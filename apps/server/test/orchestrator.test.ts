import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { AccEvent, CommandPayload } from '../../../packages/protocol/src/index.ts';
import { openDb } from '../src/db.ts';
import { Store } from '../src/store.ts';
import { Commands } from '../src/commands.ts';
import { sha256 } from '../src/auth.ts';
import { Orchestrator, parsePlannerOutput, validateDag } from '../src/orchestrator.ts';

let seq = 0;
const ev = (type: string, sessionId: string, data: Record<string, unknown> = {}, source: AccEvent['source'] = 'hook'): AccEvent => ({
  id: randomUUID(), machineId: 'm1', seq: ++seq, ts: Date.now(), source, type, sessionId, agentId: null, cwd: '/p/proj', data,
});

function setup() {
  const db = openDb(':memory:');
  const store = new Store(db);
  store.createMachine('m1', 'Mac', 'mac', 'darwin', sha256('t'));
  store.updateMachineHello('m1', 'mac', 'darwin', '0', { hooks: true, sdkSpawn: true, socketSend: true, agentsCli: false, registry: false, allowedRoots: ['/p'] });
  store.setOnline('m1', true);
  const sent: { commandId: string; payload: CommandPayload }[] = [];
  const commands = new Commands(store, (_m, commandId, payload) => { sent.push({ commandId, payload }); return true; });
  const orch = new Orchestrator(store, commands, () => {});
  store.onIngest((e) => orch.onEvents(e));
  commands.onFinish((c) => orch.onCommandFinished(c));
  for (const s of ['sA', 'sB']) store.ingest('m1', [ev('SessionStart', s), ev('SessionChannel', s, { send: 'socket' }, 'collector')]);
  return { store, commands, orch, sent };
}

describe('planificateur', () => {
  it('extrait le JSON d’un bloc de code', () => {
    const out = parsePlannerOutput('Voici :\n```json\n{"tasks":[{"key":"t1","title":"Tests","instructions":"Lance les tests","dependsOn":[],"verify":"npm test"}]}\n```');
    expect(out.tasks[0]).toMatchObject({ key: 't1', verify: 'npm test' });
  });
  it('rejette une réponse sans JSON', () => {
    expect(() => parsePlannerOutput('Je ne sais pas')).toThrow();
  });
  it('détecte les cycles et dépendances inconnues', () => {
    expect(validateDag([{ id: 'a', dependsOn: ['b'] }, { id: 'b', dependsOn: ['a'] }])).toMatch(/cycle/);
    expect(validateDag([{ id: 'a', dependsOn: ['x'] }])).toMatch(/inconnue/);
    expect(validateDag([{ id: 'a', dependsOn: [] }, { id: 'b', dependsOn: ['a'] }])).toBeNull();
  });
});

describe('exécution d’un plan', () => {
  it('respecte les dépendances et n’affirme « vérifiée » qu’avec une preuve observée', () => {
    const { orch, sent, commands, store } = setup();
    const plan = orch.createManual('Finir BasketVision', [
      { id: 't1', title: 'Tests', instructions: 'Corrige et lance les tests', dependsOn: [], verify: 'npm test', assigneeSessionId: 'sA' },
      { id: 't2', title: 'Animations', instructions: 'Vérifie les animations', dependsOn: ['t1'], verify: null, assigneeSessionId: 'sB' },
    ], 'u', null);
    expect(plan.status).toBe('draft');
    expect(sent).toHaveLength(0); // rien n'est exécuté avant validation

    orch.startPlan(plan.id, 'u', null);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.payload).toMatchObject({ type: 'session.send', sessionId: 'sA' });
    commands.onResult('m1', sent[0]!.commandId, true, { via: 'socket' }, undefined);

    // La session termine son tour SANS exécuter la commande de preuve : annoncée, pas vérifiée.
    store.ingest('m1', [ev('UserPromptSubmit', 'sA', { prompt: 'x' }), ev('Stop', 'sA', { last_assistant_message: 'Fait !' })]);
    let p = orch.get(plan.id)!;
    expect(p.tasks[0]).toMatchObject({ status: 'reported', report: 'Fait !' });
    expect(sent).toHaveLength(1); // t2 attend une preuve pour t1

    // Validation manuelle tracée, puis t2 part.
    orch.markVerified(plan.id, 't1', 'Tests vérifiés à la main', 'u', null);
    p = orch.get(plan.id)!;
    expect(p.tasks[0]!.status).toBe('verified');
    expect(sent).toHaveLength(2);
    expect(sent[1]!.payload).toMatchObject({ sessionId: 'sB' });
    commands.onResult('m1', sent[1]!.commandId, true, null, undefined);
    store.ingest('m1', [ev('Stop', 'sB', { last_assistant_message: 'Animations OK' })]);
    p = orch.get(plan.id)!;
    expect(p.tasks[1]!.status).toBe('reported');
    expect(p.status).toBe('completed');
  });

  it('preuve automatique : commande de vérification réussie dans la bonne session', () => {
    const { orch, sent, commands, store } = setup();
    const plan = orch.createManual('obj', [{ id: 't1', title: 'Tests', instructions: 'go', dependsOn: [], verify: 'npm test', assigneeSessionId: 'sA' }], 'u', null);
    orch.startPlan(plan.id, 'u', null);
    commands.onResult('m1', sent[0]!.commandId, true, null, undefined);
    // Une exécution dans une AUTRE session ne compte pas.
    store.ingest('m1', [ev('PostToolUse', 'sB', { tool_name: 'Bash', tool_input: { command: 'npm test' } })]);
    store.ingest('m1', [ev('PostToolUse', 'sA', { tool_name: 'Bash', tool_input: { command: 'cd app && npm test' } }), ev('Stop', 'sA', { last_assistant_message: 'ok' })]);
    const t = orch.get(plan.id)!.tasks[0]!;
    expect(t.status).toBe('verified');
    expect(t.evidence).toMatchObject({ ok: true, command: 'cd app && npm test' });
  });

  it('échec de la commande de preuve : tâche en échec, plan bloqué', () => {
    const { orch, sent, commands, store } = setup();
    const plan = orch.createManual('obj', [{ id: 't1', title: 'Tests', instructions: 'go', dependsOn: [], verify: 'npm test', assigneeSessionId: 'sA' }], 'u', null);
    orch.startPlan(plan.id, 'u', null);
    commands.onResult('m1', sent[0]!.commandId, true, null, undefined);
    store.ingest('m1', [ev('PostToolUseFailure', 'sA', { tool_name: 'Bash', tool_input: { command: 'npm test' }, error: 'Exit 1' }), ev('Stop', 'sA', {})]);
    const p = orch.get(plan.id)!;
    expect(p.tasks[0]!.status).toBe('failed');
    expect(p.status).toBe('blocked');
  });

  it('n’envoie pas à une session occupée', () => {
    const { orch, sent, store } = setup();
    store.ingest('m1', [ev('UserPromptSubmit', 'sA', { prompt: 'autre travail' })]);
    const plan = orch.createManual('obj', [{ id: 't1', title: 'T', instructions: 'go', dependsOn: [], verify: null, assigneeSessionId: 'sA' }], 'u', null);
    orch.startPlan(plan.id, 'u', null);
    expect(sent).toHaveLength(0);
    store.ingest('m1', [ev('Stop', 'sA', {})]);
    expect(sent).toHaveLength(1);
  });

  it('refuse de lancer un plan avec une session non pilotable', () => {
    const { orch, store } = setup();
    store.ingest('m1', [ev('SessionStart', 'sC')]);
    const plan = orch.createManual('obj', [{ id: 't1', title: 'T', instructions: 'go', dependsOn: [], verify: null, assigneeSessionId: 'sC' }], 'u', null);
    expect(() => orch.startPlan(plan.id, 'u', null)).toThrow(/pilotable/);
  });
});
