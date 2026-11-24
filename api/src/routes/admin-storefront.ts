import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { exec, one, patch, q, tx } from '../db.ts';
import type { Row } from '../db.ts';
import { CMS_SLUGS, adminScope, dropObject, idParam, like, query, receiveImage, where, zDate } from '../lib/admin.ts';
import { audit, badRequest, conflict, notFound, pageParams, parse, requireAdmin, slugify, uniqueSlug } from '../lib/http.ts';
import { publicUrl } from '../lib/storage.ts';

const SLOTS = ['hero', 'staff_picks', 'spotlight'] as const;

/** Site-relative path or absolute http(s) URL. */
const zLink = z.string().trim().max(500).regex(/^(\/(?!\/)|https?:\/\/)\S*$/, 'Links must start with / or http(s)://');

const featuredBody = z.object({
  slot: z.enum(SLOTS),
  series_id: z.uuid().nullable().optional(),
  headline: z.string().trim().max(160).nullable().optional(),
  blurb: z.string().trim().max(600).optional(),
  url: zLink.nullable().optional(),
  position: z.number().int().min(0).max(10_000).optional(),
  starts_at: zDate.nullable().optional(),
  ends_at: zDate.nullable().optional(),
});

const announcementBody = z.object({
  kind: z.enum(['bar', 'modal']),
  headline: z.string().trim().min(1).max(200),
  body: z.string().trim().max(2000).optional(),
  cta_label: z.string().trim().max(60).nullable().optional(),
  cta_url: zLink.nullable().optional(),
  starts_at: zDate.optional(),
  ends_at: zDate.nullable().optional(),
  active: z.boolean().optional(),
});

const newsBody = z.object({
  title: z.string().trim().min(1).max(200),
  slug: z.string().trim().max(80).optional(),
  excerpt: z.string().trim().max(500).optional(),
  body: z.string().max(200_000),
  published_at: zDate.nullable().optional(),
});

function checkWindow(starts?: string | null, ends?: string | null): void {
  if (starts && ends && Date.parse(ends) <= Date.parse(starts)) throw badRequest('The end must be after the start');
}

async function featuredOut(rows: Row[]): Promise<Row[]> {
  for (const r of rows) {
    r.image_url = await publicUrl(r.image_key);
    r.series_cover_url = await publicUrl(r.series_cover_key);
    r.live = (!r.starts_at || Date.parse(r.starts_at) <= Date.now()) && (!r.ends_at || Date.parse(r.ends_at) > Date.now());
  }
  return rows;
}

const FEATURED_SELECT = `select f.id, f.slot, f.series_id, f.headline, f.blurb, f.url, f.image_key, f.position, f.starts_at, f.ends_at, f.created_at,
         s.title as series_title, s.slug as series_slug, s.cover_key as series_cover_key, s.visibility as series_visibility, s.takedown_at as series_takedown_at
    from featured f left join series s on s.id = f.series_id`;

export default async function adminStorefrontRoutes(app: FastifyInstance) {
  await adminScope(app, (s) => {
    // ------------------------------------------------------------ featured
    s.get('/api/admin/featured', async (req) => {
      requireAdmin(req);
      const slot = query(req).slot;
      const rows = await q(`${FEATURED_SELECT} ${slot ? 'where f.slot = $1' : ''} order by f.slot, f.position, f.created_at`, slot ? [slot] : []);
      return { items: await featuredOut(rows) };
    });

    /**
     * staff_picks and spotlight entries are always a series. A hero entry is a
     * series, or a custom card: headline + url, with the image uploaded afterwards.
     */
    s.post('/api/admin/featured', async (req) => {
      requireAdmin(req);
      const body = parse(featuredBody, req.body);
      checkWindow(body.starts_at, body.ends_at);
      if (body.series_id) {
        const sr = await one('select visibility, takedown_at from series where id = $1 and deleted_at is null', [body.series_id]);
        if (!sr) throw badRequest('That series does not exist');
        if (sr.visibility !== 'public' || sr.takedown_at) throw badRequest('Only public series that are not taken down can be featured');
      } else if (body.slot !== 'hero') {
        throw badRequest('Choose a series for this row');
      } else if (!body.headline || !body.url) {
        throw badRequest('A custom hero card needs a headline and a link');
      }
      const row = await one<{ id: string }>(
        `insert into featured (slot, series_id, headline, blurb, url, position, starts_at, ends_at)
         values ($1, $2, $3, $4, $5, coalesce($6, (select coalesce(max(position), -1) + 1 from featured where slot = $1)), $7, $8) returning id`,
        [body.slot, body.series_id ?? null, body.headline ?? null, body.blurb ?? '', body.url ?? null, body.position ?? null, body.starts_at ?? null, body.ends_at ?? null],
      );
      audit(req, 'featured.create', { kind: 'featured', id: row!.id }, { slot: body.slot, series_id: body.series_id ?? null, headline: body.headline ?? null });
      return { ok: true, item: (await featuredOut(await q(`${FEATURED_SELECT} where f.id = $1`, [row!.id])))[0] };
    });

    s.patch('/api/admin/featured/:id', async (req) => {
      requireAdmin(req);
      const id = idParam(req);
      const body = parse(featuredBody.partial(), req.body);
      const cur = await one('select * from featured where id = $1', [id]);
      if (!cur) throw notFound('Featured item not found');
      const next = { ...cur, ...body };
      checkWindow(next.starts_at && new Date(next.starts_at).toISOString(), next.ends_at && new Date(next.ends_at).toISOString());
      if (!next.series_id && next.slot !== 'hero') throw badRequest('Choose a series for this row');
      if (!next.series_id && (!next.headline || !next.url)) throw badRequest('A custom hero card needs a headline and a link');
      if (body.series_id && !(await one(`select 1 from series where id = $1 and deleted_at is null and visibility = 'public' and takedown_at is null`, [body.series_id]))) {
        throw badRequest('Only public series that are not taken down can be featured');
      }
      const { sets, values } = patch(body, ['slot', 'series_id', 'headline', 'blurb', 'url', 'position', 'starts_at', 'ends_at'], 2);
      if (sets.length) await exec(`update featured set ${sets.join(', ')} where id = $1`, [id, ...values]);
      audit(req, 'featured.update', { kind: 'featured', id }, { fields: Object.keys(body) });
      return { ok: true, item: (await featuredOut(await q(`${FEATURED_SELECT} where f.id = $1`, [id])))[0] };
    });

    /** Set the order of a slot: `ids` lists every item in the order it should appear. */
    s.post('/api/admin/featured/reorder', async (req) => {
      requireAdmin(req);
      const body = parse(z.object({ slot: z.enum(SLOTS), ids: z.array(z.uuid()).min(1).max(200) }), req.body);
      await tx(async (db) => {
        for (let i = 0; i < body.ids.length; i++) await exec('update featured set position = $3 where id = $1 and slot = $2', [body.ids[i], body.slot, i], db);
      });
      audit(req, 'featured.reorder', { kind: 'featured', id: body.slot }, { count: body.ids.length });
      return { ok: true };
    });

    /** multipart/form-data, field "file". Stored under public/featured/. */
    s.post('/api/admin/featured/:id/image', async (req) => {
      requireAdmin(req);
      const id = idParam(req);
      const cur = await one<{ image_key: string | null }>('select image_key from featured where id = $1', [id]);
      if (!cur) throw notFound('Featured item not found');
      const key = await receiveImage(req, 'featured', id, 2400);
      await exec('update featured set image_key = $2 where id = $1', [id, key]);
      await dropObject(cur.image_key);
      audit(req, 'featured.image', { kind: 'featured', id });
      return { ok: true, image_key: key, image_url: await publicUrl(key) };
    });

    s.delete('/api/admin/featured/:id', async (req) => {
      requireAdmin(req);
      const id = idParam(req);
      const cur = await one('delete from featured where id = $1 returning image_key, slot, series_id, headline', [id]);
      if (!cur) throw notFound('Featured item not found');
      await dropObject(cur.image_key);
      audit(req, 'featured.delete', { kind: 'featured', id }, { slot: cur.slot, series_id: cur.series_id, headline: cur.headline });
      return { ok: true };
    });

    // ------------------------------------------------------------ announcements
    s.get('/api/admin/announcements', async (req) => {
      requireAdmin(req);
      const items = await q(
        `select id, kind, headline, body, cta_label, cta_url, image_key, starts_at, ends_at, active, created_at,
                (active and starts_at <= now() and (ends_at is null or ends_at > now())) as live
           from announcements order by created_at desc limit 200`,
      );
      for (const a of items) a.image_url = await publicUrl(a.image_key);
      return { items };
    });

    s.post('/api/admin/announcements', async (req) => {
      requireAdmin(req);
      const body = parse(announcementBody, req.body);
      checkWindow(body.starts_at, body.ends_at);
      if (Boolean(body.cta_label) !== Boolean(body.cta_url)) throw badRequest('A button needs both a label and a link');
      const row = await one(
        `insert into announcements (kind, headline, body, cta_label, cta_url, starts_at, ends_at, active)
         values ($1,$2,$3,$4,$5,coalesce($6, now()),$7,$8) returning *`,
        [body.kind, body.headline, body.body ?? '', body.cta_label ?? null, body.cta_url ?? null, body.starts_at ?? null, body.ends_at ?? null, body.active ?? true],
      );
      audit(req, 'announcement.create', { kind: 'announcement', id: row!.id }, { kind: body.kind, headline: body.headline });
      return { ok: true, item: { ...row, image_url: null } };
    });

    s.patch('/api/admin/announcements/:id', async (req) => {
      requireAdmin(req);
      const id = idParam(req);
      const body = parse(announcementBody.partial(), req.body);
      const cur = await one('select * from announcements where id = $1', [id]);
      if (!cur) throw notFound('Announcement not found');
      const next = { ...cur, ...body };
      checkWindow(new Date(next.starts_at).toISOString(), next.ends_at && new Date(next.ends_at).toISOString());
      if (Boolean(next.cta_label) !== Boolean(next.cta_url)) throw badRequest('A button needs both a label and a link');
      const { sets, values } = patch(body, ['kind', 'headline', 'body', 'cta_label', 'cta_url', 'starts_at', 'ends_at', 'active'], 2);
      const row = sets.length ? await one(`update announcements set ${sets.join(', ')} where id = $1 returning *`, [id, ...values]) : cur;
      audit(req, 'announcement.update', { kind: 'announcement', id }, { fields: Object.keys(body) });
      return { ok: true, item: { ...row, image_url: await publicUrl(row!.image_key) } };
    });

    s.post('/api/admin/announcements/:id/image', async (req) => {
      requireAdmin(req);
      const id = idParam(req);
      const cur = await one<{ image_key: string | null }>('select image_key from announcements where id = $1', [id]);
      if (!cur) throw notFound('Announcement not found');
      const key = await receiveImage(req, 'announcements', id, 1600);
      await exec('update announcements set image_key = $2 where id = $1', [id, key]);
      await dropObject(cur.image_key);
      audit(req, 'announcement.image', { kind: 'announcement', id });
      return { ok: true, image_key: key, image_url: await publicUrl(key) };
    });

    s.delete('/api/admin/announcements/:id', async (req) => {
      requireAdmin(req);
      const id = idParam(req);
      const cur = await one('delete from announcements where id = $1 returning image_key, headline', [id]);
      if (!cur) throw notFound('Announcement not found');
      await dropObject(cur.image_key);
      audit(req, 'announcement.delete', { kind: 'announcement', id }, { headline: cur.headline });
      return { ok: true };
    });

    // ------------------------------------------------------------ CMS pages
    s.get('/api/admin/pages', async (req) => {
      requireAdmin(req);
      const rows = await q(
        `select p.slug, p.title, length(p.body) as length, p.updated_at, u.username as updated_by_username
           from cms_pages p left join users u on u.id = p.updated_by where p.slug = any($1::text[])`,
        [CMS_SLUGS],
      );
      const bySlug = new Map(rows.map((r) => [r.slug, r]));
      return { items: CMS_SLUGS.map((slug) => bySlug.get(slug) ?? { slug, title: '', length: 0, updated_at: null, updated_by_username: null }) };
    });

    s.get('/api/admin/pages/:slug', async (req) => {
      requireAdmin(req);
      const slug = (req.params as { slug: string }).slug;
      if (!CMS_SLUGS.includes(slug)) throw notFound('Page not found');
      const page = await one('select slug, title, body, updated_at from cms_pages where slug = $1', [slug]);
      return { page: page ?? { slug, title: '', body: '', updated_at: null } };
    });

    /** Body is Markdown. */
    s.put('/api/admin/pages/:slug', async (req) => {
      const actor = requireAdmin(req);
      const slug = (req.params as { slug: string }).slug;
      if (!CMS_SLUGS.includes(slug)) throw notFound('Page not found');
      const body = parse(z.object({ title: z.string().trim().min(1).max(200), body: z.string().max(300_000) }), req.body);
      const before = await one<{ title: string; length: number }>('select title, length(body) as length from cms_pages where slug = $1', [slug]);
      const page = await one(
        `insert into cms_pages (slug, title, body, updated_by) values ($1,$2,$3,$4)
         on conflict (slug) do update set title = excluded.title, body = excluded.body, updated_by = excluded.updated_by, updated_at = now()
         returning slug, title, body, updated_at`,
        [slug, body.title, body.body, actor.id],
      );
      audit(req, 'page.update', { kind: 'cms_page', id: slug }, { title: body.title, length_from: before?.length ?? 0, length_to: body.body.length });
      return { ok: true, page };
    });

    // ------------------------------------------------------------ news
    s.get('/api/admin/news', async (req) => {
      requireAdmin(req);
      const qy = query(req);
      const { limit, offset, page } = pageParams(req.query, 50, 200);
      const w = where();
      if (qy.q) w.add('n.title ilike ?', like(qy.q));
      if (qy.status === 'draft') w.add('n.published_at is null');
      if (qy.status === 'scheduled') w.add('n.published_at > now()');
      if (qy.status === 'published') w.add('n.published_at <= now()');
      const total = (await one<{ n: number }>(`select count(*)::int as n from news_posts n ${w.sql}`, w.values))!.n;
      const items = await q(
        `select n.id, n.slug, n.title, n.excerpt, n.cover_key, n.published_at, n.created_at, u.username as author_username
           from news_posts n left join users u on u.id = n.author_id ${w.sql}
          order by coalesce(n.published_at, n.created_at) desc limit ${limit} offset ${offset}`,
        w.values,
      );
      for (const n of items) n.cover_url = await publicUrl(n.cover_key);
      return { items, total, page, limit };
    });

    s.get('/api/admin/news/:id', async (req) => {
      requireAdmin(req);
      const post = await one('select * from news_posts where id = $1', [idParam(req)]);
      if (!post) throw notFound('Post not found');
      post.cover_url = await publicUrl(post.cover_key);
      return { post };
    });

    /** `published_at`: null keeps it a draft, a future time schedules it. Body is Markdown. */
    s.post('/api/admin/news', async (req) => {
      const actor = requireAdmin(req);
      const body = parse(newsBody, req.body);
      const slug = await uniqueSlug('news_posts', body.slug || body.title);
      const post = await one(
        `insert into news_posts (slug, title, excerpt, body, author_id, published_at) values ($1,$2,$3,$4,$5,$6) returning *`,
        [slug, body.title, body.excerpt ?? '', body.body, actor.id, body.published_at ?? null],
      );
      audit(req, 'news.create', { kind: 'news_post', id: post!.id }, { title: body.title, slug, published_at: body.published_at ?? null });
      return { ok: true, post: { ...post, cover_url: null } };
    });

    s.patch('/api/admin/news/:id', async (req) => {
      requireAdmin(req);
      const id = idParam(req);
      const body = parse(newsBody.partial(), req.body);
      const cur = await one('select slug from news_posts where id = $1', [id]);
      if (!cur) throw notFound('Post not found');
      if (body.slug !== undefined) {
        body.slug = slugify(body.slug);
        if (body.slug !== cur.slug && (await one('select 1 from news_posts where slug = $1 and id <> $2', [body.slug, id]))) throw conflict('Another post already uses that URL');
      }
      const { sets, values } = patch(body, ['title', 'slug', 'excerpt', 'body', 'published_at'], 2);
      const post = sets.length ? await one(`update news_posts set ${sets.join(', ')} where id = $1 returning *`, [id, ...values]) : await one('select * from news_posts where id = $1', [id]);
      audit(req, 'news.update', { kind: 'news_post', id }, { fields: Object.keys(body) });
      return { ok: true, post: { ...post, cover_url: await publicUrl(post!.cover_key) } };
    });

    s.post('/api/admin/news/:id/cover', async (req) => {
      requireAdmin(req);
      const id = idParam(req);
      const cur = await one<{ cover_key: string | null }>('select cover_key from news_posts where id = $1', [id]);
      if (!cur) throw notFound('Post not found');
      const key = await receiveImage(req, 'news', id, 2000);
      await exec('update news_posts set cover_key = $2 where id = $1', [id, key]);
      await dropObject(cur.cover_key);
      audit(req, 'news.cover', { kind: 'news_post', id });
      return { ok: true, cover_key: key, cover_url: await publicUrl(key) };
    });

    s.delete('/api/admin/news/:id', async (req) => {
      requireAdmin(req);
      const id = idParam(req);
      const cur = await one('delete from news_posts where id = $1 returning cover_key, title', [id]);
      if (!cur) throw notFound('Post not found');
      await dropObject(cur.cover_key);
      audit(req, 'news.delete', { kind: 'news_post', id }, { title: cur.title });
      return { ok: true };
    });

    // ------------------------------------------------------------ feedback
    s.get('/api/admin/feedback', async (req) => {
      requireAdmin(req);
      const qy = query(req);
      const { limit, offset, page } = pageParams(req.query, 50, 200);
      const w = where();
      if (qy.status && qy.status !== 'all') w.add('f.status = ?', qy.status);
      if (qy.category) w.add('f.category = ?', qy.category);
      if (qy.q) {
        const p = w.param(like(qy.q));
        w.add(`(f.body ilike ${p} or f.email ilike ${p})`);
      }
      const total = (await one<{ n: number }>(`select count(*)::int as n from feedback f ${w.sql}`, w.values))!.n;
      const items = await q(
        `select f.id, f.category, f.body, f.page_url, f.status, f.created_at, f.user_id, coalesce(f.email, u.email) as email, u.username
           from feedback f left join users u on u.id = f.user_id ${w.sql}
          order by f.created_at desc limit ${limit} offset ${offset}`,
        w.values,
      );
      const counts = await q('select status, count(*)::int as count from feedback group by status');
      return { items, total, page, limit, counts: Object.fromEntries(counts.map((c) => [c.status, c.count])) };
    });

    s.post('/api/admin/feedback/:id/status', async (req) => {
      requireAdmin(req);
      const id = idParam(req);
      const { status } = parse(z.object({ status: z.enum(['new', 'read', 'resolved']) }), req.body);
      if (!(await exec('update feedback set status = $2 where id = $1', [id, status]))) throw notFound('Feedback not found');
      audit(req, 'feedback.status', { kind: 'feedback', id }, { status });
      return { ok: true, status };
    });
  });
}
