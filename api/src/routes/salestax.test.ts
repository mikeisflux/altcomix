import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';
import { fixtures, useTestDatabase } from '../lib/commerce.testkit.ts';

/**
 * Sales tax at checkout, end to end through the HTTP stack. Card payments go
 * to the sandbox provider or to a local stand-in for the processor's partner
 * API (never a live processor), which records the amounts it is asked for.
 */
await useTestDatabase('salestax');
process.env.ROUTES = 'auth,account,commerce,admin-finance,admin-settings,admin-dashboard';
const { exec, one, q, pool } = await import('../db.ts');
const { setSetting, getSetting, publicSettings } = await import('../lib/settings.ts');
const tax = await import('../lib/salestax.ts');
const pay = await import('../lib/payments.ts');
const { refundParts } = await import('../lib/ledger.ts');
const { runMembershipCycle } = await import('../jobs/memberships.ts');
const { buildApp } = await import('../server.ts');
const f = await fixtures();
const app = await buildApp();

class Client {
  cookies: Record<string, string> = {};
  async call(method: string, url: string, body?: unknown) {
    const cookie = Object.entries(this.cookies).map(([k, v]) => `${k}=${v}`).join('; ');
    const res = await app.inject({
      method: method as 'GET', url,
      headers: { ...(cookie ? { cookie } : {}), ...(this.cookies.csrf_token ? { 'x-csrf-token': this.cookies.csrf_token } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}), 'user-agent': 'Mozilla/5.0 (Test)' },
      payload: body !== undefined ? JSON.stringify(body) : undefined,
    });
    for (const c of [res.headers['set-cookie'] ?? []].flat()) {
      const [pair] = String(c).split(';');
      const i = pair.indexOf('=');
      if (pair.slice(i + 1)) this.cookies[pair.slice(0, i)] = pair.slice(i + 1);
      else delete this.cookies[pair.slice(0, i)];
    }
    let json: any = null;
    try {
      json = JSON.parse(res.payload);
    } catch {
      // not JSON (csv)
    }
    return { status: res.statusCode, json, res };
  }
  get = (url: string) => this.call('GET', url);
  post = (url: string, body: unknown = {}) => this.call('POST', url, body);
  put = (url: string, body: unknown = {}) => this.call('PUT', url, body);
  patch = (url: string, body: unknown = {}) => this.call('PATCH', url, body);
  async login(email: string) {
    await this.get('/api/bootstrap');
    const r = await this.post('/api/auth/login', { email, password: 'correct horse battery' });
    assert.equal(r.status, 200, r.res.payload);
    return this;
  }
}
const signedIn = async (over: Parameters<typeof f.user>[0] = {}) => {
  const user = await f.user(over);
  return { user, c: await new Client().login(user.email) };
};

// A stand-in for the processor that remembers what it was asked to charge.
type Call = { action: string; body: Record<string, any> };
const calls: Call[] = [];
const fake = createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    const action = new URL(req.url!, 'http://x').searchParams.get('action') ?? '';
    const b = raw ? JSON.parse(raw) : {};
    calls.push({ action, body: b });
    let out: unknown = { success: true };
    if (action === 'create-checkout-session') {
      const id = `cs_tax_${Date.now().toString(36)}_${calls.length}`;
      out = { success: true, sessionId: id, checkoutUrl: `https://pay.example/checkout/${id}` };
    } else if (action === 'charge-saved-payment-method') out = { success: true, status: 'succeeded', paymentIntentId: `pi_${b.pledgeId}_${b.idempotencyKey}`, amount: b.amount };
    else if (action === 'refund') out = { success: true, refundId: `re_${calls.length}`, amount: b.amount, status: 'succeeded' };
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(out));
  });
});
const of = (action: string) => calls.filter((c) => c.action === action);
const useSandbox = () => setSetting('payments', { provider: 'sandbox' }, null);
const useProcessor = () =>
  setSetting('payments', { provider: 'divinity', divinity_api_url: `http://127.0.0.1:${(fake.address() as AddressInfo).port}/internal`, divinity_partner_id: 'partner_tax', divinity_api_key: 'dc_tax_testkey' }, null);

const RATES = { IN: 700, OH: 575, WY: 400 };
const taxOn = () => setSetting('tax', { enabled: true, rates: RATES }, null);
const taxOff = () => setSetting('tax', { enabled: false, rates: RATES }, null);
const IN = { country: 'US', state: 'IN', zip: '46204' };
const OH = { country: 'US', state: 'OH', zip: '43215' };
const CALIFORNIA = { country: 'US', state: 'CA', zip: '90210' };

let brand: any, payee: any, series: any, r1: any, r2: any, r3: any, bundle: any;
const order = (id: string) => one('select * from orders where id = $1', [id]);
const ledger = (id: string) => q('select publisher_id, kind, amount_cents, gross_cents, series_id, release_id from ledger where order_id = $1 order by publisher_id, kind, amount_cents', [id]);
const wallet = async (userId: string) => (await one<{ credit_cents: number }>('select credit_cents from wallets where user_id = $1', [userId]))?.credit_cents ?? 0;
const giveCredit = (userId: string, cents: number) => exec(`insert into wallets (user_id, credit_cents) values ($1,$2) on conflict (user_id) do update set credit_cents = $2`, [userId, cents]);

before(async () => {
  await new Promise<void>((r) => fake.listen(0, '127.0.0.1', r));
  // This database belongs to this file alone: start each run from nothing so the report can be checked exactly.
  await exec('delete from sales_tax_refunds');
  await exec('delete from subscriptions');
  await exec('delete from orders');
  await useSandbox();
  await setSetting('membership', { trial_days: 0, monthly_cents: 599, annual_cents: 5900, page_credit_cents: 5 }, null);
  await setSetting('revenue', { sale_share_bps: 8500, tip_share_bps: 9500, fee_pct_bps: 290, fee_fixed_cents: 30 }, null);
  await taxOn();
  brand = await f.brand((await f.user()).id);
  payee = await f.brand((await f.user()).id);
  series = await f.series(brand.id);
  r1 = await f.release(series.id, { number: 1 }, 1); // 199 (series default)
  r2 = await f.release(series.id, { number: 2, price_cents: 1000 }, 1);
  r3 = await f.release(series.id, { number: 3, price_cents: 1999 }, 1);
  await exec('insert into revenue_splits (series_id, payee_publisher_id, share_bps) values ($1,$2,2500)', [series.id, payee.id]);
  bundle = await one(`insert into bundles (publisher_id, title, price_cents) values ($1,'Starter pack',1000) returning *`, [brand.id]);
  await exec('insert into bundle_items (bundle_id, release_id) values ($1,$2),($1,$3)', [bundle.id, r1.id, r2.id]);
});
after(async () => {
  await taxOff();
  await useSandbox();
  fake.close();
  await app.close();
  await pool.end();
});

test('the calculation: half up on the order total, shared out over the taxed lines, tips and gift cards left out', () => {
  const cfg = { enabled: true, rates: RATES };
  // 750 at 7% is 52.5: half a cent rounds up
  assert.equal(tax.taxOn(750, 700), 53);
  assert.equal(tax.taxOn(749, 700), 52); // 52.43
  assert.equal(tax.taxOn(150, 700), 11); // 10.5
  assert.equal(tax.taxOn(199, 0), 0);
  assert.equal(tax.taxOn(0, 700), 0);
  // rounded once on the order, not per line: three 7-cent lines owe 1 cent, not 0 and not 3
  const three = tax.computeTax([{ kind: 'credits', price_cents: 7 }, { kind: 'credits', price_cents: 7 }, { kind: 'credits', price_cents: 7 }], IN, cfg);
  assert.deepEqual([three.taxable_cents, three.tax_cents, three.lines], [21, 1, [1, 0, 0]], '1.47 rounds to 1; the tie goes to the earlier line');
  const mixed = tax.computeTax([{ kind: 'release', price_cents: 199 }, { kind: 'tip', price_cents: 500 }, { kind: 'release', price_cents: 1999 }, { kind: 'gift_card', price_cents: 1000 }], IN, cfg);
  assert.deepEqual([mixed.taxable_cents, mixed.tax_cents, mixed.lines], [2198, 154, [14, 0, 140, 0]]);
  assert.equal(mixed.lines.reduce((a, b) => a + b, 0), mixed.tax_cents);
  // a free line owes nothing; every taxed kind is taxed
  assert.equal(tax.computeTax([{ kind: 'release', price_cents: 0 }], IN, cfg).tax_cents, 0);
  for (const kind of ['release', 'download', 'series', 'bundle', 'credits', 'membership']) assert.equal(tax.computeTax([{ kind, price_cents: 1000 }], IN, cfg).tax_cents, 70, kind);
  for (const kind of ['tip', 'gift_card']) assert.equal(tax.computeTax([{ kind, price_cents: 1000 }], IN, cfg).tax_cents, 0, kind);
  // no rate entered, outside the US, feature off, no location yet
  assert.deepEqual([tax.computeTax([{ kind: 'release', price_cents: 1000 }], CALIFORNIA, cfg).tax_cents, tax.computeTax([{ kind: 'release', price_cents: 1000 }], CALIFORNIA, cfg).state], [0, 'CA']);
  const abroad = tax.computeTax([{ kind: 'release', price_cents: 1000 }], { country: 'CA', state: null, zip: null }, cfg);
  assert.deepEqual([abroad.tax_cents, abroad.country, abroad.state, abroad.rate_bps], [0, 'CA', null, 0]);
  const off = tax.computeTax([{ kind: 'release', price_cents: 1000 }], IN, { enabled: false, rates: RATES });
  assert.deepEqual([off.enabled, off.tax_cents, off.state, off.taxable_cents], [false, 0, null, 0]);
  assert.equal(tax.computeTax([{ kind: 'release', price_cents: 1000 }], null, cfg).needs_location, true);
  assert.equal(tax.computeTax([{ kind: 'tip', price_cents: 1000 }], null, cfg).needs_location, false, 'nothing taxed, nothing to ask');
  assert.deepEqual([tax.taxLabel('IN', 700), tax.taxLabel('OH', 575), tax.taxLabel('NJ', 663)], ['Sales tax (Indiana 7%)', 'Sales tax (Ohio 5.75%)', 'Sales tax (New Jersey 6.63%)']);
});

test('refund math: the same proportion of the tax, half up on running totals, never more than was collected', () => {
  const o = { total_cents: 1999, tax_cents: 140 };
  assert.equal(tax.taxRefunded(o, 0), 0);
  assert.equal(tax.taxRefunded(o, 1000), 65); // 1000 x 140 / 2139 = 65.45
  assert.equal(tax.taxRefunded(o, 1500), 98); // 98.18
  assert.equal(tax.taxRefunded(o, 2139), 140);
  assert.equal(tax.taxRefunded(o, 99_999), 140, 'capped at what was collected');
  assert.equal(tax.taxRefunded({ total_cents: 1999, tax_cents: 0 }, 500), 0);
  for (const [total, t] of [[199, 14], [750, 53], [5900, 413], [7, 1]] as const) {
    let prev = 0;
    for (let r = 0; r <= total + t; r++) {
      const back = tax.taxRefunded({ total_cents: total, tax_cents: t }, r);
      assert.ok(back >= prev && back <= t && back <= r, `monotonic and bounded at ${r} of ${total}+${t}`);
      prev = back;
    }
    assert.equal(prev, t, 'everything refunded returns exactly the tax');
  }
});

test('billing location: country, and in the US a listed state and a ZIP that fits it', () => {
  assert.deepEqual(tax.parseLocation({ country: 'us', state: 'in', zip: ' 46204 ' }), IN);
  assert.deepEqual(tax.parseLocation({ country: 'US', state: 'IN', zip: '46204-1234' }), { country: 'US', state: 'IN', zip: '46204-1234' });
  assert.deepEqual(tax.parseLocation({ country: 'DE', state: 'IN', zip: '10115' }), { country: 'DE', state: null, zip: null }, 'state and ZIP are dropped outside the US');
  assert.equal(tax.parseLocation(undefined), null);
  for (const bad of [{ country: 'XX' }, { country: 'USA' }, {}, { country: 'US' }, { country: 'US', state: 'ZZ', zip: '46204' }, { country: 'US', state: 'PR', zip: '00901' },
    { country: 'US', state: 'IN', zip: '4620' }, { country: 'US', state: 'IN', zip: '46204-12' }, { country: 'US', state: 'IN', zip: 'ABCDE' }, { country: 'US', state: 'IN', zip: '90210' }, 'US']) {
    assert.throws(() => tax.parseLocation(bad), (e: any) => e.status === 400 && e.code === 'location_invalid', JSON.stringify(bad));
  }
  // the three states whose ZIP codes start with more than one digit
  for (const [state, zip] of [['NY', '10001'], ['NY', '00501'], ['NY', '06390'], ['TX', '75001'], ['TX', '88510'], ['DC', '20001'], ['DC', '56901']]) assert.equal(tax.zipFitsState(zip, state), true, `${state} ${zip}`);
  assert.equal(tax.US_STATES.length, 51);
  assert.equal(new Set(tax.US_STATES.map((s) => s.code)).size, 51);
});

test('settings: off by default with every state at 0; rates are 0 to 2000 basis points for the 50 states and DC; the public site only learns on/off', async () => {
  const { SETTINGS } = await import('../lib/settings.ts');
  assert.deepEqual(SETTINGS.tax.defaults, { enabled: false, rates: {} });
  const admin = await signedIn({ role: 'super_admin' });
  const save = (data: unknown) => admin.c.patch('/api/admin/settings', { section: 'tax', data });
  for (const [rates, why] of [[{ IN: 2001 }, /above 20%/], [{ IN: -1 }, /below 0%/], [{ IN: 7.5 }, /whole basis points/], [{ ZZ: 700 }, /50 states/], [{ PR: 700 }, /50 states/]] as const) {
    const r = await save({ rates });
    assert.equal(r.status, 400, JSON.stringify(rates));
    assert.match(r.json.error, why);
  }
  const all = Object.fromEntries(tax.US_STATES.map((s) => [s.code, 0]));
  const ok = await save({ enabled: true, rates: { ...all, ...RATES, DC: 2000 } });
  assert.equal(ok.status, 200, ok.res.payload);
  assert.deepEqual([(await getSetting('tax')).rates.IN, (await getSetting('tax')).rates.DC, (await getSetting('tax')).rates.CA], [700, 2000, 0]);
  assert.equal((await (await signedIn()).c.patch('/api/admin/settings', { section: 'tax', data: { enabled: false } })).status, 403);
  await taxOn();
  assert.deepEqual((await publicSettings()).tax, { enabled: true });
  assert.ok(!JSON.stringify(await publicSettings()).includes('rates'), 'the rate table is not sent to browsers');
  const boot = (await new Client().get('/api/bootstrap')).json;
  assert.deepEqual(boot.settings.tax, { enabled: true });
});

test('feature off: the same totals as before, no location asked for, and a location that is sent anyway is ignored', async () => {
  await taxOff();
  try {
    const { user, c } = await signedIn();
    const qt = await c.post('/api/checkout/quote', { items: [{ kind: 'release', id: r1.id }], location: { country: 'US', state: 'not-a-state' } });
    assert.equal(qt.status, 200, qt.res.payload);
    assert.deepEqual([qt.json.total_cents, qt.json.tax, qt.json.tax_cents, qt.json.total_with_tax_cents, qt.json.amount_due_cents, qt.json.problem], [199, null, 0, 199, 199, null]);
    const buy = await c.post('/api/checkout', { items: [{ kind: 'release', id: r1.id }], location: IN });
    assert.equal(buy.json.completed, true, buy.res.payload);
    const o = await order(buy.json.order_id);
    assert.deepEqual([o!.total_cents, o!.tax_cents, o!.taxable_cents, o!.tax_country, o!.tax_state, o!.tax_zip, o!.tax_rate_bps, o!.fee_cents], [199, 0, 0, null, null, null, 0, 36]);
    const view = (await c.get(`/api/orders/${o!.id}`)).json.order;
    assert.deepEqual([view.total_cents, view.charged_cents, view.tax_cents, view.tax_label, view.items[0].tax_cents], [199, 199, 0, null, 0]);
    assert.equal((await one('select billing_country from users where id = $1', [user.id]))!.billing_country, null, 'nothing is remembered while the feature is off');
    assert.deepEqual((await c.get('/api/billing-location')).json, { enabled: false, location: null });
    assert.ok(!(await one(`select html from emails where template = 'receipt' and user_id = $1`, [user.id]))!.html.includes('Sales tax'));
    // membership: no location needed, no tax
    const m = await c.post('/api/membership/start', { plan: 'monthly' });
    assert.equal(m.json.completed, true, m.res.payload);
    assert.equal(m.json.tax, null);
    const ch = await one('select amount_cents, tax_cents, tax_state from subscription_charges where user_id = $1', [user.id]);
    assert.deepEqual([ch!.amount_cents, ch!.tax_cents, ch!.tax_state], [599, 0, null]);
    assert.deepEqual([m.json.subscription.last_charge.total_cents, m.json.subscription.last_charge.tax_label], [599, null]);
  } finally {
    await taxOn();
  }
});

test('a state with no rate: located, 0 tax, no tax line; a location is required before paying for something taxed', async () => {
  const { c } = await signedIn();
  const blank = await c.post('/api/checkout/quote', { items: [{ kind: 'release', id: r1.id }] });
  assert.deepEqual([blank.json.tax.needs_location, blank.json.tax.location, blank.json.tax_cents, blank.json.problem.code], [true, null, 0, 'location_required']);
  const refused = await c.post('/api/checkout', { items: [{ kind: 'release', id: r1.id }] });
  assert.deepEqual([refused.status, refused.json.code], [400, 'location_required']);
  // nothing taxed in the basket: no location needed
  const tip = await c.post('/api/checkout/quote', { items: [{ kind: 'tip', id: brand.slug, amount_cents: 500 }] });
  assert.deepEqual([tip.json.tax.needs_location, tip.json.tax.taxable_cents, tip.json.problem], [false, 0, null]);

  const qt = await c.post('/api/checkout/quote', { items: [{ kind: 'release', id: r1.id }], location: CALIFORNIA });
  assert.deepEqual([qt.json.tax.location, qt.json.tax.state_name, qt.json.tax.rate_bps, qt.json.tax.tax_cents, qt.json.tax.label, qt.json.total_with_tax_cents, qt.json.amount_due_cents], [CALIFORNIA, 'California', 0, 0, null, 199, 199]);
  const buy = await c.post('/api/checkout', { items: [{ kind: 'release', id: r1.id }], location: CALIFORNIA });
  assert.equal(buy.json.completed, true, buy.res.payload);
  const o = await order(buy.json.order_id);
  assert.deepEqual([o!.total_cents, o!.tax_cents, o!.taxable_cents, o!.tax_country, o!.tax_state, o!.tax_zip, o!.tax_rate_bps], [199, 0, 199, 'US', 'CA', '90210', 0]);
  assert.equal((await c.get(`/api/orders/${o!.id}`)).json.order.tax_label, null);
});

test('7% state: a release, a bundle with a discount code and a page-credit pack; the location is remembered', async () => {
  const { user, c } = await signedIn();
  const qt = await c.post('/api/checkout/quote', { items: [{ kind: 'release', id: r1.id }], location: IN });
  assert.deepEqual([qt.json.total_cents, qt.json.tax.taxable_cents, qt.json.tax.rate_bps, qt.json.tax_cents, qt.json.tax.label, qt.json.total_with_tax_cents, qt.json.amount_due_cents, qt.json.lines[0].tax_cents],
    [199, 199, 700, 14, 'Sales tax (Indiana 7%)', 213, 213, 14]); // 13.93 rounds to 14
  assert.equal((await one('select billing_state from users where id = $1', [user.id]))!.billing_state, null, 'a quote saves nothing');
  const buy = await c.post('/api/checkout', { items: [{ kind: 'release', id: r1.id }], location: IN });
  assert.equal(buy.json.completed, true, buy.res.payload);
  const o = await order(buy.json.order_id);
  assert.deepEqual([o!.total_cents, o!.tax_cents, o!.taxable_cents, o!.tax_state, o!.tax_zip, o!.tax_rate_bps, o!.credit_cents], [199, 14, 199, 'IN', '46204', 700, 0]);
  const view = (await c.get(`/api/orders/${o!.id}`)).json.order;
  assert.deepEqual([view.total_cents, view.tax_cents, view.tax_label, view.charged_cents, view.items[0].tax_cents], [199, 14, 'Sales tax (Indiana 7%)', 213, 14]);
  const listed = (await c.get('/api/account/orders')).json.items[0];
  assert.deepEqual([listed.total_cents, listed.tax_cents, listed.tax_label, listed.charged_cents], [199, 14, 'Sales tax (Indiana 7%)', 213]);
  const mail = await one(`select html from emails where template = 'receipt' and user_id = $1`, [user.id]);
  assert.match(mail!.html, /Subtotal<\/td><td align="right">\$1\.99/);
  assert.match(mail!.html, /Sales tax \(Indiana 7%\)<\/td><td align="right">\$0\.14/);
  assert.match(mail!.html, /Total: \$2\.13/);

  // prefilled next time: no location sent, the saved one is used
  assert.deepEqual((await c.get('/api/billing-location')).json, { enabled: true, location: IN });
  await exec(`insert into promo_codes (publisher_id, code, kind, percent_off) values ($1,$2,'discount',25)`, [brand.id, `TAX25-${user.username}`]);
  // the bundle holds release 1, which this reader now owns, and release 2: still for sale. 1000 less 25% = 750; 7% of 750 is 52.5, charged as 53.
  const basket = { items: [{ kind: 'bundle', id: bundle.id }], code: `TAX25-${user.username}` };
  const bq = await c.post('/api/checkout/quote', basket);
  assert.deepEqual([bq.json.total_cents, bq.json.discounts.code_cents, bq.json.tax.taxable_cents, bq.json.tax_cents, bq.json.amount_due_cents, bq.json.tax.location], [750, 250, 750, 53, 803, IN]);
  const bb = await c.post('/api/checkout', basket);
  assert.equal(bb.json.completed, true, bb.res.payload);
  const bo = await order(bb.json.order_id);
  assert.deepEqual([bo!.total_cents, bo!.tax_cents, bo!.taxable_cents, bo!.tax_state], [750, 53, 750, 'IN']);

  // 30 page credits at 5 cents: 150, tax 10.5 charged as 11
  const pq = await c.post('/api/checkout/quote', { items: [{ kind: 'credits', quantity: 30 }] });
  assert.deepEqual([pq.json.total_cents, pq.json.tax_cents, pq.json.amount_due_cents], [150, 11, 161]);
  const pb = await c.post('/api/checkout', { items: [{ kind: 'credits', quantity: 30 }] });
  assert.equal(pb.json.completed, true, pb.res.payload);
  assert.deepEqual([(await order(pb.json.order_id))!.tax_cents, (await one('select page_credits from wallets where user_id = $1', [user.id]))!.page_credits], [11, 30]);

  // a different location at the next checkout replaces the saved one
  const moved = await c.post('/api/checkout', { items: [{ kind: 'release', id: r3.id }], location: OH });
  assert.equal(moved.json.completed, true, moved.res.payload);
  assert.deepEqual([(await order(moved.json.order_id))!.tax_cents, (await order(moved.json.order_id))!.tax_state], [115, 'OH']); // 1999 x 5.75% = 114.94
  assert.deepEqual((await c.get('/api/billing-location')).json.location, OH);
});

test('a mixed basket: the tip and the gift card are not taxed', async () => {
  const { c } = await signedIn();
  const items = [{ kind: 'release', id: r1.id }, { kind: 'tip', id: brand.slug, amount_cents: 500 }, { kind: 'gift_card', amount_cents: 1000 }];
  const qt = await c.post('/api/checkout/quote', { items, location: IN });
  assert.deepEqual([qt.json.total_cents, qt.json.tax.taxable_cents, qt.json.tax_cents, qt.json.amount_due_cents], [1699, 199, 14, 1713]);
  assert.deepEqual(qt.json.lines.map((l: any) => [l.kind, l.price_cents, l.tax_cents]), [['release', 199, 14], ['tip', 500, 0], ['gift_card', 1000, 0]]);
  const buy = await c.post('/api/checkout', { items, location: IN });
  assert.equal(buy.json.completed, true, buy.res.payload);
  const o = await order(buy.json.order_id);
  assert.deepEqual([o!.total_cents, o!.taxable_cents, o!.tax_cents], [1699, 199, 14]);
  const lines = await q('select kind, price_cents, tax_cents from order_items where order_id = $1 order by id', [o!.id]);
  assert.deepEqual(lines.map((l) => [l.kind, l.tax_cents]), [['release', 14], ['tip', 0], ['gift_card', 0]]);
  assert.equal((await one('select amount_cents from gift_cards where order_id = $1', [o!.id]))!.amount_cents, 1000, 'the gift card is worth what was paid for it');
  // tips and gift cards alone: no tax and no location needed
  const { c: other } = await signedIn();
  const plain = await other.post('/api/checkout', { items: [{ kind: 'tip', id: brand.slug, amount_cents: 500 }, { kind: 'gift_card', amount_cents: 1000 }] });
  assert.equal(plain.json.completed, true, plain.res.payload);
  const po = await order(plain.json.order_id);
  assert.deepEqual([po!.total_cents, po!.tax_cents, po!.tax_state], [1500, 0, null]);
});

test('store credit pays, it does not reduce the tax: partly covered, fully covered, and credit that runs out before the tax', async () => {
  // partly: 199 + 14 tax = 213; 100 of credit, 113 on the card
  const a = await signedIn();
  await giveCredit(a.user.id, 100);
  const qa = await a.c.post('/api/checkout/quote', { items: [{ kind: 'release', id: r1.id }], location: IN, use_credit: true });
  assert.deepEqual([qa.json.total_cents, qa.json.tax_cents, qa.json.credit_applied_cents, qa.json.amount_due_cents], [199, 14, 100, 113]);
  const ba = await a.c.post('/api/checkout', { items: [{ kind: 'release', id: r1.id }], location: IN, use_credit: true });
  assert.equal(ba.json.completed, true, ba.res.payload);
  const oa = await order(ba.json.order_id);
  assert.deepEqual([oa!.total_cents, oa!.tax_cents, oa!.credit_cents, oa!.provider, pay.orderCharge(oa!), await wallet(a.user.id)], [199, 14, 100, 'sandbox', 113, 0]);
  assert.equal(oa!.fee_cents, 33, 'the fee estimate is on the pre-tax card amount (99), as it would be without tax');

  // fully: enough credit for the price and the tax; no card, tax still owed and recorded
  const b = await signedIn();
  await giveCredit(b.user.id, 5000);
  const qb = await b.c.post('/api/checkout/quote', { items: [{ kind: 'release', id: r1.id }], location: IN, use_credit: true });
  assert.deepEqual([qb.json.tax_cents, qb.json.credit_applied_cents, qb.json.amount_due_cents], [14, 213, 0]);
  const bb = await b.c.post('/api/checkout', { items: [{ kind: 'release', id: r1.id }], location: IN, use_credit: true });
  assert.equal(bb.json.completed, true, bb.res.payload);
  const ob = await order(bb.json.order_id);
  assert.deepEqual([ob!.total_cents, ob!.tax_cents, ob!.credit_cents, ob!.provider, ob!.fee_cents, pay.orderCharge(ob!), await wallet(b.user.id)], [199, 14, 213, 'credit', 0, 0, 4787]);

  // credit covers the price but not all of the tax: the rest of the tax goes to the card
  const c = await signedIn();
  await giveCredit(c.user.id, 2000);
  const qc = await c.c.post('/api/checkout/quote', { items: [{ kind: 'release', id: r3.id }], location: IN, use_credit: true });
  assert.deepEqual([qc.json.total_cents, qc.json.tax_cents, qc.json.credit_applied_cents, qc.json.amount_due_cents], [1999, 140, 2000, 139]);
  const bc = await c.c.post('/api/checkout', { items: [{ kind: 'release', id: r3.id }], location: IN, use_credit: true });
  assert.equal(bc.json.completed, true, bc.res.payload);
  const oc = await order(bc.json.order_id);
  assert.deepEqual([oc!.total_cents, oc!.tax_cents, oc!.credit_cents, oc!.provider, pay.orderCharge(oc!), await wallet(c.user.id)], [1999, 140, 2000, 'sandbox', 139, 0]);
  // the creators earn exactly what they earn on the same release bought entirely with credit and no tax
  await taxOff();
  const d = await signedIn();
  await giveCredit(d.user.id, 1999);
  const bd = await d.c.post('/api/checkout', { items: [{ kind: 'release', id: r3.id }], use_credit: true });
  await taxOn();
  assert.equal(bd.json.completed, true, bd.res.payload);
  assert.deepEqual(await ledger(oc!.id), await ledger(bd.json.order_id));
  assert.equal(oc!.fee_cents, (await order(bd.json.order_id))!.fee_cents);
});

test('quote = checkout = the amount the processor is asked for; creator earnings are the same with and without tax', async () => {
  await useProcessor();
  try {
    calls.length = 0;
    const basket = { items: [{ kind: 'release', id: r3.id }, { kind: 'tip', id: brand.slug, amount_cents: 500 }], location: IN };
    const taxed = await signedIn();
    const qt = await taxed.c.post('/api/checkout/quote', basket);
    assert.deepEqual([qt.json.total_cents, qt.json.tax_cents, qt.json.amount_due_cents], [2499, 140, 2639]);
    const co = await taxed.c.post('/api/checkout', basket);
    assert.equal(co.status, 200, co.res.payload);
    assert.equal(co.json.amount_cents, qt.json.amount_due_cents);
    const sent = of('create-checkout-session');
    assert.equal(sent.length, 1);
    assert.deepEqual([sent[0].body.amount, sent[0].body.pledgeId], [2639, co.json.order_id], 'pre-tax total + tax, no credit');
    await pay.handleDivinityEvent({ event: 'payment.succeeded', data: { pledgeId: co.json.order_id, paymentIntentId: `pi_${co.json.order_id}` } });
    const o = await order(co.json.order_id);
    assert.deepEqual([o!.status, o!.total_cents, o!.tax_cents, pay.orderCharge(o!)], ['paid', 2499, 140, 2639]);

    // the same basket with sales tax off
    await taxOff();
    calls.length = 0;
    const plain = await signedIn();
    const pc = await plain.c.post('/api/checkout', basket);
    assert.equal(pc.json.amount_cents, 2499);
    assert.equal(of('create-checkout-session')[0].body.amount, 2499);
    await pay.handleDivinityEvent({ event: 'payment.succeeded', data: { pledgeId: pc.json.order_id, paymentIntentId: `pi_${pc.json.order_id}` } });
    const p = await order(pc.json.order_id);
    assert.equal(p!.status, 'paid');

    // every ledger row, the fee and each line's creator amount are identical
    const rows = await ledger(o!.id);
    assert.ok(rows.length >= 3, 'owner sale, split payee sale, tip');
    assert.deepEqual(rows, await ledger(p!.id));
    assert.equal(o!.fee_cents, p!.fee_cents);
    const creator = (id: string) => q('select kind, price_cents, creator_cents from order_items where order_id = $1 order by id', [id]);
    assert.deepEqual(await creator(o!.id), await creator(p!.id));
    // and the tax is in nobody's share: creators + fee never exceed the pre-tax total
    assert.ok(rows.reduce((n, r) => n + r.amount_cents, 0) + o!.fee_cents <= 2499);
  } finally {
    await taxOn();
    await useSandbox();
  }
});

const lapse = (userId: string) => exec(`update subscriptions set current_period_end = now() - interval '1 minute', current_period_start = now() - interval '1 month' where user_id = $1 and status = 'active'`, [userId]);
const charges = (userId: string) => q('select * from subscription_charges where user_id = $1 order by created_at, id', [userId]);

test('membership: the first charge and each renewal are taxed at the saved state; a change of state applies from the next renewal', async () => {
  const { user, c } = await signedIn();
  const none = await c.post('/api/membership/start', { plan: 'monthly' });
  assert.deepEqual([none.status, none.json.code], [400, 'location_required']);
  assert.equal((await c.post('/api/membership/start', { plan: 'monthly', location: { country: 'US', state: 'IN', zip: '1' } })).json.code, 'location_invalid');

  // what the plans cost here, before anything is saved
  const qt = (await c.post('/api/membership/quote', { location: IN })).json;
  assert.deepEqual([qt.tax.monthly.price_cents, qt.tax.monthly.tax_cents, qt.tax.monthly.total_cents, qt.tax.monthly.label], [599, 42, 641, 'Sales tax (Indiana 7%)']); // 41.93
  assert.deepEqual([qt.tax.annual.price_cents, qt.tax.annual.tax_cents, qt.tax.annual.total_cents], [5900, 413, 6313]);
  assert.equal(qt.tax.location, null, 'nothing saved yet');
  assert.equal((await c.post('/api/membership/quote', {})).json.tax.monthly.needs_location, true);

  const start = await c.post('/api/membership/start', { plan: 'monthly', location: IN });
  assert.equal(start.json.completed, true, start.res.payload);
  let rows = await charges(user.id);
  assert.deepEqual(rows.map((r) => [r.status, r.amount_cents, r.tax_cents, r.taxable_cents, r.tax_state, r.tax_zip, r.tax_rate_bps, pay.chargeTotal(r)]), [['paid', 599, 42, 599, 'IN', '46204', 700, 641]]);
  assert.deepEqual([start.json.subscription.price_cents, start.json.subscription.last_charge.amount_cents, start.json.subscription.last_charge.tax_cents, start.json.subscription.last_charge.total_cents, start.json.subscription.last_charge.tax_label],
    [599, 599, 42, 641, 'Sales tax (Indiana 7%)']);
  assert.deepEqual([start.json.tax.location, start.json.tax.monthly.total_cents], [IN, 641]);
  // the membership pool and the fee are worked out on the plan price, not on price + tax
  const pot = await one('select gross_cents, fee_cents from sub_months where user_id = $1', [user.id]);
  assert.deepEqual([pot!.gross_cents, pot!.fee_cents, rows[0].fee_cents], [599, 47, 47]);
  const welcome = await one(`select html from emails where template = 'membership_started' and user_id = $1`, [user.id]);
  assert.match(welcome!.html, /You were charged \$6\.41: \$5\.99 for the membership plus \$0\.42 sales tax \(Indiana 7%\)\./);

  // renewal at the saved state, with the processor asked for price + tax
  await useProcessor();
  try {
    await exec(`update subscriptions set provider = 'divinity', payment_method_token = 'pm_tax_test' where user_id = $1`, [user.id]);
    calls.length = 0;
    await lapse(user.id);
    await runMembershipCycle();
    rows = await charges(user.id);
    assert.deepEqual(rows.map((r) => [r.status, r.amount_cents, r.tax_cents, r.tax_state]), [['paid', 599, 42, 'IN'], ['paid', 599, 42, 'IN']]);
    assert.deepEqual(of('charge-saved-payment-method').map((x) => [x.body.amount, x.body.pledgeId]), [[641, rows[1].id]]);
    const renewal = await one(`select subject, html from emails where template = 'membership_billing' and user_id = $1 order by created_at desc limit 1`, [user.id]);
    assert.match(renewal!.subject, /membership renewed/);
    assert.match(renewal!.html, /\$6\.41: \$5\.99 for the membership plus \$0\.42 sales tax \(Indiana 7%\)/);

    // the member moves to Ohio (5.75%): 599 x 5.75% = 34.44
    assert.equal((await c.put('/api/billing-location', { country: 'US', state: 'OH', zip: '4321' })).status, 400);
    const moved = await c.put('/api/billing-location', OH);
    assert.equal(moved.status, 200, moved.res.payload);
    assert.deepEqual([moved.json.location, moved.json.tax.monthly.tax_cents, moved.json.tax.monthly.label], [OH, 34, 'Sales tax (Ohio 5.75%)']);
    calls.length = 0;
    await lapse(user.id);
    await runMembershipCycle();
    rows = await charges(user.id);
    assert.deepEqual([rows[2].status, rows[2].amount_cents, rows[2].tax_cents, rows[2].tax_state, rows[2].tax_rate_bps], ['paid', 599, 34, 'OH', 575]);
    assert.equal(of('charge-saved-payment-method')[0].body.amount, 633);

    // then abroad: no tax, and no renewal receipt is needed for it
    await c.put('/api/billing-location', { country: 'FR' });
    calls.length = 0;
    await lapse(user.id);
    await runMembershipCycle();
    rows = await charges(user.id);
    assert.deepEqual([rows[3].status, rows[3].tax_cents, rows[3].tax_country, rows[3].tax_state], ['paid', 0, 'FR', null]);
    assert.equal(of('charge-saved-payment-method')[0].body.amount, 599);
    const view = (await c.get('/api/membership')).json;
    assert.deepEqual([view.subscription.last_charge.total_cents, view.subscription.last_charge.tax_label], [599, null]);
    const listed = (await c.get('/api/account/membership-payments')).json.items;
    assert.deepEqual(listed.map((x: any) => [x.amount_cents, x.tax_cents, x.total_cents, x.tax_label]).reverse(),
      [[599, 42, 641, 'Sales tax (Indiana 7%)'], [599, 42, 641, 'Sales tax (Indiana 7%)'], [599, 34, 633, 'Sales tax (Ohio 5.75%)'], [599, 0, 599, null]]);

    // refunding a taxed membership charge sends back price + tax and records the tax as refunded
    calls.length = 0;
    assert.deepEqual(await pay.refundCharge(rows[1].id, 'Asked for a refund'), { refunded: true });
    assert.equal(of('refund')[0].body.amount, 641);
    const back = await one('select status, tax_cents, tax_refunded_cents from subscription_charges where id = $1', [rows[1].id]);
    assert.deepEqual([back!.status, back!.tax_refunded_cents], ['refunded', 42]);
    assert.deepEqual(await q('select state, tax_cents from sales_tax_refunds where charge_id = $1', [rows[1].id]), [{ state: 'IN', tax_cents: 42 }]);
  } finally {
    await useSandbox();
  }

  // a member with no saved location (joined before the feature was on) is not taxed at renewal
  await taxOff();
  const old = await signedIn();
  assert.equal((await old.c.post('/api/membership/start', { plan: 'annual' })).json.completed, true);
  await taxOn();
  await lapse(old.user.id);
  await runMembershipCycle();
  assert.deepEqual((await charges(old.user.id)).map((r) => [r.status, r.amount_cents, r.tax_cents, r.tax_state]), [['paid', 5900, 0, null], ['paid', 5900, 0, null]]);
});

test('a buyer outside the United States pays no tax', async () => {
  const { user, c } = await signedIn();
  // "CA" as a country is Canada, not California
  const canada = { country: 'CA' };
  const qt = await c.post('/api/checkout/quote', { items: [{ kind: 'release', id: r3.id }], location: canada });
  assert.deepEqual([qt.json.tax.location, qt.json.tax.rate_bps, qt.json.tax_cents, qt.json.tax.label, qt.json.amount_due_cents, qt.json.problem], [{ country: 'CA', state: null, zip: null }, 0, 0, null, 1999, null]);
  const buy = await c.post('/api/checkout', { items: [{ kind: 'release', id: r3.id }], location: canada });
  assert.equal(buy.json.completed, true, buy.res.payload);
  const o = await order(buy.json.order_id);
  assert.deepEqual([o!.total_cents, o!.tax_cents, o!.tax_country, o!.tax_state, o!.tax_zip], [1999, 0, 'CA', null, null]);
  assert.deepEqual((await one('select billing_country, billing_state, billing_zip from users where id = $1', [user.id])), { billing_country: 'CA', billing_state: null, billing_zip: null });
});

test('an invalid state or ZIP is refused before anything is priced or charged', async () => {
  const { user, c } = await signedIn();
  const items = [{ kind: 'release', id: r1.id }];
  for (const [location, why] of [
    [{ country: 'US', state: 'ZZ', zip: '46204' }, /Choose your state/], [{ country: 'US', state: 'IN' }, /5-digit ZIP/], [{ country: 'US', state: 'IN', zip: '4620A' }, /5-digit ZIP/],
    [{ country: 'US', state: 'IN', zip: '462041234' }, /5-digit ZIP/], [{ country: 'US', state: 'IN', zip: '90210' }, /not in Indiana/], [{ country: 'Narnia' }, /Choose your country/], [{ state: 'IN', zip: '46204' }, /Choose your country/],
  ] as const) {
    for (const path of ['/api/checkout/quote', '/api/checkout']) {
      const r = await c.post(path, { items, location });
      assert.deepEqual([r.status, r.json.code], [400, 'location_invalid'], `${path} ${JSON.stringify(location)}`);
      assert.match(r.json.error, why);
    }
  }
  assert.equal((await one<{ n: number }>('select count(*)::int as n from orders where user_id = $1', [user.id]))!.n, 0);
  assert.equal((await c.put('/api/billing-location', { country: 'US', state: 'IN', zip: '90210' })).json.code, 'location_invalid');
  assert.equal((await new Client().get('/api/billing-location')).status, 401);
});

test('refunds: a full refund returns all the tax; partial refunds return the same proportion and never more than was collected', async () => {
  // full refund of a sandbox order partly paid with credit: the credit and the tax both come back
  const a = await signedIn();
  await giveCredit(a.user.id, 100);
  const ba = await a.c.post('/api/checkout', { items: [{ kind: 'release', id: r1.id }], location: IN, use_credit: true });
  assert.deepEqual(await pay.refundOrder(ba.json.order_id, { reason: 'Changed my mind' }), { refunded: true });
  const oa = await order(ba.json.order_id);
  assert.deepEqual([oa!.status, oa!.tax_cents, oa!.tax_refunded_cents, await wallet(a.user.id)], ['refunded', 14, 14, 100]);
  assert.deepEqual(await q('select state, tax_cents from sales_tax_refunds where order_id = $1', [oa!.id]), [{ state: 'IN', tax_cents: 14 }]);
  const va = (await a.c.get(`/api/orders/${oa!.id}`)).json.order;
  assert.deepEqual([va.refunded_cents, va.tax_refunded_cents], [113, 14], 'what the card paid, tax included, went back');

  // partial refunds reported by the processor on a 1999 + 140 order
  await useProcessor();
  try {
    calls.length = 0;
    const b = await signedIn();
    const co = await b.c.post('/api/checkout', { items: [{ kind: 'release', id: r3.id }], location: IN });
    const id = co.json.order_id;
    await pay.handleDivinityEvent({ event: 'payment.succeeded', data: { pledgeId: id, paymentIntentId: `pi_${id}` } });
    const paid = await order(id);
    const earned = (await ledger(id)).reduce((n, r) => n + r.amount_cents, 0);
    const refundEvent = (amount: number, refundId: string) => pay.handleDivinityEvent({ event: 'refund.completed', data: { pledgeId: id, amount, partial: true, refundId, reason: 'Damaged pages' } });

    // 1000 of 2139 back: 65 of it is tax (65.45), 935 is price
    await refundEvent(1000, 're_tax_1');
    let o = await order(id);
    assert.deepEqual([o!.status, o!.refunded_cents, o!.tax_refunded_cents], ['paid', 1000, 65]);
    const first = refundParts({ total_cents: 1999, fee_cents: paid!.fee_cents, creator_cents: earned }, 935);
    const reversed = async () => -(await one<{ n: number }>(`select coalesce(sum(amount_cents),0)::int as n from ledger where order_id = $1 and kind = 'refund'`, [id]))!.n;
    assert.equal(await reversed(), first.creator_cents, 'creators give back their share of the 935, not of the 1000');
    assert.deepEqual(o!.meta.partial_refunds.map((r: any) => [r.amount_cents, r.tax_cents, r.tax_cents + r.creator_cents + r.platform_cents + r.fee_cents]), [[1000, 65, 1000]]);
    // delivered twice: applied once
    await refundEvent(1000, 're_tax_1');
    assert.equal((await order(id))!.tax_refunded_cents, 65);

    // 500 more: running 1500 -> 98 of tax (98.18), so 33 this time
    await refundEvent(500, 're_tax_2');
    o = await order(id);
    assert.deepEqual([o!.refunded_cents, o!.tax_refunded_cents, o!.meta.partial_refunds[1].tax_cents], [1500, 98, 33]);
    assert.equal(await reversed(), refundParts({ total_cents: 1999, fee_cents: paid!.fee_cents, creator_cents: earned }, 1402).creator_cents);
    assert.deepEqual((await q('select tax_cents from sales_tax_refunds where order_id = $1 order by created_at, id', [id])).map((r) => r.tax_cents), [65, 33]);
    assert.equal((await b.c.get(`/api/orders/${id}`)).json.order.tax_refunded_cents, 98);

    // the rest, through the admin refund: the processor is asked for what is left of price + tax, and the last 42 of tax goes back
    calls.length = 0;
    await pay.refundOrder(id, { reason: 'Refund the rest' });
    assert.equal(of('refund')[0].body.amount, 639);
    o = await order(id);
    assert.deepEqual([o!.status, o!.tax_refunded_cents], ['refunded', 140]);
    const back = await q<{ tax_cents: number }>('select tax_cents from sales_tax_refunds where order_id = $1 order by created_at, id', [id]);
    assert.deepEqual(back.map((r) => r.tax_cents), [65, 33, 42]);
    assert.equal(back.reduce((n, r) => n + r.tax_cents, 0), 140, 'exactly the tax collected, never more');
    assert.equal((await ledger(id)).reduce((n, r) => n + r.amount_cents, 0), 0, 'creator earnings net to zero');
    // refunding again changes nothing
    assert.deepEqual(await pay.refundOrder(id, {}), { refunded: false });
    assert.equal((await q('select 1 from sales_tax_refunds where order_id = $1', [id])).length, 3);

    // a partial refund that reaches the whole card charge is a full refund
    const c2 = await signedIn();
    const co2 = await c2.c.post('/api/checkout', { items: [{ kind: 'release', id: r1.id }], location: IN });
    await pay.handleDivinityEvent({ event: 'payment.succeeded', data: { pledgeId: co2.json.order_id, paymentIntentId: `pi_${co2.json.order_id}` } });
    await pay.handleDivinityEvent({ event: 'refund.completed', data: { pledgeId: co2.json.order_id, amount: 213, partial: true, refundId: 're_tax_all' } });
    const o2 = await order(co2.json.order_id);
    assert.deepEqual([o2!.status, o2!.tax_refunded_cents], ['refunded', 14]);
  } finally {
    await useSandbox();
  }
});

test('admin: the sales tax report by state with totals and CSV, tax on the order detail, and revenue figures that leave tax out', async () => {
  const admin = await signedIn({ role: 'admin' });
  assert.equal((await (await signedIn()).c.get('/api/admin/sales-tax')).status, 403);

  // Wyoming (4%) is used by this test only: 1000 -> 40, 1999 -> 79.96 = 80, and a page-credit pack 150 -> 6
  const WY = { country: 'US', state: 'WY', zip: '82001' };
  const one_ = await signedIn();
  const two = await signedIn();
  const o1 = (await one_.c.post('/api/checkout', { items: [{ kind: 'release', id: r2.id }, { kind: 'tip', id: brand.slug, amount_cents: 500 }], location: WY })).json.order_id;
  const o2 = (await two.c.post('/api/checkout', { items: [{ kind: 'release', id: r3.id }], location: WY })).json.order_id;
  const o3 = (await two.c.post('/api/checkout', { items: [{ kind: 'credits', quantity: 30 }] })).json.order_id;
  assert.deepEqual([(await order(o1))!.tax_cents, (await order(o2))!.tax_cents, (await order(o3))!.tax_cents], [40, 80, 6]);
  await pay.refundOrder(o1, { reason: 'Report test' });

  const today = new Date().toISOString().slice(0, 10);
  const rep = await admin.c.get(`/api/admin/sales-tax?from=${today}&to=${today}`);
  assert.equal(rep.status, 200, rep.res.payload);
  const wy = rep.json.states.find((s: any) => s.state === 'WY');
  assert.deepEqual(wy, { state: 'WY', state_name: 'Wyoming', rate_bps: 400, taxable_cents: 3149, tax_collected_cents: 126, tax_refunded_cents: 40, net_tax_cents: 86, orders: 3 });

  // every state agrees with the rows themselves, and the totals are the sum of the states
  const direct = await q(
    `select state, sum(taxable)::int as taxable, sum(tax)::int as tax, count(*)::int as n from (
       select tax_state as state, taxable_cents as taxable, tax_cents as tax from orders where tax_state is not null and status in ('paid','refunded')
       union all select tax_state, taxable_cents, tax_cents from subscription_charges where tax_state is not null and status in ('paid','refunded')) x group by state order by state`,
  );
  const refunded = new Map((await q('select state, sum(tax_cents)::int as cents from sales_tax_refunds group by state')).map((r) => [r.state, r.cents]));
  assert.deepEqual(
    rep.json.states.map((s: any) => [s.state, s.taxable_cents, s.tax_collected_cents, s.tax_refunded_cents, s.net_tax_cents, s.orders]).sort(),
    direct.map((d) => [d.state, d.taxable, d.tax, refunded.get(d.state) ?? 0, d.tax - (refunded.get(d.state) ?? 0), d.n]).sort(),
  );
  for (const k of ['taxable_cents', 'tax_collected_cents', 'tax_refunded_cents', 'net_tax_cents', 'orders']) assert.equal(rep.json.totals[k], rep.json.states.reduce((n: number, s: any) => n + s[k], 0), k);
  assert.ok(rep.json.states.some((s: any) => s.state === 'IN' && s.tax_collected_cents > 0 && s.tax_refunded_cents > 0), 'Indiana sales and refunds from the tests above, memberships included');
  assert.ok(rep.json.states.some((s: any) => s.state === 'CA' && s.tax_collected_cents === 0 && s.taxable_cents === 199), 'a state at 0% still shows its sales');
  assert.equal(rep.json.totals.net_tax_cents, rep.json.totals.tax_collected_cents - rep.json.totals.tax_refunded_cents);

  const csv = await admin.c.get(`/api/admin/sales-tax?from=${today}&to=${today}&format=csv`);
  assert.equal(csv.status, 200);
  assert.match(String(csv.res.headers['content-type']), /text\/csv/);
  assert.match(String(csv.res.headers['content-disposition']), new RegExp(`sales-tax-${today}-to-${today}\\.csv`));
  const lines = csv.res.payload.trim().split('\r\n');
  assert.equal(lines[0], 'state,state_name,taxable_sales,tax_collected,tax_refunded,net_tax,orders');
  assert.ok(lines.includes('WY,Wyoming,31.49,1.26,0.40,0.86,3'));
  const cents = (n: number) => (n / 100).toFixed(2);
  assert.equal(lines.at(-1), `TOTAL,All states,${cents(rep.json.totals.taxable_cents)},${cents(rep.json.totals.tax_collected_cents)},${cents(rep.json.totals.tax_refunded_cents)},${cents(rep.json.totals.net_tax_cents)},${rep.json.totals.orders}`);
  assert.equal(lines.length, rep.json.states.length + 2);

  // the default range is the last full calendar month: nothing from today is in it
  const dflt = (await admin.c.get('/api/admin/sales-tax')).json;
  const now = new Date();
  assert.deepEqual([dflt.from, dflt.to], [new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1)).toISOString().slice(0, 10), new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 0)).toISOString().slice(0, 10)]);
  assert.deepEqual([dflt.states, dflt.totals.tax_collected_cents], [[], 0]);
  assert.equal((await admin.c.get('/api/admin/sales-tax?from=2026-02-01&to=2026-01-01')).status, 400);
  assert.equal((await admin.c.get('/api/admin/sales-tax?from=yesterday')).status, 400);

  // the dashboard's revenue figures are the pre-tax amounts: tax collected is in none of them
  const dash = (await admin.c.get('/api/admin/dashboard')).json.totals;
  const sums = await one(
    `select (select sum(total_cents) from orders where status in ('paid','refunded'))::int as sales, (select sum(tax_cents) from orders where status in ('paid','refunded'))::int as order_tax,
            (select sum(amount_cents) from subscription_charges where status in ('paid','refunded'))::int as membership, (select sum(tax_cents) from subscription_charges where status in ('paid','refunded'))::int as charge_tax`,
  );
  assert.ok(sums!.order_tax > 0 && sums!.charge_tax > 0);
  assert.deepEqual([dash.sales_cents, dash.membership_cents, dash.gross_cents], [sums!.sales, sums!.membership, sums!.sales + sums!.membership]);

  // order detail: tax shown apart from the pre-tax total
  const detail = (await admin.c.get(`/api/admin/orders/${o2}`)).json;
  assert.deepEqual([detail.order.total_cents, detail.tax.tax_cents, detail.tax.label, detail.tax.state_name, detail.tax.zip, detail.tax.taxable_cents, detail.tax.charged_cents, detail.items[0].tax_cents],
    [1999, 80, 'Sales tax (Wyoming 4%)', 'Wyoming', '82001', 1999, 2079, 80]);
  const list = (await admin.c.get(`/api/admin/orders?user_id=${two.user.id}`)).json;
  assert.deepEqual([list.paid_cents, list.items.map((i: any) => i.tax_cents).sort((x: number, y: number) => x - y)], [2149, [6, 80]], 'paid_cents is pre-tax');
  // refunding as store credit hands back what the card paid, tax included
  const three = await signedIn();
  const o4 = (await three.c.post('/api/checkout', { items: [{ kind: 'release', id: r2.id }], location: WY })).json.order_id;
  const rf = await admin.c.post(`/api/admin/orders/${o4}/refund`, { reason: 'Store credit instead', to_wallet: true });
  assert.equal(rf.status, 200, rf.res.payload);
  assert.deepEqual([await wallet(three.user.id), (await order(o4))!.tax_refunded_cents], [1040, 40]);
});
