import { BadgeCheck, BookOpen } from 'lucide-react';
import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { money } from '@/lib/format';
import { useSession } from '@/lib/session';
import { cx } from '@/ui';

/** The badge the API attaches to every series card (`toCard` in api/src/routes/catalog.ts). */
export type CardBadge = {
  kind: 'free' | 'unlimited' | 'sale' | 'price' | 'premium';
  label: string;
  price_cents?: number;
  list_price_cents?: number;
  percent_off?: number;
};

/** A series as every public list returns it. */
export type SeriesCard = {
  id: string;
  slug: string;
  title: string;
  type: string;
  genre: string | null;
  status: string;
  language: string;
  mature: boolean;
  cover_url: string | null;
  publisher: { id: string; slug: string; name: string; kind: 'creator' | 'publisher'; verified: boolean };
  release_count: number;
  latest_release: { id: string; number: number; kind: string; title: string; published_at: string | null } | null;
  access_model: 'free' | 'premium' | 'blocked';
  in_membership: boolean;
  from_price_cents: number | null;
  list_price_cents: number | null;
  sale_percent: number | null;
  sale_label: string | null;
  badge: CardBadge;
  follower_count: number;
  favorite_count: number;
  read_count: number;
  updated_at: string;
  blurb?: string | null;
};

/** The release half of a "new releases" or "continue reading" entry. */
export type ReleaseSummary = {
  id: string;
  number: number;
  kind: string;
  title: string;
  cover_url: string | null;
  published_at?: string | null;
  page_count?: number;
};

const KIND_SHORT: Record<string, string> = {
  issue: '#', episode: 'Ep.', volume: 'Vol.', graphic_novel: 'GN', bande_dessinee: 'BD', omnibus: 'Omnibus', compendium: 'Comp.', omake: 'Omake', special: 'Special', one_shot: 'One-shot',
};

/** "#3", "Vol. 2", "One-shot": the short number mark printed on a release cover. */
export function releaseMark(kind: string, number: number): string {
  if (kind === 'one_shot') return 'One-shot';
  const short = KIND_SHORT[kind] ?? '#';
  return short === '#' ? `#${number}` : `${short} ${number}`;
}

/** 2:3 cover image with a drawn fallback when a title has no cover yet. */
export function Cover({ src, title, className, children }: { src: string | null | undefined; title: string; className?: string; children?: ReactNode }) {
  return (
    <div className={cx('relative aspect-[2/3] w-full overflow-hidden rounded-xl border border-line bg-raised', className)}>
      {src ? (
        <img src={src} alt={`Cover of ${title}`} loading="lazy" className="size-full object-cover transition-transform duration-300 group-hover:scale-[1.03]" />
      ) : (
        <div className="flex size-full flex-col items-center justify-center gap-2 p-3 text-center text-faint">
          <BookOpen className="size-7" aria-hidden />
          <span className="line-clamp-3 font-display text-sm font-semibold text-muted">{title}</span>
        </div>
      )}
      {children}
    </div>
  );
}

/** Free / Unlimited / price / sale mark. Sale shows the struck-through list price. */
export function AccessBadge({ badge, className }: { badge: CardBadge; className?: string }) {
  const { currency } = useSession();
  const base = 'inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-bold leading-4 shadow-sm';
  if (badge.kind === 'free') return <span className={cx(base, 'bg-sun text-sun-ink', className)}>Free</span>;
  if (badge.kind === 'sale') {
    return (
      <span className={cx(base, 'bg-accent text-accent-ink', className)}>
        <span>{money(badge.price_cents, currency)}</span>
        <s className="font-medium opacity-70">{money(badge.list_price_cents, currency)}</s>
        <span className="sr-only">, {badge.label}</span>
      </span>
    );
  }
  if (badge.kind === 'unlimited') return <span className={cx(base, 'bg-paper text-ink', className)}>Unlimited</span>;
  if (badge.kind === 'price') return <span className={cx(base, 'border border-line-strong bg-ink/90 text-paper', className)}>{money(badge.price_cents, currency)}</span>;
  return <span className={cx(base, 'border border-line-strong bg-ink/90 text-paper', className)}>Paid</span>;
}

function MatureMark() {
  return <span className="inline-flex items-center rounded-md border border-danger/50 bg-ink/90 px-1.5 py-0.5 text-[11px] font-bold leading-4 text-danger" title="For readers 18 and over">18+</span>;
}

function BrandLine({ publisher }: { publisher: SeriesCard['publisher'] }) {
  return (
    <Link to={`/b/${publisher.slug}`} className="relative z-10 mt-0.5 flex items-center gap-1 text-[13px] text-muted hover:text-paper">
      <span className="truncate">{publisher.name}</span>
      {publisher.verified && <BadgeCheck className="size-3.5 shrink-0 text-info" aria-label="Verified" />}
    </Link>
  );
}

/**
 * Series cover card: 2:3 cover, title, brand, access badge, mature marker.
 * Fills its container; give it a width with `className` inside a row.
 */
export function CoverCard({ series, className, to, footer }: { series: SeriesCard; className?: string; to?: string; footer?: ReactNode }) {
  return (
    <article className={cx('group relative min-w-0', className)}>
      <Cover src={series.cover_url} title={series.title}>
        <div className="absolute inset-x-1.5 bottom-1.5 flex flex-wrap items-end justify-between gap-1">
          <AccessBadge badge={series.badge} />
          {series.mature && <MatureMark />}
        </div>
      </Cover>
      <h3 className="mt-2 line-clamp-2 text-sm font-semibold leading-snug">
        <Link to={to ?? `/series/${series.slug}`} className="after:absolute after:inset-0 hover:text-accent-hover">{series.title}</Link>
      </h3>
      <BrandLine publisher={series.publisher} />
      {footer}
    </article>
  );
}

/**
 * Release card: the release's own cover with its number mark, the series
 * title and the release title. Links to the series unless `to` says otherwise;
 * `percent` draws a reading-progress bar.
 */
export function ReleaseCard({ release, series, className, to, percent }: { release: ReleaseSummary; series: SeriesCard; className?: string; to?: string; percent?: number }) {
  const mark = releaseMark(release.kind, release.number);
  return (
    <article className={cx('group relative min-w-0', className)}>
      <Cover src={release.cover_url ?? series.cover_url} title={`${series.title} ${mark}`}>
        <span className="absolute left-1.5 top-1.5 rounded-md bg-ink/90 px-1.5 py-0.5 text-[11px] font-bold leading-4 text-paper shadow-sm">{mark}</span>
        <div className="absolute inset-x-1.5 bottom-1.5 flex flex-wrap items-end justify-between gap-1">
          <AccessBadge badge={series.badge} />
          {series.mature && <MatureMark />}
        </div>
        {percent !== undefined && (
          <div className="absolute inset-x-0 bottom-0 h-1 bg-ink/70" role="progressbar" aria-label="Reading progress" aria-valuenow={percent} aria-valuemin={0} aria-valuemax={100}>
            <div className="h-full bg-accent" style={{ width: `${percent}%` }} />
          </div>
        )}
      </Cover>
      <h3 className="mt-2 line-clamp-2 text-sm font-semibold leading-snug">
        <Link to={to ?? `/series/${series.slug}`} className="after:absolute after:inset-0 hover:text-accent-hover">{series.title}</Link>
      </h3>
      <p className="mt-0.5 truncate text-[13px] text-muted">{release.title}</p>
      <BrandLine publisher={series.publisher} />
    </article>
  );
}

/** Responsive grid for cover cards (browse results, brand pages). */
export function CoverGrid({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cx('grid grid-cols-2 gap-x-4 gap-y-6 min-[480px]:grid-cols-3 md:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-6', className)}>{children}</div>;
}
