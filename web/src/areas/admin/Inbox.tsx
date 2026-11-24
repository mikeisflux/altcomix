import { useQueryClient } from '@tanstack/react-query';
import { Archive, ArchiveRestore, Ban, ChevronDown, ChevronRight, CornerUpLeft, Download, ImageOff, Images, MailOpen, MailPlus, Paperclip, Pencil, Plus, Send, ShieldAlert, ShieldCheck, Trash2 } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router';
import { api, errorMessage } from '@/lib/api';
import { ago, bytes, dateTime, number } from '@/lib/format';
import { Badge, Button, EmptyState, ErrorState, Field, Input, LinkButton, Modal, Notice, PageHeader, Pagination, Segmented, Select, Skeleton, Table, Tabs, Textarea, cx, toast, useConfirm } from '@/ui';
import { Drawer, FilterBar, FilterSelect, Loaded, SearchInput, Section, StatusBadge, useAct, useAdminQuery, useAsk, useFilters, useIsSuper, useList, useTitle } from './shared';
import type { R } from './shared';

type MailboxRow = { id: string; address: string; name: string; is_default: boolean; active: boolean; auto_reply: string; total: number; unread: number };
type Mailboxes = { items: MailboxRow[]; domains: string[]; inbound_enabled: boolean };
type Counts = { inbox: number; unread: number; archived: number; spam: number };
type Folder = 'inbox' | 'unread' | 'archived' | 'spam';

const who = (m: R) => m.from_name || m.from_email;

// ---------------------------------------------------------------- a stranger's HTML, kept at arm's length

/**
 * The message is already cleaned on the server. It is still drawn in a frame
 * that can run nothing and reach nothing: no scripts, no forms, no links out,
 * and its own content policy that only lets pictures load once asked for.
 */
function mailDocument(html: string, images: boolean): string {
  const body = images ? html.replaceAll(' data-remote-src="', ' src="') : html;
  const policy = `default-src 'none'; style-src 'unsafe-inline'; img-src data:${images ? ' https: http:' : ''}`;
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${policy}"><meta name="referrer" content="no-referrer"><base target="_blank">`
    + '<style>html{color-scheme:light}body{margin:12px;background:white;color:black;font:14px/1.5 system-ui,sans-serif;overflow-wrap:anywhere}img{max-width:100%;height:auto}table{max-width:100%}blockquote{margin:0 0 0 8px;padding-left:12px;border-left:2px solid silver}a[href]{color:navy}</style>'
    + `</head><body>${body}</body></html>`;
}

function MailFrame({ html, title }: { html: string; title: string }) {
  const [images, setImages] = useState(false);
  const hasRemote = html.includes(' data-remote-src="');
  const doc = useMemo(() => mailDocument(html, images), [html, images]);
  return (
    <div>
      {hasRemote && (
        <div className="mb-2 flex flex-wrap items-center gap-2 text-xs text-muted">
          <Button size="sm" icon={images ? <ImageOff className="size-4" /> : <Images className="size-4" />} onClick={() => setImages((v) => !v)}>{images ? 'Hide images' : 'Show images'}</Button>
          <span>{images ? 'Pictures are loading from the sender’s servers.' : 'Pictures are not loaded, so the sender cannot tell you opened this.'}</span>
        </div>
      )}
      <iframe title={title} sandbox="" srcDoc={doc} referrerPolicy="no-referrer" className="h-[420px] w-full rounded-xl border border-line bg-paper" />
      <p className="mt-1.5 text-xs text-faint">Shown in an isolated frame. Links are switched off here: hover over one to see where it goes.</p>
    </div>
  );
}

// ---------------------------------------------------------------- one message in a conversation

function Received({ m, open, onToggle }: { m: R; open: boolean; onToggle: () => void }) {
  const [view, setView] = useState<'text' | 'html'>('text');
  return (
    <article className="rounded-xl border border-line bg-surface">
      <button type="button" onClick={onToggle} aria-expanded={open} className="flex w-full items-start gap-2 px-4 py-3 text-left">
        {open ? <ChevronDown className="mt-0.5 size-4 shrink-0 text-muted" /> : <ChevronRight className="mt-0.5 size-4 shrink-0 text-muted" />}
        <span className="min-w-0 flex-1">
          <span className="block truncate font-medium">{who(m)}</span>
          <span className="block truncate text-xs text-muted">{m.from_email} to {m.to_email}</span>
          {!open && <span className="mt-1 block truncate text-sm text-muted">{String(m.text_body).replace(/\s+/g, ' ').slice(0, 160)}</span>}
        </span>
        <span className="shrink-0 text-xs text-muted" title={dateTime(m.at)}>{ago(m.at)}</span>
      </button>
      {open && (
        <div className="space-y-3 border-t border-line px-4 py-4">
          {m.spam && <Notice tone="warn">Filed as spam{m.spam_score !== null && m.spam_flagged ? ` (the mail provider scored it ${Number(m.spam_score).toFixed(1)})` : ''}.</Notice>}
          {(m.notes as string[]).map((n) => <Notice key={n} tone="info">{n}</Notice>)}
          {m.cc && <p className="break-words text-xs text-muted">Copied to: {m.cc}</p>}
          {m.html_body && (
            <Segmented size="sm" value={view} onChange={setView} options={[{ value: 'text', label: 'Plain text' }, { value: 'html', label: 'Formatted' }]} />
          )}
          {view === 'html' && m.html_body
            ? <MailFrame html={m.html_body} title={`Message from ${who(m)}`} />
            : <div className="max-h-[480px] overflow-auto whitespace-pre-wrap break-words text-sm">{m.text_body || <span className="text-muted">This message has no text.</span>}</div>}
          {m.attachments.length > 0 && (
            <div>
              <h4 className="mb-1.5 flex items-center gap-1.5 text-[13px] font-medium"><Paperclip className="size-4" /> {m.attachments.length === 1 ? '1 attachment' : `${m.attachments.length} attachments`}</h4>
              <ul className="space-y-1.5">
                {(m.attachments as R[]).map((a) => (
                  <li key={a.id}>
                    <a href={`/api/admin/inbox/attachments/${a.id}`} download={a.filename} className="flex min-h-10 items-center gap-2.5 rounded-lg border border-line px-3 py-2 text-sm hover:bg-hover">
                      <Download className="size-4 shrink-0 text-muted" />
                      <span className="min-w-0 flex-1 truncate">{a.filename}</span>
                      <span className="shrink-0 text-xs text-muted">{bytes(a.size_bytes)}</span>
                    </a>
                  </li>
                ))}
              </ul>
              <p className="mt-1.5 text-xs text-faint">Attachments come from outside. Only open files you were expecting.</p>
            </div>
          )}
        </div>
      )}
    </article>
  );
}

const SENT_LABEL: Record<string, string> = { reply: 'Reply', new: 'New message', auto_reply: 'Automatic reply' };

function Sent({ m, open, onToggle }: { m: R; open: boolean; onToggle: () => void }) {
  return (
    <article className="ml-4 rounded-xl border border-line bg-raised sm:ml-8">
      <button type="button" onClick={onToggle} aria-expanded={open} className="flex w-full items-start gap-2 px-4 py-3 text-left">
        <CornerUpLeft className="mt-0.5 size-4 shrink-0 text-muted" />
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-2 font-medium">{SENT_LABEL[m.kind] ?? 'Sent'}{m.sent_by_name ? ` by ${m.sent_by_name}` : ''} <StatusBadge status={m.status} /></span>
          <span className="block truncate text-xs text-muted">{m.from_email} to {m.to_email}</span>
          {!open && <span className="mt-1 block truncate text-sm text-muted">{String(m.text_body).replace(/\s+/g, ' ').slice(0, 160)}</span>}
        </span>
        <span className="shrink-0 text-xs text-muted" title={dateTime(m.at)}>{ago(m.at)}</span>
      </button>
      {open && (
        <div className="space-y-3 border-t border-line px-4 py-4">
          {m.error && <Notice tone={m.status === 'failed' ? 'danger' : 'warn'}>{m.error}</Notice>}
          <div className="whitespace-pre-wrap break-words text-sm">{m.text_body}</div>
        </div>
      )}
    </article>
  );
}

// ---------------------------------------------------------------- reading pane

type Detail = { email: R; mailbox: R | null; thread: R[]; blocked: R | null };

function Reader({ id, onClose }: { id: string; onClose: () => void }) {
  const path = `/api/admin/inbox/${id}`;
  // Once the message is being deleted there is nothing left to reload.
  const [gone, setGone] = useState(false);
  const q = useAdminQuery<Detail>(path, undefined, { enabled: !gone });
  const qc = useQueryClient();
  const { run, busy } = useAct();
  const confirm = useConfirm();
  const ask = useAsk();
  const [reply, setReply] = useState('');
  const [opened, setOpened] = useState<Record<string, boolean>>({});

  // Opening a message marks it read on the server: refresh the list and the sidebar count once it has loaded.
  const loadedId = q.data?.email?.id;
  useEffect(() => {
    if (loadedId) void qc.invalidateQueries({ predicate: (query) => query.queryKey[0] === 'admin' && query.queryKey[1] !== path });
  }, [loadedId, path, qc]);

  const e = q.data?.email;
  const post = (key: string, sub: string, json: R, ok: string, then?: () => void) => run({ key, fn: () => api<R>(`${path}/${sub}`, { json }), ok, onDone: then });

  const markSpam = async () => {
    if (!e) return;
    const domain = String(e.from_email).split('@')[1];
    const v = await ask({
      title: 'Move to spam?',
      body: `From ${e.from_email}.`,
      confirmLabel: 'Move to spam',
      danger: true,
      fields: [{
        name: 'block', label: 'Future mail from this sender', type: 'select', initial: 'none',
        options: [{ value: 'none', label: 'Keep accepting it' }, { value: 'address', label: `Block ${e.from_email}` }, { value: 'domain', label: `Block everyone at ${domain}` }],
        hint: 'Blocked mail is thrown away before it reaches any mailbox. You can unblock a sender under Mailboxes.',
      }],
    });
    if (!v) return;
    void run({
      key: 'spam',
      fn: () => api<R>(`${path}/spam`, { json: { spam: true, ...(v.block && v.block !== 'none' ? { block: v.block } : {}) } }),
      ok: (r) => (r.blocked ? `Moved to spam and blocked ${r.blocked.value}` : 'Moved to spam'),
      onDone: onClose,
    });
  };
  const remove = async () => {
    if (await confirm({ title: 'Delete this email?', body: 'The message and its attachments are removed for good. Replies you sent stay in the email log.', confirmLabel: 'Delete', danger: true })) {
      setGone(true);
      void run({ key: 'delete', fn: () => api<R>(path, { method: 'DELETE' }), ok: 'Email deleted', onDone: onClose }).then((r) => !r && setGone(false));
    }
  };
  const send = () => {
    void run({
      key: 'reply',
      fn: () => api<R>(`${path}/reply`, { json: { body: reply } }),
      ok: (r) => (r.status === 'queued' ? `Reply on its way to ${r.to}` : null),
      onDone: (r) => {
        if (r.status !== 'queued') toast.warning(`The reply was not sent to ${r.to}: ${r.error ?? 'the address cannot receive mail'}.`, { duration: 12_000 });
        else setReply('');
      },
    });
  };

  return (
    <Drawer
      open
      onClose={onClose}
      title={e?.subject || (e ? '(no subject)' : 'Email')}
      footer={e && (
        <>
          <Button size="sm" icon={<MailOpen className="size-4" />} loading={busy === 'unread'} onClick={() => void post('unread', 'read', { read: false }, 'Marked as unread', onClose)}>Mark unread</Button>
          {e.archived_at
            ? <Button size="sm" icon={<ArchiveRestore className="size-4" />} loading={busy === 'archive'} onClick={() => void post('archive', 'archive', { archived: false }, 'Moved back to the inbox')}>Move to inbox</Button>
            : <Button size="sm" icon={<Archive className="size-4" />} loading={busy === 'archive'} onClick={() => void post('archive', 'archive', { archived: true }, 'Archived', onClose)}>Archive</Button>}
          {e.spam
            ? <Button size="sm" icon={<ShieldCheck className="size-4" />} loading={busy === 'spam'} onClick={() => void post('spam', 'spam', { spam: false }, 'Moved out of spam')}>Not spam</Button>
            : <Button size="sm" icon={<ShieldAlert className="size-4" />} loading={busy === 'spam'} onClick={markSpam}>Spam</Button>}
          <Button size="sm" variant="danger" icon={<Trash2 className="size-4" />} loading={busy === 'delete'} onClick={remove}>Delete</Button>
        </>
      )}
    >
      <Loaded query={q}>
        {({ email, mailbox, thread, blocked }) => (
          <div className="space-y-4">
            <p className="text-sm text-muted">
              {mailbox ? <>In <span className="text-paper">{mailbox.name}</span> ({mailbox.address})</> : 'Mailbox removed'}
              {thread.length > 1 && <> · {thread.length} messages in this conversation</>}
            </p>
            {blocked && <Notice tone="warn" action={<Link className="underline" to="/admin/inbox/mailboxes">Blocked senders</Link>}>{blocked.kind === 'domain' ? `Everyone at ${blocked.value} is blocked` : `${blocked.value} is blocked`}: new mail from them is thrown away.</Notice>}
            <div className="space-y-3">
              {thread.map((m, i) => {
                const isOpen = opened[m.id] ?? (m.id === email.id || i === thread.length - 1);
                const toggle = () => setOpened((o) => ({ ...o, [m.id]: !isOpen }));
                return m.type === 'sent' ? <Sent key={m.id} m={m} open={isOpen} onToggle={toggle} /> : <Received key={m.id} m={m} open={isOpen} onToggle={toggle} />;
              })}
            </div>
            <form
              className="space-y-2 border-t border-line pt-4"
              onSubmit={(ev) => {
                ev.preventDefault();
                if (reply.trim()) send();
              }}
            >
              <Field label="Reply" hint={mailbox ? `Sent from ${mailbox.address} to ${email.reply_to || email.from_email}. Their message is quoted underneath yours.` : undefined}>
                <Textarea value={reply} onChange={(ev) => setReply(ev.target.value)} placeholder="Write your answer" className="min-h-32" maxLength={50_000} />
              </Field>
              <div className="flex justify-end">
                <Button type="submit" variant="primary" icon={<Send className="size-4" />} loading={busy === 'reply'} disabled={!reply.trim() || !mailbox}>Send reply</Button>
              </div>
            </form>
          </div>
        )}
      </Loaded>
    </Drawer>
  );
}

// ---------------------------------------------------------------- write a new message

function Compose({ mailboxes, initial, onClose }: { mailboxes: MailboxRow[]; initial: string; onClose: () => void }) {
  const usable = mailboxes.filter((m) => m.active);
  const [form, setForm] = useState({ mailbox_id: usable.find((m) => m.id === initial)?.id ?? usable.find((m) => m.is_default)?.id ?? usable[0]?.id ?? '', to: '', subject: '', body: '' });
  const { run, busy } = useAct();
  const set = (patch: Partial<typeof form>) => setForm((f) => ({ ...f, ...patch }));
  const ready = form.mailbox_id && form.to.trim() && form.subject.trim() && form.body.trim();
  const send = () => {
    void run({
      key: 'compose',
      fn: () => api<R>('/api/admin/inbox/compose', { json: { ...form, to: form.to.trim() } }),
      ok: (r) => (r.status === 'queued' ? 'Message on its way' : null),
      onDone: (r) => {
        if (r.status !== 'queued') toast.warning(`The message was not sent: ${r.error ?? 'the address cannot receive mail'}.`, { duration: 12_000 });
        else onClose();
      },
    });
  };
  return (
    <Modal
      open
      onClose={onClose}
      title="Write a message"
      size="lg"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" icon={<Send className="size-4" />} loading={busy === 'compose'} disabled={!ready} onClick={send}>Send</Button>
        </>
      }
    >
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (ready) send();
        }}
      >
        <Field label="From">
          <Select value={form.mailbox_id} onChange={(e) => set({ mailbox_id: e.target.value })}>
            {usable.map((m) => <option key={m.id} value={m.id}>{m.name} ({m.address})</option>)}
          </Select>
        </Field>
        <Field label="To"><Input type="email" value={form.to} onChange={(e) => set({ to: e.target.value })} placeholder="name@example.com" autoFocus /></Field>
        <Field label="Subject"><Input value={form.subject} maxLength={300} onChange={(e) => set({ subject: e.target.value })} /></Field>
        <Field label="Message" hint="Sent as plain text. Answers come back to this mailbox."><Textarea value={form.body} onChange={(e) => set({ body: e.target.value })} className="min-h-40" maxLength={50_000} /></Field>
      </form>
    </Modal>
  );
}

// ---------------------------------------------------------------- the inbox

export function InboxPage() {
  useTitle('Inbox');
  const isSuper = useIsSuper();
  const [f, setF] = useFilters({ mailbox: '', folder: 'inbox', q: '', open: '' });
  const folder = (['inbox', 'unread', 'archived', 'spam'].includes(f.folder) ? f.folder : 'inbox') as Folder;
  const boxes = useAdminQuery<Mailboxes>('/api/admin/mailboxes');
  const list = useList<{ counts: Counts }>('/api/admin/inbox', {
    mailbox: f.mailbox, folder: folder === 'unread' ? 'inbox' : folder, unread: folder === 'unread' ? 1 : undefined, q: f.q, page: f.page,
  });
  const [composing, setComposing] = useState(false);
  const counts = list.data?.counts;
  const mailboxes = boxes.data?.items ?? [];
  const tab = (value: Folder, label: string, n?: number) => ({ value, label: <>{label}{n ? <span className="ml-1.5 text-xs text-muted tabular-nums">{number(n)}</span> : null}</> });

  const setupHint = isSuper
    ? <>Incoming mail is not connected yet. <Link className="underline" to="/admin/settings?tab=email">Set it up in Settings, Email</Link>.</>
    : 'Incoming mail is not connected yet. A super admin can set it up in Settings, Email.';

  return (
    <>
      <PageHeader
        title="Inbox"
        description="Mail sent to the site's own addresses. Answers go out from the same address."
        actions={
          <>
            <LinkButton to="/admin/inbox/mailboxes">Mailboxes</LinkButton>
            <Button variant="primary" icon={<MailPlus className="size-4" />} disabled={!mailboxes.some((m) => m.active)} onClick={() => setComposing(true)}>Write a message</Button>
          </>
        }
      />
      {boxes.data && !boxes.data.inbound_enabled && <div className="mb-4"><Notice tone="warn">{setupHint}</Notice></div>}
      <div className="mb-4"><Tabs value={folder} onChange={(v) => setF({ folder: v })} tabs={[tab('inbox', 'Inbox', counts?.inbox), tab('unread', 'Unread', counts?.unread), tab('archived', 'Archived'), tab('spam', 'Spam', counts?.spam)]} /></div>
      <FilterBar>
        <SearchInput value={f.q} onChange={(q) => setF({ q })} placeholder="Search sender, subject or text" />
        <FilterSelect
          label="Mailbox"
          value={f.mailbox}
          onChange={(mailbox) => setF({ mailbox })}
          options={[['', 'All mailboxes'], ...mailboxes.map((m) => [m.id, m.unread ? `${m.name} (${m.unread} unread)` : m.name] as [string, string])]}
        />
      </FilterBar>

      {list.isPending ? <Skeleton className="h-72 w-full" />
        : list.isError ? <ErrorState message={errorMessage(list.error)} retry={() => void list.refetch()} />
        : list.data.items.length === 0 ? (
          <EmptyState icon={<MailOpen />} title={f.q ? 'No email matches that search' : folder === 'inbox' ? 'The inbox is empty' : folder === 'unread' ? 'Nothing unread' : folder === 'archived' ? 'Nothing archived' : 'No spam'}>
            {f.q ? 'Try a shorter search, or look in another tab.' : folder === 'inbox' ? 'New mail to your mailboxes shows up here.' : folder === 'spam' ? 'Mail the provider scores as spam, or that you move here, is kept out of the inbox.' : undefined}
          </EmptyState>
        ) : (
          <div className={cx('transition-opacity', list.isPlaceholderData && 'opacity-60')}>
            <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line">
              {list.data.items.map((m) => (
                <li key={m.id}>
                  <button type="button" onClick={() => setF({ open: m.id, page: f.page })} className={cx('flex w-full items-start gap-3 px-3.5 py-3 text-left hover:bg-surface', f.open === m.id && 'bg-surface')}>
                    <span className={cx('mt-1.5 size-2 shrink-0 rounded-full', m.read_at ? 'bg-transparent' : 'bg-accent')} aria-hidden />
                    <span className="min-w-0 flex-1">
                      <span className="flex items-baseline gap-2">
                        <span className={cx('min-w-0 flex-1 truncate', m.read_at ? 'text-muted' : 'font-semibold')}>{who(m)}{!m.read_at && <span className="sr-only"> (unread)</span>}</span>
                        <span className="shrink-0 text-xs text-muted" title={dateTime(m.received_at)}>{ago(m.received_at)}</span>
                      </span>
                      <span className={cx('block truncate text-sm', !m.read_at && 'font-medium')}>{m.subject || '(no subject)'}</span>
                      <span className="block truncate text-sm text-muted">{m.snippet}</span>
                      <span className="mt-1 flex flex-wrap items-center gap-1.5">
                        {!f.mailbox && <Badge>{m.mailbox_name}</Badge>}
                        {m.replied_at && <Badge tone="ok">Answered</Badge>}
                        {m.attachment_count > 0 && <Badge><Paperclip className="size-3" aria-hidden />{m.attachment_count}<span className="sr-only"> attachments</span></Badge>}
                        {m.spam && folder !== 'spam' && <Badge tone="warn">Spam</Badge>}
                      </span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
            <div className="mt-2 text-xs text-faint">{number(list.data.total)} in total</div>
            <Pagination page={list.data.page} pages={Math.ceil(list.data.total / list.data.limit)} onPage={(page) => setF({ page })} />
          </div>
        )}

      {f.open && <Reader key={f.open} id={f.open} onClose={() => setF({ open: '', page: f.page })} />}
      {composing && <Compose mailboxes={mailboxes} initial={f.mailbox} onClose={() => setComposing(false)} />}
    </>
  );
}

// ---------------------------------------------------------------- mailboxes and blocked senders

export function MailboxesPage() {
  useTitle('Mailboxes');
  const isSuper = useIsSuper();
  const boxes = useAdminQuery<Mailboxes>('/api/admin/mailboxes');
  const blocked = useAdminQuery<{ items: R[] }>('/api/admin/inbox/blocklist');
  const { run, busy } = useAct();
  const ask = useAsk();
  const confirm = useConfirm();
  const domain = boxes.data?.domains[0] ?? 'example.com';

  const edit = async (m?: MailboxRow) => {
    const v = await ask({
      title: m ? `Edit ${m.name}` : 'Add a mailbox',
      confirmLabel: m ? 'Save' : 'Add mailbox',
      fields: [
        { name: 'address', label: 'Address', type: 'email', required: true, initial: m?.address ?? '', placeholder: `support@${domain}`, hint: `Has to be on ${boxes.data?.domains.join(' or ') ?? 'the site’s domain'}.` },
        { name: 'name', label: 'Name', required: true, initial: m?.name ?? '', placeholder: 'Support', hint: 'Shown in the inbox and as the sender name on replies.' },
        { name: 'auto_reply', label: 'Automatic reply', type: 'textarea', initial: m?.auto_reply ?? '', hint: 'Sent to people who write in, at most once a day each. Never sent to newsletters or other automatic mail. Leave empty for none.' },
        { name: 'is_default', label: 'Catch-all mailbox', type: 'checkbox', initial: m?.is_default ?? false, hint: 'Mail for addresses that have no mailbox of their own lands here.' },
        { name: 'active', label: 'Turned on', type: 'checkbox', initial: m?.active ?? true, hint: 'When off, mail for this address goes to the catch-all mailbox instead.' },
      ],
    });
    if (!v) return;
    const json = { address: v.address, name: v.name, auto_reply: v.auto_reply ?? '', is_default: v.is_default, active: v.active };
    void run({ key: 'edit', fn: () => (m ? api(`/api/admin/mailboxes/${m.id}`, { method: 'PATCH', json }) : api('/api/admin/mailboxes', { json })), ok: m ? 'Mailbox saved' : 'Mailbox added' });
  };
  const remove = async (m: MailboxRow) => {
    if (await confirm({ title: `Delete ${m.address}?`, body: m.total ? `Its ${number(m.total)} ${m.total === 1 ? 'email is' : 'emails are'} deleted with it, attachments included. This cannot be undone.` : 'The mailbox is empty. New mail for this address will go to the catch-all mailbox.', confirmLabel: 'Delete mailbox', danger: true })) {
      void run({ key: `del-${m.id}`, fn: () => api(`/api/admin/mailboxes/${m.id}`, { method: 'DELETE' }), ok: 'Mailbox deleted' });
    }
  };
  const block = async () => {
    const v = await ask({
      title: 'Block a sender',
      body: 'Mail from a blocked sender is thrown away before it reaches any mailbox.',
      confirmLabel: 'Block',
      fields: [
        { name: 'kind', label: 'Block', type: 'select', initial: 'address', options: [{ value: 'address', label: 'One address' }, { value: 'domain', label: 'Everyone at a domain' }] },
        { name: 'value', label: 'Address or domain', required: true, placeholder: 'name@example.com or example.com' },
        { name: 'reason', label: 'Note', hint: 'Why, for whoever looks at this list later.' },
      ],
    });
    if (v) void run({ key: 'block', fn: () => api('/api/admin/inbox/blocklist', { json: { kind: v.kind, value: v.value, reason: v.reason ?? '' } }), ok: 'Sender blocked' });
  };

  return (
    <>
      <PageHeader
        title="Mailboxes"
        description="The addresses the site receives mail at, and the senders it refuses."
        back={<Link className="text-sm text-muted hover:text-paper" to="/admin/inbox">Back to the inbox</Link>}
      />
      <div className="space-y-6">
        {boxes.data && !boxes.data.inbound_enabled && (
          <Notice tone="warn">
            {isSuper ? <>Incoming mail is not connected yet, so nothing arrives. <Link className="underline" to="/admin/settings?tab=email">Set it up in Settings, Email</Link>.</> : 'Incoming mail is not connected yet. A super admin can set it up in Settings, Email.'}
          </Notice>
        )}
        <Section
          title="Mailboxes"
          description={isSuper ? 'Add one for each address you publish, such as support@ or dmca@.' : 'Only a super admin can add or change mailboxes.'}
          actions={isSuper && <Button variant="primary" icon={<Plus className="size-4" />} loading={busy === 'edit'} onClick={() => void edit()}>Add mailbox</Button>}
        >
          <Loaded query={boxes}>
            {(d) => d.items.length === 0 ? (
              <EmptyState icon={<MailOpen />} title="No mailboxes yet">A support mailbox is created by itself when the first email arrives. You can also add the ones you need now.</EmptyState>
            ) : (
              <Table<MailboxRow>
                rows={d.items}
                rowKey={(m) => m.id}
                columns={[
                  { key: 'address', header: 'Address', cell: (m) => (
                    <span className="block">
                      <Link className="link font-medium" to={`/admin/inbox?mailbox=${m.id}`}>{m.address}</Link>
                      <span className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-muted">
                        {m.name}
                        {m.is_default && <Badge tone="accent">Catch-all</Badge>}
                        {!m.active && <Badge tone="warn">Off</Badge>}
                        {m.auto_reply && <Badge>Automatic reply</Badge>}
                      </span>
                    </span>
                  ) },
                  { key: 'mail', header: 'Mail', align: 'right', cell: (m) => <span title={`${m.unread} unread`}>{m.unread ? `${number(m.unread)} unread of ` : ''}{number(m.total)}</span> },
                  ...(isSuper ? [{ key: 'actions', header: '', align: 'right' as const, cell: (m: MailboxRow) => (
                    <span className="flex justify-end gap-2">
                      <Button size="sm" icon={<Pencil className="size-4" />} onClick={() => void edit(m)}>Edit</Button>
                      <Button size="sm" variant="danger" loading={busy === `del-${m.id}`} onClick={() => void remove(m)}>Delete</Button>
                    </span>
                  ) }] : []),
                ]}
              />
            )}
          </Loaded>
        </Section>

        <Section title="Blocked senders" description="Their mail is thrown away before it is stored. The sender is not told." actions={<Button icon={<Ban className="size-4" />} loading={busy === 'block'} onClick={() => void block()}>Block a sender</Button>}>
          <Loaded query={blocked}>
            {(d) => (
              <Table<R>
                rows={d.items}
                rowKey={(b) => b.id}
                empty="Nobody is blocked. You can block a sender when you move one of their emails to spam."
                columns={[
                  { key: 'value', header: 'Sender', cell: (b) => <span className="block max-w-[220px] truncate" title={b.reason || undefined}>{b.kind === 'domain' ? `Everyone at ${b.value}` : b.value}</span> },
                  { key: 'hits', header: 'Stopped', align: 'right', cell: (b) => <span title={b.last_hit_at ? `Last ${dateTime(b.last_hit_at)}` : 'Nothing stopped yet'}>{number(b.hits)}</span> },
                  { key: 'since', header: 'Since', hideOnMobile: true, cell: (b) => ago(b.created_at) },
                  { key: 'actions', header: '', align: 'right', cell: (b) => <Button size="sm" loading={busy === `unblock-${b.id}`} onClick={() => void run({ key: `unblock-${b.id}`, fn: () => api(`/api/admin/inbox/blocklist/${b.id}`, { method: 'DELETE' }), ok: 'Unblocked' })}>Unblock</Button> },
                ]}
              />
            )}
          </Loaded>
        </Section>
      </div>
    </>
  );
}
