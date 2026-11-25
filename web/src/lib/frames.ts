/**
 * Reading frames. A frame is a region of a page in fractions of the page
 * (0..1), either a rectangle or a polygon. Shared by the reader's guided view
 * and the Studio frame editor.
 */
export type RectFrame = { x: number; y: number; w: number; h: number };
export type PolyFrame = { points: [number, number][] };
export type Frame = RectFrame | PolyFrame;

export const isPoly = (f: Frame): f is PolyFrame => 'points' in f;

export function bounds(f: Frame): RectFrame {
  if (!isPoly(f)) return f;
  const xs = f.points.map((p) => p[0]);
  const ys = f.points.map((p) => p[1]);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
}

const pct = (n: number) => `${(n * 100).toFixed(3)}%`;

/** CSS clip-path that shows only this frame of a page element. */
export function clipPath(f: Frame): string {
  if (isPoly(f)) return `polygon(${f.points.map(([x, y]) => `${pct(x)} ${pct(y)}`).join(', ')})`;
  // Expressed as a polygon too, so rect <-> polygon transitions can interpolate when point counts match.
  return `polygon(${pct(f.x)} ${pct(f.y)}, ${pct(f.x + f.w)} ${pct(f.y)}, ${pct(f.x + f.w)} ${pct(f.y + f.h)}, ${pct(f.x)} ${pct(f.y + f.h)})`;
}

export const WHOLE_PAGE: RectFrame = { x: 0, y: 0, w: 1, h: 1 };

export type Fit = { width: number; height: number; left: number; top: number };

/**
 * Size and position a page so that `frame` fills the viewport as much as
 * possible while staying entirely visible.
 *
 * @param aspect  page width / page height
 * @param maxZoom cap on page width relative to the viewport width, so a tiny
 *                frame never blows the artwork up into mush
 */
export function fitFrame(frame: Frame, aspect: number, viewW: number, viewH: number, pad = 0, maxZoom = 5): Fit {
  const b = bounds(frame);
  const availW = Math.max(1, viewW - pad * 2);
  const availH = Math.max(1, viewH - pad * 2);
  const fw = Math.max(b.w, 0.02);
  const fh = Math.max(b.h, 0.02);
  let width = Math.min(availW / fw, (availH * aspect) / fh);
  width = Math.min(width, viewW * maxZoom);
  const height = width / aspect;
  return {
    width,
    height,
    left: viewW / 2 - (b.x + b.w / 2) * width,
    top: viewH / 2 - (b.y + b.h / 2) * height,
  };
}

export function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

/** Keep a rectangle inside the page and above a minimum size. */
export function normalizeRect(r: RectFrame, min = 0.01): RectFrame {
  let { x, y, w, h } = r;
  if (w < 0) { x += w; w = -w; }
  if (h < 0) { y += h; h = -h; }
  x = clamp(x, 0, 1 - min);
  y = clamp(y, 0, 1 - min);
  w = clamp(w, min, 1 - x);
  h = clamp(h, min, 1 - y);
  return { x, y, w, h };
}

export function pointInFrame(f: Frame, px: number, py: number): boolean {
  if (!isPoly(f)) return px >= f.x && px <= f.x + f.w && py >= f.y && py <= f.y + f.h;
  let inside = false;
  const pts = f.points;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i];
    const [xj, yj] = pts[j];
    if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export function area(f: Frame): number {
  if (!isPoly(f)) return f.w * f.h;
  let a = 0;
  for (let i = 0, j = f.points.length - 1; i < f.points.length; j = i++) a += (f.points[j][0] + f.points[i][0]) * (f.points[j][1] - f.points[i][1]);
  return Math.abs(a / 2);
}
