import "server-only";
import crypto from "node:crypto";
import { getAdminClient } from "@/lib/supabase/admin";
import { sendReply } from "@/lib/smartlead";
import { textToHtml } from "@/lib/html";
import { getThreadForEvent } from "@/lib/replies/threads";
import { logRun } from "@/lib/replies/apply";
import { markCampaignBriefDirty } from "@/lib/campaign-insights";
import type { ReplyEventRow, SendContext } from "@/lib/types";

type Admin = ReturnType<typeof getAdminClient>;

export const EVENT_COLUMNS =
  "id, smartlead_message_id, smartlead_lead_id, lead_id, campaign_id, campaign_name, from_email, to_email, subject, body, smartlead_category, status, received_at, created_at";

/** How far out a reply may be scheduled. */
const MAX_SCHEDULE_DAYS = 60;
/** A send stuck in 'sending' past this is re-queued by the cron. */
const STALE_SENDING_MINUTES = 15;

export type SchedulePreset = "in_3_hours" | "tomorrow_morning" | "tomorrow_afternoon" | "monday_morning";
export type ScheduleWhen = { preset: SchedulePreset } | { customLocal: string };

/* ── Timezone helpers ──────────────────────────────────────────────────────
   Presets and the custom picker are interpreted in the WORKSPACE timezone (the
   operator's business clock) so "tomorrow morning" means their morning. */

/** The UTC instant for a wall-clock time (y, month 1-12, d, hh, mm) in a zone. */
function zonedWallClockToUtc(y: number, mo: number, d: number, hh: number, mm: number, timeZone: string): Date {
  const asUtc = Date.UTC(y, mo - 1, d, hh, mm, 0);
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone, hourCycle: "h23",
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
  const p = Object.fromEntries(fmt.formatToParts(new Date(asUtc)).map((x) => [x.type, x.value]));
  const seen = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return new Date(asUtc - (seen - asUtc)); // undo the zone offset
}

/** Today's wall-clock Y/M/D in the given zone, as a UTC-midnight anchor Date. */
function zonedTodayAnchor(now: Date, timeZone: string): Date {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" })
      .formatToParts(now).map((x) => [x.type, x.value]),
  );
  return new Date(Date.UTC(+p.year, +p.month - 1, +p.day));
}

/**
 * Resolve a preset or custom local datetime into a UTC instant. Returns an error
 * message when the result is in the past or beyond the max horizon.
 */
export function resolveScheduledAt(
  when: ScheduleWhen,
  timeZone: string,
  now: Date = new Date(),
): { ok: true; at: Date } | { ok: false; message: string } {
  let at: Date;

  if ("customLocal" in when) {
    const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(when.customLocal.trim());
    if (!m) return { ok: false, message: "Pick a valid date and time." };
    at = zonedWallClockToUtc(+m[1], +m[2], +m[3], +m[4], +m[5], timeZone);
  } else if (when.preset === "in_3_hours") {
    at = new Date(now.getTime() + 3 * 60 * 60_000);
  } else {
    const anchor = zonedTodayAnchor(now, timeZone);
    const target = new Date(anchor);
    if (when.preset === "monday_morning") {
      const dow = anchor.getUTCDay(); // 0 Sun .. 6 Sat, for the workspace-local date
      const add = ((1 - dow + 7) % 7) || 7; // strictly-future Monday
      target.setUTCDate(target.getUTCDate() + add);
    } else {
      target.setUTCDate(target.getUTCDate() + 1); // tomorrow
    }
    const hour = when.preset === "tomorrow_afternoon" ? 13 : 8;
    at = zonedWallClockToUtc(
      target.getUTCFullYear(), target.getUTCMonth() + 1, target.getUTCDate(), hour, 0, timeZone,
    );
  }

  if (Number.isNaN(at.getTime())) return { ok: false, message: "Pick a valid date and time." };
  if (at.getTime() <= now.getTime() + 60_000) return { ok: false, message: "Pick a time at least a minute from now." };
  if (at.getTime() > now.getTime() + MAX_SCHEDULE_DAYS * 86_400_000) {
    return { ok: false, message: `Replies can be scheduled up to ${MAX_SCHEDULE_DAYS} days out.` };
  }
  return { ok: true, at };
}

/* ── Delivery (shared by immediate send + the scheduled cron) ──────────────── */

/**
 * Deliver one reply_sends row into its Smartlead thread and mark it sent/failed.
 * The single source of truth for the Smartlead send, reused by the interactive
 * sendReplyAction and the scheduled-reply cron. The caller owns the pre-insert.
 */
export async function deliverReplySend(
  admin: Admin,
  params: { rowId: string; body: string; event: ReplyEventRow; sendContext?: SendContext },
): Promise<{ ok: boolean; message: string }> {
  const sendContext = params.sendContext ?? (await getThreadForEvent(params.event)).sendContext;
  const stamp = () => new Date().toISOString();

  if (!sendContext) {
    await admin.from("reply_sends").update({
      status: "failed", error: "Thread is no longer linked to a Smartlead inbox.", completed_at: stamp(),
    }).eq("id", params.rowId);
    return { ok: false, message: "This thread is not linked to Smartlead, so it can't be replied to." };
  }

  try {
    const response = await sendReply({
      campaignId: sendContext.campaignId,
      emailStatsId: sendContext.emailStatsId,
      bodyHtml: textToHtml(params.body),
      replyMessageId: sendContext.replyMessageId,
      replyEmailTime: sendContext.replyEmailTime,
    });
    await admin.from("reply_sends").update({
      status: "sent", smartlead_response: response ?? null, completed_at: stamp(),
    }).eq("id", params.rowId);
    void markCampaignBriefDirty(params.event.campaign_id).catch(() => undefined);
    await logRun({ leadId: params.event.lead_id, action: "reply_sent", ok: true, message: `Replied to ${params.event.from_email}` });
    return { ok: true, message: "Reply sent." };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Send failed.";
    await admin.from("reply_sends").update({
      status: "failed", error: message.slice(0, 500), completed_at: stamp(),
    }).eq("id", params.rowId);
    return { ok: false, message: `Smartlead rejected the send: ${message}` };
  }
}

/* ── Schedule / cancel / read ──────────────────────────────────────────────── */

/**
 * Schedule a reply for later. One scheduled reply per thread at a time — a new
 * schedule replaces any still-pending one for the same event.
 */
export async function scheduleReply(params: {
  event: ReplyEventRow;
  body: string;
  scheduledAt: Date;
  sentBy: string;
  idempotencyKey: string;
}): Promise<{ ok: boolean; message: string; id?: string; scheduledAt?: string }> {
  const admin = getAdminClient();

  await admin
    .from("reply_sends")
    .update({ status: "canceled", error: "Replaced by a newer schedule.", completed_at: new Date().toISOString() })
    .eq("reply_event_id", params.event.id)
    .eq("status", "scheduled");

  const { data, error } = await admin
    .from("reply_sends")
    .insert({
      reply_event_id: params.event.id,
      lead_id: params.event.lead_id,
      campaign_id: params.event.campaign_id,
      smartlead_lead_id: params.event.smartlead_lead_id,
      to_email: params.event.from_email,
      body: params.body,
      body_hash: crypto.createHash("md5").update(params.body).digest("hex"),
      sent_by: params.sentBy,
      idempotency_key: params.idempotencyKey,
      status: "scheduled",
      scheduled_at: params.scheduledAt.toISOString(),
    })
    .select("id")
    .single();

  if (error) return { ok: false, message: error.message };
  return { ok: true, message: "Reply scheduled.", id: data.id as string, scheduledAt: params.scheduledAt.toISOString() };
}

export async function cancelScheduledReply(id: string): Promise<{ ok: boolean; message: string }> {
  const { data, error } = await getAdminClient()
    .from("reply_sends")
    .update({ status: "canceled", completed_at: new Date().toISOString() })
    .eq("id", id)
    .eq("status", "scheduled")
    .select("id");
  if (error) return { ok: false, message: error.message };
  if (!data || data.length === 0) return { ok: false, message: "That scheduled reply was already sent or canceled." };
  return { ok: true, message: "Scheduled reply canceled." };
}

export type PendingScheduledReply = { id: string; body: string; scheduledAt: string };

/** The still-pending scheduled reply for a thread's latest event, if any. */
export async function getPendingScheduledReply(eventId: string): Promise<PendingScheduledReply | null> {
  const { data } = await getAdminClient()
    .from("reply_sends")
    .select("id, body, scheduled_at")
    .eq("reply_event_id", eventId)
    .eq("status", "scheduled")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  return data ? { id: data.id as string, body: data.body as string, scheduledAt: data.scheduled_at as string } : null;
}

/* ── Cron: deliver due scheduled replies ───────────────────────────────────── */

export async function sendDueScheduledReplies(limit = 10): Promise<{ sent: number; failed: number; skipped: number }> {
  const admin = getAdminClient();
  const now = new Date();
  const staleCutoff = new Date(now.getTime() - STALE_SENDING_MINUTES * 60_000).toISOString();

  const [dueRes, staleRes] = await Promise.all([
    admin.from("reply_sends").select("id, reply_event_id, body, status")
      .eq("status", "scheduled").lte("scheduled_at", now.toISOString())
      .order("scheduled_at", { ascending: true }).limit(limit),
    // Recover a scheduled send that started but crashed mid-flight.
    admin.from("reply_sends").select("id, reply_event_id, body, status")
      .eq("status", "sending").not("scheduled_at", "is", null).lt("send_started_at", staleCutoff)
      .order("scheduled_at", { ascending: true }).limit(limit),
  ]);

  const rows = [...(dueRes.data ?? []), ...(staleRes.data ?? [])];
  let sent = 0, failed = 0, skipped = 0;

  for (const row of rows) {
    // Atomic claim -> 'sending'. A concurrent cancel or an identical already-sent
    // reply (partial unique index) loses the claim; treat both as skip.
    let claim = admin.from("reply_sends")
      .update({ status: "sending", send_started_at: new Date().toISOString() })
      .eq("id", row.id).eq("status", row.status);
    if (row.status === "sending") claim = claim.lt("send_started_at", staleCutoff);
    const { data: claimed, error: claimError } = await claim.select("id");
    if (claimError) {
      if (claimError.code === "23505") {
        await admin.from("reply_sends").update({ status: "canceled", error: "An identical reply was already sent on this thread.", completed_at: new Date().toISOString() }).eq("id", row.id).eq("status", "scheduled");
      }
      skipped += 1;
      continue;
    }
    if (!claimed || claimed.length === 0) { skipped += 1; continue; }

    if (!row.reply_event_id) {
      await admin.from("reply_sends").update({ status: "failed", error: "Missing reply event.", completed_at: new Date().toISOString() }).eq("id", row.id);
      failed += 1;
      continue;
    }
    const { data: event } = await admin.from("reply_events").select(EVENT_COLUMNS).eq("id", row.reply_event_id).maybeSingle();
    if (!event) {
      await admin.from("reply_sends").update({ status: "failed", error: "Original reply not found.", completed_at: new Date().toISOString() }).eq("id", row.id);
      failed += 1;
      continue;
    }

    const result = await deliverReplySend(admin, { rowId: row.id as string, body: row.body as string, event: event as ReplyEventRow });
    if (result.ok) sent += 1; else failed += 1;
  }

  return { sent, failed, skipped };
}
