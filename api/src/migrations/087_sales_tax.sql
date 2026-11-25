-- Sales tax collected at checkout (lib/salestax.ts).
--
-- `orders.total_cents` and `subscription_charges.amount_cents` stay PRE-TAX,
-- exactly as before, so creator earnings, fees, the membership pool and every
-- revenue figure keep reading the same numbers. Tax sits beside them:
--
--   charged to the card = total_cents + tax_cents - credit_cents        (orders)
--   charged to the card = amount_cents + tax_cents                      (membership charges)

-- The billing location a buyer last used: prefilled at the next checkout and
-- read when a membership renews.
alter table users
  add column billing_country text check (billing_country ~ '^[A-Z]{2}$'),
  add column billing_state   text check (billing_state ~ '^[A-Z]{2}$'),
  add column billing_zip     text check (billing_zip ~ '^[0-9]{5}(-[0-9]{4})?$');

alter table orders
  add column tax_cents          integer not null default 0 check (tax_cents >= 0),
  -- the part of total_cents that tax was worked out on (after discounts, before store credit)
  add column taxable_cents      integer not null default 0 check (taxable_cents >= 0),
  add column tax_country        text,
  add column tax_state          text,
  add column tax_zip            text,
  add column tax_rate_bps       integer not null default 0 check (tax_rate_bps >= 0),
  add column tax_refunded_cents integer not null default 0,
  add constraint orders_tax_refunded_check check (tax_refunded_cents >= 0 and tax_refunded_cents <= tax_cents);

-- Each line's share of the order's tax (largest remainder; the lines sum to orders.tax_cents).
alter table order_items add column tax_cents integer not null default 0 check (tax_cents >= 0);

alter table subscription_charges
  add column tax_cents          integer not null default 0 check (tax_cents >= 0),
  add column taxable_cents      integer not null default 0 check (taxable_cents >= 0),
  add column tax_country        text,
  add column tax_state          text,
  add column tax_zip            text,
  add column tax_rate_bps       integer not null default 0 check (tax_rate_bps >= 0),
  add column tax_refunded_cents integer not null default 0,
  add constraint subscription_charges_tax_refunded_check check (tax_refunded_cents >= 0 and tax_refunded_cents <= tax_cents);

-- One row each time tax goes back to a buyer (full refund, partial refund,
-- chargeback), dated, so the sales tax report can net it out per period.
create table sales_tax_refunds (
  id         uuid primary key default uuidv7(),
  order_id   uuid references orders(id) on delete cascade,
  charge_id  uuid references subscription_charges(id) on delete cascade,
  state      text not null,
  tax_cents  integer not null check (tax_cents > 0),
  created_at timestamptz not null default now(),
  check ((order_id is null) <> (charge_id is null))
);
create index sales_tax_refunds_created_idx on sales_tax_refunds (created_at);
create index sales_tax_refunds_order_idx on sales_tax_refunds (order_id);
create index sales_tax_refunds_charge_idx on sales_tax_refunds (charge_id);

create index orders_tax_paid_idx on orders (paid_at) where tax_state is not null;
create index subscription_charges_tax_paid_idx on subscription_charges (paid_at) where tax_state is not null;
