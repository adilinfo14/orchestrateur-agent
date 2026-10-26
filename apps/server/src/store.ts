import { fileFromToolCall, type AccEvent, type AgentView, type CollectorCapabilities, type FileTouch, type MachineView, type Platform, type ServerToUi } from '../../../packages/protocol/src/index.ts';
import { tx, type Db } from './db.ts';
import { agentKey, applyToAgent, applyToSession, newSession, type SessionState } from './reducer.ts';

interface MachineRow {
  id: string; name: string; hostname: string | null; platform: string | null; allow_control: number; revoked: number;
  capabilities: string | null; collector_version: string | null; last_seen_at: number | null; ack_seq: number; created_at: number;
}

export interface EventQuery {
  before?: { ts: number; id: string };
  limit: number;
  machineId?: string;
  sessionId?: string;
  sessionIds?: string[];
  types?: string[];
}

/** État courant en mémoire, persisté dans SQLite, diffusé aux interfaces connectées. */
export class Store {
  sessions = new Map<string, SessionState>();
  agents = new Map<string, AgentView>();
  online = new Set<string>();
  private listeners = new Set<(m: ServerToUi) => void>();
  private ingestListeners = new Set<(events: AccEvent[]) => void>();

  db: Db;

  constructor(db: Db) {
    this.db = db;
    for (const r of db.prepare('SELECT state FROM sessions').all() as { state: string }[]) {
      const s = JSON.parse(r.state) as SessionState;
      this.sessions.set(s.id, s);
    }
    for (const r of db.prepare('SELECT key, state FROM agents').all() as { key: string; state: string }[]) {
      this.agents.set(r.key, JSON.parse(r.state) as AgentView);
    }
  }

  subscribe(fn: (m: ServerToUi) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  onIngest(fn: (events: AccEvent[]) => void): void {
    this.ingestListeners.add(fn);
  }

  broadcast(m: ServerToUi): void {
    for (const fn of this.listeners) fn(m);
  }

  // ---------- Machines ----------

  private machineView(r: MachineRow): MachineView {
    return {
      id: r.id, name: r.name, hostname: r.hostname, platform: (r.platform as Platform | null) ?? null, online: this.online.has(r.id),
      lastSeenAt: r.last_seen_at, collectorVersion: r.collector_version,
      capabilities: r.capabilities ? (JSON.parse(r.capabilities) as CollectorCapabilities) : null,
      allowControl: r.allow_control === 1, createdAt: r.created_at,
    };
  }

  machines(): MachineView[] {
    return (this.db.prepare('SELECT * FROM machines WHERE revoked = 0 ORDER BY name').all() as unknown as MachineRow[]).map((r) => this.machineView(r));
  }

  machine(id: string): MachineView | null {
    const r = this.db.prepare('SELECT * FROM machines WHERE id = ? AND revoked = 0').get(id) as unknown as MachineRow | undefined;
    return r ? this.machineView(r) : null;
  }

  machineByTokenHash(hash: string): { id: string; ackSeq: number } | null {
    const r = this.db.prepare('SELECT id, ack_seq FROM machines WHERE token_hash = ? AND revoked = 0').get(hash) as { id: string; ack_seq: number } | undefined;
    return r ? { id: r.id, ackSeq: r.ack_seq } : null;
  }

  createMachine(id: string, name: string, hostname: string | null, platform: string | null, tokenHash: string): void {
    this.db.prepare('INSERT INTO machines(id, name, hostname, platform, token_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, name, hostname, platform, tokenHash, Date.now());
    this.emitMachine(id);
  }

  updateMachineHello(id: string, hostname: string, platform: string, version: string, caps: CollectorCapabilities): void {
    this.db.prepare('UPDATE machines SET hostname = ?, platform = ?, collector_version = ?, capabilities = ?, last_seen_at = ? WHERE id = ?')
      .run(hostname, platform, version, JSON.stringify(caps), Date.now(), id);
  }

  setOnline(id: string, online: boolean): void {
    if (online) this.online.add(id); else this.online.delete(id);
    this.db.prepare('UPDATE machines SET last_seen_at = ? WHERE id = ?').run(Date.now(), id);
    this.emitMachine(id);
  }

  setMachinePolicy(id: string, patch: { allowControl?: boolean; name?: string }): void {
    if (patch.allowControl !== undefined) this.db.prepare('UPDATE machines SET allow_control = ? WHERE id = ?').run(patch.allowControl ? 1 : 0, id);
    if (patch.name) this.db.prepare('UPDATE machines SET name = ? WHERE id = ?').run(patch.name.slice(0, 80), id);
    this.emitMachine(id);
  }

  revokeMachine(id: string): void {
    this.db.prepare('UPDATE machines SET revoked = 1 WHERE id = ?').run(id);
  }

  emitMachine(id: string): void {
    const m = this.machine(id);
    if (m) this.broadcast({ t: 'machine', machine: m });
  }

  // ---------- Événements ----------

  /**
   * Ingestion d'un lot venant d'un collecteur. Les doublons (même machine+seq ou même id)
   * sont ignorés : un renvoi après reconnexion n'a aucun effet de bord.
   * Retourne le numéro de séquence à acquitter.
   */
  ingest(machineId: string, events: AccEvent[]): number {
    const fresh: AccEvent[] = [];
    let maxSeq = 0;
    const insert = this.db.prepare(`INSERT OR IGNORE INTO events(id, machine_id, seq, ts, source, type, session_id, agent_id, cwd, data)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    tx(this.db, () => {
      for (const ev of events) {
        if (ev.machineId !== machineId) continue; // un collecteur ne parle que pour sa machine
        maxSeq = Math.max(maxSeq, ev.seq);
        const r = insert.run(ev.id, machineId, ev.seq, ev.ts, ev.source, ev.type, ev.sessionId, ev.agentId, ev.cwd, JSON.stringify(ev.data));
        if (Number(r.changes) === 1) fresh.push(ev);
      }
      if (maxSeq) this.db.prepare('UPDATE machines SET ack_seq = MAX(ack_seq, ?), last_seen_at = ? WHERE id = ?').run(maxSeq, Date.now(), machineId);
    });
    const touchedSessions = new Set<string>();
    const touchedAgents = new Set<string>();
    tx(this.db, () => {
      for (const ev of fresh) {
        this.apply(ev, touchedSessions, touchedAgents);
      }
      for (const id of touchedSessions) this.persistSession(id);
      for (const key of touchedAgents) this.persistAgent(key);
    });
    for (const ev of fresh) this.broadcast({ t: 'event', event: ev });
    for (const key of touchedAgents) { const a = this.agents.get(key); if (a) this.broadcast({ t: 'agent', agent: a }); }
    for (const id of touchedSessions) { const s = this.sessions.get(id); if (s) this.broadcast({ t: 'session', session: s }); }
    if (fresh.length) for (const fn of this.ingestListeners) fn(fresh);
    return maxSeq;
  }

  private apply(ev: AccEvent, touchedSessions: Set<string>, touchedAgents: Set<string>): void {
    if (!ev.sessionId) return;
    let s = this.sessions.get(ev.sessionId);
    if (!s) {
      // Un simple « disparu » ne crée pas de session.
      if (ev.type === 'SessionGone') return;
      s = newSession(ev);
      this.sessions.set(s.id, s);
    }
    applyToSession(s, ev);
    touchedSessions.add(s.id);

    const a = applyToAgent(this.agents, ev);
    if (a) touchedAgents.add(agentKey(a.sessionId, a.id));
    if (ev.type === 'SubagentStart' || ev.type === 'SubagentStop' || ev.type === 'SessionEnd') this.recountAgents(s);

    if (ev.type === 'PostToolUse') {
      const path = fileFromToolCall(ev.data.tool_name, ev.data.tool_input);
      if (path) {
        this.db.prepare(`INSERT INTO files(session_id, path, tool, count, last_ts) VALUES (?, ?, ?, 1, ?)
          ON CONFLICT(session_id, path) DO UPDATE SET count = count + 1, last_ts = excluded.last_ts, tool = excluded.tool`)
          .run(ev.sessionId, path, String(ev.data.tool_name), ev.ts);
      }
    }
  }

  private recountAgents(s: SessionState): void {
    let total = 0, active = 0;
    for (const a of this.agents.values()) {
      if (a.sessionId !== s.id) continue;
      total++;
      if (a.status === 'running' && s.status !== 'ended') active++;
    }
    s.agentCount = total;
    s.activeAgentCount = active;
  }

  private persistSession(id: string): void {
    const s = this.sessions.get(id);
    if (!s) return;
    this.db.prepare(`INSERT INTO sessions(id, machine_id, state, last_event_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET state = excluded.state, last_event_at = excluded.last_event_at`).run(s.id, s.machineId, JSON.stringify(s), s.lastEventAt);
  }

  private persistAgent(key: string): void {
    const a = this.agents.get(key);
    if (!a) return;
    this.db.prepare(`INSERT INTO agents(key, session_id, state) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET state = excluded.state`)
      .run(key, a.sessionId, JSON.stringify(a));
  }


  events(q: EventQuery): AccEvent[] {
    const where: string[] = [];
    const args: (string | number)[] = [];
    if (q.before) { where.push('(ts < ? OR (ts = ? AND id < ?))'); args.push(q.before.ts, q.before.ts, q.before.id); }
    if (q.machineId) { where.push('machine_id = ?'); args.push(q.machineId); }
    if (q.sessionId) { where.push('session_id = ?'); args.push(q.sessionId); }
    if (q.sessionIds) {
      if (!q.sessionIds.length) return [];
      where.push(`session_id IN (${q.sessionIds.map(() => '?').join(',')})`);
      args.push(...q.sessionIds);
    }
    if (q.types?.length) { where.push(`type IN (${q.types.map(() => '?').join(',')})`); args.push(...q.types); }
    const sql = `SELECT * FROM events ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY ts DESC, id DESC LIMIT ?`;
    args.push(Math.min(Math.max(q.limit, 1), 500));
    const rows = this.db.prepare(sql).all(...args) as {
      id: string; machine_id: string; seq: number; ts: number; source: string; type: string; session_id: string | null; agent_id: string | null; cwd: string | null; data: string;
    }[];
    return rows.map((r) => ({
      id: r.id, machineId: r.machine_id, seq: r.seq, ts: r.ts, source: r.source as AccEvent['source'], type: r.type,
      sessionId: r.session_id, agentId: r.agent_id, cwd: r.cwd, data: JSON.parse(r.data) as Record<string, unknown>,
    }));
  }

  files(sessionId: string): FileTouch[] {
    return (this.db.prepare('SELECT session_id, path, tool, count, last_ts FROM files WHERE session_id = ? ORDER BY last_ts DESC LIMIT 500').all(sessionId) as {
      session_id: string; path: string; tool: string; count: number; last_ts: number;
    }[]).map((r) => ({ sessionId: r.session_id, path: r.path, tool: r.tool, count: r.count, lastTs: r.last_ts }));
  }

  agentsOf(sessionId: string): AgentView[] {
    return [...this.agents.values()].filter((a) => a.sessionId === sessionId).sort((a, b) => b.startedAt - a.startedAt);
  }

  /** Purge des événements anciens (les états réduits sont conservés). */
  prune(maxAgeMs: number): number {
    const r = this.db.prepare('DELETE FROM events WHERE ts < ?').run(Date.now() - maxAgeMs);
    return Number(r.changes);
  }
}
