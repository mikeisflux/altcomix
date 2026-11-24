import { useMutation } from '@tanstack/react-query';
import { Mail, MailX, Pause, Play, RotateCcw } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { Link } from 'react-router';
import { api, errorMessage } from '@/lib/api';
import { ago, date, dateTime, number } from '@/lib/format';
import { Badge, Button, DefList, ErrorState, Field, Input, Modal, Notice, PageHeader, Segmented, Skeleton, Stat, Table, Textarea, toast, useConfirm } from '@/ui';
import type { Column } from '@/ui';
import {
  DataList, Drawer, EmailFrame, FilterBar, FilterSelect, Loaded, SearchInput, StatusBadge, useAct, useAdminQuery, useAsk, useFilters, useIsSuper, useList, useTitle,
} from './shared';
import type { R } from './shared';

const templateName = (key: string | null) => (key ? key.replace(/_/g, ' ') : 'one-off message');

// ---------------------------------------------------------------- queue and log

function EmailDrawer({ id, onClose }: { id: string; onClose: () => void }) {
  const q = useAdminQuery<{ email: R; suppression: R | null }>(`/api/admin/emails/${id}`);
  const { run, busy } = useAct();
  const confirm = useConfirm();
  const e = q.data?.email;
  return (
    <Drawer
      open
      onClose={onClose}
      title={e?.subject ?? 'Email'}
      footer={
        e && (
          <>
            {['failed', 'suppressed', 'cancelled'].includes(e.status) && (
              <Button loading={busy === 'retry'} icon={<RotateCcw className="size-4" />} onClick={() => run({ key: 'retry', fn: () => api(`/api/admin/emails/${id}/retry`, { method: 'POST' }), ok: 'Back in the queue' })}>Send again</Button>
            )}
            {e.status === 'queued' && (
              <Button variant="danger" loading={busy === 'cancel'} onClick={async () => {
                if (await confirm({ title: 'Cancel this email?', body: `It will not be sent to ${e.to_email}. You can send it again later from here.`, confirmLabel: 'Cancel email', danger: true })) void run({ key: 'cancel', fn: () => api(`/api/admin/emails/${id}/cancel`, { method: 'POST' }), ok: 'Email cancelled' });
              }}>Cancel sending</Button>
            )}
            <Button variant="ghost" onClick={onClose}>Close</Button>
          </>
        )
      }
    >
      <Loaded query={q}>
        {({ email, suppression }) => (
          <div className="space-y-5">
            {suppression && <Notice tone="warn" action={<Link className="underline" to={`/admin/email/suppressions?q=${encodeURIComponent(email.to_email)}`}>Open the list</Link>}>This address is on the suppression list ({suppression.reason}), so nothing is sent to it.</Notice>}
            {email.error && <Notice tone={email.status === 'failed' ? 'danger' : 'info'}>{email.error}</Notice>}
            <DefList
              items={[
                ['To', <>{email.to_email}{email.user_id && <> · <Link className="link" to={`/admin/users/${email.user_id}`}>@{email.username}</Link></>}</>],
                ['Status', <StatusBadge status={email.status} />],
                ['Template', <span className="capitalize">{templateName(email.template)}</span>],
                ['Kind', <span className="capitalize">{email.category}</span>],
                ['Created', dateTime(email.created_at)],
                ['Sent', email.sent_at ? `${dateTime(email.sent_at)} via ${email.provider ?? 'unknown'}` : email.status === 'queued' ? `Due ${dateTime(email.send_after)}` : 'Not sent'],
                ['Attempts', String(email.attempts)],
                ['Opened', email.opened_at ? dateTime(email.opened_at) : 'No'],
                ['Clicked', email.clicked_at ? dateTime(email.clicked_at) : 'No'],
                ...(email.publisher_name ? [['Brand', email.publisher_name] as [string, string]] : []),
              ]}
            />
            <div>
              <h3 className="mb-2 font-semibold">Message as sent</h3>
              <EmailFrame html={email.html} title={`Email: ${email.subject}`} />
              <p className="mt-1.5 text-xs text-faint">Shown in an isolated frame: scripts and links in the message cannot run here.</p>
            </div>
          </div>
        )}
      </Loaded>
    </Drawer>
  );
}

export function EmailQueuePage() {
  useTitle('Email queue & log');
  const isSuper = useIsSuper();
  const [f, setF] = useFilters({ status: '', template: '', to: '', q: '' });
  const list = useList<{ queue: R }>('/api/admin/emails', { status: f.status, template: f.template, to: f.to, q: f.q, page: f.page });
  const templates = useAdminQuery<{ items: R[] }>('/api/admin/email-templates');
  const { run, busy } = useAct();
  const confirm = useConfirm();
  const [open, setOpen] = useState<string | null>(null);
  const queue = list.data?.queue;

  const toggleQueue = async () => {
    const pause = !queue?.paused;
    if (await confirm({ title: pause ? 'Pause the email queue?' : 'Resume the email queue?', body: pause ? 'Nothing is sent until you resume, including password resets and receipts. Emails wait in the queue.' : 'Waiting emails start going out within a minute.', confirmLabel: pause ? 'Pause queue' : 'Resume queue', danger: pause })) {
      void run({ key: 'queue', fn: () => api(`/api/admin/emails/queue/${pause ? 'pause' : 'resume'}`, { method: 'POST' }), ok: pause ? 'Queue paused' : 'Queue resumed' });
    }
  };
  const retryFailed = async () => {
    if (await confirm({ title: 'Send failed emails again?', body: 'Every email that failed in the last 7 days goes back in the queue, except addresses on the suppression list.', confirmLabel: 'Send again' })) {
      void run({ key: 'retry-all', fn: () => api<R>('/api/admin/emails/retry-failed', { json: { days: 7 } }), ok: (r) => `${r.requeued} ${r.requeued === 1 ? 'email' : 'emails'} put back in the queue` });
    }
  };

  const columns: Column<R>[] = [
    { key: 'when', header: 'Created', cell: (e) => <span title={dateTime(e.created_at)}>{ago(e.created_at)}</span> },
    { key: 'to', header: 'To', cell: (e) => <span className="block max-w-[200px] truncate">{e.to_email}</span> },
    { key: 'subject', header: 'Subject', cell: (e) => <span className="block max-w-[280px] truncate">{e.subject}</span> },
    { key: 'template', header: 'Template', cell: (e) => <span className="capitalize text-muted">{templateName(e.template)}</span>, hideOnMobile: true },
    {
      key: 'status', header: 'Status',
      cell: (e) => (
        <span className="flex items-center gap-1.5" title={e.error ?? ''}>
          <StatusBadge status={e.status} />
          {e.clicked_at ? <Badge tone="accent">Clicked</Badge> : e.opened_at ? <Badge tone="accent">Opened</Badge> : null}
        </span>
      ),
    },
    { key: 'tries', header: 'Tries', align: 'right', cell: (e) => e.attempts, hideOnMobile: true },
  ];

  return (
    <>
      <PageHeader
        title="Email queue & log"
        description="Every message the site has sent or is about to send. Open one to read it exactly as the recipient got it."
        actions={
          <>
            {queue && queue.failed > 0 && <Button loading={busy === 'retry-all'} icon={<RotateCcw className="size-4" />} onClick={retryFailed}>Retry failed</Button>}
            {isSuper && queue && <Button loading={busy === 'queue'} icon={queue.paused ? <Play className="size-4" /> : <Pause className="size-4" />} variant={queue.paused ? 'primary' : 'secondary'} onClick={toggleQueue}>{queue.paused ? 'Resume queue' : 'Pause queue'}</Button>}
          </>
        }
      />
      {queue?.paused && <div className="mb-4"><Notice tone="warn">The queue is paused. {number(queue.queued)} {queue.queued === 1 ? 'email is' : 'emails are'} waiting and nothing is being sent.</Notice></div>}
      {queue?.provider === 'log' && <div className="mb-4"><Notice action={isSuper ? <Link className="underline" to="/admin/settings?tab=email">Email settings</Link> : undefined}>No email provider is connected, so messages are recorded here as sent but are not delivered to anyone.</Notice></div>}
      {queue && (
        <div className="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-5">
          <Stat label="Waiting" value={number(queue.queued)} hint={queue.oldest_due ? `Oldest has waited since ${ago(queue.oldest_due)}` : `${number(queue.due)} due now`} />
          <Stat label="Sending" value={number(queue.sending)} />
          <Stat label="Sent in 24 hours" value={number(queue.sent_24h)} hint={`${number(queue.opened_24h)} opened`} />
          <Stat label="Failed" value={number(queue.failed)} hint="In the last 30 days" />
          <Stat label="Held back in 24 hours" value={number(queue.suppressed_24h)} hint="Recipient on the suppression list" />
        </div>
      )}
      <FilterBar>
        <SearchInput value={f.to} onChange={(to) => setF({ to })} placeholder="Recipient email" />
        <SearchInput value={f.q} onChange={(q) => setF({ q })} placeholder="Subject" />
        <FilterSelect label="Status" value={f.status} onChange={(status) => setF({ status })} options={[['', 'Any status'], ['queued', 'Waiting'], ['sending', 'Sending'], ['sent', 'Sent'], ['failed', 'Failed'], ['suppressed', 'Held back'], ['cancelled', 'Cancelled']]} />
        <FilterSelect label="Template" value={f.template} onChange={(template) => setF({ template })} options={[['', 'Any template'], ...(templates.data?.items ?? []).map((t): [string, string] => [t.key, templateName(t.key)])]} />
      </FilterBar>
      <DataList
        query={list}
        columns={columns}
        onRowClick={(e) => setOpen(e.id)}
        onPage={(page) => setF({ page })}
        empty={{ icon: <Mail />, title: 'No emails match', hint: 'Emails appear here as soon as the site queues them: sign-ups, receipts, notifications. Try clearing the filters.', action: <Button onClick={() => setF({ status: '', template: '', to: '', q: '' })}>Clear filters</Button> }}
      />
      {open && <EmailDrawer id={open} onClose={() => setOpen(null)} />}
    </>
  );
}

// ---------------------------------------------------------------- templates

function TemplateEditor({ tpl, syntax, onClose }: { tpl: R; syntax: string; onClose: () => void }) {
  const isSuper = useIsSuper();
  const { run, busy } = useAct();
  const confirm = useConfirm();
  const [subject, setSubject] = useState<string>(tpl.subject);
  const [html, setHtml] = useState<string>(tpl.html);
  const [view, setView] = useState<'edit' | 'preview'>('edit');
  const preview = useMutation({ mutationFn: () => api<{ subject: string; html: string; unknown_vars: string[] }>(`/api/admin/email-templates/${tpl.key}/preview`, { json: { subject, html } }) });
  const { mutate: loadPreview } = preview;
  useEffect(() => {
    if (view === 'preview') loadPreview();
  }, [view, loadPreview]);
  const dirty = subject !== tpl.subject || html !== tpl.html;
  const save = () => run({ key: 'tpl', fn: () => api(`/api/admin/email-templates/${tpl.key}`, { method: 'PUT', json: { subject, html } }), ok: 'Template saved', onDone: onClose });
  const reset = async () => {
    if (await confirm({ title: 'Go back to the built-in wording?', body: 'Your edited subject and message for this template are discarded.', confirmLabel: 'Reset template', danger: true })) {
      void run({ key: 'reset', fn: () => api(`/api/admin/email-templates/${tpl.key}`, { method: 'DELETE' }), ok: 'Template reset to the built-in wording', onDone: onClose });
    }
  };
  const insert = (v: string) => setHtml((h) => `${h}{{${v}}}`);
  return (
    <Modal
      open
      onClose={onClose}
      size="xl"
      title={<span className="capitalize">{templateName(tpl.key)}</span>}
      footer={
        <>
          {isSuper && tpl.customised && <Button variant="danger" loading={busy === 'reset'} onClick={reset}>Reset to default</Button>}
          <Button variant="ghost" onClick={onClose}>{isSuper ? 'Cancel' : 'Close'}</Button>
          {isSuper && <Button variant="primary" loading={busy === 'tpl'} disabled={!dirty} onClick={save}>Save template</Button>}
        </>
      }
    >
      <div className="space-y-4">
        {!isSuper && <Notice>Only a super admin can change templates. You can still preview this one.</Notice>}
        <Segmented value={view} onChange={setView} options={[{ value: 'edit', label: 'Edit' }, { value: 'preview', label: 'Preview with sample values' }]} />
        {view === 'edit' ? (
          <>
            <Field label="Subject"><Input value={subject} maxLength={300} readOnly={!isSuper} onChange={(e) => setSubject(e.target.value)} /></Field>
            <Field label="Message (HTML)" hint={syntax}>
              <Textarea value={html} readOnly={!isSuper} onChange={(e) => setHtml(e.target.value)} className="min-h-[320px] font-mono text-[13px]" spellCheck={false} />
            </Field>
            <div>
              <div className="mb-1.5 text-[13px] font-medium">Values you can use</div>
              <div className="flex flex-wrap gap-1.5">
                {(tpl.vars as string[]).map((v) => (
                  <button key={v} type="button" disabled={!isSuper} onClick={() => insert(v)} title={isSuper ? 'Add to the end of the message' : undefined} className="h-8 rounded-md border border-line bg-ink px-2 font-mono text-xs hover:border-line-strong disabled:opacity-70">{`{{${v}}}`}</button>
                ))}
              </div>
            </div>
          </>
        ) : preview.isPending ? (
          <Skeleton className="h-96 w-full" />
        ) : preview.isError ? (
          <ErrorState message={errorMessage(preview.error)} retry={() => preview.mutate()} />
        ) : preview.data ? (
          <>
            {preview.data.unknown_vars.length > 0 && <Notice tone="warn">These placeholders are not available for this template and will be left empty: {preview.data.unknown_vars.map((v) => `{{${v}}}`).join(', ')}</Notice>}
            <div className="text-sm"><span className="text-muted">Subject:</span> <span className="font-medium">{preview.data.subject}</span></div>
            <EmailFrame html={preview.data.html} title="Template preview" />
          </>
        ) : null}
      </div>
    </Modal>
  );
}

export function EmailTemplatesPage() {
  useTitle('Email templates');
  const q = useAdminQuery<{ items: R[]; syntax: string }>('/api/admin/email-templates');
  const [open, setOpen] = useState<R | null>(null);
  return (
    <>
      <PageHeader title="Email templates" description="The wording of every automatic email. Edit the subject or message, preview it with sample values, or go back to the built-in version." />
      <Loaded query={q}>
        {(d) => (
          <Table
            rowKey={(t: R) => t.key}
            rows={d.items}
            onRowClick={setOpen}
            empty="No templates are defined"
            columns={[
              { key: 'name', header: 'Template', cell: (t: R) => <span className="font-medium capitalize">{templateName(t.key)}</span> },
              { key: 'subject', header: 'Subject', cell: (t: R) => <span className="block max-w-[320px] truncate text-muted">{t.subject}</span> },
              { key: 'cat', header: 'Kind', cell: (t: R) => <span className="capitalize">{t.category}</span>, hideOnMobile: true },
              { key: 'vars', header: 'Values', cell: (t: R) => <span className="block max-w-[220px] truncate font-mono text-xs text-muted">{t.vars.join(', ')}</span>, hideOnMobile: true },
              { key: 'state', header: 'Wording', cell: (t: R) => (t.customised ? <span title={t.updated_at ? `Edited ${date(t.updated_at)}${t.updated_by_username ? ` by @${t.updated_by_username}` : ''}` : ''}><Badge tone="accent">Edited</Badge></span> : <span className="text-muted">Built-in</span>) },
            ]}
          />
        )}
      </Loaded>
      {open && <TemplateEditor key={open.key} tpl={open} syntax={q.data?.syntax ?? ''} onClose={() => setOpen(null)} />}
    </>
  );
}

// ---------------------------------------------------------------- suppression list

export function SuppressionsPage() {
  useTitle('Suppression list');
  const [f, setF] = useFilters({ q: '', source: '' });
  const list = useList('/api/admin/email-suppressions', { q: f.q, source: f.source, page: f.page });
  const { run, busy } = useAct();
  const ask = useAsk();
  const confirm = useConfirm();
  const add = async (e?: FormEvent) => {
    e?.preventDefault();
    const v = await ask({
      title: 'Stop emailing an address',
      body: 'Nothing at all is sent to a suppressed address, including receipts and password resets.',
      fields: [
        { name: 'email', label: 'Email address', type: 'email', required: true },
        { name: 'reason', label: 'Reason', hint: 'For example "asked by phone to stop all email".' },
      ],
      confirmLabel: 'Add to list',
    });
    if (v) void run({ key: 'add', fn: () => api('/api/admin/email-suppressions', { json: { email: v.email, reason: v.reason } }), ok: `${v.email} will not be emailed` });
  };
  return (
    <>
      <PageHeader
        title="Suppression list"
        description="Addresses the site never emails: hard bounces, spam complaints, unsubscribes and any you add by hand. Remove one only if you are sure the address works and wants email."
        actions={<Button variant="primary" loading={busy === 'add'} onClick={() => add()}>Add an address</Button>}
      />
      <FilterBar>
        <SearchInput value={f.q} onChange={(q) => setF({ q })} placeholder="Search by email address" />
        <FilterSelect label="Added by" value={f.source} onChange={(source) => setF({ source })} options={[['', 'Any source'], ['bounce', 'Bounce'], ['complaint', 'Spam complaint'], ['unsubscribe', 'Unsubscribe'], ['manual', 'Added by an admin']]} />
      </FilterBar>
      <DataList
        query={list}
        rowKey={(r) => r.email}
        onPage={(page) => setF({ page })}
        empty={{ icon: <MailX />, title: 'No suppressed addresses', hint: 'Addresses are added automatically when mail bounces or someone reports it as spam.', action: <Button onClick={() => add()}>Add an address</Button> }}
        columns={[
          { key: 'email', header: 'Address', cell: (s) => <span className="block max-w-[260px] truncate font-medium">{s.email}</span> },
          { key: 'reason', header: 'Reason', cell: (s) => <span className="block max-w-[320px] truncate text-muted" title={s.reason}>{s.reason}</span> },
          { key: 'source', header: 'Added by', cell: (s) => <span className="capitalize">{s.source}</span> },
          { key: 'when', header: 'Added', cell: (s) => <span className="text-muted">{date(s.created_at)}</span> },
          {
            key: 'act', header: '',
            cell: (s) => (
              <Button size="sm" loading={busy === s.email} onClick={async () => {
                if (await confirm({ title: `Email ${s.email} again?`, body: 'The address leaves the suppression list and the site can send to it. If it bounces again it will be added back.', confirmLabel: 'Remove from list' })) {
                  void run({ key: s.email, fn: () => api(`/api/admin/email-suppressions/${encodeURIComponent(s.email)}`, { method: 'DELETE' }), ok: 'Removed from the suppression list' });
                }
              }}>Remove</Button>
            ),
          },
        ]}
      />
    </>
  );
}
