import { BadgeCheck, Store, Users as UsersIcon } from 'lucide-react';
import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { api } from '@/lib/api';
import { ago, date, dateTime, moneyExact, number } from '@/lib/format';
import { useSession } from '@/lib/session';
import { Avatar, Badge, Button, DefList, Field, FormRow, Input, Notice, PageHeader, Stat, Table, useConfirm } from '@/ui';
import type { Column } from '@/ui';
import { DataList, FilterBar, FilterSelect, Loaded, SearchInput, Section, StatusBadge, bpsToPct, pctToBps, shortId, useAct, useAdminQuery, useAsk, useFilters, useIsSuper, useList, useTitle } from './shared';
import type { R } from './shared';
import { toast } from '@/ui';

// ---------------------------------------------------------------- users

function userState(u: R) {
  return (
    <span className="flex flex-wrap gap-1">
      {u.deleted_at ? <StatusBadge status="deleted" /> : u.banned_at ? <StatusBadge status="banned" /> : <StatusBadge status="active" />}
      {!u.email_verified_at && !u.deleted_at && <Badge tone="warn">Unverified</Badge>}
      {u.is_member && <Badge tone="accent">Member</Badge>}
    </span>
  );
}

export function UsersPage() {
  useTitle('Users');
  const nav = useNavigate();
  const [f, setF] = useFilters({ q: '', role: '', status: '', member: '', sort: 'newest' });
  const list = useList('/api/admin/users', { q: f.q, role: f.role, status: f.status, member: f.member, sort: f.sort, page: f.page });
  const columns: Column<R>[] = [
    {
      key: 'user', header: 'User',
      cell: (u) => (
        <div className="max-w-[260px]">
          <div className="truncate font-medium">{u.display_name} <span className="font-normal text-muted">@{u.username}</span></div>
          <div className="truncate text-xs text-muted">{u.email}</div>
        </div>
      ),
    },
    { key: 'role', header: 'Role', cell: (u) => (u.role === 'user' ? <span className="text-muted">Reader</span> : <StatusBadge status={u.role} />) },
    { key: 'state', header: 'Status', cell: userState },
    { key: 'brands', header: 'Brands', align: 'right', cell: (u) => u.brand_count || '—', hideOnMobile: true },
    { key: '2fa', header: '2FA', cell: (u) => (u.totp_enabled ? 'On' : <span className="text-faint">Off</span>), hideOnMobile: true },
    { key: 'login', header: 'Last sign-in', cell: (u) => <span className="text-muted">{u.last_login_at ? ago(u.last_login_at) : 'Never'}</span> },
    { key: 'joined', header: 'Joined', cell: (u) => <span className="text-muted">{date(u.created_at)}</span>, hideOnMobile: true },
  ];
  return (
    <>
      <PageHeader title="Users" description="Everyone with an account. Open a user to see their purchases and sign-ins or to act on the account." />
      <FilterBar>
        <SearchInput value={f.q} onChange={(q) => setF({ q })} placeholder="Search by email, username, name, ID or IP address" />
        <FilterSelect label="Role" value={f.role} onChange={(role) => setF({ role })} options={[['', 'Any role'], ['user', 'Readers'], ['admin', 'Admins'], ['super_admin', 'Super admins']]} />
        <FilterSelect label="Status" value={f.status} onChange={(status) => setF({ status })} options={[['', 'Not deleted'], ['active', 'Active'], ['banned', 'Banned'], ['unverified', 'Email not confirmed'], ['locked', 'Locked out'], ['deleted', 'Deleted'], ['all', 'Everyone']]} />
        <FilterSelect label="Membership" value={f.member} onChange={(member) => setF({ member })} options={[['', 'Members and non-members'], ['1', 'Members'], ['0', 'Non-members']]} />
        <FilterSelect label="Sort" value={f.sort} onChange={(sort) => setF({ sort })} options={[['newest', 'Newest first'], ['oldest', 'Oldest first'], ['last_login', 'Recently signed in'], ['email', 'Email A-Z']]} />
      </FilterBar>
      <DataList
        query={list}
        columns={columns}
        onRowClick={(u) => nav(`/admin/users/${u.id}`)}
        onPage={(page) => setF({ page })}
        empty={{ icon: <UsersIcon />, title: 'No users match', hint: 'Try a shorter search or clear the filters.', action: <Button onClick={() => setF({ q: '', role: '', status: '', member: '' })}>Clear filters</Button> }}
      />
    </>
  );
}

export function UserDetail() {
  const { id = '' } = useParams();
  const { user: me, currency } = useSession();
  const isSuper = useIsSuper();
  const nav = useNavigate();
  const ask = useAsk();
  const confirm = useConfirm();
  const { run, busy } = useAct();
  const q = useAdminQuery<R>(`/api/admin/users/${id}`);
  const u: R | undefined = q.data?.user;
  useTitle(u ? `@${u.username}` : 'User');
  const base = `/api/admin/users/${id}`;
  const $ = (c: number) => moneyExact(c, currency);

  const changeRole = async () => {
    const v = await ask({
      title: `Change role for @${u!.username}`,
      body: 'Admins can moderate content and people. Super admins can also move money, change settings and manage staff.',
      fields: [{ name: 'role', label: 'Role', type: 'select', initial: u!.role, options: [{ value: 'user', label: 'Reader (no admin access)' }, { value: 'admin', label: 'Admin' }, { value: 'super_admin', label: 'Super admin' }], required: true }],
      confirmLabel: 'Change role',
    });
    if (v && v.role !== u!.role) void run({ key: 'role', fn: () => api(`${base}/role`, { json: { role: v.role } }), ok: 'Role changed' });
  };
  const ban = async () => {
    const v = await ask({
      title: `Ban @${u!.username}?`,
      body: 'They are signed out everywhere and cannot sign in again until unbanned.',
      fields: [{ name: 'reason', label: 'Reason', type: 'textarea', required: true, minLength: 3, hint: 'Kept in the audit log and shown to other admins.' }],
      confirmLabel: 'Ban user',
      danger: true,
    });
    if (v) void run({ key: 'ban', fn: () => api(`${base}/ban`, { json: { reason: v.reason } }), ok: 'User banned' });
  };
  const simple = async (key: string, title: string, body: string, path: string, ok: string | ((r: R) => string), label = 'Confirm') => {
    if (await confirm({ title, body, confirmLabel: label })) void run({ key, fn: () => api<R>(`${base}/${path}`, { method: 'POST' }), ok });
  };
  const grant = async () => {
    const v = await ask({
      title: 'Grant complimentary membership',
      body: 'Adds free membership time. If they already have a complimentary membership it is extended.',
      fields: [
        { name: 'days', label: 'Days', type: 'number', required: true, initial: '30', min: 1, max: 3650 },
        { name: 'note', label: 'Note', hint: 'Why they are getting it. Saved in the audit log.' },
      ],
      confirmLabel: 'Grant membership',
    });
    if (v) void run({ key: 'grant', fn: () => api<R>(`${base}/grant-membership`, { json: { days: v.days, note: v.note } }), ok: (r) => `Membership runs until ${date(r.current_period_end)}` });
  };
  const wallet = async () => {
    const v = await ask({
      title: 'Adjust wallet',
      body: 'Add or remove store credit and page credits. The balance cannot go below zero.',
      fields: [
        { name: 'direction', label: 'Direction', type: 'select', initial: 'add', options: [{ value: 'add', label: 'Add to the wallet' }, { value: 'remove', label: 'Remove from the wallet' }] },
        { name: 'credit_cents', label: 'Store credit', type: 'money' },
        { name: 'page_credits', label: 'Page credits', type: 'number', min: 0, max: 100000 },
        { name: 'note', label: 'Note', type: 'textarea', required: true, minLength: 3, hint: 'Explain the adjustment. Saved with the wallet history.' },
      ],
      confirmLabel: 'Apply adjustment',
    });
    if (!v) return;
    const sign = v.direction === 'remove' ? -1 : 1;
    if (!v.credit_cents && !v.page_credits) return void toast.error('Enter an amount of store credit or page credits.');
    void run({ key: 'wallet', fn: () => api(`${base}/wallet`, { json: { credit_cents: sign * (v.credit_cents ?? 0), page_credits: sign * (v.page_credits ?? 0), note: v.note } }), ok: 'Wallet adjusted' });
  };
  const remove = async () => {
    const v = await ask({
      title: `Delete @${u!.username}?`,
      body: 'The account is closed and signed out. Purchases and comments stay on record. A deleted account can be restored unless you also scrub it.',
      fields: [
        { name: 'anonymise', label: 'Also scrub personal details', type: 'checkbox', hint: 'Replaces the email, username, name, bio and avatar. This cannot be undone.' },
        { name: 'reason', label: 'Reason' },
      ],
      confirmLabel: 'Delete account',
      danger: true,
    });
    if (v) void run({ key: 'delete', fn: () => api(base, { method: 'DELETE', json: { anonymise: v.anonymise, reason: v.reason } }), ok: 'Account deleted', onDone: () => v.anonymise && nav('/admin/users') });
  };
  const reset2fa = async () => {
    if (await confirm({ title: 'Reset two-factor sign-in?', body: 'Use this when they have lost their authenticator. They are signed out and can sign in with just their password until they set it up again.', confirmLabel: 'Reset 2FA', danger: true })) {
      void run({ key: '2fa', fn: () => api(`/api/admin/security/2fa/reset/${id}`, { method: 'POST' }), ok: 'Two-factor sign-in reset' });
    }
  };

  return (
    <Loaded query={q}>
      {(d) => {
        const user = d.user as R;
        const isSelf = me?.id === user.id;
        const staffLocked = user.role !== 'user' && !isSuper;
        const canModerate = !isSelf && !staffLocked;
        return (
          <>
            <PageHeader
              back={<Link to="/admin/users" className="hover:text-paper">← Users</Link>}
              title={<span className="flex items-center gap-3"><Avatar src={user.avatar_url} name={user.display_name} size={44} />{user.display_name}</span>}
              description={<>@{user.username} · {user.email} · joined {date(user.created_at)}</>}
              actions={userState({ ...user, is_member: d.membership.active })}
            />
            {user.banned_at && <div className="mb-4"><Notice tone="danger">Banned {ago(user.banned_at)}. Reason: {user.ban_reason || 'none given'}</Notice></div>}
            {user.deleted_at && <div className="mb-4"><Notice tone="danger">This account was deleted {ago(user.deleted_at)}.</Notice></div>}
            {isSelf && <div className="mb-4"><Notice>This is your own account. Role changes, bans and deletion have to be done by another super admin.</Notice></div>}
            {staffLocked && !isSelf && <div className="mb-4"><Notice>This is a staff account. Only a super admin can change it.</Notice></div>}

            <div className="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
              <Stat label="Spent" value={$(d.stats.spent_cents)} hint={`${number(d.stats.owned_releases)} releases owned`} />
              <Stat label="Store credit" value={$(d.wallet.credit_cents)} hint={`${number(d.wallet.page_credits)} page credits`} />
              <Stat label="Comments" value={number(d.stats.comments)} hint={`${number(d.stats.follows)} follows`} />
              <Stat label="Reports against" value={number(d.stats.reports_against)} />
            </div>

            <div className="flex flex-col gap-5">
              <div className="min-w-0 space-y-5">
                <Section title="Profile">
                  <DefList
                    items={[
                      ['User ID', <span className="break-all font-mono text-xs">{user.id}</span>],
                      ['Role', user.role === 'user' ? 'Reader' : <StatusBadge status={user.role} />],
                      ['Email', <>{user.email} {user.email_verified_at ? <span className="text-muted">(confirmed {date(user.email_verified_at)})</span> : <Badge tone="warn">Not confirmed</Badge>}</>],
                      ['Emails', user.email_unsubscribed_at ? `Unsubscribed ${date(user.email_unsubscribed_at)}` : user.marketing_opt_in ? 'Newsletter and notifications' : 'Notifications only'],
                      ['Two-factor', user.totp_enabled ? 'On' : 'Off'],
                      ['Last sign-in', user.last_login_at ? `${dateTime(user.last_login_at)} from ${user.last_ip ?? 'unknown address'}` : 'Never'],
                      ['Failed sign-ins', user.locked_until && Date.parse(user.locked_until) > Date.now() ? `${user.failed_logins}, locked until ${dateTime(user.locked_until)}` : String(user.failed_logins)],
                      ['Bio', user.bio || <span className="text-faint">None</span>],
                    ]}
                  />
                </Section>

                <Section title="Membership" description={d.membership.active ? `Active until ${date(d.membership.current.current_period_end)}${d.membership.current.provider === 'grant' ? ' (complimentary)' : ''}` : 'Not a member right now.'}>
                  <Table
                    rowKey={(r: R) => r.id}
                    rows={d.membership.history}
                    empty="No membership history"
                    columns={[
                      { key: 'plan', header: 'Plan', cell: (s: R) => (s.provider === 'grant' ? 'Complimentary' : s.plan) },
                      { key: 'status', header: 'Status', cell: (s: R) => <StatusBadge status={s.status} /> },
                      { key: 'price', header: 'Price', align: 'right', cell: (s: R) => $(s.price_cents) },
                      { key: 'period', header: 'Period', cell: (s: R) => `${date(s.current_period_start)} to ${date(s.current_period_end)}` },
                      { key: 'renew', header: 'Renews', cell: (s: R) => (s.cancel_at_period_end ? 'No' : 'Yes') },
                    ]}
                  />
                </Section>

                <Section title="Brands">
                  <Table
                    rowKey={(r: R) => r.id}
                    rows={d.brands}
                    empty="Not a member of any brand"
                    columns={[
                      { key: 'name', header: 'Brand', cell: (b: R) => <Link className="link" to={`/admin/brands/${b.id}`}>{b.name}</Link> },
                      { key: 'kind', header: 'Type', cell: (b: R) => b.kind },
                      { key: 'role', header: 'Their role', cell: (b: R) => b.role },
                      { key: 'state', header: 'Status', cell: (b: R) => (b.suspended_at ? <StatusBadge status="suspended" /> : b.verified_at ? <StatusBadge status="verified" /> : <span className="text-muted">Active</span>) },
                    ]}
                  />
                </Section>

                <Section title="Orders" description="The 25 most recent.">
                  <Table
                    rowKey={(r: R) => r.id}
                    rows={d.orders}
                    empty="No orders"
                    onRowClick={(o: R) => nav(`/admin/orders/${o.id}`)}
                    columns={[
                      { key: 'when', header: 'Date', cell: (o: R) => dateTime(o.created_at) },
                      { key: 'what', header: 'Items', cell: (o: R) => <span className="block max-w-[280px] truncate">{o.summary ?? '—'}</span> },
                      { key: 'status', header: 'Status', cell: (o: R) => <StatusBadge status={o.status} /> },
                      { key: 'total', header: 'Total', align: 'right', cell: (o: R) => $(o.total_cents) },
                    ]}
                  />
                </Section>

                <Section title="Wallet history">
                  <Table
                    rowKey={(r: R) => r.id}
                    rows={d.wallet_log}
                    empty="No wallet activity"
                    columns={[
                      { key: 'when', header: 'Date', cell: (w: R) => dateTime(w.created_at) },
                      { key: 'kind', header: 'Type', cell: (w: R) => String(w.kind).replace(/_/g, ' ') },
                      { key: 'credit', header: 'Store credit', align: 'right', cell: (w: R) => (w.credit_cents ? $(w.credit_cents) : '—') },
                      { key: 'pages', header: 'Page credits', align: 'right', cell: (w: R) => w.page_credits || '—' },
                      { key: 'note', header: 'Note', cell: (w: R) => <span className="block max-w-[260px] truncate text-muted" title={w.note}>{w.note}</span> },
                    ]}
                  />
                </Section>

                <Section title="Signed-in devices" description={`${d.sessions.length} active ${d.sessions.length === 1 ? 'session' : 'sessions'}.`}>
                  <Table
                    rowKey={(r: R) => `${r.created_at}${r.ip}`}
                    rows={d.sessions}
                    empty="Not signed in anywhere"
                    columns={[
                      { key: 'ip', header: 'IP address', cell: (s: R) => <span className="font-mono text-xs">{s.ip}</span> },
                      { key: 'ua', header: 'Browser', cell: (s: R) => <span className="block max-w-[300px] truncate text-muted" title={s.user_agent}>{s.user_agent}</span> },
                      { key: 'seen', header: 'Last seen', cell: (s: R) => ago(s.last_seen_at) },
                      { key: 'since', header: 'Signed in', cell: (s: R) => date(s.created_at) },
                    ]}
                  />
                </Section>

                <Section title="Sign-in attempts" description="The 25 most recent.">
                  <Table
                    rowKey={(r: R) => r.id}
                    rows={d.logins}
                    empty="No sign-in attempts recorded"
                    columns={[
                      { key: 'when', header: 'When', cell: (l: R) => dateTime(l.created_at) },
                      { key: 'ok', header: 'Result', cell: (l: R) => (l.success ? <Badge tone="ok">Signed in</Badge> : <Badge tone="danger">{String(l.reason ?? 'failed').replace(/_/g, ' ')}</Badge>) },
                      { key: 'ip', header: 'IP address', cell: (l: R) => <span className="font-mono text-xs">{l.ip}</span> },
                      { key: 'ua', header: 'Browser', cell: (l: R) => <span className="block max-w-[260px] truncate text-muted" title={l.user_agent}>{l.user_agent}</span> },
                    ]}
                  />
                </Section>
              </div>

              <aside className="order-first">
                <Section title="Actions">
                  <div className="flex flex-wrap gap-2">
                    {!user.email_verified_at && !user.deleted_at && (
                      <Button loading={busy === 'verify'} onClick={() => simple('verify', 'Mark email as confirmed?', `Treat ${user.email} as confirmed without the user clicking the link.`, 'verify-email', 'Email marked as confirmed')}>Confirm email</Button>
                    )}
                    <Button loading={busy === 'grant'} disabled={Boolean(user.deleted_at)} onClick={grant}>Grant membership days</Button>
                    {isSuper && <Button loading={busy === 'wallet'} onClick={wallet}>Adjust wallet</Button>}
                    <Button loading={busy === 'logout'} disabled={!isSelf && staffLocked} onClick={() => simple('logout', 'Sign this user out everywhere?', isSelf ? 'Your other devices are signed out. This one stays signed in.' : 'Every device is signed out. They can sign in again with their password.', 'logout', (r) => `${r.sessions_ended} ${r.sessions_ended === 1 ? 'session' : 'sessions'} ended`, 'Sign out')}>Force sign-out</Button>
                    {isSuper && !isSelf && <Button loading={busy === 'role'} disabled={Boolean(user.deleted_at)} onClick={changeRole}>Change role</Button>}
                    {isSuper && !isSelf && user.totp_enabled && <Button loading={busy === '2fa'} onClick={reset2fa}>Reset two-factor</Button>}
                    {canModerate && !user.deleted_at && (
                      user.banned_at
                        ? <Button loading={busy === 'unban'} onClick={() => simple('unban', `Unban @${user.username}?`, 'They can sign in again straight away.', 'unban', 'User unbanned', 'Unban')}>Unban</Button>
                        : <Button variant="danger" loading={busy === 'ban'} onClick={ban}>Ban user</Button>
                    )}
                    {canModerate && (
                      user.deleted_at
                        ? <Button loading={busy === 'restore'} onClick={() => simple('restore', 'Restore this account?', 'The account becomes usable again.', 'restore', 'Account restored', 'Restore')}>Restore account</Button>
                        : <Button variant="danger" loading={busy === 'delete'} onClick={remove}>Delete account</Button>
                    )}
                  </div>
                </Section>
              </aside>
            </div>
          </>
        );
      }}
    </Loaded>
  );
}

// ---------------------------------------------------------------- brands

function brandState(b: R) {
  return (
    <span className="flex flex-wrap gap-1">
      {b.deleted_at && <StatusBadge status="deleted" />}
      {b.suspended_at && <StatusBadge status="suspended" />}
      {b.verified_at && <Badge tone="ok"><BadgeCheck className="size-3" />Verified</Badge>}
      {b.kind_requested && <Badge tone="warn">Wants: {b.kind_requested}</Badge>}
      {!b.deleted_at && !b.suspended_at && !b.verified_at && !b.kind_requested && <span className="text-muted">Active</span>}
    </span>
  );
}

export function BrandsPage() {
  useTitle('Brands');
  const nav = useNavigate();
  const { currency } = useSession();
  const [f, setF] = useFilters({ q: '', kind: '', status: '', sort: '' });
  const list = useList('/api/admin/brands', { q: f.q, kind: f.kind, status: f.status, sort: f.sort, page: f.page });
  const columns: Column<R>[] = [
    {
      key: 'brand', header: 'Brand',
      cell: (b) => (
        <span className="flex items-center gap-3">
          <Avatar src={b.avatar_url} name={b.name} size={36} square />
          <span className="min-w-0 max-w-[220px]"><span className="block truncate font-medium">{b.name}</span><span className="block truncate text-xs text-muted">/{b.slug}</span></span>
        </span>
      ),
    },
    { key: 'kind', header: 'Type', cell: (b) => <span className="capitalize">{b.kind}</span> },
    { key: 'state', header: 'Status', cell: brandState },
    { key: 'series', header: 'Series', align: 'right', cell: (b) => number(b.series_count) },
    { key: 'members', header: 'Team', align: 'right', cell: (b) => number(b.member_count), hideOnMobile: true },
    { key: 'balance', header: 'Balance', align: 'right', cell: (b) => moneyExact(b.balance_cents, currency) },
    { key: 'created', header: 'Created', cell: (b) => <span className="text-muted">{date(b.created_at)}</span>, hideOnMobile: true },
  ];
  return (
    <>
      <PageHeader title="Brands" description="Creator and publisher pages. Verify them, review requests to become a publisher, and manage their earnings." />
      <FilterBar>
        <SearchInput value={f.q} onChange={(q) => setF({ q })} placeholder="Search by brand name or address" />
        <FilterSelect label="Type" value={f.kind} onChange={(kind) => setF({ kind })} options={[['', 'Creators and publishers'], ['creator', 'Creators'], ['publisher', 'Publishers']]} />
        <FilterSelect label="Status" value={f.status} onChange={(status) => setF({ status })} options={[['', 'Any status'], ['kind_requested', 'Waiting for a decision'], ['verified', 'Verified'], ['unverified', 'Not verified'], ['suspended', 'Suspended'], ['deleted', 'Deleted']]} />
        <FilterSelect label="Sort" value={f.sort} onChange={(sort) => setF({ sort })} options={[['', 'Newest first'], ['name', 'Name A-Z'], ['balance', 'Highest balance']]} />
      </FilterBar>
      <DataList
        query={list}
        columns={columns}
        onRowClick={(b) => nav(`/admin/brands/${b.id}`)}
        onPage={(page) => setF({ page })}
        empty={{ icon: <Store />, title: 'No brands match', hint: 'Brands appear here when someone starts publishing. Try clearing the filters.', action: <Button onClick={() => setF({ q: '', kind: '', status: '' })}>Clear filters</Button> }}
      />
    </>
  );
}

function ShareForm({ id, brand, shares }: { id: string; brand: R; shares: R }) {
  const { run, busy } = useAct();
  const [v, setV] = useState({ sale: bpsToPct(brand.sale_share_bps), sub: bpsToPct(brand.sub_share_bps), tip: bpsToPct(brand.tip_share_bps) });
  const save = () => {
    const body = { sale_share_bps: pctToBps(v.sale), sub_share_bps: pctToBps(v.sub), tip_share_bps: pctToBps(v.tip) };
    for (const n of Object.values(body)) if (n !== null && (Number.isNaN(n) || n < 0 || n > 10000)) return void toast.error('Shares are percentages between 0 and 100.');
    void run({ key: 'shares', fn: () => api(`/api/admin/brands/${id}/shares`, { method: 'PATCH', json: body }), ok: 'Revenue shares saved' });
  };
  const field = (key: 'sale' | 'sub' | 'tip', label: string, def: number) => (
    <Field label={label} hint={v[key].trim() ? `Platform default is ${def / 100}%` : `Using the platform default of ${def / 100}%`}>
      <span className="relative block">
        <Input inputMode="decimal" value={v[key]} placeholder={String(def / 100)} onChange={(e) => setV({ ...v, [key]: e.target.value })} className="pr-8" />
        <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-sm text-muted">%</span>
      </span>
    </Field>
  );
  return (
    <Section title="Revenue share" description="The part of each payment this brand keeps, after processing fees. Leave a box empty to use the platform default." actions={<Button loading={busy === 'shares'} onClick={save}>Save shares</Button>}>
      <FormRow cols={3}>
        {field('sale', 'Sales', shares.defaults.sale_share_bps)}
        {field('sub', 'Membership reads', shares.defaults.sub_share_bps)}
        {field('tip', 'Tips', shares.defaults.tip_share_bps)}
      </FormRow>
    </Section>
  );
}

function Ledger({ id }: { id: string }) {
  const { currency } = useSession();
  const [page, setPage] = useState(1);
  const [kind, setKind] = useState('');
  const list = useList(`/api/admin/brands/${id}/ledger`, { page, kind, limit: 25 });
  const $ = (c: number) => moneyExact(c, currency);
  return (
    <>
      <FilterBar>
        <FilterSelect label="Entry type" value={kind} onChange={(k) => { setKind(k); setPage(1); }} options={[['', 'All entries'], ['sale', 'Sales'], ['subscription', 'Membership reads'], ['tip', 'Tips'], ['payout', 'Payouts'], ['refund', 'Refunds'], ['adjustment', 'Adjustments']]} />
      </FilterBar>
      <DataList
        query={list}
        onPage={setPage}
        empty={{ title: 'No ledger entries', hint: 'Earnings, payouts and adjustments for this brand are listed here as they happen.' }}
        columns={[
          { key: 'when', header: 'Date', cell: (l) => dateTime(l.created_at) },
          { key: 'kind', header: 'Type', cell: (l) => <span className="capitalize">{l.kind === 'subscription' ? 'membership' : l.kind}</span> },
          { key: 'what', header: 'Detail', cell: (l) => <span className="block max-w-[300px] truncate text-muted" title={l.note ?? ''}>{l.series_title ?? l.note ?? (l.order_id ? `Order ${shortId(l.order_id)}` : '—')}</span> },
          { key: 'gross', header: 'Reader paid', align: 'right', cell: (l) => (l.gross_cents ? $(l.gross_cents) : '—'), hideOnMobile: true },
          { key: 'amount', header: 'Amount', align: 'right', cell: (l) => <span className={l.amount_cents < 0 ? 'text-danger' : 'text-ok'}>{$(l.amount_cents)}</span> },
          { key: 'avail', header: 'Available', cell: (l) => (l.available_at && Date.parse(l.available_at) > Date.now() ? <span className="text-warn">{date(l.available_at)}</span> : <span className="text-muted">Now</span>), hideOnMobile: true },
        ]}
      />
    </>
  );
}

export function BrandDetail() {
  const { id = '' } = useParams();
  const { currency } = useSession();
  const isSuper = useIsSuper();
  const ask = useAsk();
  const confirm = useConfirm();
  const nav = useNavigate();
  const { run, busy } = useAct();
  const q = useAdminQuery<R>(`/api/admin/brands/${id}`);
  useTitle(q.data?.brand?.name ?? 'Brand');
  const base = `/api/admin/brands/${id}`;
  const $ = (c: number) => moneyExact(c, currency);

  const decide = async (b: R, approve: boolean) => {
    const v = await ask({
      title: approve ? `Make ${b.name} a ${b.kind_requested} page?` : `Turn down the request from ${b.name}?`,
      body: 'The brand owners are told by email and in their notifications.',
      fields: [{ name: 'note', label: 'Message to the brand', type: 'textarea', hint: approve ? 'Optional.' : 'Optional, but a short explanation helps.' }],
      confirmLabel: approve ? 'Approve' : 'Turn down',
      danger: !approve,
    });
    if (v) void run({ key: approve ? 'approve' : 'deny', fn: () => api(`${base}/kind-request`, { json: { approve, note: v.note } }), ok: approve ? 'Request approved' : 'Request turned down' });
  };
  const suspend = async (b: R) => {
    const v = await ask({
      title: `Suspend ${b.name}?`,
      body: 'The brand owners are told why. Payouts cannot be approved while a brand is suspended.',
      fields: [{ name: 'reason', label: 'Reason', type: 'textarea', required: true, minLength: 3, hint: 'Sent to the brand owners.' }],
      confirmLabel: 'Suspend brand',
      danger: true,
    });
    if (v) void run({ key: 'suspend', fn: () => api(`${base}/suspend`, { json: { reason: v.reason } }), ok: 'Brand suspended' });
  };
  const adjust = async () => {
    const v = await ask({
      title: 'Adjust brand balance',
      body: 'Adds a manual entry to the ledger. The balance cannot go below zero.',
      fields: [
        { name: 'direction', label: 'Direction', type: 'select', initial: 'credit', options: [{ value: 'credit', label: 'Credit (add money)' }, { value: 'debit', label: 'Debit (take money away)' }] },
        { name: 'amount', label: 'Amount', type: 'money', required: true },
        { name: 'note', label: 'Note', type: 'textarea', required: true, minLength: 3, hint: 'Shown on the ledger entry.' },
      ],
      confirmLabel: 'Add entry',
    });
    if (!v) return;
    if (!v.amount) return void toast.error('Enter an amount other than zero.');
    void run({ key: 'adjust', fn: () => api(`${base}/ledger`, { json: { amount_cents: v.direction === 'debit' ? -v.amount : v.amount, note: v.note } }), ok: 'Ledger entry added' });
  };

  return (
    <Loaded query={q}>
      {(d) => {
        const b = d.brand as R;
        return (
          <>
            <PageHeader
              back={<Link to="/admin/brands" className="hover:text-paper">← Brands</Link>}
              title={<span className="flex items-center gap-3"><Avatar src={b.avatar_url} name={b.name} size={44} square />{b.name}</span>}
              description={<><span className="capitalize">{b.kind}</span> page · /{b.slug} · created {date(b.created_at)}{b.country ? ` · ${b.country}` : ''}</>}
              actions={
                <>
                  {brandState(b)}
                  <Button size="sm" loading={busy === 'verify'} onClick={async () => {
                    const verified = !b.verified_at;
                    if (await confirm({ title: verified ? `Verify ${b.name}?` : `Remove the verified mark from ${b.name}?`, body: verified ? 'Readers see a verified mark on the brand.' : 'Readers no longer see the verified mark.', confirmLabel: verified ? 'Verify' : 'Remove mark' })) {
                      void run({ key: 'verify', fn: () => api(`${base}/verify`, { json: { verified } }), ok: verified ? 'Brand verified' : 'Verified mark removed' });
                    }
                  }}>{b.verified_at ? 'Remove verified mark' : 'Verify'}</Button>
                  {b.suspended_at ? (
                    <Button size="sm" loading={busy === 'unsuspend'} onClick={async () => {
                      if (await confirm({ title: `Lift the suspension on ${b.name}?`, body: 'The brand owners are told it is active again.', confirmLabel: 'Lift suspension' })) void run({ key: 'unsuspend', fn: () => api(`${base}/unsuspend`, { method: 'POST' }), ok: 'Suspension lifted' });
                    }}>Lift suspension</Button>
                  ) : (
                    <Button size="sm" variant="danger" loading={busy === 'suspend'} onClick={() => suspend(b)}>Suspend</Button>
                  )}
                </>
              }
            />
            {b.suspended_at && <div className="mb-4"><Notice tone="danger">Suspended {ago(b.suspended_at)}. Reason: {b.suspend_reason || 'none given'}</Notice></div>}
            {b.kind_requested && (
              <div className="mb-4">
                <Notice
                  tone="warn"
                  action={
                    <span className="flex gap-2">
                      <Button size="sm" variant="primary" loading={busy === 'approve'} onClick={() => decide(b, true)}>Approve</Button>
                      <Button size="sm" loading={busy === 'deny'} onClick={() => decide(b, false)}>Turn down</Button>
                    </span>
                  }
                >
                  This {b.kind} page has asked to become a <strong>{b.kind_requested}</strong> page.
                </Notice>
              </div>
            )}

            <div className="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
              <Stat label="Balance" value={$(d.balance.balance_cents)} />
              <Stat label="Available to pay out" value={$(d.balance.available_cents)} hint={`${$(d.balance.pending_cents)} still on hold`} />
              <Stat label="Earned from sales" value={$(d.earned_by_kind.sale ?? 0)} hint={`${$(d.earned_by_kind.tip ?? 0)} in tips`} />
              <Stat label="Earned from members" value={$(d.earned_by_kind.subscription ?? 0)} hint={`${$(-(d.earned_by_kind.payout ?? 0))} paid out so far`} />
            </div>

            <div className="space-y-5">
              {isSuper && <ShareForm key={`${b.sale_share_bps}-${b.sub_share_bps}-${b.tip_share_bps}`} id={id} brand={b} shares={d.shares} />}
              {!isSuper && (
                <Section title="Revenue share">
                  <p className="text-sm text-muted">Sales {d.shares.effective.sale_share_bps / 100}%, membership reads {d.shares.effective.sub_share_bps / 100}%, tips {d.shares.effective.tip_share_bps / 100}%. Only a super admin can change these.</p>
                </Section>
              )}

              <Section title="Team">
                <Table
                  rowKey={(r: R) => r.id}
                  rows={d.members}
                  empty="No team members"
                  onRowClick={(m: R) => nav(`/admin/users/${m.id}`)}
                  columns={[
                    { key: 'who', header: 'Person', cell: (m: R) => <>{m.display_name} <span className="text-muted">@{m.username}</span></> },
                    { key: 'email', header: 'Email', cell: (m: R) => <span className="text-muted">{m.email}</span> },
                    { key: 'role', header: 'Role', cell: (m: R) => <span className="capitalize">{m.role}</span> },
                    { key: 'since', header: 'Since', cell: (m: R) => date(m.created_at), hideOnMobile: true },
                  ]}
                />
              </Section>

              <Section title="Series" actions={<Link className="link text-sm" to={`/admin/series?q=${encodeURIComponent(b.name)}`}>Moderate these series</Link>}>
                <Table
                  rowKey={(r: R) => r.id}
                  rows={d.series}
                  empty="This brand has not created a series yet"
                  columns={[
                    { key: 'title', header: 'Title', cell: (s: R) => <Link className="link" to={`/series/${s.slug}`}>{s.title}</Link> },
                    { key: 'vis', header: 'Visibility', cell: (s: R) => (s.takedown_at ? <StatusBadge status="taken down" /> : <StatusBadge status={s.visibility} />) },
                    { key: 'access', header: 'Access', cell: (s: R) => <span className="capitalize">{s.access_model}</span> },
                    { key: 'followers', header: 'Followers', align: 'right', cell: (s: R) => number(s.follower_count) },
                    { key: 'reads', header: 'Reads', align: 'right', cell: (s: R) => number(s.read_count) },
                  ]}
                />
              </Section>

              <Section title="Recent payouts" description={b.payout_method ? `Payout method on file: ${b.payout_method}` : 'No payout method on file.'} actions={isSuper ? <Link className="link text-sm" to="/admin/payouts?status=all">All payouts</Link> : undefined}>
                <Table
                  rowKey={(r: R) => r.id}
                  rows={d.payouts}
                  empty="No payouts requested yet"
                  columns={[
                    { key: 'when', header: 'Requested', cell: (p: R) => date(p.created_at) },
                    { key: 'amount', header: 'Amount', align: 'right', cell: (p: R) => $(p.amount_cents) },
                    { key: 'status', header: 'Status', cell: (p: R) => <StatusBadge status={p.status} /> },
                    { key: 'method', header: 'Method', cell: (p: R) => p.method },
                    { key: 'ref', header: 'Reference', cell: (p: R) => p.reference ?? '—' },
                  ]}
                />
              </Section>

              <Section title="Ledger" description="Every credit and debit that makes up the balance." actions={isSuper ? <Button loading={busy === 'adjust'} onClick={adjust}>Manual adjustment</Button> : undefined}>
                <Ledger id={id} />
              </Section>
            </div>
          </>
        );
      }}
    </Loaded>
  );
}
