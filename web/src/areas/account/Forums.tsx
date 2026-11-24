import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, BookOpen, ChevronRight, Lock, LockOpen, MessageSquarePlus, MessagesSquare, Pencil, Pin, PinOff, Rss, Trash2, UserRound } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Link, useLocation, useNavigate, useParams, useSearchParams } from 'react-router';
import { ApiError, api, errorMessage } from '@/lib/api';
import { ago, dateTime, number, plural } from '@/lib/format';
import { useSession } from '@/lib/session';
import { Avatar, Badge, Button, Card, EmptyState, ErrorState, Field, Input, LinkButton, Modal, Notice, PageHeader, PageLoader, Pagination, Textarea, cx, toast, useConfirm } from '@/ui';
import { Cover, ListSkeleton, PersonLink, PlainText, releaseLabel, useTitle } from './shared';
import type { Person, ReleaseRef, SeriesCard, Thread } from './shared';

const BOARD_BLURB: Record<string, string> = {
  general: 'Talk about comics, the site and everything around them.',
  recommendations: 'Ask for something to read, or tell people what they are missing.',
  creators: 'Craft, tools, publishing and promotion, by and for people who make comics.',
  feedback: 'Ideas and problems with the site itself. The team reads this board.',
};

type Board = { id: string; label: string };
type ThreadWithPlace = Thread & { series: { slug: string; title: string } | null; board: Board | null };

function ThreadRow({ thread, place }: { thread: Thread; place?: ReactNode }) {
  return (
    <li>
      <Link to={`/forums/thread/${thread.id}`} className="flex items-center gap-3 px-4 py-3 transition-colors hover:bg-hover">
        <Avatar src={thread.author?.avatar_url} name={thread.author?.name ?? '?'} size={36} />
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="min-w-0 break-words font-medium [overflow-wrap:anywhere]">{thread.title}</span>
            {thread.pinned && <Badge tone="accent"><Pin className="size-3" aria-hidden />Pinned</Badge>}
            {thread.locked && <Badge><Lock className="size-3" aria-hidden />Locked</Badge>}
          </span>
          <span className="mt-0.5 block truncate text-xs text-muted">
            {thread.author?.name ?? 'Deleted user'}{place ? <> · {place}</> : null} · last post {ago(thread.last_post_at)}
          </span>
        </span>
        <span className="shrink-0 text-right text-xs text-muted">
          <span className="block text-sm font-semibold tabular-nums text-paper">{number(thread.reply_count)}</span>
          {thread.reply_count === 1 ? 'reply' : 'replies'}
        </span>
      </Link>
    </li>
  );
}

function ThreadList({ children }: { children: ReactNode }) {
  return <ul className="divide-y divide-line overflow-hidden rounded-2xl border border-line bg-surface">{children}</ul>;
}

// ---------------------------------------------------------------- community feed

type FeedRelease = { release: ReleaseRef; series: SeriesCard };
type Feed = { following_releases: FeedRelease[]; releases: FeedRelease[]; threads: ThreadWithPlace[] };

function ReleaseList({ items }: { items: FeedRelease[] }) {
  return (
    <ul className="space-y-3">
      {items.map((it) => (
        <li key={it.release.id} className="flex gap-3 rounded-2xl border border-line bg-surface p-3">
          <Link to={`/read/${it.release.id}`} className="w-14 shrink-0" aria-label={`Read ${releaseLabel(it.release)}`}>
            <Cover src={it.release.cover_url} title={it.series.title} />
          </Link>
          <div className="min-w-0 flex-1">
            <Link to={`/series/${it.series.slug}`} className="block truncate font-display font-semibold hover:text-accent-hover">{it.series.title}</Link>
            <Link to={`/read/${it.release.id}`} className="block truncate text-sm text-muted hover:text-paper">{releaseLabel(it.release)}</Link>
            <div className="mt-1 flex flex-wrap items-center gap-x-2 text-xs text-faint">
              <Link to={`/b/${it.series.publisher.slug}`} className="hover:text-paper">{it.series.publisher.name}</Link>
              <span>·</span>
              <span>{ago(it.release.published_at)}</span>
            </div>
          </div>
          <LinkButton to={`/read/${it.release.id}`} size="sm" className="h-10 self-center" icon={<BookOpen className="size-4" />}>Read</LinkButton>
        </li>
      ))}
    </ul>
  );
}

export function Community() {
  useTitle('Community');
  const { user } = useSession();
  const feed = useQuery({ queryKey: ['community', 'feed'], queryFn: () => api<Feed>('/api/community/feed') });
  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader title="Community" description="New releases from what you follow and what people are talking about." />
      <div className="mb-8 grid gap-3 sm:grid-cols-2">
        <Link to="/forums" className="flex items-center gap-4 rounded-2xl border border-line bg-surface p-4 transition-colors hover:border-line-strong hover:bg-raised">
          <span className="flex size-11 items-center justify-center rounded-xl bg-accent-soft text-accent-hover"><MessagesSquare className="size-6" /></span>
          <span className="min-w-0 flex-1">
            <span className="block font-display text-base font-semibold">Forums</span>
            <span className="block text-sm text-muted">Site-wide boards and a forum for each series</span>
          </span>
          <ChevronRight className="size-5 text-faint" />
        </Link>
        <Link to="/creators" className="flex items-center gap-4 rounded-2xl border border-line bg-surface p-4 transition-colors hover:border-line-strong hover:bg-raised">
          <span className="flex size-11 items-center justify-center rounded-xl bg-accent-soft text-accent-hover"><UserRound className="size-6" /></span>
          <span className="min-w-0 flex-1">
            <span className="block font-display text-base font-semibold">Creators</span>
            <span className="block text-sm text-muted">Find the people and publishers behind the comics</span>
          </span>
          <ChevronRight className="size-5 text-faint" />
        </Link>
      </div>
      {feed.isPending ? (
        <ListSkeleton rows={6} />
      ) : feed.isError ? (
        <ErrorState message={errorMessage(feed.error)} retry={() => feed.refetch()} />
      ) : (
        <div className="grid gap-10 lg:grid-cols-2">
          <section aria-labelledby="feed-releases">
            <h2 id="feed-releases" className="mb-3 text-lg font-semibold">{feed.data.following_releases.length ? 'New from what you follow' : 'New releases'}</h2>
            {feed.data.following_releases.length ? (
              <ReleaseList items={feed.data.following_releases} />
            ) : (
              <div className="space-y-4">
                <Notice tone="info" action={<LinkButton to={user ? '/creators' : '/login?next=/community'} size="sm" className="h-10">{user ? 'Find creators' : 'Sign in'}</LinkButton>}>
                  {user ? 'Nothing new from the series and creators you follow in the last 60 days. Here is what is new across the site.' : 'Sign in and follow series or creators to make this feed your own.'}
                </Notice>
                {feed.data.releases.length ? (
                  <ReleaseList items={feed.data.releases} />
                ) : (
                  <EmptyState icon={<Rss />} title="No new releases right now" action={<LinkButton to="/">Browse the store</LinkButton>}>Nothing has been published in the last 60 days.</EmptyState>
                )}
              </div>
            )}
          </section>
          <section aria-labelledby="feed-threads">
            <div className="mb-3 flex items-center justify-between gap-3">
              <h2 id="feed-threads" className="text-lg font-semibold">Recent forum threads</h2>
              <Link to="/forums" className="text-sm font-medium text-accent-hover hover:text-paper">All forums</Link>
            </div>
            {feed.data.threads.length ? (
              <ThreadList>
                {feed.data.threads.map((t) => <ThreadRow key={t.id} thread={t} place={t.series ? t.series.title : t.board?.label} />)}
              </ThreadList>
            ) : (
              <EmptyState icon={<MessagesSquare />} title="No threads yet" action={<LinkButton to="/forums" variant="primary">Start the first one</LinkButton>}>The forums are quiet. Say hello.</EmptyState>
            )}
          </section>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- forum index

type ForumIndex = {
  boards: (Board & { threads: number; last_post_at: string | null })[];
  series: { id: string; slug: string; title: string; cover_url: string | null; description: string | null; threads: number; last_post_at: string | null }[];
};

export function ForumIndexPage() {
  useTitle('Forums');
  const { meta } = useSession();
  const index = useQuery({ queryKey: ['forums', 'index'], queryFn: () => api<ForumIndex>('/api/forums') });
  // The board list itself comes with the session; the request only adds activity numbers.
  const stats = new Map(index.data?.boards.map((b) => [b.id, b]));
  return (
    <div className="mx-auto max-w-4xl">
      <PageHeader title="Forums" description="Pick a board, or head to the forum of a series you read." back={<Link to="/community" className="inline-flex items-center gap-1 hover:text-paper"><ArrowLeft className="size-4" /> Community</Link>} />
      <section aria-labelledby="boards" className="mb-10">
        <h2 id="boards" className="mb-3 text-lg font-semibold">Boards</h2>
        <ul className="divide-y divide-line overflow-hidden rounded-2xl border border-line bg-surface">
          {meta.forumBoards.map((b) => {
            const s = stats.get(b.id);
            return (
              <li key={b.id}>
                <Link to={`/forums/${b.id}`} className="flex items-center gap-4 px-4 py-4 transition-colors hover:bg-hover">
                  <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-raised text-muted"><MessagesSquare className="size-5" /></span>
                  <span className="min-w-0 flex-1">
                    <span className="block font-display text-base font-semibold">{b.label}</span>
                    <span className="block text-sm text-muted">{BOARD_BLURB[b.id] ?? 'Open discussion'}</span>
                  </span>
                  <span className="shrink-0 text-right text-xs text-muted">
                    {index.isPending ? <span className="block h-4 w-14 animate-pulse rounded bg-raised" /> : (
                      <>
                        <span className="block">{plural(s?.threads ?? 0, 'thread')}</span>
                        {s?.last_post_at && <span className="hidden text-faint sm:block">active {ago(s.last_post_at)}</span>}
                      </>
                    )}
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
      </section>
      <section aria-labelledby="series-forums">
        <h2 id="series-forums" className="mb-3 text-lg font-semibold">Series forums</h2>
        {index.isPending ? (
          <ListSkeleton rows={3} />
        ) : index.isError ? (
          <ErrorState message={errorMessage(index.error)} retry={() => index.refetch()} />
        ) : index.data.series.length === 0 ? (
          <EmptyState icon={<BookOpen />} title="No series forums yet" action={<LinkButton to="/">Browse the store</LinkButton>}>
            Creators can switch on a forum for each of their series. When they do, it is listed here.
          </EmptyState>
        ) : (
          <ul className="grid gap-3 sm:grid-cols-2">
            {index.data.series.map((s) => (
              <li key={s.id}>
                <Link to={`/series/${s.slug}/forum`} className="flex h-full gap-3 rounded-2xl border border-line bg-surface p-3 transition-colors hover:border-line-strong hover:bg-raised">
                  <div className="w-12 shrink-0"><Cover src={s.cover_url} title={s.title} /></div>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-display font-semibold">{s.title}</span>
                    {s.description && <span className="line-clamp-2 block text-sm text-muted">{s.description}</span>}
                    <span className="mt-1 block text-xs text-faint">{plural(s.threads, 'thread')}{s.last_post_at ? ` · active ${ago(s.last_post_at)}` : ''}</span>
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

// ---------------------------------------------------------------- one board / one series forum

type ThreadPage = {
  board: Board | null;
  series: { id: string; slug: string; title: string; description: string | null } | null;
  items: Thread[];
  total: number;
  page: number;
  limit: number;
  can_moderate: boolean;
};

function NewThread({ place, onClose }: { place: { board?: string; series_id?: string; label: string }; onClose: () => void }) {
  const nav = useNavigate();
  const qc = useQueryClient();
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [error, setError] = useState<string | null>(null);
  const create = useMutation({
    mutationFn: () => api<{ thread: Thread }>('/api/forums/threads', { json: { board: place.board, series_id: place.series_id, title, body } }),
    onMutate: () => setError(null),
    onSuccess: (r) => {
      toast.success('Thread posted');
      void qc.invalidateQueries({ queryKey: ['forums'] });
      void qc.invalidateQueries({ queryKey: ['community'] });
      nav(`/forums/thread/${r.thread.id}`);
    },
    onError: (e) => setError(errorMessage(e)),
  });
  return (
    <Modal
      open
      onClose={onClose}
      title={`New thread in ${place.label}`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" type="submit" form="new-thread" loading={create.isPending} disabled={title.trim().length < 3 || !body.trim()}>Post thread</Button>
        </>
      }
    >
      <form
        id="new-thread"
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          create.mutate();
        }}
      >
        {error && <ErrorState message={error} />}
        <Field label="Title" hint="A short summary people can scan.">
          <Input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={140} required minLength={3} autoFocus />
        </Field>
        <Field label="Your post" hint="Mention someone with @username and they are notified.">
          <Textarea value={body} onChange={(e) => setBody(e.target.value)} maxLength={10000} required className="min-h-44" />
        </Field>
      </form>
    </Modal>
  );
}

/** `/forums/:board` and `/series/:slug/forum` share this page. */
export function ForumBoard({ kind }: { kind: 'board' | 'series' }) {
  const { board = '', slug = '' } = useParams();
  const key = kind === 'board' ? board : slug;
  const { user, meta } = useSession();
  const loc = useLocation();
  const [params, setParams] = useSearchParams();
  const page = Math.max(1, Number(params.get('page')) || 1);
  const [writing, setWriting] = useState(false);
  const threads = useQuery({
    queryKey: ['forums', 'threads', kind, key, page],
    queryFn: () => api<ThreadPage>('/api/forums/threads', { query: kind === 'board' ? { board: key, page } : { series: key, page } }),
    retry: (n, e) => !(e instanceof ApiError && [403, 404].includes(e.status)) && n < 2,
  });
  const knownBoard = meta.forumBoards.find((b) => b.id === key);
  const label = kind === 'board' ? (threads.data?.board?.label ?? knownBoard?.label ?? 'Forum') : threads.data?.series ? `${threads.data.series.title} forum` : 'Series forum';
  useTitle(label);
  const back = <Link to="/forums" className="inline-flex items-center gap-1 hover:text-paper"><ArrowLeft className="size-4" /> All forums</Link>;

  if (threads.isError) {
    const e = threads.error;
    const missing = e instanceof ApiError && e.status === 404;
    return (
      <div className="mx-auto max-w-4xl space-y-4">
        <div className="text-sm text-muted">{back}</div>
        {missing ? (
          <EmptyState
            icon={<MessagesSquare />}
            title={kind === 'series' ? 'No forum here' : 'Board not found'}
            action={kind === 'series' ? <LinkButton to={`/series/${slug}`}>Back to the series</LinkButton> : <LinkButton to="/forums">See all forums</LinkButton>}
          >
            {errorMessage(e)}
          </EmptyState>
        ) : (
          <ErrorState message={errorMessage(e)} retry={() => threads.refetch()} />
        )}
      </div>
    );
  }
  const d = threads.data;
  const newButton = user ? (
    <Button variant="primary" icon={<MessageSquarePlus className="size-4" />} disabled={!d} onClick={() => setWriting(true)}>New thread</Button>
  ) : (
    <LinkButton to={`/login?next=${encodeURIComponent(loc.pathname)}`} variant="primary">Sign in to post</LinkButton>
  );
  return (
    <div className="mx-auto max-w-4xl">
      <PageHeader
        back={back}
        title={label}
        description={kind === 'board' ? BOARD_BLURB[key] : d?.series ? d.series.description || <>Talk about <Link className="link" to={`/series/${d.series.slug}`}>{d.series.title}</Link> with other readers.</> : undefined}
        actions={newButton}
      />
      {kind === 'series' && d?.series && d.series.description && (
        <p className="-mt-3 mb-5 text-sm text-muted">Forum for <Link className="link" to={`/series/${d.series.slug}`}>{d.series.title}</Link></p>
      )}
      {threads.isPending ? (
        <ListSkeleton />
      ) : d!.items.length === 0 ? (
        <EmptyState icon={<MessagesSquare />} title="No threads yet" action={user ? <Button onClick={() => setWriting(true)}>Start the first thread</Button> : undefined}>
          {page > 1 ? 'There is nothing on this page.' : 'Be the first to post here.'}
        </EmptyState>
      ) : (
        <>
          <ThreadList>{d!.items.map((t) => <ThreadRow key={t.id} thread={t} />)}</ThreadList>
          <Pagination page={d!.page} pages={Math.ceil(d!.total / d!.limit)} onPage={(p) => setParams({ page: String(p) })} />
        </>
      )}
      {writing && d && <NewThread place={kind === 'board' ? { board: key, label } : { series_id: d.series!.id, label }} onClose={() => setWriting(false)} />}
    </div>
  );
}

// ---------------------------------------------------------------- one thread

type Post = { id: string; body: string; edited_at: string | null; created_at: string; author: Person | null; mine: boolean; can_edit: boolean; can_delete: boolean };
type ThreadDetail = {
  thread: Thread;
  series: { id: string; slug: string; title: string } | null;
  board: Board | null;
  posts: Post[];
  total: number;
  page: number;
  limit: number;
  can_moderate: boolean;
  can_reply: boolean;
};

function PostCard({ post, first, threadKey, onThreadDeleted }: { post: Post; first: boolean; threadKey: unknown[]; onThreadDeleted: () => void }) {
  const qc = useQueryClient();
  const confirm = useConfirm();
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(post.body);
  const save = useMutation({
    mutationFn: () => api(`/api/forums/posts/${post.id}`, { method: 'PATCH', json: { body: text } }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: threadKey });
      setEditing(false);
      toast.success('Post updated');
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const remove = useMutation({
    mutationFn: () => api<{ ok: true; thread_deleted: boolean }>(`/api/forums/posts/${post.id}`, { method: 'DELETE' }),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: ['forums'] });
      if (r.thread_deleted) onThreadDeleted();
      else toast.success('Post deleted');
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const askDelete = async () => {
    const ok = await confirm(
      first
        ? { title: 'Delete the whole thread?', body: 'This is the opening post. Deleting it removes the thread and every reply.', confirmLabel: 'Delete thread', danger: true }
        : { title: 'Delete this post?', body: post.mine ? 'Your post is removed for everyone.' : `This removes ${post.author?.name ?? 'the'} post for everyone. The action is logged.`, confirmLabel: 'Delete post', danger: true },
    );
    if (ok) remove.mutate();
  };
  return (
    <li id={`post-${post.id}`} className="scroll-mt-24">
      <Card className="px-4 py-4 target:border-accent sm:px-5">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
          <PersonLink person={post.author} size={32} />
          <span className="text-xs text-faint" title={dateTime(post.created_at)}>
            {ago(post.created_at)}{post.edited_at ? ` · edited ${ago(post.edited_at)}` : ''}
          </span>
        </div>
        {editing ? (
          <form
            className="space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              if (text.trim()) save.mutate();
            }}
          >
            <label className="sr-only" htmlFor={`edit-${post.id}`}>Edit your post</label>
            <Textarea id={`edit-${post.id}`} value={text} onChange={(e) => setText(e.target.value)} maxLength={10000} required autoFocus className="min-h-32" />
            <div className="flex flex-wrap gap-2">
              <Button type="submit" variant="secondary" loading={save.isPending} disabled={!text.trim() || text.trim() === post.body}>Save changes</Button>
              <Button variant="ghost" onClick={() => { setEditing(false); setText(post.body); }}>Cancel</Button>
            </div>
          </form>
        ) : (
          <PlainText className="text-[15px] leading-relaxed">{post.body}</PlainText>
        )}
        {!editing && (post.can_edit || post.can_delete) && (
          <div className="-mb-1 -ml-2 mt-3 flex flex-wrap gap-1">
            {post.can_edit && <Button size="sm" variant="ghost" className="h-10" icon={<Pencil className="size-4" />} onClick={() => setEditing(true)}>Edit</Button>}
            {post.can_delete && <Button size="sm" variant="ghost" className="h-10" icon={<Trash2 className="size-4" />} loading={remove.isPending} onClick={() => void askDelete()}>Delete</Button>}
          </div>
        )}
      </Card>
    </li>
  );
}

export function ForumThread() {
  const { threadId = '' } = useParams();
  const { user } = useSession();
  const nav = useNavigate();
  const loc = useLocation();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const [params, setParams] = useSearchParams();
  const page = Math.max(1, Number(params.get('page')) || 1);
  const [reply, setReply] = useState('');
  const threadKey = ['forums', 'thread', threadId];
  const detail = useQuery({
    queryKey: [...threadKey, page],
    queryFn: () => api<ThreadDetail>(`/api/forums/threads/${threadId}`, { query: { page } }),
    retry: (n, e) => !(e instanceof ApiError && [403, 404].includes(e.status)) && n < 2,
  });
  const d = detail.data;
  useTitle(d ? d.thread.title : 'Forum thread');
  const pages = d ? Math.max(1, Math.ceil(d.total / d.limit)) : 1;
  const home = d?.series ? { to: `/series/${d.series.slug}/forum`, label: `${d.series.title} forum` } : d?.board ? { to: `/forums/${d.board.id}`, label: d.board.label } : { to: '/forums', label: 'Forums' };

  // Links from notifications point at #post-<id>. Show it, moving to the last page when it is not on this one.
  const wanted = loc.hash.startsWith('#post-') ? loc.hash.slice(1) : null;
  const jumped = useRef<string | null>(null);
  useEffect(() => {
    if (!d || !wanted || jumped.current === `${wanted}:${page}`) return;
    jumped.current = `${wanted}:${page}`;
    const el = document.getElementById(wanted);
    if (el) el.scrollIntoView({ block: 'center' });
    else if (page < pages && !params.get('page')) nav(`${loc.pathname}?page=${pages}${loc.hash}`, { replace: true });
  }, [d, wanted, page, pages, params, nav, loc.pathname, loc.hash]);

  const gone = () => {
    toast.success('Thread deleted');
    void qc.invalidateQueries({ queryKey: ['forums'] });
    void qc.invalidateQueries({ queryKey: ['community'] });
    nav(home.to, { replace: true });
  };
  const post = useMutation({
    mutationFn: () => api<{ post: Post }>(`/api/forums/threads/${threadId}/posts`, { json: { body: reply } }),
    onSuccess: async (r) => {
      setReply('');
      toast.success('Reply posted');
      const total = (d?.total ?? 0) + 1;
      const last = Math.max(1, Math.ceil(total / (d?.limit ?? 30)));
      await qc.invalidateQueries({ queryKey: threadKey });
      nav(`${loc.pathname}${last > 1 ? `?page=${last}` : ''}#post-${r.post.id}`, { replace: true });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const moderate = useMutation({
    mutationFn: (patch: { pinned?: boolean; locked?: boolean }) => api<{ pinned: boolean; locked: boolean }>(`/api/forums/threads/${threadId}`, { method: 'PATCH', json: patch }),
    onSuccess: (r, patch) => {
      toast.success(patch.pinned !== undefined ? (r.pinned ? 'Thread pinned to the top' : 'Thread unpinned') : r.locked ? 'Thread locked' : 'Thread unlocked');
      void qc.invalidateQueries({ queryKey: ['forums'] });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const removeThread = useMutation({
    mutationFn: () => api(`/api/forums/threads/${threadId}`, { method: 'DELETE' }),
    onSuccess: gone,
    onError: (e) => toast.error(errorMessage(e)),
  });

  if (detail.isPending) return <PageLoader label="Loading the thread" />;
  if (detail.isError || !d) {
    const missing = detail.error instanceof ApiError && detail.error.status === 404;
    return (
      <div className="mx-auto max-w-3xl">
        {missing ? (
          <EmptyState icon={<MessagesSquare />} title="Thread not found" action={<LinkButton to="/forums" variant="primary">See all forums</LinkButton>}>It may have been deleted.</EmptyState>
        ) : (
          <ErrorState message={errorMessage(detail.error)} retry={() => detail.refetch()} />
        )}
      </div>
    );
  }
  const t = d.thread;
  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader
        back={<Link to={home.to} className="inline-flex items-center gap-1 hover:text-paper"><ArrowLeft className="size-4" /> {home.label}</Link>}
        title={<span className="break-words [overflow-wrap:anywhere]">{t.title}</span>}
        description={
          <span className="flex flex-wrap items-center gap-2 text-sm">
            {t.pinned && <Badge tone="accent"><Pin className="size-3" aria-hidden />Pinned</Badge>}
            {t.locked && <Badge><Lock className="size-3" aria-hidden />Locked</Badge>}
            <span>Started by {t.author?.name ?? 'a deleted user'} {ago(t.created_at)} · {plural(t.reply_count, 'reply', 'replies')}</span>
          </span>
        }
      />
      {d.can_moderate && (
        <div className="mb-5 flex flex-wrap items-center gap-2 rounded-xl border border-line bg-surface px-3 py-2" role="group" aria-label="Moderator tools">
          <span className="mr-1 text-xs font-semibold uppercase tracking-wide text-muted">Moderator</span>
          <Button size="sm" className="h-10" disabled={moderate.isPending} icon={t.pinned ? <PinOff className="size-4" /> : <Pin className="size-4" />} onClick={() => moderate.mutate({ pinned: !t.pinned })}>{t.pinned ? 'Unpin' : 'Pin'}</Button>
          <Button size="sm" className="h-10" disabled={moderate.isPending} icon={t.locked ? <LockOpen className="size-4" /> : <Lock className="size-4" />} onClick={() => moderate.mutate({ locked: !t.locked })}>{t.locked ? 'Unlock' : 'Lock'}</Button>
          <Button
            size="sm"
            variant="danger"
            className="h-10"
            loading={removeThread.isPending}
            icon={<Trash2 className="size-4" />}
            onClick={async () => {
              if (await confirm({ title: 'Delete this thread?', body: 'The thread and all of its replies are removed for everyone. The action is logged.', confirmLabel: 'Delete thread', danger: true })) removeThread.mutate();
            }}
          >
            Delete thread
          </Button>
        </div>
      )}
      <ol className="space-y-3">
        {d.posts.map((p, i) => <PostCard key={`${p.id}:${p.edited_at ?? ''}`} post={p} first={page === 1 && i === 0} threadKey={threadKey} onThreadDeleted={gone} />)}
      </ol>
      {d.posts.length === 0 && <EmptyState title="Nothing on this page" action={<Button onClick={() => setParams({})}>Go to the first page</Button>} />}
      <Pagination page={d.page} pages={pages} onPage={(p) => setParams(p > 1 ? { page: String(p) } : {})} />

      <section className="mt-8" aria-labelledby="reply-title">
        <h2 id="reply-title" className="mb-3 text-lg font-semibold">Reply</h2>
        {!user ? (
          <Notice tone="info" action={<LinkButton to={`/login?next=${encodeURIComponent(loc.pathname)}`} variant="primary" size="sm" className="h-10">Sign in</LinkButton>}>Sign in to join this conversation.</Notice>
        ) : !d.can_reply ? (
          <Notice tone="warn">This thread is locked. Nobody can add replies.</Notice>
        ) : (
          <form
            className={cx('space-y-3')}
            onSubmit={(e) => {
              e.preventDefault();
              if (reply.trim()) post.mutate();
            }}
          >
            {t.locked && <Notice tone="warn">This thread is locked for everyone else. As a moderator you can still reply.</Notice>}
            <label className="sr-only" htmlFor="reply-body">Your reply</label>
            <Textarea id="reply-body" value={reply} onChange={(e) => setReply(e.target.value)} maxLength={10000} placeholder="Write a reply. Mention someone with @username." className="min-h-32" />
            <Button type="submit" variant="primary" loading={post.isPending} disabled={!reply.trim()}>Post reply</Button>
          </form>
        )}
      </section>
    </div>
  );
}
