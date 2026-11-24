import { closeSync, createReadStream, createWriteStream, openSync, readSync, writeSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { FastifyRequest } from 'fastify';
import { Unzip, UnzipInflate } from 'fflate';
import sharp from 'sharp';
import { exec, one, q, tx } from '../db.ts';
import type { Queryable, Row } from '../db.ts';
import { captureError } from './errors.ts';
import { HttpError, badRequest } from './http.ts';
import { notifyNewRelease } from './notify.ts';
import { detectFrames } from './panels.ts';
import { contentTypeFor, publicUrl, storage } from './storage.ts';

/**
 * Studio media pipeline: uploads, page ingestion, covers, publishing.
 *
 * Storage layout
 *   private/archives/<release>/<archive>.<pdf|cbz|zip>   uploaded archive, kept for re-extraction
 *   private/staging/<job>/<n>.<ext>                      loose images waiting for their job
 *   private/originals/<release>/<page>.<ext>             page exactly as uploaded (PDF pages: rendered PNG)
 *   private/pages/<release>/<page>/<thumb|medium|full>.webp
 *   public/covers/<series|releases>/<id>/<name>-lg.webp and -sm.webp
 *   public/brands/<brand>/<avatar|banner>-<stamp>.webp
 *
 * Ingestion is a row in `jobs` (kind 'ingest'). Every page it creates carries
 * `ingest_key = <job>:<index>`, so a job that is run twice, or resumed after a
 * restart, never duplicates a page.
 */

export const VARIANT_WIDTHS = { thumb: 320, medium: 1100, full: 2200 } as const;
export type VariantName = keyof typeof VARIANT_WIDTHS;
const WEBP_QUALITY: Record<VariantName, number> = { thumb: 74, medium: 82, full: 86 };
const WEBP_MAX_SIDE = 16383;
const PDF_DPI = 200;
const PDF_MAX_EDGE = 3000;
const ARCHIVE_MAX_ENTRIES = 3000;
const ARCHIVE_MAX_BYTES = 6 * 1024 * 1024 * 1024;
const STALE_SECONDS = 45;

/** A problem with what the creator uploaded. The message is shown to them. */
export class IngestError extends Error {}

export const naturalCompare = (a: string, b: string) => a.localeCompare(b, 'en', { numeric: true, sensitivity: 'base' });

export async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'altcomix-'));
}

// ---------------------------------------------------------------- images

const FORMATS: Record<string, 'png' | 'jpg' | 'webp'> = { png: 'png', jpeg: 'jpg', webp: 'webp' };
export type ImageInfo = { format: 'png' | 'jpg' | 'webp'; width: number; height: number; dpi: number | null };

/** Decode check. Null when the bytes are not a PNG, JPEG or WebP we can read. */
export async function probeImage(input: Buffer | string): Promise<ImageInfo | null> {
  try {
    const m = await sharp(input).metadata();
    const format = FORMATS[m.format ?? ''];
    if (!format || !m.width || !m.height) return null;
    // Metadata alone passes for truncated files; decode the pixels too.
    await sharp(input).resize(48, 48, { fit: 'inside' }).raw().toBuffer();
    const turned = (m.orientation ?? 1) >= 5;
    return {
      format,
      width: turned ? m.height : m.width,
      height: turned ? m.width : m.height,
      dpi: m.density && m.density > 1 ? Math.round(m.density) : null,
    };
  } catch {
    return null;
  }
}

export function sniff(path: string): 'pdf' | 'zip' | 'other' {
  const fd = openSync(path, 'r');
  try {
    const head = Buffer.alloc(8);
    readSync(fd, head, 0, 8, 0);
    if (head.subarray(0, 5).toString('latin1') === '%PDF-') return 'pdf';
    if (head[0] === 0x50 && head[1] === 0x4b && (head[2] === 3 || head[2] === 5 || head[2] === 7)) return 'zip';
    return 'other';
  } finally {
    closeSync(fd);
  }
}

/** Dominant colour of the page edge, as #rrggbb. Used as the reader background behind the page. */
export async function edgeColor(input: Buffer | string): Promise<string> {
  const size = 64;
  const { data, info } = await sharp(input)
    .rotate()
    .flatten({ background: '#ffffff' })
    .resize(size, size, { fit: 'fill' })
    .toColourspace('srgb')
    .raw()
    .toBuffer({ resolveWithObject: true });
  const ch = info.channels;
  const bins = new Map<number, { n: number; r: number; g: number; b: number }>();
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (x > 1 && x < size - 2 && y > 1 && y < size - 2) continue;
      const i = (y * size + x) * ch;
      const r = data[i];
      const g = ch >= 3 ? data[i + 1] : r;
      const b = ch >= 3 ? data[i + 2] : r;
      const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
      const bin = bins.get(key) ?? { n: 0, r: 0, g: 0, b: 0 };
      bin.n++;
      bin.r += r;
      bin.g += g;
      bin.b += b;
      bins.set(key, bin);
    }
  }
  let best = { n: 0, r: 0, g: 0, b: 0 };
  for (const bin of bins.values()) if (bin.n > best.n) best = bin;
  const hex = (v: number) => Math.round(v / Math.max(1, best.n)).toString(16).padStart(2, '0');
  return `#${hex(best.r)}${hex(best.g)}${hex(best.b)}`;
}

async function webp(input: Buffer | string, width: number, quality: number): Promise<Buffer> {
  return sharp(input, { limitInputPixels: 500_000_000 })
    .rotate()
    .resize({ width, height: WEBP_MAX_SIDE, fit: 'inside', withoutEnlargement: true })
    .webp({ quality, effort: 4 })
    .toBuffer();
}

/** Resize to WebP and store under a public/ key. */
export async function storeWebp(key: string, input: Buffer | string, width: number, height?: number): Promise<void> {
  const img = sharp(input).rotate();
  const out = await (height
    ? img.resize(width, height, { fit: 'cover', position: 'attention' })
    : img.resize({ width, height: WEBP_MAX_SIDE, fit: 'inside', withoutEnlargement: true })
  )
    .webp({ quality: 84 })
    .toBuffer();
  await (await storage()).put(key, out, 'image/webp');
}

// ---------------------------------------------------------------- covers

export const coverThumbKey = (key: string) => key.replace(/-lg\.webp$/, '-sm.webp');

/** Writes `<prefix>-lg.webp` (800w) and `<prefix>-sm.webp` (320w); returns the large key. */
export async function writeCover(prefix: string, input: Buffer | string): Promise<string> {
  await storeWebp(`${prefix}-lg.webp`, input, 800);
  await storeWebp(`${prefix}-sm.webp`, input, 320);
  return `${prefix}-lg.webp`;
}

export async function coverUrls(key: string | null | undefined): Promise<{ cover_url: string | null; cover_thumb_url: string | null }> {
  return { cover_url: await publicUrl(key), cover_thumb_url: key ? await publicUrl(coverThumbKey(key)) : null };
}

async function dropCover(key: string | null | undefined): Promise<void> {
  if (!key) return;
  const store = await storage();
  await store.del(key).catch(() => {});
  await store.del(coverThumbKey(key)).catch(() => {});
}

async function pageImage(page: Row): Promise<Buffer | null> {
  const store = await storage();
  return (await store.read(page.variants?.full ?? '')) ?? (await store.read(page.source_key));
}

/** Keep releases.cover_key in step with the chosen cover page, or page 1 when none is chosen. */
export async function refreshReleaseCover(releaseId: string): Promise<string | null> {
  const r = await one('select id, cover_page_id, cover_key from releases where id = $1', [releaseId]);
  if (!r) return null;
  const page =
    (r.cover_page_id && (await one('select * from pages where id = $1 and release_id = $2', [r.cover_page_id, releaseId]))) ||
    (await one('select * from pages where release_id = $1 order by position limit 1', [releaseId]));
  if (!page) {
    if (r.cover_key) {
      await exec('update releases set cover_key = null where id = $1', [releaseId]);
      await dropCover(r.cover_key);
    }
    return null;
  }
  const prefix = `public/covers/releases/${releaseId}/${page.id}`;
  if (r.cover_key === `${prefix}-lg.webp`) return r.cover_key;
  const img = await pageImage(page);
  if (!img) return r.cover_key;
  const key = await writeCover(prefix, img);
  await exec('update releases set cover_key = $2 where id = $1', [releaseId, key]);
  if (r.cover_key && r.cover_key !== key) await dropCover(r.cover_key);
  return key;
}

export async function setSeriesCover(seriesId: string, prefixName: string, input: Buffer | string): Promise<string> {
  const old = await one<{ cover_key: string | null }>('select cover_key from series where id = $1', [seriesId]);
  const key = await writeCover(`public/covers/series/${seriesId}/${prefixName}`, input);
  await exec('update series set cover_key = $2, updated_at = now() where id = $1', [seriesId, key]);
  if (old?.cover_key && old.cover_key !== key) await dropCover(old.cover_key);
  return key;
}

export async function setSeriesCoverFromPage(seriesId: string, page: Row): Promise<string | null> {
  const img = await pageImage(page);
  if (!img) return null;
  return setSeriesCover(seriesId, page.id, img);
}

// ---------------------------------------------------------------- pages

export async function renumberPages(db: Queryable, releaseId: string): Promise<void> {
  await db.query(
    `update pages p set position = x.rn
       from (select id, row_number() over (order by position, created_at, id) as rn from pages where release_id = $1) x
      where p.id = x.id and p.position <> x.rn`,
    [releaseId],
  );
  await db.query('update releases set page_count = (select count(*) from pages where release_id = $1), updated_at = now() where id = $1', [releaseId]);
}

type NewPage = { releaseId: string; file: string; filename: string; ingestKey: string; archiveId?: string | null; dpi?: number | null };

/** Store one page image with its variants and append it to the release. Safe to call twice. */
export async function addPage(p: NewPage): Promise<{ id: string; created: boolean }> {
  const existing = await one<{ id: string }>('select id from pages where ingest_key = $1', [p.ingestKey]);
  if (existing) return { id: existing.id, created: false };
  const info = await probeImage(p.file);
  if (!info) throw new IngestError(`"${p.filename}" is not a PNG, JPG or WebP image we can read`);

  const { id } = (await one<{ id: string }>('select uuidv7() as id'))!;
  const store = await storage();
  const original = await readFile(p.file);
  const sourceKey = `private/originals/${p.releaseId}/${id}.${info.format}`;
  await store.put(sourceKey, original, contentTypeFor(sourceKey));

  const variants: Record<string, string> = {};
  let thumb: Buffer | null = null;
  for (const name of Object.keys(VARIANT_WIDTHS) as VariantName[]) {
    const buf = await webp(p.file, VARIANT_WIDTHS[name], WEBP_QUALITY[name]);
    if (name === 'thumb') thumb = buf;
    variants[name] = `private/pages/${p.releaseId}/${id}/${name}.webp`;
    await store.put(variants[name], buf, 'image/webp');
  }
  const bg = await edgeColor(thumb!);

  const created = await tx(async (db) => {
    // Serialise page-list changes per release so positions stay dense.
    const rel = await db.query('select id from releases where id = $1 for update', [p.releaseId]);
    if (!rel.rowCount) return false;
    const pos = await db.query('select coalesce(max(position), 0) + 1 as next from pages where release_id = $1', [p.releaseId]);
    const ins = await db.query(
      `insert into pages (id, release_id, position, source_key, width, height, bytes, filename, dpi, variants, bg_color, ingest_key, archive_id)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       on conflict (ingest_key) where ingest_key is not null do nothing`,
      [id, p.releaseId, pos.rows[0].next, sourceKey, info.width, info.height, original.length, p.filename.slice(0, 255),
       p.dpi ?? info.dpi, JSON.stringify(variants), bg, p.ingestKey, p.archiveId ?? null],
    );
    if (!ins.rowCount) return false;
    await db.query('update releases set page_count = (select count(*) from pages where release_id = $1), updated_at = now() where id = $1', [p.releaseId]);
    return true;
  });
  if (!created) {
    await removePageFiles([{ source_key: sourceKey, variants }]);
    const again = await one<{ id: string }>('select id from pages where ingest_key = $1', [p.ingestKey]);
    if (!again) throw new IngestError('This release no longer exists');
    return { id: again.id, created: false };
  }
  return { id, created: true };
}

async function removePageFiles(pages: { source_key: string; variants: Record<string, string> }[]): Promise<void> {
  const store = await storage();
  for (const p of pages) {
    await store.del(p.source_key).catch(() => {});
    for (const key of Object.values(p.variants ?? {})) await store.del(key).catch(() => {});
  }
}

/** Delete pages of one release, close the gaps and keep covers valid. Returns how many went. */
export async function deletePages(releaseId: string, ids: string[]): Promise<number> {
  if (!ids.length) return 0;
  const gone = await tx(async (db) => {
    await db.query('select id from releases where id = $1 for update', [releaseId]);
    const del = await db.query('delete from pages where release_id = $1 and id = any($2::uuid[]) returning id, source_key, variants', [releaseId, ids]);
    await db.query('update releases set cover_page_id = null where id = $1 and cover_page_id = any($2::uuid[])', [releaseId, ids]);
    await renumberPages(db, releaseId);
    return del.rows;
  });
  await removePageFiles(gone as { source_key: string; variants: Record<string, string> }[]);
  await refreshReleaseCover(releaseId);
  return gone.length;
}

// ---------------------------------------------------------------- uploads

export type ReceivedFile = { path: string; filename: string; field: string; bytes: number };
export type Received = { dir: string; files: ReceivedFile[]; fields: Record<string, string>; cleanup: () => Promise<void> };

/** Stream every file of a multipart request to a temp directory (never into memory). */
export async function receiveMultipart(req: FastifyRequest, maxFiles = 400): Promise<Received> {
  if (!req.isMultipart()) throw badRequest('Send the files as multipart/form-data');
  const dir = await tempDir();
  const files: ReceivedFile[] = [];
  const fields: Record<string, string> = {};
  const cleanup = () => rm(dir, { recursive: true, force: true });
  try {
    for await (const part of req.parts()) {
      if (part.type !== 'file') {
        fields[part.fieldname] = String(part.value ?? '');
        continue;
      }
      if (!part.filename) {
        part.file.resume();
        continue;
      }
      if (files.length >= maxFiles) throw badRequest(`Upload at most ${maxFiles} files at a time`);
      const path = join(dir, `${files.length}`.padStart(5, '0') + extname(part.filename).toLowerCase().replace(/[^.a-z0-9]/g, ''));
      await pipeline(part.file, createWriteStream(path));
      if (part.file.truncated) throw new HttpError(413, `"${part.filename}" is too large`);
      files.push({ path, filename: part.filename.replace(/[\\/]/g, '_').slice(0, 255), field: part.fieldname, bytes: part.file.bytesRead });
    }
  } catch (e) {
    await cleanup();
    throw e;
  }
  return { dir, files, fields, cleanup };
}

/** One image from a multipart request, decoded to make sure it is one. */
export async function receiveImage(req: FastifyRequest): Promise<{ path: string; cleanup: () => Promise<void> }> {
  const got = await receiveMultipart(req, 1);
  const f = got.files[0];
  if (!f || !(await probeImage(f.path))) {
    await got.cleanup();
    throw badRequest(f ? `"${f.filename}" is not a PNG, JPG or WebP image we can read` : 'Choose an image to upload');
  }
  return { path: f.path, cleanup: got.cleanup };
}

/**
 * Take the files of an upload: archives are stored and get a job each, loose
 * images are staged (in natural filename order) and share one job.
 * Everything is checked before anything is stored, so a bad file rejects the
 * whole upload with nothing half-done.
 */
export async function acceptUpload(releaseId: string, files: { path: string; filename: string }[], userId: string | null) {
  if (!files.length) throw badRequest('Choose at least one file to upload');
  const images: { path: string; filename: string; format: string }[] = [];
  const archives: { path: string; filename: string; ext: string }[] = [];
  for (const f of files) {
    const kind = sniff(f.path);
    if (kind === 'pdf') archives.push({ ...f, ext: 'pdf' });
    else if (kind === 'zip') archives.push({ ...f, ext: /\.cbz$/i.test(f.filename) ? 'cbz' : 'zip' });
    else {
      const info = await probeImage(f.path);
      if (!info) throw badRequest(`"${f.filename}" is not something we can read. Upload PNG, JPG or WebP images, a ZIP/CBZ of images, or a PDF.`);
      images.push({ ...f, format: info.format });
    }
  }
  images.sort((a, b) => naturalCompare(a.filename, b.filename));

  const store = await storage();
  const jobs: Row[] = [];
  const outArchives: Row[] = [];
  if (images.length) {
    const { id: jobId } = (await one<{ id: string }>('select uuidv7() as id'))!;
    const items: { key: string; filename: string }[] = [];
    for (let i = 0; i < images.length; i++) {
      const key = `private/staging/${jobId}/${i}.${images[i].format}`;
      await store.put(key, await readFile(images[i].path), contentTypeFor(key));
      items.push({ key, filename: images[i].filename });
    }
    jobs.push(
      (await one(
        `insert into jobs (id, kind, release_id, total, payload, created_by) values ($1,'ingest',$2,$3,$4,$5)
         returning id, kind, status, done, total, error, created_at, finished_at`,
        [jobId, releaseId, items.length, JSON.stringify({ source: 'images', items }), userId],
      ))!,
    );
  }
  for (const a of archives) {
    const { id } = (await one<{ id: string }>('select uuidv7() as id'))!;
    const key = `private/archives/${releaseId}/${id}.${a.ext}`;
    const body = await readFile(a.path);
    await store.put(key, body, contentTypeFor(key));
    const row = await one(
      'insert into release_archives (id, release_id, filename, storage_key, bytes) values ($1,$2,$3,$4,$5) returning id, filename, bytes, created_at',
      [id, releaseId, a.filename, key, body.length],
    );
    outArchives.push(row!);
    jobs.push(await queueArchiveJob(releaseId, id, a.filename, false, userId));
  }
  kickJobs();
  return { jobs, archives: outArchives };
}

export async function queueArchiveJob(releaseId: string, archiveId: string, filename: string, replace: boolean, userId: string | null): Promise<Row> {
  return (await one(
    `insert into jobs (kind, release_id, payload, created_by) values ('ingest',$1,$2,$3)
     returning id, kind, status, done, total, error, created_at, finished_at`,
    [releaseId, JSON.stringify({ source: 'archive', archive_id: archiveId, filename, replace }), userId],
  ))!;
}

export async function queueDetectJob(releaseId: string, force: boolean, userId: string | null): Promise<Row> {
  const total = await one<{ n: number }>('select count(*)::int as n from pages where release_id = $1', [releaseId]);
  return (await one(
    `insert into jobs (kind, release_id, total, payload, created_by) values ('detect_frames',$1,$2,$3,$4)
     returning id, kind, status, done, total, error, created_at, finished_at`,
    [releaseId, total?.n ?? 0, JSON.stringify({ force }), userId],
  ))!;
}

// ---------------------------------------------------------------- archives

/** Unpack the images of a ZIP/CBZ to `outDir`, streaming, and return them in natural filename order. */
export async function extractZip(zipPath: string, outDir: string): Promise<{ path: string; name: string }[]> {
  const out: { path: string; name: string }[] = [];
  const open = new Set<number>();
  let failure: Error | null = null;
  let total = 0;
  const unzip = new Unzip();
  unzip.register(UnzipInflate);
  unzip.onfile = (file) => {
    const name = file.name;
    const base = name.split('/').pop() ?? '';
    if (failure || !base || name.startsWith('__MACOSX/') || base.startsWith('.') || !/\.(png|jpe?g|webp)$/i.test(base)) return;
    if (out.length >= ARCHIVE_MAX_ENTRIES) {
      failure = new IngestError(`This archive has more than ${ARCHIVE_MAX_ENTRIES} images. Split it into smaller releases.`);
      return;
    }
    const path = join(outDir, `${out.length}`.padStart(5, '0') + extname(base).toLowerCase());
    const fd = openSync(path, 'w');
    open.add(fd);
    out.push({ path, name });
    file.ondata = (err, chunk, final) => {
      if (err) failure ??= new IngestError('This archive is damaged and could not be unpacked');
      if (!failure && chunk?.length) {
        writeSync(fd, chunk);
        total += chunk.length;
        if (total > ARCHIVE_MAX_BYTES) failure = new IngestError('This archive unpacks to more than 6 GB. Split it into smaller releases.');
      }
      if ((final || failure) && open.has(fd)) {
        open.delete(fd);
        closeSync(fd);
      }
    };
    file.start();
  };
  try {
    for await (const chunk of createReadStream(zipPath, { highWaterMark: 1 << 20 })) {
      try {
        unzip.push(chunk as Buffer, false);
      } catch {
        failure ??= new IngestError('This archive is damaged and could not be unpacked');
      }
      if (failure) break;
      await new Promise((r) => setImmediate(r)); // let heartbeats and requests through
    }
    if (!failure) {
      try {
        unzip.push(new Uint8Array(0), true);
      } catch {
        failure = new IngestError('This archive is damaged and could not be unpacked');
      }
    }
  } finally {
    for (const fd of open) closeSync(fd);
  }
  if (failure) throw failure;
  return out.sort((a, b) => naturalCompare(a.name, b.name));
}

/** Render each PDF page to a PNG file on demand. ~200 DPI, long edge capped at 3000px. */
async function openPdf(path: string) {
  const mupdf = await import('mupdf');
  let doc: InstanceType<typeof mupdf.Document>;
  try {
    doc = mupdf.Document.openDocument(await readFile(path), 'application/pdf');
  } catch {
    throw new IngestError('This PDF is damaged and could not be opened');
  }
  if (doc.needsPassword()) {
    doc.destroy();
    throw new IngestError('This PDF is password-protected. Remove the password and upload it again.');
  }
  const count = doc.countPages();
  return {
    count,
    render(index: number): { png: Buffer; dpi: number } {
      const page = doc.loadPage(index);
      try {
        const [x0, y0, x1, y1] = page.getBounds();
        const longPt = Math.max(x1 - x0, y1 - y0, 1);
        const scale = Math.min(PDF_DPI / 72, PDF_MAX_EDGE / longPt);
        const pix = page.toPixmap(mupdf.Matrix.scale(scale, scale), mupdf.ColorSpace.DeviceRGB, false, true);
        try {
          return { png: Buffer.from(pix.asPNG()), dpi: Math.round(scale * 72) };
        } finally {
          pix.destroy();
        }
      } finally {
        page.destroy();
      }
    },
    close: () => doc.destroy(),
  };
}

// ---------------------------------------------------------------- jobs

const JOB_KINDS = ['ingest', 'detect_frames'];

async function claim(): Promise<Row | null> {
  return one(
    `update jobs set status = 'running', heartbeat_at = now(), attempts = attempts + 1
      where id = (
        select c.id from jobs c
         where c.kind = any($1)
           and (c.status = 'queued' or (c.status = 'running' and (c.heartbeat_at is null or c.heartbeat_at < now() - make_interval(secs => $2))))
           and not exists (
             select 1 from jobs o
              where o.release_id = c.release_id and o.id <> c.id and o.status = 'running'
                and o.heartbeat_at > now() - make_interval(secs => $2))
         order by c.created_at, c.id
         limit 1
         for update skip locked)
      returning *`,
    [JOB_KINDS, STALE_SECONDS],
  );
}

const progress = (id: string, done: number, total: number) =>
  exec('update jobs set done = $2, total = $3, heartbeat_at = now() where id = $1', [id, done, total]);

async function runIngest(job: Row): Promise<void> {
  const releaseId = job.release_id as string;
  const payload = job.payload as {
    source: 'images' | 'archive'; items?: { key: string; filename: string }[]; archive_id?: string; filename?: string; replace?: boolean;
  };
  const store = await storage();
  const dir = await tempDir();
  const skipped: string[] = [];
  let made = 0;
  try {
    if (!(await one('select 1 from releases where id = $1 and deleted_at is null', [releaseId]))) throw new IngestError('This release no longer exists');

    if (payload.source === 'images') {
      const items = payload.items ?? [];
      for (let i = 0; i < items.length; i++) {
        const ingestKey = `${job.id}:${i}`;
        if (!(await one('select 1 from pages where ingest_key = $1', [ingestKey]))) {
          const buf = await store.read(items[i].key);
          if (!buf) skipped.push(items[i].filename);
          else {
            const file = join(dir, `img-${i}`);
            await writeFile(file, buf);
            await addPage({ releaseId, file, filename: items[i].filename, ingestKey });
            await rm(file, { force: true });
            made++;
          }
        }
        await store.del(items[i].key).catch(() => {});
        await progress(job.id, i + 1, items.length);
      }
    } else {
      const archive = await one('select * from release_archives where id = $1 and release_id = $2', [payload.archive_id, releaseId]);
      if (!archive) throw new IngestError('The uploaded archive is no longer available');
      const obj = await store.get(archive.storage_key);
      if (!obj) throw new IngestError('The uploaded archive is no longer available');
      const local = join(dir, 'archive');
      await pipeline(obj.stream, createWriteStream(local));
      const kind = sniff(local);
      if (kind === 'other') throw new IngestError(`"${archive.filename}" is not a ZIP, CBZ or PDF`);

      if (payload.replace) {
        // "Extract" again: pages from an earlier extraction of this archive are replaced.
        const old = await q<{ id: string }>(
          `select id from pages where release_id = $1 and archive_id = $2 and (ingest_key is null or ingest_key not like $3)`,
          [releaseId, archive.id, `${job.id}:%`],
        );
        await deletePages(releaseId, old.map((o) => o.id));
      }

      if (kind === 'zip') {
        const entries = await extractZip(local, dir);
        if (!entries.length) throw new IngestError(`No PNG, JPG or WebP images were found in "${archive.filename}"`);
        await progress(job.id, 0, entries.length);
        for (let i = 0; i < entries.length; i++) {
          const filename = entries[i].name.split('/').pop()!;
          try {
            const r = await addPage({ releaseId, file: entries[i].path, filename, ingestKey: `${job.id}:${i}`, archiveId: archive.id });
            if (r.created) made++;
          } catch (e) {
            if (!(e instanceof IngestError) || e.message.includes('no longer exists')) throw e;
            skipped.push(entries[i].name);
          }
          await rm(entries[i].path, { force: true });
          await progress(job.id, i + 1, entries.length);
        }
        if (skipped.length === entries.length) throw new IngestError(`None of the images in "${archive.filename}" could be read`);
      } else {
        const pdf = await openPdf(local);
        try {
          if (!pdf.count) throw new IngestError(`"${archive.filename}" has no pages`);
          await progress(job.id, 0, pdf.count);
          const stem = archive.filename.replace(/\.pdf$/i, '');
          for (let i = 0; i < pdf.count; i++) {
            const ingestKey = `${job.id}:${i}`;
            if (!(await one('select 1 from pages where ingest_key = $1', [ingestKey]))) {
              const { png, dpi } = pdf.render(i);
              const file = join(dir, `pdf-${i}.png`);
              await writeFile(file, png);
              await addPage({ releaseId, file, filename: `${stem}-p${String(i + 1).padStart(3, '0')}.png`, ingestKey, archiveId: archive.id, dpi });
              await rm(file, { force: true });
              made++;
            }
            await progress(job.id, i + 1, pdf.count);
          }
        } finally {
          pdf.close();
        }
      }
    }
    await refreshReleaseCover(releaseId);
    await exec(`update jobs set payload = payload || $2::jsonb where id = $1`, [job.id, JSON.stringify({ skipped, pages_added: made })]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Detect frames on one page row and save them. Returns the frame count. */
export async function detectPageFrames(page: Row, dir: 'ltr' | 'rtl'): Promise<number> {
  const store = await storage();
  const img = (await store.read(page.variants?.medium ?? '')) ?? (await store.read(page.source_key));
  if (!img) throw new IngestError('The image for this page is missing');
  const frames = await detectFrames(img, { dir });
  await exec(`update pages set frames = $2, frames_source = 'auto' where id = $1`, [page.id, JSON.stringify(frames)]);
  return frames.length;
}

async function runDetect(job: Row): Promise<void> {
  const force = Boolean(job.payload?.force);
  const rel = await one<{ reading_dir: 'ltr' | 'rtl' }>(
    'select s.reading_dir from releases r join series s on s.id = r.series_id where r.id = $1',
    [job.release_id],
  );
  if (!rel) throw new IngestError('This release no longer exists');
  const pages = await q('select id, variants, source_key, frames_source from pages where release_id = $1 order by position', [job.release_id]);
  let detected = 0;
  let kept = 0;
  // A resumed job carries on from the page it had reached.
  for (let i = Math.min(job.done ?? 0, pages.length); i < pages.length; i++) {
    const fresh = await one<{ frames_source: string }>('select frames_source from pages where id = $1', [pages[i].id]);
    if (fresh) {
      if (fresh.frames_source === 'manual' && !force) kept++;
      else {
        await detectPageFrames(pages[i], rel.reading_dir);
        detected++;
      }
    }
    await progress(job.id, i + 1, pages.length);
  }
  await exec(`update jobs set payload = payload || $2::jsonb where id = $1`, [job.id, JSON.stringify({ detected, kept_manual: kept })]);
}

let busy = false;

/** Work through queued jobs, and running ones whose worker died. Returns how many it handled. */
export async function runPendingJobs(): Promise<number> {
  if (busy) return 0;
  busy = true;
  let handled = 0;
  try {
    for (;;) {
      const job = await claim();
      if (!job) break;
      handled++;
      const beat = setInterval(() => {
        exec('update jobs set heartbeat_at = now() where id = $1 and status = $2', [job.id, 'running']).catch(() => {});
      }, 10_000);
      try {
        if (job.kind === 'ingest') await runIngest(job);
        else await runDetect(job);
        await exec(`update jobs set status = 'done', error = null, finished_at = now() where id = $1`, [job.id]);
      } catch (e) {
        if (e instanceof IngestError) {
          await exec(`update jobs set status = 'failed', error = $2, finished_at = now() where id = $1`, [job.id, e.message]);
        } else {
          captureError(e, { source: 'job', endpoint: `studio:${job.kind}`, meta: { jobId: job.id } });
          if (job.attempts >= 3) {
            await exec(`update jobs set status = 'failed', error = $2, finished_at = now() where id = $1`, [
              job.id, 'Something went wrong while processing this upload. It has been logged; please try again.',
            ]);
          } else {
            await exec(`update jobs set status = 'queued', heartbeat_at = null where id = $1`, [job.id]);
          }
        }
      } finally {
        clearInterval(beat);
      }
    }
  } finally {
    busy = false;
  }
  return handled;
}

/** Start processing right away instead of waiting for the next job tick. */
export function kickJobs(): void {
  runPendingJobs().catch((e) => captureError(e, { source: 'job', endpoint: 'studio:kick' }));
}

// ---------------------------------------------------------------- publishing

/**
 * Make a release live. The first time, followers are told and a series with
 * no cover takes page 1 of this release, so it is never invisible by accident.
 */
export async function publishRelease(releaseId: string): Promise<Row> {
  const { release, first } = await tx(async (db) => {
    const cur = (await db.query('select * from releases where id = $1 and deleted_at is null for update', [releaseId])).rows[0];
    if (!cur) throw new HttpError(404, 'Release not found');
    const pages = (await db.query('select count(*)::int as n from pages where release_id = $1', [releaseId])).rows[0].n;
    if (!pages) throw badRequest('Add at least one page before publishing');
    const upd = await db.query(
      `update releases set status = 'published', published_at = coalesce(published_at, now()), publish_at = null, updated_at = now()
        where id = $1 returning *`,
      [releaseId],
    );
    await db.query('update series set updated_at = now() where id = $1', [cur.series_id]);
    return { release: upd.rows[0] as Row, first: !cur.published_at };
  });
  await refreshReleaseCover(releaseId);
  const series = await one('select id, cover_key, visibility from series where id = $1', [release.series_id]);
  if (series && !series.cover_key) {
    const page = await one('select * from pages where release_id = $1 order by position limit 1', [releaseId]);
    if (page) await setSeriesCoverFromPage(series.id, page);
  }
  // A draft series has no audience yet; its followers hear about the next release.
  if (first && series && series.visibility !== 'draft') {
    await notifyNewRelease({ id: release.id, title: release.title, synopsis: release.synopsis, series_id: release.series_id });
  }
  return release;
}

// ---------------------------------------------------------------- small helpers shared by the studio routes

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID.test(v);

/** A uuid route parameter; anything else is a 404 rather than a database error. */
export function idParam(req: FastifyRequest, name = 'id'): string {
  const v = (req.params as Record<string, string>)[name];
  if (!isUuid(v)) throw new HttpError(404, 'Not found');
  return v;
}

export function toCsv(rows: Row[], columns: string[]): string {
  const cell = (v: unknown) => {
    if (v === null || v === undefined) return '';
    let s = v instanceof Date ? v.toISOString() : typeof v === 'object' ? JSON.stringify(v) : String(v);
    // Spreadsheet formula injection: neutralise cells that start like a formula.
    if (/^[=+\-@\t\r]/.test(s) && typeof v === 'string') s = `'${s}`;
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [columns.join(','), ...rows.map((r) => columns.map((c) => cell(r[c])).join(','))].join('\r\n') + '\r\n';
}

/** Minimal RFC 4180 reader (quoted fields, embedded commas and newlines). */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cur = '';
  let quoted = false;
  const src = text.replace(/^﻿/, '');
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quoted) {
      if (c === '"' && src[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (c === '"') quoted = false;
      else cur += c;
    } else if (c === '"') quoted = true;
    else if (c === ',' || c === ';' || c === '\t') {
      row.push(cur);
      cur = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++;
      row.push(cur);
      cur = '';
      if (row.some((v) => v.trim())) rows.push(row);
      row = [];
    } else cur += c;
  }
  row.push(cur);
  if (row.some((v) => v.trim())) rows.push(row);
  return rows;
}
