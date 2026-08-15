-- 041: Widen notification_deliveries.status for the durable-outbox lifecycle.
--
-- 040 turned the table into an outbox, but an older CHECK constraint still pins
-- status to the audit-era values ('sent','failed'). Allow the full lifecycle.
-- 'failed' is kept for backward compatibility with any existing audit rows.

alter table public.notification_deliveries
  drop constraint if exists notification_deliveries_status_check;

alter table public.notification_deliveries
  add constraint notification_deliveries_status_check
  check (status in ('pending', 'processing', 'retry', 'sent', 'dead', 'failed'));

notify pgrst, 'reload schema';
