import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { config } from '../config.ts';
import { exec } from '../db.ts';
import { adminScope } from '../lib/admin.ts';
import { sendTemplate } from '../lib/email.ts';
import { audit, badRequest, parse, requireSuperAdmin } from '../lib/http.ts';
import { SETTINGS, getSetting, getSettingMasked, invalidateSettings, setSetting } from '../lib/settings.ts';
import type { SettingKey } from '../lib/settings.ts';
import { testR2 } from '../lib/storage.ts';

/**
 * Settings are super admin only. Secrets are write-only: reads return
 * `{ set: boolean }`, a blank value keeps what is stored, and removing one
 * takes an explicit `clear`. Every change is audited with a masked diff.
 */

const str = (max = 300) => z.string().trim().max(max);
const emailOrBlank = z.union([z.literal(''), z.email('Enter a valid email address')]);
const httpsUrlOrBlank = z.union([z.literal(''), z.string().trim().max(500).regex(/^https?:\/\/[^\s/]+\S*$/, 'Enter a full URL starting with https://')]);
const bps = z.number().int().min(0).max(10000);

const SCHEMAS: Record<SettingKey, z.ZodObject> = {
  site: z.object({
    name: str(60).min(1),
    tagline: str(160),
    support_email: emailOrBlank,
    currency: z.string().trim().toLowerCase().regex(/^[a-z]{3}$/, 'Use a 3-letter currency code such as usd'),
    socials: z.record(z.string().regex(/^[a-z0-9_]{2,24}$/), z.string().trim().max(300).regex(/^https:\/\/\S+$/, 'Social links must start with https://')),
    registration_open: z.boolean(),
    maintenance: z.boolean(),
  }),
  revenue: z.object({
    sale_share_bps: bps,
    sub_share_bps: bps,
    tip_share_bps: bps,
    payout_minimum_cents: z.number().int().min(0).max(1_000_000),
    payout_hold_days: z.number().int().min(0).max(90),
    fee_pct_bps: z.number().int().min(0).max(2000),
    fee_fixed_cents: z.number().int().min(0).max(500),
  }),
  membership: z.object({
    name: str(60).min(1),
    monthly_cents: z.number().int().min(50).max(100_000),
    annual_cents: z.number().int().min(50).max(1_000_000),
    trial_days: z.number().int().min(0).max(90),
    page_credit_cents: z.number().int().min(1).max(1000),
  }),
  storage: z.object({
    driver: z.enum(['local', 'r2']),
    r2_account_id: z.union([z.literal(''), z.string().trim().regex(/^[a-f0-9]{32}$/i, 'The R2 account ID is 32 hexadecimal characters')]),
    r2_bucket: z.union([z.literal(''), z.string().trim().regex(/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/, 'Enter the bucket name exactly as in Cloudflare')]),
    r2_access_key_id: str(200),
    r2_secret_access_key: str(200),
    r2_public_url: httpsUrlOrBlank,
  }),
  email: z.object({
    provider: z.enum(['log', 'sendgrid', 'mailgun']),
    sendgrid_api_key: z.union([z.literal(''), z.string().trim().max(300).regex(/^SG\.[\w-]+\.[\w-]+$/, 'SendGrid API keys start with "SG."')]),
    sendgrid_webhook_key: str(1000),
    mailgun_api_key: str(300),
    mailgun_domain: z.union([z.literal(''), z.string().trim().toLowerCase().regex(/^[a-z0-9.-]+\.[a-z]{2,}$/, 'Enter the sending domain, for example mg.example.com')]),
    mailgun_webhook_signing_key: str(300),
    from_email: emailOrBlank,
    from_name: str(80),
    reply_to: emailOrBlank,
    queue_paused: z.boolean(),
  }),
  payments: z.object({
    provider: z.enum(['sandbox', 'divinity']),
    divinity_api_url: httpsUrlOrBlank,
    divinity_partner_id: str(200),
    divinity_api_key: str(500),
    divinity_webhook_secret: str(500),
    divinity_checkout_logo_url: httpsUrlOrBlank,
  }),
  security: z.object({
    recaptcha_site_key: str(200),
    recaptcha_secret_key: str(200),
    recaptcha_enabled: z.boolean(),
    bot_blocker_enabled: z.boolean(),
    rate_limit_per_minute: z.number().int().min(30).max(100_000),
    admin_2fa_required: z.boolean(),
    max_login_attempts: z.number().int().min(3).max(50),
    password_min_length: z.number().int().min(8).max(128),
  }),
  analytics: z.object({
    ga_measurement_id: z.union([z.literal(''), z.string().trim().regex(/^G-[A-Z0-9]{4,}$/, 'Measurement IDs look like G-XXXXXXXXXX')]),
    sentry_dsn: httpsUrlOrBlank,
  }),
};

const isSection = (s: string): s is SettingKey => Object.hasOwn(SETTINGS, s);
const secretsOf = (section: SettingKey): readonly string[] => SETTINGS[section].secret;

/** Rules that span several fields, checked against the value as it would be after the save. */
function crossCheck(section: SettingKey, v: Record<string, unknown>): void {
  if (section === 'storage' && v.driver === 'r2' && !(v.r2_account_id && v.r2_bucket && v.r2_access_key_id && v.r2_secret_access_key)) {
    throw badRequest('To use R2, fill in the account ID, bucket, access key ID and secret access key');
  }
  if (section === 'email') {
    if (v.provider !== 'log' && !v.from_email) throw badRequest('Set the From address before choosing an email provider');
    if (v.provider === 'sendgrid' && !v.sendgrid_api_key) throw badRequest('Enter the SendGrid API key');
    if (v.provider === 'mailgun' && !(v.mailgun_api_key && v.mailgun_domain)) throw badRequest('Enter the Mailgun API key and sending domain');
  }
  if (section === 'payments') {
    if (v.provider === 'sandbox' && config.isProd) throw badRequest('The sandbox payment provider cannot be used in production. Choose Divinity payments.');
    if (v.provider === 'divinity') {
      if (!(v.divinity_api_url && v.divinity_partner_id && v.divinity_api_key)) throw badRequest('Divinity payments needs the API URL, partner ID and API key');
      if (config.isProd && !String(v.divinity_api_url).startsWith('https://')) throw badRequest('The Divinity API URL must use https://');
    }
  }
  if (section === 'security' && v.recaptcha_enabled && !(v.recaptcha_site_key && v.recaptcha_secret_key)) {
    throw badRequest('Enter both reCAPTCHA keys before turning it on');
  }
  if (section === 'membership' && Number(v.annual_cents) > Number(v.monthly_cents) * 12) {
    throw badRequest('The annual price is higher than twelve monthly payments');
  }
}

type TestResult = { ok: boolean; message: string; detail?: Record<string, unknown> };

/** Network failures become an honest "could not reach" rather than a pass or a crash. */
async function probe(label: string, fn: () => Promise<TestResult>): Promise<TestResult> {
  try {
    return await fn();
  } catch (e) {
    const err = e as Error & { cause?: { code?: string; message?: string } };
    const why = err.name === 'TimeoutError' ? 'timed out after 10 seconds' : err.cause?.code ?? err.cause?.message ?? err.message;
    return { ok: false, message: `Could not reach ${label}: ${why}` };
  }
}

/** Value typed into the form, or the stored one when the field was left blank. */
const pick = (form: Record<string, string | undefined>, stored: Record<string, unknown>, key: string): string => (form[key]?.trim() || String(stored[key] ?? '')).trim();

const formBody = z.record(z.string(), z.string().max(2000)).default({});

export default async function adminSettingsRoutes(app: FastifyInstance) {
  await adminScope(app, (s) => {
    s.get('/api/admin/settings', async (req) => {
      requireSuperAdmin(req);
      const sections: Record<string, unknown> = {};
      for (const key of Object.keys(SETTINGS) as SettingKey[]) sections[key] = await getSettingMasked(key);
      return {
        sections,
        secrets: Object.fromEntries((Object.keys(SETTINGS) as SettingKey[]).map((k) => [k, [...secretsOf(k)]])),
        info: {
          app_url: config.appUrl,
          environment: config.isProd ? 'production' : 'development',
          // Addresses the owner registers with each provider.
          webhooks: {
            divinity: `${config.appUrl}/api/webhooks/divinity`,
            sendgrid: `${config.appUrl}/api/webhooks/email/sendgrid`,
            mailgun: `${config.appUrl}/api/webhooks/email/mailgun`,
          },
          cron_secret_set: Boolean(config.cronSecret),
        },
      };
    });

    /** Body: { section, data: { field: value, ... }, clear?: ["secret_field"] }. Only the fields sent are changed. */
    s.patch('/api/admin/settings', async (req) => {
      const actor = requireSuperAdmin(req);
      const body = parse(z.object({ section: z.string(), data: z.record(z.string(), z.unknown()).default({}), clear: z.array(z.string()).max(20).default([]) }), req.body);
      if (!isSection(body.section)) throw badRequest('Unknown settings section');
      const section = body.section;
      const secrets = secretsOf(section);
      const data = parse(SCHEMAS[section].partial().strict(), body.data) as Record<string, unknown>;
      for (const f of body.clear) if (!secrets.includes(f)) throw badRequest(`${f} is not a secret field of ${section}`);

      const before = (await getSetting(section)) as Record<string, unknown>;
      const after: Record<string, unknown> = { ...before };
      const diff: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(data)) {
        if (secrets.includes(k)) {
          // A blank secret field means "leave it alone".
          if (typeof v !== 'string' || v === '') {
            delete data[k];
            continue;
          }
          if (v !== before[k]) diff[k] = before[k] ? 'secret replaced' : 'secret set';
          after[k] = v;
        } else {
          if (JSON.stringify(v) !== JSON.stringify(before[k])) diff[k] = { from: before[k], to: v };
          after[k] = v;
        }
      }
      for (const f of body.clear) {
        if (data[f]) throw badRequest(`${f} cannot be both set and cleared`);
        if (before[f]) diff[f] = 'secret cleared';
        after[f] = '';
      }
      crossCheck(section, after);

      if (Object.keys(data).length) await setSetting(section, data, actor.id);
      if (body.clear.length) {
        await exec('update settings set value = value - $2::text[], updated_by = $3, updated_at = now() where key = $1', [section, body.clear, actor.id]);
        invalidateSettings();
      }
      if (Object.keys(diff).length) audit(req, 'settings.update', { kind: 'settings', id: section }, { diff });

      const notes: string[] = [];
      if (section === 'storage' && 'driver' in diff) notes.push('Existing files were not moved. Copy the storage directory to the new location before readers notice missing images.');
      if (section === 'security' && diff.admin_2fa_required && after.admin_2fa_required && !actor.totp_enabled) notes.push('You have not set up two-factor authentication yet: you will be asked to do it now.');
      return { ok: true, section, changed: Object.keys(diff), value: await getSettingMasked(section), notes };
    });

    // ------------------------------------------------------------ connection tests
    // Each takes the form's current values (optional); blank secrets fall back to the stored ones.

    s.post('/api/admin/settings/test/r2', async (req) => {
      requireSuperAdmin(req);
      const form = parse(formBody, req.body ?? {});
      const st = (await getSetting('storage')) as Record<string, unknown>;
      const c = {
        accountId: pick(form, st, 'r2_account_id'),
        bucket: pick(form, st, 'r2_bucket'),
        accessKeyId: pick(form, st, 'r2_access_key_id'),
        secretAccessKey: pick(form, st, 'r2_secret_access_key'),
        publicUrl: pick(form, st, 'r2_public_url'),
      };
      if (!(c.accountId && c.bucket && c.accessKeyId && c.secretAccessKey)) return { ok: false, message: 'Fill in the account ID, bucket, access key ID and secret access key first' };
      if (!/^[a-f0-9]{32}$/i.test(c.accountId)) return { ok: false, message: 'The R2 account ID is 32 hexadecimal characters' };
      const r = await testR2(c);
      audit(req, 'settings.test', { kind: 'settings', id: 'storage' }, { target: 'r2', ok: r.ok });
      return r.ok ? { ok: true, message: `Connected to bucket "${c.bucket}"` } : { ok: false, message: `R2 refused the connection: ${r.error}` };
    });

    s.post('/api/admin/settings/test/sendgrid', async (req) => {
      requireSuperAdmin(req);
      const form = parse(formBody, req.body ?? {});
      const key = pick(form, (await getSetting('email')) as Record<string, unknown>, 'sendgrid_api_key');
      if (!key) return { ok: false, message: 'Enter the SendGrid API key first' };
      const r = await probe('SendGrid (api.sendgrid.com)', async () => {
        const res = await fetch('https://api.sendgrid.com/v3/scopes', { headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(10_000) });
        if (res.status === 401 || res.status === 403) return { ok: false, message: 'SendGrid rejected this API key' };
        if (!res.ok) return { ok: false, message: `SendGrid answered ${res.status}` };
        const scopes = ((await res.json()) as { scopes?: string[] }).scopes ?? [];
        if (!scopes.includes('mail.send')) return { ok: false, message: 'The key is valid but lacks the "Mail Send" permission', detail: { scopes: scopes.length } };
        return { ok: true, message: 'SendGrid accepted the key and it can send mail', detail: { scopes: scopes.length } };
      });
      audit(req, 'settings.test', { kind: 'settings', id: 'email' }, { target: 'sendgrid', ok: r.ok });
      return r;
    });

    s.post('/api/admin/settings/test/mailgun', async (req) => {
      requireSuperAdmin(req);
      const form = parse(formBody, req.body ?? {});
      const em = (await getSetting('email')) as Record<string, unknown>;
      const key = pick(form, em, 'mailgun_api_key');
      const domain = pick(form, em, 'mailgun_domain');
      if (!key || !domain) return { ok: false, message: 'Enter the Mailgun API key and sending domain first' };
      if (!/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(domain)) return { ok: false, message: 'That does not look like a domain name' };
      const r = await probe('Mailgun (api.mailgun.net)', async () => {
        const res = await fetch(`https://api.mailgun.net/v3/domains/${encodeURIComponent(domain)}`, {
          headers: { authorization: 'Basic ' + Buffer.from(`api:${key}`).toString('base64') },
          signal: AbortSignal.timeout(10_000),
        });
        if (res.status === 401 || res.status === 403) return { ok: false, message: 'Mailgun rejected this API key' };
        if (res.status === 404) return { ok: false, message: `Mailgun has no domain "${domain}" on this account (EU accounts use a different API host)` };
        if (!res.ok) return { ok: false, message: `Mailgun answered ${res.status}` };
        const d = ((await res.json()) as { domain?: { state?: string } }).domain;
        return d?.state === 'active'
          ? { ok: true, message: `Mailgun domain ${domain} is active` }
          : { ok: false, message: `Mailgun knows ${domain} but its state is "${d?.state ?? 'unknown'}". Finish DNS verification.` };
      });
      audit(req, 'settings.test', { kind: 'settings', id: 'email' }, { target: 'mailgun', ok: r.ok });
      return r;
    });

    /**
     * Divinity payments: a read-only `lookup-payment` for an id that cannot
     * exist. An authentication failure means the key or partner ID is wrong;
     * any other JSON answer means the partner API accepted the credentials.
     */
    s.post('/api/admin/settings/test/divinity', async (req) => {
      requireSuperAdmin(req);
      const form = parse(formBody, req.body ?? {});
      const pay = (await getSetting('payments')) as Record<string, unknown>;
      const url = pick(form, pay, 'divinity_api_url');
      const partnerId = pick(form, pay, 'divinity_partner_id');
      const key = pick(form, pay, 'divinity_api_key');
      if (!url || !partnerId || !key) return { ok: false, message: 'Enter the API URL, partner ID and API key first' };
      if (!/^https?:\/\/[^\s/]+/.test(url) || (config.isProd && !url.startsWith('https://'))) return { ok: false, message: 'The API URL must be a full https:// address' };
      const host = new URL(url).host;
      const r = await probe(`Divinity payments (${host})`, async () => {
        const res = await fetch(`${url}${url.includes('?') ? '&' : '?'}action=lookup-payment`, {
          method: 'POST',
          headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', 'x-partner-id': partnerId },
          body: JSON.stringify({ pledgeId: 'altcomix-connection-test' }),
          signal: AbortSignal.timeout(10_000),
        });
        const text = await res.text();
        let json: Record<string, unknown> | null = null;
        try {
          json = JSON.parse(text) as Record<string, unknown>;
        } catch {
          json = null;
        }
        const said = typeof json?.error === 'string' ? json.error : typeof json?.message === 'string' ? json.message : '';
        if (res.status === 401 || res.status === 403 || /authoriz|api key|partner/i.test(said) && !res.ok) {
          return { ok: false, message: `Divinity payments rejected these credentials${said ? `: ${said}` : ` (HTTP ${res.status})`}` };
        }
        if ([502, 503, 504].includes(res.status) || !json) return { ok: false, message: `Divinity payments is not answering properly right now (HTTP ${res.status} from its gateway)` };
        return { ok: true, message: 'Divinity payments accepted the partner ID and API key', detail: { http_status: res.status } };
      });
      audit(req, 'settings.test', { kind: 'settings', id: 'payments' }, { target: 'divinity', ok: r.ok });
      return { ...r, webhook_url: `${config.appUrl}/api/webhooks/divinity` };
    });

    /** Checks the key formats, then asks Google whether it recognises the secret. */
    s.post('/api/admin/settings/test/recaptcha', async (req) => {
      requireSuperAdmin(req);
      const form = parse(formBody, req.body ?? {});
      const sec = (await getSetting('security')) as Record<string, unknown>;
      const site = pick(form, sec, 'recaptcha_site_key');
      const secret = pick(form, sec, 'recaptcha_secret_key');
      if (!site || !secret) return { ok: false, message: 'Enter both the site key and the secret key first' };
      const shape = /^6L[\w-]{38}$/;
      if (!shape.test(site)) return { ok: false, message: 'The site key does not look like a reCAPTCHA key (40 characters starting with 6L)' };
      if (!shape.test(secret)) return { ok: false, message: 'The secret key does not look like a reCAPTCHA key (40 characters starting with 6L)' };
      if (site === secret) return { ok: false, message: 'The site key and secret key are the same. They are two different values.' };
      const live = await probe('Google reCAPTCHA', async () => {
        const res = await fetch('https://www.google.com/recaptcha/api/siteverify', {
          method: 'POST',
          body: new URLSearchParams({ secret, response: 'connection-test' }),
          signal: AbortSignal.timeout(10_000),
        });
        const codes = ((await res.json()) as { 'error-codes'?: string[] })['error-codes'] ?? [];
        return codes.includes('invalid-input-secret')
          ? { ok: false, message: 'Google does not recognise this secret key' }
          : { ok: true, message: 'Both keys have the right format and Google recognises the secret key' };
      });
      audit(req, 'settings.test', { kind: 'settings', id: 'security' }, { target: 'recaptcha', ok: live.ok });
      // If Google cannot be reached the format check is all we know: say exactly that.
      return live.message.startsWith('Could not reach')
        ? { ok: true, message: 'Both keys have the right format. Google could not be reached to confirm the secret.', detail: { verified_with_google: false } }
        : live;
    });

    /** Queues a real message to the signed-in admin through the normal pipeline. */
    s.post('/api/admin/settings/test/email', async (req) => {
      const actor = requireSuperAdmin(req);
      const em = await getSetting('email');
      const id = await sendTemplate(
        'admin_alert',
        actor.email,
        { subject: 'Test email', body: `This is a test sent from the admin panel at ${new Date().toISOString()}. If you can read it, outbound email works.`, url: `${config.appUrl}/admin/email` },
        { userId: actor.id },
      );
      audit(req, 'settings.test', { kind: 'settings', id: 'email' }, { target: 'send', email_id: id });
      if (!id) return { ok: false, message: 'Your account email address is not valid, so nothing was queued' };
      const message =
        em.provider === 'log' ? 'Queued. The provider is "log", so it will be recorded in the email log but not delivered.'
        : em.queue_paused ? 'Queued, but the queue is paused. Resume it to send.'
        : `Queued for ${actor.email} via ${em.provider}. Check the email log for the result in a few seconds.`;
      return { ok: true, message, email_id: id, to: actor.email };
    });
  });
}
