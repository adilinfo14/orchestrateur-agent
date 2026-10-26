import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { claudeConfigDir } from './config.ts';

/** Événements remontés. Choisis parmi les hooks documentés de Claude Code. */
export const HOOK_EVENTS = [
  'SessionStart', 'SessionEnd', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure',
  'PermissionRequest', 'PermissionDenied', 'Notification', 'SubagentStart', 'SubagentStop', 'Stop',
  'StopFailure', 'PreCompact', 'TaskCreated', 'TaskCompleted', 'CwdChanged',
] as const;

const MARK = 'acc=1';

type HookEntry = { type: string; url?: string; [k: string]: unknown };
type Matcher = { matcher?: string; hooks: HookEntry[] };
type Settings = { hooks?: Record<string, Matcher[]>; [k: string]: unknown };

export function hookEntry(port: number, localToken: string): HookEntry {
  return {
    type: 'http',
    url: `http://127.0.0.1:${port}/hook?${MARK}`,
    timeout: 5,
    headers: {
      'X-ACC-Token': localToken,
      // Variables documentées, exportées par Claude Code aux hooks : permettent au collecteur
      // de déposer des instructions dans l'inbox de la session. Elles ne quittent jamais la machine.
      'X-ACC-Socket': '$CLAUDE_CODE_MESSAGING_SOCKET',
      'X-ACC-Msg-Token': '$CLAUDE_CODE_MESSAGING_TOKEN',
    },
    allowedEnvVars: ['CLAUDE_CODE_MESSAGING_SOCKET', 'CLAUDE_CODE_MESSAGING_TOKEN'],
  };
}

const isOurs = (h: HookEntry) => h.type === 'http' && typeof h.url === 'string' && h.url.includes(MARK);

/** Retire nos entrées (et les groupes devenus vides), sans toucher aux autres hooks. */
export function removeOurHooks(settings: Settings): Settings {
  const out: Settings = { ...settings };
  if (!out.hooks) return out;
  const hooks: Record<string, Matcher[]> = {};
  for (const [event, matchers] of Object.entries(out.hooks)) {
    const kept = matchers.map((m) => ({ ...m, hooks: m.hooks.filter((h) => !isOurs(h)) })).filter((m) => m.hooks.length > 0);
    if (kept.length) hooks[event] = kept;
  }
  if (Object.keys(hooks).length) out.hooks = hooks; else delete out.hooks;
  return out;
}

export function addOurHooks(settings: Settings, port: number, localToken: string): Settings {
  const out = removeOurHooks(settings);
  const hooks = { ...(out.hooks ?? {}) };
  for (const ev of HOOK_EVENTS) hooks[ev] = [...(hooks[ev] ?? []), { hooks: [hookEntry(port, localToken)] }];
  return { ...out, hooks };
}

function settingsPath(): string { return join(claudeConfigDir(), 'settings.json'); }

function edit(fn: (s: Settings) => Settings): string {
  const p = settingsPath();
  const current: Settings = existsSync(p) ? (JSON.parse(readFileSync(p, 'utf8')) as Settings) : {};
  if (existsSync(p)) copyFileSync(p, `${p}.acc-backup-${Date.now()}`);
  writeFileSync(p, JSON.stringify(fn(current), null, 2) + '\n', { mode: 0o600 });
  return p;
}

export function installHooks(port: number, localToken: string): string { return edit((s) => addOurHooks(s, port, localToken)); }
export function uninstallHooks(): string { return edit(removeOurHooks); }
