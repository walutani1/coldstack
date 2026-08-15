-- Schedule replies for later. A scheduled reply is just a reply_sends row that
-- the cron delivers at scheduled_at (reusing the same Smartlead send path as an
-- immediate reply). Adds the schedule time, a claim timestamp for stale-recovery,
-- and the 'scheduled' / 'canceled' statuses.

alter table reply_sends add column if not exists scheduled_at timestamptz;
alter table reply_sends add column if not exists send_started_at timestamptz;

alter table reply_sends drop constraint if exists reply_sends_status_check;
alter table reply_sends add constraint reply_sends_status_check
  check (status in ('scheduled', 'sending', 'sent', 'failed', 'canceled'));

-- Cron scan: due scheduled rows, oldest first.
create index if not exists reply_sends_scheduled_idx
  on reply_sends (scheduled_at) where status = 'scheduled';
