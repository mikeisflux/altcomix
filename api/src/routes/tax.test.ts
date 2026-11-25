import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { fixtures, useTestDatabase } from '../lib/commerce.testkit.ts';

/** Creator tax information: limit, notice, payout gate, the form, and the admin Tax view. Real HTTP stack (app.inject). */
await useTestDatabase('tax');
process.env.ROUTES = 'auth,studio-brands,studio-commerce,studio-tax,admin-tax,admin-finance';
const { exec, one, q, pool } = await import('../db.ts');
const { decrypt } = await import('../lib/crypto.ts');
const { getSetting, setSetting } = await import('../lib/settings.ts');
const { CERTIFICATIONS, cleanTin, sendTaxNotices, taxStatus, taxYear, yearEarnings } = await import('../lib/tax.ts');
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
      // not JSON
    }
    return { status: res.statusCode, json, text: res.payload };
  }
  get = (url: string) => this.call('GET', url);
  post = (url: string, body: unknown = {}) => this.call('POST', url, body);
  put = (url: string, body: unknown = {}) => this.call('PUT', url, body);
  async login(email: string) {
    await this.get('/api/bootstrap');
    const r = await this.post('/api/auth/login', { email, password: 'correct horse battery' });
    assert.equal(r.status, 200, r.text);
    return this;
  }
}
const signedIn = async (over: Parameters<typeof f.user>[0] = {}) => {
  const user = await f.user(over);
  return { user, c: await new Client().login(user.email) };
};

const YEAR = taxYear();
const LIMIT = 200_000;
// Test numbers only: an SSN from the range reserved for examples would be rejected, so these are made up.
const SSN = '514-83-2167';
const SSN_DIGITS = '514832167';
const EIN = '35-2146870';
const EIN_DIGITS = '352146870';

/** A ledger row dated inside `year` (1 July), already past the payout hold. */
async function ledger(brandId: string, kind: string, cents: number, year = YEAR) {
  const at = year === YEAR ? new Date(Date.now() - 60_000) : new Date(Date.UTC(year, 6, 1, 12));
  await exec(`insert into ledger (publisher_id, kind, amount_cents, gross_cents, note, available_at, created_at) values ($1,$2,$3,$4,'test',$5,$5)`, [brandId, kind, cents, Math.max(0, cents), at]);
}

async function payable(over: Record<string, unknown> = {}) {
  const { user, c } = await signedIn();
  const brand = await f.brand(user.id, over);
  await exec(`update publishers set payout = $2, country = 'US' where id = $1`, [brand.id, JSON.stringify({ method: 'paypal', destination: 'pay@test.invalid', legal_name: 'Jordan Example' })]);
  return { user, c, brand, base: `/api/studio/brands/${brand.id}` };
}

const usForm = (over: Record<string, unknown> = {}) => ({
  is_us_person: true, legal_name: 'Jordan Example', business_name: 'Example Comics', classification: 'individual',
  address_street: '100 Main Street', address_city: 'Indianapolis', address_state: 'IN', address_postal: '46204', address_country: 'US',
  tin_type: 'ssn', tin: SSN, signature_name: 'Jordan Example', certify: true, certification_text: CERTIFICATIONS.us, ...over,
});
const foreignForm = (over: Record<string, unknown> = {}) => ({
  is_us_person: false, legal_name: 'Robin Sample', classification: 'individual',
  address_street: '5 Harbour Road', address_city: 'Toronto', address_state: 'Ontario', address_postal: 'M5V 2T6', address_country: 'CA',
  tax_residence_country: 'CA', foreign_tin: 'CA-774 512 908', date_of_birth: '1988-04-12', not_us_person: true,
  signature_name: 'Robin Sample', certify: true, certification_text: CERTIFICATIONS.non_us, ...over,
});

const notices = (userId: string) => q(`select * from notifications where user_id = $1 and kind = 'tax' order by created_at`, [userId]);
const emails = (brandId: string, template = 'tax_form_needed') => q('select * from emails where publisher_id = $1 and template = $2', [brandId, template]);

before(async () => {
  // This file's database is reused between runs. Earnings left by earlier runs would
  // push this run's brands off the first page of the admin list, so start clean.
  await exec('delete from ledger');
  await exec('delete from payouts');
  await setSetting('revenue', { tax_reporting_threshold_cents: LIMIT, tax_form_required: true, payout_minimum_cents: 2000, payout_hold_days: 7 }, null);
});
after(async () => {
  await app.close();
  await pool.end();
});

test('settings: the limit defaults to 2,000.00 and the requirement to on', async () => {
  const { SETTINGS } = await import('../lib/settings.ts');
  assert.equal(SETTINGS.revenue.defaults.tax_reporting_threshold_cents, 200_000);
  assert.equal(SETTINGS.revenue.defaults.tax_form_required, true);
  const rev = await getSetting('revenue');
  assert.deepEqual([rev.tax_reporting_threshold_cents, rev.tax_form_required], [LIMIT, true]);
});

test('taxpayer ID shapes: 9 digits, obvious junk refused, and the message never repeats the number', () => {
  assert.deepEqual(cleanTin('ssn', SSN), { ok: true, digits: SSN_DIGITS });
  assert.deepEqual(cleanTin('ein', EIN), { ok: true, digits: EIN_DIGITS });
  assert.deepEqual(cleanTin('ssn', '514 83 2167'), { ok: true, digits: SSN_DIGITS });
  for (const [type, bad] of [
    ['ssn', '000000000'], ['ssn', '123456789'], ['ssn', '111-11-1111'], ['ssn', '51483216'], ['ssn', '5148321670'], ['ssn', '000-12-3456'],
    ['ssn', '666-12-3456'], ['ssn', '514-00-2167'], ['ssn', '514-83-0000'], ['ssn', '51a832167'], ['ssn', ''],
    ['ein', '000000000'], ['ein', '123456789'], ['ein', '00-1234567'], ['ein', '35-0000000'], ['ein', '35214687'],
  ] as const) {
    const r = cleanTin(type, bad);
    assert.equal(r.ok, false, `${type} ${bad} should be refused`);
    if (!r.ok && bad.length > 3) assert.ok(!r.error.includes(bad) && !r.error.includes(bad.replace(/\D/g, '')), 'the message does not repeat the number');
  }
});

test('under the limit: no prompt, no notice, payout allowed', async () => {
  const { user, c, brand, base } = await payable();
  await ledger(brand.id, 'sale', 150_000);
  assert.equal(await yearEarnings(brand.id, YEAR), 150_000);
  const t = (await c.get(`${base}/tax`)).json;
  assert.deepEqual(
    [t.status.limit_cents, t.status.year, t.status.earnings_cents, t.status.limit_reached, t.status.form_status, t.status.form_needed, t.status.payout_blocked, t.profile],
    [LIMIT, YEAR, 150_000, false, 'missing', false, false, null],
  );
  // "Auto fill": what is already on file, and never a taxpayer ID.
  assert.deepEqual(t.prefill, { legal_name: 'Jordan Example', legal_name_source: 'payout_details', business_name: brand.name, address_country: 'US' });
  await sendTaxNotices();
  assert.equal((await notices(user.id)).length, 0);
  assert.equal((await emails(brand.id)).length, 0);
  const e = (await c.get(`${base}/earnings`)).json;
  assert.deepEqual([e.tax_form_required, e.can_request], [false, true]);
  const list = (await c.get('/api/studio/brands')).json.brands;
  assert.equal(list.find((b: any) => b.id === brand.id).tax_form_needed, false);
  const p = await c.post(`${base}/payouts`, { amount_cents: 5000 });
  assert.equal(p.status, 201, p.text);
});

test('earnings count sales, tips, membership and refunds of the year; not payouts, adjustments or other years', async () => {
  const { brand } = await payable();
  await ledger(brand.id, 'sale', 120_000);
  await ledger(brand.id, 'tip', 30_000);
  await ledger(brand.id, 'subscription', 70_000);
  assert.equal(await yearEarnings(brand.id, YEAR), 220_000);
  await ledger(brand.id, 'refund', -25_000);
  assert.equal(await yearEarnings(brand.id, YEAR), 195_000, 'net of refunds');
  await ledger(brand.id, 'payout', -50_000);
  await ledger(brand.id, 'adjustment', 50_000);
  await ledger(brand.id, 'sale', 90_000, YEAR - 2);
  assert.equal(await yearEarnings(brand.id, YEAR), 195_000);
  assert.equal(await yearEarnings(brand.id, YEAR - 2), 90_000);
  const s = (await taxStatus(brand.id))!;
  assert.deepEqual([s.limit_reached, s.payout_blocked], [false, false], 'a refund took it back under the limit');
});

test('crossing the limit: one notification and one email, payout refused with tax_form_required', async () => {
  const { user, c, brand, base } = await payable();
  await ledger(brand.id, 'sale', 150_000);
  await sendTaxNotices();
  assert.equal((await notices(user.id)).length, 0);
  await ledger(brand.id, 'sale', 60_000);
  await ledger(brand.id, 'refund', -5_000);

  assert.equal(await sendTaxNotices(), 1);
  assert.equal(await sendTaxNotices(), 0, 'not repeated');
  await Promise.all([sendTaxNotices(), sendTaxNotices()]);
  const n = await notices(user.id);
  assert.equal(n.length, 1);
  assert.match(n[0].title, /tax information needed/);
  assert.equal(n[0].url, `/studio/${brand.slug}/tax`);
  const mail = await emails(brand.id);
  assert.equal(mail.length, 1);
  assert.deepEqual([mail[0].to_email, mail[0].status, mail[0].category], [user.email, 'queued', 'transactional']);
  assert.ok(mail[0].html.includes(`/studio/${brand.slug}/tax`), 'the email links to the form');
  assert.ok(!/\b(1099|W-?9|W-?8|Schedule K)\b/i.test(mail[0].subject + mail[0].html), 'no form number is promised');
  assert.deepEqual((await q('select year, earnings_cents::int as e from tax_notices where publisher_id = $1', [brand.id])), [{ year: YEAR, e: 205_000 }]);

  const t = (await c.get(`${base}/tax`)).json;
  assert.deepEqual([t.status.limit_reached, t.status.reached_year, t.status.form_needed, t.status.payout_blocked], [true, YEAR, true, true]);
  assert.ok(t.notified_at);
  const e = (await c.get(`${base}/earnings`)).json;
  assert.deepEqual([e.tax_form_required, e.can_request], [true, false]);
  assert.equal((await c.get('/api/studio/brands')).json.brands.find((b: any) => b.id === brand.id).tax_form_needed, true);
  assert.equal((await c.get(`/api/studio/brands/by-slug/${brand.slug}`)).json.brand.tax_form_needed, true);

  const p = await c.post(`${base}/payouts`, { amount_cents: 5000 });
  assert.equal(p.status, 409);
  assert.equal(p.json.code, 'tax_form_required');
  assert.match(p.json.error, /tax reporting limit/);
  assert.equal((await one('select count(*)::int as n from payouts where publisher_id = $1', [brand.id]))!.n, 0);
});

test('an invalid SSN or EIN is rejected and nothing is stored', async () => {
  const { c, brand, base } = await payable();
  for (const body of [
    usForm({ tin: '000-00-0000' }), usForm({ tin: '123-45-6789' }), usForm({ tin: '51483216' }), usForm({ tin: '666-83-2167' }),
    usForm({ tin_type: 'ein', tin: '00-1234567' }), usForm({ tin_type: 'ein', tin: '12-345678' }), usForm({ tin: undefined }), usForm({ tin: '' }), usForm({ tin: 514832167 }),
    usForm({ tin_type: null }),
  ]) {
    const r = await c.put(`${base}/tax`, body);
    assert.equal(r.status, 400, r.text);
    assert.equal(r.json.code, 'validation');
    const typed = String((body as any).tin ?? '');
    if (typed.length > 3) assert.ok(!r.text.includes(typed) && !r.text.includes(typed.replace(/\D/g, '')), 'the error does not repeat the number');
  }
  // Other required parts of the form.
  assert.equal((await c.put(`${base}/tax`, usForm({ address_state: 'ZZ' }))).status, 400);
  assert.equal((await c.put(`${base}/tax`, usForm({ address_postal: '4620' }))).status, 400);
  assert.equal((await c.put(`${base}/tax`, usForm({ classification: 'llc' }))).status, 400);
  assert.equal((await c.put(`${base}/tax`, usForm({ classification: 'other' }))).status, 400);
  assert.equal((await c.put(`${base}/tax`, usForm({ certify: false }))).status, 400);
  assert.equal((await c.put(`${base}/tax`, usForm({ signature_name: '' }))).status, 400);
  assert.equal((await c.put(`${base}/tax`, usForm({ certification_text: 'I agree' }))).status, 409, 'the signature must cover the wording shown');
  assert.equal(await one('select 1 from tax_profiles where publisher_id = $1', [brand.id]), null);
});

test('a valid form: payout allowed again, the ID is stored encrypted and never returned', async () => {
  const { user, c, brand, base } = await payable();
  await ledger(brand.id, 'sale', 230_000);
  assert.equal((await c.post(`${base}/payouts`, { amount_cents: 5000 })).status, 409);

  const put = await c.put(`${base}/tax`, usForm({ classification: 'llc', llc_tax_class: 's_corp' }));
  assert.equal(put.status, 200, put.text);
  assert.deepEqual(
    [put.json.profile.status, put.json.profile.tin_type, put.json.profile.tin_last4, put.json.profile.classification, put.json.profile.llc_tax_class, put.json.status.form_status, put.json.status.payout_blocked],
    ['submitted', 'ssn', '2167', 'llc', 's_corp', 'on_file', false],
  );
  const get = await c.get(`${base}/tax`);
  for (const text of [put.text, get.text]) {
    assert.ok(!text.includes(SSN) && !text.includes(SSN_DIGITS), 'the full ID is never in a response');
    assert.ok(!text.includes('tin_encrypted') && !text.includes('v1.'), 'nor is the ciphertext');
  }
  assert.equal(get.json.profile.tin_last4, '2167');
  assert.equal(get.json.profile.certification_text, CERTIFICATIONS.us);

  // The row: ciphertext plus last four, signature details, no plaintext anywhere.
  const row = (await one('select * from tax_profiles where publisher_id = $1', [brand.id]))!;
  assert.match(row.tin_encrypted, /^v1\.[\w-]+\.[\w-]+\.[\w-]+$/);
  assert.equal(decrypt(row.tin_encrypted), SSN_DIGITS);
  const raw = (await one('select row_to_json(t)::text as j from tax_profiles t where publisher_id = $1', [brand.id]))!.j as string;
  assert.ok(!raw.includes(SSN_DIGITS) && !raw.includes(SSN), 'not stored in plaintext');
  assert.deepEqual([row.tin_last4, row.signature_name, row.certification_text, row.submitted_by, row.status], ['2167', 'Jordan Example', CERTIFICATIONS.us, user.id, 'submitted']);
  assert.ok(row.signed_at && row.signature_ip);

  // Audit trail without the number.
  await new Promise((r) => setTimeout(r, 150));
  const log = await q(`select action, meta::text as meta from audit_log where target_id = $1 and action like 'tax.%'`, [brand.id]);
  assert.deepEqual(log.map((l) => l.action), ['tax.profile_submit']);
  assert.ok(!log[0].meta.includes(SSN_DIGITS) && !log[0].meta.includes('2167'));

  const p = await c.post(`${base}/payouts`, { amount_cents: 5000 });
  assert.equal(p.status, 201, p.text);
  assert.equal(await sendTaxNotices(), 0, 'a brand with a form on file is not asked');
  assert.equal((await notices(user.id)).length, 0);

  // Changing anything means entering the whole ID again.
  const again = await c.put(`${base}/tax`, usForm({ tin: undefined, address_city: 'Fort Wayne' }));
  assert.equal(again.status, 400);
  assert.match(again.json.error, /typed in again/);
  const ein = await c.put(`${base}/tax`, usForm({ classification: 'c_corp', tin_type: 'ein', tin: EIN }));
  assert.deepEqual([ein.status, ein.json.profile.tin_type, ein.json.profile.tin_last4], [200, 'ein', '6870']);
  assert.equal((await one('select count(*)::int as n from tax_profiles where publisher_id = $1', [brand.id]))!.n, 1, 'one current row per brand');
});

test('non-US payee: residence, statement, optional foreign tax ID; no US taxpayer ID kept', async () => {
  const { c, brand, base } = await payable();
  await ledger(brand.id, 'sale', 210_000);
  assert.equal((await c.put(`${base}/tax`, foreignForm({ tax_residence_country: null }))).status, 400);
  assert.equal((await c.put(`${base}/tax`, foreignForm({ tax_residence_country: 'US' }))).status, 400);
  assert.equal((await c.put(`${base}/tax`, foreignForm({ not_us_person: false }))).status, 400);
  assert.equal((await c.put(`${base}/tax`, foreignForm({ date_of_birth: '2999-01-01' }))).status, 400);
  assert.equal((await c.put(`${base}/tax`, foreignForm({ certification_text: CERTIFICATIONS.us }))).status, 409);

  const r = await c.put(`${base}/tax`, foreignForm({ tin_type: 'ssn', tin: SSN }));
  assert.equal(r.status, 200, r.text);
  const p = r.json.profile;
  assert.deepEqual(
    [p.is_us_person, p.tin_type, p.tin_last4, p.tax_residence_country, p.foreign_tin_last4, p.date_of_birth, p.address_state, p.address_country],
    [false, null, null, 'CA', '2908', '1988-04-12', 'Ontario', 'CA'],
  );
  assert.ok(!r.text.includes('774 512 908'));
  const row = (await one('select * from tax_profiles where publisher_id = $1', [brand.id]))!;
  assert.deepEqual([row.tin_encrypted, row.not_us_person_statement, row.certification_text], [null, true, CERTIFICATIONS.non_us]);
  assert.equal(decrypt(row.foreign_tin_encrypted), 'CA-774 512 908');
  assert.equal((await c.post(`${base}/payouts`, { amount_cents: 5000 })).status, 201);

  // The foreign tax ID and date of birth are optional.
  const bare = await c.put(`${base}/tax`, foreignForm({ foreign_tin: '', date_of_birth: null, classification: 'c_corp' }));
  assert.deepEqual([bare.status, bare.json.profile.foreign_tin_last4, bare.json.profile.date_of_birth], [200, null, null]);
});

test('only the owner or a brand admin can read or write the form', async () => {
  const { c: ownerClient, brand, base } = await payable();
  const add = async (role: string) => {
    const m = await signedIn();
    await exec('insert into publisher_members (publisher_id, user_id, role) values ($1,$2,$3)', [brand.id, m.user.id, role]);
    return m.c;
  };
  const anon = new Client();
  await anon.get('/api/bootstrap');
  assert.equal((await anon.get(`${base}/tax`)).status, 401);
  assert.equal((await anon.put(`${base}/tax`, usForm())).status, 401);
  for (const c of [await add('editor'), await add('analyst'), (await signedIn()).c]) {
    assert.equal((await c.get(`${base}/tax`)).status, 403);
    assert.equal((await c.put(`${base}/tax`, usForm())).status, 403);
  }
  assert.equal(await one('select 1 from tax_profiles where publisher_id = $1', [brand.id]), null);
  const brandAdmin = await add('admin');
  assert.equal((await brandAdmin.put(`${base}/tax`, usForm())).status, 200);
  assert.equal((await brandAdmin.get(`${base}/tax`)).json.profile.tin_last4, '2167');
  assert.equal((await ownerClient.get(`${base}/tax`)).json.profile.tin_last4, '2167');
  // An editor is not told about the form on the brand either.
  const editor = await add('editor');
  assert.equal((await editor.get(`/api/studio/brands/by-slug/${brand.slug}`)).json.brand.tax_form_needed, false);
});

test('turning the requirement off disables the gate and the notice', async () => {
  const { user, c, brand, base } = await payable();
  await ledger(brand.id, 'sale', 300_000);
  assert.equal((await c.post(`${base}/payouts`, { amount_cents: 5000 })).status, 409);
  await setSetting('revenue', { tax_form_required: false }, null);
  try {
    const s = (await c.get(`${base}/tax`)).json.status;
    assert.deepEqual([s.required, s.limit_reached, s.form_needed, s.payout_blocked], [false, true, true, false]);
    assert.equal(await sendTaxNotices(), 0);
    assert.equal((await notices(user.id)).length, 0);
    assert.equal((await c.get(`${base}/earnings`)).json.tax_form_required, false);
    assert.equal((await c.post(`${base}/payouts`, { amount_cents: 5000 })).status, 201);
  } finally {
    await setSetting('revenue', { tax_form_required: true }, null);
  }
  assert.equal((await c.post(`${base}/payouts`, { amount_cents: 5000 })).status, 409, 'back on');
});

test('the limit is a setting: raising it lifts the gate', async () => {
  const { c, brand, base } = await payable();
  await ledger(brand.id, 'sale', 250_000);
  assert.equal((await c.post(`${base}/payouts`, { amount_cents: 5000 })).status, 409);
  await setSetting('revenue', { tax_reporting_threshold_cents: 60_000_00 }, null);
  try {
    assert.equal((await c.get(`${base}/tax`)).json.status.limit_cents, 6_000_000);
    assert.equal((await c.post(`${base}/payouts`, { amount_cents: 5000 })).status, 201);
  } finally {
    await setSetting('revenue', { tax_reporting_threshold_cents: LIMIT }, null);
  }
});

test('previous year: reaching the limit last year still holds payouts until a form is on file', async () => {
  const { user, c, brand, base } = await payable();
  await ledger(brand.id, 'sale', 240_000, YEAR - 1);
  await ledger(brand.id, 'sale', 30_000);
  const s = (await c.get(`${base}/tax`)).json.status;
  assert.deepEqual([s.earnings_cents, s.previous_year, s.previous_earnings_cents, s.limit_reached, s.reached_year, s.payout_blocked], [30_000, YEAR - 1, 240_000, true, YEAR - 1, true]);
  const p = await c.post(`${base}/payouts`, { amount_cents: 5000 });
  assert.deepEqual([p.status, p.json.code], [409, 'tax_form_required']);
  await sendTaxNotices();
  await sendTaxNotices();
  assert.equal((await notices(user.id)).length, 1);
  assert.deepEqual((await q('select year from tax_notices where publisher_id = $1', [brand.id])).map((r) => r.year), [YEAR - 1]);
  assert.equal((await c.put(`${base}/tax`, usForm())).status, 200);
  assert.equal((await c.post(`${base}/payouts`, { amount_cents: 5000 })).status, 201);

  // Two years back does not count.
  const old = await payable();
  await ledger(old.brand.id, 'sale', 500_000, YEAR - 2);
  await ledger(old.brand.id, 'sale', 30_000);
  assert.equal((await old.c.get(`${old.base}/tax`)).json.status.limit_reached, false);
  assert.equal((await old.c.post(`${old.base}/payouts`, { amount_cents: 5000 })).status, 201);
});

test('admin Tax view: year list, filters, export, reveal and "needs update"', async () => {
  const over = await payable(); // over the limit, form on file
  const missing = await payable(); // over the limit, no form
  const under = await payable(); // under the limit, form on file
  await ledger(over.brand.id, 'sale', 260_000);
  await ledger(missing.brand.id, 'sale', 310_000);
  await ledger(under.brand.id, 'sale', 40_000);
  assert.equal((await over.c.put(`${over.base}/tax`, usForm({ legal_name: 'Avery Overlimit', tin_type: 'ein', tin: EIN, classification: 'c_corp' }))).status, 200);
  assert.equal((await under.c.put(`${under.base}/tax`, usForm())).status, 200);
  await exec(`insert into payouts (publisher_id, amount_cents, status, method, destination, paid_at) values ($1, 120000, 'paid', 'paypal', 'pay@test.invalid', now())`, [over.brand.id]);
  await exec(`insert into payouts (publisher_id, amount_cents, status, method, destination, paid_at) values ($1, 7000, 'paid', 'paypal', 'pay@test.invalid', $2)`, [over.brand.id, new Date(Date.UTC(YEAR - 1, 5, 1))]);

  const adminUser = await signedIn({ role: 'admin' });
  const admin = adminUser.c;
  const sup = await signedIn({ role: 'super_admin' });
  const stranger = (await signedIn()).c;
  assert.equal((await stranger.get('/api/admin/tax')).status, 403);
  assert.equal((await stranger.post('/api/admin/tax/export', {})).status, 403);
  assert.equal((await stranger.post(`/api/admin/tax/${over.brand.id}/reveal`)).status, 403);

  const ids = [over.brand.id, missing.brand.id, under.brand.id];
  const mine = (items: any[]) => items.filter((i) => ids.includes(i.publisher_id));
  const all = (await admin.get(`/api/admin/tax?year=${YEAR}&limit=200`)).json;
  assert.deepEqual([all.year, all.limit_cents, all.form_required, all.years[0]], [YEAR, LIMIT, true, YEAR]);
  assert.ok(all.years.includes(YEAR - 1));
  assert.deepEqual(
    mine(all.items).map((i: any) => [i.publisher_id, i.earnings_cents, i.payouts_paid_cents, i.over_limit, i.form_status, i.tin_type, i.tin_last4]).sort(),
    [[missing.brand.id, 310_000, 0, true, 'missing', null, null], [over.brand.id, 260_000, 120_000, true, 'on_file', 'ein', '6870'], [under.brand.id, 40_000, 0, false, 'on_file', 'ssn', '2167']].sort(),
  );
  assert.ok(all.totals.over_limit >= 2 && all.totals.over_limit_without_form >= 1);
  const listText = (await admin.get(`/api/admin/tax?year=${YEAR}&limit=200`)).text;
  assert.ok(!listText.includes('tin_encrypted') && !listText.includes(EIN_DIGITS) && !listText.includes(EIN) && !listText.includes(SSN_DIGITS), 'the list carries last four only');

  const overOnly = mine((await admin.get(`/api/admin/tax?year=${YEAR}&over=1&limit=200`)).json.items).map((i: any) => i.publisher_id).sort();
  assert.deepEqual(overOnly, [over.brand.id, missing.brand.id].sort());
  const missingOnly = (await admin.get(`/api/admin/tax?year=${YEAR}&over=1&missing=1&limit=200`)).json.items;
  assert.deepEqual(mine(missingOnly).map((i: any) => i.publisher_id), [missing.brand.id]);
  assert.ok(missingOnly.every((i: any) => i.over_limit && i.form_status !== 'on_file'));
  assert.deepEqual(mine((await admin.get(`/api/admin/tax?year=${YEAR}&q=${encodeURIComponent('Avery Overlimit')}`)).json.items).map((i: any) => i.publisher_id), [over.brand.id]);
  const lastYear = (await admin.get(`/api/admin/tax?year=${YEAR - 1}&limit=200`)).json;
  const overLast = lastYear.items.find((i: any) => i.publisher_id === over.brand.id);
  assert.deepEqual([overLast.earnings_cents, overLast.payouts_paid_cents, overLast.over_limit], [0, 7000, false]);
  assert.equal((await admin.get(`/api/admin/tax?year=${YEAR + 1}`)).status, 400);

  // Export for the accountant: brands over the limit, without full IDs.
  const csv = await admin.post('/api/admin/tax/export', { year: YEAR });
  assert.equal(csv.status, 200, csv.text);
  assert.deepEqual([csv.json.filename, csv.json.include_ids], [`creator-tax-${YEAR}.csv`, false]);
  const lines = (csv.json.csv as string).trim().split('\n');
  const header = lines[0].split(',');
  for (const col of ['legal_name', 'business_name', 'classification', 'address_street', 'address_city', 'address_state', 'address_postal', 'address_country', 'taxpayer_id_type', 'taxpayer_id_last4', 'earnings', 'payouts_paid']) assert.ok(header.includes(col), col);
  assert.ok(!header.includes('taxpayer_id') && !header.includes('foreign_tax_id'));
  const lineOf = (text: string, name: string) => text.split('\n').find((l) => l.includes(name))!;
  const cells = lineOf(csv.json.csv, over.brand.name).split(',');
  const cell = (name: string) => cells[header.indexOf(name)];
  assert.deepEqual(
    [cell('legal_name'), cell('business_name'), cell('classification'), cell('address_state'), cell('taxpayer_id_type'), cell('taxpayer_id_last4'), cell('earnings'), cell('payouts_paid'), cell('form_status')],
    ['Avery Overlimit', 'Example Comics', 'c_corp', 'IN', 'EIN', '6870', '2600.00', '1200.00', 'on_file'],
  );
  assert.ok(lineOf(csv.json.csv, missing.brand.name).includes('missing'));
  assert.ok(!(csv.json.csv as string).includes(under.brand.name), 'only brands over the limit');
  assert.ok(!csv.text.includes(EIN) && !csv.text.includes(EIN_DIGITS));

  // Full IDs: super admin, explicit confirmation, audited without the IDs.
  assert.equal((await admin.post('/api/admin/tax/export', { year: YEAR, include_ids: true, confirm: true })).status, 403);
  assert.equal((await sup.c.post('/api/admin/tax/export', { year: YEAR, include_ids: true })).status, 400);
  const full = await sup.c.post('/api/admin/tax/export', { year: YEAR, include_ids: true, confirm: true });
  assert.equal(full.status, 200, full.text);
  assert.equal(full.json.filename, `creator-tax-${YEAR}-with-taxpayer-ids.csv`);
  const fullHeader = (full.json.csv as string).split('\n')[0].split(',');
  assert.equal(lineOf(full.json.csv, over.brand.name).split(',')[fullHeader.indexOf('taxpayer_id')], EIN);
  const exports = await q(`select action, actor_id, meta, meta::text as text from audit_log where action like 'tax.export%' and actor_id = any($1::uuid[]) order by created_at`, [[adminUser.user.id, sup.user.id]]);
  assert.deepEqual(exports.map((e) => e.action), ['tax.export', 'tax.export_with_ids']);
  assert.equal(exports[1].actor_id, sup.user.id);
  assert.deepEqual([exports[1].meta.year, exports[1].meta.include_taxpayer_ids, exports[1].meta.brands], [YEAR, true, full.json.rows]);
  for (const e of exports) assert.ok(!e.text.includes(EIN) && !e.text.includes(EIN_DIGITS) && !e.text.includes('6870'), 'the audit log does not hold the IDs');

  // Reveal one ID.
  assert.equal((await admin.post(`/api/admin/tax/${over.brand.id}/reveal`)).status, 403);
  assert.equal((await sup.c.post(`/api/admin/tax/${missing.brand.id}/reveal`)).status, 404);
  const rev = await sup.c.post(`/api/admin/tax/${over.brand.id}/reveal`);
  assert.deepEqual([rev.status, rev.json.tin_type, rev.json.tin, rev.json.legal_name], [200, 'ein', EIN, 'Avery Overlimit']);
  const revealed = await q(`select actor_id, target_id, meta::text as text from audit_log where action = 'tax.reveal_taxpayer_id' and (actor_id = any($1::uuid[]) or target_id = any($2::text[]))`, [[adminUser.user.id, sup.user.id], ids]);
  assert.equal(revealed.length, 1, 'refused attempts reveal nothing and the one success is logged');
  assert.deepEqual([revealed[0].actor_id, revealed[0].target_id], [sup.user.id, over.brand.id]);
  assert.ok(!revealed[0].text.includes(EIN) && !revealed[0].text.includes(EIN_DIGITS));

  // Needs update: the brand is told, payouts wait again, a new form clears it.
  assert.equal((await over.c.post(`${over.base}/payouts`, { amount_cents: 5000 })).status, 201);
  assert.equal((await admin.post(`/api/admin/tax/${missing.brand.id}/needs-update`, { note: 'Name does not match' })).status, 404);
  assert.equal((await admin.post(`/api/admin/tax/${over.brand.id}/needs-update`, { note: '' })).status, 400);
  const nu = await admin.post(`/api/admin/tax/${over.brand.id}/needs-update`, { note: 'The legal name does not match the EIN.' });
  assert.deepEqual([nu.status, nu.json.notified], [200, 1]);
  const told = await notices(over.user.id);
  assert.equal(told.length, 1);
  assert.match(told[0].body, /legal name does not match/);
  assert.equal(told[0].url, `/studio/${over.brand.slug}/tax`);
  assert.equal((await emails(over.brand.id, 'moderation_notice')).length, 1);
  const st = (await over.c.get(`${over.base}/tax`)).json;
  assert.deepEqual([st.profile.status, st.profile.needs_update_note, st.status.form_status, st.status.payout_blocked], ['needs_update', 'The legal name does not match the EIN.', 'needs_update', true]);
  assert.equal((await admin.get(`/api/admin/tax?year=${YEAR}&missing=1&limit=200`)).json.items.find((i: any) => i.publisher_id === over.brand.id).form_status, 'needs_update');
  assert.equal((await over.c.post(`${over.base}/payouts`, { amount_cents: 5000 })).json.code, 'tax_form_required');
  assert.equal((await over.c.put(`${over.base}/tax`, usForm({ legal_name: 'Avery Overlimit Inc', tin_type: 'ein', tin: EIN, classification: 'c_corp' }))).status, 200);
  const fixed = (await over.c.get(`${over.base}/tax`)).json;
  assert.deepEqual([fixed.profile.status, fixed.profile.needs_update_note, fixed.status.payout_blocked], ['submitted', null, false]);
});

test('admin payouts: the missing form is a warning, not a block', async () => {
  const { c, brand, base } = await payable();
  await ledger(brand.id, 'sale', 150_000);
  const req = await c.post(`${base}/payouts`, { amount_cents: 20_000 });
  assert.equal(req.status, 201, req.text);
  await ledger(brand.id, 'sale', 80_000);
  const sup = (await signedIn({ role: 'super_admin' })).c;
  const row = (await sup.get(`/api/admin/payouts?publisher_id=${brand.id}`)).json.items[0];
  assert.match(row.tax_warning, /reached the tax reporting limit and it has no tax information form on file/);
  const ok = await sup.post(`/api/admin/payouts/${req.json.payout.id}/approve`, {});
  assert.equal(ok.status, 200, ok.text);
  assert.match(ok.json.tax_warning, /no tax information form/);
  const paid = await sup.post(`/api/admin/payouts/${req.json.payout.id}/paid`, { reference: 'TEST-REF-1' });
  assert.equal(paid.status, 200, paid.text);
  assert.match(paid.json.tax_warning, /no tax information form/);
  // With a form on file there is nothing to warn about.
  assert.equal((await c.put(`${base}/tax`, usForm())).status, 200);
  assert.equal((await sup.get(`/api/admin/payouts?status=all&publisher_id=${brand.id}`)).json.items[0].tax_warning, null);
});
