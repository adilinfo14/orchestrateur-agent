import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { AlertTriangle, CheckCircle2, Info, XCircle } from 'lucide-react';
import { Button } from './ui.tsx';
import { cx } from '../lib/format.ts';

interface ConfirmOpts { title: string; body?: ReactNode; confirmLabel?: string; danger?: boolean }
type Toast = { id: number; tone: 'ok' | 'error' | 'info'; text: string };

const Ctx = createContext<{ confirm: (o: ConfirmOpts) => Promise<boolean>; toast: (tone: Toast['tone'], text: string) => void } | null>(null);

export function useDialogs() {
  const c = useContext(Ctx);
  if (!c) throw new Error('DialogProvider manquant');
  return c;
}

export function DialogProvider({ children }: { children: ReactNode }) {
  const [pending, setPending] = useState<(ConfirmOpts & { resolve: (v: boolean) => void }) | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const btn = useRef<HTMLButtonElement>(null);

  const confirm = useCallback((o: ConfirmOpts) => new Promise<boolean>((resolve) => setPending({ ...o, resolve })), []);
  const toast = useCallback((tone: Toast['tone'], text: string) => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t.slice(-3), { id, tone, text }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), tone === 'error' ? 7000 : 4000);
  }, []);

  const close = (v: boolean) => { pending?.resolve(v); setPending(null); };

  useEffect(() => {
    if (!pending) return;
    btn.current?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  return (
    <Ctx.Provider value={{ confirm, toast }}>
      {children}
      {pending && (
        <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/60 backdrop-blur-[2px] animate-fade-in p-4" onMouseDown={() => close(false)}>
          <div role="dialog" aria-modal className="w-full max-w-md rounded-xl border border-line-strong bg-panel shadow-2xl shadow-black/60 animate-slide-up" onMouseDown={(e) => e.stopPropagation()}>
            <div className="p-5">
              <div className="flex items-start gap-3">
                <div className={cx('mt-0.5 rounded-lg p-1.5', pending.danger ? 'bg-error/10 text-error' : 'bg-waiting/10 text-waiting')}><AlertTriangle size={16} /></div>
                <div className="min-w-0">
                  <h3 className="text-[14px] font-semibold">{pending.title}</h3>
                  {pending.body && <div className="mt-1.5 text-[12.5px] text-muted leading-relaxed">{pending.body}</div>}
                </div>
              </div>
            </div>
            <div className="flex justify-end gap-2 border-t border-line px-5 py-3">
              <Button variant="ghost" onClick={() => close(false)}>Annuler</Button>
              <Button ref={btn} variant={pending.danger ? 'danger' : 'primary'} onClick={() => close(true)}>{pending.confirmLabel ?? 'Confirmer'}</Button>
            </div>
          </div>
        </div>
      )}
      <div className="fixed z-50 bottom-20 sm:bottom-4 right-4 left-4 sm:left-auto flex flex-col gap-2 items-end pointer-events-none">
        {toasts.map((t) => (
          <div key={t.id} className="pointer-events-auto flex items-start gap-2 max-w-sm rounded-lg border border-line-strong bg-raised/95 backdrop-blur px-3 py-2.5 text-[12.5px] shadow-xl shadow-black/40 animate-slide-up">
            {t.tone === 'ok' ? <CheckCircle2 size={15} className="text-ok shrink-0 mt-px" /> : t.tone === 'error' ? <XCircle size={15} className="text-error shrink-0 mt-px" /> : <Info size={15} className="text-working shrink-0 mt-px" />}
            <span>{t.text}</span>
          </div>
        ))}
      </div>
    </Ctx.Provider>
  );
}
