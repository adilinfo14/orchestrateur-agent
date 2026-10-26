import { useEffect, useState } from 'react';
import type { SessionStatus } from '../../../../packages/protocol/src/index.ts';

export function useNow(intervalMs = 5000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), intervalMs); return () => clearInterval(t); }, [intervalMs]);
  return now;
}

export function ago(ts: number | null | undefined, now: number): string {
  if (!ts) return '—';
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 5) return 'à l’instant';
  if (s < 60) return `il y a ${s} s`;
  const m = Math.round(s / 60);
  if (m < 60) return `il y a ${m} min`;
  const h = Math.round(m / 60);
  if (h < 24) return `il y a ${h} h`;
  return `il y a ${Math.round(h / 24)} j`;
}

export function clock(ts: number): string {
  return new Date(ts).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export function dayLabel(ts: number): string {
  const d = new Date(ts);
  const today = new Date();
  const y = new Date(); y.setDate(today.getDate() - 1);
  if (d.toDateString() === today.toDateString()) return 'Aujourd’hui';
  if (d.toDateString() === y.toDateString()) return 'Hier';
  return d.toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' });
}

export const STATUS: Record<SessionStatus, { label: string; color: string; text: string }> = {
  working: { label: 'Active', color: 'bg-working', text: 'text-working' },
  waiting: { label: 'En attente', color: 'bg-waiting', text: 'text-waiting' },
  idle: { label: 'Inactive', color: 'bg-idle', text: 'text-muted' },
  error: { label: 'Erreur', color: 'bg-error', text: 'text-error' },
  ended: { label: 'Terminée', color: 'bg-ended', text: 'text-faint' },
  unknown: { label: 'Inconnu', color: 'bg-idle', text: 'text-faint' },
};

export const PLATFORM_LABEL: Record<string, string> = { darwin: 'macOS', win32: 'Windows', linux: 'Linux', wsl: 'WSL' };

export const SOURCE_LABEL: Record<string, string> = {
  hook: 'Hooks Claude Code', sdk: 'Agent SDK', registry: 'Registre local (non documenté)', 'agents-cli': 'claude agents', collector: 'Collecteur',
};

export function shortPath(p: string | null | undefined, keep = 3): string {
  if (!p) return '';
  const parts = p.split(/[\\/]+/).filter(Boolean);
  return parts.length <= keep ? p : '…/' + parts.slice(-keep).join('/');
}

export function cx(...c: (string | false | null | undefined)[]): string {
  return c.filter(Boolean).join(' ');
}
