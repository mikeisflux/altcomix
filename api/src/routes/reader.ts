import { once } from 'node:events';
import { PassThrough } from 'node:stream';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { Zip, ZipPassThrough } from 'fflate';
import { z } from 'zod';
import { exec, one, q } from '../db.ts';
import type { Row } from '../db.ts';
import { hasMembership, releaseAccess } from '../lib/access.ts';
import type { ReleaseAccess, Via } from '../lib/access.ts';
import { loadSession } from '../lib/auth.ts';
import { rateLimit } from '../lib/botblock.ts';
import { sha256, sign } from '../lib/crypto.ts';
import { HttpError, forbidden, notFound, paymentRequired, parse, requireUser } from '../lib/http.ts';
import { activeDiscounts, downloadPrice, readPrice, seriesPurchase } from '../lib/pricing.ts';
import { getSetting } from '../lib/settings.ts';
import { publicUrl, storage } from '../lib/storage.ts';
import { assertViewable, crowdfunding, isUuid } from './catalog.ts';

type PageRow = { id: string; position: number; width: number; height: number; bg_color: string; is_free: boolean | null; frames: unknown[]; variants: Record<string, string> };
type Loaded = { series: Row; release: Row; pages: PageRow[]; access: ReleaseAccess; preview: boolean; member: boolean };

/**
 * Release + who-may-see-what for this request. The paywall decision itself is
 * `releaseAccess` (lib/access.ts); this only adds the visibility gate and the
 * private preview link, which shows every page without recording anything.
 */
async function load(req: FastifyRequest, releaseId: string, previewToken?: string): Promise<Loaded> {
  if (!isUuid(releaseId)) throw notFound('Release not found');
  const release = await one('select * from releases where id = $1 and deleted_at is null', [releaseId]);
  const series = release && (await one('select * from series where id = $1 and deleted_at is null', [release.series_id]));
  if (!release || !series) throw notFound('Release not found');
  const preview = Boolean(previewToken) && previewToken === release.private_token;
  const member = await assertViewable(req, series, release, { preview });
  const pages = await q<PageRow>('select id, position, width, height, bg_color, is_free, frames, variants from pages where release_id = $1 order by position, id', [releaseId]);
  const access = await releaseAccess({ series, release, pages, user: req.user, country: req.country, preview });
  if (access.model === 'blocked' && access.unlock !== 'owner' && !preview) throw notFound('This title is not available in your country');
  if (preview) access.pages = access.pages.map((v) => v ?? 'free');
  return { series, release, pages, access, preview, member };
}

// Fully-unlocked answers are remembered briefly so a 40-page issue is not 40 paywall evaluations.
const open = new Map<string, { until: number; vias: Map<string, Via> }>();
function remember(key: string, l: Loaded): void {
  if (l.access.pages.some((v) => v === null)) return;
  if (open.size > 5000) open.clear();
  open.set(key, { until: Date.now() + 20_000, vias: new Map(l.pages.map((p, i) => [p.id, l.access.pages[i] as Via])) });
}

const month = () => new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1)).toISOString().slice(0, 10);

export default async function readerRoutes(app: FastifyInstance) {
  /** Reader manifest. */
  app.get('/api/releases/:id', async (req) => {
    const token = String((req.query as Row)?.preview ?? '') || undefined;
    const l = await load(req, (req.params as { id: string }).id, token);
    const { series: s, release: r, access: a } = l;
    const u = req.user;
    const suffix = l.preview ? `?preview=${encodeURIComponent(token!)}` : '';

    const [pub, siblings, discounts, wallet, progress, mem] = await Promise.all([
      one('select id, slug, name, avatar_key from publishers where id = $1', [s.publisher_id]),
      q<{ id: string }>(
        `select id from releases where series_id = $1 and language = $2 and deleted_at is null and (status = 'published' or id = $3) order by number, created_at`,
        [s.id, r.language, r.id],
      ),
      activeDiscounts([s.publisher_id]),
      u ? one<{ page_credits: number }>('select page_credits from wallets where user_id = $1', [u.id]) : null,
      u ? one('select position, finished from reading_progress where user_id = $1 and release_id = $2', [u.id, r.id]) : null,
      getSetting('membership'),
    ]);
    const at = siblings.findIndex((x) => x.id === r.id);
    const owned = a.unlock === 'owner' || a.unlock === 'purchase' || a.unlock === 'code';
    const sellable = a.model === 'premium' && !a.releaseFree && !owned && r.status === 'published';
    const read = sellable ? readPrice(s, r, discounts) : null;
    const dl = !a.canDownload && a.model !== 'blocked' && r.status === 'published' ? downloadPrice(s, r, discounts) : null;
    const whole = sellable ? await seriesPurchase(s, u?.id ?? null, discounts) : null;

    return {
      release: {
        id: r.id, title: r.title, number: r.number, kind: r.kind, language: r.language, mature: r.mature, page_count: l.pages.length, synopsis: r.synopsis,
        print_url: r.print_url, published_at: r.published_at, status: r.status, cover_url: await publicUrl(r.cover_key),
      },
      series: {
        id: s.id, slug: s.slug, title: s.title, layout: s.layout, reading_dir: s.reading_dir, cover_url: await publicUrl(s.cover_key), allow_comments: s.allow_comments,
        publisher: pub && { id: pub.id, slug: pub.slug, name: pub.name, avatar_url: await publicUrl(pub.avatar_key) },
        crowdfunding: crowdfunding(s.crowdfunding),
      },
      spread: { pref: r.spread_pref, single_cover: r.single_cover },
      pages: l.pages.map((p, i) => {
        const locked = a.pages[i] === null;
        return {
          id: p.id, position: p.position, width: p.width, height: p.height, bg_color: p.bg_color,
          frames: locked ? [] : p.frames, locked, via: a.pages[i],
          url_thumb: locked || !p.variants?.thumb ? null : `/media/page/${p.id}/thumb${suffix}`,
          url_medium: locked ? null : `/media/page/${p.id}/medium${suffix}`,
          url_full: locked ? null : `/media/page/${p.id}/full${suffix}`,
        };
      }),
      access: {
        model: a.model, release_free: a.releaseFree, unlock: a.unlock, can_download: a.canDownload && !l.preview,
        free_pages: a.pages.filter((v) => v === 'free').length, locked_pages: a.pages.filter((v) => v === null).length, preview: l.preview,
      },
      offers: {
        read_price_cents: read?.price_cents ?? null, read_list_price_cents: read?.base_cents ?? null,
        download_price_cents: dl?.price_cents ?? null, download_list_price_cents: dl?.base_cents ?? null,
        series_price_cents: whole && whole.releases.length > 1 ? whole.price_cents : null,
        in_membership: a.model === 'premium' && s.in_subscription, is_member: u ? await hasMembership(u.id) : false,
        membership: { name: mem.name, monthly_cents: mem.monthly_cents, annual_cents: mem.annual_cents },
        page_credits_available: wallet?.page_credits ?? 0, page_credit_cents: mem.page_credit_cents,
      },
      prev_release_id: at > 0 ? siblings[at - 1].id : null,
      next_release_id: at >= 0 && at < siblings.length - 1 ? siblings[at + 1].id : null,
      progress: progress ? { position: progress.position, finished: progress.finished } : null,
    };
  });

  /**
   * Page images. Every request is checked against the paywall; nothing under
   * private/ is reachable any other way.
   */
  app.get('/media/page/:pageId/:variant', async (req, reply) => {
    const { pageId, variant } = req.params as { pageId: string; variant: string };
    if (!isUuid(pageId) || !['thumb', 'medium', 'full'].includes(variant)) throw notFound();
    await loadSession(req); // the session hook only runs under /api
    const token = String((req.query as Row)?.preview ?? '') || undefined;
    const page = await one<{ release_id: string; variants: Record<string, string> }>('select release_id, variants from pages where id = $1', [pageId]);
    if (!page) throw notFound();

    const key = `${req.user?.id ?? 'anon'}:${req.user?.prefs?.show_mature ? 1 : 0}:${page.release_id}:${req.country ?? ''}`;
    let via: Via | null | undefined = token ? undefined : open.get(key)?.until! > Date.now() ? open.get(key)!.vias.get(pageId) : undefined;
    if (via === undefined) {
      const l = await load(req, page.release_id, token);
      via = l.access.pages[l.pages.findIndex((p) => p.id === pageId)] ?? null;
      if (!l.preview) remember(key, l);
    }
    if (via === null) throw paymentRequired(req.user ? 'This page is locked. Buy the release, join the membership or use a page credit to read it.' : 'This page is locked. Sign in to unlock it.');

    const objectKey = page.variants?.[variant];
    const obj = objectKey ? await (await storage()).get(objectKey) : null;
    if (!obj) throw notFound('Image not found');
    // Free pages are the same for everyone; anything unlocked for one reader must not sit in a shared cache.
    reply.header('cache-control', token ? 'private, no-store' : via === 'free' ? 'public, max-age=3600' : 'private, max-age=3600');
    reply.header('vary', 'cookie').type(obj.contentType);
    if (obj.size) reply.header('content-length', obj.size);
    return reply.send(obj.stream);
  });

  /** Reading analytics: first read of each page per reader per month. Works signed out (free pages only). */
  app.post('/api/reads', async (req) => {
    const body = parse(z.object({ release_id: z.uuid(), page_ids: z.array(z.uuid()).min(1).max(500) }), req.body);
    if (!rateLimit('reads', req.user?.id ?? req.clientIp, 240, 60)) throw new HttpError(429, 'Too many requests. Slow down and try again in a minute.');
    const l = await load(req, body.release_id);
    const wanted = new Set(body.page_ids);
    const seen = l.pages.map((p, i) => ({ id: p.id, via: l.access.pages[i] })).filter((p) => wanted.has(p.id) && p.via !== null);
    if (!seen.length) return { ok: true, recorded: 0 };
    const u = req.user;
    let recorded = 0;
    if (u) {
      recorded = await exec(
        `insert into page_reads (user_id, page_id, month, release_id, series_id, publisher_id, via, country)
         select $1, x.page_id, $2, $3, $4, $5, x.via, $6 from unnest($7::uuid[], $8::text[]) as x(page_id, via)
         on conflict do nothing`,
        [u.id, month(), l.release.id, l.series.id, l.series.publisher_id, req.country, seen.map((p) => p.id), seen.map((p) => p.via)],
      );
      // A brand reading its own book does not move the public counter.
      if (l.member) return { ok: true, recorded };
    } else {
      // No account, no identity kept: a hash that changes every day and cannot be reversed to an IP.
      const day = new Date().toISOString().slice(0, 10);
      const visitor = sha256(`${sign(`anon-reads:${day}`)}:${req.clientIp}:${String(req.headers['user-agent'] ?? '')}`).slice(0, 40);
      const free = seen.filter((p) => p.via === 'free').length;
      if (!free) return { ok: true, recorded: 0 };
      const before = await one<{ pages: number }>('select pages from anon_reads where day = $1 and release_id = $2 and visitor_hash = $3', [day, l.release.id, visitor]);
      const after = await one<{ pages: number }>(
        `insert into anon_reads (day, release_id, series_id, publisher_id, visitor_hash, pages) values ($1,$2,$3,$4,$5, least($6::int, $7::int))
         on conflict (day, release_id, visitor_hash) do update set pages = least($7::int, anon_reads.pages + $6::int) returning pages`,
        [day, l.release.id, l.series.id, l.series.publisher_id, visitor, free, Math.max(1, l.pages.length)],
      );
      recorded = (after?.pages ?? 0) - (before?.pages ?? 0);
    }
    if (recorded > 0) await exec('update series set read_count = read_count + $2 where id = $1', [l.series.id, recorded]);
    return { ok: true, recorded };
  });

  app.put('/api/progress', async (req) => {
    const u = requireUser(req);
    const body = parse(z.object({ release_id: z.uuid(), position: z.number().int().min(0).max(100000), finished: z.boolean().optional() }), req.body);
    const l = await load(req, body.release_id);
    await exec(
      `insert into reading_progress (user_id, release_id, series_id, position, finished) values ($1,$2,$3,$4,$5)
       on conflict (user_id, release_id) do update set position = excluded.position, finished = reading_progress.finished or excluded.finished, updated_at = now()`,
      [u.id, l.release.id, l.series.id, Math.min(body.position, Math.max(0, l.pages.length - 1)), body.finished ?? false],
    );
    return { ok: true };
  });

  /** Download a release the reader may keep, as a CBZ built from the full-size pages. */
  app.get('/api/releases/:id/download', async (req, reply) => {
    const u = requireUser(req);
    const l = await load(req, (req.params as { id: string }).id);
    if (!l.access.canDownload) throw forbidden('Downloading is not included for this release. Buy the download to keep a copy.');
    if (!rateLimit('download', u.id, 30, 3600)) throw new HttpError(429, 'You have downloaded a lot in the last hour. Try again a little later.');
    const store = await storage();
    const out = new PassThrough();
    const zip = new Zip((err, chunk, final) => {
      if (err) return out.destroy(err);
      out.write(Buffer.from(chunk));
      if (final) out.end();
    });
    const pad = String(l.pages.length).length;
    (async () => {
      for (const [i, p] of l.pages.entries()) {
        const key = p.variants?.full;
        const buf = key ? await store.read(key) : null;
        if (!buf) continue;
        // Images are already compressed: store them as-is.
        const entry = new ZipPassThrough(`${String(i + 1).padStart(Math.max(3, pad), '0')}.${key!.split('.').pop() || 'webp'}`);
        zip.add(entry);
        entry.push(buf, true);
        if (out.writableNeedDrain) await once(out, 'drain');
        if (out.destroyed) return;
      }
      zip.end();
    })().catch((e) => out.destroy(e as Error));
    const name = `${l.series.slug}-${l.release.kind}-${l.release.number}`.replace(/[^a-z0-9._-]+/gi, '-');
    reply.header('content-type', 'application/vnd.comicbook+zip').header('content-disposition', `attachment; filename="${name}.cbz"`).header('cache-control', 'private, no-store');
    return reply.send(out);
  });
}
