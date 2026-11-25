import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { one } from '../db.ts';
import { encrypt } from '../lib/crypto.ts';
import { audit, badRequest, conflict, notFound, parse, requireMember } from '../lib/http.ts';
import { idParam } from '../lib/ingest.ts';
import { getSetting } from '../lib/settings.ts';
import { CERTIFICATIONS, CLASSIFICATIONS, LLC_TAX_CLASSES, cleanTin, profileView, taxStatus } from '../lib/tax.ts';

/**
 * Studio: a brand's tax information form (brand admin / owner).
 *
 * The taxpayer ID goes in and never comes back out: it is stored encrypted,
 * responses carry the last four digits only, and it is kept out of the audit
 * log and of every error message.
 */

const US_STATES = new Set(
  'AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY AS GU MP PR VI AA AE AP'.split(' '),
);

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullish()
    .transform((v) => v || null);
const country = (what: string) =>
  z
    .string()
    .trim()
    .regex(/^[A-Za-z]{2}$/, `Choose ${what}`)
    .transform((v) => v.toUpperCase());

const formBody = z.object({
  is_us_person: z.boolean(),
  legal_name: z.string().trim().min(2, 'Enter the legal name of the person or business being paid').max(160),
  business_name: optionalText(160),
  classification: z.enum(CLASSIFICATIONS, 'Choose a federal tax classification'),
  llc_tax_class: z.enum(LLC_TAX_CLASSES).nullish(),
  other_description: optionalText(160),
  address_street: z.string().trim().min(3, 'Enter the street address').max(200),
  address_city: z.string().trim().min(1, 'Enter the city').max(100),
  address_state: optionalText(60),
  address_postal: optionalText(20),
  address_country: country('the country of the address'),
  tin_type: z.enum(['ssn', 'ein']).nullish(),
  // Checked by hand below so that no validation message can ever repeat the number.
  tin: z.unknown().optional(),
  tax_residence_country: country('the country of tax residence').nullish(),
  foreign_tin: z.unknown().optional(),
  date_of_birth: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Enter the date of birth as YYYY-MM-DD')
    .nullish(),
  not_us_person: z.boolean().optional(),
  signature_name: z.string().trim().min(2, 'Type your full name to sign').max(160),
  certify: z.boolean().optional(),
  certification_text: z.string().max(4000),
});

export default async function (app: FastifyInstance) {
  app.get('/api/studio/brands/:id/tax', async (req) => {
    const id = idParam(req);
    await requireMember(req, id, 'admin');
    const brand = await one('select id, name, country, payout from publishers where id = $1 and deleted_at is null', [id]);
    if (!brand) throw notFound('Brand not found');
    const [status, profile, site, owner, notice] = await Promise.all([
      taxStatus(id),
      one('select * from tax_profiles where publisher_id = $1', [id]),
      getSetting('site'),
      one<{ display_name: string }>(
        `select u.display_name from publisher_members m join users u on u.id = m.user_id
          where m.publisher_id = $1 and m.role = 'owner' and u.deleted_at is null order by m.created_at limit 1`,
        [id],
      ),
      one<{ notified_at: string }>('select notified_at from tax_notices where publisher_id = $1 order by year desc limit 1', [id]),
    ]);
    const payeeName = typeof brand.payout?.legal_name === 'string' && brand.payout.legal_name.trim() ? (brand.payout.legal_name as string).trim() : null;
    return {
      currency: site.currency,
      status,
      profile: profileView(profile),
      // What is already on file elsewhere, to start the form from. Never a taxpayer ID.
      prefill: {
        legal_name: payeeName ?? owner?.display_name ?? null,
        legal_name_source: payeeName ? 'payout_details' : owner ? 'owner_name' : null,
        business_name: brand.name as string,
        address_country: /^[A-Za-z]{2}$/.test(brand.country ?? '') ? String(brand.country).toUpperCase() : null,
      },
      certifications: CERTIFICATIONS,
      classifications: CLASSIFICATIONS,
      llc_tax_classes: LLC_TAX_CLASSES,
      notified_at: notice?.notified_at ?? null,
    };
  });

  /** Submit or replace the form. The whole form is sent every time, including the full taxpayer ID. */
  app.put('/api/studio/brands/:id/tax', async (req) => {
    const id = idParam(req);
    await requireMember(req, id, 'admin');
    if (!(await one('select 1 from publishers where id = $1 and deleted_at is null', [id]))) throw notFound('Brand not found');
    const b = parse(formBody, req.body);

    if (b.classification === 'llc' && !b.llc_tax_class) throw badRequest('Choose how the LLC is taxed', 'validation');
    if (b.classification === 'other' && !b.other_description) throw badRequest('Describe the kind of entity being paid', 'validation');
    if (b.address_country === 'US') {
      if (!b.address_state || !US_STATES.has(b.address_state.toUpperCase())) throw badRequest('Choose the state', 'validation');
      if (!b.address_postal || !/^\d{5}(-\d{4})?$/.test(b.address_postal)) throw badRequest('Enter a 5-digit ZIP code', 'validation');
    }

    let tinType: 'ssn' | 'ein' | null = null;
    let tinDigits: string | null = null;
    let foreignTin: string | null = null;
    let dob: string | null = null;
    if (b.is_us_person) {
      if (!b.tin_type) throw badRequest('Choose the kind of taxpayer ID', 'validation');
      if (typeof b.tin !== 'string' || !b.tin.trim()) throw badRequest('Enter the full taxpayer ID. For your security the saved number is never shown, so it has to be typed in again.', 'validation');
      const tin = cleanTin(b.tin_type, b.tin);
      if (!tin.ok) throw badRequest(tin.error, 'validation');
      tinType = b.tin_type;
      tinDigits = tin.digits;
    } else {
      if (!b.tax_residence_country) throw badRequest('Choose the country of tax residence', 'validation');
      if (b.tax_residence_country === 'US') throw badRequest('A payee whose tax residence is the United States is a US person. Choose "Yes" for the first question.', 'validation');
      if (!b.not_us_person) throw badRequest('Confirm that the payee is not a US person', 'validation');
      if (typeof b.foreign_tin === 'string' && b.foreign_tin.trim()) {
        foreignTin = b.foreign_tin.trim();
        if (foreignTin.length < 3 || foreignTin.length > 40 || !/^[A-Za-z0-9 ./-]+$/.test(foreignTin)) throw badRequest('Enter the foreign tax ID using letters, digits, spaces, dots and dashes', 'validation');
      }
      if (b.date_of_birth && b.classification === 'individual') {
        const d = new Date(`${b.date_of_birth}T00:00:00Z`);
        if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== b.date_of_birth || d.getUTCFullYear() < 1900 || d.getTime() > Date.now()) {
          throw badRequest('Enter a real date of birth', 'validation');
        }
        dob = b.date_of_birth;
      }
    }

    // The signature covers the exact statement the person saw.
    const statement = b.is_us_person ? CERTIFICATIONS.us : CERTIFICATIONS.non_us;
    if (!b.certify) throw badRequest('Tick the box to certify the form before signing', 'validation');
    if (b.certification_text !== statement) throw conflict('The certification wording has changed since this page was opened. Reload the page, read it again and sign.');

    const existed = Boolean(await one('select 1 from tax_profiles where publisher_id = $1', [id]));
    const foreignLast4 = foreignTin ? foreignTin.replace(/[^A-Za-z0-9]/g, '').slice(-4) : null;
    const row = await one(
      `insert into tax_profiles (publisher_id, status, is_us_person, legal_name, business_name, classification, llc_tax_class, other_description,
                                 address_street, address_city, address_state, address_postal, address_country,
                                 tin_type, tin_encrypted, tin_last4, tax_residence_country, foreign_tin_encrypted, foreign_tin_last4, date_of_birth,
                                 not_us_person_statement, signature_name, signed_at, signature_ip, certification_text, submitted_by)
       values ($1,'submitted',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,now(),$22,$23,$24)
       on conflict (publisher_id) do update set
         status = 'submitted', is_us_person = excluded.is_us_person, legal_name = excluded.legal_name, business_name = excluded.business_name,
         classification = excluded.classification, llc_tax_class = excluded.llc_tax_class, other_description = excluded.other_description,
         address_street = excluded.address_street, address_city = excluded.address_city, address_state = excluded.address_state,
         address_postal = excluded.address_postal, address_country = excluded.address_country,
         tin_type = excluded.tin_type, tin_encrypted = excluded.tin_encrypted, tin_last4 = excluded.tin_last4,
         tax_residence_country = excluded.tax_residence_country, foreign_tin_encrypted = excluded.foreign_tin_encrypted,
         foreign_tin_last4 = excluded.foreign_tin_last4, date_of_birth = excluded.date_of_birth,
         not_us_person_statement = excluded.not_us_person_statement, signature_name = excluded.signature_name, signed_at = now(),
         signature_ip = excluded.signature_ip, certification_text = excluded.certification_text, submitted_by = excluded.submitted_by,
         needs_update_note = null, needs_update_at = null, needs_update_by = null, updated_at = now()
       returning *`,
      [
        id, b.is_us_person, b.legal_name, b.business_name, b.classification, b.classification === 'llc' ? b.llc_tax_class : null,
        b.classification === 'other' ? b.other_description : null, b.address_street, b.address_city,
        b.address_country === 'US' ? b.address_state!.toUpperCase() : b.address_state, b.address_postal, b.address_country,
        tinType, tinDigits ? encrypt(tinDigits) : null, tinDigits ? tinDigits.slice(-4) : null,
        b.is_us_person ? null : b.tax_residence_country, foreignTin ? encrypt(foreignTin) : null, foreignLast4, dob,
        !b.is_us_person, b.signature_name, req.clientIp || null, statement, req.user!.id,
      ],
    );
    audit(req, existed ? 'tax.profile_update' : 'tax.profile_submit', { kind: 'publisher', id }, { is_us_person: b.is_us_person, classification: b.classification, tin_type: tinType });
    return { profile: profileView(row), status: await taxStatus(id) };
  });
}
