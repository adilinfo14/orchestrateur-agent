import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { NavLink, useNavigate } from 'react-router-dom';
import { Activity, CornerDownLeft, LayoutGrid, LogOut, Network, ScrollText, Search, Server, Workflow } from 'lucide-react';
import { api } from '../lib/api.ts';
import { cx, STATUS } from '../lib/format.ts';
import { useLive } from '../lib/live.ts';
import { Kbd, StatusDot } from './ui.tsx';

const NAV = [
  { to: '/', label: 'Vue d’ensemble', icon: LayoutGrid, end: true },
  { to: '/graph', label: 'Graphe des agents', icon: Network },
  { to: '/timeline', label: 'Chronologie', icon: Activity },
  { to: '/orchestrate', label: 'Orchestration', icon: Workflow },
  { to: '/machines', label: 'Machines', icon: Server },
  { to: '/audit', label: 'Journal d’audit', icon: ScrollText },
];

function ConnectionBadge() {
  const status = useLive((s) => s.status);
  const label = status === 'live' ? 'Temps réel' : status === 'connecting' ? 'Connexion…' : 'Hors ligne';
  const color = status === 'live' ? 'bg-ok' : status === 'connecting' ? 'bg-waiting' : 'bg-error';
  return (
    <span className="flex items-center gap-1.5 text-[11px] text-muted" title="État du flux temps réel avec le serveur">
      <span className={cx('h-1.5 w-1.5 rounded-full', color, status !== 'live' && 'animate-pulse')} />
      {label}
    </span>
  );
}

function Palette({ onClose }: { onClose: () => void }) {
  const sessions = useLive((s) => s.sessions);
  const machines = useLive((s) => s.machines);
  const navigate = useNavigate();
  const [q, setQ] = useState('');
  const [idx, setIdx] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => input.current?.focus(), []);

  const items = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const pages = NAV.map((n) => ({ key: n.to, label: n.label, hint: 'Page', to: n.to, status: null as null | keyof typeof STATUS }));
    const sess = [...sessions.values()]
      .sort((a, b) => b.lastEventAt - a.lastEventAt)
      .map((s) => ({
        key: s.id, label: `${s.project ?? 'session'}${s.name ? ' · ' + s.name : ''}`, hint: machines.get(s.machineId)?.name ?? '',
        to: `/sessions/${s.id}`, status: s.status, hay: `${s.project} ${s.name} ${s.cwd} ${s.currentTask} ${s.id}`.toLowerCase(),
      }));
    const all = [...pages.map((p) => ({ ...p, hay: p.label.toLowerCase() })), ...sess];
    return (needle ? all.filter((i) => i.hay.includes(needle)) : all).slice(0, 12);
  }, [q, sessions, machines]);

  const go = (to: string) => { navigate(to); onClose(); };

  return (
    <div className="fixed inset-0 z-50 bg-black/55 backdrop-blur-[2px] flex items-start justify-center pt-[12vh] px-4 animate-fade-in" onMouseDown={onClose}>
      <div className="w-full max-w-xl rounded-xl border border-line-strong bg-panel shadow-2xl shadow-black/60 overflow-hidden animate-slide-up" onMouseDown={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-2.5 px-4 h-12 border-b border-line">
          <Search size={15} className="text-faint" />
          <input
            ref={input} value={q} placeholder="Aller à une session, un projet, une page…"
            onChange={(e) => { setQ(e.target.value); setIdx(0); }}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') { e.preventDefault(); setIdx((i) => Math.min(i + 1, items.length - 1)); }
              if (e.key === 'ArrowUp') { e.preventDefault(); setIdx((i) => Math.max(i - 1, 0)); }
              if (e.key === 'Enter' && items[idx]) go(items[idx].to);
              if (e.key === 'Escape') onClose();
            }}
            className="flex-1 bg-transparent outline-none text-[14px] placeholder:text-faint"
          />
          <Kbd>esc</Kbd>
        </div>
        <ul className="max-h-[50vh] overflow-auto py-1.5">
          {items.map((it, i) => (
            <li key={it.key}>
              <button
                onMouseEnter={() => setIdx(i)} onClick={() => go(it.to)}
                className={cx('w-full flex items-center gap-3 px-4 h-9 text-left text-[13px]', i === idx ? 'bg-hover text-fg' : 'text-muted')}
              >
                {it.status ? <StatusDot status={it.status} size={7} /> : <span className="w-[7px]" />}
                <span className="truncate flex-1">{it.label}</span>
                <span className="text-[11px] text-faint">{it.hint}</span>
                {i === idx && <CornerDownLeft size={12} className="text-faint" />}
              </button>
            </li>
          ))}
          {!items.length && <li className="px-4 py-6 text-center text-[12.5px] text-faint">Aucun résultat</li>}
        </ul>
      </div>
    </div>
  );
}

export function Shell({ children, user }: { children: ReactNode; user: string }) {
  const [palette, setPalette] = useState(false);
  const waiting = useLive((s) => [...s.sessions.values()].filter((x) => x.status === 'waiting').length);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setPalette((p) => !p); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => { document.title = waiting ? `(${waiting}) Agent Command Center` : 'Agent Command Center'; }, [waiting]);

  const logout = async () => { await api('/api/logout', { method: 'POST' }).catch(() => {}); location.href = '/'; };

  return (
    <div className="h-full flex">
      <aside className="hidden md:flex w-[220px] shrink-0 flex-col border-r border-line bg-panel/60">
        <div className="flex items-center gap-2.5 px-4 h-14">
          <img src="/icon.svg" alt="" className="h-6 w-6" />
          <div className="leading-tight">
            <div className="text-[13px] font-semibold tracking-[-0.01em]">Command Center</div>
            <div className="text-[10.5px] text-faint">Claude Code · multi-machines</div>
          </div>
        </div>
        <button onClick={() => setPalette(true)} className="mx-3 mb-3 flex items-center gap-2 rounded-md border border-line bg-raised/60 px-2.5 h-8 text-[12px] text-faint hover:text-muted hover:border-line-strong transition-colors">
          <Search size={13} /> Rechercher <span className="ml-auto flex gap-0.5"><Kbd>⌘</Kbd><Kbd>K</Kbd></span>
        </button>
        <nav className="flex-1 px-2 space-y-px">
          {NAV.map(({ to, label, icon: Icon, end }) => (
            <NavLink key={to} to={to} end={end} className={({ isActive }) => cx(
              'flex items-center gap-2.5 rounded-md px-2.5 h-8 text-[13px] transition-colors',
              isActive ? 'bg-hover text-fg' : 'text-muted hover:text-fg hover:bg-hover/60',
            )}>
              <Icon size={15} strokeWidth={1.8} />
              <span className="flex-1">{label}</span>
              {to === '/' && waiting > 0 && <span className="rounded-full bg-waiting/15 text-waiting text-[10.5px] font-semibold px-1.5 tabular">{waiting}</span>}
            </NavLink>
          ))}
        </nav>
        <div className="border-t border-line p-3 flex items-center justify-between">
          <div className="min-w-0">
            <div className="text-[12px] truncate">{user}</div>
            <ConnectionBadge />
          </div>
          <button onClick={logout} className="p-1.5 rounded-md text-faint hover:text-fg hover:bg-hover" title="Se déconnecter"><LogOut size={14} /></button>
        </div>
      </aside>

      <div className="flex-1 min-w-0 flex flex-col">
        <header className="md:hidden safe-top flex items-center justify-between px-4 h-12 border-b border-line bg-panel/80 backdrop-blur sticky top-0 z-30">
          <div className="flex items-center gap-2"><img src="/icon.svg" alt="" className="h-5 w-5" /><span className="text-[13px] font-semibold">Command Center</span></div>
          <div className="flex items-center gap-3">
            <ConnectionBadge />
            <button onClick={() => setPalette(true)} className="p-1.5 text-muted" aria-label="Rechercher"><Search size={16} /></button>
          </div>
        </header>
        <main className="flex-1 min-h-0 overflow-auto">{children}</main>
        <nav className="md:hidden safe-bottom border-t border-line bg-panel/90 backdrop-blur grid grid-cols-5">
          {NAV.slice(0, 5).map(({ to, label, icon: Icon, end }) => (
            <NavLink key={to} to={to} end={end} className={({ isActive }) => cx('relative flex flex-col items-center gap-0.5 py-2 text-[10px]', isActive ? 'text-fg' : 'text-faint')}>
              <Icon size={18} strokeWidth={1.8} />
              <span className="truncate max-w-full px-1">{label.split(' ')[0]}</span>
              {to === '/' && waiting > 0 && <span className="absolute top-1 right-[30%] h-2 w-2 rounded-full bg-waiting" />}
            </NavLink>
          ))}
        </nav>
      </div>
      {palette && <Palette onClose={() => setPalette(false)} />}
    </div>
  );
}
