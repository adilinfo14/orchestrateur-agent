// Orchestration multi-agents : décomposition, validation humaine, distribution, suivi par preuves.
// Principe : une tâche n'est « vérifiée » que si une preuve a été observée dans les événements collectés
// (commande de vérification exécutée avec succès dans la session assignée, après l'envoi de la tâche).
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { AccEvent, CommandRecord, Plan, PlanStatus, PlanTask, TaskStatus } from '../../../packages/protocol/src/index.ts';

export type { Plan, PlanTask };
import { audit } from './auth.ts';
import type { Commands } from './commands.ts';
import { tx, type Db } from './db.ts';
import type { Store } from './store.ts';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS plans(
  id TEXT PRIMARY KEY, objective TEXT NOT NULL, machine_id TEXT, cwd TEXT, planner_session_id TEXT, planner_command_id TEXT,
  status TEXT NOT NULL, error TEXT, actor TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS plan_tasks(
  id TEXT PRIMARY KEY, plan_id TEXT NOT NULL, idx INTEGER NOT NULL, title TEXT NOT NULL, instructions TEXT NOT NULL,
  depends_on TEXT NOT NULL, verify TEXT, assignee_session_id TEXT, status TEXT NOT NULL, dispatched_at INTEGER,
  command_id TEXT, report TEXT, evidence TEXT, error TEXT, updated_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS plan_tasks_plan ON plan_tasks(plan_id, idx);
`;

export const TaskInput = z.object({
  id: z.string().max(64).optional(),
  title: z.string().min(1).max(200),
  instructions: z.string().min(1).max(8000),
  dependsOn: z.array(z.string().max(64)).max(20).default([]),
  verify: z.string().max(300).nullable().default(null),
  assigneeSessionId: z.string().max(128).nullable().default(null),
});
export type TaskInput = z.infer<typeof TaskInput>;

const PlannerOutput = z.object({
  tasks: z.array(z.object({
    key: z.string().min(1).max(40),
    title: z.string().min(1).max(200),
    instructions: z.string().min(1).max(8000),
    dependsOn: z.array(z.string()).default([]),
    verify: z.string().max(300).nullable().optional(),
    suggestedSession: z.string().nullable().optional(),
  })).min(1).max(12),
});

/** Extrait le plan JSON d'une réponse du planificateur (bloc ```json ou premier objet). */
export function parsePlannerOutput(text: string): z.infer<typeof PlannerOutput> {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const candidate = fenced?.[1] ?? text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1);
  if (!candidate.trim()) throw new Error('Aucun JSON dans la réponse du planificateur');
  return PlannerOutput.parse(JSON.parse(candidate));
}

/** Vérifie l'absence de cycle et de dépendance inconnue. */
export function validateDag(tasks: { id: string; dependsOn: string[] }[]): string | null {
  const ids = new Set(tasks.map((t) => t.id));
  for (const t of tasks) for (const d of t.dependsOn) if (!ids.has(d)) return `Dépendance inconnue dans « ${t.id} »`;
  const state = new Map<string, 1 | 2>();
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const visit = (id: string): boolean => {
    if (state.get(id) === 2) return true;
    if (state.get(id) === 1) return false;
    state.set(id, 1);
    for (const d of byId.get(id)!.dependsOn) if (!visit(d)) return false;
    state.set(id, 2);
    return true;
  };
  for (const t of tasks) if (!visit(t.id)) return 'Les dépendances forment un cycle';
  return null;
}

const DONE: TaskStatus[] = ['verified'];
const isSatisfied = (t: PlanTask) => DONE.includes(t.status) || (t.status === 'reported' && !t.verify);

export class Orchestrator {
  private db: Db;
  private store: Store;
  private commands: Commands;
  private timer: NodeJS.Timeout | null = null;
  private onChange: (plan: Plan) => void;

  constructor(store: Store, commands: Commands, onChange: (plan: Plan) => void) {
    this.store = store;
    this.db = store.db;
    this.commands = commands;
    this.onChange = onChange;
    this.db.exec(SCHEMA);
  }

  start(): void {
    this.timer = setInterval(() => this.tick(), 5000);
    this.timer.unref();
  }

  stop(): void { if (this.timer) clearInterval(this.timer); }

  // ---------- Lecture ----------

  list(): Plan[] {
    const ids = this.db.prepare('SELECT id FROM plans ORDER BY created_at DESC LIMIT 50').all() as { id: string }[];
    return ids.map(({ id }) => this.get(id)!).filter(Boolean);
  }

  get(id: string): Plan | null {
    const r = this.db.prepare('SELECT * FROM plans WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    if (!r) return null;
    const tasks = (this.db.prepare('SELECT * FROM plan_tasks WHERE plan_id = ? ORDER BY idx').all(id) as Record<string, unknown>[]).map((t) => ({
      id: t.id as string, planId: t.plan_id as string, idx: t.idx as number, title: t.title as string, instructions: t.instructions as string,
      dependsOn: JSON.parse(t.depends_on as string) as string[], verify: (t.verify as string | null) ?? null, assigneeSessionId: (t.assignee_session_id as string | null) ?? null,
      status: t.status as TaskStatus, dispatchedAt: (t.dispatched_at as number | null) ?? null, commandId: (t.command_id as string | null) ?? null,
      report: (t.report as string | null) ?? null, evidence: t.evidence ? (JSON.parse(t.evidence as string) as PlanTask['evidence']) : null,
      error: (t.error as string | null) ?? null, updatedAt: t.updated_at as number,
    }));
    return {
      id: r.id as string, objective: r.objective as string, machineId: (r.machine_id as string | null) ?? null, cwd: (r.cwd as string | null) ?? null,
      plannerSessionId: (r.planner_session_id as string | null) ?? null, plannerCommandId: (r.planner_command_id as string | null) ?? null,
      status: r.status as PlanStatus, error: (r.error as string | null) ?? null, actor: r.actor as string,
      createdAt: r.created_at as number, updatedAt: r.updated_at as number, tasks,
    };
  }

  // ---------- Création ----------

  /** Décomposition par une session Claude Code lancée en mode plan (lecture seule) sur la machine choisie. */
  createWithPlanner(objective: string, machineId: string, cwd: string, actor: string, ip: string | null): Plan {
    const id = randomUUID();
    const now = Date.now();
    this.db.prepare(`INSERT INTO plans(id, objective, machine_id, cwd, status, actor, created_at, updated_at) VALUES (?, ?, ?, ?, 'planning', ?, ?, ?)`)
      .run(id, objective, machineId, cwd, actor, now, now);
    audit(this.db, actor, 'plan.created', id, { objective, machineId, cwd, planner: true }, ip);
    try {
      const c = this.commands.create({
        idempotencyKey: randomUUID(), machineId, confirmed: true,
        payload: { type: 'session.spawn', cwd, prompt: this.plannerPrompt(objective, cwd), permissionMode: 'plan' },
      }, `orchestrateur:${actor}`, ip);
      this.db.prepare('UPDATE plans SET planner_command_id = ? WHERE id = ?').run(c.id, id);
    } catch (e) {
      this.setPlan(id, { status: 'planning_failed', error: (e as Error).message });
    }
    return this.emit(id);
  }

  /** Plan saisi manuellement (sans planificateur). */
  createManual(objective: string, tasks: TaskInput[], actor: string, ip: string | null): Plan {
    const id = randomUUID();
    const now = Date.now();
    this.db.prepare(`INSERT INTO plans(id, objective, status, actor, created_at, updated_at) VALUES (?, ?, 'draft', ?, ?, ?)`).run(id, objective, actor, now, now);
    this.replaceTasks(id, tasks);
    audit(this.db, actor, 'plan.created', id, { objective, manual: true, tasks: tasks.length }, ip);
    return this.emit(id);
  }

  private plannerPrompt(objective: string, cwd: string): string {
    const sessions = [...this.store.sessions.values()]
      .filter((s) => s.status !== 'ended' && s.control.send)
      .map((s) => `- id=${s.id} projet=${s.project} dossier=${s.cwd} machine=${this.store.machine(s.machineId)?.name ?? '?'} statut=${s.status}`)
      .join('\n') || '(aucune session pilotable pour l’instant)';
    return [
      'Tu es le planificateur d’Agent Command Center. Tu ne modifies rien : analyse le dépôt en lecture seule.',
      `Objectif global : ${objective}`,
      `Dossier du projet : ${cwd}`,
      'Sessions Claude Code pilotables disponibles :',
      sessions,
      '',
      'Décompose l’objectif en 2 à 8 tâches concrètes et indépendantes autant que possible.',
      'Pour chaque tâche, indique si une commande shell exacte permet de prouver sa réussite (ex. « npm test »). Sinon, mets null : n’invente pas de vérification.',
      'Propose une session uniquement si son dossier correspond au travail ; sinon null.',
      'Réponds UNIQUEMENT par un bloc ```json au format :',
      '{"tasks":[{"key":"t1","title":"…","instructions":"…","dependsOn":[],"verify":"npm test","suggestedSession":"<id ou null>"}]}',
    ].join('\n');
  }

  // ---------- Édition ----------

  replaceTasks(planId: string, inputs: TaskInput[]): void {
    const plan = this.get(planId);
    if (!plan) throw new Error('Plan inconnu');
    if (plan.status !== 'draft' && plan.status !== 'planning_failed') throw new Error('Le plan n’est plus modifiable');
    const withIds = inputs.map((t) => ({ ...t, id: t.id ?? randomUUID() }));
    const err = validateDag(withIds);
    if (err) throw new Error(err);
    const now = Date.now();
    tx(this.db, () => {
      this.db.prepare('DELETE FROM plan_tasks WHERE plan_id = ?').run(planId);
      withIds.forEach((t, idx) => {
        this.db.prepare(`INSERT INTO plan_tasks(id, plan_id, idx, title, instructions, depends_on, verify, assignee_session_id, status, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`).run(t.id, planId, idx, t.title, t.instructions, JSON.stringify(t.dependsOn), t.verify?.trim() || null, t.assigneeSessionId, now);
      });
      this.db.prepare(`UPDATE plans SET status = 'draft', error = NULL, updated_at = ? WHERE id = ?`).run(now, planId);
    });
    this.emit(planId);
  }

  startPlan(planId: string, actor: string, ip: string | null): Plan {
    const plan = this.get(planId);
    if (!plan) throw new Error('Plan inconnu');
    if (plan.status !== 'draft') throw new Error('Seul un plan en brouillon peut être lancé');
    if (!plan.tasks.length) throw new Error('Le plan ne contient aucune tâche');
    for (const t of plan.tasks) {
      if (!t.assigneeSessionId) throw new Error(`Tâche « ${t.title} » sans session assignée`);
      const s = this.store.sessions.get(t.assigneeSessionId);
      if (!s || s.status === 'ended' || !s.control.send) throw new Error(`La session assignée à « ${t.title} » n’est pas pilotable`);
    }
    this.setPlan(planId, { status: 'running', error: null });
    audit(this.db, actor, 'plan.started', planId, { tasks: plan.tasks.length }, ip);
    this.tick();
    return this.get(planId)!;
  }

  cancel(planId: string, actor: string, ip: string | null): Plan {
    const plan = this.get(planId);
    if (!plan) throw new Error('Plan inconnu');
    if (plan.plannerSessionId && this.store.sessions.get(plan.plannerSessionId)?.control.stop) this.stopPlanner(plan);
    this.setPlan(planId, { status: 'cancelled' });
    audit(this.db, actor, 'plan.cancelled', planId, null, ip);
    return this.emit(planId);
  }

  /** Validation manuelle d'une tâche annoncée terminée, avec justification (tracée dans l'audit). */
  markVerified(planId: string, taskId: string, note: string, actor: string, ip: string | null): Plan {
    const t = this.get(planId)?.tasks.find((x) => x.id === taskId);
    if (!t) throw new Error('Tâche inconnue');
    if (t.status !== 'reported') throw new Error('Seule une tâche annoncée terminée peut être validée manuellement');
    this.setTask(taskId, { status: 'verified', evidence: { ts: Date.now(), eventId: 'manual', command: `Validation manuelle : ${note.slice(0, 200)}`, ok: true } });
    audit(this.db, actor, 'plan.task_verified_manually', planId, { taskId, note }, ip);
    this.tick();
    return this.emit(planId);
  }

  retryTask(planId: string, taskId: string, actor: string, ip: string | null): Plan {
    const t = this.get(planId)?.tasks.find((x) => x.id === taskId);
    if (!t || t.status !== 'failed') throw new Error('Seule une tâche en échec peut être relancée');
    this.setTask(taskId, { status: 'pending', error: null, dispatchedAt: null, commandId: null, report: null, evidence: null });
    this.setPlan(planId, { status: 'running', error: null });
    audit(this.db, actor, 'plan.task_retried', planId, { taskId }, ip);
    this.tick();
    return this.emit(planId);
  }

  // ---------- Réactions aux événements ----------

  onEvents(events: AccEvent[]): void {
    if (!events.length) return;
    const active = (this.db.prepare(`SELECT id FROM plans WHERE status IN ('planning','running','blocked')`).all() as { id: string }[]).map((r) => this.get(r.id)!);
    for (const plan of active) {
      let changed = false;
      if (plan.status === 'planning') changed = this.watchPlanner(plan, events) || changed;
      for (const t of plan.tasks) {
        if (!t.assigneeSessionId || !t.dispatchedAt) continue;
        if (t.status !== 'dispatched' && t.status !== 'reported') continue;
        for (const ev of events) {
          if (ev.sessionId !== t.assigneeSessionId || ev.ts < t.dispatchedAt) continue;
          changed = this.applyTaskEvent(t, ev) || changed;
        }
      }
      if (changed) this.emit(plan.id);
    }
    // Une session qui repasse au repos peut débloquer une distribution, même sans changement de tâche.
    if (active.length) this.tick();
  }

  onCommandFinished(c: CommandRecord): void {
    // Planificateur lancé : on mémorise sa session pour lire son résultat.
    const plan = this.db.prepare('SELECT id FROM plans WHERE planner_command_id = ?').get(c.id) as { id: string } | undefined;
    if (plan) {
      if (c.status === 'ok' && c.result && typeof c.result === 'object' && 'sessionId' in c.result) {
        this.db.prepare('UPDATE plans SET planner_session_id = ?, updated_at = ? WHERE id = ?').run(String((c.result as { sessionId: unknown }).sessionId), Date.now(), plan.id);
      } else if (c.status !== 'ok') {
        this.setPlan(plan.id, { status: 'planning_failed', error: `Planificateur non lancé : ${c.error ?? c.status}` });
      }
      this.emit(plan.id);
      return;
    }
    const task = this.db.prepare('SELECT id, plan_id FROM plan_tasks WHERE command_id = ?').get(c.id) as { id: string; plan_id: string } | undefined;
    if (task && (c.status === 'error' || c.status === 'timeout' || c.status === 'rejected')) {
      this.setTask(task.id, { status: 'failed', error: `Instruction non transmise : ${c.error ?? c.status}` });
      this.tick();
      this.emit(task.plan_id);
    }
  }

  private watchPlanner(plan: Plan, events: AccEvent[]): boolean {
    if (!plan.plannerSessionId) return false;
    for (const ev of events) {
      if (ev.sessionId !== plan.plannerSessionId) continue;
      if (ev.type === 'TurnResult' || ev.type === 'Stop') {
        const text = typeof ev.data.result === 'string' ? ev.data.result : typeof ev.data.last_assistant_message === 'string' ? ev.data.last_assistant_message : '';
        if (!text) continue;
        try {
          const out = parsePlannerOutput(text);
          const keyToId = new Map<string, string>(out.tasks.map((t) => [t.key, randomUUID()]));
          const tasks: TaskInput[] = out.tasks.map((t) => {
            const suggested = t.suggestedSession && this.store.sessions.get(t.suggestedSession)?.control.send ? t.suggestedSession : null;
            return {
              id: keyToId.get(t.key)!, title: t.title, instructions: t.instructions,
              dependsOn: t.dependsOn.map((k) => keyToId.get(k)).filter((x): x is string => !!x),
              verify: t.verify ?? null, assigneeSessionId: suggested,
            };
          });
          this.setPlan(plan.id, { status: 'draft' });
          this.replaceTasks(plan.id, tasks);
        } catch (e) {
          this.setPlan(plan.id, { status: 'planning_failed', error: `Réponse du planificateur inexploitable : ${(e as Error).message.slice(0, 300)}` });
        }
        this.stopPlanner(plan);
        return true;
      }
      if (ev.type === 'ManagedSessionError' || ev.type === 'ManagedSessionClosed' || (ev.type === 'TurnResult' && ev.data.is_error)) {
        this.setPlan(plan.id, { status: 'planning_failed', error: `Planificateur interrompu (${ev.type})` });
        return true;
      }
    }
    return false;
  }

  private stopPlanner(plan: Plan): void {
    if (!plan.plannerSessionId || !plan.machineId) return;
    try {
      this.commands.create({ idempotencyKey: randomUUID(), machineId: plan.machineId, confirmed: true, payload: { type: 'session.stop', sessionId: plan.plannerSessionId } }, 'orchestrateur', null);
    } catch { /* session déjà fermée */ }
  }

  private applyTaskEvent(t: PlanTask, ev: AccEvent): boolean {
    const d = ev.data;
    const isVerify = (cmd: unknown) => !!t.verify && typeof cmd === 'string' && cmd.includes(t.verify);
    const bashCmd = d.tool_name === 'Bash' ? (d.tool_input as { command?: unknown } | undefined)?.command : undefined;
    if (ev.type === 'PostToolUse' && isVerify(bashCmd)) {
      t.evidence = { ts: ev.ts, eventId: ev.id, command: String(bashCmd).slice(0, 300), ok: true };
      this.setTask(t.id, { evidence: t.evidence, ...(t.status === 'reported' ? { status: 'verified' } : {}) });
      if (t.status === 'reported') t.status = 'verified';
      return true;
    }
    if (ev.type === 'PostToolUseFailure' && isVerify(bashCmd)) {
      t.evidence = { ts: ev.ts, eventId: ev.id, command: String(bashCmd).slice(0, 300), ok: false };
      this.setTask(t.id, { evidence: t.evidence });
      return true;
    }
    if ((ev.type === 'Stop' || (ev.type === 'TurnResult' && !d.is_error)) && t.status === 'dispatched') {
      const report = typeof d.last_assistant_message === 'string' ? d.last_assistant_message : typeof d.result === 'string' ? d.result : null;
      // Annoncée terminée. Vérifiée seulement si la dernière exécution de la commande de preuve a réussi.
      const status: TaskStatus = t.verify ? (t.evidence?.ok ? 'verified' : t.evidence && !t.evidence.ok ? 'failed' : 'reported') : 'reported';
      const error = status === 'failed' ? `La vérification « ${t.verify} » a échoué` : null;
      this.setTask(t.id, { status, report: report?.slice(0, 4000) ?? null, error });
      t.status = status;
      return true;
    }
    if (ev.type === 'StopFailure' || ev.type === 'ManagedSessionError' || (ev.type === 'TurnResult' && d.is_error)) {
      this.setTask(t.id, { status: 'failed', error: `Échec observé (${ev.type})` });
      t.status = 'failed';
      return true;
    }
    if (ev.type === 'SessionEnd' || ev.type === 'ManagedSessionClosed') {
      if (t.status === 'dispatched') { this.setTask(t.id, { status: 'failed', error: 'Session terminée avant la fin de la tâche' }); t.status = 'failed'; return true; }
    }
    return false;
  }

  /** Distribue les tâches prêtes et met à jour le statut global des plans actifs. */
  tick(): void {
    const active = (this.db.prepare(`SELECT id FROM plans WHERE status IN ('running','blocked')`).all() as { id: string }[]).map((r) => this.get(r.id)!);
    for (const plan of active) {
      const byId = new Map(plan.tasks.map((t) => [t.id, t]));
      for (const t of plan.tasks) {
        if (t.status !== 'pending') continue;
        if (!t.dependsOn.every((d) => { const dep = byId.get(d); return dep && isSatisfied(dep); })) continue;
        const s = t.assigneeSessionId ? this.store.sessions.get(t.assigneeSessionId) : undefined;
        if (!s || s.status === 'ended' || !s.control.send) { this.setTask(t.id, { status: 'failed', error: 'Session assignée indisponible' }); t.status = 'failed'; continue; }
        // On n'envoie qu'à une session au repos, pour que le prochain « tour terminé » soit bien celui de la tâche.
        if (s.status !== 'idle' && s.status !== 'unknown') continue;
        if (plan.tasks.some((o) => o.assigneeSessionId === s.id && o.status === 'dispatched')) continue;
        try {
          const now = Date.now();
          const c = this.commands.create({
            idempotencyKey: randomUUID(), machineId: s.machineId, confirmed: false,
            payload: { type: 'session.send', sessionId: s.id, text: this.taskMessage(plan, t) },
          }, `orchestrateur:${plan.actor}`, null);
          this.setTask(t.id, { status: 'dispatched', dispatchedAt: now, commandId: c.id });
          t.status = 'dispatched';
        } catch (e) {
          const msg = (e as Error).message;
          // Verrou occupé ou machine momentanément hors ligne : on réessaiera au prochain cycle.
          if (!/déjà en cours|hors ligne/.test(msg)) { this.setTask(t.id, { status: 'failed', error: msg }); t.status = 'failed'; }
        }
      }
      const fresh = this.get(plan.id)!;
      const all = fresh.tasks;
      const next: PlanStatus = all.every(isSatisfied) ? 'completed' : all.some((t) => t.status === 'failed') ? 'blocked' : 'running';
      if (next !== plan.status) { this.setPlan(plan.id, { status: next }); this.emit(plan.id); }
    }
  }

  private taskMessage(plan: Plan, t: PlanTask): string {
    return [
      `Tâche orchestrée « ${t.title} » (objectif global : ${plan.objective})`,
      '',
      t.instructions,
      '',
      t.verify ? `Quand tu as terminé, exécute exactement \`${t.verify}\` pour prouver la réussite, puis résume le résultat.` : 'Quand tu as terminé, résume précisément ce que tu as fait et ce qui reste éventuellement à faire.',
    ].join('\n');
  }

  private setPlan(id: string, patch: { status?: PlanStatus; error?: string | null }): void {
    const sets: string[] = ['updated_at = ?'];
    const args: (string | number | null)[] = [Date.now()];
    if (patch.status) { sets.push('status = ?'); args.push(patch.status); }
    if (patch.error !== undefined) { sets.push('error = ?'); args.push(patch.error); }
    this.db.prepare(`UPDATE plans SET ${sets.join(', ')} WHERE id = ?`).run(...args, id);
  }

  private setTask(id: string, patch: Partial<Pick<PlanTask, 'status' | 'dispatchedAt' | 'commandId' | 'report' | 'evidence' | 'error'>>): void {
    const cols: Record<string, string> = { status: 'status', dispatchedAt: 'dispatched_at', commandId: 'command_id', report: 'report', evidence: 'evidence', error: 'error' };
    const sets: string[] = ['updated_at = ?'];
    const args: (string | number | null)[] = [Date.now()];
    for (const [k, v] of Object.entries(patch)) {
      sets.push(`${cols[k]} = ?`);
      args.push(k === 'evidence' ? (v ? JSON.stringify(v) : null) : (v as string | number | null));
    }
    this.db.prepare(`UPDATE plan_tasks SET ${sets.join(', ')} WHERE id = ?`).run(...args, id);
  }

  private emit(id: string): Plan {
    const p = this.get(id)!;
    this.onChange(p);
    return p;
  }
}
