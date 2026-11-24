import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Bell, BookOpen, Check, CheckCheck, Flag, Ghost, Heart, MessageCircle, MessagesSquare, Orbit, Pencil, Receipt, Rocket, Shapes, Sparkles, Swords, UserPlus, UserRound, Wallet, Zap,
} from 'lucide-react';
import { useState } from 'react';
import type { ReactNode } from 'react';
import { Link, useLocation, useNavigate, useParams, useSearchParams } from 'react-router';
import { ApiError, api, errorMessage } from '@/lib/api';
import { ago, date } from '@/lib/format';
import { useSession } from '@/lib/session';
import { Avatar, Badge, Button, Card, EmptyState, ErrorState, Field, Input, LinkButton, Modal, Notice, PageHeader, PageLoader, Pagination, Select, Tabs, Textarea, cx, toast } from '@/ui';
import { CoverGrid, ListSkeleton, PlainText, SeriesTile, safePath, useTitle } from './shared';
import type { SeriesCard } from './shared';

// ---------------------------------------------------------------- favourite genre

const GENRE_ART: Record<string, { icon: ReactNode; blurb: string }> = {
  superhero_action: { icon: <Zap />, blurb: 'Capes, powers and big fights' },
  scifi_fantasy: { icon: <Orbit />, blurb: 'Other worlds, magic and machines' },
  manga_action: { icon: <Swords />, blurb: 'Fast, kinetic manga adventures' },
  manga_romance: { icon: <Heart />, blurb: 'Manga with heart and wonder' },
  horror_mystery: { icon: <Ghost />, blurb: 'Dread, secrets and thrillers' },
  everything: { icon: <Shapes />, blurb: 'Surprise me with a mix' },
};

export function GenrePicker() {
  useTitle('Pick a favorite genre');
  const { meta, user, refresh } = useSession();
  const nav = useNavigate();
  const [params] = useSearchParams();
  const next = safePath(params.get('next'));
  const current = user?.prefs.favorite_genre ?? null;
  const [picked, setPicked] = useState<string | null>(current);
  const save = useMutation({
    mutationFn: () => api('/api/account/prefs', { method: 'PATCH', json: { favorite_genre: picked } }),
    onSuccess: async () => {
      await refresh();
      toast.success('Saved. Your store rows are tuned to your pick.');
      nav(next);
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  return (
    <div className="mx-auto max-w-3xl">
      <div className="mb-6 text-center">
        <h1 className="text-2xl font-bold sm:text-3xl">{current ? 'Change your favorite genre' : 'Pick one to start'}</h1>
        <p className="mt-2 text-muted">We use it to choose which rows the store shows you first. You can change it any time from the account menu.</p>
      </div>
      <div role="radiogroup" aria-label="Favorite genre" className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {meta.favoriteGenres.map((g) => {
          const on = picked === g.id;
          const art = GENRE_ART[g.id] ?? { icon: <BookOpen />, blurb: g.genres.join(', ') };
          return (
            <button
              key={g.id}
              type="button"
              role="radio"
              aria-checked={on}
              onClick={() => setPicked(g.id)}
              className={cx(
                'relative flex min-h-24 items-center gap-4 rounded-2xl border p-4 text-left transition-colors sm:min-h-36 sm:flex-col sm:items-start sm:justify-between',
                on ? 'border-accent bg-accent-soft' : 'border-line bg-surface hover:border-line-strong hover:bg-raised',
              )}
            >
              <span className={cx('flex size-11 shrink-0 items-center justify-center rounded-xl [&>svg]:size-6', on ? 'bg-accent text-accent-ink' : 'bg-raised text-muted')}>{art.icon}</span>
              <span className="min-w-0">
                <span className="block font-display text-base font-semibold leading-tight">{g.label}</span>
                <span className="mt-1 block text-xs text-muted">{art.blurb}</span>
              </span>
              {on && <Check className="absolute right-3 top-3 size-5 text-accent-hover" aria-hidden />}
            </button>
          );
        })}
      </div>
      <div className="mt-6 flex flex-wrap items-center justify-center gap-2">
        <Button variant="primary" size="lg" disabled={!picked || picked === current} loading={save.isPending} onClick={() => save.mutate()}>Save</Button>
        <LinkButton to={next} variant="ghost" size="lg">{current ? 'Cancel' : 'Skip for now'}</LinkButton>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- notifications

type Notification = { id: string; kind: string; title: string; body: string | null; url: string | null; read_at: string | null; created_at: string };
type NotificationPage = { items: Notification[]; unread: number; total: number; page: number; limit: number };

const KIND_ICON: Record<string, ReactNode> = {
  release: <Rocket />, message: <MessageCircle />, reply: <MessagesSquare />, mention: <MessagesSquare />, follower: <UserPlus />,
  purchase: <Receipt />, refund: <Receipt />, membership: <Sparkles />, tip: <Heart />, payout: <Wallet />,
};

export function Notifications() {
  useTitle('Notifications');
  const qc = useQueryClient();
  const nav = useNavigate();
  const { refresh } = useSession();
  const [params, setParams] = useSearchParams();
  const unreadOnly = params.get('show') === 'unread';
  const page = Math.max(1, Number(params.get('page')) || 1);
  const list = useQuery({
    queryKey: ['notifications', unreadOnly, page],
    queryFn: () => api<NotificationPage>('/api/notifications', { query: { page, unread: unreadOnly ? '1' : undefined } }),
  });
  const changed = async () => {
    await qc.invalidateQueries({ queryKey: ['notifications'] });
    await refresh();
  };
  const readOne = useMutation({
    mutationFn: (id: string) => api(`/api/notifications/${id}/read`, { method: 'POST' }),
    onSuccess: changed,
    onError: (e) => toast.error(errorMessage(e)),
  });
  const readAll = useMutation({
    mutationFn: () => api('/api/notifications/read-all', { method: 'POST' }),
    onSuccess: async () => {
      await changed();
      toast.success('All caught up');
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const open = (n: Notification) => {
    if (!n.read_at) readOne.mutate(n.id);
    if (!n.url) return;
    if (/^https?:/i.test(n.url)) window.location.assign(n.url);
    else nav(n.url);
  };
  const data = list.data;
  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader
        title="Notifications"
        description={data ? (data.unread ? `${data.unread} unread` : 'You are all caught up.') : undefined}
        actions={
          <>
            <Button icon={<CheckCheck className="size-4" />} disabled={!data?.unread} loading={readAll.isPending} onClick={() => readAll.mutate()}>Mark all as read</Button>
            <LinkButton to="/account#email" variant="ghost">Email settings</LinkButton>
          </>
        }
      />
      <div className="mb-5">
        <Tabs value={unreadOnly ? 'unread' : 'all'} onChange={(v) => setParams(v === 'unread' ? { show: 'unread' } : {})} tabs={[{ value: 'all', label: 'All' }, { value: 'unread', label: data?.unread ? `Unread (${data.unread})` : 'Unread' }]} />
      </div>
      {list.isPending ? (
        <ListSkeleton />
      ) : list.isError ? (
        <ErrorState message={errorMessage(list.error)} retry={() => list.refetch()} />
      ) : data!.items.length === 0 ? (
        unreadOnly ? (
          <EmptyState icon={<CheckCheck />} title="Nothing unread" action={<Button onClick={() => setParams({})}>Show all notifications</Button>}>You have read everything.</EmptyState>
        ) : (
          <EmptyState icon={<Bell />} title="No notifications yet" action={<LinkButton to="/creators" variant="primary">Find creators to follow</LinkButton>}>
            New releases from what you follow, replies, mentions and messages show up here.
          </EmptyState>
        )
      ) : (
        <>
          <ul className="overflow-hidden rounded-2xl border border-line">
            {data!.items.map((n) => {
              const unread = !n.read_at;
              return (
                <li key={n.id} className={cx('flex items-stretch border-b border-line last:border-0', unread ? 'bg-accent-soft/40' : 'bg-surface')}>
                  <button type="button" onClick={() => open(n)} className="flex min-w-0 flex-1 items-start gap-3 px-4 py-3.5 text-left transition-colors hover:bg-hover">
                    <span className={cx('mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-full [&>svg]:size-[18px]', unread ? 'bg-accent text-accent-ink' : 'bg-raised text-muted')}>{KIND_ICON[n.kind] ?? <Bell />}</span>
                    <span className="min-w-0 flex-1">
                      <span className={cx('block text-sm', unread ? 'font-semibold text-paper' : 'text-paper')}>
                        {n.title}
                        {unread && <span className="sr-only"> (unread)</span>}
                      </span>
                      {n.body && <span className="mt-0.5 line-clamp-2 block text-sm text-muted">{n.body}</span>}
                      <span className="mt-1 block text-xs text-faint">{ago(n.created_at)}</span>
                    </span>
                  </button>
                  {unread && (
                    <button type="button" aria-label={`Mark as read: ${n.title}`} title="Mark as read" disabled={readOne.isPending} onClick={() => readOne.mutate(n.id)} className="flex w-12 shrink-0 items-center justify-center text-muted transition-colors hover:bg-hover hover:text-paper disabled:opacity-40">
                      <Check className="size-5" />
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
          <Pagination
            page={data!.page}
            pages={unreadOnly ? (data!.items.length < data!.limit && page === 1 ? 1 : Math.ceil(data!.unread / data!.limit)) : Math.ceil(data!.total / data!.limit)}
            onPage={(p) => {
              const n = new URLSearchParams(params);
              n.set('page', String(p));
              setParams(n);
            }}
          />
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- feedback

const CATEGORIES = [
  { id: 'general', label: 'General comment' },
  { id: 'bug', label: 'Something is broken' },
  { id: 'idea', label: 'An idea or request' },
  { id: 'billing', label: 'Payments or membership' },
  { id: 'content', label: 'A comic or creator' },
  { id: 'other', label: 'Something else' },
] as const;

/**
 * The page the reader was on before opening the feedback form. Recorded with
 * the Navigation API as in-app navigation happens (this module is loaded with
 * the router at start-up); falls back to the referrer.
 */
let cameFrom: string | null = null;
type NavigationLike = { addEventListener: (type: 'navigate', cb: (e: { destination: { url: string } }) => void) => void };
if (typeof window !== 'undefined' && 'navigation' in window) {
  (window as unknown as { navigation: NavigationLike }).navigation.addEventListener('navigate', (e) => {
    try {
      if (new URL(e.destination.url).pathname === '/feedback' && window.location.pathname !== '/feedback') cameFrom = window.location.href;
    } catch {
      /* unusual URL: keep the previous value */
    }
  });
}

export function Feedback() {
  useTitle('Submit feedback');
  const { user, settings } = useSession();
  const loc = useLocation();
  const [params] = useSearchParams();
  const initial = CATEGORIES.find((c) => c.id === params.get('category'))?.id ?? 'general';
  const [category, setCategory] = useState<string>(initial);
  const [body, setBody] = useState('');
  const [email, setEmail] = useState('');
  const [pageUrl] = useState<string>(() => {
    const from = (loc.state as { from?: string } | null)?.from ?? cameFrom ?? document.referrer ?? '';
    return from && !new RegExp('/feedback(\\?|$)').test(from) ? from.slice(0, 500) : '';
  });
  const [sent, setSent] = useState(false);
  const send = useMutation({
    mutationFn: () => api('/api/feedback', { json: { category, body, page_url: pageUrl || undefined, email: !user && email ? email : undefined } }),
    onSuccess: () => {
      setSent(true);
      setBody('');
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  if (sent) {
    return (
      <div className="mx-auto max-w-xl">
        <EmptyState
          icon={<Check />}
          title="Thank you. We got it."
          action={
            <div className="flex flex-wrap justify-center gap-2">
              <LinkButton to="/" variant="primary">Back to the store</LinkButton>
              <Button onClick={() => setSent(false)}>Send another</Button>
            </div>
          }
        >
          A person on the {settings.site.name} team reads every message. {user || email ? 'If it needs an answer, we will email you.' : 'You did not leave an email, so we cannot reply.'}
        </EmptyState>
      </div>
    );
  }
  return (
    <div className="mx-auto max-w-xl">
      <PageHeader title="Submit feedback" description="Tell us what is working, what is not, or what you wish existed. It goes straight to the team." />
      <Card className="px-5 py-5">
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (body.trim()) send.mutate();
          }}
        >
          <Field label="What is it about?">
            <Select value={category} onChange={(e) => setCategory(e.target.value)}>
              {CATEGORIES.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
            </Select>
          </Field>
          <Field label="Your message" hint={category === 'bug' ? 'What did you do, what did you expect, and what happened instead?' : undefined}>
            <Textarea value={body} onChange={(e) => setBody(e.target.value)} maxLength={5000} required className="min-h-40" />
          </Field>
          {!user && (
            <Field label="Your email" optional hint="Only used to answer this message.">
              <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" maxLength={200} />
            </Field>
          )}
          {pageUrl && (
            <p className="break-all text-xs text-faint">
              Sent with your message so we can find the page you were on: <span className="text-muted">{pageUrl}</span>
            </p>
          )}
          <Button type="submit" variant="primary" loading={send.isPending} disabled={!body.trim()}>Send feedback</Button>
        </form>
      </Card>
      <p className="mt-4 text-sm text-muted">
        Reporting a specific comic, comment or person? Use the Report button next to it so the moderators see exactly what you mean.
      </p>
    </div>
  );
}

// ---------------------------------------------------------------- public profile

type Profile = {
  user: { id: string; username: string; name: string; bio: string; avatar_url: string | null; joined_at: string; accepts_messages: boolean; is_me: boolean };
  brands: { slug: string; name: string; kind: string; role: string; avatar_url: string | null }[];
  favorites: SeriesCard[];
};

const REPORT_REASONS = ['Harassment or abuse', 'Spam or scam', 'Impersonation', 'Inappropriate profile', 'Something else'];

function ReportUser({ profile, onClose }: { profile: Profile['user']; onClose: () => void }) {
  const [reason, setReason] = useState(REPORT_REASONS[0]);
  const [detail, setDetail] = useState('');
  const report = useMutation({
    mutationFn: () => api('/api/reports', { json: { target_kind: 'user', target_id: profile.id, reason, detail } }),
    onSuccess: () => {
      toast.success('Report sent. The moderators will take a look.');
      onClose();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  return (
    <Modal
      open
      onClose={onClose}
      title={`Report @${profile.username}`}
      size="sm"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={report.isPending} onClick={() => report.mutate()}>Send report</Button>
        </>
      }
    >
      <div className="space-y-4">
        <p className="text-sm text-muted">Reports go to the moderators. The person you report is not told who reported them.</p>
        <Field label="Reason">
          <Select value={reason} onChange={(e) => setReason(e.target.value)}>
            {REPORT_REASONS.map((r) => <option key={r}>{r}</option>)}
          </Select>
        </Field>
        <Field label="What happened?" optional hint="Links to the posts or messages help.">
          <Textarea value={detail} onChange={(e) => setDetail(e.target.value)} maxLength={2000} />
        </Field>
      </div>
    </Modal>
  );
}

export function UserProfile() {
  const { username = '' } = useParams();
  const { user: me } = useSession();
  const loc = useLocation();
  const [reporting, setReporting] = useState(false);
  const profile = useQuery({
    queryKey: ['user', username.toLowerCase()],
    queryFn: () => api<Profile>(`/api/users/${encodeURIComponent(username)}`),
    retry: (n, e) => !(e instanceof ApiError && e.status === 404) && n < 2,
  });
  useTitle(profile.data ? `${profile.data.user.name} (@${profile.data.user.username})` : `@${username}`);

  if (profile.isPending) return <PageLoader label="Loading the profile" />;
  if (profile.isError) {
    if (profile.error instanceof ApiError && profile.error.status === 404) {
      return (
        <div className="mx-auto max-w-xl">
          <EmptyState icon={<UserRound />} title="No one here by that name" action={<LinkButton to="/community" variant="primary">Go to the community</LinkButton>}>
            @{username} does not exist, or the account was closed.
          </EmptyState>
        </div>
      );
    }
    return <ErrorState message={errorMessage(profile.error)} retry={() => profile.refetch()} />;
  }
  const { user: u, brands, favorites } = profile.data;
  const signIn = `/login?next=${encodeURIComponent(loc.pathname)}`;
  return (
    <div className="mx-auto max-w-5xl">
      <header className="mb-8 flex flex-col gap-5 rounded-2xl border border-line bg-surface p-5 sm:flex-row sm:items-start sm:p-6">
        <Avatar src={u.avatar_url} name={u.name} size={96} />
        <div className="min-w-0 flex-1">
          <h1 className="break-words text-2xl font-bold sm:text-3xl">{u.name}</h1>
          <div className="mt-1 text-sm text-muted">@{u.username} · Member since {date(u.joined_at, { year: 'numeric', month: 'long' })}</div>
          {u.bio ? <PlainText className="mt-3 max-w-2xl text-sm">{u.bio}</PlainText> : u.is_me ? <p className="mt-3 text-sm text-muted">You have not written a bio yet.</p> : null}
          <div className="mt-4 flex flex-wrap items-center gap-2">
            {u.is_me ? (
              <LinkButton to="/account" variant="primary" icon={<Pencil className="size-4" />}>Edit profile</LinkButton>
            ) : (
              <>
                {u.accepts_messages ? (
                  <LinkButton to={me ? `/messages?to=${encodeURIComponent(u.username)}` : signIn} variant="primary" icon={<MessageCircle className="size-4" />}>Message</LinkButton>
                ) : (
                  <Badge>Not accepting messages</Badge>
                )}
                {me ? (
                  <Button variant="ghost" icon={<Flag className="size-4" />} onClick={() => setReporting(true)}>Report</Button>
                ) : (
                  <LinkButton to={signIn} variant="ghost" icon={<Flag className="size-4" />}>Report</LinkButton>
                )}
              </>
            )}
          </div>
        </div>
      </header>

      {u.is_me && <div className="mb-8"><Notice tone="info">This is how other people see your profile. Your display name shows only if you allow it under Privacy in account settings.</Notice></div>}

      {brands.length > 0 && (
        <section className="mb-10">
          <h2 className="mb-3 text-lg font-semibold">Publishes as</h2>
          <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {brands.map((b) => (
              <li key={b.slug}>
                <Link to={`/b/${b.slug}`} className="flex items-center gap-3 rounded-2xl border border-line bg-surface p-3 transition-colors hover:border-line-strong">
                  <Avatar src={b.avatar_url} name={b.name} size={44} square />
                  <span className="min-w-0">
                    <span className="block truncate font-semibold">{b.name}</span>
                    <span className="block text-xs capitalize text-muted">{b.kind} · {b.role}</span>
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section>
        <h2 className="mb-3 text-lg font-semibold">Favorite series</h2>
        {favorites.length ? (
          <CoverGrid>{favorites.map((s) => <SeriesTile key={s.id} series={s} />)}</CoverGrid>
        ) : (
          <EmptyState icon={<Heart />} title="No favorites yet" action={u.is_me ? <LinkButton to="/">Browse the store</LinkButton> : undefined}>
            {u.is_me ? 'Tap the heart on a series and it shows here.' : `${u.name} has not picked any favorite series yet.`}
          </EmptyState>
        )}
      </section>
      {reporting && <ReportUser profile={u} onClose={() => setReporting(false)} />}
    </div>
  );
}
