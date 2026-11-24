import { useMutation } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight, Flag, Share2 } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Link, useLocation } from 'react-router';
import { api, errorMessage } from '@/lib/api';
import { useSession } from '@/lib/session';
import { Button, Field, LinkButton, Modal, Select, Skeleton, Textarea, cx, toast } from '@/ui';

/** Sets the browser tab title for the current page. */
export function useTitle(title: string | null | undefined) {
  const { settings } = useSession();
  useEffect(() => {
    document.title = title ? `${title} · ${settings.site.name}` : settings.site.name;
  }, [title, settings.site.name]);
}

/** `/login?next=<here>` so a reader comes back to the same page after signing in. */
export function useLoginLink(): string {
  const loc = useLocation();
  return `/login?next=${encodeURIComponent(loc.pathname + loc.search)}`;
}

/** Only follow same-site paths handed to us in `?next=`. */
export function safeNext(next: string | null | undefined, fallback: string): string {
  return next && /^\/(?!\/)[^\\\s]*$/.test(next) ? next : fallback;
}

/** Share through the device's share sheet when it has one, otherwise copy the link. */
export async function sharePage(title: string, path?: string) {
  const url = path ? new URL(path, window.location.origin).toString() : window.location.href;
  if (typeof navigator.share === 'function') {
    try {
      await navigator.share({ title, url });
      return;
    } catch (e) {
      if ((e as Error).name === 'AbortError') return;
    }
  }
  try {
    await navigator.clipboard.writeText(url);
    toast.success('Link copied');
  } catch {
    toast.message('Copy this link', { description: url });
  }
}

export function ShareButton({ title, path, size = 'md' }: { title: string; path?: string; size?: 'sm' | 'md' }) {
  return <Button size={size} icon={<Share2 className="size-4" />} onClick={() => void sharePage(title, path)}>Share</Button>;
}

const REASONS = ['Stolen or pirated work', 'Made with generative AI', 'Missing mature-content label', 'Hateful or harassing', 'Spam or scam', 'Illegal content', 'Something else'];

type ReportTarget = { kind: 'series' | 'release' | 'publisher' | 'user' | 'comment'; id: string; name: string };

/** Report something to the moderators. `target` null keeps the dialog closed. */
export function ReportDialog({ target, onClose }: { target: ReportTarget | null; onClose: () => void }) {
  const { user } = useSession();
  const login = useLoginLink();
  const [reason, setReason] = useState(REASONS[0]);
  const [detail, setDetail] = useState('');
  useEffect(() => {
    if (target) {
      setReason(REASONS[0]);
      setDetail('');
    }
  }, [target]);
  const send = useMutation({
    mutationFn: () =>
      target!.kind === 'comment'
        ? api(`/api/comments/${target!.id}/report`, { json: { reason, detail } })
        : api('/api/reports', { json: { target_kind: target!.kind, target_id: target!.id, reason, detail } }),
    onSuccess: () => {
      toast.success('Report sent. A moderator will look at it.');
      onClose();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  return (
    <Modal
      open={Boolean(target)}
      onClose={onClose}
      title={`Report ${target?.name ?? ''}`}
      size="sm"
      footer={
        user ? (
          <>
            <Button variant="ghost" onClick={onClose}>Cancel</Button>
            <Button variant="primary" loading={send.isPending} onClick={() => send.mutate()}>Send report</Button>
          </>
        ) : (
          <LinkButton to={login} variant="primary">Sign in to report</LinkButton>
        )
      }
    >
      {user ? (
        <div className="space-y-4">
          <Field label="What is wrong?">
            <Select value={reason} onChange={(e) => setReason(e.target.value)}>
              {REASONS.map((r) => <option key={r}>{r}</option>)}
            </Select>
          </Field>
          <Field label="Details" optional hint="Links or page numbers help the moderators check quickly.">
            <Textarea value={detail} onChange={(e) => setDetail(e.target.value)} maxLength={2000} />
          </Field>
        </div>
      ) : (
        <p className="text-sm text-muted">Reports are tied to an account so moderators can follow up with you.</p>
      )}
    </Modal>
  );
}

export function ReportIcon() {
  return <Flag className="size-4" aria-hidden />;
}

/**
 * A titled horizontal row that scrolls with snap. Arrow buttons appear on
 * desktop and switch off at either end.
 */
export function Shelf({ title, subtitle, action, children, id }: { title: ReactNode; subtitle?: ReactNode; action?: ReactNode; children: ReactNode; id?: string }) {
  const scroller = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({ start: true, end: true });
  const measure = useCallback(() => {
    const el = scroller.current;
    if (!el) return;
    setEdges({ start: el.scrollLeft <= 4, end: el.scrollLeft + el.clientWidth >= el.scrollWidth - 4 });
  }, []);
  useEffect(() => {
    measure();
    const el = scroller.current;
    if (!el) return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [measure, children]);
  const move = (dir: 1 | -1) => scroller.current?.scrollBy({ left: dir * scroller.current.clientWidth * 0.85, behavior: 'smooth' });
  const arrow = 'hidden size-9 items-center justify-center rounded-full border border-line bg-raised text-paper transition-colors hover:bg-hover disabled:opacity-30 md:inline-flex';
  return (
    <section aria-labelledby={id} className="min-w-0">
      <div className="mb-3 flex items-end justify-between gap-3">
        <div className="min-w-0">
          <h2 id={id} className="text-xl font-bold sm:text-2xl">{title}</h2>
          {subtitle && <div className="mt-1 text-sm text-muted">{subtitle}</div>}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {action}
          {!(edges.start && edges.end) && (
            <>
              <button type="button" aria-label="Scroll back" className={arrow} disabled={edges.start} onClick={() => move(-1)}><ChevronLeft className="size-5" /></button>
              <button type="button" aria-label="Scroll forward" className={arrow} disabled={edges.end} onClick={() => move(1)}><ChevronRight className="size-5" /></button>
            </>
          )}
        </div>
      </div>
      <div ref={scroller} onScroll={measure} className="no-scrollbar -mx-4 flex snap-x snap-mandatory scroll-px-4 gap-4 overflow-x-auto px-4 pb-1 sm:-mx-6 sm:scroll-px-6 sm:px-6 lg:-mx-8 lg:scroll-px-8 lg:px-8">
        {children}
      </div>
    </section>
  );
}

/** Width of one card inside a Shelf. */
export const SHELF_ITEM = 'w-[138px] shrink-0 snap-start sm:w-[168px]';

export function ShelfSkeleton() {
  return (
    <div>
      <Skeleton className="mb-3 h-7 w-48" />
      <div className="flex gap-4 overflow-hidden">
        {Array.from({ length: 8 }, (_, i) => <Skeleton key={i} className="aspect-[2/3] w-[138px] shrink-0 sm:w-[168px]" />)}
      </div>
    </div>
  );
}

export function GridSkeleton({ count = 12 }: { count?: number }) {
  return (
    <div className="grid grid-cols-2 gap-x-4 gap-y-6 min-[480px]:grid-cols-3 md:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-6">
      {Array.from({ length: count }, (_, i) => <Skeleton key={i} className="aspect-[2/3] w-full" />)}
    </div>
  );
}

export function SectionLink({ to, children }: { to: string; children: ReactNode }) {
  return <Link to={to} className={cx('inline-flex h-10 items-center text-sm font-medium text-accent-hover hover:text-paper')}>{children}</Link>;
}
