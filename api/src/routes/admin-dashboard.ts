import { readdir, stat, statfs } from 'node:fs/promises';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { config } from '../config.ts';
import { one, q } from '../db.ts';
import { adminScope, query } from '../lib/admin.ts';
import { requireAdmin } from '../lib/http.ts';
import { getSetting } from '../lib/settings.ts';
import { storage } from '../lib/storage.ts';

/** Per-day metric: [key, table, timestamp column, aggregate, extra condition]. */
const SERIES: [string, string, string, string, string][] = [
  ['users', 'users', 'created_at', 'count(*)', 'true'],
  ['brands', 'publishers', 'created_at', 'count(*)', 'deleted_at is null'],
  ['series', 'series', 'created_at', 'count(*)', 'deleted_at is null'],
  ['releases', 'releases', 'published_at', 'count(*)', `status = 'published' and deleted_at is null`],
  ['pages_read', 'page_reads', 'read_at', 'count(*)', 'true'],
  ['orders', 'orders', 'paid_at', 'count(*)', `status in ('paid','refunded')`],
  ['gross_cents', 'orders', 'paid_at', 'coalesce(sum(total_cents),0)', `status in ('paid','refunded')`],
  ['fee_cents', 'orders', 'paid_at', 'coalesce(sum(fee_cents),0)', `status in ('paid','refunded')`],
  ['refunded_cents', 'orders', 'refunded_at', 'coalesce(sum(total_cents),0)', `status = 'refunded'`],
  ['creator_cents', 'ledger', 'created_at', 'coalesce(sum(amount_cents),0)', `kind in ('sale','subscription','tip','refund')`],
  ['new_members', 'subscriptions', 'created_at', 'count(*)', 'true'],
];

async function dailySeries(days: number): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  const results = await Promise.all(
    SERIES.map(([, table, col, agg, cond]) =>
      q<{ day: string; v: number }>(
        `select to_char(d, 'YYYY-MM-DD') as day, coalesce(x.v, 0)::float8 as v
           from generate_series(current_date - ($1::int - 1), current_date, interval '1 day') d
           left join (select (${col})::date as day, ${agg} as v from ${table}
                       where ${col} >= current_date - ($1::int - 1) and ${cond} group by 1) x on x.day = d::date
          order by d`,
        [days],
      ),
    ),
  );
  out.days = results[0].map((r) => r.day);
  SERIES.forEach(([key], i) => (out[key] = results[i].map((r) => r.v)));
  // Anonymous reads of free pages are kept per day in their own table.
  const anon = await q<{ day: string; v: number }>(
    `select to_char(day, 'YYYY-MM-DD') as day, sum(pages)::float8 as v from anon_reads where day >= current_date - ($1::int - 1) group by 1`,
    [days],
  );
  const anonByDay = new Map(anon.map((r) => [r.day, r.v]));
  out.pages_read = (out.pages_read as number[]).map((v, i) => v + (anonByDay.get((out.days as string[])[i]) ?? 0));
  const g = out.gross_cents as number[];
  const f = out.fee_cents as number[];
  const c = out.creator_cents as number[];
  const r = out.refunded_cents as number[];
  out.platform_cents = g.map((v, i) => v - f[i] - c[i] - r[i]);
  return out;
}

async function counts() {
  return one(
    `select
       (select count(*) from reports where status = 'open')::int as open_reports,
       (select count(*) from payouts where status = 'requested')::int as payouts_requested,
       (select count(*) from payouts where status = 'approved')::int as payouts_approved,
       (select coalesce(sum(amount_cents),0) from payouts where status = 'requested')::float8 as payouts_requested_cents,
       (select coalesce(sum(amount_cents),0) from payouts where status = 'approved')::float8 as payouts_approved_cents,
       (select count(*) from feedback where status = 'new')::int as new_feedback,
       (select count(*) from error_groups where status = 'unresolved')::int as unresolved_errors,
       (select count(*) from emails where status = 'queued')::int as emails_queued,
       (select count(*) from emails where status = 'failed')::int as emails_failed,
       (select count(*) from blocked_ips where expires_at > now())::int as blocked_ips,
       (select count(*) from publishers where kind_requested is not null and deleted_at is null)::int as kind_requests`,
  );
}

let diskCache: { at: number; bytes: number; files: number } | null = null;

/** Size of the local storage directory, walked at most every five minutes. */
async function localUsage(): Promise<{ bytes: number; files: number }> {
  if (diskCache && Date.now() - diskCache.at < 300_000) return diskCache;
  let bytes = 0;
  let files = 0;
  const walk = async (dir: string): Promise<void> => {
    for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
      const p = join(dir, e.name);
      if (e.isDirectory()) await walk(p);
      else if (e.isFile()) {
        bytes += (await stat(p).catch(() => null))?.size ?? 0;
        files++;
      }
    }
  };
  await walk(config.storageDir);
  diskCache = { at: Date.now(), bytes, files };
  return diskCache;
}

export default async function adminDashboardRoutes(app: FastifyInstance) {
  await adminScope(app, (s) => {
    /**
     * Totals plus per-day series for the last N days.
     * platform revenue = gross - processing fees - creator earnings - refunds.
     * Membership money reaches creator earnings when the month is settled.
     */
    s.get('/api/admin/dashboard', async (req) => {
      requireAdmin(req);
      const days = Math.min(365, Math.max(1, Number(query(req).days) || 30));
      const [totals, c, series] = await Promise.all([
        one(
          `select
             (select count(*) from users where deleted_at is null)::int as users,
             (select count(*) from publishers where deleted_at is null)::int as brands,
             (select count(*) from series where deleted_at is null)::int as series,
             (select count(*) from releases where deleted_at is null and status = 'published')::int as releases,
             ((select count(*) from page_reads) + (select coalesce(sum(pages),0) from anon_reads))::float8 as pages_read,
             (select count(*) from orders where status in ('paid','refunded'))::int as orders,
             (select coalesce(sum(total_cents),0) from orders where status in ('paid','refunded'))::float8 as gross_cents,
             (select coalesce(sum(fee_cents),0) from orders where status in ('paid','refunded'))::float8 as fee_cents,
             (select coalesce(sum(total_cents),0) from orders where status = 'refunded')::float8 as refunded_cents,
             (select coalesce(sum(amount_cents),0) from ledger where kind in ('sale','subscription','tip','refund'))::float8 as creator_cents,
             (select count(distinct user_id) from subscriptions
               where status in ('active','past_due') and current_period_end > now())::int as active_members,
             (select coalesce(round(sum(case plan when 'annual' then price_cents / 12.0 else price_cents end)),0) from subscriptions
               where status = 'active' and current_period_end > now() and not cancel_at_period_end)::float8 as mrr_cents`,
        ),
        counts(),
        dailySeries(days),
      ]);
      const t = totals!;
      return {
        days,
        totals: {
          ...t,
          platform_cents: t.gross_cents - t.fee_cents - t.creator_cents - t.refunded_cents,
          pending_payouts: c!.payouts_requested,
          pending_payouts_cents: c!.payouts_requested_cents,
          approved_payouts: c!.payouts_approved,
          approved_payouts_cents: c!.payouts_approved_cents,
          open_reports: c!.open_reports,
          emails_queued: c!.emails_queued,
          emails_failed: c!.emails_failed,
          unresolved_errors: c!.unresolved_errors,
          blocked_ips: c!.blocked_ips,
        },
        series,
      };
    });

    /** Counts for the sidebar badges. */
    s.get('/api/admin/badges', async (req) => {
      requireAdmin(req);
      const c = (await counts())!;
      return {
        reports: c.open_reports,
        payouts: c.payouts_requested,
        feedback: c.new_feedback,
        errors: c.unresolved_errors,
        emails_failed: c.emails_failed,
        emails_queued: c.emails_queued,
        kind_requests: c.kind_requests,
        blocked_ips: c.blocked_ips,
      };
    });

    s.get('/api/admin/health', async (req) => {
      requireAdmin(req);
      const warnings: string[] = [];

      const dbStart = performance.now();
      let db: Record<string, unknown>;
      try {
        const r = await one<{ version: string; size: number; connections: number }>(
          `select current_setting('server_version') as version, pg_database_size(current_database())::float8 as size,
                  (select count(*) from pg_stat_activity where datname = current_database())::int as connections`,
        );
        db = { ok: true, ms: Math.round(performance.now() - dbStart), version: r!.version, size_bytes: r!.size, connections: r!.connections };
      } catch (e) {
        db = { ok: false, error: (e as Error).message };
      }

      const storageSettings = await getSetting('storage');
      const stStart = performance.now();
      let store: Record<string, unknown>;
      try {
        const driver = await storage();
        const key = `private/healthcheck/${process.pid}-${Date.now()}.json`;
        const body = Buffer.from(JSON.stringify({ at: new Date().toISOString() }));
        await driver.put(key, body, 'application/json');
        const back = await driver.read(key);
        await driver.del(key);
        if (!back || !back.equals(body)) throw new Error('Wrote a test object but could not read the same bytes back');
        store = { ok: true, driver: storageSettings.driver, ms: Math.round(performance.now() - stStart) };
      } catch (e) {
        store = { ok: false, driver: storageSettings.driver, error: (e as Error).message };
      }
      if (storageSettings.driver === 'r2' && !storageSettings.r2_public_url) {
        warnings.push('R2 has no public URL set, so covers and free pages are proxied through the API instead of served from the CDN.');
      }

      let disk: Record<string, unknown> | null = null;
      try {
        const fs = await statfs(config.storageDir);
        const usage = await localUsage();
        const total = fs.blocks * fs.bsize;
        const free = fs.bavail * fs.bsize;
        disk = { path: config.storageDir, used_bytes: usage.bytes, files: usage.files, volume_total_bytes: total, volume_free_bytes: free, volume_used_pct: total ? Math.round(((total - free) / total) * 1000) / 10 : null };
        if (total && free / total < 0.1) warnings.push('The storage volume has less than 10% free space.');
      } catch (e) {
        disk = { path: config.storageDir, error: (e as Error).message };
      }

      const em = await getSetting('email');
      const emailConfigured =
        em.provider === 'sendgrid' ? Boolean(em.sendgrid_api_key && em.from_email)
        : em.provider === 'mailgun' ? Boolean(em.mailgun_api_key && em.mailgun_domain && em.from_email)
        : false;
      const lastSent = await one<{ sent_at: string }>(`select sent_at from emails where status = 'sent' order by sent_at desc nulls last limit 1`);
      const email = {
        ok: emailConfigured || (!config.isProd && em.provider === 'log'),
        provider: em.provider,
        configured: emailConfigured,
        from_email: em.from_email,
        queue_paused: em.queue_paused,
        webhook_verification: em.provider === 'sendgrid' ? Boolean(em.sendgrid_webhook_key) : em.provider === 'mailgun' ? Boolean(em.mailgun_webhook_signing_key) : null,
        last_sent_at: lastSent?.sent_at ?? null,
      };
      if (em.provider === 'log') warnings.push(config.isProd ? 'No email provider is configured: nothing is being delivered.' : 'Email provider is "log": messages are stored but not delivered.');
      else if (!emailConfigured) warnings.push(`The ${em.provider} email settings are incomplete.`);
      if (em.queue_paused) warnings.push('The email queue is paused.');

      const pay = await getSetting('payments');
      const paymentsConfigured = pay.provider === 'divinity' && Boolean(pay.divinity_api_url && pay.divinity_partner_id && pay.divinity_api_key);
      const payments = {
        ok: config.isProd ? paymentsConfigured : paymentsConfigured || pay.provider === 'sandbox',
        provider: pay.provider,
        configured: paymentsConfigured,
        webhook_secret_set: Boolean(pay.divinity_webhook_secret),
        webhook_url: `${config.appUrl}/api/webhooks/divinity`,
      };
      if (config.isProd && !paymentsConfigured) {
        warnings.push(
          pay.provider === 'sandbox'
            ? 'Production is running with the sandbox payment provider: no real payments can be taken. Configure Divinity payments in Settings.'
            : 'Divinity payments is selected but its API URL, partner ID or API key is missing: checkout will fail.',
        );
      } else if (pay.provider === 'divinity' && !pay.divinity_webhook_secret) {
        warnings.push('Divinity payments has no webhook secret saved, so payment confirmations cannot be verified.');
      }

      const jobs = await q(
        `select distinct on (job) job, ok, detail, started_at, finished_at from cron_runs order by job, started_at desc`,
      );
      if (!config.cronSecret) warnings.push('CRON_SECRET is not set: the /api/cron endpoints are disabled.');
      const security = await getSetting('security');
      if (!security.admin_2fa_required) warnings.push('Two-factor authentication is not required for admins.');

      return {
        ok: Boolean(db.ok && store.ok && email.ok && payments.ok),
        db,
        storage: store,
        disk,
        email,
        payments,
        jobs: { in_process: !process.env.NO_JOBS, cron_secret_set: Boolean(config.cronSecret), last_runs: jobs },
        server: { node: process.version, uptime_s: Math.round(process.uptime()), env: config.isProd ? 'production' : 'development', rss_bytes: process.memoryUsage().rss, pid: process.pid },
        warnings,
      };
    });
  });
}
