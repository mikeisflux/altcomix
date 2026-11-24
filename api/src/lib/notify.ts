import { config } from '../config.ts';
import { exec, q } from '../db.ts';
import { sendTemplate } from './email.ts';

/**
 * In-app notifications (the bell) plus the matching email when the reader's
 * settings allow it. `prefs.notify.<key>` on the user controls email; the
 * in-app row is always written.
 */
export type NotifyPref = 'releases' | 'messages' | 'replies' | 'mentions' | 'followers' | 'feed' | 'analytics' | 'newsletter';

export async function notify(userId: string, kind: string, title: string, body = '', url: string | null = null): Promise<void> {
  await exec('insert into notifications (user_id, kind, title, body, url) values ($1,$2,$3,$4,$5)', [userId, kind, title, body.slice(0, 500), url]);
}

/** Tell everyone following a series (or its brand) that a release went live. */
export async function notifyNewRelease(release: { id: string; title: string; synopsis: string; series_id: string }): Promise<number> {
  const followers = await q<{ id: string; email: string; wants_email: boolean; series_title: string; slug: string; publisher_id: string }>(
    `select distinct u.id, u.email, s.title as series_title, s.slug, s.publisher_id,
            coalesce((u.prefs->'notify'->>'releases')::boolean, true) as wants_email
       from series s
       join users u on u.deleted_at is null and u.banned_at is null
      where s.id = $1
        and (exists (select 1 from follows f where f.series_id = s.id and f.user_id = u.id and f.notify)
          or exists (select 1 from publisher_follows pf where pf.publisher_id = s.publisher_id and pf.user_id = u.id))`,
    [release.series_id],
  );
  for (const f of followers) {
    const url = `/read/${release.id}`;
    await notify(f.id, 'release', `New: ${release.title}`, f.series_title, url);
    if (f.wants_email) {
      await sendTemplate(
        'new_release',
        f.email,
        { series: f.series_title, release: release.title, synopsis: release.synopsis.slice(0, 300), url: config.appUrl + url },
        { userId: f.id, publisherId: f.publisher_id },
      );
    }
  }
  return followers.length;
}
