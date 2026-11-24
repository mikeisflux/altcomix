import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Copy, Download, ShieldCheck, ShieldOff } from 'lucide-react';
import { useState } from 'react';
import type { FormEvent } from 'react';
import { api, errorMessage } from '@/lib/api';
import { useSession } from '@/lib/session';
import { Badge, Button, Checkbox, ErrorState, Field, Input, Modal, Notice, toast } from '@/ui';

type Status = { enabled: boolean; enrolment_pending: boolean; backup_codes_left: number };
type Enrolment = { secret: string; otpauth_url: string; qr_data_url: string };

const digits = (v: string) => v.replace(/\D/g, '').slice(0, 6);

function CodeInput({ value, onChange, autoFocus, id }: { value: string; onChange: (v: string) => void; autoFocus?: boolean; id?: string }) {
  return (
    <Input
      id={id}
      value={value}
      onChange={(e) => onChange(digits(e.target.value))}
      inputMode="numeric"
      autoComplete="one-time-code"
      pattern="[0-9]{6}"
      maxLength={6}
      placeholder="123456"
      autoFocus={autoFocus}
      className="max-w-40 font-mono text-lg tracking-[0.3em]"
    />
  );
}

/** Backup codes are shown exactly once: copy them, download them, and say so before the dialog will close. */
function BackupCodes({ codes, siteName, account, onDone }: { codes: string[]; siteName: string; account: string; onDone: () => void }) {
  const [saved, setSaved] = useState(false);
  const text = `${siteName} backup codes for ${account}\nEach code signs you in once if you do not have your authenticator app.\n\n${codes.join('\n')}\n`;
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(codes.join('\n'));
      toast.success('Backup codes copied');
    } catch {
      toast.error('Could not copy. Select the codes and copy them by hand, or download them.');
    }
  };
  const download = () => {
    const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `${siteName.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-backup-codes.txt`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };
  return (
    <div className="space-y-4">
      <Notice tone="warn">These codes are shown only this once. Each one signs you in a single time if you lose your phone. Keep them somewhere safe, away from your password.</Notice>
      <ul className="grid grid-cols-2 gap-2 rounded-xl border border-line bg-ink p-4 font-mono text-sm tabular-nums" aria-label="Backup codes">
        {codes.map((c) => <li key={c} className="select-all tracking-wider">{c}</li>)}
      </ul>
      <div className="flex flex-wrap gap-2">
        <Button icon={<Copy className="size-4" />} onClick={() => void copy()}>Copy codes</Button>
        <Button icon={<Download className="size-4" />} onClick={download}>Download as a text file</Button>
      </div>
      <Checkbox checked={saved} onChange={setSaved} label="I have saved these codes" />
      <div className="flex justify-end"><Button variant="primary" disabled={!saved} onClick={onDone}>Done</Button></div>
    </div>
  );
}

/** Two-factor sign-in for the account: set up with a QR code, confirm, keep backup codes, turn off. */
export function TwoFactor() {
  const qc = useQueryClient();
  const { user, settings, refresh } = useSession();
  const status = useQuery({ queryKey: ['account', '2fa'], queryFn: () => api<Status>('/api/account/2fa') });
  const [setup, setSetup] = useState<Enrolment | null>(null);
  const [code, setCode] = useState('');
  const [codes, setCodes] = useState<string[] | null>(null);
  const [dialog, setDialog] = useState<null | 'disable' | 'renew'>(null);
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);

  const changed = async () => {
    await Promise.all([qc.invalidateQueries({ queryKey: ['account'] }), refresh()]);
  };
  const reset = () => {
    setSetup(null);
    setCode('');
    setPassword('');
    setError(null);
    setDialog(null);
  };

  const begin = useMutation({
    mutationFn: () => api<Enrolment>('/api/account/2fa/begin', { method: 'POST' }),
    onSuccess: (r) => {
      setCode('');
      setError(null);
      setSetup(r);
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const confirm = useMutation({
    mutationFn: () => api<{ backup_codes: string[] }>('/api/account/2fa/confirm', { json: { code } }),
    onSuccess: async (r) => {
      setSetup(null);
      setCode('');
      setCodes(r.backup_codes);
      toast.success('Two-factor sign-in is on');
      await changed();
    },
    onError: (e) => setError(errorMessage(e)),
  });
  const renew = useMutation({
    mutationFn: () => api<{ backup_codes: string[] }>('/api/account/2fa/backup-codes', { json: { code } }),
    onSuccess: async (r) => {
      reset();
      setCodes(r.backup_codes);
      await changed();
    },
    onError: (e) => setError(errorMessage(e)),
  });
  const disable = useMutation({
    mutationFn: () => api<{ ok: true; setup_required: boolean }>('/api/account/2fa/disable', { json: { password, code: code.trim() } }),
    onSuccess: async (r) => {
      reset();
      toast.success(r.setup_required ? 'Two-factor sign-in is off. Staff accounts are asked to set it up again.' : 'Two-factor sign-in is off');
      await changed();
    },
    onError: (e) => setError(errorMessage(e)),
  });

  if (status.isPending) return <div className="h-20 animate-pulse rounded-xl bg-raised" />;
  if (status.isError) return <ErrorState message={errorMessage(status.error)} retry={() => status.refetch()} />;
  const s = status.data;

  return (
    <div>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0 max-w-xl">
          <div className="flex flex-wrap items-center gap-2 font-medium">
            Two-factor sign-in
            {s.enabled ? <Badge tone="ok">On</Badge> : <Badge>Off</Badge>}
          </div>
          <p className="mt-1 text-sm text-muted">
            {s.enabled
              ? `Signing in asks for your password and a 6-digit code from your authenticator app. You have ${s.backup_codes_left} backup ${s.backup_codes_left === 1 ? 'code' : 'codes'} left.`
              : 'Add a second step when you sign in: a 6-digit code from an authenticator app on your phone. Someone who learns your password still cannot get in.'}
          </p>
          {s.enabled && s.backup_codes_left <= 2 && <p className="mt-1 text-sm text-warn">You are nearly out of backup codes. Make a new set.</p>}
        </div>
        {s.enabled ? (
          <div className="flex flex-wrap gap-2">
            <Button onClick={() => { reset(); setDialog('renew'); }}>New backup codes</Button>
            <Button variant="danger" icon={<ShieldOff className="size-4" />} onClick={() => { reset(); setDialog('disable'); }}>Turn off</Button>
          </div>
        ) : (
          <Button icon={<ShieldCheck className="size-4" />} loading={begin.isPending} onClick={() => begin.mutate()}>
            {s.enrolment_pending ? 'Start setup again' : 'Set up two-factor sign-in'}
          </Button>
        )}
      </div>

      {/* Step 1 and 2: scan, then prove it works. Nothing is switched on until the code is accepted. */}
      <Modal open={Boolean(setup)} onClose={reset} title="Set up two-factor sign-in">
        {setup && (
          <form
            className="space-y-5"
            onSubmit={(e: FormEvent) => {
              e.preventDefault();
              if (code.length === 6) confirm.mutate();
            }}
          >
            <div className="flex flex-col gap-5 sm:flex-row">
              <img src={setup.qr_data_url} alt="QR code to scan with your authenticator app" width={200} height={200} className="size-[200px] shrink-0 self-center rounded-xl border border-line bg-paper p-2 sm:self-start" />
              <ol className="min-w-0 list-decimal space-y-3 pl-5 text-sm">
                <li>Open an authenticator app on your phone (any app that supports time-based codes).</li>
                <li>
                  Scan the QR code. If you cannot scan it, type this key into the app instead:
                  <span className="mt-1.5 flex flex-wrap items-center gap-2">
                    <code className="select-all break-all rounded-md border border-line bg-ink px-2 py-1 font-mono text-xs tracking-wider">{setup.secret.match(/.{1,4}/g)?.join(' ')}</code>
                    <button
                      type="button"
                      className="link min-h-10 text-xs"
                      onClick={() => navigator.clipboard.writeText(setup.secret).then(() => toast.success('Key copied'), () => toast.error('Could not copy. Select the key and copy it by hand.'))}
                    >
                      Copy key
                    </button>
                  </span>
                </li>
                <li>Enter the 6-digit code the app shows to finish.</li>
              </ol>
            </div>
            <Field label="Code from your app" error={error}>
              <CodeInput value={code} onChange={(v) => { setCode(v); setError(null); }} autoFocus />
            </Field>
            <div className="flex flex-wrap justify-end gap-2">
              <Button variant="ghost" onClick={reset}>Cancel</Button>
              <Button type="submit" variant="primary" loading={confirm.isPending} disabled={code.length !== 6}>Turn on two-factor sign-in</Button>
            </div>
          </form>
        )}
      </Modal>

      {/* Step 3: the backup codes, once. The dialog only closes through "Done". */}
      <Modal open={Boolean(codes)} onClose={() => {}} title="Save your backup codes" size="sm">
        {codes && <BackupCodes codes={codes} siteName={settings.site.name} account={user?.email ?? ''} onDone={() => setCodes(null)} />}
      </Modal>

      <Modal open={dialog === 'renew'} onClose={reset} title="Make new backup codes" size="sm">
        <form
          className="space-y-4"
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            if (code.length === 6) renew.mutate();
          }}
        >
          <p className="text-sm text-muted">You get ten new codes and the old ones stop working straight away.</p>
          <Field label="Code from your app" error={error}>
            <CodeInput value={code} onChange={(v) => { setCode(v); setError(null); }} autoFocus />
          </Field>
          <div className="flex flex-wrap justify-end gap-2">
            <Button variant="ghost" onClick={reset}>Cancel</Button>
            <Button type="submit" variant="primary" loading={renew.isPending} disabled={code.length !== 6}>Make new codes</Button>
          </div>
        </form>
      </Modal>

      <Modal open={dialog === 'disable'} onClose={reset} title="Turn off two-factor sign-in?" size="sm">
        <form
          className="space-y-4"
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            if (password && code.trim().length >= 6) disable.mutate();
          }}
        >
          <p className="text-sm text-muted">Your account will be protected by your password alone. To confirm it is you, enter your password and a code.</p>
          {error && <ErrorState message={error} />}
          <Field label="Your password">
            <Input type="password" autoComplete="current-password" value={password} onChange={(e) => { setPassword(e.target.value); setError(null); }} required autoFocus />
          </Field>
          <Field label="Code from your app, or a backup code">
            <Input value={code} onChange={(e) => { setCode(e.target.value.slice(0, 20)); setError(null); }} autoComplete="one-time-code" autoCapitalize="characters" spellCheck={false} placeholder="123456" className="font-mono tracking-wider" required />
          </Field>
          <div className="flex flex-wrap justify-end gap-2">
            <Button variant="ghost" onClick={reset}>Keep it on</Button>
            <Button type="submit" variant="danger" loading={disable.isPending} disabled={!password || code.trim().length < 6}>Turn off</Button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
