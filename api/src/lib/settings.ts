import { q, exec } from '../db.ts';
import { decrypt, encrypt } from './crypto.ts';

/**
 * Admin-editable settings. Each key holds one JSON object. Fields listed in
 * `secret` are stored encrypted and are never sent to the browser: the admin
 * API returns only whether they are set.
 */
export const SETTINGS = {
  site: {
    defaults: {
      name: 'NSFWComix',
      tagline: 'Your comic. Your rules.',
      support_email: '',
      currency: 'usd',
      socials: {} as Record<string, string>,
      registration_open: true,
      maintenance: false,
    },
    secret: [] as string[],
  },
  revenue: {
    defaults: {
      // Creator share of each kind of money, in basis points of the price the reader paid.
      // The processor takes its fee (below) and the platform keeps what is left:
      // sales 93.5% creator + 3.5% processor + 3% platform; membership 80% + 3.5% + 16.5%.
      sale_share_bps: 9350,
      sub_share_bps: 8000,
      tip_share_bps: 9500,
      payout_minimum_cents: 2000,
      payout_hold_days: 7,
      // What the payment processor keeps of each charge.
      fee_pct_bps: 350,
      fee_fixed_cents: 0,
      // Creator taxes: a brand whose earnings in a calendar year reach this is asked for a tax
      // information form. The owner sets the figure with their accountant.
      tax_reporting_threshold_cents: 200000,
      // Off = no form is asked for and payouts are never held for one.
      tax_form_required: true as boolean,
    },
    secret: [],
  },
  membership: {
    defaults: {
      name: 'NSFWComix Unlimited',
      monthly_cents: 599,
      annual_cents: 5900,
      trial_days: 0,
      page_credit_cents: 5,
    },
    secret: [],
  },
  creator_premium: {
    defaults: {
      // The optional yearly plan a brand can buy (lib/premium.ts). Price per brand per year, before sales tax.
      name: 'Creator Premium',
      annual_cents: 14000,
    },
    secret: [],
  },
  storage: {
    defaults: {
      driver: 'local' as 'local' | 'r2',
      r2_account_id: '',
      r2_bucket: '',
      r2_access_key_id: '',
      r2_secret_access_key: '',
      r2_public_url: '',
    },
    secret: ['r2_secret_access_key'],
  },
  email: {
    defaults: {
      // 'log' writes mail to the email log without sending (development).
      provider: 'log' as 'log' | 'sendgrid' | 'mailgun',
      sendgrid_api_key: '',
      sendgrid_webhook_key: '',
      mailgun_api_key: '',
      mailgun_domain: '',
      mailgun_webhook_signing_key: '',
      from_email: '',
      from_name: 'NSFWComix',
      reply_to: '',
      queue_paused: false,
      // The secret last part of the inbound mail webhook address. Empty = inbound mail is off.
      inbound_token: '',
    },
    secret: ['sendgrid_api_key', 'sendgrid_webhook_key', 'mailgun_api_key', 'mailgun_webhook_signing_key', 'inbound_token'],
  },
  payments: {
    defaults: {
      // 'divinity' is the production processor (Divinity payments partner API).
      // 'sandbox' completes orders instantly and is refused in production.
      provider: 'sandbox' as 'sandbox' | 'divinity',
      divinity_api_url: 'https://divinitycoin.com/internal',
      divinity_partner_id: '',
      divinity_api_key: '',
      divinity_webhook_secret: '',
      // Logo shown on the hosted checkout page (absolute URL).
      divinity_checkout_logo_url: '',
      // Show the hosted checkout framed inside our own pages (desktop browsers). The processor has to
      // allow this site to frame its checkout page first; off = every buyer is sent to the page instead.
      divinity_embed_checkout: true as boolean,
    },
    secret: ['divinity_api_key', 'divinity_webhook_secret'],
  },
  security: {
    defaults: {
      recaptcha_site_key: '',
      recaptcha_secret_key: '',
      recaptcha_enabled: false,
      bot_blocker_enabled: true,
      rate_limit_per_minute: 240,
      admin_2fa_required: false,
      max_login_attempts: 8,
      password_min_length: 10,
    },
    secret: ['recaptcha_secret_key'],
  },
  analytics: {
    defaults: { ga_measurement_id: '', sentry_dsn: '' },
    secret: [],
  },
  tax: {
    defaults: {
      // Sales tax at checkout (lib/salestax.ts). Off = no location is asked for and nothing is charged.
      enabled: false as boolean,
      // Rate per US state (two-letter code, 50 states + DC) in basis points: 700 = 7%. A state not listed is 0.
      // The owner decides with their accountant where they must collect.
      rates: {} as Record<string, number>,
    },
    secret: [],
  },
} as const;

export type SettingKey = keyof typeof SETTINGS;
export type SettingValue<K extends SettingKey> = { -readonly [P in keyof (typeof SETTINGS)[K]['defaults']]: (typeof SETTINGS)[K]['defaults'][P] };

let cache: Map<string, Record<string, unknown>> | null = null;
let cachedAt = 0;
const TTL_MS = 15_000;

async function load(): Promise<Map<string, Record<string, unknown>>> {
  if (cache && Date.now() - cachedAt < TTL_MS) return cache;
  const rows = await q('select key, value from settings');
  cache = new Map(rows.map((r) => [r.key, r.value]));
  cachedAt = Date.now();
  return cache;
}

export function invalidateSettings(): void {
  cache = null;
}

/** Full value with secrets decrypted. Server-side use only. */
export async function getSetting<K extends SettingKey>(key: K): Promise<SettingValue<K>> {
  const stored = (await load()).get(key) ?? {};
  const def = SETTINGS[key];
  const out: Record<string, unknown> = { ...def.defaults };
  for (const [k, v] of Object.entries(stored)) {
    if (!(k in def.defaults)) continue;
    out[k] = (def.secret as readonly string[]).includes(k) && typeof v === 'string' && v ? (decrypt(v) ?? '') : v;
  }
  return out as SettingValue<K>;
}

/** Value safe to send to an admin browser: secrets replaced by `{ set: boolean }`. */
export async function getSettingMasked(key: SettingKey): Promise<Record<string, unknown>> {
  const full = (await getSetting(key)) as Record<string, unknown>;
  for (const s of SETTINGS[key].secret) full[s] = { set: Boolean(full[s]) };
  return full;
}

/** Merge a partial update. Secret fields left empty/undefined keep their current value. */
export async function setSetting(key: SettingKey, patch: Record<string, unknown>, userId: string | null): Promise<void> {
  const def = SETTINGS[key];
  const stored = { ...((await load()).get(key) ?? {}) };
  for (const [k, v] of Object.entries(patch)) {
    if (!(k in def.defaults)) continue;
    if ((def.secret as readonly string[]).includes(k)) {
      if (typeof v !== 'string' || v === '') continue;
      stored[k] = encrypt(v);
    } else {
      stored[k] = v;
    }
  }
  await exec(
    `insert into settings (key, value, is_secret, updated_by) values ($1, $2, $3, $4)
     on conflict (key) do update set value = excluded.value, updated_by = excluded.updated_by, updated_at = now()`,
    [key, JSON.stringify(stored), def.secret.length > 0, userId],
  );
  invalidateSettings();
}

/** Subset of settings the public site needs. */
export async function publicSettings(): Promise<Record<string, unknown>> {
  const [site, membership, payments, security, analytics, revenue, tax, premium] = await Promise.all([
    getSetting('site'),
    getSetting('membership'),
    getSetting('payments'),
    getSetting('security'),
    getSetting('analytics'),
    getSetting('revenue'),
    getSetting('tax'),
    getSetting('creator_premium'),
  ]);
  return {
    site: { name: site.name, tagline: site.tagline, socials: site.socials, registration_open: site.registration_open, currency: site.currency },
    membership,
    // The optional yearly plan for brands: its name and price (before sales tax), so pages can show it.
    creator_premium: { name: premium.name, annual_cents: premium.annual_cents },
    payments: { provider: payments.provider, embed_checkout: payments.divinity_embed_checkout !== false },
    // Creator shares are public: they are the pitch.
    revenue: { sale_share_bps: revenue.sale_share_bps, sub_share_bps: revenue.sub_share_bps, tip_share_bps: revenue.tip_share_bps, payout_minimum_cents: revenue.payout_minimum_cents },
    // Only handed out while the check is on, so the forms know whether to run it.
    recaptcha_site_key: security.recaptcha_enabled ? security.recaptcha_site_key : '',
    ga_measurement_id: analytics.ga_measurement_id,
    // Whether checkout asks for a billing location and may add sales tax. The rates stay on the server.
    tax: { enabled: tax.enabled === true },
  };
}
