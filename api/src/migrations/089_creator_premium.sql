-- Creator Premium: an optional yearly plan a brand pays the platform for
-- (lib/payments.ts PREMIUM book, lib/premium.ts).
--
-- The two tables mirror `subscriptions` / `subscription_charges` column for
-- column, so the same billing code runs both (first charge through a saved
-- card, renewals, retries after a decline, refunds, sales tax). They are
-- separate tables on purpose: nothing that reads reader memberships, the
-- membership revenue pool (`sub_months`), settlement or the creator ledger
-- can ever see a Premium payment. Premium money is platform revenue only.

create table premium_subscriptions (
  id            uuid primary key default uuidv7(),
  publisher_id  uuid not null references publishers(id) on delete cascade,
  -- Who pays: the brand owner/admin whose saved card and billing location are used.
  -- For a complimentary grant, the platform admin who gave it.
  user_id       uuid not null references users(id) on delete cascade,
  plan          text not null default 'annual' check (plan = 'annual'),
  status        text not null default 'pending' check (status in ('pending','active','past_due','canceled','expired')),
  -- 'sandbox' | 'divinity' for a paid plan; 'comp' for a complimentary grant (no card, ends on its end date).
  provider      text not null,
  provider_ref  text,
  price_cents   integer not null check (price_cents >= 0),
  current_period_start timestamptz not null,
  current_period_end   timestamptz not null,
  cancel_at_period_end boolean not null default false,
  canceled_at   timestamptz,
  payment_method_token text,
  setup_ref     text,
  origin_ip     text,
  origin_user_agent text,
  -- Complimentary grants: why it was given.
  note          text,
  created_at    timestamptz not null default now()
);
create index premium_subscriptions_publisher_idx on premium_subscriptions (publisher_id, status);
create unique index premium_subscriptions_setup_ref_key on premium_subscriptions (setup_ref) where setup_ref is not null;
-- A brand has at most one plan running at a time (relaxed in 090: one paid plan and one grant).
create unique index premium_subscriptions_live_key on premium_subscriptions (publisher_id) where status in ('active','past_due');

-- One row per billed year. The id is the reconciliation key sent to the processor.
-- amount_cents is PRE-TAX; charged to the card = amount_cents + tax_cents.
create table premium_charges (
  id              uuid primary key default uuidv7(),
  subscription_id uuid not null references premium_subscriptions(id) on delete cascade,
  user_id         uuid not null references users(id) on delete cascade,
  period_start    timestamptz not null,
  period_end      timestamptz not null,
  amount_cents    integer not null check (amount_cents > 0),
  fee_cents       integer not null default 0,
  status          text not null default 'pending' check (status in ('pending','paid','failed','refunded')),
  attempts        integer not null default 0,
  uncertain       boolean not null default false,
  next_attempt_at timestamptz not null default now(),
  payment_ref     text,
  last_error      text,
  captured_at     timestamptz,
  paid_at         timestamptz,
  refunded_at     timestamptz,
  tax_cents          integer not null default 0 check (tax_cents >= 0),
  taxable_cents      integer not null default 0 check (taxable_cents >= 0),
  tax_country        text,
  tax_state          text,
  tax_zip            text,
  tax_rate_bps       integer not null default 0 check (tax_rate_bps >= 0),
  tax_refunded_cents integer not null default 0,
  created_at      timestamptz not null default now(),
  unique (subscription_id, period_start),
  constraint premium_charges_tax_refunded_check check (tax_refunded_cents >= 0 and tax_refunded_cents <= tax_cents)
);
create index premium_charges_due_idx on premium_charges (next_attempt_at) where status = 'pending';
create index premium_charges_payment_ref_idx on premium_charges (payment_ref) where payment_ref is not null;
create index premium_charges_paid_idx on premium_charges (paid_at);

-- Tax that went back on a refunded Premium charge, for the sales tax report.
alter table sales_tax_refunds add column premium_charge_id uuid references premium_charges(id) on delete cascade;
alter table sales_tax_refunds drop constraint sales_tax_refunds_check;
alter table sales_tax_refunds add constraint sales_tax_refunds_check
  check ((order_id is not null)::int + (charge_id is not null)::int + (premium_charge_id is not null)::int = 1);
create index sales_tax_refunds_premium_charge_idx on sales_tax_refunds (premium_charge_id);

-- Publisher terms: the Creator Premium section, added once.
update cms_pages set body = rtrim(body, E'\n') || $md$

## 11. Creator Premium

Publishing on NSFWComix is free. Creator Premium is an optional paid plan for a brand.

- **What it unlocks:** a "Buy in print" link on your releases, and advanced analytics in Studio (where readers stop, reader countries, followers, engagement, email statistics and CSV exports). Everyone on the brand's team can use these while the brand's Premium is active.
- **Price:** $140 per year for each brand. The current price is always shown in Studio before you subscribe. Where sales tax applies it is added to the price and shown before you pay.
- **Renewal:** Premium is billed once a year and renews automatically on the saved card until you cancel.
- **Canceling:** you can cancel at any time in Studio. Premium stays active until the end of the year you paid for and does not renew.
- **Refunds:** all sales are final. We do not give refunds, including for a year that has already started.
- **When Premium ends:** print links you saved are kept but are no longer shown to readers, and the advanced analytics close. Both come back if you subscribe again. Nothing you published is removed.
$md$, updated_at = now()
 where slug = 'publisher-terms' and body not like '%Creator Premium%';
