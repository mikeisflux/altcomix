import { existsSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import sharp from 'sharp';
import { config } from '../config.ts';
import { one } from '../db.ts';
import { getSetting } from './settings.ts';
import { storage } from './storage.ts';

/**
 * Link previews. Facebook, X, Discord and the rest read a page's <meta> tags
 * without running any script, so the app shell is sent with the right tags
 * for the address asked for, and series get their own preview picture.
 *
 * Adult series never show their cover in a preview: it is blurred beyond
 * recognition under an "18+ inside" bar, so a link is safe to post anywhere.
 */

export type ShareMeta = { title: string; description: string; image: string; imageAlt: string; type: 'website' | 'article' | 'book'; path: string };

const DEFAULT_DESCRIPTION = 'Creator-owned comics. Adult work welcome. Publish free and keep your rights.';

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** One tidy line of plain text from markdown-ish prose. */
function summary(text: string, max = 200): string {
  const plain = text
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[#*_`>~]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (plain.length <= max) return plain;
  const cut = plain.slice(0, max - 1);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(' '), max - 40)).trimEnd()}…`;
}

const slugOf = (path: string, prefix: string): string | null => {
  if (!path.startsWith(prefix)) return null;
  const rest = path.slice(prefix.length).split('/')[0];
  return /^[a-z0-9][a-z0-9-]{0,120}$/i.test(rest) ? rest : null;
};

const metaCache = new Map<string, { at: number; meta: ShareMeta }>();

export async function shareMeta(rawPath: string): Promise<ShareMeta> {
  const path = rawPath.split('?')[0].replace(/\/+$/, '') || '/';
  const hit = metaCache.get(path);
  if (hit && Date.now() - hit.at < 60_000) return hit.meta;

  const site = await getSetting('site');
  const name = site.name || 'NSFWComix';
  const base: ShareMeta = {
    title: `${name} — ${site.tagline || 'Your comic. Your rules.'}`,
    description: DEFAULT_DESCRIPTION,
    image: `${config.appUrl}/brand/og-image.png`,
    imageAlt: `${name}. ${site.tagline || 'Your comic. Your rules.'}`,
    type: 'website',
    path: '/',
  };
  let meta = base;

  const series = slugOf(path, '/series/') ?? slugOf(path, '/read/');
  const brand = slugOf(path, '/b/');
  const news = slugOf(path, '/news/');
  const page = slugOf(path, '/p/');

  if (series) {
    const s = await one<{ slug: string; title: string; description: string; mature: boolean; updated_at: Date; brand: string }>(
      `select s.slug, s.title, s.description, s.mature, s.updated_at, p.name as brand
         from series s join publishers p on p.id = s.publisher_id
        where lower(s.slug) = lower($1) and s.visibility in ('public','unlisted') and s.deleted_at is null and s.takedown_at is null`,
      [series],
    );
    if (s) {
      meta = {
        title: `${s.title} by ${s.brand} — ${name}`,
        description: summary(s.description) || `Read ${s.title} by ${s.brand} on ${name}, frame by frame on any screen.`,
        image: `${config.appUrl}/share/series/${encodeURIComponent(s.slug)}.png?v=${Math.floor(new Date(s.updated_at).getTime() / 1000)}`,
        imageAlt: s.mature ? `${s.title}. Cover hidden: adults only.` : `Cover of ${s.title}`,
        type: 'book',
        path: `/series/${s.slug}`,
      };
    }
  } else if (brand) {
    const b = await one<{ slug: string; name: string; bio: string }>(
      'select slug, name, bio from publishers where lower(slug) = lower($1) and deleted_at is null and suspended_at is null',
      [brand],
    ).catch(() => null);
    if (b) meta = { ...base, title: `${b.name} — ${name}`, description: summary(b.bio) || `Comics by ${b.name} on ${name}.`, path: `/b/${b.slug}` };
  } else if (news) {
    const n = await one<{ slug: string; title: string; excerpt: string }>('select slug, title, excerpt from news_posts where slug = $1 and published_at is not null and published_at <= now()', [news]).catch(() => null);
    if (n) meta = { ...base, title: `${n.title} — ${name}`, description: summary(n.excerpt) || base.description, type: 'article', path: `/news/${n.slug}` };
  } else if (page) {
    const c = await one<{ slug: string; title: string }>('select slug, title from cms_pages where slug = $1', [page]).catch(() => null);
    if (c) meta = { ...base, title: `${c.title} — ${name}`, path: `/p/${c.slug}` };
  } else {
    const fixed: Record<string, [string, string]> = {
      '/browse': ['Browse comics', 'Find creator-owned comics, manga and webcomics, including the ones made for adults.'],
      '/creators': ['For creators', 'Publish free, keep your rights, set your own price. Adult work welcome.'],
      '/unlimited': ['Membership', 'One membership, the whole library, and most of it goes to the creators you read.'],
      '/gift-cards': ['Gift cards', 'Give someone comics.'],
      '/welcome': [site.tagline || 'Your comic. Your rules.', DEFAULT_DESCRIPTION],
    };
    const f = fixed[path];
    if (f) meta = { ...base, title: `${f[0]} — ${name}`, description: f[1], path };
  }

  if (metaCache.size > 2000) metaCache.clear();
  metaCache.set(path, { at: Date.now(), meta });
  return meta;
}

function tags(m: ShareMeta): string {
  const url = `${config.appUrl}${m.path === '/' ? '/' : m.path}`;
  const t = esc(m.title);
  const d = esc(m.description);
  const i = esc(m.image);
  return [
    `<title>${t}</title>`,
    `<meta name="description" content="${d}" />`,
    `<link rel="canonical" href="${esc(url)}" />`,
    `<meta property="og:type" content="${m.type}" />`,
    `<meta property="og:site_name" content="NSFWComix" />`,
    `<meta property="og:url" content="${esc(url)}" />`,
    `<meta property="og:title" content="${t}" />`,
    `<meta property="og:description" content="${d}" />`,
    `<meta property="og:image" content="${i}" />`,
    `<meta property="og:image:width" content="1200" />`,
    `<meta property="og:image:height" content="630" />`,
    `<meta property="og:image:alt" content="${esc(m.imageAlt)}" />`,
    `<meta name="twitter:card" content="summary_large_image" />`,
    `<meta name="twitter:title" content="${t}" />`,
    `<meta name="twitter:description" content="${d}" />`,
    `<meta name="twitter:image" content="${i}" />`,
  ].join('\n    ');
}

let shell: { mtime: number; html: string } | null = null;

/** The built app shell with the preview tags for `path`, or null when the web client is not built. */
export async function renderIndex(path: string): Promise<string | null> {
  const file = join(config.webDist, 'index.html');
  if (!existsSync(file)) return null;
  const mtime = statSync(file).mtimeMs;
  if (!shell || shell.mtime !== mtime) shell = { mtime, html: await readFile(file, 'utf8') };
  const html = shell.html;
  const a = html.indexOf('<!--share-->');
  const b = html.indexOf('<!--/share-->');
  if (a < 0 || b < a) return html;
  let meta: ShareMeta;
  try {
    meta = await shareMeta(path);
  } catch {
    return html; // the page must still load when the database is unhappy
  }
  return `${html.slice(0, a)}<!--share-->\n    ${tags(meta)}\n    ${html.slice(b)}`;
}

/* ---------------------------------------------------------------- pictures */

function brandFile(name: string): string | null {
  for (const dir of [join(config.webDist, 'brand'), resolve(import.meta.dirname, '../../../web/public/brand')]) {
    const f = join(dir, name);
    if (existsSync(f)) return f;
  }
  return null;
}

const SLOT = { left: 72, top: 45, width: 360, height: 540 };
const cardCache = new Map<string, Buffer>();

async function buffer(key: string): Promise<Buffer | null> {
  const obj = await (await storage()).get(key);
  if (!obj) return null;
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of obj.stream) {
    chunks.push(c as Buffer);
    size += (c as Buffer).length;
    if (size > 40 * 1024 * 1024) return null;
  }
  return Buffer.concat(chunks);
}

/** 1200x630 PNG for a series, or null when the series is not public. */
export async function seriesCard(slug: string): Promise<Buffer | null> {
  const s = await one<{ slug: string; mature: boolean; cover_key: string | null; updated_at: Date }>(
    `select slug, mature, cover_key, updated_at from series
      where lower(slug) = lower($1) and visibility in ('public','unlisted') and deleted_at is null and takedown_at is null`,
    [slug],
  );
  if (!s) return null;
  const cacheKey = `${s.slug}:${new Date(s.updated_at).getTime()}`;
  const cached = cardCache.get(cacheKey);
  if (cached) return cached;

  const template = brandFile('og-series.png');
  const fallback = brandFile('og-image.png');
  const cover = s.cover_key ? await buffer(s.cover_key).catch(() => null) : null;
  if (!template || !cover) return fallback ? readFile(fallback) : null;

  let art: Buffer;
  try {
    let img = sharp(cover, { limitInputPixels: 80_000_000 }).rotate().resize(SLOT.width, SLOT.height, { fit: 'cover', position: 'attention' });
    if (s.mature) {
      const bar = brandFile('og-mature-overlay.png');
      img = sharp(await img.blur(26).modulate({ saturation: 1.15 }).png().toBuffer());
      if (bar) img = img.composite([{ input: bar }]);
    }
    art = await img.png().toBuffer();
  } catch {
    return fallback ? readFile(fallback) : null;
  }
  const out = await sharp(template).composite([{ input: art, left: SLOT.left, top: SLOT.top }]).png({ compressionLevel: 9, palette: false }).toBuffer();
  if (cardCache.size > 300) cardCache.clear();
  cardCache.set(cacheKey, out);
  return out;
}
