import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { ChevronDown, SearchX, SlidersHorizontal, X } from 'lucide-react';
import { useState } from 'react';
import { useSearchParams } from 'react-router';
import { api, errorMessage } from '@/lib/api';
import { number } from '@/lib/format';
import { languageLabel, useSession } from '@/lib/session';
import { Button, Checkbox, EmptyState, ErrorState, Modal, Pagination, Select, cx } from '@/ui';
import { CoverCard, CoverGrid } from './cards';
import type { SeriesCard } from './cards';
import { GridSkeleton, useTitle } from './shared';

type Result = { items: SeriesCard[]; total: number; page: number; limit: number; sort: string };

/** Filters that hold a comma-separated list in the URL, named as GET /api/series reads them. */
const LIST_KEYS = ['type', 'genre', 'themes', 'eras', 'audience', 'art_style', 'status', 'language'] as const;
type ListKey = (typeof LIST_KEYS)[number];

const ACCESS = [
  { value: '', label: 'Everything' },
  { value: 'free', label: 'Free to read' },
  { value: 'membership', label: 'In the membership' },
  { value: 'premium', label: 'Paid' },
];

const SORTS = [
  { value: 'relevance', label: 'Best match' },
  { value: 'new', label: 'Newest releases' },
  { value: 'popular', label: 'Most read' },
  { value: 'updated', label: 'Recently updated' },
  { value: 'title', label: 'Title A to Z' },
];

const sentence = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

function Group({ title, count, children, defaultOpen }: { title: string; count: number; children: React.ReactNode; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(Boolean(defaultOpen) || count > 0);
  return (
    <div className="border-b border-line last:border-0">
      <button type="button" aria-expanded={open} onClick={() => setOpen((o) => !o)} className="flex min-h-11 w-full items-center justify-between gap-2 py-2 text-left text-sm font-semibold">
        <span>{title}{count > 0 && <span className="ml-2 rounded-full bg-accent-soft px-1.5 py-0.5 text-[11px] text-accent-hover">{count}</span>}</span>
        <ChevronDown className={cx('size-4 text-muted transition-transform', open && 'rotate-180')} aria-hidden />
      </button>
      {open && <div className="max-h-64 space-y-2.5 overflow-y-auto pb-4 pr-1">{children}</div>}
    </div>
  );
}

export function Browse() {
  const { meta, settings } = useSession();
  const [params, setParams] = useSearchParams();
  const [sheet, setSheet] = useState(false);

  const q = params.get('q') ?? '';
  const access = params.get('access') ?? '';
  const onSale = params.get('on_sale') === '1';
  const page = Math.max(1, Number(params.get('page')) || 1);
  const sort = params.get('sort') ?? (q ? 'relevance' : 'new');
  const lists = Object.fromEntries(LIST_KEYS.map((k) => [k, (params.get(k) ?? '').split(',').filter(Boolean)])) as Record<ListKey, string[]>;

  useTitle(q ? `Search: ${q}` : 'Browse comics');

  /** Change filters; anything but a page change goes back to page 1. */
  const update = (changes: Record<string, string | null>) => {
    const next = new URLSearchParams(params);
    if (!('page' in changes)) next.delete('page');
    for (const [k, v] of Object.entries(changes)) {
      if (v === null || v === '') next.delete(k);
      else next.set(k, v);
    }
    setParams(next, { preventScrollReset: !('page' in changes) });
  };
  const toggle = (key: ListKey, value: string) => {
    const cur = lists[key];
    update({ [key]: (cur.includes(value) ? cur.filter((v) => v !== value) : [...cur, value]).join(',') });
  };

  const query = {
    q, sort: params.get('sort') ?? undefined, page, access, on_sale: onSale ? '1' : undefined,
    ...Object.fromEntries(LIST_KEYS.map((k) => [k, lists[k].join(',')])),
  };
  const result = useQuery({ queryKey: ['browse', query], queryFn: () => api<Result>('/api/series', { query }), placeholderData: keepPreviousData });

  const groups: { key: ListKey; title: string; options: { value: string; label: string }[] }[] = [
    { key: 'type', title: 'Format', options: meta.seriesTypes.map((t) => ({ value: t.id, label: t.label })) },
    { key: 'genre', title: 'Genre', options: meta.genres.map((g) => ({ value: g, label: g })) },
    { key: 'themes', title: 'Themes', options: meta.themes.map((g) => ({ value: g, label: g })) },
    { key: 'eras', title: 'Era', options: meta.eras.map((g) => ({ value: g, label: g })) },
    { key: 'audience', title: 'Audience', options: meta.audiences.map((g) => ({ value: g, label: g })) },
    { key: 'art_style', title: 'Art style', options: meta.artStyles.map((g) => ({ value: g, label: g })) },
    { key: 'status', title: 'Status', options: meta.seriesStatuses.map((s) => ({ value: s, label: sentence(s) })) },
    { key: 'language', title: 'Language', options: meta.languages.map((l) => ({ value: l.code, label: l.label })) },
  ];
  const labelFor = (key: ListKey, value: string) => (key === 'language' ? languageLabel(meta, value) : groups.find((g) => g.key === key)?.options.find((o) => o.value === value)?.label ?? value);

  const chips: { label: string; clear: () => void }[] = [
    ...(access ? [{ label: ACCESS.find((a) => a.value === access)?.label ?? access, clear: () => update({ access: null }) }] : []),
    ...(onSale ? [{ label: 'On sale', clear: () => update({ on_sale: null }) }] : []),
    ...LIST_KEYS.flatMap((k) => lists[k].map((v) => ({ label: labelFor(k, v), clear: () => toggle(k, v) }))),
  ];
  const clearAll = () => {
    const next = new URLSearchParams();
    if (q) next.set('q', q);
    if (params.get('sort')) next.set('sort', params.get('sort')!);
    setParams(next, { preventScrollReset: true });
  };

  const panel = (
    <div>
      <Group title="Price" count={(access ? 1 : 0) + (onSale ? 1 : 0)} defaultOpen>
        <div role="radiogroup" aria-label="Price" className="space-y-1">
          {ACCESS.map((a) => (
            <label key={a.value} className="flex min-h-9 cursor-pointer items-center gap-2.5 text-sm">
              <input type="radio" name="access" className="size-4 accent-accent" checked={access === a.value} onChange={() => update({ access: a.value })} />
              {a.value === 'membership' ? `In ${settings.membership.name}` : a.label}
            </label>
          ))}
        </div>
        <div className="pt-1"><Checkbox checked={onSale} onChange={(v) => update({ on_sale: v ? '1' : null })} label="On sale now" /></div>
      </Group>
      {groups.map((g) => (
        <Group key={g.key} title={g.title} count={lists[g.key].length}>
          {g.options.map((o) => <Checkbox key={o.value} checked={lists[g.key].includes(o.value)} onChange={() => toggle(g.key, o.value)} label={o.label} />)}
        </Group>
      ))}
    </div>
  );

  const data = result.data;
  const pages = data ? Math.ceil(data.total / data.limit) : 0;

  return (
    <div>
      <header className="mb-5 flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <h1 className="break-words text-2xl font-bold sm:text-3xl">{q ? <>Results for “{q}”</> : 'Browse comics'}</h1>
          <p className="mt-1 text-sm text-muted" aria-live="polite">
            {data ? `${number(data.total)} ${data.total === 1 ? 'series' : 'series'}${chips.length ? ' match your filters' : ''}` : 'Searching…'}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button className="lg:hidden" icon={<SlidersHorizontal className="size-4" />} onClick={() => setSheet(true)}>
            Filters{chips.length > 0 && ` (${chips.length})`}
          </Button>
          <label className="flex items-center gap-2 text-sm text-muted">
            <span className="hidden sm:inline">Sort by</span>
            <span className="w-44">
              <Select aria-label="Sort by" value={sort} onChange={(e) => update({ sort: e.target.value })}>
                {SORTS.filter((s) => s.value !== 'relevance' || q).map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
              </Select>
            </span>
          </label>
        </div>
      </header>

      <div className="grid gap-8 lg:grid-cols-[230px_minmax(0,1fr)]">
        <aside className="hidden lg:block" aria-label="Filters">
          <div className="sticky top-20 max-h-[calc(100dvh-6rem)] overflow-y-auto rounded-2xl border border-line bg-surface px-4 py-1">{panel}</div>
        </aside>

        <div className="min-w-0">
          {chips.length > 0 && (
            <div className="mb-4 flex flex-wrap items-center gap-2">
              {chips.map((c) => (
                <button key={c.label} type="button" onClick={c.clear} className="inline-flex h-8 items-center gap-1.5 rounded-full border border-line bg-raised pl-3 pr-2 text-[13px] hover:border-line-strong" aria-label={`Remove filter ${c.label}`}>
                  {c.label}<X className="size-3.5 text-muted" aria-hidden />
                </button>
              ))}
              <button type="button" onClick={clearAll} className="link h-8 px-1 text-[13px]">Clear all</button>
            </div>
          )}

          {result.isLoading ? (
            <GridSkeleton />
          ) : result.isError || !data ? (
            <ErrorState message={errorMessage(result.error)} retry={() => void result.refetch()} />
          ) : data.items.length === 0 ? (
            <EmptyState icon={<SearchX />} title={q ? `Nothing found for “${q}”` : 'No series match these filters'} action={chips.length > 0 ? <Button onClick={clearAll}>Clear filters</Button> : undefined}>
              {chips.length > 0 ? 'Try removing a filter or two.' : q ? 'Check the spelling, or try a creator name, a genre or a single word from the title.' : 'Nothing has been published yet.'}
            </EmptyState>
          ) : (
            <div className={cx('transition-opacity', result.isPlaceholderData && 'opacity-60')}>
              <CoverGrid className="lg:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-6">
                {data.items.map((s) => <CoverCard key={s.id} series={s} />)}
              </CoverGrid>
              <Pagination page={data.page} pages={pages} onPage={(p) => update({ page: p > 1 ? String(p) : null })} />
            </div>
          )}
        </div>
      </div>

      <Modal
        open={sheet}
        onClose={() => setSheet(false)}
        title="Filters"
        footer={
          <>
            {chips.length > 0 && <Button variant="ghost" onClick={clearAll}>Clear all</Button>}
            <Button variant="primary" onClick={() => setSheet(false)}>Show {data ? number(data.total) : ''} results</Button>
          </>
        }
      >
        {panel}
      </Modal>
    </div>
  );
}
