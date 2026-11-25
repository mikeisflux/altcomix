import assert from 'node:assert/strict';
import { test } from 'node:test';
import { allocate, bpsOf, breakdown, estimateFee, splitShares } from './ledger.ts';
import { applyCode, bestDiscount, bundlePrice, downloadPrice, percentOff, readPrice, seriesPrice } from './pricing.ts';
import type { Discount } from './pricing.ts';

const sum = (a: number[]) => a.reduce((x, y) => x + y, 0);

test('allocate: parts always sum to the total, largest remainders first, ties to the lower key', () => {
  assert.deepEqual(allocate(100, [1, 1, 1]), [34, 33, 33]);
  assert.deepEqual(allocate(100, [1, 1, 1], ['c', 'a', 'b']), [33, 34, 33]);
  assert.deepEqual(allocate(552, [7, 3]), [386, 166]);
  assert.deepEqual(allocate(1, [1, 1, 1, 1]), [1, 0, 0, 0]);
  assert.deepEqual(allocate(0, [5, 9]), [0, 0]);
  assert.deepEqual(allocate(77, [0, 0]), [0, 0]);
  assert.deepEqual(allocate(5900, Array(12).fill(1)), [492, 492, 492, 492, 492, 492, 492, 492, 491, 491, 491, 491]);
  for (const total of [1, 2, 3, 7, 99, 101, 599, 5900, 123457, 2_000_000_011]) {
    for (const w of [[1], [1, 2], [3, 3, 3], [1, 999999], [7, 11, 13, 17, 19], [1, 0, 1, 0, 1], [123456789, 987654321, 5]]) {
      const parts = allocate(total, w);
      assert.equal(sum(parts), total, `total ${total} weights ${w}`);
      assert.ok(parts.every((p) => p >= 0 && Number.isInteger(p)));
      // no part is more than one cent away from its exact share
      const W = sum(w);
      parts.forEach((p, i) => assert.ok(Math.abs(p - (total * w[i]) / W) < 1));
    }
  }
});

test('bpsOf floors exactly, without floating point drift', () => {
  assert.equal(bpsOf(199, 8500), 169);
  assert.equal(bpsOf(1, 9999), 0);
  assert.equal(bpsOf(10000, 1), 1);
  assert.equal(bpsOf(2_000_000_011, 8500), 1_700_000_009);
  assert.equal(bpsOf(57, 10000), 57);
});

test('estimateFee: percentage plus fixed, never above the charge, nothing on nothing', () => {
  const rev = { fee_pct_bps: 290, fee_fixed_cents: 30 };
  assert.equal(estimateFee(0, rev), 0);
  assert.equal(estimateFee(199, rev), 36);
  assert.equal(estimateFee(599, rev), 47);
  assert.equal(estimateFee(20, rev), 20);
});

test('splitShares: payees get floor(amount x bps), the owner keeps every leftover cent', () => {
  assert.deepEqual(splitShares(138, 'owner', []), [{ publisher_id: 'owner', cents: 138 }]);
  assert.deepEqual(splitShares(138, 'owner', [{ payee_publisher_id: 'p', share_bps: 2500 }]), [{ publisher_id: 'owner', cents: 104 }, { publisher_id: 'p', cents: 34 }]);
  // three thirds: 33 + 33 + 33, the odd cent stays with the owner
  const thirds = splitShares(100, 'owner', [{ payee_publisher_id: 'a', share_bps: 3333 }, { payee_publisher_id: 'b', share_bps: 3333 }, { payee_publisher_id: 'c', share_bps: 3333 }]);
  assert.deepEqual(thirds.map((s) => s.cents), [1, 33, 33, 33]);
  // over-allocated splits can never pay out more than there is
  const over = splitShares(101, 'owner', [{ payee_publisher_id: 'a', share_bps: 7000 }, { payee_publisher_id: 'b', share_bps: 7000 }]);
  assert.equal(sum(over.map((s) => s.cents)), 101);
  assert.ok(over.every((s) => s.cents >= 0));
  // a split that names the owner is ignored
  assert.deepEqual(splitShares(50, 'owner', [{ payee_publisher_id: 'owner', share_bps: 5000 }]), [{ publisher_id: 'owner', cents: 50 }]);
});

test('breakdown: fee + every creator row + platform is exactly the price, for awkward amounts', () => {
  const splitsets = [
    [],
    [{ payee_publisher_id: 'a', share_bps: 2500 }],
    [{ payee_publisher_id: 'a', share_bps: 3333 }, { payee_publisher_id: 'b', share_bps: 3333 }, { payee_publisher_id: 'c', share_bps: 3334 }],
    [{ payee_publisher_id: 'a', share_bps: 1 }, { payee_publisher_id: 'b', share_bps: 9999 }],
  ];
  let checked = 0;
  for (const price of [1, 2, 3, 5, 49, 50, 99, 101, 199, 333, 399, 499, 999, 1001, 5900, 12345, 99999, 1_000_003]) {
    for (const fee of [0, 1, 30, 31, 36, 47, Math.floor(price / 3), price, price + 5]) {
      for (const bps of [0, 1, 3333, 7000, 8000, 8500, 9500, 9999, 10000]) {
        for (const splits of splitsets) {
          const b = breakdown(price, fee, bps, 'owner', splits);
          const creators = sum(b.shares.map((s) => s.cents));
          assert.equal(creators, b.creator_cents);
          assert.equal(b.fee_cents + creators + b.platform_cents, price, `price ${price} fee ${fee} bps ${bps}`);
          assert.ok(b.fee_cents >= 0 && b.platform_cents >= 0 && b.shares.every((s) => s.cents >= 0 && Number.isInteger(s.cents)));
          // the creator's share is a percentage of the price, limited to what is left after the fee
          assert.equal(b.creator_cents, Math.min(price - b.fee_cents, bpsOf(price, bps)));
          checked++;
        }
      }
    }
  }
  assert.ok(checked > 5000);
});

test('an order: fee shared over its lines, then each line conserved, sums back to the charge', () => {
  const lines = [199, 399, 333, 1000, 7];
  const total = sum(lines);
  const fee = estimateFee(total, { fee_pct_bps: 290, fee_fixed_cents: 30 });
  const fees = allocate(fee, lines);
  assert.equal(sum(fees), fee);
  let creators = 0;
  let platform = 0;
  lines.forEach((price, i) => {
    const b = breakdown(price, fees[i], i === 2 ? 9500 : 8500, 'owner', i === 0 ? [{ payee_publisher_id: 'p', share_bps: 2500 }] : []);
    creators += sum(b.shares.map((s) => s.cents));
    platform += b.platform_cents;
  });
  assert.equal(fee + creators + platform, total);
});

const d = (over: Partial<Discount>): Discount => ({ id: 'd1', publisher_id: 'pub', series_id: null, percent_off: 10, applies_to: 'all', label: 'Sale', ends_at: null, ...over });
const series = { id: 's1', publisher_id: 'pub', default_price_cents: 199 };

test('percentOff rounds half up and stays within bounds', () => {
  assert.equal(percentOff(199, 0), 199);
  assert.equal(percentOff(199, 50), 100); // 99.5 -> 100
  assert.equal(percentOff(199, 20), 159); // 159.2
  assert.equal(percentOff(1, 95), 0); // 0.05
  assert.equal(percentOff(333, 33), 223); // 223.11
  assert.equal(percentOff(500, 100), 0);
});

test('read price: release override beats the series default; 0 or null means not sold', () => {
  assert.equal(readPrice(series, { price_cents: null }, [])?.price_cents, 199);
  assert.equal(readPrice(series, { price_cents: 299 }, [])?.price_cents, 299);
  assert.equal(readPrice(series, { price_cents: 0 }, []), null);
  assert.equal(readPrice({ ...series, default_price_cents: null }, { price_cents: null }, []), null);
});

test('discounts: best single percentage wins, scoped by publisher, series and read/download', () => {
  const ds = [
    d({ id: 'a', percent_off: 10 }),
    d({ id: 'b', percent_off: 30, series_id: 's1', applies_to: 'read', label: 'Series sale' }),
    d({ id: 'c', percent_off: 60, series_id: 'other' }),
    d({ id: 'e', percent_off: 80, publisher_id: 'someone-else' }),
    d({ id: 'f', percent_off: 40, applies_to: 'download', label: 'PDF week' }),
  ];
  assert.equal(bestDiscount(ds, 'pub', 's1', 'read')?.id, 'b');
  assert.equal(bestDiscount(ds, 'pub', 's2', 'read')?.id, 'a');
  const read = readPrice(series, { price_cents: null }, ds)!;
  assert.deepEqual([read.base_cents, read.price_cents, read.percent_off, read.discount_label], [199, 139, 30, 'Series sale']);
  // download: release's own discount (25) vs publisher download sale (40): no stacking, 40 wins
  const dl = downloadPrice(series, { download_price_cents: 499, download_discount_pct: 25 }, ds)!;
  assert.deepEqual([dl.price_cents, dl.percent_off, dl.discount_label], [299, 40, 'PDF week']);
  // without the sale the release's own discount applies
  const own = downloadPrice(series, { download_price_cents: 499, download_discount_pct: 25 }, [])!;
  assert.deepEqual([own.price_cents, own.percent_off, own.discount_label], [374, 25, 'Download discount']);
  assert.equal(downloadPrice(series, { download_price_cents: null }, ds), null);
  // bundles ignore series-scoped discounts
  assert.equal(bundlePrice({ publisher_id: 'pub', price_cents: 1000, includes_download: false }, ds).price_cents, 900);
  assert.equal(bundlePrice({ publisher_id: 'pub', price_cents: 1000, includes_download: true }, ds).price_cents, 600);
});

test('series price is the sum of discounted release prices; unsold releases are skipped', () => {
  const p = seriesPrice(series, [{ id: 'r1', price_cents: null }, { id: 'r2', price_cents: 0 }, { id: 'r3', price_cents: 301 }], [d({ percent_off: 50 })]);
  assert.deepEqual(p, { base_cents: 500, price_cents: 251, releases: [{ id: 'r1', price_cents: 100 }, { id: 'r3', price_cents: 151 }] });
});

test('checkout code: only content lines in scope are discounted', () => {
  const lines = [
    { kind: 'release', price_cents: 199, publisher_id: 'pub', series_id: 's1', release_id: 'r1' },
    { kind: 'download', price_cents: 499, publisher_id: 'pub', series_id: 's2', release_id: 'r9' },
    { kind: 'tip', price_cents: 500, publisher_id: 'pub', series_id: null, release_id: null },
    { kind: 'gift_card', price_cents: 1000, publisher_id: null, series_id: null, release_id: null },
    { kind: 'release', price_cents: 300, publisher_id: 'other', series_id: 's7', release_id: 'r7' },
  ];
  assert.deepEqual(applyCode({ publisher_id: 'pub', series_id: null, release_id: null, percent_off: 20 }, lines), { prices: [159, 399, 500, 1000, 300], discount_cents: 140 });
  assert.deepEqual(applyCode({ publisher_id: 'pub', series_id: 's1', release_id: null, percent_off: 100 }, lines).prices, [0, 499, 500, 1000, 300]);
  assert.deepEqual(applyCode({ publisher_id: null, series_id: null, release_id: 'r9', percent_off: 10 }, lines).prices, [199, 449, 500, 1000, 300]);
  assert.deepEqual(applyCode({ publisher_id: null, series_id: null, release_id: null, percent_off: 50 }, lines).prices, [100, 250, 500, 1000, 150]);
});
