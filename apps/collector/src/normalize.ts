import { bounded } from './truncate.ts';
import type { NewEvent } from './outbox.ts';

const DROP_KEYS = new Set(['session_id', 'cwd', 'hook_event_name', 'transcript_path', 'agent_transcript_path', 'agent_id']);

/** Transforme le corps JSON d'un hook Claude Code en événement normalisé. */
export function normalizeHook(body: unknown): NewEvent | null {
  if (!body || typeof body !== 'object') return null;
  const b = body as Record<string, unknown>;
  const type = typeof b.hook_event_name === 'string' ? b.hook_event_name : null;
  if (!type || type.length > 64) return null;
  const data: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(b)) if (!DROP_KEYS.has(k)) data[k] = v;
  return {
    source: 'hook',
    type,
    sessionId: typeof b.session_id === 'string' ? b.session_id : null,
    agentId: typeof b.agent_id === 'string' ? b.agent_id : null,
    cwd: typeof b.cwd === 'string' ? b.cwd : null,
    data: bounded(data) as Record<string, unknown>,
  };
}
