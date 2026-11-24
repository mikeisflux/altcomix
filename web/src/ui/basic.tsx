import { clsx } from 'clsx';
import { Loader2 } from 'lucide-react';
import type { ButtonHTMLAttributes, HTMLAttributes, ReactNode } from 'react';
import { Link } from 'react-router';

export const cx = clsx;

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'sun';
type Size = 'sm' | 'md' | 'lg';

const VARIANT: Record<Variant, string> = {
  primary: 'bg-accent text-accent-ink hover:bg-accent-hover font-semibold',
  secondary: 'bg-raised text-paper border border-line hover:bg-hover hover:border-line-strong',
  ghost: 'text-muted hover:text-paper hover:bg-hover',
  danger: 'bg-danger-soft text-danger border border-danger/40 hover:bg-danger hover:text-ink',
  sun: 'bg-sun text-sun-ink hover:brightness-110 font-semibold',
};
const SIZE: Record<Size, string> = {
  sm: 'h-8 px-3 text-[13px] gap-1.5 rounded-md',
  md: 'h-10 px-4 text-sm gap-2 rounded-lg',
  lg: 'h-12 px-6 text-base gap-2 rounded-xl',
};

export function buttonClass(variant: Variant = 'secondary', size: Size = 'md', block = false): string {
  return cx(
    'inline-flex items-center justify-center whitespace-nowrap transition-colors select-none disabled:opacity-50',
    VARIANT[variant],
    SIZE[size],
    block && 'w-full',
  );
}

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: Size; block?: boolean; loading?: boolean; icon?: ReactNode };

export function Button({ variant, size, block, loading, icon, children, className, disabled, type = 'button', ...rest }: ButtonProps) {
  return (
    <button type={type} className={cx(buttonClass(variant, size, block), className)} disabled={disabled || loading} {...rest}>
      {loading ? <Loader2 className="size-4 animate-spin" aria-hidden /> : icon}
      {children}
    </button>
  );
}

export function LinkButton({ to, variant, size, block, icon, children, className, external }: { to: string; variant?: Variant; size?: Size; block?: boolean; icon?: ReactNode; children?: ReactNode; className?: string; external?: boolean }) {
  const cls = cx(buttonClass(variant, size, block), className);
  if (external) return <a href={to} target="_blank" rel="noreferrer" className={cls}>{icon}{children}</a>;
  return <Link to={to} className={cls}>{icon}{children}</Link>;
}

export function IconButton({ label, children, className, active, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { label: string; active?: boolean }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      className={cx('inline-flex size-9 items-center justify-center rounded-lg text-muted transition-colors hover:bg-hover hover:text-paper disabled:opacity-40', active && 'bg-hover text-paper', className)}
      {...rest}
    >
      {children}
    </button>
  );
}

type Tone = 'neutral' | 'accent' | 'sun' | 'ok' | 'warn' | 'danger' | 'info';
const TONE: Record<Tone, string> = {
  neutral: 'bg-raised text-muted border-line',
  accent: 'bg-accent-soft text-accent-hover border-accent/30',
  sun: 'bg-sun text-sun-ink border-transparent',
  ok: 'bg-ok-soft text-ok border-ok/30',
  warn: 'bg-warn-soft text-warn border-warn/30',
  danger: 'bg-danger-soft text-danger border-danger/30',
  info: 'bg-info-soft text-info border-info/30',
};

export function Badge({ tone = 'neutral', children, className }: { tone?: Tone; children: ReactNode; className?: string }) {
  return <span className={cx('inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[11px] font-semibold uppercase tracking-wide', TONE[tone], className)}>{children}</span>;
}

export function Spinner({ className }: { className?: string }) {
  return <Loader2 className={cx('size-5 animate-spin text-muted', className)} role="status" aria-label="Loading" />;
}

export function PageLoader({ label = 'Loading' }: { label?: string }) {
  return (
    <div className="flex min-h-[40vh] flex-col items-center justify-center gap-3 text-muted">
      <Spinner className="size-7" />
      <span className="text-sm">{label}</span>
    </div>
  );
}

export function Card({ className, children, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cx('rounded-2xl border border-line bg-surface', className)} {...rest}>{children}</div>;
}

export function CardHeader({ title, description, actions }: { title: ReactNode; description?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3 border-b border-line px-5 py-4">
      <div className="min-w-0">
        <h2 className="text-lg font-semibold">{title}</h2>
        {description && <p className="mt-1 text-sm text-muted">{description}</p>}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </div>
  );
}

export function EmptyState({ icon, title, children, action }: { icon?: ReactNode; title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 rounded-2xl border border-dashed border-line px-6 py-14 text-center">
      {icon && <div className="text-faint [&>svg]:size-9">{icon}</div>}
      <h3 className="text-lg font-semibold">{title}</h3>
      {children && <p className="max-w-md text-sm text-muted">{children}</p>}
      {action}
    </div>
  );
}

export function ErrorState({ message, retry }: { message: string; retry?: () => void }) {
  return (
    <div className="rounded-2xl border border-danger/30 bg-danger-soft px-5 py-4 text-sm text-danger" role="alert">
      <p>{message}</p>
      {retry && <button className="mt-2 underline" onClick={retry}>Try again</button>}
    </div>
  );
}

export function Notice({ tone = 'info', children, action }: { tone?: 'info' | 'warn' | 'ok' | 'danger'; children: ReactNode; action?: ReactNode }) {
  return (
    <div className={cx('flex flex-wrap items-center justify-between gap-3 rounded-xl border px-4 py-3 text-sm', TONE[tone])}>
      <div className="min-w-0 normal-case">{children}</div>
      {action}
    </div>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={cx('animate-pulse rounded-lg bg-raised', className)} />;
}

export function Avatar({ src, name, size = 36, square }: { src?: string | null; name: string; size?: number; square?: boolean }) {
  const initials = name.trim().split(/\s+/).slice(0, 2).map((w) => w[0]?.toUpperCase()).join('') || '?';
  const style = { width: size, height: size, fontSize: Math.max(11, size * 0.38) };
  const shape = square ? 'rounded-lg' : 'rounded-full';
  if (src) return <img src={src} alt="" style={style} className={cx('shrink-0 border border-line object-cover', shape)} />;
  return <span style={style} className={cx('inline-flex shrink-0 items-center justify-center border border-line bg-raised font-semibold text-muted', shape)} aria-hidden>{initials}</span>;
}

export function PageHeader({ title, description, actions, back }: { title: ReactNode; description?: ReactNode; actions?: ReactNode; back?: ReactNode }) {
  return (
    <header className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div className="min-w-0">
        {back && <div className="mb-2 text-sm text-muted">{back}</div>}
        <h1 className="text-2xl font-bold sm:text-3xl">{title}</h1>
        {description && <p className="mt-1.5 max-w-2xl text-muted">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </header>
  );
}

export function Stat({ label, value, delta, hint }: { label: string; value: ReactNode; delta?: number; hint?: ReactNode }) {
  return (
    <div className="rounded-xl border border-line bg-surface px-4 py-3.5">
      <div className="text-[12px] font-medium uppercase tracking-wide text-muted">{label}</div>
      <div className="mt-1 flex items-baseline gap-2">
        <span className="font-display text-2xl font-bold tabular-nums">{value}</span>
        {delta !== undefined && delta !== 0 && (
          <span className={cx('text-sm font-medium tabular-nums', delta > 0 ? 'text-ok' : 'text-danger')}>
            {delta > 0 ? '+' : '−'}{new Intl.NumberFormat(undefined, { notation: 'compact' }).format(Math.abs(delta))}
          </span>
        )}
      </div>
      {hint && <div className="mt-0.5 text-xs text-faint">{hint}</div>}
    </div>
  );
}
