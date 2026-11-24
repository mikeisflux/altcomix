import type { FastifyInstance } from 'fastify';
import sharp from 'sharp';
import { z } from 'zod';
import { config } from '../config.ts';
import { exec, one, q, tx } from '../db.ts';
import type { Row } from '../db.ts';
import { hasMembership } from '../lib/access.ts';
import { destroySession } from '../lib/auth.ts';
import { rateLimit } from '../lib/botblock.ts';
import { hashPassword, randomToken, sha256, verifyPassword } from '../lib/crypto.ts';
import { sendTemplate } from '../lib/email.ts';
import { HttpError, audit, badRequest, conflict, notFound, pageParams, parse, requireUser } from '../lib/http.ts';
import { getSetting } from '../lib/settings.ts';
import { publicUrl, storage } from '../lib/storage.ts';
import { FAVORITE_GENRES, LANGUAGES } from '../lib/taxonomy.ts';
import { toCards, CARD_SELECT, listable } from './catalog.ts';

const NOTIFY_KEYS = ['releases', 'messages', 'replies', 'mentions', 'followers', 'feed', 'analytics', 'newsletter'] as const;
const LANG = LANGUAGES.map((l) => l.code) as string[];

/** Settings shown on the account page, with defaults filled in. */
function prefsView(p: Row): Row {
  const n = (p.notify ?? {}) as Row;
  return {
    show_mature: Boolean(p.show_mature),
    reading_language: p.reading_language ?? null, // null = any language
    interface_language: p.interface_language ?? 'en',
    country: p.country ?? null,
    favorite_genre: p.favorite_genre ?? null,
    show_real_name: p.show_real_name !== false,
    show_donation_amounts: p.show_donation_amounts !== false,
    allow_dms: p.allow_dms !== false,
    beta: Boolean(p.beta),
    notify: Object.fromEntries(NOTIFY_KEYS.map((k) => [k, k === 'newsletter' ? Boolean(n[k]) : n[k] !== false])),
  };
}

async function checkPassword(userId: string, password: string, ip: string): Promise<void> {
  if (!rateLimit('account-password', userId, 10, 900) || !rateLimit('account-password-ip', ip, 30, 900)) throw new HttpError(429, 'Too many attempts. Try again in a few minutes.');
  const row = await one<{ password_hash: string }>('select password_hash from users where id = $1', [userId]);
  if (!row || !(await verifyPassword(password, row.password_hash))) throw new HttpError(403, 'Your current password is not correct');
}

export default async function accountRoutes(app: FastifyInstance) {
  app.get('/api/account', async (req) => {
    const u = requireUser(req);
    const [row, wallet, member] = await Promise.all([
      one('select bio, marketing_opt_in, created_at, email_verified_at, totp_enabled from users where id = $1', [u.id]),
      one('select credit_cents, page_credits from wallets where user_id = $1', [u.id]),
      hasMembership(u.id),
    ]);
    return {
      profile: { id: u.id, username: u.username, email: u.email, email_verified: Boolean(row?.email_verified_at), display_name: u.display_name, bio: row?.bio ?? '', avatar_url: await publicUrl(u.avatar_key), created_at: row?.created_at, totp_enabled: Boolean(row?.totp_enabled) },
      prefs: prefsView(u.prefs),
      wallet: wallet ?? { credit_cents: 0, page_credits: 0 },
      member,
    };
  });

  app.patch('/api/account/profile', async (req) => {
    const u = requireUser(req);
    const body = parse(z.object({ display_name: z.string().trim().min(1, 'Enter a name').max(60).optional(), bio: z.string().trim().max(600).optional() }), req.body);
    const r = await one('update users set display_name = coalesce($2, display_name), bio = coalesce($3, bio) where id = $1 returning display_name, bio', [u.id, body.display_name ?? null, body.bio ?? null]);
    return { ok: true, profile: r };
  });

  /** multipart/form-data with one image file. Stored as a 256px square WebP under public/avatars. */
  app.post('/api/account/avatar', async (req) => {
    const u = requireUser(req);
    if (!rateLimit('avatar', u.id, 10, 3600)) throw new HttpError(429, 'Too many uploads. Try again later.');
    if (!req.isMultipart()) throw badRequest('Send the image as a file upload');
    const file = await req.file({ limits: { fileSize: 8 * 1024 * 1024, files: 1 } });
    if (!file) throw badRequest('Choose an image to upload');
    const input = await file.toBuffer().catch(() => null);
    if (!input || file.file.truncated) throw new HttpError(413, 'That image is too large. Use one under 8 MB.');
    let out: Buffer;
    try {
      out = await sharp(input, { limitInputPixels: 50_000_000 }).rotate().resize(256, 256, { fit: 'cover' }).webp({ quality: 86 }).toBuffer();
    } catch {
      throw badRequest('That file is not an image we can read. Use a JPG, PNG or WebP.');
    }
    const key = `public/avatars/${u.id}-${randomToken(6)}.webp`;
    const store = await storage();
    await store.put(key, out, 'image/webp');
    await exec('update users set avatar_key = $2 where id = $1', [u.id, key]);
    if (u.avatar_key?.startsWith('public/avatars/')) await store.del(u.avatar_key).catch(() => {});
    return { ok: true, avatar_url: await publicUrl(key) };
  });

  app.delete('/api/account/avatar', async (req) => {
    const u = requireUser(req);
    await exec('update users set avatar_key = null where id = $1', [u.id]);
    if (u.avatar_key?.startsWith('public/avatars/')) await (await storage()).del(u.avatar_key).catch(() => {});
    return { ok: true, avatar_url: null };
  });

  /** Partial update of settings. Turning mature content on needs `confirm_adult: true` in the same request. */
  app.patch('/api/account/prefs', async (req) => {
    const u = requireUser(req);
    const body = parse(
      z.object({
        show_mature: z.boolean().optional(),
        confirm_adult: z.boolean().optional(),
        reading_language: z.string().refine((v) => LANG.includes(v), 'Unknown language').nullable().optional(),
        interface_language: z.string().refine((v) => LANG.includes(v), 'Unknown language').optional(),
        country: z.string().regex(/^[A-Za-z]{2}$/, 'Use a two-letter country code').nullable().optional(),
        favorite_genre: z.string().refine((v) => FAVORITE_GENRES.some((g) => g.id === v), 'Unknown genre').nullable().optional(),
        show_real_name: z.boolean().optional(),
        show_donation_amounts: z.boolean().optional(),
        allow_dms: z.boolean().optional(),
        beta: z.boolean().optional(),
        notify: z.object(Object.fromEntries(NOTIFY_KEYS.map((k) => [k, z.boolean().optional()])) as Record<(typeof NOTIFY_KEYS)[number], z.ZodOptional<z.ZodBoolean>>).optional(),
      }),
      req.body,
    );
    const cur = (await one<{ prefs: Row }>('select prefs from users where id = $1', [u.id]))?.prefs ?? {};
    if (body.show_mature === true && !cur.show_mature && body.confirm_adult !== true) {
      throw badRequest('Confirm that you are 18 or older to turn on mature content', 'confirm_adult');
    }
    const next: Row = { ...cur };
    for (const k of ['show_mature', 'reading_language', 'interface_language', 'favorite_genre', 'show_real_name', 'show_donation_amounts', 'allow_dms', 'beta'] as const) {
      if (body[k] !== undefined) next[k] = body[k];
    }
    if (body.country !== undefined) next.country = body.country ? body.country.toUpperCase() : null;
    if (body.show_mature === true && !cur.show_mature) next.adult_confirmed_at = new Date().toISOString();
    if (body.notify) next.notify = { ...(cur.notify ?? {}), ...Object.fromEntries(Object.entries(body.notify).filter(([, v]) => v !== undefined)) };
    await exec('update users set prefs = $2, marketing_opt_in = coalesce($3, marketing_opt_in) where id = $1', [u.id, JSON.stringify(next), body.notify?.newsletter ?? null]);
    return { ok: true, prefs: prefsView(next) };
  });

  /** Start an email change: the confirmation link goes to the NEW address and nothing changes until it is opened. */
  app.post('/api/account/email', async (req) => {
    const u = requireUser(req);
    const body = parse(z.object({ new_email: z.email('Enter a valid email address').max(200), current_password: z.string().min(1, 'Enter your current password').max(200) }), req.body);
    await checkPassword(u.id, body.current_password, req.clientIp);
    const email = body.new_email.toLowerCase();
    if (email === u.email.toLowerCase()) throw badRequest('That is already your email address');
    if (await one('select 1 from users where lower(email) = $1', [email])) throw conflict('That email is already in use');
    if (!rateLimit('email-change', u.id, 5, 3600)) throw new HttpError(429, 'Too many requests. Try again later.');
    // auth.ts decorates `issueEmailToken` inside its own plugin scope, where sibling route files cannot see it;
    // fall back to writing the same kind of token row (confirmed by POST /api/auth/confirm-email-change).
    let token: string;
    if (typeof app.issueEmailToken === 'function') token = await app.issueEmailToken(u.id, 'email_change', 24, { email });
    else {
      token = randomToken(32);
      await exec(`insert into email_tokens (token_hash, user_id, kind, payload, expires_at) values ($1,$2,'email_change',$3, now() + interval '24 hours')`, [sha256(token), u.id, JSON.stringify({ email })]);
    }
    await sendTemplate('email_change', email, { name: u.display_name || u.username, url: `${config.appUrl}/confirm-email?token=${token}` }, { userId: u.id });
    audit(req, 'user.email_change_requested', { kind: 'user', id: u.id });
    return { ok: true, sent_to: email };
  });

  /** Change password; every other session is signed out. */
  app.post('/api/account/password', async (req) => {
    const u = requireUser(req);
    const security = await getSetting('security');
    const body = parse(
      z.object({
        current_password: z.string().min(1, 'Enter your current password').max(200),
        new_password: z.string().min(security.password_min_length, `Password must be at least ${security.password_min_length} characters`).max(200),
      }),
      req.body,
    );
    await checkPassword(u.id, body.current_password, req.clientIp);
    if (body.new_password === body.current_password) throw badRequest('Choose a password you have not just used');
    await exec('update users set password_hash = $2 where id = $1', [u.id, await hashPassword(body.new_password)]);
    const out = await exec('delete from sessions where user_id = $1 and token_hash <> $2', [u.id, req.sessionHash]);
    audit(req, 'user.password_changed', { kind: 'user', id: u.id });
    return { ok: true, sessions_signed_out: out };
  });

  /** Where the account is signed in. `id` is a short handle, not the session secret. */
  app.get('/api/account/sessions', async (req) => {
    const u = requireUser(req);
    const rows = await q('select token_hash, ip, user_agent, created_at, last_seen_at, expires_at from sessions where user_id = $1 and expires_at > now() order by last_seen_at desc', [u.id]);
    return { items: rows.map((s) => ({ id: s.token_hash.slice(0, 16), current: s.token_hash === req.sessionHash, ip: s.ip, user_agent: s.user_agent, created_at: s.created_at, last_seen_at: s.last_seen_at, expires_at: s.expires_at })) };
  });
  app.delete('/api/account/sessions/:id', async (req) => {
    const u = requireUser(req);
    const { id } = req.params as { id: string };
    if (!/^[0-9a-f]{16}$/.test(id)) throw notFound('Session not found');
    const n = await exec('delete from sessions where user_id = $1 and left(token_hash, 16) = $2 and token_hash <> $3', [u.id, id, req.sessionHash]);
    if (!n) throw notFound('Session not found (to end this one, sign out)');
    return { ok: true };
  });
  app.post('/api/account/sessions/revoke-others', async (req) => {
    const u = requireUser(req);
    return { ok: true, sessions_signed_out: await exec('delete from sessions where user_id = $1 and token_hash <> $2', [u.id, req.sessionHash]) };
  });

  /**
   * Delete the account: personal details are wiped, the row stays so orders
   * and creator earnings keep adding up, the membership stops renewing.
   */
  app.post('/api/account/delete', async (req, reply) => {
    const u = requireUser(req);
    const body = parse(z.object({ password: z.string().min(1, 'Enter your password to confirm').max(200) }), req.body);
    await checkPassword(u.id, body.password, req.clientIp);
    const owns = await q<{ name: string }>(
      `select p.name from publisher_members m join publishers p on p.id = m.publisher_id
        where m.user_id = $1 and m.role = 'owner' and p.deleted_at is null
          and not exists (select 1 from publisher_members o where o.publisher_id = p.id and o.role = 'owner' and o.user_id <> $1)`,
      [u.id],
    );
    if (owns.length) throw conflict(`You are the only owner of ${owns.map((o) => o.name).join(', ')}. Hand the brand to another owner or delete it first.`);
    await tx(async (db) => {
      const tag = u.id.replace(/-/g, '').slice(-12);
      await db.query(
        `update users set email = $2, username = $3, display_name = 'Deleted user', bio = '', avatar_key = null, prefs = '{}', marketing_opt_in = false,
                password_hash = $4, totp_secret = null, totp_enabled = false, totp_backup_codes = '{}', last_ip = null, email_verified_at = null,
                email_unsubscribed_at = now(), deleted_at = now() where id = $1`,
        [u.id, `deleted-${tag}@deleted.invalid`, `deleted_${tag}`, `deleted$${randomToken(24)}`],
      );
      await db.query('delete from sessions where user_id = $1', [u.id]);
      await db.query('delete from email_tokens where user_id = $1', [u.id]);
      await db.query('delete from publisher_members where user_id = $1', [u.id]);
      // No further renewals: the saved payment method token is dropped with the membership.
      await db.query(
        `update subscriptions set status = case when status in ('active','past_due') then 'canceled' else status end, cancel_at_period_end = true,
                canceled_at = coalesce(canceled_at, now()), payment_method_token = null, origin_ip = null, origin_user_agent = null where user_id = $1`,
        [u.id],
      );
      await db.query(`update subscription_charges set status = 'failed', last_error = 'Account deleted' where user_id = $1 and status = 'pending'`, [u.id]);
      await db.query('update series set follower_count = greatest(0, follower_count - 1) where id in (select series_id from follows where user_id = $1)', [u.id]);
      await db.query('update series set favorite_count = greatest(0, favorite_count - 1) where id in (select series_id from favorites where user_id = $1)', [u.id]);
      await db.query('delete from follows where user_id = $1', [u.id]);
      await db.query('delete from favorites where user_id = $1', [u.id]);
      await db.query('delete from publisher_follows where user_id = $1', [u.id]);
      await db.query('delete from notifications where user_id = $1', [u.id]);
      await db.query('update orders set ip = null, user_agent = null where user_id = $1', [u.id]);
      await db.query('update login_events set email = null, ip = null, user_agent = null where user_id = $1', [u.id]);
    });
    if (u.avatar_key?.startsWith('public/avatars/')) await (await storage()).del(u.avatar_key).catch(() => {});
    audit(req, 'user.deleted_self', { kind: 'user', id: u.id });
    await destroySession(req, reply);
    return { ok: true };
  });

  /** Store credit, page credits and the log behind them. */
  app.get('/api/account/wallet', async (req) => {
    const u = requireUser(req);
    const { limit, offset, page } = pageParams(req.query, 50, 100);
    const mem = await getSetting('membership');
    const [wallet, log, total] = await Promise.all([
      one('select credit_cents, page_credits, updated_at from wallets where user_id = $1', [u.id]),
      q(`select id, kind, credit_cents, page_credits, note, created_at from wallet_log where user_id = $1 order by created_at desc, id desc limit ${limit} offset ${offset}`, [u.id]),
      one<{ n: number }>('select count(*)::int as n from wallet_log where user_id = $1', [u.id]),
    ]);
    return { wallet: wallet ?? { credit_cents: 0, page_credits: 0, updated_at: null }, page_credit_cents: mem.page_credit_cents, log, total: total?.n ?? 0, page, limit };
  });

  /** Purchases, newest first, each with its lines. */
  app.get('/api/account/orders', async (req) => {
    const u = requireUser(req);
    const { limit, offset, page } = pageParams(req.query, 20, 100);
    const orders = await q(
      `select id, status, total_cents, credit_cents, provider, created_at, paid_at, refunded_at from orders
        where user_id = $1 and status in ('paid','refunded') order by created_at desc limit ${limit} offset ${offset}`,
      [u.id],
    );
    const items = orders.length ? await q('select id, order_id, kind, description, price_cents, release_id, series_id, publisher_id, bundle_id from order_items where order_id = any($1) order by id', [orders.map((o) => o.id)]) : [];
    const total = await one<{ n: number }>(`select count(*)::int as n from orders where user_id = $1 and status in ('paid','refunded')`, [u.id]);
    return {
      items: orders.map((o) => ({ ...o, charged_cents: o.total_cents - o.credit_cents, items: items.filter((i) => i.order_id === o.id).map(({ order_id: _o, ...i }) => i) })),
      total: total?.n ?? 0, page, limit,
    };
  });

  /** Gift cards this account bought (codes are shown so they can be passed on) and what it has redeemed. */
  app.get('/api/account/gift-cards', async (req) => {
    const u = requireUser(req);
    const bought = await q('select id, code, amount_cents, balance_cents, recipient_email, message, redeemed_at, created_at from gift_cards where purchaser_id = $1 order by created_at desc limit 100', [u.id]);
    const redeemed = await q('select id, amount_cents, redeemed_at from gift_cards where redeemed_by = $1 order by redeemed_at desc limit 100', [u.id]);
    return { bought: bought.map((g) => ({ ...g, redeemed: Boolean(g.redeemed_at) })), redeemed };
  });

  /** Public profile at /u/<username>. */
  app.get('/api/users/:username', async (req) => {
    const p = await one(
      `select id, username, display_name, bio, avatar_key, prefs, created_at from users where lower(username) = lower($1) and deleted_at is null and banned_at is null`,
      [(req.params as { username: string }).username],
    );
    if (!p) throw notFound('User not found');
    const brands = await q(
      `select p.slug, p.name, p.kind, p.avatar_key, m.role from publisher_members m join publishers p on p.id = m.publisher_id
        where m.user_id = $1 and p.deleted_at is null and p.suspended_at is null order by p.name`,
      [p.id],
    );
    const params: unknown[] = [];
    const vis = listable(req, params);
    params.push(p.id);
    const favorites = await toCards(await q(`${CARD_SELECT} where ${vis} and exists (select 1 from favorites f where f.user_id = $${params.length} and f.series_id = s.id) order by s.title limit 24`, params));
    return {
      user: {
        id: p.id, username: p.username, name: p.prefs?.show_real_name === false ? p.username : p.display_name || p.username, bio: p.bio, avatar_url: await publicUrl(p.avatar_key),
        joined_at: p.created_at, accepts_messages: p.prefs?.allow_dms !== false, is_me: req.user?.id === p.id,
      },
      brands: await Promise.all(brands.map(async (b) => ({ slug: b.slug, name: b.name, kind: b.kind, role: b.role, avatar_url: await publicUrl(b.avatar_key) }))),
      favorites,
    };
  });
}
