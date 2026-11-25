import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { after, before, test } from 'node:test';
import { fixtures, useTestDatabase } from '../lib/commerce.testkit.ts';

/** Follow-up fixes, end to end through the HTTP stack (app.inject) with sandbox payments. */
await useTestDatabase('readerfixes');
process.env.ROUTES = 'auth,catalog,reader,library,social,account,commerce';
const { exec, one, q, pool } = await import('../db.ts');
const { setSetting } = await import('../lib/settings.ts');
const { TEMPLATES } = await import('../lib/email.ts');
const pay = await import('../lib/payments.ts');
const { isoWeek, runWeeklyDigests } = await import('../jobs/weekly-digests.ts');
const { buildApp } = await import('../server.ts');
const f = await fixtures();
const app = await buildApp();

let clients = 0;
class Client {
  cookies: Record<string, string> = {};
  // Each client is its own network address, so per-address sign-in limits do not couple the tests.
  ip = `10.77.${Math.floor(++clients / 250)}.${(clients % 250) + 1}`;
  async call(method: string, url: string, body?: unknown) {
    const cookie = Object.entries(this.cookies).map(([k, v]) => `${k}=${v}`).join('; ');
    const res = await app.inject({
      method: method as 'GET', url,
      headers: { ...(cookie ? { cookie } : {}), ...(this.cookies.csrf_token ? { 'x-csrf-token': this.cookies.csrf_token } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}), 'user-agent': 'Mozilla/5.0 (Test)', 'x-forwarded-for': this.ip },
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
      // not JSON
    }
    return { status: res.statusCode, json, res };
  }
  get = (url: string) => this.call('GET', url);
  post = (url: string, body: unknown = {}) => this.call('POST', url, body);
  patch = (url: string, body: unknown = {}) => this.call('PATCH', url, body);
  async login(email: string, extra: Record<string, unknown> = {}) {
    await this.get('/api/bootstrap');
    return this.post('/api/auth/login', { email, password: 'correct horse battery', ...extra });
  }
}
const signedIn = async (over: Parameters<typeof f.user>[0] = {}) => {
  const user = await f.user(over);
  const c = new Client();
  assert.equal((await c.login(user.email)).status, 200);
  return { user, c };
};

/** RFC 6238 code for a base32 secret, as an authenticator app would show it. */
function totp(secret: string, at = Date.now()): string {
  const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const ch of secret) bits += B32.indexOf(ch).toString(2).padStart(5, '0');
  const key = Buffer.from(bits.match(/.{8}/g)!.map((b) => parseInt(b, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(at / 30_000)));
  const h = createHmac('sha1', key).update(counter).digest();
  const o = h[h.length - 1] & 0xf;
  return String((((h[o] & 0x7f) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3]) % 1_000_000).padStart(6, '0');
}

let owner: Awaited<ReturnType<typeof f.user>>;
let brand: any, payee: any, series: any, r1: any, r2: any, r3: any;

before(async () => {
  await setSetting('payments', { provider: 'sandbox' }, null);
  await setSetting('membership', { trial_days: 0, monthly_cents: 599, annual_cents: 5900, page_credit_cents: 5 }, null);
  owner = await f.user();
  brand = await f.brand(owner.id);
  payee = await f.brand((await f.user()).id);
  // "automatic" preview: the first release is free to read, the rest are sold. Release 3 has its own price.
  series = await f.series(brand.id, { title: `Paper Robots ${Date.now()}`, free_preview: { mode: 'automatic' }, forum_enabled: true });
  r1 = await f.release(series.id, { number: 1 }, 3);
  r2 = await f.release(series.id, { number: 2 }, 7);
  r3 = await f.release(series.id, { number: 3, price_cents: 301 }, 7);
  await exec('insert into revenue_splits (series_id, payee_publisher_id, share_bps) values ($1,$2,2500)', [series.id, payee.id]);
  await exec(`insert into discounts (publisher_id, series_id, percent_off, applies_to, label, active, starts_at) values ($1,null,10,'read','Launch week',true, now() - interval '1 hour')`, [brand.id]);
});
after(async () => {
  await app.close();
  await pool.end();
});

test('quote: same numbers as the checkout that follows; sale, code and credit itemized; a bad code fails before any payment', async () => {
  const { user, c } = await signedIn();
  await exec(`insert into promo_codes (publisher_id, code, kind, percent_off) values ($1,$2,'discount',25)`, [brand.id, `Q25-${user.username}`]);
  await exec(`insert into wallets (user_id, credit_cents) values ($1, 150)`, [user.id]);
  const basket = { items: [{ kind: 'release', id: r2.id }, { kind: 'tip', id: brand.slug, amount_cents: 500 }], code: `q25-${user.username}`, use_credit: true };

  const anon = new Client();
  await anon.get('/api/bootstrap');
  assert.equal((await anon.post('/api/checkout/quote', basket)).status, 401);
  const qt = await c.post('/api/checkout/quote', basket);
  assert.equal(qt.status, 200, qt.res.payload);
  // 199 list, 10% sale = 179, then 25% code = 134 (45 off); the tip is never discounted
  assert.deepEqual(qt.json.lines.map((l: any) => [l.kind, l.list_price_cents, l.sale_discount_cents, l.code_discount_cents, l.price_cents]), [['release', 199, 20, 45, 134], ['tip', 500, 0, 0, 500]]);
  assert.deepEqual(
    [qt.json.list_price_cents, qt.json.discounts, qt.json.code.percent_off, qt.json.total_cents, qt.json.credit_available_cents, qt.json.credit_applied_cents, qt.json.amount_due_cents, qt.json.problem],
    [699, { sale_cents: 20, code_cents: 45 }, 25, 634, 150, 150, 484, null],
  );
  assert.equal(qt.json.list_price_cents - qt.json.discounts.sale_cents - qt.json.discounts.code_cents - qt.json.credit_applied_cents, qt.json.amount_due_cents);
  // no side effects: no order, credit untouched, code not used
  assert.equal((await one<{ n: number }>('select count(*)::int as n from orders where user_id = $1', [user.id]))!.n, 0);
  assert.equal((await one('select credit_cents from wallets where user_id = $1', [user.id]))!.credit_cents, 150);
  assert.equal((await one('select redeemed_count from promo_codes where code = $1', [`Q25-${user.username}`]))!.redeemed_count, 0);

  const without = (await c.post('/api/checkout/quote', { ...basket, use_credit: false })).json;
  assert.deepEqual([without.credit_applied_cents, without.amount_due_cents], [0, 634]);

  const bad = await c.post('/api/checkout/quote', { ...basket, code: 'NOPE-NOPE' });
  assert.deepEqual([bad.status, bad.json.code], [400, 'code_invalid']);
  assert.match(bad.json.error, /not valid/);
  const small = (await c.post('/api/checkout/quote', { items: [{ kind: 'credits', quantity: 3 }] })).json;
  assert.deepEqual([small.amount_due_cents, small.problem.code], [15, 'below_minimum']);

  const buy = await c.post('/api/checkout', basket);
  assert.equal(buy.json.completed, true, buy.res.payload);
  const o = (await c.get(`/api/orders/${buy.json.order_id}`)).json.order;
  assert.deepEqual([o.total_cents, o.credit_cents, o.charged_cents], [qt.json.total_cents, qt.json.credit_applied_cents, qt.json.amount_due_cents]);
  assert.deepEqual(o.items.map((i: any) => i.price_cents), qt.json.lines.map((l: any) => l.price_cents));
  // order lines carry what the web needs to link them
  assert.deepEqual([o.items[0].series_slug, o.items[0].series_title, o.items[0].release_ids, o.items[1].publisher_slug], [series.slug, series.title, [r2.id], brand.slug]);
  const hist = (await c.get('/api/account/orders')).json.items[0];
  assert.deepEqual([hist.items[0].series_slug, hist.items[0].release_id, hist.items[1].series_slug, hist.items[1].publisher_slug], [series.slug, r2.id, null, brand.slug]);
});

test('series price and per-release prices agree for every reader state', async () => {
  const check = async (c: Client, who: string) => {
    const page = (await c.get(`/api/series/${series.slug}`)).json;
    const rels = page.release_groups.flatMap((g: any) => g.releases);
    const priced = rels.filter((r: any) => r.access.read_price_cents !== null);
    const sum = priced.reduce((n: number, r: any) => n + r.access.read_price_cents, 0);
    const list = priced.reduce((n: number, r: any) => n + r.access.read_list_price_cents, 0);
    assert.deepEqual([...page.offers.series_release_ids].sort(), priced.map((r: any) => r.id).sort(), `${who}: the series offer covers exactly the releases that show a price`);
    assert.equal(page.offers.series_release_count, priced.length, who);
    assert.equal(page.offers.series_price_cents, priced.length > 1 ? sum : null, `${who}: series price is the sum of the release prices`);
    assert.equal(page.offers.series_list_price_cents, priced.length > 1 ? list : null, who);
    return { page, rels, priced, sum };
  };

  // anonymous: release 1 is free under the preview rule, so it has no price and is not in the series price
  const anon = new Client();
  await anon.get('/api/bootstrap');
  const a = await check(anon, 'anonymous');
  assert.deepEqual(a.rels.map((r: any) => [r.number, r.access.status, r.access.read_price_cents]), [[1, 'free', null], [2, 'preview', 179], [3, 'preview', 271]]);
  assert.equal(a.page.offers.series_price_cents, 450);

  const reader = await signedIn();
  assert.equal((await check(reader.c, 'signed in')).sum, 450);

  // a member can read everything and can still buy to keep: prices and series price stay, and agree
  const member = await signedIn();
  assert.equal((await member.c.post('/api/membership/start', { plan: 'monthly' })).json.completed, true);
  const m = await check(member.c, 'member');
  assert.deepEqual(m.rels.map((r: any) => [r.access.status, r.access.read_price_cents]), [['free', null], ['membership', 179], ['membership', 271]]);
  assert.equal(m.page.offers.series_price_cents, 450);
  // …and the checkout charges exactly that, for exactly those releases
  const quote = (await member.c.post('/api/checkout/quote', { items: [{ kind: 'series', id: series.slug }] })).json;
  assert.deepEqual([quote.total_cents, quote.list_price_cents], [450, 500]);
  assert.match((await member.c.post('/api/checkout', { items: [{ kind: 'release', id: r1.id }] })).json.error, /free to read/);

  // owner of some releases: only what is left is offered, and one release alone is not a "series" offer
  const some = await signedIn();
  assert.equal((await some.c.post('/api/checkout', { items: [{ kind: 'release', id: r2.id }] })).json.completed, true);
  const s = await check(some.c, 'owner of release 2');
  assert.deepEqual(s.rels.map((r: any) => [r.access.status, r.access.read_price_cents]), [['free', null], ['owned', null], ['preview', 271]]);
  assert.deepEqual([s.page.offers.series_price_cents, s.page.offers.series_release_count], [null, 1]);
  const rest = await some.c.post('/api/checkout', { items: [{ kind: 'series', id: series.slug }] });
  assert.equal((await one('select total_cents from orders where id = $1', [rest.json.order_id]))!.total_cents, 271);
  assert.equal((await check(some.c, 'owner of everything')).priced.length, 0);

  // the brand's own team sees no prices and no series offer
  const team = new Client();
  await team.login(owner.email);
  const t = await check(team, 'brand owner');
  assert.equal(t.priced.length, 0);
  assert.match((await team.post('/api/checkout/quote', { items: [{ kind: 'series', id: series.slug }] })).json.error, /nothing left to buy/);

  // the reader manifest quotes the same series price
  const manifest = (await reader.c.get(`/api/releases/${r2.id}`)).json;
  assert.deepEqual([manifest.offers.read_price_cents, manifest.offers.series_price_cents], [179, 450]);
});

test('a tip accepts a brand id, a brand slug, or a series slug / id; anything else says what was wrong', async () => {
  const { c } = await signedIn();
  for (const id of [brand.id, brand.slug, series.slug, series.id]) {
    const qt = await c.post('/api/checkout/quote', { items: [{ kind: 'tip', id, amount_cents: 300 }] });
    assert.deepEqual([qt.status, qt.json.lines?.[0].publisher_id, qt.json.lines?.[0].description], [200, brand.id, `Tip for ${brand.name}`], `tip id ${id}`);
  }
  const done = await c.post('/api/checkout', { items: [{ kind: 'tip', id: series.slug, amount_cents: 300 }] });
  assert.equal(done.json.completed, true);
  assert.equal((await one('select publisher_id from tips where order_id = $1', [done.json.order_id]))!.publisher_id, brand.id);
  const none = await c.post('/api/checkout', { items: [{ kind: 'tip', id: 'no-such-thing', amount_cents: 300 }] });
  assert.equal(none.status, 404);
  assert.match(none.json.error, /No brand or series matches "no-such-thing".*brand's slug or id/);
  await exec('update publishers set tips_enabled = false where id = $1', [payee.id]);
  assert.match((await c.post('/api/checkout', { items: [{ kind: 'tip', id: payee.slug, amount_cents: 300 }] })).json.error, /is not accepting tips/);
});

test('an unconfirmed email gets a clear 403 (email_unverified) from paying and posting; reading, following and redeeming stay open', async () => {
  const { user, c } = await signedIn({ verified: false });
  const ok = await signedIn();
  const thread = (await ok.c.post('/api/forums/threads', { series_id: series.id, title: 'Favorite robot?', body: 'Mine is the tall one.' })).json.thread;
  const mine = (await ok.c.get(`/api/forums/threads/${thread.id}`)).json.posts[0];

  const refused: [string, string, unknown][] = [
    ['POST', '/api/checkout', { items: [{ kind: 'release', id: r2.id }] }],
    ['POST', '/api/checkout', { items: [{ kind: 'tip', id: brand.slug, amount_cents: 300 }] }],
    ['POST', '/api/checkout', { items: [{ kind: 'gift_card', amount_cents: 1000 }] }],
    ['POST', '/api/checkout', { items: [{ kind: 'credits', quantity: 20 }] }],
    ['POST', '/api/membership/start', { plan: 'monthly' }],
    ['POST', '/api/comments', { series_id: series.id, body: 'First!' }],
    ['POST', '/api/forums/threads', { series_id: series.id, title: 'Hello there', body: 'Hi' }],
    ['POST', `/api/forums/threads/${thread.id}/posts`, { body: 'Me too' }],
    ['PATCH', `/api/forums/posts/${mine.id}`, { body: 'Edited' }],
    ['POST', '/api/reports', { target_kind: 'series', target_id: series.id, reason: 'Spam or scam' }],
    ['POST', '/api/messages', { to: ok.user.username, body: 'Hello' }],
  ];
  for (const [method, url, body] of refused) {
    const r = await c.call(method, url, body);
    assert.deepEqual([r.status, r.json.code], [403, 'email_unverified'], `${method} ${url} ${JSON.stringify(body)}`);
    assert.match(r.json.error, /^Confirm your email to /);
  }
  assert.equal((await one<{ n: number }>('select count(*)::int as n from orders where user_id = $1', [user.id]))!.n, 0);

  // still open
  assert.equal((await c.get(`/api/releases/${r1.id}`)).status, 200);
  assert.equal((await c.post(`/api/series/${series.slug}/follow`)).status, 200);
  assert.equal((await c.post(`/api/series/${series.slug}/favorite`)).status, 200);
  assert.equal((await c.post('/api/checkout/quote', { items: [{ kind: 'release', id: r2.id }] })).status, 200, 'a price can be looked at');
  await exec(`insert into promo_codes (publisher_id, code, kind, release_id) values ($1,$2,'unlock',$3)`, [brand.id, `UNLOCK-${user.username}`, r3.id]);
  assert.equal((await c.post('/api/codes/redeem', { code: `UNLOCK-${user.username}` })).json.kind, 'unlock');

  // confirm through the emailed link, then the same calls go through
  assert.equal((await c.post('/api/auth/resend-verification')).status, 200);
  const mail = await one(`select text_body from emails where template = 'verify_email' and user_id = $1 order by created_at desc limit 1`, [user.id]);
  const token = /verify-email\?token=([\w-]+)/.exec(mail!.text_body)![1];
  assert.equal((await c.post('/api/auth/verify-email', { token })).status, 200);
  assert.equal((await c.post('/api/checkout', { items: [{ kind: 'release', id: r2.id }] })).json.completed, true);
  assert.equal((await c.post('/api/comments', { series_id: series.id, body: 'First!' })).status, 200);
});

test('membership start honors a same-site next path and hands it to the hosted flow', async () => {
  const { c } = await signedIn();
  const off = await signedIn();
  assert.equal((await off.c.post('/api/membership/start', { plan: 'monthly', next: 'https://evil.example/x' })).json.next, null, 'off-site paths are dropped');
  assert.equal((await (await signedIn()).c.post('/api/membership/start', { plan: 'monthly', next: '//evil.example' })).json.next, null);
  const r = await c.post('/api/membership/start', { plan: 'monthly', next: `/read/${r2.id}?page=3` });
  assert.deepEqual([r.json.completed, r.json.next, r.json.member], [true, `/read/${r2.id}?page=3`, true]);

  // hosted provider: the return and cancel URLs carry it
  const seen: any[] = [];
  const { createServer } = await import('node:http');
  const fake = createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => (raw += d));
    req.on('end', () => {
      seen.push(JSON.parse(raw));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ success: true, sessionId: `cs_next_${Date.now()}`, checkoutUrl: 'https://pay.example/checkout/x' }));
    });
  });
  await new Promise<void>((done) => fake.listen(0, '127.0.0.1', done));
  try {
    await setSetting('payments', { provider: 'divinity', divinity_api_url: `http://127.0.0.1:${(fake.address() as { port: number }).port}/internal`, divinity_partner_id: 'p', divinity_api_key: 'k' }, null);
    const h = await (await signedIn()).c.post('/api/membership/start', { plan: 'annual', next: '/series/paper-robots?tab=releases' });
    assert.deepEqual([h.json.url, h.json.status, h.json.next], ['https://pay.example/checkout/x', 'pending', '/series/paper-robots?tab=releases']);
    assert.match(seen[0].returnUrl, /\/account\/membership\?next=%2Fseries%2Fpaper-robots%3Ftab%3Dreleases$/);
    assert.match(seen[0].cancelUrl, /\/account\/membership\?cancelled=1&next=%2Fseries%2Fpaper-robots%3Ftab%3Dreleases$/);
    await (await signedIn()).c.post('/api/membership/start', { plan: 'annual' });
    assert.match(seen[1].returnUrl, /\/account\/membership$/);
  } finally {
    fake.close();
    await setSetting('payments', { provider: 'sandbox' }, null);
  }
});

test('membership payments are listed for the account', async () => {
  const { user, c } = await signedIn();
  assert.deepEqual((await c.get('/api/account/membership-payments')).json.items, []);
  await c.post('/api/membership/start', { plan: 'monthly' });
  const list = (await c.get('/api/account/membership-payments')).json;
  assert.deepEqual(list.items.map((p: any) => [p.status, p.amount_cents, p.plan]), [['paid', 599, 'monthly']]);
  assert.ok(list.items[0].date && list.items[0].period_end);
  assert.equal(list.total, 1);
  const ch = await one('select id from subscription_charges where user_id = $1', [user.id]);
  await pay.reverseChargeBooks(ch!.id, { reason: 'Asked nicely' });
  assert.equal((await c.get('/api/account/membership-payments')).json.items[0].status, 'refunded');
  assert.equal((await (await signedIn()).c.get('/api/account/membership-payments')).json.total, 0, 'only your own');
});

test('direct messages: one rule for can_reply and for sending', async () => {
  const quiet = await signedIn({ prefs: { allow_dms: false } });
  const other = await signedIn();
  // nobody can start a conversation with someone who has DMs off
  const no = await other.c.post('/api/messages', { to: quiet.user.username, body: 'Hi?' });
  assert.equal(no.status, 403);
  assert.match(no.json.error, /not accepting direct messages/);
  // but once they have written in a conversation, the other person can reply there, and the view says so
  const first = await quiet.c.post('/api/messages', { to: other.user.username, body: 'I have a question about your comic.' });
  assert.equal(first.status, 200, first.res.payload);
  const view = (await other.c.get(`/api/messages/conversations/${first.json.conversation_id}`)).json;
  assert.deepEqual([view.conversation.can_reply, view.conversation.cannot_reply_reason], [true, null]);
  assert.equal((await other.c.post('/api/messages', { to: quiet.user.username, body: 'Ask away.' })).status, 200);

  // the other way round: they never wrote, DMs go off afterwards -> view and send both say no
  const a = await signedIn();
  const b = await signedIn();
  const started = await a.c.post('/api/messages', { to: b.user.username, body: 'Hello' });
  await b.c.patch('/api/account/prefs', { allow_dms: false });
  const v2 = (await a.c.get(`/api/messages/conversations/${started.json.conversation_id}`)).json;
  assert.equal(v2.conversation.can_reply, false);
  assert.match(v2.conversation.cannot_reply_reason, /not accepting direct messages/);
  assert.equal((await a.c.post('/api/messages', { to: b.user.username, body: 'Still there?' })).status, 403);
  // b themselves can always write to a (a accepts messages)
  assert.equal((await b.c.get(`/api/messages/conversations/${started.json.conversation_id}`)).json.conversation.can_reply, true);
  // a banned account closes the conversation on both endpoints
  await exec('update users set banned_at = now() where id = $1', [b.user.id]);
  assert.equal((await a.c.get(`/api/messages/conversations/${started.json.conversation_id}`)).json.conversation.can_reply, false);
  assert.equal((await a.c.post('/api/messages', { to: b.user.username, body: 'x' })).status, 404);
});

test('forum threads and posts can be reported', async () => {
  const author = await signedIn();
  const reporter = await signedIn();
  const thread = (await author.c.post('/api/forums/threads', { board: 'general', title: 'Buy cheap watches', body: 'Click here' })).json.thread;
  const post = (await author.c.post(`/api/forums/threads/${thread.id}/posts`, { body: 'Really cheap' })).json.post;
  assert.equal((await reporter.c.post('/api/reports', { target_kind: 'forum_thread', target_id: thread.id, reason: 'Spam or scam' })).status, 200);
  assert.equal((await reporter.c.post('/api/reports', { target_kind: 'forum_post', target_id: post.id, reason: 'Spam or scam', detail: 'Same link again' })).status, 200);
  await reporter.c.post('/api/reports', { target_kind: 'forum_post', target_id: post.id, reason: 'Spam or scam' });
  const rows = await q('select target_kind, target_id, detail from reports where reporter_id = $1 order by target_kind', [reporter.user.id]);
  assert.deepEqual(rows.map((r) => [r.target_kind, r.target_id, r.detail]), [['forum_post', post.id, 'Same link again'], ['forum_thread', thread.id, '']], 'one open report per person per item');
  assert.equal((await reporter.c.post('/api/reports', { target_kind: 'forum_post', target_id: thread.id, reason: 'Spam or scam' })).status, 404, 'a thread id is not a post');
  await author.c.call('DELETE', `/api/forums/posts/${post.id}`);
  assert.equal((await (await signedIn()).c.post('/api/reports', { target_kind: 'forum_post', target_id: post.id, reason: 'Spam or scam' })).status, 404);
  assert.equal((await reporter.c.post('/api/reports', { target_kind: 'page', target_id: post.id, reason: 'x y' })).status, 400);
});

test('two-factor sign-in for any account: begin, confirm, backup codes once, sign in with a code, disable', async () => {
  const { user, c } = await signedIn();
  assert.deepEqual((await c.get('/api/account/2fa')).json, { enabled: false, enrolment_pending: false, backup_codes_left: 0 });
  assert.equal((await new Client().get('/api/account/2fa')).status, 401);
  assert.equal((await c.post('/api/account/2fa/confirm', { code: '123456' })).status, 400, 'nothing to confirm yet');
  const begin = (await c.post('/api/account/2fa/begin')).json;
  assert.match(begin.secret, /^[A-Z2-7]{32}$/);
  assert.ok(begin.otpauth_url.startsWith('otpauth://totp/') && begin.otpauth_url.includes(encodeURIComponent(user.email)));
  assert.ok(begin.qr_data_url.startsWith('data:image/png;base64,'));
  assert.equal((await c.get('/api/account/2fa')).json.enrolment_pending, true);
  // not enforced until confirmed
  assert.equal((await new Client().login(user.email)).status, 200);
  const wrong = String((Number(totp(begin.secret)) + 1) % 1_000_000).padStart(6, '0');
  assert.equal((await c.post('/api/account/2fa/confirm', { code: wrong })).status, 400);
  const done = (await c.post('/api/account/2fa/confirm', { code: totp(begin.secret) })).json;
  assert.equal(done.backup_codes.length, 10);
  const stored = await one('select totp_enabled, totp_backup_codes from users where id = $1', [user.id]);
  assert.equal(stored!.totp_enabled, true);
  assert.ok(stored!.totp_backup_codes.every((h: string) => /^[0-9a-f]{64}$/.test(h)) && !stored!.totp_backup_codes.includes(done.backup_codes[0]), 'only hashes are stored');
  assert.deepEqual((await c.get('/api/account/2fa')).json, { enabled: true, enrolment_pending: false, backup_codes_left: 10 });
  assert.equal((await c.get('/api/account')).json.profile.totp_enabled, true);
  assert.equal((await c.post('/api/account/2fa/begin')).status, 409);

  // signing in now needs the code; a backup code works once
  const fresh = new Client();
  const need = await fresh.login(user.email);
  assert.deepEqual([need.status, need.json.code], [401, 'totp_required']);
  assert.equal((await fresh.login(user.email, { totp: totp(begin.secret) })).status, 200);
  assert.equal((await new Client().login(user.email, { totp: done.backup_codes[0] })).status, 200);
  assert.equal((await new Client().login(user.email, { totp: done.backup_codes[0] })).status, 401);
  assert.equal((await c.get('/api/account/2fa')).json.backup_codes_left, 9);

  const again = (await c.post('/api/account/2fa/backup-codes', { code: totp(begin.secret) })).json;
  assert.equal(again.backup_codes.length, 10);
  assert.equal((await new Client().login(user.email, { totp: done.backup_codes[1] })).status, 401, 'old backup codes stop working');

  assert.equal((await c.post('/api/account/2fa/disable', { password: 'wrong', code: totp(begin.secret) })).status, 400);
  assert.equal((await c.post('/api/account/2fa/disable', { password: 'correct horse battery', code: '000000' })).status, 400);
  assert.deepEqual((await c.post('/api/account/2fa/disable', { password: 'correct horse battery', code: again.backup_codes[3] })).json, { ok: true, setup_required: false });
  const off = await one('select totp_enabled, totp_secret, totp_backup_codes from users where id = $1', [user.id]);
  assert.deepEqual([off!.totp_enabled, off!.totp_secret, off!.totp_backup_codes], [false, null, []]);
  assert.equal((await new Client().login(user.email)).status, 200);
});

test('bootstrap exposes the password minimum length', async () => {
  const c = new Client();
  assert.equal((await c.get('/api/bootstrap')).json.settings.password_min_length, 10);
  await setSetting('security', { password_min_length: 14 }, null);
  try {
    assert.equal((await c.get('/api/bootstrap')).json.settings.password_min_length, 14);
  } finally {
    await setSetting('security', { password_min_length: 10 }, null);
  }
});

test('reply, mention and membership-billing emails are editable templates rendered through sendTemplate', async () => {
  for (const key of ['notice_reply', 'notice_mention', 'membership_billing', 'weekly_feed', 'weekly_analytics']) assert.ok(TEMPLATES[key], key);
  assert.deepEqual([TEMPLATES.notice_reply.category, TEMPLATES.notice_mention.category, TEMPLATES.membership_billing.category], ['notification', 'notification', 'transactional']);
  const a = await signedIn();
  const b = await signedIn();
  await exec(`insert into email_templates (key, subject, html) values ('notice_reply', 'Edited: {{title}}', '<p>EDITED {{preview}}</p>{{button:Go|url}}') on conflict (key) do update set subject = excluded.subject, html = excluded.html`);
  try {
    const top = (await a.c.post('/api/comments', { series_id: series.id, body: 'What a cliffhanger' })).json.comment;
    await b.c.post('/api/comments', { series_id: series.id, parent_id: top.id, body: `Agreed <b>totally</b>, and @${owner.username} should know` });
    const reply = await one(`select subject, html, category from emails where template = 'notice_reply' and user_id = $1`, [a.user.id]);
    assert.match(reply!.subject, /^Edited: .* replied to your comment on Paper Robots/);
    assert.ok(reply!.html.includes('EDITED Agreed &lt;b&gt;totally&lt;/b&gt;') && reply!.html.includes('/api/unsubscribe?token='), 'admin override used, text escaped, unsubscribe footer present');
    assert.equal(reply!.category, 'notification');
    const mention = await one(`select subject, html from emails where template = 'notice_mention' and user_id = $1`, [owner.id]);
    assert.match(mention!.subject, /mentioned you in Paper Robots/);
    assert.ok(mention!.html.includes('#comment-'));
  } finally {
    await exec(`delete from email_templates where key = 'notice_reply'`);
  }
  // a reader who turned reply emails off gets the notification but no email
  const quiet = await signedIn({ prefs: { notify: { replies: false } } });
  const t2 = (await quiet.c.post('/api/comments', { series_id: series.id, body: 'Quiet comment' })).json.comment;
  await b.c.post('/api/comments', { series_id: series.id, parent_id: t2.id, body: 'A reply' });
  assert.equal(await one(`select 1 from emails where template = 'notice_reply' and user_id = $1`, [quiet.user.id]), null);
  assert.ok((await quiet.c.get('/api/notifications')).json.items.some((n: any) => n.kind === 'reply'));

  // membership billing: a declined renewal writes through the template
  const m = await signedIn();
  await m.c.post('/api/membership/start', { plan: 'monthly' });
  const sub = await one(`select id from subscriptions where user_id = $1`, [m.user.id]);
  const ch = await one<{ id: string }>(
    `insert into subscription_charges (subscription_id, user_id, period_start, period_end, amount_cents) values ($1,$2, now() + interval '1 month', now() + interval '2 months', 599) returning id`,
    [sub!.id, m.user.id],
  );
  await pay.recordDecline(ch!.id, 'insufficient funds');
  const bill = await one(`select subject, html, category from emails where template = 'membership_billing' and user_id = $1`, [m.user.id]);
  assert.match(bill!.subject, /^We could not renew your .* membership$/);
  assert.ok(bill!.html.includes('insufficient funds') && bill!.html.includes('/account/membership') && bill!.html.includes('Manage membership'));
  assert.equal(bill!.category, 'transactional');
});

test('weekly digests: feed and analytics, once per ISO week, respecting toggles and unsubscribes', async () => {
  assert.deepEqual([isoWeek(new Date('2026-11-24T10:00:00Z')).label, isoWeek(new Date('2026-11-24T10:00:00Z')).start.toISOString()], ['2026-W48', '2026-11-23T00:00:00.000Z']);
  assert.equal(isoWeek(new Date('2027-01-01T00:00:00Z')).label, '2026-W53');
  assert.equal(isoWeek(new Date('2024-12-30T00:00:00Z')).label, '2025-W01');

  const now = new Date();
  const { label, start } = isoWeek(now);
  const lastWeek = new Date(start.getTime() - 3 * 86_400_000);
  const weekBefore = new Date(start.getTime() - 10 * 86_400_000);
  const dBrand = await f.brand(owner.id);
  const coAdmin = await f.user();
  const analyticsOff = await f.user({ prefs: { notify: { analytics: false } } });
  const editor = await f.user();
  await exec(`insert into publisher_members (publisher_id, user_id, role) values ($1,$2,'admin'), ($1,$3,'admin'), ($1,$4,'editor')`, [dBrand.id, coAdmin.id, analyticsOff.id, editor.id]);
  const dSeries = await f.series(dBrand.id, { title: 'Digest Days' });
  const fresh = await f.release(dSeries.id, { number: 1, title: 'Digest Days <One>', published_at: lastWeek }, 2);
  await f.release(dSeries.id, { number: 2, title: 'Too old', published_at: weekBefore }, 1);
  await f.release(dSeries.id, { number: 3, title: 'This week, not last', published_at: now }, 1);
  const adult = await f.release(dSeries.id, { number: 4, title: 'After dark', published_at: lastWeek, mature: true }, 1);

  const follower = await f.user();
  const brandFollower = await f.user({ prefs: { show_mature: true } });
  const feedOff = await f.user({ prefs: { notify: { feed: false } } });
  const unsubscribed = await f.user();
  const unconfirmed = await f.user({ verified: false });
  const nothingNew = await f.user();
  for (const u of [follower, feedOff, unsubscribed, unconfirmed]) await exec('insert into follows (user_id, series_id) values ($1,$2)', [u.id, dSeries.id]);
  await exec('insert into publisher_follows (user_id, publisher_id) values ($1,$2)', [brandFollower.id, dBrand.id]);
  await exec('insert into follows (user_id, series_id) values ($1,$2)', [nothingNew.id, series.id]);
  await exec('update users set email_unsubscribed_at = now() where id = $1', [unsubscribed.id]);

  // last week: 2 signed-in readers + 1 guest, 5 + 4 page reads, 300 earned and 50 refunded; the week before: 1 reader, 1 read, 100 earned
  const month = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)).toISOString().slice(0, 10);
  const read = async (userId: string, pageId: string, at: Date) =>
    exec(`insert into page_reads (user_id, page_id, month, release_id, series_id, publisher_id, via, read_at) values ($1,$2,$3,$4,$5,$6,'free',$7)`, [userId, pageId, month(at), fresh.id, dSeries.id, dBrand.id, at]);
  await read(follower.id, fresh.page_ids[0], lastWeek);
  await read(follower.id, fresh.page_ids[1], lastWeek);
  await read(brandFollower.id, fresh.page_ids[0], lastWeek);
  await read(brandFollower.id, fresh.page_ids[1], lastWeek);
  await read(brandFollower.id, adult.page_ids[0], lastWeek);
  await exec(`insert into anon_reads (day, release_id, series_id, publisher_id, visitor_hash, pages) values ($1,$2,$3,$4,'guest-1',4)`, [lastWeek.toISOString().slice(0, 10), fresh.id, dSeries.id, dBrand.id]);
  await exec(`insert into anon_reads (day, release_id, series_id, publisher_id, visitor_hash, pages) values ($1,$2,$3,$4,'guest-0',1)`, [weekBefore.toISOString().slice(0, 10), fresh.id, dSeries.id, dBrand.id]);
  for (const [kind, cents, at] of [['sale', 300, lastWeek], ['refund', -50, lastWeek], ['tip', 100, weekBefore], ['sale', 999, now]] as const) {
    await exec('insert into ledger (publisher_id, kind, amount_cents, gross_cents, created_at) values ($1,$2,$3,$3,$4)', [dBrand.id, kind, cents, at]);
  }

  const run = await runWeeklyDigests(now);
  assert.equal(run.week, label);
  const mailOf = (template: string, userId: string) => q(`select subject, html, category, status from emails where template = $1 and user_id = $2`, [template, userId]);

  // feed
  const [fm, ...moreF] = await mailOf('weekly_feed', follower.id);
  assert.equal(moreF.length, 0);
  assert.match(fm.subject, /^New this week from what you follow: 1 release$/);
  assert.ok(fm.html.includes('Digest Days &lt;One&gt;') && fm.html.includes(`/read/${fresh.id}`) && !fm.html.includes('Too old') && !fm.html.includes('This week, not last') && !fm.html.includes('After dark'));
  assert.ok(fm.html.includes('/api/unsubscribe?token='), 'carries the unsubscribe link');
  assert.equal(fm.category, 'notification');
  const [bm] = await mailOf('weekly_feed', brandFollower.id);
  assert.match(bm.subject, /2 releases$/);
  assert.ok(bm.html.includes('After dark'), 'a reader who opted in to mature titles sees them; brand follows count');
  for (const u of [feedOff, unsubscribed, unconfirmed, nothingNew]) assert.equal((await mailOf('weekly_feed', u.id)).length, 0);
  assert.deepEqual(await one('select sent, email_id is not null as has from digest_sends where kind = $1 and week = $2 and user_id = $3', ['feed', label, follower.id]), { sent: true, has: true });
  assert.deepEqual(await one('select sent from digest_sends where kind = $1 and week = $2 and user_id = $3', ['feed', label, nothingNew.id]), { sent: false }, 'nothing to report is remembered, not retried');

  // analytics: owners and admins with the toggle on
  const [am, ...moreA] = await mailOf('weekly_analytics', coAdmin.id);
  assert.equal(moreA.length, 0);
  assert.match(am.subject, /^Your publishing week on /);
  const text = am.html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  assert.match(text, new RegExp(`${dBrand.name} This week Week before Change Readers 3 1 \\+200% Page reads 9 1 \\+800% Earnings \\$2\\.50 \\$1\\.00 \\+150%`));
  assert.ok(am.html.includes(`/studio/${dBrand.slug}/analytics`));
  assert.equal((await mailOf('weekly_analytics', owner.id)).length, 1, 'the owner too (once, covering their brands)');
  assert.equal((await mailOf('weekly_analytics', analyticsOff.id)).length, 0);
  assert.equal((await mailOf('weekly_analytics', editor.id)).length, 0, 'editors are not sent earnings');

  // idempotent: again in the same week sends nothing, to anyone
  const before = (await one<{ n: number }>(`select count(*)::int as n from emails where template in ('weekly_feed','weekly_analytics')`))!.n;
  assert.deepEqual(await runWeeklyDigests(now), { week: label, feed: 0, analytics: 0 });
  assert.deepEqual(await runWeeklyDigests(new Date(start.getTime() + 6 * 86_400_000)), { week: label, feed: 0, analytics: 0 });
  assert.equal((await one<{ n: number }>(`select count(*)::int as n from emails where template in ('weekly_feed','weekly_analytics')`))!.n, before);
  // the next ISO week is a new send (with its own week of data)
  const next = await runWeeklyDigests(new Date(start.getTime() + 7 * 86_400_000));
  assert.notEqual(next.week, label);
  assert.ok(next.feed >= 1, 'the release published "now" is in next week\'s summary');
});
