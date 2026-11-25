import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CalendarDays, Coins, FileText, IdCard, Landmark, Share2, Trash2, UsersRound } from 'lucide-react';
import { useMemo, useState } from 'react';
import type { FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { api } from '@/lib/api';
import { date, dateTime, moneyExact, plural } from '@/lib/format';
import { useSession } from '@/lib/session';
import { Avatar, Badge, Button, Field, FormRow, IconButton, Input, MoneyInput, Notice, Segmented, Select, SideNav, Switch, Table, Textarea, toast, useConfirm } from '@/ui';
import { SaveBar } from './SeriesDetails';
import { BrandPage, COUNTRIES, FileButton, IMAGE_TYPES, Q, ROLE_HELP, Section, TIMEZONES, can, cap, changed, useAct, useBrand, useDraft, Group } from './shared';
import type { Role, StudioBrand } from './shared';

const brandKeys = [['studio', 'brands']];

function useSaveBrand(success: string) {
  const { brand } = useBrand();
  const { refresh } = useSession();
  const nav = useNavigate();
  return useAct((body: Record<string, unknown>) => api<{ brand: StudioBrand }>(`/api/studio/brands/${brand.id}`, { method: 'PATCH', json: body }), {
    success,
    invalidate: brandKeys,
    onDone: async (r) => {
      await refresh();
      if (r.brand.slug !== brand.slug) nav(`/studio/${r.brand.slug}/settings`, { replace: true });
    },
  });
}

function Images({ editable }: { editable: boolean }) {
  const { brand } = useBrand();
  const { refresh } = useSession();
  const send = (kind: 'avatar' | 'banner') => (file: File) => {
    const form = new FormData();
    form.append('file', file);
    return api(`/api/studio/brands/${brand.id}/${kind}`, { form });
  };
  const opts = { invalidate: brandKeys, onDone: () => void refresh() };
  const avatar = useAct(send('avatar'), { success: 'Avatar updated', ...opts });
  const banner = useAct(send('banner'), { success: 'Banner updated', ...opts });
  const remove = useAct((kind: 'avatar' | 'banner') => api(`/api/studio/brands/${brand.id}/${kind}`, { method: 'DELETE' }), { success: 'Image removed', ...opts });
  const pick = (m: typeof avatar) => (f: File[]) => (f[0].size > 30 * 1024 * 1024 ? toast.error('Choose an image under 30 MB') : m.mutate(f[0]));
  return (
    <Section title="Images" description="Shown on your public brand page.">
      <div className="flex flex-wrap items-center gap-4">
        <Avatar src={brand.avatar_url} name={brand.name} size={72} square />
        <div>
          <div className="text-sm font-medium">Avatar</div>
          <p className="mb-2 text-xs text-muted">Square, at least 400 by 400 pixels.</p>
          {editable && <div className="flex gap-2"><FileButton accept={IMAGE_TYPES} size="sm" loading={avatar.isPending} onFiles={pick(avatar)}>Upload</FileButton>{brand.avatar_url && <Button size="sm" variant="ghost" onClick={() => remove.mutate('avatar')}>Remove</Button>}</div>}
        </div>
      </div>
      <div>
        <div className="text-sm font-medium">Banner</div>
        <p className="mb-2 text-xs text-muted">Wide, 1600 by 400 pixels works best.</p>
        <div className="mb-2 aspect-[4/1] w-full max-w-2xl overflow-hidden rounded-xl border border-line bg-raised">{brand.banner_url && <img src={brand.banner_url} alt="Brand banner" className="size-full object-cover" />}</div>
        {editable && <div className="flex gap-2"><FileButton accept={IMAGE_TYPES} size="sm" loading={banner.isPending} onFiles={pick(banner)}>Upload</FileButton>{brand.banner_url && <Button size="sm" variant="ghost" onClick={() => remove.mutate('banner')}>Remove</Button>}</div>}
      </div>
    </Section>
  );
}

function Identity() {
  const { brand, role } = useBrand();
  const { meta } = useSession();
  const editable = can(role, 'admin');
  const server = useMemo(() => ({ name: brand.name, slug: brand.slug, bio: brand.bio, country: brand.country, primary_language: brand.primary_language, timezone: brand.timezone, ga_tracking_id: brand.ga_tracking_id, membership_note: brand.membership_note }), [brand]);
  const [d, set, dirty, reset] = useDraft(server);
  const save = useSaveBrand('Brand saved');
  const kind = useSaveBrand(brand.kind_requested ? 'Request withdrawn' : 'Request sent. We will review it shortly.');
  const other = brand.kind === 'creator' ? 'publisher' : 'creator';
  return (
    <div className="space-y-5">
      <Section title="Identity">
        <fieldset disabled={!editable} className="space-y-4">
          <FormRow>
            <Field label="Brand name"><Input value={d.name} maxLength={80} onChange={(e) => set({ name: e.target.value })} /></Field>
            <Field label="Brand address" hint={`Your public page: /${d.slug}. Changing it breaks old links.`}><Input value={d.slug} maxLength={60} onChange={(e) => set({ slug: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '') })} /></Field>
          </FormRow>
          <Field label="Short bio"><Textarea value={d.bio} maxLength={400} className="min-h-20" onChange={(e) => set({ bio: e.target.value })} /></Field>
          <FormRow cols={3}>
            <Field label="Country"><Select value={d.country ?? ''} onChange={(e) => set({ country: e.target.value || null })}><option value="">Not set</option>{COUNTRIES.map((c) => <option key={c.code} value={c.code}>{c.name}</option>)}</Select></Field>
            <Field label="Primary language" hint="The default for new series."><Select value={d.primary_language} onChange={(e) => set({ primary_language: e.target.value })}>{meta.languages.map((l) => <option key={l.code} value={l.code}>{l.label}</option>)}</Select></Field>
            <Field label="Timezone"><Select value={d.timezone ?? ''} onChange={(e) => set({ timezone: e.target.value || null })}><option value="">Not set</option>{TIMEZONES.map((z) => <option key={z}>{z}</option>)}</Select></Field>
          </FormRow>
          <Field label="Google Analytics ID" optional hint="Like G-XXXXXXXXXX. Page views of your series and reader pages are also sent to your own property."><Input value={d.ga_tracking_id ?? ''} className="max-w-64" onChange={(e) => set({ ga_tracking_id: e.target.value.toUpperCase() || null })} /></Field>
          <Field label="Membership note" optional hint="A message to members on your brand page, for example what their reading supports."><Textarea value={d.membership_note} maxLength={1000} className="min-h-20" onChange={(e) => set({ membership_note: e.target.value })} /></Field>
        </fieldset>
        <SaveBar dirty={dirty} saving={save.isPending} onSave={() => save.mutate({ ...changed(server, d), ...(d.ga_tracking_id !== server.ga_tracking_id ? { ga_tracking_id: d.ga_tracking_id ?? '' } : {}) })} onReset={reset} />
      </Section>
      <Section title="Creator or publisher" description="Creators publish their own work. Publishers release work by several creators. The label shows on your brand page.">
        <div className="flex flex-wrap items-center gap-3 text-sm">
          <span>This brand is a <strong>{brand.kind}</strong>.</span>
          {brand.kind_requested && <Badge tone="info">Change to {brand.kind_requested} awaiting approval</Badge>}
          {brand.verified && <Badge tone="ok">Verified</Badge>}
        </div>
        {editable && (brand.kind_requested
          ? <div><Button loading={kind.isPending} onClick={() => kind.mutate({ kind: brand.kind })}>Withdraw the request</Button><p className="mt-2 text-xs text-muted">Our team reviews requests by hand. Nothing changes for your readers in the meantime.</p></div>
          : <div><Button loading={kind.isPending} onClick={() => kind.mutate({ kind: other })}>Ask to become a {other}</Button><p className="mt-2 text-xs text-muted">No form to fill in and no email to send: one click sends the request to our team.</p></div>)}
      </Section>
      <Images editable={editable} />
    </div>
  );
}

const SOCIALS: [string, string, string][] = [['x', 'X (Twitter)', 'username'], ['facebook', 'Facebook', 'page name'], ['instagram', 'Instagram', 'username'], ['bluesky', 'Bluesky', 'handle'], ['youtube', 'YouTube', 'channel'], ['discord', 'Discord', 'invite link'], ['tiktok', 'TikTok', 'username']];

function Social() {
  const { brand, role } = useBrand();
  const editable = can(role, 'admin');
  const server = useMemo(() => ({ website: brand.website, socials: Object.fromEntries(SOCIALS.map(([k]) => [k, brand.socials[k] ?? ''])) as Record<string, string> }), [brand]);
  const [d, set, dirty, reset] = useDraft(server);
  const save = useSaveBrand('Links saved');
  return (
    <Section title="Website and social links" description="Shown on your brand page. Leave any of them empty.">
      <fieldset disabled={!editable} className="space-y-4">
        <Field label="Website"><Input type="url" placeholder="https://" value={d.website ?? ''} onChange={(e) => set({ website: e.target.value || null })} /></Field>
        <FormRow>
          {SOCIALS.map(([k, label, what]) => <Field key={k} label={label}><Input value={d.socials[k]} maxLength={200} placeholder={what} onChange={(e) => set({ socials: { ...d.socials, [k]: e.target.value } })} /></Field>)}
        </FormRow>
      </fieldset>
      <SaveBar dirty={dirty} saving={save.isPending} onSave={() => save.mutate({ website: d.website ?? '', socials: d.socials })} onReset={reset} />
    </Section>
  );
}

function Tips() {
  const { brand, role } = useBrand();
  const editable = can(role, 'admin');
  const server = useMemo(() => ({ tips_enabled: brand.tips_enabled, monthly_goal_cents: brand.monthly_goal_cents }), [brand]);
  const [d, set, dirty, reset] = useDraft(server);
  const save = useSaveBrand('Tip settings saved');
  return (
    <Section title="Tips" description="Let readers send you money directly from your brand page and from the last page of a release.">
      <Switch checked={d.tips_enabled} onChange={(v) => set({ tips_enabled: v })} disabled={!editable} label="Accept tips" />
      <Field label="Monthly goal" optional hint="Shows a progress bar on your brand page. Leave empty for no goal." className="max-w-56"><MoneyInput cents={d.monthly_goal_cents} disabled={!editable || !d.tips_enabled} onChange={(c) => set({ monthly_goal_cents: c })} /></Field>
      <SaveBar dirty={dirty} saving={save.isPending} onSave={() => save.mutate(changed(server, d))} onReset={reset} />
    </Section>
  );
}

type PayoutInfo = { payout: { configured: boolean; method: string | null; legal_name: string | null; destination_hint: string | null; updated_at: string | null }; methods: string[] };
const METHOD_LABEL: Record<string, string> = { paypal: 'PayPal', venmo: 'Venmo', cashapp: 'Cash App', wise: 'Wise', bank_transfer: 'Bank transfer' };

function Payouts() {
  const { brand, role } = useBrand();
  const info = useQuery({ queryKey: ['studio', 'payout', brand.id], queryFn: () => api<PayoutInfo>(`/api/studio/brands/${brand.id}/payout`), enabled: can(role, 'admin') });
  const [method, setMethod] = useState<string | null>(null);
  const [destination, setDestination] = useState('');
  const [legal, setLegal] = useState<string | null>(null);
  const save = useAct(() => api(`/api/studio/brands/${brand.id}/payout`, { method: 'PUT', json: { method: method ?? info.data?.payout.method ?? 'paypal', destination, legal_name: legal ?? info.data?.payout.legal_name ?? '' } }), { success: 'Payout details saved', invalidate: [['studio', 'payout', brand.id], ['studio', 'earnings', brand.id], ...brandKeys], onDone: () => setDestination('') });
  if (!can(role, 'admin')) return <Notice tone="info">Payout details can be seen and changed by brand admins and owners only.</Notice>;
  return (
    <Section title="Payout details" description="Where we send your earnings when you request a payout.">
      <Q query={info}>
        {(d) => {
          const m = method ?? d.payout.method ?? 'paypal';
          return (
            <form className="space-y-4" onSubmit={(e: FormEvent) => { e.preventDefault(); save.mutate(); }}>
              {d.payout.configured ? <Notice tone="ok">On file: {METHOD_LABEL[d.payout.method!] ?? d.payout.method} to {d.payout.destination_hint}, payee {d.payout.legal_name}. Updated {date(d.payout.updated_at)}.</Notice> : <Notice tone="warn">No payout details yet. Add them to be able to request payouts.</Notice>}
              <Group label="Method"><Segmented value={m} onChange={setMethod} options={d.methods.map((x) => ({ value: x, label: METHOD_LABEL[x] ?? x }))} /></Group>
              <FormRow>
                <Field label="Legal name of the payee"><Input value={legal ?? d.payout.legal_name ?? ''} onChange={(e) => setLegal(e.target.value)} required minLength={2} maxLength={120} /></Field>
                <Field label={m === 'venmo' ? 'Venmo username' : m === 'cashapp' ? 'Cash App $cashtag' : 'PayPal email or @PayPal.Me name'} hint={d.payout.configured ? 'Enter it again to change anything.' : m === 'venmo' ? 'Like @yourname' : m === 'cashapp' ? 'Like $yourname' : 'The email on the PayPal account, or @yourname'}>
                  <Input type="text" value={destination} onChange={(e) => setDestination(e.target.value)} placeholder={m === 'venmo' ? '@yourname' : m === 'cashapp' ? '$yourname' : 'you@example.com or @yourname'} required minLength={2} maxLength={200} autoComplete="off" autoCapitalize="none" spellCheck={false} />
                </Field>
              </FormRow>
              <Button type="submit" variant="primary" loading={save.isPending}>Save payout details</Button>
              <p className="text-sm text-muted">Once your earnings in a calendar year reach the tax reporting limit, payouts also need a tax information form. <Link className="link" to={`/studio/${brand.slug}/tax`}>Tax information</Link></p>
            </form>
          );
        }}
      </Q>
    </Section>
  );
}

type Member = { user_id: string; username: string; display_name: string; avatar_url: string | null; role: Role; created_at: string; email?: string; is_you: boolean };
type Invite = { id: string; email: string; role: Role; created_at: string; expires_at: string; invited_by: string | null };

function Team() {
  const { brand, role } = useBrand();
  const { refresh } = useSession();
  const confirm = useConfirm();
  const nav = useNavigate();
  const key = ['studio', 'members', brand.id];
  const team = useQuery({ queryKey: key, queryFn: () => api<{ members: Member[]; invites: Invite[]; roles: Role[]; your_role: Role }>(`/api/studio/brands/${brand.id}/members`) });
  const [email, setEmail] = useState('');
  const [inviteRole, setInviteRole] = useState<Role>('editor');
  const manage = can(role, 'admin');
  const owner = role === 'owner';
  const inv = [key, ...brandKeys];
  const invite = useAct(() => api(`/api/studio/brands/${brand.id}/invites`, { json: { email, role: inviteRole } }), { success: `Invitation sent to ${email}`, invalidate: inv, onDone: () => setEmail('') });
  const cancel = useAct((id: string) => api(`/api/studio/brands/${brand.id}/invites/${id}`, { method: 'DELETE' }), { success: 'Invitation withdrawn', invalidate: inv });
  const change = useAct((v: { id: string; role: Role }) => api(`/api/studio/brands/${brand.id}/members/${v.id}`, { method: 'PATCH', json: { role: v.role } }), { success: 'Role changed', invalidate: inv, onDone: () => void refresh() });
  const remove = useAct((m: Member) => api(`/api/studio/brands/${brand.id}/members/${m.user_id}`, { method: 'DELETE' }), { success: (_r, m) => (m.is_you ? `You left ${brand.name}` : 'Member removed'), invalidate: inv, onDone: async (_r, m) => { await refresh(); if (m.is_you) nav('/studio'); } });
  const assignable = (target: Role): Role[] => (owner ? ['owner', 'admin', 'editor', 'analyst'] : target === 'owner' || target === 'admin' ? [] : ['editor', 'analyst']);
  return (
    <div className="space-y-5">
      <Section title="Members">
        <Q query={team}>
          {(d) => (
            <ul className="divide-y divide-line rounded-xl border border-line">
              {d.members.map((m) => {
                const options = manage ? assignable(m.role) : [];
                return (
                  <li key={m.user_id} className="flex flex-wrap items-center gap-3 px-3 py-2.5 text-sm">
                    <Avatar src={m.avatar_url} name={m.display_name || m.username} size={36} />
                    <div className="min-w-40 flex-1">
                      <div className="font-medium">{m.display_name || m.username} {m.is_you && <Badge>You</Badge>}</div>
                      <div className="text-xs text-muted">@{m.username}{m.email ? ` · ${m.email}` : ''} · joined {date(m.created_at)}</div>
                    </div>
                    {options.length > 0 ? (
                      <select aria-label={`Role of ${m.username}`} className="h-9 rounded-md border border-line bg-ink px-2 text-sm" value={m.role} disabled={change.isPending} onChange={(e) => change.mutate({ id: m.user_id, role: e.target.value as Role })}>
                        {options.map((r) => <option key={r} value={r}>{cap(r)}</option>)}
                      </select>
                    ) : <Badge>{m.role}</Badge>}
                    {(m.is_you || options.length > 0) && (
                      <Button size="sm" variant="ghost" disabled={remove.isPending} onClick={async () => (await confirm({ title: m.is_you ? `Leave ${brand.name}?` : `Remove ${m.display_name || m.username}?`, body: m.is_you ? 'You will lose access to this brand straight away.' : 'They lose access to this brand straight away.', confirmLabel: m.is_you ? 'Leave brand' : 'Remove', danger: true })) && remove.mutate(m)}>{m.is_you ? 'Leave' : 'Remove'}</Button>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </Q>
      </Section>
      <Section title="Roles">
        <dl className="grid gap-2 text-sm sm:grid-cols-2">{(Object.keys(ROLE_HELP) as Role[]).map((r) => <div key={r} className="rounded-xl border border-line p-3"><dt className="font-semibold">{cap(r)}</dt><dd className="text-muted">{ROLE_HELP[r]}</dd></div>)}</dl>
      </Section>
      {manage && (
        <Section title="Invite someone" description="They get an email with a link. If they have no NSFWComix account yet, they can create one with that address and then accept.">
          <form className="grid items-end gap-3 sm:grid-cols-[1fr_160px_auto]" onSubmit={(e: FormEvent) => { e.preventDefault(); invite.mutate(); }}>
            <Field label="Email address"><Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required maxLength={200} /></Field>
            <Field label="Role"><Select value={inviteRole} onChange={(e) => setInviteRole(e.target.value as Role)}>{(owner ? ['owner', 'admin', 'editor', 'analyst'] : ['editor', 'analyst']).map((r) => <option key={r} value={r}>{cap(r)}</option>)}</Select></Field>
            <Button type="submit" variant="primary" loading={invite.isPending}>Send invitation</Button>
          </form>
          {team.data && team.data.invites.length > 0 && (
            <Table rows={team.data.invites} rowKey={(i) => i.id} columns={[
              { key: 'e', header: 'Waiting for', cell: (i) => i.email },
              { key: 'r', header: 'Role', cell: (i) => cap(i.role) },
              { key: 'x', header: 'Expires', cell: (i) => dateTime(i.expires_at), hideOnMobile: true },
              { key: 'a', header: '', cell: (i) => <Button size="sm" variant="ghost" disabled={cancel.isPending} onClick={() => cancel.mutate(i.id)}>Withdraw</Button> },
            ]} />
          )}
        </Section>
      )}
    </div>
  );
}

type Convention = { id: string; name: string; location: string; booth: string; url: string | null; starts_on: string; ends_on: string | null };

function Conventions() {
  const { brand, role } = useBrand();
  const editable = can(role, 'editor');
  const key = ['studio', 'conventions', brand.id];
  const list = useQuery({ queryKey: key, queryFn: () => api<{ conventions: Convention[] }>(`/api/studio/brands/${brand.id}/conventions`) });
  const empty = { name: '', location: '', booth: '', url: '', starts_on: '', ends_on: '' };
  const [f, setF] = useState(empty);
  const [editing, setEditing] = useState<string | null>(null);
  const base = `/api/studio/brands/${brand.id}/conventions`;
  const save = useAct(() => { const json = { ...f, ends_on: f.ends_on || null }; return editing ? api(`${base}/${editing}`, { method: 'PATCH', json }) : api(base, { json }); }, { success: editing ? 'Appearance saved' : 'Appearance added', invalidate: [key], onDone: () => { setF(empty); setEditing(null); } });
  const remove = useAct((id: string) => api(`${base}/${id}`, { method: 'DELETE' }), { success: 'Appearance removed', invalidate: [key] });
  const day = (s: string) => date(s, { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' });
  return (
    <Section title="Convention appearances" description="Tell readers where to find you in person. Upcoming appearances show on your brand page.">
      <Q query={list}>
        {(d) => (
          <Table rows={d.conventions} rowKey={(c) => c.id} empty="No appearances listed yet" columns={[
            { key: 'n', header: 'Convention', cell: (c) => <div><div className="font-medium">{c.name}</div><div className="text-xs text-muted">{[c.location, c.booth && `Booth ${c.booth}`].filter(Boolean).join(' · ') || '—'}</div></div> },
            { key: 'd', header: 'Dates', cell: (c) => `${day(c.starts_on)}${c.ends_on && c.ends_on !== c.starts_on ? ` to ${day(c.ends_on)}` : ''}` },
            { key: 'x', header: '', cell: (c) => editable && (
              <div className="flex justify-end gap-1">
                <Button size="sm" variant="ghost" onClick={() => { setEditing(c.id); setF({ name: c.name, location: c.location, booth: c.booth, url: c.url ?? '', starts_on: c.starts_on.slice(0, 10), ends_on: c.ends_on?.slice(0, 10) ?? '' }); }}>Edit</Button>
                <IconButton label={`Remove ${c.name}`} onClick={() => remove.mutate(c.id)}><Trash2 className="size-4" /></IconButton>
              </div>
            ) },
          ]} />
        )}
      </Q>
      {editable && (
        <form className="space-y-3 rounded-xl border border-line p-3.5" onSubmit={(e: FormEvent) => { e.preventDefault(); save.mutate(); }}>
          <h3 className="text-sm font-semibold">{editing ? 'Edit appearance' : 'Add an appearance'}</h3>
          <FormRow>
            <Field label="Convention name"><Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required minLength={2} maxLength={120} /></Field>
            <Field label="City or venue" optional><Input value={f.location} onChange={(e) => setF({ ...f, location: e.target.value })} maxLength={160} /></Field>
          </FormRow>
          <FormRow cols={4}>
            <Field label="First day"><Input type="date" value={f.starts_on} onChange={(e) => setF({ ...f, starts_on: e.target.value })} required /></Field>
            <Field label="Last day" optional><Input type="date" value={f.ends_on} min={f.starts_on} onChange={(e) => setF({ ...f, ends_on: e.target.value })} /></Field>
            <Field label="Booth or table" optional><Input value={f.booth} onChange={(e) => setF({ ...f, booth: e.target.value })} maxLength={60} /></Field>
            <Field label="Link" optional><Input type="url" placeholder="https://" value={f.url} onChange={(e) => setF({ ...f, url: e.target.value })} /></Field>
          </FormRow>
          <div className="flex gap-2"><Button type="submit" loading={save.isPending}>{editing ? 'Save appearance' : 'Add appearance'}</Button>{editing && <Button variant="ghost" onClick={() => { setEditing(null); setF(empty); }}>Cancel</Button>}</div>
        </form>
      )}
    </Section>
  );
}

type Deletion = { balance_cents: number; open_payouts: number; open_payout_cents: number; series_count: number; published_release_count: number; owned_copies: number; usable_codes: number; can_delete: boolean; blockers: string[] };

function DeleteBrand() {
  const { brand, role } = useBrand();
  const { refresh, currency } = useSession();
  const nav = useNavigate();
  const qc = useQueryClient();
  const [typed, setTyped] = useState('');
  const owner = role === 'owner';
  const state = useQuery({ queryKey: ['studio', 'brand-deletion', brand.id], queryFn: () => api<Deletion>(`/api/studio/brands/${brand.id}/deletion`), enabled: owner });
  const del = useAct(() => api(`/api/studio/brands/${brand.id}`, { method: 'DELETE' }), {
    success: `${brand.name} has been deleted`,
    // Leave the brand's screens first: nothing about it can be loaded any more.
    onDone: async () => {
      nav('/studio', { replace: true });
      await refresh();
      await qc.invalidateQueries({ queryKey: ['studio', 'brands'], exact: true });
    },
  });
  if (!owner) return <Notice tone="info">Only an owner of this brand can delete it.</Notice>;
  const matches = typed.trim() === brand.name;
  return (
    <Section title="Delete this brand" description="Takes the brand and everything published under it off NSFWComix. This cannot be undone from the Studio.">
      <Q query={state}>
        {(d) => (
          <div className="space-y-4">
            <div>
              <h3 className="mb-2 text-sm font-semibold">What happens when you delete {brand.name}</h3>
              <ul className="list-disc space-y-1.5 pl-5 text-sm text-muted">
                <li><strong className="text-paper">Series.</strong> {d.series_count === 0 ? 'This brand has no series.' : <>All of its series ({plural(d.series_count, 'series', 'series')}, {plural(d.published_release_count, 'published release')}) are removed from the store, search and your brand page, and direct links stop working.</>}</li>
                <li><strong className="text-paper">Readers.</strong> {d.owned_copies === 0 ? 'Nobody owns a release from this brand yet, so no reader loses anything.' : <>Readers hold {plural(d.owned_copies, 'bought or redeemed copy', 'bought or redeemed copies')} of your releases. Those releases disappear from their libraries and can no longer be read or downloaded. Readers are not refunded and are not told automatically.</>}</li>
                <li><strong className="text-paper">Earnings owed.</strong> A brand cannot be deleted while it is owed money. {d.balance_cents > 0 || d.open_payouts > 0 ? <>Right now the balance is {moneyExact(d.balance_cents, currency)}{d.open_payouts > 0 ? <> and {plural(d.open_payouts, 'payout')} ({moneyExact(d.open_payout_cents, currency)}) {d.open_payouts === 1 ? 'is' : 'are'} still being processed</> : null}.</> : 'Nothing is owed at the moment: the balance is zero and no payout is in progress.'} The record of past earnings and payouts is kept.</li>
                <li><strong className="text-paper">Codes.</strong> {d.usable_codes === 0 ? 'This brand has no unused codes.' : <>{plural(d.usable_codes, 'unused code')} {d.usable_codes === 1 ? 'stops' : 'stop'} working: codes that unlock your releases have nothing left to unlock, and discount codes no longer apply to anything.</>} Releases already unlocked with a code are removed from libraries like any other copy.</li>
                <li><strong className="text-paper">Team and address.</strong> Everyone on the team loses access to this brand in the Studio. The address /{brand.slug} is not freed for another brand.</li>
              </ul>
            </div>
            {d.blockers.length > 0 ? (
              <Notice tone="warn" action={<Link className="link" to={`/studio/${brand.slug}/earnings`}>Open earnings</Link>}>
                <strong>This brand cannot be deleted yet.</strong> {d.blockers.join(' ')}
              </Notice>
            ) : (
              <form className="space-y-3" onSubmit={(e: FormEvent) => { e.preventDefault(); if (matches) del.mutate(); }}>
                <Field label={<>Type the brand name, <strong>{brand.name}</strong>, to confirm</>} className="max-w-md">
                  <Input value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" spellCheck={false} />
                </Field>
                <Button type="submit" variant="danger" icon={<Trash2 className="size-4" />} disabled={!matches} loading={del.isPending}>Delete {brand.name} for good</Button>
              </form>
            )}
          </div>
        )}
      </Q>
    </Section>
  );
}

export function SettingsPage() {
  const { brand, role } = useBrand();
  const { section = 'identity' } = useParams();
  const base = `/studio/${brand.slug}/settings`;
  const pages: Record<string, () => React.ReactNode> = { identity: () => <Identity />, social: () => <Social />, tips: () => <Tips />, payouts: () => <Payouts />, team: () => <Team />, conventions: () => <Conventions />, delete: () => <DeleteBrand /> };
  return (
    <BrandPage title="Settings">
      <div className="grid gap-5 md:grid-cols-[200px_minmax(0,1fr)]">
        <SideNav groups={[
          { title: 'Brand', items: [{ to: base, label: 'Identity', icon: <IdCard />, end: true }, { to: `${base}/social`, label: 'Social links', icon: <Share2 /> }, { to: `${base}/conventions`, label: 'Conventions', icon: <CalendarDays /> }] },
          { title: 'Money', items: [{ to: `${base}/tips`, label: 'Tips', icon: <Coins /> }, { to: `${base}/payouts`, label: 'Payouts', icon: <Landmark /> }, ...(can(role, 'admin') ? [{ to: `/studio/${brand.slug}/tax`, label: 'Tax information', icon: <FileText /> }] : [])] },
          { title: 'People', items: [{ to: `${base}/team`, label: 'Team', icon: <UsersRound /> }] },
          ...(role === 'owner' ? [{ title: 'Danger zone', items: [{ to: `${base}/delete`, label: 'Delete brand', icon: <Trash2 /> }] }] : []),
        ]} />
        <div className="min-w-0 space-y-5">
          {!can(role, 'admin') && ['identity', 'social', 'tips'].includes(section) && <Notice tone="info">Brand settings can be changed by admins and owners. You can view them.</Notice>}
          {(pages[section] ?? pages.identity)()}
        </div>
      </div>
    </BrandPage>
  );
}
