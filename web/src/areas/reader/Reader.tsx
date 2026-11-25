import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowLeft, BookOpen, ChevronLeft, ChevronRight, Columns2, Download, GalleryVertical, Maximize, Minimize, Rows3, ScanLine, ShoppingBag, ZoomOut,
} from 'lucide-react';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { ApiError, api, errorMessage } from '@/lib/api';
import { WHOLE_PAGE, clamp, clipPath, fitFrame } from '@/lib/frames';
import { useSession } from '@/lib/session';
import { Button, IconButton, LinkButton, PageLoader, cx, toast } from '@/ui';
import { Paywall } from './Paywall';
import { buildSpreads, buildSteps, defaultMode, guidedSrc, loadModePref, pageSrc, saveModePref } from './model';
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
const guidedPad = (w: number) => (w < 640 ? 4 : 16);
const EASE = 'cubic-bezier(.22,.8,.2,1)';

/**
 * Guided view: one frame at a time, scaled to fill whatever screen this is.
 * The page image is positioned so the current frame is centered and as large
 * as possible; everything outside the frame is clipped away so neighboring
 * panels do not spoil what comes next.
 *
 * The <img> is keyed by page: moving between frames of one page glides, while
 * a new page is a new element that starts at its own position (invisible until
 * its file has loaded), so the previous page is never seen sliding to where
 * the new frame is.
 */
export function GuidedView({ page, frameIndex, w, h, top = 0, bottom = 0 }: { page: ReaderPage; frameIndex: number | null; w: number; h: number; /** Space kept clear for the controls while they are showing. */ top?: number; bottom?: number }) {
  const frame = frameIndex === null ? WHOLE_PAGE : (page.frames[frameIndex] ?? WHOLE_PAGE);
  const pad = guidedPad(w);
  // The frame is fitted into the area between the control bars, so their fade never covers it.
  const inner = fitFrame(frame, page.width / page.height, w, Math.max(1, h - top - bottom), pad);
  const fit = { ...inner, top: inner.top + top };
  const src = guidedSrc(page, w, h, pad);
  const [loaded, setLoaded] = useState<string | null>(null);
  const move = `380ms ${EASE}`;
  return (
    <div className="absolute inset-0 overflow-hidden" style={{ background: page.bg_color }}>
      {src && (
        <img
          key={page.id}
          src={src}
          alt={`Page ${page.position}${frameIndex !== null ? `, frame ${frameIndex + 1} of ${page.frames.length}` : ''}`}
          draggable={false}
          onLoad={() => setLoaded(page.id)}
          ref={(el) => { if (el?.complete && el.naturalWidth > 0 && loaded !== page.id) setLoaded(page.id); }}
          className="absolute left-0 top-0 max-w-none select-none"
          style={{
            width: fit.width,
            height: fit.height,
            transform: `translate3d(${fit.left}px, ${fit.top}px, 0)`,
            clipPath: frameIndex === null ? undefined : clipPath(frame),
            opacity: loaded === page.id ? 1 : 0,
            transition: reduceMotion() ? 'none' : `transform ${move}, width ${move}, height ${move}, clip-path ${move}, opacity 160ms linear`,
            willChange: 'transform',
          }}
        />
      )}
    </div>
  );
}

type Zoom = { s: number; x: number; y: number };
const NO_ZOOM: Zoom = { s: 1, x: 0, y: 0 };
const MAX_ZOOM = 5;
const DOUBLE_TAP_ZOOM = 2.5;

/** One page, or two facing pages meeting at the spine. `zoom` (single page only) scales and pans around the center of the stage. */
function PagedView({ pages, rtl, zoom, animate, children }: { pages: ReaderPage[]; rtl: boolean; zoom: Zoom; animate: boolean; children: (p: ReaderPage) => ReactNode }) {
  const pair = pages.length === 2;
  return (
    <div className="absolute inset-0 overflow-hidden" style={{ background: pages[0]?.bg_color }}>
      <div
        className={cx('flex size-full items-center justify-center', rtl && 'flex-row-reverse')}
        style={{ transform: zoom.s === 1 ? undefined : `translate3d(${zoom.x}px, ${zoom.y}px, 0) scale(${zoom.s})`, transition: animate && !reduceMotion() ? `transform 220ms ${EASE}` : 'none' }}
      >
        {pages.map((p, i) => {
          // Facing pages touch in the middle: the page on the left hugs its right edge and the other way round.
          const onLeft = pair && (i === 0) !== rtl;
          return (
            <div key={p.id} className={cx('flex h-full min-w-0 items-center', !pair ? 'justify-center' : onLeft ? 'justify-end' : 'justify-start')} style={{ flex: pair ? `${(p.width / p.height) * 10} 1 0` : '1 1 0' }}>
              {p.locked ? children(p) : <img src={pageSrc(p, (window.innerWidth / pages.length) * zoom.s) ?? undefined} alt={`Page ${p.position}`} draggable={false} className="max-h-full max-w-full select-none object-contain" />}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function ScrollView({ manifest, onSeen, onEnd, startAt, jump, paywall, end }: {
  manifest: Manifest; onSeen: (i: number) => void; onEnd: () => void; startAt: number; jump: { page: number; n: number }; paywall: (p: ReaderPage) => ReactNode; end: ReactNode;
}) {
  const root = useRef<HTMLDivElement>(null);
  const firstLocked = manifest.pages.findIndex((p) => p.locked);
  const shown = firstLocked === -1 ? manifest.pages : manifest.pages.slice(0, firstLocked + 1);
  const seen = useRef(onSeen);
  const ended = useRef(onEnd);
  seen.current = onSeen;
  ended.current = onEnd;
  useEffect(() => {
    const el = root.current;
    if (!el) return;
    // "Current page" is whichever page crosses the middle of the screen. A share-of-page threshold would never fire for a strip several screens tall.
    const io = new IntersectionObserver(
      (entries) => entries.forEach((e) => e.isIntersecting && seen.current(Number((e.target as HTMLElement).dataset.index))),
      { root: el, rootMargin: '-50% 0px -50% 0px', threshold: 0 },
    );
    el.querySelectorAll('[data-index]').forEach((n) => io.observe(n));
    // Reaching the end card (it sits under the last page) is what finishes the release.
    const endIo = new IntersectionObserver((entries) => entries.some((e) => e.isIntersecting) && ended.current(), { root: el, threshold: 0.25 });
    const endEl = el.querySelector('[data-end]');
    if (endEl) endIo.observe(endEl);
    if (startAt > 0) el.querySelector(`[data-index="${startAt}"]`)?.scrollIntoView();
    return () => {
      io.disconnect();
      endIo.disconnect();
    };
    // Only on mount / manifest change: scrolling itself must not re-run this.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [manifest.release.id, shown.length]);
  const jumped = useRef(jump.n);
  useEffect(() => {
    // Only a jump made while this view is on screen (scrubber, Home / End, Read again), not one left over from another mode.
    if (jump.n === jumped.current) return;
    jumped.current = jump.n;
    const el = root.current;
    if (!el) return;
    if (jump.page <= 0) el.scrollTo({ top: 0 });
    else el.querySelector(`[data-index="${Math.min(jump.page, shown.length - 1)}"]`)?.scrollIntoView();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jump.n]);
  return (
    <div ref={root} data-scroll-root className="absolute inset-0 overflow-y-auto overscroll-contain" style={{ background: manifest.pages[0]?.bg_color }}>
      <div className="mx-auto max-w-3xl">
        {shown.map((p, i) => (
          <div key={p.id} data-index={i} style={{ background: p.bg_color }}>
            {p.locked ? (
              <div className="py-10">{paywall(p)}</div>
            ) : (
              <img src={pageSrc(p, Math.min(768, window.innerWidth)) ?? undefined} alt={`Page ${p.position}`} loading={Math.abs(i - startAt) < 2 ? 'eager' : 'lazy'} width={p.width} height={p.height} className="block h-auto w-full" />
            )}
          </div>
        ))}
      </div>
      {firstLocked === -1 && <div data-end className="bg-ink">{end}</div>}
    </div>
  );
}

function EndCard({ manifest, onRestart, inline }: { manifest: Manifest; onRestart: () => void; inline?: boolean }) {
  const { series, release, next_release_id, offers, access } = manifest;
  const cf = series.crowdfunding?.active ? series.crowdfunding : null;
  const home = series.taken_down ? '/library' : `/series/${series.slug}`;
  return (
    <div className={cx('flex items-center justify-center bg-ink p-5', inline ? 'min-h-[80dvh] pb-28' : 'absolute inset-0 overflow-auto')} data-no-tap>
      <div className="w-full max-w-md space-y-4 text-center">
        <p className="text-sm uppercase tracking-widest text-muted">End of</p>
        <h2 className="text-3xl font-bold">{release.title}</h2>
        <p className="text-muted">
          from {series.taken_down ? series.title : <Link className="link" to={`/series/${series.slug}`}>{series.title}</Link>} by <Link className="link" to={`/b/${series.publisher.slug}`}>{series.publisher.name}</Link>
        </p>
        <div className="space-y-2.5 pt-2">
          {next_release_id && <LinkButton to={`/read/${next_release_id}`} variant="primary" size="lg" block>Read the next one<ChevronRight className="size-5" /></LinkButton>}
          {cf && <LinkButton to={cf.url} external variant="sun" block>{cf.state === 'upcoming' ? `Coming soon on ${cf.service}` : `Back this on ${cf.service}`}</LinkButton>}
          {release.print_url && <LinkButton to={release.print_url} external variant="secondary" block icon={<ShoppingBag className="size-4" />}>Buy the print edition</LinkButton>}
          {access.can_download ? (
            <LinkButton to={`/api/releases/${release.id}/download`} external variant="secondary" block icon={<Download className="size-4" />}>Download your copy</LinkButton>
          ) : offers.download_price_cents && !series.taken_down ? (
            <LinkButton to={`/series/${series.slug}`} variant="secondary" block icon={<Download className="size-4" />}>Get the download</LinkButton>
          ) : null}
          {series.taken_down
            ? <LinkButton to="/library" variant="secondary" block>Back to your library</LinkButton>
            : <LinkButton to={home} variant="secondary" block>{series.allow_comments ? 'Series page and comments' : 'Series page'}</LinkButton>}
          <Button variant="ghost" block onClick={onRestart}>Read again</Button>
        </div>
      </div>
    </div>
  );
}

const MODE_INFO: Record<Mode, { label: string; icon: ReactNode; hint: string }> = {
  guided: { label: 'Frame by frame', icon: <ScanLine className="size-4" />, hint: 'One frame at a time, sized to your screen' },
  page: { label: 'Single page', icon: <BookOpen className="size-4" />, hint: 'One whole page. Pinch or double-tap to zoom' },
  spread: { label: 'Two pages', icon: <Columns2 className="size-4" />, hint: 'Facing pages side by side' },
  scroll: { label: 'Scroll', icon: <GalleryVertical className="size-4" />, hint: 'Continuous vertical scroll' },
};

type Point = { x: number; y: number };
type Gesture =
  | { kind: 'pinch'; d0: number; z0: Zoom; mid0: Point }
  | { kind: 'pan'; id: number; from: Point; z0: Zoom };

function ReaderInner({ manifest, reload }: { manifest: Manifest; reload: () => void }) {
  const nav = useNavigate();
  const { pages, series } = manifest;
  const rtl = series.reading_dir === 'rtl';
  const preview = manifest.access.preview;
  const [stage, size] = useSize<HTMLDivElement>();
  const hasFrames = pages.some((p) => p.frames.length > 1);
  const modes: Mode[] = useMemo(() => (series.layout === 'vertical' ? ['scroll', 'page'] : ['guided', 'page', 'spread', 'scroll']), [series.layout]);

  const [mode, setModeState] = useState<Mode>(() => {
    const saved = loadModePref(series.layout);
    return saved && modes.includes(saved) ? saved : defaultMode(series.layout, window.innerWidth, window.innerHeight, hasFrames);
  });

  const steps = useMemo(() => buildSteps(pages), [pages]);
  const spreads = useMemo(() => buildSpreads(pages, manifest.spread), [pages, manifest.spread]);
  // reading_progress.position is a 0-based index into the pages; what the reader sees is always index + 1.
  const startPage = clamp(manifest.progress && !manifest.progress.finished ? manifest.progress.position : 0, 0, pages.length - 1);

  // `pageIdx` is the source of truth across modes; `stepIdx` refines it in guided view.
  const [pageIdx, setPageIdx] = useState(startPage);
  const [stepIdx, setStepIdx] = useState(() => Math.max(0, steps.findIndex((s) => s.page === startPage)));
  const [ended, setEnded] = useState(false);
  // Scroll mode never leaves the page list: the end card sits under the last page, and reaching it finishes the release.
  const [finished, setFinished] = useState(false);
  const [ui, setUi] = useState(true);
  // Heights of the control bars (including their fade), so guided view can keep frames clear of them.
  const topBar = useRef<HTMLDivElement>(null);
  const bottomBar = useRef<HTMLDivElement>(null);
  const [bars, setBars] = useState({ top: 0, bottom: 0 });
  useLayoutEffect(() => {
    const measure = () => setBars((b) => {
      const next = { top: topBar.current?.offsetHeight ?? 0, bottom: bottomBar.current?.offsetHeight ?? 0 };
      return next.top === b.top && next.bottom === b.bottom ? b : next;
    });
    measure();
    const ro = new ResizeObserver(measure);
    if (topBar.current) ro.observe(topBar.current);
    if (bottomBar.current) ro.observe(bottomBar.current);
    return () => ro.disconnect();
  });
  const [fullscreen, setFullscreen] = useState(false);
  const [jump, setJump] = useState({ page: 0, n: 0 });
  const [zoom, setZoomState] = useState<Zoom>(NO_ZOOM);
  const [zoomAnimated, setZoomAnimated] = useState(false);
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;

  // Unlocking a page gives it frames, which renumbers the steps: stay on the page being read.
  useEffect(() => {
    setStepIdx((i) => (steps[i]?.page === pageIdx ? i : Math.max(0, steps.findIndex((s) => s.page === pageIdx))));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [steps]);

  const current = pages[pageIdx];
  const step = steps[stepIdx];
  const zoomable = mode === 'page' && !ended && Boolean(current) && !current.locked;

  const setZoom = useCallback(
    (z: Zoom, animate = false) => {
      const s = clamp(z.s, 1, MAX_ZOOM);
      const next = s < 1.03 ? NO_ZOOM : { s, x: clamp(z.x, (-(s - 1) * size.w) / 2, ((s - 1) * size.w) / 2), y: clamp(z.y, (-(s - 1) * size.h) / 2, ((s - 1) * size.h) / 2) };
      zoomRef.current = next;
      setZoomAnimated(animate);
      setZoomState(next);
    },
    [size.w, size.h],
  );
  /** Zoom to `s` keeping the point under (clientX, clientY) where it is. */
  const zoomAt = useCallback(
    (s: number, clientX: number, clientY: number, animate = false) => {
      const rect = stage.current?.getBoundingClientRect();
      if (!rect) return;
      const z = zoomRef.current;
      const p = { x: clientX - rect.left - rect.width / 2, y: clientY - rect.top - rect.height / 2 };
      const c = { x: (p.x - z.x) / z.s, y: (p.y - z.y) / z.s };
      const ns = clamp(s, 1, MAX_ZOOM);
      setZoom({ s: ns, x: p.x - c.x * ns, y: p.y - c.y * ns }, animate);
    },
    [setZoom, stage],
  );
  useEffect(() => {
    zoomRef.current = NO_ZOOM;
    setZoomState(NO_ZOOM);
  }, [pageIdx, mode, ended]);

  const setMode = (m: Mode) => {
    setModeState(m);
    saveModePref(series.layout, m);
  };

  const goToPage = useCallback(
    (i: number) => {
      const p = clamp(i, 0, pages.length - 1);
      setPageIdx(p);
      setStepIdx(Math.max(0, steps.findIndex((s) => s.page === p)));
      setEnded(false);
      setJump((j) => ({ page: p, n: j.n + 1 }));
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

  // Reading stats and resume position. A private preview records nothing.
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
      if (preview || !p || p.locked || sent.current.has(p.id)) return;
      sent.current.add(p.id);
      pending.current.add(p.id);
    },
    [pages, preview],
  );
  useEffect(() => {
    if (ended) return;
    const visible = mode === 'spread' ? (spreads.find((s) => s.includes(pageIdx)) ?? [pageIdx]) : [pageIdx];
    visible.forEach(markSeen);
  }, [pageIdx, mode, spreads, markSeen, ended]);
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
  const done = ended || finished;
  useEffect(() => {
    if (!user || preview) return;
    const t = setTimeout(() => {
      api('/api/progress', { method: 'PUT', json: { release_id: manifest.release.id, position: pageIdx, finished: done } }).catch(() => {});
    }, 1200);
    return () => clearTimeout(t);
  }, [pageIdx, done, user, preview, manifest.release.id]);

  // Warm the next couple of pages with the same file the current mode will ask for.
  useEffect(() => {
    if (!size.w) return;
    for (const i of [pageIdx + 1, pageIdx + 2]) {
      const p = pages[i];
      if (!p || p.locked) continue;
      const src = mode === 'guided' ? guidedSrc(p, size.w, size.h, guidedPad(size.w)) : pageSrc(p, mode === 'spread' ? window.innerWidth / 2 : mode === 'scroll' ? Math.min(768, window.innerWidth) : window.innerWidth);
      if (src) new Image().src = src;
    }
  }, [pageIdx, pages, size.w, size.h, mode]);

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
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      // Arrow keys follow the page: in a right-to-left book the next page is to the left.
      const fwd = rtl ? 'ArrowLeft' : 'ArrowRight';
      const back = rtl ? 'ArrowRight' : 'ArrowLeft';
      const center = () => { const r = stage.current?.getBoundingClientRect(); return r ? [r.left + r.width / 2, r.top + r.height / 2] as const : null; };
      if (mode !== 'scroll' && (e.key === fwd || e.key === ' ' || e.key === 'PageDown' || e.key === 'ArrowDown')) {
        e.preventDefault();
        move(1);
      } else if (mode !== 'scroll' && (e.key === back || e.key === 'PageUp' || e.key === 'ArrowUp')) {
        e.preventDefault();
        move(-1);
      } else if (e.key === 'Home') goToPage(0);
      else if (e.key === 'End') goToPage(pages.length - 1);
      else if (e.key === 'f') toggleFullscreen();
      else if (e.key === 'g' && modes.includes('guided')) setMode(mode === 'guided' ? 'page' : 'guided');
      else if (e.key === 'Escape') { if (zoomRef.current.s > 1) setZoom(NO_ZOOM, true); else setUi(true); }
      else if (zoomable && (e.key === '+' || e.key === '=')) { const c = center(); if (c) zoomAt(zoomRef.current.s * 1.5, c[0], c[1], true); }
      else if (zoomable && e.key === '-') { const c = center(); if (c) zoomAt(zoomRef.current.s / 1.5, c[0], c[1], true); }
      else if (zoomable && e.key === '0') setZoom(NO_ZOOM, true);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  // Trackpad pinch (ctrl + wheel) zooms; a plain wheel pans once zoomed. Needs a non-passive listener to stop the browser zooming the whole page.
  useEffect(() => {
    const el = stage.current;
    if (!el || !zoomable) return;
    const onWheel = (e: WheelEvent) => {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        zoomAt(zoomRef.current.s * Math.exp(-e.deltaY / 200), e.clientX, e.clientY);
      } else if (zoomRef.current.s > 1) {
        e.preventDefault();
        const z = zoomRef.current;
        setZoom({ s: z.s, x: z.x - e.deltaX, y: z.y - e.deltaY });
      }
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [zoomable, zoomAt, setZoom, stage]);

  // Taps, swipes, pinch and pan on the stage.
  const pointers = useRef(new Map<number, Point>());
  const gesture = useRef<Gesture | null>(null);
  const down = useRef<{ x: number; y: number; t: number; target: HTMLElement; moved: boolean } | null>(null);
  const lastTap = useRef<{ x: number; y: number; t: number } | null>(null);
  const tapTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (tapTimer.current) clearTimeout(tapTimer.current); }, []);

  const tapAt = (clientX: number) => {
    const rect = stage.current?.getBoundingClientRect();
    if (!rect) return;
    const f = (clientX - rect.left) / rect.width;
    // The outer thirds turn the page; which one is "next" follows the reading direction.
    if (f > 0.33 && f < 0.67) setUi((v) => !v);
    else move((f >= 0.67) !== rtl ? 1 : -1);
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.current.size === 1) {
      down.current = { x: e.clientX, y: e.clientY, t: Date.now(), target: e.target as HTMLElement, moved: false };
      if (zoomable && zoomRef.current.s > 1) gesture.current = { kind: 'pan', id: e.pointerId, from: { x: e.clientX, y: e.clientY }, z0: zoomRef.current };
    } else if (pointers.current.size === 2 && zoomable) {
      const [a, b] = [...pointers.current.values()];
      gesture.current = { kind: 'pinch', d0: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)), z0: zoomRef.current, mid0: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } };
      if (down.current) down.current.moved = true; // two fingers are never a tap
    }
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (!pointers.current.has(e.pointerId)) return;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const g = gesture.current;
    if (!g) return;
    if (g.kind === 'pinch' && pointers.current.size >= 2) {
      const rect = stage.current?.getBoundingClientRect();
      if (!rect) return;
      const [a, b] = [...pointers.current.values()];
      const s = clamp((g.z0.s * Math.hypot(a.x - b.x, a.y - b.y)) / g.d0, 1, MAX_ZOOM);
      const center = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
      // The point of the page that was between the fingers stays between the fingers.
      const c = { x: (g.mid0.x - center.x - g.z0.x) / g.z0.s, y: (g.mid0.y - center.y - g.z0.y) / g.z0.s };
      const mid = { x: (a.x + b.x) / 2 - center.x, y: (a.y + b.y) / 2 - center.y };
      setZoom({ s, x: mid.x - c.x * s, y: mid.y - c.y * s });
    } else if (g.kind === 'pan' && g.id === e.pointerId) {
      const dx = e.clientX - g.from.x;
      const dy = e.clientY - g.from.y;
      if (Math.abs(dx) + Math.abs(dy) > 6 && down.current) down.current.moved = true;
      setZoom({ s: g.z0.s, x: g.z0.x + dx, y: g.z0.y + dy });
    }
  };
  const onPointerUp = (e: React.PointerEvent) => {
    if (!pointers.current.delete(e.pointerId)) return;
    const g = gesture.current;
    if (g?.kind === 'pinch') {
      // One finger left on the glass carries on as a pan.
      const rest = [...pointers.current.entries()][0];
      gesture.current = rest && zoomRef.current.s > 1 ? { kind: 'pan', id: rest[0], from: rest[1], z0: zoomRef.current } : null;
      return;
    }
    if (g?.kind === 'pan' && g.id === e.pointerId) gesture.current = null;
    const s = down.current;
    if (pointers.current.size > 0 || !s) return;
    down.current = null;
    if (e.type === 'pointercancel' || s.moved || mode === 'scroll' || s.target.closest('input')) return;
    const dx = e.clientX - s.x;
    const dy = e.clientY - s.y;
    const zoomed = zoomRef.current.s > 1;
    if (!zoomed && Math.abs(dx) > 45 && Math.abs(dx) > Math.abs(dy) * 1.5) {
      // Swipe: the page follows the finger, so swiping left goes forward in a left-to-right book and back in a right-to-left one.
      move((dx < 0) !== rtl ? 1 : -1);
      return;
    }
    // A swipe may start anywhere, the paywall included; a tap on a link, a button or the paywall belongs to that control.
    if (Math.abs(dx) > 10 || Math.abs(dy) > 10 || Date.now() - s.t > 600 || s.target.closest('a, button, [data-no-tap]')) return;
    if (!zoomable) return tapAt(e.clientX);
    // Single page: wait a moment to see whether this is the first half of a double-tap (zoom).
    const now = Date.now();
    const last = lastTap.current;
    if (last && now - last.t < 320 && Math.hypot(e.clientX - last.x, e.clientY - last.y) < 48) {
      lastTap.current = null;
      if (tapTimer.current) clearTimeout(tapTimer.current);
      if (zoomed) setZoom(NO_ZOOM, true);
      else zoomAt(DOUBLE_TAP_ZOOM, e.clientX, e.clientY, true);
      return;
    }
    lastTap.current = { x: e.clientX, y: e.clientY, t: now };
    const x = e.clientX;
    tapTimer.current = setTimeout(() => {
      lastTap.current = null;
      if (zoomRef.current.s > 1) setUi((v) => !v);
      else tapAt(x);
    }, 280);
  };

  const paywall = (p: ReaderPage) => <div data-no-tap className="h-full w-full"><Paywall manifest={manifest} page={p} onUnlocked={reload} compact={mode === 'scroll'} /></div>;
  const screenPages = mode === 'spread' ? (spreads.find((s) => s.includes(pageIdx)) ?? [pageIdx]).map((i) => pages[i]) : [current];
  const progress = pages.length > 1 ? pageIdx / (pages.length - 1) : 1;
  const frameLabel = mode === 'guided' && step && step.frame !== null && current && !current.locked && current.frames.length > 1 ? ` · frame ${step.frame + 1}/${current.frames.length}` : '';
  // Two facing pages show as "3-4"; everything shown to the reader is the 0-based index + 1.
  const shownPages = mode === 'spread' && screenPages.length === 2 ? `${screenPages[0].position}-${screenPages[1].position}` : `${pageIdx + 1}`;
  const home = series.taken_down ? '/library' : `/series/${series.slug}`;
  const restart = () => {
    setFinished(false);
    goToPage(0);
  };

  // While the controls show, guided frames keep clear of them (never giving up more than 45% of the height).
  const wantTop = ui ? bars.top : 0;
  const wantBottom = ui && !ended ? bars.bottom : 0;
  const squeeze = Math.min(1, (size.h * 0.45) / Math.max(1, wantTop + wantBottom));
  const clear = { top: Math.round(wantTop * squeeze), bottom: Math.round(wantBottom * squeeze) };
  return (
    <div className="fixed inset-0 flex flex-col bg-black text-paper" dir="ltr">
      <div
        ref={stage}
        className="relative min-h-0 flex-1 select-none"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        style={{ touchAction: mode === 'scroll' || ended ? 'pan-y' : 'none' }}
      >
        {ended ? (
          <EndCard manifest={manifest} onRestart={restart} />
        ) : mode === 'scroll' ? (
          <ScrollView
            manifest={manifest}
            startAt={pageIdx}
            jump={jump}
            paywall={paywall}
            onSeen={(i) => {
              setPageIdx(i);
              markSeen(i);
            }}
            onEnd={() => {
              // Reaching the end card means the last page has gone by, even after a jump or a fast fling.
              setPageIdx(pages.length - 1);
              markSeen(pages.length - 1);
              setFinished(true);
            }}
            end={<EndCard manifest={manifest} onRestart={restart} inline />}
          />
        ) : !current ? null : mode === 'guided' && !current.locked ? (
          size.w > 0 && <GuidedView page={current} frameIndex={step?.frame ?? null} w={size.w} h={size.h} top={clear.top} bottom={clear.bottom} />
        ) : (
          <PagedView pages={screenPages} rtl={rtl} zoom={zoomable ? zoom : NO_ZOOM} animate={zoomAnimated}>{paywall}</PagedView>
        )}

        {/* First-visit hint for guided view */}
        {mode === 'guided' && !ended && ui && stepIdx === 0 && hasFrames && (
          <div className="pointer-events-none absolute inset-x-0 bottom-24 flex justify-center px-4">
            <div className="rounded-full bg-black/75 px-4 py-2 text-center text-sm backdrop-blur">Tap the {rtl ? 'left' : 'right'} side or swipe {rtl ? 'right' : 'left'} to move frame by frame</div>
          </div>
        )}
        {zoomable && zoom.s > 1 && (
          <div className="absolute inset-x-0 bottom-24 flex justify-center px-4">
            <button type="button" onClick={() => setZoom(NO_ZOOM, true)} className="flex h-10 items-center gap-2 rounded-full bg-black/75 px-4 text-sm backdrop-blur hover:bg-black">
              <ZoomOut className="size-4" aria-hidden />{Math.round(zoom.s * 100)}% · reset zoom
            </button>
          </div>
        )}
      </div>

      {/* Top bar */}
      <div ref={topBar} className={cx('absolute inset-x-0 top-0 z-10 flex items-center gap-2 bg-gradient-to-b from-black via-black/80 to-transparent px-2 pb-10 pt-2 transition-opacity sm:px-4', ui ? 'opacity-100' : 'pointer-events-none opacity-0')}>
        <IconButton label={series.taken_down ? 'Back to your library' : 'Back to series'} onClick={() => nav(home)}><ArrowLeft className="size-5" /></IconButton>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold">{manifest.release.title}</div>
          <Link to={home} className="block truncate text-xs text-paper/75 hover:text-paper">{series.title} · {series.publisher.name}</Link>
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
              className={cx('flex h-9 min-w-10 items-center justify-center gap-1.5 rounded-lg px-2.5 text-xs font-medium transition-colors', mode === m ? 'bg-accent text-accent-ink' : 'text-muted hover:text-paper')}
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
      {(preview || series.taken_down) && ui && (
        <div className="pointer-events-none absolute inset-x-0 top-14 z-10 flex justify-center px-3">
          <div className="rounded-full bg-black/80 px-3.5 py-1.5 text-center text-xs text-muted backdrop-blur">
            {preview ? 'Private preview: nothing you read here is counted.' : 'This title is no longer in the store. You can still read it because you own it.'}
          </div>
        </div>
      )}

      {/* Bottom bar */}
      <div ref={bottomBar} className={cx('absolute inset-x-0 bottom-0 z-10 bg-gradient-to-t from-black via-black/80 to-transparent px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-10 transition-opacity sm:px-5', ui && !ended ? 'opacity-100' : 'pointer-events-none opacity-0')}>
        <div className="mx-auto flex max-w-3xl items-center gap-3">
          {mode !== 'scroll' && <IconButton label={rtl ? 'Next' : 'Previous'} onClick={() => move(rtl ? 1 : -1)}><ChevronLeft className="size-5" /></IconButton>}
          {/* In a right-to-left book the scrubber fills from the right, like the pages. */}
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
          />
          <span className="shrink-0 text-xs tabular-nums text-paper/85">{shownPages} / {pages.length}{frameLabel}</span>
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

/** The API answered `mature`: one tap confirms 18+ (saved to the account, or a cookie when signed out) and the release opens in place. */
function MatureGate({ message }: { message: string }) {
  const { user, setAdult } = useSession();
  const [busy, setBusy] = useState(false);
  const confirm = async () => {
    setBusy(true);
    try {
      // setAdult refreshes every query, including this release, so the reader opens without leaving the page.
      await setAdult(true);
    } catch (e) {
      toast.error(errorMessage(e));
      setBusy(false);
    }
  };
  return (
    <Gate title="This release is for adults" action={<Button variant="primary" loading={busy} onClick={confirm}>I am 18 or older, show it</Button>}>
      {message} {user ? 'Your choice is saved to your account and adult titles will also show in the store. You can turn this off again in your account settings.' : 'Your choice is remembered on this device, and adult titles will also show in the store.'}
    </Gate>
  );
}

export function Reader() {
  const { releaseId } = useParams();
  const [params] = useSearchParams();
  const preview = params.get('preview');
  const qc = useQueryClient();
  const { user } = useSession();
  const key = ['reader', releaseId, preview, user?.id ?? null];
  const { data, error, isLoading, refetch, isFetching } = useQuery({
    queryKey: key,
    queryFn: () => api<Manifest>(`/api/releases/${releaseId}`, { query: { preview } }),
    staleTime: 60_000,
    retry: false,
  });

  if (isLoading) return <div className="min-h-dvh bg-ink"><PageLoader label="Opening" /></div>;
  if (error || !data) {
    const e = error as ApiError | null;
    if (e?.code === 'mature') return <MatureGate message={e.message} />;
    return <Gate title="This release is not available" action={<Button loading={isFetching} onClick={() => refetch()}>Try again</Button>}>{e?.message ?? 'It may have been unpublished or the link may be wrong.'}</Gate>;
  }
  if (data.pages.length === 0) return <Gate title="No pages yet">This release has no pages to read yet.</Gate>;
  return <ReaderInner key={data.release.id} manifest={data} reload={() => void qc.invalidateQueries({ queryKey: ['reader', releaseId] })} />;
}
