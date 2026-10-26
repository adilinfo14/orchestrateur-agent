import { useEffect, useState } from 'react';
import { ScrollText } from 'lucide-react';
import { api } from '../lib/api.ts';
import { cx } from '../lib/format.ts';
import { Empty, PageHeader, Panel, Spinner } from '../components/ui.tsx';

interface Row { id: number; ts: number; actor: string; action: string; target: string | null; detail: string | null; ip: string | null }

const tone = (a: string) => (a.includes('failed') || a.includes('rejected') || a.includes('error') || a.includes('revoked') ? 'text-error' : a.includes('timeout') ? 'text-waiting' : a.endsWith('.ok') ? 'text-ok' : 'text-fg');

export function Audit() {
  const [rows, setRows] = useState<Row[] | null>(null);
  useEffect(() => { api<Row[]>('/api/audit').then(setRows, () => setRows([])); }, []);
  return (
    <div className="p-4 md:p-6 max-w-[1200px] mx-auto">
      <PageHeader title="Journal d’audit" subtitle="Connexions, inscriptions, commandes et changements de droits (300 dernières entrées)" />
      <Panel bodyClass="overflow-x-auto">
        {!rows ? <div className="py-10 grid place-items-center text-faint"><Spinner /></div> : rows.length === 0 ? <Empty icon={<ScrollText size={24} />} title="Journal vide" /> : (
          <table className="w-full text-[12px]">
            <thead><tr className="text-left text-[11px] text-faint uppercase tracking-wider border-b border-line">
              <th className="px-4 py-2 font-medium">Date</th><th className="px-4 py-2 font-medium">Acteur</th><th className="px-4 py-2 font-medium">Action</th><th className="px-4 py-2 font-medium">Détail</th><th className="px-4 py-2 font-medium">IP</th>
            </tr></thead>
            <tbody>{rows.map((r) => (
              <tr key={r.id} className="border-b border-line last:border-0 hover:bg-hover/50">
                <td className="px-4 py-2 mono tabular text-faint whitespace-nowrap">{new Date(r.ts).toLocaleString('fr-FR')}</td>
                <td className="px-4 py-2 truncate max-w-[140px]">{r.actor}</td>
                <td className={cx('px-4 py-2 mono whitespace-nowrap', tone(r.action))}>{r.action}</td>
                <td className="px-4 py-2 mono text-muted truncate max-w-[420px]" title={r.detail ?? ''}>{r.detail}</td>
                <td className="px-4 py-2 mono text-faint">{r.ip}</td>
              </tr>
            ))}</tbody>
          </table>
        )}
      </Panel>
    </div>
  );
}
