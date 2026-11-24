import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, BookOpen, Coins, Printer, Receipt as ReceiptIcon, Sparkles, Ticket } from 'lucide-react';
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import type { ReactNode } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { api, errorMessage } from '@/lib/api';
import { date, dateTime, money, moneyExact, number, plural } from '@/lib/format';
import { useSession } from '@/lib/session';
import { Badge, Button, Card, CardHeader, DefList, EmptyState, ErrorState, Field, Input, LinkButton, NavTabs, Notice, PageHeader, PageLoader, Pagination, Stat, Table, toast, useConfirm } from '@/ui';
import type { Column } from '@/ui';
import { useCheckout } from '../store/Checkout';
import { ListSkeleton, safePath, useTitle } from './shared';

function BillingTabs() {
  return (
    <NavTabs
      tabs={[
        { to: '/account/codes', label: 'Codes and credits' },
        { to: '/account/purchases', label: 'Purchases' },
        { to: '/account/membership', label: 'Membership' },
      ]}
    />
  );
}

// ---------------------------------------------------------------- codes + wallet

type Redeemed =
  | { kind: 'gift_card'; message: string; credit_cents: number; wallet_credit_cents: number }
  | { kind: 'unlock'; message: string; series_slug: string; release_ids: string[]; includes_download: boolean }
  | { kind: 'membership'; message: string; days: number; member_until: string }
  | { kind: 'credits'; message: string; page_credits_added: number; page_credits: number };

type WalletLog = { id: string; kind: string; credit_cents: number; page_credits: number; note: string | null; created_at: string };
type Wallet = { wallet: { credit_cents: number; page_credits: number; updated_at: string | null }; page_credit_cents: number; log: WalletLog[]; total: number; page: number; limit: number };

const LOG_KIND: Record<string, string> = {
  gift_card: 'Gift card redeemed',
  credits_code: 'Credit code redeemed',
  credits_purchase: 'Page credits bought',
  page_unlock: 'Page unlocked',
  purchase: 'Store credit spent',
  refund: 'Refund',
  admin: 'Adjustment by support',
};

function signed(n: number, fmt: (v: number) => string): ReactNode {
  if (!n) return <span className="text-faint">—</span>;
  return <span className={n > 0 ? 'text-ok' : 'text-paper'}>{n > 0 ? '+' : '−'}{fmt(Math.abs(n))}</span>;
}

/** What just happened, in the reader's terms, built from the redeem response. */
function RedeemResult({ result, next, currency, membershipName }: { result: Redeemed; next: string | null; currency: string; membershipName: string }) {
  let detail: ReactNode;
  let action: ReactNode;
  if (result.kind === 'gift_card') {
    detail = <>Your store credit balance is now {moneyExact(result.wallet_credit_cents, currency)}. It is taken off your next purchases automatically at checkout, and it does not expire.</>;
    action = <LinkButton to="/" variant="primary" size="sm" className="h-10">Spend it in the store</LinkButton>;
  } else if (result.kind === 'unlock') {
    const n = result.release_ids.length;
    detail = (
      <>
        {n === 1 ? 'That release is' : `Those ${n} releases are`} yours to read for good, on any device.{' '}
        {result.includes_download ? 'The code includes the files too: find them under Downloads in your library.' : 'This code covers reading on AltComix; it does not include a file download.'}
      </>
    );
    action = (
      <>
        <LinkButton to={`/read/${result.release_ids[0]}`} variant="primary" size="sm" className="h-10" icon={<BookOpen className="size-4" />}>Start reading</LinkButton>
        <LinkButton to={`/series/${result.series_slug}`} size="sm" className="h-10">View the series</LinkButton>
      </>
    );
  } else if (result.kind === 'membership') {
    detail = <>You have {membershipName} until {date(result.member_until)}: everything in the membership catalogue is open to you. It ends by itself on that date and nothing is charged.</>;
    action = <LinkButton to="/account/membership" variant="primary" size="sm" className="h-10">See your membership</LinkButton>;
  } else {
    detail = <>You now have {plural(result.page_credits, 'page credit')}. Each credit opens one locked page of a pay-per-page comic; spend them from the reader when you reach a locked page.</>;
    action = <LinkButton to="/" variant="primary" size="sm" className="h-10">Find something to read</LinkButton>;
  }
  return (
    <div className="rounded-xl border border-ok/30 bg-ok-soft px-4 py-4" role="status">
      <div className="font-semibold text-ok">{result.message}</div>
      <p className="mt-1.5 text-sm text-paper">{detail}</p>
      <div className="mt-3 flex flex-wrap gap-2">
        {next ? <LinkButton to={next} variant="primary" size="sm" className="h-10">Continue</LinkButton> : action}
      </div>
    </div>
  );
}

/** Pack sizes offered; the price is always size × the per-credit price from settings. */
const CREDIT_PACKS = [20, 50, 100, 250];
/** The API refuses card payments under this, so smaller packs are not offered. */
const MIN_CARD_CHARGE = 50;

function BuyCredits({ perCredit, currency, onBought }: { perCredit: number; currency: string; onBought: () => void }) {
  const checkout = useCheckout(onBought);
  const packs = CREDIT_PACKS.filter((n) => n * perCredit >= MIN_CARD_CHARGE);
  if (perCredit <= 0 || packs.length === 0) return null;
  return (
    <Card>
      <CardHeader
        title="Buy page credits"
        description={`One credit opens one locked page of a pay-per-page comic, for good. Credits cost ${moneyExact(perCredit, currency)} each and do not expire.`}
      />
      <ul className="grid gap-3 px-5 py-5 sm:grid-cols-2 lg:grid-cols-4">
        {packs.map((n) => (
          <li key={n}>
            <button
              type="button"
              onClick={() =>
                checkout.open({
                  lines: [{ item: { kind: 'credits', quantity: n }, label: `${number(n)} page credits`, detail: `${moneyExact(perCredit, currency)} per credit`, price_cents: n * perCredit }],
                  returnTo: '/account/codes',
                  allowCode: false,
                })
              }
              className="flex w-full flex-col items-start gap-1 rounded-xl border border-line bg-ink px-4 py-3.5 text-left transition-colors hover:border-line-strong hover:bg-hover"
            >
              <span className="flex items-center gap-2 font-semibold"><Coins className="size-4 text-accent-hover" aria-hidden />{number(n)} credits</span>
              <span className="font-display text-xl font-bold tabular-nums">{moneyExact(n * perCredit, currency)}</span>
              <span className="text-xs text-muted">Buy this pack</span>
            </button>
          </li>
        ))}
      </ul>
      {checkout.dialog}
    </Card>
  );
}

export function Codes() {
  useTitle('Redeem a code');
  const qc = useQueryClient();
  const { refresh, currency, settings } = useSession();
  const [params, setParams] = useSearchParams();
  const next = params.get('next') ? safePath(params.get('next'), '') || null : null;
  const page = Math.max(1, Number(params.get('page')) || 1);
  const [code, setCode] = useState(() => params.get('code') ?? '');
  const [result, setResult] = useState<Redeemed | null>(null);
  const [error, setError] = useState<string | null>(null);

  const wallet = useQuery({ queryKey: ['wallet', page], queryFn: () => api<Wallet>('/api/account/wallet', { query: { page, limit: 20 } }) });
  const redeem = useMutation({
    mutationFn: () => api<Redeemed>('/api/codes/redeem', { json: { code } }),
    onMutate: () => {
      setError(null);
      setResult(null);
    },
    onSuccess: async (r) => {
      setResult(r);
      setCode('');
      toast.success(r.message);
      await Promise.all([qc.invalidateQueries({ queryKey: ['wallet'] }), qc.invalidateQueries({ queryKey: ['library'] }), qc.invalidateQueries({ queryKey: ['membership'] })]);
      await refresh();
    },
    onError: (e) => setError(errorMessage(e)),
  });

  const columns: Column<WalletLog>[] = [
    { key: 'when', header: 'Date', cell: (l) => <span className="whitespace-nowrap text-muted">{dateTime(l.created_at)}</span> },
    { key: 'what', header: 'What happened', cell: (l) => (
      <div className="max-w-[60vw] sm:max-w-md">
        <div>{LOG_KIND[l.kind] ?? 'Balance change'}</div>
        {l.note && <div className="truncate text-xs text-muted">{l.note}</div>}
      </div>
    ) },
    { key: 'credit', header: 'Store credit', align: 'right', cell: (l) => signed(l.credit_cents, (v) => moneyExact(v, currency)) },
    { key: 'pages', header: 'Page credits', align: 'right', cell: (l) => signed(l.page_credits, number) },
  ];

  return (
    <div className="mx-auto max-w-4xl">
      <PageHeader title="Codes and credits" description="Redeem gift cards and codes, and see what is left to spend." />
      <BillingTabs />
      <div className="space-y-6">
        <Card>
          <CardHeader title="Redeem a code" description="Gift cards, codes from creators, membership codes and page-credit codes all go in the same box." />
          <form
            className="space-y-4 px-5 py-5"
            onSubmit={(e) => {
              e.preventDefault();
              if (code.trim().length >= 4) redeem.mutate();
            }}
          >
            {result && <RedeemResult result={result} next={next} currency={currency} membershipName={settings.membership.name} />}
            {error && <ErrorState message={error} />}
            <div className="flex flex-wrap items-end gap-3">
              <Field label="Code" hint="For example ABCD-1234. Capitals and spaces do not matter." className="min-w-0 flex-1 basis-60">
                <Input
                  value={code}
                  onChange={(e) => setCode(e.target.value.toUpperCase())}
                  placeholder="ABCD-1234"
                  maxLength={40}
                  autoComplete="off"
                  autoCapitalize="characters"
                  spellCheck={false}
                  className="font-mono tracking-wider"
                  autoFocus={Boolean(params.get('code'))}
                />
              </Field>
              <Button type="submit" variant="primary" loading={redeem.isPending} disabled={code.trim().length < 4} icon={<Ticket className="size-4" />} className="mb-[22px]">Redeem</Button>
            </div>
            <p className="text-sm text-muted">
              Have a discount code instead? Those are entered at checkout. Want to give credit to someone? <Link className="link" to="/gift-cards">Buy a gift card</Link>.
            </p>
          </form>
        </Card>

        {wallet.isPending ? (
          <ListSkeleton rows={3} />
        ) : wallet.isError ? (
          <ErrorState message={errorMessage(wallet.error)} retry={() => wallet.refetch()} />
        ) : (
          <>
            <div className="grid gap-3 sm:grid-cols-2">
              <Stat label="Store credit" value={moneyExact(wallet.data.wallet.credit_cents, currency)} hint="Used automatically at checkout" />
              <Stat
                label="Page credits"
                value={number(wallet.data.wallet.page_credits)}
                hint={`One credit opens one locked page${wallet.data.page_credit_cents ? `. Buy more below, ${moneyExact(wallet.data.page_credit_cents, currency)} each` : ''}`}
              />
            </div>
            <BuyCredits
              perCredit={wallet.data.page_credit_cents}
              currency={currency}
              onBought={() => {
                void qc.invalidateQueries({ queryKey: ['wallet'] });
                void refresh();
              }}
            />
            <section aria-labelledby="wallet-log">
              <h2 id="wallet-log" className="mb-3 text-lg font-semibold">Credit history</h2>
              {wallet.data.total === 0 ? (
                <EmptyState icon={<Ticket />} title="No credit activity yet">Redeemed codes, gift cards and every credit you spend are listed here.</EmptyState>
              ) : (
                <>
                  <Table columns={columns} rows={wallet.data.log} rowKey={(l) => l.id} />
                  <Pagination
                    page={wallet.data.page}
                    pages={Math.ceil(wallet.data.total / wallet.data.limit)}
                    onPage={(p) => {
                      const n = new URLSearchParams(params);
                      n.set('page', String(p));
                      setParams(n);
                    }}
                  />
                </>
              )}
            </section>
          </>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- purchases

type OrderItem = {
  id: string; kind: string; description: string; price_cents: number; release_id: string | null; series_id: string | null; publisher_id: string | null; bundle_id: string | null;
  series_slug: string | null; series_title: string | null; publisher_slug: string | null; publisher_name: string | null; release_ids: string[];
};
type Order = {
  id: string; status: string; total_cents: number; credit_cents: number; charged_cents: number; refunded_cents: number; provider: string;
  created_at: string; paid_at: string | null; refunded_at: string | null; items: OrderItem[];
  partial_refunds?: { amount_cents: number; reason: string | null; at: string }[];
};

const orderNumber = (id: string) => id.replace(/-/g, '').slice(-8).toUpperCase();

function StatusBadge({ status }: { status: string }) {
  if (status === 'paid') return <Badge tone="ok">Paid</Badge>;
  if (status === 'refunded') return <Badge tone="warn">Refunded</Badge>;
  if (status === 'pending') return <Badge tone="info">Waiting for payment</Badge>;
  return <Badge tone="danger">{status === 'failed' ? 'Payment failed' : status}</Badge>;
}

function ItemLines({ order, currency }: { order: Order; currency: string }) {
  return (
    <ul className="divide-y divide-line text-sm">
      {order.items.map((it) => (
        <li key={it.id} className="flex items-baseline justify-between gap-4 py-2">
          <span className="min-w-0">
            {/* Each line leads to its series page (tips to the brand); a paid release can also be opened straight away. */}
            {it.series_slug ? (
              <Link to={`/series/${it.series_slug}`} className="hover:text-accent-hover hover:underline">{it.description}</Link>
            ) : it.kind === 'tip' && it.publisher_slug ? (
              <Link to={`/b/${it.publisher_slug}`} className="hover:text-accent-hover hover:underline">{it.description}</Link>
            ) : (
              it.description
            )}
            {order.status === 'paid' && (it.release_id ?? it.release_ids?.[0]) && (
              <Link to={`/read/${it.release_id ?? it.release_ids[0]}`} className="ml-2 whitespace-nowrap text-xs text-accent-hover hover:underline print:hidden">Read</Link>
            )}
          </span>
          <span className="shrink-0 tabular-nums">{moneyExact(it.price_cents, currency)}</span>
        </li>
      ))}
    </ul>
  );
}

function Totals({ order, currency }: { order: Order; currency: string }) {
  return (
    <dl className="ml-auto w-full max-w-xs space-y-1 text-sm">
      <div className="flex justify-between gap-4"><dt className="text-muted">Total</dt><dd className="tabular-nums">{moneyExact(order.total_cents, currency)}</dd></div>
      {order.credit_cents > 0 && <div className="flex justify-between gap-4"><dt className="text-muted">Store credit used</dt><dd className="tabular-nums">−{moneyExact(order.credit_cents, currency)}</dd></div>}
      <div className="flex justify-between gap-4 border-t border-line pt-1 font-semibold"><dt>{order.status === 'pending' ? 'To pay' : 'Charged'}</dt><dd className="tabular-nums">{moneyExact(order.charged_cents, currency)}</dd></div>
      {order.status === 'paid' && order.refunded_cents > 0 && (
        <div className="flex justify-between gap-4"><dt className="text-muted">Refunded to your card</dt><dd className="tabular-nums">−{moneyExact(order.refunded_cents, currency)}</dd></div>
      )}
    </dl>
  );
}

export function Purchases() {
  useTitle('Purchases');
  const { currency } = useSession();
  const [params, setParams] = useSearchParams();
  const page = Math.max(1, Number(params.get('page')) || 1);
  const orders = useQuery({ queryKey: ['orders', page], queryFn: () => api<{ items: Order[]; total: number; page: number; limit: number }>('/api/account/orders', { query: { page } }) });
  return (
    <div className="mx-auto max-w-4xl">
      <PageHeader title="Purchases" description="Everything you have bought, with a receipt for each order." />
      <BillingTabs />
      {orders.isPending ? (
        <ListSkeleton rows={3} />
      ) : orders.isError ? (
        <ErrorState message={errorMessage(orders.error)} retry={() => orders.refetch()} />
      ) : orders.data.items.length === 0 ? (
        <EmptyState icon={<ReceiptIcon />} title="No purchases yet" action={<LinkButton to="/" variant="primary">Browse the store</LinkButton>}>
          Comics, bundles, tips and gift cards you pay for are listed here with their receipts. Membership payments are on the Membership tab.
        </EmptyState>
      ) : (
        <>
          <ul className="space-y-4">
            {orders.data.items.map((o) => (
              <li key={o.id}>
                <Card>
                  <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-5 py-3.5">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <h2 className="text-base font-semibold">Order {orderNumber(o.id)}</h2>
                        <StatusBadge status={o.status} />
                        {o.status === 'paid' && o.refunded_cents > 0 && <Badge tone="warn">Partly refunded</Badge>}
                      </div>
                      <div className="mt-0.5 text-xs text-muted">
                        {dateTime(o.paid_at ?? o.created_at)}{o.refunded_at ? ` · refunded ${date(o.refunded_at)}` : ''}
                      </div>
                    </div>
                    <LinkButton to={`/account/purchases/${o.id}`} size="sm" className="h-10" icon={<ReceiptIcon className="size-4" />}>Receipt</LinkButton>
                  </div>
                  <div className="space-y-3 px-5 py-3">
                    <ItemLines order={o} currency={currency} />
                    <Totals order={o} currency={currency} />
                  </div>
                </Card>
              </li>
            ))}
          </ul>
          <Pagination page={orders.data.page} pages={Math.ceil(orders.data.total / orders.data.limit)} onPage={(p) => setParams({ page: String(p) })} />
        </>
      )}
    </div>
  );
}

const PAID_WITH: Record<string, string> = { sandbox: 'Test payment (sandbox)', divinity: 'Card', credit: 'Store credit', free: 'No payment needed' };

/**
 * Printing a receipt prints the receipt and nothing else. A second copy of it
 * is mounted straight under <body>, hidden on screen; the print rules hide
 * every other child of <body> (the whole app shell) and show that copy in
 * dark-on-white by re-pointing the colour tokens inside it.
 */
const PRINT_ID = 'receipt-print';
const PRINT_CSS = `
#${PRINT_ID} { display: none; }
@media print {
  @page { margin: 16mm; }
  html, body { background: white !important; }
  body > *:not(#${PRINT_ID}) { display: none !important; }
  #${PRINT_ID} {
    display: block !important; color: black; font-size: 12pt;
    --color-paper: black; --color-muted: #444; --color-faint: #666; --color-line: #bbb; --color-line-strong: #888;
    --color-ink: white; --color-surface: white; --color-raised: white; --color-accent-hover: black;
    --color-ok: black; --color-warn: black; --color-danger: black; --color-info: black;
    --color-ok-soft: transparent; --color-warn-soft: transparent; --color-danger-soft: transparent; --color-info-soft: transparent;
  }
  #${PRINT_ID} a { color: black; text-decoration: none; }
}`;

function ReceiptBody({ o, currency, siteName, email }: { o: Order & { failure: string | null }; currency: string; siteName: string; email: string }) {
  return (
    <>
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-line pb-4">
        <div>
          <div className="font-display text-xl font-bold">{siteName}</div>
          <div className="text-sm text-muted">Order {orderNumber(o.id)}</div>
        </div>
        <span className="flex flex-wrap gap-2">
          <StatusBadge status={o.status} />
          {o.status === 'paid' && o.refunded_cents > 0 && <Badge tone="warn">Partly refunded</Badge>}
        </span>
      </div>
      <div className="border-b border-line py-4">
        <DefList
          items={[
            ['Billed to', email],
            ['Ordered', dateTime(o.created_at)],
            ...(o.paid_at ? ([['Paid', dateTime(o.paid_at)]] as [ReactNode, ReactNode][]) : []),
            ...(o.refunded_at ? ([['Refunded', dateTime(o.refunded_at)]] as [ReactNode, ReactNode][]) : []),
            ['Paid with', o.charged_cents === 0 && o.credit_cents > 0 ? 'Store credit' : PAID_WITH[o.provider] ?? o.provider],
            ['Order reference', <span key="ref" className="break-all font-mono text-xs">{o.id}</span>],
          ]}
        />
      </div>
      <div className="py-2"><ItemLines order={o} currency={currency} /></div>
      <div className="border-t border-line pt-3"><Totals order={o} currency={currency} /></div>
      {o.status === 'paid' && (o.partial_refunds?.length ?? 0) > 0 && (
        <ul className="mt-4 space-y-1 text-sm text-muted">
          {o.partial_refunds!.map((r, i) => (
            <li key={i}>{date(r.at)}: {moneyExact(r.amount_cents, currency)} refunded to your card{r.reason ? ` (${r.reason})` : ''}. Everything from this order stays in your library.</li>
          ))}
        </ul>
      )}
      {o.status === 'failed' && o.failure && <div className="mt-4"><Notice tone="danger">{o.failure}</Notice></div>}
      {o.status === 'refunded' && <div className="mt-4"><Notice tone="warn">This order was refunded. Anything it unlocked has been removed from your library.</Notice></div>}
    </>
  );
}

export function Receipt() {
  const { orderId = '' } = useParams();
  const { currency, settings, user } = useSession();
  useTitle(`Receipt ${orderNumber(orderId)}`);
  const order = useQuery({ queryKey: ['order', orderId], queryFn: () => api<{ order: Order & { failure: string | null } }>(`/api/orders/${orderId}`) });
  const back = <Link to="/account/purchases" className="inline-flex min-h-10 items-center gap-1 hover:text-paper"><ArrowLeft className="size-4" /> All purchases</Link>;
  if (order.isPending) return <PageLoader label="Loading the receipt" />;
  if (order.isError) {
    return (
      <div className="mx-auto max-w-2xl space-y-4">
        {back}
        <ErrorState message={errorMessage(order.error)} retry={() => order.refetch()} />
      </div>
    );
  }
  const o = order.data.order;
  const body = <ReceiptBody o={o} currency={currency} siteName={settings.site.name} email={user?.email ?? ''} />;
  return (
    <div className="mx-auto max-w-2xl">
      <style>{PRINT_CSS}</style>
      <PageHeader
        back={back}
        title="Receipt"
        actions={<Button icon={<Printer className="size-4" />} onClick={() => window.print()}>Print or save as PDF</Button>}
      />
      <Card className="px-5 py-5 sm:px-7 sm:py-6">{body}</Card>
      <p className="mt-4 text-sm text-muted">Something wrong with this order? <Link className="link" to="/feedback?category=billing">Tell us</Link> and include the order number.</p>
      {createPortal(<div id={PRINT_ID} aria-hidden>{body}</div>, document.body)}
    </div>
  );
}

// ---------------------------------------------------------------- membership

type Subscription = {
  id: string; plan: 'monthly' | 'annual'; status: 'active' | 'past_due' | 'canceled' | 'expired'; price_cents: number; provider: string;
  current_period_start: string; current_period_end: string; cancel_at_period_end: boolean; canceled_at: string | null; renews_at: string | null;
  has_payment_method: boolean; from_code: boolean; payment_problem: { attempts: number; next_attempt_at: string | null; message: string | null } | null;
};
type MembershipView = {
  member: boolean;
  plans: { name: string; monthly_cents: number; annual_cents: number; trial_days: number };
  provider: string;
  subscription: Subscription | null;
  confirmation?: string | null;
};

type Payment = {
  id: string; status: 'pending' | 'paid' | 'failed' | 'refunded'; amount_cents: number; plan: 'monthly' | 'annual'; provider: string;
  period_start: string; period_end: string; date: string; paid_at: string | null; refunded_at: string | null; retrying: boolean; next_attempt_at: string | null;
};

function PaymentStatus({ p }: { p: Payment }) {
  if (p.status === 'paid') return <Badge tone="ok">Paid</Badge>;
  if (p.status === 'refunded') return <Badge tone="warn">Refunded</Badge>;
  if (p.status === 'failed') return <Badge tone="danger">Not collected</Badge>;
  return <Badge tone={p.retrying ? 'danger' : 'info'}>{p.retrying ? 'Declined, retrying' : 'Being collected'}</Badge>;
}

/** Every membership charge on the account: date, amount, status. */
function MembershipPayments({ currency }: { currency: string }) {
  const [page, setPage] = useState(1);
  const payments = useQuery({ queryKey: ['membership', 'payments', page], queryFn: () => api<{ items: Payment[]; total: number; page: number; limit: number }>('/api/account/membership-payments', { query: { page, limit: 12 } }) });
  const columns: Column<Payment>[] = [
    { key: 'date', header: 'Date', cell: (p) => <span className="whitespace-nowrap">{date(p.date)}</span> },
    { key: 'what', header: 'For', cell: (p) => <span className="whitespace-nowrap text-muted">{p.plan === 'annual' ? 'Yearly' : 'Monthly'} · {date(p.period_start)} to {date(p.period_end)}</span>, hideOnMobile: true },
    { key: 'amount', header: 'Amount', align: 'right', cell: (p) => moneyExact(p.amount_cents, currency) },
    { key: 'status', header: 'Status', cell: (p) => <PaymentStatus p={p} /> },
  ];
  return (
    <section aria-labelledby="membership-payments" className="mt-8">
      <h2 id="membership-payments" className="mb-3 text-lg font-semibold">Membership payments</h2>
      {payments.isPending ? (
        <ListSkeleton rows={2} />
      ) : payments.isError ? (
        <ErrorState message={errorMessage(payments.error)} retry={() => payments.refetch()} />
      ) : payments.data.total === 0 ? (
        <p className="rounded-xl border border-dashed border-line px-4 py-6 text-center text-sm text-muted">No membership payments yet. Each charge is listed here with its date, amount and status.</p>
      ) : (
        <>
          <Table columns={columns} rows={payments.data.items} rowKey={(p) => p.id} />
          <Pagination page={payments.data.page} pages={Math.ceil(payments.data.total / payments.data.limit)} onPage={setPage} />
        </>
      )}
    </section>
  );
}

export function Membership() {
  useTitle('Membership');
  const qc = useQueryClient();
  const confirm = useConfirm();
  const nav = useNavigate();
  const { refresh, currency } = useSession();
  const [params, setParams] = useSearchParams();
  // What the hosted card page sent back with the reader. Held in state because the URL is tidied straight away.
  const [sessionId, setSessionId] = useState(() => params.get('session_id'));
  const [onward] = useState(() => (params.get('next') ? safePath(params.get('next'), '') || null : null));
  const [cancelled] = useState(() => params.get('cancelled') === '1');
  const membership = useQuery({ queryKey: ['membership'], queryFn: () => api<MembershipView>('/api/membership', { query: { session_id: sessionId } }) });

  // Back from the hosted card page: the load confirmed the session. Tidy the URL, update the shell, and when the
  // membership is active send the reader on to where they were heading (`next`, already checked to be same-site).
  const confirmation = membership.data?.confirmation ?? null;
  const settled = Boolean(membership.data);
  useEffect(() => {
    if (!settled) return;
    if (sessionId && confirmation === 'active' && onward) {
      setSessionId(null);
      void refresh();
      toast.success('Welcome aboard. Your membership is active.');
      nav(onward, { replace: true });
      return;
    }
    if (params.get('session_id') || params.get('next') || params.get('cancelled')) setParams({}, { replace: true });
    if (!sessionId) return;
    void refresh();
    void qc.invalidateQueries({ queryKey: ['membership', 'payments'] });
    // A session still being confirmed is asked about again by "Check again"; anything else is final.
    if (confirmation !== 'pending') setSessionId(null);
  }, [settled, confirmation, sessionId, onward, params, setParams, refresh, qc, nav]);

  const apply = async (view: MembershipView) => {
    qc.setQueryData(['membership'], view);
    await refresh();
  };
  const cancel = useMutation({
    mutationFn: () => api<MembershipView>('/api/membership/cancel', { method: 'POST' }),
    onSuccess: async (v) => {
      await apply(v);
      toast.success(v.member ? 'Renewal cancelled. You keep access until the period ends.' : 'Membership cancelled');
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const resume = useMutation({
    mutationFn: () => api<MembershipView>('/api/membership/resume', { method: 'POST' }),
    onSuccess: async (v) => {
      await apply(v);
      toast.success('Membership resumed. It will renew as before.');
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const card = useMutation({
    mutationFn: () => api<{ url?: string; completed?: boolean } & Partial<MembershipView>>('/api/membership/payment-method', { method: 'POST' }),
    onSuccess: async (r) => {
      if (r.url) return void window.location.assign(r.url);
      await qc.invalidateQueries({ queryKey: ['membership'] });
      toast.success('Payment method updated');
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  let body: ReactNode;
  if (membership.isPending) body = <PageLoader label="Loading your membership" />;
  else if (membership.isError) body = <ErrorState message={errorMessage(membership.error)} retry={() => membership.refetch()} />;
  else {
    const { member, plans, subscription: sub } = membership.data;
    const conf = membership.data.confirmation;
    const returned = conf === 'active' ? <Notice tone="ok">Welcome aboard. Your membership is active.</Notice>
      : conf === 'updated' ? <Notice tone="ok">Your new payment method is saved.</Notice>
      : conf === 'pending' ? <Notice tone="info" action={<Button size="sm" className="h-10" onClick={() => membership.refetch()}>Check again</Button>}>Your card details are still being confirmed. This usually takes a few seconds.</Notice>
      : conf === 'declined' || conf === 'failed' ? <Notice tone="danger">The card was not accepted, so nothing was charged and nothing changed. You can try again with another card.</Notice>
      : cancelled ? <Notice tone="info" action={onward ? <LinkButton to={onward} size="sm" className="h-10">Go back</LinkButton> : undefined}>You left the card page before finishing, so nothing was charged and nothing changed.</Notice>
      : null;
    const live = sub && ((member && sub.status === 'active') || sub.status === 'past_due');
    if (!live || !sub) {
      body = (
        <div className="space-y-4">
          {returned}
          {sub && (
            <Notice tone={sub.status === 'expired' ? 'warn' : 'info'}>
              {sub.status === 'expired' && !sub.from_code
                ? `Your ${sub.plan} membership ended on ${date(sub.current_period_end)} because the renewal payment could not be collected. Start a new one to get back in.`
                : `Your last membership ended on ${date(sub.current_period_end)}.`}
            </Notice>
          )}
          <EmptyState
            icon={<Sparkles />}
            title={`You are not a ${plans.name} member`}
            action={<LinkButton to={onward ? `/unlimited?next=${encodeURIComponent(onward)}` : '/unlimited'} variant="primary" size="lg">See what {plans.name} includes</LinkButton>}
          >
            Read everything in the membership catalogue for {money(plans.monthly_cents, currency)} a month{plans.annual_cents ? ` or ${money(plans.annual_cents, currency)} a year` : ''}
            {plans.trial_days ? `, with ${plans.trial_days} days free to start` : ''}. Your reading pays the creators you actually read. Have a membership code?{' '}
            <Link className="link" to="/account/codes">Redeem it</Link>.
          </EmptyState>
        </div>
      );
    } else {
      const pastDue = sub.status === 'past_due';
      const ending = !pastDue && (sub.cancel_at_period_end || !sub.renews_at);
      body = (
        <div className="space-y-4">
          {returned}
          {pastDue && !sub.payment_problem && (
            <Notice tone="danger" action={<Button size="sm" className="h-10" loading={card.isPending} onClick={() => card.mutate()}>Update payment method</Button>}>
              Your renewal payment did not go through, so your membership is paused. Update your payment method to get back in.
            </Notice>
          )}
          {sub.payment_problem && (
            <Notice tone="danger" action={<Button size="sm" className="h-10" loading={card.isPending} onClick={() => card.mutate()}>Update payment method</Button>}>
              Your last payment did not go through{sub.payment_problem.message ? ` (${sub.payment_problem.message})` : ''}.{' '}
              Your membership is paused until a payment succeeds. {sub.payment_problem.next_attempt_at ? `We will try the card again on ${date(sub.payment_problem.next_attempt_at)}; ` : ''}a new card is charged straight away.
            </Notice>
          )}
          <Card>
            <CardHeader
              title={<span className="flex flex-wrap items-center gap-2">{plans.name} {pastDue ? <Badge tone="danger">Paused: payment failed</Badge> : ending && !sub.from_code ? <Badge tone="warn">Ending</Badge> : <Badge tone="ok">Active</Badge>}</span>}
              description={
                pastDue
                  ? 'You cannot read membership comics until a payment goes through. After four failed tries the membership ends.'
                  : sub.from_code
                  ? `From a code. It ends on ${date(sub.current_period_end)} and nothing is charged.`
                  : ending
                    ? `You cancelled renewal. You keep full access until ${date(sub.current_period_end)}, then it ends.`
                    : `Renews on ${date(sub.renews_at)} for ${moneyExact(sub.price_cents, currency)}.`
              }
            />
            <div className="px-5 py-5">
              <DefList
                items={[
                  ['Plan', sub.from_code ? 'Membership code' : sub.plan === 'annual' ? `Annual, ${moneyExact(sub.price_cents, currency)} a year` : `Monthly, ${moneyExact(sub.price_cents, currency)} a month`],
                  ['Current period', `${date(sub.current_period_start)} to ${date(sub.current_period_end)}`],
                  [pastDue ? 'Payment was due' : ending ? 'Access ends' : 'Next payment', date(pastDue || ending ? sub.current_period_end : sub.renews_at)],
                  ...(sub.from_code ? [] : ([['Payment method', sub.has_payment_method ? (sub.provider === 'sandbox' ? 'Test card (sandbox)' : 'Card on file') : 'None saved']] as [ReactNode, ReactNode][])),
                ]}
              />
            </div>
            {!sub.from_code && (
              <div className="flex flex-wrap items-center gap-2 border-t border-line px-5 py-4">
                {sub.cancel_at_period_end ? (
                  sub.has_payment_method && <Button variant="primary" loading={resume.isPending} onClick={() => resume.mutate()}>Resume membership</Button>
                ) : (
                  <>
                    <Button loading={card.isPending} onClick={() => card.mutate()}>Change payment method</Button>
                    <Button
                      variant="danger"
                      loading={cancel.isPending}
                      onClick={async () => {
                        const ok = await confirm({
                          title: 'Cancel your membership?',
                          body: sub.status === 'past_due' ? 'Your membership ends right away because the last payment did not go through.' : `You keep full access until ${date(sub.current_period_end)} and you will not be charged again. You can resume any time before then.`,
                          confirmLabel: 'Cancel membership',
                          danger: true,
                        });
                        if (ok) cancel.mutate();
                      }}
                    >
                      Cancel membership
                    </Button>
                  </>
                )}
              </div>
            )}
          </Card>
          <p className="text-sm text-muted">
            <Link className="link" to="/unlimited">Browse the membership catalogue</Link>
            {sub.from_code ? <> · Have another code? <Link className="link" to="/account/codes">Redeem it</Link> to add more time.</> : null}
          </p>
        </div>
      );
    }
  }

  return (
    <div className="mx-auto max-w-4xl">
      <PageHeader title="Membership" description="Your plan, when it renews and how to change it." />
      <BillingTabs />
      {body}
      <MembershipPayments currency={currency} />
    </div>
  );
}
