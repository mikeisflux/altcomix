import { WHOLE_PAGE, fitFrame } from '@/lib/frames';
import type { Frame } from '@/lib/frames';

export type ReaderPage = {
  id: string;
  position: number;
  width: number;
  height: number;
  bg_color: string;
  frames: Frame[];
  locked: boolean;
  url_medium: string | null;
  url_full: string | null;
};

export type Manifest = {
  release: { id: string; title: string; number: number; kind: string; language: string; mature: boolean; page_count: number; synopsis: string; print_url: string | null; published_at: string | null };
  series: {
    id: string;
    slug: string;
    title: string;
    layout: 'paged' | 'vertical';
    reading_dir: 'ltr' | 'rtl';
    cover_url: string | null;
    allow_comments: boolean;
    publisher: { id: string; slug: string; name: string; avatar_url: string | null };
    crowdfunding: null | { service: string; url: string; goal_cents: number | null; starts_at: string | null; ends_at: string | null; active: boolean; state: 'upcoming' | 'live' | 'ended' };
    /** Removed from the store; this reader can still open it because they own it (or work for the brand). */
    taken_down: boolean;
  };
  spread: { pref: 'first' | 'last'; single_cover: boolean };
  pages: ReaderPage[];
  access: { model: string; release_free: boolean; unlock: string | null; can_download: boolean; free_pages: number; locked_pages: number; preview: boolean };
  offers: { read_price_cents: number | null; read_list_price_cents: number | null; download_price_cents: number | null; series_price_cents: number | null; in_membership: boolean; page_credits_available: number };
  prev_release_id: string | null;
  next_release_id: string | null;
  progress: null | { position: number; finished: boolean };
};

export type Mode = 'guided' | 'page' | 'spread' | 'scroll';

/** One stop in guided view: a frame of a page, the whole page, or a locked page. */
export type Step = { page: number; frame: number | null };

export function buildSteps(pages: ReaderPage[]): Step[] {
  const steps: Step[] = [];
  pages.forEach((p, i) => {
    if (p.locked || p.frames.length === 0) steps.push({ page: i, frame: null });
    else p.frames.forEach((_, f) => steps.push({ page: i, frame: f }));
  });
  return steps;
}

/**
 * Group page indexes into screens for double-page mode.
 * Landscape pages are already spreads and stand alone. With `single_cover` the
 * first page stands alone. In a run with an odd number of pages, `pref`
 * decides which end keeps the single page: 'last' pairs up the final two.
 */
export function buildSpreads(pages: ReaderPage[], spread: Manifest['spread']): number[][] {
  const out: number[][] = [];
  let run: number[] = [];
  const flush = () => {
    const r = run;
    run = [];
    if (!r.length) return;
    const odd = r.length % 2 === 1;
    const single = odd ? (spread.pref === 'last' ? r.shift()! : r.pop()!) : null;
    if (single !== null && spread.pref === 'last') out.push([single]);
    for (let i = 0; i < r.length; i += 2) out.push([r[i], r[i + 1]]);
    if (single !== null && spread.pref !== 'last') out.push([single]);
  };
  pages.forEach((p, i) => {
    const alone = p.width > p.height || p.locked || (i === 0 && spread.single_cover);
    if (alone) {
      flush();
      out.push([i]);
    } else run.push(i);
  });
  flush();
  return out;
}

export function defaultMode(layout: 'paged' | 'vertical', viewW: number, viewH: number, hasFrames: boolean): Mode {
  if (layout === 'vertical') return 'scroll';
  const small = Math.min(viewW, viewH) < 640 || viewW < 820;
  // On phones and small tablets a print page is unreadable whole: go frame by frame.
  if (small) return hasFrames ? 'guided' : 'page';
  return viewW > viewH * 1.25 ? 'spread' : 'page';
}

const PREF_KEY = 'altcomix.reader.mode';

export function loadModePref(layout: string): Mode | null {
  try {
    const v = JSON.parse(localStorage.getItem(PREF_KEY) ?? '{}')[layout + (window.innerWidth < 820 ? ':s' : ':l')];
    return v === 'guided' || v === 'page' || v === 'spread' || v === 'scroll' ? v : null;
  } catch {
    return null;
  }
}

export function saveModePref(layout: string, mode: Mode): void {
  try {
    const all = JSON.parse(localStorage.getItem(PREF_KEY) ?? '{}');
    all[layout + (window.innerWidth < 820 ? ':s' : ':l')] = mode;
    localStorage.setItem(PREF_KEY, JSON.stringify(all));
  } catch {
    /* private mode */
  }
}

/** Pick the sharper file only when the page is drawn larger than the medium variant. */
export function pageSrc(p: ReaderPage, drawnWidthCssPx: number): string | null {
  const need = drawnWidthCssPx * Math.min(window.devicePixelRatio || 1, 2);
  return need > 1150 && p.url_full ? p.url_full : (p.url_medium ?? p.url_full);
}

/** Guided view picks one file per page (the sharpest any of its frames needs), so moving between frames never swaps the image. */
export function guidedSrc(p: ReaderPage, viewW: number, viewH: number, pad: number): string | null {
  const aspect = p.width / p.height;
  const widest = Math.max(...[WHOLE_PAGE as Frame, ...p.frames].map((f) => fitFrame(f, aspect, viewW, viewH, pad).width));
  return pageSrc(p, widest);
}
