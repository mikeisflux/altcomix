import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { config } from '../config.ts';
import { exec, one, q, tx } from '../db.ts';
import type { Row } from '../db.ts';
import { rateLimit } from '../lib/botblock.ts';
import { TEMPLATES, button, escapeHtml, layout, queueEmail, render } from '../lib/email.ts';
import { HttpError, audit, badRequest, notFound, parse, requireMember } from '../lib/http.ts';
import { idParam, isUuid, requireVerifiedEmail } from '../lib/ingest.ts';
import { getSetting } from '../lib/settings.ts';

/**
 * Studio: Marketing. A brand writes an announcement and it is emailed to the
 * people who follow the brand or any of its series.
 *
 * - Recipients: followers of the brand plus followers of each of its series
 *   (with "notify me" on), one email per person however many things they
 *   follow, minus anyone who turned off "New releases" emails, unsubscribed,
 *   was banned or deleted their account.
 * - The email is the `announcement` template (admins can reword it in /admin),
 *   queued like every other email with `emails.publisher_id` set, so it shows
 *   up in the brand's email analytics.
 * - At most ANNOUNCEMENTS_PER_WEEK per brand in any 7 days, counted from the
 *   table (survives restarts).
 */
export const ANNOUNCEMENTS_PER_WEEK = 3;
const WINDOW = `interval '7 days'`;

const draft = z.object({
  subject: z.string().trim().min(3, 'Write a subject of at least 3 characters').max(120, 'Keep the subject under 120 characters').refine((v) => !/[\r\n]/.test(v), 'The subject must be a single line'),
  body: z.string().trim().min(10, 'Write a message of at least 10 characters').max(5000, 'Keep the message under 5,000 characters'),
  // Optional: adds a button to this series under the message.
  series_id: z.string().refine(isUuid, 'Unknown series').nullable().optional(),
});
type Draft = z.infer<typeof draft>;

const BODY_SLOT = '\u0000announcement-body\u0000';

/** Recipients, de-duplicated by account. `emailable` leaves out the people whose settings say no. */
const AUDIENCE = `
  select u.id, u.email, u.email_unsubscribed_at is null and coalesce((u.prefs->'notify'->>'releases')::boolean, true) as wants
    from users u
   where u.deleted_at is null and u.banned_at is null
     and (exists (select 1 from publisher_follows pf where pf.publisher_id = $1 and pf.user_id = u.id)
       or exists (select 1 from follows f join series s on s.id = f.series_id
                   where s.publisher_id = $1 and s.deleted_at is null and f.user_id = u.id and f.notify))`;

async function audience(brandId: string): Promise<{ followers: number; emailable: number }> {
  return (await one<{ followers: number; emailable: number }>(
    `select count(*)::int as followers, count(*) filter (where a.wants)::int as emailable from (${AUDIENCE}) a`,
    [brandId],
  ))!;
}

async function allowance(brandId: string) {
  const r = (await one<{ used: number; oldest: string | null }>(
    `select count(*)::int as used, min(created_at) as oldest from brand_announcements where publisher_id = $1 and created_at > now() - ${WINDOW}`,
    [brandId],
  ))!;
  const remaining = Math.max(0, ANNOUNCEMENTS_PER_WEEK - r.used);
  return {
    per_week: ANNOUNCEMENTS_PER_WEEK,
    used: r.used,
    remaining,
    // When the oldest one in the window drops out of it.
    next_available_at: remaining === 0 && r.oldest ? new Date(Date.parse(r.oldest) + 7 * 86_400_000).toISOString() : null,
  };
}

async function linkedSeries(brandId: string, seriesId: string | null | undefined): Promise<Row | null> {
  if (!seriesId) return null;
  const s = await one(
    `select id, title, slug from series where id = $1 and publisher_id = $2 and deleted_at is null and takedown_at is null and visibility <> 'draft'`,
    [seriesId, brandId],
  );
  if (!s) throw badRequest('Choose one of this brand\'s published series for the button, or none');
  return s;
}

/** The announcement template with the message as paragraphs (line breaks kept) and an optional series button. */
async function compose(brandName: string, d: Draft, series: Row | null, to: string): Promise<{ subject: string; html: string }> {
  const builtin = TEMPLATES.announcement;
  const override = await one<{ subject: string; html: string }>(`select subject, html from email_templates where key = 'announcement'`);
  const site = await getSetting('site');
  const vars = { site: site.name, subject: d.subject, brand: brandName };
  const subject = render(override?.subject ?? builtin.subject, { ...vars, body: d.body }, false);
  // The template escapes its variables. The message is escaped here instead, so blank lines can become paragraphs.
  const paragraphs = d.body
    .split(/\n{2,}/)
    .map((p) => escapeHtml(p.trim()).replace(/\n/g, '<br>'))
    .filter(Boolean)
    .join('</p><p>');
  let body = render(override?.html ?? builtin.html, { ...vars, body: BODY_SLOT }, true).replace(BODY_SLOT, paragraphs);
  if (series) body += button(`Open ${series.title}`, `${config.appUrl}/series/${encodeURIComponent(series.slug)}?utm_source=announcement&utm_medium=email`);
  return { subject, html: await layout(body, { unsubscribeEmail: to }) };
}

export default async function (app: FastifyInstance) {
  /** Everything the Marketing screen shows: audience size, what is left this week, history with results. */
  app.get('/api/studio/brands/:id/announcements', async (req) => {
    const id = idParam(req);
    await requireMember(req, id, 'admin');
    const [aud, limit, rows, series] = await Promise.all([
      audience(id),
      allowance(id),
      q(
        `select a.id, a.subject, a.body, a.recipients, a.created_at, u.username as sent_by, s.id as series_id, s.title as series_title,
                coalesce(e.queued, 0) as queued, coalesce(e.sent, 0) as sent, coalesce(e.opened, 0) as opened, coalesce(e.clicked, 0) as clicked,
                coalesce(e.failed, 0) as failed
           from brand_announcements a
           left join users u on u.id = a.sent_by
           left join series s on s.id = a.series_id
           left join lateral (
             select count(*) filter (where em.status in ('queued','sending'))::int as queued,
                    count(*) filter (where em.status = 'sent')::int as sent,
                    count(em.opened_at)::int as opened, count(em.clicked_at)::int as clicked,
                    count(*) filter (where em.status in ('failed','suppressed','cancelled'))::int as failed
               from emails em where em.announcement_id = a.id) e on true
          where a.publisher_id = $1 order by a.created_at desc limit 100`,
        [id],
      ),
      q(`select id, title from series where publisher_id = $1 and deleted_at is null and takedown_at is null and visibility <> 'draft' order by title`, [id]),
    ]);
    return { audience: aud, limit, announcements: rows, series, limits: { subject_max: 120, body_max: 5000 } };
  });

  /** The email exactly as a follower would get it, without sending anything. */
  app.post('/api/studio/brands/:id/announcements/preview', async (req) => {
    const id = idParam(req);
    await requireMember(req, id, 'admin');
    const u = req.user!;
    const body = parse(draft, req.body);
    const brand = await one<{ name: string }>('select name from publishers where id = $1 and deleted_at is null', [id]);
    if (!brand) throw notFound('Brand not found');
    const mail = await compose(brand.name, body, await linkedSeries(id, body.series_id), u.email);
    return { ...mail, audience: await audience(id) };
  });

  /** Send the announcement to yourself only. Does not count towards the weekly limit or the brand's email analytics. */
  app.post('/api/studio/brands/:id/announcements/test', async (req) => {
    const id = idParam(req);
    await requireMember(req, id, 'admin');
    const u = requireVerifiedEmail(req);
    const body = parse(draft, req.body);
    if (!rateLimit('announce_test', u.id, 10, 3600)) throw new HttpError(429, 'You have sent several test emails this hour. Try again later.');
    const brand = await one<{ name: string }>('select name from publishers where id = $1 and deleted_at is null', [id]);
    if (!brand) throw notFound('Brand not found');
    const mail = await compose(brand.name, body, await linkedSeries(id, body.series_id), u.email);
    // Sent as a service message so a creator who has unsubscribed from marketing still gets their own test.
    const emailId = await queueEmail({ to: u.email, subject: `[Test] ${mail.subject}`, html: mail.html, template: 'announcement', category: 'transactional', userId: u.id });
    return { ok: true, to: u.email, email_id: emailId };
  });

  /** Send to every follower. */
  app.post('/api/studio/brands/:id/announcements', async (req, reply) => {
    const id = idParam(req);
    await requireMember(req, id, 'admin');
    const u = requireVerifiedEmail(req);
    const body = parse(draft, req.body);
    const series = await linkedSeries(id, body.series_id);

    const { announcement, brandName, recipients } = await tx(async (db) => {
      // One send at a time per brand, so two clicks cannot both pass the weekly limit.
      const brand = (await db.query('select name, suspended_at from publishers where id = $1 and deleted_at is null for update', [id])).rows[0];
      if (!brand) throw notFound('Brand not found');
      if (brand.suspended_at) throw new HttpError(403, 'This brand is suspended and cannot email its followers.');
      const used = (await db.query(`select count(*)::int as n, min(created_at) as oldest from brand_announcements where publisher_id = $1 and created_at > now() - ${WINDOW}`, [id])).rows[0];
      if (used.n >= ANNOUNCEMENTS_PER_WEEK) {
        const next = new Date(Date.parse(used.oldest) + 7 * 86_400_000);
        throw new HttpError(
          429,
          `A brand can send ${ANNOUNCEMENTS_PER_WEEK} announcements in any 7 days, and this one has. The next can go out after ${next.toISOString().slice(0, 16).replace('T', ' ')} UTC.`,
          'announcement_limit',
        );
      }
      const people = (await db.query(`select a.id, a.email from (${AUDIENCE}) a where a.wants order by a.id`, [id])).rows as { id: string; email: string }[];
      if (!people.length) throw badRequest('Nobody who follows this brand can be emailed yet, so there is nothing to send.');
      const ins = await db.query(
        `insert into brand_announcements (publisher_id, series_id, subject, body, recipients, sent_by) values ($1,$2,$3,$4,$5,$6)
         returning id, subject, body, recipients, created_at`,
        [id, series?.id ?? null, body.subject, body.body, people.length, u.id],
      );
      return { announcement: ins.rows[0] as Row, brandName: brand.name as string, recipients: people };
    });

    // Queued after the row is committed; the queue job delivers them. Each person gets their own unsubscribe link.
    let queued = 0;
    for (const p of recipients) {
      const mail = await compose(brandName, body, series, p.email);
      const emailId = await queueEmail({ to: p.email, subject: mail.subject, html: mail.html, template: 'announcement', category: 'marketing', userId: p.id, publisherId: id });
      if (emailId) {
        await exec('update emails set announcement_id = $2 where id = $1', [emailId, announcement.id]);
        queued++;
      }
    }
    audit(req, 'brand.announcement', { kind: 'publisher', id }, { announcement_id: announcement.id, recipients: queued });
    reply.code(201);
    return { announcement: { ...announcement, sent_by: u.username, series_id: series?.id ?? null, series_title: series?.title ?? null }, queued, limit: await allowance(id) };
  });
}
