import { useSyncExternalStore } from 'react';
import type { AccEvent, AgentView, CommandRecord, MachineView, Plan, ServerToUi, SessionView } from '../../../../packages/protocol/src/index.ts';
import { api } from './api.ts';

export type Session = SessionView & { pendingPermissions?: { requestId: string; toolName: string; input: unknown; ts: number }[] };

export interface LiveState {
  status: 'connecting' | 'live' | 'offline';
  loaded: boolean;
  machines: Map<string, MachineView>;
  sessions: Map<string, Session>;
  agents: Map<string, AgentView>;
  events: AccEvent[];
  commands: Map<string, CommandRecord>;
  plans: Map<string, Plan>;
  /** Décalage horloge serveur - client, pour des durées justes. */
  skew: number;
}

const MAX_EVENTS = 600;

let state: LiveState = {
  status: 'connecting', loaded: false, machines: new Map(), sessions: new Map(), agents: new Map(), events: [], commands: new Map(), plans: new Map(), skew: 0,
};
const listeners = new Set<() => void>();
let scheduled = false;

/** Regroupe les notifications dans une frame d'animation : rendu fluide même en rafale. */
function commit(next: Partial<LiveState>): void {
  state = { ...state, ...next };
  if (scheduled) return;
  scheduled = true;
  requestAnimationFrame(() => { scheduled = false; for (const l of listeners) l(); });
}

export function useLive<T>(select: (s: LiveState) => T): T {
  return useSyncExternalStore(
    (l) => { listeners.add(l); return () => listeners.delete(l); },
    () => select(state),
  );
}

export const getLive = () => state;

const agentKey = (a: AgentView) => `${a.sessionId}/${a.id}`;

interface Bootstrap {
  serverTime: number; machines: MachineView[]; sessions: Session[]; agents: AgentView[]; events: AccEvent[]; commands: CommandRecord[];
}

async function bootstrap(): Promise<void> {
  const b = await api<Bootstrap>('/api/bootstrap');
  commit({
    loaded: true,
    skew: b.serverTime - Date.now(),
    machines: new Map(b.machines.map((m) => [m.id, m])),
    sessions: new Map(b.sessions.map((s) => [s.id, s])),
    agents: new Map(b.agents.map((a) => [agentKey(a), a])),
    events: b.events,
    commands: new Map(b.commands.map((c) => [c.id, c])),
  });
}

function onMessage(m: ServerToUi): void {
  switch (m.t) {
    case 'event': {
      if (state.events.some((e) => e.id === m.event.id)) return;
      const events = [m.event, ...state.events];
      if (events.length > MAX_EVENTS) events.length = MAX_EVENTS;
      commit({ events });
      break;
    }
    case 'session': commit({ sessions: new Map(state.sessions).set(m.session.id, m.session) }); break;
    case 'agent': commit({ agents: new Map(state.agents).set(agentKey(m.agent), m.agent) }); break;
    case 'machine': commit({ machines: new Map(state.machines).set(m.machine.id, m.machine) }); break;
    case 'command': commit({ commands: new Map(state.commands).set(m.command.id, m.command) }); break;
    case 'plan': commit({ plans: new Map(state.plans).set(m.plan.id, m.plan) }); break;
    case 'hello': commit({ skew: m.serverTime - Date.now() }); break;
  }
}

let ws: WebSocket | null = null;
let backoff = 1000;
let started = false;

/**
 * Connexion temps réel. À chaque (re)connexion, l'état complet est rechargé : aucune mise à jour
 * manquée pendant une coupure ne peut laisser un affichage périmé.
 */
export function startLive(): void {
  if (started) return;
  started = true;
  const connect = () => {
    commit({ status: 'connecting' });
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${proto}://${location.host}/ws/ui`);
    ws.onopen = () => {
      backoff = 1000;
      bootstrap().then(() => commit({ status: 'live' }), () => commit({ status: 'offline' }));
    };
    ws.onmessage = (e) => { try { onMessage(JSON.parse(e.data as string) as ServerToUi); } catch {} };
    ws.onclose = () => {
      commit({ status: 'offline' });
      const delay = Math.min(backoff, 15000);
      backoff *= 2;
      setTimeout(connect, delay);
    };
  };
  connect();
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && ws && ws.readyState !== WebSocket.OPEN && ws.readyState !== WebSocket.CONNECTING) connect();
  });
}

export function setPlans(list: Plan[]): void {
  const plans = new Map(state.plans);
  for (const p of list) plans.set(p.id, p);
  commit({ plans });
}

export function upsertCommand(c: CommandRecord): void {
  commit({ commands: new Map(state.commands).set(c.id, c) });
}

export function mergeEvents(list: AccEvent[]): void {
  const known = new Set(state.events.map((e) => e.id));
  const add = list.filter((e) => !known.has(e.id));
  if (!add.length) return;
  commit({ events: [...state.events, ...add].sort((a, b) => b.ts - a.ts).slice(0, MAX_EVENTS) });
}
