import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { one, q } from '../db.ts';
import type { Row } from '../db.ts';
import { badRequest, notFound, parse, requireMember } from '../lib/http.ts';
import { idParam, isUuid, sendCsv } from '../lib/ingest.ts';
import { requirePremium } from '../lib/premium.ts';
import { getSetting } from '../lib/settings.ts';

/**
 * Studio: analytics for a brand. Readable by every member (analyst and up).
 *
 * Free for every brand: the dashboard, page reads and revenue (JSON).
 * Creator Premium (lib/premium.ts) only: drop-off, countries, followers,
 * engagement, emails, and every CSV download. Without Premium those answer
 * 402 with code `premium_required`.
 *
 * Every report takes the same range: `?range=7d|30d|90d|365d` (default 30d) or
 * `?from=YYYY-MM-DD&to=YYYY-MM-DD` (both inclusive, UTC days), and
 * `&format=csv` to download it.
 */

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a date like 2027-03-14').refine((v) => !Number.isNaN(Date.parse(v)), 'That date does not exist');
const rangeQuery = z.object({
  range: z.enum(['7d', '30d', '90d', '365d']).optional(),
  from: day.optional(),
  to: day.optional(),
  format: z.enum(['json', 'csv']).optional(),
  series_id: z.string().refine(isUuid, 'Unknown series').optional(),
});

type Range = { from: string; to: string; start: Date; end: Date; prevStart: Date; days: number; csv: boolean; seriesId: string | null };
const DAY = 86_400_000;
const iso = (d: Date) => d.toISOString().slice(0, 10);

function readRange(req: FastifyRequest): Range {
  const query = parse(rangeQuery, req.query);
  let start: Date;
  let end: Date; // exclusive
  if (query.from || query.to) {
    if (!query.from || !query.to) throw badRequest('Give both a start and an end date');
    start = new Date(`${query.from}T00:00:00Z`);
    end = new Date(Date.parse(`${query.to}T00:00:00Z`) + DAY);
    if (end <= start) throw badRequest('The end date is before the start date');
    if (end.getTime() - start.getTime() > 1100 * DAY) throw badRequest('Choose a range of at most 3 years');
  } else {
    const days = Number((query.range ?? '30d').slice(0, -1));
    end = new Date(Math.floor(Date.now() / DAY) * DAY + DAY);
    start = new Date(end.getTime() - days * DAY);
  }
  const days = Math.round((end.getTime() - start.getTime()) / DAY);
  return {
    from: iso(start), to: iso(new Date(end.getTime() - DAY)), start, end, prevStart: new Date(start.getTime() - days * DAY), days,
    csv: query.format === 'csv', seriesId: query.series_id ?? null,
  };
}

/**
 * `premium` says whether the report itself is a Creator Premium view. Every
 * CSV download is Premium, including the CSV of a free view. The check comes
 * after the role check, so only the brand's own team learns its plan.
 */
async function brandAndRange(req: FastifyRequest, premium: false | string = false) {
  const id = idParam(req);
  await requireMember(req, id, 'analyst');
  const range = readRange(req);
  if (premium) await requirePremium(id, premium);
  else if (range.csv) await requirePremium(id, 'Downloading analytics as CSV');
  if (range.seriesId && !(await one('select 1 from series where id = $1 and publisher_id = $2', [range.seriesId, id]))) {
    throw badRequest('That series does not belong to this brand');
  }
  return { id, range };
}

const meta = (r: Range) => ({ from: r.from, to: r.to, days: r.days, previous: { from: iso(r.prevStart), to: iso(new Date(r.start.getTime() - DAY)) } });

async function totals(brandId: string, start: Date, end: Date): Promise<Record<string, number>> {
  const a = [brandId, start, end];
  const [reads, money, engagement, mail] = await Promise.all([
    one(
      `select
         (select count(*) from (
            select user_id::text from page_reads where publisher_id = $1 and read_at >= $2 and read_at < $3
            union
            select visitor_hash from anon_reads where publisher_id = $1 and day >= $2::date and day < $3::date) r)::int as unique_readers,
         ((select count(distinct (user_id, release_id, read_at::date)) from page_reads where publisher_id = $1 and read_at >= $2 and read_at < $3)
          + (select count(*) from anon_reads where publisher_id = $1 and day >= $2::date and day < $3::date))::int as visits,
         ((select count(*) from page_reads where publisher_id = $1 and read_at >= $2 and read_at < $3)
          + (select coalesce(sum(pages), 0) from anon_reads where publisher_id = $1 and day >= $2::date and day < $3::date))::int as page_reads`,
      a,
    ),
    one(
      `select coalesce(sum(amount_cents) filter (where kind = 'tip'), 0)::int as revenue_tips_cents,
              coalesce(sum(amount_cents) filter (where kind = 'subscription'), 0)::int as revenue_membership_cents,
              coalesce(sum(amount_cents) filter (where kind = 'sale'), 0)::int as revenue_sales_cents,
              coalesce(sum(amount_cents) filter (where kind in ('refund','adjustment')), 0)::int as revenue_adjustments_cents,
              coalesce(sum(amount_cents) filter (where kind <> 'payout'), 0)::int as revenue_total_cents
         from ledger where publisher_id = $1 and created_at >= $2 and created_at < $3`,
      a,
    ),
    one(
      `select
         ((select count(*) from follows f join series s on s.id = f.series_id where s.publisher_id = $1 and f.created_at >= $2 and f.created_at < $3)
          + (select count(*) from publisher_follows pf where pf.publisher_id = $1 and pf.created_at >= $2 and pf.created_at < $3))::int as followers,
         (select count(*) from favorites f join series s on s.id = f.series_id where s.publisher_id = $1 and f.created_at >= $2 and f.created_at < $3)::int as favorites,
         (select count(*) from forum_posts fp join forum_threads t on t.id = fp.thread_id join series s on s.id = t.series_id
           where s.publisher_id = $1 and fp.deleted_at is null and fp.created_at >= $2 and fp.created_at < $3)::int as forum_posts,
         (select count(*) from comments c join series s on s.id = c.series_id
           where s.publisher_id = $1 and c.deleted_at is null and c.created_at >= $2 and c.created_at < $3)::int as comments`,
      a,
    ),
    one(
      `select count(*) filter (where sent_at >= $2 and sent_at < $3)::int as emails_sent,
              count(*) filter (where opened_at >= $2 and opened_at < $3)::int as emails_opened,
              count(*) filter (where clicked_at >= $2 and clicked_at < $3)::int as emails_clicked
         from emails where publisher_id = $1 and created_at >= $2::timestamptz - interval '60 days'`,
      a,
    ),
  ]);
  return { ...reads, ...money, ...engagement, ...mail } as Record<string, number>;
}

function reply(rep: FastifyReply, range: Range, name: string, rows: Row[], columns: string[], extra: Row = {}) {
  if (range.csv) return sendCsv(rep, `${name}-${range.from}-to-${range.to}.csv`, rows, columns);
  return { range: meta(range), columns, rows, ...extra };
}

export default async function (app: FastifyInstance) {
  /** The dashboard: every headline number with the same-length period before it. */
  app.get('/api/studio/brands/:id/analytics/dashboard', async (req, rep) => {
    const { id, range } = await brandAndRange(req);
    const [now, before, standing] = await Promise.all([
      totals(id, range.start, range.end),
      totals(id, range.prevStart, range.start),
      one(
        `select ((select count(*) from follows f join series s on s.id = f.series_id where s.publisher_id = $1)
                 + (select count(*) from publisher_follows where publisher_id = $1))::int as followers_total,
                (select count(*) from favorites f join series s on s.id = f.series_id where s.publisher_id = $1)::int as favorites_total`,
        [id],
      ),
    ]);
    const metric = (key: string) => {
      const value = now[key] ?? 0;
      const previous = before[key] ?? 0;
      return { value, previous, change: value - previous, change_pct: previous ? Math.round(((value - previous) / Math.abs(previous)) * 1000) / 10 : null };
    };
    const keys = Object.keys(now);
    if (range.csv) {
      return sendCsv(rep, `dashboard-${range.from}-to-${range.to}.csv`, keys.map((k) => ({ metric: k, ...metric(k) })), ['metric', 'value', 'previous', 'change', 'change_pct']);
    }
    const site = await getSetting('site');
    return {
      range: meta(range),
      currency: site.currency,
      readers: { unique_readers: metric('unique_readers'), visits: metric('visits'), page_reads: metric('page_reads') },
      revenue: {
        tips: metric('revenue_tips_cents'),
        membership: metric('revenue_membership_cents'),
        // Read-online sales and downloads.
        sales: metric('revenue_sales_cents'),
        adjustments: metric('revenue_adjustments_cents'),
        total: metric('revenue_total_cents'),
      },
      engagement: {
        // New in the range; *_total is where the brand stands today.
        followers: metric('followers'), favorites: metric('favorites'), forum_posts: metric('forum_posts'), comments: metric('comments'),
        followers_total: standing!.followers_total, favorites_total: standing!.favorites_total,
      },
      emails: { sent: metric('emails_sent'), opened: metric('emails_opened'), clicked: metric('emails_clicked') },
    };
  });

  /** Page reads by day, by series or by release (`?group=day|series|release`). */
  app.get('/api/studio/brands/:id/analytics/page-reads', async (req, rep) => {
    const { id, range } = await brandAndRange(req);
    const group = parse(z.enum(['day', 'series', 'release']).optional(), (req.query as { group?: string }).group) ?? 'day';
    const a = [id, range.start, range.end, range.seriesId];
    if (group === 'day') {
      const rows = await q(
        `with d as (select generate_series($2::date, $3::date - 1, interval '1 day')::date as day),
              m as (select read_at::date as day, count(*)::int as n, count(distinct user_id)::int as readers
                      from page_reads where publisher_id = $1 and read_at >= $2 and read_at < $3 and ($4::uuid is null or series_id = $4) group by 1),
              an as (select day, coalesce(sum(pages), 0)::int as n, count(distinct visitor_hash)::int as readers
                      from anon_reads where publisher_id = $1 and day >= $2::date and day < $3::date and ($4::uuid is null or series_id = $4) group by 1)
         select d.day, coalesce(m.n, 0) + coalesce(an.n, 0) as page_reads, coalesce(m.n, 0) as member_page_reads, coalesce(an.n, 0) as guest_page_reads,
                coalesce(m.readers, 0) + coalesce(an.readers, 0) as readers
           from d left join m on m.day = d.day left join an on an.day = d.day order by d.day`,
        a,
      );
      return reply(rep, range, 'page-reads-by-day', rows, ['day', 'page_reads', 'member_page_reads', 'guest_page_reads', 'readers']);
    }
    if (group === 'series') {
      const rows = await q(
        `select s.id as series_id, s.title, s.slug,
                (coalesce(m.n, 0) + coalesce(an.n, 0))::int as page_reads, (coalesce(m.readers, 0) + coalesce(an.readers, 0))::int as readers
           from series s
           left join (select series_id, count(*) as n, count(distinct user_id) as readers from page_reads
                       where publisher_id = $1 and read_at >= $2 and read_at < $3 group by 1) m on m.series_id = s.id
           left join (select series_id, sum(pages) as n, count(distinct visitor_hash) as readers from anon_reads
                       where publisher_id = $1 and day >= $2::date and day < $3::date group by 1) an on an.series_id = s.id
          where s.publisher_id = $1 and s.deleted_at is null and ($4::uuid is null or s.id = $4)
          order by 4 desc, s.title`,
        a,
      );
      return reply(rep, range, 'page-reads-by-series', rows, ['series_id', 'title', 'page_reads', 'readers']);
    }
    const rows = await q(
      `select r.id as release_id, s.title as series_title, r.title, r.kind, r.number, r.language, r.status, r.page_count,
              (coalesce(m.n, 0) + coalesce(an.n, 0))::int as page_reads, (coalesce(m.readers, 0) + coalesce(an.readers, 0))::int as readers,
              (coalesce(m.visits, 0) + coalesce(an.visits, 0))::int as visits
         from releases r join series s on s.id = r.series_id
         left join (select release_id, count(*) as n, count(distinct user_id) as readers, count(distinct (user_id, read_at::date)) as visits
                      from page_reads where publisher_id = $1 and read_at >= $2 and read_at < $3 group by 1) m on m.release_id = r.id
         left join (select release_id, sum(pages) as n, count(distinct visitor_hash) as readers, count(*) as visits
                      from anon_reads where publisher_id = $1 and day >= $2::date and day < $3::date group by 1) an on an.release_id = r.id
        where s.publisher_id = $1 and s.deleted_at is null and r.deleted_at is null and ($4::uuid is null or s.id = $4)
        order by 9 desc, s.title, r.number`,
      a,
    );
    return reply(rep, range, 'page-reads-by-release', rows, ['release_id', 'series_title', 'title', 'kind', 'number', 'language', 'status', 'page_count', 'page_reads', 'readers', 'visits']);
  });

  /**
   * Drop-off inside one release: how many readers got at least as far as each
   * page. Guests are counted by how many pages they read from the start.
   */
  app.get('/api/studio/brands/:id/analytics/releases/:releaseId/dropoff', async (req, rep) => {
    const { id, range } = await brandAndRange(req, 'Where readers stop');
    const releaseId = idParam(req, 'releaseId');
    const release = await one(
      `select r.id, r.title, r.number, r.kind, r.page_count, s.title as series_title
         from releases r join series s on s.id = r.series_id where r.id = $1 and s.publisher_id = $2 and r.deleted_at is null`,
      [releaseId, id],
    );
    if (!release) throw notFound('Release not found');
    const rows = await q(
      `with pg as (select id, position from pages where release_id = $1),
            far as (select pr.user_id, max(pg.position) as reached
                      from page_reads pr join pg on pg.id = pr.page_id
                     where pr.release_id = $1 and pr.read_at >= $2 and pr.read_at < $3 group by 1),
            guest as (select visitor_hash, max(pages) as reached from anon_reads
                       where release_id = $1 and day >= $2::date and day < $3::date group by 1),
            exact as (select pr.page_id, count(distinct pr.user_id)::int as n from page_reads pr
                       where pr.release_id = $1 and pr.read_at >= $2 and pr.read_at < $3 group by 1)
       select pg.position, pg.id as page_id,
              ((select count(*) from far where reached >= pg.position) + (select count(*) from guest where reached >= pg.position))::int as readers,
              (select count(*) from far where reached >= pg.position)::int as member_readers,
              coalesce(exact.n, 0) as member_reads_of_page
         from pg left join exact on exact.page_id = pg.id order by pg.position`,
      [releaseId, range.start, range.end],
    );
    const first = rows[0]?.readers ?? 0;
    let prev = first;
    for (const r of rows) {
      r.pct_of_start = first ? Math.round((r.readers / first) * 1000) / 10 : 0;
      r.left_here = Math.max(0, prev - r.readers);
      prev = r.readers;
    }
    return reply(rep, range, `dropoff-${release.title}`, rows, ['position', 'readers', 'member_readers', 'member_reads_of_page', 'pct_of_start', 'left_here', 'page_id'], {
      release,
      started: first,
      finished: rows.length ? rows[rows.length - 1].readers : 0,
    });
  });

  /** Where signed-in readers are (guests are not located). */
  app.get('/api/studio/brands/:id/analytics/countries', async (req, rep) => {
    const { id, range } = await brandAndRange(req, 'Reader countries');
    const rows = await q(
      `select coalesce(nullif(country, ''), 'unknown') as country, count(distinct user_id)::int as readers, count(*)::int as page_reads
         from page_reads where publisher_id = $1 and read_at >= $2 and read_at < $3 and ($4::uuid is null or series_id = $4)
        group by 1 order by 2 desc, 3 desc`,
      [id, range.start, range.end, range.seriesId],
    );
    const all = rows.reduce((n, r) => n + r.readers, 0);
    for (const r of rows) r.share_pct = all ? Math.round((r.readers / all) * 1000) / 10 : 0;
    return reply(rep, range, 'reader-countries', rows, ['country', 'readers', 'page_reads', 'share_pct']);
  });

  /** New followers per day (series follows + brand follows) and the running total. */
  app.get('/api/studio/brands/:id/analytics/followers', async (req, rep) => {
    const { id, range } = await brandAndRange(req, 'The followers report');
    const rows = await q(
      `with ev as (
         select f.created_at, 'series' as kind from follows f join series s on s.id = f.series_id
          where s.publisher_id = $1 and ($4::uuid is null or s.id = $4)
         union all
         select pf.created_at, 'brand' from publisher_follows pf where pf.publisher_id = $1 and $4::uuid is null),
       d as (select generate_series($2::date, $3::date - 1, interval '1 day')::date as day),
       per as (select created_at::date as day, count(*) filter (where kind = 'series')::int as series_followers,
                      count(*) filter (where kind = 'brand')::int as brand_followers
                 from ev where created_at >= $2 and created_at < $3 group by 1)
       select d.day, coalesce(per.series_followers, 0) as series_followers, coalesce(per.brand_followers, 0) as brand_followers,
              coalesce(per.series_followers, 0) + coalesce(per.brand_followers, 0) as new_followers,
              ((select count(*) from ev where created_at < $2)
               + sum(coalesce(per.series_followers, 0) + coalesce(per.brand_followers, 0)) over (order by d.day))::int as total
         from d left join per on per.day = d.day order by d.day`,
      [id, range.start, range.end, range.seriesId],
    );
    return reply(rep, range, 'followers', rows, ['day', 'new_followers', 'series_followers', 'brand_followers', 'total']);
  });

  /** Favorites, comments and forum posts per day. */
  app.get('/api/studio/brands/:id/analytics/engagement', async (req, rep) => {
    const { id, range } = await brandAndRange(req, 'The engagement report');
    const rows = await q(
      `with d as (select generate_series($2::date, $3::date - 1, interval '1 day')::date as day),
            fav as (select f.created_at::date as day, count(*)::int as n from favorites f join series s on s.id = f.series_id
                     where s.publisher_id = $1 and f.created_at >= $2 and f.created_at < $3 and ($4::uuid is null or s.id = $4) group by 1),
            com as (select c.created_at::date as day, count(*)::int as n from comments c join series s on s.id = c.series_id
                     where s.publisher_id = $1 and c.deleted_at is null and c.created_at >= $2 and c.created_at < $3 and ($4::uuid is null or s.id = $4) group by 1),
            fp as (select p.created_at::date as day, count(*)::int as n from forum_posts p join forum_threads t on t.id = p.thread_id
                     join series s on s.id = t.series_id
                    where s.publisher_id = $1 and p.deleted_at is null and p.created_at >= $2 and p.created_at < $3 and ($4::uuid is null or s.id = $4) group by 1)
       select d.day, coalesce(fav.n, 0) as favorites, coalesce(com.n, 0) as comments, coalesce(fp.n, 0) as forum_posts
         from d left join fav on fav.day = d.day left join com on com.day = d.day left join fp on fp.day = d.day order by d.day`,
      [id, range.start, range.end, range.seriesId],
    );
    return reply(rep, range, 'engagement', rows, ['day', 'favorites', 'comments', 'forum_posts']);
  });

  /** Emails sent on the brand's behalf, per day and per kind of email. */
  app.get('/api/studio/brands/:id/analytics/emails', async (req, rep) => {
    const { id, range } = await brandAndRange(req, 'Email statistics');
    const rows = await q(
      `with d as (select generate_series($2::date, $3::date - 1, interval '1 day')::date as day),
            e as (select sent_at::date as day, count(*)::int as sent, count(opened_at)::int as opened, count(clicked_at)::int as clicked
                    from emails where publisher_id = $1 and sent_at >= $2 and sent_at < $3 group by 1)
       select d.day, coalesce(e.sent, 0) as sent, coalesce(e.opened, 0) as opened, coalesce(e.clicked, 0) as clicked
         from d left join e on e.day = d.day order by d.day`,
      [id, range.start, range.end],
    );
    const byTemplate = await q(
      `select coalesce(template, 'other') as template, count(*)::int as sent, count(opened_at)::int as opened, count(clicked_at)::int as clicked
         from emails where publisher_id = $1 and sent_at >= $2 and sent_at < $3 group by 1 order by 2 desc`,
      [id, range.start, range.end],
    );
    return reply(rep, range, 'emails', rows, ['day', 'sent', 'opened', 'clicked'], { by_template: byTemplate });
  });

  /** Earnings by month and kind, plus how each month's membership figure was made up. */
  app.get('/api/studio/brands/:id/analytics/revenue', async (req, rep) => {
    const { id, range } = await brandAndRange(req);
    const a = [id, range.start, range.end, range.seriesId];
    const rows = await q(
      `select to_char(date_trunc('month', created_at), 'YYYY-MM') as month,
              coalesce(sum(amount_cents) filter (where kind = 'tip'), 0)::int as tips_cents,
              coalesce(sum(amount_cents) filter (where kind = 'subscription'), 0)::int as membership_cents,
              coalesce(sum(amount_cents) filter (where kind = 'sale'), 0)::int as sales_cents,
              coalesce(sum(amount_cents) filter (where kind = 'refund'), 0)::int as refunds_cents,
              coalesce(sum(amount_cents) filter (where kind = 'adjustment'), 0)::int as adjustments_cents,
              coalesce(sum(amount_cents), 0)::int as total_cents,
              coalesce(sum(gross_cents), 0)::int as gross_cents
         from ledger
        where publisher_id = $1 and kind <> 'payout' and created_at >= $2 and created_at < $3 and ($4::uuid is null or series_id = $4)
        group by 1 order by 1`,
      a,
    );
    if (range.csv) return reply(rep, range, 'revenue-by-month', rows, ['month', 'tips_cents', 'membership_cents', 'sales_cents', 'refunds_cents', 'adjustments_cents', 'total_cents', 'gross_cents']);
    // Membership money is settled per reading month: each row is this brand's
    // share of what its subscribers paid that month, for one series.
    const membership = await q(
      `select to_char(l.month, 'YYYY-MM') as reading_month, l.series_id, s.title as series_title, l.gross_cents, l.amount_cents, l.note,
              (select count(*)::int from page_reads pr where pr.series_id = l.series_id and pr.month = l.month and pr.via = 'subscription') as member_page_reads,
              (select count(distinct pr.user_id)::int from page_reads pr where pr.series_id = l.series_id and pr.month = l.month and pr.via = 'subscription') as member_readers
         from ledger l left join series s on s.id = l.series_id
        where l.publisher_id = $1 and l.kind = 'subscription' and l.created_at >= $2 and l.created_at < $3 and ($4::uuid is null or l.series_id = $4)
        order by l.month desc, s.title`,
      a,
    );
    const bySeries = await q(
      `select l.series_id, s.title as series_title, coalesce(sum(l.amount_cents), 0)::int as total_cents
         from ledger l left join series s on s.id = l.series_id
        where l.publisher_id = $1 and l.kind <> 'payout' and l.created_at >= $2 and l.created_at < $3 and ($4::uuid is null or l.series_id = $4)
        group by 1, 2 order by 3 desc`,
      a,
    );
    const site = await getSetting('site');
    return reply(rep, range, 'revenue-by-month', rows, ['month', 'tips_cents', 'membership_cents', 'sales_cents', 'refunds_cents', 'adjustments_cents', 'total_cents', 'gross_cents'], {
      currency: site.currency, membership_breakdown: membership, by_series: bySeries,
    });
  });
}
