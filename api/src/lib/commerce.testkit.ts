/**
 * Test support for the reader/commerce area. NOT loaded by the server.
 *
 * `useTestDatabase('name')` must run before anything imports db.ts: it points
 * DATABASE_URL at a private database (created on first use, migrated every
 * time) and STORAGE_DIR at a temp folder, so tests never touch development
 * data and test files can run in parallel. Then import the rest dynamically.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';

const BASE = process.env.TEST_DATABASE_BASE ?? process.env.DATABASE_URL ?? 'postgres://postgres@127.0.0.1:5433/altcomix';

export async function useTestDatabase(name: string): Promise<void> {
  const url = new URL(BASE);
  const db = `${url.pathname.slice(1).replace(/_t_.*$/, '')}_t_${name}`;
  const admin = new pg.Client({ connectionString: BASE });
  await admin.connect();
  try {
    const hit = await admin.query('select 1 from pg_database where datname = $1', [db]);
    if (!hit.rowCount) await admin.query(`create database "${db}"`).catch((e: { code?: string }) => { if (e.code !== '42P04' && e.code !== '23505') throw e; });
  } finally {
    await admin.end();
  }
  url.pathname = `/${db}`;
  process.env.DATABASE_URL = url.toString();
  process.env.STORAGE_DIR ??= mkdtempSync(join(tmpdir(), 'altcomix-test-'));
  process.env.NODE_ENV = 'test';
  const { migrate } = await import('../migrate.ts');
  await migrate(() => {});
}

let n = 0;
const uniq = () => `${Date.now().toString(36)}${(n++).toString(36)}${Math.random().toString(36).slice(2, 6)}`;

/** Row builders. Everything gets a unique name so repeated runs never collide. */
export async function fixtures() {
  const { one, exec } = await import('../db.ts');
  const { storage } = await import('./storage.ts');
  const { hashPassword } = await import('./crypto.ts');
  const sharp = (await import('sharp')).default;
  let passwordHash: string | null = null;

  return {
    async user(over: { role?: string; verified?: boolean; prefs?: object; password?: string } = {}) {
      const tag = uniq();
      passwordHash ??= await hashPassword('correct horse battery');
      const hash = over.password ? await hashPassword(over.password) : passwordHash;
      const u = await one(
        `insert into users (email, username, display_name, password_hash, role, email_verified_at, prefs)
         values ($1,$2,$3,$4,$5,$6,$7) returning id, email, username, display_name, role, email_verified_at, avatar_key, prefs, totp_enabled`,
        [`reader-${tag}@test.invalid`, `u_${tag}`.slice(0, 24), `Reader ${tag}`, hash, over.role ?? 'user', over.verified === false ? null : new Date(), JSON.stringify(over.prefs ?? {})],
      );
      return u as { id: string; email: string; username: string; display_name: string; role: 'user'; email_verified_at: string | null; avatar_key: null; prefs: Record<string, unknown>; totp_enabled: boolean };
    },
    async brand(ownerId: string | null, over: Record<string, unknown> = {}) {
      const tag = uniq();
      const p = await one(
        `insert into publishers (slug, name, kind, sale_share_bps, sub_share_bps, tip_share_bps, monthly_goal_cents) values ($1,$2,$3,$4,$5,$6,$7) returning *`,
        [`brand-${tag}`, `Brand ${tag}`, over.kind ?? 'creator', over.sale_share_bps ?? null, over.sub_share_bps ?? null, over.tip_share_bps ?? null, over.monthly_goal_cents ?? null],
      );
      if (ownerId) await exec(`insert into publisher_members (publisher_id, user_id, role) values ($1,$2,'owner')`, [p!.id, ownerId]);
      return p!;
    },
    async series(publisherId: string, over: Record<string, unknown> = {}) {
      const tag = uniq();
      const s = await one(
        `insert into series (publisher_id, slug, title, description, visibility, access_model, in_subscription, free_preview, default_price_cents, genre, mature, forum_enabled, type, tags)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) returning *`,
        [publisherId, `series-${tag}`, over.title ?? `Series ${tag}`, over.description ?? 'A test series.', over.visibility ?? 'public', over.access_model ?? 'premium',
         over.in_subscription ?? true, JSON.stringify(over.free_preview ?? { mode: 'first_pages', n: 2 }), over.default_price_cents ?? 199, over.genre ?? 'Sci-Fi',
         over.mature ?? false, over.forum_enabled ?? false, over.type ?? 'comic', over.tags ?? []],
      );
      return s!;
    },
    /** A published release with `pages` real WebP pages in storage (private keys). */
    async release(seriesId: string, over: Record<string, unknown> = {}, pages = 4) {
      const r = await one(
        `insert into releases (series_id, number, kind, title, status, published_at, price_cents, download_price_cents, download_discount_pct, page_count, force_free, mature)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) returning *`,
        [seriesId, over.number ?? 1, over.kind ?? 'issue', over.title ?? `Issue ${over.number ?? 1}`, over.status ?? 'published', over.published_at ?? new Date(),
         over.price_cents ?? null, over.download_price_cents ?? null, over.download_discount_pct ?? null, pages, over.force_free ?? false, over.mature ?? false],
      );
      const store = await storage();
      const ids: string[] = [];
      for (let i = 0; i < pages; i++) {
        const img = await sharp({ create: { width: 40, height: 60, channels: 3, background: { r: (i * 53) % 255, g: 90, b: 160 } } }).webp().toBuffer();
        const base = `private/pages/${r!.id}/${i + 1}`;
        for (const v of ['thumb', 'medium', 'full']) await store.put(`${base}-${v}.webp`, img, 'image/webp');
        const p = await one<{ id: string }>(
          `insert into pages (release_id, position, source_key, width, height, variants, frames) values ($1,$2,$3,40,60,$4,$5) returning id`,
          [r!.id, i + 1, `${base}-full.webp`, JSON.stringify({ thumb: `${base}-thumb.webp`, medium: `${base}-medium.webp`, full: `${base}-full.webp` }), JSON.stringify([{ x: 0, y: 0, w: 1, h: 0.5 }])],
        );
        ids.push(p!.id);
      }
      return { ...r!, id: r!.id as string, page_ids: ids } as Record<string, any> & { id: string; page_ids: string[] };
    },
  };
}
