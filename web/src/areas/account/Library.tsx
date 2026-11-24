import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { BookOpen, Download, Heart, History, LibraryBig, Rss } from 'lucide-react';
import type { ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router';
import { api, errorMessage } from '@/lib/api';
import { ago, date, plural } from '@/lib/format';
import { Avatar, Badge, Button, EmptyState, ErrorState, LinkButton, PageHeader, Pagination, ProgressBar, Tabs, buttonClass, toast, useConfirm } from '@/ui';
import { Cover, CoverGrid, GridSkeleton, ListSkeleton, SeriesTile, releaseLabel, useTitle } from './shared';
import type { ReleaseRef, SeriesCard } from './shared';

const TABS = [
  { value: 'continue', label: 'Continue reading' },
  { value: 'owned', label: 'Owned' },
  { value: 'downloads', label: 'Downloads' },
  { value: 'following', label: 'Following' },
  { value: 'favorites', label: 'Favorites' },
  { value: 'history', label: 'History' },
] as const;
type Tab = (typeof TABS)[number]['value'];

type Progress = { release: ReleaseRef; position: number; finished: boolean; read_at: string; percent: number; series: SeriesCard };
type Owned = {
  release: ReleaseRef & { published: boolean };
  series: { id: string; slug: string; title: string; cover_url: string | null; publisher: { slug: string; name: string } };
  source: string;
  can_download: boolean;
  download_url: string | null;
  acquired_at: string;
  order_id: string | null;
};
type FollowedBrand = { id: string; slug: string; name: string; kind: string; avatar_url: string | null; followed_at: string };
type Paged<T> = { items: T[]; total: number; page: number; limit: number };

const SOURCE: Record<string, string> = { purchase: 'Bought', code: 'Redeemed with a code', grant: 'Gift from the creator' };

function Shelf<T>({ query, skeleton = 'grid', empty, children }: { query: { isPending: boolean; isError: boolean; error: unknown; refetch: () => void; data: T | undefined }; skeleton?: 'grid' | 'list'; empty: (d: T) => ReactNode | null; children: (d: T) => ReactNode }) {
  if (query.isPending) return skeleton === 'grid' ? <GridSkeleton /> : <ListSkeleton />;
  if (query.isError || !query.data) return <ErrorState message={errorMessage(query.error)} retry={() => query.refetch()} />;
  return <>{empty(query.data) ?? children(query.data)}</>;
}

function ProgressRow({ item, history }: { item: Progress; history?: boolean }) {
  const pages = item.release.page_count ?? 0;
  return (
    <li className="flex gap-4 rounded-2xl border border-line bg-surface p-3 sm:p-4">
      <Link to={`/series/${item.series.slug}`} className="w-16 shrink-0 sm:w-20" aria-label={item.series.title}>
        <Cover src={item.release.cover_url} title={item.series.title} />
      </Link>
      <div className="flex min-w-0 flex-1 flex-col justify-between gap-3">
        <div className="min-w-0">
          <Link to={`/series/${item.series.slug}`} className="block truncate font-display text-base font-semibold hover:text-accent-hover">{item.series.title}</Link>
          <div className="truncate text-sm text-muted">{releaseLabel(item.release)}</div>
          <div className="mt-0.5 text-xs text-faint">{history ? 'Last opened' : 'Read'} {ago(item.read_at)}</div>
        </div>
        <div className="flex flex-wrap items-end gap-x-4 gap-y-2">
          <div className="min-w-32 flex-1">
            <ProgressBar value={item.percent} max={100} label={item.finished ? 'Finished' : pages ? `Page ${Math.min(item.position + 1, pages)} of ${pages}` : `${item.percent}% read`} />
          </div>
          <LinkButton to={`/read/${item.release.id}`} variant={history ? 'secondary' : 'primary'} size="sm" icon={<BookOpen className="size-4" />}>
            {item.finished ? 'Read again' : 'Resume'}
          </LinkButton>
        </div>
      </div>
    </li>
  );
}

function ContinueTab({ history }: { history?: boolean }) {
  const query = useQuery({
    queryKey: ['library', history ? 'history' : 'continue'],
    queryFn: () => api<{ items: Progress[] }>(history ? '/api/library/history' : '/api/library/continue'),
  });
  return (
    <Shelf
      query={query}
      skeleton="list"
      empty={(d) =>
        d.items.length ? null : history ? (
          <EmptyState icon={<History />} title="No reading history yet" action={<LinkButton to="/" variant="primary">Find something to read</LinkButton>}>
            Every release you open is listed here, finished or not, so you can find it again.
          </EmptyState>
        ) : (
          <EmptyState icon={<BookOpen />} title="Nothing in progress" action={<LinkButton to="/" variant="primary">Browse the store</LinkButton>}>
            Start any comic and it shows up here with your place saved, on every device you sign in on.
          </EmptyState>
        )
      }
    >
      {(d) => <ul className="grid gap-3 xl:grid-cols-2">{d.items.map((it) => <ProgressRow key={it.release.id} item={it} history={history} />)}</ul>}
    </Shelf>
  );
}

function OwnedTab({ downloads }: { downloads?: boolean }) {
  const [params, setParams] = useSearchParams();
  const page = Math.max(1, Number(params.get('page')) || 1);
  const query = useQuery({
    queryKey: ['library', downloads ? 'downloads' : 'owned', page],
    queryFn: () => api<Paged<Owned>>(downloads ? '/api/library/downloads' : '/api/library/owned', { query: { page } }),
  });
  const setPage = (p: number) => {
    const next = new URLSearchParams(params);
    next.set('page', String(p));
    setParams(next);
  };
  return (
    <Shelf
      query={query}
      skeleton="list"
      empty={(d) =>
        d.items.length ? null : downloads ? (
          <EmptyState icon={<Download />} title="No downloads yet" action={<LinkButton to="/" variant="primary">Browse the store</LinkButton>}>
            When a purchase includes the file, it appears here as a CBZ you can keep and read in any comic app.
          </EmptyState>
        ) : (
          <EmptyState icon={<LibraryBig />} title="You do not own any comics yet" action={<LinkButton to="/" variant="primary">Browse the store</LinkButton>}>
            Comics you buy or unlock with a code are yours to read for good, and they are listed here. Have a code?{' '}
            <Link className="link" to="/account/codes">Redeem it</Link>.
          </EmptyState>
        )
      }
    >
      {(d) => (
        <>
          <p className="mb-3 text-sm text-muted">{plural(d.total, 'release')}{downloads ? ' you can download' : ' in your collection'}</p>
          <ul className="grid gap-3 xl:grid-cols-2">
            {d.items.map((it) => (
              <li key={it.release.id} className="flex gap-4 rounded-2xl border border-line bg-surface p-3 sm:p-4">
                <Link to={`/series/${it.series.slug}`} className="w-16 shrink-0 sm:w-20" aria-label={it.series.title}>
                  <Cover src={it.release.cover_url} title={it.series.title} />
                </Link>
                <div className="flex min-w-0 flex-1 flex-col justify-between gap-3">
                  <div className="min-w-0">
                    <Link to={`/series/${it.series.slug}`} className="block truncate font-display text-base font-semibold hover:text-accent-hover">{it.series.title}</Link>
                    <div className="truncate text-sm text-muted">{releaseLabel(it.release)}</div>
                    <div className="mt-0.5 text-xs text-faint">
                      {SOURCE[it.source] ?? 'Added'} {date(it.acquired_at)} · <Link to={`/b/${it.series.publisher.slug}`} className="hover:text-paper">{it.series.publisher.name}</Link>
                    </div>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    {it.release.published ? (
                      <LinkButton to={`/read/${it.release.id}`} size="sm" icon={<BookOpen className="size-4" />}>Read</LinkButton>
                    ) : (
                      <Badge tone="warn">Not released yet</Badge>
                    )}
                    {it.download_url && it.release.published && (
                      <a href={it.download_url} download className={buttonClass(downloads ? 'primary' : 'secondary', 'sm')}>
                        <Download className="size-4" aria-hidden />
                        Download CBZ
                      </a>
                    )}
                    {it.order_id && <Link to={`/account/purchases/${it.order_id}`} className="px-1 text-xs text-muted underline-offset-2 hover:text-paper hover:underline">Receipt</Link>}
                  </div>
                </div>
              </li>
            ))}
          </ul>
          <Pagination page={d.page} pages={Math.ceil(d.total / d.limit)} onPage={setPage} />
        </>
      )}
    </Shelf>
  );
}

function FollowingTab() {
  const qc = useQueryClient();
  const confirm = useConfirm();
  const query = useQuery({ queryKey: ['library', 'following'], queryFn: () => api<{ items: SeriesCard[]; brands: FollowedBrand[] }>('/api/library/following', { query: { limit: 100 } }) });
  const unfollow = useMutation({
    mutationFn: (t: { kind: 'series' | 'brands'; slug: string; name: string }) => api(`/api/${t.kind}/${t.slug}/follow`, { method: 'DELETE' }),
    onSuccess: (_d, t) => {
      toast.success(`You no longer follow ${t.name}`);
      void qc.invalidateQueries({ queryKey: ['library'] });
      void qc.invalidateQueries({ queryKey: ['community'] });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const ask = async (t: { kind: 'series' | 'brands'; slug: string; name: string }) => {
    if (await confirm({ title: `Stop following ${t.name}?`, body: 'You will no longer hear about new releases from it.', confirmLabel: 'Unfollow' })) unfollow.mutate(t);
  };
  return (
    <Shelf
      query={query}
      empty={(d) =>
        d.items.length || d.brands.length ? null : (
          <EmptyState icon={<Rss />} title="You are not following anything yet" action={<LinkButton to="/creators" variant="primary">Find creators</LinkButton>}>
            Follow a series or a creator and new releases land in your notifications and your community feed.
          </EmptyState>
        )
      }
    >
      {(d) => (
        <div className="space-y-10">
          {d.brands.length > 0 && (
            <section>
              <h2 className="mb-3 text-lg font-semibold">Creators and publishers</h2>
              <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                {d.brands.map((b) => (
                  <li key={b.id} className="flex items-center gap-3 rounded-2xl border border-line bg-surface p-3">
                    <Link to={`/b/${b.slug}`} className="flex min-w-0 flex-1 items-center gap-3 hover:text-accent-hover">
                      <Avatar src={b.avatar_url} name={b.name} size={44} square />
                      <span className="min-w-0">
                        <span className="block truncate font-semibold">{b.name}</span>
                        <span className="block text-xs text-muted"><span className="capitalize">{b.kind}</span> · followed {ago(b.followed_at)}</span>
                      </span>
                    </Link>
                    <Button size="sm" variant="ghost" className="h-10" disabled={unfollow.isPending} onClick={() => void ask({ kind: 'brands', slug: b.slug, name: b.name })}>Unfollow</Button>
                  </li>
                ))}
              </ul>
            </section>
          )}
          {d.items.length > 0 && (
            <section>
              <h2 className="mb-3 text-lg font-semibold">Series</h2>
              <CoverGrid>
                {d.items.map((s) => (
                  <SeriesTile
                    key={s.id}
                    series={s}
                    footer={
                      <div className="space-y-1.5">
                        {s.latest_release && (
                          <Link to={`/read/${s.latest_release.id}`} className="block truncate text-xs text-muted hover:text-paper">
                            Latest: {releaseLabel(s.latest_release)}{s.latest_release.published_at ? ` · ${ago(s.latest_release.published_at)}` : ''}
                          </Link>
                        )}
                        <Button size="sm" block disabled={unfollow.isPending} onClick={() => void ask({ kind: 'series', slug: s.slug, name: s.title })}>Unfollow</Button>
                      </div>
                    }
                  />
                ))}
              </CoverGrid>
            </section>
          )}
        </div>
      )}
    </Shelf>
  );
}

function FavoritesTab() {
  const qc = useQueryClient();
  const query = useQuery({ queryKey: ['library', 'favorites'], queryFn: () => api<{ items: SeriesCard[] }>('/api/library/favorites', { query: { limit: 100 } }) });
  const remove = useMutation({
    mutationFn: (s: SeriesCard) => api(`/api/series/${s.slug}/favorite`, { method: 'DELETE' }),
    onSuccess: (_d, s) => {
      toast.success(`${s.title} removed from favorites`);
      void qc.invalidateQueries({ queryKey: ['library'] });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  return (
    <Shelf
      query={query}
      empty={(d) =>
        d.items.length ? null : (
          <EmptyState icon={<Heart />} title="No favorites yet" action={<LinkButton to="/" variant="primary">Browse the store</LinkButton>}>
            Tap the heart on any series to keep it here. Favorites also show on your public profile.
          </EmptyState>
        )
      }
    >
      {(d) => (
        <CoverGrid>
          {d.items.map((s) => (
            <SeriesTile key={s.id} series={s} footer={<Button size="sm" block disabled={remove.isPending} onClick={() => remove.mutate(s)}>Remove</Button>} />
          ))}
        </CoverGrid>
      )}
    </Shelf>
  );
}

export function Library() {
  useTitle('Library');
  const [params, setParams] = useSearchParams();
  const raw = params.get('tab');
  const tab: Tab = TABS.some((t) => t.value === raw) ? (raw as Tab) : 'continue';
  return (
    <div>
      <PageHeader title="Library" description="Everything you are reading, own and follow." />
      <div className="-mx-4 mb-6 px-4 sm:mx-0 sm:px-0">
        <Tabs value={tab} onChange={(t) => setParams(t === 'continue' ? {} : { tab: t })} tabs={[...TABS]} />
      </div>
      {tab === 'continue' && <ContinueTab />}
      {tab === 'owned' && <OwnedTab />}
      {tab === 'downloads' && <OwnedTab downloads />}
      {tab === 'following' && <FollowingTab />}
      {tab === 'favorites' && <FavoritesTab />}
      {tab === 'history' && <ContinueTab history />}
    </div>
  );
}
