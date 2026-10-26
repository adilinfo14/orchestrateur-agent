import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { AccEvent } from '../../../packages/protocol/src/index.ts';
import { applyToAgent, applyToSession, newSession } from '../src/reducer.ts';

let seq = 0;
const ev = (type: string, data: Record<string, unknown> = {}, extra: Partial<AccEvent> = {}): AccEvent => ({
  id: randomUUID(), machineId: 'm1', seq: ++seq, ts: 1_000_000 + seq, source: 'hook', type, sessionId: 's1', agentId: null, cwd: '/Users/x/basketvision', data, ...extra,
});

function run(...events: AccEvent[]) {
  const s = newSession(events[0]!);
  for (const e of events) applyToSession(s, e);
  return s;
}

describe('réduction d’état des sessions', () => {
  it('démarrage puis demande : working avec la tâche courante', () => {
    const s = run(ev('SessionStart', { source: 'startup' }), ev('UserPromptSubmit', { prompt: 'Lance les tests' }));
    expect(s.status).toBe('working');
    expect(s.currentTask).toBe('Lance les tests');
    expect(s.project).toBe('basketvision');
  });

  it('demande d’autorisation : waiting, puis reprise après PostToolUse', () => {
    const s = run(ev('PreToolUse', { tool_name: 'Bash', tool_input: { command: 'npm test' } }), ev('PermissionRequest', { tool_name: 'Bash', tool_input: { command: 'npm test' } }));
    expect(s.status).toBe('waiting');
    expect(s.waitingFor).toContain('npm test');
    applyToSession(s, ev('PostToolUse', { tool_name: 'Bash' }));
    expect(s.status).toBe('working');
    expect(s.waitingFor).toBeNull();
  });

  it('Stop : idle avec le dernier message', () => {
    const s = run(ev('UserPromptSubmit', { prompt: 'x' }), ev('Stop', { last_assistant_message: 'Terminé.' }));
    expect(s.status).toBe('idle');
    expect(s.lastMessage).toBe('Terminé.');
  });

  it('échec d’outil : compteur d’erreurs sans changer le statut', () => {
    const s = run(ev('UserPromptSubmit', { prompt: 'x' }), ev('PostToolUseFailure', { error: 'Exit code 1', is_interrupt: false }));
    expect(s.errorCount).toBe(1);
    expect(s.lastError).toBe('Exit code 1');
    expect(s.status).toBe('working');
  });

  it('StopFailure : statut error', () => {
    expect(run(ev('StopFailure', { error: 'rate_limit' })).status).toBe('error');
  });

  it('SessionEnd : ended, et les événements suivants ne la ressuscitent pas', () => {
    const s = run(ev('SessionStart'), ev('SessionEnd', { reason: 'other' }));
    applyToSession(s, ev('Notification', { notification_type: 'idle_prompt' }));
    expect(s.status).toBe('ended');
    expect(s.control.send).toBeNull();
  });

  it('aucun canal de contrôle sans preuve', () => {
    const s = run(ev('SessionStart'));
    expect(s.control).toEqual({ send: null, interrupt: false, stop: false, permissions: false });
  });

  it('canal socket annoncé par le collecteur : envoi possible, pas d’interruption', () => {
    const s = run(ev('SessionStart'), ev('SessionChannel', { send: 'socket' }, { source: 'collector' }));
    expect(s.control.send).toBe('socket');
    expect(s.control.interrupt).toBe(false);
  });

  it('session SDK : contrôle complet et autorisations en attente', () => {
    const s = run(ev('ManagedSessionStarted', { prompt: 'go' }, { source: 'sdk' }), ev('PermissionPending', { requestId: 'r1', tool_name: 'Bash', tool_input: { command: 'ls' } }, { source: 'sdk' }));
    expect(s.control).toEqual({ send: 'sdk', interrupt: true, stop: true, permissions: true });
    expect(s.status).toBe('waiting');
    expect(s.pendingPermissions).toHaveLength(1);
    applyToSession(s, ev('PermissionResolved', { requestId: 'r1', decision: 'allow' }, { source: 'sdk' }));
    expect(s.pendingPermissions).toHaveLength(0);
    expect(s.status).toBe('working');
  });

  it('registre : statut utilisé seulement sans observation par hooks', () => {
    const s = run(ev('SessionSeen', { status: 'idle', name: 'tk-b5', pid: 42 }, { source: 'registry' }));
    expect(s.status).toBe('idle');
    expect(s.name).toBe('tk-b5');
    applyToSession(s, ev('UserPromptSubmit', { prompt: 'x' }));
    applyToSession(s, ev('SessionSeen', { status: 'idle' }, { source: 'registry' }));
    expect(s.status).toBe('working');
  });
});

describe('sous-agents', () => {
  it('relation créée uniquement par SubagentStart/Stop', () => {
    const agents = new Map();
    expect(applyToAgent(agents, ev('PreToolUse', { tool_name: 'Agent', tool_input: { prompt: 'x' } }))).toBeNull();
    const a = applyToAgent(agents, ev('SubagentStart', { agent_type: 'Explore' }, { agentId: 'a1' }));
    expect(a).toMatchObject({ id: 'a1', sessionId: 's1', status: 'running', agentType: 'Explore' });
    const b = applyToAgent(agents, ev('SubagentStop', { agent_type: 'Explore', last_assistant_message: 'ok' }, { agentId: 'a1' }));
    expect(b).toMatchObject({ status: 'done', lastMessage: 'ok' });
    expect(agents.size).toBe(1);
  });
});
