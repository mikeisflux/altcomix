import type { FastifyInstance } from 'fastify';
import { one, q } from '../db.ts';
import { CMS_SLUGS } from '../lib/admin.ts';
import { notFound, pageParams } from '../lib/http.ts';
import { publicUrl } from '../lib/storage.ts';

/** Public, read-only content managed from /admin. No sign-in needed. */
export default async function contentRoutes(app: FastifyInstance) {
  /** Announcement bar and promo modal entries that are live right now. */
  app.get('/api/content/announcements', async () => {
    const rows = await q(
      `select id, kind, headline, body, cta_label, cta_url, image_key
         from announcements where active and starts_at <= now() and (ends_at is null or ends_at > now())
        order by starts_at desc limit 10`,
    );
    const announcements = [];
    for (const { image_key, ...a } of rows) announcements.push({ ...a, image_url: await publicUrl(image_key) });
    return { announcements };
  });

  /** A footer page. `body` is Markdown. */
  app.get('/api/pages/:slug', async (req) => {
    const slug = (req.params as { slug: string }).slug;
    const page = CMS_SLUGS.includes(slug) ? await one('select slug, title, body, updated_at from cms_pages where slug = $1', [slug]) : null;
    if (!page) throw notFound('Page not found');
    return { page };
  });

  app.get('/api/news', async (req) => {
    const { limit, offset, page } = pageParams(req.query, 12, 50);
    const total = (await one<{ n: number }>('select count(*)::int as n from news_posts where published_at <= now()'))!.n;
    const rows = await q(
      `select slug, title, excerpt, cover_key, published_at from news_posts where published_at <= now()
        order by published_at desc limit ${limit} offset ${offset}`,
    );
    const posts = [];
    for (const { cover_key, ...p } of rows) posts.push({ ...p, cover_url: await publicUrl(cover_key) });
    return { posts, total, page, limit };
  });

  /** One published post. `body` is Markdown. */
  app.get('/api/news/:slug', async (req) => {
    const row = await one(
      `select n.slug, n.title, n.excerpt, n.body, n.cover_key, n.published_at, u.display_name as author_name
         from news_posts n left join users u on u.id = n.author_id where n.slug = $1 and n.published_at <= now()`,
      [(req.params as { slug: string }).slug],
    );
    if (!row) throw notFound('Post not found');
    const { cover_key, ...post } = row;
    return { post: { ...post, cover_url: await publicUrl(cover_key) } };
  });
}
