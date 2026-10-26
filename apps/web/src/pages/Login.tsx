import { useState, type FormEvent } from 'react';
import { ArrowRight, Lock } from 'lucide-react';
import { api } from '../lib/api.ts';
import { Spinner } from '../components/ui.tsx';

export function Login({ onLogin }: { onLogin: (u: string) => void }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ username: string }>('/api/login', { method: 'POST', body: { username, password } });
      onLogin(r.username);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="h-full grid place-items-center bg-grid px-4">
      <div className="absolute inset-0 pointer-events-none" style={{ background: 'radial-gradient(600px circle at 50% 30%, #d9775714, transparent 60%)' }} />
      <form onSubmit={submit} className="relative w-full max-w-[340px] animate-slide-up">
        <div className="flex flex-col items-center mb-8">
          <img src="/icon.svg" alt="" className="h-11 w-11 mb-4" />
          <h1 className="text-[18px] font-semibold tracking-[-0.015em]">Agent Command Center</h1>
          <p className="text-[12.5px] text-muted mt-1">Supervision des sessions Claude Code</p>
        </div>
        <div className="rounded-xl border border-line bg-panel/90 backdrop-blur p-1.5 shadow-2xl shadow-black/40">
          <input
            autoFocus autoComplete="username" placeholder="Utilisateur" value={username} onChange={(e) => setUsername(e.target.value)}
            className="w-full h-10 rounded-lg bg-transparent px-3 text-[13.5px] outline-none placeholder:text-faint focus:bg-raised transition-colors"
          />
          <div className="h-px bg-line mx-2" />
          <input
            type="password" autoComplete="current-password" placeholder="Mot de passe" value={password} onChange={(e) => setPassword(e.target.value)}
            className="w-full h-10 rounded-lg bg-transparent px-3 text-[13.5px] outline-none placeholder:text-faint focus:bg-raised transition-colors"
          />
        </div>
        {error && <p className="mt-3 text-[12.5px] text-error text-center animate-fade-in">{error}</p>}
        <button disabled={busy || !username || !password} className="mt-4 w-full h-10 rounded-lg bg-fg text-bg text-[13.5px] font-medium flex items-center justify-center gap-2 hover:bg-white transition-colors disabled:opacity-40">
          {busy ? <Spinner /> : <>Se connecter <ArrowRight size={15} /></>}
        </button>
        <p className="mt-6 flex items-center justify-center gap-1.5 text-[11px] text-faint"><Lock size={11} /> Accès réservé au réseau Tailscale</p>
      </form>
    </div>
  );
}
