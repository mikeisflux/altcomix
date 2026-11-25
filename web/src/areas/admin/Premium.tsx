import { useQuery } from '@tanstack/react-query';
import { Sparkles } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router';
import { api, errorMessage } from '@/lib/api';
import { date, moneyExact, number } from '@/lib/format';
import { useSession } from '@/lib/session';
import { Badge, Button, Checkbox, Field, Input, Modal, Notice, PageHeader, Stat, Tabs, Textarea, useConfirm } from '@/ui';
import { DataList, FilterBar, FilterSelect, SearchInput, Section, StatusBadge, useAct, useAsk, useFilters, useList, useTitle } from './shared';
import type { AdminColumn, R } from './shared';

/**
 * Creator Premium in the admin area: the brands that have it (paid or
 * granted), its totals and payments, refunds, and granting it to any brand
 * without payment. The grant dialog and the brand-page card are used from
 * the brand detail page too.
 */

const utcDay = (iso: string | null | undefined) => date(iso, { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' });
/** The last day a grant is active (the API's `ends_at` is the instant it stops). */
const lastDay = (endsAt: string) => new Date(new Date(endsAt).getTime() - 1).toISOString().slice(0, 10);
const inAYear = () => {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear() + 1, d.getUTCMonth(), d.getUTCDate())).toISOString().slice(0, 10);
};
export const grantText = (g: { ends_at: string | null }) => (g.ends_at ? `until ${utcDay(lastDay(g.ends_at))}` : 'with no end date');

type Grant = { id: string; started_at: string; ends_at: string | null; note: string | null; granted_by: string | null };
export type BrandPremium = { active: boolean; grant: Grant | null; paid: R | null };
type Picked = { id: string; name: string; slug?: string };

/**
 * Grant Creator Premium to a brand, or change a grant it already has.
 * Without `brand` the dialog starts with a search over every brand.
 */
export function GrantPremiumDialog({ brand, onClose }: { brand?: Picked; onClose: () => void }) {
  const { settings } = useSession();
  const name = settings.creator_premium?.name ?? 'Creator Premium';
  const { run, busy } = useAct();
  const [picked, setPicked] = useState<Picked | null>(brand ?? null);
  const [search, setSearch] = useState('');
  const found = useQuery({
    queryKey: ['admin', 'premium-brand-search', search],
    queryFn: () => api<{ items: R[] }>('/api/admin/brands', { query: { q: search, limit: 8, sort: 'name' } }),
    enabled: !picked && search.trim().length >= 2,
  });
  const current = useQuery({
    queryKey: ['admin', 'brand-premium', picked?.id],
    queryFn: () => api<BrandPremium>(`/api/admin/brands/${picked!.id}/premium`),
    enabled: Boolean(picked),
  });
  const [endsOn, setEndsOn] = useState<string | null>(null);
  const [noEnd, setNoEnd] = useState<boolean | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const g = current.data?.grant ?? null;
  // Start from the grant the brand already has; otherwise one year from today.
  const endValue = endsOn ?? (g?.ends_at ? lastDay(g.ends_at) : inAYear());
  const noEndValue = noEnd ?? (g ? g.ends_at === null : false);
  const noteValue = note ?? g?.note ?? '';
  const today = new Date().toISOString().slice(0, 10);
  const valid = noEndValue || (Boolean(endValue) && endValue >= today);
  const save = () =>
    void run({
      key: 'grant',
      fn: () => api(`/api/admin/brands/${picked!.id}/premium/grant`, { json: noEndValue ? { no_end: true, note: noteValue.trim() || null } : { ends_on: endValue, note: noteValue.trim() || null } }),
      ok: g ? 'Grant updated' : `${name} granted to ${picked!.name}`,
      onDone: onClose,
    });
  return (
    <Modal
      open
      onClose={onClose}
      size="md"
      title={g ? `Change the ${name} grant` : `Grant ${name}`}
      footer={<><Button variant="ghost" onClick={onClose}>Close</Button><Button variant="primary" loading={busy === 'grant'} disabled={!picked || !valid || current.isPending} onClick={save} data-testid="grant-save">{g ? 'Save changes' : `Grant ${name}`}</Button></>}
    >
      <div className="space-y-4" data-testid="grant-dialog">
        {!picked ? (
          <>
            <Field label="Brand" hint="Search every brand by name or address.">
              <Input autoFocus value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Type at least 2 letters" aria-label="Search brands" data-testid="grant-brand-search" />
            </Field>
            {found.isError && <Notice tone="danger">{errorMessage(found.error)}</Notice>}
            {found.data && (found.data.items.length ? (
              <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line">
                {found.data.items.map((b) => (
                  <li key={b.id}>
                    <button type="button" className="flex min-h-11 w-full items-center justify-between gap-3 px-3 py-2 text-left hover:bg-hover" onClick={() => setPicked({ id: b.id, name: b.name, slug: b.slug })}>
                      <span className="min-w-0 truncate font-medium">{b.name}</span><span className="shrink-0 text-xs text-muted">/{b.slug}</span>
                    </button>
                  </li>
                ))}
              </ul>
            ) : <p className="text-sm text-muted">No brand matches “{search}”.</p>)}
          </>
        ) : (
          <>
            <p className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-line px-3 py-2.5">
              <span className="min-w-0"><span className="block truncate font-semibold">{picked.name}</span>{picked.slug && <span className="text-xs text-muted">/{picked.slug}</span>}</span>
              {!brand && <Button size="sm" variant="ghost" onClick={() => { setPicked(null); setEndsOn(null); setNoEnd(null); setNote(null); }}>Choose another</Button>}
            </p>
            {current.isError && <Notice tone="danger">{errorMessage(current.error)}</Notice>}
            {g && <Notice tone="info">This brand already has a grant, active {grantText(g)}. Saving replaces its end date and note.</Notice>}
            {current.data?.paid?.current && <Notice tone="info">This brand also pays for {name} (until {utcDay(current.data.paid.current_period_end)}). Both can run together: the features stay on while either is active, and the grant does not change what the brand pays.</Notice>}
            <Field label="Active until the end of" hint="The last day the grant is active (UTC).">
              <Input type="date" value={noEndValue ? '' : endValue} min={today} disabled={noEndValue} onChange={(e) => setEndsOn(e.target.value)} className="max-w-[12rem]" data-testid="grant-ends-on" />
            </Field>
            <Checkbox checked={noEndValue} onChange={setNoEnd} label="No end date" description="Stays on until someone revokes it." />
            <Field label="Note" optional hint="For the admin team only: why this brand gets it.">
              <Textarea value={noteValue} maxLength={500} onChange={(e) => setNote(e.target.value)} data-testid="grant-note" />
            </Field>
            <p className="text-sm text-muted">The brand gets the same features as a paying brand. No card is needed, nothing is charged and it is not counted as revenue. The brand's owners are told in the app and by email, and the grant is recorded in the audit log.</p>
          </>
        )}
      </div>
    </Modal>
  );
}

function useRevoke() {
  const confirm = useConfirm();
  const { run, busy } = useAct();
  const revoke = async (brandId: string, brandName: string, alsoPaid: boolean) => {
    const ok = await confirm({
      title: `Revoke the grant for ${brandName}?`,
      body: alsoPaid
        ? 'The grant ends now. The brand also has a paid plan, so the features stay on.'
        : 'The grant ends now. Print edition links stay saved but are hidden from readers, and the advanced analytics close.',
      confirmLabel: 'Revoke grant',
      danger: true,
    });
    if (ok) void run({ key: `revoke-${brandId}`, fn: () => api(`/api/admin/brands/${brandId}/premium/revoke`, { json: {} }), ok: 'Grant revoked' });
  };
  return { revoke, busy };
}

/** On the brand detail page: where the brand stands, and grant / change / revoke. */
export function BrandPremiumSection({ brand, premium }: { brand: { id: string; name: string; slug: string }; premium: BrandPremium | undefined }) {
  const { settings, currency } = useSession();
  const name = settings.creator_premium?.name ?? 'Creator Premium';
  const [granting, setGranting] = useState(false);
  const { revoke, busy } = useRevoke();
  if (!premium) return null;
  const { grant, paid } = premium;
  return (
    <Section
      title={<span className="flex flex-wrap items-center gap-2">{name} {premium.active ? <Badge tone="ok">Active</Badge> : <Badge>Not active</Badge>}</span>}
      description="The optional plan that unlocks print edition links and advanced analytics. Grant it to give a brand the features without payment."
      actions={
        <>
          <Button size="sm" variant={grant ? 'secondary' : 'primary'} onClick={() => setGranting(true)} data-testid="brand-grant-premium">{grant ? 'Change grant' : `Grant ${name}`}</Button>
          {grant && <Button size="sm" variant="danger" loading={busy === `revoke-${brand.id}`} onClick={() => revoke(brand.id, brand.name, Boolean(paid?.current))}>Revoke grant</Button>}
        </>
      }
    >
      <ul className="space-y-2 text-sm" data-testid="brand-premium">
        <li>
          <strong>Grant:</strong>{' '}
          {grant ? <>active {grantText(grant)}, granted {utcDay(grant.started_at)}{grant.granted_by ? ` by ${grant.granted_by}` : ''}{grant.note ? <>. Note: <span className="text-muted">{grant.note}</span></> : ''}</> : <span className="text-muted">none</span>}
        </li>
        <li>
          <strong>Paid plan:</strong>{' '}
          {paid ? <><StatusBadge status={paid.status} /> {moneyExact(paid.price_cents, currency)} a year, {paid.current ? (paid.cancel_at_period_end ? 'ends' : 'renews') : 'ended'} {utcDay(paid.current_period_end)}. <Link className="link" to={`/admin/premium?status=&q=${encodeURIComponent(brand.slug)}`}>Payments</Link></> : <span className="text-muted">never subscribed</span>}
        </li>
      </ul>
      {granting && <GrantPremiumDialog brand={brand} onClose={() => setGranting(false)} />}
    </Section>
  );
}

export function PremiumPage() {
  const { settings, currency } = useSession();
  const name = settings.creator_premium?.name ?? 'Creator Premium';
  useTitle(name);
  const $ = (c: number | null | undefined) => moneyExact(c, currency);
  const ask = useAsk();
  const { run, busy } = useAct();
  const { revoke, busy: revoking } = useRevoke();
  const [f, setF] = useFilters({ tab: 'brands', q: '', status: 'current', kind: '' });
  const [grantFor, setGrantFor] = useState<Picked | 'pick' | null>(null);
  const brands = useList<{ summary: R; product: { name: string; annual_cents: number } }>('/api/admin/premium', { q: f.q, status: f.status, kind: f.kind, page: f.page }, f.tab === 'brands');
  const summary = useList<{ summary: R; product: { name: string; annual_cents: number } }>('/api/admin/premium', { limit: 1 });
  const charges = useList('/api/admin/premium-charges', { page: f.page }, f.tab === 'payments');
  const s = summary.data?.summary;

  const refund = async (c: R) => {
    const v = await ask({
      title: `Refund ${$(c.total_cents)} to ${c.brand_name}?`,
      body: `The whole payment goes back through the processor${c.tax_cents > 0 ? `, including ${$(c.tax_cents)} of sales tax,` : ''} and the brand's paid plan ends now. A grant, if the brand has one, is not affected.`,
      fields: [{ name: 'reason', label: 'Reason', type: 'textarea', required: true, minLength: 3 }],
      confirmLabel: 'Refund payment',
      danger: true,
    });
    if (v) void run({ key: c.id, fn: () => api(`/api/admin/premium-charges/${c.id}/refund`, { json: { reason: v.reason } }), ok: 'Payment refunded' });
  };

  const brandColumns: AdminColumn[] = [
    { key: 'brand', header: 'Brand', cell: (p) => <Link className="link block max-w-[220px] truncate" to={`/admin/brands/${p.publisher_id}`}>{p.brand_name}</Link> },
    { key: 'kind', header: 'Kind', cell: (p) => (p.complimentary ? <Badge tone="info">Granted</Badge> : <Badge>Paid</Badge>) },
    { key: 'status', header: 'Status', cell: (p) => <span className="flex flex-wrap gap-1"><StatusBadge status={p.status} />{!p.complimentary && p.cancel_at_period_end && p.status === 'active' && <Badge tone="warn">Ending</Badge>}</span> },
    { key: 'started', header: 'Started', cell: (p) => <span className="text-muted">{utcDay(p.started_at)}</span>, hideOnMobile: true },
    { key: 'until', header: 'Renews / ends', cell: (p) => (p.no_end ? 'No end date' : p.complimentary ? `Ends ${utcDay(lastDay(p.ends_at))}` : p.renews_at ? `Renews ${utcDay(p.renews_at)}` : `Ends ${utcDay(p.current_period_end)}`) },
    { key: 'last', header: 'Last payment', align: 'right', cell: (p) => (p.last_charge ? <span title={p.last_charge.tax_cents > 0 ? `plus ${$(p.last_charge.tax_cents)} sales tax` : undefined}>{$(p.last_charge.amount_cents)} · {utcDay(p.last_charge.paid_at)}</span> : '—'), hideOnMobile: true },
    { key: 'note', header: 'Note', cell: (p) => <span className="block max-w-[200px] truncate text-muted" title={p.note ?? ''}>{p.note ?? ''}</span>, wide: true },
    { key: 'act', header: '', cell: (p) => (p.complimentary && p.current ? (
      <span className="flex justify-end gap-1.5">
        <Button size="sm" onClick={() => setGrantFor({ id: p.publisher_id, name: p.brand_name, slug: p.brand_slug })}>Change</Button>
        <Button size="sm" variant="danger" loading={revoking === `revoke-${p.publisher_id}`} onClick={() => revoke(p.publisher_id, p.brand_name, false)}>Revoke</Button>
      </span>
    ) : null) },
  ];
  const chargeColumns: AdminColumn[] = [
    { key: 'paid', header: 'Paid', cell: (c) => utcDay(c.paid_at) },
    { key: 'brand', header: 'Brand', cell: (c) => <Link className="link block max-w-[200px] truncate" to={`/admin/brands/${c.publisher_id}`}>{c.brand_name}</Link> },
    { key: 'payer', header: 'Paid by', cell: (c) => <span className="block max-w-[200px] truncate text-muted">{c.email}</span>, wide: true },
    { key: 'period', header: 'Covers', cell: (c) => `${utcDay(c.period_start)} to ${utcDay(c.period_end)}`, wide: true },
    { key: 'amount', header: 'Plan', align: 'right', cell: (c) => $(c.amount_cents), hideOnMobile: true },
    { key: 'tax', header: 'Sales tax', align: 'right', cell: (c) => (c.tax_cents > 0 ? <span title={c.tax_label ?? ''}>{$(c.tax_cents)}</span> : '—') },
    { key: 'total', header: 'Total', align: 'right', cell: (c) => <strong>{$(c.total_cents)}</strong> },
    { key: 'status', header: 'Status', cell: (c) => <StatusBadge status={c.status} />, hideOnMobile: true },
    { key: 'act', header: '', cell: (c) => (c.status === 'paid' ? <Button size="sm" variant="danger" loading={busy === c.id} onClick={() => refund(c)}>Refund</Button> : null) },
  ];

  return (
    <>
      <PageHeader
        title={name}
        description={`The optional yearly plan for brands (${$(summary.data?.product.annual_cents ?? settings.creator_premium?.annual_cents)} a year per brand, before sales tax). All of it is platform revenue; none of it is in the membership figures.`}
        actions={<Button variant="primary" icon={<Sparkles className="size-4" />} onClick={() => setGrantFor('pick')} data-testid="grant-premium">Grant {name}</Button>}
      />
      {s && (
        <div className="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-5" data-testid="premium-summary">
          <Stat label="Brands with it" value={number(s.active_brands)} hint={`${number(s.paying)} paying, ${number(s.complimentary)} granted`} />
          <Stat label="Annual run rate" value={$(s.annual_run_rate_cents)} hint="Paid plans set to renew, before tax" />
          <Stat label="Collected" value={$(s.collected_cents - s.refunded_cents)} hint={`${$(s.refunded_cents)} refunded. Before tax, all time`} />
          <Stat label="Sales tax collected" value={$(s.tax_cents)} hint={<Link className="link" to="/admin/sales-tax">In the sales tax report</Link>} />
          <Stat label="Needs attention" value={number(s.past_due)} hint={`Payment overdue. ${number(s.canceling)} canceled, still running`} />
        </div>
      )}
      <div className="mb-4"><Tabs value={f.tab} onChange={(tab) => setF({ tab, page: 1 })} tabs={[{ value: 'brands', label: 'Brands' }, { value: 'payments', label: 'Payments' }]} /></div>
      {f.tab === 'brands' ? (
        <>
          <FilterBar>
            <SearchInput value={f.q} onChange={(q) => setF({ q })} placeholder="Search by brand or payer email" />
            <FilterSelect label="Status" value={f.status} onChange={(status) => setF({ status })} options={[['current', 'Active now'], ['', 'Any status'], ['past_due', 'Payment overdue'], ['canceled', 'Canceled'], ['expired', 'Expired']]} />
            <FilterSelect label="Kind" value={f.kind} onChange={(kind) => setF({ kind })} options={[['', 'Paid and granted'], ['paid', 'Paid'], ['complimentary', 'Granted']]} />
          </FilterBar>
          <DataList
            query={brands}
            columns={brandColumns}
            onPage={(page) => setF({ page })}
            empty={{ icon: <Sparkles />, title: `No brand matches`, hint: `Brands appear here when they subscribe to ${name} or are granted it. Any brand can be granted it with the button above.`, action: <Button onClick={() => setF({ q: '', status: '', kind: '' })}>Show every plan</Button> }}
          />
        </>
      ) : (
        <DataList query={charges} columns={chargeColumns} onPage={(page) => setF({ page })} empty={{ icon: <Sparkles />, title: 'No payments yet', hint: `Every ${name} payment appears here with its sales tax. Grants have no payments.` }} />
      )}
      {grantFor && <GrantPremiumDialog brand={grantFor === 'pick' ? undefined : grantFor} onClose={() => setGrantFor(null)} />}
    </>
  );
}
