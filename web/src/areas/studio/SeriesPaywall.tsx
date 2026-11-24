import { useQueryClient } from '@tanstack/react-query';
import { Plus, Trash2 } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import type { FormEvent } from 'react';
import { api, errorMessage } from '@/lib/api';
import { useSession } from '@/lib/session';
import { Badge, Button, Checkbox, EmptyState, Field, FormRow, IconButton, Input, MoneyInput, Notice, Segmented, Select, Switch, cx, toast } from '@/ui';
import { SaveBar } from './SeriesDetails';
import { releasesKey, seriesKey, useReleases, useSeries } from './SeriesEditor';
import type { CountryRule, FreePreview, Release, ReleaseList, Series } from './SeriesEditor';
import { COUNTRIES, Q, STATUS_TONE, Section, bps, can, cap, changed, countryName, fromLocalInput, toLocalInput, useAct, useDraft } from './shared';

const AUTOMATIC_PAGES = 5;
const MODES: { mode: FreePreview['mode']; label: string; help: string }[] = [
  { mode: 'automatic', label: 'Automatic', help: `The first release is free in full. Every other release shows its first ${AUTOMATIC_PAGES} pages.` },
  { mode: 'first_releases', label: 'First 3 releases', help: 'The first three releases are free in full. Nothing else is previewed.' },
  { mode: 'first_last_releases', label: 'First and last 3 releases', help: 'The first three and the newest three releases are free in full, so new readers can start and followers can keep up.' },
  { mode: 'first_pages', label: 'First pages of each release', help: 'Every release shows its first pages for free.' },
  { mode: 'custom_first', label: 'Custom: first releases', help: 'Choose how many releases from the start are free in full.' },
  { mode: 'custom_first_last', label: 'Custom: first and last releases', help: 'Choose how many releases are free from the start and from the end.' },
];

type Pay = Pick<Series, 'access_model' | 'in_subscription' | 'paywall_expires_days' | 'default_price_cents' | 'free_preview'>;
const pickPay = (s: Series): Pay => ({ access_model: s.access_model, in_subscription: s.in_subscription, paywall_expires_days: s.paywall_expires_days, default_price_cents: s.default_price_cents, free_preview: s.free_preview ?? { mode: 'automatic' } });

function freeByPreview(fp: FreePreview, index: number, total: number) {
  const n = fp.n ?? 3;
  const m = fp.m ?? n;
  switch (fp.mode) {
    case 'first_releases': return index < 3;
    case 'first_last_releases': return index < 3 || index >= total - 3;
    case 'custom_first': return index < n;
    case 'custom_first_last': return index < n || index >= total - m;
    case 'automatic': return index === 0;
    default: return false;
  }
}

/** What a visitor with no account gets, release by release, under the draft settings. */
function PreviewSummary({ d, list, language, membership }: { d: Pay; list: ReleaseList | undefined; language: string; membership: string }) {
  const published = (list?.releases ?? []).filter((r) => r.language === language && r.status === 'published').sort((a, b) => Number(a.number) - Number(b.number));
  if (d.access_model === 'free') return <Notice tone="ok">Everyone can read every page of every release for free.</Notice>;
  if (d.access_model === 'blocked') return <Notice tone="warn">Nobody outside your team can read this series. It stays listed if it is public, but every page is locked.</Notice>;
  const fp = d.free_preview;
  const pages = fp.mode === 'first_pages' ? (fp.n ?? 10) : fp.mode === 'automatic' ? AUTOMATIC_PAGES : 0;
  const lines = published.map((r, i) => {
    const expired = d.paywall_expires_days && r.published_at && Date.parse(r.published_at) + d.paywall_expires_days * 86_400_000 <= Date.now();
    const whole = r.force_free || (r.free_at && Date.parse(r.free_at) <= Date.now()) || expired || freeByPreview(fp, i, published.length);
    const p = r.free_pages ?? pages;
    return { r, text: whole ? 'free in full' : p > 0 ? `first ${Math.min(p, r.page_count)} of ${r.page_count} pages free` : 'locked, cover only' , whole };
  });
  return (
    <div className="rounded-xl border border-line bg-ink p-4 text-sm">
      <h3 className="mb-2 text-sm font-semibold">What a reader gets without paying</h3>
      <p className="text-muted">
        {MODES.find((m) => m.mode === fp.mode)!.help.replace('first pages', `first ${pages} pages`)}
        {fp.mode === 'custom_first' && ` Right now that is the first ${fp.n ?? 3}.`}
        {fp.mode === 'custom_first_last' && ` Right now that is the first ${fp.n ?? 3} and the last ${fp.m ?? fp.n ?? 3}.`}
        {' '}Locked pages open with {d.in_subscription ? `a ${membership} membership or ` : ''}a purchase{d.paywall_expires_days ? `, and every release becomes free ${d.paywall_expires_days} days after it is published` : ''}.
      </p>
      {lines.length > 0 ? (
        <ul className="mt-3 max-h-56 space-y-1 overflow-auto">
          {lines.map(({ r, text, whole }) => (
            <li key={r.id} className="flex items-center justify-between gap-3"><span className="min-w-0 truncate">{r.kind_label} {Number(r.number)} · {r.title}</span><span className={cx('shrink-0 text-xs', whole ? 'text-ok' : 'text-muted')}>{text}</span></li>
          ))}
        </ul>
      ) : (
        <p className="mt-2 text-xs text-faint">Publish a release to see exactly how this applies to it.</p>
      )}
    </div>
  );
}

function AccessSettings({ list }: { list: ReleaseList | undefined }) {
  const { series, detail, role, brand } = useSeries();
  const { settings } = useSession();
  const server = useMemo(() => pickPay(series), [series]);
  const [d, set, dirty, reset] = useDraft(server);
  const editable = can(role, 'editor');
  const fp = d.free_preview;
  const setFp = (p: Partial<FreePreview>) => set({ free_preview: { ...fp, ...p } });
  const save = useAct(() => api(`/api/studio/series/${series.id}`, { method: 'PATCH', json: changed(server, d) }), { success: 'Paywall saved', invalidate: [seriesKey(series.id), ['studio', 'series-list', brand.id]] });
  const share = detail.revenue_share;
  return (
    <>
      <Section title="What you earn" description="Publishing is free. There is no paid plan and no higher tier to unlock: these are the real numbers for this brand.">
        <div className="grid gap-3 sm:grid-cols-3">
          {[
            { label: 'Sales', v: share.sale_bps, hint: 'Of each read-online or download purchase' },
            { label: 'Membership reads', v: share.subscription_bps, hint: `Of your share of ${settings.membership.name} money, split by pages read` },
            { label: 'Tips', v: share.tip_bps, hint: 'Of every tip from a reader' },
          ].map((x) => (
            <div key={x.label} className="rounded-xl border border-line bg-ink px-4 py-3">
              <div className="text-xs uppercase tracking-wide text-muted">{x.label}</div>
              <div className="font-display text-3xl font-bold tabular-nums">{bps(x.v)}</div>
              <div className="text-xs text-faint">{x.hint}</div>
            </div>
          ))}
        </div>
        <p className="text-sm text-muted">
          Percentages are of what is left after the card processor's fee. {share.split_out_bps > 0 ? `${bps(share.split_out_bps)} of this series' earnings then goes to your collaborators (see Advanced, Revenue splits).` : 'You can share earnings with collaborators under Advanced, Revenue splits.'}
        </p>
      </Section>

      <Section title="Who can read" description="The rule for readers everywhere, unless a country rule below says otherwise.">
        <fieldset disabled={!editable} className="space-y-4">
          <Field label="Public access" hint={d.access_model === 'free' ? 'Free: every page is open to everyone.' : d.access_model === 'premium' ? 'Premium: a free preview, then readers need a membership or a purchase.' : 'Blocked: locked for everyone except your team.'}>
            <Segmented value={d.access_model} onChange={(v) => set({ access_model: v })} options={[{ value: 'free', label: 'Free' }, { value: 'premium', label: 'Premium' }, { value: 'blocked', label: 'Blocked' }]} />
          </Field>
          {d.access_model === 'premium' && (
            <>
              <Switch checked={d.in_subscription} onChange={(v) => set({ in_subscription: v })} disabled={!editable} label={`Include in ${settings.membership.name}`} description="Members read it without buying, and you are paid for the pages they read. Turn this off to sell it only release by release." />
              <FormRow>
                <Field label="Default price to read a release" hint="Used by any release without its own price. Leave empty if releases are not sold one by one.">
                  <MoneyInput cents={d.default_price_cents} onChange={(c) => set({ default_price_cents: c })} placeholder="Not sold separately" />
                </Field>
                <Field label="Paywall expires" hint={d.paywall_expires_days ? `Each release becomes free ${d.paywall_expires_days} days after it is published.` : 'Releases stay paid until you change them.'}>
                  <div className="flex items-center gap-2">
                    <Select value={d.paywall_expires_days ? 'yes' : 'no'} onChange={(e) => set({ paywall_expires_days: e.target.value === 'yes' ? 90 : null })}><option value="no">Never</option><option value="yes">After a number of days</option></Select>
                    {d.paywall_expires_days !== null && <Input aria-label="Days until the paywall expires" type="number" min={1} max={3650} className="w-24" value={d.paywall_expires_days} onChange={(e) => set({ paywall_expires_days: Math.max(1, Number(e.target.value) || 1) })} />}
                  </div>
                </Field>
              </FormRow>
              <div>
                <span className="mb-1.5 block text-[13px] font-medium">Free preview</span>
                <div role="radiogroup" aria-label="Free preview" className="grid gap-2 sm:grid-cols-2">
                  {MODES.map((m) => (
                    <button key={m.mode} type="button" role="radio" aria-checked={fp.mode === m.mode} onClick={() => set({ free_preview: m.mode === 'first_pages' ? { mode: m.mode, n: 10 } : m.mode === 'custom_first' ? { mode: m.mode, n: 3 } : m.mode === 'custom_first_last' ? { mode: m.mode, n: 1, m: 1 } : { mode: m.mode } })} className={cx('rounded-xl border p-3 text-left transition-colors', fp.mode === m.mode ? 'border-accent bg-accent-soft' : 'border-line bg-ink hover:border-line-strong')}>
                      <span className="block text-sm font-semibold">{m.label}</span>
                      <span className="mt-0.5 block text-xs text-muted">{m.help}</span>
                    </button>
                  ))}
                </div>
                <div className="mt-3 flex flex-wrap gap-3">
                  {fp.mode === 'first_pages' && <Field label="Free pages per release" className="w-44"><Input type="number" min={1} max={500} value={fp.n ?? 10} onChange={(e) => setFp({ n: Math.max(1, Number(e.target.value) || 1) })} /></Field>}
                  {(fp.mode === 'custom_first' || fp.mode === 'custom_first_last') && <Field label="Free releases from the start" className="w-52"><Input type="number" min={1} max={500} value={fp.n ?? 3} onChange={(e) => setFp({ n: Math.max(1, Number(e.target.value) || 1) })} /></Field>}
                  {fp.mode === 'custom_first_last' && <Field label="Free releases from the end" className="w-52"><Input type="number" min={1} max={500} value={fp.m ?? fp.n ?? 1} onChange={(e) => setFp({ m: Math.max(1, Number(e.target.value) || 1) })} /></Field>}
                </div>
              </div>
            </>
          )}
        </fieldset>
        <PreviewSummary d={d} list={list} language={series.language} membership={settings.membership.name} />
        <SaveBar dirty={dirty} saving={save.isPending} onSave={() => save.mutate()} onReset={reset} />
      </Section>
    </>
  );
}

function CountryRules() {
  const { series, detail, role } = useSeries();
  const editable = can(role, 'editor');
  const [country, setCountry] = useState('');
  const [rule, setRule] = useState<CountryRule['rule']>('blocked');
  const inv = [seriesKey(series.id)];
  const add = useAct(() => api(`/api/studio/series/${series.id}/country-rules`, { json: { country, rule } }), { success: 'Country rule added', invalidate: inv, onDone: () => setCountry('') });
  const update = useAct((v: { id: string; body: Partial<CountryRule> }) => api(`/api/studio/series/${series.id}/country-rules/${v.id}`, { method: 'PATCH', json: v.body }), { success: 'Country rule updated', invalidate: inv });
  const remove = useAct((id: string) => api(`/api/studio/series/${series.id}/country-rules/${id}`, { method: 'DELETE' }), { success: 'Country rule removed', invalidate: inv });
  const submit = (e: FormEvent) => { e.preventDefault(); add.mutate(); };
  return (
    <Section title="Country rules" description="Override the access rule for readers in one country, for example to block a territory you have not licensed, or to make the series free where it is premium elsewhere.">
      {detail.country_rules.length === 0 ? <p className="text-sm text-muted">No country rules. Readers everywhere get the same access.</p> : (
        <ul className="divide-y divide-line rounded-xl border border-line">
          {detail.country_rules.map((r) => (
            <li key={r.id} className="flex flex-wrap items-center gap-3 px-3 py-2 text-sm">
              <span className="min-w-32 flex-1 font-medium">{countryName(r.country)}</span>
              <select aria-label={`Rule for ${countryName(r.country)}`} disabled={!editable} className="h-9 rounded-md border border-line bg-ink px-2 text-sm" value={r.rule} onChange={(e) => update.mutate({ id: r.id, body: { rule: e.target.value as CountryRule['rule'] } })}>
                <option value="blocked">Blocked</option><option value="free">Free</option><option value="premium">Premium</option>
              </select>
              <Checkbox checked={r.enabled} disabled={!editable} onChange={(v) => update.mutate({ id: r.id, body: { enabled: v } })} label="Enabled" />
              {editable && <IconButton label={`Remove rule for ${countryName(r.country)}`} onClick={() => remove.mutate(r.id)}><Trash2 className="size-4" /></IconButton>}
            </li>
          ))}
        </ul>
      )}
      {editable && (
        <form onSubmit={submit} className="grid items-end gap-3 sm:grid-cols-[1fr_180px_auto]">
          <Field label="Country"><Select value={country} onChange={(e) => setCountry(e.target.value)} required><option value="">Choose a country</option>{COUNTRIES.filter((c) => !detail.country_rules.some((r) => r.country === c.code)).map((c) => <option key={c.code} value={c.code}>{c.name}</option>)}</Select></Field>
          <Field label="Readers there get"><Select value={rule} onChange={(e) => setRule(e.target.value as CountryRule['rule'])}><option value="blocked">Blocked</option><option value="free">Free</option><option value="premium">Premium</option></Select></Field>
          <Button type="submit" loading={add.isPending} disabled={!country} icon={<Plus className="size-4" />}>Add rule</Button>
        </form>
      )}
    </Section>
  );
}

type PriceDraft = Pick<Release, 'price_cents' | 'download_price_cents' | 'download_discount_pct' | 'force_free' | 'free_at' | 'free_pages'>;
const pickPrice = (r: Release): PriceDraft => ({ price_cents: r.price_cents, download_price_cents: r.download_price_cents, download_discount_pct: r.download_discount_pct, force_free: r.force_free, free_at: r.free_at, free_pages: r.free_pages });
const cell = 'h-10 rounded-lg border border-line bg-ink px-2 text-sm hover:border-line-strong focus:border-accent focus:outline-none disabled:opacity-60';

function PriceTable({ data }: { data: ReleaseList }) {
  const { series, role } = useSeries();
  const qc = useQueryClient();
  const editable = can(role, 'editor');
  const [edits, setEdits] = useState<Record<string, Partial<PriceDraft>>>({});
  const [saving, setSaving] = useState(false);
  const rows = data.releases;
  useEffect(() => {
    setEdits((all) => Object.fromEntries(Object.entries(all).filter(([id]) => rows.some((r) => r.id === id))));
  }, [rows]);
  const row = (r: Release): PriceDraft => ({ ...pickPrice(r), ...edits[r.id] });
  const edit = (r: Release, p: Partial<PriceDraft>) =>
    setEdits((all) => {
      const diff = changed(pickPrice(r), { ...pickPrice(r), ...all[r.id], ...p });
      const out = { ...all };
      if (Object.keys(diff).length) out[r.id] = diff;
      else delete out[r.id];
      return out;
    });
  const count = Object.keys(edits).length;
  const save = async () => {
    setSaving(true);
    try {
      await api(`/api/studio/series/${series.id}/releases/bulk`, { method: 'PUT', json: { releases: Object.entries(edits).map(([id, p]) => ({ id, ...p })) } });
      setEdits({});
      await qc.invalidateQueries({ queryKey: releasesKey(series.id) });
      toast.success(`Prices saved for ${count} ${count === 1 ? 'release' : 'releases'}`);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };
  if (!rows.length) return <EmptyState title="No releases yet">Prices appear here once this series has releases.</EmptyState>;
  return (
    <div>
      <div className="overflow-x-auto rounded-xl border border-line">
        <table className="w-full min-w-max border-collapse text-sm">
          <thead>
            <tr className="border-b border-line bg-surface text-left text-[12px] uppercase tracking-wide text-muted">
              {['Release', 'Price to read', 'Download price', 'Download discount', 'Always free', 'Free to read from', 'Preview pages', 'Status'].map((h) => <th key={h} className="px-2.5 py-2.5 font-medium">{h}</th>)}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const d = row(r);
              return (
                <tr key={r.id} className={cx('border-b border-line last:border-0', edits[r.id] && 'bg-accent-soft/40')}>
                  <td className="max-w-56 px-2.5 py-2"><div className="truncate font-medium">{r.title}</div><div className="text-xs text-muted">{r.kind_label} {Number(r.number)} · {r.language.toUpperCase()}</div></td>
                  <td className="w-36 px-2.5 py-2"><MoneyInput cents={d.price_cents} disabled={!editable || d.force_free} onChange={(c) => edit(r, { price_cents: c })} placeholder={series.default_price_cents ? `${(series.default_price_cents / 100).toFixed(2)} default` : 'Not sold'} /></td>
                  <td className="w-36 px-2.5 py-2"><MoneyInput cents={d.download_price_cents} disabled={!editable} onChange={(c) => edit(r, { download_price_cents: c })} placeholder="Not for sale" /></td>
                  <td className="px-2.5 py-2">
                    <span className="flex items-center gap-1"><input aria-label={`Download discount for ${r.title}`} type="number" min={1} max={100} disabled={!editable || !d.download_price_cents} className={cx(cell, 'w-20 tabular-nums')} value={d.download_discount_pct ?? ''} placeholder="None" onChange={(e) => edit(r, { download_discount_pct: e.target.value ? Math.min(100, Math.max(1, Number(e.target.value))) : null })} /><span className="text-muted">%</span></span>
                  </td>
                  <td className="px-2.5 py-2"><Checkbox checked={d.force_free} disabled={!editable} onChange={(v) => edit(r, { force_free: v })} label={<span className="sr-only">Always free</span>} /></td>
                  <td className="px-2.5 py-2"><input aria-label={`Free to read date for ${r.title}`} type="datetime-local" disabled={!editable || d.force_free} className={cx(cell, 'w-52')} value={toLocalInput(d.free_at)} onChange={(e) => edit(r, { free_at: fromLocalInput(e.target.value) })} /></td>
                  <td className="px-2.5 py-2"><input aria-label={`Free preview pages for ${r.title}`} type="number" min={0} max={5000} disabled={!editable} className={cx(cell, 'w-24 tabular-nums')} value={d.free_pages ?? ''} placeholder="Series rule" onChange={(e) => edit(r, { free_pages: e.target.value === '' ? null : Math.max(0, Number(e.target.value)) })} /></td>
                  <td className="px-2.5 py-2"><Badge tone={STATUS_TONE[r.status]}>{cap(r.status)}</Badge></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="mt-2 text-xs text-faint">Reading online and downloading are priced separately. An empty read price uses the series default; an empty download price means the download is not sold.</p>
      <SaveBar dirty={count > 0} saving={saving} onSave={save} onReset={() => setEdits({})} label={`Save ${count} ${count === 1 ? 'release' : 'releases'}`} />
    </div>
  );
}

export function SeriesPaywall() {
  const { series } = useSeries();
  const list = useReleases(series.id);
  return (
    <div className="space-y-5">
      <AccessSettings list={list.data} />
      <CountryRules />
      <Section title="Release prices" description="Set prices and free dates for every release, then save them all at once.">
        <Q query={list}>{(d) => <PriceTable data={d} />}</Q>
      </Section>
    </div>
  );
}
