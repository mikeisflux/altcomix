import type { FastifyReply, FastifyRequest } from 'fastify';
import { config } from '../config.ts';
import { exec, one } from '../db.ts';
import { randomToken, sha256 } from './crypto.ts';
import type { SessionUser } from './http.ts';

export const SESSION_COOKIE = 'session_token';
export const CSRF_COOKIE = 'csrf_token';
const SESSION_DAYS = 30;

const cookieBase = { path: '/', sameSite: 'lax' as const, secure: config.isProd };

export async function createSession(req: FastifyRequest, reply: FastifyReply, userId: string): Promise<void> {
  const token = randomToken(32);
  const csrf = randomToken(24);
  await exec(
    `insert into sessions (token_hash, user_id, csrf_token, ip, user_agent, expires_at)
     values ($1,$2,$3,$4,$5, now() + ($6 || ' days')::interval)`,
    [sha256(token), userId, csrf, req.clientIp, String(req.headers['user-agent'] ?? '').slice(0, 300), String(SESSION_DAYS)],
  );
  await exec('update users set last_login_at = now(), last_ip = $2, failed_logins = 0, locked_until = null where id = $1', [userId, req.clientIp]);
  const maxAge = SESSION_DAYS * 86400;
  reply.setCookie(SESSION_COOKIE, token, { ...cookieBase, httpOnly: true, maxAge });
  reply.setCookie(CSRF_COOKIE, csrf, { ...cookieBase, httpOnly: false, maxAge });
}

export async function destroySession(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (req.sessionHash) await exec('delete from sessions where token_hash = $1', [req.sessionHash]);
  reply.clearCookie(SESSION_COOKIE, cookieBase);
}

/** Give anonymous visitors a CSRF cookie too, so public forms can post. */
export function ensureCsrfCookie(req: FastifyRequest, reply: FastifyReply): void {
  if (!req.cookies[CSRF_COOKIE]) {
    reply.setCookie(CSRF_COOKIE, randomToken(24), { ...cookieBase, httpOnly: false, maxAge: SESSION_DAYS * 86400 });
  }
}

export async function loadSession(req: FastifyRequest): Promise<void> {
  req.user = null;
  req.sessionHash = null;
  const token = req.cookies[SESSION_COOKIE];
  if (!token) return;
  const hash = sha256(token);
  const row = await one<SessionUser & { banned_at: string | null }>(
    `select u.id, u.email, u.username, u.display_name, u.role, u.email_verified_at, u.avatar_key, u.prefs,
            u.totp_enabled, u.banned_at
       from sessions s join users u on u.id = s.user_id
      where s.token_hash = $1 and s.expires_at > now() and u.deleted_at is null`,
    [hash],
  );
  if (!row || row.banned_at) return;
  req.user = row;
  req.sessionHash = hash;
  // Touch at most once a minute.
  exec(`update sessions set last_seen_at = now() where token_hash = $1 and last_seen_at < now() - interval '1 minute'`, [hash]).catch(() => {});
}

const CSRF_EXEMPT = ['/api/webhooks/', '/api/cron/', '/api/track'];

/** Double-submit check: header must equal the cookie on every mutating /api call. */
export function csrfOk(req: FastifyRequest): boolean {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return true;
  const path = req.url.split('?')[0];
  if (!path.startsWith('/api/')) return true;
  if (CSRF_EXEMPT.some((p) => path.startsWith(p))) return true;
  const cookie = req.cookies[CSRF_COOKIE];
  const header = req.headers['x-csrf-token'];
  return Boolean(cookie) && typeof header === 'string' && header === cookie;
}

/** Rightmost X-Forwarded-For entry is the one our own proxy appended. */
export function clientIp(req: FastifyRequest): string {
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff.trim()) {
    const parts = xff.split(',').map((s) => s.trim()).filter(Boolean);
    if (parts.length) return parts[parts.length - 1];
  }
  const real = req.headers['x-real-ip'] ?? req.headers['cf-connecting-ip'];
  if (typeof real === 'string' && real) return real;
  return req.ip || 'unknown';
}

export function clientCountry(req: FastifyRequest): string | null {
  const c = req.headers['cf-ipcountry'] ?? req.headers['x-country'];
  return typeof c === 'string' && /^[A-Za-z]{2}$/.test(c) ? c.toUpperCase() : null;
}
