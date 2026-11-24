import { useEffect } from 'react';
import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { useSession } from '@/lib/session';
import { Avatar, Badge, cx } from '@/ui';

// ---------------------------------------------------------------- API shapes (field names as the handlers return them)

export type Person = { username: string; name: string; avatar_url: string | null };

export type SeriesCard = {
  id: string;
  slug: string;
  title: string;
  type: string;
  genre: string | null;
  mature: boolean;
  cover_url: string | null;
  publisher: { id: string; slug: string; name: string; kind: string; verified: boolean };
  release_count: number;
  latest_release: { id: string; number: number; kind: string; title: string; published_at: string | null } | null;
  badge: { kind: 'free' | 'unlimited' | 'sale' | 'price' | 'premium'; label: string };
  follower_count: number;
  favorite_count: number;
};

export type ReleaseRef = { id: string; number: number; kind: string; title: string; page_count?: number; cover_url: string | null; published_at?: string | null };

export type Thread = {
  id: string;
  title: string;
  board: string;
  series_id: string | null;
  pinned: boolean;
  locked: boolean;
  reply_count: number;
  last_post_at: string;
  created_at: string;
  author: Person | null;
};

// ---------------------------------------------------------------- helpers

/** Sets the browser tab title while the page is mounted. */
export function useTitle(title: string | null | undefined) {
  const { settings } = useSession();
  useEffect(() => {
    if (!title) return;
    const prev = document.title;
    document.title = `${title} · ${settings.site.name}`;
    return () => {
      document.title = prev;
    };
  }, [title, settings.site.name]);
}

/** Only follow same-site paths handed to us in a query string. */
export function safePath(next: string | null | undefined, fallback = '/'): string {
  return next && next.startsWith('/') && !next.startsWith('//') && !next.includes('\\') ? next : fallback;
}

/** "Issue 3" style label; the release title already carries the detail. */
export function releaseLabel(r: { kind: string; number: number; title: string }): string {
  return r.title || `${r.kind.replace(/_/g, ' ')} ${r.number}`;
}

// ---------------------------------------------------------------- small pieces

/** 2:3 cover with a readable fallback when a title has no art yet. */
export function Cover({ src, title, className }: { src: string | null | undefined; title: string; className?: string }) {
  return (
    <div className={cx('relative aspect-[2/3] overflow-hidden rounded-lg border border-line bg-raised', className)}>
      {src ? (
        <img src={src} alt={`Cover of ${title}`} loading="lazy" className="absolute inset-0 size-full object-cover" />
      ) : (
        <div className="absolute inset-0 flex items-center justify-center p-2 text-center font-display text-xs font-semibold text-faint">{title}</div>
      )}
    </div>
  );
}

const BADGE_TONE = { free: 'sun', unlimited: 'accent', sale: 'ok', price: 'neutral', premium: 'neutral' } as const;

/** Series cover card for shelves and profile grids. `footer` holds per-shelf actions. */
export function SeriesTile({ series, footer }: { series: SeriesCard; footer?: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col">
      <Link to={`/series/${series.slug}`} className="group block">
        <div className="relative">
          <Cover src={series.cover_url} title={series.title} className="transition-colors group-hover:border-line-strong" />
          <Badge tone={BADGE_TONE[series.badge.kind]} className="absolute left-1.5 top-1.5">{series.badge.label}</Badge>
        </div>
        <div className="mt-2 line-clamp-2 text-sm font-semibold leading-snug group-hover:text-accent-hover">{series.title}</div>
      </Link>
      <Link to={`/b/${series.publisher.slug}`} className="mt-0.5 truncate text-xs text-muted hover:text-paper">{series.publisher.name}</Link>
      {footer && <div className="mt-2">{footer}</div>}
    </div>
  );
}

export function CoverGrid({ children }: { children: ReactNode }) {
  return <div className="grid grid-cols-2 gap-x-4 gap-y-6 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-6">{children}</div>;
}

export function GridSkeleton({ count = 6 }: { count?: number }) {
  return (
    <CoverGrid>
      {Array.from({ length: count }, (_, i) => (
        <div key={i}>
          <div className="aspect-[2/3] animate-pulse rounded-lg bg-raised" />
          <div className="mt-2 h-4 w-3/4 animate-pulse rounded bg-raised" />
        </div>
      ))}
    </CoverGrid>
  );
}

export function ListSkeleton({ rows = 5 }: { rows?: number }) {
  return (
    <div className="space-y-2" aria-hidden>
      {Array.from({ length: rows }, (_, i) => <div key={i} className="h-16 animate-pulse rounded-xl bg-raised" />)}
    </div>
  );
}

/** Avatar + name linking to the public profile; "Deleted user" when the account is gone. */
export function PersonLink({ person, size = 28, className }: { person: Person | null; size?: number; className?: string }) {
  if (!person) {
    return (
      <span className={cx('inline-flex items-center gap-2 text-muted', className)}>
        <Avatar name="?" size={size} />
        <span>Deleted user</span>
      </span>
    );
  }
  return (
    <Link to={`/u/${person.username}`} className={cx('inline-flex min-w-0 items-center gap-2 font-medium hover:text-accent-hover', className)}>
      <Avatar src={person.avatar_url} name={person.name} size={size} />
      <span className="truncate">{person.name}</span>
    </Link>
  );
}

/** Reader-written text: plain, line breaks kept, long words wrapped. Never HTML. */
export function PlainText({ children, className }: { children: string; className?: string }) {
  return <p className={cx('whitespace-pre-wrap break-words [overflow-wrap:anywhere]', className)}>{children}</p>;
}
