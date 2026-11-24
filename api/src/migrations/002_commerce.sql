-- Money: subscriptions, direct sales, codes, creator ledger and payouts.
-- All amounts are integer cents in the platform currency.

create table subscriptions (
  id            uuid primary key default uuidv7(),
  user_id       uuid not null references users(id) on delete cascade,
  plan          text not null check (plan in ('monthly','annual')),
  status        text not null default 'active' check (status in ('active','past_due','canceled','expired')),
  provider      text not null,
  provider_ref  text,
  price_cents   integer not null,
  current_period_start timestamptz not null,
  current_period_end   timestamptz not null,
  cancel_at_period_end boolean not null default false,
  canceled_at   timestamptz,
  created_at    timestamptz not null default now()
);
create index subscriptions_user_idx on subscriptions (user_id, status);
create unique index subscriptions_provider_ref_key on subscriptions (provider, provider_ref) where provider_ref is not null;

-- One row per subscriber per calendar month of paid membership. This is the pot
-- that gets split among the publishers that subscriber actually read that month.
create table sub_months (
  id            uuid primary key default uuidv7(),
  user_id       uuid not null references users(id) on delete cascade,
  subscription_id uuid not null references subscriptions(id) on delete cascade,
  month         date not null,
  gross_cents   integer not null,
  fee_cents     integer not null default 0,
  settled_at    timestamptz,
  unique (user_id, month)
);
create index sub_months_month_idx on sub_months (month) where settled_at is null;

-- First read of each page by each reader in each month. Drives analytics and
-- the subscription split. `via` records why the reader had access.
create table page_reads (
  user_id      uuid not null references users(id) on delete cascade,
  page_id      uuid not null references pages(id) on delete cascade,
  month        date not null,
  release_id   uuid not null,
  series_id    uuid not null,
  publisher_id uuid not null,
  via          text not null check (via in ('free','subscription','purchase','code','owner')),
  country      text,
  read_at      timestamptz not null default now(),
  primary key (user_id, page_id, month)
);
create index page_reads_pub_idx on page_reads (publisher_id, read_at);
create index page_reads_series_idx on page_reads (series_id, read_at);
create index page_reads_month_idx on page_reads (month, via);

-- Anonymous reads of free pages (no account): counted for analytics only.
create table anon_reads (
  day          date not null,
  release_id   uuid not null,
  series_id    uuid not null,
  publisher_id uuid not null,
  visitor_hash text not null,
  pages        integer not null default 1,
  primary key (day, release_id, visitor_hash)
);
create index anon_reads_pub_idx on anon_reads (publisher_id, day);

create table orders (
  id            uuid primary key default uuidv7(),
  user_id       uuid not null references users(id) on delete cascade,
  status        text not null default 'pending' check (status in ('pending','paid','failed','refunded')),
  total_cents   integer not null,
  fee_cents     integer not null default 0,
  provider      text not null,
  provider_ref  text,
  discount_code_id uuid,
  ip            text,
  created_at    timestamptz not null default now(),
  paid_at       timestamptz,
  refunded_at   timestamptz
);
create index orders_user_idx on orders (user_id, created_at desc);
create unique index orders_provider_ref_key on orders (provider, provider_ref) where provider_ref is not null;

create table order_items (
  id            uuid primary key default uuidv7(),
  order_id      uuid not null references orders(id) on delete cascade,
  kind          text not null check (kind in ('release','series','tip','subscription')),
  release_id    uuid references releases(id) on delete set null,
  series_id     uuid references series(id) on delete set null,
  publisher_id  uuid references publishers(id) on delete set null,
  description   text not null,
  price_cents   integer not null,
  creator_cents integer not null default 0
);
create index order_items_order_idx on order_items (order_id);
create index order_items_pub_idx on order_items (publisher_id);

create table promo_codes (
  id            uuid primary key default uuidv7(),
  publisher_id  uuid references publishers(id) on delete cascade,
  code          text not null,
  -- unlock: grants ownership of the scoped release(s). discount: percent off at checkout.
  -- membership: grants days of subscription (platform-issued only).
  kind          text not null check (kind in ('unlock','discount','membership')),
  series_id     uuid references series(id) on delete cascade,
  release_id    uuid references releases(id) on delete cascade,
  percent_off   integer check (percent_off between 1 and 100),
  membership_days integer,
  max_redemptions integer,
  redeemed_count integer not null default 0,
  -- label for the campaign or reward tier this batch was generated for
  batch_label   text,
  batch_id      uuid,
  assigned_email text,
  sent_at       timestamptz,
  starts_at     timestamptz,
  expires_at    timestamptz,
  disabled_at   timestamptz,
  created_by    uuid references users(id) on delete set null,
  created_at    timestamptz not null default now()
);
create unique index promo_codes_code_key on promo_codes (upper(code));
create index promo_codes_pub_idx on promo_codes (publisher_id, batch_id);

create table code_redemptions (
  code_id     uuid not null references promo_codes(id) on delete cascade,
  user_id     uuid not null references users(id) on delete cascade,
  created_at  timestamptz not null default now(),
  primary key (code_id, user_id)
);

-- Permanent ownership of a release (bought, redeemed, or granted).
create table entitlements (
  user_id     uuid not null references users(id) on delete cascade,
  release_id  uuid not null references releases(id) on delete cascade,
  source      text not null check (source in ('purchase','code','grant')),
  order_id    uuid references orders(id) on delete set null,
  code_id     uuid references promo_codes(id) on delete set null,
  created_at  timestamptz not null default now(),
  primary key (user_id, release_id)
);

-- Append-only creator earnings. Balance = sum(amount_cents).
create table ledger (
  id            uuid primary key default uuidv7(),
  publisher_id  uuid not null references publishers(id) on delete cascade,
  kind          text not null check (kind in ('sale','subscription','tip','payout','refund','adjustment')),
  amount_cents  integer not null,
  gross_cents   integer not null default 0,
  series_id     uuid,
  release_id    uuid,
  order_id      uuid,
  payout_id     uuid,
  month         date,
  note          text,
  available_at  timestamptz not null default now(),
  created_at    timestamptz not null default now()
);
create index ledger_pub_idx on ledger (publisher_id, created_at desc);
create unique index ledger_sub_month_key on ledger (publisher_id, month, series_id) where kind = 'subscription';

create table payouts (
  id            uuid primary key default uuidv7(),
  publisher_id  uuid not null references publishers(id) on delete cascade,
  amount_cents  integer not null check (amount_cents > 0),
  status        text not null default 'requested' check (status in ('requested','approved','paid','rejected')),
  method        text not null,
  destination   text,
  note          text,
  reference     text,
  requested_by  uuid references users(id) on delete set null,
  reviewed_by   uuid references users(id) on delete set null,
  created_at    timestamptz not null default now(),
  reviewed_at   timestamptz,
  paid_at       timestamptz
);
create index payouts_pub_idx on payouts (publisher_id, created_at desc);
create index payouts_status_idx on payouts (status, created_at);

-- Monthly settlement runs for the subscription split (one row per month).
create table settlements (
  month         date primary key,
  subscribers   integer not null,
  gross_cents   bigint not null,
  fee_cents     bigint not null,
  creator_cents bigint not null,
  platform_cents bigint not null,
  ran_at        timestamptz not null default now(),
  ran_by        uuid references users(id) on delete set null
);
