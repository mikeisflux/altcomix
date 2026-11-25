import { useQuery } from '@tanstack/react-query';
import { Download } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router';
import { api } from '@/lib/api';
import { date, dateTime, moneyExact } from '@/lib/format';
import { useSession } from '@/lib/session';
import { Badge, Button, Card, Field, MoneyInput, Notice, Pagination, Segmented, Stat, Table, useConfirm } from '@/ui';
import { BrandPage, Q, RoleNotice, Section, bps, can, cap, useAct, useBrand } from './shared';
import { TaxBanner } from './Tax';

type Earnings = {
  currency: string; balance_cents: number; pending_cents: number; available_cents: number; reserved_cents: number; requestable_cents: number;
  next_release_at: string | null; totals_by_kind: { kind: string; amount_cents: number; gross_cents: number; entries: number }[];
  payout_minimum_cents: number; payout_hold_days: number; payout_configured: boolean; can_request: boolean; tax_form_required: boolean;
  share: { sale_bps: number; subscription_bps: number; tip_bps: number };
};
type Entry = { id: string; created_at: string; kind: string; amount_cents: number; gross_cents: number | null; balance_cents: number; available_at: string | null; pending: boolean; month: string | null; note: string | null; series_title: string | null; release_title: string | null };
type Payout = { id: string; amount_cents: number; status: string; method: string; note: string | null; reference: string | null; created_at: string; reviewed_at: string | null; paid_at: string | null; requested_by: string | null };

const KIND_LABEL: Record<string, string> = { sale: 'Sale', subscription: 'Membership', tip: 'Tip', payout: 'Payout', refund: 'Refund', adjustment: 'Adjustment' };
const METHOD_LABEL: Record<string, string> = { paypal: 'PayPal', venmo: 'Venmo', cashapp: 'Cash App', wise: 'Wise', bank_transfer: 'Bank transfer' };
const PAYOUT_TONE: Record<string, 'info' | 'ok' | 'danger' | 'neutral' | 'warn'> = { requested: 'info', approved: 'warn', paid: 'ok', rejected: 'danger', failed: 'danger' };

function Body() {
  const { brand } = useBrand();
  const { settings } = useSession();
  const confirm = useConfirm();
  const [kind, setKind] = useState('all');
  const [page, setPage] = useState(1);
  const [amount, setAmount] = useState<number | null>(null);
  const base = `/api/studio/brands/${brand.id}`;
  const earnings = useQuery({ queryKey: ['studio', 'earnings', brand.id], queryFn: () => api<Earnings>(`${base}/earnings`) });
  const ledger = useQuery({ queryKey: ['studio', 'ledger', brand.id, kind, page], queryFn: () => api<{ entries: Entry[]; total: number; limit: number }>(`${base}/ledger`, { query: { kind: kind === 'all' ? undefined : kind, page } }), placeholderData: (p) => p });
  const payouts = useQuery({ queryKey: ['studio', 'payouts', brand.id], queryFn: () => api<{ payouts: Payout[] }>(`${base}/payouts`) });
  const inv = [['studio', 'earnings', brand.id], ['studio', 'payouts', brand.id], ['studio', 'ledger', brand.id]];
  const request = useAct(() => api(`${base}/payouts`, { json: amount ? { amount_cents: amount } : {} }), { success: 'Payout requested. We review requests within a few working days.', invalidate: inv, onDone: () => setAmount(null) });
  const withdraw = useAct((id: string) => api(`${base}/payouts/${id}`, { method: 'DELETE' }), { success: 'Payout request withdrawn', invalidate: inv });
  return (
    <Q query={earnings}>
      {(e) => {
        const m = (c: number | null | undefined) => moneyExact(c, e.currency);
        return (
          <div className="space-y-5">
            <TaxBanner brand={{ ...brand, tax_form_needed: e.tax_form_required }} />
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
              <Stat label="Available" value={m(e.available_cents)} hint="Cleared and ready to pay out" />
              <Stat label="Pending" value={m(e.pending_cents)} hint={e.next_release_at ? `Next clears ${date(e.next_release_at)}` : `Earnings clear after ${e.payout_hold_days} days`} />
              <Stat label="Reserved" value={m(e.reserved_cents)} hint="In payout requests being reviewed" />
              <Stat label="You can request" value={m(e.requestable_cents)} hint={`Minimum payout ${m(e.payout_minimum_cents)}`} />
            </div>
            <p className="text-sm text-muted">Balance {m(e.balance_cents)} = available {m(e.available_cents)} + pending {m(e.pending_cents)}. Requested payouts stay in the balance, shown as reserved, until we approve them; then they appear in the ledger as a payout.</p>

            <Section title="Request a payout" description={`Paid to the method on file. The smallest payout is ${m(e.payout_minimum_cents)}.`}>
              {e.tax_form_required ? (
                <div className="space-y-3">
                  <Notice tone="warn" action={<Link className="link" to={`/studio/${brand.slug}/tax`}>Fill in the tax form</Link>}>
                    Payouts are on hold. Your earnings reached the tax reporting limit, so we need your tax information form before we can pay you. Your balance is safe and keeps growing in the meantime.
                  </Notice>
                  <Button variant="primary" disabled aria-describedby="payout-blocked">Request payout</Button>
                  <p id="payout-blocked" className="text-xs text-faint">Unlocks as soon as the tax information form is submitted.</p>
                </div>
              ) : !e.payout_configured ? (
                <Notice tone="warn" action={<Link className="link" to={`/studio/${brand.slug}/settings/payouts`}>Add payout details</Link>}>Tell us where to send your money before requesting a payout.</Notice>
              ) : e.requestable_cents < e.payout_minimum_cents ? (
                <Notice tone="info">You can request a payout once {m(e.payout_minimum_cents)} is available. Right now {m(e.requestable_cents)} is.</Notice>
              ) : (
                <div className="flex flex-wrap items-end gap-3">
                  <Field label="Amount" hint={`Leave empty to request everything: ${m(e.requestable_cents)}`} className="w-56"><MoneyInput cents={amount} onChange={setAmount} placeholder={(e.requestable_cents / 100).toFixed(2)} /></Field>
                  <Button variant="primary" loading={request.isPending} disabled={amount !== null && (amount < e.payout_minimum_cents || amount > e.requestable_cents)} onClick={async () => (await confirm({ title: `Request a payout of ${m(amount ?? e.requestable_cents)}?`, body: 'It is sent to the payout method on file once approved.', confirmLabel: 'Request payout' })) && request.mutate()}>Request payout</Button>
                  <Link className="link pb-2.5 text-sm" to={`/studio/${brand.slug}/settings/payouts`}>Change payout method</Link>
                </div>
              )}
              <Q query={payouts} loader={<p className="text-sm text-muted">Loading payouts…</p>}>
                {(p) => (
                  <Table rows={p.payouts} rowKey={(r) => r.id} empty="No payouts requested yet" columns={[
                    { key: 'd', header: 'Requested', cell: (r) => dateTime(r.created_at) },
                    { key: 'a', header: 'Amount', align: 'right', cell: (r) => m(r.amount_cents) },
                    { key: 'm', header: 'Method', cell: (r) => METHOD_LABEL[r.method] ?? r.method, hideOnMobile: true },
                    { key: 's', header: 'Status', cell: (r) => <Badge tone={PAYOUT_TONE[r.status] ?? 'neutral'}>{cap(r.status)}</Badge> },
                    { key: 'p', header: 'Paid', cell: (r) => (r.paid_at ? `${date(r.paid_at)}${r.reference ? ` · ref ${r.reference}` : ''}` : r.note ?? '—'), hideOnMobile: true },
                    { key: 'x', header: '', cell: (r) => (r.status === 'requested' ? <Button size="sm" variant="ghost" disabled={withdraw.isPending} onClick={() => withdraw.mutate(r.id)}>Withdraw</Button> : null) },
                  ]} />
                )}
              </Q>
            </Section>

            <Section title="How your earnings are calculated">
              <div className="grid gap-3 text-sm text-muted sm:grid-cols-3">
                <Card className="p-3.5"><strong className="text-paper">Sales: you keep {bps(e.share.sale_bps)}</strong><p className="mt-1">Of each purchase to read or download a release, after the card processor's fee.</p></Card>
                <Card className="p-3.5"><strong className="text-paper">Membership: you keep {bps(e.share.subscription_bps)}</strong><p className="mt-1">Each month, what a {settings.membership.name} member paid (after fees) is divided between the series they read, by the number of pages they read in each. Your part of that, times {bps(e.share.subscription_bps)}, is your membership figure. It is settled once the month ends.</p></Card>
                <Card className="p-3.5"><strong className="text-paper">Tips: you keep {bps(e.share.tip_bps)}</strong><p className="mt-1">Of every tip, after the card processor's fee.</p></Card>
              </div>
              <p className="text-sm text-muted">If your earnings in a calendar year reach the tax reporting limit, we ask for a tax information form before paying out. See where you stand under <Link className="link" to={`/studio/${brand.slug}/tax`}>Tax information</Link>.</p>
              <p className="text-sm text-muted">New earnings are pending for {e.payout_hold_days} days in case of refunds, then become available. The month-by-month membership breakdown is under <Link className="link" to={`/studio/${brand.slug}/analytics?view=revenue`}>Analytics, Revenue</Link>.</p>
            </Section>

            <Section title="Ledger" description="Every cent in and out, newest first." actions={<a href={`${base}/ledger?format=csv${kind === 'all' ? '' : `&kind=${kind}`}`} className="inline-flex h-8 items-center gap-1.5 rounded-md border border-line bg-raised px-3 text-[13px] hover:bg-hover"><Download className="size-4" />Export CSV</a>}>
              <Segmented size="sm" value={kind} onChange={(v) => { setKind(v); setPage(1); }} options={[{ value: 'all', label: 'All' }, ...Object.entries(KIND_LABEL).map(([value, label]) => ({ value, label }))]} />
              <Q query={ledger}>
                {(l) => (
                  <>
                    <Table rows={l.entries} rowKey={(r) => r.id} empty={kind === 'all' ? 'Nothing here yet. Earnings appear as soon as readers buy, tip or read as members.' : 'No entries of this kind'} columns={[
                      { key: 'd', header: 'Date', cell: (r) => dateTime(r.created_at) },
                      { key: 'k', header: 'Kind', cell: (r) => <span className="inline-flex items-center gap-1.5">{KIND_LABEL[r.kind] ?? r.kind}{r.pending && <Badge tone="warn">Pending</Badge>}</span> },
                      { key: 'w', header: 'For', cell: (r) => <span className="block max-w-64 truncate text-muted">{[r.release_title ?? r.series_title, r.note].filter(Boolean).join(' · ') || '—'}</span>, hideOnMobile: true },
                      { key: 'g', header: 'Reader paid', align: 'right', cell: (r) => (r.gross_cents ? m(r.gross_cents) : '—'), hideOnMobile: true },
                      { key: 'a', header: 'Amount', align: 'right', cell: (r) => <span className={r.amount_cents < 0 ? 'text-danger' : 'text-ok'}>{m(r.amount_cents)}</span> },
                      { key: 'b', header: 'Balance', align: 'right', cell: (r) => m(r.balance_cents) },
                    ]} />
                    <Pagination page={page} pages={Math.ceil(l.total / l.limit)} onPage={setPage} />
                  </>
                )}
              </Q>
            </Section>
          </div>
        );
      }}
    </Q>
  );
}

export function EarningsPage() {
  const { role } = useBrand();
  return <BrandPage title="Earnings">{can(role, 'admin') ? <Body /> : <RoleNotice need="admin" />}</BrandPage>;
}
