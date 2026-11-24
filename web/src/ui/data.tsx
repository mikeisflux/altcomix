import { ChevronLeft, ChevronRight } from 'lucide-react';
import type { ReactNode } from 'react';
import { Button, cx } from './basic';

export type Column<T> = { key: string; header: ReactNode; cell: (row: T) => ReactNode; align?: 'left' | 'right' | 'center'; width?: string; hideOnMobile?: boolean };

/** Table that scrolls sideways inside its own box on narrow screens. */
export function Table<T>({ columns, rows, rowKey, empty = 'Nothing here yet', onRowClick }: { columns: Column<T>[]; rows: T[]; rowKey: (row: T) => string; empty?: ReactNode; onRowClick?: (row: T) => void }) {
  return (
    <div className="overflow-x-auto rounded-xl border border-line">
      <table className="w-full min-w-max border-collapse text-sm">
        <thead>
          <tr className="border-b border-line bg-surface text-left text-[12px] uppercase tracking-wide text-muted">
            {columns.map((c) => (
              <th key={c.key} style={{ width: c.width }} className={cx('px-3.5 py-2.5 font-medium', c.align === 'right' && 'text-right', c.align === 'center' && 'text-center', c.hideOnMobile && 'hidden md:table-cell')}>
                {c.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={rowKey(r)} onClick={onRowClick ? () => onRowClick(r) : undefined} className={cx('border-b border-line last:border-0', onRowClick && 'cursor-pointer hover:bg-surface')}>
              {columns.map((c) => (
                <td key={c.key} className={cx('px-3.5 py-2.5 align-middle', c.align === 'right' && 'text-right tabular-nums', c.align === 'center' && 'text-center', c.hideOnMobile && 'hidden md:table-cell')}>
                  {c.cell(r)}
                </td>
              ))}
            </tr>
          ))}
          {rows.length === 0 && (
            <tr>
              <td colSpan={columns.length} className="px-4 py-10 text-center text-muted">{empty}</td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

export function Pagination({ page, pages, onPage }: { page: number; pages: number; onPage: (p: number) => void }) {
  if (pages <= 1) return null;
  return (
    <div className="mt-4 flex items-center justify-center gap-3 text-sm text-muted">
      <Button size="sm" variant="secondary" disabled={page <= 1} onClick={() => onPage(page - 1)} icon={<ChevronLeft className="size-4" />}>Previous</Button>
      <span className="tabular-nums">Page {page} of {pages}</span>
      <Button size="sm" variant="secondary" disabled={page >= pages} onClick={() => onPage(page + 1)}>Next<ChevronRight className="size-4" /></Button>
    </div>
  );
}

/** Label / value pairs. */
export function DefList({ items }: { items: [ReactNode, ReactNode][] }) {
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-sm">
      {items.map(([k, v], i) => (
        <div key={i} className="contents">
          <dt className="text-muted">{k}</dt>
          <dd className="min-w-0 break-words">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * Small dependency-free charts. Single series only, so no legend is needed;
 * the title above the chart names the measure.
 */
export function BarChart({ data, height = 160, format = (n: number) => String(n) }: { data: { label: string; value: number }[]; height?: number; format?: (n: number) => string }) {
  const max = Math.max(1, ...data.map((d) => d.value));
  if (!data.length) return <div className="py-8 text-center text-sm text-muted">No data for this period</div>;
  const step = Math.ceil(data.length / 8);
  return (
    <div>
      <div className="flex items-end gap-px" style={{ height }} role="img" aria-label={`Bar chart, ${data.length} points, maximum ${format(max)}`}>
        {data.map((d, i) => (
          <div key={i} className="group relative flex h-full flex-1 items-end">
            <div className="w-full rounded-t-sm bg-accent/80 transition-colors group-hover:bg-accent-hover" style={{ height: `${Math.max(d.value ? 2 : 0, (d.value / max) * 100)}%` }} />
            <div className="pointer-events-none absolute bottom-full left-1/2 z-10 mb-1 hidden -translate-x-1/2 whitespace-nowrap rounded-md border border-line-strong bg-raised px-2 py-1 text-xs shadow-pop group-hover:block">
              <span className="text-muted">{d.label}</span> <span className="font-semibold tabular-nums">{format(d.value)}</span>
            </div>
          </div>
        ))}
      </div>
      <div className="mt-1.5 flex justify-between text-[11px] text-faint">
        {data.filter((_, i) => i % step === 0).map((d, i) => <span key={i}>{d.label}</span>)}
      </div>
    </div>
  );
}

/** Horizontal ranked bars ("top series", "reader countries"). */
export function RankList({ items, format = (n: number) => String(n) }: { items: { label: ReactNode; value: number }[]; format?: (n: number) => string }) {
  const max = Math.max(1, ...items.map((i) => i.value));
  if (!items.length) return <div className="py-6 text-center text-sm text-muted">No data for this period</div>;
  return (
    <ul className="space-y-2">
      {items.map((it, i) => (
        <li key={i} className="text-sm">
          <div className="mb-1 flex justify-between gap-3">
            <span className="min-w-0 truncate">{it.label}</span>
            <span className="tabular-nums text-muted">{format(it.value)}</span>
          </div>
          <div className="h-1.5 overflow-hidden rounded-full bg-raised">
            <div className="h-full rounded-full bg-accent" style={{ width: `${(it.value / max) * 100}%` }} />
          </div>
        </li>
      ))}
    </ul>
  );
}

export function ProgressBar({ value, max, label }: { value: number; max: number; label?: ReactNode }) {
  const pct = max > 0 ? Math.min(100, (value / max) * 100) : 0;
  return (
    <div>
      {label && <div className="mb-1.5 text-sm text-muted">{label}</div>}
      <div className="h-2 overflow-hidden rounded-full bg-raised" role="progressbar" aria-valuenow={Math.round(pct)} aria-valuemin={0} aria-valuemax={100}>
        <div className="h-full rounded-full bg-accent transition-all" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}
