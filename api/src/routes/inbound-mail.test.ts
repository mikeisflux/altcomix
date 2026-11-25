import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { fixtures, useTestDatabase } from '../lib/commerce.testkit.ts';

/** Inbound mail end to end through the real HTTP stack (app.inject): webhook, admin mailboxes, replies. */
process.env.APP_URL = 'https://comix.test';
await useTestDatabase('inbound');
process.env.ROUTES = 'auth,catalog,admin-mailboxes,admin-dashboard,webhooks-inbound';
const { exec, one, q, pool } = await import('../db.ts');
const { setSetting } = await import('../lib/settings.ts');
const { processEmailQueue } = await import('../lib/email.ts');
const { sanitizeMailHtml, htmlToText, parseAddress, isAutomated, parseHeaders } = await import('../lib/inbound-mail.ts');
const { storage } = await import('../lib/storage.ts');
const { buildApp } = await import('../server.ts');
const f = await fixtures();
const app = await buildApp();

const TOKEN = 'test-token-0123456789abcdefghijklmnopqrstuv';
const HOOK = `/api/webhooks/email/inbound/${TOKEN}`;

class Client {
  cookies: Record<string, string> = {};
  async call(method: string, url: string, body?: unknown) {
    const cookie = Object.entries(this.cookies).map(([k, v]) => `${k}=${v}`).join('; ');
    const res = await app.inject({
      method: method as 'GET', url,
      headers: { ...(cookie ? { cookie } : {}), ...(this.cookies.csrf_token ? { 'x-csrf-token': this.cookies.csrf_token } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      payload: body !== undefined ? JSON.stringify(body) : undefined,
    });
    for (const c of [res.headers['set-cookie'] ?? []].flat()) {
      const [pair] = String(c).split(';');
      const i = pair.indexOf('=');
      if (pair.slice(i + 1)) this.cookies[pair.slice(0, i)] = pair.slice(i + 1);
    }
    let json: any = null;
    try {
      json = JSON.parse(res.payload);
    } catch {
      // not JSON (a download)
    }
    return { status: res.statusCode, json, res };
  }
  get = (url: string) => this.call('GET', url);
  post = (url: string, body: unknown = {}) => this.call('POST', url, body);
  async login(email: string) {
    await this.get('/api/bootstrap');
    const r = await this.post('/api/auth/login', { email, password: 'correct horse battery' });
    assert.equal(r.status, 200, r.res.payload);
    return this;
  }
}

type Part = { name: string; value: string | Buffer; filename?: string; type?: string };

/** The multipart body SendGrid Inbound Parse posts in its default (non-raw) mode. */
function multipart(parts: Part[]): { payload: Buffer; headers: Record<string, string> } {
  const boundary = 'xYzZY';
  const chunks: Buffer[] = [];
  for (const p of parts) {
    let head = `--${boundary}\r\nContent-Disposition: form-data; name="${p.name}"`;
    if (p.filename !== undefined) head += `; filename="${p.filename}"\r\nContent-Type: ${p.type ?? 'application/octet-stream'}`;
    chunks.push(Buffer.from(head + '\r\n\r\n', 'latin1'), typeof p.value === 'string' ? Buffer.from(p.value, 'utf8') : p.value, Buffer.from('\r\n'));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return { payload: Buffer.concat(chunks), headers: { 'content-type': `multipart/form-data; boundary=${boundary}`, 'user-agent': 'Sendlib/1.0' } };
}

let seq = 0;
type MailOpts = {
  to?: string; from?: string; subject?: string; text?: string; html?: string; messageId?: string | null; extraHeaders?: string; spamScore?: string;
  envelopeTo?: string[]; files?: { filename: string; type: string; data: Buffer }[]; raw?: Part[]; charsets?: Record<string, string>;
};

function sendgridParts(o: MailOpts = {}): Part[] {
  const to = o.to ?? 'support@comix.test';
  const from = o.from ?? 'Sam Reader <sam@reader.example>';
  const fromAddress = parseAddress(from).email;
  const messageId = o.messageId === undefined ? `<msg-${Date.now()}-${++seq}@mail.reader.example>` : o.messageId;
  const subject = o.subject ?? 'Question about my order';
  const headers = [
    'Received: by mx0047p1mdw1.sendgrid.net with SMTP id abc123 Tue, 24 Nov 2026 10:00:00 +0000 (UTC)',
    'DKIM-Signature: v=1; a=rsa-sha256; c=relaxed/relaxed; d=reader.example; s=s1;',
    ' h=from:to:subject; bh=abc=; b=def=',
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${subject}`,
    ...(messageId ? [`Message-ID: ${messageId}`] : []),
    'MIME-Version: 1.0',
    'Content-Type: multipart/alternative; boundary="000000000000a1b2c3"',
    ...(o.extraHeaders ? [o.extraHeaders] : []),
  ].join('\n') + '\n';
  const files = o.files ?? [];
  const info: Record<string, unknown> = {};
  files.forEach((file, i) => (info[`attachment${i + 1}`] = { filename: file.filename, name: file.filename, type: file.type }));
  return [
    { name: 'headers', value: headers },
    { name: 'dkim', value: '{@reader.example : pass}' },
    { name: 'to', value: to },
    ...(o.html !== undefined ? [{ name: 'html', value: o.html }] : []),
    { name: 'from', value: from },
    { name: 'text', value: o.text ?? 'Hello,\n\nI bought issue 2 yesterday and it is not in my library.\n\nSam\n' },
    { name: 'sender_ip', value: '203.0.113.9' },
    { name: 'spam_report', value: 'Spam detection software, running on the system "mx0047p1mdw1.sendgrid.net"' },
    { name: 'envelope', value: JSON.stringify({ to: o.envelopeTo ?? [parseAddress(to).email], from: fromAddress }) },
    { name: 'attachments', value: String(files.length) },
    { name: 'subject', value: subject },
    { name: 'spam_score', value: o.spamScore ?? '0.011' },
    ...(files.length ? [{ name: 'attachment-info', value: JSON.stringify(info) }] : []),
    { name: 'charsets', value: JSON.stringify(o.charsets ?? { to: 'UTF-8', html: 'UTF-8', subject: 'UTF-8', from: 'UTF-8', text: 'UTF-8' }) },
    { name: 'SPF', value: 'pass' },
    ...files.map((file, i) => ({ name: `attachment${i + 1}`, value: file.data, filename: file.filename, type: file.type })),
    ...(o.raw ?? []),
  ];
}

async function deliver(o: MailOpts = {}, url = HOOK) {
  const res = await app.inject({ method: 'POST', url, ...multipart(sendgridParts(o)) });
  return { status: res.statusCode, json: JSON.parse(res.payload) as { ok?: boolean; result?: string; error?: string } };
}
const stored = async (o: MailOpts = {}) => {
  const id = `<t-${Date.now()}-${++seq}@mail.reader.example>`;
  const r = await deliver({ messageId: id, ...o });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.result, 'stored');
  return (await one('select * from inbound_emails where message_id = $1', [(o.messageId ?? id).replace(/^<|>$/g, '')]))!;
};

let admin: Client, superAdmin: Client, reader: Client;
let adminUser: Awaited<ReturnType<typeof f.user>>;

before(async () => {
  await exec('delete from mailbox_replies');
  await exec('delete from inbound_emails');
  await exec('delete from mailboxes');
  await exec('delete from inbound_blocklist');
  await exec('delete from emails');
  await exec('delete from email_suppressions');
  await exec(`delete from settings where key = 'email'`);
  await setSetting('email', { from_email: 'hello@comix.test' }, null);
  adminUser = await f.user({ role: 'admin' });
  admin = await new Client().login(adminUser.email);
  superAdmin = await new Client().login((await f.user({ role: 'super_admin' })).email);
  reader = await new Client().login((await f.user()).email);
});

after(async () => {
  await app.close();
  await pool.end();
});

test('the webhook is closed until a token is set, and a wrong token is a 404', async () => {
  assert.equal((await deliver()).status, 404, 'no token configured: fail closed');
  assert.equal((await deliver({}, '/api/webhooks/email/inbound/')).status, 404);

  // An admin generates it; only a super admin may.
  assert.equal((await admin.post('/api/admin/inbound-mail/token')).status, 403);
  const gen = await superAdmin.post('/api/admin/inbound-mail/token');
  assert.equal(gen.status, 200);
  const url: string = gen.json.url;
  assert.match(url, /^https:\/\/comix\.test\/api\/webhooks\/email\/inbound\/[A-Za-z0-9_-]{43}$/);
  assert.equal((await superAdmin.get('/api/admin/inbound-mail')).json.url, url);
  const raw = await one<{ value: Record<string, string> }>(`select value from settings where key = 'email'`);
  assert.ok(!url.endsWith(raw!.value.inbound_token), 'the token is stored encrypted');

  // From here on the tests use a known token (as the shell script or the settings form would set it).
  await setSetting('email', { inbound_token: TOKEN }, null);
  assert.equal((await deliver({}, url.replace('https://comix.test', ''))).status, 404, 'the replaced token no longer works');
  assert.equal((await deliver({}, HOOK + 'x')).status, 404);
  assert.equal((await deliver({}, HOOK.slice(0, -1))).status, 404);
  assert.equal(await one('select 1 from inbound_emails'), null, 'nothing was stored by the refused calls');

  // No CSRF token and no cookies, like the provider's servers.
  const ok = await deliver();
  assert.equal(ok.status, 200);
  assert.equal(ok.json.result, 'stored');
});

test('a SendGrid delivery with an attachment is stored, a support mailbox is created, admins are told', async () => {
  const boxes = await q('select * from mailboxes');
  assert.equal(boxes.length, 1, 'first mail created the default mailbox');
  assert.equal(boxes[0].address, 'support@comix.test');
  assert.equal(boxes[0].is_default, true);

  const pdf = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(2048, 7)]);
  const e = await stored({
    subject: 'Receipt attached', html: '<p>Hello <b>there</b></p>',
    files: [{ filename: 'receipt #1.pdf', type: 'application/pdf', data: pdf }],
  });
  assert.equal(e.from_email, 'sam@reader.example');
  assert.equal(e.from_name, 'Sam Reader');
  assert.equal(e.to_email, 'support@comix.test');
  assert.equal(e.mailbox_id, boxes[0].id);
  assert.equal(e.subject, 'Receipt attached');
  assert.match(e.text_body, /issue 2 yesterday/);
  assert.equal(e.html_body, '<p>Hello <b>there</b></p>');
  assert.equal(e.spf, 'pass');
  assert.equal(e.dkim, '{@reader.example : pass}');
  assert.equal(e.spam, false);
  assert.equal(e.read_at, null);

  const atts = await q('select * from inbound_attachments where email_id = $1', [e.id]);
  assert.equal(atts.length, 1);
  assert.equal(atts[0].filename, 'receipt #1.pdf');
  assert.equal(atts[0].content_type, 'application/pdf');
  assert.equal(Number(atts[0].size_bytes), pdf.length);
  assert.ok(atts[0].storage_key.startsWith('private/inbound-mail/'), 'attachments are never public');
  assert.deepEqual(await (await storage()).read(atts[0].storage_key), pdf);
  assert.equal((await app.inject({ method: 'GET', url: `/media/${atts[0].storage_key}` })).statusCode, 404, 'not reachable through /media');

  const note = await one(`select * from notifications where user_id = $1 and kind = 'inbox' and url = $2`, [adminUser.id, `/admin/inbox?open=${e.id}`]);
  assert.ok(note, 'in-app notification for staff');
  assert.match(note.title, /New email to Support: Receipt attached/);
  assert.equal(await one(`select 1 from emails where template = 'admin_alert'`), null, 'no email per email to admins');

  // Download: always an attachment, never inline; admins only.
  const dl = await admin.get(`/api/admin/inbox/attachments/${atts[0].id}`);
  assert.equal(dl.status, 200);
  assert.match(String(dl.res.headers['content-disposition']), /^attachment; filename="receipt #1\.pdf"/);
  assert.equal(dl.res.headers['content-type'], 'application/octet-stream');
  assert.deepEqual(dl.res.rawPayload, pdf);
  assert.equal((await reader.get(`/api/admin/inbox/attachments/${atts[0].id}`)).status, 403);
  assert.equal((await new Client().get(`/api/admin/inbox/attachments/${atts[0].id}`)).status, 401);
});

test('mail is routed by the envelope recipient: exact mailbox, else the default; other domains are dropped', async () => {
  const made = await superAdmin.post('/api/admin/mailboxes', { address: 'DMCA@comix.test', name: 'Copyright' });
  assert.equal(made.status, 200, made.res.payload);
  assert.equal(made.json.mailbox.address, 'dmca@comix.test');
  const [support] = await q(`select * from mailboxes where address = 'support@comix.test'`);

  // The To header says one thing, the envelope is where it was really delivered.
  const a = await stored({ to: 'Someone Else <someone@elsewhere.example>', envelopeTo: ['dmca@comix.test'] });
  assert.equal(a.mailbox_id, made.json.mailbox.id);
  const b = await stored({ to: 'press@comix.test' });
  assert.equal(b.mailbox_id, support.id, 'no mailbox for press@: default mailbox');
  assert.equal(b.to_email, 'press@comix.test');

  const before = (await one<{ n: number }>('select count(*)::int as n from inbound_emails'))!.n;
  const c = await deliver({ to: 'victim@elsewhere.example' });
  assert.equal(c.status, 200, 'deliberately dropped mail still answers 200');
  assert.equal(c.json.result, 'not_ours');
  assert.equal((await one<{ n: number }>('select count(*)::int as n from inbound_emails'))!.n, before);

  // A mailbox that is turned off no longer catches its address.
  await superAdmin.call('PATCH', `/api/admin/mailboxes/${made.json.mailbox.id}`, { active: false });
  assert.equal((await stored({ to: 'dmca@comix.test' })).mailbox_id, support.id);
  await superAdmin.call('PATCH', `/api/admin/mailboxes/${made.json.mailbox.id}`, { active: true });
});

test('blocked senders and domains are dropped and the hit is counted', async () => {
  assert.equal((await admin.post('/api/admin/inbox/blocklist', { kind: 'address', value: 'Pest@spam.example' })).status, 200);
  assert.equal((await admin.post('/api/admin/inbox/blocklist', { kind: 'domain', value: 'junk.example' })).status, 200);
  assert.equal((await admin.post('/api/admin/inbox/blocklist', { kind: 'domain', value: 'comix.test' })).status, 400, 'cannot block the site itself');

  for (const from of ['Pest <pest@spam.example>', 'a@junk.example', 'b@mail.junk.example']) {
    const r = await deliver({ from });
    assert.equal(r.status, 200);
    assert.equal(r.json.result, 'blocked');
  }
  assert.equal(await one(`select 1 from inbound_emails where from_email in ('pest@spam.example','a@junk.example','b@mail.junk.example')`), null);
  const rows = await q('select kind, value, hits, last_hit_at from inbound_blocklist order by kind');
  assert.deepEqual(rows.map((r) => [r.kind, r.value, r.hits]), [['address', 'pest@spam.example', 1], ['domain', 'junk.example', 2]]);
  assert.ok(rows[0].last_hit_at);
  assert.equal((await deliver({ from: 'other@spam.example' })).json.result, 'stored', 'only that address is blocked');
});

test('a retried delivery with the same Message-ID is stored once', async () => {
  const messageId = '<retry-1@mail.reader.example>';
  assert.equal((await deliver({ messageId, subject: 'Only once' })).json.result, 'stored');
  const again = await deliver({ messageId, subject: 'Only once' });
  assert.equal(again.status, 200);
  assert.equal(again.json.result, 'duplicate');
  assert.equal((await q(`select 1 from inbound_emails where message_id = 'retry-1@mail.reader.example'`)).length, 1);
});

test('replies join the conversation by In-Reply-To / References, else by subject and correspondent', async () => {
  const first = await stored({ subject: 'Where is my payout?', from: 'Jo Artist <jo@studio.example>' });
  const byHeader = await stored({
    subject: 'A completely different subject', from: 'Jo Artist <jo@studio.example>',
    extraHeaders: `In-Reply-To: <${first.message_id}>\nReferences: <unknown@x.example>\n <${first.message_id}>`,
  });
  assert.equal(byHeader.thread_key, first.thread_key);
  assert.equal(byHeader.in_reply_to, first.message_id);
  assert.deepEqual(byHeader.reference_ids, ['unknown@x.example', first.message_id]);

  const bySubject = await stored({ subject: 'RE: Fwd:  where is my PAYOUT?', from: 'jo@studio.example' });
  assert.equal(bySubject.thread_key, first.thread_key);
  const otherPerson = await stored({ subject: 'Where is my payout?', from: 'someone@other.example' });
  assert.notEqual(otherPerson.thread_key, first.thread_key);

  const view = await admin.get(`/api/admin/inbox/${bySubject.id}`);
  assert.equal(view.status, 200);
  assert.deepEqual(view.json.thread.map((m: { id: string }) => m.id), [first.id, byHeader.id, bySubject.id]);
  assert.equal(view.json.email.id, bySubject.id);
  assert.ok((await one('select read_at from inbound_emails where id = $1', [first.id]))!.read_at, 'opening marks the conversation read');
});

test('attachment caps: at most 10 files, 10 MB each, 25 MB together; the rest is left out with a note', async () => {
  const small = (n: number) => ({ filename: `page-${n}.png`, type: 'image/png', data: Buffer.alloc(1000 + n, n) });
  const many = await stored({ subject: 'Twelve files', files: Array.from({ length: 12 }, (_, i) => small(i + 1)) });
  const kept = await q('select filename from inbound_attachments where email_id = $1 order by created_at', [many.id]);
  assert.deepEqual(kept.map((k) => k.filename), Array.from({ length: 10 }, (_, i) => `page-${i + 1}.png`));
  assert.match(many.notes.join(' '), /2 more attachments were left out: only the first 10 are kept/);

  const big = await stored({
    subject: 'One huge file',
    files: [{ filename: 'huge.zip', type: 'application/zip', data: Buffer.alloc(10 * 1024 * 1024 + 1, 1) }, small(1)],
  });
  assert.deepEqual((await q('select filename from inbound_attachments where email_id = $1', [big.id])).map((k) => k.filename), ['page-1.png']);
  assert.match(big.notes.join(' '), /"huge\.zip" was left out because it is larger than 10 MB/);

  const nine = (n: number) => ({ filename: `scan-${n}.bin`, type: 'application/octet-stream', data: Buffer.alloc(9 * 1024 * 1024, n) });
  const total = await stored({ subject: 'Three large files', files: [nine(1), nine(2), nine(3)] });
  const rows = await q('select filename, size_bytes from inbound_attachments where email_id = $1 order by created_at', [total.id]);
  assert.deepEqual(rows.map((k) => k.filename), ['scan-1.bin', 'scan-2.bin']);
  assert.match(total.notes.join(' '), /1 attachment was left out: the attachments together were larger than 25 MB/);
});

test('spam goes to the spam folder: no notification, no attachments kept', async () => {
  const e = await stored({ subject: 'WIN BIG', from: 'promo@deals.example', spamScore: '7.9', files: [{ filename: 'banner.gif', type: 'image/gif', data: Buffer.alloc(500, 1) }] });
  assert.equal(e.spam, true);
  assert.equal(e.spam_flagged, true);
  assert.equal(Math.round(e.spam_score * 10), 79);
  assert.equal(await one('select 1 from inbound_attachments where email_id = $1', [e.id]), null);
  assert.match(e.notes.join(' '), /not kept because the message was flagged as spam/);
  assert.equal(await one(`select 1 from notifications where url = $1`, [`/admin/inbox?open=${e.id}`]), null);
  const inbox = await admin.get('/api/admin/inbox?q=WIN+BIG');
  assert.equal(inbox.json.items.length, 0);
  const spam = await admin.get('/api/admin/inbox?folder=spam&q=WIN+BIG');
  assert.deepEqual(spam.json.items.map((i: { id: string }) => i.id), [e.id]);
});

test('auto-reply: once per sender per day, never to robots, lists or automatic mail', async () => {
  const box = (await one(`select id from mailboxes where address = 'support@comix.test'`))!;
  const set = await superAdmin.call('PATCH', `/api/admin/mailboxes/${box.id}`, { auto_reply: 'Thanks for writing. A person will answer within two working days.' });
  assert.equal(set.status, 200, set.res.payload);
  const autos = async (to: string) => q(`select r.*, e.headers, e.from_email as queue_from, e.to_email as queue_to, e.subject as queue_subject from mailbox_replies r join emails e on e.id = r.email_id where r.kind = 'auto_reply' and r.to_email = $1`, [to]);

  const first = await stored({ from: 'Pat <pat@reader.example>', subject: 'Hello?' });
  let sent = await autos('pat@reader.example');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].queue_from, 'support@comix.test');
  assert.equal(sent[0].queue_subject, 'Re: Hello?');
  assert.equal(sent[0].headers['Auto-Submitted'], 'auto-replied');
  assert.equal(sent[0].headers['In-Reply-To'], `<${first.message_id}>`);
  assert.equal(sent[0].thread_key, first.thread_key);

  await stored({ from: 'pat@reader.example', subject: 'Hello again' });
  sent = await autos('pat@reader.example');
  assert.equal(sent.length, 1, 'second message the same day gets no auto-reply');
  await exec(`update mailbox_replies set created_at = now() - interval '25 hours' where kind = 'auto_reply' and to_email = 'pat@reader.example'`);
  await stored({ from: 'pat@reader.example', subject: 'Next day' });
  assert.equal((await autos('pat@reader.example')).length, 2, 'a day later it is sent again');

  const quiet: [string, MailOpts][] = [
    ['no-reply@shop.example', {}],
    ['MAILER-DAEMON@mx.example', { subject: 'Undelivered Mail Returned to Sender' }],
    ['news@list.example', { extraHeaders: 'Precedence: bulk' }],
    ['robot@auto.example', { extraHeaders: 'Auto-Submitted: auto-replied' }],
    ['digest@groups.example', { extraHeaders: 'List-Id: <digest.groups.example>\nPrecedence: list' }],
    ['ooo@office.example', { extraHeaders: 'X-Auto-Response-Suppress: All' }],
    // Our own mailbox answering itself would loop for ever.
    ['dmca@comix.test', {}],
  ];
  for (const [from, extra] of quiet) {
    await stored({ from, ...extra });
    assert.equal((await autos(from.toLowerCase())).length, 0, `no auto-reply to ${from}`);
  }
  // "Auto-Submitted: no" is a person.
  await stored({ from: 'human@reader.example', extraHeaders: 'Auto-Submitted: no' });
  assert.equal((await autos('human@reader.example')).length, 1);
  await superAdmin.call('PATCH', `/api/admin/mailboxes/${box.id}`, { auto_reply: '' });
  await stored({ from: 'later@reader.example' });
  assert.equal((await autos('later@reader.example')).length, 0, 'no auto-reply text, no auto-reply');

  assert.equal(isAutomated('jo@studio.example', parseHeaders('From: jo@studio.example\n')), false);
  assert.equal(isAutomated('bounce+abc@mail.example', new Map()), true);
  assert.equal(isAutomated('x@y.example', parseHeaders('Return-Path: <>\n')), true);
});

test('hostile HTML is sanitized before it is stored', async () => {
  const hostile = [
    '<html><head><title>x</title><style>body{background:url(https://evil.example/bg.png)}</style>',
    '<script>window.__pwned = 1</script><meta http-equiv="refresh" content="0;url=https://evil.example"></head>',
    '<body onload="alert(1)"><h1 style="color:red; background-image:url(https://evil.example/t.gif); position:fixed">Hi</h1>',
    '<img src="https://tracker.example/open.gif?id=1" onerror="alert(2)" width="1" height="1">',
    '<img src=x onerror=alert(3)><img src="data:image/png;base64,iVBORw0KGgo=" alt="dot"><img src="cid:logo@x">',
    '<a href="javascript:alert(4)">one</a> <a href="JaVa&#x09;ScRiPt:alert(5)">two</a> <a href="&#106;avascript:alert(6)">three</a>',
    '<a href="https://ok.example/page?a=1&amp;b=2" onclick="steal()">four</a> <a href="data:text/html,<script>alert(7)</script>">five</a>',
    '<form action="https://evil.example/login"><input name="password"><button>Sign in</button></form>',
    '<iframe src="https://evil.example"></iframe><object data="x.swf"></object><embed src="x.swf">',
    '<svg onload="alert(8)"><script>alert(9)</script></svg><math><mi xlink:href="javascript:alert(10)">m</mi></math>',
    '<div style="width:100px;behavior:url(x.htc);color:expression(alert(11))">box</div>',
    '<scr<script>ipt>pwn12()</scr</script>ipt><p>Bye &amp; thanks &copy; "quoted"</p><b>unclosed',
    '<!-- <script>alert(13)</script> --><link rel="stylesheet" href="https://evil.example/x.css"><base href="https://evil.example/">',
  ].join('\n');
  const e = await stored({ subject: 'Hostile', html: hostile, text: '' });
  const html: string = e.html_body;
  for (const bad of [/<script/i, /onerror/i, /onload/i, /onclick/i, /javascript:/i, /<style/i, /<iframe/i, /<form/i, /<input/i, /<object/i, /<embed/i, /<svg/i, /<math/i, /<meta/i, /<link/i, /<base/i, /url\(/i, /expression/i, /behavior/i, /position/i, /evil\.example/i, /__pwned/, /alert\(/, /cid:/]) {
    assert.doesNotMatch(html, bad);
  }
  // A tag split around another tag ends up as plain, escaped text.
  assert.match(html, /ipt&gt;pwn12\(\)ipt&gt;/);
  // Remote images are parked, not loaded.
  assert.doesNotMatch(html, /\ssrc="https?:/i);
  assert.match(html, /<img data-remote-src="https:\/\/tracker\.example\/open\.gif\?id=1" width="1" height="1">/);
  assert.match(html, /<img src="data:image\/png;base64,iVBORw0KGgo=" alt="dot">/);
  assert.match(html, /<h1 style="color: red">Hi<\/h1>/);
  assert.match(html, /<a target="_blank" rel="noopener noreferrer nofollow">one<\/a>/);
  assert.match(html, /<a href="https:\/\/ok\.example\/page\?a=1&amp;b=2" title="[^"]+" target="_blank" rel="noopener noreferrer nofollow">four<\/a>/);
  assert.match(html, /<div style="width: 100px">box<\/div>/);
  assert.match(html, /<p>Bye &amp; thanks &copy; &quot;quoted&quot;<\/p><b>unclosed\s*<\/b>$/);
  // With no text part, the plain text is made from the HTML, without the code.
  assert.match(e.text_body, /Hi/);
  assert.doesNotMatch(e.text_body, /alert|background|<|__pwned|javascript/i);
  assert.match(e.text_body, /four \(https:\/\/ok\.example\/page\?a=1&b=2\)/);

  // The sanitizer on its own.
  assert.equal(sanitizeMailHtml('<p>a<script>x</p>'), '<p>a</p>');
  assert.equal(sanitizeMailHtml('<img src="x" onerror="alert(1)"'), '');
  assert.equal(sanitizeMailHtml('<a href="https://a.example/" title="x" href="javascript:1">l</a>'), '<a href="https://a.example/" title="https://a.example/" target="_blank" rel="noopener noreferrer nofollow">l</a>');
  assert.equal(sanitizeMailHtml('1 < 2 & 3 > "2"'), '1 &lt; 2 &amp; 3 &gt; &quot;2&quot;');
  assert.equal(sanitizeMailHtml('<p title=\'" data-remote-src="https://x.example/\'>t</p>'), '<p title="&quot; data-remote-src=&quot;https://x.example/">t</p>');
  assert.equal(sanitizeMailHtml('<img src="//tracker.example/a.gif"><img src="data:image/svg+xml;base64,AAAA" alt="x">'), '');
  assert.equal(sanitizeMailHtml('<STYLE>p{}</STYLE><P CLASS="x" ID="y">t</P>'), '<p>t</p>');
  assert.equal(sanitizeMailHtml('<table><tr><td colspan="2" bgcolor="#fff">c</td></tr></table>'), '<table><tr><td colspan="2" bgcolor="#fff">c</td></tr></table>');
  assert.equal(htmlToText('<style>p{color:red}</style><p>Hello&nbsp;<a href="https://a.example/x">there</a></p><p>Bye</p>'), 'Hello there (https://a.example/x)\nBye');
});

test('fields are decoded with the character sets SendGrid reports', async () => {
  const parts = sendgridParts({ messageId: '<latin-1@mail.reader.example>', charsets: { to: 'UTF-8', subject: 'iso-8859-1', from: 'UTF-8', text: 'windows-1252' } })
    .map((p) => (p.name === 'subject' ? { ...p, value: Buffer.from('Caf\xe9 cr\xe8me', 'latin1') } : p.name === 'text' ? { ...p, value: Buffer.from('It costs \x80 5 \x96 na\xefve', 'latin1') } : p));
  const res = await app.inject({ method: 'POST', url: HOOK, ...multipart(parts) });
  assert.equal(res.statusCode, 200, res.payload);
  const e = (await one(`select subject, text_body from inbound_emails where message_id = 'latin-1@mail.reader.example'`))!;
  assert.equal(e.subject, 'Café crème');
  assert.equal(e.text_body, 'It costs € 5 – naïve');
  const utf = await stored({ subject: 'Ünïcödé ✓ 漫画', from: '"Zoë, Reader" <zoe@reader.example>' });
  assert.equal(utf.subject, 'Ünïcödé ✓ 漫画');
  assert.equal(utf.from_name, 'Zoë, Reader');
});

test('Mailgun field names are accepted as well', async () => {
  const res = await app.inject({
    method: 'POST', url: HOOK, headers: { 'content-type': 'application/x-www-form-urlencoded' },
    payload: new URLSearchParams({
      recipient: 'support@comix.test', sender: 'kim@reader.example', from: 'Kim <kim@reader.example>', subject: 'Via Mailgun', 'body-plain': 'Plain body', 'body-html': '<p>Plain body</p>',
      'Message-Id': '<mg-1@reader.example>', 'attachment-count': '0', 'X-Mailgun-Sflag': 'No', 'X-Mailgun-Sscore': '0.1',
      'message-headers': JSON.stringify([['Message-Id', '<mg-1@reader.example>'], ['Subject', 'Via Mailgun']]),
    }).toString(),
  });
  assert.equal(res.statusCode, 200, res.payload);
  const e = (await one(`select * from inbound_emails where message_id = 'mg-1@reader.example'`))!;
  assert.equal(e.from_email, 'kim@reader.example');
  assert.equal(e.text_body, 'Plain body');
  assert.equal(e.to_email, 'support@comix.test');
});

test('admin permissions: staff only; mailboxes and the webhook address are for super admins', async () => {
  const anon = new Client();
  await anon.get('/api/bootstrap');
  for (const c of [anon, reader]) {
    const want = c === anon ? 401 : 403;
    assert.equal((await c.get('/api/admin/inbox')).status, want);
    assert.equal((await c.get('/api/admin/mailboxes')).status, want);
    assert.equal((await c.get('/api/admin/inbox/blocklist')).status, want);
    assert.equal((await c.get('/api/admin/inbound-mail')).status, want);
    assert.equal((await c.post('/api/admin/inbox/compose', { mailbox_id: adminUser.id, to: 'a@b.example', subject: 's', body: 'b' })).status, want);
    assert.equal((await c.post('/api/admin/mailboxes', { address: 'x@comix.test', name: 'X' })).status, want);
  }
  assert.equal((await admin.get('/api/admin/inbox')).status, 200);
  const boxes = await admin.get('/api/admin/mailboxes');
  assert.equal(boxes.status, 200);
  assert.ok(boxes.json.items.find((m: { address: string; unread: number }) => m.address === 'support@comix.test' && m.unread > 0));
  assert.equal((await admin.post('/api/admin/mailboxes', { address: 'x@comix.test', name: 'X' })).status, 403);
  assert.equal((await admin.get('/api/admin/inbound-mail')).status, 403);
  // Without the CSRF header a signed-in admin's POST is refused too.
  const noCsrf = await app.inject({ method: 'POST', url: '/api/admin/inbox/compose', headers: { cookie: Object.entries(admin.cookies).map(([k, v]) => `${k}=${v}`).join('; '), 'content-type': 'application/json' }, payload: '{}' });
  assert.equal(noCsrf.statusCode, 403);

  assert.equal((await superAdmin.post('/api/admin/mailboxes', { address: 'support@comix.test', name: 'Again' })).status, 409);
  assert.equal((await superAdmin.post('/api/admin/mailboxes', { address: 'me@elsewhere.example', name: 'Elsewhere' })).status, 400, 'only our own domains');
  const made = await superAdmin.post('/api/admin/mailboxes', { address: 'press@comix.test', name: 'Press', is_default: true });
  assert.equal(made.status, 200);
  assert.deepEqual((await q('select address from mailboxes where is_default')).map((m) => m.address), ['press@comix.test'], 'one default at a time');
  await stored({ to: 'press@comix.test', subject: 'For the bin', files: [{ filename: 'a.txt', type: 'text/plain', data: Buffer.from('hi') }] });
  const key = (await one(`select a.storage_key from inbound_attachments a join inbound_emails e on e.id = a.email_id where e.mailbox_id = $1`, [made.json.mailbox.id]))!.storage_key;
  const gone = await superAdmin.call('DELETE', `/api/admin/mailboxes/${made.json.mailbox.id}`);
  assert.equal(gone.status, 200);
  assert.equal(gone.json.emails_deleted, 1);
  assert.equal(await (await storage()).read(key), null, 'attachments are removed with the mailbox');
  const support = (await one(`select id from mailboxes where address = 'support@comix.test'`))!;
  await superAdmin.call('PATCH', `/api/admin/mailboxes/${support.id}`, { is_default: true });

  const badge = await admin.get('/api/admin/badges');
  assert.equal(badge.status, 200);
  assert.ok(badge.json.inbox_unread > 0);
});

test('filing: read and unread, archive, spam with block, delete', async () => {
  const e = await stored({ from: 'Ann <ann@pushy.example>', subject: 'Buy followers', files: [{ filename: 'offer.pdf', type: 'application/pdf', data: Buffer.from('%PDF') }] });
  const other = await stored({ from: 'ann@pushy.example', subject: 'Buy followers now' });
  const listed = async (query: string) => (await admin.get(`/api/admin/inbox?${query}`)).json.items.map((i: { id: string }) => i.id) as string[];

  assert.ok((await listed('unread=1&q=pushy.example')).includes(e.id));
  assert.equal((await admin.get(`/api/admin/inbox/${e.id}`)).json.email.attachments.length, 1);
  assert.ok(!(await listed('unread=1&q=pushy.example')).includes(e.id), 'opening marked it read');
  assert.equal((await admin.post(`/api/admin/inbox/${e.id}/read`, { read: false })).status, 200);
  assert.ok((await listed('unread=1&q=pushy.example')).includes(e.id));

  assert.equal((await admin.post(`/api/admin/inbox/${e.id}/archive`, { archived: true })).status, 200);
  assert.ok(!(await listed('q=pushy.example')).includes(e.id));
  assert.ok((await listed('folder=archived&q=pushy.example')).includes(e.id));
  await admin.post(`/api/admin/inbox/${e.id}/archive`, { archived: false });
  assert.ok((await listed('mailbox=' + e.mailbox_id + '&q=Buy+followers')).includes(e.id));

  const spam = await admin.post(`/api/admin/inbox/${e.id}/spam`, { spam: true, block: 'address' });
  assert.equal(spam.status, 200, spam.res.payload);
  assert.equal(spam.json.also_filed, 1, 'the other message from the sender is filed too');
  assert.deepEqual((await listed('folder=spam&q=pushy.example')).sort(), [e.id, other.id].sort());
  assert.equal((await deliver({ from: 'ann@pushy.example' })).json.result, 'blocked');
  assert.equal((await admin.get(`/api/admin/inbox/${e.id}`)).json.blocked.value, 'ann@pushy.example');
  assert.equal((await admin.post(`/api/admin/inbox/${e.id}/spam`, { spam: false })).json.spam, false);
  assert.ok((await listed('q=pushy.example')).includes(e.id));
  const entry = (await admin.get('/api/admin/inbox/blocklist')).json.items.find((b: { value: string }) => b.value === 'ann@pushy.example');
  assert.equal(entry.hits, 1);
  assert.equal((await admin.call('DELETE', `/api/admin/inbox/blocklist/${entry.id}`)).status, 200);
  assert.equal((await deliver({ from: 'ann@pushy.example' })).json.result, 'stored');

  const key = (await one('select storage_key from inbound_attachments where email_id = $1', [e.id]))!.storage_key;
  assert.equal((await admin.call('DELETE', `/api/admin/inbox/${e.id}`)).status, 200);
  assert.equal(await one('select 1 from inbound_emails where id = $1', [e.id]), null);
  assert.equal(await (await storage()).read(key), null);
  assert.equal((await admin.get(`/api/admin/inbox/${e.id}`)).status, 404);
  assert.equal((await admin.get('/api/admin/inbox/not-an-id')).status, 404);
});

test('a reply goes out through the queue from the mailbox, with threading headers, and is recorded on the thread', async () => {
  const original = await stored({
    from: 'Lee Backer <lee@reader.example>', subject: 'Refund please', text: 'I was charged twice.\nPlease refund one.',
    extraHeaders: 'References: <older-1@reader.example>\nReply-To: Lee at work <lee.work@office.example>',
  });
  assert.equal(original.reply_to, 'lee.work@office.example');
  assert.equal((await admin.post(`/api/admin/inbox/${original.id}/reply`, { body: '  ' })).status, 400);

  const r = await admin.post(`/api/admin/inbox/${original.id}/reply`, { body: 'Hi Lee,\n\nRefunded today. <b>Sorry</b> about that.' });
  assert.equal(r.status, 200, r.res.payload);
  assert.equal(r.json.to, 'lee.work@office.example', 'answers go to Reply-To');
  assert.equal(r.json.status, 'queued');

  const queued = (await one('select * from emails where id = $1', [r.json.email_id]))!;
  assert.equal(queued.to_email, 'lee.work@office.example');
  assert.equal(queued.from_email, 'support@comix.test');
  assert.equal(queued.from_name, 'Support');
  assert.equal(queued.reply_to, 'support@comix.test');
  assert.equal(queued.subject, 'Re: Refund please');
  assert.deepEqual(queued.headers, { 'In-Reply-To': `<${original.message_id}>`, References: `<older-1@reader.example> <${original.message_id}>` });
  assert.match(queued.text_body, /Refunded today[\s\S]*wrote:\n> I was charged twice\.\n> Please refund one\./);
  assert.match(queued.html, /&lt;b&gt;Sorry&lt;\/b&gt;/, 'what the admin typed is text, not markup');
  assert.ok((await one('select replied_at from inbound_emails where id = $1', [original.id]))!.replied_at);

  // What the provider is asked to send.
  await setSetting('email', { provider: 'sendgrid', sendgrid_api_key: 'SG.test.key', reply_to: 'ignored@comix.test' }, null);
  await exec(`update emails set status = 'cancelled' where status = 'queued' and id <> $1`, [queued.id]);
  const realFetch = globalThis.fetch;
  const calls: { url: string; body: any }[] = [];
  globalThis.fetch = (async (url: string, init: { body: string }) => {
    calls.push({ url: String(url), body: JSON.parse(init.body) });
    return new Response('', { status: 202, headers: { 'x-message-id': 'sg-abc' } });
  }) as never;
  try {
    assert.deepEqual(await processEmailQueue(5), { sent: 1, failed: 0 });
  } finally {
    globalThis.fetch = realFetch;
    await setSetting('email', { provider: 'log' }, null);
  }
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.sendgrid.com/v3/mail/send');
  assert.deepEqual(calls[0].body.from, { email: 'support@comix.test', name: 'Support' });
  assert.deepEqual(calls[0].body.reply_to, { email: 'support@comix.test' });
  assert.deepEqual(calls[0].body.headers, { 'In-Reply-To': `<${original.message_id}>`, References: `<older-1@reader.example> <${original.message_id}>` });
  assert.deepEqual(calls[0].body.personalizations[0].to, [{ email: 'lee.work@office.example' }]);

  // The customer's answer threads back, and the conversation shows all three in order.
  const answer = await stored({ from: 'lee.work@office.example', subject: 'RE: Refund please', extraHeaders: `In-Reply-To: <provider-made-id@sendgrid.example>\nReferences: <older-1@reader.example> <${original.message_id}> <provider-made-id@sendgrid.example>` });
  assert.equal(answer.thread_key, original.thread_key);
  const view = await admin.get(`/api/admin/inbox/${answer.id}`);
  assert.deepEqual(view.json.thread.map((m: { type: string }) => m.type), ['received', 'sent', 'received']);
  assert.equal(view.json.thread[1].status, 'sent');
  assert.equal(view.json.thread[1].sent_by_name, adminUser.display_name);
  assert.equal(view.json.thread[1].text_body, 'Hi Lee,\n\nRefunded today. <b>Sorry</b> about that.');

  // The suppression list still wins.
  await exec(`insert into email_suppressions (email, reason, source) values ('gone@reader.example', 'Hard bounce', 'test')`);
  const bounced = await stored({ from: 'gone@reader.example', subject: 'Old address' });
  const refused = await admin.post(`/api/admin/inbox/${bounced.id}/reply`, { body: 'Hello?' });
  assert.equal(refused.status, 200);
  assert.equal(refused.json.status, 'suppressed');
  assert.match(refused.json.error, /Suppressed: Hard bounce/);

  // A new message from a mailbox; the answer to it threads by subject and correspondent.
  const box = (await one(`select id from mailboxes where address = 'dmca@comix.test'`))!;
  const fresh = await admin.post('/api/admin/inbox/compose', { mailbox_id: box.id, to: 'Rights@Holder.example', subject: 'Your notice', body: 'We removed the series.' });
  assert.equal(fresh.status, 200, fresh.res.payload);
  const out = (await one('select * from emails where id = $1', [fresh.json.email_id]))!;
  assert.equal(out.from_email, 'dmca@comix.test');
  assert.equal(out.to_email, 'rights@holder.example');
  assert.equal(out.headers, null);
  const back = await stored({ to: 'dmca@comix.test', from: 'rights@holder.example', subject: 'Re: Your notice' });
  const thread = (await admin.get(`/api/admin/inbox/${back.id}`)).json.thread;
  assert.deepEqual(thread.map((m: { type: string; kind?: string }) => m.kind ?? m.type), ['new', 'received']);
  assert.equal((await admin.post('/api/admin/inbox/compose', { mailbox_id: box.id, to: 'not an address', subject: 's', body: 'b' })).status, 400);
});

test('ordinary site mail still uses the site sender', async () => {
  const { queueEmail } = await import('../lib/email.ts');
  const id = await queueEmail({ to: 'someone@reader.example', subject: 'Plain', html: '<p>x</p>', headers: { 'X-Evil': 'nope', Bcc: 'a@b.example', 'In-Reply-To': '<a@b>\r\nBcc: c@d.example' } });
  const row = (await one('select from_email, reply_to, headers from emails where id = $1', [id]))!;
  assert.equal(row.from_email, null);
  assert.equal(row.reply_to, null);
  assert.deepEqual(row.headers, { 'In-Reply-To': '<a@b> Bcc: c@d.example' }, 'only threading headers, never a second header line');
});
