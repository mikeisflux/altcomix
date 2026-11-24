import type { FastifyInstance, FastifyRequest } from 'fastify';
import { one, q } from '../db.ts';
import { monthStart, previousMonth, recordRun, requireCron, settlementModule } from '../lib/admin.ts';
import { processEmailQueue, recoverStuckEmails } from '../lib/email.ts';
import { captureError } from '../lib/errors.ts';
import { badRequest } from '../lib/http.ts';
import { notifyNewRelease } from '../lib/notify.ts';
import { describeCleanup, runCleanup } from '../jobs/cleanup.ts';

/**
 * Endpoints for a system crontab, for when in-process jobs are switched off
 * (NO_JOBS=1) or as a safety net beside them. Every task is safe to run
 * twice and from several places at once.
 *
 * Auth: `Authorization: Bearer $CRON_SECRET`. With no CRON_SECRET set on the
 * server every call is refused. See scripts/deploy/crontab.example.
 */

/**
 * Publish releases whose scheduled time has come. The studio's own job does
 * the full work (page checks, covers, notifications); the plain version below
 * only runs on an install that does not have it.
 */
async function publishScheduled(): Promise<string | void> {
  try {
    const mod = (await import(new URL('../jobs/publish-scheduled.ts', import.meta.url).href)) as { default?: { run?: () => Promise<string | void> } };
    if (typeof mod.default?.run === 'function') return await mod.default.run();
  } catch (e) {
    if ((e as { code?: string }).code !== 'ERR_MODULE_NOT_FOUND') throw e;
  }
  const rows = await q<{ id: string; title: string; synopsis: string; series_id: string }>(
    `update releases r set status = 'published', published_at = coalesce(r.publish_at, now()), updated_at = now()
      where r.status = 'scheduled' and r.publish_at <= now() and r.deleted_at is null
      returning r.id, r.title, r.synopsis, r.series_id`,
  );
  if (!rows.length) return;
  let notified = 0;
  for (const r of rows) {
    await one('update series set updated_at = now() where id = $1 returning id', [r.series_id]);
    try {
      notified += await notifyNewRelease(r);
    } catch (e) {
      captureError(e, { source: 'job', endpoint: 'publish-scheduled' });
    }
  }
  return `published ${rows.length}, notified ${notified}`;
}

export default async function cronRoutes(app: FastifyInstance) {
  const task = (path: string, job: string, fn: (req: FastifyRequest) => Promise<string | void>) => {
    app.route({
      method: ['GET', 'POST'],
      url: `/api/cron/${path}`,
      handler: async (req) => {
        requireCron(req);
        return recordRun(job, () => fn(req));
      },
    });
  };

  task('email-queue', 'cron:email-queue', async () => {
    const recovered = await recoverStuckEmails();
    const { sent, failed } = await processEmailQueue(50);
    return `sent ${sent}, failed ${failed}, recovered ${recovered}`;
  });

  /** Settles last month by default; `?month=2026-10` picks another finished month. */
  task('settlement', 'cron:settlement', async (req) => {
    const asked = (req.query as { month?: string }).month;
    const month = asked ? monthStart(asked) : previousMonth();
    if (month > previousMonth()) throw badRequest(`${month.slice(0, 7)} is not over yet`);
    const already = await one('select 1 from settlements where month = $1', [month]);
    const pending = await one<{ n: number }>('select count(*)::int as n from sub_months where month = $1 and settled_at is null', [month]);
    if (already && !pending?.n) return `${month.slice(0, 7)} already settled`;
    const mod = await settlementModule();
    await mod.settleMonth(month, { ranBy: null });
    const row = await one('select subscribers, creator_cents, platform_cents from settlements where month = $1', [month]);
    return row ? `${month.slice(0, 7)}: ${row.subscribers} members, creators ${row.creator_cents}c, platform ${row.platform_cents}c` : `${month.slice(0, 7)}: nothing to settle`;
  });

  task('cleanup', 'cron:cleanup', async () => describeCleanup(await runCleanup()));

  task('publish-scheduled', 'cron:publish-scheduled', publishScheduled);
}
