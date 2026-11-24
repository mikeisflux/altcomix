import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, ArrowLeft, Check, ChevronFirst, ChevronLast, ChevronLeft, ChevronRight, Loader2, Monitor, Pause, Play, Smartphone, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { GuidedView } from '@/areas/reader/Reader';
import type { ReaderPage } from '@/areas/reader/model';
import { api, errorMessage } from '@/lib/api';
import type { Frame } from '@/lib/frames';
import { clamp, normaliseRect } from '@/lib/frames';
import { useSession } from '@/lib/session';
import { Button, ErrorState, IconButton, Modal, PageLoader, Segmented, Select, Tabs, Textarea, cx, toast, useConfirm } from '@/ui';
import { FrameEditor } from './FrameEditor';
import { NoAccess, SignInNeeded, VerifyEmailPrompt, studioError, useTitle } from './shared';

type TextRegion = { x: number; y: number; w: number; h: number; text: Record<string, string> };
type PageDetail = {
  page: {
    id: string; release_id: string; position: number; width: number; height: number; bg_color: string; frames: Frame[]; frames_status: string; texts: TextRegion[];
    urls: { original: string; full: string; medium: string; thumb: string };
  };
  release: { id: string; title: string; number: number; kind: string; language: string; page_count: number; status: string };
  series: { id: string; title: string; slug: string; reading_dir: 'ltr' | 'rtl'; layout: string; language: string };
  prev_id: string | null; next_id: string | null; first_id: string | null; last_id: string | null;
};
type SaveState = 'saved' | 'dirty' | 'saving' | 'error';

/**
 * Debounced saver that carries its own target, so an edit made on one page is
 * still written to that page after the editor has moved on to another.
 */
function useSaver<T>(write: (id: string, value: T) => Promise<void>, delay = 700) {
  const [state, setState] = useState<SaveState>('saved');
  const pending = useRef<{ id: string; value: T } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const running = useRef<Promise<boolean> | null>(null);
  const writeRef = useRef(write);
  writeRef.current = write;

  const flush = useCallback(async (): Promise<boolean> => {
    clearTimeout(timer.current);
    if (running.current) await running.current;
    const job = pending.current;
    if (!job) return true;
    pending.current = null;
    setState('saving');
    running.current = (async () => {
      try {
        await writeRef.current(job.id, job.value);
        if (!pending.current) setState('saved');
        return true;
      } catch {
        // Keep the edit so Retry (or the next change) sends it again.
        if (!pending.current) pending.current = job;
        setState('error');
        return false;
      } finally {
        running.current = null;
      }
    })();
    return running.current;
  }, []);

  const queue = useCallback((id: string, value: T) => {
    pending.current = { id, value };
    setState('dirty');
    clearTimeout(timer.current);
    timer.current = setTimeout(() => void flush(), delay);
  }, [flush, delay]);

  const settle = useCallback(() => {
    clearTimeout(timer.current);
    pending.current = null;
    setState('saved');
  }, []);

  useEffect(() => () => { void flush(); }, [flush]);
  return { state, queue, flush, settle };
}

function worst(a: SaveState, b: SaveState): SaveState {
  const order: SaveState[] = ['saved', 'dirty', 'saving', 'error'];
  return order[Math.max(order.indexOf(a), order.indexOf(b))];
}

function SaveBadge({ state, retry }: { state: SaveState; retry: () => void }) {
  if (state === 'error') return <button onClick={retry} className="inline-flex h-8 items-center gap-1.5 rounded-md bg-danger-soft px-2.5 text-xs font-semibold text-danger"><AlertTriangle className="size-3.5" />Not saved. Retry</button>;
  return (
    <span className={cx('inline-flex h-8 items-center gap-1.5 px-1 text-xs', state === 'saved' ? 'text-ok' : 'text-muted')} role="status" aria-live="polite">
      {state === 'saved' ? <Check className="size-3.5" /> : <Loader2 className="size-3.5 animate-spin" />}
      {state === 'saved' ? 'Saved' : 'Saving…'}
    </span>
  );
}

/** A fixed-size screen, scaled down to fit the space it is given. */
function Stage({ w, h, label, children }: { w: number; h: number; label: string; children: React.ReactNode }) {
  const box = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(0.5);
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const fit = () => setScale(Math.min(1, el.clientWidth / w, el.clientHeight / h));
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, [w, h]);
  return (
    <figure className="flex min-h-0 min-w-0 flex-1 flex-col items-center gap-2">
      <div ref={box} className="flex min-h-0 w-full flex-1 items-center justify-center">
        <div style={{ width: w * scale, height: h * scale }} className="relative overflow-hidden rounded-xl border-2 border-line-strong shadow-pop">
          <div style={{ width: w, height: h, transform: `scale(${scale})`, transformOrigin: 'top left' }} className="relative">{children}</div>
        </div>
      </div>
      <figcaption className="text-xs text-muted">{label}</figcaption>
    </figure>
  );
}

function PreviewDialog({ page, rtl, onClose }: { page: ReaderPage; rtl: boolean; onClose: () => void }) {
  const n = page.frames.length;
  const [i, setI] = useState(0);
  const [playing, setPlaying] = useState(n > 1);
  const [device, setDevice] = useState<'both' | 'phone' | 'desktop'>(() => (window.innerWidth >= 900 ? 'both' : 'phone'));
  useEffect(() => {
    if (!playing || n < 2) return;
    const t = setInterval(() => setI((v) => (v + 1) % n), 1700);
    return () => clearInterval(t);
  }, [playing, n]);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      // Same as the reader: in a right-to-left series the left arrow goes forward.
      const fwd = rtl ? 'ArrowLeft' : 'ArrowRight';
      const back = rtl ? 'ArrowRight' : 'ArrowLeft';
      if (e.key === fwd || e.key === ' ') { e.preventDefault(); setPlaying(false); setI((v) => Math.min(n - 1, v + 1)); }
      if (e.key === back) { setPlaying(false); setI((v) => Math.max(0, v - 1)); }
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [n, rtl]);
  const frameIndex = n ? i : null;
  return (
    <Modal open onClose={onClose} title="Guided view preview" size="xl">
      <div className="flex h-[70dvh] flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <Segmented size="sm" value={device} onChange={setDevice} options={[...(window.innerWidth >= 900 ? [{ value: 'both' as const, label: 'Both' }] : []), { value: 'phone', label: <span className="inline-flex items-center gap-1"><Smartphone className="size-3.5" />Phone</span> }, { value: 'desktop', label: <span className="inline-flex items-center gap-1"><Monitor className="size-3.5" />Desktop</span> }]} />
          {n > 0 ? (
            <div className="flex items-center gap-1">
              {/* The arrows point the way the reader's do: in a right-to-left series "next" is on the left. */}
              <div className={cx('flex items-center gap-1', rtl && 'flex-row-reverse')}>
                <IconButton label="Previous frame" disabled={i === 0} onClick={() => { setPlaying(false); setI(i - 1); }}>{rtl ? <ChevronRight className="size-5" /> : <ChevronLeft className="size-5" />}</IconButton>
                <IconButton label={playing ? 'Pause' : 'Play'} disabled={n < 2} onClick={() => setPlaying((p) => !p)}>{playing ? <Pause className="size-5" /> : <Play className="size-5" />}</IconButton>
                <IconButton label="Next frame" disabled={i >= n - 1} onClick={() => { setPlaying(false); setI(i + 1); }}>{rtl ? <ChevronLeft className="size-5" /> : <ChevronRight className="size-5" />}</IconButton>
              </div>
              <span className="w-28 text-right text-sm tabular-nums text-muted">Frame {i + 1} of {n}</span>
              {rtl && <span className="hidden text-xs text-faint sm:inline">Right to left</span>}
            </div>
          ) : <span className="text-sm text-muted">No frames: readers see the whole page.</span>}
        </div>
        <div className="flex min-h-0 flex-1 gap-4">
          {device !== 'desktop' && <div className={cx('flex min-h-0', device === 'both' ? 'w-1/4 min-w-40' : 'flex-1')}><Stage w={390} h={760} label="Phone, 390 wide"><GuidedView page={page} frameIndex={frameIndex} w={390} h={760} /></Stage></div>}
          {device !== 'phone' && <div className="flex min-h-0 flex-1"><Stage w={1280} h={720} label="Desktop, 1280 wide"><GuidedView page={page} frameIndex={frameIndex} w={1280} h={720} /></Stage></div>}
        </div>
      </div>
    </Modal>
  );
}

function TextEditor({ imageUrl, width, height, texts, onChange, languages, language, setLanguage }: { imageUrl: string; width: number; height: number; texts: TextRegion[]; onChange: (t: TextRegion[]) => void; languages: { code: string; label: string }[]; language: string; setLanguage: (l: string) => void }) {
  const stage = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [sel, setSel] = useState<number | null>(null);
  const [draw, setDraw] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  useLayoutEffect(() => {
    const el = stage.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    setSize({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);
  const aspect = width / height;
  const pw = Math.max(50, Math.min(size.w - 32, (size.h - 32) * aspect));
  const ph = pw / aspect;
  const left = (size.w - pw) / 2;
  const top = (size.h - ph) / 2;
  const at = (e: React.PointerEvent): [number, number] => {
    const r = stage.current!.getBoundingClientRect();
    return [clamp((e.clientX - r.left - left) / pw, 0, 1), clamp((e.clientY - r.top - top) / ph, 0, 1)];
  };
  const finish = () => {
    if (draw) {
      const r = normaliseRect({ x: draw.x0, y: draw.y0, w: draw.x1 - draw.x0, h: draw.y1 - draw.y0 }, 0.005);
      if (r.w * pw > 8 && r.h * ph > 8) { onChange([...texts, { ...r, text: {} }]); setSel(texts.length); }
    }
    setDraw(null);
  };
  return (
    <div className="flex h-full min-h-0 flex-col md:flex-row">
      <aside className="order-2 flex max-h-56 w-full shrink-0 flex-col border-t border-line bg-surface md:order-1 md:max-h-none md:w-72 md:border-r md:border-t-0">
        <div className="border-b border-line p-3">
          <label className="text-xs text-muted">Transcription language
            <Select value={language} onChange={(e) => setLanguage(e.target.value)} className="mt-1">{languages.map((l) => <option key={l.code} value={l.code}>{l.label}</option>)}</Select>
          </label>
          <p className="mt-2 text-[11px] leading-snug text-faint">Drag a box over a balloon or caption, then type what it says. Transcriptions help translators and make the page searchable.</p>
        </div>
        <ol className="min-h-0 flex-1 space-y-2 overflow-auto p-2">
          {texts.length === 0 && <li className="px-2 py-3 text-xs text-muted">No text regions yet. Drag a box on the page to add one.</li>}
          {texts.map((t, i) => (
            <li key={i} className={cx('rounded-lg border p-2', sel === i ? 'border-accent bg-accent-soft' : 'border-line')}>
              <div className="mb-1 flex items-center justify-between">
                <button className="text-sm font-medium" onClick={() => setSel(i)}>Text {i + 1}</button>
                <IconButton label={`Delete text region ${i + 1}`} className="size-7" onClick={() => { onChange(texts.filter((_, j) => j !== i)); setSel(null); }}><Trash2 className="size-3.5" /></IconButton>
              </div>
              <Textarea aria-label={`Transcription of text ${i + 1}`} className="min-h-16" maxLength={2000} value={t.text[language] ?? ''} onFocus={() => setSel(i)} onChange={(e) => onChange(texts.map((x, j) => (j === i ? { ...x, text: { ...x.text, [language]: e.target.value } } : x)))} />
            </li>
          ))}
        </ol>
      </aside>
      <div ref={stage} className="relative order-1 min-h-0 flex-1 cursor-crosshair touch-none overflow-hidden bg-ink md:order-2"
        onPointerDown={(e) => { (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); const p = at(e); setDraw({ x0: p[0], y0: p[1], x1: p[0], y1: p[1] }); }}
        onPointerMove={(e) => { if (draw) { const p = at(e); setDraw({ ...draw, x1: p[0], y1: p[1] }); } }}
        onPointerUp={finish} onPointerCancel={() => setDraw(null)}>
        {size.w > 0 && (
          <div className="absolute shadow-pop" style={{ left, top, width: pw, height: ph }}>
            <img src={imageUrl} alt="Page being transcribed" draggable={false} className="pointer-events-none absolute inset-0 size-full select-none" />
            {texts.map((t, i) => (
              <button key={i} aria-label={`Select text region ${i + 1}`} onPointerDown={(e) => { e.stopPropagation(); setSel(i); }} className={cx('absolute border-2 text-left', sel === i ? 'border-accent bg-accent/15' : 'border-info bg-info/10')} style={{ left: `${t.x * 100}%`, top: `${t.y * 100}%`, width: `${t.w * 100}%`, height: `${t.h * 100}%` }}>
                <span className={cx('absolute -left-0.5 -top-5 rounded px-1 text-[11px] font-bold', sel === i ? 'bg-accent text-accent-ink' : 'bg-info text-ink')}>{i + 1}</span>
              </button>
            ))}
            {draw && <div className="absolute border-2 border-dashed border-accent bg-accent/15" style={{ left: `${Math.min(draw.x0, draw.x1) * 100}%`, top: `${Math.min(draw.y0, draw.y1) * 100}%`, width: `${Math.abs(draw.x1 - draw.x0) * 100}%`, height: `${Math.abs(draw.y1 - draw.y0) * 100}%` }} />}
          </div>
        )}
      </div>
    </div>
  );
}

export function FramePage() {
  const { user, meta } = useSession();
  const { brand = '', series = '', release = '', page: pageId = '' } = useParams();
  const nav = useNavigate();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const key = ['studio', 'page', pageId];
  const detail = useQuery({ queryKey: key, queryFn: () => api<PageDetail>(`/api/studio/pages/${pageId}`), enabled: Boolean(user), retry: false, staleTime: 0, gcTime: 0 });
  const role = user?.brands.find((b) => b.slug === brand)?.role ?? (user && (user.role === 'admin' || user.role === 'super_admin') ? 'owner' : null);
  const editable = role !== null && role !== 'analyst';

  const [loaded, setLoaded] = useState<string | null>(null);
  const [frames, setFrames] = useState<Frame[]>([]);
  const [texts, setTexts] = useState<TextRegion[]>([]);
  const [bg, setBg] = useState('#000000');
  const [tab, setTab] = useState<'frames' | 'text'>('frames');
  const [preview, setPreview] = useState(false);
  const [language, setLanguage] = useState('en');
  const skip = useRef<string | null>(null);

  const patchCache = (id: string, p: Partial<PageDetail['page']>) => qc.setQueryData<PageDetail>(['studio', 'page', id], (old) => (old ? { ...old, page: { ...old.page, ...p } } : old));
  const frameSaver = useSaver<Frame[]>(async (id, value) => {
    const r = await api<{ frames: Frame[]; frames_status: string }>(`/api/studio/pages/${id}/frames`, { method: 'PUT', json: { frames: value } });
    patchCache(id, { frames: value, frames_status: r.frames_status });
  });
  const textSaver = useSaver<TextRegion[]>(async (id, value) => {
    await api(`/api/studio/pages/${id}/texts`, { method: 'PUT', json: { texts: value } });
    patchCache(id, { texts: value });
  });
  const bgSaver = useSaver<string>(async (id, value) => {
    await api(`/api/studio/pages/${id}`, { method: 'PATCH', json: { bg_color: value } });
    patchCache(id, { bg_color: value });
  }, 500);
  const state = worst(worst(frameSaver.state, textSaver.state), bgSaver.state);
  const flushAll = useCallback(async () => (await Promise.all([frameSaver.flush(), textSaver.flush(), bgSaver.flush()])).every(Boolean), [frameSaver, textSaver, bgSaver]);

  const d = detail.data;
  useEffect(() => {
    if (d && d.page.id === pageId && loaded !== pageId) {
      setFrames(d.page.frames ?? []);
      setTexts(d.page.texts ?? []);
      setBg(d.page.bg_color);
      setLanguage(d.release.language);
      setLoaded(pageId);
    }
  }, [d, pageId, loaded]);
  useTitle(d ? `Page ${d.page.position} · ${d.release.title}` : 'Frame editor');

  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => { if (state !== 'saved') e.preventDefault(); };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [state]);

  const releasePath = `/studio/${brand}/series/${series}/releases/${release}`;
  const go = useCallback(async (id: string | null | undefined) => {
    if (!id || id === pageId) return;
    if (!(await flushAll())) return void toast.error('Your last change could not be saved, so the page was not changed. Check your connection and retry.');
    nav(`${releasePath}/pages/${id}`);
  }, [pageId, flushAll, nav, releasePath]);
  const leave = async () => {
    if (!(await flushAll())) return void toast.error('Your last change could not be saved yet. Retry before leaving.');
    void qc.invalidateQueries({ queryKey: ['studio', 'pages', release] });
    nav(releasePath);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).closest('input, textarea, select') || e.metaKey || e.ctrlKey || preview) return;
      if (e.key === '[' || e.key === 'PageUp') { e.preventDefault(); void go(d?.prev_id); }
      if (e.key === ']' || e.key === 'PageDown') { e.preventDefault(); void go(d?.next_id); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [d, go, preview]);

  const publish = async () => {
    if (!d || !(await confirm({ title: `Publish “${d.release.title}”?`, body: 'The whole release goes live for readers now.', confirmLabel: 'Publish' }))) return;
    try {
      await flushAll();
      await api(`/api/studio/releases/${d.release.id}/publish`, { json: {} });
      toast.success('Published');
      await qc.invalidateQueries({ queryKey: key });
    } catch (e) {
      studioError(e);
    }
  };

  if (!user) return <div className="flex min-h-dvh items-center justify-center p-6"><SignInNeeded what="the frame editor" /></div>;
  if (detail.isError) {
    const status = (detail.error as { status?: number }).status;
    return <div className="flex min-h-dvh items-center justify-center p-6"><div className="w-full max-w-lg">{status === 403 ? <NoAccess /> : <ErrorState message={errorMessage(detail.error)} retry={() => detail.refetch()} />}<div className="mt-3 text-center"><Link className="link" to={releasePath}>Back to the release</Link></div></div></div>;
  }
  if (!d || loaded !== pageId) return <div className="flex min-h-dvh items-center justify-center"><PageLoader label="Opening page" /></div>;

  const p = d.page;
  const rtl = d.series.reading_dir === 'rtl';
  const onFrames = (next: Frame[]) => {
    setFrames(next);
    const json = JSON.stringify(next);
    if (skip.current === json) {
      // Exactly what detection just stored on the server: nothing to write.
      skip.current = null;
      frameSaver.settle();
      return;
    }
    skip.current = null;
    if (editable) frameSaver.queue(p.id, next);
  };
  const readerPage: ReaderPage = { id: p.id, position: p.position, width: p.width, height: p.height, bg_color: bg, frames, locked: false, url_medium: p.urls.medium, url_full: p.urls.full };
  const pagerBtn = 'size-9';

  return (
    <div className="flex h-dvh flex-col bg-ink">
      <header className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-line bg-surface px-2 py-1.5 sm:px-3">
        <button onClick={leave} className="inline-flex h-9 min-w-0 items-center gap-1.5 rounded-lg px-2 text-sm text-muted hover:bg-hover hover:text-paper">
          <ArrowLeft className="size-4 shrink-0" /><span className="max-w-32 truncate sm:max-w-56">{d.release.title}</span>
        </button>
        <div className={cx('flex items-center', rtl && 'flex-row-reverse')} role="group" aria-label={`Pages${rtl ? ', right to left' : ''}`}>
          <IconButton className={pagerBtn} label="First page" disabled={!d.prev_id} onClick={() => go(d.first_id)}>{rtl ? <ChevronLast className="size-4" /> : <ChevronFirst className="size-4" />}</IconButton>
          <IconButton className={pagerBtn} label="Previous page ([)" disabled={!d.prev_id} onClick={() => go(d.prev_id)}>{rtl ? <ChevronRight className="size-4" /> : <ChevronLeft className="size-4" />}</IconButton>
          <span className="px-1.5 text-sm tabular-nums">{p.position} of {d.release.page_count}</span>
          <IconButton className={pagerBtn} label="Next page (])" disabled={!d.next_id} onClick={() => go(d.next_id)}>{rtl ? <ChevronLeft className="size-4" /> : <ChevronRight className="size-4" />}</IconButton>
          <IconButton className={pagerBtn} label="Last page" disabled={!d.next_id} onClick={() => go(d.last_id)}>{rtl ? <ChevronFirst className="size-4" /> : <ChevronLast className="size-4" />}</IconButton>
        </div>
        <div className="mx-1"><Tabs value={tab} onChange={setTab} tabs={[{ value: 'frames', label: `Frames${frames.length ? ` (${frames.length})` : ''}` }, { value: 'text', label: `Text${texts.length ? ` (${texts.length})` : ''}` }]} /></div>
        <div className="ml-auto flex items-center gap-2">
          {rtl && <span className="hidden text-xs text-muted sm:inline">Reads right to left</span>}
          {editable ? <SaveBadge state={state} retry={flushAll} /> : <span className="text-xs text-muted">View only</span>}
          <Button size="sm" icon={<Play className="size-4" />} onClick={() => setPreview(true)}>Preview</Button>
          {editable && d.release.status !== 'published' && <Button size="sm" variant="primary" onClick={publish}>Publish</Button>}
        </div>
      </header>
      <main className="min-h-0 flex-1">
        {tab === 'frames' ? (
          <FrameEditor
            imageUrl={p.urls.full}
            pageWidth={p.width}
            pageHeight={p.height}
            frames={frames}
            onChange={onFrames}
            background={bg}
            onBackgroundChange={(hex) => { setBg(hex); if (editable) bgSaver.queue(p.id, hex.toLowerCase()); }}
            onDetect={async () => {
              await frameSaver.flush();
              const r = await api<{ frames: Frame[]; frames_status: string }>(`/api/studio/pages/${p.id}/frames/detect`, { json: {} });
              patchCache(p.id, { frames: r.frames, frames_status: r.frames_status });
              skip.current = JSON.stringify(r.frames);
              return r.frames;
            }}
            onSmartFrame={async (x, y) => (await api<{ frame: Frame }>(`/api/studio/pages/${p.id}/frames/smart`, { json: { x, y } })).frame}
            onRefine={async (frame, x, y, mode) => (await api<{ frame: Frame }>(`/api/studio/pages/${p.id}/frames/refine`, { json: { frame, x, y, mode } })).frame}
            rtl={rtl}
            readOnly={!editable}
          />
        ) : (
          <TextEditor imageUrl={p.urls.full} width={p.width} height={p.height} texts={texts} onChange={(t) => { setTexts(t); if (editable) textSaver.queue(p.id, t); }} languages={meta.languages} language={language} setLanguage={setLanguage} />
        )}
      </main>
      {preview && <PreviewDialog page={readerPage} rtl={rtl} onClose={() => setPreview(false)} />}
      <VerifyEmailPrompt />
    </div>
  );
}
