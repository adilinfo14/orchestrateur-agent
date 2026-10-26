// Protocole partagé entre collecteurs, serveur central et interface web.
// Toute donnée affichée provient d'un AccEvent collecté : rien n'est synthétisé côté serveur
// en dehors de la réduction d'état (statut dérivé des événements).
import { z } from 'zod';

export const PROTOCOL_VERSION = 1;

/** D'où provient un événement. Affiché dans l'interface pour la traçabilité. */
export const EventSource = z.enum([
  'hook', // hook HTTP Claude Code (documenté)
  'sdk', // flux de messages Agent SDK d'une session lancée par le collecteur (documenté)
  'registry', // ~/.claude/sessions/<pid>.json (non documenté, lecture seule, désactivable)
  'agents-cli', // `claude agents --json` (documenté, sessions en arrière-plan)
  'collector', // événement propre au collecteur (commande exécutée, démarrage…)
]);
export type EventSource = z.infer<typeof EventSource>;

export const AccEvent = z.object({
  id: z.string().uuid(),
  machineId: z.string().min(1),
  seq: z.number().int().nonnegative(),
  ts: z.number().int().positive(),
  source: EventSource,
  /** Nom d'événement : hook_event_name Claude Code (PreToolUse…) ou type propre (SessionSeen, AssistantText…). */
  type: z.string().min(1).max(64),
  sessionId: z.string().max(128).nullable(),
  agentId: z.string().max(128).nullable(),
  cwd: z.string().max(4096).nullable(),
  data: z.record(z.string(), z.unknown()),
});
export type AccEvent = z.infer<typeof AccEvent>;

export const Platform = z.enum(['darwin', 'win32', 'linux', 'wsl']);
export type Platform = z.infer<typeof Platform>;

/** Ce que le collecteur sait faire localement (annoncé au serveur, jamais supposé). */
export const CollectorCapabilities = z.object({
  hooks: z.boolean(),
  sdkSpawn: z.boolean(),
  socketSend: z.boolean(),
  agentsCli: z.boolean(),
  registry: z.boolean(),
  allowedRoots: z.array(z.string()),
});
export type CollectorCapabilities = z.infer<typeof CollectorCapabilities>;

// ---------- Commandes ----------

export const CommandType = z.enum([
  'session.send',
  'session.interrupt',
  'session.stop',
  'session.spawn',
  'permission.respond',
]);
export type CommandType = z.infer<typeof CommandType>;

/** Commandes qui exigent une confirmation explicite côté interface (vérifiée par le serveur). */
export const SENSITIVE_COMMANDS: ReadonlySet<CommandType> = new Set(['session.stop', 'session.spawn', 'permission.respond']);

export const PermissionModeInput = z.enum(['default', 'acceptEdits', 'plan']);

export const CommandPayload = z.discriminatedUnion('type', [
  z.object({ type: z.literal('session.send'), sessionId: z.string().min(1), text: z.string().min(1).max(20000) }),
  z.object({ type: z.literal('session.interrupt'), sessionId: z.string().min(1) }),
  z.object({ type: z.literal('session.stop'), sessionId: z.string().min(1) }),
  z.object({
    type: z.literal('session.spawn'),
    cwd: z.string().min(1).max(4096),
    prompt: z.string().min(1).max(20000),
    permissionMode: PermissionModeInput.default('default'),
    model: z.string().max(64).optional(),
  }),
  z.object({
    type: z.literal('permission.respond'),
    sessionId: z.string().min(1),
    requestId: z.string().min(1),
    decision: z.enum(['allow', 'deny']),
    message: z.string().max(2000).optional(),
  }),
]);
export type CommandPayload = z.infer<typeof CommandPayload>;

/** Requête de commande envoyée par l'interface au serveur. */
export const CommandRequest = z.object({
  /** Clé d'idempotence générée par le client : une même clé n'est jamais exécutée deux fois. */
  idempotencyKey: z.string().uuid(),
  machineId: z.string().min(1),
  confirmed: z.boolean().default(false),
  payload: CommandPayload,
});
export type CommandRequest = z.infer<typeof CommandRequest>;

export const CommandStatus = z.enum(['pending', 'sent', 'ok', 'error', 'timeout', 'rejected']);
export type CommandStatus = z.infer<typeof CommandStatus>;

export interface CommandRecord {
  id: string;
  idempotencyKey: string;
  machineId: string;
  sessionId: string | null;
  type: CommandType;
  payload: CommandPayload;
  status: CommandStatus;
  result: unknown;
  error: string | null;
  createdAt: number;
  updatedAt: number;
  actor: string;
}

// ---------- Messages collecteur <-> serveur ----------

export const CollectorHello = z.object({
  t: z.literal('hello'),
  protocol: z.number().int(),
  machineId: z.string(),
  hostname: z.string().max(255),
  platform: Platform,
  collectorVersion: z.string().max(32),
  capabilities: CollectorCapabilities,
});

export const CollectorToServer = z.discriminatedUnion('t', [
  CollectorHello,
  z.object({ t: z.literal('events'), events: z.array(AccEvent).max(500) }),
  z.object({
    t: z.literal('cmd.result'),
    commandId: z.string(),
    ok: z.boolean(),
    result: z.unknown().optional(),
    error: z.string().max(4000).optional(),
  }),
  z.object({ t: z.literal('ping') }),
]);
export type CollectorToServer = z.infer<typeof CollectorToServer>;

export type ServerToCollector =
  | { t: 'welcome'; ackSeq: number }
  | { t: 'ack'; seq: number }
  | { t: 'cmd'; commandId: string; payload: CommandPayload }
  | { t: 'pong' };

// ---------- Vues exposées à l'interface ----------

export type SessionStatus = 'working' | 'waiting' | 'idle' | 'error' | 'ended' | 'unknown';

export interface SessionView {
  id: string;
  machineId: string;
  cwd: string | null;
  project: string | null;
  name: string | null;
  status: SessionStatus;
  /** Ce que la session attend (outil soumis à autorisation, dialogue…) si statut waiting. */
  waitingFor: string | null;
  currentTask: string | null;
  lastTool: string | null;
  lastMessage: string | null;
  lastError: string | null;
  errorCount: number;
  toolCount: number;
  startedAt: number | null;
  lastEventAt: number;
  /** Sources ayant observé la session. */
  sources: EventSource[];
  /** Canaux de contrôle réellement disponibles, calculés depuis les données collectées. */
  control: SessionControl;
  entrypoint: string | null;
  pid: number | null;
  agentCount: number;
  activeAgentCount: number;
}

export interface SessionControl {
  /** 'sdk' : session lancée par le collecteur ; 'socket' : inbox socket connu ; null : observation seule. */
  send: 'sdk' | 'socket' | null;
  interrupt: boolean;
  stop: boolean;
  permissions: boolean;
}

export interface AgentView {
  id: string;
  sessionId: string;
  machineId: string;
  agentType: string | null;
  status: 'running' | 'done';
  startedAt: number;
  endedAt: number | null;
  lastMessage: string | null;
  description: string | null;
}

export interface MachineView {
  id: string;
  name: string;
  hostname: string | null;
  platform: Platform | null;
  online: boolean;
  lastSeenAt: number | null;
  collectorVersion: string | null;
  capabilities: CollectorCapabilities | null;
  allowControl: boolean;
  createdAt: number;
}

export interface FileTouch {
  sessionId: string;
  path: string;
  tool: string;
  count: number;
  lastTs: number;
}

export interface PendingPermission {
  requestId: string;
  sessionId: string;
  toolName: string;
  input: unknown;
  ts: number;
}

export type PlanStatus = 'planning' | 'planning_failed' | 'draft' | 'running' | 'blocked' | 'completed' | 'cancelled';
export type TaskStatus = 'pending' | 'dispatched' | 'reported' | 'verified' | 'failed';

export interface PlanTask {
  id: string;
  planId: string;
  idx: number;
  title: string;
  instructions: string;
  dependsOn: string[];
  /** Commande dont l'exécution réussie, observée via les hooks, prouve la tâche. */
  verify: string | null;
  assigneeSessionId: string | null;
  status: TaskStatus;
  dispatchedAt: number | null;
  commandId: string | null;
  report: string | null;
  evidence: { ts: number; eventId: string; command: string; ok: boolean } | null;
  error: string | null;
  updatedAt: number;
}

export interface Plan {
  id: string;
  objective: string;
  machineId: string | null;
  cwd: string | null;
  plannerSessionId: string | null;
  plannerCommandId: string | null;
  status: PlanStatus;
  error: string | null;
  actor: string;
  createdAt: number;
  updatedAt: number;
  tasks: PlanTask[];
}

/** Messages poussés par le serveur à l'interface. */
export type ServerToUi =
  | { t: 'hello'; serverTime: number }
  | { t: 'event'; event: AccEvent }
  | { t: 'session'; session: SessionView }
  | { t: 'agent'; agent: AgentView }
  | { t: 'machine'; machine: MachineView }
  | { t: 'command'; command: CommandRecord }
  | { t: 'plan'; plan: Plan };

// ---------- Utilitaires partagés ----------

const FILE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);

/** Fichier modifié déduit d'un appel d'outil documenté (jamais d'une lecture de fichiers internes). */
export function fileFromToolCall(toolName: unknown, toolInput: unknown): string | null {
  if (typeof toolName !== 'string' || !FILE_TOOLS.has(toolName)) return null;
  if (!toolInput || typeof toolInput !== 'object') return null;
  const input = toolInput as Record<string, unknown>;
  const p = input.file_path ?? input.notebook_path;
  return typeof p === 'string' && p.length > 0 ? p : null;
}

/** Nom de projet lisible depuis un cwd, sans supposition sur la racine git. */
export function projectFromCwd(cwd: string | null | undefined): string | null {
  if (!cwd) return null;
  const parts = cwd.split(/[\\/]+/).filter(Boolean);
  return parts.length ? parts[parts.length - 1]! : cwd;
}

/** Résumé court d'un appel d'outil pour l'affichage. */
export function summarizeTool(toolName: unknown, toolInput: unknown): string {
  const name = typeof toolName === 'string' ? toolName : 'outil';
  const input = (toolInput && typeof toolInput === 'object' ? toolInput : {}) as Record<string, unknown>;
  const pick = (k: string) => (typeof input[k] === 'string' ? (input[k] as string) : null);
  const detail =
    pick('description') ?? pick('command') ?? pick('file_path') ?? pick('pattern') ?? pick('url') ?? pick('query') ?? pick('prompt');
  return detail ? `${name} · ${detail.slice(0, 140)}` : name;
}
