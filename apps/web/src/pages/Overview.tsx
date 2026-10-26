import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Activity, AlertOctagon, Hourglass, Layers, Radio, Server } from 'lucide-react';
import type { SessionStatus } from '../../../../packages/protocol/src/index.ts';
import { cx, PLATFORM_LABEL } from '../lib/format.ts';
import { useLive, type Session } from '../lib/live.ts';
import { SessionCard } from '../components/SessionCard.tsx';
import { EventRow } from '../components/EventRow.tsx';
import { Empty, PageHeader, Panel, Spinner } from '../components/ui.tsx';

const ORDER: Record<SessionStatus, number> = { waiting: 0, error: 1, working: 2, idle: 3, unknown: 4, ended: 5 };

type Filter = 'live' | 'all' | SessionStatus;
const FILTERS: { key: Filter; label: string }[] = [
  { key: 'live', label: 'En cours' }, { key: 'working', label: 'Actives' }, { key: 'waiting', label: 'En attente' },
  { key: 'error', label: 'Erreur' }, { key: 'idle', label: 'Inactives' }, { key: 'ended', label: 'Terminées' }, { key: 'all', label: 'Toutes' },
];

function Stat({ icon: Icon, label, value, sub, tone }: { icon: typeof Server; label: string; value: number | string; sub?: string; tone?: string }) {
  return (
    <div className="rounded-xl border border-line bg-panel px-4 py-3.5 animate-slide-up">
      <div className="flex items-center gap-1.5 text-[11.5px] text-muted"><Icon size={13} className={tone ?? 'text-faint'} />{label}</div>
      <div className={cx('mt-1.5 text-[24px] font-semibold tracking-[-0.02em] tabular leading-none', tone)}>{value}</div>
      {sub && <div className="mt-1.5 text-[11px] text-faint truncate">{sub}</div>}
    </div>
  );
}

export function Overview() {
  const loaded = useLive((s) => s.loaded);
  const machines = useLive((s) => s.machines);
  const sessions = useLive((s) => s.sessions);
  const events = useLive((s) => s.events);
  const [filter, setFilter] = useState<Filter>('live');
  const [machineFilter, setMachineFilter] = useState<string | null>(null);

  const all = useMemo(() => [...sessions.values()], [sessions]);
  const counts = useMemo(() => {
    const c = { working: 0, waiting: 0, error: 0, idle: 0, ended: 0, unknown: 0 } as Record<SessionStatus, number>;
    for (const s of all) c[s.status]++;
    return c;
  }, [all]);
  const online = [...machines.values()].filter((m) => m.online);

  const list = useMemo(() => {
    let l: Session[] = all;
    if (machineFilter) l = l.filter((s) => s.machineId === machineFilter);
    if (filter === 'live') l = l.filter((s) => s.status !== 'ended');
    else if (filter !== 'all') l = l.filter((s) => s.status === filter);
    return l.sort((a, b) => ORDER[a.status] - ORDER[b.status] || b.lastEventAt - a.lastEventAt);
  }, [all, filter, machineFilter]);

  if (!loaded) return <div className="h-full grid place-items-center text-faint"><Spinner /></div>;

  return (
    <div className="p-4 md:p-6 max-w-[1600px] mx-auto">
      <PageHeader
        title="Vue d’ensemble"
        subtitle={`${online.length} machine${online.length > 1 ? 's' : ''} connectée${online.length > 1 ? 's' : ''} · données collectées en temps réel`}
      />

      <div className="grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-6 gap-3 mb-6">
        <Stat icon={Server} label="Machines connectées" value={`${online.length}/${machines.size}`} sub={online.map((m) => m.name).join(', ') || 'aucune'} />
        <Stat icon={Layers} label="Sessions détectées" value={all.length - counts.ended} sub={`${counts.ended} terminée${counts.ended > 1 ? 's' : ''} (7 j)`} />
        <Stat icon={Activity} label="Actives" value={counts.working} tone={counts.working ? 'text-working' : undefined} />
        <Stat icon={Hourglass} label="En attente" value={counts.waiting} tone={counts.waiting ? 'text-waiting' : undefined} sub="validation ou dialogue" />
        <Stat icon={AlertOctagon} label="En erreur" value={counts.error} tone={counts.error ? 'text-error' : undefined} />
        <Stat icon={Radio} label="Inactives" value={counts.idle + counts.unknown} sub={counts.unknown ? `${counts.unknown} statut inconnu` : undefined} />
      </div>

      {machines.size === 0 ? (
        <Panel>
          <Empty icon={<Server size={28} />} title="Aucune machine inscrite">
            Inscrivez un collecteur depuis la page <Link to="/machines" className="text-accent hover:underline">Machines</Link>. Le cockpit n’affiche que des données réellement collectées : il restera vide tant qu’aucun collecteur n’est connecté.
          </Empty>
        </Panel>
      ) : (
        <div className="grid grid-cols-1 xl:grid-cols-[1fr_380px] gap-6">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-1.5 mb-3">
              {FILTERS.map((f) => {
                const n = f.key === 'all' ? all.length : f.key === 'live' ? all.length - counts.ended : counts[f.key];
                return (
                  <button key={f.key} onClick={() => setFilter(f.key)} className={cx(
                    'h-7 px-2.5 rounded-md text-[12px] border transition-colors flex items-center gap-1.5',
                    filter === f.key ? 'bg-hover border-line-strong text-fg' : 'border-transparent text-muted hover:text-fg',
                  )}>
                    {f.label}<span className="text-faint tabular">{n}</span>
                  </button>
                );
              })}
              {machines.size > 1 && (
                <select
                  value={machineFilter ?? ''} onChange={(e) => setMachineFilter(e.target.value || null)}
                  className="ml-auto h-7 rounded-md border border-line bg-panel px-2 text-[12px] text-muted outline-none"
                >
                  <option value="">Toutes les machines</option>
                  {[...machines.values()].map((m) => <option key={m.id} value={m.id}>{m.name}{m.platform ? ` (${PLATFORM_LABEL[m.platform]})` : ''}</option>)}
                </select>
              )}
            </div>
            {list.length ? (
              <div className="grid grid-cols-1 lg:grid-cols-2 2xl:grid-cols-3 gap-3">
                {list.map((s) => <SessionCard key={s.id} session={s} />)}
              </div>
            ) : (
              <Panel>
                <Empty icon={<Layers size={26} />} title="Aucune session dans ce filtre">
                  Les sessions apparaissent dès qu’un hook est reçu, ou dès que le collecteur détecte un processus Claude Code en cours.
                </Empty>
              </Panel>
            )}
          </div>

          <Panel title="Activité récente" actions={<Link to="/timeline" className="text-[11.5px] text-muted hover:text-fg">Tout voir →</Link>} className="xl:sticky xl:top-6 self-start" bodyClass="max-h-[70vh] overflow-auto py-1">
            {events.length ? events.slice(0, 40).map((e) => <EventRow key={e.id} event={e} compact />) : (
              <Empty title="Aucun événement">Les événements arrivent dès qu’une session Claude Code instrumentée travaille.</Empty>
            )}
          </Panel>
        </div>
      )}
    </div>
  );
}
