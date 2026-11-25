import { exec, q } from '../db.ts';
import { captureError } from '../lib/errors.ts';
import { BOOKS, MEMBERSHIP, PREMIUM, attemptCharge, billPeriod, captureCharge, captureOrder, confirmSession, failOrder, premiumPayerLeft, sendPremiumRenewalReminders } from '../lib/payments.ts';
import { invalidatePremium } from '../lib/premium.ts';
import type { Job } from '../server.ts';

/**
 * Billing housekeeping, every few minutes. Steps 1 to 3 run for the reader
 * membership and, on its own tables, for Creator Premium (a brand's yearly
 * plan; complimentary grants are its "no payment method" case):
 *
 *   1. memberships with no payment method behind them (code grants) expire
 *      when their period ends
 *   2. memberships whose period ended: cancelled ones stop; the rest get a
 *      charge row for the next period
 *   3. due charges are attempted (first try, decline retries after 1/3/5
 *      days, unanswered calls looked up and repeated) — for the sandbox
 *      provider the charge always succeeds, so periods roll forward and
 *      `sub_months` rows appear exactly as they do in production
 *   4. paid orders/charges whose processor hold is not captured yet are captured
 *   5. hosted checkouts the reader never came back from are reconciled with
 *      the processor, and abandoned ones are closed
 */
export async function runMembershipCycle(): Promise<Record<string, number>> {
  const n = { expired: 0, ended: 0, billed: 0, paid: 0, declined: 0, captured: 0, reconciled: 0, reminded: 0 };
  const safe = async (what: string, fn: () => Promise<unknown>) => {
    try {
      return await fn();
    } catch (e) {
      captureError(e, { source: 'job', endpoint: `memberships:${what}` });
      return null;
    }
  };

  // The same cycle runs for the reader membership and for Creator Premium (lib/payments.ts BOOKS):
  // same columns, separate tables, so neither can touch the other's rows.
  for (const book of BOOKS) {
    n.expired += await exec(
      `update ${book.subs} set status = 'expired' where status in ('active','past_due') and current_period_end <= now()
          and (provider not in ('sandbox','divinity') or payment_method_token is null)`,
    );

    n.ended += await exec(
      `update ${book.subs} set status = 'canceled', canceled_at = coalesce(canceled_at, now())
        where status = 'active' and cancel_at_period_end and current_period_end <= now()`,
    );

    const due = await q(
      `select s.* from ${book.subs} s
        where s.status = 'active' and not s.cancel_at_period_end and s.current_period_end <= now()
          and s.provider in ('sandbox','divinity') and s.payment_method_token is not null
          and not exists (select 1 from ${book.charges} c where c.subscription_id = s.id and c.period_start = s.current_period_end)
        limit 200`,
    );
    for (const s of due) {
      // A Premium payer who has left the brand's team is not charged; the plan ends with the paid year instead.
      if (book.kind === 'premium' && (await safe('payer', () => premiumPayerLeft(s))) !== false) continue;
      const start = new Date(s.current_period_end);
      // Sales tax for the new period is worked out here, at the payer's saved state as it is now (lib/payments.ts billPeriod).
      if (await safe('bill', () => billPeriod(s, start, book))) n.billed++;
    }

    const charges = await q<{ id: string }>(`select id from ${book.charges} where status = 'pending' and next_attempt_at <= now() order by next_attempt_at limit 200`);
    for (const c of charges) {
      const r = await safe('charge', () => attemptCharge(c.id, book));
      if (r === 'paid') n.paid++;
      if (r === 'declined') n.declined++;
    }
  }
  // Plans can end in the statements above without going through lib/payments.ts.
  invalidatePremium();

  const holds = await q<{ id: string; t: string }>(
    `select id, 'order' as t from orders where provider = 'divinity' and status = 'paid' and captured_at is null and total_cents + tax_cents > credit_cents and paid_at < now() - interval '1 minute'
     union all
     select c.id, 'charge' from subscription_charges c join subscriptions s on s.id = c.subscription_id
      where s.provider = 'divinity' and c.status = 'paid' and c.captured_at is null and c.paid_at < now() - interval '1 minute'
     union all
     select c.id, 'premium' from premium_charges c join premium_subscriptions s on s.id = c.subscription_id
      where s.provider = 'divinity' and c.status = 'paid' and c.captured_at is null and c.paid_at < now() - interval '1 minute'
     limit 100`,
  );
  for (const h of holds) if (await safe('capture', () => (h.t === 'order' ? captureOrder(h.id) : captureCharge(h.id, h.t === 'premium' ? PREMIUM : MEMBERSHIP)))) n.captured++;

  const sessions = await q<{ ref: string }>(
    `select provider_ref as ref from orders where provider = 'divinity' and status = 'pending' and provider_ref is not null and created_at < now() - interval '10 minutes'
     union all
     select setup_ref from subscriptions where provider = 'divinity' and status = 'pending' and setup_ref is not null and canceled_at is null and created_at < now() - interval '10 minutes'
     union all
     select setup_ref from premium_subscriptions where provider = 'divinity' and status = 'pending' and setup_ref is not null and canceled_at is null and created_at < now() - interval '10 minutes'
     limit 100`,
  );
  for (const s of sessions) if (await safe('reconcile', () => confirmSession(s.ref))) n.reconciled++;

  const orphans = await q<{ id: string }>(`select id from orders where status = 'pending' and provider_ref is null and created_at < now() - interval '1 hour' limit 100`);
  for (const o of orphans) await safe('orphan', () => failOrder(o.id, 'Checkout was never started'));
  n.reminded = Number((await safe('remind', () => sendPremiumRenewalReminders())) ?? 0);
  await exec(`delete from subscriptions where status = 'pending' and created_at < now() - interval '1 day'`);
  await exec(`delete from premium_subscriptions where status = 'pending' and created_at < now() - interval '1 day'`);
  return n;
}

const job: Job = {
  name: 'memberships',
  everyMs: 5 * 60_000,
  async run() {
    const n = await runMembershipCycle();
    const did = Object.entries(n).filter(([, v]) => v > 0);
    return did.length ? did.map(([k, v]) => `${k} ${v}`).join(', ') : undefined;
  },
};

export default job;
