import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Ban, Download, KeyRound, ShieldAlert, ShieldCheck } from 'lucide-react';
import { useState } from 'react';
import type { FormEvent } from 'react';
import { Link } from 'react-router';
import { api, errorMessage } from '@/lib/api';
import { ago, dateTime, number } from '@/lib/format';
import { useSession } from '@/lib/session';
import { Badge, Button, Card, Field, Input, Notice, PageHeader, RankList, Stat, Tabs, toast, useConfirm } from '@/ui';
import { SuperOnly } from './AdminLayout';
import { CopyButton, DataList, FilterBar, FilterSelect, Loaded, Mono, SearchInput, Section, useAct, useAdminQuery, useAsk, useFilters, useList, useTitle } from './shared';
import type { AdminColumn, R } from './shared';

const DURATIONS = [
  { value: '1', label: '1 hour' }, { value: '24', label: '1 day' }, { value: '168', label: '7 days' }, { value: '720', label: '30 days' }, { value: '', label: 'Until I unblock it' },
];

function useBlock() {
  const ask = useAsk();
  const { run, busy } = useAct();
  const block = async (ip = '') => {
    const v = await ask({
      title: 'Block an IP address',
      body: 'Every request from this address is refused, on the site and at the firewall.',
      fields: [
        { name: 'ip', label: 'IP address', required: true, initial: ip, placeholder: '203.0.113.45' },
        { name: 'hours', label: 'Block for', type: 'select', initial: '24', options: DURATIONS },
        { name: 'reason', label: 'Reason', required: true, minLength: 3, hint: 'Shown in this list and the audit log.' },
      ],
      confirmLabel: 'Block address',
      danger: true,
    });
    if (v) void run({ key: `block-${v.ip}`, fn: () => api('/api/admin/security/blocked-ips', { json: { ip: v.ip, reason: v.reason, hours: v.hours ? Number(v.hours) : null } }), ok: `${v.ip} is blocked` });
  };
  return { block, busy };
}

function BlockedIps() {
  const [f, setF] = useFilters({ q: '', bstatus: '' });
  const list = useList('/api/admin/security/blocked-ips', { q: f.q, status: f.bstatus, page: f.page });
  const { run, busy } = useAct();
  const confirm = useConfirm();
  const { block } = useBlock();
  const columns: AdminColumn[] = [
    { key: 'ip', header: 'IP address', cell: (b) => <Mono>{b.ip_address}</Mono> },
    { key: 'reason', header: 'Reason', cell: (b) => <span className="block max-w-[280px] truncate" title={b.reason}>{b.reason}</span> },
    { key: 'hits', header: 'Strikes', align: 'right', cell: (b) => number(b.violation_count) },
    { key: 'when', header: 'Blocked', cell: (b) => <span title={dateTime(b.blocked_at)}>{ago(b.blocked_at)}</span> },
    { key: 'until', header: 'Until', cell: (b) => (b.permanent ? <Badge tone="danger">Permanent</Badge> : b.active ? dateTime(b.expires_at) : <span className="text-muted">Expired {ago(b.expires_at)}</span>) },
    { key: 'last', header: 'Last seen doing', cell: (b) => <span className="block max-w-[220px] truncate text-xs text-muted" title={`${b.last_path ?? ''} ${b.last_user_agent ?? ''}`}>{b.last_path ?? b.last_user_agent ?? '—'}</span>, hideOnMobile: true, wide: true },
    {
      key: 'act', header: '',
      cell: (b) => (
        <Button size="sm" loading={busy === b.id} onClick={async () => {
          if (await confirm({ title: `Unblock ${b.ip_address}?`, body: 'Requests from this address are allowed again. It can be blocked again automatically if it misbehaves.', confirmLabel: 'Unblock' })) {
            void run({ key: b.id, fn: () => api<R>(`/api/admin/security/blocked-ips/${b.id}`, { method: 'DELETE' }), ok: (r) => `${r.ip_address} unblocked. ${r.note}` });
          }
        }}>{b.active ? 'Unblock' : 'Remove'}</Button>
      ),
    },
  ];
  return (
    <>
      <FilterBar>
        <SearchInput value={f.q} onChange={(q) => setF({ q })} placeholder="Search by address, reason or browser" />
        <FilterSelect label="Status" value={f.bstatus} onChange={(bstatus) => setF({ bstatus })} options={[['', 'Blocked now'], ['expired', 'Expired'], ['all', 'All']]} />
        <Button variant="primary" icon={<Ban className="size-4" />} onClick={() => block()}>Block an address</Button>
      </FilterBar>
      <DataList
        query={list}
        columns={columns}
        onPage={(page) => setF({ page })}
        empty={{ icon: <ShieldCheck />, title: f.q || f.bstatus ? 'No blocks match' : 'No addresses are blocked', hint: 'The bot blocker adds addresses here when it catches scanners and attack traffic. You can also block one by hand.', action: <Button onClick={() => block()}>Block an address</Button> }}
      />
    </>
  );
}

function Suspicious() {
  const [f, setF] = useFilters({ sq: '' });
  const list = useList('/api/admin/security/suspicious', { q: f.sq, page: f.page, limit: 50 });
  const { block, busy } = useBlock();
  return (
    <>
      <FilterBar><SearchInput value={f.sq} onChange={(sq) => setF({ sq })} placeholder="Search by address, reason, path or browser" /></FilterBar>
      <DataList
        query={list}
        onPage={(page) => setF({ page })}
        empty={{ icon: <ShieldAlert />, title: 'Nothing suspicious recorded', hint: 'Requests that look like probing, scraping or flooding are logged here before an address is blocked.' }}
        columns={[
          { key: 'when', header: 'When', cell: (a) => <span title={dateTime(a.created_at)}>{ago(a.created_at)}</span> },
          { key: 'ip', header: 'IP address', cell: (a) => <Mono>{a.ip_address}</Mono> },
          { key: 'reason', header: 'What happened', cell: (a) => <span className="block max-w-[240px] truncate" title={a.reason}>{a.reason}</span> },
          { key: 'path', header: 'Path', cell: (a) => <span className="block max-w-[220px] truncate font-mono text-xs text-muted" title={a.path ?? ''}>{a.path ?? '—'}</span> },
          { key: 'ua', header: 'Browser', cell: (a) => <span className="block max-w-[200px] truncate text-xs text-muted" title={a.user_agent ?? ''}>{a.user_agent ?? '—'}</span>, hideOnMobile: true, wide: true },
          { key: 'act', header: '', cell: (a) => (a.blocked ? <Badge tone="danger">Blocked</Badge> : <Button size="sm" loading={busy === `block-${a.ip_address}`} onClick={() => block(a.ip_address)}>Block</Button>) },
        ]}
      />
    </>
  );
}

function Logins() {
  const [f, setF] = useFilters({ email: '', success: '' });
  const list = useList('/api/admin/security/logins', { email: f.email, success: f.success, page: f.page, limit: 50 });
  return (
    <>
      <FilterBar>
        <SearchInput value={f.email} onChange={(email) => setF({ email })} placeholder="Search by the email that was typed" />
        <FilterSelect label="Result" value={f.success} onChange={(success) => setF({ success })} options={[['', 'All attempts'], ['1', 'Signed in'], ['0', 'Failed']]} />
      </FilterBar>
      <DataList
        query={list}
        onPage={(page) => setF({ page })}
        empty={{ icon: <KeyRound />, title: 'No sign-in attempts match', hint: 'Every sign-in, successful or not, is recorded here.' }}
        columns={[
          { key: 'when', header: 'When', cell: (l) => <span title={dateTime(l.created_at)}>{ago(l.created_at)}</span> },
          { key: 'who', header: 'Account', cell: (l) => <span className="block max-w-[240px] truncate">{l.user_id ? <Link className="link" to={`/admin/users/${l.user_id}`}>@{l.username}</Link> : l.email}{l.role && l.role !== 'user' && <Badge tone="info" className="ml-1.5">Staff</Badge>}</span> },
          { key: 'ok', header: 'Result', cell: (l) => (l.success ? <Badge tone="ok">Signed in</Badge> : <Badge tone="danger">{String(l.reason ?? 'failed').replace(/_/g, ' ')}</Badge>) },
          { key: 'ip', header: 'IP address', cell: (l) => <Mono>{l.ip}</Mono> },
          { key: 'ua', header: 'Browser', cell: (l) => <span className="block max-w-[240px] truncate text-xs text-muted" title={l.user_agent ?? ''}>{l.user_agent ?? '—'}</span>, hideOnMobile: true, wide: true },
        ]}
      />
    </>
  );
}

function SecurityInner() {
  useTitle('Security');
  const [f, setF] = useFilters({ tab: 'blocked' });
  const overview = useAdminQuery<R>('/api/admin/security/overview', undefined, { refetchInterval: 60_000 });
  return (
    <>
      <PageHeader title="Security" description="Who is being kept out, what looked suspicious, and who has been signing in." />
      <Loaded query={overview}>
        {(o) => (
          <div className="mb-6 space-y-4">
            {o.staff_without_2fa > 0 && (
              <Notice tone="warn" action={<Link className="underline" to="/admin/settings?tab=security">Security settings</Link>}>
                {o.staff_without_2fa} of {o.staff} staff {o.staff === 1 ? 'account has' : 'accounts have'} no two-factor sign-in{o.settings.admin_2fa_required ? '. They are locked out of the admin panel until they set it up.' : ', and it is not required.'}
              </Notice>
            )}
            {!o.settings.bot_blocker_enabled && <Notice tone="warn" action={<Link className="underline" to="/admin/settings?tab=security">Turn it on</Link>}>The bot blocker is off. Nothing is being blocked automatically.</Notice>}
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
              <Stat label="Blocked addresses" value={number(o.blocked_ips)} hint={`${number(o.blocked_24h)} added in 24 hours`} />
              <Stat label="Suspicious requests" value={number(o.suspicious_24h)} hint="In the last 24 hours" />
              <Stat label="Failed sign-ins" value={number(o.failed_logins_24h)} hint={`${number(o.logins_24h)} successful, ${number(o.locked_accounts)} accounts locked`} />
              <Stat label="Signed in now" value={number(o.users_online)} hint={`${number(o.active_sessions)} active sessions`} />
            </div>
            {o.top_reasons.length > 0 && (
              <Card className="p-5">
                <h2 className="mb-3 text-base font-semibold">What was flagged in the last 24 hours</h2>
                <RankList items={o.top_reasons.map((r: R) => ({ label: r.reason, value: r.count }))} format={number} />
              </Card>
            )}
          </div>
        )}
      </Loaded>
      <div className="mb-4">
        <Tabs value={f.tab} onChange={(tab) => setF({ tab })} tabs={[{ value: 'blocked', label: 'Blocked addresses' }, { value: 'suspicious', label: 'Suspicious activity' }, { value: 'logins', label: 'Sign-ins' }]} />
      </div>
      {f.tab === 'suspicious' ? <Suspicious /> : f.tab === 'logins' ? <Logins /> : <BlockedIps />}
    </>
  );
}

export const SecurityPage = () => <SuperOnly><SecurityInner /></SuperOnly>;

// ---------------------------------------------------------------- two-factor sign-in (own account)

function BackupCodes({ codes, onDone }: { codes: string[]; onDone: () => void }) {
  const { settings } = useSession();
  const text = codes.join('\n');
  const download = () => {
    const url = URL.createObjectURL(new Blob([`${settings.site.name} backup codes\nEach code works once.\n\n${text}\n`], { type: 'text/plain' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = 'backup-codes.txt';
    a.click();
    URL.revokeObjectURL(url);
  };
  return (
    <Section title="Save your backup codes" description="Each code signs you in once if you lose your phone. This is the only time they are shown.">
      <ul className="grid grid-cols-2 gap-2 rounded-xl border border-line bg-ink p-4 font-mono text-sm sm:grid-cols-5">
        {codes.map((c) => <li key={c}>{c}</li>)}
      </ul>
      <div className="mt-4 flex flex-wrap gap-2">
        <CopyButton text={text} label="Copy codes" size="md" />
        <Button icon={<Download className="size-4" />} onClick={download}>Download as a text file</Button>
        <Button variant="primary" className="ml-auto" onClick={onDone}>I have saved them</Button>
      </div>
    </Section>
  );
}

export function TwoFactorPage() {
  useTitle('Two-factor sign-in');
  const { refresh } = useSession();
  const qc = useQueryClient();
  const ask = useAsk();
  const status = useAdminQuery<{ enabled: boolean; required: boolean; enrolment_pending: boolean; backup_codes_left: number }>('/api/admin/security/2fa');
  const [setup, setSetup] = useState<{ secret: string; qr_data_url: string } | null>(null);
  const [code, setCode] = useState('');
  const [codes, setCodes] = useState<string[] | null>(null);
  const reload = async () => {
    await refresh();
    await qc.invalidateQueries({ queryKey: ['admin'] });
  };
  const begin = useMutation({
    mutationFn: () => api<{ secret: string; qr_data_url: string }>('/api/admin/security/2fa/begin', { method: 'POST' }),
    onSuccess: (r) => setSetup(r),
    onError: (e) => toast.error(errorMessage(e)),
  });
  const confirmCode = useMutation({
    mutationFn: () => api<{ backup_codes: string[] }>('/api/admin/security/2fa/confirm', { json: { code: code.trim() } }),
    onSuccess: (r) => {
      setCodes(r.backup_codes);
      setSetup(null);
      setCode('');
      toast.success('Two-factor sign-in is on');
      void reload();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const action = useMutation({
    mutationFn: (v: { path: string; body: R }) => api<R>(`/api/admin/security/2fa/${v.path}`, { json: v.body }),
    onSuccess: (r, v) => {
      if (v.path === 'backup-codes') {
        setCodes(r.backup_codes);
        toast.success('New backup codes created. The old ones no longer work.');
      } else {
        toast.success('Two-factor sign-in is off');
      }
      void reload();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  const disable = async () => {
    const v = await ask({
      title: 'Turn off two-factor sign-in?',
      body: status.data?.required ? 'Two-factor is required for admins, so you will have to set it up again straight away to keep using the admin panel.' : 'Your account will be protected by your password alone.',
      fields: [
        { name: 'password', label: 'Your password', type: 'password', required: true },
        { name: 'code', label: 'Authenticator code or a backup code', required: true, minLength: 6 },
      ],
      confirmLabel: 'Turn off',
      danger: true,
    });
    if (v) action.mutate({ path: 'disable', body: { password: v.password, code: v.code } });
  };
  const newCodes = async () => {
    const v = await ask({
      title: 'Create new backup codes?',
      body: 'Your current backup codes stop working.',
      fields: [{ name: 'code', label: 'Authenticator code', required: true, minLength: 6, placeholder: '6 digits' }],
      confirmLabel: 'Create new codes',
    });
    if (v) action.mutate({ path: 'backup-codes', body: { code: v.code } });
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    confirmCode.mutate();
  };

  return (
    <>
      <PageHeader title="Two-factor sign-in" description="A second step when you sign in: a 6-digit code from an authenticator app on your phone. It protects your admin access if your password leaks." />
      <Loaded query={status}>
        {(s) => (
          <div className="max-w-3xl space-y-5">
            {codes ? (
              <BackupCodes codes={codes} onDone={() => setCodes(null)} />
            ) : s.enabled ? (
              <Section title={<span className="flex items-center gap-2"><ShieldCheck className="size-5 text-ok" /> Two-factor sign-in is on</span>} description={`You have ${s.backup_codes_left} backup ${s.backup_codes_left === 1 ? 'code' : 'codes'} left.`}>
                {s.backup_codes_left <= 3 && <div className="mb-4"><Notice tone="warn">You are running low on backup codes. Create a new set and store it somewhere safe.</Notice></div>}
                <div className="flex flex-wrap gap-2">
                  <Button loading={action.isPending} onClick={newCodes}>Create new backup codes</Button>
                  <Button variant="danger" disabled={action.isPending} onClick={disable}>Turn off</Button>
                </div>
              </Section>
            ) : (
              <>
                {s.required && <Notice tone="warn">Two-factor sign-in is required for admins. Set it up here to unlock the rest of the admin panel.</Notice>}
                {!setup ? (
                  <Section title="Set it up" description="You need an authenticator app such as Google Authenticator, 1Password, Authy or the one built into your phone.">
                    <Button variant="primary" loading={begin.isPending} onClick={() => begin.mutate()}>{s.enrolment_pending ? 'Start again' : 'Start setup'}</Button>
                    {s.enrolment_pending && <p className="mt-3 text-sm text-muted">A setup was started earlier but never confirmed. Starting again replaces it.</p>}
                  </Section>
                ) : (
                  <Section title="Scan and confirm">
                    <form onSubmit={submit} className="grid gap-6 sm:grid-cols-[auto_1fr]">
                      <img src={setup.qr_data_url} alt="QR code to scan with your authenticator app" width={240} height={240} className="mx-auto rounded-xl border border-line bg-paper p-2 sm:mx-0" />
                      <div className="space-y-4">
                        <ol className="list-decimal space-y-1.5 pl-5 text-sm text-muted">
                          <li>Open your authenticator app and add an account.</li>
                          <li>Scan the QR code, or type the key below by hand.</li>
                          <li>Enter the 6-digit code the app shows.</li>
                        </ol>
                        <div className="flex flex-wrap items-center gap-2">
                          <code className="break-all rounded-lg border border-line bg-ink px-3 py-2 font-mono text-[13px]">{setup.secret}</code>
                          <CopyButton text={setup.secret} label="Copy key" />
                        </div>
                        <Field label="Code from the app">
                          <Input autoFocus inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} placeholder="123456" className="max-w-40 font-mono tracking-widest" />
                        </Field>
                        <Button type="submit" variant="primary" loading={confirmCode.isPending} disabled={code.length !== 6}>Turn on two-factor sign-in</Button>
                      </div>
                    </form>
                  </Section>
                )}
              </>
            )}
          </div>
        )}
      </Loaded>
    </>
  );
}
