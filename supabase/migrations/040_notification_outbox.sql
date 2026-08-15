-- 040: Turn notification_deliveries into a durable outbox.
--
-- A reply notification used to be a best-effort call at the very end of the
-- reply-processing function; if that serverless invocation was cut off (a slow
-- reply-draft ate the 60s budget), the notification was lost with no retry.
-- Now each matching channel gets a durable delivery JOB enqueued atomically when
-- the reply is classified, then a claim-based drainer sends it (eagerly right
-- after enqueue, and again at the start of cron). A cutoff can no longer lose a
-- notification: the job survives and the next drain sends it.
--
-- One logical delivery per (proposal, channel) for reply kind, so re-enqueue and
-- concurrent drains never double-post. The claim happens BEFORE the external
-- send (a unique audit row alone cannot prevent two workers both POSTing).

alter table public.notification_deliveries
  -- Immutable snapshot of what to send (the ReplyNotification + channel transport),
  -- so a retry never has to refetch Smartlead/thread state or a since-edited channel.
  add column if not exists payload jsonb,
  add column if not exists attempt_count integer not null default 0,
  add column if not exists next_attempt_at timestamptz,
  add column if not exists claimed_at timestamptz,
  add column if not exists claim_token uuid,
  add column if not exists sent_at timestamptz,
  -- Slack message coordinates for later chat.update (Part B); null for email/webhook.
  add column if not exists provider_channel_id text,
  add column if not exists provider_message_ts text;

-- Status vocabulary for new rows: pending | processing | retry | sent | dead.
-- Existing audit rows keep their 'sent'/'failed' values (terminal, ignored by the
-- drainer, which only claims pending/retry).

-- One live delivery per (proposal, channel) for reply notifications. Test rows
-- (proposal_id null) are excluded, so they never collide.
create unique index if not exists notification_delivery_once
  on public.notification_deliveries (proposal_id, channel_id, kind)
  where proposal_id is not null and kind = 'reply';

-- Due-work lookup for the drainer.
create index if not exists notification_deliveries_due_idx
  on public.notification_deliveries (status, next_attempt_at)
  where status in ('pending', 'retry');

-- Claim up to p_limit due delivery jobs: pending, retry whose backoff elapsed, or
-- processing rows abandoned by a dead worker (claimed_at older than p_stale_seconds).
-- Sets them to processing under a fresh claim_token, skipping rows another drain
-- holds. Returns the claimed rows so the caller can send them.
create or replace function public.notification_claim_deliveries(
  p_limit integer,
  p_stale_seconds integer default 120
)
returns table (id uuid, channel_id uuid, proposal_id uuid, kind text, payload jsonb, attempt_count integer, claim_token uuid)
language plpgsql
as $$
declare
  v_token uuid := gen_random_uuid();
begin
  return query
  with due as (
    select d.id
    from public.notification_deliveries d
    where (
        (d.status in ('pending', 'retry') and coalesce(d.next_attempt_at, now()) <= now())
        or (d.status = 'processing' and d.claimed_at < now() - make_interval(secs => p_stale_seconds))
      )
    order by coalesce(d.next_attempt_at, d.created_at)
    for update skip locked
    limit greatest(p_limit, 0)
  )
  update public.notification_deliveries d
  set status = 'processing',
      claim_token = v_token,
      claimed_at = now(),
      attempt_count = d.attempt_count + 1
  from due
  where d.id = due.id
  returning d.id, d.channel_id, d.proposal_id, d.kind, d.payload, d.attempt_count, d.claim_token;
end;
$$;

-- Record a delivery's outcome, but ONLY if the caller still holds the claim (a
-- stale worker whose row was reclaimed cannot clobber a newer attempt). status
-- is 'sent' or 'retry'/'dead'. On retry, next_attempt_at is when to try again.
create or replace function public.notification_complete_delivery(
  p_id uuid,
  p_claim_token uuid,
  p_status text,
  p_error text default null,
  p_next_attempt_at timestamptz default null,
  p_provider_channel_id text default null,
  p_provider_message_ts text default null
)
returns boolean
language plpgsql
as $$
declare
  v_updated integer;
begin
  if p_status not in ('sent', 'retry', 'dead') then
    raise exception 'invalid delivery status %', p_status;
  end if;
  update public.notification_deliveries d
  set status = p_status,
      error = left(p_error, 1000),
      sent_at = case when p_status = 'sent' then now() else d.sent_at end,
      next_attempt_at = case when p_status = 'retry' then p_next_attempt_at else null end,
      claim_token = case when p_status = 'retry' then null else d.claim_token end,
      provider_channel_id = coalesce(p_provider_channel_id, d.provider_channel_id),
      provider_message_ts = coalesce(p_provider_message_ts, d.provider_message_ts)
  where d.id = p_id and d.claim_token = p_claim_token
  returning 1 into v_updated;
  return coalesce(v_updated, 0) = 1;
end;
$$;

revoke execute on function public.notification_claim_deliveries(integer, integer) from public, anon, authenticated;
revoke execute on function public.notification_complete_delivery(uuid, uuid, text, text, timestamptz, text, text) from public, anon, authenticated;
grant execute on function public.notification_claim_deliveries(integer, integer) to service_role;
grant execute on function public.notification_complete_delivery(uuid, uuid, text, text, timestamptz, text, text) to service_role;

notify pgrst, 'reload schema';
