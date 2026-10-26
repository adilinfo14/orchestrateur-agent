import { randomUUID } from 'node:crypto';
import { query, type Query, type SDKUserMessage, type PermissionResult, type SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { bounded } from './truncate.ts';
import type { NewEvent } from './outbox.ts';

/** File asynchrone servant d'entrée en streaming à une session Agent SDK. */
class InputQueue implements AsyncIterable<SDKUserMessage> {
  private items: SDKUserMessage[] = [];
  private waiters: ((r: IteratorResult<SDKUserMessage>) => void)[] = [];
  private closed = false;

  push(text: string): void {
    if (this.closed) throw new Error('Session fermée');
    const msg: SDKUserMessage = { type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null };
    const w = this.waiters.shift();
    if (w) w({ value: msg, done: false });
    else this.items.push(msg);
  }

  close(): void {
    this.closed = true;
    for (const w of this.waiters.splice(0)) w({ value: undefined, done: true });
  }

  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    return {
      next: () => {
        const item = this.items.shift();
        if (item) return Promise.resolve({ value: item, done: false });
        if (this.closed) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => this.waiters.push(resolve));
      },
    };
  }
}

interface PendingPermission {
  resolve: (r: PermissionResult) => void;
  toolName: string;
}

interface Managed {
  sessionId: string;
  cwd: string;
  q: Query;
  input: InputQueue;
  abort: AbortController;
  pending: Map<string, PendingPermission>;
}

export interface SpawnOptions {
  cwd: string;
  prompt: string;
  permissionMode: 'default' | 'acceptEdits' | 'plan';
  model?: string;
}

/**
 * Sessions Claude Code lancées par le collecteur via l'Agent SDK (mécanisme officiel).
 * Ce sont les seules sessions offrant interruption, arrêt et relais des autorisations.
 * Les permissions Claude Code s'appliquent normalement : règles deny/ask, mode choisi, puis
 * canUseTool, qui transmet la demande à l'interface et attend une réponse humaine.
 */
export class SdkSessions {
  private sessions = new Map<string, Managed>();
  /** Sessions arrêtées volontairement : leur abandon n'est pas une erreur. */
  private stopping = new Set<string>();

  private emit: (e: NewEvent) => void;
  private log: (m: string) => void;
  private opts: { relayPermissions: boolean; claudePath: string | null };

  constructor(emit: (e: NewEvent) => void, log: (m: string) => void, opts: { relayPermissions: boolean; claudePath: string | null }) {
    this.emit = emit;
    this.log = log;
    this.opts = opts;
  }

  has(sessionId: string): boolean { return this.sessions.has(sessionId); }

  list(): string[] { return [...this.sessions.keys()]; }

  spawn(o: SpawnOptions): Promise<{ sessionId: string }> {
    const input = new InputQueue();
    const abort = new AbortController();
    const pending = new Map<string, PendingPermission>();
    let sessionId: string | null = null;
    input.push(o.prompt);

    const q = query({
      prompt: input,
      options: {
        cwd: o.cwd,
        permissionMode: o.permissionMode,
        model: o.model,
        abortController: abort,
        pathToClaudeCodeExecutable: this.opts.claudePath ?? undefined,
        canUseTool: async (toolName, toolInput, { signal }) => {
          if (!this.opts.relayPermissions || !sessionId) {
            return { behavior: 'deny', message: 'Relais des autorisations désactivé sur ce collecteur.' };
          }
          const requestId = randomUUID();
          const sid = sessionId;
          this.emit({ source: 'sdk', type: 'PermissionPending', sessionId: sid, cwd: o.cwd, data: { requestId, tool_name: toolName, tool_input: bounded(toolInput) } });
          const result = await new Promise<PermissionResult>((resolve) => {
            pending.set(requestId, { resolve, toolName });
            signal.addEventListener('abort', () => resolve({ behavior: 'deny', message: 'Annulé' }), { once: true });
          });
          pending.delete(requestId);
          this.emit({ source: 'sdk', type: 'PermissionResolved', sessionId: sid, cwd: o.cwd, data: { requestId, tool_name: toolName, decision: result.behavior } });
          return result;
        },
        stderr: (d) => this.log(`[sdk ${sessionId ?? '…'}] ${d.trim().slice(0, 300)}`),
      },
    });

    return new Promise((resolve, reject) => {
      let settled = false;
      const run = async () => {
        try {
          for await (const msg of q) {
            if (!sessionId && 'session_id' in msg && typeof msg.session_id === 'string') {
              sessionId = msg.session_id;
              this.sessions.set(sessionId, { sessionId, cwd: o.cwd, q, input, abort, pending });
              this.emit({ source: 'sdk', type: 'ManagedSessionStarted', sessionId, cwd: o.cwd, data: { permissionMode: o.permissionMode, model: o.model ?? null, prompt: o.prompt.slice(0, 500) } });
              settled = true;
              resolve({ sessionId });
            }
            if (sessionId) this.onMessage(sessionId, o.cwd, msg);
          }
        } catch (err) {
          const message = (err as Error).message;
          const expected = sessionId !== null && this.stopping.has(sessionId);
          this.log(expected ? `session SDK ${sessionId} arrêtée` : `session SDK terminée en erreur : ${message}`);
          if (sessionId && !expected) this.emit({ source: 'sdk', type: 'ManagedSessionError', sessionId, cwd: o.cwd, data: { error: message.slice(0, 2000) } });
          if (!settled) { settled = true; reject(new Error(message)); }
        } finally {
          if (sessionId) {
            for (const p of pending.values()) p.resolve({ behavior: 'deny', message: 'Session fermée' });
            this.sessions.delete(sessionId);
            this.emit({ source: 'sdk', type: 'ManagedSessionClosed', sessionId, cwd: o.cwd, data: { stoppedByCockpit: this.stopping.has(sessionId) } });
            this.stopping.delete(sessionId);
          }
          if (!settled) { settled = true; reject(new Error('La session s’est terminée avant d’annoncer son identifiant')); }
        }
      };
      void run();
    });
  }

  private onMessage(sessionId: string, cwd: string, msg: SDKMessage): void {
    if (msg.type === 'assistant' && msg.parent_tool_use_id === null) {
      const content = (msg.message as { content?: unknown }).content;
      const text = Array.isArray(content)
        ? content.filter((b): b is { type: 'text'; text: string } => !!b && typeof b === 'object' && (b as { type?: unknown }).type === 'text').map((b) => b.text).join('\n')
        : '';
      if (text.trim()) this.emit({ source: 'sdk', type: 'AssistantText', sessionId, cwd, data: { text: text.slice(0, 4000) } });
      if (msg.error) this.emit({ source: 'sdk', type: 'AssistantError', sessionId, cwd, data: { error: msg.error } });
    } else if (msg.type === 'result') {
      this.emit({
        source: 'sdk', type: 'TurnResult', sessionId, cwd,
        data: {
          subtype: msg.subtype, is_error: msg.is_error, num_turns: msg.num_turns, duration_ms: msg.duration_ms,
          total_cost_usd: (msg as { total_cost_usd?: number }).total_cost_usd ?? null,
          result: 'result' in msg && typeof msg.result === 'string' ? msg.result.slice(0, 4000) : null,
        },
      });
    }
  }

  send(sessionId: string, text: string): void {
    const s = this.sessions.get(sessionId);
    if (!s) throw new Error('Session SDK inconnue sur ce collecteur');
    s.input.push(text);
  }

  async interrupt(sessionId: string): Promise<void> {
    const s = this.sessions.get(sessionId);
    if (!s) throw new Error('Session SDK inconnue sur ce collecteur');
    await s.q.interrupt();
  }

  stop(sessionId: string): void {
    const s = this.sessions.get(sessionId);
    if (!s) throw new Error('Session SDK inconnue sur ce collecteur');
    this.stopping.add(sessionId);
    s.input.close();
    s.abort.abort();
  }

  respondPermission(sessionId: string, requestId: string, decision: 'allow' | 'deny', message?: string): void {
    const s = this.sessions.get(sessionId);
    if (!s) throw new Error('Session SDK inconnue sur ce collecteur');
    const p = s.pending.get(requestId);
    if (!p) throw new Error('Demande d’autorisation introuvable ou déjà traitée');
    p.resolve(decision === 'allow' ? { behavior: 'allow' } : { behavior: 'deny', message: message || 'Refusé depuis Agent Command Center' });
  }

  stopAll(): void {
    for (const id of this.list()) { try { this.stop(id); } catch {} }
  }
}
