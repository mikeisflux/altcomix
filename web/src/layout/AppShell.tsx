import { useQuery } from '@tanstack/react-query';
import {
  ArrowUpRight, BarChart3, Bell, BookOpen, ChevronRight, Download, Gift, LibraryBig, LogOut, Menu, MessageCircle, MessagesSquare, PenLine,
  Receipt, Search, Settings, ShieldCheck, Sparkles, Store, Ticket, UserRound, X,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router';
import { api } from '@/lib/api';
import { useSession } from '@/lib/session';
import { Avatar, Badge, Button, IconButton, LinkButton, Modal, Popover, cx } from '@/ui';

type Announcement = { id: string; kind: 'bar' | 'modal'; headline: string; body: string; cta_label: string | null; cta_url: string | null; image_url: string | null };

const LEGAL = [
  ['Why NSFWComix', '/welcome'], ['Creator promise', '/p/creator-promise'], ['About', '/p/about'], ['Contact', '/p/contact'], ['Content policy', '/p/content-policy'], ['Publisher SLA', '/p/publisher-sla'],
  ['Privacy', '/p/privacy'], ['Your privacy choices', '/p/privacy-choices'], ['Terms', '/p/terms'], ['FAQ', '/p/faq'],
] as const;

/**
 * The mark: a keyboard key reading "nsfw". `size` is its height in px.
 * `square` gives the icon form (two lines, "ns" over "fw") used where the mark
 * has to fit a square.
 */
export function Keycap({ size = 36, square = false }: { size?: number; square?: boolean }) {
  const base = { height: size, borderRadius: size * 0.235, boxShadow: `inset 0 -${size * 0.095}px 0 rgb(0 0 0 / .24)` };
  if (square) {
    return (
      <span aria-hidden className="flex shrink-0 flex-col items-start justify-center bg-accent" style={{ ...base, width: size, padding: `0 0 ${size * 0.08}px ${size * 0.16}px` }}>
        <span className="font-display font-extrabold text-accent-ink" style={{ fontSize: size * 0.36, lineHeight: 0.86, letterSpacing: '-0.04em' }}>ns<br />fw</span>
      </span>
    );
  }
  return (
    <span aria-hidden className="flex shrink-0 items-end bg-accent" style={{ ...base, padding: `0 ${size * 0.2}px ${size * 0.2}px ${size * 0.17}px` }}>
      <span className="font-display font-extrabold leading-none text-accent-ink" style={{ fontSize: size * 0.42, letterSpacing: '-0.04em' }}>nsfw</span>
    </span>
  );
}

/** Keycap + "comix". The second span is the wordmark, hidden by the top bar on small screens. */
export function Logo({ className, size = 36 }: { className?: string; size?: number }) {
  const { settings } = useSession();
  return (
    <Link to="/" className={cx('flex items-center gap-2', className)} aria-label={`${settings.site.name} home`}>
      <Keycap size={size} />
      <span className="font-display font-extrabold leading-none" style={{ fontSize: size * 0.78, letterSpacing: '-0.045em' }}>comix</span>
    </Link>
  );
}

/** 18+ switch in the top bar: one confirmation, then adult titles show everywhere. */
function AdultSwitch() {
  const { adult, setAdult } = useSession();
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const apply = async (on: boolean) => {
    setBusy(true);
    try {
      await setAdult(on);
      setAsking(false);
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <button
        type="button"
        role="switch"
        aria-checked={adult}
        disabled={busy}
        title={adult ? 'Adult titles are shown. Click to hide them.' : 'Show adult titles (18+)'}
        onClick={() => (adult ? void apply(false) : setAsking(true))}
        className={cx(
          'flex h-9 shrink-0 items-center gap-1.5 rounded-full border px-3 text-[13px] font-semibold transition-colors',
          adult ? 'border-sun bg-sun text-sun-ink' : 'border-line-strong text-muted hover:border-sun hover:text-paper',
        )}
      >
        18+<span className="hidden sm:inline">{adult ? ' on' : ' off'}</span>
      </button>
      <Modal
        open={asking}
        onClose={() => setAsking(false)}
        title="Show adult titles?"
        size="sm"
        footer={
          <>
            <Button variant="ghost" onClick={() => setAsking(false)}>Not now</Button>
            <Button variant="sun" loading={busy} onClick={() => void apply(true)}>I am 18 or older</Button>
          </>
        }
      >
        <p className="text-sm text-muted">
          Some comics here are made for adults and include explicit sexual content, nudity or graphic violence. They stay hidden until you confirm your age.
          You can turn this off again at any time.
        </p>
      </Modal>
    </>
  );
}

function SearchBox({ onDone }: { onDone?: () => void }) {
  const nav = useNavigate();
  const loc = useLocation();
  const [q, setQ] = useState(() => new URLSearchParams(loc.search).get('q') ?? '');
  const submit = (e: FormEvent) => {
    e.preventDefault();
    nav(`/browse${q.trim() ? `?q=${encodeURIComponent(q.trim())}` : ''}`);
    onDone?.();
  };
  return (
    <form onSubmit={submit} role="search" className="relative min-w-0 flex-1">
      <Search className="pointer-events-none absolute left-3.5 top-1/2 size-4 -translate-y-1/2 text-muted" aria-hidden />
      <input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        type="search"
        aria-label="Search comics and creators"
        placeholder="Search comics, creators, tags"
        className="h-10 w-full rounded-full border border-line bg-surface pl-10 pr-4 text-sm placeholder:text-faint hover:border-line-strong focus:border-accent focus:outline-none"
      />
    </form>
  );
}

function Row({ to, icon, children, onClick, right }: { to?: string; icon: ReactNode; children: ReactNode; onClick?: () => void; right?: ReactNode }) {
  const inner = (
    <>
      <span className="text-muted [&>svg]:size-4">{icon}</span>
      <span className="flex-1 text-left">{children}</span>
      {right ?? <ChevronRight className="size-4 text-faint" />}
    </>
  );
  const cls = 'flex w-full items-center gap-3 px-4 py-2.5 text-sm transition-colors hover:bg-hover';
  return to ? <Link to={to} onClick={onClick} className={cls}>{inner}</Link> : <button type="button" onClick={onClick} className={cls}>{inner}</button>;
}

function AccountMenu() {
  const { user, logout, settings, isStaff, meta } = useSession();
  if (!user) {
    return (
      <div className="flex items-center gap-2">
        <LinkButton to="/login" variant="ghost" size="sm">Sign in</LinkButton>
        <LinkButton to="/register" variant="primary" size="sm">Join free</LinkButton>
      </div>
    );
  }
  const fav = meta.favoriteGenres.find((g) => g.id === user.prefs.favorite_genre);
  return (
    <Popover
      width={320}
      trigger={({ toggle, open }) => (
        <button onClick={toggle} aria-label="Account menu" aria-expanded={open} className="rounded-full ring-accent transition-shadow hover:ring-2">
          <Avatar src={user.avatar_url} name={user.display_name} size={36} />
        </button>
      )}
    >
      {(close) => (
        <div className="max-h-[80dvh] overflow-auto py-2">
          <div className="flex items-center justify-between gap-3 px-4 pb-3 pt-2">
            <div className="min-w-0">
              <div className="truncate font-display text-lg font-bold">{user.display_name}</div>
              <div className="truncate text-xs text-muted">@{user.username}</div>
            </div>
            <Link to={`/u/${user.username}`} onClick={close} className="shrink-0 text-sm font-medium text-accent-hover hover:text-paper">View profile</Link>
          </div>
          {!user.member && (
            <Link to="/unlimited" onClick={close} className="mx-3 mb-2 flex items-center gap-3 rounded-xl bg-accent-soft px-3 py-2.5 hover:bg-accent/30">
              <Sparkles className="size-5 text-accent-hover" />
              <span className="flex-1">
                <span className="block text-sm font-semibold">Get {settings.membership.name}</span>
                <span className="block text-xs text-muted">Read everything in the membership catalogue</span>
              </span>
              <ChevronRight className="size-4 text-muted" />
            </Link>
          )}
          <Row to="/account" icon={<Settings />} onClick={close}>Account settings</Row>
          <Row to="/onboarding/genre" icon={<BookOpen />} onClick={close} right={<span className="text-xs text-muted">{fav?.label ?? 'Choose'}</span>}>Favorite genre</Row>
          <Row to="/account/codes" icon={<Ticket />} onClick={close}>Redeem code</Row>
          <Row to="/gift-cards" icon={<Gift />} onClick={close}>Gift cards</Row>
          <Row to="/account/purchases" icon={<Receipt />} onClick={close}>Purchases</Row>
          <Row to="/account/membership" icon={<Sparkles />} onClick={close} right={user.member ? <Badge tone="ok">Active</Badge> : undefined}>Membership</Row>
          <Row to="/feedback" icon={<MessageCircle />} onClick={close}>Submit feedback</Row>

          {user.brands.map((b) => (
            <div key={b.id} className="mt-2 border-t border-line pt-2">
              <Link to={`/b/${b.slug}`} onClick={close} className="flex items-center gap-3 px-4 py-2 hover:bg-hover">
                <Avatar src={b.avatar_url} name={b.name} size={40} square />
                <span className="min-w-0">
                  <span className="block truncate font-semibold">{b.name}</span>
                  <span className="block text-xs text-muted">View creator profile</span>
                </span>
              </Link>
              <Row to={`/studio/${b.slug}/settings`} icon={<Settings />} onClick={close}>Brand settings</Row>
              <Row to={`/studio/${b.slug}/analytics`} icon={<BarChart3 />} onClick={close}>Analytics</Row>
              <Row to={`/studio/${b.slug}`} icon={<LibraryBig />} onClick={close}>Manage series</Row>
            </div>
          ))}
          <div className="mt-2 border-t border-line pt-2">
            {user.brands.length === 0 && <Row to="/studio" icon={<PenLine />} onClick={close}>Start publishing</Row>}
            {isStaff && <Row to="/admin" icon={<ShieldCheck />} onClick={close}>Admin</Row>}
            <Row icon={<LogOut />} onClick={() => void logout()} right={<span />}>Log out</Row>
          </div>
        </div>
      )}
    </Popover>
  );
}

function SidebarLink({ to, icon, children, end, onClick }: { to: string; icon: ReactNode; children: ReactNode; end?: boolean; onClick?: () => void }) {
  return (
    <NavLink
      to={to}
      end={end}
      onClick={onClick}
      className={({ isActive }) => cx('flex items-center gap-3 rounded-xl px-3 py-2.5 text-[15px] font-medium transition-colors [&>svg]:size-5', isActive ? 'bg-raised text-paper' : 'text-muted hover:bg-hover hover:text-paper')}
    >
      {icon}
      {children}
    </NavLink>
  );
}

function Sidebar({ onNavigate }: { onNavigate?: () => void }) {
  const { settings, user } = useSession();
  const [installEvent, setInstallEvent] = useState<(Event & { prompt: () => void }) | null>(null);
  useEffect(() => {
    const h = (e: Event) => {
      e.preventDefault();
      setInstallEvent(e as Event & { prompt: () => void });
    };
    window.addEventListener('beforeinstallprompt', h);
    return () => window.removeEventListener('beforeinstallprompt', h);
  }, []);
  const socials = Object.entries(settings.site.socials ?? {}).filter(([, v]) => v);
  return (
    <div className="flex h-full flex-col gap-1 overflow-y-auto px-3 py-4">
      <SidebarLink to="/" end icon={<Store />} onClick={onNavigate}>Store</SidebarLink>
      <SidebarLink to="/library" icon={<LibraryBig />} onClick={onNavigate}>Library</SidebarLink>
      <SidebarLink to="/unlimited" icon={<Sparkles />} onClick={onNavigate}>{user?.member ? 'Unlimited' : 'Go Unlimited'}</SidebarLink>
      <SidebarLink to="/community" icon={<MessagesSquare />} onClick={onNavigate}>Community</SidebarLink>
      <SidebarLink to="/creators" icon={<UserRound />} onClick={onNavigate}>Creators</SidebarLink>

      <div className="my-3 border-t border-line" />
      {installEvent && (
        <div className="px-1 pb-2">
          <div className="mb-2 px-2 font-display text-sm font-semibold">Read anywhere</div>
          <Button variant="sun" block icon={<Download className="size-4" />} onClick={() => installEvent.prompt()}>Install the app</Button>
        </div>
      )}
      <div className="px-1">
        <LinkButton to="/studio" variant="secondary" block icon={<PenLine className="size-4" />}>Publish</LinkButton>
      </div>

      <div className="mt-auto space-y-3 px-2 pt-6">
        {socials.length > 0 && (
          <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted">
            {socials.map(([k, v]) => <a key={k} href={v} target="_blank" rel="noreferrer" className="capitalize hover:text-paper">{k}</a>)}
          </div>
        )}
        <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-faint">
          {LEGAL.map(([label, to]) => <Link key={to} to={to} onClick={onNavigate} className="hover:text-paper">{label}</Link>)}
          <Link to="/news" onClick={onNavigate} className="hover:text-paper">News</Link>
        </div>
      </div>
    </div>
  );
}

function Announcements() {
  const { data } = useQuery({
    queryKey: ['announcements'],
    queryFn: () => api<{ announcements: Announcement[] }>('/api/content/announcements'),
    staleTime: 5 * 60_000,
    retry: false,
  });
  const [dismissed, setDismissed] = useState<string[]>(() => {
    try {
      return JSON.parse(localStorage.getItem('nsfwcomix.dismissed') ?? '[]');
    } catch {
      return [];
    }
  });
  const dismiss = (id: string) => {
    const next = [...dismissed, id].slice(-30);
    setDismissed(next);
    try {
      localStorage.setItem('nsfwcomix.dismissed', JSON.stringify(next));
    } catch {
      /* private mode */
    }
  };
  const list = (data?.announcements ?? []).filter((a) => !dismissed.includes(a.id));
  const bar = list.find((a) => a.kind === 'bar');
  const modal = list.find((a) => a.kind === 'modal');
  const cta = (a: Announcement, variant: 'sun' | 'primary', size: 'sm' | 'lg') =>
    a.cta_label && a.cta_url ? (
      <LinkButton to={a.cta_url} external={/^https?:/.test(a.cta_url)} variant={variant} size={size}>{a.cta_label}</LinkButton>
    ) : null;
  return (
    <>
      {bar && (
        <div className="flex items-center justify-center gap-3 bg-accent px-4 py-2 text-center text-sm font-semibold text-accent-ink">
          <span className="min-w-0">{bar.headline}{bar.body ? <span className="font-normal"> — {bar.body}</span> : null}</span>
          {cta(bar, 'sun', 'sm')}
          <button aria-label="Dismiss announcement" onClick={() => dismiss(bar.id)} className="rounded p-1 hover:bg-black/15"><X className="size-4" /></button>
        </div>
      )}
      {modal && (
        <Modal open onClose={() => dismiss(modal.id)} title={modal.headline} size="sm" footer={<span onClick={() => dismiss(modal.id)}>{cta(modal, 'primary', 'lg')}</span>}>
          {modal.image_url && <img src={modal.image_url} alt="" className="mb-4 w-full rounded-xl" />}
          <p className="whitespace-pre-line text-muted">{modal.body}</p>
        </Modal>
      )}
    </>
  );
}

function VerifyBanner() {
  const { user } = useSession();
  const [sent, setSent] = useState(false);
  if (!user || user.email_verified) return null;
  return (
    <div className="flex flex-wrap items-center justify-center gap-x-3 gap-y-1 border-b border-warn/30 bg-warn-soft px-4 py-2 text-center text-sm text-warn">
      <span>Confirm your email ({user.email}) to buy, comment and publish.</span>
      <button
        className="underline disabled:no-underline"
        disabled={sent}
        onClick={() => api('/api/auth/resend-verification', { method: 'POST' }).then(() => setSent(true)).catch(() => setSent(true))}
      >
        {sent ? 'Sent. Check your inbox.' : 'Resend the link'}
      </button>
    </div>
  );
}

/** Main chrome for every page except the reader and the frame editor. */
export function AppShell() {
  const { user } = useSession();
  const [drawer, setDrawer] = useState(false);
  const loc = useLocation();
  useEffect(() => setDrawer(false), [loc.pathname]);

  // Admin is a back office, not part of the store: it gets its own plain top bar
  // (logo, a way back to the site, the account menu) and none of the reader chrome.
  if (loc.pathname === '/admin' || loc.pathname.startsWith('/admin/')) {
    return (
      <div className="flex min-h-dvh flex-col">
        <header className="sticky top-0 z-30 flex h-16 items-center gap-3 border-b border-line bg-ink/90 px-3 backdrop-blur print:hidden sm:px-5">
          <Link to="/admin" className="flex shrink-0 items-center gap-2" aria-label="Admin home">
            <Keycap size={36} />
            <span className="hidden font-display text-[28px] font-extrabold leading-none tracking-[-0.045em] sm:inline">comix</span>
            <span className="ml-1 rounded-md border border-line-strong px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wider text-muted">Admin</span>
          </Link>
          <div className="flex-1" />
          <Link to="/" className="inline-flex h-9 items-center gap-1.5 rounded-lg px-3 text-sm text-muted hover:bg-hover hover:text-paper">
            View site <ArrowUpRight className="size-4" />
          </Link>
          <AccountMenu />
        </header>
        <main className="min-w-0 flex-1 px-4 py-6 sm:px-6 lg:px-8">
          <Outlet />
        </main>
      </div>
    );
  }

  return (
    <div className="flex min-h-dvh flex-col">
      <Announcements />
      <header className="sticky top-0 z-30 flex h-16 print:hidden items-center gap-3 border-b border-line bg-ink/90 px-3 backdrop-blur sm:px-5">
        <IconButton label="Open menu" className="lg:hidden" onClick={() => setDrawer(true)}><Menu className="size-5" /></IconButton>
        <Logo className="shrink-0 [&>span:last-child]:hidden sm:[&>span:last-child]:inline lg:w-56" />
        <div className="hidden min-w-0 flex-1 sm:flex"><SearchBox /></div>
        <div className="flex-1 sm:hidden" />
        <Link to="/browse" aria-label="Search" className="inline-flex size-9 items-center justify-center rounded-lg text-muted hover:bg-hover hover:text-paper sm:hidden"><Search className="size-5" /></Link>
        {user && (
          <>
            <Link to="/messages" aria-label="Messages" className="hidden size-9 items-center justify-center rounded-lg text-muted hover:bg-hover hover:text-paper sm:inline-flex"><MessageCircle className="size-5" /></Link>
            <Link to="/notifications" aria-label={`Notifications${user.unread_notifications ? `, ${user.unread_notifications} unread` : ''}`} className="relative inline-flex size-9 items-center justify-center rounded-lg text-muted hover:bg-hover hover:text-paper">
              <Bell className="size-5" />
              {user.unread_notifications > 0 && (
                <span className="absolute -right-0.5 -top-0.5 flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-accent px-1 text-[10px] font-bold text-accent-ink">
                  {user.unread_notifications > 99 ? '99+' : user.unread_notifications}
                </span>
              )}
            </Link>
          </>
        )}
        <AdultSwitch />
        <AccountMenu />
      </header>
      <VerifyBanner />

      <div className="flex min-h-0 flex-1">
        <aside className="sticky top-16 hidden h-[calc(100dvh-4rem)] w-60 shrink-0 border-r border-line print:!hidden lg:block">
          <Sidebar />
        </aside>
        <main className="min-w-0 flex-1 px-4 py-6 sm:px-6 lg:px-8">
          <Outlet />
        </main>
      </div>

      {drawer && (
        <div className="fixed inset-0 z-50 lg:hidden">
          <div className="absolute inset-0 bg-black/70" onClick={() => setDrawer(false)} />
          <div className="absolute inset-y-0 left-0 flex w-72 max-w-[85vw] flex-col border-r border-line bg-ink">
            <div className="flex h-16 items-center justify-between border-b border-line px-4">
              <Logo />
              <IconButton label="Close menu" onClick={() => setDrawer(false)}><X className="size-5" /></IconButton>
            </div>
            <Sidebar onNavigate={() => setDrawer(false)} />
          </div>
        </div>
      )}
    </div>
  );
}

/** Centered column for sign-in style pages. */
export function AuthLayout() {
  return (
    <div className="flex min-h-dvh flex-col items-center px-4 py-10">
      <Logo className="mb-8" size={44} />
      <div className="w-full max-w-md rounded-2xl border border-line bg-surface p-6 sm:p-8">
        <Outlet />
      </div>
    </div>
  );
}

/** Wrap routes that need a signed-in user. */
export function RequireUser({ children }: { children: ReactNode }) {
  const { user } = useSession();
  const loc = useLocation();
  const nav = useNavigate();
  useEffect(() => {
    if (!user) nav(`/login?next=${encodeURIComponent(loc.pathname + loc.search)}`, { replace: true });
  }, [user, nav, loc]);
  return user ? <>{children}</> : null;
}
