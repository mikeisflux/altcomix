import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Bell, Check, FlaskConical, Globe, KeyRound, Lock, Mail, MonitorSmartphone, Sparkles, Trash2, Upload, UserRound, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { Link } from 'react-router';
import { api, errorMessage, upload } from '@/lib/api';
import { ago, date } from '@/lib/format';
import { useSession } from '@/lib/session';
import { Avatar, Badge, Button, Card, CardHeader, Checkbox, ErrorState, Field, FormRow, Input, Modal, Notice, PageHeader, PageLoader, Select, Switch, Textarea, cx, toast, useConfirm } from '@/ui';
import { useTitle } from './shared';

type NotifyKey = 'newsletter' | 'messages' | 'replies' | 'mentions' | 'releases' | 'feed' | 'followers' | 'analytics';
type Prefs = {
  show_mature: boolean;
  reading_language: string | null;
  interface_language: string;
  country: string | null;
  favorite_genre: string | null;
  show_real_name: boolean;
  show_donation_amounts: boolean;
  allow_dms: boolean;
  beta: boolean;
  notify: Record<NotifyKey, boolean>;
};
type Account = {
  profile: { id: string; username: string; email: string; email_verified: boolean; display_name: string; bio: string; avatar_url: string | null; created_at: string; totp_enabled: boolean };
  prefs: Prefs;
  wallet: { credit_cents: number; page_credits: number };
  member: boolean;
};
type PrefsPatch = Partial<Omit<Prefs, 'notify'>> & { confirm_adult?: boolean; notify?: Partial<Record<NotifyKey, boolean>> };
type SessionRow = { id: string; current: boolean; ip: string | null; user_agent: string | null; created_at: string; last_seen_at: string; expires_at: string };

const SECTIONS = [
  { id: 'about', label: 'About you', icon: <UserRound /> },
  { id: 'discovery', label: 'Discovery & content', icon: <Sparkles /> },
  { id: 'locale', label: 'Language & locale', icon: <Globe /> },
  { id: 'privacy', label: 'Privacy', icon: <Lock /> },
  { id: 'email', label: 'Email notifications', icon: <Bell /> },
  { id: 'beta', label: 'Beta participation', icon: <FlaskConical /> },
  { id: 'change-email', label: 'Change email', icon: <Mail /> },
  { id: 'password', label: 'Change password', icon: <KeyRound /> },
  { id: 'security', label: 'Security', icon: <MonitorSmartphone /> },
  { id: 'danger', label: 'Danger zone', icon: <Trash2 /> },
] as const;

// ISO 3166-1 alpha-2; names come from the browser in the reader's own language.
const COUNTRY_CODES =
  'AD AE AF AG AI AL AM AO AR AS AT AU AW AZ BA BB BD BE BF BG BH BI BJ BM BN BO BR BS BT BW BY BZ CA CD CF CG CH CI CL CM CN CO CR CU CV CY CZ DE DJ DK DM DO DZ EC EE EG ER ES ET FI FJ FM FO FR GA GB GD GE GH GI GL GM GN GQ GR GT GU GW GY HK HN HR HT HU ID IE IL IN IQ IR IS IT JM JO JP KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MG MH MK ML MM MN MO MR MT MU MV MW MX MY MZ NA NC NE NG NI NL NO NP NR NZ OM PA PE PF PG PH PK PL PR PS PT PW PY QA RO RS RU RW SA SB SC SD SE SG SI SK SL SM SN SO SR SS ST SV SY SZ TD TG TH TJ TL TM TN TO TR TT TV TW TZ UA UG US UY UZ VA VC VE VG VI VN VU WS YE ZA ZM ZW'.split(' ');

function useCountries(): { code: string; name: string }[] {
  return useMemo(() => {
    let names: Intl.DisplayNames | null = null;
    try {
      names = new Intl.DisplayNames(undefined, { type: 'region' });
    } catch {
      /* very old browser: fall back to the codes */
    }
    return COUNTRY_CODES.map((code) => ({ code, name: names?.of(code) ?? code })).sort((a, b) => a.name.localeCompare(b.name));
  }, []);
}

/** One call for every settings toggle; the server answers with the full, current settings. */
function usePrefs() {
  const qc = useQueryClient();
  const { refresh } = useSession();
  return useMutation({
    mutationFn: (patch: PrefsPatch) => api<{ ok: true; prefs: Prefs }>('/api/account/prefs', { method: 'PATCH', json: patch }),
    onSuccess: (r) => {
      qc.setQueryData<Account>(['account'], (old) => (old ? { ...old, prefs: r.prefs } : old));
      toast.success('Saved');
      void refresh();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
}

function Section({ id, title, description, children, danger }: { id: string; title: string; description?: ReactNode; children: ReactNode; danger?: boolean }) {
  return (
    <section id={id} aria-labelledby={`${id}-title`} className="scroll-mt-36 md:scroll-mt-24">
      <Card className={cx(danger && 'border-danger/40')}>
        <CardHeader title={<span id={`${id}-title`}>{title}</span>} description={description} />
        <div className="px-5 py-5">{children}</div>
      </Card>
    </section>
  );
}

function SectionNav({ active, onPick }: { active: string; onPick: (id: string) => void }) {
  const strip = useRef<HTMLElement>(null);
  // Keep the highlighted tab in view on the mobile strip.
  useEffect(() => {
    const el = strip.current?.querySelector<HTMLElement>(`[data-id="${active}"]`);
    const box = strip.current;
    if (el && box && box.scrollWidth > box.clientWidth) box.scrollTo({ left: el.offsetLeft - 16, behavior: 'smooth' });
  }, [active]);
  return (
    <nav ref={strip} aria-label="Settings sections" className="no-scrollbar flex gap-1 overflow-x-auto md:block md:space-y-0.5">
      {SECTIONS.map((s) => (
        <a
          key={s.id}
          href={`#${s.id}`}
          data-id={s.id}
          aria-current={active === s.id ? 'true' : undefined}
          onClick={(e) => {
            e.preventDefault();
            onPick(s.id);
          }}
          className={cx(
            'flex h-10 shrink-0 items-center gap-2.5 whitespace-nowrap rounded-lg px-2.5 text-sm transition-colors [&>svg]:size-4 [&>svg]:shrink-0',
            active === s.id ? 'bg-raised font-medium text-paper' : 'text-muted hover:bg-hover hover:text-paper',
            s.id === 'danger' && active !== s.id && 'md:mt-3',
          )}
        >
          {s.icon}
          {s.label}
        </a>
      ))}
    </nav>
  );
}

// ---------------------------------------------------------------- sections

function AboutSection({ account }: { account: Account }) {
  const qc = useQueryClient();
  const { refresh } = useSession();
  const confirm = useConfirm();
  const p = account.profile;
  const [name, setName] = useState(p.display_name);
  const [bio, setBio] = useState(p.bio);
  const [picked, setPicked] = useState<{ file: File; url: string } | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => () => { if (picked) URL.revokeObjectURL(picked.url); }, [picked]);

  const done = async () => {
    await qc.invalidateQueries({ queryKey: ['account'] });
    await refresh();
  };
  const save = useMutation({
    mutationFn: () => api('/api/account/profile', { method: 'PATCH', json: { display_name: name, bio } }),
    onSuccess: async () => {
      toast.success('Profile saved');
      await done();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const sendAvatar = useMutation({
    mutationFn: () => {
      const form = new FormData();
      form.append('file', picked!.file);
      return upload('/api/account/avatar', form, setProgress);
    },
    onSuccess: async () => {
      toast.success('Profile picture updated');
      setPicked(null);
      await done();
    },
    onError: (e) => toast.error(errorMessage(e)),
    onSettled: () => setProgress(null),
  });
  const removeAvatar = useMutation({
    mutationFn: () => api('/api/account/avatar', { method: 'DELETE' }),
    onSuccess: async () => {
      toast.success('Profile picture removed');
      await done();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  const choose = (file: File | undefined) => {
    if (!file) return;
    if (!file.type.startsWith('image/')) return void toast.error('Choose an image file (JPG, PNG or WebP).');
    if (file.size > 8 * 1024 * 1024) return void toast.error('That image is too large. Use one under 8 MB.');
    setPicked({ file, url: URL.createObjectURL(file) });
  };
  const dirty = name.trim() !== p.display_name || bio.trim() !== p.bio;

  return (
    <Section id="about" title="About you" description={<>Shown on your <Link className="link" to={`/u/${p.username}`}>public profile</Link>, your comments and your forum posts.</>}>
      <div className="flex flex-wrap items-center gap-4 border-b border-line pb-5">
        <Avatar src={picked?.url ?? p.avatar_url} name={p.display_name} size={84} />
        <div className="min-w-0 flex-1 basis-56 space-y-2">
          <div className="text-[13px] font-medium">Profile picture</div>
          <input ref={input} type="file" accept="image/jpeg,image/png,image/webp,image/gif" className="sr-only" aria-label="Choose a profile picture" onChange={(e) => { choose(e.target.files?.[0]); e.target.value = ''; }} />
          {picked ? (
            <div className="flex flex-wrap items-center gap-2">
              <Button variant="secondary" loading={sendAvatar.isPending} icon={<Check className="size-4" />} onClick={() => sendAvatar.mutate()}>
                {progress !== null && progress < 1 ? `Uploading ${Math.round(progress * 100)}%` : 'Use this picture'}
              </Button>
              <Button variant="ghost" disabled={sendAvatar.isPending} onClick={() => setPicked(null)}>Cancel</Button>
            </div>
          ) : (
            <div className="flex flex-wrap items-center gap-2">
              <Button icon={<Upload className="size-4" />} onClick={() => input.current?.click()}>Upload a picture</Button>
              {p.avatar_url && (
                <Button
                  variant="ghost"
                  loading={removeAvatar.isPending}
                  onClick={async () => {
                    if (await confirm({ title: 'Remove your profile picture?', body: 'Your initials are shown instead.', confirmLabel: 'Remove', danger: true })) removeAvatar.mutate();
                  }}
                >
                  Remove
                </Button>
              )}
            </div>
          )}
          <p className="text-xs text-faint">{picked ? 'This is a preview. Nothing changes until you confirm.' : 'JPG, PNG or WebP up to 8 MB. It is cropped to a square.'}</p>
        </div>
      </div>
      <form
        className="space-y-4 pt-5"
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          save.mutate();
        }}
      >
        <FormRow>
          <Field label="Display name" hint="The name other readers see.">
            <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={60} required autoComplete="name" />
          </Field>
          <Field label="Username" hint="Your profile address. It cannot be changed.">
            <Input value={`@${p.username}`} readOnly disabled />
          </Field>
        </FormRow>
        <Field label="Bio" optional>
          <Textarea value={bio} onChange={(e) => setBio(e.target.value)} maxLength={600} placeholder="What do you read? What do you make?" />
        </Field>
        <Button type="submit" variant="primary" loading={save.isPending} disabled={!dirty || !name.trim()}>Save profile</Button>
      </form>
    </Section>
  );
}

function DiscoverySection({ prefs }: { prefs: Prefs }) {
  const save = usePrefs();
  const [asking, setAsking] = useState(false);
  const [adult, setAdult] = useState(false);
  return (
    <Section id="discovery" title="Discovery & content" description="What the store, search and recommendations are allowed to show you.">
      <Switch
        checked={prefs.show_mature}
        disabled={save.isPending}
        onChange={(on) => {
          if (on) {
            setAdult(false);
            setAsking(true);
          } else save.mutate({ show_mature: false });
        }}
        label="Show mature content (18+)"
        description="Titles marked for adults are hidden everywhere unless this is on."
      />
      <p className="mt-2 text-xs text-faint">There is no setting for AI-generated comics because they are not accepted here at all.</p>
      <Modal
        open={asking}
        onClose={() => setAsking(false)}
        title="Show mature content?"
        size="sm"
        footer={
          <>
            <Button variant="ghost" onClick={() => setAsking(false)}>Keep it hidden</Button>
            <Button
              variant="primary"
              disabled={!adult}
              loading={save.isPending}
              onClick={() => save.mutate({ show_mature: true, confirm_adult: true }, { onSuccess: () => setAsking(false) })}
            >
              Show mature content
            </Button>
          </>
        }
      >
        <p className="mb-4 text-sm text-muted">Mature titles can include graphic violence, nudity and sexual content. They are only for adults.</p>
        <Checkbox checked={adult} onChange={setAdult} label="I am 18 or older" description="We record the date you confirmed this." />
      </Modal>
    </Section>
  );
}

function LocaleSection({ prefs }: { prefs: Prefs }) {
  const save = usePrefs();
  const { meta } = useSession();
  const countries = useCountries();
  return (
    <Section id="locale" title="Language & locale" description="Changes here save as soon as you pick them.">
      <FormRow cols={3}>
        <Field label="Country" hint="Used for regional availability and pricing.">
          <Select value={prefs.country ?? ''} disabled={save.isPending} onChange={(e) => save.mutate({ country: e.target.value || null })}>
            <option value="">Not set</option>
            {countries.map((c) => <option key={c.code} value={c.code}>{c.name}</option>)}
          </Select>
        </Field>
        <Field label="Interface language" hint="Menus and emails. More translations are on the way.">
          <Select value={prefs.interface_language} disabled={save.isPending} onChange={(e) => save.mutate({ interface_language: e.target.value })}>
            {meta.languages.map((l) => <option key={l.code} value={l.code}>{l.label}</option>)}
          </Select>
        </Field>
        <Field label="Preferred reading language" hint="Comics in this language are shown first.">
          <Select value={prefs.reading_language ?? ''} disabled={save.isPending} onChange={(e) => save.mutate({ reading_language: e.target.value || null })}>
            <option value="">Any language</option>
            {meta.languages.map((l) => <option key={l.code} value={l.code}>{l.label}</option>)}
          </Select>
        </Field>
      </FormRow>
    </Section>
  );
}

function PrivacySection({ prefs }: { prefs: Prefs }) {
  const save = usePrefs();
  return (
    <Section id="privacy" title="Privacy" description="What other people can see and do.">
      <div className="divide-y divide-line">
        <Switch checked={prefs.show_real_name} disabled={save.isPending} onChange={(v) => save.mutate({ show_real_name: v })} label="Show my display name on my profile" description="When off, your profile shows only your username." />
        <Switch checked={prefs.show_donation_amounts} disabled={save.isPending} onChange={(v) => save.mutate({ show_donation_amounts: v })} label="Show my tip amounts" description="When off, creators' supporter lists show that you tipped but not how much." />
        <Switch checked={prefs.allow_dms} disabled={save.isPending} onChange={(v) => save.mutate({ allow_dms: v })} label="Allow direct messages" description="When off, nobody can start a conversation with you. You can still reply in conversations you start." />
      </div>
    </Section>
  );
}

const EMAILS: { key: NotifyKey; label: string; description: string }[] = [
  { key: 'newsletter', label: 'Newsletter', description: 'Occasional news, new arrivals and offers.' },
  { key: 'messages', label: 'Private conversations', description: 'When someone sends you a direct message.' },
  { key: 'replies', label: 'Forum and comment replies', description: 'When someone replies to your thread or comment.' },
  { key: 'mentions', label: '@mentions', description: 'When someone mentions your username.' },
  { key: 'releases', label: 'New releases', description: 'When a series or creator you follow publishes.' },
  { key: 'feed', label: 'Weekly feed summary', description: 'A weekly digest of what happened in the things you follow. This email has not started yet; your choice is saved for when it does.' },
  { key: 'followers', label: 'New followers', description: 'When someone follows a brand you run.' },
  { key: 'analytics', label: 'Weekly publishing analytics', description: 'Reads, sales and earnings for the brands you belong to. This email has not started yet; your choice is saved for when it does.' },
];

function EmailSection({ account }: { account: Account }) {
  const save = usePrefs();
  const n = account.prefs.notify;
  return (
    <Section id="email" title="Email notifications" description={<>Sent to {account.profile.email}. Receipts and security emails always arrive. Everything also shows in your <Link className="link" to="/notifications">notifications</Link>.</>}>
      <div className="divide-y divide-line">
        {EMAILS.map((e) => (
          <Switch key={e.key} checked={n[e.key]} disabled={save.isPending} onChange={(v) => save.mutate({ notify: { [e.key]: v } })} label={e.label} description={e.description} />
        ))}
      </div>
    </Section>
  );
}

function BetaSection({ prefs }: { prefs: Prefs }) {
  const save = usePrefs();
  return (
    <Section id="beta" title="Beta participation">
      <Switch checked={prefs.beta} disabled={save.isPending} onChange={(v) => save.mutate({ beta: v })} label="Try new features early" description="You will see features before they are finished. Things may change or break; tell us what you think through Submit feedback." />
    </Section>
  );
}

function ChangeEmailSection({ account }: { account: Account }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [sentTo, setSentTo] = useState<string | null>(null);
  const change = useMutation({
    mutationFn: () => api<{ ok: true; sent_to: string }>('/api/account/email', { json: { new_email: email, current_password: password } }),
    onSuccess: (r) => {
      setSentTo(r.sent_to);
      setEmail('');
      setPassword('');
      toast.success('Confirmation link sent');
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  return (
    <Section
      id="change-email"
      title="Change email"
      description={<>You sign in with <strong className="font-medium text-paper">{account.profile.email}</strong>{account.profile.email_verified ? '' : ' (not confirmed yet)'}.</>}
    >
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          change.mutate();
        }}
      >
        {sentTo && <Notice tone="ok">We sent a confirmation link to {sentTo}. Open it within 24 hours to finish the change. Until then you keep signing in with {account.profile.email}.</Notice>}
        <FormRow>
          <Field label="New email address">
            <Input type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} required maxLength={200} />
          </Field>
          <Field label="Current password">
            <Input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
          </Field>
        </FormRow>
        <p className="text-sm text-muted">We send a confirmation link to the new address. Nothing changes until you open that link, so a typo cannot lock you out.</p>
        <Button type="submit" loading={change.isPending} disabled={!email || !password}>Send confirmation link</Button>
      </form>
    </Section>
  );
}

const MIN_PASSWORD = 10;

function Rule({ ok, children }: { ok: boolean; children: ReactNode }) {
  return (
    <li className={cx('flex items-center gap-2', ok ? 'text-ok' : 'text-muted')}>
      {ok ? <Check className="size-4" aria-hidden /> : <X className="size-4 text-faint" aria-hidden />}
      <span>{children}</span>
      <span className="sr-only">{ok ? '(met)' : '(not met yet)'}</span>
    </li>
  );
}

function PasswordSection({ username }: { username: string }) {
  const qc = useQueryClient();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [again, setAgain] = useState('');
  const rules = { length: next.length >= MIN_PASSWORD, different: next.length > 0 && next !== current, match: next.length > 0 && next === again };
  const valid = rules.length && rules.different && rules.match && current.length > 0;
  const change = useMutation({
    mutationFn: () => api<{ ok: true; sessions_signed_out: number }>('/api/account/password', { json: { current_password: current, new_password: next } }),
    onSuccess: (r) => {
      toast.success(r.sessions_signed_out ? `Password changed. ${r.sessions_signed_out} other ${r.sessions_signed_out === 1 ? 'device was' : 'devices were'} signed out.` : 'Password changed');
      setCurrent('');
      setNext('');
      setAgain('');
      void qc.invalidateQueries({ queryKey: ['account', 'sessions'] });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  return (
    <Section id="password" title="Change password" description="Changing it signs you out everywhere except here.">
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (valid) change.mutate();
        }}
      >
        {/* Lets password managers attach the new password to the right account. */}
        <input type="text" name="username" autoComplete="username" value={username} readOnly hidden />
        <Field label="Current password" className="sm:max-w-sm">
          <Input type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} required />
        </Field>
        <FormRow>
          <Field label="New password">
            <Input type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} required aria-describedby="password-rules" />
          </Field>
          <Field label="Confirm new password">
            <Input type="password" autoComplete="new-password" value={again} onChange={(e) => setAgain(e.target.value)} required aria-describedby="password-rules" />
          </Field>
        </FormRow>
        <ul id="password-rules" className="space-y-1 text-sm" aria-live="polite">
          <Rule ok={rules.length}>At least {MIN_PASSWORD} characters</Rule>
          <Rule ok={rules.different}>Different from your current password</Rule>
          <Rule ok={rules.match}>Both new password fields match</Rule>
        </ul>
        <Button type="submit" loading={change.isPending} disabled={!valid}>Change password</Button>
      </form>
    </Section>
  );
}

/** "Chrome on macOS" from a user-agent string; good enough to recognise your own devices. */
function device(ua: string | null): string {
  if (!ua) return 'Unknown device';
  const browser = /Edg\//.test(ua) ? 'Edge' : /OPR\//.test(ua) ? 'Opera' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : /curl\//.test(ua) ? 'curl' : null;
  const os = /iPhone|iPad|iPod/.test(ua) ? 'iOS' : /Android/.test(ua) ? 'Android' : /Windows/.test(ua) ? 'Windows' : /Mac OS X|Macintosh/.test(ua) ? 'macOS' : /CrOS/.test(ua) ? 'ChromeOS' : /Linux/.test(ua) ? 'Linux' : null;
  if (browser && os) return `${browser} on ${os}`;
  return browser ?? os ?? ua.slice(0, 60);
}

function SecuritySection() {
  const qc = useQueryClient();
  const confirm = useConfirm();
  const sessions = useQuery({ queryKey: ['account', 'sessions'], queryFn: () => api<{ items: SessionRow[] }>('/api/account/sessions') });
  const refetch = () => qc.invalidateQueries({ queryKey: ['account', 'sessions'] });
  const revoke = useMutation({
    mutationFn: (id: string) => api(`/api/account/sessions/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      toast.success('That device was signed out');
      void refetch();
    },
    onError: (e) => {
      toast.error(errorMessage(e));
      void refetch();
    },
  });
  const revokeOthers = useMutation({
    mutationFn: () => api<{ sessions_signed_out: number }>('/api/account/sessions/revoke-others', { method: 'POST' }),
    onSuccess: (r) => {
      toast.success(`Signed out of ${r.sessions_signed_out} other ${r.sessions_signed_out === 1 ? 'device' : 'devices'}`);
      void refetch();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const items = sessions.data?.items ?? [];
  const others = items.filter((s) => !s.current).length;
  return (
    <Section id="security" title="Security" description="Every browser and device where your account is signed in right now.">
      {sessions.isPending ? (
        <div className="h-20 animate-pulse rounded-xl bg-raised" />
      ) : sessions.isError ? (
        <ErrorState message={errorMessage(sessions.error)} retry={() => sessions.refetch()} />
      ) : (
        <>
          <ul className="divide-y divide-line">
            {items.map((s) => (
              <li key={s.id} className="flex flex-wrap items-center justify-between gap-3 py-3 first:pt-0">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2 text-sm font-medium">
                    {device(s.user_agent)}
                    {s.current && <Badge tone="ok">This device</Badge>}
                  </div>
                  <div className="mt-0.5 text-xs text-muted">
                    {s.ip ? `${s.ip} · ` : ''}{s.current ? 'Active now' : `Last active ${ago(s.last_seen_at)}`} · signed in {date(s.created_at)}
                  </div>
                </div>
                {!s.current && (
                  <Button
                    size="sm"
                    className="h-10"
                    disabled={revoke.isPending}
                    onClick={async () => {
                      if (await confirm({ title: 'Sign out this device?', body: `${device(s.user_agent)}${s.ip ? ` (${s.ip})` : ''} will need your password to get back in.`, confirmLabel: 'Sign out', danger: true })) revoke.mutate(s.id);
                    }}
                  >
                    Sign out
                  </Button>
                )}
              </li>
            ))}
          </ul>
          {others > 0 ? (
            <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-line pt-4">
              <p className="text-sm text-muted">See something you do not recognise? Sign out everywhere else, then change your password.</p>
              <Button
                loading={revokeOthers.isPending}
                onClick={async () => {
                  if (await confirm({ title: 'Sign out everywhere else?', body: `${others} other ${others === 1 ? 'device' : 'devices'} will be signed out. You stay signed in here.`, confirmLabel: 'Sign out the others', danger: true })) revokeOthers.mutate();
                }}
              >
                Sign out everywhere else
              </Button>
            </div>
          ) : (
            <p className="mt-3 text-sm text-muted">You are only signed in on this device.</p>
          )}
        </>
      )}
    </Section>
  );
}

function DangerSection({ account }: { account: Account }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState('');
  const [typed, setTyped] = useState('');
  const username = account.profile.username;
  const remove = useMutation({
    mutationFn: () => api('/api/account/delete', { json: { password } }),
    onSuccess: () => {
      qc.clear();
      window.location.assign('/');
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const ready = password.length > 0 && typed.trim().toLowerCase() === username.toLowerCase();
  const close = () => {
    setOpen(false);
    setPassword('');
    setTyped('');
  };
  return (
    <Section id="danger" title="Danger zone" danger>
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="min-w-0 max-w-xl">
          <div className="font-medium">Delete your account</div>
          <p className="mt-1 text-sm text-muted">
            Your profile, library, follows, favorites and notifications are removed and any membership stops renewing. Store credit and page credits are lost. This cannot be undone.
          </p>
        </div>
        <Button variant="danger" icon={<Trash2 className="size-4" />} onClick={() => setOpen(true)}>Delete account</Button>
      </div>
      <Modal
        open={open}
        onClose={close}
        title="Delete your account for good?"
        size="sm"
        footer={
          <>
            <Button variant="ghost" onClick={close}>Keep my account</Button>
            <Button variant="danger" form="delete-account" type="submit" disabled={!ready} loading={remove.isPending}>Delete forever</Button>
          </>
        }
      >
        <form
          id="delete-account"
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (ready) remove.mutate();
          }}
        >
          <Notice tone="danger">
            Comics you bought can no longer be opened{account.wallet.credit_cents > 0 || account.wallet.page_credits > 0 ? ', and your remaining credit is lost' : ''}. Posts you wrote stay, shown as written by a deleted user.
          </Notice>
          {account.member && <p className="text-sm text-muted">Your membership ends now and is not charged again.</p>}
          <Field label="Your password">
            <Input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
          </Field>
          <Field label={<>Type your username, <span className="font-semibold">{username}</span>, to confirm</>}>
            <Input value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" autoCapitalize="off" spellCheck={false} required />
          </Field>
        </form>
      </Modal>
    </Section>
  );
}

// ---------------------------------------------------------------- page

export function Settings() {
  useTitle('Account settings');
  const account = useQuery({ queryKey: ['account'], queryFn: () => api<Account>('/api/account') });
  const [active, setActive] = useState<string>(() => SECTIONS.find((s) => `#${s.id}` === window.location.hash)?.id ?? 'about');
  const jumping = useRef(false);
  const loaded = Boolean(account.data);

  const jump = (id: string, smooth = true) => {
    const el = document.getElementById(id);
    if (!el) return;
    jumping.current = true;
    setActive(id);
    el.scrollIntoView({ behavior: smooth ? 'smooth' : 'auto', block: 'start' });
    window.history.replaceState(window.history.state, '', `#${id}`);
    window.setTimeout(() => (jumping.current = false), 900);
  };

  // Open on the section named in the link (emails link to /account#email).
  useEffect(() => {
    if (!loaded) return;
    const id = window.location.hash.slice(1);
    if (id && id !== 'about' && SECTIONS.some((s) => s.id === id)) jump(id, false);
  }, [loaded]);

  // Highlight the section being read.
  useEffect(() => {
    if (!loaded) return;
    const onScroll = () => {
      if (jumping.current) return;
      const line = window.innerHeight * 0.35;
      let current: string = SECTIONS[0].id;
      for (const s of SECTIONS) {
        const el = document.getElementById(s.id);
        if (el && el.getBoundingClientRect().top <= line) current = s.id;
      }
      if (window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 4) current = SECTIONS[SECTIONS.length - 1].id;
      setActive(current);
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, [loaded]);

  if (account.isPending) return <PageLoader label="Loading your settings" />;
  if (account.isError) return <ErrorState message={errorMessage(account.error)} retry={() => account.refetch()} />;
  const a = account.data;

  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader title="Account settings" description="Each section saves on its own." />
      <div className="md:grid md:grid-cols-[200px_minmax(0,1fr)] md:gap-8">
        <div className="sticky top-16 z-20 -mx-4 mb-5 border-b border-line bg-ink/95 px-4 py-2 backdrop-blur sm:-mx-6 sm:px-6 md:top-24 md:mx-0 md:mb-0 md:self-start md:border-0 md:bg-transparent md:p-0 md:backdrop-blur-none">
          <SectionNav active={active} onPick={jump} />
        </div>
        <div className="min-w-0 space-y-6">
          <AboutSection account={a} />
          <DiscoverySection prefs={a.prefs} />
          <LocaleSection prefs={a.prefs} />
          <PrivacySection prefs={a.prefs} />
          <EmailSection account={a} />
          <BetaSection prefs={a.prefs} />
          <ChangeEmailSection account={a} />
          <PasswordSection username={a.profile.username} />
          <SecuritySection />
          <DangerSection account={a} />
        </div>
      </div>
    </div>
  );
}
