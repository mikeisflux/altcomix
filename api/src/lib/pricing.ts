import { one, q, pool } from '../db.ts';
import type { Queryable, Row } from '../db.ts';
import { releaseAccess } from './access.ts';

/**
 * What things cost. Read-online and download are priced separately:
 *
 *   read      release.price_cents, else series.default_price_cents (0/null = not sold)
 *   download  release.download_price_cents (0/null = not sold)
 *
 * Discounts never stack. The reader gets the single best percentage among
 * the publisher's active `discounts` rows that apply (and, for downloads,
 * the release's own download_discount_pct). A checkout promo code is then
 * taken off the already-discounted price of the lines it covers.
 */

export type Discount = { id: string; publisher_id: string; series_id: string | null; percent_off: number; applies_to: 'all' | 'read' | 'download'; label: string; ends_at: string | null };
export type Price = { base_cents: number; price_cents: number; percent_off: number; discount_label: string | null; ends_at: string | null };

/** Price after a percentage off, rounded to the nearest cent (half up). */
export function percentOff(cents: number, pct: number): number {
  if (pct <= 0) return cents;
  if (pct >= 100) return 0;
  return Math.floor((cents * (100 - pct) + 50) / 100);
}

export function bestDiscount(discounts: Discount[], publisherId: string, seriesId: string | null, kind: 'read' | 'download', publisherWideOnly = false): Discount | null {
  let best: Discount | null = null;
  for (const d of discounts) {
    if (d.publisher_id !== publisherId) continue;
    if (d.applies_to !== 'all' && d.applies_to !== kind) continue;
    if (d.series_id && (publisherWideOnly || d.series_id !== seriesId)) continue;
    if (!best || d.percent_off > best.percent_off || (d.percent_off === best.percent_off && d.id < best.id)) best = d;
  }
  return best;
}

function priced(base: number, d: Discount | null, extraPct = 0): Price {
  const pct = Math.max(d?.percent_off ?? 0, extraPct);
  const fromRow = d && d.percent_off >= extraPct;
  return { base_cents: base, price_cents: percentOff(base, pct), percent_off: pct, discount_label: pct ? (fromRow ? d.label : 'Download discount') : null, ends_at: fromRow ? d.ends_at : null };
}

/** Read-online price of a release, or null when it is not sold a la carte. */
export function readPrice(series: Row, release: Row, discounts: Discount[]): Price | null {
  const base = release.price_cents ?? series.default_price_cents ?? 0;
  if (!base || base <= 0) return null;
  return priced(base, bestDiscount(discounts, series.publisher_id, series.id, 'read'));
}

/** Download price of a release, or null when the download is not for sale. */
export function downloadPrice(series: Row, release: Row, discounts: Discount[]): Price | null {
  const base = release.download_price_cents ?? 0;
  if (!base || base <= 0) return null;
  return priced(base, bestDiscount(discounts, series.publisher_id, series.id, 'download'), release.download_discount_pct ?? 0);
}

/** Bundles take publisher-wide discounts only (a bundle can span series). */
export function bundlePrice(bundle: Row, discounts: Discount[]): Price {
  return priced(bundle.price_cents, bestDiscount(discounts, bundle.publisher_id, null, bundle.includes_download ? 'download' : 'read', true));
}

/** Whole series = the sum of the read prices of the given releases. */
export function seriesPrice(series: Row, releases: Row[], discounts: Discount[]): { base_cents: number; price_cents: number; releases: { id: string; price_cents: number }[] } {
  const out = { base_cents: 0, price_cents: 0, releases: [] as { id: string; price_cents: number }[] };
  for (const r of releases) {
    const p = readPrice(series, r, discounts);
    if (!p) continue;
    out.base_cents += p.base_cents;
    out.price_cents += p.price_cents;
    out.releases.push({ id: r.id, price_cents: p.price_cents });
  }
  return out;
}

export async function activeDiscounts(publisherIds: string[], db: Queryable = pool): Promise<Discount[]> {
  if (!publisherIds.length) return [];
  return q<Discount>(
    `select id, publisher_id, series_id, percent_off, applies_to, label, ends_at from discounts
      where publisher_id = any($1) and active and starts_at <= now() and (ends_at is null or ends_at > now())`,
    [publisherIds],
    db,
  );
}

export type CodeScope = { publisher_id: string | null; series_id: string | null; release_id: string | null; percent_off: number };
export type Line = { kind: string; price_cents: number; publisher_id: string | null; series_id: string | null; release_id: string | null; release_ids?: string[] };

/** Does a checkout discount code cover this line? Tips, gift cards and credits are never discounted. */
export function codeCovers(code: CodeScope, line: Line): boolean {
  if (!['release', 'download', 'series', 'bundle'].includes(line.kind)) return false;
  if (code.publisher_id && code.publisher_id !== line.publisher_id) return false;
  if (code.release_id) return line.release_id === code.release_id || Boolean(line.release_ids?.includes(code.release_id) && line.release_ids.length === 1);
  if (code.series_id) return line.series_id === code.series_id;
  return true;
}

/** Apply a discount code; returns the new line prices and the total taken off. */
export function applyCode(code: CodeScope, lines: Line[]): { prices: number[]; discount_cents: number } {
  let off = 0;
  const prices = lines.map((l) => {
    if (!codeCovers(code, l)) return l.price_cents;
    const p = percentOff(l.price_cents, code.percent_off);
    off += l.price_cents - p;
    return p;
  });
  return { prices, discount_cents: off };
}

/** The parts of a release's access decision (lib/access.ts) that pricing depends on. */
export type OfferAccess = { model: string; releaseFree: boolean; unlock: string | null };

/**
 * THE rule for "can this reader buy this release to read, and for how much".
 * Used for the price on the series page, the single-release checkout line
 * and every release inside a whole-series purchase, so they cannot disagree.
 *
 * Not for sale when: the release is not published; it is free to read for
 * this reader's country / language edition (free model, forced free, free
 * date passed, paywall expired, or free under the series preview rule); the
 * reader already owns it (purchase or code) or is on the brand's team; or it
 * has no price. A membership does not remove the price: members can still buy
 * a release to keep it.
 */
export function readOffer(series: Row, release: Row, access: OfferAccess, discounts: Discount[]): Price | null {
  if (release.status !== 'published' || release.deleted_at) return null;
  if (access.model !== 'premium' || access.releaseFree) return null;
  if (access.unlock === 'owner' || access.unlock === 'purchase' || access.unlock === 'code') return null;
  return readPrice(series, release, discounts);
}

type Buyer = { id: string; role?: string } | null;

/**
 * "Buy the whole series": the sum of `readOffer` over every published
 * release, i.e. exactly the releases that show a read price to this reader.
 * The same function prices the offer on the page and the order at checkout.
 * `ctx.access` lets a caller that has already worked out access per release
 * (the series page) hand it over instead of having it worked out again.
 */
export async function seriesPurchase(
  series: Row,
  userId: string | null,
  discounts: Discount[],
  db: Queryable = pool,
  ctx: { country?: string | null; access?: Map<string, OfferAccess> } = {},
) {
  const out = { base_cents: 0, price_cents: 0, releases: [] as { id: string; price_cents: number; base_cents: number }[] };
  const rows = await q(
    `select r.* from releases r where r.series_id = $1 and r.status = 'published' and r.deleted_at is null order by r.language, r.number, r.created_at`,
    [series.id],
    db,
  );
  if (!rows.length) return out;
  let user: Buyer = null;
  if (userId && rows.some((r) => !ctx.access?.has(r.id))) user = await one<{ id: string; role: string }>('select id, role from users where id = $1', [userId], db);
  for (let i = 0; i < rows.length; i += 6) {
    const chunk = rows.slice(i, i + 6);
    const access = await Promise.all(
      chunk.map((r) => ctx.access?.get(r.id) ?? releaseAccess({ series, release: r, pages: [], user: user as never, country: ctx.country ?? null })),
    );
    chunk.forEach((r, n) => {
      const p = readOffer(series, r, access[n], discounts);
      if (!p) return;
      out.base_cents += p.base_cents;
      out.price_cents += p.price_cents;
      out.releases.push({ id: r.id, price_cents: p.price_cents, base_cents: p.base_cents });
    });
  }
  return out;
}
