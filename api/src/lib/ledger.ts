import { one, q, pool } from '../db.ts';
import type { Queryable } from '../db.ts';
import { getSetting } from './settings.ts';

/**
 * Creator earnings. Everything is integer cents and every function here
 * conserves money exactly:
 *
 *   price = processing fee share + creator rows (owner + split payees) + platform
 *
 * Rounding always goes one way: a creator share is floored, and what is left
 * stays with the platform (sales) or with the series owner (revenue splits).
 */

export type Share = { publisher_id: string; cents: number };
export type Breakdown = { price_cents: number; fee_cents: number; creator_cents: number; platform_cents: number; shares: Share[] };

/**
 * Split `total` across `weights` so the parts sum to exactly `total`
 * (largest-remainder method). Leftover cents go to the largest fractional
 * remainders; ties go to the smaller `keys[i]` (or the lower index).
 */
export function allocate(total: number, weights: number[], keys?: string[]): number[] {
  if (!Number.isInteger(total) || total < 0) throw new Error('allocate: total must be a non-negative integer');
  const W = weights.reduce((a, b) => a + BigInt(b), 0n);
  if (weights.some((w) => !Number.isInteger(w) || w < 0)) throw new Error('allocate: weights must be non-negative integers');
  if (W === 0n) return weights.map(() => 0);
  const T = BigInt(total);
  const parts = weights.map((w) => (T * BigInt(w)) / W);
  const rems = weights.map((w, i) => ({ i, r: (T * BigInt(w)) % W }));
  let left = Number(T - parts.reduce((a, b) => a + b, 0n));
  rems.sort((a, b) => (a.r === b.r ? (keys ? (keys[a.i] < keys[b.i] ? -1 : keys[a.i] > keys[b.i] ? 1 : a.i - b.i) : a.i - b.i) : a.r > b.r ? -1 : 1));
  const out = parts.map(Number);
  for (const { i, r } of rems) {
    if (left <= 0 || r === 0n) break;
    out[i] += 1;
    left -= 1;
  }
  return out;
}

/** floor(cents * bps / 10000) without floating point. */
export function bpsOf(cents: number, bps: number): number {
  return Number((BigInt(cents) * BigInt(bps)) / 10000n);
}

/** Card processing cost estimate from settings, never more than the charge. */
export function estimateFee(chargeCents: number, rev: { fee_pct_bps: number; fee_fixed_cents: number }): number {
  if (chargeCents <= 0) return 0;
  const fee = Math.round((chargeCents * rev.fee_pct_bps) / 10000) + rev.fee_fixed_cents;
  return Math.min(chargeCents, Math.max(0, fee));
}

/**
 * Divide a creator amount between the series owner and its revenue-split
 * payees. Each payee gets floor(amount * bps); the owner keeps the rest, so
 * the shares always sum to `creatorCents`. Splits are applied in payee-id
 * order and can never exceed what is left.
 */
export function splitShares(creatorCents: number, ownerId: string, splits: { payee_publisher_id: string; share_bps: number }[]): Share[] {
  const by = new Map<string, number>();
  let remaining = creatorCents;
  for (const s of [...splits].sort((a, b) => (a.payee_publisher_id < b.payee_publisher_id ? -1 : 1))) {
    if (s.payee_publisher_id === ownerId) continue;
    const cents = Math.min(remaining, bpsOf(creatorCents, s.share_bps));
    remaining -= cents;
    by.set(s.payee_publisher_id, (by.get(s.payee_publisher_id) ?? 0) + cents);
  }
  return [{ publisher_id: ownerId, cents: remaining }, ...[...by].map(([publisher_id, cents]) => ({ publisher_id, cents }))];
}

/** price -> fee, creator (with splits) and platform; exact by construction. */
export function breakdown(
  priceCents: number,
  feeCents: number,
  shareBps: number,
  ownerId: string,
  splits: { payee_publisher_id: string; share_bps: number }[] = [],
): Breakdown {
  const fee = Math.min(priceCents, Math.max(0, feeCents));
  const net = priceCents - fee;
  const creator = bpsOf(net, shareBps);
  return { price_cents: priceCents, fee_cents: fee, creator_cents: creator, platform_cents: net - creator, shares: splitShares(creator, ownerId, splits) };
}

type Money = 'sale' | 'sub' | 'tip';

/** Publisher override, else the platform default. */
export async function shareBps(publisherId: string, kind: Money, db: Queryable = pool): Promise<number> {
  const rev = await getSetting('revenue');
  const p = await one<{ bps: number | null }>(`select ${kind}_share_bps as bps from publishers where id = $1`, [publisherId], db);
  return p?.bps ?? rev[`${kind}_share_bps`];
}

export async function seriesSplits(seriesId: string | null, db: Queryable = pool) {
  if (!seriesId) return [];
  return q<{ payee_publisher_id: string; share_bps: number }>(
    'select payee_publisher_id, share_bps from revenue_splits where series_id = $1 order by payee_publisher_id',
    [seriesId],
    db,
  );
}

async function availableAt(): Promise<Date> {
  const rev = await getSetting('revenue');
  return new Date(Date.now() + rev.payout_hold_days * 86_400_000);
}

type Entry = {
  kind: 'sale' | 'tip' | 'subscription';
  ownerId: string;
  seriesId?: string | null;
  releaseId?: string | null;
  orderId?: string | null;
  month?: string | null;
  note: string;
};

async function writeShares(db: Queryable, e: Entry, b: Breakdown): Promise<void> {
  const at = await availableAt();
  for (const s of b.shares) {
    const owner = s.publisher_id === e.ownerId;
    if (!owner && s.cents === 0) continue;
    await db.query(
      `insert into ledger (publisher_id, kind, amount_cents, gross_cents, series_id, release_id, order_id, month, note, available_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       on conflict (publisher_id, month, series_id) where kind = 'subscription' do nothing`,
      // gross is recorded once, on the owner's row, so summing it never double counts
      [s.publisher_id, e.kind, s.cents, owner ? b.price_cents : 0, e.seriesId ?? null, e.releaseId ?? null, e.orderId ?? null, e.month ?? null,
       owner ? e.note : `Revenue split: ${e.note}`, at],
    );
  }
}

/** A paid order line for a series (read unlock, download, series, bundle part). */
export async function creditSale(
  db: Queryable,
  a: { publisherId: string; seriesId: string | null; releaseId?: string | null; orderId: string | null; priceCents: number; feeCents: number; note: string },
): Promise<Breakdown> {
  const b = breakdown(a.priceCents, a.feeCents, await shareBps(a.publisherId, 'sale', db), a.publisherId, await seriesSplits(a.seriesId, db));
  await writeShares(db, { kind: 'sale', ownerId: a.publisherId, seriesId: a.seriesId, releaseId: a.releaseId, orderId: a.orderId, note: a.note }, b);
  return b;
}

/** A tip goes to the brand itself; series splits do not apply. */
export async function creditTip(db: Queryable, a: { publisherId: string; orderId: string; priceCents: number; feeCents: number; note: string }): Promise<Breakdown> {
  const b = breakdown(a.priceCents, a.feeCents, await shareBps(a.publisherId, 'tip', db), a.publisherId);
  await writeShares(db, { kind: 'tip', ownerId: a.publisherId, orderId: a.orderId, note: a.note }, b);
  return b;
}

/** One series' part of a settled membership month. `netCents` is already net of fees. */
export async function creditSubscription(
  db: Queryable,
  a: { publisherId: string; seriesId: string; month: string; netCents: number; note: string },
): Promise<Breakdown> {
  const b = breakdown(a.netCents, 0, await shareBps(a.publisherId, 'sub', db), a.publisherId, await seriesSplits(a.seriesId, db));
  await writeShares(db, { kind: 'subscription', ownerId: a.publisherId, seriesId: a.seriesId, month: a.month, note: a.note }, b);
  return b;
}

type LedgerKey = { publisher_id: string; series_id: string | null; release_id: string | null };
const keyOf = (r: LedgerKey) => `${r.publisher_id}|${r.series_id ?? ''}|${r.release_id ?? ''}`;

/** An order's earning rows and what has been reversed so far, summed per (payee, series, release). */
async function orderLedger(db: Queryable, orderId: string) {
  const rows = await q<LedgerKey & { reversed: boolean; amount: number; gross: number }>(
    `select publisher_id, series_id, release_id, (kind = 'refund') as reversed, sum(amount_cents)::int as amount, sum(gross_cents)::int as gross
       from ledger where order_id = $1 and kind in ('sale','tip','refund') group by 1,2,3,4`,
    [orderId],
    db,
  );
  const by = new Map<string, LedgerKey & { amount: number; gross: number; back: number; grossBack: number }>();
  for (const r of rows) {
    const k = keyOf(r);
    const e = by.get(k) ?? { publisher_id: r.publisher_id, series_id: r.series_id, release_id: r.release_id, amount: 0, gross: 0, back: 0, grossBack: 0 };
    if (r.reversed) {
      e.back -= r.amount;
      e.grossBack -= r.gross;
    } else {
      e.amount += r.amount;
      e.gross += r.gross;
    }
    by.set(k, e);
  }
  return [...by.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([key, e]) => ({ key, ...e }));
}

/**
 * Take back everything an order paid out: one negative `refund` row per
 * original row. Idempotent: rows already reversed are skipped. After partial
 * refunds only what is still standing is reversed, so the order always nets
 * to exactly zero.
 */
export async function reverseOrder(db: Queryable, orderId: string, note: string): Promise<number> {
  const done = await one('select 1 from ledger where order_id = $1 and kind = $2 limit 1', [orderId, 'refund'], db);
  if (done) {
    let total = 0;
    for (const e of await orderLedger(db, orderId)) {
      const amount = e.amount - e.back;
      const gross = e.gross - e.grossBack;
      if (!amount && !gross) continue;
      await db.query(
        `insert into ledger (publisher_id, kind, amount_cents, gross_cents, series_id, release_id, order_id, note) values ($1,'refund',$2,$3,$4,$5,$6,$7)`,
        [e.publisher_id, -amount, -gross, e.series_id, e.release_id, orderId, note],
      );
      total += amount;
    }
    return total;
  }
  const rows = await q('select publisher_id, amount_cents, gross_cents, series_id, release_id from ledger where order_id = $1 and kind in ($2,$3)', [orderId, 'sale', 'tip'], db);
  let total = 0;
  for (const r of rows) {
    await db.query(
      `insert into ledger (publisher_id, kind, amount_cents, gross_cents, series_id, release_id, order_id, note)
       values ($1,'refund',$2,$3,$4,$5,$6,$7)`,
      [r.publisher_id, -r.amount_cents, -r.gross_cents, r.series_id, r.release_id, orderId, note],
    );
    total += r.amount_cents;
  }
  return total;
}

export type RefundParts = { creator_cents: number; platform_cents: number; fee_cents: number };

/**
 * How `refundCents` of an order is shared between what the creators earned,
 * what the platform kept and the processing fee: in proportion to how the
 * order's total was shared in the first place, and summing to exactly
 * `refundCents` (largest remainder; ties go creator, platform, fee).
 * Pass the running total refunded so far to get running totals back.
 */
export function refundParts(order: { total_cents: number; fee_cents: number; creator_cents: number }, refundCents: number): RefundParts {
  const fee = Math.min(order.total_cents, Math.max(0, order.fee_cents));
  const creator = Math.min(order.total_cents - fee, Math.max(0, order.creator_cents));
  const platform = order.total_cents - fee - creator;
  const refund = Math.min(Math.max(0, refundCents), order.total_cents);
  const [c, p, f] = allocate(refund, [creator, platform, fee], ['a', 'b', 'c']);
  return { creator_cents: c, platform_cents: p, fee_cents: f };
}

/**
 * Bring the creator side of an order to "`creatorBackCents` of earnings and
 * `grossBackCents` of gross reversed in total", spread over its ledger rows in
 * proportion to what each earned. Writes only the difference from what earlier
 * refunds already reversed, so calling it with running totals is exact however
 * many partial refunds there are. Returns the creator cents reversed by this call.
 */
export async function reverseOrderPartly(db: Queryable, orderId: string, creatorBackCents: number, grossBackCents: number, note: string): Promise<number> {
  const rows = await orderLedger(db, orderId);
  if (!rows.length) return 0;
  const earned = rows.reduce((n, r) => n + r.amount, 0);
  const gross = rows.reduce((n, r) => n + r.gross, 0);
  const amounts = allocate(Math.min(creatorBackCents, earned), rows.map((r) => Math.max(0, r.amount)), rows.map((r) => r.key));
  const grosses = allocate(Math.min(grossBackCents, gross), rows.map((r) => Math.max(0, r.gross)), rows.map((r) => r.key));
  let total = 0;
  for (const [i, r] of rows.entries()) {
    const amount = amounts[i] - r.back;
    const g = grosses[i] - r.grossBack;
    if (!amount && !g) continue;
    await db.query(
      `insert into ledger (publisher_id, kind, amount_cents, gross_cents, series_id, release_id, order_id, note) values ($1,'refund',$2,$3,$4,$5,$6,$7)`,
      [r.publisher_id, -amount, -g, r.series_id, r.release_id, orderId, note],
    );
    total += amount;
  }
  return total;
}
