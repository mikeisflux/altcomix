-- Creator tax information: one current profile per brand, collected when a
-- brand's earnings in a calendar year reach the tax reporting limit.
create table tax_profiles (
  publisher_id      uuid primary key references publishers(id) on delete cascade,
  status            text not null default 'submitted' check (status in ('submitted','needs_update')),

  -- Who is being paid.
  is_us_person      boolean not null,
  legal_name        text not null,
  business_name     text,
  classification    text not null check (classification in
                      ('individual','single_member_llc','c_corp','s_corp','partnership','trust_estate','llc','other')),
  -- Only for classification = 'llc': how the LLC is taxed.
  llc_tax_class     text check (llc_tax_class in ('c_corp','s_corp','partnership')),
  -- Only for classification = 'other': what it is, in the payee's words.
  other_description text,

  address_street    text not null,
  address_city      text not null,
  address_state     text,
  address_postal    text,
  address_country   text not null,

  -- Taxpayer ID. The number itself is only ever stored encrypted (lib/crypto.ts, AES-256-GCM
  -- with APP_SECRET); the last four digits are kept beside it for display.
  tin_type          text check (tin_type in ('ssn','ein')),
  tin_encrypted     text,
  tin_last4         text,

  -- Payees who are not US persons.
  tax_residence_country text,
  foreign_tin_encrypted text,
  foreign_tin_last4     text,
  date_of_birth         date,
  not_us_person_statement boolean not null default false,

  -- Typed-signature certification.
  signature_name     text not null,
  signed_at          timestamptz not null default now(),
  signature_ip       text,
  certification_text text not null,

  submitted_by      uuid references users(id) on delete set null,
  -- Set when an admin asks for a corrected form.
  needs_update_note text,
  needs_update_at   timestamptz,
  needs_update_by   uuid references users(id) on delete set null,

  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),

  check (classification <> 'llc' or llc_tax_class is not null),
  check (not is_us_person or (tin_type is not null and tin_encrypted is not null and tin_last4 is not null)),
  check (is_us_person or (tax_residence_country is not null and not_us_person_statement))
);

-- "Your earnings reached the tax reporting limit" is sent once per brand per calendar year.
create table tax_notices (
  publisher_id uuid not null references publishers(id) on delete cascade,
  year         integer not null,
  earnings_cents bigint not null,
  limit_cents  bigint not null,
  notified_at  timestamptz not null default now(),
  primary key (publisher_id, year)
);

-- Earnings per brand per year are summed from the ledger by date.
create index ledger_earning_year_idx on ledger (publisher_id, created_at) where kind in ('sale','tip','subscription','refund');
