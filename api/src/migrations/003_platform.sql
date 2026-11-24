-- Platform operations: settings, email, audit, storefront curation.

-- Admin-editable configuration. Secret values are stored AES-256-GCM encrypted
-- (see lib/settings.ts) and never returned to the browser.
create table settings (
  key         text primary key,
  value       jsonb not null,
  is_secret   boolean not null default false,
  updated_by  uuid references users(id) on delete set null,
  updated_at  timestamptz not null default now()
);

create table email_templates (
  key         text primary key,
  subject     text not null,
  html        text not null,
  text_body   text not null default '',
  updated_by  uuid references users(id) on delete set null,
  updated_at  timestamptz not null default now()
);

-- Outbound mail queue and log in one table.
create table emails (
  id          uuid primary key default uuidv7(),
  to_email    text not null,
  user_id     uuid references users(id) on delete set null,
  template    text,
  category    text not null default 'transactional' check (category in ('transactional','notification','marketing')),
  subject     text not null,
  html        text not null,
  text_body   text not null default '',
  status      text not null default 'queued' check (status in ('queued','sending','sent','failed','suppressed')),
  attempts    integer not null default 0,
  provider    text,
  provider_id text,
  error       text,
  send_after  timestamptz not null default now(),
  created_at  timestamptz not null default now(),
  sent_at     timestamptz,
  opened_at   timestamptz,
  clicked_at  timestamptz
);
create index emails_queue_idx on emails (send_after) where status = 'queued';
create index emails_created_idx on emails (created_at desc);
create index emails_to_idx on emails (lower(to_email));

create table email_suppressions (
  email       text primary key,
  reason      text not null,
  source      text not null default 'manual',
  created_at  timestamptz not null default now()
);

create table audit_log (
  id          uuid primary key default uuidv7(),
  actor_id    uuid references users(id) on delete set null,
  action      text not null,
  target_kind text,
  target_id   text,
  meta        jsonb not null default '{}',
  ip          text,
  created_at  timestamptz not null default now()
);
create index audit_log_created_idx on audit_log (created_at desc);
create index audit_log_actor_idx on audit_log (actor_id, created_at desc);

-- Hand-picked storefront rows managed from /admin.
create table featured (
  id          uuid primary key default uuidv7(),
  slot        text not null default 'hero' check (slot in ('hero','staff_picks','spotlight')),
  series_id   uuid not null references series(id) on delete cascade,
  blurb       text not null default '',
  position    integer not null default 0,
  starts_at   timestamptz,
  ends_at     timestamptz,
  created_at  timestamptz not null default now()
);
create index featured_slot_idx on featured (slot, position);

create table cron_runs (
  id          uuid primary key default uuidv7(),
  job         text not null,
  ok          boolean not null,
  detail      text,
  started_at  timestamptz not null default now(),
  finished_at timestamptz
);
create index cron_runs_job_idx on cron_runs (job, started_at desc);
