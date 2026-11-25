import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { one, q } from '../db.ts';
import type { Row } from '../db.ts';
import { rateLimit } from '../lib/botblock.ts';
import { requireConfirmedEmail } from '../lib/email.ts';
import { HttpError, audit, badRequest, forbidden, notFound, parse, requireMember, requireUser } from '../lib/http.ts';
import type { MemberRole, SessionUser } from '../lib/http.ts';
import { idParam } from '../lib/ingest.ts';
import { cancelPremium, changePremiumCard, chargeTotal, closeEndedPremium, confirmSession, premiumGrantOf, resumePremium, startPremium } from '../lib/payments.ts';
import type { Origin } from '../lib/payments.ts';
import { brandHasPremium } from '../lib/premium.ts';
import { computeTax, parseLocation, saveLocation, savedLocation, stateName, taxLabel, taxSettings, taxView } from '../lib/salestax.ts';
import { getSetting } from '../lib/settings.ts';

/**
 * Studio: Creator Premium for a brand, the optional yearly plan that unlocks
 * the print edition link and the advanced analytics (lib/premium.ts).
 *
 * Every member of the brand can see the plan's status. Starting it,
 * canceling, resuming and changing the card need the owner or admin role,
 * the same as the payout settings. The card is entered on the embedded
 * secure checkout (a SETUP session, exactly like the reader membership);
 * billing is in lib/payments.ts (the PREMIUM book).
 */

const origin = (req: FastifyRequest): Origin => ({ ip: req.clientIp || null, userAgent: String(req.headers['user-agent'] ?? '').slice(0, 512) || null });
const surfaceSchema = z.enum(['embed', 'redirect']).optional();
const MANAGERS: MemberRole[] = ['owner', 'admin'];
const LOCATION_REQUIRED = 'Choose your country (and state and ZIP code in the United States) so sales tax can be worked out';

/**
 * Paying needs a real seat on the brand's team as owner or admin: it is that
 * person's card and billing location. A platform admin looking at a brand's
 * Studio passes `requireMember` but cannot pay for it; they grant
 * complimentary Premium from the admin area instead.
 */
async function onTeam(u: SessionUser, publisherId: string): Promise<boolean> {
  return Boolean(await one(`select 1 from publisher_members where publisher_id = $1 and user_id = $2 and role in ('owner','admin')`, [publisherId, u.id]));
}
async function requirePayer(u: SessionUser, publisherId: string): Promise<void> {
  if (!(await onTeam(u, publisherId))) throw forbidden('Only an owner or admin on this brand\'s team can pay for Creator Premium. Platform admins can grant it from Admin, Finance, Creator Premium.');
}

async function brandOf(id: string): Promise<Row> {
  const b = await one('select id, slug, name from publishers where id = $1 and deleted_at is null', [id]);
  if (!b) throw notFound('Brand not found');
  return b;
}

/** Sales tax on one year of Premium for this person: at `sent` (a location being tried in the form) or their saved one. null while sales tax is off. */
async function taxFor(u: SessionUser, priceCents: number, sent: unknown) {
  const cfg = await taxSettings();
  if (!cfg.enabled) return null;
  const saved = await savedLocation(u.id);
  const t = computeTax([{ kind: 'membership', price_cents: priceCents }], parseLocation(sent) ?? saved, cfg);
  return { enabled: true, location: saved, state_name: saved?.state ? stateName(saved.state) : null, annual: { price_cents: priceCents, ...taxView(t), total_cents: priceCents + t.tax_cents } };
}

async function premiumView(u: SessionUser, brand: Row, role: MemberRole) {
  const canManage = MANAGERS.includes(role);
  const prem = await getSetting('creator_premium');
  const pay = await getSetting('payments');
  await closeEndedPremium(brand.id);
  const sub = await one(
    `select ps.*, pu.display_name as payer_name from premium_subscriptions ps join users pu on pu.id = ps.user_id
      where ps.publisher_id = $1 and ps.status <> 'pending' and ps.provider <> 'comp'
      order by (ps.status in ('active','past_due') and ps.current_period_end > now()) desc, case ps.status when 'past_due' then 0 else 1 end, ps.created_at desc limit 1`,
    [brand.id],
  );
  const due = sub ? await one(`select attempts, next_attempt_at, last_error from premium_charges where subscription_id = $1 and status = 'pending' order by created_at desc limit 1`, [sub.id]) : null;
  const charges = await q(
    `select pc.id, pc.period_start, pc.period_end, pc.amount_cents, pc.tax_cents, pc.tax_state, pc.tax_rate_bps, pc.status, pc.paid_at, pc.refunded_at
       from premium_charges pc join premium_subscriptions ps on ps.id = pc.subscription_id
      where ps.publisher_id = $1 and pc.status in ('paid','refunded') order by pc.paid_at desc limit 40`,
    [brand.id],
  );
  const saved = await one<{ n: number }>(
    `select count(*)::int as n from releases r join series s on s.id = r.series_id
      where s.publisher_id = $1 and s.deleted_at is null and r.deleted_at is null and r.print_url is not null`,
    [brand.id],
  );
  const granted = await premiumGrantOf(brand.id);
  const site = await getSetting('site');
  const live = Boolean(sub) && ['active', 'past_due'].includes(sub!.status);
  return {
    brand: { id: brand.id, slug: brand.slug, name: brand.name },
    // THE answer every gate uses (lib/premium.ts brandHasPremium).
    active: await brandHasPremium(brand.id),
    product: { name: prem.name, annual_cents: prem.annual_cents },
    role,
    can_manage: canManage,
    // Subscribing and changing the card need a seat on the team (it is that person's card); see requirePayer.
    can_pay: canManage && (await onTeam(u, brand.id)),
    // Only for the people who can pay: what a year costs with sales tax at their own billing location. null while sales tax is off.
    tax: canManage ? await taxFor(u, prem.annual_cents, undefined) : null,
    provider: pay.provider,
    saved_print_links: saved?.n ?? 0,
    // Premium given by the platform without payment: no card, no charge. `ends_at` null = no end date.
    // Runs beside a paid plan if there is one; the brand has Premium while either is active.
    grant: granted && { granted_by: site.name, started_at: granted.started_at, ends_at: granted.ends_at },
    // The brand's own paid plan (the latest one), or null if it never had one.
    subscription: sub && {
      id: sub.id, status: sub.status, price_cents: sub.price_cents,
      current_period_start: sub.current_period_start, current_period_end: sub.current_period_end,
      cancel_at_period_end: sub.cancel_at_period_end, canceled_at: sub.canceled_at,
      renews_at: live && !sub.cancel_at_period_end && sub.payment_method_token && sub.status === 'active' ? sub.current_period_end : null,
      has_payment_method: Boolean(sub.payment_method_token),
      paid_by: sub.payer_name, paid_by_you: sub.user_id === u.id,
      payment_problem: sub.status === 'past_due' && due ? { attempts: due.attempts, next_attempt_at: due.next_attempt_at, message: due.last_error } : null,
    },
    // Past payments, newest first. amount_cents is before tax; total_cents is what the card was charged.
    charges: charges.map((c) => ({
      id: c.id, period_start: c.period_start, period_end: c.period_end, amount_cents: c.amount_cents, tax_cents: c.tax_cents, total_cents: chargeTotal(c),
      tax_label: c.tax_cents > 0 ? taxLabel(c.tax_state, c.tax_rate_bps) : null, status: c.status, paid_at: c.paid_at, refunded_at: c.refunded_at,
    })),
  };
}

export default async function (app: FastifyInstance) {
  /**
   * The plan and where this brand stands. With `?session_id=` (the embedded
   * card form asking how it went, or the person back from the hosted card
   * page) the session is confirmed first; safe to repeat.
   */
  app.get('/api/studio/brands/:id/premium', async (req) => {
    const id = idParam(req);
    const role = await requireMember(req, id, 'analyst');
    const u = requireUser(req);
    const brand = await brandOf(id);
    const sid = String((req.query as Row)?.session_id ?? '');
    let confirmation = null;
    if (sid && MANAGERS.includes(role) && rateLimit('order-confirm', u.id, 150, 600)) {
      confirmation = await confirmSession(sid, { userId: u.id }).catch((e) => (req.log.error(e, 'premium confirm failed'), null));
    }
    const mine = confirmation && confirmation.kind === 'premium' ? confirmation : null;
    return { ...(await premiumView(u, brand, role)), confirmation: mine?.status ?? null, confirmation_message: mine?.message ?? null };
  });

  /** What a year costs with sales tax at a billing location, without saving anything. `tax` is null while sales tax is off. */
  app.post('/api/studio/brands/:id/premium/quote', async (req) => {
    const id = idParam(req);
    await requireMember(req, id, 'admin');
    const u = requireUser(req);
    const { location } = parse(z.object({ location: z.unknown().optional() }), req.body ?? {});
    if (!rateLimit('quote', u.id, 120, 600)) throw new HttpError(429, 'Too many price checks. Try again in a few minutes.');
    const prem = await getSetting('creator_premium');
    return { product: { name: prem.name, annual_cents: prem.annual_cents }, tax: await taxFor(u, prem.annual_cents, location) };
  });

  /** Subscribe: saves a card through the secure checkout and charges the first year (plus sales tax where it applies). */
  app.post('/api/studio/brands/:id/premium/start', async (req) => {
    const id = idParam(req);
    const role = await requireMember(req, id, 'admin');
    const u = requireUser(req);
    const brand = await brandOf(id);
    await requirePayer(u, id);
    const { surface, location } = parse(z.object({ surface: surfaceSchema, location: z.unknown().optional() }), req.body ?? {});
    requireConfirmedEmail(u, 'subscribe to Creator Premium');
    if (!rateLimit('premium', u.id, 10, 3600)) throw new HttpError(429, 'Too many attempts. Try again later.');
    // With sales tax on, the first charge and every renewal are taxed at the payer's saved billing location, so there has to be one.
    if ((await taxSettings()).enabled) {
      const given = parseLocation(location);
      if (given) await saveLocation(u.id, given);
      else if (!(await savedLocation(u.id))) throw badRequest(LOCATION_REQUIRED, 'location_required');
    }
    const r = await startPremium(u, id, origin(req), surface);
    audit(req, 'premium.start', { kind: 'publisher', id }, { status: r.status });
    return r.completed ? { completed: true, ...(await premiumView(u, brand, role)) } : { url: r.url, session_id: r.session_id, surface: r.surface, status: r.status };
  });

  /** Stop renewing. Premium continues until the end of the paid year. */
  app.post('/api/studio/brands/:id/premium/cancel', async (req) => {
    const id = idParam(req);
    const role = await requireMember(req, id, 'admin');
    const u = requireUser(req);
    const brand = await brandOf(id);
    await cancelPremium(id);
    audit(req, 'premium.cancel', { kind: 'publisher', id });
    return { ok: true, ...(await premiumView(u, brand, role)) };
  });

  /** Undo a cancellation while the paid year is still running. */
  app.post('/api/studio/brands/:id/premium/resume', async (req) => {
    const id = idParam(req);
    const role = await requireMember(req, id, 'admin');
    const u = requireUser(req);
    const brand = await brandOf(id);
    await resumePremium(id);
    audit(req, 'premium.resume', { kind: 'publisher', id });
    return { ok: true, ...(await premiumView(u, brand, role)) };
  });

  /** Replace the saved card. Whoever does this becomes the payer (receipts and the billing location for sales tax are theirs). */
  app.post('/api/studio/brands/:id/premium/payment-method', async (req) => {
    const id = idParam(req);
    const role = await requireMember(req, id, 'admin');
    const u = requireUser(req);
    const brand = await brandOf(id);
    await requirePayer(u, id);
    const { surface, location } = parse(z.object({ surface: surfaceSchema, location: z.unknown().optional() }), req.body ?? {});
    if (!rateLimit('premium', u.id, 10, 3600)) throw new HttpError(429, 'Too many attempts. Try again later.');
    const given = (await taxSettings()).enabled ? parseLocation(location) : null;
    if (given) await saveLocation(u.id, given);
    const r = await changePremiumCard(u, id, origin(req), surface);
    audit(req, 'premium.payment_method', { kind: 'publisher', id });
    return r.url ? { url: r.url, session_id: r.session_id, surface: r.surface } : { completed: true, ...(await premiumView(u, brand, role)) };
  });
}
