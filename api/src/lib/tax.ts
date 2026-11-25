import { config } from '../config.ts';
import { one, pool, q } from '../db.ts';
import type { Queryable, Row } from '../db.ts';
import { brandContacts, money, studioPath } from './admin.ts';
import { sendTemplate } from './email.ts';
import { notify } from './notify.ts';
import { getSetting } from './settings.ts';

/**
 * Creator tax information.
 *
 * A brand whose earnings in a calendar year reach the tax reporting limit
 * (settings.revenue.tax_reporting_threshold_cents) is asked for a tax
 * information form, and payouts wait until it is on file. The site collects
 * and exports the information; it does not file anything with a tax authority.
 *
 * "Earnings in a year" are the brand's ledger rows of kind sale, tip,
 * subscription and refund (refund rows are negative) whose created_at falls in
 * that calendar year in TAX_TIME_ZONE. Payouts and manual adjustments are not
 * earnings and are not counted.
 */

/** The business is in Indiana; a calendar year starts and ends at midnight there. */
export const TAX_TIME_ZONE = 'America/Indiana/Indianapolis';

const EARNING_KINDS = `('sale','tip','subscription','refund')`;

export function taxYear(now = new Date()): number {
  return Number(new Intl.DateTimeFormat('en-US', { timeZone: TAX_TIME_ZONE, year: 'numeric' }).format(now));
}

/** SQL for "created_at is inside calendar year $n" on the ledger alias given. */
export const inYear = (column: string, param: string): string =>
  `${column} >= make_timestamptz(${param}::int, 1, 1, 0, 0, 0, '${TAX_TIME_ZONE}') and ${column} < make_timestamptz(${param}::int + 1, 1, 1, 0, 0, 0, '${TAX_TIME_ZONE}')`;

/** A brand's earnings (creator share credited, net of refunds) in one calendar year, in cents. */
export async function yearEarnings(publisherId: string, year: number, db: Queryable = pool): Promise<number> {
  const r = await one<{ cents: number }>(
    `select coalesce(sum(amount_cents), 0)::bigint as cents from ledger l
      where l.publisher_id = $1 and l.kind in ${EARNING_KINDS} and ${inYear('l.created_at', '$2')}`,
    [publisherId, year],
    db,
  );
  return r?.cents ?? 0;
}

export type FormStatus = 'on_file' | 'missing' | 'needs_update';

export type TaxStatus = {
  /** settings.revenue.tax_form_required: off = nothing is asked for and nothing is blocked. */
  required: boolean;
  limit_cents: number;
  year: number;
  earnings_cents: number;
  previous_year: number;
  previous_earnings_cents: number;
  /** This year's earnings, or last year's, reached the limit. */
  limit_reached: boolean;
  /** The year that reached it (this year first), or null. */
  reached_year: number | null;
  form_status: FormStatus;
  /** The limit is reached and no usable form is on file. */
  form_needed: boolean;
  /** Payout requests are refused: `form_needed` while the requirement is on. */
  payout_blocked: boolean;
};

export async function taxSettings(): Promise<{ required: boolean; limit_cents: number }> {
  const rev = await getSetting('revenue');
  return { required: rev.tax_form_required !== false, limit_cents: Number(rev.tax_reporting_threshold_cents) };
}

/** Where each brand stands, in one query. Brands that do not exist are left out. */
export async function taxStatuses(publisherIds: string[], db: Queryable = pool): Promise<Map<string, TaxStatus>> {
  const out = new Map<string, TaxStatus>();
  if (!publisherIds.length) return out;
  const { required, limit_cents } = await taxSettings();
  const year = taxYear();
  const rows = await q<{ id: string; cur: number; prev: number; status: string | null }>(
    `select p.id,
            (select coalesce(sum(l.amount_cents), 0) from ledger l
              where l.publisher_id = p.id and l.kind in ${EARNING_KINDS} and ${inYear('l.created_at', '$2')})::bigint as cur,
            (select coalesce(sum(l.amount_cents), 0) from ledger l
              where l.publisher_id = p.id and l.kind in ${EARNING_KINDS} and ${inYear('l.created_at', '$3')})::bigint as prev,
            (select t.status from tax_profiles t where t.publisher_id = p.id) as status
       from publishers p where p.id = any($1::uuid[])`,
    [publisherIds, year, year - 1],
    db,
  );
  for (const r of rows) {
    const form_status: FormStatus = r.status === 'submitted' ? 'on_file' : r.status === 'needs_update' ? 'needs_update' : 'missing';
    const reached_year = r.cur >= limit_cents ? year : r.prev >= limit_cents ? year - 1 : null;
    const form_needed = reached_year !== null && form_status !== 'on_file';
    out.set(r.id, {
      required, limit_cents, year, earnings_cents: r.cur, previous_year: year - 1, previous_earnings_cents: r.prev,
      limit_reached: reached_year !== null, reached_year, form_status, form_needed, payout_blocked: required && form_needed,
    });
  }
  return out;
}

export async function taxStatus(publisherId: string, db: Queryable = pool): Promise<TaxStatus | null> {
  return (await taxStatuses([publisherId], db)).get(publisherId) ?? null;
}

/** Shown to an admin beside a payout; null when there is nothing to warn about. */
export function taxWarning(s: TaxStatus | null | undefined): string | null {
  if (!s || !s.form_needed) return null;
  const which = s.form_status === 'needs_update' ? 'its tax information form needs an update' : 'it has no tax information form on file';
  return `This brand's ${s.reached_year} earnings reached the tax reporting limit and ${which}.`;
}

// ---------------------------------------------------------------- the notice

/**
 * Tell the owners of every brand that has reached the limit this year (or
 * reached it last year) and has no tax form on file: one in-app notification
 * and one email each, once per brand per year. The (brand, year) row in
 * tax_notices is claimed first, so two workers never send it twice.
 * Returns how many brands were told.
 */
export async function sendTaxNotices(now = new Date()): Promise<number> {
  const { required, limit_cents } = await taxSettings();
  if (!required) return 0;
  const site = await getSetting('site');
  const year = taxYear(now);
  let told = 0;
  for (const y of [year, year - 1]) {
    const due = await q<{ id: string; name: string; cents: number }>(
      `select p.id, p.name, e.cents
         from (select l.publisher_id, sum(l.amount_cents)::bigint as cents from ledger l
                where l.kind in ${EARNING_KINDS} and ${inYear('l.created_at', '$1')}
                group by l.publisher_id having sum(l.amount_cents) >= $2) e
         join publishers p on p.id = e.publisher_id and p.deleted_at is null
        where not exists (select 1 from tax_profiles t where t.publisher_id = p.id)
          and not exists (select 1 from tax_notices n where n.publisher_id = p.id and n.year = $1)`,
      [y, limit_cents],
    );
    for (const b of due) {
      const claimed = await one(
        `insert into tax_notices (publisher_id, year, earnings_cents, limit_cents) values ($1,$2,$3,$4) on conflict do nothing returning publisher_id`,
        [b.id, y, b.cents, limit_cents],
      );
      if (!claimed) continue;
      const path = await studioPath(`/studio/brand/${b.id}/tax`);
      const limit = money(limit_cents, site.currency);
      for (const person of await brandContacts(b.id)) {
        await notify(
          person.id,
          'tax',
          `${b.name}: tax information needed`,
          `Earnings for ${y} reached the tax reporting limit of ${limit}. Fill in the tax information form so payouts can continue.`,
          path,
        );
        await sendTemplate(
          'tax_form_needed',
          person.email,
          { name: person.display_name, brand: b.name, year: String(y), limit, url: config.appUrl + path },
          { userId: person.id, publisherId: b.id },
        );
      }
      told++;
    }
  }
  return told;
}

// ---------------------------------------------------------------- the form

export const CLASSIFICATIONS = ['individual', 'single_member_llc', 'c_corp', 's_corp', 'partnership', 'trust_estate', 'llc', 'other'] as const;
export const LLC_TAX_CLASSES = ['c_corp', 's_corp', 'partnership'] as const;

/**
 * The statement the payee signs. The exact text shown is stored with the
 * signature, so changing these only affects forms submitted afterwards.
 */
export const CERTIFICATIONS = {
  us:
    'Under penalties of perjury, I certify that: (1) the taxpayer identification number I entered is correct and belongs to the person or business named on this form; ' +
    '(2) I am a U.S. citizen or other U.S. person, or I am authorized to sign for the U.S. business named on this form; ' +
    '(3) the legal name, address and federal tax classification I entered are correct; and ' +
    '(4) I will submit a new form within 30 days if any of this changes. ' +
    'I understand that this information is used to prepare the tax form the law requires for these earnings and may be reported to the tax authorities.',
  non_us:
    'Under penalties of perjury, I certify that: (1) the person or business named on this form is not a U.S. citizen, U.S. resident or other U.S. person; ' +
    '(2) that person or business is the owner of the earnings this form relates to; ' +
    '(3) the country of tax residence and the other details I entered are correct; and ' +
    '(4) I will submit a new form within 30 days if any of this changes. ' +
    'I understand that this information is kept for tax reporting and may be reported to the tax authorities.',
} as const;

const JUNK_TINS = new Set(['123456789', '987654321', '012345678', '078051120']);

/**
 * Digits of a US taxpayer ID, or a sentence saying what is wrong with it.
 * The message never repeats what was typed.
 */
export function cleanTin(type: 'ssn' | 'ein', input: string): { ok: true; digits: string } | { ok: false; error: string } {
  const what = type === 'ssn' ? 'Social Security number' : 'Employer Identification Number';
  const raw = input.trim();
  if (!/^[\d\s-]+$/.test(raw)) return { ok: false, error: `Enter the ${what} using digits only` };
  const digits = raw.replace(/\D/g, '');
  if (digits.length !== 9) return { ok: false, error: `A ${what} has 9 digits` };
  const invalid = { ok: false as const, error: `That is not a valid ${what}. Check the number and enter it again.` };
  if (/^(\d)\1{8}$/.test(digits) || JUNK_TINS.has(digits)) return invalid;
  if (type === 'ssn') {
    // Area 000 and 666, group 00 and serial 0000 are never issued. Area 9xx is an ITIN, which is accepted here.
    if (digits.startsWith('000') || digits.startsWith('666') || digits.slice(3, 5) === '00' || digits.slice(5) === '0000') return invalid;
  } else if (digits.startsWith('00') || digits.slice(2) === '0000000') {
    return invalid;
  }
  return { ok: true, digits };
}

/** 123-45-6789 or 12-3456789, for the accountant's export and the reveal dialog. */
export function formatTin(type: string | null, digits: string): string {
  if (!/^\d{9}$/.test(digits)) return digits;
  return type === 'ein' ? `${digits.slice(0, 2)}-${digits.slice(2)}` : `${digits.slice(0, 3)}-${digits.slice(3, 5)}-${digits.slice(5)}`;
}

/** What a brand's team may see of its own profile: never the taxpayer ID itself. */
export function profileView(p: Row | null) {
  if (!p) return null;
  return {
    status: p.status as 'submitted' | 'needs_update',
    is_us_person: p.is_us_person as boolean,
    legal_name: p.legal_name as string,
    business_name: (p.business_name as string | null) ?? null,
    classification: p.classification as string,
    llc_tax_class: (p.llc_tax_class as string | null) ?? null,
    other_description: (p.other_description as string | null) ?? null,
    address_street: p.address_street as string,
    address_city: p.address_city as string,
    address_state: (p.address_state as string | null) ?? null,
    address_postal: (p.address_postal as string | null) ?? null,
    address_country: p.address_country as string,
    tin_type: (p.tin_type as string | null) ?? null,
    tin_last4: (p.tin_last4 as string | null) ?? null,
    tax_residence_country: (p.tax_residence_country as string | null) ?? null,
    foreign_tin_last4: (p.foreign_tin_last4 as string | null) ?? null,
    date_of_birth: (p.date_of_birth as string | null) ?? null,
    signature_name: p.signature_name as string,
    signed_at: p.signed_at as string,
    certification_text: p.certification_text as string,
    needs_update_note: p.status === 'needs_update' ? ((p.needs_update_note as string | null) ?? null) : null,
    updated_at: p.updated_at as string,
  };
}
