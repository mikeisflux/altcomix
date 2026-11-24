-- NSFWComix core schema. Postgres 18+ (uses uuidv7()).

create table users (
  id              uuid primary key default uuidv7(),
  email           text not null,
  username        text not null,
  display_name    text not null default '',
  password_hash   text not null,
  role            text not null default 'user' check (role in ('user','admin','super_admin')),
  email_verified_at timestamptz,
  totp_secret     text,
  totp_enabled    boolean not null default false,
  avatar_key      text,
  bio             text not null default '',
  prefs           jsonb not null default '{}',
  marketing_opt_in boolean not null default false,
  last_login_at   timestamptz,
  last_ip         text,
  banned_at       timestamptz,
  ban_reason      text,
  deleted_at      timestamptz,
  created_at      timestamptz not null default now()
);
create unique index users_email_key on users (lower(email));
create unique index users_username_key on users (lower(username));

create table sessions (
  token_hash  text primary key,
  user_id     uuid not null references users(id) on delete cascade,
  csrf_token  text not null,
  ip          text,
  user_agent  text,
  created_at  timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  expires_at  timestamptz not null
);
create index sessions_user_idx on sessions (user_id);

create table email_tokens (
  token_hash  text primary key,
  user_id     uuid not null references users(id) on delete cascade,
  kind        text not null check (kind in ('verify','reset','email_change')),
  payload     jsonb not null default '{}',
  expires_at  timestamptz not null,
  used_at     timestamptz,
  created_at  timestamptz not null default now()
);

-- A publisher is the brand page that owns series: a solo creator or an imprint.
create table publishers (
  id            uuid primary key default uuidv7(),
  slug          text not null unique,
  name          text not null,
  kind          text not null default 'creator' check (kind in ('creator','publisher')),
  bio           text not null default '',
  avatar_key    text,
  banner_key    text,
  website       text,
  socials       jsonb not null default '{}',
  country       text,
  timezone      text,
  -- null = platform default from settings
  sale_share_bps   integer check (sale_share_bps between 0 and 10000),
  sub_share_bps    integer check (sub_share_bps between 0 and 10000),
  tip_share_bps    integer check (tip_share_bps between 0 and 10000),
  payout        jsonb not null default '{}',
  tips_enabled  boolean not null default true,
  monthly_goal_cents integer,
  primary_language text not null default 'en',
  ga_tracking_id text,
  membership_note text not null default '',
  kind_requested text,
  verified_at   timestamptz,
  suspended_at  timestamptz,
  suspend_reason text,
  deleted_at    timestamptz,
  created_at    timestamptz not null default now()
);

create table publisher_members (
  publisher_id uuid not null references publishers(id) on delete cascade,
  user_id      uuid not null references users(id) on delete cascade,
  role         text not null default 'editor' check (role in ('owner','admin','editor','analyst')),
  created_at   timestamptz not null default now(),
  primary key (publisher_id, user_id)
);
create index publisher_members_user_idx on publisher_members (user_id);

create table series (
  id            uuid primary key default uuidv7(),
  publisher_id  uuid not null references publishers(id) on delete cascade,
  slug          text not null unique,
  title         text not null,
  description   text not null default '',
  type          text not null default 'comic' check (type in ('comic','graphic_novel','manga','webcomic')),
  layout        text not null default 'paged' check (layout in ('paged','vertical')),
  reading_dir   text not null default 'ltr' check (reading_dir in ('ltr','rtl')),
  language      text not null default 'en',
  status        text not null default 'ongoing' check (status in ('ongoing','completed','hiatus','cancelled')),
  visibility    text not null default 'draft' check (visibility in ('draft','public','unlisted')),
  genre         text,
  themes        text[] not null default '{}',
  audiences     text[] not null default '{}',
  art_styles    text[] not null default '{}',
  advisories    text[] not null default '{}',
  eras          text[] not null default '{}',
  content_ratings text[] not null default '{}',
  tags          text[] not null default '{}',
  mature        boolean not null default false,
  cover_key     text,
  banner_key    text,
  -- free: everything readable. premium: paywall after the free preview.
  access_model  text not null default 'free' check (access_model in ('blocked','free','premium')),
  in_subscription boolean not null default true,
  -- mode: first_releases | first_last_releases | first_pages | custom_first |
  --       custom_first_last | automatic ; n / m are the counts
  free_preview  jsonb not null default '{"mode":"automatic"}',
  paywall_expires_days integer,
  default_price_cents integer check (default_price_cents >= 0),
  allow_comments boolean not null default true,
  update_frequency text,
  website       text,
  pub_year      integer,
  crowdfunding  jsonb,
  forum_enabled boolean not null default false,
  forum_description text not null default '',
  favorite_count integer not null default 0,
  search        tsvector,
  follower_count integer not null default 0,
  read_count    bigint not null default 0,
  takedown_at   timestamptz,
  takedown_reason text,
  deleted_at    timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index series_publisher_idx on series (publisher_id);
create index series_search_idx on series using gin (search);
create index series_public_idx on series (visibility, updated_at desc) where deleted_at is null;

create function series_search_refresh() returns trigger language plpgsql as $$
begin
  new.search :=
    setweight(to_tsvector('simple', coalesce(new.title,'')), 'A') ||
    setweight(to_tsvector('simple', array_to_string(new.tags, ' ') || ' ' || coalesce(new.genre,'')), 'B') ||
    setweight(to_tsvector('english', coalesce(new.description,'')), 'C');
  return new;
end $$;
create trigger series_search_trg before insert or update of title, tags, genre, description
  on series for each row execute function series_search_refresh();

create table releases (
  id            uuid primary key default uuidv7(),
  series_id     uuid not null references series(id) on delete cascade,
  number        numeric(8,2) not null default 1,
  kind          text not null default 'issue' check (kind in
                  ('issue','omake','special','episode','one_shot','graphic_novel','bande_dessinee',
                   'volume','omnibus','compendium')),
  language      text not null default 'en',
  title         text not null,
  synopsis      text not null default '',
  mature        boolean not null default false,
  status        text not null default 'draft' check (status in ('draft','scheduled','published')),
  publish_at    timestamptz,
  published_at  timestamptz,
  -- null = use series default; 0 = not sold a la carte
  price_cents   integer check (price_cents >= 0),
  -- download (PDF) sale: null/0 = not for sale
  download_price_cents integer check (download_price_cents >= 0),
  download_discount_pct integer check (download_discount_pct between 1 and 100),
  -- date after which this release becomes free to read
  free_at       timestamptz,
  themes        text[] not null default '{}',
  audiences     text[] not null default '{}',
  content_ratings text[] not null default '{}',
  -- null = follow the series free preview rule
  free_pages    integer check (free_pages >= 0),
  force_free    boolean not null default false,
  isbn          text,
  print_url     text,
  orig_pub_date date,
  page_count    integer not null default 0,
  cover_page_id uuid,
  spread_pref   text not null default 'last' check (spread_pref in ('first','last')),
  single_cover  boolean not null default true,
  private_token text not null default encode(uuid_send(uuidv4()), 'hex'),
  deleted_at    timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index releases_series_idx on releases (series_id, language, number);
create index releases_published_idx on releases (published_at desc) where status = 'published' and deleted_at is null;

create table pages (
  id          uuid primary key default uuidv7(),
  release_id  uuid not null references releases(id) on delete cascade,
  position    integer not null,
  source_key  text not null,
  width       integer not null,
  height      integer not null,
  bytes       integer not null default 0,
  filename    text,
  dpi         integer,
  -- text regions for transcription/translation: [{"x","y","w","h","text":{"en":"..."}}]
  texts       jsonb not null default '[]',
  -- {"thumb": key, "medium": key, "full": key}
  variants    jsonb not null default '{}',
  bg_color    text not null default '#000000',
  -- null = follow the release rule; true/false = explicit per-page override
  is_free     boolean,
  -- ordered reading frames, each {"x","y","w","h"} as fractions of the page (0..1),
  -- or {"points":[[x,y],...]} for non-rectangular panels
  frames      jsonb not null default '[]',
  frames_source text not null default 'none' check (frames_source in ('none','auto','manual')),
  created_at  timestamptz not null default now()
);
create index pages_release_idx on pages (release_id, position);

create table contributors (
  id          uuid primary key default uuidv7(),
  series_id   uuid not null references series(id) on delete cascade,
  release_id  uuid references releases(id) on delete cascade,
  name        text not null,
  role        text not null,
  user_id     uuid references users(id) on delete set null,
  position    integer not null default 0
);
create index contributors_series_idx on contributors (series_id);

-- Background work: page ingestion, frame detection.
create table jobs (
  id          uuid primary key default uuidv7(),
  kind        text not null,
  release_id  uuid references releases(id) on delete cascade,
  status      text not null default 'queued' check (status in ('queued','running','done','failed')),
  done        integer not null default 0,
  total       integer not null default 0,
  payload     jsonb not null default '{}',
  error       text,
  created_by  uuid references users(id) on delete set null,
  created_at  timestamptz not null default now(),
  finished_at timestamptz
);
create index jobs_release_idx on jobs (release_id, created_at desc);

-- Reader state ---------------------------------------------------------

create table follows (
  user_id     uuid not null references users(id) on delete cascade,
  series_id   uuid not null references series(id) on delete cascade,
  notify      boolean not null default true,
  created_at  timestamptz not null default now(),
  primary key (user_id, series_id)
);
create index follows_series_idx on follows (series_id);

create table publisher_follows (
  user_id      uuid not null references users(id) on delete cascade,
  publisher_id uuid not null references publishers(id) on delete cascade,
  created_at   timestamptz not null default now(),
  primary key (user_id, publisher_id)
);

create table reading_progress (
  user_id     uuid not null references users(id) on delete cascade,
  release_id  uuid not null references releases(id) on delete cascade,
  series_id   uuid not null references series(id) on delete cascade,
  position    integer not null default 0,
  finished    boolean not null default false,
  updated_at  timestamptz not null default now(),
  primary key (user_id, release_id)
);
create index reading_progress_recent_idx on reading_progress (user_id, updated_at desc);

create table comments (
  id          uuid primary key default uuidv7(),
  user_id     uuid not null references users(id) on delete cascade,
  series_id   uuid not null references series(id) on delete cascade,
  release_id  uuid references releases(id) on delete cascade,
  parent_id   uuid references comments(id) on delete cascade,
  body        text not null,
  hidden_at   timestamptz,
  deleted_at  timestamptz,
  created_at  timestamptz not null default now()
);
create index comments_series_idx on comments (series_id, created_at desc);

create table reports (
  id          uuid primary key default uuidv7(),
  reporter_id uuid references users(id) on delete set null,
  target_kind text not null check (target_kind in ('series','release','comment','publisher','user')),
  target_id   uuid not null,
  reason      text not null,
  detail      text not null default '',
  status      text not null default 'open' check (status in ('open','actioned','dismissed')),
  resolved_by uuid references users(id) on delete set null,
  resolved_at timestamptz,
  created_at  timestamptz not null default now()
);
create index reports_status_idx on reports (status, created_at desc);
