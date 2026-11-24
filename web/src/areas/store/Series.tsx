import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  BadgeCheck, Bell, BookOpen, Check, Clock, Download, ExternalLink, EyeOff, Heart, Lock, MessagesSquare, Package, Play, Plus, Printer, Rocket, ShieldAlert, Sparkles, Tag,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { Link, useLocation, useNavigate, useParams, useSearchParams } from 'react-router';
import { ApiError, api, errorMessage } from '@/lib/api';
import { compact, date, money, plural } from '@/lib/format';
import { languageLabel, useSession } from '@/lib/session';
import { Avatar, Badge, Button, Card, EmptyState, ErrorState, LinkButton, Notice, PageLoader, Segmented, buttonClass, cx, toast, useConfirm } from '@/ui';
import { useCheckout } from './Checkout';
import type { CheckoutLine } from './Checkout';
import { Comments } from './Comments';
import { Cover, releaseMark } from './cards';
import { ReportDialog, ReportIcon, ShareButton, useLoginLink, useTitle } from './shared';

type Access = {
  status: 'blocked' | 'owner' | 'owned' | 'free' | 'membership' | 'preview' | 'locked';
  can_download: boolean;
  free_pages: number;
  locked_pages: number;
  read_price_cents: number | null;
  read_list_price_cents: number | null;
  download_price_cents: number | null;
  download_list_price_cents: number | null;
  in_membership: boolean;
};

type Release = {
  id: string;
  number: number;
  kind: string;
  kind_label?: string;
  language: string;
  title: string;
  synopsis: string | null;
  mature: boolean;
  status: string;
  published_at: string | null;
  page_count: number;
  cover_url: string | null;
  print_url: string | null;
  isbn: string | null;
  free_at: string | null;
  access: Access;
  progress: { position: number; finished: boolean } | null;
};

type Bundle = { id: string; title: string; description: string | null; price_cents: number; list_price_cents: number; includes_download: boolean; release_ids: string[] };

type Crowdfunding = {
  service: string;
  url: string;
  goal_cents: number | null;
  starts_at: string | null;
  ends_at: string | null;
  state: 'upcoming' | 'live' | 'ended';
  active: boolean;
};

type SeriesData = {
  series: {
    id: string; slug: string; title: string; description: string; type: string; language: string; languages: string[]; status: string; visibility: string;
    genre: string | null; themes: string[]; audiences: string[]; art_styles: string[]; advisories: string[]; eras: string[]; content_ratings: string[]; tags: string[];
    mature: boolean; cover_url: string | null; banner_url: string | null; access_model: string; in_membership: boolean; allow_comments: boolean;
    update_frequency: string | null; website: string | null; pub_year: number | null; forum_enabled: boolean; forum_description: string | null;
  };
  brand: { id: string; slug: string; name: string; kind: string; bio: string; avatar_url: string | null; verified: boolean; tips_enabled: boolean; following: boolean } | null;
  release_groups: { group: string; releases: Release[] }[];
  contributors: { id: string; name: string; role: string; username: string | null; avatar_url: string | null }[];
  crowdfunding: Crowdfunding | null;
  discount: { label: string; percent_off: number; applies_to: string; ends_at: string | null } | null;
  offers: { series_price_cents: number | null; series_list_price_cents: number | null; series_release_count: number; bundles: Bundle[]; is_member: boolean };
  viewer: { signed_in: boolean; is_brand_member: boolean; following: boolean; notify: boolean; favorite: boolean; start_release_id: string | null; resume: boolean };
  counts: { followers: number; favorites: number; reads: number; releases: number; comments: number; threads: number };
};

const sentence = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

function Countdown({ to }: { to: string }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const s = Math.max(0, Math.floor((Date.parse(to) - now) / 1000));
  const parts: [number, string][] = [[Math.floor(s / 86400), 'd'], [Math.floor((s % 86400) / 3600), 'h'], [Math.floor((s % 3600) / 60), 'm'], [s % 60, 's']];
  return (
    <span className="inline-flex gap-1.5 font-display text-lg font-bold tabular-nums" role="timer" aria-label={`${parts[0][0]} days ${parts[1][0]} hours ${parts[2][0]} minutes left`}>
      {parts.map(([n, unit]) => (
        <span key={unit} className="rounded-md bg-ink/40 px-1.5 py-0.5">{String(n).padStart(2, '0')}<span className="ml-0.5 text-xs font-medium opacity-70">{unit}</span></span>
      ))}
    </span>
  );
}

function CrowdfundingBanner({ cf, title }: { cf: Crowdfunding; title: string }) {
  const { currency } = useSession();
  const [, tick] = useState(0);
  // Flip from "starts in" to "live" (or hide at the end) without a reload.
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, []);
  const now = Date.now();
  const upcoming = cf.starts_at ? Date.parse(cf.starts_at) > now : false;
  const ended = cf.ends_at ? Date.parse(cf.ends_at) <= now : false;
  if (ended || !cf.active) return null;
  const target = upcoming ? cf.starts_at : cf.ends_at;
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3 rounded-2xl bg-sun px-5 py-4 text-sun-ink">
      <div className="flex min-w-0 items-center gap-3">
        <Rocket className="size-6 shrink-0" aria-hidden />
        <div className="min-w-0">
          <div className="font-display text-lg font-bold leading-tight">{upcoming ? `Crowdfunding starts soon on ${cf.service}` : `Now crowdfunding on ${cf.service}`}</div>
          <div className="text-sm opacity-80">
            Back {title} directly{cf.goal_cents ? `. Goal: ${money(cf.goal_cents, currency)}` : ''}.
          </div>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-4">
        {target && (
          <div>
            <div className="text-[11px] font-semibold uppercase tracking-wide opacity-70">{upcoming ? 'Starts in' : 'Ends in'}</div>
            <Countdown to={target} />
          </div>
        )}
        <a href={cf.url} target="_blank" rel="noreferrer" className="inline-flex h-10 items-center gap-2 rounded-lg bg-sun-ink px-4 text-sm font-semibold text-sun hover:opacity-90">
          {upcoming ? 'See the campaign' : 'Back this project'} <ExternalLink className="size-4" aria-hidden />
        </a>
      </div>
    </div>
  );
}

function Description({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const long = text.length > 420 || text.split('\n').length > 6;
  return (
    <div>
      <p className={cx('whitespace-pre-line text-[15px] leading-relaxed text-paper/90', long && !open && 'line-clamp-5')}>{text}</p>
      {long && <button type="button" className="link mt-1.5 text-sm" aria-expanded={open} onClick={() => setOpen((o) => !o)}>{open ? 'Show less' : 'Read more'}</button>}
    </div>
  );
}

function Price({ cents, list }: { cents: number; list: number | null }) {
  const { currency } = useSession();
  return (
    <>
      {list !== null && list > cents && <s className="mr-1 font-normal opacity-60">{money(list, currency)}</s>}
      {money(cents, currency)}
    </>
  );
}

function AccessLabel({ r, isMember }: { r: Release; isMember: boolean }) {
  const { settings } = useSession();
  const a = r.access;
  if (r.status !== 'published') return <Badge tone="warn">{sentence(r.status)}, not public</Badge>;
  switch (a.status) {
    case 'free': return <Badge tone="sun">Free</Badge>;
    case 'owned': return <Badge tone="ok"><Check className="size-3" aria-hidden />Owned</Badge>;
    case 'owner': return <Badge tone="info">Your release</Badge>;
    case 'membership': return <Badge tone="accent"><Sparkles className="size-3" aria-hidden />Included in membership</Badge>;
    case 'blocked': return <Badge tone="neutral">Not available in your country</Badge>;
    default:
      return (
        <span className="flex flex-wrap items-center gap-1.5">
          {a.status === 'preview' ? <Badge tone="neutral">{plural(a.free_pages, 'free page')}</Badge> : <Badge tone="neutral"><Lock className="size-3" aria-hidden />Paid</Badge>}
          {a.in_membership && !isMember && <Badge tone="accent">In {settings.membership.name.replace(/^AltComix\s+/i, '')}</Badge>}
        </span>
      );
  }
}

function ReleaseRow({ r, data, buy }: { r: Release; data: SeriesData; buy: (line: CheckoutLine) => void }) {
  const a = r.access;
  const mark = `${r.kind_label ?? sentence(r.kind.replace(/_/g, ' '))}${r.kind === 'one_shot' ? '' : ` ${r.number}`}`;
  const readable = a.status !== 'blocked';
  const label = `${data.series.title}: ${r.title}`;
  return (
    <li className="flex gap-3 py-3.5 sm:gap-4">
      <Link to={`/read/${r.id}`} className="group w-14 shrink-0 sm:w-16" tabIndex={-1} aria-hidden>
        <Cover src={r.cover_url ?? data.series.cover_url} title={r.title} className="rounded-lg" />
      </Link>
      <div className="flex min-w-0 flex-1 flex-col gap-2 sm:flex-row sm:items-center sm:gap-4">
        <div className="min-w-0 flex-1">
          <div className="text-xs font-semibold uppercase tracking-wide text-muted">{mark}{r.mature && <span className="ml-2 text-danger">18+</span>}</div>
          <h4 className="truncate font-sans text-[15px] font-semibold tracking-normal">
            {readable ? <Link to={`/read/${r.id}`} className="hover:text-accent-hover">{r.title}</Link> : r.title}
          </h4>
          <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px] text-muted">
            <span>{plural(r.page_count, 'page')}</span>
            {r.published_at && <span>· {date(r.published_at)}</span>}
            {r.progress && <span>· {r.progress.finished ? 'Finished' : `On page ${r.progress.position + 1}`}</span>}
          </div>
          <div className="mt-1.5"><AccessLabel r={r} isMember={data.offers.is_member} /></div>
          {r.free_at && a.read_price_cents !== null && Date.parse(r.free_at) > Date.now() && (
            <div className="mt-1 flex items-center gap-1 text-xs text-faint"><Clock className="size-3" aria-hidden />Free to read from {date(r.free_at)}</div>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2 sm:justify-end">
          {readable && (
            <Link to={`/read/${r.id}`} className={buttonClass('secondary', 'md')} aria-label={`Read ${r.title}`}>
              <BookOpen className="size-4" aria-hidden />{a.status === 'preview' ? 'Preview' : a.status === 'locked' ? 'Open' : 'Read'}
            </Link>
          )}
          {a.read_price_cents !== null && (
            <Button aria-label={`Buy ${r.title}`} onClick={() => buy({ item: { kind: 'release', id: r.id }, label, detail: `${mark}, to read online`, price_cents: a.read_price_cents!, list_price_cents: a.read_list_price_cents })}>
              Buy · <Price cents={a.read_price_cents} list={a.read_list_price_cents} />
            </Button>
          )}
          {a.can_download && (
            <a href={`/api/releases/${r.id}/download`} className={buttonClass('secondary', 'md')} aria-label={`Download ${r.title}`}><Download className="size-4" aria-hidden />Download</a>
          )}
          {a.download_price_cents !== null && (
            <Button variant="ghost" aria-label={`Buy the download of ${r.title}`} icon={<Download className="size-4" />} onClick={() => buy({ item: { kind: 'download', id: r.id }, label, detail: `${mark}, file to keep (CBZ)`, price_cents: a.download_price_cents!, list_price_cents: a.download_list_price_cents })}>
              Download · <Price cents={a.download_price_cents} list={a.download_list_price_cents} />
            </Button>
          )}
          {r.print_url && (
            <a href={r.print_url} target="_blank" rel="noreferrer" className={buttonClass('ghost', 'md')} aria-label={`Print edition of ${r.title}`}><Printer className="size-4" aria-hidden />Print edition</a>
          )}
        </div>
      </div>
    </li>
  );
}

function Chips({ label, items, param }: { label: string; items: string[]; param?: string }) {
  if (!items.length) return null;
  return (
    <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1.5">
      <dt className="w-24 shrink-0 text-[13px] text-muted">{label}</dt>
      <dd className="flex min-w-0 flex-1 flex-wrap gap-1.5">
        {items.map((t) =>
          param ? (
            <Link key={t} to={`/browse?${param}=${encodeURIComponent(t)}`} className="rounded-full border border-line bg-raised px-2.5 py-1 text-[13px] hover:border-line-strong">{t}</Link>
          ) : (
            <span key={t} className="rounded-full border border-line px-2.5 py-1 text-[13px] text-muted">{t}</span>
          ),
        )}
      </dd>
    </div>
  );
}

function MatureGate({ message, onOpened }: { message: string; onOpened: () => void }) {
  const { user, refresh } = useSession();
  const login = useLoginLink();
  const confirm = useConfirm();
  const turnOn = useMutation({
    mutationFn: () => api('/api/account/prefs', { method: 'PATCH', json: { show_mature: true, confirm_adult: true } }),
    onSuccess: async () => {
      await refresh();
      toast.success('Mature content is now shown');
      onOpened();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const ask = async () => {
    if (await confirm({ title: 'Are you 18 or older?', body: 'Mature titles can include graphic violence, nudity and sexual content. By continuing you confirm you are an adult. You can turn this off again in your account settings.', confirmLabel: 'I am 18 or older' })) turnOn.mutate();
  };
  return (
    <div className="mx-auto max-w-xl py-10">
      <EmptyState
        icon={<ShieldAlert />}
        title="This title is for readers 18 and over"
        action={
          user ? (
            <div className="flex flex-wrap justify-center gap-2">
              <Button variant="primary" loading={turnOn.isPending} onClick={ask}>Show mature content</Button>
              <LinkButton to="/account">Account settings</LinkButton>
            </div>
          ) : (
            <LinkButton to={login} variant="primary">Sign in to continue</LinkButton>
          )
        }
      >
        {user ? 'Mature content is switched off for your account. Turn it on to open this series; the setting lives in your account settings.' : message}
      </EmptyState>
    </div>
  );
}

export function SeriesPage() {
  const { slug = '' } = useParams();
  const { user, meta, settings, currency } = useSession();
  const [params, setParams] = useSearchParams();
  const language = params.get('language') ?? '';
  const loc = useLocation();
  const nav = useNavigate();
  const qc = useQueryClient();
  const login = useLoginLink();
  const [report, setReport] = useState(false);
  const key = ['series', slug, language, user?.id ?? null];
  const query = useQuery({ queryKey: key, queryFn: () => api<SeriesData>(`/api/series/${encodeURIComponent(slug)}`, { query: { language } }), retry: false });
  const data = query.data;
  useTitle(data ? `${data.series.title} by ${data.brand?.name ?? 'unknown'}` : query.isError ? 'Series' : null);
  const checkout = useCheckout(() => void qc.invalidateQueries({ queryKey: ['series', slug] }));

  const patch = (fn: (d: SeriesData) => SeriesData) => qc.setQueryData<SeriesData>(key, (d) => (d ? fn(d) : d));
  const follow = useMutation({
    mutationFn: (on: boolean) => api<{ following: boolean; follower_count: number }>(`/api/series/${slug}/follow`, on ? { method: 'POST', json: {} } : { method: 'DELETE' }),
    onSuccess: (r) => {
      patch((d) => ({ ...d, viewer: { ...d.viewer, following: r.following }, counts: { ...d.counts, followers: r.follower_count } }));
      toast.success(r.following ? 'Following. You will hear about new releases.' : 'Unfollowed');
      void qc.invalidateQueries({ queryKey: ['library'] });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const favorite = useMutation({
    mutationFn: (on: boolean) => api<{ favorite: boolean; favorite_count: number }>(`/api/series/${slug}/favorite`, { method: on ? 'POST' : 'DELETE' }),
    onSuccess: (r) => {
      patch((d) => ({ ...d, viewer: { ...d.viewer, favorite: r.favorite }, counts: { ...d.counts, favorites: r.favorite_count } }));
      toast.success(r.favorite ? 'Added to your favourites' : 'Removed from your favourites');
      void qc.invalidateQueries({ queryKey: ['library'] });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  if (query.isLoading) return <PageLoader label="Opening the series" />;
  if (query.isError || !data) {
    const err = query.error;
    if (err instanceof ApiError && err.code === 'mature') return <MatureGate message={err.message} onOpened={() => void query.refetch()} />;
    if (err instanceof ApiError && err.status === 404) {
      return (
        <div className="mx-auto max-w-xl py-10">
          <EmptyState icon={<BookOpen />} title="This series is not available" action={<LinkButton to="/browse" variant="primary">Browse comics</LinkButton>}>
            It may have been removed or made private by its creator, or the link may be wrong.
          </EmptyState>
        </div>
      );
    }
    return <ErrorState message={errorMessage(err)} retry={() => void query.refetch()} />;
  }

  const { series: s, brand, viewer, counts, offers } = data;
  const needUser = (fn: () => void) => () => (user ? fn() : nav(login));
  const returnTo = loc.pathname + loc.search;
  const buy = (line: CheckoutLine) => checkout.open({ lines: [line], returnTo });
  const allReleases = data.release_groups.flatMap((g) => g.releases);
  const typeLabel = meta.seriesTypes.find((t) => t.id === s.type)?.label ?? s.type;
  const startLabel = viewer.resume ? 'Continue reading' : 'Start reading';

  return (
    <div className="space-y-8">
      {/* Header */}
      <header className="relative -mx-4 -mt-6 overflow-hidden border-b border-line px-4 pb-6 pt-6 sm:-mx-6 sm:px-6 lg:-mx-8 lg:px-8 lg:pt-8">
        {(s.banner_url ?? s.cover_url) && (
          <img src={(s.banner_url ?? s.cover_url)!} alt="" className={cx('absolute inset-0 size-full object-cover', s.banner_url ? 'opacity-35' : 'scale-110 opacity-30 blur-2xl')} />
        )}
        <div className="absolute inset-0 bg-gradient-to-t from-ink via-ink/85 to-ink/40" />
        <div className="relative flex flex-col gap-5 sm:flex-row sm:items-end sm:gap-7">
          <div className="w-36 shrink-0 sm:w-48 lg:w-56"><Cover src={s.cover_url} title={s.title} className="shadow-pop" /></div>
          <div className="min-w-0 flex-1">
            <div className="mb-2 flex flex-wrap items-center gap-1.5">
              <Badge>{typeLabel}</Badge>
              {s.access_model === 'free' ? <Badge tone="sun">Free</Badge> : s.in_membership ? <Badge tone="accent"><Sparkles className="size-3" aria-hidden />{settings.membership.name}</Badge> : <Badge>Paid</Badge>}
              {s.mature && <Badge tone="danger">18+</Badge>}
              {s.visibility !== 'public' && <Badge tone="warn">{sentence(s.visibility)}</Badge>}
            </div>
            <h1 className="break-words text-3xl font-extrabold sm:text-4xl lg:text-5xl">{s.title}</h1>
            {brand && (
              <Link to={`/b/${brand.slug}`} className="mt-3 inline-flex max-w-full items-center gap-2 text-[15px] hover:text-accent-hover">
                <Avatar src={brand.avatar_url} name={brand.name} size={28} />
                <span className="truncate font-medium">{brand.name}</span>
                {brand.verified && <BadgeCheck className="size-4 shrink-0 text-info" aria-label="Verified" />}
              </Link>
            )}
            <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-sm text-muted">
              <span>{sentence(s.status)}</span>
              {s.update_frequency && s.update_frequency !== 'None' && s.status === 'ongoing' && <span>Updates {s.update_frequency.toLowerCase()}</span>}
              <span>{plural(counts.releases, 'release')}</span>
              <span>{compact(counts.reads)} reads</span>
              {s.pub_year && <span>First published {s.pub_year}</span>}
            </div>

            <div className="mt-5 flex flex-wrap items-center gap-2">
              {viewer.start_release_id ? (
                <LinkButton to={`/read/${viewer.start_release_id}`} variant="primary" size="lg" icon={<Play className="size-4" />}>{startLabel}</LinkButton>
              ) : (
                <Button variant="primary" size="lg" disabled>No releases yet</Button>
              )}
              <Button
                size="lg"
                aria-pressed={viewer.following}
                loading={follow.isPending}
                icon={viewer.following ? <Bell className="size-4 text-accent-hover" /> : <Plus className="size-4" />}
                onClick={needUser(() => follow.mutate(!viewer.following))}
              >
                {viewer.following ? 'Following' : 'Follow'}<span className="ml-1 tabular-nums text-muted">{compact(counts.followers)}</span>
              </Button>
              <Button
                size="lg"
                aria-pressed={viewer.favorite}
                aria-label={viewer.favorite ? `Remove from favourites, ${counts.favorites} favourites` : `Add to favourites, ${counts.favorites} favourites`}
                loading={favorite.isPending}
                icon={<Heart className={cx('size-4', viewer.favorite && 'fill-accent text-accent')} />}
                onClick={needUser(() => favorite.mutate(!viewer.favorite))}
              >
                <span className="tabular-nums">{compact(counts.favorites)}</span>
              </Button>
              <ShareButton title={s.title} />
              <Button variant="ghost" icon={<ReportIcon />} onClick={() => setReport(true)}>Report</Button>
            </div>
          </div>
        </div>
      </header>

      {viewer.is_brand_member && brand && (
        <Notice tone="info" action={<LinkButton to={`/studio/${brand.slug}`} size="sm">Open in Studio</LinkButton>}>You are on this title's team, so you also see unpublished releases here.</Notice>
      )}
      {data.crowdfunding && <CrowdfundingBanner cf={data.crowdfunding} title={s.title} />}
      {data.discount && s.access_model === 'premium' && (
        <Notice tone="ok">
          <span className="inline-flex flex-wrap items-center gap-x-1.5"><Tag className="size-4" aria-hidden /><strong>{data.discount.percent_off}% off</strong>{data.discount.label && <span>· {data.discount.label}</span>}{data.discount.ends_at && <span>· ends {date(data.discount.ends_at)}</span>}</span>
        </Notice>
      )}

      <div className="grid gap-8 xl:grid-cols-[minmax(0,1fr)_320px]">
        <div className="min-w-0 space-y-8">
          {/* About */}
          <section aria-label="About this series" className="space-y-4">
            {s.description ? <Description text={s.description} /> : <p className="text-muted">The creator has not written a description yet.</p>}
            <dl className="space-y-2.5">
              <Chips label="Genre" items={s.genre ? [s.genre] : []} param="genre" />
              <Chips label="Themes" items={s.themes} param="themes" />
              <Chips label="Era" items={s.eras} param="eras" />
              <Chips label="Audience" items={s.audiences} param="audience" />
              <Chips label="Art style" items={s.art_styles} param="art_style" />
              <Chips label="Rating" items={s.content_ratings} />
              <Chips label="Advisories" items={s.advisories} />
              <Chips label="Tags" items={s.tags} param="q" />
            </dl>
            {s.website && /^https?:\/\//i.test(s.website) && (
              <a href={s.website} target="_blank" rel="noreferrer nofollow" className="link inline-flex items-center gap-1.5 text-sm">Official website <ExternalLink className="size-3.5" aria-hidden /></a>
            )}
          </section>

          {/* Language */}
          {s.languages.length > 1 && (
            <section aria-label="Language">
              <h2 className="mb-2 text-sm font-semibold text-muted">Read in</h2>
              <Segmented
                size="sm"
                value={language}
                onChange={(v) => setParams(v ? { language: v } : {}, { replace: true, preventScrollReset: true })}
                options={[{ value: '', label: 'All languages' }, ...s.languages.map((l) => ({ value: l, label: languageLabel(meta, l) }))]}
              />
            </section>
          )}

          {/* Releases */}
          <section aria-labelledby="releases-h">
            <div className="mb-2 flex flex-wrap items-end justify-between gap-3">
              <h2 id="releases-h" className="text-xl font-bold sm:text-2xl">Releases</h2>
              {s.in_membership && !offers.is_member && (
                <Link to={`/unlimited?next=${encodeURIComponent(returnTo)}`} className="inline-flex items-center gap-1.5 text-sm font-medium text-accent-hover hover:text-paper">
                  <Sparkles className="size-4" aria-hidden />Read it all with {settings.membership.name}
                </Link>
              )}
            </div>
            {data.release_groups.length === 0 ? (
              <EmptyState icon={<BookOpen />} title={language ? `Nothing in ${languageLabel(meta, language)} yet` : 'No releases yet'}>
                {language ? 'Pick another language above.' : 'Follow the series to hear when the first release is out.'}
              </EmptyState>
            ) : (
              data.release_groups.map((g) => (
                <div key={g.group} className="mt-5 first:mt-0">
                  <h3 className="flex items-center gap-2 border-b border-line pb-2 text-base font-semibold">{g.group}<span className="text-sm font-normal text-muted">{g.releases.length}</span></h3>
                  <ul className="divide-y divide-line">
                    {g.releases.map((r) => <ReleaseRow key={r.id} r={r} data={data} buy={buy} />)}
                  </ul>
                </div>
              ))
            )}
          </section>

          {/* Comments */}
          {s.allow_comments && <Comments seriesId={s.id} slug={s.slug} />}
        </div>

        {/* Side column */}
        <aside className="min-w-0 space-y-5">
          {(offers.series_price_cents !== null || offers.bundles.length > 0) && (
            <Card className="p-5">
              <h2 className="text-lg font-semibold">Save on the set</h2>
              <div className="mt-3 space-y-4">
                {offers.series_price_cents !== null && (
                  <div>
                    <div className="flex items-baseline justify-between gap-3">
                      <span className="font-medium">Whole series</span>
                      <span className="font-display text-lg font-bold tabular-nums"><Price cents={offers.series_price_cents} list={offers.series_list_price_cents} /></span>
                    </div>
                    <p className="mt-0.5 text-sm text-muted">Every release you do not own yet ({offers.series_release_count}), to read online.</p>
                    <Button block className="mt-2.5" onClick={() => buy({ item: { kind: 'series', id: s.slug }, label: `${s.title}: whole series`, detail: plural(offers.series_release_count, 'release'), price_cents: offers.series_price_cents!, list_price_cents: offers.series_list_price_cents })}>
                      Buy whole series
                    </Button>
                  </div>
                )}
                {offers.bundles.map((b) => {
                  const inside = allReleases.filter((r) => b.release_ids.includes(r.id));
                  return (
                    <div key={b.id} className="border-t border-line pt-4 first:border-0 first:pt-0">
                      <div className="flex items-baseline justify-between gap-3">
                        <span className="flex min-w-0 items-center gap-1.5 font-medium"><Package className="size-4 shrink-0 text-muted" aria-hidden /><span className="truncate">{b.title}</span></span>
                        <span className="shrink-0 font-display text-lg font-bold tabular-nums"><Price cents={b.price_cents} list={b.list_price_cents} /></span>
                      </div>
                      {b.description && <p className="mt-0.5 text-sm text-muted">{b.description}</p>}
                      <p className="mt-0.5 text-sm text-muted">
                        {plural(b.release_ids.length, 'release')}{inside.length > 0 && inside.length <= 6 ? `: ${inside.map((r) => releaseMark(r.kind, r.number)).join(', ')}` : ''}{b.includes_download ? ', with downloads' : ''}
                      </p>
                      <Button block className="mt-2.5" aria-label={`Buy bundle ${b.title}`} onClick={() => buy({ item: { kind: 'bundle', id: b.id }, label: `Bundle: ${b.title}`, detail: `${plural(b.release_ids.length, 'release')}${b.includes_download ? ', with downloads' : ''}`, price_cents: b.price_cents, list_price_cents: b.list_price_cents })}>
                        Buy bundle
                      </Button>
                    </div>
                  );
                })}
              </div>
              <p className="mt-4 text-xs text-faint">Prices in {currency.toUpperCase()}. Most of every sale goes to {brand?.name ?? 'the creator'}.</p>
            </Card>
          )}

          {brand && (
            <Card className="p-5">
              <Link to={`/b/${brand.slug}`} className="flex items-center gap-3 hover:text-accent-hover">
                <Avatar src={brand.avatar_url} name={brand.name} size={48} />
                <span className="min-w-0">
                  <span className="flex items-center gap-1.5 font-semibold"><span className="truncate">{brand.name}</span>{brand.verified && <BadgeCheck className="size-4 shrink-0 text-info" aria-label="Verified" />}</span>
                  <span className="block text-sm text-muted">{brand.kind === 'publisher' ? 'Publisher' : 'Independent creator'}</span>
                </span>
              </Link>
              {brand.bio && <p className="mt-3 line-clamp-4 text-sm text-muted">{brand.bio}</p>}
              <div className="mt-3 flex flex-wrap gap-2">
                <LinkButton to={`/b/${brand.slug}`} size="sm">More from {brand.name}</LinkButton>
                {brand.tips_enabled && <LinkButton to={`/b/${brand.slug}?tip=1`} size="sm" variant="ghost" icon={<Heart className="size-4" />}>Leave a tip</LinkButton>}
              </div>
            </Card>
          )}

          {data.contributors.length > 0 && (
            <Card className="p-5">
              <h2 className="text-lg font-semibold">Made by</h2>
              <ul className="mt-3 space-y-3">
                {data.contributors.map((c) => {
                  const inner: ReactNode = (
                    <>
                      <Avatar src={c.avatar_url} name={c.name} size={36} />
                      <span className="min-w-0">
                        <span className="block truncate text-sm font-medium">{c.name}</span>
                        <span className="block text-xs text-muted">{c.role}</span>
                      </span>
                    </>
                  );
                  return (
                    <li key={c.id}>
                      {c.username ? <Link to={`/u/${c.username}`} className="flex items-center gap-3 hover:text-accent-hover">{inner}</Link> : <div className="flex items-center gap-3">{inner}</div>}
                    </li>
                  );
                })}
              </ul>
            </Card>
          )}

          {s.forum_enabled && (
            <Card className="p-5">
              <h2 className="flex items-center gap-2 text-lg font-semibold"><MessagesSquare className="size-5 text-muted" aria-hidden />Series forum</h2>
              <p className="mt-1.5 text-sm text-muted">{s.forum_description || 'Theories, questions and fan talk with other readers.'}</p>
              <LinkButton to={`/series/${s.slug}/forum`} size="sm" className="mt-3">{counts.threads > 0 ? `Open the forum (${plural(counts.threads, 'thread')})` : 'Start the first thread'}</LinkButton>
            </Card>
          )}

          {!s.allow_comments && (
            <p className="flex items-center gap-2 text-sm text-faint"><EyeOff className="size-4" aria-hidden />The creator has turned comments off for this series.</p>
          )}
        </aside>
      </div>

      {checkout.dialog}
      <ReportDialog target={report ? { kind: 'series', id: s.id, name: s.title } : null} onClose={() => setReport(false)} />
    </div>
  );
}
