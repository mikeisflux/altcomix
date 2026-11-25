import { useQuery } from '@tanstack/react-query';
import { FileCheck2, FileWarning, ShieldCheck } from 'lucide-react';
import { useState } from 'react';
import type { FormEvent } from 'react';
import { Link } from 'react-router';
import { api } from '@/lib/api';
import { date, dateTime, moneyExact } from '@/lib/format';
import { Badge, Button, Checkbox, DefList, Field, FormRow, Input, LinkButton, Notice, ProgressBar, Segmented, Select } from '@/ui';
import { BrandPage, COUNTRIES, Group, Q, RoleNotice, Section, can, countryName, useAct, useBrand } from './shared';
import type { StudioBrand } from './shared';

type Status = {
  required: boolean; limit_cents: number; year: number; earnings_cents: number; previous_year: number; previous_earnings_cents: number;
  limit_reached: boolean; reached_year: number | null; form_status: 'on_file' | 'missing' | 'needs_update'; form_needed: boolean; payout_blocked: boolean;
};
type Profile = {
  status: 'submitted' | 'needs_update'; is_us_person: boolean; legal_name: string; business_name: string | null; classification: string;
  llc_tax_class: string | null; other_description: string | null; address_street: string; address_city: string; address_state: string | null;
  address_postal: string | null; address_country: string; tin_type: 'ssn' | 'ein' | null; tin_last4: string | null; tax_residence_country: string | null;
  foreign_tin_last4: string | null; date_of_birth: string | null; signature_name: string; signed_at: string; certification_text: string;
  needs_update_note: string | null; updated_at: string;
};
type TaxInfo = {
  currency: string; status: Status; profile: Profile | null;
  prefill: { legal_name: string | null; legal_name_source: 'payout_details' | 'owner_name' | null; business_name: string | null; address_country: string | null };
  certifications: { us: string; non_us: string }; notified_at: string | null;
};

const CLASS_LABEL: Record<string, string> = {
  individual: 'Individual or sole proprietor',
  single_member_llc: 'Single-member LLC',
  c_corp: 'C corporation',
  s_corp: 'S corporation',
  partnership: 'Partnership',
  trust_estate: 'Trust or estate',
  llc: 'LLC with more than one member',
  other: 'Other',
};
/** Outside the US the American company types do not apply. */
const FOREIGN_CLASS_LABEL: Record<string, string> = { individual: 'Individual', c_corp: 'Company or corporation', partnership: 'Partnership', trust_estate: 'Trust or estate', other: 'Other' };
const LLC_LABEL: Record<string, string> = { c_corp: 'As a C corporation', s_corp: 'As an S corporation', partnership: 'As a partnership' };
const TIN_LABEL: Record<string, string> = { ssn: 'SSN or ITIN', ein: 'EIN' };

const US_STATES: [string, string][] = [
  ['AL', 'Alabama'], ['AK', 'Alaska'], ['AZ', 'Arizona'], ['AR', 'Arkansas'], ['CA', 'California'], ['CO', 'Colorado'], ['CT', 'Connecticut'], ['DE', 'Delaware'],
  ['DC', 'District of Columbia'], ['FL', 'Florida'], ['GA', 'Georgia'], ['HI', 'Hawaii'], ['ID', 'Idaho'], ['IL', 'Illinois'], ['IN', 'Indiana'], ['IA', 'Iowa'],
  ['KS', 'Kansas'], ['KY', 'Kentucky'], ['LA', 'Louisiana'], ['ME', 'Maine'], ['MD', 'Maryland'], ['MA', 'Massachusetts'], ['MI', 'Michigan'], ['MN', 'Minnesota'],
  ['MS', 'Mississippi'], ['MO', 'Missouri'], ['MT', 'Montana'], ['NE', 'Nebraska'], ['NV', 'Nevada'], ['NH', 'New Hampshire'], ['NJ', 'New Jersey'], ['NM', 'New Mexico'],
  ['NY', 'New York'], ['NC', 'North Carolina'], ['ND', 'North Dakota'], ['OH', 'Ohio'], ['OK', 'Oklahoma'], ['OR', 'Oregon'], ['PA', 'Pennsylvania'], ['RI', 'Rhode Island'],
  ['SC', 'South Carolina'], ['SD', 'South Dakota'], ['TN', 'Tennessee'], ['TX', 'Texas'], ['UT', 'Utah'], ['VT', 'Vermont'], ['VA', 'Virginia'], ['WA', 'Washington'],
  ['WV', 'West Virginia'], ['WI', 'Wisconsin'], ['WY', 'Wyoming'], ['AS', 'American Samoa'], ['GU', 'Guam'], ['MP', 'Northern Mariana Islands'], ['PR', 'Puerto Rico'],
  ['VI', 'US Virgin Islands'], ['AA', 'Armed Forces Americas'], ['AE', 'Armed Forces Europe'], ['AP', 'Armed Forces Pacific'],
];

export const taxKey = (brandId: string) => ['studio', 'tax', brandId];

/**
 * Shown on the brand's home and Earnings pages when earnings have reached the
 * tax reporting limit and no usable form is on file. Only brand admins and
 * owners can fill the form in, so only they see it.
 */
export function TaxBanner({ brand }: { brand: StudioBrand }) {
  if (!brand.tax_form_needed || !can(brand.role, 'admin')) return null;
  return (
    <div className="mb-5">
      <Notice tone="warn" action={<LinkButton to={`/studio/${brand.slug}/tax`} variant="sun" icon={<FileWarning className="size-4" />}>Fill in the tax form</LinkButton>}>
        <strong className="block text-[15px]">Tax information needed</strong>
        Earnings for {brand.name} have reached the tax reporting limit. Payouts wait until the tax information form is complete. It takes a few minutes.
      </Notice>
    </div>
  );
}

type Form = {
  is_us_person: boolean; legal_name: string; business_name: string; classification: string; llc_tax_class: string; other_description: string;
  address_street: string; address_city: string; address_state: string; address_postal: string; address_country: string;
  tin_type: 'ssn' | 'ein'; tin: string; tax_residence_country: string; foreign_tin: string; date_of_birth: string; not_us_person: boolean;
  signature_name: string; certify: boolean;
};

function startingForm(d: TaxInfo): Form {
  const p = d.profile;
  if (p) {
    return {
      is_us_person: p.is_us_person, legal_name: p.legal_name, business_name: p.business_name ?? '', classification: p.classification, llc_tax_class: p.llc_tax_class ?? '',
      other_description: p.other_description ?? '', address_street: p.address_street, address_city: p.address_city, address_state: p.address_state ?? '',
      address_postal: p.address_postal ?? '', address_country: p.address_country, tin_type: p.tin_type ?? 'ssn', tin: '', tax_residence_country: p.tax_residence_country ?? '',
      foreign_tin: '', date_of_birth: p.date_of_birth ?? '', not_us_person: false, signature_name: '', certify: false,
    };
  }
  const country = d.prefill.address_country ?? 'US';
  const legal = d.prefill.legal_name ?? '';
  return {
    is_us_person: country === 'US', legal_name: legal, business_name: d.prefill.business_name && d.prefill.business_name !== legal ? d.prefill.business_name : '',
    classification: 'individual', llc_tax_class: '', other_description: '', address_street: '', address_city: '', address_state: '', address_postal: '', address_country: country,
    tin_type: 'ssn', tin: '', tax_residence_country: country === 'US' ? '' : country, foreign_tin: '', date_of_birth: '', not_us_person: false, signature_name: '', certify: false,
  };
}

function TaxForm({ data, onDone, onCancel }: { data: TaxInfo; onDone: () => void; onCancel?: () => void }) {
  const { brand } = useBrand();
  const [f, setF] = useState<Form>(() => startingForm(data));
  const [error, setError] = useState<string | null>(null);
  const set = (patch: Partial<Form>) => setF((cur) => ({ ...cur, ...patch }));
  const us = f.is_us_person;
  const statement = us ? data.certifications.us : data.certifications.non_us;
  const classes = us ? CLASS_LABEL : FOREIGN_CLASS_LABEL;
  const classification = classes[f.classification] ? f.classification : 'individual';
  const usAddress = f.address_country === 'US';
  const tinDigits = f.tin.replace(/\D/g, '');

  const save = useAct(
    () =>
      api(`/api/studio/brands/${brand.id}/tax`, {
        method: 'PUT',
        json: {
          is_us_person: us, legal_name: f.legal_name, business_name: f.business_name || null, classification,
          llc_tax_class: classification === 'llc' ? f.llc_tax_class || null : null, other_description: classification === 'other' ? f.other_description : null,
          address_street: f.address_street, address_city: f.address_city, address_state: f.address_state || null, address_postal: f.address_postal || null, address_country: f.address_country,
          ...(us
            ? { tin_type: f.tin_type, tin: f.tin }
            : { tax_residence_country: f.tax_residence_country || null, foreign_tin: f.foreign_tin || null, date_of_birth: classification === 'individual' && f.date_of_birth ? f.date_of_birth : null, not_us_person: f.not_us_person }),
          signature_name: f.signature_name, certify: f.certify, certification_text: statement,
        },
      }),
    { success: 'Tax information submitted', invalidate: [taxKey(brand.id), ['studio', 'earnings', brand.id], ['studio', 'brands']], onDone },
  );

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (us && tinDigits.length !== 9) return setError(`Enter all 9 digits of the ${f.tin_type === 'ssn' ? 'Social Security number' : 'Employer Identification Number'}.`);
    if (!us && !f.tax_residence_country) return setError('Choose the country of tax residence.');
    if (!us && !f.not_us_person) return setError('Confirm that the payee is not a US person.');
    if (classification === 'llc' && !f.llc_tax_class) return setError('Choose how the LLC is taxed.');
    if (!f.certify) return setError('Tick the box to certify the form before signing.');
    save.mutate(undefined, { onError: (err) => setError(err instanceof Error ? err.message : 'Could not submit the form.') });
  };

  const filledFrom = !data.profile && data.prefill.legal_name ? (data.prefill.legal_name_source === 'payout_details' ? 'your payout details' : 'the brand owner\'s account') : null;

  return (
    <form className="space-y-6" onSubmit={submit} autoComplete="off">
      {filledFrom && <Notice tone="info">We filled in the name{data.prefill.address_country ? ' and country' : ''} from {filledFrom}. Check them: they must match your tax records. We never fill in a taxpayer ID.</Notice>}

      <Group label="Is the person or business being paid a US person?" hint="A US person is a US citizen, a US resident, or a business formed in the United States. Answer for whoever receives the money, not for the readers.">
        <Segmented
          value={us ? 'yes' : 'no'}
          onChange={(v) => set(v === 'yes' ? { is_us_person: true, address_country: f.address_country || 'US' } : { is_us_person: false, tax_residence_country: f.tax_residence_country || (f.address_country !== 'US' ? f.address_country : '') })}
          options={[{ value: 'yes', label: 'Yes, a US person' }, { value: 'no', label: 'No, not a US person' }]}
        />
      </Group>

      <div className="space-y-4">
        <h3 className="text-sm font-semibold">Who is being paid</h3>
        <FormRow>
          <Field label="Legal name" hint={us ? 'Exactly as it appears on the tax return of the person or business being paid.' : 'The full legal name of the person or business being paid.'}>
            <Input value={f.legal_name} onChange={(e) => set({ legal_name: e.target.value })} required minLength={2} maxLength={160} />
          </Field>
          <Field label="Business name" optional hint="Only if you trade under a different name, such as a studio or imprint.">
            <Input value={f.business_name} onChange={(e) => set({ business_name: e.target.value })} maxLength={160} />
          </Field>
        </FormRow>
        <FormRow>
          <Field label={us ? 'Federal tax classification' : 'Type of payee'} hint={us ? 'How the payee files its federal taxes. Most solo creators are "Individual or sole proprietor".' : undefined}>
            <Select value={classification} onChange={(e) => set({ classification: e.target.value })}>
              {Object.entries(classes).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </Select>
          </Field>
          {classification === 'llc' && (
            <Field label="How the LLC is taxed">
              <Select value={f.llc_tax_class} onChange={(e) => set({ llc_tax_class: e.target.value })} required>
                <option value="">Choose…</option>
                {Object.entries(LLC_LABEL).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </Select>
            </Field>
          )}
          {classification === 'other' && (
            <Field label="Describe it" hint="For example: nonprofit organization, cooperative.">
              <Input value={f.other_description} onChange={(e) => set({ other_description: e.target.value })} required maxLength={160} />
            </Field>
          )}
        </FormRow>
      </div>

      <div className="space-y-4">
        <h3 className="text-sm font-semibold">{us ? 'Mailing address' : 'Permanent address'}</h3>
        <Field label="Street address" hint="Number, street, and apartment or suite if there is one.">
          <Input value={f.address_street} onChange={(e) => set({ address_street: e.target.value })} required minLength={3} maxLength={200} autoComplete="off" />
        </Field>
        <FormRow>
          <Field label="City"><Input value={f.address_city} onChange={(e) => set({ address_city: e.target.value })} required maxLength={100} /></Field>
          {usAddress ? (
            <Field label="State">
              <Select value={f.address_state} onChange={(e) => set({ address_state: e.target.value })} required>
                <option value="">Choose…</option>
                {US_STATES.map(([code, name]) => <option key={code} value={code}>{name}</option>)}
              </Select>
            </Field>
          ) : (
            <Field label="State, province or region" optional><Input value={f.address_state} onChange={(e) => set({ address_state: e.target.value })} maxLength={60} /></Field>
          )}
        </FormRow>
        <FormRow>
          <Field label={usAddress ? 'ZIP code' : 'Postal code'} optional={!usAddress}>
            <Input value={f.address_postal} onChange={(e) => set({ address_postal: e.target.value })} required={usAddress} maxLength={20} inputMode={usAddress ? 'numeric' : undefined} placeholder={usAddress ? '46204' : undefined} />
          </Field>
          <Field label="Country">
            <Select value={f.address_country} onChange={(e) => set({ address_country: e.target.value, address_state: '' })} required>
              {COUNTRIES.map((c) => <option key={c.code} value={c.code}>{c.name}</option>)}
            </Select>
          </Field>
        </FormRow>
      </div>

      {us ? (
        <div className="space-y-4">
          <h3 className="text-sm font-semibold">Taxpayer ID</h3>
          <Group label="Which number are you giving us?" hint="Individuals and sole proprietors normally use their Social Security number (or ITIN). Companies use their Employer Identification Number.">
            <Segmented value={f.tin_type} onChange={(v) => set({ tin_type: v })} options={[{ value: 'ssn', label: 'Social Security number (SSN or ITIN)' }, { value: 'ein', label: 'Employer Identification Number (EIN)' }]} />
          </Group>
          <Field
            label={f.tin_type === 'ssn' ? 'Social Security number' : 'Employer Identification Number'}
            hint={`9 digits. Stored encrypted and used only for tax reporting. After you submit, we only ever show the last 4 digits.${data.profile?.tin_last4 ? ` The number on file ends in ${data.profile.tin_last4}; for your security it has to be typed in again.` : ''}`}
            className="max-w-xs"
          >
            <Input value={f.tin} onChange={(e) => set({ tin: e.target.value.replace(/[^\d\s-]/g, '').slice(0, 11) })} required inputMode="numeric" autoComplete="off" spellCheck={false} placeholder={f.tin_type === 'ssn' ? '000-00-0000' : '00-0000000'} className="tabular-nums" />
          </Field>
        </div>
      ) : (
        <div className="space-y-4">
          <h3 className="text-sm font-semibold">Tax residence</h3>
          <FormRow>
            <Field label="Country of tax residence" hint="The country where the payee pays tax on its income.">
              <Select value={f.tax_residence_country} onChange={(e) => set({ tax_residence_country: e.target.value })} required>
                <option value="">Choose…</option>
                {COUNTRIES.filter((c) => c.code !== 'US').map((c) => <option key={c.code} value={c.code}>{c.name}</option>)}
              </Select>
            </Field>
            <Field label="Tax ID in that country" optional hint={`The number your own tax office gave you. Stored encrypted.${data.profile?.foreign_tin_last4 ? ` The one on file ends in ${data.profile.foreign_tin_last4}; enter it again to keep it.` : ''}`}>
              <Input value={f.foreign_tin} onChange={(e) => set({ foreign_tin: e.target.value })} maxLength={40} autoComplete="off" spellCheck={false} />
            </Field>
          </FormRow>
          {classification === 'individual' && (
            <Field label="Date of birth" optional className="max-w-xs"><Input type="date" value={f.date_of_birth} onChange={(e) => set({ date_of_birth: e.target.value })} max={new Date().toISOString().slice(0, 10)} /></Field>
          )}
          <Checkbox checked={f.not_us_person} onChange={(v) => set({ not_us_person: v })} label="The person or business being paid is not a US person" description="Not a US citizen, not a US resident, and not a business formed in the United States." />
        </div>
      )}

      <div className="space-y-4 rounded-xl border border-line bg-ink p-4">
        <h3 className="flex items-center gap-2 text-sm font-semibold"><ShieldCheck className="size-4 text-accent-hover" aria-hidden />Certification and signature</h3>
        <p className="text-sm leading-relaxed text-muted" data-testid="certification">{statement}</p>
        <Checkbox checked={f.certify} onChange={(v) => set({ certify: v })} label="I have read this statement and I certify that it is true" />
        <Field label="Type your full name to sign" hint="Typing your name here is your signature. We record it with the date, time and your network address." className="max-w-md">
          <Input value={f.signature_name} onChange={(e) => set({ signature_name: e.target.value })} required minLength={2} maxLength={160} autoComplete="off" />
        </Field>
      </div>

      {error && <p className="rounded-xl border border-danger/30 bg-danger-soft px-4 py-3 text-sm text-danger" role="alert">{error}</p>}
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" variant="primary" loading={save.isPending}>Sign and submit</Button>
        {onCancel && <Button variant="ghost" onClick={onCancel}>Cancel</Button>}
      </div>
    </form>
  );
}

function OnFile({ p }: { p: Profile }) {
  const address = [p.address_street, p.address_city, [p.address_state, p.address_postal].filter(Boolean).join(' '), countryName(p.address_country)].filter(Boolean).join(', ');
  const kind = p.is_us_person ? CLASS_LABEL[p.classification] : (FOREIGN_CLASS_LABEL[p.classification] ?? CLASS_LABEL[p.classification]);
  return (
    <DefList
      items={[
        ['Payee', p.is_us_person ? 'US person' : 'Not a US person'],
        ['Legal name', p.legal_name],
        ...(p.business_name ? [['Business name', p.business_name] as [string, string]] : []),
        [p.is_us_person ? 'Tax classification' : 'Type of payee', `${kind ?? p.classification}${p.llc_tax_class ? `, taxed ${LLC_LABEL[p.llc_tax_class]?.toLowerCase()}` : ''}${p.other_description ? `: ${p.other_description}` : ''}`],
        ['Address', address],
        ...(p.is_us_person
          ? [['Taxpayer ID', <span key="t" className="tabular-nums">{TIN_LABEL[p.tin_type ?? 'ssn']} ending in {p.tin_last4}</span>] as [string, React.ReactNode]]
          : [
              ['Tax residence', countryName(p.tax_residence_country)] as [string, React.ReactNode],
              ['Tax ID', p.foreign_tin_last4 ? `Ending in ${p.foreign_tin_last4}` : 'Not given'] as [string, React.ReactNode],
              ...(p.date_of_birth ? [['Date of birth', date(`${p.date_of_birth}T12:00:00`)] as [string, React.ReactNode]] : []),
            ]),
        ['Signed', `${p.signature_name}, ${dateTime(p.signed_at)}`],
      ]}
    />
  );
}

function Body() {
  const { brand } = useBrand();
  const [editing, setEditing] = useState(false);
  const info = useQuery({ queryKey: taxKey(brand.id), queryFn: () => api<TaxInfo>(`/api/studio/brands/${brand.id}/tax`) });
  return (
    <Q query={info}>
      {(d) => {
        const s = d.status;
        const m = (c: number) => moneyExact(c, d.currency);
        const p = d.profile;
        const showForm = !p || editing || p.status === 'needs_update';
        const left = Math.max(0, s.limit_cents - s.earnings_cents);
        return (
          <div className="space-y-5">
            {p?.status === 'needs_update' ? (
              <Notice tone="danger"><strong className="block">We need a corrected form</strong>{p.needs_update_note ?? 'Please check your details and submit the form again.'}{s.payout_blocked ? ' Payouts wait until it has been submitted again.' : ''}</Notice>
            ) : s.form_needed ? (
              <Notice tone="warn"><strong className="block">Tax information needed</strong>Your {s.reached_year} earnings reached the tax reporting limit of {m(s.limit_cents)}. {s.required ? 'Fill in the form below so payouts can continue.' : 'Please fill in the form below.'}</Notice>
            ) : p ? (
              <Notice tone="ok"><span className="flex items-start gap-2.5"><FileCheck2 className="mt-0.5 size-4 shrink-0" aria-hidden /><span><strong>Your tax information is on file.</strong> Submitted {date(p.updated_at)}. There is nothing else to do unless your details change.</span></span></Notice>
            ) : null}

            <Section title={`Earnings in ${s.year}`} description="Your share of sales, tips and membership reads this calendar year, after refunds.">
              <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                <p className="font-display text-2xl font-bold tabular-nums">{m(s.earnings_cents)} <span className="text-base font-normal text-muted">of {m(s.limit_cents)}</span></p>
                <Badge tone={s.earnings_cents >= s.limit_cents ? 'warn' : 'neutral'}>{s.earnings_cents >= s.limit_cents ? 'Limit reached' : `${m(left)} to go`}</Badge>
              </div>
              <ProgressBar value={Math.max(0, s.earnings_cents)} max={s.limit_cents} />
              <p className="text-sm text-muted">
                {m(s.limit_cents)} is the tax reporting limit. If your earnings in a calendar year reach it, we ask you for the tax information form on this page, and payouts wait until it is complete.
                We use it to prepare your year-end tax form, the tax form the law requires for these earnings. You can fill it in ahead of time.
              </p>
              {s.previous_earnings_cents >= s.limit_cents && <p className="text-sm text-muted">In {s.previous_year} you earned {m(s.previous_earnings_cents)}, which reached the limit for that year.</p>}
            </Section>

            <Section
              title="Tax information form"
              description={showForm ? 'Tell us who is being paid. It takes a few minutes, and only brand owners and admins can see or change it.' : 'What we have on file. Only brand owners and admins can see or change it.'}
              actions={p && !showForm ? <Button onClick={() => setEditing(true)}>Update the form</Button> : undefined}
            >
              {showForm ? (
                <TaxForm key={p?.updated_at ?? 'new'} data={d} onDone={() => setEditing(false)} onCancel={p && p.status !== 'needs_update' ? () => setEditing(false) : undefined} />
              ) : (
                <OnFile p={p!} />
              )}
            </Section>
            <p className="text-sm text-muted">Looking for where your money goes? <Link className="link" to={`/studio/${brand.slug}/settings/payouts`}>Payout details</Link> · <Link className="link" to={`/studio/${brand.slug}/earnings`}>Earnings</Link></p>
          </div>
        );
      }}
    </Q>
  );
}

export function TaxPage() {
  const { role } = useBrand();
  return <BrandPage title="Tax information">{can(role, 'admin') ? <Body /> : <RoleNotice need="admin" />}</BrandPage>;
}
