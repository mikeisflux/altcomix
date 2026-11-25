import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Archive, BarChart3, CalendarClock, ChevronRight, Download, ExternalLink, Eye, Frame as FrameIcon, GripVertical, Info, Lock, RefreshCw, RotateCw, Settings2, Trash2,
  UploadCloud, Wand2, X,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { api, upload } from '@/lib/api';
import { bytes, dateTime } from '@/lib/format';
import { languageLabel, useSession } from '@/lib/session';
import {
  Badge, Button, Checkbox, DefList, EmptyState, Field, IconButton, Input, LinkButton, Modal, Notice, Popover, ProgressBar, Segmented, Select, Skeleton, Spinner,
  Textarea, cx, toast, useConfirm,
} from '@/ui';
import { ContributorsEditor } from './Contributors';
import { usePremium, usePremiumPrice } from './Premium';
import { releasesKey, seriesKey } from './SeriesEditor';
import type { Contributor, Release } from './SeriesEditor';
import { CopyButton, FileButton, PAGE_TYPES, Q, STATUS_TONE, Section, can, cap, changed, fromLocalInput, toLocalInput, studioError, useAct, useBrand, useDraft, useTitle, Group } from './shared';

type ReleaseDetail = {
  release: Release;
  series: { id: string; slug: string; title: string; language: string; reading_dir: 'ltr' | 'rtl'; layout: 'paged' | 'vertical'; access_model: string; has_cover: boolean };
  brand: { id: string; slug: string; name: string };
  contributors: Contributor[];
};
type GridPage = {
  id: string; position: number; width: number; height: number; bytes: number; filename: string | null; thumb_url: string; frames_count: number;
  frames_status: 'missing' | 'auto' | 'manual'; is_free: boolean | null; free: boolean; is_cover: boolean; spread: number | null; side: 'single' | 'left' | 'right' | 'wide';
};
type Pages = { access: { model: string; release_free: boolean; free_pages: number; locked_pages: number }; frames_missing: number; pages: GridPage[] };
type Job = { id: string; kind: 'ingest' | 'detect_frames'; status: 'queued' | 'running' | 'done' | 'failed'; done: number; total: number; error: string | null; filename: string | null; skipped: (string | { filename?: string; reason?: string })[]; pages_added: number | null; detected: number | null; kept_manual: number | null };
type Jobs = { processing: boolean; done: number; total: number; page_count: number; jobs: Job[] };
type ArchiveRow = { id: string; filename: string; bytes: number; created_at: string; page_count: number; extracting: boolean; download_url: string };

const keys = (id: string) => ({ release: ['studio', 'release', id], pages: ['studio', 'pages', id], jobs: ['studio', 'jobs', id], archives: ['studio', 'archives', id], preview: ['studio', 'preview-link', id] });

/** Same check the server does, so the message appears while typing. */
export function isbnProblem(input: string): string | null {
  const s = input.replace(/[\s-]/g, '').toUpperCase();
  if (!s) return null;
  if (/^\d{9}[\dX]$/.test(s)) {
    let sum = 0;
    for (let i = 0; i < 10; i++) sum += (s[i] === 'X' ? 10 : Number(s[i])) * (10 - i);
    return sum % 11 === 0 ? null : 'The check digit does not match. Re-check the number.';
  }
  if (/^\d{13}$/.test(s)) {
    let sum = 0;
    for (let i = 0; i < 13; i++) sum += Number(s[i]) * (i % 2 ? 3 : 1);
    return sum % 10 === 0 ? null : 'The check digit does not match. Re-check the number.';
  }
  return `An ISBN has 10 or 13 digits. This has ${s.length}.`;
}

/**
 * The "Buy in print" link is part of Creator Premium. Without it the field is
 * shown but cannot be edited (the server refuses a new or changed link too),
 * and a link saved earlier is kept, hidden from readers, and can be removed.
 */
function PrintLinkField({ value, saved, editable, onChange }: { value: string | null; saved: string | null; editable: boolean; onChange: (v: string | null) => void }) {
  const { brand } = useBrand();
  const premium = usePremium(brand.id);
  const price = usePremiumPrice();
  // Until the plan is known the field stays as it always was; the server has the last word either way.
  const locked = premium.data ? !premium.data.active : false;
  if (!locked) {
    return <Field label="Print edition link" optional hint="Shown to readers as “Buy in print”."><Input type="url" placeholder="https://" value={value ?? ''} onChange={(e) => onChange(e.target.value || null)} /></Field>;
  }
  return (
    <Field label={<span className="inline-flex items-center gap-1.5"><Lock className="size-3.5 text-muted" aria-hidden />Print edition link</span>} optional>
      <Input type="url" placeholder="https://" value={value ?? ''} disabled readOnly aria-describedby="print-link-locked" data-testid="print-link-locked" />
      <p id="print-link-locked" className="mt-1.5 text-xs text-muted">
        {saved && value
          ? 'This link is saved but hidden from readers, because print edition links are part of '
          : value === null && saved
            ? 'The link will be removed when you save. Adding one again needs '
            : 'A “Buy in print” link for readers is part of '}
        <Link className="link" to={`/studio/${brand.slug}/premium`}>{price.name}</Link>
        {saved && value ? '. It shows again as soon as the plan is active.' : ` (${price.text}).`}
        {saved && value && editable && <> <button type="button" className="link" onClick={() => onChange(null)}>Remove the link</button></>}
      </p>
    </Field>
  );
}

type Fields = Pick<Release, 'title' | 'synopsis' | 'mature' | 'spread_pref' | 'single_cover' | 'isbn' | 'print_url' | 'orig_pub_date'>;

function SettingsPanel({ d, editable }: { d: ReleaseDetail; editable: boolean }) {
  const r = d.release;
  const k = keys(r.id);
  const server = useMemo<Fields>(() => ({ title: r.title, synopsis: r.synopsis, mature: r.mature, spread_pref: r.spread_pref, single_cover: r.single_cover, isbn: r.isbn, print_url: r.print_url, orig_pub_date: r.orig_pub_date ? r.orig_pub_date.slice(0, 10) : null }), [r]);
  const [f, set, dirty, reset] = useDraft(server);
  const isbnError = isbnProblem(f.isbn ?? '');
  const save = useAct(
    () => {
      const body: Record<string, unknown> = changed(server, f);
      if ('isbn' in body) body.isbn = f.isbn ?? '';
      if ('print_url' in body) body.print_url = f.print_url ?? '';
      return api(`/api/studio/releases/${r.id}`, { method: 'PATCH', json: body });
    },
    { success: 'Release saved', invalidate: [k.release, k.pages, releasesKey(d.series.id)] },
  );
  return (
    <Section title="Release details">
      <fieldset disabled={!editable} className="space-y-4">
        <Field label="Title"><Input value={f.title} maxLength={200} onChange={(e) => set({ title: e.target.value })} /></Field>
        <Field label="Synopsis" optional><Textarea value={f.synopsis} maxLength={1800} onChange={(e) => set({ synopsis: e.target.value })} /></Field>
        <Checkbox checked={f.mature} disabled={!editable} onChange={(v) => set({ mature: v })} label="Mature content" description="Only shown to readers who have opted in." />
        {d.series.layout === 'paged' && (
          <>
            <Field label="Double-page spreads" hint="When a run of pages has an odd one out, this decides which end stays single.">
              <Select value={f.spread_pref} onChange={(e) => set({ spread_pref: e.target.value as 'first' | 'last' })}>
                <option value="last">Keep the last two pages together</option>
                <option value="first">Keep the first two pages together</option>
              </Select>
            </Field>
            <Checkbox checked={f.single_cover} disabled={!editable} onChange={(v) => set({ single_cover: v })} label="Show the cover on its own" description="Page 1 is never paired with page 2 in double-page view." />
          </>
        )}
        <Field label="ISBN" optional error={isbnError} hint="10 or 13 digits, with or without dashes."><Input value={f.isbn ?? ''} inputMode="numeric" onChange={(e) => set({ isbn: e.target.value || null })} /></Field>
        <PrintLinkField value={f.print_url} saved={r.print_url} editable={editable} onChange={(v) => set({ print_url: v })} />
        <Field label="Originally published" optional><Input type="date" value={f.orig_pub_date ?? ''} onChange={(e) => set({ orig_pub_date: e.target.value || null })} /></Field>
      </fieldset>
      {dirty && <div className="flex justify-end gap-2"><Button variant="ghost" onClick={reset}>Discard</Button><Button loading={save.isPending} disabled={Boolean(isbnError)} onClick={() => save.mutate()}>Save details</Button></div>}
    </Section>
  );
}

function PublishPanel({ d, editable, brandSlug }: { d: ReleaseDetail; editable: boolean; brandSlug: string }) {
  const r = d.release;
  const k = keys(r.id);
  const confirm = useConfirm();
  const [when, setWhen] = useState('');
  const [scheduling, setScheduling] = useState(false);
  const inv = [k.release, releasesKey(d.series.id), seriesKey(d.series.id), ['studio', 'series-list', d.brand.id]];
  const link = useQuery({ queryKey: k.preview, queryFn: () => api<{ url: string }>(`/api/studio/releases/${r.id}/preview-link`), enabled: editable });
  const publish = useAct((publish_at: string | null) => api<{ release: Release; first_publish: boolean }>(`/api/studio/releases/${r.id}/publish`, { json: publish_at ? { publish_at } : {} }), {
    success: (res) => (res.release.status === 'scheduled' ? `Scheduled for ${dateTime(res.release.publish_at)}` : res.first_publish ? 'Published. Your followers are being told.' : 'Published'),
    invalidate: inv,
    onDone: () => { setScheduling(false); setWhen(''); },
  });
  const unpublish = useAct(() => api(`/api/studio/releases/${r.id}/unpublish`, { method: 'POST' }), { success: r.status === 'scheduled' ? 'Schedule canceled' : 'Unpublished. Readers can no longer open it.', invalidate: inv });
  const rotate = useAct(() => api<{ url: string }>(`/api/studio/releases/${r.id}/preview-link/rotate`, { method: 'POST' }), { success: 'New private link created. The old one no longer works.', invalidate: [k.preview] });
  // The API builds links from its configured address; open them on the site you are on.
  const here = (url: string) => { try { const u = new URL(url); return window.location.origin + u.pathname + u.search; } catch { return url; } };
  const previewUrl = link.data ? here(link.data.url) : null;
  const whenIso = fromLocalInput(when);
  return (
    <Section title="Publishing">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <Badge tone={STATUS_TONE[r.status]}>{cap(r.status)}</Badge>
        <span className="text-muted">
          {r.status === 'published' ? `since ${dateTime(r.published_at)}` : r.status === 'scheduled' ? `goes live ${dateTime(r.publish_at)}` : r.published_at ? `last published ${dateTime(r.published_at)}` : 'Only your team can see it'}
        </span>
      </div>
      {r.page_count === 0 && <p className="text-sm text-muted">Add at least one page before publishing.</p>}
      {editable && (
        <div className="flex flex-wrap gap-2">
          {r.status !== 'published' && <Button variant="primary" disabled={!r.page_count} loading={publish.isPending && !scheduling} onClick={() => publish.mutate(null)}>Publish now</Button>}
          {r.status !== 'published' && <Button disabled={!r.page_count} icon={<CalendarClock className="size-4" />} onClick={() => setScheduling((s) => !s)}>{r.status === 'scheduled' ? 'Reschedule' : 'Schedule'}</Button>}
          {r.status !== 'draft' && <Button loading={unpublish.isPending} onClick={async () => (r.status === 'scheduled' || (await confirm({ title: 'Unpublish this release?', body: 'Readers will not be able to open it until you publish again. People who bought it keep their purchase.', confirmLabel: 'Unpublish' }))) && unpublish.mutate()}>{r.status === 'scheduled' ? 'Cancel schedule' : 'Unpublish'}</Button>}
        </div>
      )}
      {scheduling && (
        <div className="space-y-2 rounded-xl border border-line bg-ink p-3">
          <Field label="Publish on" hint="In your own timezone."><Input type="datetime-local" value={when} min={toLocalInput(new Date().toISOString())} onChange={(e) => setWhen(e.target.value)} /></Field>
          <Button variant="primary" size="sm" disabled={!whenIso || Date.parse(whenIso) < Date.now() + 60_000} loading={publish.isPending} onClick={() => publish.mutate(whenIso)}>Schedule release</Button>
        </div>
      )}
      <div className="flex flex-wrap gap-2 border-t border-line pt-3">
        {previewUrl && <LinkButton to={previewUrl} external size="sm" icon={<Eye className="size-4" />}>Preview</LinkButton>}
        {r.status === 'published' && <LinkButton to={`/read/${r.id}`} external size="sm" icon={<ExternalLink className="size-4" />}>Go to release</LinkButton>}
        <LinkButton to={`/studio/${brandSlug}/analytics?view=dropoff&release=${r.id}`} size="sm" variant="ghost" icon={<BarChart3 className="size-4" />}>View stats</LinkButton>
      </div>
      {editable && (
        <div className="border-t border-line pt-3">
          <div className="mb-1 text-[13px] font-medium">Share privately</div>
          <p className="mb-2 text-xs text-muted">Anyone with this link can read the release before it is published. No account needed.</p>
          {previewUrl ? (
            <div className="space-y-2">
              <input readOnly aria-label="Private preview link" value={previewUrl} onFocus={(e) => e.target.select()} className="h-9 w-full rounded-lg border border-line bg-ink px-2.5 font-mono text-xs text-muted" />
              <div className="flex flex-wrap gap-2">
                <CopyButton text={previewUrl} label="Copy private link" />
                <Button size="sm" variant="ghost" loading={rotate.isPending} icon={<RotateCw className="size-4" />} onClick={async () => (await confirm({ title: 'Replace the private link?', body: 'Everyone you shared the current link with will lose access.', confirmLabel: 'Replace link' })) && rotate.mutate()}>Replace link</Button>
              </div>
            </div>
          ) : <Skeleton className="h-9" />}
        </div>
      )}
    </Section>
  );
}

function FilesPanel({ d, editable, admin, hasPages }: { d: ReleaseDetail; editable: boolean; admin: boolean; hasPages: boolean }) {
  const r = d.release;
  const k = keys(r.id);
  const { brand } = useBrand();
  const confirm = useConfirm();
  const nav = useNavigate();
  const archives = useQuery({ queryKey: k.archives, queryFn: () => api<{ archives: ArchiveRow[] }>(`/api/studio/releases/${r.id}/archives`) });
  const extract = useAct((id: string) => api(`/api/studio/archives/${id}/extract`, { method: 'POST' }), { success: 'Extracting again. Pages from this file will be replaced.', invalidate: [k.jobs, k.archives] });
  const removeArchive = useAct((id: string) => api(`/api/studio/archives/${id}`, { method: 'DELETE' }), { success: 'Uploaded file removed. Its pages stay in the release.', invalidate: [k.archives] });
  const del = useAct(() => api(`/api/studio/releases/${r.id}`, { method: 'DELETE' }), { success: 'Release deleted', invalidate: [releasesKey(d.series.id), seriesKey(d.series.id)], onDone: () => nav(`/studio/${brand.slug}/series/${d.series.id}`) });
  const canDelete = editable && (!r.published_at || admin);
  return (
    <Section title="Files">
      <div>
        <div className="mb-1.5 text-[13px] font-medium">Uploaded archives</div>
        {archives.data?.archives.length ? (
          <ul className="divide-y divide-line rounded-xl border border-line">
            {archives.data.archives.map((a) => (
              <li key={a.id} className="flex items-center gap-2 px-3 py-2 text-sm">
                <Archive className="size-4 shrink-0 text-muted" aria-hidden />
                <div className="min-w-0 flex-1">
                  <div className="truncate font-medium" title={a.filename}>{a.filename}</div>
                  <div className="text-xs text-muted">{bytes(a.bytes)} · {a.page_count} pages · {dateTime(a.created_at)}</div>
                </div>
                {a.extracting ? <Spinner className="size-4" /> : editable && (
                  <>
                    <IconButton label={`Extract ${a.filename} again`} onClick={async () => (await confirm({ title: 'Extract this file again?', body: 'The pages that came from it are replaced with a fresh extraction. Frames and free settings on those pages are lost.', confirmLabel: 'Extract again' })) && extract.mutate(a.id)}><RefreshCw className="size-4" /></IconButton>
                    <a href={a.download_url} aria-label={`Download ${a.filename}`} title="Download" className="inline-flex size-9 items-center justify-center rounded-lg text-muted hover:bg-hover hover:text-paper"><Download className="size-4" /></a>
                    <IconButton label={`Remove ${a.filename}`} onClick={async () => (await confirm({ title: 'Remove this uploaded file?', body: 'Only the stored archive is removed. The pages extracted from it stay in the release.', confirmLabel: 'Remove file', danger: true })) && removeArchive.mutate(a.id)}><X className="size-4" /></IconButton>
                  </>
                )}
              </li>
            ))}
          </ul>
        ) : <p className="text-sm text-muted">{archives.isLoading ? 'Loading…' : 'PDF, CBZ and ZIP files you upload are kept here so you can extract them again.'}</p>}
      </div>
      {editable && hasPages && <a href={`/api/studio/releases/${r.id}/originals.zip`} className="inline-flex h-8 items-center gap-1.5 rounded-md border border-line bg-raised px-3 text-[13px] hover:bg-hover"><Download className="size-4" />Download original pages</a>}
      {editable && (
        <div className="border-t border-line pt-3">
          <Button variant="danger" size="sm" disabled={!canDelete} loading={del.isPending} icon={<Trash2 className="size-4" />} onClick={async () => (await confirm({ title: `Delete “${r.title}”?`, body: r.published_at ? 'This release has been public. Readers who bought it will lose access to it.' : 'The release and its pages are removed.', confirmLabel: 'Delete release', danger: true })) && del.mutate()}>Delete release</Button>
          {!canDelete && <p className="mt-1.5 text-xs text-faint">A release that has been published can only be deleted by a brand admin or owner.</p>}
        </div>
      )}
    </Section>
  );
}

function Requirements() {
  return (
    <Popover align="left" width={320} trigger={({ toggle, open }) => <button type="button" aria-expanded={open} onClick={toggle} className="inline-flex items-center gap-1 text-xs text-muted underline underline-offset-2 hover:text-paper"><Info className="size-3.5" />File requirements</button>}>
      {() => (
        <div className="space-y-2 p-4 text-left text-xs text-muted">
          <p className="text-sm font-semibold text-paper">What you can upload</p>
          <ul className="list-disc space-y-1.5 pl-4">
            <li><span className="text-paper">Images:</span> PNG, JPG or WebP, one file per page. They are put in order by filename, so name them 001.jpg, 002.jpg and so on.</li>
            <li><span className="text-paper">CBZ or ZIP:</span> an archive of page images, up to 3,000 images and 6 GB unpacked. CBR is not supported; re-save it as CBZ.</li>
            <li><span className="text-paper">PDF:</span> every PDF page becomes one comic page, rendered up to 3,000 pixels on its long edge.</li>
            <li>Up to 400 files and 600 MB per file in one upload.</li>
            <li>For print layout, 1,600 pixels wide or more keeps lettering sharp when a frame is zoomed in on a phone.</li>
          </ul>
          <p>New pages are added after the ones already in the release. Drag pages in the grid to reorder them.</p>
        </div>
      )}
    </Popover>
  );
}

const SPREAD_TONES = ['info', 'accent'] as const;

function PageSettings({ page, pages, onClose, releaseId, seriesId, editable, onMove }: { page: GridPage; pages: GridPage[]; onClose: () => void; releaseId: string; seriesId: string; editable: boolean; onMove: (id: string, to: number) => void }) {
  const k = keys(releaseId);
  const confirm = useConfirm();
  const info = useQuery({ queryKey: ['studio', 'page', page.id], queryFn: () => api<{ page: { filename: string | null; bytes: number; width: number; height: number; dpi: number | null; created_at: string; status: string; urls: Record<'original' | 'full' | 'medium' | 'thumb', string>; is_release_cover: boolean } }>(`/api/studio/pages/${page.id}`) });
  const [free, setFree] = useState<'rule' | 'free' | 'locked'>(page.is_free === null ? 'rule' : page.is_free ? 'free' : 'locked');
  const [pos, setPos] = useState(String(page.position));
  const save = useAct(() => api(`/api/studio/pages/${page.id}`, { method: 'PATCH', json: { is_free: free === 'rule' ? null : free === 'free' } }), { success: 'Page saved', invalidate: [k.pages], onDone: onClose });
  const seriesCover = useAct(() => api(`/api/studio/pages/${page.id}/series-cover`, { method: 'POST' }), { success: 'This page is now the series cover', invalidate: [seriesKey(seriesId), ['studio', 'series-list']] });
  const releaseCover = useAct(() => api(`/api/studio/pages/${page.id}/release-cover`, { method: 'POST' }), { success: 'This page is now the release cover', invalidate: [k.pages, k.release, releasesKey(seriesId)] });
  const del = useAct(() => api(`/api/studio/pages/${page.id}`, { method: 'DELETE' }), { success: 'Page deleted', invalidate: [k.pages, k.release, releasesKey(seriesId)], onDone: onClose });
  const p = info.data?.page;
  const changedFree = free !== (page.is_free === null ? 'rule' : page.is_free ? 'free' : 'locked');
  return (
    <Modal open onClose={onClose} title={`Page ${page.position}`} size="lg" footer={editable ? <><Button variant="danger" className="mr-auto" loading={del.isPending} onClick={async () => (await confirm({ title: `Delete page ${page.position}?`, body: 'The page, its frames and its text regions are removed.', confirmLabel: 'Delete page', danger: true })) && del.mutate()}>Delete</Button><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" disabled={!changedFree} loading={save.isPending} onClick={() => save.mutate()}>Save</Button></> : <Button onClick={onClose}>Close</Button>}>
      <div className="grid gap-5 sm:grid-cols-[200px_1fr]">
        <img src={p?.urls.medium ?? page.thumb_url} alt={`Page ${page.position}`} className="mx-auto max-h-80 w-auto rounded-lg border border-line sm:max-h-none sm:w-full" style={{ aspectRatio: `${page.width} / ${page.height}` }} />
        <div className="min-w-0 space-y-4">
          <DefList items={[
            ['File', p?.filename ?? page.filename ?? '—'],
            ['Size', bytes(page.bytes)],
            ['Uploaded', p ? dateTime(p.created_at) : '…'],
            ['Status', p ? cap(p.status) : '…'],
            ['Dimensions', `${page.width} × ${page.height} px${p?.dpi ? ` · ${p.dpi} DPI` : ''}`],
            ['Frames', page.frames_count ? `${page.frames_count} (${page.frames_status === 'manual' ? 'set by hand' : 'detected'})` : 'None'],
          ]} />
          {p && (
            <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
              {([['original', 'Original file'], ['full', 'Desktop size'], ['medium', 'Mobile size'], ['thumb', 'Thumbnail']] as const).map(([v, label]) => <a key={v} className="link" href={p.urls[v]} target="_blank" rel="noreferrer">{label}</a>)}
            </div>
          )}
          {editable && (
            <>
              <Group label="Free to read" hint={free === 'rule' ? `Follows the release and series paywall. Right now this page is ${page.free ? 'free' : 'locked'}.` : free === 'free' ? 'Anyone can read this page, whatever the paywall says.' : 'This page needs a membership or purchase even inside the free preview.'}>
                <Segmented value={free} onChange={setFree} options={[{ value: 'rule', label: 'Follow the paywall' }, { value: 'free', label: 'Always free' }, { value: 'locked', label: 'Always locked' }]} />
              </Group>
              <div className="flex flex-wrap gap-2">
                <Button size="sm" loading={seriesCover.isPending} onClick={() => seriesCover.mutate()}>Set as series cover</Button>
                <Button size="sm" disabled={page.is_cover} loading={releaseCover.isPending} onClick={() => releaseCover.mutate()}>{page.is_cover ? 'This is the release cover' : 'Set as release cover'}</Button>
              </div>
              <div className="flex items-end gap-2">
                <Field label="Move to position" className="w-36"><Input type="number" min={1} max={pages.length} value={pos} onChange={(e) => setPos(e.target.value)} /></Field>
                <Button disabled={!Number(pos) || Number(pos) === page.position || Number(pos) < 1 || Number(pos) > pages.length} onClick={() => { onMove(page.id, Number(pos)); onClose(); }}>Move</Button>
              </div>
            </>
          )}
        </div>
      </div>
    </Modal>
  );
}

function PageGrid({ d, data, editable, base }: { d: ReleaseDetail; data: Pages; editable: boolean; base: string }) {
  const r = d.release;
  const k = keys(r.id);
  const qc = useQueryClient();
  const confirm = useConfirm();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [order, setOrder] = useState<GridPage[] | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);
  const [settings, setSettings] = useState<string | null>(null);
  const pages = order ?? data.pages;
  useEffect(() => {
    setOrder(null);
    setSelected((s) => new Set([...s].filter((id) => data.pages.some((p) => p.id === id))));
  }, [data.pages]);
  const paged = d.series.layout === 'paged';
  const premium = data.access.model === 'premium';
  const inv = [k.pages, k.release, releasesKey(d.series.id)];

  const reorder = async (ids: string[]) => {
    setOrder(ids.map((id, i) => ({ ...pages.find((p) => p.id === id)!, position: i + 1 })));
    try {
      await api(`/api/studio/releases/${r.id}/pages/order`, { method: 'PUT', json: { ids } });
      toast.success('Page order saved');
    } catch (e) {
      studioError(e);
    }
    for (const key of inv) await qc.invalidateQueries({ queryKey: key });
  };
  const move = (id: string, toPosition: number) => {
    const ids = pages.map((p) => p.id).filter((x) => x !== id);
    ids.splice(toPosition - 1, 0, id);
    void reorder(ids);
  };
  const dropOn = (targetId: string) => {
    if (!dragId || dragId === targetId) return;
    const to = pages.findIndex((p) => p.id === targetId);
    move(dragId, to + 1);
  };

  const ids = [...selected];
  const setFree = useAct((is_free: boolean | null) => api(`/api/studio/releases/${r.id}/pages/free`, { json: { ids, is_free } }), { success: (_r, v) => `${ids.length} ${ids.length === 1 ? 'page' : 'pages'} ${v === null ? 'now follow the paywall' : v ? 'set free' : 'set locked'}`, invalidate: [k.pages], onDone: () => setSelected(new Set()) });
  const delMany = useAct(() => api(`/api/studio/releases/${r.id}/pages/delete`, { json: { ids } }), { success: `${ids.length} ${ids.length === 1 ? 'page' : 'pages'} deleted`, invalidate: inv, onDone: () => setSelected(new Set()) });
  const toggle = (id: string) => setSelected((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const settingsPage = pages.find((p) => p.id === settings);

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2 text-sm">
        <span className="text-muted">
          {pages.length} {pages.length === 1 ? 'page' : 'pages'}
          {premium && !data.access.release_free ? ` · ${data.access.free_pages} free, ${data.access.locked_pages} locked for visitors` : data.access.model === 'blocked' ? ' · blocked for readers' : ' · all free to read'}
        </span>
        {editable && <Button size="sm" variant="ghost" onClick={() => setSelected(selected.size === pages.length ? new Set() : new Set(pages.map((p) => p.id)))}>{selected.size === pages.length ? 'Clear selection' : 'Select all'}</Button>}
      </div>

      {selected.size > 0 && (
        <div className="sticky top-16 z-20 mb-3 flex flex-wrap items-center gap-2 rounded-xl border border-accent/40 bg-raised px-3 py-2 shadow-pop" role="toolbar" aria-label="Actions for selected pages">
          <span className="mr-1 text-sm font-semibold">{selected.size} selected</span>
          <Button size="sm" loading={setFree.isPending} onClick={() => setFree.mutate(true)}>Set free</Button>
          <Button size="sm" disabled={setFree.isPending} onClick={() => setFree.mutate(false)}>Set locked</Button>
          <Button size="sm" disabled={setFree.isPending} onClick={() => setFree.mutate(null)}>Follow paywall</Button>
          <Button size="sm" variant="danger" loading={delMany.isPending} onClick={async () => (await confirm({ title: `Delete ${ids.length} ${ids.length === 1 ? 'page' : 'pages'}?`, body: 'The pages, their frames and text regions are removed.', confirmLabel: 'Delete pages', danger: true })) && delMany.mutate()}>Delete</Button>
          <IconButton label="Clear selection" className="ml-auto" onClick={() => setSelected(new Set())}><X className="size-4" /></IconButton>
        </div>
      )}

      <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5">
        {pages.map((p) => {
          const on = selected.has(p.id);
          return (
            <li
              key={p.id}
              draggable={editable}
              onDragStart={(e) => { setDragId(p.id); e.dataTransfer.effectAllowed = 'move'; }}
              onDragEnd={() => { setDragId(null); setOverId(null); }}
              onDragOver={(e) => { if (dragId) { e.preventDefault(); setOverId(p.id); } }}
              onDrop={(e) => { e.preventDefault(); dropOn(p.id); setDragId(null); setOverId(null); }}
              className={cx('group relative overflow-hidden rounded-xl border bg-surface transition-colors', on ? 'border-accent' : 'border-line', overId === p.id && dragId !== p.id && 'ring-2 ring-accent', dragId === p.id && 'opacity-40')}
            >
              <div className="relative bg-ink" style={{ aspectRatio: '2 / 3' }}>
                <img src={p.thumb_url} alt={`Page ${p.position}`} loading="lazy" draggable={false} className="size-full object-contain" />
                {editable && (
                  <label className="absolute left-0 top-0 flex size-10 cursor-pointer items-center justify-center">
                    <input type="checkbox" className="peer sr-only" checked={on} onChange={() => toggle(p.id)} aria-label={`Select page ${p.position}`} />
                    <span className={cx('flex size-5 items-center justify-center rounded border-2 text-[11px] font-bold peer-focus-visible:outline peer-focus-visible:outline-2 peer-focus-visible:outline-accent', on ? 'border-accent bg-accent text-accent-ink' : 'border-paper/70 bg-black/50')}>{on ? '✓' : ''}</span>
                  </label>
                )}
                <div className="absolute right-1.5 top-1.5 flex flex-col items-end gap-1">
                  {data.access.model !== 'blocked' && <Badge tone={p.free ? 'sun' : 'neutral'}>{p.is_free !== null ? 'Always ' : ''}{p.free ? 'free' : 'locked'}</Badge>}
                  {p.is_cover && <Badge tone="ok">Cover</Badge>}
                  {p.spread !== null && <Badge tone={SPREAD_TONES[p.spread % 2]}>Spread {p.spread} {p.side === 'left' ? 'L' : 'R'}</Badge>}
                  {p.side === 'wide' && <Badge tone="info">Wide</Badge>}
                </div>
                {paged && (
                  <div className="absolute bottom-1.5 left-1.5">
                    {p.frames_status === 'missing' ? <Badge tone="warn">No frames</Badge> : p.frames_count === 0 ? <Badge tone="warn">0 frames found</Badge> : <Badge tone={p.frames_status === 'manual' ? 'ok' : 'info'}><span title={p.frames_status === 'manual' ? 'Frames set by hand' : 'Frames detected automatically'}>{p.frames_count} {p.frames_count === 1 ? 'frame' : 'frames'} · {p.frames_status === 'manual' ? 'manual' : 'auto'}</span></Badge>}
                  </div>
                )}
              </div>
              <div className="flex items-center gap-0.5 px-1.5 py-1">
                {editable && <GripVertical className="size-4 shrink-0 cursor-grab text-faint" aria-hidden />}
                <span className="flex-1 text-sm font-semibold tabular-nums">#{p.position}</span>
                {paged && <Link to={`${base}/pages/${p.id}`} className="inline-flex h-9 items-center gap-1 rounded-lg px-2 text-[13px] text-muted hover:bg-hover hover:text-paper" aria-label={`Edit frames on page ${p.position}`}><FrameIcon className="size-4" />Frames</Link>}
                <IconButton label={`Settings for page ${p.position}`} onClick={() => setSettings(p.id)}><Settings2 className="size-4" /></IconButton>
              </div>
            </li>
          );
        })}
      </ul>
      {settingsPage && <PageSettings key={settingsPage.id} page={settingsPage} pages={pages} releaseId={r.id} seriesId={d.series.id} editable={editable} onClose={() => setSettings(null)} onMove={move} />}
    </div>
  );
}

type DetectSummary = { detected: number; kept: number };

function Workspace({ d, editable, base }: { d: ReleaseDetail; editable: boolean; base: string }) {
  const r = d.release;
  const k = keys(r.id);
  const qc = useQueryClient();
  const confirm = useConfirm();
  const pages = useQuery({ queryKey: k.pages, queryFn: () => api<Pages>(`/api/studio/releases/${r.id}/pages`) });
  const jobs = useQuery({ queryKey: k.jobs, queryFn: () => api<Jobs>(`/api/studio/releases/${r.id}/jobs`), refetchInterval: (q) => (q.state.data?.processing ? 1000 : false) });
  const [uploading, setUploading] = useState<number | null>(null);
  const [over, setOver] = useState(false);
  const [summary, setSummary] = useState<DetectSummary | null>(null);
  const [problems, setProblems] = useState<string[]>([]);
  const watched = useRef(new Set<string>());
  const paged = d.series.layout === 'paged';

  // Follow jobs from running to finished: refresh the grid and report what happened.
  useEffect(() => {
    const list = jobs.data?.jobs ?? [];
    for (const j of list) if (j.status === 'queued' || j.status === 'running') watched.current.add(j.id);
    const finished = list.filter((j) => watched.current.has(j.id) && (j.status === 'done' || j.status === 'failed'));
    if (!finished.length) return;
    const notes: string[] = [];
    for (const j of finished) {
      watched.current.delete(j.id);
      if (j.status === 'failed') notes.push(`${j.kind === 'detect_frames' ? 'Frame detection' : j.filename ?? 'Upload'} failed: ${j.error ?? 'unknown problem'}`);
      for (const s of j.skipped ?? []) notes.push(typeof s === 'string' ? `Skipped ${s}` : `Skipped ${s.filename ?? 'a file'}${s.reason ? `: ${s.reason}` : ''}`);
      if (j.kind === 'detect_frames' && j.status === 'done') setSummary({ detected: j.detected ?? 0, kept: j.kept_manual ?? 0 });
      if (j.kind === 'ingest' && j.status === 'done' && j.pages_added) toast.success(`${j.pages_added} ${j.pages_added === 1 ? 'page' : 'pages'} added`);
    }
    if (notes.length) setProblems((p) => [...p, ...notes]);
    for (const key of [k.pages, k.release, k.archives, releasesKey(d.series.id), seriesKey(d.series.id)]) void qc.invalidateQueries({ queryKey: key });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobs.data]);

  const send = async (files: File[]) => {
    if (!files.length) return;
    setUploading(0);
    try {
      const form = new FormData();
      files.forEach((f) => form.append('files', f, f.name));
      await upload(`/api/studio/releases/${r.id}/upload`, form, setUploading);
      await qc.invalidateQueries({ queryKey: k.jobs });
      await qc.invalidateQueries({ queryKey: k.archives });
    } catch (e) {
      studioError(e);
    } finally {
      setUploading(null);
    }
  };

  const detect = useAct((force: boolean) => api(`/api/studio/releases/${r.id}/frames/detect`, { json: { force } }), { invalidate: [k.jobs], onDone: () => setSummary(null) });
  const startDetect = async () => {
    const manual = pages.data?.pages.filter((p) => p.frames_status === 'manual').length ?? 0;
    let force = false;
    if (manual > 0) {
      force = await confirm({ title: 'Redo the pages you framed by hand too?', body: `${manual} ${manual === 1 ? 'page has' : 'pages have'} frames you drew or adjusted. Choose “Redo all” to replace them, or cancel to keep them and only detect the rest.`, confirmLabel: 'Redo all pages' });
    }
    detect.mutate(force);
  };

  const active = jobs.data?.jobs.filter((j) => j.status === 'queued' || j.status === 'running') ?? [];
  const detecting = active.some((j) => j.kind === 'detect_frames');
  const ingesting = active.some((j) => j.kind === 'ingest');
  const needLook = pages.data?.pages.filter((p) => p.frames_status !== 'manual' && p.frames_count === 0) ?? [];
  const hasPages = (pages.data?.pages.length ?? 0) > 0;

  return (
    <div className="min-w-0 space-y-4">
      {editable && (
        <div
          onDragOver={(e) => { if (e.dataTransfer.types.includes('Files')) { e.preventDefault(); setOver(true); } }}
          onDragLeave={() => setOver(false)}
          onDrop={(e) => { if (e.dataTransfer.files.length) { e.preventDefault(); setOver(false); void send(Array.from(e.dataTransfer.files)); } }}
          className={cx('flex flex-col items-center gap-2 rounded-2xl border-2 border-dashed px-4 text-center transition-colors', hasPages ? 'py-5' : 'py-12', over ? 'border-accent bg-accent-soft' : 'border-line-strong')}
        >
          <UploadCloud className={cx('text-muted', hasPages ? 'size-6' : 'size-9')} aria-hidden />
          <p className="text-sm font-semibold">{over ? 'Drop to upload' : hasPages ? 'Drop more pages here' : 'Drop your pages here'}</p>
          <p className="text-xs text-muted">PNG, JPG or WebP images, a CBZ or ZIP, or a PDF</p>
          <div className="flex flex-wrap items-center justify-center gap-3">
            <FileButton accept={PAGE_TYPES} multiple onFiles={send} loading={uploading !== null} size="sm">Choose files</FileButton>
            <Requirements />
          </div>
          {uploading !== null && <div className="w-full max-w-sm"><ProgressBar value={uploading} max={1} label={`Uploading… ${Math.round(uploading * 100)}%`} /></div>}
        </div>
      )}

      {ingesting && (
        <div className="rounded-xl border border-line bg-surface p-4" role="status" aria-live="polite">
          <ProgressBar value={jobs.data!.done} max={jobs.data!.total || 1} label={jobs.data!.total ? `${jobs.data!.done} / ${jobs.data!.total} pages processed` : 'Waiting for the server to open your file…'} />
        </div>
      )}

      {problems.length > 0 && (
        <Notice tone="warn" action={<Button size="sm" variant="ghost" onClick={() => setProblems([])}>Dismiss</Button>}>
          <ul className="list-disc space-y-0.5 pl-4">{problems.map((p, i) => <li key={i}>{p}</li>)}</ul>
        </Notice>
      )}

      {paged && hasPages && (
        <div className="rounded-2xl border border-sun/40 bg-raised p-4">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0 flex-1">
              <h2 className="text-base font-semibold">Frames for guided reading</h2>
              <p className="mt-0.5 text-sm text-muted">
                {pages.data && pages.data.frames_missing > 0
                  ? `${pages.data.frames_missing} of ${pages.data.pages.length} pages have no frames yet. One click finds the panels on every page.`
                  : 'Every page has been through frame detection. Open any page to adjust its frames.'}
              </p>
            </div>
            {editable && <Button variant="sun" size="lg" loading={detect.isPending || detecting} disabled={ingesting} icon={<Wand2 className="size-5" />} onClick={startDetect}>{pages.data && pages.data.frames_missing < pages.data.pages.length ? 'Detect frames again' : 'Detect frames for all pages'}</Button>}
          </div>
          {detecting && (() => { const j = active.find((x) => x.kind === 'detect_frames')!; return <div className="mt-3" role="status" aria-live="polite"><ProgressBar value={j.done} max={j.total || 1} label={`Analyzing page ${Math.min(j.done + 1, j.total)} of ${j.total}…`} /></div>; })()}
          {summary && !detecting && (
            <div className="mt-3 rounded-xl border border-line bg-ink p-3 text-sm">
              <p><strong>{summary.detected - needLook.length < 0 ? 0 : summary.detected - needLook.length}</strong> of {summary.detected} {summary.detected === 1 ? 'page' : 'pages'} got frames.{summary.kept > 0 && ` ${summary.kept} kept the frames you made by hand.`}</p>
              {needLook.length > 0 ? (
                <p className="mt-1 text-muted">No panel borders were found on {needLook.length === 1 ? 'this page' : 'these pages'}, so {needLook.length === 1 ? 'it shows' : 'they show'} whole in guided view. Have a look:{' '}
                  {needLook.map((p, i) => <span key={p.id}>{i > 0 && ', '}<Link className="link" to={`${base}/pages/${p.id}`}>page {p.position}</Link></span>)}
                </p>
              ) : <p className="mt-1 text-muted">Nothing needs a look. Spot-check a page or two, then publish.</p>}
            </div>
          )}
          <p className="mt-2 text-xs text-faint">Detection analyzes the gutters between panels on our server.</p>
        </div>
      )}

      <Q query={pages} loader={<div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">{[0, 1, 2, 3].map((i) => <Skeleton key={i} className="aspect-[2/3]" />)}</div>}>
        {(data) => (data.pages.length ? <PageGrid d={d} data={data} editable={editable} base={base} /> : !ingesting && uploading === null ? <EmptyState title="No pages yet">{editable ? 'Upload your pages above. They appear here as soon as they are processed.' : 'An editor needs to upload pages to this release.'}</EmptyState> : null)}
      </Q>
    </div>
  );
}

export function ReleaseEditor() {
  const { brand, role } = useBrand();
  const { meta } = useSession();
  const { series: seriesId = '', release: id = '' } = useParams();
  const detail = useQuery({ queryKey: keys(id).release, queryFn: () => api<ReleaseDetail>(`/api/studio/releases/${id}`) });
  useTitle(detail.data ? `${detail.data.release.title} · ${detail.data.series.title}` : 'Release');
  const editable = can(role, 'editor');
  const base = `/studio/${brand.slug}/series/${seriesId}/releases/${id}`;
  return (
    <Q query={detail}>
      {(d) => {
        const r = d.release;
        if (d.brand.id !== brand.id) return <Notice tone="warn">This release belongs to another brand.</Notice>;
        return (
          <div>
            <nav aria-label="Breadcrumb" className="mb-3 flex flex-wrap items-center gap-1 text-sm text-muted">
              <Link to={`/studio/${brand.slug}`} className="hover:text-paper">{brand.name}</Link>
              <ChevronRight className="size-3.5" aria-hidden />
              <Link to={`/studio/${brand.slug}/series/${d.series.id}`} className="hover:text-paper">{d.series.title}</Link>
              <ChevronRight className="size-3.5" aria-hidden />
              <span className="text-paper">{r.kind_label} {Number(r.number)} ({languageLabel(meta, r.language)})</span>
            </nav>
            <h1 className="mb-5 text-2xl font-bold sm:text-3xl">{r.title}</h1>
            <div className="grid gap-5 lg:grid-cols-[340px_minmax(0,1fr)]">
              <div className="order-2 space-y-4 lg:order-1">
                <PublishPanel d={d} editable={editable} brandSlug={brand.slug} />
                <SettingsPanel d={d} editable={editable} />
                <Section title="Credits for this release" description="Series credits apply as well.">
                  <ContributorsEditorCompact d={d} editable={editable} />
                </Section>
                <FilesPanel d={d} editable={editable} admin={can(role, 'admin')} hasPages={r.page_count > 0} />
              </div>
              <div className="order-1 min-w-0 lg:order-2"><Workspace d={d} editable={editable} base={base} /></div>
            </div>
          </div>
        );
      }}
    </Q>
  );
}

function ContributorsEditorCompact({ d, editable }: { d: ReleaseDetail; editable: boolean }) {
  return <div className="[&_form]:!grid-cols-1"><ContributorsEditor seriesId={d.series.id} releaseId={d.release.id} contributors={d.contributors.map((c) => ({ ...c, release_id: d.release.id }))} invalidate={[keys(d.release.id).release, seriesKey(d.series.id)]} canEdit={editable} /></div>;
}
