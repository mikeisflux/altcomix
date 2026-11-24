import { one, q, tx } from '../db.ts';
import type { Queryable } from '../db.ts';
import { HttpError, badRequest } from '../lib/http.ts';
import { allocate, creditSubscription } from '../lib/ledger.ts';
import type { Job } from '../server.ts';

/**
 * Monthly split of membership money ("who did each member actually read").
 *
 * For a finished calendar month (UTC), for every `sub_months` row:
 *
 *   net = gross - fee
 *   a member who read membership pages that month: their net is shared among
 *     the series they read, in proportion to the number of distinct pages
 *     read with via = 'subscription'
 *   a member who read nothing: their net goes into a common pool, shared
 *     among all series in proportion to every member's subscription reads
 *     that month
 *
 * The per-series totals are then paid like any other earning: the creator
 * share is floor(series net x sub share bps) (publisher override, else the
 * platform default), revenue splits take their percentage as their own
 * ledger rows and the series owner keeps the rest. What is not the creators'
 * is the platform's, so gross = fees + creators + platform to the cent.
 *
 * Remainder rule: every proportional split uses the largest-remainder
 * method; leftover cents go to the largest fractional parts, ties to the
 * lower series id. Same inputs, same result.
 *
 * Running a month twice does nothing the second time: the `settlements` row
 * is the lock, ledger rows are unique per (publisher, month, series) and each
 * `sub_months` row is stamped `settled_at`.
 */

export type SettlementSeries = { series_id: string; publisher_id: string; pages: number; net_cents: number; creator_cents: number; platform_cents: number };
export type SettlementResult = {
  month: string;
  already_settled: boolean;
  subscribers: number;
  gross_cents: number;
  fee_cents: number;
  creator_cents: number;
  platform_cents: number;
  /** Net from members who read nothing, shared out by everyone's reads. */
  pool_cents: number;
  /** Pool money with nobody to pay because no membership page was read all month; stays with the platform. */
  undistributed_cents: number;
  series: SettlementSeries[];
};

function normMonth(input: string): string {
  const m = /^(\d{4})-(\d{2})(?:-\d{2})?$/.exec(String(input));
  if (!m || Number(m[2]) < 1 || Number(m[2]) > 12) throw badRequest('Month must look like 2026-10');
  return `${m[1]}-${m[2]}-01`;
}

function currentMonth(): string {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)).toISOString().slice(0, 10);
}

type Plan = Omit<SettlementResult, 'already_settled' | 'creator_cents' | 'platform_cents' | 'series'> & { nets: { series_id: string; publisher_id: string; pages: number; net_cents: number }[]; ids: string[] };

/** Pure arithmetic over the month's rows; no writes. */
async function plan(month: string, db: Queryable): Promise<Plan> {
  const subs = await q<{ id: string; user_id: string; gross_cents: number; fee_cents: number }>(
    'select id, user_id, gross_cents, fee_cents from sub_months where month = $1 and settled_at is null order by user_id',
    [month],
    db,
  );
  const reads = await q<{ user_id: string; series_id: string; publisher_id: string; pages: number }>(
    `select user_id, series_id, (array_agg(publisher_id order by read_at desc))[1] as publisher_id, count(*)::int as pages
       from page_reads where month = $1 and via = 'subscription' group by user_id, series_id`,
    [month],
    db,
  );
  const publisherOf = new Map<string, string>();
  const totalPages = new Map<string, number>();
  const byUser = new Map<string, { series_id: string; pages: number }[]>();
  for (const r of reads) {
    publisherOf.set(r.series_id, r.publisher_id);
    totalPages.set(r.series_id, (totalPages.get(r.series_id) ?? 0) + r.pages);
    const list = byUser.get(r.user_id) ?? [];
    list.push({ series_id: r.series_id, pages: r.pages });
    byUser.set(r.user_id, list);
  }
  const net = new Map<string, number>();
  const add = (seriesId: string, cents: number) => net.set(seriesId, (net.get(seriesId) ?? 0) + cents);
  let gross = 0;
  let fee = 0;
  let pool = 0;
  for (const s of subs) {
    const f = Math.min(s.gross_cents, Math.max(0, s.fee_cents));
    gross += s.gross_cents;
    fee += f;
    const mine = (byUser.get(s.user_id) ?? []).sort((a, b) => (a.series_id < b.series_id ? -1 : 1));
    if (!mine.length) {
      pool += s.gross_cents - f;
      continue;
    }
    allocate(s.gross_cents - f, mine.map((m) => m.pages), mine.map((m) => m.series_id)).forEach((c, i) => add(mine[i].series_id, c));
  }
  const all = [...totalPages].sort((a, b) => (a[0] < b[0] ? -1 : 1));
  let undistributed = 0;
  if (all.length) allocate(pool, all.map((a) => a[1]), all.map((a) => a[0])).forEach((c, i) => add(all[i][0], c));
  else undistributed = pool;
  return {
    month,
    subscribers: subs.length,
    gross_cents: gross,
    fee_cents: fee,
    pool_cents: pool,
    undistributed_cents: undistributed,
    nets: all.map(([series_id, pages]) => ({ series_id, publisher_id: publisherOf.get(series_id)!, pages, net_cents: net.get(series_id) ?? 0 })),
    ids: subs.map((s) => s.id),
  };
}

async function stored(month: string, db?: Queryable): Promise<SettlementResult | null> {
  const s = await one('select * from settlements where month = $1', [month], db);
  if (!s) return null;
  return {
    month, already_settled: true, subscribers: s.subscribers, gross_cents: s.gross_cents, fee_cents: s.fee_cents, creator_cents: s.creator_cents,
    platform_cents: s.platform_cents, pool_cents: 0, undistributed_cents: 0, series: [],
  };
}

/** What settling `month` would pay, without writing anything. Uses the same code path inside a rolled-back transaction. */
export async function previewSettlement(monthInput: string): Promise<SettlementResult> {
  const month = normMonth(monthInput);
  const done = await stored(month);
  if (done) return done;
  let out: SettlementResult | null = null;
  await tx(async (db) => {
    out = await run(month, null, db);
    throw new Rollback();
  }).catch((e) => {
    if (!(e instanceof Rollback)) throw e;
  });
  return out!;
}
class Rollback extends Error {}

async function run(month: string, ranBy: string | null, db: Queryable): Promise<SettlementResult> {
  const p = await plan(month, db);
  const series: SettlementSeries[] = [];
  let creator = 0;
  for (const n of p.nets) {
    const b = await creditSubscription(db, { publisherId: n.publisher_id, seriesId: n.series_id, month, netCents: n.net_cents, note: `Membership reads, ${month.slice(0, 7)} (${n.pages} pages)` });
    creator += b.creator_cents;
    series.push({ ...n, creator_cents: b.creator_cents, platform_cents: b.platform_cents });
  }
  const platform = p.gross_cents - p.fee_cents - creator;
  await db.query(
    'insert into settlements (month, subscribers, gross_cents, fee_cents, creator_cents, platform_cents, ran_by) values ($1,$2,$3,$4,$5,$6,$7)',
    [month, p.subscribers, p.gross_cents, p.fee_cents, creator, platform, ranBy],
  );
  if (p.ids.length) await db.query('update sub_months set settled_at = now() where id = any($1)', [p.ids]);
  return {
    month, already_settled: false, subscribers: p.subscribers, gross_cents: p.gross_cents, fee_cents: p.fee_cents, creator_cents: creator,
    platform_cents: platform, pool_cents: p.pool_cents, undistributed_cents: p.undistributed_cents, series,
  };
}

/** Settle one finished month. Safe to call again: the second call reports `already_settled`. */
export async function settleMonth(monthInput: string, opts: { ranBy?: string | null } = {}): Promise<SettlementResult> {
  const month = normMonth(monthInput);
  if (month >= currentMonth()) throw new HttpError(400, 'A month can only be settled once it has ended');
  return tx(async (db) => {
    // One settlement at a time per month, across processes.
    await db.query(`select pg_advisory_xact_lock(727275, ('x' || substr(md5($1), 1, 8))::bit(32)::int)`, [month]);
    return (await stored(month, db)) ?? run(month, opts.ranBy ?? null, db);
  });
}

const job: Job = {
  name: 'settlement',
  everyMs: 3_600_000,
  async run() {
    const months = await q<{ month: string }>(
      `select distinct month from sub_months m where settled_at is null and month < $1
          and not exists (select 1 from settlements s where s.month = m.month) order by month`,
      [currentMonth()],
    );
    const out: string[] = [];
    for (const { month } of months) {
      const r = await settleMonth(month);
      out.push(`${month.slice(0, 7)}: ${r.subscribers} members, ${r.creator_cents} cents to creators`);
    }
    return out.length ? out.join('; ') : undefined;
  },
};

export default job;
