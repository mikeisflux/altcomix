import { useQuery } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight, PenLine, Tag } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { KeyboardEvent, PointerEvent } from 'react';
import { Link } from 'react-router';
import { api, errorMessage } from '@/lib/api';
import { date } from '@/lib/format';
import { useSession } from '@/lib/session';
import { EmptyState, ErrorState, LinkButton, Skeleton, Tabs, cx } from '@/ui';
import { AccessBadge, CoverCard, ReleaseCard } from './cards';
import type { ReleaseSummary, SeriesCard } from './cards';
import { SHELF_ITEM, SectionLink, Shelf, ShelfSkeleton, useTitle } from './shared';

type HeroItem = { id: string; headline: string; blurb: string | null; image_url: string | null; url: string | null; series: SeriesCard | null };
type NewRelease = { release: ReleaseSummary; series: SeriesCard };
type Continue = { release: ReleaseSummary; position: number; finished: boolean; percent: number; series: SeriesCard };
type Row = { id: string; title: string; items: SeriesCard[] };
type SaleRow = { id: string; label: string; percent_off: number; ends_at: string | null; publisher: { slug: string; name: string }; items: SeriesCard[] };

type HomeData = {
  hero: HeroItem[];
  staff_picks: SeriesCard[];
  spotlight: SeriesCard[];
  new_releases: { last_week: NewRelease[]; earlier: NewRelease[] };
  sale: SaleRow[];
  independent: Row[];
  continue_reading: Continue[];
  favorite_genre: { id: string; label: string } | null;
  for_you: Row[];
  popular: SeriesCard[];
};

const SLIDE_MS = 7000;

function HeroLink({ url, children, className, tabIndex }: { url: string | null; children: React.ReactNode; className?: string; tabIndex?: number }) {
  if (!url) return <div className={className}>{children}</div>;
  if (/^https?:\/\//i.test(url)) return <a href={url} target="_blank" rel="noreferrer" className={className} tabIndex={tabIndex}>{children}</a>;
  return <Link to={url} className={className} tabIndex={tabIndex}>{children}</Link>;
}

/** Curated banners: auto-advance (paused on hover, focus or reduced motion), dots, arrows, swipe. */
function HeroCarousel({ items }: { items: HeroItem[] }) {
  const [index, setIndex] = useState(0);
  const [paused, setPaused] = useState(false);
  const [filled, setFilled] = useState(false);
  const drag = useRef<{ x: number; moved: boolean } | null>(null);
  const count = items.length;
  const reduced = typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const auto = count > 1 && !paused && !reduced;
  const go = useCallback((i: number) => setIndex(((i % count) + count) % count), [count]);

  useEffect(() => {
    if (index >= count) setIndex(0);
  }, [index, count]);

  useEffect(() => {
    setFilled(false);
    if (!auto) return;
    const raf = requestAnimationFrame(() => requestAnimationFrame(() => setFilled(true)));
    const t = setTimeout(() => setIndex((i) => (i + 1) % count), SLIDE_MS);
    return () => {
      cancelAnimationFrame(raf);
      clearTimeout(t);
    };
  }, [index, auto, count]);

  const onPointerDown = (e: PointerEvent) => {
    drag.current = { x: e.clientX, moved: false };
  };
  const onPointerUp = (e: PointerEvent) => {
    const d = drag.current;
    drag.current = null;
    if (!d) return;
    const dx = e.clientX - d.x;
    if (Math.abs(dx) > 48) {
      d.moved = true;
      swiped.current = true;
      go(index + (dx < 0 ? 1 : -1));
    }
  };
  const swiped = useRef(false);
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'ArrowRight') go(index + 1);
    if (e.key === 'ArrowLeft') go(index - 1);
  };

  return (
    <section
      aria-roledescription="carousel"
      aria-label="Featured"
      className="relative"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={(e) => !e.currentTarget.contains(e.relatedTarget as Node) && setPaused(false)}
      onKeyDown={onKey}
    >
      <div
        className="relative overflow-hidden rounded-2xl border border-line bg-surface"
        style={{ touchAction: 'pan-y' }}
        onPointerDown={onPointerDown}
        onPointerUp={onPointerUp}
        onPointerCancel={() => (drag.current = null)}
        onClickCapture={(e) => {
          if (swiped.current) {
            e.preventDefault();
            e.stopPropagation();
            swiped.current = false;
          }
        }}
      >
        <div className="flex transition-transform duration-500 ease-out" style={{ transform: `translateX(-${index * 100}%)` }}>
          {items.map((item, i) => {
            const coverOnly = Boolean(item.series && item.image_url === item.series.cover_url);
            const active = i === index;
            return (
              <div key={item.id} role="group" aria-roledescription="slide" aria-label={`${i + 1} of ${count}: ${item.headline}`} aria-hidden={!active} className="relative w-full shrink-0">
                <HeroLink url={item.url} tabIndex={active ? 0 : -1} className="relative flex min-h-[300px] items-end sm:min-h-[340px] lg:min-h-[380px]">
                  {item.image_url && (
                    <img
                      src={item.image_url}
                      alt=""
                      draggable={false}
                      loading={i === 0 ? 'eager' : 'lazy'}
                      className={cx('absolute inset-0 size-full object-cover', coverOnly && 'scale-125 opacity-50 blur-2xl')}
                    />
                  )}
                  <div className="absolute inset-0 bg-gradient-to-t from-ink via-ink/70 to-ink/10 sm:bg-gradient-to-r sm:from-ink sm:via-ink/75 sm:to-transparent" />
                  <div className="relative flex w-full items-end gap-6 p-5 pb-12 sm:p-8 sm:pb-12 lg:p-10 lg:pb-14">
                    <div className="min-w-0 max-w-xl flex-1">
                      {item.series && (
                        <div className="mb-3 flex flex-wrap items-center gap-2 text-sm text-muted">
                          <AccessBadge badge={item.series.badge} />
                          <span className="truncate">{item.series.publisher.name}</span>
                        </div>
                      )}
                      <h2 className="text-3xl font-extrabold sm:text-4xl lg:text-5xl">{item.headline}</h2>
                      {item.blurb && <p className="mt-3 line-clamp-3 text-[15px] text-paper/85 sm:text-base">{item.blurb}</p>}
                      {item.url && (
                        <span className="mt-5 inline-flex h-10 items-center rounded-lg bg-paper px-4 text-sm font-semibold text-ink">
                          {item.series ? 'See the series' : 'Take a look'}
                        </span>
                      )}
                    </div>
                    {coverOnly && item.image_url && (
                      <img src={item.image_url} alt={`Cover of ${item.headline}`} draggable={false} className="hidden aspect-[2/3] w-40 shrink-0 rounded-xl border border-line-strong object-cover shadow-pop sm:block lg:w-48" />
                    )}
                  </div>
                </HeroLink>
              </div>
            );
          })}
        </div>

        {count > 1 && (
          <>
            <div className="absolute inset-x-0 bottom-0 h-1 bg-paper/10" aria-hidden>
              <div className="h-full bg-accent" style={{ width: filled ? '100%' : '0%', transition: filled ? `width ${SLIDE_MS}ms linear` : 'none' }} />
            </div>
            <div className="absolute bottom-3.5 left-5 flex items-center gap-1 sm:left-8 lg:left-10">
              {items.map((item, i) => (
                <button key={item.id} type="button" aria-label={`Show ${item.headline}`} aria-current={i === index} onClick={() => go(i)} className="group/dot flex h-6 w-6 items-center justify-center">
                  <span className={cx('h-2 rounded-full transition-all', i === index ? 'w-5 bg-paper' : 'w-2 bg-paper/40 group-hover/dot:bg-paper/70')} />
                </button>
              ))}
            </div>
            <div className="absolute bottom-3 right-4 hidden gap-2 md:flex">
              <button type="button" aria-label="Previous" onClick={() => go(index - 1)} className="flex size-9 items-center justify-center rounded-full border border-line-strong bg-ink/80 hover:bg-hover"><ChevronLeft className="size-5" /></button>
              <button type="button" aria-label="Next" onClick={() => go(index + 1)} className="flex size-9 items-center justify-center rounded-full border border-line-strong bg-ink/80 hover:bg-hover"><ChevronRight className="size-5" /></button>
            </div>
          </>
        )}
      </div>
    </section>
  );
}

function SeriesShelf({ id, title, subtitle, items, action }: { id: string; title: string; subtitle?: React.ReactNode; items: SeriesCard[]; action?: React.ReactNode }) {
  if (!items.length) return null;
  return (
    <Shelf id={id} title={title} subtitle={subtitle} action={action}>
      {items.map((s) => <CoverCard key={s.id} series={s} className={SHELF_ITEM} />)}
    </Shelf>
  );
}

function NewReleases({ data }: { data: HomeData['new_releases'] }) {
  const hasWeek = data.last_week.length > 0;
  const [tab, setTab] = useState<'last_week' | 'earlier'>(hasWeek ? 'last_week' : 'earlier');
  if (!data.last_week.length && !data.earlier.length) return null;
  const items = data[tab];
  return (
    <Shelf
      id="new-releases"
      title="New releases"
      action={<SectionLink to="/browse?sort=new">View all</SectionLink>}
      subtitle={
        <div className="-mt-1">
          <Tabs value={tab} onChange={setTab} tabs={[{ value: 'last_week', label: 'Last week' }, { value: 'earlier', label: 'Earlier' }]} />
        </div>
      }
    >
      {items.length ? (
        items.map((n) => <ReleaseCard key={n.release.id} release={n.release} series={n.series} className={SHELF_ITEM} />)
      ) : (
        <p className="py-10 text-sm text-muted">{tab === 'last_week' ? 'Nothing new in the last seven days. The Earlier tab has the most recent releases.' : 'No older releases yet.'}</p>
      )}
    </Shelf>
  );
}

export function Home() {
  useTitle(null);
  const { user, settings } = useSession();
  const { data, isLoading, error, refetch } = useQuery({ queryKey: ['home', user?.id ?? null], queryFn: () => api<HomeData>('/api/home') });

  if (isLoading) {
    return (
      <div className="space-y-10">
        <Skeleton className="h-[300px] w-full rounded-2xl sm:h-[340px]" />
        <ShelfSkeleton />
        <ShelfSkeleton />
      </div>
    );
  }
  if (error || !data) return <ErrorState message={errorMessage(error)} retry={() => void refetch()} />;

  const empty = !data.hero.length && !data.popular.length && !data.new_releases.last_week.length && !data.new_releases.earlier.length && !data.staff_picks.length;
  if (empty) {
    return (
      <div className="mx-auto max-w-2xl py-10">
        <h1 className="sr-only">{settings.site.name} store</h1>
        <EmptyState
          icon={<PenLine />}
          title="The shelves are still empty"
          action={<LinkButton to="/studio" variant="primary" icon={<PenLine className="size-4" />}>Publish your comic</LinkButton>}
        >
          No comics have been published here yet. If you make comics, yours can be the first: set up a creator page, upload your pages and choose whether it is free or paid.
        </EmptyState>
      </div>
    );
  }

  return (
    <div className="space-y-10 lg:space-y-12">
      <h1 className="sr-only">{settings.site.name} store</h1>
      {data.hero.length > 0 && <HeroCarousel items={data.hero} />}

      {data.continue_reading.length > 0 && (
        <Shelf id="continue" title="Continue reading" action={<SectionLink to="/library">Your library</SectionLink>}>
          {data.continue_reading.map((c) => <ReleaseCard key={c.release.id} release={c.release} series={c.series} percent={c.percent} to={`/read/${c.release.id}`} className={SHELF_ITEM} />)}
        </Shelf>
      )}

      <SeriesShelf id="staff-picks" title="Staff picks" subtitle="Chosen by people, not an algorithm." items={data.staff_picks} />

      <NewReleases data={data.new_releases} />

      {data.sale.map((s) => (
        <SeriesShelf
          key={s.id}
          id={`sale-${s.id}`}
          title={`${s.percent_off}% off: ${s.label || s.publisher.name}`}
          subtitle={
            <span className="inline-flex flex-wrap items-center gap-x-1.5">
              <Tag className="size-4 text-accent-hover" aria-hidden />
              From <Link to={`/b/${s.publisher.slug}`} className="link">{s.publisher.name}</Link>
              {s.ends_at && <span>· ends {date(s.ends_at)}</span>}
            </span>
          }
          items={s.items}
        />
      ))}

      {data.independent.map((r) => (
        <SeriesShelf key={r.id} id={r.id.replace(':', '-')} title={r.title} items={r.items} subtitle={r.id === 'independent:new' ? 'Self-published work, straight from the people who made it.' : undefined} action={<SectionLink to="/creators">All creators</SectionLink>} />
      ))}

      <SeriesShelf id="spotlight" title="In the spotlight" items={data.spotlight} />

      {data.for_you.map((r, i) => {
        const [, genre, type] = r.id.split(':');
        return (
          <SeriesShelf
            key={r.id}
            id={`genre-${i}`}
            title={r.title}
            subtitle={i === 0 && data.favorite_genre ? <>Because you picked {data.favorite_genre.label}. <Link to="/onboarding/genre" className="link">Change</Link></> : undefined}
            items={r.items}
            action={<SectionLink to={`/browse?genre=${encodeURIComponent(genre)}${type ? `&type=${type}` : ''}`}>View all</SectionLink>}
          />
        );
      })}

      <SeriesShelf id="popular" title="Most read" items={data.popular} action={<SectionLink to="/browse?sort=popular">View all</SectionLink>} />
    </div>
  );
}
