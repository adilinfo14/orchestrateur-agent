import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const SCHEMA = `
PRAGMA journal_mode=WAL;
PRAGMA synchronous=NORMAL;
PRAGMA foreign_keys=ON;
CREATE TABLE IF NOT EXISTS machines(
  id TEXT PRIMARY KEY, name TEXT NOT NULL, hostname TEXT, platform TEXT,
  token_hash TEXT NOT NULL UNIQUE, allow_control INTEGER NOT NULL DEFAULT 1, revoked INTEGER NOT NULL DEFAULT 0,
  capabilities TEXT, collector_version TEXT, last_seen_at INTEGER, ack_seq INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS events(
  id TEXT PRIMARY KEY, machine_id TEXT NOT NULL, seq INTEGER NOT NULL, ts INTEGER NOT NULL, source TEXT NOT NULL,
  type TEXT NOT NULL, session_id TEXT, agent_id TEXT, cwd TEXT, data TEXT NOT NULL, UNIQUE(machine_id, seq));
CREATE INDEX IF NOT EXISTS events_ts ON events(ts DESC, id);
CREATE INDEX IF NOT EXISTS events_session ON events(session_id, ts DESC);
CREATE INDEX IF NOT EXISTS events_machine ON events(machine_id, ts DESC);
CREATE INDEX IF NOT EXISTS events_type ON events(type, ts DESC);
CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY, machine_id TEXT NOT NULL, state TEXT NOT NULL, last_event_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS sessions_last ON sessions(last_event_at DESC);
CREATE TABLE IF NOT EXISTS agents(key TEXT PRIMARY KEY, session_id TEXT NOT NULL, state TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS agents_session ON agents(session_id);
CREATE TABLE IF NOT EXISTS files(
  session_id TEXT NOT NULL, path TEXT NOT NULL, tool TEXT NOT NULL, count INTEGER NOT NULL, last_ts INTEGER NOT NULL,
  PRIMARY KEY(session_id, path));
CREATE TABLE IF NOT EXISTS commands(
  id TEXT PRIMARY KEY, idempotency_key TEXT NOT NULL UNIQUE, machine_id TEXT NOT NULL, session_id TEXT, type TEXT NOT NULL,
  payload TEXT NOT NULL, status TEXT NOT NULL, result TEXT, error TEXT, actor TEXT NOT NULL,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS commands_session ON commands(session_id, created_at DESC);
CREATE INDEX IF NOT EXISTS commands_created ON commands(created_at DESC);
CREATE TABLE IF NOT EXISTS audit(
  id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, actor TEXT NOT NULL, action TEXT NOT NULL,
  target TEXT, detail TEXT, ip TEXT);
CREATE INDEX IF NOT EXISTS audit_ts ON audit(ts DESC);
CREATE TABLE IF NOT EXISTS users(username TEXT PRIMARY KEY, password_hash TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS ui_sessions(
  token_hash TEXT PRIMARY KEY, username TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS enroll_codes(code_hash TEXT PRIMARY KEY, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, used_at INTEGER);
`;

export function openDb(path: string): DatabaseSync {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(SCHEMA);
  return db;
}

export type Db = DatabaseSync;

export function tx<T>(db: Db, fn: () => T): T {
  db.exec('BEGIN');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}
