import { useMutation } from '@tanstack/react-query';
import { CheckCircle2, PlugZap, XCircle } from 'lucide-react';
import { useState } from 'react';
import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { api, errorMessage } from '@/lib/api';
import { useSession } from '@/lib/session';
import { Badge, Button, Field, FormRow, FormSection, Input, MoneyInput, Notice, PageHeader, Segmented, Select, Switch, Tabs, toast } from '@/ui';
import { SuperOnly } from './AdminLayout';
import { CopyField, Loaded, bpsToPct, pctToBps, useAct, useAdminQuery, useFilters, useTitle } from './shared';
import type { R } from './shared';

type SettingsData = { sections: Record<string, R>; secrets: Record<string, string[]>; info: { app_url: string; environment: string; webhooks: Record<string, string>; cron_secret_set: boolean } };

/**
 * State for one settings section. Secret fields start empty and are only sent
 * when something was typed; the stored value never reaches the browser.
 */
function useSection(section: string, value: R, secrets: string[]) {
  const { refresh } = useSession();
  const { run, busy } = useAct();
  const init = (v: R) => Object.fromEntries(Object.entries(v).map(([k, x]) => [k, secrets.includes(k) ? '' : x]));
  const [form, setForm] = useState<R>(() => init(value));
  const [saved, setSaved] = useState<R>(value);
  const [clear, setClear] = useState<string[]>([]);
  const set = (patch: R) => setForm((f) => ({ ...f, ...patch }));
  /** `data` is the non-secret fields to send, already converted to what the API expects. */
  const save = (data: R | string) => {
    if (typeof data === 'string') return void toast.error(data);
    const body: R = { ...data };
    for (const s of secrets) {
      delete body[s];
      if (typeof form[s] === 'string' && form[s].trim() && !clear.includes(s)) body[s] = form[s].trim();
    }
    void run({
      key: section,
      fn: () => api<{ value: R; changed: string[]; notes: string[] }>('/api/admin/settings', { method: 'PATCH', json: { section, data: body, clear } }),
      ok: (r) => (r.changed.length ? 'Settings saved' : 'Nothing changed'),
      onDone: (r) => {
        setSaved(r.value);
        setForm((f) => ({ ...f, ...Object.fromEntries(secrets.map((s) => [s, ''])) }));
        setClear([]);
        r.notes.forEach((n) => toast.warning(n, { duration: 15_000 }));
        void refresh();
      },
    });
  };
  const secret = (name: string) => ({
    isSet: Boolean(saved[name]?.set),
    value: (form[name] as string) ?? '',
    onChange: (v: string) => set({ [name]: v }),
    clearing: clear.includes(name),
    onClear: (on: boolean) => setClear((c) => (on ? [...c, name] : c.filter((x) => x !== name))),
  });
  /** Values for a "Test connection" call: what is typed now; blank secrets fall back to the stored ones on the server. */
  const testForm = (fields: string[]) => Object.fromEntries(fields.map((k) => [k, String(form[k] ?? '').trim()]).filter(([, v]) => v));
  return { form, set, save, secret, saving: busy === section, testForm, saved };
}

function SecretInput({ label, hint, s }: { label: string; hint?: ReactNode; s: { isSet: boolean; value: string; onChange: (v: string) => void; clearing: boolean; onClear: (on: boolean) => void } }) {
  return (
    <Field
      label={
        <span className="flex items-center gap-2">
          {label}
          {s.clearing ? <Badge tone="danger">Will be removed</Badge> : s.isSet ? <Badge tone="ok">Saved</Badge> : <Badge>Not set</Badge>}
        </span>
      }
      hint={
        <>
          {hint}{hint ? ' ' : ''}
          {s.isSet && !s.clearing && 'The saved value is never shown. Type a new one to replace it. '}
          {s.isSet && (
            <button type="button" className="underline hover:text-paper" onClick={() => s.onClear(!s.clearing)}>
              {s.clearing ? 'Keep the saved value' : 'Remove the saved value'}
            </button>
          )}
        </>
      }
    >
      <Input
        type="password"
        autoComplete="new-password"
        spellCheck={false}
        disabled={s.clearing}
        value={s.value}
        onChange={(e) => s.onChange(e.target.value)}
        placeholder={s.isSet ? 'Saved. Leave empty to keep it.' : 'Not set'}
      />
    </Field>
  );
}

type TestResult = { ok: boolean; message: string };

/** Calls a real connection test on the server and shows what it found. */
function TestButton({ path, body, label = 'Test connection', note }: { path: string; body?: R; label?: string; note?: string }) {
  const test = useMutation({ mutationFn: () => api<TestResult>(path, { json: body ?? {} }) });
  const r = test.data;
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-3">
        <Button loading={test.isPending} icon={<PlugZap className="size-4" />} onClick={() => test.mutate()}>{label}</Button>
        {note && <span className="text-xs text-faint">{note}</span>}
      </div>
      {test.isError && <Notice tone="danger">{errorMessage(test.error)}</Notice>}
      {r && !test.isPending && (
        <div role="status" className={`flex items-start gap-2 rounded-xl border px-4 py-3 text-sm ${r.ok ? 'border-ok/30 bg-ok-soft text-ok' : 'border-danger/30 bg-danger-soft text-danger'}`}>
          {r.ok ? <CheckCircle2 className="mt-0.5 size-4 shrink-0" /> : <XCircle className="mt-0.5 size-4 shrink-0" />}
          <span className="min-w-0 break-words">{r.message}</span>
        </div>
      )}
    </div>
  );
}

function SaveBar({ saving, onSave, label }: { saving: boolean; onSave: () => void; label: string }) {
  return (
    <div className="sticky bottom-0 -mx-1 mt-2 flex justify-end border-t border-line bg-ink/95 px-1 py-3 backdrop-blur">
      <Button variant="primary" loading={saving} onClick={onSave}>{label}</Button>
    </div>
  );
}

function Pct({ label, value, onChange, hint }: { label: string; value: string; onChange: (v: string) => void; hint?: string }) {
  return (
    <Field label={label} hint={hint}>
      <span className="relative block">
        <Input inputMode="decimal" value={value} onChange={(e) => onChange(e.target.value)} className="pr-8" />
        <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-sm text-muted">%</span>
      </span>
    </Field>
  );
}

const int = (v: unknown, label: string, min: number, max: number): number | string => {
  const n = Number(String(v).trim());
  return String(v).trim() !== '' && Number.isInteger(n) && n >= min && n <= max ? n : `${label}: enter a whole number between ${min} and ${max}.`;
};
const pct = (v: string, label: string, max = 100): number | string => {
  const n = pctToBps(v);
  return n !== null && !Number.isNaN(n) && n >= 0 && n <= max * 100 ? n : `${label}: enter a percentage between 0 and ${max}.`;
};
/** Collect converted values; the first conversion error wins. */
function collect(entries: Record<string, unknown>): R | string {
  for (const v of Object.values(entries)) if (typeof v === 'string' && /: enter a /.test(v)) return v;
  return entries;
}

type TabProps = { value: R; secrets: string[]; info: SettingsData['info'] };

// ---------------------------------------------------------------- General

const SOCIALS: [string, string][] = [['youtube', 'YouTube'], ['discord', 'Discord'], ['tiktok', 'TikTok'], ['x', 'X'], ['instagram', 'Instagram']];
const CURRENCIES = ['usd', 'eur', 'gbp', 'cad', 'aud', 'nzd', 'jpy', 'sek', 'nok', 'dkk', 'chf', 'brl', 'mxn'];

function General({ value, secrets }: TabProps) {
  const s = useSection('site', value, secrets);
  const f = s.form;
  const socials: Record<string, string> = f.socials ?? {};
  const extra = Object.keys(socials).filter((k) => !SOCIALS.some(([id]) => id === k));
  const save = () => {
    const clean: Record<string, string> = Object.fromEntries(Object.entries(socials).map(([k, v]) => [k, v.trim()]).filter(([, v]) => v));
    for (const [k, v] of Object.entries(clean)) if (!/^https:\/\/\S+$/.test(v)) return void toast.error(`The ${k} link must be a full address starting with https://`);
    s.save({ name: f.name.trim(), tagline: f.tagline.trim(), support_email: f.support_email.trim(), currency: f.currency, socials: clean, registration_open: f.registration_open, maintenance: f.maintenance });
  };
  return (
    <>
      <FormSection title="Identity" description="Shown in the top bar, browser tabs and every email.">
        <Field label="Site name"><Input value={f.name} maxLength={60} onChange={(e) => s.set({ name: e.target.value })} /></Field>
        <Field label="Tagline"><Input value={f.tagline} maxLength={160} onChange={(e) => s.set({ tagline: e.target.value })} /></Field>
        <FormRow>
          <Field label="Support email" optional hint="Where readers are told to write for help."><Input type="email" value={f.support_email} onChange={(e) => s.set({ support_email: e.target.value })} /></Field>
          <Field label="Currency" hint="Prices and payouts are shown in this currency.">
            <Select value={f.currency} onChange={(e) => s.set({ currency: e.target.value })}>
              {[...new Set([f.currency, ...CURRENCIES])].map((c) => <option key={c} value={c}>{c.toUpperCase()}</option>)}
            </Select>
          </Field>
        </FormRow>
      </FormSection>
      <FormSection title="Access">
        <Switch checked={f.registration_open} onChange={(v) => s.set({ registration_open: v })} label="Let new people sign up" description="Turn off to pause new accounts. Existing users can still sign in." />
        <Switch checked={f.maintenance} onChange={(v) => s.set({ maintenance: v })} label="Maintenance mode" description="Readers see a maintenance notice instead of the site. Admins can still sign in and work." />
      </FormSection>
      <FormSection title="Social links" description="Shown at the bottom of the side menu. Leave one empty to hide it.">
        {[...SOCIALS, ...extra.map((k): [string, string] => [k, k])].map(([id, label]) => (
          <Field key={id} label={label}>
            <Input type="url" value={socials[id] ?? ''} placeholder="https://" onChange={(e) => s.set({ socials: { ...socials, [id]: e.target.value } })} />
          </Field>
        ))}
      </FormSection>
      <SaveBar saving={s.saving} onSave={save} label="Save general settings" />
    </>
  );
}

// ---------------------------------------------------------------- Revenue

function Revenue({ value, secrets }: TabProps) {
  const { currency } = useSession();
  const s = useSection('revenue', { ...value, sale: bpsToPct(value.sale_share_bps), sub: bpsToPct(value.sub_share_bps), tip: bpsToPct(value.tip_share_bps), fee: bpsToPct(value.fee_pct_bps), hold: String(value.payout_hold_days) }, secrets);
  const f = s.form;
  const save = () =>
    s.save(collect({
      sale_share_bps: pct(f.sale, 'Sales share'), sub_share_bps: pct(f.sub, 'Membership share'), tip_share_bps: pct(f.tip, 'Tips share'),
      payout_minimum_cents: f.payout_minimum_cents ?? 0, payout_hold_days: int(f.hold, 'Hold', 0, 90),
      fee_pct_bps: pct(f.fee, 'Fee percentage', 20), fee_fixed_cents: f.fee_fixed_cents ?? 0,
    }));
  return (
    <>
      <FormSection title="Creator shares" description="The part of each payment creators keep after the processing fee. The platform keeps the rest. A brand can be given its own shares on its admin page.">
        <FormRow cols={3}>
          <Pct label="Sales" value={f.sale} onChange={(sale) => s.set({ sale })} hint="Single releases, series and bundles." />
          <Pct label="Membership reads" value={f.sub} onChange={(sub) => s.set({ sub })} hint="Applied at monthly settlement." />
          <Pct label="Tips" value={f.tip} onChange={(tip) => s.set({ tip })} />
        </FormRow>
      </FormSection>
      <FormSection title="Payouts">
        <FormRow>
          <Field label="Smallest payout" hint="Creators can ask for a payout once their available balance reaches this."><MoneyInput cents={f.payout_minimum_cents} onChange={(c) => s.set({ payout_minimum_cents: c })} /></Field>
          <Field label="Hold new earnings for" hint="Days before a sale can be paid out, to leave room for refunds.">
            <span className="relative block"><Input inputMode="numeric" value={f.hold} onChange={(e) => s.set({ hold: e.target.value })} className="pr-14" /><span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-sm text-muted">days</span></span>
          </Field>
        </FormRow>
      </FormSection>
      <FormSection title="Processing fee estimate" description={`Used only when the payment processor does not report its own fee. Amounts are in ${currency.toUpperCase()}.`}>
        <FormRow>
          <Pct label="Percentage of the payment" value={f.fee} onChange={(fee) => s.set({ fee })} />
          <Field label="Plus a fixed amount"><MoneyInput cents={f.fee_fixed_cents} onChange={(c) => s.set({ fee_fixed_cents: c })} /></Field>
        </FormRow>
      </FormSection>
      <SaveBar saving={s.saving} onSave={save} label="Save revenue settings" />
    </>
  );
}

// ---------------------------------------------------------------- Membership

function Membership({ value, secrets }: TabProps) {
  const s = useSection('membership', { ...value, trial: String(value.trial_days) }, secrets);
  const f = s.form;
  const save = () => {
    if (!f.monthly_cents || !f.annual_cents || !f.page_credit_cents) return void toast.error('Enter all three prices.');
    s.save(collect({ name: f.name.trim(), monthly_cents: f.monthly_cents, annual_cents: f.annual_cents, trial_days: int(f.trial, 'Free trial', 0, 90), page_credit_cents: f.page_credit_cents }));
  };
  return (
    <>
      <FormSection title="Membership" description="The all-you-can-read plan. New prices apply to new members and to renewals from now on.">
        <Field label="Plan name"><Input value={f.name} maxLength={60} onChange={(e) => s.set({ name: e.target.value })} /></Field>
        <FormRow cols={3}>
          <Field label="Monthly price"><MoneyInput cents={f.monthly_cents} onChange={(c) => s.set({ monthly_cents: c })} /></Field>
          <Field label="Annual price" hint="No more than twelve monthly payments."><MoneyInput cents={f.annual_cents} onChange={(c) => s.set({ annual_cents: c })} /></Field>
          <Field label="Free trial" hint="0 for no trial.">
            <span className="relative block"><Input inputMode="numeric" value={f.trial} onChange={(e) => s.set({ trial: e.target.value })} className="pr-14" /><span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-sm text-muted">days</span></span>
          </Field>
        </FormRow>
      </FormSection>
      <FormSection title="Page credits" description="Readers without a membership can buy credits and spend one per premium page.">
        <Field label="Price of one page credit" className="max-w-xs"><MoneyInput cents={f.page_credit_cents} onChange={(c) => s.set({ page_credit_cents: c })} /></Field>
      </FormSection>
      <SaveBar saving={s.saving} onSave={save} label="Save membership settings" />
    </>
  );
}

// ---------------------------------------------------------------- Storage

function Storage({ value, secrets }: TabProps) {
  const s = useSection('storage', value, secrets);
  const f = s.form;
  const save = () => s.save({ driver: f.driver, r2_account_id: f.r2_account_id.trim(), r2_bucket: f.r2_bucket.trim(), r2_access_key_id: f.r2_access_key_id.trim(), r2_public_url: f.r2_public_url.trim() });
  return (
    <>
      <FormSection title="Where files are kept" description="Covers, pages and uploads. Switching does not move existing files: copy them across first.">
        <Segmented value={f.driver} onChange={(driver) => s.set({ driver })} options={[{ value: 'local', label: 'This server\'s disk' }, { value: 'r2', label: 'Cloudflare R2' }]} />
        {f.driver === 'local' && <p className="text-sm text-muted">Files are stored on the server's own disk. Fine for getting started; use R2 once the library grows or you run more than one server.</p>}
        {f.driver !== s.saved.driver && <Notice tone="warn">You are changing where files are kept. Existing files stay where they are until you copy them.</Notice>}
      </FormSection>
      {f.driver === 'r2' && (
        <FormSection title="Cloudflare R2" description="Create an R2 bucket and an API token with read and write access to it, then paste the details here.">
          <FormRow>
            <Field label="Account ID" hint="32 characters, from the R2 overview page."><Input value={f.r2_account_id} spellCheck={false} onChange={(e) => s.set({ r2_account_id: e.target.value })} /></Field>
            <Field label="Bucket name"><Input value={f.r2_bucket} spellCheck={false} onChange={(e) => s.set({ r2_bucket: e.target.value })} /></Field>
          </FormRow>
          <Field label="Access key ID"><Input value={f.r2_access_key_id} spellCheck={false} autoComplete="off" onChange={(e) => s.set({ r2_access_key_id: e.target.value })} /></Field>
          <SecretInput label="Secret access key" s={s.secret('r2_secret_access_key')} />
          <Field label="Public URL" optional hint="The bucket's public or custom domain. Without it, covers and free pages are served through this server instead of Cloudflare's network.">
            <Input type="url" value={f.r2_public_url} placeholder="https://media.example.com" onChange={(e) => s.set({ r2_public_url: e.target.value })} />
          </Field>
          <TestButton path="/api/admin/settings/test/r2" body={s.testForm(['r2_account_id', 'r2_bucket', 'r2_access_key_id', 'r2_secret_access_key', 'r2_public_url'])} note="Tests the values typed above, before you save." />
        </FormSection>
      )}
      <SaveBar saving={s.saving} onSave={save} label="Save storage settings" />
    </>
  );
}

// ---------------------------------------------------------------- Email

function EmailTab({ value, secrets, info }: TabProps) {
  const { user } = useSession();
  const s = useSection('email', value, secrets);
  const f = s.form;
  const save = () => s.save({ provider: f.provider, mailgun_domain: f.mailgun_domain.trim(), from_email: f.from_email.trim(), from_name: f.from_name.trim(), reply_to: f.reply_to.trim() });
  return (
    <>
      <FormSection title="Provider" description="The service that delivers the site's email.">
        <Segmented value={f.provider} onChange={(provider) => s.set({ provider })} options={[{ value: 'log', label: 'None (log only)' }, { value: 'sendgrid', label: 'SendGrid' }, { value: 'mailgun', label: 'Mailgun' }]} />
        {f.provider === 'log' && <Notice tone="warn">With no provider, emails are written to the email log and nobody receives them. Sign-up confirmations and password resets will not arrive.</Notice>}
        {f.provider === 'sendgrid' && (
          <>
            <SecretInput label="SendGrid API key" hint={'Starts with "SG." and needs the Mail Send permission.'} s={s.secret('sendgrid_api_key')} />
            <TestButton path="/api/admin/settings/test/sendgrid" body={s.testForm(['sendgrid_api_key'])} note="Checks the key with SendGrid. Nothing is sent." />
          </>
        )}
        {f.provider === 'mailgun' && (
          <>
            <Field label="Sending domain" hint="For example mg.example.com."><Input value={f.mailgun_domain} spellCheck={false} onChange={(e) => s.set({ mailgun_domain: e.target.value })} /></Field>
            <SecretInput label="Mailgun API key" s={s.secret('mailgun_api_key')} />
            <TestButton path="/api/admin/settings/test/mailgun" body={s.testForm(['mailgun_api_key', 'mailgun_domain'])} note="Checks the key and domain with Mailgun. Nothing is sent." />
          </>
        )}
      </FormSection>
      <FormSection title="Sender" description="Who the emails come from. The address must be verified with your provider.">
        <FormRow>
          <Field label="From name"><Input value={f.from_name} maxLength={80} onChange={(e) => s.set({ from_name: e.target.value })} /></Field>
          <Field label="From address"><Input type="email" value={f.from_email} placeholder="hello@example.com" onChange={(e) => s.set({ from_email: e.target.value })} /></Field>
        </FormRow>
        <Field label="Reply-to address" optional hint="Where replies go, if different from the From address."><Input type="email" value={f.reply_to} onChange={(e) => s.set({ reply_to: e.target.value })} /></Field>
      </FormSection>
      {f.provider !== 'log' && (
        <FormSection title="Delivery webhooks" description="Lets the provider report bounces, spam complaints, opens and clicks, so bad addresses are suppressed automatically.">
          {f.provider === 'sendgrid' ? (
            <>
              <CopyField label="Webhook URL to register with SendGrid" value={info.webhooks.sendgrid} hint="SendGrid: Settings, Mail Settings, Event Webhook. Turn on signed events." />
              <SecretInput label="Signed event webhook verification key" hint="The public key SendGrid shows after you turn on signing." s={s.secret('sendgrid_webhook_key')} />
            </>
          ) : (
            <>
              <CopyField label="Webhook URL to register with Mailgun" value={info.webhooks.mailgun} hint="Mailgun: Sending, Webhooks. Add it for delivered, failed, complained, opened and clicked." />
              <SecretInput label="HTTP webhook signing key" hint="Mailgun: Settings, API security." s={s.secret('mailgun_webhook_signing_key')} />
            </>
          )}
        </FormSection>
      )}
      <FormSection title="Send a test" description="Queues a real message through the saved settings, so save first if you changed anything.">
        <TestButton path="/api/admin/settings/test/email" label="Send test email" note={`Goes to ${user?.email}.`} />
        <p className="text-sm text-muted">Follow it in the <Link className="link" to="/admin/email">email queue and log</Link>.</p>
      </FormSection>
      <SaveBar saving={s.saving} onSave={save} label="Save email settings" />
    </>
  );
}

// ---------------------------------------------------------------- Payments

function Payments({ value, secrets, info }: TabProps) {
  const s = useSection('payments', value, secrets);
  const f = s.form;
  const save = () => s.save({ provider: f.provider, divinity_api_url: f.divinity_api_url.trim(), divinity_partner_id: f.divinity_partner_id.trim(), divinity_checkout_logo_url: f.divinity_checkout_logo_url.trim() });
  return (
    <>
      <FormSection title="Provider" description="How readers pay for releases, credits, gift cards and membership.">
        <Segmented value={f.provider} onChange={(provider) => s.set({ provider })} options={[{ value: 'sandbox', label: 'Sandbox (no real money)' }, { value: 'divinity', label: 'Divinity payments' }]} />
        {f.provider === 'sandbox' && (
          <Notice tone={info.environment === 'production' ? 'danger' : 'warn'}>
            Sandbox completes every order instantly without charging anyone. {info.environment === 'production' ? 'It cannot be used on the live site: choose Divinity payments.' : 'Use it for testing only.'}
          </Notice>
        )}
      </FormSection>
      {f.provider === 'divinity' && (
        <>
          <FormSection title="Divinity payments" description="Your partner credentials. Readers pay on Divinity's hosted checkout page; card details never touch this site.">
            <Field label="API URL"><Input type="url" value={f.divinity_api_url} spellCheck={false} onChange={(e) => s.set({ divinity_api_url: e.target.value })} /></Field>
            <Field label="Partner ID"><Input value={f.divinity_partner_id} spellCheck={false} autoComplete="off" onChange={(e) => s.set({ divinity_partner_id: e.target.value })} /></Field>
            <SecretInput label="API key" s={s.secret('divinity_api_key')} />
            <Field label="Checkout logo URL" optional hint="A full https:// address of the logo shown on the hosted checkout page.">
              <Input type="url" value={f.divinity_checkout_logo_url} placeholder="https://" onChange={(e) => s.set({ divinity_checkout_logo_url: e.target.value })} />
            </Field>
            <TestButton path="/api/admin/settings/test/divinity" body={s.testForm(['divinity_api_url', 'divinity_partner_id', 'divinity_api_key'])} note="Tests the values typed above with a harmless lookup. No payment is made." />
          </FormSection>
          <FormSection title="Payment confirmations" description="Divinity calls this address when a payment succeeds, fails or is refunded.">
            <CopyField label="Webhook URL to register with Divinity payments" value={info.webhooks.divinity} />
            <SecretInput label="Webhook secret" hint="Used to check that confirmations really come from Divinity." s={s.secret('divinity_webhook_secret')} />
          </FormSection>
        </>
      )}
      <SaveBar saving={s.saving} onSave={save} label="Save payment settings" />
    </>
  );
}

// ---------------------------------------------------------------- Security

function SecurityTab({ value, secrets }: TabProps) {
  const { user } = useSession();
  const s = useSection('security', { ...value, rate: String(value.rate_limit_per_minute), attempts: String(value.max_login_attempts), minlen: String(value.password_min_length) }, secrets);
  const f = s.form;
  const save = () =>
    s.save(collect({
      recaptcha_site_key: f.recaptcha_site_key.trim(), recaptcha_enabled: f.recaptcha_enabled, bot_blocker_enabled: f.bot_blocker_enabled,
      rate_limit_per_minute: int(f.rate, 'Rate limit', 30, 100000), admin_2fa_required: f.admin_2fa_required,
      max_login_attempts: int(f.attempts, 'Sign-in attempts', 3, 50), password_min_length: int(f.minlen, 'Password length', 8, 128),
    }));
  return (
    <>
      <FormSection title="Sign-in" description="Rules for every account.">
        <FormRow>
          <Field label="Failed sign-ins before a lockout" hint="Between 3 and 50."><Input inputMode="numeric" value={f.attempts} onChange={(e) => s.set({ attempts: e.target.value })} /></Field>
          <Field label="Shortest password allowed" hint="Characters. Applies to new passwords."><Input inputMode="numeric" value={f.minlen} onChange={(e) => s.set({ minlen: e.target.value })} /></Field>
        </FormRow>
        <Switch
          checked={f.admin_2fa_required}
          onChange={(v) => s.set({ admin_2fa_required: v })}
          label="Require two-factor sign-in for admins"
          description={!user?.totp_enabled && f.admin_2fa_required && !s.saved.admin_2fa_required ? 'You have not set it up yourself yet: after saving you will be taken to set it up before you can do anything else here.' : 'Staff without it can only reach the two-factor setup screen until they enrol.'}
        />
      </FormSection>
      <FormSection title="Bot protection" description={<>Blocks scrapers and attack traffic. Blocked addresses are listed under <Link className="link" to="/admin/security">Security</Link>.</>}>
        <Switch checked={f.bot_blocker_enabled} onChange={(v) => s.set({ bot_blocker_enabled: v })} label="Bot blocker" description="Automatically blocks addresses that probe for vulnerabilities or hammer the site." />
        <Field label="Requests allowed per address, per minute" hint="Between 30 and 100,000. Going over this is counted as suspicious." className="max-w-sm"><Input inputMode="numeric" value={f.rate} onChange={(e) => s.set({ rate: e.target.value })} /></Field>
      </FormSection>
      <FormSection title="reCAPTCHA" description="Google's invisible check on sign-up and sign-in forms. Create a v3 key pair for your domain in the reCAPTCHA admin console.">
        <Field label="Site key"><Input value={f.recaptcha_site_key} spellCheck={false} autoComplete="off" onChange={(e) => s.set({ recaptcha_site_key: e.target.value })} /></Field>
        <SecretInput label="Secret key" s={s.secret('recaptcha_secret_key')} />
        <TestButton path="/api/admin/settings/test/recaptcha" body={s.testForm(['recaptcha_site_key', 'recaptcha_secret_key'])} label="Check keys" note="Checks the values typed above with Google." />
        <Switch checked={f.recaptcha_enabled} onChange={(v) => s.set({ recaptcha_enabled: v })} label="Use reCAPTCHA" description="Needs both keys." />
      </FormSection>
      <SaveBar saving={s.saving} onSave={save} label="Save security settings" />
    </>
  );
}

// ---------------------------------------------------------------- Analytics

function Analytics({ value, secrets }: TabProps) {
  const s = useSection('analytics', value, secrets);
  const f = s.form;
  return (
    <>
      <FormSection title="Google Analytics" description="Adds the Google tag to every page. Leave empty to run without it.">
        <Field label="Measurement ID" optional hint="Looks like G-XXXXXXXXXX."><Input value={f.ga_measurement_id} spellCheck={false} placeholder="G-" onChange={(e) => s.set({ ga_measurement_id: e.target.value.toUpperCase() })} className="max-w-xs" /></Field>
      </FormSection>
      <FormSection title="Error reporting" description={<>Errors are always kept in the built-in <Link className="link" to="/admin/errors">error log</Link>. Add a Sentry address to send them there as well.</>}>
        <Field label="Sentry DSN" optional><Input type="url" value={f.sentry_dsn} spellCheck={false} placeholder="https://" onChange={(e) => s.set({ sentry_dsn: e.target.value })} /></Field>
      </FormSection>
      <SaveBar saving={s.saving} onSave={() => s.save({ ga_measurement_id: f.ga_measurement_id.trim(), sentry_dsn: f.sentry_dsn.trim() })} label="Save analytics settings" />
    </>
  );
}

// ---------------------------------------------------------------- page

const TABS: { value: string; label: string; section: string; C: (p: TabProps) => ReactNode }[] = [
  { value: 'general', label: 'General', section: 'site', C: General },
  { value: 'revenue', label: 'Revenue', section: 'revenue', C: Revenue },
  { value: 'membership', label: 'Membership', section: 'membership', C: Membership },
  { value: 'storage', label: 'Storage', section: 'storage', C: Storage },
  { value: 'email', label: 'Email', section: 'email', C: EmailTab },
  { value: 'payments', label: 'Payments', section: 'payments', C: Payments },
  { value: 'security', label: 'Security', section: 'security', C: SecurityTab },
  { value: 'analytics', label: 'Analytics', section: 'analytics', C: Analytics },
];

function SettingsInner() {
  const [f, setF] = useFilters({ tab: 'general' });
  const tab = TABS.find((t) => t.value === f.tab) ?? TABS[0];
  useTitle(`${tab.label} settings`);
  const q = useAdminQuery<SettingsData>('/api/admin/settings');
  return (
    <>
      <PageHeader title="Settings" description="Each tab saves on its own. Keys and passwords are stored encrypted and are never shown again after saving." />
      <div className="mb-6"><Tabs value={tab.value} onChange={(t) => setF({ tab: t })} tabs={TABS.map(({ value, label }) => ({ value, label }))} /></div>
      <Loaded query={q}>
        {(d) => <tab.C key={tab.section} value={d.sections[tab.section]} secrets={d.secrets[tab.section] ?? []} info={d.info} />}
      </Loaded>
    </>
  );
}

export const SettingsPage = () => <SuperOnly><SettingsInner /></SuperOnly>;
