import { one, pool } from '../db.ts';
import type { Queryable } from '../db.ts';
import { badRequest } from './http.ts';
import { allocate } from './ledger.ts';
import { getSetting } from './settings.ts';

/**
 * Sales tax at checkout. One calculation (`computeTax`) is used by the basket
 * quote, the checkout, membership start and every membership renewal, so the
 * number a buyer is shown is the number that is charged and stored.
 *
 * The rules:
 *
 *   - Tax is charged on top of the price, by the buyer's US state, at the
 *     rate the owner entered for that state in Admin → Settings → Sales tax
 *     (basis points; 700 = 7%). Every state starts at 0. Buyers outside the
 *     United States pay no tax.
 *   - Taxed: releases, downloads, whole series, bundles, page-credit packs
 *     and memberships. Not taxed: tips and gift card purchases.
 *   - No tax is charged on store credit. Tax is charged only on the part
 *     of the taxed lines the buyer pays by card. Store credit (the wallet
 *     balance, which is also where redeemed gift cards land) goes to the
 *     taxed lines first and to tips and gift cards after that:
 *
 *         credit  = min(wallet, pre-tax total)        when credit is used
 *         taxable = max(0, taxed lines after sales and codes - credit)
 *         tax     = taxable x rate, rounded half up to the cent
 *         card    = pre-tax total - credit + tax
 *
 *     Credit never pays tax, and an order fully covered by credit owes
 *     none and has no card charge.
 *   - Tax is worked out once per order and rounded half up to the cent. It
 *     is then shared out over what is left taxable of each taxed line (the
 *     credit comes off the taxed lines in proportion to their prices) by
 *     largest remainder, ties to the earlier line, so the line amounts
 *     always sum to the order's tax.
 *   - The platform keeps the tax to remit. It is stored beside the pre-tax
 *     totals and is never part of a creator's share, a fee, a ledger row or a
 *     revenue figure.
 */

export const US_STATES: readonly { code: string; name: string }[] = [
  { code: 'AL', name: 'Alabama' }, { code: 'AK', name: 'Alaska' }, { code: 'AZ', name: 'Arizona' }, { code: 'AR', name: 'Arkansas' },
  { code: 'CA', name: 'California' }, { code: 'CO', name: 'Colorado' }, { code: 'CT', name: 'Connecticut' }, { code: 'DE', name: 'Delaware' },
  { code: 'DC', name: 'District of Columbia' }, { code: 'FL', name: 'Florida' }, { code: 'GA', name: 'Georgia' }, { code: 'HI', name: 'Hawaii' },
  { code: 'ID', name: 'Idaho' }, { code: 'IL', name: 'Illinois' }, { code: 'IN', name: 'Indiana' }, { code: 'IA', name: 'Iowa' },
  { code: 'KS', name: 'Kansas' }, { code: 'KY', name: 'Kentucky' }, { code: 'LA', name: 'Louisiana' }, { code: 'ME', name: 'Maine' },
  { code: 'MD', name: 'Maryland' }, { code: 'MA', name: 'Massachusetts' }, { code: 'MI', name: 'Michigan' }, { code: 'MN', name: 'Minnesota' },
  { code: 'MS', name: 'Mississippi' }, { code: 'MO', name: 'Missouri' }, { code: 'MT', name: 'Montana' }, { code: 'NE', name: 'Nebraska' },
  { code: 'NV', name: 'Nevada' }, { code: 'NH', name: 'New Hampshire' }, { code: 'NJ', name: 'New Jersey' }, { code: 'NM', name: 'New Mexico' },
  { code: 'NY', name: 'New York' }, { code: 'NC', name: 'North Carolina' }, { code: 'ND', name: 'North Dakota' }, { code: 'OH', name: 'Ohio' },
  { code: 'OK', name: 'Oklahoma' }, { code: 'OR', name: 'Oregon' }, { code: 'PA', name: 'Pennsylvania' }, { code: 'RI', name: 'Rhode Island' },
  { code: 'SC', name: 'South Carolina' }, { code: 'SD', name: 'South Dakota' }, { code: 'TN', name: 'Tennessee' }, { code: 'TX', name: 'Texas' },
  { code: 'UT', name: 'Utah' }, { code: 'VT', name: 'Vermont' }, { code: 'VA', name: 'Virginia' }, { code: 'WA', name: 'Washington' },
  { code: 'WV', name: 'West Virginia' }, { code: 'WI', name: 'Wisconsin' }, { code: 'WY', name: 'Wyoming' },
];
const STATE_NAMES = new Map(US_STATES.map((s) => [s.code, s.name]));
export const isUsState = (code: unknown): code is string => typeof code === 'string' && STATE_NAMES.has(code);
export const stateName = (code: string | null | undefined): string => (code && STATE_NAMES.get(code)) || code || '';

/** The highest rate the owner can enter for a state: 20%. */
export const MAX_RATE_BPS = 2000;

/** Order line kinds that carry sales tax, plus 'membership' for membership charges. */
const TAXABLE_KINDS = new Set(['release', 'download', 'series', 'bundle', 'credits', 'membership']);
export const isTaxable = (kind: string): boolean => TAXABLE_KINDS.has(kind);

export type TaxLocation = { country: string; state: string | null; zip: string | null };

/**
 * First digit(s) a ZIP code can start with in each state. A cheap sanity
 * check only: it catches a ZIP typed for the wrong part of the country, not a
 * ZIP from a neighboring state. Three states have ZIP codes outside their
 * usual first digit and allow both: New York (005xx, 063xx), Texas (885xx)
 * and the District of Columbia (569xx).
 */
const ZIP_FIRST_DIGITS: Record<string, string> = {
  CT: '0', MA: '0', ME: '0', NH: '0', NJ: '0', RI: '0', VT: '0',
  DE: '1', NY: '01', PA: '1',
  DC: '25', MD: '2', NC: '2', SC: '2', VA: '2', WV: '2',
  AL: '3', FL: '3', GA: '3', MS: '3', TN: '3',
  IN: '4', KY: '4', MI: '4', OH: '4',
  IA: '5', MN: '5', MT: '5', ND: '5', SD: '5', WI: '5',
  IL: '6', KS: '6', MO: '6', NE: '6',
  AR: '7', LA: '7', OK: '7', TX: '78',
  AZ: '8', CO: '8', ID: '8', NM: '8', NV: '8', UT: '8', WY: '8',
  AK: '9', CA: '9', HI: '9', OR: '9', WA: '9',
};
export const zipFitsState = (zip: string, state: string): boolean => (ZIP_FIRST_DIGITS[state] ?? '').includes(zip[0]);

const regionNames = new Intl.DisplayNames(['en'], { type: 'region' });
/** A real two-letter country code (ISO 3166-1 alpha-2), as the runtime knows them. */
function isCountry(code: string): boolean {
  if (!/^[A-Z]{2}$/.test(code)) return false;
  try {
    const name = regionNames.of(code);
    return Boolean(name) && name !== code && !/^Unknown/i.test(name!);
  } catch {
    return false;
  }
}

/**
 * Validate a billing location sent by a browser. Country is a two-letter
 * code; inside the United States a state from the list and a ZIP code (5
 * digits or ZIP+4) are required; elsewhere state and ZIP are dropped.
 * Returns null when nothing was sent.
 */
export function parseLocation(input: unknown): TaxLocation | null {
  if (input === undefined || input === null) return null;
  if (typeof input !== 'object') throw badRequest('Choose your country', 'location_invalid');
  const raw = input as Record<string, unknown>;
  const country = String(raw.country ?? '').trim().toUpperCase();
  if (!isCountry(country)) throw badRequest('Choose your country', 'location_invalid');
  if (country !== 'US') return { country, state: null, zip: null };
  const state = String(raw.state ?? '').trim().toUpperCase();
  if (!isUsState(state)) throw badRequest('Choose your state', 'location_invalid');
  const zip = String(raw.zip ?? '').trim();
  if (!/^\d{5}(-\d{4})?$/.test(zip)) throw badRequest('Enter a 5-digit ZIP code', 'location_invalid');
  if (!zipFitsState(zip, state)) throw badRequest(`That ZIP code is not in ${stateName(state)}. Check the state and ZIP code.`, 'location_invalid');
  return { country, state, zip };
}

export type TaxSettings = { enabled: boolean; rates: Record<string, number> };

/** The owner's rate for a state in basis points; 0 for anything unset or out of range. */
export function rateFor(cfg: TaxSettings, state: string | null): number {
  const bps = state ? Number(cfg.rates?.[state] ?? 0) : 0;
  return Number.isInteger(bps) && bps > 0 ? Math.min(bps, MAX_RATE_BPS) : 0;
}

/** cents × bps / 10000, rounded half up to the cent, without floating point. */
export function taxOn(taxableCents: number, bps: number): number {
  if (taxableCents <= 0 || bps <= 0) return 0;
  return Number((BigInt(taxableCents) * BigInt(bps) + 5000n) / 10000n);
}

export type Tax = {
  /** The sales tax feature is on. When false every other field is empty and nothing is stored. */
  enabled: boolean;
  /** Tax could not be worked out because there are taxed lines and no billing location yet. */
  needs_location: boolean;
  country: string | null;
  state: string | null;
  zip: string | null;
  rate_bps: number;
  taxable_cents: number;
  tax_cents: number;
  /** Each line's share of `tax_cents`, in the order the lines were given. */
  lines: number[];
};

/**
 * THE sales tax calculation. `lines` are final prices (after sales and
 * discount codes). `creditCents` is the store credit going toward the order:
 * it comes off the taxed lines first, and only what is left of them is
 * taxed. `taxable_cents` in the answer is that remainder.
 */
export function computeTax(lines: { kind: string; price_cents: number }[], location: TaxLocation | null, cfg: TaxSettings, creditCents = 0): Tax {
  const none = lines.map(() => 0);
  if (!cfg.enabled) return { enabled: false, needs_location: false, country: null, state: null, zip: null, rate_bps: 0, taxable_cents: 0, tax_cents: 0, lines: none };
  const prices = lines.map((l) => (isTaxable(l.kind) && l.price_cents > 0 ? l.price_cents : 0));
  const full = prices.reduce((a, b) => a + b, 0);
  // Store credit covers taxed lines before untaxed ones, spread over them in proportion to their prices.
  const covered = allocate(Math.min(full, Math.max(0, Math.floor(creditCents))), prices);
  const weights = prices.map((p, i) => p - covered[i]);
  const taxable = weights.reduce((a, b) => a + b, 0);
  if (!location) return { enabled: true, needs_location: taxable > 0, country: null, state: null, zip: null, rate_bps: 0, taxable_cents: taxable, tax_cents: 0, lines: none };
  const state = location.country === 'US' ? location.state : null;
  const rate = rateFor(cfg, state);
  const tax = taxOn(taxable, rate);
  return {
    enabled: true, needs_location: false, country: location.country, state, zip: state ? location.zip : null,
    rate_bps: rate, taxable_cents: taxable, tax_cents: tax, lines: tax > 0 ? allocate(tax, weights) : none,
  };
}

export async function taxSettings(): Promise<TaxSettings> {
  const s = await getSetting('tax');
  return { enabled: s.enabled === true, rates: s.rates ?? {} };
}

export async function quoteTax(lines: { kind: string; price_cents: number }[], location: TaxLocation | null): Promise<Tax> {
  return computeTax(lines, location, await taxSettings());
}

/** "7%", "7.25%", "6.625%". */
export function ratePercent(bps: number): string {
  return `${(bps / 100).toFixed(2).replace(/\.?0+$/, '')}%`;
}

/** The line as buyers see it everywhere: "Sales tax (Indiana 7%)". */
export function taxLabel(state: string | null | undefined, bps: number): string {
  return state ? `Sales tax (${stateName(state)} ${ratePercent(bps)})` : 'Sales tax';
}

/** What the API tells a browser about the tax on a quote, an order or a membership charge. */
export function taxView(t: Tax) {
  return {
    needs_location: t.needs_location,
    location: t.country ? { country: t.country, state: t.state, zip: t.zip } : null,
    state_name: t.state ? stateName(t.state) : null,
    rate_bps: t.rate_bps,
    taxable_cents: t.taxable_cents,
    tax_cents: t.tax_cents,
    label: t.tax_cents > 0 ? taxLabel(t.state, t.rate_bps) : null,
  };
}

// ------------------------------------------------------------------ the buyer's saved location

export async function savedLocation(userId: string, db: Queryable = pool): Promise<TaxLocation | null> {
  const u = await one<{ billing_country: string | null; billing_state: string | null; billing_zip: string | null }>(
    'select billing_country, billing_state, billing_zip from users where id = $1',
    [userId],
    db,
  );
  if (!u?.billing_country) return null;
  if (u.billing_country !== 'US') return { country: u.billing_country, state: null, zip: null };
  // A US location is only usable with its state.
  return isUsState(u.billing_state) ? { country: 'US', state: u.billing_state, zip: u.billing_zip } : null;
}

export async function saveLocation(userId: string, loc: TaxLocation, db: Queryable = pool): Promise<void> {
  await db.query('update users set billing_country = $2, billing_state = $3, billing_zip = $4 where id = $1', [userId, loc.country, loc.state, loc.zip]);
}

/**
 * Tax on one membership charge of `amountCents`, at the member's saved
 * billing location as it is right now. A member with no saved location
 * (joined before sales tax was switched on) is not taxed until they give one.
 */
export async function membershipTax(userId: string, amountCents: number, db: Queryable = pool): Promise<Tax> {
  const cfg = await taxSettings();
  if (!cfg.enabled) return computeTax([], null, cfg);
  const t = computeTax([{ kind: 'membership', price_cents: amountCents }], await savedLocation(userId, db), cfg);
  return { ...t, needs_location: false };
}

// ------------------------------------------------------------------ refunds

/**
 * How much of an order's tax has gone back once `refundedCents` of its card
 * charge (pre-tax total - store credit + tax) has been refunded: the same
 * proportion of the tax as of the card charge, rounded half up, never more
 * than was collected. Pass the running total refunded so far and take the
 * difference from the previous answer, so several partial refunds can never
 * drift by a cent.
 */
export function taxRefunded(order: { total_cents: number; tax_cents: number; credit_cents?: number }, refundedCents: number): number {
  const tax = Math.max(0, order.tax_cents);
  const paid = Math.max(0, order.total_cents - (order.credit_cents ?? 0)) + tax;
  if (tax === 0 || paid === 0 || refundedCents <= 0) return 0;
  const r = BigInt(Math.min(refundedCents, paid));
  return Math.min(tax, Number((r * BigInt(tax) * 2n + BigInt(paid)) / (2n * BigInt(paid))));
}

/** Record tax that went back to a buyer (see migration 087). Nothing is written for 0. */
export async function recordTaxRefund(db: Queryable, a: { orderId?: string; chargeId?: string; state: string | null; taxCents: number }): Promise<void> {
  if (a.taxCents <= 0) return;
  await db.query('insert into sales_tax_refunds (order_id, charge_id, state, tax_cents) values ($1,$2,$3,$4)', [a.orderId ?? null, a.chargeId ?? null, a.state ?? '', a.taxCents]);
}
