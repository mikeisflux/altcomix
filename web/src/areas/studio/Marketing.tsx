import { useQuery } from '@tanstack/react-query';
import { Eye, Megaphone, Send } from 'lucide-react';
import { useState } from 'react';
import { api } from '@/lib/api';
import { dateTime, number, percent, plural } from '@/lib/format';
import { useSession } from '@/lib/session';
import { Button, EmptyState, Field, Input, Modal, Notice, Select, Stat, Table, Textarea, toast, useConfirm } from '@/ui';
import { BrandPage, Q, RoleNotice, Section, can, useAct, useBrand } from './shared';

type Sent = {
  id: string; subject: string; body: string; recipients: number; created_at: string; sent_by: string | null; series_id: string | null; series_title: string | null;
  queued: number; sent: number; opened: number; clicked: number; failed: number;
};
type Overview = {
  audience: { followers: number; emailable: number };
  limit: { per_week: number; used: number; remaining: number; next_available_at: string | null };
  announcements: Sent[];
  series: { id: string; title: string }[];
  limits: { subject_max: number; body_max: number };
};
type Preview = { subject: string; html: string; audience: Overview['audience'] };

function Body() {
  const { brand } = useBrand();
  const { user } = useSession();
  const confirm = useConfirm();
  const base = `/api/studio/brands/${brand.id}/announcements`;
  const key = ['studio', 'announcements', brand.id];
  const overview = useQuery({ queryKey: key, queryFn: () => api<Overview>(base), refetchInterval: (q) => (q.state.data?.announcements.some((a) => a.queued > 0) ? 5000 : false) });
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [seriesId, setSeriesId] = useState('');
  const [preview, setPreview] = useState<Preview | null>(null);
  const [reading, setReading] = useState<Sent | null>(null);
  const draft = { subject, body, series_id: seriesId || null };
  const ready = subject.trim().length >= 3 && body.trim().length >= 10;

  const show = useAct(() => api<Preview>(`${base}/preview`, { json: draft }), { onDone: (r) => setPreview(r) });
  const test = useAct(() => api<{ to: string }>(`${base}/test`, { json: draft }), { success: (r) => `Test sent to ${r.to}. It arrives with [Test] in the subject.` });
  const send = useAct(() => api<{ queued: number }>(base, { json: draft }), {
    success: (r) => `Announcement on its way to ${plural(r.queued, 'follower')}`,
    invalidate: [key, ['studio', 'analytics']],
    onDone: () => { setSubject(''); setBody(''); setSeriesId(''); setPreview(null); },
  });

  return (
    <Q query={overview}>
      {(d) => {
        const out = d.limit.remaining === 0;
        const nobody = d.audience.emailable === 0;
        const confirmSend = async () => {
          const ok = await confirm({
            title: `Email ${plural(d.audience.emailable, 'follower')}?`,
            body: `“${subject.trim()}” goes out straight away and cannot be recalled. This uses 1 of your ${d.limit.remaining} remaining ${d.limit.remaining === 1 ? 'announcement' : 'announcements'} this week.`,
            confirmLabel: 'Send announcement',
          });
          if (ok) send.mutate();
        };
        return (
          <div className="space-y-5">
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
              <Stat label="Followers" value={number(d.audience.followers)} hint="People following the brand or any of its series" />
              <Stat label="Will receive email" value={number(d.audience.emailable)} hint={d.audience.followers > d.audience.emailable ? `${number(d.audience.followers - d.audience.emailable)} turned these emails off` : 'Everyone who follows you'} />
              <Stat label="Left this week" value={`${d.limit.remaining} of ${d.limit.per_week}`} hint={out && d.limit.next_available_at ? `Next one from ${dateTime(d.limit.next_available_at)}` : 'Counted over any 7 days'} />
            </div>

            <Section
              title="Write an announcement"
              description={`An email to everyone who follows ${brand.name} or one of its series. Each person gets it once, however many of your series they follow, and people who turned off new-release emails or unsubscribed are left out. A brand can send ${d.limit.per_week} announcements in any 7 days.`}
            >
              {out && <Notice tone="warn">You have sent {d.limit.per_week} announcements in the last 7 days, which is the limit.{d.limit.next_available_at ? ` You can send the next one from ${dateTime(d.limit.next_available_at)}.` : ''} You can still write, preview and test.</Notice>}
              {!out && nobody && <Notice tone="info">{d.audience.followers === 0 ? 'Nobody follows this brand or its series yet, so there is nobody to email. You can still write, preview and send yourself a test.' : 'All of your followers have turned these emails off, so there is nobody to email right now.'}</Notice>}
              <Field label="Subject" hint={`${subject.length} of ${d.limits.subject_max} characters`}>
                <Input value={subject} maxLength={d.limits.subject_max} onChange={(e) => setSubject(e.target.value)} placeholder="Volume 2 is out on Friday" />
              </Field>
              <Field label="Message" hint="Plain text. Leave an empty line between paragraphs. The email is signed with your brand name and carries an unsubscribe link.">
                <Textarea value={body} maxLength={d.limits.body_max} className="min-h-44" onChange={(e) => setBody(e.target.value)} />
              </Field>
              <Field label="Button under the message" optional hint="Adds a button that opens one of your series." className="max-w-md">
                <Select value={seriesId} onChange={(e) => setSeriesId(e.target.value)}>
                  <option value="">No button</option>
                  {d.series.map((s) => <option key={s.id} value={s.id}>Open {s.title}</option>)}
                </Select>
              </Field>
              <div className="flex flex-wrap gap-2">
                <Button variant="primary" icon={<Send className="size-4" />} disabled={!ready || out || nobody} loading={send.isPending} onClick={confirmSend}>Send to {plural(d.audience.emailable, 'follower')}</Button>
                <Button icon={<Eye className="size-4" />} disabled={!ready} loading={show.isPending} onClick={() => show.mutate()}>Preview</Button>
                <Button variant="ghost" disabled={!ready} loading={test.isPending} onClick={() => test.mutate()}>Send a test to {user?.email}</Button>
              </div>
              {!ready && (subject || body) && <p className="text-xs text-faint">Write a subject of at least 3 characters and a message of at least 10 to preview or send.</p>}
            </Section>

            <Section title="Sent announcements" description="Opens and clicks are reported by the email provider and keep arriving for a few days after sending.">
              {d.announcements.length === 0 ? (
                <EmptyState icon={<Megaphone />} title="No announcements yet">When you send one it is listed here with how many people it reached, opened it and clicked.</EmptyState>
              ) : (
                <Table rows={d.announcements} rowKey={(a) => a.id} onRowClick={setReading} columns={[
                  { key: 's', header: 'Announcement', cell: (a) => <div className="min-w-40"><div className="font-medium">{a.subject}</div><div className="text-xs text-muted">{dateTime(a.created_at)}{a.sent_by ? ` · by ${a.sent_by}` : ''}</div></div> },
                  { key: 'r', header: 'Recipients', align: 'right', cell: (a) => number(a.recipients), hideOnMobile: true },
                  { key: 'd', header: 'Sent', align: 'right', cell: (a) => <span>{number(a.sent)}{a.queued > 0 && <span className="block text-xs text-muted">{number(a.queued)} sending</span>}{a.failed > 0 && <span className="block text-xs text-muted">{number(a.failed)} not delivered</span>}</span> },
                  { key: 'o', header: 'Opened', align: 'right', cell: (a) => <span>{number(a.opened)}{a.sent > 0 && <span className="block text-xs text-muted">{percent(a.opened / a.sent)}</span>}</span> },
                  { key: 'c', header: 'Clicked', align: 'right', cell: (a) => <span>{number(a.clicked)}{a.sent > 0 && <span className="block text-xs text-muted">{percent(a.clicked / a.sent)}</span>}</span> },
                ]} />
              )}
            </Section>

            <Modal open={Boolean(preview)} onClose={() => setPreview(null)} size="lg" title="Preview" footer={<><Button variant="ghost" onClick={() => setPreview(null)}>Keep editing</Button><Button variant="primary" icon={<Send className="size-4" />} disabled={out || nobody} loading={send.isPending} onClick={confirmSend}>Send to {plural(d.audience.emailable, 'follower')}</Button></>}>
              {preview && (
                <div className="space-y-3">
                  <p className="text-sm"><span className="text-muted">Subject:</span> <strong>{preview.subject}</strong></p>
                  {/* The email is a complete HTML document; a sandboxed frame shows it exactly as sent, with scripts and navigation off. */}
                  <iframe title="Email preview" sandbox="" srcDoc={preview.html} className="h-[55dvh] w-full rounded-xl border border-line bg-paper" />
                  <p className="text-xs text-faint">Each follower gets their own unsubscribe link; the one in this preview is yours.</p>
                </div>
              )}
            </Modal>

            <Modal open={Boolean(reading)} onClose={() => setReading(null)} title={reading?.subject ?? ''}>
              {reading && (
                <div className="space-y-3 text-sm">
                  <p className="text-muted">Sent {dateTime(reading.created_at)}{reading.sent_by ? ` by ${reading.sent_by}` : ''} to {plural(reading.recipients, 'follower')}{reading.series_title ? `, with a button to ${reading.series_title}` : ''}.</p>
                  <p className="whitespace-pre-wrap">{reading.body}</p>
                  <Button size="sm" onClick={() => { setSubject(reading.subject); setBody(reading.body); setSeriesId(reading.series_id && d.series.some((s) => s.id === reading.series_id) ? reading.series_id : ''); setReading(null); toast.success('Copied into the editor'); }}>Use as a starting point</Button>
                </div>
              )}
            </Modal>
          </div>
        );
      }}
    </Q>
  );
}

export function MarketingPage() {
  const { role } = useBrand();
  return <BrandPage title="Marketing">{can(role, 'admin') ? <Body /> : <RoleNotice need="admin" />}</BrandPage>;
}
