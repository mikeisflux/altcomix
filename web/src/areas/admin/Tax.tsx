import { Download, Eye, FileWarning, Landmark } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router';
import { api } from '@/lib/api';
import { date, moneyExact, number } from '@/lib/format';
import { Badge, Button, Checkbox, DefList, Modal, Notice, PageHeader, Stat, toast, useConfirm } from '@/ui';
import { CopyButton, DataList, FilterBar, FilterSelect, Mono, SearchInput, useAct, useAsk, useFilters, useIsSuper, useList, useTitle } from './shared';
import type { AdminColumn, R } from './shared';

type TaxList = {
  year: number; years: number[]; currency: string; limit_cents: number; form_required: boolean;
  totals: { brands: number; over_limit: number; over_limit_without_form: number; over_limit_earnings_cents: number };
};
type Export = { filename: string; csv: string; rows: number; include_ids: boolean; unreadable: string[] };
type Revealed = { name: string; legal_name: string; is_us_person: boolean; tin_type: string | null; tin: string | null; foreign_tin: string | null };

const FORM_LABEL: Record<string, string> = { on_file: 'On file', missing: 'Missing', needs_update: 'Needs update' };
const FORM_TONE: Record<string, 'ok' | 'warn' | 'danger'> = { on_file: 'ok', missing: 'danger', needs_update: 'warn' };
const CLASS_LABEL: Record<string, string> = {
  individual: 'Individual or sole proprietor', single_member_llc: 'Single-member LLC', c_corp: 'C corporation', s_corp: 'S corporation',
  partnership: 'Partnership', trust_estate: 'Trust or estate', llc: 'LLC', other: 'Other',
};

/** Hand a file made in the browser to the person (the export arrives as JSON so the request can carry the CSRF token). */
function saveFile(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function TaxPage() {
  useTitle('Creator taxes');
  const isSuper = useIsSuper();
  const ask = useAsk();
  const confirm = useConfirm();
  const { run, busy } = useAct();
  const [f, setF] = useFilters({ year: '', over: '', missing: '', q: '' });
  const list = useList<TaxList>('/api/admin/tax', { year: f.year, over: f.over, missing: f.missing, q: f.q, page: f.page });
  const d = list.data;
  const $ = (c: number | null | undefined) => moneyExact(c, d?.currency);
  const year = d?.year ?? (Number(f.year) || new Date().getFullYear());
  const [exporting, setExporting] = useState(false);
  const [withIds, setWithIds] = useState(false);
  const [revealed, setRevealed] = useState<Revealed | null>(null);

  const doExport = async () => {
    if (withIds && !(await confirm({
      title: `Export full taxpayer IDs for ${year}?`,
      body: 'The file will contain every Social Security number and EIN on file for brands over the limit. Keep it somewhere safe, send it only to your accountant, and delete it when the filing is done. This export is recorded in the audit log under your name.',
      confirmLabel: 'Export with full IDs',
      danger: true,
    }))) return;
    void run({
      key: 'export',
      fn: () => api<Export>('/api/admin/tax/export', { json: { year, include_ids: withIds, confirm: withIds } }),
      ok: (r) => (r.rows ? `Exported ${number(r.rows)} ${r.rows === 1 ? 'brand' : 'brands'}` : null),
      onDone: (r) => {
        if (!r.rows) return void toast.info(`No brand is over the limit in ${year}, so there is nothing to export.`);
        saveFile(r.filename, r.csv);
        if (r.unreadable.length) toast.warning(`The stored ID could not be read for: ${r.unreadable.join(', ')}. Ask them to submit the form again.`, { duration: 15_000 });
        setExporting(false);
        setWithIds(false);
      },
    });
  };

  const reveal = async (b: R) => {
    if (!(await confirm({
      title: `Show the taxpayer ID for ${b.name}?`,
      body: 'The full number is shown once on this screen. Looking at it is recorded in the audit log under your name.',
      confirmLabel: 'Show the ID',
    }))) return;
    void run({ key: `reveal:${b.publisher_id}`, fn: () => api<Revealed>(`/api/admin/tax/${b.publisher_id}/reveal`, { method: 'POST' }), onDone: setRevealed });
  };

  const needsUpdate = async (b: R) => {
    const v = await ask({
      title: `Ask ${b.name} for a corrected form?`,
      body: 'The brand owners are told in the Studio and by email, with your note. If the brand is over the limit, its payouts wait until the form is submitted again.',
      fields: [{ name: 'note', label: 'What needs correcting', type: 'textarea', required: true, minLength: 3, hint: 'Sent to the brand. Do not include the taxpayer ID.' }],
      confirmLabel: 'Ask for an update',
    });
    if (v) void run({ key: `nu:${b.publisher_id}`, fn: () => api(`/api/admin/tax/${b.publisher_id}/needs-update`, { json: { note: v.note } }), ok: 'The brand has been asked to update its form' });
  };

  const columns: AdminColumn[] = [
    {
      key: 'brand', header: 'Brand',
      cell: (b) => (
        <div className="max-w-[200px]">
          <Link className="link block truncate" to={`/admin/brands/${b.publisher_id}`}>{b.name}</Link>
          {b.legal_name && <span className="block truncate text-xs text-muted" title={b.legal_name}>{b.legal_name}</span>}
          {b.deleted_at && <Badge tone="neutral">Brand deleted</Badge>}
        </div>
      ),
    },
    {
      key: 'earnings', header: `Earned in ${year}`, align: 'right',
      cell: (b) => (
        <div>
          <div className="font-semibold tabular-nums">{$(b.earnings_cents)}</div>
          <div className="text-xs text-muted">{$(b.payouts_paid_cents)} paid out</div>
        </div>
      ),
    },
    { key: 'over', header: 'Limit', cell: (b) => (b.over_limit ? <Badge tone="warn">Over the limit</Badge> : <span className="text-xs text-muted">Under</span>) },
    {
      key: 'form', header: 'Tax form',
      cell: (b) => (
        <div className="max-w-[190px] text-xs">
          {b.form_status === 'missing' && !b.over_limit ? <span className="text-muted">Not needed yet</span> : <Badge tone={FORM_TONE[b.form_status]}>{FORM_LABEL[b.form_status]}</Badge>}
          {b.form_status !== 'missing' && <div className="mt-1 text-muted">{b.is_us_person ? (CLASS_LABEL[b.classification] ?? b.classification) : 'Not a US person'} · {date(b.form_updated_at)}</div>}
          {b.needs_update_note && b.form_status === 'needs_update' && <div className="mt-1 truncate text-muted" title={b.needs_update_note}>{b.needs_update_note}</div>}
        </div>
      ),
    },
    {
      key: 'tin', header: 'Taxpayer ID',
      cell: (b) => (b.tin_last4 ? <Mono>{String(b.tin_type).toUpperCase()} ••••{b.tin_last4}</Mono> : b.foreign_tin_last4 ? <Mono>Foreign ••••{b.foreign_tin_last4}</Mono> : <span className="text-muted">—</span>),
    },
    {
      key: 'actions', header: '',
      cell: (b) => (
        <div className="flex flex-wrap justify-end gap-1.5">
          {isSuper && (b.tin_last4 || b.foreign_tin_last4) && <Button size="sm" icon={<Eye className="size-4" />} loading={busy === `reveal:${b.publisher_id}`} onClick={() => reveal(b)}>Reveal ID</Button>}
          {b.form_status === 'on_file' && <Button size="sm" variant="ghost" disabled={busy === `nu:${b.publisher_id}`} onClick={() => needsUpdate(b)}>Needs update</Button>}
        </div>
      ),
    },
  ];

  return (
    <>
      <PageHeader
        title="Creator taxes"
        description="A brand whose earnings reach the tax reporting limit in a calendar year is asked for a tax information form, and its payouts wait until the form is in. This page shows where each brand stands and exports what your accountant needs. The site collects the information; it does not file anything."
        actions={<Button variant="primary" icon={<Download className="size-4" />} onClick={() => setExporting(true)}>Export for accountant</Button>}
      />
      {d && !d.form_required && <div className="mb-4"><Notice tone="warn" action={isSuper ? <Link className="link" to="/admin/settings?tab=revenue">Open settings</Link> : undefined}>The tax form requirement is switched off: no brand is asked for a form and no payout is held for one.</Notice></div>}
      <div className="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Tax reporting limit" value={d ? $(d.limit_cents) : '—'} hint={isSuper ? <Link className="link" to="/admin/settings?tab=revenue">Change in settings</Link> : 'Per calendar year'} />
        <Stat label={`Over the limit in ${year}`} value={d ? number(d.totals.over_limit) : '—'} hint={d ? `of ${number(d.totals.brands)} brands with activity` : undefined} />
        <Stat label="Over the limit, no form" value={d ? number(d.totals.over_limit_without_form) : '—'} hint="Payouts are on hold for these" />
        <Stat label="Earned by brands over the limit" value={d ? $(d.totals.over_limit_earnings_cents) : '—'} />
      </div>
      <FilterBar>
        <FilterSelect label="Calendar year" value={String(year)} onChange={(v) => setF({ year: v })} options={(d?.years ?? [year]).map((y) => [String(y), String(y)])} />
        <SearchInput value={f.q} onChange={(q) => setF({ q })} placeholder="Search by brand or legal name" />
        <span className="flex flex-wrap items-center gap-x-5 gap-y-2 py-1">
          <Checkbox checked={f.over === '1'} onChange={(v) => setF({ over: v ? '1' : '' })} label="Over the limit" />
          <Checkbox checked={f.missing === '1'} onChange={(v) => setF({ missing: v ? '1' : '' })} label="Missing form" />
        </span>
      </FilterBar>
      <DataList
        query={list}
        columns={columns}
        rowKey={(b) => b.publisher_id}
        onPage={(page) => setF({ page })}
        empty={{
          icon: <Landmark />,
          title: f.over || f.missing || f.q ? 'No brands match' : `No brand earned anything in ${year}`,
          hint: f.over || f.missing || f.q ? 'Try clearing the filters.' : 'Brands appear here once they have earnings, a payout or a tax form in the chosen year.',
          action: f.over || f.missing || f.q ? <Button onClick={() => setF({ over: '', missing: '', q: '' })}>Clear filters</Button> : undefined,
        }}
      />

      <Modal
        open={exporting}
        onClose={() => { setExporting(false); setWithIds(false); }}
        title={`Export ${year} for your accountant`}
        size="sm"
        footer={<><Button variant="ghost" onClick={() => { setExporting(false); setWithIds(false); }}>Cancel</Button><Button variant={withIds ? 'danger' : 'primary'} loading={busy === 'export'} onClick={doExport}>{withIds ? 'Export with full IDs' : 'Export CSV'}</Button></>}
      >
        <div className="space-y-4 text-sm text-muted">
          <p>One row for each brand whose {year} earnings reached the limit of {d ? $(d.limit_cents) : 'the limit'}: legal name, business name, tax classification, address, the kind of taxpayer ID and its last 4 digits, earnings, and payouts paid in {year}.</p>
          {isSuper ? (
            <Checkbox checked={withIds} onChange={setWithIds} label="Include full taxpayer IDs" description="Adds the complete SSN, EIN or foreign tax ID to each row. You will be asked to confirm, and the export is recorded in the audit log." />
          ) : (
            <p>Full taxpayer IDs can only be exported by a super admin.</p>
          )}
        </div>
      </Modal>

      <Modal open={Boolean(revealed)} onClose={() => setRevealed(null)} title="Taxpayer ID" size="sm" footer={<Button variant="primary" onClick={() => setRevealed(null)}>Done</Button>}>
        {revealed && (
          <div className="space-y-4">
            <DefList
              items={[
                ['Brand', revealed.name],
                ['Legal name', revealed.legal_name],
                ...(revealed.tin ? [[String(revealed.tin_type).toUpperCase(), <span key="t" className="flex flex-wrap items-center gap-2"><Mono>{revealed.tin}</Mono><CopyButton text={revealed.tin} /></span>] as [string, React.ReactNode]] : []),
                ...(revealed.foreign_tin ? [['Foreign tax ID', <span key="f" className="flex flex-wrap items-center gap-2"><Mono>{revealed.foreign_tin}</Mono><CopyButton text={revealed.foreign_tin} /></span>] as [string, React.ReactNode]] : []),
              ]}
            />
            <Notice tone="info"><span className="flex items-start gap-2"><FileWarning className="mt-0.5 size-4 shrink-0" aria-hidden /><span>Shown once. It is gone when you close this box, and showing it again is logged again.</span></span></Notice>
          </div>
        )}
      </Modal>
    </>
  );
}
