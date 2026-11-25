import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { unzipSync } from 'fflate';
import { fixtures, useTestDatabase } from '../lib/commerce.testkit.ts';

/** End to end through the real HTTP stack (app.inject), sandbox payments. */
await useTestDatabase('routes');
process.env.ROUTES = 'auth,catalog,reader,library,social,account,commerce,widgets';
const { exec, one, q, pool } = await import('../db.ts');
const { setSetting } = await import('../lib/settings.ts');
const { signDivinityPayload } = await import('../lib/payments.ts');
const { buildApp } = await import('../server.ts');
const f = await fixtures();
const app = await buildApp();

class Client {
  cookies: Record<string, string> = {};
  headers: Record<string, string>;
  constructor(headers: Record<string, string> = {}) {
    this.headers = headers;
  }
  async call(method: string, url: string, body?: unknown, extra: Record<string, string> = {}) {
    const cookie = Object.entries(this.cookies).map(([k, v]) => `${k}=${v}`).join('; ');
    const res = await app.inject({
      method: method as 'GET', url,
      headers: { ...(cookie ? { cookie } : {}), ...(this.cookies.csrf_token ? { 'x-csrf-token': this.cookies.csrf_token } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}), 'user-agent': 'Mozilla/5.0 (Test)', ...this.headers, ...extra },
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
      // not JSON (image, zip, html)
    }
    return { status: res.statusCode, json, res };
  }
  get = (url: string) => this.call('GET', url);
  post = (url: string, body: unknown = {}) => this.call('POST', url, body);
  async login(email: string, password = 'correct horse battery') {
    await this.get('/api/bootstrap');
    const r = await this.post('/api/auth/login', { email, password });
    assert.equal(r.status, 200, r.res.payload);
    return this;
  }
}
const signedIn = async (over: Parameters<typeof f.user>[0] = {}) => {
  const user = await f.user(over);
  return { user, c: await new Client().login(user.email, over.password) };
};

let owner: Awaited<ReturnType<typeof f.user>>;
let brand: any, payee: any, premium: any, r1: any, r2: any, free: any, fr: any;

before(async () => {
  await setSetting('payments', { provider: 'sandbox', divinity_webhook_secret: 'whsec_routes' }, null);
  await setSetting('membership', { trial_days: 0, monthly_cents: 599, annual_cents: 5900, page_credit_cents: 5 }, null);
  owner = await f.user();
  brand = await f.brand(owner.id, { monthly_goal_cents: 5000 });
  payee = await f.brand((await f.user()).id);
  premium = await f.series(brand.id, { title: `Quasar Knights ${Date.now()}`, forum_enabled: true });
  r1 = await f.release(premium.id, { number: 1, download_price_cents: 499 }, 5);
  r2 = await f.release(premium.id, { number: 2 }, 5);
  free = await f.series(brand.id, { access_model: 'free', genre: 'Comedy' });
  fr = await f.release(free.id, { number: 1 }, 3);
  await exec('insert into revenue_splits (series_id, payee_publisher_id, share_bps) values ($1,$2,2500)', [premium.id, payee.id]);
});
after(async () => {
  await app.close();
  await pool.end();
});

test('anonymous: free release reads end to end, premium shows a preview and refuses locked pages', async () => {
  const anon = new Client();
  await anon.get('/api/bootstrap');

  const m = (await anon.get(`/api/releases/${fr.id}`)).json;
  assert.deepEqual([m.access.model, m.access.release_free, m.access.locked_pages, m.pages.length], ['free', true, 0, 3]);
  assert.equal(m.pages[0].url_medium, `/media/page/${fr.page_ids[0]}/medium`);
  assert.deepEqual(Object.keys(m).sort(), ['access', 'next_release_id', 'offers', 'pages', 'prev_release_id', 'progress', 'release', 'series', 'spread']);
  const img = await anon.get(m.pages[0].url_medium);
  assert.equal(img.status, 200);
  assert.equal(img.res.headers['content-type'], 'image/webp');
  assert.equal(img.res.headers['cache-control'], 'public, max-age=3600');
  assert.equal(img.res.rawPayload.subarray(0, 4).toString(), 'RIFF');

  // anonymous read: counted, with a daily hash instead of an address
  const before = (await one('select read_count from series where id = $1', [free.id]))!.read_count;
  const rd = await anon.post('/api/reads', { release_id: fr.id, page_ids: fr.page_ids });
  assert.deepEqual(rd.json, { ok: true, recorded: 3 });
  assert.equal((await anon.post('/api/reads', { release_id: fr.id, page_ids: fr.page_ids })).json.recorded, 0, 'never more than the page count per visitor per day');
  assert.equal((await one('select read_count from series where id = $1', [free.id]))!.read_count, before + 3);
  const rows = await q('select * from anon_reads where release_id = $1', [fr.id]);
  assert.equal(rows.length, 1);
  assert.match(rows[0].visitor_hash, /^[0-9a-f]{40}$/);
  assert.ok(!JSON.stringify(rows[0]).includes('127.0.0.1'));
  assert.equal((await anon.call('PUT', '/api/progress', { release_id: fr.id, position: 1 })).status, 401);

  const p = (await anon.get(`/api/releases/${r1.id}`)).json;
  assert.deepEqual([p.access.model, p.access.free_pages, p.access.locked_pages, p.access.unlock], ['premium', 2, 3, null]);
  assert.deepEqual(p.pages.map((x: any) => x.locked), [false, false, true, true, true]);
  const locked = p.pages[3];
  assert.deepEqual([locked.url_medium, locked.url_full, locked.frames, locked.width, locked.height], [null, null, [], 40, 60]);
  assert.deepEqual([p.offers.read_price_cents, p.offers.download_price_cents, p.offers.series_price_cents, p.offers.in_membership], [199, 499, 398, true]);
  assert.equal(p.next_release_id, r2.id);
  assert.equal((await anon.get(`/media/page/${r1.page_ids[0]}/medium`)).status, 200);
  for (const v of ['thumb', 'medium', 'full']) {
    const no = await anon.get(`/media/page/${r1.page_ids[3]}/${v}`);
    assert.equal(no.status, 402);
    assert.match(no.json.error, /locked/);
  }
  assert.equal((await anon.get(`/media/page/${r1.page_ids[3]}/original`)).status, 404);
  assert.equal((await anon.get(`/media/private/pages/${r1.id}/4-full.webp`)).status, 404, 'private keys are not reachable directly');
  // locked pages are not counted as read
  assert.equal((await anon.post('/api/reads', { release_id: r1.id, page_ids: [r1.page_ids[3]] })).json.recorded, 0);
  assert.equal((await anon.post('/api/checkout', { items: [{ kind: 'release', id: r1.id }] })).status, 401);
  // CSRF: a mutating call without the header is refused
  assert.equal((await app.inject({ method: 'POST', url: '/api/reads', payload: { release_id: fr.id, page_ids: fr.page_ids } })).statusCode, 403);
});

test('private preview link shows a draft in full, and only with the right token', async () => {
  const draft = await f.release(premium.id, { number: 9, status: 'draft', published_at: null }, 2);
  const anon = new Client();
  assert.equal((await anon.get(`/api/releases/${draft.id}`)).status, 404);
  assert.equal((await anon.get(`/api/releases/${draft.id}?preview=wrong`)).status, 404);
  assert.equal((await anon.get(`/media/page/${draft.page_ids[1]}/medium`)).status, 404);
  const m = (await anon.get(`/api/releases/${draft.id}?preview=${draft.private_token}`)).json;
  assert.equal(m.access.preview, true);
  assert.equal(m.pages[1].url_medium, `/media/page/${draft.page_ids[1]}/medium?preview=${draft.private_token}`);
  const img = await anon.get(m.pages[1].url_medium);
  assert.equal(img.status, 200);
  assert.equal(img.res.headers['cache-control'], 'private, no-store');
  await exec('update releases set deleted_at = now() where id = $1', [draft.id]);
});

test('buying a release in the sandbox unlocks it; earnings are split and add up to the charge', async () => {
  const { user, c } = await signedIn();
  assert.equal((await c.get(`/media/page/${r1.page_ids[4]}/medium`)).status, 402);
  const bad = await c.post('/api/checkout', { items: [{ kind: 'release', id: r1.id }, { kind: 'release', id: r1.id }] });
  assert.equal(bad.status, 400);

  const buy = await c.post('/api/checkout', { items: [{ kind: 'release', id: r1.id }], return_to: `/read/${r1.id}` });
  assert.equal(buy.status, 200, buy.res.payload);
  assert.deepEqual([buy.json.completed, buy.json.return_to], [true, `/read/${r1.id}`]);
  const img = await c.get(`/media/page/${r1.page_ids[4]}/full`);
  assert.equal(img.status, 200);
  assert.equal(img.res.headers['cache-control'], 'private, max-age=3600', 'paid pages never sit in a shared cache');
  const m = (await c.get(`/api/releases/${r1.id}`)).json;
  assert.deepEqual([m.access.unlock, m.access.locked_pages, m.offers.read_price_cents, m.access.can_download], ['purchase', 0, null, false]);
  // the other release is still locked, and someone else is still locked out of this one
  assert.equal((await c.get(`/media/page/${r2.page_ids[4]}/medium`)).status, 402);
  assert.equal((await (await signedIn()).c.get(`/media/page/${r1.page_ids[4]}/medium`)).status, 402);

  const o = (await c.get(`/api/orders/${buy.json.order_id}`)).json.order;
  assert.deepEqual([o.status, o.total_cents, o.charged_cents, o.items.length, o.return_to], ['paid', 199, 199, 1, `/read/${r1.id}`]);
  const ledger = await q('select publisher_id, amount_cents, kind from ledger where order_id = $1 order by amount_cents desc', [o.id]);
  assert.deepEqual(ledger.map((l) => [l.publisher_id, l.amount_cents, l.kind]), [[brand.id, 104, 'sale'], [payee.id, 34, 'sale']]);
  const row = await one('select fee_cents, total_cents from orders where id = $1', [o.id]);
  const platform = row!.total_cents - row!.fee_cents - 138;
  assert.deepEqual([row!.fee_cents, platform], [36, 25]); // 199 = 36 + 104 + 34 + 25
  assert.equal((await c.post('/api/checkout', { items: [{ kind: 'release', id: r1.id }] })).status, 409, 'cannot buy what you own');
  assert.equal((await new Client().get(`/api/orders/${o.id}`)).status, 401);
  assert.equal((await (await signedIn()).c.get(`/api/orders/${o.id}`)).status, 404, "another reader cannot see this order");

  // download is a separate purchase; a brand discount code takes 20% off it
  assert.equal((await c.get(`/api/releases/${r1.id}/download`)).status, 403);
  await exec(`insert into promo_codes (publisher_id, code, kind, percent_off, max_redemptions) values ($1,$2,'discount',20,1)`, [brand.id, `SAVE-${user.username}`]);
  const dl = await c.post('/api/checkout', { items: [{ kind: 'download', id: r1.id }], code: `save-${user.username}`, return_to: '//evil.example' });
  assert.deepEqual([dl.json.completed, dl.json.return_to], [true, '/library'], 'an off-site return_to is ignored');
  assert.equal((await one('select total_cents from orders where id = $1', [dl.json.order_id]))!.total_cents, 399);
  assert.equal((await one('select redeemed_count from promo_codes where code = $1', [`SAVE-${user.username}`]))!.redeemed_count, 1);
  const zip = await c.get(`/api/releases/${r1.id}/download`);
  assert.equal(zip.status, 200);
  assert.equal(zip.res.headers['content-type'], 'application/vnd.comicbook+zip');
  assert.deepEqual(Object.keys(unzipSync(new Uint8Array(zip.res.rawPayload))), ['001.webp', '002.webp', '003.webp', '004.webp', '005.webp']);
  const shelf = (await c.get('/api/library/downloads')).json;
  assert.deepEqual([shelf.total, shelf.items[0].release.id, shelf.items[0].can_download], [1, r1.id, true]);
  const orders = (await c.get('/api/account/orders')).json;
  assert.deepEqual(orders.items.map((x: any) => [x.status, x.total_cents, x.items[0].kind]), [['paid', 399, 'download'], ['paid', 199, 'release']]);
});

test('membership unlocks the catalog; reads are recorded as subscription reads; cancel and resume', async () => {
  const { user, c } = await signedIn();
  const plans = (await c.get('/api/membership')).json;
  assert.deepEqual([plans.member, plans.subscription, plans.plans.monthly_cents], [false, null, 599]);
  const start = await c.post('/api/membership/start', { plan: 'monthly' });
  assert.equal(start.status, 200, start.res.payload);
  assert.deepEqual([start.json.completed, start.json.member, start.json.subscription.status, start.json.subscription.plan], [true, true, 'active', 'monthly']);
  assert.equal((await c.post('/api/membership/start', { plan: 'annual' })).status, 409);

  const m = (await c.get(`/api/releases/${r2.id}`)).json;
  assert.deepEqual([m.access.unlock, m.access.locked_pages, m.access.can_download, m.offers.is_member], ['subscription', 0, false, true]);
  assert.equal((await c.get(`/media/page/${r2.page_ids[4]}/medium`)).status, 200);
  assert.equal((await c.get(`/api/releases/${r2.id}/download`)).status, 403, 'membership is for reading, not keeping');

  assert.equal((await c.post('/api/reads', { release_id: r2.id, page_ids: r2.page_ids })).json.recorded, 5);
  assert.equal((await c.post('/api/reads', { release_id: r2.id, page_ids: r2.page_ids })).json.recorded, 0, 'first read per page per month only');
  const reads = await q('select via, count(*)::int as n from page_reads where user_id = $1 group by via order by via', [user.id]);
  assert.deepEqual(reads.map((r) => [r.via, r.n]), [['free', 2], ['subscription', 3]]);
  assert.equal((await c.call('PUT', '/api/progress', { release_id: r2.id, position: 3, finished: false })).status, 200);
  const lib = (await c.get('/api/library')).json;
  assert.deepEqual([lib.continue_reading[0].release.id, lib.continue_reading[0].position, lib.continue_reading[0].percent], [r2.id, 3, 80]);
  assert.equal((await c.get('/api/home')).json.continue_reading.length, 1);

  const pot = await one('select gross_cents, fee_cents from sub_months where user_id = $1', [user.id]);
  assert.deepEqual([pot!.gross_cents, pot!.fee_cents], [599, 47]);

  const cancel = (await c.post('/api/membership/cancel')).json;
  assert.deepEqual([cancel.member, cancel.subscription.cancel_at_period_end, cancel.subscription.renews_at], [true, true, null]);
  const resume = (await c.post('/api/membership/resume')).json;
  assert.equal(resume.subscription.cancel_at_period_end, false);
  assert.ok(resume.subscription.renews_at);
  // lapsed: access goes with it
  await exec(`update subscriptions set status = 'expired', current_period_end = now() - interval '1 day' where user_id = $1`, [user.id]);
  assert.equal((await c.get(`/media/page/${r2.page_ids[4]}/full`)).status, 402);
});

test('codes: unlock, credits, membership, gift cards; limits, single use, assigned email, wrong kind', async () => {
  const tag = Date.now().toString(36).toUpperCase();
  await exec(`insert into promo_codes (publisher_id, code, kind, series_id, includes_download, max_redemptions) values ($1,$2,'unlock',$3,true,1)`, [brand.id, `UNLK-${tag}`, premium.id]);
  await exec(`insert into promo_codes (publisher_id, code, kind, release_id, assigned_email) values ($1,$2,'unlock',$3,'backer@test.invalid')`, [brand.id, `BACK-${tag}`, r2.id]);
  await exec(`insert into promo_codes (code, kind, page_credits) values ($1,'credits',3)`, [`CRED-${tag}`]);
  await exec(`insert into promo_codes (publisher_id, code, kind, page_credits) values ($1,$2,'credits',500)`, [brand.id, `SELF-${tag}`]);
  await exec(`insert into promo_codes (code, kind, membership_days) values ($1,'membership',30)`, [`MEMB-${tag}`]);
  await exec(`insert into promo_codes (code, kind, percent_off) values ($1,'discount',10)`, [`DISC-${tag}`]);
  await exec(`insert into promo_codes (code, kind, membership_days, expires_at) values ($1,'membership',30, now() - interval '1 day')`, [`GONE-${tag}`]);
  await exec(`insert into promo_codes (code, kind, membership_days, disabled_at) values ($1,'membership',30, now())`, [`OFF-${tag}`]);
  await exec(`insert into promo_codes (code, kind, membership_days, starts_at) values ($1,'membership',30, now() + interval '1 day')`, [`SOON-${tag}`]);

  const { user, c } = await signedIn();
  assert.equal((await new Client().post('/api/codes/redeem', { code: `UNLK-${tag}` })).status, 403, 'signed out: CSRF/auth');
  for (const [code, status, re] of [[`NOPE-${tag}`, 400, /not valid/], [`GONE-${tag}`, 400, /expired/], [`OFF-${tag}`, 400, /not valid/], [`SOON-${tag}`, 400, /not active yet/], [`DISC-${tag}`, 400, /Enter it at checkout/], [`BACK-${tag}`, 403, /different email/], [`SELF-${tag}`, 400, /not valid/]] as const) {
    const r = await c.post('/api/codes/redeem', { code });
    assert.equal(r.status, status, `${code}: ${r.res.payload}`);
    assert.match(r.json.error, re);
  }

  // whole-series unlock with download, lower case and spaces tolerated
  const un = await c.post('/api/codes/redeem', { code: ` unlk-${tag.toLowerCase()} ` });
  assert.equal(un.status, 200, un.res.payload);
  assert.deepEqual([un.json.kind, un.json.release_ids.length, un.json.includes_download], ['unlock', 2, true]);
  const m = (await c.get(`/api/releases/${r2.id}`)).json;
  assert.deepEqual([m.access.unlock, m.access.can_download, m.access.locked_pages], ['code', true, 0]);
  assert.equal((await c.get(`/media/page/${r2.page_ids[4]}/medium`)).status, 200);
  assert.equal((await c.get(`/api/releases/${r2.id}/download`)).status, 200);
  // a rate limit of 8 attempts an hour per account: this reader has now used all eight
  const ninth = await c.post('/api/codes/redeem', { code: `CRED-${tag}` });
  assert.equal(ninth.status, 429);

  // max_redemptions = 1: the next person is too late
  const second = await signedIn();
  assert.match((await second.c.post('/api/codes/redeem', { code: `UNLK-${tag}` })).json.error, /already been used/);
  // page credits
  const cr = await second.c.post('/api/codes/redeem', { code: `CRED-${tag}` });
  assert.deepEqual([cr.json.kind, cr.json.page_credits], ['credits', 3]);
  assert.equal((await second.c.post('/api/codes/redeem', { code: `CRED-${tag}` })).status, 409, 'once per account');
  // membership days
  const mb = await second.c.post('/api/codes/redeem', { code: `MEMB-${tag}` });
  assert.deepEqual([mb.json.kind, mb.json.days], ['membership', 30]);
  assert.equal((await second.c.get(`/media/page/${r1.page_ids[4]}/medium`)).status, 200);
  const sub = (await second.c.get('/api/membership')).json.subscription;
  assert.deepEqual([sub.from_code, sub.renews_at, sub.has_payment_method], [true, null, false]);

  // assigned code: the right, verified address only
  await exec(`update users set email = 'backer@test.invalid', email_verified_at = null where id = $1`, [second.user.id]);
  assert.match((await second.c.post('/api/codes/redeem', { code: `BACK-${tag}` })).json.error, /Confirm your email first/);
  await exec(`update users set email_verified_at = now() where id = $1`, [second.user.id]);
  assert.equal((await second.c.post('/api/codes/redeem', { code: `BACK-${tag}` })).json.kind, 'unlock');
  await exec(`update users set email = $2 where id = $1`, [second.user.id, second.user.email]);
  assert.equal(user.id.length, 36);
});

test('page credits: bought in packs, one credit unlocks one page and pays the creators', async () => {
  const { user, c } = await signedIn();
  assert.equal((await c.post(`/api/pages/${r1.page_ids[3]}/unlock`)).status, 402);
  assert.match((await c.post('/api/checkout', { items: [{ kind: 'credits', quantity: 3 }] })).json.error, /smallest card payment/);
  const buy = await c.post('/api/checkout', { items: [{ kind: 'credits', quantity: 20 }] });
  assert.equal(buy.json.completed, true);
  // a free page costs nothing
  assert.deepEqual((await c.post(`/api/pages/${r1.page_ids[0]}/unlock`)).json, { ok: true, page_credits: 20, spent: 0 });
  const un = await c.post(`/api/pages/${r1.page_ids[3]}/unlock`);
  assert.deepEqual(un.json, { ok: true, page_credits: 19, spent: 1 });
  assert.deepEqual((await c.post(`/api/pages/${r1.page_ids[3]}/unlock`)).json, { ok: true, page_credits: 19, spent: 0 }, 'never charged twice for a page');
  assert.equal((await c.get(`/media/page/${r1.page_ids[3]}/medium`)).status, 200);
  assert.equal((await c.get(`/media/page/${r1.page_ids[4]}/medium`)).status, 402, 'only that page');
  const m = (await c.get(`/api/releases/${r1.id}`)).json;
  assert.deepEqual(m.pages.map((p: any) => p.via), ['free', 'free', null, 'credit', null]);
  assert.equal(m.offers.page_credits_available, 19);
  assert.equal((await c.post('/api/reads', { release_id: r1.id, page_ids: r1.page_ids })).json.recorded, 3);
  assert.deepEqual((await q('select via from page_reads where user_id = $1 order by via', [user.id])).map((r) => r.via), ['credit', 'free', 'free']);
  // 5 cents: 85% -> 4 to creators (owner 3, payee 25% of 4 = 1), 1 to the platform
  const led = await q(`select publisher_id, amount_cents from ledger where note like '%Page credit%' and release_id = $1 and created_at > now() - interval '5 seconds' order by amount_cents desc`, [r1.id]);
  assert.deepEqual(led.slice(0, 2).map((l) => [l.publisher_id, l.amount_cents]), [[brand.id, 3], [payee.id, 1]]);
  const w = (await c.get('/api/account/wallet')).json;
  assert.equal(w.wallet.page_credits, 19);
  assert.deepEqual(w.log.map((l: any) => [l.kind, l.page_credits]), [['page_unlock', -1], ['credits_purchase', 20]]);
});

test('tips, gift cards and store credit: one basket, credit applied on the next order, whole-series purchase', async () => {
  const { user, c } = await signedIn();
  assert.equal((await c.post('/api/checkout', { items: [{ kind: 'tip', id: brand.slug, amount_cents: 50 }] })).status, 400);
  const basket = await c.post('/api/checkout', { items: [{ kind: 'tip', id: brand.slug, amount_cents: 333, message: 'Loved issue 1' }, { kind: 'gift_card', amount_cents: 1000, recipient_email: 'friend@test.invalid', message: 'Enjoy' }] });
  assert.equal(basket.json.completed, true, basket.res.payload);
  const order = await one('select * from orders where id = $1', [basket.json.order_id]);
  const items = await q('select kind, price_cents, creator_cents from order_items where order_id = $1 order by kind', [order!.id]);
  const fees = 1333 * 0.029 + 30;
  assert.equal(order!.fee_cents, Math.round(fees));
  // the tip pays 95% of its share after fees; the gift card pays no creator
  assert.equal(items[0].creator_cents, 0);
  assert.ok(items[1].creator_cents > 290 && items[1].creator_cents < 333 * 0.95);
  const tip = await one('select amount_cents, message, show_amount from tips where order_id = $1', [order!.id]);
  assert.deepEqual([tip!.amount_cents, tip!.message, tip!.show_amount], [333, 'Loved issue 1', true]);
  const b = (await c.get(`/api/brands/${brand.slug}`)).json;
  assert.ok(b.tip_goal.raised_cents >= 333);
  assert.equal(b.tip_goal.goal_cents, 5000);
  assert.ok(b.recent_tips.some((t: any) => t.amount_cents === 333 && t.message === 'Loved issue 1'));

  const card = await one('select code, balance_cents, recipient_email from gift_cards where order_id = $1', [order!.id]);
  assert.match(card!.code, /^[A-Z2-9]{4}(-[A-Z2-9]{4}){3}$/);
  const mail = await one(`select to_email, html from emails where template = 'gift_card' order by created_at desc limit 1`);
  assert.equal(mail!.to_email, 'friend@test.invalid');
  assert.ok(mail!.html.includes(card!.code));
  assert.equal((await one<{ n: number }>(`select count(*)::int as n from emails where template = 'receipt' and user_id = $1`, [user.id]))!.n, 1);
  assert.ok((await c.get('/api/notifications')).json.items.some((n: any) => n.kind === 'purchase'));
  assert.equal((await c.get('/api/account/gift-cards')).json.bought[0].code, card!.code);

  const friend = await signedIn();
  const red = await friend.c.post('/api/codes/redeem', { code: card!.code });
  assert.deepEqual([red.json.kind, red.json.credit_cents], ['gift_card', 1000]);
  assert.match((await friend.c.post('/api/codes/redeem', { code: card!.code })).json.error, /already been used/);

  // whole series (2 x 199 = 398) paid entirely with store credit: no card, no fee
  const all = await friend.c.post('/api/checkout', { items: [{ kind: 'series', id: premium.slug }], use_credit: true });
  assert.equal(all.json.completed, true, all.res.payload);
  const o2 = await one('select total_cents, credit_cents, fee_cents, provider, status from orders where id = $1', [all.json.order_id]);
  assert.deepEqual([o2!.total_cents, o2!.credit_cents, o2!.fee_cents, o2!.provider, o2!.status], [398, 398, 0, 'credit', 'paid']);
  assert.equal((await friend.c.get('/api/account/wallet')).json.wallet.credit_cents, 602);
  assert.equal((await friend.c.get('/api/library/owned')).json.total, 2);
  assert.equal((await friend.c.get(`/media/page/${r2.page_ids[4]}/medium`)).status, 200);
  // 398 with no fee: 85% = 338 to creators (payee 25% = 84, owner 254), 60 to the platform
  const led = await q('select publisher_id, amount_cents from ledger where order_id = $1 order by amount_cents desc', [all.json.order_id]);
  assert.deepEqual(led.map((l) => [l.publisher_id, l.amount_cents]), [[brand.id, 254], [payee.id, 84]]);
  assert.match((await friend.c.post('/api/checkout', { items: [{ kind: 'series', id: premium.slug }] })).json.error, /nothing left to buy/);
});

test('the Divinity webhook endpoint verifies the signature over the raw body', async () => {
  const body = JSON.stringify({ event: 'test.ping', timestamp: new Date().toISOString(), data: {} });
  const send = (sig: string, payload = body) => app.inject({ method: 'POST', url: '/api/webhooks/divinity', headers: { 'content-type': 'application/json', 'x-webhook-signature': sig }, payload });
  // no cookie, no CSRF token: webhooks are authenticated by signature alone
  const ok = await send(signDivinityPayload(body, 'whsec_routes'));
  assert.equal(ok.statusCode, 200, ok.payload);
  assert.deepEqual(ok.json(), { success: true, message: 'Webhook received' });
  assert.equal((await send(signDivinityPayload(body, 'wrong-secret'))).statusCode, 401);
  assert.equal((await send('')).statusCode, 401);
  // same JSON, different bytes: the signature is over what was sent, not what it parses to
  assert.equal((await send(signDivinityPayload(body, 'whsec_routes'), body.replace('{"event"', '{ "event"'))).statusCode, 401);
  // an event about something that is not ours is still acknowledged so it is not redelivered forever
  const other = JSON.stringify({ event: 'dispute.created', data: { stripePaymentIntentId: 'pi_not_ours', pledgeId: 'pledge_x' } });
  assert.equal((await send(signDivinityPayload(other, 'whsec_routes'), other)).statusCode, 200);
});

test('hosted checkout over HTTP: the browser names its surface, gets the session back, and can ask how it went as often as it likes', async () => {
  // A local stand-in for the processor's partner API, just enough for a session to be created and read.
  const { createServer } = await import('node:http');
  const sessions = new Map<string, Record<string, any>>();
  const created: Record<string, any>[] = [];
  const fake = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const action = new URL(req.url!, 'http://x').searchParams.get('action');
      const b = raw ? JSON.parse(raw) : {};
      let out: unknown = { success: true };
      if (action === 'create-checkout-session') {
        created.push(b);
        const id = `cs_http_${Date.now().toString(36)}_${created.length}`;
        sessions.set(id, { sessionId: id, status: 'pending', mode: b.mode, paymentIntentId: b.mode === 'payment' ? `pi_${id}` : null, paymentMethodId: null });
        out = { success: true, sessionId: id, checkoutUrl: `https://pay.example/checkout/${id}`, expiresAt: new Date(Date.now() + 3600e3).toISOString() };
      } else if (action === 'get-checkout-session') out = { success: true, session: sessions.get(b.sessionId) };
      else if (action === 'charge-saved-payment-method') out = { success: true, status: 'succeeded', paymentIntentId: `pi_${b.pledgeId}` };
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(out));
    });
  });
  await new Promise<void>((r) => fake.listen(0, '127.0.0.1', r));
  await setSetting('payments', { provider: 'divinity', divinity_api_url: `http://127.0.0.1:${(fake.address() as { port: number }).port}/internal`, divinity_partner_id: 'partner_routes', divinity_api_key: 'dc_routes' }, null);
  try {
    const { user, c } = await signedIn();
    const item = { items: [{ kind: 'release', id: r2.id }], return_to: `/read/${r2.id}` };

    const bad = await c.post('/api/checkout', { ...item, surface: 'popup' });
    assert.equal(bad.status, 400);
    assert.match(bad.json.error, /surface must be "embed" or "redirect"/);
    assert.equal(created.length, 0, 'nothing was started');

    // embedded: the session is told not to navigate the browser, and everything the dialog needs comes back
    const start = await c.post('/api/checkout', { ...item, surface: 'embed' });
    assert.equal(start.status, 200, start.res.payload);
    assert.deepEqual(Object.keys(start.json).sort(), ['amount_cents', 'order_id', 'return_to', 'session_id', 'surface', 'url']);
    assert.deepEqual([start.json.surface, start.json.amount_cents, start.json.return_to], ['embed', 199, `/read/${r2.id}`]);
    // the address carries the site's colors so the payment page is not shown in its default light look
    assert.equal(start.json.url, `https://pay.example/checkout/${start.json.session_id}?bg=191714&text=f4eee1&accent=ff2e88`);
    assert.equal(created[0].disableAutoRedirect, true);

    // while the buyer is still typing, every ask says "pending" and changes nothing
    const ask = () => c.get(`/api/orders/${start.json.order_id}?session_id=${start.json.session_id}`);
    for (let i = 0; i < 4; i++) {
      const o = (await ask()).json.order;
      assert.deepEqual([o.status, o.payment_state, o.failure], ['pending', 'pending', null]);
    }
    assert.equal((await one('select count(*)::int as n from entitlements where user_id = $1', [user.id]))!.n, 0);
    // someone else's session id confirms nothing
    assert.equal((await c.get(`/api/orders/${start.json.order_id}?session_id=cs_not_mine`)).json.order.status, 'pending');

    // the card is refused and the session ends: a state and a sentence for the buyer, the same on every ask
    sessions.get(start.json.session_id)!.status = 'failed';
    for (let i = 0; i < 2; i++) {
      const o = (await ask()).json.order;
      assert.deepEqual([o.status, o.payment_state, o.failure], ['failed', 'failed', 'The card was not accepted, so nothing was charged.']);
    }

    // no surface named: a redirect session, which the processor sends back itself; paid, then paid on every ask
    const plain = await c.post('/api/checkout', item);
    assert.equal(plain.json.surface, 'redirect');
    assert.ok(!('disableAutoRedirect' in created[1]));
    sessions.get(plain.json.session_id)!.status = 'complete';
    for (let i = 0; i < 3; i++) {
      const o = (await c.get(`/api/orders/${plain.json.order_id}?session_id=${plain.json.session_id}`)).json.order;
      assert.deepEqual([o.status, o.payment_state, o.failure], ['paid', 'paid', null]);
    }
    assert.equal((await one('select count(*)::int as n from ledger where order_id = $1', [plain.json.order_id]))!.n, 2, 'granted and credited once');

    // membership card, embedded
    assert.equal((await c.post('/api/membership/start', { plan: 'monthly', surface: 'iframe' })).status, 400);
    const m = await c.post('/api/membership/start', { plan: 'monthly', surface: 'embed' });
    assert.deepEqual([m.json.surface, m.json.status, typeof m.json.session_id, created.at(-1)!.mode, created.at(-1)!.disableAutoRedirect], ['embed', 'pending', 'string', 'setup', true]);
    const mine = () => c.get(`/api/membership?session_id=${m.json.session_id}`);
    assert.deepEqual([(await mine()).json.confirmation, (await mine()).json.confirmation_message], ['pending', null]);
    Object.assign(sessions.get(m.json.session_id)!, { status: 'complete', paymentMethodId: 'pm_http' });
    for (let i = 0; i < 3; i++) assert.deepEqual([(await mine()).json.confirmation, (await mine()).json.member], ['active', true]);
    assert.equal((await one('select count(*)::int as n from subscription_charges where user_id = $1', [user.id]))!.n, 1, 'charged once however often it was asked');

    // a new card for that membership, also embedded
    const card = await c.post('/api/membership/payment-method', { surface: 'embed' });
    assert.deepEqual([card.json.surface, created.at(-1)!.disableAutoRedirect], ['embed', true]);
    sessions.get(card.json.session_id)!.status = 'expired';
    const gone = (await c.get(`/api/membership?session_id=${card.json.session_id}`)).json;
    assert.deepEqual([gone.confirmation, gone.member], ['expired', true]);
    assert.match(gone.confirmation_message, /timed out before it was paid/);

    // the public settings tell the web app whether it may embed at all
    assert.equal((await c.get('/api/bootstrap')).json.settings.payments.embed_checkout, true);
    await setSetting('payments', { divinity_embed_checkout: false }, null);
    assert.equal((await c.get('/api/bootstrap')).json.settings.payments.embed_checkout, false);
    const other = await signedIn();
    assert.equal((await other.c.post('/api/checkout', { ...item, surface: 'embed' })).json.surface, 'redirect');
  } finally {
    await setSetting('payments', { provider: 'sandbox', divinity_embed_checkout: true }, null);
    fake.close();
  }
});

test('catalog: search with prefix fallback, filters, visibility rules, series page and brand page', async () => {
  const Z = `Zq${Date.now().toString(36)}x`; // a word no earlier run has used (the test database is kept between runs)
  const hidden = await f.series(brand.id, { title: `${Z} Nights Uncut`, mature: true, access_model: 'free' });
  await f.release(hidden.id, {}, 1);
  const draft = await f.series(brand.id, { title: `${Z} Draft`, visibility: 'draft' });
  await f.release(draft.id, {}, 1);
  const blocked = await f.series(brand.id, { title: `${Z} Abroad` });
  await f.release(blocked.id, {}, 1);
  await exec(`insert into country_rules (series_id, country, rule) values ($1,'DE','blocked')`, [blocked.id]);
  const empty = await f.series(brand.id, { title: `${Z} Empty` }); // no published release
  const suspendedBrand = await f.brand(null);
  await exec('update publishers set suspended_at = now() where id = $1', [suspendedBrand.id]);
  const sus = await f.series(suspendedBrand.id, { title: `${Z} Suspended` });
  await f.release(sus.id, {}, 1);

  const anon = new Client();
  const titles = async (cl: Client, qs: string) => ((await cl.get(`/api/series?${qs}`)).json.items as any[]).map((i) => i.title).sort();
  assert.deepEqual(await titles(anon, `q=${Z.toLowerCase().slice(0, -2)}`), [`${Z} Abroad`], 'prefix search; mature, draft, empty and suspended are hidden');
  assert.deepEqual(await titles(new Client({ 'x-country': 'DE' }), `q=${Z}`), [], 'blocked in that country');
  const adult = await signedIn({ prefs: { show_mature: true } });
  assert.deepEqual(await titles(adult.c, `q=${Z}`), [`${Z} Abroad`, `${Z} Nights Uncut`]);
  assert.deepEqual(await titles(adult.c, `q=${Z}&access=free`), [`${Z} Nights Uncut`]);
  assert.equal((await anon.get(`/api/series/${hidden.slug}`)).json.code, 'mature');
  assert.equal((await anon.get(`/api/series/${draft.slug}`)).status, 404);
  assert.equal((await anon.get(`/api/series/${empty.slug}`)).status, 200, 'reachable by link, just not listed');
  assert.equal((await anon.get(`/api/series/${sus.slug}`)).status, 404);

  const list = (await anon.get(`/api/series?publisher=${brand.slug}&genre=Comedy&sort=title&limit=5`)).json;
  assert.deepEqual([list.total, list.items[0].id, list.items[0].badge.kind, list.limit], [1, free.id, 'free', 5]);
  const card = ((await anon.get(`/api/series?q=${encodeURIComponent(premium.title)}`)).json.items as any[]).find((i) => i.id === premium.id);
  assert.deepEqual([card.badge.kind, card.from_price_cents, card.in_membership, card.release_count], ['unlimited', 199, true, 2]);

  // a timed sale shows on cards, the series page and the store row
  await exec(`insert into discounts (publisher_id, label, percent_off, series_id) values ($1,'Launch week',25,$2)`, [brand.id, premium.id]);
  const sale = ((await anon.get(`/api/series?on_sale=1&publisher=${brand.slug}`)).json.items as any[])[0];
  assert.deepEqual([sale.id, sale.badge.kind, sale.badge.price_cents, sale.badge.list_price_cents, sale.sale_percent], [premium.id, 'sale', 149, 199, 25]);
  const home = (await anon.get('/api/home')).json;
  assert.deepEqual(Object.keys(home).sort(), ['continue_reading', 'favorite_genre', 'for_you', 'hero', 'independent', 'new_releases', 'popular', 'sale', 'spotlight', 'staff_picks']);
  assert.ok(home.sale.some((row: any) => row.label === 'Launch week' && row.items.some((i: any) => i.id === premium.id)));
  assert.ok(home.new_releases.last_week.some((n: any) => n.release.id === r2.id && n.series.id === premium.id));
  assert.ok(home.independent[0].items.length > 0);

  const page = (await anon.get(`/api/series/${premium.slug}`)).json;
  assert.deepEqual([page.discount.label, page.discount.percent_off], ['Launch week', 25]);
  assert.deepEqual(page.release_groups.map((g: any) => g.group), ['Singles']);
  const rel = page.release_groups[0].releases[0];
  assert.deepEqual([rel.access.status, rel.access.free_pages, rel.access.locked_pages, rel.access.read_price_cents, rel.access.read_list_price_cents, rel.access.download_price_cents], ['preview', 2, 3, 149, 199, 374]);
  assert.equal(page.offers.series_price_cents, 298);
  assert.equal(page.brand.slug, brand.slug);
  await exec('delete from discounts where publisher_id = $1', [brand.id]);

  // favorite genre tunes the store
  const fan = await signedIn({ prefs: { favorite_genre: 'scifi_fantasy' } });
  const tuned = (await fan.c.get('/api/home')).json;
  assert.equal(tuned.favorite_genre.id, 'scifi_fantasy');
  assert.equal(tuned.for_you[0].title, 'Sci-Fi');
  assert.ok(tuned.for_you[0].items.every((i: any) => i.genre === 'Sci-Fi'));

  const dir = (await anon.get(`/api/brands?q=${brand.slug}`)).json;
  assert.deepEqual([dir.total, dir.items[0].slug], [1, brand.slug]);
  const profile = (await anon.get(`/api/brands/${brand.slug}?q=quasar`)).json;
  assert.deepEqual(profile.series.map((s: any) => s.id), [premium.id]);
  assert.deepEqual([profile.members[0].role, profile.members[0].username], ['owner', owner.username]);
  assert.equal((await anon.get(`/api/brands/${suspendedBrand.slug}`)).status, 404);
});

test('library: follow / favorite keep the counters exact; brand follow notifies the owner', async () => {
  const { user, c } = await signedIn();
  const base = (await one('select follower_count, favorite_count from series where id = $1', [premium.id]))!;
  assert.equal((await c.post(`/api/series/${premium.slug}/follow`)).json.follower_count, base.follower_count + 1);
  assert.equal((await c.post(`/api/series/${premium.id}/follow`, { notify: false })).json.follower_count, base.follower_count + 1, 'following twice counts once');
  assert.equal((await one('select notify from follows where user_id = $1', [user.id]))!.notify, false);
  assert.equal((await c.post(`/api/series/${premium.slug}/favorite`)).json.favorite_count, base.favorite_count + 1);
  assert.equal((await c.post(`/api/series/${premium.slug}/favorite`)).json.favorite_count, base.favorite_count + 1);
  const page = (await c.get(`/api/series/${premium.slug}`)).json;
  assert.deepEqual([page.viewer.following, page.viewer.notify, page.viewer.favorite], [true, false, true]);
  const lib = (await c.get('/api/library')).json;
  assert.deepEqual([lib.following.map((s: any) => s.id), lib.favorites.map((s: any) => s.id)], [[premium.id], [premium.id]]);
  assert.equal((await c.call('DELETE', `/api/series/${premium.slug}/favorite`)).json.favorite_count, base.favorite_count);
  assert.equal((await c.call('DELETE', `/api/series/${premium.slug}/favorite`)).json.favorite_count, base.favorite_count, 'removing twice does not go below');
  assert.equal((await c.call('DELETE', `/api/series/${premium.slug}/follow`)).json.follower_count, base.follower_count);

  assert.equal((await c.post(`/api/brands/${brand.slug}/follow`)).json.following, true);
  await c.post(`/api/brands/${brand.slug}/follow`);
  assert.equal((await q(`select 1 from notifications where user_id = $1 and kind = 'follower' and url = $2`, [owner.id, `/u/${user.username}`])).length, 1);
  assert.equal((await c.get('/api/library/following')).json.brands[0].slug, brand.slug);
  const feed = (await c.get('/api/community/feed')).json;
  assert.ok(feed.following_releases.some((x: any) => x.series.id === premium.id), 'releases from a followed brand');
  assert.equal((await c.call('DELETE', `/api/brands/${brand.slug}/follow`)).json.following, false);
});

test('comments, reports, forums with moderation and @mentions', async () => {
  const a = await signedIn();
  const b = await signedIn();
  const brandOwner = await new Client().login(owner.email);

  const first = await a.c.post('/api/comments', { series_id: premium.id, release_id: r1.id, body: 'What an opening page.' });
  assert.equal(first.status, 200, first.res.payload);
  const reply = await b.c.post('/api/comments', { series_id: premium.id, parent_id: first.json.comment.id, body: `Agreed @${a.user.username} and @${owner.username}!` });
  assert.equal(reply.status, 200);
  const notes = await q<{ kind: string }>('select kind from notifications where user_id = $1 order by created_at', [a.user.id]);
  assert.deepEqual(notes.map((n) => n.kind), ['reply'], 'a reply that also mentions you is one notification');
  assert.equal((await q(`select 1 from notifications where user_id = $1 and kind = 'mention'`, [owner.id])).length, 1);
  assert.equal((await q(`select 1 from emails where user_id = $1 and template = 'notice_reply'`, [a.user.id])).length, 1);

  let list = (await new Client().get(`/api/comments?series=${premium.slug}`)).json;
  const top = list.items.find((c: any) => c.id === first.json.comment.id);
  assert.deepEqual([top.replies.length, top.replies[0].author.username, top.author.username], [1, b.user.username, a.user.username]);
  assert.equal((await new Client().get(`/api/comments?series=${premium.slug}&release=${r2.id}`)).json.total, 0);

  // report (deduplicated), hide by the brand, delete own
  assert.equal((await b.c.post(`/api/comments/${first.json.comment.id}/report`, { reason: 'spam' })).status, 200);
  await b.c.post('/api/reports', { target_kind: 'comment', target_id: first.json.comment.id, reason: 'spam', detail: 'again' });
  assert.equal((await q(`select 1 from reports where target_id = $1 and status = 'open'`, [first.json.comment.id])).length, 1);
  assert.equal((await b.c.post('/api/reports', { target_kind: 'series', target_id: premium.id, reason: 'Stolen artwork' })).status, 200);
  assert.equal((await b.c.post('/api/reports', { target_kind: 'forum_post', target_id: premium.id, reason: 'x' })).status, 400);
  assert.equal((await b.c.post(`/api/comments/${first.json.comment.id}/hide`, { hidden: true })).status, 403);
  assert.equal((await brandOwner.post(`/api/comments/${first.json.comment.id}/hide`, { hidden: true })).json.hidden, true);
  list = (await new Client().get(`/api/comments?series=${premium.slug}`)).json;
  assert.ok(!list.items.some((c: any) => c.id === first.json.comment.id), 'hidden from the public');
  assert.ok((await a.c.get(`/api/comments?series=${premium.slug}`)).json.items.some((c: any) => c.id === first.json.comment.id && c.hidden), 'its author still sees it, marked hidden');
  assert.equal((await b.c.call('DELETE', `/api/comments/${first.json.comment.id}`)).status, 403);
  assert.equal((await a.c.call('DELETE', `/api/comments/${first.json.comment.id}`)).status, 200);
  await exec('update series set allow_comments = false where id = $1', [free.id]);
  assert.match((await a.c.post('/api/comments', { series_id: free.id, body: 'hello' })).json.error, /turned off/);

  // forums
  const idx = (await new Client().get('/api/forums')).json;
  assert.deepEqual(idx.boards.map((x: any) => x.id), ['general', 'recommendations', 'creators', 'feedback']);
  assert.ok(idx.series.some((s: any) => s.id === premium.id));
  assert.equal((await a.c.post('/api/forums/threads', { series_id: free.id, title: 'No forum here', body: 'x' })).status, 404);
  const th = await a.c.post('/api/forums/threads', { series_id: premium.id, title: 'Theories about issue 2', body: `Paging @${b.user.username}` });
  assert.equal(th.status, 200, th.res.payload);
  const tid = th.json.thread.id;
  assert.equal((await q(`select 1 from notifications where user_id = $1 and kind = 'mention' and url = $2`, [b.user.id, `/forums/thread/${tid}`])).length, 1);
  const p = await b.c.post(`/api/forums/threads/${tid}/posts`, { body: 'The knight is the villain.' });
  assert.equal(p.status, 200);
  assert.equal((await b.c.call('PATCH', `/api/forums/posts/${p.json.post.id}`, { body: 'The knight is the hero.' })).status, 200);
  assert.equal((await a.c.call('PATCH', `/api/forums/posts/${p.json.post.id}`, { body: 'vandalism' })).status, 403);
  let view = (await new Client().get(`/api/forums/threads/${tid}`)).json;
  assert.deepEqual([view.thread.reply_count, view.posts.length, view.posts[1].body, Boolean(view.posts[1].edited_at)], [1, 2, 'The knight is the hero.', true]);

  // pin/lock: not ordinary readers; forum moderators, the brand team and admins can
  assert.equal((await b.c.call('PATCH', `/api/forums/threads/${tid}`, { locked: true })).status, 403);
  await exec('insert into forum_moderators (series_id, user_id) values ($1,$2)', [premium.id, b.user.id]);
  assert.deepEqual((await b.c.call('PATCH', `/api/forums/threads/${tid}`, { pinned: true, locked: true })).json, { ok: true, pinned: true, locked: true });
  assert.match((await a.c.post(`/api/forums/threads/${tid}/posts`, { body: 'one more thing' })).json.error, /locked/);
  assert.equal((await brandOwner.post(`/api/forums/threads/${tid}/posts`, { body: 'Creator here: no spoilers.' })).status, 200);
  assert.equal((await (await signedIn()).c.call('DELETE', `/api/forums/posts/${p.json.post.id}`)).status, 403);
  assert.equal((await brandOwner.call('DELETE', `/api/forums/posts/${p.json.post.id}`)).status, 200);
  view = (await new Client().get(`/api/forums/threads/${tid}`)).json;
  assert.deepEqual([view.thread.reply_count, view.posts.length], [1, 2]);
  assert.equal((await new Client().get(`/api/forums/threads?series=${premium.slug}`)).json.items[0].id, tid);

  // site-wide board: only admins moderate
  const site = await a.c.post('/api/forums/threads', { board: 'recommendations', title: 'Best space opera?', body: 'Go.' });
  assert.equal(site.json.thread.board, 'recommendations');
  assert.equal((await brandOwner.call('PATCH', `/api/forums/threads/${site.json.thread.id}`, { pinned: true })).status, 403);
  const admin = await signedIn({ role: 'admin' });
  assert.equal((await admin.c.call('PATCH', `/api/forums/threads/${site.json.thread.id}`, { pinned: true })).json.pinned, true);
  assert.equal((await new Client().get('/api/forums/threads?board=nope')).status, 404);
  assert.equal((await a.c.call('DELETE', `/api/forums/threads/${site.json.thread.id}`)).status, 200, 'the author can remove their own thread');
  assert.equal((await new Client().get(`/api/forums/threads/${site.json.thread.id}`)).status, 404);
});

test('direct messages respect allow_dms and the email preference; notifications; feedback', async () => {
  const a = await signedIn();
  const b = await signedIn();
  const quiet = await signedIn({ prefs: { allow_dms: false } });
  const noMail = await signedIn({ prefs: { notify: { messages: false } } });
  const unverified = await signedIn({ verified: false });

  assert.match((await unverified.c.post('/api/messages', { to: b.user.username, body: 'hi' })).json.error, /Confirm your email/);
  assert.match((await a.c.post('/api/messages', { to: quiet.user.username, body: 'hi' })).json.error, /not accepting direct messages/);
  assert.equal((await a.c.post('/api/messages', { to: a.user.username, body: 'hi me' })).status, 400);
  assert.equal((await a.c.post('/api/messages', { to: 'nobody_here_x', body: 'hi' })).status, 404);

  const sent = await a.c.post('/api/messages', { to: `@${b.user.username}`, body: 'Loved your theory thread.' });
  assert.equal(sent.status, 200, sent.res.payload);
  assert.equal((await q(`select 1 from emails where template = 'new_message' and user_id = $1`, [b.user.id])).length, 1);
  await a.c.post('/api/messages', { to: noMail.user.username, body: 'No email please.' });
  assert.equal((await q(`select 1 from emails where template = 'new_message' and user_id = $1`, [noMail.user.id])).length, 0);
  assert.equal((await q(`select 1 from notifications where kind = 'message' and user_id = $1`, [noMail.user.id])).length, 1, 'the bell still rings');

  let inbox = (await b.c.get('/api/messages/conversations')).json;
  assert.deepEqual([inbox.unread, inbox.items[0].with.username, inbox.items[0].last_message.mine], [1, a.user.username, false]);
  const conv = (await b.c.get(`/api/messages/conversations/${inbox.items[0].id}`)).json;
  assert.deepEqual(conv.messages.map((m: any) => [m.body, m.mine]), [['Loved your theory thread.', false]]);
  inbox = (await b.c.get('/api/messages/conversations')).json;
  assert.equal(inbox.unread, 0, 'opening the conversation marks it read');
  assert.equal((await quiet.c.get(`/api/messages/conversations/${inbox.items[0].id}`)).status, 404, 'not a participant');
  // someone with messages off can start a conversation and then be answered in it
  assert.equal((await quiet.c.post('/api/messages', { to: a.user.username, body: 'Quick question.' })).status, 200);
  assert.equal((await a.c.post('/api/messages', { to: quiet.user.username, body: 'Sure.' })).status, 200);

  const bell = (await b.c.get('/api/notifications')).json;
  assert.ok(bell.unread >= 1);
  const one1 = (await b.c.post(`/api/notifications/${bell.items[0].id}/read`)).json;
  assert.equal(one1.unread, bell.unread - 1);
  assert.deepEqual((await b.c.post('/api/notifications/read-all')).json, { ok: true, unread: 0 });
  assert.equal((await b.c.get('/api/auth/me')).json.user.unread_notifications, 0);

  const anon = new Client();
  await anon.get('/api/bootstrap');
  assert.equal((await anon.post('/api/feedback', { category: 'idea', body: 'Dark mode for the reader, please.', email: 'visitor@test.invalid', page_url: '/read/x' })).status, 200);
  assert.equal((await a.c.post('/api/feedback', { body: '' })).status, 400);
  const fb = await one(`select user_id, email, category, status from feedback order by created_at desc limit 1`);
  assert.deepEqual([fb!.user_id, fb!.email, fb!.category, fb!.status], [null, 'visitor@test.invalid', 'idea', 'new']);
});

test('account: profile, avatar, settings with the 18+ confirmation, email and password changes, sessions, deletion', async () => {
  const { user, c } = await signedIn({ password: 'first password 123' });
  const acct = (await c.get('/api/account')).json;
  assert.deepEqual([acct.profile.username, acct.prefs.show_mature, acct.prefs.allow_dms, acct.prefs.notify.releases, acct.prefs.notify.newsletter], [user.username, false, true, true, false]);
  assert.equal((await c.call('PATCH', '/api/account/profile', { display_name: 'Ada L.', bio: 'Reads everything.' })).json.profile.display_name, 'Ada L.');

  // avatar: multipart upload -> 256px webp under public/avatars
  const sharp = (await import('sharp')).default;
  const png = await sharp({ create: { width: 600, height: 400, channels: 3, background: '#c33' } }).png().toBuffer();
  const boundary = 'xBOUNDARYx';
  const payload = Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="me.png"\r\nContent-Type: image/png\r\n\r\n`), png, Buffer.from(`\r\n--${boundary}--\r\n`)]);
  const up = await app.inject({ method: 'POST', url: '/api/account/avatar', headers: { cookie: Object.entries(c.cookies).map(([k, v]) => `${k}=${v}`).join('; '), 'x-csrf-token': c.cookies.csrf_token, 'content-type': `multipart/form-data; boundary=${boundary}` }, payload });
  assert.equal(up.statusCode, 200, up.payload);
  assert.match(up.json().avatar_url, /^\/media\/public\/avatars\/.+\.webp$/);
  const pic = await app.inject({ method: 'GET', url: up.json().avatar_url });
  const meta = await sharp(pic.rawPayload).metadata();
  assert.deepEqual([meta.format, meta.width, meta.height], ['webp', 256, 256]);
  assert.equal((await c.get(`/api/users/${user.username}`)).json.user.name, 'Ada L.');

  // mature content needs an explicit confirmation in the same request
  const no = await c.call('PATCH', '/api/account/prefs', { show_mature: true });
  assert.deepEqual([no.status, no.json.code], [400, 'confirm_adult']);
  const yes = await c.call('PATCH', '/api/account/prefs', { show_mature: true, confirm_adult: true, country: 'gb', reading_language: 'fr', favorite_genre: 'horror_mystery', show_real_name: false, allow_dms: false, beta: true, notify: { releases: false, newsletter: true } });
  assert.equal(yes.status, 200, yes.res.payload);
  assert.deepEqual(
    [yes.json.prefs.show_mature, yes.json.prefs.country, yes.json.prefs.reading_language, yes.json.prefs.favorite_genre, yes.json.prefs.show_real_name, yes.json.prefs.allow_dms, yes.json.prefs.beta, yes.json.prefs.notify.releases, yes.json.prefs.notify.messages, yes.json.prefs.notify.newsletter],
    [true, 'GB', 'fr', 'horror_mystery', false, false, true, false, true, true],
  );
  assert.equal((await one('select marketing_opt_in from users where id = $1', [user.id]))!.marketing_opt_in, true);
  assert.equal((await c.call('PATCH', '/api/account/prefs', { favorite_genre: 'polka' })).status, 400);
  assert.equal((await c.get(`/api/users/${user.username}`)).json.user.name, user.username, 'real name hidden');

  // email change: password required, link goes to the new address, nothing changes until it is confirmed
  assert.equal((await c.post('/api/account/email', { new_email: 'new-ada@test.invalid', current_password: 'wrong' })).status, 403);
  assert.equal((await c.post('/api/account/email', { new_email: owner.email, current_password: 'first password 123' })).status, 409);
  const fresh = `ada-${Date.now()}@test.invalid`;
  assert.equal((await c.post('/api/account/email', { new_email: fresh.toUpperCase(), current_password: 'first password 123' })).json.sent_to, fresh);
  const mail = await one(`select to_email, html from emails where template = 'email_change' and user_id = $1`, [user.id]);
  assert.equal(mail!.to_email, fresh);
  assert.equal((await one('select email from users where id = $1', [user.id]))!.email, user.email);
  const token = /confirm-email\?token=([A-Za-z0-9_-]+)/.exec(mail!.html)![1];
  assert.equal((await c.post('/api/auth/confirm-email-change', { token })).status, 200);
  assert.equal((await one('select email from users where id = $1', [user.id]))!.email, fresh);

  // password change signs out every other session
  const phone = await new Client().login(fresh, 'first password 123');
  const sess = (await c.get('/api/account/sessions')).json.items;
  assert.deepEqual([sess.length, sess.filter((s: any) => s.current).length], [2, 1]);
  assert.ok(sess.every((s: any) => /^[0-9a-f]{16}$/.test(s.id)));
  assert.match((await c.post('/api/account/password', { current_password: 'first password 123', new_password: 'short' })).json.error, /at least 10 characters/);
  assert.equal((await c.post('/api/account/password', { current_password: 'nope', new_password: 'second password 456' })).status, 403);
  assert.deepEqual((await c.post('/api/account/password', { current_password: 'first password 123', new_password: 'second password 456' })).json, { ok: true, sessions_signed_out: 1 });
  assert.equal((await phone.get('/api/account')).status, 401);
  assert.equal((await c.get('/api/account')).status, 200);
  const tablet = await new Client().login(fresh, 'second password 456');
  const other = (await c.get('/api/account/sessions')).json.items.find((s: any) => !s.current);
  assert.equal((await c.call('DELETE', `/api/account/sessions/${other.id}`)).status, 200);
  assert.equal((await tablet.get('/api/account')).status, 401);

  // deletion: password, membership stops, personal details go, purchases stay attributable
  await c.post('/api/membership/start', { plan: 'monthly' });
  await c.post(`/api/series/${premium.slug}/follow`);
  const followers = (await one('select follower_count from series where id = $1', [premium.id]))!.follower_count;
  assert.equal((await c.post('/api/account/delete', { password: 'wrong' })).status, 403);
  assert.equal((await c.post('/api/account/delete', { password: 'second password 456' })).status, 200);
  const gone = await one('select email, username, display_name, bio, avatar_key, prefs, deleted_at from users where id = $1', [user.id]);
  assert.match(gone!.email, /^deleted-[0-9a-f]+@deleted\.invalid$/);
  assert.deepEqual([gone!.display_name, gone!.bio, gone!.avatar_key, gone!.prefs, Boolean(gone!.deleted_at)], ['Deleted user', '', null, {}, true]);
  const sub = await one('select status, cancel_at_period_end, payment_method_token from subscriptions where user_id = $1', [user.id]);
  assert.deepEqual([sub!.status, sub!.cancel_at_period_end, sub!.payment_method_token], ['canceled', true, null]);
  assert.equal((await one('select follower_count from series where id = $1', [premium.id]))!.follower_count, followers - 1);
  assert.equal((await c.get('/api/account')).status, 401);
  assert.equal((await app.inject({ method: 'GET', url: up.json().avatar_url })).statusCode, 404, 'avatar file removed');
  const again = new Client();
  await again.get('/api/bootstrap');
  assert.equal((await again.post('/api/auth/login', { email: fresh, password: 'second password 456' })).status, 401);

  // the sole owner of a brand has to hand it over first
  const boss = await new Client().login(owner.email);
  assert.match((await boss.post('/api/account/delete', { password: 'correct horse battery' })).json.error, /only owner/);
});

test('widgets: self-contained, frameable, safe with odd input', async () => {
  const btn = await app.inject({ method: 'GET', url: `/widgets/read-now/${premium.slug}?color=%23ff6600&size=large` });
  assert.equal(btn.statusCode, 200);
  assert.match(btn.headers['content-type'] as string, /^text\/html/);
  assert.match(btn.headers['content-security-policy'] as string, /frame-ancestors \*/);
  assert.equal(btn.headers['x-frame-options'], undefined);
  assert.match(btn.payload, /background:#ff6600/);
  assert.match(btn.payload, new RegExp(`href="[^"]+/series/${premium.slug}\\?utm_source=widget`));
  assert.match(btn.payload, />Read now<\/a>/);
  assert.ok(!/<script/i.test(btn.payload));
  const odd = await app.inject({ method: 'GET', url: `/widgets/read-now/${premium.slug}?color=red;}</style><script>alert(1)</script>&size=huge&label=%3Cb%3EGo%3C/b%3E` });
  assert.equal(odd.statusCode, 200);
  assert.ok(!/<script|<b>/i.test(odd.payload));
  assert.match(odd.payload, /background:#1a1c20/);
  const card = await app.inject({ method: 'GET', url: `/widgets/card/${premium.slug}?theme=dark` });
  assert.equal(card.statusCode, 200);
  assert.ok(card.payload.includes(premium.title));
  assert.equal((await app.inject({ method: 'GET', url: '/widgets/card/no-such-series' })).statusCode, 404);
});
