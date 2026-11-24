import { createHmac, timingSafeEqual } from 'node:crypto';
import { config } from '../config.ts';
import { exec, one, q, tx } from '../db.ts';
import type { Queryable, Row } from '../db.ts';
import { randomCode } from './crypto.ts';
import { alertAdmins, escapeHtml, sendTemplate } from './email.ts';
import { captureError } from './errors.ts';
import { HttpError, conflict } from './http.ts';
import { allocate, creditSale, creditTip, estimateFee, refundParts, reverseOrder, reverseOrderPartly } from './ledger.ts';
import { notify } from './notify.ts';
import { getSetting } from './settings.ts';

/**
 * Payments. Two providers behind one interface:
 *
 *   divinity  Divinity payments partner API (production). Hosted checkout
 *             only: the reader enters their card on the processor's page and
 *             NSFWComix never sees, logs or stores card data. Memberships save
 *             a payment method token (pm_...) through a SETUP-mode hosted
 *             checkout and are charged off-session each period. The hosted
 *             page is shown one of two ways (`Surface`): framed inside our
 *             own page ('embed') or as a full-page visit that comes back to
 *             our return URL ('redirect').
 *   sandbox   Completes instantly with no processor so the whole flow can be
 *             exercised in development. Refused when NODE_ENV=production.
 *
 * Every Divinity charge is created as a hold on the processor's side, keyed
 * by the id we send as `pledgeId`. NSFWComix sells immediately, so each paid
 * order / membership charge is captured as soon as the hold exists
 * (`payment.succeeded`), with the housekeeping job retrying any that are not.
 *
 * Whatever path reports a payment (the reader returning from checkout, a
 * webhook, the reconciliation job) ends in `completeOrder` /
 * `markChargePaid`, which are idempotent.
 */

// ------------------------------------------------------------------ Divinity client

export type DcResponse = { ok: boolean; status: number; data: Row; error: string | null; code: string | null };

const DC_READ_ONLY = new Set(['get-checkout-session', 'lookup-payment', 'verify-payment']);
const DC_GATEWAY = new Set([502, 503, 504]);
const STORE_PROJECT = 'nsfwcomix-store';
const MEMBERSHIP_PROJECT = 'nsfwcomix-membership';

function dcErrorText(body: Row): string | null {
  for (const c of [body.error, body.message, body.detail, body.reason]) {
    if (typeof c === 'string' && c.trim()) return c.trim();
    if (c && typeof c === 'object') {
      for (const k of ['message', 'error', 'detail', 'code']) if (typeof c[k] === 'string' && c[k].trim()) return c[k].trim();
    }
  }
  return null;
}

/**
 * One call to the partner API: POST <divinity_api_url>?action=<action> with
 * `Authorization: Bearer <api key>` and `X-Partner-ID`. Reads are retried
 * once on a gateway error; writes are not (their callers hold idempotency
 * keys). `ok` is false for a non-2xx answer AND for a 200 carrying
 * `success: false`.
 */
export async function dcCall(action: string, payload: Row): Promise<DcResponse> {
  const s = await getSetting('payments');
  if (!s.divinity_api_key || !s.divinity_partner_id) throw notConfigured();
  const send = () =>
    fetch(`${s.divinity_api_url}?action=${encodeURIComponent(action)}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${s.divinity_api_key}`, 'content-type': 'application/json', 'x-partner-id': s.divinity_partner_id },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(20_000),
    });
  try {
    let res = await send();
    if (DC_GATEWAY.has(res.status) && DC_READ_ONLY.has(action)) {
      await new Promise((r) => setTimeout(r, 1500));
      res = await send();
    }
    const raw = await res.text();
    let data: Row = {};
    try {
      const parsed = raw ? JSON.parse(raw) : {};
      if (parsed && typeof parsed === 'object') data = parsed;
    } catch {
      // gateway error page; fall through with the status
    }
    const code = typeof data.code === 'string' ? data.code : typeof data.errorCode === 'string' ? data.errorCode : null;
    if (!res.ok) {
      const gateway = DC_GATEWAY.has(res.status) || /^\s*<(!doctype|html)/i.test(raw);
      return { ok: false, status: res.status, data, error: gateway ? `Payment processor unavailable (HTTP ${res.status})` : (dcErrorText(data) ?? `${action} failed with HTTP ${res.status}`), code: gateway ? 'gateway_unavailable' : code };
    }
    if (data.success === false) return { ok: false, status: res.status, data, error: dcErrorText(data) ?? `${action} reported failure`, code };
    return { ok: true, status: res.status, data, error: null, code };
  } catch (e) {
    return { ok: false, status: 0, data: {}, error: (e as Error).message || 'Payment processor unreachable', code: 'network_error' };
  }
}

/** `X-Webhook-Signature: t=<unix seconds>,v1=<hex hmac-sha256 of "t.body">`. */
export function signDivinityPayload(rawBody: string, secret: string, timestamp = Math.floor(Date.now() / 1000)): string {
  return `t=${timestamp},v1=${createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex')}`;
}

export function verifyDivinitySignature(rawBody: string, header: string, secret: string, nowMs = Date.now()): boolean {
  if (!secret || !header) return false;
  const parts = header.split(',').map((p) => p.trim());
  const t = parts.find((p) => p.startsWith('t='))?.slice(2);
  const v1 = parts.find((p) => p.startsWith('v1='))?.slice(3);
  if (!t || !v1 || !/^\d+$/.test(t)) return false;
  const age = nowMs / 1000 - Number(t);
  if (age < -30 || age > 300) return false;
  const expected = Buffer.from(createHmac('sha256', secret).update(`${t}.${rawBody}`).digest('hex'));
  const given = Buffer.from(v1);
  return expected.length === given.length && timingSafeEqual(expected, given);
}

// ------------------------------------------------------------------ providers

export type Origin = { ip: string | null; userAgent: string | null };
/**
 * How the reader's browser shows the hosted checkout page. The browser
 * chooses (it knows whether it can type into a framed card form); the server
 * only has to create the session to match.
 */
export type Surface = 'embed' | 'redirect';
type SessionState = { status: 'pending' | 'complete' | 'failed' | 'expired' | 'canceled'; mode: 'payment' | 'setup'; paymentRef: string | null; paymentMethod: string | null; message: string | null };
type ChargeResult = { outcome: 'paid' | 'declined' | 'uncertain'; paymentRef: string | null; error: string | null; code: string | null };

export type PaymentProvider = {
  name: 'sandbox' | 'divinity';
  /** Begin paying for an order. `url` null means the provider settled it on the spot. */
  startOrder(a: { orderId: string; next?: string | null; userId: string; email: string; amountCents: number; currency: string; description: string; origin: Origin; surface?: Surface }): Promise<{ ref: string; url: string | null; state: SessionState['status'] }>;
  /** Begin saving a payment method. `token` set means no redirect is needed. */
  startSetup(a: { key: string; next?: string | null; userId: string; email: string; description: string; origin: Origin; surface?: Surface }): Promise<{ ref: string; url: string | null; token: string | null }>;
  getSession(ref: string): Promise<SessionState | null>;
  /** Charge a saved payment method off-session. `attempt` starts at 1. */
  charge(a: { chargeId: string; userId: string; token: string; amountCents: number; currency: string; attempt: number; description: string; origin: Origin }): Promise<ChargeResult>;
  /** Did a charge with this id go through? null = the processor could not say. */
  lookup(id: string): Promise<{ paid: boolean; paymentRef: string | null } | null>;
  /** Turn the processor-side hold into a completed sale. False = not yet possible, retry later. */
  capture(id: string): Promise<boolean>;
  refund(a: { paymentRef: string; id: string; amountCents: number; reason: string }): Promise<{ ok: boolean; error: string | null }>;
};

function notConfigured(): HttpError {
  return new HttpError(
    503,
    'Payments are not set up yet. An administrator needs to configure the payment provider under Admin → Integrations → Payments before anything can be bought.',
    'payments_not_configured',
  );
}

const sandbox: PaymentProvider = {
  name: 'sandbox',
  async startOrder(a) {
    return { ref: `sbx_${a.orderId}`, url: null, state: 'complete' };
  },
  async startSetup(a) {
    return { ref: `sbx_setup_${a.key}`, url: null, token: 'pm_sandbox' };
  },
  async getSession() {
    return null;
  },
  async charge(a) {
    return { outcome: 'paid', paymentRef: `sbx_pay_${a.chargeId}_${a.attempt}`, error: null, code: null };
  },
  async lookup() {
    return { paid: false, paymentRef: null };
  },
  async capture() {
    return true;
  },
  async refund() {
    return { ok: true, error: null };
  },
};

function originFields(o: Origin): Row {
  const out: Row = {};
  // As reported by the reader's browser; never our own server's address.
  if (o.ip && /^[0-9a-fA-F:.]{3,45}$/.test(o.ip) && o.ip !== '127.0.0.1' && o.ip !== '::1') out.customerIpAddress = o.ip;
  if (o.userAgent) out.customerUserAgent = o.userAgent.slice(0, 512);
  return out;
}

/**
 * Buyers are never told which company moves the money: anything the processor
 * wrote that ends up in front of them has its own name (and its card
 * network's) replaced.
 */
export function whiteLabel(text: string): string {
  return text.replace(/\b(divinity\s*coin|divinity(\s+payments)?|stripe)\b/gi, 'the payment processor').replace(/\s+/g, ' ').trim();
}

/** What a decline code means, in words the cardholder can act on. */
const DECLINES: Record<string, string> = {
  insufficient_funds: 'The card does not have enough available funds. Try another card or contact your bank.',
  do_not_honor: 'Your bank declined the payment without giving a reason. Contact your bank to approve it, or try another card.',
  generic_decline: 'Your bank declined the payment. Try another card or contact your bank.',
  card_declined: 'The card was declined. Try another card or contact your bank.',
  expired_card: 'The card has expired. Use a different card.',
  incorrect_cvc: 'The security code (CVC) did not match the card. Check it and try again.',
  invalid_cvc: 'The security code (CVC) is not valid. Check it and try again.',
  incorrect_number: 'The card number is not right. Check it and try again.',
  invalid_number: 'The card number is not valid. Check it and try again.',
  invalid_expiry_month: 'The expiry month on the card is not valid.',
  invalid_expiry_year: 'The expiry year on the card is not valid.',
  lost_card: 'This card cannot be used. Use a different card.',
  stolen_card: 'This card cannot be used. Use a different card.',
  pickup_card: 'This card cannot be used. Use a different card.',
  restricted_card: 'The card has restrictions that stopped the payment. Use a different card or contact your bank.',
  processing_error: 'Your bank reported a processing error. Try again in a moment, or use a different card.',
  card_velocity_exceeded: 'The card has reached its limit for now. Wait a while and try again, or use a different card.',
  card_not_supported: 'This kind of card is not supported. Try a different card.',
  currency_not_supported: 'The card cannot be charged in this currency. Try a different card.',
  fraudulent: 'Your bank blocked the payment. Contact your bank to approve it, or use a different card.',
  authentication_required: 'Your bank needs you to confirm this payment. Try again and complete the verification step.',
  call_issuer: 'Your bank needs to approve this payment. Contact them, or use a different card.',
  transaction_not_allowed: 'Your bank does not allow this kind of payment on the card. Use a different card.',
};

/**
 * One sentence for the buyer from whatever the processor said about a
 * declined payment: the precise decline code first, then the general code,
 * then its own text; null when it said nothing usable.
 */
export function declineMessage(d: Row): string | null {
  for (const c of [d.declineCode, d.decline_code, d.code, d.errorCode]) if (typeof c === 'string' && DECLINES[c]) return DECLINES[c];
  for (const t of [d.failureMessage, d.declineReason, d.failureReason, d.lastPaymentError, d.error, d.message]) {
    const text = typeof t === 'string' ? t : t && typeof t === 'object' && typeof (t as Row).message === 'string' ? ((t as Row).message as string) : '';
    if (text.trim()) return whiteLabel(text).slice(0, 240);
  }
  return null;
}

function sessionState(s: Row): SessionState | null {
  if (!s || typeof s.status !== 'string') return null;
  const status = s.status.toLowerCase() as SessionState['status'];
  return {
    status,
    mode: String(s.mode ?? 'payment').toLowerCase() === 'setup' ? 'setup' : 'payment',
    paymentRef: typeof s.paymentIntentId === 'string' ? s.paymentIntentId : null,
    paymentMethod: typeof s.paymentMethodId === 'string' ? s.paymentMethodId : null,
    // Only a session that ended badly has a reason worth repeating.
    message: status === 'failed' ? declineMessage({ ...s, message: null }) : null,
  };
}

/**
 * The surface a session is really created for. The owner can switch the
 * embedded checkout off (Admin → Settings → Payments) until the processor
 * allows this site to frame its page; every session is then a redirect,
 * whatever the browser asked for.
 */
export async function resolveSurface(asked: Surface | null | undefined): Promise<Surface> {
  if (asked !== 'embed') return 'redirect';
  return (await getSetting('payments')).divinity_embed_checkout === false ? 'redirect' : 'embed';
}

const startFailed = (r: DcResponse) =>
  new HttpError(502, `We could not start the checkout: ${whiteLabel(r.error ?? 'the payment processor returned an incomplete answer').replace(/[.\s]+$/, '')}. You have not been charged.`, 'checkout_unavailable');

const divinity: PaymentProvider = {
  name: 'divinity',
  async startOrder(a) {
    const s = await getSetting('payments');
    const r = await dcCall('create-checkout-session', {
      mode: 'payment',
      platformUserId: a.userId,
      email: a.email,
      amount: a.amountCents,
      currency: a.currency,
      // One hold per pledgeId on the processor: the order id is ours to reconcile on.
      pledgeId: a.orderId,
      projectId: STORE_PROJECT,
      returnUrl: `${config.appUrl}/checkout/return?order=${a.orderId}${a.next ? `&next=${encodeURIComponent(a.next)}` : ''}`,
      cancelUrl: `${config.appUrl}/checkout/return?order=${a.orderId}&cancelled=1`,
      description: a.description.slice(0, 200),
      expiresInMinutes: 60,
      // One session per order, however often the reader retries or reloads.
      idempotencyKey: a.orderId,
      // Framed in our own page: the processor must not navigate the browser away when the
      // session ends. Its page tells ours instead (postMessage) and our page carries on.
      ...(a.surface === 'embed' ? { disableAutoRedirect: true } : {}),
      ...(s.divinity_checkout_logo_url ? { partnerLogoUrl: s.divinity_checkout_logo_url } : {}),
      ...originFields(a.origin),
    });
    if (!r.ok || !r.data.sessionId || !r.data.checkoutUrl) throw startFailed(r);
    return { ref: String(r.data.sessionId), url: String(r.data.checkoutUrl), state: r.data.status === 'complete' ? 'complete' : 'pending' };
  },
  async startSetup(a) {
    const s = await getSetting('payments');
    const r = await dcCall('create-checkout-session', {
      mode: 'setup',
      platformUserId: a.userId,
      email: a.email,
      // `next` (already validated same-site) rides along so /account/membership can send the reader on afterwards.
      returnUrl: `${config.appUrl}/account/membership${a.next ? `?next=${encodeURIComponent(a.next)}` : ''}`,
      cancelUrl: `${config.appUrl}/account/membership?cancelled=1${a.next ? `&next=${encodeURIComponent(a.next)}` : ''}`,
      description: a.description.slice(0, 200),
      expiresInMinutes: 60,
      idempotencyKey: `setup-${a.key}`,
      ...(a.surface === 'embed' ? { disableAutoRedirect: true } : {}),
      ...(s.divinity_checkout_logo_url ? { partnerLogoUrl: s.divinity_checkout_logo_url } : {}),
      ...originFields(a.origin),
    });
    if (!r.ok || !r.data.sessionId || !r.data.checkoutUrl) throw startFailed(r);
    return { ref: String(r.data.sessionId), url: String(r.data.checkoutUrl), token: null };
  },
  async getSession(ref) {
    const r = await dcCall('get-checkout-session', { sessionId: ref });
    if (!r.ok) return null;
    return sessionState(r.data.session ?? r.data);
  },
  async charge(a) {
    const r = await dcCall('charge-saved-payment-method', {
      platformUserId: a.userId,
      paymentMethodId: a.token,
      amount: a.amountCents,
      currency: a.currency,
      // Reconciliation key: never altered between attempts.
      pledgeId: a.chargeId,
      projectId: MEMBERSHIP_PROJECT,
      description: a.description.slice(0, 200),
      // A distinct key per attempt, or a retry of a declined card inside 24h
      // replays the cached decline without reaching the bank.
      idempotencyKey: `attempt-${a.attempt}`,
      ...originFields(a.origin),
    });
    const paymentRef = typeof r.data.paymentIntentId === 'string' ? r.data.paymentIntentId : null;
    if (r.ok && r.data.success === true) return { outcome: 'paid', paymentRef, error: null, code: null };
    const status = String(r.data.status ?? '');
    // Still in flight, or the processor never decided: do not burn an attempt.
    if (r.code === 'idempotency_key_in_use' || r.code === 'gateway_unavailable' || r.code === 'network_error' || status === 'processing') return { outcome: 'uncertain', paymentRef, error: r.error, code: r.code };
    if (r.status === 402 || r.code || status) return { outcome: 'declined', paymentRef, error: r.error ?? 'The card was declined', code: (r.data.declineCode as string) ?? r.code ?? status };
    if (r.status >= 400 && r.status < 500) return { outcome: 'declined', paymentRef, error: r.error, code: `http_${r.status}` };
    return { outcome: 'uncertain', paymentRef, error: r.error, code: r.code };
  },
  async lookup(id) {
    const r = await dcCall('lookup-payment', { pledgeId: id });
    if (!r.ok) return null;
    if (r.data.hasSuccessfulCharge === true) {
      const hit = ((r.data.attempts as Row[]) ?? []).find((x) => ['succeeded', 'completed', 'COMPLETED'].includes(String(x.status ?? x.stripeStatus ?? '')));
      return { paid: true, paymentRef: (hit?.paymentIntentId as string) ?? ((r.data.attempts as Row[])?.[0]?.paymentIntentId as string) ?? null };
    }
    // `reconciled: false` means "unknown", not "safe to charge again".
    if (r.data.reconciled === false) return null;
    return { paid: false, paymentRef: null };
  },
  async capture(id) {
    const r = await dcCall('capture', { pledgeId: id });
    if (r.ok) return true;
    // Already captured counts; "hold not found" means the processor has not placed it yet.
    return /CAPTURED/i.test(`${r.error ?? ''} ${r.data.message ?? ''}`);
  },
  async refund(a) {
    const r = await dcCall('refund', { paymentIntentId: a.paymentRef, pledgeId: a.id, amount: a.amountCents, reason: a.reason.slice(0, 200), requestedBy: 'admin' });
    if (r.ok || r.code === 'ALREADY_PROCESSED') return { ok: true, error: null };
    return { ok: false, error: r.error };
  },
};

/** The provider chosen in settings (or a named one, for rows created under it). */
export async function getProvider(name?: string): Promise<PaymentProvider> {
  const s = await getSetting('payments');
  const which = name ?? s.provider;
  if (which === 'divinity') {
    if (!s.divinity_api_key || !s.divinity_partner_id) throw notConfigured();
    return divinity;
  }
  if (which === 'sandbox') {
    // Read at call time so a misconfigured production server can never sell for free.
    if (process.env.NODE_ENV === 'production') throw notConfigured();
    return sandbox;
  }
  throw notConfigured();
}

export async function money(cents: number): Promise<string> {
  const site = await getSetting('site');
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: site.currency.toUpperCase() }).format(cents / 100);
  } catch {
    return `$${(cents / 100).toFixed(2)}`;
  }
}

async function walletAdd(db: Queryable, userId: string, kind: string, creditCents: number, pageCredits: number, note: string): Promise<void> {
  await db.query(
    `insert into wallets (user_id, credit_cents, page_credits) values ($1, greatest($2,0), greatest($3,0))
     on conflict (user_id) do update set credit_cents = greatest(0, wallets.credit_cents + $2),
       page_credits = greatest(0, wallets.page_credits + $3), updated_at = now()`,
    [userId, creditCents, pageCredits],
  );
  await db.query('insert into wallet_log (user_id, kind, credit_cents, page_credits, note) values ($1,$2,$3,$4,$5)', [userId, kind, creditCents, pageCredits, note]);
}
export { walletAdd };

// ------------------------------------------------------------------ orders

export type OrderResult = { completed: boolean; order_id: string; status: string; url?: string; session_id?: string; surface?: Surface; amount_cents?: number };

/**
 * Take a freshly created `pending` order to the provider. Orders fully
 * covered by store credit (or free after a code) complete without one.
 * `surface` is how the reader's browser will show the hosted page; the
 * answer carries the one the session was really created for.
 */
export async function startOrderPayment(orderId: string, surface: Surface = 'redirect'): Promise<OrderResult> {
  const o = await one('select o.*, u.email from orders o join users u on u.id = o.user_id where o.id = $1', [orderId]);
  if (!o) throw new HttpError(404, 'Order not found');
  const charge = o.total_cents - o.credit_cents;
  if (charge <= 0) {
    await exec(`update orders set provider = 'credit', provider_ref = $2 where id = $1`, [orderId, `free_${orderId}`]);
    await completeOrder(orderId);
    return { completed: true, order_id: orderId, status: 'paid' };
  }
  const site = await getSetting('site');
  try {
    const p = await getProvider(o.provider);
    const items = await q<{ description: string }>('select description from order_items where order_id = $1 order by id', [orderId]);
    const description = items.length === 1 ? items[0].description : `${site.name} order (${items.length} items)`;
    const shown = await resolveSurface(surface);
    const s = await p.startOrder({ orderId, next: typeof o.meta?.return_to === 'string' ? o.meta.return_to : null, userId: o.user_id, email: o.email, amountCents: charge, currency: site.currency, description, origin: { ip: o.ip, userAgent: o.user_agent }, surface: shown });
    await exec('update orders set provider_ref = $2 where id = $1', [orderId, s.ref]);
    if (s.state === 'complete') {
      await completeOrder(orderId);
      await captureOrder(orderId);
      return { completed: true, order_id: orderId, status: 'paid' };
    }
    return { completed: false, order_id: orderId, status: 'pending', url: s.url ?? undefined, session_id: s.ref, surface: shown, amount_cents: charge };
  } catch (e) {
    await failOrder(orderId, (e as Error).message);
    throw e;
  }
}

/**
 * Grant everything a paid order bought. Idempotent: only the first call for
 * an order does anything, whichever of the return page, a webhook or the
 * reconciliation job gets here first.
 */
export async function completeOrder(orderId: string, opts: { paymentRef?: string | null } = {}): Promise<boolean> {
  const rev = await getSetting('revenue');
  const giftCards: { code: string; amount: number; to: string; message: string }[] = [];
  const done = await tx(async (db) => {
    const o = await one('select * from orders where id = $1 for update', [orderId], db);
    if (!o || (o.status !== 'pending' && o.status !== 'failed')) {
      if (o && opts.paymentRef && !o.payment_ref) await exec('update orders set payment_ref = $2 where id = $1', [orderId, opts.paymentRef], db);
      return null;
    }
    // A session reported failed can still be paid afterwards. Its store
    // credit went back to the wallet then, so take it again (as far as it is still there).
    if (o.status === 'failed' && o.credit_cents > 0 && o.meta?.credit_restored) {
      const w = await one<{ credit_cents: number }>('select credit_cents from wallets where user_id = $1 for update', [o.user_id], db);
      const take = Math.min(w?.credit_cents ?? 0, o.credit_cents);
      if (take > 0) await walletAdd(db, o.user_id, 'purchase', -take, 0, `Store credit used on order ${orderId.slice(-8)}`);
    }
    const items = await q('select * from order_items where order_id = $1 order by id', [orderId], db);
    const charge = Math.max(0, o.total_cents - o.credit_cents);
    const fee = o.provider === 'credit' ? 0 : estimateFee(charge, rev);
    const fees = allocate(fee, items.map((i) => i.price_cents), items.map((i) => i.id));

    for (const [n, it] of items.entries()) {
      const meta = (it.meta ?? {}) as Row;
      let creator = 0;
      const grant = async (releaseId: string, download: boolean) =>
        db.query(
          `insert into entitlements (user_id, release_id, source, order_id, can_download) values ($1,$2,'purchase',$3,$4)
           on conflict (user_id, release_id) do update set can_download = entitlements.can_download or excluded.can_download,
             order_id = coalesce(entitlements.order_id, excluded.order_id)`,
          [o.user_id, releaseId, orderId, download],
        );
      if (it.kind === 'release' || it.kind === 'download') {
        await grant(it.release_id, it.kind === 'download');
        creator = (await creditSale(db, { publisherId: it.publisher_id, seriesId: it.series_id, releaseId: it.release_id, orderId, priceCents: it.price_cents, feeCents: fees[n], note: it.description })).creator_cents;
      } else if (it.kind === 'series') {
        for (const id of (meta.release_ids as string[]) ?? []) await grant(id, false);
        creator = (await creditSale(db, { publisherId: it.publisher_id, seriesId: it.series_id, orderId, priceCents: it.price_cents, feeCents: fees[n], note: it.description })).creator_cents;
      } else if (it.kind === 'bundle') {
        const parts = ((meta.releases as { id: string; series_id: string; weight: number }[]) ?? []).slice().sort((a, b) => (a.id < b.id ? -1 : 1));
        for (const p of parts) await grant(p.id, Boolean(meta.includes_download));
        // The bundle price is shared out over its releases, then credited per series so each series' splits apply.
        const prices = allocate(it.price_cents, parts.map((p) => Math.max(1, p.weight)), parts.map((p) => p.id));
        const partFees = allocate(fees[n], prices, parts.map((p) => p.id));
        const bySeries = new Map<string, { price: number; fee: number }>();
        parts.forEach((p, i) => {
          const s = bySeries.get(p.series_id) ?? { price: 0, fee: 0 };
          s.price += prices[i];
          s.fee += partFees[i];
          bySeries.set(p.series_id, s);
        });
        for (const [seriesId, s] of [...bySeries].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
          creator += (await creditSale(db, { publisherId: it.publisher_id, seriesId, orderId, priceCents: s.price, feeCents: s.fee, note: it.description })).creator_cents;
        }
      } else if (it.kind === 'tip') {
        await db.query('insert into tips (user_id, publisher_id, order_id, amount_cents, message, show_amount) values ($1,$2,$3,$4,$5,$6)', [
          o.user_id, it.publisher_id, orderId, it.price_cents, String(meta.message ?? '').slice(0, 500), meta.show_amount !== false,
        ]);
        creator = (await creditTip(db, { publisherId: it.publisher_id, orderId, priceCents: it.price_cents, feeCents: fees[n], note: it.description })).creator_cents;
      } else if (it.kind === 'gift_card') {
        const code = randomCode(4, 4);
        await db.query('insert into gift_cards (code, amount_cents, balance_cents, purchaser_id, recipient_email, message, order_id) values ($1,$2,$2,$3,$4,$5,$6)', [
          code, it.price_cents, o.user_id, meta.recipient_email ?? null, String(meta.message ?? '').slice(0, 500), orderId,
        ]);
        giftCards.push({ code, amount: it.price_cents, to: String(meta.recipient_email ?? ''), message: String(meta.message ?? '') });
      } else if (it.kind === 'credits') {
        await walletAdd(db, o.user_id, 'credits_purchase', 0, Number(meta.quantity ?? 0), `${meta.quantity} page credits`);
      }
      if (creator) await db.query('update order_items set creator_cents = $2 where id = $1', [it.id, creator]);
    }
    if (o.discount_code_id) {
      const used = await db.query('insert into code_redemptions (code_id, user_id) values ($1,$2) on conflict do nothing', [o.discount_code_id, o.user_id]);
      if (used.rowCount) await db.query('update promo_codes set redeemed_count = redeemed_count + 1 where id = $1', [o.discount_code_id]);
    }
    await db.query(
      `update orders set status = 'paid', paid_at = now(), fee_cents = $2, payment_ref = coalesce($3, payment_ref),
              captured_at = case when provider = 'divinity' then captured_at else now() end where id = $1`,
      [orderId, fee, opts.paymentRef ?? null],
    );
    return { order: o, items };
  });
  if (!done) return false;

  // After commit: nothing below can undo the purchase.
  const { order, items } = done;
  try {
    const u = await one<{ email: string; display_name: string }>('select email, display_name from users where id = $1', [order.user_id]);
    if (u) {
      const rows = await Promise.all(items.map(async (i) => `<tr><td style="padding:4px 12px 4px 0">${escapeHtml(i.description)}</td><td align="right">${await money(i.price_cents)}</td></tr>`));
      if (order.credit_cents > 0) rows.push(`<tr><td style="padding:4px 12px 4px 0">Store credit</td><td align="right">-${await money(order.credit_cents)}</td></tr>`);
      await sendTemplate('receipt', u.email, {
        name: u.display_name, items: `<table role="presentation" cellpadding="0" cellspacing="0" width="100%">${rows.join('')}</table>`,
        total: await money(order.total_cents - order.credit_cents), url: `${config.appUrl}/library`,
      }, { userId: order.user_id });
      for (const g of giftCards) {
        await sendTemplate('gift_card', g.to || u.email, {
          amount: await money(g.amount), message: g.message || `${u.display_name} sent you a gift card.`, code: g.code, url: `${config.appUrl}/account/codes?code=${g.code}`,
        }, { userId: g.to ? null : order.user_id });
      }
    }
    await notify(order.user_id, 'purchase', 'Purchase complete', items.map((i) => i.description).join(', '), '/account/purchases');
    for (const t of items.filter((i) => i.kind === 'tip')) {
      const owners = await q<{ user_id: string }>(`select user_id from publisher_members where publisher_id = $1 and role in ('owner','admin')`, [t.publisher_id]);
      const brand = await one<{ slug: string }>('select slug from publishers where id = $1', [t.publisher_id]);
      for (const m of owners) await notify(m.user_id, 'tip', `You received a ${await money(t.price_cents)} tip`, String(t.meta?.message ?? ''), brand ? `/studio/${brand.slug}/earnings` : '/studio');
    }
  } catch (e) {
    captureError(e, { source: 'api', endpoint: 'completeOrder', meta: { orderId } });
  }
  return true;
}

export type FailureState = 'failed' | 'expired' | 'canceled';

/** What to tell a buyer whose checkout ended without a payment, when the processor gave no reason of its own. */
export const FAILURE_TEXT: Record<FailureState, string> = {
  failed: 'The card was not accepted, so nothing was charged.',
  expired: 'The checkout timed out before it was paid, so nothing was charged.',
  canceled: 'The checkout was cancelled before it was paid, so nothing was charged.',
};

/**
 * A checkout that will not be paid: mark it and hand any reserved store
 * credit back. `reason` is shown to the buyer (`orders.meta.failure`);
 * `state` records how the checkout ended (`orders.meta.failure_state`).
 */
export async function failOrder(orderId: string, reason: string, state: FailureState = 'failed'): Promise<boolean> {
  return tx(async (db) => {
    const o = await one('select * from orders where id = $1 for update', [orderId], db);
    if (!o || o.status !== 'pending') return false;
    if (o.credit_cents > 0) await walletAdd(db, o.user_id, 'refund', o.credit_cents, 0, `Store credit returned from unpaid order ${orderId.slice(-8)}`);
    await db.query(`update orders set status = 'failed', meta = meta || $2::jsonb where id = $1`, [orderId, JSON.stringify({ failure: reason.slice(0, 300), failure_state: state, credit_restored: o.credit_cents > 0 })]);
    return true;
  });
}

/** Capture the processor-side hold for a paid order (immediate sale). */
export async function captureOrder(orderId: string): Promise<boolean> {
  const o = await one(`select id, provider from orders where id = $1 and status = 'paid' and captured_at is null`, [orderId]);
  if (!o) return false;
  const ok = await (await getProvider(o.provider)).capture(orderId);
  if (ok) await exec('update orders set captured_at = now() where id = $1 and captured_at is null', [orderId]);
  return ok;
}

/**
 * Undo a paid order in our books: reverse creator earnings, remove what was
 * granted, return any store credit that was spent. Idempotent. Used for
 * refunds and for disputes/chargebacks.
 */
export async function reverseOrderBooks(orderId: string, why: { reason: string; dispute?: Row }): Promise<boolean> {
  const done = await tx(async (db) => {
    const o = await one('select * from orders where id = $1 for update', [orderId], db);
    if (!o || o.status !== 'paid') return null;
    const items = await q('select * from order_items where order_id = $1', [orderId], db);
    await reverseOrder(db, orderId, why.dispute ? `Chargeback: ${why.reason}` : `Refund: ${why.reason}`);
    await db.query('delete from entitlements where user_id = $1 and order_id = $2', [o.user_id, orderId]);
    await db.query('delete from tips where order_id = $1', [orderId]);
    for (const it of items) {
      if (it.kind === 'credits') await walletAdd(db, o.user_id, 'refund', 0, -Number(it.meta?.quantity ?? 0), 'Page credits removed after refund');
      if (it.kind === 'gift_card') {
        const cards = await q('select * from gift_cards where order_id = $1 for update', [orderId], db);
        for (const g of cards) {
          if (g.redeemed_by) await walletAdd(db, g.redeemed_by, 'refund', -g.amount_cents, 0, 'Gift card refunded to the buyer');
          await db.query('update gift_cards set balance_cents = 0, redeemed_at = coalesce(redeemed_at, now()) where id = $1', [g.id]);
        }
      }
    }
    // Store credit comes back for a refund; a chargeback forfeits nothing extra but returns nothing either.
    if (o.credit_cents > 0 && !why.dispute) await walletAdd(db, o.user_id, 'refund', o.credit_cents, 0, `Store credit returned from refunded order ${orderId.slice(-8)}`);
    await db.query(`update orders set status = 'refunded', refunded_at = now(), meta = meta || $2::jsonb where id = $1`, [
      orderId, JSON.stringify(why.dispute ? { dispute: why.dispute, refund_reason: why.reason } : { refund_reason: why.reason }),
    ]);
    return o;
  });
  if (!done) return false;
  await notify(done.user_id, 'refund', why.dispute ? 'A payment was disputed' : 'Your order was refunded', why.dispute ? 'Access from that order has been removed.' : 'The items from that order have been removed from your library.', '/account/purchases').catch(() => {});
  return true;
}

export type PartialRefund = { ref: string | null; amount_cents: number; creator_cents: number; platform_cents: number; fee_cents: number; reason: string; at: string };

/**
 * Part of an order's card payment went back to the reader (reported by the
 * processor). The books follow in proportion: of every refunded cent, the
 * creators, the platform and the processing fee each give back the share
 * they took of the order, and the three parts add up to exactly the refund.
 * The reader keeps everything the order unlocked and the order stays `paid`;
 * `orders.refunded_cents` and `orders.meta.partial_refunds` record it.
 *
 * Idempotent per processor refund id. `full` means the refunds now add up to
 * the whole card charge: nothing is written and the caller treats it as a
 * full refund (`reverseOrderBooks`), which takes back what was unlocked.
 */
export async function partialRefundOrder(orderId: string, a: { amountCents: number; ref?: string | null; reason?: string }): Promise<'applied' | 'duplicate' | 'full' | 'ignored'> {
  if (!Number.isInteger(a.amountCents) || a.amountCents <= 0) return 'ignored';
  const reason = (a.reason?.trim() || 'Partly refunded by the payment processor').slice(0, 300);
  const out = await tx(async (db) => {
    const o = await one('select * from orders where id = $1 for update', [orderId], db);
    if (!o || o.status !== 'paid') return { result: 'ignored' as const };
    const earlier = ((o.meta?.partial_refunds as PartialRefund[] | undefined) ?? []).slice();
    if (a.ref ? earlier.some((r) => r.ref === a.ref) : earlier.some((r) => !r.ref && r.amount_cents === a.amountCents && Date.parse(r.at) > Date.now() - 600_000)) return { result: 'duplicate' as const };
    const charge = o.total_cents - o.credit_cents;
    const running = (o.refunded_cents as number) + a.amountCents;
    if (running >= charge) return { result: 'full' as const };
    const earned = await one<{ cents: number }>(`select coalesce(sum(amount_cents), 0)::int as cents from ledger where order_id = $1 and kind in ('sale','tip')`, [orderId], db);
    // Running totals, so several partial refunds can never drift by a cent.
    const target = refundParts({ total_cents: o.total_cents, fee_cents: o.fee_cents, creator_cents: earned?.cents ?? 0 }, running);
    const before = earlier.reduce((n, r) => ({ creator: n.creator + r.creator_cents, platform: n.platform + r.platform_cents, fee: n.fee + r.fee_cents }), { creator: 0, platform: 0, fee: 0 });
    const creator = await reverseOrderPartly(db, orderId, target.creator_cents, running, `Partial refund: ${reason}`);
    const entry: PartialRefund = {
      ref: a.ref ?? null, amount_cents: a.amountCents, creator_cents: creator,
      platform_cents: target.platform_cents - before.platform, fee_cents: a.amountCents - creator - (target.platform_cents - before.platform),
      reason, at: new Date().toISOString(),
    };
    await db.query(`update orders set refunded_cents = $2, meta = meta || $3::jsonb where id = $1`, [orderId, running, JSON.stringify({ partial_refunds: [...earlier, entry] })]);
    return { result: 'applied' as const, order: o };
  });
  if (out.result === 'applied') {
    await notify(out.order.user_id, 'refund', 'Part of your order was refunded', `${await money(a.amountCents)} is on its way back to your card. Everything from the order stays in your library.`, `/account/purchases/${orderId}`).catch(() => {});
  }
  return out.result;
}

/**
 * Refund an order in full: ask the processor for the money first, then
 * reverse our books. For the admin panel; `refund.completed` webhooks end in
 * the same `reverseOrderBooks`.
 */
export async function refundOrder(orderId: string, opts: { reason?: string } = {}): Promise<{ refunded: boolean }> {
  const o = await one('select * from orders where id = $1', [orderId]);
  if (!o) throw new HttpError(404, 'Order not found');
  if (o.status === 'refunded') return { refunded: false };
  if (o.status !== 'paid') throw conflict('Only a paid order can be refunded');
  const reason = opts.reason?.trim() || 'Refunded by support';
  // Whatever earlier partial refunds already sent back is not asked for again.
  const charge = o.total_cents - o.credit_cents - (o.refunded_cents ?? 0);
  if (o.provider === 'divinity' && charge > 0) {
    if (!o.payment_ref) throw conflict('This order has no processor payment reference yet, so it cannot be refunded automatically');
    const r = await (await getProvider('divinity')).refund({ paymentRef: o.payment_ref, id: orderId, amountCents: charge, reason });
    if (!r.ok) throw new HttpError(502, `The payment processor did not accept the refund: ${r.error ?? 'unknown error'}. Nothing was changed.`);
  }
  return { refunded: await reverseOrderBooks(orderId, { reason }) };
}

// ------------------------------------------------------------------ membership

const RETRY_AFTER_DAYS = [1, 3, 5]; // after the 1st, 2nd, 3rd decline; the 4th ends the membership
const UNCERTAIN_RETRY_MIN = 10;

export function addPeriod(from: Date, plan: string): Date {
  const d = new Date(from);
  const day = d.getUTCDate();
  d.setUTCDate(1);
  if (plan === 'annual') d.setUTCFullYear(d.getUTCFullYear() + 1);
  else d.setUTCMonth(d.getUTCMonth() + 1);
  // Jan 31 + 1 month = Feb 28/29, not Mar 3.
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, last));
  return d;
}

function monthOf(d: Date, plus = 0): string {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + plus, 1)).toISOString().slice(0, 10);
}

/**
 * Book a paid period into the monthly pots that settlement splits among
 * creators: one month for a monthly plan, twelve equal months (remainder
 * cents first) for an annual one. A month already settled is never touched:
 * the amount rolls to the next open month.
 */
async function addSubMonths(db: Queryable, c: Row, plan: string): Promise<void> {
  const n = plan === 'annual' ? 12 : 1;
  const gross = allocate(c.amount_cents, Array(n).fill(1));
  const fee = allocate(c.fee_cents, Array(n).fill(1));
  const start = new Date(c.period_start);
  let shift = 0;
  for (let i = 0; i < n; i++) {
    for (;;) {
      const r = await db.query(
        `insert into sub_months (user_id, subscription_id, month, gross_cents, fee_cents, charge_id) values ($1,$2,$3,$4,$5,$6)
         on conflict (user_id, month) do update set gross_cents = sub_months.gross_cents + excluded.gross_cents,
           fee_cents = sub_months.fee_cents + excluded.fee_cents
         where sub_months.settled_at is null returning id`,
        [c.user_id, c.subscription_id, monthOf(start, i + shift), gross[i], fee[i], c.id],
      );
      if (r.rows.length || shift > 36) break;
      shift++;
    }
  }
}

/** A membership charge was paid. Idempotent. */
export async function markChargePaid(chargeId: string, paymentRef: string | null): Promise<boolean> {
  const rev = await getSetting('revenue');
  const done = await tx(async (db) => {
    const c = await one('select * from subscription_charges where id = $1 for update', [chargeId], db);
    if (!c || c.status === 'paid' || c.status === 'refunded') return null;
    const sub = await one('select * from subscriptions where id = $1 for update', [c.subscription_id], db);
    if (!sub) return null;
    c.fee_cents = estimateFee(c.amount_cents, rev);
    await db.query(
      `update subscription_charges set status = 'paid', paid_at = now(), fee_cents = $2, payment_ref = coalesce($3, payment_ref), uncertain = false,
              last_error = null, captured_at = case when $4 then null else now() end where id = $1`,
      [chargeId, c.fee_cents, paymentRef, sub.provider === 'divinity'],
    );
    await db.query(
      `update subscriptions set status = 'active', current_period_start = $2, current_period_end = $3, canceled_at = null where id = $1`,
      [sub.id, c.period_start, c.period_end],
    );
    await addSubMonths(db, c, sub.plan);
    const first = !(await one(`select 1 from subscription_charges where subscription_id = $1 and status = 'paid' and id <> $2 limit 1`, [sub.id, chargeId], db));
    return { c, sub, first };
  });
  if (!done) return false;
  try {
    if (done.first) await welcomeMember(done.sub.user_id, done.sub.plan, new Date(done.c.period_end));
  } catch (e) {
    captureError(e, { source: 'api', endpoint: 'markChargePaid' });
  }
  return true;
}

async function welcomeMember(userId: string, plan: string, renews: Date): Promise<void> {
  const u = await one<{ email: string; display_name: string }>('select email, display_name from users where id = $1', [userId]);
  const m = await getSetting('membership');
  if (u) await sendTemplate('membership_started', u.email, { name: u.display_name, plan: `${m.name} ${plan}`, renews: renews.toISOString().slice(0, 10), url: config.appUrl }, { userId });
  await notify(userId, 'membership', `${m.name} is active`, `Your ${plan} membership renews on ${renews.toISOString().slice(0, 10)}.`, '/account/membership');
}

async function memberMail(userId: string, subject: string, body: string): Promise<void> {
  const u = await one<{ email: string; display_name: string }>('select email, display_name from users where id = $1 and deleted_at is null', [userId]);
  if (!u) return;
  // Editable in /admin like every other template (lib/email.ts TEMPLATES.membership_billing).
  await sendTemplate('membership_billing', u.email, { subject, name: u.display_name, body, url: `${config.appUrl}/account/membership` }, { userId });
}

export async function captureCharge(chargeId: string): Promise<boolean> {
  const c = await one(
    `select c.id, s.provider from subscription_charges c join subscriptions s on s.id = c.subscription_id
      where c.id = $1 and c.status = 'paid' and c.captured_at is null`,
    [chargeId],
  );
  if (!c) return false;
  const ok = await (await getProvider(c.provider)).capture(chargeId);
  if (ok) await exec('update subscription_charges set captured_at = now() where id = $1 and captured_at is null', [chargeId]);
  return ok;
}

/**
 * Try to collect one membership charge. Declines are retried after 1, 3 and
 * 5 days (membership is `past_due` meanwhile) and the fourth decline ends the
 * membership. A call that got no answer is looked up before it is repeated,
 * and repeated under the same idempotency key.
 */
export async function attemptCharge(chargeId: string): Promise<'paid' | 'declined' | 'uncertain' | 'skipped'> {
  const c = await one('select * from subscription_charges where id = $1', [chargeId]);
  if (!c || c.status !== 'pending') return 'skipped';
  const sub = await one('select * from subscriptions where id = $1', [c.subscription_id]);
  if (!sub || !sub.payment_method_token || ['canceled', 'expired'].includes(sub.status)) {
    await exec(`update subscription_charges set status = 'failed', last_error = 'Membership ended before this charge' where id = $1 and status = 'pending'`, [chargeId]);
    return 'skipped';
  }
  const p = await getProvider(sub.provider);
  const site = await getSetting('site');
  const mem = await getSetting('membership');
  if (c.uncertain) {
    const seen = await p.lookup(chargeId);
    if (seen === null) {
      await exec(`update subscription_charges set next_attempt_at = now() + interval '${UNCERTAIN_RETRY_MIN} minutes' where id = $1`, [chargeId]);
      return 'uncertain';
    }
    if (seen.paid) {
      await markChargePaid(chargeId, seen.paymentRef);
      await captureCharge(chargeId).catch(() => false);
      return 'paid';
    }
  }
  const r = await p.charge({
    chargeId, userId: sub.user_id, token: sub.payment_method_token, amountCents: c.amount_cents, currency: site.currency, attempt: c.attempts + 1,
    description: `${mem.name} (${sub.plan})`, origin: { ip: sub.origin_ip, userAgent: sub.origin_user_agent },
  });
  if (r.outcome === 'paid') {
    await markChargePaid(chargeId, r.paymentRef);
    await captureCharge(chargeId).catch(() => false);
    return 'paid';
  }
  if (r.outcome === 'uncertain') {
    await exec(
      `update subscription_charges set uncertain = true, last_error = $2, next_attempt_at = now() + interval '${UNCERTAIN_RETRY_MIN} minutes' where id = $1 and status = 'pending'`,
      [chargeId, whiteLabel(r.error ?? 'No answer from the payment processor').slice(0, 300)],
    );
    return 'uncertain';
  }
  await recordDecline(chargeId, r.error ?? 'The card was declined', r.paymentRef);
  return 'declined';
}

/** Count a decline against a charge and move the membership along past_due → expired. */
export async function recordDecline(chargeId: string, error: string, paymentRef: string | null = null): Promise<void> {
  const out = await tx(async (db) => {
    const c = await one('select * from subscription_charges where id = $1 for update', [chargeId], db);
    if (!c || c.status !== 'pending') return null;
    // The member reads this on their membership page and in the "could not renew" email.
    error = whiteLabel(error);
    // The synchronous answer and the payment.failed webhook describe the same attempt: count it once.
    if (paymentRef && c.payment_ref === paymentRef) return null;
    const sub = await one('select * from subscriptions where id = $1 for update', [c.subscription_id], db);
    if (!sub) return null;
    const attempts = c.attempts + 1;
    const firstPeriod = sub.status === 'pending';
    const final = firstPeriod || attempts > RETRY_AFTER_DAYS.length;
    await db.query(
      `update subscription_charges set attempts = $2, uncertain = false, last_error = $3, payment_ref = coalesce($4, payment_ref),
              status = case when $5 then 'failed' else 'pending' end,
              next_attempt_at = now() + ($6 || ' days')::interval where id = $1`,
      [chargeId, attempts, error.slice(0, 300), paymentRef, final, String(final ? 0 : RETRY_AFTER_DAYS[attempts - 1])],
    );
    await db.query('update subscriptions set status = $2 where id = $1', [sub.id, final ? 'expired' : 'past_due']);
    return { sub, attempts, final, firstPeriod };
  });
  if (!out || out.firstPeriod) return;
  const mem = await getSetting('membership');
  if (out.final) {
    await memberMail(out.sub.user_id, `Your ${mem.name} membership has ended`, 'We could not collect your membership payment after several tries, so the membership has ended. You can start it again at any time; everything you bought stays in your library.').catch(() => {});
    await notify(out.sub.user_id, 'membership', `${mem.name} has ended`, 'We could not collect your membership payment.', '/account/membership').catch(() => {});
  } else if (out.attempts === 1) {
    await memberMail(out.sub.user_id, `We could not renew your ${mem.name} membership`, `Your card was declined (${error}). We will try again over the next few days. To keep reading without a break, update your payment method.`).catch(() => {});
    await notify(out.sub.user_id, 'membership', 'Membership payment failed', 'Update your payment method to keep your membership.', '/account/membership').catch(() => {});
  }
}

/** A saved payment method arrived for a pending membership: bill the first period (or start the trial). */
export async function activateMembership(subId: string, token: string): Promise<'active' | 'declined' | 'pending' | 'skipped'> {
  const sub = await one(`update subscriptions set payment_method_token = $2 where id = $1 and status = 'pending' and payment_method_token is null returning *`, [subId, token]);
  if (!sub) return 'skipped';
  const mem = await getSetting('membership');
  const now = new Date();
  const hadBefore = await one(`select 1 from subscriptions where user_id = $1 and id <> $2 and status <> 'pending' limit 1`, [sub.user_id, subId]);
  if (mem.trial_days > 0 && !hadBefore) {
    const end = new Date(now.getTime() + mem.trial_days * 86_400_000);
    await exec(`update subscriptions set status = 'active', current_period_start = $2, current_period_end = $3 where id = $1`, [subId, now, end]);
    await welcomeMember(sub.user_id, sub.plan, end).catch(() => {});
    return 'active';
  }
  const c = await one<{ id: string }>(
    `insert into subscription_charges (subscription_id, user_id, period_start, period_end, amount_cents) values ($1,$2,$3,$4,$5)
     on conflict (subscription_id, period_start) do nothing returning id`,
    [subId, sub.user_id, now, addPeriod(now, sub.plan), sub.price_cents],
  );
  if (!c) return 'skipped';
  const r = await attemptCharge(c.id);
  return r === 'paid' ? 'active' : r === 'declined' ? 'declined' : 'pending';
}

export type MembershipStart = { completed: boolean; status: string; url?: string; session_id?: string; surface?: Surface };

export async function startMembership(user: { id: string; email: string }, plan: 'monthly' | 'annual', origin: Origin, next: string | null = null, surface: Surface = 'redirect'): Promise<MembershipStart> {
  const live = await one(`select 1 from subscriptions where user_id = $1 and status in ('active','past_due') and current_period_end > now() limit 1`, [user.id]);
  if (live) throw conflict('You already have an active membership');
  const p = await getProvider();
  const mem = await getSetting('membership');
  const price = plan === 'annual' ? mem.annual_cents : mem.monthly_cents;
  if (!price || price <= 0) throw new HttpError(400, 'That membership plan is not on offer right now');
  await exec(`delete from subscriptions where user_id = $1 and status = 'pending'`, [user.id]);
  const sub = await one<{ id: string }>(
    `insert into subscriptions (user_id, plan, status, provider, price_cents, current_period_start, current_period_end, origin_ip, origin_user_agent)
     values ($1,$2,'pending',$3,$4, now(), now(), $5, $6) returning id`,
    [user.id, plan, p.name, price, origin.ip, origin.userAgent?.slice(0, 512) ?? null],
  );
  const shown = await resolveSurface(surface);
  const s = await p.startSetup({ key: sub!.id, next: next && /^\/(?!\/)[^\\\s]*$/.test(next) ? next : null, userId: user.id, email: user.email, description: `${mem.name} (${plan})`, origin, surface: shown });
  await exec('update subscriptions set setup_ref = $2, provider_ref = $2 where id = $1', [sub!.id, s.ref]);
  if (s.token) {
    const r = await activateMembership(sub!.id, s.token);
    if (r === 'declined') throw new HttpError(402, 'Your card was declined, so the membership was not started.');
    return { completed: r === 'active', status: r };
  }
  return { completed: false, status: 'pending', url: s.url ?? undefined, session_id: s.ref, surface: shown };
}

/** Replace the saved payment method on an existing membership (returns a hosted setup URL, or null for sandbox). */
export async function changePaymentMethod(user: { id: string; email: string }, origin: Origin, surface: Surface = 'redirect'): Promise<{ url: string | null; session_id: string; surface: Surface }> {
  const sub = await one(`select * from subscriptions where user_id = $1 and status in ('active','past_due') order by created_at desc limit 1`, [user.id]);
  if (!sub) throw new HttpError(404, 'You do not have a membership to update');
  if (sub.provider !== 'divinity' && sub.provider !== 'sandbox') throw conflict('This membership came from a code and has no payment method');
  const p = await getProvider(sub.provider);
  const mem = await getSetting('membership');
  const shown = await resolveSurface(surface);
  const s = await p.startSetup({ key: `${sub.id}-${Date.now()}`, userId: user.id, email: user.email, description: `${mem.name} payment method`, origin, surface: shown });
  await exec('update subscriptions set setup_ref = $2, origin_ip = $3, origin_user_agent = $4 where id = $1', [sub.id, s.ref, origin.ip, origin.userAgent?.slice(0, 512) ?? null]);
  if (s.token) await savedMethodArrived(sub.id, s.token);
  return { url: s.url, session_id: s.ref, surface: shown };
}

async function savedMethodArrived(subId: string, token: string): Promise<string> {
  const sub = await one('select * from subscriptions where id = $1', [subId]);
  if (!sub) return 'skipped';
  if (sub.status === 'pending') return activateMembership(subId, token);
  await exec('update subscriptions set payment_method_token = $2 where id = $1', [subId, token]);
  // A new card on a past-due membership is worth trying straight away.
  const due = await one<{ id: string }>(`select id from subscription_charges where subscription_id = $1 and status = 'pending' order by created_at desc limit 1`, [subId]);
  if (due && sub.status === 'past_due') return attemptCharge(due.id);
  return 'updated';
}

/** Membership charge refunded or charged back: take the money out of unsettled pots and end access. */
export async function reverseChargeBooks(chargeId: string, why: { reason: string; dispute?: boolean }): Promise<boolean> {
  const done = await tx(async (db) => {
    const c = await one('select * from subscription_charges where id = $1 for update', [chargeId], db);
    if (!c || c.status !== 'paid') return null;
    await db.query(`update subscription_charges set status = 'refunded', refunded_at = now(), last_error = $2 where id = $1`, [chargeId, why.reason.slice(0, 300)]);
    const open = await db.query('delete from sub_months where charge_id = $1 and settled_at is null returning id', [chargeId]);
    const settled = await one<{ n: number }>('select count(*)::int as n from sub_months where charge_id = $1', [chargeId], db);
    await db.query(`update subscriptions set status = 'canceled', canceled_at = now(), cancel_at_period_end = true, current_period_end = least(current_period_end, now()) where id = $1`, [c.subscription_id]);
    return { c, removed: open.rows.length, settled: settled?.n ?? 0 };
  });
  if (!done) return false;
  if (done.settled > 0) {
    await alertAdmins(
      `Membership ${why.dispute ? 'chargeback' : 'refund'} after settlement`,
      `Membership charge ${chargeId} was ${why.dispute ? 'charged back' : 'refunded'} but ${done.settled} of its months were already settled to creators. Review whether a ledger adjustment is needed.`,
    ).catch(() => {});
  }
  await notify(done.c.user_id, 'membership', why.dispute ? 'A membership payment was disputed' : 'Your membership payment was refunded', 'Your membership has ended.', '/account/membership').catch(() => {});
  return true;
}

export async function refundCharge(chargeId: string, reason = 'Refunded by support'): Promise<{ refunded: boolean }> {
  const c = await one(`select c.*, s.provider from subscription_charges c join subscriptions s on s.id = c.subscription_id where c.id = $1`, [chargeId]);
  if (!c) throw new HttpError(404, 'Membership charge not found');
  if (c.status !== 'paid') return { refunded: false };
  if (c.provider === 'divinity') {
    if (!c.payment_ref) throw conflict('This charge has no processor payment reference');
    const r = await (await getProvider('divinity')).refund({ paymentRef: c.payment_ref, id: chargeId, amountCents: c.amount_cents, reason });
    if (!r.ok) throw new HttpError(502, `The payment processor did not accept the refund: ${r.error ?? 'unknown error'}. Nothing was changed.`);
  }
  return { refunded: await reverseChargeBooks(chargeId, { reason }) };
}

// ------------------------------------------------------------------ hosted checkout: return + webhooks

export type Confirmation = {
  kind: 'order' | 'membership' | 'unknown';
  status: 'paid' | 'active' | 'updated' | 'pending' | 'declined' | 'failed' | 'expired' | 'canceled';
  order_id?: string;
  /** Why it did not go through, for the buyer. Only with declined / failed / expired / canceled. */
  message?: string;
};

/**
 * Where a membership stands for a SETUP session whose card has already been
 * taken in, read from our own rows. Asking again must never charge again, so
 * every repeat of a confirmation ends here instead of in `savedMethodArrived`.
 */
async function setupOutcome(subId: string, sessionId: string): Promise<Confirmation> {
  const s = await one<{ status: string; provider_ref: string | null }>('select status, provider_ref from subscriptions where id = $1', [subId]);
  if (!s) return { kind: 'membership', status: 'failed', message: FAILURE_TEXT.failed };
  // The session that started this membership, as opposed to a later change of card.
  const started = s.provider_ref === sessionId;
  if (s.status === 'active') return { kind: 'membership', status: started ? 'active' : 'updated' };
  if (s.status === 'pending') return { kind: 'membership', status: 'pending' };
  const c = await one<{ status: string; uncertain: boolean; last_error: string | null }>(
    'select status, uncertain, last_error from subscription_charges where subscription_id = $1 order by created_at desc limit 1',
    [subId],
  );
  const declined: Confirmation = { kind: 'membership', status: 'declined', message: declineMessage({ error: c?.last_error }) ?? 'The card was declined. Try another card or contact your bank.' };
  if (s.status === 'past_due') return c?.uncertain ? { kind: 'membership', status: 'pending' } : declined;
  // Ended: a first payment that was declined, or a membership that has simply run out since.
  const everPaid = await one(`select 1 from subscription_charges where subscription_id = $1 and status in ('paid','refunded') limit 1`, [subId]);
  return started && !everPaid ? declined : { kind: 'membership', status: 'failed', message: FAILURE_TEXT.failed };
}

/**
 * Settle what we know about a hosted checkout session. Called when the
 * reader's browser asks how a payment went (the embedded checkout as soon as
 * the processor's page says it is done and on a timer as a backstop; the
 * return page after a redirect), from `checkout.*` webhooks (which pass the
 * state they carry) and from the reconciliation job.
 *
 * Safe to call as often as anyone likes: a session still open changes
 * nothing, and one that has ended is applied exactly once.
 */
export async function confirmSession(sessionId: string, opts: { userId?: string; state?: SessionState } = {}): Promise<Confirmation> {
  const order = await one(`select id, user_id, status, provider, meta from orders where provider = 'divinity' and provider_ref = $1`, [sessionId]);
  const sub = order ? null : await one(`select id, user_id, status, provider, payment_method_token from subscriptions where setup_ref = $1`, [sessionId]);
  const owner = order ?? sub;
  if (!owner || (opts.userId && owner.user_id !== opts.userId)) return { kind: 'unknown', status: 'failed' };
  const state = opts.state ?? (await (await getProvider('divinity')).getSession(sessionId));

  if (order) {
    const ended = (): Confirmation => {
      const how = (['failed', 'expired', 'canceled'] as const).find((x) => x === order.meta?.failure_state) ?? 'failed';
      return { kind: 'order', status: how, order_id: order.id, message: typeof order.meta?.failure === 'string' ? order.meta.failure : FAILURE_TEXT[how] };
    };
    if (order.status === 'paid') return { kind: 'order', status: 'paid', order_id: order.id };
    if (!state) return order.status === 'failed' ? ended() : { kind: 'order', status: 'pending', order_id: order.id };
    if (state.status === 'complete') {
      await completeOrder(order.id, { paymentRef: state.paymentRef });
      // The hold appears once the processor has finished its own bookkeeping; the job retries if this is early.
      await captureOrder(order.id).catch(() => false);
      return { kind: 'order', status: 'paid', order_id: order.id };
    }
    if (state.status === 'pending') return order.status === 'failed' ? ended() : { kind: 'order', status: 'pending', order_id: order.id };
    if (order.status === 'failed') return ended();
    const how: FailureState = state.status === 'expired' || state.status === 'canceled' ? state.status : 'failed';
    // A decline reason reaches us on the session itself or, earlier, on a payment.failed webhook.
    const message = how === 'failed' ? (state.message ?? (typeof order.meta?.last_decline === 'string' ? order.meta.last_decline : null) ?? FAILURE_TEXT.failed) : FAILURE_TEXT[how];
    await failOrder(order.id, message, how);
    return { kind: 'order', status: how, order_id: order.id, message };
  }

  if (!state) return { kind: 'membership', status: 'pending' };
  if (state.status === 'complete' && state.paymentMethod) {
    // This card was already taken in (an earlier call, or the webhook): report, do not act again.
    if (sub!.status !== 'pending' && sub!.payment_method_token === state.paymentMethod) return setupOutcome(sub!.id, sessionId);
    const r = await savedMethodArrived(sub!.id, state.paymentMethod);
    if (r === 'active' || r === 'paid') return { kind: 'membership', status: 'active' };
    if (r === 'updated') return { kind: 'membership', status: 'updated' };
    return setupOutcome(sub!.id, sessionId);
  }
  if (state.status === 'pending' || state.status === 'complete') return { kind: 'membership', status: 'pending' };
  const how: FailureState = state.status === 'expired' || state.status === 'canceled' ? state.status : 'failed';
  // A membership that never got its card stays out of sight (and out of the reconciliation job) until the
  // reader starts again or the daily clean-up removes it. Kept, so asking again gets the same answer.
  await exec(`update subscriptions set canceled_at = coalesce(canceled_at, now()) where id = $1 and status = 'pending'`, [sub!.id]);
  return { kind: 'membership', status: how, message: (how === 'failed' ? state.message : null) ?? FAILURE_TEXT[how] };
}

const isUuid = (s: unknown): s is string => typeof s === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);

/** Find what a webhook is about: the `pledgeId` we sent (order id or membership charge id), else the processor payment id. */
async function locate(data: Row): Promise<{ order?: Row; charge?: Row }> {
  const pi = data.stripePaymentIntentId ?? data.paymentIntentId ?? data.paymentId;
  if (isUuid(data.pledgeId)) {
    const order = await one('select * from orders where id = $1', [data.pledgeId]);
    if (order) return { order };
    const charge = await one('select * from subscription_charges where id = $1', [data.pledgeId]);
    if (charge) return { charge };
  }
  if (typeof pi === 'string' && pi) {
    const order = await one('select * from orders where payment_ref = $1', [pi]);
    if (order) return { order };
    const charge = await one('select * from subscription_charges where payment_ref = $1', [pi]);
    if (charge) return { charge };
  }
  return {};
}

/**
 * Handle one verified webhook from the processor. Every branch is idempotent
 * (the processor redelivers on any non-2xx) and an event that matches nothing
 * of ours is acknowledged, not rejected.
 */
export async function handleDivinityEvent(evt: { event?: string; data?: Row }): Promise<{ success: true; message: string }> {
  const data = evt.data ?? {};
  const say = (message: string) => ({ success: true as const, message });
  switch (evt.event) {
    case 'test.ping':
      return say('Webhook received');

    case 'checkout.completed':
    case 'checkout.failed':
    case 'checkout.expired':
    case 'checkout.canceled': {
      if (typeof data.sessionId !== 'string') return say('No session id');
      // An abandoned sibling session of something already paid: informational.
      if (evt.event !== 'checkout.completed' && data.pledgeAlreadyPaid === true) return say('Sibling session of a paid order; ignored');
      const state = sessionState({ ...data, status: evt.event.slice('checkout.'.length).replace('completed', 'complete') });
      // SETUP sessions need the saved method; if the event does not carry it, ask the processor.
      const r = await confirmSession(data.sessionId, state && (state.status !== 'complete' || state.mode === 'payment' || state.paymentMethod) ? { state } : {});
      return say(`${r.kind} ${r.status}`);
    }

    case 'payment.succeeded': {
      const { order, charge } = await locate(data);
      const pi = typeof data.paymentIntentId === 'string' ? data.paymentIntentId : null;
      if (order) {
        await completeOrder(order.id, { paymentRef: pi });
        // payment.succeeded is sent after the hold is placed, so the capture can go now.
        await captureOrder(order.id).catch(() => false);
        return say(`Order ${order.id} paid`);
      }
      if (charge) {
        await markChargePaid(charge.id, pi);
        await captureCharge(charge.id).catch(() => false);
        return say(`Membership charge ${charge.id} paid`);
      }
      return say('No matching order');
    }

    case 'payment.failed':
    case 'payment.requires_action': {
      if (data.pledgeAlreadyPaid === true) return say('Abandoned attempt on a paid order; ignored');
      const { order, charge } = await locate(data);
      // On the hosted page the reader can simply try another card; the order only fails with its session.
      // The reason is kept: should the session end without a payment, it is what the buyer is told.
      if (order) {
        const why = evt.event === 'payment.failed' ? declineMessage(data) : null;
        if (why) await exec(`update orders set meta = meta || $2::jsonb where id = $1 and status = 'pending'`, [order.id, JSON.stringify({ last_decline: why })]);
        return say('Order left open; the checkout session decides');
      }
      if (charge && charge.status === 'pending') {
        // Second signal for a decline whose synchronous answer we may have lost.
        const pi = typeof data.paymentIntentId === 'string' ? data.paymentIntentId : null;
        if (charge.uncertain || (pi && charge.payment_ref !== pi && charge.last_error === null)) {
          await recordDecline(charge.id, String(data.error ?? (evt.event === 'payment.requires_action' ? 'The bank asked for extra confirmation' : 'The card was declined')), pi);
          return say(`Membership charge ${charge.id} declined`);
        }
      }
      return say('Nothing to do');
    }

    case 'refund.completed': {
      const { order, charge } = await locate(data);
      if (data.partial === true) {
        const reason = String(data.reason ?? 'Partly refunded by the payment processor');
        const amount = Number(data.amount);
        if (order) {
          const ref = typeof data.refundId === 'string' && data.refundId ? data.refundId : null;
          const r = await partialRefundOrder(order.id, { amountCents: amount, ref, reason });
          if (r === 'applied') return say(`Order ${order.id} partly refunded`);
          if (r === 'duplicate') return say('Partial refund already applied');
          // The refunds now cover the whole card charge: handle it as the full refund it has become.
          if (r === 'full') return say((await reverseOrderBooks(order.id, { reason })) ? `Order ${order.id} refunded` : 'Order already settled');
          return say('Partial refund ignored: no paid order or no amount');
        }
        if (charge) {
          // A membership period is not divisible in the monthly pots; a person decides what to adjust.
          await alertAdmins('Membership charge partly refunded', `Membership charge ${charge.id} was partly refunded at the processor (${Number.isFinite(amount) ? await money(amount) : 'amount not given'}). The membership and its creator pots were left as they are; adjust by hand if needed.`).catch(() => {});
          return say('Partial membership refund noted; nothing reversed');
        }
        return say('No matching order');
      }
      if (order) return say((await reverseOrderBooks(order.id, { reason: String(data.reason ?? 'Refunded by the payment processor') })) ? `Order ${order.id} refunded` : 'Order already settled');
      if (charge) return say((await reverseChargeBooks(charge.id, { reason: String(data.reason ?? 'Refunded by the payment processor') })) ? `Membership charge ${charge.id} refunded` : 'Charge already settled');
      return say('No matching order');
    }

    case 'dispute.created':
    case 'chargeback.created': {
      const { order, charge } = await locate(data);
      const reason = String(data.reason ?? 'disputed');
      const dispute = { id: data.disputeId ?? null, reason, status: data.status ?? null, evidence_due_by: data.evidenceDueBy ?? null };
      let changed = false;
      if (order) changed = await reverseOrderBooks(order.id, { reason, dispute });
      else if (charge) changed = await reverseChargeBooks(charge.id, { reason, dispute: true });
      else return say('No matching order');
      if (changed) {
        await alertAdmins(
          'Payment disputed',
          `${order ? `Order ${order.id}` : `Membership charge ${charge!.id}`} was disputed (${reason}). Access and creator earnings from it have been reversed.${dispute.evidence_due_by ? ` Evidence is due by ${dispute.evidence_due_by}.` : ''}`,
        ).catch(() => {});
      }
      return say(changed ? 'Dispute applied' : 'Dispute already applied');
    }

    default:
      return say(`Event ${evt.event ?? 'unknown'} ignored`);
  }
}
