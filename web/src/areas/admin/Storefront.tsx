import { useQueryClient } from '@tanstack/react-query';
import { ArrowDown, ArrowUp, ExternalLink, ImagePlus, Inbox, LayoutTemplate, Megaphone, Newspaper, Pencil, Trash2, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { api, errorMessage, upload } from '@/lib/api';
import { ago, date, dateTime, number } from '@/lib/format';
import { Markdown } from '@/lib/markdown';
import {
  Badge, Button, Card, EmptyState, ErrorState, Field, FormRow, IconButton, Input, LinkButton, Modal, PageHeader, Pagination, Segmented, Skeleton, Switch, Table,
  Tabs, Textarea, buttonClass, cx, toast, useConfirm,
} from '@/ui';
import {
  DataList, FilterBar, FilterSelect, Group, Loaded, SearchInput, Section, fromLocalInput, toLocalInput, useAct, useAdminQuery, useFilters, useList, useTitle,
} from './shared';
import type { R } from './shared';

/** File picker button that uploads one image as multipart field "file". */
function ImageUpload({ path, label, onDone }: { path: string; label: string; onDone?: () => void }) {
  const qc = useQueryClient();
  const input = useRef<HTMLInputElement>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const pick = async (file: File | undefined) => {
    if (!file) return;
    const form = new FormData();
    form.append('file', file);
    setProgress(0);
    try {
      await upload(path, form, setProgress);
      toast.success('Image uploaded');
      await qc.invalidateQueries({ queryKey: ['admin'] });
      onDone?.();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setProgress(null);
      if (input.current) input.current.value = '';
    }
  };
  return (
    <>
      <input ref={input} type="file" accept="image/jpeg,image/png,image/webp,image/avif" className="sr-only" tabIndex={-1} aria-hidden onChange={(e) => void pick(e.target.files?.[0])} />
      <Button size="sm" loading={progress !== null} icon={<ImagePlus className="size-4" />} onClick={() => input.current?.click()}>
        {progress !== null ? `Uploading ${Math.round(progress * 100)}%` : label}
      </Button>
    </>
  );
}

function scheduleLabel(starts: string | null, ends: string | null): string {
  const now = Date.now();
  if (starts && Date.parse(starts) > now) return `Starts ${dateTime(starts)}`;
  if (ends && Date.parse(ends) <= now) return `Ended ${dateTime(ends)}`;
  if (ends) return `Until ${dateTime(ends)}`;
  return 'No end date';
}

// ---------------------------------------------------------------- hero, staff picks, spotlight

const SLOTS: { slot: string; title: string; description: string }[] = [
  { slot: 'hero', title: 'Hero carousel', description: 'The large rotating banner at the top of the store. A slide is a series, or a custom card with your own image, headline and link.' },
  { slot: 'staff_picks', title: 'Staff picks', description: 'A row of series chosen by the team.' },
  { slot: 'spotlight', title: 'Spotlight', description: 'A second curated row, for a theme, an event or a season.' },
];

function SeriesPicker({ value, onPick }: { value: R | null; onPick: (s: R | null) => void }) {
  const [q, setQ] = useState('');
  const results = useList('/api/admin/series', { q, visibility: 'public', takedown: '0', limit: 8, sort: 'reads' }, !value);
  if (value) {
    return (
      <div className="flex items-center gap-3 rounded-xl border border-line bg-ink p-2.5">
        {value.cover_url ? <img src={value.cover_url} alt="" className="aspect-[2/3] w-10 rounded border border-line object-cover" /> : <span className="aspect-[2/3] w-10 rounded border border-line bg-raised" />}
        <span className="min-w-0 flex-1"><span className="block truncate font-medium">{value.title}</span><span className="block truncate text-xs text-muted">{value.publisher_name}</span></span>
        <IconButton label="Choose a different series" onClick={() => onPick(null)}><X className="size-4" /></IconButton>
      </div>
    );
  }
  return (
    <div>
      <SearchInput value={q} onChange={setQ} placeholder="Search public series by title or brand" />
      <ul className="mt-2 max-h-64 overflow-auto rounded-xl border border-line">
        {results.isPending && <li className="px-3 py-3 text-sm text-muted">Searching…</li>}
        {results.isError && <li className="px-3 py-3 text-sm text-danger">{errorMessage(results.error)}</li>}
        {results.data?.items.length === 0 && <li className="px-3 py-3 text-sm text-muted">No public series match. Only public series that are not taken down can be featured.</li>}
        {results.data?.items.map((s) => (
          <li key={s.id} className="border-b border-line last:border-0">
            <button type="button" onClick={() => onPick(s)} className="flex w-full items-center gap-3 px-3 py-2 text-left hover:bg-hover">
              {s.cover_url ? <img src={s.cover_url} alt="" loading="lazy" className="aspect-[2/3] w-8 rounded border border-line object-cover" /> : <span className="aspect-[2/3] w-8 rounded border border-line bg-raised" />}
              <span className="min-w-0"><span className="block truncate text-sm font-medium">{s.title}</span><span className="block truncate text-xs text-muted">{s.publisher_name}</span></span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function FeaturedForm({ slot, item, onClose }: { slot: string; item: R | null; onClose: () => void }) {
  const { run, busy } = useAct();
  const isHero = slot === 'hero';
  const [mode, setMode] = useState<'series' | 'custom'>(item && !item.series_id ? 'custom' : 'series');
  const [series, setSeries] = useState<R | null>(item?.series_id ? { id: item.series_id, title: item.series_title, cover_url: item.series_cover_url, publisher_name: '' } : null);
  const [v, setV] = useState({ headline: item?.headline ?? '', blurb: item?.blurb ?? '', url: item?.url ?? '', starts: toLocalInput(item?.starts_at), ends: toLocalInput(item?.ends_at) });
  const set = (p: Partial<typeof v>) => setV((c) => ({ ...c, ...p }));
  const submit = () => {
    if (mode === 'series' && !series) return void toast.error('Choose a series first.');
    if (mode === 'custom' && (!v.headline.trim() || !v.url.trim())) return void toast.error('A custom card needs a headline and a link.');
    const body: R = {
      slot,
      series_id: mode === 'series' ? series!.id : null,
      headline: v.headline.trim() || null,
      blurb: v.blurb.trim(),
      url: v.url.trim() || null,
      starts_at: fromLocalInput(v.starts),
      ends_at: fromLocalInput(v.ends),
    };
    void run({
      key: 'featured',
      fn: () => (item ? api(`/api/admin/featured/${item.id}`, { method: 'PATCH', json: body }) : api('/api/admin/featured', { json: body })),
      ok: item ? 'Saved' : mode === 'custom' ? 'Card added. Upload its image next.' : 'Added',
      onDone: onClose,
    });
  };
  return (
    <Modal open onClose={onClose} title={item ? 'Edit featured item' : 'Add to the store front'} footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" loading={busy === 'featured'} onClick={submit}>{item ? 'Save' : 'Add'}</Button></>}>
      <div className="space-y-4">
        {isHero && (
          <Segmented value={mode} onChange={setMode} options={[{ value: 'series', label: 'A series' }, { value: 'custom', label: 'Custom card' }]} />
        )}
        {mode === 'series' && <Group label="Series"><SeriesPicker value={series} onPick={setSeries} /></Group>}
        {(isHero || mode === 'custom') && (
          <>
            <Field label="Headline" optional={mode === 'series'} hint={mode === 'series' ? 'Leave empty to use the series title.' : undefined}><Input value={v.headline} maxLength={160} onChange={(e) => set({ headline: e.target.value })} /></Field>
            <Field label="Short text" optional><Textarea value={v.blurb} maxLength={600} onChange={(e) => set({ blurb: e.target.value })} className="min-h-20" /></Field>
            <Field label="Link" optional={mode === 'series'} hint={mode === 'series' ? 'Leave empty to link to the series.' : 'A page on this site such as /unlimited, or a full https:// address.'}><Input value={v.url} onChange={(e) => set({ url: e.target.value })} placeholder="/unlimited" /></Field>
          </>
        )}
        <FormRow>
          <Field label="Show from" optional hint="Empty means straight away."><Input type="datetime-local" value={v.starts} onChange={(e) => set({ starts: e.target.value })} /></Field>
          <Field label="Show until" optional hint="Empty means until you remove it."><Input type="datetime-local" value={v.ends} onChange={(e) => set({ ends: e.target.value })} /></Field>
        </FormRow>
        {mode === 'custom' && !item && <p className="text-sm text-muted">You can upload the card's image as soon as it is added.</p>}
      </div>
    </Modal>
  );
}

export function FeaturedPage() {
  useTitle('Hero & featured');
  const q = useAdminQuery<{ items: R[] }>('/api/admin/featured');
  const { run, busy, anyBusy } = useAct();
  const confirm = useConfirm();
  const [form, setForm] = useState<{ slot: string; item: R | null } | null>(null);

  const move = (slot: string, items: R[], index: number, by: number) => {
    const ids = items.map((i) => i.id);
    [ids[index], ids[index + by]] = [ids[index + by], ids[index]];
    void run({ key: `order-${slot}`, fn: () => api('/api/admin/featured/reorder', { json: { slot, ids } }) });
  };

  return (
    <>
      <PageHeader title="Hero & featured" description="Choose what the store front leads with. Changes show on the store straight away." />
      <Loaded query={q}>
        {(d) => (
          <div className="space-y-5">
            {SLOTS.map(({ slot, title, description }) => {
              const items = d.items.filter((i) => i.slot === slot);
              return (
                <Section key={slot} title={title} description={description} actions={<Button onClick={() => setForm({ slot, item: null })}>Add {slot === 'hero' ? 'a slide' : 'a series'}</Button>}>
                  {items.length === 0 ? (
                    <EmptyState icon={<LayoutTemplate />} title="Nothing here yet" action={<Button onClick={() => setForm({ slot, item: null })}>Add {slot === 'hero' ? 'a slide' : 'a series'}</Button>}>
                      {slot === 'hero' ? 'Until you add a slide the store shows no banner.' : 'This row is hidden on the store while it is empty.'}
                    </EmptyState>
                  ) : (
                    <ul className="space-y-2">
                      {items.map((it, i) => {
                        const img = it.image_url ?? it.series_cover_url;
                        const hidden = it.series_id && (it.series_visibility !== 'public' || it.series_takedown_at);
                        return (
                          <li key={it.id} className="flex flex-wrap items-center gap-3 rounded-xl border border-line bg-ink p-2.5">
                            <span className="flex flex-col">
                              <IconButton label="Move up" className="size-8" disabled={i === 0 || anyBusy} onClick={() => move(slot, items, i, -1)}><ArrowUp className="size-4" /></IconButton>
                              <IconButton label="Move down" className="size-8" disabled={i === items.length - 1 || anyBusy} onClick={() => move(slot, items, i, 1)}><ArrowDown className="size-4" /></IconButton>
                            </span>
                            {img
                              ? <img src={img} alt="" loading="lazy" className={cx('h-16 shrink-0 rounded border border-line object-cover', it.image_url ? 'aspect-video' : 'aspect-[2/3]')} />
                              : <span className="flex aspect-video h-16 shrink-0 items-center justify-center rounded border border-dashed border-line-strong text-xs text-faint">No image</span>}
                            <div className="min-w-0 flex-1 basis-48">
                              <div className="truncate font-medium">{it.headline || it.series_title || 'Untitled'}</div>
                              <div className="truncate text-xs text-muted">{it.series_id ? `Series: ${it.series_title}` : `Custom card linking to ${it.url}`}</div>
                              <div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-muted">
                                {hidden ? <Badge tone="danger">Series not public</Badge> : it.live ? <Badge tone="ok">Showing</Badge> : <Badge tone="info">Not showing</Badge>}
                                {scheduleLabel(it.starts_at, it.ends_at)}
                              </div>
                            </div>
                            <span className="flex items-center gap-1.5">
                              {slot === 'hero' && <ImageUpload path={`/api/admin/featured/${it.id}/image`} label={it.image_url ? 'Replace image' : 'Upload image'} />}
                              <IconButton label="Edit" onClick={() => setForm({ slot, item: it })}><Pencil className="size-4" /></IconButton>
                              <IconButton label="Remove" disabled={busy === it.id} onClick={async () => {
                                if (await confirm({ title: `Remove "${it.headline || it.series_title}"?`, body: `It leaves the ${title.toLowerCase()} on the store. The series itself is not affected.`, confirmLabel: 'Remove', danger: true })) void run({ key: it.id, fn: () => api(`/api/admin/featured/${it.id}`, { method: 'DELETE' }), ok: 'Removed' });
                              }}><Trash2 className="size-4" /></IconButton>
                            </span>
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </Section>
              );
            })}
          </div>
        )}
      </Loaded>
      {form && <FeaturedForm slot={form.slot} item={form.item} onClose={() => setForm(null)} />}
    </>
  );
}

// ---------------------------------------------------------------- announcements

/** The same look as the bar the shell draws above the top navigation. */
function BarPreview({ headline, body, cta }: { headline: string; body: string; cta: string }) {
  return (
    <div className="flex items-center justify-center gap-3 rounded-lg bg-accent px-4 py-2 text-center text-sm font-semibold text-accent-ink">
      <span className="min-w-0">{headline || 'Your headline'}{body ? <span className="font-normal"> — {body}</span> : null}</span>
      {cta && <span className={buttonClass('sun', 'sm')}>{cta}</span>}
      <X className="size-4 shrink-0" aria-hidden />
    </div>
  );
}

function ModalPreview({ headline, body, cta, image }: { headline: string; body: string; cta: string; image?: string | null }) {
  return (
    <div className="mx-auto max-w-sm rounded-2xl border border-line-strong bg-surface shadow-pop">
      <div className="flex items-center justify-between border-b border-line px-5 py-3.5"><span className="font-display text-lg font-semibold">{headline || 'Your headline'}</span><X className="size-5 text-muted" aria-hidden /></div>
      <div className="px-5 py-5">
        {image && <img src={image} alt="" className="mb-4 w-full rounded-xl" />}
        <p className="whitespace-pre-line text-muted">{body || 'Your message'}</p>
      </div>
      {cta && <div className="flex justify-end border-t border-line px-5 py-3.5"><span className={buttonClass('primary', 'lg')}>{cta}</span></div>}
    </div>
  );
}

function AnnouncementForm({ item, onClose }: { item: R | null; onClose: () => void }) {
  const { run, busy } = useAct();
  const [v, setV] = useState({
    kind: (item?.kind ?? 'bar') as 'bar' | 'modal', headline: item?.headline ?? '', body: item?.body ?? '', cta_label: item?.cta_label ?? '', cta_url: item?.cta_url ?? '',
    starts: toLocalInput(item?.starts_at), ends: toLocalInput(item?.ends_at), active: item?.active ?? true,
  });
  const set = (p: Partial<typeof v>) => setV((c) => ({ ...c, ...p }));
  const submit = () => {
    if (!v.headline.trim()) return void toast.error('Write a headline.');
    if (Boolean(v.cta_label.trim()) !== Boolean(v.cta_url.trim())) return void toast.error('A button needs both a label and a link.');
    const body: R = {
      kind: v.kind, headline: v.headline.trim(), body: v.body.trim(), cta_label: v.cta_label.trim() || null, cta_url: v.cta_url.trim() || null,
      ends_at: fromLocalInput(v.ends), active: v.active,
    };
    const starts = fromLocalInput(v.starts);
    if (starts) body.starts_at = starts;
    void run({
      key: 'ann',
      fn: () => (item ? api(`/api/admin/announcements/${item.id}`, { method: 'PATCH', json: body }) : api('/api/admin/announcements', { json: body })),
      ok: item ? 'Announcement saved' : 'Announcement created',
      onDone: onClose,
    });
  };
  return (
    <Modal open onClose={onClose} size="lg" title={item ? 'Edit announcement' : 'New announcement'} footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" loading={busy === 'ann'} onClick={submit}>{item ? 'Save' : 'Create'}</Button></>}>
      <div className="space-y-4">
        <Group label="Where it shows">
          <Segmented value={v.kind} onChange={(kind) => set({ kind })} options={[{ value: 'bar', label: 'Bar across the top' }, { value: 'modal', label: 'Pop-up, shown once per visitor' }]} />
        </Group>
        <Field label="Headline"><Input value={v.headline} maxLength={200} onChange={(e) => set({ headline: e.target.value })} /></Field>
        <Field label={v.kind === 'bar' ? 'Extra text' : 'Message'} optional><Textarea value={v.body} maxLength={2000} onChange={(e) => set({ body: e.target.value })} className={v.kind === 'bar' ? 'min-h-16' : 'min-h-28'} /></Field>
        <FormRow>
          <Field label="Button label" optional><Input value={v.cta_label} maxLength={60} onChange={(e) => set({ cta_label: e.target.value })} placeholder="Become a member" /></Field>
          <Field label="Button link" optional hint="A page such as /unlimited, or a full https:// address."><Input value={v.cta_url} onChange={(e) => set({ cta_url: e.target.value })} placeholder="/unlimited" /></Field>
        </FormRow>
        <FormRow>
          <Field label="Show from" optional hint="Empty means now."><Input type="datetime-local" value={v.starts} onChange={(e) => set({ starts: e.target.value })} /></Field>
          <Field label="Show until" optional hint="Empty means until you turn it off."><Input type="datetime-local" value={v.ends} onChange={(e) => set({ ends: e.target.value })} /></Field>
        </FormRow>
        <Switch checked={v.active} onChange={(active) => set({ active })} label="Turned on" description="Turn off to keep the announcement without showing it." />
        <div>
          <div className="mb-2 text-[13px] font-medium">Preview</div>
          <div className="rounded-xl border border-dashed border-line-strong bg-ink p-4">
            {v.kind === 'bar' ? <BarPreview headline={v.headline} body={v.body} cta={v.cta_label} /> : <ModalPreview headline={v.headline} body={v.body} cta={v.cta_label} image={item?.image_url} />}
          </div>
          {v.kind === 'modal' && <p className="mt-2 text-xs text-faint">{item ? 'Add or replace the picture from the list after saving.' : 'You can add a picture from the list once it is created.'}</p>}
        </div>
      </div>
    </Modal>
  );
}

export function AnnouncementsPage() {
  useTitle('Announcements');
  const q = useAdminQuery<{ items: R[] }>('/api/admin/announcements');
  const { run, busy } = useAct();
  const confirm = useConfirm();
  const qc = useQueryClient();
  const [form, setForm] = useState<{ item: R | null } | null>(null);
  // The shell caches the public list for five minutes; refresh it so the admin sees the change.
  const refreshShell = () => void qc.invalidateQueries({ queryKey: ['announcements'] });
  return (
    <>
      <PageHeader
        title="Announcements"
        description="A bar across the top of every page, or a pop-up each visitor sees once. If several are live, the newest of each kind is shown."
        actions={<Button variant="primary" onClick={() => setForm({ item: null })}>New announcement</Button>}
      />
      <Loaded query={q}>
        {(d) => d.items.length === 0 ? (
          <EmptyState icon={<Megaphone />} title="No announcements yet" action={<Button onClick={() => setForm({ item: null })}>New announcement</Button>}>
            Tell readers about a sale, a launch or planned downtime.
          </EmptyState>
        ) : (
          <div className="space-y-3">
            {d.items.map((a) => (
              <Card key={a.id} className="p-4">
                <div className="mb-3 flex flex-wrap items-center gap-2">
                  <Badge tone="info">{a.kind === 'bar' ? 'Top bar' : 'Pop-up'}</Badge>
                  {a.live ? <Badge tone="ok">Live now</Badge> : !a.active ? <Badge>Turned off</Badge> : Date.parse(a.starts_at) > Date.now() ? <Badge tone="warn">Scheduled</Badge> : <Badge>Ended</Badge>}
                  <span className="text-xs text-muted">{a.active ? scheduleLabel(a.starts_at, a.ends_at) : `Created ${date(a.created_at)}`}</span>
                  <span className="ml-auto flex flex-wrap items-center gap-1.5">
                    {a.kind === 'modal' && <ImageUpload path={`/api/admin/announcements/${a.id}/image`} label={a.image_url ? 'Replace picture' : 'Add picture'} onDone={refreshShell} />}
                    <Button size="sm" loading={busy === `t-${a.id}`} onClick={() => run({ key: `t-${a.id}`, fn: () => api(`/api/admin/announcements/${a.id}`, { method: 'PATCH', json: { active: !a.active } }), ok: a.active ? 'Turned off' : 'Turned on', onDone: refreshShell })}>{a.active ? 'Turn off' : 'Turn on'}</Button>
                    <IconButton label="Edit" onClick={() => setForm({ item: a })}><Pencil className="size-4" /></IconButton>
                    <IconButton label="Delete" disabled={busy === a.id} onClick={async () => {
                      if (await confirm({ title: 'Delete this announcement?', body: `"${a.headline}" is removed for good.`, confirmLabel: 'Delete', danger: true })) void run({ key: a.id, fn: () => api(`/api/admin/announcements/${a.id}`, { method: 'DELETE' }), ok: 'Announcement deleted', onDone: refreshShell });
                    }}><Trash2 className="size-4" /></IconButton>
                  </span>
                </div>
                {a.kind === 'bar' ? <BarPreview headline={a.headline} body={a.body} cta={a.cta_label ?? ''} /> : (
                  <div className="text-sm"><span className="font-semibold">{a.headline}</span>{a.body && <span className="text-muted"> — {a.body}</span>}{a.cta_label && <span className="text-muted"> · Button: {a.cta_label} → {a.cta_url}</span>}</div>
                )}
              </Card>
            ))}
          </div>
        )}
      </Loaded>
      {form && <AnnouncementForm item={form.item} onClose={() => { setForm(null); refreshShell(); }} />}
    </>
  );
}

// ---------------------------------------------------------------- CMS pages

const PAGE_NAMES: Record<string, string> = {
  about: 'About', 'creator-promise': 'The creator promise', contact: 'Contact', 'content-policy': 'Content policy', 'publisher-sla': 'Publisher SLA', privacy: 'Privacy policy', 'privacy-choices': 'Your privacy choices',
  terms: 'Terms of service', 'publisher-terms': 'Publisher terms', faq: 'FAQ',
};

export function PagesPage() {
  useTitle('Pages');
  const nav = useNavigate();
  const q = useAdminQuery<{ items: R[] }>('/api/admin/pages');
  return (
    <>
      <PageHeader title="Pages" description="The information and legal pages linked from the footer. The list is fixed; you write what each one says." />
      <Loaded query={q}>
        {(d) => (
          <Table
            rowKey={(p: R) => p.slug}
            rows={d.items}
            onRowClick={(p: R) => nav(`/admin/pages/${p.slug}`)}
            columns={[
              { key: 'page', header: 'Page', cell: (p: R) => <><span className="font-medium">{PAGE_NAMES[p.slug] ?? p.slug}</span> <span className="text-xs text-muted">/p/{p.slug}</span></> },
              { key: 'state', header: 'Status', cell: (p: R) => (p.length > 0 ? <Badge tone="ok">Written</Badge> : <Badge tone="warn">Empty</Badge>) },
              { key: 'len', header: 'Length', align: 'right', cell: (p: R) => (p.length ? `${number(p.length)} characters` : '—'), hideOnMobile: true },
              { key: 'updated', header: 'Last edited', cell: (p: R) => <span className="text-muted">{p.updated_at ? `${ago(p.updated_at)}${p.updated_by_username ? ` by @${p.updated_by_username}` : ''}` : 'Never'}</span> },
              { key: 'edit', header: '', cell: () => <span className="text-accent-hover">Edit</span> },
            ]}
          />
        )}
      </Loaded>
    </>
  );
}

/** Markdown textarea with a live preview beside it (below it on small screens). */
function MarkdownEditor({ value, onChange, label }: { value: string; onChange: (v: string) => void; label: string }) {
  const [view, setView] = useState<'write' | 'preview'>('write');
  return (
    <div>
      <div className="mb-2 flex items-center justify-between gap-3">
        <span className="text-[13px] font-medium">{label}</span>
        <span className="xl:hidden"><Segmented size="sm" value={view} onChange={setView} options={[{ value: 'write', label: 'Write' }, { value: 'preview', label: 'Preview' }]} /></span>
      </div>
      <div className="grid gap-4 xl:grid-cols-2">
        <div className={cx(view === 'preview' && 'hidden xl:block')}>
          <Textarea aria-label={label} value={value} onChange={(e) => onChange(e.target.value)} className="min-h-[480px] font-mono text-[13px]" spellCheck />
          <p className="mt-1.5 text-xs text-faint">Markdown: ## heading, **bold**, *italic*, - list item, 1. numbered item, [link text](https://example.com).</p>
        </div>
        <div className={cx('min-h-40 rounded-xl border border-line bg-ink p-5 xl:max-h-[520px] xl:overflow-auto', view === 'write' && 'hidden xl:block')}>
          {value.trim() ? <Markdown source={value} /> : <p className="text-sm text-faint">The preview appears here as you write.</p>}
        </div>
      </div>
    </div>
  );
}

export function PageEditor() {
  const { slug = '' } = useParams();
  const name = PAGE_NAMES[slug] ?? slug;
  useTitle(`Edit ${name}`);
  const q = useAdminQuery<{ page: R }>(`/api/admin/pages/${slug}`);
  const { run, busy } = useAct();
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const loaded = useRef<string | null>(null);
  useEffect(() => {
    if (q.data && loaded.current !== slug) {
      loaded.current = slug;
      setTitle(q.data.page.title || name);
      setBody(q.data.page.body);
    }
  }, [q.data, slug, name]);
  const dirty = q.data ? title !== (q.data.page.title || name) || body !== q.data.page.body : false;
  const save = () => {
    if (!title.trim()) return void toast.error('Give the page a title.');
    void run({ key: 'page', fn: () => api<R>(`/api/admin/pages/${slug}`, { method: 'PUT', json: { title: title.trim(), body } }), ok: 'Page saved' });
  };
  return (
    <>
      <PageHeader
        back={<Link to="/admin/pages" className="hover:text-paper">← Pages</Link>}
        title={name}
        description={q.data?.page.updated_at ? `Last saved ${dateTime(q.data.page.updated_at)}` : 'This page has not been written yet.'}
        actions={
          <>
            <LinkButton to={`/p/${slug}`} external icon={<ExternalLink className="size-4" />}>View page</LinkButton>
            <Button variant="primary" loading={busy === 'page'} disabled={!dirty} onClick={save}>{dirty ? 'Save page' : 'Saved'}</Button>
          </>
        }
      />
      <Loaded query={q}>
        {() => (
          <div className="space-y-4">
            <Field label="Title"><Input value={title} maxLength={200} onChange={(e) => setTitle(e.target.value)} /></Field>
            <MarkdownEditor label="Page text" value={body} onChange={setBody} />
          </div>
        )}
      </Loaded>
    </>
  );
}

// ---------------------------------------------------------------- news

function newsState(n: R): ReactNode {
  if (!n.published_at) return <Badge>Draft</Badge>;
  return Date.parse(n.published_at) > Date.now() ? <Badge tone="info">Scheduled</Badge> : <Badge tone="ok">Published</Badge>;
}

export function NewsPage() {
  useTitle('News');
  const nav = useNavigate();
  const [f, setF] = useFilters({ q: '', status: '' });
  const list = useList('/api/admin/news', { q: f.q, status: f.status, page: f.page });
  return (
    <>
      <PageHeader title="News" description="Posts for the News section: launches, platform updates, creator spotlights." actions={<LinkButton to="/admin/news/new" variant="primary">Write a post</LinkButton>} />
      <FilterBar>
        <SearchInput value={f.q} onChange={(q) => setF({ q })} placeholder="Search by title" />
        <FilterSelect label="Status" value={f.status} onChange={(status) => setF({ status })} options={[['', 'All posts'], ['published', 'Published'], ['scheduled', 'Scheduled'], ['draft', 'Drafts']]} />
      </FilterBar>
      <DataList
        query={list}
        onRowClick={(n) => nav(`/admin/news/${n.id}`)}
        onPage={(page) => setF({ page })}
        empty={{ icon: <Newspaper />, title: 'No posts yet', hint: 'Write the first post. It stays a draft until you publish it.', action: <LinkButton to="/admin/news/new">Write a post</LinkButton> }}
        columns={[
          {
            key: 'post', header: 'Post',
            cell: (n) => (
              <span className="flex items-center gap-3">
                {n.cover_url ? <img src={n.cover_url} alt="" loading="lazy" className="aspect-video w-16 shrink-0 rounded border border-line object-cover" /> : <span className="aspect-video w-16 shrink-0 rounded border border-line bg-raised" />}
                <span className="min-w-0 max-w-[340px]"><span className="block truncate font-medium">{n.title}</span><span className="block truncate text-xs text-muted">{n.excerpt || `/news/${n.slug}`}</span></span>
              </span>
            ),
          },
          { key: 'state', header: 'Status', cell: newsState },
          { key: 'when', header: 'Publish date', cell: (n) => <span className="text-muted">{n.published_at ? dateTime(n.published_at) : '—'}</span> },
          { key: 'author', header: 'Author', cell: (n) => <span className="text-muted">{n.author_username ? `@${n.author_username}` : '—'}</span>, hideOnMobile: true },
        ]}
      />
    </>
  );
}

export function NewsEditor() {
  const { id = 'new' } = useParams();
  const isNew = id === 'new';
  const nav = useNavigate();
  const confirm = useConfirm();
  const { run, busy } = useAct();
  const [gone, setGone] = useState(false);
  const q = useAdminQuery<{ post: R }>(`/api/admin/news/${id}`, undefined, { enabled: !isNew && !gone });
  const post = q.data?.post;
  useTitle(isNew ? 'New post' : post?.title ?? 'Post');
  const [v, setV] = useState({ title: '', slug: '', excerpt: '', body: '', when: '' });
  const set = (p: Partial<typeof v>) => setV((c) => ({ ...c, ...p }));
  const loaded = useRef<string | null>(null);
  useEffect(() => {
    if (post && loaded.current !== post.id) {
      loaded.current = post.id;
      setV({ title: post.title, slug: post.slug, excerpt: post.excerpt ?? '', body: post.body ?? '', when: toLocalInput(post.published_at) });
    }
  }, [post]);

  const save = (published_at: string | null | undefined, ok: string) => {
    if (!v.title.trim()) return void toast.error('Give the post a title.');
    const body: R = { title: v.title.trim(), excerpt: v.excerpt.trim(), body: v.body };
    if (v.slug.trim()) body.slug = v.slug.trim();
    if (published_at !== undefined) body.published_at = published_at;
    void run({
      key: 'news',
      fn: () => (isNew ? api<{ post: R }>('/api/admin/news', { json: body }) : api<{ post: R }>(`/api/admin/news/${id}`, { method: 'PATCH', json: body })),
      ok,
      onDone: (r) => {
        setV((c) => ({ ...c, slug: r.post.slug, when: toLocalInput(r.post.published_at) }));
        if (isNew) nav(`/admin/news/${r.post.id}`, { replace: true });
      },
    });
  };
  const live = Boolean(post?.published_at && Date.parse(post.published_at) <= Date.now());
  const scheduled = Boolean(post?.published_at && !live);

  const form = (
    <div className="space-y-5">
      <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_300px]">
        <div className="space-y-4">
          <Field label="Title"><Input value={v.title} maxLength={200} onChange={(e) => set({ title: e.target.value })} /></Field>
          <Field label="Summary" optional hint="One or two sentences shown in the news list."><Textarea value={v.excerpt} maxLength={500} onChange={(e) => set({ excerpt: e.target.value })} className="min-h-20" /></Field>
          <Field label="Web address" optional hint={isNew ? 'Leave empty to make one from the title.' : 'Changing this breaks links that were already shared.'}>
            <span className="flex items-center gap-2"><span className="text-sm text-muted">/news/</span><Input value={v.slug} maxLength={80} onChange={(e) => set({ slug: e.target.value })} /></span>
          </Field>
        </div>
        <div className="space-y-4">
          <Card className="space-y-3 p-4">
            <div className="flex items-center justify-between"><span className="font-semibold">Publishing</span>{post ? newsState(post) : <Badge>Not saved</Badge>}</div>
            {live ? (
              <>
                <p className="text-sm text-muted">Published {dateTime(post!.published_at)}.</p>
                <Button block loading={busy === 'news'} onClick={async () => { if (await confirm({ title: 'Unpublish this post?', body: 'It goes back to being a draft and leaves the News section.', confirmLabel: 'Unpublish' })) save(null, 'Post unpublished'); }}>Unpublish</Button>
              </>
            ) : (
              <>
                <Field label="Schedule for" optional hint="Pick a future time, or leave empty and publish now."><Input type="datetime-local" value={v.when} onChange={(e) => set({ when: e.target.value })} /></Field>
                {v.when && Date.parse(v.when) > Date.now()
                  ? <Button block loading={busy === 'news'} onClick={() => save(fromLocalInput(v.when), 'Post scheduled')}>{scheduled ? 'Update schedule' : 'Schedule'}</Button>
                  : <Button block loading={busy === 'news'} onClick={() => save(new Date().toISOString(), 'Post published')}>Publish now</Button>}
                {scheduled && <Button block variant="ghost" onClick={() => save(null, 'Back to draft')}>Cancel schedule</Button>}
              </>
            )}
          </Card>
          <Card className="space-y-3 p-4">
            <span className="font-semibold">Cover image</span>
            {post?.cover_url ? <img src={post.cover_url} alt="" className="aspect-video w-full rounded-lg border border-line object-cover" /> : <div className="flex aspect-video items-center justify-center rounded-lg border border-dashed border-line-strong text-sm text-faint">No cover yet</div>}
            {isNew ? <p className="text-xs text-faint">Save the post first, then add a cover.</p> : <ImageUpload path={`/api/admin/news/${id}/cover`} label={post?.cover_url ? 'Replace cover' : 'Upload cover'} />}
          </Card>
        </div>
      </div>
      <MarkdownEditor label="Post text" value={v.body} onChange={(body) => set({ body })} />
    </div>
  );

  return (
    <>
      <PageHeader
        back={<Link to="/admin/news" className="hover:text-paper">← News</Link>}
        title={isNew ? 'New post' : v.title || 'Post'}
        actions={
          <>
            {live && <LinkButton to={`/news/${post!.slug}`} external icon={<ExternalLink className="size-4" />}>View post</LinkButton>}
            {!isNew && (
              <Button variant="danger" disabled={busy === 'del'} onClick={async () => {
                if (await confirm({ title: 'Delete this post?', body: 'The post and its cover image are removed for good.', confirmLabel: 'Delete post', danger: true })) void run({
                    key: 'del',
                    // Stop reloading the post while it is being removed.
                    fn: () => { setGone(true); return api(`/api/admin/news/${id}`, { method: 'DELETE' }).catch((e) => { setGone(false); throw e; }); },
                    ok: 'Post deleted',
                    onDone: () => nav('/admin/news'),
                  });
              }}>Delete</Button>
            )}
            <Button variant="primary" loading={busy === 'news'} onClick={() => save(undefined, isNew ? 'Draft saved' : 'Post saved')}>{isNew ? 'Save draft' : 'Save'}</Button>
          </>
        }
      />
      {isNew ? form : <Loaded query={q}>{() => form}</Loaded>}
    </>
  );
}

// ---------------------------------------------------------------- feedback

export function FeedbackPage() {
  useTitle('Feedback');
  const [f, setF] = useFilters({ status: 'new', category: '', q: '' });
  const list = useList<{ counts: Record<string, number> }>('/api/admin/feedback', { status: f.status, category: f.category, q: f.q, page: f.page, limit: 25 });
  const { run, busy } = useAct();
  const counts = list.data?.counts ?? {};
  const setStatus = (id: string, status: string, ok: string) => run({ key: id, fn: () => api(`/api/admin/feedback/${id}/status`, { json: { status } }), ok });
  const tab = (value: string, label: string) => ({ value, label: counts[value] ? `${label} (${counts[value]})` : label });
  return (
    <>
      <PageHeader title="Feedback" description="Messages sent through the feedback form. Reply from your own mailbox, then mark them resolved." />
      <div className="mb-4"><Tabs value={f.status} onChange={(status) => setF({ status })} tabs={[tab('new', 'New'), tab('read', 'Read'), tab('resolved', 'Resolved'), { value: 'all', label: 'All' }]} /></div>
      <FilterBar>
        <SearchInput value={f.q} onChange={(q) => setF({ q })} placeholder="Search the message or sender email" />
        <FilterSelect label="Topic" value={f.category} onChange={(category) => setF({ category })} options={[['', 'Any topic'], ['general', 'General'], ['bug', 'Bug'], ['idea', 'Idea'], ['billing', 'Billing'], ['content', 'Content'], ['other', 'Other']]} />
      </FilterBar>
      {list.isPending ? (
        <Skeleton className="h-72 w-full" />
      ) : list.isError ? (
        <ErrorState message={errorMessage(list.error)} retry={() => void list.refetch()} />
      ) : list.data.items.length === 0 ? (
        <EmptyState icon={<Inbox />} title={f.status === 'new' ? 'Inbox zero' : 'No messages here'}>
          {f.status === 'new' ? 'New feedback from readers and creators lands here.' : 'Try another tab or clear the search.'}
        </EmptyState>
      ) : (
        <div className="space-y-3">
          {list.data.items.map((m) => (
            <Card key={m.id} className="p-4 sm:p-5">
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <Badge tone="info">{m.category}</Badge>
                {m.status === 'new' && <Badge tone="warn">New</Badge>}
                {m.status === 'resolved' && <Badge tone="ok">Resolved</Badge>}
                <span className="min-w-0 truncate font-medium">{m.user_id ? <Link className="link" to={`/admin/users/${m.user_id}`}>@{m.username}</Link> : 'Visitor'}{m.email ? ` · ${m.email}` : ''}</span>
                <span className="ml-auto text-xs text-muted" title={dateTime(m.created_at)}>{ago(m.created_at)}</span>
              </div>
              <p className="mt-3 whitespace-pre-line break-words text-sm">{m.body}</p>
              {m.page_url && <p className="mt-2 truncate text-xs text-muted">Sent from {m.page_url}</p>}
              <div className="mt-4 flex flex-wrap gap-2">
                {m.email && <a className={buttonClass('secondary', 'sm')} href={`mailto:${m.email}?subject=${encodeURIComponent('Your feedback')}`}>Reply by email</a>}
                {m.status !== 'resolved' && <Button size="sm" loading={busy === m.id} onClick={() => setStatus(m.id, 'resolved', 'Marked as resolved')}>Mark resolved</Button>}
                {m.status === 'new' && <Button size="sm" variant="ghost" disabled={busy === m.id} onClick={() => setStatus(m.id, 'read', 'Marked as read')}>Mark read</Button>}
                {m.status !== 'new' && <Button size="sm" variant="ghost" disabled={busy === m.id} onClick={() => setStatus(m.id, 'new', 'Moved back to new')}>Move back to new</Button>}
              </div>
            </Card>
          ))}
          <Pagination page={list.data.page} pages={Math.ceil(list.data.total / list.data.limit)} onPage={(page) => setF({ page })} />
        </div>
      )}
    </>
  );
}
