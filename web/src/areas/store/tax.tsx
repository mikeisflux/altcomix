import { useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { api } from '@/lib/api';
import { useSession } from '@/lib/session';
import { Field, Input, Select, cx } from '@/ui';

/**
 * Sales tax in the web app: the billing location fields every checkout shows
 * while sales tax is on, and the helpers around them. All amounts come from
 * the server (POST /api/checkout/quote, POST /api/membership/quote); nothing
 * here works out tax.
 */

/** The 50 states and the District of Columbia, as the API accepts them. */
export const US_STATES: readonly [code: string, name: string][] = [
  ['AL', 'Alabama'], ['AK', 'Alaska'], ['AZ', 'Arizona'], ['AR', 'Arkansas'], ['CA', 'California'], ['CO', 'Colorado'], ['CT', 'Connecticut'], ['DE', 'Delaware'],
  ['DC', 'District of Columbia'], ['FL', 'Florida'], ['GA', 'Georgia'], ['HI', 'Hawaii'], ['ID', 'Idaho'], ['IL', 'Illinois'], ['IN', 'Indiana'], ['IA', 'Iowa'],
  ['KS', 'Kansas'], ['KY', 'Kentucky'], ['LA', 'Louisiana'], ['ME', 'Maine'], ['MD', 'Maryland'], ['MA', 'Massachusetts'], ['MI', 'Michigan'], ['MN', 'Minnesota'],
  ['MS', 'Mississippi'], ['MO', 'Missouri'], ['MT', 'Montana'], ['NE', 'Nebraska'], ['NV', 'Nevada'], ['NH', 'New Hampshire'], ['NJ', 'New Jersey'], ['NM', 'New Mexico'],
  ['NY', 'New York'], ['NC', 'North Carolina'], ['ND', 'North Dakota'], ['OH', 'Ohio'], ['OK', 'Oklahoma'], ['OR', 'Oregon'], ['PA', 'Pennsylvania'], ['RI', 'Rhode Island'],
  ['SC', 'South Carolina'], ['SD', 'South Dakota'], ['TN', 'Tennessee'], ['TX', 'Texas'], ['UT', 'Utah'], ['VT', 'Vermont'], ['VA', 'Virginia'], ['WA', 'Washington'],
  ['WV', 'West Virginia'], ['WI', 'Wisconsin'], ['WY', 'Wyoming'],
];
export const stateName = (code: string | null | undefined): string => US_STATES.find(([c]) => c === code)?.[1] ?? code ?? '';

/** ISO 3166-1 alpha-2 country codes; names come from the browser. */
const COUNTRY_CODES =
  'AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW';

let countryList: [string, string][] | null = null;
/** Every country as [code, English name], the United States first, the rest by name. */
function countries(): [string, string][] {
  if (countryList) return countryList;
  let names: Intl.DisplayNames | null = null;
  try {
    names = new Intl.DisplayNames(['en'], { type: 'region' });
  } catch {
    // very old browser: the codes are shown instead
  }
  const all = COUNTRY_CODES.split(' ').map((c): [string, string] => [c, names?.of(c) ?? c]);
  all.sort((a, b) => (a[0] === 'US' ? -1 : b[0] === 'US' ? 1 : a[1].localeCompare(b[1])));
  countryList = all;
  return all;
}
export const countryName = (code: string | null | undefined): string => countries().find(([c]) => c === code)?.[1] ?? code ?? '';

/** The location as the API stores and returns it. */
export type BillingLocation = { country: string; state: string | null; zip: string | null };
/** The location as it sits in the form while being typed. */
export type LocationDraft = { country: string; state: string; zip: string };

const ZIP = /^\d{5}(-\d{4})?$/;
const EMPTY: LocationDraft = { country: '', state: '', zip: '' };
const toDraft = (l: BillingLocation | null | undefined): LocationDraft => (l ? { country: l.country, state: l.state ?? '', zip: l.zip ?? '' } : EMPTY);

/** The draft as a request body, or null while it is not complete enough to send. */
export function locationBody(d: LocationDraft): BillingLocation | null {
  if (!d.country) return null;
  if (d.country !== 'US') return { country: d.country, state: null, zip: null };
  const zip = d.zip.trim();
  return d.state && ZIP.test(zip) ? { country: 'US', state: d.state, zip } : null;
}

/** "Indiana 46204, United States" / "France". */
export function describeLocation(l: BillingLocation | null | undefined): string {
  if (!l) return 'Not set';
  return l.country === 'US' && l.state ? `${stateName(l.state)}${l.zip ? ` ${l.zip}` : ''}, United States` : countryName(l.country);
}

/** Whether the owner has sales tax switched on. Off: no location is asked for anywhere. */
export function useSalesTaxEnabled(): boolean {
  return useSession().settings.tax?.enabled === true;
}

/**
 * The billing location for a checkout form: starts from the one this reader
 * used last time (GET /api/billing-location) and follows what they type.
 * `location` is what to send with a quote or a payment: null until the form
 * is complete. With sales tax off, or `active` false, nothing is fetched and
 * `enabled` is false.
 */
export function useBillingLocation(active: boolean) {
  const { user } = useSession();
  const enabled = useSalesTaxEnabled() && active && Boolean(user);
  const saved = useQuery({
    queryKey: ['billing-location', user?.id],
    queryFn: () => api<{ enabled: boolean; location: BillingLocation | null }>('/api/billing-location'),
    enabled,
    staleTime: 0,
  });
  const [draft, setDraft] = useState<LocationDraft>(EMPTY);
  const [touched, setTouched] = useState(false);
  const stored = saved.data?.location ?? null;
  // Prefill once per opening, and never over something the reader has started typing.
  useEffect(() => {
    if (!active) {
      setTouched(false);
      setDraft(EMPTY);
    } else if (!touched && saved.data) setDraft(toDraft(saved.data.location));
  }, [active, touched, saved.data]);
  const change = (next: LocationDraft) => {
    setTouched(true);
    setDraft(next);
  };
  const location = useMemo(() => locationBody(draft), [draft]);
  return { enabled, ready: !enabled || saved.isFetched || saved.isError, draft, change, location, saved: stored };
}

/**
 * Country, and for the United States state and ZIP code, on one compact row.
 * `error` is the server's complaint about what was entered (for example a ZIP
 * code that is not in the chosen state).
 */
export function LocationFields({ value, onChange, error, note, disabled }: { value: LocationDraft; onChange: (v: LocationDraft) => void; error?: string | null; note?: string; disabled?: boolean }) {
  const us = value.country === 'US';
  const zipStarted = us && value.zip.trim() !== '' && !ZIP.test(value.zip.trim());
  const hint = error ?? (zipStarted ? 'Enter a 5-digit ZIP code.' : null);
  return (
    <fieldset className="min-w-0" data-testid="billing-location" disabled={disabled}>
      <legend className="sr-only">Billing location, used to work out sales tax</legend>
      <div className={cx('grid items-end gap-2', us ? 'grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)_5.25rem]' : 'grid-cols-1')}>
        <Field label="Country">
          <Select value={value.country} autoComplete="country" onChange={(e) => onChange({ country: e.target.value, state: e.target.value === 'US' ? value.state : '', zip: e.target.value === 'US' ? value.zip : '' })}>
            <option value="">Choose…</option>
            {countries().map(([code, name]) => <option key={code} value={code}>{name}</option>)}
          </Select>
        </Field>
        {us && (
          <Field label="State">
            <Select value={value.state} autoComplete="address-level1" onChange={(e) => onChange({ ...value, state: e.target.value })}>
              <option value="">Choose…</option>
              {US_STATES.map(([code, name]) => <option key={code} value={code}>{name}</option>)}
            </Select>
          </Field>
        )}
        {us && (
          <Field label="ZIP code">
            <Input value={value.zip} inputMode="numeric" autoComplete="postal-code" maxLength={10} placeholder="12345" aria-invalid={Boolean(error) || zipStarted} onChange={(e) => onChange({ ...value, zip: e.target.value.replace(/[^\d-]/g, '') })} />
          </Field>
        )}
      </div>
      <p className={cx('mt-1.5 text-xs', error ? 'text-danger' : 'text-faint')} role={error ? 'alert' : undefined}>
        {hint ?? note ?? 'Used to work out sales tax. We remember it for next time.'}
      </p>
    </fieldset>
  );
}

/** What the API says about the tax on a quote. */
export type TaxQuote = {
  needs_location: boolean;
  location: BillingLocation | null;
  state_name: string | null;
  rate_bps: number;
  taxable_cents: number;
  tax_cents: number;
  /** "Sales tax (Indiana 7%)"; null when no tax is charged. */
  label: string | null;
};
