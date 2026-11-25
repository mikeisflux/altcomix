import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { exec, one, q } from '../db.ts';
import { adminScope, dateRange, idParam, isUuid, like, query, renderTemplate, where } from '../lib/admin.ts';
import { TEMPLATES, layout, suppress } from '../lib/email.ts';
import { audit, badRequest, conflict, notFound, pageParams, parse, requireAdmin, requireSuperAdmin } from '../lib/http.ts';
import { getSetting, setSetting } from '../lib/settings.ts';

const SAMPLE: Record<string, string> = {
  name: 'Sam Reader', url: 'https://example.com/sample-link', site: 'NSFWComix', total: '$12.00', title: 'Night Ferry #1', message: 'Thanks for backing the book!',
  code: 'ABCD-EFGH-JKLM', brand: 'Harbour Press', inviter: 'Alex Editor', role: 'editor', amount: '$48.20', status: 'approved', note: 'Sent by bank transfer.',
  series: 'Night Ferry', release: 'Issue 2: Low Tide', synopsis: 'The ferry leaves without its captain.', subject: 'Sample subject', body: 'Sample body text.',
  plan: 'monthly', renews: '1 January', year: '2026', limit: '$2,000.00', from: 'Jo Artist', preview: 'Loved the last issue...',
  items: '<table role="presentation" width="100%"><tr><td>Night Ferry #1</td><td align="right">$4.00</td></tr><tr><td>Night Ferry #2</td><td align="right">$8.00</td></tr></table>',
};

const templateBody = z.object({
  subject: z.string().trim().min(1, 'Enter a subject').max(300),
  html: z.string().min(1, 'Enter the message body').max(100_000),
});

function templateKey(req: { params: unknown }): string {
  const key = (req.params as { key: string }).key;
  if (!Object.hasOwn(TEMPLATES, key)) throw notFound('Unknown template');
  return key;
}

/** Placeholders used in a template that the built-in does not supply. */
function unknownVars(key: string, ...texts: string[]): string[] {
  const allowed = new Set([...TEMPLATES[key].vars, 'site']);
  const used = new Set<string>();
  for (const t of texts) {
    for (const m of t.matchAll(/\{\{button:[^|}]+\|(\w+)\}\}|\{\{(\w+)\}\}/g)) used.add(m[1] ?? m[2]);
  }
  return [...used].filter((v) => !allowed.has(v));
}

async function queueState() {
  const em = await getSetting('email');
  const c = await one(
    `select count(*) filter (where status = 'queued')::int as queued,
            count(*) filter (where status = 'queued' and send_after <= now())::int as due,
            count(*) filter (where status = 'sending')::int as sending,
            count(*) filter (where status = 'failed')::int as failed,
            count(*) filter (where status = 'sent' and sent_at > now() - interval '24 hours')::int as sent_24h,
            count(*) filter (where status = 'suppressed' and created_at > now() - interval '24 hours')::int as suppressed_24h,
            count(*) filter (where opened_at > now() - interval '24 hours')::int as opened_24h,
            min(created_at) filter (where status = 'queued' and send_after <= now()) as oldest_due
       from emails where created_at > now() - interval '30 days' or status in ('queued','sending')`,
  );
  return { paused: em.queue_paused, provider: em.provider, ...c };
}

export default async function adminEmailRoutes(app: FastifyInstance) {
  await adminScope(app, (s) => {
    // ------------------------------------------------------------ queue + log
    s.get('/api/admin/emails', async (req) => {
      requireAdmin(req);
      const qy = query(req);
      const { limit, offset, page } = pageParams(req.query, 50, 200);
      const w = where();
      if (qy.status) w.add('e.status = ?', qy.status);
      if (qy.template) w.add('e.template = ?', qy.template);
      if (qy.category) w.add('e.category = ?', qy.category);
      if (qy.recipient) w.add('e.to_email ilike ?', like(qy.recipient));
      if (qy.q) w.add('e.subject ilike ?', like(qy.q));
      if (isUuid(qy.user_id)) w.add('e.user_id = ?', qy.user_id);
      if (isUuid(qy.publisher_id)) w.add('e.publisher_id = ?', qy.publisher_id);
      if (qy.engagement === 'opened') w.add('e.opened_at is not null');
      if (qy.engagement === 'clicked') w.add('e.clicked_at is not null');
      dateRange(w, 'e.created_at', qy);
      const total = (await one<{ n: number }>(`select count(*)::int as n from emails e ${w.sql}`, w.values))!.n;
      const items = await q(
        `select e.id, e.to_email, e.user_id, e.template, e.category, e.subject, e.status, e.attempts, e.provider, e.error,
                e.send_after, e.created_at, e.sent_at, e.opened_at, e.clicked_at
           from emails e ${w.sql} order by e.created_at desc limit ${limit} offset ${offset}`,
        w.values,
      );
      return { items, total, page, limit, queue: await queueState() };
    });

    s.get('/api/admin/emails/queue', async (req) => {
      requireAdmin(req);
      return queueState();
    });

    /** Full message including the rendered HTML (show it in a sandboxed iframe). */
    s.get('/api/admin/emails/:id', async (req) => {
      requireAdmin(req);
      const email = await one(
        `select e.*, u.username, p.name as publisher_name
           from emails e left join users u on u.id = e.user_id left join publishers p on p.id = e.publisher_id where e.id = $1`,
        [idParam(req)],
      );
      if (!email) throw notFound('Email not found');
      const suppression = await one('select reason, source, created_at from email_suppressions where email = $1', [String(email.to_email).toLowerCase()]);
      return { email, suppression };
    });

    s.post('/api/admin/emails/:id/retry', async (req) => {
      requireAdmin(req);
      const id = idParam(req);
      const e = await one<{ status: string; to_email: string }>('select status, to_email from emails where id = $1', [id]);
      if (!e) throw notFound('Email not found');
      if (!['failed', 'suppressed', 'cancelled'].includes(e.status)) throw conflict(`This email is ${e.status}; only failed, suppressed or canceled emails can be retried`);
      if (await one('select 1 from email_suppressions where email = $1', [e.to_email.toLowerCase()])) {
        throw badRequest('This address is on the suppression list. Remove it there first.');
      }
      await exec(`update emails set status = 'queued', attempts = 0, error = null, send_after = now() where id = $1 and status = $2`, [id, e.status]);
      audit(req, 'email.retry', { kind: 'email', id }, { to: e.to_email, was: e.status });
      return { ok: true };
    });

    s.post('/api/admin/emails/:id/cancel', async (req) => {
      requireAdmin(req);
      const id = idParam(req);
      const e = await one(`update emails set status = 'cancelled', error = 'Canceled by an admin' where id = $1 and status = 'queued' returning to_email`, [id]);
      if (!e) {
        if (!(await one('select 1 from emails where id = $1', [id]))) throw notFound('Email not found');
        throw conflict('Only emails still waiting in the queue can be canceled');
      }
      audit(req, 'email.cancel', { kind: 'email', id }, { to: e.to_email });
      return { ok: true };
    });

    /** Requeue every failed email from the last `days` days (default 7), except suppressed addresses. */
    s.post('/api/admin/emails/retry-failed', async (req) => {
      requireAdmin(req);
      const { days } = parse(z.object({ days: z.number().int().min(1).max(90).default(7) }), req.body ?? {});
      const n = await exec(
        `update emails e set status = 'queued', attempts = 0, error = null, send_after = now()
          where e.status = 'failed' and e.created_at > now() - ($1 || ' days')::interval
            and not exists (select 1 from email_suppressions sp where sp.email = lower(e.to_email))`,
        [String(days)],
      );
      audit(req, 'email.retry_failed', undefined, { days, requeued: n });
      return { ok: true, requeued: n };
    });

    s.post('/api/admin/emails/queue/pause', async (req) => {
      const actor = requireSuperAdmin(req);
      await setSetting('email', { queue_paused: true }, actor.id);
      audit(req, 'email.queue_pause');
      return { ok: true, paused: true };
    });

    s.post('/api/admin/emails/queue/resume', async (req) => {
      const actor = requireSuperAdmin(req);
      await setSetting('email', { queue_paused: false }, actor.id);
      audit(req, 'email.queue_resume');
      return { ok: true, paused: false };
    });

    // ------------------------------------------------------------ templates
    s.get('/api/admin/email-templates', async (req) => {
      requireAdmin(req);
      const overrides = new Map((await q('select t.key, t.subject, t.html, t.updated_at, u.username from email_templates t left join users u on u.id = t.updated_by')).map((r) => [r.key, r]));
      return {
        items: Object.entries(TEMPLATES).map(([key, t]) => {
          const o = overrides.get(key);
          return {
            key,
            category: t.category,
            vars: [...new Set([...t.vars, 'site'])],
            customized: Boolean(o),
            subject: o?.subject ?? t.subject,
            html: o?.html ?? t.html,
            default_subject: t.subject,
            default_html: t.html,
            updated_at: o?.updated_at ?? null,
            updated_by_username: o?.username ?? null,
          };
        }),
        syntax: 'Use {{name}} for a value and {{button:Label|url}} for a button that links to the "url" value.',
      };
    });

    s.put('/api/admin/email-templates/:key', async (req) => {
      const actor = requireSuperAdmin(req);
      const key = templateKey(req);
      const body = parse(templateBody, req.body);
      const unknown = unknownVars(key, body.subject, body.html);
      if (unknown.length) throw badRequest(`This template has no value called ${unknown.map((v) => `{{${v}}}`).join(', ')}. Available: ${[...new Set([...TEMPLATES[key].vars, 'site'])].join(', ')}`);
      if (/<script|javascript:|\son\w+\s*=/i.test(body.html)) throw badRequest('Email HTML cannot contain scripts or event handlers');
      await exec(
        `insert into email_templates (key, subject, html, updated_by) values ($1,$2,$3,$4)
         on conflict (key) do update set subject = excluded.subject, html = excluded.html, updated_by = excluded.updated_by, updated_at = now()`,
        [key, body.subject, body.html, actor.id],
      );
      audit(req, 'email_template.save', { kind: 'email_template', id: key }, { subject: body.subject, html_length: body.html.length });
      return { ok: true };
    });

    /** Back to the built-in wording. */
    s.delete('/api/admin/email-templates/:key', async (req) => {
      requireSuperAdmin(req);
      const key = templateKey(req);
      const n = await exec('delete from email_templates where key = $1', [key]);
      if (n) audit(req, 'email_template.reset', { kind: 'email_template', id: key });
      return { ok: true, reset: n > 0 };
    });

    /** Render with sample values. Send `subject`/`html` to preview unsaved edits. */
    s.post('/api/admin/email-templates/:key/preview', async (req) => {
      requireAdmin(req);
      const key = templateKey(req);
      const body = parse(templateBody.partial().extend({ vars: z.record(z.string(), z.string().max(5000)).optional() }), req.body ?? {});
      const builtin = TEMPLATES[key];
      const saved = await one<{ subject: string; html: string }>('select subject, html from email_templates where key = $1', [key]);
      const site = await getSetting('site');
      const vars = { ...SAMPLE, site: site.name, ...(body.vars ?? {}) };
      const subject = renderTemplate(body.subject ?? saved?.subject ?? builtin.subject, vars, false);
      const inner = renderTemplate(body.html ?? saved?.html ?? builtin.html, vars, true);
      const html = await layout(inner, builtin.category === 'transactional' ? {} : { unsubscribeEmail: 'reader@example.com' });
      return { subject, html, unknown_vars: unknownVars(key, body.subject ?? '', body.html ?? '') };
    });

    // ------------------------------------------------------------ suppression list
    s.get('/api/admin/email-suppressions', async (req) => {
      requireAdmin(req);
      const qy = query(req);
      const { limit, offset, page } = pageParams(req.query, 50, 500);
      const w = where();
      if (qy.q) w.add('email ilike ?', like(qy.q));
      if (qy.source) w.add('source = ?', qy.source);
      const total = (await one<{ n: number }>(`select count(*)::int as n from email_suppressions ${w.sql}`, w.values))!.n;
      const items = await q(`select email, reason, source, created_at from email_suppressions ${w.sql} order by created_at desc limit ${limit} offset ${offset}`, w.values);
      return { items, total, page, limit };
    });

    s.post('/api/admin/email-suppressions', async (req) => {
      requireAdmin(req);
      const body = parse(z.object({ email: z.email('Enter a valid email address').max(200), reason: z.string().trim().min(2).max(300).default('Added by an admin') }), req.body);
      await suppress(body.email, body.reason, 'manual');
      audit(req, 'email_suppression.add', { kind: 'email', id: body.email.toLowerCase() }, { reason: body.reason });
      return { ok: true };
    });

    s.delete('/api/admin/email-suppressions/:email', async (req) => {
      requireAdmin(req);
      const email = (req.params as { email: string }).email.toLowerCase();
      const row = await one('delete from email_suppressions where email = $1 returning reason, source', [email]);
      if (!row) throw notFound('That address is not on the suppression list');
      audit(req, 'email_suppression.remove', { kind: 'email', id: email }, { reason: row.reason, source: row.source });
      return { ok: true };
    });
  });
}
