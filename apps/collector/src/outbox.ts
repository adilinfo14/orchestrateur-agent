import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import type { AccEvent, EventSource } from '../../../packages/protocol/src/index.ts';

export interface NewEvent {
  source: EventSource;
  type: string;
  sessionId: string | null;
  agentId?: string | null;
  cwd?: string | null;
  data: Record<string, unknown>;
  ts?: number;
}

const MAX_ROWS = 200_000;

/**
 * Journal d'envoi persistant : chaque événement reçoit un numéro de séquence monotone par machine.
 * Il reste stocké tant que le serveur n'a pas accusé réception, ce qui couvre les coupures réseau
 * et les redémarrages du collecteur.
 */
export class Outbox {
  private db: DatabaseSync;
  private seq: number;
  private listeners = new Set<() => void>();

  private machineId: string;

  constructor(path: string, machineId: string) {
    this.machineId = machineId;
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS outbox(seq INTEGER PRIMARY KEY, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS meta(k TEXT PRIMARY KEY, v TEXT NOT NULL);`);
    const row = this.db.prepare(`SELECT v FROM meta WHERE k='lastSeq'`).get() as { v: string } | undefined;
    this.seq = row ? Number(row.v) : 0;
  }

  onAppend(fn: () => void): void { this.listeners.add(fn); }

  append(e: NewEvent): AccEvent {
    const ev: AccEvent = {
      id: randomUUID(),
      machineId: this.machineId,
      seq: ++this.seq,
      ts: e.ts ?? Date.now(),
      source: e.source,
      type: e.type,
      sessionId: e.sessionId,
      agentId: e.agentId ?? null,
      cwd: e.cwd ?? null,
      data: e.data,
    };
    this.db.exec('BEGIN');
    try {
      this.db.prepare('INSERT INTO outbox(seq, body) VALUES (?, ?)').run(ev.seq, JSON.stringify(ev));
      this.db.prepare(`INSERT INTO meta(k, v) VALUES ('lastSeq', ?) ON CONFLICT(k) DO UPDATE SET v=excluded.v`).run(String(ev.seq));
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
    for (const fn of this.listeners) fn();
    return ev;
  }

  /** Événements non acquittés au-delà de `afterSeq`. */
  pending(afterSeq: number, limit: number): AccEvent[] {
    const rows = this.db.prepare('SELECT body FROM outbox WHERE seq > ? ORDER BY seq LIMIT ?').all(afterSeq, limit) as { body: string }[];
    return rows.map((r) => JSON.parse(r.body) as AccEvent);
  }

  ackUpTo(seq: number): void {
    this.db.prepare('DELETE FROM outbox WHERE seq <= ?').run(seq);
  }

  size(): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM outbox').get() as { n: number }).n;
  }

  lastSeq(): number { return this.seq; }

  /** Protection mémoire/disque en cas de coupure très longue : on garde les plus récents. */
  enforceCap(): number {
    const n = this.size();
    if (n <= MAX_ROWS) return 0;
    const drop = n - MAX_ROWS;
    this.db.prepare('DELETE FROM outbox WHERE seq IN (SELECT seq FROM outbox ORDER BY seq LIMIT ?)').run(drop);
    return drop;
  }

  close(): void { this.db.close(); }
}
