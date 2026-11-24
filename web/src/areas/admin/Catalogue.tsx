import { BookOpen, Flag, MessageSquare } from 'lucide-react';
import { Link } from 'react-router';
import { api, errorMessage } from '@/lib/api';
import { ago, date, dateTime, number, plural } from '@/lib/format';
import { Badge, Button, Card, EmptyState, ErrorState, Notice, PageHeader, Pagination, Skeleton, useConfirm } from '@/ui';
import type { Column } from '@/ui';
import { DataList, FilterBar, FilterSelect, SearchInput, StatusBadge, useAct, useAsk, useFilters, useList, useTitle } from './shared';
import type { AskField, R } from './shared';

/**
 * The platform's position: creators publish freely, and explicit adult work is
 * welcome when it carries the 18+ label. Only these hard limits justify
 * removing something, so every takedown names the one that applies.
 */
const HARD_LIMITS = [
  'Sexual content involving minors',
  'Sexual depiction of a real person without their consent',
  'Published without the rights to the work',
  'Illegal content',
  'AI-generated comic',
];
const LIMITS_NOTE = 'Explicit adult content is allowed when it carries the 18+ label, so "too explicit" is not a reason to remove a title. If the label is simply missing, add the label instead.';

const ruleFields = (detailHint: string): AskField[] => [
  { name: 'rule', label: 'Which rule does it break?', type: 'select', required: true, initial: '', options: [{ value: '', label: 'Choose the rule that applies' }, ...HARD_LIMITS.map((r) => ({ value: r, label: r }))] },
  { name: 'detail', label: 'What you found', type: 'textarea', required: true, minLength: 3, hint: detailHint },
];
const ruleReason = (v: R) => `${v.rule}. ${v.detail}`;

// ---------------------------------------------------------------- series

export function SeriesPage() {
  useTitle('Series');
  const [f, setF] = useFilters({ q: '', visibility: '', access_model: '', mature: '', takedown: '', reported: '', sort: '' });
  const list = useList('/api/admin/series', { ...f });
  const ask = useAsk();
  const confirm = useConfirm();
  const { run, busy } = useAct();

  const takedown = async (s: R) => {
    const v = await ask({
      title: `Take down "${s.title}"?`,
      body: `The series leaves the store and any featured rows, and the brand owners are told which rule it broke. ${LIMITS_NOTE}`,
      fields: ruleFields('Sent to the brand owners with the rule, so be specific about where the problem is.'),
      confirmLabel: 'Take down',
      danger: true,
    });
    if (v) void run({ key: `td-${s.id}`, fn: () => api(`/api/admin/series/${s.id}/takedown`, { json: { reason: ruleReason(v) } }), ok: 'Series taken down' });
  };
  const restore = async (s: R) => {
    if (await confirm({ title: `Restore "${s.title}"?`, body: 'It becomes visible again and the brand owners are told.', confirmLabel: 'Restore' })) {
      void run({ key: `td-${s.id}`, fn: () => api(`/api/admin/series/${s.id}/restore`, { method: 'POST' }), ok: 'Series restored' });
    }
  };
  const mature = async (s: R) => {
    const next = !s.mature;
    if (await confirm({ title: next ? `Add the 18+ label to "${s.title}"?` : `Remove the 18+ label from "${s.title}"?`, body: next ? 'The series stays published and on sale. The label only means it is shown to readers who have chosen to see adult content. It is a label, not a penalty; the brand owners are told it was added.' : 'Every reader will be able to see it, including those who have not chosen to see adult content.', confirmLabel: next ? 'Add 18+ label' : 'Remove 18+ label' })) {
      void run({ key: `m-${s.id}`, fn: () => api(`/api/admin/series/${s.id}/mature`, { json: { mature: next } }), ok: next ? '18+ label added' : '18+ label removed' });
    }
  };
  const feature = async (s: R) => {
    const featured = !s.featured_slots.includes('staff_picks');
    if (await confirm({ title: featured ? `Add "${s.title}" to staff picks?` : `Remove "${s.title}" from staff picks?`, body: featured ? 'It is added at the end of the staff picks row on the store.' : 'It leaves the staff picks row.', confirmLabel: featured ? 'Add to staff picks' : 'Remove' })) {
      void run({ key: `f-${s.id}`, fn: () => api(`/api/admin/series/${s.id}/feature`, { json: { slot: 'staff_picks', featured } }), ok: featured ? 'Added to staff picks' : 'Removed from staff picks' });
    }
  };

  const row = (s: R) => (
    <li key={s.id} className="flex flex-wrap items-center gap-x-4 gap-y-3 border-b border-line px-3.5 py-3 last:border-0">
      <span className="flex min-w-0 flex-1 basis-64 items-center gap-3">
        {s.cover_url ? <img src={s.cover_url} alt="" loading="lazy" className="aspect-[2/3] w-10 shrink-0 rounded border border-line object-cover" /> : <span className="flex aspect-[2/3] w-10 shrink-0 items-center justify-center rounded border border-line bg-raised text-faint"><BookOpen className="size-4" /></span>}
        <span className="min-w-0">
          <Link className="block truncate font-medium hover:text-accent-hover" to={`/series/${s.slug}`}>{s.title}</Link>
          <span className="block truncate text-xs text-muted">
            <Link className="hover:text-paper" to={`/admin/brands/${s.publisher_id}`}>{s.publisher_name}</Link> · <span className="capitalize">{s.access_model}</span> · {plural(s.release_count, 'release')} · {number(s.read_count)} reads · updated {ago(s.updated_at)}
          </span>
          <span className="mt-1.5 flex flex-wrap gap-1">
            {s.takedown_at ? <span title={s.takedown_reason ?? ''}><StatusBadge status="taken down" /></span> : <StatusBadge status={s.visibility} />}
            {s.mature && <Badge tone="info">18+</Badge>}
            {s.open_reports > 0 && <Badge tone="danger">{plural(s.open_reports, 'report')}</Badge>}
            {s.featured_slots.map((slot: string) => <Badge key={slot} tone="accent">{slot.replace('_', ' ')}</Badge>)}
          </span>
          {s.takedown_at && s.takedown_reason && <span className="mt-1 block text-xs text-danger">{s.takedown_reason}</span>}
        </span>
      </span>
      <span className="flex flex-wrap gap-1.5">
        <Button size="sm" loading={busy === `m-${s.id}`} onClick={() => mature(s)}>{s.mature ? 'Remove 18+ label' : 'Add 18+ label'}</Button>
        {s.visibility === 'public' && !s.takedown_at && <Button size="sm" loading={busy === `f-${s.id}`} onClick={() => feature(s)}>{s.featured_slots.includes('staff_picks') ? 'Remove staff pick' : 'Staff pick'}</Button>}
        {s.takedown_at
          ? <Button size="sm" loading={busy === `td-${s.id}`} onClick={() => restore(s)}>Restore</Button>
          : <Button size="sm" variant="danger" loading={busy === `td-${s.id}`} onClick={() => takedown(s)}>Take down</Button>}
      </span>
    </li>
  );
  return (
    <>
      <PageHeader title="Series" description="Every series on the platform. Adult work is welcome here when it carries the 18+ label. Take a series down only when it breaks one of the hard limits." />
      <FilterBar>
        <SearchInput value={f.q} onChange={(q) => setF({ q })} placeholder="Search by title, address or brand" />
        <FilterSelect label="Visibility" value={f.visibility} onChange={(visibility) => setF({ visibility })} options={[['', 'Any visibility'], ['public', 'Public'], ['unlisted', 'Unlisted'], ['draft', 'Draft']]} />
        <FilterSelect label="Access" value={f.access_model} onChange={(access_model) => setF({ access_model })} options={[['', 'Any access'], ['free', 'Free'], ['premium', 'Premium'], ['blocked', 'Blocked']]} />
        <FilterSelect label="18+ label" value={f.mature} onChange={(mature) => setF({ mature })} options={[['', 'With or without 18+ label'], ['1', 'Has the 18+ label'], ['0', 'No 18+ label']]} />
        <FilterSelect label="Moderation" value={f.takedown} onChange={(takedown) => setF({ takedown })} options={[['', 'Taken down or not'], ['1', 'Taken down'], ['0', 'Not taken down']]} />
        <FilterSelect label="Reports" value={f.reported} onChange={(reported) => setF({ reported })} options={[['', 'With or without reports'], ['1', 'Has open reports']]} />
        <FilterSelect label="Sort" value={f.sort} onChange={(sort) => setF({ sort })} options={[['', 'Newest first'], ['updated', 'Recently updated'], ['reads', 'Most read'], ['title', 'Title A-Z']]} />
      </FilterBar>
      {list.isPending ? (
        <Skeleton className="h-72 w-full" />
      ) : list.isError ? (
        <ErrorState message={errorMessage(list.error)} retry={() => void list.refetch()} />
      ) : list.data.items.length === 0 ? (
        <EmptyState icon={<BookOpen />} title="No series match" action={<Button onClick={() => setF({ q: '', visibility: '', access_model: '', mature: '', takedown: '', reported: '' })}>Clear filters</Button>}>
          Series show up here as soon as a creator makes one. Try clearing the filters.
        </EmptyState>
      ) : (
        <>
          <ul className="rounded-xl border border-line">{list.data.items.map(row)}</ul>
          <div className="mt-2 text-xs text-faint">{number(list.data.total)} in total</div>
          <Pagination page={list.data.page} pages={Math.ceil(list.data.total / list.data.limit)} onPage={(page) => setF({ page })} />
        </>
      )}
    </>
  );
}

// ---------------------------------------------------------------- reports

const KIND_LABEL: Record<string, string> = { series: 'Series', release: 'Release', comment: 'Comment', publisher: 'Brand', user: 'User' };

export function ReportsPage() {
  useTitle('Reports');
  const [f, setF] = useFilters({ status: 'open', target_kind: '' });
  const list = useList('/api/admin/reports', { status: f.status, target_kind: f.target_kind, page: f.page, limit: 25 });
  const ask = useAsk();
  const confirm = useConfirm();
  const { run, busy } = useAct();

  const resolve = (r: R, body: R, ok: string) => run({ key: r.id, fn: () => api<R>(`/api/admin/reports/${r.id}/resolve`, { json: body }), ok: (res) => (res.closed > 1 ? `${ok}. ${res.closed} reports about the same thing were closed.` : ok) });
  const dismiss = async (r: R) => {
    if (await confirm({ title: 'Dismiss this report?', body: `${r.open_on_target > 1 ? `Nothing is changed. All ${r.open_on_target} open reports about this are closed.` : 'Nothing is changed and the report is closed.'} This is the right call when the work is within the rules, including labelled adult content.`, confirmLabel: 'Dismiss' })) void resolve(r, { decision: 'dismiss' }, 'Report dismissed');
  };
  /** The usual answer to "this is too explicit": label it, leave it published, close the report. */
  const label18 = async (r: R, seriesId: string) => {
    if (await confirm({ title: 'Add the 18+ label and close the report?', body: 'The series stays published. From now on it is only shown to readers who have chosen to see adult content, and the brand owners are told the label was added.', confirmLabel: 'Add 18+ label' })) {
      void run({
        key: r.id,
        fn: async () => {
          await api(`/api/admin/series/${seriesId}/mature`, { json: { mature: true } });
          return api<R>(`/api/admin/reports/${r.id}/resolve`, { json: { decision: 'action', reason: 'Added the 18+ label' } });
        },
        ok: '18+ label added and report closed',
      });
    }
  };
  const noted = async (r: R) => {
    if (await confirm({ title: 'Mark as handled?', body: 'Use this when you have already dealt with it another way. The report is closed as actioned.', confirmLabel: 'Mark as handled' })) void resolve(r, { decision: 'action' }, 'Report closed');
  };
  const step = async (r: R, flags: R, title: string, body: string, label: string, ok: string, needsReason: boolean | 'rule' = true) => {
    if (needsReason === 'rule') {
      const v = await ask({ title, body: `${body} ${LIMITS_NOTE}`, fields: ruleFields('Sent to the brand owners with the rule, and kept in the audit log.'), confirmLabel: label, danger: true });
      if (v) void resolve(r, { decision: 'action', ...flags, reason: ruleReason(v) }, ok);
    } else if (needsReason) {
      const v = await ask({ title, body, fields: [{ name: 'reason', label: 'Reason', type: 'textarea', required: true, minLength: 3, initial: `Reported: ${r.reason}`, hint: 'Sent to the people affected and kept in the audit log.' }], confirmLabel: label, danger: true });
      if (v) void resolve(r, { decision: 'action', ...flags, reason: v.reason }, ok);
    } else if (await confirm({ title, body, confirmLabel: label, danger: true })) {
      void resolve(r, { decision: 'action', ...flags }, ok);
    }
  };

  return (
    <>
      <PageHeader title="Reports" description="What readers have flagged. Each button closes the report and carries out the step in one go." />
      <div className="mb-4">
        <Notice>
          Adult and explicit work is allowed when it carries the 18+ label. Remove something only when it breaks a hard limit: {HARD_LIMITS.map((l) => l.toLowerCase()).join('; ')}. For a correctly labelled adult title reported as too explicit, dismiss the report.
        </Notice>
      </div>
      <FilterBar>
        <FilterSelect label="Status" value={f.status} onChange={(status) => setF({ status })} options={[['open', 'Open'], ['actioned', 'Actioned'], ['dismissed', 'Dismissed'], ['all', 'All reports']]} />
        <FilterSelect label="About" value={f.target_kind} onChange={(target_kind) => setF({ target_kind })} options={[['', 'Anything'], ['series', 'Series'], ['release', 'Releases'], ['comment', 'Comments'], ['publisher', 'Brands'], ['user', 'Users']]} />
      </FilterBar>
      {list.isPending ? (
        <Skeleton className="h-72 w-full" />
      ) : list.isError ? (
        <ErrorState message={errorMessage(list.error)} retry={() => void list.refetch()} />
      ) : list.data.items.length === 0 ? (
        <EmptyState icon={<Flag />} title={f.status === 'open' ? 'The queue is clear' : 'No reports match'}>
          {f.status === 'open' ? 'New reports from readers land here. Nothing is waiting for you.' : 'Try another status or type.'}
        </EmptyState>
      ) : (
        <div className="space-y-3">
          {list.data.items.map((r) => {
            const t = r.target as R | null;
            const open = r.status === 'open';
            return (
              <Card key={r.id} className="p-4 sm:p-5">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone="info">{KIND_LABEL[r.target_kind] ?? r.target_kind}</Badge>
                  <span className="font-semibold">{r.reason}</span>
                  {r.open_on_target > 1 && <Badge tone="danger">{r.open_on_target} open reports on this</Badge>}
                  {!open && <StatusBadge status={r.status} />}
                  <span className="ml-auto text-xs text-muted" title={dateTime(r.created_at)}>{ago(r.created_at)} by {r.reporter_username ? `@${r.reporter_username}` : 'a visitor'}</span>
                </div>
                <div className="mt-2 text-sm">
                  {t ? (
                    <>
                      {t.url ? <Link className="link" to={t.url}>{t.label}</Link> : <span className="font-medium">{t.label}</span>}
                      {r.target_kind === 'user' && <> · <Link className="link" to={`/admin/users/${r.target_id}`}>Open user</Link></>}
                      {r.target_kind === 'publisher' && <> · <Link className="link" to={`/admin/brands/${r.target_id}`}>Open brand</Link></>}
                      {(t.takedown_at || t.hidden_at || t.deleted_at || t.banned_at || t.suspended_at) && <Badge tone="neutral" className="ml-2">{t.takedown_at ? 'Already taken down' : t.deleted_at ? 'Already deleted' : t.hidden_at ? 'Already hidden' : t.banned_at ? 'Already banned' : 'Already suspended'}</Badge>}
                    </>
                  ) : (
                    <span className="text-muted">The reported item no longer exists.</span>
                  )}
                </div>
                {r.target_kind === 'comment' && t?.body && <blockquote className="mt-2 whitespace-pre-line break-words border-l-2 border-line-strong pl-3 text-sm text-muted">{t.body}</blockquote>}
                {r.detail && <p className="mt-2 whitespace-pre-line break-words text-sm"><span className="text-muted">Reporter wrote:</span> {r.detail}</p>}
                {open ? (
                  <div className="mt-4 flex flex-wrap gap-2">
                    {r.target_kind === 'comment' && t && (
                      <>
                        <Button size="sm" loading={busy === r.id} onClick={() => step(r, { hide_comment: true }, 'Hide this comment?', 'Readers stop seeing it. The author is not told.', 'Hide comment', 'Comment hidden', false)}>Hide comment</Button>
                        <Button size="sm" variant="danger" disabled={busy === r.id} onClick={() => step(r, { hide_comment: true, ban_user: true }, `Hide the comment and ban @${t.username}?`, 'The comment is hidden and its author is signed out and blocked from signing in.', 'Hide and ban', 'Comment hidden and author banned')}>Hide and ban author</Button>
                      </>
                    )}
                    {(r.target_kind === 'series' || r.target_kind === 'release') && t && (
                      <>
                        {!t.takedown_at && <Button size="sm" loading={busy === r.id} onClick={() => label18(r, r.target_kind === 'series' ? r.target_id : t.series_id)}>Add 18+ label</Button>}
                        <Button size="sm" variant="danger" disabled={busy === r.id} onClick={() => step(r, { takedown_series: true }, 'Take down this series?', 'The whole series leaves the store and the brand owners are told which rule it broke.', 'Take down series', 'Series taken down', 'rule')}>Take down series</Button>
                      </>
                    )}
                    {r.target_kind === 'user' && t && (
                      <Button size="sm" variant="danger" loading={busy === r.id} onClick={() => step(r, { ban_user: true }, `Ban ${t.label}?`, 'They are signed out everywhere and cannot sign in again until unbanned.', 'Ban user', 'User banned')}>Ban user</Button>
                    )}
                    {r.target_kind === 'publisher' && t && (
                      <Button size="sm" variant="danger" loading={busy === r.id} onClick={() => step(r, { suspend_brand: true }, `Suspend ${t.label}?`, 'The brand owners are told why. Payouts are held while suspended.', 'Suspend brand', 'Brand suspended', 'rule')}>Suspend brand</Button>
                    )}
                    <Button size="sm" disabled={busy === r.id} onClick={() => noted(r)}>Mark as handled</Button>
                    <Button size="sm" variant="ghost" disabled={busy === r.id} onClick={() => dismiss(r)}>Dismiss</Button>
                  </div>
                ) : (
                  <p className="mt-3 text-xs text-muted">Closed {date(r.resolved_at)}{r.resolved_by_username ? ` by @${r.resolved_by_username}` : ''}</p>
                )}
              </Card>
            );
          })}
          <Pagination page={list.data.page} pages={Math.ceil(list.data.total / list.data.limit)} onPage={(page) => setF({ page })} />
        </div>
      )}
    </>
  );
}

// ---------------------------------------------------------------- comments

export function CommentsPage() {
  useTitle('Comments');
  const [f, setF] = useFilters({ q: '', status: '' });
  const list = useList('/api/admin/comments', { q: f.q, status: f.status, page: f.page });
  const confirm = useConfirm();
  const { run, busy } = useAct();
  const columns: Column<R>[] = [
    {
      key: 'body', header: 'Comment',
      cell: (c) => (
        <div className="w-[min(46vw,340px)] min-w-[220px]">
          <p className="line-clamp-3 whitespace-pre-line break-words">{c.body}</p>
          <p className="mt-1 text-xs text-muted">
            <Link className="hover:text-paper" to={`/admin/users/${c.user_id}`}>@{c.username}</Link>{c.user_banned_at ? ' (banned)' : ''} on <Link className="hover:text-paper" to={`/series/${c.series_slug}`}>{c.series_title}</Link> · {ago(c.created_at)}
          </p>
        </div>
      ),
    },
    {
      key: 'state', header: 'Status',
      cell: (c) => (
        <span className="flex flex-wrap gap-1">
          {c.deleted_at ? <StatusBadge status="deleted" /> : c.hidden_at ? <Badge tone="warn">Hidden</Badge> : <Badge tone="ok">Visible</Badge>}
          {c.open_reports > 0 && <Badge tone="danger">{c.open_reports} {c.open_reports === 1 ? 'report' : 'reports'}</Badge>}
        </span>
      ),
    },
    {
      key: 'actions', header: 'Actions',
      cell: (c) => c.deleted_at ? <span className="text-faint">—</span> : (
        <span className="flex gap-1.5">
          <Button size="sm" loading={busy === `h-${c.id}`} onClick={async () => {
            const hidden = !c.hidden_at;
            if (await confirm({ title: hidden ? 'Hide this comment?' : 'Show this comment again?', body: hidden ? 'Readers stop seeing it. You can show it again later.' : 'Readers will see it again.', confirmLabel: hidden ? 'Hide' : 'Show' })) {
              void run({ key: `h-${c.id}`, fn: () => api(`/api/admin/comments/${c.id}/hide`, { json: { hidden } }), ok: hidden ? 'Comment hidden' : 'Comment visible again' });
            }
          }}>{c.hidden_at ? 'Show' : 'Hide'}</Button>
          <Button size="sm" variant="danger" loading={busy === `d-${c.id}`} onClick={async () => {
            if (await confirm({ title: 'Delete this comment?', body: 'It is removed for everyone and cannot be brought back from here.', confirmLabel: 'Delete', danger: true })) {
              void run({ key: `d-${c.id}`, fn: () => api(`/api/admin/comments/${c.id}`, { method: 'DELETE' }), ok: 'Comment deleted' });
            }
          }}>Delete</Button>
        </span>
      ),
    },
  ];
  return (
    <>
      <PageHeader title="Comments" description="Reader comments across every series, newest first." />
      <FilterBar>
        <SearchInput value={f.q} onChange={(q) => setF({ q })} placeholder="Search comment text" />
        <FilterSelect label="Status" value={f.status} onChange={(status) => setF({ status })} options={[['', 'All comments'], ['reported', 'Reported'], ['visible', 'Visible'], ['hidden', 'Hidden'], ['deleted', 'Deleted']]} />
      </FilterBar>
      <DataList
        query={list}
        columns={columns}
        onPage={(page) => setF({ page })}
        empty={{ icon: <MessageSquare />, title: 'No comments match', hint: 'Comments appear here as readers post them. Try another filter.', action: <Button onClick={() => setF({ q: '', status: '' })}>Clear filters</Button> }}
      />
    </>
  );
}
