-- Reader + commerce: order bookkeeping for the hosted checkout, saved payment
-- method tokens for membership renewals, and one row per membership charge.

alter table orders add column credit_cents integer not null default 0 check (credit_cents >= 0);
alter table orders add column meta jsonb not null default '{}';
-- Reader's browser at checkout (with orders.ip): sent to the processor as the
-- customer origin, never our own server address.
alter table orders add column user_agent text;
-- Processor payment id (pi_...). Never card data.
alter table orders add column payment_ref text;
alter table orders add column captured_at timestamptz;
create index orders_payment_ref_idx on orders (payment_ref) where payment_ref is not null;

alter table order_items add column meta jsonb not null default '{}';

alter table subscriptions drop constraint subscriptions_status_check;
alter table subscriptions add constraint subscriptions_status_check
  check (status in ('pending','active','past_due','canceled','expired'));
-- Opaque saved payment method token (pm_...) from the processor's hosted
-- setup checkout. The only payment credential NSFWComix stores.
alter table subscriptions add column payment_method_token text;
-- Hosted setup session (cs_...) that produced the token.
alter table subscriptions add column setup_ref text;
create unique index subscriptions_setup_ref_key on subscriptions (setup_ref) where setup_ref is not null;
-- Where the card was entered; forwarded on off-session renewals.
alter table subscriptions add column origin_ip text;
alter table subscriptions add column origin_user_agent text;

-- One row per billed membership period. The id is the reconciliation key sent
-- to the processor (its pledgeId), so it is never reused across periods.
create table subscription_charges (
  id              uuid primary key default uuidv7(),
  subscription_id uuid not null references subscriptions(id) on delete cascade,
  user_id         uuid not null references users(id) on delete cascade,
  period_start    timestamptz not null,
  period_end      timestamptz not null,
  amount_cents    integer not null check (amount_cents > 0),
  fee_cents       integer not null default 0,
  status          text not null default 'pending' check (status in ('pending','paid','failed','refunded')),
  -- declined attempts so far; the next attempt uses idempotency key attempt-<n+1>
  attempts        integer not null default 0,
  -- last call got no decision from the processor: look it up before retrying
  uncertain       boolean not null default false,
  next_attempt_at timestamptz not null default now(),
  payment_ref     text,
  last_error      text,
  captured_at     timestamptz,
  paid_at         timestamptz,
  refunded_at     timestamptz,
  created_at      timestamptz not null default now(),
  unique (subscription_id, period_start)
);
create index subscription_charges_due_idx on subscription_charges (next_attempt_at) where status = 'pending';
create index subscription_charges_payment_ref_idx on subscription_charges (payment_ref) where payment_ref is not null;

alter table sub_months add column charge_id uuid references subscription_charges(id) on delete set null;
