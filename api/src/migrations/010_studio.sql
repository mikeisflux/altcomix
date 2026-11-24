-- Creator Studio: resumable ingestion, release covers, duplicate-free numbering.

-- Identity of the upload item a page came from ("<job id>:<index>"). Makes
-- ingestion idempotent: re-running a job never inserts the same page twice.
alter table pages add column ingest_key text;
create unique index pages_ingest_key on pages (ingest_key) where ingest_key is not null;

-- Archive (PDF/CBZ/ZIP) a page was extracted from, so "Extract" can replace them.
alter table pages add column archive_id uuid references release_archives(id) on delete set null;

-- A running job proves it is alive by touching heartbeat_at; a stale one is
-- picked up again after a restart.
alter table jobs add column heartbeat_at timestamptz;
alter table jobs add column attempts integer not null default 0;
create index jobs_pending_idx on jobs (created_at) where status in ('queued','running');

-- Public cover image of a release (large size; the small one is the same key
-- ending in -sm.webp). Follows cover_page_id, or page 1 when that is null.
alter table releases add column cover_key text;

-- Each release type keeps its own sequence per language edition.
create unique index releases_number_key on releases (series_id, language, kind, number) where deleted_at is null;
