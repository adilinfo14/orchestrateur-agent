import { randomUUID } from 'node:crypto';
import { SENSITIVE_COMMANDS, type CommandPayload, type CommandRecord, type CommandRequest, type CommandStatus } from '../../../packages/protocol/src/index.ts';
import { audit } from './auth.ts';
import type { Store } from './store.ts';

export class CommandError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

type Dispatch = (machineId: string, commandId: string, payload: CommandPayload) => boolean;

const TIMEOUT_MS: Partial<Record<CommandPayload['type'], number>> = { 'session.spawn': 120_000 };
const DEFAULT_TIMEOUT_MS = 30_000;

interface Row {
  id: string; idempotency_key: string; machine_id: string; session_id: string | null; type: string; payload: string;
  status: string; result: string | null; error: string | null; actor: string; created_at: number; updated_at: number;
}

const toRecord = (r: Row): CommandRecord => ({
  id: r.id, idempotencyKey: r.idempotency_key, machineId: r.machine_id, sessionId: r.session_id, type: r.type as CommandRecord['type'],
  payload: JSON.parse(r.payload) as CommandPayload, status: r.status as CommandStatus, result: r.result ? JSON.parse(r.result) : null,
  error: r.error, actor: r.actor, createdAt: r.created_at, updatedAt: r.updated_at,
});

/**
 * Cycle de vie des commandes : validation -> verrou -> envoi au collecteur -> résultat ou expiration.
 * Une commande n'est jamais marquée réussie sans réponse explicite du collecteur.
 */
export class Commands {
  private timers = new Map<string, NodeJS.Timeout>();

  private store: Store;
  private dispatch: Dispatch;

  constructor(store: Store, dispatch: Dispatch) {
    this.store = store;
    this.dispatch = dispatch;
    // Au redémarrage, les commandes en vol n'ont plus de réponse possible.
    const stale = store.db.prepare(`SELECT id FROM commands WHERE status IN ('pending','sent')`).all() as { id: string }[];
    for (const { id } of stale) this.finish(id, 'timeout', null, 'Serveur redémarré avant la réponse du collecteur');
  }

  get(id: string): CommandRecord | null {
    const r = this.store.db.prepare('SELECT * FROM commands WHERE id = ?').get(id) as unknown as Row | undefined;
    return r ? toRecord(r) : null;
  }

  list(opts: { sessionId?: string; limit?: number }): CommandRecord[] {
    const limit = Math.min(opts.limit ?? 50, 200);
    const rows = opts.sessionId
      ? this.store.db.prepare('SELECT * FROM commands WHERE session_id = ? ORDER BY created_at DESC LIMIT ?').all(opts.sessionId, limit)
      : this.store.db.prepare('SELECT * FROM commands ORDER BY created_at DESC LIMIT ?').all(limit);
    return (rows as unknown as Row[]).map(toRecord);
  }

  create(req: CommandRequest, actor: string, ip: string | null): CommandRecord {
    const existing = this.store.db.prepare('SELECT * FROM commands WHERE idempotency_key = ?').get(req.idempotencyKey) as unknown as Row | undefined;
    if (existing) return toRecord(existing);

    const p = req.payload;
    const reject = (status: number, msg: string): never => {
      audit(this.store.db, actor, 'command.rejected', req.machineId, { type: p.type, reason: msg }, ip);
      throw new CommandError(status, msg);
    };

    const machine = this.store.machine(req.machineId);
    if (!machine) reject(404, 'Machine inconnue ou révoquée');
    if (!machine!.allowControl) reject(403, 'Le pilotage est désactivé pour cette machine');
    if (!machine!.online) reject(409, 'Machine hors ligne : commande non transmise');
    if (SENSITIVE_COMMANDS.has(p.type) && !req.confirmed) reject(428, 'Confirmation explicite requise pour cette opération');

    const sessionId = 'sessionId' in p ? p.sessionId : null;
    if (sessionId) {
      const s = this.store.sessions.get(sessionId);
      if (!s) reject(404, 'Session inconnue');
      if (s!.machineId !== req.machineId) reject(400, 'La session n’appartient pas à cette machine');
      if (s!.status === 'ended') reject(409, 'Session terminée');
      const c = s!.control;
      if (p.type === 'session.send' && !c.send) reject(409, 'Aucun canal d’envoi supporté pour cette session');
      if (p.type === 'session.interrupt' && !c.interrupt) reject(409, 'Interruption non supportée pour cette session (seulement les sessions lancées par le cockpit)');
      if (p.type === 'session.stop' && !c.stop) reject(409, 'Arrêt non supporté pour cette session');
      if (p.type === 'permission.respond') {
        if (!c.permissions) reject(409, 'Relais des autorisations non supporté pour cette session');
        if (!s!.pendingPermissions.some((x) => x.requestId === p.requestId)) reject(409, 'Demande d’autorisation introuvable ou déjà traitée');
      }
      // Une seule commande en vol par session (protection contre les commandes concurrentes).
      const busy = this.store.db.prepare(`SELECT id FROM commands WHERE session_id = ? AND status IN ('pending','sent') LIMIT 1`).get(sessionId);
      if (busy) reject(409, 'Une commande est déjà en cours pour cette session');
    }
    if (p.type === 'session.spawn') {
      const caps = machine!.capabilities;
      if (!caps?.sdkSpawn) reject(409, 'Lancement de sessions non activé sur ce collecteur (aucune racine autorisée)');
    }

    const now = Date.now();
    const id = randomUUID();
    this.store.db.prepare(`INSERT INTO commands(id, idempotency_key, machine_id, session_id, type, payload, status, actor, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`).run(id, req.idempotencyKey, req.machineId, sessionId, p.type, JSON.stringify(p), actor, now, now);
    audit(this.store.db, actor, 'command.created', req.machineId, { id, type: p.type, sessionId, confirmed: req.confirmed }, ip);

    if (!this.dispatch(req.machineId, id, p)) {
      this.finish(id, 'error', null, 'Collecteur déconnecté pendant l’envoi');
    } else {
      this.update(id, 'sent');
      this.timers.set(id, setTimeout(() => this.finish(id, 'timeout', null, 'Pas de réponse du collecteur dans le délai imparti'), TIMEOUT_MS[p.type] ?? DEFAULT_TIMEOUT_MS));
    }
    return this.get(id)!;
  }

  /** Réponse du collecteur. Ignorée si elle ne vient pas de la machine ciblée. */
  onResult(machineId: string, commandId: string, ok: boolean, result: unknown, error: string | undefined): void {
    const c = this.get(commandId);
    if (!c || c.machineId !== machineId) return;
    if (c.status !== 'sent' && c.status !== 'pending' && c.status !== 'timeout') return;
    this.finish(commandId, ok ? 'ok' : 'error', result ?? null, ok ? null : (error ?? 'Erreur inconnue'));
  }

  /** Le collecteur s'est déconnecté : ses commandes en vol ne recevront pas de réponse fiable. */
  onDisconnect(machineId: string): void {
    const rows = this.store.db.prepare(`SELECT id FROM commands WHERE machine_id = ? AND status IN ('pending','sent')`).all(machineId) as { id: string }[];
    for (const { id } of rows) this.finish(id, 'error', null, 'Collecteur déconnecté avant la réponse : résultat inconnu');
  }

  private update(id: string, status: CommandStatus): void {
    this.store.db.prepare('UPDATE commands SET status = ?, updated_at = ? WHERE id = ?').run(status, Date.now(), id);
    const c = this.get(id);
    if (c) this.store.broadcast({ t: 'command', command: c });
  }

  private finish(id: string, status: CommandStatus, result: unknown, error: string | null): void {
    const t = this.timers.get(id);
    if (t) { clearTimeout(t); this.timers.delete(id); }
    this.store.db.prepare('UPDATE commands SET status = ?, result = ?, error = ?, updated_at = ? WHERE id = ?')
      .run(status, result === null || result === undefined ? null : JSON.stringify(result), error, Date.now(), id);
    const c = this.get(id);
    if (c) {
      audit(this.store.db, 'system', `command.${status}`, c.machineId, { id, type: c.type, error }, null);
      this.store.broadcast({ t: 'command', command: c });
    }
  }
}
