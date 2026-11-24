import { useQuery } from '@tanstack/react-query';
import { ExternalLink, Megaphone, Plus, Trash2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import type { FormEvent } from 'react';
import { useNavigate } from 'react-router';
import { api } from '@/lib/api';
import { date, money } from '@/lib/format';
import { languageLabel, useSession } from '@/lib/session';
import { Avatar, Badge, Button, Field, FormRow, IconButton, Input, MoneyInput, Notice, Segmented, Select, Switch, Textarea, useConfirm } from '@/ui';
import { ContributorsEditor } from './Contributors';
import { SaveBar } from './SeriesDetails';
import { seriesKey, useSeries } from './SeriesEditor';
import type { Crowdfunding, Series } from './SeriesEditor';
import { CopyButton, Section, TIMEZONES, bps, can, cap, changed, fromLocalInput, toLocalInput, useAct, useDraft, Group } from './shared';

type Basic = Pick<Series, 'type' | 'layout' | 'language' | 'website' | 'pub_year' | 'status' | 'reading_dir' | 'visibility'>;

function Settings() {
  const { series, role, brand } = useSeries();
  const { meta } = useSession();
  const server = useMemo<Basic>(() => ({ type: series.type, layout: series.layout, language: series.language, website: series.website, pub_year: series.pub_year, status: series.status, reading_dir: series.reading_dir, visibility: series.visibility }), [series]);
  const [d, set, dirty, reset] = useDraft(server);
  const editable = can(role, 'editor');
  const save = useAct(() => api(`/api/studio/series/${series.id}`, { method: 'PATCH', json: { ...changed(server, d), ...(d.website !== server.website ? { website: d.website ?? '' } : {}) } }), { success: 'Series settings saved', invalidate: [seriesKey(series.id), ['studio', 'series-list', brand.id]] });
  return (
    <Section id="settings" title="Series settings">
      <fieldset disabled={!editable} className="space-y-4">
        <FormRow cols={3}>
          <Field label="Type"><Select value={d.type} onChange={(e) => set({ type: e.target.value })}>{meta.seriesTypes.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}</Select></Field>
          <Field label="Original language"><Select value={d.language} onChange={(e) => set({ language: e.target.value })}>{meta.languages.map((l) => <option key={l.code} value={l.code}>{l.label}</option>)}</Select></Field>
          <Field label="Status"><Select value={d.status} onChange={(e) => set({ status: e.target.value })}>{meta.seriesStatuses.map((s) => <option key={s} value={s}>{cap(s)}</option>)}</Select></Field>
        </FormRow>
        <Group label="Page layout" hint={d.layout === 'paged' ? 'Separate pages, read one or two at a time, or frame by frame on phones.' : 'One long strip per episode, read by scrolling.'}>
          <Segmented value={d.layout} onChange={(v) => set({ layout: v })} options={[{ value: 'paged', label: 'Print layout' }, { value: 'vertical', label: 'Vertical scroll' }]} />
        </Group>
        <Group label="Reading direction" hint={d.reading_dir === 'ltr' ? 'Pages and frames run left to right.' : 'Pages and frames run right to left, as in manga. Frame detection orders panels the same way.'}>
          <Segmented value={d.reading_dir} onChange={(v) => set({ reading_dir: v })} options={[{ value: 'ltr', label: 'Left to right' }, { value: 'rtl', label: 'Right to left' }]} />
        </Group>
        <Group label="Listing" hint={d.visibility === 'public' ? 'Shown in the store and search once a release is published.' : d.visibility === 'unlisted' ? 'Not shown in the store or search. Anyone with the link can open it.' : 'Only your team can see the series.'}>
          <Segmented value={d.visibility} onChange={(v) => set({ visibility: v })} options={[{ value: 'public', label: 'Public' }, { value: 'unlisted', label: 'Unlisted' }, { value: 'draft', label: 'Draft' }]} />
        </Group>
        <FormRow>
          <Field label="Official website" optional><Input type="url" placeholder="https://" value={d.website ?? ''} onChange={(e) => set({ website: e.target.value || null })} /></Field>
          <Field label="Original publishing year" optional><Input type="number" min={1800} max={new Date().getFullYear() + 2} value={d.pub_year ?? ''} onChange={(e) => set({ pub_year: e.target.value ? Number(e.target.value) : null })} /></Field>
        </FormRow>
      </fieldset>
      <SaveBar dirty={dirty} saving={save.isPending} onSave={() => save.mutate()} onReset={reset} />
    </Section>
  );
}

function Editions() {
  const { series, detail, role } = useSeries();
  const { meta } = useSession();
  const editable = can(role, 'editor');
  const [lang, setLang] = useState('');
  const inv = [seriesKey(series.id)];
  const add = useAct(() => api(`/api/studio/series/${series.id}/editions/${lang}`, { method: 'PUT', json: { title: series.title, description: series.description } }), { success: 'Language edition added', invalidate: inv, onDone: () => setLang('') });
  const access = useAct((v: { language: string; title: string; access_model: string | null }) => api(`/api/studio/series/${series.id}/editions/${v.language}`, { method: 'PUT', json: { title: v.title, access_model: v.access_model } }), { success: 'Edition access updated', invalidate: inv });
  const remove = useAct((l: string) => api(`/api/studio/series/${series.id}/editions/${l}`, { method: 'DELETE' }), { success: 'Language edition removed', invalidate: inv });
  const available = meta.languages.filter((l) => !detail.languages.some((x) => x.code === l.code));
  return (
    <Section id="languages" title="Language editions" description="A translated edition has its own releases, title and description. Edit translated titles on the Details tab.">
      <ul className="divide-y divide-line rounded-xl border border-line">
        {detail.languages.map((l) => {
          const e = detail.editions.find((x) => x.language === l.code);
          return (
            <li key={l.code} className="flex flex-wrap items-center gap-3 px-3 py-2 text-sm">
              <span className="min-w-28 flex-1 font-medium">{languageLabel(meta, l.code)} {l.primary && <Badge>Original</Badge>}</span>
              <span className="text-muted">{l.releases} {l.releases === 1 ? 'release' : 'releases'}</span>
              {e && (
                <select aria-label={`Access for the ${languageLabel(meta, l.code)} edition`} disabled={!editable} className="h-9 rounded-md border border-line bg-ink px-2 text-sm" value={e.access_model ?? ''} onChange={(ev) => access.mutate({ language: l.code, title: e.title, access_model: ev.target.value || null })}>
                  <option value="">Same access as the series</option><option value="free">Free</option><option value="premium">Premium</option><option value="blocked">Blocked</option>
                </select>
              )}
              {e && editable && <IconButton label={`Remove the ${languageLabel(meta, l.code)} edition`} disabled={l.releases > 0} title={l.releases > 0 ? 'Delete its releases first' : undefined} onClick={() => remove.mutate(l.code)}><Trash2 className="size-4" /></IconButton>}
            </li>
          );
        })}
      </ul>
      {editable && available.length > 0 && (
        <form className="flex flex-wrap items-end gap-3" onSubmit={(e: FormEvent) => { e.preventDefault(); add.mutate(); }}>
          <Field label="Add a language" className="w-56"><Select value={lang} onChange={(e) => setLang(e.target.value)}><option value="">Choose a language</option>{available.map((l) => <option key={l.code} value={l.code}>{l.label}</option>)}</Select></Field>
          <Button type="submit" disabled={!lang} loading={add.isPending} icon={<Plus className="size-4" />}>Add edition</Button>
        </form>
      )}
    </Section>
  );
}

const EMPTY_CF: Crowdfunding = { enabled: false, service: 'IndieCrowdfund', goal_cents: null, url: null, timezone: null, starts_at: null, ends_at: null };

export function CrowdfundingBanner({ cf, currency }: { cf: Crowdfunding; currency: string }) {
  const now = Date.now();
  const start = cf.starts_at ? Date.parse(cf.starts_at) : null;
  const end = cf.ends_at ? Date.parse(cf.ends_at) : null;
  const days = (ms: number) => Math.max(1, Math.ceil(ms / 86_400_000));
  const state = start && start > now ? `Launches in ${days(start - now)} ${days(start - now) === 1 ? 'day' : 'days'}` : end && end < now ? 'Campaign ended' : end ? `${days(end - now)} ${days(end - now) === 1 ? 'day' : 'days'} left` : 'Funding now';
  const zone = cf.timezone ?? undefined;
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-xl border border-sun/40 bg-raised px-4 py-3">
      <Megaphone className="size-5 shrink-0 text-sun" aria-hidden />
      <div className="min-w-0 flex-1">
        <div className="text-sm font-semibold">{start && start > now ? 'Coming soon to' : end && end < now ? 'Funded on' : 'Now funding on'} {cf.service === 'Other' ? 'crowdfunding' : cf.service}</div>
        <div className="text-xs text-muted">
          {state}{cf.goal_cents ? ` · Goal ${money(cf.goal_cents, currency)}` : ''}
          {end && end >= now ? ` · Ends ${date(cf.ends_at, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: zone, timeZoneName: 'short' })}` : ''}
        </div>
      </div>
      <span className="inline-flex h-8 items-center gap-1.5 rounded-md bg-sun px-3 text-[13px] font-semibold text-sun-ink">Back this project <ExternalLink className="size-3.5" /></span>
    </div>
  );
}

function CrowdfundingSettings() {
  const { series, role } = useSeries();
  const { meta, currency } = useSession();
  const server = useMemo(() => series.crowdfunding ?? EMPTY_CF, [series.crowdfunding]);
  const [d, set, dirty, reset] = useDraft(server);
  const editable = can(role, 'editor');
  const save = useAct(() => api(`/api/studio/series/${series.id}`, { method: 'PATCH', json: { crowdfunding: { ...d, url: d.url ?? '' } } }), { success: 'Crowdfunding banner saved', invalidate: [seriesKey(series.id)] });
  return (
    <Section id="crowdfunding" title="Crowdfunding banner" description="Point readers to your campaign. The banner shows on the series page and after the last page in the reader.">
      <Switch checked={d.enabled} onChange={(v) => set({ enabled: v })} disabled={!editable} label="Show the banner" description="Needs a campaign link." />
      <fieldset disabled={!editable} className="space-y-4">
        <FormRow>
          <Field label="Service"><Select value={d.service} onChange={(e) => set({ service: e.target.value })}>{meta.crowdfundingServices.map((s) => <option key={s}>{s}</option>)}</Select></Field>
          <Field label="Funding goal" optional><MoneyInput cents={d.goal_cents} onChange={(c) => set({ goal_cents: c })} /></Field>
        </FormRow>
        <Field label="Campaign link"><Input type="url" placeholder="https://" value={d.url ?? ''} onChange={(e) => set({ url: e.target.value || null })} /></Field>
        <FormRow cols={3}>
          <Field label="Starts" optional><Input type="datetime-local" value={toLocalInput(d.starts_at)} onChange={(e) => set({ starts_at: fromLocalInput(e.target.value) })} /></Field>
          <Field label="Ends" optional><Input type="datetime-local" value={toLocalInput(d.ends_at)} onChange={(e) => set({ ends_at: fromLocalInput(e.target.value) })} /></Field>
          <Field label="Show times in" hint="Enter the times above in your own timezone."><Select value={d.timezone ?? ''} onChange={(e) => set({ timezone: e.target.value || null })}><option value="">Each reader's timezone</option>{TIMEZONES.map((z) => <option key={z}>{z}</option>)}</Select></Field>
        </FormRow>
      </fieldset>
      <div>
        <div className="mb-1.5 text-[13px] font-medium">Preview</div>
        {d.url ? <CrowdfundingBanner cf={d} currency={currency} /> : <p className="text-sm text-muted">Add the campaign link to see the banner.</p>}
        {!d.enabled && d.url && <p className="mt-1.5 text-xs text-faint">The banner is switched off, so readers do not see this yet.</p>}
      </div>
      <SaveBar dirty={dirty} saving={save.isPending} onSave={() => save.mutate()} onReset={reset} />
    </Section>
  );
}

function Forum() {
  const { series, detail, role } = useSeries();
  const server = useMemo(() => ({ forum_enabled: series.forum_enabled, forum_description: series.forum_description }), [series]);
  const [d, set, dirty, reset] = useDraft(server);
  const [username, setUsername] = useState('');
  const editable = can(role, 'editor');
  const inv = [seriesKey(series.id)];
  const save = useAct(() => api(`/api/studio/series/${series.id}`, { method: 'PATCH', json: changed(server, d) }), { success: 'Forum settings saved', invalidate: inv });
  const add = useAct(() => api(`/api/studio/series/${series.id}/moderators`, { json: { username } }), { success: 'Moderator added', invalidate: inv, onDone: () => setUsername('') });
  const remove = useAct((id: string) => api(`/api/studio/series/${series.id}/moderators/${id}`, { method: 'DELETE' }), { success: 'Moderator removed', invalidate: inv });
  return (
    <Section id="forum" title="Forum" description="A discussion board for this series. Brand owners always moderate it.">
      <Switch checked={d.forum_enabled} onChange={(v) => set({ forum_enabled: v })} disabled={!editable} label="Enable the forum" />
      <Field label="Forum description" optional><Textarea disabled={!editable} value={d.forum_description} maxLength={400} className="min-h-20" onChange={(e) => set({ forum_description: e.target.value })} /></Field>
      <div>
        <div className="mb-1.5 text-[13px] font-medium">Moderators</div>
        <ul className="divide-y divide-line rounded-xl border border-line">
          {detail.moderators.map((m) => (
            <li key={`${m.source}-${m.user_id}`} className="flex items-center gap-3 px-3 py-2 text-sm">
              <Avatar src={m.avatar_url} name={m.display_name || m.username} size={28} />
              <span className="min-w-0 flex-1 truncate">{m.display_name || m.username} <span className="text-muted">@{m.username}</span></span>
              {m.source === 'owner' ? <Badge>Owner</Badge> : <span className="text-xs text-muted">Added {date(m.created_at)}</span>}
              {m.source === 'moderator' && editable && <IconButton label={`Remove moderator ${m.username}`} onClick={() => remove.mutate(m.user_id)}><Trash2 className="size-4" /></IconButton>}
            </li>
          ))}
        </ul>
      </div>
      {editable && (
        <form className="flex flex-wrap items-end gap-3" onSubmit={(e: FormEvent) => { e.preventDefault(); add.mutate(); }}>
          <Field label="Add a moderator by username" className="w-64"><Input value={username} onChange={(e) => setUsername(e.target.value)} placeholder="@username" maxLength={25} required /></Field>
          <Button type="submit" loading={add.isPending} icon={<Plus className="size-4" />}>Add moderator</Button>
        </form>
      )}
      <SaveBar dirty={dirty} saving={save.isPending} onSave={() => save.mutate()} onReset={reset} />
    </Section>
  );
}

function Splits() {
  const { series, detail, brand } = useSeries();
  const [slug, setSlug] = useState('');
  const [pct, setPct] = useState('');
  const [note, setNote] = useState('');
  const inv = [seriesKey(series.id)];
  const add = useAct(() => api(`/api/studio/series/${series.id}/splits`, { json: { payee_slug: slug.trim().replace(/^\//, ''), share_bps: Math.round(Number(pct) * 100), note } }), { success: 'Split added', invalidate: inv, onDone: () => { setSlug(''); setPct(''); setNote(''); } });
  const remove = useAct((id: string) => api(`/api/studio/series/${series.id}/splits/${id}`, { method: 'DELETE' }), { success: 'Split removed', invalidate: inv });
  const total = detail.splits.reduce((n, s) => n + s.share_bps, 0);
  return (
    <Section id="splits" title="Revenue splits" description="Share this series' earnings with collaborators. Each one is paid automatically into their own brand's balance; you never have to forward money.">
      <ul className="divide-y divide-line rounded-xl border border-line text-sm">
        <li className="flex items-center justify-between gap-3 px-3 py-2"><span className="font-medium">{brand.name} <span className="font-normal text-muted">keeps</span></span><span className="tabular-nums">{bps(10000 - total)}</span></li>
        {detail.splits.map((s) => (
          <li key={s.id} className="flex items-center gap-3 px-3 py-2">
            <span className="min-w-0 flex-1 truncate"><span className="font-medium">{s.payee_name}</span> <span className="text-muted">/{s.payee_slug}{s.note ? ` · ${s.note}` : ''}</span></span>
            <span className="tabular-nums">{bps(s.share_bps)}</span>
            <IconButton label={`Remove split for ${s.payee_name}`} onClick={() => remove.mutate(s.id)}><Trash2 className="size-4" /></IconButton>
          </li>
        ))}
      </ul>
      <form className="grid items-end gap-3 sm:grid-cols-[1fr_110px_1fr_auto]" onSubmit={(e: FormEvent) => { e.preventDefault(); add.mutate(); }}>
        <Field label="Collaborator's brand address" hint="The part after the slash on their brand page."><Input value={slug} onChange={(e) => setSlug(e.target.value)} placeholder="their-brand" required /></Field>
        <Field label="Share %"><Input type="number" min={0.01} max={100} step="0.01" value={pct} onChange={(e) => setPct(e.target.value)} required /></Field>
        <Field label="Note" optional><Input value={note} onChange={(e) => setNote(e.target.value)} maxLength={200} placeholder="Colorist" /></Field>
        <Button type="submit" loading={add.isPending} icon={<Plus className="size-4" />}>Add split</Button>
      </form>
    </Section>
  );
}

type Widget = { color: string; size: 'small' | 'medium' | 'large'; sizes: Record<string, { width: number; height: number }>; read_now: { url: string; width: number; height: number; html: string }; series_url: string };

function Embed() {
  const { series } = useSeries();
  const [color, setColor] = useState('#ff2e88');
  const [size, setSize] = useState<'small' | 'medium' | 'large'>('medium');
  const [kind, setKind] = useState<'button' | 'card'>('button');
  const [theme, setTheme] = useState<'light' | 'dark'>('dark');
  const w = useQuery({ queryKey: ['studio', 'widget', series.id, color, size], queryFn: () => api<Widget>(`/api/studio/series/${series.id}/widget`, { query: { color: color.replace('#', ''), size } }), placeholderData: (p) => p });
  // The preview is served by this site, whatever address the embed code points at.
  const local = (url: string) => { const u = new URL(url); return u.pathname + u.search; };
  const cardUrl = w.data ? `${new URL(w.data.read_now.url).origin}/widgets/card/${series.slug}?color=${color.replace('#', '')}&theme=${theme}` : '';
  const cardHtml = `<iframe src="${cardUrl}" width="360" height="170" title="${series.title.replace(/"/g, '&quot;').replace(/</g, '&lt;')} on AltComix" style="border:0;overflow:hidden" scrolling="no" loading="lazy"></iframe>`;
  const html = kind === 'button' ? w.data?.read_now.html ?? '' : cardHtml;
  return (
    <Section id="embed" title="Embed on your website" description="A Read now button or a cover card for your own site. Paste the code where you want it to appear.">
      <div className="flex flex-wrap items-end gap-4">
        <Group label="Widget"><Segmented value={kind} onChange={setKind} options={[{ value: 'button', label: 'Read now button' }, { value: 'card', label: 'Cover card' }]} /></Group>
        <Field label="Button colour"><span className="flex h-10 items-center gap-2"><input type="color" value={color} onChange={(e) => setColor(e.target.value)} className="size-9 cursor-pointer rounded border border-line" /><span className="font-mono text-xs uppercase text-muted">{color}</span></span></Field>
        {kind === 'button' ? <Group label="Size"><Segmented value={size} onChange={setSize} options={[{ value: 'small', label: 'Small' }, { value: 'medium', label: 'Medium' }, { value: 'large', label: 'Large' }]} /></Group> : <Group label="Card style"><Segmented value={theme} onChange={setTheme} options={[{ value: 'dark', label: 'Dark' }, { value: 'light', label: 'Light' }]} /></Group>}
      </div>
      {w.data && (
        <>
          <div>
            <div className="mb-1.5 text-[13px] font-medium">Live preview</div>
            <div className="flex min-h-24 items-center justify-center overflow-x-auto rounded-xl border border-line bg-paper/90 p-4">
              {kind === 'button' ? <iframe key={w.data.read_now.url} src={local(w.data.read_now.url)} width={w.data.read_now.width} height={w.data.read_now.height} title="Read now button preview" style={{ border: 0, colorScheme: 'light' }} /> : <iframe key={cardUrl} src={local(cardUrl)} width={360} height={170} title="Cover card preview" style={{ border: 0, maxWidth: '100%', colorScheme: 'light' }} />}
            </div>
            {series.visibility === 'draft' && <p className="mt-1.5 text-xs text-warn">This series is a draft, so the widget shows “not available” until you list it as public or unlisted.</p>}
          </div>
          <div>
            <div className="mb-1.5 flex items-center justify-between gap-2"><span className="text-[13px] font-medium">Embed code</span><CopyButton text={html} label="Copy code" /></div>
            <pre className="overflow-x-auto whitespace-pre-wrap break-all rounded-xl border border-line bg-ink p-3 font-mono text-xs text-muted">{html}</pre>
          </div>
        </>
      )}
    </Section>
  );
}

function Danger() {
  const { series, brand } = useSeries();
  const confirm = useConfirm();
  const nav = useNavigate();
  const del = useAct(() => api(`/api/studio/series/${series.id}`, { method: 'DELETE' }), { success: 'Series deleted', invalidate: [['studio', 'series-list', brand.id], ['studio', 'brands']], onDone: () => nav(`/studio/${brand.slug}`) });
  return (
    <Section id="delete" title="Delete series" description="Removes the series and all of its releases from the store and from readers' libraries. Earnings already recorded are kept.">
      <Button variant="danger" loading={del.isPending} icon={<Trash2 className="size-4" />} onClick={async () => (await confirm({ title: `Delete “${series.title}”?`, body: 'Readers will no longer be able to open it, including people who bought it. This cannot be undone from the Studio.', confirmLabel: 'Delete series', danger: true })) && del.mutate()}>Delete this series</Button>
    </Section>
  );
}

export function SeriesAdvanced() {
  const { series, detail, role } = useSeries();
  const admin = can(role, 'admin');
  const links = [['settings', 'Settings'], ['contributors', 'Contributors'], ['languages', 'Languages'], ['crowdfunding', 'Crowdfunding'], ['forum', 'Forum'], ...(admin ? [['splits', 'Revenue splits']] : []), ['embed', 'Embed'], ...(admin ? [['delete', 'Delete']] : [])];
  return (
    <div className="grid gap-5 lg:grid-cols-[180px_minmax(0,1fr)]">
      <nav aria-label="Advanced sections" className="no-scrollbar -mx-4 flex gap-1 overflow-x-auto px-4 lg:sticky lg:top-20 lg:mx-0 lg:block lg:space-y-0.5 lg:self-start lg:px-0">
        {links.map(([id, label]) => <a key={id} href={`#${id}`} className="block whitespace-nowrap rounded-lg px-2.5 py-2 text-sm text-muted hover:bg-hover hover:text-paper">{label}</a>)}
      </nav>
      <div className="min-w-0 space-y-5 [&>section]:scroll-mt-20">
        {!can(role, 'editor') && <Notice tone="info">Your role can view these settings but not change them.</Notice>}
        <Settings />
        <Section id="contributors" title="Contributors" description="People credited on the whole series. Credits for a single release are set on that release.">
          <ContributorsEditor seriesId={series.id} releaseId={null} contributors={detail.contributors.filter((c) => !c.release_id)} invalidate={[seriesKey(series.id)]} canEdit={can(role, 'editor')} />
        </Section>
        <Editions />
        <CrowdfundingSettings />
        <Forum />
        {admin && <Splits />}
        <Embed />
        {admin && <Danger />}
      </div>
    </div>
  );
}
