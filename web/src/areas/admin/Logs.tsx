import { Bug, CalendarClock, ChevronRight, ScrollText } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router';
import { api, errorMessage } from '@/lib/api';
import { ago, dateTime, number } from '@/lib/format';
import { Badge, Button, DefList, EmptyState, ErrorState, Input, Notice, PageHeader, Pagination, Skeleton, Table, Tabs, useConfirm } from '@/ui';
import type { Column } from '@/ui';
import { DataList, Drawer, FilterBar, FilterSelect, Loaded, Mono, SearchInput, StatusBadge, useAct, useAdminQuery, useFilters, useList, useTitle } from './shared';
import type { R } from './shared';

// ---------------------------------------------------------------- audit log

const TARGET_LINK: Record<string, (id: string) => string> = {
  user: (id) => `/admin/users/${id}`,
  publisher: (id) => `/admin/brands/${id}`,
  order: (id) => `/admin/orders/${id}`,
  news_post: (id) => `/admin/news/${id}`,
  cms_page: (id) => `/admin/pages/${id}`,
  settings: (id) => `/admin/settings?tab=${id === 'site' ? 'general' : id}`,
};

const actionLabel = (a: string) => a.replace(/[._]/g, ' ');

export function AuditPage() {
  useTitle('Audit log');
  const [f, setF] = useFilters({ actor: '', action: '', target_kind: '', q: '', from: '', to: '' });
  const list = useList('/api/admin/audit', { actor: f.actor, action: f.action, target_kind: f.target_kind, q: f.q, from: f.from, to: f.to ? `${f.to}T23:59:59` : '', page: f.page });
  const facets = useAdminQuery<{ actions: { action: string; count: number }[]; target_kinds: string[] }>('/api/admin/audit/facets');
  const groups = [...new Set((facets.data?.actions ?? []).map((a) => a.action.split('.')[0]))];
  return (
    <>
      <PageHeader title="Audit log" description="A permanent record of what staff and creators changed, when, and from where. Open an entry to see the details." />
      <FilterBar>
        <SearchInput value={f.actor} onChange={(actor) => setF({ actor })} placeholder="Who: email or username" />
        <SearchInput value={f.q} onChange={(q) => setF({ q })} placeholder="Search inside the details" />
        <FilterSelect
          label="Action"
          value={f.action}
          onChange={(action) => setF({ action })}
          options={[['', 'Any action'], ...groups.map((g): [string, string] => [g, `Everything about ${g.replace(/_/g, ' ')}`]), ...(facets.data?.actions ?? []).map((a): [string, string] => [a.action, `${actionLabel(a.action)} (${a.count})`])]}
        />
        <FilterSelect label="About" value={f.target_kind} onChange={(target_kind) => setF({ target_kind })} options={[['', 'Any kind of thing'], ...(facets.data?.target_kinds ?? []).map((k): [string, string] => [k, k.replace(/_/g, ' ')])]} />
        <span className="flex items-center gap-2 text-sm text-muted">
          <Input type="date" aria-label="From date" value={f.from} onChange={(e) => setF({ from: e.target.value })} className="w-auto" />
          to
          <Input type="date" aria-label="To date" value={f.to} onChange={(e) => setF({ to: e.target.value })} className="w-auto" />
        </span>
      </FilterBar>
      {list.isPending ? (
        <Skeleton className="h-72 w-full" />
      ) : list.isError ? (
        <ErrorState message={errorMessage(list.error)} retry={() => void list.refetch()} />
      ) : list.data.items.length === 0 ? (
        <EmptyState icon={<ScrollText />} title="No entries match" action={<Button onClick={() => setF({ actor: '', action: '', target_kind: '', q: '', from: '', to: '' })}>Clear filters</Button>}>
          Every admin action is written here as it happens. Try widening the dates or clearing the filters.
        </EmptyState>
      ) : (
        <>
          <ul className="overflow-hidden rounded-xl border border-line">
            {list.data.items.map((a) => {
              const link = a.target_kind && a.target_id && TARGET_LINK[a.target_kind]?.(a.target_id);
              const hasMeta = a.meta && Object.keys(a.meta).length > 0;
              return (
                <li key={a.id} className="border-b border-line last:border-0">
                  <details className="group">
                    <summary className="flex min-h-11 cursor-pointer list-none flex-wrap items-center gap-x-3 gap-y-1 px-3.5 py-2.5 text-sm hover:bg-surface [&::-webkit-details-marker]:hidden">
                      <ChevronRight className="size-4 shrink-0 text-faint transition-transform group-open:rotate-90" aria-hidden />
                      <span className="w-36 shrink-0 text-muted" title={dateTime(a.created_at)}>{dateTime(a.created_at)}</span>
                      <span className="font-medium capitalize">{actionLabel(a.action)}</span>
                      {a.target_kind && <Badge>{String(a.target_kind).replace(/_/g, ' ')}</Badge>}
                      <span className="ml-auto text-muted">{a.actor_username ? `@${a.actor_username}` : 'System'}</span>
                    </summary>
                    <div className="space-y-3 border-t border-line bg-surface px-4 py-4 text-sm sm:pl-11">
                      <DefList
                        items={[
                          ['Who', a.actor_id ? <><Link className="link" to={`/admin/users/${a.actor_id}`}>@{a.actor_username}</Link> <span className="text-muted">{a.actor_email}{a.actor_role && a.actor_role !== 'user' ? ` · ${String(a.actor_role).replace('_', ' ')}` : ''}</span></> : 'System'],
                          ['Action', <Mono>{a.action}</Mono>],
                          ['About', a.target_kind ? <>{String(a.target_kind).replace(/_/g, ' ')} {link ? <Link className="link break-all" to={link}><Mono>{a.target_id}</Mono></Link> : <span className="break-all"><Mono>{a.target_id}</Mono></span>}</> : '—'],
                          ['From', <Mono>{a.ip ?? 'unknown'}</Mono>],
                        ]}
                      />
                      {hasMeta ? <pre className="max-h-80 overflow-auto rounded-lg border border-line bg-ink p-3 font-mono text-xs leading-relaxed">{JSON.stringify(a.meta, null, 2)}</pre> : <p className="text-muted">No further details were recorded.</p>}
                    </div>
                  </details>
                </li>
              );
            })}
          </ul>
          <div className="mt-2 text-xs text-faint">{number(list.data.total)} entries</div>
          <Pagination page={list.data.page} pages={Math.ceil(list.data.total / list.data.limit)} onPage={(page) => setF({ page })} />
        </>
      )}
    </>
  );
}

// ---------------------------------------------------------------- error log

function ErrorDrawer({ id, onClose }: { id: string; onClose: () => void }) {
  const q = useAdminQuery<{ error: R }>(`/api/admin/errors/${id}`);
  const { run, busy } = useAct();
  const e = q.data?.error;
  const setStatus = (status: string, ok: string) => run({ key: status, fn: () => api(`/api/admin/errors/${id}/status`, { json: { status } }), ok });
  return (
    <Drawer
      open
      onClose={onClose}
      title={e?.title ?? 'Error'}
      footer={
        e && (
          <>
            {e.status !== 'unresolved' && <Button loading={busy === 'unresolved'} onClick={() => setStatus('unresolved', 'Reopened')}>Reopen</Button>}
            {e.status !== 'ignored' && <Button loading={busy === 'ignored'} onClick={() => setStatus('ignored', 'Ignored. It will stay quiet even if it happens again.')}>Ignore</Button>}
            {e.status !== 'resolved' && <Button variant="primary" loading={busy === 'resolved'} onClick={() => setStatus('resolved', 'Marked as resolved')}>Mark resolved</Button>}
          </>
        )
      }
    >
      <Loaded query={q}>
        {({ error }) => (
          <div className="space-y-5">
            <DefList
              items={[
                ['Status', <StatusBadge status={error.status} />],
                ['Where', <><span className="capitalize">{error.source}</span>{error.endpoint ? <> · <Mono>{error.endpoint}</Mono></> : null}</>],
                ['Level', error.level],
                ['Happened', `${number(error.event_count)} ${error.event_count === 1 ? 'time' : 'times'}`],
                ['First seen', dateTime(error.first_seen)],
                ['Last seen', `${dateTime(error.last_seen)} (${ago(error.last_seen)})`],
              ]}
            />
            <p className="text-xs text-muted">A resolved error reopens by itself if it happens again. An ignored one stays quiet.</p>
            {error.last_message && (
              <div>
                <h3 className="mb-2 font-semibold">Latest message</h3>
                <p className="whitespace-pre-wrap break-words rounded-lg border border-line bg-ink p-3 font-mono text-xs">{error.last_message}</p>
              </div>
            )}
            <div>
              <h3 className="mb-2 font-semibold">Stack trace</h3>
              {error.last_stack ? <pre className="max-h-96 overflow-auto rounded-lg border border-line bg-ink p-3 font-mono text-xs leading-relaxed">{error.last_stack}</pre> : <p className="text-sm text-muted">No stack trace was captured.</p>}
            </div>
            {error.last_meta && Object.keys(error.last_meta).length > 0 && (
              <div>
                <h3 className="mb-2 font-semibold">Context</h3>
                <pre className="max-h-72 overflow-auto rounded-lg border border-line bg-ink p-3 font-mono text-xs leading-relaxed">{JSON.stringify(error.last_meta, null, 2)}</pre>
              </div>
            )}
          </div>
        )}
      </Loaded>
    </Drawer>
  );
}

export function ErrorsPage() {
  useTitle('Error log');
  const [f, setF] = useFilters({ status: 'unresolved', source: '', q: '', sort: '' });
  const list = useList<{ counts: Record<string, number> }>('/api/admin/errors', { status: f.status, source: f.source, q: f.q, sort: f.sort, page: f.page });
  const [open, setOpen] = useState<string | null>(null);
  const { run, busy } = useAct();
  const confirm = useConfirm();
  const counts = list.data?.counts ?? {};
  const tab = (value: string, label: string) => ({ value, label: counts[value] ? `${label} (${counts[value]})` : label });
  const resolveAll = async () => {
    if (await confirm({ title: `Mark all ${counts.unresolved} unresolved errors as resolved?`, body: 'Any that happen again will reopen by themselves.', confirmLabel: 'Resolve all' })) {
      void run({ key: 'bulk', fn: () => api<R>('/api/admin/errors/bulk', { json: { all_with_status: 'unresolved', status: 'resolved' } }), ok: (r) => `${r.affected} errors marked as resolved` });
    }
  };
  const columns: Column<R>[] = [
    {
      key: 'title', header: 'Error',
      cell: (e) => (
        <div className="max-w-[min(60vw,460px)]">
          <div className="truncate font-medium">{e.title}</div>
          <div className="truncate font-mono text-xs text-muted">{e.source}{e.endpoint ? ` · ${e.endpoint}` : ''}</div>
        </div>
      ),
    },
    { key: 'status', header: 'Status', cell: (e) => <StatusBadge status={e.status} /> },
    { key: 'count', header: 'Times', align: 'right', cell: (e) => number(e.event_count) },
    { key: 'last', header: 'Last seen', cell: (e) => <span title={dateTime(e.last_seen)}>{ago(e.last_seen)}</span> },
    { key: 'first', header: 'First seen', cell: (e) => <span className="text-muted">{ago(e.first_seen)}</span>, hideOnMobile: true },
  ];
  return (
    <>
      <PageHeader
        title="Error log"
        description="Problems on the server and in readers' browsers, grouped so each distinct error appears once with a count."
        actions={counts.unresolved > 1 && f.status === 'unresolved' ? <Button loading={busy === 'bulk'} onClick={resolveAll}>Resolve all</Button> : undefined}
      />
      <div className="mb-4"><Tabs value={f.status} onChange={(status) => setF({ status })} tabs={[tab('unresolved', 'Unresolved'), tab('resolved', 'Resolved'), tab('ignored', 'Ignored'), { value: 'all', label: 'All' }]} /></div>
      <FilterBar>
        <SearchInput value={f.q} onChange={(q) => setF({ q })} placeholder="Search by message or address" />
        <FilterSelect label="Where" value={f.source} onChange={(source) => setF({ source })} options={[['', 'Server and browser'], ['api', 'Server (API)'], ['web', 'Browser'], ['job', 'Background jobs']]} />
        <FilterSelect label="Sort" value={f.sort} onChange={(sort) => setF({ sort })} options={[['', 'Most recent'], ['count', 'Most frequent'], ['first_seen', 'Newest errors']]} />
      </FilterBar>
      <DataList
        query={list}
        columns={columns}
        onRowClick={(e) => setOpen(e.id)}
        onPage={(page) => setF({ page })}
        empty={{ icon: <Bug />, title: f.status === 'unresolved' && !f.q && !f.source ? 'No unresolved errors' : 'No errors match', hint: f.status === 'unresolved' ? 'Nothing needs looking at. New errors show up here on their own.' : 'Try another tab or clear the search.' }}
      />
      {open && <ErrorDrawer id={open} onClose={() => setOpen(null)} />}
    </>
  );
}

// ---------------------------------------------------------------- cron runs

export function CronPage() {
  useTitle('Cron runs');
  const [f, setF] = useFilters({ job: '', ok: '' });
  const list = useList<{ jobs: R[] }>('/api/admin/cron-runs', { job: f.job, ok: f.ok, page: f.page, limit: 50 });
  const health = useAdminQuery<R>('/api/admin/health');
  const jobs = list.data?.jobs ?? [];
  return (
    <>
      <PageHeader title="Cron runs" description="Scheduled work: sending queued email, settling memberships, publishing scheduled releases and clean-up." />
      {health.data && !health.data.jobs.in_process && !health.data.jobs.cron_secret_set && (
        <div className="mb-4"><Notice tone="warn">Background jobs are not running in this server process and the cron endpoints are disabled (no CRON_SECRET), so scheduled work is not happening.</Notice></div>
      )}
      {jobs.length > 0 && (
          <div className="mb-6">
            <h2 className="mb-3 text-lg font-semibold">Last 7 days</h2>
            <Table
              rowKey={(j: R) => j.job}
              rows={jobs}
              onRowClick={(j: R) => setF({ job: j.job })}
              columns={[
                { key: 'job', header: 'Job', cell: (j: R) => <span className="font-medium">{j.job}</span> },
                { key: 'runs', header: 'Runs', align: 'right', cell: (j: R) => number(j.runs) },
                { key: 'fail', header: 'Failures', align: 'right', cell: (j: R) => (j.failures ? <span className="text-danger">{number(j.failures)}</span> : '0') },
                { key: 'last', header: 'Last run', cell: (j: R) => ago(j.last_run) },
                { key: 'ok', header: 'Last success', cell: (j: R) => (j.last_success ? ago(j.last_success) : <span className="text-danger">None this week</span>) },
              ]}
            />
          </div>
      )}
      <FilterBar>
        <FilterSelect label="Job" value={f.job} onChange={(job) => setF({ job })} options={[['', 'All jobs'], ...[...new Set([...jobs.map((j) => j.job as string), ...(f.job ? [f.job] : [])])].map((j): [string, string] => [j, j])]} />
        <FilterSelect label="Result" value={f.ok} onChange={(ok) => setF({ ok })} options={[['', 'Any result'], ['1', 'Succeeded'], ['0', 'Failed']]} />
      </FilterBar>
      <DataList
        query={list}
        onPage={(page) => setF({ page })}
        empty={{ icon: <CalendarClock />, title: 'No runs recorded', hint: 'Runs appear here once the scheduler calls the cron endpoints. Set CRON_SECRET on the server and point your scheduler at /api/cron.' }}
        columns={[
          { key: 'when', header: 'Started', cell: (r) => dateTime(r.started_at) },
          { key: 'job', header: 'Job', cell: (r) => r.job },
          { key: 'ok', header: 'Result', cell: (r) => (r.ok ? <Badge tone="ok">Succeeded</Badge> : <Badge tone="danger">Failed</Badge>) },
          { key: 'ms', header: 'Took', align: 'right', cell: (r) => (r.ms === null ? '—' : r.ms >= 1000 ? `${(r.ms / 1000).toFixed(1)} s` : `${r.ms} ms`) },
          { key: 'detail', header: 'Detail', cell: (r) => <span className="block max-w-[420px] truncate text-muted" title={r.detail ?? ''}>{r.detail ?? '—'}</span> },
        ]}
      />
    </>
  );
}
