import { useState } from 'react';
import { Check, Copy, Plus, Server, ShieldOff, Trash2 } from 'lucide-react';
import type { MachineView } from '../../../../packages/protocol/src/index.ts';
import { api } from '../lib/api.ts';
import { ago, cx, PLATFORM_LABEL, useNow } from '../lib/format.ts';
import { useLive } from '../lib/live.ts';
import { useDialogs } from '../components/dialogs.tsx';
import { Badge, Button, Empty, PageHeader, Panel } from '../components/ui.tsx';

function CopyBlock({ label, text }: { label: string; text: string }) {
  const [done, setDone] = useState(false);
  return (
    <div>
      <div className="text-[11px] text-faint mb-1">{label}</div>
      <div className="group relative rounded-lg border border-line bg-bg">
        <pre className="mono text-[11.5px] text-fg/90 p-3 pr-10 whitespace-pre-wrap break-all">{text}</pre>
        <button onClick={() => { void navigator.clipboard.writeText(text); setDone(true); setTimeout(() => setDone(false), 1500); }}
          className="absolute top-2 right-2 p-1.5 rounded-md text-faint hover:text-fg hover:bg-hover" aria-label="Copier">
          {done ? <Check size={13} className="text-ok" /> : <Copy size={13} />}
        </button>
      </div>
    </div>
  );
}

function Capability({ on, label }: { on: boolean | undefined; label: string }) {
  return <Badge tone={on ? 'ok' : 'neutral'}>{label}</Badge>;
}

function MachineRow({ m }: { m: MachineView }) {
  const now = useNow(10000);
  const { confirm, toast } = useDialogs();
  const sessions = useLive((s) => [...s.sessions.values()].filter((x) => x.machineId === m.id && x.status !== 'ended').length);
  const c = m.capabilities;

  const toggleControl = async () => {
    const ok = await confirm({
      title: m.allowControl ? `Désactiver le pilotage de ${m.name} ?` : `Activer le pilotage de ${m.name} ?`,
      body: m.allowControl ? 'La machine restera observée, mais aucune commande ne lui sera transmise.' : 'Les commandes autorisées par la configuration locale du collecteur pourront être transmises.',
      danger: m.allowControl,
    });
    if (!ok) return;
    try { await api(`/api/machines/${m.id}`, { method: 'PATCH', body: { allowControl: !m.allowControl, confirmed: true } }); }
    catch (e) { toast('error', (e as Error).message); }
  };

  const revoke = async () => {
    const ok = await confirm({ title: `Révoquer ${m.name} ?`, body: 'Son jeton sera invalidé immédiatement. Il faudra réinscrire le collecteur avec un nouveau code.', confirmLabel: 'Révoquer', danger: true });
    if (!ok) return;
    try { await api(`/api/machines/${m.id}/revoke`, { method: 'POST', body: { confirmed: true } }); toast('ok', 'Machine révoquée'); location.reload(); }
    catch (e) { toast('error', (e as Error).message); }
  };

  return (
    <div className="p-4 border-b border-line last:border-0">
      <div className="flex flex-wrap items-center gap-3">
        <span className={cx('h-2 w-2 rounded-full', m.online ? 'bg-ok' : 'bg-error')} />
        <div className="min-w-0">
          <div className="text-[13.5px] font-medium">{m.name}</div>
          <div className="text-[11.5px] text-faint">{m.hostname ?? '—'} · {m.platform ? PLATFORM_LABEL[m.platform] : 'plateforme inconnue'} · collecteur {m.collectorVersion ?? '?'} · {m.online ? 'connecté' : `vu ${ago(m.lastSeenAt, now)}`}</div>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <span className="text-[11.5px] text-muted tabular">{sessions} session{sessions > 1 ? 's' : ''}</span>
          <Button size="sm" variant={m.allowControl ? 'subtle' : 'primary'} onClick={toggleControl}><ShieldOff size={13} />{m.allowControl ? 'Désactiver le pilotage' : 'Activer le pilotage'}</Button>
          <Button size="sm" variant="ghost" onClick={revoke} aria-label="Révoquer"><Trash2 size={13} /></Button>
        </div>
      </div>
      {c && (
        <div className="mt-3 flex flex-wrap gap-1.5 pl-5">
          <Capability on={c.hooks} label="Hooks" />
          <Capability on={c.socketSend} label="Envoi via inbox socket" />
          <Capability on={c.sdkSpawn} label="Lancement (Agent SDK)" />
          <Capability on={c.agentsCli} label="claude agents" />
          <Capability on={c.registry} label="Registre local" />
          {c.allowedRoots.length > 0 && <span className="text-[11px] text-faint mono ml-1">racines : {c.allowedRoots.join(', ')}</span>}
        </div>
      )}
    </div>
  );
}

export function Machines() {
  const machines = useLive((s) => s.machines);
  const { toast } = useDialogs();
  const [code, setCode] = useState<string | null>(null);
  const server = location.origin;

  const newCode = async () => {
    try { setCode((await api<{ code: string }>('/api/enroll-codes', { method: 'POST' })).code); }
    catch (e) { toast('error', (e as Error).message); }
  };

  return (
    <div className="p-4 md:p-6 max-w-[1100px] mx-auto space-y-5">
      <PageHeader title="Machines" subtitle="Collecteurs inscrits, capacités annoncées et droits de pilotage" actions={<Button variant="primary" onClick={newCode}><Plus size={14} /> Ajouter une machine</Button>} />

      {code && (
        <Panel title="Inscrire un collecteur" bodyClass="p-4 space-y-4 animate-fade-in">
          <p className="text-[12.5px] text-muted">Code à usage unique, valable 15 minutes : <span className="mono text-fg text-[14px] font-semibold tracking-wider">{code}</span></p>
          <CopyBlock label="macOS / Linux / WSL — depuis le dossier du dépôt" text={`npm install\nnode apps/collector/src/cli.ts enroll --server ${server} --code ${code} --name "$(hostname -s)" --allow-root ~/projets\nnode apps/collector/src/cli.ts install-hooks\nnode apps/collector/src/cli.ts run`} />
          <CopyBlock label="Windows (PowerShell) — depuis le dossier du dépôt" text={`npm install\nnode apps\\collector\\src\\cli.ts enroll --server ${server} --code ${code} --name $env:COMPUTERNAME --allow-root $HOME\\projets\nnode apps\\collector\\src\\cli.ts install-hooks\nnode apps\\collector\\src\\cli.ts run`} />
          <p className="text-[11.5px] text-faint">Voir docs/INSTALLATION.md pour l’installation en service (launchd, tâche planifiée Windows, systemd dans WSL).</p>
        </Panel>
      )}

      <Panel title={`${machines.size} machine${machines.size > 1 ? 's' : ''}`}>
        {machines.size ? [...machines.values()].map((m) => <MachineRow key={m.id} m={m} />) : (
          <Empty icon={<Server size={26} />} title="Aucune machine inscrite">Cliquez sur « Ajouter une machine » pour générer un code d’inscription.</Empty>
        )}
      </Panel>
    </div>
  );
}
