import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, MessageCircle, PenSquare, Send } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { ApiError, api, errorMessage } from '@/lib/api';
import { ago, date } from '@/lib/format';
import { useSession } from '@/lib/session';
import { Avatar, Button, EmptyState, ErrorState, Field, IconButton, Input, LinkButton, Modal, Notice, Spinner, Textarea, cx, toast } from '@/ui';
import { ListSkeleton, PlainText, useTitle } from './shared';
import type { Person } from './shared';

type Conversation = { id: string; with: Person | null; last_message: { body: string; mine: boolean }; last_message_at: string; unread: number };
type Message = { id: string; body: string; mine: boolean; read_at: string | null; created_at: string };
type ThreadData = { conversation: { id: string; with: Person | null; can_reply: boolean }; messages: Message[]; page: number; limit: number };
type Sent = { conversation_id: string; message: Message };

const PAGE = 50;

function useConversations() {
  return useQuery({
    queryKey: ['messages', 'list'],
    queryFn: () => api<{ items: Conversation[]; unread: number }>('/api/messages/conversations'),
    refetchInterval: 15_000,
  });
}

function NewConversation({ initialTo, onClose, onSent }: { initialTo: string; onClose: () => void; onSent: () => void }) {
  const nav = useNavigate();
  const qc = useQueryClient();
  const [to, setTo] = useState(initialTo);
  const [body, setBody] = useState('');
  const { user } = useSession();
  const [error, setError] = useState<string | null>(null);
  const send = useMutation({
    mutationFn: () => api<Sent>('/api/messages', { json: { to: to.trim(), body } }),
    onMutate: () => setError(null),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: ['messages'] });
      onSent();
      nav(`/messages/${r.conversation_id}`, { replace: Boolean(initialTo) });
    },
    onError: (e) => setError(errorMessage(e)),
  });
  return (
    <Modal
      open
      onClose={onClose}
      title="New message"
      size="sm"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" type="submit" form="new-message" loading={send.isPending} disabled={!to.trim() || !body.trim()} icon={<Send className="size-4" />}>Send</Button>
        </>
      }
    >
      <form
        id="new-message"
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          send.mutate();
        }}
      >
        {error && <ErrorState message={error} />}
        {user && !user.email_verified && <Notice tone="warn">Confirm your email address before sending messages. The link is in the email we sent to {user.email}.</Notice>}
        <Field label="To" hint="Their username, as shown on their profile.">
          <Input value={to} onChange={(e) => setTo(e.target.value)} placeholder="username" autoCapitalize="off" autoComplete="off" spellCheck={false} maxLength={40} required autoFocus={!initialTo} />
        </Field>
        <Field label="Message">
          <Textarea value={body} onChange={(e) => setBody(e.target.value)} maxLength={4000} required autoFocus={Boolean(initialTo)} />
        </Field>
      </form>
    </Modal>
  );
}

function ConversationList({ activeId, onNew }: { activeId?: string; onNew: () => void }) {
  const list = useConversations();
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center justify-between gap-3 border-b border-line px-4 py-3">
        <h1 className="text-xl font-bold">Messages</h1>
        <Button size="sm" variant={activeId ? 'secondary' : 'primary'} className="h-10" icon={<PenSquare className="size-4" />} onClick={onNew}>New message</Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {list.isPending ? (
          <div className="p-3"><ListSkeleton rows={4} /></div>
        ) : list.isError ? (
          <div className="p-3"><ErrorState message={errorMessage(list.error)} retry={() => list.refetch()} /></div>
        ) : list.data.items.length === 0 ? (
          <div className="p-4">
            <EmptyState icon={<MessageCircle />} title="No conversations yet" action={<Button onClick={onNew}>Write to someone</Button>}>
              Message another reader or a creator by their username, or use the Message button on their profile.
            </EmptyState>
          </div>
        ) : (
          <ul>
            {list.data.items.map((c) => {
              const name = c.with?.name ?? 'Deleted user';
              return (
                <li key={c.id}>
                  <Link
                    to={`/messages/${c.id}`}
                    aria-current={c.id === activeId ? 'page' : undefined}
                    className={cx('flex items-center gap-3 border-b border-line px-4 py-3 transition-colors hover:bg-hover', c.id === activeId && 'bg-raised')}
                  >
                    <Avatar src={c.with?.avatar_url} name={name} size={44} />
                    <span className="min-w-0 flex-1">
                      <span className="flex items-baseline justify-between gap-2">
                        <span className={cx('truncate text-sm', c.unread ? 'font-bold' : 'font-medium')}>{name}</span>
                        <span className="shrink-0 text-xs text-faint">{ago(c.last_message_at)}</span>
                      </span>
                      <span className="flex items-center justify-between gap-2">
                        <span className={cx('truncate text-sm', c.unread ? 'text-paper' : 'text-muted')}>{c.last_message.mine ? 'You: ' : ''}{c.last_message.body}</span>
                        {c.unread > 0 && (
                          <span className="flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full bg-accent px-1.5 text-[11px] font-bold text-accent-ink" aria-label={`${c.unread} unread`}>{c.unread}</span>
                        )}
                      </span>
                    </span>
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}

function sameDay(a: string, b: string): boolean {
  return new Date(a).toDateString() === new Date(b).toDateString();
}

function ThreadView({ id }: { id: string }) {
  const qc = useQueryClient();
  const { refresh, user } = useSession();
  const [older, setOlder] = useState<Message[]>([]);
  const [olderPage, setOlderPage] = useState(1);
  const [noMore, setNoMore] = useState(false);
  const [draft, setDraft] = useState('');
  const [blocked, setBlocked] = useState<string | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  const thread = useQuery({
    queryKey: ['messages', 'thread', id],
    queryFn: () => api<ThreadData>(`/api/messages/conversations/${id}`, { query: { limit: PAGE } }),
    refetchInterval: 5_000,
    retry: (n, e) => !(e instanceof ApiError && e.status === 404) && n < 2,
  });
  const them = thread.data?.conversation.with ?? null;
  useTitle(thread.data ? `Messages with ${them?.name ?? 'a deleted user'}` : 'Messages');

  // Opening a conversation marks it read on the server: bring the list and the bell in line once.
  const opened = Boolean(thread.data);
  useEffect(() => {
    if (!opened) return;
    void qc.invalidateQueries({ queryKey: ['messages', 'list'] });
    void refresh();
  }, [opened, id, qc, refresh]);

  const recent = thread.data?.messages ?? [];
  const seen = new Set(recent.map((m) => m.id));
  const messages = [...older.filter((m) => !seen.has(m.id)), ...recent];
  const lastId = messages[messages.length - 1]?.id;

  // Stay pinned to the newest message unless the reader has scrolled up to read history.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [lastId]);

  const loadOlder = useMutation({
    mutationFn: () => api<ThreadData>(`/api/messages/conversations/${id}`, { query: { limit: PAGE, page: olderPage + 1 } }),
    onSuccess: (r) => {
      const el = scroller.current;
      const before = el ? el.scrollHeight - el.scrollTop : 0;
      setOlder((cur) => [...r.messages.filter((m) => !cur.some((c) => c.id === m.id)), ...cur]);
      setOlderPage((p) => p + 1);
      if (r.messages.length < PAGE) setNoMore(true);
      requestAnimationFrame(() => {
        if (el) el.scrollTop = el.scrollHeight - before;
      });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  const send = useMutation({
    mutationFn: (body: string) => api<Sent>('/api/messages', { json: { to: them!.username, body } }),
    onSuccess: (r) => {
      setDraft('');
      setBlocked(null);
      stick.current = true;
      qc.setQueryData<ThreadData>(['messages', 'thread', id], (old) => (old ? { ...old, messages: [...old.messages.filter((m) => m.id !== r.message.id), r.message] } : old));
      void qc.invalidateQueries({ queryKey: ['messages', 'list'] });
    },
    onError: (e) => {
      // "Not accepting direct messages", unconfirmed email and rate limits all arrive as readable sentences.
      if (e instanceof ApiError && e.status === 403) setBlocked(e.message);
      else toast.error(errorMessage(e));
    },
  });
  const submit = () => {
    const body = draft.trim();
    if (body && them && !send.isPending) send.mutate(body);
  };
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      submit();
    }
  };

  if (thread.isPending) return <div className="flex h-full items-center justify-center"><Spinner className="size-7" /></div>;
  if (thread.isError) {
    const gone = thread.error instanceof ApiError && thread.error.status === 404;
    return (
      <div className="p-4">
        {gone ? (
          <EmptyState icon={<MessageCircle />} title="Conversation not found" action={<LinkButton to="/messages">Back to messages</LinkButton>}>It may belong to a different account.</EmptyState>
        ) : (
          <ErrorState message={errorMessage(thread.error)} retry={() => thread.refetch()} />
        )}
      </div>
    );
  }
  const canReply = thread.data.conversation.can_reply && Boolean(them);
  const hasOlder = !noMore && recent.length >= PAGE;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-2 border-b border-line px-2 py-2.5 sm:px-4">
        <Link to="/messages" aria-label="Back to all messages" className="inline-flex size-10 items-center justify-center rounded-lg text-muted hover:bg-hover hover:text-paper md:hidden"><ArrowLeft className="size-5" /></Link>
        <Avatar src={them?.avatar_url} name={them?.name ?? '?'} size={36} />
        <div className="min-w-0 flex-1">
          {them ? (
            <Link to={`/u/${them.username}`} className="block truncate font-semibold hover:text-accent-hover">{them.name}</Link>
          ) : (
            <div className="font-semibold text-muted">Deleted user</div>
          )}
          {them && <div className="truncate text-xs text-muted">@{them.username}</div>}
        </div>
      </div>

      <div
        ref={scroller}
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
        }}
        className="min-h-0 flex-1 space-y-1.5 overflow-y-auto px-3 py-4 sm:px-5"
        aria-live="polite"
      >
        {hasOlder && (
          <div className="pb-2 text-center"><Button size="sm" className="h-10" loading={loadOlder.isPending} onClick={() => loadOlder.mutate()}>Show earlier messages</Button></div>
        )}
        {messages.map((m, i) => {
          const prev = messages[i - 1];
          const newDay = !prev || !sameDay(prev.created_at, m.created_at);
          const isLastMine = m.mine && i === messages.length - 1;
          return (
            <div key={m.id}>
              {newDay && <div className="py-3 text-center text-xs text-faint">{date(m.created_at, { weekday: 'long', month: 'long', day: 'numeric' })}</div>}
              <div className={cx('flex', m.mine ? 'justify-end' : 'justify-start')}>
                <div
                  title={new Date(m.created_at).toLocaleString()}
                  className={cx('max-w-[85%] rounded-2xl px-3.5 py-2 text-sm sm:max-w-[70%]', m.mine ? 'rounded-br-md bg-accent text-accent-ink' : 'rounded-bl-md bg-raised text-paper')}
                >
                  <PlainText>{m.body}</PlainText>
                  <div className={cx('mt-0.5 text-right text-[11px]', m.mine ? 'text-accent-ink/70' : 'text-faint')}>
                    {new Date(m.created_at).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}
                  </div>
                </div>
              </div>
              {isLastMine && <div className="mt-0.5 text-right text-[11px] text-faint">{m.read_at ? 'Seen' : 'Sent'}</div>}
            </div>
          );
        })}
      </div>

      <div className="border-t border-line p-3">
        {!canReply ? (
          <Notice tone="warn">
            {them ? `${them.name} is not accepting direct messages, so you cannot reply here.` : 'This account was deleted, so the conversation is closed.'}
          </Notice>
        ) : (
          <form
            className="flex items-end gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              submit();
            }}
          >
            <div className="min-w-0 flex-1">
              {(blocked || (user && !user.email_verified)) && <div className="mb-2"><Notice tone="warn">{blocked ?? 'Confirm your email address before sending messages.'}</Notice></div>}
              <label className="sr-only" htmlFor="composer">Message {them?.name}</label>
              <textarea
                id="composer"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={onKey}
                rows={Math.min(5, Math.max(1, draft.split('\n').length))}
                maxLength={4000}
                placeholder={`Message ${them?.name ?? ''}`}
                className="block w-full resize-none rounded-xl border border-line bg-ink px-3.5 py-2.5 text-sm placeholder:text-faint hover:border-line-strong focus:border-accent focus:outline-none"
              />
            </div>
            <IconButton type="submit" label="Send message" disabled={!draft.trim() || send.isPending} className="size-11 bg-accent text-accent-ink hover:bg-accent-hover hover:text-accent-ink">
              {send.isPending ? <Spinner className="size-5 text-accent-ink" /> : <Send className="size-5" />}
            </IconButton>
          </form>
        )}
      </div>
    </div>
  );
}

/** /messages and /messages/:conversationId. Two panes on desktop, one at a time on a phone. */
export function Messages() {
  const { conversationId } = useParams();
  const [params, setParams] = useSearchParams();
  const to = params.get('to');
  const [composing, setComposing] = useState(Boolean(to));
  useTitle(conversationId ? null : 'Messages');
  useEffect(() => {
    if (to) setComposing(true);
  }, [to]);
  const closeNew = () => {
    setComposing(false);
    if (to) setParams({}, { replace: true });
  };
  return (
    <div className="-mx-4 -my-6 sm:-mx-6 lg:-mx-8">
      <div className="flex h-[calc(100dvh-4rem)] min-h-[420px]">
        <aside className={cx('w-full shrink-0 border-line md:block md:w-80 md:border-r lg:w-96', conversationId && 'hidden')}>
          <ConversationList activeId={conversationId} onNew={() => setComposing(true)} />
        </aside>
        <section className={cx('min-w-0 flex-1', !conversationId && 'hidden md:block')} aria-label="Conversation">
          {conversationId ? (
            <ThreadView key={conversationId} id={conversationId} />
          ) : (
            <div className="flex h-full items-center justify-center p-6">
              <EmptyState icon={<MessageCircle />} title="Pick a conversation">Choose one on the left, or start a new message.</EmptyState>
            </div>
          )}
        </section>
      </div>
      {composing && <NewConversation initialTo={to ?? ''} onClose={closeNew} onSent={() => setComposing(false)} />}
    </div>
  );
}
