import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, CircleAlert, Wallet } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { api, errorMessage } from '@/lib/api';
import { moneyExact } from '@/lib/format';
import { useSession } from '@/lib/session';
import { Button, Card, Checkbox, ErrorState, Field, Input, LinkButton, Modal, Notice, Spinner, toast } from '@/ui';
import { safeNext, useLoginLink, useTitle } from './shared';

/** One basket line exactly as POST /api/checkout accepts it. */
export type CheckoutItem =
  | { kind: 'release' | 'download' | 'bundle'; id: string }
  | { kind: 'series'; id: string }
  | { kind: 'tip'; id: string; amount_cents: number; message?: string; show_amount?: boolean }
  | { kind: 'gift_card'; amount_cents: number; recipient_email?: string; message?: string };

export type CheckoutLine = { item: CheckoutItem; label: string; detail?: string; price_cents: number; list_price_cents?: number | null };

export type CheckoutRequest = { lines: CheckoutLine[]; returnTo: string; allowCode?: boolean };

type CheckoutResponse = { url?: string; completed?: boolean; order_id: string; return_to?: string };

/** Start paying. Resolves `true` when the order is already complete, `false` when the browser is leaving for the card page. */
export async function startCheckout(body: { items: CheckoutItem[]; code?: string; use_credit?: boolean; return_to: string }): Promise<boolean> {
  const r = await api<CheckoutResponse>('/api/checkout', { json: body });
  if (r.url) {
    window.location.assign(r.url);
    return false;
  }
  return true;
}

/** "Use my store credit" row; renders nothing when the reader has none. */
export function CreditChoice({ total, checked, onChange }: { total: number; checked: boolean; onChange: (v: boolean) => void }) {
  const { user, currency } = useSession();
  const credit = user?.wallet.credit_cents ?? 0;
  if (credit <= 0) return null;
  return (
    <div className="rounded-xl border border-line bg-ink px-3.5 py-3">
      <Checkbox
        checked={checked}
        onChange={onChange}
        label={<span className="inline-flex items-center gap-1.5"><Wallet className="size-4 text-muted" aria-hidden /> Use store credit</span>}
        description={`You have ${moneyExact(credit, currency)}. ${moneyExact(Math.min(credit, total), currency)} would go towards this.`}
      />
    </div>
  );
}

/**
 * Confirmation step before money moves: what is being bought, the price,
 * store credit, a promo code. `request` null keeps it closed.
 */
export function CheckoutDialog({ request, onClose, onPaid }: { request: CheckoutRequest | null; onClose: () => void; onPaid?: () => void }) {
  const { user, currency, refresh } = useSession();
  const qc = useQueryClient();
  const login = useLoginLink();
  const [useCredit, setUseCredit] = useState(true);
  const [code, setCode] = useState('');
  const [showCode, setShowCode] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  useEffect(() => {
    if (request) {
      setUseCredit(true);
      setCode('');
      setShowCode(false);
      setError(null);
      setDone(false);
      setBusy(false);
    }
  }, [request]);

  const lines = request?.lines ?? [];
  const total = lines.reduce((n, l) => n + l.price_cents, 0);
  const credit = useCredit ? Math.min(user?.wallet.credit_cents ?? 0, total) : 0;
  const due = total - credit;

  const pay = async () => {
    if (!request) return;
    setBusy(true);
    setError(null);
    try {
      const completed = await startCheckout({ items: lines.map((l) => l.item), code: code.trim() || undefined, use_credit: useCredit && credit > 0, return_to: request.returnTo });
      if (!completed) return; // leaving for the card page
      await refresh();
      await qc.invalidateQueries();
      setDone(true);
      onPaid?.();
    } catch (e) {
      setError(errorMessage(e));
    }
    setBusy(false);
  };

  const footer = !user ? (
    <LinkButton to={login} variant="primary">Sign in to buy</LinkButton>
  ) : done ? (
    <Button variant="primary" onClick={onClose}>Done</Button>
  ) : (
    <>
      <Button variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
      <Button variant="primary" loading={busy} onClick={pay}>{due > 0 ? `Pay ${moneyExact(due, currency)}` : 'Confirm'}</Button>
    </>
  );

  return (
    <Modal open={Boolean(request)} onClose={busy ? () => {} : onClose} title={done ? 'Thank you' : 'Confirm your purchase'} size="sm" footer={footer}>
      {done ? (
        <div className="flex flex-col items-center gap-3 py-4 text-center">
          <CheckCircle2 className="size-10 text-ok" aria-hidden />
          <p className="font-semibold">Payment complete</p>
          <p className="text-sm text-muted">{lines.map((l) => l.label).join(', ')} {lines.length === 1 ? 'is' : 'are'} yours. A receipt is in your purchases.</p>
        </div>
      ) : (
        <div className="space-y-4">
          <ul className="divide-y divide-line rounded-xl border border-line">
            {lines.map((l, i) => (
              <li key={i} className="flex items-start justify-between gap-3 px-3.5 py-3 text-sm">
                <span className="min-w-0">
                  <span className="block font-medium">{l.label}</span>
                  {l.detail && <span className="block text-xs text-muted">{l.detail}</span>}
                </span>
                <span className="shrink-0 text-right tabular-nums">
                  {l.list_price_cents != null && l.list_price_cents > l.price_cents && <s className="mr-1.5 text-muted">{moneyExact(l.list_price_cents, currency)}</s>}
                  {moneyExact(l.price_cents, currency)}
                </span>
              </li>
            ))}
          </ul>

          {user && <CreditChoice total={total} checked={useCredit} onChange={setUseCredit} />}

          {request?.allowCode !== false && user && (
            showCode ? (
              <Field label="Promo code" hint="A valid discount code lowers the amount charged when you confirm.">
                <Input value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} autoFocus autoComplete="off" maxLength={40} placeholder="Enter a discount code" />
              </Field>
            ) : (
              <button type="button" className="link text-sm" onClick={() => setShowCode(true)}>Have a promo code?</button>
            )
          )}

          <dl className="space-y-1.5 border-t border-line pt-3 text-sm">
            <div className="flex justify-between"><dt className="text-muted">Subtotal</dt><dd className="tabular-nums">{moneyExact(total, currency)}</dd></div>
            {credit > 0 && <div className="flex justify-between"><dt className="text-muted">Store credit</dt><dd className="tabular-nums">−{moneyExact(credit, currency)}</dd></div>}
            <div className="flex justify-between text-base font-semibold"><dt>{code.trim() ? 'To pay, before your code' : 'To pay'}</dt><dd className="tabular-nums">{moneyExact(due, currency)}</dd></div>
          </dl>

          {!user && <Notice tone="info">Sign in or create a free account to buy. Purchases are kept in your library.</Notice>}
          {user && !user.email_verified && <Notice tone="warn">Your email is not confirmed yet, so your receipt may not reach you. Use the link we sent to {user.email}.</Notice>}
          {error && <ErrorState message={error} />}
        </div>
      )}
    </Modal>
  );
}

/** Tiny state holder so a page can say `checkout.open({...})` and render `checkout.dialog`. */
export function useCheckout(onPaid?: () => void) {
  const [request, setRequest] = useState<CheckoutRequest | null>(null);
  return {
    open: (r: CheckoutRequest) => setRequest(r),
    dialog: <CheckoutDialog request={request} onClose={() => setRequest(null)} onPaid={onPaid} />,
  };
}

type Order = {
  id: string;
  status: 'pending' | 'paid' | 'failed' | 'refunded';
  total_cents: number;
  credit_cents: number;
  charged_cents: number;
  return_to: string;
  failure: string | null;
  items: { id: string; kind: string; description: string; price_cents: number }[];
};

const MAX_POLLS = 40;

/** Where the card page sends the reader back to: wait for the order to settle, then move on. */
export function CheckoutReturn() {
  useTitle('Checkout');
  const { user, currency, refresh } = useSession();
  const qc = useQueryClient();
  const nav = useNavigate();
  const login = useLoginLink();
  const [params] = useSearchParams();
  const orderId = params.get('order') ?? '';
  const sessionId = params.get('session_id') ?? undefined;
  const cancelled = params.get('cancelled') === '1';
  const polls = useRef(0);
  const [gaveUp, setGaveUp] = useState(false);

  const query = useQuery({
    queryKey: ['order', orderId, sessionId],
    queryFn: () => api<{ order: Order }>(`/api/orders/${encodeURIComponent(orderId)}`, { query: { session_id: sessionId } }),
    enabled: Boolean(user && orderId),
    retry: false,
    refetchInterval: (q) => {
      const status = q.state.data?.order.status;
      if (q.state.error || (status && status !== 'pending') || cancelled) return false;
      polls.current += 1;
      if (polls.current >= MAX_POLLS) {
        setGaveUp(true);
        return false;
      }
      return 2000;
    },
  });
  const order = query.data?.order;
  const next = safeNext(params.get('next'), safeNext(order?.return_to, '/library'));
  const paid = order?.status === 'paid';

  useEffect(() => {
    if (!paid) return;
    void refresh();
    void qc.invalidateQueries({ predicate: (q) => q.queryKey[0] !== 'order' });
    const t = setTimeout(() => nav(next, { replace: true }), 3500);
    return () => clearTimeout(t);
  }, [paid, next, nav, refresh, qc]);

  useEffect(() => {
    if (paid) toast.success('Payment complete');
  }, [paid]);

  let body;
  if (!orderId) {
    body = (
      <>
        <CircleAlert className="size-10 text-warn" aria-hidden />
        <h1 className="text-2xl font-bold">No order to show</h1>
        <p className="text-muted">This page finishes a checkout. Your past orders are in your purchases.</p>
        <LinkButton to="/account/purchases" variant="primary">See your purchases</LinkButton>
      </>
    );
  } else if (!user) {
    body = (
      <>
        <h1 className="text-2xl font-bold">Sign in to see your order</h1>
        <p className="text-muted">Your session ended while you were paying. Sign in and we will pick up where you left off.</p>
        <LinkButton to={login} variant="primary">Sign in</LinkButton>
      </>
    );
  } else if (query.isError) {
    body = (
      <>
        <CircleAlert className="size-10 text-danger" aria-hidden />
        <h1 className="text-2xl font-bold">We could not load that order</h1>
        <ErrorState message={errorMessage(query.error)} retry={() => void query.refetch()} />
        <LinkButton to="/account/purchases">See your purchases</LinkButton>
      </>
    );
  } else if (!order) {
    body = (
      <>
        <Spinner className="size-8" />
        <p className="text-muted">Loading your order…</p>
      </>
    );
  } else if (paid) {
    body = (
      <>
        <CheckCircle2 className="size-12 text-ok" aria-hidden />
        <h1 className="text-2xl font-bold">Payment complete</h1>
        <ul className="w-full divide-y divide-line rounded-xl border border-line text-left text-sm">
          {order.items.map((i) => (
            <li key={i.id} className="flex justify-between gap-3 px-3.5 py-2.5"><span className="min-w-0">{i.description}</span><span className="shrink-0 tabular-nums">{moneyExact(i.price_cents, currency)}</span></li>
          ))}
          <li className="flex justify-between gap-3 px-3.5 py-2.5 font-semibold">
            <span>Charged{order.credit_cents > 0 ? ` (after ${moneyExact(order.credit_cents, currency)} store credit)` : ''}</span>
            <span className="tabular-nums">{moneyExact(order.charged_cents, currency)}</span>
          </li>
        </ul>
        <p className="text-sm text-muted">Taking you on in a moment…</p>
        <LinkButton to={next} variant="primary">Continue</LinkButton>
      </>
    );
  } else if (order.status === 'failed') {
    body = (
      <>
        <CircleAlert className="size-12 text-danger" aria-hidden />
        <h1 className="text-2xl font-bold">The payment did not go through</h1>
        <p className="text-muted">{order.failure ?? 'Your card was not charged.'} Any store credit you used is back in your account.</p>
        <LinkButton to={next} variant="primary">Go back and try again</LinkButton>
      </>
    );
  } else if (order.status === 'refunded') {
    body = (
      <>
        <h1 className="text-2xl font-bold">This order was refunded</h1>
        <LinkButton to="/account/purchases" variant="primary">See your purchases</LinkButton>
      </>
    );
  } else if (cancelled) {
    body = (
      <>
        <h1 className="text-2xl font-bold">Checkout cancelled</h1>
        <p className="text-muted">You left the card page before paying, so nothing was charged.</p>
        <LinkButton to={next} variant="primary">Go back</LinkButton>
      </>
    );
  } else if (gaveUp) {
    body = (
      <>
        <CircleAlert className="size-10 text-warn" aria-hidden />
        <h1 className="text-2xl font-bold">Still waiting for your bank</h1>
        <p className="text-muted">The payment has not been confirmed yet. It can take a few minutes; nothing is lost. Your purchase appears in your library as soon as it clears.</p>
        <div className="flex flex-wrap justify-center gap-2">
          <Button variant="primary" onClick={() => { polls.current = 0; setGaveUp(false); void query.refetch(); }}>Check again</Button>
          <LinkButton to="/account/purchases">See your purchases</LinkButton>
        </div>
      </>
    );
  } else {
    body = (
      <>
        <Spinner className="size-8" />
        <h1 className="text-2xl font-bold">Confirming your payment</h1>
        <p className="text-muted">This usually takes a few seconds. Keep this page open.</p>
      </>
    );
  }

  return (
    <div className="mx-auto max-w-lg py-8">
      <Card className="flex flex-col items-center gap-4 p-6 text-center sm:p-8" aria-live="polite">{body}</Card>
    </div>
  );
}
