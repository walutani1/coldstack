-- Concurrency-safe processing: events are claimed ('processing') before the
-- AI call so the webhook after(), page-load drain, and cron can't double-
-- process the same reply. Stale claims (crashed worker) are re-queued after
-- 10 minutes via process_started_at.
alter table reply_events drop constraint if exists reply_events_status_check;
alter table reply_events add constraint reply_events_status_check
  check (status in ('received', 'processing', 'processed', 'error', 'ignored'));

alter table reply_events add column if not exists process_started_at timestamptz;
