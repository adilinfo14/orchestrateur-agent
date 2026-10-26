import { createServer, type Server } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { normalizeHook } from './normalize.ts';
import type { NewEvent } from './outbox.ts';

export interface HookChannel {
  socket: string;
  token: string | null;
}

export interface HookServerOptions {
  port: number;
  localToken: string;
  onEvent: (e: NewEvent) => void;
  /** Appelé quand un hook révèle l'inbox socket d'une session (variables exportées par Claude Code). */
  onChannel: (sessionId: string, channel: HookChannel) => void;
  log: (msg: string) => void;
}

const MAX_BODY = 1_000_000;

function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a), bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

/**
 * Récepteur des hooks HTTP Claude Code, en écoute sur 127.0.0.1 uniquement.
 * Répond toujours 200 avec un corps vide : le collecteur n'influence jamais une décision
 * de Claude Code (pas d'autorisation, pas de blocage).
 */
export function startHookServer(opts: HookServerOptions): Promise<Server> {
  const server = createServer((req, res) => {
    const done = (code: number) => { res.writeHead(code).end(); };
    if (req.method !== 'POST' || !req.url?.startsWith('/hook')) return done(404);
    const token = req.headers['x-acc-token'];
    if (typeof token !== 'string' || !safeEqual(token, opts.localToken)) return done(401);
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) { req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      done(200);
      let body: unknown;
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { opts.log('hook: JSON invalide ignoré'); return; }
      const ev = normalizeHook(body);
      if (!ev) return;
      const socket = req.headers['x-acc-socket'];
      const msgToken = req.headers['x-acc-msg-token'];
      if (ev.sessionId && typeof socket === 'string' && socket.length > 0) {
        opts.onChannel(ev.sessionId, { socket, token: typeof msgToken === 'string' && msgToken.length > 0 ? msgToken : null });
      }
      opts.onEvent(ev);
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port, '127.0.0.1', () => resolve(server));
  });
}
