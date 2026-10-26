import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import type { Db } from './db.ts';

export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
export const randomToken = (bytes = 32) => randomBytes(bytes).toString('base64url');

const SCRYPT = { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const SESSION_TTL_MS = 30 * 24 * 3600 * 1000;
const ENROLL_TTL_MS = 15 * 60 * 1000;

export function hashPassword(pw: string): string {
  const salt = randomBytes(16);
  const key = scryptSync(pw, salt, 32, SCRYPT);
  return `scrypt$${salt.toString('base64')}$${key.toString('base64')}`;
}

export function verifyPassword(pw: string, stored: string): boolean {
  const [alg, saltB64, keyB64] = stored.split('$');
  if (alg !== 'scrypt' || !saltB64 || !keyB64) return false;
  const expected = Buffer.from(keyB64, 'base64');
  const key = scryptSync(pw, Buffer.from(saltB64, 'base64'), expected.length, SCRYPT);
  return timingSafeEqual(key, expected);
}

export function setPassword(db: Db, username: string, pw: string): void {
  if (pw.length < 12) throw new Error('Mot de passe trop court (12 caractères minimum)');
  db.prepare(`INSERT INTO users(username, password_hash, created_at) VALUES (?, ?, ?)
    ON CONFLICT(username) DO UPDATE SET password_hash=excluded.password_hash`).run(username, hashPassword(pw), Date.now());
  // Changer le mot de passe invalide toutes les sessions ouvertes.
  db.prepare('DELETE FROM ui_sessions WHERE username = ?').run(username);
}

export function hasUsers(db: Db): boolean {
  return !!db.prepare('SELECT 1 FROM users LIMIT 1').get();
}

export function login(db: Db, username: string, pw: string): string | null {
  const row = db.prepare('SELECT password_hash FROM users WHERE username = ?').get(username) as { password_hash: string } | undefined;
  // Coût constant même si l'utilisateur n'existe pas.
  const ok = row ? verifyPassword(pw, row.password_hash) : (verifyPassword(pw, hashPassword('leurre-temps-constant')), false);
  if (!ok) return null;
  const token = randomToken();
  const now = Date.now();
  db.prepare('INSERT INTO ui_sessions(token_hash, username, created_at, expires_at) VALUES (?, ?, ?, ?)').run(sha256(token), username, now, now + SESSION_TTL_MS);
  return token;
}

export function userForToken(db: Db, token: string | undefined): string | null {
  if (!token) return null;
  const row = db.prepare('SELECT username, expires_at FROM ui_sessions WHERE token_hash = ?').get(sha256(token)) as { username: string; expires_at: number } | undefined;
  if (!row || row.expires_at < Date.now()) return null;
  return row.username;
}

export function logout(db: Db, token: string | undefined): void {
  if (token) db.prepare('DELETE FROM ui_sessions WHERE token_hash = ?').run(sha256(token));
}

/** Code d'inscription à usage unique, valable 15 minutes. Seul son hachage est stocké. */
export function createEnrollCode(db: Db): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = randomBytes(10);
  let raw = '';
  for (const b of bytes) raw += alphabet[b % alphabet.length];
  const code = `${raw.slice(0, 5)}-${raw.slice(5)}`;
  const now = Date.now();
  db.prepare('INSERT INTO enroll_codes(code_hash, created_at, expires_at) VALUES (?, ?, ?)').run(sha256(code), now, now + ENROLL_TTL_MS);
  return code;
}

export function consumeEnrollCode(db: Db, code: string): boolean {
  const res = db.prepare('UPDATE enroll_codes SET used_at = ? WHERE code_hash = ? AND used_at IS NULL AND expires_at > ?').run(Date.now(), sha256(code.toUpperCase()), Date.now());
  return Number(res.changes) === 1;
}

/** Limiteur simple en mémoire (par clé, fenêtre glissante). */
export class RateLimiter {
  private hits = new Map<string, number[]>();
  private max: number;
  private windowMs: number;
  constructor(max: number, windowMs: number) { this.max = max; this.windowMs = windowMs; }
  allow(key: string): boolean {
    const now = Date.now();
    const arr = (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs);
    if (arr.length >= this.max) { this.hits.set(key, arr); return false; }
    arr.push(now);
    this.hits.set(key, arr);
    return true;
  }
}

export function audit(db: Db, actor: string, action: string, target: string | null, detail: unknown, ip: string | null): void {
  db.prepare('INSERT INTO audit(ts, actor, action, target, detail, ip) VALUES (?, ?, ?, ?, ?, ?)')
    .run(Date.now(), actor, action, target, detail === undefined ? null : JSON.stringify(detail), ip);
}
