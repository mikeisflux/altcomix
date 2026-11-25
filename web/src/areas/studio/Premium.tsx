import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { BarChart3, Check, Lock, Printer } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router';
import { ApiError, api, errorMessage } from '@/lib/api';
import { date, moneyExact } from '@/lib/format';
import { useSession } from '@/lib/session';
import { Badge, Button, Card, CardHeader, DefList, LinkButton, Notice, Table, toast, useConfirm } from '@/ui';
import { useCheckoutSurface, useSecureCheckout } from '../store/SecureCheckout';
import type { CheckoutSurface, PaymentCheck } from '../store/SecureCheckout';
import { LocationFields, describeLocation, locationBody, useBillingLocation } from '../store/tax';
import type { BillingLocation, LocationDraft, TaxQuote } from '../store/tax';
import { BrandPage, Q, studioError, useBrand } from './shared';

/**
 * Creator Premium in the Studio: the optional yearly plan for a brand. It
 * unlocks the print edition link on releases and the advanced analytics.
 * Everything else in the Studio is free and stays free.
 *
 * `usePremium` is what the locked features ask; the server enforces the same
 * answer (402 `premium_required`), so nothing here is a gate by itself.
 */

type YearTax = TaxQuote & { price_cents: number; total_cents: number };
type PremiumTax = { enabled: boolean; location: BillingLocation | null; state_name: string | null; annual: YearTax };
type PremiumCharge = { id: string; period_start: string; period_end: string; amount_cents: number; tax_cents: number; total_cents: number; tax_label: string | null; status: 'paid' | 'refunded'; paid_at: string | null; refunded_at: string | null };
export type PremiumView = {
  brand: { id: string; slug: string; name: string };
  active: boolean;
  product: { name: string; annual_cents: number };
  role: string;
  /** Owner or admin of the brand (or a platform admin): may cancel and resume. */
  can_manage: boolean;
  /** On the brand's team as owner or admin: may subscribe and change the card. */
  can_pay: boolean;
  tax: PremiumTax | null;
  provider: string;
  saved_print_links: number;
  /** Premium given by the platform without payment. `ends_at` null: no end date. */
  grant: null | { granted_by: string; started_at: string; ends_at: string | null };
  /** The brand's own paid plan (the latest one). */
  subscription: null | {
    id: string; status: 'active' | 'past_due' | 'canceled' | 'expired'; price_cents: number;
    current_period_start: string; current_period_end: string; cancel_at_period_end: boolean; canceled_at: string | null; renews_at: string | null;
    has_payment_method: boolean; paid_by: string | null; paid_by_you: boolean;
    payment_problem: { attempts: number; next_attempt_at: string | null; message: string | null } | null;
  };
  charges: PremiumCharge[];
  confirmation: string | null;
  confirmation_message: string | null;
};
type StartResult = Partial<PremiumView> & { completed?: boolean; url?: string; session_id?: string; surface?: CheckoutSurface };

export const premiumKey = (brandId: string) => ['studio', 'premium', brandId];
const premiumUrl = (brandId: string) => `/api/studio/brands/${brandId}/premium`;

/** The brand's plan. Shared by the Premium page and every locked feature. */
export function usePremium(brandId: string) {
  return useQuery({ queryKey: premiumKey(brandId), queryFn: () => api<PremiumView>(premiumUrl(brandId)), staleTime: 15_000 });
}

/** The server refused something because the brand has no Creator Premium. */
export const isPremiumRequired = (e: unknown) => e instanceof ApiError && e.code === 'premium_required';

/** "140.00 a year" with "plus tax where it applies" while sales tax is on. */
export function usePremiumPrice(): { name: string; text: string } {
  const { settings, currency } = useSession();
  const p = settings.creator_premium ?? { name: 'Creator Premium', annual_cents: 14000 };
  return { name: p.name, text: `${moneyExact(p.annual_cents, currency)} a year${settings.tax?.enabled ? ', plus tax where it applies' : ''}` };
}

/** A locked feature: what it would show, the price, and the way to the Premium page. Never a dead end. */
export function PremiumLock({ title, children, compact }: { title: string; children: ReactNode; compact?: boolean }) {
  const { brand } = useBrand();
  const price = usePremiumPrice();
  return (
    <Card className={compact ? 'p-4' : 'p-5 sm:p-8'} data-testid="premium-lock">
      <div className={compact ? 'flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between' : 'mx-auto flex max-w-xl flex-col items-center gap-3 text-center'}>
        {!compact && <span className="flex size-11 items-center justify-center rounded-full border border-line bg-raised text-muted"><Lock className="size-5" aria-hidden /></span>}
        <div className="min-w-0">
          <h2 className="text-base font-semibold">{title}</h2>
          <div className="mt-1 text-sm text-muted">{children}</div>
          <p className="mt-2 text-xs text-faint">Part of {price.name}: {price.text}, per brand. Optional. Publishing stays free.</p>
        </div>
        <LinkButton to={`/studio/${brand.slug}/premium`} variant="primary" className="shrink-0">See {price.name}</LinkButton>
      </div>
    </Card>
  );
}

/** A small "this is locked" line that sits where a button would be. */
export function PremiumHint({ children }: { children: ReactNode }) {
  const { brand } = useBrand();
  return (
    <Link to={`/studio/${brand.slug}/premium`} className="inline-flex min-h-8 items-center gap-1.5 rounded-md border border-line px-3 text-[13px] text-muted hover:bg-hover hover:text-paper" data-testid="premium-hint">
      <Lock className="size-3.5 shrink-0" aria-hidden />{children}
    </Link>
  );
}

function premiumCheck(brandId: string, sessionId: string): () => Promise<PaymentCheck> {
  return async () => {
    const r = await api<PremiumView>(premiumUrl(brandId), { query: { session_id: sessionId } });
    const c = r.confirmation;
    if (c === 'active' || c === 'updated') return { state: 'paid' };
    if (c === 'declined' || c === 'failed') return { state: 'failed', message: r.confirmation_message ?? 'The card was not accepted, so nothing was charged and nothing changed.' };
    if (c === 'expired' || c === 'canceled') return { state: c, message: r.confirmation_message };
    return { state: 'pending' };
  };
}

const INCLUDED: { icon: ReactNode; title: string; body: string }[] = [
  { icon: <Printer className="size-5" aria-hidden />, title: '“Buy in print” links', body: 'Add a link to the print edition on any release. Readers see it on your series page and at the end of the issue.' },
  { icon: <BarChart3 className="size-5" aria-hidden />, title: 'Advanced analytics', body: 'Where readers stop in each release, reader countries, followers, engagement and email statistics, plus CSV export of every analytics view.' },
];

function Included() {
  return (
    <Card>
      <CardHeader title="What it includes" description="For everyone on this brand's team, for as long as the plan is active." />
      <ul className="grid gap-4 px-5 py-5 sm:grid-cols-2">
        {INCLUDED.map((f) => (
          <li key={f.title} className="flex gap-3">
            <span className="flex size-10 shrink-0 items-center justify-center rounded-xl border border-line bg-raised text-accent-hover">{f.icon}</span>
            <span className="min-w-0"><span className="block font-semibold">{f.title}</span><span className="mt-0.5 block text-sm text-muted">{f.body}</span></span>
          </li>
        ))}
      </ul>
      <p className="flex items-start gap-2 border-t border-line px-5 py-4 text-sm text-muted">
        <Check className="mt-0.5 size-4 shrink-0 text-ok" aria-hidden />
        <span>Free for every creator, with or without this plan: publishing, selling, payouts, the analytics overview, earnings and page reads.</span>
      </p>
    </Card>
  );
}

function LocationEditor({ location, onSaved, onClose }: { location: BillingLocation | null; onSaved: () => void | Promise<void>; onClose: () => void }) {
  const [draft, setDraft] = useState<LocationDraft>({ country: location?.country ?? '', state: location?.state ?? '', zip: location?.zip ?? '' });
  const body = locationBody(draft);
  const save = useMutation({
    mutationFn: () => api('/api/billing-location', { method: 'PUT', json: body }),
    onSuccess: async () => {
      await onSaved();
      onClose();
      toast.success('Billing location saved. It applies from your next payment.');
    },
  });
  return (
    <div className="mt-4 max-w-md space-y-3 rounded-xl border border-line bg-ink p-4">
      <h3 className="text-sm font-semibold">Billing location</h3>
      <LocationFields value={draft} onChange={(d) => { setDraft(d); save.reset(); }} error={save.isError ? errorMessage(save.error) : null} disabled={save.isPending} note="Sales tax on the next payment is worked out from this." />
      <div className="flex gap-2">
        <Button variant="primary" size="sm" className="h-10" loading={save.isPending} disabled={!body} onClick={() => save.mutate()}>Save location</Button>
        <Button variant="ghost" size="sm" className="h-10" disabled={save.isPending} onClick={onClose}>Cancel</Button>
      </div>
    </div>
  );
}

export function PremiumPage() {
  const { brand } = useBrand();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const { currency } = useSession();
  const [params, setParams] = useSearchParams();
  // What the hosted card page sent back. Held in state because the URL is tidied straight away.
  const [sessionId, setSessionId] = useState(() => params.get('session_id'));
  const [cancelled] = useState(() => params.get('cancelled') === '1');
  const [editingLocation, setEditingLocation] = useState(false);
  const key = premiumKey(brand.id);
  const premium = useQuery({ queryKey: [...key, 'page', sessionId], queryFn: () => api<PremiumView>(premiumUrl(brand.id), { query: { session_id: sessionId ?? undefined } }) });
  const view = premium.data;
  const m = (c: number) => moneyExact(c, currency);

  useEffect(() => {
    if (!view) return;
    if (params.get('session_id') || params.get('cancelled')) setParams({}, { replace: true });
    // A session still being confirmed is asked about again by "Check again"; anything else is final.
    if (sessionId && view.confirmation !== 'pending') void qc.invalidateQueries({ queryKey: ['studio'] });
  }, [view, sessionId, params, setParams, qc]);

  const apply = async (v: Partial<PremiumView>) => {
    if (v.brand) qc.setQueryData([...key, 'page', sessionId], { ...v, confirmation: null, confirmation_message: null });
    setSessionId(null);
    await qc.invalidateQueries({ queryKey: ['studio'] });
  };

  // Sales tax: the payer's location decides the tax on the first charge and every renewal. Nothing here exists while it is off.
  const paidLive = (v: PremiumView) => Boolean(v.subscription) && (v.subscription!.status === 'past_due' || (v.subscription!.status === 'active' && new Date(v.subscription!.current_period_end).getTime() > Date.now()));
  const offering = Boolean(view && view.can_pay && !view.grant && !paidLive(view));
  const billing = useBillingLocation(offering);
  const quote = useQuery({
    queryKey: [...key, 'quote', billing.location],
    queryFn: () => api<{ tax: PremiumTax | null }>(`${premiumUrl(brand.id)}/quote`, { json: { location: billing.location ?? undefined } }),
    enabled: offering && billing.enabled && billing.ready,
    retry: false,
    placeholderData: (prev) => prev,
  });
  const locationError = quote.isError && (quote.error as { code?: string } | null)?.code === 'location_invalid' ? errorMessage(quote.error) : null;
  const yearTax = billing.enabled && billing.location && !quote.isError && !quote.isPlaceholderData ? quote.data?.tax?.annual ?? null : null;

  const surface = useCheckoutSurface();
  const secure = useSecureCheckout();
  const name = view?.product.name ?? 'Creator Premium';
  const start = useMutation({
    mutationFn: () => api<StartResult>(`${premiumUrl(brand.id)}/start`, { json: { surface, location: billing.enabled ? billing.location ?? undefined : undefined } }),
    onSuccess: async (r) => {
      if (r.url && r.session_id && view) {
        const taxed = yearTax && yearTax.tax_cents > 0 && yearTax.label ? yearTax : null;
        const price = m(taxed ? taxed.total_cents : view.product.annual_cents);
        secure.open({
          session: { url: r.url, session_id: r.session_id, surface: r.surface ?? 'redirect' },
          lines: [{ label: `${name} for ${brand.name}`, detail: 'Yearly plan, renews until you cancel', amount: `${m(view.product.annual_cents)} a year` }],
          totals: [
            ...(taxed ? [{ label: 'Subtotal', amount: m(taxed.price_cents) }, { label: taxed.label!, amount: m(taxed.tax_cents) }] : []),
            { label: 'Due today', amount: price },
          ],
          payLabel: price,
          note: `Your card is saved and charged ${price} now, then once a year until you cancel. Cancel any time in the Studio and keep ${name} until the end of the paid year.`,
          check: premiumCheck(brand.id, r.session_id),
          onPaid: () => void toast.success(`${name} is active for ${brand.name}`),
          success: { title: `${name} is active`, body: 'Print edition links and the advanced analytics are open for your whole team now.', action: { label: 'Open analytics', to: `/studio/${brand.slug}/analytics` } },
          onRetry: () => start.mutate(),
        });
        return;
      }
      await apply(r);
      toast.success(`${name} is active for ${brand.name}`);
    },
    onError: (e) => studioError(e),
  });
  const card = useMutation({
    mutationFn: () => api<StartResult>(`${premiumUrl(brand.id)}/payment-method`, { json: { surface } }),
    onSuccess: async (r) => {
      if (r.url && r.session_id && view?.subscription) {
        const overdue = view.subscription.status === 'past_due';
        secure.open({
          session: { url: r.url, session_id: r.session_id, surface: r.surface ?? 'redirect' },
          lines: [{ label: `${name} payment method`, detail: 'Replaces the card we have on file' }],
          note: overdue ? 'The overdue payment is collected from the new card straight away.' : 'Nothing is charged now. The new card is used from the next renewal.',
          check: premiumCheck(brand.id, r.session_id),
          onPaid: () => void toast.success('Payment method updated'),
          success: { title: 'Payment method updated', body: overdue ? `The new card is saved and the overdue payment went through. ${name} is active again.` : 'The new card is saved and will be used from the next renewal.' },
          onRetry: () => card.mutate(),
        });
        return;
      }
      await apply(r);
      toast.success('Payment method updated');
    },
    onError: (e) => studioError(e),
  });
  const cancel = useMutation({
    mutationFn: () => api<PremiumView>(`${premiumUrl(brand.id)}/cancel`, { method: 'POST' }),
    onSuccess: async (v) => {
      await apply(v);
      toast.success(v.active ? `Renewal canceled. ${name} stays on until the paid year ends.` : `${name} canceled`);
    },
    onError: (e) => studioError(e),
  });
  const resume = useMutation({
    mutationFn: () => api<PremiumView>(`${premiumUrl(brand.id)}/resume`, { method: 'POST' }),
    onSuccess: async (v) => {
      await apply(v);
      toast.success(`${name} resumed. It will renew as before.`);
    },
    onError: (e) => studioError(e),
  });

  return (
    <BrandPage title="Creator Premium">
      {secure.dialog}
      <Q query={premium}>
        {(d) => {
          const sub = d.subscription;
          const taxOn = Boolean(d.tax) || billing.enabled;
          const plusTax = taxOn ? ', plus tax where it applies' : '';
          const conf = d.confirmation;
          const returned = conf === 'active' ? <Notice tone="ok">{d.product.name} is active for {brand.name}.</Notice>
            : conf === 'updated' ? <Notice tone="ok">The new payment method is saved.</Notice>
            : conf === 'pending' ? <Notice tone="info" action={<Button size="sm" className="h-10" onClick={() => premium.refetch()}>Check again</Button>}>Your card details are still being confirmed. This usually takes a few seconds.</Notice>
            : conf === 'declined' || conf === 'failed' ? <Notice tone="danger">{d.confirmation_message ?? 'The card was not accepted, so nothing was charged and nothing changed.'} You can try again with another card.</Notice>
            : conf === 'expired' ? <Notice tone="info">The secure checkout timed out before you finished, so nothing was charged and nothing changed.</Notice>
            : cancelled || conf === 'canceled' ? <Notice tone="info">You left the secure checkout before finishing, so nothing was charged and nothing changed.</Notice>
            : null;
          const pastDue = sub?.status === 'past_due';
          const live = paidLive(d);
          const ending = live && !pastDue && sub!.cancel_at_period_end;
          const grant = d.grant;
          const renewalTax = d.tax?.annual && sub?.paid_by_you ? d.tax.annual : null;
          const renewalText = sub
            ? renewalTax && renewalTax.tax_cents > 0
              ? `${m(sub.price_cents + renewalTax.tax_cents)} (${m(sub.price_cents)} plus ${m(renewalTax.tax_cents)} sales tax)`
              : `${m(sub.price_cents)}${plusTax}`
            : '';
          const hidden = d.saved_print_links > 0 && !d.active
            ? `${d.saved_print_links} print edition ${d.saved_print_links === 1 ? 'link is' : 'links are'} saved on your releases and hidden from readers. ${d.saved_print_links === 1 ? 'It shows' : 'They show'} again as soon as ${d.product.name} is active.`
            : null;

          const status = live && sub ? (
            <Card data-testid="premium-status">
              <CardHeader
                title={<span className="flex flex-wrap items-center gap-2">{d.product.name} {pastDue ? <Badge tone="danger">{grant ? 'Payment failed' : 'Paused: payment failed'}</Badge> : ending ? <Badge tone="warn">Canceled, ends {date(sub.current_period_end)}</Badge> : <Badge tone="ok">Active</Badge>}</span>}
                description={
                  pastDue ? (grant ? 'The renewal payment for the paid plan did not go through. After four failed tries the paid plan ends. The grant above keeps the features on meanwhile.' : 'The features are paused until a payment goes through. After four failed tries the plan ends. Your saved links and data are kept.')
                    : ending ? `Renewal is canceled. ${brand.name} keeps ${d.product.name} until ${date(sub.current_period_end)}, then it ends. The card will not be charged again.`
                    : `Active until ${date(sub.current_period_end)}. Renews on ${date(sub.renews_at)} for ${renewalText}.`
                }
              />
              <div className="px-5 py-5">
                <DefList
                  items={[
                    ['Plan', `Yearly, ${m(sub.price_cents)} a year${plusTax}, for ${brand.name}`],
                    ['Current period', `${date(sub.current_period_start)} to ${date(sub.current_period_end)}`],
                    [pastDue ? 'Payment was due' : ending ? 'Ends on' : 'Renews on', date(pastDue || ending ? sub.current_period_end : sub.renews_at)],
                    ['Paid by', sub.paid_by_you ? 'You' : sub.paid_by ?? 'A team member'],
                    ['Payment method', sub.has_payment_method ? (d.provider === 'sandbox' ? 'Test card (sandbox)' : 'Card on file') : 'None saved'],
                    ...(d.tax && sub.paid_by_you
                      ? ([['Billing location', (
                          <span key="loc" className="flex flex-wrap items-center gap-x-3">
                            <span>{describeLocation(d.tax.location)}</span>
                            {!editingLocation && <button type="button" className="link min-h-10 text-sm" onClick={() => setEditingLocation(true)}>{d.tax.location ? 'Change' : 'Add'}</button>}
                          </span>
                        )]] as [ReactNode, ReactNode][])
                      : []),
                  ]}
                />
                {d.tax && sub.paid_by_you && editingLocation && <LocationEditor location={d.tax.location} onSaved={() => apply({})} onClose={() => setEditingLocation(false)} />}
              </div>
              {d.can_manage && (
                <div className="flex flex-wrap items-center gap-2 border-t border-line px-5 py-4">
                  {sub.cancel_at_period_end ? (
                    sub.has_payment_method && <Button variant="primary" loading={resume.isPending} onClick={() => resume.mutate()}>Resume {d.product.name}</Button>
                  ) : (
                    <>
                      {d.can_pay && <Button variant={pastDue ? 'primary' : 'secondary'} loading={card.isPending} onClick={() => card.mutate()}>{pastDue ? 'Update the card' : 'Change card'}</Button>}
                      <Button
                        variant="danger"
                        loading={cancel.isPending}
                        onClick={async () => {
                          const ok = await confirm({
                            title: `Cancel ${d.product.name}?`,
                            body: pastDue
                              ? 'The plan ends right away because the last payment did not go through. Saved print links are kept but stay hidden from readers.'
                              : `${brand.name} keeps ${d.product.name} until ${date(sub.current_period_end)} and the card is not charged again. After that, saved print links are kept but hidden from readers, and the advanced analytics close. You can resume any time before then.`,
                            confirmLabel: `Cancel ${d.product.name}`,
                            danger: true,
                          });
                          if (ok) cancel.mutate();
                        }}
                      >
                        Cancel {d.product.name}
                      </Button>
                    </>
                  )}
                </div>
              )}
              {!d.can_manage && <p className="border-t border-line px-5 py-4 text-sm text-muted">Owners and admins of {brand.name} can change the card or cancel.</p>}
            </Card>
          ) : null;

          const granted = grant ? (
            <Card data-testid="premium-grant">
              <CardHeader
                title={<span className="flex flex-wrap items-center gap-2">{d.product.name} <Badge tone="ok">Active</Badge></span>}
                description={`Granted by ${grant.granted_by}, active ${grant.ends_at ? `until ${date(new Date(new Date(grant.ends_at).getTime() - 1).toISOString(), { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' })}` : 'with no end date'}.`}
              />
              <p className="px-5 py-4 text-sm text-muted">
                There is nothing to pay and no card is needed. Everyone on the {brand.name} team has the features below.
                {grant.ends_at && !live ? ` When the grant ends, an owner or admin can subscribe on this page to keep them; saved print links are kept either way.` : ''}
              </p>
            </Card>
          ) : null;

          const taxed = yearTax && yearTax.tax_cents > 0 && yearTax.label ? yearTax : null;
          const offer = !live && !grant ? (
            <Card data-testid="premium-offer">
              <CardHeader title={`${d.product.name} for ${brand.name}`} description="Optional. Publishing, selling and getting paid stay free." />
              <div className="space-y-4 px-5 py-5">
                <p className="flex flex-wrap items-baseline gap-x-2">
                  <span className="font-display text-3xl font-bold">{m(d.product.annual_cents)}</span>
                  <span className="text-muted">a year for this brand{plusTax}</span>
                </p>
                <ul className="space-y-1.5 text-sm text-muted">
                  <li>Billed once a year. It renews automatically on the saved card until you cancel.</li>
                  <li>Cancel any time in the Studio and keep it until the end of the paid year.</li>
                  <li>No trial. All sales are final; we do not give refunds. See the <Link className="link" to="/p/publisher-terms">publisher terms</Link>.</li>
                </ul>
                {d.can_pay ? (
                  <>
                    {billing.enabled && (
                      <div className="max-w-md">
                        <LocationFields value={billing.draft} onChange={billing.change} error={locationError} note="Your billing location, used to work out sales tax on this plan." disabled={start.isPending} />
                        {billing.location && !locationError && yearTax && (
                          <dl className="mt-3 space-y-1 text-sm" data-testid="premium-quote">
                            <div className="flex justify-between gap-4"><dt className="text-muted">{d.product.name}, 1 year</dt><dd className="tabular-nums">{m(yearTax.price_cents)}</dd></div>
                            <div className="flex justify-between gap-4"><dt className="text-muted">{taxed ? taxed.label : 'Sales tax'}</dt><dd className="tabular-nums">{m(yearTax.tax_cents)}</dd></div>
                            <div className="flex justify-between gap-4 font-semibold"><dt>Due today</dt><dd className="tabular-nums">{m(yearTax.total_cents)}</dd></div>
                          </dl>
                        )}
                      </div>
                    )}
                    <Button variant="primary" size="lg" loading={start.isPending} disabled={billing.enabled && (!billing.location || Boolean(locationError))} onClick={() => start.mutate()} data-testid="premium-subscribe">
                      Subscribe for {m(yearTax ? yearTax.total_cents : d.product.annual_cents)} a year
                    </Button>
                    <p className="text-xs text-faint">You enter the card on a secure payment form. We never see or store the card number.</p>
                  </>
                ) : d.can_manage ? (
                  <Notice tone="info">You are viewing this brand as a platform admin, so you cannot pay for it. To give a brand {d.product.name}, use Admin, Finance, Creator Premium.</Notice>
                ) : (
                  <Notice tone="info">Owners and admins of {brand.name} can subscribe. Ask one of them if your team needs these features.</Notice>
                )}
              </div>
            </Card>
          ) : null;

          return (
            <div className="space-y-4">
              {returned}
              {live && sub?.payment_problem && (
                <Notice tone="danger" action={d.can_pay ? <Button size="sm" className="h-10" loading={card.isPending} onClick={() => card.mutate()}>Update the card</Button> : undefined}>
                  The renewal payment did not go through{sub.payment_problem.message ? ` (${sub.payment_problem.message})` : ''}. {sub.payment_problem.next_attempt_at ? `We will try the card again on ${date(sub.payment_problem.next_attempt_at)}; ` : ''}a new card is charged straight away.
                </Notice>
              )}
              {!live && !grant && sub && (
                <Notice tone={sub.status === 'expired' ? 'warn' : 'info'}>
                  {sub.status === 'expired'
                    ? `${d.product.name} ended on ${date(sub.current_period_end)} because the renewal payment could not be collected.`
                    : `${d.product.name} for ${brand.name} ended on ${date(sub.current_period_end)}.`}{' '}
                  Nothing was deleted.
                </Notice>
              )}
              {hidden && <Notice tone="info">{hidden}</Notice>}
              {granted}
              {status}
              {offer}
              <Included />
              {d.charges.length > 0 && (
                <Card>
                  <CardHeader title="Payments" description="Every payment for this brand's plan. Amounts are in the site currency." />
                  <Table
                    rows={d.charges}
                    rowKey={(c) => c.id}
                    columns={[
                      { key: 'd', header: 'Paid', cell: (c) => date(c.paid_at) },
                      { key: 'p', header: 'Covers', cell: (c) => `${date(c.period_start)} to ${date(c.period_end)}`, hideOnMobile: true },
                      { key: 'a', header: 'Plan', align: 'right', cell: (c) => m(c.amount_cents), hideOnMobile: true },
                      { key: 't', header: 'Sales tax', align: 'right', cell: (c) => (c.tax_cents > 0 ? <span title={c.tax_label ?? undefined}>{m(c.tax_cents)}</span> : '—') },
                      { key: 'tot', header: 'Total', align: 'right', cell: (c) => <strong>{m(c.total_cents)}</strong> },
                      { key: 's', header: 'Status', cell: (c) => (c.status === 'refunded' ? <Badge tone="warn">Refunded</Badge> : <Badge tone="ok">Paid</Badge>) },
                    ]}
                  />
                </Card>
              )}
            </div>
          );
        }}
      </Q>
    </BrandPage>
  );
}
