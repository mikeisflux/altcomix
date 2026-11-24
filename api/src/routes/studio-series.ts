import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { config } from '../config.ts';
import { exec, one, patch, q } from '../db.ts';
import type { Row } from '../db.ts';
import { audit, badRequest, conflict, notFound, parse, requireMember, requireSeriesMember, uniqueSlug } from '../lib/http.ts';
import { announceSeriesLaunch, coverUrls, idParam, isUuid, probeImage, receiveImage, receiveMultipart, setSeriesCover, storeWebp } from '../lib/ingest.ts';
import { getSetting } from '../lib/settings.ts';
import { publicUrl, storage } from '../lib/storage.ts';
import {
  ADVISORIES, ART_STYLES, AUDIENCES, CONTENT_RATINGS, CONTRIBUTOR_ROLES, CROWDFUNDING_SERVICES, ERAS, GENRES, LANGUAGES, THEMES,
  UPDATE_FREQUENCIES,
} from '../lib/taxonomy.ts';

/** Studio: series (metadata, paywall, advanced settings and everything hanging off a series). */

const LANGUAGE_CODES = LANGUAGES.map((l) => l.code) as string[];
const language = z.string().refine((v) => LANGUAGE_CODES.includes(v), 'Unknown language');
const timezones = new Set<string>([...Intl.supportedValuesOf('timeZone'), 'UTC']);

const pick = (list: readonly string[], max: number, what: string) =>
  z
    .array(z.string().refine((v) => list.includes(v), `Unknown ${what}`))
    .max(max, `Choose at most ${max} ${what}${max === 1 ? '' : 's'}`)
    .transform((v) => [...new Set(v)]);

const link = z
  .string()
  .trim()
  .max(500)
  .refine((v) => v === '' || (/^https?:\/\//i.test(v) && URL.canParse(v)), 'Enter a full link starting with https://')
  .transform((v) => (v === '' ? null : v))
  .nullable();

const instant = z
  .string()
  .refine((v) => !Number.isNaN(Date.parse(v)), 'Use a date and time like 2027-03-14T18:00:00Z')
  .transform((v) => new Date(v).toISOString());

const freePreview = z
  .object({
    mode: z.enum(['first_releases', 'first_last_releases', 'first_pages', 'custom_first', 'custom_first_last', 'automatic']),
    n: z.number().int().min(1).max(500).optional(),
    m: z.number().int().min(1).max(500).optional(),
  })
  .refine((v) => !['custom_first', 'custom_first_last'].includes(v.mode) || v.n !== undefined, 'Say how many releases are free (n)')
  .transform((v) => {
    // Keep only the counts the mode uses.
    if (v.mode === 'first_pages' || v.mode === 'custom_first') return { mode: v.mode, n: v.n ?? (v.mode === 'first_pages' ? 10 : 3) };
    if (v.mode === 'custom_first_last') return { mode: v.mode, n: v.n!, m: v.m ?? v.n! };
    return { mode: v.mode };
  });

const crowdfunding = z
  .object({
    enabled: z.boolean(),
    service: z.enum(CROWDFUNDING_SERVICES),
    goal_cents: z.number().int().min(0).max(2_000_000_000).nullable().optional(),
    url: link.optional(),
    timezone: z.string().refine((v) => timezones.has(v), 'Unknown timezone').nullable().optional(),
    starts_at: instant.nullable().optional(),
    ends_at: instant.nullable().optional(),
  })
  .refine((v) => !v.enabled || v.url, 'Add the campaign link to show the banner')
  .refine((v) => !v.starts_at || !v.ends_at || v.ends_at > v.starts_at, 'The campaign ends before it starts')
  .transform((v) => ({
    enabled: v.enabled, service: v.service, goal_cents: v.goal_cents ?? null, url: v.url ?? null, timezone: v.timezone ?? null,
    starts_at: v.starts_at ?? null, ends_at: v.ends_at ?? null,
  }));

const seriesFields = z.object({
  title: z.string().trim().min(1, 'Give the series a title').max(150),
  description: z.string().trim().max(1800, 'Description can be at most 1800 characters'),
  language,
  pub_year: z.number().int().min(1800).max(new Date().getFullYear() + 2).nullable(),
  status: z.enum(['ongoing', 'completed', 'hiatus', 'cancelled']),
  type: z.enum(['comic', 'graphic_novel', 'manga', 'webcomic']),
  layout: z.enum(['paged', 'vertical']),
  reading_dir: z.enum(['ltr', 'rtl']),
  visibility: z.enum(['draft', 'public', 'unlisted']),
  genre: z.string().refine((v) => (GENRES as readonly string[]).includes(v), 'Unknown genre').nullable(),
  themes: pick(THEMES, 6, 'theme'),
  art_styles: pick(ART_STYLES, 2, 'art style'),
  audiences: pick(AUDIENCES, 3, 'audience'),
  advisories: pick(ADVISORIES, ADVISORIES.length, 'advisory'),
  eras: pick(ERAS, ERAS.length, 'era'),
  content_ratings: pick(CONTENT_RATINGS, CONTENT_RATINGS.length, 'content rating'),
  tags: z
    .array(z.string().trim().min(1).max(30))
    .max(20, 'Use at most 20 tags')
    .transform((v) => [...new Set(v.map((t) => t.toLowerCase().replace(/\s+/g, ' ')))]),
  mature: z.boolean(),
  access_model: z.enum(['blocked', 'free', 'premium']),
  in_subscription: z.boolean(),
  free_preview: freePreview,
  paywall_expires_days: z.number().int().min(1).max(3650).nullable(),
  default_price_cents: z.number().int().min(0).max(100_000).nullable(),
  allow_comments: z.boolean(),
  update_frequency: z.string().refine((v) => (UPDATE_FREQUENCIES as readonly string[]).includes(v), 'Unknown update frequency').nullable(),
  website: link,
  crowdfunding: crowdfunding.nullable(),
  forum_enabled: z.boolean(),
  forum_description: z.string().trim().max(400, 'Forum description can be at most 400 characters'),
});
const SERIES_COLUMNS = Object.keys(seriesFields.shape);

async function seriesView(s: Row) {
  return {
    id: s.id, publisher_id: s.publisher_id, slug: s.slug, title: s.title, description: s.description, type: s.type, layout: s.layout,
    reading_dir: s.reading_dir, language: s.language, status: s.status, visibility: s.visibility, genre: s.genre, themes: s.themes,
    audiences: s.audiences, art_styles: s.art_styles, advisories: s.advisories, eras: s.eras, content_ratings: s.content_ratings, tags: s.tags,
    mature: s.mature, ...(await coverUrls(s.cover_key)), banner_url: await publicUrl(s.banner_key), access_model: s.access_model,
    in_subscription: s.in_subscription, free_preview: s.free_preview, paywall_expires_days: s.paywall_expires_days,
    default_price_cents: s.default_price_cents, allow_comments: s.allow_comments, update_frequency: s.update_frequency, website: s.website,
    pub_year: s.pub_year, crowdfunding: s.crowdfunding, forum_enabled: s.forum_enabled, forum_description: s.forum_description,
    favorite_count: s.favorite_count, follower_count: s.follower_count, read_count: s.read_count,
    takedown: s.takedown_at ? { at: s.takedown_at, reason: s.takedown_reason, purge: Boolean(s.takedown_purge) } : null,
    created_at: s.created_at, updated_at: s.updated_at,
  };
}

const editionCols = 'language, title, description, access_model, created_at';
const ruleCols = 'id, country, language, rule, enabled, created_at';

async function contributorsOf(seriesId: string) {
  return q(
    `select c.id, c.release_id, c.name, c.role, c.position, c.user_id, u.username
       from contributors c left join users u on u.id = c.user_id
      where c.series_id = $1 order by c.release_id nulls first, c.position, c.id`,
    [seriesId],
  );
}

async function moderatorsOf(series: Row) {
  const rows = await q(
    `select 'owner' as source, u.id as user_id, u.username, u.display_name, u.avatar_key, m.created_at
       from publisher_members m join users u on u.id = m.user_id
      where m.publisher_id = $1 and m.role = 'owner'
      union all
     select 'moderator', u.id, u.username, u.display_name, u.avatar_key, fm.created_at
       from forum_moderators fm join users u on u.id = fm.user_id
      where fm.series_id = $2
      order by 1 desc, 6`,
    [series.publisher_id, series.id],
  );
  const out = [];
  for (const r of rows) {
    out.push({ source: r.source, user_id: r.user_id, username: r.username, display_name: r.display_name, avatar_url: await publicUrl(r.avatar_key), created_at: r.created_at });
  }
  return out;
}

async function splitsOf(seriesId: string) {
  return q(
    `select rs.id, rs.share_bps, rs.note, rs.created_at, p.id as payee_id, p.slug as payee_slug, p.name as payee_name
       from revenue_splits rs join publishers p on p.id = rs.payee_publisher_id
      where rs.series_id = $1 order by rs.created_at`,
    [seriesId],
  );
}

/** JSON body, or multipart with the JSON in a `data` field and an optional `cover` file. */
async function readCreate(req: FastifyRequest): Promise<{ data: unknown; coverPath: string | null; cleanup: () => Promise<void> }> {
  if (!req.isMultipart()) return { data: req.body, coverPath: null, cleanup: async () => {} };
  const got = await receiveMultipart(req, 1);
  try {
    let data: unknown;
    try {
      data = JSON.parse(got.fields.data ?? '{}');
    } catch {
      throw badRequest('The "data" field is not valid JSON');
    }
    const file = got.files[0];
    if (file && !(await probeImage(file.path))) throw badRequest(`"${file.filename}" is not a PNG, JPG or WebP image we can read`);
    return { data, coverPath: file?.path ?? null, cleanup: got.cleanup };
  } catch (e) {
    await got.cleanup();
    throw e;
  }
}

export default async function (app: FastifyInstance) {
  // ------------------------------------------------------------ series

  app.get('/api/studio/brands/:id/series', async (req) => {
    const id = idParam(req);
    await requireMember(req, id, 'analyst');
    const rows = await q(
      `select s.*,
              (select count(*)::int from releases r where r.series_id = s.id and r.deleted_at is null) as release_count,
              (select count(*)::int from releases r where r.series_id = s.id and r.deleted_at is null and r.status = 'published') as published_count,
              (select coalesce(sum(r.page_count), 0)::int from releases r where r.series_id = s.id and r.deleted_at is null) as page_count
         from series s where s.publisher_id = $1 and s.deleted_at is null
        order by s.updated_at desc`,
      [id],
    );
    const series = [];
    for (const s of rows) {
      series.push({
        id: s.id, slug: s.slug, title: s.title, type: s.type, language: s.language, status: s.status, visibility: s.visibility,
        access_model: s.access_model, genre: s.genre, mature: s.mature, ...(await coverUrls(s.cover_key)),
        // No cover means the series is hidden from public lists until one exists.
        missing_cover: !s.cover_key,
        release_count: s.release_count, published_count: s.published_count, page_count: s.page_count,
        follower_count: s.follower_count, favorite_count: s.favorite_count, read_count: s.read_count,
        taken_down: Boolean(s.takedown_at), created_at: s.created_at, updated_at: s.updated_at,
      });
    }
    return { series };
  });

  app.post('/api/studio/brands/:id/series', async (req, reply) => {
    const id = idParam(req);
    await requireMember(req, id, 'editor');
    const brand = await one('select id, primary_language from publishers where id = $1 and deleted_at is null', [id]);
    if (!brand) throw notFound('Brand not found');
    const input = await readCreate(req);
    try {
      const body = parse(seriesFields.partial().required({ title: true }), input.data) as Row;
      body.language ??= brand.primary_language;
      // Vertical-scroll comics read top to bottom whatever the script direction.
      if (body.type === 'webcomic' && body.layout === undefined) body.layout = 'vertical';
      if (body.type === 'manga' && body.reading_dir === undefined) body.reading_dir = 'rtl';
      const slug = await uniqueSlug('series', body.title);
      const { sets, values } = patch(body, SERIES_COLUMNS, 3);
      const cols = sets.map((s) => s.split(' = ')[0]);
      const marks = sets.map((s) => s.split(' = ')[1]);
      let series: Row | null;
      try {
        series = await one(
          `insert into series (publisher_id, slug, ${cols.join(', ')}) values ($1, $2, ${marks.join(', ')}) returning *`,
          [id, slug, ...values],
        );
      } catch (e) {
        if ((e as { code?: string }).code === '23505') throw conflict('A series with that URL was just created. Try again.');
        throw e;
      }
      if (input.coverPath) {
        await setSeriesCover(series!.id, `upload-${Date.now().toString(36)}`, input.coverPath);
        series = await one('select * from series where id = $1', [series!.id]);
      }
      // Created already public: there is nothing published yet to summarise, so this only stamps the launch.
      await announceSeriesLaunch(series!.id);
      audit(req, 'series.create', { kind: 'series', id: series!.id });
      reply.code(201);
      return { series: await seriesView(series!) };
    } finally {
      await input.cleanup();
    }
  });

  app.get('/api/studio/series/:id', async (req) => {
    const s = await requireSeriesMember(req, idParam(req), 'analyst');
    const [brand, editions, rules, contributors, moderators, splits, revenue, langs] = await Promise.all([
      one('select id, slug, name, sale_share_bps, sub_share_bps, tip_share_bps from publishers where id = $1', [s.publisher_id]),
      q(`select ${editionCols} from series_editions where series_id = $1 order by language`, [s.id]),
      q(`select ${ruleCols} from country_rules where series_id = $1 order by country, language nulls first`, [s.id]),
      contributorsOf(s.id),
      moderatorsOf(s),
      splitsOf(s.id),
      getSetting('revenue'),
      q<{ language: string; releases: number }>(
        `select language, count(*)::int as releases from releases where series_id = $1 and deleted_at is null group by language`,
        [s.id],
      ),
    ]);
    const languages = [...new Set([s.language, ...editions.map((e) => e.language), ...langs.map((l) => l.language)])].map((code) => ({
      code,
      primary: code === s.language,
      releases: langs.find((l) => l.language === code)?.releases ?? 0,
    }));
    return {
      series: await seriesView(s),
      brand: { id: brand!.id, slug: brand!.slug, name: brand!.name },
      languages,
      editions,
      country_rules: rules,
      contributors,
      moderators,
      splits,
      // The share of each kind of money this brand keeps, in basis points, after payment fees.
      revenue_share: {
        sale_bps: brand!.sale_share_bps ?? revenue.sale_share_bps,
        subscription_bps: brand!.sub_share_bps ?? revenue.sub_share_bps,
        tip_bps: brand!.tip_share_bps ?? revenue.tip_share_bps,
        split_out_bps: splits.reduce((n, x) => n + x.share_bps, 0),
      },
    };
  });

  app.patch('/api/studio/series/:id', async (req) => {
    const s = await requireSeriesMember(req, idParam(req), 'editor');
    const body = parse(seriesFields.partial(), req.body) as Row;
    const { sets, values } = patch(body, SERIES_COLUMNS, 2);
    if (!sets.length) return { series: await seriesView(s) };
    const updated = await one(`update series set ${sets.join(', ')}, updated_at = now() where id = $1 returning *`, [s.id, ...values]);
    audit(req, 'series.update', { kind: 'series', id: s.id }, { fields: Object.keys(body) });
    // Leaving draft for the first time: followers hear once about what is already published.
    let launch_notified: number | null = null;
    if (s.visibility === 'draft' && updated!.visibility !== 'draft' && !updated!.takedown_at) {
      launch_notified = await announceSeriesLaunch(s.id);
      if (launch_notified !== null) audit(req, 'series.launch', { kind: 'series', id: s.id }, { notified: launch_notified });
    }
    return { series: await seriesView(updated!), launch_notified };
  });

  app.delete('/api/studio/series/:id', async (req) => {
    const s = await requireSeriesMember(req, idParam(req), 'admin');
    await exec('update series set deleted_at = now(), updated_at = now() where id = $1', [s.id]);
    audit(req, 'series.delete', { kind: 'series', id: s.id }, { title: s.title });
    return { ok: true };
  });

  app.post('/api/studio/series/:id/cover', async (req) => {
    const s = await requireSeriesMember(req, idParam(req), 'editor');
    const img = await receiveImage(req);
    try {
      const key = await setSeriesCover(s.id, `upload-${Date.now().toString(36)}`, img.path);
      audit(req, 'series.cover', { kind: 'series', id: s.id });
      return coverUrls(key);
    } finally {
      await img.cleanup();
    }
  });

  app.post('/api/studio/series/:id/banner', async (req) => {
    const s = await requireSeriesMember(req, idParam(req), 'editor');
    const img = await receiveImage(req);
    try {
      const key = `public/covers/series/${s.id}/banner-${Date.now().toString(36)}.webp`;
      await storeWebp(key, img.path, 1920, 600);
      await exec('update series set banner_key = $2, updated_at = now() where id = $1', [s.id, key]);
      if (s.banner_key) await (await storage()).del(s.banner_key).catch(() => {});
      return { banner_url: await publicUrl(key) };
    } finally {
      await img.cleanup();
    }
  });

  app.delete('/api/studio/series/:id/banner', async (req) => {
    const s = await requireSeriesMember(req, idParam(req), 'editor');
    await exec('update series set banner_key = null, updated_at = now() where id = $1', [s.id]);
    if (s.banner_key) await (await storage()).del(s.banner_key).catch(() => {});
    return { ok: true };
  });

  // ------------------------------------------------------------ language editions

  app.get('/api/studio/series/:id/editions', async (req) => {
    const s = await requireSeriesMember(req, idParam(req), 'analyst');
    return { primary_language: s.language, editions: await q(`select ${editionCols} from series_editions where series_id = $1 order by language`, [s.id]) };
  });

  app.put('/api/studio/series/:id/editions/:language', async (req) => {
    const s = await requireSeriesMember(req, idParam(req), 'editor');
    const lang = parse(language, (req.params as { language: string }).language);
    const body = parse(
      z.object({
        title: z.string().trim().min(1, 'Give this edition a title').max(150),
        description: z.string().trim().max(1800).optional(),
        access_model: z.enum(['blocked', 'free', 'premium']).nullable().optional(),
      }),
      req.body,
    );
    const edition = await one(
      `insert into series_editions (series_id, language, title, description, access_model) values ($1,$2,$3,$4,$5)
       on conflict (series_id, language) do update set title = excluded.title,
         description = case when $6 then excluded.description else series_editions.description end,
         access_model = case when $7 then excluded.access_model else series_editions.access_model end
       returning ${editionCols}`,
      [s.id, lang, body.title, body.description ?? '', body.access_model ?? null, body.description !== undefined, body.access_model !== undefined],
    );
    return { edition };
  });

  app.delete('/api/studio/series/:id/editions/:language', async (req) => {
    const s = await requireSeriesMember(req, idParam(req), 'editor');
    const lang = (req.params as { language: string }).language;
    const used = await one<{ n: number }>('select count(*)::int as n from releases where series_id = $1 and language = $2 and deleted_at is null', [s.id, lang]);
    if (used!.n) throw conflict(`This edition still has ${used!.n} release${used!.n === 1 ? '' : 's'}. Delete or move them first.`);
    const n = await exec('delete from series_editions where series_id = $1 and language = $2', [s.id, lang]);
    if (!n) throw notFound('Edition not found');
    return { ok: true };
  });

  // ------------------------------------------------------------ country rules

  const rule = z.object({
    country: z.string().trim().toUpperCase().regex(/^[A-Z]{2}$/, 'Use a 2-letter country code'),
    language: language.nullable().optional(),
    rule: z.enum(['blocked', 'free', 'premium']),
    enabled: z.boolean().optional(),
  });

  app.get('/api/studio/series/:id/country-rules', async (req) => {
    const s = await requireSeriesMember(req, idParam(req), 'analyst');
    return { country_rules: await q(`select ${ruleCols} from country_rules where series_id = $1 order by country, language nulls first`, [s.id]) };
  });

  const ruleClash = (seriesId: string, country: string, lang: string | null, except: string | null) =>
    one(
      `select 1 from country_rules where series_id = $1 and country = $2 and language is not distinct from $3 and ($4::uuid is null or id <> $4)`,
      [seriesId, country, lang, except],
    );

  app.post('/api/studio/series/:id/country-rules', async (req, reply) => {
    const s = await requireSeriesMember(req, idParam(req), 'editor');
    const body = parse(rule, req.body);
    if (await ruleClash(s.id, body.country, body.language ?? null, null)) throw conflict('There is already a rule for that country. Edit it instead.');
    const row = await one(
      `insert into country_rules (series_id, country, language, rule, enabled) values ($1,$2,$3,$4,$5) returning ${ruleCols}`,
      [s.id, body.country, body.language ?? null, body.rule, body.enabled ?? true],
    );
    reply.code(201);
    return { country_rule: row };
  });

  app.patch('/api/studio/series/:id/country-rules/:ruleId', async (req) => {
    const s = await requireSeriesMember(req, idParam(req), 'editor');
    const ruleId = idParam(req, 'ruleId');
    const cur = await one(`select ${ruleCols} from country_rules where id = $1 and series_id = $2`, [ruleId, s.id]);
    if (!cur) throw notFound('Rule not found');
    const body = parse(rule.partial(), req.body);
    const country = body.country ?? cur.country;
    const lang = body.language !== undefined ? body.language : cur.language;
    if (await ruleClash(s.id, country, lang, ruleId)) throw conflict('There is already a rule for that country. Edit it instead.');
    const { sets, values } = patch(body, ['country', 'language', 'rule', 'enabled'], 2);
    if (!sets.length) return { country_rule: cur };
    return { country_rule: await one(`update country_rules set ${sets.join(', ')} where id = $1 returning ${ruleCols}`, [ruleId, ...values]) };
  });

  app.delete('/api/studio/series/:id/country-rules/:ruleId', async (req) => {
    const s = await requireSeriesMember(req, idParam(req), 'editor');
    const n = await exec('delete from country_rules where id = $1 and series_id = $2', [idParam(req, 'ruleId'), s.id]);
    if (!n) throw notFound('Rule not found');
    return { ok: true };
  });

  // ------------------------------------------------------------ contributors

  const contributor = z.object({
    name: z.string().trim().min(1, 'Enter the contributor\'s name').max(120),
    role: z.string().trim().min(1, 'Choose a role').max(40),
    // Link the credit to an NSFWComix account.
    username: z.string().trim().max(24).nullable().optional(),
    // Null = credited on the whole series; otherwise on one release.
    release_id: z.string().refine(isUuid, 'Unknown release').nullable().optional(),
    position: z.number().int().min(0).max(1000).optional(),
  });

  const resolveContributor = async (seriesId: string, body: { username?: string | null; release_id?: string | null }) => {
    let userId: string | null | undefined;
    if (body.username !== undefined) {
      userId = null;
      if (body.username) {
        const u = await one<{ id: string }>('select id from users where lower(username) = lower($1) and deleted_at is null', [body.username]);
        if (!u) throw badRequest(`No account with the username "${body.username}"`);
        userId = u.id;
      }
    }
    if (body.release_id && !(await one('select 1 from releases where id = $1 and series_id = $2 and deleted_at is null', [body.release_id, seriesId]))) {
      throw badRequest('That release does not belong to this series');
    }
    return userId;
  };

  app.get('/api/studio/series/:id/contributors', async (req) => {
    const s = await requireSeriesMember(req, idParam(req), 'analyst');
    return { contributors: await contributorsOf(s.id), roles: CONTRIBUTOR_ROLES };
  });

  app.post('/api/studio/series/:id/contributors', async (req, reply) => {
    const s = await requireSeriesMember(req, idParam(req), 'editor');
    const body = parse(contributor, req.body);
    const userId = await resolveContributor(s.id, body);
    const next = await one<{ p: number }>(
      'select coalesce(max(position), -1) + 1 as p from contributors where series_id = $1 and release_id is not distinct from $2',
      [s.id, body.release_id ?? null],
    );
    const row = await one<{ id: string }>(
      `insert into contributors (series_id, release_id, name, role, user_id, position) values ($1,$2,$3,$4,$5,$6) returning id`,
      [s.id, body.release_id ?? null, body.name, body.role, userId ?? null, body.position ?? next!.p],
    );
    reply.code(201);
    return { contributor: (await contributorsOf(s.id)).find((c) => c.id === row!.id) };
  });

  app.patch('/api/studio/series/:id/contributors/:contributorId', async (req) => {
    const s = await requireSeriesMember(req, idParam(req), 'editor');
    const cid = idParam(req, 'contributorId');
    if (!(await one('select 1 from contributors where id = $1 and series_id = $2', [cid, s.id]))) throw notFound('Contributor not found');
    const body = parse(contributor.partial(), req.body) as Row;
    const userId = await resolveContributor(s.id, body);
    if (userId !== undefined) body.user_id = userId;
    const { sets, values } = patch(body, ['name', 'role', 'release_id', 'position', 'user_id'], 2);
    if (sets.length) await exec(`update contributors set ${sets.join(', ')} where id = $1`, [cid, ...values]);
    return { contributor: (await contributorsOf(s.id)).find((c) => c.id === cid) };
  });

  app.delete('/api/studio/series/:id/contributors/:contributorId', async (req) => {
    const s = await requireSeriesMember(req, idParam(req), 'editor');
    const n = await exec('delete from contributors where id = $1 and series_id = $2', [idParam(req, 'contributorId'), s.id]);
    if (!n) throw notFound('Contributor not found');
    return { ok: true };
  });

  // ------------------------------------------------------------ forum moderators

  app.get('/api/studio/series/:id/moderators', async (req) => {
    const s = await requireSeriesMember(req, idParam(req), 'analyst');
    return { forum_enabled: s.forum_enabled, forum_description: s.forum_description, moderators: await moderatorsOf(s) };
  });

  app.post('/api/studio/series/:id/moderators', async (req, reply) => {
    const s = await requireSeriesMember(req, idParam(req), 'editor');
    const body = parse(z.object({ username: z.string().trim().min(1, 'Enter a username').max(24) }), req.body);
    const u = await one<{ id: string }>('select id from users where lower(username) = lower($1) and deleted_at is null and banned_at is null', [body.username.replace(/^@/, '')]);
    if (!u) throw badRequest(`No account with the username "${body.username}"`);
    const n = await exec('insert into forum_moderators (series_id, user_id) values ($1,$2) on conflict do nothing', [s.id, u.id]);
    if (!n) throw conflict('That person already moderates this forum');
    audit(req, 'series.moderator_add', { kind: 'series', id: s.id }, { userId: u.id });
    reply.code(201);
    return { moderators: await moderatorsOf(s) };
  });

  app.delete('/api/studio/series/:id/moderators/:userId', async (req) => {
    const s = await requireSeriesMember(req, idParam(req), 'editor');
    const n = await exec('delete from forum_moderators where series_id = $1 and user_id = $2', [s.id, idParam(req, 'userId')]);
    if (!n) throw notFound('That person does not moderate this forum');
    audit(req, 'series.moderator_remove', { kind: 'series', id: s.id }, { userId: idParam(req, 'userId') });
    return { moderators: await moderatorsOf(s) };
  });

  // ------------------------------------------------------------ revenue splits (admin / owner)

  const splitTotal = async (seriesId: string, except: string | null) =>
    (await one<{ n: number }>('select coalesce(sum(share_bps), 0)::int as n from revenue_splits where series_id = $1 and ($2::uuid is null or id <> $2)', [seriesId, except]))!.n;
  const shareBps = z.number().int().min(1, 'A split must be at least 0.01%').max(10000, 'A split cannot be more than 100%');

  app.get('/api/studio/series/:id/splits', async (req) => {
    const s = await requireSeriesMember(req, idParam(req), 'admin');
    const splits = await splitsOf(s.id);
    const total = splits.reduce((n, x) => n + x.share_bps, 0);
    return { splits, total_bps: total, kept_bps: 10000 - total };
  });

  app.post('/api/studio/series/:id/splits', async (req, reply) => {
    const s = await requireSeriesMember(req, idParam(req), 'admin');
    const body = parse(z.object({ payee_slug: z.string().trim().toLowerCase().min(1).max(60), share_bps: shareBps, note: z.string().trim().max(200).optional() }), req.body);
    const payee = await one<{ id: string }>('select id from publishers where slug = $1 and deleted_at is null', [body.payee_slug]);
    if (!payee) throw badRequest(`No brand with the URL "${body.payee_slug}"`);
    if (payee.id === s.publisher_id) throw badRequest('This brand already keeps whatever is not split. Choose a collaborator\'s brand.');
    if (await one('select 1 from revenue_splits where series_id = $1 and payee_publisher_id = $2', [s.id, payee.id])) {
      throw conflict('That brand already has a split on this series. Edit it instead.');
    }
    if ((await splitTotal(s.id, null)) + body.share_bps > 10000) throw badRequest('Splits on a series cannot add up to more than 100%');
    const row = await one<{ id: string }>(
      'insert into revenue_splits (series_id, payee_publisher_id, share_bps, note) values ($1,$2,$3,$4) returning id',
      [s.id, payee.id, body.share_bps, body.note ?? ''],
    );
    audit(req, 'series.split_add', { kind: 'series', id: s.id }, { payee: payee.id, share_bps: body.share_bps });
    reply.code(201);
    return { split: (await splitsOf(s.id)).find((x) => x.id === row!.id) };
  });

  app.patch('/api/studio/series/:id/splits/:splitId', async (req) => {
    const s = await requireSeriesMember(req, idParam(req), 'admin');
    const splitId = idParam(req, 'splitId');
    if (!(await one('select 1 from revenue_splits where id = $1 and series_id = $2', [splitId, s.id]))) throw notFound('Split not found');
    const body = parse(z.object({ share_bps: shareBps.optional(), note: z.string().trim().max(200).optional() }), req.body);
    if (body.share_bps !== undefined && (await splitTotal(s.id, splitId)) + body.share_bps > 10000) {
      throw badRequest('Splits on a series cannot add up to more than 100%');
    }
    const { sets, values } = patch(body, ['share_bps', 'note'], 2);
    if (sets.length) await exec(`update revenue_splits set ${sets.join(', ')} where id = $1`, [splitId, ...values]);
    audit(req, 'series.split_update', { kind: 'series', id: s.id }, { splitId, ...body });
    return { split: (await splitsOf(s.id)).find((x) => x.id === splitId) };
  });

  app.delete('/api/studio/series/:id/splits/:splitId', async (req) => {
    const s = await requireSeriesMember(req, idParam(req), 'admin');
    const splitId = idParam(req, 'splitId');
    const n = await exec('delete from revenue_splits where id = $1 and series_id = $2', [splitId, s.id]);
    if (!n) throw notFound('Split not found');
    audit(req, 'series.split_remove', { kind: 'series', id: s.id }, { splitId });
    return { ok: true };
  });

  // ------------------------------------------------------------ embeddable widgets: "Read now" button and cover card

  const WIDGET_SIZES = { small: { width: 140, height: 40 }, medium: { width: 180, height: 48 }, large: { width: 240, height: 60 } } as const;
  // The card is 360px at most and shrinks with its container; 180px fits the 2:3 cover, padding, border and a title that wraps.
  const CARD_SIZE = { width: 360, height: 180 } as const;

  app.get('/api/studio/series/:id/widget', async (req) => {
    const s = await requireSeriesMember(req, idParam(req), 'analyst');
    const query = parse(
      z.object({
        color: z.string().regex(/^#?[0-9a-fA-F]{6}$/, 'Use a colour like 1a1c20').optional(),
        size: z.enum(['small', 'medium', 'large']).optional(),
        label: z.string().trim().max(40).optional(),
        theme: z.enum(['light', 'dark']).optional(),
      }),
      req.query,
    );
    const color = (query.color ?? '1a1c20').replace('#', '').toLowerCase();
    const size = query.size ?? 'medium';
    const theme = query.theme ?? 'light';
    const label = query.label ?? '';
    const { width, height } = WIDGET_SIZES[size];
    const attr = (v: string) => v.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
    const slug = encodeURIComponent(s.slug);
    const url = `${config.appUrl}/widgets/read-now/${slug}?color=${color}&size=${size}${label ? `&label=${encodeURIComponent(label)}` : ''}`;
    const cardUrl = `${config.appUrl}/widgets/card/${slug}?color=${color}&theme=${theme}`;
    const site = (await getSetting('site')).name;
    // The public widget routes only serve series a visitor could open, and never adult ones.
    const unavailable = s.takedown_at
      ? 'This series has been taken down, so its widgets show "not available".'
      : s.visibility === 'draft'
        ? 'This series is still a draft. The widgets show "not available" until it is public or unlisted.'
        : s.mature
          ? 'Widgets are not available for adult series, because they would show on sites that have not asked visitors their age.'
          : null;
    return {
      color,
      size,
      theme,
      label,
      sizes: WIDGET_SIZES,
      available: unavailable === null,
      unavailable_reason: unavailable,
      read_now: {
        url,
        width,
        height,
        html: `<iframe src="${attr(url)}" width="${width}" height="${height}" title="${attr(`Read ${s.title} on ${site}`)}" style="border:0;overflow:hidden" scrolling="no" loading="lazy"></iframe>`,
      },
      card: {
        url: cardUrl,
        ...CARD_SIZE,
        html: `<iframe src="${attr(cardUrl)}" width="${CARD_SIZE.width}" height="${CARD_SIZE.height}" title="${attr(`${s.title} on ${site}`)}" style="border:0;max-width:100%;overflow:hidden" scrolling="no" loading="lazy"></iframe>`,
      },
      series_url: `${config.appUrl}/series/${s.slug}`,
    };
  });
}
