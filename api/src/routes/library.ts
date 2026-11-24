import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { exec, one, q, tx } from '../db.ts';
import type { Row } from '../db.ts';
import { rateLimit } from '../lib/botblock.ts';
import { HttpError, notFound, pageParams, parse, requireUser } from '../lib/http.ts';
import { notify } from '../lib/notify.ts';
import { publicUrl } from '../lib/storage.ts';
import { assertViewable, cards, continueReading, findPublisher, findSeries } from './catalog.ts';

/** Releases the reader owns for good (bought, redeemed or granted). */
async function owned(userId: string, opts: { downloads: boolean; limit: number; offset: number }): Promise<{ items: Row[]; total: number }> {
  const where = `e.user_id = $1 and r.deleted_at is null and s.deleted_at is null and (s.takedown_at is null or not s.takedown_purge) and ($2 = false or e.can_download)`;
  const from = `from entitlements e join releases r on r.id = e.release_id join series s on s.id = r.series_id join publishers p on p.id = s.publisher_id where ${where}`;
  const rows = await q(
    `select e.source, e.can_download, e.created_at as acquired_at, e.order_id, r.id as release_id, r.number, r.kind, r.title, r.page_count, r.cover_key as release_cover_key, r.status,
            s.id as series_id, s.slug, s.title as series_title, s.cover_key, p.slug as publisher_slug, p.name as publisher_name
       ${from} order by e.created_at desc, r.number limit ${opts.limit} offset ${opts.offset}`,
    [userId, opts.downloads],
  );
  const total = await one<{ n: number }>(`select count(*)::int as n ${from}`, [userId, opts.downloads]);
  return {
    total: total?.n ?? 0,
    items: await Promise.all(rows.map(async (r) => ({
      release: { id: r.release_id, number: r.number, kind: r.kind, title: r.title, page_count: r.page_count, cover_url: await publicUrl(r.release_cover_key ?? r.cover_key), published: r.status === 'published' },
      series: { id: r.series_id, slug: r.slug, title: r.series_title, cover_url: await publicUrl(r.cover_key), publisher: { slug: r.publisher_slug, name: r.publisher_name } },
      source: r.source, can_download: r.can_download, download_url: r.can_download ? `/api/releases/${r.release_id}/download` : null, acquired_at: r.acquired_at, order_id: r.order_id,
    }))),
  };
}

const following = (req: FastifyRequest, limit: number, offset = 0) =>
  cards(req, 'exists (select 1 from follows f where f.user_id = $1 and f.series_id = s.id)', [req.user!.id], `order by lr.published_at desc nulls last limit ${limit} offset ${offset}`);
const favorites = (req: FastifyRequest, limit: number, offset = 0) =>
  cards(req, 'exists (select 1 from favorites f where f.user_id = $1 and f.series_id = s.id)', [req.user!.id], `order by s.title limit ${limit} offset ${offset}`);

async function brandsFollowed(userId: string): Promise<Row[]> {
  const rows = await q(
    `select p.id, p.slug, p.name, p.kind, p.avatar_key, f.created_at from publisher_follows f join publishers p on p.id = f.publisher_id
      where f.user_id = $1 and p.deleted_at is null and p.suspended_at is null order by f.created_at desc`,
    [userId],
  );
  return Promise.all(rows.map(async (b) => ({ id: b.id, slug: b.slug, name: b.name, kind: b.kind, avatar_url: await publicUrl(b.avatar_key), followed_at: b.created_at })));
}

export default async function libraryRoutes(app: FastifyInstance) {
  /** Library landing: a first page of every shelf. */
  app.get('/api/library', async (req) => {
    const u = requireUser(req);
    const [cont, own, down, fol, fav, brands, counts] = await Promise.all([
      continueReading(req, 12), owned(u.id, { downloads: false, limit: 12, offset: 0 }), owned(u.id, { downloads: true, limit: 12, offset: 0 }),
      following(req, 12), favorites(req, 12), brandsFollowed(u.id),
      one(`select (select count(*)::int from follows where user_id = $1) as following, (select count(*)::int from favorites where user_id = $1) as favorites`, [u.id]),
    ]);
    return {
      continue_reading: cont, owned: own.items, downloads: down.items, following: fol, favorites: fav, brands,
      counts: { owned: own.total, downloads: down.total, following: counts?.following ?? 0, favorites: counts?.favorites ?? 0, brands: brands.length },
    };
  });

  app.get('/api/library/continue', async (req) => {
    requireUser(req);
    return { items: await continueReading(req, 50) };
  });
  app.get('/api/library/history', async (req) => {
    requireUser(req);
    return { items: await continueReading(req, 100, true) };
  });
  app.get('/api/library/owned', async (req) => {
    const u = requireUser(req);
    const { limit, offset, page } = pageParams(req.query, 48, 100);
    return { ...(await owned(u.id, { downloads: false, limit, offset })), page, limit };
  });
  /** Downloads shelf: owned releases whose purchase includes the file. */
  app.get('/api/library/downloads', async (req) => {
    const u = requireUser(req);
    const { limit, offset, page } = pageParams(req.query, 48, 100);
    return { ...(await owned(u.id, { downloads: true, limit, offset })), page, limit };
  });
  app.get('/api/library/following', async (req) => {
    const u = requireUser(req);
    const { limit, offset, page } = pageParams(req.query, 48, 100);
    return { items: await following(req, limit, offset), brands: await brandsFollowed(u.id), page, limit };
  });
  app.get('/api/library/favorites', async (req) => {
    requireUser(req);
    const { limit, offset, page } = pageParams(req.query, 48, 100);
    return { items: await favorites(req, limit, offset), page, limit };
  });

  const series = async (req: FastifyRequest) => {
    const s = await findSeries((req.params as { slug: string }).slug);
    if (!s) throw notFound('Series not found');
    await assertViewable(req, s, null);
    return s;
  };
  const limited = (req: FastifyRequest) => {
    if (!rateLimit('follow', req.user!.id, 120, 600)) throw new HttpError(429, 'Too many changes at once. Try again in a few minutes.');
  };

  // The counters only move when a row really was added or removed, so repeats cannot drift them.
  app.post('/api/series/:slug/follow', async (req) => {
    const u = requireUser(req);
    limited(req);
    const s = await series(req);
    const body = parse(z.object({ notify: z.boolean().optional() }), req.body ?? {});
    const count = await tx(async (db) => {
      const r = await db.query(
        `insert into follows (user_id, series_id, notify) values ($1,$2,$3) on conflict (user_id, series_id) do update set notify = excluded.notify returning (xmax = 0) as inserted`,
        [u.id, s.id, body.notify ?? true],
      );
      const row = await db.query('update series set follower_count = follower_count + $2 where id = $1 returning follower_count', [s.id, r.rows[0].inserted ? 1 : 0]);
      return row.rows[0].follower_count as number;
    });
    return { following: true, notify: body.notify ?? true, follower_count: count };
  });
  app.delete('/api/series/:slug/follow', async (req) => {
    const u = requireUser(req);
    const s = await series(req);
    const count = await tx(async (db) => {
      const r = await db.query('delete from follows where user_id = $1 and series_id = $2', [u.id, s.id]);
      const row = await db.query('update series set follower_count = greatest(0, follower_count - $2) where id = $1 returning follower_count', [s.id, r.rowCount ?? 0]);
      return row.rows[0].follower_count as number;
    });
    return { following: false, follower_count: count };
  });

  app.post('/api/series/:slug/favorite', async (req) => {
    const u = requireUser(req);
    limited(req);
    const s = await series(req);
    const count = await tx(async (db) => {
      const r = await db.query('insert into favorites (user_id, series_id) values ($1,$2) on conflict do nothing', [u.id, s.id]);
      const row = await db.query('update series set favorite_count = favorite_count + $2 where id = $1 returning favorite_count', [s.id, r.rowCount ?? 0]);
      return row.rows[0].favorite_count as number;
    });
    return { favorite: true, favorite_count: count };
  });
  app.delete('/api/series/:slug/favorite', async (req) => {
    const u = requireUser(req);
    const s = await series(req);
    const count = await tx(async (db) => {
      const r = await db.query('delete from favorites where user_id = $1 and series_id = $2', [u.id, s.id]);
      const row = await db.query('update series set favorite_count = greatest(0, favorite_count - $2) where id = $1 returning favorite_count', [s.id, r.rowCount ?? 0]);
      return row.rows[0].favorite_count as number;
    });
    return { favorite: false, favorite_count: count };
  });

  app.post('/api/brands/:slug/follow', async (req) => {
    const u = requireUser(req);
    limited(req);
    const p = await findPublisher((req.params as { slug: string }).slug);
    if (!p || p.suspended_at) throw notFound('Brand not found');
    const added = await exec('insert into publisher_follows (user_id, publisher_id) values ($1,$2) on conflict do nothing', [u.id, p.id]);
    if (added) {
      const owners = await q<{ user_id: string }>(`select user_id from publisher_members where publisher_id = $1 and role in ('owner','admin') and user_id <> $2`, [p.id, u.id]);
      for (const o of owners) await notify(o.user_id, 'follower', `${u.display_name || u.username} followed ${p.name}`, '', `/u/${u.username}`);
    }
    const n = await one<{ n: number }>('select count(*)::int as n from publisher_follows where publisher_id = $1', [p.id]);
    return { following: true, follower_count: n?.n ?? 0 };
  });
  app.delete('/api/brands/:slug/follow', async (req) => {
    const u = requireUser(req);
    const p = await findPublisher((req.params as { slug: string }).slug);
    if (!p) throw notFound('Brand not found');
    await exec('delete from publisher_follows where user_id = $1 and publisher_id = $2', [u.id, p.id]);
    const n = await one<{ n: number }>('select count(*)::int as n from publisher_follows where publisher_id = $1', [p.id]);
    return { following: false, follower_count: n?.n ?? 0 };
  });
}
