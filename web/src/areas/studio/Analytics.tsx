import { useQuery } from '@tanstack/react-query';
import { Download } from 'lucide-react';
import { useState } from 'react';
import type { ReactNode } from 'react';
import { useSearchParams } from 'react-router';
import { api, withQuery } from '@/lib/api';
import { date, money, moneyExact, number, percent } from '@/lib/format';
import { BarChart, Card, EmptyState, Field, Input, RankList, Segmented, Select, Stat, Table, Tabs } from '@/ui';
import { BrandPage, Q, cap, countryName, useBrand } from './shared';

type Metric = { value: number; previous: number; change: number; change_pct: number | null };
type RangeMeta = { from: string; to: string; days: number; previous: { from: string; to: string } };
type Dashboard = {
  range: RangeMeta; currency: string;
  readers: { unique_readers: Metric; visits: Metric; page_reads: Metric };
  revenue: { tips: Metric; membership: Metric; sales: Metric; adjustments: Metric; total: Metric };
  engagement: { followers: Metric; favorites: Metric; forum_posts: Metric; comments: Metric; followers_total: number; favorites_total: number };
  emails: { sent: Metric; opened: Metric; clicked: Metric };
};
type Report<T, X = object> = { range: RangeMeta; columns: string[]; rows: T[] } & X;
type RangeQuery = { range?: string; from?: string; to?: string };

const VIEWS = [
  ['overview', 'Overview'], ['reads', 'Page reads'], ['releases', 'Releases'], ['dropoff', 'Drop-off'], ['countries', 'Countries'], ['followers', 'Followers'],
  ['engagement', 'Engagement'], ['emails', 'Email'], ['revenue', 'Revenue'],
] as const;
type View = (typeof VIEWS)[number][0];

const day = (iso: string) => date(iso, { month: 'short', day: 'numeric', timeZone: 'UTC' });

function useReport<T>(brandId: string, path: string, q: RangeQuery, extra: Record<string, string | undefined> = {}, enabled = true) {
  return useQuery({ queryKey: ['studio', 'analytics', brandId, path, q, extra], queryFn: () => api<T>(`/api/studio/brands/${brandId}/analytics/${path}`, { query: { ...q, ...extra } }), enabled });
}

function Csv({ brandId, path, q, extra }: { brandId: string; path: string; q: RangeQuery; extra?: Record<string, string | undefined> }) {
  return <a href={withQuery(`/api/studio/brands/${brandId}/analytics/${path}`, { ...q, ...extra, format: 'csv' })} className="inline-flex h-8 items-center gap-1.5 rounded-md border border-line bg-raised px-3 text-[13px] hover:bg-hover"><Download className="size-4" />Export CSV</a>;
}

function Panel({ title, note, actions, children }: { title: string; note?: ReactNode; actions?: ReactNode; children: ReactNode }) {
  return (
    <Card className="min-w-0 p-4 sm:p-5">
      <div className="mb-4 flex flex-wrap items-start justify-between gap-2">
        <div><h2 className="text-base font-semibold">{title}</h2>{note && <p className="mt-0.5 text-xs text-muted">{note}</p>}</div>
        {actions}
      </div>
      {children}
    </Card>
  );
}

function StatGroup({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section>
      <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-muted">{title}</h2>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">{children}</div>
    </section>
  );
}

function Overview({ brandId, q }: { brandId: string; q: RangeQuery }) {
  const dash = useReport<Dashboard>(brandId, 'dashboard', q);
  return (
    <Q query={dash}>
      {(d) => {
        const m = (c: number) => money(c, d.currency);
        const prev = `vs ${day(d.range.previous.from)} to ${day(d.range.previous.to)}`;
        const rate = (a: Metric, b: Metric) => (b.value ? `${percent(a.value / b.value)} of sent` : undefined);
        return (
          <div className="space-y-6">
            <div className="flex flex-wrap items-center justify-between gap-2 text-sm text-muted">
              <span>{date(d.range.from, { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' })} to {date(d.range.to, { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' })}. Changes are {prev}.</span>
              <Csv brandId={brandId} path="dashboard" q={q} />
            </div>
            <StatGroup title="Readers">
              <Stat label="Unique readers" value={number(d.readers.unique_readers.value)} delta={d.readers.unique_readers.change} />
              <Stat label="Visits" value={number(d.readers.visits.value)} delta={d.readers.visits.change} />
              <Stat label="Page reads" value={number(d.readers.page_reads.value)} delta={d.readers.page_reads.change} />
            </StatGroup>
            <StatGroup title="Revenue">
              <Stat label="Tips" value={m(d.revenue.tips.value)} hint={`${m(d.revenue.tips.previous)} before`} />
              <Stat label="Membership" value={m(d.revenue.membership.value)} hint={`${m(d.revenue.membership.previous)} before`} />
              <Stat label="Sales" value={m(d.revenue.sales.value)} hint={`${m(d.revenue.sales.previous)} before · reading and downloads`} />
              <Stat label="Total earned" value={m(d.revenue.total.value)} hint={`${m(d.revenue.total.previous)} before${d.revenue.adjustments.value ? ` · includes ${m(d.revenue.adjustments.value)} refunds and adjustments` : ''}`} />
            </StatGroup>
            <StatGroup title="Engagement">
              <Stat label="New followers" value={number(d.engagement.followers.value)} delta={d.engagement.followers.change} hint={`${number(d.engagement.followers_total)} in total`} />
              <Stat label="New favourites" value={number(d.engagement.favorites.value)} delta={d.engagement.favorites.change} hint={`${number(d.engagement.favorites_total)} in total`} />
              <Stat label="Forum posts" value={number(d.engagement.forum_posts.value)} delta={d.engagement.forum_posts.change} />
              <Stat label="Comments" value={number(d.engagement.comments.value)} delta={d.engagement.comments.change} />
            </StatGroup>
            <StatGroup title="Emails sent for your brand">
              <Stat label="Sent" value={number(d.emails.sent.value)} delta={d.emails.sent.change} />
              <Stat label="Opened" value={number(d.emails.opened.value)} delta={d.emails.opened.change} hint={rate(d.emails.opened, d.emails.sent)} />
              <Stat label="Clicked" value={number(d.emails.clicked.value)} delta={d.emails.clicked.change} hint={rate(d.emails.clicked, d.emails.sent)} />
            </StatGroup>
          </div>
        );
      }}
    </Q>
  );
}

type DayReads = { day: string; page_reads: number; member_page_reads: number; guest_page_reads: number; readers: number };
type SeriesReads = { series_id: string; title: string; page_reads: number; readers: number };
type ReleaseReads = { release_id: string; series_title: string; title: string; kind: string; number: number; language: string; status: string; page_count: number; page_reads: number; readers: number; visits: number };

function Reads({ brandId, q }: { brandId: string; q: RangeQuery }) {
  const byDay = useReport<Report<DayReads>>(brandId, 'page-reads', q, { group: 'day' });
  const bySeries = useReport<Report<SeriesReads>>(brandId, 'page-reads', q, { group: 'series' });
  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
      <Panel title="Page reads per day" note="Signed-in readers and guests together." actions={<Csv brandId={brandId} path="page-reads" q={q} extra={{ group: 'day' }} />}>
        <Q query={byDay}>{(d) => (d.rows.some((r) => r.page_reads) ? <BarChart data={d.rows.map((r) => ({ label: day(r.day), value: r.page_reads }))} format={number} height={200} /> : <p className="py-10 text-center text-sm text-muted">No pages were read in this period.</p>)}</Q>
      </Panel>
      <Panel title="By series" actions={<Csv brandId={brandId} path="page-reads" q={q} extra={{ group: 'series' }} />}>
        <Q query={bySeries}>{(d) => <RankList items={d.rows.filter((r) => r.page_reads > 0).map((r) => ({ label: r.title, value: r.page_reads }))} format={number} />}</Q>
      </Panel>
    </div>
  );
}

function Releases({ brandId, q, openDropoff }: { brandId: string; q: RangeQuery; openDropoff: (id: string) => void }) {
  const rows = useReport<Report<ReleaseReads>>(brandId, 'page-reads', q, { group: 'release' });
  return (
    <Panel title="Reads by release" note="Select a row to see where readers stop." actions={<Csv brandId={brandId} path="page-reads" q={q} extra={{ group: 'release' }} />}>
      <Q query={rows}>
        {(d) => (
          <Table
            rows={d.rows}
            rowKey={(r) => r.release_id}
            empty="No releases yet"
            onRowClick={(r) => openDropoff(r.release_id)}
            columns={[
              { key: 't', header: 'Release', cell: (r) => <div><div className="font-medium">{r.title}</div><div className="text-xs text-muted">{r.series_title} · {cap(r.kind)} {Number(r.number)} · {r.language.toUpperCase()}</div></div> },
              { key: 's', header: 'Status', cell: (r) => cap(r.status), hideOnMobile: true },
              { key: 'p', header: 'Pages', align: 'right', cell: (r) => r.page_count, hideOnMobile: true },
              { key: 'r', header: 'Readers', align: 'right', cell: (r) => number(r.readers) },
              { key: 'v', header: 'Visits', align: 'right', cell: (r) => number(r.visits), hideOnMobile: true },
              { key: 'pr', header: 'Page reads', align: 'right', cell: (r) => number(r.page_reads) },
            ]}
          />
        )}
      </Q>
    </Panel>
  );
}

type Drop = { position: number; readers: number; member_readers: number; pct_of_start: number; left_here: number };

function Dropoff({ brandId, q, releaseId, setRelease }: { brandId: string; q: RangeQuery; releaseId: string | null; setRelease: (id: string) => void }) {
  const releases = useReport<Report<ReleaseReads>>(brandId, 'page-reads', q, { group: 'release' });
  const chosen = releaseId ?? releases.data?.rows[0]?.release_id ?? null;
  const drop = useReport<Report<Drop, { release: { title: string; page_count: number; series_title: string }; started: number; finished: number }>>(brandId, `releases/${chosen}/dropoff`, q, {}, Boolean(chosen));
  if (releases.data && !releases.data.rows.length) return <EmptyState title="No releases yet">Drop-off appears once a release has readers.</EmptyState>;
  return (
    <Panel title="Where readers stop" note="How many readers got at least as far as each page." actions={chosen ? <Csv brandId={brandId} path={`releases/${chosen}/dropoff`} q={q} /> : undefined}>
      <Field label="Release" className="mb-4 max-w-md">
        <Select value={chosen ?? ''} onChange={(e) => setRelease(e.target.value)}>{releases.data?.rows.map((r) => <option key={r.release_id} value={r.release_id}>{r.series_title} · {r.title}</option>)}</Select>
      </Field>
      {chosen && (
        <Q query={drop}>
          {(d) => {
            if (!d.started) return <p className="py-10 text-center text-sm text-muted">Nobody read this release in the period you chose.</p>;
            const worstPage = [...d.rows].sort((a, b) => b.left_here - a.left_here)[0];
            return (
              <div className="space-y-4">
                <div className="grid grid-cols-3 gap-3">
                  <Stat label="Started" value={number(d.started)} />
                  <Stat label="Finished" value={number(d.finished)} hint={percent(d.finished / d.started)} />
                  <Stat label="Biggest drop" value={worstPage?.left_here ? `Page ${worstPage.position}` : 'None'} hint={worstPage?.left_here ? `${number(worstPage.left_here)} readers stopped before it` : undefined} />
                </div>
                <BarChart data={d.rows.map((r) => ({ label: `Page ${r.position}`, value: r.readers }))} format={(n) => `${number(n)} readers`} height={200} />
              </div>
            );
          }}
        </Q>
      )}
    </Panel>
  );
}

function Countries({ brandId, q }: { brandId: string; q: RangeQuery }) {
  const rows = useReport<Report<{ country: string; readers: number; page_reads: number; share_pct: number }>>(brandId, 'countries', q);
  return (
    <Panel title="Reader countries" note="Signed-in readers only. Guests are not located." actions={<Csv brandId={brandId} path="countries" q={q} />}>
      <Q query={rows}>{(d) => <RankList items={d.rows.map((r) => ({ label: `${countryName(r.country)} · ${r.share_pct}%`, value: r.readers }))} format={(n) => `${number(n)} readers`} />}</Q>
    </Panel>
  );
}

function Followers({ brandId, q }: { brandId: string; q: RangeQuery }) {
  const rows = useReport<Report<{ day: string; new_followers: number; series_followers: number; brand_followers: number; total: number }>>(brandId, 'followers', q);
  return (
    <Panel title="New followers per day" note="People following a series or the brand." actions={<Csv brandId={brandId} path="followers" q={q} />}>
      <Q query={rows}>
        {(d) => {
          const last = d.rows[d.rows.length - 1];
          const gained = d.rows.reduce((n, r) => n + r.new_followers, 0);
          return (
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3"><Stat label="Followers now" value={number(last?.total ?? 0)} /><Stat label="Gained in this period" value={number(gained)} /></div>
              <BarChart data={d.rows.map((r) => ({ label: day(r.day), value: r.new_followers }))} format={number} />
            </div>
          );
        }}
      </Q>
    </Panel>
  );
}

function Engagement({ brandId, q }: { brandId: string; q: RangeQuery }) {
  const rows = useReport<Report<{ day: string; favorites: number; comments: number; forum_posts: number }>>(brandId, 'engagement', q);
  return (
    <Q query={rows}>
      {(d) => (
        <div className="space-y-4">
          <div className="flex justify-end"><Csv brandId={brandId} path="engagement" q={q} /></div>
          <div className="grid gap-4 lg:grid-cols-3">
            {(['favorites', 'comments', 'forum_posts'] as const).map((k) => (
              <Panel key={k} title={k === 'favorites' ? 'Favourites per day' : k === 'comments' ? 'Comments per day' : 'Forum posts per day'} note={`${number(d.rows.reduce((n, r) => n + r[k], 0))} in this period`}>
                <BarChart data={d.rows.map((r) => ({ label: day(r.day), value: r[k] }))} format={number} height={120} />
              </Panel>
            ))}
          </div>
        </div>
      )}
    </Q>
  );
}

const TEMPLATE_LABEL: Record<string, string> = { new_release: 'New release', backer_code: 'Backer code', team_invite: 'Team invitation', announcement: 'Announcement', other: 'Other' };

function Emails({ brandId, q }: { brandId: string; q: RangeQuery }) {
  const rows = useReport<Report<{ day: string; sent: number; opened: number; clicked: number }, { by_template: { template: string; sent: number; opened: number; clicked: number }[] }>>(brandId, 'emails', q);
  return (
    <Q query={rows}>
      {(d) => (
        <div className="grid gap-4 lg:grid-cols-2">
          <Panel title="Emails sent per day" note="Emails NSFWComix sends for this brand, such as new-release alerts and backer codes." actions={<Csv brandId={brandId} path="emails" q={q} />}>
            <BarChart data={d.rows.map((r) => ({ label: day(r.day), value: r.sent }))} format={number} />
          </Panel>
          <Panel title="By kind of email">
            <Table rows={d.by_template} rowKey={(r) => r.template} empty="No emails were sent in this period" columns={[
              { key: 't', header: 'Email', cell: (r) => TEMPLATE_LABEL[r.template] ?? cap(r.template) },
              { key: 's', header: 'Sent', align: 'right', cell: (r) => number(r.sent) },
              { key: 'o', header: 'Opened', align: 'right', cell: (r) => `${number(r.opened)}${r.sent ? ` (${percent(r.opened / r.sent)})` : ''}` },
              { key: 'c', header: 'Clicked', align: 'right', cell: (r) => `${number(r.clicked)}${r.sent ? ` (${percent(r.clicked / r.sent)})` : ''}` },
            ]} />
          </Panel>
        </div>
      )}
    </Q>
  );
}

type RevMonth = { month: string; tips_cents: number; membership_cents: number; sales_cents: number; refunds_cents: number; adjustments_cents: number; total_cents: number; gross_cents: number };
type MembershipRow = { reading_month: string; series_id: string | null; series_title: string | null; gross_cents: number; amount_cents: number; note: string | null; member_page_reads: number; member_readers: number };

function Revenue({ brandId, q }: { brandId: string; q: RangeQuery }) {
  const rows = useReport<Report<RevMonth, { currency: string; membership_breakdown: MembershipRow[]; by_series: { series_id: string | null; series_title: string | null; total_cents: number }[] }>>(brandId, 'revenue', q);
  return (
    <Q query={rows}>
      {(d) => {
        const m = (c: number) => moneyExact(c, d.currency);
        return (
          <div className="space-y-4">
            <Panel title="Earnings by month" note="What reached your balance, after payment fees and the platform share." actions={<Csv brandId={brandId} path="revenue" q={q} />}>
              <Table rows={d.rows} rowKey={(r) => r.month} empty="Nothing was earned in this period" columns={[
                { key: 'm', header: 'Month', cell: (r) => r.month },
                { key: 't', header: 'Tips', align: 'right', cell: (r) => m(r.tips_cents) },
                { key: 'mb', header: 'Membership', align: 'right', cell: (r) => m(r.membership_cents) },
                { key: 's', header: 'Sales', align: 'right', cell: (r) => m(r.sales_cents) },
                { key: 'r', header: 'Refunds', align: 'right', cell: (r) => m(r.refunds_cents), hideOnMobile: true },
                { key: 'a', header: 'Adjustments', align: 'right', cell: (r) => m(r.adjustments_cents), hideOnMobile: true },
                { key: 'tot', header: 'Total', align: 'right', cell: (r) => <strong>{m(r.total_cents)}</strong> },
              ]} />
            </Panel>
            <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
              <Panel title="By series"><RankList items={d.by_series.filter((s) => s.total_cents > 0).map((s) => ({ label: s.series_title ?? 'Whole brand (tips)', value: s.total_cents }))} format={m} /></Panel>
              <Panel title="How the membership figure is made up" note="Each month, the membership money from readers who read your work is shared out by the pages they read. One row per series per reading month.">
                <Table rows={d.membership_breakdown} rowKey={(r) => `${r.reading_month}-${r.series_id}`} empty="No membership earnings in this period" columns={[
                  { key: 'm', header: 'Reading month', cell: (r) => r.reading_month },
                  { key: 's', header: 'Series', cell: (r) => r.series_title ?? '—' },
                  { key: 'r', header: 'Member readers', align: 'right', cell: (r) => number(r.member_readers) },
                  { key: 'p', header: 'Pages they read', align: 'right', cell: (r) => number(r.member_page_reads) },
                  { key: 'g', header: 'Pool share', align: 'right', cell: (r) => m(r.gross_cents), hideOnMobile: true },
                  { key: 'a', header: 'You earned', align: 'right', cell: (r) => <strong>{m(r.amount_cents)}</strong> },
                ]} />
              </Panel>
            </div>
          </div>
        );
      }}
    </Q>
  );
}

export function Analytics() {
  const { brand } = useBrand();
  const [params, setParams] = useSearchParams();
  const view = (VIEWS.some(([v]) => v === params.get('view')) ? params.get('view') : 'overview') as View;
  const [range, setRange] = useState('30d');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const custom = range === 'custom';
  const q: RangeQuery = custom && from && to && from <= to ? { from, to } : { range: custom ? '30d' : range };
  const setView = (v: View, release?: string) => {
    const next = new URLSearchParams(params);
    next.set('view', v);
    if (release) next.set('release', release);
    setParams(next, { replace: true });
  };
  return (
    <BrandPage title="Analytics">
      <div className="mb-4 flex flex-wrap items-end gap-3">
        <Segmented size="sm" value={range} onChange={setRange} options={[{ value: '7d', label: '7 days' }, { value: '30d', label: '30 days' }, { value: '90d', label: '90 days' }, { value: '365d', label: '12 months' }, { value: 'custom', label: 'Custom' }]} />
        {custom && (
          <div className="flex flex-wrap items-end gap-2">
            <Field label="From"><Input type="date" value={from} max={to || undefined} onChange={(e) => setFrom(e.target.value)} className="h-8" /></Field>
            <Field label="To"><Input type="date" value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)} className="h-8" /></Field>
            {!(from && to) && <span className="pb-1.5 text-xs text-muted">Choose both dates. Showing the last 30 days until then.</span>}
          </div>
        )}
      </div>
      <div className="mb-5"><Tabs value={view} onChange={(v) => setView(v)} tabs={VIEWS.map(([value, label]) => ({ value, label }))} /></div>
      {view === 'overview' && <Overview brandId={brand.id} q={q} />}
      {view === 'reads' && <Reads brandId={brand.id} q={q} />}
      {view === 'releases' && <Releases brandId={brand.id} q={q} openDropoff={(id) => setView('dropoff', id)} />}
      {view === 'dropoff' && <Dropoff brandId={brand.id} q={q} releaseId={params.get('release')} setRelease={(id) => setView('dropoff', id)} />}
      {view === 'countries' && <Countries brandId={brand.id} q={q} />}
      {view === 'followers' && <Followers brandId={brand.id} q={q} />}
      {view === 'engagement' && <Engagement brandId={brand.id} q={q} />}
      {view === 'emails' && <Emails brandId={brand.id} q={q} />}
      {view === 'revenue' && <Revenue brandId={brand.id} q={q} />}
    </BrandPage>
  );
}
