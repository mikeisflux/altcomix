import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, BadgeCheck, CalendarDays, Check, ExternalLink, Flag, Globe, Heart, MapPin, MoreVertical, Plus, Search, Share2, UsersRound } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { Link, useLocation, useNavigate, useParams, useSearchParams } from 'react-router';
import { ApiError, api, errorMessage } from '@/lib/api';
import { ago, compact, date, money, moneyExact, plural } from '@/lib/format';
import { useSession } from '@/lib/session';
import {
  Avatar, Badge, Button, Card, Checkbox, EmptyState, ErrorState, Field, IconButton, Input, LinkButton, MenuItem, Modal, MoneyInput, PageLoader, Pagination, Popover, ProgressBar,
  Segmented, Skeleton, Textarea, cx, toast,
} from '@/ui';
import { CreditChoice, startCheckout } from './Checkout';
import { CoverCard, CoverGrid } from './cards';
import type { SeriesCard } from './cards';
import { ConfirmEmailPrompt, ReportDialog, isEmailUnverified, sharePage, useLoginLink, useTitle } from './shared';

type BrandData = {
  brand: {
    id: string; slug: string; name: string; kind: 'creator' | 'publisher'; bio: string; avatar_url: string | null; banner_url: string | null; website: string | null;
    socials: Record<string, string> | null; country: string | null; verified: boolean; tips_enabled: boolean; series_count: number; follower_count: number; created_at: string;
  };
  tip_goal: { goal_cents: number; raised_cents: number; percent: number; tips: number; month: string } | null;
  recent_tips: { name: string; message: string | null; created_at: string; amount_cents: number | null }[];
  series: SeriesCard[];
  query: string;
  members: { username: string; name: string; avatar_url: string | null; role: string; since: string }[];
  conventions: { id: string; name: string; location: string | null; booth: string | null; url: string | null; starts_on: string; ends_on: string | null }[];
  viewer: { following: boolean; is_brand_member: boolean };
};

const SOCIAL: Record<string, { label: string; base: string }> = {
  x: { label: 'X', base: 'https://x.com/' },
  facebook: { label: 'Facebook', base: 'https://facebook.com/' },
  instagram: { label: 'Instagram', base: 'https://instagram.com/' },
  bluesky: { label: 'Bluesky', base: 'https://bsky.app/profile/' },
  youtube: { label: 'YouTube', base: 'https://youtube.com/@' },
  discord: { label: 'Discord', base: 'https://discord.gg/' },
  tiktok: { label: 'TikTok', base: 'https://tiktok.com/@' },
};

/** Creators type either a full link or just a handle; only http(s) links are ever rendered. */
function socialHref(key: string, value: string): string | null {
  const v = value.trim();
  if (/^https?:\/\//i.test(v)) return v;
  if (/^[a-z][a-z0-9+.-]*:/i.test(v)) return null;
  if (/^[\w-]+(\.[\w-]+)+(\/\S*)?$/.test(v) && key !== 'bluesky') return `https://${v}`;
  const base = SOCIAL[key]?.base;
  return base ? base + encodeURIComponent(v.replace(/^@/, '')) : null;
}

const ROLE: Record<string, string> = { owner: 'Owner', admin: 'Admin', editor: 'Editor', analyst: 'Analyst' };
const PRESETS = [300, 500, 1000, 2500];

function TipDialog({ open, onClose, brand, onPaid }: { open: boolean; onClose: () => void; brand: BrandData['brand']; onPaid: () => void }) {
  const { user, currency, refresh } = useSession();
  const login = useLoginLink();
  const loc = useLocation();
  const [amount, setAmount] = useState<number | null>(500);
  const [custom, setCustom] = useState(false);
  const [message, setMessage] = useState('');
  const [showAmount, setShowAmount] = useState(true);
  const [useCredit, setUseCredit] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [unverified, setUnverified] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setError(null);
      setUnverified(null);
      setBusy(false);
    }
  }, [open]);

  const cents = amount ?? 0;
  const problem = cents < 100 ? `The smallest tip is ${money(100, currency)}.` : cents > 100_000 ? `The largest tip is ${money(100_000, currency)}.` : null;
  const credit = useCredit ? Math.min(user?.wallet.credit_cents ?? 0, cents) : 0;

  const send = async (e: FormEvent) => {
    e.preventDefault();
    if (problem) return setError(problem);
    setBusy(true);
    setError(null);
    setUnverified(null);
    try {
      const completed = await startCheckout({
        // The tip's id is the brand's slug (the API also takes a brand id, or a series slug / id).
        items: [{ kind: 'tip', id: brand.slug, amount_cents: cents, message: message.trim() || undefined, show_amount: showAmount }],
        use_credit: credit > 0, return_to: loc.pathname,
      });
      if (!completed) return;
      await refresh();
      toast.success(`Thank you. Your tip is on its way to ${brand.name}.`);
      setMessage('');
      onPaid();
      onClose();
    } catch (err) {
      if (isEmailUnverified(err)) setUnverified(errorMessage(err));
      else setError(errorMessage(err));
    }
    setBusy(false);
  };

  return (
    <Modal
      open={open}
      onClose={busy ? () => {} : onClose}
      title={`Tip ${brand.name}`}
      size="sm"
      footer={
        user ? (
          <>
            <Button variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
            <Button type="submit" form="tip-form" variant="primary" loading={busy} disabled={Boolean(problem) || !user.email_verified}>Send {cents >= 100 ? moneyExact(cents - credit, currency) : 'tip'}</Button>
          </>
        ) : (
          <LinkButton to={login} variant="primary">Sign in to tip</LinkButton>
        )
      }
    >
      {user ? (
        <form id="tip-form" onSubmit={send} className="space-y-4">
          <p className="text-sm text-muted">A tip is a one-off thank-you. Nearly all of it goes straight to {brand.name}.</p>
          <div>
            <div className="mb-1.5 text-[13px] font-medium">Amount</div>
            <Segmented
              value={custom ? 'custom' : String(amount)}
              onChange={(v) => {
                if (v === 'custom') setCustom(true);
                else {
                  setCustom(false);
                  setAmount(Number(v));
                }
              }}
              options={[...PRESETS.map((p) => ({ value: String(p), label: money(p, currency) })), { value: 'custom', label: 'Other' }]}
            />
          </div>
          {custom && (
            <Field label="Your amount" error={amount !== null && problem ? problem : null}>
              <MoneyInput cents={amount} onChange={setAmount} />
            </Field>
          )}
          <Field label="Message" optional hint={`Shown on ${brand.name}'s page next to your name.`}>
            <Textarea value={message} onChange={(e) => setMessage(e.target.value)} maxLength={500} className="min-h-20" />
          </Field>
          <Checkbox checked={showAmount} onChange={setShowAmount} label="Show the amount publicly" description="Untick to show only your name and message." />
          <CreditChoice total={cents} checked={useCredit} onChange={setUseCredit} />
          {(unverified || !user.email_verified) && <ConfirmEmailPrompt message={unverified ?? 'Confirm your email to send tips. We sent a link to your address when you signed up.'} onConfirmed={() => setUnverified(null)} />}
          {error && <ErrorState message={error} />}
        </form>
      ) : (
        <p className="text-sm text-muted">Tips come from an account so the creator can see who to thank, and so you get a receipt.</p>
      )}
    </Modal>
  );
}

export function BrandPage() {
  const { slug = '' } = useParams();
  const { user, currency } = useSession();
  const nav = useNavigate();
  const qc = useQueryClient();
  const login = useLoginLink();
  const [params, setParams] = useSearchParams();
  const term = params.get('q') ?? '';
  const [draft, setDraft] = useState(term);
  const [tip, setTip] = useState(false);
  const [report, setReport] = useState(false);
  useEffect(() => setDraft(term), [term]);

  const key = ['brand', slug, term, user?.id ?? null];
  const query = useQuery({ queryKey: key, queryFn: () => api<BrandData>(`/api/brands/${encodeURIComponent(slug)}`, { query: { q: term } }), placeholderData: keepPreviousData, retry: false });
  const data = query.data?.brand.slug === slug || !query.data ? query.data : undefined;
  useTitle(data?.brand.name ?? (query.isError ? 'Creator' : null));

  // `/b/<slug>?tip=1` (linked from series pages) opens the tip dialog once.
  const wantsTip = params.get('tip') === '1';
  useEffect(() => {
    if (wantsTip && data?.brand.tips_enabled) {
      setTip(true);
      const next = new URLSearchParams(params);
      next.delete('tip');
      setParams(next, { replace: true });
    }
  }, [wantsTip, data?.brand.tips_enabled, params, setParams]);

  const follow = useMutation({
    mutationFn: (on: boolean) => api<{ following: boolean; follower_count: number }>(`/api/brands/${slug}/follow`, { method: on ? 'POST' : 'DELETE' }),
    onSuccess: (r) => {
      qc.setQueryData<BrandData>(key, (d) => (d ? { ...d, brand: { ...d.brand, follower_count: r.follower_count }, viewer: { ...d.viewer, following: r.following } } : d));
      toast.success(r.following ? `You follow ${data?.brand.name}` : 'Unfollowed');
      void qc.invalidateQueries({ queryKey: ['library'] });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  if (query.isLoading || (query.isFetching && !data)) return <PageLoader />;
  if (query.isError || !data) {
    if (query.error instanceof ApiError && query.error.status === 404) {
      return (
        <div className="mx-auto max-w-xl py-10">
          <EmptyState icon={<UsersRound />} title="We could not find that creator" action={<LinkButton to="/creators" variant="primary">Browse creators</LinkButton>}>The page may have been renamed or removed.</EmptyState>
        </div>
      );
    }
    return <ErrorState message={errorMessage(query.error)} retry={() => void query.refetch()} />;
  }

  const { brand, viewer, tip_goal: goal } = data;
  const socials = [
    ...(brand.website && /^https?:\/\//i.test(brand.website) ? [{ key: 'website', label: 'Website', href: brand.website }] : []),
    ...Object.entries(brand.socials ?? {}).flatMap(([k, v]) => {
      const href = v ? socialHref(k, v) : null;
      return href ? [{ key: k, label: SOCIAL[k]?.label ?? k, href }] : [];
    }),
  ];
  const search = (e: FormEvent) => {
    e.preventDefault();
    setParams(draft.trim() ? { q: draft.trim() } : {}, { replace: true, preventScrollReset: true });
  };

  return (
    <div className="space-y-8">
      <header>
        <div className="relative -mx-4 -mt-6 h-36 overflow-hidden border-b border-line bg-surface sm:-mx-6 sm:h-48 lg:-mx-8 lg:h-56">
          {brand.banner_url ? <img src={brand.banner_url} alt="" className="size-full object-cover" /> : <div className="size-full bg-gradient-to-br from-accent-soft via-surface to-raised" />}
          <div className="absolute inset-0 bg-gradient-to-t from-ink/80 to-transparent" />
          <div className="absolute left-3 top-3 sm:left-5">
            <button type="button" onClick={() => (window.history.length > 1 ? nav(-1) : nav('/creators'))} className="inline-flex h-10 items-center gap-1.5 rounded-full bg-ink/80 pl-3 pr-4 text-sm font-medium backdrop-blur hover:bg-hover">
              <ArrowLeft className="size-4" aria-hidden />Back
            </button>
          </div>
        </div>

        <div className="relative -mt-10 flex flex-col gap-4 sm:-mt-12 sm:flex-row sm:items-end sm:gap-5">
          <div className="shrink-0 rounded-2xl bg-ink p-1"><Avatar src={brand.avatar_url} name={brand.name} size={104} square /></div>
          <div className="min-w-0 flex-1 sm:pb-1">
            <h1 className="flex flex-wrap items-center gap-x-2 text-2xl font-extrabold sm:text-3xl">
              <span className="break-words">{brand.name}</span>
              {brand.verified && <BadgeCheck className="size-6 shrink-0 text-info" aria-label="Verified" />}
            </h1>
            <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-sm text-muted">
              <span>{brand.kind === 'publisher' ? 'Publisher' : 'Independent creator'}</span>
              <span>{term ? 'Series' : plural(brand.series_count, 'series', 'series')}</span>
              <span>{compact(brand.follower_count)} {brand.follower_count === 1 ? 'follower' : 'followers'}</span>
              <span>Here since {date(brand.created_at, { year: 'numeric', month: 'short' })}</span>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2 sm:pb-1">
            <Button
              variant={viewer.following ? 'secondary' : 'primary'}
              aria-pressed={viewer.following}
              loading={follow.isPending}
              icon={viewer.following ? <Check className="size-4" /> : <Plus className="size-4" />}
              onClick={() => (user ? follow.mutate(!viewer.following) : nav(login))}
            >
              {viewer.following ? 'Following' : 'Follow'}
            </Button>
            {brand.tips_enabled && <Button icon={<Heart className="size-4 text-accent-hover" />} onClick={() => setTip(true)}>Tip</Button>}
            {viewer.is_brand_member && <LinkButton to={`/studio/${brand.slug}/settings`} variant="ghost">Edit page</LinkButton>}
            <Popover
              width={200}
              trigger={({ toggle, open }) => <IconButton label="More options" aria-expanded={open} onClick={toggle} className="size-10 border border-line"><MoreVertical className="size-5" /></IconButton>}
            >
              {(close) => (
                <div className="py-1">
                  <MenuItem icon={<Share2 className="size-4" />} onClick={() => { close(); void sharePage(brand.name); }}>Share this page</MenuItem>
                  <MenuItem icon={<Flag className="size-4" />} onClick={() => { close(); setReport(true); }}>Report</MenuItem>
                </div>
              )}
            </Popover>
          </div>
        </div>
      </header>

      <div className="grid gap-8 xl:grid-cols-[minmax(0,1fr)_320px]">
        <div className="order-2 min-w-0 xl:order-1">
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
            <h2 className="text-xl font-bold sm:text-2xl">Series</h2>
            <form onSubmit={search} role="search" className="relative w-full sm:w-72">
              <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted" aria-hidden />
              <Input type="search" aria-label={`Search titles by ${brand.name}`} placeholder="Search titles" value={draft} onChange={(e) => setDraft(e.target.value)} className="pl-9" />
            </form>
          </div>
          {term && (
            <p className="mb-4 text-sm text-muted">
              {plural(data.series.length, 'title')} matching “{term}”. <button type="button" className="link" onClick={() => setParams({}, { replace: true, preventScrollReset: true })}>Show all</button>
            </p>
          )}
          {data.series.length === 0 ? (
            <EmptyState title={term ? 'No titles match that search' : 'Nothing published yet'} action={viewer.is_brand_member && !term ? <LinkButton to={`/studio/${brand.slug}`} variant="primary">Publish a series</LinkButton> : undefined}>
              {term ? 'Try a shorter word from the title.' : `Follow ${brand.name} to hear when the first series is out.`}
            </EmptyState>
          ) : (
            <CoverGrid className={cx('xl:grid-cols-4 2xl:grid-cols-5', query.isPlaceholderData && 'opacity-60')}>
              {data.series.map((s) => <CoverCard key={s.id} series={s} />)}
            </CoverGrid>
          )}
        </div>

        <aside className="order-1 min-w-0 space-y-5 xl:order-2">
          <Card className="p-5">
            <h2 className="text-lg font-semibold">About</h2>
            <p className="mt-2 whitespace-pre-line break-words text-sm leading-relaxed text-paper/90">{brand.bio || `${brand.name} has not written a bio yet.`}</p>
            {socials.length > 0 && (
              <ul className="mt-4 flex flex-wrap gap-2">
                {socials.map((l) => (
                  <li key={l.key}>
                    <a href={l.href} target="_blank" rel="noreferrer nofollow" className="inline-flex h-9 items-center gap-1.5 rounded-full border border-line bg-raised px-3 text-[13px] hover:border-line-strong">
                      {l.key === 'website' ? <Globe className="size-3.5" aria-hidden /> : <ExternalLink className="size-3.5" aria-hidden />}{l.label}
                    </a>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          {brand.tips_enabled && (goal || data.recent_tips.length > 0) && (
            <Card className="p-5">
              <h2 className="text-lg font-semibold">Support</h2>
              {goal && (
                <div className="mt-3">
                  <ProgressBar value={goal.raised_cents} max={goal.goal_cents} label={<><span className="font-semibold text-paper">{money(goal.raised_cents, currency)}</span> of {money(goal.goal_cents, currency)} this month</>} />
                  <p className="mt-1.5 text-xs text-faint">{goal.tips > 0 ? `${plural(goal.tips, 'tip')} so far. ` : ''}The goal resets on the 1st.</p>
                </div>
              )}
              {data.recent_tips.length > 0 && (
                <ul className="mt-4 space-y-3">
                  {data.recent_tips.slice(0, 5).map((t, i) => (
                    <li key={i} className="text-sm">
                      <div className="flex items-baseline justify-between gap-2">
                        <span className="min-w-0 truncate font-medium">{t.name}{t.amount_cents !== null && <span className="ml-1.5 font-normal text-accent-hover">{money(t.amount_cents, currency)}</span>}</span>
                        <time className="shrink-0 text-xs text-faint" dateTime={t.created_at}>{ago(t.created_at)}</time>
                      </div>
                      {t.message && <p className="mt-0.5 break-words text-muted">{t.message}</p>}
                    </li>
                  ))}
                </ul>
              )}
              <Button block className="mt-4" icon={<Heart className="size-4 text-accent-hover" />} onClick={() => setTip(true)}>Leave a tip</Button>
            </Card>
          )}

          {data.conventions.length > 0 && (
            <Card className="p-5">
              <h2 className="text-lg font-semibold">Meet them in person</h2>
              <ul className="mt-3 space-y-3.5">
                {data.conventions.map((c) => (
                  <li key={c.id} className="text-sm">
                    <div className="font-medium">{c.url && /^https?:\/\//i.test(c.url) ? <a href={c.url} target="_blank" rel="noreferrer nofollow" className="hover:text-accent-hover">{c.name} <ExternalLink className="inline size-3.5 text-muted" aria-hidden /></a> : c.name}</div>
                    <div className="mt-0.5 flex items-center gap-1.5 text-muted"><CalendarDays className="size-3.5 shrink-0" aria-hidden />{date(c.starts_on)}{c.ends_on && c.ends_on !== c.starts_on ? ` to ${date(c.ends_on)}` : ''}</div>
                    {(c.location || c.booth) && <div className="mt-0.5 flex items-center gap-1.5 text-muted"><MapPin className="size-3.5 shrink-0" aria-hidden />{[c.location, c.booth && `Booth ${c.booth}`].filter(Boolean).join(' · ')}</div>}
                  </li>
                ))}
              </ul>
            </Card>
          )}

          {data.members.length > 0 && (
            <Card className="p-5">
              <h2 className="text-lg font-semibold">Members</h2>
              <ul className="mt-3 space-y-3">
                {data.members.map((m) => (
                  <li key={m.username}>
                    <Link to={`/u/${m.username}`} className="flex items-center gap-3 hover:text-accent-hover">
                      <Avatar src={m.avatar_url} name={m.name} size={36} />
                      <span className="min-w-0 flex-1 truncate text-sm font-medium">{m.name}</span>
                      <Badge>{ROLE[m.role] ?? m.role}</Badge>
                    </Link>
                  </li>
                ))}
              </ul>
            </Card>
          )}
        </aside>
      </div>

      <TipDialog open={tip} onClose={() => setTip(false)} brand={brand} onPaid={() => void qc.invalidateQueries({ queryKey: ['brand', slug] })} />
      <ReportDialog target={report ? { kind: 'publisher', id: brand.id, name: brand.name } : null} onClose={() => setReport(false)} />
    </div>
  );
}

type Directory = { items: { id: string; slug: string; name: string; kind: string; bio: string; avatar_url: string | null; verified: boolean; series_count: number; follower_count: number }[]; total: number; page: number; limit: number };

export function Creators() {
  useTitle('Creators');
  const [params, setParams] = useSearchParams();
  const q = params.get('q') ?? '';
  const kind = params.get('kind') ?? '';
  const sort = params.get('sort') ?? '';
  const page = Math.max(1, Number(params.get('page')) || 1);
  const [draft, setDraft] = useState(q);
  useEffect(() => setDraft(q), [q]);
  const update = (changes: Record<string, string | null>) => {
    const next = new URLSearchParams(params);
    if (!('page' in changes)) next.delete('page');
    for (const [k, v] of Object.entries(changes)) {
      if (!v) next.delete(k);
      else next.set(k, v);
    }
    setParams(next, { preventScrollReset: !('page' in changes) });
    if ('page' in changes) window.scrollTo({ top: 0 });
  };
  const query = useQuery({ queryKey: ['brands', q, kind, sort, page], queryFn: () => api<Directory>('/api/brands', { query: { q, kind, sort, page } }), placeholderData: keepPreviousData });
  const data = query.data;

  return (
    <div>
      <header className="mb-6">
        <h1 className="text-2xl font-bold sm:text-3xl">Creators</h1>
        <p className="mt-1.5 max-w-2xl text-muted">The people and small presses publishing here. Follow the ones you like to hear about new work.</p>
      </header>
      <div className="mb-6 flex flex-wrap items-center gap-3">
        <form role="search" className="relative w-full sm:w-80" onSubmit={(e) => { e.preventDefault(); update({ q: draft.trim() || null }); }}>
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted" aria-hidden />
          <Input type="search" aria-label="Search creators" placeholder="Search by name" value={draft} onChange={(e) => setDraft(e.target.value)} className="pl-9" />
        </form>
        <Segmented value={kind} onChange={(v) => update({ kind: v || null })} options={[{ value: '', label: 'Everyone' }, { value: 'creator', label: 'Independent' }, { value: 'publisher', label: 'Publishers' }]} />
        <div className="sm:ml-auto">
          <Segmented size="sm" value={sort} onChange={(v) => update({ sort: v || null })} options={[{ value: '', label: 'Most followed' }, { value: 'new', label: 'Newest' }, { value: 'name', label: 'A to Z' }]} />
        </div>
      </div>

      {query.isLoading ? (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">{Array.from({ length: 6 }, (_, i) => <Skeleton key={i} className="h-28" />)}</div>
      ) : query.isError || !data ? (
        <ErrorState message={errorMessage(query.error)} retry={() => void query.refetch()} />
      ) : data.items.length === 0 ? (
        <EmptyState icon={<UsersRound />} title={q ? `No creators match “${q}”` : 'No creators have published yet'} action={q || kind ? <Button onClick={() => setParams({})}>Show everyone</Button> : <LinkButton to="/studio" variant="primary">Start publishing</LinkButton>}>
          {q ? 'Check the spelling or try part of the name.' : 'Creators appear here once they have a public series.'}
        </EmptyState>
      ) : (
        <>
          <p className="mb-3 text-sm text-muted">{plural(data.total, 'creator')}</p>
          <ul className={cx('grid gap-4 sm:grid-cols-2 xl:grid-cols-3', query.isPlaceholderData && 'opacity-60')}>
            {data.items.map((b) => (
              <li key={b.id}>
                <Link to={`/b/${b.slug}`} className="flex h-full gap-4 rounded-2xl border border-line bg-surface p-4 transition-colors hover:border-line-strong hover:bg-raised">
                  <Avatar src={b.avatar_url} name={b.name} size={64} square />
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-1.5 font-display text-lg font-bold leading-tight"><span className="truncate">{b.name}</span>{b.verified && <BadgeCheck className="size-4 shrink-0 text-info" aria-label="Verified" />}</span>
                    <span className="mt-0.5 block text-[13px] text-muted">{plural(b.series_count, 'series', 'series')} · {compact(b.follower_count)} {b.follower_count === 1 ? 'follower' : 'followers'}</span>
                    {b.bio && <span className="mt-1.5 line-clamp-2 block text-sm text-muted">{b.bio}</span>}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
          <Pagination page={data.page} pages={Math.ceil(data.total / data.limit)} onPage={(p) => update({ page: p > 1 ? String(p) : null })} />
        </>
      )}
    </div>
  );
}
