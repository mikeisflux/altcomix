import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import type { RouteObject } from 'react-router';
import { ApiError, api, errorMessage } from '@/lib/api';
import { useSession } from '@/lib/session';
import { Button, Checkbox, ErrorState, Field, Input, LinkButton, Notice, Spinner } from '@/ui';

/** Only follow same-site paths after sign-in. */
function safeNext(next: string | null): string {
  return next && next.startsWith('/') && !next.startsWith('//') ? next : '/';
}

function Login() {
  const { refresh, user } = useSession();
  const nav = useNavigate();
  const [params] = useSearchParams();
  const next = safeNext(params.get('next'));
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [totp, setTotp] = useState('');
  const [needTotp, setNeedTotp] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (user) nav(next, { replace: true });
  }, [user, nav, next]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api('/api/auth/login', { json: { email, password, totp: needTotp ? totp : undefined } });
      await refresh();
    } catch (err) {
      if (err instanceof ApiError && err.code === 'totp_required') setNeedTotp(true);
      else setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="space-y-4">
      <h1 className="text-2xl font-bold">Sign in</h1>
      {error && <ErrorState message={error} />}
      <Field label="Email or username"><Input autoFocus autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required /></Field>
      <Field label="Password"><Input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required /></Field>
      {needTotp && (
        <Field label="Authenticator code" hint="6-digit code from your authenticator app, or a backup code.">
          <Input autoFocus inputMode="numeric" autoComplete="one-time-code" value={totp} onChange={(e) => setTotp(e.target.value)} required />
        </Field>
      )}
      <Button type="submit" variant="primary" block loading={busy}>Sign in</Button>
      <div className="flex justify-between text-sm">
        <Link className="link" to="/forgot-password">Forgot password?</Link>
        <Link className="link" to={`/register${next !== '/' ? `?next=${encodeURIComponent(next)}` : ''}`}>Create an account</Link>
      </div>
    </form>
  );
}

function Register() {
  const { refresh, user, settings } = useSession();
  const nav = useNavigate();
  const [params] = useSearchParams();
  const next = safeNext(params.get('next'));
  const [form, setForm] = useState({ email: '', username: '', password: '', marketing_opt_in: false, website: '' });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const created = useRef(false);

  useEffect(() => {
    if (user) nav(created.current ? '/onboarding/genre' : next, { replace: true });
  }, [user, nav, next]);

  if (!settings.site.registration_open) {
    return (
      <div className="space-y-4">
        <h1 className="text-2xl font-bold">Sign-ups are closed</h1>
        <p className="text-muted">New accounts are paused right now. Please check back soon.</p>
        <LinkButton to="/login" variant="primary" block>Sign in instead</LinkButton>
      </div>
    );
  }

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      created.current = true;
      await api('/api/auth/register', { json: form });
      await refresh();
    } catch (err) {
      created.current = false;
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold">Create your account</h1>
        <p className="mt-1 text-sm text-muted">Free to read, free to publish.</p>
      </div>
      {error && <ErrorState message={error} />}
      <Field label="Email"><Input type="email" autoFocus autoComplete="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} required /></Field>
      <Field label="Username" hint="3-24 letters, numbers or underscores. Shown on comments and your profile.">
        <Input autoComplete="username" value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} required pattern="[A-Za-z0-9_]{3,24}" />
      </Field>
      <Field label="Password" hint="At least 10 characters.">
        <Input type="password" autoComplete="new-password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} required minLength={10} />
      </Field>
      {/* Honeypot: hidden from people, filled by bots. */}
      <input tabIndex={-1} autoComplete="off" aria-hidden className="absolute -left-[9999px] h-0 w-0 opacity-0" name="website" value={form.website} onChange={(e) => setForm({ ...form, website: e.target.value })} />
      <Checkbox checked={form.marketing_opt_in} onChange={(v) => setForm({ ...form, marketing_opt_in: v })} label={`Email me the ${settings.site.name} newsletter`} />
      <Button type="submit" variant="primary" block loading={busy}>Create account</Button>
      <p className="text-xs text-faint">
        By creating an account you agree to the <Link className="link" to="/p/terms">Terms</Link> and <Link className="link" to="/p/privacy">Privacy policy</Link>.
      </p>
      <p className="text-sm">Already have an account? <Link className="link" to="/login">Sign in</Link></p>
    </form>
  );
}

function Forgot() {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api('/api/auth/forgot', { json: { email } });
      setSent(true);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  if (sent) {
    return (
      <div className="space-y-4">
        <h1 className="text-2xl font-bold">Check your inbox</h1>
        <p className="text-muted">If an account exists for {email}, a reset link is on its way. It works for 2 hours.</p>
        <LinkButton to="/login" block>Back to sign in</LinkButton>
      </div>
    );
  }
  return (
    <form onSubmit={submit} className="space-y-4">
      <h1 className="text-2xl font-bold">Reset your password</h1>
      {error && <ErrorState message={error} />}
      <Field label="Email"><Input type="email" autoFocus value={email} onChange={(e) => setEmail(e.target.value)} required /></Field>
      <Button type="submit" variant="primary" block loading={busy}>Send reset link</Button>
      <Link className="link text-sm" to="/login">Back to sign in</Link>
    </form>
  );
}

function Reset() {
  const [params] = useSearchParams();
  const { refresh } = useSession();
  const nav = useNavigate();
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api('/api/auth/reset', { json: { token: params.get('token') ?? '', password } });
      await refresh();
      nav('/', { replace: true });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form onSubmit={submit} className="space-y-4">
      <h1 className="text-2xl font-bold">Choose a new password</h1>
      {error && <ErrorState message={error} />}
      <Field label="New password" hint="At least 10 characters."><Input type="password" autoFocus autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={10} /></Field>
      <Button type="submit" variant="primary" block loading={busy}>Save and sign in</Button>
    </form>
  );
}

/** Handles both "confirm your email" and "confirm your new email" links. */
function ConfirmToken({ endpoint, done }: { endpoint: string; done: string }) {
  const [params] = useSearchParams();
  const { refresh } = useSession();
  const [state, setState] = useState<'working' | 'ok' | string>('working');
  const ran = useRef(false);
  useEffect(() => {
    if (ran.current) return;
    ran.current = true;
    api(endpoint, { json: { token: params.get('token') ?? '' } })
      .then(async () => {
        await refresh();
        setState('ok');
      })
      .catch((e) => setState(errorMessage(e)));
  }, [endpoint, params, refresh]);
  if (state === 'working') return <div className="flex items-center gap-3 text-muted"><Spinner /> Confirming…</div>;
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">{state === 'ok' ? done : 'That link did not work'}</h1>
      {state !== 'ok' && <ErrorState message={state} />}
      <LinkButton to="/" variant="primary" block>Continue</LinkButton>
    </div>
  );
}

function Unsubscribed() {
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">You are unsubscribed</h1>
      <Notice tone="ok">You will no longer get newsletters or notification emails. Receipts and security messages still arrive.</Notice>
      <p className="text-sm text-muted">Changed your mind? Turn individual emails back on in account settings.</p>
      <LinkButton to="/account" block>Account settings</LinkButton>
    </div>
  );
}

export const authRoutes: RouteObject[] = [
  { path: '/login', element: <Login /> },
  { path: '/register', element: <Register /> },
  { path: '/forgot-password', element: <Forgot /> },
  { path: '/reset-password', element: <Reset /> },
  { path: '/verify-email', element: <ConfirmToken endpoint="/api/auth/verify-email" done="Email confirmed" /> },
  { path: '/confirm-email', element: <ConfirmToken endpoint="/api/auth/confirm-email-change" done="New email confirmed" /> },
  { path: '/unsubscribed', element: <Unsubscribed /> },
];
