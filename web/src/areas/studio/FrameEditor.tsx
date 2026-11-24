import {
  Check, ChevronDown, ChevronUp, GripVertical, Hand, Maximize2, Minus, MousePointer2, PenTool, Plus, Redo2, ScanSearch, Square, SquareDashedMousePointer,
  SquareMinus, SquarePlus, Trash2, Undo2, Wand2, X,
} from 'lucide-react';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { bounds, clamp, isPoly, normaliseRect, pointInFrame } from '@/lib/frames';
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
  | { kind: 'pan'; sx: number; sy: number; ox: number; oy: number }
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
  select: 'Click a frame to select it. Drag to move, drag a handle to resize.',
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

  const toPage = (clientX: number, clientY: number): [number, number] => {
    const r = stage.current!.getBoundingClientRect();
    return [(clientX - r.left - left) / pageW, (clientY - r.top - top) / pageH];
  };
  const inPage = ([x, y]: [number, number]) => x >= 0 && x <= 1 && y >= 0 && y <= 1;

  const zoomBy = (factor: number, at?: { x: number; y: number }) => {
    setView((v) => {
      const zoom = clamp(v.zoom * factor, 0.4, 8);
      if (!at) return { ...v, zoom };
      // Keep the point under the cursor fixed.
      const cx0 = at.x - stageSize.w / 2 - v.x;
      const cy0 = at.y - stageSize.h / 2 - v.y;
      const k = zoom / v.zoom;
      return { zoom, x: v.x - cx0 * (k - 1), y: v.y - cy0 * (k - 1) };
    });
  };

  const finishPolygon = useCallback(() => {
    if (draft.length >= 3) commit([...frames, { points: draft.map(([x, y]) => [clamp(x, 0, 1), clamp(y, 0, 1)] as [number, number]) }], frames.length);
    setDraft([]);
  }, [draft, frames, commit]);

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

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0 && e.button !== 1) return;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    const p = toPage(e.clientX, e.clientY);
    const active: Tool = spaceDown || e.button === 1 ? 'pan' : tool;

    if (active === 'pan') return setDrag({ kind: 'pan', sx: e.clientX, sy: e.clientY, ox: view.x, oy: view.y });

    if (active === 'rect') {
      if (!inPage(p)) return;
      return setDrag({ kind: 'draw', x0: p[0], y0: p[1], x1: p[0], y1: p[1] });
    }

    if (active === 'poly') {
      if (!inPage(p)) return;
      if (draft.length >= 3) {
        const [fx, fy] = draft[0];
        if (Math.hypot((p[0] - fx) * pageW, (p[1] - fy) * pageH) < 12) return finishPolygon();
      }
      return setDraft([...draft, p]);
    }

    if (active === 'smart') {
      if (!inPage(p)) return;
      return void run('smart', async () => {
        const f = await onSmartFrame(p[0], p[1]);
        if (!f) return void toast.info('Could not find a panel border there. Try the rectangle or point tools.');
        commit([...frames, f], frames.length);
      });
    }

    if (active === 'add' || active === 'remove') {
      if (selected === null || !inPage(p)) return;
      const index = selected;
      return void run(active, async () => {
        const f = await onRefine(frames[index], p[0], p[1], active);
        commit(frames.map((x, j) => (j === index ? f : x)));
      });
    }

    // Select: topmost (last drawn) frame under the pointer, preferring the current selection.
    const hits = frames.map((f, i) => ({ f, i })).filter(({ f }) => pointInFrame(f, p[0], p[1]));
    const hit = hits.find((h) => h.i === selected) ?? hits.sort((a, b) => bounds(a.f).w * bounds(a.f).h - bounds(b.f).w * bounds(b.f).h)[0];
    if (!hit) return setSelected(null);
    setSelected(hit.i);
    setDrag({ kind: 'move', index: hit.i, start: hit.f, px: p[0], py: p[1] });
  };

  const liveFrames = useRef<Frame[] | null>(null);
  const [, redraw] = useState(0);
  const shown = liveFrames.current ?? frames;

  const onPointerMove = (e: React.PointerEvent) => {
    const p = toPage(e.clientX, e.clientY);
    setCursor(p);
    if (!drag) return;
    if (drag.kind === 'pan') return setView((v) => ({ ...v, x: drag.ox + e.clientX - drag.sx, y: drag.oy + e.clientY - drag.sy }));
    if (drag.kind === 'draw') return setDrag({ ...drag, x1: clamp(p[0], 0, 1), y1: clamp(p[1], 0, 1) });

    let next: Frame | null = null;
    if (drag.kind === 'move') {
      const dx = p[0] - drag.px;
      const dy = p[1] - drag.py;
      const b = bounds(drag.start);
      const mx = clamp(dx, -b.x, 1 - b.x - b.w);
      const my = clamp(dy, -b.y, 1 - b.y - b.h);
      next = isPoly(drag.start) ? { points: drag.start.points.map(([x, y]) => [x + mx, y + my] as [number, number]) } : { ...drag.start, x: drag.start.x + mx, y: drag.start.y + my };
    } else if (drag.kind === 'handle') {
      const s = drag.start;
      let x0 = s.x;
      let y0 = s.y;
      let x1 = s.x + s.w;
      let y1 = s.y + s.h;
      if (drag.hx === -1) x0 = clamp(p[0], 0, x1 - 0.01);
      if (drag.hx === 1) x1 = clamp(p[0], x0 + 0.01, 1);
      if (drag.hy === -1) y0 = clamp(p[1], 0, y1 - 0.01);
      if (drag.hy === 1) y1 = clamp(p[1], y0 + 0.01, 1);
      next = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
    } else if (drag.kind === 'vertex') {
      const f = frames[drag.index];
      if (isPoly(f)) next = { points: f.points.map((pt, j) => (j === drag.vertex ? ([clamp(p[0], 0, 1), clamp(p[1], 0, 1)] as [number, number]) : pt)) };
    }
    if (next) {
      const n = next;
      liveFrames.current = frames.map((f, j) => (j === drag.index ? n : f));
      redraw((v) => v + 1);
    }
  };

  const onPointerUp = () => {
    if (drag?.kind === 'draw') {
      const r = normaliseRect({ x: drag.x0, y: drag.y0, w: drag.x1 - drag.x0, h: drag.y1 - drag.y0 });
      if (r.w * pageW > 8 && r.h * pageH > 8) commit([...frames, r], frames.length);
    }
    if (liveFrames.current) {
      const changed = JSON.stringify(liveFrames.current) !== JSON.stringify(frames);
      const next = liveFrames.current;
      liveFrames.current = null;
      if (changed) commit(next);
    }
    setDrag(null);
  };

  // Keyboard.
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).closest('input, textarea, select')) return;
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
        if (draft.length) return setDraft([]);
        setSelected(null);
        return setTool('select');
      }
      if ((e.key === 'Delete' || e.key === 'Backspace') && selected !== null) {
        e.preventDefault();
        return removeFrame(selected);
      }
      if (e.key === '+' || e.key === '=') return zoomBy(1.25);
      if (e.key === '-') return zoomBy(0.8);
      if (e.key === '0') return setView({ zoom: 1, x: 0, y: 0 });
      const t = TOOLS.find((x) => x.key.toLowerCase() === e.key.toLowerCase());
      if (t && !(t.needsSelection && selected === null)) setTool(t.id);
    };
    const up = (e: KeyboardEvent) => e.key === ' ' && setSpaceDown(false);
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
    };
  });

  // Wheel zoom (needs a non-passive listener to prevent page scroll).
  useEffect(() => {
    const el = stage.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
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
  const handleSize = 9;
  const px = (fx: number) => fx * pageW;
  const py = (fy: number) => fy * pageH;
  const cursorClass = drag?.kind === 'pan' ? 'cursor-grabbing' : spaceDown || tool === 'pan' ? 'cursor-grab' : tool === 'select' ? 'cursor-default' : 'cursor-crosshair';

  return (
    <div className="flex h-full min-h-0 flex-col md:flex-row">
      {/* Frame list */}
      <aside className="order-2 flex max-h-48 w-full shrink-0 flex-col border-t border-line bg-surface md:order-1 md:max-h-none md:w-60 md:border-r md:border-t-0">
        <div className="flex items-center justify-between gap-2 border-b border-line px-3 py-2.5">
          <label className="flex items-center gap-2 text-xs text-muted">
            Background
            <input type="color" value={background} onChange={(e) => onBackgroundChange(e.target.value)} aria-label="Page background colour" className="size-6 cursor-pointer rounded border border-line" />
            <span className="font-mono text-[11px] uppercase text-faint">{background}</span>
          </label>
        </div>
        <div className="border-b border-line p-3">
          <Button variant="sun" size="sm" block loading={busy === 'detect'} disabled={readOnly} onClick={detect} icon={<Wand2 className="size-4" />}>
            {frames.length ? 'Detect again' : 'Detect frames'}
          </Button>
          <p className="mt-2 text-[11px] leading-snug text-faint">Finds panel borders by analysing the page image. No generative AI; nothing leaves the server.{rtl ? ' Frames are ordered right to left for this series.' : ''}</p>
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
              <button className="flex-1 text-left" onClick={() => { setSelected(i); setTool('select'); }}>Frame {i + 1}</button>
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
          <div className="no-scrollbar flex max-w-full items-center gap-0.5 overflow-x-auto rounded-xl bg-ink p-1" role="toolbar" aria-label="Frame tools">
            {TOOLS.map((t) => (
              <button
                key={t.id}
                type="button"
                title={`${t.label} (${t.key})`}
                aria-label={t.label}
                aria-pressed={tool === t.id}
                disabled={t.needsSelection && selected === null}
                onClick={() => setTool(t.id)}
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
          className={cx('relative min-h-0 flex-1 touch-none overflow-hidden bg-ink', cursorClass)}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          onPointerLeave={() => setCursor(null)}
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

                {/* Handles for the selected frame */}
                {tool === 'select' && sel && !isPoly(sel) &&
                  ([-1, 0, 1] as const).flatMap((hx) =>
                    ([-1, 0, 1] as const).map((hy) => {
                      if (hx === 0 && hy === 0) return null;
                      const cxp = px(sel.x + (sel.w * (hx + 1)) / 2);
                      const cyp = py(sel.y + (sel.h * (hy + 1)) / 2);
                      const cur = hx === 0 ? 'ns-resize' : hy === 0 ? 'ew-resize' : hx === hy ? 'nwse-resize' : 'nesw-resize';
                      return (
                        <rect
                          key={`${hx}${hy}`}
                          x={cxp - handleSize / 2}
                          y={cyp - handleSize / 2}
                          width={handleSize}
                          height={handleSize}
                          fill="white"
                          stroke="var(--color-accent)"
                          strokeWidth={2}
                          style={{ cursor: cur }}
                          onPointerDown={(e) => {
                            e.stopPropagation();
                            stage.current?.setPointerCapture(e.pointerId);
                            const p = toPage(e.clientX, e.clientY);
                            setDrag({ kind: 'handle', index: selected!, start: sel, hx, hy, px: p[0], py: p[1] });
                          }}
                        />
                      );
                    }),
                  )}
                {tool === 'select' && sel && isPoly(sel) &&
                  sel.points.map(([x, y], v) => (
                    <circle
                      key={v}
                      cx={px(x)}
                      cy={py(y)}
                      r={6}
                      fill="white"
                      stroke="var(--color-accent)"
                      strokeWidth={2}
                      style={{ cursor: 'move' }}
                      onPointerDown={(e) => {
                        e.stopPropagation();
                        stage.current?.setPointerCapture(e.pointerId);
                        setDrag({ kind: 'vertex', index: selected!, vertex: v });
                      }}
                    />
                  ))}

                {/* Rectangle being drawn */}
                {drag?.kind === 'draw' && (
                  <rect x={px(Math.min(drag.x0, drag.x1))} y={py(Math.min(drag.y0, drag.y1))} width={px(Math.abs(drag.x1 - drag.x0))} height={py(Math.abs(drag.y1 - drag.y0))} fill="rgb(255 46 136 / .18)" stroke="var(--color-accent)" strokeWidth={2} strokeDasharray="6 4" />
                )}
                {/* Polygon being drawn */}
                {draft.length > 0 && (
                  <>
                    <polyline points={[...draft, ...(cursor ? [cursor] : [])].map(([x, y]) => `${px(x)},${py(y)}`).join(' ')} fill="rgb(255 46 136 / .12)" stroke="var(--color-accent)" strokeWidth={2} strokeDasharray="6 4" />
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
            <div className="absolute right-3 top-3 flex gap-2" onPointerDown={(e) => e.stopPropagation()}>
              <Button size="sm" variant="primary" disabled={draft.length < 3} onClick={finishPolygon} icon={<Check className="size-4" />}>Accept</Button>
              <Button size="sm" variant="secondary" onClick={() => setDraft([])} icon={<X className="size-4" />}>Cancel</Button>
            </div>
          )}

          <div className="pointer-events-none absolute inset-x-0 bottom-3 flex justify-center px-3">
            <div className="flex items-center gap-2 rounded-full bg-black/80 px-4 py-2 text-center text-xs text-paper backdrop-blur">
              <ScanSearch className="size-4 shrink-0 text-muted" />
              {HINT[spaceDown ? 'pan' : tool]}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
