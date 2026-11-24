import { Gift, Receipt, Sparkles, Ticket, Wallet } from 'lucide-react';
import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { ApiError, api } from '@/lib/api';
import { ago, date, dateTime, moneyExact, number } from '@/lib/format';
import { useSession } from '@/lib/session';
import {
  Badge, Button, Checkbox, DefList, Field, FormRow, Input, Modal, MoneyInput, Notice, PageHeader, Segmented, Select, Stat, Table, Tabs, Textarea, toast, useConfirm,
} from '@/ui';
import type { Column } from '@/ui';
import { SuperOnly } from './AdminLayout';
import {
  CopyButton, DataList, FilterBar, FilterSelect, Loaded, Mono, SearchInput, Section, StatusBadge, fromLocalInput, shortId, useAct, useAdminQuery, useAsk, useFilters,
  useIsSuper, useList, useTitle,
} from './shared';
import type { R } from './shared';

function useMoney() {
  const { currency } = useSession();
  return (c: number | null | undefined) => moneyExact(c, currency);
}

// ---------------------------------------------------------------- orders

export function OrdersPage() {
  useTitle('Orders');
  const nav = useNavigate();
  const $ = useMoney();
  const [f, setF] = useFilters({ q: '', status: '', provider: '', from: '', to: '' });
  const list = useList<{ paid_cents: number }>('/api/admin/orders', { q: f.q, status: f.status, provider: f.provider, from: f.from, to: f.to ? `${f.to}T23:59:59` : '', page: f.page });
  const columns: Column<R>[] = [
    { key: 'when', header: 'Date', cell: (o) => dateTime(o.created_at) },
    { key: 'who', header: 'Buyer', cell: (o) => <span className="block max-w-[200px] truncate">{o.email}</span> },
    { key: 'what', header: 'Items', cell: (o) => <span className="block max-w-[260px] truncate text-muted" title={o.summary ?? ''}>{o.item_count > 1 ? `${o.item_count} items: ` : ''}{o.summary ?? '—'}</span> },
    { key: 'status', header: 'Status', cell: (o) => <StatusBadge status={o.status} /> },
    { key: 'provider', header: 'Paid with', cell: (o) => <span className="capitalize text-muted">{o.provider}</span>, hideOnMobile: true },
    { key: 'total', header: 'Total', align: 'right', cell: (o) => $(o.total_cents) },
  ];
  return (
    <>
      <PageHeader title="Orders" description="Store purchases. Open an order to see where the money went or to refund it." />
      <FilterBar>
        <SearchInput value={f.q} onChange={(q) => setF({ q })} placeholder="Search by buyer email, username, order ID or payment reference" />
        <FilterSelect label="Status" value={f.status} onChange={(status) => setF({ status })} options={[['', 'Any status'], ['paid', 'Paid'], ['pending', 'Pending'], ['failed', 'Failed'], ['refunded', 'Refunded']]} />
        <FilterSelect label="Paid with" value={f.provider} onChange={(provider) => setF({ provider })} options={[['', 'Any processor'], ['divinity', 'Divinity payments'], ['sandbox', 'Sandbox'], ['wallet', 'Store credit']]} />
        <span className="flex items-center gap-2 text-sm text-muted">
          <Input type="date" aria-label="From date" value={f.from} onChange={(e) => setF({ from: e.target.value })} className="w-auto" />
          to
          <Input type="date" aria-label="To date" value={f.to} onChange={(e) => setF({ to: e.target.value })} className="w-auto" />
        </span>
      </FilterBar>
      {list.data && list.data.total > 0 && <p className="mb-3 text-sm text-muted">{number(list.data.total)} {list.data.total === 1 ? 'order' : 'orders'} match, {$(list.data.paid_cents)} paid.</p>}
      <DataList
        query={list}
        columns={columns}
        onRowClick={(o) => nav(`/admin/orders/${o.id}`)}
        onPage={(page) => setF({ page })}
        empty={{ icon: <Receipt />, title: 'No orders match', hint: 'Orders appear here when readers buy releases, credits or gift cards. Try clearing the filters.', action: <Button onClick={() => setF({ q: '', status: '', provider: '', from: '', to: '' })}>Clear filters</Button> }}
      />
    </>
  );
}

export function OrderDetail() {
  const { id = '' } = useParams();
  const $ = useMoney();
  const ask = useAsk();
  const confirm = useConfirm();
  const { run, busy } = useAct();
  const q = useAdminQuery<R>(`/api/admin/orders/${id}`);
  useTitle(`Order ${shortId(id)}`);

  const refund = async (o: R) => {
    const v = await ask({
      title: `Refund ${$(o.total_cents)}?`,
      body: 'The buyer loses access to what they bought and the creators\' earnings from this order are reversed.',
      fields: [
        { name: 'to', label: 'Send the money', type: 'select', initial: 'provider', options: [{ value: 'provider', label: 'Back to the original payment method' }, { value: 'wallet', label: 'To the buyer\'s store credit' }] },
        { name: 'reason', label: 'Reason', type: 'textarea', required: true, minLength: 3 },
      ],
      confirmLabel: 'Refund order',
      danger: true,
    });
    if (!v) return;
    const send = (extra: R = {}) =>
      run({
        key: 'refund',
        fn: () => api<R>(`/api/admin/orders/${id}/refund`, { json: { reason: v.reason, to_wallet: v.to === 'wallet', ...extra } }),
        ok: (r) => (r.method === 'wallet' ? 'Refunded as store credit' : r.method === 'recorded' ? 'Refund recorded' : 'Order refunded'),
        onDone: (r) => (r.warnings as string[]).forEach((w) => toast.warning(w, { duration: 12_000 })),
        quietError: (e) => {
          if (!(e instanceof ApiError && e.code === 'provider_refund_unavailable')) return false;
          void confirm({ title: 'Refund it at the processor first', body: `${e.message} Only continue if the money has already been returned there.`, confirmLabel: 'I have refunded it there', danger: true }).then((yes) => { if (yes) void send({ provider_refunded: true }); });
          return true;
        },
      });
    void send();
  };

  return (
    <Loaded query={q}>
      {(d) => {
        const o = d.order as R;
        return (
          <>
            <PageHeader
              back={<Link to="/admin/orders" className="hover:text-paper">← Orders</Link>}
              title={<>Order <Mono>{shortId(o.id)}</Mono></>}
              description={<>{dateTime(o.created_at)} · <Link className="link" to={`/admin/users/${o.user_id}`}>{o.display_name} (@{o.username})</Link></>}
              actions={
                <>
                  <StatusBadge status={o.status} />
                  {o.status === 'paid' && <Button variant="danger" loading={busy === 'refund'} onClick={() => refund(o)}>Refund</Button>}
                </>
              }
            />
            <div className="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
              <Stat label="Total" value={$(o.total_cents)} hint={o.discount_cents ? `${$(o.discount_cents)} discount${o.discount_code ? ` (${o.discount_code})` : ''}` : undefined} />
              <Stat label="Processing fee" value={$(o.fee_cents)} />
              <Stat label="To creators" value={$(d.items.reduce((a: number, i: R) => a + (i.creator_cents ?? 0), 0))} />
              <Stat label="Paid with credit" value={$(o.credit_cents ?? 0)} />
            </div>
            <div className="space-y-5">
              <Section title="Details">
                <DefList
                  items={[
                    ['Order ID', <span className="break-all font-mono text-xs">{o.id}</span>],
                    ['Buyer email', o.email],
                    ['Processor', <span className="capitalize">{o.provider}</span>],
                    ['Payment reference', o.provider_ref ? <span className="break-all font-mono text-xs">{o.provider_ref}</span> : '—'],
                    ['Paid', o.paid_at ? dateTime(o.paid_at) : 'Not paid'],
                    ...(o.refunded_at ? [['Refunded', dateTime(o.refunded_at)] as [string, string]] : []),
                  ]}
                />
              </Section>
              <Section title="Items">
                <Table
                  rowKey={(r: R) => r.id}
                  rows={d.items}
                  empty="This order has no items"
                  columns={[
                    { key: 'desc', header: 'Item', cell: (i: R) => <span className="block max-w-[320px] truncate">{i.description}</span> },
                    { key: 'kind', header: 'Type', cell: (i: R) => <span className="capitalize">{String(i.kind).replace(/_/g, ' ')}</span> },
                    { key: 'brand', header: 'Brand', cell: (i: R) => (i.publisher_id ? <Link className="link" to={`/admin/brands/${i.publisher_id}`}>{i.publisher_name}</Link> : '—') },
                    { key: 'price', header: 'Price', align: 'right', cell: (i: R) => $(i.price_cents) },
                    { key: 'creator', header: 'Creator share', align: 'right', cell: (i: R) => $(i.creator_cents) },
                  ]}
                />
              </Section>
              <Section title="Creator ledger" description="What this order added to, or took back from, brand balances.">
                <Table
                  rowKey={(r: R) => r.id}
                  rows={d.ledger}
                  empty="No ledger entries for this order"
                  columns={[
                    { key: 'when', header: 'Date', cell: (l: R) => dateTime(l.created_at) },
                    { key: 'brand', header: 'Brand', cell: (l: R) => <Link className="link" to={`/admin/brands/${l.publisher_id}`}>{l.publisher_name}</Link> },
                    { key: 'kind', header: 'Type', cell: (l: R) => <span className="capitalize">{l.kind}</span> },
                    { key: 'note', header: 'Note', cell: (l: R) => <span className="block max-w-[240px] truncate text-muted">{l.note ?? '—'}</span> },
                    { key: 'amount', header: 'Amount', align: 'right', cell: (l: R) => <span className={l.amount_cents < 0 ? 'text-danger' : 'text-ok'}>{$(l.amount_cents)}</span> },
                  ]}
                />
              </Section>
              {d.entitlements.length > 0 && (
                <Section title="Access granted">
                  <ul className="space-y-1 text-sm">
                    {d.entitlements.map((e: R) => <li key={e.release_id}>{e.title} <span className="text-muted">({e.source}{e.can_download ? ', with download' : ''})</span></li>)}
                  </ul>
                </Section>
              )}
              {d.gift_cards.length > 0 && (
                <Section title="Gift cards in this order">
                  <ul className="space-y-1 text-sm">
                    {d.gift_cards.map((g: R) => <li key={g.id}>{$(g.amount_cents)} for {g.recipient_email ?? 'the buyer'} <span className="text-muted">({g.redeemed_at ? `redeemed ${date(g.redeemed_at)}` : g.balance_cents ? 'not redeemed yet' : 'void'})</span></li>)}
                  </ul>
                </Section>
              )}
            </div>
          </>
        );
      }}
    </Loaded>
  );
}

// ---------------------------------------------------------------- memberships

function MembershipModal({ id, onClose }: { id: string; onClose: () => void }) {
  const $ = useMoney();
  const ask = useAsk();
  const { run, busy } = useAct();
  const q = useAdminQuery<R>(`/api/admin/memberships/${id}`);
  const refund = async (c: R) => {
    const v = await ask({
      title: `Refund ${$(c.amount_cents)}?`,
      body: 'The payment goes back through the processor and the membership ends.',
      fields: [{ name: 'reason', label: 'Reason', type: 'textarea', required: true, minLength: 3 }],
      confirmLabel: 'Refund payment',
      danger: true,
    });
    if (v) void run({ key: c.id, fn: () => api(`/api/admin/membership-charges/${c.id}/refund`, { json: { reason: v.reason } }), ok: 'Membership payment refunded' });
  };
  return (
    <Modal open onClose={onClose} title="Membership" size="lg">
      <Loaded query={q}>
        {(d) => (
          <div className="space-y-5">
            <DefList
              items={[
                ['Member', <Link className="link" to={`/admin/users/${d.membership.user_id}`}>{d.membership.email}</Link>],
                ['Plan', d.membership.provider === 'grant' ? 'Complimentary' : `${d.membership.plan}, ${$(d.membership.price_cents)}`],
                ['Status', <StatusBadge status={d.membership.status} />],
                ['Current period', `${date(d.membership.current_period_start)} to ${date(d.membership.current_period_end)}`],
                ['Renews', d.membership.cancel_at_period_end ? 'No, ends with this period' : 'Yes'],
                ['Started', date(d.membership.created_at)],
              ]}
            />
            <div>
              <h3 className="mb-2 font-semibold">Payments</h3>
              <Table
                rowKey={(r: R) => r.id}
                rows={d.charges}
                empty="No payments have been taken for this membership"
                columns={[
                  { key: 'period', header: 'Period', cell: (c: R) => `${date(c.period_start)} to ${date(c.period_end)}` },
                  { key: 'status', header: 'Status', cell: (c: R) => <span title={c.last_error ?? ''}><StatusBadge status={c.status} /></span> },
                  { key: 'amount', header: 'Amount', align: 'right', cell: (c: R) => $(c.amount_cents) },
                  { key: 'fee', header: 'Fee', align: 'right', cell: (c: R) => $(c.fee_cents) },
                  { key: 'act', header: '', cell: (c: R) => (c.status === 'paid' ? <Button size="sm" variant="danger" loading={busy === c.id} onClick={() => refund(c)}>Refund</Button> : null) },
                ]}
              />
            </div>
            {d.months.length > 0 && (
              <div>
                <h3 className="mb-2 font-semibold">Months counted for settlement</h3>
                <ul className="flex flex-wrap gap-2 text-sm">
                  {d.months.map((m: R) => <li key={m.month} className="rounded-lg border border-line px-2.5 py-1">{m.month} · {$(m.gross_cents - m.fee_cents)} net · {m.settled_at ? 'settled' : 'not settled'}</li>)}
                </ul>
              </div>
            )}
          </div>
        )}
      </Loaded>
    </Modal>
  );
}

export function MembershipsPage() {
  useTitle('Memberships');
  const $ = useMoney();
  const { settings } = useSession();
  const [f, setF] = useFilters({ q: '', status: 'current', plan: '', provider: '' });
  const [open, setOpen] = useState<string | null>(null);
  const list = useList<{ summary: R }>('/api/admin/memberships', { q: f.q, status: f.status, plan: f.plan, provider: f.provider, page: f.page });
  const s = list.data?.summary;
  const columns: Column<R>[] = [
    { key: 'who', header: 'Member', cell: (m) => <span className="block max-w-[220px] truncate">{m.email}</span> },
    { key: 'plan', header: 'Plan', cell: (m) => <span className="capitalize">{m.provider === 'grant' ? 'Complimentary' : m.plan}</span> },
    { key: 'status', header: 'Status', cell: (m) => <span className="flex gap-1"><StatusBadge status={m.status} />{m.cancel_at_period_end && m.provider !== 'grant' && m.status === 'active' && <Badge tone="warn">Ending</Badge>}</span> },
    { key: 'price', header: 'Price', align: 'right', cell: (m) => $(m.price_cents) },
    { key: 'until', header: 'Period ends', cell: (m) => date(m.current_period_end) },
    { key: 'since', header: 'Started', cell: (m) => <span className="text-muted">{date(m.created_at)}</span>, hideOnMobile: true },
  ];
  return (
    <>
      <PageHeader title="Memberships" description={`Everyone who has, or had, ${settings.membership.name}. Open one for its payment history.`} />
      {s && (
        <div className="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-5">
          <Stat label="Active members" value={number(s.active_members)} />
          <Stat label="Monthly recurring" value={$(s.mrr_cents)} hint="Annual plans counted as a twelfth" />
          <Stat label="Payment overdue" value={number(s.past_due)} />
          <Stat label="Ending soon" value={number(s.cancelling)} hint="Cancelled, still in their paid period" />
          <Stat label="Complimentary" value={number(s.complimentary)} />
        </div>
      )}
      <FilterBar>
        <SearchInput value={f.q} onChange={(q) => setF({ q })} placeholder="Search by email or username" />
        <FilterSelect label="Status" value={f.status} onChange={(status) => setF({ status })} options={[['current', 'Current members'], ['', 'Any status'], ['active', 'Active'], ['past_due', 'Payment overdue'], ['canceled', 'Cancelled'], ['expired', 'Expired'], ['pending', 'Pending']]} />
        <FilterSelect label="Plan" value={f.plan} onChange={(plan) => setF({ plan })} options={[['', 'Any plan'], ['monthly', 'Monthly'], ['annual', 'Annual']]} />
        <FilterSelect label="Source" value={f.provider} onChange={(provider) => setF({ provider })} options={[['', 'Paid and complimentary'], ['grant', 'Complimentary'], ['divinity', 'Divinity payments'], ['sandbox', 'Sandbox']]} />
      </FilterBar>
      <DataList
        query={list}
        columns={columns}
        onRowClick={(m) => setOpen(m.id)}
        onPage={(page) => setF({ page })}
        empty={{ icon: <Sparkles />, title: 'No memberships match', hint: 'Members appear here when they subscribe or are granted membership from a user\'s page.', action: <Button onClick={() => setF({ q: '', status: '', plan: '', provider: '' })}>Show every membership</Button> }}
      />
      {open && <MembershipModal id={open} onClose={() => setOpen(null)} />}
    </>
  );
}

// ---------------------------------------------------------------- payouts

function Payouts() {
  useTitle('Payouts');
  const $ = useMoney();
  const ask = useAsk();
  const { run, busy } = useAct();
  const [f, setF] = useFilters({ status: 'requested' });
  const list = useList<{ totals: R[] }>('/api/admin/payouts', { status: f.status, page: f.page });
  const totals = Object.fromEntries((list.data?.totals ?? []).map((t) => [t.status, t]));
  const tab = (status: string, label: string) => ({ value: status, label: totals[status] ? `${label} (${totals[status].count})` : label });

  const approve = async (p: R) => {
    const v = await ask({
      title: `Approve ${$(p.amount_cents)} to ${p.publisher_name}?`,
      body: `This takes ${$(p.amount_cents)} out of the brand's balance now (${$(p.available_cents)} is available). You then send the money by ${p.method} and mark it paid.`,
      fields: [{ name: 'note', label: 'Message to the creator', hint: 'Optional. Included in the approval email.' }],
      confirmLabel: 'Approve payout',
    });
    if (v) void run({ key: p.id, fn: () => api(`/api/admin/payouts/${p.id}/approve`, { json: { note: v.note } }), ok: 'Payout approved. Send the money, then mark it paid.' });
  };
  const paid = async (p: R) => {
    const v = await ask({
      title: `Mark ${$(p.amount_cents)} as paid?`,
      body: `Only do this once the money has left your account. ${p.publisher_name} is told it is on its way.`,
      fields: [
        { name: 'reference', label: 'Transfer reference', required: true, hint: 'The bank or PayPal transaction ID. The creator sees it.' },
        { name: 'note', label: 'Message to the creator' },
      ],
      confirmLabel: 'Mark as paid',
    });
    if (v) void run({ key: p.id, fn: () => api(`/api/admin/payouts/${p.id}/paid`, { json: { reference: v.reference, note: v.note } }), ok: 'Payout marked as paid' });
  };
  const reject = async (p: R) => {
    const v = await ask({
      title: `Reject this ${$(p.amount_cents)} payout?`,
      body: p.debited ? 'The money already taken from the brand balance is put back.' : 'The brand keeps its balance and can request again.',
      fields: [{ name: 'note', label: 'Why', type: 'textarea', required: true, minLength: 3, hint: 'Sent to the creator.' }],
      confirmLabel: 'Reject payout',
      danger: true,
    });
    if (v) void run({ key: p.id, fn: () => api(`/api/admin/payouts/${p.id}/reject`, { json: { note: v.note } }), ok: 'Payout rejected' });
  };

  const columns: Column<R>[] = [
    {
      key: 'brand', header: 'Brand',
      cell: (p) => (
        <div className="max-w-[220px]">
          <Link className="link block truncate" to={`/admin/brands/${p.publisher_id}`}>{p.publisher_name}</Link>
          <span className="block truncate text-xs text-muted">{p.requested_by_email ?? 'Requester removed'} · {ago(p.created_at)}</span>
          {p.publisher_suspended_at && <Badge tone="danger">Brand suspended</Badge>}
        </div>
      ),
    },
    { key: 'amount', header: 'Amount', align: 'right', cell: (p) => <span className="font-semibold">{$(p.amount_cents)}</span> },
    {
      key: 'context', header: 'Brand balance',
      cell: (p) => (
        <div className="text-xs">
          <div>{$(p.balance_cents)} balance</div>
          <div className={!p.debited && p.available_cents < p.amount_cents ? 'text-danger' : 'text-muted'}>{$(p.available_cents)} available{!p.debited && p.available_cents < p.amount_cents ? ': not enough' : ''}</div>
        </div>
      ),
    },
    { key: 'method', header: 'Send to', cell: (p) => <div className="max-w-[220px] text-xs"><div className="capitalize">{p.method}</div><div className="truncate text-muted" title={p.destination ?? ''}>{p.destination ?? 'No destination given'}</div></div> },
    {
      key: 'status', header: 'Status',
      cell: (p) => (
        <div className="max-w-[200px] text-xs">
          <StatusBadge status={p.status} />
          {p.reference && <div className="mt-1 truncate text-muted">Ref: {p.reference}</div>}
          {p.note && <div className="mt-1 truncate text-muted" title={p.note}>{p.note}</div>}
          {p.reviewed_by_username && <div className="mt-1 text-faint">by @{p.reviewed_by_username}</div>}
        </div>
      ),
    },
    {
      key: 'actions', header: 'Actions',
      cell: (p) => (
        <span className="flex gap-1.5">
          {p.status === 'requested' && <Button size="sm" variant="primary" loading={busy === p.id} onClick={() => approve(p)}>Approve</Button>}
          {p.status === 'approved' && <Button size="sm" variant="primary" loading={busy === p.id} onClick={() => paid(p)}>Mark paid</Button>}
          {(p.status === 'requested' || p.status === 'approved') && <Button size="sm" variant="danger" disabled={busy === p.id} onClick={() => reject(p)}>Reject</Button>}
          {(p.status === 'paid' || p.status === 'rejected') && <span className="text-xs text-muted">{date(p.paid_at ?? p.reviewed_at)}</span>}
        </span>
      ),
    },
  ];
  return (
    <>
      <PageHeader title="Payouts" description="Creators ask for their available earnings here. Approve a request to reserve the money, send it yourself, then mark it paid with the transfer reference." />
      <div className="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Waiting for review" value={$(totals.requested?.cents ?? 0)} hint={`${totals.requested?.count ?? 0} requests`} />
        <Stat label="Approved, not sent" value={$(totals.approved?.cents ?? 0)} hint={`${totals.approved?.count ?? 0} payouts`} />
        <Stat label="Paid out" value={$(totals.paid?.cents ?? 0)} hint={`${totals.paid?.count ?? 0} payouts`} />
        <Stat label="Rejected" value={$(totals.rejected?.cents ?? 0)} hint={`${totals.rejected?.count ?? 0} requests`} />
      </div>
      <div className="mb-4">
        <Tabs value={f.status} onChange={(status) => setF({ status })} tabs={[tab('requested', 'Requested'), tab('approved', 'Approved'), tab('paid', 'Paid'), tab('rejected', 'Rejected'), { value: 'all', label: 'All' }]} />
      </div>
      <DataList
        query={list}
        columns={columns}
        onPage={(page) => setF({ page })}
        empty={{ icon: <Wallet />, title: f.status === 'requested' ? 'No payout requests waiting' : 'No payouts here', hint: 'Creators request payouts from their Studio earnings page once they pass the payout minimum.' }}
      />
    </>
  );
}

export const PayoutsPage = () => <SuperOnly><Payouts /></SuperOnly>;

// ---------------------------------------------------------------- settlement

function SettlementPreview({ month, closed, onClose }: { month: string; closed: boolean; onClose: () => void }) {
  const $ = useMoney();
  const confirm = useConfirm();
  const { run, busy } = useAct();
  const q = useAdminQuery<R>(`/api/admin/settlement/${month}/preview`);
  const doRun = async () => {
    if (await confirm({ title: `Settle ${month}?`, body: 'Creator earnings for this month are added to brand ledgers. This is done once per month and cannot be undone from here.', confirmLabel: 'Run settlement' })) {
      void run({ key: 'settle', fn: () => api<R>(`/api/admin/settlement/${month}/run`, { method: 'POST' }), ok: (r) => `${month} settled: ${$(r.settlement?.creator_cents ?? 0)} to creators`, onDone: onClose });
    }
  };
  return (
    <Modal
      open
      onClose={onClose}
      title={`Settlement for ${month}`}
      size="lg"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Close</Button>
          {q.data && !q.data.settled && closed && <Button variant="primary" loading={busy === 'settle'} onClick={doRun}>Run settlement</Button>}
        </>
      }
    >
      <Loaded query={q}>
        {(d) => {
          const p = d.preview as R;
          const rows: R[] = p.series ?? p.publishers ?? [];
          return (
            <div className="space-y-4">
              {d.settled ? <Notice tone="ok">Settled {dateTime(d.settled.ran_at)}. These are the final numbers.</Notice>
                : !closed ? <Notice tone="warn">This month is still running. The numbers will keep moving, and it can be settled once the month ends.</Notice>
                : <Notice>Nothing has been paid yet. This is what running the settlement would do.</Notice>}
              {p.note && <p className="text-sm text-muted">{p.note}</p>}
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                <Stat label="Members" value={number(p.subscribers)} />
                <Stat label="Paid by members" value={$(p.gross_cents)} hint={`${$(p.fee_cents)} in fees`} />
                <Stat label="To creators" value={$(p.creator_cents)} />
                <Stat label="Platform keeps" value={$(p.platform_cents)} />
              </div>
              {p.pool_cents !== undefined && (
                <p className="text-sm text-muted">
                  {$(p.pool_cents)} came from members who read nothing; it is shared out in proportion to everyone else's reading.
                  {p.undistributed_cents > 0 && ` ${$(p.undistributed_cents)} had nobody to go to and stays with the platform.`}
                </p>
              )}
              <Table
                rowKey={(r: R) => r.series_id ?? r.publisher_id}
                rows={rows}
                empty="No membership pages were read this month, so there is nothing to share out"
                columns={
                  p.series
                    ? [
                        { key: 'series', header: 'Series', cell: (r: R) => <Mono>{shortId(r.series_id)}</Mono> },
                        { key: 'brand', header: 'Brand', cell: (r: R) => <Link className="link" to={`/admin/brands/${r.publisher_id}`}><Mono>{shortId(r.publisher_id)}</Mono></Link> },
                        { key: 'pages', header: 'Pages read', align: 'right', cell: (r: R) => number(r.pages) },
                        { key: 'net', header: 'Net share', align: 'right', cell: (r: R) => $(r.net_cents) },
                        { key: 'creator', header: 'To creator', align: 'right', cell: (r: R) => $(r.creator_cents) },
                      ]
                    : [
                        { key: 'brand', header: 'Brand', cell: (r: R) => <Link className="link" to={`/admin/brands/${r.publisher_id}`}>{r.name}</Link> },
                        { key: 'pages', header: 'Pages read', align: 'right', cell: (r: R) => number(r.pages) },
                        { key: 'readers', header: 'Readers', align: 'right', cell: (r: R) => number(r.readers) },
                        { key: 'creator', header: 'To creator', align: 'right', cell: (r: R) => $(r.creator_cents) },
                      ]
                }
              />
            </div>
          );
        }}
      </Loaded>
    </Modal>
  );
}

function Settlement() {
  useTitle('Settlement');
  const $ = useMoney();
  const { settings } = useSession();
  const q = useAdminQuery<{ months: R[] }>('/api/admin/settlement');
  const [open, setOpen] = useState<R | null>(null);
  return (
    <>
      <PageHeader title="Settlement" description={`Sharing each month's ${settings.membership.name} money between the creators whose pages members read.`} />
      <Section title="What settlement does" className="mb-5">
        <ol className="list-decimal space-y-1.5 pl-5 text-sm text-muted">
          <li>Takes what each member paid for the month, minus the processing fee.</li>
          <li>Splits that member's money across the series they read, in proportion to the pages they read in each.</li>
          <li>Money from members who read nothing is pooled and shared out by everyone's reading.</li>
          <li>Applies each brand's membership share, adds the creator part to the brand's ledger, and keeps the rest for the platform.</li>
        </ol>
        <p className="mt-3 text-sm text-muted">A month can be settled once, after it has ended. Preview it first: nothing is paid until you run it. Settled earnings become available for payout after the usual hold.</p>
      </Section>
      <Loaded query={q}>
        {(d) => (
          <Table
            rowKey={(m: R) => m.month}
            rows={d.months}
            empty="No membership payments yet. Months appear here once members have paid."
            columns={[
              { key: 'month', header: 'Month', cell: (m: R) => <span className="font-medium">{date(`${m.month}-15`, { month: 'long', year: 'numeric' })}</span> },
              { key: 'state', header: 'Status', cell: (m: R) => (m.ran_at ? <Badge tone="ok">Settled</Badge> : m.closed ? <Badge tone="warn">Ready to settle</Badge> : <Badge tone="info">In progress</Badge>) },
              { key: 'subs', header: 'Members', align: 'right', cell: (m: R) => number(m.subscribers) },
              { key: 'gross', header: 'Paid in', align: 'right', cell: (m: R) => $(m.gross_cents) },
              { key: 'fees', header: 'Fees', align: 'right', cell: (m: R) => $(m.fee_cents), hideOnMobile: true },
              { key: 'creator', header: 'To creators', align: 'right', cell: (m: R) => (m.ran_at ? $(m.creator_cents) : '—') },
              { key: 'platform', header: 'Platform', align: 'right', cell: (m: R) => (m.ran_at ? $(m.platform_cents) : '—'), hideOnMobile: true },
              { key: 'ran', header: 'Settled', cell: (m: R) => (m.ran_at ? <span className="text-muted">{date(m.ran_at)}{m.ran_by_username ? ` by @${m.ran_by_username}` : ' automatically'}</span> : '—'), hideOnMobile: true },
              { key: 'act', header: '', cell: (m: R) => <Button size="sm" onClick={() => setOpen(m)}>{m.ran_at ? 'View' : m.closed ? 'Preview and run' : 'Preview'}</Button> },
            ]}
          />
        )}
      </Loaded>
      {open && <SettlementPreview month={open.month} closed={open.closed} onClose={() => setOpen(null)} />}
    </>
  );
}

export const SettlementPage = () => <SuperOnly><Settlement /></SuperOnly>;

// ---------------------------------------------------------------- codes and gift cards

function CodeForm({ onClose, onCreated }: { onClose: () => void; onCreated: (codes: R[]) => void }) {
  const { run, busy } = useAct();
  const [v, setV] = useState({ kind: 'membership', mode: 'batch', code: '', quantity: '10', value: '30', max: '', expires: '', label: '', email: '' });
  const set = (p: Partial<typeof v>) => setV((c) => ({ ...c, ...p }));
  const submit = () => {
    const value = Number(v.value);
    if (!Number.isInteger(value) || value < 1) return void toast.error('Enter a whole number for what the code gives.');
    const body: R = {
      kind: v.kind,
      [v.kind === 'membership' ? 'membership_days' : v.kind === 'credits' ? 'page_credits' : 'percent_off']: value,
      batch_label: v.label.trim() || undefined,
      assigned_email: v.email.trim() || undefined,
      expires_at: v.expires ? fromLocalInput(`${v.expires}T23:59`) : undefined,
    };
    if (v.mode === 'custom') body.code = v.code.trim().toUpperCase();
    else body.quantity = Number(v.quantity) || 1;
    if (v.max.trim()) body.max_redemptions = Number(v.max);
    void run({ key: 'code', fn: () => api<R>('/api/admin/codes', { json: body }), ok: (r) => `${r.codes.length} ${r.codes.length === 1 ? 'code' : 'codes'} created`, onDone: (r) => onCreated(r.codes) });
  };
  return (
    <Modal open onClose={onClose} title="Create codes" footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" loading={busy === 'code'} onClick={submit}>Create</Button></>}>
      <div className="space-y-4">
        <Field label="What the code gives">
          <Segmented value={v.kind} onChange={(kind) => set({ kind, value: kind === 'membership' ? '30' : kind === 'credits' ? '100' : '20' })} options={[{ value: 'membership', label: 'Membership days' }, { value: 'credits', label: 'Page credits' }, { value: 'discount', label: 'Percent off an order' }]} />
        </Field>
        <FormRow>
          <Field label={v.kind === 'membership' ? 'Days of membership' : v.kind === 'credits' ? 'Page credits' : 'Percent off'}>
            <Input inputMode="numeric" value={v.value} onChange={(e) => set({ value: e.target.value })} />
          </Field>
          <Field label="Code style">
            <Select value={v.mode} onChange={(e) => set({ mode: e.target.value })}>
              <option value="batch">Random codes, one use each</option>
              <option value="custom">One code I choose</option>
            </Select>
          </Field>
        </FormRow>
        {v.mode === 'custom' ? (
          <FormRow>
            <Field label="Code" hint="4-40 letters, numbers or dashes."><Input value={v.code} onChange={(e) => set({ code: e.target.value.toUpperCase() })} placeholder="SUMMER-2027" /></Field>
            <Field label="Total uses" optional hint="Leave empty for unlimited."><Input inputMode="numeric" value={v.max} onChange={(e) => set({ max: e.target.value })} /></Field>
          </FormRow>
        ) : (
          <FormRow>
            <Field label="How many" hint="Up to 500 at a time."><Input inputMode="numeric" value={v.quantity} onChange={(e) => set({ quantity: e.target.value })} /></Field>
            <Field label="Uses per code" optional hint="Leave empty for one use each."><Input inputMode="numeric" value={v.max} onChange={(e) => set({ max: e.target.value })} /></Field>
          </FormRow>
        )}
        <FormRow>
          <Field label="Expires" optional><Input type="date" value={v.expires} onChange={(e) => set({ expires: e.target.value })} /></Field>
          <Field label="Label" optional hint="For your own records, such as a convention name."><Input value={v.label} onChange={(e) => set({ label: e.target.value })} /></Field>
        </FormRow>
        <Field label="Only for this email" optional hint="Leave empty so anyone with the code can use it."><Input type="email" value={v.email} onChange={(e) => set({ email: e.target.value })} /></Field>
      </div>
    </Modal>
  );
}

function codeGives(c: R): string {
  return c.kind === 'membership' ? `${c.membership_days} days of membership` : c.kind === 'credits' ? `${number(c.page_credits)} page credits` : `${c.percent_off}% off`;
}

function CreatedCodes({ codes, onClose }: { codes: R[]; onClose: () => void }) {
  const text = codes.map((c) => c.code).join('\n');
  return (
    <Modal open onClose={onClose} title={codes.length === 1 ? 'Your code is ready' : `${codes.length} codes are ready`} footer={<><CopyButton text={text} label={codes.length === 1 ? 'Copy code' : 'Copy all'} size="md" /><Button variant="primary" onClick={onClose}>Done</Button></>}>
      <p className="mb-3 text-sm text-muted">Each gives {codeGives(codes[0])}. They are also listed on this page whenever you need them again.</p>
      <pre className="max-h-72 overflow-auto rounded-xl border border-line bg-ink p-4 font-mono text-sm leading-relaxed">{text}</pre>
    </Modal>
  );
}

function CodesTab() {
  const [f, setF] = useFilters({ q: '', kind: '', cstatus: '' });
  const list = useList('/api/admin/codes', { q: f.q, kind: f.kind, status: f.cstatus, page: f.page });
  const confirm = useConfirm();
  const { run, busy } = useAct();
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<R[] | null>(null);
  const columns: Column<R>[] = [
    { key: 'code', header: 'Code', cell: (c) => <span className="flex items-center gap-2"><Mono>{c.code}</Mono></span> },
    { key: 'gives', header: 'Gives', cell: codeGives },
    { key: 'used', header: 'Used', align: 'right', cell: (c) => `${number(c.redeemed_count)}${c.max_redemptions ? ` of ${number(c.max_redemptions)}` : ''}` },
    {
      key: 'state', header: 'Status',
      cell: (c) => c.disabled_at ? <Badge tone="danger">Disabled</Badge>
        : c.expires_at && Date.parse(c.expires_at) < Date.now() ? <Badge>Expired</Badge>
        : c.max_redemptions && c.redeemed_count >= c.max_redemptions ? <Badge>Used up</Badge>
        : <Badge tone="ok">Active</Badge>,
    },
    { key: 'label', header: 'Label', cell: (c) => <span className="block max-w-[180px] truncate text-muted">{c.batch_label ?? c.assigned_email ?? '—'}</span>, hideOnMobile: true },
    { key: 'expires', header: 'Expires', cell: (c) => <span className="text-muted">{c.expires_at ? date(c.expires_at) : 'Never'}</span>, hideOnMobile: true },
    {
      key: 'act', header: '',
      cell: (c) => (
        <span className="flex gap-1.5">
          <CopyButton text={c.code} />
          <Button size="sm" loading={busy === c.id} onClick={async () => {
            const disabled = !c.disabled_at;
            if (await confirm({ title: disabled ? `Disable ${c.code}?` : `Enable ${c.code} again?`, body: disabled ? 'Nobody can redeem it until you enable it again. People who already used it keep what they got.' : 'It can be redeemed again.', confirmLabel: disabled ? 'Disable' : 'Enable', danger: disabled })) {
              void run({ key: c.id, fn: () => api(`/api/admin/codes/${c.id}/disable`, { json: { disabled } }), ok: disabled ? 'Code disabled' : 'Code enabled' });
            }
          }}>{c.disabled_at ? 'Enable' : 'Disable'}</Button>
        </span>
      ),
    },
  ];
  return (
    <>
      <FilterBar>
        <SearchInput value={f.q} onChange={(q) => setF({ q })} placeholder="Search by code, label or email" />
        <FilterSelect label="Type" value={f.kind} onChange={(kind) => setF({ kind })} options={[['', 'Any type'], ['membership', 'Membership days'], ['credits', 'Page credits'], ['discount', 'Discount']]} />
        <FilterSelect label="Status" value={f.cstatus} onChange={(cstatus) => setF({ cstatus })} options={[['', 'Any status'], ['active', 'Active'], ['used', 'Used at least once'], ['disabled', 'Disabled']]} />
        <Button variant="primary" onClick={() => setCreating(true)}>Create codes</Button>
      </FilterBar>
      <DataList
        query={list}
        columns={columns}
        onPage={(page) => setF({ page })}
        empty={{ icon: <Ticket />, title: 'No codes yet', hint: 'Create codes that give membership days, page credits or a discount. Hand them out at events or to press.', action: <Button onClick={() => setCreating(true)}>Create codes</Button> }}
      />
      {creating && <CodeForm onClose={() => setCreating(false)} onCreated={(codes) => { setCreating(false); setCreated(codes); }} />}
      {created && <CreatedCodes codes={created} onClose={() => setCreated(null)} />}
    </>
  );
}

function GiftCardForm({ onClose, onCreated }: { onClose: () => void; onCreated: (r: R) => void }) {
  const { run, busy } = useAct();
  const [amount, setAmount] = useState<number | null>(2500);
  const [email, setEmail] = useState('');
  const [message, setMessage] = useState('');
  const [send, setSend] = useState(true);
  const submit = () => {
    if (!amount || amount < 100) return void toast.error('Gift cards start at $1.00.');
    void run({ key: 'gift', fn: () => api<R>('/api/admin/gift-cards', { json: { amount_cents: amount, recipient_email: email.trim() || undefined, message, send_email: send } }), ok: 'Gift card issued', onDone: onCreated });
  };
  return (
    <Modal open onClose={onClose} title="Issue a gift card" size="sm" footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" loading={busy === 'gift'} onClick={submit}>Issue gift card</Button></>}>
      <div className="space-y-4">
        <p className="text-sm text-muted">A complimentary gift card. Whoever redeems the code gets the amount as store credit.</p>
        <Field label="Amount" hint="Between $1 and $1,000."><MoneyInput cents={amount} onChange={setAmount} /></Field>
        <Field label="Recipient email" optional><Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} /></Field>
        <Field label="Message" optional><Textarea value={message} onChange={(e) => setMessage(e.target.value)} maxLength={500} className="min-h-20" /></Field>
        <Checkbox checked={send} onChange={setSend} disabled={!email.trim()} label="Email the code to the recipient" description="Turn off to copy the code and deliver it yourself." />
      </div>
    </Modal>
  );
}

function GiftCardsTab() {
  const $ = useMoney();
  const isSuper = useIsSuper();
  const [f, setF] = useFilters({ gq: '', gstatus: '' });
  const list = useList('/api/admin/gift-cards', { q: f.gq, status: f.gstatus, page: f.page });
  const confirm = useConfirm();
  const { run, busy } = useAct();
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<R | null>(null);
  const columns: Column<R>[] = [
    { key: 'code', header: 'Code', cell: (g) => <Mono>{g.code}</Mono> },
    { key: 'amount', header: 'Amount', align: 'right', cell: (g) => $(g.amount_cents) },
    { key: 'state', header: 'Status', cell: (g) => (g.redeemed_at ? <Badge tone="ok">Redeemed</Badge> : g.balance_cents > 0 ? <Badge tone="info">Not redeemed</Badge> : <Badge tone="danger">Void</Badge>) },
    { key: 'to', header: 'For', cell: (g) => <span className="block max-w-[200px] truncate">{g.recipient_email ?? '—'}</span> },
    { key: 'from', header: 'From', cell: (g) => <span className="text-muted">{g.order_id ? <Link className="link" to={`/admin/orders/${g.order_id}`}>@{g.purchaser_username ?? 'buyer'}</Link> : `Issued by @${g.purchaser_username ?? 'staff'}`}</span>, hideOnMobile: true },
    { key: 'created', header: 'Created', cell: (g) => <span className="text-muted">{date(g.created_at)}</span>, hideOnMobile: true },
    {
      key: 'act', header: '',
      cell: (g) => !g.redeemed_at && g.balance_cents > 0 ? (
        <span className="flex gap-1.5">
          <CopyButton text={g.code} />
          {isSuper && <Button size="sm" variant="danger" loading={busy === g.id} onClick={async () => {
            if (await confirm({ title: `Void this ${$(g.amount_cents)} gift card?`, body: 'The code stops working. This cannot be undone.', confirmLabel: 'Void gift card', danger: true })) void run({ key: g.id, fn: () => api(`/api/admin/gift-cards/${g.id}/void`, { method: 'POST' }), ok: 'Gift card voided' });
          }}>Void</Button>}
        </span>
      ) : g.redeemed_by_username ? <span className="text-xs text-muted">by @{g.redeemed_by_username}</span> : null,
    },
  ];
  return (
    <>
      <FilterBar>
        <SearchInput value={f.gq} onChange={(gq) => setF({ gq })} placeholder="Search by code or recipient email" />
        <FilterSelect label="Status" value={f.gstatus} onChange={(gstatus) => setF({ gstatus })} options={[['', 'Any status'], ['unredeemed', 'Not redeemed'], ['redeemed', 'Redeemed'], ['void', 'Void']]} />
        {isSuper && <Button variant="primary" onClick={() => setCreating(true)}>Issue a gift card</Button>}
      </FilterBar>
      <DataList
        query={list}
        columns={columns}
        onPage={(page) => setF({ page })}
        empty={{ icon: <Gift />, title: 'No gift cards yet', hint: 'Gift cards readers buy show up here, along with any you issue yourself.', action: isSuper ? <Button onClick={() => setCreating(true)}>Issue a gift card</Button> : undefined }}
      />
      {creating && <GiftCardForm onClose={() => setCreating(false)} onCreated={(r) => { setCreating(false); setCreated(r); }} />}
      {created && (
        <Modal open onClose={() => setCreated(null)} title="Gift card issued" size="sm" footer={<><CopyButton text={created.gift_card.code} label="Copy code" size="md" /><Button variant="primary" onClick={() => setCreated(null)}>Done</Button></>}>
          <p className="mb-3 text-sm text-muted">
            {$(created.gift_card.amount_cents)} of store credit.{' '}
            {created.email_id ? `The code is on its way to ${created.gift_card.recipient_email}.` : 'No email was sent: copy the code and pass it on yourself.'}
          </p>
          <pre className="rounded-xl border border-line bg-ink p-4 text-center font-mono text-lg">{created.gift_card.code}</pre>
        </Modal>
      )}
    </>
  );
}

export function CodesPage() {
  useTitle('Codes & gift cards');
  const [f, setF] = useFilters({ tab: 'codes' });
  return (
    <>
      <PageHeader title="Codes & gift cards" description="Platform-wide codes for membership, page credits and discounts, and gift cards for store credit." />
      <div className="mb-4">
        <Tabs value={f.tab} onChange={(tab) => setF({ tab })} tabs={[{ value: 'codes', label: 'Codes' }, { value: 'gift', label: 'Gift cards' }]} />
      </div>
      {f.tab === 'gift' ? <GiftCardsTab /> : <CodesTab />}
    </>
  );
}
