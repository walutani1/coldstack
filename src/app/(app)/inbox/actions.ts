"use server";

import crypto from "node:crypto";
import { revalidatePath } from "next/cache";
import { requireActiveProfile } from "@/lib/auth";
import { getAdminClient } from "@/lib/supabase/admin";
import { fetchReplyCategories, resolveSmartleadCategoryId, updateLeadCategory } from "@/lib/smartlead";
import type { DncReason } from "@/lib/taxonomy";
import { getTaxonomy } from "@/lib/taxonomy-store";
import { getWorkspaceSettings } from "@/lib/settings-store";
import { processPendingReplyEvents, processReplyEvent } from "@/lib/replies/process";
import { getThreadForEvent } from "@/lib/replies/threads";
import { applyProposal } from "@/lib/replies/apply";
import { parseChanges } from "@/lib/replies/changes";
import {
  scheduleReply,
  cancelScheduledReply,
  deliverReplySend,
  resolveScheduledAt,
  getPendingScheduledReply,
  type ScheduleWhen,
  type SchedulePreset,
  type PendingScheduledReply,
} from "@/lib/replies/scheduled-send";
import type { ActionResult, ReplyEventRow, SendContext, ThreadMessage } from "@/lib/types";

type PendingProposal = {
  id: string;
  reply_event_id: string | null;
  lead_id: string | null;
  lead_email: string | null;
  smartlead_lead_id: string | null;
  sentiment: string | null;
  action_suppress: boolean;
  action_dnc: boolean;
  action_value: string | null;
  dnc_reason: DncReason | null;
  proposed_changes: unknown;
};

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function validUuid(value: unknown): string | null {
  return typeof value === "string" && UUID_PATTERN.test(value) ? value : null;
}

function trimmedString(value: unknown, maxLength: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > maxLength) return null;
  return trimmed;
}

async function getPendingProposal(id: string): Promise<PendingProposal | null> {
  const { data } = await getAdminClient()
    .from("reply_proposals")
    .select(
      "id, reply_event_id, lead_id, lead_email, smartlead_lead_id, sentiment, action_suppress, action_dnc, action_value, dnc_reason, proposed_changes",
    )
    .eq("id", id)
    .eq("status", "pending")
    .maybeSingle();
  return (data as PendingProposal | null) ?? null;
}

async function getEvent(eventId: string): Promise<ReplyEventRow | null> {
  const { data } = await getAdminClient()
    .from("reply_events")
    .select(
      "id, smartlead_message_id, smartlead_lead_id, lead_id, campaign_id, campaign_name, from_email, to_email, subject, body, smartlead_category, status, received_at, created_at",
    )
    .eq("id", eventId)
    .maybeSingle();
  return (data as ReplyEventRow | null) ?? null;
}

/** Apply a pending proposal: lead fields, suppression, DNC — then mark approved. */
export async function approveProposalAction(id: string): Promise<ActionResult> {
  const profile = await requireActiveProfile();
  const proposalId = validUuid(id);
  if (!proposalId) {
    return { ok: false, message: "Invalid proposal id." };
  }

  const result = await applyProposal(proposalId, profile.email);
  if (result.ok) {
    revalidatePath("/inbox");
  }
  return result;
}

export async function declineProposalAction(id: string): Promise<ActionResult> {
  const profile = await requireActiveProfile();
  const proposalId = validUuid(id);
  if (!proposalId) {
    return { ok: false, message: "Invalid proposal id." };
  }

  const admin = getAdminClient();
  const { error } = await admin
    .from("reply_proposals")
    .update({ status: "declined", resolved_at: new Date().toISOString(), resolved_by: profile.email })
    .eq("id", proposalId)
    .eq("status", "pending");
  if (error) {
    return { ok: false, message: error.message };
  }
  // A rejected read must not leave a live resume behind (e.g. from a partial
  // approve that was reverted after scheduling).
  await admin
    .from("scheduled_actions")
    .update({ status: "canceled", note: "Proposal declined.", executed_at: new Date().toISOString() })
    .eq("proposal_id", proposalId)
    .eq("status", "scheduled");
  revalidatePath("/inbox");
  return { ok: true, message: "Declined." };
}

/** Decline the current read and regenerate it with the reviewer's context. */
export async function regenerateProposalAction(id: string, userNote: string): Promise<ActionResult> {
  await requireActiveProfile();
  const proposalId = validUuid(id);
  if (!proposalId) {
    return { ok: false, message: "Invalid proposal id." };
  }

  const note = trimmedString(userNote, 2000);
  if (!note) {
    return { ok: false, message: "Add a note describing the correction." };
  }

  const proposal = await getPendingProposal(proposalId);
  if (!proposal?.reply_event_id) {
    return { ok: false, message: "Proposal not found or already resolved." };
  }

  const source = await getAdminClient().from("reply_events").select("source").eq("id", proposal.reply_event_id).maybeSingle();
  if (source.data?.source === "smartlead_untracked_import") {
    return { ok: false, message: "Recovered replies are analyzed by the untracked pipeline and can't be regenerated here." };
  }

  const event = await getEvent(proposal.reply_event_id);
  if (!event) {
    return { ok: false, message: "Original reply not found." };
  }

  const result = await processReplyEvent(event, { userNote: note, replaceProposalId: proposalId });
  revalidatePath("/inbox");
  return result.ok
    ? { ok: true, message: "Re-read with your context." }
    : { ok: false, message: result.error ?? "Could not regenerate." };
}

/** Change the category on a pending proposal; recomputes default actions. */
export async function setProposalCategoryAction(id: string, categoryValue: string): Promise<ActionResult> {
  await requireActiveProfile();
  const taxonomy = await getTaxonomy();
  const proposalId = validUuid(id);
  if (!proposalId) {
    return { ok: false, message: "Invalid proposal id." };
  }
  const def = typeof categoryValue === "string" ? taxonomy.byValue(categoryValue) : null;
  if (!def?.active) {
    return { ok: false, message: "Invalid category." };
  }

  const proposal = await getPendingProposal(proposalId);
  if (!proposal) {
    return { ok: false, message: "Proposal not found or already resolved." };
  }

  const keepDefunct = proposal.dnc_reason === "email_defunct" && proposal.action_dnc;
  const explicitDnc = def.systemRole === "do_not_contact" || def.dnc;
  const actionDnc = explicitDnc || keepDefunct;
  const dncReason: DncReason | null = explicitDnc
    ? "explicit_request"
    : keepDefunct
      ? "email_defunct"
      : null;
  const actionSuppress = def.suppress || actionDnc;

  const changes = parseChanges(proposal.proposed_changes);
  changes.sentiment = def.label;
  if (def.systemRole !== "out_of_office" && def.systemRole !== "fallback") {
    changes.replied = true;
    changes.positive_lead = def.sentimentType === "positive";
  } else {
    // Switching TO an automated/unknown read: drop human-reply claims the
    // previous categorization may have staged.
    delete changes.replied;
    delete changes.positive_lead;
  }

  const { error } = await getAdminClient()
    .from("reply_proposals")
    .update({
      sentiment: def.label,
      sentiment_type: def.sentimentType,
      positive_lead: def.sentimentType === "positive",
      action_suppress: actionSuppress && Boolean(proposal.action_value),
      action_dnc: actionDnc && Boolean(proposal.action_value),
      dnc_reason: actionDnc ? dncReason : null,
      proposed_changes: changes,
    })
    .eq("id", proposalId)
    .eq("status", "pending");

  if (error) {
    return { ok: false, message: error.message };
  }

  // Keep Smartlead's tag in step with the override (tag only — actions still
  // fire on approve). Best-effort.
  if (proposal.smartlead_lead_id && proposal.reply_event_id) {
    try {
      const { data: eventRow } = await getAdminClient()
        .from("reply_events")
        .select("campaign_id")
        .eq("id", proposal.reply_event_id)
        .maybeSingle();
      const campaignId = (eventRow?.campaign_id as string | null) ?? null;
      const categoryId = campaignId ? resolveSmartleadCategoryId(await fetchReplyCategories(), def.label) : null;
      if (campaignId && categoryId) {
        await updateLeadCategory({
          campaignId,
          smartleadLeadId: proposal.smartlead_lead_id,
          categoryId,
          pauseLead: false,
        });
      }
    } catch {
      // approve re-syncs
    }
  }

  revalidatePath("/inbox");
  return { ok: true, message: `Category set to ${def.label}.` };
}

/** Drain any reply events the webhook didn't finish processing. */
export async function drainRepliesAction(): Promise<ActionResult & { processed: number }> {
  await requireActiveProfile();
  try {
    // Small batch — research + drafting make events slow; the 300s cron is
    // the bulk path. This keeps the action inside its 60s window.
    const result = await processPendingReplyEvents(5);
    revalidatePath("/inbox");
    return {
      ok: true,
      processed: result.processed,
      message:
        result.total === 0
          ? "No new replies waiting."
          : `Processed ${result.processed} repl${result.processed === 1 ? "y" : "ies"}${result.failed ? `, ${result.failed} failed` : ""}.`,
    };
  } catch (error) {
    return { ok: false, processed: 0, message: error instanceof Error ? error.message : "Could not check replies." };
  }
}

/** Full thread + reply-send context for one conversation (fetched on select). */
export async function loadThreadAction(
  eventId: string,
): Promise<{
  ok: boolean;
  messages: ThreadMessage[];
  sendContext: SendContext;
  scheduledReply: PendingScheduledReply | null;
  message?: string;
}> {
  await requireActiveProfile();
  const validEventId = validUuid(eventId);
  if (!validEventId) {
    return { ok: false, messages: [], sendContext: null, scheduledReply: null, message: "Invalid reply id." };
  }

  const event = await getEvent(validEventId);
  if (!event) {
    return { ok: false, messages: [], sendContext: null, scheduledReply: null, message: "Reply not found." };
  }
  const [thread, scheduledReply] = await Promise.all([
    getThreadForEvent(event),
    getPendingScheduledReply(validEventId),
  ]);
  return { ok: true, ...thread, scheduledReply };
}

/** Send a reply into the Smartlead thread (idempotent by key). */
export async function sendReplyAction(input: {
  eventId: string;
  body: string;
  idempotencyKey: string;
}): Promise<ActionResult> {
  const profile = await requireActiveProfile();
  const validEventId = validUuid(input?.eventId);
  if (!validEventId) {
    return { ok: false, message: "Invalid reply id." };
  }

  const body = typeof input?.body === "string" ? input.body.trim() : "";
  if (!body) {
    return { ok: false, message: "Write a reply first." };
  }
  if (body.length > 8000) {
    return { ok: false, message: "Reply is too long." };
  }
  const idempotencyKey = trimmedString(input?.idempotencyKey, 128);
  if (!idempotencyKey || idempotencyKey.length < 8) {
    return { ok: false, message: "Missing send token. Refresh and try again." };
  }

  const event = await getEvent(validEventId);
  if (!event || !event.from_email) {
    return { ok: false, message: "Original reply not found." };
  }

  const { sendContext } = await getThreadForEvent(event);
  if (!sendContext) {
    return { ok: false, message: "This thread is not linked to Smartlead yet, so it can't be replied to from here." };
  }

  const admin = getAdminClient();

  // Self-heal: a crashed send can leave a permanent 'sending' row, which
  // would block re-sending this text forever via the unique index.
  const staleSending = new Date(Date.now() - 10 * 60_000).toISOString();
  await admin
    .from("reply_sends")
    .update({ status: "failed", error: "Timed out in 'sending'. Treated as failed.", completed_at: new Date().toISOString() })
    .eq("reply_event_id", event.id)
    .eq("status", "sending")
    .lt("created_at", staleSending);

  // Duplicate window: same text to the same thread within 10 minutes is a
  // double-send regardless of idempotency key (covers rapid double-invokes
  // that raced past the client-side key).
  const windowStart = new Date(Date.now() - 10 * 60_000).toISOString();
  const { data: duplicate } = await admin
    .from("reply_sends")
    .select("id, status")
    .eq("reply_event_id", event.id)
    .eq("body", body)
    .in("status", ["sending", "sent"])
    .gte("created_at", windowStart)
    .limit(1)
    .maybeSingle();
  if (duplicate) {
    return { ok: false, message: duplicate.status === "sent" ? "This reply was already sent." : "This reply is already being sent." };
  }

  // body_hash backs a partial unique index on (reply_event_id, body_hash)
  // where status in ('sending','sent') — the ATOMIC double-send guard. The
  // 10-minute window check above just provides a friendlier message.
  const { data: attempt, error: attemptError } = await admin
    .from("reply_sends")
    .insert({
      reply_event_id: event.id,
      lead_id: event.lead_id,
      campaign_id: event.campaign_id,
      smartlead_lead_id: event.smartlead_lead_id,
      to_email: event.from_email,
      body,
      body_hash: crypto.createHash("md5").update(body).digest("hex"),
      sent_by: profile.email,
      idempotency_key: idempotencyKey,
      status: "sending",
    })
    .select("id")
    .single();

  if (attemptError) {
    if (attemptError.code === "23505") {
      return { ok: false, message: "This exact reply was already sent (or is sending) on this thread." };
    }
    return { ok: false, message: attemptError.message };
  }

  const delivered = await deliverReplySend(admin, { rowId: attempt.id, body, event, sendContext });
  if (delivered.ok) revalidatePath("/inbox");
  return delivered;
}

/** Schedule a reply to send later (delivered by the cron at the chosen time). */
export async function scheduleReplyAction(input: {
  eventId: string;
  body: string;
  when: ScheduleWhen;
  idempotencyKey: string;
}): Promise<ActionResult & { scheduledAt?: string; id?: string }> {
  const profile = await requireActiveProfile();
  const validEventId = validUuid(input?.eventId);
  if (!validEventId) return { ok: false, message: "Invalid reply id." };

  const body = typeof input?.body === "string" ? input.body.trim() : "";
  if (!body) return { ok: false, message: "Write a reply first." };
  if (body.length > 8000) return { ok: false, message: "Reply is too long." };

  const idempotencyKey = trimmedString(input?.idempotencyKey, 128);
  if (!idempotencyKey || idempotencyKey.length < 8) {
    return { ok: false, message: "Missing send token. Refresh and try again." };
  }

  const when = input?.when;
  const PRESETS: SchedulePreset[] = ["in_3_hours", "tomorrow_morning", "tomorrow_afternoon", "monday_morning"];
  const validWhen =
    !!when &&
    (("preset" in when && PRESETS.includes(when.preset)) ||
      ("customLocal" in when && typeof when.customLocal === "string"));
  if (!validWhen) return { ok: false, message: "Pick when to send." };

  const event = await getEvent(validEventId);
  if (!event || !event.from_email) return { ok: false, message: "Original reply not found." };

  const { sendContext } = await getThreadForEvent(event);
  if (!sendContext) {
    return { ok: false, message: "This thread is not linked to Smartlead yet, so it can't be replied to from here." };
  }

  const workspace = await getWorkspaceSettings();
  const resolved = resolveScheduledAt(when, workspace.timeZone);
  if (!resolved.ok) return { ok: false, message: resolved.message };

  const result = await scheduleReply({ event, body, scheduledAt: resolved.at, sentBy: profile.email, idempotencyKey });
  if (result.ok) revalidatePath("/inbox");
  return result;
}

/** Cancel a still-pending scheduled reply. */
export async function cancelScheduledReplyAction(id: string): Promise<ActionResult> {
  await requireActiveProfile();
  const validId = validUuid(id);
  if (!validId) return { ok: false, message: "Invalid scheduled reply id." };
  const result = await cancelScheduledReply(validId);
  if (result.ok) revalidatePath("/inbox");
  return result;
}
