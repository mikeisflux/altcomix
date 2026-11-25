import { AlertTriangle, CheckCircle2, XCircle } from 'lucide-react';
import { useState } from 'react';
import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { ago, bytes, compact, date, money, number } from '@/lib/format';
import { useSession } from '@/lib/session';
import { BarChart, Card, DefList, Notice, PageHeader, Segmented, Stat, cx } from '@/ui';
import { Loaded, useAdminQuery } from './shared';
import type { R } from './shared';

type Dash = { days: number; totals: Record<string, number>; series: { days: string[] } & Record<string, number[]> };

const sum = (a: number[] | undefined) => (a ?? []).reduce((x, y) => x + y, 0);
const dayLabel = (d: string) => date(d + 'T12:00:00', { month: 'short', day: 'numeric' });

function Check({ ok, title, children }: { ok: boolean | null; title: string; children: ReactNode }) {
  return (
    <div className="flex gap-3 border-b border-line py-3.5 last:border-0">
      <span className="mt-0.5 shrink-0">
        {ok === null ? <AlertTriangle className="size-5 text-warn" aria-label="Needs attention" /> : ok ? <CheckCircle2 className="size-5 text-ok" aria-label="Working" /> : <XCircle className="size-5 text-danger" aria-label="Failing" />}
      </span>
      <div className="min-w-0 flex-1">
        <div className="font-medium">{title}</div>
        <div className="mt-0.5 break-words text-sm text-muted">{children}</div>
      </div>
    </div>
  );
}

function Health() {
  const health = useAdminQuery<R>('/api/admin/health', undefined, { refetchInterval: 120_000 });
  return (
    <Loaded query={health}>
      {(h) => (
        <div className="grid gap-5 xl:grid-cols-2">
          <Card className="px-5 py-2">
            <Check ok={h.db.ok} title="Database">
              {h.db.ok ? `PostgreSQL ${h.db.version}, answered in ${h.db.ms} ms, ${bytes(h.db.size_bytes)}, ${h.db.connections} connections` : h.db.error}
            </Check>
            <Check ok={h.storage.ok} title={`File storage (${h.storage.driver === 'r2' ? 'Cloudflare R2' : 'local disk'})`}>
              {h.storage.ok ? `Wrote, read back and deleted a test file in ${h.storage.ms} ms` : h.storage.error}
            </Check>
            {h.disk && (
              <Check ok={h.disk.error ? false : h.disk.volume_used_pct !== null && h.disk.volume_used_pct > 90 ? null : true} title="Disk">
                {h.disk.error ?? `${bytes(h.disk.used_bytes)} in ${number(h.disk.files)} stored files. Volume is ${h.disk.volume_used_pct}% full, ${bytes(h.disk.volume_free_bytes)} free.`}
              </Check>
            )}
            <Check ok={h.email.ok ? (h.email.queue_paused ? null : true) : false} title={`Email (${h.email.provider === 'log' ? 'not delivering: log only' : h.email.provider})`}>
              {h.email.provider === 'log' ? 'Messages are saved to the email log but not sent. ' : h.email.configured ? `Sending as ${h.email.from_email}. ` : 'The provider settings are incomplete. '}
              {h.email.queue_paused && 'The queue is paused. '}
              {h.email.webhook_verification === false && 'No webhook key is saved, so bounces and opens are not verified. '}
              {h.email.last_sent_at ? `Last sent ${ago(h.email.last_sent_at)}.` : 'Nothing has been sent yet.'}{' '}
              <Link className="link" to="/admin/settings?tab=email">Email settings</Link>
            </Check>
            <Check ok={h.payments.ok} title={`Payments (${h.payments.provider === 'sandbox' ? 'sandbox: no real money' : 'Divinity payments'})`}>
              {h.payments.provider === 'sandbox' ? 'Orders complete instantly without charging anyone. ' : h.payments.configured ? 'Credentials are saved. ' : 'Credentials are missing. '}
              {h.payments.provider !== 'sandbox' && (h.payments.webhook_secret_set ? 'Webhook secret is saved. ' : 'No webhook secret saved. ')}
              <Link className="link" to="/admin/settings?tab=payments">Payment settings</Link>
            </Check>
          </Card>
          <Card className="px-5 py-2">
            <Check ok={h.jobs.in_process || h.jobs.cron_secret_set ? true : null} title="Background jobs">
              {h.jobs.in_process ? 'Running inside this server process. ' : 'Not running in this server process. '}
              {h.jobs.cron_secret_set ? 'The cron endpoints are enabled.' : 'The cron endpoints are disabled (no CRON_SECRET).'}
              {h.jobs.last_runs.length > 0 && (
                <ul className="mt-2 space-y-1">
                  {h.jobs.last_runs.map((j: R) => (
                    <li key={j.job} className="flex flex-wrap items-baseline gap-x-2">
                      <span className={cx('size-2 shrink-0 self-center rounded-full', j.ok ? 'bg-ok' : 'bg-danger')} aria-label={j.ok ? 'Succeeded' : 'Failed'} />
                      <span className="text-paper">{j.job}</span>
                      <span>{ago(j.started_at)}</span>
                      {!j.ok && <span className="text-danger">{j.detail}</span>}
                    </li>
                  ))}
                </ul>
              )}{' '}
              <Link className="link" to="/admin/cron">All runs</Link>
            </Check>
            <div className="py-3.5">
              <div className="mb-2 font-medium">Server</div>
              <DefList
                items={[
                  ['Environment', h.server.env],
                  ['Node', h.server.node],
                  ['Up for', h.server.uptime_s > 86_400 ? `${Math.floor(h.server.uptime_s / 86_400)} days` : h.server.uptime_s > 3600 ? `${Math.floor(h.server.uptime_s / 3600)} hours` : `${Math.max(1, Math.round(h.server.uptime_s / 60))} minutes`],
                  ['Memory', bytes(h.server.rss_bytes)],
                ]}
              />
            </div>
          </Card>
        </div>
      )}
    </Loaded>
  );
}

function Warnings({ totals }: { totals?: Record<string, number> }) {
  const health = useAdminQuery<R>('/api/admin/health', undefined, { refetchInterval: 120_000 });
  const list: { text: string; to?: string; cta?: string; tone: 'warn' | 'danger' }[] = (health.data?.warnings ?? []).map((w: string) => ({
    text: w,
    tone: /production|not being delivered|will fail|nothing is being delivered/i.test(w) ? 'danger' : 'warn',
    ...( /email/i.test(w) && /queue/i.test(w) ? { to: '/admin/email', cta: 'Open the queue' }
      : /email/i.test(w) ? { to: '/admin/settings?tab=email', cta: 'Email settings' }
      : /payment/i.test(w) ? { to: '/admin/settings?tab=payments', cta: 'Payment settings' }
      : /R2|storage/i.test(w) ? { to: '/admin/settings?tab=storage', cta: 'Storage settings' }
      : /two-factor/i.test(w) ? { to: '/admin/settings?tab=security', cta: 'Security settings' }
      : {}),
  }));
  if (totals?.unresolved_errors) list.push({ text: `${number(totals.unresolved_errors)} unresolved ${totals.unresolved_errors === 1 ? 'error' : 'errors'} in the error log.`, to: '/admin/errors', cta: 'Review errors', tone: 'warn' });
  if (totals?.emails_failed) list.push({ text: `${number(totals.emails_failed)} ${totals.emails_failed === 1 ? 'email' : 'emails'} failed to send.`, to: '/admin/email?status=failed', cta: 'See failed emails', tone: 'warn' });
  if (!list.length) return null;
  return (
    <div className="mb-6 space-y-2">
      {list.map((w, i) => (
        <Notice key={i} tone={w.tone} action={w.to ? <Link className="shrink-0 underline" to={w.to}>{w.cta}</Link> : undefined}>{w.text}</Notice>
      ))}
    </div>
  );
}

export function Dashboard() {
  const { currency } = useSession();
  const [days, setDays] = useState('30');
  const dash = useAdminQuery<Dash>('/api/admin/dashboard', { days });
  const $ = (c: number) => money(c, currency);
  const chart = (s: Dash['series'], key: string) => s.days.map((d, i) => ({ label: dayLabel(d), value: s[key]?.[i] ?? 0 }));
  const span = days === '365' ? 'the last year' : `the last ${days} days`;

  return (
    <>
      <PageHeader
        title="Dashboard"
        description="How the platform is doing, and anything that needs your attention."
        actions={
          <Segmented
            size="sm"
            value={days}
            onChange={setDays}
            options={[{ value: '7', label: '7 days' }, { value: '30', label: '30 days' }, { value: '90', label: '90 days' }, { value: '365', label: '1 year' }]}
          />
        }
      />
      <Warnings totals={dash.data?.totals} />
      <Loaded query={dash}>
        {({ totals: t, series: s }) => (
          <div className={cx('space-y-6 transition-opacity', dash.isFetching && 'opacity-70')}>
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
              <Stat label="Money in" value={$(sum(s.gross_cents))} hint={`${$(t.gross_cents)} all time`} />
              <Stat label="Platform revenue" value={$(sum(s.platform_cents))} hint={`After fees, creator earnings and refunds. ${$(t.platform_cents)} all time`} />
              <Stat label="Creator Premium" value={$(sum(s.premium_cents))} hint={<Link className="link" to="/admin/premium">{$(t.premium_cents)} all time, before tax. {number(t.premium_brands)} {t.premium_brands === 1 ? 'brand has' : 'brands have'} it</Link>} />
              <Stat label="Creator earnings" value={$(sum(s.creator_cents))} hint={`${$(t.creator_cents)} all time`} />
              <Stat label="Refunded" value={$(sum(s.refunded_cents))} hint={`${$(t.refunded_cents)} all time`} />
              <Stat label="Orders" value={number(sum(s.orders))} hint={`${number(t.orders)} all time`} />
              <Stat label="Active members" value={number(t.active_members)} hint={`${$(t.mrr_cents)} a month recurring, ${number(sum(s.new_members))} joined in ${span}`} />
              <Stat label="New readers" value={number(sum(s.users))} hint={`${number(t.users)} accounts in total`} />
              <Stat label="Pages read" value={compact(sum(s.pages_read))} hint={`${compact(t.pages_read)} all time`} />
              <Stat label="Brands" value={number(t.brands)} hint={`${number(sum(s.brands))} new`} />
              <Stat label="Series" value={number(t.series)} hint={`${number(sum(s.series))} new, ${number(sum(s.releases))} releases published`} />
              <Stat label="Payouts waiting" value={number(t.pending_payouts)} hint={<Link className="link" to="/admin/payouts">{$(t.pending_payouts_cents)} requested, {$(t.approved_payouts_cents)} approved and unpaid</Link>} />
              <Stat label="Open reports" value={number(t.open_reports)} hint={<Link className="link" to="/admin/reports">Review the queue</Link>} />
            </div>

            <div className="grid gap-5 xl:grid-cols-2">
              <Card className="p-5">
                <h2 className="mb-1 text-lg font-semibold">Money in per day</h2>
                <p className="mb-4 text-sm text-muted">Store orders, membership payments and Creator Premium payments, before fees and sales tax.</p>
                <BarChart data={chart(s, 'gross_cents')} format={$} />
              </Card>
              <Card className="p-5">
                <h2 className="mb-1 text-lg font-semibold">Platform revenue per day</h2>
                <p className="mb-4 text-sm text-muted">What is left after processing fees, creator earnings and refunds.</p>
                <BarChart data={chart(s, 'platform_cents').map((d) => ({ ...d, value: Math.max(0, d.value) }))} format={$} />
              </Card>
              <Card className="p-5">
                <h2 className="mb-4 text-lg font-semibold">New accounts per day</h2>
                <BarChart data={chart(s, 'users')} format={number} />
              </Card>
              <Card className="p-5">
                <h2 className="mb-4 text-lg font-semibold">Pages read per day</h2>
                <BarChart data={chart(s, 'pages_read')} format={number} />
              </Card>
              <Card className="p-5">
                <h2 className="mb-4 text-lg font-semibold">Orders per day</h2>
                <BarChart data={chart(s, 'orders')} format={number} />
              </Card>
              <Card className="p-5">
                <h2 className="mb-4 text-lg font-semibold">New memberships per day</h2>
                <BarChart data={chart(s, 'new_members')} format={number} />
              </Card>
            </div>
          </div>
        )}
      </Loaded>

      <h2 className="mb-3 mt-10 text-xl font-bold">System health</h2>
      <Health />
    </>
  );
}
