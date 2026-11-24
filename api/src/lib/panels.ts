import sharp from 'sharp';
import { z } from 'zod';

/**
 * Reading-frame (panel) detection by classical image processing. No models,
 * nothing leaves the server.
 *
 * The page is reduced to a small greyscale copy. The gutter colour is taken
 * from the page border, every pixel is classed as "gutter-coloured" or
 * "content", and the page is split with a recursive XY-cut along runs of empty
 * rows / columns. Leaves the XY-cut cannot split (L-shaped or staggered
 * layouts) fall back to connected components of everything that is not gutter.
 * Pages with no clean border are treated as full-bleed: one frame.
 *
 * Frames are fractions of the page (0..1): `{x,y,w,h}` or `{points:[[x,y],...]}`.
 */

export type RectFrame = { x: number; y: number; w: number; h: number };
export type PolyFrame = { points: [number, number][] };
export type Frame = RectFrame | PolyFrame;
export type ReadingDir = 'ltr' | 'rtl';

const unit = z.number().min(-0.0005).max(1.0005);
export const frameSchema = z.union([
  z
    .object({ x: unit, y: unit, w: z.number().min(0.005).max(1.0005), h: z.number().min(0.005).max(1.0005) })
    .refine((f) => f.x + f.w <= 1.001 && f.y + f.h <= 1.001, 'Frame extends past the edge of the page'),
  z.object({ points: z.array(z.tuple([unit, unit])).min(3, 'A frame needs at least 3 points').max(400) }),
]);
export const framesSchema = z.array(frameSchema).max(200, 'A page can have at most 200 frames');

const r4 = (n: number) => Math.round(Math.min(1, Math.max(0, n)) * 10000) / 10000;

export function isPoly(f: Frame): f is PolyFrame {
  return Array.isArray((f as PolyFrame).points);
}

/** Clamp to the page and round to 4 decimals. */
export function normaliseFrame(f: Frame): Frame {
  if (isPoly(f)) return { points: f.points.map(([x, y]) => [r4(x), r4(y)] as [number, number]) };
  const x = r4(f.x);
  const y = r4(f.y);
  return { x, y, w: r4(Math.min(f.w, 1 - x)), h: r4(Math.min(f.h, 1 - y)) };
}

export function frameBounds(f: Frame): RectFrame {
  if (!isPoly(f)) return f;
  let x0 = 1, y0 = 1, x1 = 0, y1 = 0;
  for (const [x, y] of f.points) {
    x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

// ---------------------------------------------------------------- analysis

export type Analysis = {
  w: number;
  h: number;
  grey: Uint8Array;
  /** Gutter grey level. */
  bg: number;
  /** Share of border pixels that match `bg` (low = art runs to the edge). */
  uniform: number;
  /** 1 where the pixel differs from the gutter colour. */
  content: Uint8Array;
  /** 1 where the pixel is gutter: background connected to the page edge. */
  gutter: Uint8Array;
};

const TOLERANCE = 30;
type Box = { x0: number; y0: number; x1: number; y1: number }; // inclusive pixel bounds

export async function loadGrey(input: Buffer | string, maxEdge = 800): Promise<{ grey: Uint8Array; w: number; h: number }> {
  const { data, info } = await sharp(input)
    .rotate()
    .flatten({ background: '#ffffff' })
    .greyscale()
    .resize({ width: maxEdge, height: maxEdge, fit: 'inside', withoutEnlargement: true, kernel: 'cubic' })
    .raw()
    .toBuffer({ resolveWithObject: true });
  const { width: w, height: h, channels } = info;
  if (channels === 1) return { grey: new Uint8Array(data.buffer, data.byteOffset, w * h), w, h };
  const grey = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) grey[i] = data[i * channels];
  return { grey, w, h };
}

/** Most common grey level in a thin band around the page edge. */
export function estimateBackground(grey: Uint8Array, w: number, h: number): { bg: number; uniform: number } {
  const band = Math.max(2, Math.round(Math.min(w, h) * 0.012));
  const hist = new Uint32Array(256);
  let n = 0;
  for (let y = 0; y < h; y++) {
    const edgeRow = y < band || y >= h - band;
    for (let x = 0; x < w; x++) {
      if (!edgeRow && x >= band && x < w - band) {
        x = w - band - 1; // skip the interior
        continue;
      }
      hist[grey[y * w + x]]++;
      n++;
    }
  }
  const win = 8;
  let best = -1;
  let bestSum = -1;
  for (let v = 0; v < 256; v++) {
    let s = 0;
    for (let k = Math.max(0, v - win); k <= Math.min(255, v + win); k++) s += hist[k];
    if (s > bestSum) {
      bestSum = s;
      best = v;
    }
  }
  let ws = 0;
  let wn = 0;
  for (let k = Math.max(0, best - win); k <= Math.min(255, best + win); k++) {
    ws += hist[k] * k;
    wn += hist[k];
  }
  const bg = wn ? Math.round(ws / wn) : 255;
  // A real margin shows the gutter colour on all four sides, so score the worst side.
  const share = (x0: number, y0: number, x1: number, y1: number) => {
    let hit = 0;
    let all = 0;
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        all++;
        if (Math.abs(grey[y * w + x] - bg) <= TOLERANCE) hit++;
      }
    }
    return all ? hit / all : 0;
  };
  const uniform = n ? Math.min(share(0, 0, w, band), share(0, h - band, w, h), share(0, 0, band, h), share(w - band, 0, w, h)) : 0;
  return { bg, uniform };
}

function buildMasks(grey: Uint8Array, w: number, h: number, bg: number): { content: Uint8Array; gutter: Uint8Array } {
  const n = w * h;
  const content = new Uint8Array(n);
  for (let i = 0; i < n; i++) content[i] = Math.abs(grey[i] - bg) > TOLERANCE ? 1 : 0;

  // Background pixels whose 3x3 neighbourhood is all background. Flooding only
  // through these stops the gutter leaking into a panel through a 1-2px gap.
  const open = new Uint8Array(n);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let ok = 1;
      for (let dy = -1; dy <= 1 && ok; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= w) continue;
          if (content[yy * w + xx]) {
            ok = 0;
            break;
          }
        }
      }
      open[y * w + x] = ok;
    }
  }
  const reached = new Uint8Array(n);
  const stack = new Int32Array(n);
  let sp = 0;
  const seed = (i: number) => {
    if (open[i] && !reached[i]) {
      reached[i] = 1;
      stack[sp++] = i;
    }
  };
  for (let x = 0; x < w; x++) {
    seed(x);
    seed((h - 1) * w + x);
  }
  for (let y = 0; y < h; y++) {
    seed(y * w);
    seed(y * w + w - 1);
  }
  while (sp) {
    const i = stack[--sp];
    const x = i % w;
    if (x > 0) seed(i - 1);
    if (x < w - 1) seed(i + 1);
    if (i >= w) seed(i - w);
    if (i < n - w) seed(i + w);
  }
  // Grow back the pixel lost to the erosion.
  const gutter = new Uint8Array(n);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (content[i]) continue;
      if (reached[i]) {
        gutter[i] = 1;
        continue;
      }
      let near = 0;
      for (let dy = -1; dy <= 1 && !near; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          if (xx >= 0 && xx < w && reached[yy * w + xx]) {
            near = 1;
            break;
          }
        }
      }
      gutter[i] = near;
    }
  }
  return { content, gutter };
}

export function analyseGrey(grey: Uint8Array, w: number, h: number, forceBg?: number): Analysis {
  const est = estimateBackground(grey, w, h);
  const bg = forceBg ?? est.bg;
  return { w, h, grey, bg, uniform: est.uniform, ...buildMasks(grey, w, h, bg) };
}

export async function analysePage(input: Buffer | string): Promise<Analysis> {
  const { grey, w, h } = await loadGrey(input);
  return analyseGrey(grey, w, h);
}

// ---------------------------------------------------------------- XY-cut

function trim(a: Analysis, b: Box): Box | null {
  const { content, w } = a;
  let { x0, y0, x1, y1 } = b;
  const rowEmpty = (y: number) => {
    for (let x = x0; x <= x1; x++) if (content[y * w + x]) return false;
    return true;
  };
  const colEmpty = (x: number) => {
    for (let y = y0; y <= y1; y++) if (content[y * w + x]) return false;
    return true;
  };
  while (y0 <= y1 && rowEmpty(y0)) y0++;
  if (y0 > y1) return null;
  while (rowEmpty(y1)) y1--;
  while (x0 <= x1 && colEmpty(x0)) x0++;
  while (colEmpty(x1)) x1--;
  return { x0, y0, x1, y1 };
}

/** Split a box along runs of empty rows (axis 'y') or columns (axis 'x') at least `minGap` long. */
function cut(a: Analysis, b: Box, axis: 'x' | 'y', minGap: number): Box[] {
  const { content, w } = a;
  const from = axis === 'y' ? b.y0 : b.x0;
  const to = axis === 'y' ? b.y1 : b.x1;
  const len = axis === 'y' ? b.x1 - b.x0 + 1 : b.y1 - b.y0 + 1;
  // A stray pixel or two (JPEG noise, a hairline) does not close a gutter.
  const allow = Math.floor(len * 0.0025);
  const empty = (k: number) => {
    let c = 0;
    if (axis === 'y') {
      for (let x = b.x0; x <= b.x1; x++) if (content[k * w + x] && ++c > allow) return false;
    } else {
      for (let y = b.y0; y <= b.y1; y++) if (content[y * w + k] && ++c > allow) return false;
    }
    return true;
  };
  const parts: Box[] = [];
  let start = from;
  let k = from;
  while (k <= to) {
    if (!empty(k)) {
      k++;
      continue;
    }
    let e = k;
    while (e <= to && empty(e)) e++;
    if (e - k >= minGap && k > start && e <= to) {
      parts.push(axis === 'y' ? { ...b, y0: start, y1: k - 1 } : { ...b, x0: start, x1: k - 1 });
      start = e;
    }
    k = e;
  }
  if (!parts.length) return [b];
  parts.push(axis === 'y' ? { ...b, y0: start, y1: to } : { ...b, x0: start, x1: to });
  return parts;
}

function xyCut(a: Analysis, box: Box, minGap: number, depth = 0): Box[] {
  const b = trim(a, box);
  if (!b) return [];
  if (depth > 12) return [b];
  for (const axis of ['y', 'x'] as const) {
    const parts = cut(a, b, axis, minGap);
    if (parts.length > 1) return parts.flatMap((p) => xyCut(a, p, minGap, depth + 1));
  }
  return [b];
}

/** Bounding boxes of the connected non-gutter regions inside a box. */
function components(a: Analysis, b: Box): { box: Box; area: number }[] {
  const { gutter, w } = a;
  const bw = b.x1 - b.x0 + 1;
  const bh = b.y1 - b.y0 + 1;
  const seen = new Uint8Array(bw * bh);
  const stack = new Int32Array(bw * bh);
  const out: { box: Box; area: number }[] = [];
  for (let sy = 0; sy < bh; sy++) {
    for (let sx = 0; sx < bw; sx++) {
      const s = sy * bw + sx;
      if (seen[s] || gutter[(b.y0 + sy) * w + b.x0 + sx]) continue;
      let sp = 0;
      stack[sp++] = s;
      seen[s] = 1;
      let x0 = sx, x1 = sx, y0 = sy, y1 = sy, area = 0;
      while (sp) {
        const i = stack[--sp];
        const x = i % bw;
        const y = (i - x) / bw;
        area++;
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
        const visit = (xx: number, yy: number) => {
          if (xx < 0 || yy < 0 || xx >= bw || yy >= bh) return;
          const j = yy * bw + xx;
          if (seen[j] || gutter[(b.y0 + yy) * w + b.x0 + xx]) return;
          seen[j] = 1;
          stack[sp++] = j;
        };
        visit(x - 1, y);
        visit(x + 1, y);
        visit(x, y - 1);
        visit(x, y + 1);
      }
      out.push({ box: { x0: b.x0 + x0, y0: b.y0 + y0, x1: b.x0 + x1, y1: b.y0 + y1 }, area });
    }
  }
  return out;
}

const boxArea = (b: Box) => (b.x1 - b.x0 + 1) * (b.y1 - b.y0 + 1);

function overlap(a: Box, b: Box): number {
  const ox = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0) + 1;
  const oy = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0) + 1;
  return ox > 0 && oy > 0 ? ox * oy : 0;
}

/** Merge boxes that mostly cover each other (a caption box sitting inside a panel). */
function mergeNested(boxes: Box[]): Box[] {
  const out = boxes.slice();
  let merged = true;
  while (merged) {
    merged = false;
    outer: for (let i = 0; i < out.length; i++) {
      for (let j = i + 1; j < out.length; j++) {
        const o = overlap(out[i], out[j]);
        if (o > 0.6 * Math.min(boxArea(out[i]), boxArea(out[j]))) {
          out[i] = {
            x0: Math.min(out[i].x0, out[j].x0), y0: Math.min(out[i].y0, out[j].y0),
            x1: Math.max(out[i].x1, out[j].x1), y1: Math.max(out[i].y1, out[j].y1),
          };
          out.splice(j, 1);
          merged = true;
          break outer;
        }
      }
    }
  }
  return out;
}

export type DetectOptions = {
  dir?: ReadingDir;
  /** Smallest panel side as a fraction of the page side. */
  minSide?: number;
};

function panelsFor(a: Analysis, minSide: number): Box[] {
  const { w, h } = a;
  const minGap = Math.max(2, Math.round(Math.max(w, h) * 0.004));
  const big = (b: Box) => b.x1 - b.x0 + 1 >= w * minSide && b.y1 - b.y0 + 1 >= h * minSide;
  const leaves = xyCut(a, { x0: 0, y0: 0, x1: w - 1, y1: h - 1 }, minGap).filter(big);
  const out: Box[] = [];
  for (const leaf of leaves) {
    // Irregular layouts: gutters that turn a corner leave several panels in one leaf.
    const parts = mergeNested(components(a, leaf).filter((c) => big(c.box)).map((c) => c.box));
    if (parts.length >= 2) out.push(...parts);
    else out.push(leaf);
  }
  return out;
}

const toRect = (b: Box, w: number, h: number): RectFrame =>
  normaliseFrame({ x: b.x0 / w, y: b.y0 / h, w: (b.x1 - b.x0 + 1) / w, h: (b.y1 - b.y0 + 1) / h }) as RectFrame;

const WHOLE_PAGE: RectFrame = { x: 0, y: 0, w: 1, h: 1 };

export function detectFromGrey(grey: Uint8Array, w: number, h: number, opts: DetectOptions = {}): RectFrame[] {
  const minSide = opts.minSide ?? 0.05;
  const dir = opts.dir ?? 'ltr';
  const base = analyseGrey(grey, w, h);
  let boxes: Box[] = [];
  if (base.uniform >= 0.55) {
    boxes = panelsFor(base, minSide);
  } else {
    // Art runs off the edge. It may still be several bleed panels divided by
    // white or black gutters; accept that only when it clearly is.
    for (const bg of [255, 0]) {
      const alt = analyseGrey(grey, w, h, bg);
      const found = panelsFor(alt, minSide);
      const covered = found.reduce((s, b) => s + boxArea(b), 0) / (w * h);
      if (found.length >= 2 && covered >= 0.6) {
        boxes = found;
        break;
      }
    }
    if (!boxes.length) return [WHOLE_PAGE];
  }
  if (!boxes.length) return [WHOLE_PAGE];
  if (boxes.length === 1 && boxArea(boxes[0]) >= 0.85 * w * h) return [WHOLE_PAGE];
  return orderFrames(boxes.map((b) => toRect(b, w, h)), dir);
}

/** Detect the reading frames of a page image. */
export async function detectFrames(input: Buffer | string, opts: DetectOptions = {}): Promise<RectFrame[]> {
  const { grey, w, h } = await loadGrey(input);
  return detectFromGrey(grey, w, h, opts);
}

// ---------------------------------------------------------------- reading order

/**
 * Reading order: rows top to bottom; inside a row, columns in the reading
 * direction; inside a column, rows again. Works on any frame list, so it is
 * also used to tidy hand-drawn frames.
 */
export function orderFrames<T extends Frame>(frames: T[], dir: ReadingDir = 'ltr'): T[] {
  const items = frames.map((f) => ({ f, b: frameBounds(f) }));
  type Item = (typeof items)[number];

  const split = (list: Item[], axis: 'x' | 'y'): Item[][] => {
    const lo = (i: Item) => (axis === 'y' ? i.b.y : i.b.x);
    const size = (i: Item) => (axis === 'y' ? i.b.h : i.b.w);
    const sorted = list.slice().sort((p, q) => lo(p) - lo(q));
    const groups: Item[][] = [];
    let cur: Item[] = [];
    let end = -Infinity;
    let minSize = Infinity;
    for (const it of sorted) {
      // Frames may overlap a little (slanted gutters, loose hand-drawn boxes).
      const slack = 0.15 * Math.min(size(it), minSize);
      if (cur.length && lo(it) >= end - slack) {
        groups.push(cur);
        cur = [];
        end = -Infinity;
        minSize = Infinity;
      }
      cur.push(it);
      end = Math.max(end, lo(it) + size(it));
      minSize = Math.min(minSize, size(it));
    }
    if (cur.length) groups.push(cur);
    if (axis === 'x' && dir === 'rtl') groups.reverse();
    return groups;
  };

  const walk = (list: Item[], axis: 'x' | 'y', failed: boolean): Item[] => {
    if (list.length <= 1) return list;
    const groups = split(list, axis);
    const other = axis === 'y' ? 'x' : 'y';
    if (groups.length > 1) return groups.flatMap((g) => walk(g, other, false));
    if (!failed) return walk(list, other, true);
    // No clean separation either way (pinwheels, overlaps): frames whose top
    // edges line up form a row, rows go top to bottom.
    const byTop = list.slice().sort((p, q) => p.b.y - q.b.y);
    const rows: Item[][] = [];
    for (const it of byTop) {
      const row = rows[rows.length - 1];
      if (row && it.b.y - row[0].b.y <= 0.25 * Math.min(row[0].b.h, it.b.h)) row.push(it);
      else rows.push([it]);
    }
    return rows.flatMap((row) => row.sort((p, q) => (dir === 'rtl' ? q.b.x + q.b.w - (p.b.x + p.b.w) : p.b.x - q.b.x)));
  };

  return walk(items, 'y', false).map((i) => i.f);
}

// ---------------------------------------------------------------- regions (smart frame, refine)

type Mask = Uint8Array;

function flood(w: number, h: number, start: number, pass: (i: number) => boolean): { mask: Mask; area: number } {
  const mask = new Uint8Array(w * h);
  const stack = new Int32Array(w * h);
  let sp = 0;
  let area = 0;
  if (!pass(start)) return { mask, area };
  mask[start] = 1;
  stack[sp++] = start;
  const n = w * h;
  while (sp) {
    const i = stack[--sp];
    area++;
    const x = i % w;
    const go = (j: number) => {
      if (!mask[j] && pass(j)) {
        mask[j] = 1;
        stack[sp++] = j;
      }
    };
    if (x > 0) go(i - 1);
    if (x < w - 1) go(i + 1);
    if (i >= w) go(i - w);
    if (i < n - w) go(i + w);
  }
  return { mask, area };
}

const toPixel = (a: { w: number; h: number }, x: number, y: number) =>
  Math.min(a.h - 1, Math.max(0, Math.floor(y * a.h))) * a.w + Math.min(a.w - 1, Math.max(0, Math.floor(x * a.w)));

/** The panel (non-gutter region) under a point, or null when the point is in a gutter. */
function panelAt(a: Analysis, x: number, y: number): { mask: Mask; area: number } | null {
  let i = toPixel(a, x, y);
  if (a.gutter[i]) {
    // Forgive a click a few pixels off the panel edge.
    const px = i % a.w;
    const py = (i - px) / a.w;
    let found = -1;
    for (let r = 1; r <= 4 && found < 0; r++) {
      for (let dy = -r; dy <= r && found < 0; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          const xx = px + dx;
          const yy = py + dy;
          if (xx < 0 || yy < 0 || xx >= a.w || yy >= a.h) continue;
          if (!a.gutter[yy * a.w + xx]) {
            found = yy * a.w + xx;
            break;
          }
        }
      }
    }
    if (found < 0) return null;
    i = found;
  }
  return flood(a.w, a.h, i, (j) => !a.gutter[j]);
}

/** Pixels of a similar tone connected to a point. */
function toneAt(a: Analysis, x: number, y: number, tolerance = 22): { mask: Mask; area: number } {
  const i = toPixel(a, x, y);
  const g = a.grey[i];
  return flood(a.w, a.h, i, (j) => Math.abs(a.grey[j] - g) <= tolerance);
}

function largestComponent(mask: Mask, w: number, h: number): { mask: Mask; area: number } {
  const seen = new Uint8Array(w * h);
  let best: { mask: Mask; area: number } = { mask: new Uint8Array(w * h), area: 0 };
  for (let i = 0; i < w * h; i++) {
    if (!mask[i] || seen[i]) continue;
    const c = flood(w, h, i, (j) => mask[j] === 1);
    for (let j = 0; j < w * h; j++) if (c.mask[j]) seen[j] = 1;
    if (c.area > best.area) best = c;
  }
  return best;
}

function countComponents(mask: Mask, w: number, h: number, minArea: number): number {
  const seen = new Uint8Array(w * h);
  let n = 0;
  for (let i = 0; i < w * h; i++) {
    if (!mask[i] || seen[i]) continue;
    const c = flood(w, h, i, (j) => mask[j] === 1);
    for (let j = 0; j < w * h; j++) if (c.mask[j]) seen[j] = 1;
    if (c.area >= minArea) n++;
  }
  return n;
}

/** Grow (`grow` true) or shrink a mask by `r` pixels with a square brush. */
function morph(mask: Mask, w: number, h: number, r: number, grow: boolean): Mask {
  const want = grow ? 1 : 0;
  const tmp = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let v = 1 - want;
      for (let k = Math.max(0, x - r); k <= Math.min(w - 1, x + r); k++) {
        if (mask[y * w + k] === want) {
          v = want;
          break;
        }
      }
      tmp[y * w + x] = v;
    }
  }
  const out = new Uint8Array(w * h);
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) {
      let v = 1 - want;
      for (let k = Math.max(0, y - r); k <= Math.min(h - 1, y + r); k++) {
        if (tmp[k * w + x] === want) {
          v = want;
          break;
        }
      }
      out[y * w + x] = v;
    }
  }
  return out;
}

/** Fill a frame into a pixel mask (even-odd scanline for polygons). */
export function rasterise(frame: Frame, w: number, h: number): Mask {
  const mask = new Uint8Array(w * h);
  if (!isPoly(frame)) {
    const x0 = Math.max(0, Math.round(frame.x * w));
    const x1 = Math.min(w, Math.round((frame.x + frame.w) * w));
    const y0 = Math.max(0, Math.round(frame.y * h));
    const y1 = Math.min(h, Math.round((frame.y + frame.h) * h));
    for (let y = y0; y < y1; y++) mask.fill(1, y * w + x0, y * w + x1);
    return mask;
  }
  const pts = frame.points.map(([x, y]) => [x * w, y * h]);
  for (let y = 0; y < h; y++) {
    const sy = y + 0.5;
    const xs: number[] = [];
    for (let i = 0; i < pts.length; i++) {
      const [ax, ay] = pts[i];
      const [bx, by] = pts[(i + 1) % pts.length];
      if (ay <= sy === by <= sy) continue;
      xs.push(ax + ((sy - ay) / (by - ay)) * (bx - ax));
    }
    xs.sort((p, q) => p - q);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const x0 = Math.max(0, Math.round(xs[k]));
      const x1 = Math.min(w, Math.round(xs[k + 1]));
      if (x1 > x0) mask.fill(1, y * w + x0, y * w + x1);
    }
  }
  return mask;
}

// Clockwise ring of the 8 neighbours, starting west.
const RING: [number, number][] = [[-1, 0], [-1, -1], [0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 1]];

/** Outline of the component whose top-left pixel is (sx, sy): Moore-neighbour tracing. */
function traceContour(mask: Mask, w: number, h: number, sx: number, sy: number): [number, number][] {
  const at = (x: number, y: number) => x >= 0 && y >= 0 && x < w && y < h && mask[y * w + x] === 1;
  const pts: [number, number][] = [[sx, sy]];
  let cx = sx;
  let cy = sy;
  let back = 0; // direction of the last background neighbour examined
  let second: [number, number] | null = null;
  for (let guard = 0; guard < 4 * w * h; guard++) {
    let found = -1;
    for (let k = 1; k <= 8; k++) {
      const d = (back + k) % 8;
      if (at(cx + RING[d][0], cy + RING[d][1])) {
        found = d;
        break;
      }
    }
    if (found < 0) break; // single pixel
    const nx = cx + RING[found][0];
    const ny = cy + RING[found][1];
    // New backtrack: the cell examined just before the hit, seen from the new pixel.
    const p = (found + 7) % 8;
    const bx = cx + RING[p][0] - nx;
    const by = cy + RING[p][1] - ny;
    back = RING.findIndex(([dx, dy]) => dx === bx && dy === by);
    if (back < 0) back = (found + 4) % 8;
    if (cx === sx && cy === sy && second && nx === second[0] && ny === second[1]) break;
    if (!second) second = [nx, ny];
    cx = nx;
    cy = ny;
    pts.push([cx, cy]);
  }
  if (pts.length > 1 && pts[pts.length - 1][0] === sx && pts[pts.length - 1][1] === sy) pts.pop();
  return pts;
}

/** Douglas-Peucker on a closed outline. */
function simplify(pts: [number, number][], eps: number): [number, number][] {
  if (pts.length <= 4) return pts;
  // Anchor on the two points farthest apart so the closed loop becomes two open runs.
  let far = 0;
  let fd = -1;
  for (let i = 1; i < pts.length; i++) {
    const d = (pts[i][0] - pts[0][0]) ** 2 + (pts[i][1] - pts[0][1]) ** 2;
    if (d > fd) {
      fd = d;
      far = i;
    }
  }
  const run = (from: number, to: number): [number, number][] => {
    const seg: [number, number][] = [];
    for (let i = from; ; i = (i + 1) % pts.length) {
      seg.push(pts[i]);
      if (i === to) break;
    }
    const keep = new Uint8Array(seg.length);
    keep[0] = keep[seg.length - 1] = 1;
    const todo: [number, number][] = [[0, seg.length - 1]];
    while (todo.length) {
      const [s, e] = todo.pop()!;
      const [ax, ay] = seg[s];
      const [bx, by] = seg[e];
      const len = Math.hypot(bx - ax, by - ay) || 1;
      let worst = -1;
      let wd = eps;
      for (let i = s + 1; i < e; i++) {
        const d = Math.abs((bx - ax) * (ay - seg[i][1]) - (ax - seg[i][0]) * (by - ay)) / len;
        if (d > wd) {
          wd = d;
          worst = i;
        }
      }
      if (worst > 0) {
        keep[worst] = 1;
        todo.push([s, worst], [worst, e]);
      }
    }
    return seg.filter((_p, i) => keep[i]);
  };
  const a = run(0, far);
  const b = run(far, 0);
  return [...a.slice(0, -1), ...b.slice(0, -1)];
}

/** A region as a frame: a rectangle when it nearly fills its bounding box, otherwise its outline. */
function maskToFrame(mask: Mask, w: number, h: number): Frame | null {
  let x0 = w, y0 = h, x1 = -1, y1 = -1, area = 0;
  let sx = -1, sy = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!mask[y * w + x]) continue;
      area++;
      if (sx < 0) {
        sx = x;
        sy = y;
      }
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  if (!area) return null;
  const bw = x1 - x0 + 1;
  const bh = y1 - y0 + 1;
  if (area >= 0.93 * bw * bh) return normaliseFrame({ x: x0 / w, y: y0 / h, w: bw / w, h: bh / h });
  const outline = simplify(traceContour(mask, w, h, sx, sy), Math.max(1.5, Math.max(w, h) * 0.004));
  if (outline.length < 3) return normaliseFrame({ x: x0 / w, y: y0 / h, w: bw / w, h: bh / h });
  // Pixel centres, pushed out to the pixel's outer edge where it lies on the bounding box.
  const edge = (v: number, lo: number, hi: number, size: number) => (v === lo ? v : v === hi ? v + 1 : v + 0.5) / size;
  return normaliseFrame({ points: outline.map(([x, y]) => [edge(x, x0, x1, w), edge(y, y0, y1, h)] as [number, number]) });
}

/** Smart frame: the panel containing a point, snapped to its gutters. Null when the point is in a gutter. */
export function smartFrame(a: Analysis, x: number, y: number): Frame | null {
  if (a.uniform < 0.55) {
    // Full-bleed page: only split it if white or black gutters really divide it.
    for (const bg of [255, 0]) {
      const alt = analyseGrey(a.grey, a.w, a.h, bg);
      const p = panelAt(alt, x, y);
      if (p && p.area < 0.85 * a.w * a.h && p.area > 0.002 * a.w * a.h) return maskToFrame(p.mask, a.w, a.h);
    }
    return WHOLE_PAGE;
  }
  const p = panelAt(a, x, y);
  if (!p) return null;
  return maskToFrame(p.mask, a.w, a.h);
}

export class RefineError extends Error {}

/**
 * Refine a frame at a point.
 *  add:    the panel under the point (or, in a gutter, nothing) is merged into the frame;
 *          a gutter between the two is bridged.
 *  remove: the panel under the point is cut out of the frame. When the frame is
 *          a single panel, the patch of similar tone under the point is cut instead.
 */
export function refineFrame(a: Analysis, frame: Frame, x: number, y: number, mode: 'add' | 'remove'): Frame {
  const { w, h } = a;
  const n = w * h;
  const cur = rasterise(frame, w, h);
  let curArea = 0;
  for (let i = 0; i < n; i++) curArea += cur[i];
  if (!curArea) throw new RefineError('That frame is empty');
  const click = toPixel(a, x, y);

  if (mode === 'add') {
    let region = panelAt(a, x, y);
    if (!region || region.area > 0.97 * n) {
      const tone = toneAt(a, x, y);
      region = a.gutter[click] || tone.area > 0.5 * n ? null : tone;
    }
    if (!region) throw new RefineError('Click on artwork outside the frame to add it');
    let out: Mask = new Uint8Array(n);
    for (let i = 0; i < n; i++) out[i] = cur[i] | region.mask[i];
    if (countComponents(out, w, h, 12) > 1) {
      const r = Math.ceil(Math.max(w, h) * 0.02);
      out = morph(morph(out, w, h, r, true), w, h, r, false);
    }
    const f = maskToFrame(largestComponent(out, w, h).mask, w, h);
    if (!f) throw new RefineError('Nothing to add at that point');
    return f;
  }

  if (!cur[click]) throw new RefineError('Click inside the frame on the part to remove');
  const inside = (m: Mask) => {
    let c = 0;
    for (let i = 0; i < n; i++) c += m[i] & cur[i];
    return c;
  };
  let region: Mask | null = panelAt(a, x, y)?.mask ?? null;
  if (!region || inside(region) > 0.9 * curArea) region = toneAt(a, x, y).mask;
  if (inside(region) > 0.9 * curArea) throw new RefineError('That would remove the whole frame. Delete the frame instead.');
  // The gutter alongside the removed part goes with it.
  const reach = morph(region, w, h, Math.ceil(Math.max(w, h) * 0.04), true);
  let out: Mask = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = cur[i] & (region[i] ^ 1) & ((reach[i] & a.gutter[i]) ^ 1);
  // Shave off slivers left along the cut.
  const r = Math.max(1, Math.round(Math.max(w, h) * 0.004));
  out = morph(morph(out, w, h, r, false), w, h, r, true);
  const f = maskToFrame(largestComponent(out, w, h).mask, w, h);
  if (!f) throw new RefineError('That would remove the whole frame. Delete the frame instead.');
  return f;
}
