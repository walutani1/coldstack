import "server-only";

import { getAdminClient } from "@/lib/supabase/admin";
import { listInboxAccounts } from "@/lib/smartlead";
import { buildCandidates } from "@/lib/untracked/candidates";
import { classifyUntrackedReply } from "@/lib/untracked/classify";
import { processImportedReplyEvent } from "@/lib/untracked/import";
import { runDeterministicPrefilter } from "@/lib/untracked/prefilter";

export type UntrackedRow = {
  id: string; provider_message_id: string | null; from_email: string | null; from_name: string | null;
  to_email: string | null; subject: string | null; body_text: string | null; provider_received_at: string | null;
  attempt_count: number; status: string;
};

export type SenderContext = { aliases: Set<string>; warmupTags: Set<string> };

export async function loadSenderContext(): Promise<SenderContext> {
  const accounts = await listInboxAccounts();
  return {
    aliases: new Set(accounts.map((account) => account.fromEmail.trim().toLowerCase()).filter(Boolean)),
    warmupTags: new Set(accounts.map((account) => account.warmup?.warmupKey?.trim().toLowerCase() ?? "").filter(Boolean)),
  };
}

export async function processOneUntrackedReply(row: UntrackedRow, context: SenderContext): Promise<{ usedLlm: boolean; status: string; permanent?: boolean; lostClaim?: boolean }> {
  const admin = getAdminClient();
  const decision = await runDeterministicPrefilter(row, context.aliases, context.warmupTags);
  if (decision) {
    const { data, error } = await admin.from("untracked_replies").update({
      status: decision.status, automation_kind: decision.automationKind ?? null,
      classification_rule: decision.classificationRule, classification: { rule: decision.classificationRule },
      last_error: decision.lastError ?? null, process_started_at: null, next_attempt_at: null,
    }).eq("id", row.id).eq("status", "processing").select("id");
    if (error) throw new Error(`Untracked prefilter update: ${error.message}`);
    if (!data?.length) return { usedLlm: false, status: "lost_claim", lostClaim: true };
    return { usedLlm: false, status: decision.status, permanent: decision.status === "error" };
  }
  const candidates = await buildCandidates(row);
  const transition = await classifyUntrackedReply(row, candidates);
  const { data, error } = await admin.from("untracked_replies").update({
    status: transition.status, automation_kind: transition.automationKind,
    classification: transition.classification, classification_rule: "anthropic_structured_classifier",
    classifier_model: transition.classifierModel, candidate_snapshot: candidates,
    suggested_lead_id: transition.suggestedLeadId, suggested_campaign_id: transition.suggestedCampaignId,
    match_confidence: transition.matchConfidence, match_rationale: transition.matchRationale,
    proposed_contact: transition.proposedContact, last_error: null, process_started_at: null, next_attempt_at: null,
  }).eq("id", row.id).eq("status", "processing").select("id");
  if (error) throw new Error(`Untracked classification update: ${error.message}`);
  if (!data?.length) return { usedLlm: true, status: "lost_claim", lostClaim: true };
  return { usedLlm: true, status: transition.status, permanent: transition.permanentFailure };
}

async function recordFailure(row: UntrackedRow, error: unknown): Promise<boolean> {
  const attempt = row.attempt_count + 1;
  const delays = [10, 30, 120];
  const terminal = attempt > delays.length;
  const next = terminal ? null : new Date(Date.now() + delays[attempt - 1] * 60_000).toISOString();
  const result = await getAdminClient().from("untracked_replies").update({
    status: terminal ? "error" : "new", attempt_count: attempt, next_attempt_at: next,
    process_started_at: null, last_error: (error instanceof Error ? error.message : String(error)).slice(0, 2000),
  }).eq("id", row.id).eq("status", "processing").select("id");
  return !result.error && Boolean(result.data?.length);
}

export async function processPendingUntrackedReplies(options: {
  maxLlmCalls?: number; maxPrefilters?: number; softTimeMs?: number;
} = {}) {
  const maxLlmCalls = Math.max(0, Math.min(options.maxLlmCalls ?? 5, 20));
  const maxPrefilters = Math.max(1, Math.min(options.maxPrefilters ?? 25, 100));
  const softTimeMs = Math.max(1_000, options.softTimeMs ?? 60_000);
  const started = Date.now();
  const admin = getAdminClient();
  let context: SenderContext;
  try {
    context = await loadSenderContext();
  } catch (error) {
    return { total: 0, prefiltered: 0, llmCalls: 0, processed: 0, failed: 0, released: 0,
      error: error instanceof Error ? error.message : String(error) };
  }
  const claim = await admin.rpc("claim_untracked_replies", { p_limit: maxPrefilters });
  if (claim.error) return { total: 0, prefiltered: 0, llmCalls: 0, processed: 0, failed: 0, released: 0, error: claim.error.message };
  const rows = (claim.data ?? []) as UntrackedRow[];
  let prefiltered = 0, llmCalls = 0, processed = 0, failed = 0;
  let cursor = 0;
  for (; cursor < rows.length; cursor += 1) {
    if (Date.now() - started >= softTimeMs) break;
    const row = rows[cursor];
    if (llmCalls >= maxLlmCalls) {
      try {
        const decision = await runDeterministicPrefilter(row, context.aliases, context.warmupTags);
        if (!decision) break;
      } catch {
        break;
      }
    }
    try {
      const result = await processOneUntrackedReply(row, context);
      if (result.lostClaim) continue;
      if (result.usedLlm) llmCalls += 1; else prefiltered += 1;
      processed += 1;
    } catch (error) {
      if (await recordFailure(row, error)) failed += 1;
    }
  }
  const remaining = rows.slice(cursor).map((row) => row.id);
  if (remaining.length) await admin.from("untracked_replies").update({ status: "new", process_started_at: null }).in("id", remaining).eq("status", "processing");

  let importedProcessed = 0, importedFailed = 0;
  const importedBudget = Math.min(5, Math.max(0, maxLlmCalls - llmCalls));
  if (importedBudget > 0 && Date.now() - started < softTimeMs) {
    try {
      const stuck = await admin.from("reply_events").select("id")
        .eq("source", "smartlead_untracked_import").in("status", ["received", "error"])
        .order("created_at", { ascending: true }).limit(100);
      if (!stuck.error && stuck.data?.length) {
        const ids = stuck.data.map((event) => String(event.id));
        const active = await admin.from("reply_proposals").select("reply_event_id")
          .in("reply_event_id", ids).in("status", ["pending", "approved"]);
        if (!active.error) {
          const activeIds = new Set((active.data ?? []).map((proposal) => String(proposal.reply_event_id)));
          for (const eventId of ids.filter((id) => !activeIds.has(id)).slice(0, importedBudget)) {
            if (Date.now() - started >= softTimeMs) break;
            try {
              const result = await processImportedReplyEvent(eventId);
              if (result.ok) importedProcessed += 1; else importedFailed += 1;
              llmCalls += 1;
            } catch {
              importedFailed += 1;
              llmCalls += 1;
            }
          }
        }
      }
    } catch {
      // Recovery is best-effort and must never orphan or fail the claimed batch.
    }
  }
  return { total: rows.length, prefiltered, llmCalls, processed, failed, released: remaining.length, importedProcessed, importedFailed };
}
