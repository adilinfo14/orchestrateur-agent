#!/usr/bin/env node
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { parseArgs } from 'node:util';
import {
  accDir, claudeConfigDir, COLLECTOR_VERSION, configPath, DEFAULT_HOOK_PORT, detectPlatform, loadConfig, machineHostname, newSecret, saveConfig,
  type CollectorConfig,
} from './config.ts';
import { Outbox } from './outbox.ts';
import { startHookServer, type HookChannel } from './hook-server.ts';
import { RegistryWatcher } from './registry.ts';
import { AgentsCliWatcher } from './agents-cli.ts';
import { SdkSessions } from './sdk-sessions.ts';
import { Uplink } from './uplink.ts';
import { createCommandHandler } from './commands.ts';
import { installHooks, uninstallHooks } from './install-hooks.ts';

const log = (m: string) => console.log(`${new Date().toISOString()} [collecteur] ${m}`);

async function enroll(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: { server: { type: 'string' }, code: { type: 'string' }, name: { type: 'string' }, 'allow-root': { type: 'string', multiple: true } },
  });
  if (!values.server || !values.code) throw new Error('Usage : acc-collector enroll --server http://<hôte>:7820 --code XXXX-XXXX [--name "Mac"] [--allow-root ~/projets]');
  const platform = detectPlatform();
  const res = await fetch(values.server.replace(/\/$/, '') + '/api/enroll', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: values.code.trim(), name: values.name ?? machineHostname(), hostname: machineHostname(), platform }),
  });
  const body = (await res.json().catch(() => ({}))) as { machineId?: string; token?: string; error?: string };
  if (!res.ok || !body.machineId || !body.token) throw new Error(`Inscription refusée : ${body.error ?? res.status}`);
  const cfg: CollectorConfig = {
    serverUrl: values.server.replace(/\/$/, ''),
    machineId: body.machineId,
    machineToken: body.token,
    localToken: newSecret(),
    hookPort: DEFAULT_HOOK_PORT,
    allowedRoots: (values['allow-root'] ?? []).map((r) => resolve(r.replace(/^~(?=$|[\\/])/, homedir()))),
    allowSend: true,
    allowSpawn: true,
    allowPermissionRelay: true,
    useSessionRegistry: true,
    socketSendAuthToken: true,
    claudePath: null,
  };
  saveConfig(cfg);
  console.log(`Machine inscrite (${body.machineId}). Configuration : ${configPath()}`);
  console.log('Étape suivante : acc-collector install-hooks, puis acc-collector run');
}

async function run(): Promise<void> {
  const cfg = loadConfig();
  mkdirSync(accDir(), { recursive: true, mode: 0o700 });
  const platform = detectPlatform();
  const outbox = new Outbox(join(accDir(), 'outbox.db'), cfg.machineId);
  const channels = new Map<string, HookChannel>();

  const emit = outbox.append.bind(outbox);
  const sdk = new SdkSessions(emit, log, { relayPermissions: cfg.allowPermissionRelay, claudePath: cfg.claudePath });

  await startHookServer({
    port: cfg.hookPort,
    localToken: cfg.localToken,
    log,
    onEvent: (e) => {
      if (e.type === 'SessionEnd' && e.sessionId) channels.delete(e.sessionId);
      emit(e);
    },
    onChannel: (sessionId, ch) => {
      const prev = channels.get(sessionId);
      channels.set(sessionId, ch);
      // Seule l'existence du canal est remontée ; le chemin et le jeton restent sur la machine.
      if (!prev || prev.socket !== ch.socket) emit({ source: 'collector', type: 'SessionChannel', sessionId, data: { send: 'socket', authenticated: !!ch.token } });
    },
  });
  log(`hooks : écoute sur http://127.0.0.1:${cfg.hookPort}/hook`);

  const registry = cfg.useSessionRegistry ? new RegistryWatcher(join(claudeConfigDir(), 'sessions'), emit) : null;
  registry?.start();

  const agents = new AgentsCliWatcher(cfg.claudePath ?? 'claude', emit, log);
  await agents.probe();
  agents.start();

  const handle = createCommandHandler(cfg, sdk, channels);
  const uplink = new Uplink({
    serverUrl: cfg.serverUrl,
    machineId: cfg.machineId,
    machineToken: cfg.machineToken,
    hostname: machineHostname(),
    platform,
    version: COLLECTOR_VERSION,
    outbox,
    log,
    capabilities: () => ({
      hooks: true,
      sdkSpawn: cfg.allowSpawn && cfg.allowedRoots.length > 0,
      socketSend: cfg.allowSend,
      agentsCli: agents.available,
      registry: !!registry,
      allowedRoots: cfg.allowedRoots,
    }),
    onCommand: async (commandId, payload) => {
      log(`commande ${commandId} : ${payload.type}`);
      return handle(payload);
    },
  });
  uplink.start();
  emit({ source: 'collector', type: 'CollectorStarted', sessionId: null, data: { version: COLLECTOR_VERSION, platform, pending: outbox.size() } });

  setInterval(() => {
    const dropped = outbox.enforceCap();
    if (dropped) log(`journal d'envoi plein : ${dropped} anciens événements supprimés`);
  }, 60_000).unref();

  const shutdown = () => {
    log('arrêt');
    sdk.stopAll();
    uplink.stop();
    registry?.stop();
    agents.stop();
    outbox.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);
  switch (cmd) {
    case 'enroll': return enroll(rest);
    case 'run': return run();
    case 'install-hooks': {
      const cfg = loadConfig();
      console.log(`Hooks ajoutés (sauvegarde créée à côté) : ${installHooks(cfg.hookPort, cfg.localToken)}`);
      console.log('Claude Code recharge généralement les réglages à chaud ; sinon, redémarrez les sessions ouvertes.');
      return;
    }
    case 'uninstall-hooks':
      console.log(`Hooks retirés : ${uninstallHooks()}`);
      return;
    case 'allow-root': {
      const cfg = loadConfig();
      const root = rest[0];
      if (!root) throw new Error('Usage : acc-collector allow-root <dossier>');
      const abs = resolve(root.replace(/^~(?=$|[\\/])/, homedir()));
      if (!cfg.allowedRoots.includes(abs)) cfg.allowedRoots.push(abs);
      saveConfig(cfg);
      console.log(`Racines autorisées : ${cfg.allowedRoots.join(', ')}`);
      return;
    }
    case 'status': {
      const cfg = loadConfig();
      console.log(JSON.stringify({ ...cfg, machineToken: '***', localToken: '***' }, null, 2));
      return;
    }
    default:
      console.log('acc-collector <enroll|install-hooks|uninstall-hooks|allow-root|run|status>');
  }
}

main().catch((e: Error) => { console.error(e.message); process.exit(1); });
