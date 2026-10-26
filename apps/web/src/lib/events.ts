import type { LucideIcon } from 'lucide-react';
import {
  AlertTriangle, Bot, CheckCircle2, CircleStop, FilePen, FolderInput, Hand, Hourglass, KeyRound, ListTodo, MessageSquare,
  Minimize2, Play, Plug, Power, Radar, ShieldX, Sparkles, Terminal, Wrench, XCircle, Zap,
} from 'lucide-react';
import { fileFromToolCall, summarizeTool, type AccEvent } from '../../../../packages/protocol/src/index.ts';

export type Tone = 'neutral' | 'working' | 'waiting' | 'error' | 'ok' | 'accent';

export interface EventLook {
  icon: LucideIcon;
  label: string;
  detail: string | null;
  tone: Tone;
  category: EventCategory;
}

export type EventCategory = 'session' | 'subagent' | 'tool' | 'file' | 'error' | 'permission' | 'task' | 'message' | 'system';

export const CATEGORY_LABEL: Record<EventCategory, string> = {
  session: 'Sessions', subagent: 'Sous-agents', tool: 'Outils', file: 'Modifications', error: 'Erreurs',
  permission: 'Validations', task: 'Tâches', message: 'Messages', system: 'Système',
};

export const CATEGORY_TYPES: Record<EventCategory, string[]> = {
  session: ['SessionStart', 'SessionEnd', 'SessionSeen', 'SessionGone', 'ManagedSessionStarted', 'ManagedSessionClosed', 'CwdChanged'],
  subagent: ['SubagentStart', 'SubagentStop'],
  tool: ['PreToolUse', 'PostToolUse'],
  file: ['PostToolUse'],
  error: ['PostToolUseFailure', 'StopFailure', 'ManagedSessionError', 'AssistantError', 'PermissionDenied'],
  permission: ['PermissionRequest', 'PermissionPending', 'PermissionResolved', 'Notification'],
  task: ['UserPromptSubmit', 'Stop', 'TurnResult', 'TaskCreated', 'TaskCompleted'],
  message: ['AssistantText'],
  system: ['SessionChannel', 'CollectorStarted', 'PreCompact'],
};

const s = (v: unknown, n = 160) => (typeof v === 'string' && v ? (v.length > n ? v.slice(0, n) + '…' : v) : null);

export function describeEvent(e: AccEvent): EventLook {
  const d = e.data;
  switch (e.type) {
    case 'SessionStart': return { icon: Play, label: 'Session démarrée', detail: s(d.source), tone: 'ok', category: 'session' };
    case 'SessionEnd': return { icon: Power, label: 'Session terminée', detail: s(d.reason), tone: 'neutral', category: 'session' };
    case 'SessionSeen': return { icon: Radar, label: 'Session détectée', detail: [s(d.name), s(d.entrypoint), s(d.state ?? d.status)].filter(Boolean).join(' · ') || null, tone: 'neutral', category: 'session' };
    case 'SessionGone': return { icon: Power, label: 'Processus disparu', detail: d.pid ? `pid ${String(d.pid)}` : null, tone: 'neutral', category: 'session' };
    case 'ManagedSessionStarted': return { icon: Sparkles, label: 'Session lancée par le cockpit', detail: s(d.prompt), tone: 'accent', category: 'session' };
    case 'ManagedSessionClosed': return { icon: CircleStop, label: 'Session du cockpit fermée', detail: null, tone: 'neutral', category: 'session' };
    case 'CwdChanged': return { icon: FolderInput, label: 'Dossier changé', detail: s(d.new_cwd ?? d.cwd), tone: 'neutral', category: 'session' };
    case 'UserPromptSubmit': return { icon: MessageSquare, label: 'Demande', detail: s(d.prompt, 220), tone: 'accent', category: 'task' };
    case 'PreToolUse': {
      const isAgent = d.tool_name === 'Agent' || d.tool_name === 'Task';
      return { icon: isAgent ? Bot : d.tool_name === 'Bash' ? Terminal : Wrench, label: isAgent ? 'Délégation à un sous-agent' : 'Outil', detail: summarizeTool(d.tool_name, d.tool_input), tone: 'working', category: 'tool' };
    }
    case 'PostToolUse': {
      const f = fileFromToolCall(d.tool_name, d.tool_input);
      return f
        ? { icon: FilePen, label: `${String(d.tool_name)} terminé`, detail: f, tone: 'ok', category: 'file' }
        : { icon: CheckCircle2, label: `${String(d.tool_name ?? 'Outil')} terminé`, detail: typeof d.duration_ms === 'number' ? `${d.duration_ms} ms` : null, tone: 'neutral', category: 'tool' };
    }
    case 'PostToolUseFailure': return { icon: XCircle, label: `Échec ${String(d.tool_name ?? 'outil')}`, detail: s(d.error, 220), tone: 'error', category: 'error' };
    case 'PermissionRequest': return { icon: KeyRound, label: 'Demande d’autorisation', detail: summarizeTool(d.tool_name, d.tool_input), tone: 'waiting', category: 'permission' };
    case 'PermissionPending': return { icon: KeyRound, label: 'Autorisation à valider ici', detail: summarizeTool(d.tool_name, d.tool_input), tone: 'waiting', category: 'permission' };
    case 'PermissionResolved': return { icon: d.decision === 'allow' ? CheckCircle2 : ShieldX, label: d.decision === 'allow' ? 'Autorisation accordée' : 'Autorisation refusée', detail: s(d.tool_name), tone: d.decision === 'allow' ? 'ok' : 'error', category: 'permission' };
    case 'PermissionDenied': return { icon: ShieldX, label: 'Action refusée', detail: s(d.reason) ?? summarizeTool(d.tool_name, d.tool_input), tone: 'error', category: 'error' };
    case 'Notification': return {
      icon: d.notification_type === 'idle_prompt' ? Hourglass : Hand,
      label: d.notification_type === 'permission_prompt' ? 'Validation attendue' : d.notification_type === 'idle_prompt' ? 'En attente d’une instruction' : 'Notification',
      detail: s(d.message), tone: d.notification_type === 'idle_prompt' ? 'neutral' : 'waiting', category: 'permission',
    };
    case 'SubagentStart': return { icon: Bot, label: 'Sous-agent lancé', detail: s(d.agent_type), tone: 'working', category: 'subagent' };
    case 'SubagentStop': return { icon: Bot, label: 'Sous-agent terminé', detail: s(d.last_assistant_message) ?? s(d.agent_type), tone: 'ok', category: 'subagent' };
    case 'Stop': return { icon: CheckCircle2, label: 'Tour terminé', detail: s(d.last_assistant_message, 220), tone: 'ok', category: 'task' };
    case 'StopFailure': return { icon: AlertTriangle, label: 'Tour en échec', detail: s(d.error), tone: 'error', category: 'error' };
    case 'TurnResult': return { icon: d.is_error ? AlertTriangle : CheckCircle2, label: d.is_error ? 'Résultat en erreur' : 'Résultat', detail: s(d.result, 220), tone: d.is_error ? 'error' : 'ok', category: 'task' };
    case 'TaskCreated': return { icon: ListTodo, label: 'Tâche créée', detail: s(d.task_subject), tone: 'neutral', category: 'task' };
    case 'TaskCompleted': return { icon: CheckCircle2, label: 'Tâche terminée', detail: s(d.task_subject), tone: 'ok', category: 'task' };
    case 'AssistantText': return { icon: Sparkles, label: 'Réponse', detail: s(d.text, 220), tone: 'neutral', category: 'message' };
    case 'AssistantError': case 'ManagedSessionError': return { icon: AlertTriangle, label: 'Erreur', detail: s(d.error), tone: 'error', category: 'error' };
    case 'SessionChannel': return { icon: Plug, label: 'Canal d’instructions détecté', detail: 'inbox socket', tone: 'accent', category: 'system' };
    case 'PreCompact': return { icon: Minimize2, label: 'Compaction du contexte', detail: s(d.trigger), tone: 'neutral', category: 'system' };
    case 'CollectorStarted': return { icon: Zap, label: 'Collecteur démarré', detail: s(d.platform), tone: 'neutral', category: 'system' };
    default: return { icon: Zap, label: e.type, detail: null, tone: 'neutral', category: 'system' };
  }
}

export const TONE_TEXT: Record<Tone, string> = {
  neutral: 'text-muted', working: 'text-working', waiting: 'text-waiting', error: 'text-error', ok: 'text-ok', accent: 'text-accent',
};
export const TONE_BG: Record<Tone, string> = {
  neutral: 'bg-raised', working: 'bg-working/10', waiting: 'bg-waiting/10', error: 'bg-error/10', ok: 'bg-ok/10', accent: 'bg-accent/10',
};
