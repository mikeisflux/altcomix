import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { config } from '../config.ts';
import { exec, one, q, tx } from '../db.ts';
import type { Row } from '../db.ts';
import { adminScope, idParam, isUuid, like, query, where } from '../lib/admin.ts';
import { audit, badRequest, conflict, notFound, pageParams, parse, requireAdmin, requireSuperAdmin } from '../lib/http.ts';
import { blockedSender, domainOf, dropAttachments, onDomain, ownDomains, replySubject, sendFromMailbox } from '../lib/inbound-mail.ts';
import type { Mailbox } from '../lib/inbound-mail.ts';
import { getSetting, setSetting } from '../lib/settings.ts';
import { storage } from '../lib/storage.ts';

/**
 * Admin mailboxes: the mail that arrives through the inbound webhook
 * (routes/webhooks-inbound.ts), read and answered from /admin.
 *
 *   mailboxes        which addresses exist (super admin)
 *   inbox            list, read, file, answer (admin)
 *   blocklist        senders whose mail is dropped (admin)
 *   inbound-mail     the webhook address and its secret (super admin)
 */

const MAILBOX_COLS = 'id, address, name, is_default, active, auto_reply, created_at, updated_at';

const mailboxBody = z.object({
  address: z.email('Enter a full email address, for example support@example.com').trim().toLowerCase().max(200),
  name: z.string().trim().min(1, 'Give the mailbox a name').max(80),
  is_default: z.boolean().default(false),
  active: z.boolean().default(true),
  auto_reply: z.string().trim().max(5000).default(''),
});

const messageText = z.string().trim().min(1, 'Write a message first').max(50_000);

async function assertOwnAddress(address: string): Promise<void> {
  const own = await ownDomains();
  if (!onDomain(domainOf(address), own)) {
    throw badRequest(`This site only receives mail for ${own.join(' and ') || 'its own domain'}. Use an address on that domain.`);
  }
}

async function mailboxOr404(id: string): Promise<Mailbox> {
  const m = await one<Mailbox>(`select ${MAILBOX_COLS} from mailboxes where id = $1`, [id]);
  if (!m) throw notFound('Mailbox not found');
  return m;
}

async function emailOr404(id: string): Promise<Row> {
  const e = await one('select * from inbound_emails where id = $1', [id]);
  if (!e) throw notFound('Email not found');
  return e;
}

const inboundUrl = (token: string): string => `${config.appUrl}/api/webhooks/email/inbound/${token}`;

async function inboundSetup() {
  const token = (await getSetting('email')).inbound_token;
  return {
    enabled: Boolean(token),
    // Shown to super admins only: it has to be pasted into the mail provider.
    url: token ? inboundUrl(token) : null,
    url_base: inboundUrl(''),
    domains: await ownDomains(),
    mx_host: 'mx.sendgrid.net',
    mx_priority: 10,
  };
}

/** `attachment; filename=...` that survives any filename. */
function attachmentDisposition(filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7e]+/g, '_').replace(/["\\]/g, '_') || 'attachment';
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

export default async function adminMailboxRoutes(app: FastifyInstance) {
  await adminScope(app, (s) => {
    // ------------------------------------------------------------ mailboxes

    s.get('/api/admin/mailboxes', async (req) => {
      requireAdmin(req);
      const items = await q(
        `select m.id, m.address, m.name, m.is_default, m.active, m.auto_reply, m.created_at, m.updated_at,
                (select count(*) from inbound_emails e where e.mailbox_id = m.id)::int as total,
                (select count(*) from inbound_emails e where e.mailbox_id = m.id and e.read_at is null and e.archived_at is null and not e.spam)::int as unread
           from mailboxes m order by m.is_default desc, m.created_at`,
      );
      return { items, domains: await ownDomains(), inbound_enabled: Boolean((await getSetting('email')).inbound_token) };
    });

    s.post('/api/admin/mailboxes', async (req) => {
      const actor = requireSuperAdmin(req);
      const b = parse(mailboxBody, req.body);
      await assertOwnAddress(b.address);
      if (await one('select 1 from mailboxes where address = $1', [b.address])) throw conflict(`There is already a mailbox for ${b.address}`);
      const mailbox = await tx(async (db) => {
        const first = !(await one('select 1 from mailboxes limit 1', [], db));
        const makeDefault = b.is_default || first;
        if (makeDefault) await exec('update mailboxes set is_default = false where is_default', [], db);
        return one(`insert into mailboxes (address, name, is_default, active, auto_reply, created_by) values ($1,$2,$3,$4,$5,$6) returning ${MAILBOX_COLS}`,
          [b.address, b.name, makeDefault, b.active, b.auto_reply, actor.id], db);
      });
      audit(req, 'mailbox.create', { kind: 'mailbox', id: mailbox!.id }, { address: b.address });
      return { ok: true, mailbox };
    });

    s.patch('/api/admin/mailboxes/:id', async (req) => {
      requireSuperAdmin(req);
      const id = idParam(req);
      const before = await mailboxOr404(id);
      const b = parse(mailboxBody.partial(), req.body);
      const next = { ...before, ...Object.fromEntries(Object.entries(b).filter(([, v]) => v !== undefined)) } as Mailbox;
      if (next.address !== before.address) {
        await assertOwnAddress(next.address);
        if (await one('select 1 from mailboxes where address = $1 and id <> $2', [next.address, id])) throw conflict(`There is already a mailbox for ${next.address}`);
      }
      const mailbox = await tx(async (db) => {
        if (next.is_default && !before.is_default) await exec('update mailboxes set is_default = false where is_default', [], db);
        return one(`update mailboxes set address = $2, name = $3, is_default = $4, active = $5, auto_reply = $6, updated_at = now() where id = $1 returning ${MAILBOX_COLS}`,
          [id, next.address, next.name, next.is_default, next.active, next.auto_reply], db);
      });
      audit(req, 'mailbox.update', { kind: 'mailbox', id }, { address: next.address, changed: Object.keys(b) });
      return { ok: true, mailbox };
    });

    /** Deletes the mailbox together with its mail and attachments. */
    s.delete('/api/admin/mailboxes/:id', async (req) => {
      requireSuperAdmin(req);
      const id = idParam(req);
      const m = await mailboxOr404(id);
      const count = (await one<{ n: number }>('select count(*)::int as n from inbound_emails where mailbox_id = $1', [id]))!.n;
      await dropAttachments('e.mailbox_id = $1', [id]);
      await exec('delete from mailboxes where id = $1', [id]);
      audit(req, 'mailbox.delete', { kind: 'mailbox', id }, { address: m.address, emails_deleted: count });
      return { ok: true, emails_deleted: count };
    });

    // ------------------------------------------------------------ inbox

    /** Query: mailbox (id), folder = inbox | archived | spam | all, unread=1, q, page, limit. */
    s.get('/api/admin/inbox', async (req) => {
      requireAdmin(req);
      const qy = query(req);
      const { limit, offset, page } = pageParams(req.query, 30, 100);
      const scope = where();
      if (qy.mailbox) {
        if (!isUuid(qy.mailbox)) throw notFound('Mailbox not found');
        scope.add('e.mailbox_id = ?', qy.mailbox);
      }
      const counts = await one(
        `select count(*) filter (where e.archived_at is null and not e.spam)::int as inbox,
                count(*) filter (where e.archived_at is null and not e.spam and e.read_at is null)::int as unread,
                count(*) filter (where e.archived_at is not null and not e.spam)::int as archived,
                count(*) filter (where e.spam)::int as spam
           from inbound_emails e ${scope.sql}`,
        scope.values,
      );
      const w = where();
      if (qy.mailbox) w.add('e.mailbox_id = ?', qy.mailbox);
      const folder = qy.folder ?? 'inbox';
      if (folder === 'inbox') w.add('e.archived_at is null and not e.spam');
      else if (folder === 'archived') w.add('e.archived_at is not null and not e.spam');
      else if (folder === 'spam') w.add('e.spam');
      else if (folder !== 'all') throw badRequest('Unknown folder');
      if (qy.unread === '1' || qy.unread === 'true') w.add('e.read_at is null');
      if (qy.q) w.add('(e.subject ilike ? or e.from_email ilike ? or e.from_name ilike ? or e.text_body ilike ?)', like(qy.q), like(qy.q), like(qy.q), like(qy.q));
      const total = (await one<{ n: number }>(`select count(*)::int as n from inbound_emails e ${w.sql}`, w.values))!.n;
      const items = await q(
        `select e.id, e.mailbox_id, m.name as mailbox_name, m.address as mailbox_address, e.from_email, e.from_name, e.to_email, e.subject,
                left(regexp_replace(e.text_body, '\\s+', ' ', 'g'), 180) as snippet, e.received_at, e.read_at, e.archived_at, e.replied_at,
                e.spam, e.spam_flagged, e.thread_key,
                (select count(*) from inbound_attachments a where a.email_id = e.id)::int as attachment_count
           from inbound_emails e join mailboxes m on m.id = e.mailbox_id
           ${w.sql} order by e.received_at desc limit ${w.param(limit)} offset ${w.param(offset)}`,
        w.values,
      );
      return { items, total, page, limit, counts };
    });

    // ------------------------------------------------------------ blocklist (before /:id so the words are not read as ids)

    s.get('/api/admin/inbox/blocklist', async (req) => {
      requireAdmin(req);
      return { items: await q('select id, kind, value, reason, hits, last_hit_at, created_at from inbound_blocklist order by created_at desc limit 500') };
    });

    s.post('/api/admin/inbox/blocklist', async (req) => {
      const actor = requireAdmin(req);
      const b = parse(z.object({ kind: z.enum(['address', 'domain']), value: z.string().trim().toLowerCase().min(3).max(200), reason: z.string().trim().max(300).default('') }), req.body);
      const value = b.kind === 'domain' ? b.value.replace(/^.*@/, '') : b.value;
      if (b.kind === 'address' ? !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value) : !/^[a-z0-9.-]+\.[a-z]{2,}$/.test(value)) {
        throw badRequest(b.kind === 'address' ? 'Enter a full email address' : 'Enter a domain, for example example.com');
      }
      const entry = await block(actor.id, b.kind, value, b.reason);
      audit(req, 'inbox.block', { kind: 'inbound_blocklist', id: entry.id }, { kind: b.kind, value });
      return { ok: true, entry };
    });

    s.delete('/api/admin/inbox/blocklist/:id', async (req) => {
      requireAdmin(req);
      const id = idParam(req);
      const row = await one('delete from inbound_blocklist where id = $1 returning kind, value', [id]);
      if (!row) throw notFound('That sender is not on the blocked list');
      audit(req, 'inbox.unblock', { kind: 'inbound_blocklist', id }, row);
      return { ok: true };
    });

    // ------------------------------------------------------------ attachments

    /** Always a download, never shown in the browser: the file came from a stranger. */
    s.get('/api/admin/inbox/attachments/:id', async (req, reply) => {
      requireAdmin(req);
      const a = await one('select storage_key, filename, size_bytes from inbound_attachments where id = $1', [idParam(req)]);
      if (!a) throw notFound('Attachment not found');
      const obj = await (await storage()).get(a.storage_key);
      if (!obj) throw notFound('The file for this attachment is missing from storage');
      reply
        .header('content-disposition', attachmentDisposition(a.filename))
        .header('content-security-policy', "sandbox; default-src 'none'")
        .header('content-length', obj.size ?? Number(a.size_bytes))
        .type('application/octet-stream');
      return reply.send(obj.stream);
    });

    // ------------------------------------------------------------ write a new message

    s.post('/api/admin/inbox/compose', async (req) => {
      const actor = requireAdmin(req);
      const b = parse(z.object({
        mailbox_id: z.uuid('Choose the mailbox to send from'),
        to: z.email('Enter the address to send to').trim().toLowerCase().max(200),
        subject: z.string().trim().min(1, 'Enter a subject').max(300),
        body: messageText,
      }), req.body);
      const mailbox = await mailboxOr404(b.mailbox_id);
      if (!mailbox.active) throw badRequest('This mailbox is turned off. Turn it on before sending from it.');
      const sent = await sendFromMailbox({ mailbox, to: b.to, subject: b.subject, text: b.body, kind: 'new', sentBy: actor.id });
      audit(req, 'inbox.compose', { kind: 'mailbox', id: mailbox.id }, { to: b.to, subject: b.subject, email_id: sent.email_id });
      return { ok: true, ...sent };
    });

    // ------------------------------------------------------------ one message

    /** Opening a message marks its whole conversation as read. */
    s.get('/api/admin/inbox/:id', async (req) => {
      requireAdmin(req);
      const id = idParam(req);
      const email = await emailOr404(id);
      await exec('update inbound_emails set read_at = now() where thread_key = $1 and read_at is null', [email.thread_key]);
      const received = await q(
        `select e.id, e.mailbox_id, e.from_email, e.from_name, e.reply_to, e.to_email, e.to_header, e.cc, e.subject, e.text_body, e.html_body, e.received_at as at,
                e.read_at, e.archived_at, e.replied_at, e.spam, e.spam_flagged, e.spam_score, e.spf, e.dkim, e.notes,
                coalesce((select json_agg(json_build_object('id', a.id, 'filename', a.filename, 'content_type', a.content_type, 'size_bytes', a.size_bytes) order by a.created_at)
                            from inbound_attachments a where a.email_id = e.id), '[]'::json) as attachments
           from inbound_emails e where e.thread_key = $1 order by e.received_at limit 200`,
        [email.thread_key],
      );
      const sent = await q(
        `select r.id, r.kind, r.from_email, r.to_email, r.subject, r.text_body, r.created_at as at, r.inbound_id,
                coalesce(em.status, 'unknown') as status, em.error, u.display_name as sent_by_name
           from mailbox_replies r left join emails em on em.id = r.email_id left join users u on u.id = r.sent_by
          where r.thread_key = $1 order by r.created_at limit 200`,
        [email.thread_key],
      );
      const thread = [...received.map((r) => ({ type: 'received', ...r })), ...sent.map((r) => ({ type: 'sent', ...r }))]
        .sort((a, b) => new Date((a as Row).at).getTime() - new Date((b as Row).at).getTime());
      return {
        email: received.find((r) => r.id === id),
        mailbox: await one<Mailbox>(`select ${MAILBOX_COLS} from mailboxes where id = $1`, [email.mailbox_id]),
        thread,
        blocked: await blockedSender(email.from_email),
      };
    });

    s.post('/api/admin/inbox/:id/read', async (req) => {
      requireAdmin(req);
      const id = idParam(req);
      const b = parse(z.object({ read: z.boolean() }), req.body);
      const n = await exec(`update inbound_emails set read_at = ${b.read ? 'coalesce(read_at, now())' : 'null'} where id = $1`, [id]);
      if (!n) throw notFound('Email not found');
      return { ok: true, read: b.read };
    });

    s.post('/api/admin/inbox/:id/archive', async (req) => {
      requireAdmin(req);
      const id = idParam(req);
      const b = parse(z.object({ archived: z.boolean() }), req.body);
      const n = await exec(`update inbound_emails set archived_at = ${b.archived ? 'coalesce(archived_at, now()), read_at = coalesce(read_at, now())' : 'null'} where id = $1`, [id]);
      if (!n) throw notFound('Email not found');
      audit(req, b.archived ? 'inbox.archive' : 'inbox.unarchive', { kind: 'inbound_email', id });
      return { ok: true, archived: b.archived };
    });

    /**
     * Body: { spam, block?: 'address' | 'domain' }. With `block`, the sender (or their whole domain) is
     * added to the blocked list and everything already received from them is filed as spam too.
     */
    s.post('/api/admin/inbox/:id/spam', async (req) => {
      const actor = requireAdmin(req);
      const id = idParam(req);
      const b = parse(z.object({ spam: z.boolean(), block: z.enum(['address', 'domain']).optional() }), req.body);
      const email = await emailOr404(id);
      if (!b.spam) {
        await exec('update inbound_emails set spam = false where id = $1', [id]);
        audit(req, 'inbox.not_spam', { kind: 'inbound_email', id }, { from: email.from_email });
        return { ok: true, spam: false, also_filed: 0, blocked: null };
      }
      await exec('update inbound_emails set spam = true, read_at = coalesce(read_at, now()) where id = $1', [id]);
      let alsoFiled = 0;
      let blocked: Row | null = null;
      if (b.block) {
        const value = b.block === 'domain' ? domainOf(email.from_email) : (email.from_email as string);
        blocked = await block(actor.id, b.block, value, `Marked as spam: "${String(email.subject || '(no subject)').slice(0, 120)}"`);
        alsoFiled = await exec(
          `update inbound_emails set spam = true, read_at = coalesce(read_at, now())
            where not spam and ${b.block === 'domain' ? `(from_email like '%@' || $1 or from_email like '%.' || $1)` : 'from_email = $1'}`,
          [value],
        );
      }
      audit(req, 'inbox.spam', { kind: 'inbound_email', id }, { from: email.from_email, block: b.block ?? null, also_filed: alsoFiled });
      return { ok: true, spam: true, also_filed: alsoFiled, blocked };
    });

    s.delete('/api/admin/inbox/:id', async (req) => {
      requireAdmin(req);
      const id = idParam(req);
      const email = await emailOr404(id);
      await dropAttachments('e.id = $1', [id]);
      await exec('delete from inbound_emails where id = $1', [id]);
      audit(req, 'inbox.delete', { kind: 'inbound_email', id }, { from: email.from_email, subject: email.subject });
      return { ok: true };
    });

    /** Answers from the mailbox the message arrived in, to its Reply-To (or From) address. */
    s.post('/api/admin/inbox/:id/reply', async (req) => {
      const actor = requireAdmin(req);
      const id = idParam(req);
      const b = parse(z.object({ body: messageText }), req.body);
      const email = await emailOr404(id);
      const mailbox = await mailboxOr404(email.mailbox_id);
      const to = (email.reply_to as string | null) || (email.from_email as string);
      const sent = await sendFromMailbox({ mailbox, to, subject: replySubject(email.subject), text: b.body, kind: 'reply', inbound: email, sentBy: actor.id });
      if (sent.status === 'invalid') throw badRequest(`"${to}" is not an address a reply can be sent to`);
      await exec('update inbound_emails set replied_at = now(), read_at = coalesce(read_at, now()) where id = $1', [id]);
      audit(req, 'inbox.reply', { kind: 'inbound_email', id }, { to, email_id: sent.email_id, status: sent.status });
      return { ok: true, to, ...sent };
    });

    // ------------------------------------------------------------ the webhook address (super admin)

    s.get('/api/admin/inbound-mail', async (req) => {
      requireSuperAdmin(req);
      return inboundSetup();
    });

    /** Makes a new secret. The old address stops working within 15 seconds. */
    s.post('/api/admin/inbound-mail/token', async (req) => {
      const actor = requireSuperAdmin(req);
      const had = Boolean((await getSetting('email')).inbound_token);
      await setSetting('email', { inbound_token: randomBytes(32).toString('base64url') }, actor.id);
      audit(req, 'inbound.token', { kind: 'settings', id: 'email' }, { replaced: had });
      return { ok: true, replaced: had, ...(await inboundSetup()) };
    });
  });
}

/** Never let an admin cut the site off from its own mail. */
async function block(actorId: string, kind: 'address' | 'domain', value: string, reason: string): Promise<Row> {
  const own = await ownDomains();
  const domain = kind === 'domain' ? value : domainOf(value);
  if (onDomain(domain, own) || own.some((d) => d.endsWith('.' + domain))) throw badRequest('That is this site\'s own domain. Blocking it would drop the site\'s own mail.');
  const row = await one(
    `insert into inbound_blocklist (kind, value, reason, created_by) values ($1,$2,$3,$4)
     on conflict (kind, value) do update set reason = case when excluded.reason <> '' then excluded.reason else inbound_blocklist.reason end
     returning id, kind, value, reason, hits, last_hit_at, created_at`,
    [kind, value, reason, actorId],
  );
  return row!;
}
