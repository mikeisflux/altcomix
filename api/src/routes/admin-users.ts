import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { exec, one, q, tx } from '../db.ts';
import { adminScope, banUser, dropObject, idParam, like, moderationTarget, query, where, zReason } from '../lib/admin.ts';
import { audit, badRequest, conflict, notFound, pageParams, parse, requireAdmin, requireSuperAdmin } from '../lib/http.ts';
import { publicUrl } from '../lib/storage.ts';

const SORTS: Record<string, string> = {
  newest: 'u.created_at desc',
  oldest: 'u.created_at asc',
  last_login: 'u.last_login_at desc nulls last',
  email: 'lower(u.email) asc',
};

export default async function adminUserRoutes(app: FastifyInstance) {
  await adminScope(app, (s) => {
    s.get('/api/admin/users', async (req) => {
      requireAdmin(req);
      const qy = query(req);
      const { limit, offset, page } = pageParams(req.query, 50, 200);
      const w = where();
      if (qy.q) {
        const p = w.param(like(qy.q));
        w.add(`(u.email ilike ${p} or u.username ilike ${p} or u.display_name ilike ${p} or u.id::text = ${w.param(qy.q.trim())} or u.last_ip = ${w.param(qy.q.trim())})`);
      }
      if (qy.role) w.add('u.role = ?', qy.role);
      if (qy.status === 'deleted') w.add('u.deleted_at is not null');
      else {
        if (qy.status !== 'all') w.add('u.deleted_at is null');
        if (qy.status === 'banned') w.add('u.banned_at is not null');
        if (qy.status === 'active') w.add('u.banned_at is null');
        if (qy.status === 'unverified') w.add('u.email_verified_at is null');
        if (qy.status === 'locked') w.add('u.locked_until > now()');
      }
      const memberSql = `exists (select 1 from subscriptions sb where sb.user_id = u.id and sb.status in ('active','past_due') and sb.current_period_end > now())`;
      if (qy.member === '1') w.add(memberSql);
      if (qy.member === '0') w.add(`not ${memberSql}`);
      if (qy.creator === '1') w.add('exists (select 1 from publisher_members pm where pm.user_id = u.id)');
      const total = (await one<{ n: number }>(`select count(*)::int as n from users u ${w.sql}`, w.values))!.n;
      const items = await q(
        `select u.id, u.email, u.username, u.display_name, u.role, u.email_verified_at, u.totp_enabled, u.last_login_at, u.last_ip,
                u.banned_at, u.ban_reason, u.deleted_at, u.created_at, ${memberSql} as is_member,
                (select count(*) from publisher_members pm where pm.user_id = u.id)::int as brand_count
           from users u ${w.sql}
          order by ${SORTS[qy.sort] ?? SORTS.newest} limit ${limit} offset ${offset}`,
        w.values,
      );
      return { items, total, page, limit };
    });

    s.get('/api/admin/users/:id', async (req) => {
      requireAdmin(req);
      const id = idParam(req);
      const user = await one(
        `select id, email, username, display_name, role, email_verified_at, totp_enabled, avatar_key, bio, prefs, marketing_opt_in,
                last_login_at, last_ip, banned_at, ban_reason, deleted_at, created_at, failed_logins, locked_until, email_unsubscribed_at
           from users where id = $1`,
        [id],
      );
      if (!user) throw notFound('User not found');
      user.avatar_url = await publicUrl(user.avatar_key);
      const [brands, orders, subscriptions, wallet, walletLog, logins, sessions, stats] = await Promise.all([
        q(
          `select p.id, p.slug, p.name, p.kind, m.role, p.verified_at, p.suspended_at
             from publisher_members m join publishers p on p.id = m.publisher_id
            where m.user_id = $1 and p.deleted_at is null order by p.name`,
          [id],
        ),
        q(
          `select o.id, o.status, o.total_cents, o.provider, o.created_at, o.paid_at, o.refunded_at,
                  (select string_agg(i.description, ', ') from order_items i where i.order_id = o.id) as summary
             from orders o where o.user_id = $1 order by o.created_at desc limit 25`,
          [id],
        ),
        q(
          `select id, plan, status, provider, price_cents, current_period_start, current_period_end, cancel_at_period_end, canceled_at, created_at
             from subscriptions where user_id = $1 order by created_at desc limit 20`,
          [id],
        ),
        one('select credit_cents, page_credits, updated_at from wallets where user_id = $1', [id]),
        q('select id, kind, credit_cents, page_credits, note, created_at from wallet_log where user_id = $1 order by created_at desc limit 25', [id]),
        q('select id, ip, user_agent, success, reason, created_at from login_events where user_id = $1 order by created_at desc limit 25', [id]),
        q('select ip, user_agent, created_at, last_seen_at, expires_at from sessions where user_id = $1 and expires_at > now() order by last_seen_at desc', [id]),
        one(
          `select (select count(*) from entitlements where user_id = $1)::int as owned_releases,
                  (select count(*) from comments where user_id = $1 and deleted_at is null)::int as comments,
                  (select count(*) from follows where user_id = $1)::int as follows,
                  (select count(*) from reports r where r.target_kind = 'user' and r.target_id = $1)::int as reports_against,
                  (select coalesce(sum(total_cents),0) from orders where user_id = $1 and status = 'paid')::float8 as spent_cents`,
          [id],
        ),
      ]);
      const active = subscriptions.find((x) => ['active', 'past_due'].includes(x.status) && Date.parse(x.current_period_end) > Date.now());
      return {
        user,
        brands,
        orders,
        membership: { active: Boolean(active), current: active ?? null, history: subscriptions },
        wallet: wallet ?? { credit_cents: 0, page_credits: 0, updated_at: null },
        wallet_log: walletLog,
        logins,
        sessions,
        stats,
      };
    });

    /** Super admin only. The last super admin cannot be demoted. */
    s.post('/api/admin/users/:id/role', async (req) => {
      const actor = requireSuperAdmin(req);
      const id = idParam(req);
      const { role } = parse(z.object({ role: z.enum(['user', 'admin', 'super_admin']) }), req.body);
      const before = await tx(async (db) => {
        const supers = await q<{ id: string }>(`select id from users where role = 'super_admin' and deleted_at is null for update`, [], db);
        const t = await one<{ role: string; email: string; deleted_at: string | null; banned_at: string | null }>(
          'select role, email, deleted_at, banned_at from users where id = $1 for update', [id], db);
        if (!t || t.deleted_at) throw notFound('User not found');
        if (t.role === role) return t;
        if (t.role === 'super_admin' && supers.length <= 1) throw conflict('This is the last super admin. Promote someone else first.');
        if (role !== 'user' && t.banned_at) throw badRequest('Unban this account before giving it a staff role');
        await exec('update users set role = $2 where id = $1', [id, role], db);
        return t;
      });
      if (before.role !== role) audit(req, 'user.role', { kind: 'user', id }, { email: before.email, from: before.role, to: role, self: id === actor.id });
      return { ok: true, role };
    });

    s.post('/api/admin/users/:id/ban', async (req) => {
      const actor = requireAdmin(req);
      const id = idParam(req);
      const { reason } = parse(z.object({ reason: zReason }), req.body);
      await banUser(req, actor, id, reason);
      return { ok: true };
    });

    s.post('/api/admin/users/:id/unban', async (req) => {
      const actor = requireAdmin(req);
      const id = idParam(req);
      const t = await moderationTarget(actor, id);
      await exec('update users set banned_at = null, ban_reason = null, failed_logins = 0, locked_until = null where id = $1', [id]);
      audit(req, 'user.unban', { kind: 'user', id }, { email: t.email });
      return { ok: true };
    });

    /** Ends every session of the user (your own current session is kept). */
    s.post('/api/admin/users/:id/logout', async (req) => {
      const actor = requireAdmin(req);
      const id = idParam(req);
      if (id !== actor.id) await moderationTarget(actor, id);
      const n = await exec('delete from sessions where user_id = $1 and token_hash <> $2', [id, req.sessionHash ?? '']);
      audit(req, 'user.force_logout', { kind: 'user', id }, { sessions: n });
      return { ok: true, sessions_ended: n };
    });

    s.post('/api/admin/users/:id/verify-email', async (req) => {
      requireAdmin(req);
      const id = idParam(req);
      const u = await one<{ email: string }>('update users set email_verified_at = coalesce(email_verified_at, now()) where id = $1 and deleted_at is null returning email', [id]);
      if (!u) throw notFound('User not found');
      audit(req, 'user.verify_email', { kind: 'user', id }, { email: u.email });
      return { ok: true };
    });

    /** Complimentary membership: extends an existing grant, or starts one from now. */
    s.post('/api/admin/users/:id/grant-membership', async (req) => {
      requireAdmin(req);
      const id = idParam(req);
      const body = parse(z.object({ days: z.number().int().min(1).max(3650), note: z.string().trim().max(500).optional() }), req.body);
      const sub = await tx(async (db) => {
        const u = await one('select id from users where id = $1 and deleted_at is null for update', [id], db);
        if (!u) throw notFound('User not found');
        const existing = await one<{ id: string }>(
          `select id from subscriptions where user_id = $1 and provider = 'grant' and status = 'active' and current_period_end > now()
            order by current_period_end desc limit 1 for update`,
          [id], db);
        if (existing) {
          return one(
            `update subscriptions set current_period_end = current_period_end + ($2 || ' days')::interval where id = $1
             returning id, current_period_end`,
            [existing.id, String(body.days)], db);
        }
        return one(
          `insert into subscriptions (user_id, plan, status, provider, price_cents, current_period_start, current_period_end, cancel_at_period_end)
           values ($1, 'monthly', 'active', 'grant', 0, now(), now() + ($2 || ' days')::interval, true)
           returning id, current_period_end`,
          [id, String(body.days)], db);
      });
      audit(req, 'user.grant_membership', { kind: 'user', id }, { days: body.days, note: body.note ?? null, until: sub!.current_period_end });
      return { ok: true, subscription_id: sub!.id, current_period_end: sub!.current_period_end };
    });

    /** Store credit is money, so this is super admin only. Amounts are deltas (may be negative). */
    s.post('/api/admin/users/:id/wallet', async (req) => {
      requireSuperAdmin(req);
      const id = idParam(req);
      const body = parse(
        z.object({
          credit_cents: z.number().int().min(-1_000_000).max(1_000_000).default(0),
          page_credits: z.number().int().min(-100_000).max(100_000).default(0),
          note: z.string().trim().min(3, 'Add a note explaining the adjustment').max(500),
        }),
        req.body,
      );
      if (!body.credit_cents && !body.page_credits) throw badRequest('Enter an amount to add or remove');
      const wallet = await tx(async (db) => {
        if (!(await one('select 1 from users where id = $1', [id], db))) throw notFound('User not found');
        await exec('insert into wallets (user_id) values ($1) on conflict (user_id) do nothing', [id], db);
        const cur = await one<{ credit_cents: number; page_credits: number }>('select credit_cents, page_credits from wallets where user_id = $1 for update', [id], db);
        if (cur!.credit_cents + body.credit_cents < 0) throw badRequest('That would take the store credit below zero');
        if (cur!.page_credits + body.page_credits < 0) throw badRequest('That would take the page credits below zero');
        const w = await one(
          'update wallets set credit_cents = credit_cents + $2, page_credits = page_credits + $3, updated_at = now() where user_id = $1 returning credit_cents, page_credits',
          [id, body.credit_cents, body.page_credits], db);
        await exec(`insert into wallet_log (user_id, kind, credit_cents, page_credits, note) values ($1, 'admin_adjustment', $2, $3, $4)`, [id, body.credit_cents, body.page_credits, body.note], db);
        return w;
      });
      audit(req, 'user.wallet_adjust', { kind: 'user', id }, body);
      return { ok: true, wallet };
    });

    /** Soft delete. `anonymise` also scrubs the profile and frees the email and username. */
    s.delete('/api/admin/users/:id', async (req) => {
      const actor = requireAdmin(req);
      const id = idParam(req);
      const body = parse(z.object({ anonymise: z.boolean().default(false), reason: z.string().trim().max(500).optional() }), req.body ?? {});
      const t = await moderationTarget(actor, id);
      if (t.role === 'super_admin') throw badRequest('Remove the super admin role before deleting this account');
      let avatar: string | null = null;
      await tx(async (db) => {
        await exec('update users set deleted_at = coalesce(deleted_at, now()) where id = $1', [id], db);
        await exec('delete from sessions where user_id = $1', [id], db);
        await exec('delete from email_tokens where user_id = $1', [id], db);
        if (body.anonymise) {
          const tag = id.replace(/-/g, '').slice(-12);
          const r = await one<{ avatar_key: string | null }>('select avatar_key from users where id = $1', [id], db);
          avatar = r?.avatar_key ?? null;
          await exec(
            `update users set email = $2, username = $3, display_name = 'Deleted user', bio = '', avatar_key = null, prefs = '{}',
                    marketing_opt_in = false, last_ip = null, totp_secret = null, totp_enabled = false, totp_backup_codes = '{}', role = 'user'
              where id = $1`,
            [id, `deleted-${tag}@deleted.invalid`, `deleted_${tag}`], db);
        }
      });
      await dropObject(avatar);
      audit(req, 'user.delete', { kind: 'user', id }, { email: t.email, anonymised: body.anonymise, reason: body.reason ?? null });
      return { ok: true };
    });

    s.post('/api/admin/users/:id/restore', async (req) => {
      const actor = requireAdmin(req);
      const id = idParam(req);
      const t = await moderationTarget(actor, id);
      if (!t.deleted_at) return { ok: true };
      if (String(t.email).endsWith('@deleted.invalid')) throw badRequest('This account was anonymised and cannot be restored');
      await exec('update users set deleted_at = null where id = $1', [id]);
      audit(req, 'user.restore', { kind: 'user', id }, { email: t.email });
      return { ok: true };
    });
  });
}
