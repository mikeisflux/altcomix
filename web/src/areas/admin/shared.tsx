import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { UseQueryResult } from '@tanstack/react-query';
import { Check, Copy, Search, X } from 'lucide-react';
import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useSearchParams } from 'react-router';
import { api, errorMessage } from '@/lib/api';
import { useSession } from '@/lib/session';
import {
  Badge, Button, Checkbox, EmptyState, ErrorState, Field, IconButton, Input, Modal, MoneyInput, Pagination, Select, Skeleton, Table, Textarea, cx, toast,
} from '@/ui';
import type { Column } from '@/ui';

/** A row as the admin API returns it. Field names are the handler's own. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type R = Record<string, any>;
export type Paged<T = R> = { items: T[]; total: number; page: number; limit: number };

export function useTitle(title: string) {
  const { settings } = useSession();
  useEffect(() => {
    document.title = `${title} · Admin · ${settings.site.name}`;
  }, [title, settings.site.name]);
}

export function useIsSuper(): boolean {
  return useSession().user?.role === 'super_admin';
}

// ---------------------------------------------------------------- filters in the URL

/**
 * Filter state kept in the query string, so a reload or a shared link shows
 * the same list. Changing any filter returns to page 1.
 */
export function useFilters<T extends Record<string, string>>(defaults: T): [T & { page: number }, (patch: Partial<T> & { page?: number }) => void] {
  const [params, setParams] = useSearchParams();
  const values = { ...defaults } as Record<string, string>;
  for (const k of Object.keys(defaults)) {
    const v = params.get(k);
    if (v !== null) values[k] = v;
  }
  const page = Math.max(1, Number(params.get('page')) || 1);
  const set = (patch: Partial<T> & { page?: number }) => {
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        if (patch.page === undefined) next.delete('page');
        for (const [k, v] of Object.entries(patch)) {
          if (k === 'page') {
            if (Number(v) > 1) next.set('page', String(v));
            else next.delete('page');
          } else if (v === undefined || v === '' || v === defaults[k]) next.delete(k);
          else next.set(k, String(v));
        }
        return next;
      },
      { replace: true },
    );
  };
  return [{ ...(values as T), page }, set];
}

/** Paged admin list. Every admin query key starts with 'admin' so one invalidation refreshes them all. */
export function useList<X = unknown>(path: string, query: Record<string, string | number | undefined>, enabled = true) {
  return useQuery({
    queryKey: ['admin', path, query],
    queryFn: () => api<Paged & X>(path, { query }),
    placeholderData: keepPreviousData,
    enabled,
  });
}

export function useAdminQuery<T>(path: string, query?: Record<string, string | number | undefined>, opts: { enabled?: boolean; refetchInterval?: number } = {}) {
  return useQuery({ queryKey: ['admin', path, query ?? null], queryFn: () => api<T>(path, { query }), ...opts });
}

// ---------------------------------------------------------------- mutations

type ActInput<T> = { key: string; fn: () => Promise<T>; ok?: string | ((r: T) => string | null); onDone?: (r: T) => void; quietError?: (e: unknown) => boolean };

/**
 * Runs an admin action: disables the button that started it (`busy === key`),
 * toasts the result or the server's error, and refreshes every admin query.
 */
export function useAct() {
  const qc = useQueryClient();
  const [busy, setBusy] = useState<string | null>(null);
  const m = useMutation({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mutationFn: (input: ActInput<any>) => input.fn(),
    onMutate: (input) => setBusy(input.key),
    onSuccess: (r, input) => {
      const msg = typeof input.ok === 'function' ? input.ok(r) : input.ok;
      if (msg) toast.success(msg);
      input.onDone?.(r);
    },
    onError: (e, input) => {
      if (!input.quietError?.(e)) toast.error(errorMessage(e));
    },
    onSettled: () => {
      setBusy(null);
      void qc.invalidateQueries({ queryKey: ['admin'] });
    },
  });
  const run = useCallback(<T,>(input: ActInput<T>) => m.mutateAsync(input).then((r) => r as T, () => undefined), [m]);
  return { run, busy, anyBusy: busy !== null };
}

// ---------------------------------------------------------------- ask dialog (confirm step that also collects input)

export type AskField = {
  name: string;
  label: string;
  type?: 'text' | 'textarea' | 'number' | 'money' | 'select' | 'checkbox' | 'password' | 'email' | 'datetime';
  required?: boolean;
  minLength?: number;
  hint?: string;
  placeholder?: string;
  options?: { value: string; label: string }[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  initial?: any;
  min?: number;
  max?: number;
  /** Only show this field when the other values satisfy the test. */
  when?: (values: R) => boolean;
};
type AskOptions = { title: string; body?: ReactNode; fields: AskField[]; confirmLabel?: string; danger?: boolean };
type AskFn = (o: AskOptions) => Promise<R | null>;

const AskCtx = createContext<AskFn>(() => Promise.resolve(null));

/** `const ask = useAsk(); const v = await ask({ title, fields }); if (v) …` */
export function useAsk(): AskFn {
  return useContext(AskCtx);
}

export function AskProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<(AskOptions & { resolve: (v: R | null) => void }) | null>(null);
  const [values, setValues] = useState<R>({});
  const [error, setError] = useState<string | null>(null);
  const ask = useCallback<AskFn>(
    (o) =>
      new Promise((resolve) => {
        setValues(Object.fromEntries(o.fields.map((f) => [f.name, f.initial ?? (f.type === 'checkbox' ? false : f.type === 'money' ? null : '')])));
        setError(null);
        setState({ ...o, resolve });
      }),
    [],
  );
  const close = (v: R | null) => {
    state?.resolve(v);
    setState(null);
  };
  const submit = () => {
    if (!state) return;
    const out: R = {};
    for (const f of state.fields) {
      if (f.when && !f.when(values)) continue;
      let v = values[f.name];
      if (typeof v === 'string') v = v.trim();
      const blank = v === '' || v === null || v === undefined;
      if (f.required && blank) return setError(`${f.label}: this is needed.`);
      if (!blank && f.minLength && String(v).length < f.minLength) return setError(`${f.label}: write at least ${f.minLength} characters.`);
      if (f.type === 'number' && !blank) {
        v = Number(v);
        if (!Number.isFinite(v) || !Number.isInteger(v)) return setError(`${f.label}: enter a whole number.`);
        if (f.min !== undefined && v < f.min) return setError(`${f.label}: the minimum is ${f.min}.`);
        if (f.max !== undefined && v > f.max) return setError(`${f.label}: the maximum is ${f.max}.`);
      }
      if (f.type === 'datetime') v = fromLocalInput(v);
      out[f.name] = blank && f.type !== 'checkbox' ? undefined : v;
    }
    close(out);
  };
  const set = (name: string, v: unknown) => setValues((cur) => ({ ...cur, [name]: v }));
  return (
    <AskCtx.Provider value={ask}>
      {children}
      <Modal
        open={Boolean(state)}
        onClose={() => close(null)}
        title={state?.title ?? ''}
        size="sm"
        footer={
          <>
            <Button variant="ghost" onClick={() => close(null)}>Cancel</Button>
            <Button variant={state?.danger ? 'danger' : 'primary'} onClick={submit}>{state?.confirmLabel ?? 'Confirm'}</Button>
          </>
        }
      >
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          {state?.body && <div className="text-sm text-muted">{state.body}</div>}
          {state?.fields.filter((f) => !f.when || f.when(values)).map((f, i) =>
            f.type === 'checkbox' ? (
              <Checkbox key={f.name} checked={Boolean(values[f.name])} onChange={(v) => set(f.name, v)} label={f.label} description={f.hint} />
            ) : (
              <Field key={f.name} label={f.label} hint={f.hint} optional={!f.required}>
                {f.type === 'textarea' ? (
                  <Textarea autoFocus={i === 0} value={values[f.name] ?? ''} onChange={(e) => set(f.name, e.target.value)} placeholder={f.placeholder} className="min-h-20" />
                ) : f.type === 'select' ? (
                  <Select value={values[f.name] ?? ''} onChange={(e) => set(f.name, e.target.value)}>
                    {f.options?.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                  </Select>
                ) : f.type === 'money' ? (
                  <MoneyInput cents={values[f.name] ?? null} onChange={(c) => set(f.name, c)} />
                ) : (
                  <Input
                    autoFocus={i === 0}
                    type={f.type === 'number' ? 'text' : f.type === 'datetime' ? 'datetime-local' : (f.type ?? 'text')}
                    inputMode={f.type === 'number' ? 'numeric' : undefined}
                    value={values[f.name] ?? ''}
                    onChange={(e) => set(f.name, e.target.value)}
                    placeholder={f.placeholder}
                  />
                )}
              </Field>
            ),
          )}
          {error && <p className="text-sm text-danger" role="alert">{error}</p>}
          <button type="submit" className="hidden" aria-hidden tabIndex={-1} />
        </form>
      </Modal>
    </AskCtx.Provider>
  );
}

// ---------------------------------------------------------------- small pieces

export function SearchInput({ value, onChange, placeholder, label }: { value: string; onChange: (v: string) => void; placeholder: string; label?: string }) {
  const [text, setText] = useState(value);
  const last = useRef(value);
  useEffect(() => {
    if (value !== last.current) {
      last.current = value;
      setText(value);
    }
  }, [value]);
  useEffect(() => {
    if (text === last.current) return;
    const t = setTimeout(() => {
      last.current = text;
      onChange(text);
    }, 300);
    return () => clearTimeout(t);
  }, [text, onChange]);
  return (
    <span className="relative block min-w-0 flex-1 basis-56">
      <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted" aria-hidden />
      <Input type="search" aria-label={label ?? placeholder} placeholder={placeholder} value={text} onChange={(e) => setText(e.target.value)} className="pl-9" />
    </span>
  );
}

/** A labelled dropdown filter. The first option is normally the "any" choice. */
export function FilterSelect({ label, value, onChange, options }: { label: string; value: string; onChange: (v: string) => void; options: [string, string][] }) {
  return (
    <span className="block w-[calc(50%-0.25rem)] min-w-0 sm:w-auto sm:min-w-36">
      <Select aria-label={label} value={value} onChange={(e) => onChange(e.target.value)}>
        {options.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
      </Select>
    </span>
  );
}

export function FilterBar({ children }: { children: ReactNode }) {
  return <div className="mb-4 flex flex-wrap items-center gap-2">{children}</div>;
}

/** Table with the loading, error, empty and paging states every admin list needs. */
export function DataList({ query, columns, onRowClick, empty, onPage, rowKey = (r: R) => r.id }: {
  query: UseQueryResult<Paged>;
  columns: Column<R>[];
  onRowClick?: (row: R) => void;
  empty: { title: string; hint?: ReactNode; action?: ReactNode; icon?: ReactNode };
  onPage: (p: number) => void;
  rowKey?: (row: R) => string;
}) {
  if (query.isPending) return <Skeleton className="h-72 w-full" />;
  if (query.isError) return <ErrorState message={errorMessage(query.error)} retry={() => void query.refetch()} />;
  const d = query.data;
  if (!d.items.length) return <EmptyState icon={empty.icon} title={empty.title} action={empty.action}>{empty.hint}</EmptyState>;
  return (
    <div className={cx('transition-opacity', query.isPlaceholderData && 'opacity-60')}>
      <Table columns={columns} rows={d.items} rowKey={rowKey} onRowClick={onRowClick} />
      <div className="mt-2 text-xs text-faint">{new Intl.NumberFormat().format(d.total)} in total</div>
      <Pagination page={d.page} pages={Math.ceil(d.total / d.limit)} onPage={onPage} />
    </div>
  );
}

/** Loading and error handling for a single-object query. */
export function Loaded<T>({ query, children }: { query: UseQueryResult<T>; children: (data: T) => ReactNode }) {
  if (query.isPending) return <Skeleton className="h-64 w-full" />;
  if (query.isError) return <ErrorState message={errorMessage(query.error)} retry={() => void query.refetch()} />;
  return <>{children(query.data)}</>;
}

const TONES: Record<string, 'ok' | 'warn' | 'danger' | 'info' | 'neutral' | 'accent'> = {
  paid: 'ok', active: 'ok', sent: 'ok', approved: 'info', resolved: 'ok', public: 'ok', live: 'ok', verified: 'ok', actioned: 'ok', success: 'ok', published: 'ok',
  pending: 'warn', queued: 'info', sending: 'info', requested: 'warn', past_due: 'warn', unresolved: 'warn', open: 'warn', new: 'warn', scheduled: 'info', unlisted: 'info',
  failed: 'danger', refunded: 'neutral', rejected: 'danger', banned: 'danger', suspended: 'danger', suppressed: 'warn', 'taken down': 'danger', deleted: 'danger',
  super_admin: 'accent', admin: 'info',
};

export function StatusBadge({ status, label }: { status: string; label?: string }) {
  return <Badge tone={TONES[status] ?? 'neutral'}>{label ?? status.replace(/_/g, ' ')}</Badge>;
}

export function CopyButton({ text, label = 'Copy', size = 'sm' }: { text: string; label?: string; size?: 'sm' | 'md' }) {
  const [done, setDone] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setDone(true);
      setTimeout(() => setDone(false), 1500);
    } catch {
      toast.error('Your browser blocked copying. Select the text and copy it by hand.');
    }
  };
  return <Button size={size} variant="secondary" onClick={copy} icon={done ? <Check className="size-4" /> : <Copy className="size-4" />}>{done ? 'Copied' : label}</Button>;
}

/** A read-only value with a copy button (webhook URLs, codes). */
export function CopyField({ label, value, hint }: { label: string; value: string; hint?: ReactNode }) {
  return (
    <div>
      <div className="mb-1.5 text-[13px] font-medium">{label}</div>
      <div className="flex items-center gap-2">
        <code className="min-w-0 flex-1 truncate rounded-lg border border-line bg-ink px-3 py-2.5 text-[13px]">{value}</code>
        <CopyButton text={value} size="md" />
      </div>
      {hint && <div className="mt-1.5 text-xs text-faint">{hint}</div>}
    </div>
  );
}

/** Panel that slides in from the right for a record's detail. Full width on phones. */
export function Drawer({ open, onClose, title, children, footer }: { open: boolean; onClose: () => void; title: ReactNode; children: ReactNode; footer?: ReactNode }) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
  }, [open, onClose]);
  if (!open) return null;
  return createPortal(
    <div className="fixed inset-0 z-50 flex justify-end bg-black/70" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div role="dialog" aria-modal="true" className="flex h-full w-full max-w-2xl flex-col border-l border-line-strong bg-surface shadow-pop">
        <div className="flex items-center justify-between gap-4 border-b border-line px-5 py-3.5">
          <h2 className="min-w-0 truncate text-lg font-semibold">{title}</h2>
          <IconButton label="Close" onClick={onClose}><X className="size-5" /></IconButton>
        </div>
        <div className="min-h-0 flex-1 overflow-auto px-5 py-5">{children}</div>
        {footer && <div className="flex flex-wrap items-center justify-end gap-2 border-t border-line px-5 py-3.5">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}

/** Rendered email HTML, isolated: no scripts, no forms, no access to this page. */
export function EmailFrame({ html, title }: { html: string; title: string }) {
  return <iframe title={title} sandbox="" srcDoc={html} referrerPolicy="no-referrer" className="h-[520px] w-full rounded-xl border border-line bg-paper" />;
}

/** A labelled group of controls. Use instead of Field when the content is several buttons, which a <label> must not wrap. */
export function Group({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div role="group" aria-label={label}>
      <div className="mb-1.5 text-[13px] font-medium">{label}</div>
      {children}
    </div>
  );
}

export function Mono({ children }: { children: ReactNode }) {
  return <span className="font-mono text-[12.5px]">{children}</span>;
}

export function shortId(id: string | null | undefined): string {
  return id ? id.slice(-8) : '—';
}

/** ISO timestamp -> value for <input type="datetime-local"> in the viewer's time zone. */
export function toLocalInput(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime()) || d.getFullYear() > 9000) return '';
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function fromLocalInput(v: string | null | undefined): string | null {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** Basis points <-> the percentage an admin types ("85" or "82.5"). */
export const bpsToPct = (bps: number | null | undefined): string => (bps === null || bps === undefined ? '' : String(bps / 100));
export function pctToBps(text: string): number | null {
  const t = text.trim().replace('%', '');
  if (!t) return null;
  const n = Number(t);
  return Number.isFinite(n) ? Math.round(n * 100) : NaN;
}

export function Section({ title, description, actions, children, className }: { title: ReactNode; description?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={cx('rounded-2xl border border-line bg-surface', className)}>
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-line px-5 py-4">
        <div className="min-w-0">
          <h2 className="text-lg font-semibold">{title}</h2>
          {description && <p className="mt-1 text-sm text-muted">{description}</p>}
        </div>
        {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
      </div>
      <div className="p-5">{children}</div>
    </section>
  );
}
