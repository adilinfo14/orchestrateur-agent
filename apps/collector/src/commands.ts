import { existsSync, statSync } from 'node:fs';
import type { CommandPayload } from '../../../packages/protocol/src/index.ts';
import { isUnderAllowedRoot, type CollectorConfig } from './config.ts';
import type { HookChannel } from './hook-server.ts';
import type { SdkSessions } from './sdk-sessions.ts';
import { sendViaSocket } from './socket-send.ts';

export const SEND_PREFIX = '[Agent Command Center] ';

/**
 * Exécution locale des commandes reçues du serveur. La politique locale (config du collecteur)
 * prévaut toujours : le serveur ne peut pas élargir ce que la machine autorise.
 */
export function createCommandHandler(cfg: CollectorConfig, sdk: SdkSessions, channels: Map<string, HookChannel>) {
  return async (payload: CommandPayload): Promise<unknown> => {
    switch (payload.type) {
      case 'session.send': {
        if (!cfg.allowSend) throw new Error('Envoi d’instructions désactivé sur cette machine');
        if (sdk.has(payload.sessionId)) { sdk.send(payload.sessionId, payload.text); return { via: 'sdk' }; }
        const ch = channels.get(payload.sessionId);
        if (!ch) throw new Error('Aucun canal supporté pour cette session (ni SDK, ni inbox socket connu)');
        await sendViaSocket(ch.socket, cfg.socketSendAuthToken ? ch.token : null, SEND_PREFIX + payload.text);
        return { via: 'socket', note: 'Déposé dans l’inbox ; la session applique ses propres contrôles d’entrée.' };
      }
      case 'session.interrupt':
        await sdk.interrupt(payload.sessionId);
        return { via: 'sdk' };
      case 'session.stop':
        sdk.stop(payload.sessionId);
        return { via: 'sdk' };
      case 'session.spawn': {
        if (!cfg.allowSpawn) throw new Error('Lancement de sessions désactivé sur cette machine');
        if (!isUnderAllowedRoot(payload.cwd, cfg.allowedRoots)) throw new Error(`Dossier hors des racines autorisées : ${payload.cwd}`);
        if (!existsSync(payload.cwd) || !statSync(payload.cwd).isDirectory()) throw new Error(`Dossier introuvable : ${payload.cwd}`);
        return sdk.spawn({ cwd: payload.cwd, prompt: payload.prompt, permissionMode: payload.permissionMode, model: payload.model });
      }
      case 'permission.respond':
        if (!cfg.allowPermissionRelay) throw new Error('Relais des autorisations désactivé sur cette machine');
        sdk.respondPermission(payload.sessionId, payload.requestId, payload.decision, payload.message);
        return { decision: payload.decision };
    }
  };
}
