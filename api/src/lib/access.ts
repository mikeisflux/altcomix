import { one, q } from '../db.ts';
import type { Row } from '../db.ts';
import { isAdmin } from './http.ts';
import type { SessionUser } from './http.ts';

/**
 * The paywall rules, in one place. Everything that decides whether a reader
 * may see a page goes through `releaseAccess`.
 *
 * Order of precedence for the access model of a series:
 *   country rule  >  language edition override  >  series.access_model
 *
 * Within a premium series a page is FREE when any of these hold:
 *   - the release is forced free, its free-to-read date has passed, or the
 *     series paywall expiry (days since publication) has passed
 *   - the series free-preview rule makes the whole release free
 *   - the page is flagged "always free"
 *   - the page falls inside the release's free page count
 * Otherwise the reader needs one of: brand membership (owner), ownership of
 * the release (purchase / code), an active membership when the series is in
 * the membership catalogue, or a page credit spent on that page.
 */

export type Via = 'free' | 'owner' | 'purchase' | 'code' | 'subscription' | 'credit';

export type FreePreview = { mode: string; n?: number; m?: number };

export const AUTOMATIC_PREVIEW_PAGES = 5;

/** Is the whole release free under the series preview rule? `index` is 0-based among published releases. */
export function releaseFreeByPreview(fp: FreePreview, index: number, total: number): boolean {
  const n = fp.n ?? 3;
  const m = fp.m ?? n;
  switch (fp.mode) {
    case 'first_releases':
      return index < 3;
    case 'first_last_releases':
      return index < 3 || index >= total - 3;
    case 'custom_first':
      return index < n;
    case 'custom_first_last':
      return index < n || index >= total - m;
    case 'automatic':
      return index === 0;
    default:
      return false;
  }
}

/** Free page count for a release that is not wholly free. */
export function previewPages(fp: FreePreview, releaseFreePages: number | null): number {
  if (releaseFreePages !== null && releaseFreePages !== undefined) return releaseFreePages;
  if (fp.mode === 'first_pages') return fp.n ?? 10;
  if (fp.mode === 'automatic') return AUTOMATIC_PREVIEW_PAGES;
  return 0;
}

export type ReleaseAccess = {
  model: 'blocked' | 'free' | 'premium';
  /** Whole release readable without paying. */
  releaseFree: boolean;
  /** What unlocks locked pages for this reader, if anything. */
  unlock: Exclude<Via, 'free' | 'credit'> | null;
  canDownload: boolean;
  /** Per page (same order as `pages`): how the reader may see it, or null if locked. */
  pages: (Via | null)[];
  freePages: number;
  lockedPages: number;
};

type Ctx = {
  series: Row;
  release: Row;
  pages: { id: string; position: number; is_free: boolean | null }[];
  user: SessionUser | null;
  country: string | null;
  /** Skip visibility rules (private preview link, studio preview). */
  preview?: boolean;
};

export async function releaseAccess(ctx: Ctx): Promise<ReleaseAccess> {
  const { series, release, pages, user, country } = ctx;
  const now = Date.now();

  // 1. Effective model.
  let model = series.access_model as ReleaseAccess['model'];
  const edition = await one<{ access_model: string | null }>(
    'select access_model from series_editions where series_id = $1 and language = $2',
    [series.id, release.language],
  );
  if (edition?.access_model) model = edition.access_model as ReleaseAccess['model'];
  if (country) {
    const rule = await one<{ rule: string }>(
      `select rule from country_rules
        where series_id = $1 and country = $2 and enabled and (language is null or language = $3)
        order by language nulls last limit 1`,
      [series.id, country, release.language],
    );
    if (rule) model = rule.rule as ReleaseAccess['model'];
  }

  // 2. What this reader holds.
  let unlock: ReleaseAccess['unlock'] = null;
  let canDownload = false;
  const credits = new Set<string>();
  if (user) {
    const member =
      isAdmin(user) ||
      Boolean(await one('select 1 from publisher_members where publisher_id = $1 and user_id = $2', [series.publisher_id, user.id]));
    if (member) {
      unlock = 'owner';
      canDownload = true;
    } else {
      const ent = await one<{ source: string; can_download: boolean }>(
        'select source, can_download from entitlements where user_id = $1 and release_id = $2',
        [user.id, release.id],
      );
      if (ent) {
        unlock = ent.source === 'code' ? 'code' : 'purchase';
        canDownload = ent.can_download;
      } else if (model !== 'blocked' && series.in_subscription && (await hasMembership(user.id))) {
        unlock = 'subscription';
      }
      if (!unlock) {
        const rows = await q<{ page_id: string }>(
          'select u.page_id from page_unlocks u join pages p on p.id = u.page_id where u.user_id = $1 and p.release_id = $2',
          [user.id, release.id],
        );
        for (const r of rows) credits.add(r.page_id);
      }
    }
  }

  // 3. Is the whole release free?
  let releaseFree = model === 'free';
  if (model === 'premium') {
    const published = release.published_at ? Date.parse(release.published_at) : null;
    if (release.force_free) releaseFree = true;
    else if (release.free_at && Date.parse(release.free_at) <= now) releaseFree = true;
    else if (series.paywall_expires_days && published && published + series.paywall_expires_days * 86_400_000 <= now) releaseFree = true;
    else {
      const order = await q<{ id: string }>(
        `select id from releases
          where series_id = $1 and language = $2 and status = 'published' and deleted_at is null
          order by number, created_at`,
        [series.id, release.language],
      );
      const index = order.findIndex((r) => r.id === release.id);
      if (index >= 0 && releaseFreeByPreview(series.free_preview ?? { mode: 'automatic' }, index, order.length)) releaseFree = true;
    }
  }

  // 4. Per page.
  const freeCount = model === 'premium' && !releaseFree ? previewPages(series.free_preview ?? { mode: 'automatic' }, release.free_pages) : 0;
  const out: (Via | null)[] = pages.map((p, i) => {
    if (model === 'blocked') return unlock === 'owner' ? 'owner' : null;
    if (releaseFree || p.is_free === true || (p.is_free !== false && i < freeCount)) return 'free';
    if (unlock) return unlock;
    if (credits.has(p.id)) return 'credit';
    return null;
  });

  const freePages = out.filter((v) => v === 'free').length;
  return {
    model,
    releaseFree,
    unlock,
    canDownload,
    pages: out,
    freePages,
    lockedPages: out.filter((v) => v === null).length,
  };
}

export async function hasMembership(userId: string): Promise<boolean> {
  return Boolean(
    await one(
      `select 1 from subscriptions
        where user_id = $1 and status in ('active','past_due') and current_period_end > now() limit 1`,
      [userId],
    ),
  );
}

/** Can this visitor open the series/release at all (drafts, takedowns, mature gate)? */
export function canView(series: Row, release: Row | null, user: SessionUser | null, isMember: boolean): { ok: boolean; reason?: string } {
  if (isMember) return { ok: true };
  if (series.deleted_at || series.takedown_at) return { ok: false, reason: 'This title is not available' };
  if (series.visibility === 'draft') return { ok: false, reason: 'This title is not published yet' };
  if (release && (release.status !== 'published' || release.deleted_at)) return { ok: false, reason: 'This release is not published yet' };
  const mature = series.mature || release?.mature;
  if (mature && !(user?.prefs as { show_mature?: boolean } | undefined)?.show_mature) {
    return { ok: false, reason: 'mature' };
  }
  return { ok: true };
}
