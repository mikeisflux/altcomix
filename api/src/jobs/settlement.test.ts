import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { fixtures, useTestDatabase } from '../lib/commerce.testkit.ts';

await useTestDatabase('settlement');
const { exec, one, q, pool } = await import('../db.ts');
const { settleMonth, previewSettlement } = await import('./settlement.ts');
const f = await fixtures();

type Ids = { id: string; page_ids: string[] };
let P1: string, P2: string, PAYEE: string;
let X: string, Y: string;
let rx: Ids, ry: Ids;
let A: string, B: string, C: string, D: string;

const MONTH = '2019-03-01';
const EMPTY = '2019-04-01';

async function read(userId: string, release: Ids, seriesId: string, publisherId: string, pages: number, via = 'subscription', month = MONTH) {
  for (const pageId of release.page_ids.slice(0, pages)) {
    await exec(
      `insert into page_reads (user_id, page_id, month, release_id, series_id, publisher_id, via) values ($1,$2,$3,$4,$5,$6,$7) on conflict do nothing`,
      [userId, pageId, month, release.id, seriesId, publisherId, via],
    );
  }
}
async function subMonth(userId: string, month: string, gross: number, fee: number) {
  const s = await one<{ id: string }>(
    `insert into subscriptions (user_id, plan, provider, price_cents, current_period_start, current_period_end) values ($1,'monthly','sandbox',$2, now(), now() + interval '1 month') returning id`,
    [userId, gross],
  );
  await exec('insert into sub_months (user_id, subscription_id, month, gross_cents, fee_cents) values ($1,$2,$3,$4,$5)', [userId, s!.id, month, gross, fee]);
}

before(async () => {
  await exec('truncate settlements, ledger, sub_months, page_reads');
  const o1 = await f.user();
  const o2 = await f.user();
  const o3 = await f.user();
  P1 = (await f.brand(o1.id)).id; // platform default membership share (80%)
  P2 = (await f.brand(o2.id, { sub_share_bps: 9000 })).id; // negotiated 90%
  PAYEE = (await f.brand(o3.id)).id;
  const sx = await f.series(P1);
  const sy = await f.series(P2);
  // deterministic tie-breaking is by series id; make sure X < Y for the hand-worked numbers below
  [X, Y] = [sx.id, sy.id];
  assert.ok(X < Y);
  rx = await f.release(X, {}, 8);
  ry = await f.release(Y, {}, 5);
  await exec('insert into revenue_splits (series_id, payee_publisher_id, share_bps) values ($1,$2,2500)', [X, PAYEE]);
  [A, B, C, D] = (await Promise.all([f.user(), f.user(), f.user(), f.user()])).map((u) => u.id);

  // A: 599 gross, 47 fee -> net 552; read 7 pages of X and 3 of Y
  await subMonth(A, MONTH, 599, 47);
  await read(A, rx, X, P1, 7);
  await read(A, ry, Y, P2, 3);
  // B: 599 gross, 47 fee -> net 552; read nothing premium (one free page does not count)
  await subMonth(B, MONTH, 599, 47);
  await read(B, rx, X, P1, 1, 'free');
  // C: one month of an annual plan, 491 gross, no fee; read 1 page of Y. Their reads in another month are ignored.
  await subMonth(C, MONTH, 491, 0);
  await read(C, ry, Y, P2, 1);
  await read(C, rx, X, P1, 8, 'subscription', '2019-02-01');
  // D: bought X outright; purchase reads never draw on membership money
  await read(D, rx, X, P1, 8, 'purchase');
  // The following month: one member, nobody read anything.
  await subMonth(A, EMPTY, 599, 47);
});

after(async () => {
  await pool.end();
});

test('a month that has not ended cannot be settled', async () => {
  const now = new Date();
  const current = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
  await assert.rejects(settleMonth(current), /once it has ended/);
  await assert.rejects(settleMonth('2019-13'), /Month must look like/);
});

test('preview computes the split and writes nothing', async () => {
  const p = await previewSettlement('2019-03');
  assert.equal(p.already_settled, false);
  assert.equal(p.creator_cents, 1361);
  assert.equal((await one<{ n: number }>('select count(*)::int as n from ledger'))!.n, 0);
  assert.equal((await one<{ n: number }>('select count(*)::int as n from settlements'))!.n, 0);
  assert.equal((await one<{ n: number }>('select count(*)::int as n from sub_months where settled_at is not null'))!.n, 0);
});

test('settlement splits each member by what they read, pools non-readers, honours share overrides and splits', async () => {
  const r = await settleMonth(MONTH, { ranBy: null });
  /*
   * By hand:
   *   A net 552 over X:7, Y:3     -> X 386.4, Y 165.6 -> 386 + 165, spare cent to Y (.6)   => X 386, Y 166
   *   C net 491 over Y:1          -> Y 491
   *   B net 552 -> pool, shared by all membership reads X:7, Y:4
   *                               -> X 351.27, Y 200.72 -> 351 + 200, spare cent to Y (.72) => X 351, Y 201
   *   series net: X = 386 + 351 = 737, Y = 166 + 491 + 201 = 858   (737 + 858 = 1595 = 552 + 552 + 491)
   *   X (80%): floor(589.6) = 589 -> payee 25% = floor(147.25) = 147, owner 442; platform 148
   *   Y (90%): floor(772.2) = 772, platform 86
   */
  assert.equal(r.already_settled, false);
  assert.equal(r.subscribers, 3);
  assert.equal(r.gross_cents, 1689);
  assert.equal(r.fee_cents, 94);
  assert.equal(r.pool_cents, 552);
  assert.equal(r.undistributed_cents, 0);
  assert.deepEqual(r.series.map((s) => [s.series_id, s.pages, s.net_cents, s.creator_cents, s.platform_cents]), [[X, 7, 737, 589, 148], [Y, 4, 858, 772, 86]]);
  assert.equal(r.creator_cents, 1361);
  assert.equal(r.platform_cents, 234);
  // to the cent: everything members paid went to fees, creators or the platform
  assert.equal(r.fee_cents + r.creator_cents + r.platform_cents, r.gross_cents);

  const ledger = await q(`select publisher_id, series_id, amount_cents, gross_cents, month, kind, available_at > now() + interval '6 days' as held from ledger order by series_id, amount_cents desc`);
  assert.deepEqual(ledger.map((l) => [l.publisher_id, l.series_id, l.amount_cents, l.gross_cents]), [[P1, X, 442, 737], [PAYEE, X, 147, 0], [P2, Y, 772, 858]]);
  assert.ok(ledger.every((l) => l.kind === 'subscription' && l.month === MONTH && l.held), 'rows are subscription earnings for the month, held for the payout delay');
  assert.equal(ledger.reduce((n, l) => n + l.amount_cents, 0), r.creator_cents);

  const row = await one('select * from settlements where month = $1', [MONTH]);
  assert.deepEqual([row!.subscribers, row!.gross_cents, row!.fee_cents, row!.creator_cents, row!.platform_cents], [3, 1689, 94, 1361, 234]);
  assert.equal((await one<{ n: number }>('select count(*)::int as n from sub_months where month = $1 and settled_at is null', [MONTH]))!.n, 0);
  // the other month's rows are untouched
  assert.equal((await one<{ n: number }>('select count(*)::int as n from sub_months where month = $1 and settled_at is null', [EMPTY]))!.n, 1);
});

test('running the same month again changes nothing', async () => {
  const before = await q('select id, amount_cents from ledger order by id');
  const again = await settleMonth('2019-03');
  assert.equal(again.already_settled, true);
  assert.equal(again.creator_cents, 1361);
  const both = await Promise.all([settleMonth(MONTH), settleMonth(MONTH)]);
  assert.ok(both.every((b) => b.already_settled));
  assert.deepEqual(await q('select id, amount_cents from ledger order by id'), before);
  assert.equal((await one<{ n: number }>('select count(*)::int as n from settlements'))!.n, 1);
});

test('two runs racing for an unsettled month produce one settlement', async () => {
  const racers = await Promise.all([settleMonth(EMPTY), settleMonth(EMPTY), settleMonth(EMPTY)]);
  assert.equal(racers.filter((r) => !r.already_settled).length, 1);
  const done = racers.find((r) => !r.already_settled)!;
  // nobody read a membership page that month: there is no creator to pay, and the report says so
  assert.equal(done.pool_cents, 552);
  assert.equal(done.undistributed_cents, 552);
  assert.equal(done.creator_cents, 0);
  assert.equal(done.platform_cents, 552);
  assert.equal(done.fee_cents + done.creator_cents + done.platform_cents, done.gross_cents);
  assert.equal((await one<{ n: number }>('select count(*)::int as n from ledger where month = $1', [EMPTY]))!.n, 0);
});

test('awkward amounts across many members and series still balance exactly', async () => {
  const month = '2018-07-01';
  const pubs = [P1, P2];
  const members = await Promise.all(Array.from({ length: 7 }, () => f.user()));
  const amounts = [[599, 47], [1, 0], [5900, 201], [333, 40], [491, 14], [492, 15], [50, 31]];
  for (const [i, m] of members.entries()) {
    await subMonth(m.id, month, amounts[i][0], amounts[i][1]);
    if (i % 3 === 0) continue; // every third member reads nothing
    await read(m.id, rx, X, pubs[0], 1 + (i % 8), 'subscription', month);
    if (i % 2) await read(m.id, ry, Y, pubs[1], 1 + (i % 5), 'subscription', month);
  }
  const r = await settleMonth(month);
  const gross = amounts.reduce((n, a) => n + a[0], 0);
  const fee = amounts.reduce((n, a) => n + a[1], 0);
  assert.equal(r.gross_cents, gross);
  assert.equal(r.fee_cents, fee);
  assert.equal(r.series.reduce((n, s) => n + s.net_cents, 0), gross - fee, 'every net cent was assigned to a series');
  assert.equal(r.fee_cents + r.creator_cents + r.platform_cents, r.gross_cents);
  const paid = await one<{ cents: number }>('select coalesce(sum(amount_cents),0)::int as cents from ledger where month = $1', [month]);
  assert.equal(paid!.cents, r.creator_cents);
  // same inputs, same answer
  const shadow = r.series.map((s) => [s.series_id, s.net_cents, s.creator_cents]);
  await exec('delete from ledger where month = $1', [month]);
  await exec('delete from settlements where month = $1', [month]);
  await exec('update sub_months set settled_at = null where month = $1', [month]);
  const again = await settleMonth(month);
  assert.deepEqual(again.series.map((s) => [s.series_id, s.net_cents, s.creator_cents]), shadow);
});
