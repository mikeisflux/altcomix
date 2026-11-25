import {
  Activity, BadgeDollarSign, Ban, BookOpen, Bug, CalendarClock, Clock, CreditCard, FileText, Flag, Gauge, Inbox, KeyRound, Landmark, LayoutTemplate, Mail, MailX,
  MailOpen, Megaphone, MessageSquare, Newspaper, Receipt, ScrollText, Settings, ShieldCheck, Sparkles, Store, Ticket, Users, Wallet,
} from 'lucide-react';
import { useEffect, useRef } from 'react';
import type { ReactNode } from 'react';
import { Navigate, Outlet, useLocation } from 'react-router';
import { ApiError } from '@/lib/api';
import { useSession } from '@/lib/session';
import { EmptyState, LinkButton, SideNav, cx } from '@/ui';
import { AskProvider, useAdminQuery } from './shared';

type Badges = { reports: number; payouts: number; feedback: number; errors: number; emails_failed: number; emails_queued: number; kind_requests: number; blocked_ips: number; inbox_unread: number };

function Count({ n, tone = 'accent', label }: { n: number | undefined; tone?: 'accent' | 'danger' | 'neutral'; label: string }) {
  if (!n) return null;
  return (
    <span
      aria-label={`${n} ${label}`}
      className={cx(
        'ml-1 inline-flex h-5 min-w-5 items-center justify-center rounded-full px-1.5 text-[11px] font-bold tabular-nums',
        tone === 'accent' && 'bg-accent text-accent-ink',
        tone === 'danger' && 'bg-danger text-ink',
        tone === 'neutral' && 'bg-hover text-muted',
      )}
    >
      {n > 99 ? '99+' : n}
    </span>
  );
}

export function AdminLayout() {
  const { user, isStaff } = useSession();
  const loc = useLocation();
  const badges = useAdminQuery<Badges>('/api/admin/badges', undefined, { enabled: isStaff, refetchInterval: 60_000 });

  // On phones the navigation is a sideways scroller: keep the current section in view.
  const navRef = useRef<HTMLElement>(null);
  useEffect(() => {
    navRef.current?.querySelector('a[aria-current="page"]')?.scrollIntoView({ block: 'nearest', inline: 'center' });
  }, [loc.pathname, badges.isSuccess]);
  // Same for a page's own tab strip (settings, security) when the tab comes from the address.
  const bodyRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    bodyRef.current?.querySelector('[role="tab"][aria-selected="true"]')?.scrollIntoView({ block: 'nearest', inline: 'center' });
  }, [loc.pathname, loc.search]);

  if (!user) {
    return (
      <EmptyState icon={<ShieldCheck />} title="Sign in to open the admin panel" action={<LinkButton to={`/login?next=${encodeURIComponent(loc.pathname)}`} variant="primary">Sign in</LinkButton>}>
        This area is for the people who run the site.
      </EmptyState>
    );
  }
  if (!isStaff) {
    return (
      <EmptyState icon={<ShieldCheck />} title="Admins only" action={<LinkButton to="/">Back to the store</LinkButton>}>
        Your account (@{user.username}) does not have admin access. If you should have it, ask a super admin to change your role.
      </EmptyState>
    );
  }

  // With "require two-factor for admins" on, the API refuses everything except enrolment.
  const mfa = badges.error instanceof ApiError && badges.error.code === 'mfa_setup_required';
  const on2fa = loc.pathname.replace(/\/$/, '') === '/admin/security/2fa';
  if (mfa && !on2fa) return <Navigate to="/admin/security/2fa" replace />;

  const b = badges.data;
  const isSuper = user.role === 'super_admin';
  const item = (to: string, label: string, icon: ReactNode, badge?: ReactNode, end?: boolean) => ({ to, label, icon, badge, end });
  const groups = [
    { title: 'Overview', items: [item('/admin', 'Dashboard', <Gauge />, undefined, true)] },
    {
      title: 'Catalog',
      items: [
        item('/admin/series', 'Series', <BookOpen />),
        item('/admin/reports', 'Reports', <Flag />, <Count n={b?.reports} label="open reports" />),
        item('/admin/comments', 'Comments', <MessageSquare />),
      ],
    },
    {
      title: 'People',
      items: [item('/admin/users', 'Users', <Users />), item('/admin/brands', 'Brands', <Store />, <Count n={b?.kind_requests} label="publisher requests" />)],
    },
    {
      title: 'Finance',
      items: [
        item('/admin/orders', 'Orders', <Receipt />),
        item('/admin/memberships', 'Memberships', <Sparkles />),
        ...(isSuper ? [item('/admin/payouts', 'Payouts', <Wallet />, <Count n={b?.payouts} label="payout requests" />), item('/admin/settlement', 'Settlement', <BadgeDollarSign />)] : []),
        item('/admin/tax', 'Creator taxes', <Landmark />),
        item('/admin/codes', 'Codes & gift cards', <Ticket />),
      ],
    },
    {
      title: 'Storefront',
      items: [
        item('/admin/featured', 'Hero & featured', <LayoutTemplate />),
        item('/admin/announcements', 'Announcements', <Megaphone />),
        item('/admin/pages', 'Pages', <FileText />),
        item('/admin/news', 'News', <Newspaper />),
        item('/admin/feedback', 'Feedback', <Inbox />, <Count n={b?.feedback} label="new feedback messages" />),
      ],
    },
    {
      title: 'Communication',
      items: [
        item('/admin/inbox', 'Inbox', <MailOpen />, <Count n={b?.inbox_unread} label="unread emails" />),
        item('/admin/email', 'Email queue & log', <Mail />, <Count n={b?.emails_failed} tone="danger" label="failed emails" />, true),
        item('/admin/email/templates', 'Templates', <CreditCard />),
        item('/admin/email/suppressions', 'Suppressions', <MailX />),
      ],
    },
    {
      title: 'System',
      items: [
        ...(isSuper ? [item('/admin/settings', 'Settings', <Settings />), item('/admin/security', 'Security', <Ban />, <Count n={b?.blocked_ips} tone="neutral" label="blocked addresses" />, true)] : []),
        item('/admin/security/2fa', 'Two-factor sign-in', <KeyRound />),
        item('/admin/audit', 'Audit log', <ScrollText />),
        item('/admin/errors', 'Error log', <Bug />, <Count n={b?.errors} tone="danger" label="unresolved errors" />),
        item('/admin/cron', 'Cron runs', <CalendarClock />),
      ],
    },
  ];

  return (
    <AskProvider>
      <div className="md:grid md:grid-cols-[212px_minmax(0,1fr)] md:gap-8">
        <aside ref={navRef} className="max-md:[&_a]:min-h-10 -mx-4 mb-5 border-b border-line px-4 pb-3 sm:-mx-6 sm:px-6 md:sticky md:top-20 md:mx-0 md:mb-0 md:max-h-[calc(100dvh-6rem)] md:self-start md:overflow-y-auto md:border-0 md:px-0 md:pb-6">
          <div className="mb-3 hidden items-center gap-2 px-2.5 text-xs font-semibold uppercase tracking-wider text-muted md:flex">
            <Activity className="size-4 text-accent" /> Admin
            {!isSuper && <span className="rounded border border-line px-1 text-[10px] normal-case tracking-normal text-faint">limited</span>}
          </div>
          {mfa ? (
            <p className="flex items-center gap-2 px-2.5 text-sm text-muted"><Clock className="size-4" /> The rest of the admin panel unlocks after two-factor setup.</p>
          ) : (
            <SideNav groups={groups} />
          )}
        </aside>
        {/* Phones: lift the kit's compact buttons to a 40px touch target. */}
        <div ref={bodyRef} className="min-w-0 max-md:[&_button:not([role=switch]):not(.underline)]:min-h-10">
          <Outlet />
        </div>
      </div>
    </AskProvider>
  );
}

/** Screens only a super admin can use (the API enforces this too). */
export function SuperOnly({ children }: { children: ReactNode }) {
  const { user } = useSession();
  if (user?.role !== 'super_admin') {
    return (
      <EmptyState icon={<ShieldCheck />} title="Super admins only" action={<LinkButton to="/admin">Back to the dashboard</LinkButton>}>
        Money movements, settings and security are limited to super admins. Your role is admin.
      </EmptyState>
    );
  }
  return <>{children}</>;
}
