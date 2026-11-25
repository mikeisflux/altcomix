import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';
import { fixtures, useTestDatabase } from '../lib/commerce.testkit.ts';

/**
 * Creator Premium end to end through the HTTP stack: the two gates (print
 * edition link, advanced analytics), subscribing, sales tax, renewals,
 * declines, cancel and resume, complimentary grants, the admin views and
 * refund, and that none of it touches reader-membership money. Card payments
 * go to the sandbox provider or to a local stand-in for the processor's
 * partner API (never a live processor).
 */
await useTestDatabase('premium');
process.env.ROUTES = 'auth,account,catalog,reader,commerce,studio-releases,studio-analytics,studio-premium,admin-finance,admin-dashboard,admin-settings,admin-brands';
const { exec, one, q, pool } = await import('../db.ts');
const { setSetting, publicSettings } = await import('../lib/settings.ts');
const pay = await import('../lib/payments.ts');
const { brandHasPremium, invalidatePremium } = await import('../lib/premium.ts');
const { hasMembership } = await import('../lib/access.ts');
const { runMembershipCycle } = await import('../jobs/memberships.ts');
const { buildApp } = await import('../server.ts');
const f = await fixtures();
const app = await buildApp();

let clients = 0;
class Client {
  cookies: Record<string, string> = {};
  address = `203.0.113.${(clients++ % 250) + 1}`;
  async call(method: string, url: string, body?: unknown) {
    const cookie = Object.entries(this.cookies).map(([k, v]) => `${k}=${v}`).join('; ');
    const res = await app.inject({
      method: method as 'GET', url, remoteAddress: this.address,
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

// A stand-in for the processor: remembers what it was asked to charge, can decline, and plays hosted setup sessions.
type Call = { action: string; body: Record<string, any> };
const calls: Call[] = [];
let decline = false;
const sessions = new Map<string, Record<string, unknown>>();
const fake = createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    const action = new URL(req.url!, 'http://x').searchParams.get('action') ?? '';
    const b = raw ? JSON.parse(raw) : {};
    calls.push({ action, body: b });
    let status = 200;
    let out: unknown = { success: true };
    if (action === 'create-checkout-session') {
      const id = `cs_prem_${Date.now().toString(36)}_${calls.length}`;
      sessions.set(id, { sessionId: id, status: 'pending', mode: b.mode, paymentMethodId: null });
      out = { success: true, sessionId: id, checkoutUrl: `https://pay.example/checkout/${id}` };
    } else if (action === 'get-checkout-session') {
      out = { success: true, session: sessions.get(b.sessionId) };
    } else if (action === 'charge-saved-payment-method') {
      if (decline) {
        status = 402;
        out = { success: false, error: 'Your card was declined by Divinity', declineCode: 'card_declined', paymentIntentId: `pi_${b.pledgeId}_${b.idempotencyKey}` };
      } else out = { success: true, status: 'succeeded', paymentIntentId: `pi_${b.pledgeId}_${b.idempotencyKey}`, amount: b.amount };
    } else if (action === 'refund') out = { success: true, refundId: `re_${calls.length}`, amount: b.amount, status: 'succeeded' };
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(out));
  });
});
const of = (action: string) => calls.filter((c) => c.action === action);
const useSandbox = () => setSetting('payments', { provider: 'sandbox' }, null);
const useProcessor = () =>
  setSetting('payments', { provider: 'divinity', divinity_api_url: `http://127.0.0.1:${(fake.address() as AddressInfo).port}/internal`, divinity_partner_id: 'partner_prem', divinity_api_key: 'dc_prem_testkey' }, null);
const RATES = { IN: 700, OH: 575 };
const taxOn = () => setSetting('tax', { enabled: true, rates: RATES }, null);
const taxOff = () => setSetting('tax', { enabled: false, rates: RATES }, null);
const IN = { country: 'US', state: 'IN', zip: '46204' };
const OH = { country: 'US', state: 'OH', zip: '43215' };
const LINK = 'https://print.example/issue-1';

/** A brand with an owner, one public free series and one published release that already has a saved print link. */
async function studio(link: string | null = LINK) {
  const { user, c } = await signedIn();
  const brand = await f.brand(user.id);
  const series = await f.series(brand.id, { access_model: 'free' });
  const release = await f.release(series.id, { number: 1 }, 3);
  if (link) await exec('update releases set print_url = $2 where id = $1', [release.id, link]);
  return { user, c, brand, series, release };
}
const member = async (brandId: string, role: string) => {
  const m = await signedIn();
  await exec('insert into publisher_members (publisher_id, user_id, role) values ($1,$2,$3)', [brandId, m.user.id, role]);
  return m;
};
const plan = (brandId: string) => one(`select * from premium_subscriptions where publisher_id = $1 and status <> 'pending' order by created_at desc limit 1`, [brandId]);
const charges = (brandId: string) =>
  q(`select pc.* from premium_charges pc join premium_subscriptions ps on ps.id = pc.subscription_id where ps.publisher_id = $1 order by pc.created_at, pc.id`, [brandId]);
/** The paid year is over: move the plan's period into the past, as if a year had gone by. */
const yearPasses = async (brandId: string) => {
  await exec(
    `update premium_subscriptions set current_period_start = current_period_start - interval '1 year' - interval '1 minute', current_period_end = now() - interval '1 minute'
      where publisher_id = $1 and status in ('active','past_due')`,
    [brandId],
  );
  invalidatePremium();
};
const anon = new Client();
/** What a signed-out reader is given for the release's print link: on the series page (twice) and in the reader. */
async function publicLinks(s: { series: any; release: any }) {
  const page = (await anon.get(`/api/series/${s.series.slug}`)).json;
  const rel = page.release_groups.flatMap((g: any) => g.releases).find((r: any) => r.id === s.release.id);
  const read = (await anon.get(`/api/releases/${s.release.id}`)).json;
  return [rel.print_url, page.print_links.map((l: any) => l.url), read.release.print_url];
}
const PREMIUM_REPORTS = (s: { brand: any; release: any }) => [
  `/api/studio/brands/${s.brand.id}/analytics/releases/${s.release.id}/dropoff`,
  `/api/studio/brands/${s.brand.id}/analytics/countries`,
  `/api/studio/brands/${s.brand.id}/analytics/followers`,
  `/api/studio/brands/${s.brand.id}/analytics/engagement`,
  `/api/studio/brands/${s.brand.id}/analytics/emails`,
];
const FREE_REPORTS = (s: { brand: any }) => [
  `/api/studio/brands/${s.brand.id}/analytics/dashboard`,
  `/api/studio/brands/${s.brand.id}/analytics/page-reads`,
  `/api/studio/brands/${s.brand.id}/analytics/page-reads?group=release`,
  `/api/studio/brands/${s.brand.id}/analytics/revenue`,
];
const csvOf = (url: string) => `${url}${url.includes('?') ? '&' : '?'}format=csv`;
const today = () => new Date().toISOString().slice(0, 10);
const taxReport = async (admin: Client, state: string) => {
  const rep = (await admin.get(`/api/admin/sales-tax?from=${today()}&to=${today()}`)).json;
  return rep.states.find((x: any) => x.state === state) ?? { taxable_cents: 0, tax_collected_cents: 0, tax_refunded_cents: 0, net_tax_cents: 0, orders: 0 };
};
/** Everything reader-membership money lives in, plus the creator ledger: Premium must never move any of it. */
const readerMoney = async (admin: Client) => {
  const db = await one(
    `select (select count(*) from subscriptions)::int as subscriptions, (select count(*) from subscription_charges)::int as membership_charges,
            (select count(*) from sub_months)::int as pots, (select coalesce(sum(gross_cents),0) from sub_months)::int as pot_cents,
            (select count(*) from ledger)::int as ledger_rows, (select coalesce(sum(amount_cents),0) from ledger)::int as ledger_cents,
            (select count(*) from orders)::int as orders`,
  );
  const dash = (await admin.get('/api/admin/dashboard')).json.totals;
  const mem = (await admin.get('/api/admin/memberships')).json;
  return { db, sales_cents: dash.sales_cents, membership_cents: dash.membership_cents, creator_cents: dash.creator_cents, active_members: dash.active_members, mrr_cents: dash.mrr_cents, memberships: mem.summary, membership_rows: mem.total };
};

before(async () => {
  await new Promise<void>((r) => fake.listen(0, '127.0.0.1', r));
  await useSandbox();
  await taxOff();
  await setSetting('creator_premium', { name: 'Creator Premium', annual_cents: 14000 }, null);
  await setSetting('revenue', { fee_pct_bps: 290, fee_fixed_cents: 30 }, null);
  // Plans left by an earlier run would be renewed by the cycle under test.
  await exec(`update premium_charges set status = 'failed' where status = 'pending'`);
  await exec(`update premium_subscriptions set status = 'expired' where status in ('active','past_due','pending')`);
  await anon.get('/api/bootstrap');
});
after(async () => {
  await app.close();
  fake.close();
  await pool.end();
});

test('the price is an admin setting and is public', async () => {
  const pub = (await publicSettings()) as any;
  assert.deepEqual(pub.creator_premium, { name: 'Creator Premium', annual_cents: 14000 });
  const admin = await signedIn({ role: 'super_admin' });
  assert.equal((await admin.c.patch('/api/admin/settings', { section: 'creator_premium', data: { annual_cents: 0 } })).status, 400);
  assert.equal((await admin.c.patch('/api/admin/settings', { section: 'creator_premium', data: { annual_cents: 15000 } })).status, 200);
  assert.equal(((await publicSettings()) as any).creator_premium.annual_cents, 15000);
  assert.equal((await admin.c.patch('/api/admin/settings', { section: 'creator_premium', data: { annual_cents: 14000 } })).status, 200);
});

test('without Premium: the print link cannot be added or changed, a saved link is hidden from readers, premium analytics and every CSV are refused', async () => {
  const s = await studio();
  assert.equal(await brandHasPremium(s.brand.id), false);

  // adding or changing the link is refused with the code the web app looks for; nothing is saved
  const change = await s.c.patch(`/api/studio/releases/${s.release.id}`, { print_url: 'https://print.example/changed' });
  assert.deepEqual([change.status, change.json.code], [402, 'premium_required']);
  assert.match(change.json.error, /Creator Premium/);
  const create = await s.c.post(`/api/studio/series/${s.series.id}/releases`, { title: 'With a link', print_url: 'https://print.example/new' });
  assert.deepEqual([create.status, create.json.code], [402, 'premium_required']);
  const bulk = await s.c.put(`/api/studio/series/${s.series.id}/releases/bulk`, { releases: [{ id: s.release.id, title: 'Renamed', print_url: 'https://print.example/bulk' }] });
  assert.deepEqual([bulk.status, bulk.json.code], [402, 'premium_required']);
  let row = await one('select title, print_url from releases where id = $1', [s.release.id]);
  assert.deepEqual([row!.title, row!.print_url], ['Issue 1', LINK]);

  // everything else on the form still saves, also when the form sends the saved link back unchanged
  const other = await s.c.patch(`/api/studio/releases/${s.release.id}`, { title: 'Issue one', print_url: LINK });
  assert.equal(other.status, 200, other.res.payload);
  // the Studio still shows the saved link to the team; it is kept in the database
  assert.equal(other.json.release.print_url, LINK);
  assert.equal((await s.c.get(`/api/studio/releases/${s.release.id}`)).json.release.print_url, LINK);
  const sameBulk = await s.c.put(`/api/studio/series/${s.series.id}/releases/bulk`, { releases: [{ id: s.release.id, title: 'Issue 1', print_url: LINK }] });
  assert.equal(sameBulk.status, 200, sameBulk.res.payload);

  // hidden from readers everywhere it is public: the series page (per release and in print_links) and the reader
  assert.deepEqual(await publicLinks(s), [null, [], null]);
  // also for the signed-in owner on the public pages
  const mine = (await s.c.get(`/api/series/${s.series.slug}`)).json;
  assert.deepEqual([mine.release_groups[0].releases[0].print_url, mine.print_links], [null, []]);
  assert.equal((await s.c.get(`/api/releases/${s.release.id}`)).json.release.print_url, null);

  // analytics: the free views answer, the premium views and every CSV do not
  for (const url of FREE_REPORTS(s)) assert.equal((await s.c.get(url)).status, 200, url);
  for (const url of PREMIUM_REPORTS(s)) {
    const r = await s.c.get(url);
    assert.deepEqual([r.status, r.json.code], [402, 'premium_required'], url);
  }
  for (const url of [...FREE_REPORTS(s), ...PREMIUM_REPORTS(s)]) {
    const r = await s.c.get(csvOf(url));
    assert.deepEqual([r.status, r.json?.code], [402, 'premium_required'], csvOf(url));
  }
  // someone outside the brand learns nothing about its plan
  const stranger = await signedIn();
  assert.equal((await stranger.c.get(PREMIUM_REPORTS(s)[1])).status, 403);
  assert.equal((await stranger.c.get(`/api/studio/brands/${s.brand.id}/premium`)).status, 403);

  // a link can still be taken away without Premium
  const cleared = await s.c.patch(`/api/studio/releases/${s.release.id}`, { print_url: '' });
  assert.deepEqual([cleared.status, cleared.json.release.print_url], [200, null]);

  const view = (await s.c.get(`/api/studio/brands/${s.brand.id}/premium`)).json;
  assert.deepEqual([view.active, view.subscription, view.product, view.can_manage, view.can_pay, view.tax, view.charges], [false, null, { name: 'Creator Premium', annual_cents: 14000 }, true, true, null, []]);
});

test('only owners and admins of the brand can subscribe, cancel, resume or change the card; the rest of the team sees the status', async () => {
  const s = await studio();
  const editor = await member(s.brand.id, 'editor');
  const analyst = await member(s.brand.id, 'analyst');
  const base = `/api/studio/brands/${s.brand.id}/premium`;
  for (const who of [editor, analyst]) {
    for (const action of ['start', 'cancel', 'resume', 'payment-method', 'quote']) assert.equal((await who.c.post(`${base}/${action}`)).status, 403, action);
    const view = await who.c.get(base);
    assert.deepEqual([view.status, view.json.active, view.json.can_manage, view.json.can_pay, view.json.tax], [200, false, false, false, null]);
  }
  assert.equal(await brandHasPremium(s.brand.id), false);
  assert.equal((await new Client().get(base)).status, 401);

  // a platform admin looking at the brand's Studio sees the same closed gates and cannot pay for the brand
  const staff = await signedIn({ role: 'admin' });
  const seen = (await staff.c.get(base)).json;
  assert.deepEqual([seen.active, seen.can_manage, seen.can_pay], [false, true, false]);
  assert.equal((await staff.c.post(`${base}/start`)).status, 403);
  assert.deepEqual([(await staff.c.get(PREMIUM_REPORTS(s)[1])).status, (await staff.c.get(PREMIUM_REPORTS(s)[1])).json.code], [402, 'premium_required']);
  assert.equal((await staff.c.patch(`/api/studio/releases/${s.release.id}`, { print_url: 'https://print.example/staff' })).json.code, 'premium_required');

  // an unconfirmed email cannot subscribe
  const fresh = await signedIn({ verified: false });
  const fb = await f.brand(fresh.user.id);
  const refused = await fresh.c.post(`/api/studio/brands/${fb.id}/premium/start`);
  assert.deepEqual([refused.status, refused.json.code], [403, 'email_unverified']);

  // a brand admin can
  const admin = await member(s.brand.id, 'admin');
  const started = await admin.c.post(`${base}/start`);
  assert.deepEqual([started.status, started.json.completed, started.json.active], [200, true, true], started.res.payload);
  // and now the whole team has the features
  assert.equal((await analyst.c.get(PREMIUM_REPORTS(s)[1])).status, 200);
  assert.equal((await analyst.c.get(csvOf(FREE_REPORTS(s)[0]))).status, 200);
  assert.equal((await editor.c.patch(`/api/studio/releases/${s.release.id}`, { print_url: 'https://print.example/by-editor' })).status, 200);
  const status = (await analyst.c.get(base)).json;
  assert.deepEqual([status.active, status.subscription.status, status.subscription.paid_by_you, status.subscription.paid_by], [true, 'active', false, admin.user.display_name]);
});

test('subscribing (sandbox): 140.00 for a year, the link saves and shows publicly, premium analytics and CSV open; reader-membership money is untouched', async () => {
  const staff = await signedIn({ role: 'admin' });
  const s = await studio();
  const second = await f.brand(s.user.id);
  const secondSeries = await f.series(second.id, { access_model: 'free' });
  const secondRelease = await f.release(secondSeries.id, { number: 1 }, 2);
  await exec('update releases set print_url = $2 where id = $1', [secondRelease.id, 'https://print.example/second']);
  const before = await readerMoney(staff.c);
  const dashBefore = (await staff.c.get('/api/admin/dashboard')).json.totals;

  const started = await s.c.post(`/api/studio/brands/${s.brand.id}/premium/start`);
  assert.deepEqual([started.status, started.json.completed, started.json.active], [200, true, true], started.res.payload);
  assert.equal(await brandHasPremium(s.brand.id), true);
  const sub = started.json.subscription;
  assert.deepEqual([sub.status, started.json.grant, sub.price_cents, sub.cancel_at_period_end, sub.has_payment_method, sub.paid_by_you, sub.payment_problem], ['active', null, 14000, false, true, true, null]);
  // annual: the year ends one year from now, and that is when it renews
  const days = (Date.parse(sub.current_period_end) - Date.parse(sub.current_period_start)) / 86_400_000;
  assert.ok(days >= 365 && days <= 366, `period is ${days} days`);
  assert.equal(sub.renews_at, sub.current_period_end);
  const rows = await charges(s.brand.id);
  assert.deepEqual(rows.map((c) => [c.status, c.amount_cents, c.tax_cents, c.fee_cents, c.user_id]), [['paid', 14000, 0, 436, s.user.id]]);
  assert.deepEqual(started.json.charges.map((c: any) => [c.amount_cents, c.tax_cents, c.total_cents, c.tax_label, c.status]), [[14000, 0, 14000, null, 'paid']]);

  // the receipt names the product, the brand and the amount
  const mail = await one(`select subject, html from emails where template = 'premium_started' and user_id = $1`, [s.user.id]);
  assert.match(mail!.subject, new RegExp(`Your Creator Premium receipt for ${s.brand.name}`));
  assert.match(mail!.html, /Creator Premium for Brand [a-z0-9]+, 1 year/);
  assert.match(mail!.html, /Total: \$140\.00/);
  assert.doesNotMatch(mail!.html, /Sales tax/);

  // a second subscription for the same brand is refused
  const again = await s.c.post(`/api/studio/brands/${s.brand.id}/premium/start`);
  assert.equal(again.status, 409);
  assert.equal((await charges(s.brand.id)).length, 1);

  // gate (a): the saved link shows again, and a new one can be saved and shows
  assert.deepEqual(await publicLinks(s), [LINK, [LINK], LINK]);
  const changed = await s.c.patch(`/api/studio/releases/${s.release.id}`, { print_url: 'https://print.example/second-printing' });
  assert.equal(changed.status, 200, changed.res.payload);
  assert.deepEqual(await publicLinks(s), ['https://print.example/second-printing', ['https://print.example/second-printing'], 'https://print.example/second-printing']);
  const made = await s.c.post(`/api/studio/series/${s.series.id}/releases`, { title: 'Issue two', print_url: 'https://print.example/issue-2' });
  assert.deepEqual([made.status, made.json.release.print_url], [201, 'https://print.example/issue-2']);

  // gate (b): premium analytics and every CSV
  for (const url of [...FREE_REPORTS(s), ...PREMIUM_REPORTS(s)]) {
    assert.equal((await s.c.get(url)).status, 200, url);
    const csv = await s.c.get(csvOf(url));
    assert.equal(csv.status, 200, csvOf(url));
    assert.match(String(csv.res.headers['content-type']), /text\/csv/);
  }

  // Premium is per brand: the same owner's other brand is not covered
  assert.equal(await brandHasPremium(second.id), false);
  assert.equal((await s.c.get(`/api/studio/brands/${second.id}/premium`)).json.active, false);
  assert.equal((await s.c.get(`/api/studio/brands/${second.id}/analytics/countries`)).json.code, 'premium_required');
  assert.equal((await s.c.patch(`/api/studio/releases/${secondRelease.id}`, { print_url: 'https://print.example/other' })).json.code, 'premium_required');
  assert.deepEqual(await publicLinks({ series: secondSeries, release: secondRelease }), [null, [], null]);

  // none of it is reader-membership money: no membership, no pot, no ledger row, no order, same admin membership figures
  assert.deepEqual(await readerMoney(staff.c), before);
  assert.equal(await hasMembership(s.user.id), false);
  assert.equal((await s.c.get('/api/membership')).json.member, false);
  assert.equal((await one<{ n: number }>('select count(*)::int as n from ledger where publisher_id = $1', [s.brand.id]))!.n, 0);

  // the admin dashboard counts it as money in and as platform revenue, on its own line, before tax
  const dash = (await staff.c.get('/api/admin/dashboard')).json;
  assert.equal(dash.totals.premium_cents - dashBefore.premium_cents, 14000);
  assert.equal(dash.totals.gross_cents - dashBefore.gross_cents, 14000);
  assert.equal(dash.totals.fee_cents - dashBefore.fee_cents, 436);
  assert.equal(dash.totals.platform_cents - dashBefore.platform_cents, 14000 - 436);
  assert.equal(dash.totals.premium_brands - dashBefore.premium_brands, 1);
  assert.ok(dash.series.premium_cents.at(-1) >= 14000);
  assert.equal(dash.series.days.length, dash.series.premium_cents.length);
});

test('sales tax: 7% in the payer\'s state makes the charge 14000 + 980, the report shows it, and renewals are taxed at the saved state', async () => {
  const staff = await signedIn({ role: 'admin' });
  await taxOn();
  try {
    const s = await studio();
    const base = `/api/studio/brands/${s.brand.id}/premium`;
    const reportBefore = await taxReport(staff.c, 'IN');
    const ohBefore = await taxReport(staff.c, 'OH');
    const moneyBefore = await readerMoney(staff.c);

    // the page shows the price before tax until there is a location, then the quote for it
    let view = (await s.c.get(base)).json;
    assert.deepEqual([view.tax.enabled, view.tax.location, view.tax.annual.needs_location, view.tax.annual.total_cents], [true, null, true, 14000]);
    const quote = (await s.c.post(`${base}/quote`, { location: IN })).json;
    assert.deepEqual([quote.tax.annual.price_cents, quote.tax.annual.tax_cents, quote.tax.annual.total_cents, quote.tax.annual.label], [14000, 980, 14980, 'Sales tax (Indiana 7%)']);
    // subscribing needs a billing location while sales tax is on
    const none = await s.c.post(`${base}/start`);
    assert.deepEqual([none.status, none.json.code], [400, 'location_required']);

    const started = await s.c.post(`${base}/start`, { location: IN });
    assert.deepEqual([started.status, started.json.completed, started.json.active], [200, true, true], started.res.payload);
    let rows = await charges(s.brand.id);
    assert.deepEqual(rows.map((c) => [c.status, c.amount_cents, c.tax_cents, c.taxable_cents, c.tax_state, c.tax_zip, c.tax_rate_bps, c.fee_cents]), [['paid', 14000, 980, 14000, 'IN', '46204', 700, 436]]);
    assert.deepEqual(started.json.charges.map((c: any) => [c.amount_cents, c.tax_cents, c.total_cents, c.tax_label]), [[14000, 980, 14980, 'Sales tax (Indiana 7%)']]);
    const receipt = await one(`select html from emails where template = 'premium_started' and user_id = $1`, [s.user.id]);
    assert.match(receipt!.html, /Sales tax \(Indiana 7%\)<\/td><td align="right">\$9\.80/);
    assert.match(receipt!.html, /Total: \$149\.80/);

    // the sales tax report has it, in Indiana
    let rep = await taxReport(staff.c, 'IN');
    assert.deepEqual([rep.taxable_cents - reportBefore.taxable_cents, rep.tax_collected_cents - reportBefore.tax_collected_cents, rep.orders - reportBefore.orders], [14000, 980, 1]);

    // a year later it renews on the saved card: the processor is asked for price + tax at the saved state
    await useProcessor();
    await exec(`update premium_subscriptions set provider = 'divinity', payment_method_token = 'pm_prem_test' where publisher_id = $1`, [s.brand.id]);
    const firstEnd = (await plan(s.brand.id))!.current_period_end;
    calls.length = 0;
    await yearPasses(s.brand.id);
    assert.equal(await brandHasPremium(s.brand.id), false, 'the paid year is over until the renewal goes through');
    await runMembershipCycle();
    rows = await charges(s.brand.id);
    assert.deepEqual(rows.map((c) => [c.status, c.amount_cents, c.tax_cents, c.tax_state]), [['paid', 14000, 980, 'IN'], ['paid', 14000, 980, 'IN']]);
    assert.deepEqual(of('charge-saved-payment-method').map((x) => [x.body.amount, x.body.pledgeId, x.body.platformUserId]), [[14980, rows[1].id, s.user.id]]);
    assert.match(of('charge-saved-payment-method')[0].body.description, /^Creator Premium for Brand /);
    const renewed = (await plan(s.brand.id))!;
    assert.equal(renewed.status, 'active');
    const year = (Date.parse(renewed.current_period_end) - Date.parse(renewed.current_period_start)) / 86_400_000;
    assert.ok(year >= 365 && year <= 366 && Date.parse(renewed.current_period_end) > Date.now() + 360 * 86_400_000, 'renewed for one more year');
    assert.notEqual(String(renewed.current_period_end), String(firstEnd));
    assert.equal(await brandHasPremium(s.brand.id), true);
    const mail = await one(`select subject, html from emails where template = 'premium_billing' and user_id = $1 order by created_at desc limit 1`, [s.user.id]);
    assert.match(mail!.subject, /Creator Premium renewed for Brand /);
    assert.match(mail!.html, /You were charged \$149\.80: \$140\.00 for Creator Premium plus \$9\.80 sales tax \(Indiana 7%\)\./);

    // the payer moves to Ohio (5.75%): the next renewal is 14000 + 805
    assert.equal((await s.c.put('/api/billing-location', OH)).status, 200);
    calls.length = 0;
    await yearPasses(s.brand.id);
    await runMembershipCycle();
    rows = await charges(s.brand.id);
    assert.deepEqual([rows[2].status, rows[2].amount_cents, rows[2].tax_cents, rows[2].tax_state, rows[2].tax_rate_bps], ['paid', 14000, 805, 'OH', 575]);
    assert.equal(of('charge-saved-payment-method')[0].body.amount, 14805);
    rep = await taxReport(staff.c, 'IN');
    assert.deepEqual([rep.taxable_cents - reportBefore.taxable_cents, rep.tax_collected_cents - reportBefore.tax_collected_cents], [28000, 1960]);
    const oh = await taxReport(staff.c, 'OH');
    assert.deepEqual([oh.taxable_cents - ohBefore.taxable_cents, oh.tax_collected_cents - ohBefore.tax_collected_cents], [14000, 805]);

    // the brand's page lists every payment with its tax
    view = (await s.c.get(base)).json;
    assert.deepEqual(view.charges.map((c: any) => [c.total_cents, c.tax_label]), [[14805, 'Sales tax (Ohio 5.75%)'], [14980, 'Sales tax (Indiana 7%)'], [14980, 'Sales tax (Indiana 7%)']]);

    // three taxed payments later, reader-membership money and the creator ledger are exactly where they were
    assert.deepEqual(await readerMoney(staff.c), moneyBefore);
  } finally {
    await useSandbox();
    await taxOff();
  }
});

test('a declined renewal: Premium is paused, the card is retried after 1, 3 and 5 days, then the plan lapses; links stay saved and come back on a new subscription', async () => {
  const s = await studio();
  const base = `/api/studio/brands/${s.brand.id}/premium`;
  assert.equal((await s.c.post(`${base}/start`)).json.completed, true);
  assert.deepEqual(await publicLinks(s), [LINK, [LINK], LINK]);
  await useProcessor();
  try {
    await exec(`update premium_subscriptions set provider = 'divinity', payment_method_token = 'pm_prem_test' where publisher_id = $1`, [s.brand.id]);
    decline = true;
    calls.length = 0;
    await yearPasses(s.brand.id);
    await runMembershipCycle();
    let rows = await charges(s.brand.id);
    assert.deepEqual([rows[1].status, rows[1].attempts, rows[1].amount_cents], ['pending', 1, 14000]);
    // the processor's name never reaches the person
    assert.equal(rows[1].last_error, 'Your card was declined by the payment processor');
    assert.equal((await plan(s.brand.id))!.status, 'past_due');
    const retryIn = (Date.parse(rows[1].next_attempt_at) - Date.now()) / 86_400_000;
    assert.ok(retryIn > 0.9 && retryIn < 1.1, `first retry in ${retryIn} days`);

    // the gates close while the payment is failing: the paid year is over
    assert.equal(await brandHasPremium(s.brand.id), false);
    assert.deepEqual(await publicLinks(s), [null, [], null]);
    assert.equal((await s.c.get(PREMIUM_REPORTS(s)[0])).json.code, 'premium_required');
    assert.equal((await s.c.patch(`/api/studio/releases/${s.release.id}`, { print_url: 'https://print.example/late' })).json.code, 'premium_required');
    const view = (await s.c.get(base)).json;
    assert.deepEqual([view.active, view.subscription.status, view.subscription.payment_problem.attempts, view.subscription.payment_problem.message], [false, 'past_due', 1, 'Your card was declined by the payment processor']);
    assert.equal(view.saved_print_links, 1);
    const failed = await one(`select subject, html from emails where template = 'premium_billing' and user_id = $1 order by created_at desc limit 1`, [s.user.id]);
    assert.match(failed!.subject, /We could not renew Creator Premium for Brand /);
    assert.doesNotMatch(failed!.html, /divinity/i);
    // subscribing again while the plan is failing is refused: fix the card or cancel first
    assert.equal((await s.c.post(`${base}/start`)).status, 409);

    // retries: nothing happens before the retry is due; three more declines end the plan
    await runMembershipCycle();
    assert.equal(of('charge-saved-payment-method').length, 1);
    const waits: number[] = [];
    for (let i = 0; i < 3; i++) {
      await exec(`update premium_charges set next_attempt_at = now() - interval '1 minute' where id = $1`, [rows[1].id]);
      await runMembershipCycle();
      const c = (await charges(s.brand.id))[1];
      waits.push(Math.round((Date.parse(c.next_attempt_at) - Date.now()) / 86_400_000) || 0);
    }
    assert.deepEqual(waits, [3, 5, 0]);
    rows = await charges(s.brand.id);
    assert.deepEqual([rows[1].status, rows[1].attempts], ['failed', 4]);
    assert.equal(of('charge-saved-payment-method').length, 4);
    // every attempt asked for the same amount under its own idempotency key
    assert.deepEqual(of('charge-saved-payment-method').map((x) => [x.body.amount, x.body.idempotencyKey]), [[14000, 'attempt-1'], [14000, 'attempt-2'], [14000, 'attempt-3'], [14000, 'attempt-4']]);
    assert.equal((await plan(s.brand.id))!.status, 'expired');
    const ended = await one(`select subject from emails where template = 'premium_billing' and user_id = $1 order by created_at desc limit 1`, [s.user.id]);
    assert.match(ended!.subject, /Creator Premium has ended for Brand /);

    // lapsed: gates closed, nothing more is charged, and the data is all still there
    await runMembershipCycle();
    assert.equal(of('charge-saved-payment-method').length, 4);
    assert.equal(await brandHasPremium(s.brand.id), false);
    assert.deepEqual(await publicLinks(s), [null, [], null]);
    assert.equal((await one('select print_url from releases where id = $1', [s.release.id]))!.print_url, LINK);
    assert.equal((await s.c.get(`/api/studio/releases/${s.release.id}`)).json.release.print_url, LINK);
    for (const url of FREE_REPORTS(s)) assert.equal((await s.c.get(url)).status, 200, url);
  } finally {
    decline = false;
    await useSandbox();
  }
  // subscribing again brings the saved link back
  const back = await s.c.post(`${base}/start`);
  assert.deepEqual([back.status, back.json.active], [200, true], back.res.payload);
  assert.deepEqual(await publicLinks(s), [LINK, [LINK], LINK]);
});

test('a new card on a failing plan is charged straight away and Premium comes back', async () => {
  const s = await studio();
  const base = `/api/studio/brands/${s.brand.id}/premium`;
  assert.equal((await s.c.post(`${base}/start`)).json.completed, true);
  await useProcessor();
  try {
    await exec(`update premium_subscriptions set provider = 'divinity', payment_method_token = 'pm_old' where publisher_id = $1`, [s.brand.id]);
    decline = true;
    await yearPasses(s.brand.id);
    await runMembershipCycle();
    assert.equal((await plan(s.brand.id))!.status, 'past_due');
    decline = false;

    // the hosted card form: a setup session that comes back to the brand's Premium page
    calls.length = 0;
    const r = await s.c.post(`${base}/payment-method`, { surface: 'embed' });
    assert.equal(r.status, 200, r.res.payload);
    assert.match(r.json.url, /^https:\/\/pay\.example\/checkout\/cs_prem_/);
    const sent = of('create-checkout-session')[0].body;
    assert.deepEqual([sent.mode, sent.platformUserId, sent.disableAutoRedirect], ['setup', s.user.id, true]);
    assert.ok(String(sent.returnUrl).endsWith(`/studio/${s.brand.slug}/premium`), sent.returnUrl);
    assert.equal((await s.c.get(`${base}?session_id=${r.json.session_id}`)).json.confirmation, 'pending');
    sessions.set(r.json.session_id, { sessionId: r.json.session_id, status: 'complete', mode: 'setup', paymentMethodId: 'pm_new' });
    const done = (await s.c.get(`${base}?session_id=${r.json.session_id}`)).json;
    assert.deepEqual([done.confirmation, done.active, done.subscription.status], ['active', true, 'active']);
    assert.deepEqual(of('charge-saved-payment-method').map((x) => [x.body.paymentMethodId, x.body.amount]), [['pm_new', 14000]]);
    // asking again never charges again
    assert.equal((await s.c.get(`${base}?session_id=${r.json.session_id}`)).json.confirmation, 'updated');
    assert.equal(of('charge-saved-payment-method').length, 1);
    // someone else on the team cannot confirm the payer's session
    const other = await member(s.brand.id, 'admin');
    assert.equal((await other.c.get(`${base}?session_id=${r.json.session_id}`)).json.confirmation, null);
  } finally {
    decline = false;
    await useSandbox();
  }
});

test('subscribing through the hosted card form, and the processor\'s webhooks for a Premium charge', async () => {
  const staff = await signedIn({ role: 'admin' });
  await useProcessor();
  try {
    const s = await studio();
    const base = `/api/studio/brands/${s.brand.id}/premium`;
    const moneyBefore = await readerMoney(staff.c);
    calls.length = 0;
    const r = await s.c.post(`${base}/start`, { surface: 'redirect' });
    assert.deepEqual([r.status, r.json.status, r.json.surface], [200, 'pending', 'redirect'], r.res.payload);
    assert.equal(await brandHasPremium(s.brand.id), false);
    assert.equal((await s.c.get(base)).json.subscription, null, 'a card form that is still open is not a plan');
    sessions.set(r.json.session_id, { sessionId: r.json.session_id, status: 'complete', mode: 'setup', paymentMethodId: 'pm_hosted' });
    // the webhook gets there first; the browser asking afterwards changes nothing
    const hook = await pay.handleDivinityEvent({ event: 'checkout.completed', data: { sessionId: r.json.session_id, mode: 'setup', paymentMethodId: 'pm_hosted' } });
    assert.equal(hook.message, 'premium active');
    const done = (await s.c.get(`${base}?session_id=${r.json.session_id}`)).json;
    assert.deepEqual([done.confirmation, done.active], ['active', true]);
    assert.equal(of('charge-saved-payment-method').length, 1);
    const [c] = await charges(s.brand.id);
    assert.deepEqual([c.status, c.amount_cents, c.captured_at !== null], ['paid', 14000, true]);

    // payment.succeeded for the same charge is a no-op; a refund at the processor ends Premium
    assert.equal((await pay.handleDivinityEvent({ event: 'payment.succeeded', data: { pledgeId: c.id, paymentIntentId: c.payment_ref } })).message, `Premium charge ${c.id} paid`);
    assert.equal((await charges(s.brand.id)).length, 1);
    assert.equal((await pay.handleDivinityEvent({ event: 'refund.completed', data: { pledgeId: c.id, reason: 'Requested at the bank' } })).message, `Premium charge ${c.id} refunded`);
    assert.equal(await brandHasPremium(s.brand.id), false);
    assert.equal((await plan(s.brand.id))!.status, 'canceled');
    assert.deepEqual(await readerMoney(staff.c), moneyBefore);
  } finally {
    await useSandbox();
  }
});

test('canceling keeps Premium until the end of the paid year, resuming undoes it, and a canceled plan is not charged again', async () => {
  const s = await studio();
  const base = `/api/studio/brands/${s.brand.id}/premium`;
  assert.equal((await s.c.post(`${base}/resume`)).status, 409);
  assert.equal((await s.c.post(`${base}/cancel`)).status, 404);
  assert.equal((await s.c.post(`${base}/start`)).json.completed, true);

  const canceled = await s.c.post(`${base}/cancel`);
  assert.equal(canceled.status, 200, canceled.res.payload);
  const sub = canceled.json.subscription;
  assert.deepEqual([canceled.json.active, sub.status, sub.cancel_at_period_end, sub.renews_at, sub.canceled_at !== null], [true, 'active', true, null, true]);
  // still on until the paid year ends
  assert.equal(await brandHasPremium(s.brand.id), true);
  assert.deepEqual(await publicLinks(s), [LINK, [LINK], LINK]);
  assert.equal((await s.c.get(PREMIUM_REPORTS(s)[2])).status, 200);
  const mail = await one(`select subject, html from emails where template = 'premium_billing' and user_id = $1 order by created_at desc limit 1`, [s.user.id]);
  assert.match(mail!.subject, /Creator Premium canceled for Brand /);
  assert.match(mail!.html, new RegExp(`You keep it until ${String(sub.current_period_end).slice(0, 10)}`));
  // canceling twice is harmless
  assert.equal((await s.c.post(`${base}/cancel`)).status, 200);

  const resumed = await s.c.post(`${base}/resume`);
  assert.deepEqual([resumed.status, resumed.json.subscription.cancel_at_period_end, resumed.json.subscription.renews_at], [200, false, sub.current_period_end]);

  // cancel again and let the year run out: Premium ends, the card is not charged, the link is hidden but kept
  assert.equal((await s.c.post(`${base}/cancel`)).status, 200);
  await yearPasses(s.brand.id);
  await runMembershipCycle();
  assert.equal((await plan(s.brand.id))!.status, 'canceled');
  assert.deepEqual((await charges(s.brand.id)).map((c) => c.status), ['paid']);
  assert.equal(await brandHasPremium(s.brand.id), false);
  assert.deepEqual(await publicLinks(s), [null, [], null]);
  assert.equal((await one('select print_url from releases where id = $1', [s.release.id]))!.print_url, LINK);
  assert.equal((await s.c.get(PREMIUM_REPORTS(s)[2])).json.code, 'premium_required');
  const view = (await s.c.get(base)).json;
  assert.deepEqual([view.active, view.subscription.status], [false, 'canceled']);
  // too late to resume; a new subscription is the way back
  assert.equal((await s.c.post(`${base}/resume`)).status, 409);
  assert.equal((await s.c.post(`${base}/start`)).json.active, true);
});

test('a payer who has left the team is not charged at renewal; a payer who deletes their account stops the renewal', async () => {
  const s = await studio();
  const payer = await member(s.brand.id, 'admin');
  assert.equal((await payer.c.post(`/api/studio/brands/${s.brand.id}/premium/start`)).json.completed, true);
  await exec('delete from publisher_members where publisher_id = $1 and user_id = $2', [s.brand.id, payer.user.id]);
  await yearPasses(s.brand.id);
  await runMembershipCycle();
  assert.deepEqual((await charges(s.brand.id)).map((c) => c.status), ['paid']);
  await runMembershipCycle();
  const ended = (await plan(s.brand.id))!;
  assert.deepEqual([ended.status, ended.payment_method_token], ['expired', null]);
  assert.equal(await brandHasPremium(s.brand.id), false);
  assert.ok(await one(`select 1 from notifications where user_id = $1 and kind = 'premium' and title like '%was not renewed%'`, [s.user.id]));

  // an admin of the brand pays, then deletes their account: the brand keeps the paid year and the card is never charged again
  const t = await studio();
  const leaving = await member(t.brand.id, 'admin');
  assert.equal((await leaving.c.post(`/api/studio/brands/${t.brand.id}/premium/start`)).json.completed, true);
  const gone = await leaving.c.post('/api/account/delete', { password: 'correct horse battery' });
  assert.equal(gone.status, 200, gone.res.payload);
  invalidatePremium();
  const kept = (await plan(t.brand.id))!;
  assert.deepEqual([kept.status, kept.cancel_at_period_end, kept.payment_method_token], ['active', true, null]);
  assert.equal(await brandHasPremium(t.brand.id), true, 'the brand keeps the year that was paid for');
  await yearPasses(t.brand.id);
  await runMembershipCycle();
  assert.deepEqual((await charges(t.brand.id)).map((c) => c.status), ['paid']);
  assert.equal(await brandHasPremium(t.brand.id), false);
});

test('granted Premium: an admin grants it (end date or none, note optional), changes it and revokes it; same features, nothing charged, owners told, all audited', async () => {
  const staff = await signedIn({ role: 'admin' });
  const s = await studio();
  const base = `/api/studio/brands/${s.brand.id}/premium`;
  const grant = `/api/admin/brands/${s.brand.id}/premium/grant`;
  const day = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
  // not for brand owners, and not with a past date
  assert.equal((await s.c.post(grant, { ends_on: day(30) })).status, 403);
  assert.equal((await staff.c.post(grant, { ends_on: '2020-01-01' })).status, 400);
  assert.equal((await staff.c.post(`/api/admin/brands/${s.brand.id}/premium/revoke`)).status, 409);
  assert.equal((await staff.c.get(`/api/admin/brands/${s.brand.id}/premium`)).json.active, false);

  const moneyBefore = await readerMoney(staff.c);
  const dashBefore = (await staff.c.get('/api/admin/dashboard')).json.totals;
  const sumBefore = (await staff.c.get('/api/admin/premium')).json.summary;

  // no fields at all: one year from today, no note
  const g = await staff.c.post(grant, {});
  assert.equal(g.status, 200, g.res.payload);
  const inAYear = new Date(Date.UTC(new Date().getUTCFullYear() + 1, new Date().getUTCMonth(), new Date().getUTCDate() + 1)).toISOString();
  assert.deepEqual([g.json.ends_at, g.json.changed], [inAYear, false]);

  // exactly the features a paying brand has
  assert.equal(await brandHasPremium(s.brand.id), true);
  assert.deepEqual(await publicLinks(s), [LINK, [LINK], LINK]);
  assert.equal((await s.c.patch(`/api/studio/releases/${s.release.id}`, { print_url: 'https://print.example/granted' })).status, 200);
  for (const url of [...FREE_REPORTS(s), ...PREMIUM_REPORTS(s)]) {
    assert.equal((await s.c.get(url)).status, 200, url);
    assert.equal((await s.c.get(csvOf(url))).status, 200, csvOf(url));
  }
  // the Studio page says who granted it and until when, with no billing details
  let view = (await s.c.get(base)).json;
  assert.deepEqual([view.active, view.grant.ends_at, view.subscription, view.charges], [true, inAYear, null, []]);
  assert.equal(typeof view.grant.granted_by, 'string');
  assert.equal((await s.c.post(`${base}/cancel`)).status, 404, 'there is no paid plan to cancel');

  // no card, no charge, no tax, not revenue
  assert.equal((await charges(s.brand.id)).length, 0);
  const dash = (await staff.c.get('/api/admin/dashboard')).json.totals;
  assert.deepEqual([dash.premium_cents, dash.gross_cents, dash.platform_cents, dash.fee_cents], [dashBefore.premium_cents, dashBefore.gross_cents, dashBefore.platform_cents, dashBefore.fee_cents]);
  assert.equal(dash.premium_brands - dashBefore.premium_brands, 1);
  let sum = (await staff.c.get('/api/admin/premium')).json.summary;
  assert.deepEqual([sum.active_brands - sumBefore.active_brands, sum.complimentary - sumBefore.complimentary, sum.paying - sumBefore.paying, sum.annual_run_rate_cents - sumBefore.annual_run_rate_cents, sum.collected_cents - sumBefore.collected_cents],
    [1, 1, 0, 0, 0]);
  assert.deepEqual(await readerMoney(staff.c), moneyBefore);

  // the owner is told in the app and by email
  const note = await one(`select title, body, url from notifications where user_id = $1 and kind = 'premium' order by created_at desc limit 1`, [s.user.id]);
  assert.match(note!.title, /Creator Premium was granted to Brand /);
  assert.match(note!.body, /Nothing is charged/);
  assert.equal(note!.url, `/studio/${s.brand.slug}/premium`);
  const mail = await one(`select subject, html from emails where template = 'premium_granted' and user_id = $1`, [s.user.id]);
  assert.match(mail!.subject, /Creator Premium was granted to Brand /);
  assert.match(mail!.html, new RegExp(`active until ${new Date(Date.parse(inAYear) - 1).toISOString().slice(0, 10)}\\.`));
  assert.match(mail!.html, /nothing to pay and no card is needed/);

  // change it: a new end date and a note; then no end date at all
  const changed = await staff.c.post(grant, { ends_on: day(90), note: 'Extended for the convention' });
  assert.deepEqual([changed.status, changed.json.changed, String(changed.json.ends_at).slice(0, 10)], [200, true, day(91)]);
  let rows = await q(`select provider, status, note, price_cents from premium_subscriptions where publisher_id = $1`, [s.brand.id]);
  assert.deepEqual(rows, [{ provider: 'comp', status: 'active', note: 'Extended for the convention', price_cents: 0 }]);
  const open = await staff.c.post(grant, { no_end: true, note: 'Founding creator' });
  assert.deepEqual([open.status, open.json.ends_at], [200, null]);
  view = (await s.c.get(base)).json;
  assert.deepEqual([view.active, view.grant.ends_at], [true, null]);
  const onBrand = (await staff.c.get(`/api/admin/brands/${s.brand.id}/premium`)).json;
  assert.deepEqual([onBrand.active, onBrand.grant.ends_at, onBrand.grant.note, onBrand.grant.granted_by, onBrand.paid], [true, null, 'Founding creator', staff.user.display_name, null]);
  // the admin list flags it, with no end date and nothing to renew
  const list = (await staff.c.get(`/api/admin/premium?status=current&q=${s.brand.slug}`)).json;
  assert.deepEqual(list.items.map((x: any) => [x.brand_slug, x.complimentary, x.note, x.current, x.no_end, x.ends_at, x.renews_at, x.last_charge]), [[s.brand.slug, true, 'Founding creator', true, true, null, null, null]]);
  // a grant with no end date is still there after any number of years of housekeeping
  await runMembershipCycle();
  assert.equal(await brandHasPremium(s.brand.id), true);

  // overlap: the brand may also pay; either one keeps the features on, and neither changes the other
  const paid = await s.c.post(`${base}/start`);
  assert.deepEqual([paid.status, paid.json.completed, paid.json.active, paid.json.subscription.status, paid.json.grant.ends_at], [200, true, true, 'active', null], paid.res.payload);
  assert.equal((await staff.c.post(grant, { ends_on: day(10), note: 'Shortened while they pay' })).status, 200, 'a grant can be changed while a paid plan runs');
  const revoked = await staff.c.post(`/api/admin/brands/${s.brand.id}/premium/revoke`, { note: 'Agreement ended' });
  assert.equal(revoked.status, 200, revoked.res.payload);
  view = (await s.c.get(base)).json;
  assert.deepEqual([view.active, view.grant, view.subscription.status], [true, null, 'active'], 'the paid plan keeps Premium on after the grant is revoked');
  // and the other way round: grant again, refund the paid year, the grant keeps it on
  assert.equal((await staff.c.post(grant, { ends_on: day(30) })).status, 200);
  const [c] = await charges(s.brand.id);
  assert.equal((await staff.c.post(`/api/admin/premium-charges/${c.id}/refund`, { reason: 'Covered by the grant' })).status, 200);
  view = (await s.c.get(base)).json;
  assert.deepEqual([view.active, view.subscription.status, String(view.grant.ends_at).slice(0, 10)], [true, 'canceled', day(31)]);
  assert.deepEqual(await publicLinks(s), ['https://print.example/granted', ['https://print.example/granted'], 'https://print.example/granted']);

  // revoked with nothing else behind it: the gates close, the link is kept
  assert.equal((await staff.c.post(`/api/admin/brands/${s.brand.id}/premium/revoke`)).status, 200);
  assert.equal(await brandHasPremium(s.brand.id), false);
  assert.deepEqual(await publicLinks(s), [null, [], null]);
  assert.equal((await one('select print_url from releases where id = $1', [s.release.id]))!.print_url, 'https://print.example/granted');
  assert.equal((await s.c.get(PREMIUM_REPORTS(s)[1])).json.code, 'premium_required');

  await new Promise((r) => setTimeout(r, 80));
  const trail = await q(`select action, actor_id, meta from audit_log where target_id = $1 and action like 'premium.%' and actor_id = $2 order by created_at`, [s.brand.id, staff.user.id]);
  assert.deepEqual(trail.map((a) => a.action), ['premium.grant', 'premium.grant_change', 'premium.grant_change', 'premium.grant_change', 'premium.revoke', 'premium.grant', 'premium.revoke']);
  assert.deepEqual([trail[0].meta.note, trail[1].meta.ends_on, trail[1].meta.note, trail[2].meta.no_end, trail[4].meta.note], [null, day(90), 'Extended for the convention', true, 'Agreement ended']);

  // a grant with an end date ends by itself
  assert.equal((await staff.c.post(grant, { ends_on: day(5), note: 'Short trial of the features' })).status, 200);
  await exec(`update premium_subscriptions set current_period_end = now() - interval '1 minute' where publisher_id = $1 and provider = 'comp' and status = 'active'`, [s.brand.id]);
  invalidatePremium();
  await runMembershipCycle();
  assert.equal((await one(`select status from premium_subscriptions where publisher_id = $1 and provider = 'comp' order by created_at desc limit 1`, [s.brand.id]))!.status, 'expired');
  assert.equal(await brandHasPremium(s.brand.id), false);
});

test('the admin brand page carries the brand\'s Premium status', async () => {
  const staff = await signedIn({ role: 'admin' });
  const s = await studio();
  assert.equal((await staff.c.post(`/api/admin/brands/${s.brand.id}/premium/grant`, { no_end: true })).status, 200);
  const summary = (await staff.c.get(`/api/admin/brands/${s.brand.id}/premium`)).json;
  assert.deepEqual([summary.brand.slug, summary.active, summary.grant.ends_at, summary.grant.note], [s.brand.slug, true, null, null]);
  const page = await staff.c.get(`/api/admin/brands/${s.brand.id}`);
  assert.equal(page.status, 200, page.res.payload);
  assert.deepEqual([page.json.premium.active, page.json.premium.grant.ends_at, page.json.premium.paid], [true, null, null]);
});

test('admin: the Premium list, totals and charges, and a full refund that returns the tax and ends Premium', async () => {
  const staff = await signedIn({ role: 'admin' });
  assert.equal((await (await signedIn()).c.get('/api/admin/premium')).status, 403);
  assert.equal((await (await signedIn()).c.get('/api/admin/premium-charges')).status, 403);
  await taxOn();
  await useProcessor();
  try {
    const s = await studio();
    const sumBefore = (await staff.c.get('/api/admin/premium')).json.summary;
    const dashBefore = (await staff.c.get('/api/admin/dashboard')).json.totals;
    const repBefore = await taxReport(staff.c, 'IN');
    const moneyBefore = await readerMoney(staff.c);
    const r = await s.c.post(`/api/studio/brands/${s.brand.id}/premium/start`, { location: IN });
    sessions.set(r.json.session_id, { sessionId: r.json.session_id, status: 'complete', mode: 'setup', paymentMethodId: 'pm_refund' });
    assert.equal((await s.c.get(`/api/studio/brands/${s.brand.id}/premium?session_id=${r.json.session_id}`)).json.confirmation, 'active');

    const list = (await staff.c.get(`/api/admin/premium?q=${s.brand.slug}`)).json;
    assert.equal(list.total, 1);
    const row = list.items[0];
    assert.deepEqual([row.brand_name, row.status, row.complimentary, row.current, row.price_cents, row.email, row.last_charge.amount_cents, row.last_charge.tax_cents, row.renews_at === row.current_period_end],
      [s.brand.name, 'active', false, true, 14000, s.user.email, 14000, 980, true]);
    assert.deepEqual(list.product, { name: 'Creator Premium', annual_cents: 14000 });
    assert.deepEqual([list.summary.active_brands - sumBefore.active_brands, list.summary.paying - sumBefore.paying, list.summary.complimentary - sumBefore.complimentary,
      list.summary.annual_run_rate_cents - sumBefore.annual_run_rate_cents, list.summary.collected_cents - sumBefore.collected_cents, list.summary.tax_cents - sumBefore.tax_cents], [1, 1, 0, 14000, 14000, 980]);
    assert.equal((await staff.c.get(`/api/admin/premium?kind=complimentary&q=${s.brand.slug}`)).json.total, 0);

    const listed = (await staff.c.get(`/api/admin/premium-charges?subscription_id=${row.id}`)).json;
    assert.deepEqual(listed.items.map((c: any) => [c.brand_slug, c.amount_cents, c.tax_cents, c.total_cents, c.tax_label, c.status]), [[s.brand.slug, 14000, 980, 14980, 'Sales tax (Indiana 7%)', 'paid']]);
    const chargeId = listed.items[0].id;

    // the refund: only for admins, with a reason; the processor is asked for price + tax
    assert.equal((await s.c.post(`/api/admin/premium-charges/${chargeId}/refund`, { reason: 'Please' })).status, 403);
    assert.equal((await staff.c.post(`/api/admin/premium-charges/${chargeId}/refund`, {})).status, 400);
    calls.length = 0;
    const refund = await staff.c.post(`/api/admin/premium-charges/${chargeId}/refund`, { reason: 'Subscribed by mistake' });
    assert.equal(refund.status, 200, refund.res.payload);
    assert.deepEqual(of('refund').map((x) => [x.body.amount, x.body.pledgeId]), [[14980, chargeId]]);
    const c = await one('select status, tax_cents, tax_refunded_cents, refunded_at from premium_charges where id = $1', [chargeId]);
    assert.deepEqual([c!.status, c!.tax_refunded_cents, c!.refunded_at !== null], ['refunded', 980, true]);
    assert.deepEqual(await q('select state, tax_cents, order_id, charge_id from sales_tax_refunds where premium_charge_id = $1', [chargeId]), [{ state: 'IN', tax_cents: 980, order_id: null, charge_id: null }]);
    // Premium ends at once, like a refunded reader membership payment ends that membership
    assert.equal(await brandHasPremium(s.brand.id), false);
    assert.equal((await plan(s.brand.id))!.status, 'canceled');
    assert.deepEqual(await publicLinks(s), [null, [], null]);
    // refunding twice is refused, and nothing more is asked of the processor
    assert.equal((await staff.c.post(`/api/admin/premium-charges/${chargeId}/refund`, { reason: 'Again' })).status, 409);
    assert.equal(of('refund').length, 1);
    await new Promise((r) => setTimeout(r, 50));
    const trail = await one(`select meta from audit_log where action = 'premium_charge.refund' and target_id = $1`, [chargeId]);
    assert.deepEqual([trail!.meta.reason, trail!.meta.amount_cents, trail!.meta.tax_cents], ['Subscribed by mistake', 14000, 980]);

    // the report nets the tax out; the dashboard shows the payment and its refund, pre-tax
    const rep = await taxReport(staff.c, 'IN');
    assert.deepEqual([rep.tax_collected_cents - repBefore.tax_collected_cents, rep.tax_refunded_cents - repBefore.tax_refunded_cents, rep.net_tax_cents - repBefore.net_tax_cents], [980, 980, 0]);
    const dash = (await staff.c.get('/api/admin/dashboard')).json.totals;
    assert.deepEqual([dash.premium_cents - dashBefore.premium_cents, dash.refunded_cents - dashBefore.refunded_cents, dash.platform_cents - dashBefore.platform_cents], [14000, 14000, -436]);
    const sum = (await staff.c.get('/api/admin/premium')).json.summary;
    assert.deepEqual([sum.active_brands - sumBefore.active_brands, sum.annual_run_rate_cents - sumBefore.annual_run_rate_cents, sum.refunded_cents - sumBefore.refunded_cents, sum.tax_cents - sumBefore.tax_cents], [0, 0, 14000, 0]);
    assert.deepEqual(await readerMoney(staff.c), moneyBefore);
  } finally {
    await useSandbox();
    await taxOff();
  }
});

test('a reader membership and Creator Premium held by the same person run side by side without touching each other', async () => {
  const staff = await signedIn({ role: 'admin' });
  const s = await studio();
  await setSetting('membership', { trial_days: 0, monthly_cents: 599, annual_cents: 5900 }, null);
  assert.equal((await s.c.post('/api/membership/start', { plan: 'monthly' })).json.completed, true);
  const pots = await q('select gross_cents from sub_months where user_id = $1', [s.user.id]);
  assert.deepEqual(pots, [{ gross_cents: 599 }]);
  const before = await readerMoney(staff.c);

  assert.equal((await s.c.post(`/api/studio/brands/${s.brand.id}/premium/start`)).json.completed, true);
  assert.deepEqual(await readerMoney(staff.c), before);
  assert.deepEqual(await q('select gross_cents from sub_months where user_id = $1', [s.user.id]), pots);

  // canceling the membership leaves Premium alone, and the other way round
  assert.equal((await s.c.post('/api/membership/cancel')).status, 200);
  assert.equal((await plan(s.brand.id))!.cancel_at_period_end, false);
  assert.equal((await s.c.post('/api/membership/resume')).status, 200);
  assert.equal((await s.c.post(`/api/studio/brands/${s.brand.id}/premium/cancel`)).status, 200);
  const mem = (await s.c.get('/api/membership')).json;
  assert.deepEqual([mem.member, mem.subscription.cancel_at_period_end, mem.subscription.price_cents], [true, false, 599]);

  // the renewal cycle bills each from its own table: the membership month renews for 5.99, Premium (canceled) ends
  await exec(`update subscriptions set current_period_end = now() - interval '1 minute' where user_id = $1`, [s.user.id]);
  await yearPasses(s.brand.id);
  await runMembershipCycle();
  assert.deepEqual((await q('select amount_cents, status from subscription_charges where user_id = $1 order by created_at', [s.user.id])).map((c) => [c.amount_cents, c.status]), [[599, 'paid'], [599, 'paid']]);
  assert.deepEqual((await charges(s.brand.id)).map((c) => [c.amount_cents, c.status]), [[14000, 'paid']]);
  assert.equal(await hasMembership(s.user.id), true);
  assert.equal(await brandHasPremium(s.brand.id), false);
});
