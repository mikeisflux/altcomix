import { useQuery } from '@tanstack/react-query';
import { ImagePlus, LayoutGrid, Plus, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { Link, useNavigate } from 'react-router';
import { api, errorMessage } from '@/lib/api';
import { compact } from '@/lib/format';
import { useSession } from '@/lib/session';
import { Badge, Button, EmptyState, ErrorState, Field, FormRow, FormSection, Input, LinkButton, MultiSelect, Notice, Segmented, Select, Skeleton, Textarea, toast } from '@/ui';
import { ACCESS_LABEL, BrandPage, Cover, IMAGE_TYPES, Q, VISIBILITY_LABEL, can, cap, useBrand, Group } from './shared';
import { TaxBanner } from './Tax';

type SeriesRow = {
  id: string; slug: string; title: string; type: string; language: string; status: string; visibility: string; access_model: string;
  cover_thumb_url?: string | null; cover_url?: string | null; missing_cover: boolean; release_count: number; published_count: number;
  page_count: number; follower_count: number; read_count: number; taken_down: boolean; mature: boolean;
};

export function SeriesList() {
  const { brand, role } = useBrand();
  const list = useQuery({ queryKey: ['studio', 'series-list', brand.id], queryFn: () => api<{ series: SeriesRow[] }>(`/api/studio/brands/${brand.id}/series`) });
  const editor = can(role, 'editor');
  return (
    <BrandPage title="Series" actions={editor && <LinkButton to={`/studio/${brand.slug}/new`} variant="primary" icon={<Plus className="size-4" />}>New series</LinkButton>}>
      <TaxBanner brand={brand} />
      <Q query={list} loader={<div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-36" />)}</div>}>
        {(d) =>
          d.series.length === 0 ? (
            <EmptyState icon={<LayoutGrid />} title="No series yet" action={editor && <LinkButton to={`/studio/${brand.slug}/new`} variant="primary">Create your first series</LinkButton>}>
              A series holds your issues, chapters or volumes. Create one, drop in your pages, and publish.
            </EmptyState>
          ) : (
            <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {d.series.map((s) => (
                <li key={s.id}>
                  <Link to={`/studio/${brand.slug}/series/${s.id}`} className="flex h-full gap-3.5 rounded-2xl border border-line bg-surface p-3.5 transition-colors hover:border-line-strong hover:bg-raised">
                    <Cover src={s.cover_thumb_url ?? s.cover_url} alt={`Cover of ${s.title}`} className="w-20 shrink-0 self-start" />
                    <div className="min-w-0 flex-1">
                      <h2 className="line-clamp-2 text-base font-semibold">{s.title}</h2>
                      <div className="mt-1.5 flex flex-wrap gap-1">
                        <Badge tone={s.visibility === 'public' ? 'ok' : s.visibility === 'unlisted' ? 'info' : 'neutral'}>{VISIBILITY_LABEL[s.visibility]}</Badge>
                        <Badge>{cap(s.status)}</Badge>
                        <Badge tone={s.access_model === 'premium' ? 'accent' : s.access_model === 'free' ? 'sun' : 'danger'}>{ACCESS_LABEL[s.access_model]}</Badge>
                        {s.taken_down && <Badge tone="danger">Taken down</Badge>}
                      </div>
                      <dl className="mt-2 grid grid-cols-3 gap-1 text-xs text-muted">
                        <div><dt className="text-faint">Releases</dt><dd className="tabular-nums text-paper">{s.published_count}/{s.release_count}<span className="sr-only"> published</span></dd></div>
                        <div><dt className="text-faint">Pages</dt><dd className="tabular-nums text-paper">{compact(s.page_count)}</dd></div>
                        <div><dt className="text-faint">Reads</dt><dd className="tabular-nums text-paper">{compact(s.read_count)}</dd></div>
                      </dl>
                      {s.missing_cover && <p className="mt-1.5 text-xs text-warn">No cover yet. It will use page 1 of the first release.</p>}
                    </div>
                  </Link>
                </li>
              ))}
            </ul>
          )
        }
      </Q>
    </BrandPage>
  );
}

const LAYOUT_HELP = { paged: 'Print layout: separate pages, read one or two at a time, or frame by frame on phones.', vertical: 'Vertical scroll: one long strip per episode, read by scrolling. Typical for webtoons.' };
const DIR_HELP = { ltr: 'Left to right: pages and frames run left to right, like Western comics.', rtl: 'Right to left: pages and frames run right to left, like Japanese manga.' };
const ACCESS_HELP = {
  free: 'Free: anyone can read every page. You can still take tips and sell downloads.',
  premium: 'Premium: readers get a free preview, then need a membership or a purchase. You set the preview and prices on the Paywall tab.',
  blocked: 'Blocked: nobody can read it except your team. Use it while you get things ready.',
};

export function SeriesNew() {
  const { brand, role } = useBrand();
  const { meta } = useSession();
  const nav = useNavigate();
  const year = new Date().getFullYear();
  const [f, setF] = useState({
    title: '', description: '', language: brand.primary_language, pub_year: year as number | null, status: 'ongoing', type: 'comic', genre: '' as string,
    themes: [] as string[], art_styles: [] as string[], audiences: [] as string[], advisories: [] as string[], layout: 'paged' as 'paged' | 'vertical',
    reading_dir: 'ltr' as 'ltr' | 'rtl', access_model: 'free' as 'free' | 'premium' | 'blocked', visibility: 'public' as 'public' | 'unlisted' | 'draft',
  });
  const touched = useRef({ layout: false, dir: false });
  const [cover, setCover] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!cover) return setPreview(null);
    const url = URL.createObjectURL(cover);
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [cover]);

  if (!can(role, 'editor')) return <BrandPage title="New series"><Notice tone="warn">Your role can view this brand but not create series.</Notice></BrandPage>;

  const set = (p: Partial<typeof f>) => setF((x) => ({ ...x, ...p }));
  const setType = (type: string) => {
    const p: Partial<typeof f> = { type };
    // Follow the conventions of the format until the creator says otherwise.
    if (!touched.current.layout) p.layout = type === 'webcomic' ? 'vertical' : 'paged';
    if (!touched.current.dir) p.reading_dir = type === 'manga' ? 'rtl' : 'ltr';
    set(p);
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const data = { ...f, genre: f.genre || null };
      const form = new FormData();
      form.append('data', JSON.stringify(data));
      if (cover) form.append('cover', cover);
      const r = await api<{ series: { id: string } }>(`/api/studio/brands/${brand.id}/series`, { form });
      toast.success('Series created. Add your first release.');
      nav(`/studio/${brand.slug}/series/${r.series.id}`);
    } catch (err) {
      setError(errorMessage(err));
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <BrandPage title="New series">
      <form onSubmit={submit} className="mx-auto max-w-4xl">
        <h2 className="mb-1 text-xl font-bold">New series</h2>
        <p className="mb-5 text-sm text-muted">Only the title is required. Everything here can be changed later.</p>
        {error && <div className="mb-4"><ErrorState message={error} /></div>}
        <FormSection title="The basics" description="What readers see first.">
          <div className="grid gap-4 sm:grid-cols-[140px_1fr]">
            <div>
              <span className="mb-1.5 block text-[13px] font-medium">Cover <span className="text-xs font-normal text-faint">Optional</span></span>
              <input ref={fileRef} type="file" accept={IMAGE_TYPES} className="sr-only" tabIndex={-1} aria-hidden onChange={(e) => setCover(e.target.files?.[0] ?? null)} />
              <button type="button" onClick={() => fileRef.current?.click()} aria-label={cover ? 'Change cover image' : 'Choose a cover image'} className="relative flex aspect-[2/3] w-full max-w-[140px] flex-col items-center justify-center gap-1.5 overflow-hidden rounded-lg border border-dashed border-line-strong bg-ink text-xs text-muted hover:border-accent hover:text-paper">
                {preview ? <img src={preview} alt="Chosen cover" className="absolute inset-0 size-full object-cover" /> : <><ImagePlus className="size-6" />Choose image</>}
              </button>
              {cover && <button type="button" className="mt-1.5 inline-flex items-center gap-1 text-xs text-muted hover:text-paper" onClick={() => setCover(null)}><X className="size-3" />Remove</button>}
            </div>
            <div className="space-y-4">
              <Field label="Title"><Input autoFocus required maxLength={150} value={f.title} onChange={(e) => set({ title: e.target.value })} /></Field>
              <Field label="Description" optional><Textarea maxLength={1800} value={f.description} onChange={(e) => set({ description: e.target.value })} /></Field>
              <p className="text-xs text-faint">No cover to hand? Leave it empty: page 1 of your first release becomes the cover, so the series is never hidden by accident.</p>
            </div>
          </div>
        </FormSection>

        <FormSection title="Format" description="How the comic is laid out and read.">
          <FormRow cols={3}>
            <Field label="Type"><Select value={f.type} onChange={(e) => setType(e.target.value)}>{meta.seriesTypes.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}</Select></Field>
            <Field label="Language"><Select value={f.language} onChange={(e) => set({ language: e.target.value })}>{meta.languages.map((l) => <option key={l.code} value={l.code}>{l.label}</option>)}</Select></Field>
            <Field label="Status"><Select value={f.status} onChange={(e) => set({ status: e.target.value })}>{meta.seriesStatuses.map((s) => <option key={s} value={s}>{cap(s)}</option>)}</Select></Field>
          </FormRow>
          <Group label="Page layout" hint={LAYOUT_HELP[f.layout]}>
            <Segmented value={f.layout} onChange={(v) => { touched.current.layout = true; set({ layout: v }); }} options={[{ value: 'paged', label: 'Print layout' }, { value: 'vertical', label: 'Vertical scroll' }]} />
          </Group>
          <Group label="Reading direction" hint={DIR_HELP[f.reading_dir]}>
            <Segmented value={f.reading_dir} onChange={(v) => { touched.current.dir = true; set({ reading_dir: v }); }} options={[{ value: 'ltr', label: 'Left to right' }, { value: 'rtl', label: 'Right to left' }]} />
          </Group>
          <Field label="Original publishing year" optional className="max-w-56">
            <Input type="number" min={1800} max={year + 2} value={f.pub_year ?? ''} onChange={(e) => set({ pub_year: e.target.value ? Number(e.target.value) : null })} />
          </Field>
        </FormSection>

        <FormSection title="Help readers find it" description="Used for browsing, search and recommendations.">
          <FormRow>
            <Field label="Genre"><Select value={f.genre} onChange={(e) => set({ genre: e.target.value })}><option value="">Choose a genre</option>{meta.genres.map((g) => <option key={g}>{g}</option>)}</Select></Field>
            <Group label="Themes" hint="Up to 6"><MultiSelect value={f.themes} onChange={(v) => set({ themes: v })} options={meta.themes} max={6} /></Group>
            <Group label="Art style" hint="Up to 2"><MultiSelect value={f.art_styles} onChange={(v) => set({ art_styles: v })} options={meta.artStyles} max={2} /></Group>
            <Group label="Audience" hint="Up to 3"><MultiSelect value={f.audiences} onChange={(v) => set({ audiences: v })} options={meta.audiences} max={3} /></Group>
          </FormRow>
          <Group label="Content advisories" hint="Tick anything a reader might want to know before starting."><MultiSelect value={f.advisories} onChange={(v) => set({ advisories: v })} options={meta.advisories} placeholder="None" /></Group>
        </FormSection>

        <FormSection title="Access" description="Who can read it. You can fine-tune previews, prices and country rules after creating the series.">
          <Group label="Who can read" hint={ACCESS_HELP[f.access_model]}>
            <Segmented value={f.access_model} onChange={(v) => set({ access_model: v })} options={[{ value: 'free', label: 'Free' }, { value: 'premium', label: 'Premium' }, { value: 'blocked', label: 'Blocked' }]} />
          </Group>
          <Group label="Listing" hint={f.visibility === 'public' ? 'Shown in the store and search as soon as a release is published.' : f.visibility === 'unlisted' ? 'Hidden from the store and search; anyone with the link can open it.' : 'Only your team can see it.'}>
            <Segmented value={f.visibility} onChange={(v) => set({ visibility: v })} options={[{ value: 'public', label: 'Public' }, { value: 'unlisted', label: 'Unlisted' }, { value: 'draft', label: 'Draft' }]} />
          </Group>
        </FormSection>

        <div className="sticky bottom-0 -mx-4 flex justify-end gap-2 border-t border-line bg-ink/95 px-4 py-3 backdrop-blur sm:mx-0 sm:px-0">
          <LinkButton to={`/studio/${brand.slug}`} variant="ghost">Cancel</LinkButton>
          <Button type="submit" variant="primary" loading={busy}>Create series</Button>
        </div>
      </form>
    </BrandPage>
  );
}
