import { useQuery } from '@tanstack/react-query';
import { Download, Mail, Plus, Ticket, Trash2, Upload } from 'lucide-react';
import { useMemo, useState } from 'react';
import type { FormEvent } from 'react';
import { api } from '@/lib/api';
import { date, dateTime } from '@/lib/format';
import { Badge, Button, Checkbox, EmptyState, Field, FormRow, Input, Modal, Notice, Pagination, Segmented, Select, Table, Tabs, Textarea, toast, useConfirm } from '@/ui';
import type { ReleaseList } from './SeriesEditor';
import { BrandPage, CopyButton, FileButton, Q, RoleNotice, can, fromLocalInput, useAct, useBrand, Group } from './shared';

type Code = {
  id: string; code: string; kind: 'unlock' | 'discount'; series_id: string | null; release_id: string | null; percent_off: number | null; includes_download: boolean;
  max_redemptions: number | null; redeemed_count: number; batch_label: string | null; batch_id: string | null; assigned_email: string | null; sent_at: string | null;
  expires_at: string | null; disabled: boolean; created_at: string; scope_title: string | null; scope: 'release' | 'series' | 'brand';
};
type Batch = {
  batch_id: string; batch_label: string; kind: 'unlock' | 'discount'; includes_download: boolean; percent_off: number | null; scope_title: string | null; expires_at: string | null;
  total: number; redeemed: number; assigned: number; sent: number; disabled_count: number; disabled: boolean; created_at: string;
};
type Spec = { kind: 'unlock' | 'discount'; series_id: string; scope: 'series' | 'release'; release_id: string; includes_download: boolean; percent_off: string; expires: string };
const EMPTY_SPEC: Spec = { kind: 'unlock', series_id: '', scope: 'series', release_id: '', includes_download: false, percent_off: '20', expires: '' };

function specBody(s: Spec) {
  return {
    kind: s.kind,
    series_id: s.series_id && (s.scope === 'series' || !s.release_id) ? s.series_id : null,
    release_id: s.series_id && s.scope === 'release' && s.release_id ? s.release_id : null,
    includes_download: s.kind === 'unlock' ? s.includes_download : undefined,
    percent_off: s.kind === 'discount' ? Number(s.percent_off) : undefined,
    expires_at: fromLocalInput(s.expires),
  };
}

export function describe(c: { kind: string; percent_off: number | null; includes_download: boolean; scope_title: string | null }) {
  if (c.kind === 'discount') return `${c.percent_off}% off ${c.scope_title ?? 'anything from this brand'}`;
  return `Unlocks ${c.scope_title ?? 'a release'}${c.includes_download ? ', with download' : ''}`;
}

/** What a code does: shared by single codes, batches and backer imports. */
function SpecFields({ s, set, brandId }: { s: Spec; set: (p: Partial<Spec>) => void; brandId: string }) {
  const series = useQuery({ queryKey: ['studio', 'series-list', brandId], queryFn: () => api<{ series: { id: string; title: string }[] }>(`/api/studio/brands/${brandId}/series`) });
  const releases = useQuery({ queryKey: ['studio', 'releases', s.series_id], queryFn: () => api<ReleaseList>(`/api/studio/series/${s.series_id}/releases`), enabled: Boolean(s.series_id) && s.scope === 'release' });
  return (
    <div className="space-y-4">
      <Group label="The code" hint={s.kind === 'unlock' ? 'The reader gets the comic for free, as if they had bought it.' : 'The reader pays less at checkout.'}>
        <Segmented value={s.kind} onChange={(kind) => set({ kind })} options={[{ value: 'unlock', label: 'Unlocks a comic' }, { value: 'discount', label: 'Gives a discount' }]} />
      </Group>
      <FormRow>
        <Field label="Series">
          <Select value={s.series_id} onChange={(e) => set({ series_id: e.target.value, release_id: '' })} required={s.kind === 'unlock'}>
            <option value="">{s.kind === 'discount' ? 'Anything from this brand' : 'Choose a series'}</option>
            {series.data?.series.map((x) => <option key={x.id} value={x.id}>{x.title}</option>)}
          </Select>
        </Field>
        {s.series_id && (
          <Field label="Applies to">
            <Select value={s.scope} onChange={(e) => set({ scope: e.target.value as Spec['scope'] })}><option value="series">Every release of the series</option><option value="release">One release</option></Select>
          </Field>
        )}
      </FormRow>
      {s.series_id && s.scope === 'release' && (
        <Field label="Release">
          <Select value={s.release_id} onChange={(e) => set({ release_id: e.target.value })} required>
            <option value="">{releases.isLoading ? 'Loading…' : 'Choose a release'}</option>
            {releases.data?.releases.map((r) => <option key={r.id} value={r.id}>{r.kind_label} {Number(r.number)} · {r.title} ({r.language.toUpperCase()})</option>)}
          </Select>
        </Field>
      )}
      {s.kind === 'unlock' ? (
        <Checkbox checked={s.includes_download} onChange={(v) => set({ includes_download: v })} label="Include the download" description="The reader can also download the files, where a download exists." />
      ) : (
        <Field label="Percent off" className="w-40"><Input type="number" min={1} max={100} value={s.percent_off} onChange={(e) => set({ percent_off: e.target.value })} required /></Field>
      )}
      <Field label="Expires" optional className="max-w-64"><Input type="datetime-local" value={s.expires} onChange={(e) => set({ expires: e.target.value })} /></Field>
    </div>
  );
}

function useSpec() {
  const [s, setS] = useState<Spec>(EMPTY_SPEC);
  return [s, (p: Partial<Spec>) => setS((x) => ({ ...x, ...p })), () => setS(EMPTY_SPEC)] as const;
}

function NewCode({ onClose }: { onClose: () => void }) {
  const { brand } = useBrand();
  const [s, set] = useSpec();
  const [code, setCode] = useState('');
  const [max, setMax] = useState('');
  const create = useAct(() => api<{ code: Code }>(`/api/studio/brands/${brand.id}/codes`, { json: { ...specBody(s), code: code.trim() || undefined, max_redemptions: max ? Number(max) : null } }), { success: (r) => `Code ${r.code.code} created`, invalidate: [['studio', 'codes', brand.id]], onDone: onClose });
  return (
    <Modal open onClose={onClose} title="New code" footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" type="submit" form="new-code" loading={create.isPending}>Create code</Button></>}>
      <form id="new-code" className="space-y-4" onSubmit={(e: FormEvent) => { e.preventDefault(); create.mutate(); }}>
        <SpecFields s={s} set={set} brandId={brand.id} />
        <FormRow>
          <Field label="Code" optional hint="Leave empty for a random one. 5 to 40 letters, numbers and dashes."><Input value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} maxLength={40} placeholder="LAUNCH-WEEK" /></Field>
          <Field label="Times it can be used" optional hint="Empty means no limit."><Input type="number" min={1} value={max} onChange={(e) => setMax(e.target.value)} /></Field>
        </FormRow>
      </form>
    </Modal>
  );
}

function NewBatch({ onClose }: { onClose: () => void }) {
  const { brand } = useBrand();
  const [s, set] = useSpec();
  const [label, setLabel] = useState('');
  const [count, setCount] = useState('50');
  const create = useAct(() => api<{ created: number }>(`/api/studio/brands/${brand.id}/codes/bulk`, { json: { ...specBody(s), batch_label: label, count: Number(count) } }), { success: (r) => `${r.created} codes generated`, invalidate: [['studio', 'batches', brand.id]], onDone: onClose });
  return (
    <Modal open onClose={onClose} title="Generate a batch of codes" footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" type="submit" form="new-batch" loading={create.isPending}>Generate codes</Button></>}>
      <form id="new-batch" className="space-y-4" onSubmit={(e: FormEvent) => { e.preventDefault(); create.mutate(); }}>
        <p className="text-sm text-muted">Each code works once. Make one batch per reward tier, then export the codes or import your backer list to email them.</p>
        <FormRow>
          <Field label="Batch name" hint="For example the reward tier."><Input value={label} onChange={(e) => setLabel(e.target.value)} required maxLength={80} placeholder="Digital tier" /></Field>
          <Field label="How many codes"><Input type="number" min={1} max={5000} value={count} onChange={(e) => setCount(e.target.value)} required /></Field>
        </FormRow>
        <SpecFields s={s} set={set} brandId={brand.id} />
      </form>
    </Modal>
  );
}

const EMAIL_RE = /[^@\s,;"<>]+@[^@\s,;"<>]+\.[^@\s,;"<>]+/g;

function ImportBackers({ onClose, batches }: { onClose: () => void; batches: Batch[] }) {
  const { brand } = useBrand();
  const [s, set] = useSpec();
  const [target, setTarget] = useState('new');
  const [label, setLabel] = useState('');
  const [csv, setCsv] = useState('');
  const [file, setFile] = useState<string | null>(null);
  const preview = useMemo(() => {
    const emails = [...new Set((csv.match(EMAIL_RE) ?? []).map((e) => e.toLowerCase()))];
    const lines = csv.split(/\r?\n/).filter((l) => l.trim());
    const without = lines.filter((l) => !l.match(EMAIL_RE)).length;
    return { emails, rows: lines.length, without };
  }, [csv]);
  const run = useAct(
    () => api<{ assigned: number; created: number; already_in_batch: number; invalid_rows: number }>(`/api/studio/brands/${brand.id}/codes/import`, { json: target === 'new' ? { ...specBody(s), batch_label: label, csv } : { batch_id: target, csv } }),
    { success: (r) => `${r.assigned} backers given a code${r.already_in_batch ? `, ${r.already_in_batch} already had one` : ''}${r.invalid_rows ? `, ${r.invalid_rows} rows skipped` : ''}`, invalidate: [['studio', 'batches', brand.id], ['studio', 'codes', brand.id]], onDone: onClose },
  );
  return (
    <Modal open onClose={onClose} size="lg" title="Import backers" footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" type="submit" form="import-backers" disabled={!preview.emails.length} loading={run.isPending}>Give {preview.emails.length || ''} {preview.emails.length === 1 ? 'backer a code' : 'backers a code'}</Button></>}>
      <form id="import-backers" className="space-y-4" onSubmit={(e: FormEvent) => { e.preventDefault(); run.mutate(); }}>
        <p className="text-sm text-muted">Upload the backer export from your crowdfunding service (a CSV with an email column), or paste one address per line. Each backer gets their own single-use code. Nothing is emailed until you choose to.</p>
        <div className="flex flex-wrap items-center gap-3">
          <FileButton accept=".csv,text/csv,text/plain" onFiles={async (f) => { if (f[0].size > 1_800_000) return void toast.error('That file is larger than 1.8 MB. Split it into smaller files.'); setCsv(await f[0].text()); setFile(f[0].name); }}>Choose CSV file</FileButton>
          {file && <span className="text-sm text-muted">{file}</span>}
        </div>
        <Field label="Or paste the list"><Textarea value={csv} onChange={(e) => { setCsv(e.target.value); setFile(null); }} className="min-h-24 font-mono text-xs" placeholder={'email\nfirst.backer@example.com\nsecond.backer@example.com'} /></Field>
        {csv.trim() && (
          <Notice tone={preview.emails.length ? 'ok' : 'warn'}>
            <strong>{preview.emails.length} {preview.emails.length === 1 ? 'address' : 'addresses'} found</strong> in {preview.rows} rows{preview.without > 0 ? ` (${preview.without} ${preview.without === 1 ? 'row has' : 'rows have'} no address, such as the header)` : ''}.
            {preview.emails.length > 0 && <span className="mt-1 block break-all font-mono text-xs opacity-90">{preview.emails.slice(0, 5).join(', ')}{preview.emails.length > 5 ? ` and ${preview.emails.length - 5} more` : ''}</span>}
          </Notice>
        )}
        <Field label="Add them to">
          <Select value={target} onChange={(e) => setTarget(e.target.value)}>
            <option value="new">A new batch</option>
            {batches.map((b) => <option key={b.batch_id} value={b.batch_id}>{b.batch_label} ({b.total - b.assigned} spare codes)</option>)}
          </Select>
        </Field>
        {target === 'new' ? (
          <>
            <Field label="Batch name" hint="For example the reward tier."><Input value={label} onChange={(e) => setLabel(e.target.value)} required maxLength={80} /></Field>
            <SpecFields s={s} set={set} brandId={brand.id} />
          </>
        ) : <p className="text-sm text-muted">Spare codes in the batch are handed out first; more are generated if needed. Backers already in the batch keep the code they have.</p>}
      </form>
    </Modal>
  );
}

function EmailBatch({ batch, onClose }: { batch: Batch; onClose: () => void }) {
  const { brand } = useBrand();
  const [message, setMessage] = useState('Thank you for backing us! Here is your code to read the comic on AltComix.');
  const [resend, setResend] = useState(false);
  const waiting = batch.assigned - batch.sent;
  const send = useAct(() => api<{ sent: number; not_sent: number }>(`/api/studio/brands/${brand.id}/code-batches/${batch.batch_id}/email`, { json: { message, resend } }), { success: (r) => `${r.sent} emails sent${r.not_sent ? `, ${r.not_sent} could not be sent (unsubscribed or bounced)` : ''}`, invalidate: [['studio', 'batches', brand.id]], onDone: onClose });
  return (
    <Modal open onClose={onClose} title={`Email “${batch.batch_label}”`} footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" type="submit" form="email-batch" loading={send.isPending} disabled={!resend && waiting <= 0}>Send emails</Button></>}>
      <form id="email-batch" className="space-y-4" onSubmit={(e: FormEvent) => { e.preventDefault(); send.mutate(); }}>
        <p className="text-sm text-muted">{waiting > 0 ? `${waiting} ${waiting === 1 ? 'backer has' : 'backers have'} not been emailed their code yet.` : batch.assigned ? 'Everyone in this batch has already been emailed.' : 'No backers are attached to this batch yet. Import your backer list first.'} Each email contains the backer's own code and a link to redeem it. Redeemed and disabled codes are skipped.</p>
        <Field label="Your message"><Textarea value={message} onChange={(e) => setMessage(e.target.value)} maxLength={1500} required /></Field>
        <Checkbox checked={resend} onChange={setResend} label="Also send again to backers already emailed" />
      </form>
    </Modal>
  );
}

function BatchCodes({ batch, onClose }: { batch: Batch; onClose: () => void }) {
  const { brand } = useBrand();
  const [page, setPage] = useState(1);
  const codes = useQuery({ queryKey: ['studio', 'codes', brand.id, batch.batch_id, page], queryFn: () => api<{ codes: Code[]; total: number; limit: number }>(`/api/studio/brands/${brand.id}/codes`, { query: { batch_id: batch.batch_id, page } }) });
  return (
    <Modal open onClose={onClose} size="lg" title={`Codes in “${batch.batch_label}”`}>
      <Q query={codes}>
        {(d) => (
          <>
            <Table rows={d.codes} rowKey={(c) => c.id} columns={[
              { key: 'c', header: 'Code', cell: (c) => <span className="font-mono text-xs">{c.code}</span> },
              { key: 'e', header: 'Backer', cell: (c) => c.assigned_email ?? <span className="text-faint">Not assigned</span> },
              { key: 's', header: 'Emailed', cell: (c) => (c.sent_at ? date(c.sent_at) : '—'), hideOnMobile: true },
              { key: 'r', header: 'Status', cell: (c) => (c.disabled ? <Badge tone="danger">Disabled</Badge> : c.redeemed_count ? <Badge tone="ok">Redeemed</Badge> : <Badge>Unused</Badge>) },
            ]} />
            <Pagination page={page} pages={Math.ceil(d.total / d.limit)} onPage={setPage} />
          </>
        )}
      </Q>
    </Modal>
  );
}

function Body() {
  const { brand, role } = useBrand();
  const admin = can(role, 'admin');
  const confirm = useConfirm();
  const [tab, setTab] = useState<'batches' | 'single'>('batches');
  const [dialog, setDialog] = useState<null | 'code' | 'batch' | 'import'>(null);
  const [emailing, setEmailing] = useState<Batch | null>(null);
  const [viewing, setViewing] = useState<Batch | null>(null);
  const [page, setPage] = useState(1);
  const base = `/api/studio/brands/${brand.id}`;
  const batches = useQuery({ queryKey: ['studio', 'batches', brand.id], queryFn: () => api<{ batches: Batch[] }>(`${base}/code-batches`) });
  const singles = useQuery({ queryKey: ['studio', 'codes', brand.id, 'single', page], queryFn: () => api<{ codes: Code[]; total: number; limit: number }>(`${base}/codes`, { query: { single: 1, page } }), enabled: tab === 'single' });
  const toggleBatch = useAct((b: Batch) => api(`${base}/code-batches/${b.batch_id}`, { method: 'PATCH', json: { disabled: !b.disabled } }), { success: (_r, b) => (b.disabled ? 'Batch enabled' : 'Batch disabled. Unused codes no longer work.'), invalidate: [['studio', 'batches', brand.id]] });
  const toggleCode = useAct((c: Code) => api(`${base}/codes/${c.id}`, { method: 'PATCH', json: { disabled: !c.disabled } }), { success: (_r, c) => (c.disabled ? 'Code enabled' : 'Code disabled'), invalidate: [['studio', 'codes', brand.id]] });
  const delCode = useAct((c: Code) => api(`${base}/codes/${c.id}`, { method: 'DELETE' }), { success: 'Code deleted', invalidate: [['studio', 'codes', brand.id]] });
  return (
    <div>
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <p className="max-w-2xl text-sm text-muted">Codes unlock a release or a whole series, or take a percentage off. Use batches to give every crowdfunding backer their own code.</p>
        {admin && (
          <div className="flex flex-wrap gap-2">
            <Button onClick={() => setDialog('code')} icon={<Plus className="size-4" />}>New code</Button>
            <Button onClick={() => setDialog('batch')} icon={<Ticket className="size-4" />}>Generate batch</Button>
            <Button variant="primary" onClick={() => setDialog('import')} icon={<Upload className="size-4" />}>Import backers</Button>
          </div>
        )}
      </div>
      {!admin && <div className="mb-4"><Notice tone="info">Your role can view codes. Creating, emailing and disabling them needs the admin role.</Notice></div>}
      <div className="mb-4"><Tabs value={tab} onChange={setTab} tabs={[{ value: 'batches', label: 'Batches' }, { value: 'single', label: 'Single codes' }]} /></div>

      {tab === 'batches' && (
        <Q query={batches}>
          {(d) =>
            d.batches.length === 0 ? (
              <EmptyState icon={<Ticket />} title="No batches yet" action={admin && <Button variant="primary" onClick={() => setDialog('import')}>Import backers</Button>}>Import a backer list to give each backer a code, or generate a batch of codes to hand out yourself.</EmptyState>
            ) : (
              <Table rows={d.batches} rowKey={(b) => b.batch_id} columns={[
                { key: 'l', header: 'Batch', cell: (b) => <div><button className="text-left font-medium hover:text-accent-hover" onClick={() => setViewing(b)}>{b.batch_label}</button><div className="text-xs text-muted">{describe(b)}{b.expires_at ? ` · expires ${date(b.expires_at)}` : ''}</div></div> },
                { key: 't', header: 'Codes', align: 'right', cell: (b) => b.total },
                { key: 'a', header: 'Backers', align: 'right', cell: (b) => b.assigned, hideOnMobile: true },
                { key: 's', header: 'Emailed', align: 'right', cell: (b) => b.sent, hideOnMobile: true },
                { key: 'r', header: 'Redeemed', align: 'right', cell: (b) => `${b.redeemed} of ${b.total}` },
                { key: 'st', header: 'Status', cell: (b) => (b.disabled ? <Badge tone="danger">Disabled</Badge> : b.disabled_count ? <Badge tone="warn">{b.disabled_count} disabled</Badge> : <Badge tone="ok">Active</Badge>) },
                { key: 'x', header: '', cell: (b) => (
                  <div className="flex items-center justify-end gap-1">
                    <a href={`${base}/code-batches/${b.batch_id}/export.csv`} className="inline-flex h-8 items-center gap-1.5 rounded-md px-2 text-[13px] text-muted hover:bg-hover hover:text-paper"><Download className="size-4" />CSV</a>
                    {admin && <Button size="sm" variant="ghost" icon={<Mail className="size-4" />} onClick={() => setEmailing(b)}>Email</Button>}
                    {admin && <Button size="sm" variant="ghost" disabled={toggleBatch.isPending} onClick={async () => (b.disabled || (await confirm({ title: `Disable “${b.batch_label}”?`, body: 'Codes that have not been redeemed stop working. Comics already unlocked stay unlocked.', confirmLabel: 'Disable batch', danger: true }))) && toggleBatch.mutate(b)}>{b.disabled ? 'Enable' : 'Disable'}</Button>}
                  </div>
                ) },
              ]} />
            )
          }
        </Q>
      )}

      {tab === 'single' && (
        <Q query={singles}>
          {(d) =>
            d.codes.length === 0 ? (
              <EmptyState icon={<Ticket />} title="No single codes yet" action={admin && <Button variant="primary" onClick={() => setDialog('code')}>New code</Button>}>A single code can be shared with many readers, for a launch-week discount or a convention giveaway.</EmptyState>
            ) : (
              <>
                <Table rows={d.codes} rowKey={(c) => c.id} columns={[
                  { key: 'c', header: 'Code', cell: (c) => <span className="inline-flex items-center gap-2"><span className="font-mono text-sm">{c.code}</span><CopyButton text={c.code} /></span> },
                  { key: 'w', header: 'What it does', cell: (c) => describe(c) },
                  { key: 'u', header: 'Used', align: 'right', cell: (c) => `${c.redeemed_count}${c.max_redemptions ? ` of ${c.max_redemptions}` : ''}` },
                  { key: 'e', header: 'Expires', cell: (c) => (c.expires_at ? dateTime(c.expires_at) : 'Never'), hideOnMobile: true },
                  { key: 's', header: 'Status', cell: (c) => (c.disabled ? <Badge tone="danger">Disabled</Badge> : c.expires_at && Date.parse(c.expires_at) < Date.now() ? <Badge tone="warn">Expired</Badge> : <Badge tone="ok">Active</Badge>) },
                  { key: 'x', header: '', cell: (c) => admin && (
                    <div className="flex items-center justify-end gap-1">
                      <Button size="sm" variant="ghost" disabled={toggleCode.isPending} onClick={() => toggleCode.mutate(c)}>{c.disabled ? 'Enable' : 'Disable'}</Button>
                      {c.redeemed_count === 0 && <Button size="sm" variant="ghost" aria-label={`Delete code ${c.code}`} onClick={async () => (await confirm({ title: `Delete ${c.code}?`, confirmLabel: 'Delete code', danger: true, body: 'Nobody has used this code. It will stop working.' })) && delCode.mutate(c)}><Trash2 className="size-4" /></Button>}
                    </div>
                  ) },
                ]} />
                <Pagination page={page} pages={Math.ceil(d.total / d.limit)} onPage={setPage} />
              </>
            )
          }
        </Q>
      )}

      {dialog === 'code' && <NewCode onClose={() => { setDialog(null); setTab('single'); }} />}
      {dialog === 'batch' && <NewBatch onClose={() => { setDialog(null); setTab('batches'); }} />}
      {dialog === 'import' && <ImportBackers batches={batches.data?.batches ?? []} onClose={() => { setDialog(null); setTab('batches'); }} />}
      {emailing && <EmailBatch batch={emailing} onClose={() => setEmailing(null)} />}
      {viewing && <BatchCodes batch={viewing} onClose={() => setViewing(null)} />}
    </div>
  );
}

export function CodesPage() {
  const { role } = useBrand();
  return <BrandPage title="Codes">{can(role, 'editor') ? <Body /> : <RoleNotice need="editor" />}</BrandPage>;
}
