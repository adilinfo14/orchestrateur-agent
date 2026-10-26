import { memo } from 'react';
import { Link } from 'react-router-dom';
import { Bot, KeyRound, Plug, Sparkles, TerminalSquare, TriangleAlert } from 'lucide-react';
import { ago, cx, PLATFORM_LABEL, shortPath, useNow } from '../lib/format.ts';
import { useLive, type Session } from '../lib/live.ts';
import { Badge, StatusPill } from './ui.tsx';

const ENTRY: Record<string, string> = { 'claude-vscode': 'VS Code', cli: 'Terminal', 'sdk-ts': 'SDK', 'sdk-py': 'SDK', 'claude-desktop': 'Desktop' };

export const SessionCard = memo(function SessionCard({ session: s }: { session: Session }) {
  const now = useNow(10000);
  const machine = useLive((st) => st.machines.get(s.machineId));
  const glow = s.status === 'working' ? 'glow-working' : s.status === 'waiting' ? 'glow-waiting' : s.status === 'error' ? 'glow-error' : '';
  return (
    <Link
      to={`/sessions/${s.id}`}
      className={cx(
        'group relative flex flex-col rounded-xl border border-line bg-panel p-4 transition-[border-color,background,transform] duration-200 hover:border-line-strong hover:bg-raised/60 hover:-translate-y-px animate-slide-up overflow-hidden',
        glow, s.status === 'ended' && 'opacity-60',
      )}
    >
      {s.status === 'working' && <div className="absolute inset-x-0 top-0 h-px shimmer-line" />}
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 min-w-0">
            <h3 className="truncate text-[14px] font-semibold tracking-[-0.01em]">{s.project ?? 'Projet inconnu'}</h3>
            {s.control.send === 'sdk' && <Sparkles size={13} className="text-accent shrink-0" aria-label="Lancée par le cockpit" />}
          </div>
          <p className="truncate text-[11.5px] text-faint mono mt-0.5" title={s.cwd ?? undefined}>{s.name ?? s.id.slice(0, 8)} · {shortPath(s.cwd, 2)}</p>
        </div>
        <StatusPill status={s.status} />
      </div>

      <div className="mt-3 min-h-[38px] text-[12.5px] leading-snug">
        {s.status === 'waiting' && s.waitingFor ? (
          <p className="flex gap-1.5 text-waiting"><KeyRound size={13} className="mt-0.5 shrink-0" /><span className="line-clamp-2">{s.waitingFor}</span></p>
        ) : s.status === 'error' && s.lastError ? (
          <p className="flex gap-1.5 text-error"><TriangleAlert size={13} className="mt-0.5 shrink-0" /><span className="line-clamp-2">{s.lastError}</span></p>
        ) : s.currentTask ? (
          <p className="line-clamp-2 text-fg/90">{s.currentTask}</p>
        ) : (
          <p className="text-faint italic">Tâche non identifiable (aucune demande observée)</p>
        )}
        {s.status === 'working' && s.lastTool && <p className="mt-1 truncate text-[11.5px] text-working/90 mono">{s.lastTool}</p>}
      </div>

      <div className="mt-3 pt-3 border-t border-line flex items-center gap-2 text-[11px] text-muted min-w-0">
        <span className="flex items-center gap-1 truncate">
          <TerminalSquare size={12} className="shrink-0 text-faint" />
          <span className="truncate">{machine?.name ?? 'machine'}{machine?.platform ? ` · ${PLATFORM_LABEL[machine.platform]}` : ''}</span>
        </span>
        {s.entrypoint && <Badge>{ENTRY[s.entrypoint] ?? s.entrypoint}</Badge>}
        {s.agentCount > 0 && (
          <Badge tone={s.activeAgentCount ? 'accent' : 'neutral'} title="Sous-agents observés via SubagentStart">
            <Bot size={11} />{s.activeAgentCount > 0 ? `${s.activeAgentCount}/${s.agentCount}` : s.agentCount}
          </Badge>
        )}
        {s.control.send && <span title={s.control.send === 'sdk' ? 'Pilotable (Agent SDK)' : 'Instructions possibles (inbox socket)'}><Plug size={12} className="text-ok shrink-0" /></span>}
        <span className="ml-auto shrink-0 tabular">{ago(s.lastEventAt, now)}</span>
      </div>
    </Link>
  );
});
