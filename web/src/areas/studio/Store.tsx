import { useQuery } from '@tanstack/react-query';
import { Package, Pencil, Percent, Plus, Trash2, X } from 'lucide-react';
import { useState } from 'react';
import type { FormEvent } from 'react';
import { api } from '@/lib/api';
import { dateTime, money } from '@/lib/format';
import { useSession } from '@/lib/session';
import { Badge, Button, Checkbox, EmptyState, Field, FormRow, IconButton, Input, Modal, MoneyInput, Notice, Select, Switch, Table, Textarea, useConfirm } from '@/ui';
import type { ReleaseList } from './SeriesEditor';
import { BrandPage, Q, RoleNotice, Section, can, cap, fromLocalInput, toLocalInput, useAct, useBrand } from './shared';

type BundleItem = { release_id: string; title: string; number: number; kind: string; language: string; status: string; series_id: string; series_title: string; cover_thumb_url: string | null; deleted: boolean };
type Bundle = { id: string; title: string; description: string; price_cents: number; includes_download: boolean; active: boolean; created_at: string; separate_price_cents: number; items: BundleItem[] };
type Discount = { id: string; label: string; percent_off: number; series_id: string | null; series_title: string | null; applies_to: 'all' | 'read' | 'download'; starts_at: string; ends_at: string | null; active: boolean; state: 'off' | 'upcoming' | 'ended' | 'running' };
type SeriesOpt = { id: string; title: string };

function useSeriesOptions(brandId: string) {
  return useQuery({ queryKey: ['studio', 'series-list', brandId], queryFn: () => api<{ series: SeriesOpt[] }>(`/api/studio/brands/${brandId}/series`) });
}

function BundleForm({ bundle, onClose }: { bundle: Bundle | null; onClose: () => void }) {
  const { brand } = useBrand();
  const { currency } = useSession();
  const series = useSeriesOptions(brand.id);
  const [title, setTitle] = useState(bundle?.title ?? '');
  const [description, setDescription] = useState(bundle?.description ?? '');
  const [price, setPrice] = useState<number | null>(bundle?.price_cents ?? null);
  const [download, setDownload] = useState(bundle?.includes_download ?? false);
  const [active, setActive] = useState(bundle?.active ?? true);
  const [picked, setPicked] = useState<{ id: string; label: string }[]>(bundle?.items.filter((i) => !i.deleted).map((i) => ({ id: i.release_id, label: `${i.series_title} · ${i.title}` })) ?? []);
  const [seriesId, setSeriesId] = useState('');
  const releases = useQuery({ queryKey: ['studio', 'releases', seriesId], queryFn: () => api<ReleaseList>(`/api/studio/series/${seriesId}/releases`), enabled: Boolean(seriesId) });
  const base = `/api/studio/brands/${brand.id}/bundles`;
  const save = useAct(
    () => {
      const json = { title, description, price_cents: price ?? 0, includes_download: download, active, release_ids: picked.map((p) => p.id) };
      return bundle ? api(`${base}/${bundle.id}`, { method: 'PATCH', json }) : api(base, { json });
    },
    { success: bundle ? 'Bundle saved' : 'Bundle created', invalidate: [['studio', 'bundles', brand.id]], onDone: onClose },
  );
  const toggle = (id: string, label: string) => setPicked((p) => (p.some((x) => x.id === id) ? p.filter((x) => x.id !== id) : [...p, { id, label }]));
  return (
    <Modal open onClose={onClose} size="lg" title={bundle ? 'Edit bundle' : 'New bundle'} footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" type="submit" form="bundle-form" loading={save.isPending} disabled={!picked.length || price === null}>{bundle ? 'Save bundle' : 'Create bundle'}</Button></>}>
      <form id="bundle-form" className="space-y-4" onSubmit={(e: FormEvent) => { e.preventDefault(); save.mutate(); }}>
        <FormRow>
          <Field label="Title"><Input value={title} onChange={(e) => setTitle(e.target.value)} required maxLength={150} placeholder="The complete first arc" /></Field>
          <Field label={`Bundle price (${currency.toUpperCase()})`}><MoneyInput cents={price} onChange={setPrice} /></Field>
        </FormRow>
        <Field label="Description" optional><Textarea value={description} onChange={(e) => setDescription(e.target.value)} maxLength={1000} className="min-h-20" /></Field>
        <div>
          <span className="mb-1.5 block text-[13px] font-medium">Releases in the bundle</span>
          {picked.length > 0 && (
            <ul className="mb-2 flex flex-wrap gap-1.5">
              {picked.map((p) => <li key={p.id} className="inline-flex items-center gap-1 rounded-md bg-raised px-2 py-1 text-xs">{p.label}<button type="button" aria-label={`Remove ${p.label}`} className="text-muted hover:text-paper" onClick={() => toggle(p.id, p.label)}><X className="size-3" /></button></li>)}
            </ul>
          )}
          <Select aria-label="Series to add releases from" value={seriesId} onChange={(e) => setSeriesId(e.target.value)}>
            <option value="">Choose a series to add releases from</option>
            {series.data?.series.map((s) => <option key={s.id} value={s.id}>{s.title}</option>)}
          </Select>
          {seriesId && (
            <div className="mt-2 max-h-48 space-y-2 overflow-auto rounded-xl border border-line p-3">
              {releases.isLoading && <p className="text-sm text-muted">Loading releases…</p>}
              {releases.data?.releases.length === 0 && <p className="text-sm text-muted">This series has no releases yet.</p>}
              {releases.data?.releases.map((r) => <Checkbox key={r.id} checked={picked.some((p) => p.id === r.id)} onChange={() => toggle(r.id, `${releases.data!.series.title} · ${r.title}`)} label={`${r.kind_label} ${Number(r.number)} · ${r.title}`} description={`${r.language.toUpperCase()} · ${cap(r.status)}`} />)}
            </div>
          )}
        </div>
        <Checkbox checked={download} onChange={setDownload} label="Include downloads" description="Buyers can also download each release, where a download exists." />
        <Switch checked={active} onChange={setActive} label="On sale" description="Turn off to stop offering the bundle without deleting it." />
      </form>
    </Modal>
  );
}

function DiscountForm({ discount, onClose }: { discount: Discount | null; onClose: () => void }) {
  const { brand } = useBrand();
  const series = useSeriesOptions(brand.id);
  const [label, setLabel] = useState(discount?.label ?? '');
  const [pct, setPct] = useState(String(discount?.percent_off ?? 25));
  const [seriesId, setSeriesId] = useState(discount?.series_id ?? '');
  const [applies, setApplies] = useState<Discount['applies_to']>(discount?.applies_to ?? 'all');
  const [starts, setStarts] = useState(toLocalInput(discount?.starts_at ?? new Date().toISOString()));
  const [ends, setEnds] = useState(toLocalInput(discount?.ends_at));
  const [active, setActive] = useState(discount?.active ?? true);
  const base = `/api/studio/brands/${brand.id}/discounts`;
  const save = useAct(
    () => {
      const json = { label, percent_off: Number(pct), series_id: seriesId || null, applies_to: applies, starts_at: fromLocalInput(starts) ?? new Date().toISOString(), ends_at: fromLocalInput(ends), active };
      return discount ? api(`${base}/${discount.id}`, { method: 'PATCH', json }) : api(base, { json });
    },
    { success: discount ? 'Sale saved' : 'Sale created', invalidate: [['studio', 'discounts', brand.id]], onDone: onClose },
  );
  return (
    <Modal open onClose={onClose} title={discount ? 'Edit sale' : 'New sale'} footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" type="submit" form="discount-form" loading={save.isPending}>{discount ? 'Save sale' : 'Create sale'}</Button></>}>
      <form id="discount-form" className="space-y-4" onSubmit={(e: FormEvent) => { e.preventDefault(); save.mutate(); }}>
        <FormRow>
          <Field label="Name" hint="Readers see this next to the reduced price."><Input value={label} onChange={(e) => setLabel(e.target.value)} required maxLength={80} placeholder="Summer sale" /></Field>
          <Field label="Percent off" hint="1 to 95"><Input type="number" min={1} max={95} value={pct} onChange={(e) => setPct(e.target.value)} required /></Field>
        </FormRow>
        <FormRow>
          <Field label="Series"><Select value={seriesId} onChange={(e) => setSeriesId(e.target.value)}><option value="">Every series of this brand</option>{series.data?.series.map((s) => <option key={s.id} value={s.id}>{s.title}</option>)}</Select></Field>
          <Field label="Applies to"><Select value={applies} onChange={(e) => setApplies(e.target.value as Discount['applies_to'])}><option value="all">Reading and downloads</option><option value="read">Price to read only</option><option value="download">Download price only</option></Select></Field>
        </FormRow>
        <FormRow>
          <Field label="Starts"><Input type="datetime-local" value={starts} onChange={(e) => setStarts(e.target.value)} required /></Field>
          <Field label="Ends" optional hint="Empty means it runs until you turn it off."><Input type="datetime-local" value={ends} min={starts} onChange={(e) => setEnds(e.target.value)} /></Field>
        </FormRow>
        <Switch checked={active} onChange={setActive} label="Enabled" />
      </form>
    </Modal>
  );
}

const STATE_TONE = { running: 'ok', upcoming: 'info', ended: 'neutral', off: 'neutral' } as const;

function Body() {
  const { brand, role } = useBrand();
  const { currency } = useSession();
  const admin = can(role, 'admin');
  const confirm = useConfirm();
  const [bundleDialog, setBundleDialog] = useState<Bundle | 'new' | null>(null);
  const [discountDialog, setDiscountDialog] = useState<Discount | 'new' | null>(null);
  const base = `/api/studio/brands/${brand.id}`;
  const bundles = useQuery({ queryKey: ['studio', 'bundles', brand.id], queryFn: () => api<{ bundles: Bundle[] }>(`${base}/bundles`) });
  const discounts = useQuery({ queryKey: ['studio', 'discounts', brand.id], queryFn: () => api<{ discounts: Discount[] }>(`${base}/discounts`) });
  const delBundle = useAct((b: Bundle) => api<{ deactivated: boolean }>(`${base}/bundles/${b.id}`, { method: 'DELETE' }), { success: (r) => (r.deactivated ? 'This bundle has been sold, so it was taken off sale instead of deleted' : 'Bundle deleted'), invalidate: [['studio', 'bundles', brand.id]] });
  const delDiscount = useAct((d: Discount) => api(`${base}/discounts/${d.id}`, { method: 'DELETE' }), { success: 'Sale deleted', invalidate: [['studio', 'discounts', brand.id]] });
  const m = (c: number) => money(c, currency);
  return (
    <div className="space-y-5">
      {!admin && <Notice tone="info">Your role can view bundles and sales. Changing them needs the admin role.</Notice>}
      <Section title="Bundles" description="Sell several releases together at one price." actions={admin && <Button onClick={() => setBundleDialog('new')} icon={<Plus className="size-4" />}>New bundle</Button>}>
        <Q query={bundles}>
          {(d) =>
            d.bundles.length === 0 ? (
              <EmptyState icon={<Package />} title="No bundles yet">A bundle is a good way to sell a finished arc or a whole series for less than buying each release.</EmptyState>
            ) : (
              <Table rows={d.bundles} rowKey={(b) => b.id} columns={[
                { key: 't', header: 'Bundle', cell: (b) => <div className="max-w-80"><div className="font-medium">{b.title}</div><div className="truncate text-xs text-muted">{b.items.length} {b.items.length === 1 ? 'release' : 'releases'}{b.includes_download ? ' with downloads' : ''}: {b.items.map((i) => i.title).join(', ')}</div></div> },
                { key: 'p', header: 'Price', align: 'right', cell: (b) => m(b.price_cents) },
                { key: 's', header: 'Bought separately', align: 'right', cell: (b) => (b.separate_price_cents ? <span>{m(b.separate_price_cents)}{b.separate_price_cents > b.price_cents && <span className="ml-1.5 text-ok">saves {Math.round((1 - b.price_cents / b.separate_price_cents) * 100)}%</span>}</span> : '—'), hideOnMobile: true },
                { key: 'a', header: 'Status', cell: (b) => <Badge tone={b.active ? 'ok' : 'neutral'}>{b.active ? 'On sale' : 'Off sale'}</Badge> },
                { key: 'x', header: '', cell: (b) => admin && (
                  <div className="flex justify-end">
                    <IconButton label={`Edit ${b.title}`} onClick={() => setBundleDialog(b)}><Pencil className="size-4" /></IconButton>
                    <IconButton label={`Delete ${b.title}`} onClick={async () => (await confirm({ title: `Delete “${b.title}”?`, body: 'If anyone has bought it, it is taken off sale and kept for their receipts.', confirmLabel: 'Delete bundle', danger: true })) && delBundle.mutate(b)}><Trash2 className="size-4" /></IconButton>
                  </div>
                ) },
              ]} />
            )
          }
        </Q>
      </Section>

      <Section title="Sales" description="Timed percentage discounts on reading prices, download prices or both." actions={admin && <Button onClick={() => setDiscountDialog('new')} icon={<Plus className="size-4" />}>New sale</Button>}>
        <Q query={discounts}>
          {(d) =>
            d.discounts.length === 0 ? (
              <EmptyState icon={<Percent />} title="No sales yet">Run a sale for a launch, a convention weekend or a holiday. It starts and ends on its own.</EmptyState>
            ) : (
              <Table rows={d.discounts} rowKey={(x) => x.id} columns={[
                { key: 'l', header: 'Sale', cell: (x) => <div><div className="font-medium">{x.label}</div><div className="text-xs text-muted">{x.series_title ?? 'Every series'} · {x.applies_to === 'all' ? 'reading and downloads' : x.applies_to === 'read' ? 'reading only' : 'downloads only'}</div></div> },
                { key: 'p', header: 'Off', align: 'right', cell: (x) => `${x.percent_off}%` },
                { key: 'w', header: 'When', cell: (x) => `${dateTime(x.starts_at)} to ${x.ends_at ? dateTime(x.ends_at) : 'until turned off'}`, hideOnMobile: true },
                { key: 's', header: 'Status', cell: (x) => <Badge tone={STATE_TONE[x.state]}>{x.state === 'off' ? 'Turned off' : cap(x.state)}</Badge> },
                { key: 'x', header: '', cell: (x) => admin && (
                  <div className="flex justify-end">
                    <IconButton label={`Edit ${x.label}`} onClick={() => setDiscountDialog(x)}><Pencil className="size-4" /></IconButton>
                    <IconButton label={`Delete ${x.label}`} onClick={async () => (await confirm({ title: `Delete “${x.label}”?`, confirmLabel: 'Delete sale', danger: true, body: 'Prices go back to normal straight away.' })) && delDiscount.mutate(x)}><Trash2 className="size-4" /></IconButton>
                  </div>
                ) },
              ]} />
            )
          }
        </Q>
      </Section>
      {bundleDialog && <BundleForm bundle={bundleDialog === 'new' ? null : bundleDialog} onClose={() => setBundleDialog(null)} />}
      {discountDialog && <DiscountForm discount={discountDialog === 'new' ? null : discountDialog} onClose={() => setDiscountDialog(null)} />}
    </div>
  );
}

export function StorePage() {
  const { role } = useBrand();
  return <BrandPage title="Bundles and sales">{can(role, 'editor') ? <Body /> : <RoleNotice need="editor" />}</BrandPage>;
}
