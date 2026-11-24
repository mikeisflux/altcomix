import assert from 'node:assert/strict';
import { test } from 'node:test';
import sharp from 'sharp';
import { analysePage, detectFrames, frameBounds, isPoly, orderFrames, refineFrame, smartFrame } from './panels.ts';
import type { Frame, RectFrame } from './panels.ts';

/** A synthetic comic page: panels are [x, y, w, h] in page fractions. */
type Panel = [number, number, number, number];
const COLOURS = ['#c0392b', '#2980b9', '#27ae60', '#8e44ad', '#d35400', '#16a085', '#7f8c8d', '#f39c12'];

async function page(panels: Panel[], opts: { w?: number; h?: number; gutter?: string; outlined?: boolean; jpeg?: boolean } = {}): Promise<Buffer> {
  const w = opts.w ?? 1000;
  const h = opts.h ?? 1500;
  const shapes = panels
    .map(([x, y, pw, ph], i) => {
      const px = Math.round(x * w), py = Math.round(y * h), ww = Math.round(pw * w), hh = Math.round(ph * h);
      if (opts.outlined) {
        // White panel with a black border and a little line art inside.
        return `<rect x="${px + 3}" y="${py + 3}" width="${ww - 6}" height="${hh - 6}" fill="#ffffff" stroke="#000000" stroke-width="6"/>
                <circle cx="${px + ww / 2}" cy="${py + hh / 2}" r="${Math.min(ww, hh) / 5}" fill="none" stroke="#222" stroke-width="5"/>`;
      }
      return `<rect x="${px}" y="${py}" width="${ww}" height="${hh}" fill="${COLOURS[i % COLOURS.length]}"/>
              <circle cx="${px + ww * 0.35}" cy="${py + hh * 0.45}" r="${Math.min(ww, hh) / 6}" fill="#f5e6c8"/>
              <rect x="${px + ww * 0.55}" y="${py + hh * 0.2}" width="${ww * 0.3}" height="${hh * 0.12}" rx="8" fill="#ffffff"/>`;
    })
    .join('');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="100%" height="100%" fill="${opts.gutter ?? '#ffffff'}"/>${shapes}</svg>`;
  const img = sharp(Buffer.from(svg));
  return opts.jpeg ? img.jpeg({ quality: 80 }).toBuffer() : img.png().toBuffer();
}

const TOL = 0.012;
function assertRect(actual: Frame, expected: Panel, label: string) {
  const b = frameBounds(actual);
  const got = [b.x, b.y, b.w, b.h];
  for (let i = 0; i < 4; i++) {
    assert.ok(Math.abs(got[i] - expected[i]) <= TOL, `${label}: expected ${expected.join(', ')} but got ${got.map((v) => v.toFixed(3)).join(', ')}`);
  }
}
function assertPanels(actual: Frame[], expected: Panel[]) {
  assert.equal(actual.length, expected.length, `expected ${expected.length} frames, got ${JSON.stringify(actual)}`);
  expected.forEach((e, i) => assertRect(actual[i], e, `frame ${i + 1}`));
}

const GRID_2X2: Panel[] = [
  [0.05, 0.04, 0.435, 0.445], [0.515, 0.04, 0.435, 0.445],
  [0.05, 0.515, 0.435, 0.445], [0.515, 0.515, 0.435, 0.445],
];

test('2x2 grid on white gutters, reading order left to right', async () => {
  assertPanels(await detectFrames(await page(GRID_2X2)), GRID_2X2);
});

test('same grid read right to left', async () => {
  const frames = await detectFrames(await page(GRID_2X2), { dir: 'rtl' });
  assertPanels(frames, [GRID_2X2[1], GRID_2X2[0], GRID_2X2[3], GRID_2X2[2]]);
});

test('uneven rows: 1 wide, 3 across, 2 across of different widths', async () => {
  const panels: Panel[] = [
    [0.05, 0.04, 0.9, 0.25],
    [0.05, 0.32, 0.28, 0.3], [0.36, 0.32, 0.28, 0.3], [0.67, 0.32, 0.28, 0.3],
    [0.05, 0.65, 0.55, 0.31], [0.63, 0.65, 0.32, 0.31],
  ];
  assertPanels(await detectFrames(await page(panels)), panels);
});

test('black gutters', async () => {
  const panels: Panel[] = [
    [0.04, 0.03, 0.92, 0.3],
    [0.04, 0.36, 0.44, 0.3], [0.52, 0.36, 0.44, 0.3],
    [0.04, 0.69, 0.92, 0.28],
  ];
  assertPanels(await detectFrames(await page(panels, { gutter: '#000000' })), panels);
});

test('JPEG noise and a narrow gutter still split', async () => {
  const panels: Panel[] = [[0.05, 0.05, 0.9, 0.44], [0.05, 0.505, 0.9, 0.445]];
  assertPanels(await detectFrames(await page(panels, { jpeg: true })), panels);
});

test('outlined white panels (line art on white) are found by their borders', async () => {
  const panels: Panel[] = [[0.06, 0.05, 0.88, 0.28], [0.06, 0.37, 0.42, 0.57], [0.52, 0.37, 0.42, 0.57]];
  assertPanels(await detectFrames(await page(panels, { outlined: true })), panels);
});

test('a tall panel beside two stacked ones (column first, then rows)', async () => {
  const panels: Panel[] = [[0.05, 0.05, 0.4, 0.9], [0.5, 0.05, 0.45, 0.43], [0.5, 0.52, 0.45, 0.43]];
  assertPanels(await detectFrames(await page(panels)), panels);
  // Right to left: the right-hand column is read first.
  assertPanels(await detectFrames(await page(panels), { dir: 'rtl' }), [panels[1], panels[2], panels[0]]);
});

test('pinwheel layout that no straight cut can split falls back to connected regions', async () => {
  const panels: Panel[] = [
    [0.05, 0.05, 0.55, 0.25], // top, wide
    [0.65, 0.05, 0.3, 0.55], // right, tall
    [0.05, 0.35, 0.25, 0.6], // left, tall
    [0.35, 0.35, 0.25, 0.25], // centre
    [0.35, 0.65, 0.6, 0.3], // bottom, wide
  ];
  const frames = await detectFrames(await page(panels));
  assert.equal(frames.length, 5);
  for (const p of panels) {
    assert.ok(frames.some((f) => [f.x - p[0], f.y - p[1], f.w - p[2], f.h - p[3]].every((d) => Math.abs(d) <= TOL)), `missing panel ${p.join(', ')}`);
  }
  // First frame is the top-left one, last is the bottom one.
  assertRect(frames[0], panels[0], 'first frame');
});

test('page number and other small marks in the margin are ignored', async () => {
  const w = 1000, h = 1500;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="100%" height="100%" fill="#fff"/>
    <rect x="60" y="60" width="880" height="640" fill="#2980b9"/><rect x="60" y="740" width="880" height="640" fill="#c0392b"/>
    <rect x="480" y="1430" width="40" height="22" fill="#111"/></svg>`;
  const frames = await detectFrames(await sharp(Buffer.from(svg)).png().toBuffer());
  assertPanels(frames, [[0.06, 0.04, 0.88, 0.4267], [0.06, 0.4933, 0.88, 0.4267]]);
});

test('full-bleed art is one frame covering the page', async () => {
  const w = 800, h = 1200;
  const raw = Buffer.alloc(w * h * 3);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 3;
      raw[i] = (x * 255) / w;
      raw[i + 1] = 128 + 100 * Math.sin((x + y) / 37);
      raw[i + 2] = (y * 255) / h;
    }
  }
  const img = await sharp(raw, { raw: { width: w, height: h, channels: 3 } }).png().toBuffer();
  assert.deepEqual(await detectFrames(img), [{ x: 0, y: 0, w: 1, h: 1 }]);
});

test('a single splash panel with margins is one frame', async () => {
  const frames = await detectFrames(await page([[0.06, 0.05, 0.88, 0.9]]));
  assertPanels(frames, [[0.06, 0.05, 0.88, 0.9]]);
});

test('bleed panels divided only by white gutters are still split', async () => {
  const panels: Panel[] = [[0, 0, 1, 0.48], [0, 0.52, 0.48, 0.48], [0.52, 0.52, 0.48, 0.48]];
  assertPanels(await detectFrames(await page(panels)), panels);
});

test('smart frame snaps to the panel under the click, and reports gutters', async () => {
  const a = await analysePage(await page(GRID_2X2));
  const hit = smartFrame(a, 0.75, 0.75);
  assert.ok(hit && !isPoly(hit));
  assertRect(hit, GRID_2X2[3], 'smart frame');
  assert.equal(smartFrame(a, 0.5, 0.5), null, 'the centre of the page is a gutter');
  // A click a hair outside the panel edge is forgiven.
  const near = smartFrame(a, 0.05 - 0.003, 0.2);
  assert.ok(near);
  assertRect(near, GRID_2X2[0], 'near-edge click');
});

test('smart frame traces a non-rectangular panel as a polygon', async () => {
  const w = 1000, h = 1000;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="100%" height="100%" fill="#fff"/>
    <polygon points="50,50 950,50 950,400 50,600" fill="#2980b9"/><polygon points="50,650 950,450 950,950 50,950" fill="#c0392b"/></svg>`;
  const a = await analysePage(await sharp(Buffer.from(svg)).png().toBuffer());
  const top = smartFrame(a, 0.3, 0.2);
  assert.ok(top && isPoly(top), 'slanted panel should come back as a polygon');
  const b = frameBounds(top);
  assertRect({ x: b.x, y: b.y, w: b.w, h: b.h }, [0.05, 0.05, 0.9, 0.55], 'polygon bounds');
  assert.ok(top.points.length >= 4 && top.points.length <= 12, `outline should be simple, got ${top.points.length} points`);
  // The slanted bottom edge: a point under the slope on the left is outside the frame.
  const lowRight = top.points.some(([x, y]) => x > 0.9 && Math.abs(y - 0.4) < 0.03);
  const lowLeft = top.points.some(([x, y]) => x < 0.1 && Math.abs(y - 0.6) < 0.03);
  assert.ok(lowRight && lowLeft, `expected corners near (0.95, 0.4) and (0.05, 0.6): ${JSON.stringify(top.points)}`);
});

test('refine: add merges the neighbouring panel across the gutter, remove cuts it back', async () => {
  const a = await analysePage(await page(GRID_2X2));
  const start: RectFrame = { x: 0.05, y: 0.04, w: 0.435, h: 0.445 };
  const grown = refineFrame(a, start, 0.75, 0.25, 'add');
  assertRect(grown, [0.05, 0.04, 0.9, 0.445], 'after add');
  const cut = refineFrame(a, grown, 0.75, 0.25, 'remove');
  assertRect(cut, GRID_2X2[0], 'after remove');
  assert.throws(() => refineFrame(a, start, 0.5, 0.5, 'add'), /artwork/);
  assert.throws(() => refineFrame(a, start, 0.9, 0.9, 'remove'), /inside the frame/);
});

test('orderFrames: rows first, then reading direction; works for hand-drawn frames', () => {
  const f = (x: number, y: number, w: number, h: number): RectFrame => ({ x, y, w, h });
  const a = f(0.05, 0.05, 0.4, 0.3), b = f(0.55, 0.06, 0.4, 0.3), c = f(0.05, 0.4, 0.9, 0.25), d = f(0.05, 0.7, 0.25, 0.25), e = f(0.35, 0.7, 0.6, 0.25);
  assert.deepEqual(orderFrames([e, c, b, d, a]), [a, b, c, d, e]);
  assert.deepEqual(orderFrames([e, c, b, d, a], 'rtl'), [b, a, c, e, d]);
  const poly = { points: [[0.5, 0.05], [0.95, 0.05], [0.95, 0.3]] as [number, number][] };
  assert.deepEqual(orderFrames<Frame>([poly, a]), [a, poly]);
});
