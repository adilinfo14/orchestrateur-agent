import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { Activity } from 'lucide-react';
import type { AccEvent } from '../../../../packages/protocol/src/index.ts';
import { api } from '../lib/api.ts';
import { CATEGORY_LABEL, CATEGORY_TYPES, describeEvent, type EventCategory } from '../lib/events.ts';
import { cx, dayLabel, PLATFORM_LABEL } from '../lib/format.ts';
import { useLive } from '../lib/live.ts';
import { EventRow } from '../components/EventRow.tsx';
import { Empty, PageHeader, Spinner } from '../components/ui.tsx';

const CATEGORIES = Object.keys(CATEGORY_LABEL) as EventCategory[];
const PAGE = 150;

export function Timeline() {
  const machines = useLive((s) => s.machines);
  const sessions = useLive((s) => s.sessions);
  const liveEvents = useLive((s) => s.events);

  const [machineId, setMachineId] = useState('');
  const [project, setProject] = useState('');
  const [sessionId, setSessionId] = useState('');
  const [cats, setCats] = useState<Set<EventCategory>>(new Set());
  const [loaded, setLoaded] = useState<AccEvent[]>([]);
  const [loading, setLoading] = useState(false);
  const [exhausted, setExhausted] = useState(false);
  const since = useRef(Date.now());

  const projects = useMemo(() => [...new Set([...sessions.values()].map((s) => s.project).filter(Boolean) as string[])].sort(), [sessions]);
  const sessionOptions = useMemo(() => [...sessions.values()]
    .filter((s) => (!machineId || s.machineId === machineId) && (!project || s.project === project))
    .sort((a, b) => b.lastEventAt - a.lastEventAt), [sessions, machineId, project]);

  const types = useMemo(() => [...new Set([...cats].flatMap((c) => CATEGORY_TYPES[c]))], [cats]);

  const query = useCallback((before?: AccEvent) => {
    const p = new URLSearchParams({ limit: String(PAGE) });
    if (machineId) p.set('machineId', machineId);
    if (project) p.set('project', project);
    if (sessionId) p.set('sessionId', sessionId);
    if (types.length) p.set('types', types.join(','));
    if (before) p.set('before', `${before.ts}:${before.id}`);
    return api<AccEvent[]>(`/api/events?${p}`);
  }, [machineId, project, sessionId, types]);

  // Rechargement complet à chaque changement de filtre.
  useEffect(() => {
    let cancel = false;
    setLoading(true);
    setExhausted(false);
    since.current = Date.now();
    query().then((page) => { if (!cancel) { setLoaded(page); setExhausted(page.length < PAGE); } }).finally(() => !cancel && setLoading(false));
    return () => { cancel = true; };
  }, [query]);

  const matches = useCallback((e: AccEvent) => {
    if (machineId && e.machineId !== machineId) return false;
    if (sessionId && e.sessionId !== sessionId) return false;
    if (project && (!e.sessionId || sessions.get(e.sessionId)?.project !== project)) return false;
    if (cats.size && !cats.has(describeEvent(e).category) && !types.includes(e.type)) return false;
    return true;
  }, [machineId, sessionId, project, cats, types, sessions]);

  const events = useMemo(() => {
    const map = new Map<string, AccEvent>();
    for (const e of loaded) map.set(e.id, e);
    for (const e of liveEvents) if (e.ts >= since.current - 60_000 && matches(e)) map.set(e.id, e);
    return [...map.values()].sort((a, b) => b.ts - a.ts || (a.id < b.id ? 1 : -1));
  }, [loaded, liveEvents, matches]);

  const loadMore = useCallback(async () => {
    if (loading || exhausted) return;
    const last = loaded[loaded.length - 1];
    if (!last) return;
    setLoading(true);
    try {
      const page = await query(last);
      setLoaded((l) => [...l, ...page]);
      if (page.length < PAGE) setExhausted(true);
    } finally { setLoading(false); }
  }, [loading, exhausted, loaded, query]);

  const parent = useRef<HTMLDivElement>(null);
  const virt = useVirtualizer({ count: events.length, getScrollElement: () => parent.current, estimateSize: () => 56, overscan: 12 });
  const items = virt.getVirtualItems();
  useEffect(() => {
    const last = items[items.length - 1];
    if (last && last.index >= events.length - 20) void loadMore();
  }, [items, events.length, loadMore]);

  const toggle = (c: EventCategory) => setCats((s) => { const n = new Set(s); if (n.has(c)) n.delete(c); else n.add(c); return n; });
  const select = 'h-8 rounded-md border border-line bg-panel px-2 text-[12px] text-muted outline-none focus:border-line-strong max-w-[200px]';

  return (
    <div className="h-full flex flex-col p-4 md:p-6 max-w-[1200px] mx-auto">
      <PageHeader title="Chronologie" subtitle="Tous les événements collectés, du plus récent au plus ancien" />
      <div className="flex flex-wrap gap-2 mb-3">
        <select className={select} value={machineId} onChange={(e) => { setMachineId(e.target.value); setSessionId(''); }}>
          <option value="">Toutes les machines</option>
          {[...machines.values()].map((m) => <option key={m.id} value={m.id}>{m.name}{m.platform ? ` (${PLATFORM_LABEL[m.platform]})` : ''}</option>)}
        </select>
        <select className={select} value={project} onChange={(e) => { setProject(e.target.value); setSessionId(''); }}>
          <option value="">Tous les projets</option>
          {projects.map((p) => <option key={p} value={p}>{p}</option>)}
        </select>
        <select className={select} value={sessionId} onChange={(e) => setSessionId(e.target.value)}>
          <option value="">Toutes les sessions</option>
          {sessionOptions.map((s) => <option key={s.id} value={s.id}>{s.project ?? '?'} · {s.name ?? s.id.slice(0, 8)}</option>)}
        </select>
      </div>
      <div className="flex flex-wrap gap-1.5 mb-4">
        {CATEGORIES.map((c) => (
          <button key={c} onClick={() => toggle(c)} className={cx(
            'h-7 px-2.5 rounded-full text-[11.5px] border transition-colors',
            cats.has(c) ? 'border-accent/40 bg-accent/10 text-accent' : 'border-line text-muted hover:text-fg hover:border-line-strong',
          )}>{CATEGORY_LABEL[c]}</button>
        ))}
        {cats.size > 0 && <button onClick={() => setCats(new Set())} className="h-7 px-2 text-[11.5px] text-faint hover:text-fg">Réinitialiser</button>}
      </div>

      <div ref={parent} className="flex-1 min-h-[300px] overflow-auto rounded-xl border border-line bg-panel">
        {events.length === 0 && !loading ? (
          <Empty icon={<Activity size={24} />} title="Aucun événement pour ces filtres" />
        ) : (
          <div style={{ height: virt.getTotalSize(), position: 'relative' }}>
            {items.map((vi) => {
              const e = events[vi.index]!;
              const prev = events[vi.index - 1];
              const newDay = !prev || new Date(prev.ts).toDateString() !== new Date(e.ts).toDateString();
              return (
                <div key={e.id} data-index={vi.index} ref={virt.measureElement} style={{ position: 'absolute', top: 0, left: 0, right: 0, transform: `translateY(${vi.start}px)` }}>
                  {newDay && <div className="sticky top-0 z-10 px-4 pt-3 pb-1.5 text-[11px] font-medium uppercase tracking-wider text-faint bg-panel/95 backdrop-blur border-b border-line">{dayLabel(e.ts)}</div>}
                  <EventRow event={e} />
                </div>
              );
            })}
          </div>
        )}
        {loading && <div className="py-4 flex justify-center text-faint"><Spinner /></div>}
        {exhausted && events.length > 0 && <div className="py-4 text-center text-[11px] text-faint">Début de l’historique conservé</div>}
      </div>
    </div>
  );
}
