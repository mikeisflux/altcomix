import { runPendingJobs } from '../lib/ingest.ts';
import type { Job } from '../server.ts';

/**
 * Page ingestion and whole-release frame detection. Uploads start their job
 * straight away; this tick is the safety net that picks up queued rows and
 * running rows whose worker stopped (deploy, crash) and carries on from the
 * last finished page.
 */
const job: Job = {
  name: 'ingest',
  everyMs: 5_000,
  async run() {
    const n = await runPendingJobs();
    if (n) return `processed ${n} job${n === 1 ? '' : 's'}`;
  },
};

export default job;
