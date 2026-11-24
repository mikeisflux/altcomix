import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowLeft, BookOpen, ChevronLeft, ChevronRight, Columns2, Download, GalleryVertical, Maximize, Minimize, Rows3, ScanLine, ShoppingBag,
} from 'lucide-react';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { ApiError, api } from '@/lib/api';
import { WHOLE_PAGE, clipPath, fitFrame } from '@/lib/frames';
import { useSession } from '@/lib/session';
import { Button, IconButton, LinkButton, PageLoader, cx } from '@/ui';
import { Paywall } from './Paywall';
import { buildSpreads, buildSteps, defaultMode, loadModePref, pageSrc, saveModePref } from './model';
import type { Manifest, Mode, ReaderPage } from './model';

function useSize<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    setSize({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);
  return [ref, size] as const;
}

const reduceMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/**
 * Guided view: one frame at a time, scaled to fill whatever screen this is.
 * The page image is positioned so the current frame is centred and as large
 * as possible; everything outside the frame is clipped away so neighbouring
 * panels do not spoil what comes next.
 */
export function GuidedView({ page, frameIndex, w, h }: { page: ReaderPage; frameIndex: number | null; w: number; h: number }) {
  const frame = frameIndex === null ? WHOLE_PAGE : (page.frames[frameIndex] ?? WHOLE_PAGE);
  const fit = fitFrame(frame, page.width / page.height, w, h, w < 640 ? 4 : 16);
  const src = pageSrc(page, fit.width);
  return (
    <div className="absolute inset-0 overflow-hidden" style={{ background: page.bg_color }}>
      {src && (
        <img
          key={page.id}
          src={src}
          alt={`Page ${page.position + 1}${frameIndex !== null ? `, frame ${frameIndex + 1} of ${page.frames.length}` : ''}`}
          draggable={false}
          className="absolute max-w-none select-none"
          style={{
            width: fit.width,
            height: fit.height,
            transform: `translate3d(${fit.left}px, ${fit.top}px, 0)`,
            clipPath: frameIndex === null ? undefined : clipPath(frame),
            transition: reduceMotion() ? 'none' : 'transform 380ms cubic-bezier(.22,.8,.2,1), width 380ms cubic-bezier(.22,.8,.2,1), height 380ms cubic-bezier(.22,.8,.2,1), clip-path 380ms cubic-bezier(.22,.8,.2,1)',
            willChange: 'transform',
          }}
        />
      )}
    </div>
  );
}

function PagedView({ pages, rtl, children }: { pages: ReaderPage[]; rtl: boolean; children: (p: ReaderPage) => ReactNode }) {
  return (
    <div className={cx('absolute inset-0 flex items-center justify-center', rtl && 'flex-row-reverse')} style={{ background: pages[0]?.bg_color }}>
      {pages.map((p) => (
        <div key={p.id} className="flex h-full min-w-0 items-center justify-center" style={{ flex: `${p.width / p.height} 1 0` }}>
          {p.locked ? children(p) : <img src={pageSrc(p, window.innerWidth / pages.length) ?? undefined} alt={`Page ${p.position + 1}`} draggable={false} className="max-h-full max-w-full select-none object-contain" />}
        </div>
      ))}
    </div>
  );
}

function ScrollView({ manifest, onSeen, startAt, paywall }: { manifest: Manifest; onSeen: (i: number) => void; startAt: number; paywall: (p: ReaderPage) => ReactNode }) {
  const root = useRef<HTMLDivElement>(null);
  const firstLocked = manifest.pages.findIndex((p) => p.locked);
  const shown = firstLocked === -1 ? manifest.pages : manifest.pages.slice(0, firstLocked + 1);
  useEffect(() => {
    const el = root.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (entries) => entries.forEach((e) => e.isIntersecting && onSeen(Number((e.target as HTMLElement).dataset.index))),
      { root: el, threshold: 0.35 },
    );
    el.querySelectorAll('[data-index]').forEach((n) => io.observe(n));
    if (startAt > 0) el.querySelector(`[data-index="${startAt}"]`)?.scrollIntoView();
    return () => io.disconnect();
    // Only on mount / manifest change: scrolling itself must not re-run this.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [manifest.release.id, shown.length]);
  return (
    <div ref={root} className="absolute inset-0 overflow-y-auto overscroll-contain" style={{ background: manifest.pages[0]?.bg_color }}>
      <div className="mx-auto max-w-3xl">
        {shown.map((p, i) => (
          <div key={p.id} data-index={i} style={{ background: p.bg_color }}>
            {p.locked ? (
              <div className="py-10">{paywall(p)}</div>
            ) : (
              <img src={pageSrc(p, Math.min(768, window.innerWidth)) ?? undefined} alt={`Page ${p.position + 1}`} loading={i < 2 ? 'eager' : 'lazy'} width={p.width} height={p.height} className="block h-auto w-full" />
            )}
          </div>
        ))}
        {firstLocked === -1 && <div data-index={manifest.pages.length} className="h-px" />}
      </div>
    </div>
  );
}

function EndCard({ manifest, onRestart }: { manifest: Manifest; onRestart: () => void }) {
  const { series, release, next_release_id, offers, access } = manifest;
  const cf = series.crowdfunding?.active ? series.crowdfunding : null;
  return (
    <div className="absolute inset-0 flex items-center justify-center overflow-auto bg-ink p-5">
      <div className="w-full max-w-md space-y-4 text-center">
        <p className="text-sm uppercase tracking-widest text-muted">End of</p>
        <h2 className="text-3xl font-bold">{release.title}</h2>
        <p className="text-muted">from <Link className="link" to={`/series/${series.slug}`}>{series.title}</Link> by <Link className="link" to={`/b/${series.publisher.slug}`}>{series.publisher.name}</Link></p>
        <div className="space-y-2.5 pt-2">
          {next_release_id && <LinkButton to={`/read/${next_release_id}`} variant="primary" size="lg" block>Read the next one<ChevronRight className="size-5" /></LinkButton>}
          {cf && <LinkButton to={cf.url} external variant="sun" block>Back this on {cf.service}</LinkButton>}
          {release.print_url && <LinkButton to={release.print_url} external variant="secondary" block icon={<ShoppingBag className="size-4" />}>Buy the print edition</LinkButton>}
          {access.can_download ? (
            <LinkButton to={`/api/releases/${release.id}/download`} external variant="secondary" block icon={<Download className="size-4" />}>Download your copy</LinkButton>
          ) : offers.download_price_cents ? (
            <LinkButton to={`/series/${series.slug}`} variant="secondary" block icon={<Download className="size-4" />}>Get the download</LinkButton>
          ) : null}
          <LinkButton to={`/series/${series.slug}`} variant="secondary" block>{series.allow_comments ? 'Series page and comments' : 'Series page'}</LinkButton>
          <Button variant="ghost" block onClick={onRestart}>Read again</Button>
        </div>
      </div>
    </div>
  );
}

const MODE_INFO: Record<Mode, { label: string; icon: ReactNode; hint: string }> = {
  guided: { label: 'Frame by frame', icon: <ScanLine className="size-4" />, hint: 'One frame at a time, sized to your screen' },
  page: { label: 'Single page', icon: <BookOpen className="size-4" />, hint: 'One whole page' },
  spread: { label: 'Two pages', icon: <Columns2 className="size-4" />, hint: 'Facing pages side by side' },
  scroll: { label: 'Scroll', icon: <GalleryVertical className="size-4" />, hint: 'Continuous vertical scroll' },
};

function ReaderInner({ manifest, reload }: { manifest: Manifest; reload: () => void }) {
  const nav = useNavigate();
  const { pages, series } = manifest;
  const rtl = series.reading_dir === 'rtl';
  const [stage, size] = useSize<HTMLDivElement>();
  const hasFrames = pages.some((p) => p.frames.length > 1);

  const [mode, setModeState] = useState<Mode>(() => loadModePref(series.layout) ?? defaultMode(series.layout, window.innerWidth, window.innerHeight, hasFrames));
  const setMode = (m: Mode) => {
    setModeState(m);
    saveModePref(series.layout, m);
  };

  const steps = useMemo(() => buildSteps(pages), [pages]);
  const spreads = useMemo(() => buildSpreads(pages, manifest.spread), [pages, manifest.spread]);
  const startPage = Math.min(manifest.progress && !manifest.progress.finished ? manifest.progress.position : 0, pages.length - 1);

  // `pageIdx` is the source of truth across modes; `stepIdx` refines it in guided view.
  const [pageIdx, setPageIdx] = useState(Math.max(0, startPage));
  const [stepIdx, setStepIdx] = useState(() => Math.max(0, steps.findIndex((s) => s.page === Math.max(0, startPage))));
  const [ended, setEnded] = useState(false);
  const [ui, setUi] = useState(true);
  const [fullscreen, setFullscreen] = useState(false);

  const goToPage = useCallback(
    (i: number) => {
      const p = Math.max(0, Math.min(pages.length - 1, i));
      setPageIdx(p);
      setStepIdx(Math.max(0, steps.findIndex((s) => s.page === p)));
      setEnded(false);
    },
    [pages.length, steps],
  );

  const move = useCallback(
    (dir: 1 | -1) => {
      if (ended) {
        if (dir === -1) setEnded(false);
        return;
      }
      if (mode === 'guided') {
        const n = stepIdx + dir;
        if (n >= steps.length) return setEnded(true);
        if (n < 0) return;
        setStepIdx(n);
        setPageIdx(steps[n].page);
      } else if (mode === 'spread') {
        const cur = spreads.findIndex((s) => s.includes(pageIdx));
        const n = cur + dir;
        if (n >= spreads.length) return setEnded(true);
        if (n >= 0) goToPage(spreads[n][0]);
      } else if (mode === 'page') {
        if (pageIdx + dir >= pages.length) return setEnded(true);
        if (pageIdx + dir >= 0) goToPage(pageIdx + dir);
      }
    },
    [ended, mode, stepIdx, steps, spreads, pageIdx, pages.length, goToPage],
  );

  // Reading stats and resume position.
  const pending = useRef(new Set<string>());
  const sent = useRef(new Set<string>());
  const flush = useCallback(() => {
    const ids = [...pending.current];
    pending.current.clear();
    if (ids.length) api('/api/reads', { json: { release_id: manifest.release.id, page_ids: ids } }).catch(() => ids.forEach((id) => sent.current.delete(id)));
  }, [manifest.release.id]);
  const markSeen = useCallback(
    (i: number) => {
      const p = pages[i];
      if (!p || p.locked || sent.current.has(p.id)) return;
      sent.current.add(p.id);
      pending.current.add(p.id);
    },
    [pages],
  );
  useEffect(() => {
    const visible = mode === 'spread' ? (spreads.find((s) => s.includes(pageIdx)) ?? [pageIdx]) : [pageIdx];
    visible.forEach(markSeen);
  }, [pageIdx, mode, spreads, markSeen]);
  useEffect(() => {
    const t = setInterval(flush, 4000);
    const onHide = () => document.visibilityState === 'hidden' && flush();
    document.addEventListener('visibilitychange', onHide);
    return () => {
      clearInterval(t);
      document.removeEventListener('visibilitychange', onHide);
      flush();
    };
  }, [flush]);
  const { user } = useSession();
  useEffect(() => {
    if (!user) return;
    const t = setTimeout(() => {
      api('/api/progress', { method: 'PUT', json: { release_id: manifest.release.id, position: pageIdx, finished: ended } }).catch(() => {});
    }, 1500);
    return () => clearTimeout(t);
  }, [pageIdx, ended, user, manifest.release.id]);

  // Warm the next couple of pages.
  useEffect(() => {
    for (const i of [pageIdx + 1, pageIdx + 2]) {
      const p = pages[i];
      const src = p && !p.locked ? pageSrc(p, Math.min(size.w || 800, 1100)) : null;
      if (src) new Image().src = src;
    }
  }, [pageIdx, pages, size.w]);

  const toggleFullscreen = useCallback(() => {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void document.documentElement.requestFullscreen?.().catch(() => {});
  }, []);
  useEffect(() => {
    const h = () => setFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener('fullscreenchange', h);
    return () => document.removeEventListener('fullscreenchange', h);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).closest('input, textarea, select, [role="dialog"]')) return;
      const fwd = rtl ? 'ArrowLeft' : 'ArrowRight';
      const back = rtl ? 'ArrowRight' : 'ArrowLeft';
      if (mode !== 'scroll' && (e.key === fwd || e.key === ' ' || e.key === 'PageDown' || e.key === 'ArrowDown')) {
        e.preventDefault();
        move(1);
      } else if (mode !== 'scroll' && (e.key === back || e.key === 'PageUp' || e.key === 'ArrowUp')) {
        e.preventDefault();
        move(-1);
      } else if (e.key === 'Home') goToPage(0);
      else if (e.key === 'End') goToPage(pages.length - 1);
      else if (e.key === 'f') toggleFullscreen();
      else if (e.key === 'g') setMode(mode === 'guided' ? 'page' : 'guided');
      else if (e.key === 'Escape') setUi(true);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  // Tap zones and swipes on the stage.
  const touch = useRef<{ x: number; y: number; t: number } | null>(null);
  const onPointerDown = (e: React.PointerEvent) => {
    touch.current = { x: e.clientX, y: e.clientY, t: Date.now() };
  };
  const onPointerUp = (e: React.PointerEvent) => {
    const s = touch.current;
    touch.current = null;
    if (!s || mode === 'scroll' || (e.target as HTMLElement).closest('a, button, [data-no-tap]')) return;
    const dx = e.clientX - s.x;
    const dy = e.clientY - s.y;
    if (Math.abs(dx) > 45 && Math.abs(dx) > Math.abs(dy) * 1.5) {
      // Swipe: content follows the finger, so swiping left goes forward in LTR.
      move((dx < 0) !== rtl ? 1 : -1);
      return;
    }
    if (Math.abs(dx) > 10 || Math.abs(dy) > 10 || Date.now() - s.t > 600) return;
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const f = (e.clientX - rect.left) / rect.width;
    if (f > 0.33 && f < 0.67) setUi((v) => !v);
    else move((f >= 0.67) !== rtl ? 1 : -1);
  };

  const current = pages[pageIdx];
  const step = steps[stepIdx];
  const paywall = (p: ReaderPage) => <div data-no-tap className="h-full w-full"><Paywall manifest={manifest} page={p} onUnlocked={reload} compact={mode === 'scroll'} /></div>;
  const screenPages = mode === 'spread' ? (spreads.find((s) => s.includes(pageIdx)) ?? [pageIdx]).map((i) => pages[i]) : [current];
  const modes: Mode[] = series.layout === 'vertical' ? ['scroll', 'page'] : ['guided', 'page', 'spread', 'scroll'];
  const progress = pages.length > 1 ? pageIdx / (pages.length - 1) : 1;
  const frameLabel = mode === 'guided' && step?.frame !== null && current && current.frames.length > 1 ? ` · frame ${(step?.frame ?? 0) + 1}/${current.frames.length}` : '';

  return (
    <div className="fixed inset-0 flex flex-col bg-black text-paper" dir="ltr">
      <div
        ref={stage}
        className="relative min-h-0 flex-1 touch-pan-y select-none"
        onPointerDown={onPointerDown}
        onPointerUp={onPointerUp}
        style={{ touchAction: mode === 'scroll' ? 'pan-y' : 'none' }}
      >
        {ended ? (
          <EndCard manifest={manifest} onRestart={() => goToPage(0)} />
        ) : mode === 'scroll' ? (
          <ScrollView
            manifest={manifest}
            startAt={pageIdx}
            paywall={paywall}
            onSeen={(i) => {
              if (i >= pages.length) return setEnded(true);
              setPageIdx(i);
              markSeen(i);
            }}
          />
        ) : !current ? null : mode === 'guided' && !current.locked ? (
          size.w > 0 && <GuidedView page={current} frameIndex={step?.frame ?? null} w={size.w} h={size.h} />
        ) : (
          <PagedView pages={screenPages} rtl={rtl}>{paywall}</PagedView>
        )}

        {/* First-visit hint for guided view */}
        {mode === 'guided' && !ended && ui && stepIdx === 0 && hasFrames && (
          <div className="pointer-events-none absolute inset-x-0 bottom-24 flex justify-center px-4">
            <div className="rounded-full bg-black/75 px-4 py-2 text-center text-sm backdrop-blur">Tap the {rtl ? 'left' : 'right'} side or swipe to move frame by frame</div>
          </div>
        )}
      </div>

      {/* Top bar */}
      <div className={cx('absolute inset-x-0 top-0 z-10 flex items-center gap-2 bg-gradient-to-b from-black/90 to-transparent px-2 pb-8 pt-2 transition-opacity sm:px-4', ui ? 'opacity-100' : 'pointer-events-none opacity-0')}>
        <IconButton label="Back to series" onClick={() => nav(`/series/${series.slug}`)}><ArrowLeft className="size-5" /></IconButton>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold">{manifest.release.title}</div>
          <Link to={`/series/${series.slug}`} className="block truncate text-xs text-muted hover:text-paper">{series.title} · {series.publisher.name}</Link>
        </div>
        <div className="flex items-center rounded-xl bg-black/60 p-0.5 backdrop-blur" role="radiogroup" aria-label="Reading mode">
          {modes.map((m) => (
            <button
              key={m}
              role="radio"
              aria-checked={mode === m}
              title={`${MODE_INFO[m].label}: ${MODE_INFO[m].hint}`}
              aria-label={MODE_INFO[m].label}
              onClick={() => {
                setEnded(false);
                setMode(m);
                if (m === 'guided') setStepIdx(Math.max(0, steps.findIndex((s) => s.page === pageIdx)));
              }}
              className={cx('flex h-9 items-center gap-1.5 rounded-lg px-2.5 text-xs font-medium transition-colors', mode === m ? 'bg-accent text-accent-ink' : 'text-muted hover:text-paper')}
            >
              {m === 'scroll' && series.layout !== 'vertical' ? <Rows3 className="size-4" /> : MODE_INFO[m].icon}
              <span className="hidden md:inline">{MODE_INFO[m].label}</span>
            </button>
          ))}
        </div>
        <IconButton label={fullscreen ? 'Exit full screen' : 'Full screen'} onClick={toggleFullscreen} className="hidden sm:inline-flex">
          {fullscreen ? <Minimize className="size-5" /> : <Maximize className="size-5" />}
        </IconButton>
      </div>

      {/* Bottom bar */}
      <div className={cx('absolute inset-x-0 bottom-0 z-10 bg-gradient-to-t from-black/90 to-transparent px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-8 transition-opacity sm:px-5', ui && !ended ? 'opacity-100' : 'pointer-events-none opacity-0')}>
        <div className="mx-auto flex max-w-3xl items-center gap-3">
          {mode !== 'scroll' && <IconButton label={rtl ? 'Next' : 'Previous'} onClick={() => move(rtl ? 1 : -1)}><ChevronLeft className="size-5" /></IconButton>}
          <input
            type="range"
            min={0}
            max={Math.max(0, pages.length - 1)}
            value={pageIdx}
            onChange={(e) => goToPage(Number(e.target.value))}
            aria-label="Page"
            aria-valuetext={`Page ${pageIdx + 1} of ${pages.length}`}
            className="h-1.5 min-w-0 flex-1 cursor-pointer appearance-none rounded-full accent-[var(--color-accent)]"
            style={{ direction: rtl ? 'rtl' : 'ltr', background: `linear-gradient(to ${rtl ? 'left' : 'right'}, var(--color-accent) ${progress * 100}%, rgb(255 255 255 / .25) ${progress * 100}%)` }}
            disabled={mode === 'scroll'}
          />
          <span className="shrink-0 text-xs tabular-nums text-muted">{pageIdx + 1} / {pages.length}{frameLabel}</span>
          {mode !== 'scroll' && <IconButton label={rtl ? 'Previous' : 'Next'} onClick={() => move(rtl ? -1 : 1)}><ChevronRight className="size-5" /></IconButton>}
        </div>
      </div>
    </div>
  );
}

function Gate({ title, children, action }: { title: string; children: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center gap-4 bg-ink px-6 text-center">
      <h1 className="text-2xl font-bold">{title}</h1>
      <p className="max-w-md text-muted">{children}</p>
      <div className="flex flex-wrap justify-center gap-2">{action}<LinkButton to="/">Go to the store</LinkButton></div>
    </div>
  );
}

export function Reader() {
  const { releaseId } = useParams();
  const [params] = useSearchParams();
  const preview = params.get('preview');
  const qc = useQueryClient();
  const { user } = useSession();
  const key = ['reader', releaseId, preview, user?.id ?? null];
  const { data, error, isLoading, refetch } = useQuery({
    queryKey: key,
    queryFn: () => api<Manifest>(`/api/releases/${releaseId}`, { query: { preview } }),
    staleTime: 60_000,
    retry: false,
  });

  if (isLoading) return <div className="min-h-dvh bg-ink"><PageLoader label="Opening" /></div>;
  if (error || !data) {
    const e = error as ApiError | null;
    if (e?.code === 'mature') {
      return (
        <Gate title="This release is for adults" action={<LinkButton to={user ? '/account' : `/login?next=/read/${releaseId}`} variant="primary">{user ? 'Open account settings' : 'Sign in'}</LinkButton>}>
          It is marked as mature. {user ? 'Turn on “Show mature content” in your account settings to read it.' : 'Sign in and turn on “Show mature content” to read it.'}
        </Gate>
      );
    }
    return <Gate title="This release is not available" action={<Button onClick={() => refetch()}>Try again</Button>}>{e?.message ?? 'It may have been unpublished or the link may be wrong.'}</Gate>;
  }
  if (data.pages.length === 0) return <Gate title="No pages yet">This release has no pages to read yet.</Gate>;
  return <ReaderInner key={data.release.id} manifest={data} reload={() => void qc.invalidateQueries({ queryKey: ['reader', releaseId] })} />;
}
