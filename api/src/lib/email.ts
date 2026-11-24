import { config } from '../config.ts';
import { exec, one, q } from '../db.ts';
import { sign } from './crypto.ts';
import { getSetting } from './settings.ts';

/**
 * Outbound email. Everything is written to the `emails` table first (that
 * table is both queue and log) and delivered by `processEmailQueue`, which the
 * server runs on a timer. Providers: SendGrid, Mailgun, or 'log' (store only).
 */

export type Category = 'transactional' | 'notification' | 'marketing';

export type Mail = {
  to: string;
  subject: string;
  html: string;
  text?: string;
  template?: string;
  category?: Category;
  userId?: string | null;
  publisherId?: string | null;
  sendAfter?: Date;
};

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);
}

function htmlToText(html: string): string {
  return html
    .replace(/<a [^>]*href="([^"]+)"[^>]*>(.*?)<\/a>/gi, '$2 ($1)')
    .replace(/<br\s*\/?>(\s*)/gi, '\n')
    .replace(/<\/(p|h\d|div|tr)>/gi, '\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Signed, stateless unsubscribe token for an address. */
export function unsubscribeToken(email: string): string {
  const e = email.toLowerCase();
  return Buffer.from(`${e}:${sign('unsub:' + e).slice(0, 32)}`).toString('base64url');
}

export function readUnsubscribeToken(token: string): string | null {
  try {
    const raw = Buffer.from(token, 'base64url').toString('utf8');
    const i = raw.lastIndexOf(':');
    if (i < 1) return null;
    const email = raw.slice(0, i);
    return sign('unsub:' + email).slice(0, 32) === raw.slice(i + 1) ? email : null;
  } catch {
    return null;
  }
}

/** Shared wrapper so every message looks the same. */
export async function layout(bodyHtml: string, opts: { unsubscribeEmail?: string } = {}): Promise<string> {
  const site = await getSetting('site');
  const footer = opts.unsubscribeEmail
    ? `<p style="margin:0">You are receiving this because of your notification settings on ${escapeHtml(site.name)}.
       <a href="${config.appUrl}/api/unsubscribe?token=${unsubscribeToken(opts.unsubscribeEmail)}" style="color:#8a8f98">Unsubscribe</a></p>`
    : `<p style="margin:0">This is a service message about your ${escapeHtml(site.name)} account.</p>`;
  return `<!doctype html><html><body style="margin:0;background:#f3f1ec;font-family:Helvetica,Arial,sans-serif;color:#1a1c20">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:32px 16px">
<table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%">
<tr><td style="padding:0 0 16px;font-size:20px;font-weight:700;letter-spacing:-.01em">${escapeHtml(site.name)}</td></tr>
<tr><td style="background:#ffffff;border-radius:10px;padding:28px;font-size:15px;line-height:1.55">${bodyHtml}</td></tr>
<tr><td style="padding:16px 4px;font-size:12px;line-height:1.5;color:#8a8f98">${footer}</td></tr>
</table></td></tr></table></body></html>`;
}

export function button(label: string, url: string): string {
  return `<p style="margin:24px 0"><a href="${url}" style="background:#1a1c20;color:#ffffff;text-decoration:none;padding:12px 20px;border-radius:8px;font-weight:600;display:inline-block">${escapeHtml(label)}</a></p>`;
}

/** Built-in templates. A row in `email_templates` with the same key overrides subject/body. */
export const TEMPLATES: Record<string, { subject: string; html: string; vars: string[]; category: Category }> = {
  verify_email: {
    subject: 'Confirm your email for {{site}}',
    html: '<p>Hi {{name}},</p><p>Confirm this address to finish setting up your account.</p>{{button:Confirm email|url}}<p>The link works for 48 hours.</p>',
    vars: ['name', 'url', 'site'],
    category: 'transactional',
  },
  reset_password: {
    subject: 'Reset your {{site}} password',
    html: '<p>Hi {{name}},</p><p>Use the button below to choose a new password. If you did not ask for this, you can ignore this message.</p>{{button:Choose a new password|url}}<p>The link works for 2 hours.</p>',
    vars: ['name', 'url', 'site'],
    category: 'transactional',
  },
  email_change: {
    subject: 'Confirm your new email address',
    html: '<p>Hi {{name}},</p><p>Confirm that you want to use this address for your {{site}} account.</p>{{button:Confirm new address|url}}',
    vars: ['name', 'url', 'site'],
    category: 'transactional',
  },
  welcome: {
    subject: 'Welcome to {{site}}',
    html: '<p>Hi {{name}},</p><p>Your account is ready. Start with something free, or publish your own book in a few minutes.</p>{{button:Open the store|url}}',
    vars: ['name', 'url', 'site'],
    category: 'transactional',
  },
  receipt: {
    subject: 'Your {{site}} receipt',
    html: '<p>Hi {{name}},</p><p>Thanks for your purchase.</p>{{items}}<p><strong>Total: {{total}}</strong></p>{{button:Go to your library|url}}',
    vars: ['name', 'items', 'total', 'url', 'site'],
    category: 'transactional',
  },
  backer_code: {
    subject: 'Your digital copy of {{title}}',
    html: '<p>{{message}}</p><p>Your code: <strong style="font-size:18px;letter-spacing:.06em">{{code}}</strong></p>{{button:Redeem and read|url}}<p>Sent on behalf of {{brand}}.</p>',
    vars: ['title', 'message', 'code', 'url', 'brand'],
    category: 'transactional',
  },
  team_invite: {
    subject: 'You have been invited to {{brand}} on {{site}}',
    html: '<p>{{inviter}} invited you to join <strong>{{brand}}</strong> as {{role}}.</p>{{button:Accept invitation|url}}',
    vars: ['brand', 'inviter', 'role', 'url', 'site'],
    category: 'transactional',
  },
  payout_update: {
    subject: 'Payout {{status}}: {{amount}}',
    html: '<p>Your payout request of <strong>{{amount}}</strong> for {{brand}} is now <strong>{{status}}</strong>.</p><p>{{note}}</p>{{button:View earnings|url}}',
    vars: ['amount', 'status', 'brand', 'note', 'url'],
    category: 'transactional',
  },
  new_release: {
    subject: 'New from {{series}}: {{release}}',
    html: '<p><strong>{{release}}</strong> is out now.</p><p>{{synopsis}}</p>{{button:Read now|url}}',
    vars: ['series', 'release', 'synopsis', 'url'],
    category: 'notification',
  },
  announcement: {
    subject: '{{subject}}',
    html: '<p>{{body}}</p><p>From {{brand}}.</p>',
    vars: ['subject', 'body', 'brand'],
    category: 'marketing',
  },
  gift_card: {
    subject: 'You received a {{amount}} gift card for {{site}}',
    html: '<p>{{message}}</p><p>Gift code: <strong style="font-size:18px;letter-spacing:.06em">{{code}}</strong></p>{{button:Redeem|url}}',
    vars: ['amount', 'message', 'code', 'url', 'site'],
    category: 'transactional',
  },
  membership_started: {
    subject: 'Your {{plan}} membership is active',
    html: '<p>Hi {{name}},</p><p>Your membership is active and renews on {{renews}}.</p>{{button:Start reading|url}}',
    vars: ['name', 'plan', 'renews', 'url'],
    category: 'transactional',
  },
  new_message: {
    subject: 'New message from {{from}}',
    html: '<p><strong>{{from}}</strong> sent you a message:</p><p>{{preview}}</p>{{button:Reply|url}}',
    vars: ['from', 'preview', 'url'],
    category: 'notification',
  },
  admin_alert: {
    subject: '[{{site}}] {{subject}}',
    html: '<p>{{body}}</p>{{button:Open admin|url}}',
    vars: ['subject', 'body', 'url', 'site'],
    category: 'transactional',
  },
};

/** Vars whose values are already HTML and must not be escaped. */
const RAW_VARS = new Set(['items']);

function render(tpl: string, vars: Record<string, string>, escape: boolean): string {
  return tpl
    .replace(/\{\{button:([^|}]+)\|(\w+)\}\}/g, (_m, label, key) => (escape ? button(label, vars[key] ?? '#') : `${label}: ${vars[key] ?? ''}`))
    .replace(/\{\{(\w+)\}\}/g, (_m, key) => {
      const v = vars[key] ?? '';
      return escape && !RAW_VARS.has(key) ? escapeHtml(v) : v;
    });
}

/** Queue a templated email. */
export async function sendTemplate(
  key: keyof typeof TEMPLATES | string,
  to: string,
  vars: Record<string, string>,
  opts: { userId?: string | null; publisherId?: string | null; sendAfter?: Date } = {},
): Promise<string | null> {
  const builtin = TEMPLATES[key];
  if (!builtin) throw new Error(`Unknown email template ${key}`);
  const override = await one<{ subject: string; html: string }>('select subject, html from email_templates where key = $1', [key]);
  const site = await getSetting('site');
  const all = { site: site.name, ...vars };
  const subject = render(override?.subject ?? builtin.subject, all, false);
  const body = render(override?.html ?? builtin.html, all, true);
  const html = await layout(body, builtin.category === 'transactional' ? {} : { unsubscribeEmail: to });
  return queueEmail({ to, subject, html, template: key, category: builtin.category, ...opts });
}

export async function queueEmail(mail: Mail): Promise<string | null> {
  const to = mail.to.trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) return null;
  const category = mail.category ?? 'transactional';
  let status = 'queued';
  let error: string | null = null;
  const suppressed = await one<{ reason: string }>('select reason from email_suppressions where email = $1', [to]);
  if (suppressed) {
    status = 'suppressed';
    error = `Suppressed: ${suppressed.reason}`;
  } else if (category !== 'transactional') {
    const u = await one('select 1 from users where lower(email) = $1 and email_unsubscribed_at is not null', [to]);
    if (u) {
      status = 'suppressed';
      error = 'Recipient unsubscribed';
    }
  }
  const row = await one<{ id: string }>(
    `insert into emails (to_email, user_id, publisher_id, template, category, subject, html, text_body, status, error, send_after)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) returning id`,
    [to, mail.userId ?? null, mail.publisherId ?? null, mail.template ?? null, category, mail.subject, mail.html,
     mail.text ?? htmlToText(mail.html), status, error, mail.sendAfter ?? new Date()],
  );
  return row?.id ?? null;
}

type Deliver = { ok: true; provider: string; id?: string } | { ok: false; provider: string; error: string };

async function deliver(m: { to_email: string; subject: string; html: string; text_body: string; category: string; id: string }): Promise<Deliver> {
  const s = await getSetting('email');
  const from = s.from_email;
  const listUnsub =
    m.category === 'transactional' ? null : `<${config.appUrl}/api/unsubscribe?token=${unsubscribeToken(m.to_email)}>`;

  if (s.provider === 'sendgrid') {
    if (!s.sendgrid_api_key || !from) return { ok: false, provider: 'sendgrid', error: 'SendGrid is not configured' };
    const headers: Record<string, string> = {};
    if (listUnsub) {
      headers['List-Unsubscribe'] = listUnsub;
      headers['List-Unsubscribe-Post'] = 'List-Unsubscribe=One-Click';
    }
    const res = await fetch('https://api.sendgrid.com/v3/mail/send', {
      method: 'POST',
      headers: { authorization: `Bearer ${s.sendgrid_api_key}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        personalizations: [{ to: [{ email: m.to_email }], custom_args: { email_id: m.id } }],
        from: { email: from, name: s.from_name },
        ...(s.reply_to ? { reply_to: { email: s.reply_to } } : {}),
        subject: m.subject,
        content: [
          { type: 'text/plain', value: m.text_body || ' ' },
          { type: 'text/html', value: m.html },
        ],
        ...(Object.keys(headers).length ? { headers } : {}),
        tracking_settings: { click_tracking: { enable: m.category !== 'transactional' }, open_tracking: { enable: true } },
      }),
      signal: AbortSignal.timeout(20_000),
    });
    if (res.status >= 200 && res.status < 300) return { ok: true, provider: 'sendgrid', id: res.headers.get('x-message-id') ?? undefined };
    return { ok: false, provider: 'sendgrid', error: `SendGrid ${res.status}: ${(await res.text()).slice(0, 400)}` };
  }

  if (s.provider === 'mailgun') {
    if (!s.mailgun_api_key || !s.mailgun_domain || !from) return { ok: false, provider: 'mailgun', error: 'Mailgun is not configured' };
    const form = new URLSearchParams({
      from: s.from_name ? `${s.from_name} <${from}>` : from,
      to: m.to_email,
      subject: m.subject,
      text: m.text_body || ' ',
      html: m.html,
      'v:email_id': m.id,
    });
    if (s.reply_to) form.set('h:Reply-To', s.reply_to);
    if (listUnsub) {
      form.set('h:List-Unsubscribe', listUnsub);
      form.set('h:List-Unsubscribe-Post', 'List-Unsubscribe=One-Click');
    } else {
      // Keep Mailgun from adding its own unsubscribe handling to service mail.
      form.set('o:tracking-clicks', 'no');
    }
    const res = await fetch(`https://api.mailgun.net/v3/${s.mailgun_domain}/messages`, {
      method: 'POST',
      headers: { authorization: 'Basic ' + Buffer.from(`api:${s.mailgun_api_key}`).toString('base64') },
      body: form,
      signal: AbortSignal.timeout(20_000),
    });
    if (res.ok) return { ok: true, provider: 'mailgun', id: ((await res.json()) as { id?: string }).id };
    return { ok: false, provider: 'mailgun', error: `Mailgun ${res.status}: ${(await res.text()).slice(0, 400)}` };
  }

  // 'log': nothing leaves the server. Refuse to pretend in production.
  if (config.isProd) return { ok: false, provider: 'log', error: 'No email provider configured in /admin' };
  return { ok: true, provider: 'log' };
}

const MAX_ATTEMPTS = 4;

/** Claim and send up to `batch` queued emails. Safe to run from several workers. */
export async function processEmailQueue(batch = 20): Promise<{ sent: number; failed: number }> {
  const s = await getSetting('email');
  if (s.queue_paused) return { sent: 0, failed: 0 };
  let sent = 0;
  let failed = 0;
  for (let i = 0; i < batch; i++) {
    const m = await one(
      `update emails set status = 'sending', attempts = attempts + 1
        where id = (select id from emails where status = 'queued' and send_after <= now()
                     order by (category = 'transactional') desc, created_at limit 1 for update skip locked)
        returning id, to_email, subject, html, text_body, category, attempts`,
    );
    if (!m) break;
    let r: Deliver;
    try {
      r = await deliver(m as never);
    } catch (e) {
      r = { ok: false, provider: s.provider, error: (e as Error).message };
    }
    if (r.ok) {
      sent++;
      await exec(`update emails set status = 'sent', sent_at = now(), provider = $2, provider_id = $3, error = null where id = $1`, [m.id, r.provider, r.id ?? null]);
    } else {
      failed++;
      const giveUp = m.attempts >= MAX_ATTEMPTS;
      await exec(
        `update emails set status = $2, provider = $3, error = $4, send_after = now() + (interval '2 minutes' * power(4, attempts - 1)) where id = $1`,
        [m.id, giveUp ? 'failed' : 'queued', r.provider, r.error],
      );
    }
  }
  return { sent, failed };
}

/** Emails stuck in 'sending' (worker died mid-send) go back to the queue. */
export async function recoverStuckEmails(): Promise<number> {
  return exec(`update emails set status = 'queued' where status = 'sending' and created_at < now() - interval '15 minutes' and sent_at is null and attempts < $1`, [MAX_ATTEMPTS]);
}

export async function suppress(email: string, reason: string, source = 'manual'): Promise<void> {
  await exec(
    `insert into email_suppressions (email, reason, source) values ($1,$2,$3) on conflict (email) do update set reason = excluded.reason, source = excluded.source`,
    [email.toLowerCase(), reason, source],
  );
}

/** Notify every admin. The same subject is sent at most once an hour. */
export async function alertAdmins(subject: string, body: string, url = `${config.appUrl}/admin`): Promise<void> {
  const recent = await one(
    `select 1 from emails where template = 'admin_alert' and subject like $1 and created_at > now() - interval '1 hour' limit 1`,
    [`%${subject}%`],
  );
  if (recent) return;
  const admins = await q<{ email: string; id: string }>(`select id, email from users where role in ('admin','super_admin') and deleted_at is null`);
  for (const a of admins) await sendTemplate('admin_alert', a.email, { subject, body, url }, { userId: a.id });
}
