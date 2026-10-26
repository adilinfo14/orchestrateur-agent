import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { NewEvent } from './outbox.ts';

/**
 * Lecture seule du registre ~/.claude/sessions/<pid>.json écrit par Claude Code.
 * NON DOCUMENTÉ : sert uniquement à détecter les sessions déjà ouvertes avant l'installation des hooks.
 * Les fichiers *.key (secrets) ne sont jamais lus. Rien n'est jamais écrit dans ce dossier.
 */
interface RegistryEntry {
  pid: number;
  sessionId: string;
  cwd?: string;
  name?: string;
  status?: string;
  kind?: string;
  entrypoint?: string;
  version?: string;
  startedAt?: number;
  statusUpdatedAt?: number;
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; }
}

export function readRegistry(dir: string): RegistryEntry[] {
  let files: string[];
  try { files = readdirSync(dir); } catch { return []; }
  const out: RegistryEntry[] = [];
  for (const f of files) {
    if (!/^\d+\.json$/.test(f)) continue;
    try {
      const d = JSON.parse(readFileSync(join(dir, f), 'utf8')) as RegistryEntry;
      if (typeof d.pid === 'number' && typeof d.sessionId === 'string' && alive(d.pid)) out.push(d);
    } catch {}
  }
  return out;
}

export class RegistryWatcher {
  private known = new Map<string, string>(); // clé pid:session -> empreinte
  private timer: NodeJS.Timeout | null = null;

  private dir: string;
  private emit: (e: NewEvent) => void;
  private intervalMs: number;

  constructor(dir: string, emit: (e: NewEvent) => void, intervalMs = 5000) {
    this.dir = dir; this.emit = emit; this.intervalMs = intervalMs;
  }

  start(): void {
    this.scan();
    this.timer = setInterval(() => this.scan(), this.intervalMs);
    this.timer.unref();
  }

  stop(): void { if (this.timer) clearInterval(this.timer); }

  scan(): void {
    const seen = new Set<string>();
    for (const e of readRegistry(this.dir)) {
      const key = `${e.pid}:${e.sessionId}`;
      seen.add(key);
      const fp = `${e.status}|${e.name}|${e.cwd}`;
      if (this.known.get(key) === fp) continue;
      this.known.set(key, fp);
      this.emit({
        source: 'registry', type: 'SessionSeen', sessionId: e.sessionId, cwd: e.cwd ?? null,
        data: { pid: e.pid, name: e.name ?? null, status: e.status ?? null, kind: e.kind ?? null, entrypoint: e.entrypoint ?? null, version: e.version ?? null, startedAt: e.startedAt ?? null },
      });
    }
    for (const key of [...this.known.keys()]) {
      if (seen.has(key)) continue;
      this.known.delete(key);
      const [pid, sessionId] = key.split(':');
      this.emit({ source: 'registry', type: 'SessionGone', sessionId: sessionId ?? null, data: { pid: Number(pid) } });
    }
  }
}
