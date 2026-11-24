import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { config } from '../config.ts';
import { exec, one, q, tx } from '../db.ts';
import type { Row } from '../db.ts';
import { rateLimit } from '../lib/botblock.ts';
import { TEMPLATES, requireConfirmedEmail, sendTemplate } from '../lib/email.ts';
import { HttpError, audit, badRequest, forbidden, isAdmin, notFound, pageParams, parse, requireUser } from '../lib/http.ts';
import type { SessionUser } from '../lib/http.ts';
import { notify } from '../lib/notify.ts';
import type { NotifyPref } from '../lib/notify.ts';
import { publicUrl } from '../lib/storage.ts';
import { FORUM_BOARDS } from '../lib/taxonomy.ts';
import { CARD_SELECT, assertViewable, findSeries, isBrandMember, isUuid, listable, toCard } from './catalog.ts';

const text = (max: number) => z.string().trim().min(1, 'Write something first').max(max, `Keep it under ${max} characters`);

async function author(r: Row): Promise<Row | null> {
  if (!r.username) return null;
  return { username: r.username, name: r.display_name || r.username, avatar_url: await publicUrl(r.avatar_key) };
}
const AUTHOR = 'u.username, u.display_name, u.avatar_key';

function limited(req: FastifyRequest, what: string, limit: number, seconds: number): void {
  if (!rateLimit(what, req.user?.id ?? req.clientIp, limit, seconds)) throw new HttpError(429, 'You are doing that a lot. Take a short break and try again.');
}

/** In-app notification, plus an email when the reader's `prefs.notify.<pref>` allows it (default on). */
export async function tell(userId: string, pref: NotifyPref, kind: string, title: string, body: string, url: string): Promise<void> {
  await notify(userId, kind, title, body, url);
  const u = await one<{ email: string; prefs: Row }>('select email, prefs from users where id = $1 and deleted_at is null and banned_at is null', [userId]);
  if (!u || u.prefs?.notify?.[pref] === false) return;
  // `notice_reply` and `notice_mention` are editable templates (lib/email.ts TEMPLATES); other kinds are in-app only.
  const key = `notice_${kind}`;
  if (!TEMPLATES[key]) return;
  await sendTemplate(key, u.email, { title, preview: body.slice(0, 300), url: config.appUrl + url }, { userId });
}

/** Notify everyone @mentioned in a post (not the author, at most ten). */
async function mentions(from: SessionUser, body: string, where: string, url: string, skip: string[] = []): Promise<string[]> {
  const names = [...new Set([...body.matchAll(/(?:^|[^A-Za-z0-9_@])@([A-Za-z0-9_]{3,24})\b/g)].map((m) => m[1].toLowerCase()))].slice(0, 10);
  if (!names.length) return [];
  const users = await q<{ id: string }>('select id from users where lower(username) = any($1) and deleted_at is null and banned_at is null and id <> $2', [names, from.id]);
  for (const u of users) {
    if (skip.includes(u.id)) continue;
    await tell(u.id, 'mentions', 'mention', `${from.display_name || from.username} mentioned you in ${where}`, body, url);
  }
  return users.map((u) => u.id);
}

/** Brand members, forum moderators of the series and platform admins. Site-wide boards: admins only. */
async function canModerate(user: SessionUser | null, seriesId: string | null): Promise<boolean> {
  if (!user) return false;
  if (isAdmin(user)) return true;
  if (!seriesId) return false;
  const s = await one<{ publisher_id: string }>('select publisher_id from series where id = $1', [seriesId]);
  if (s && (await isBrandMember(user.id, s.publisher_id))) return true;
  return Boolean(await one('select 1 from forum_moderators where series_id = $1 and user_id = $2', [seriesId, user.id]));
}

const REPORT_KINDS = ['series', 'release', 'comment', 'publisher', 'user', 'forum_post', 'forum_thread'] as const;
const REPORT_TARGETS: Record<(typeof REPORT_KINDS)[number], string> = {
  forum_post: 'select 1 from forum_posts fp join forum_threads t on t.id = fp.thread_id where fp.id = $1 and fp.deleted_at is null and t.deleted_at is null',
  forum_thread: 'select 1 from forum_threads where id = $1 and deleted_at is null',
  series: 'select 1 from series where id = $1 and deleted_at is null',
  release: 'select 1 from releases where id = $1 and deleted_at is null',
  comment: 'select 1 from comments where id = $1 and deleted_at is null',
  publisher: 'select 1 from publishers where id = $1 and deleted_at is null',
  user: 'select 1 from users where id = $1 and deleted_at is null',
};

async function fileReport(req: FastifyRequest, kind: (typeof REPORT_KINDS)[number], id: string, reason: string, detail: string): Promise<void> {
  const u = requireUser(req);
  requireConfirmedEmail(u, 'send a report');
  limited(req, 'report', 20, 3600);
  if (!(await one(REPORT_TARGETS[kind], [id]))) throw notFound('That item no longer exists');
  // One open report per person per item is enough to get it looked at.
  const dup = await one(`select 1 from reports where reporter_id = $1 and target_kind = $2 and target_id = $3 and status = 'open'`, [u.id, kind, id]);
  if (!dup) await exec('insert into reports (reporter_id, target_kind, target_id, reason, detail) values ($1,$2,$3,$4,$5)', [u.id, kind, id, reason, detail]);
}

export default async function socialRoutes(app: FastifyInstance) {
  // ---------------------------------------------------------------- comments

  /** Comments on a series (`?series=<slug or id>`), optionally only one release (`&release=<id>`). Replies are nested one level. */
  app.get('/api/comments', async (req) => {
    const qy = (req.query ?? {}) as Record<string, string>;
    const s = await findSeries(String(qy.series ?? ''));
    if (!s) throw notFound('Series not found');
    await assertViewable(req, s, null);
    const { limit, offset, page } = pageParams(qy, 30, 100);
    const release = isUuid(qy.release) ? qy.release : null;
    const mod = await canModerate(req.user, s.id);
    const scope = `c.series_id = $1 and ($2::uuid is null or c.release_id = $2) and c.deleted_at is null and ($3 or c.hidden_at is null or c.user_id = $4)`;
    const args = [s.id, release, mod, req.user?.id ?? null];
    const top = await q(
      `select c.id, c.release_id, c.parent_id, c.body, c.hidden_at, c.created_at, c.user_id, ${AUTHOR} from comments c left join users u on u.id = c.user_id and u.deleted_at is null
        where ${scope} and c.parent_id is null order by c.created_at desc limit ${limit} offset ${offset}`,
      args,
    );
    const replies = top.length
      ? await q(
          `select c.id, c.release_id, c.parent_id, c.body, c.hidden_at, c.created_at, c.user_id, ${AUTHOR} from comments c left join users u on u.id = c.user_id and u.deleted_at is null
            where ${scope} and c.parent_id = any($5) order by c.created_at`,
          [...args, top.map((c) => c.id)],
        )
      : [];
    const total = await one<{ n: number }>(`select count(*)::int as n from comments c where ${scope} and c.parent_id is null`, args);
    const shape = async (c: Row): Promise<Row> => ({
      id: c.id, release_id: c.release_id, parent_id: c.parent_id, body: c.body, hidden: Boolean(c.hidden_at), created_at: c.created_at, author: await author(c),
      mine: c.user_id === req.user?.id, can_delete: c.user_id === req.user?.id || isAdmin(req.user), can_hide: mod,
    });
    return {
      items: await Promise.all(top.map(async (c) => ({ ...(await shape(c)), replies: await Promise.all(replies.filter((r) => r.parent_id === c.id).map(shape)) }))),
      total: total?.n ?? 0, page, limit, allow_comments: s.allow_comments, can_moderate: mod,
    };
  });

  app.post('/api/comments', async (req) => {
    const u = requireUser(req);
    const body = parse(z.object({ series_id: z.uuid(), release_id: z.uuid().nullish(), parent_id: z.uuid().nullish(), body: text(2000) }), req.body);
    requireConfirmedEmail(u, 'post comments');
    limited(req, 'comment', 20, 600);
    const s = await findSeries(body.series_id);
    if (!s) throw notFound('Series not found');
    const rel = body.release_id ? await one('select * from releases where id = $1 and series_id = $2 and deleted_at is null', [body.release_id, s.id]) : null;
    if (body.release_id && !rel) throw notFound('Release not found');
    await assertViewable(req, s, rel);
    if (!s.allow_comments) throw forbidden('Comments are turned off for this series');
    let parent: Row | null = null;
    if (body.parent_id) {
      parent = await one('select id, user_id, parent_id from comments where id = $1 and series_id = $2 and deleted_at is null', [body.parent_id, s.id]);
      if (!parent) throw notFound('The comment you are replying to is gone');
    }
    // Replies to a reply attach to the same top-level comment.
    const c = await one('insert into comments (user_id, series_id, release_id, parent_id, body) values ($1,$2,$3,$4,$5) returning id, created_at', [
      u.id, s.id, rel?.id ?? null, parent ? (parent.parent_id ?? parent.id) : null, body.body,
    ]);
    const url = rel ? `/read/${rel.id}#comment-${c!.id}` : `/series/${s.slug}#comment-${c!.id}`;
    const told: string[] = [];
    if (parent && parent.user_id !== u.id) {
      await tell(parent.user_id, 'replies', 'reply', `${u.display_name || u.username} replied to your comment on ${s.title}`, body.body, url);
      told.push(parent.user_id);
    }
    await mentions(u, body.body, s.title, url, told);
    return { comment: { id: c!.id, release_id: rel?.id ?? null, parent_id: parent ? (parent.parent_id ?? parent.id) : null, body: body.body, hidden: false, created_at: c!.created_at, author: await author(u), mine: true, can_delete: true, replies: [] } };
  });

  app.delete('/api/comments/:id', async (req) => {
    const u = requireUser(req);
    const c = await one('select id, user_id from comments where id = $1 and deleted_at is null', [(req.params as { id: string }).id]);
    if (!c) throw notFound('Comment not found');
    if (c.user_id !== u.id && !isAdmin(u)) throw forbidden('You can only delete your own comments');
    await exec('update comments set deleted_at = now() where id = $1 or parent_id = $1', [c.id]);
    if (c.user_id !== u.id) audit(req, 'comment.delete', { kind: 'comment', id: c.id });
    return { ok: true };
  });

  /** Brand members, the series' forum moderators and admins can hide (or restore) a comment. */
  app.post('/api/comments/:id/hide', async (req) => {
    const u = requireUser(req);
    const { hidden } = parse(z.object({ hidden: z.boolean().default(true) }), req.body ?? {});
    const c = await one('select id, series_id from comments where id = $1 and deleted_at is null', [(req.params as { id: string }).id]);
    if (!c) throw notFound('Comment not found');
    if (!(await canModerate(u, c.series_id))) throw forbidden('Only the brand team can hide comments here');
    await exec('update comments set hidden_at = case when $2 then coalesce(hidden_at, now()) else null end where id = $1', [c.id, hidden]);
    audit(req, hidden ? 'comment.hide' : 'comment.unhide', { kind: 'comment', id: c.id });
    return { ok: true, hidden };
  });

  const reportBody = z.object({ reason: z.string().trim().min(2, 'Choose a reason').max(80), detail: z.string().trim().max(2000).default('') });
  app.post('/api/comments/:id/report', async (req) => {
    const { id } = req.params as { id: string };
    if (!isUuid(id)) throw notFound('Comment not found');
    const b = parse(reportBody, req.body);
    await fileReport(req, 'comment', id, b.reason, b.detail);
    return { ok: true };
  });

  /** Report a series, release, comment, brand (`publisher`), user, forum post or forum thread to the moderators. */
  app.post('/api/reports', async (req) => {
    const b = parse(reportBody.extend({ target_kind: z.enum(REPORT_KINDS), target_id: z.uuid() }), req.body);
    await fileReport(req, b.target_kind, b.target_id, b.reason, b.detail);
    return { ok: true };
  });

  // ---------------------------------------------------------------- forums

  /** Forum index: the site-wide boards and every series forum that is switched on. */
  app.get('/api/forums', async (req) => {
    const stats = await q<{ board: string; threads: number; last_post_at: string }>(
      `select board, count(*)::int as threads, max(last_post_at) as last_post_at from forum_threads where series_id is null and deleted_at is null group by board`,
    );
    const params: unknown[] = [];
    const series = await q(
      `select s.id, s.slug, s.title, s.cover_key, s.forum_description, t.threads, t.last_post_at
         from series s join publishers p on p.id = s.publisher_id
         left join lateral (select count(*)::int as threads, max(last_post_at) as last_post_at from forum_threads where series_id = s.id and deleted_at is null) t on true
        where s.forum_enabled and ${listable(req, params)} order by t.last_post_at desc nulls last, s.title limit 200`,
      params,
    );
    return {
      boards: FORUM_BOARDS.map((b) => ({ ...b, threads: stats.find((s) => s.board === b.id)?.threads ?? 0, last_post_at: stats.find((s) => s.board === b.id)?.last_post_at ?? null })),
      series: await Promise.all(series.map(async (s) => ({ id: s.id, slug: s.slug, title: s.title, cover_url: await publicUrl(s.cover_key), description: s.forum_description, threads: s.threads ?? 0, last_post_at: s.last_post_at }))),
    };
  });

  /** Where a thread list / new thread lives: `?board=<id>` (site-wide) or `?series=<slug or id>`. */
  const place = async (req: FastifyRequest, src: Row): Promise<{ series: Row | null; board: string }> => {
    if (src.series || src.series_id) {
      const s = await findSeries(String(src.series ?? src.series_id));
      if (!s) throw notFound('Series not found');
      await assertViewable(req, s, null);
      if (!s.forum_enabled) throw notFound('This series does not have a forum');
      return { series: s, board: 'general' };
    }
    const board = String(src.board ?? 'general');
    if (!FORUM_BOARDS.some((b) => b.id === board)) throw notFound('Board not found');
    return { series: null, board };
  };

  const threadShape = async (t: Row): Promise<Row> => ({
    id: t.id, title: t.title, board: t.board, series_id: t.series_id, pinned: t.pinned, locked: t.locked, reply_count: t.reply_count,
    last_post_at: t.last_post_at, created_at: t.created_at, author: await author(t),
  });

  app.get('/api/forums/threads', async (req) => {
    const qy = (req.query ?? {}) as Record<string, string>;
    const { series, board } = await place(req, qy);
    const { limit, offset, page } = pageParams(qy, 30, 100);
    const where = series ? 't.series_id = $1' : 't.series_id is null and t.board = $1';
    const arg = [series ? series.id : board];
    const rows = await q(
      `select t.*, ${AUTHOR} from forum_threads t left join users u on u.id = t.user_id and u.deleted_at is null
        where ${where} and t.deleted_at is null order by t.pinned desc, t.last_post_at desc limit ${limit} offset ${offset}`,
      arg,
    );
    const total = await one<{ n: number }>(`select count(*)::int as n from forum_threads t where ${where} and t.deleted_at is null`, arg);
    return {
      board: series ? null : FORUM_BOARDS.find((b) => b.id === board),
      series: series ? { id: series.id, slug: series.slug, title: series.title, description: series.forum_description } : null,
      items: await Promise.all(rows.map(threadShape)), total: total?.n ?? 0, page, limit, can_moderate: await canModerate(req.user, series?.id ?? null),
    };
  });

  app.post('/api/forums/threads', async (req) => {
    const u = requireUser(req);
    const body = parse(z.object({ board: z.string().optional(), series_id: z.uuid().optional(), title: z.string().trim().min(3, 'Give the thread a title').max(140), body: text(10000) }), req.body);
    requireConfirmedEmail(u, 'start forum threads');
    limited(req, 'thread', 6, 3600);
    const { series, board } = await place(req, body);
    const t = await tx(async (db) => {
      const r = await db.query('insert into forum_threads (series_id, board, user_id, title) values ($1,$2,$3,$4) returning *', [series?.id ?? null, board, u.id, body.title]);
      await db.query('insert into forum_posts (thread_id, user_id, body) values ($1,$2,$3)', [r.rows[0].id, u.id, body.body]);
      return r.rows[0];
    });
    await mentions(u, body.body, `"${body.title}"`, `/forums/thread/${t.id}`);
    return { thread: await threadShape({ ...t, username: u.username, display_name: u.display_name, avatar_key: u.avatar_key }) };
  });

  const thread = async (req: FastifyRequest, id: string) => {
    if (!isUuid(id)) throw notFound('Thread not found');
    const t = await one(`select t.*, ${AUTHOR} from forum_threads t left join users u on u.id = t.user_id and u.deleted_at is null where t.id = $1 and t.deleted_at is null`, [id]);
    if (!t) throw notFound('Thread not found');
    let series: Row | null = null;
    if (t.series_id) {
      series = await one('select * from series where id = $1 and deleted_at is null', [t.series_id]);
      if (!series) throw notFound('Thread not found');
      await assertViewable(req, series, null);
    }
    return { t, series, mod: await canModerate(req.user, t.series_id) };
  };

  app.get('/api/forums/threads/:id', async (req) => {
    const { t, series, mod } = await thread(req, (req.params as { id: string }).id);
    const { limit, offset, page } = pageParams(req.query, 30, 100);
    const posts = await q(
      `select fp.id, fp.body, fp.edited_at, fp.created_at, fp.user_id, ${AUTHOR} from forum_posts fp left join users u on u.id = fp.user_id and u.deleted_at is null
        where fp.thread_id = $1 and fp.deleted_at is null order by fp.created_at, fp.id limit ${limit} offset ${offset}`,
      [t.id],
    );
    const total = await one<{ n: number }>('select count(*)::int as n from forum_posts where thread_id = $1 and deleted_at is null', [t.id]);
    return {
      thread: await threadShape(t),
      series: series ? { id: series.id, slug: series.slug, title: series.title } : null,
      board: series ? null : FORUM_BOARDS.find((b) => b.id === t.board) ?? null,
      posts: await Promise.all(posts.map(async (p) => ({
        id: p.id, body: p.body, edited_at: p.edited_at, created_at: p.created_at, author: await author(p),
        mine: p.user_id === req.user?.id, can_edit: p.user_id === req.user?.id && (!t.locked || mod), can_delete: p.user_id === req.user?.id || mod,
      }))),
      total: total?.n ?? 0, page, limit, can_moderate: mod, can_reply: Boolean(req.user) && (!t.locked || mod),
    };
  });

  app.post('/api/forums/threads/:id/posts', async (req) => {
    const u = requireUser(req);
    const body = parse(z.object({ body: text(10000) }), req.body);
    requireConfirmedEmail(u, 'post in the forums');
    limited(req, 'post', 30, 600);
    const { t, mod } = await thread(req, (req.params as { id: string }).id);
    if (t.locked && !mod) throw forbidden('This thread is locked');
    const p = await tx(async (db) => {
      const r = await db.query('insert into forum_posts (thread_id, user_id, body) values ($1,$2,$3) returning id, created_at', [t.id, u.id, body.body]);
      await db.query('update forum_threads set reply_count = reply_count + 1, last_post_at = now() where id = $1', [t.id]);
      return r.rows[0];
    });
    const url = `/forums/thread/${t.id}#post-${p.id}`;
    const told: string[] = [];
    if (t.user_id !== u.id) {
      await tell(t.user_id, 'replies', 'reply', `${u.display_name || u.username} replied in "${t.title}"`, body.body, url);
      told.push(t.user_id);
    }
    await mentions(u, body.body, `"${t.title}"`, url, told);
    return { post: { id: p.id, body: body.body, edited_at: null, created_at: p.created_at, author: await author(u), mine: true, can_edit: true, can_delete: true } };
  });

  const post = async (req: FastifyRequest) => {
    const { id } = req.params as { id: string };
    const p = isUuid(id) ? await one('select * from forum_posts where id = $1 and deleted_at is null', [id]) : null;
    if (!p) throw notFound('Post not found');
    return { p, ...(await thread(req, p.thread_id)) };
  };

  app.patch('/api/forums/posts/:id', async (req) => {
    const u = requireUser(req);
    const body = parse(z.object({ body: text(10000) }), req.body);
    requireConfirmedEmail(u, 'edit forum posts');
    const { p, t, mod } = await post(req);
    if (p.user_id !== u.id) throw forbidden('You can only edit your own posts');
    if (t.locked && !mod) throw forbidden('This thread is locked');
    await exec('update forum_posts set body = $2, edited_at = now() where id = $1', [p.id, body.body]);
    return { ok: true };
  });

  app.delete('/api/forums/posts/:id', async (req) => {
    const u = requireUser(req);
    const { p, t, mod } = await post(req);
    if (p.user_id !== u.id && !mod) throw forbidden('You can only delete your own posts');
    const first = await one<{ id: string }>('select id from forum_posts where thread_id = $1 order by created_at, id limit 1', [t.id]);
    await tx(async (db) => {
      await db.query('update forum_posts set deleted_at = now() where id = $1', [p.id]);
      // Removing the opening post removes the thread.
      if (first?.id === p.id) await db.query('update forum_threads set deleted_at = now() where id = $1', [t.id]);
      else await db.query('update forum_threads set reply_count = greatest(0, reply_count - 1) where id = $1', [t.id]);
    });
    if (p.user_id !== u.id) audit(req, 'forum.post_delete', { kind: 'forum_post', id: p.id });
    return { ok: true, thread_deleted: first?.id === p.id };
  });

  /** Pin / lock: moderators only. */
  app.patch('/api/forums/threads/:id', async (req) => {
    requireUser(req);
    const body = parse(z.object({ pinned: z.boolean().optional(), locked: z.boolean().optional() }), req.body);
    const { t, mod } = await thread(req, (req.params as { id: string }).id);
    if (!mod) throw forbidden('Only moderators can pin or lock threads');
    const r = await one('update forum_threads set pinned = coalesce($2, pinned), locked = coalesce($3, locked) where id = $1 returning pinned, locked', [t.id, body.pinned ?? null, body.locked ?? null]);
    audit(req, 'forum.thread_update', { kind: 'forum_thread', id: t.id }, body);
    return { ok: true, pinned: r!.pinned, locked: r!.locked };
  });

  app.delete('/api/forums/threads/:id', async (req) => {
    const u = requireUser(req);
    const { t, mod } = await thread(req, (req.params as { id: string }).id);
    if (!mod && t.user_id !== u.id) throw forbidden('Only moderators can delete this thread');
    await exec('update forum_threads set deleted_at = now() where id = $1', [t.id]);
    if (t.user_id !== u.id) audit(req, 'forum.thread_delete', { kind: 'forum_thread', id: t.id });
    return { ok: true };
  });

  // ---------------------------------------------------------------- direct messages

  const other = (c: Row, me: string) => (c.user_a === me ? c.user_b : c.user_a);

  /**
   * THE rule for "may `from` write to `to`", used by both the conversation
   * view (`can_reply`) and the send endpoint so they cannot disagree:
   * the other account must exist and not be banned, and either they accept
   * direct messages, or they have written in this conversation themselves
   * (replying to someone who wrote to you is always allowed), or the sender
   * is platform staff.
   */
  const canMessage = async (from: SessionUser, to: Row | null, conversationId: string | null): Promise<{ ok: boolean; reason: string | null }> => {
    if (!to || to.deleted_at || to.banned_at) return { ok: false, reason: 'This account is no longer here, so the conversation is closed.' };
    if (to.prefs?.allow_dms !== false || isAdmin(from)) return { ok: true, reason: null };
    const tookPart = conversationId ? await one('select 1 from messages where conversation_id = $1 and sender_id = $2 limit 1', [conversationId, to.id]) : null;
    return tookPart ? { ok: true, reason: null } : { ok: false, reason: `${to.display_name || to.username} is not accepting direct messages` };
  };

  app.get('/api/messages/conversations', async (req) => {
    const u = requireUser(req);
    const rows = await q(
      `select c.id, c.last_message_at, c.user_a, c.user_b, ${AUTHOR}, lm.body as last_body, lm.sender_id as last_sender,
              (select count(*)::int from messages m where m.conversation_id = c.id and m.sender_id <> $1 and m.read_at is null) as unread
         from conversations c
         join users u on u.id = case when c.user_a = $1 then c.user_b else c.user_a end
         left join lateral (select body, sender_id from messages m where m.conversation_id = c.id order by m.created_at desc limit 1) lm on true
        where (c.user_a = $1 or c.user_b = $1) and lm.body is not null order by c.last_message_at desc limit 200`,
      [u.id],
    );
    return {
      items: await Promise.all(rows.map(async (c) => ({ id: c.id, with: await author(c), last_message: { body: String(c.last_body).slice(0, 140), mine: c.last_sender === u.id }, last_message_at: c.last_message_at, unread: c.unread }))),
      unread: rows.reduce((n, c) => n + c.unread, 0),
    };
  });

  /** Messages in a conversation, newest page first; opening it marks the other person's messages read. */
  app.get('/api/messages/conversations/:id', async (req) => {
    const u = requireUser(req);
    const { id } = req.params as { id: string };
    const c = isUuid(id) ? await one('select * from conversations where id = $1 and (user_a = $2 or user_b = $2)', [id, u.id]) : null;
    if (!c) throw notFound('Conversation not found');
    const { limit, offset, page } = pageParams(req.query, 50, 100);
    const rows = await q(`select id, sender_id, body, read_at, created_at from messages where conversation_id = $1 order by created_at desc, id desc limit ${limit} offset ${offset}`, [c.id]);
    await exec('update messages set read_at = now() where conversation_id = $1 and sender_id <> $2 and read_at is null', [c.id, u.id]);
    const them = await one(`select u.id, ${AUTHOR}, u.prefs, u.deleted_at, u.banned_at from users u where u.id = $1`, [other(c, u.id)]);
    const may = await canMessage(u, them, c.id);
    return {
      conversation: { id: c.id, with: them && !them.deleted_at ? await author(them) : null, can_reply: may.ok, cannot_reply_reason: may.reason },
      messages: rows.reverse().map((m) => ({ id: m.id, body: m.body, mine: m.sender_id === u.id, read_at: m.read_at, created_at: m.created_at })),
      page, limit,
    };
  });

  /** Send a message to a username (starts the conversation if there is none). */
  app.post('/api/messages', async (req) => {
    const u = requireUser(req);
    const body = parse(z.object({ to: z.string().trim().min(1).max(40), body: text(4000) }), req.body);
    requireConfirmedEmail(u, 'send messages');
    limited(req, 'dm', 40, 3600);
    const to = await one('select id, email, username, display_name, prefs from users where lower(username) = lower($1) and deleted_at is null and banned_at is null', [body.to.replace(/^@/, '')]);
    if (!to) throw notFound('No one with that username');
    if (to.id === u.id) throw badRequest('You cannot message yourself');
    const [a, b] = u.id < to.id ? [u.id, to.id] : [to.id, u.id];
    const existing = await one<{ id: string }>('select id from conversations where user_a = $1 and user_b = $2', [a, b]);
    const may = await canMessage(u, to, existing?.id ?? null);
    if (!may.ok) throw forbidden(may.reason ?? 'You cannot message this person');
    const m = await tx(async (db) => {
      const c = await db.query(
        `insert into conversations (user_a, user_b) values ($1,$2) on conflict (user_a, user_b) do update set last_message_at = now() returning id`,
        [a, b],
      );
      const r = await db.query('insert into messages (conversation_id, sender_id, body) values ($1,$2,$3) returning id, created_at, conversation_id', [c.rows[0].id, u.id, body.body]);
      return r.rows[0];
    });
    const from = u.display_name || u.username;
    await notify(to.id, 'message', `New message from ${from}`, body.body, `/messages/${m.conversation_id}`);
    if (to.prefs?.notify?.messages !== false) {
      await sendTemplate('new_message', to.email, { from, preview: body.body.slice(0, 300), url: `${config.appUrl}/messages/${m.conversation_id}` }, { userId: to.id });
    }
    return { conversation_id: m.conversation_id, message: { id: m.id, body: body.body, mine: true, read_at: null, created_at: m.created_at } };
  });

  // ---------------------------------------------------------------- notifications

  app.get('/api/notifications', async (req) => {
    const u = requireUser(req);
    const { limit, offset, page } = pageParams(req.query, 30, 100);
    const unreadOnly = (req.query as Row)?.unread === '1';
    const rows = await q(
      `select id, kind, title, body, url, read_at, created_at from notifications where user_id = $1 and ($2 = false or read_at is null) order by created_at desc limit ${limit} offset ${offset}`,
      [u.id, unreadOnly],
    );
    const n = await one<{ unread: number; total: number }>('select count(*) filter (where read_at is null)::int as unread, count(*)::int as total from notifications where user_id = $1', [u.id]);
    return { items: rows, unread: n?.unread ?? 0, total: n?.total ?? 0, page, limit };
  });
  app.post('/api/notifications/read-all', async (req) => {
    const u = requireUser(req);
    await exec('update notifications set read_at = now() where user_id = $1 and read_at is null', [u.id]);
    return { ok: true, unread: 0 };
  });
  app.post('/api/notifications/:id/read', async (req) => {
    const u = requireUser(req);
    const { id } = req.params as { id: string };
    if (isUuid(id)) await exec('update notifications set read_at = coalesce(read_at, now()) where id = $1 and user_id = $2', [id, u.id]);
    const n = await one<{ unread: number }>('select count(*)::int as unread from notifications where user_id = $1 and read_at is null', [u.id]);
    return { ok: true, unread: n?.unread ?? 0 };
  });

  // ---------------------------------------------------------------- feedback + community

  /** Lands in the /admin feedback inbox. Works signed out (give an email to get an answer). */
  app.post('/api/feedback', async (req) => {
    const body = parse(
      z.object({ category: z.enum(['general', 'bug', 'idea', 'billing', 'content', 'other']).default('general'), body: text(5000), page_url: z.string().max(500).optional(), email: z.email().max(200).optional() }),
      req.body,
    );
    limited(req, 'feedback', 5, 3600);
    await exec('insert into feedback (user_id, email, category, body, page_url) values ($1,$2,$3,$4,$5)', [req.user?.id ?? null, body.email ?? req.user?.email ?? null, body.category, body.body, body.page_url ?? null]);
    return { ok: true };
  });

  /** Community page: new releases (from what you follow when signed in), newest forum threads, recent comments. */
  app.get('/api/community/feed', async (req) => {
    const u = req.user;
    const releases = async (mine: boolean) => {
      const params: unknown[] = [];
      const vis = listable(req, params);
      params.push(u?.id ?? null);
      const rows = await q(
        `select r.id as release_id, r.number, r.kind, r.title as release_title, r.published_at, r.cover_key as release_cover_key, c.*
           from releases r join lateral (${CARD_SELECT} where s.id = r.series_id and ${vis}) c on true
          where r.status = 'published' and r.deleted_at is null and (not r.mature or $1) and r.published_at > now() - interval '60 days'
            ${mine ? `and (exists (select 1 from follows f where f.user_id = $${params.length} and f.series_id = r.series_id)
                        or exists (select 1 from publisher_follows pf where pf.user_id = $${params.length} and pf.publisher_id = c.publisher_id))` : `and $${params.length}::uuid is not distinct from $${params.length}::uuid`}
          order by r.published_at desc limit 20`,
        params,
      );
      return Promise.all(rows.map(async (r) => ({
        release: { id: r.release_id, number: r.number, kind: r.kind, title: r.release_title, published_at: r.published_at, cover_url: await publicUrl(r.release_cover_key ?? r.cover_key) },
        series: await toCard(r),
      })));
    };
    const followed = u ? await releases(true) : [];
    const tp: unknown[] = [];
    const tvis = listable(req, tp);
    const threads = await q(
      `select t.*, ${AUTHOR}, s.slug as series_slug, s.title as series_title from forum_threads t
         left join users u on u.id = t.user_id and u.deleted_at is null
         left join series s on s.id = t.series_id left join publishers p on p.id = s.publisher_id
        where t.deleted_at is null and (t.series_id is null or (s.forum_enabled and ${tvis})) order by t.last_post_at desc limit 15`,
      tp,
    );
    return {
      following_releases: followed,
      releases: followed.length ? [] : await releases(false),
      threads: await Promise.all(threads.map(async (t) => ({ ...(await threadShape(t)), series: t.series_slug ? { slug: t.series_slug, title: t.series_title } : null, board: t.series_id ? null : FORUM_BOARDS.find((b) => b.id === t.board) ?? null }))),
    };
  });
}
