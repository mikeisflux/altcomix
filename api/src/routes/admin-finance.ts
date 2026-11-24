import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { config } from '../config.ts';
import { exec, one, q, tx } from '../db.ts';
import type { Row } from '../db.ts';
import {
  adminScope, brandBalance, brandContacts, dateRange, idParam, isUuid, like, money, monthStart, query, settlementModule, where, zDate,
} from '../lib/admin.ts';
import { randomCode } from '../lib/crypto.ts';
import { sendTemplate } from '../lib/email.ts';
import { HttpError, audit, badRequest, conflict, notFound, pageParams, parse, requireAdmin, requireSuperAdmin } from '../lib/http.ts';
import { reverseOrder } from '../lib/ledger.ts';
import { notify } from '../lib/notify.ts';
import { getSetting } from '../lib/settings.ts';

type PaymentsModule = {
  refundOrder?: (orderId: string, opts: { reason?: string }) => Promise<unknown>;
  reverseOrderBooks?: (orderId: string, why: { reason: string }) => Promise<boolean>;
  refundCharge?: (chargeId: string, reason?: string) => Promise<{ refunded: boolean }>;
};

/** The reader/commerce payments module, loaded lazily so the admin API boots without it. */
async function payments(): Promise<PaymentsModule> {
  try {
    return (await import(new URL('../lib/payments.ts', import.meta.url).href)) as PaymentsModule;
  } catch (e) {
    if ((e as { code?: string }).code === 'ERR_MODULE_NOT_FOUND') return {};
    throw e;
  }
}

async function payoutEmail(p: Row, status: string, note: string): Promise<void> {
  const site = await getSetting('site');
  const brand = await one<{ name: string }>('select name from publishers where id = $1', [p.publisher_id]);
  const people = new Map((await brandContacts(p.publisher_id)).map((c) => [c.id, c]));
  if (p.requested_by && !people.has(p.requested_by)) {
    const r = await one<{ id: string; email: string; display_name: string }>('select id, email, display_name from users where id = $1 and deleted_at is null', [p.requested_by]);
    if (r) people.set(r.id, r);
  }
  const url = `/studio/brand/${p.publisher_id}/earnings`;
  for (const person of people.values()) {
    await sendTemplate(
      'payout_update',
      person.email,
      { amount: money(p.amount_cents, site.currency), status, brand: brand?.name ?? '', note, url: config.appUrl + url },
      { userId: person.id, publisherId: p.publisher_id },
    );
    await notify(person.id, 'payout', `Payout ${status}: ${money(p.amount_cents, site.currency)}`, note, url);
  }
}

/** My own reading of the split, used only when the settlement module has no preview. */
async function estimateSettlement(month: string) {
  const rev = await getSetting('revenue');
  const pot = await one(
    `select count(*)::int as subscribers, coalesce(sum(gross_cents),0)::float8 as gross_cents, coalesce(sum(fee_cents),0)::float8 as fee_cents,
            count(*) filter (where settled_at is not null)::int as settled
       from sub_months where month = $1`,
    [month],
  );
  const publishers = await q(
    `with pots as (select user_id, gross_cents - fee_cents as net from sub_months where month = $1),
          reads as (select user_id, publisher_id, count(*) as n from page_reads where month = $1 and via = 'subscription' group by 1, 2),
          tot as (select user_id, sum(n) as t from reads group by 1)
     select r.publisher_id, p.name, sum(r.n)::int as pages, count(distinct r.user_id)::int as readers,
            floor(sum(pots.net * r.n::numeric / tot.t * coalesce(p.sub_share_bps, $2) / 10000.0))::float8 as creator_cents
       from reads r join tot using (user_id) join pots using (user_id) join publishers p on p.id = r.publisher_id
      group by 1, 2 order by 5 desc`,
    [month, rev.sub_share_bps],
  );
  const idle = await one<{ n: number }>(
    `select count(*)::int as n from sub_months m where m.month = $1
        and not exists (select 1 from page_reads r where r.user_id = m.user_id and r.month = m.month and r.via = 'subscription')`,
    [month],
  );
  const creator = publishers.reduce((a, b) => a + b.creator_cents, 0);
  return {
    source: 'estimate',
    note: 'Estimate from page reads: each member\'s net payment split across the brands they read, times the brand\'s membership share. The settlement run is authoritative and may round differently.',
    month,
    ...pot,
    subscribers_without_reads: idle?.n ?? 0,
    creator_cents: creator,
    platform_cents: pot!.gross_cents - pot!.fee_cents - creator,
    publishers,
  };
}

const codeBody = z.object({
  kind: z.enum(['membership', 'credits', 'discount']),
  code: z.string().trim().toUpperCase().regex(/^[A-Z0-9][A-Z0-9-]{3,39}$/, 'Codes are 4-40 letters, numbers or dashes').optional(),
  quantity: z.number().int().min(1).max(500).default(1),
  membership_days: z.number().int().min(1).max(3650).optional(),
  page_credits: z.number().int().min(1).max(100_000).optional(),
  percent_off: z.number().int().min(1).max(100).optional(),
  max_redemptions: z.number().int().min(1).max(1_000_000).nullable().optional(),
  starts_at: zDate.nullable().optional(),
  expires_at: zDate.nullable().optional(),
  batch_label: z.string().trim().max(120).optional(),
  assigned_email: z.email().optional(),
});

export default async function adminFinanceRoutes(app: FastifyInstance) {
  await adminScope(app, (s) => {
    // ------------------------------------------------------------ orders
    s.get('/api/admin/orders', async (req) => {
      requireAdmin(req);
      const qy = query(req);
      const { limit, offset, page } = pageParams(req.query, 50, 200);
      const w = where();
      if (qy.status) w.add('o.status = ?', qy.status);
      if (qy.provider) w.add('o.provider = ?', qy.provider);
      if (isUuid(qy.user_id)) w.add('o.user_id = ?', qy.user_id);
      if (isUuid(qy.publisher_id)) w.add('exists (select 1 from order_items i where i.order_id = o.id and i.publisher_id = ?)', qy.publisher_id);
      if (qy.q) {
        const term = qy.q.trim();
        const p = w.param(like(term));
        w.add(`(u.email ilike ${p} or u.username ilike ${p} or o.provider_ref = ${w.param(term)} or o.id::text = ${w.param(term.toLowerCase())})`);
      }
      dateRange(w, 'o.created_at', qy);
      const from = 'from orders o join users u on u.id = o.user_id';
      const agg = (await one<{ n: number; gross: number }>(
        `select count(*)::int as n, coalesce(sum(o.total_cents) filter (where o.status = 'paid'),0)::float8 as gross ${from} ${w.sql}`, w.values))!;
      const items = await q(
        `select o.id, o.status, o.total_cents, o.fee_cents, o.provider, o.provider_ref, o.created_at, o.paid_at, o.refunded_at,
                o.user_id, u.email, u.username,
                (select count(*) from order_items i where i.order_id = o.id)::int as item_count,
                (select string_agg(i.description, ', ') from order_items i where i.order_id = o.id) as summary
           ${from} ${w.sql} order by o.created_at desc limit ${limit} offset ${offset}`,
        w.values,
      );
      return { items, total: agg.n, paid_cents: agg.gross, page, limit };
    });

    s.get('/api/admin/orders/:id', async (req) => {
      requireAdmin(req);
      const id = idParam(req);
      const order = await one(
        `select o.*, u.email, u.username, u.display_name, pc.code as discount_code
           from orders o join users u on u.id = o.user_id left join promo_codes pc on pc.id = o.discount_code_id where o.id = $1`,
        [id],
      );
      if (!order) throw notFound('Order not found');
      const [items, ledger, entitlements, giftCards] = await Promise.all([
        q(
          `select i.id, i.kind, i.description, i.price_cents, i.creator_cents, i.release_id, i.series_id, i.publisher_id, i.bundle_id,
                  p.name as publisher_name, sr.title as series_title
             from order_items i left join publishers p on p.id = i.publisher_id left join series sr on sr.id = i.series_id
            where i.order_id = $1 order by i.id`,
          [id],
        ),
        q(
          `select l.id, l.kind, l.amount_cents, l.gross_cents, l.note, l.created_at, l.publisher_id, p.name as publisher_name
             from ledger l join publishers p on p.id = l.publisher_id where l.order_id = $1 order by l.created_at, l.id`,
          [id],
        ),
        q(`select e.release_id, e.source, e.can_download, r.title from entitlements e join releases r on r.id = e.release_id where e.order_id = $1`, [id]),
        q('select id, amount_cents, balance_cents, recipient_email, redeemed_at from gift_cards where order_id = $1', [id]),
      ]);
      return { order, items, ledger, entitlements, gift_cards: giftCards };
    });

    /**
     * Refund a paid order.
     *   - Default: the card payment goes back through the processor (lib/payments.ts refundOrder).
     *   - `to_wallet: true` gives the reader store credit instead; the processor is not called.
     *   - On an install without the payments module, a card order needs `provider_refunded: true`:
     *     you confirm the money was returned in the processor's dashboard and this records it.
     * Either way creator earnings are reversed and ownership of the releases is removed.
     */
    s.post('/api/admin/orders/:id/refund', async (req) => {
      requireAdmin(req);
      const id = idParam(req);
      const body = parse(
        z.object({
          reason: z.string().trim().min(3, 'Give a reason for the refund').max(500),
          to_wallet: z.boolean().default(false),
          provider_refunded: z.boolean().default(false),
        }),
        req.body,
      );
      const order = await one('select * from orders where id = $1', [id]);
      if (!order) throw notFound('Order not found');
      if (order.status === 'refunded') throw conflict('This order has already been refunded');
      if (order.status !== 'paid') throw badRequest('Only paid orders can be refunded');

      const pay = await payments();
      const external = order.provider !== 'sandbox' && order.total_cents - (order.credit_cents ?? 0) > 0;
      let method: 'provider' | 'wallet' | 'recorded' | 'none';
      if (body.to_wallet) method = 'wallet';
      else if (!external) method = 'none'; // nothing was charged to a card
      else if (pay.refundOrder) method = 'provider';
      else if (body.provider_refunded) method = 'recorded';
      else {
        throw new HttpError(
          409,
          'This server cannot send refunds to the payment processor. Refund it in the processor dashboard and confirm here, or refund as store credit.',
          'provider_refund_unavailable',
        );
      }

      const warnings: string[] = [];
      let booksBy: 'payments' | 'admin' = 'payments';
      if (method === 'provider') {
        // Asks the processor for the money first; changes nothing if it refuses.
        await pay.refundOrder!(id, { reason: body.reason });
      } else if (pay.reverseOrderBooks) {
        await pay.reverseOrderBooks(id, { reason: body.reason });
      } else {
        booksBy = 'admin';
      }

      // Without the payments module: reverse earnings and remove ownership here. Every step is idempotent.
      const reversed = await tx(async (db) => {
        const cur = await one<{ status: string }>('select status from orders where id = $1 for update', [id], db);
        if (booksBy === 'payments' && cur!.status !== 'refunded') throw new HttpError(409, 'The order could not be refunded. Reload it and try again.');
        await exec(`update orders set status = 'refunded', refunded_at = coalesce(refunded_at, now()) where id = $1`, [id], db);
        const cents = await reverseOrder(db, id, `Refund: ${body.reason}`);
        await exec('delete from entitlements where order_id = $1', [id], db);
        if (booksBy === 'admin') await exec('update gift_cards set balance_cents = 0 where order_id = $1 and redeemed_at is null', [id], db);
        if (method === 'wallet') {
          // The payments module already hands back any store credit spent on the order.
          const back = booksBy === 'payments' ? order.total_cents - (order.credit_cents ?? 0) : order.total_cents;
          if (back > 0) {
            await exec(
              `insert into wallets (user_id, credit_cents) values ($1, $2)
               on conflict (user_id) do update set credit_cents = wallets.credit_cents + excluded.credit_cents, updated_at = now()`,
              [order.user_id, back], db);
            await exec(`insert into wallet_log (user_id, kind, credit_cents, note) values ($1, 'refund', $2, $3)`, [order.user_id, back, `Refund of order ${id} as store credit: ${body.reason}`], db);
          }
        }
        return cents;
      });
      if (booksBy === 'admin') {
        const kinds = (await q<{ kind: string }>('select distinct kind from order_items where order_id = $1', [id])).map((r) => r.kind);
        if (kinds.includes('credits')) warnings.push('This order bought page credits. They were not removed: adjust the reader\'s wallet if needed.');
        if (await one('select 1 from gift_cards where order_id = $1 and redeemed_at is not null', [id])) warnings.push('A gift card from this order was already redeemed and keeps its value.');
      }
      const ledgerReversed = await one<{ cents: number }>(`select coalesce(-sum(amount_cents),0)::float8 as cents from ledger where order_id = $1 and kind = 'refund'`, [id]);
      audit(req, 'order.refund', { kind: 'order', id }, { reason: body.reason, method, total_cents: order.total_cents, creator_cents_reversed: ledgerReversed?.cents ?? reversed });
      return { ok: true, method, creator_cents_reversed: ledgerReversed?.cents ?? reversed, warnings };
    });

    // ------------------------------------------------------------ memberships
    s.get('/api/admin/memberships', async (req) => {
      requireAdmin(req);
      const qy = query(req);
      const { limit, offset, page } = pageParams(req.query, 50, 200);
      const w = where();
      if (qy.status === 'current') w.add(`sb.status in ('active','past_due') and sb.current_period_end > now()`);
      else if (qy.status) w.add('sb.status = ?', qy.status);
      if (qy.plan) w.add('sb.plan = ?', qy.plan);
      if (qy.provider) w.add('sb.provider = ?', qy.provider);
      if (qy.q) {
        const p = w.param(like(qy.q));
        w.add(`(u.email ilike ${p} or u.username ilike ${p})`);
      }
      const from = 'from subscriptions sb join users u on u.id = sb.user_id';
      const total = (await one<{ n: number }>(`select count(*)::int as n ${from} ${w.sql}`, w.values))!.n;
      const items = await q(
        `select sb.id, sb.plan, sb.status, sb.provider, sb.provider_ref, sb.price_cents, sb.current_period_start, sb.current_period_end,
                sb.cancel_at_period_end, sb.canceled_at, sb.created_at, sb.user_id, u.email, u.username
           ${from} ${w.sql} order by sb.created_at desc limit ${limit} offset ${offset}`,
        w.values,
      );
      const summary = await one(
        `select count(distinct user_id) filter (where status in ('active','past_due') and current_period_end > now())::int as active_members,
                count(*) filter (where status = 'past_due')::int as past_due,
                count(*) filter (where status = 'active' and cancel_at_period_end and provider <> 'grant' and current_period_end > now())::int as cancelling,
                count(*) filter (where provider = 'grant' and status = 'active' and current_period_end > now())::int as complimentary,
                coalesce(round(sum(case plan when 'annual' then price_cents / 12.0 else price_cents end)
                  filter (where status = 'active' and current_period_end > now() and not cancel_at_period_end)),0)::float8 as mrr_cents
           from subscriptions`,
      );
      return { items, total, page, limit, summary };
    });

    /** One membership with its billing history. */
    s.get('/api/admin/memberships/:id', async (req) => {
      requireAdmin(req);
      const id = idParam(req);
      const membership = await one(
        `select sb.id, sb.plan, sb.status, sb.provider, sb.provider_ref, sb.price_cents, sb.current_period_start, sb.current_period_end,
                sb.cancel_at_period_end, sb.canceled_at, sb.created_at, sb.user_id, u.email, u.username
           from subscriptions sb join users u on u.id = sb.user_id where sb.id = $1`,
        [id],
      );
      if (!membership) throw notFound('Membership not found');
      const charges = await q(
        `select id, period_start, period_end, amount_cents, fee_cents, status, attempts, last_error, payment_ref, paid_at, refunded_at, created_at
           from subscription_charges where subscription_id = $1 order by period_start desc limit 60`,
        [id],
      );
      const months = await q(`select to_char(month, 'YYYY-MM') as month, gross_cents, fee_cents, settled_at from sub_months where subscription_id = $1 order by month desc limit 60`, [id]);
      return { membership, charges, months };
    });

    /** Refund one membership payment through the processor. Ends the membership. */
    s.post('/api/admin/membership-charges/:id/refund', async (req) => {
      requireAdmin(req);
      const id = idParam(req);
      const { reason } = parse(z.object({ reason: z.string().trim().min(3, 'Give a reason for the refund').max(300) }), req.body);
      const pay = await payments();
      if (!pay.refundCharge) throw new HttpError(501, 'Membership refunds are not available on this server (lib/payments.ts is missing)');
      const charge = await one('select amount_cents, user_id, status from subscription_charges where id = $1', [id]);
      if (!charge) throw notFound('Membership charge not found');
      const r = await pay.refundCharge(id, reason);
      if (!r.refunded) throw conflict(`This charge is ${charge.status}; only a paid charge can be refunded`);
      audit(req, 'membership_charge.refund', { kind: 'subscription_charge', id }, { reason, amount_cents: charge.amount_cents, user_id: charge.user_id });
      return { ok: true };
    });

    // ------------------------------------------------------------ payouts (super admin)
    s.get('/api/admin/payouts', async (req) => {
      requireSuperAdmin(req);
      const qy = query(req);
      const { limit, offset, page } = pageParams(req.query, 50, 200);
      const w = where();
      if (qy.status !== 'all') w.add('po.status = ?', qy.status || 'requested');
      if (isUuid(qy.publisher_id)) w.add('po.publisher_id = ?', qy.publisher_id);
      const total = (await one<{ n: number }>(`select count(*)::int as n from payouts po ${w.sql}`, w.values))!.n;
      const items = await q(
        `select po.id, po.publisher_id, p.name as publisher_name, p.slug as publisher_slug, p.suspended_at as publisher_suspended_at,
                po.amount_cents, po.status, po.method, po.destination, po.note, po.reference, po.created_at, po.reviewed_at, po.paid_at,
                po.requested_by, ru.email as requested_by_email, po.reviewed_by, au.username as reviewed_by_username,
                (select coalesce(sum(amount_cents),0) from ledger l where l.publisher_id = po.publisher_id)::float8 as balance_cents,
                (select coalesce(sum(amount_cents) filter (where available_at <= now()),0) from ledger l where l.publisher_id = po.publisher_id)::float8 as available_cents,
                exists (select 1 from ledger l where l.payout_id = po.id) as debited
           from payouts po join publishers p on p.id = po.publisher_id
           left join users ru on ru.id = po.requested_by left join users au on au.id = po.reviewed_by
           ${w.sql} order by po.created_at ${qy.status && qy.status !== 'requested' ? 'desc' : 'asc'} limit ${limit} offset ${offset}`,
        w.values,
      );
      const totals = await q('select status, count(*)::int as count, coalesce(sum(amount_cents),0)::float8 as cents from payouts group by status');
      return { items, total, page, limit, totals };
    });

    /**
     * Approve: debit the brand's ledger and mark the payout approved in one
     * transaction, under a lock on the brand so two approvals cannot overdraw it.
     */
    s.post('/api/admin/payouts/:id/approve', async (req) => {
      const actor = requireSuperAdmin(req);
      const id = idParam(req);
      const body = parse(z.object({ note: z.string().trim().max(500).optional() }), req.body ?? {});
      const p = await tx(async (db) => {
        const po = await one('select * from payouts where id = $1 for update', [id], db);
        if (!po) throw notFound('Payout not found');
        if (po.status !== 'requested') throw conflict(`This payout is already ${po.status}`);
        const brand = await one<{ suspended_at: string | null }>('select suspended_at from publishers where id = $1 for update', [po.publisher_id], db);
        if (!brand) throw notFound('Brand not found');
        if (brand.suspended_at) throw badRequest('This brand is suspended. Lift the suspension or reject the payout.');
        const debited = await one<{ cents: number }>('select coalesce(sum(amount_cents),0)::float8 as cents from ledger where payout_id = $1', [id], db);
        if ((debited?.cents ?? 0) === 0) {
          const bal = await brandBalance(po.publisher_id, db);
          if (bal.available_cents < po.amount_cents || bal.balance_cents < po.amount_cents) {
            throw badRequest(`The brand only has ${(bal.available_cents / 100).toFixed(2)} available, less than this payout. Reject it or wait for held earnings to clear.`);
          }
          await exec(
            `insert into ledger (publisher_id, kind, amount_cents, payout_id, note) values ($1, 'payout', $2, $3, $4)`,
            [po.publisher_id, -po.amount_cents, id, `Payout via ${po.method}`], db);
        } else if ((await brandBalance(po.publisher_id, db)).balance_cents < 0) {
          throw badRequest('The brand balance is below zero. Reject this payout.');
        }
        return one(
          `update payouts set status = 'approved', reviewed_by = $2, reviewed_at = now(), note = coalesce($3, note) where id = $1 returning *`,
          [id, actor.id, body.note ?? null], db);
      });
      await payoutEmail(p!, 'approved', body.note || 'Your payout has been approved and will be sent shortly.');
      audit(req, 'payout.approve', { kind: 'payout', id }, { publisher_id: p!.publisher_id, amount_cents: p!.amount_cents, method: p!.method });
      return { ok: true, payout: p, balance: await brandBalance(p!.publisher_id) };
    });

    s.post('/api/admin/payouts/:id/paid', async (req) => {
      const actor = requireSuperAdmin(req);
      const id = idParam(req);
      const body = parse(z.object({ reference: z.string().trim().min(1, 'Enter the transfer reference').max(200), note: z.string().trim().max(500).optional() }), req.body);
      const p = await one(
        `update payouts set status = 'paid', paid_at = now(), reference = $2, reviewed_by = $3, note = coalesce($4, note)
          where id = $1 and status = 'approved' returning *`,
        [id, body.reference, actor.id, body.note ?? null],
      );
      if (!p) {
        const cur = await one<{ status: string }>('select status from payouts where id = $1', [id]);
        if (!cur) throw notFound('Payout not found');
        throw conflict(cur.status === 'requested' ? 'Approve this payout before marking it paid' : `This payout is already ${cur.status}`);
      }
      await payoutEmail(p, 'paid', body.note || `Sent via ${p.method}. Reference: ${body.reference}`);
      audit(req, 'payout.paid', { kind: 'payout', id }, { publisher_id: p.publisher_id, amount_cents: p.amount_cents, reference: body.reference });
      return { ok: true, payout: p };
    });

    /** Reject a requested or approved payout. Money already debited goes back to the brand. */
    s.post('/api/admin/payouts/:id/reject', async (req) => {
      const actor = requireSuperAdmin(req);
      const id = idParam(req);
      const body = parse(z.object({ note: z.string().trim().min(3, 'Tell the creator why').max(500) }), req.body);
      const result = await tx(async (db) => {
        const po = await one('select * from payouts where id = $1 for update', [id], db);
        if (!po) throw notFound('Payout not found');
        if (!['requested', 'approved'].includes(po.status)) throw conflict(`This payout is already ${po.status}`);
        await one('select 1 from publishers where id = $1 for update', [po.publisher_id], db);
        const debited = await one<{ cents: number }>('select coalesce(sum(amount_cents),0)::float8 as cents from ledger where payout_id = $1', [id], db);
        const returned = -(debited?.cents ?? 0);
        if (returned > 0) {
          await exec(
            `insert into ledger (publisher_id, kind, amount_cents, payout_id, note) values ($1, 'adjustment', $2, $3, 'Payout rejected: funds returned')`,
            [po.publisher_id, returned, id], db);
        }
        const row = await one(`update payouts set status = 'rejected', reviewed_by = $2, reviewed_at = now(), note = $3 where id = $1 returning *`, [id, actor.id, body.note], db);
        return { row: row!, returned };
      });
      await payoutEmail(result.row, 'rejected', body.note);
      audit(req, 'payout.reject', { kind: 'payout', id }, { publisher_id: result.row.publisher_id, amount_cents: result.row.amount_cents, returned_cents: result.returned, note: body.note });
      return { ok: true, payout: result.row, returned_cents: result.returned };
    });

    // ------------------------------------------------------------ settlement (super admin)
    s.get('/api/admin/settlement', async (req) => {
      requireSuperAdmin(req);
      const months = await q(
        `select to_char(m.month, 'YYYY-MM') as month, m.subscribers, m.gross_cents, m.fee_cents, m.unsettled,
                (m.month < date_trunc('month', now())::date) as closed,
                st.ran_at, st.creator_cents, st.platform_cents, u.username as ran_by_username
           from (select month, count(*)::int as subscribers, sum(gross_cents)::float8 as gross_cents, sum(fee_cents)::float8 as fee_cents,
                        count(*) filter (where settled_at is null)::int as unsettled
                   from sub_months group by month) m
           left join settlements st on st.month = m.month left join users u on u.id = st.ran_by
          order by m.month desc limit 60`,
      );
      return { months };
    });

    s.get('/api/admin/settlement/:month/preview', async (req) => {
      requireSuperAdmin(req);
      const month = monthStart((req.params as { month: string }).month);
      const existing = await one('select * from settlements where month = $1', [month]);
      let preview: unknown = null;
      try {
        const mod = await settlementModule();
        if (mod.previewSettlement) preview = await mod.previewSettlement(month);
      } catch (e) {
        if (!(e instanceof HttpError && e.code === 'settlement_missing')) throw e;
      }
      const result = (preview ?? (await estimateSettlement(month))) as { series?: { series_id: string; publisher_id: string; series_title?: string; publisher_name?: string }[] };
      // Name the rows so the preview reads as titles and brands, not ids.
      if (Array.isArray(result.series) && result.series.length) {
        const names = await q<{ id: string; title: string; name: string }>(
          'select s.id, s.title, p.name from series s join publishers p on p.id = s.publisher_id where s.id = any($1::uuid[])',
          [result.series.map((r) => r.series_id)],
        );
        const byId = new Map(names.map((n) => [n.id, n]));
        for (const r of result.series) {
          r.series_title = byId.get(r.series_id)?.title ?? r.series_title;
          r.publisher_name = byId.get(r.series_id)?.name ?? r.publisher_name;
        }
      }
      return { month: month.slice(0, 7), settled: existing, preview: result };
    });

    s.post('/api/admin/settlement/:month/run', async (req) => {
      const actor = requireSuperAdmin(req);
      const month = monthStart((req.params as { month: string }).month);
      if (new Date(month + 'T00:00:00Z').getTime() >= Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1)) {
        throw badRequest('That month is not over yet. Settlement runs once the month has ended.');
      }
      const mod = await settlementModule();
      const result = await mod.settleMonth(month, { ranBy: actor.id });
      const row = await one('select * from settlements where month = $1', [month]);
      audit(req, 'settlement.run', { kind: 'settlement', id: month.slice(0, 7) }, { creator_cents: row?.creator_cents ?? null, platform_cents: row?.platform_cents ?? null, subscribers: row?.subscribers ?? null });
      return { ok: true, month: month.slice(0, 7), settlement: row, result: result ?? null };
    });

    // ------------------------------------------------------------ platform codes
    s.get('/api/admin/codes', async (req) => {
      requireAdmin(req);
      const qy = query(req);
      const { limit, offset, page } = pageParams(req.query, 50, 500);
      const w = where();
      w.add('c.publisher_id is null');
      if (qy.kind) w.add('c.kind = ?', qy.kind);
      if (isUuid(qy.batch_id)) w.add('c.batch_id = ?', qy.batch_id);
      if (qy.q) {
        const p = w.param(like(qy.q));
        w.add(`(c.code ilike ${p} or c.batch_label ilike ${p} or c.assigned_email ilike ${p})`);
      }
      if (qy.status === 'active') w.add('c.disabled_at is null and (c.expires_at is null or c.expires_at > now()) and (c.max_redemptions is null or c.redeemed_count < c.max_redemptions)');
      if (qy.status === 'disabled') w.add('c.disabled_at is not null');
      if (qy.status === 'used') w.add('c.redeemed_count > 0');
      const total = (await one<{ n: number }>(`select count(*)::int as n from promo_codes c ${w.sql}`, w.values))!.n;
      const items = await q(
        `select c.id, c.code, c.kind, c.percent_off, c.membership_days, c.page_credits, c.max_redemptions, c.redeemed_count, c.batch_label, c.batch_id,
                c.assigned_email, c.starts_at, c.expires_at, c.disabled_at, c.created_at, u.username as created_by_username
           from promo_codes c left join users u on u.id = c.created_by ${w.sql}
          order by c.created_at desc, c.code limit ${limit} offset ${offset}`,
        w.values,
      );
      return { items, total, page, limit };
    });

    /** Create one named code, or a batch of random single-use codes. */
    s.post('/api/admin/codes', async (req) => {
      const actor = requireAdmin(req);
      const body = parse(codeBody, req.body);
      if (body.kind === 'membership' && !body.membership_days) throw badRequest('Enter how many days of membership the code grants');
      if (body.kind === 'credits' && !body.page_credits) throw badRequest('Enter how many page credits the code grants');
      if (body.kind === 'discount' && !body.percent_off) throw badRequest('Enter the percentage off');
      if (body.code && body.quantity > 1) throw badRequest('A custom code can only be created one at a time');
      if (body.expires_at && Date.parse(body.expires_at) <= Date.now()) throw badRequest('The expiry date is in the past');
      if (body.code && (await one('select 1 from promo_codes where upper(code) = $1', [body.code]))) throw conflict('That code already exists');
      // Random codes are single-use unless told otherwise; a named code is unlimited unless capped.
      const max = body.max_redemptions === undefined ? (body.code ? null : 1) : body.max_redemptions;
      const batch = body.quantity > 1 ? (await one<{ id: string }>('select uuidv7() as id'))!.id : null;
      const created = await tx(async (db) => {
        const out: Row[] = [];
        for (let i = 0; i < body.quantity; i++) {
          for (let attempt = 0; ; attempt++) {
            const code = body.code ?? randomCode(3, 4);
            const row = await one(
              `insert into promo_codes (code, kind, percent_off, membership_days, page_credits, max_redemptions, batch_label, batch_id,
                                        assigned_email, starts_at, expires_at, created_by)
               values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
               on conflict (upper(code)) do nothing
               returning id, code, kind, percent_off, membership_days, page_credits, max_redemptions, expires_at`,
              [code, body.kind, body.kind === 'discount' ? body.percent_off : null, body.kind === 'membership' ? body.membership_days : null,
               body.kind === 'credits' ? body.page_credits : null, max, body.batch_label ?? null, batch, body.assigned_email ?? null,
               body.starts_at ?? null, body.expires_at ?? null, actor.id],
              db,
            );
            if (row) {
              out.push(row);
              break;
            }
            if (body.code || attempt > 5) throw conflict('Could not create a unique code. Try again.');
          }
        }
        return out;
      });
      audit(req, 'code.create', { kind: 'promo_code', id: batch ?? created[0].id }, {
        kind: body.kind, quantity: created.length, membership_days: body.membership_days, page_credits: body.page_credits,
        percent_off: body.percent_off, max_redemptions: max, batch_label: body.batch_label ?? null,
      });
      return { ok: true, batch_id: batch, codes: created };
    });

    s.post('/api/admin/codes/:id/disable', async (req) => {
      requireAdmin(req);
      const id = idParam(req);
      const { disabled } = parse(z.object({ disabled: z.boolean().default(true) }), req.body ?? {});
      const c = await one(
        `update promo_codes set disabled_at = case when $2 then coalesce(disabled_at, now()) else null end
          where id = $1 and publisher_id is null returning code, disabled_at`,
        [id, disabled],
      );
      if (!c) throw notFound('Code not found');
      audit(req, disabled ? 'code.disable' : 'code.enable', { kind: 'promo_code', id }, { code: c.code });
      return { ok: true, disabled_at: c.disabled_at };
    });

    // ------------------------------------------------------------ gift cards
    s.get('/api/admin/gift-cards', async (req) => {
      requireAdmin(req);
      const qy = query(req);
      const { limit, offset, page } = pageParams(req.query, 50, 200);
      const w = where();
      if (qy.q) {
        const p = w.param(like(qy.q));
        w.add(`(g.code ilike ${p} or g.recipient_email ilike ${p})`);
      }
      if (qy.status === 'redeemed') w.add('g.redeemed_at is not null');
      if (qy.status === 'unredeemed') w.add('g.redeemed_at is null and g.balance_cents > 0');
      if (qy.status === 'void') w.add('g.redeemed_at is null and g.balance_cents = 0');
      const total = (await one<{ n: number }>(`select count(*)::int as n from gift_cards g ${w.sql}`, w.values))!.n;
      const items = await q(
        `select g.id, g.code, g.amount_cents, g.balance_cents, g.recipient_email, g.message, g.order_id, g.created_at, g.redeemed_at,
                g.purchaser_id, pu.username as purchaser_username, g.redeemed_by, ru.username as redeemed_by_username
           from gift_cards g left join users pu on pu.id = g.purchaser_id left join users ru on ru.id = g.redeemed_by
           ${w.sql} order by g.created_at desc limit ${limit} offset ${offset}`,
        w.values,
      );
      return { items, total, page, limit };
    });

    /** Issue a complimentary gift card (store credit). Super admin only. */
    s.post('/api/admin/gift-cards', async (req) => {
      const actor = requireSuperAdmin(req);
      const body = parse(
        z.object({
          amount_cents: z.number().int().min(100).max(100_000),
          recipient_email: z.email().optional(),
          message: z.string().trim().max(500).default(''),
          send_email: z.boolean().default(true),
        }),
        req.body,
      );
      let card: Row | null = null;
      for (let attempt = 0; attempt < 6 && !card; attempt++) {
        card = await one(
          `insert into gift_cards (code, amount_cents, balance_cents, purchaser_id, recipient_email, message)
           values ($1, $2, $2, $3, $4, $5) on conflict (upper(code)) do nothing
           returning id, code, amount_cents, balance_cents, recipient_email, message, created_at`,
          [randomCode(4, 4), body.amount_cents, actor.id, body.recipient_email?.toLowerCase() ?? null, body.message],
        );
      }
      if (!card) throw conflict('Could not create a unique gift code. Try again.');
      let emailId: string | null = null;
      if (body.recipient_email && body.send_email) {
        const site = await getSetting('site');
        emailId = await sendTemplate('gift_card', body.recipient_email, {
          amount: money(body.amount_cents, site.currency),
          message: body.message || `A gift from ${site.name}.`,
          code: card.code,
          url: `${config.appUrl}/redeem?code=${encodeURIComponent(card.code)}`,
        });
      }
      audit(req, 'gift_card.create', { kind: 'gift_card', id: card.id }, { amount_cents: body.amount_cents, recipient_email: body.recipient_email ?? null });
      return { ok: true, gift_card: card, email_id: emailId };
    });

    s.post('/api/admin/gift-cards/:id/void', async (req) => {
      requireSuperAdmin(req);
      const id = idParam(req);
      const g = await one('update gift_cards set balance_cents = 0 where id = $1 and redeemed_at is null returning code, amount_cents', [id]);
      if (!g) throw badRequest('This gift card was not found or has already been redeemed');
      audit(req, 'gift_card.void', { kind: 'gift_card', id }, { amount_cents: g.amount_cents });
      return { ok: true };
    });
  });
}
