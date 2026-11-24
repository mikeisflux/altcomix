import { useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, CircleAlert, Clock, Lock, ShieldCheck } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { api } from '@/lib/api';
import { useSession } from '@/lib/session';
import { Button, LinkButton, Modal, Spinner, cx, toast } from '@/ui';
import { checkoutSurfaceFor } from './checkoutSurface';
import type { CheckoutSurface } from './checkoutSurface';

/**
 * The one place a card payment happens in the web app: store orders, tips,
 * gift cards, page credits, the reader paywall, starting a membership and
 * changing its card all end up in `SecureCheckoutDialog`.
 *
 * The card form itself is served by the payment processor. On desktop (and
 * Android Chrome) it is framed inside our own dialog ('embed'), under our own
 * heading and order summary, and the buyer never leaves the page. iPhones,
 * iPads and in-app browsers cannot type into a framed card form, so they get
 * our panel with a button that takes the whole page to the form ('redirect');
 * they come back through /checkout/return or /account/membership.
 *
 * The framed page talks to us with window messages (`ready`, `resize`,
 * `complete`). A message only says "ask now": what the buyer is told always
 * comes from our own server (`check`), which asks the processor. A timer asks
 * as well, in case the message never arrives.
 */

export type { CheckoutSurface };

/** What the API hands back when a payment needs the card form. */
export type PaymentSession = { url: string; session_id: string; surface: CheckoutSurface };

/** Our server's answer to "how did it go?". */
export type PaymentCheck = { state: 'pending' | 'paid' | 'failed' | 'expired' | 'canceled'; message?: string | null };

export type SecurePaymentRequest = {
  session: PaymentSession;
  /** What is being paid for, shown above the card form. */
  lines: { label: string; detail?: string; amount?: string }[];
  /** Rows under the lines; the last one is the amount (shown strong). */
  totals?: { label: string; amount: string }[];
  /** The amount on the "Continue to secure checkout" button, when money moves now. */
  payLabel?: string;
  /** A sentence under the summary (when the card is charged, what renews …). */
  note?: ReactNode;
  /** Ask our server how the payment went. Called often; must be safe to repeat. */
  check: () => Promise<PaymentCheck>;
  /** Runs once the server says it is paid, after the session and every query have been refreshed. */
  onPaid?: () => void | Promise<void>;
  success: { title: string; body: ReactNode; action?: { label: string; to: string } };
  /** Offered after a payment that did not go through. */
  onRetry?: () => void;
  /** The dialog has gone away, for whatever reason. */
  onClosed?: () => void;
};

/** The message namespace the hosted payment page uses. Never shown to anyone. */
const MESSAGE_NAMESPACE = 'divinitycoin-checkout';
/** Height of the frame until the page reports its own. */
const INITIAL_FRAME_HEIGHT = 480;
/** Backstop: first ask 30 seconds in, then every 10. */
const BACKSTOP_DELAY_MS = 30_000;
const BACKSTOP_EVERY_MS = 10_000;
/** After the page says it is done: ask every 2 seconds, for up to about half a minute. */
const SETTLE_EVERY_MS = 2_000;
const SETTLE_TRIES = 15;
const SLOW_FRAME_MS = 15_000;

declare global {
  interface Window {
    /** Test hook: shortens the timers above (milliseconds) so the backstop can be exercised quickly. */
    __checkoutTimings?: { backstopDelay?: number; backstopEvery?: number; settleEvery?: number };
  }
}
const timing = (key: 'backstopDelay' | 'backstopEvery' | 'settleEvery', fallback: number) => window.__checkoutTimings?.[key] ?? fallback;

const FALLBACK: Record<'failed' | 'expired' | 'canceled', string> = {
  failed: 'The card was not accepted, so nothing was charged.',
  expired: 'The payment form timed out before it was paid, so nothing was charged.',
  canceled: 'The payment was cancelled before it finished, so nothing was charged.',
};

/** Which surface this browser gets. The owner can switch the framed form off for everyone. */
export function useCheckoutSurface(): CheckoutSurface {
  const { settings } = useSession();
  return useMemo(() => {
    if (settings.payments.embed_checkout === false) return 'redirect';
    return checkoutSurfaceFor(navigator.userAgent, navigator.maxTouchPoints);
  }, [settings.payments.embed_checkout]);
}

/** `check` for a store order: GET /api/orders/:id confirms a pending order with the processor before answering. */
export function orderCheck(orderId: string, sessionId: string): () => Promise<PaymentCheck> {
  return async () => {
    const { order } = await api<{ order: { payment_state: string; failure: string | null } }>(`/api/orders/${encodeURIComponent(orderId)}`, { query: { session_id: sessionId } });
    const s = order.payment_state;
    if (s === 'paid' || s === 'refunded') return { state: 'paid' };
    if (s === 'failed' || s === 'expired' || s === 'canceled') return { state: s, message: order.failure };
    return { state: 'pending' };
  };
}

/** `check` for a membership card (starting one, or replacing the card): GET /api/membership?session_id=. */
export function membershipCheck(sessionId: string): () => Promise<PaymentCheck> {
  return async () => {
    const r = await api<{ confirmation: string | null; confirmation_message: string | null }>('/api/membership', { query: { session_id: sessionId } });
    const c = r.confirmation;
    if (c === 'active' || c === 'updated') return { state: 'paid' };
    if (c === 'declined' || c === 'failed') return { state: 'failed', message: r.confirmation_message ?? 'The card was not accepted, so nothing was charged and nothing changed.' };
    if (c === 'expired' || c === 'canceled') return { state: c, message: r.confirmation_message };
    return { state: 'pending' };
  };
}

type Stage =
  | { at: 'pay' }
  | { at: 'confirming' }
  | { at: 'waiting' }
  | { at: 'unsure' }
  | { at: 'paid' }
  | { at: 'failed'; message: string };

function Summary({ request }: { request: SecurePaymentRequest }) {
  const totals = request.totals ?? [];
  return (
    <div className="rounded-xl border border-line text-sm">
      <ul className="divide-y divide-line">
        {request.lines.map((l, i) => (
          <li key={i} className="flex items-start justify-between gap-3 px-3.5 py-2.5">
            <span className="min-w-0">
              <span className="block font-medium">{l.label}</span>
              {l.detail && <span className="block text-xs text-muted">{l.detail}</span>}
            </span>
            {l.amount && <span className="shrink-0 tabular-nums">{l.amount}</span>}
          </li>
        ))}
      </ul>
      {totals.length > 0 && (
        <dl className="space-y-1 border-t border-line px-3.5 py-2.5">
          {totals.map((t, i) => {
            const last = i === totals.length - 1;
            return (
              <div key={i} className={cx('flex justify-between gap-4', last && 'text-base font-semibold')}>
                <dt className={cx(!last && 'text-muted')}>{t.label}</dt>
                <dd className="tabular-nums">{t.amount}</dd>
              </div>
            );
          })}
        </dl>
      )}
    </div>
  );
}

/** The processor's card form, framed. Reports `ready`/`complete`; trusts nothing else it is told. */
function PaymentFrame({ session, onReady, onComplete }: { session: PaymentSession; onReady: () => void; onComplete: () => void }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [ready, setReady] = useState(false);
  const [slow, setSlow] = useState(false);
  const [height, setHeight] = useState(INITIAL_FRAME_HEIGHT);
  // Messages are accepted from the page we framed and nowhere else. Taken from the session's own
  // address rather than written down here, so a processor reached on another host still works.
  const origin = useMemo(() => {
    try {
      return new URL(session.url, window.location.href).origin;
    } catch {
      return null;
    }
  }, [session.url]);

  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (!origin || e.origin !== origin) return;
      if (frame.current && e.source !== frame.current.contentWindow) return;
      const d = e.data as { namespace?: unknown; type?: unknown; sessionId?: unknown; height?: unknown; disableAutoRedirect?: unknown } | null;
      if (!d || typeof d !== 'object' || d.namespace !== MESSAGE_NAMESPACE) return;
      // A message about some other session (an earlier attempt still open in the page's history).
      if (d.sessionId !== session.session_id) return;
      if (d.type === 'ready') setReady(true);
      else if (d.type === 'resize') {
        if (typeof d.height === 'number' && d.height > 0) setHeight(Math.min(Math.max(Math.ceil(d.height), 240), 2400));
      } else if (d.type === 'complete') {
        // The session was created with disableAutoRedirect so that the page stays put when it finishes.
        // If it says otherwise it is about to navigate the whole browser away from us.
        if (d.disableAutoRedirect === false) {
          console.warn('[secure checkout] the payment page reported disableAutoRedirect=false on completion: it may navigate the browser away. Check how the checkout session is created.');
        }
        setReady(true);
        // Whatever status the message carries is ignored: our server is asked.
        onComplete();
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [origin, session.session_id, onComplete]);

  useEffect(() => {
    if (ready) return;
    const t = setTimeout(() => setSlow(true), SLOW_FRAME_MS);
    return () => clearTimeout(t);
  }, [ready]);
  useEffect(() => {
    if (ready) onReady();
  }, [ready, onReady]);

  return (
    <div className="relative w-full overflow-hidden rounded-xl border border-line bg-paper">
      {!ready && (
        <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 bg-surface px-6 text-center" data-testid="payment-veil">
          <Spinner className="size-7" />
          <p className="text-sm text-muted">{slow ? 'The payment form is taking longer than usual to load.' : 'Loading the secure payment form…'}</p>
          {slow && <p className="text-xs text-faint">Check your connection. If it does not appear, close this and try again; nothing has been charged.</p>}
        </div>
      )}
      <iframe
        ref={frame}
        src={session.url}
        title="Secure payment form"
        allow="payment *; publickey-credentials-get *"
        className="block w-full border-0 transition-[height] duration-200"
        style={{ height }}
        data-testid="payment-frame"
      />
    </div>
  );
}

/**
 * Our own dialog around a card payment. `request` null keeps it closed.
 * Closing it part-way is safe: the order simply stays unpaid, and one last
 * check with the server catches a payment that did finish.
 */
export function SecureCheckoutDialog({ request, onClose }: { request: SecurePaymentRequest | null; onClose: () => void }) {
  // Keyed by session: every payment starts from a clean slate, with no state left over from the one before.
  return request ? <SecurePayment key={request.session.session_id} request={request} onClose={onClose} /> : null;
}

function SecurePayment({ request, onClose }: { request: SecurePaymentRequest; onClose: () => void }) {
  const { settings, refresh } = useSession();
  const qc = useQueryClient();
  const [stage, setStage] = useState<Stage>({ at: 'pay' });
  const [asking, setAsking] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [going, setGoing] = useState(false);
  // The card form is on screen, so there may be something typed into it to lose.
  const [formShown, setFormShown] = useState(false);
  const shown = useCallback(() => setFormShown(true), []);
  // Latches. `finished`: a final answer has been shown (a late duplicate "complete" must not act twice).
  // `settling`: the page said it is done and we are asking the server until it agrees.
  const finished = useRef(false);
  const settling = useRef(false);
  // The request while this dialog is on screen; null once it has gone, so nothing late touches its state.
  const live = useRef<SecurePaymentRequest | null>(request);
  useEffect(() => {
    live.current = request;
    return () => {
      live.current = null;
    };
  }, [request]);
  const sessionId = request.session.session_id;

  /** The server says it is paid: bring the whole app up to date, then say so. */
  const succeed = useCallback(async (req: SecurePaymentRequest, shown: boolean) => {
    if (finished.current) return;
    finished.current = true;
    try {
      await refresh();
      await qc.invalidateQueries();
      await req.onPaid?.();
    } finally {
      if (shown && live.current === req) setStage({ at: 'paid' });
    }
  }, [refresh, qc]);

  const fail = useCallback((req: SecurePaymentRequest, r: PaymentCheck) => {
    if (finished.current) return;
    finished.current = true;
    // Reserved store credit has gone back to the wallet, and a membership that did not start must not look started.
    void refresh();
    void qc.invalidateQueries();
    if (live.current === req) setStage({ at: 'failed', message: r.message || FALLBACK[r.state === 'expired' || r.state === 'canceled' ? r.state : 'failed'] });
  }, [refresh, qc]);

  /** The page reported it is done (or the buyer pressed "Check again"): ask until the server has an answer. */
  const settle = useCallback(async () => {
    const req = live.current;
    if (!req || finished.current || settling.current) return;
    settling.current = true;
    setStage({ at: 'confirming' });
    try {
      for (let i = 0; i < SETTLE_TRIES; i++) {
        if (live.current !== req || finished.current) return;
        const r = await req.check();
        // Paid counts even if the dialog was closed while we were asking: the app still has to catch up.
        if (r.state === 'paid') return void (await succeed(req, true));
        if (live.current !== req) return;
        if (r.state !== 'pending') return fail(req, r);
        await new Promise((done) => setTimeout(done, timing('settleEvery', SETTLE_EVERY_MS)));
      }
      if (live.current === req && !finished.current) setStage({ at: 'waiting' });
    } catch {
      // Our own server could not be reached. The payment may well have gone through, so claim nothing.
      if (live.current === req && !finished.current) setStage({ at: 'unsure' });
    } finally {
      settling.current = false;
    }
  }, [succeed, fail]);

  // Backstop for the framed form: the "complete" message can go missing (a blocked message, a closed
  // pop-up, a dropped connection), which would leave the buyer looking at a finished form with nothing
  // happening. Ask the server on a timer for as long as no answer has been shown.
  const embedded = request.session.surface === 'embed';
  useEffect(() => {
    if (!embedded) return;
    let every: ReturnType<typeof setInterval> | undefined;
    const ask = async () => {
      const req = live.current;
      if (!req || finished.current || settling.current) return;
      try {
        const r = await req.check();
        if (live.current !== req || finished.current || settling.current) return;
        if (r.state === 'paid') await succeed(req, true);
        else if (r.state !== 'pending') fail(req, r);
      } catch {
        // A passing network error: the next tick asks again.
      }
    };
    const first = setTimeout(() => {
      void ask();
      every = setInterval(() => void ask(), timing('backstopEvery', BACKSTOP_EVERY_MS));
    }, timing('backstopDelay', BACKSTOP_DELAY_MS));
    return () => {
      clearTimeout(first);
      if (every) clearInterval(every);
    };
  }, [sessionId, embedded, succeed, fail]);

  const site = settings.site.name;
  const unfinished = stage.at !== 'paid' && stage.at !== 'failed';

  const close = () => {
    const req = request;
    if (unfinished && embedded) {
      toast.message('Payment not finished', { description: 'Nothing was charged unless you completed the payment. If you did, it will show in your account in a moment.' });
      // One last look, in case the payment did finish while the dialog was closing. The order stays open either way.
      void req.check().then((r) => {
        if (r.state !== 'paid' || finished.current) return;
        return succeed(req, false).then(() => void toast.success('Payment complete'));
      }).catch(() => {});
    }
    onClose();
    req.onClosed?.();
  };
  /** Backdrop, Escape and the close button all land here: a half-typed card form is not thrown away by a stray click. */
  const requestClose = () => {
    if (going) return;
    if (stage.at === 'pay' && embedded && formShown && !leaving) return setLeaving(true);
    close();
  };

  // The Modal re-focuses itself whenever its onClose changes, which would pull the cursor out of the card form
  // on every re-render (each "resize" message causes one). Hand it one function for the life of the dialog.
  const closer = useRef(requestClose);
  closer.current = requestClose;
  const stableClose = useCallback(() => closer.current(), []);

  const checkAgain = async () => {
    setAsking(true);
    await settle();
    setAsking(false);
  };

  let body: ReactNode;
  let footer: ReactNode = null;
  if (stage.at === 'paid') {
    body = (
      <div className="flex flex-col items-center gap-3 py-4 text-center" role="status">
        <CheckCircle2 className="size-10 text-ok" aria-hidden />
        <p className="font-semibold">{request.success.title}</p>
        <p className="text-sm text-muted">{request.success.body}</p>
      </div>
    );
    footer = request.success.action ? (
      <>
        <Button variant="ghost" onClick={close}>Close</Button>
        <LinkButton to={request.success.action.to} variant="primary">{request.success.action.label}</LinkButton>
      </>
    ) : (
      <Button variant="primary" onClick={close}>Done</Button>
    );
  } else if (stage.at === 'failed') {
    body = (
      <div className="flex flex-col items-center gap-3 py-4 text-center" role="alert">
        <CircleAlert className="size-10 text-danger" aria-hidden />
        <p className="font-semibold">The payment did not go through</p>
        <p className="text-sm text-muted">{stage.message}</p>
      </div>
    );
    footer = request.onRetry ? (
      <>
        <Button variant="ghost" onClick={close}>Close</Button>
        <Button variant="primary" onClick={() => { const retry = request.onRetry!; onClose(); retry(); }}>Try again</Button>
      </>
    ) : (
      <Button variant="primary" onClick={close}>Close</Button>
    );
  } else if (stage.at === 'confirming') {
    body = (
      <div className="flex flex-col items-center gap-3 py-8 text-center" role="status">
        <Spinner className="size-8" />
        <p className="font-semibold">Confirming your payment</p>
        <p className="text-sm text-muted">This usually takes a few seconds. Keep this open.</p>
      </div>
    );
  } else if (stage.at === 'waiting' || stage.at === 'unsure') {
    body = (
      <div className="flex flex-col items-center gap-3 py-4 text-center" role="status">
        <Clock className="size-10 text-warn" aria-hidden />
        <p className="font-semibold">{stage.at === 'waiting' ? 'Still waiting for confirmation' : 'We could not check your payment'}</p>
        <p className="text-sm text-muted">
          {stage.at === 'waiting'
            ? 'The payment has not been confirmed yet. It can take a few minutes, and nothing is lost: it shows in your account as soon as it clears.'
            : `We could not reach ${site} to confirm the payment. If your card was charged, it will show in your account within a few minutes. Please do not pay again until you have checked.`}
        </p>
      </div>
    );
    footer = (
      <>
        <Button variant="ghost" onClick={close}>Close</Button>
        <Button variant="primary" loading={asking} onClick={checkAgain}>Check again</Button>
      </>
    );
  } else if (embedded) {
    body = (
      <div className="space-y-4">
        <Summary request={request} />
        {request.note && <p className="text-sm text-muted">{request.note}</p>}
        {leaving && (
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-warn/30 bg-warn-soft px-4 py-3 text-sm" role="alertdialog" aria-label="Leave the payment?">
            <p className="min-w-0 flex-1 text-warn">Leave without paying? Nothing is charged unless you finish the payment.</p>
            <div className="flex gap-2">
              <Button size="sm" className="h-10" onClick={() => setLeaving(false)}>Keep paying</Button>
              <Button size="sm" className="h-10" variant="danger" onClick={close}>Leave</Button>
            </div>
          </div>
        )}
        <PaymentFrame session={request.session} onReady={shown} onComplete={settle} />
        <p className="flex items-start gap-2 text-xs text-faint">
          <ShieldCheck className="mt-0.5 size-3.5 shrink-0 text-ok" aria-hidden />
          <span>Your card details go straight to our payment processor over an encrypted connection. {site} never sees or stores them.</span>
        </p>
      </div>
    );
  } else {
    body = (
      <div className="space-y-4">
        <Summary request={request} />
        {request.note && <p className="text-sm text-muted">{request.note}</p>}
        <p className="text-sm text-muted">
          You will enter your card on our secure checkout page and come straight back here when you are done. {site} never sees or stores your card details.
        </p>
        <Button
          variant="primary"
          size="lg"
          block
          loading={going}
          icon={<Lock className="size-4" aria-hidden />}
          onClick={() => {
            setGoing(true);
            window.location.assign(request.session.url);
          }}
        >
          {going ? 'Opening secure checkout…' : `Continue to secure checkout${request.payLabel ? ` · ${request.payLabel}` : ''}`}
        </Button>
        <p className="flex items-start gap-2 text-xs text-faint">
          <ShieldCheck className="mt-0.5 size-3.5 shrink-0 text-ok" aria-hidden />
          <span>Encrypted end to end. If you come back without paying, nothing is charged.</span>
        </p>
      </div>
    );
    footer = <Button variant="ghost" onClick={close} disabled={going}>Cancel</Button>;
  }

  const title = stage.at === 'paid' ? 'Thank you' : <span className="inline-flex items-center gap-2"><Lock className="size-4 text-ok" aria-hidden />Secure payment</span>;
  return (
    <Modal open onClose={stableClose} title={title} size={stage.at === 'pay' && embedded ? 'md' : 'sm'} footer={footer}>
      {body}
    </Modal>
  );
}

/** State holder: `secure.open({...})` after the API returned a session, and render `secure.dialog` once. */
export function useSecureCheckout() {
  const [request, setRequest] = useState<SecurePaymentRequest | null>(null);
  const close = useCallback(() => setRequest(null), []);
  return {
    open: (r: SecurePaymentRequest) => setRequest(r),
    close,
    active: Boolean(request),
    dialog: <SecureCheckoutDialog request={request} onClose={close} />,
  };
}
