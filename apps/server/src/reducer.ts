// Réduction d'état : dérive la vue d'une session uniquement à partir des événements collectés.
import { projectFromCwd, summarizeTool, type AccEvent, type AgentView, type PendingPermission, type SessionView } from '../../../packages/protocol/src/index.ts';

export interface SessionState extends SessionView {
  pendingPermissions: PendingPermission[];
  managed: boolean;
  socketKnown: boolean;
  lastHookAt: number | null;
}

const str = (v: unknown, max = 240): string | null => (typeof v === 'string' && v.length ? (v.length > max ? v.slice(0, max) + '…' : v) : null);

export function newSession(ev: AccEvent): SessionState {
  return {
    id: ev.sessionId!,
    machineId: ev.machineId,
    cwd: ev.cwd,
    project: projectFromCwd(ev.cwd),
    name: null,
    status: 'unknown',
    waitingFor: null,
    currentTask: null,
    lastTool: null,
    lastMessage: null,
    lastError: null,
    errorCount: 0,
    toolCount: 0,
    startedAt: null,
    lastEventAt: ev.ts,
    sources: [],
    control: { send: null, interrupt: false, stop: false, permissions: false },
    entrypoint: null,
    pid: null,
    agentCount: 0,
    activeAgentCount: 0,
    pendingPermissions: [],
    managed: false,
    socketKnown: false,
    lastHookAt: null,
  };
}

function computeControl(s: SessionState): void {
  const live = s.status !== 'ended';
  s.control = {
    send: !live ? null : s.managed ? 'sdk' : s.socketKnown ? 'socket' : null,
    interrupt: live && s.managed,
    stop: live && s.managed,
    permissions: live && s.managed,
  };
}

function mapExternalStatus(v: unknown): SessionState['status'] | null {
  switch (v) {
    case 'idle': return 'idle';
    case 'busy': case 'working': return 'working';
    case 'waiting': case 'blocked': return 'waiting';
    case 'failed': return 'error';
    case 'done': case 'stopped': return 'ended';
    default: return null;
  }
}

/** Applique un événement à l'état d'une session. Retourne true si la vue a changé. */
export function applyToSession(s: SessionState, ev: AccEvent): void {
  const d = ev.data;
  if (ev.ts >= s.lastEventAt) s.lastEventAt = ev.ts;
  if (ev.cwd && ev.source !== 'registry') { s.cwd = ev.cwd; s.project = projectFromCwd(ev.cwd); }
  else if (ev.cwd && !s.cwd) { s.cwd = ev.cwd; s.project = projectFromCwd(ev.cwd); }
  if (!s.sources.includes(ev.source)) s.sources.push(ev.source);
  if (ev.source === 'hook') s.lastHookAt = Math.max(s.lastHookAt ?? 0, ev.ts);
  // Une session terminée ne revient à la vie que par un démarrage explicite.
  const revive = ev.type === 'SessionStart' || ev.type === 'ManagedSessionStarted' || ev.type === 'UserPromptSubmit';
  if (s.status === 'ended' && !revive) { computeControl(s); return; }

  switch (ev.type) {
    case 'SessionStart':
      s.status = 'idle';
      s.startedAt ??= ev.ts;
      s.name = str(d.session_title, 120) ?? s.name;
      break;
    case 'UserPromptSubmit':
      s.status = 'working';
      s.currentTask = str(d.prompt) ?? s.currentTask;
      s.waitingFor = null;
      break;
    case 'PreToolUse':
      s.status = 'working';
      s.waitingFor = null;
      s.lastTool = summarizeTool(d.tool_name, d.tool_input);
      s.toolCount++;
      break;
    case 'PostToolUse':
    case 'PermissionDenied':
      if (s.status === 'waiting' && s.pendingPermissions.length === 0) s.waitingFor = null;
      if (s.pendingPermissions.length === 0) s.status = 'working';
      break;
    case 'PostToolUseFailure':
      s.errorCount++;
      s.lastError = str(d.error, 500);
      if (d.is_interrupt === true) s.status = 'idle';
      break;
    case 'PermissionRequest':
      s.status = 'waiting';
      s.waitingFor = `Autorisation · ${summarizeTool(d.tool_name, d.tool_input)}`;
      break;
    case 'Notification':
      if (d.notification_type === 'permission_prompt' || d.notification_type === 'elicitation_dialog') {
        s.status = 'waiting';
        s.waitingFor = s.waitingFor ?? str(d.message, 200);
      } else if (d.notification_type === 'idle_prompt' && s.status !== 'waiting') {
        s.status = 'idle';
      }
      break;
    case 'Stop':
      s.status = 'idle';
      s.waitingFor = null;
      s.lastMessage = str(d.last_assistant_message, 1000) ?? s.lastMessage;
      break;
    case 'StopFailure':
    case 'ManagedSessionError':
      s.status = 'error';
      s.errorCount++;
      s.lastError = str(d.error, 500) ?? 'Échec du tour';
      break;
    case 'SessionEnd':
    case 'ManagedSessionClosed':
      s.status = 'ended';
      s.waitingFor = null;
      s.pendingPermissions = [];
      s.managed = false;
      break;
    case 'SessionSeen': {
      s.name = str(d.name, 120) ?? s.name;
      s.pid = typeof d.pid === 'number' ? d.pid : s.pid;
      s.entrypoint = str(d.entrypoint, 40) ?? s.entrypoint;
      if (typeof d.startedAt === 'number') s.startedAt ??= d.startedAt;
      // Statut externe utilisé seulement en l'absence d'observation par les hooks.
      const ext = mapExternalStatus(d.state ?? d.status);
      if (ext && (s.lastHookAt === null || s.status === 'unknown')) s.status = ext;
      if (ev.source === 'agents-cli' && typeof d.waitingFor === 'string') s.waitingFor = d.waitingFor;
      break;
    }
    case 'SessionGone':
      if (s.lastHookAt === null || ev.ts - s.lastHookAt > 5_000) { s.status = 'ended'; s.managed = false; s.socketKnown = false; }
      break;
    case 'SessionChannel':
      if (d.send === 'socket') s.socketKnown = true;
      break;
    case 'ManagedSessionStarted':
      s.managed = true;
      s.status = 'working';
      s.startedAt ??= ev.ts;
      s.currentTask = str(d.prompt) ?? s.currentTask;
      break;
    case 'PermissionPending':
      s.status = 'waiting';
      s.pendingPermissions = [...s.pendingPermissions.filter((p) => p.requestId !== d.requestId), {
        requestId: String(d.requestId), sessionId: s.id, toolName: String(d.tool_name ?? 'outil'), input: d.tool_input ?? null, ts: ev.ts,
      }];
      s.waitingFor = `Autorisation · ${summarizeTool(d.tool_name, d.tool_input)}`;
      break;
    case 'PermissionResolved':
      s.pendingPermissions = s.pendingPermissions.filter((p) => p.requestId !== d.requestId);
      if (!s.pendingPermissions.length) { s.status = 'working'; s.waitingFor = null; }
      break;
    case 'AssistantText':
      s.lastMessage = str(d.text, 1000) ?? s.lastMessage;
      break;
    case 'TurnResult':
      if (d.is_error === true) { s.status = 'error'; s.lastError = str(d.result, 500) ?? `Échec (${String(d.subtype)})`; s.errorCount++; }
      else if (s.pendingPermissions.length === 0) s.status = 'idle';
      break;
  }
  computeControl(s);
}

/** Événements affectant un sous-agent. Seuls SubagentStart/Stop créent une relation parent-enfant. */
export function applyToAgent(agents: Map<string, AgentView>, ev: AccEvent): AgentView | null {
  if (!ev.sessionId) return null;
  const d = ev.data;
  if (ev.type === 'SubagentStart' && ev.agentId) {
    const a: AgentView = {
      id: ev.agentId, sessionId: ev.sessionId, machineId: ev.machineId, agentType: str(d.agent_type, 80),
      status: 'running', startedAt: ev.ts, endedAt: null, lastMessage: null, description: null,
    };
    agents.set(agentKey(ev.sessionId, ev.agentId), a);
    return a;
  }
  if (ev.type === 'SubagentStop' && ev.agentId) {
    const key = agentKey(ev.sessionId, ev.agentId);
    const a = agents.get(key) ?? {
      id: ev.agentId, sessionId: ev.sessionId, machineId: ev.machineId, agentType: str(d.agent_type, 80),
      status: 'running' as const, startedAt: ev.ts, endedAt: null, lastMessage: null, description: null,
    };
    a.status = 'done';
    a.endedAt = ev.ts;
    a.lastMessage = str(d.last_assistant_message, 1000);
    agents.set(key, a);
    return a;
  }
  if (ev.type === 'SessionEnd' || ev.type === 'ManagedSessionClosed' || ev.type === 'SessionGone') {
    // Les sous-agents d'une session terminée ne tournent plus, mais on ne leur invente pas de fin.
    return null;
  }
  return null;
}

export const agentKey = (sessionId: string, agentId: string) => `${sessionId}/${agentId}`;
