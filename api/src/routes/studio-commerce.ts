import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { config } from '../config.ts';
import { exec, one, patch, pool, q, tx } from '../db.ts';
import type { Queryable } from '../db.ts';
import { rateLimit } from '../lib/botblock.ts';
import { randomCode } from '../lib/crypto.ts';
import { alertAdmins, sendTemplate } from '../lib/email.ts';
import { HttpError, audit, badRequest, conflict, notFound, pageParams, parse, requireMember } from '../lib/http.ts';
import { coverThumbKey, idParam, isUuid, parseCsv, requireVerifiedEmail, sendCsv } from '../lib/ingest.ts';
import { getSetting } from '../lib/settings.ts';
import { publicUrl } from '../lib/storage.ts';

/** Studio: promo codes, bundles, discounts, earnings and payout requests. */

const EMAIL = /^[^@\s,;]+@[^@\s,;]+\.[^@\s,;]+$/;
const uuid = (what: string) => z.string().refine(isUuid, `Unknown ${what}`);
const instant = z
  .string()
  .refine((v) => !Number.isNaN(Date.parse(v)), 'Use a date and time like 2027-03-14T18:00:00Z')
  .transform((v) => new Date(v).toISOString());

// What a code does. Shared by single codes, bulk batches and CSV imports.
const codeSpec = z.object({
  kind: z.enum(['unlock', 'discount']),
  // unlock: exactly one of these (a release, or every release of a series).
  // discount: optional; neither = anything this brand sells.
  series_id: uuid('series').nullable().optional(),
  release_id: uuid('release').nullable().optional(),
  // unlock only: the code also grants the download.
  includes_download: z.boolean().optional(),
  // discount only.
  percent_off: z.number().int().min(1).max(100).nullable().optional(),
  starts_at: instant.nullable().optional(),
  expires_at: instant.nullable().optional(),
});
type CodeSpec = z.infer<typeof codeSpec>;

async function checkSpec(brandId: string, spec: CodeSpec): Promise<Required<CodeSpec>> {
  const series_id = spec.series_id ?? null;
  const release_id = spec.release_id ?? null;
  if (series_id && release_id) throw badRequest('Choose a release or a whole series, not both');
  if (spec.kind === 'unlock') {
    if (!series_id && !release_id) throw badRequest('Choose the release or series this code unlocks');
    if (spec.percent_off) throw badRequest('An unlock code has no percentage. Use a discount code for that.');
  } else {
    if (!spec.percent_off) throw badRequest('Enter the percentage this code takes off');
    if (spec.includes_download) throw badRequest('Only unlock codes can include the download');
  }
  if (series_id && !(await one('select 1 from series where id = $1 and publisher_id = $2 and deleted_at is null', [series_id, brandId]))) {
    throw badRequest('That series does not belong to this brand');
  }
  if (
    release_id &&
    !(await one(
      'select 1 from releases r join series s on s.id = r.series_id where r.id = $1 and s.publisher_id = $2 and r.deleted_at is null and s.deleted_at is null',
      [release_id, brandId],
    ))
  ) {
    throw badRequest('That release does not belong to this brand');
  }
  if (spec.starts_at && spec.expires_at && spec.expires_at <= spec.starts_at) throw badRequest('The code expires before it starts');
  return {
    kind: spec.kind, series_id, release_id, includes_download: spec.kind === 'unlock' ? (spec.includes_download ?? false) : false,
    percent_off: spec.kind === 'discount' ? spec.percent_off! : null, starts_at: spec.starts_at ?? null, expires_at: spec.expires_at ?? null,
  };
}

const CODE_SELECT = `
  select c.id, c.code, c.kind, c.series_id, c.release_id, c.percent_off, c.includes_download, c.max_redemptions, c.redeemed_count,
         c.batch_label, c.batch_id, c.assigned_email, c.sent_at, c.starts_at, c.expires_at, c.disabled_at is not null as disabled,
         c.created_at, coalesce(r.title, s.title) as scope_title,
         case when c.release_id is not null then 'release' when c.series_id is not null then 'series' else 'brand' end as scope
    from promo_codes c
    left join releases r on r.id = c.release_id
    left join series s on s.id = c.series_id`;

/** Insert `count` fresh unique codes; `emails[i]`, when given, is assigned to the i-th code. */
async function generateCodes(
  db: Queryable, brandId: string, spec: Required<CodeSpec>, count: number,
  opts: { batchId: string; batchLabel: string; emails?: string[]; userId: string },
): Promise<number> {
  // Settle on codes nobody uses yet, then insert them in one statement.
  const codes: string[] = [];
  for (let round = 0; codes.length < count && round < 20; round++) {
    const fresh = [...new Set(Array.from({ length: count - codes.length }, () => randomCode()))].filter((c) => !codes.includes(c));
    const taken = new Set((await db.query('select upper(code) as code from promo_codes where upper(code) = any($1::text[])', [fresh])).rows.map((r) => r.code));
    codes.push(...fresh.filter((c) => !taken.has(c)));
  }
  if (codes.length < count) throw new HttpError(503, 'Could not generate enough unique codes. Try again.');
  const emails = codes.map((_c, i) => opts.emails?.[i] ?? null);
  const ins = await db.query(
    `insert into promo_codes (publisher_id, code, kind, series_id, release_id, percent_off, includes_download, max_redemptions,
                              batch_label, batch_id, assigned_email, starts_at, expires_at, created_by)
     select $1, x.code, $2, $3, $4, $5, $6, 1, $7, $8, x.email, $9, $10, $11
       from unnest($12::text[], $13::text[]) as x(code, email)`,
    [brandId, spec.kind, spec.series_id, spec.release_id, spec.percent_off, spec.includes_download, opts.batchLabel, opts.batchId,
     spec.starts_at, spec.expires_at, opts.userId, codes, emails],
  );
  return ins.rowCount ?? 0;
}

/** Pull email addresses out of pasted CSV text (a column headed "email", or any cell that looks like one). */
function emailsFromCsv(text: string): { emails: string[]; invalid: number } {
  const rows = parseCsv(text);
  if (!rows.length) return { emails: [], invalid: 0 };
  const header = rows[0].map((h) => h.trim().toLowerCase());
  let col = header.findIndex((h) => h === 'email' || h === 'e-mail' || h.includes('email'));
  const body = col >= 0 ? rows.slice(1) : rows;
  if (col < 0) col = rows[0].findIndex((c) => EMAIL.test(c.trim()));
  if (col < 0) col = 0;
  const seen = new Set<string>();
  let invalid = 0;
  for (const r of body) {
    const v = (r[col] ?? '').trim().toLowerCase();
    if (!v) continue;
    if (!EMAIL.test(v) || v.length > 200) invalid++;
    else seen.add(v);
  }
  return { emails: [...seen], invalid };
}

export default async function (app: FastifyInstance) {
  // ------------------------------------------------------------ promo codes

  app.get('/api/studio/brands/:id/codes', async (req) => {
    const id = idParam(req);
    await requireMember(req, id, 'editor');
    const query = parse(
      z.object({ batch_id: z.string().optional(), q: z.string().trim().max(100).optional(), single: z.string().optional() }),
      req.query,
    );
    if (query.batch_id && !isUuid(query.batch_id)) throw notFound('Batch not found');
    const { limit, offset, page } = pageParams(req.query, 50, 500);
    const where = `c.publisher_id = $1
      and ($2::uuid is null or c.batch_id = $2)
      and ($3::text is null or c.code ilike '%' || $3 || '%' or c.assigned_email ilike '%' || $3 || '%' or c.batch_label ilike '%' || $3 || '%')
      and ($4::boolean is not true or c.batch_id is null)`;
    const args = [id, query.batch_id ?? null, query.q || null, query.single === '1' || query.single === 'true'];
    const total = await one<{ n: number }>(`select count(*)::int as n from promo_codes c where ${where}`, args);
    const codes = await q(`${CODE_SELECT} where ${where} order by c.created_at desc, c.id desc limit $5 offset $6`, [...args, limit, offset]);
    return { codes, total: total!.n, page, limit };
  });

  app.post('/api/studio/brands/:id/codes', async (req, reply) => {
    const id = idParam(req);
    await requireMember(req, id, 'admin');
    const body = parse(
      codeSpec.extend({
        // Leave out to get a random code like ABCD-EFGH-JKLM.
        code: z.string().trim().toUpperCase().regex(/^[A-Z0-9][A-Z0-9-]{3,38}[A-Z0-9]$/, 'Use 5-40 letters, numbers and dashes').optional(),
        // null = unlimited.
        max_redemptions: z.number().int().min(1).max(1_000_000).nullable().optional(),
        assigned_email: z.string().trim().toLowerCase().regex(EMAIL, 'Enter a valid email address').max(200).nullable().optional(),
      }),
      req.body,
    );
    const spec = await checkSpec(id, body);
    let row: { id: string } | null = null;
    for (let attempt = 0; attempt < 5 && !row; attempt++) {
      try {
        row = await one<{ id: string }>(
          `insert into promo_codes (publisher_id, code, kind, series_id, release_id, percent_off, includes_download, max_redemptions,
                                    assigned_email, starts_at, expires_at, created_by)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) returning id`,
          [id, body.code ?? randomCode(), spec.kind, spec.series_id, spec.release_id, spec.percent_off, spec.includes_download,
           body.max_redemptions ?? null, body.assigned_email ?? null, spec.starts_at, spec.expires_at, req.user!.id],
        );
      } catch (e) {
        if ((e as { code?: string }).code !== '23505') throw e;
        if (body.code) throw conflict('That code is already in use. Choose another.');
      }
    }
    if (!row) throw new HttpError(503, 'Could not generate a unique code. Try again.');
    audit(req, 'code.create', { kind: 'publisher', id }, { code_id: row.id, kind: spec.kind });
    reply.code(201);
    return { code: await one(`${CODE_SELECT} where c.id = $1`, [row.id]) };
  });

  const ownCode = async (req: FastifyRequest, brandId: string) => {
    const code = await one('select * from promo_codes where id = $1 and publisher_id = $2', [idParam(req, 'codeId'), brandId]);
    if (!code) throw notFound('Code not found');
    return code;
  };

  app.patch('/api/studio/brands/:id/codes/:codeId', async (req) => {
    const id = idParam(req);
    await requireMember(req, id, 'admin');
    const code = await ownCode(req, id);
    const body = parse(
      z.object({
        disabled: z.boolean().optional(),
        max_redemptions: z.number().int().min(1).max(1_000_000).nullable().optional(),
        assigned_email: z.string().trim().toLowerCase().regex(EMAIL, 'Enter a valid email address').max(200).nullable().optional(),
        starts_at: instant.nullable().optional(),
        expires_at: instant.nullable().optional(),
      }),
      req.body,
    );
    if (body.max_redemptions != null && body.max_redemptions < code.redeemed_count) {
      throw badRequest(`This code has already been redeemed ${code.redeemed_count} times`);
    }
    const { sets, values } = patch(body, ['max_redemptions', 'assigned_email', 'starts_at', 'expires_at'], 2);
    if (body.disabled !== undefined) sets.push(body.disabled ? 'disabled_at = coalesce(disabled_at, now())' : 'disabled_at = null');
    if (body.assigned_email !== undefined && body.assigned_email !== code.assigned_email) sets.push('sent_at = null');
    if (sets.length) await exec(`update promo_codes set ${sets.join(', ')} where id = $1`, [code.id, ...values]);
    return { code: await one(`${CODE_SELECT} where c.id = $1`, [code.id]) };
  });

  app.delete('/api/studio/brands/:id/codes/:codeId', async (req) => {
    const id = idParam(req);
    await requireMember(req, id, 'admin');
    const code = await ownCode(req, id);
    if (code.redeemed_count > 0) throw conflict('This code has been redeemed, so it is kept for the record. Disable it instead.');
    await exec('delete from promo_codes where id = $1', [code.id]);
    audit(req, 'code.delete', { kind: 'publisher', id }, { code_id: code.id });
    return { ok: true };
  });

  // ------------------------------------------------------------ batches (backer / reward-tier codes)

  const BATCH_SELECT = `
    select c.batch_id, min(c.batch_label) as batch_label, min(c.kind) as kind, min(c.series_id::text)::uuid as series_id,
           min(c.release_id::text)::uuid as release_id, bool_or(c.includes_download) as includes_download, min(c.percent_off) as percent_off,
           min(coalesce(r.title, s.title)) as scope_title, min(c.expires_at) as expires_at,
           count(*)::int as total, count(*) filter (where c.redeemed_count > 0)::int as redeemed,
           count(c.assigned_email)::int as assigned, count(c.sent_at)::int as sent,
           count(*) filter (where c.disabled_at is not null)::int as disabled_count,
           bool_and(c.disabled_at is not null) as disabled, min(c.created_at) as created_at
      from promo_codes c
      left join releases r on r.id = c.release_id
      left join series s on s.id = c.series_id
     where c.publisher_id = $1 and c.batch_id is not null`;

  const batchOf = async (req: FastifyRequest, brandId: string) => {
    const batch = await one(`${BATCH_SELECT} and c.batch_id = $2 group by c.batch_id`, [brandId, idParam(req, 'batchId')]);
    if (!batch) throw notFound('Batch not found');
    return batch;
  };

  app.get('/api/studio/brands/:id/code-batches', async (req) => {
    const id = idParam(req);
    await requireMember(req, id, 'editor');
    return { batches: await q(`${BATCH_SELECT} group by c.batch_id order by min(c.created_at) desc`, [id]) };
  });

  /** N single-use codes sharing a label, e.g. one batch per reward tier. */
  app.post('/api/studio/brands/:id/codes/bulk', async (req, reply) => {
    const id = idParam(req);
    await requireMember(req, id, 'admin');
    const body = parse(
      codeSpec.extend({
        count: z.number().int().min(1, 'Generate at least 1 code').max(5000, 'Generate at most 5000 codes at a time'),
        batch_label: z.string().trim().min(1, 'Name this batch, e.g. the reward tier').max(80),
      }),
      req.body,
    );
    const spec = await checkSpec(id, body);
    if (!rateLimit('code_bulk', id, 40, 3600)) throw new HttpError(429, 'Too many batches generated in the last hour. Try again later.');
    const { id: batchId } = (await one<{ id: string }>('select uuidv7() as id'))!;
    await tx((db) => generateCodes(db, id, spec, body.count, { batchId, batchLabel: body.batch_label, userId: req.user!.id }));
    audit(req, 'code.bulk', { kind: 'publisher', id }, { batch_id: batchId, count: body.count, label: body.batch_label });
    reply.code(201);
    return { batch_id: batchId, created: body.count, batch: await one(`${BATCH_SELECT} and c.batch_id = $2 group by c.batch_id`, [id, batchId]) };
  });

  /**
   * Backer list import: one code per email address. Either start a new batch
   * (`batch_label` + what the codes do) or add to an existing one (`batch_id`),
   * where unassigned codes are handed out first and more are made if needed.
   */
  app.post('/api/studio/brands/:id/codes/import', async (req, reply) => {
    const id = idParam(req);
    await requireMember(req, id, 'admin');
    const body = parse(
      codeSpec.partial().extend({
        // CSV text (a column headed "email", or one address per line) ...
        csv: z.string().max(1_900_000).optional(),
        // ... or the addresses themselves.
        emails: z.array(z.string()).max(5000).optional(),
        batch_id: uuid('batch').optional(),
        batch_label: z.string().trim().min(1).max(80).optional(),
      }),
      req.body,
    );
    const parsed = body.csv !== undefined ? emailsFromCsv(body.csv) : emailsFromCsv((body.emails ?? []).join('\n'));
    if (!parsed.emails.length) throw badRequest('No email addresses were found. Use a column headed "email" or one address per line.');
    if (parsed.emails.length > 5000) throw badRequest('Import at most 5000 backers at a time');
    if (!rateLimit('code_bulk', id, 40, 3600)) throw new HttpError(429, 'Too many batches generated in the last hour. Try again later.');

    let batchId: string;
    let label: string;
    let spec: Required<CodeSpec>;
    if (body.batch_id) {
      const first = await one('select * from promo_codes where publisher_id = $1 and batch_id = $2 order by created_at limit 1', [id, body.batch_id]);
      if (!first) throw notFound('Batch not found');
      batchId = body.batch_id;
      label = first.batch_label;
      spec = {
        kind: first.kind, series_id: first.series_id, release_id: first.release_id, includes_download: first.includes_download,
        percent_off: first.percent_off, starts_at: first.starts_at, expires_at: first.expires_at,
      };
    } else {
      if (!body.batch_label) throw badRequest('Name this batch, e.g. the reward tier');
      if (!body.kind) throw badRequest('Choose what these codes do (unlock or discount)');
      spec = await checkSpec(id, body as CodeSpec);
      batchId = (await one<{ id: string }>('select uuidv7() as id'))!.id;
      label = body.batch_label;
    }

    const result = await tx(async (db) => {
      await db.query('select pg_advisory_xact_lock(hashtext($1))', [batchId]);
      const have = new Set(
        (await db.query('select lower(assigned_email) as e from promo_codes where batch_id = $1 and assigned_email is not null', [batchId])).rows.map((r) => r.e),
      );
      const fresh = parsed.emails.filter((e) => !have.has(e));
      // Hand out codes already in the batch that nobody holds yet.
      const spare = await db.query(
        `select id from promo_codes where batch_id = $1 and assigned_email is null and redeemed_count = 0 and disabled_at is null
          order by created_at, id limit $2 for update`,
        [batchId, fresh.length],
      );
      const reuse = fresh.slice(0, spare.rows.length);
      if (reuse.length) {
        await db.query(
          `update promo_codes c set assigned_email = x.email
             from unnest($1::uuid[], $2::text[]) as x(id, email) where c.id = x.id`,
          [spare.rows.map((r) => r.id), reuse],
        );
      }
      const rest = fresh.slice(reuse.length);
      if (rest.length) await generateCodes(db, id, spec, rest.length, { batchId, batchLabel: label, emails: rest, userId: req.user!.id });
      return { assigned: fresh.length, created: rest.length, already_in_batch: parsed.emails.length - fresh.length };
    });
    audit(req, 'code.import', { kind: 'publisher', id }, { batch_id: batchId, ...result });
    reply.code(201);
    return {
      batch_id: batchId, ...result, invalid_rows: parsed.invalid,
      batch: await one(`${BATCH_SELECT} and c.batch_id = $2 group by c.batch_id`, [id, batchId]),
    };
  });

  app.get('/api/studio/brands/:id/code-batches/:batchId/export.csv', async (req, reply) => {
    const id = idParam(req);
    await requireMember(req, id, 'editor');
    const batch = await batchOf(req, id);
    const rows = await q(
      `select c.code, coalesce(c.assigned_email, '') as email, case when c.redeemed_count > 0 then 'yes' else 'no' end as redeemed,
              (select min(cr.created_at) from code_redemptions cr where cr.code_id = c.id) as redeemed_at,
              c.sent_at as emailed_at, case when c.disabled_at is not null then 'yes' else 'no' end as disabled
         from promo_codes c where c.publisher_id = $1 and c.batch_id = $2 order by c.created_at, c.id`,
      [id, batch.batch_id],
    );
    return sendCsv(reply, `codes-${batch.batch_label}.csv`, rows, ['code', 'email', 'redeemed', 'redeemed_at', 'emailed_at', 'disabled']);
  });

  app.patch('/api/studio/brands/:id/code-batches/:batchId', async (req) => {
    const id = idParam(req);
    await requireMember(req, id, 'admin');
    const batch = await batchOf(req, id);
    const body = parse(z.object({ disabled: z.boolean().optional(), batch_label: z.string().trim().min(1).max(80).optional() }), req.body);
    if (body.disabled !== undefined) {
      await exec(
        `update promo_codes set disabled_at = ${body.disabled ? 'coalesce(disabled_at, now())' : 'null'} where publisher_id = $1 and batch_id = $2`,
        [id, batch.batch_id],
      );
    }
    if (body.batch_label) await exec('update promo_codes set batch_label = $3 where publisher_id = $1 and batch_id = $2', [id, batch.batch_id, body.batch_label]);
    audit(req, 'code.batch_update', { kind: 'publisher', id }, { batch_id: batch.batch_id, ...body });
    return { batch: await batchOf(req, id) };
  });

  /** Email each backer their code. Only codes not yet emailed, unless `resend`. */
  app.post('/api/studio/brands/:id/code-batches/:batchId/email', async (req) => {
    const id = idParam(req);
    await requireMember(req, id, 'admin');
    requireVerifiedEmail(req);
    const batch = await batchOf(req, id);
    const body = parse(
      z.object({
        message: z.string().trim().min(1, 'Write a short message to your backers').max(1500),
        // Defaults to the title of the release or series the codes are for.
        title: z.string().trim().min(1).max(150).optional(),
        resend: z.boolean().optional(),
      }),
      req.body,
    );
    if (!rateLimit('backer_email', id, 6, 3600)) throw new HttpError(429, 'You have emailed batches several times this hour. Try again later.');
    const brand = await one<{ name: string }>('select name from publishers where id = $1', [id]);
    const today = await one<{ n: number }>(
      `select count(*)::int as n from emails where publisher_id = $1 and template = 'backer_code' and created_at > now() - interval '24 hours'`,
      [id],
    );
    const DAILY = 10_000;
    const codes = await q<{ id: string; code: string; assigned_email: string }>(
      `select id, code, assigned_email from promo_codes
        where publisher_id = $1 and batch_id = $2 and assigned_email is not null and disabled_at is null and redeemed_count = 0
          and (expires_at is null or expires_at > now()) and ($3 or sent_at is null)
        order by created_at, id`,
      [id, batch.batch_id, body.resend ?? false],
    );
    if (!codes.length) throw badRequest('Nobody in this batch is waiting for a code. Import backer emails first, or use resend.');
    if (today!.n + codes.length > DAILY) {
      throw new HttpError(429, `That would pass the limit of ${DAILY} backer emails per day. ${Math.max(0, DAILY - today!.n)} can still be sent today.`);
    }
    const title = body.title ?? batch.scope_title ?? brand!.name;
    let sent = 0;
    let suppressed = 0;
    for (const c of codes) {
      const mailId = await sendTemplate(
        'backer_code',
        c.assigned_email,
        { title, message: body.message, code: c.code, url: `${config.appUrl}/redeem?code=${encodeURIComponent(c.code)}`, brand: brand!.name },
        { publisherId: id },
      );
      if (mailId) {
        sent++;
        await exec('update promo_codes set sent_at = now() where id = $1', [c.id]);
      } else suppressed++;
    }
    audit(req, 'code.batch_email', { kind: 'publisher', id }, { batch_id: batch.batch_id, sent });
    return { ok: true, sent, not_sent: suppressed, batch: await batchOf(req, id) };
  });

  // ------------------------------------------------------------ bundles

  const bundle = z.object({
    title: z.string().trim().min(1, 'Give the bundle a title').max(150),
    description: z.string().trim().max(1000),
    price_cents: z.number().int().min(0).max(1_000_000),
    includes_download: z.boolean(),
    active: z.boolean(),
    release_ids: z.array(uuid('release')).min(1, 'Add at least one release to the bundle').max(500).transform((v) => [...new Set(v)]),
  });

  async function bundlesOf(brandId: string, only?: string) {
    const rows = await q(
      `select b.id, b.title, b.description, b.price_cents, b.includes_download, b.active, b.created_at
         from bundles b where b.publisher_id = $1 and ($2::uuid is null or b.id = $2) order by b.created_at desc`,
      [brandId, only ?? null],
    );
    const items = await q(
      `select bi.bundle_id, r.id as release_id, r.title, r.number, r.kind, r.language, r.status, r.cover_key, r.price_cents,
              r.download_price_cents, s.id as series_id, s.title as series_title, s.default_price_cents, r.deleted_at is not null as deleted
         from bundle_items bi join releases r on r.id = bi.release_id join series s on s.id = r.series_id
        where bi.bundle_id = any($1::uuid[]) order by s.title, r.number`,
      [rows.map((r) => r.id)],
    );
    for (const it of items) {
      it.cover_thumb_url = it.cover_key ? await publicUrl(coverThumbKey(it.cover_key)) : null;
      delete it.cover_key;
    }
    return rows.map((b) => {
      const mine = items.filter((i) => i.bundle_id === b.id);
      // What the same releases cost bought one by one.
      const separate = mine.reduce((n, i) => n + (i.price_cents ?? i.default_price_cents ?? 0) + (b.includes_download ? (i.download_price_cents ?? 0) : 0), 0);
      return { ...b, separate_price_cents: separate, items: mine.map(({ bundle_id: _b, default_price_cents: _d, ...rest }) => rest) };
    });
  }

  const checkReleases = async (brandId: string, ids: string[]) => {
    const ok = await one<{ n: number }>(
      `select count(*)::int as n from releases r join series s on s.id = r.series_id
        where r.id = any($1::uuid[]) and s.publisher_id = $2 and r.deleted_at is null and s.deleted_at is null`,
      [ids, brandId],
    );
    if (ok!.n !== ids.length) throw badRequest('Every release in a bundle must belong to this brand');
  };

  app.get('/api/studio/brands/:id/bundles', async (req) => {
    const id = idParam(req);
    await requireMember(req, id, 'editor');
    return { bundles: await bundlesOf(id) };
  });

  app.post('/api/studio/brands/:id/bundles', async (req, reply) => {
    const id = idParam(req);
    await requireMember(req, id, 'admin');
    const body = parse(bundle.partial({ description: true, includes_download: true, active: true }), req.body);
    await checkReleases(id, body.release_ids);
    const bundleId = await tx(async (db) => {
      const ins = await db.query(
        `insert into bundles (publisher_id, title, description, price_cents, includes_download, active) values ($1,$2,$3,$4,$5,$6) returning id`,
        [id, body.title, body.description ?? '', body.price_cents, body.includes_download ?? false, body.active ?? true],
      );
      await db.query('insert into bundle_items (bundle_id, release_id) select $1, unnest($2::uuid[])', [ins.rows[0].id, body.release_ids]);
      return ins.rows[0].id as string;
    });
    audit(req, 'bundle.create', { kind: 'publisher', id }, { bundle_id: bundleId });
    reply.code(201);
    return { bundle: (await bundlesOf(id, bundleId))[0] };
  });

  app.patch('/api/studio/brands/:id/bundles/:bundleId', async (req) => {
    const id = idParam(req);
    const bundleId = idParam(req, 'bundleId');
    await requireMember(req, id, 'admin');
    if (!(await one('select 1 from bundles where id = $1 and publisher_id = $2', [bundleId, id]))) throw notFound('Bundle not found');
    const body = parse(bundle.partial(), req.body);
    if (body.release_ids) await checkReleases(id, body.release_ids);
    await tx(async (db) => {
      const { sets, values } = patch(body, ['title', 'description', 'price_cents', 'includes_download', 'active'], 2);
      if (sets.length) await db.query(`update bundles set ${sets.join(', ')} where id = $1`, [bundleId, ...values]);
      if (body.release_ids) {
        await db.query('delete from bundle_items where bundle_id = $1', [bundleId]);
        await db.query('insert into bundle_items (bundle_id, release_id) select $1, unnest($2::uuid[])', [bundleId, body.release_ids]);
      }
    });
    audit(req, 'bundle.update', { kind: 'publisher', id }, { bundle_id: bundleId });
    return { bundle: (await bundlesOf(id, bundleId))[0] };
  });

  app.delete('/api/studio/brands/:id/bundles/:bundleId', async (req) => {
    const id = idParam(req);
    const bundleId = idParam(req, 'bundleId');
    await requireMember(req, id, 'admin');
    if (await one('select 1 from order_items where bundle_id = $1 limit 1', [bundleId])) {
      // Sold bundles stay on the record for receipts; they just stop being offered.
      const n = await exec('update bundles set active = false where id = $1 and publisher_id = $2', [bundleId, id]);
      if (!n) throw notFound('Bundle not found');
      return { ok: true, deactivated: true };
    }
    const n = await exec('delete from bundles where id = $1 and publisher_id = $2', [bundleId, id]);
    if (!n) throw notFound('Bundle not found');
    audit(req, 'bundle.delete', { kind: 'publisher', id }, { bundle_id: bundleId });
    return { ok: true, deactivated: false };
  });

  // ------------------------------------------------------------ discounts (timed sales)

  const discount = z.object({
    label: z.string().trim().min(1, 'Name this sale').max(80),
    percent_off: z.number().int().min(1).max(95, 'A sale can take off at most 95%'),
    // null = every series of the brand.
    series_id: uuid('series').nullable(),
    // all = reading and downloads; read = read-online price only; download = download price only.
    applies_to: z.enum(['all', 'read', 'download']),
    starts_at: instant,
    ends_at: instant.nullable(),
    active: z.boolean(),
  });
  const DISCOUNT_SELECT = `
    select d.id, d.label, d.percent_off, d.series_id, s.title as series_title, d.applies_to, d.starts_at, d.ends_at, d.active, d.created_at,
           case when not d.active then 'off' when d.starts_at > now() then 'upcoming'
                when d.ends_at is not null and d.ends_at <= now() then 'ended' else 'running' end as state
      from discounts d left join series s on s.id = d.series_id`;

  app.get('/api/studio/brands/:id/discounts', async (req) => {
    const id = idParam(req);
    await requireMember(req, id, 'editor');
    return { discounts: await q(`${DISCOUNT_SELECT} where d.publisher_id = $1 order by d.starts_at desc, d.created_at desc`, [id]) };
  });

  const checkDiscount = async (brandId: string, d: { series_id?: string | null; starts_at?: string; ends_at?: string | null }) => {
    if (d.series_id && !(await one('select 1 from series where id = $1 and publisher_id = $2 and deleted_at is null', [d.series_id, brandId]))) {
      throw badRequest('That series does not belong to this brand');
    }
    if (d.starts_at && d.ends_at && d.ends_at <= d.starts_at) throw badRequest('The sale ends before it starts');
  };

  app.post('/api/studio/brands/:id/discounts', async (req, reply) => {
    const id = idParam(req);
    await requireMember(req, id, 'admin');
    const body = parse(discount.partial({ series_id: true, applies_to: true, starts_at: true, ends_at: true, active: true }), req.body);
    await checkDiscount(id, body);
    const row = await one<{ id: string }>(
      `insert into discounts (publisher_id, label, percent_off, series_id, applies_to, starts_at, ends_at, active)
       values ($1,$2,$3,$4,$5,coalesce($6::timestamptz, now()),$7,$8) returning id`,
      [id, body.label, body.percent_off, body.series_id ?? null, body.applies_to ?? 'all', body.starts_at ?? null, body.ends_at ?? null, body.active ?? true],
    );
    audit(req, 'discount.create', { kind: 'publisher', id }, { discount_id: row!.id, percent_off: body.percent_off });
    reply.code(201);
    return { discount: await one(`${DISCOUNT_SELECT} where d.id = $1`, [row!.id]) };
  });

  app.patch('/api/studio/brands/:id/discounts/:discountId', async (req) => {
    const id = idParam(req);
    const did = idParam(req, 'discountId');
    await requireMember(req, id, 'admin');
    const cur = await one('select * from discounts where id = $1 and publisher_id = $2', [did, id]);
    if (!cur) throw notFound('Discount not found');
    const body = parse(discount.partial(), req.body);
    await checkDiscount(id, {
      series_id: body.series_id,
      starts_at: body.starts_at ?? new Date(cur.starts_at).toISOString(),
      ends_at: body.ends_at !== undefined ? body.ends_at : cur.ends_at && new Date(cur.ends_at).toISOString(),
    });
    const { sets, values } = patch(body, ['label', 'percent_off', 'series_id', 'applies_to', 'starts_at', 'ends_at', 'active'], 2);
    if (sets.length) await exec(`update discounts set ${sets.join(', ')} where id = $1`, [did, ...values]);
    audit(req, 'discount.update', { kind: 'publisher', id }, { discount_id: did });
    return { discount: await one(`${DISCOUNT_SELECT} where d.id = $1`, [did]) };
  });

  app.delete('/api/studio/brands/:id/discounts/:discountId', async (req) => {
    const id = idParam(req);
    await requireMember(req, id, 'admin');
    const n = await exec('delete from discounts where id = $1 and publisher_id = $2', [idParam(req, 'discountId'), id]);
    if (!n) throw notFound('Discount not found');
    return { ok: true };
  });

  // ------------------------------------------------------------ earnings and payouts (admin / owner)

  /**
   * balance     everything earned minus everything paid out
   * pending     earned but still inside the hold period (available_at in the future)
   * available   balance - pending
   * reserved    payout requests not yet debited from the ledger
   * requestable available - reserved
   */
  async function money(db: Queryable, brandId: string) {
    const r = (
      await db.query(
        `select coalesce(sum(amount_cents), 0)::int as balance,
                coalesce(sum(amount_cents) filter (where available_at > now() and amount_cents > 0), 0)::int as pending
           from ledger where publisher_id = $1`,
        [brandId],
      )
    ).rows[0];
    // A payout is debited from the ledger when an admin approves it. Until its
    // debit row exists it is held back here, so it is never counted twice.
    const reserved = (
      await db.query(
        `select coalesce(sum(p.amount_cents), 0)::int as n from payouts p
          where p.publisher_id = $1 and p.status in ('requested','approved')
            and not exists (select 1 from ledger l where l.payout_id = p.id)`,
        [brandId],
      )
    ).rows[0].n as number;
    const available = r.balance - r.pending;
    return { balance_cents: r.balance, pending_cents: r.pending, available_cents: available, reserved_cents: reserved, requestable_cents: Math.max(0, available - reserved) };
  }

  app.get('/api/studio/brands/:id/earnings', async (req) => {
    const id = idParam(req);
    await requireMember(req, id, 'admin');
    const brand = await one('select payout, sale_share_bps, sub_share_bps, tip_share_bps from publishers where id = $1 and deleted_at is null', [id]);
    if (!brand) throw notFound('Brand not found');
    const [totals, revenue, site, nextRelease] = await Promise.all([
      q(
        `select kind, coalesce(sum(amount_cents), 0)::int as amount_cents, coalesce(sum(gross_cents), 0)::int as gross_cents, count(*)::int as entries
           from ledger where publisher_id = $1 group by kind order by kind`,
        [id],
      ),
      getSetting('revenue'),
      getSetting('site'),
      one<{ at: string }>('select min(available_at) as at from ledger where publisher_id = $1 and available_at > now() and amount_cents > 0', [id]),
    ]);
    const m = await money(pool, id);
    return {
      currency: site.currency,
      ...m,
      next_release_at: nextRelease?.at ?? null,
      totals_by_kind: totals,
      payout_minimum_cents: revenue.payout_minimum_cents,
      payout_hold_days: revenue.payout_hold_days,
      payout_configured: Boolean(brand.payout?.method && brand.payout?.destination),
      can_request: Boolean(brand.payout?.method && brand.payout?.destination) && m.requestable_cents >= revenue.payout_minimum_cents,
      share: {
        sale_bps: brand.sale_share_bps ?? revenue.sale_share_bps,
        subscription_bps: brand.sub_share_bps ?? revenue.sub_share_bps,
        tip_bps: brand.tip_share_bps ?? revenue.tip_share_bps,
      },
    };
  });

  app.get('/api/studio/brands/:id/ledger', async (req, reply) => {
    const id = idParam(req);
    await requireMember(req, id, 'admin');
    const query = parse(z.object({ kind: z.enum(['sale', 'subscription', 'tip', 'payout', 'refund', 'adjustment']).optional(), format: z.enum(['json', 'csv']).optional() }), req.query);
    const csv = query.format === 'csv';
    const { limit, offset, page } = pageParams(req.query, 50, 200);
    // The running balance is over the whole ledger, whatever the filter or page.
    const rows = await q(
      `with l as (
         select le.*, sum(le.amount_cents) over (order by le.created_at, le.id)::int as balance_cents
           from ledger le where le.publisher_id = $1)
       select l.id, l.created_at, l.kind, l.amount_cents, l.gross_cents, l.balance_cents, l.available_at, l.available_at > now() as pending,
              l.month, l.note, l.series_id, s.title as series_title, l.release_id, r.title as release_title, l.order_id, l.payout_id
         from l left join series s on s.id = l.series_id left join releases r on r.id = l.release_id
        where ($2::text is null or l.kind = $2)
        order by l.created_at desc, l.id desc
        ${csv ? 'limit 50000' : 'limit $3 offset $4'}`,
      csv ? [id, query.kind ?? null] : [id, query.kind ?? null, limit, offset],
    );
    if (csv) {
      return sendCsv(reply, 'ledger.csv', rows, ['created_at', 'kind', 'amount_cents', 'gross_cents', 'balance_cents', 'available_at', 'month', 'series_title', 'release_title', 'note', 'order_id', 'payout_id']);
    }
    const total = await one<{ n: number }>('select count(*)::int as n from ledger where publisher_id = $1 and ($2::text is null or kind = $2)', [id, query.kind ?? null]);
    return { entries: rows, total: total!.n, page, limit };
  });

  const PAYOUT_COLS = `p.id, p.amount_cents, p.status, p.method, p.note, p.reference, p.created_at, p.reviewed_at, p.paid_at, u.username as requested_by`;

  app.get('/api/studio/brands/:id/payouts', async (req) => {
    const id = idParam(req);
    await requireMember(req, id, 'admin');
    return {
      payouts: await q(
        `select ${PAYOUT_COLS} from payouts p left join users u on u.id = p.requested_by where p.publisher_id = $1 order by p.created_at desc limit 200`,
        [id],
      ),
    };
  });

  app.post('/api/studio/brands/:id/payouts', async (req, reply) => {
    const id = idParam(req);
    await requireMember(req, id, 'admin');
    requireVerifiedEmail(req);
    // Leave amount_cents out to request everything that can be requested.
    const body = parse(z.object({ amount_cents: z.number().int().min(1).optional(), note: z.string().trim().max(300).optional() }), req.body ?? {});
    const revenue = await getSetting('revenue');
    const fmt = (c: number) => (c / 100).toFixed(2);
    const payout = await tx(async (db) => {
      // One request at a time per brand, so two clicks cannot both pass the balance check.
      const brand = (await db.query('select name, payout, suspended_at from publishers where id = $1 and deleted_at is null for update', [id])).rows[0];
      if (!brand) throw notFound('Brand not found');
      if (brand.suspended_at) throw new HttpError(403, 'This brand is suspended. Contact support about payouts.');
      if (!brand.payout?.method || !brand.payout?.destination) throw badRequest('Add your payout details before requesting a payout');
      const m = await money(db, id);
      const amount = body.amount_cents ?? m.requestable_cents;
      if (amount < revenue.payout_minimum_cents) {
        throw badRequest(
          body.amount_cents === undefined
            ? `You can request a payout once ${fmt(revenue.payout_minimum_cents)} is available. Right now ${fmt(m.requestable_cents)} is.`
            : `The smallest payout is ${fmt(revenue.payout_minimum_cents)}`,
        );
      }
      if (amount > m.requestable_cents) throw badRequest(`Only ${fmt(m.requestable_cents)} is available to request right now`);
      const ins = await db.query(
        `insert into payouts (publisher_id, amount_cents, method, destination, note, requested_by) values ($1,$2,$3,$4,$5,$6) returning id`,
        [id, amount, brand.payout.method, brand.payout.destination, body.note ?? null, req.user!.id],
      );
      return { id: ins.rows[0].id as string, amount, brand: brand.name as string };
    });
    audit(req, 'payout.request', { kind: 'publisher', id }, { payout_id: payout.id, amount_cents: payout.amount });
    alertAdmins('Payout requested', `${payout.brand} requested a payout of ${fmt(payout.amount)}.`, `${config.appUrl}/admin/payouts`).catch(() => {});
    reply.code(201);
    return {
      payout: await one(`select ${PAYOUT_COLS} from payouts p left join users u on u.id = p.requested_by where p.id = $1`, [payout.id]),
      ...(await money(pool, id)),
    };
  });

  /** Withdraw a request that has not been reviewed yet. */
  app.delete('/api/studio/brands/:id/payouts/:payoutId', async (req) => {
    const id = idParam(req);
    await requireMember(req, id, 'admin');
    const n = await exec(`delete from payouts where id = $1 and publisher_id = $2 and status = 'requested'`, [idParam(req, 'payoutId'), id]);
    if (!n) throw conflict('This payout is already being processed and cannot be withdrawn');
    audit(req, 'payout.withdraw', { kind: 'publisher', id }, { payout_id: idParam(req, 'payoutId') });
    return { ok: true };
  });
}
