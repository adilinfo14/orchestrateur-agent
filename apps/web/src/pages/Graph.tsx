import { memo, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Background, BackgroundVariant, Controls, Handle, MiniMap, Position, ReactFlow, ReactFlowProvider, type Edge, type Node, type NodeProps } from '@xyflow/react';
import { Bot, ExternalLink, KeyRound, Search, Sparkles, X } from 'lucide-react';
import type { AgentView, MachineView } from '../../../../packages/protocol/src/index.ts';
import { ago, cx, PLATFORM_LABEL, STATUS, useNow } from '../lib/format.ts';
import { useLive, type Session } from '../lib/live.ts';
import { Badge, Empty, StatusDot, StatusPill } from '../components/ui.tsx';

type GroupBy = 'machine' | 'project';

type SessionData = { session: Session; machine?: MachineView; dim: boolean };
type AgentData = { agent: AgentView; parentEnded: boolean; dim: boolean };
type GroupData = { label: string; sub: string; online?: boolean };

const SessionNode = memo(function SessionNode({ data, selected }: NodeProps<Node<SessionData>>) {
  const s = data.session;
  const glow = s.status === 'working' ? 'glow-working' : s.status === 'waiting' ? 'glow-waiting' : s.status === 'error' ? 'glow-error' : '';
  return (
    <div className={cx(
      'w-[230px] rounded-xl border bg-panel px-3.5 py-3 transition-[opacity,border-color] duration-300',
      selected ? 'border-accent' : 'border-line-strong', glow, data.dim && 'opacity-25', s.status === 'ended' && 'opacity-50',
    )}>
      <Handle type="source" position={Position.Bottom} className="!opacity-0" />
      <Handle type="target" position={Position.Top} className="!opacity-0" />
      <div className="flex items-center gap-2">
        <StatusDot status={s.status} />
        <span className="truncate text-[13px] font-semibold">{s.project ?? 'projet'}</span>
        {s.control.send === 'sdk' && <Sparkles size={12} className="text-accent shrink-0" />}
      </div>
      <div className="mt-1 truncate text-[11px] text-faint mono">{s.name ?? s.id.slice(0, 8)}</div>
      <div className="mt-2 truncate text-[11.5px] text-muted">
        {s.status === 'waiting' ? <span className="text-waiting flex items-center gap-1"><KeyRound size={11} />{s.waitingFor ?? 'en attente'}</span>
          : s.status === 'working' && s.lastTool ? <span className="text-working mono">{s.lastTool}</span>
          : STATUS[s.status].label}
      </div>
    </div>
  );
});

const AgentNode = memo(function AgentNode({ data, selected }: NodeProps<Node<AgentData>>) {
  const a = data.agent;
  const running = a.status === 'running' && !data.parentEnded;
  return (
    <div className={cx(
      'flex items-center gap-1.5 rounded-full border bg-raised pl-2 pr-2.5 h-7 text-[11px] whitespace-nowrap transition-opacity duration-300',
      selected ? 'border-accent' : running ? 'border-working/50 glow-working' : 'border-line', data.dim && 'opacity-25',
    )}>
      <Handle type="target" position={Position.Top} className="!opacity-0" />
      <Bot size={12} className={running ? 'text-working' : 'text-faint'} />
      <span className={running ? 'text-fg' : 'text-muted'}>{a.agentType ?? 'sous-agent'}</span>
    </div>
  );
});

const GroupNode = memo(function GroupNode({ data }: NodeProps<Node<GroupData>>) {
  return (
    <div className="h-full w-full rounded-2xl border border-dashed border-line-strong/70 bg-panel/20">
      <div className="flex items-center gap-2 px-4 pt-3">
        {data.online !== undefined && <span className={cx('h-1.5 w-1.5 rounded-full', data.online ? 'bg-ok' : 'bg-error')} />}
        <span className="text-[12px] font-medium text-muted">{data.label}</span>
        <span className="text-[11px] text-faint">{data.sub}</span>
      </div>
    </div>
  );
});

const nodeTypes = { session: SessionNode, agent: AgentNode, group: GroupNode };

const CELL_W = 330, CELL_H = 250, COLS = 3, PAD = 40, HEADER = 36;

function layout(sessions: Session[], agents: AgentView[], machines: Map<string, MachineView>, groupBy: GroupBy, match: (s: Session) => boolean, showDone: boolean) {
  const groups = new Map<string, Session[]>();
  for (const s of sessions) {
    const k = groupBy === 'machine' ? s.machineId : s.project ?? '—';
    groups.set(k, [...(groups.get(k) ?? []), s]);
  }
  const agentsBySession = new Map<string, AgentView[]>();
  for (const a of agents) {
    if (!showDone && a.status === 'done') continue;
    agentsBySession.set(a.sessionId, [...(agentsBySession.get(a.sessionId) ?? []), a]);
  }

  const nodes: Node[] = [];
  const edges: Edge[] = [];
  let x = 0;
  const keys = [...groups.keys()].sort();
  for (const k of keys) {
    const list = groups.get(k)!.sort((a, b) => (a.project ?? '').localeCompare(b.project ?? '') || b.lastEventAt - a.lastEventAt);
    const cols = Math.min(COLS, list.length);
    const rows = Math.ceil(list.length / cols);
    const w = cols * CELL_W + PAD * 2, h = rows * CELL_H + PAD * 2 + HEADER;
    const m = machines.get(k);
    const gid = `g:${k}`;
    nodes.push({
      id: gid, type: 'group', position: { x, y: 0 }, style: { width: w, height: h }, selectable: false, draggable: false,
      data: groupBy === 'machine'
        ? { label: m?.name ?? 'machine', sub: m?.platform ? PLATFORM_LABEL[m.platform] : '', online: m?.online ?? false }
        : { label: k, sub: `${list.length} session${list.length > 1 ? 's' : ''}` },
    });
    list.forEach((s, i) => {
      const cx0 = PAD + (i % cols) * CELL_W + CELL_W / 2;
      const cy0 = PAD + HEADER + Math.floor(i / cols) * CELL_H + 50;
      const dim = !match(s);
      nodes.push({ id: s.id, type: 'session', parentId: gid, extent: 'parent', position: { x: cx0 - 115, y: cy0 - 40 }, data: { session: s, machine: machines.get(s.machineId), dim } });
      const kids = (agentsBySession.get(s.id) ?? []).sort((a, b) => a.startedAt - b.startedAt).slice(-8);
      // Sous-agents disposés en arc sous la session parente.
      kids.forEach((a, j) => {
        const n = kids.length;
        const angle = n === 1 ? Math.PI / 2 : Math.PI * (0.15 + (0.7 * j) / (n - 1));
        const r = 105;
        const id = `${s.id}/${a.id}`;
        nodes.push({ id, type: 'agent', parentId: gid, extent: 'parent', position: { x: cx0 + Math.cos(angle) * r * 1.25 - 55, y: cy0 + 40 + Math.sin(angle) * r * 0.75 }, data: { agent: a, parentEnded: s.status === 'ended', dim } });
        const running = a.status === 'running' && s.status !== 'ended';
        edges.push({ id: `e:${id}`, source: s.id, target: id, animated: running, style: { stroke: running ? 'var(--color-working)' : '#2f343c', strokeWidth: running ? 1.5 : 1, opacity: dim ? 0.2 : 1 } });
      });
    });
    x += w + 60;
  }
  return { nodes, edges };
}

function Inspector({ id, onClose }: { id: string; onClose: () => void }) {
  const now = useNow(5000);
  const [sid, aid] = id.split('/') as [string, string | undefined];
  const s = useLive((st) => st.sessions.get(sid));
  const a = useLive((st) => (aid ? st.agents.get(`${sid}/${aid}`) : undefined));
  const machine = useLive((st) => (s ? st.machines.get(s.machineId) : undefined));
  if (!s) return null;
  return (
    <div className="absolute right-3 top-3 bottom-3 w-[320px] max-w-[calc(100%-24px)] rounded-xl border border-line-strong bg-panel/95 backdrop-blur shadow-2xl shadow-black/50 flex flex-col animate-slide-up z-10">
      <div className="flex items-center justify-between px-4 h-11 border-b border-line">
        <span className="text-[12px] font-medium text-muted">{a ? 'Sous-agent' : 'Session'}</span>
        <button onClick={onClose} className="p-1 rounded text-faint hover:text-fg hover:bg-hover"><X size={14} /></button>
      </div>
      <div className="p-4 space-y-3 overflow-auto text-[12.5px]">
        {a ? (
          <>
            <div className="flex items-center gap-2"><Bot size={15} className="text-working" /><span className="font-semibold">{a.agentType ?? 'sous-agent'}</span></div>
            <p className="mono text-[11px] text-faint break-all">{a.id}</p>
            <p className="text-muted">{a.status === 'running' ? (s.status === 'ended' ? 'Fin non observée (session terminée)' : `En cours depuis ${ago(a.startedAt, now).replace('il y a ', '')}`) : `Terminé ${ago(a.endedAt, now)}`}</p>
            {a.lastMessage && <p className="text-muted whitespace-pre-wrap leading-relaxed">{a.lastMessage}</p>}
            <p className="text-[11.5px] text-faint">Session parente : {s.project} · {s.name ?? s.id.slice(0, 8)}</p>
          </>
        ) : (
          <>
            <div className="flex items-center justify-between gap-2"><span className="font-semibold text-[14px] truncate">{s.project}</span><StatusPill status={s.status} /></div>
            <p className="mono text-[11px] text-faint break-all">{s.cwd}</p>
            <div className="flex flex-wrap gap-1.5"><Badge>{machine?.name}</Badge>{s.control.send && <Badge tone="ok">pilotable</Badge>}{s.agentCount > 0 && <Badge tone="accent">{s.agentCount} sous-agent(s)</Badge>}</div>
            {s.currentTask && <div><div className="text-[11px] text-faint mb-1">Tâche</div><p className="leading-relaxed">{s.currentTask}</p></div>}
            {s.lastMessage && <div><div className="text-[11px] text-faint mb-1">Dernier message</div><p className="text-muted line-clamp-6 whitespace-pre-wrap">{s.lastMessage}</p></div>}
            <p className="text-[11px] text-faint">Dernière activité {ago(s.lastEventAt, now)}</p>
          </>
        )}
      </div>
      <div className="mt-auto p-3 border-t border-line">
        <Link to={`/sessions/${s.id}`} className="flex items-center justify-center gap-1.5 h-8 rounded-md bg-fg text-bg text-[12.5px] font-medium hover:bg-white">Ouvrir la session <ExternalLink size={13} /></Link>
      </div>
    </div>
  );
}

function GraphInner() {
  const sessions = useLive((s) => s.sessions);
  const agents = useLive((s) => s.agents);
  const machines = useLive((s) => s.machines);
  const [groupBy, setGroupBy] = useState<GroupBy>('machine');
  const [q, setQ] = useState('');
  const [showEnded, setShowEnded] = useState(false);
  const [showDone, setShowDone] = useState(true);
  const [selected, setSelected] = useState<string | null>(null);

  const visible = useMemo(() => [...sessions.values()].filter((s) => showEnded || s.status !== 'ended'), [sessions, showEnded]);
  const needle = q.trim().toLowerCase();
  const match = useMemo(() => (s: Session) => !needle || `${s.project} ${s.name} ${s.cwd} ${s.currentTask}`.toLowerCase().includes(needle), [needle]);
  const { nodes, edges } = useMemo(() => layout(visible, [...agents.values()], machines, groupBy, match, showDone), [visible, agents, machines, groupBy, match, showDone]);

  return (
    <div className="h-full flex flex-col">
      <div className="flex flex-wrap items-center gap-2 px-4 md:px-6 py-3 border-b border-line">
        <h1 className="text-[15px] font-semibold mr-2">Graphe des agents</h1>
        <div className="flex rounded-md border border-line p-0.5">
          {(['machine', 'project'] as const).map((g) => (
            <button key={g} onClick={() => setGroupBy(g)} className={cx('h-6 px-2.5 rounded text-[11.5px] transition-colors', groupBy === g ? 'bg-hover text-fg' : 'text-muted hover:text-fg')}>
              {g === 'machine' ? 'Par machine' : 'Par projet'}
            </button>
          ))}
        </div>
        <label className="flex items-center gap-1.5 h-8 rounded-md border border-line bg-panel px-2.5 text-faint focus-within:border-line-strong">
          <Search size={13} />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filtrer…" className="bg-transparent outline-none text-[12px] text-fg w-36 placeholder:text-faint" />
        </label>
        <label className="flex items-center gap-1.5 text-[12px] text-muted cursor-pointer"><input type="checkbox" checked={showEnded} onChange={(e) => setShowEnded(e.target.checked)} className="accent-[var(--color-accent)]" />Sessions terminées</label>
        <label className="flex items-center gap-1.5 text-[12px] text-muted cursor-pointer"><input type="checkbox" checked={showDone} onChange={(e) => setShowDone(e.target.checked)} className="accent-[var(--color-accent)]" />Sous-agents terminés</label>
        <span className="ml-auto text-[11px] text-faint hidden lg:block">Seules les relations observées (SubagentStart) sont tracées</span>
      </div>
      <div className="relative flex-1 min-h-0 bg-grid">
        {visible.length === 0 ? (
          <Empty title="Aucune session à afficher">Les sessions détectées par les collecteurs apparaîtront ici.</Empty>
        ) : (
          <ReactFlow
            nodes={nodes} edges={edges} nodeTypes={nodeTypes} fitView fitViewOptions={{ padding: 0.15, maxZoom: 1.1 }} minZoom={0.15} maxZoom={2}
            nodesConnectable={false} nodesDraggable={false} onlyRenderVisibleElements proOptions={{ hideAttribution: true }}
            onNodeClick={(_, n) => n.type !== 'group' && setSelected(n.id)} onPaneClick={() => setSelected(null)}
          >
            <Background variant={BackgroundVariant.Dots} gap={22} size={1} color="#ffffff10" />
            <Controls showInteractive={false} position="bottom-left" />
            <MiniMap pannable zoomable nodeColor={(n) => (n.type === 'session' ? '#3a3f47' : n.type === 'agent' ? '#2a2e35' : 'transparent')} maskColor="#08090bcc" className="!hidden md:!block" />
          </ReactFlow>
        )}
        {selected && <Inspector id={selected} onClose={() => setSelected(null)} />}
      </div>
    </div>
  );
}

export default function Graph() {
  return <ReactFlowProvider><GraphInner /></ReactFlowProvider>;
}
