import { isIP } from 'node:net';
import type { FastifyInstance } from 'fastify';
import QRCode from 'qrcode';
import { z } from 'zod';
import { exec, one, q } from '../db.ts';
import { BOTBLOCK_PENDING, BOTBLOCK_UNBLOCK, adminScope, assertIp, dateRange, idParam, isUuid, like, query, queueFirewall, where } from '../lib/admin.ts';
import { forgetBlockedIp, rateLimit } from '../lib/botblock.ts';
import { randomCode, sha256, verifyPassword } from '../lib/crypto.ts';
import { HttpError, audit, badRequest, conflict, notFound, pageParams, parse, requireAdmin, requireSuperAdmin } from '../lib/http.ts';
import { getSetting } from '../lib/settings.ts';
import { generateSecret, otpauthUrl, verifyTotp } from '../lib/totp.ts';

const PERMANENT = '9999-12-31T00:00:00Z';

function isPrivateOrLoopback(ip: string): boolean {
  if (isIP(ip) === 6) {
    const v = ip.toLowerCase();
    return v === '::1' || v.startsWith('fe80:') || v.startsWith('fc') || v.startsWith('fd') || v.startsWith('::ffff:127.');
  }
  const [a, b] = ip.split('.').map(Number);
  return a === 127 || a === 10 || a === 0 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
}

export default async function adminSecurityRoutes(app: FastifyInstance) {
  await adminScope(app, (s) => {
    // ------------------------------------------------------------ overview
    s.get('/api/admin/security/overview', async (req) => {
      requireSuperAdmin(req);
      const security = await getSetting('security');
      const c = await one(
        `select (select count(*) from blocked_ips where expires_at > now())::int as blocked_ips,
                (select count(*) from blocked_ips where expires_at > now() and blocked_at > now() - interval '24 hours')::int as blocked_24h,
                (select count(*) from suspicious_activity where created_at > now() - interval '24 hours')::int as suspicious_24h,
                (select count(*) from login_events where not success and created_at > now() - interval '24 hours')::int as failed_logins_24h,
                (select count(*) from login_events where success and created_at > now() - interval '24 hours')::int as logins_24h,
                (select count(*) from sessions where expires_at > now())::int as active_sessions,
                (select count(distinct user_id) from sessions where expires_at > now() and last_seen_at > now() - interval '15 minutes')::int as users_online,
                (select count(*) from users where locked_until > now())::int as locked_accounts,
                (select count(*) from users where role in ('admin','super_admin') and deleted_at is null)::int as staff,
                (select count(*) from users where role in ('admin','super_admin') and deleted_at is null and not totp_enabled)::int as staff_without_2fa`,
      );
      const topReasons = await q(
        `select reason, count(*)::int as count from suspicious_activity where created_at > now() - interval '24 hours' group by reason order by count desc limit 8`,
      );
      return {
        ...c,
        top_reasons: topReasons,
        settings: {
          bot_blocker_enabled: security.bot_blocker_enabled,
          rate_limit_per_minute: security.rate_limit_per_minute,
          admin_2fa_required: security.admin_2fa_required,
          recaptcha_enabled: security.recaptcha_enabled,
        },
      };
    });

    // ------------------------------------------------------------ blocked IPs
    s.get('/api/admin/security/blocked-ips', async (req) => {
      requireSuperAdmin(req);
      const qy = query(req);
      const { limit, offset, page } = pageParams(req.query, 50, 500);
      const w = where();
      if (qy.status === 'expired') w.add('expires_at <= now()');
      else if (qy.status !== 'all') w.add('expires_at > now()');
      if (qy.q) {
        const p = w.param(like(qy.q));
        w.add(`(ip_address ilike ${p} or reason ilike ${p} or last_user_agent ilike ${p})`);
      }
      const total = (await one<{ n: number }>(`select count(*)::int as n from blocked_ips ${w.sql}`, w.values))!.n;
      const items = await q(
        `select id, ip_address, reason, violation_count, blocked_at, expires_at, last_user_agent, last_path,
                (expires_at > now()) as active, (expires_at >= '9999-01-01') as permanent
           from blocked_ips ${w.sql} order by blocked_at desc limit ${limit} offset ${offset}`,
        w.values,
      );
      return { items, total, page, limit };
    });

    /** Manual block. `hours` omitted or null means permanent. */
    s.post('/api/admin/security/blocked-ips', async (req) => {
      requireSuperAdmin(req);
      const body = parse(
        z.object({ ip: z.string().max(60), reason: z.string().trim().min(3, 'Give a reason').max(300), hours: z.number().int().min(1).max(24 * 365).nullable().optional() }),
        req.body,
      );
      const ip = assertIp(body.ip);
      if (ip === req.clientIp) throw badRequest('That is the address you are connecting from');
      if (isPrivateOrLoopback(ip)) throw badRequest('Private and loopback addresses cannot be blocked');
      const expires = body.hours ? new Date(Date.now() + body.hours * 3_600_000) : new Date(PERMANENT);
      const row = await one(
        `insert into blocked_ips (ip_address, reason, violation_count, expires_at) values ($1, $2, 1, $3)
         on conflict (ip_address) do update set reason = excluded.reason, expires_at = excluded.expires_at, blocked_at = now(), updated_at = now()
         returning id, ip_address, reason, violation_count, blocked_at, expires_at`,
        [ip, `Manual: ${body.reason}`, expires],
      );
      forgetBlockedIp(ip); // forces this worker to reload the list; others follow within a minute
      await queueFirewall(BOTBLOCK_PENDING, ip);
      audit(req, 'security.block_ip', { kind: 'blocked_ip', id: ip }, { reason: body.reason, hours: body.hours ?? null });
      return { ok: true, item: row };
    });

    /** Unblock: remove the row, drop it from this worker's cache and tell the firewall watcher. */
    s.delete('/api/admin/security/blocked-ips/:id', async (req) => {
      requireSuperAdmin(req);
      const id = idParam(req);
      const row = await one<{ ip_address: string; reason: string; violation_count: number }>('delete from blocked_ips where id = $1 returning ip_address, reason, violation_count', [id]);
      if (!row) throw notFound('That block no longer exists');
      forgetBlockedIp(row.ip_address);
      await queueFirewall(BOTBLOCK_UNBLOCK, row.ip_address);
      audit(req, 'security.unblock_ip', { kind: 'blocked_ip', id: row.ip_address }, { reason: row.reason, violation_count: row.violation_count });
      return { ok: true, ip_address: row.ip_address, note: 'Other server processes stop blocking this address within a minute; the firewall rule is removed within seconds.' };
    });

    s.get('/api/admin/security/suspicious', async (req) => {
      requireSuperAdmin(req);
      const qy = query(req);
      const { limit, offset, page } = pageParams(req.query, 100, 500);
      const w = where();
      if (qy.ip) w.add('a.ip_address = ?', qy.ip);
      if (qy.q) {
        const p = w.param(like(qy.q));
        w.add(`(a.reason ilike ${p} or a.path ilike ${p} or a.user_agent ilike ${p} or a.ip_address ilike ${p})`);
      }
      dateRange(w, 'a.created_at', qy);
      const total = (await one<{ n: number }>(`select count(*)::int as n from suspicious_activity a ${w.sql}`, w.values))!.n;
      const items = await q(
        `select a.id, a.ip_address, a.reason, a.path, a.user_agent, a.created_at,
                exists (select 1 from blocked_ips b where b.ip_address = a.ip_address and b.expires_at > now()) as blocked
           from suspicious_activity a ${w.sql} order by a.created_at desc limit ${limit} offset ${offset}`,
        w.values,
      );
      return { items, total, page, limit };
    });

    s.get('/api/admin/security/logins', async (req) => {
      requireSuperAdmin(req);
      const qy = query(req);
      const { limit, offset, page } = pageParams(req.query, 100, 500);
      const w = where();
      if (qy.success === '1') w.add('l.success');
      if (qy.success === '0') w.add('not l.success');
      if (qy.ip) w.add('l.ip = ?', qy.ip);
      if (qy.email) w.add('l.email ilike ?', like(qy.email));
      if (qy.reason) w.add('l.reason = ?', qy.reason);
      if (isUuid(qy.user_id)) w.add('l.user_id = ?', qy.user_id);
      dateRange(w, 'l.created_at', qy);
      const total = (await one<{ n: number }>(`select count(*)::int as n from login_events l ${w.sql}`, w.values))!.n;
      const items = await q(
        `select l.id, l.user_id, u.username, u.role, l.email, l.ip, l.user_agent, l.success, l.reason, l.created_at
           from login_events l left join users u on u.id = l.user_id ${w.sql} order by l.created_at desc limit ${limit} offset ${offset}`,
        w.values,
      );
      return { items, total, page, limit };
    });

    // ------------------------------------------------------------ two-factor (own account)
    // These stay reachable while admin_2fa_required is locking the rest of /api/admin.

    s.get('/api/admin/security/2fa', async (req) => {
      const u = requireAdmin(req);
      const security = await getSetting('security');
      const row = await one<{ n: number; pending: boolean }>(
        'select cardinality(totp_backup_codes) as n, (totp_secret is not null and not totp_enabled) as pending from users where id = $1', [u.id]);
      return { enabled: u.totp_enabled, required: security.admin_2fa_required, enrolment_pending: row?.pending ?? false, backup_codes_left: u.totp_enabled ? (row?.n ?? 0) : 0 };
    });

    /** Start (or restart) enrolment. Nothing is enforced until /confirm succeeds. */
    s.post('/api/admin/security/2fa/begin', async (req) => {
      const u = requireAdmin(req);
      if (u.totp_enabled) throw conflict('Two-factor authentication is already on. Turn it off first to enroll a new device.');
      if (!rateLimit('2fa-begin', u.id, 10, 3600)) throw new HttpError(429, 'Too many attempts. Try again later.');
      const site = await getSetting('site');
      const secret = generateSecret();
      await exec('update users set totp_secret = $2 where id = $1 and not totp_enabled', [u.id, secret]);
      const url = otpauthUrl(secret, u.email, site.name);
      audit(req, 'security.2fa_begin', { kind: 'user', id: u.id });
      return { secret, otpauth_url: url, qr_data_url: await QRCode.toDataURL(url, { margin: 1, width: 240 }) };
    });

    /** Confirm with a code from the app. Returns the backup codes once; only their hashes are stored. */
    s.post('/api/admin/security/2fa/confirm', async (req) => {
      const u = requireAdmin(req);
      const { code } = parse(z.object({ code: z.string().trim().regex(/^\d{6}$/, 'Enter the 6-digit code from your authenticator app') }), req.body);
      if (u.totp_enabled) throw conflict('Two-factor authentication is already on');
      if (!rateLimit('2fa-confirm', u.id, 10, 600)) throw new HttpError(429, 'Too many attempts. Wait a few minutes and try again.');
      const row = await one<{ totp_secret: string | null }>('select totp_secret from users where id = $1', [u.id]);
      if (!row?.totp_secret) throw badRequest('Start the setup first');
      if (!(await verifyTotp(row.totp_secret, code))) throw badRequest('That code is not valid. Check the time on your phone and try the next code.');
      const codes = Array.from({ length: 10 }, () => randomCode(2, 5));
      await exec('update users set totp_enabled = true, totp_backup_codes = $2 where id = $1', [u.id, codes.map((c) => sha256(c))]);
      audit(req, 'security.2fa_enable', { kind: 'user', id: u.id });
      return { ok: true, backup_codes: codes };
    });

    /** New backup codes; the old ones stop working. Needs a current code. */
    s.post('/api/admin/security/2fa/backup-codes', async (req) => {
      const u = requireAdmin(req);
      const { code } = parse(z.object({ code: z.string().trim().regex(/^\d{6}$/, 'Enter the 6-digit code from your authenticator app') }), req.body);
      if (!rateLimit('2fa-confirm', u.id, 10, 600)) throw new HttpError(429, 'Too many attempts. Wait a few minutes and try again.');
      const row = await one<{ totp_secret: string | null; totp_enabled: boolean }>('select totp_secret, totp_enabled from users where id = $1', [u.id]);
      if (!row?.totp_enabled) throw badRequest('Two-factor authentication is not on');
      if (!(await verifyTotp(row.totp_secret, code))) throw badRequest('That code is not valid');
      const codes = Array.from({ length: 10 }, () => randomCode(2, 5));
      await exec('update users set totp_backup_codes = $2 where id = $1', [u.id, codes.map((c) => sha256(c))]);
      audit(req, 'security.2fa_backup_codes', { kind: 'user', id: u.id });
      return { ok: true, backup_codes: codes };
    });

    /** Turn off: password plus a current code (or a backup code). */
    s.post('/api/admin/security/2fa/disable', async (req) => {
      const u = requireAdmin(req);
      const body = parse(z.object({ password: z.string().min(1).max(200), code: z.string().trim().min(6).max(20) }), req.body);
      if (!rateLimit('2fa-disable', u.id, 8, 900)) throw new HttpError(429, 'Too many attempts. Wait a few minutes and try again.');
      const row = await one<{ password_hash: string; totp_secret: string | null; totp_enabled: boolean; totp_backup_codes: string[] }>(
        'select password_hash, totp_secret, totp_enabled, totp_backup_codes from users where id = $1', [u.id]);
      if (!row?.totp_enabled) throw badRequest('Two-factor authentication is not on');
      if (!(await verifyPassword(body.password, row.password_hash))) throw badRequest('That password is not correct');
      const code = body.code.replace(/\s/g, '');
      const ok = (await verifyTotp(row.totp_secret, code)) || row.totp_backup_codes.includes(sha256(code.toUpperCase()));
      if (!ok) throw badRequest('That code is not valid');
      await exec(`update users set totp_enabled = false, totp_secret = null, totp_backup_codes = '{}' where id = $1`, [u.id]);
      const security = await getSetting('security');
      audit(req, 'security.2fa_disable', { kind: 'user', id: u.id });
      return { ok: true, setup_required: security.admin_2fa_required };
    });

    /** Super admin: clear another staff member's 2FA when they have lost their device. */
    s.post('/api/admin/security/2fa/reset/:id', async (req) => {
      const actor = requireSuperAdmin(req);
      const id = idParam(req);
      if (id === actor.id) throw badRequest('Use "Turn off" for your own account');
      const t = await one(`update users set totp_enabled = false, totp_secret = null, totp_backup_codes = '{}' where id = $1 returning email`, [id]);
      if (!t) throw notFound('User not found');
      await exec('delete from sessions where user_id = $1', [id]);
      audit(req, 'security.2fa_reset', { kind: 'user', id }, { email: t.email });
      return { ok: true };
    });
  });
}
