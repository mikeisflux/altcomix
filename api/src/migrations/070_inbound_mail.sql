-- Inbound mail: admin mailboxes fed by the provider's inbound webhook
-- (SendGrid Inbound Parse), replies sent from them, and a sender blocklist.

-- An address the site receives mail at (support@, dmca@ ...).
create table mailboxes (
  id          uuid primary key default uuidv7(),
  address     text not null unique check (address = lower(address) and address ~ '^[^@\s]+@[^@\s]+$'),
  name        text not null,
  is_default  boolean not null default false,
  active      boolean not null default true,
  -- Sent once per sender per day when not empty.
  auto_reply  text not null default '',
  created_by  uuid references users(id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
-- At most one default: mail for an address with no mailbox of its own lands there.
create unique index mailboxes_one_default_idx on mailboxes (is_default) where is_default;

create table inbound_emails (
  id            uuid primary key default uuidv7(),
  mailbox_id    uuid not null references mailboxes(id) on delete cascade,
  from_email    text not null,
  from_name     text not null default '',
  reply_to      text,
  -- The address the mail was actually delivered to (SMTP envelope), then the To and Cc headers as written.
  to_email      text not null,
  to_header     text not null default '',
  cc            text not null default '',
  subject       text not null default '',
  text_body     text not null default '',
  -- Already sanitised by lib/inbound-mail.ts; still only ever shown inside a sandboxed frame.
  html_body     text not null default '',
  message_id    text,
  in_reply_to   text,
  reference_ids text[] not null default '{}',
  -- What the provider's filter said.
  spam_flagged  boolean not null default false,
  spam_score    real,
  spf           text,
  dkim          text,
  -- Where it is filed now (an admin can move it either way).
  spam          boolean not null default false,
  read_at       timestamptz,
  archived_at   timestamptz,
  replied_at    timestamptz,
  thread_key    text not null,
  -- Things the admin should know: attachments left out, text cut short.
  notes         text[] not null default '{}',
  received_at   timestamptz not null default now()
);
-- The provider retries a delivery it thinks failed: one row per Message-ID.
create unique index inbound_emails_message_id_idx on inbound_emails (message_id) where message_id is not null;
create index inbound_emails_mailbox_idx on inbound_emails (mailbox_id, received_at desc);
create index inbound_emails_thread_idx on inbound_emails (thread_key, received_at);
create index inbound_emails_unread_idx on inbound_emails (mailbox_id) where read_at is null and archived_at is null and not spam;
create index inbound_emails_from_idx on inbound_emails (from_email);

create table inbound_attachments (
  id            uuid primary key default uuidv7(),
  email_id      uuid not null references inbound_emails(id) on delete cascade,
  -- Always under private/inbound-mail/: served only through the admin download route.
  storage_key   text not null,
  filename      text not null,
  content_type  text not null default 'application/octet-stream',
  size_bytes    bigint not null default 0,
  created_at    timestamptz not null default now()
);
create index inbound_attachments_email_idx on inbound_attachments (email_id);

-- What was sent from a mailbox: replies, new messages and automatic replies.
create table mailbox_replies (
  id            uuid primary key default uuidv7(),
  mailbox_id    uuid not null references mailboxes(id) on delete cascade,
  thread_key    text not null,
  inbound_id    uuid references inbound_emails(id) on delete set null,
  -- The row in the outbound queue that carries (and logs) the delivery.
  email_id      uuid references emails(id) on delete set null,
  kind          text not null default 'reply' check (kind in ('reply', 'new', 'auto_reply')),
  from_email    text not null,
  to_email      text not null,
  subject       text not null default '',
  text_body     text not null default '',
  sent_by       uuid references users(id) on delete set null,
  created_at    timestamptz not null default now()
);
create index mailbox_replies_thread_idx on mailbox_replies (thread_key, created_at);
create index mailbox_replies_auto_idx on mailbox_replies (mailbox_id, to_email, created_at) where kind = 'auto_reply';

-- Senders whose mail is dropped before anything is stored.
create table inbound_blocklist (
  id           uuid primary key default uuidv7(),
  kind         text not null check (kind in ('address', 'domain')),
  value        text not null check (value = lower(value)),
  reason       text not null default '',
  hits         integer not null default 0,
  last_hit_at  timestamptz,
  created_by   uuid references users(id) on delete set null,
  created_at   timestamptz not null default now(),
  unique (kind, value)
);

-- Mail sent from a mailbox goes through the normal queue with its own sender and threading headers.
alter table emails add column from_email text;
alter table emails add column from_name text;
alter table emails add column reply_to text;
alter table emails add column headers jsonb;
