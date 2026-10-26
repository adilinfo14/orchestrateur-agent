import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  ArrowRight, Ban, BadgeCheck, CheckCircle2, CircleDashed, FlaskConical, GitBranch, KeyRound, Loader2, Plus, RotateCcw, Send, Sparkles, Trash2, Workflow, XCircle,
} from 'lucide-react';
import type { Plan, PlanTask, TaskStatus } from '../../../../packages/protocol/src/index.ts';
import { api } from '../lib/api.ts';
import { ago, cx, shortPath, useNow } from '../lib/format.ts';
import { setPlans, useLive } from '../lib/live.ts';
import { useDialogs } from '../components/dialogs.tsx';
import { Badge, Button, Empty, PageHeader, Panel, Spinner, StatusDot } from '../components/ui.tsx';

const PLAN_STATUS: Record<Plan['status'], { label: string; tone: 'neutral' | 'accent' | 'warn' | 'ok' | 'error' }> = {
  planning: { label: 'Décomposition…', tone: 'accent' }, planning_failed: { label: 'Décomposition échouée', tone: 'error' }, draft: { label: 'À valider', tone: 'warn' },
  running: { label: 'En cours', tone: 'accent' }, blocked: { label: 'Bloqué', tone: 'error' }, completed: { label: 'Terminé', tone: 'ok' }, cancelled: { label: 'Annulé', tone: 'neutral' },
};

const TASK_STATUS: Record<TaskStatus, { label: string; icon: typeof CheckCircle2; cls: string }> = {
  pending: { label: 'En attente', icon: CircleDashed, cls: 'text-faint' },
  dispatched: { label: 'Envoyée', icon: Loader2, cls: 'text-working' },
  reported: { label: 'Annoncée terminée · sans preuve', icon: CheckCircle2, cls: 'text-waiting' },
  verified: { label: 'Vérifiée', icon: BadgeCheck, cls: 'text-ok' },
  failed: { label: 'Échec', icon: XCircle, cls: 'text-error' },
};

type Draft = { id: string; title: string; instructions: string; dependsOn: string[]; verify: string; assigneeSessionId: string };

const toDraft = (t: PlanTask): Draft => ({ id: t.id, title: t.title, instructions: t.instructions, dependsOn: t.dependsOn, verify: t.verify ?? '', assigneeSessionId: t.assigneeSessionId ?? '' });
const field = 'w-full rounded-md border border-line bg-bg px-2.5 py-1.5 text-[12.5px] outline-none focus:border-line-strong placeholder:text-faint';

function NewPlan({ onCreated }: { onCreated: (p: Plan) => void }) {
  const machines = useLive((s) => s.machines);
  const sessions = useLive((s) => s.sessions);
  const { confirm, toast } = useDialogs();
  const [objective, setObjective] = useState('');
  const [mode, setMode] = useState<'planner' | 'manual'>('planner');
  const [machineId, setMachineId] = useState('');
  const [cwd, setCwd] = useState('');
  const [busy, setBusy] = useState(false);

  const spawnMachines = [...machines.values()].filter((m) => m.online && m.allowControl && m.capabilities?.sdkSpawn);
  const cwdOptions = useMemo(() => {
    const m = machines.get(machineId);
    const roots = m?.capabilities?.allowedRoots ?? [];
    const fromSessions = [...sessions.values()].filter((s) => s.machineId === machineId && s.cwd && roots.some((r) => s.cwd!.startsWith(r))).map((s) => s.cwd!);
    return [...new Set([...fromSessions, ...roots])];
  }, [machines, sessions, machineId]);

  useEffect(() => { if (!machineId && spawnMachines[0]) setMachineId(spawnMachines[0].id); }, [spawnMachines, machineId]);
  useEffect(() => { if (!cwdOptions.includes(cwd)) setCwd(cwdOptions[0] ?? ''); }, [cwdOptions, cwd]);

  const create = async () => {
    if (mode === 'planner') {
      const ok = await confirm({
        title: 'Lancer la décomposition ?',
        body: <>Une session Claude Code sera lancée sur <b>{machines.get(machineId)?.name}</b> dans <span className="mono">{cwd}</span>, en <b>mode plan</b> (lecture seule). Elle consomme votre abonnement comme une session normale. Aucune tâche ne sera exécutée avant votre validation.</>,
        confirmLabel: 'Décomposer',
      });
      if (!ok) return;
    }
    setBusy(true);
    try {
      const body = mode === 'planner'
        ? { objective, machineId, cwd, confirmed: true }
        : { objective, tasks: [{ title: 'Tâche 1', instructions: objective, dependsOn: [], verify: null, assigneeSessionId: null }] };
      const p = await api<Plan>('/api/plans', { method: 'POST', body });
      setObjective('');
      onCreated(p);
    } catch (e) { toast('error', (e as Error).message); } finally { setBusy(false); }
  };

  return (
    <Panel title="Nouvel objectif" bodyClass="p-4 space-y-3">
      <textarea value={objective} onChange={(e) => setObjective(e.target.value)} rows={3} className={field + ' resize-none text-[13px]'}
        placeholder="Ex. : Termine le développement de BasketVision, exécute les tests et vérifie les animations." />
      <div className="flex rounded-md border border-line p-0.5 w-fit">
        {(['planner', 'manual'] as const).map((m) => (
          <button key={m} onClick={() => setMode(m)} className={cx('h-6 px-2.5 rounded text-[11.5px]', mode === m ? 'bg-hover text-fg' : 'text-muted hover:text-fg')}>
            {m === 'planner' ? 'Décomposer avec Claude' : 'Saisie manuelle'}
          </button>
        ))}
      </div>
      {mode === 'planner' && (spawnMachines.length ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          <select value={machineId} onChange={(e) => setMachineId(e.target.value)} className={field}>
            {spawnMachines.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
          </select>
          <select value={cwd} onChange={(e) => setCwd(e.target.value)} className={field}>
            {cwdOptions.map((c) => <option key={c} value={c}>{shortPath(c, 3)}</option>)}
          </select>
        </div>
      ) : <p className="text-[12px] text-faint">Aucune machine connectée n’autorise le lancement de sessions (racines autorisées vides). Utilisez la saisie manuelle ou configurez <span className="mono">allow-root</span> sur un collecteur.</p>)}
      <div className="flex justify-end">
        <Button variant="primary" onClick={create} disabled={busy || objective.trim().length < 3 || (mode === 'planner' && (!machineId || !cwd))}>
          {busy ? <Spinner /> : mode === 'planner' ? <Sparkles size={14} /> : <Plus size={14} />} {mode === 'planner' ? 'Décomposer' : 'Créer le plan'}
        </Button>
      </div>
    </Panel>
  );
}

function DraftEditor({ plan }: { plan: Plan }) {
  const sessions = useLive((s) => s.sessions);
  const machines = useLive((s) => s.machines);
  const { confirm, toast } = useDialogs();
  const [tasks, setTasks] = useState<Draft[]>(() => plan.tasks.map(toDraft));
  const [busy, setBusy] = useState(false);
  useEffect(() => setTasks(plan.tasks.map(toDraft)), [plan.id, plan.updatedAt]);

  const controllable = [...sessions.values()].filter((s) => s.status !== 'ended' && s.control.send);
  const update = (i: number, patch: Partial<Draft>) => setTasks((t) => t.map((x, j) => (j === i ? { ...x, ...patch } : x)));
  const payload = () => tasks.map((t) => ({ id: t.id, title: t.title, instructions: t.instructions, dependsOn: t.dependsOn, verify: t.verify.trim() || null, assigneeSessionId: t.assigneeSessionId || null }));

  const save = async () => {
    setBusy(true);
    try { await api(`/api/plans/${plan.id}/tasks`, { method: 'PUT', body: { tasks: payload() } }); toast('ok', 'Plan enregistré'); return true; }
    catch (e) { toast('error', (e as Error).message); return false; } finally { setBusy(false); }
  };

  const start = async () => {
    if (!(await save())) return;
    const ok = await confirm({
      title: 'Valider et lancer le plan ?',
      body: (
        <ul className="space-y-1 mt-1">
          {tasks.map((t) => { const s = sessions.get(t.assigneeSessionId); return <li key={t.id}>• <b>{t.title}</b> → {s ? `${s.project} · ${machines.get(s.machineId)?.name}` : <span className="text-error">non assignée</span>}</li>; })}
          <li className="pt-2 text-faint">Les tâches seront envoyées une à une, dans l’ordre des dépendances, aux sessions au repos.</li>
        </ul>
      ),
      confirmLabel: 'Lancer',
    });
    if (!ok) return;
    try { await api(`/api/plans/${plan.id}/start`, { method: 'POST', body: { confirmed: true } }); } catch (e) { toast('error', (e as Error).message); }
  };

  return (
    <div className="space-y-3">
      {tasks.map((t, i) => (
        <div key={t.id} className="rounded-lg border border-line bg-bg/50 p-3 space-y-2 animate-slide-up">
          <div className="flex items-center gap-2">
            <span className="mono text-[11px] text-faint w-6">T{i + 1}</span>
            <input value={t.title} onChange={(e) => update(i, { title: e.target.value })} className={field + ' font-medium'} />
            <button onClick={() => setTasks((x) => x.filter((_, j) => j !== i).map((y) => ({ ...y, dependsOn: y.dependsOn.filter((d) => d !== t.id) })))} className="p-1.5 text-faint hover:text-error" aria-label="Supprimer"><Trash2 size={13} /></button>
          </div>
          <textarea value={t.instructions} onChange={(e) => update(i, { instructions: e.target.value })} rows={3} className={field + ' resize-y'} />
          <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
            <label className="text-[11px] text-faint space-y-1"><span className="flex items-center gap-1"><Send size={11} />Session assignée</span>
              <select value={t.assigneeSessionId} onChange={(e) => update(i, { assigneeSessionId: e.target.value })} className={field}>
                <option value="">— choisir —</option>
                {controllable.map((s) => <option key={s.id} value={s.id}>{s.project} · {s.name ?? s.id.slice(0, 6)} · {machines.get(s.machineId)?.name} ({s.control.send})</option>)}
              </select>
            </label>
            <label className="text-[11px] text-faint space-y-1"><span className="flex items-center gap-1"><FlaskConical size={11} />Commande de preuve (facultatif)</span>
              <input value={t.verify} onChange={(e) => update(i, { verify: e.target.value })} placeholder="ex. npm test" className={field + ' mono'} />
            </label>
          </div>
          {i > 0 && (
            <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-faint"><GitBranch size={11} />Dépend de :
              {tasks.slice(0, tasks.length).filter((o) => o.id !== t.id).map((o) => {
                const on = t.dependsOn.includes(o.id);
                return <button key={o.id} onClick={() => update(i, { dependsOn: on ? t.dependsOn.filter((d) => d !== o.id) : [...t.dependsOn, o.id] })}
                  className={cx('h-5 px-1.5 rounded border', on ? 'border-accent/40 text-accent bg-accent/10' : 'border-line hover:text-fg')}>T{tasks.indexOf(o) + 1}</button>;
              })}
            </div>
          )}
        </div>
      ))}
      <div className="flex flex-wrap gap-2 justify-between">
        <Button size="sm" variant="ghost" onClick={() => setTasks((t) => [...t, { id: crypto.randomUUID(), title: `Tâche ${t.length + 1}`, instructions: '', dependsOn: [], verify: '', assigneeSessionId: '' }])}><Plus size={13} /> Ajouter une tâche</Button>
        <div className="flex gap-2">
          <Button size="sm" onClick={save} disabled={busy}>Enregistrer</Button>
          <Button size="sm" variant="primary" onClick={start} disabled={busy || !tasks.length}><ArrowRight size={13} /> Valider et lancer</Button>
        </div>
      </div>
      {!controllable.length && <p className="text-[11.5px] text-waiting">Aucune session pilotable : ouvrez des sessions avec les hooks installés, ou lancez-en depuis le cockpit.</p>}
    </div>
  );
}

function TaskCard({ plan, t, index }: { plan: Plan; t: PlanTask; index: number }) {
  const now = useNow(5000);
  const { toast } = useDialogs();
  const s = useLive((st) => (t.assigneeSessionId ? st.sessions.get(t.assigneeSessionId) : undefined));
  const meta = TASK_STATUS[t.status];
  const Icon = meta.icon;
  const blocked = t.status === 'dispatched' && s && (s.status === 'waiting' || s.status === 'error');
  const deps = t.dependsOn.map((d) => plan.tasks.findIndex((x) => x.id === d) + 1).filter((n) => n > 0);

  const verify = async () => {
    const note = window.prompt('Justification de la validation manuelle (tracée dans l’audit) :');
    if (!note || note.trim().length < 3) return;
    try { await api(`/api/plans/${plan.id}/tasks/${t.id}/verify`, { method: 'POST', body: { note, confirmed: true } }); } catch (e) { toast('error', (e as Error).message); }
  };
  const retry = async () => { try { await api(`/api/plans/${plan.id}/tasks/${t.id}/retry`, { method: 'POST', body: {} }); } catch (e) { toast('error', (e as Error).message); } };

  return (
    <div className={cx('rounded-lg border bg-bg/40 p-3 transition-colors', blocked ? 'border-waiting/40 glow-waiting' : t.status === 'dispatched' ? 'border-working/30' : 'border-line')}>
      <div className="flex items-center gap-2">
        <span className="mono text-[11px] text-faint">T{index + 1}</span>
        <span className="text-[13px] font-medium truncate">{t.title}</span>
        <span className={cx('ml-auto flex items-center gap-1 text-[11.5px] shrink-0', meta.cls)}><Icon size={13} className={t.status === 'dispatched' ? 'animate-spin' : ''} />{meta.label}</span>
      </div>
      <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[11px] text-faint">
        {s ? <Link to={`/sessions/${s.id}`} className="flex items-center gap-1 hover:text-fg"><StatusDot status={s.status} size={6} />{s.project} · {s.name ?? s.id.slice(0, 6)}</Link> : <span>session inconnue</span>}
        {deps.length > 0 && <span>· dépend de {deps.map((d) => `T${d}`).join(', ')}</span>}
        {t.verify && <Badge><FlaskConical size={10} />{t.verify}</Badge>}
        {t.dispatchedAt && <span>· envoyée {ago(t.dispatchedAt, now)}</span>}
      </div>
      {blocked && <p className="mt-2 text-[12px] text-waiting flex items-center gap-1.5"><KeyRound size={12} />Bloquée : {s!.waitingFor ?? s!.lastError ?? 'la session attend une intervention'}</p>}
      {t.error && <p className="mt-2 text-[12px] text-error">{t.error}</p>}
      {t.evidence && (
        <p className={cx('mt-2 text-[11.5px] mono flex items-center gap-1.5', t.evidence.ok ? 'text-ok' : 'text-error')}>
          {t.evidence.ok ? <BadgeCheck size={12} /> : <XCircle size={12} />}Preuve : {t.evidence.command} {t.evidence.eventId !== 'manual' && `· ${ago(t.evidence.ts, now)}`}
        </p>
      )}
      {t.report && <p className="mt-2 text-[12px] text-muted line-clamp-4 whitespace-pre-wrap border-l-2 border-line pl-2.5">{t.report}</p>}
      {(t.status === 'reported' || t.status === 'failed') && plan.status !== 'cancelled' && (
        <div className="mt-2.5 flex gap-2 justify-end">
          {t.status === 'reported' && <Button size="sm" onClick={verify}><BadgeCheck size={13} /> Valider manuellement</Button>}
          {t.status === 'failed' && <Button size="sm" onClick={retry}><RotateCcw size={13} /> Relancer</Button>}
        </div>
      )}
    </div>
  );
}

function PlanDetail({ plan }: { plan: Plan }) {
  const now = useNow(10000);
  const { confirm, toast } = useDialogs();
  const meta = PLAN_STATUS[plan.status];
  const verified = plan.tasks.filter((t) => t.status === 'verified').length;
  const reported = plan.tasks.filter((t) => t.status === 'reported').length;

  const cancel = async () => {
    if (!(await confirm({ title: 'Annuler ce plan ?', body: 'Aucune nouvelle tâche ne sera envoyée. Les sessions déjà en train de travailler continuent leur tour en cours.', danger: true, confirmLabel: 'Annuler le plan' }))) return;
    try { await api(`/api/plans/${plan.id}/cancel`, { method: 'POST', body: {} }); } catch (e) { toast('error', (e as Error).message); }
  };

  return (
    <Panel
      title={<span className="flex items-center gap-2">Plan <Badge tone={meta.tone}>{meta.label}</Badge></span>}
      actions={['planning', 'draft', 'running', 'blocked'].includes(plan.status) ? <Button size="sm" variant="ghost" onClick={cancel}><Ban size={13} /> Annuler</Button> : undefined}
      bodyClass="p-4 space-y-4"
    >
      <div>
        <p className="text-[14px] leading-relaxed">{plan.objective}</p>
        <p className="mt-1 text-[11px] text-faint">Créé {ago(plan.createdAt, now)} par {plan.actor}{plan.cwd ? ` · ${shortPath(plan.cwd, 3)}` : ''}</p>
      </div>
      {plan.status === 'planning' && (
        <div className="flex items-center gap-2 text-[12.5px] text-accent"><Spinner />
          {plan.plannerSessionId ? <>Claude analyse le projet en mode plan… <Link to={`/sessions/${plan.plannerSessionId}`} className="underline">suivre la session</Link></> : 'Lancement de la session de planification…'}
        </div>
      )}
      {plan.error && <p className="text-[12.5px] text-error">{plan.error}</p>}
      {(plan.status === 'draft' || plan.status === 'planning_failed') && <DraftEditor plan={plan} />}
      {['running', 'blocked', 'completed', 'cancelled'].includes(plan.status) && (
        <>
          <div className="flex flex-wrap gap-3 text-[12px] text-muted">
            <span><b className="text-ok tabular">{verified}</b> vérifiée{verified > 1 ? 's' : ''}</span>
            <span><b className="text-waiting tabular">{reported}</b> annoncée{reported > 1 ? 's' : ''} sans preuve</span>
            <span><b className="tabular">{plan.tasks.length}</b> au total</span>
          </div>
          <div className="space-y-2">{plan.tasks.map((t, i) => <TaskCard key={t.id} plan={plan} t={t} index={i} />)}</div>
        </>
      )}
    </Panel>
  );
}

export function Orchestrate() {
  const plans = useLive((s) => s.plans);
  const [selected, setSelected] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => { api<Plan[]>('/api/plans').then((l) => { setPlans(l); setLoading(false); if (l[0]) setSelected((x) => x ?? l[0]!.id); }, () => setLoading(false)); }, []);

  const list = [...plans.values()].sort((a, b) => b.createdAt - a.createdAt);
  const current = selected ? plans.get(selected) : undefined;

  return (
    <div className="p-4 md:p-6 max-w-[1400px] mx-auto">
      <PageHeader title="Orchestration" subtitle="Décomposer un objectif, valider la répartition, suivre l’exécution sur preuves" />
      <div className="grid grid-cols-1 lg:grid-cols-[360px_1fr] gap-5">
        <div className="space-y-5">
          <NewPlan onCreated={(p) => { setPlans([p]); setSelected(p.id); }} />
          <Panel title="Plans" bodyClass="py-1">
            {loading ? <div className="py-6 grid place-items-center text-faint"><Spinner /></div> : list.length ? list.map((p) => (
              <button key={p.id} onClick={() => setSelected(p.id)} className={cx('w-full text-left px-4 py-2.5 border-b border-line last:border-0 transition-colors', selected === p.id ? 'bg-hover' : 'hover:bg-hover/50')}>
                <div className="flex items-center gap-2"><span className="text-[12.5px] truncate flex-1">{p.objective}</span><Badge tone={PLAN_STATUS[p.status].tone}>{PLAN_STATUS[p.status].label}</Badge></div>
                <div className="mt-0.5 text-[11px] text-faint">{p.tasks.length} tâche{p.tasks.length > 1 ? 's' : ''}</div>
              </button>
            )) : <Empty icon={<Workflow size={22} />} title="Aucun plan" />}
          </Panel>
        </div>
        <div className="min-w-0">
          {current ? <PlanDetail plan={current} /> : (
            <Panel><Empty icon={<Workflow size={26} />} title="Définissez un objectif global">
              Claude le décompose en tâches (en lecture seule), vous validez la répartition, puis le cockpit distribue les tâches aux sessions pilotables et suit leur exécution.
              Une tâche n’est marquée « vérifiée » que sur preuve observée.
            </Empty></Panel>
          )}
        </div>
      </div>
    </div>
  );
}
