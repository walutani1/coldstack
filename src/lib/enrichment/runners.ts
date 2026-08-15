// Auth-less cores for the built-in run actions (find/validate/linkedin/
// personalization/export). Both the interactive Server Actions (which add auth
// + zod validation) and the durable run-job worker (which runs under the cron
// context, with no user session) call these, so the execution logic lives in
// exactly one place. Custom/title/QA cores already live in custom-columns.ts /
// email-qa.ts; this file completes the set for the built-ins.

import {
  commitWriteback, getCoworker, getLeadById,
} from "@/lib/enrichment/queries";
import type { WritebackOutcome } from "@/lib/enrichment/types";
import { LeadMagicClient } from "@/lib/enrichment/leadmagic";
import { ApifyClient } from "@/lib/enrichment/apify";
import { generatePersonalizationValue, type PersonalizationColumn } from "@/lib/enrichment/personalization";
import { mapZeroBounceToEmailStatus, ZeroBounceClient } from "@/lib/enrichment/zerobounce";
import {
  getCustomExportVariables, getEmailQaDetails, getTableColumns, TITLE_FIT_KEY,
} from "@/lib/enrichment/custom-columns";
import { getEffectiveCampaignForTable, getTableById } from "@/lib/enrichment/workspace";
import { getSecret } from "@/lib/secrets";
import { addCampaignLeads } from "@/lib/smartlead";
import { getAdminClient } from "@/lib/supabase/admin";

export type RunOutcome = WritebackOutcome | "failed" | "skipped";
export type RunnerResult = {
  ok: boolean;
  message: string;
  outcome?: RunOutcome;
  value?: string | null;
  kind?: string;
  provider?: string;
  retryAfterMs?: number;
  fallback?: boolean;
  result?: unknown;
};

function msg(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}

export async function runFindEmailCore(leadId: string, runId: string): Promise<RunnerResult> {
  try {
    const lead = await getLeadById(leadId);
    if (!lead) return { ok: false, message: "Lead not found." };
    if (lead.email && lead.emailStatus !== "invalid") return { ok: false, message: "Find Email only runs when email is missing or marked invalid." };
    if (!lead.firstName || !lead.lastName || !lead.domain) return { ok: false, message: "Find Email needs first name, last name, and domain." };
    const lmKey = (await getSecret("leadmagic_api_key").catch(() => null)) ?? undefined;
    const result = await new LeadMagicClient(lmKey ? { apiKey: lmKey } : {}).findEmail(lead);
    if (!result.email) return { ok: false, message: "LeadMagic did not return an email for this row." };
    const beforeWrite = await getLeadById(lead.id); if (!beforeWrite) return { ok: false, message: "Lead not found." };
    const outcome = await commitWriteback({ leadId: lead.id, column: "email", value: result.email, expectedUpdatedAt: beforeWrite.updatedAt, runId, provider: result.source, message: `Found ${result.email}`, details: { raw: result.raw } });
    if (outcome === "written") {
      const fresh = await getLeadById(lead.id);
      if (fresh) await commitWriteback({ leadId: lead.id, column: "email_status", value: null, expectedUpdatedAt: fresh.updatedAt, runId, provider: result.source, message: "Reset after email discovery", details: { sourceAction: "find_email" } });
    }
    return { ok: outcome === "written" || outcome === "duplicate", message: outcome === "written" ? `Found ${result.email}. ZeroBounce validation can run next.` : `Find Email writeback was ${outcome}.`, outcome, value: result.email };
  } catch (error) { return { ok: false, message: msg(error, "Find Email failed.") }; }
}

export async function runValidateEmailCore(leadId: string, runId: string): Promise<RunnerResult> {
  try {
    const lead = await getLeadById(leadId); if (!lead) return { ok: false, message: "Lead not found." }; if (!lead.email) return { ok: false, message: "Validate Email depends on the Email column." };
    const zbKey = (await getSecret("zerobounce_api_key").catch(() => null)) ?? undefined;
    const result = await new ZeroBounceClient(zbKey).validate(lead.email);
    const value = mapZeroBounceToEmailStatus(result.status);
    const fresh = await getLeadById(lead.id); if (!fresh) return { ok: false, message: "Lead not found." };
    const outcome = await commitWriteback({ leadId: lead.id, column: "email_status", value, expectedUpdatedAt: fresh.updatedAt, runId, provider: "zerobounce", message: `${lead.email}: ${value}`, details: { zeroBounceStatus: result.status, raw: result.raw } });
    return { ok: outcome === "written" || outcome === "duplicate", message: outcome === "written" ? `Validated ${lead.email}: ${value} via ZeroBounce.` : `Validation writeback was ${outcome}.`, outcome, value };
  } catch (error) { return { ok: false, message: msg(error, "Email validation failed.") }; }
}

export const LINKEDIN_STATUS_LABELS: Record<string, string> = { working: "At company", not_working: "Left company", uncertain: "Unsure" };

export async function runLinkedinVerifyCore(leadId: string, runId: string): Promise<RunnerResult> {
  try {
    const lead = await getLeadById(leadId); if (!lead) return { ok: false, message: "Lead not found." };
    if (!lead.linkedinUrl?.trim()) return { ok: false, message: "This lead has no LinkedIn URL to check." };
    const apKey = (await getSecret("apify_api_key").catch(() => null)) ?? undefined;
    const result = await new ApifyClient(apKey ? { token: apKey } : {}).verifyEmployment(lead);
    const now = new Date().toISOString();
    const admin = getAdminClient();
    // Boolean + jsonb + timestamp write; the single-column writeback RPC does not
    // fit, so update directly (like the Smartlead export path) and log the full
    // scraped payload to lead_runs for the click-into detail view.
    const { error } = await admin.from("leads").update({
      linkedin_employment_status: result.status,
      linkedin_current_company: result.currentCompany,
      linkedin_profile: result.profile,
      linkedin_checked_at: now,
      updated_at: now,
    }).eq("id", lead.id);
    if (error) throw new Error(error.message);
    const logged = await admin.from("lead_runs").insert({
      lead_id: lead.id, action: "linkedin_verify", provider: "apify", ok: true,
      message: `${LINKEDIN_STATUS_LABELS[result.status] ?? result.status}: ${result.reason}`,
      details: { run_id: runId, status: result.status, currentCompany: result.currentCompany, reason: result.reason, profile: result.profile },
    });
    if (logged.error && logged.error.code !== "23505") throw new Error(logged.error.message);
    return { ok: true, message: `${LINKEDIN_STATUS_LABELS[result.status] ?? result.status}. ${result.reason}`, outcome: "written", value: result.status };
  } catch (error) { return { ok: false, message: msg(error, "LinkedIn verification failed.") }; }
}

export async function runPersonalizationCore(leadId: string, column: PersonalizationColumn, runId: string, model: string, reasoningEffort?: string | null): Promise<RunnerResult> {
  try {
    const lead = await getLeadById(leadId); if (!lead) return { ok: false, message: "Lead not found." };
    if (lead.emailStatus !== "deliverable") return { ok: false, message: "Campaign variables only run after ZeroBounce marks the email as deliverable." };
    const coworker = column === "ops_candidate" ? await getCoworker(lead.id) : null;
    const generated = await generatePersonalizationValue(column, lead, model, coworker, reasoningEffort);
    if (!generated.ok) return { ok: false, message: generated.message, kind: generated.kind, provider: generated.provider, retryAfterMs: generated.retryAfterMs };
    const fresh = await getLeadById(lead.id); if (!fresh) return { ok: false, message: "Lead not found." };
    const outcome = await commitWriteback({ leadId: lead.id, column, value: generated.value, expectedUpdatedAt: fresh.updatedAt, runId, provider: generated.provider, message: `${column} = ${generated.value}`, details: { fallback: generated.fallback, runner: generated.runner } });
    return { ok: outcome === "written" || outcome === "duplicate", message: outcome === "written" ? `${column} set to "${generated.value}".` : `Personalization writeback was ${outcome}.`, outcome, value: generated.value, provider: generated.provider, fallback: generated.fallback };
  } catch (error) { return { ok: false, message: msg(error, "Personalization failed.") }; }
}

export async function exportLeadCore(leadId: string, tableId: string, runId: string, expectedCampaignId: string): Promise<RunnerResult> {
  const admin = getAdminClient();
  // "failed" status is written ONLY when the provider call itself failed; a
  // pre-check throw must not mark the lead, and a bookkeeping throw after a
  // successful push must never mark an actually-exported lead re-runnable.
  let exportAttempted = false;
  let exportSucceeded = false;
  let attemptedTableId: string | null = null;
  let attemptedCampaignId: string | null = null;
  let attemptedCampaignName: string | null = null;
  try {
    const selected = await getTableById(tableId);
    if (!selected) return { ok: false, message: "Table not found." };
    const effective = await getEffectiveCampaignForTable(tableId);
    if (!effective) return { ok: false, message: "Tag this list, its workbook, or its folder to a campaign before exporting." };
    if (effective.id !== expectedCampaignId) return { ok: false, message: "The list's campaign changed. Restart the export run." };
    const lead = await getLeadById(leadId); if (!lead) return { ok: false, message: "Lead not found." };
    const existing = await admin.from("enrichment_table_exports").select("id").eq("table_id", selected.id).eq("lead_id", lead.id).eq("status", "exported").limit(1);
    if (existing.error) throw new Error(existing.error.message);
    // An already-exported lead is REFRESHED, not skipped: its mapped variable
    // values may have changed since the push (regenerated cell, repaired copy,
    // template-era drift), and a bare skip left leads sitting in the campaign
    // rendering the field set from whenever they were first exported. A gate
    // miss on such a lead just leaves the campaign as-is - it must never fail
    // the lead (it IS exported) and never push unreviewed values.
    const alreadyExported = Boolean(existing.data?.length);
    const gateMiss = (message: string): RunnerResult => alreadyExported
      ? { ok: true, message: `Already exported; campaign variables left as-is (${message})`, outcome: "duplicate" }
      : { ok: false, message };
    if (!lead.email || lead.emailStatus !== "deliverable") return gateMiss("Smartlead export requires a deliverable email.");
    if (lead.suppressionReason) return gateMiss(`Smartlead export blocked: ${lead.suppressionReason}`);
    const columns = await getTableColumns(selected.id);
    // Title-check gate: a lead the title check marked "no" is not a fit and is
    // never exported.
    const titleColumn = columns.find((c) => c.key === TITLE_FIT_KEY);
    if (titleColumn) {
      const titleCell = await admin.from("enrichment_cell_values").select("value").eq("column_id", titleColumn.id).eq("lead_id", lead.id).maybeSingle();
      if (titleCell.error) throw new Error(titleCell.error.message); // fail closed, not open
      if (String((titleCell.data as { value?: unknown } | null)?.value ?? "").trim().toLowerCase() === "no") {
        return gateMiss("Title check marked this lead as not a fit, so it is not exported.");
      }
    }
    // Email-review gate: if the table has an email_qa column, the lead must have
    // passed the review before it can be pushed to Smartlead.
    const qaColumn = columns.find((c) => c.kind === "email_qa");
    if (qaColumn) {
      const details = await getEmailQaDetails(qaColumn.id, lead.id);
      const verdict = (details as { verdict?: string } | null)?.verdict;
      if (verdict !== "ready") {
        return gateMiss(verdict === "needs_review" ? "Email review is not passing for this lead. Fix it before exporting." : "Run the email review for this lead before exporting.");
      }
    }
    // Custom-column tables (v2) export their mapped custom variables; tables
    // with no mappings (Champions) fall back to the original legacy variables,
    // byte-identical. finalFirstName/finalCompanyName fall back to the native
    // fields so a v2 list that does not run those built-ins still sends a name.
    const customVars = await getCustomExportVariables(selected.id, lead.id);
    const variables = Object.keys(customVars).length > 0
      ? customVars
      : { title: lead.finalTitle ?? "", operations_task: lead.operationsTask ?? "", ops_candidate: lead.opsCandidate ?? "" };
    if (alreadyExported) {
      // Refresh path: upsert the current variable set onto the existing campaign
      // lead (merged in place; verified live). No export bookkeeping changes -
      // the lead stays exported, only its fields are brought back in sync.
      const refreshed = await addCampaignLeads(effective.id, [{ email: lead.email, variables }]);
      const logged = await admin.from("lead_runs").insert({ lead_id: lead.id, action: "smartlead_export", provider: "smartlead", ok: true, message: `Refreshed campaign variables for ${lead.email}`, details: { run_id: runId, table_id: selected.id, refreshed: true, result: refreshed } });
      if (logged.error && logged.error.code !== "23505") throw new Error(logged.error.message);
      return { ok: true, message: `Refreshed campaign variables for ${lead.email}.`, outcome: "duplicate" };
    }
    attemptedTableId = selected.id;
    attemptedCampaignId = effective.id;
    attemptedCampaignName = effective.name;
    exportAttempted = true;
    const result = await addCampaignLeads(effective.id, [{ email: lead.email, firstName: (lead.finalFirstName ?? lead.firstName) ?? undefined, lastName: lead.lastName ?? undefined, company: (lead.finalCompanyName ?? lead.company) ?? undefined, website: lead.domain ? `https://${lead.domain.replace(/^https?:\/\//, "")}` : undefined, linkedinUrl: lead.linkedinUrl ?? undefined, variables }]);
    exportSucceeded = true;
    const now = new Date().toISOString();
    const exportRecord = await admin.from("enrichment_table_exports").upsert({ table_id: selected.id, lead_id: lead.id, campaign_id: effective.id, campaign_name: effective.name, status: "exported", error: null, run_id: runId, exported_at: now }, { onConflict: "table_id,lead_id,campaign_id" });
    if (exportRecord.error) throw new Error(exportRecord.error.message);
    const { error } = await admin.from("leads").update({ smartlead_campaign_id: effective.id, smartlead_campaign_name: effective.name, smartlead_export_status: "exported", smartlead_exported_at: now, smartlead_export_error: null, updated_at: now }).eq("id", lead.id);
    if (error) throw new Error(error.message);
    const logged = await admin.from("lead_runs").insert({ lead_id: lead.id, action: "smartlead_export", provider: "smartlead", ok: true, message: `Exported ${lead.email} to campaign ${effective.id}`, details: { run_id: runId, table_id: selected.id, result } });
    if (logged.error && logged.error.code !== "23505") throw new Error(logged.error.message);
    return { ok: true, message: `Exported ${lead.email} to Smartlead.`, outcome: "written", result };
  } catch (error) {
    if (exportSucceeded) {
      return { ok: false, message: `The lead reached Smartlead but recording it here failed: ${msg(error, "unknown error")}. Refresh before retrying.` };
    }
    if (exportAttempted) {
      const failure = msg(error, "Smartlead export failed.");
      if (attemptedTableId && attemptedCampaignId && attemptedCampaignName) {
        const now = new Date().toISOString();
        // Never demote an exported row: a concurrent session may have already
        // pushed this lead, and flipping it to failed would re-arm the lead
        // for another push. Insert-if-absent; a real failed row can update.
        const alreadyExported = await admin.from("enrichment_table_exports").select("id").eq("table_id", attemptedTableId).eq("lead_id", leadId).eq("campaign_id", attemptedCampaignId).eq("status", "exported").limit(1);
        if (alreadyExported.data?.length) {
          return { ok: false, message: `${failure} A concurrent run already exported this lead; it stays marked exported.` };
        }
        const failedExport = await admin.from("enrichment_table_exports").upsert({ table_id: attemptedTableId, lead_id: leadId, campaign_id: attemptedCampaignId, campaign_name: attemptedCampaignName, status: "failed", error: failure, run_id: runId, exported_at: now }, { onConflict: "table_id,lead_id,campaign_id" });
        const failedSummary = await admin.from("leads").update({ smartlead_campaign_id: attemptedCampaignId, smartlead_campaign_name: attemptedCampaignName, smartlead_export_status: "failed", smartlead_exported_at: now, smartlead_export_error: failure }).eq("id", leadId);
        const recordingError = failedExport.error?.message ?? failedSummary.error?.message;
        if (recordingError) return { ok: false, message: `${failure} Recording the failed export also failed: ${recordingError}` };
      }
    }
    return { ok: false, message: msg(error, "Smartlead export failed.") };
  }
}
