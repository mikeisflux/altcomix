import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { fixtures, useTestDatabase } from './commerce.testkit.ts';

/** Partial refunds: the books follow the money exactly, access stays. */
await useTestDatabase('refunds');
const { exec, one, q, pool } = await import('../db.ts');
const { setSetting } = await import('./settings.ts');
const { allocate, refundParts } = await import('./ledger.ts');
const pay = await import('./payments.ts');
const f = await fixtures();

let brand: Record<string, any>, payee: Record<string, any>, series: Record<string, any>, release: Record<string, any>, second: Record<string, any>;

before(async () => {
  await setSetting('payments', { provider: 'sandbox' }, null);
  await setSetting('revenue', { sale_share_bps: 8500, tip_share_bps: 9500, fee_pct_bps: 290, fee_fixed_cents: 30 }, null);
  brand = await f.brand((await f.user()).id);
  payee = await f.brand((await f.user()).id);
  series = await f.series(brand.id);
  release = await f.release(series.id, { number: 1 }, 2);
  second = await f.release(series.id, { number: 2 }, 2);
  await exec('insert into revenue_splits (series_id, payee_publisher_id, share_bps) values ($1,$2,2500)', [series.id, payee.id]);
});
after(async () => {
  await pool.end();
});

/** A paid sandbox order: `prices` are release lines (first two releases), `tip` adds a tip line, `credit` is store credit used. */
async function paidOrder(prices: number[], opts: { tip?: number; credit?: number } = {}) {
  const user = await f.user();
  const total = prices.reduce((a, b) => a + b, 0) + (opts.tip ?? 0);
  const o = await one<{ id: string }>(`insert into orders (user_id, status, total_cents, credit_cents, provider, meta) values ($1,'pending',$2,$3,'sandbox','{}') returning id`, [user.id, total, opts.credit ?? 0]);
  for (const [i, p] of prices.entries()) {
    await exec(`insert into order_items (order_id, kind, release_id, series_id, publisher_id, description, price_cents) values ($1,'release',$2,$3,$4,$5,$6)`, [o!.id, [release, second][i].id, series.id, brand.id, `Release ${i + 1}`, p]);
  }
  if (opts.tip) await exec(`insert into order_items (order_id, kind, publisher_id, description, price_cents, meta) values ($1,'tip',$2,'Tip',$3,'{"message":"thanks"}')`, [o!.id, brand.id, opts.tip]);
  assert.equal((await pay.startOrderPayment(o!.id)).completed, true);
  return { id: o!.id, user };
}
const order = (id: string) => one('select * from orders where id = $1', [id]);
const owns = async (userId: string, releaseId = release.id) => Boolean(await one('select 1 from entitlements where user_id = $1 and release_id = $2', [userId, releaseId]));
const ledger = (id: string) => q<{ publisher_id: string; kind: string; amount_cents: number; gross_cents: number }>('select publisher_id, kind, amount_cents, gross_cents from ledger where order_id = $1 order by created_at, id', [id]);
const sum = (rows: { amount_cents: number }[]) => rows.reduce((n, r) => n + r.amount_cents, 0);
const refundEvent = (id: string, amount: number, refundId: string | undefined, partial = true) =>
  pay.handleDivinityEvent({ event: 'refund.completed', data: { pledgeId: id, amount, status: 'succeeded', partial, ...(refundId ? { refundId } : {}), reason: 'Damaged pages' } });

test('refundParts: creator + platform + fee is exactly the refund, in proportion, for awkward amounts', () => {
  assert.deepEqual(refundParts({ total_cents: 199, fee_cents: 36, creator_cents: 138 }, 100), { creator_cents: 69, platform_cents: 13, fee_cents: 18 });
  assert.deepEqual(refundParts({ total_cents: 199, fee_cents: 36, creator_cents: 138 }, 199), { creator_cents: 138, platform_cents: 25, fee_cents: 36 }, 'refunding everything returns exactly what each took');
  assert.deepEqual(refundParts({ total_cents: 199, fee_cents: 36, creator_cents: 138 }, 0), { creator_cents: 0, platform_cents: 0, fee_cents: 0 });
  for (const total of [50, 99, 199, 1333, 5001, 99_999]) {
    const fee = Math.min(total, Math.round(total * 0.029) + 30);
    const creator = Math.floor(((total - fee) * 8500) / 10000);
    let prev = { creator_cents: 0, platform_cents: 0, fee_cents: 0 };
    for (const refund of [1, 2, 3, 7, Math.floor(total / 3), Math.floor(total / 2), total - 1, total]) {
      const p = refundParts({ total_cents: total, fee_cents: fee, creator_cents: creator }, refund);
      assert.equal(p.creator_cents + p.platform_cents + p.fee_cents, refund, `total ${total}, refund ${refund}`);
      assert.ok(p.creator_cents <= creator && p.fee_cents <= fee && p.platform_cents <= total - fee - creator, 'nobody gives back more than they took');
      assert.ok(Math.abs(p.creator_cents - (refund * creator) / total) < 1 && Math.abs(p.fee_cents - (refund * fee) / total) < 1, 'within a cent of the exact proportion');
      assert.ok(p.creator_cents >= prev.creator_cents - 1, 'running totals never jump backwards by more than rounding');
      prev = p;
    }
  }
  // no fee (paid with store credit), nothing earned (gift card): still exact
  assert.deepEqual(refundParts({ total_cents: 1000, fee_cents: 0, creator_cents: 0 }, 333), { creator_cents: 0, platform_cents: 333, fee_cents: 0 });
});

test('a partial refund reverses creator earnings, platform and fee in proportion; the reader keeps the release', async () => {
  const { id, user } = await paidOrder([199]);
  const before = await order(id);
  // 199 = 36 fee + 138 creators (104 owner + 34 payee) + 25 platform
  assert.deepEqual([before!.fee_cents, (await ledger(id)).map((l) => l.amount_cents)], [36, [104, 34]]);

  assert.deepEqual(await refundEvent(id, 100, 're_part_1'), { success: true, message: `Order ${id} partly refunded` });
  const o = await order(id);
  assert.deepEqual([o!.status, o!.refunded_cents, o!.refunded_at], ['paid', 100, null], 'the order stays paid');
  assert.equal(await owns(user.id), true, 'entitlements are kept');
  const [entry] = o!.meta.partial_refunds;
  assert.deepEqual([entry.ref, entry.amount_cents, entry.creator_cents, entry.platform_cents, entry.fee_cents, entry.reason], ['re_part_1', 100, 69, 13, 18, 'Damaged pages']);
  assert.equal(entry.creator_cents + entry.platform_cents + entry.fee_cents, 100, 'exact conservation');
  const rows = await ledger(id);
  const back = rows.filter((l) => l.kind === 'refund');
  // 69 of creator money shared like the earnings were: owner 104/138, payee 34/138
  assert.deepEqual(back.map((l) => [l.publisher_id, l.amount_cents, l.gross_cents]), [[brand.id, -52, -100], [payee.id, -17, 0]]);
  assert.equal(sum(rows), 138 - 69);
  assert.ok((await q(`select 1 from notifications where user_id = $1 and kind = 'refund' and title = 'Part of your order was refunded'`, [user.id])).length === 1);

  // the processor redelivers the same event: nothing more happens
  assert.match((await refundEvent(id, 100, 're_part_1')).message, /already applied/);
  assert.equal((await order(id))!.refunded_cents, 100);
  assert.equal((await ledger(id)).length, 4);
});

test('several partial refunds stay exact to the cent, and a later full refund takes back exactly the rest', async () => {
  const { id, user } = await paidOrder([199, 301], { tip: 333 }); // 833 on the card
  const o0 = await order(id);
  const earned = sum(await ledger(id));
  const platform0 = o0!.total_cents - o0!.fee_cents - earned;
  let creator = 0, platform = 0, fee = 0, refunded = 0;
  for (const [n, amount] of [7, 1, 250, 99, 333].entries()) {
    assert.match((await refundEvent(id, amount, `re_multi_${n}`)).message, /partly refunded/);
    refunded += amount;
    const o = await order(id);
    const e = o!.meta.partial_refunds[n];
    assert.equal(e.creator_cents + e.platform_cents + e.fee_cents, amount, `refund ${n}: the three parts are exactly the refund`);
    creator += e.creator_cents; platform += e.platform_cents; fee += e.fee_cents;
    assert.equal(o!.refunded_cents, refunded);
    // running totals match a single refund of the same size, so nothing drifts
    assert.deepEqual({ creator_cents: creator, platform_cents: platform, fee_cents: fee }, refundParts({ total_cents: 833, fee_cents: o0!.fee_cents, creator_cents: earned }, refunded));
    const rows = await ledger(id);
    assert.equal(sum(rows), earned - creator, 'the ledger holds exactly what the creators still keep');
    assert.equal(rows.reduce((s, r) => s + r.gross_cents, 0), 833 - refunded, 'gross follows the money');
    // per payee, what stands is their share of what remains (within rounding), never negative
    for (const p of [brand.id, payee.id]) assert.ok(sum(rows.filter((r) => r.publisher_id === p)) >= 0);
  }
  assert.equal(refunded, 690);
  assert.ok(creator <= earned && fee <= o0!.fee_cents && platform <= platform0);
  assert.equal(await owns(user.id), true);
  assert.equal(await owns(user.id, second.id), true);
  assert.equal((await one<{ n: number }>('select count(*)::int as n from tips where order_id = $1', [id]))!.n, 1);

  // full refund afterwards (admin button): only the remaining 143 is left to reverse, and the books end at zero
  assert.deepEqual(await pay.refundOrder(id, { reason: 'Changed their mind' }), { refunded: true });
  const end = await order(id);
  assert.equal(end!.status, 'refunded');
  assert.equal(sum(await ledger(id)), 0, 'every creator cent is reversed exactly once');
  assert.equal((await ledger(id)).reduce((s, r) => s + r.gross_cents, 0), 0);
  assert.equal(await owns(user.id), false, 'a full refund still removes access');
  assert.match((await refundEvent(id, 10, 're_late')).message, /ignored/);
});

test('partial refunds that add up to the whole card charge become a full refund; store credit is returned', async () => {
  const { id, user } = await paidOrder([199]);
  await refundEvent(id, 150, 're_a');
  assert.equal(await owns(user.id), true);
  assert.match((await refundEvent(id, 49, 're_b')).message, new RegExp(`Order ${id} refunded`));
  assert.deepEqual([(await order(id))!.status, await owns(user.id), sum(await ledger(id))], ['refunded', false, 0]);

  // with store credit in the order, proportions are of the whole order, the cap is the card charge
  const buyer = await paidOrder([301], { credit: 100 }); // 201 on the card
  await exec(`insert into wallets (user_id, credit_cents) values ($1, 0) on conflict do nothing`, [buyer.user.id]);
  await refundEvent(buyer.id, 67, 're_c');
  const o = await order(buyer.id);
  const e = o!.meta.partial_refunds[0];
  assert.equal(e.creator_cents + e.platform_cents + e.fee_cents, 67);
  assert.equal(e.creator_cents, allocate(67, [sum((await ledger(buyer.id)).filter((l) => l.kind !== 'refund')), 301 - o!.fee_cents - sum((await ledger(buyer.id)).filter((l) => l.kind !== 'refund')), o!.fee_cents], ['a', 'b', 'c'])[0]);
  assert.match((await refundEvent(buyer.id, 134, 're_d')).message, /refunded$/);
  assert.equal((await order(buyer.id))!.status, 'refunded');
  assert.equal((await one('select credit_cents from wallets where user_id = $1', [buyer.user.id]))!.credit_cents, 100, 'the credit part comes back when the order is fully refunded');
});

test('full refunds are unchanged; odd partial events are ignored safely', async () => {
  const { id, user } = await paidOrder([199]);
  // no amount, zero, fractional: nothing is written
  for (const amount of [undefined, 0, 12.5, -5]) {
    assert.match((await pay.handleDivinityEvent({ event: 'refund.completed', data: { pledgeId: id, amount, partial: true, refundId: `re_bad_${amount}` } })).message, /ignored/);
  }
  assert.deepEqual([(await order(id))!.refunded_cents, (await ledger(id)).length], [0, 2]);
  // without a refund id the same amount twice in a row is one refund (redelivery), a different amount is another
  await refundEvent(id, 20, undefined);
  assert.match((await refundEvent(id, 20, undefined)).message, /already applied/);
  await refundEvent(id, 21, undefined);
  assert.equal((await order(id))!.refunded_cents, 41);
  assert.equal(await pay.partialRefundOrder('00000000-0000-7000-8000-000000000000', { amountCents: 10 }), 'ignored');

  // a plain full refund (partial: false) behaves exactly as before: one opposite row per earning row
  const full = await paidOrder([199]);
  assert.match((await refundEvent(full.id, 199, 're_full', false)).message, /refunded$/);
  assert.deepEqual((await ledger(full.id)).map((l) => [l.kind, l.amount_cents, l.gross_cents]), [['sale', 104, 199], ['sale', 34, 0], ['refund', -104, -199], ['refund', -34, 0]]);
  assert.deepEqual([(await order(full.id))!.status, await owns(full.user.id)], ['refunded', false]);
  assert.equal(await owns(user.id), true);
});
