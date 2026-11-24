import { config } from '../config.ts';
import { exec, one, q } from '../db.ts';
import { escapeHtml, sendTemplate } from '../lib/email.ts';
import { captureError } from '../lib/errors.ts';
import { money } from '../lib/payments.ts';
import type { Job } from '../server.ts';

/**
 * The two weekly emails behind the account settings toggles:
 *
 *   feed       prefs.notify.feed       new releases from followed series and
 *                                      brands in the week just ended, for
 *                                      readers who have something to report
 *   analytics  prefs.notify.analytics  readers, page reads and earnings per
 *                                      brand for that week against the week
 *                                      before, for brand owners and admins
 *
 * "The week" is the ISO week (Monday to Sunday, UTC) before the current one,
 * so the numbers are the same whenever in the new week the job happens to run.
 * `digest_sends` holds one row per kind, ISO week and recipient: the row is
 * claimed before the email is queued, so a week is never sent twice, however
 * many workers run this and however often. Both templates are category
 * `notification`: they carry an unsubscribe link, and people who unsubscribed
 * or have not confirmed their address are not written to.
 */

const DAY = 86_400_000;

/** ISO 8601 week of a date: label like 2026-W48 and the Monday it starts on (UTC). */
export function isoWeek(d: Date): { label: string; start: Date } {
  const day = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dow = day.getUTCDay() || 7; // Monday = 1 … Sunday = 7
  const start = new Date(day.getTime() - (dow - 1) * DAY);
  const thursday = new Date(start.getTime() + 3 * DAY); // the ISO year is the year of the week's Thursday
  const jan1 = Date.UTC(thursday.getUTCFullYear(), 0, 1);
  const week = Math.floor((thursday.getTime() - jan1) / (7 * DAY)) + 1;
  return { label: `${thursday.getUTCFullYear()}-W${String(week).padStart(2, '0')}`, start };
}

const shortDate = (d: Date) => new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }).format(d);

/** People who may get a weekly email of this kind and have not been handled for `week` yet. */
const RECIPIENT = (pref: 'feed' | 'analytics') => `
  u.deleted_at is null and u.banned_at is null and u.email_verified_at is not null and u.email_unsubscribed_at is null
  and coalesce((u.prefs->'notify'->>'${pref}')::boolean, true)
  and not exists (select 1 from email_suppressions es where es.email = lower(u.email))
  and not exists (select 1 from digest_sends d where d.kind = '${pref}' and d.week = $1 and d.user_id = u.id)`;

/** Claim (kind, week, user). False when another run already has it. */
async function claim(kind: 'feed' | 'analytics', week: string, userId: string): Promise<boolean> {
  return (await exec('insert into digest_sends (kind, week, user_id) values ($1,$2,$3) on conflict do nothing', [kind, week, userId])) > 0;
}
async function sent(kind: string, week: string, userId: string, emailId: string | null): Promise<void> {
  await exec('update digest_sends set sent = $4, email_id = $5 where kind = $1 and week = $2 and user_id = $3', [kind, week, userId, Boolean(emailId), emailId]);
}

async function feedDigests(week: string, from: Date, to: Date, vars: { from: string; to: string }): Promise<number> {
  let n = 0;
  for (let round = 0; round < 20; round++) {
    const users = await q<{ id: string; email: string; display_name: string; username: string; show_mature: boolean }>(
      `select u.id, u.email, u.display_name, u.username, coalesce((u.prefs->>'show_mature')::boolean, false) as show_mature
         from users u
        where ${RECIPIENT('feed')}
          and (exists (select 1 from follows f where f.user_id = u.id) or exists (select 1 from publisher_follows pf where pf.user_id = u.id))
        order by u.id limit 300`,
      [week],
    );
    if (!users.length) break;
    for (const u of users) {
      if (!(await claim('feed', week, u.id))) continue;
      const releases = await q(
        `select r.id, r.title, r.number, r.kind, s.title as series_title, p.name as brand
           from releases r join series s on s.id = r.series_id join publishers p on p.id = s.publisher_id
          where r.status = 'published' and r.deleted_at is null and r.published_at >= $2 and r.published_at < $3
            and s.deleted_at is null and s.takedown_at is null and s.visibility = 'public' and p.deleted_at is null and p.suspended_at is null
            and (not (s.mature or r.mature) or $4)
            and (exists (select 1 from follows f where f.user_id = $1 and f.series_id = s.id)
              or exists (select 1 from publisher_follows pf where pf.user_id = $1 and pf.publisher_id = p.id))
          order by r.published_at desc, r.id limit 26`,
        [u.id, from, to, u.show_mature],
      );
      // Nothing to report: the claim row stays (sent = false) so this reader is not looked at again this week.
      if (!releases.length) continue;
      const shown = releases.slice(0, 25);
      const items =
        `<table role="presentation" cellpadding="0" cellspacing="0" width="100%">${shown
          .map((r) => `<tr><td style="padding:8px 0;border-bottom:1px solid #eceae4"><a href="${config.appUrl}/read/${r.id}" style="color:#1a1c20;font-weight:600;text-decoration:none">${escapeHtml(r.title)}</a><br><span style="color:#6b7078;font-size:13px">${escapeHtml(r.series_title)} · ${escapeHtml(r.brand)}</span></td></tr>`)
          .join('')}</table>${releases.length > shown.length ? '<p style="color:#6b7078;font-size:13px">…and more in your feed.</p>' : ''}`;
      const count = releases.length > shown.length ? `${shown.length}+ releases` : `${shown.length} ${shown.length === 1 ? 'release' : 'releases'}`;
      const id = await sendTemplate('weekly_feed', u.email, { name: u.display_name || u.username, count, items, url: `${config.appUrl}/community`, ...vars }, { userId: u.id });
      await sent('feed', week, u.id, id);
      if (id) n++;
    }
  }
  return n;
}

type Week = { readers: number; page_reads: number; earnings_cents: number };

async function brandWeek(publisherId: string, from: Date, to: Date): Promise<Week> {
  const r = await one<Week>(
    `select (select count(*) from (
               select user_id::text from page_reads where publisher_id = $1 and read_at >= $2 and read_at < $3
               union
               select visitor_hash from anon_reads where publisher_id = $1 and day >= $2::date and day < $3::date) x)::int as readers,
            ((select count(*) from page_reads where publisher_id = $1 and read_at >= $2 and read_at < $3)
             + (select coalesce(sum(pages), 0) from anon_reads where publisher_id = $1 and day >= $2::date and day < $3::date))::int as page_reads,
            (select coalesce(sum(amount_cents), 0) from ledger
              where publisher_id = $1 and kind in ('sale','tip','subscription','refund') and created_at >= $2 and created_at < $3)::int as earnings_cents`,
    [publisherId, from, to],
  );
  return r ?? { readers: 0, page_reads: 0, earnings_cents: 0 };
}

function change(now: number, before: number): string {
  if (now === before) return 'no change';
  if (!before) return 'new this week';
  const pct = Math.round(((now - before) * 100) / Math.abs(before));
  return `${pct > 0 ? '+' : ''}${pct}%`;
}

async function analyticsDigests(week: string, from: Date, to: Date, vars: { from: string; to: string }): Promise<number> {
  let n = 0;
  const cache = new Map<string, { now: Week; before: Week }>();
  const stats = async (publisherId: string) => {
    let s = cache.get(publisherId);
    if (!s) {
      s = { now: await brandWeek(publisherId, from, to), before: await brandWeek(publisherId, new Date(from.getTime() - 7 * DAY), from) };
      cache.set(publisherId, s);
    }
    return s;
  };
  const num = (v: number) => new Intl.NumberFormat('en-US').format(v);
  const cell = 'padding:6px 12px 6px 0;font-size:14px';
  for (let round = 0; round < 20; round++) {
    const users = await q<{ id: string; email: string; display_name: string; username: string }>(
      `select u.id, u.email, u.display_name, u.username from users u
        where ${RECIPIENT('analytics')}
          and exists (select 1 from publisher_members m join publishers p on p.id = m.publisher_id
                       where m.user_id = u.id and m.role in ('owner','admin') and p.deleted_at is null)
        order by u.id limit 300`,
      [week],
    );
    if (!users.length) break;
    for (const u of users) {
      if (!(await claim('analytics', week, u.id))) continue;
      const brands = await q<{ id: string; name: string; slug: string }>(
        `select p.id, p.name, p.slug from publisher_members m join publishers p on p.id = m.publisher_id
          where m.user_id = $1 and m.role in ('owner','admin') and p.deleted_at is null order by p.name limit 20`,
        [u.id],
      );
      const blocks: string[] = [];
      let first: string | null = null;
      for (const b of brands) {
        const s = await stats(b.id);
        // A brand with a silent fortnight has nothing to report.
        if (![s.now, s.before].some((w) => w.readers || w.page_reads || w.earnings_cents)) continue;
        first ??= b.slug;
        const rows: [string, string, string, string][] = [
          ['Readers', num(s.now.readers), num(s.before.readers), change(s.now.readers, s.before.readers)],
          ['Page reads', num(s.now.page_reads), num(s.before.page_reads), change(s.now.page_reads, s.before.page_reads)],
          ['Earnings', await money(s.now.earnings_cents), await money(s.before.earnings_cents), change(s.now.earnings_cents, s.before.earnings_cents)],
        ];
        blocks.push(
          `<p style="margin:20px 0 6px"><a href="${config.appUrl}/studio/${b.slug}/analytics" style="color:#1a1c20;font-weight:700;text-decoration:none">${escapeHtml(b.name)}</a></p>` +
            `<table role="presentation" cellpadding="0" cellspacing="0" width="100%"><tr><th align="left" style="${cell};color:#6b7078;font-weight:400"></th><th align="right" style="${cell};color:#6b7078;font-weight:400">This week</th><th align="right" style="${cell};color:#6b7078;font-weight:400">Week before</th><th align="right" style="${cell};color:#6b7078;font-weight:400">Change</th></tr>` +
            rows.map((r) => `<tr><td style="${cell}">${r[0]}</td><td align="right" style="${cell};font-weight:600">${escapeHtml(r[1])}</td><td align="right" style="${cell}">${escapeHtml(r[2])}</td><td align="right" style="${cell}">${escapeHtml(r[3])}</td></tr>`).join('') +
            '</table>',
        );
      }
      if (!blocks.length) continue;
      const id = await sendTemplate('weekly_analytics', u.email, { name: u.display_name || u.username, summary: blocks.join(''), url: `${config.appUrl}/studio/${first}/analytics`, ...vars }, { userId: u.id });
      await sent('analytics', week, u.id, id);
      if (id) n++;
    }
  }
  return n;
}

/** Send whatever is still owed for the ISO week containing `now`. Safe to call as often as you like. */
export async function runWeeklyDigests(now = new Date()): Promise<{ week: string; feed: number; analytics: number }> {
  const { label, start } = isoWeek(now);
  const from = new Date(start.getTime() - 7 * DAY);
  const vars = { from: shortDate(from), to: shortDate(new Date(start.getTime() - DAY)) };
  const out = { week: label, feed: 0, analytics: 0 };
  // One kind failing must not hold the other back.
  for (const [kind, fn] of [['feed', feedDigests], ['analytics', analyticsDigests]] as const) {
    try {
      out[kind] = await fn(label, from, start, vars);
    } catch (e) {
      captureError(e, { source: 'job', endpoint: `weekly-digests:${kind}` });
    }
  }
  return out;
}

const job: Job = {
  name: 'weekly-digests',
  everyMs: 30 * 60_000,
  async run() {
    const r = await runWeeklyDigests();
    return r.feed || r.analytics ? `${r.week}: feed ${r.feed}, analytics ${r.analytics}` : undefined;
  },
};
export default job;

