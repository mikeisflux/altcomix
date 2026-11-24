import type { FastifyInstance, FastifyReply } from 'fastify';
import { config } from '../config.ts';
import { one } from '../db.ts';
import type { Row } from '../db.ts';
import { escapeHtml } from '../lib/email.ts';
import { getSetting } from '../lib/settings.ts';
import { publicUrl } from '../lib/storage.ts';

/**
 * Embeddable widgets for creators' own sites. Each is a tiny self-contained
 * HTML page (no scripts, no cookies) meant to sit in an <iframe> anywhere.
 */
const SIZES: Record<string, { font: number; padY: number; padX: number; height: number }> = {
  small: { font: 13, padY: 6, padX: 14, height: 34 },
  medium: { font: 15, padY: 9, padX: 20, height: 42 },
  large: { font: 18, padY: 13, padX: 28, height: 54 },
};

function color(input: unknown, fallback: string): string {
  const v = String(input ?? '').replace(/^#/, '');
  return /^([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(v) ? `#${v}` : fallback;
}

/** Black or white text, whichever reads better on the chosen colour. */
function textOn(hex: string): string {
  const h = hex.length === 4 ? hex.slice(1).split('').map((c) => c + c).join('') : hex.slice(1);
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
  return r * 0.299 + g * 0.587 + b * 0.114 > 150 ? '#111111' : '#ffffff';
}

async function embeddable(slug: string): Promise<Row | null> {
  return one(
    `select s.slug, s.title, s.cover_key, s.access_model, s.in_subscription, p.name as publisher_name
       from series s join publishers p on p.id = s.publisher_id
      where s.slug = $1 and s.visibility in ('public','unlisted') and s.deleted_at is null and s.takedown_at is null and not s.mature
        and p.deleted_at is null and p.suspended_at is null`,
    [slug],
  );
}

function send(reply: FastifyReply, status: number, html: string): FastifyReply {
  return reply
    .code(status)
    .header('content-type', 'text/html; charset=utf-8')
    .header('cache-control', status === 200 ? 'public, max-age=300' : 'no-store')
    // Framing from any site is the point of a widget; it runs no script and reads no cookie.
    .header('content-security-policy', "default-src 'none'; img-src * data:; style-src 'unsafe-inline'; frame-ancestors *")
    .send(html);
}

const shell = (title: string, css: string, body: string) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title><style>html,body{margin:0;padding:0;background:transparent;font-family:system-ui,-apple-system,"Segoe UI",Helvetica,Arial,sans-serif}a{text-decoration:none}${css}</style></head><body>${body}</body></html>`;

const gone = (reply: FastifyReply) => send(reply, 404, shell('Not available', 'p{font-size:13px;color:#777;margin:8px}', '<p>This comic is not available.</p>'));

export default async function widgetRoutes(app: FastifyInstance) {
  /** "Read now" button. Query: color (hex, with or without #), size (small | medium | large), label. */
  app.get('/widgets/read-now/:slug', async (req, reply) => {
    const s = await embeddable((req.params as { slug: string }).slug);
    if (!s) return gone(reply);
    const qy = (req.query ?? {}) as Record<string, string>;
    const bg = color(qy.color, '#1a1c20');
    const z = SIZES[qy.size] ?? SIZES.medium;
    const site = await getSetting('site');
    const text = String(qy.label ?? '').trim().slice(0, 40) || 'Read now';
    return send(reply, 200, shell(
      `Read ${s.title} on ${site.name}`,
      `.b{display:inline-block;box-sizing:border-box;height:${z.height}px;line-height:${z.height - z.padY * 2}px;padding:${z.padY}px ${z.padX}px;border-radius:${Math.round(z.height / 5)}px;background:${bg};color:${textOn(bg)};font-size:${z.font}px;font-weight:600;white-space:nowrap}.b:hover,.b:focus{filter:brightness(1.12)}`,
      `<a class="b" href="${config.appUrl}/series/${encodeURIComponent(s.slug)}?utm_source=widget&utm_medium=read-now" target="_blank" rel="noopener" title="${escapeHtml(`Read ${s.title} on ${site.name}`)}">${escapeHtml(text)}</a>`,
    ));
  });

  /** Cover card: cover, title, creator and a Read now button. Query: color, theme (light | dark). */
  app.get('/widgets/card/:slug', async (req, reply) => {
    const s = await embeddable((req.params as { slug: string }).slug);
    if (!s) return gone(reply);
    const qy = (req.query ?? {}) as Record<string, string>;
    const bg = color(qy.color, '#1a1c20');
    const dark = qy.theme === 'dark';
    const site = await getSetting('site');
    const cover = await publicUrl(s.cover_key);
    const img = cover ? (cover.startsWith('/') ? config.appUrl + cover : cover) : null;
    const href = `${config.appUrl}/series/${encodeURIComponent(s.slug)}?utm_source=widget&utm_medium=card`;
    const badge = s.access_model === 'free' ? 'Free to read' : s.in_subscription ? `Included in ${(await getSetting('membership')).name}` : '';
    return send(reply, 200, shell(
      `${s.title} on ${site.name}`,
      `.c{display:flex;gap:12px;box-sizing:border-box;width:100%;max-width:360px;padding:12px;border-radius:12px;border:1px solid ${dark ? '#2c2f36' : '#e3e0d9'};background:${dark ? '#16181c' : '#ffffff'};color:${dark ? '#f1f1f1' : '#1a1c20'}}
.i{flex:0 0 96px;width:96px;aspect-ratio:2/3;border-radius:6px;object-fit:cover;background:${dark ? '#2c2f36' : '#eceae4'}}
.t{font-size:16px;font-weight:700;line-height:1.25;margin:2px 0 4px}.p{font-size:13px;opacity:.75;margin:0 0 6px}.g{font-size:12px;opacity:.75;margin:0 0 10px}
.m{display:flex;flex-direction:column;min-width:0}.s{flex:1}
.b{align-self:flex-start;padding:8px 16px;border-radius:8px;background:${bg};color:${textOn(bg)};font-size:14px;font-weight:600}.f{font-size:11px;opacity:.6;margin-top:8px;color:inherit}`,
      `<div class="c"><a href="${href}" target="_blank" rel="noopener">${img ? `<img class="i" src="${escapeHtml(img)}" alt="${escapeHtml(s.title)} cover" loading="lazy">` : '<div class="i"></div>'}</a>
<div class="m"><p class="t">${escapeHtml(s.title)}</p><p class="p">${escapeHtml(s.publisher_name)}</p>${badge ? `<p class="g">${escapeHtml(badge)}</p>` : ''}<div class="s"></div>
<a class="b" href="${href}" target="_blank" rel="noopener">Read now</a><a class="f" href="${config.appUrl}" target="_blank" rel="noopener">on ${escapeHtml(site.name)}</a></div></div>`,
    ));
  });
}
