import { once } from 'node:events';
import { PassThrough } from 'node:stream';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { Zip, ZipPassThrough } from 'fflate';
import { z } from 'zod';
import { exec, one, patch, q, tx } from '../db.ts';
import type { Row } from '../db.ts';
import { canView, releaseAccess } from '../lib/access.ts';
import { captureError } from '../lib/errors.ts';
import { HttpError, audit, badRequest, conflict, isAdmin, notFound, parse, requireReleaseMember } from '../lib/http.ts';
import type { MemberRole } from '../lib/http.ts';
import {
  acceptUpload, coverUrls, deletePages, detectPageFrames, idParam, isUuid, kickJobs, queueArchiveJob, queueDetectJob, receiveMultipart,
  refreshReleaseCover, setSeriesCoverFromPage,
} from '../lib/ingest.ts';
import { RefineError, analysePage, detectFromGrey, frameSchema, framesSchema, normaliseFrame, orderFrames, refineFrame, smartFrame } from '../lib/panels.ts';
import type { Analysis, Frame } from '../lib/panels.ts';
import { storage } from '../lib/storage.ts';

/** Studio: uploads and ingestion, the page grid, and the frame editor. */

const VARIANTS = ['original', 'thumb', 'medium', 'full'] as const;
const imageUrl = (pageId: string, variant: (typeof VARIANTS)[number]) => `/api/studio/pages/${pageId}/image/${variant}`;

type Spread = { spread: number | null; side: 'single' | 'left' | 'right' | 'wide' };

/**
 * Double-page pairing. A page wider than tall is already a spread. The cover
 * stands alone when `single_cover` is on. Every run of upright pages in
 * between is paired two by two; when a run has an odd page out, `spread_pref`
 * says which end stays single ('last' keeps the last two together).
 */
export function computeSpreads(
  pages: { width: number; height: number }[],
  opts: { spread_pref: 'first' | 'last'; single_cover: boolean; reading_dir: 'ltr' | 'rtl'; layout: string },
): Spread[] {
  const out: Spread[] = pages.map((p) => ({ spread: null, side: p.width > p.height ? 'wide' : 'single' }));
  if (opts.layout === 'vertical') return out.map(() => ({ spread: null, side: 'single' as const }));
  let n = 0;
  const pairRun = (from: number, to: number) => {
    let i = from;
    if ((to - from + 1) % 2 === 1 && opts.spread_pref === 'last') i++;
    for (; i + 1 <= to; i += 2) {
      n++;
      out[i] = { spread: n, side: opts.reading_dir === 'rtl' ? 'right' : 'left' };
      out[i + 1] = { spread: n, side: opts.reading_dir === 'rtl' ? 'left' : 'right' };
    }
  };
  let start = opts.single_cover ? 1 : 0;
  for (let i = start; i <= pages.length; i++) {
    if (i === pages.length || out[i].side === 'wide') {
      if (i - 1 >= start) pairRun(start, i - 1);
      start = i + 1;
    }
  }
  return out;
}

const framesStatus = (p: Row) => (p.frames_source === 'none' ? 'missing' : p.frames_source);

const jobView = (j: Row) => ({
  id: j.id, kind: j.kind, status: j.status, done: j.done, total: j.total, error: j.error, source: j.payload?.source ?? null,
  filename: j.payload?.filename ?? null, skipped: j.payload?.skipped ?? [], pages_added: j.payload?.pages_added ?? null,
  detected: j.payload?.detected ?? null, kept_manual: j.payload?.kept_manual ?? null, created_at: j.created_at, finished_at: j.finished_at,
});

// Analysed pages are kept briefly so a run of smart-frame clicks on one page is instant.
const analysed = new Map<string, Analysis>();
async function analysisFor(page: Row): Promise<Analysis> {
  const hit = analysed.get(page.id);
  if (hit) {
    analysed.delete(page.id);
    analysed.set(page.id, hit);
    return hit;
  }
  const store = await storage();
  const img = (await store.read(page.variants?.medium ?? '')) ?? (await store.read(page.source_key));
  if (!img) throw notFound('The image for this page is missing');
  const a = await analysePage(img);
  analysed.set(page.id, a);
  if (analysed.size > 16) analysed.delete(analysed.keys().next().value!);
  return a;
}

/** Page + its release (with membership check). */
async function requirePage(req: FastifyRequest, min: MemberRole = 'editor'): Promise<{ page: Row; release: Row }> {
  const page = await one('select * from pages where id = $1', [idParam(req)]);
  if (!page) throw notFound('Page not found');
  const release = await requireReleaseMember(req, page.release_id, min);
  return { page, release };
}

/** Files of a purged takedown are not handed out to the brand either (rule: canView in lib/access.ts). */
async function refusePurged(req: FastifyRequest, seriesId: string): Promise<void> {
  const s = await one('select takedown_at, takedown_purge, deleted_at, visibility, mature from series where id = $1', [seriesId]);
  if (s && !canView(s, null, true, true, { admin: isAdmin(req.user) }).ok) throw notFound('This title has been removed');
}

const point = z.number().min(0).max(1);

export default async function (app: FastifyInstance) {
  // ------------------------------------------------------------ upload + ingestion

  /** Images (PNG/JPG/WebP), ZIP/CBZ archives and PDFs, in any mix. Pages are appended to the release. */
  app.post('/api/studio/releases/:id/upload', async (req, reply) => {
    const r = await requireReleaseMember(req, idParam(req), 'editor');
    const got = await receiveMultipart(req);
    try {
      const result = await acceptUpload(r.id, got.files, req.user!.id);
      audit(req, 'release.upload', { kind: 'release', id: r.id }, { files: got.files.length, bytes: got.files.reduce((n, f) => n + f.bytes, 0) });
      reply.code(202);
      return { jobs: result.jobs, archives: result.archives };
    } finally {
      await got.cleanup();
    }
  });

  app.get('/api/studio/releases/:id/jobs', async (req) => {
    const r = await requireReleaseMember(req, idParam(req), 'analyst');
    const rows = await q('select * from jobs where release_id = $1 order by created_at desc limit 30', [r.id]);
    const jobs = rows.map(jobView);
    const active = jobs.filter((j) => j.status === 'queued' || j.status === 'running');
    // A queued row with no worker on it (e.g. after a restart) is picked up here too.
    if (active.length) kickJobs();
    return {
      processing: active.length > 0,
      done: active.reduce((n, j) => n + j.done, 0),
      total: active.reduce((n, j) => n + j.total, 0),
      page_count: (await one<{ page_count: number }>('select page_count from releases where id = $1', [r.id]))!.page_count,
      jobs,
    };
  });

  app.get('/api/studio/releases/:id/archives', async (req) => {
    const r = await requireReleaseMember(req, idParam(req), 'analyst');
    const archives = await q(
      `select a.id, a.filename, a.bytes, a.created_at,
              (select count(*)::int from pages p where p.archive_id = a.id) as page_count,
              exists (select 1 from jobs j where j.release_id = a.release_id and j.status in ('queued','running')
                         and j.payload->>'archive_id' = a.id::text) as extracting
         from release_archives a where a.release_id = $1 order by a.created_at`,
      [r.id],
    );
    return { archives: archives.map((a) => ({ ...a, download_url: `/api/studio/archives/${a.id}/download` })) };
  });

  const requireArchive = async (req: FastifyRequest, min: MemberRole) => {
    const a = await one('select * from release_archives where id = $1', [idParam(req)]);
    if (!a) throw notFound('Archive not found');
    const release = await requireReleaseMember(req, a.release_id, min);
    return { archive: a, release };
  };

  /** Extract the archive again. Pages from its earlier extraction are replaced. */
  app.post('/api/studio/archives/:id/extract', async (req, reply) => {
    const { archive, release } = await requireArchive(req, 'editor');
    const busy = await one(
      `select 1 from jobs where release_id = $1 and status in ('queued','running') and payload->>'archive_id' = $2`,
      [release.id, archive.id],
    );
    if (busy) throw conflict('This archive is already being extracted');
    const job = await queueArchiveJob(release.id, archive.id, archive.filename, true, req.user!.id);
    kickJobs();
    audit(req, 'release.reextract', { kind: 'release', id: release.id }, { archive: archive.id });
    reply.code(202);
    return { job };
  });

  app.get('/api/studio/archives/:id/download', async (req, reply) => {
    const { archive, release } = await requireArchive(req, 'editor');
    await refusePurged(req, release.series_id);
    const obj = await (await storage()).get(archive.storage_key);
    if (!obj) throw notFound('The archive file is missing');
    reply
      .type(obj.contentType)
      .header('content-disposition', `attachment; filename*=UTF-8''${encodeURIComponent(archive.filename)}`)
      .header('cache-control', 'private, no-store');
    if (obj.size) reply.header('content-length', obj.size);
    return reply.send(obj.stream);
  });

  app.delete('/api/studio/archives/:id', async (req) => {
    const { archive, release } = await requireArchive(req, 'editor');
    const busy = await one(
      `select 1 from jobs where release_id = $1 and status in ('queued','running') and payload->>'archive_id' = $2`,
      [release.id, archive.id],
    );
    if (busy) throw conflict('This archive is still being extracted');
    await exec('delete from release_archives where id = $1', [archive.id]);
    await (await storage()).del(archive.storage_key).catch(() => {});
    return { ok: true };
  });

  /** Every original page file of the release as one ZIP, streamed. */
  app.get('/api/studio/releases/:id/originals.zip', async (req, reply) => {
    const r = await requireReleaseMember(req, idParam(req), 'editor');
    await refusePurged(req, r.series_id);
    const pages = await q<{ position: number; source_key: string }>('select position, source_key from pages where release_id = $1 order by position', [r.id]);
    if (!pages.length) throw notFound('This release has no pages yet');
    const store = await storage();
    const out = new PassThrough();
    const zip = new Zip((err, chunk, final) => {
      if (err) return void out.destroy(err);
      out.write(Buffer.from(chunk));
      if (final) out.end();
    });
    const width = Math.max(3, String(pages.length).length);
    (async () => {
      for (const p of pages) {
        if (out.destroyed) return;
        const buf = await store.read(p.source_key);
        if (!buf) continue;
        const entry = new ZipPassThrough(`page-${String(p.position).padStart(width, '0')}.${p.source_key.split('.').pop()}`);
        zip.add(entry);
        entry.push(buf, true);
        if (out.writableNeedDrain) await once(out, 'drain');
      }
      zip.end();
    })().catch((e) => {
      captureError(e, { source: 'api', endpoint: 'GET /api/studio/releases/:id/originals.zip' });
      out.destroy(e as Error);
    });
    const name = `${r.series_slug}-${r.kind}-${r.number}-originals.zip`.replace(/[^a-z0-9._-]+/gi, '-');
    reply.type('application/zip').header('content-disposition', `attachment; filename="${name}"`).header('cache-control', 'private, no-store');
    return reply.send(out);
  });

  // ------------------------------------------------------------ page grid

  app.get('/api/studio/releases/:id/pages', async (req) => {
    const r = await requireReleaseMember(req, idParam(req), 'analyst');
    const series = (await one('select * from series where id = $1', [r.series_id]))!;
    const rows = await q('select * from pages where release_id = $1 order by position', [r.id]);
    const spreads = computeSpreads(rows as { width: number; height: number }[], {
      spread_pref: r.spread_pref, single_cover: r.single_cover, reading_dir: series.reading_dir, layout: series.layout,
    });
    // What a visitor with no account, no purchase and no membership would get.
    const access = await releaseAccess({ series, release: r, pages: rows as { id: string; position: number; is_free: boolean | null }[], user: null, country: null });
    const coverId = r.cover_page_id ?? rows[0]?.id ?? null;
    return {
      release: { id: r.id, title: r.title, page_count: rows.length, spread_pref: r.spread_pref, single_cover: r.single_cover, cover_page_id: r.cover_page_id },
      access: { model: access.model, release_free: access.releaseFree, free_pages: access.freePages, locked_pages: access.lockedPages },
      frames_missing: rows.filter((p) => p.frames_source === 'none').length,
      pages: rows.map((p, i) => ({
        id: p.id, position: p.position, width: p.width, height: p.height, bytes: p.bytes, filename: p.filename, bg_color: p.bg_color,
        thumb_url: imageUrl(p.id, 'thumb'),
        frames_count: Array.isArray(p.frames) ? p.frames.length : 0,
        frames_status: framesStatus(p),
        // Explicit override (true / false) or null to follow the release rule; `free` is the outcome.
        is_free: p.is_free,
        free: access.pages[i] === 'free',
        is_cover: p.id === coverId,
        ...spreads[i],
      })),
    };
  });

  app.get('/api/studio/pages/:id', async (req) => {
    const { page, release } = await requirePage(req, 'analyst');
    const series = (await one('select id, title, slug, reading_dir, layout, language from series where id = $1', [release.series_id]))!;
    const around = await one(
      `select (select id from pages where release_id = $1 and position < $2 order by position desc limit 1) as prev_id,
              (select id from pages where release_id = $1 and position > $2 order by position limit 1) as next_id,
              (select id from pages where release_id = $1 order by position limit 1) as first_id,
              (select id from pages where release_id = $1 order by position desc limit 1) as last_id`,
      [release.id, page.position],
    );
    return {
      page: {
        id: page.id, release_id: page.release_id, position: page.position, filename: page.filename, bytes: page.bytes, width: page.width,
        height: page.height, dpi: page.dpi, bg_color: page.bg_color, is_free: page.is_free, created_at: page.created_at,
        status: 'processed',
        frames: page.frames, frames_status: framesStatus(page), texts: page.texts,
        urls: { original: imageUrl(page.id, 'original'), full: imageUrl(page.id, 'full'), medium: imageUrl(page.id, 'medium'), thumb: imageUrl(page.id, 'thumb') },
        is_release_cover: (release.cover_page_id ?? around!.first_id) === page.id,
      },
      release: { id: release.id, title: release.title, number: release.number, kind: release.kind, language: release.language, page_count: release.page_count, status: release.status },
      series,
      ...around,
    };
  });

  /** Streams a page image to brand members: original | thumb | medium | full. */
  app.get('/api/studio/pages/:id/image/:variant', async (req, reply) => {
    const { page, release } = await requirePage(req, 'analyst');
    await refusePurged(req, release.series_id);
    const variant = (req.params as { variant: string }).variant as (typeof VARIANTS)[number];
    if (!VARIANTS.includes(variant)) throw notFound('Unknown image size');
    const key = variant === 'original' ? page.source_key : page.variants?.[variant];
    const obj = key ? await (await storage()).get(key) : null;
    if (!obj) throw notFound('That image is missing');
    reply.type(obj.contentType).header('cache-control', 'private, max-age=86400');
    if (obj.size) reply.header('content-length', obj.size);
    if ((req.query as { download?: string }).download) {
      const name = variant === 'original' && page.filename ? page.filename : `page-${page.position}-${variant}.${key.split('.').pop()}`;
      reply.header('content-disposition', `attachment; filename*=UTF-8''${encodeURIComponent(name)}`);
    }
    return reply.send(obj.stream);
  });

  app.patch('/api/studio/pages/:id', async (req) => {
    const { page } = await requirePage(req);
    const body = parse(
      z.object({
        is_free: z.boolean().nullable().optional(),
        bg_color: z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Use a colour like #1a1c20').transform((v) => v.toLowerCase()).optional(),
      }),
      req.body,
    );
    const sets: string[] = [];
    const values: unknown[] = [];
    // `patch` skips undefined only, so a null is_free (follow the release rule) is written.
    const p = patch(body, ['is_free', 'bg_color'], 2);
    sets.push(...p.sets);
    values.push(...p.values);
    if (!sets.length) return { page: { id: page.id, is_free: page.is_free, bg_color: page.bg_color } };
    return { page: await one(`update pages set ${sets.join(', ')} where id = $1 returning id, is_free, bg_color`, [page.id, ...values]) };
  });

  app.delete('/api/studio/pages/:id', async (req) => {
    const { page, release } = await requirePage(req);
    await deletePages(release.id, [page.id]);
    analysed.delete(page.id);
    audit(req, 'page.delete', { kind: 'release', id: release.id }, { count: 1 });
    return { ok: true, deleted: 1 };
  });

  const idList = z.array(z.string().refine(isUuid, 'Unknown page')).min(1, 'Select at least one page').max(5000);

  app.post('/api/studio/releases/:id/pages/delete', async (req) => {
    const r = await requireReleaseMember(req, idParam(req), 'editor');
    const body = parse(z.object({ ids: idList }), req.body);
    const deleted = await deletePages(r.id, [...new Set(body.ids)]);
    for (const id of body.ids) analysed.delete(id);
    audit(req, 'page.delete', { kind: 'release', id: r.id }, { count: deleted });
    return { ok: true, deleted };
  });

  /** Mark pages always free (true), always locked (false), or back to the release rule (null). */
  app.post('/api/studio/releases/:id/pages/free', async (req) => {
    const r = await requireReleaseMember(req, idParam(req), 'editor');
    const body = parse(z.object({ ids: idList, is_free: z.boolean().nullable() }), req.body);
    const updated = await exec('update pages set is_free = $3 where release_id = $1 and id = any($2::uuid[])', [r.id, body.ids, body.is_free]);
    return { ok: true, updated };
  });

  app.put('/api/studio/releases/:id/pages/order', async (req) => {
    const r = await requireReleaseMember(req, idParam(req), 'editor');
    const body = parse(z.object({ ids: idList }), req.body);
    if (new Set(body.ids).size !== body.ids.length) throw badRequest('The same page appears twice in the new order');
    await tx(async (db) => {
      await db.query('select id from releases where id = $1 for update', [r.id]);
      const have = new Set((await db.query('select id from pages where release_id = $1', [r.id])).rows.map((p) => p.id));
      if (have.size !== body.ids.length || body.ids.some((id) => !have.has(id))) {
        throw badRequest('The new order must list every page of this release exactly once. Reload and try again.');
      }
      await db.query(
        `update pages p set position = x.ord from unnest($1::uuid[]) with ordinality as x(id, ord) where p.id = x.id and p.release_id = $2`,
        [body.ids, r.id],
      );
      await db.query('update releases set updated_at = now() where id = $1', [r.id]);
    });
    await refreshReleaseCover(r.id);
    return { ok: true, order: body.ids.map((id, i) => ({ id, position: i + 1 })) };
  });

  // ------------------------------------------------------------ covers

  app.post('/api/studio/pages/:id/series-cover', async (req) => {
    const { page, release } = await requirePage(req);
    const key = await setSeriesCoverFromPage(release.series_id, page);
    if (!key) throw notFound('The image for this page is missing');
    audit(req, 'series.cover', { kind: 'series', id: release.series_id }, { page: page.id });
    return coverUrls(key);
  });

  app.post('/api/studio/pages/:id/release-cover', async (req) => {
    const { page, release } = await requirePage(req);
    await exec('update releases set cover_page_id = $2, updated_at = now() where id = $1', [release.id, page.id]);
    const key = await refreshReleaseCover(release.id);
    return { cover_page_id: page.id, ...(await coverUrls(key)) };
  });

  /** Back to the default: the first page is the cover. */
  app.delete('/api/studio/releases/:id/cover', async (req) => {
    const r = await requireReleaseMember(req, idParam(req), 'editor');
    await exec('update releases set cover_page_id = null, updated_at = now() where id = $1', [r.id]);
    const key = await refreshReleaseCover(r.id);
    return { cover_page_id: null, ...(await coverUrls(key)) };
  });

  // ------------------------------------------------------------ frames

  /** Save the frames drawn in the editor (order = reading order). */
  app.put('/api/studio/pages/:id/frames', async (req) => {
    const { page, release } = await requirePage(req);
    const body = parse(z.object({ frames: framesSchema, auto_order: z.boolean().optional() }), req.body);
    let frames = body.frames.map((f) => normaliseFrame(f as Frame));
    if (body.auto_order) {
      const s = await one<{ reading_dir: 'ltr' | 'rtl' }>('select reading_dir from series where id = $1', [release.series_id]);
      frames = orderFrames(frames, s!.reading_dir);
    }
    const source = frames.length ? 'manual' : 'none';
    await exec('update pages set frames = $2, frames_source = $3 where id = $1', [page.id, JSON.stringify(frames), source]);
    return { frames, frames_status: source === 'none' ? 'missing' : source };
  });

  /** Detect frames on one page. `save: false` only suggests. */
  app.post('/api/studio/pages/:id/frames/detect', async (req) => {
    const { page, release } = await requirePage(req);
    const body = parse(z.object({ save: z.boolean().optional() }), req.body ?? {});
    const s = await one<{ reading_dir: 'ltr' | 'rtl' }>('select reading_dir from series where id = $1', [release.series_id]);
    if (body.save === false) {
      const a = await analysisFor(page);
      return { frames: detectFromGrey(a.grey, a.w, a.h, { dir: s!.reading_dir }), saved: false, frames_status: framesStatus(page) };
    }
    try {
      await detectPageFrames(page, s!.reading_dir);
    } catch (e) {
      throw new HttpError(404, (e as Error).message);
    }
    const fresh = await one('select frames from pages where id = $1', [page.id]);
    return { frames: fresh!.frames, saved: true, frames_status: 'auto' };
  });

  /** One click for the whole release. Runs as a job; pages with hand-made frames are kept unless `force`. */
  app.post('/api/studio/releases/:id/frames/detect', async (req, reply) => {
    const r = await requireReleaseMember(req, idParam(req), 'editor');
    const body = parse(z.object({ force: z.boolean().optional() }), req.body ?? {});
    if (!r.page_count) throw badRequest('This release has no pages yet');
    if (await one(`select 1 from jobs where release_id = $1 and kind = 'detect_frames' and status in ('queued','running')`, [r.id])) {
      throw conflict('Frame detection is already running for this release');
    }
    const job = await queueDetectJob(r.id, body.force ?? false, req.user!.id);
    kickJobs();
    reply.code(202);
    return { job };
  });

  /** Smart frame: the panel under a click, snapped to its gutters. */
  app.post('/api/studio/pages/:id/frames/smart', async (req) => {
    const { page } = await requirePage(req);
    const body = parse(z.object({ x: point, y: point }), req.body);
    const frame = smartFrame(await analysisFor(page), body.x, body.y);
    if (!frame) throw badRequest('That point is in the gutter between panels. Click inside a panel.');
    return { frame };
  });

  /** Grow (`add`) or cut (`remove`) a frame at a point. Returns the new frame; nothing is saved. */
  app.post('/api/studio/pages/:id/frames/refine', async (req) => {
    const { page } = await requirePage(req);
    const body = parse(z.object({ frame: frameSchema, x: point, y: point, mode: z.enum(['add', 'remove']) }), req.body);
    try {
      return { frame: refineFrame(await analysisFor(page), body.frame as Frame, body.x, body.y, body.mode) };
    } catch (e) {
      if (e instanceof RefineError) throw badRequest(e.message);
      throw e;
    }
  });

  // ------------------------------------------------------------ text regions

  app.put('/api/studio/pages/:id/texts', async (req) => {
    const { page } = await requirePage(req);
    const unit = z.number().min(0).max(1);
    const body = parse(
      z.object({
        texts: z
          .array(
            z.object({
              x: unit, y: unit, w: z.number().min(0.002).max(1), h: z.number().min(0.002).max(1),
              // Transcription per language code: { "en": "...", "fr": "..." }
              text: z.record(z.string().regex(/^[a-z]{2,3}(-[A-Za-z]{2,4})?$/, 'Use a language code like en'), z.string().max(2000)),
            }),
          )
          .max(300, 'A page can have at most 300 text regions'),
      }),
      req.body,
    );
    const r4 = (n: number) => Math.round(n * 10000) / 10000;
    const texts = body.texts.map((t) => ({ x: r4(t.x), y: r4(t.y), w: r4(Math.min(t.w, 1 - t.x)), h: r4(Math.min(t.h, 1 - t.y)), text: t.text }));
    await exec('update pages set texts = $2 where id = $1', [page.id, JSON.stringify(texts)]);
    return { texts };
  });
}
