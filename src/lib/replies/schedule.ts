import "server-only";
import { getAdminClient } from "@/lib/supabase/admin";
import { resumeLead } from "@/lib/smartlead";
import { logRun } from "@/lib/replies/log";

// OOO resume timing uses caller-provided settings so this module stays pure.
const SEND_HOUR_UTC = 13; // ~9am ET, inside the sending window
const MAX_REASONABLE_RETURN_DAYS = 60;

function atSendHour(date: Date) {
  const result = new Date(date);
  result.setUTCHours(SEND_HOUR_UTC, 0, 0, 0);
  return result;
}

function isWeekend(date: Date) {
  const day = date.getUTCDay();
  return day === 0 || day === 6;
}

export function addBusinessDays(from: Date, days: number) {
  const result = new Date(from);
  let remaining = days;
  while (remaining > 0) {
    result.setUTCDate(result.getUTCDate() + 1);
    if (!isWeekend(result)) remaining -= 1;
  }
  return result;
}

function nextBusinessDay(date: Date) {
  const result = new Date(date);
  while (isWeekend(result)) {
    result.setUTCDate(result.getUTCDate() + 1);
  }
  return result;
}

/**
 * When to resume a paused OOO lead. Dated OOO -> return + configured business days.
 * Undated (or unparseable/implausible date — far future, or so far in the
 * past it's clearly a bad parse) -> received + configured days, rolled forward off
 * weekends. Never in the past.
 */
export function computeResumeAt(input: {
  returnDate: string | null;
  receivedAt: string;
  businessDaysAfterReturn: number;
  defaultWaitDays: number;
  now?: Date;
}): Date {
  const now = input.now ?? new Date();
  const received = Number.isNaN(new Date(input.receivedAt).getTime()) ? now : new Date(input.receivedAt);

  if (input.returnDate) {
    const returnDate = new Date(`${input.returnDate}T00:00:00.000Z`);
    const daysOut = (returnDate.getTime() - now.getTime()) / 86_400_000;
    // -14: a date a few days past is "they're already back" (processing lag);
    // anything older is a mis-parse and falls through to the undated default.
    if (!Number.isNaN(returnDate.getTime()) && daysOut >= -14 && daysOut <= MAX_REASONABLE_RETURN_DAYS) {
      const due = atSendHour(addBusinessDays(returnDate, input.businessDaysAfterReturn));
      return due > now ? due : atSendHour(nextBusinessDay(new Date(now.getTime() + 86_400_000)));
    }
  }

  const fallback = atSendHour(nextBusinessDay(new Date(received.getTime() + input.defaultWaitDays * 86_400_000)));
  return fallback > now ? fallback : atSendHour(nextBusinessDay(new Date(now.getTime() + 86_400_000)));
}

export async function scheduleResume(input: {
  leadId: string | null;
  replyEventId: string | null;
  proposalId: string;
  campaignId: string;
  smartleadLeadId: string;
  leadEmail: string;
  dueAt: Date;
}) {
  const admin = getAdminClient();

  // Idempotent per lead: an approve retry (or re-approve after a partial
  // failure) replaces any still-pending resume instead of stacking a second.
  await admin
    .from("scheduled_actions")
    .update({ status: "canceled", note: "Replaced by a newer schedule.", executed_at: new Date().toISOString() })
    .ilike("lead_email", input.leadEmail.toLowerCase().replace(/([\\%_*])/g, "\\$1"))
    .eq("status", "scheduled");

  const { error } = await admin.from("scheduled_actions").insert({
    kind: "resume_lead",
    lead_id: input.leadId,
    reply_event_id: input.replyEventId,
    proposal_id: input.proposalId,
    campaign_id: input.campaignId,
    smartlead_lead_id: input.smartleadLeadId,
    lead_email: input.leadEmail.toLowerCase(),
    due_at: input.dueAt.toISOString(),
    status: "scheduled",
  });
  if (error) throw new Error(`Could not schedule the resume: ${error.message}`);
}

/** A newer reply supersedes any pending resume for that address. */
export async function cancelScheduledResumes(leadEmail: string, note: string) {
  await getAdminClient()
    .from("scheduled_actions")
    .update({ status: "canceled", note, executed_at: new Date().toISOString() })
    .eq("lead_email", leadEmail.toLowerCase())
    .eq("status", "scheduled");
}

const STALE_EXECUTION_MINUTES = 15;

/**
 * Run due resumes (called from the cron). Claims move scheduled -> processing
 * and become 'done' only after Smartlead confirms — a crash mid-flight
 * re-queues after STALE_EXECUTION_MINUTES instead of losing the resume.
 * Right before firing, re-checks suppression and newer replies.
 */
export async function executeDueScheduledActions(limit = 10) {
  const admin = getAdminClient();
  const now = new Date();
  const staleCutoff = new Date(now.getTime() - STALE_EXECUTION_MINUTES * 60_000).toISOString();

  const { data: due, error } = await admin
    .from("scheduled_actions")
    .select("id, kind, lead_id, campaign_id, smartlead_lead_id, lead_email, due_at, status, created_at")
    .or(`status.eq.scheduled,and(status.eq.processing,executed_at.lt.${staleCutoff})`)
    .lte("due_at", now.toISOString())
    .order("due_at", { ascending: true })
    .limit(limit);

  if (error) return { executed: 0, canceled: 0, failed: 0, error: error.message };

  let executed = 0;
  let canceled = 0;
  let failed = 0;

  for (const action of due ?? []) {
    // Atomic claim: scheduled (or stale processing) -> processing.
    let claim = admin
      .from("scheduled_actions")
      .update({ status: "processing", executed_at: now.toISOString() })
      .eq("id", action.id)
      .eq("status", action.status);
    if (action.status === "processing") {
      claim = claim.lt("executed_at", staleCutoff);
    }
    const { data: claimed } = await claim.select("id");
    if (!claimed || claimed.length === 0) continue;

    const emailPattern = action.lead_email.replace(/([\\%_*])/g, "\\$1");

    // Re-check just before firing: suppressed, a newer reply arrived, or the
    // lead has an APPROVED positive read (engaged human — never restart the
    // cold sequence on them)? Then the wait no longer applies.
    const [{ data: suppressed }, { data: newerReply }, { data: positive }] = await Promise.all([
      admin.from("suppressions").select("id").eq("kind", "email").ilike("value", emailPattern).limit(1).maybeSingle(),
      admin
        .from("reply_events")
        .select("id")
        .ilike("from_email", emailPattern)
        .gt("created_at", action.created_at)
        .limit(1)
        .maybeSingle(),
      admin
        .from("reply_proposals")
        .select("id")
        .ilike("lead_email", emailPattern)
        .eq("status", "approved")
        .eq("sentiment_type", "positive")
        .limit(1)
        .maybeSingle(),
    ]);

    if (suppressed || newerReply || positive) {
      await admin
        .from("scheduled_actions")
        .update({
          status: "canceled",
          note: suppressed
            ? "Address suppressed before resume."
            : newerReply
              ? "Newer reply arrived before resume."
              : "Lead has an approved positive reply. Not resuming the cold sequence.",
        })
        .eq("id", action.id);
      canceled += 1;
      continue;
    }

    try {
      if (action.kind === "resume_lead" && action.campaign_id && action.smartlead_lead_id) {
        await resumeLead(action.campaign_id, action.smartlead_lead_id);
      }
      await admin
        .from("scheduled_actions")
        .update({ status: "done", executed_at: new Date().toISOString() })
        .eq("id", action.id);
      await logRun({
        leadId: (action.lead_id as string | null) ?? null,
        action: "ooo_resumed",
        ok: true,
        message: `Resumed ${action.lead_email} in campaign ${action.campaign_id} after OOO wait`,
      });
      executed += 1;
    } catch (resumeError) {
      const message = resumeError instanceof Error ? resumeError.message : "resume failed";
      await admin
        .from("scheduled_actions")
        .update({ status: "failed", note: message.slice(0, 300) })
        .eq("id", action.id);
      await logRun({ leadId: (action.lead_id as string | null) ?? null, action: "ooo_resumed", ok: false, message });
      failed += 1;
    }
  }

  return { executed, canceled, failed };
}
