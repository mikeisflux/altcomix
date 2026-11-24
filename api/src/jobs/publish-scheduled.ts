import { exec, q } from '../db.ts';
import { captureError } from '../lib/errors.ts';
import { HttpError } from '../lib/http.ts';
import { publishRelease } from '../lib/ingest.ts';
import type { Job } from '../server.ts';

/** Publishes releases whose scheduled time has arrived. */
const job: Job = {
  name: 'publish-scheduled',
  everyMs: 30_000,
  async run() {
    const due = await q<{ id: string }>(
      `select r.id from releases r join series s on s.id = r.series_id
        where r.status = 'scheduled' and r.publish_at <= now() and r.deleted_at is null and s.deleted_at is null
        order by r.publish_at limit 50`,
    );
    let published = 0;
    let held = 0;
    for (const r of due) {
      try {
        await publishRelease(r.id);
        published++;
      } catch (e) {
        if (e instanceof HttpError) {
          // Nothing to publish (no pages): back to draft so the creator sees it did not go out.
          await exec(`update releases set status = 'draft', publish_at = null, updated_at = now() where id = $1 and status = 'scheduled'`, [r.id]);
          held++;
        } else {
          captureError(e, { source: 'job', endpoint: 'publish-scheduled', meta: { releaseId: r.id } });
        }
      }
    }
    if (published || held) return `published ${published}, returned to draft ${held}`;
  },
};

export default job;
