-- Studio / reader fix pass.

-- Takedowns keep what readers bought readable (see lib/access.ts canView).
-- takedown_purge marks the rare removal where access must end for everyone
-- (illegal content): only platform admins can open the series then.
alter table series add column takedown_purge boolean not null default false;

-- When the series first left draft. Followers are told about the releases it
-- already has exactly once, at that moment.
alter table series add column launched_at timestamptz;
update series set launched_at = created_at where visibility <> 'draft';

-- Follower announcements sent by a brand (Studio > Marketing).
create table brand_announcements (
  id            uuid primary key default uuidv7(),
  publisher_id  uuid not null references publishers(id) on delete cascade,
  series_id     uuid references series(id) on delete set null,
  subject       text not null,
  body          text not null,
  recipients    integer not null default 0,
  sent_by       uuid references users(id) on delete set null,
  created_at    timestamptz not null default now()
);
create index brand_announcements_pub_idx on brand_announcements (publisher_id, created_at desc);

alter table emails add column announcement_id uuid references brand_announcements(id) on delete set null;
create index emails_announcement_idx on emails (announcement_id) where announcement_id is not null;
