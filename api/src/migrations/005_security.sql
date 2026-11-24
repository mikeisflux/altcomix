-- Bot blocker (ported from IndieCrowdfund), login audit, error tracking.

create table blocked_ips (
  id              uuid primary key default uuidv7(),
  ip_address      text not null unique,
  reason          text not null,
  violation_count integer not null default 1,
  blocked_at      timestamptz not null default now(),
  expires_at      timestamptz not null,
  last_user_agent text,
  last_path       text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index blocked_ips_expires_idx on blocked_ips (expires_at);

create table suspicious_activity (
  id          uuid primary key default uuidv7(),
  ip_address  text not null,
  reason      text not null,
  path        text,
  user_agent  text,
  created_at  timestamptz not null default now()
);
create index suspicious_activity_ip_idx on suspicious_activity (ip_address);
create index suspicious_activity_created_idx on suspicious_activity (created_at desc);

create table login_events (
  id          uuid primary key default uuidv7(),
  user_id     uuid references users(id) on delete cascade,
  email       text,
  ip          text,
  user_agent  text,
  success     boolean not null,
  reason      text,
  created_at  timestamptz not null default now()
);
create index login_events_user_idx on login_events (user_id, created_at desc);
create index login_events_ip_idx on login_events (ip, created_at desc);

alter table users add column failed_logins integer not null default 0;
alter table users add column locked_until timestamptz;
alter table users add column totp_backup_codes text[] not null default '{}';
alter table users add column email_unsubscribed_at timestamptz;

-- Self-hosted error tracking: one row per distinct error.
create table error_groups (
  id           uuid primary key default uuidv7(),
  fingerprint  text not null unique,
  title        text not null,
  source       text not null,
  endpoint     text,
  level        text not null default 'error',
  status       text not null default 'unresolved' check (status in ('unresolved','resolved','ignored')),
  event_count  integer not null default 1,
  last_message text,
  last_stack   text,
  last_meta    jsonb not null default '{}',
  first_seen   timestamptz not null default now(),
  last_seen    timestamptz not null default now()
);
create index error_groups_seen_idx on error_groups (status, last_seen desc);
