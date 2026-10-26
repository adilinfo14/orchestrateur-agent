import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { addOurHooks, removeOurHooks, HOOK_EVENTS } from '../src/install-hooks.ts';
import { isUnderAllowedRoot } from '../src/config.ts';
import { normalizeHook } from '../src/normalize.ts';
import { bounded } from '../src/truncate.ts';
import { Outbox } from '../src/outbox.ts';

describe('installation des hooks', () => {
  const existing = {
    permissions: { allow: ['Bash(git *)'] },
    hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo user-hook' }] }] },
  };

  it('ajoute nos hooks sans toucher aux autres réglages', () => {
    const out = addOurHooks(existing, 47821, 'secret');
    expect(out.permissions).toEqual(existing.permissions);
    expect(Object.keys(out.hooks!)).toEqual(expect.arrayContaining([...HOOK_EVENTS]));
    expect(out.hooks!.PreToolUse).toHaveLength(2);
    expect(out.hooks!.PreToolUse![0]!.hooks[0]!.command).toBe('echo user-hook');
    const ours = out.hooks!.SessionStart![0]!.hooks[0]!;
    expect(ours).toMatchObject({ type: 'http', url: 'http://127.0.0.1:47821/hook?acc=1', allowedEnvVars: ['CLAUDE_CODE_MESSAGING_SOCKET', 'CLAUDE_CODE_MESSAGING_TOKEN'] });
  });

  it('est idempotent et réversible', () => {
    const twice = addOurHooks(addOurHooks(existing, 47821, 's'), 47821, 's');
    expect(twice.hooks!.PreToolUse).toHaveLength(2);
    expect(removeOurHooks(twice)).toEqual(existing);
  });
});

describe('racines autorisées', () => {
  it('accepte la racine et ses sous-dossiers seulement', () => {
    expect(isUnderAllowedRoot('/Users/a/projets/bv', ['/Users/a/projets'])).toBe(true);
    expect(isUnderAllowedRoot('/Users/a/projets', ['/Users/a/projets'])).toBe(true);
    expect(isUnderAllowedRoot('/Users/a/projets-secret', ['/Users/a/projets'])).toBe(false);
    expect(isUnderAllowedRoot('/Users/a/projets/../.ssh', ['/Users/a/projets'])).toBe(false);
    expect(isUnderAllowedRoot('/tmp', [])).toBe(false);
  });
});

describe('normalisation des hooks', () => {
  it('extrait session, agent et cwd ; retire les chemins internes', () => {
    const e = normalizeHook({ hook_event_name: 'SubagentStop', session_id: 's', agent_id: 'a', cwd: '/x', transcript_path: '/t', agent_transcript_path: '/t2', last_assistant_message: 'ok' })!;
    expect(e).toMatchObject({ type: 'SubagentStop', sessionId: 's', agentId: 'a', cwd: '/x', source: 'hook' });
    expect(e.data).toEqual({ last_assistant_message: 'ok' });
  });
  it('rejette un corps sans hook_event_name', () => {
    expect(normalizeHook({ foo: 1 })).toBeNull();
  });
  it('tronque les contenus volumineux', () => {
    const b = bounded({ tool_input: { content: 'x'.repeat(5000), command: 'y'.repeat(5000) } }) as { tool_input: { content: string; command: string } };
    expect(b.tool_input.content.length).toBeLessThan(700);
    expect(b.tool_input.command.length).toBeLessThan(4100);
  });
});

describe('journal d’envoi', () => {
  it('numérote, conserve après réouverture et purge à l’acquittement', () => {
    const dir = mkdtempSync(join(tmpdir(), 'acc-'));
    const ob = new Outbox(join(dir, 'o.db'), 'm1');
    ob.append({ source: 'hook', type: 'A', sessionId: 's', data: {} });
    ob.append({ source: 'hook', type: 'B', sessionId: 's', data: {} });
    ob.close();
    const ob2 = new Outbox(join(dir, 'o.db'), 'm1');
    expect(ob2.pending(0, 10).map((e) => e.seq)).toEqual([1, 2]);
    const c = ob2.append({ source: 'hook', type: 'C', sessionId: 's', data: {} });
    expect(c.seq).toBe(3);
    ob2.ackUpTo(2);
    expect(ob2.pending(0, 10).map((e) => e.type)).toEqual(['C']);
    ob2.close();
  });
});
