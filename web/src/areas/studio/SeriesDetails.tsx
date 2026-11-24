import { useQueryClient } from '@tanstack/react-query';
import { FolderOpen, Link2, Tags, Users } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router';
import { api, errorMessage } from '@/lib/api';
import { languageLabel, useSession } from '@/lib/session';
import { Badge, Button, Checkbox, EmptyState, Field, FormRow, IconButton, Input, Modal, MultiSelect, Notice, Select, Switch, TagInput, Textarea, cx, toast } from '@/ui';
import { ContributorsEditor } from './Contributors';
import { releasesKey, seriesKey, useReleases, useSeries } from './SeriesEditor';
import type { Edition, Release, ReleaseList, Series } from './SeriesEditor';
import { Cover, Q, STATUS_TONE, Section, can, cap, changed, useAct, useDraft, Group } from './shared';

type Meta = Pick<Series, 'title' | 'description' | 'genre' | 'themes' | 'eras' | 'audiences' | 'art_styles' | 'advisories' | 'content_ratings' | 'tags' | 'allow_comments' | 'update_frequency' | 'mature'>;
const pickMeta = (s: Series): Meta => ({
  title: s.title, description: s.description, genre: s.genre, themes: s.themes, eras: s.eras, audiences: s.audiences, art_styles: s.art_styles,
  advisories: s.advisories, content_ratings: s.content_ratings, tags: s.tags, allow_comments: s.allow_comments, update_frequency: s.update_frequency, mature: s.mature,
});

export function SaveBar({ dirty, saving, onSave, onReset, label = 'Save changes' }: { dirty: boolean; saving: boolean; onSave: () => void; onReset: () => void; label?: string }) {
  if (!dirty) return null;
  return (
    <div className="sticky bottom-3 z-20 mt-4 flex items-center justify-between gap-3 rounded-xl border border-line-strong bg-raised px-4 py-2.5 shadow-pop">
      <span className="text-sm text-muted">You have unsaved changes</span>
      <div className="flex gap-2"><Button variant="ghost" onClick={onReset} disabled={saving}>Discard</Button><Button variant="primary" loading={saving} onClick={onSave}>{label}</Button></div>
    </div>
  );
}

function MetadataForm() {
  const { series, role, brand } = useSeries();
  const { meta } = useSession();
  const server = useMemo(() => pickMeta(series), [series]);
  const [d, set, dirty, reset] = useDraft(server);
  const editable = can(role, 'editor');
  const save = useAct(() => api(`/api/studio/series/${series.id}`, { method: 'PATCH', json: changed(server, d) }), { success: 'Series details saved', invalidate: [seriesKey(series.id), ['studio', 'series-list', brand.id]] });
  return (
    <Section title="About this series" description="Shown on the series page and used for browsing and search. These settings are shared by every language edition.">
      <fieldset disabled={!editable} className="space-y-4">
        <Field label="Title"><Input value={d.title} maxLength={150} onChange={(e) => set({ title: e.target.value })} /></Field>
        <Field label="Description"><Textarea value={d.description} maxLength={1800} onChange={(e) => set({ description: e.target.value })} /></Field>
        <FormRow cols={3}>
          <Field label="Genre"><Select value={d.genre ?? ''} onChange={(e) => set({ genre: e.target.value || null })}><option value="">None</option>{meta.genres.map((g) => <option key={g}>{g}</option>)}</Select></Field>
          <Field label="Update frequency"><Select value={d.update_frequency ?? ''} onChange={(e) => set({ update_frequency: e.target.value || null })}><option value="">Not set</option>{meta.updateFrequencies.map((g) => <option key={g}>{g}</option>)}</Select></Field>
        </FormRow>
        <FormRow>
          <Group label="Themes" hint="Up to 6"><MultiSelect value={d.themes} onChange={(v) => set({ themes: v })} options={meta.themes} max={6} /></Group>
          <Group label="Time or era"><MultiSelect value={d.eras} onChange={(v) => set({ eras: v })} options={meta.eras} /></Group>
          <Group label="Audience" hint="Up to 3"><MultiSelect value={d.audiences} onChange={(v) => set({ audiences: v })} options={meta.audiences} max={3} /></Group>
          <Group label="Art style" hint="Up to 2"><MultiSelect value={d.art_styles} onChange={(v) => set({ art_styles: v })} options={meta.artStyles} max={2} /></Group>
          <Group label="Content advisories"><MultiSelect value={d.advisories} onChange={(v) => set({ advisories: v })} options={meta.advisories} placeholder="None" /></Group>
          <Group label="Content rating"><MultiSelect value={d.content_ratings} onChange={(v) => set({ content_ratings: v })} options={meta.contentRatings} /></Group>
        </FormRow>
        <Group label="Tags" hint="Up to 20. Press Enter or comma after each."><TagInput value={d.tags} onChange={(v) => set({ tags: v })} max={20} /></Group>
        <div className="divide-y divide-line">
          <Switch checked={d.allow_comments} onChange={(v) => set({ allow_comments: v })} disabled={!editable} label="Allow comments" description="Readers can comment on releases of this series." />
          <Switch checked={d.mature} onChange={(v) => set({ mature: v })} disabled={!editable} label="Mature series" description="Hidden from readers who have not opted in to mature content. New releases start as mature." />
        </div>
      </fieldset>
      <SaveBar dirty={dirty} saving={save.isPending} onSave={() => save.mutate()} onReset={reset} />
    </Section>
  );
}

function EditionRow({ e, canEdit }: { e: Edition; canEdit: boolean }) {
  const { series } = useSeries();
  const { meta } = useSession();
  const server = useMemo(() => ({ title: e.title, description: e.description }), [e.title, e.description]);
  const [d, set, dirty, reset] = useDraft(server);
  const save = useAct(() => api(`/api/studio/series/${series.id}/editions/${e.language}`, { method: 'PUT', json: d }), { success: `${languageLabel(meta, e.language)} details saved`, invalidate: [seriesKey(series.id)] });
  return (
    <div className="rounded-xl border border-line p-3.5">
      <h3 className="mb-3 text-sm font-semibold">{languageLabel(meta, e.language)}</h3>
      <fieldset disabled={!canEdit} className="space-y-3">
        <Field label="Title in this language"><Input value={d.title} maxLength={150} onChange={(ev) => set({ title: ev.target.value })} /></Field>
        <Field label="Description in this language"><Textarea value={d.description} maxLength={1800} className="min-h-20" onChange={(ev) => set({ description: ev.target.value })} /></Field>
      </fieldset>
      {dirty && <div className="mt-3 flex justify-end gap-2"><Button variant="ghost" size="sm" onClick={reset}>Discard</Button><Button variant="primary" size="sm" loading={save.isPending} onClick={() => save.mutate()}>Save {languageLabel(meta, e.language)}</Button></div>}
    </div>
  );
}

type RowDraft = Pick<Release, 'title' | 'kind' | 'number' | 'isbn' | 'orig_pub_date' | 'mature' | 'audiences' | 'themes' | 'content_ratings'>;
const pickRow = (r: Release): RowDraft => ({ title: r.title, kind: r.kind, number: Number(r.number), isbn: r.isbn, orig_pub_date: r.orig_pub_date ? r.orig_pub_date.slice(0, 10) : null, mature: r.mature, audiences: r.audiences, themes: r.themes, content_ratings: r.content_ratings });

const cell = 'h-9 rounded-md border border-line bg-ink px-2 text-sm hover:border-line-strong focus:border-accent focus:outline-none disabled:opacity-60';

export function BulkReleases({ data }: { data: ReleaseList }) {
  const { series, detail, role, base } = useSeries();
  const { meta } = useSession();
  const qc = useQueryClient();
  const editable = can(role, 'editor');
  const [edits, setEdits] = useState<Record<string, Partial<RowDraft>>>({});
  const [tagsFor, setTagsFor] = useState<string | null>(null);
  const [creditsFor, setCreditsFor] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const rows = data.releases;
  const row = (r: Release): RowDraft => ({ ...pickRow(r), ...edits[r.id] });
  const edit = (r: Release, p: Partial<RowDraft>) =>
    setEdits((all) => {
      const next = { ...all[r.id], ...p };
      const diff = changed(pickRow(r), { ...pickRow(r), ...next });
      const out = { ...all };
      if (Object.keys(diff).length) out[r.id] = diff;
      else delete out[r.id];
      return out;
    });
  const dirtyCount = Object.keys(edits).length;
  // Drop edits for releases that no longer exist.
  useEffect(() => {
    setEdits((all) => Object.fromEntries(Object.entries(all).filter(([id]) => rows.some((r) => r.id === id))));
  }, [rows]);

  const save = async () => {
    setSaving(true);
    try {
      const releases = Object.entries(edits).map(([id, p]) => ({ id, ...p, isbn: p.isbn === null ? '' : p.isbn }));
      for (const r of releases) if (r.isbn === undefined) delete r.isbn;
      await api(`/api/studio/series/${series.id}/releases/bulk`, { method: 'PUT', json: { releases } });
      setEdits({});
      await qc.invalidateQueries({ queryKey: releasesKey(series.id) });
      toast.success(`${releases.length} ${releases.length === 1 ? 'release' : 'releases'} saved`);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };
  const publish = useAct((id: string) => api(`/api/studio/releases/${id}/publish`, { json: {} }), { success: 'Release published', invalidate: [releasesKey(series.id)] });

  const tagRelease = rows.find((r) => r.id === tagsFor);
  const creditRelease = rows.find((r) => r.id === creditsFor);
  if (!rows.length) return <EmptyState title="No releases yet" action={<Link className="link" to={base}>Add a release</Link>}>Once this series has releases, you can edit all of their details here in one table.</EmptyState>;
  return (
    <div>
      <div className="relative overflow-x-auto rounded-xl border border-line">
        <table className="w-full min-w-max border-collapse text-sm">
          <thead>
            <tr className="border-b border-line bg-surface text-left text-[12px] uppercase tracking-wide text-muted">
              {['', 'Type', '#', 'Title', 'Pages', 'ISBN', 'First published', 'Mature', 'Labels', 'Credits', 'Status', ''].map((h, i) => <th key={i} className="px-2.5 py-2.5 font-medium">{h}</th>)}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const d = row(r);
              const labels = d.audiences.length + d.themes.length + d.content_ratings.length;
              const credits = detail.contributors.filter((c) => c.release_id === r.id).length;
              return (
                <tr key={r.id} className={cx('border-b border-line last:border-0', edits[r.id] && 'bg-accent-soft/40')}>
                  <td className="px-2.5 py-2"><Cover src={r.cover_thumb_url} alt="" className="w-8" /></td>
                  <td className="px-2.5 py-2">
                    <select aria-label={`Type of ${r.title}`} disabled={!editable} className={cx(cell, 'w-36')} value={d.kind} onChange={(e) => edit(r, { kind: e.target.value })}>
                      {data.groups.map((g) => <optgroup key={g.group} label={g.group}>{g.kinds.map((k) => <option key={k.id} value={k.id}>{k.label}</option>)}</optgroup>)}
                    </select>
                  </td>
                  <td className="px-2.5 py-2"><input aria-label={`Number of ${r.title}`} disabled={!editable} type="number" min={0} step="0.01" className={cx(cell, 'w-20 tabular-nums')} value={Number.isNaN(d.number) ? '' : d.number} onChange={(e) => edit(r, { number: e.target.value === '' ? NaN : Number(e.target.value) })} /></td>
                  <td className="px-2.5 py-2"><input aria-label="Title" disabled={!editable} className={cx(cell, 'w-56')} value={d.title} maxLength={200} onChange={(e) => edit(r, { title: e.target.value })} /></td>
                  <td className="px-2.5 py-2 text-right tabular-nums text-muted">{r.page_count}</td>
                  <td className="px-2.5 py-2"><input aria-label={`ISBN of ${r.title}`} disabled={!editable} className={cx(cell, 'w-40')} value={d.isbn ?? ''} placeholder="10 or 13 digits" onChange={(e) => edit(r, { isbn: e.target.value || null })} /></td>
                  <td className="px-2.5 py-2"><input aria-label={`First published date of ${r.title}`} disabled={!editable} type="date" className={cx(cell, 'w-40')} value={d.orig_pub_date ?? ''} onChange={(e) => edit(r, { orig_pub_date: e.target.value || null })} /></td>
                  <td className="px-2.5 py-2"><Checkbox checked={d.mature} disabled={!editable} onChange={(v) => edit(r, { mature: v })} label={<span className="sr-only">Mature</span>} /></td>
                  <td className="px-2.5 py-2"><Button size="sm" onClick={() => setTagsFor(r.id)} icon={<Tags className="size-4" />}>{labels || 'Add'}</Button></td>
                  <td className="px-2.5 py-2"><Button size="sm" onClick={() => setCreditsFor(r.id)} icon={<Users className="size-4" />}>{credits || 'Add'}</Button></td>
                  <td className="px-2.5 py-2">
                    <div className="flex items-center gap-2">
                      <Badge tone={STATUS_TONE[r.status]}>{cap(r.status)}</Badge>
                      {editable && r.status !== 'published' && r.page_count > 0 && <Button size="sm" disabled={publish.isPending} onClick={() => publish.mutate(r.id)}>Publish</Button>}
                    </div>
                  </td>
                  <td className="px-2.5 py-2">
                    <div className="flex items-center">
                      <IconButton label={`Copy reader link for ${r.title}`} onClick={() => navigator.clipboard.writeText(r.url).then(() => toast.success('Reader link copied'), () => toast.error('Could not copy the link'))}><Link2 className="size-4" /></IconButton>
                      <Link to={`${base}/releases/${r.id}`} aria-label={`Open pages of ${r.title}`} title="Pages and files" className="inline-flex size-9 items-center justify-center rounded-lg text-muted hover:bg-hover hover:text-paper"><FolderOpen className="size-4" /></Link>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <SaveBar dirty={dirtyCount > 0} saving={saving} onSave={save} onReset={() => setEdits({})} label={`Save ${dirtyCount} ${dirtyCount === 1 ? 'release' : 'releases'}`} />

      <Modal open={Boolean(tagRelease)} onClose={() => setTagsFor(null)} title={`Labels for ${tagRelease?.title ?? ''}`} footer={<Button variant="primary" onClick={() => setTagsFor(null)}>Done</Button>}>
        {tagRelease && (
          <div className="min-h-72 space-y-4">
            <p className="text-sm text-muted">Use these when a release differs from the series as a whole. They are saved with the rest of the table.</p>
            <Group label="Audience" hint="Up to 3"><MultiSelect value={row(tagRelease).audiences} onChange={(v) => edit(tagRelease, { audiences: v })} options={meta.audiences} max={3} /></Group>
            <Group label="Themes" hint="Up to 6"><MultiSelect value={row(tagRelease).themes} onChange={(v) => edit(tagRelease, { themes: v })} options={meta.themes} max={6} /></Group>
            <Group label="Content rating"><MultiSelect value={row(tagRelease).content_ratings} onChange={(v) => edit(tagRelease, { content_ratings: v })} options={meta.contentRatings} /></Group>
          </div>
        )}
      </Modal>
      <Modal open={Boolean(creditRelease)} onClose={() => setCreditsFor(null)} title={`Credits for ${creditRelease?.title ?? ''}`} size="lg">
        {creditRelease && <ContributorsEditor seriesId={series.id} releaseId={creditRelease.id} contributors={detail.contributors.filter((c) => c.release_id === creditRelease.id)} invalidate={[seriesKey(series.id)]} canEdit={editable} />}
      </Modal>
    </div>
  );
}

export function SeriesDetails() {
  const { series, detail, role } = useSeries();
  const list = useReleases(series.id);
  return (
    <div className="space-y-5">
      <MetadataForm />
      {detail.editions.length > 0 && (
        <Section title="Translated titles and descriptions" description="Each language edition can have its own title and description. Add editions on the Releases or Advanced tab.">
          <div className="grid gap-3 lg:grid-cols-2">{detail.editions.map((e) => <EditionRow key={e.language} e={e} canEdit={can(role, 'editor')} />)}</div>
        </Section>
      )}
      <Section title="All releases" description="Edit any number of rows, then save them all at once. Numbers can be swapped between rows in the same save.">
        {!can(role, 'editor') && <Notice tone="info">Your role can view these details but not change them.</Notice>}
        <Q query={list}>{(d) => <BulkReleases data={d} />}</Q>
      </Section>
    </div>
  );
}
