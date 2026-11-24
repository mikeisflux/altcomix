import { Check, ChevronDown, X } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import type { InputHTMLAttributes, ReactNode, SelectHTMLAttributes, TextareaHTMLAttributes } from 'react';
import { cx } from './basic';

const control =
  'w-full rounded-lg border border-line bg-ink px-3 text-sm text-paper placeholder:text-faint transition-colors hover:border-line-strong focus:border-accent focus:outline-none disabled:opacity-50';

export function Field({ label, hint, error, children, className, optional }: { label?: ReactNode; hint?: ReactNode; error?: string | null; children: ReactNode; className?: string; optional?: boolean }) {
  return (
    <label className={cx('block', className)}>
      {label && (
        <span className="mb-1.5 flex items-baseline justify-between gap-2 text-[13px] font-medium text-paper">
          <span>{label}</span>
          {optional && <span className="text-xs font-normal text-faint">Optional</span>}
        </span>
      )}
      {children}
      {error ? <span className="mt-1.5 block text-xs text-danger" role="alert">{error}</span> : hint ? <span className="mt-1.5 block text-xs text-faint">{hint}</span> : null}
    </label>
  );
}

export function Input({ className, ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={cx(control, 'h-10', className)} {...rest} />;
}

export function Textarea({ className, maxLength, value, ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <span className="block">
      <textarea className={cx(control, 'min-h-28 py-2.5 leading-relaxed', className)} maxLength={maxLength} value={value} {...rest} />
      {maxLength !== undefined && (
        <span className="mt-1 block text-right text-xs tabular-nums text-faint">{String(value ?? '').length}/{maxLength}</span>
      )}
    </span>
  );
}

export function Select({ className, children, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <span className="relative block">
      <select className={cx(control, 'h-10 appearance-none pr-9', className)} {...rest}>{children}</select>
      <ChevronDown className="pointer-events-none absolute right-3 top-1/2 size-4 -translate-y-1/2 text-muted" aria-hidden />
    </span>
  );
}

export function Switch({ checked, onChange, label, description, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: ReactNode; description?: ReactNode; disabled?: boolean }) {
  const id = useId();
  return (
    <div className="flex items-start justify-between gap-4 py-3">
      <label htmlFor={id} className="min-w-0 cursor-pointer">
        <span className="block text-sm font-medium">{label}</span>
        {description && <span className="mt-0.5 block text-xs text-muted">{description}</span>}
      </label>
      <button
        id={id}
        type="button"
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={cx('relative mt-0.5 h-6 w-11 shrink-0 rounded-full border transition-colors disabled:opacity-50', checked ? 'border-accent bg-accent' : 'border-line-strong bg-raised')}
      >
        <span className={cx('absolute top-0.5 size-[18px] rounded-full transition-all', checked ? 'left-[22px] bg-accent-ink' : 'left-0.5 bg-muted')} />
      </button>
    </div>
  );
}

export function Checkbox({ checked, onChange, label, description, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: ReactNode; description?: ReactNode; disabled?: boolean }) {
  return (
    <label className={cx('flex cursor-pointer items-start gap-2.5', disabled && 'cursor-not-allowed opacity-50')}>
      <input type="checkbox" className="peer sr-only" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span className={cx('mt-0.5 flex size-[18px] shrink-0 items-center justify-center rounded border transition-colors peer-focus-visible:outline peer-focus-visible:outline-2 peer-focus-visible:outline-accent', checked ? 'border-accent bg-accent text-accent-ink' : 'border-line-strong bg-ink')}>
        {checked && <Check className="size-3.5" strokeWidth={3} />}
      </span>
      <span className="min-w-0">
        <span className="block text-sm">{label}</span>
        {description && <span className="mt-0.5 block text-xs text-muted">{description}</span>}
      </span>
    </label>
  );
}

/** Segmented choice (radio group drawn as buttons). */
export function Segmented<T extends string>({ value, onChange, options, size = 'md' }: { value: T; onChange: (v: T) => void; options: { value: T; label: ReactNode; hint?: string }[]; size?: 'sm' | 'md' }) {
  return (
    <div role="radiogroup" className="flex flex-wrap gap-1.5">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          title={o.hint}
          onClick={() => onChange(o.value)}
          className={cx(
            'rounded-lg border transition-colors',
            size === 'sm' ? 'h-8 px-2.5 text-[13px]' : 'h-10 px-3.5 text-sm',
            value === o.value ? 'border-accent bg-accent-soft text-paper' : 'border-line bg-ink text-muted hover:border-line-strong hover:text-paper',
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** Multi-select with an optional maximum ("Theme (max 6)"). */
export function MultiSelect({ value, onChange, options, max, placeholder = 'Choose…' }: { value: string[]; onChange: (v: string[]) => void; options: readonly string[]; max?: number; placeholder?: string }) {
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState('');
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', esc);
    };
  }, [open]);
  const atMax = max !== undefined && value.length >= max;
  const shown = options.filter((o) => o.toLowerCase().includes(filter.toLowerCase()));
  const toggle = (o: string) => {
    if (value.includes(o)) onChange(value.filter((v) => v !== o));
    else if (!atMax) onChange([...value, o]);
  };
  return (
    <div ref={ref} className="relative">
      <button type="button" aria-haspopup="listbox" aria-expanded={open} onClick={() => setOpen((o) => !o)} className={cx(control, 'flex min-h-10 items-center justify-between gap-2 py-1.5 text-left')}>
        <span className="flex min-w-0 flex-wrap gap-1">
          {value.length === 0 && <span className="text-faint">{placeholder}</span>}
          {value.map((v) => (
            <span key={v} className="inline-flex items-center gap-1 rounded-md bg-raised px-1.5 py-0.5 text-xs">
              {v}
              <span role="button" tabIndex={0} aria-label={`Remove ${v}`} className="text-muted hover:text-paper" onClick={(e) => { e.stopPropagation(); toggle(v); }} onKeyDown={(e) => { if (e.key === 'Enter') { e.stopPropagation(); toggle(v); } }}>
                <X className="size-3" />
              </span>
            </span>
          ))}
        </span>
        <ChevronDown className="size-4 shrink-0 text-muted" aria-hidden />
      </button>
      {open && (
        <div className="absolute z-30 mt-1 w-full overflow-hidden rounded-xl border border-line-strong bg-raised shadow-pop">
          {options.length > 8 && (
            <input autoFocus value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter…" className="w-full border-b border-line bg-transparent px-3 py-2 text-sm outline-none placeholder:text-faint" />
          )}
          <ul role="listbox" aria-multiselectable className="max-h-60 overflow-auto py-1">
            {shown.map((o) => {
              const on = value.includes(o);
              return (
                <li key={o}>
                  <button type="button" role="option" aria-selected={on} disabled={!on && atMax} onClick={() => toggle(o)} className="flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left text-sm hover:bg-hover disabled:opacity-40">
                    {o}
                    {on && <Check className="size-4 text-accent" />}
                  </button>
                </li>
              );
            })}
            {shown.length === 0 && <li className="px-3 py-2 text-sm text-faint">No matches</li>}
          </ul>
          {max !== undefined && <div className="border-t border-line px-3 py-1.5 text-xs text-faint">{value.length} of {max} selected</div>}
        </div>
      )}
    </div>
  );
}

/** Free-form tags: type and press Enter or comma. */
export function TagInput({ value, onChange, placeholder = 'Add a tag and press Enter', max = 30 }: { value: string[]; onChange: (v: string[]) => void; placeholder?: string; max?: number }) {
  const [draft, setDraft] = useState('');
  const add = (raw: string) => {
    const tags = raw.split(',').map((t) => t.trim().toLowerCase()).filter(Boolean);
    if (!tags.length) return;
    onChange(Array.from(new Set([...value, ...tags])).slice(0, max));
    setDraft('');
  };
  return (
    <div className={cx(control, 'flex min-h-10 flex-wrap items-center gap-1 py-1.5')}>
      {value.map((t) => (
        <span key={t} className="inline-flex items-center gap-1 rounded-md bg-raised px-1.5 py-0.5 text-xs">
          {t}
          <button type="button" aria-label={`Remove ${t}`} className="text-muted hover:text-paper" onClick={() => onChange(value.filter((v) => v !== t))}><X className="size-3" /></button>
        </span>
      ))}
      <input
        value={draft}
        onChange={(e) => (e.target.value.includes(',') ? add(e.target.value) : setDraft(e.target.value))}
        onKeyDown={(e) => {
          if (e.key === 'Enter') { e.preventDefault(); add(draft); }
          if (e.key === 'Backspace' && !draft && value.length) onChange(value.slice(0, -1));
        }}
        onBlur={() => add(draft)}
        placeholder={value.length ? '' : placeholder}
        className="min-w-24 flex-1 bg-transparent text-sm outline-none placeholder:text-faint"
      />
    </div>
  );
}

/** Dollar amount input backed by integer cents. Empty = null. */
export function MoneyInput({ cents, onChange, placeholder = '0.00', disabled }: { cents: number | null; onChange: (cents: number | null) => void; placeholder?: string; disabled?: boolean }) {
  const [text, setText] = useState(cents === null ? '' : (cents / 100).toFixed(2));
  const last = useRef(cents);
  useEffect(() => {
    if (cents !== last.current) {
      last.current = cents;
      setText(cents === null ? '' : (cents / 100).toFixed(2));
    }
  }, [cents]);
  return (
    <span className="relative block">
      <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-muted">$</span>
      <input
        inputMode="decimal"
        disabled={disabled}
        value={text}
        placeholder={placeholder}
        onChange={(e) => {
          const t = e.target.value.replace(/[^0-9.]/g, '');
          setText(t);
          const v = t === '' ? null : Math.round(parseFloat(t) * 100);
          last.current = Number.isFinite(v as number) ? v : null;
          onChange(last.current);
        }}
        className={cx(control, 'h-10 pl-7 tabular-nums')}
      />
    </span>
  );
}

export function FormRow({ children, cols = 2 }: { children: ReactNode; cols?: 2 | 3 | 4 }) {
  return <div className={cx('grid gap-4', cols === 2 && 'sm:grid-cols-2', cols === 3 && 'sm:grid-cols-3', cols === 4 && 'sm:grid-cols-2 lg:grid-cols-4')}>{children}</div>;
}

export function FormSection({ title, description, children }: { title: string; description?: ReactNode; children: ReactNode }) {
  return (
    <section className="grid gap-5 border-b border-line py-7 first:pt-0 last:border-0 md:grid-cols-[minmax(0,260px)_minmax(0,1fr)] md:gap-10">
      <div>
        <h3 className="text-base font-semibold">{title}</h3>
        {description && <p className="mt-1 text-sm text-muted">{description}</p>}
      </div>
      <div className="space-y-4">{children}</div>
    </section>
  );
}
