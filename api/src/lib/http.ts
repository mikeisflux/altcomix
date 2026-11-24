import type { FastifyRequest } from 'fastify';
import type { ZodType } from 'zod';
import { exec, one } from '../db.ts';

/** Thrown anywhere in a handler; rendered as `{ error }` with the status. */
export class HttpError extends Error {
  status: number;
  code?: string;
  constructor(status: number, message: string, code?: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export const badRequest = (m: string, code?: string) => new HttpError(400, m, code);
export const unauthorized = (m = 'Sign in to continue') => new HttpError(401, m);
export const forbidden = (m = 'You do not have access to this') => new HttpError(403, m);
export const notFound = (m = 'Not found') => new HttpError(404, m);
export const conflict = (m: string) => new HttpError(409, m);
export const paymentRequired = (m = 'Purchase or membership required') => new HttpError(402, m);

export type SessionUser = {
  id: string;
  email: string;
  username: string;
  display_name: string;
  role: 'user' | 'admin' | 'super_admin';
  email_verified_at: string | null;
  avatar_key: string | null;
  prefs: Record<string, unknown>;
  totp_enabled: boolean;
};

declare module 'fastify' {
  interface FastifyRequest {
    user: SessionUser | null;
    sessionHash: string | null;
    clientIp: string;
    /** Reader has confirmed they are an adult and wants adult titles shown (account setting, or the age cookie when signed out). */
    showMature: boolean;
    country: string | null;
  }
}

/** Validate with zod; the first issue becomes a 400 with a readable message. */
export function parse<T>(schema: ZodType<T>, data: unknown): T {
  const r = schema.safeParse(data);
  if (r.success) return r.data;
  const issue = r.error.issues[0];
  const path = issue.path.join('.');
  throw badRequest(path ? `${path}: ${issue.message}` : issue.message, 'validation');
}

export function requireUser(req: FastifyRequest): SessionUser {
  if (!req.user) throw unauthorized();
  return req.user;
}

export function isAdmin(user: SessionUser | null): boolean {
  return user?.role === 'admin' || user?.role === 'super_admin';
}

export function requireAdmin(req: FastifyRequest): SessionUser {
  const u = requireUser(req);
  if (!isAdmin(u)) throw forbidden('Admin access required');
  return u;
}

export function requireSuperAdmin(req: FastifyRequest): SessionUser {
  const u = requireUser(req);
  if (u.role !== 'super_admin') throw forbidden('Super admin access required');
  return u;
}

export type MemberRole = 'owner' | 'admin' | 'editor' | 'analyst';
const RANK: Record<MemberRole, number> = { analyst: 1, editor: 2, admin: 3, owner: 4 };

/**
 * Confirms the signed-in user belongs to the publisher with at least `min`
 * role. Platform admins pass as owners. Returns the effective role.
 */
export async function requireMember(req: FastifyRequest, publisherId: string, min: MemberRole = 'editor'): Promise<MemberRole> {
  const u = requireUser(req);
  if (isAdmin(u)) return 'owner';
  const m = await one<{ role: MemberRole }>('select role from publisher_members where publisher_id = $1 and user_id = $2', [publisherId, u.id]);
  if (!m || RANK[m.role] < RANK[min]) throw forbidden('You are not a member of this brand with the required role');
  return m.role;
}

/** Series lookup + membership check in one step, for studio routes. */
export async function requireSeriesMember(req: FastifyRequest, seriesId: string, min: MemberRole = 'editor') {
  const s = await one('select * from series where id = $1 and deleted_at is null', [seriesId]);
  if (!s) throw notFound('Series not found');
  await requireMember(req, s.publisher_id, min);
  return s;
}

export async function requireReleaseMember(req: FastifyRequest, releaseId: string, min: MemberRole = 'editor') {
  const r = await one(
    `select r.*, s.publisher_id, s.slug as series_slug, s.title as series_title
       from releases r join series s on s.id = r.series_id
      where r.id = $1 and r.deleted_at is null and s.deleted_at is null`,
    [releaseId],
  );
  if (!r) throw notFound('Release not found');
  await requireMember(req, r.publisher_id, min);
  return r;
}

/** Fire-and-forget admin/creator audit trail. */
export function audit(req: FastifyRequest, action: string, target?: { kind: string; id: string }, meta: Record<string, unknown> = {}): void {
  exec('insert into audit_log (actor_id, action, target_kind, target_id, meta, ip) values ($1,$2,$3,$4,$5,$6)', [
    req.user?.id ?? null,
    action,
    target?.kind ?? null,
    target?.id ?? null,
    JSON.stringify(meta),
    req.clientIp,
  ]).catch((e) => req.log.error(e, 'audit write failed'));
}

export function slugify(input: string): string {
  return (
    input
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'untitled'
  );
}

/** Find a free slug in `table` by appending -2, -3, ... */
export async function uniqueSlug(table: 'series' | 'publishers' | 'news_posts', base: string): Promise<string> {
  const root = slugify(base);
  for (let i = 1; i < 500; i++) {
    const candidate = i === 1 ? root : `${root}-${i}`;
    const hit = await one(`select 1 from ${table} where slug = $1`, [candidate]);
    if (!hit) return candidate;
  }
  throw conflict('Could not find a free URL for that name');
}

export function pageParams(query: unknown, defaultLimit = 24, maxLimit = 100): { limit: number; offset: number; page: number } {
  const qy = (query ?? {}) as Record<string, string>;
  const limit = Math.min(maxLimit, Math.max(1, Number(qy.limit) || defaultLimit));
  const page = Math.max(1, Number(qy.page) || 1);
  return { limit, page, offset: (page - 1) * limit };
}
