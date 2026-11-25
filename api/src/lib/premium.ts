import { one } from '../db.ts';
import { HttpError } from './http.ts';

/**
 * Creator Premium: the gate. A brand has Premium while it has a paid plan or
 * a complimentary grant that is running and whose period has not ended —
 * the same rule as the reader membership (`hasMembership` in lib/access.ts):
 * a plan that is canceled keeps going to the end of the paid year. Unlike the
 * reader membership, a plan whose renewal payment is being retried stays on
 * until the last retry fails (the owner's decision).
 *
 * Every Premium feature asks `brandHasPremium`; nothing else decides.
 * The billing itself is in lib/payments.ts (the PREMIUM book).
 */

/**
 * SQL condition (on a premium_subscriptions row) for "this plan keeps Premium on":
 * its period is running, or it is a paid plan whose yearly renewal is being
 * collected. A renewal that is declined is retried for nine days (`past_due`),
 * and the brand keeps Premium through those retries; it ends only when the
 * last retry fails and the plan becomes `expired`. The two-day allowance covers
 * the short gap between the year ending and the first renewal attempt.
 */
export const PREMIUM_ON = `(
  (status in ('active','past_due') and current_period_end > now())
  or (status = 'past_due' and provider <> 'comp')
  or (status = 'active' and provider <> 'comp' and not cancel_at_period_end and payment_method_token is not null
      and current_period_end > now() - interval '2 days')
)`;

const TTL_MS = 15_000;
const cache = new Map<string, { value: boolean; at: number }>();

export async function brandHasPremium(publisherId: string): Promise<boolean> {
  const hit = cache.get(publisherId);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value;
  const value = Boolean(
    await one(
      `select 1 from premium_subscriptions where publisher_id = $1 and ${PREMIUM_ON} limit 1`,
      [publisherId],
    ),
  );
  if (cache.size > 5000) cache.clear();
  cache.set(publisherId, { value, at: Date.now() });
  return value;
}

/** Forget what is cached for one brand (or for all of them) after its plan changed. */
export function invalidatePremium(publisherId?: string): void {
  if (publisherId) cache.delete(publisherId);
  else cache.clear();
}

export const premiumRequired = (what: string) =>
  new HttpError(402, `${what} is part of Creator Premium. A brand owner or admin can turn it on from the Creator Premium page in Studio.`, 'premium_required');

/** Refuse with 402 `premium_required` unless the brand has Premium. `what` starts the sentence: "The print edition link". */
export async function requirePremium(publisherId: string, what: string): Promise<void> {
  if (!(await brandHasPremium(publisherId))) throw premiumRequired(what);
}

/** A release's "Buy in print" link as readers may see it: the saved link while the brand has Premium, otherwise nothing. */
export async function publicPrintUrl(publisherId: string, printUrl: string | null | undefined): Promise<string | null> {
  if (!printUrl) return null;
  return (await brandHasPremium(publisherId)) ? printUrl : null;
}
