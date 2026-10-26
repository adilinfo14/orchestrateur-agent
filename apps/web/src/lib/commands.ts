import type { CommandPayload, CommandRecord } from '../../../../packages/protocol/src/index.ts';
import { api } from './api.ts';
import { upsertCommand } from './live.ts';

export async function sendCommand(machineId: string, payload: CommandPayload, confirmed = false): Promise<CommandRecord> {
  const c = await api<CommandRecord>('/api/commands', { method: 'POST', body: { idempotencyKey: crypto.randomUUID(), machineId, confirmed, payload } });
  upsertCommand(c);
  return c;
}

export const COMMAND_LABEL: Record<CommandPayload['type'], string> = {
  'session.send': 'Instruction',
  'session.interrupt': 'Interruption',
  'session.stop': 'Arrêt',
  'session.spawn': 'Lancement',
  'permission.respond': 'Autorisation',
};
