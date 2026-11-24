import { timingSafeEqual } from 'node:crypto';
import { appendFile } from 'node:fs/promises';
import { isIP } from 'node:net';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import sharp from 'sharp';
import { z } from 'zod';
import { config } from '../config.ts';
import { exec, one, q, tx } from '../db.ts';
import type { Queryable, Row } from '../db.ts';
import { button, escapeHtml, layout, queueEmail } from './email.ts';
import { HttpError, audit, badRequest, forbidden, isAdmin, notFound } from './http.ts';
import type { SessionUser } from './http.ts';
import { notify } from './notify.ts';
import { getSetting } from './settings.ts';
import { storage } from './storage.ts';

/**
 * Shared helpers for the /api/admin route files.
 *
 * Conventions (carried over from IndieCrowdfund):
 *   - every handler re-checks the role itself (requireAdmin / requireSuperAdmin);
 *     nothing relies on a parent layout or hook for authorisation
 *   - every mutation writes an audit_log row
 *   - secrets never leave the server
 */

/** The footer pages. Admins edit these; they cannot add or remove slugs. */
export const CMS_SLUGS = ['about', 'creator-promise', 'contact', 'content-policy', 'publisher-sla', 'privacy', 'privacy-choices', 'terms', 'publisher-terms', 'faq'];

/** Paths that stay reachable while an admin still has to enrol in 2FA. */
const MFA_EXEMPT_PREFIX = '/api/admin/security/2fa';

/**
 * When settings.security.admin_2fa_required is on, staff without TOTP can only
 * reach the enrolment endpoints. Authorisation itself stays in each handler.
 */
async function mfaGate(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  reply.header('cache-control', 'no-store');
  const u = req.user;
  if (!u || !isAdmin(u) || u.totp_enabled) return;
  if (req.url.split('?')[0].startsWith(MFA_EXEMPT_PREFIX)) return;
  const security = await getSetting('security');
  if (security.admin_2fa_required) {
    throw new HttpError(403, 'Set up two-factor authentication to keep using the admin panel', 'mfa_setup_required');
  }
}

/** Register admin routes inside an encapsulated scope that carries the 2FA gate. */
export async function adminScope(app: FastifyInstance, routes: (scope: FastifyInstance) => void | Promise<void>): Promise<void> {
  await app.register(async (scope) => {
    scope.addHook('preHandler', mfaGate);
    await routes(scope);
  });
}

// ---------------------------------------------------------------- request helpers

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Route param that must be a UUID; anything else is a 404 rather than a database error. */
export function idParam(req: FastifyRequest, name = 'id'): string {
  const v = (req.params as Record<string, string>)[name];
  if (!v || !UUID.test(v)) throw notFound();
  return v.toLowerCase();
}

export function query(req: FastifyRequest): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries((req.query ?? {}) as Record<string, unknown>)) {
    if (typeof v === 'string' && v !== '') out[k] = v;
  }
  return out;
}

export const isUuid = (s: string | undefined): s is string => Boolean(s && UUID.test(s));

/** Escape a search term for ILIKE and wrap it in wildcards. */
export function like(term: string): string {
  return `%${term.trim().replace(/[\\%_]/g, (c) => '\\' + c)}%`;
}

/** Incrementally built WHERE clause with numbered parameters. */
export function where() {
  const parts: string[] = [];
  const values: unknown[] = [];
  return {
    values,
    /** `sql` uses `?` for the value placeholder(s); each `?` consumes one value. */
    add(sql: string, ...vals: unknown[]) {
      let i = 0;
      parts.push(sql.replace(/\?/g, () => {
        values.push(vals[i++]);
        return `$${values.length}`;
      }));
    },
    /** Push a value and return its `$n` placeholder. */
    param(v: unknown): string {
      values.push(v);
      return `$${values.length}`;
    },
    get sql(): string {
      return parts.length ? 'where ' + parts.join(' and ') : '';
    },
  };
}

export function dateRange(w: ReturnType<typeof where>, column: string, qy: Record<string, string>): void {
  if (qy.from && !Number.isNaN(Date.parse(qy.from))) w.add(`${column} >= ?`, new Date(qy.from));
  if (qy.to && !Number.isNaN(Date.parse(qy.to))) w.add(`${column} <= ?`, new Date(qy.to));
}

/** An ISO date/time string, or null to clear. */
export const zDate = z
  .string()
  .refine((s) => !Number.isNaN(Date.parse(s)), 'Enter a valid date and time')
  .transform((s) => new Date(s).toISOString());

export const zReason = z.string().trim().min(3, 'Give a reason (at least 3 characters)').max(1000);

export function money(cents: number, currency = 'usd'): string {
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: currency.toUpperCase() }).format(cents / 100);
  } catch {
    return `${(cents / 100).toFixed(2)} ${currency.toUpperCase()}`;
  }
}

// ---------------------------------------------------------------- uploads

/**
 * Read one multipart image, re-encode it as WebP (drops metadata, bounds the
 * size) and store it under public/<prefix>/. Returns the storage key.
 */
export async function receiveImage(req: FastifyRequest, prefix: string, name: string, maxWidth = 2400): Promise<string> {
  if (!req.isMultipart()) throw badRequest('Send the image as multipart/form-data in a field named "file"');
  const file = await req.file({ limits: { fileSize: 20 * 1024 * 1024, files: 1 } });
  if (!file) throw badRequest('Attach an image file');
  const input = await file.toBuffer();
  let out: Buffer;
  try {
    out = await sharp(input).rotate().resize({ width: maxWidth, withoutEnlargement: true }).webp({ quality: 88 }).toBuffer();
  } catch {
    throw badRequest('That file is not an image we can read. Use a JPG, PNG, WebP or AVIF.');
  }
  const key = `public/${prefix}/${name}-${Date.now().toString(36)}.webp`;
  await (await storage()).put(key, out, 'image/webp');
  return key;
}

/** Best-effort removal of a replaced upload. */
export async function dropObject(key: string | null | undefined): Promise<void> {
  if (!key) return;
  await (await storage()).del(key).catch(() => {});
}

// ---------------------------------------------------------------- people

export type BrandContact = { id: string; email: string; display_name: string };

/** Owners (and brand admins) of a brand: the people told about moderation and payouts. */
export async function brandContacts(publisherId: string, roles: string[] = ['owner']): Promise<BrandContact[]> {
  return q<BrandContact>(
    `select u.id, u.email, u.display_name
       from publisher_members m join users u on u.id = m.user_id
      where m.publisher_id = $1 and m.role = any($2::text[]) and u.deleted_at is null`,
    [publisherId, roles],
  );
}

/** In-app notification plus a plain service email to each brand owner. */
export async function tellBrand(publisherId: string, kind: string, title: string, body: string, path: string, label = 'Open Studio'): Promise<number> {
  const people = await brandContacts(publisherId);
  for (const p of people) {
    await notify(p.id, kind, title, body, path);
    const html = await layout(
      `<p>Hi ${escapeHtml(p.display_name)},</p><p><strong>${escapeHtml(title)}</strong></p><p>${escapeHtml(body)}</p>${button(label, config.appUrl + path)}`,
    );
    await queueEmail({ to: p.email, subject: title, html, template: 'moderation_notice', category: 'transactional', userId: p.id, publisherId });
  }
  return people.length;
}

/**
 * Staff accounts can only be changed by a super admin, and nobody moderates
 * themselves. Returns the target row.
 */
export async function moderationTarget(actor: SessionUser, userId: string): Promise<Row> {
  const t = await one('select id, email, username, display_name, role, banned_at, deleted_at from users where id = $1', [userId]);
  if (!t) throw notFound('User not found');
  if (t.id === actor.id) throw badRequest('You cannot do that to your own account');
  if (t.role !== 'user' && actor.role !== 'super_admin') throw forbidden('Only a super admin can change another staff account');
  return t;
}

export async function banUser(req: FastifyRequest, actor: SessionUser, userId: string, reason: string, via?: Record<string, unknown>): Promise<void> {
  const t = await moderationTarget(actor, userId);
  if (t.role === 'super_admin') throw badRequest('Remove the super admin role before banning this account');
  await tx(async (db) => {
    await exec('update users set banned_at = now(), ban_reason = $2 where id = $1', [userId, reason], db);
    await exec('delete from sessions where user_id = $1', [userId], db);
  });
  audit(req, 'user.ban', { kind: 'user', id: userId }, { reason, email: t.email, ...via });
}

export async function takedownSeries(req: FastifyRequest, seriesId: string, reason: string, via?: Record<string, unknown>): Promise<Row> {
  const s = await one(
    `update series set takedown_at = now(), takedown_reason = $2, updated_at = now()
      where id = $1 and deleted_at is null returning id, title, slug, publisher_id`,
    [seriesId, reason],
  );
  if (!s) throw notFound('Series not found');
  await exec('delete from featured where series_id = $1', [seriesId]);
  await tellBrand(
    s.publisher_id,
    'moderation',
    `"${s.title}" has been taken down`,
    `Our moderation team removed this series from the store. Reason: ${reason} Reply to this email or contact support if you think this is a mistake.`,
    `/studio/series/${s.id}`,
  );
  audit(req, 'series.takedown', { kind: 'series', id: seriesId }, { reason, title: s.title, ...via });
  return s;
}

// ---------------------------------------------------------------- money

export type Balance = { balance_cents: number; available_cents: number; pending_cents: number };

/** Ledger balance for a brand. `available` excludes earnings still inside the payout hold. */
export async function brandBalance(publisherId: string, db?: Queryable): Promise<Balance> {
  const r = await one<{ balance: number; available: number }>(
    `select coalesce(sum(amount_cents), 0)::bigint as balance,
            coalesce(sum(amount_cents) filter (where available_at <= now()), 0)::bigint as available
       from ledger where publisher_id = $1`,
    [publisherId],
    db,
  );
  const balance = r?.balance ?? 0;
  const available = r?.available ?? 0;
  return { balance_cents: balance, available_cents: available, pending_cents: balance - available };
}

// ---------------------------------------------------------------- firewall files

/** Contract with scripts/botblock: one IP per line. */
export const BOTBLOCK_PENDING = '/tmp/botblock-pending';
export const BOTBLOCK_UNBLOCK = '/tmp/botblock-unblock';

export function assertIp(ip: string): string {
  const v = ip.trim();
  if (!isIP(v)) throw badRequest('Enter a valid IPv4 or IPv6 address');
  return v;
}

export async function queueFirewall(file: string, ip: string): Promise<void> {
  if (!isIP(ip)) return;
  await appendFile(file, ip + '\n').catch(() => {});
}

// ---------------------------------------------------------------- cron

/** `Authorization: Bearer $CRON_SECRET`. Fails closed when the secret is not configured. */
export function requireCron(req: FastifyRequest): void {
  if (!config.cronSecret) throw new HttpError(503, 'Cron is disabled: CRON_SECRET is not set on the server');
  const header = req.headers.authorization ?? '';
  const given = Buffer.from(header.startsWith('Bearer ') ? header.slice(7) : '');
  const expected = Buffer.from(config.cronSecret);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) throw new HttpError(401, 'Invalid cron credentials');
}

/** Run a named task and record it in cron_runs either way. */
export async function recordRun(job: string, fn: () => Promise<string | void>): Promise<{ ok: boolean; job: string; detail: string }> {
  const started = new Date();
  try {
    const detail = (await fn()) || 'nothing to do';
    await exec('insert into cron_runs (job, ok, detail, started_at, finished_at) values ($1,true,$2,$3,now())', [job, detail.slice(0, 500), started]);
    return { ok: true, job, detail };
  } catch (e) {
    const detail = (e as Error).message.slice(0, 500);
    await exec('insert into cron_runs (job, ok, detail, started_at, finished_at) values ($1,false,$2,$3,now())', [job, detail, started]).catch(() => {});
    if (e instanceof HttpError) throw e;
    throw new HttpError(500, `${job} failed: ${detail}`);
  }
}

// ---------------------------------------------------------------- settlement bridge

export type SettleFn = (month: string, opts?: { ranBy?: string | null }) => Promise<unknown>;
export type SettlementModule = { settleMonth: SettleFn; previewSettlement?: (month: string) => Promise<unknown> };

/**
 * The subscription split lives in jobs/settlement.ts (reader/commerce area).
 * It is loaded lazily so the admin API still boots if that file is absent.
 * Expected exports: `settleMonth(month: 'YYYY-MM-01', { ranBy })` and,
 * optionally, `previewSettlement(month)`.
 */
export async function settlementModule(): Promise<SettlementModule> {
  let mod: Record<string, unknown>;
  try {
    mod = await import(new URL('../jobs/settlement.ts', import.meta.url).href);
  } catch (e) {
    if ((e as { code?: string }).code === 'ERR_MODULE_NOT_FOUND') {
      throw new HttpError(501, 'Settlement is not installed on this server (api/src/jobs/settlement.ts is missing)', 'settlement_missing');
    }
    throw e;
  }
  if (typeof mod.settleMonth !== 'function') {
    throw new HttpError(501, 'Settlement is not available: jobs/settlement.ts does not export settleMonth(month, opts)', 'settlement_missing');
  }
  return mod as unknown as SettlementModule;
}

/** 'YYYY-MM' or 'YYYY-MM-DD' -> first day of that month. */
export function monthStart(input: string): string {
  const m = /^(\d{4})-(\d{2})(?:-\d{2})?$/.exec(input);
  if (!m || Number(m[2]) < 1 || Number(m[2]) > 12) throw badRequest('Month must look like 2026-10');
  return `${m[1]}-${m[2]}-01`;
}

export function previousMonth(now = new Date()): string {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  return d.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------- email template preview

const RAW_VARS = new Set(['items']);

/** Same substitution rules as lib/email.ts `sendTemplate` (kept in step with it). */
export function renderTemplate(tpl: string, vars: Record<string, string>, html: boolean): string {
  return tpl
    .replace(/\{\{button:([^|}]+)\|(\w+)\}\}/g, (_m, label: string, key: string) => (html ? button(label, vars[key] ?? '#') : `${label}: ${vars[key] ?? ''}`))
    .replace(/\{\{(\w+)\}\}/g, (_m, key: string) => {
      const v = vars[key] ?? '';
      return html && !RAW_VARS.has(key) ? escapeHtml(v) : v;
    });
}
