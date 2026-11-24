import { useQuery } from '@tanstack/react-query';
import { ChevronRight, ExternalLink } from 'lucide-react';
import { Link, Outlet, useOutletContext, useParams } from 'react-router';
import { api } from '@/lib/api';
import { Badge, LinkButton, NavTabs, Notice, toast } from '@/ui';
import { ACCESS_LABEL, Cover, FileButton, IMAGE_TYPES, Q, VISIBILITY_LABEL, can, cap, useAct, useBrand, useTitle } from './shared';
import type { Role, StudioBrand } from './shared';

export type FreePreview = { mode: 'first_releases' | 'first_last_releases' | 'first_pages' | 'custom_first' | 'custom_first_last' | 'automatic'; n?: number; m?: number };
export type Crowdfunding = { enabled: boolean; service: string; goal_cents: number | null; url: string | null; timezone: string | null; starts_at: string | null; ends_at: string | null };
export type Series = {
  id: string; publisher_id: string; slug: string; title: string; description: string; type: string; layout: 'paged' | 'vertical'; reading_dir: 'ltr' | 'rtl';
  language: string; status: string; visibility: 'draft' | 'public' | 'unlisted'; genre: string | null; themes: string[]; audiences: string[]; art_styles: string[];
  advisories: string[]; eras: string[]; content_ratings: string[]; tags: string[]; mature: boolean; cover_url: string | null; cover_thumb_url: string | null;
  banner_url: string | null; access_model: 'blocked' | 'free' | 'premium'; in_subscription: boolean; free_preview: FreePreview; paywall_expires_days: number | null;
  default_price_cents: number | null; allow_comments: boolean; update_frequency: string | null; website: string | null; pub_year: number | null;
  crowdfunding: Crowdfunding | null; forum_enabled: boolean; forum_description: string; favorite_count: number; follower_count: number; read_count: number;
  takedown: { at: string; reason: string; purge: boolean } | null;
};
export type Edition = { language: string; title: string; description: string; access_model: 'blocked' | 'free' | 'premium' | null };
export type CountryRule = { id: string; country: string; language: string | null; rule: 'blocked' | 'free' | 'premium'; enabled: boolean };
export type Contributor = { id: string; release_id: string | null; name: string; role: string; position: number; user_id: string | null; username: string | null };
export type Moderator = { source: 'owner' | 'moderator'; user_id: string; username: string; display_name: string; avatar_url: string | null; created_at: string };
export type Split = { id: string; share_bps: number; note: string; payee_id: string; payee_slug: string; payee_name: string };
export type SeriesDetail = {
  series: Series; brand: { id: string; slug: string; name: string }; languages: { code: string; primary: boolean; releases: number }[]; editions: Edition[];
  country_rules: CountryRule[]; contributors: Contributor[]; moderators: Moderator[]; splits: Split[];
  revenue_share: { sale_bps: number; subscription_bps: number; tip_bps: number; split_out_bps: number };
};

export type Release = {
  id: string; series_id: string; number: number; kind: string; kind_label: string; group: string | null; language: string; title: string; synopsis: string;
  mature: boolean; status: 'draft' | 'scheduled' | 'published'; publish_at: string | null; published_at: string | null; price_cents: number | null;
  download_price_cents: number | null; download_discount_pct: number | null; force_free: boolean; free_at: string | null; free_pages: number | null;
  themes: string[]; audiences: string[]; content_ratings: string[]; isbn: string | null; print_url: string | null; orig_pub_date: string | null;
  page_count: number; cover_page_id: string | null; cover_url: string | null; cover_thumb_url: string | null; spread_pref: 'first' | 'last'; single_cover: boolean;
  url: string; frames_missing: number; contributor_count?: number; active_job?: { id: string; kind: string; status: string; done: number; total: number } | null;
};
export type ReleaseList = { series: { id: string; title: string; slug: string; language: string; reading_dir: string }; releases: Release[]; groups: { group: string; kinds: { id: string; label: string }[] }[] };

export const seriesKey = (id: string) => ['studio', 'series', id];
export const releasesKey = (id: string) => ['studio', 'releases', id];

type Ctx = { detail: SeriesDetail; series: Series; brand: StudioBrand; role: Role; base: string };
export function useSeries(): Ctx {
  return useOutletContext<Ctx>();
}

export function useReleases(seriesId: string, refetchInterval?: number | false) {
  return useQuery({ queryKey: releasesKey(seriesId), queryFn: () => api<ReleaseList>(`/api/studio/series/${seriesId}/releases`), refetchInterval });
}

export function SeriesEditor() {
  const { brand, role } = useBrand();
  const { series: id = '' } = useParams();
  const detail = useQuery({ queryKey: seriesKey(id), queryFn: () => api<SeriesDetail>(`/api/studio/series/${id}`) });
  useTitle(detail.data ? `${detail.data.series.title} · ${brand.name}` : 'Series');
  const cover = useAct(
    (file: File) => {
      const form = new FormData();
      form.append('file', file);
      return api(`/api/studio/series/${id}/cover`, { form });
    },
    { success: 'Cover updated', invalidate: [seriesKey(id), ['studio', 'series-list', brand.id]] },
  );
  const base = `/studio/${brand.slug}/series/${id}`;
  return (
    <Q query={detail}>
      {(d) => {
        const s = d.series;
        if (s.publisher_id !== brand.id) return <Notice tone="warn">This series belongs to another brand.</Notice>;
        return (
          <div>
            <nav aria-label="Breadcrumb" className="mb-3 flex flex-wrap items-center gap-1 text-sm text-muted">
              <Link to={`/studio/${brand.slug}`} className="hover:text-paper">{brand.name}</Link>
              <ChevronRight className="size-3.5" aria-hidden />
              <span className="text-paper">{s.title}</span>
            </nav>
            <header className="mb-5 flex gap-4">
              <div className="w-20 shrink-0 sm:w-24">
                <Cover src={s.cover_thumb_url ?? s.cover_url} alt={`Cover of ${s.title}`} />
              </div>
              <div className="min-w-0 flex-1">
                <h1 className="text-2xl font-bold sm:text-3xl">{s.title}</h1>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  <Badge tone={s.visibility === 'public' ? 'ok' : s.visibility === 'unlisted' ? 'info' : 'neutral'}>{VISIBILITY_LABEL[s.visibility]}</Badge>
                  <Badge>{cap(s.status)}</Badge>
                  <Badge tone={s.access_model === 'premium' ? 'accent' : s.access_model === 'free' ? 'sun' : 'danger'}>{ACCESS_LABEL[s.access_model]}</Badge>
                  {s.mature && <Badge tone="warn">Mature</Badge>}
                </div>
                <div className="mt-3 flex flex-wrap gap-2">
                  {can(role, 'editor') && <FileButton accept={IMAGE_TYPES} size="sm" loading={cover.isPending} onFiles={(f) => (f[0].size > 30 * 1024 * 1024 ? toast.error('Choose an image under 30 MB') : cover.mutate(f[0]))}>{s.cover_url ? 'Change cover' : 'Upload cover'}</FileButton>}
                  <LinkButton to={`/series/${s.slug}`} size="sm" variant="ghost" icon={<ExternalLink className="size-4" />}>Public page</LinkButton>
                </div>
              </div>
            </header>
            {s.takedown && <div className="mb-4"><Notice tone="danger">NSFWComix has taken this series down{s.takedown.reason ? `: ${s.takedown.reason}` : ''}. {s.takedown.purge ? 'It has been removed completely: nobody can open it, including readers who bought it, and its files cannot be downloaded from the Studio.' : 'It is hidden from the store, search and your brand page. Readers who already own a release can still read it from their library.'} Contact support to resolve this.</Notice></div>}
            {!s.cover_url && <div className="mb-4"><Notice tone="info">No cover yet. Upload one, or add a release: its first page becomes the cover automatically.</Notice></div>}
            <NavTabs tabs={[{ to: base, label: 'Releases', end: true }, { to: `${base}/details`, label: 'Details' }, { to: `${base}/paywall`, label: 'Paywall' }, { to: `${base}/advanced`, label: 'Advanced' }]} />
            <Outlet context={{ detail: d, series: s, brand, role, base } satisfies Ctx} />
          </div>
        );
      }}
    </Q>
  );
}
