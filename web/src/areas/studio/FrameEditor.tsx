import {
  Check, ChevronDown, ChevronUp, GripVertical, Hand, Maximize2, Minus, MousePointer2, PenTool, Plus, Redo2, ScanSearch, Square, SquareDashedMousePointer,
  SquareMinus, SquarePlus, Trash2, Undo2, Wand2, X,
} from 'lucide-react';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { bounds, clamp, isPoly, normalizeRect, pointInFrame } from '@/lib/frames';
import type { Frame, RectFrame } from '@/lib/frames';
import { Button, IconButton, Spinner, cx, toast } from '@/ui';
import { errorMessage } from '@/lib/api';

/**
 * Frame editor for one page. Frames are the stops of the guided reader: the
 * order in the list is the reading order.
 *
 * Tools (keyboard shortcut):
 *   Select (V)   pick, move, resize; drag polygon points
 *   Pan (H)      drag the page; Space-drag works in any tool
 *   Rectangle (F) drag a box
 *   Points (P)   click each corner, Enter or click the first point to finish
 *   Smart (S)    click inside a panel and it snaps to the panel border
 *   Add (D) / Remove (R)  click to grow or cut the selected frame
 *
 * The component is controlled: it calls `onChange` with the full ordered list
 * after every edit and keeps its own undo history.
 */
export type Tool = 'select' | 'pan' | 'rect' | 'poly' | 'smart' | 'add' | 'remove';

type Props = {
  imageUrl: string;
  /** Natural page size in pixels (only the ratio matters). */
  pageWidth: number;
  pageHeight: number;
  frames: Frame[];
  onChange: (frames: Frame[]) => void;
  background: string;
  onBackgroundChange: (hex: string) => void;
  /** Ask the server to detect every frame on this page. */
  onDetect: () => Promise<Frame[]>;
  /** Panel containing the clicked point (fractions), or null if none found. */
  onSmartFrame: (x: number, y: number) => Promise<Frame | null>;
  /** Grow or cut `frame` at the clicked point. */
  onRefine: (frame: Frame, x: number, y: number, mode: 'add' | 'remove') => Promise<Frame>;
  /** Extra controls rendered at the right of the toolbar row (Preview, Save state ...). */
  actions?: ReactNode;
  rtl?: boolean;
  /** Look but do not touch (analyst role). */
  readOnly?: boolean;
};

type Drag =
  | { kind: 'pan'; lx: number; ly: number }
  | { kind: 'draw'; x0: number; y0: number; x1: number; y1: number }
  | { kind: 'move'; index: number; start: Frame; px: number; py: number }
  | { kind: 'handle'; index: number; start: RectFrame; hx: -1 | 0 | 1; hy: -1 | 0 | 1; px: number; py: number }
  | { kind: 'vertex'; index: number; vertex: number };

const TOOLS: { id: Tool; label: string; key: string; icon: ReactNode; needsSelection?: boolean }[] = [
  { id: 'select', label: 'Select and edit', key: 'V', icon: <MousePointer2 className="size-[18px]" /> },
  { id: 'pan', label: 'Move the page', key: 'H', icon: <Hand className="size-[18px]" /> },
  { id: 'rect', label: 'Draw a rectangle frame', key: 'F', icon: <Square className="size-[18px]" /> },
  { id: 'poly', label: 'Draw a frame point by point', key: 'P', icon: <PenTool className="size-[18px]" /> },
  { id: 'smart', label: 'Smart frame: click inside a panel', key: 'S', icon: <SquareDashedMousePointer className="size-[18px]" /> },
  { id: 'add', label: 'Add to the selected frame', key: 'D', icon: <SquarePlus className="size-[18px]" />, needsSelection: true },
  { id: 'remove', label: 'Remove from the selected frame', key: 'R', icon: <SquareMinus className="size-[18px]" />, needsSelection: true },
];

const HINT: Record<Tool, string> = {
  select: 'Click a frame to select it. Drag it to move, drag a corner, edge or point to reshape.',
  pan: 'Drag to move the page. Scroll to zoom.',
  rect: 'Drag a box around a panel.',
  poly: 'Click each corner of the panel. Press Enter or click the first point to finish.',
  smart: 'Click inside a panel and the frame snaps to its border.',
  add: 'Click an area next to the selected frame to add it.',
  remove: 'Click an area inside the selected frame to cut it away.',
};

export function FrameEditor(props: Props) {
  const { imageUrl, pageWidth, pageHeight, frames, onChange, background, onBackgroundChange, onDetect, onSmartFrame, onRefine, actions, rtl, readOnly } = props;
  const aspect = pageWidth / pageHeight;

  const [tool, setTool] = useState<Tool>('select');
  const [selected, setSelected] = useState<number | null>(null);
  const [draft, setDraft] = useState<[number, number][]>([]); // polygon in progress
  const [cursor, setCursor] = useState<[number, number] | null>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [spaceDown, setSpaceDown] = useState(false);
  const liveFrames = useRef<Frame[] | null>(null); // frames while one is being dragged
  // The drag in progress, readable at once (pointer events can arrive before the next render),
  // and the one pointer that owns it (a second finger or a stray button must not interfere).
  const dragRef = useRef<Drag | null>(null);
  const dragPointer = useRef<number | null>(null);
  const beginDrag = (d: Drag, pointerId: number) => {
    dragRef.current = d;
    dragPointer.current = pointerId;
    setDrag(d);
  };
  const [hot, setHot] = useState<string | null>(null); // node under the pointer: "h:-1:1" or "v:3"

  // View: zoom 1 = page fits the stage.
  const stage = useRef<HTMLDivElement>(null);
  const [stageSize, setStageSize] = useState({ w: 0, h: 0 });
  const [view, setView] = useState({ zoom: 1, x: 0, y: 0 });
  useLayoutEffect(() => {
    const el = stage.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setStageSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    setStageSize({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);
  const pad = 24;
  const fitW = Math.max(50, Math.min(stageSize.w - pad * 2, (stageSize.h - pad * 2) * aspect));
  const pageW = fitW * view.zoom;
  const pageH = pageW / aspect;
  const left = (stageSize.w - pageW) / 2 + view.x;
  const top = (stageSize.h - pageH) / 2 + view.y;

  // The newest frames, for tools that answer after a server round trip.
  const framesRef = useRef(frames);
  framesRef.current = frames;

  // History.
  const past = useRef<Frame[][]>([]);
  const future = useRef<Frame[][]>([]);
  const [, bump] = useState(0);
  const commit = useCallback(
    (next: Frame[], selectIndex?: number | null) => {
      if (readOnly) return;
      past.current.push(frames);
      if (past.current.length > 100) past.current.shift();
      future.current = [];
      onChange(next);
      if (selectIndex !== undefined) setSelected(selectIndex);
      bump((n) => n + 1);
    },
    [frames, onChange, readOnly],
  );
  const undo = useCallback(() => {
    const prev = past.current.pop();
    if (!prev) return;
    future.current.push(frames);
    onChange(prev);
    setSelected(null);
    bump((n) => n + 1);
  }, [frames, onChange]);
  const redo = useCallback(() => {
    const next = future.current.pop();
    if (!next) return;
    past.current.push(frames);
    onChange(next);
    setSelected(null);
    bump((n) => n + 1);
  }, [frames, onChange]);

  // New page: reset transient state.
  useEffect(() => {
    past.current = [];
    future.current = [];
    setSelected(null);
    setDraft([]);
    setView({ zoom: 1, x: 0, y: 0 });
  }, [imageUrl]);

  // "Add to" and "Remove from" work on the selected frame. When the selection goes away
  // (delete, undo, a new page), go back to Select instead of leaving a tool that cannot do anything.
  useEffect(() => {
    if (selected === null && (tool === 'add' || tool === 'remove')) setTool('select');
  }, [selected, tool]);

  const toPage = (clientX: number, clientY: number): [number, number] => {
    const r = stage.current?.getBoundingClientRect();
    if (!r) return [-1, -1];
    return [(clientX - r.left - left) / Math.max(1, pageW), (clientY - r.top - top) / Math.max(1, pageH)];
  };
  const inPage = ([x, y]: [number, number]) => x >= 0 && x <= 1 && y >= 0 && y <= 1;
  /** A point just outside the page edge counts as on the edge (panels often run to it); farther out is a miss. */
  const snapToPage = ([x, y]: [number, number], slackPx = 24): [number, number] | null => {
    const sx = slackPx / Math.max(1, pageW);
    const sy = slackPx / Math.max(1, pageH);
    if (x < -sx || x > 1 + sx || y < -sy || y > 1 + sy) return null;
    return [clamp(x, 0, 1), clamp(y, 0, 1)];
  };

  /** Keep part of the page on screen whatever the zoom and however far it is dragged. */
  const clampView = useCallback(
    (v: { zoom: number; x: number; y: number }) => {
      if (!stageSize.w || !stageSize.h) return v;
      const w = fitW * v.zoom;
      const h = w / aspect;
      const keep = 96;
      const maxX = Math.max(0, (stageSize.w + w) / 2 - keep);
      const maxY = Math.max(0, (stageSize.h + h) / 2 - keep);
      return { zoom: v.zoom, x: clamp(v.x, -maxX, maxX), y: clamp(v.y, -maxY, maxY) };
    },
    [stageSize.w, stageSize.h, fitW, aspect],
  );
  // The stage changed size (window resized, side panel opened): bring the page back if it fell out of view.
  useEffect(() => {
    setView((v) => {
      const c = clampView(v);
      return c.x === v.x && c.y === v.y ? v : c;
    });
  }, [clampView]);

  const zoomBy = (factor: number, at?: { x: number; y: number }) => {
    setView((v) => {
      const zoom = clamp(v.zoom * factor, 0.4, 8);
      if (!at) return clampView({ ...v, zoom });
      // Keep the point under the cursor fixed.
      const cx0 = at.x - stageSize.w / 2 - v.x;
      const cy0 = at.y - stageSize.h / 2 - v.y;
      const k = zoom / v.zoom;
      return clampView({ zoom, x: v.x - cx0 * (k - 1), y: v.y - cy0 * (k - 1) });
    });
  };

  const finishPolygon = useCallback(() => {
    if (draft.length >= 3) commit([...frames, { points: draft.map(([x, y]) => [clamp(x, 0, 1), clamp(y, 0, 1)] as [number, number]) }], frames.length);
    setDraft([]);
  }, [draft, frames, commit]);

  /** Drop whatever drag is under way without applying it. */
  const cancelDrag = useCallback(() => {
    const id = dragPointer.current;
    if (id !== null) {
      try {
        stage.current?.releasePointerCapture(id);
      } catch {
        // the pointer is already gone
      }
    }
    dragRef.current = null;
    dragPointer.current = null;
    liveFrames.current = null;
    setDrag(null);
  }, []);

  /**
   * Switch tools. Any drag under way is ended first. A point-by-point shape in
   * progress is kept while you go to the Hand tool and back (moving the page
   * mid-shape is normal); switching to any other tool closes it: kept when it
   * has three or more points, dropped otherwise.
   */
  const chooseTool = useCallback(
    (next: Tool) => {
      cancelDrag();
      if (next !== 'poly' && next !== 'pan' && draft.length) finishPolygon();
      setHot(null);
      setTool(next);
    },
    [draft.length, finishPolygon, cancelDrag],
  );

  const removeFrame = useCallback(
    (i: number) => {
      commit(frames.filter((_, j) => j !== i), null);
    },
    [frames, commit],
  );

  const run = async (label: string, fn: () => Promise<void>) => {
    setBusy(label);
    try {
      await fn();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  const detect = () =>
    run('detect', async () => {
      const found = await onDetect();
      if (!found.length) {
        toast.info('No panel borders found on this page. Draw the frames by hand.');
        return;
      }
      commit(found, null);
      toast.success(`${found.length} frame${found.length === 1 ? '' : 's'} detected. Check the order, then move on.`);
    });

  /** How close (in screen pixels) a press must be to a node to grab it: generous, and more so for fingers. */
  const grabRadius = (pointerType: string) => (pointerType === 'mouse' ? 14 : 26);

  /**
   * The resize handle or corner point of the selected frame nearest to a press, if one is
   * within reach. Done by distance rather than by hitting the small drawn square, so a node
   * can be grabbed without pixel-perfect aim. Rectangles can also be grabbed anywhere along an edge.
   */
  const nodeAt = (clientX: number, clientY: number, pointerType: string):
    | { kind: 'handle'; hx: -1 | 0 | 1; hy: -1 | 0 | 1 }
    | { kind: 'vertex'; vertex: number }
    | null => {
    if (selected === null || readOnly) return null;
    const f = frames[selected];
    const r = stage.current?.getBoundingClientRect();
    if (!f || !r) return null;
    const mx = clientX - r.left - left;
    const my = clientY - r.top - top;
    const reach = grabRadius(pointerType);
    if (isPoly(f)) {
      let best = -1;
      let bestD = reach;
      f.points.forEach(([x, y], i) => {
        const d = Math.hypot(x * pageW - mx, y * pageH - my);
        if (d <= bestD) {
          best = i;
          bestD = d;
        }
      });
      return best >= 0 ? { kind: 'vertex', vertex: best } : null;
    }
    const x0 = f.x * pageW;
    const y0 = f.y * pageH;
    const x1 = (f.x + f.w) * pageW;
    const y1 = (f.y + f.h) * pageH;
    let found: { hx: -1 | 0 | 1; hy: -1 | 0 | 1 } | null = null;
    let bestD = reach;
    for (const hx of [-1, 0, 1] as const) {
      for (const hy of [-1, 0, 1] as const) {
        if (hx === 0 && hy === 0) continue;
        const d = Math.hypot(x0 + ((x1 - x0) * (hx + 1)) / 2 - mx, y0 + ((y1 - y0) * (hy + 1)) / 2 - my);
        if (d <= bestD) {
          found = { hx, hy };
          bestD = d;
        }
      }
    }
    if (found) return { kind: 'handle', ...found };
    // Anywhere along an edge resizes that edge.
    const edge = pointerType === 'mouse' ? 6 : 14;
    const withinX = mx >= x0 - edge && mx <= x1 + edge;
    const withinY = my >= y0 - edge && my <= y1 + edge;
    if (withinY && Math.abs(mx - x0) <= edge) return { kind: 'handle', hx: -1, hy: 0 };
    if (withinY && Math.abs(mx - x1) <= edge) return { kind: 'handle', hx: 1, hy: 0 };
    if (withinX && Math.abs(my - y0) <= edge) return { kind: 'handle', hx: 0, hy: -1 };
    if (withinX && Math.abs(my - y1) <= edge) return { kind: 'handle', hx: 0, hy: 1 };
    return null;
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0 && e.button !== 1) return;
    // One drag at a time: a second finger, or another button pressed mid-drag, is ignored.
    if (dragRef.current) return;
    if (e.button === 1) e.preventDefault(); // no browser auto-scroll on middle click
    const el = e.currentTarget as HTMLElement;
    const capture = () => {
      try {
        el.setPointerCapture(e.pointerId);
      } catch {
        // Capture can be refused (pointer already released). The window-level listeners below still end the drag.
      }
    };
    const p = toPage(e.clientX, e.clientY);
    const active: Tool = spaceDown || e.button === 1 ? 'pan' : tool;

    if (active === 'pan') {
      capture();
      return beginDrag({ kind: 'pan', lx: e.clientX, ly: e.clientY }, e.pointerId);
    }

    if (active === 'rect') {
      const q = snapToPage(p);
      if (!q || readOnly) return;
      capture();
      return beginDrag({ kind: 'draw', x0: q[0], y0: q[1], x1: q[0], y1: q[1] }, e.pointerId);
    }

    if (active === 'poly') {
      const q = snapToPage(p);
      if (!q || readOnly) return;
      const dist = (a: [number, number]) => Math.hypot((q[0] - a[0]) * pageW, (q[1] - a[1]) * pageH);
      // Clicking the first point (the larger dot) closes the shape. The target is kept small so an
      // outline that passes close to where it began is not closed by accident.
      if (draft.length >= 3 && dist(draft[0]) < (e.pointerType === 'mouse' ? 9 : 18)) return finishPolygon();
      // A double-click on the spot just placed closes the shape instead of stacking a second point there.
      // It has to be the very same spot (within 2 pixels): quick clicks a few pixels apart, as when
      // tracing an outline, are ordinary points, and there is no limit on how many a shape can have.
      if (e.detail >= 2 && draft.length && dist(draft[draft.length - 1]) < 2) return void (draft.length >= 3 && finishPolygon());
      return setDraft([...draft, q]);
    }

    if (active === 'smart') {
      if (!inPage(p) || busy || readOnly) return;
      return void run('smart', async () => {
        const f = await onSmartFrame(p[0], p[1]);
        if (!f) return void toast.info('Could not find a panel border there. Try the rectangle or point tools.');
        const now = framesRef.current;
        commit([...now, f], now.length);
      });
    }

    if (active === 'add' || active === 'remove') {
      if (selected === null || !inPage(p) || busy || readOnly) return;
      const index = selected;
      const target = frames[index];
      if (!target) return;
      return void run(active, async () => {
        const f = await onRefine(target, p[0], p[1], active);
        // Only apply it if that frame is still there, unchanged, when the answer arrives.
        const now = framesRef.current;
        if (now[index] !== target) return;
        commit(now.map((x, j) => (j === index ? f : x)));
      });
    }

    // Select. A node of the selected frame within reach wins over everything else.
    const node = nodeAt(e.clientX, e.clientY, e.pointerType);
    if (node && selected !== null) {
      const f = frames[selected];
      capture();
      if (node.kind === 'vertex') return beginDrag({ kind: 'vertex', index: selected, vertex: node.vertex }, e.pointerId);
      if (!isPoly(f)) return beginDrag({ kind: 'handle', index: selected, start: f, hx: node.hx, hy: node.hy, px: p[0], py: p[1] }, e.pointerId);
    }
    // Otherwise the frame under the pointer, preferring the current selection, then the smallest.
    const hits = frames.map((f, i) => ({ f, i })).filter(({ f }) => pointInFrame(f, p[0], p[1]));
    const hit = hits.find((h) => h.i === selected) ?? hits.sort((a, b) => bounds(a.f).w * bounds(a.f).h - bounds(b.f).w * bounds(b.f).h)[0];
    if (!hit) return setSelected(null);
    setSelected(hit.i);
    if (readOnly) return;
    capture();
    beginDrag({ kind: 'move', index: hit.i, start: hit.f, px: p[0], py: p[1] }, e.pointerId);
  };

  const [, redraw] = useState(0);
  const shown = liveFrames.current ?? frames;

  /** Finish the drag: apply what it did. Safe to call when there is none, and more than once. */
  const endDrag = () => {
    const d = dragRef.current;
    const id = dragPointer.current;
    dragRef.current = null;
    dragPointer.current = null;
    if (id !== null) {
      try {
        stage.current?.releasePointerCapture(id);
      } catch {
        // already released
      }
    }
    const now = framesRef.current;
    if (d?.kind === 'draw') {
      const r = normalizeRect({ x: d.x0, y: d.y0, w: d.x1 - d.x0, h: d.y1 - d.y0 });
      if (r.w * pageW > 8 && r.h * pageH > 8) commit([...now, r], now.length);
    }
    if (liveFrames.current) {
      const next = liveFrames.current;
      liveFrames.current = null;
      // Only if the frames underneath are still the ones the drag started from.
      if (next.length === now.length && JSON.stringify(next) !== JSON.stringify(now)) commit(next);
    }
    setDrag(null);
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const p = toPage(e.clientX, e.clientY);
    setCursor(p);
    const d = dragRef.current;
    if (!d) {
      // Show which node a press here would grab.
      const n = tool === 'select' && !spaceDown ? nodeAt(e.clientX, e.clientY, e.pointerType) : null;
      const key = n ? (n.kind === 'vertex' ? `v:${n.vertex}` : `h:${n.hx}:${n.hy}`) : null;
      if (key !== hot) setHot(key);
      return;
    }
    if (dragPointer.current !== null && e.pointerId !== dragPointer.current) return;
    // The button was let go somewhere we did not see (outside the window, over a dialog).
    if (e.pointerType === 'mouse' && e.buttons === 0) return endDrag();

    if (d.kind === 'pan') {
      const dx = e.clientX - d.lx;
      const dy = e.clientY - d.ly;
      d.lx = e.clientX;
      d.ly = e.clientY;
      if (dx || dy) setView((v) => clampView({ ...v, x: v.x + dx, y: v.y + dy }));
      return;
    }
    if (d.kind === 'draw') {
      const nd: Drag = { ...d, x1: clamp(p[0], 0, 1), y1: clamp(p[1], 0, 1) };
      dragRef.current = nd;
      return setDrag(nd);
    }

    const base = framesRef.current;
    if (!base[d.index]) return endDrag(); // the frame was removed under the drag
    let next: Frame | null = null;
    if (d.kind === 'move') {
      const b = bounds(d.start);
      const mx = clamp(p[0] - d.px, -b.x, 1 - b.x - b.w);
      const my = clamp(p[1] - d.py, -b.y, 1 - b.y - b.h);
      next = isPoly(d.start) ? { points: d.start.points.map(([x, y]) => [x + mx, y + my] as [number, number]) } : { ...d.start, x: d.start.x + mx, y: d.start.y + my };
    } else if (d.kind === 'handle') {
      const st = d.start;
      let x0 = st.x;
      let y0 = st.y;
      let x1 = st.x + st.w;
      let y1 = st.y + st.h;
      if (d.hx === -1) x0 = clamp(p[0], 0, x1 - 0.01);
      if (d.hx === 1) x1 = clamp(p[0], x0 + 0.01, 1);
      if (d.hy === -1) y0 = clamp(p[1], 0, y1 - 0.01);
      if (d.hy === 1) y1 = clamp(p[1], y0 + 0.01, 1);
      next = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
    } else if (d.kind === 'vertex') {
      const f = base[d.index];
      if (isPoly(f) && f.points[d.vertex]) next = { points: f.points.map((pt, j) => (j === d.vertex ? ([clamp(p[0], 0, 1), clamp(p[1], 0, 1)] as [number, number]) : pt)) };
    }
    if (next) {
      const n = next;
      liveFrames.current = base.map((f, j) => (j === d.index ? n : f));
      redraw((v) => v + 1);
    }
  };

  const onPointerUp = (e?: React.PointerEvent) => {
    if (e && dragPointer.current !== null && e.pointerId !== dragPointer.current) return;
    endDrag();
  };

  // Safety net: however a drag ends (released outside the stage, the window loses focus, the
  // tab is hidden, the browser cancels the touch), it ends. Nothing is left following the pointer.
  const endDragRef = useRef(endDrag);
  endDragRef.current = endDrag;
  useEffect(() => {
    if (!drag) return;
    const finish = (ev: PointerEvent) => {
      if (dragPointer.current === null || ev.pointerId === dragPointer.current) endDragRef.current();
    };
    const stop = () => endDragRef.current();
    const hidden = () => document.hidden && endDragRef.current();
    window.addEventListener('pointerup', finish);
    window.addEventListener('pointercancel', finish);
    window.addEventListener('blur', stop);
    document.addEventListener('visibilitychange', hidden);
    return () => {
      window.removeEventListener('pointerup', finish);
      window.removeEventListener('pointercancel', finish);
      window.removeEventListener('blur', stop);
      document.removeEventListener('visibilitychange', hidden);
    };
  }, [drag !== null]); // eslint-disable-line react-hooks/exhaustive-deps

  // Keyboard.
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target.closest('input, textarea, select, [contenteditable="true"]')) return;
      // A button that has keyboard focus owns Space and Enter (they press it).
      if ((e.key === ' ' || e.key === 'Enter') && target.closest('button, a')) return;
      if (e.key === ' ') {
        e.preventDefault();
        setSpaceDown(true);
        return;
      }
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        return e.shiftKey ? redo() : undo();
      }
      if (mod && e.key.toLowerCase() === 'y') {
        e.preventDefault();
        return redo();
      }
      if (mod) return;
      if (e.key === 'Enter' && draft.length) return finishPolygon();
      if (e.key === 'Escape') {
        if (dragRef.current) return cancelDrag();
        if (draft.length) return setDraft([]);
        setSelected(null);
        return setTool('select');
      }
      // While a shape is being placed, Backspace takes back its last point.
      if ((e.key === 'Delete' || e.key === 'Backspace') && draft.length) {
        e.preventDefault();
        return setDraft(draft.slice(0, -1));
      }
      if (dragRef.current) return; // no deleting, zooming or tool changes mid-drag
      if ((e.key === 'Delete' || e.key === 'Backspace') && selected !== null) {
        e.preventDefault();
        return removeFrame(selected);
      }
      if (e.key === '+' || e.key === '=') return zoomBy(1.25);
      if (e.key === '-') return zoomBy(0.8);
      if (e.key === '0') return setView({ zoom: 1, x: 0, y: 0 });
      const t = TOOLS.find((x) => x.key.toLowerCase() === e.key.toLowerCase());
      if (t && !e.repeat && !(t.needsSelection && selected === null)) chooseTool(t.id);
    };
    const up = (e: KeyboardEvent) => e.key === ' ' && setSpaceDown(false);
    // Space released while another window had focus never reaches us: do not stay in "move the page".
    const lost = () => setSpaceDown(false);
    document.addEventListener('visibilitychange', lost);
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    window.addEventListener('blur', lost);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
      window.removeEventListener('blur', lost);
      document.removeEventListener('visibilitychange', lost);
    };
  });

  // Wheel zoom (needs a non-passive listener to prevent page scroll).
  useEffect(() => {
    const el = stage.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const d = dragRef.current;
      if (d && d.kind !== 'pan') return; // zooming mid-drag would move the frame under the pointer
      const r = el.getBoundingClientRect();
      if (e.ctrlKey || e.metaKey || Math.abs(e.deltaY) > Math.abs(e.deltaX)) zoomBy(e.deltaY < 0 ? 1.12 : 0.89, { x: e.clientX - r.left, y: e.clientY - r.top });
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  });

  // Drag-to-reorder in the frame list.
  const [dragRow, setDragRow] = useState<number | null>(null);
  const [overRow, setOverRow] = useState<number | null>(null);
  const reorder = (from: number, to: number) => {
    if (from === to) return;
    const next = [...frames];
    const [m] = next.splice(from, 1);
    next.splice(to, 0, m);
    commit(next, to);
  };

  const sel = selected !== null ? shown[selected] : null;
  const handleSize = 11;
  const px = (fx: number) => fx * pageW;
  const py = (fy: number) => fy * pageH;
  const cursorClass = drag?.kind === 'pan' ? 'cursor-grabbing' : spaceDown || tool === 'pan' ? 'cursor-grab' : tool === 'select' ? 'cursor-default' : 'cursor-crosshair';
  // Over a node (or while dragging one) the cursor shows what the drag will do.
  const nodeCursor = (() => {
    if (spaceDown || tool !== 'select') return undefined;
    const d = drag;
    const key = d?.kind === 'vertex' ? `v:${d.vertex}` : d?.kind === 'handle' ? `h:${d.hx}:${d.hy}` : hot;
    if (!key) return d?.kind === 'move' ? 'move' : undefined;
    if (key.startsWith('v:')) return 'move';
    const [, hx, hy] = key.split(':').map(Number);
    return hx === 0 ? 'ns-resize' : hy === 0 ? 'ew-resize' : hx === hy ? 'nwse-resize' : 'nesw-resize';
  })();

  return (
    <div className="flex h-full min-h-0 flex-col md:flex-row">
      {/* Frame list */}
      <aside className="order-2 flex max-h-48 w-full shrink-0 flex-col border-t border-line bg-surface md:order-1 md:max-h-none md:w-60 md:border-r md:border-t-0">
        <div className="flex items-center justify-between gap-2 border-b border-line px-3 py-2.5">
          <label className="flex items-center gap-2 text-xs text-muted">
            Background
            <input type="color" value={background} onChange={(e) => onBackgroundChange(e.target.value)} aria-label="Page background color" className="size-6 cursor-pointer rounded border border-line" />
            <span className="font-mono text-[11px] uppercase text-faint">{background}</span>
          </label>
        </div>
        <div className="border-b border-line p-3">
          <Button variant="sun" size="sm" block loading={busy === 'detect'} disabled={readOnly} onClick={detect} icon={<Wand2 className="size-4" />}>
            {frames.length ? 'Detect again' : 'Detect frames'}
          </Button>
          <p className="mt-2 text-[11px] leading-snug text-faint">Finds panel borders by analyzing the page image. Nothing leaves the server.{rtl ? ' Frames are ordered right to left for this series.' : ''}</p>
        </div>
        <ol className="min-h-0 flex-1 space-y-1 overflow-auto p-2" aria-label="Frames in reading order">
          {frames.length === 0 && <li className="px-2 py-3 text-xs text-muted">No frames yet. Detect them, or press <kbd className="rounded bg-raised px-1">F</kbd> and drag a box.</li>}
          {frames.map((_, i) => (
            <li
              key={i}
              draggable={!readOnly}
              onDragStart={(e) => {
                // Firefox only starts a drag that carries data.
                e.dataTransfer.setData('text/plain', String(i));
                e.dataTransfer.effectAllowed = 'move';
                setDragRow(i);
              }}
              onDragOver={(e) => {
                if (dragRow === null) return;
                e.preventDefault();
                e.dataTransfer.dropEffect = 'move';
                if (overRow !== i) setOverRow(i);
              }}
              onDrop={(e) => {
                e.preventDefault();
                if (dragRow !== null) reorder(dragRow, i);
                setDragRow(null);
                setOverRow(null);
              }}
              onDragEnd={() => {
                setDragRow(null);
                setOverRow(null);
              }}
              // The line shows where the dragged frame will land: above when moving it earlier, below when moving it later.
              className={cx(
                'flex items-center gap-1.5 rounded-lg border px-1.5 py-1 text-sm',
                selected === i ? 'border-accent bg-accent-soft' : 'border-transparent hover:bg-hover',
                dragRow === i && 'opacity-50',
                dragRow !== null && overRow === i && dragRow !== i && (dragRow > i ? 'shadow-[0_-2px_0_0_var(--color-accent)]' : 'shadow-[0_2px_0_0_var(--color-accent)]'),
              )}
            >
              <GripVertical className="size-4 shrink-0 cursor-grab text-faint" aria-hidden />
              <button className="flex-1 text-left" onMouseDown={(e) => e.preventDefault()} onClick={() => { setSelected(i); chooseTool('select'); }}>Frame {i + 1}</button>
              <IconButton label={`Move frame ${i + 1} earlier`} className="size-7" disabled={i === 0} onClick={() => reorder(i, i - 1)}><ChevronUp className="size-3.5" /></IconButton>
              <IconButton label={`Move frame ${i + 1} later`} className="size-7" disabled={i === frames.length - 1} onClick={() => reorder(i, i + 1)}><ChevronDown className="size-3.5" /></IconButton>
              <IconButton label={`Delete frame ${i + 1}`} className="size-7" onClick={() => removeFrame(i)}><Trash2 className="size-3.5" /></IconButton>
            </li>
          ))}
        </ol>
      </aside>

      <div className="order-1 flex min-h-0 min-w-0 flex-1 flex-col md:order-2">
        {/* Toolbar */}
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line bg-surface px-3 py-2">
          <div className="no-scrollbar flex max-w-full items-center gap-0.5 overflow-x-auto rounded-xl bg-ink p-1" role="toolbar" aria-label="Frame tools" onMouseDown={(e) => e.preventDefault()}>
            {TOOLS.map((t) => (
              <button
                key={t.id}
                type="button"
                title={`${t.label} (${t.key})`}
                aria-label={t.label}
                aria-pressed={tool === t.id}
                disabled={t.needsSelection && selected === null}
                onClick={() => chooseTool(t.id)}
                className={cx('relative flex size-9 shrink-0 items-center justify-center rounded-lg transition-colors disabled:opacity-30', tool === t.id ? 'bg-accent text-accent-ink' : 'text-muted hover:bg-hover hover:text-paper')}
              >
                {t.icon}
                <span className="absolute bottom-0.5 right-1 text-[8px] font-bold opacity-70">{t.key}</span>
              </button>
            ))}
            <span className="mx-1 h-6 w-px bg-line" />
            <IconButton label="Delete selected frame (Del)" disabled={selected === null} onClick={() => selected !== null && removeFrame(selected)}><Trash2 className="size-[18px]" /></IconButton>
            <IconButton label="Undo (Ctrl+Z)" disabled={!past.current.length} onClick={undo}><Undo2 className="size-[18px]" /></IconButton>
            <IconButton label="Redo (Ctrl+Shift+Z)" disabled={!future.current.length} onClick={redo}><Redo2 className="size-[18px]" /></IconButton>
          </div>
          <div className="flex items-center gap-1">
            <IconButton label="Zoom out (-)" onClick={() => zoomBy(0.8)}><Minus className="size-[18px]" /></IconButton>
            <button className="w-12 text-center text-xs tabular-nums text-muted hover:text-paper" title="Reset zoom (0)" onClick={() => setView({ zoom: 1, x: 0, y: 0 })}>{Math.round(view.zoom * 100)}%</button>
            <IconButton label="Zoom in (+)" onClick={() => zoomBy(1.25)}><Plus className="size-[18px]" /></IconButton>
            <IconButton label="Fit page" onClick={() => setView({ zoom: 1, x: 0, y: 0 })}><Maximize2 className="size-[18px]" /></IconButton>
            {actions}
          </div>
        </div>

        {/* Stage */}
        <div
          ref={stage}
          className={cx('relative min-h-0 flex-1 touch-none select-none overflow-hidden bg-ink', cursorClass)}
          style={nodeCursor ? { cursor: nodeCursor } : undefined}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          onLostPointerCapture={(e) => dragRef.current && onPointerUp(e)}
          onPointerLeave={() => { setCursor(null); if (!dragRef.current) setHot(null); }}
          onContextMenu={(e) => dragRef.current && e.preventDefault()}
          onDragStart={(e) => e.preventDefault()}
          onAuxClick={(e) => e.button === 1 && e.preventDefault()}
        >
          {stageSize.w > 0 && (
            <div className="absolute shadow-pop" style={{ left, top, width: pageW, height: pageH, background }}>
              <img src={imageUrl} alt="Page being edited" draggable={false} className="pointer-events-none absolute inset-0 size-full select-none" />
              <svg className="absolute inset-0 size-full overflow-visible" viewBox={`0 0 ${pageW} ${pageH}`} aria-hidden>
                {/* Dim everything that is not in a frame, so gaps are obvious. */}
                {shown.length > 0 && (
                  <>
                    <defs>
                      <mask id="frames-mask">
                        <rect width={pageW} height={pageH} fill="white" />
                        {shown.map((f, i) =>
                          isPoly(f) ? <polygon key={i} points={f.points.map(([x, y]) => `${px(x)},${py(y)}`).join(' ')} fill="black" /> : <rect key={i} x={px(f.x)} y={py(f.y)} width={px(f.w)} height={py(f.h)} fill="black" />,
                        )}
                      </mask>
                    </defs>
                    <rect width={pageW} height={pageH} fill="rgb(0 0 0 / .45)" mask="url(#frames-mask)" />
                  </>
                )}
                {shown.map((f, i) => {
                  const on = selected === i;
                  const stroke = on ? 'var(--color-accent)' : 'var(--color-sun)';
                  const b = bounds(f);
                  return (
                    <g key={i}>
                      {isPoly(f) ? (
                        <polygon points={f.points.map(([x, y]) => `${px(x)},${py(y)}`).join(' ')} fill={on ? 'rgb(255 46 136 / .14)' : 'transparent'} stroke={stroke} strokeWidth={on ? 2.5 : 2} strokeLinejoin="round" />
                      ) : (
                        <rect x={px(f.x)} y={py(f.y)} width={px(f.w)} height={py(f.h)} fill={on ? 'rgb(255 46 136 / .14)' : 'transparent'} stroke={stroke} strokeWidth={on ? 2.5 : 2} />
                      )}
                      <g transform={`translate(${px(b.x + b.w / 2)}, ${py(b.y + b.h / 2)})`}>
                        <circle r={15} fill={stroke} />
                        <text textAnchor="middle" dominantBaseline="central" fontSize={14} fontWeight={700} fill={on ? 'var(--color-accent-ink)' : 'var(--color-sun-ink)'}>{i + 1}</text>
                      </g>
                    </g>
                  );
                })}

                {/* Handles for the selected frame. They are drawn only: presses are matched to the
                    nearest one by distance in onPointerDown, so they do not need pixel-perfect aim. */}
                {tool === 'select' && sel && !isPoly(sel) &&
                  ([-1, 0, 1] as const).flatMap((hx) =>
                    ([-1, 0, 1] as const).map((hy) => {
                      if (hx === 0 && hy === 0) return null;
                      const key = `h:${hx}:${hy}`;
                      const on = hot === key || (drag?.kind === 'handle' && drag.hx === hx && drag.hy === hy);
                      const size = on ? handleSize + 5 : handleSize;
                      const cxp = px(sel.x + (sel.w * (hx + 1)) / 2);
                      const cyp = py(sel.y + (sel.h * (hy + 1)) / 2);
                      return <rect key={key} x={cxp - size / 2} y={cyp - size / 2} width={size} height={size} rx={2} fill={on ? 'var(--color-accent)' : 'white'} stroke={on ? 'white' : 'var(--color-accent)'} strokeWidth={2} pointerEvents="none" />;
                    }),
                  )}
                {tool === 'select' && sel && isPoly(sel) &&
                  sel.points.map(([x, y], v) => {
                    const on = hot === `v:${v}` || (drag?.kind === 'vertex' && drag.vertex === v);
                    return <circle key={v} cx={px(x)} cy={py(y)} r={on ? 10 : 7} fill={on ? 'var(--color-accent)' : 'white'} stroke={on ? 'white' : 'var(--color-accent)'} strokeWidth={2} pointerEvents="none" />;
                  })}

                {/* Rectangle being drawn */}
                {drag?.kind === 'draw' && (
                  <rect x={px(Math.min(drag.x0, drag.x1))} y={py(Math.min(drag.y0, drag.y1))} width={px(Math.abs(drag.x1 - drag.x0))} height={py(Math.abs(drag.y1 - drag.y0))} fill="rgb(255 46 136 / .18)" stroke="var(--color-accent)" strokeWidth={2} strokeDasharray="6 4" />
                )}
                {/* Polygon being drawn */}
                {draft.length > 0 && (
                  <>
                    <polyline points={[...draft, ...(cursor && tool === 'poly' && !spaceDown && !drag ? [cursor] : [])].map(([x, y]) => `${px(x)},${py(y)}`).join(' ')} fill="rgb(255 46 136 / .12)" stroke="var(--color-accent)" strokeWidth={2} strokeDasharray="6 4" />
                    {draft.map(([x, y], i) => <circle key={i} cx={px(x)} cy={py(y)} r={i === 0 ? 7 : 4.5} fill={i === 0 ? 'var(--color-accent)' : 'white'} stroke="var(--color-accent)" strokeWidth={2} />)}
                  </>
                )}
              </svg>
            </div>
          )}

          {busy && busy !== 'detect' && (
            <div className="absolute right-3 top-3 flex items-center gap-2 rounded-full bg-black/75 px-3 py-1.5 text-xs"><Spinner className="size-4" /> Working…</div>
          )}

          {draft.length > 0 && (
            <div className="absolute right-3 top-3 flex gap-2" onPointerDown={(e) => e.stopPropagation()} onMouseDown={(e) => e.preventDefault()}>
              <Button size="sm" variant="primary" disabled={draft.length < 3} onClick={finishPolygon} icon={<Check className="size-4" />}>Accept</Button>
              <Button size="sm" variant="secondary" onClick={() => setDraft([])} icon={<X className="size-4" />}>Cancel</Button>
            </div>
          )}

          <div className="pointer-events-none absolute inset-x-0 bottom-3 flex justify-center px-3">
            <div className="flex items-center gap-2 rounded-full bg-black/80 px-4 py-2 text-center text-xs text-paper backdrop-blur">
              <ScanSearch className="size-4 shrink-0 text-muted" />
              {draft.length > 0 && (spaceDown || tool === 'pan') ? 'Move the page, then press P to carry on with your shape. Its points are kept.' : draft.length > 0 && tool === 'poly' ? 'Click the next corner. Enter or the first point finishes. Backspace takes back a point.' : HINT[spaceDown ? 'pan' : tool]}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
