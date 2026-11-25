import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { exec, one, q, tx } from '../db.ts';
import { adminScope, brandBalance, idParam, like, query, tellBrand, where, zReason } from '../lib/admin.ts';
import { audit, badRequest, notFound, pageParams, parse, requireAdmin, requireSuperAdmin } from '../lib/http.ts';
import { brandPremiumSummary } from '../lib/payments.ts';
import { getSetting } from '../lib/settings.ts';
import { publicUrl } from '../lib/storage.ts';

const bps = z.number().int().min(0).max(10000).nullable();

export default async function adminBrandRoutes(app: FastifyInstance) {
  await adminScope(app, (s) => {
    s.get('/api/admin/brands', async (req) => {
      requireAdmin(req);
      const qy = query(req);
      const { limit, offset, page } = pageParams(req.query, 50, 200);
      const w = where();
      if (qy.status === 'deleted') w.add('p.deleted_at is not null');
      else w.add('p.deleted_at is null');
      if (qy.q) {
        const p = w.param(like(qy.q));
        w.add(`(p.name ilike ${p} or p.slug ilike ${p})`);
      }
      if (qy.kind) w.add('p.kind = ?', qy.kind);
      if (qy.status === 'verified') w.add('p.verified_at is not null');
      if (qy.status === 'unverified') w.add('p.verified_at is null');
      if (qy.status === 'suspended') w.add('p.suspended_at is not null');
      if (qy.status === 'kind_requested') w.add('p.kind_requested is not null');
      const total = (await one<{ n: number }>(`select count(*)::int as n from publishers p ${w.sql}`, w.values))!.n;
      const items = await q(
        `select p.id, p.slug, p.name, p.kind, p.kind_requested, p.avatar_key, p.country, p.verified_at, p.suspended_at, p.suspend_reason,
                p.sale_share_bps, p.sub_share_bps, p.tip_share_bps, p.created_at,
                (select count(*) from series s where s.publisher_id = p.id and s.deleted_at is null)::int as series_count,
                (select count(*) from publisher_members m where m.publisher_id = p.id)::int as member_count,
                (select coalesce(sum(amount_cents),0) from ledger l where l.publisher_id = p.id)::float8 as balance_cents
           from publishers p ${w.sql}
          order by ${qy.sort === 'name' ? 'lower(p.name)' : qy.sort === 'balance' ? 'balance_cents desc' : 'p.created_at desc'}
          limit ${limit} offset ${offset}`,
        w.values,
      );
      for (const b of items) b.avatar_url = await publicUrl(b.avatar_key);
      return { items, total, page, limit };
    });

    s.get('/api/admin/brands/:id', async (req) => {
      requireAdmin(req);
      const id = idParam(req);
      const brand = await one(
        `select id, slug, name, kind, kind_requested, bio, avatar_key, banner_key, website, socials, country, timezone,
                sale_share_bps, sub_share_bps, tip_share_bps, tips_enabled, monthly_goal_cents, primary_language,
                verified_at, suspended_at, suspend_reason, deleted_at, created_at,
                (payout->>'method') as payout_method
           from publishers where id = $1`,
        [id],
      );
      if (!brand) throw notFound('Brand not found');
      brand.avatar_url = await publicUrl(brand.avatar_key);
      brand.banner_url = await publicUrl(brand.banner_key);
      const [members, series, balance, payouts, revenue, earned] = await Promise.all([
        q(
          `select u.id, u.email, u.username, u.display_name, m.role, m.created_at
             from publisher_members m join users u on u.id = m.user_id where m.publisher_id = $1
            order by case m.role when 'owner' then 0 when 'admin' then 1 when 'editor' then 2 else 3 end, m.created_at`,
          [id],
        ),
        q(
          `select id, slug, title, visibility, access_model, mature, takedown_at, follower_count, read_count, created_at
             from series where publisher_id = $1 and deleted_at is null order by created_at desc limit 100`,
          [id],
        ),
        brandBalance(id),
        q('select id, amount_cents, status, method, reference, created_at, reviewed_at, paid_at from payouts where publisher_id = $1 order by created_at desc limit 10', [id]),
        getSetting('revenue'),
        q<{ kind: string; cents: number }>('select kind, sum(amount_cents)::float8 as cents from ledger where publisher_id = $1 group by kind', [id]),
      ]);
      return {
        brand,
        // Creator Premium: whether it is on, the grant (if any) and the paid plan (if any). Granted from here or from Finance.
        premium: await brandPremiumSummary(id),
        members,
        series,
        balance,
        earned_by_kind: Object.fromEntries(earned.map((e) => [e.kind, e.cents])),
        payouts,
        shares: {
          defaults: { sale_share_bps: revenue.sale_share_bps, sub_share_bps: revenue.sub_share_bps, tip_share_bps: revenue.tip_share_bps },
          effective: {
            sale_share_bps: brand.sale_share_bps ?? revenue.sale_share_bps,
            sub_share_bps: brand.sub_share_bps ?? revenue.sub_share_bps,
            tip_share_bps: brand.tip_share_bps ?? revenue.tip_share_bps,
          },
        },
      };
    });

    s.post('/api/admin/brands/:id/verify', async (req) => {
      requireAdmin(req);
      const id = idParam(req);
      const { verified } = parse(z.object({ verified: z.boolean().default(true) }), req.body ?? {});
      const b = await one(
        `update publishers set verified_at = case when $2 then coalesce(verified_at, now()) else null end
          where id = $1 and deleted_at is null returning name, verified_at`,
        [id, verified],
      );
      if (!b) throw notFound('Brand not found');
      audit(req, verified ? 'brand.verify' : 'brand.unverify', { kind: 'publisher', id }, { name: b.name });
      return { ok: true, verified_at: b.verified_at };
    });

    /** Approve or deny a pending creator -> publisher (or back) request. */
    s.post('/api/admin/brands/:id/kind-request', async (req) => {
      requireAdmin(req);
      const id = idParam(req);
      const body = parse(z.object({ approve: z.boolean(), note: z.string().trim().max(500).optional() }), req.body);
      const b = await tx(async (db) => {
        const cur = await one<{ name: string; kind: string; kind_requested: string | null }>(
          'select name, kind, kind_requested from publishers where id = $1 and deleted_at is null for update', [id], db);
        if (!cur) throw notFound('Brand not found');
        if (!cur.kind_requested) throw badRequest('This brand has no pending request');
        if (body.approve && !['creator', 'publisher'].includes(cur.kind_requested)) throw badRequest(`"${cur.kind_requested}" is not a brand type that can be approved`);
        await exec('update publishers set kind = case when $2 then kind_requested else kind end, kind_requested = null where id = $1', [id, body.approve], db);
        return cur;
      });
      const requested = b.kind_requested!;
      await tellBrand(
        id,
        'brand',
        body.approve ? `${b.name} is now a ${requested} page` : `Your request to become a ${requested} page was not approved`,
        body.note || (body.approve ? 'Your brand type has been updated.' : 'Contact support if you would like to know more.'),
        `/studio/brand/${id}/settings`,
      );
      audit(req, body.approve ? 'brand.kind_approve' : 'brand.kind_deny', { kind: 'publisher', id }, { name: b.name, from: b.kind, requested, note: body.note ?? null });
      return { ok: true, kind: body.approve ? requested : b.kind };
    });

    /** Per-brand revenue share overrides; null returns the brand to the platform default. Super admin only. */
    s.patch('/api/admin/brands/:id/shares', async (req) => {
      requireSuperAdmin(req);
      const id = idParam(req);
      const body = parse(z.object({ sale_share_bps: bps.optional(), sub_share_bps: bps.optional(), tip_share_bps: bps.optional() }).strict(), req.body);
      const before = await one('select name, sale_share_bps, sub_share_bps, tip_share_bps from publishers where id = $1 and deleted_at is null', [id]);
      if (!before) throw notFound('Brand not found');
      const next = {
        sale_share_bps: body.sale_share_bps === undefined ? before.sale_share_bps : body.sale_share_bps,
        sub_share_bps: body.sub_share_bps === undefined ? before.sub_share_bps : body.sub_share_bps,
        tip_share_bps: body.tip_share_bps === undefined ? before.tip_share_bps : body.tip_share_bps,
      };
      await exec('update publishers set sale_share_bps = $2, sub_share_bps = $3, tip_share_bps = $4 where id = $1', [id, next.sale_share_bps, next.sub_share_bps, next.tip_share_bps]);
      const diff: Record<string, unknown> = {};
      for (const k of Object.keys(next) as (keyof typeof next)[]) if (before[k] !== next[k]) diff[k] = { from: before[k], to: next[k] };
      if (Object.keys(diff).length) audit(req, 'brand.shares', { kind: 'publisher', id }, { name: before.name, diff });
      return { ok: true, ...next };
    });

    s.post('/api/admin/brands/:id/suspend', async (req) => {
      requireAdmin(req);
      const id = idParam(req);
      const { reason } = parse(z.object({ reason: zReason }), req.body);
      const b = await one('update publishers set suspended_at = now(), suspend_reason = $2 where id = $1 and deleted_at is null returning name', [id, reason]);
      if (!b) throw notFound('Brand not found');
      await tellBrand(id, 'moderation', `${b.name} has been suspended`, `Reason: ${reason} Contact support if you think this is a mistake.`, `/studio/brand/${id}/settings`);
      audit(req, 'brand.suspend', { kind: 'publisher', id }, { name: b.name, reason });
      return { ok: true };
    });

    s.post('/api/admin/brands/:id/unsuspend', async (req) => {
      requireAdmin(req);
      const id = idParam(req);
      const b = await one('update publishers set suspended_at = null, suspend_reason = null where id = $1 and deleted_at is null and suspended_at is not null returning name', [id]);
      if (!b) throw notFound('Brand not found or not suspended');
      await tellBrand(id, 'moderation', `${b.name} is active again`, 'The suspension on your brand has been lifted.', `/studio/brand/${id}/settings`);
      audit(req, 'brand.unsuspend', { kind: 'publisher', id }, { name: b.name });
      return { ok: true };
    });

    s.get('/api/admin/brands/:id/ledger', async (req) => {
      requireAdmin(req);
      const id = idParam(req);
      const qy = query(req);
      const { limit, offset, page } = pageParams(req.query, 50, 200);
      if (!(await one('select 1 from publishers where id = $1', [id]))) throw notFound('Brand not found');
      const w = where();
      w.add('l.publisher_id = ?', id);
      if (qy.kind) w.add('l.kind = ?', qy.kind);
      const total = (await one<{ n: number }>(`select count(*)::int as n from ledger l ${w.sql}`, w.values))!.n;
      const items = await q(
        `select l.id, l.kind, l.amount_cents, l.gross_cents, l.series_id, s.title as series_title, l.release_id, l.order_id, l.payout_id,
                l.month, l.note, l.available_at, l.created_at
           from ledger l left join series s on s.id = l.series_id ${w.sql}
          order by l.created_at desc, l.id desc limit ${limit} offset ${offset}`,
        w.values,
      );
      return { items, total, page, limit, balance: await brandBalance(id) };
    });

    /** Manual credit or debit with a note. Super admin only; the balance may not go below zero. */
    s.post('/api/admin/brands/:id/ledger', async (req) => {
      requireSuperAdmin(req);
      const id = idParam(req);
      const body = parse(
        z.object({
          amount_cents: z.number().int().min(-10_000_000).max(10_000_000).refine((n) => n !== 0, 'Enter an amount other than zero'),
          note: z.string().trim().min(3, 'Add a note explaining the adjustment').max(500),
        }),
        req.body,
      );
      const result = await tx(async (db) => {
        const b = await one<{ name: string }>('select name from publishers where id = $1 for update', [id], db);
        if (!b) throw notFound('Brand not found');
        const bal = await brandBalance(id, db);
        if (bal.balance_cents + body.amount_cents < 0) throw badRequest('That would take the brand balance below zero');
        const row = await one<{ id: string }>(
          `insert into ledger (publisher_id, kind, amount_cents, note) values ($1, 'adjustment', $2, $3) returning id`,
          [id, body.amount_cents, body.note], db);
        return { name: b.name, id: row!.id, balance: await brandBalance(id, db) };
      });
      audit(req, 'brand.ledger_adjust', { kind: 'publisher', id }, { name: result.name, ...body, ledger_id: result.id });
      return { ok: true, ledger_id: result.id, balance: result.balance };
    });
  });
}
