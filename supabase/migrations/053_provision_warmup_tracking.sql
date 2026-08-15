-- 053: warmup-period tracking + resilient imaging for provision batches.
--
-- warmup_days: the operator-chosen warmup window picked in the buy wizard
-- (product options: 1w/2w/3w/1m/2m/3m; default two weeks). warmup_started_at is
-- stamped when the batch's Smartlead warmup settings are applied (the exporting
-- -> review flip); warmup_started_at + warmup_days is when the batch counts as
-- campaign-ready and gets its ONE Slack ping (warmup_ready_notified_at is the
-- claim marker - set atomically before sending so overlapping crons can never
-- double-post). image_error surfaces the latest profile-image failure: Zapmail
-- rejects mailbox updates for a while after creation even when the mailbox
-- reports ACTIVE, so imaging retries in the background and must never block the
-- Smartlead export.

alter table public.zapmail_provisions
  add column if not exists warmup_days integer not null default 14
    check (warmup_days in (7, 14, 21, 30, 60, 90)),
  add column if not exists warmup_started_at timestamptz,
  add column if not exists warmup_ready_notified_at timestamptz,
  add column if not exists image_error text;

-- Legacy batches (pre-053): notified_at was written at the moment the Smartlead
-- warmup defaults were applied, so it doubles as the warmup start.
update public.zapmail_provisions
  set warmup_started_at = notified_at
  where warmup_started_at is null
    and notified_at is not null
    and status in ('review', 'complete');

create index if not exists zapmail_provisions_warmup_ready_idx
  on public.zapmail_provisions (warmup_started_at)
  where warmup_started_at is not null and warmup_ready_notified_at is null;

notify pgrst, 'reload schema';
