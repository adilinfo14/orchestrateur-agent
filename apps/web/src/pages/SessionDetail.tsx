import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { AnimatePresence, motion } from 'motion/react';
import {
  ArrowLeft, Bot, CheckCircle2, CircleSlash, Clock, FileCode2, Info, KeyRound, OctagonX, Pause, Send, ShieldCheck, ShieldX, Wrench, XCircle,
} from 'lucide-react';
import type { AccEvent, AgentView, CommandRecord, FileTouch } from '../../../../packages/protocol/src/index.ts';
import { api } from '../lib/api.ts';
import { COMMAND_LABEL, sendCommand } from '../lib/commands.ts';
import { ago, clock, cx, PLATFORM_LABEL, shortPath, SOURCE_LABEL, useNow } from '../lib/format.ts';
import { useLive, type Session } from '../lib/live.ts';
import { EventRow } from '../components/EventRow.tsx';
import { EventList } from '../components/EventList.tsx';
import { useDialogs } from '../components/dialogs.tsx';
import { Badge, Button, Empty, Kbd, Panel, Spinner, StatusPill } from '../components/ui.tsx';

interface Detail { session: Session; agents: AgentView[]; files: FileTouch[]; events: AccEvent[]; commands: CommandRecord[] }
type Tab = 'history' | 'tools' | 'files' | 'agents' | 'errors' | 'commands';

const ENTRY_HINT: Record<string, string> = { 'claude-vscode': 'VS Code', cli: 'terminal' };

function CommandStatusIcon({ c }: { c: CommandRecord }) {
  if (c.status === 'ok') return <CheckCircle2 size={14} className="text-ok" />;
  if (c.status === 'error' || c.status === 'rejected') return <XCircle size={14} className="text-error" />;
  if (c.status === 'timeout') return <Clock size={14} className="text-waiting" />;
  return <Spinner className="text-working" />;
}

const STATUS_LABEL: Record<CommandRecord['status'], string> = { pending: 'En préparation', sent: 'Transmise', ok: 'Exécutée', error: 'Échec', timeout: 'Sans réponse', rejected: 'Refusée' };

export function SessionDetail() {
  const { id = '' } = useParams();
  const now = useNow(5000);
  const { confirm, toast } = useDialogs();
  const live = useLive((s) => s.sessions.get(id));
  const machine = useLive((s) => (live ? s.machines.get(live.machineId) : undefined));
  const liveEvents = useLive((s) => s.events);
  const liveAgents = useLive((s) => s.agents);
  const liveCommands = useLive((s) => s.commands);

  const [detail, setDetail] = useState<Detail | null>(null);
  const [missing, setMissing] = useState(false);
  const [older, setOlder] = useState<AccEvent[]>([]);
  const [exhausted, setExhausted] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [tab, setTab] = useState<Tab>('history');
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const textarea = useRef<HTMLTextAreaElement>(null);

  const load = useCallback(() => {
    api<Detail>(`/api/sessions/${id}`).then((d) => { setDetail(d); setMissing(false); }, () => setMissing(true));
  }, [id]);
  useEffect(() => { setDetail(null); setOlder([]); setExhausted(false); load(); }, [load]);

  const session = live ?? detail?.session;

  // Fusion : historique chargé + événements temps réel de cette session.
  const events = useMemo(() => {
    const map = new Map<string, AccEvent>();
    for (const e of [...(detail?.events ?? []), ...older]) map.set(e.id, e);
    for (const e of liveEvents) if (e.sessionId === id) map.set(e.id, e);
    return [...map.values()].sort((a, b) => b.ts - a.ts);
  }, [detail, older, liveEvents, id]);

  const agents = useMemo(() => {
    const map = new Map<string, AgentView>();
    for (const a of detail?.agents ?? []) map.set(a.id, a);
    for (const a of liveAgents.values()) if (a.sessionId === id) map.set(a.id, a);
    return [...map.values()].sort((a, b) => b.startedAt - a.startedAt);
  }, [detail, liveAgents, id]);

  const commands = useMemo(() => {
    const map = new Map<string, CommandRecord>();
    for (const c of detail?.commands ?? []) map.set(c.id, c);
    for (const c of liveCommands.values()) if (c.sessionId === id) map.set(c.id, c);
    return [...map.values()].sort((a, b) => b.createdAt - a.createdAt);
  }, [detail, liveCommands, id]);

  const files = useMemo(() => {
    const map = new Map<string, FileTouch>();
    for (const f of detail?.files ?? []) map.set(f.path, f);
    for (const e of liveEvents) {
      if (e.sessionId !== id || e.type !== 'PostToolUse') continue;
      const input = e.data.tool_input as Record<string, unknown> | undefined;
      const p = typeof input?.file_path === 'string' ? input.file_path : null;
      if (!p || !['Write', 'Edit', 'MultiEdit', 'NotebookEdit'].includes(String(e.data.tool_name))) continue;
      const known = map.get(p);
      // Fichier vu en direct mais pas encore dans l'instantané serveur : compteur minimal connu.
      if (!known) map.set(p, { sessionId: id, path: p, tool: String(e.data.tool_name), count: 1, lastTs: e.ts });
      else if (known.lastTs < e.ts) map.set(p, { ...known, lastTs: e.ts });
    }
    return [...map.values()].sort((a, b) => b.lastTs - a.lastTs);
  }, [detail, liveEvents, id]);

  const tools = useMemo(() => {
    const m = new Map<string, { ok: number; fail: number; last: number }>();
    for (const e of events) {
      if (e.type !== 'PostToolUse' && e.type !== 'PostToolUseFailure') continue;
      const name = String(e.data.tool_name ?? '?');
      const t = m.get(name) ?? { ok: 0, fail: 0, last: 0 };
      if (e.type === 'PostToolUse') t.ok++; else t.fail++;
      t.last = Math.max(t.last, e.ts);
      m.set(name, t);
    }
    return [...m.entries()].sort((a, b) => b[1].ok + b[1].fail - (a[1].ok + a[1].fail));
  }, [events]);

  const errors = useMemo(() => events.filter((e) => ['PostToolUseFailure', 'StopFailure', 'ManagedSessionError', 'AssistantError', 'PermissionDenied'].includes(e.type) || (e.type === 'TurnResult' && e.data.is_error)), [events]);
  const approvals = useMemo(() => events.filter((e) => e.type === 'PermissionRequest' || e.type === 'PermissionPending' || e.type === 'PermissionResolved' || (e.type === 'Notification' && e.data.notification_type === 'permission_prompt')), [events]);

  const loadMore = async () => {
    const last = events[events.length - 1];
    if (!last) return;
    setLoadingMore(true);
    try {
      const page = await api<AccEvent[]>(`/api/events?sessionId=${encodeURIComponent(id)}&limit=200&before=${last.ts}:${last.id}`);
      setOlder((o) => [...o, ...page]);
      if (page.length < 200) setExhausted(true);
    } finally { setLoadingMore(false); }
  };

  const inflight = commands.find((c) => c.status === 'pending' || c.status === 'sent');

  const run = async (label: string, fn: () => Promise<CommandRecord>) => {
    setBusy(true);
    try {
      const c = await fn();
      toast('info', `${label} transmise au collecteur`);
      return c;
    } catch (e) {
      toast('error', (e as Error).message);
      return null;
    } finally { setBusy(false); }
  };

  const send = async () => {
    if (!session || !text.trim()) return;
    const c = await run('Instruction', () => sendCommand(session.machineId, { type: 'session.send', sessionId: session.id, text: text.trim() }));
    if (c) setText('');
  };

  const interrupt = () => session && run('Interruption', () => sendCommand(session.machineId, { type: 'session.interrupt', sessionId: session.id }));

  const stop = async () => {
    if (!session) return;
    const ok = await confirm({ title: 'Arrêter cette session ?', body: 'Le processus Claude Code lancé par le cockpit sera fermé. Le travail en cours dans ce tour sera interrompu.', confirmLabel: 'Arrêter', danger: true });
    if (ok) await run('Arrêt', () => sendCommand(session.machineId, { type: 'session.stop', sessionId: session.id }, true));
  };

  const respond = async (requestId: string, toolName: string, input: unknown, decision: 'allow' | 'deny') => {
    if (!session) return;
    if (decision === 'allow') {
      const ok = await confirm({
        title: `Autoriser ${toolName} ?`,
        body: <pre className="mono text-[11.5px] whitespace-pre-wrap break-all max-h-60 overflow-auto rounded-md bg-bg border border-line p-2.5 text-fg/90">{JSON.stringify(input, null, 2)}</pre>,
        confirmLabel: 'Autoriser une fois',
      });
      if (!ok) return;
    }
    await run('Décision', () => sendCommand(session.machineId, { type: 'permission.respond', sessionId: session.id, requestId, decision }, true));
  };

  if (missing && !session) return <div className="p-6"><Panel><Empty title="Session introuvable">Elle a peut-être été purgée (au-delà de la durée de rétention).</Empty></Panel></div>;
  if (!session) return <div className="h-full grid place-items-center text-faint"><Spinner /></div>;

  const channel = session.control.send;
  const machineReady = !!machine?.online && machine.allowControl;
  const pending = session.pendingPermissions ?? [];

  const TABS: { key: Tab; label: string; count?: number }[] = [
    { key: 'history', label: 'Historique' }, { key: 'tools', label: 'Outils', count: tools.length }, { key: 'files', label: 'Fichiers', count: files.length },
    { key: 'agents', label: 'Sous-agents', count: agents.length }, { key: 'errors', label: 'Erreurs', count: errors.length }, { key: 'commands', label: 'Commandes', count: commands.length },
  ];

  return (
    <div className="p-4 md:p-6 max-w-[1400px] mx-auto">
      <Link to="/" className="inline-flex items-center gap-1 text-[12px] text-muted hover:text-fg mb-4"><ArrowLeft size={13} /> Vue d’ensemble</Link>

      {/* En-tête */}
      <div className="flex flex-wrap items-start justify-between gap-4 mb-5">
        <div className="min-w-0">
          <div className="flex items-center gap-3 flex-wrap">
            <h1 className="text-[20px] font-semibold tracking-[-0.015em]">{session.project ?? 'Projet inconnu'}</h1>
            <StatusPill status={session.status} />
          </div>
          <p className="mt-1 text-[12px] text-muted mono truncate" title={session.cwd ?? ''}>{session.name ?? session.id} · {session.cwd ?? 'dossier inconnu'}</p>
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            <Badge>{machine?.name ?? 'machine'}{machine?.platform ? ` · ${PLATFORM_LABEL[machine.platform]}` : ''}</Badge>
            {session.entrypoint && <Badge>{ENTRY_HINT[session.entrypoint] ?? session.entrypoint}</Badge>}
            {session.pid && <Badge>pid {session.pid}</Badge>}
            {session.sources.map((src) => <Badge key={src} tone={src === 'registry' ? 'warn' : 'neutral'} title="Source des données">{SOURCE_LABEL[src] ?? src}</Badge>)}
            <span className="text-[11px] text-faint ml-1">Dernière activité {ago(session.lastEventAt, now)}</span>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {session.control.interrupt && <Button onClick={interrupt} disabled={busy || !machineReady || session.status !== 'working'}><Pause size={14} /> Interrompre</Button>}
          {session.control.stop && <Button variant="danger" onClick={stop} disabled={busy || !machineReady}><OctagonX size={14} /> Arrêter</Button>}
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[1fr_360px] gap-5">
        <div className="min-w-0 space-y-5">
          {/* Validations en attente */}
          <AnimatePresence initial={false}>
          {session.status === 'waiting' && (
            <motion.div key="waiting" className="rounded-xl border border-waiting/30 bg-waiting/[0.04] p-4 glow-waiting"
              initial={{ opacity: 0, height: 0, marginBottom: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0, paddingTop: 0, paddingBottom: 0 }}
              transition={{ type: 'spring', stiffness: 400, damping: 38 }}>
              <div className="flex items-center gap-2 text-waiting text-[13px] font-medium"><KeyRound size={15} /> {session.waitingFor ?? 'La session attend une réponse'}</div>
              {pending.length > 0 ? (
                <div className="mt-3 space-y-2">
                  <AnimatePresence initial={false}>
                  {pending.map((p) => (
                    <motion.div key={p.requestId} layout className="rounded-lg border border-line bg-panel p-3"
                      initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, scale: 0.98, transition: { duration: 0.15 } }}
                      transition={{ type: 'spring', stiffness: 500, damping: 38 }}>
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-[12.5px] font-medium">{p.toolName}</span>
                        <span className="text-[11px] text-faint">{ago(p.ts, now)}</span>
                      </div>
                      <pre className="mt-2 mono text-[11.5px] text-muted whitespace-pre-wrap break-all max-h-40 overflow-auto">{JSON.stringify(p.input, null, 2)}</pre>
                      <div className="mt-3 flex gap-2 justify-end">
                        <Button size="sm" variant="danger" disabled={busy || !machineReady} onClick={() => respond(p.requestId, p.toolName, p.input, 'deny')}><ShieldX size={13} /> Refuser</Button>
                        <Button size="sm" variant="primary" disabled={busy || !machineReady} onClick={() => respond(p.requestId, p.toolName, p.input, 'allow')}><ShieldCheck size={13} /> Autoriser</Button>
                      </div>
                    </motion.div>
                  ))}
                  </AnimatePresence>
                </div>
              ) : (
                <p className="mt-2 text-[12px] text-muted leading-relaxed">
                  Cette validation doit être faite là où la session s’exécute ({ENTRY_HINT[session.entrypoint ?? ''] ?? 'son interface'}), ou via Remote Control si la session y est connectée.
                  Le cockpit ne contourne pas les demandes d’autorisation de Claude Code.
                </p>
              )}
            </motion.div>
          )}
          </AnimatePresence>

          {/* Envoi d'instructions */}
          <div className="rounded-xl border border-line bg-panel">
            <div className="p-3">
              <textarea
                ref={textarea} value={text} onChange={(e) => setText(e.target.value)} rows={3}
                disabled={!channel || !machineReady}
                onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); void send(); } }}
                placeholder={channel ? 'Instruction à transmettre à la session…' : 'Aucun canal d’instructions supporté pour cette session'}
                className="w-full resize-none bg-transparent outline-none text-[13.5px] leading-relaxed placeholder:text-faint disabled:cursor-not-allowed"
              />
            </div>
            <div className="flex items-center justify-between gap-3 border-t border-line px-3 py-2">
              <p className="text-[11.5px] text-faint flex items-center gap-1.5 min-w-0">
                <Info size={12} className="shrink-0" />
                <span className="truncate">
                  {!machine?.online ? 'Machine hors ligne : aucune commande ne peut être transmise.'
                    : !machine.allowControl ? 'Pilotage désactivé pour cette machine.'
                    : channel === 'sdk' ? 'Transmis via l’Agent SDK (session lancée par le cockpit).'
                    : channel === 'socket' ? 'Déposé dans l’inbox de la session ; Claude Code applique ses contrôles d’entrée.'
                    : 'Session observée uniquement. Redémarrez-la avec les hooks installés pour activer l’envoi.'}
                </span>
              </p>
              <div className="flex items-center gap-2 shrink-0">
                <span className="hidden sm:flex items-center gap-0.5"><Kbd>⌘</Kbd><Kbd>↵</Kbd></span>
                <Button size="sm" variant="primary" onClick={send} disabled={!channel || !machineReady || !text.trim() || busy || !!inflight}>
                  {busy || inflight ? <Spinner /> : <Send size={13} />} Envoyer
                </Button>
              </div>
            </div>
          </div>

          {/* Onglets */}
          <div>
            <div className="flex gap-1 border-b border-line overflow-x-auto">
              {TABS.map((t) => (
                <button key={t.key} onClick={() => setTab(t.key)} className={cx(
                  'relative h-9 px-3 text-[12.5px] whitespace-nowrap transition-colors',
                  tab === t.key ? 'text-fg' : 'text-muted hover:text-fg',
                )}>
                  {t.label}{t.count !== undefined && t.count > 0 && <span className="ml-1.5 text-faint tabular">{t.count}</span>}
                  {tab === t.key && <motion.span layoutId="session-tab" className="absolute inset-x-2 -bottom-px h-[1.5px] rounded-full bg-accent" transition={{ type: 'spring', stiffness: 560, damping: 42 }} />}
                </button>
              ))}
            </div>
            <motion.div key={tab} initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.25, ease: [0.16, 1, 0.3, 1] }} className="rounded-b-xl border border-t-0 border-line bg-panel min-h-[200px]">
              {tab === 'history' && (
                <div className="py-1">
                  {events.length ? <EventList events={events} showSession={false} /> : <Empty title="Aucun événement collecté" />}
                  {events.length > 0 && !exhausted && (
                    <div className="p-3 flex justify-center"><Button size="sm" variant="ghost" onClick={loadMore} disabled={loadingMore}>{loadingMore ? <Spinner /> : 'Charger l’historique plus ancien'}</Button></div>
                  )}
                </div>
              )}
              {tab === 'tools' && (tools.length ? (
                <table className="w-full text-[12.5px]">
                  <thead><tr className="text-left text-[11px] text-faint uppercase tracking-wider"><th className="px-4 py-2 font-medium">Outil</th><th className="px-4 py-2 font-medium text-right">Réussis</th><th className="px-4 py-2 font-medium text-right">Échecs</th><th className="px-4 py-2 font-medium text-right">Dernier</th></tr></thead>
                  <tbody>{tools.map(([name, t]) => (
                    <tr key={name} className="border-t border-line"><td className="px-4 py-2 mono flex items-center gap-2"><Wrench size={12} className="text-faint" />{name}</td><td className="px-4 py-2 text-right tabular">{t.ok}</td><td className={cx('px-4 py-2 text-right tabular', t.fail ? 'text-error' : 'text-faint')}>{t.fail}</td><td className="px-4 py-2 text-right text-faint">{ago(t.last, now)}</td></tr>
                  ))}</tbody>
                </table>
              ) : <Empty title="Aucun outil observé" />)}
              {tab === 'files' && (files.length ? (
                <ul>{files.map((f) => (
                  <li key={f.path} className="flex items-center gap-3 px-4 py-2 border-b border-line last:border-0">
                    <FileCode2 size={13} className="text-faint shrink-0" />
                    <span className="mono text-[12px] truncate flex-1" title={f.path}>{shortPath(f.path, 4)}</span>
                    <Badge>{f.tool}</Badge>
                    <span className="text-[11px] text-faint tabular">×{f.count}</span>
                    <span className="text-[11px] text-faint w-20 text-right">{ago(f.lastTs, now)}</span>
                  </li>
                ))}</ul>
              ) : <Empty title="Aucune modification de fichier observée">Déduites des appels Write / Edit / NotebookEdit remontés par les hooks.</Empty>)}
              {tab === 'agents' && (agents.length ? (
                <ul>{agents.map((a) => (
                  <li key={a.id} className="px-4 py-3 border-b border-line last:border-0">
                    <div className="flex items-center gap-2">
                      <Bot size={14} className={a.status === 'running' && session.status !== 'ended' ? 'text-working' : 'text-faint'} />
                      <span className="text-[12.5px] font-medium">{a.agentType ?? 'sous-agent'}</span>
                      <span className="mono text-[11px] text-faint">{a.id.slice(0, 10)}</span>
                      <span className="ml-auto text-[11px] text-faint">{a.status === 'running' ? (session.status === 'ended' ? 'fin non observée' : 'en cours') : `terminé ${ago(a.endedAt, now)}`}</span>
                    </div>
                    {a.lastMessage && <p className="mt-1.5 text-[12px] text-muted line-clamp-3">{a.lastMessage}</p>}
                  </li>
                ))}</ul>
              ) : <Empty title="Aucun sous-agent observé">Les sous-agents apparaissent via les hooks SubagentStart / SubagentStop.</Empty>)}
              {tab === 'errors' && (errors.length ? <div className="py-1">{errors.map((e) => <EventRow key={e.id} event={e} showSession={false} />)}</div> : <Empty icon={<CircleSlash size={22} />} title="Aucune erreur observée" />)}
              {tab === 'commands' && (commands.length ? (
                <ul>{commands.map((c) => (
                  <li key={c.id} className="px-4 py-2.5 border-b border-line last:border-0">
                    <div className="flex items-center gap-2">
                      <CommandStatusIcon c={c} />
                      <span className="text-[12.5px] font-medium">{COMMAND_LABEL[c.type]}</span>
                      <span className="text-[11.5px] text-muted">{STATUS_LABEL[c.status]}</span>
                      <span className="ml-auto text-[11px] text-faint mono tabular">{clock(c.createdAt)}</span>
                    </div>
                    {c.payload.type === 'session.send' && <p className="mt-1 text-[12px] text-fg/80 line-clamp-2">{c.payload.text}</p>}
                    {c.error && <p className="mt-1 text-[11.5px] text-error">{c.error}</p>}
                    {c.status === 'ok' && c.result != null && typeof c.result === 'object' && 'note' in c.result && <p className="mt-1 text-[11.5px] text-faint">{String((c.result as { note: unknown }).note)}</p>}
                  </li>
                ))}</ul>
              ) : <Empty title="Aucune commande envoyée" />)}
            </motion.div>
          </div>
        </div>

        {/* Colonne latérale */}
        <div className="space-y-5">
          <Panel title="Tâche actuelle" bodyClass="p-4 text-[12.5px] space-y-3">
            <div>
              <div className="text-[11px] text-faint mb-1">Dernière demande observée</div>
              <p className="text-fg/90 leading-relaxed">{session.currentTask ?? <span className="text-faint italic">Non identifiable</span>}</p>
            </div>
            {session.lastTool && <div><div className="text-[11px] text-faint mb-1">Dernier outil</div><p className="mono text-[12px] text-muted break-all">{session.lastTool}</p></div>}
            {session.lastMessage && <div><div className="text-[11px] text-faint mb-1">Dernier message de Claude</div><p className="text-muted leading-relaxed line-clamp-[8] whitespace-pre-wrap">{session.lastMessage}</p></div>}
          </Panel>

          <Panel title="Pilotage disponible" bodyClass="p-4 space-y-2 text-[12.5px]">
            {[
              ['Envoi d’instructions', channel ? (channel === 'sdk' ? 'Agent SDK' : 'Inbox socket') : null],
              ['Interruption', session.control.interrupt ? 'Agent SDK' : null],
              ['Arrêt', session.control.stop ? 'Agent SDK' : null],
              ['Validation des autorisations', session.control.permissions ? 'Relais canUseTool' : null],
            ].map(([label, via]) => (
              <div key={label} className="flex items-center justify-between gap-2">
                <span className="text-muted">{label}</span>
                {via ? <Badge tone="ok">{via}</Badge> : <Badge>Non supporté</Badge>}
              </div>
            ))}
            {!session.control.interrupt && session.status !== 'ended' && (
              <p className="pt-2 text-[11.5px] text-faint leading-relaxed border-t border-line">
                Claude Code n’offre aucun moyen documenté d’interrompre une session interactive depuis l’extérieur. Utilisez son interface, ou Remote Control.
              </p>
            )}
          </Panel>

          <Panel title="Validations" bodyClass="py-1 max-h-72 overflow-auto">
            {approvals.length ? approvals.slice(0, 30).map((e) => <EventRow key={e.id} event={e} showSession={false} compact />) : <Empty title="Aucune demande de validation" />}
          </Panel>

          <Panel title="Statistiques observées" bodyClass="p-4 grid grid-cols-2 gap-3 text-[12px]">
            <div><div className="text-faint text-[11px]">Appels d’outils</div><div className="text-[16px] font-semibold tabular">{session.toolCount}</div></div>
            <div><div className="text-faint text-[11px]">Erreurs</div><div className={cx('text-[16px] font-semibold tabular', session.errorCount > 0 && 'text-error')}>{session.errorCount}</div></div>
            <div><div className="text-faint text-[11px]">Sous-agents</div><div className="text-[16px] font-semibold tabular">{session.agentCount}</div></div>
            <div><div className="text-faint text-[11px]">Démarrée</div><div className="text-[12.5px] mt-1">{ago(session.startedAt, now)}</div></div>
          </Panel>
        </div>
      </div>
    </div>
  );
}

