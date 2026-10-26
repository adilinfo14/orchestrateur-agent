import type { ComponentProps, ReactNode } from 'react';
import type { SessionStatus } from '../../../../packages/protocol/src/index.ts';
import { cx, STATUS } from '../lib/format.ts';

export function StatusDot({ status, size = 8 }: { status: SessionStatus; size?: number }) {
  const live = status === 'working' || status === 'waiting';
  return (
    <span className="relative inline-flex shrink-0" style={{ width: size, height: size }} aria-label={STATUS[status].label}>
      {live && <span className={cx('absolute inset-0 rounded-full animate-pulse-ring', STATUS[status].color)} />}
      <span className={cx('relative inline-flex rounded-full w-full h-full', STATUS[status].color)} />
    </span>
  );
}

export function StatusPill({ status }: { status: SessionStatus }) {
  return (
    <span className={cx('inline-flex items-center gap-1.5 rounded-full border border-line px-2 py-0.5 text-[11px] font-medium', STATUS[status].text)}>
      <StatusDot status={status} size={6} />
      {STATUS[status].label}
    </span>
  );
}

export function Badge({ children, tone = 'neutral', title }: { children: ReactNode; tone?: 'neutral' | 'accent' | 'warn' | 'ok' | 'error'; title?: string }) {
  const tones = {
    neutral: 'border-line text-muted', accent: 'border-accent/30 text-accent bg-accent/5', warn: 'border-waiting/30 text-waiting bg-waiting/5',
    ok: 'border-ok/30 text-ok bg-ok/5', error: 'border-error/30 text-error bg-error/5',
  };
  return <span title={title} className={cx('inline-flex items-center gap-1 rounded-md border px-1.5 py-px text-[10.5px] font-medium whitespace-nowrap', tones[tone])}>{children}</span>;
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="mono rounded border border-line-strong bg-raised px-1 text-[10px] text-muted">{children}</kbd>;
}

type BtnProps = ComponentProps<'button'> & { variant?: 'primary' | 'ghost' | 'danger' | 'subtle'; size?: 'sm' | 'md' };

export function Button({ variant = 'subtle', size = 'md', className, ...rest }: BtnProps) {
  const v = {
    primary: 'bg-fg text-bg hover:bg-white',
    subtle: 'bg-raised text-fg border border-line hover:bg-hover hover:border-line-strong',
    ghost: 'text-muted hover:text-fg hover:bg-hover',
    danger: 'bg-error/10 text-error border border-error/30 hover:bg-error/20',
  }[variant];
  const s = size === 'sm' ? 'h-7 px-2.5 text-[12px]' : 'h-8 px-3 text-[13px]';
  return (
    <button
      {...rest}
      className={cx('inline-flex items-center justify-center gap-1.5 rounded-md font-medium transition-[background,border,color,transform] duration-150 active:scale-[0.98] disabled:opacity-40 disabled:pointer-events-none select-none', v, s, className)}
    />
  );
}

export function Panel({ title, actions, children, className, bodyClass }: { title?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string; bodyClass?: string }) {
  return (
    <section className={cx('rounded-xl border border-line bg-panel', className)}>
      {(title || actions) && (
        <header className="flex items-center justify-between gap-2 border-b border-line px-4 h-10">
          <h2 className="text-[12px] font-medium text-muted uppercase tracking-[0.06em]">{title}</h2>
          {actions}
        </header>
      )}
      <div className={bodyClass}>{children}</div>
    </section>
  );
}

export function Empty({ icon, title, children }: { icon?: ReactNode; title: string; children?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center text-center py-12 px-6 animate-fade-in">
      {icon && <div className="mb-3 text-faint">{icon}</div>}
      <p className="text-[13px] font-medium text-fg">{title}</p>
      {children && <div className="mt-1.5 max-w-md text-[12.5px] text-muted leading-relaxed">{children}</div>}
    </div>
  );
}

export function Spinner({ className }: { className?: string }) {
  return <span className={cx('inline-block h-3.5 w-3.5 rounded-full border-2 border-current border-r-transparent animate-spin', className)} />;
}

export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-3 mb-5">
      <div className="min-w-0">
        <h1 className="text-[19px] font-semibold tracking-[-0.015em]">{title}</h1>
        {subtitle && <p className="mt-0.5 text-[12.5px] text-muted">{subtitle}</p>}
      </div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </div>
  );
}
