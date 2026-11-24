import type { FastifyInstance, FastifyRequest } from 'fastify';
import { one, q } from '../db.ts';
import type { Row } from '../db.ts';
import { canView, hasMembership, releaseAccess } from '../lib/access.ts';
import { isAdmin, notFound, pageParams, HttpError } from '../lib/http.ts';
import { activeDiscounts, bundlePrice, downloadPrice, readOffer, percentOff, seriesPurchase } from '../lib/pricing.ts';
import { money } from '../lib/payments.ts';
import { publicUrl } from '../lib/storage.ts';
import { FAVORITE_GENRES, RELEASE_GROUPS } from '../lib/taxonomy.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (s: unknown): s is string => typeof s === 'string' && UUID.test(s);

export const showMature = (req: FastifyRequest) => req.showMature;

/**
 * WHERE conditions every public list applies (aliases: series `s`,
 * publishers `p`): public, not deleted or taken down, brand not suspended,
 * mature hidden unless the reader opted in, not blocked for their country,
 * and at least one published release.
 */
export function listable(req: FastifyRequest, params: unknown[]): string {
  params.push(showMature(req), req.country);
  const m = params.length - 1;
  const c = params.length;
  return `s.visibility = 'public' and s.deleted_at is null and s.takedown_at is null
    and p.deleted_at is null and p.suspended_at is null
    and (not s.mature or $${m})
    and not exists (select 1 from country_rules cr where cr.series_id = s.id and cr.enabled and cr.language is null and cr.country = $${c} and cr.rule = 'blocked')
    and (s.access_model <> 'blocked' or exists (select 1 from country_rules cr where cr.series_id = s.id and cr.enabled and cr.language is null and cr.country = $${c} and cr.rule <> 'blocked'))
    and exists (select 1 from releases r where r.series_id = s.id and r.status = 'published' and r.deleted_at is null)`;
}

/** Columns + joins for a series card. Append `where ...`. */
export const CARD_SELECT = `
  select s.id, s.slug, s.title, s.type, s.genre, s.status, s.language, s.mature, s.cover_key, s.access_model, s.in_subscription,
         s.follower_count, s.favorite_count, s.read_count, s.updated_at, s.created_at,
         p.id as publisher_id, p.slug as publisher_slug, p.name as publisher_name, p.kind as publisher_kind, p.verified_at as publisher_verified_at,
         lr.id as lr_id, lr.number as lr_number, lr.kind as lr_kind, lr.title as lr_title, lr.published_at as lr_published_at,
         rc.release_count, rc.min_price, d.percent_off as sale_percent, d.label as sale_label
    from series s
    join publishers p on p.id = s.publisher_id
    left join lateral (select r.id, r.number, r.kind, r.title, r.published_at from releases r
                        where r.series_id = s.id and r.status = 'published' and r.deleted_at is null
                        order by r.published_at desc nulls last limit 1) lr on true
    left join lateral (select count(*)::int as release_count, min(nullif(coalesce(r.price_cents, s.default_price_cents), 0)) as min_price
                         from releases r where r.series_id = s.id and r.status = 'published' and r.deleted_at is null) rc on true
    left join lateral (select d.percent_off, d.label from discounts d
                        where d.publisher_id = s.publisher_id and d.active and d.starts_at <= now() and (d.ends_at is null or d.ends_at > now())
                          and (d.series_id is null or d.series_id = s.id) and d.applies_to in ('all','read')
                        order by d.percent_off desc limit 1) d on true`;

export type Badge = { kind: 'free' | 'unlimited' | 'sale' | 'price' | 'premium'; label: string; price_cents?: number; list_price_cents?: number; percent_off?: number };

/** Shape a CARD_SELECT row for the browser. */
export async function toCard(r: Row): Promise<Row> {
  const list = r.access_model === 'premium' ? (r.min_price as number | null) : null;
  const sale = list && r.sale_percent ? percentOff(list, r.sale_percent) : null;
  let badge: Badge;
  if (r.access_model === 'free') badge = { kind: 'free', label: 'Free' };
  else if (sale !== null && list) badge = { kind: 'sale', label: `${r.sale_percent}% off`, price_cents: sale, list_price_cents: list, percent_off: r.sale_percent };
  else if (r.in_subscription) badge = { kind: 'unlimited', label: 'Unlimited', ...(list ? { price_cents: list } : {}) };
  else if (list) badge = { kind: 'price', label: await money(list), price_cents: list };
  else badge = { kind: 'premium', label: 'Premium' };
  return {
    id: r.id, slug: r.slug, title: r.title, type: r.type, genre: r.genre, status: r.status, language: r.language, mature: r.mature,
    cover_url: await publicUrl(r.cover_key),
    publisher: { id: r.publisher_id, slug: r.publisher_slug, name: r.publisher_name, kind: r.publisher_kind, verified: Boolean(r.publisher_verified_at) },
    release_count: r.release_count ?? 0,
    latest_release: r.lr_id ? { id: r.lr_id, number: r.lr_number, kind: r.lr_kind, title: r.lr_title, published_at: r.lr_published_at } : null,
    access_model: r.access_model, in_membership: r.access_model === 'premium' && r.in_subscription,
    from_price_cents: sale ?? list, list_price_cents: list, sale_percent: sale !== null ? r.sale_percent : null, sale_label: sale !== null ? r.sale_label : null,
    badge, follower_count: r.follower_count, favorite_count: r.favorite_count, read_count: r.read_count, updated_at: r.updated_at,
  };
}
export const toCards = (rows: Row[]) => Promise.all(rows.map(toCard));

/** Listable series cards with extra conditions/order; shared by the store, library and feeds. */
export async function cards(req: FastifyRequest, where: string, params: unknown[], tail: string): Promise<Row[]> {
  const p = [...params];
  return toCards(await q(`${CARD_SELECT} where ${listable(req, p)} ${where ? `and ${where}` : ''} ${tail}`, p));
}

export async function findSeries(key: string): Promise<Row | null> {
  return one(`select * from series where ${isUuid(key) ? 'id' : 'slug'} = $1 and deleted_at is null`, [key]);
}
export async function findPublisher(key: string): Promise<Row | null> {
  return one(`select * from publishers where ${isUuid(key) ? 'id' : 'slug'} = $1 and deleted_at is null`, [key]);
}

export async function isBrandMember(userId: string | undefined, publisherId: string): Promise<boolean> {
  if (!userId) return false;
  return Boolean(await one('select 1 from publisher_members where publisher_id = $1 and user_id = $2', [publisherId, userId]));
}

/** 404 / 403 unless this visitor may open the series (and release). Returns whether they are staff of the brand. */
export async function assertViewable(req: FastifyRequest, series: Row, release: Row | null, opts: { preview?: boolean } = {}): Promise<boolean> {
  const member = isAdmin(req.user) || (await isBrandMember(req.user?.id, series.publisher_id));
  if (member) return true;
  const pub = await one('select suspended_at, deleted_at from publishers where id = $1', [series.publisher_id]);
  if (!pub || pub.deleted_at || pub.suspended_at) throw notFound('This title is not available');
  if (opts.preview) return false;
  const v = canView(series, release, req.showMature, false);
  if (!v.ok) {
    if (v.reason === 'mature') {
      throw new HttpError(403, 'This title is for adults. Confirm you are 18 or older to open it.', 'mature');
    }
    throw notFound(v.reason);
  }
  return false;
}

/** Crowdfunding banner with countdown fields, or null when it should not show. */
export function crowdfunding(cf: Row | null): Row | null {
  if (!cf || typeof cf !== 'object') return null;
  if ((cf.enabled ?? cf.display ?? cf.show_banner ?? cf.active) === false) return null;
  const url = cf.url ?? cf.link ?? cf.campaign_url ?? null;
  if (!url) return null;
  const starts = cf.starts_at ?? cf.start_at ?? cf.start ?? null;
  const ends = cf.ends_at ?? cf.end_at ?? cf.end ?? null;
  const now = Date.now();
  const s = starts ? Date.parse(starts) : null;
  const e = ends ? Date.parse(ends) : null;
  const state = s && s > now ? 'upcoming' : e && e <= now ? 'ended' : 'live';
  const goal = cf.goal_cents ?? (typeof cf.goal === 'number' ? Math.round(cf.goal * 100) : null);
  return {
    service: cf.service ?? 'Other', url, goal_cents: goal, timezone: cf.timezone ?? null, starts_at: starts, ends_at: ends,
    state, active: state !== 'ended',
    seconds_until_start: state === 'upcoming' && s ? Math.ceil((s - now) / 1000) : 0,
    seconds_remaining: state === 'live' && e ? Math.ceil((e - now) / 1000) : state === 'live' ? null : 0,
  };
}

function csv(v: unknown): string[] {
  return String(v ?? '').split(',').map((s) => s.trim()).filter(Boolean).slice(0, 20);
}

const NEW_RELEASES = `
  select r.id as release_id, r.number, r.kind, r.title as release_title, r.published_at, r.cover_key as release_cover_key, c.*
    from releases r join lateral (__CARD__ where s.id = r.series_id and __LISTABLE__) c on true
   where r.status = 'published' and r.deleted_at is null and __WHEN__
   order by r.published_at desc limit 24`;

export default async function catalogRoutes(app: FastifyInstance) {
  const newReleases = async (req: FastifyRequest, when: string) => {
    const params: unknown[] = [];
    const sql = NEW_RELEASES.replace('__CARD__', CARD_SELECT).replace('__LISTABLE__', listable(req, params)).replace('__WHEN__', `(not r.mature or $${1})` + ` and ${when}`);
    const rows = await q(sql, params);
    return Promise.all(rows.map(async (r) => ({
      release: { id: r.release_id, number: r.number, kind: r.kind, title: r.release_title, published_at: r.published_at, cover_url: await publicUrl(r.release_cover_key ?? r.cover_key) },
      series: await toCard(r),
    })));
  };

  /** Storefront. Every row is a list of series cards unless noted. */
  app.get('/api/home', async (req) => {
    const u = req.user;
    const active = `(f.starts_at is null or f.starts_at <= now()) and (f.ends_at is null or f.ends_at > now())`;
    const featured = async (slot: string) => {
      const params: unknown[] = [slot];
      const rows = await q(
        `select f.id as featured_id, f.blurb, f.headline, f.url, f.image_key, f.position, c.*
           from featured f left join lateral (${CARD_SELECT} where s.id = f.series_id and ${listable(req, params)}) c on true
          where f.slot = $1 and ${active} and (f.series_id is null or c.id is not null) order by f.position, f.created_at`,
        params,
      );
      return Promise.all(rows.map(async (r) => {
        const series = r.id ? await toCard(r) : null;
        return {
          id: r.featured_id, headline: r.headline ?? series?.title ?? '', blurb: r.blurb, image_url: (await publicUrl(r.image_key)) ?? series?.cover_url ?? null,
          url: r.url ?? (series ? `/series/${series.slug}` : null), series,
        };
      }));
    };

    const fav = FAVORITE_GENRES.find((g) => g.id === u?.prefs?.favorite_genre);
    const genreRow = async (genre: string, type?: string) => ({
      id: `genre:${genre}${type ? `:${type}` : ''}`,
      title: type === 'manga' ? `${genre} manga` : genre,
      items: await cards(req, `s.genre = $1 ${type ? 'and s.type = $2' : ''}`, type ? [genre, type] : [genre], 'order by s.read_count desc, s.updated_at desc limit 18'),
    });
    let tuned: { id: string; title: string; items: Row[] }[] = [];
    if (fav && fav.genres.length) {
      const type = 'type' in fav ? fav.type : undefined;
      tuned = await Promise.all(fav.genres.map((g) => genreRow(g, type)));
      // A manga pick with a thin manga shelf still gets the genre from every format.
      if (type) tuned.push(...(await Promise.all(fav.genres.map((g) => genreRow(g)))));
    } else {
      const top = await q<{ genre: string }>(
        `select s.genre from series s join publishers p on p.id = s.publisher_id where ${listable(req, [])} and s.genre is not null group by s.genre order by sum(s.read_count) desc, count(*) desc limit 4`,
        [showMature(req), req.country],
      );
      tuned = await Promise.all(top.map((t) => genreRow(t.genre)));
    }
    tuned = tuned.filter((r) => r.items.length);

    const saleRows = await q(
      `select d.id, d.label, d.percent_off, d.ends_at, d.series_id, d.publisher_id, d.applies_to, p.name as publisher_name, p.slug as publisher_slug
         from discounts d join publishers p on p.id = d.publisher_id
        where d.active and d.starts_at <= now() and (d.ends_at is null or d.ends_at > now()) and p.suspended_at is null and p.deleted_at is null
        order by d.percent_off desc, d.created_at desc limit 8`,
    );
    const sale = (await Promise.all(saleRows.map(async (d) => ({
      id: d.id, label: d.label, percent_off: d.percent_off, ends_at: d.ends_at, applies_to: d.applies_to,
      publisher: { slug: d.publisher_slug, name: d.publisher_name },
      items: await cards(req, `s.publisher_id = $1 and ($2::uuid is null or s.id = $2) and s.access_model = 'premium'`, [d.publisher_id, d.series_id], 'order by s.read_count desc limit 18'),
    })))).filter((r) => r.items.length);

    const [hero, staff_picks, spotlight, last_week, earlier, indieNew, indiePopular, popular] = await Promise.all([
      featured('hero'), featured('staff_picks'), featured('spotlight'),
      newReleases(req, `r.published_at > now() - interval '7 days'`),
      newReleases(req, `r.published_at <= now() - interval '7 days' and r.published_at > now() - interval '90 days'`),
      cards(req, `p.kind = 'creator'`, [], 'order by lr.published_at desc nulls last limit 18'),
      cards(req, `p.kind = 'creator'`, [], 'order by s.read_count desc, s.follower_count desc limit 18'),
      cards(req, '', [], 'order by s.read_count desc, s.follower_count desc limit 18'),
    ]);

    return {
      hero,
      staff_picks: staff_picks.filter((f) => f.series).map((f) => ({ ...f.series, blurb: f.blurb })),
      spotlight: spotlight.filter((f) => f.series).map((f) => ({ ...f.series, blurb: f.blurb })),
      new_releases: { last_week, earlier },
      sale,
      independent: [
        { id: 'independent:new', title: 'New from independent creators', items: indieNew },
        { id: 'independent:popular', title: 'Independent favourites', items: indiePopular },
      ].filter((r) => r.items.length),
      continue_reading: u ? await continueReading(req, 12) : [],
      favorite_genre: fav ? { id: fav.id, label: fav.label } : null,
      for_you: tuned,
      popular,
    };
  });

  /** Browse + search. */
  app.get('/api/series', async (req) => {
    const qy = (req.query ?? {}) as Record<string, string>;
    const { limit, offset, page } = pageParams(qy, 24, 60);
    const params: unknown[] = [];
    const where: string[] = [listable(req, params)];
    const add = (sql: string, v: unknown) => {
      params.push(v);
      where.push(sql.replaceAll('?', `$${params.length}`));
    };
    const term = String(qy.q ?? '').trim().slice(0, 100);
    let rank = '0';
    if (term) {
      // Whole-word match first, then a prefix match so "drag" finds "Dragon".
      const prefix = term.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean).slice(0, 6).map((w) => `${w}:*`).join(' & ');
      params.push(term, prefix || 'zzzzzz:*', `%${term.replace(/[%_\\]/g, '\\$&')}%`);
      const [a, b, c] = [params.length - 2, params.length - 1, params.length];
      where.push(`(s.search @@ websearch_to_tsquery('simple', $${a}) or s.search @@ websearch_to_tsquery('english', $${a}) or s.search @@ to_tsquery('simple', $${b}) or s.title ilike $${c} or p.name ilike $${c})`);
      rank = `(ts_rank(s.search, websearch_to_tsquery('simple', $${a})) * 2 + ts_rank(s.search, to_tsquery('simple', $${b})) + case when s.title ilike $${c} then 0.5 else 0 end)`;
    }
    if (qy.type) add('s.type = any(?)', csv(qy.type));
    if (qy.genre) add('s.genre = any(?)', csv(qy.genre));
    if (qy.themes) add('s.themes && ?', csv(qy.themes));
    if (qy.eras) add('s.eras && ?', csv(qy.eras));
    if (qy.audience) add('s.audiences && ?', csv(qy.audience));
    if (qy.art_style) add('s.art_styles && ?', csv(qy.art_style));
    if (qy.tags) add('s.tags && ?', csv(qy.tags));
    if (qy.status) add('s.status = any(?)', csv(qy.status));
    if (qy.language) add('(s.language = any(?) or exists (select 1 from series_editions e where e.series_id = s.id and e.language = any(?)))', csv(qy.language));
    if (qy.publisher) add('p.slug = ?', qy.publisher);
    if (qy.access === 'free') where.push(`s.access_model = 'free'`);
    if (qy.access === 'premium') where.push(`s.access_model = 'premium'`);
    if (qy.access === 'membership') where.push(`s.access_model = 'premium' and s.in_subscription`);
    if (qy.on_sale === '1' || qy.on_sale === 'true') where.push('d.percent_off is not null');
    const effective = `(case when s.access_model = 'free' then 0 else rc.min_price * (100 - coalesce(d.percent_off, 0)) / 100 end)`;
    if (qy.price_max !== undefined && qy.price_max !== '') add(`${effective} <= ?`, Math.max(0, Number(qy.price_max) || 0));
    if (qy.price_min !== undefined && qy.price_min !== '') add(`${effective} >= ?`, Math.max(0, Number(qy.price_min) || 0));

    const sort = qy.sort ?? (term ? 'relevance' : 'new');
    const order =
      sort === 'popular' ? 's.read_count desc, s.follower_count desc' :
      sort === 'updated' ? 's.updated_at desc' :
      sort === 'title' ? 'lower(s.title) asc' :
      sort === 'relevance' && term ? `${rank} desc, s.read_count desc` :
      'lr.published_at desc nulls last';
    const sql = `${CARD_SELECT} where ${where.join(' and ')}`;
    const [rows, count] = await Promise.all([
      q(`${sql} order by ${order}, s.id limit ${limit} offset ${offset}`, params),
      one<{ n: number }>(`select count(*)::int as n from (${sql}) x`, params),
    ]);
    return { items: await toCards(rows), total: count?.n ?? 0, page, limit, sort: sort === 'relevance' && !term ? 'new' : sort };
  });

  /** Everything the series page shows, tailored to this reader. */
  app.get('/api/series/:slug', async (req) => {
    const { slug } = req.params as { slug: string };
    const s = await findSeries(slug);
    if (!s) throw notFound('Series not found');
    const member = await assertViewable(req, s, null);
    const u = req.user;
    const lang = String((req.query as Row)?.language ?? '');

    const [pub, relRows, editions, contributors, discounts, state, counts, bundles] = await Promise.all([
      one('select id, slug, name, kind, bio, avatar_key, verified_at, tips_enabled, membership_note from publishers where id = $1', [s.publisher_id]),
      q(
        `select * from releases where series_id = $1 and deleted_at is null and ($2 or status = 'published') and ($3 = '' or language = $3)
          order by language, number, created_at`,
        [s.id, member, lang],
      ),
      q('select language, title, description, access_model from series_editions where series_id = $1 order by language', [s.id]),
      q(
        `select c.id, c.release_id, c.name, c.role, c.position, u.username, u.avatar_key
           from contributors c left join users u on u.id = c.user_id and u.deleted_at is null where c.series_id = $1 order by c.position, c.name`,
        [s.id],
      ),
      activeDiscounts([s.publisher_id]),
      u
        ? one(
            `select exists (select 1 from follows where user_id = $1 and series_id = $2) as following,
                    (select notify from follows where user_id = $1 and series_id = $2) as notify,
                    exists (select 1 from favorites where user_id = $1 and series_id = $2) as favorite`,
            [u.id, s.id],
          )
        : null,
      one(`select (select count(*)::int from comments where series_id = $1 and deleted_at is null and hidden_at is null) as comments,
                  (select count(*)::int from forum_threads where series_id = $1 and deleted_at is null) as threads`, [s.id]),
      q(
        `select b.*, array_agg(bi.release_id) as release_ids from bundles b join bundle_items bi on bi.bundle_id = b.id join releases r on r.id = bi.release_id
          where b.active and b.publisher_id = $1 and r.series_id = $2 and r.status = 'published' and r.deleted_at is null group by b.id order by b.created_at`,
        [s.publisher_id, s.id],
      ),
    ]);

    const ids = relRows.map((r) => r.id);
    const pages = ids.length ? await q<{ id: string; release_id: string; position: number; is_free: boolean | null }>('select id, release_id, position, is_free from pages where release_id = any($1) order by release_id, position', [ids]) : [];
    const progress = u && ids.length ? await q('select release_id, position, finished from reading_progress where user_id = $1 and release_id = any($2)', [u.id, ids]) : [];
    const isMember = u ? await hasMembership(u.id) : false;

    // Access is worked out once per release; the per-release price and the whole-series price both come from it.
    const accessOf = new Map(await Promise.all(relRows.map(async (r) => {
      const rp = pages.filter((p) => p.release_id === r.id);
      return [r.id as string, await releaseAccess({ series: s, release: r, pages: rp, user: u, country: req.country })] as const;
    })));
    const whole = await seriesPurchase(s, u?.id ?? null, discounts, undefined, { country: req.country, access: accessOf });
    const releases = await Promise.all(relRows.map(async (r) => {
      const rp = pages.filter((p) => p.release_id === r.id);
      const a = accessOf.get(r.id)!;
      const read = readOffer(s, r, a, discounts);
      const dl = downloadPrice(s, r, discounts);
      const owned = a.unlock === 'purchase' || a.unlock === 'code';
      const status =
        a.model === 'blocked' && a.unlock !== 'owner' ? 'blocked' :
        a.unlock === 'owner' ? 'owner' : owned ? 'owned' : a.releaseFree || (a.lockedPages === 0 && a.unlock !== 'subscription') ? 'free' : a.unlock === 'subscription' ? 'membership' : a.freePages > 0 ? 'preview' : 'locked';
      const pr = progress.find((p) => p.release_id === r.id);
      return {
        id: r.id, number: r.number, kind: r.kind, language: r.language, title: r.title, synopsis: r.synopsis, mature: r.mature, status: r.status,
        published_at: r.published_at, page_count: rp.length || r.page_count, cover_url: await publicUrl(r.cover_key), print_url: r.print_url, isbn: r.isbn,
        free_at: r.free_at,
        access: {
          status, model: a.model, release_free: a.releaseFree, unlock: a.unlock, can_download: a.canDownload, free_pages: a.freePages, locked_pages: a.lockedPages,
          read_price_cents: read ? read.price_cents : null, read_list_price_cents: read ? read.base_cents : null,
          download_price_cents: dl && !a.canDownload && a.model !== 'blocked' ? dl.price_cents : null, download_list_price_cents: dl && !a.canDownload && a.model !== 'blocked' ? dl.base_cents : null,
          in_membership: a.model === 'premium' && s.in_subscription,
        },
        progress: pr ? { position: pr.position, finished: pr.finished } : null,
        contributors: contributors.filter((c) => c.release_id === r.id).map((c) => ({ name: c.name, role: c.role, username: c.username })),
      };
    }));

    const kindLabel = new Map<string, string>(RELEASE_GROUPS.flatMap((g) => g.kinds.map((k) => [k.id, k.label] as [string, string])));
    const release_groups = RELEASE_GROUPS.map((g) => ({
      group: g.group,
      releases: releases.filter((r) => g.kinds.some((k) => k.id === r.kind)).map((r) => ({ ...r, kind_label: kindLabel.get(r.kind) })),
    })).filter((g) => g.releases.length);

    const edition = editions.find((e) => e.language === (lang || (u?.prefs?.reading_language as string | undefined)));
    const best = discounts.filter((d) => !d.series_id || d.series_id === s.id).sort((a, b) => b.percent_off - a.percent_off)[0];
    const first = releases.find((r) => r.status === 'published' && r.access.status !== 'blocked');
    const resume = [...progress].length ? releases.find((r) => progress.some((p) => p.release_id === r.id && !p.finished)) : null;

    return {
      series: {
        id: s.id, slug: s.slug, title: edition?.title ?? s.title, description: edition?.description || s.description, type: s.type, layout: s.layout, reading_dir: s.reading_dir,
        language: s.language, languages: [...new Set([s.language, ...editions.map((e) => e.language), ...releases.map((r) => r.language)])],
        status: s.status, visibility: s.visibility, genre: s.genre, themes: s.themes, audiences: s.audiences, art_styles: s.art_styles, advisories: s.advisories,
        eras: s.eras, content_ratings: s.content_ratings, tags: s.tags, mature: s.mature, cover_url: await publicUrl(s.cover_key), banner_url: await publicUrl(s.banner_key),
        access_model: s.access_model, in_membership: s.access_model === 'premium' && s.in_subscription, free_preview: s.free_preview, paywall_expires_days: s.paywall_expires_days,
        allow_comments: s.allow_comments, update_frequency: s.update_frequency, website: s.website, pub_year: s.pub_year,
        forum_enabled: s.forum_enabled, forum_description: s.forum_description, created_at: s.created_at, updated_at: s.updated_at,
      },
      editions,
      brand: pub && {
        id: pub.id, slug: pub.slug, name: pub.name, kind: pub.kind, bio: pub.bio, avatar_url: await publicUrl(pub.avatar_key), verified: Boolean(pub.verified_at),
        tips_enabled: pub.tips_enabled, membership_note: pub.membership_note,
        following: u ? Boolean(await one('select 1 from publisher_follows where user_id = $1 and publisher_id = $2', [u.id, pub.id])) : false,
      },
      release_groups,
      contributors: await Promise.all(contributors.filter((c) => !c.release_id).map(async (c) => ({ id: c.id, name: c.name, role: c.role, username: c.username, avatar_url: await publicUrl(c.avatar_key) }))),
      crowdfunding: crowdfunding(s.crowdfunding),
      print_links: releases.filter((r) => r.print_url).map((r) => ({ release_id: r.id, title: r.title, number: r.number, kind: r.kind, url: r.print_url, isbn: r.isbn })),
      discount: best ? { label: best.label, percent_off: best.percent_off, applies_to: best.applies_to, ends_at: best.ends_at } : null,
      offers: {
        series_price_cents: whole.releases.length > 1 ? whole.price_cents : null, series_list_price_cents: whole.releases.length > 1 ? whole.base_cents : null, series_release_count: whole.releases.length, series_release_ids: whole.releases.map((r) => r.id),
        bundles: bundles.map((b) => {
          const p = bundlePrice(b, discounts);
          return { id: b.id, title: b.title, description: b.description, price_cents: p.price_cents, list_price_cents: p.base_cents, includes_download: b.includes_download, release_ids: b.release_ids };
        }),
        is_member: isMember,
      },
      viewer: {
        signed_in: Boolean(u), is_brand_member: member, following: Boolean(state?.following), notify: state?.notify ?? false, favorite: Boolean(state?.favorite),
        start_release_id: resume?.id ?? first?.id ?? null, resume: Boolean(resume),
      },
      counts: { followers: s.follower_count, favorites: s.favorite_count, reads: s.read_count, releases: releases.filter((r) => r.status === 'published').length, comments: counts?.comments ?? 0, threads: counts?.threads ?? 0 },
    };
  });

  /** Creators directory. */
  app.get('/api/brands', async (req) => {
    const qy = (req.query ?? {}) as Record<string, string>;
    const { limit, offset, page } = pageParams(qy, 24, 60);
    const params: unknown[] = [showMature(req)];
    const where = ['p.deleted_at is null', 'p.suspended_at is null', 'sc.n > 0'];
    if (qy.q?.trim()) {
      params.push(`%${qy.q.trim().slice(0, 80).replace(/[%_\\]/g, '\\$&')}%`);
      where.push(`(p.name ilike $${params.length} or p.slug ilike $${params.length})`);
    }
    if (qy.kind === 'creator' || qy.kind === 'publisher') {
      params.push(qy.kind);
      where.push(`p.kind = $${params.length}`);
    }
    const order = qy.sort === 'name' ? 'lower(p.name)' : qy.sort === 'new' ? 'p.created_at desc' : 'fc.n desc, sc.reads desc, lower(p.name)';
    const sql = `from publishers p
      join lateral (select count(*)::int as n, coalesce(sum(read_count),0)::float8 as reads from series s
                     where s.publisher_id = p.id and s.visibility = 'public' and s.deleted_at is null and s.takedown_at is null and (not s.mature or $1)) sc on true
      join lateral (select count(*)::int as n from publisher_follows f where f.publisher_id = p.id) fc on true
      where ${where.join(' and ')}`;
    const [rows, count] = await Promise.all([
      q(`select p.id, p.slug, p.name, p.kind, p.bio, p.avatar_key, p.verified_at, sc.n as series_count, fc.n as follower_count ${sql} order by ${order} limit ${limit} offset ${offset}`, params),
      one<{ n: number }>(`select count(*)::int as n ${sql}`, params),
    ]);
    return {
      items: await Promise.all(rows.map(async (b) => ({ id: b.id, slug: b.slug, name: b.name, kind: b.kind, bio: b.bio, avatar_url: await publicUrl(b.avatar_key), verified: Boolean(b.verified_at), series_count: b.series_count, follower_count: b.follower_count }))),
      total: count?.n ?? 0, page, limit,
    };
  });

  /** Brand profile. `?q=` searches titles within the brand. */
  app.get('/api/brands/:slug', async (req) => {
    const p = await findPublisher((req.params as { slug: string }).slug);
    const staff = p ? isAdmin(req.user) || (await isBrandMember(req.user?.id, p.id)) : false;
    if (!p || (p.suspended_at && !staff)) throw notFound('Brand not found');
    const term = String((req.query as Row)?.q ?? '').trim().slice(0, 80);
    const [series, members, tips, recentTips, conventions, followers, following] = await Promise.all([
      cards(req, `s.publisher_id = $1 and ($2 = '' or s.title ilike $3)`, [p.id, term, `%${term.replace(/[%_\\]/g, '\\$&')}%`], 'order by lr.published_at desc nulls last limit 100'),
      q(
        `select u.username, u.display_name, u.avatar_key, u.prefs, m.role, m.created_at from publisher_members m join users u on u.id = m.user_id
          where m.publisher_id = $1 and u.deleted_at is null order by case m.role when 'owner' then 0 when 'admin' then 1 when 'editor' then 2 else 3 end, m.created_at`,
        [p.id],
      ),
      one<{ cents: number; n: number }>(`select coalesce(sum(amount_cents),0)::int as cents, count(*)::int as n from tips where publisher_id = $1 and created_at >= date_trunc('month', now())`, [p.id]),
      q(
        `select t.amount_cents, t.message, t.show_amount, t.created_at, u.username, u.display_name, u.prefs
           from tips t left join users u on u.id = t.user_id and u.deleted_at is null where t.publisher_id = $1 order by t.created_at desc limit 10`,
        [p.id],
      ),
      q(`select id, name, location, booth, url, starts_on, ends_on from conventions where publisher_id = $1 and coalesce(ends_on, starts_on) >= current_date order by starts_on limit 20`, [p.id]),
      one<{ n: number }>('select count(*)::int as n from publisher_follows where publisher_id = $1', [p.id]),
      req.user ? one('select 1 from publisher_follows where user_id = $1 and publisher_id = $2', [req.user.id, p.id]) : null,
    ]);
    const shown = (u: Row) => (u.prefs?.show_real_name === false ? u.username : u.display_name || u.username);
    return {
      brand: {
        id: p.id, slug: p.slug, name: p.name, kind: p.kind, bio: p.bio, avatar_url: await publicUrl(p.avatar_key), banner_url: await publicUrl(p.banner_key),
        website: p.website, socials: p.socials, country: p.country, verified: Boolean(p.verified_at), membership_note: p.membership_note,
        tips_enabled: p.tips_enabled, series_count: series.length, follower_count: followers?.n ?? 0, created_at: p.created_at,
      },
      tip_goal: p.tips_enabled && p.monthly_goal_cents
        ? { goal_cents: p.monthly_goal_cents, raised_cents: tips?.cents ?? 0, percent: Math.min(100, Math.floor(((tips?.cents ?? 0) * 100) / p.monthly_goal_cents)), tips: tips?.n ?? 0, month: new Date().toISOString().slice(0, 7) }
        : null,
      recent_tips: recentTips.map((t) => ({
        name: t.username ? shown(t) : 'Someone', message: t.message, created_at: t.created_at,
        amount_cents: t.show_amount && t.prefs?.show_donation_amounts !== false ? t.amount_cents : null,
      })),
      series,
      query: term,
      members: await Promise.all(members.map(async (m) => ({ username: m.username, name: shown(m), avatar_url: await publicUrl(m.avatar_key), role: m.role, since: m.created_at }))),
      conventions,
      viewer: { following: Boolean(following), is_brand_member: staff },
    };
  });
}

/** The releases a reader is part-way through, newest first, as cards with progress. */
export async function continueReading(req: FastifyRequest, limit: number, finished = false): Promise<Row[]> {
  const params: unknown[] = [req.user!.id, finished];
  const rows = await q(
    `select rp.position, rp.finished, rp.updated_at as read_at, r.id as release_id, r.number, r.kind, r.title as release_title, r.page_count, r.cover_key as release_cover_key, c.*
       from reading_progress rp join releases r on r.id = rp.release_id and r.deleted_at is null and r.status = 'published'
       join lateral (${CARD_SELECT} where s.id = rp.series_id and ${listable(req, params).replace(`s.visibility = 'public'`, `s.visibility <> 'draft'`)}) c on true
      where rp.user_id = $1 and ($2 or not rp.finished) order by rp.updated_at desc limit ${limit}`,
    params,
  );
  return Promise.all(rows.map(async (r) => ({
    release: { id: r.release_id, number: r.number, kind: r.kind, title: r.release_title, page_count: r.page_count, cover_url: await publicUrl(r.release_cover_key ?? r.cover_key) },
    position: r.position, finished: r.finished, read_at: r.read_at,
    percent: r.page_count ? Math.min(100, Math.round(((r.position + 1) * 100) / r.page_count)) : 0,
    series: await toCard(r),
  })));
}
