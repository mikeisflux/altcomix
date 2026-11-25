import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { BookOpen, Check, HandCoins, PieChart, Sparkles } from 'lucide-react';
import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { api, errorMessage } from '@/lib/api';
import { date, money, moneyExact, percent } from '@/lib/format';
import { useSession } from '@/lib/session';
import { Badge, Button, Card, ErrorState, LinkButton, Notice, cx, toast } from '@/ui';
import { membershipCheck, useCheckoutSurface, useSecureCheckout } from './SecureCheckout';
import type { CheckoutSurface } from './SecureCheckout';
import { CoverCard } from './cards';
import type { SeriesCard } from './cards';
import { ConfirmEmailPrompt, SHELF_ITEM, SectionLink, Shelf, isEmailUnverified, safeNext, useLoginLink, useTitle } from './shared';
import { LocationFields, useBillingLocation } from './tax';
import type { TaxQuote } from './tax';

type Plan = 'monthly' | 'annual';
type Membership = {
  member: boolean;
  plans: { name: string; monthly_cents: number; annual_cents: number; trial_days: number };
  provider: string;
  subscription: {
    plan: Plan; status: string; price_cents: number; current_period_end: string; cancel_at_period_end: boolean; renews_at: string | null; from_code: boolean;
    payment_problem: { attempts: number; next_attempt_at: string | null; message: string | null } | null;
  } | null;
};
/** POST /api/membership/quote: each plan with sales tax at a billing location. `tax` is null while sales tax is off. */
type PlanTax = TaxQuote & { price_cents: number; total_cents: number };
type MembershipQuote = { tax: { monthly: PlanTax; annual: PlanTax } | null };
type StartResult = { completed?: boolean; url?: string; session_id?: string; surface?: CheckoutSurface; status?: string; next?: string | null };

export function Unlimited() {
  const { user, settings, currency, refresh } = useSession();
  const m = settings.membership;
  useTitle(m.name);
  const nav = useNavigate();
  const qc = useQueryClient();
  const login = useLoginLink();
  const [params] = useSearchParams();
  const next = params.get('next');
  const [plan, setPlan] = useState<Plan>('annual');

  const mine = useQuery({ queryKey: ['membership', user?.id], queryFn: () => api<Membership>('/api/membership'), enabled: Boolean(user) });
  const catalog = useQuery({
    queryKey: ['browse', 'membership-preview'],
    queryFn: () => api<{ items: SeriesCard[]; total: number }>('/api/series', { query: { access: 'membership', sort: 'popular', limit: 18 } }),
  });

  const [unverified, setUnverified] = useState<string | null>(null);
  const surface = useCheckoutSurface();
  const secure = useSecureCheckout();
  const notMember = Boolean(user) && mine.isSuccess && !mine.data.member;
  // Sales tax: where the member is decides the tax on the first charge and on every renewal. Nothing here exists while it is off.
  const billing = useBillingLocation(notMember);
  const taxQuote = useQuery({
    queryKey: ['membership-quote', billing.location],
    queryFn: () => api<MembershipQuote>('/api/membership/quote', { json: { location: billing.location ?? undefined } }),
    enabled: billing.enabled && billing.ready,
    retry: false,
    placeholderData: (prev) => prev,
  });
  const locationError = taxQuote.isError && (taxQuote.error as { code?: string } | null)?.code === 'location_invalid' ? errorMessage(taxQuote.error) : null;
  const planTax = billing.enabled && billing.location && !taxQuote.isError && !taxQuote.isPlaceholderData ? taxQuote.data?.tax?.[plan] ?? null : null;
  const start = useMutation({
    // `next` goes with the request so a reader who pays on the checkout page is brought back to where they were.
    mutationFn: () => api<StartResult>('/api/membership/start', { json: { plan, next: safeNext(next, '') || undefined, surface, location: billing.enabled ? billing.location ?? undefined : undefined } }),
    onMutate: () => setUnverified(null),
    onSuccess: async (r) => {
      if (r.url && r.session_id) {
        const yearly = plan === 'annual';
        const taxed = planTax && planTax.tax_cents > 0 && planTax.label ? planTax : null;
        // With sales tax, what is charged each time is the plan price plus the tax.
        const price = taxed ? moneyExact(taxed.total_cents, currency) : money(yearly ? m.annual_cents : m.monthly_cents, currency);
        const every = yearly ? 'year' : 'month';
        const onward = safeNext(r.next ?? next, '/browse?access=membership');
        secure.open({
          session: { url: r.url, session_id: r.session_id, surface: r.surface ?? 'redirect' },
          lines: [{ label: m.name, detail: `${yearly ? 'Yearly' : 'Monthly'} plan, renews until you cancel`, amount: `${money(yearly ? m.annual_cents : m.monthly_cents, currency)} a ${every}` }],
          totals: [
            ...(taxed ? [{ label: 'Subtotal', amount: moneyExact(taxed.price_cents, currency) }, { label: taxed.label!, amount: moneyExact(taxed.tax_cents, currency) }] : []),
            { label: m.trial_days > 0 ? `Due today (${m.trial_days} days free first)` : 'Due today', amount: m.trial_days > 0 ? money(0, currency) : price },
          ],
          payLabel: m.trial_days > 0 ? undefined : price,
          note: m.trial_days > 0
            ? `Your card is saved now and first charged ${price} when your ${m.trial_days} free days end, then every ${every} until you cancel.`
            : `Your card is saved and charged ${price} now, then every ${every} until you cancel. Cancel in two clicks from your account.`,
          check: membershipCheck(r.session_id),
          onPaid: () => void toast.success(`Welcome to ${m.name}`),
          success: {
            title: `Welcome to ${m.name}`,
            body: 'Your membership is active. Everything in the membership catalog is open to you now.',
            action: { label: next ? 'Back to reading' : 'Browse the catalog', to: onward },
          },
          onRetry: () => start.mutate(),
        });
        return;
      }
      await refresh();
      await qc.invalidateQueries();
      toast.success(`Welcome to ${m.name}`);
      nav(safeNext(r.next ?? next, '/browse?access=membership'), { replace: Boolean(next) });
    },
    onError: (e) => (isEmailUnverified(e) ? setUnverified(errorMessage(e)) : toast.error(errorMessage(e))),
  });

  const yearAtMonthly = m.monthly_cents * 12;
  const saving = yearAtMonthly - m.annual_cents;
  const sub = mine.data?.subscription;
  const isMember = mine.data?.member ?? user?.member ?? false;

  const plans: { id: Plan; title: string; price: string; per: string; note: string }[] = [
    { id: 'annual', title: 'Yearly', price: money(m.annual_cents, currency), per: 'per year', note: `Works out at ${money(Math.round(m.annual_cents / 12), currency)} a month` },
    { id: 'monthly', title: 'Monthly', price: money(m.monthly_cents, currency), per: 'per month', note: 'Cancel any time' },
  ];

  return (
    <div className="mx-auto max-w-5xl space-y-12">
      {secure.dialog}
      <header className="relative -mx-4 -mt-6 overflow-hidden border-b border-line bg-gradient-to-br from-accent-soft via-ink to-ink px-4 py-12 text-center sm:-mx-6 sm:px-6 sm:py-16 lg:-mx-8 lg:px-8">
        <div className="mx-auto max-w-2xl">
          <div className="mx-auto mb-4 flex size-12 items-center justify-center rounded-2xl bg-accent text-accent-ink"><Sparkles className="size-6" aria-hidden /></div>
          <h1 className="text-4xl font-extrabold sm:text-5xl">{m.name}</h1>
          <p className="mt-4 text-lg text-paper/85">One membership, every comic in the membership catalog, and your money goes to the creators you actually read.</p>
        </div>
      </header>

      {/* Join / status */}
      <section aria-label="Membership" className="mx-auto max-w-2xl">
        {user && mine.isError ? (
          <ErrorState message={errorMessage(mine.error)} retry={() => void mine.refetch()} />
        ) : isMember ? (
          <Card className="p-6 text-center">
            <Badge tone="ok"><Check className="size-3" aria-hidden />Active</Badge>
            <h2 className="mt-3 text-2xl font-bold">You are a member</h2>
            {sub && (
              <p className="mt-2 text-muted">
                {sub.from_code ? 'Membership from a code' : `${sub.plan === 'annual' ? 'Yearly' : 'Monthly'} plan, ${money(sub.price_cents, currency)}${settings.tax?.enabled ? ' plus tax where it applies' : ''}`}.{' '}
                {sub.renews_at ? `Renews on ${date(sub.renews_at)}.` : `Access runs until ${date(sub.current_period_end)} and will not renew.`}
              </p>
            )}
            {sub?.payment_problem && <div className="mt-4 text-left"><Notice tone="warn">Your last renewal payment did not go through. Update your card to keep your membership.</Notice></div>}
            <div className="mt-5 flex flex-wrap justify-center gap-2">
              <LinkButton to={safeNext(next, '/browse?access=membership')} variant="primary" icon={<BookOpen className="size-4" />}>{next ? 'Back to reading' : 'Browse the catalog'}</LinkButton>
              <LinkButton to="/account/membership">Manage membership</LinkButton>
            </div>
          </Card>
        ) : (
          <Card className="p-5 sm:p-6">
            <h2 className="text-xl font-bold">Choose how to pay</h2>
            <div role="radiogroup" aria-label="Plan" className="mt-4 grid gap-3 sm:grid-cols-2">
              {plans.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  role="radio"
                  aria-checked={plan === p.id}
                  onClick={() => setPlan(p.id)}
                  className={cx('relative rounded-xl border p-4 text-left transition-colors', plan === p.id ? 'border-accent bg-accent-soft' : 'border-line bg-ink hover:border-line-strong')}
                >
                  <span className="flex items-center justify-between gap-2">
                    <span className="font-semibold">{p.title}</span>
                    {p.id === 'annual' && saving > 0 && <Badge tone="sun">Save {percent(saving / yearAtMonthly)}</Badge>}
                  </span>
                  <span className="mt-2 block"><span className="font-display text-3xl font-extrabold">{p.price}</span> <span className="text-sm text-muted">{p.per}{settings.tax?.enabled ? ', plus tax where it applies' : ''}</span></span>
                  <span className="mt-1 block text-sm text-muted">{p.note}{p.id === 'annual' && saving > 0 ? `, ${money(saving, currency)} less than paying monthly` : ''}</span>
                </button>
              ))}
            </div>
            {m.trial_days > 0 && <p className="mt-3 text-sm text-muted">New members get {m.trial_days} days free before the first payment.</p>}
            {billing.enabled && (
              <div className="mt-5 space-y-3" data-testid="membership-tax">
                <LocationFields value={billing.draft} onChange={billing.change} error={locationError} disabled={start.isPending} note="Used to work out sales tax on each payment. You can change it later from your account." />
                {planTax && (
                  <dl className="space-y-1.5 border-t border-line pt-3 text-sm" aria-live="polite">
                    {planTax.tax_cents > 0 && planTax.label && (
                      <>
                        <div className="flex justify-between gap-4"><dt className="text-muted">Subtotal</dt><dd className="tabular-nums">{moneyExact(planTax.price_cents, currency)}</dd></div>
                        <div className="flex justify-between gap-4"><dt className="text-muted">{planTax.label}</dt><dd className="tabular-nums">{moneyExact(planTax.tax_cents, currency)}</dd></div>
                      </>
                    )}
                    <div className="flex justify-between gap-4 text-base font-semibold">
                      <dt>Total {plan === 'annual' ? 'per year' : 'per month'}</dt>
                      <dd className="tabular-nums">{moneyExact(planTax.total_cents, currency)}</dd>
                    </div>
                  </dl>
                )}
              </div>
            )}
            <div className="mt-5">
              {user ? (
                <Button variant="primary" size="lg" block loading={start.isPending} disabled={!user.email_verified || (billing.enabled && !planTax)} onClick={() => start.mutate()}>
                  {billing.enabled && !planTax
                    ? billing.location && !taxQuote.isError ? 'Working out the tax…' : 'Add your location to continue'
                    : <>Start {plan === 'annual' ? 'yearly' : 'monthly'} membership · {planTax ? moneyExact(planTax.total_cents, currency) : money(plan === 'annual' ? m.annual_cents : m.monthly_cents, currency)}</>}
                </Button>
              ) : (
                <LinkButton to={login} variant="primary" size="lg" block>Sign in to become a member</LinkButton>
              )}
            </div>
            {user && (unverified || !user.email_verified) && (
              <div className="mt-3"><ConfirmEmailPrompt message={unverified ?? `Confirm your email to start a membership. We sent a link to ${user.email} when you signed up.`} onConfirmed={() => setUnverified(null)} /></div>
            )}
            {sub && !isMember && <p className="mt-3 text-sm text-muted">Your previous membership ended on {date(sub.current_period_end)}.</p>}
            <p className="mt-3 text-xs text-faint">
              Renews automatically until you cancel. Cancel in two clicks from your account and keep access until the end of the period you paid for. Have a membership code? <Link to="/account/codes" className="link">Redeem it here</Link>.
            </p>
          </Card>
        )}
      </section>

      {/* What it is */}
      <section aria-labelledby="how-h">
        <h2 id="how-h" className="mb-5 text-center text-2xl font-bold">What you get, in plain terms</h2>
        <div className="grid gap-4 md:grid-cols-3">
          <Card className="p-5">
            <BookOpen className="size-6 text-accent-hover" aria-hidden />
            <h3 className="mt-3 text-lg font-semibold">Read the whole membership catalog</h3>
            <p className="mt-1.5 text-sm text-muted">Every release that a creator has put into the membership opens in full while you are a member. Look for the Unlimited badge on covers.</p>
          </Card>
          <Card className="p-5">
            <PieChart className="size-6 text-accent-hover" aria-hidden />
            <h3 className="mt-3 text-lg font-semibold">Your fee follows your reading</h3>
            <p className="mt-1.5 text-sm text-muted">
              Each month your own fee, less card fees and the platform's cut, is divided between the series you read as a member, in proportion to the pages you read. Read only one creator and that creator gets all of it. Your money is never pooled and handed out by site-wide popularity.
            </p>
          </Card>
          <Card className="p-5">
            <HandCoins className="size-6 text-accent-hover" aria-hidden />
            <h3 className="mt-3 text-lg font-semibold">What it does not include</h3>
            <p className="mt-1.5 text-sm text-muted">Creators decide what goes in. Titles outside the membership are still bought one by one, and downloads to keep are sold separately. In a month where you read nothing, your fee is shared across everything members read that month.</p>
          </Card>
        </div>
      </section>

      {/* A taste of the catalog */}
      {catalog.data && catalog.data.items.length > 0 && (
        <Shelf id="in-membership" title="In the membership now" subtitle={`${catalog.data.total} series and counting`} action={<SectionLink to="/browse?access=membership">View all</SectionLink>}>
          {catalog.data.items.map((s) => <CoverCard key={s.id} series={s} className={SHELF_ITEM} />)}
        </Shelf>
      )}
    </div>
  );
}
