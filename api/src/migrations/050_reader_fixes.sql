-- Reader / commerce follow-ups.

-- Forum posts and threads can be reported like comments.
alter table reports drop constraint reports_target_kind_check;
alter table reports add constraint reports_target_kind_check
  check (target_kind in ('series','release','comment','publisher','user','forum_post','forum_thread'));

-- Partial refunds: how much of the card charge has gone back so far. The
-- order stays `paid` and keeps what it unlocked; each refund is itemized in
-- orders.meta.partial_refunds (ref, amount, creator / platform / fee parts).
alter table orders add column refunded_cents integer not null default 0 check (refunded_cents >= 0);

-- Weekly emails: one row per recipient per ISO week per kind, written in the
-- same transaction-free step as the send so a week is never sent twice.
create table digest_sends (
  kind       text not null check (kind in ('feed','analytics')),
  week       text not null,            -- ISO week, e.g. 2026-W48
  user_id    uuid not null references users(id) on delete cascade,
  email_id   uuid,                     -- emails.id, null when there was nothing to report
  sent       boolean not null default false,
  created_at timestamptz not null default now(),
  primary key (kind, week, user_id)
);
create index digest_sends_week_idx on digest_sends (week, kind);
