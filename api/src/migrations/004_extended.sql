-- Features catalogued from the reference screenshots (docs/FEATURES.md):
-- translated editions, country rules, bundles, discounts, gift cards, page
-- credits, revenue splits, conventions, forums, messaging, notifications,
-- news, CMS pages, announcements, feedback.

-- Per-language edition of a series (title/description and its own paywall).
create table series_editions (
  series_id    uuid not null references series(id) on delete cascade,
  language     text not null,
  title        text not null,
  description  text not null default '',
  access_model text check (access_model in ('blocked','free','premium')),
  created_at   timestamptz not null default now(),
  primary key (series_id, language)
);

-- Country-specific licensing overrides.
create table country_rules (
  id          uuid primary key default uuidv7(),
  series_id   uuid not null references series(id) on delete cascade,
  language    text,
  country     text not null,
  rule        text not null check (rule in ('blocked','free','premium')),
  enabled     boolean not null default true,
  created_at  timestamptz not null default now()
);
create index country_rules_series_idx on country_rules (series_id, country);

-- Archives a creator uploaded (PDF/CBZ/ZIP) kept so pages can be re-extracted.
create table release_archives (
  id          uuid primary key default uuidv7(),
  release_id  uuid not null references releases(id) on delete cascade,
  filename    text not null,
  storage_key text not null,
  bytes       bigint not null,
  created_at  timestamptz not null default now()
);
create index release_archives_release_idx on release_archives (release_id);

create table bundles (
  id           uuid primary key default uuidv7(),
  publisher_id uuid not null references publishers(id) on delete cascade,
  title        text not null,
  description  text not null default '',
  price_cents  integer not null check (price_cents >= 0),
  includes_download boolean not null default false,
  active       boolean not null default true,
  created_at   timestamptz not null default now()
);
create table bundle_items (
  bundle_id   uuid not null references bundles(id) on delete cascade,
  release_id  uuid not null references releases(id) on delete cascade,
  primary key (bundle_id, release_id)
);

-- Timed percentage sales set by a publisher.
create table discounts (
  id           uuid primary key default uuidv7(),
  publisher_id uuid not null references publishers(id) on delete cascade,
  label        text not null,
  percent_off  integer not null check (percent_off between 1 and 95),
  series_id    uuid references series(id) on delete cascade,
  applies_to   text not null default 'all' check (applies_to in ('all','read','download')),
  starts_at    timestamptz not null default now(),
  ends_at      timestamptz,
  active       boolean not null default true,
  created_at   timestamptz not null default now()
);
create index discounts_pub_idx on discounts (publisher_id, active);

alter table order_items drop constraint order_items_kind_check;
alter table order_items add constraint order_items_kind_check
  check (kind in ('release','download','series','bundle','tip','subscription','gift_card','credits'));
alter table order_items add column bundle_id uuid references bundles(id) on delete set null;

alter table entitlements add column can_download boolean not null default false;

create table gift_cards (
  id           uuid primary key default uuidv7(),
  code         text not null,
  amount_cents integer not null check (amount_cents > 0),
  balance_cents integer not null,
  purchaser_id uuid references users(id) on delete set null,
  recipient_email text,
  message      text not null default '',
  order_id     uuid references orders(id) on delete set null,
  redeemed_by  uuid references users(id) on delete set null,
  redeemed_at  timestamptz,
  created_at   timestamptz not null default now()
);
create unique index gift_cards_code_key on gift_cards (upper(code));

-- Store credit (from gift cards / refunds) and page credits per reader.
create table wallets (
  user_id       uuid primary key references users(id) on delete cascade,
  credit_cents  integer not null default 0 check (credit_cents >= 0),
  page_credits  integer not null default 0 check (page_credits >= 0),
  updated_at    timestamptz not null default now()
);
create table wallet_log (
  id          uuid primary key default uuidv7(),
  user_id     uuid not null references users(id) on delete cascade,
  kind        text not null,
  credit_cents integer not null default 0,
  page_credits integer not null default 0,
  note        text,
  created_at  timestamptz not null default now()
);
create index wallet_log_user_idx on wallet_log (user_id, created_at desc);

-- Single pages unlocked with a page credit.
create table page_unlocks (
  user_id    uuid not null references users(id) on delete cascade,
  page_id    uuid not null references pages(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, page_id)
);

alter table page_reads drop constraint page_reads_via_check;
alter table page_reads add constraint page_reads_via_check
  check (via in ('free','subscription','purchase','code','owner','credit'));

alter table promo_codes drop constraint promo_codes_kind_check;
alter table promo_codes add constraint promo_codes_kind_check
  check (kind in ('unlock','discount','membership','credits'));
alter table promo_codes add column page_credits integer;
alter table promo_codes add column includes_download boolean not null default false;

-- Automatic split of a series' earnings between collaborators.
create table revenue_splits (
  id           uuid primary key default uuidv7(),
  series_id    uuid not null references series(id) on delete cascade,
  payee_publisher_id uuid not null references publishers(id) on delete cascade,
  share_bps    integer not null check (share_bps between 1 and 10000),
  note         text not null default '',
  created_at   timestamptz not null default now(),
  unique (series_id, payee_publisher_id)
);

create table favorites (
  user_id    uuid not null references users(id) on delete cascade,
  series_id  uuid not null references series(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, series_id)
);
create index favorites_series_idx on favorites (series_id);

create table tips (
  id           uuid primary key default uuidv7(),
  user_id      uuid references users(id) on delete set null,
  publisher_id uuid not null references publishers(id) on delete cascade,
  order_id     uuid references orders(id) on delete set null,
  amount_cents integer not null,
  message      text not null default '',
  show_amount  boolean not null default true,
  created_at   timestamptz not null default now()
);
create index tips_pub_idx on tips (publisher_id, created_at desc);

create table conventions (
  id           uuid primary key default uuidv7(),
  publisher_id uuid not null references publishers(id) on delete cascade,
  name         text not null,
  location     text not null default '',
  booth        text not null default '',
  url          text,
  starts_on    date not null,
  ends_on      date,
  created_at   timestamptz not null default now()
);
create index conventions_pub_idx on conventions (publisher_id, starts_on);

create table publisher_invites (
  id           uuid primary key default uuidv7(),
  publisher_id uuid not null references publishers(id) on delete cascade,
  email        text not null,
  role         text not null default 'editor',
  token_hash   text not null unique,
  invited_by   uuid references users(id) on delete set null,
  accepted_at  timestamptz,
  expires_at   timestamptz not null,
  created_at   timestamptz not null default now()
);

-- Forums: site-wide boards (series_id null) and per-series boards.
create table forum_threads (
  id          uuid primary key default uuidv7(),
  series_id   uuid references series(id) on delete cascade,
  board       text not null default 'general',
  user_id     uuid not null references users(id) on delete cascade,
  title       text not null,
  pinned      boolean not null default false,
  locked      boolean not null default false,
  reply_count integer not null default 0,
  last_post_at timestamptz not null default now(),
  deleted_at  timestamptz,
  created_at  timestamptz not null default now()
);
create index forum_threads_idx on forum_threads (series_id, board, pinned desc, last_post_at desc);

create table forum_posts (
  id          uuid primary key default uuidv7(),
  thread_id   uuid not null references forum_threads(id) on delete cascade,
  user_id     uuid not null references users(id) on delete cascade,
  body        text not null,
  edited_at   timestamptz,
  deleted_at  timestamptz,
  created_at  timestamptz not null default now()
);
create index forum_posts_thread_idx on forum_posts (thread_id, created_at);

create table forum_moderators (
  series_id  uuid not null references series(id) on delete cascade,
  user_id    uuid not null references users(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (series_id, user_id)
);

-- Direct messages.
create table conversations (
  id          uuid primary key default uuidv7(),
  user_a      uuid not null references users(id) on delete cascade,
  user_b      uuid not null references users(id) on delete cascade,
  last_message_at timestamptz not null default now(),
  created_at  timestamptz not null default now(),
  check (user_a < user_b),
  unique (user_a, user_b)
);
create table messages (
  id          uuid primary key default uuidv7(),
  conversation_id uuid not null references conversations(id) on delete cascade,
  sender_id   uuid not null references users(id) on delete cascade,
  body        text not null,
  read_at     timestamptz,
  created_at  timestamptz not null default now()
);
create index messages_conv_idx on messages (conversation_id, created_at);

create table notifications (
  id          uuid primary key default uuidv7(),
  user_id     uuid not null references users(id) on delete cascade,
  kind        text not null,
  title       text not null,
  body        text not null default '',
  url         text,
  read_at     timestamptz,
  created_at  timestamptz not null default now()
);
create index notifications_user_idx on notifications (user_id, created_at desc);

-- Admin-authored content.
create table news_posts (
  id          uuid primary key default uuidv7(),
  slug        text not null unique,
  title       text not null,
  excerpt     text not null default '',
  body        text not null,
  cover_key   text,
  author_id   uuid references users(id) on delete set null,
  published_at timestamptz,
  created_at  timestamptz not null default now()
);

create table cms_pages (
  slug        text primary key,
  title       text not null,
  body        text not null,
  updated_by  uuid references users(id) on delete set null,
  updated_at  timestamptz not null default now()
);

create table announcements (
  id          uuid primary key default uuidv7(),
  kind        text not null default 'bar' check (kind in ('bar','modal')),
  headline    text not null,
  body        text not null default '',
  cta_label   text,
  cta_url     text,
  image_key   text,
  starts_at   timestamptz not null default now(),
  ends_at     timestamptz,
  active      boolean not null default true,
  created_at  timestamptz not null default now()
);

alter table featured add column image_key text;
alter table featured add column headline text;
alter table featured add column url text;
alter table featured alter column series_id drop not null;

create table feedback (
  id          uuid primary key default uuidv7(),
  user_id     uuid references users(id) on delete set null,
  email       text,
  category    text not null default 'general',
  body        text not null,
  page_url    text,
  status      text not null default 'new' check (status in ('new','read','resolved')),
  created_at  timestamptz not null default now()
);

-- Per-email engagement attributed to a publisher (follower announcements).
alter table emails add column publisher_id uuid references publishers(id) on delete set null;
create index emails_pub_idx on emails (publisher_id, created_at desc);
