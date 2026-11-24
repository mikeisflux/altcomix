import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { exec, one, q } from '../db.ts';
import { adminScope, dateRange, idParam, isUuid, like, query, where } from '../lib/admin.ts';
import { audit, notFound, pageParams, parse, requireAdmin } from '../lib/http.ts';

const errorStatus = z.enum(['unresolved', 'resolved', 'ignored']);

export default async function adminLogRoutes(app: FastifyInstance) {
  await adminScope(app, (s) => {
    // ------------------------------------------------------------ audit log
    s.get('/api/admin/audit', async (req) => {
      requireAdmin(req);
      const qy = query(req);
      const { limit, offset, page } = pageParams(req.query, 50, 500);
      const w = where();
      if (isUuid(qy.actor_id)) w.add('a.actor_id = ?', qy.actor_id);
      if (qy.actor) {
        const p = w.param(like(qy.actor));
        w.add(`(u.email ilike ${p} or u.username ilike ${p})`);
      }
      // "settings" matches settings.update, settings.test ...; "settings.update" matches exactly.
      if (qy.action) w.add(qy.action.includes('.') ? 'a.action = ?' : `a.action like ? || '.%'`, qy.action);
      if (qy.target_kind) w.add('a.target_kind = ?', qy.target_kind);
      if (qy.target_id) w.add('a.target_id = ?', qy.target_id);
      if (qy.ip) w.add('a.ip = ?', qy.ip);
      if (qy.q) w.add('a.meta::text ilike ?', like(qy.q));
      dateRange(w, 'a.created_at', qy);
      const from = 'from audit_log a left join users u on u.id = a.actor_id';
      const total = (await one<{ n: number }>(`select count(*)::int as n ${from} ${w.sql}`, w.values))!.n;
      const items = await q(
        `select a.id, a.action, a.target_kind, a.target_id, a.meta, a.ip, a.created_at, a.actor_id, u.username as actor_username, u.email as actor_email, u.role as actor_role
           ${from} ${w.sql} order by a.created_at desc, a.id desc limit ${limit} offset ${offset}`,
        w.values,
      );
      return { items, total, page, limit };
    });

    /** Distinct actions and target kinds, for the filter dropdowns. */
    s.get('/api/admin/audit/facets', async (req) => {
      requireAdmin(req);
      const [actions, kinds] = await Promise.all([
        q<{ action: string; count: number }>('select action, count(*)::int as count from audit_log group by action order by action'),
        q<{ target_kind: string }>('select distinct target_kind from audit_log where target_kind is not null order by 1'),
      ]);
      return { actions, target_kinds: kinds.map((k) => k.target_kind) };
    });

    // ------------------------------------------------------------ error log
    s.get('/api/admin/errors', async (req) => {
      requireAdmin(req);
      const qy = query(req);
      const { limit, offset, page } = pageParams(req.query, 50, 200);
      const w = where();
      if (qy.status !== 'all') w.add('status = ?', qy.status || 'unresolved');
      if (qy.source) w.add('source = ?', qy.source);
      if (qy.level) w.add('level = ?', qy.level);
      if (qy.q) {
        const p = w.param(like(qy.q));
        w.add(`(title ilike ${p} or endpoint ilike ${p} or last_message ilike ${p})`);
      }
      const total = (await one<{ n: number }>(`select count(*)::int as n from error_groups ${w.sql}`, w.values))!.n;
      const items = await q(
        `select id, title, source, endpoint, level, status, event_count, first_seen, last_seen from error_groups ${w.sql}
          order by ${qy.sort === 'count' ? 'event_count desc' : qy.sort === 'first_seen' ? 'first_seen desc' : 'last_seen desc'} limit ${limit} offset ${offset}`,
        w.values,
      );
      const counts = await q('select status, count(*)::int as count from error_groups group by status');
      return { items, total, page, limit, counts: Object.fromEntries(counts.map((c) => [c.status, c.count])) };
    });

    s.get('/api/admin/errors/:id', async (req) => {
      requireAdmin(req);
      const error = await one('select * from error_groups where id = $1', [idParam(req)]);
      if (!error) throw notFound('Error not found');
      return { error };
    });

    /** resolved errors reopen by themselves if they happen again; ignored ones stay quiet. */
    s.post('/api/admin/errors/:id/status', async (req) => {
      requireAdmin(req);
      const id = idParam(req);
      const { status } = parse(z.object({ status: errorStatus }), req.body);
      const e = await one('update error_groups set status = $2 where id = $1 returning title', [id, status]);
      if (!e) throw notFound('Error not found');
      audit(req, 'error.status', { kind: 'error_group', id }, { status, title: e.title });
      return { ok: true, status };
    });

    /** Bulk: `ids`, or `all_with_status` to move every error currently in that state. `delete: true` removes them instead. */
    s.post('/api/admin/errors/bulk', async (req) => {
      requireAdmin(req);
      const body = parse(
        z.object({ ids: z.array(z.uuid()).max(1000).optional(), all_with_status: errorStatus.optional(), status: errorStatus.optional(), delete: z.boolean().default(false) })
          .refine((b) => Boolean(b.ids?.length) !== Boolean(b.all_with_status), 'Send either ids or all_with_status')
          .refine((b) => b.delete || b.status, 'Choose a status'),
        req.body,
      );
      const cond = body.ids?.length ? 'id = any($1::uuid[])' : 'status = $1';
      const arg = body.ids?.length ? body.ids : body.all_with_status;
      const n = body.delete
        ? await exec(`delete from error_groups where ${cond}`, [arg])
        : await exec(`update error_groups set status = $2 where ${cond}`, [arg, body.status]);
      audit(req, body.delete ? 'error.bulk_delete' : 'error.bulk_status', undefined, { count: n, status: body.status ?? null, all_with_status: body.all_with_status ?? null });
      return { ok: true, affected: n };
    });

    // ------------------------------------------------------------ cron runs
    s.get('/api/admin/cron-runs', async (req) => {
      requireAdmin(req);
      const qy = query(req);
      const { limit, offset, page } = pageParams(req.query, 100, 500);
      const w = where();
      if (qy.job) w.add('job = ?', qy.job);
      if (qy.ok === '1') w.add('ok');
      if (qy.ok === '0') w.add('not ok');
      const total = (await one<{ n: number }>(`select count(*)::int as n from cron_runs ${w.sql}`, w.values))!.n;
      const items = await q(
        `select id, job, ok, detail, started_at, finished_at, round(extract(epoch from (finished_at - started_at)) * 1000)::int as ms
           from cron_runs ${w.sql} order by started_at desc limit ${limit} offset ${offset}`,
        w.values,
      );
      const jobs = await q(
        `select job, count(*)::int as runs, count(*) filter (where not ok)::int as failures, max(started_at) as last_run,
                max(started_at) filter (where ok) as last_success
           from cron_runs where started_at > now() - interval '7 days' group by job order by job`,
      );
      return { items, total, page, limit, jobs };
    });
  });
}
