import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { config } from '../config.ts';
import { exec, one, q } from '../db.ts';
import { createSession, destroySession, setAdultCookie } from '../lib/auth.ts';
import { rateLimit } from '../lib/botblock.ts';
import { hashPassword, randomToken, sha256, verifyPassword } from '../lib/crypto.ts';
import { readUnsubscribeToken, sendTemplate } from '../lib/email.ts';
import { HttpError, audit, badRequest, conflict, parse, requireUser } from '../lib/http.ts';
import { getSetting, publicSettings } from '../lib/settings.ts';
import { publicUrl } from '../lib/storage.ts';
import { meta } from '../lib/taxonomy.ts';
import { hasMembership } from '../lib/access.ts';

const USERNAME = /^[A-Za-z0-9_]{3,24}$/;

const RECAPTCHA_MIN_SCORE = 0.5;

/** reCAPTCHA v3: Google scores the visit 0.0 (bot) to 1.0 (human); the token must also be for this form. */
async function verifyRecaptcha(token: string | undefined, ip: string, action: 'register' | 'forgot'): Promise<void> {
  const s = await getSetting('security');
  if (!s.recaptcha_enabled || !s.recaptcha_secret_key) return;
  if (!token) throw badRequest('The spam check did not run. Reload the page and try again.');
  try {
    const res = await fetch('https://www.google.com/recaptcha/api/siteverify', {
      method: 'POST',
      body: new URLSearchParams({ secret: s.recaptcha_secret_key, response: token, remoteip: ip }),
      signal: AbortSignal.timeout(8000),
    });
    const body = (await res.json()) as { success?: boolean; score?: number; action?: string };
    if (!body.success || body.action !== action || (body.score ?? 0) < RECAPTCHA_MIN_SCORE) throw badRequest('We could not confirm you are human. Please try again.');
  } catch (e) {
    if (e instanceof HttpError) throw e;
    throw new HttpError(503, 'The spam check is unavailable right now. Please try again.');
  }
}

async function issueToken(userId: string, kind: 'verify' | 'reset' | 'email_change', hours: number, payload: object = {}): Promise<string> {
  const token = randomToken(32);
  await exec(`insert into email_tokens (token_hash, user_id, kind, payload, expires_at) values ($1,$2,$3,$4, now() + ($5 || ' hours')::interval)`, [
    sha256(token), userId, kind, JSON.stringify(payload), String(hours),
  ]);
  return token;
}

async function consumeToken(token: string, kind: string) {
  return one<{ user_id: string; payload: Record<string, string> }>(
    `update email_tokens set used_at = now() where token_hash = $1 and kind = $2 and used_at is null and expires_at > now() returning user_id, payload`,
    [sha256(token), kind],
  );
}

/** Everything the web app needs about the signed-in user, in one call. */
async function me(req: FastifyRequest) {
  const u = req.user;
  if (!u) return null;
  const [brands, member, wallet, unread, row] = await Promise.all([
    q(
      `select p.id, p.slug, p.name, p.kind, p.avatar_key, m.role
         from publisher_members m join publishers p on p.id = m.publisher_id
        where m.user_id = $1 and p.deleted_at is null order by p.name`,
      [u.id],
    ),
    hasMembership(u.id),
    one('select credit_cents, page_credits from wallets where user_id = $1', [u.id]),
    one<{ n: number }>('select count(*)::int as n from notifications where user_id = $1 and read_at is null', [u.id]),
    one('select bio, marketing_opt_in, created_at from users where id = $1', [u.id]),
  ]);
  for (const b of brands) b.avatar_url = await publicUrl(b.avatar_key);
  return {
    id: u.id,
    email: u.email,
    username: u.username,
    display_name: u.display_name,
    role: u.role,
    email_verified: Boolean(u.email_verified_at),
    avatar_url: await publicUrl(u.avatar_key),
    bio: row?.bio ?? '',
    prefs: u.prefs,
    totp_enabled: u.totp_enabled,
    member,
    brands,
    wallet: wallet ?? { credit_cents: 0, page_credits: 0 },
    unread_notifications: unread?.n ?? 0,
    created_at: row?.created_at,
  };
}

export default async function authRoutes(app: FastifyInstance) {
  // One call on page load: public settings, vocabularies, current user.
  // `settings.password_min_length` lets the sign-up, reset and change-password forms show the real rule.
  app.get('/api/bootstrap', async (req) => ({
    settings: { ...(await publicSettings()), password_min_length: (await getSetting('security')).password_min_length },
    meta: meta(), user: await me(req), adult: req.showMature,
  }));

  /**
   * "I am 18 or older, show me adult titles" (or turn it back off). Signed in:
   * saved on the account. Signed out: a cookie on this browser.
   */
  app.post('/api/age-confirm', async (req, reply) => {
    const { adult } = parse(z.object({ adult: z.boolean() }), req.body);
    if (req.user) {
      await exec(
        `update users set prefs = prefs || $2::jsonb where id = $1`,
        [req.user.id, JSON.stringify(adult ? { show_mature: true, adult_confirmed_at: new Date().toISOString() } : { show_mature: false })],
      );
    }
    setAdultCookie(reply, adult);
    return { ok: true, adult };
  });

  app.get('/api/auth/me', async (req) => ({ user: await me(req) }));

  app.post('/api/auth/register', async (req, reply) => {
    const site = await getSetting('site');
    if (!site.registration_open) throw new HttpError(403, 'Sign-ups are closed right now');
    if (!rateLimit('register', req.clientIp, 8, 3600)) throw new HttpError(429, 'Too many sign-ups from this network. Try again later.');
    const security = await getSetting('security');
    const body = parse(
      z.object({
        email: z.email('Enter a valid email address').max(200),
        username: z.string().regex(USERNAME, 'Username must be 3-24 letters, numbers or underscores'),
        password: z.string().min(security.password_min_length, `Password must be at least ${security.password_min_length} characters`).max(200),
        display_name: z.string().max(60).optional(),
        marketing_opt_in: z.boolean().optional(),
        adult: z.boolean().optional(),
        recaptcha: z.string().optional(),
        website: z.string().optional(), // honeypot
      }),
      req.body,
    );
    // Bots that fill the hidden field get a convincing success and no account.
    if (body.website) return { ok: true, user: null };
    await verifyRecaptcha(body.recaptcha, req.clientIp, 'register');

    const email = body.email.toLowerCase();
    if (await one('select 1 from users where lower(email) = $1', [email])) throw conflict('An account with that email already exists');
    if (await one('select 1 from users where lower(username) = lower($1)', [body.username])) throw conflict('That username is taken');

    const role = config.superAdminEmail && email === config.superAdminEmail ? 'super_admin' : 'user';
    const user = await one<{ id: string }>(
      `insert into users (email, username, display_name, password_hash, role, marketing_opt_in, prefs)
       values ($1,$2,$3,$4,$5,$6,$7) returning id`,
      [email, body.username, body.display_name?.trim() || body.username, await hashPassword(body.password), role, body.marketing_opt_in ?? false,
       JSON.stringify({ ...(body.adult ? { show_mature: true, adult_confirmed_at: new Date().toISOString() } : {}), notify: { releases: true, messages: true, replies: true, mentions: true, followers: true, feed: true, analytics: true, newsletter: body.marketing_opt_in ?? false } })],
    );
    const token = await issueToken(user!.id, 'verify', 48);
    await sendTemplate('verify_email', email, { name: body.display_name?.trim() || body.username, url: `${config.appUrl}/verify-email?token=${token}` }, { userId: user!.id });
    await createSession(req, reply, user!.id);
    req.user = await one('select id, email, username, display_name, role, email_verified_at, avatar_key, prefs, totp_enabled from users where id = $1', [user!.id]) as never;
    return { ok: true, user: await me(req) };
  });

  app.post('/api/auth/login', async (req, reply) => {
    const body = parse(z.object({ email: z.string().min(1).max(200), password: z.string().min(1).max(200), totp: z.string().optional() }), req.body);
    if (!rateLimit('login', req.clientIp, 30, 900)) throw new HttpError(429, 'Too many sign-in attempts. Try again in a few minutes.');
    const security = await getSetting('security');
    const ident = body.email.trim().toLowerCase();
    const user = await one(
      `select id, email, password_hash, banned_at, ban_reason, failed_logins, locked_until, totp_enabled, totp_secret, totp_backup_codes
         from users where (lower(email) = $1 or lower(username) = $1) and deleted_at is null`,
      [ident],
    );
    const log = (success: boolean, reason: string) =>
      exec('insert into login_events (user_id, email, ip, user_agent, success, reason) values ($1,$2,$3,$4,$5,$6)', [
        user?.id ?? null, ident, req.clientIp, String(req.headers['user-agent'] ?? '').slice(0, 300), success, reason,
      ]).catch(() => {});

    if (user?.locked_until && Date.parse(user.locked_until) > Date.now()) {
      log(false, 'locked');
      throw new HttpError(429, 'This account is temporarily locked after too many failed sign-ins. Try again in 15 minutes or reset your password.');
    }
    const ok = user ? await verifyPassword(body.password, user.password_hash) : false;
    if (!user || !ok) {
      if (user) {
        await exec(
          `update users set failed_logins = failed_logins + 1,
                  locked_until = case when failed_logins + 1 >= $2 then now() + interval '15 minutes' else locked_until end
            where id = $1`,
          [user.id, security.max_login_attempts],
        );
      }
      log(false, 'password_invalid');
      throw new HttpError(401, 'Email or password is incorrect');
    }
    if (user.banned_at) {
      log(false, 'banned');
      throw new HttpError(403, `This account has been suspended${user.ban_reason ? `: ${user.ban_reason}` : ''}`);
    }
    if (user.totp_enabled) {
      if (!body.totp) {
        log(false, 'mfa_pending');
        return reply.code(401).send({ error: 'Enter the 6-digit code from your authenticator app', code: 'totp_required' });
      }
      const { verifyTotp } = await import('../lib/totp.ts');
      const code = body.totp.replace(/\s/g, '');
      const backupIndex = (user.totp_backup_codes as string[]).indexOf(sha256(code.toUpperCase()));
      if (backupIndex >= 0) {
        await exec('update users set totp_backup_codes = array_remove(totp_backup_codes, $2) where id = $1', [user.id, sha256(code.toUpperCase())]);
      } else if (!(await verifyTotp(user.totp_secret, code))) {
        log(false, 'mfa_failed');
        throw new HttpError(401, 'That code is not valid. Check your authenticator app and try again.');
      }
    }
    await createSession(req, reply, user.id);
    log(true, user.totp_enabled ? 'mfa_ok' : 'ok');
    req.user = await one('select id, email, username, display_name, role, email_verified_at, avatar_key, prefs, totp_enabled from users where id = $1', [user.id]) as never;
    return { ok: true, user: await me(req) };
  });

  app.post('/api/auth/logout', async (req, reply) => {
    await destroySession(req, reply);
    return { ok: true };
  });

  app.post('/api/auth/verify-email', async (req) => {
    const { token } = parse(z.object({ token: z.string().min(10) }), req.body);
    const t = await consumeToken(token, 'verify');
    if (!t) throw badRequest('This confirmation link has expired or was already used');
    const u = await one<{ email: string; display_name: string; email_verified_at: string | null }>(
      'update users set email_verified_at = coalesce(email_verified_at, now()) where id = $1 returning email, display_name, email_verified_at', [t.user_id],
    );
    if (u) await sendTemplate('welcome', u.email, { name: u.display_name, url: config.appUrl }, { userId: t.user_id });
    return { ok: true };
  });

  app.post('/api/auth/resend-verification', async (req) => {
    const u = requireUser(req);
    if (u.email_verified_at) return { ok: true };
    if (!rateLimit('resend', u.id, 3, 900)) throw new HttpError(429, 'We just sent one. Check your inbox, or try again in a few minutes.');
    const token = await issueToken(u.id, 'verify', 48);
    await sendTemplate('verify_email', u.email, { name: u.display_name, url: `${config.appUrl}/verify-email?token=${token}` }, { userId: u.id });
    return { ok: true };
  });

  app.post('/api/auth/forgot', async (req) => {
    const { email, recaptcha } = parse(z.object({ email: z.string().max(200), recaptcha: z.string().optional() }), req.body);
    if (!rateLimit('forgot', req.clientIp, 5, 900)) throw new HttpError(429, 'Too many requests. Try again in a few minutes.');
    await verifyRecaptcha(recaptcha, req.clientIp, 'forgot');
    const u = await one<{ id: string; email: string; display_name: string }>('select id, email, display_name from users where lower(email) = $1 and deleted_at is null', [email.trim().toLowerCase()]);
    if (u) {
      const token = await issueToken(u.id, 'reset', 2);
      await sendTemplate('reset_password', u.email, { name: u.display_name, url: `${config.appUrl}/reset-password?token=${token}` }, { userId: u.id });
    }
    // Same answer either way, so the form cannot be used to test which emails have accounts.
    return { ok: true };
  });

  app.post('/api/auth/reset', async (req, reply) => {
    const security = await getSetting('security');
    const { token, password } = parse(
      z.object({ token: z.string().min(10), password: z.string().min(security.password_min_length, `Password must be at least ${security.password_min_length} characters`).max(200) }),
      req.body,
    );
    const t = await consumeToken(token, 'reset');
    if (!t) throw badRequest('This reset link has expired or was already used');
    await exec('update users set password_hash = $2, failed_logins = 0, locked_until = null where id = $1', [t.user_id, await hashPassword(password)]);
    await exec('delete from sessions where user_id = $1', [t.user_id]);
    await createSession(req, reply, t.user_id);
    audit(req, 'user.password_reset', { kind: 'user', id: t.user_id });
    return { ok: true };
  });

  app.post('/api/auth/confirm-email-change', async (req) => {
    const { token } = parse(z.object({ token: z.string().min(10) }), req.body);
    const t = await consumeToken(token, 'email_change');
    if (!t?.payload?.email) throw badRequest('This confirmation link has expired or was already used');
    if (await one('select 1 from users where lower(email) = $1 and id <> $2', [t.payload.email, t.user_id])) throw conflict('That email is already in use');
    await exec('update users set email = $2, email_verified_at = now() where id = $1', [t.user_id, t.payload.email]);
    return { ok: true };
  });

  // Used by account settings (routes/account.ts) to start an email change.
  app.decorate('issueEmailToken', issueToken);

  // One-click unsubscribe (RFC 8058) and the link in email footers.
  const unsubscribe = async (req: FastifyRequest) => {
    const token = String((req.query as { token?: string }).token ?? (req.body as { token?: string } | undefined)?.token ?? '');
    const email = readUnsubscribeToken(token);
    if (!email) throw badRequest('This unsubscribe link is not valid');
    await exec('update users set email_unsubscribed_at = now() where lower(email) = $1', [email]);
    await exec(`insert into email_suppressions (email, reason, source) values ($1, 'Unsubscribed from non-essential email', 'unsubscribe') on conflict do nothing`, [email]).catch(() => {});
    return email;
  };
  app.get('/api/unsubscribe', async (req, reply) => {
    await unsubscribe(req);
    return reply.redirect(`${config.appUrl}/unsubscribed`);
  });
  app.post('/api/unsubscribe', async (req) => {
    await unsubscribe(req);
    return { ok: true };
  });
}

declare module 'fastify' {
  interface FastifyInstance {
    issueEmailToken: (userId: string, kind: 'verify' | 'reset' | 'email_change', hours: number, payload?: object) => Promise<string>;
  }
}
