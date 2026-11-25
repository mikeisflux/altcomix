import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { exec, one, q } from '../db.ts';
import type { Row } from '../db.ts';
import { adminScope, idParam, like, query, tellBrand, where } from '../lib/admin.ts';
import { decrypt } from '../lib/crypto.ts';
import { HttpError, badRequest, notFound, pageParams, parse, requireAdmin, requireSuperAdmin } from '../lib/http.ts';
import { toCsv } from '../lib/ingest.ts';
import { getSetting } from '../lib/settings.ts';
import { TAX_TIME_ZONE, formatTin, inYear, taxSettings, taxYear } from '../lib/tax.ts';

/**
 * Admin: creator tax information for a calendar year.
 *
 * Any admin can see the list (last four digits only), export it without
 * taxpayer IDs and ask a brand for a corrected form. Seeing a full taxpayer
 * ID, on screen or in the export, takes a super admin and is written to the
 * audit log before the number leaves the server. The audit log never holds
 * the number itself.
 */

/** Audit row that must exist before the response is sent (the shared `audit` helper does not wait). */
async function auditNow(req: FastifyRequest, action: string, target: { kind: string; id: string }, meta: Record<string, unknown>): Promise<void> {
  await exec('insert into audit_log (actor_id, action, target_kind, target_id, meta, ip) values ($1,$2,$3,$4,$5,$6)', [
    req.user?.id ?? null, action, target.kind, target.id, JSON.stringify(meta), req.clientIp,
  ]);
}

function yearParam(value: unknown): number {
  const now = taxYear();
  if (value === undefined || value === null || value === '') return now;
  const y = Number(value);
  if (!Number.isInteger(y) || y < 2000 || y > now) throw badRequest(`Choose a year up to ${now}`);
  return y;
}

/** One row per brand that earned, was paid or has a form on file in `year`. `w` carries the extra filters. */
function listSql(w: ReturnType<typeof where>, yearP: string, limitP: string, columns: string, tail = ''): string {
  return `with e as (select l.publisher_id, sum(l.amount_cents)::bigint as cents from ledger l
                      where l.kind in ('sale','tip','subscription','refund') and ${inYear('l.created_at', yearP)} group by l.publisher_id),
               po as (select y.publisher_id, sum(y.amount_cents)::bigint as cents from payouts y
                       where y.status = 'paid' and ${inYear('y.paid_at', yearP)} group by y.publisher_id),
               b as (select p.id as publisher_id, p.name, p.slug, p.deleted_at,
                            coalesce(e.cents, 0)::bigint as earnings_cents, coalesce(po.cents, 0)::bigint as payouts_paid_cents,
                            coalesce(e.cents, 0) >= ${limitP}::bigint as over_limit,
                            case when t.status = 'submitted' then 'on_file' when t.status = 'needs_update' then 'needs_update' else 'missing' end as form_status,
                            t.is_us_person, t.legal_name, t.business_name, t.classification, t.llc_tax_class, t.other_description,
                            t.address_street, t.address_city, t.address_state, t.address_postal, t.address_country,
                            t.tin_type, t.tin_last4, t.tin_encrypted, t.tax_residence_country, t.foreign_tin_last4, t.foreign_tin_encrypted,
                            t.date_of_birth, t.signature_name, t.signed_at, t.needs_update_note, t.updated_at as form_updated_at
                       from publishers p
                       left join e on e.publisher_id = p.id
                       left join po on po.publisher_id = p.id
                       left join tax_profiles t on t.publisher_id = p.id
                      where e.publisher_id is not null or po.publisher_id is not null or t.publisher_id is not null)
          select ${columns} from b ${w.sql} ${tail}`;
}

const LIST_COLUMNS = `publisher_id, name, slug, deleted_at, earnings_cents, payouts_paid_cents, over_limit, form_status, is_us_person, legal_name,
                      classification, tin_type, tin_last4, tax_residence_country, foreign_tin_last4, needs_update_note, form_updated_at`;

export default async function adminTaxRoutes(app: FastifyInstance) {
  await adminScope(app, (s) => {
    /** ?year=&over=1&missing=1&q=&page= */
    s.get('/api/admin/tax', async (req) => {
      requireAdmin(req);
      const qy = query(req);
      const year = yearParam(qy.year);
      const { limit, offset, page } = pageParams(req.query, 50, 200);
      const { required, limit_cents } = await taxSettings();
      const site = await getSetting('site');

      const build = (filtered: boolean) => {
        const w = where();
        const yearP = w.param(year);
        const limitP = w.param(limit_cents);
        if (filtered) {
          if (qy.over === '1') w.add('over_limit');
          if (qy.missing === '1') w.add(`form_status <> 'on_file'`);
          if (qy.q) {
            const p = w.param(like(qy.q));
            w.add(`(name ilike ${p} or slug ilike ${p} or legal_name ilike ${p})`);
          }
        }
        return { w, yearP, limitP };
      };
      const f = build(true);
      const total = (await one<{ n: number }>(listSql(f.w, f.yearP, f.limitP, 'count(*)::int as n'), f.w.values))!.n;
      const items = await q(listSql(f.w, f.yearP, f.limitP, LIST_COLUMNS, `order by earnings_cents desc, name limit ${limit} offset ${offset}`), f.w.values);
      const a = build(false);
      const totals = await one(
        listSql(
          a.w, a.yearP, a.limitP,
          `count(*)::int as brands, count(*) filter (where over_limit)::int as over_limit,
           count(*) filter (where over_limit and form_status <> 'on_file')::int as over_limit_without_form,
           coalesce(sum(earnings_cents) filter (where over_limit), 0)::bigint as over_limit_earnings_cents`,
        ),
        a.w.values,
      );
      const first = await one<{ y: number | null }>(`select extract(year from min(created_at) at time zone '${TAX_TIME_ZONE}')::int as y from ledger`);
      const now = taxYear();
      const years: number[] = [];
      for (let y = now; y >= Math.min(first?.y ?? now, now - 1); y--) years.push(y);
      return { items, total, page, limit, year, years, currency: site.currency, limit_cents, form_required: required, totals };
    });

    /**
     * The accountant's file: every brand over the limit in `year`, one row each.
     * Body: { year, include_ids?, confirm? }. Returned as JSON so the request carries the CSRF token.
     */
    s.post('/api/admin/tax/export', async (req) => {
      const actor = requireAdmin(req);
      const body = parse(z.object({ year: z.number().int().optional(), include_ids: z.boolean().default(false), confirm: z.boolean().default(false) }), req.body ?? {});
      const year = yearParam(body.year);
      if (body.include_ids) {
        if (actor.role !== 'super_admin') throw new HttpError(403, 'Only a super admin can export full taxpayer IDs');
        if (!body.confirm) throw badRequest('Confirm that you want full taxpayer IDs in the file');
      }
      const { limit_cents } = await taxSettings();
      const site = await getSetting('site');
      const w = where();
      const yearP = w.param(year);
      const limitP = w.param(limit_cents);
      w.add('over_limit');
      const rows = await q(listSql(w, yearP, limitP, '*', 'order by name limit 50000'), w.values);
      const amount = (cents: number) => (cents / 100).toFixed(2);
      const unreadable: string[] = [];
      const out: Row[] = rows.map((r) => {
        const row: Row = {
          year, brand: r.name, brand_address: r.slug, form_status: r.form_status,
          us_person: r.is_us_person === null ? '' : r.is_us_person ? 'yes' : 'no',
          legal_name: r.legal_name, business_name: r.business_name,
          classification: r.classification, llc_tax_class: r.llc_tax_class, other_description: r.other_description,
          address_street: r.address_street, address_city: r.address_city, address_state: r.address_state, address_postal: r.address_postal, address_country: r.address_country,
          taxpayer_id_type: r.tin_type ? String(r.tin_type).toUpperCase() : '', taxpayer_id_last4: r.tin_last4,
          tax_residence_country: r.tax_residence_country, foreign_tax_id_last4: r.foreign_tin_last4, date_of_birth: r.date_of_birth,
          signed_by: r.signature_name, signed_at: r.signed_at,
          earnings: amount(r.earnings_cents), payouts_paid: amount(r.payouts_paid_cents), currency: site.currency.toUpperCase(),
        };
        if (body.include_ids) {
          const tin = r.tin_encrypted ? decrypt(r.tin_encrypted) : '';
          const foreign = r.foreign_tin_encrypted ? decrypt(r.foreign_tin_encrypted) : '';
          if (tin === null || foreign === null) unreadable.push(r.name);
          row.taxpayer_id = tin ? formatTin(r.tin_type, tin) : '';
          row.foreign_tax_id = foreign ?? '';
        }
        return row;
      });
      const columns = [
        'year', 'brand', 'brand_address', 'form_status', 'us_person', 'legal_name', 'business_name', 'classification', 'llc_tax_class', 'other_description',
        'address_street', 'address_city', 'address_state', 'address_postal', 'address_country', 'taxpayer_id_type', 'taxpayer_id_last4',
        ...(body.include_ids ? ['taxpayer_id'] : []),
        'tax_residence_country', 'foreign_tax_id_last4', ...(body.include_ids ? ['foreign_tax_id'] : []),
        'date_of_birth', 'signed_by', 'signed_at', 'earnings', 'payouts_paid', 'currency',
      ];
      // Written before the file is handed over. Counts only: never the IDs.
      await auditNow(req, body.include_ids ? 'tax.export_with_ids' : 'tax.export', { kind: 'tax_year', id: String(year) }, {
        year, brands: out.length, include_taxpayer_ids: body.include_ids, limit_cents,
      });
      return {
        filename: `creator-tax-${year}${body.include_ids ? '-with-taxpayer-ids' : ''}.csv`,
        csv: toCsv(out, columns),
        rows: out.length,
        include_ids: body.include_ids,
        // Brands whose stored ID could not be decrypted (APP_SECRET changed since it was saved).
        unreadable,
      };
    });

    /** Show one brand's full taxpayer ID once. Super admin; audited before the number is returned. */
    s.post('/api/admin/tax/:id/reveal', async (req) => {
      requireSuperAdmin(req);
      const id = idParam(req);
      const t = await one(
        `select t.tin_type, t.tin_encrypted, t.foreign_tin_encrypted, t.legal_name, t.is_us_person, p.name
           from tax_profiles t join publishers p on p.id = t.publisher_id where t.publisher_id = $1`,
        [id],
      );
      if (!t) throw notFound('This brand has no tax information form on file');
      if (!t.tin_encrypted && !t.foreign_tin_encrypted) throw badRequest('This form has no taxpayer ID on it');
      const tin = t.tin_encrypted ? decrypt(t.tin_encrypted) : null;
      const foreign = t.foreign_tin_encrypted ? decrypt(t.foreign_tin_encrypted) : null;
      if ((t.tin_encrypted && tin === null) || (t.foreign_tin_encrypted && foreign === null)) {
        throw new HttpError(500, 'The stored taxpayer ID could not be decrypted. APP_SECRET may have changed since it was saved; ask the brand to submit the form again.');
      }
      await auditNow(req, 'tax.reveal_taxpayer_id', { kind: 'publisher', id }, { name: t.name, tin_type: t.tin_type, foreign: Boolean(foreign) });
      return {
        publisher_id: id, name: t.name, legal_name: t.legal_name, is_us_person: t.is_us_person,
        tin_type: t.tin_type, tin: tin ? formatTin(t.tin_type, tin) : null, foreign_tin: foreign,
      };
    });

    /** Ask the brand for a corrected form. Payouts wait again if the brand is over the limit. */
    s.post('/api/admin/tax/:id/needs-update', async (req) => {
      const actor = requireAdmin(req);
      const id = idParam(req);
      const { note } = parse(z.object({ note: z.string().trim().min(3, 'Say what needs correcting (at least 3 characters)').max(500) }), req.body);
      const t = await one(
        `update tax_profiles set status = 'needs_update', needs_update_note = $2, needs_update_at = now(), needs_update_by = $3, updated_at = now()
          where publisher_id = $1 returning publisher_id`,
        [id, note, actor.id],
      );
      if (!t) throw notFound('This brand has no tax information form on file');
      const told = await tellBrand(
        id, 'tax', 'Please update your tax information',
        `We need a corrected tax information form for your brand: ${note} Payouts wait until the form has been submitted again.`,
        `/studio/brand/${id}/tax`, 'Open the tax information form',
      );
      await auditNow(req, 'tax.needs_update', { kind: 'publisher', id }, { note, notified: told });
      return { ok: true, notified: told };
    });
  });
}
