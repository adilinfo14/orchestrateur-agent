import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { AccEvent, CommandPayload } from '../../../packages/protocol/src/index.ts';
import { openDb } from '../src/db.ts';
import { Store } from '../src/store.ts';
import { CommandError, Commands } from '../src/commands.ts';
import { sha256 } from '../src/auth.ts';

const mk = (seq: number, type: string, data: Record<string, unknown> = {}, sessionId = 's1', source: AccEvent['source'] = 'hook'): AccEvent => ({
  id: randomUUID(), machineId: 'm1', seq, ts: Date.now() + seq, source, type, sessionId, agentId: null, cwd: '/p/proj', data,
});

function setup() {
  const db = openDb(':memory:');
  const store = new Store(db);
  store.createMachine('m1', 'Mac', 'mac', 'darwin', sha256('tok'));
  store.updateMachineHello('m1', 'mac', 'darwin', '0.1.0', { hooks: true, sdkSpawn: true, socketSend: true, agentsCli: false, registry: true, allowedRoots: ['/p'] });
  store.setOnline('m1', true);
  const sent: { machineId: string; commandId: string; payload: CommandPayload }[] = [];
  const commands = new Commands(store, (machineId, commandId, payload) => { sent.push({ machineId, commandId, payload }); return true; });
  return { db, store, commands, sent };
}

describe('ingestion', () => {
  it('ignore les doublons (renvoi après reconnexion)', () => {
    const { store, db } = setup();
    const batch = [mk(1, 'SessionStart'), mk(2, 'UserPromptSubmit', { prompt: 'a' })];
    expect(store.ingest('m1', batch)).toBe(2);
    expect(store.ingest('m1', batch)).toBe(2);
    expect((db.prepare('SELECT COUNT(*) n FROM events').get() as { n: number }).n).toBe(2);
    expect(store.sessions.get('s1')!.toolCount).toBe(0);
    expect(store.sessions.get('s1')!.status).toBe('working');
  });

  it('refuse les événements attribués à une autre machine', () => {
    const { store } = setup();
    const e = { ...mk(1, 'SessionStart'), machineId: 'm2' };
    store.ingest('m1', [e]);
    expect(store.sessions.size).toBe(0);
  });

  it('enregistre les fichiers modifiés depuis PostToolUse', () => {
    const { store } = setup();
    store.ingest('m1', [mk(1, 'PostToolUse', { tool_name: 'Edit', tool_input: { file_path: '/p/proj/a.ts' } }), mk(2, 'PostToolUse', { tool_name: 'Edit', tool_input: { file_path: '/p/proj/a.ts' } }), mk(3, 'PostToolUse', { tool_name: 'Read', tool_input: { file_path: '/p/proj/b.ts' } })]);
    expect(store.files('s1')).toEqual([expect.objectContaining({ path: '/p/proj/a.ts', count: 2 })]);
  });

  it('pagination des événements par curseur', () => {
    const { store } = setup();
    store.ingest('m1', Array.from({ length: 10 }, (_, i) => mk(i + 1, 'PreToolUse', { tool_name: 'Bash' })));
    const p1 = store.events({ limit: 4 });
    const last = p1[p1.length - 1]!;
    const p2 = store.events({ limit: 4, before: { ts: last.ts, id: last.id } });
    expect(p1).toHaveLength(4);
    expect(p2).toHaveLength(4);
    expect(new Set([...p1, ...p2].map((e) => e.id)).size).toBe(8);
  });
});

describe('commandes', () => {
  const key = () => randomUUID();

  it('refuse l’envoi sans canal prouvé', () => {
    const { store, commands } = setup();
    store.ingest('m1', [mk(1, 'SessionStart')]);
    expect(() => commands.create({ idempotencyKey: key(), machineId: 'm1', confirmed: false, payload: { type: 'session.send', sessionId: 's1', text: 'hi' } }, 'u', null))
      .toThrow(CommandError);
  });

  it('envoi via socket, idempotent, avec verrou par session', () => {
    const { store, commands, sent } = setup();
    store.ingest('m1', [mk(1, 'SessionStart'), mk(2, 'SessionChannel', { send: 'socket' }, 's1', 'collector')]);
    const k = key();
    const c1 = commands.create({ idempotencyKey: k, machineId: 'm1', confirmed: false, payload: { type: 'session.send', sessionId: 's1', text: 'hi' } }, 'u', null);
    const again = commands.create({ idempotencyKey: k, machineId: 'm1', confirmed: false, payload: { type: 'session.send', sessionId: 's1', text: 'hi' } }, 'u', null);
    expect(again.id).toBe(c1.id);
    expect(sent).toHaveLength(1);
    expect(c1.status).toBe('sent');
    expect(() => commands.create({ idempotencyKey: key(), machineId: 'm1', confirmed: false, payload: { type: 'session.send', sessionId: 's1', text: 'deux' } }, 'u', null))
      .toThrow(/déjà en cours/);
    commands.onResult('m1', c1.id, true, { via: 'socket' }, undefined);
    expect(commands.get(c1.id)!.status).toBe('ok');
  });

  it('un résultat venant d’une autre machine est ignoré', () => {
    const { store, commands } = setup();
    store.ingest('m1', [mk(1, 'SessionStart'), mk(2, 'SessionChannel', { send: 'socket' }, 's1', 'collector')]);
    const c = commands.create({ idempotencyKey: key(), machineId: 'm1', confirmed: false, payload: { type: 'session.send', sessionId: 's1', text: 'hi' } }, 'u', null);
    commands.onResult('m2', c.id, true, null, undefined);
    expect(commands.get(c.id)!.status).toBe('sent');
  });

  it('opérations sensibles : confirmation obligatoire', () => {
    const { commands } = setup();
    expect(() => commands.create({ idempotencyKey: key(), machineId: 'm1', confirmed: false, payload: { type: 'session.spawn', cwd: '/p/proj', prompt: 'x', permissionMode: 'default' } }, 'u', null))
      .toThrow(/Confirmation/);
    const c = commands.create({ idempotencyKey: key(), machineId: 'm1', confirmed: true, payload: { type: 'session.spawn', cwd: '/p/proj', prompt: 'x', permissionMode: 'default' } }, 'u', null);
    expect(c.status).toBe('sent');
  });

  it('interruption refusée pour une session interactive (non supportée)', () => {
    const { store, commands } = setup();
    store.ingest('m1', [mk(1, 'SessionStart'), mk(2, 'SessionChannel', { send: 'socket' }, 's1', 'collector')]);
    expect(() => commands.create({ idempotencyKey: key(), machineId: 'm1', confirmed: false, payload: { type: 'session.interrupt', sessionId: 's1' } }, 'u', null))
      .toThrow(/Interruption non supportée/);
  });

  it('machine hors ligne : rien n’est transmis', () => {
    const { store, commands, sent } = setup();
    store.ingest('m1', [mk(1, 'SessionStart'), mk(2, 'SessionChannel', { send: 'socket' }, 's1', 'collector')]);
    store.setOnline('m1', false);
    expect(() => commands.create({ idempotencyKey: key(), machineId: 'm1', confirmed: false, payload: { type: 'session.send', sessionId: 's1', text: 'x' } }, 'u', null)).toThrow(/hors ligne/);
    expect(sent).toHaveLength(0);
  });

  it('déconnexion du collecteur : résultat inconnu, jamais « ok »', () => {
    const { store, commands } = setup();
    store.ingest('m1', [mk(1, 'SessionStart'), mk(2, 'SessionChannel', { send: 'socket' }, 's1', 'collector')]);
    const c = commands.create({ idempotencyKey: key(), machineId: 'm1', confirmed: false, payload: { type: 'session.send', sessionId: 's1', text: 'x' } }, 'u', null);
    commands.onDisconnect('m1');
    expect(commands.get(c.id)).toMatchObject({ status: 'error' });
  });
});
