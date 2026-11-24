import { exec } from '../db.ts';
import type { Job } from '../server.ts';

/**
 * Housekeeping. Also callable from /api/cron/cleanup when in-process jobs are
 * off. Retention: expired sessions and tokens go at once; security and job
 * history is kept for 90 days; blocks are removed 7 days after they expire
 * (the firewall sync drops the iptables rule as soon as a block expires).
 */
export async function runCleanup(): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  out.sessions = await exec('delete from sessions where expires_at < now()');
  out.email_tokens = await exec(`delete from email_tokens where expires_at < now() - interval '1 day' or used_at < now() - interval '7 days'`);
  out.publisher_invites = await exec(`delete from publisher_invites where accepted_at is null and expires_at < now() - interval '30 days'`);
  out.suspicious_activity = await exec(`delete from suspicious_activity where created_at < now() - interval '90 days'`);
  out.blocked_ips = await exec(`delete from blocked_ips where expires_at < now() - interval '7 days'`);
  out.cron_runs = await exec(`delete from cron_runs where started_at < now() - interval '90 days'`);
  out.login_events = await exec(`delete from login_events where created_at < now() - interval '180 days'`);
  out.resolved_errors = await exec(`delete from error_groups where status in ('resolved','ignored') and last_seen < now() - interval '90 days'`);
  out.unlocked_accounts = await exec('update users set locked_until = null, failed_logins = 0 where locked_until < now()');
  return out;
}

export function describeCleanup(r: Record<string, number>): string {
  return Object.entries(r).filter(([, n]) => n > 0).map(([k, n]) => `${k} ${n}`).join(', ');
}

const job: Job = {
  name: 'cleanup',
  everyMs: 60 * 60_000,
  async run() {
    return describeCleanup(await runCleanup()) || undefined;
  },
};

export default job;
