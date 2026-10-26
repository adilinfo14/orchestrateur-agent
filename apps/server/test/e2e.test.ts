import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import net from 'node:net';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.ts';
import { openDb } from '../src/db.ts';
import { createEnrollCode, setPassword } from '../src/auth.ts';
import type { Store } from '../src/store.ts';
import { Outbox } from '../../collector/src/outbox.ts';
import { Uplink } from '../../collector/src/uplink.ts';
import { startHookServer, type HookChannel } from '../../collector/src/hook-server.ts';
import { createCommandHandler, SEND_PREFIX } from '../../collector/src/commands.ts';
import { SdkSessions } from '../../collector/src/sdk-sessions.ts';
import type { CollectorConfig } from '../../collector/src/config.ts';

const waitFor = async (fn: () => boolean, ms = 4000) => {
  const t0 = Date.now();
  while (!fn()) { if (Date.now() - t0 > ms) throw new Error('délai dépassé'); await new Promise((r) => setTimeout(r, 25)); }
};

describe('bout en bout : collecteur réel -> serveur -> commande -> inbox socket', () => {
  let app: FastifyInstance, store: Store, base: string, uplink: Uplink, hookPort: number, cookie: string;
  const dir = mkdtempSync(join(tmpdir(), 'acc-e2e-'));
  const sockPath = join(dir, 'inbox.sock');
  const received: string[] = [];
  const inbox = net.createServer((c) => { let b = ''; c.on('data', (d) => (b += d)); c.on('end', () => received.push(b)); });

  beforeAll(async () => {
    await new Promise<void>((r) => inbox.listen(sockPath, r));
    const db = openDb(':memory:');
    setPassword(db, 'admin', 'mot-de-passe-solide');
    ({ app, store } = await buildApp({ db }));
    await app.listen({ host: '127.0.0.1', port: 0 });
    base = `http://127.0.0.1:${(app.server.address() as net.AddressInfo).port}`;

    const login = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-acc-csrf': '1' }, body: JSON.stringify({ username: 'admin', password: 'mot-de-passe-solide' }) });
    cookie = login.headers.get('set-cookie')!.split(';')[0]!;

    const code = createEnrollCode(db);
    const enr = (await (await fetch(`${base}/api/enroll`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code, name: 'Test', platform: 'darwin' }) })).json()) as { machineId: string; token: string };
    // Un code ne sert qu'une fois.
    expect((await fetch(`${base}/api/enroll`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code, name: 'Bis' }) })).status).toBe(403);

    const cfg: CollectorConfig = {
      serverUrl: base, machineId: enr.machineId, machineToken: enr.token, localToken: 'local', hookPort: 0, allowedRoots: [dir],
      allowSend: true, allowSpawn: false, allowPermissionRelay: false, useSessionRegistry: false, socketSendAuthToken: true, claudePath: null,
    };
    const outbox = new Outbox(join(dir, 'out.db'), cfg.machineId);
    const channels = new Map<string, HookChannel>();
    const emit = outbox.append.bind(outbox);
    const server = await startHookServer({
      port: 0, localToken: 'local', log: () => {}, onEvent: emit,
      onChannel: (sid, ch) => { if (!channels.has(sid)) emit({ source: 'collector', type: 'SessionChannel', sessionId: sid, data: { send: 'socket' } }); channels.set(sid, ch); },
    });
    hookPort = (server.address() as net.AddressInfo).port;
    const handle = createCommandHandler(cfg, new SdkSessions(emit, () => {}, { relayPermissions: false, claudePath: null }), channels);
    uplink = new Uplink({
      serverUrl: base, machineId: cfg.machineId, machineToken: cfg.machineToken, hostname: 'test', platform: 'darwin', version: 't', outbox, log: () => {},
      capabilities: () => ({ hooks: true, sdkSpawn: false, socketSend: true, agentsCli: false, registry: false, allowedRoots: [dir] }),
      onCommand: (_id, p) => handle(p),
    });
    uplink.start();
    await waitFor(() => uplink.connected);
  });

  afterAll(async () => { uplink.stop(); await app.close(); inbox.close(); });

  it('rejette un hook sans jeton local', async () => {
    const r = await fetch(`http://127.0.0.1:${hookPort}/hook`, { method: 'POST', body: '{}' });
    expect(r.status).toBe(401);
  });

  it('remonte les hooks et déduit un canal d’envoi', async () => {
    const post = (body: unknown) => fetch(`http://127.0.0.1:${hookPort}/hook?acc=1`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-acc-token': 'local', 'x-acc-socket': sockPath, 'x-acc-msg-token': 'tok123' }, body: JSON.stringify(body),
    });
    const r = await post({ hook_event_name: 'SessionStart', session_id: 'sess-1', cwd: dir, source: 'startup' });
    expect(r.status).toBe(200);
    expect(await r.text()).toBe(''); // jamais de décision renvoyée à Claude Code
    await post({ hook_event_name: 'UserPromptSubmit', session_id: 'sess-1', cwd: dir, prompt: 'Écris les tests' });
    await waitFor(() => store.sessions.get('sess-1')?.status === 'working');
    const s = store.sessions.get('sess-1')!;
    expect(s.currentTask).toBe('Écris les tests');
    expect(s.control.send).toBe('socket');
  });

  it('API protégée : 401 sans cookie, 403 sans en-tête anti-CSRF', async () => {
    expect((await fetch(`${base}/api/bootstrap`)).status).toBe(401);
    expect((await fetch(`${base}/api/commands`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: '{}' })).status).toBe(403);
  });

  it('transmet une instruction jusqu’à l’inbox socket de la session', async () => {
    const machineId = store.machines()[0]!.id;
    const res = await fetch(`${base}/api/commands`, {
      method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-acc-csrf': '1' },
      body: JSON.stringify({ idempotencyKey: randomUUID(), machineId, payload: { type: 'session.send', sessionId: 'sess-1', text: 'Lance npm test' } }),
    });
    expect(res.status).toBe(200);
    const cmd = (await res.json()) as { id: string };
    await waitFor(() => received.length === 1);
    const lines = received[0]!.trim().split('\n').map((l) => JSON.parse(l));
    expect(lines[0]).toEqual({ type: 'auth', token: 'tok123' });
    expect(lines[1]).toEqual({ type: 'user', message: { role: 'user', content: SEND_PREFIX + 'Lance npm test' } });
    await waitFor(() => (store.db.prepare('SELECT status FROM commands WHERE id = ?').get(cmd.id) as { status: string }).status === 'ok');
  });
});
