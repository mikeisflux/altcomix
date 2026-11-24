import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { exec, one, q } from '../db.ts';
import type { Row } from '../db.ts';
import { adminScope, banUser, idParam, isUuid, like, query, takedownSeries, tellBrand, where, zReason } from '../lib/admin.ts';
import { audit, badRequest, notFound, pageParams, parse, requireAdmin } from '../lib/http.ts';
import { publicUrl } from '../lib/storage.ts';

/** Attach a short description of what each report points at. */
async function describeTargets(reports: Row[]): Promise<void> {
  const ids = (kind: string) => reports.filter((r) => r.target_kind === kind).map((r) => r.target_id);
  const [series, releases, comments, publishers, users, posts, threads] = await Promise.all([
    q(`select id, title, slug, takedown_at, publisher_id from series where id = any($1::uuid[])`, [ids('series')]),
    q(`select r.id, r.title, r.series_id, s.title as series_title, s.slug as series_slug, s.takedown_at
         from releases r join series s on s.id = r.series_id where r.id = any($1::uuid[])`, [ids('release')]),
    q(`select c.id, c.body, c.hidden_at, c.deleted_at, c.series_id, c.user_id, u.username, s.title as series_title
         from comments c join users u on u.id = c.user_id join series s on s.id = c.series_id where c.id = any($1::uuid[])`, [ids('comment')]),
    q(`select id, name, slug, suspended_at from publishers where id = any($1::uuid[])`, [ids('publisher')]),
    q(`select id, username, email, banned_at from users where id = any($1::uuid[])`, [ids('user')]),
    q(`select fp.id, fp.body, fp.deleted_at, fp.thread_id, fp.user_id, u.username, t.title as thread_title
         from forum_posts fp join users u on u.id = fp.user_id join forum_threads t on t.id = fp.thread_id where fp.id = any($1::uuid[])`, [ids('forum_post')]),
    q(`select t.id, t.title, t.deleted_at, t.user_id, u.username
         from forum_threads t join users u on u.id = t.user_id where t.id = any($1::uuid[])`, [ids('forum_thread')]),
  ]);
  const maps: Record<string, Map<string, Row>> = {
    series: new Map(series.map((x) => [x.id, { label: x.title, url: `/series/${x.slug}`, ...x }])),
    release: new Map(releases.map((x) => [x.id, { label: `${x.series_title}: ${x.title}`, url: `/read/${x.id}`, ...x }])),
    comment: new Map(comments.map((x) => [x.id, { label: `Comment by @${x.username} on ${x.series_title}`, ...x, body: String(x.body).slice(0, 600) }])),
    publisher: new Map(publishers.map((x) => [x.id, { label: x.name, url: `/b/${x.slug}`, ...x }])),
    forum_post: new Map(posts.map((x) => [x.id, { label: `Forum post by @${x.username} in “${x.thread_title}”`, url: `/forums/thread/${x.thread_id}`, ...x, body: String(x.body).slice(0, 600) }])),
    forum_thread: new Map(threads.map((x) => [x.id, { label: `Forum thread “${x.title}” by @${x.username}`, url: `/forums/thread/${x.id}`, ...x }])),
    user: new Map(users.map((x) => [x.id, { label: `@${x.username}`, ...x }])),
  };
  for (const r of reports) r.target = maps[r.target_kind]?.get(r.target_id) ?? null;
}

export default async function adminCatalogueRoutes(app: FastifyInstance) {
  await adminScope(app, (s) => {
    // ------------------------------------------------------------ series
    s.get('/api/admin/series', async (req) => {
      requireAdmin(req);
      const qy = query(req);
      const { limit, offset, page } = pageParams(req.query, 50, 200);
      const w = where();
      w.add('s.deleted_at is null');
      if (qy.q) {
        const p = w.param(like(qy.q));
        w.add(`(s.title ilike ${p} or s.slug ilike ${p} or p.name ilike ${p})`);
      }
      if (qy.visibility) w.add('s.visibility = ?', qy.visibility);
      if (qy.access_model) w.add('s.access_model = ?', qy.access_model);
      if (qy.type) w.add('s.type = ?', qy.type);
      if (isUuid(qy.publisher_id)) w.add('s.publisher_id = ?', qy.publisher_id);
      if (qy.mature === '1') w.add('s.mature');
      if (qy.mature === '0') w.add('not s.mature');
      if (qy.takedown === '1') w.add('s.takedown_at is not null');
      if (qy.takedown === '0') w.add('s.takedown_at is null');
      if (qy.featured === '1') w.add('exists (select 1 from featured f where f.series_id = s.id)');
      if (qy.reported === '1') w.add(`exists (select 1 from reports r where r.target_kind = 'series' and r.target_id = s.id and r.status = 'open')`);
      const from = 'from series s join publishers p on p.id = s.publisher_id';
      const total = (await one<{ n: number }>(`select count(*)::int as n ${from} ${w.sql}`, w.values))!.n;
      const items = await q(
        `select s.id, s.slug, s.title, s.type, s.visibility, s.access_model, s.mature, s.cover_key, s.takedown_at, s.takedown_reason,
                s.follower_count, s.read_count, s.created_at, s.updated_at, s.publisher_id, p.name as publisher_name, p.slug as publisher_slug,
                (select count(*) from releases r where r.series_id = s.id and r.deleted_at is null and r.status = 'published')::int as release_count,
                (select count(*) from reports r where r.target_kind = 'series' and r.target_id = s.id and r.status = 'open')::int as open_reports,
                coalesce((select array_agg(distinct f.slot) from featured f where f.series_id = s.id), '{}') as featured_slots
           ${from} ${w.sql}
          order by ${qy.sort === 'reads' ? 's.read_count desc' : qy.sort === 'title' ? 'lower(s.title)' : qy.sort === 'updated' ? 's.updated_at desc' : 's.created_at desc'}
          limit ${limit} offset ${offset}`,
        w.values,
      );
      for (const it of items) it.cover_url = await publicUrl(it.cover_key);
      return { items, total, page, limit };
    });

    s.post('/api/admin/series/:id/takedown', async (req) => {
      requireAdmin(req);
      const id = idParam(req);
      const { reason } = parse(z.object({ reason: zReason }), req.body);
      await takedownSeries(req, id, reason);
      return { ok: true };
    });

    s.post('/api/admin/series/:id/restore', async (req) => {
      requireAdmin(req);
      const id = idParam(req);
      const sr = await one(
        `update series set takedown_at = null, takedown_reason = null, updated_at = now()
          where id = $1 and deleted_at is null and takedown_at is not null returning title, publisher_id`,
        [id],
      );
      if (!sr) throw notFound('Series not found or not taken down');
      await tellBrand(sr.publisher_id, 'moderation', `"${sr.title}" has been restored`, 'The takedown on this series has been lifted and it is visible again.', `/studio/series/${id}`);
      audit(req, 'series.restore', { kind: 'series', id }, { title: sr.title });
      return { ok: true };
    });

    s.post('/api/admin/series/:id/mature', async (req) => {
      requireAdmin(req);
      const id = idParam(req);
      const { mature } = parse(z.object({ mature: z.boolean() }), req.body);
      const sr = await one('update series set mature = $2, updated_at = now() where id = $1 and deleted_at is null returning title, publisher_id', [id, mature]);
      if (!sr) throw notFound('Series not found');
      if (mature) await tellBrand(sr.publisher_id, 'moderation', `"${sr.title}" now has an 18+ label`, 'We added the 18+ label to this series so it is shown to readers who have confirmed their age. This is a label, not a penalty: the series stays in the store and in search for adult readers.', `/studio/series/${id}`);
      audit(req, 'series.mature', { kind: 'series', id }, { title: sr.title, mature });
      return { ok: true, mature };
    });

    /** Quick toggle from the series list; full control is under /api/admin/featured. */
    s.post('/api/admin/series/:id/feature', async (req) => {
      requireAdmin(req);
      const id = idParam(req);
      const body = parse(z.object({ slot: z.enum(['hero', 'staff_picks', 'spotlight']).default('staff_picks'), featured: z.boolean() }), req.body);
      const sr = await one('select title, visibility, takedown_at from series where id = $1 and deleted_at is null', [id]);
      if (!sr) throw notFound('Series not found');
      if (body.featured) {
        if (sr.visibility !== 'public' || sr.takedown_at) throw badRequest('Only public series that are not taken down can be featured');
        if (!(await one('select 1 from featured where series_id = $1 and slot = $2', [id, body.slot]))) {
          await exec(
            `insert into featured (slot, series_id, position)
             values ($1, $2, (select coalesce(max(position), -1) + 1 from featured where slot = $1))`,
            [body.slot, id],
          );
        }
      } else {
        await exec('delete from featured where series_id = $1 and slot = $2', [id, body.slot]);
      }
      audit(req, body.featured ? 'series.feature' : 'series.unfeature', { kind: 'series', id }, { title: sr.title, slot: body.slot });
      return { ok: true };
    });

    // ------------------------------------------------------------ reports
    s.get('/api/admin/reports', async (req) => {
      requireAdmin(req);
      const qy = query(req);
      const { limit, offset, page } = pageParams(req.query, 50, 200);
      const w = where();
      if (qy.status !== 'all') w.add('r.status = ?', qy.status || 'open');
      if (qy.target_kind) w.add('r.target_kind = ?', qy.target_kind);
      if (isUuid(qy.target_id)) w.add('r.target_id = ?', qy.target_id);
      const total = (await one<{ n: number }>(`select count(*)::int as n from reports r ${w.sql}`, w.values))!.n;
      const items = await q(
        `select r.id, r.target_kind, r.target_id, r.reason, r.detail, r.status, r.created_at, r.resolved_at,
                r.reporter_id, ru.username as reporter_username, r.resolved_by, au.username as resolved_by_username,
                (select count(*) from reports o where o.target_kind = r.target_kind and o.target_id = r.target_id and o.status = 'open')::int as open_on_target
           from reports r left join users ru on ru.id = r.reporter_id left join users au on au.id = r.resolved_by
           ${w.sql} order by r.created_at ${qy.status && qy.status !== 'open' ? 'desc' : 'asc'} limit ${limit} offset ${offset}`,
        w.values,
      );
      await describeTargets(items);
      return { items, total, page, limit };
    });

    /**
     * Close a report. With decision "action" the listed steps run first:
     * hide_comment (comment reports), takedown_series (series / release /
     * comment reports), ban_user (user reports, or the comment's author),
     * suspend_brand (publisher reports).
     */
    s.post('/api/admin/reports/:id/resolve', async (req) => {
      const actor = requireAdmin(req);
      const id = idParam(req);
      const body = parse(
        z.object({
          decision: z.enum(['action', 'dismiss']),
          hide_comment: z.boolean().default(false),
          delete_forum_item: z.boolean().default(false),
          takedown_series: z.boolean().default(false),
          ban_user: z.boolean().default(false),
          suspend_brand: z.boolean().default(false),
          reason: z.string().trim().max(1000).optional(),
          close_same_target: z.boolean().default(true),
        }),
        req.body,
      );
      const r = await one('select * from reports where id = $1', [id]);
      if (!r) throw notFound('Report not found');
      if (r.status !== 'open') throw badRequest('This report is already closed');
      const done: string[] = [];
      if (body.decision === 'action') {
        const wantsStep = body.hide_comment || body.delete_forum_item || body.takedown_series || body.ban_user || body.suspend_brand;
        const reason = body.reason || `Reported: ${r.reason}`;
        if ((body.takedown_series || body.ban_user || body.suspend_brand) && reason.length < 3) throw badRequest('Give a reason');
        const via = { report_id: id };
        let comment: Row | null = null;
        if (r.target_kind === 'comment') comment = await one('select id, user_id, series_id from comments where id = $1', [r.target_id]);

        if (body.hide_comment) {
          if (!comment) throw badRequest('This report is not about a comment that still exists');
          await exec('update comments set hidden_at = coalesce(hidden_at, now()) where id = $1', [comment.id]);
          audit(req, 'comment.hide', { kind: 'comment', id: comment.id }, via);
          done.push('comment_hidden');
        }
        let forumAuthor: string | null = null;
        if (r.target_kind === 'forum_post') forumAuthor = (await one<{ user_id: string }>('select user_id from forum_posts where id = $1', [r.target_id]))?.user_id ?? null;
        if (r.target_kind === 'forum_thread') forumAuthor = (await one<{ user_id: string }>('select user_id from forum_threads where id = $1', [r.target_id]))?.user_id ?? null;
        if (body.delete_forum_item) {
          if (r.target_kind === 'forum_post') {
            const n = await exec('update forum_posts set deleted_at = coalesce(deleted_at, now()) where id = $1', [r.target_id]);
            if (!n) throw badRequest('That forum post no longer exists');
            audit(req, 'forum_post.delete', { kind: 'forum_post', id: r.target_id }, via);
            done.push('forum_post_deleted');
          } else if (r.target_kind === 'forum_thread') {
            const n = await exec('update forum_threads set deleted_at = coalesce(deleted_at, now()) where id = $1', [r.target_id]);
            if (!n) throw badRequest('That forum thread no longer exists');
            audit(req, 'forum_thread.delete', { kind: 'forum_thread', id: r.target_id }, via);
            done.push('forum_thread_deleted');
          } else throw badRequest('This report is not about a forum post or thread');
        }
        if (body.takedown_series) {
          const seriesId =
            r.target_kind === 'series' ? r.target_id
            : r.target_kind === 'release' ? (await one<{ series_id: string }>('select series_id from releases where id = $1', [r.target_id]))?.series_id
            : comment?.series_id;
          if (!seriesId) throw badRequest('This report does not point at a series');
          await takedownSeries(req, seriesId, reason, via);
          done.push('series_taken_down');
        }
        if (body.ban_user) {
          const userId = r.target_kind === 'user' ? r.target_id : (comment?.user_id ?? forumAuthor);
          if (!userId) throw badRequest('This report does not point at a user');
          await banUser(req, actor, userId, reason, via);
          done.push('user_banned');
        }
        if (body.suspend_brand) {
          if (r.target_kind !== 'publisher') throw badRequest('This report does not point at a brand');
          const b = await one('update publishers set suspended_at = now(), suspend_reason = $2 where id = $1 and deleted_at is null returning name', [r.target_id, reason]);
          if (!b) throw notFound('Brand not found');
          await tellBrand(r.target_id, 'moderation', `${b.name} has been suspended`, `Reason: ${reason} Contact support if you think this is a mistake.`, `/studio/brand/${r.target_id}/settings`);
          audit(req, 'brand.suspend', { kind: 'publisher', id: r.target_id }, { name: b.name, reason, ...via });
          done.push('brand_suspended');
        }
        if (!wantsStep) done.push('noted');
      }
      const status = body.decision === 'action' ? 'actioned' : 'dismissed';
      const closed = await exec(
        `update reports set status = $2, resolved_by = $3, resolved_at = now()
          where status = 'open' and (id = $1 or ($4 and target_kind = $5 and target_id = $6))`,
        [id, status, actor.id, body.close_same_target, r.target_kind, r.target_id],
      );
      audit(req, `report.${status}`, { kind: 'report', id }, { target_kind: r.target_kind, target_id: r.target_id, steps: done, closed });
      return { ok: true, status, steps: done, closed };
    });

    // ------------------------------------------------------------ comments
    s.get('/api/admin/comments', async (req) => {
      requireAdmin(req);
      const qy = query(req);
      const { limit, offset, page } = pageParams(req.query, 50, 200);
      const w = where();
      if (qy.q) w.add('c.body ilike ?', like(qy.q));
      if (isUuid(qy.series_id)) w.add('c.series_id = ?', qy.series_id);
      if (isUuid(qy.user_id)) w.add('c.user_id = ?', qy.user_id);
      if (qy.status === 'hidden') w.add('c.hidden_at is not null and c.deleted_at is null');
      else if (qy.status === 'deleted') w.add('c.deleted_at is not null');
      else if (qy.status === 'visible') w.add('c.hidden_at is null and c.deleted_at is null');
      else if (qy.status === 'reported') w.add(`exists (select 1 from reports r where r.target_kind = 'comment' and r.target_id = c.id and r.status = 'open')`);
      const total = (await one<{ n: number }>(`select count(*)::int as n from comments c ${w.sql}`, w.values))!.n;
      const items = await q(
        `select c.id, c.body, c.created_at, c.hidden_at, c.deleted_at, c.parent_id, c.release_id, c.series_id, s.title as series_title, s.slug as series_slug,
                c.user_id, u.username, u.banned_at as user_banned_at,
                (select count(*) from reports r where r.target_kind = 'comment' and r.target_id = c.id and r.status = 'open')::int as open_reports
           from comments c join users u on u.id = c.user_id join series s on s.id = c.series_id
           ${w.sql} order by c.created_at desc limit ${limit} offset ${offset}`,
        w.values,
      );
      return { items, total, page, limit };
    });

    s.post('/api/admin/comments/:id/hide', async (req) => {
      requireAdmin(req);
      const id = idParam(req);
      const { hidden } = parse(z.object({ hidden: z.boolean().default(true) }), req.body ?? {});
      const c = await one('update comments set hidden_at = case when $2 then coalesce(hidden_at, now()) else null end where id = $1 returning id', [id, hidden]);
      if (!c) throw notFound('Comment not found');
      audit(req, hidden ? 'comment.hide' : 'comment.unhide', { kind: 'comment', id });
      return { ok: true, hidden };
    });

    s.delete('/api/admin/comments/:id', async (req) => {
      requireAdmin(req);
      const id = idParam(req);
      const c = await one('update comments set deleted_at = coalesce(deleted_at, now()) where id = $1 returning user_id', [id]);
      if (!c) throw notFound('Comment not found');
      audit(req, 'comment.delete', { kind: 'comment', id }, { user_id: c.user_id });
      return { ok: true };
    });
  });
}
