import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { exec, one, q, tx } from '../db.ts';
import type { Queryable, Row } from '../db.ts';
import { hasMembership, releaseAccess } from '../lib/access.ts';
import { rateLimit } from '../lib/botblock.ts';
import { requireConfirmedEmail } from '../lib/email.ts';
import { HttpError, badRequest, conflict, forbidden, notFound, parse, paymentRequired, requireUser } from '../lib/http.ts';
import type { SessionUser } from '../lib/http.ts';
import { creditSale } from '../lib/ledger.ts';
import {
  changePaymentMethod, confirmSession, getProvider, handleDivinityEvent, money, startMembership, startOrderPayment, verifyDivinitySignature, walletAdd,
} from '../lib/payments.ts';
import type { Origin } from '../lib/payments.ts';
import { FAILURE_TEXT } from '../lib/payments.ts';
import { activeDiscounts, applyCode, bundlePrice, codeCovers, downloadPrice, readOffer, seriesPurchase } from '../lib/pricing.ts';
import type { Line } from '../lib/pricing.ts';
import { getSetting } from '../lib/settings.ts';
import { assertViewable, findPublisher, findSeries, isUuid } from './catalog.ts';

const MIN_CARD_CHARGE = 50;
/** Per reader. The embedded checkout asks every 10 seconds as a backstop, the return page every 2 for a while. */
const CONFIRMS_PER_10_MIN = 150;

type Draft = Line & { description: string; bundle_id: string | null; meta: Row };

const origin = (req: FastifyRequest): Origin => ({ ip: req.clientIp || null, userAgent: String(req.headers['user-agent'] ?? '').slice(0, 512) || null });

const itemSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('release'), id: z.uuid() }),
  z.object({ kind: z.literal('download'), id: z.uuid() }),
  z.object({ kind: z.literal('series'), id: z.string().min(1).max(80) }),
  z.object({ kind: z.literal('bundle'), id: z.uuid() }),
  z.object({
    kind: z.literal('tip'), id: z.string().min(1).max(80), amount_cents: z.number().int().min(100, 'The smallest tip is 1.00').max(100_000, 'The largest tip is 1,000.00'),
    message: z.string().trim().max(500).optional(), show_amount: z.boolean().optional(),
  }),
  z.object({
    kind: z.literal('gift_card'), amount_cents: z.number().int().min(500, 'Gift cards start at 5.00').max(50_000, 'Gift cards go up to 500.00'),
    recipient_email: z.email('Enter a valid email address for the recipient').max(200).optional(), message: z.string().trim().max(500).optional(),
  }),
  z.object({ kind: z.literal('credits'), quantity: z.number().int().min(1).max(5000) }),
]);

const label = (r: Row) => `${String(r.kind).replace(/_/g, ' ')} ${r.number}`;

/** A usable promo code row, or a readable reason why not. Shared by checkout (discount) and redemption. */
async function usableCode(code: string, user: SessionUser, db?: Queryable): Promise<Row> {
  const c = await one(`select * from promo_codes where upper(code) = upper($1) ${db ? 'for update' : ''}`, [code], db);
  if (!c || c.disabled_at) throw badRequest('That code is not valid. Check it and try again.', 'code_invalid');
  if (c.starts_at && Date.parse(c.starts_at) > Date.now()) throw badRequest('That code is not active yet', 'code_inactive');
  if (c.expires_at && Date.parse(c.expires_at) <= Date.now()) throw badRequest('That code has expired', 'code_expired');
  if (c.assigned_email) {
    if (!user.email_verified_at) throw forbidden('This code was sent to a specific email address. Confirm your email first, then redeem it.');
    if (c.assigned_email.toLowerCase() !== user.email.toLowerCase()) throw forbidden('This code was issued to a different email address');
  }
  if (await one('select 1 from code_redemptions where code_id = $1 and user_id = $2', [c.id, user.id], db)) throw conflict('You have already used this code');
  if (c.max_redemptions !== null && c.redeemed_count >= c.max_redemptions) throw badRequest('That code has already been used', 'code_used_up');
  return c;
}

/**
 * Order lines with what the web needs to link each one: the series (slug,
 * title) for anything that belongs to one, the brand (slug, name) for tips.
 */
export async function orderItems(orderIds: string[]): Promise<Row[]> {
  if (!orderIds.length) return [];
  return q(
    `select i.id, i.order_id, i.kind, i.description, i.price_cents, i.release_id, i.series_id, i.publisher_id, i.bundle_id,
            s.slug as series_slug, s.title as series_title, p.slug as publisher_slug, p.name as publisher_name,
            case when i.kind = 'series' then coalesce(i.meta->'release_ids', '[]'::jsonb)
                 when i.kind = 'bundle' then coalesce((select jsonb_agg(x->>'id') from jsonb_array_elements(i.meta->'releases') x), '[]'::jsonb)
                 when i.release_id is not null then jsonb_build_array(i.release_id) else '[]'::jsonb end as release_ids
       from order_items i
       left join series s on s.id = i.series_id and s.deleted_at is null
       left join publishers p on p.id = i.publisher_id and p.deleted_at is null
      where i.order_id = any($1) order by i.id`,
    [orderIds],
  );
}

/**
 * How the browser will show the hosted checkout page: 'embed' (framed inside
 * our own page) or 'redirect' (a full-page visit that comes back to the
 * return URL). The browser decides, because only it knows whether it can type
 * into a framed card form; anything that does not say gets a redirect.
 */
const surfaceSchema = z.enum(['embed', 'redirect'], 'surface must be "embed" or "redirect"').optional();

const basketSchema = z.object({
  items: z.array(itemSchema).min(1, 'Your basket is empty').max(20), code: z.string().trim().max(40).optional(), use_credit: z.boolean().optional(), return_to: z.string().max(300).optional(),
  surface: surfaceSchema,
});

/** Only same-site paths are followed after a payment. */
const sameSite = (path: string | undefined | null, fallback: string): string => (path && /^\/(?!\/)[^\\\s]*$/.test(path) ? path : fallback);

/**
 * Who a tip goes to. `id` may be a brand's id or slug, or a series' id or
 * slug (the tip then goes to the brand that publishes it). Brands win when a
 * brand and a series share a slug.
 */
async function tipRecipient(id: string): Promise<Row> {
  let p = await findPublisher(id);
  if (!p) {
    const s = await findSeries(id);
    if (s) p = await one('select * from publishers where id = $1 and deleted_at is null', [s.publisher_id]);
  }
  if (!p) throw notFound(`No brand or series matches "${id}". A tip's id must be a brand's slug or id (a series slug or id also works and tips the brand behind it).`);
  if (p.suspended_at) throw notFound(`${p.name} is suspended and cannot receive tips right now`);
  if (!p.tips_enabled) throw badRequest(`${p.name} is not accepting tips`);
  return p;
}

type Basket = { drafts: Draft[]; code: Row | null; code_discount_cents: number; total_cents: number };

/**
 * Price a basket. Shared by POST /api/checkout/quote and POST /api/checkout,
 * so the total the reader is shown is the total they are charged. Nothing is
 * written. Nothing the browser sends is trusted for a price except a tip /
 * gift card amount.
 */
async function priceBasket(req: FastifyRequest, u: SessionUser, body: z.infer<typeof basketSchema>, opts: { quote: boolean }): Promise<Basket> {
  const mem = await getSetting('membership');
  const drafts: Draft[] = [];
  const seen = new Set<string>();
  const unique = (key: string, what: string) => {
    if (seen.has(key)) throw badRequest(`${what} is in your basket twice`);
    seen.add(key);
  };
  for (const it of body.items) {
    if (it.kind === 'release' || it.kind === 'download') {
      const r = await one('select * from releases where id = $1 and deleted_at is null', [it.id]);
      const s = r && (await findSeries(r.series_id));
      if (!r || !s) throw notFound('That release is no longer available');
      await assertViewable(req, s, r);
      unique(`r:${r.id}`, r.title);
      const a = await releaseAccess({ series: s, release: r, pages: [], user: u, country: req.country });
      if (a.model === 'blocked') throw notFound('That release is not available in your country');
      const ent = await one<{ can_download: boolean }>('select can_download from entitlements where user_id = $1 and release_id = $2', [u.id, r.id]);
      const discounts = await activeDiscounts([s.publisher_id]);
      if (it.kind === 'release') {
        if (ent) throw conflict(`You already own ${r.title}`);
        if (a.model !== 'premium' || a.releaseFree) throw badRequest(`${r.title} is free to read; there is nothing to buy`);
        const p = readOffer(s, r, a, discounts);
        if (!p) throw badRequest(a.unlock === 'owner' ? `${r.title} is published by your own brand; there is nothing to buy` : `${r.title} is not sold on its own`);
        drafts.push({ kind: 'release', description: `${s.title}: ${r.title} (${label(r)})`, price_cents: p.price_cents, publisher_id: s.publisher_id, series_id: s.id, release_id: r.id, bundle_id: null, meta: { list_price_cents: p.base_cents, percent_off: p.percent_off } });
      } else {
        if (ent?.can_download) throw conflict(`You already own the download of ${r.title}`);
        const p = downloadPrice(s, r, discounts);
        if (!p) throw badRequest(`The download of ${r.title} is not for sale`);
        drafts.push({ kind: 'download', description: `${s.title}: ${r.title} (${label(r)}), download`, price_cents: p.price_cents, publisher_id: s.publisher_id, series_id: s.id, release_id: r.id, bundle_id: null, meta: { list_price_cents: p.base_cents, percent_off: p.percent_off } });
      }
    } else if (it.kind === 'series') {
      const s = await findSeries(it.id);
      if (!s) throw notFound('That series is no longer available');
      await assertViewable(req, s, null);
      unique(`s:${s.id}`, s.title);
      const whole = await seriesPurchase(s, u.id, await activeDiscounts([s.publisher_id]), undefined, { country: req.country });
      if (!whole.releases.length) throw badRequest(`There is nothing left to buy in ${s.title}`);
      drafts.push({
        kind: 'series', description: `${s.title}: all ${whole.releases.length} releases`, price_cents: whole.price_cents, publisher_id: s.publisher_id, series_id: s.id, release_id: null,
        release_ids: whole.releases.map((r) => r.id), bundle_id: null, meta: { release_ids: whole.releases.map((r) => r.id), list_price_cents: whole.base_cents },
      });
    } else if (it.kind === 'bundle') {
      const b = await one('select b.* from bundles b join publishers p on p.id = b.publisher_id where b.id = $1 and b.active and p.deleted_at is null and p.suspended_at is null', [it.id]);
      if (!b) throw notFound('That bundle is no longer available');
      unique(`b:${b.id}`, b.title);
      const rels = await q(
        `select r.id, r.series_id, r.price_cents, s.default_price_cents from bundle_items bi join releases r on r.id = bi.release_id join series s on s.id = r.series_id
          where bi.bundle_id = $1 and r.status = 'published' and r.deleted_at is null and s.deleted_at is null and s.takedown_at is null and s.publisher_id = $2 order by r.id`,
        [b.id, b.publisher_id],
      );
      if (!rels.length) throw badRequest('That bundle has nothing in it right now');
      const have = await q<{ release_id: string; can_download: boolean }>('select release_id, can_download from entitlements where user_id = $1 and release_id = any($2)', [u.id, rels.map((r) => r.id)]);
      if (rels.every((r) => have.some((h) => h.release_id === r.id && (h.can_download || !b.includes_download)))) throw conflict(`You already own everything in ${b.title}`);
      const p = bundlePrice(b, await activeDiscounts([b.publisher_id]));
      drafts.push({
        kind: 'bundle', description: `Bundle: ${b.title}${b.includes_download ? ' (with downloads)' : ''}`, price_cents: p.price_cents, publisher_id: b.publisher_id, series_id: rels.every((r) => r.series_id === rels[0].series_id) ? rels[0].series_id : null,
        release_id: null, release_ids: rels.map((r) => r.id), bundle_id: b.id,
        meta: { includes_download: b.includes_download, list_price_cents: p.base_cents, releases: rels.map((r) => ({ id: r.id, series_id: r.series_id, weight: r.price_cents ?? r.default_price_cents ?? 1 })) },
      });
    } else if (it.kind === 'tip') {
      const p = await tipRecipient(it.id);
      unique(`t:${p.id}`, `A tip for ${p.name}`);
      drafts.push({ kind: 'tip', description: `Tip for ${p.name}`, price_cents: it.amount_cents, publisher_id: p.id, series_id: null, release_id: null, bundle_id: null, meta: { message: it.message ?? '', show_amount: it.show_amount !== false } });
    } else if (it.kind === 'gift_card') {
      drafts.push({ kind: 'gift_card', description: `Gift card ${await money(it.amount_cents)}`, price_cents: it.amount_cents, publisher_id: null, series_id: null, release_id: null, bundle_id: null, meta: { recipient_email: it.recipient_email?.toLowerCase() ?? null, message: it.message ?? '' } });
    } else {
      if (!mem.page_credit_cents || mem.page_credit_cents <= 0) throw badRequest('Page credits are not on sale right now');
      unique('credits', 'Page credits');
      drafts.push({ kind: 'credits', description: `${it.quantity} page credits`, price_cents: it.quantity * mem.page_credit_cents, publisher_id: null, series_id: null, release_id: null, bundle_id: null, meta: { quantity: it.quantity } });
    }
  }

  let code: Row | null = null;
  let discount = 0;
  if (body.code) {
    // Quotes are throttled apart from real attempts so re-quoting (credit on/off) never locks a reader out of paying.
    if (!rateLimit(opts.quote ? 'code-quote' : 'code', u.id, opts.quote ? 40 : 15, 3600)) throw new HttpError(429, 'Too many code attempts. Try again in an hour.');
    const c = await usableCode(body.code, u);
    if (c.kind !== 'discount' || !c.percent_off) throw badRequest('That code is not a discount code. Redeem it from your account instead.', 'code_wrong_kind');
    if (!drafts.some((d) => codeCovers(c as never, d))) throw badRequest('That code does not apply to anything in your basket', 'code_not_applicable');
    const r = applyCode(c as never, drafts);
    r.prices.forEach((p, i) => {
      if (p !== drafts[i].price_cents) drafts[i].meta = { ...drafts[i].meta, code_discount_cents: drafts[i].price_cents - p };
      drafts[i].price_cents = p;
    });
    discount = r.discount_cents;
    code = c;
  }
  return { drafts, code, code_discount_cents: discount, total_cents: drafts.reduce((n, d) => n + d.price_cents, 0) };
}

/** How a total is paid: store credit first (when asked), the card for the rest. */
function settle(total: number, creditAvailable: number, useCredit: boolean | undefined): { credit: number; charge: number; below_minimum: boolean } {
  const credit = useCredit ? Math.min(Math.max(0, creditAvailable), total) : 0;
  const charge = total - credit;
  return { credit, charge, below_minimum: charge > 0 && charge < MIN_CARD_CHARGE };
}
const belowMinimum = async () => `The smallest card payment is ${await money(MIN_CARD_CHARGE)}. Add something else to your basket.`;

export default async function commerceRoutes(app: FastifyInstance) {
  // ---------------------------------------------------------------- checkout

  /**
   * What a basket would cost, with nothing written and nothing charged. Same
   * body as POST /api/checkout and the same pricing code, so the two cannot
   * disagree. A bad code is a 400 here, before any payment is started.
   */
  app.post('/api/checkout/quote', async (req) => {
    const u = requireUser(req);
    const body = parse(basketSchema, req.body);
    if (!rateLimit('quote', u.id, 120, 600)) throw new HttpError(429, 'Too many price checks. Try again in a few minutes.');
    const b = await priceBasket(req, u, body, { quote: true });
    const w = await one<{ credit_cents: number }>('select credit_cents from wallets where user_id = $1', [u.id]);
    const available = w?.credit_cents ?? 0;
    const pay = settle(b.total_cents, available, body.use_credit);
    const lines = b.drafts.map((d) => {
      const codeOff = Number(d.meta.code_discount_cents ?? 0);
      const list = Number(d.meta.list_price_cents ?? d.price_cents + codeOff);
      return {
        kind: d.kind, description: d.description, release_id: d.release_id, series_id: d.series_id, publisher_id: d.publisher_id, bundle_id: d.bundle_id,
        list_price_cents: list, sale_discount_cents: list - d.price_cents - codeOff, code_discount_cents: codeOff, price_cents: d.price_cents,
      };
    });
    return {
      lines,
      list_price_cents: lines.reduce((n, l) => n + l.list_price_cents, 0),
      discounts: { sale_cents: lines.reduce((n, l) => n + l.sale_discount_cents, 0), code_cents: b.code_discount_cents },
      code: b.code ? { code: b.code.code, percent_off: b.code.percent_off } : null,
      total_cents: b.total_cents,
      credit_available_cents: available,
      credit_applied_cents: pay.credit,
      amount_due_cents: pay.charge,
      // Set when this basket cannot be paid as it stands (the checkout would answer 400 with the same code).
      problem: pay.below_minimum ? { code: 'below_minimum', message: await belowMinimum() } : null,
    };
  });

  /** Price a basket on the server (see `priceBasket`) and start paying for it. */
  app.post('/api/checkout', async (req) => {
    const u = requireUser(req);
    const body = parse(basketSchema, req.body);
    requireConfirmedEmail(u, 'buy things');
    if (!rateLimit('checkout', u.id, 30, 600)) throw new HttpError(429, 'Too many checkout attempts. Try again in a few minutes.');
    const returnTo = sameSite(body.return_to, '/library');
    const { drafts, code, code_discount_cents: discount, total_cents: total } = await priceBasket(req, u, body, { quote: false });
    const codeId: string | null = code?.id ?? null;

    const pay = await getSetting('payments');
    const orderId = await tx(async (db) => {
      await db.query('insert into wallets (user_id) values ($1) on conflict do nothing', [u.id]);
      const w = await one<{ credit_cents: number }>('select credit_cents from wallets where user_id = $1 for update', [u.id], db);
      const { credit, charge, below_minimum } = settle(total, w?.credit_cents ?? 0, body.use_credit);
      if (below_minimum) throw badRequest(await belowMinimum(), 'below_minimum');
      // Fail before anything is written if a card payment is needed and none can be taken.
      if (charge > 0) await getProvider();
      const o = await one<{ id: string }>(
        `insert into orders (user_id, status, total_cents, credit_cents, provider, discount_code_id, ip, user_agent, meta) values ($1,'pending',$2,$3,$4,$5,$6,$7,$8) returning id`,
        [u.id, total, credit, charge > 0 ? pay.provider : 'credit', codeId, req.clientIp, origin(req).userAgent, JSON.stringify({ return_to: returnTo, code_discount_cents: discount })],
        db,
      );
      // Store credit is taken now so it cannot be spent twice while the reader is at the checkout; an unpaid order gives it back.
      if (credit > 0) await walletAdd(db, u.id, 'purchase', -credit, 0, `Store credit used on order ${o!.id.slice(-8)}`);
      for (const d of drafts) {
        await db.query(
          'insert into order_items (order_id, kind, release_id, series_id, publisher_id, bundle_id, description, price_cents, meta) values ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
          [o!.id, d.kind, d.release_id, d.series_id, d.publisher_id, d.bundle_id, d.description, d.price_cents, JSON.stringify(d.meta)],
        );
      }
      return o!.id;
    });
    const r = await startOrderPayment(orderId, body.surface);
    return r.completed ? { completed: true, order_id: orderId, return_to: returnTo } : { url: r.url, session_id: r.session_id, order_id: orderId, surface: r.surface, amount_cents: r.amount_cents, return_to: returnTo };
  });

  /** pending | paid | refunded, or how an unpaid checkout ended: failed (card not accepted), expired, canceled. */
  const paymentState = (o: Row): string => (o.status === 'failed' ? (['expired', 'canceled'].includes(o.meta?.failure_state) ? o.meta.failure_state : 'failed') : o.status);

  const orderView = async (o: Row) => ({
    id: o.id, status: o.status, total_cents: o.total_cents, credit_cents: o.credit_cents, charged_cents: o.total_cents - o.credit_cents, provider: o.provider,
    created_at: o.created_at, paid_at: o.paid_at, refunded_at: o.refunded_at, return_to: o.meta?.return_to ?? '/library',
    payment_state: paymentState(o),
    // One sentence for the buyer about why it was not paid; null unless the order failed.
    failure: o.status === 'failed' ? (o.meta?.failure ?? FAILURE_TEXT.failed) : null,
    refunded_cents: o.status === 'refunded' ? o.total_cents - o.credit_cents : (o.refunded_cents ?? 0),
    partial_refunds: ((o.meta?.partial_refunds as Row[] | undefined) ?? []).map((r) => ({ amount_cents: r.amount_cents, reason: r.reason ?? null, at: r.at })),
    items: await orderItems([o.id]),
  });

  /**
   * Order status / receipt, and the one place a browser learns how a payment
   * went. The embedded checkout and the checkout return page both call this
   * with the order's `session_id`; a still-pending order is then confirmed
   * with the processor before answering. Asking repeatedly while the buyer is
   * still paying is expected and changes nothing.
   */
  app.get('/api/orders/:id', async (req) => {
    const u = requireUser(req);
    const { id } = req.params as { id: string };
    let o = isUuid(id) ? await one('select * from orders where id = $1 and user_id = $2', [id, u.id]) : null;
    if (!o) throw notFound('Order not found');
    const sid = String((req.query as Row)?.session_id ?? '');
    if (o.status === 'pending' && o.provider === 'divinity' && o.provider_ref && (!sid || sid === o.provider_ref)) {
      if (rateLimit('order-confirm', u.id, CONFIRMS_PER_10_MIN, 600)) await confirmSession(o.provider_ref, { userId: u.id }).catch((e) => req.log.error(e, 'checkout confirm failed'));
      o = (await one('select * from orders where id = $1', [id]))!;
    }
    return { order: await orderView(o) };
  });

  /** Confirm any hosted checkout session (order or membership) the reader has just returned from. */
  app.post('/api/checkout/confirm', async (req) => {
    const u = requireUser(req);
    const { session_id } = parse(z.object({ session_id: z.string().min(4).max(200) }), req.body);
    if (!rateLimit('order-confirm', u.id, CONFIRMS_PER_10_MIN, 600)) throw new HttpError(429, 'Too many requests. Try again in a few minutes.');
    const r = await confirmSession(session_id, { userId: u.id });
    if (r.kind === 'unknown') throw notFound('Checkout session not found');
    return r;
  });

  /** Webhooks from the payment processor. Authenticated by signature over the raw body, not by cookie. */
  app.post('/api/webhooks/divinity', async (req, reply) => {
    const pay = await getSetting('payments');
    if (!pay.divinity_webhook_secret) return reply.code(503).send({ error: 'Webhook secret is not configured' });
    const raw = ((req as unknown as { rawBody?: Buffer }).rawBody ?? Buffer.alloc(0)).toString('utf8');
    if (!verifyDivinitySignature(raw, String(req.headers['x-webhook-signature'] ?? ''), pay.divinity_webhook_secret)) {
      return reply.code(401).send({ error: 'Invalid webhook signature' });
    }
    // An exception becomes a 500, which makes the processor deliver the event again.
    return handleDivinityEvent(req.body as { event?: string; data?: Row });
  });

  // ---------------------------------------------------------------- membership

  const membershipView = async (u: SessionUser) => {
    const mem = await getSetting('membership');
    const pay = await getSetting('payments');
    const sub = await one(
      `select * from subscriptions where user_id = $1 and status <> 'pending'
        order by (status in ('active','past_due') and current_period_end > now()) desc, case status when 'past_due' then 0 else 1 end, created_at desc limit 1`,
      [u.id],
    );
    const charge = sub ? await one(`select status, attempts, next_attempt_at, last_error from subscription_charges where subscription_id = $1 order by created_at desc limit 1`, [sub.id]) : null;
    return {
      member: await hasMembership(u.id),
      plans: { name: mem.name, monthly_cents: mem.monthly_cents, annual_cents: mem.annual_cents, trial_days: mem.trial_days },
      provider: pay.provider,
      subscription: sub && {
        id: sub.id, plan: sub.plan, status: sub.status, price_cents: sub.price_cents, provider: sub.provider,
        current_period_start: sub.current_period_start, current_period_end: sub.current_period_end,
        cancel_at_period_end: sub.cancel_at_period_end, canceled_at: sub.canceled_at,
        renews_at: ['active', 'past_due'].includes(sub.status) && !sub.cancel_at_period_end && sub.payment_method_token ? sub.current_period_end : null,
        has_payment_method: Boolean(sub.payment_method_token), from_code: sub.provider === 'code',
        payment_problem: sub.status === 'past_due' && charge ? { attempts: charge.attempts, next_attempt_at: charge.next_attempt_at, message: charge.last_error } : null,
      },
    };
  };

  /**
   * Plans + this reader's membership. With `?session_id=` (the embedded card
   * form asking how it went, or the reader back from the hosted card page)
   * the session is confirmed first. Safe to repeat: a card is taken in once.
   */
  app.get('/api/membership', async (req) => {
    const u = requireUser(req);
    const sid = String((req.query as Row)?.session_id ?? '');
    let confirmation = null;
    if (sid && rateLimit('order-confirm', u.id, CONFIRMS_PER_10_MIN, 600)) confirmation = await confirmSession(sid, { userId: u.id }).catch((e) => (req.log.error(e, 'membership confirm failed'), null));
    const mine = confirmation && confirmation.kind === 'membership' ? confirmation : null;
    return { ...(await membershipView(u)), confirmation: mine?.status ?? null, confirmation_message: mine?.message ?? null };
  });

  app.post('/api/membership/start', async (req) => {
    const u = requireUser(req);
    const { plan, next, surface } = parse(z.object({ plan: z.enum(['monthly', 'annual']), next: z.string().max(300).optional(), surface: surfaceSchema }), req.body);
    requireConfirmedEmail(u, 'start a membership');
    if (!rateLimit('membership', u.id, 10, 3600)) throw new HttpError(429, 'Too many attempts. Try again later.');
    // Where to send the reader once the membership is confirmed; only same-site paths survive.
    const onward = sameSite(next, '') || null;
    const r = await startMembership(u, plan, origin(req), onward, surface);
    return r.completed ? { completed: true, next: onward, ...(await membershipView(u)) } : { url: r.url, session_id: r.session_id, surface: r.surface, status: r.status, next: onward };
  });

  /** Stop renewing; access continues until the paid period ends. */
  app.post('/api/membership/cancel', async (req) => {
    const u = requireUser(req);
    const n = await exec(`update subscriptions set cancel_at_period_end = true, canceled_at = now() where user_id = $1 and status in ('active','past_due') and not cancel_at_period_end`, [u.id]);
    if (!n && !(await one(`select 1 from subscriptions where user_id = $1 and status in ('active','past_due')`, [u.id]))) throw notFound('You do not have an active membership');
    // A membership already past due has no paid time left: end it and stop retrying the card.
    await exec(`update subscription_charges set status = 'failed', last_error = 'Canceled by the member' where user_id = $1 and status = 'pending'`, [u.id]);
    await exec(`update subscriptions set status = 'canceled' where user_id = $1 and status = 'past_due'`, [u.id]);
    return { ok: true, ...(await membershipView(u)) };
  });

  app.post('/api/membership/resume', async (req) => {
    const u = requireUser(req);
    const n = await exec(
      `update subscriptions set cancel_at_period_end = false, canceled_at = null
        where user_id = $1 and status = 'active' and cancel_at_period_end and current_period_end > now() and payment_method_token is not null`,
      [u.id],
    );
    if (!n) throw conflict('There is no cancelled membership to resume. Start a new one instead.');
    return { ok: true, ...(await membershipView(u)) };
  });

  /** Replace the saved card: returns the hosted card page to show the reader (framed or as a visit, per `surface`). */
  app.post('/api/membership/payment-method', async (req) => {
    const u = requireUser(req);
    const { surface } = parse(z.object({ surface: surfaceSchema }), req.body ?? {});
    if (!rateLimit('membership', u.id, 10, 3600)) throw new HttpError(429, 'Too many attempts. Try again later.');
    const r = await changePaymentMethod(u, origin(req), surface);
    return r.url ? { url: r.url, session_id: r.session_id, surface: r.surface } : { completed: true, ...(await membershipView(u)) };
  });

  // ---------------------------------------------------------------- codes

  /**
   * Redeem a code: a brand's unlock code (a release or a whole series), a
   * membership or page-credit code issued by the platform, or a gift card.
   * Guessing is throttled hard, per account and per network.
   */
  app.post('/api/codes/redeem', async (req) => {
    const u = requireUser(req);
    const { code } = parse(z.object({ code: z.string().trim().min(4, 'Enter the code').max(40) }), req.body);
    if (!rateLimit('redeem', u.id, 8, 3600) || !rateLimit('redeem-ip', req.clientIp, 30, 3600)) throw new HttpError(429, 'Too many code attempts. Try again in an hour.');
    const clean = code.replace(/\s+/g, '').toUpperCase();

    return tx(async (db) => {
      const gift = await one('select * from gift_cards where upper(code) = $1 for update', [clean], db);
      if (gift) {
        if (gift.redeemed_at || gift.balance_cents <= 0) throw badRequest('That gift card has already been used', 'code_used_up');
        await db.query('update gift_cards set redeemed_by = $2, redeemed_at = now(), balance_cents = 0 where id = $1', [gift.id, u.id]);
        await walletAdd(db, u.id, 'gift_card', gift.balance_cents, 0, `Gift card ${clean.slice(-4)}`);
        const w = await one<{ credit_cents: number }>('select credit_cents from wallets where user_id = $1', [u.id], db);
        return { kind: 'gift_card', message: `${await money(gift.balance_cents)} of store credit was added to your account.`, credit_cents: gift.balance_cents, wallet_credit_cents: w?.credit_cents ?? gift.balance_cents };
      }

      const c = await usableCode(clean, u, db);
      const claim = async () => {
        await db.query('insert into code_redemptions (code_id, user_id) values ($1,$2)', [c.id, u.id]);
        await db.query('update promo_codes set redeemed_count = redeemed_count + 1 where id = $1', [c.id]);
      };

      if (c.kind === 'discount') throw badRequest(`This is a ${c.percent_off}% discount code. Enter it at checkout.`, 'code_wrong_kind');

      if (c.kind === 'unlock') {
        // A whole-series code covers every release that exists today, including ones not out yet.
        const rels = c.release_id
          ? await q('select r.id, r.title, s.title as series_title, s.slug from releases r join series s on s.id = r.series_id where r.id = $1 and r.deleted_at is null and s.deleted_at is null', [c.release_id], db)
          : c.series_id
            ? await q('select r.id, r.title, s.title as series_title, s.slug from releases r join series s on s.id = r.series_id where r.series_id = $1 and r.deleted_at is null and s.deleted_at is null order by r.number', [c.series_id], db)
            : [];
        if (!rels.length) throw badRequest('That code is not attached to anything that can be unlocked yet', 'code_invalid');
        await claim();
        for (const r of rels) {
          await db.query(
            `insert into entitlements (user_id, release_id, source, code_id, can_download) values ($1,$2,'code',$3,$4)
             on conflict (user_id, release_id) do update set can_download = entitlements.can_download or excluded.can_download`,
            [u.id, r.id, c.id, c.includes_download],
          );
        }
        return {
          kind: 'unlock', message: c.release_id ? `${rels[0].title} is now in your library.` : `${rels[0].series_title} is now in your library (${rels.length} releases).`,
          series_slug: rels[0].slug, release_ids: rels.map((r) => r.id), includes_download: c.includes_download,
        };
      }

      // Only the platform can give away membership time or page credits.
      if (c.publisher_id) throw badRequest('That code is not valid. Check it and try again.', 'code_invalid');

      if (c.kind === 'membership') {
        const days = Number(c.membership_days ?? 0);
        if (days <= 0) throw badRequest('That code is not valid. Check it and try again.', 'code_invalid');
        const cur = await one(`select * from subscriptions where user_id = $1 and status in ('active','past_due') and current_period_end > now() order by current_period_end desc limit 1 for update`, [u.id], db);
        if (cur && cur.provider !== 'code') throw conflict('You already have a paid membership. Keep this code and redeem it when that membership ends.');
        await claim();
        const row = cur
          ? await one(`update subscriptions set current_period_end = current_period_end + ($2 || ' days')::interval where id = $1 returning current_period_end`, [cur.id, String(days)], db)
          : await one(
              `insert into subscriptions (user_id, plan, status, provider, provider_ref, price_cents, current_period_start, current_period_end, cancel_at_period_end)
               values ($1,'monthly','active','code',$2,0, now(), now() + ($3 || ' days')::interval, true) returning current_period_end`,
              [u.id, `code_${c.id}_${u.id}`, String(days)],
              db,
            );
        return { kind: 'membership', message: `${days} days of membership were added to your account.`, days, member_until: row!.current_period_end };
      }

      if (c.kind === 'credits') {
        const n = Number(c.page_credits ?? 0);
        if (n <= 0) throw badRequest('That code is not valid. Check it and try again.', 'code_invalid');
        await claim();
        await walletAdd(db, u.id, 'credits_code', 0, n, `Code ${clean.slice(-4)}`);
        const w = await one<{ page_credits: number }>('select page_credits from wallets where user_id = $1', [u.id], db);
        return { kind: 'credits', message: `${n} page credits were added to your account.`, page_credits_added: n, page_credits: w?.page_credits ?? n };
      }
      throw badRequest('That code is not valid. Check it and try again.', 'code_invalid');
    });
  });

  // ---------------------------------------------------------------- page credits

  /** Spend one page credit on one locked page. The page's creators are paid for it like a sale. */
  app.post('/api/pages/:id/unlock', async (req) => {
    const u = requireUser(req);
    const { id } = req.params as { id: string };
    const page = isUuid(id) ? await one<{ id: string; release_id: string }>('select id, release_id from pages where id = $1', [id]) : null;
    const release = page && (await one('select * from releases where id = $1 and deleted_at is null', [page.release_id]));
    const series = release && (await findSeries(release.series_id));
    if (!page || !release || !series) throw notFound('Page not found');
    await assertViewable(req, series, release);
    const pages = await q<{ id: string; position: number; is_free: boolean | null }>('select id, position, is_free from pages where release_id = $1 order by position, id', [release.id]);
    const a = await releaseAccess({ series, release, pages, user: u, country: req.country });
    if (a.model === 'blocked') throw notFound('This title is not available in your country');
    const balance = async () => (await one<{ page_credits: number }>('select page_credits from wallets where user_id = $1', [u.id]))?.page_credits ?? 0;
    // Already readable (free, owned, member, or unlocked before): nothing to spend.
    if (a.pages[pages.findIndex((p) => p.id === page.id)] !== null) return { ok: true, page_credits: await balance(), spent: 0 };
    const mem = await getSetting('membership');
    const left = await tx(async (db) => {
      const w = await one<{ page_credits: number }>('select page_credits from wallets where user_id = $1 for update', [u.id], db);
      if (!w || w.page_credits < 1) throw paymentRequired('You have no page credits left. Buy more to unlock single pages.');
      const ins = await db.query('insert into page_unlocks (user_id, page_id) values ($1,$2) on conflict do nothing', [u.id, page.id]);
      if (!ins.rowCount) return w.page_credits;
      await walletAdd(db, u.id, 'page_unlock', 0, -1, `${series.title}: ${release.title}, page ${pages.findIndex((p) => p.id === page.id) + 1}`);
      if (mem.page_credit_cents > 0) {
        await creditSale(db, { publisherId: series.publisher_id, seriesId: series.id, releaseId: release.id, orderId: null, priceCents: mem.page_credit_cents, feeCents: 0, note: `Page credit: ${release.title}` });
      }
      return w.page_credits - 1;
    });
    return { ok: true, page_credits: left, spent: 1 };
  });
}
