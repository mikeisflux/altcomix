import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CornerDownRight, Eye, EyeOff, Flag, MessageCircle, Trash2 } from 'lucide-react';
import { useState } from 'react';
import type { FormEvent } from 'react';
import { Link } from 'react-router';
import { api, errorMessage } from '@/lib/api';
import { ago } from '@/lib/format';
import { useSession } from '@/lib/session';
import { Avatar, Badge, Button, ErrorState, LinkButton, Pagination, Skeleton, Textarea, toast, useConfirm } from '@/ui';
import { ConfirmEmailPrompt, ReportDialog, isEmailUnverified, useLoginLink } from './shared';

type Comment = {
  id: string;
  parent_id: string | null;
  body: string;
  hidden: boolean;
  created_at: string;
  author: { username: string; name: string; avatar_url: string | null } | null;
  mine: boolean;
  can_delete: boolean;
  can_hide?: boolean;
  replies?: Comment[];
};
type CommentList = { items: Comment[]; total: number; page: number; limit: number; allow_comments: boolean; can_moderate: boolean };

function Composer({ seriesId, parentId, onDone, autoFocus, label }: { seriesId: string; parentId?: string; onDone: () => void; autoFocus?: boolean; label: string }) {
  const { user } = useSession();
  const [body, setBody] = useState('');
  const [unverified, setUnverified] = useState<string | null>(null);
  const post = useMutation({
    mutationFn: () => api('/api/comments', { json: { series_id: seriesId, parent_id: parentId ?? null, body } }),
    onMutate: () => setUnverified(null),
    onSuccess: () => {
      setBody('');
      toast.success(parentId ? 'Reply posted' : 'Comment posted');
      onDone();
    },
    onError: (e) => (isEmailUnverified(e) ? setUnverified(errorMessage(e)) : toast.error(errorMessage(e))),
  });
  const needsEmail = Boolean(unverified) || Boolean(user && !user.email_verified);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (body.trim()) post.mutate();
  };
  return (
    <form onSubmit={submit} className="space-y-2">
      {needsEmail && <ConfirmEmailPrompt message={unverified ?? 'Confirm your email to post comments. We sent a link to your address when you signed up.'} onConfirmed={() => setUnverified(null)} />}
      <Textarea aria-label={label} placeholder={parentId ? 'Write a reply' : 'What did you think? No spoilers without a warning, please.'} value={body} onChange={(e) => setBody(e.target.value)} maxLength={2000} autoFocus={autoFocus} className={parentId ? 'min-h-20' : undefined} />
      <div className="flex justify-end gap-2">
        {parentId && <Button size="sm" variant="ghost" onClick={onDone}>Cancel</Button>}
        <Button type="submit" size="sm" loading={post.isPending} disabled={!body.trim()}>{parentId ? 'Reply' : 'Post comment'}</Button>
      </div>
    </form>
  );
}

/** Comment thread for a series: list, post, reply, delete your own, report, and hide for the title's team. */
export function Comments({ seriesId, slug }: { seriesId: string; slug: string }) {
  const { user } = useSession();
  const qc = useQueryClient();
  const login = useLoginLink();
  const confirm = useConfirm();
  const [page, setPage] = useState(1);
  const [replyTo, setReplyTo] = useState<string | null>(null);
  const [report, setReport] = useState<Comment | null>(null);
  const key = ['comments', slug, page, user?.id ?? null];
  const list = useQuery({ queryKey: key, queryFn: () => api<CommentList>('/api/comments', { query: { series: slug, page } }) });
  const reload = () => {
    void qc.invalidateQueries({ queryKey: ['comments', slug] });
    void qc.invalidateQueries({ queryKey: ['series', slug] });
  };

  const remove = useMutation({
    mutationFn: (id: string) => api(`/api/comments/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      toast.success('Comment deleted');
      reload();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const hide = useMutation({
    mutationFn: (c: Comment) => api(`/api/comments/${c.id}/hide`, { json: { hidden: !c.hidden } }),
    onSuccess: (_r, c) => {
      toast.success(c.hidden ? 'Comment is visible again' : 'Comment hidden from readers');
      reload();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const askDelete = async (c: Comment) => {
    if (await confirm({ title: 'Delete this comment?', body: c.replies?.length ? 'Its replies are removed too. This cannot be undone.' : 'This cannot be undone.', confirmLabel: 'Delete', danger: true })) remove.mutate(c.id);
  };

  const data = list.data;
  if (data && !data.allow_comments) return null;

  const action = 'inline-flex min-h-10 items-center gap-1 rounded px-1.5 text-xs text-muted hover:text-paper disabled:opacity-50';
  const one = (c: Comment, isReply: boolean) => (
    <div id={`comment-${c.id}`} className="flex gap-3">
      <Avatar src={c.author?.avatar_url} name={c.author?.name ?? 'Deleted account'} size={isReply ? 28 : 36} />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-2 text-sm">
          {c.author ? <Link to={`/u/${c.author.username}`} className="font-semibold hover:text-accent-hover">{c.author.name}</Link> : <span className="font-semibold text-muted">Deleted account</span>}
          <time dateTime={c.created_at} className="text-xs text-faint">{ago(c.created_at)}</time>
          {c.hidden && <Badge tone="warn">Hidden from readers</Badge>}
        </div>
        <p className="mt-1 whitespace-pre-line break-words text-[15px] leading-relaxed text-paper/90">{c.body}</p>
        <div className="-ml-1.5 mt-1 flex flex-wrap items-center gap-x-1">
          {user && !isReply && <button type="button" className={action} onClick={() => setReplyTo(replyTo === c.id ? null : c.id)}><CornerDownRight className="size-3.5" aria-hidden />Reply</button>}
          {c.can_delete && <button type="button" className={action} disabled={remove.isPending} onClick={() => void askDelete(c)}><Trash2 className="size-3.5" aria-hidden />Delete</button>}
          {c.can_hide && !c.mine && <button type="button" className={action} disabled={hide.isPending} onClick={() => hide.mutate(c)}>{c.hidden ? <Eye className="size-3.5" aria-hidden /> : <EyeOff className="size-3.5" aria-hidden />}{c.hidden ? 'Unhide' : 'Hide'}</button>}
          {!c.mine && <button type="button" className={action} onClick={() => setReport(c)}><Flag className="size-3.5" aria-hidden />Report</button>}
        </div>
      </div>
    </div>
  );

  return (
    <section aria-labelledby="comments-h" id="comments">
      <h2 id="comments-h" className="mb-4 text-xl font-bold sm:text-2xl">Comments{data ? <span className="ml-2 text-base font-normal text-muted">{data.total}</span> : null}</h2>

      {user ? (
        <div className="mb-6 flex gap-3">
          <div className="hidden sm:block"><Avatar src={user.avatar_url} name={user.display_name} size={36} /></div>
          <div className="min-w-0 flex-1"><Composer seriesId={seriesId} label="Your comment" onDone={() => { setPage(1); reload(); }} /></div>
        </div>
      ) : (
        <div className="mb-6 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-line bg-surface px-4 py-3 text-sm">
          <span className="text-muted">Sign in to join the conversation.</span>
          <LinkButton to={login} size="sm">Sign in</LinkButton>
        </div>
      )}

      {list.isLoading ? (
        <div className="space-y-4"><Skeleton className="h-16" /><Skeleton className="h-16" /></div>
      ) : list.isError || !data ? (
        <ErrorState message={errorMessage(list.error)} retry={() => void list.refetch()} />
      ) : data.items.length === 0 ? (
        <p className="flex items-center gap-2 py-4 text-sm text-muted"><MessageCircle className="size-4" aria-hidden />No comments yet. {user ? 'Be the first to say something.' : ''}</p>
      ) : (
        <ul className="space-y-6">
          {data.items.map((c) => (
            <li key={c.id}>
              {one(c, false)}
              {((c.replies?.length ?? 0) > 0 || replyTo === c.id) && (
                <div className="ml-4 mt-4 space-y-4 border-l border-line pl-4 sm:ml-[18px] sm:pl-7">
                  {c.replies?.map((r) => <div key={r.id}>{one(r, true)}</div>)}
                  {replyTo === c.id && <Composer seriesId={seriesId} parentId={c.id} autoFocus label={`Reply to ${c.author?.name ?? 'comment'}`} onDone={() => { setReplyTo(null); reload(); }} />}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      {data && <Pagination page={data.page} pages={Math.ceil(data.total / data.limit)} onPage={setPage} />}

      <ReportDialog target={report ? { kind: 'comment', id: report.id, name: 'this comment' } : null} onClose={() => setReport(null)} />
    </section>
  );
}
