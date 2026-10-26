import WebSocket from 'ws';
import { PROTOCOL_VERSION, type CollectorCapabilities, type CommandPayload, type Platform, type ServerToCollector } from '../../../packages/protocol/src/index.ts';
import type { Outbox } from './outbox.ts';

export interface UplinkOptions {
  serverUrl: string;
  machineId: string;
  machineToken: string;
  hostname: string;
  platform: Platform;
  version: string;
  capabilities: () => CollectorCapabilities;
  outbox: Outbox;
  onCommand: (commandId: string, payload: CommandPayload) => Promise<unknown>;
  log: (m: string) => void;
}

const BATCH = 200;

/**
 * Lien sortant collecteur -> serveur (WebSocket). Reconnexion avec backoff exponentiel,
 * reprise exacte depuis le dernier numéro de séquence acquitté par le serveur.
 */
export class Uplink {
  private ws: WebSocket | null = null;
  private acked = 0;
  private inflightUpTo = 0;
  private ready = false;
  private backoff = 1000;
  private stopped = false;
  private heartbeat: NodeJS.Timeout | null = null;
  private lastPong = 0;

  private o: UplinkOptions;

  constructor(o: UplinkOptions) {
    this.o = o;
    o.outbox.onAppend(() => this.flush());
  }

  get connected(): boolean { return this.ready; }

  start(): void { this.connect(); }

  stop(): void {
    this.stopped = true;
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.ws?.close();
  }

  private connect(): void {
    if (this.stopped) return;
    const url = this.o.serverUrl.replace(/^http/, 'ws').replace(/\/$/, '') + '/ws/collector';
    const ws = new WebSocket(url, { headers: { authorization: `Bearer ${this.o.machineToken}` }, handshakeTimeout: 10000 });
    this.ws = ws;
    ws.on('open', () => {
      this.o.log(`connecté à ${url}`);
      this.backoff = 1000;
      this.lastPong = Date.now();
      this.send({ t: 'hello', protocol: PROTOCOL_VERSION, machineId: this.o.machineId, hostname: this.o.hostname, platform: this.o.platform, collectorVersion: this.o.version, capabilities: this.o.capabilities() });
      this.heartbeat = setInterval(() => {
        if (Date.now() - this.lastPong > 45000) { this.o.log('serveur muet, reconnexion'); ws.terminate(); return; }
        this.send({ t: 'ping' });
      }, 15000);
    });
    ws.on('message', (raw) => {
      let msg: ServerToCollector;
      try { msg = JSON.parse(raw.toString()) as ServerToCollector; } catch { return; }
      this.lastPong = Date.now();
      if (msg.t === 'welcome') {
        this.acked = msg.ackSeq;
        this.o.outbox.ackUpTo(msg.ackSeq);
        this.inflightUpTo = msg.ackSeq;
        this.ready = true;
        this.flush();
      } else if (msg.t === 'ack') {
        this.acked = Math.max(this.acked, msg.seq);
        this.o.outbox.ackUpTo(this.acked);
        this.flush();
      } else if (msg.t === 'cmd') {
        this.o.onCommand(msg.commandId, msg.payload).then(
          (result) => this.send({ t: 'cmd.result', commandId: msg.commandId, ok: true, result: result ?? null }),
          (err: Error) => this.send({ t: 'cmd.result', commandId: msg.commandId, ok: false, error: err.message.slice(0, 4000) }),
        );
      }
    });
    ws.on('close', (code, reason) => {
      this.ready = false;
      if (this.heartbeat) clearInterval(this.heartbeat);
      if (this.stopped) return;
      const delay = Math.min(this.backoff, 30000) * (0.75 + Math.random() * 0.5);
      this.o.log(`déconnecté (${code}${reason.length ? ' ' + reason.toString() : ''}), nouvel essai dans ${Math.round(delay / 1000)} s`);
      this.backoff = Math.min(this.backoff * 2, 30000);
      setTimeout(() => this.connect(), delay);
    });
    ws.on('error', (err) => this.o.log(`erreur WebSocket : ${err.message}`));
  }

  private send(msg: unknown): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  /** Envoie le lot suivant quand le précédent est acquitté (une fenêtre à la fois). */
  private flush(): void {
    if (!this.ready || this.inflightUpTo > this.acked) return;
    const batch = this.o.outbox.pending(this.acked, BATCH);
    if (!batch.length) return;
    this.inflightUpTo = batch[batch.length - 1]!.seq;
    this.send({ t: 'events', events: batch });
  }
}
