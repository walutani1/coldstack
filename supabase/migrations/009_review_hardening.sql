-- Hardening from the concurrency review:
-- 1. scheduled_actions gets a 'processing' state so a resume is only marked
--    'done' AFTER Smartlead confirms it (a crash mid-flight re-queues instead
--    of silently losing the resume).
-- 2. reply_sends gains an atomic duplicate guard: same thread + same body can
--    only be 'sending'/'sent' once, enforced by the database, regardless of
--    idempotency keys.
alter table scheduled_actions drop constraint if exists scheduled_actions_status_check;
alter table scheduled_actions add constraint scheduled_actions_status_check
  check (status in ('scheduled', 'processing', 'done', 'canceled', 'failed'));

alter table reply_sends add column if not exists body_hash text;
update reply_sends set body_hash = md5(body) where body_hash is null;

create unique index if not exists reply_sends_event_body_active_key
  on reply_sends (reply_event_id, body_hash)
  where status in ('sending', 'sent');
