import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { config } from '../config.ts';
import { exec, one, patch, q, tx } from '../db.ts';
import type { Row } from '../db.ts';
import { audit, badRequest, conflict, forbidden, parse, requireMember, requireReleaseMember, requireSeriesMember } from '../lib/http.ts';
import { coverUrls, idParam, isUuid, publishRelease } from '../lib/ingest.ts';
import { AUDIENCES, CONTENT_RATINGS, LANGUAGES, RELEASE_GROUPS, RELEASE_KINDS, THEMES } from '../lib/taxonomy.ts';

/** Studio: releases of a series (create, metadata table, pricing, publishing, private preview). */

const LANGUAGE_CODES = LANGUAGES.map((l) => l.code) as string[];
const KIND_INFO = new Map<string, { label: string; group: string }>(
  RELEASE_GROUPS.flatMap((g) => g.kinds.map((k) => [k.id, { label: k.label, group: g.group }] as [string, { label: string; group: string }])),
);

/** Accepts ISBN-10 or ISBN-13 with or without dashes; returns the bare digits, or null when the check digit is wrong. */
export function normaliseIsbn(input: string): string | null {
  const s = input.replace(/[\s-]/g, '').toUpperCase();
  if (/^\d{9}[\dX]$/.test(s)) {
    let sum = 0;
    for (let i = 0; i < 10; i++) sum += (s[i] === 'X' ? 10 : Number(s[i])) * (10 - i);
    return sum % 11 === 0 ? s : null;
  }
  if (/^\d{13}$/.test(s)) {
    let sum = 0;
    for (let i = 0; i < 13; i++) sum += Number(s[i]) * (i % 2 ? 3 : 1);
    return sum % 10 === 0 ? s : null;
  }
  return null;
}

const pick = (list: readonly string[], max: number, what: string) =>
  z
    .array(z.string().refine((v) => list.includes(v), `Unknown ${what}`))
    .max(max, `Choose at most ${max} ${what}s`)
    .transform((v) => [...new Set(v)]);

const instant = z
  .string()
  .refine((v) => !Number.isNaN(Date.parse(v)), 'Use a date and time like 2027-03-14T18:00:00Z')
  .transform((v) => new Date(v).toISOString());

const releaseFields = z.object({
  title: z.string().trim().min(1, 'Give the release a title').max(200),
  synopsis: z.string().trim().max(1800, 'Synopsis can be at most 1800 characters'),
  kind: z.string().refine((v) => RELEASE_KINDS.includes(v), 'Unknown release type'),
  language: z.string().refine((v) => LANGUAGE_CODES.includes(v), 'Unknown language'),
  number: z.number().min(0).max(99999).refine((v) => Math.abs(v * 100 - Math.round(v * 100)) < 1e-6, 'Use at most 2 decimals'),
  mature: z.boolean(),
  isbn: z
    .string()
    .trim()
    .max(20)
    .transform((v, ctx) => {
      if (v === '') return null;
      const isbn = normaliseIsbn(v);
      if (!isbn) {
        ctx.addIssue({ code: 'custom', message: 'That is not a valid ISBN-10 or ISBN-13 (check the digits)' });
        return z.NEVER;
      }
      return isbn;
    })
    .nullable(),
  print_url: z
    .string()
    .trim()
    .max(500)
    .refine((v) => v === '' || (/^https?:\/\//i.test(v) && URL.canParse(v)), 'Enter a full link starting with https://')
    .transform((v) => (v === '' ? null : v))
    .nullable(),
  orig_pub_date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a date like 2027-03-14')
    .refine((v) => !Number.isNaN(Date.parse(v)), 'That date does not exist')
    .nullable(),
  audiences: pick(AUDIENCES, 3, 'audience'),
  themes: pick(THEMES, 6, 'theme'),
  content_ratings: pick(CONTENT_RATINGS, CONTENT_RATINGS.length, 'content rating'),
  // null = use the series default price; 0 = not sold on its own.
  price_cents: z.number().int().min(0).max(100_000).nullable(),
  // null / 0 = download not for sale.
  download_price_cents: z.number().int().min(0).max(100_000).nullable(),
  download_discount_pct: z.number().int().min(1).max(100).nullable(),
  force_free: z.boolean(),
  free_at: instant.nullable(),
  // null = follow the series free-preview rule.
  free_pages: z.number().int().min(0).max(5000).nullable(),
  spread_pref: z.enum(['first', 'last']),
  single_cover: z.boolean(),
});
const RELEASE_COLUMNS = Object.keys(releaseFields.shape);

async function releaseView(r: Row) {
  const info = KIND_INFO.get(r.kind);
  return {
    id: r.id, series_id: r.series_id, number: r.number, kind: r.kind, kind_label: info?.label ?? r.kind, group: info?.group ?? null,
    language: r.language, title: r.title, synopsis: r.synopsis, mature: r.mature, status: r.status, publish_at: r.publish_at,
    published_at: r.published_at, price_cents: r.price_cents, download_price_cents: r.download_price_cents,
    download_discount_pct: r.download_discount_pct, force_free: r.force_free, free_at: r.free_at, free_pages: r.free_pages,
    themes: r.themes, audiences: r.audiences, content_ratings: r.content_ratings, isbn: r.isbn, print_url: r.print_url,
    orig_pub_date: r.orig_pub_date, page_count: r.page_count, cover_page_id: r.cover_page_id, ...(await coverUrls(r.cover_key)),
    spread_pref: r.spread_pref, single_cover: r.single_cover, url: `${config.appUrl}/read/${r.id}`,
    created_at: r.created_at, updated_at: r.updated_at,
  };
}

const duplicateNumber = (e: unknown): never => {
  if ((e as { code?: string }).code === '23505') throw conflict('Another release of the same type already has that number in this language');
  throw e;
};

export default async function (app: FastifyInstance) {
  app.get('/api/studio/series/:id/releases', async (req) => {
    const s = await requireSeriesMember(req, idParam(req), 'analyst');
    const query = parse(z.object({ language: z.string().max(10).optional() }), req.query);
    const rows = await q(
      `select r.*,
              (select count(*)::int from pages p where p.release_id = r.id and p.frames_source = 'none') as frames_missing,
              (select count(*)::int from contributors c where c.release_id = r.id) as contributor_count,
              (select row_to_json(j) from (
                 select id, kind, status, done, total from jobs
                  where release_id = r.id and status in ('queued','running') order by created_at limit 1) j) as active_job
         from releases r
        where r.series_id = $1 and r.deleted_at is null and ($2::text is null or r.language = $2)
        order by r.language, array_position($3::text[], r.kind), r.number, r.created_at`,
      [s.id, query.language ?? null, RELEASE_KINDS],
    );
    const releases = [];
    for (const r of rows) {
      releases.push({ ...(await releaseView(r)), frames_missing: r.frames_missing, contributor_count: r.contributor_count, active_job: r.active_job });
    }
    return { series: { id: s.id, title: s.title, slug: s.slug, language: s.language, reading_dir: s.reading_dir }, releases, groups: RELEASE_GROUPS };
  });

  app.post('/api/studio/series/:id/releases', async (req, reply) => {
    const s = await requireSeriesMember(req, idParam(req), 'editor');
    const body = parse(releaseFields.partial(), req.body) as Row;
    body.kind ??= s.layout === 'vertical' ? 'episode' : 'issue';
    body.language ??= s.language;
    body.mature ??= s.mature;
    let release: Row | null = null;
    for (let attempt = 0; attempt < 4 && !release; attempt++) {
      const row = { ...body };
      if (row.number === undefined) {
        // Each release type keeps its own sequence per language.
        const next = await one<{ n: number }>(
          `select coalesce(floor(max(number)), 0) + 1 as n from releases where series_id = $1 and kind = $2 and language = $3 and deleted_at is null`,
          [s.id, row.kind, row.language],
        );
        row.number = next!.n;
      }
      row.title ??= `${KIND_INFO.get(row.kind)?.label ?? 'Release'} ${row.number}`;
      const { sets, values } = patch(row, RELEASE_COLUMNS, 2);
      try {
        release = await one(
          `insert into releases (series_id, ${sets.map((x) => x.split(' = ')[0]).join(', ')})
           values ($1, ${sets.map((x) => x.split(' = ')[1]).join(', ')}) returning *`,
          [s.id, ...values],
        );
      } catch (e) {
        if ((e as { code?: string }).code !== '23505' || body.number !== undefined) duplicateNumber(e);
      }
    }
    if (!release) throw conflict('Could not find a free number for this release. Try again.');
    if (release.language !== s.language) {
      // A release in a new language opens that language edition of the series.
      await exec(
        `insert into series_editions (series_id, language, title, description) values ($1,$2,$3,$4) on conflict do nothing`,
        [s.id, release.language, s.title, s.description],
      );
    }
    audit(req, 'release.create', { kind: 'release', id: release.id });
    reply.code(201);
    return { release: await releaseView(release) };
  });

  app.get('/api/studio/releases/:id', async (req) => {
    const r = await requireReleaseMember(req, idParam(req), 'analyst');
    const [contributors, brand, missing] = await Promise.all([
      q(
        `select c.id, c.name, c.role, c.position, c.user_id, u.username
           from contributors c left join users u on u.id = c.user_id where c.release_id = $1 order by c.position, c.id`,
        [r.id],
      ),
      one('select id, slug, name from publishers where id = $1', [r.publisher_id]),
      one<{ n: number }>(`select count(*)::int as n from pages where release_id = $1 and frames_source = 'none'`, [r.id]),
    ]);
    const series = await one('select id, slug, title, language, reading_dir, layout, access_model, cover_key from series where id = $1', [r.series_id]);
    return {
      release: { ...(await releaseView(r)), frames_missing: missing!.n },
      series: { id: series!.id, slug: series!.slug, title: series!.title, language: series!.language, reading_dir: series!.reading_dir, layout: series!.layout,
                access_model: series!.access_model, has_cover: Boolean(series!.cover_key) },
      brand,
      contributors,
    };
  });

  app.patch('/api/studio/releases/:id', async (req) => {
    const r = await requireReleaseMember(req, idParam(req), 'editor');
    const body = parse(releaseFields.partial(), req.body);
    const { sets, values } = patch(body, RELEASE_COLUMNS, 2);
    if (!sets.length) return { release: await releaseView(r) };
    const updated = await one(`update releases set ${sets.join(', ')}, updated_at = now() where id = $1 returning *`, [r.id, ...values]).catch(duplicateNumber);
    audit(req, 'release.update', { kind: 'release', id: r.id }, { fields: Object.keys(body) });
    return { release: await releaseView(updated!) };
  });

  /** The metadata / pricing table: every edited row saved with one request, all or nothing. */
  app.put('/api/studio/series/:id/releases/bulk', async (req) => {
    const s = await requireSeriesMember(req, idParam(req), 'editor');
    const body = parse(
      z.object({
        releases: z
          .array(releaseFields.partial().extend({ id: z.string().refine(isUuid, 'Unknown release') }))
          .min(1, 'Nothing to save')
          .max(500),
      }),
      req.body,
    );
    const ids = body.releases.map((r) => r.id);
    if (new Set(ids).size !== ids.length) throw badRequest('The same release appears twice in this save');
    const updated = await tx(async (db) => {
      const found = await db.query('select id, number from releases where series_id = $1 and deleted_at is null and id = any($2::uuid[]) for update', [s.id, ids]);
      if (found.rowCount !== ids.length) throw badRequest('One of these releases is not part of this series');
      const original = new Map<string, number>(found.rows.map((r) => [r.id, r.number]));
      // Numbers may be swapped between rows: park the ones that move first so the swap never collides.
      const moving = new Set(body.releases.filter((r) => r.number !== undefined || r.kind !== undefined || r.language !== undefined).map((r) => r.id));
      let parked = 0;
      for (const id of moving) await db.query('update releases set number = $2 where id = $1', [id, -1 - parked++]);
      const out: Row[] = [];
      for (const row of body.releases) {
        const { id, ...fields } = row;
        if (moving.has(id) && fields.number === undefined) fields.number = original.get(id);
        const { sets, values } = patch(fields, RELEASE_COLUMNS, 2);
        if (!sets.length) continue;
        out.push((await db.query(`update releases set ${sets.join(', ')}, updated_at = now() where id = $1 returning *`, [id, ...values])).rows[0]);
      }
      return out;
    }).catch(duplicateNumber);
    audit(req, 'release.bulk_update', { kind: 'series', id: s.id }, { count: updated.length });
    const releases = [];
    for (const r of updated) releases.push(await releaseView(r));
    return { releases };
  });

  /** Renumber one type in one language as 1..n in the order given. */
  app.put('/api/studio/series/:id/releases/order', async (req) => {
    const s = await requireSeriesMember(req, idParam(req), 'editor');
    const body = parse(
      z.object({
        kind: z.string().refine((v) => RELEASE_KINDS.includes(v), 'Unknown release type'),
        language: z.string().max(10).optional(),
        ids: z.array(z.string().refine(isUuid, 'Unknown release')).min(1).max(2000),
      }),
      req.body,
    );
    const lang = body.language ?? s.language;
    if (new Set(body.ids).size !== body.ids.length) throw badRequest('The same release appears twice in the new order');
    await tx(async (db) => {
      const cur = await db.query(
        'select id from releases where series_id = $1 and kind = $2 and language = $3 and deleted_at is null for update',
        [s.id, body.kind, lang],
      );
      const have = new Set(cur.rows.map((r) => r.id));
      if (have.size !== body.ids.length || body.ids.some((id) => !have.has(id))) {
        throw badRequest('The new order must list every release of this type exactly once. Reload and try again.');
      }
      await db.query('update releases set number = -number - 1 where id = any($1::uuid[])', [body.ids]);
      await db.query(
        `update releases r set number = x.ord, updated_at = now()
           from unnest($1::uuid[]) with ordinality as x(id, ord) where r.id = x.id`,
        [body.ids],
      );
    }).catch(duplicateNumber);
    audit(req, 'release.reorder', { kind: 'series', id: s.id }, { kind: body.kind, language: lang });
    return { ok: true, order: body.ids.map((id, i) => ({ id, number: i + 1 })) };
  });

  // ------------------------------------------------------------ publishing

  app.post('/api/studio/releases/:id/publish', async (req) => {
    const r = await requireReleaseMember(req, idParam(req), 'editor');
    const body = parse(z.object({ publish_at: instant.nullable().optional() }), req.body ?? {});
    const series = await one('select takedown_at from series where id = $1', [r.series_id]);
    if (series?.takedown_at) throw forbidden('This series has been taken down by AltComix. Contact support before publishing to it.');
    if (!r.page_count) throw badRequest('Add at least one page before publishing');
    if (body.publish_at && Date.parse(body.publish_at) > Date.now() + 30_000) {
      if (r.status === 'published') throw badRequest('This release is already published. Unpublish it first to schedule it.');
      const row = await one(`update releases set status = 'scheduled', publish_at = $2, updated_at = now() where id = $1 returning *`, [r.id, body.publish_at]);
      audit(req, 'release.schedule', { kind: 'release', id: r.id }, { publish_at: body.publish_at });
      return { release: await releaseView(row!), first_publish: false };
    }
    const first = !r.published_at;
    const row = await publishRelease(r.id);
    audit(req, 'release.publish', { kind: 'release', id: r.id });
    return { release: await releaseView((await one('select * from releases where id = $1', [row.id]))!), first_publish: first };
  });

  app.post('/api/studio/releases/:id/unpublish', async (req) => {
    const r = await requireReleaseMember(req, idParam(req), 'editor');
    const row = await one(`update releases set status = 'draft', publish_at = null, updated_at = now() where id = $1 returning *`, [r.id]);
    audit(req, 'release.unpublish', { kind: 'release', id: r.id }, { was: r.status });
    return { release: await releaseView(row!) };
  });

  // ------------------------------------------------------------ private preview link

  const previewUrl = (id: string, token: string) => `${config.appUrl}/read/${id}?preview=${token}`;

  app.get('/api/studio/releases/:id/preview-link', async (req) => {
    const r = await requireReleaseMember(req, idParam(req), 'editor');
    return { url: previewUrl(r.id, r.private_token) };
  });

  /** Replace the token: every link shared before stops working. */
  app.post('/api/studio/releases/:id/preview-link/rotate', async (req) => {
    const r = await requireReleaseMember(req, idParam(req), 'editor');
    const row = await one<{ private_token: string }>(
      `update releases set private_token = encode(uuid_send(uuidv4()), 'hex') where id = $1 returning private_token`,
      [r.id],
    );
    audit(req, 'release.preview_rotate', { kind: 'release', id: r.id });
    return { url: previewUrl(r.id, row!.private_token) };
  });

  // ------------------------------------------------------------ delete

  app.delete('/api/studio/releases/:id', async (req) => {
    const r = await requireReleaseMember(req, idParam(req), 'editor');
    // Readers may own a release that has been on sale, so removing one is an admin decision.
    if (r.published_at) await requireMember(req, r.publisher_id, 'admin');
    await exec(`update releases set deleted_at = now(), status = 'draft', publish_at = null, updated_at = now() where id = $1`, [r.id]);
    audit(req, 'release.delete', { kind: 'release', id: r.id }, { title: r.title });
    return { ok: true };
  });
}
