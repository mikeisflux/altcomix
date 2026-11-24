import { useQueryClient } from '@tanstack/react-query';
import { LayoutGrid, List, Loader2, Plus, UploadCloud } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import type { FormEvent } from 'react';
import { Link, useNavigate } from 'react-router';
import { api, errorMessage, upload } from '@/lib/api';
import { money } from '@/lib/format';
import { languageLabel, useSession } from '@/lib/session';
import { Badge, Button, Checkbox, EmptyState, Field, FormRow, IconButton, Input, Modal, ProgressBar, Select, Table, cx, toast } from '@/ui';
import { releasesKey, seriesKey, useReleases, useSeries } from './SeriesEditor';
import type { Release, ReleaseList, Series } from './SeriesEditor';
import { Cover, Q, STATUS_TONE, can, cap, useAct } from './shared';

export function accessBadge(series: Pick<Series, 'access_model' | 'default_price_cents'>, r: Pick<Release, 'force_free' | 'price_cents' | 'free_at'>) {
  if (series.access_model === 'blocked') return <Badge tone="danger">Blocked</Badge>;
  if (series.access_model === 'free' || r.force_free || (r.free_at && Date.parse(r.free_at) <= Date.now())) return <Badge tone="sun">Free</Badge>;
  const price = r.price_cents ?? series.default_price_cents;
  return <Badge tone="accent">Premium{price ? ` · ${money(price)}` : ''}</Badge>;
}

const num = (n: number) => (Number.isInteger(Number(n)) ? String(Number(n)) : Number(n).toFixed(2).replace(/0$/, ''));

function nextNumber(list: Release[], kind: string, language: string) {
  const nums = list.filter((r) => r.kind === kind && r.language === language).map((r) => Number(r.number));
  return nums.length ? Math.floor(Math.max(...nums)) + 1 : 1;
}

function NewReleaseDialog({ open, onClose, data, language, files }: { open: boolean; onClose: () => void; data: ReleaseList; language: string; files: File[] }) {
  const { series, base } = useSeries();
  const nav = useNavigate();
  const qc = useQueryClient();
  const defaultKind = series.layout === 'vertical' ? 'episode' : 'issue';
  const [kind, setKind] = useState(defaultKind);
  const labelOf = (k: string) => data.groups.flatMap((g) => g.kinds).find((x) => x.id === k)?.label ?? 'Release';
  const suggestedNumber = nextNumber(data.releases, kind, language);
  const [number, setNumber] = useState<string | null>(null);
  const [title, setTitle] = useState<string | null>(null);
  const [mature, setMature] = useState(series.mature);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (open) { setKind(defaultKind); setNumber(null); setTitle(null); setMature(series.mature); }
  }, [open, defaultKind, series.mature]);
  const n = number ?? String(suggestedNumber);
  const t = title ?? `${labelOf(kind)} ${n}`;
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      const r = await api<{ release: Release }>(`/api/studio/series/${series.id}/releases`, { json: { kind, language, number: Number(n), title: t, mature } });
      if (files.length) {
        const form = new FormData();
        files.forEach((f) => form.append('files', f, f.name));
        await upload(`/api/studio/releases/${r.release.id}/upload`, form);
      }
      await qc.invalidateQueries({ queryKey: releasesKey(series.id) });
      await qc.invalidateQueries({ queryKey: seriesKey(series.id) });
      toast.success(`${t} created`);
      nav(`${base}/releases/${r.release.id}`);
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal open={open} onClose={onClose} title="New release" footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" type="submit" form="new-release" loading={busy}>{files.length ? `Create and upload ${files.length} ${files.length === 1 ? 'file' : 'files'}` : 'Create release'}</Button></>}>
      <form id="new-release" onSubmit={submit} className="space-y-4">
        <FormRow>
          <Field label="Type" hint="Each type keeps its own numbering.">
            <Select value={kind} onChange={(e) => { setKind(e.target.value); setNumber(null); setTitle(null); }}>
              {data.groups.map((g) => <optgroup key={g.group} label={g.group}>{g.kinds.map((k) => <option key={k.id} value={k.id}>{k.label}</option>)}</optgroup>)}
            </Select>
          </Field>
          <Field label="Number" hint="Filled in from the releases you already have."><Input type="number" min={0} step="0.01" value={n} onChange={(e) => setNumber(e.target.value)} required /></Field>
        </FormRow>
        <Field label="Title"><Input value={t} onChange={(e) => setTitle(e.target.value)} required maxLength={200} /></Field>
        <Checkbox checked={mature} onChange={setMature} label="Mature content" description="Tick this if you would think twice before showing it to a parent or a boss. Readers must opt in to see it." />
        <p className="text-xs text-faint">Language: {language.toUpperCase()}. The release starts as a draft; nothing is public until you publish it.</p>
      </form>
    </Modal>
  );
}

function NewTile({ onOpen, onDrop, busy, list }: { onOpen: () => void; onDrop: (files: File[]) => void; busy: string | null; list: boolean }) {
  const [over, setOver] = useState(false);
  return (
    <button
      type="button"
      onClick={onOpen}
      disabled={Boolean(busy)}
      onDragOver={(e) => { e.preventDefault(); setOver(true); }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => { e.preventDefault(); setOver(false); const f = Array.from(e.dataTransfer.files); if (f.length) onDrop(f); }}
      className={cx('flex flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed p-4 text-center transition-colors', list ? 'min-h-24 w-full' : 'aspect-[2/3] w-full', over ? 'border-accent bg-accent-soft text-paper' : 'border-line-strong text-muted hover:border-accent hover:text-paper')}
    >
      {busy ? <Loader2 className="size-7 animate-spin" /> : over ? <UploadCloud className="size-7" /> : <Plus className="size-7" />}
      <span className="text-sm font-semibold text-paper">{busy ?? (over ? 'Drop to create a release' : 'New release')}</span>
      {!busy && <span className="text-xs">Click, or drop a PDF, CBZ, ZIP or page images here to create it and upload in one step</span>}
    </button>
  );
}

function Card({ r, series, to }: { r: Release; series: Series; to: string }) {
  return (
    <Link to={to} className="group block">
      <div className="relative">
        <Cover src={r.cover_thumb_url ?? r.cover_url} alt={`Cover of ${r.title}`} className="rounded-xl transition-colors group-hover:border-line-strong" />
        <div className="absolute left-1.5 top-1.5 flex flex-col items-start gap-1">{accessBadge(series, r)}</div>
        <div className="absolute right-1.5 top-1.5"><Badge tone={STATUS_TONE[r.status]}>{cap(r.status)}</Badge></div>
        {r.active_job && (
          <div className="absolute inset-x-1.5 bottom-1.5 rounded-lg bg-black/80 p-2 text-[11px]">
            <ProgressBar value={r.active_job.done} max={r.active_job.total || 1} label={r.active_job.kind === 'detect_frames' ? 'Detecting frames…' : 'Processing pages…'} />
          </div>
        )}
      </div>
      <div className="mt-2 min-w-0">
        <div className="text-xs text-muted">{r.group} · {r.kind_label} {num(r.number)}</div>
        <div className="truncate text-sm font-semibold group-hover:text-accent-hover">{r.title}</div>
        <div className="text-xs text-muted">{r.page_count} {r.page_count === 1 ? 'page' : 'pages'}{r.page_count > 0 && r.frames_missing > 0 && series.layout === 'paged' ? <span className="text-warn"> · {r.frames_missing} without frames</span> : null}</div>
      </div>
    </Link>
  );
}

export function SeriesReleases() {
  const { series, detail, role, base } = useSeries();
  const { meta } = useSession();
  const qc = useQueryClient();
  const nav = useNavigate();
  const editor = can(role, 'editor');
  const [lang, setLang] = useState(series.language);
  const [view, setView] = useState<'grid' | 'list'>(() => { try { return localStorage.getItem('altcomix.studio.releases') === 'list' ? 'list' : 'grid'; } catch { return 'grid'; } });
  const [dialog, setDialog] = useState(false);
  const [pendingFiles, setPendingFiles] = useState<File[]>([]);
  const [dropBusy, setDropBusy] = useState<string | null>(null);
  const [addLang, setAddLang] = useState(false);
  const [newLang, setNewLang] = useState('');
  const list = useReleases(series.id, 4000);
  const setViewPref = (v: 'grid' | 'list') => { setView(v); try { localStorage.setItem('altcomix.studio.releases', v); } catch { /* private mode */ } };
  const available = useMemo(() => meta.languages.filter((l) => !detail.languages.some((x) => x.code === l.code)), [meta.languages, detail.languages]);

  const addEdition = useAct(
    (code: string) => api(`/api/studio/series/${series.id}/editions/${code}`, { method: 'PUT', json: { title: series.title, description: series.description } }),
    { success: (_r, code) => `${languageLabel(meta, code)} edition added. Create its first release.`, invalidate: [seriesKey(series.id)], onDone: (_r, code) => { setLang(code); setAddLang(false); setNewLang(''); } },
  );

  // Drop on the tile: create the release with the next number, then upload straight into it.
  const quickCreate = async (files: File[]) => {
    setDropBusy('Creating release…');
    try {
      const r = await api<{ release: Release }>(`/api/studio/series/${series.id}/releases`, { json: { language: lang } });
      const form = new FormData();
      files.forEach((f) => form.append('files', f, f.name));
      await upload(`/api/studio/releases/${r.release.id}/upload`, form, (p) => setDropBusy(`Uploading… ${Math.round(p * 100)}%`));
      await qc.invalidateQueries({ queryKey: releasesKey(series.id) });
      toast.success(`${r.release.title} created. Your pages are being processed.`);
      nav(`${base}/releases/${r.release.id}`);
    } catch (err) {
      toast.error(errorMessage(err));
      await qc.invalidateQueries({ queryKey: releasesKey(series.id) });
    } finally {
      setDropBusy(null);
    }
  };

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-wrap items-end gap-2">
          <Field label="Language edition" className="w-48">
            <Select value={lang} onChange={(e) => setLang(e.target.value)}>
              {detail.languages.map((l) => <option key={l.code} value={l.code}>{languageLabel(meta, l.code)}{l.primary ? ' (original)' : ''} · {l.releases}</option>)}
            </Select>
          </Field>
          {editor && available.length > 0 && <Button onClick={() => setAddLang(true)} icon={<Plus className="size-4" />}>Add language</Button>}
        </div>
        <div className="flex items-center gap-1 rounded-lg border border-line p-0.5">
          <IconButton label="Grid view" active={view === 'grid'} onClick={() => setViewPref('grid')}><LayoutGrid className="size-4" /></IconButton>
          <IconButton label="List view" active={view === 'list'} onClick={() => setViewPref('list')}><List className="size-4" /></IconButton>
        </div>
      </div>

      <Q query={list}>
        {(d) => {
          const rows = d.releases.filter((r) => r.language === lang);
          const tile = editor ? <NewTile list={view === 'list'} busy={dropBusy} onOpen={() => { setPendingFiles([]); setDialog(true); }} onDrop={quickCreate} /> : null;
          return (
            <>
              {rows.length === 0 && !editor && <EmptyState title="No releases in this language yet">Releases appear here once an editor adds them.</EmptyState>}
              {view === 'grid' ? (
                <div className="grid grid-cols-2 gap-x-3 gap-y-5 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-6">
                  {tile}
                  {rows.map((r) => <Card key={r.id} r={r} series={series} to={`${base}/releases/${r.id}`} />)}
                </div>
              ) : (
                <div className="space-y-3">
                  {tile}
                  <Table
                    rows={rows}
                    rowKey={(r) => r.id}
                    empty="No releases in this language yet"
                    onRowClick={(r) => nav(`${base}/releases/${r.id}`)}
                    columns={[
                      { key: 'cover', header: '', width: '56px', cell: (r) => <Cover src={r.cover_thumb_url} alt="" className="w-9" /> },
                      { key: 'n', header: '#', cell: (r) => <span className="tabular-nums">{num(r.number)}</span> },
                      { key: 'title', header: 'Title', cell: (r) => <Link to={`${base}/releases/${r.id}`} className="font-medium hover:text-accent-hover" onClick={(e) => e.stopPropagation()}>{r.title}</Link> },
                      { key: 'type', header: 'Type', cell: (r) => <span className="text-muted">{r.group} · {r.kind_label}</span>, hideOnMobile: true },
                      { key: 'status', header: 'Status', cell: (r) => <Badge tone={STATUS_TONE[r.status]}>{cap(r.status)}</Badge> },
                      { key: 'pages', header: 'Pages', align: 'right', cell: (r) => r.page_count },
                      { key: 'access', header: 'Access', cell: (r) => accessBadge(series, r), hideOnMobile: true },
                    ]}
                  />
                </div>
              )}
              <NewReleaseDialog open={dialog} onClose={() => setDialog(false)} data={d} language={lang} files={pendingFiles} />
            </>
          );
        }}
      </Q>

      <Modal open={addLang} onClose={() => setAddLang(false)} title="Add a language edition" size="sm" footer={<><Button variant="ghost" onClick={() => setAddLang(false)}>Cancel</Button><Button variant="primary" disabled={!newLang} loading={addEdition.isPending} onClick={() => addEdition.mutate(newLang)}>Add edition</Button></>}>
        <Field label="Language" hint="A translated edition has its own releases, title and description. Readers switch between editions on the series page.">
          <Select value={newLang} onChange={(e) => setNewLang(e.target.value)}>
            <option value="">Choose a language</option>
            {available.map((l) => <option key={l.code} value={l.code}>{l.label}</option>)}
          </Select>
        </Field>
      </Modal>
    </div>
  );
}
