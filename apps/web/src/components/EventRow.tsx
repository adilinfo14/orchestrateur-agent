import { memo } from 'react';
import { Link } from 'react-router-dom';
import type { AccEvent } from '../../../../packages/protocol/src/index.ts';
import { describeEvent, TONE_BG, TONE_TEXT } from '../lib/events.ts';
import { clock, cx, PLATFORM_LABEL } from '../lib/format.ts';
import { useLive } from '../lib/live.ts';

export const EventRow = memo(function EventRow({ event, showSession = true, compact = false }: { event: AccEvent; showSession?: boolean; compact?: boolean }) {
  const look = describeEvent(event);
  const session = useLive((s) => (event.sessionId ? s.sessions.get(event.sessionId) : undefined));
  const machine = useLive((s) => s.machines.get(event.machineId));
  const Icon = look.icon;
  return (
    <div className={cx('group flex items-start gap-3 px-4 transition-colors hover:bg-hover/60', compact ? 'py-1.5' : 'py-2')}>
      <div className={cx('mt-0.5 grid place-items-center rounded-md shrink-0', compact ? 'h-5 w-5' : 'h-6 w-6', TONE_BG[look.tone], TONE_TEXT[look.tone])}>
        <Icon size={compact ? 12 : 13} strokeWidth={2.2} />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2 min-w-0">
          <span className="text-[12.5px] font-medium text-fg shrink-0">{look.label}</span>
          {look.detail && <span className="truncate text-[12px] text-muted mono">{look.detail}</span>}
        </div>
        {showSession && (
          <div className="mt-0.5 flex items-center gap-1.5 text-[11px] text-faint min-w-0">
            {session ? (
              <Link to={`/sessions/${session.id}`} className="truncate hover:text-fg transition-colors">{session.project ?? 'session'}{session.name ? ` · ${session.name}` : ''}</Link>
            ) : event.sessionId ? <span className="mono truncate">{event.sessionId.slice(0, 8)}</span> : <span>machine</span>}
            {machine && <><span>·</span><span className="truncate">{machine.name}{machine.platform ? ` (${PLATFORM_LABEL[machine.platform]})` : ''}</span></>}
            {event.agentId && <><span>·</span><span className="text-accent/80">sous-agent</span></>}
          </div>
        )}
      </div>
      <time className="mono tabular text-[10.5px] text-faint shrink-0 mt-0.5">{clock(event.ts)}</time>
    </div>
  );
});
