import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import fastifyCookie from '@fastify/cookie';
import fastifyWebsocket from '@fastify/websocket';
import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { WebSocket } from 'ws';
import { CollectorToServer, CommandRequest, PROTOCOL_VERSION, type ServerToCollector, type ServerToUi } from '../../../packages/protocol/src/index.ts';
import { audit, consumeEnrollCode, createEnrollCode, login, logout, randomToken, RateLimiter, sha256, userForToken } from './auth.ts';
import { CommandError, Commands } from './commands.ts';
import type { Db } from './db.ts';
import { Store } from './store.ts';
import { Orchestrator, TaskInput } from './orchestrator.ts';

export interface AppOptions {
  db: Db;
  webDist?: string;
  secureCookies?: boolean;
  logger?: boolean;
}

const COOKIE = 'acc_session';

declare module 'fastify' {
  interface FastifyRequest { user: string | null }
}

export async function buildApp(opts: AppOptions): Promise<{ app: FastifyInstance; store: Store; commands: Commands; orchestrator: Orchestrator }> {
  const app = Fastify({ logger: opts.logger ?? false, bodyLimit: 2_000_000, trustProxy: true });
  const store = new Store(opts.db);
  const collectors = new Map<string, WebSocket>();

  const dispatch = (machineId: string, commandId: string, payload: unknown): boolean => {
    const ws = collectors.get(machineId);
    if (!ws || ws.readyState !== ws.OPEN) return false;
    ws.send(JSON.stringify({ t: 'cmd', commandId, payload } as ServerToCollector));
    return true;
  };
  const commands = new Commands(store, dispatch as never);
  const orchestrator = new Orchestrator(store, commands, (plan) => store.broadcast({ t: 'plan', plan }));
  store.onIngest((events) => orchestrator.onEvents(events));
  commands.onFinish((c) => orchestrator.onCommandFinished(c));
  orchestrator.start();
  app.addHook('onClose', async () => orchestrator.stop());

  await app.register(fastifyCookie);
  await app.register(fastifyWebsocket, { options: { maxPayload: 4 * 1024 * 1024 } });

  const loginLimiter = new RateLimiter(8, 60_000);
  const enrollLimiter = new RateLimiter(5, 60_000);

  app.decorateRequest('user', null);
  app.addHook('onRequest', async (req, reply) => {
    req.user = userForToken(opts.db, req.cookies[COOKIE]);
    const url = req.url.split('?')[0]!;
    if (!url.startsWith('/api/')) return;
    const open = url === '/api/login' || url === '/api/enroll' || url === '/api/health';
    if (!open && !req.user) return reply.code(401).send({ error: 'Authentification requise' });
    // Anti-CSRF : en-tête personnalisé exigé sur toute requête modifiante (impossible cross-origin sans CORS).
    if (req.method !== 'GET' && url !== '/api/enroll' && req.headers['x-acc-csrf'] !== '1') {
      return reply.code(403).send({ error: 'En-tête anti-CSRF manquant' });
    }
  });
  app.addHook('onSend', async (_req, reply, payload) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('X-Frame-Options', 'DENY');
    return payload;
  });

  const fail = (reply: FastifyReply, status: number, error: string) => reply.code(status).send({ error });

  // ---------- Auth ----------

  app.get('/api/health', async () => ({ ok: true, protocol: PROTOCOL_VERSION }));

  app.post('/api/login', async (req, reply) => {
    if (!loginLimiter.allow(req.ip)) return fail(reply, 429, 'Trop de tentatives, réessayez dans une minute');
    const body = z.object({ username: z.string().min(1).max(64), password: z.string().min(1).max(256) }).safeParse(req.body);
    if (!body.success) return fail(reply, 400, 'Requête invalide');
    const token = login(opts.db, body.data.username, body.data.password);
    audit(opts.db, body.data.username, token ? 'login.ok' : 'login.failed', null, null, req.ip);
    if (!token) return fail(reply, 401, 'Identifiants invalides');
    reply.setCookie(COOKIE, token, { httpOnly: true, sameSite: 'strict', secure: opts.secureCookies ?? false, path: '/', maxAge: 30 * 24 * 3600 });
    return { username: body.data.username };
  });

  app.post('/api/logout', async (req, reply) => {
    logout(opts.db, req.cookies[COOKIE]);
    reply.clearCookie(COOKIE, { path: '/' });
    return { ok: true };
  });

  app.get('/api/me', async (req) => ({ username: req.user }));

  // ---------- Machines ----------

  app.post('/api/enroll', async (req, reply) => {
    if (!enrollLimiter.allow(req.ip)) return fail(reply, 429, 'Trop de tentatives');
    const body = z.object({
      code: z.string().min(5).max(32), name: z.string().min(1).max(80), hostname: z.string().max(255).optional(), platform: z.string().max(16).optional(),
    }).safeParse(req.body);
    if (!body.success) return fail(reply, 400, 'Requête invalide');
    if (!consumeEnrollCode(opts.db, body.data.code)) {
      audit(opts.db, 'anonymous', 'enroll.failed', null, { name: body.data.name }, req.ip);
      return fail(reply, 403, 'Code invalide, expiré ou déjà utilisé');
    }
    const token = randomToken();
    const id = randomUUID();
    store.createMachine(id, body.data.name, body.data.hostname ?? null, body.data.platform ?? null, sha256(token));
    audit(opts.db, 'anonymous', 'enroll.ok', id, { name: body.data.name, hostname: body.data.hostname }, req.ip);
    return { machineId: id, token };
  });

  app.post('/api/enroll-codes', async (req) => {
    const code = createEnrollCode(opts.db);
    audit(opts.db, req.user!, 'enroll.code_created', null, null, req.ip);
    return { code, expiresInMinutes: 15 };
  });

  app.get('/api/machines', async () => store.machines());

  app.patch<{ Params: { id: string } }>('/api/machines/:id', async (req, reply) => {
    const body = z.object({ allowControl: z.boolean().optional(), name: z.string().min(1).max(80).optional(), confirmed: z.literal(true) }).safeParse(req.body);
    if (!body.success) return fail(reply, 400, 'Requête invalide (confirmation requise)');
    if (!store.machine(req.params.id)) return fail(reply, 404, 'Machine inconnue');
    store.setMachinePolicy(req.params.id, body.data);
    audit(opts.db, req.user!, 'machine.policy', req.params.id, body.data, req.ip);
    return store.machine(req.params.id);
  });

  app.post<{ Params: { id: string } }>('/api/machines/:id/revoke', async (req, reply) => {
    const body = z.object({ confirmed: z.literal(true) }).safeParse(req.body);
    if (!body.success) return fail(reply, 400, 'Confirmation requise');
    store.revokeMachine(req.params.id);
    collectors.get(req.params.id)?.close(4003, 'révoquée');
    audit(opts.db, req.user!, 'machine.revoked', req.params.id, null, req.ip);
    return { ok: true };
  });

  // ---------- Données ----------

  app.get('/api/bootstrap', async () => {
    const horizon = Date.now() - 7 * 24 * 3600 * 1000;
    const sessions = [...store.sessions.values()].filter((s) => s.status !== 'ended' || s.lastEventAt > horizon);
    const ids = new Set(sessions.map((s) => s.id));
    return {
      serverTime: Date.now(),
      machines: store.machines(),
      sessions,
      agents: [...store.agents.values()].filter((a) => ids.has(a.sessionId)),
      events: store.events({ limit: 200 }),
      commands: commands.list({ limit: 50 }),
    };
  });

  app.get<{ Params: { id: string } }>('/api/sessions/:id', async (req, reply) => {
    const s = store.sessions.get(req.params.id);
    if (!s) return fail(reply, 404, 'Session inconnue');
    return {
      session: s,
      agents: store.agentsOf(s.id),
      files: store.files(s.id),
      events: store.events({ sessionId: s.id, limit: 200 }),
      commands: commands.list({ sessionId: s.id, limit: 50 }),
    };
  });

  const EventsQuery = z.object({
    before: z.string().regex(/^\d+:[0-9a-f-]{36}$/).optional(),
    limit: z.coerce.number().int().min(1).max(500).default(100),
    machineId: z.string().max(64).optional(),
    sessionId: z.string().max(128).optional(),
    project: z.string().max(255).optional(),
    types: z.string().max(1000).optional(),
  });

  app.get('/api/events', async (req, reply) => {
    const q = EventsQuery.safeParse(req.query);
    if (!q.success) return fail(reply, 400, 'Paramètres invalides');
    const { before, limit, machineId, sessionId, project, types } = q.data;
    const [ts, id] = before ? [Number(before.split(':')[0]), before.slice(before.indexOf(':') + 1)] : [0, ''];
    const sessionIds = project ? [...store.sessions.values()].filter((s) => s.project === project).map((s) => s.id) : undefined;
    return store.events({
      before: before ? { ts, id } : undefined, limit, machineId, sessionId, sessionIds,
      types: types ? types.split(',').filter(Boolean).slice(0, 40) : undefined,
    });
  });

  app.get<{ Querystring: { sessionId?: string } }>('/api/commands', async (req) => commands.list({ sessionId: req.query.sessionId, limit: 100 }));

  app.post('/api/commands', async (req, reply) => {
    const body = CommandRequest.safeParse(req.body);
    if (!body.success) return fail(reply, 400, `Commande invalide : ${body.error.issues[0]?.message ?? ''}`);
    try {
      return commands.create(body.data, req.user!, req.ip);
    } catch (e) {
      if (e instanceof CommandError) return fail(reply, e.status, e.message);
      throw e;
    }
  });

  app.get('/api/audit', async () =>
    opts.db.prepare('SELECT id, ts, actor, action, target, detail, ip FROM audit ORDER BY ts DESC LIMIT 300').all());

  // ---------- Orchestration ----------

  const planError = (reply: FastifyReply, e: unknown) => fail(reply, e instanceof CommandError ? e.status : 400, (e as Error).message);

  app.get('/api/plans', async () => orchestrator.list());

  app.get<{ Params: { id: string } }>('/api/plans/:id', async (req, reply) => orchestrator.get(req.params.id) ?? fail(reply, 404, 'Plan inconnu'));

  app.post('/api/plans', async (req, reply) => {
    const body = z.union([
      z.object({ objective: z.string().min(3).max(4000), machineId: z.string().max(64), cwd: z.string().min(1).max(4096), confirmed: z.literal(true) }),
      z.object({ objective: z.string().min(3).max(4000), tasks: z.array(TaskInput).min(1).max(20) }),
    ]).safeParse(req.body);
    if (!body.success) return fail(reply, 400, 'Requête invalide');
    try {
      return 'tasks' in body.data
        ? orchestrator.createManual(body.data.objective, body.data.tasks, req.user!, req.ip)
        : orchestrator.createWithPlanner(body.data.objective, body.data.machineId, body.data.cwd, req.user!, req.ip);
    } catch (e) { return planError(reply, e); }
  });

  app.put<{ Params: { id: string } }>('/api/plans/:id/tasks', async (req, reply) => {
    const body = z.object({ tasks: z.array(TaskInput).min(1).max(20) }).safeParse(req.body);
    if (!body.success) return fail(reply, 400, 'Tâches invalides');
    try { orchestrator.replaceTasks(req.params.id, body.data.tasks); audit(opts.db, req.user!, 'plan.edited', req.params.id, { tasks: body.data.tasks.length }, req.ip); return orchestrator.get(req.params.id); }
    catch (e) { return planError(reply, e); }
  });

  app.post<{ Params: { id: string } }>('/api/plans/:id/start', async (req, reply) => {
    if (!z.object({ confirmed: z.literal(true) }).safeParse(req.body).success) return fail(reply, 428, 'Confirmation requise');
    try { return orchestrator.startPlan(req.params.id, req.user!, req.ip); } catch (e) { return planError(reply, e); }
  });

  app.post<{ Params: { id: string } }>('/api/plans/:id/cancel', async (req, reply) => {
    try { return orchestrator.cancel(req.params.id, req.user!, req.ip); } catch (e) { return planError(reply, e); }
  });

  app.post<{ Params: { id: string; taskId: string } }>('/api/plans/:id/tasks/:taskId/verify', async (req, reply) => {
    const body = z.object({ note: z.string().min(3).max(500), confirmed: z.literal(true) }).safeParse(req.body);
    if (!body.success) return fail(reply, 400, 'Justification et confirmation requises');
    try { return orchestrator.markVerified(req.params.id, req.params.taskId, body.data.note, req.user!, req.ip); } catch (e) { return planError(reply, e); }
  });

  app.post<{ Params: { id: string; taskId: string } }>('/api/plans/:id/tasks/:taskId/retry', async (req, reply) => {
    try { return orchestrator.retryTask(req.params.id, req.params.taskId, req.user!, req.ip); } catch (e) { return planError(reply, e); }
  });

  // ---------- WebSocket collecteurs ----------

  app.register(async (scope) => {
    scope.get('/ws/collector', { websocket: true }, (socket: WebSocket, req: FastifyRequest) => {
      const auth = req.headers.authorization ?? '';
      const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
      const machine = token ? store.machineByTokenHash(sha256(token)) : null;
      if (!machine) { socket.close(4001, 'non autorisé'); return; }
      const machineId = machine.id;
      // Une seule connexion par machine : la plus récente gagne.
      collectors.get(machineId)?.close(4000, 'remplacée');
      collectors.set(machineId, socket);
      let helloDone = false;
      const send = (m: ServerToCollector) => socket.send(JSON.stringify(m));

      socket.on('message', (raw: Buffer) => {
        let parsed;
        try { parsed = CollectorToServer.safeParse(JSON.parse(raw.toString())); } catch { return; }
        if (!parsed.success) { app.log.warn({ issues: parsed.error.issues.slice(0, 3) }, 'message collecteur invalide'); return; }
        const msg = parsed.data;
        if (msg.t === 'hello') {
          if (msg.machineId !== machineId) { socket.close(4002, 'identité incohérente'); return; }
          helloDone = true;
          store.updateMachineHello(machineId, msg.hostname, msg.platform, msg.collectorVersion, msg.capabilities);
          store.setOnline(machineId, true);
          const ack = (opts.db.prepare('SELECT ack_seq FROM machines WHERE id = ?').get(machineId) as { ack_seq: number }).ack_seq;
          send({ t: 'welcome', ackSeq: ack });
          audit(opts.db, `machine:${machineId}`, 'collector.connected', machineId, { ip: req.ip, version: msg.collectorVersion }, req.ip);
          return;
        }
        if (!helloDone) return;
        if (msg.t === 'events') {
          const seq = store.ingest(machineId, msg.events);
          if (seq) send({ t: 'ack', seq });
        } else if (msg.t === 'cmd.result') {
          commands.onResult(machineId, msg.commandId, msg.ok, msg.result, msg.error);
        } else if (msg.t === 'ping') {
          send({ t: 'pong' });
        }
      });
      socket.on('close', () => {
        if (collectors.get(machineId) !== socket) return;
        collectors.delete(machineId);
        store.setOnline(machineId, false);
        commands.onDisconnect(machineId);
      });
    });

    // ---------- WebSocket interface ----------
    scope.get('/ws/ui', { websocket: true }, (socket: WebSocket, req: FastifyRequest) => {
      const origin = req.headers.origin;
      const host = req.headers.host;
      if (!req.user || (origin && host && new URL(origin).host !== host)) { socket.close(4001, 'non autorisé'); return; }
      const send = (m: ServerToUi) => { if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(m)); };
      send({ t: 'hello', serverTime: Date.now() });
      const unsubscribe = store.subscribe(send);
      const ping = setInterval(() => socket.ping(), 25_000);
      socket.on('close', () => { unsubscribe(); clearInterval(ping); });
    });
  });

  // ---------- Interface web ----------
  if (opts.webDist && existsSync(opts.webDist)) {
    await app.register(fastifyStatic, { root: opts.webDist, wildcard: false });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api/') || req.url.startsWith('/ws/')) return reply.code(404).send({ error: 'Introuvable' });
      return reply.sendFile('index.html');
    });
  }

  return { app, store, commands, orchestrator };
}
