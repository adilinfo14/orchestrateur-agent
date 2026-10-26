import { execFile } from 'node:child_process';
import type { NewEvent } from './outbox.ts';

/**
 * Interroge `claude agents --json --all` (documenté, vue agents) pour les sessions en arrière-plan.
 * Désactivé silencieusement si la commande claude est absente ou ne connaît pas cette sous-commande.
 */
export class AgentsCliWatcher {
  private last = new Map<string, string>();
  private timer: NodeJS.Timeout | null = null;
  available = false;

  private claudeBin: string;
  private emit: (e: NewEvent) => void;
  private log: (m: string) => void;
  private intervalMs: number;

  constructor(claudeBin: string, emit: (e: NewEvent) => void, log: (m: string) => void, intervalMs = 10000) {
    this.claudeBin = claudeBin; this.emit = emit; this.log = log; this.intervalMs = intervalMs;
  }

  async probe(): Promise<boolean> {
    try { await this.run(); this.available = true; } catch (e) { this.available = false; this.log(`vue agents indisponible (${(e as Error).message.split('\n')[0]})`); }
    return this.available;
  }

  start(): void {
    if (!this.available) return;
    this.timer = setInterval(() => { this.tick().catch(() => {}); }, this.intervalMs);
    this.timer.unref();
  }

  stop(): void { if (this.timer) clearInterval(this.timer); }

  private run(): Promise<unknown[]> {
    return new Promise((resolve, reject) => {
      execFile(this.claudeBin, ['agents', '--json', '--all'], { timeout: 8000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
        if (err) return reject(err);
        try {
          const parsed = JSON.parse(stdout) as unknown;
          resolve(Array.isArray(parsed) ? parsed : Array.isArray((parsed as { agents?: unknown[] }).agents) ? (parsed as { agents: unknown[] }).agents : []);
        } catch (e) { reject(e as Error); }
      });
    });
  }

  private async tick(): Promise<void> {
    const rows = await this.run();
    for (const r of rows as Record<string, unknown>[]) {
      const sessionId = typeof r.sessionId === 'string' ? r.sessionId : null;
      if (!sessionId) continue;
      const fp = JSON.stringify([r.state, r.status, r.waitingFor, r.name]);
      if (this.last.get(sessionId) === fp) continue;
      this.last.set(sessionId, fp);
      this.emit({
        source: 'agents-cli', type: 'SessionSeen', sessionId, cwd: typeof r.cwd === 'string' ? r.cwd : null,
        data: { pid: r.pid ?? null, name: r.name ?? null, kind: r.kind ?? null, state: r.state ?? null, status: r.status ?? null, waitingFor: r.waitingFor ?? null, backgroundId: r.id ?? null, startedAt: r.startedAt ?? null },
      });
    }
  }
}
