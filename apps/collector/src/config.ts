import { mkdirSync, readFileSync, writeFileSync, existsSync, chmodSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { Platform } from '../../../packages/protocol/src/index.ts';

export const COLLECTOR_VERSION = '0.1.0';
export const DEFAULT_HOOK_PORT = 47821;

export interface CollectorConfig {
  serverUrl: string;
  machineId: string;
  machineToken: string;
  /** Secret partagé entre les hooks HTTP et le collecteur (boucle locale uniquement). */
  localToken: string;
  hookPort: number;
  /** Racines dans lesquelles le cockpit peut lancer des sessions. Vide = lancement désactivé. */
  allowedRoots: string[];
  allowSend: boolean;
  allowSpawn: boolean;
  /** Relais des demandes d'autorisation des sessions lancées par le collecteur. */
  allowPermissionRelay: boolean;
  /** Lecture du registre ~/.claude/sessions (non documenté). */
  useSessionRegistry: boolean;
  /** Joindre le jeton de messagerie exporté aux hooks (obligatoire sous Windows natif). */
  socketSendAuthToken: boolean;
  claudePath: string | null;
}

export function accDir(): string {
  return process.env.ACC_HOME ?? join(homedir(), '.acc');
}

export function claudeConfigDir(): string {
  return process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude');
}

export function configPath(): string {
  return join(accDir(), 'collector.json');
}

export function detectPlatform(): Platform {
  if (process.platform === 'darwin') return 'darwin';
  if (process.platform === 'win32') return 'win32';
  try {
    if (/microsoft/i.test(readFileSync('/proc/version', 'utf8'))) return 'wsl';
  } catch {}
  return 'linux';
}

export function machineHostname(): string {
  return hostname();
}

export function loadConfig(): CollectorConfig {
  const p = configPath();
  if (!existsSync(p)) throw new Error(`Collecteur non inscrit : ${p} introuvable. Lancez « acc-collector enroll ».`);
  const raw = JSON.parse(readFileSync(p, 'utf8')) as Partial<CollectorConfig>;
  return {
    hookPort: DEFAULT_HOOK_PORT,
    allowedRoots: [],
    allowSend: true,
    allowSpawn: true,
    allowPermissionRelay: true,
    useSessionRegistry: true,
    socketSendAuthToken: true,
    claudePath: null,
    ...raw,
  } as CollectorConfig;
}

export function saveConfig(cfg: CollectorConfig): void {
  mkdirSync(accDir(), { recursive: true, mode: 0o700 });
  const p = configPath();
  writeFileSync(p, JSON.stringify(cfg, null, 2) + '\n', { mode: 0o600 });
  try { chmodSync(p, 0o600); } catch {}
}

export function newSecret(): string {
  return randomBytes(32).toString('base64url');
}

/** Vrai si `target` est égal à une racine autorisée ou situé dessous (après normalisation). */
export function isUnderAllowedRoot(target: string, roots: string[]): boolean {
  const norm = (p: string) => {
    let r = resolve(p.replace(/^~(?=$|[\\/])/, homedir()));
    if (process.platform === 'win32') r = r.toLowerCase();
    return r.endsWith(sep) ? r.slice(0, -1) : r;
  };
  const t = norm(target);
  return roots.some((root) => {
    const r = norm(root);
    return t === r || t.startsWith(r + sep);
  });
}
