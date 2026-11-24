import { q, pool } from '../db.ts';
import type { Queryable, Row } from '../db.ts';

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

/**
 * "Buy the whole series": every currently published release that is sold,
 * not already free to read for good, and not already owned by this reader.
 * The same function prices the offer on the page and the order at checkout.
 */
export async function seriesPurchase(series: Row, userId: string | null, discounts: Discount[], db: Queryable = pool) {
  if (series.access_model !== 'premium') return { base_cents: 0, price_cents: 0, releases: [] as { id: string; price_cents: number }[] };
  const rows = await q(
    `select r.* from releases r
      where r.series_id = $1 and r.status = 'published' and r.deleted_at is null and not r.force_free
        and (r.free_at is null or r.free_at > now())
        and ($3::int is null or r.published_at is null or r.published_at + ($3::int || ' days')::interval > now())
        and not exists (select 1 from entitlements e where e.user_id = $2 and e.release_id = r.id)
      order by r.language, r.number`,
    [series.id, userId, series.paywall_expires_days ?? null],
    db,
  );
  return seriesPrice(series, rows, discounts);
}
