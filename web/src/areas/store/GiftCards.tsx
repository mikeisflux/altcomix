import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Copy, Gift, Ticket } from 'lucide-react';
import { useState } from 'react';
import type { FormEvent } from 'react';
import { Link } from 'react-router';
import { api, errorMessage } from '@/lib/api';
import { date, money, moneyExact } from '@/lib/format';
import { useSession } from '@/lib/session';
import { Badge, Button, Card, ErrorState, Field, Input, LinkButton, MoneyInput, Segmented, Skeleton, Textarea, toast } from '@/ui';
import { CreditChoice, useOrderPayment } from './Checkout';
import { ConfirmEmailPrompt, isEmailUnverified, useLoginLink, useTitle } from './shared';

type Bought = { id: string; code: string; amount_cents: number; balance_cents: number; recipient_email: string | null; message: string | null; redeemed: boolean; created_at: string };

const PRESETS = [1000, 2500, 5000, 10000];
const MIN = 500;
const MAX = 50_000;

export function GiftCards() {
  useTitle('Gift cards');
  const { user, currency, refresh } = useSession();
  const qc = useQueryClient();
  const login = useLoginLink();
  const [amount, setAmount] = useState<number | null>(2500);
  const [custom, setCustom] = useState(false);
  const [email, setEmail] = useState('');
  const [message, setMessage] = useState('');
  const [useCredit, setUseCredit] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [unverified, setUnverified] = useState<string | null>(null);

  const payment = useOrderPayment();

  const mine = useQuery({ queryKey: ['gift-cards', user?.id], queryFn: () => api<{ bought: Bought[] }>('/api/account/gift-cards'), enabled: Boolean(user) });

  const cents = amount ?? 0;
  const problem = cents < MIN ? `Gift cards start at ${money(MIN, currency)}.` : cents > MAX ? `Gift cards go up to ${money(MAX, currency)}.` : null;
  const credit = useCredit ? Math.min(user?.wallet.credit_cents ?? 0, cents) : 0;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (problem) return setError(problem);
    setBusy(true);
    setError(null);
    setUnverified(null);
    const to = email.trim();
    const bought = () => {
      toast.success(to ? `Gift card sent to ${to}` : 'Gift card bought. The code is below.');
      setEmail('');
      setMessage('');
    };
    try {
      const outcome = await payment.pay(
        { items: [{ kind: 'gift_card', amount_cents: cents, recipient_email: to || undefined, message: message.trim() || undefined }], use_credit: credit > 0, return_to: '/gift-cards' },
        {
          lines: [{ label: `Gift card ${money(cents, currency)}`, detail: to ? `Emailed to ${to}` : 'The code is shown to you to pass on', price_cents: cents }],
          credit_cents: credit,
          onPaid: bought,
          success: { body: to ? `We have emailed the gift card to ${to}. It is also listed on this page.` : 'Your gift card code is on this page, ready to copy and pass on.' },
        },
      );
      // 'paying': the secure payment dialog has taken over and reports back through `onPaid`.
      if (outcome === 'completed') {
        await refresh();
        await qc.invalidateQueries({ queryKey: ['gift-cards'] });
        bought();
      }
    } catch (err) {
      if (isEmailUnverified(err)) setUnverified(errorMessage(err));
      else setError(errorMessage(err));
    }
    setBusy(false);
  };

  const copy = async (code: string) => {
    try {
      await navigator.clipboard.writeText(code);
      toast.success('Code copied');
    } catch {
      toast.message('Copy this code', { description: code });
    }
  };

  return (
    <div className="mx-auto max-w-5xl">
      {payment.dialog}
      <header className="mb-6">
        <h1 className="text-2xl font-bold sm:text-3xl">Gift cards</h1>
        <p className="mt-1.5 max-w-2xl text-muted">Give someone store credit to spend on any comic, bundle or tip. Credit never expires.</p>
      </header>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_340px]">
        <Card className="p-5 sm:p-6">
          <h2 className="flex items-center gap-2 text-lg font-semibold"><Gift className="size-5 text-accent-hover" aria-hidden />Buy a gift card</h2>
          <form onSubmit={submit} className="mt-4 space-y-5">
            <div>
              <div className="mb-1.5 text-[13px] font-medium">Amount</div>
              <Segmented
                value={custom ? 'custom' : String(amount)}
                onChange={(v) => {
                  if (v === 'custom') setCustom(true);
                  else {
                    setCustom(false);
                    setAmount(Number(v));
                  }
                }}
                options={[...PRESETS.map((p) => ({ value: String(p), label: money(p, currency) })), { value: 'custom', label: 'Other amount' }]}
              />
            </div>
            {custom && (
              <Field label="Your amount" hint={`Between ${money(MIN, currency)} and ${money(MAX, currency)}.`} error={amount !== null && problem ? problem : null}>
                <MoneyInput cents={amount} onChange={setAmount} />
              </Field>
            )}
            <Field label="Recipient's email" optional hint="We email them the code and your message. Leave it empty to get the code yourself and pass it on.">
              <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} maxLength={200} autoComplete="off" placeholder="friend@example.com" />
            </Field>
            <Field label="Message" optional>
              <Textarea value={message} onChange={(e) => setMessage(e.target.value)} maxLength={500} className="min-h-24" placeholder="Happy birthday! Go read something great." />
            </Field>
            {user && <CreditChoice total={cents} checked={useCredit} onChange={setUseCredit} />}
            {error && <ErrorState message={error} />}
            {user ? (
              <Button type="submit" variant="primary" size="lg" block loading={busy} disabled={Boolean(problem) || !user.email_verified}>
                Buy gift card{cents >= MIN && !problem ? ` · ${moneyExact(cents - credit, currency)}` : ''}
              </Button>
            ) : (
              <LinkButton to={login} variant="primary" size="lg" block>Sign in to buy a gift card</LinkButton>
            )}
            {user && (unverified || !user.email_verified) && <ConfirmEmailPrompt message={unverified ?? `Confirm your email to buy gift cards. We sent a link to ${user.email} when you signed up.`} onConfirmed={() => setUnverified(null)} />}
          </form>
        </Card>

        <div className="space-y-6">
          <Card className="p-5">
            <h2 className="flex items-center gap-2 text-lg font-semibold"><Ticket className="size-5 text-muted" aria-hidden />Got a gift card?</h2>
            <p className="mt-1.5 text-sm text-muted">Enter the code on the redeem page. The full amount is added to your account as store credit, and you choose when to use it at checkout.</p>
            <LinkButton to="/account/codes" className="mt-3">Redeem a code</LinkButton>
            {user && user.wallet.credit_cents > 0 && <p className="mt-3 text-sm">Your store credit: <strong>{moneyExact(user.wallet.credit_cents, currency)}</strong></p>}
          </Card>

          {user && (
            <Card className="p-5">
              <h2 className="text-lg font-semibold">Cards you bought</h2>
              {mine.isLoading ? (
                <Skeleton className="mt-3 h-16" />
              ) : mine.isError ? (
                <div className="mt-3"><ErrorState message={errorMessage(mine.error)} retry={() => void mine.refetch()} /></div>
              ) : !mine.data?.bought.length ? (
                <p className="mt-1.5 text-sm text-muted">None yet. Codes for cards you buy appear here so you can pass them on.</p>
              ) : (
                <ul className="mt-3 space-y-3">
                  {mine.data.bought.map((g) => (
                    <li key={g.id} className="rounded-xl border border-line bg-ink p-3">
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-display text-lg font-bold">{money(g.amount_cents, currency)}</span>
                        {g.redeemed ? <Badge tone="neutral">Redeemed</Badge> : <Badge tone="ok">Not used yet</Badge>}
                      </div>
                      <div className="mt-1.5 flex items-center justify-between gap-2">
                        <code className="min-w-0 break-all text-sm">{g.code}</code>
                        {!g.redeemed && <Button size="sm" variant="ghost" icon={<Copy className="size-4" />} onClick={() => void copy(g.code)} aria-label={`Copy code ${g.code}`}>Copy</Button>}
                      </div>
                      <div className="mt-1 text-xs text-faint">{date(g.created_at)}{g.recipient_email ? ` · sent to ${g.recipient_email}` : ''}</div>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          )}
        </div>
      </div>
      <p className="mt-6 text-sm text-faint">Gift cards are store credit, not cash, and cannot be refunded once redeemed. See the <Link to="/p/terms" className="link">terms</Link>.</p>
    </div>
  );
}
