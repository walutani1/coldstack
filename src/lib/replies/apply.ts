import "server-only";
import { getAdminClient } from "@/lib/supabase/admin";
import {
  addToGlobalBlockList,
  fetchReplyCategories,
  resolveSmartleadCategoryId,
  updateLeadCategory,
} from "@/lib/smartlead";
import { parseChanges } from "@/lib/replies/changes";
import { computeResumeAt, scheduleResume } from "@/lib/replies/schedule";
import { logRun } from "@/lib/replies/log";
import type { DncReason } from "@/lib/taxonomy";
import type { AiSettings } from "@/lib/settings-store";
import { getEffectiveAiSettings } from "@/lib/campaign-settings";

export { logRun } from "@/lib/replies/log";

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
  ooo_return_date: string | null;
  proposed_changes: unknown;
};

/**
 * Apply a pending proposal: lead field updates, local suppression, Smartlead
 * block list (email only) — then mark it approved. Called from the approve
 * server action (auth enforced there) and from the verification harness.
 *
 * Concurrency: the proposal is CLAIMED (pending -> approved) atomically
 * before any side effect runs, so a supersede-by-newer-reply or a second
 * approver can never interleave with a half-applied proposal. If a side
 * effect then fails, the claim is reverted to pending for a clean retry.
 */
export async function applyProposal(
  id: string,
  approverEmail: string,
  aiSettings?: AiSettings,
): Promise<{ ok: boolean; message: string }> {
  const admin = getAdminClient();

  const { data } = await admin
    .from("reply_proposals")
    .select(
      "id, reply_event_id, lead_id, lead_email, smartlead_lead_id, sentiment, action_suppress, action_dnc, action_value, dnc_reason, ooo_return_date, proposed_changes",
    )
    .eq("id", id)
    .eq("status", "pending")
    .maybeSingle();
  const proposal = data as PendingProposal | null;

  if (!proposal) {
    return { ok: false, message: "Proposal not found or already resolved." };
  }

  // Atomic claim — exactly one winner between approvers and supersedes.
  const { data: claimedRows, error: claimError } = await admin
    .from("reply_proposals")
    .update({ status: "approved", resolved_at: new Date().toISOString(), resolved_by: approverEmail })
    .eq("id", id)
    .eq("status", "pending")
    .select("id");
  if (claimError || !claimedRows || claimedRows.length === 0) {
    return { ok: false, message: "Proposal was resolved by something else just now. Refresh to see its state." };
  }

  const changes = parseChanges(proposal.proposed_changes);
  const applied: string[] = [];

  const sourceLookup = proposal.reply_event_id
    ? await admin.from("reply_events").select("source").eq("id", proposal.reply_event_id).maybeSingle()
    : { data: null, error: null };
  const recoveredImport = sourceLookup.data?.source === "smartlead_untracked_import";

  try {
    if (sourceLookup.error) throw new Error(`Reply source lookup failed: ${sourceLookup.error.message}`);
    // 1) Write field updates to the lead row.
    if (proposal.lead_id && Object.keys(changes).length > 0) {
      const { error } = await admin.from("leads").update(changes).eq("id", proposal.lead_id);
      if (error) throw new Error(`Lead update failed: ${error.message}`);
      applied.push(`Updated ${Object.keys(changes).length} lead field${Object.keys(changes).length === 1 ? "" : "s"}`);
    }

    // 2) Local suppression (soft: won't re-export from the Clay app).
    if (proposal.action_suppress && proposal.action_value) {
      const { error } = await admin.from("suppressions").insert({
        kind: "email",
        value: proposal.action_value.toLowerCase(),
        reason: `Reply: ${proposal.sentiment ?? "negative"}${proposal.dnc_reason === "email_defunct" ? " (email no longer in use)" : ""}`,
      });
      // 23505 = already suppressed; that's fine.
      if (error && error.code !== "23505") throw new Error(`Suppression failed: ${error.message}`);
      applied.push("Added to suppression list");
    }

    // 3) Smartlead global block list (account-wide hard block, this email only).
    if (!recoveredImport && proposal.action_dnc && proposal.action_value) {
      await addToGlobalBlockList([proposal.action_value]);
      applied.push(
        proposal.dnc_reason === "email_defunct"
          ? "Blocked dead address in Smartlead (email only)"
          : "Added to Smartlead DNC block list",
      );
    }

    // 4) Mirror the confirmed category onto the lead in Smartlead, so their
    // inbox and ours always show the same tag. Every category pauses the
    // lead's sequence — including Out Of Office, which instead gets a
    // scheduled resume using the configured dated/undated wait policy.
    if (!recoveredImport && proposal.smartlead_lead_id && proposal.sentiment) {
      const { data: eventRow } = proposal.reply_event_id
        ? await admin
            .from("reply_events")
            .select("campaign_id, received_at, created_at")
            .eq("id", proposal.reply_event_id)
            .maybeSingle()
        : { data: null };
      const campaignId = (eventRow?.campaign_id as string | null) ?? null;
      if (campaignId) {
        const categoryId = resolveSmartleadCategoryId(await fetchReplyCategories(), proposal.sentiment);
        if (categoryId) {
          await updateLeadCategory({
            campaignId,
            smartleadLeadId: proposal.smartlead_lead_id,
            categoryId,
            pauseLead: true,
          });
          applied.push(`Tagged "${proposal.sentiment}" in Smartlead`);
        }

        if (proposal.sentiment === "Out Of Office" && !proposal.action_dnc) {
          const receivedAt =
            (eventRow?.received_at as string | null) ??
            (eventRow?.created_at as string | null) ??
            new Date().toISOString();
          const settings = aiSettings ?? (await getEffectiveAiSettings(campaignId));
          const dueAt = computeResumeAt({
            returnDate: proposal.ooo_return_date,
            receivedAt,
            businessDaysAfterReturn: settings.resumeBusinessDaysAfterReturn,
            defaultWaitDays: settings.resumeDefaultWaitDays,
          });
          await scheduleResume({
            leadId: proposal.lead_id,
            replyEventId: proposal.reply_event_id,
            proposalId: proposal.id,
            campaignId,
            smartleadLeadId: proposal.smartlead_lead_id,
            leadEmail: proposal.lead_email ?? proposal.action_value ?? "",
            dueAt,
          });
          const dueLabel = dueAt.toLocaleDateString("en-US", {
            weekday: "short",
            month: "short",
            day: "numeric",
            timeZone: "UTC",
          });
          await admin
            .from("reply_proposals")
            .update({ next_step: `Sequence auto-resumes ${dueLabel} (paused while out of office).` })
            .eq("id", proposal.id);
          applied.push(`Sequence resumes ${dueLabel}`);
        }
      }
    }

    await logRun({
      leadId: proposal.lead_id,
      action: "reply_approved",
      ok: true,
      message: applied.join("; ") || "Approved",
    });

    return { ok: true, message: applied.join(" · ") || "Approved." };
  } catch (error) {
    // Revert the claim so the human can retry (each side effect is
    // idempotent: lead update, suppression 23505-tolerant, block list,
    // tag, and scheduleResume cancels-then-inserts).
    const { error: revertError } = await admin
      .from("reply_proposals")
      .update({ status: "pending", resolved_at: null, resolved_by: null })
      .eq("id", id)
      .eq("status", "approved")
      .eq("resolved_by", approverEmail);
    if (revertError) {
      await logRun({
        leadId: proposal.lead_id,
        action: "reply_approved",
        ok: false,
        message: `Partial apply, revert failed: ${revertError.message}`,
      });
    }
    return { ok: false, message: error instanceof Error ? error.message : "Could not apply proposal." };
  }
}
