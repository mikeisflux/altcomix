import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, beforeEach, test } from 'node:test';
import { fixtures, useTestDatabase } from './commerce.testkit.ts';

/**
 * The Divinity provider against a local fake of the partner endpoint
 * (POST /internal?action=...). This checks OUR side of the contract: request
 * shapes, headers, idempotency keys, signature verification and that every
 * path converges on one idempotent completion. It has not been run against
 * the live processor.
 */
await useTestDatabase('payments');
const { exec, one, q, pool } = await import('../db.ts');
const { setSetting } = await import('./settings.ts');
const pay = await import('./payments.ts');
const { runMembershipCycle } = await import('../jobs/memberships.ts');
const f = await fixtures();

type Call = { action: string; body: Record<string, any>; headers: Record<string, string | string[] | undefined> };
const calls: Call[] = [];
let respond: (c: Call) => { status?: number; body: unknown } | undefined = () => undefined;
const sessions = new Map<string, Record<string, unknown>>();
let nextId = 1;
const RUN = Date.now().toString(36); // the test database outlives a run; session ids must not repeat

const fake = createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    const url = new URL(req.url!, 'http://x');
    const call: Call = { action: url.searchParams.get('action') ?? '', body: raw ? JSON.parse(raw) : {}, headers: req.headers };
    calls.push(call);
    let out = respond(call);
    if (!out && url.pathname === '/internal') {
      const b = call.body;
      if (call.action === 'create-checkout-session') {
        const id = `cs_${RUN}_${nextId++}`;
        sessions.set(id, { sessionId: id, status: 'pending', mode: b.mode, amount: b.amount ?? null, pledgeId: b.pledgeId ?? null, paymentIntentId: b.mode === 'payment' ? `pi_${id}` : null, paymentMethodId: null });
        out = { body: { success: true, sessionId: id, checkoutUrl: `https://pay.example/checkout/${id}`, expiresAt: new Date(Date.now() + 3600e3).toISOString() } };
      } else if (call.action === 'get-checkout-session') {
        const s = sessions.get(b.sessionId);
        out = s ? { body: { success: true, session: s } } : { status: 404, body: { error: 'Checkout session not found' } };
      } else if (call.action === 'charge-saved-payment-method') out = { body: { success: true, status: 'succeeded', paymentIntentId: `pi_${b.pledgeId}_${b.idempotencyKey}`, amount: b.amount } };
      else if (call.action === 'capture') out = { body: { success: true, amount: 1 } };
      else if (call.action === 'refund') out = { body: { success: true, refundId: 're_1', amount: b.amount, status: 'succeeded' } };
      else if (call.action === 'lookup-payment') out = { body: { success: true, pledgeId: b.pledgeId, attempts: [], hasSuccessfulCharge: false, reconciled: true } };
    }
    out ??= { status: 400, body: { error: `Unknown action "${call.action}"` } };
    res.writeHead(out.status ?? 200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(out.body));
  });
});

const of = (action: string) => calls.filter((c) => c.action === action);
const SECRET = 'whsec_test_secret';

let reader: Awaited<ReturnType<typeof f.user>>;
let brand: Record<string, any>, payee: Record<string, any>, series: Record<string, any>, release: Record<string, any>;

before(async () => {
  await new Promise<void>((r) => fake.listen(0, '127.0.0.1', r));
  // Leftovers from an earlier run would be picked up by the reconcile and renewal jobs under test.
  await exec(`update orders set status = 'failed' where status = 'pending'`);
  await exec(`delete from subscriptions where status not in ('active','canceled','expired') or current_period_end < now()`);
  await setSetting('payments', {
    provider: 'divinity', divinity_api_url: `http://127.0.0.1:${(fake.address() as AddressInfo).port}/internal`, divinity_partner_id: 'partner_nsfwcomix',
    divinity_api_key: 'dc_live_testkey', divinity_webhook_secret: SECRET, divinity_checkout_logo_url: 'https://nsfwcomix.example/logo.png',
  }, null);
  await setSetting('membership', { trial_days: 0, monthly_cents: 599, annual_cents: 5900 }, null);
  const owner = await f.user();
  brand = await f.brand(owner.id);
  payee = await f.brand((await f.user()).id);
  series = await f.series(brand.id);
  release = await f.release(series.id, { download_price_cents: 499 }, 3);
  await exec('insert into revenue_splits (series_id, payee_publisher_id, share_bps) values ($1,$2,2500)', [series.id, payee.id]);
});
beforeEach(async () => {
  calls.length = 0;
  respond = () => undefined;
  reader = await f.user();
});
after(async () => {
  fake.close();
  await pool.end();
});

async function newOrder(userId: string, price = 199, credit = 0, extra: Record<string, unknown> = {}) {
  const o = await one<{ id: string }>(
    `insert into orders (user_id, status, total_cents, credit_cents, provider, ip, user_agent, meta) values ($1,'pending',$2,$3,'divinity','203.0.113.42','Mozilla/5.0 (Test Browser)',$4) returning id`,
    [userId, price, credit, JSON.stringify({ return_to: '/read/abc', ...extra })],
  );
  await exec(
    `insert into order_items (order_id, kind, release_id, series_id, publisher_id, description, price_cents) values ($1,'release',$2,$3,$4,'Test release',$5)`,
    [o!.id, release.id, series.id, brand.id, price],
  );
  return o!.id;
}
const order = (id: string) => one('select * from orders where id = $1', [id]);
const owns = async (userId: string) => Boolean(await one('select 1 from entitlements where user_id = $1 and release_id = $2', [userId, release.id]));
const ledgerSum = async (orderId: string) => (await one<{ n: number }>('select coalesce(sum(amount_cents),0)::int as n from ledger where order_id = $1', [orderId]))!.n;
const ledgerRows = async (orderId: string) => (await one<{ n: number }>('select count(*)::int as n from ledger where order_id = $1', [orderId]))!.n;

test('webhook signatures: t=<ts>,v1=<hmac sha256 of "ts.body">, 5 minute window', () => {
  const body = JSON.stringify({ event: 'test.ping', timestamp: 'x', data: {} });
  const now = Date.now();
  const sig = pay.signDivinityPayload(body, SECRET, Math.floor(now / 1000));
  assert.match(sig, /^t=\d+,v1=[0-9a-f]{64}$/);
  assert.equal(pay.verifyDivinitySignature(body, sig, SECRET, now), true);
  assert.equal(pay.verifyDivinitySignature(body + ' ', sig, SECRET, now), false, 'body tampered');
  assert.equal(pay.verifyDivinitySignature(body, sig, 'other-secret', now), false);
  assert.equal(pay.verifyDivinitySignature(body, sig.replace(/v1=./, 'v1=0'), SECRET, now), false);
  assert.equal(pay.verifyDivinitySignature(body, pay.signDivinityPayload(body, SECRET, Math.floor(now / 1000) - 301), SECRET, now), false, 'too old');
  assert.equal(pay.verifyDivinitySignature(body, pay.signDivinityPayload(body, SECRET, Math.floor(now / 1000) + 120), SECRET, now), false, 'from the future');
  assert.equal(pay.verifyDivinitySignature(body, '', SECRET, now), false);
  assert.equal(pay.verifyDivinitySignature(body, 'v1=abc', SECRET, now), false);
  assert.equal(pay.verifyDivinitySignature(body, sig, '', now), false, 'no secret configured never verifies');
});

test('hosted checkout: request shape, then return page + webhooks converge on one completion and one capture', async () => {
  const id = await newOrder(reader.id);
  const r = await pay.startOrderPayment(id);
  assert.equal(r.completed, false);
  assert.match(r.url!, /^https:\/\/pay\.example\/checkout\/cs_/);

  const [c] = of('create-checkout-session');
  assert.equal(c.headers.authorization, 'Bearer dc_live_testkey');
  assert.equal(c.headers['x-partner-id'], 'partner_nsfwcomix');
  assert.equal(c.headers['content-type'], 'application/json');
  assert.deepEqual(
    { mode: c.body.mode, platformUserId: c.body.platformUserId, email: c.body.email, amount: c.body.amount, currency: c.body.currency, pledgeId: c.body.pledgeId, projectId: c.body.projectId, idempotencyKey: c.body.idempotencyKey },
    { mode: 'payment', platformUserId: reader.id, email: reader.email, amount: 199, currency: 'usd', pledgeId: id, projectId: 'nsfwcomix-store', idempotencyKey: id },
  );
  assert.match(c.body.returnUrl, new RegExp(`/checkout/return\\?order=${id}&next=%2Fread%2Fabc$`));
  assert.equal(c.body.partnerLogoUrl, 'https://nsfwcomix.example/logo.png');
  // the reader's browser, never our server
  assert.equal(c.body.customerIpAddress, '203.0.113.42');
  assert.equal(c.body.customerUserAgent, 'Mozilla/5.0 (Test Browser)');
  // no card data of any kind leaves (or exists on) our side
  assert.deepEqual(Object.keys(c.body).sort(), ['amount', 'cancelUrl', 'currency', 'customerIpAddress', 'customerUserAgent', 'description', 'email', 'expiresInMinutes', 'idempotencyKey', 'mode', 'partnerLogoUrl', 'platformUserId', 'pledgeId', 'projectId', 'returnUrl']);

  const o1 = await order(id);
  assert.equal(o1!.status, 'pending');
  assert.match(o1!.provider_ref, /^cs_/);
  assert.equal(await owns(reader.id), false, 'nothing is granted before payment');

  // Reader comes back before paying: still pending.
  assert.deepEqual(await pay.confirmSession(o1!.provider_ref, { userId: reader.id }), { kind: 'order', status: 'pending', order_id: id });
  // Someone else cannot confirm (or probe) this session.
  assert.equal((await pay.confirmSession(o1!.provider_ref, { userId: brand.id })).kind, 'unknown');

  // Paid at the processor. The hold is not there yet when the reader lands, so the first capture is refused.
  Object.assign(sessions.get(o1!.provider_ref)!, { status: 'complete', paymentMethodId: 'pm_x' });
  respond = (call) => (call.action === 'capture' ? { status: 400, body: { success: false, error: 'HOLD_NOT_FOUND', message: 'Hold not found for this pledge.' } } : undefined);
  assert.deepEqual(await pay.confirmSession(o1!.provider_ref, { userId: reader.id }), { kind: 'order', status: 'paid', order_id: id });
  let o2 = await order(id);
  assert.equal(o2!.status, 'paid');
  assert.equal(o2!.payment_ref, `pi_${o1!.provider_ref}`);
  assert.equal(o2!.captured_at, null);
  assert.equal(await owns(reader.id), true);
  assert.equal(o2!.fee_cents, 36);

  // exact conservation: 199 = 36 fee + creators (owner + 25% payee) + platform
  const rows = await q('select publisher_id, amount_cents from ledger where order_id = $1 order by amount_cents desc', [id]);
  assert.deepEqual(rows.map((x) => [x.publisher_id, x.amount_cents]), [[brand.id, 104], [payee.id, 34]]);
  const item = await one('select creator_cents from order_items where order_id = $1', [id]);
  assert.equal(item!.creator_cents, 138);

  // Webhooks arrive afterwards, twice each: nothing is granted or paid out again; the capture now goes through.
  respond = () => undefined;
  for (let i = 0; i < 2; i++) {
    await pay.handleDivinityEvent({ event: 'checkout.completed', data: { sessionId: o1!.provider_ref, mode: 'payment', paymentIntentId: `pi_${o1!.provider_ref}`, pledgeId: id } });
    await pay.handleDivinityEvent({ event: 'payment.succeeded', data: { paymentIntentId: `pi_${o1!.provider_ref}`, amount: 199, pledgeId: id, projectId: 'nsfwcomix-store', platformUserId: reader.id, hold: { holdId: 'hold_1', amount: 199, status: 'ACTIVE' } } });
  }
  assert.equal(await ledgerRows(id), 2);
  assert.equal(await ledgerSum(id), 138);
  o2 = await order(id);
  assert.ok(o2!.captured_at, 'captured once the hold exists');
  assert.ok(of('capture').every((x) => x.body.pledgeId === id));
  const captures = of('capture').length;
  await pay.handleDivinityEvent({ event: 'payment.succeeded', data: { paymentIntentId: `pi_${o1!.provider_ref}`, pledgeId: id } });
  assert.equal(of('capture').length, captures, 'an order already captured is not captured again');
  assert.equal((await one<{ n: number }>(`select count(*)::int as n from emails where template = 'receipt' and user_id = $1`, [reader.id]))!.n, 1, 'one receipt');
});

test('the webhook alone completes an order when the reader never comes back', async () => {
  const id = await newOrder(reader.id);
  await pay.startOrderPayment(id);
  const ref = (await order(id))!.provider_ref;
  const r = await pay.handleDivinityEvent({ event: 'payment.succeeded', data: { paymentIntentId: `pi_from_webhook_${RUN}`, amount: 199, pledgeId: id } });
  assert.equal(r.success, true);
  const o = await order(id);
  assert.deepEqual([o!.status, o!.payment_ref, Boolean(o!.captured_at)], ['paid', `pi_from_webhook_${RUN}`, true]);
  assert.equal(await owns(reader.id), true);
  // the late return-page confirmation is a no-op
  assert.equal((await pay.confirmSession(ref, { userId: reader.id })).status, 'paid');
  assert.equal(await ledgerRows(id), 2);
});

test('an existing session is reused for the same order (idempotency key) and a completed one cannot charge twice', async () => {
  const id = await newOrder(reader.id);
  respond = (c) => (c.action === 'create-checkout-session' ? { body: { success: true, sessionId: `cs_done_${RUN}`, checkoutUrl: 'https://pay.example/checkout/cs_done', expiresAt: new Date().toISOString(), reused: true, status: 'complete' } } : undefined);
  const r = await pay.startOrderPayment(id);
  assert.equal(r.completed, true);
  assert.equal((await order(id))!.status, 'paid');
});

test('expired / failed / cancelled checkouts fail the order and return reserved store credit; siblings of a paid order are ignored', async () => {
  await exec('insert into wallets (user_id, credit_cents) values ($1, 0)', [reader.id]);
  const id = await newOrder(reader.id, 199, 100); // 100 of store credit was reserved at checkout
  await pay.startOrderPayment(id);
  assert.equal(of('create-checkout-session')[0].body.amount, 99, 'only the part not covered by credit is charged');
  const ref = (await order(id))!.provider_ref;

  // a declined card on the hosted page is not the end: the reader can try another card
  await pay.handleDivinityEvent({ event: 'payment.failed', data: { paymentIntentId: 'pi_x', pledgeId: id, code: 'card_declined', declineCode: 'insufficient_funds', status: 'requires_payment_method' } });
  assert.equal((await order(id))!.status, 'pending');
  // an abandoned sibling session of an order that was paid elsewhere changes nothing
  await pay.handleDivinityEvent({ event: 'checkout.expired', data: { sessionId: ref, mode: 'payment', pledgeId: id, pledgeAlreadyPaid: true, paidSessionId: 'cs_other' } });
  assert.equal((await order(id))!.status, 'pending');

  await pay.handleDivinityEvent({ event: 'checkout.expired', data: { sessionId: ref, mode: 'payment', pledgeId: id } });
  await pay.handleDivinityEvent({ event: 'checkout.expired', data: { sessionId: ref, mode: 'payment', pledgeId: id } });
  assert.equal((await order(id))!.status, 'failed');
  assert.equal((await one('select credit_cents from wallets where user_id = $1', [reader.id]))!.credit_cents, 100, 'credit returned exactly once');
  assert.equal(await owns(reader.id), false);

  // "Only completion may supersede": the processor can still report the session paid afterwards.
  await pay.handleDivinityEvent({ event: 'checkout.completed', data: { sessionId: ref, mode: 'payment', paymentIntentId: `pi_late_${RUN}`, pledgeId: id } });
  assert.equal((await order(id))!.status, 'paid');
  assert.equal((await one('select credit_cents from wallets where user_id = $1', [reader.id]))!.credit_cents, 0, 'the credit is taken again');
  assert.equal(await owns(reader.id), true);
});

test('a processor outage at checkout fails cleanly: no order left pending, credit returned, readable error', async () => {
  await exec('insert into wallets (user_id, credit_cents) values ($1, 0)', [reader.id]);
  const id = await newOrder(reader.id, 199, 50);
  respond = () => ({ status: 502, body: '<html>Bad gateway</html>' });
  await assert.rejects(pay.startOrderPayment(id), /could not start the checkout.*You have not been charged/);
  assert.equal((await order(id))!.status, 'failed');
  assert.equal((await one('select credit_cents from wallets where user_id = $1', [reader.id]))!.credit_cents, 50);
});

test('refund: processor first, then entitlements and ledger are reversed; repeats and the webhook echo change nothing', async () => {
  const id = await newOrder(reader.id);
  await pay.startOrderPayment(id);
  await pay.handleDivinityEvent({ event: 'payment.succeeded', data: { paymentIntentId: `pi_refund_me_${RUN}`, pledgeId: id } });
  assert.equal(await owns(reader.id), true);

  // If the processor refuses, nothing changes on our side.
  respond = (c) => (c.action === 'refund' ? { status: 500, body: { error: 'Failed to process refund' } } : undefined);
  await assert.rejects(pay.refundOrder(id, { reason: 'Bought twice' }), /did not accept the refund/);
  assert.equal((await order(id))!.status, 'paid');
  assert.equal(await owns(reader.id), true);
  assert.equal(await ledgerSum(id), 138);

  respond = () => undefined;
  calls.length = 0;
  assert.deepEqual(await pay.refundOrder(id, { reason: 'Bought twice' }), { refunded: true });
  const [rf] = of('refund');
  assert.deepEqual({ paymentIntentId: rf.body.paymentIntentId, pledgeId: rf.body.pledgeId, amount: rf.body.amount, reason: rf.body.reason }, { paymentIntentId: `pi_refund_me_${RUN}`, pledgeId: id, amount: 199, reason: 'Bought twice' });
  assert.equal((await order(id))!.status, 'refunded');
  assert.equal(await owns(reader.id), false);
  assert.equal(await ledgerSum(id), 0, 'every creator row has an equal and opposite refund row');
  assert.equal(await ledgerRows(id), 4);

  // the processor's own refund.completed for the same payment, and a second admin click
  await pay.handleDivinityEvent({ event: 'refund.completed', data: { paymentIntentId: `pi_refund_me_${RUN}`, refundId: 're_1', amount: 199, pledgeId: id, status: 'succeeded', partial: false } });
  assert.deepEqual(await pay.refundOrder(id), { refunded: false });
  assert.equal(await ledgerRows(id), 4);
  assert.equal(of('refund').length, 1, 'the processor was asked once');
});

test('refund.completed and dispute.created webhooks reverse an order found by payment id; a dispute alerts the admins', async () => {
  const a = await newOrder(reader.id);
  await pay.startOrderPayment(a);
  await pay.handleDivinityEvent({ event: 'payment.succeeded', data: { paymentIntentId: `pi_dashboard_refund_${RUN}`, pledgeId: a } });
  // refunded from the processor's dashboard: only the payment id is reliable
  await pay.handleDivinityEvent({ event: 'refund.completed', data: { paymentIntentId: `pi_dashboard_refund_${RUN}`, amount: 199, status: 'succeeded', partial: false } });
  assert.equal((await order(a))!.status, 'refunded');
  assert.equal(await ledgerSum(a), 0);

  const other = await f.user();
  const b = await newOrder(other.id);
  await pay.startOrderPayment(b);
  await pay.handleDivinityEvent({ event: 'payment.succeeded', data: { paymentIntentId: `pi_disputed_${RUN}`, pledgeId: b } });
  const evt = { event: 'dispute.created', data: { disputeId: 'du_1', stripePaymentIntentId: `pi_disputed_${RUN}`, chargeId: 'ch_1', pledgeId: b, amount: 199, reason: 'fraudulent', status: 'warning_needs_response', evidenceDueBy: '2026-12-17T23:59:00Z' } };
  assert.match((await pay.handleDivinityEvent(evt)).message, /Dispute applied/);
  assert.match((await pay.handleDivinityEvent(evt)).message, /already applied/);
  const o = await order(b);
  assert.equal(o!.status, 'refunded');
  assert.equal(o!.meta.dispute.id, 'du_1');
  assert.equal(await owns(other.id), false);
  assert.equal(await ledgerSum(b), 0);
  assert.equal(await ledgerRows(b), 4);
  // events about payments that are not ours are acknowledged, not errors
  assert.equal((await pay.handleDivinityEvent({ event: 'dispute.created', data: { stripePaymentIntentId: 'pi_unknown', pledgeId: 'pledge_from_elsewhere' } })).success, true);
  assert.equal((await pay.handleDivinityEvent({ event: 'something.new', data: {} })).success, true);
});

const sub = (userId: string) => one('select * from subscriptions where user_id = $1 order by created_at desc limit 1', [userId]);
const charges = (subId: string) => q('select * from subscription_charges where subscription_id = $1 order by created_at, id', [subId]);

test('membership: SETUP checkout saves only a pm_ token, first period is charged off-session and captured', async () => {
  const start = await pay.startMembership(reader, 'monthly', { ip: '198.51.100.7', userAgent: 'Mozilla/5.0 (Member)' });
  assert.equal(start.completed, false);
  assert.match(start.url!, /checkout\/cs_/);
  const [c] = of('create-checkout-session');
  assert.equal(c.body.mode, 'setup');
  assert.equal(c.body.platformUserId, reader.id);
  assert.ok(!('amount' in c.body) && !('pledgeId' in c.body), 'a setup session carries no charge');
  assert.match(c.body.idempotencyKey, /^setup-/);
  assert.match(c.body.returnUrl, /\/account\/membership$/);

  let s = await sub(reader.id);
  assert.deepEqual([s!.status, s!.payment_method_token, s!.provider], ['pending', null, 'divinity']);
  assert.equal((await pay.confirmSession(s!.setup_ref, { userId: reader.id })).status, 'pending');
  assert.equal(of('charge-saved-payment-method').length, 0);

  // Card saved on the hosted page. Both the return page and the webhook report it; one charge results.
  Object.assign(sessions.get(s!.setup_ref)!, { status: 'complete', paymentMethodId: 'pm_saved_1', setupIntentId: 'seti_1' });
  const [viaReturn, viaWebhook] = await Promise.all([
    pay.confirmSession(s!.setup_ref, { userId: reader.id }),
    pay.handleDivinityEvent({ event: 'checkout.completed', data: { sessionId: s!.setup_ref, mode: 'setup', setupIntentId: 'seti_1', paymentMethodId: 'pm_saved_1' } }),
  ]);
  assert.ok(viaReturn.kind === 'membership' && viaWebhook.success);
  s = await sub(reader.id);
  assert.deepEqual([s!.status, s!.payment_method_token, s!.origin_ip], ['active', 'pm_saved_1', '198.51.100.7']);
  const cs = await charges(s!.id);
  assert.equal(cs.length, 1);
  const paid = of('charge-saved-payment-method');
  assert.equal(paid.length, 1, 'charged exactly once');
  assert.deepEqual(
    { platformUserId: paid[0].body.platformUserId, paymentMethodId: paid[0].body.paymentMethodId, amount: paid[0].body.amount, pledgeId: paid[0].body.pledgeId, projectId: paid[0].body.projectId, idempotencyKey: paid[0].body.idempotencyKey, ip: paid[0].body.customerIpAddress, ua: paid[0].body.customerUserAgent },
    { platformUserId: reader.id, paymentMethodId: 'pm_saved_1', amount: 599, pledgeId: cs[0].id, projectId: 'nsfwcomix-membership', idempotencyKey: 'attempt-1', ip: '198.51.100.7', ua: 'Mozilla/5.0 (Member)' },
  );
  assert.deepEqual(of('capture').map((x) => x.body.pledgeId), [cs[0].id]);
  assert.deepEqual([cs[0].status, cs[0].amount_cents, cs[0].fee_cents, Boolean(cs[0].captured_at)], ['paid', 599, 47, true]);
  const months = await q('select gross_cents, fee_cents, charge_id from sub_months where user_id = $1', [reader.id]);
  assert.deepEqual(months.map((m) => [m.gross_cents, m.fee_cents, m.charge_id]), [[599, 47, cs[0].id]]);
  assert.ok(Date.parse(s!.current_period_end) > Date.now() + 27 * 86400e3);
  assert.equal((await one<{ n: number }>(`select count(*)::int as n from emails where template = 'membership_started' and user_id = $1`, [reader.id]))!.n, 1);
  // the processor's payment.succeeded for that charge is a no-op
  await pay.handleDivinityEvent({ event: 'payment.succeeded', data: { paymentIntentId: paid[0].body.pledgeId, pledgeId: cs[0].id, amount: 599 } });
  assert.equal((await q('select 1 from sub_months where user_id = $1', [reader.id])).length, 1);
  await assert.rejects(pay.startMembership(reader, 'monthly', { ip: null, userAgent: null }), /already have an active membership/);
});

test('a declined first payment does not start a membership', async () => {
  await pay.startMembership(reader, 'annual', { ip: '198.51.100.7', userAgent: 'UA' });
  const s = await sub(reader.id);
  Object.assign(sessions.get(s!.setup_ref)!, { status: 'complete', paymentMethodId: 'pm_bad' });
  respond = (c) => (c.action === 'charge-saved-payment-method' ? { status: 402, body: { success: false, status: 'requires_payment_method', error: 'Your card was declined.', code: 'card_declined', declineCode: 'insufficient_funds', paymentIntentId: 'pi_declined' } } : undefined);
  assert.equal((await pay.confirmSession(s!.setup_ref, { userId: reader.id })).status, 'declined');
  assert.equal((await sub(reader.id))!.status, 'expired');
  assert.equal((await q('select 1 from sub_months where user_id = $1', [reader.id])).length, 0);
  assert.equal(of('capture').length, 0);
});

async function member(plan: 'monthly' | 'annual' = 'monthly') {
  await pay.startMembership(reader, plan, { ip: '198.51.100.7', userAgent: 'UA' });
  const s = await sub(reader.id);
  Object.assign(sessions.get(s!.setup_ref)!, { status: 'complete', paymentMethodId: 'pm_ok' });
  await pay.confirmSession(s!.setup_ref, { userId: reader.id });
  calls.length = 0;
  return (await sub(reader.id))!;
}
const lapse = (subId: string) => exec(`update subscriptions set current_period_end = now() - interval '1 minute', current_period_start = now() - interval '1 month' where id = $1`, [subId]);
const dueNow = (subId: string) => exec(`update subscription_charges set next_attempt_at = now() - interval '1 second' where subscription_id = $1 and status = 'pending'`, [subId]);

test('renewal: the job bills the next period with a fresh pledge id; an annual plan books twelve monthly pots', async () => {
  const s = await member('annual');
  const first = (await charges(s.id))[0];
  const pots = await q('select month, gross_cents, fee_cents from sub_months where user_id = $1 order by month', [reader.id]);
  assert.equal(pots.length, 12);
  assert.equal(pots.reduce((n, p) => n + p.gross_cents, 0), 5900);
  assert.equal(pots.reduce((n, p) => n + p.fee_cents, 0), first.fee_cents);
  assert.deepEqual([...new Set(pots.map((p) => p.gross_cents))], [492, 491]);

  await lapse(s.id);
  const n = await runMembershipCycle();
  assert.equal(n.billed, 1);
  assert.equal(n.paid, 1);
  const cs = await charges(s.id);
  assert.equal(cs.length, 2);
  const [call] = of('charge-saved-payment-method');
  assert.equal(call.body.pledgeId, cs[1].id);
  assert.notEqual(cs[1].id, first.id, 'each period has its own reconciliation id (one hold per pledge id)');
  assert.equal(call.body.idempotencyKey, 'attempt-1');
  assert.equal(call.body.customerIpAddress, '198.51.100.7', 'the address recorded when the card was saved');
  const after = await sub(reader.id);
  assert.equal(after!.status, 'active');
  assert.ok(Date.parse(after!.current_period_end) > Date.now() + 360 * 86400e3);
  // the test renews immediately, so both years land on the same twelve open months and add up there
  assert.equal((await q('select 1 from sub_months where user_id = $1', [reader.id])).length, 12);
  assert.equal((await one<{ n: number }>('select sum(gross_cents)::int as n from sub_months where user_id = $1', [reader.id]))!.n, 11800);
  // running the job again does not bill the same period twice
  assert.equal((await runMembershipCycle()).billed, 0);
  assert.equal(of('charge-saved-payment-method').length, 1);
});

test('declined renewals: past_due, retried after 1/3/5 days under a new idempotency key each time, then expired', async () => {
  const s = await member();
  await lapse(s.id);
  respond = (c) => (c.action === 'charge-saved-payment-method' ? { status: 402, body: { success: false, status: 'requires_payment_method', error: 'Your card was declined.', code: 'card_declined', declineCode: 'do_not_honor' } } : undefined);

  await runMembershipCycle();
  let [, c] = await charges(s.id);
  assert.deepEqual([c.status, c.attempts, (await sub(reader.id))!.status], ['pending', 1, 'past_due']);
  const days = (d: string) => Math.round((Date.parse(d) - Date.now()) / 86400e3);
  assert.equal(days(c.next_attempt_at), 1);
  // not due yet: the job leaves it alone
  await runMembershipCycle();
  assert.equal(of('charge-saved-payment-method').length, 1);

  for (const [attempt, wait] of [[2, 3], [3, 5]] as const) {
    await dueNow(s.id);
    await runMembershipCycle();
    [, c] = await charges(s.id);
    assert.deepEqual([c.status, c.attempts, days(c.next_attempt_at)], ['pending', attempt, wait]);
  }
  await dueNow(s.id);
  await runMembershipCycle();
  [, c] = await charges(s.id);
  assert.deepEqual([c.status, c.attempts, (await sub(reader.id))!.status], ['failed', 4, 'expired']);
  const sent = of('charge-saved-payment-method');
  assert.deepEqual(sent.map((x) => x.body.idempotencyKey), ['attempt-1', 'attempt-2', 'attempt-3', 'attempt-4']);
  assert.ok(sent.every((x) => x.body.pledgeId === c.id), 'the pledge id never changes between attempts');
  assert.equal((await q('select 1 from sub_months where user_id = $1', [reader.id])).length, 1, 'no pot for a period that was never paid');
  const mails = await q<{ subject: string }>(`select subject from emails where user_id = $1 and template = 'membership_billing' order by created_at`, [reader.id]);
  assert.equal(mails.length, 2);
  assert.match(mails[0].subject, /could not renew/);
  assert.match(mails[1].subject, /has ended/);
  // nothing further is attempted
  await runMembershipCycle();
  assert.equal(of('charge-saved-payment-method').length, 4);
});

test('a recovered card: retry succeeds, membership is active again for the new period', async () => {
  const s = await member();
  await lapse(s.id);
  let decline = true;
  respond = (c) => (c.action === 'charge-saved-payment-method' && decline ? { status: 402, body: { success: false, status: 'requires_payment_method', error: 'Your card was declined.', code: 'card_declined' } } : undefined);
  await runMembershipCycle();
  assert.equal((await sub(reader.id))!.status, 'past_due');
  decline = false;
  await dueNow(s.id);
  const n = await runMembershipCycle();
  assert.equal(n.paid, 1);
  const after = await sub(reader.id);
  assert.equal(after!.status, 'active');
  assert.ok(Date.parse(after!.current_period_end) > Date.now() + 27 * 86400e3);
  assert.equal(of('charge-saved-payment-method').at(-1)!.body.idempotencyKey, 'attempt-2');
});

test('no answer from the processor: no attempt is burned, the charge is looked up before it is ever repeated', async () => {
  const s = await member();
  await lapse(s.id);
  respond = (c) => (c.action === 'charge-saved-payment-method' ? { status: 504, body: '<html>Gateway timeout</html>' } : undefined);
  await runMembershipCycle();
  let [, c] = await charges(s.id);
  assert.deepEqual([c.status, c.attempts, c.uncertain], ['pending', 0, true]);
  assert.equal((await sub(reader.id))!.status, 'active', 'an outage is not a decline');

  // The processor cannot confirm either way yet: wait, do not charge.
  respond = (call) => (call.action === 'lookup-payment' ? { body: { success: true, attempts: [{ paymentIntentId: 'pi_q', status: 'processing' }], hasSuccessfulCharge: false, reconciled: false } } : undefined);
  await dueNow(s.id);
  await runMembershipCycle();
  assert.equal(of('charge-saved-payment-method').length, 1);
  assert.deepEqual(of('lookup-payment').map((x) => x.body.pledgeId), [c.id]);

  // It did go through the first time: mark it paid without charging again.
  respond = (call) => (call.action === 'lookup-payment' ? { body: { success: true, attempts: [{ paymentIntentId: `pi_went_through_${RUN}`, status: 'succeeded' }], hasSuccessfulCharge: true, reconciled: true } } : undefined);
  await dueNow(s.id);
  await runMembershipCycle();
  [, c] = await charges(s.id);
  assert.deepEqual([c.status, c.payment_ref, c.uncertain], ['paid', `pi_went_through_${RUN}`, false]);
  assert.equal(of('charge-saved-payment-method').length, 1, 'the card was charged once');
  assert.equal((await sub(reader.id))!.status, 'active');
});

test('cancel at period end stops renewals; a membership charge that is charged back ends access and empties its open pots', async () => {
  const s = await member();
  await exec('update subscriptions set cancel_at_period_end = true where id = $1', [s.id]);
  await lapse(s.id);
  const n = await runMembershipCycle();
  assert.deepEqual([n.ended, n.billed], [1, 0]);
  assert.equal((await sub(reader.id))!.status, 'canceled');
  assert.equal(of('charge-saved-payment-method').length, 0);

  const other = await f.user();
  reader = other;
  const s2 = await member();
  const [c] = await charges(s2.id);
  await pay.handleDivinityEvent({ event: 'dispute.created', data: { disputeId: 'du_2', stripePaymentIntentId: c.payment_ref, pledgeId: c.id, reason: 'fraudulent' } });
  await pay.handleDivinityEvent({ event: 'dispute.created', data: { disputeId: 'du_2', stripePaymentIntentId: c.payment_ref, pledgeId: c.id, reason: 'fraudulent' } });
  const after = await sub(other.id);
  assert.equal(after!.status, 'canceled');
  assert.ok(Date.parse(after!.current_period_end) <= Date.now());
  assert.equal((await charges(s2.id))[0].status, 'refunded');
  assert.equal((await q('select 1 from sub_months where user_id = $1', [other.id])).length, 0);

  // refunding a membership charge goes to the processor with that charge's payment id
  const third = await f.user();
  reader = third;
  const s3 = await member();
  const [c3] = await charges(s3.id);
  assert.deepEqual(await pay.refundCharge(c3.id, 'Asked nicely'), { refunded: true });
  assert.deepEqual([of('refund')[0].body.paymentIntentId, of('refund')[0].body.pledgeId, of('refund')[0].body.amount], [c3.payment_ref, c3.id, 599]);
  assert.deepEqual(await pay.refundCharge(c3.id), { refunded: false });
});

test('sandbox: instant in development, rolls periods forward like production, refused in production', async () => {
  await setSetting('payments', { provider: 'sandbox' }, null);
  try {
    const r = await pay.startMembership(reader, 'monthly', { ip: '127.0.0.1', userAgent: 'curl' });
    assert.equal(r.completed, true);
    const s = await sub(reader.id);
    assert.deepEqual([s!.status, s!.provider, s!.payment_method_token], ['active', 'sandbox', 'pm_sandbox']);
    await lapse(s!.id);
    const n = await runMembershipCycle();
    assert.equal(n.paid, 1);
    assert.equal((await charges(s!.id)).length, 2);
    assert.equal((await one<{ n: number }>('select sum(gross_cents)::int as n from sub_months where user_id = $1', [reader.id]))!.n, 1198);
    assert.equal(calls.length, 0, 'the sandbox never talks to a processor');

    const id = await newOrder(reader.id);
    await exec(`update orders set provider = 'sandbox' where id = $1`, [id]);
    assert.equal((await pay.startOrderPayment(id)).completed, true);

    process.env.NODE_ENV = 'production';
    await assert.rejects(pay.getProvider(), (e: Error & { status?: number; code?: string }) => e.status === 503 && e.code === 'payments_not_configured' && /administrator needs to configure the payment provider/.test(e.message));
    const other = await f.user();
    await assert.rejects(pay.startMembership(other, 'monthly', { ip: null, userAgent: null }), /Payments are not set up yet/);
    assert.equal(await sub(other.id), null, 'nothing was created');
  } finally {
    process.env.NODE_ENV = 'test';
    await setSetting('payments', { provider: 'divinity' }, null);
  }
});

test('divinity without credentials is "not configured", not a crash', async () => {
  await setSetting('payments', { divinity_partner_id: '' }, null);
  try {
    await assert.rejects(pay.getProvider(), /Payments are not set up yet/);
  } finally {
    await setSetting('payments', { divinity_partner_id: 'partner_nsfwcomix' }, null);
  }
});
