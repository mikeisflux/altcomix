import { X } from 'lucide-react';
import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { NavLink } from 'react-router';
import { Button, IconButton, cx } from './basic';

export function Modal({ open, onClose, title, children, footer, size = 'md' }: { open: boolean; onClose: () => void; title: ReactNode; children: ReactNode; footer?: ReactNode; size?: 'sm' | 'md' | 'lg' | 'xl' }) {
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    panel.current?.focus();
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
  }, [open, onClose]);
  if (!open) return null;
  const width = { sm: 'max-w-md', md: 'max-w-xl', lg: 'max-w-3xl', xl: 'max-w-5xl' }[size];
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/70 p-0 backdrop-blur-sm sm:items-center sm:p-6" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={panel} tabIndex={-1} role="dialog" aria-modal="true" className={cx('flex max-h-[92dvh] w-full flex-col rounded-t-2xl border border-line-strong bg-surface shadow-pop outline-none sm:rounded-2xl', width)}>
        <div className="flex items-center justify-between gap-4 border-b border-line px-5 py-3.5">
          <h2 className="text-lg font-semibold">{title}</h2>
          <IconButton label="Close" onClick={onClose}><X className="size-5" /></IconButton>
        </div>
        <div className="min-h-0 flex-1 overflow-auto px-5 py-5">{children}</div>
        {footer && <div className="flex flex-wrap items-center justify-end gap-2 border-t border-line px-5 py-3.5">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}

type ConfirmOptions = { title: string; body?: ReactNode; confirmLabel?: string; danger?: boolean };
const ConfirmCtx = createContext<(o: ConfirmOptions) => Promise<boolean>>(() => Promise.resolve(false));

/** `const confirm = useConfirm(); if (await confirm({ title: 'Delete?' })) …` */
export function useConfirm() {
  return useContext(ConfirmCtx);
}

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<(ConfirmOptions & { resolve: (v: boolean) => void }) | null>(null);
  const confirm = useCallback((o: ConfirmOptions) => new Promise<boolean>((resolve) => setState({ ...o, resolve })), []);
  const done = (v: boolean) => {
    state?.resolve(v);
    setState(null);
  };
  return (
    <ConfirmCtx.Provider value={confirm}>
      {children}
      <Modal
        open={Boolean(state)}
        onClose={() => done(false)}
        title={state?.title ?? ''}
        size="sm"
        footer={
          <>
            <Button variant="ghost" onClick={() => done(false)}>Cancel</Button>
            <Button variant={state?.danger ? 'danger' : 'primary'} onClick={() => done(true)} autoFocus>{state?.confirmLabel ?? 'Confirm'}</Button>
          </>
        }
      >
        <div className="text-sm text-muted">{state?.body}</div>
      </Modal>
    </ConfirmCtx.Provider>
  );
}

/** Click-to-open popover anchored to its trigger. */
export function Popover({ trigger, children, align = 'right', width = 240 }: { trigger: (p: { open: boolean; toggle: () => void }) => ReactNode; children: (close: () => void) => ReactNode; align?: 'left' | 'right'; width?: number }) {
  const [open, setOpen] = useState(false);
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
  return (
    <div ref={ref} className="relative">
      {trigger({ open, toggle: () => setOpen((o) => !o) })}
      {open && (
        <div style={{ width }} className={cx('absolute z-40 mt-2 max-w-[calc(100vw-1.5rem)] overflow-hidden rounded-xl border border-line-strong bg-raised shadow-pop', align === 'right' ? 'right-0' : 'left-0')}>
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  );
}

export function MenuItem({ children, onClick, icon, danger, to }: { children: ReactNode; onClick?: () => void; icon?: ReactNode; danger?: boolean; to?: string }) {
  const cls = cx('flex w-full items-center gap-2.5 px-3.5 py-2 text-left text-sm transition-colors hover:bg-hover', danger ? 'text-danger' : 'text-paper');
  if (to) return <NavLink to={to} onClick={onClick} className={cls}>{icon}{children}</NavLink>;
  return <button type="button" onClick={onClick} className={cls}>{icon}{children}</button>;
}

/** Route-driven tabs: each tab is a link. */
export function NavTabs({ tabs }: { tabs: { to: string; label: ReactNode; end?: boolean }[] }) {
  return (
    <nav className="no-scrollbar -mx-4 mb-6 flex gap-1 overflow-x-auto border-b border-line px-4 sm:mx-0 sm:px-0">
      {tabs.map((t) => (
        <NavLink
          key={t.to}
          to={t.to}
          end={t.end}
          className={({ isActive }) => cx('-mb-px whitespace-nowrap border-b-2 px-3 py-2.5 text-sm font-medium transition-colors', isActive ? 'border-accent text-paper' : 'border-transparent text-muted hover:text-paper')}
        >
          {t.label}
        </NavLink>
      ))}
    </nav>
  );
}

/** State-driven tabs. */
export function Tabs<T extends string>({ value, onChange, tabs }: { value: T; onChange: (v: T) => void; tabs: { value: T; label: ReactNode }[] }) {
  return (
    <div role="tablist" className="no-scrollbar flex gap-1 overflow-x-auto border-b border-line">
      {tabs.map((t) => (
        <button key={t.value} role="tab" aria-selected={value === t.value} onClick={() => onChange(t.value)} className={cx('-mb-px whitespace-nowrap border-b-2 px-3 py-2.5 text-sm font-medium transition-colors', value === t.value ? 'border-accent text-paper' : 'border-transparent text-muted hover:text-paper')}>
          {t.label}
        </button>
      ))}
    </div>
  );
}

/** Secondary navigation column used by settings-style pages (Studio, Admin, Account). */
export function SideNav({ groups }: { groups: { title?: string; items: { to: string; label: ReactNode; icon?: ReactNode; end?: boolean; badge?: ReactNode }[] }[] }) {
  return (
    <nav className="no-scrollbar flex gap-1 overflow-x-auto md:block md:space-y-5">
      {groups.map((g, i) => (
        <div key={g.title ?? i} className="flex shrink-0 gap-1 md:block md:space-y-0.5">
          {g.title && <div className="hidden px-2.5 pb-1 text-[11px] font-semibold uppercase tracking-wider text-faint md:block">{g.title}</div>}
          {g.items.map((it) => (
            <NavLink
              key={it.to}
              to={it.to}
              end={it.end}
              className={({ isActive }) => cx('flex items-center gap-2.5 whitespace-nowrap rounded-lg px-2.5 py-2 text-sm transition-colors [&>svg]:size-4 [&>svg]:shrink-0', isActive ? 'bg-raised font-medium text-paper' : 'text-muted hover:bg-hover hover:text-paper')}
            >
              {it.icon}
              <span className="flex-1">{it.label}</span>
              {it.badge}
            </NavLink>
          ))}
        </div>
      ))}
    </nav>
  );
}
