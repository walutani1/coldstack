"use server";

import { z } from "zod";
import { requireActiveProfileResult } from "@/lib/auth";
import {
  addSuppression, deleteEnrichmentView, getFilterOptions,
  getLeadById, getLeadRunHistory, getLeadsPage, getSegmentStats,
  listEnrichmentViews, listSuppressions, removeSuppression, upsertEnrichmentView,
} from "@/lib/enrichment/queries";
import {
  CLI_MODEL_CATALOG, ENRICHMENT_MODEL_CATALOG, GATEWAY_MODEL_PATTERN, RECOMMENDED_GATEWAY_MODELS,
  getEnrichmentRunnerConfig, saveEnrichmentRunnerConfig, vendorLabel, withUniqueLabels,
  type EnrichmentRunnerConfig,
} from "@/lib/enrichment/llm-runner";
import {
  getPersonalizationPromptConfig, PERSONALIZATION_COLUMNS,
  savePersonalizationPromptConfig,
} from "@/lib/enrichment/personalization";
import {
  canonicalFilterSchema, createFolder, createTable, createWorkbook, deleteFolder, deleteTable,
  deleteWorkbook, getEffectiveCampaignForTable, getTableById, getWorkspaceTree, moveTableToWorkbook,
  moveWorkbookToFolder, renameFolder, renameTable, renameWorkbook, reorderTable, setFolderCampaign,
  setTableCampaign, setWorkbookCampaign,
} from "@/lib/enrichment/workspace";
import { getSecretStatus } from "@/lib/secrets";
import { listGatewayModels } from "@/lib/enrichment/gateway-models";
import {
  activeColumnModel, createCustomColumn, setColumnModels, createEmailReviewColumn, createTitleCheckColumn, deleteCustomColumn,
  getTableColumns, getTableSpend, previewCustomColumnPrompt, reorderColumns, runCustomColumn, runTitleCheck, updateCustomColumn,
} from "@/lib/enrichment/custom-columns";
import { getEmailQaInspection, runEmailQa } from "@/lib/enrichment/email-qa";
import {
  exportLeadCore, runFindEmailCore, runLinkedinVerifyCore, runPersonalizationCore, runValidateEmailCore,
} from "@/lib/enrichment/runners";
import {
  cancelRunJob, createRunJob, getLatestRunJobForTable, getRunJob,
} from "@/lib/enrichment/run-jobs";
import {
  chatReview, clearColumnSelection, getReviewDetail, getReviewQueue, resolveReview, selectProposal, type ResolveDecision,
} from "@/lib/enrichment/email-review";
import { getEmailReviewConfig, saveEmailReviewConfig } from "@/lib/enrichment/email-review-config";
import { getExportMappingView, saveExportMappings } from "@/lib/enrichment/export-mappings";
import { addToGlobalBlockList, removeCampaignLead, resolveLeadByEmail } from "@/lib/smartlead";
import { getAdminClient } from "@/lib/supabase/admin";

const uuidSchema = z.string().uuid();
const runSchema = z.object({ leadId: uuidSchema, runId: z.string().trim().min(1).max(200) }).strict();
const personalizationSchema = runSchema.extend({ column: z.enum(PERSONALIZATION_COLUMNS) }).strict();
const pageSchema = z.object({
  tableId: uuidSchema,
  limit: z.number().int().min(1).max(500).optional(), offset: z.number().int().min(0).optional(),
  search: z.string().max(300).nullable().optional(), roleLevels: z.array(z.string().max(100)).max(100).optional(),
  emailStatuses: z.array(z.string().max(100)).max(100).optional(), countries: z.array(z.string().max(100)).max(250).optional(),
  hasEmail: z.boolean().nullable().optional(), qualifiedOnly: z.boolean().optional(),
  sort: z.enum(["contact", "company", "qualification", "email", "validate_email", "email_status", "final_first_name", "final_title", "final_company_name", "operations_task", "ops_candidate", "smartlead_export"]).nullable().optional(),
  sortDir: z.enum(["asc", "desc"]).optional(),
  cellColumnId: uuidSchema.nullable().optional(),
  cellState: z.enum(["not_run", "done", "outdated"]).nullable().optional(),
  cellGeneration: z.number().int().min(0).nullable().optional(),
  erroredJobId: uuidSchema.nullable().optional(),
  queuedJobId: uuidSchema.nullable().optional(),
}).strict();
const suppressionSchema = z.object({ kind: z.enum(["email", "domain"]), value: z.string().trim().min(1).max(500), reason: z.string().trim().max(1000).nullable().optional() }).strict();
const viewSchema = z.object({ name: z.string().trim().min(1).max(120), config: z.record(z.string(), z.unknown()) }).strict();
const nameSchema = z.string().trim().min(1).max(80);
const descriptionSchema = z.string().trim().max(300);
type ExistingClientProvider = Exclude<EnrichmentRunnerConfig["provider"], "openai-api">;
function clientCompatibleRunnerConfig(config: EnrichmentRunnerConfig) {
  // Existing clients have a narrower handwritten provider union. Keep the
  // runtime value intact while this backend-only change lands independently.
  return { ...config, provider: config.provider as ExistingClientProvider };
}
/* A column may run on any catalog model OR any well-formed gateway id.

   Membership of the hardcoded catalog used to be the only test, so a model the
   gateway serves but this file had never heard of was rejected on save - which
   made every new model a code change. Validate the SHAPE instead (the same rule
   saveEnrichmentRunnerConfig applies to the workspace model); the gateway is the
   authority on what it will actually serve, and it answers at run time. */
function unsupportedModelMessage(model: string | undefined): string | null {
  if (!model) return null;
  if (ENRICHMENT_MODEL_CATALOG.some((m) => m.id === model)) return null;
  if (GATEWAY_MODEL_PATTERN.test(model)) return null;
  return `Model "${model}" is not a known model or a gateway id like "openai/gpt-5.6-luna".`;
}

/* CLI-mode models are whatever `claude --model` / `codex -m` accept: aliases
   ("opus", "sonnet[1m]"), full ids, or empty for that CLI's own default. They
   are interpolated into a shell command, so the character set is restricted
   here as well as quoted at the call site. */
const CLI_MODEL_PATTERN = /^[\w.:[\]-]*$/;
function unsupportedCliModelMessage(model: string | undefined): string | null {
  if (model === undefined || CLI_MODEL_PATTERN.test(model)) return null;
  return `CLI model "${model}" may only contain letters, digits, dots, colons, dashes and brackets.`;
}

const campaignSchema = z.object({ id: z.string().regex(/^\d+$/), name: z.string().trim().min(1).max(200) }).strict();

type Failure = { ok: false; message: string };
async function auth(): Promise<{ ok: true; profile: { id: string } } | Failure> {
  return requireActiveProfileResult();
}
function message(error: unknown, fallback: string) { return error instanceof Error ? error.message : fallback; }

export async function getWorkspaceTreeAction() {
  const access = await auth(); if (!access.ok) return access;
  try { return { ok: true, message: "", tree: await getWorkspaceTree() }; } catch (error) { return { ok: false, message: message(error, "Could not load workbooks.") }; }
}
export async function createFolderAction(name: unknown) {
  const access = await auth(); if (!access.ok) return access; const parsed = nameSchema.safeParse(name); if (!parsed.success) return { ok: false, message: "Invalid folder." };
  try { return { ok: true, message: "Folder created.", folder: await createFolder(parsed.data) }; } catch (error) { return { ok: false, message: message(error, "Could not create folder.") }; }
}
export async function renameFolderAction(id: unknown, name: unknown) {
  const access = await auth(); if (!access.ok) return access; const parsed = z.object({ id: uuidSchema, name: nameSchema }).strict().safeParse({ id, name }); if (!parsed.success) return { ok: false, message: "Invalid folder rename." };
  try { return { ok: true, message: "Folder renamed.", folder: await renameFolder(parsed.data.id, parsed.data.name) }; } catch (error) { return { ok: false, message: message(error, "Could not rename folder.") }; }
}
export async function deleteFolderAction(id: unknown) {
  const access = await auth(); if (!access.ok) return access; const parsed = uuidSchema.safeParse(id); if (!parsed.success) return { ok: false, message: "Invalid folder id." };
  try { await deleteFolder(parsed.data); return { ok: true, message: "Folder deleted." }; } catch (error) { return { ok: false, message: message(error, "Could not delete folder.") }; }
}
export async function setFolderCampaignAction(id: unknown, campaign: unknown) {
  const access = await auth(); if (!access.ok) return access; const parsed = z.object({ id: uuidSchema, campaign: campaignSchema.nullable() }).strict().safeParse({ id, campaign }); if (!parsed.success) return { ok: false, message: "Invalid folder campaign." };
  try { return { ok: true, message: parsed.data.campaign ? "Campaign set." : "Campaign cleared.", folder: await setFolderCampaign(parsed.data.id, parsed.data.campaign) }; } catch (error) { return { ok: false, message: message(error, "Could not update folder campaign.") }; }
}
export async function createWorkbookAction(name: unknown, description: unknown, folderId?: unknown) {
  const access = await auth(); if (!access.ok) return access; const parsed = z.object({ name: nameSchema, description: descriptionSchema, folderId: uuidSchema.nullable().optional() }).strict().safeParse({ name, description, folderId }); if (!parsed.success) return { ok: false, message: "Invalid workbook." };
  try { return { ok: true, message: "Workbook created.", workbook: await createWorkbook(parsed.data.name, parsed.data.description, parsed.data.folderId) }; } catch (error) { return { ok: false, message: message(error, "Could not create workbook.") }; }
}
export async function renameWorkbookAction(id: unknown, name: unknown) {
  const access = await auth(); if (!access.ok) return access; const parsed = z.object({ id: uuidSchema, name: nameSchema }).strict().safeParse({ id, name }); if (!parsed.success) return { ok: false, message: "Invalid workbook rename." };
  try { return { ok: true, message: "Workbook renamed.", workbook: await renameWorkbook(parsed.data.id, parsed.data.name) }; } catch (error) { return { ok: false, message: message(error, "Could not rename workbook.") }; }
}
export async function moveWorkbookAction(id: unknown, folderId: unknown) {
  const access = await auth(); if (!access.ok) return access; const parsed = z.object({ id: uuidSchema, folderId: uuidSchema.nullable() }).strict().safeParse({ id, folderId }); if (!parsed.success) return { ok: false, message: "Invalid workbook move." };
  try { return { ok: true, message: "Workbook moved.", workbook: await moveWorkbookToFolder(parsed.data.id, parsed.data.folderId) }; } catch (error) { return { ok: false, message: message(error, "Could not move workbook.") }; }
}
export async function deleteWorkbookAction(id: unknown) {
  const access = await auth(); if (!access.ok) return access; const parsed = uuidSchema.safeParse(id); if (!parsed.success) return { ok: false, message: "Invalid workbook id." };
  try { await deleteWorkbook(parsed.data); return { ok: true, message: "Workbook deleted." }; } catch (error) { return { ok: false, message: message(error, "Could not delete workbook.") }; }
}
export async function setWorkbookCampaignAction(id: unknown, campaign: unknown) {
  const access = await auth(); if (!access.ok) return access; const parsed = z.object({ id: uuidSchema, campaign: campaignSchema.nullable() }).strict().safeParse({ id, campaign }); if (!parsed.success) return { ok: false, message: "Invalid workbook campaign." };
  try { return { ok: true, message: parsed.data.campaign ? "Campaign set." : "Campaign cleared.", workbook: await setWorkbookCampaign(parsed.data.id, parsed.data.campaign) }; } catch (error) { return { ok: false, message: message(error, "Could not update workbook campaign.") }; }
}
export async function createTableAction(workbookId: unknown, name: unknown, description: unknown, config?: unknown) {
  const access = await auth(); if (!access.ok) return access; const parsed = z.object({ workbookId: uuidSchema, name: nameSchema, description: descriptionSchema, config: canonicalFilterSchema.optional() }).strict().safeParse({ workbookId, name, description, config }); if (!parsed.success) return { ok: false, message: "Invalid table." };
  try { return { ok: true, message: "Table created.", table: await createTable(parsed.data.workbookId, parsed.data.name, parsed.data.description, parsed.data.config) }; } catch (error) { return { ok: false, message: message(error, "Could not create table.") }; }
}
export async function renameTableAction(id: unknown, name: unknown) {
  const access = await auth(); if (!access.ok) return access; const parsed = z.object({ id: uuidSchema, name: nameSchema }).strict().safeParse({ id, name }); if (!parsed.success) return { ok: false, message: "Invalid table rename." };
  try { return { ok: true, message: "Table renamed.", table: await renameTable(parsed.data.id, parsed.data.name) }; } catch (error) { return { ok: false, message: message(error, "Could not rename table.") }; }
}
export async function moveTableAction(tableId: unknown, workbookId: unknown) {
  const access = await auth(); if (!access.ok) return access; const parsed = z.object({ tableId: uuidSchema, workbookId: uuidSchema }).strict().safeParse({ tableId, workbookId }); if (!parsed.success) return { ok: false, message: "Invalid table move." };
  try { return { ok: true, message: "Table moved.", table: await moveTableToWorkbook(parsed.data.tableId, parsed.data.workbookId) }; } catch (error) { return { ok: false, message: message(error, "Could not move table.") }; }
}
export async function reorderTableAction(tableId: unknown, direction: unknown) {
  const access = await auth(); if (!access.ok) return access; const parsed = z.object({ tableId: uuidSchema, direction: z.enum(["left", "right"]) }).strict().safeParse({ tableId, direction }); if (!parsed.success) return { ok: false, message: "Invalid table reorder." };
  try { return { ok: true, message: "Table reordered.", table: await reorderTable(parsed.data.tableId, parsed.data.direction) }; } catch (error) { return { ok: false, message: message(error, "Could not reorder table.") }; }
}
export async function deleteTableAction(id: unknown) {
  const access = await auth(); if (!access.ok) return access; const parsed = uuidSchema.safeParse(id); if (!parsed.success) return { ok: false, message: "Invalid table id." };
  try { await deleteTable(parsed.data); return { ok: true, message: "Table deleted." }; } catch (error) { return { ok: false, message: message(error, "Could not delete table.") }; }
}
export async function setTableCampaignAction(tableId: unknown, campaign: unknown) {
  const access = await auth(); if (!access.ok) return access; const parsed = z.object({ tableId: uuidSchema, campaign: campaignSchema.nullable() }).strict().safeParse({ tableId, campaign }); if (!parsed.success) return { ok: false, message: "Invalid table campaign." };
  try { return { ok: true, message: parsed.data.campaign ? "Campaign set." : "Campaign cleared.", table: await setTableCampaign(parsed.data.tableId, parsed.data.campaign) }; } catch (error) { return { ok: false, message: message(error, "Could not update table campaign.") }; }
}

export async function getEnrichmentLeadsPageAction(args: unknown) {
  const access = await auth(); if (!access.ok) return access;
  const parsed = pageSchema.safeParse(args); if (!parsed.success) return { ok: false, message: "Invalid lead page request." };
  try {
    const selected = await getTableById(parsed.data.tableId);
    if (!selected) return { ok: false, message: "Table not found." };
    return { ok: true, message: "", page: await getLeadsPage({ ...parsed.data, canonical: selected.canonical }) };
  }
  catch (error) { return { ok: false, message: message(error, "Could not load prospects.") }; }
}

/* ── Durable run jobs ──────────────────────────────────────────────────────
   A bulk fill (kind='column') or an autorun waterfall (kind='waterfall') is a
   server-side job: the client creates it, then polls getRunJobAction. Real
   per-provider concurrency runs on the server (client-invoked Server Functions
   are serialized in this Next.js), and progress survives a refresh. */
// The active toolbar filters + sort, so a run scopes to the on-screen view.
const runFiltersSchema = z.object({
  search: z.string().max(300).nullable().optional(),
  roleLevels: z.array(z.string().max(100)).max(100).optional(),
  emailStatuses: z.array(z.string().max(100)).max(100).optional(),
  countries: z.array(z.string().max(100)).max(250).optional(),
  hasEmail: z.boolean().nullable().optional(),
  qualifiedOnly: z.boolean().optional(),
  sort: z.enum(["contact", "company", "qualification", "email", "validate_email", "email_status", "final_first_name", "final_title", "final_company_name", "operations_task", "ops_candidate", "smartlead_export"]).nullable().optional(),
  sortDir: z.enum(["asc", "desc"]).optional(),
  cellColumnId: uuidSchema.nullable().optional(),
  cellState: z.enum(["not_run", "done", "outdated"]).nullable().optional(),
  cellGeneration: z.number().int().min(0).nullable().optional(),
  erroredJobId: uuidSchema.nullable().optional(),
  queuedJobId: uuidSchema.nullable().optional(),
}).strict();

export async function createRunJobAction(tableId: unknown, startColumnKey: unknown, mode: unknown, kind: unknown, includeExport: unknown, filters?: unknown, count?: unknown, offset?: unknown, leadIds?: unknown) {
  const access = await auth(); if (!access.ok) return access;
  const parsed = z.object({
    tableId: uuidSchema,
    startColumnKey: z.string().trim().min(1).max(60),
    mode: z.enum(["test10", "unrun", "outdated", "force", "count"]),
    kind: z.enum(["column", "waterfall"]),
    includeExport: z.boolean(),
    filters: runFiltersSchema.optional(),
    // Only used by mode 'count': how many rows and the 0-based starting row.
    count: z.number().int().min(1).max(20000).optional(),
    offset: z.number().int().min(0).max(1000000).optional(),
    // Only used by mode 'count': the exact on-screen rows to run. Capped at the
    // same ceiling as count so a crafted payload cannot queue an unbounded job.
    leadIds: z.array(uuidSchema).min(1).max(20000).optional(),
  }).strict().safeParse({ tableId, startColumnKey, mode, kind, includeExport, filters: filters ?? undefined, count: count ?? undefined, offset: offset ?? undefined, leadIds: leadIds ?? undefined });
  if (!parsed.success) return { ok: false, message: "Invalid run request." };
  if (parsed.data.mode === "count" && !parsed.data.count) return { ok: false, message: "Enter how many rows to run." };
  try {
    const result = await createRunJob({
      tableId: parsed.data.tableId, kind: parsed.data.kind, startColumnKey: parsed.data.startColumnKey,
      mode: parsed.data.mode, includeExport: parsed.data.includeExport, createdBy: access.profile.id,
      filters: parsed.data.filters, count: parsed.data.count, offset: parsed.data.offset,
      leadIds: parsed.data.mode === "count" ? parsed.data.leadIds : undefined,
    });
    return result.ok ? { ok: true, message: "", jobId: result.jobId, total: result.total } : { ok: false, message: result.message };
  } catch (error) { return { ok: false, message: message(error, "Could not start the run.") }; }
}

export async function getRunJobAction(jobId: unknown) {
  const access = await auth(); if (!access.ok) return access;
  const parsed = uuidSchema.safeParse(jobId); if (!parsed.success) return { ok: false, message: "Invalid job." };
  try {
    const job = await getRunJob(parsed.data);
    return job ? { ok: true, message: "", job } : { ok: false, message: "Run not found." };
  } catch (error) { return { ok: false, message: message(error, "Could not load the run.") }; }
}

export async function getLatestRunJobForTableAction(tableId: unknown) {
  const access = await auth(); if (!access.ok) return access;
  const parsed = uuidSchema.safeParse(tableId); if (!parsed.success) return { ok: false, message: "Invalid table." };
  try { return { ok: true, message: "", job: await getLatestRunJobForTable(parsed.data) }; }
  catch (error) { return { ok: false, message: message(error, "Could not load the run.") }; }
}

// Lead ids a run job currently has claimed (in flight), so the client can show
// the per-cell spinner on the exact rows being processed.
export async function getRunJobActiveLeadIdsAction(jobId: unknown) {
  const access = await auth(); if (!access.ok) return access;
  const parsed = uuidSchema.safeParse(jobId); if (!parsed.success) return { ok: false, message: "Invalid job." };
  try {
    const res = await getAdminClient().from("enrichment_run_job_items").select("lead_id, current_step").eq("job_id", parsed.data).eq("status", "running").limit(500);
    if (res.error) throw new Error(res.error.message);
    const rows = (res.data as { lead_id: string; current_step: string | null }[] | null) ?? [];
    // `active` carries the step each row is on so the spinner can follow the row
    // across the table; `leadIds` stays for the plain in-flight-rows case.
    return {
      ok: true,
      message: "",
      leadIds: rows.map((r) => r.lead_id),
      active: rows.map((r) => ({ leadId: r.lead_id, step: r.current_step })),
    };
  } catch (error) { return { ok: false, message: message(error, "Could not load the run's active rows.") }; }
}

export async function cancelRunJobAction(jobId: unknown) {
  const access = await auth(); if (!access.ok) return access;
  const parsed = uuidSchema.safeParse(jobId); if (!parsed.success) return { ok: false, message: "Invalid job." };
  try { await cancelRunJob(parsed.data); return { ok: true, message: "" }; }
  catch (error) { return { ok: false, message: message(error, "Could not cancel the run.") }; }
}

/* ── Email review (manual approval before export) ──────────────────────────── */
export async function getReviewQueueAction(tableId: unknown) {
  const access = await auth(); if (!access.ok) return access;
  const parsed = uuidSchema.safeParse(tableId); if (!parsed.success) return { ok: false, message: "Invalid table." };
  try { return { ok: true, message: "", items: await getReviewQueue(parsed.data) }; }
  catch (error) { return { ok: false, message: message(error, "Could not load the review queue.") }; }
}

export async function getReviewDetailAction(itemId: unknown) {
  const access = await auth(); if (!access.ok) return access;
  const parsed = uuidSchema.safeParse(itemId); if (!parsed.success) return { ok: false, message: "Invalid review." };
  try {
    const detail = await getReviewDetail(parsed.data);
    return detail ? { ok: true, message: "", detail } : { ok: false, message: "Review not found." };
  } catch (error) { return { ok: false, message: message(error, "Could not load the review.") }; }
}

export async function resolveReviewAction(itemId: unknown, decision: unknown, resolutionKey: unknown) {
  const access = await auth(); if (!access.ok) return access;
  const parsed = z.object({ itemId: uuidSchema, decision: z.enum(["accepted", "declined_export", "declined_hold"]), resolutionKey: z.string().trim().min(1).max(200) }).strict().safeParse({ itemId, decision, resolutionKey });
  if (!parsed.success) return { ok: false, message: "Invalid review decision." };
  try { return await resolveReview(parsed.data.itemId, parsed.data.decision as ResolveDecision, access.profile.id, parsed.data.resolutionKey); }
  catch (error) { return { ok: false, message: message(error, "Could not resolve the review.") }; }
}

export async function chatReviewAction(itemId: unknown, columnId: unknown, instruction: unknown, requestKey: unknown) {
  const access = await auth(); if (!access.ok) return access;
  const parsed = z.object({ itemId: uuidSchema, columnId: uuidSchema, instruction: z.string().trim().min(1).max(2000), requestKey: z.string().trim().min(1).max(200) }).strict().safeParse({ itemId, columnId, instruction, requestKey });
  if (!parsed.success) return { ok: false, message: "Invalid chat request." };
  try { return await chatReview(parsed.data.itemId, parsed.data.columnId, parsed.data.instruction, parsed.data.requestKey, access.profile.id); }
  catch (error) { return { ok: false, message: message(error, "Could not regenerate.") }; }
}

export async function selectReviewProposalAction(proposalId: unknown) {
  const access = await auth(); if (!access.ok) return access;
  const parsed = uuidSchema.safeParse(proposalId); if (!parsed.success) return { ok: false, message: "Invalid proposal." };
  try { return await selectProposal(parsed.data); }
  catch (error) { return { ok: false, message: message(error, "Could not select the suggestion.") }; }
}

export async function clearReviewColumnAction(itemId: unknown, columnId: unknown) {
  const access = await auth(); if (!access.ok) return access;
  const parsed = z.object({ itemId: uuidSchema, columnId: uuidSchema }).strict().safeParse({ itemId, columnId });
  if (!parsed.success) return { ok: false, message: "Invalid request." };
  try { return await clearColumnSelection(parsed.data.itemId, parsed.data.columnId); }
  catch (error) { return { ok: false, message: message(error, "Could not update the selection.") }; }
}

export async function getEmailReviewModeAction() {
  const access = await auth(); if (!access.ok) return access;
  try { return { ok: true, message: "", mode: (await getEmailReviewConfig()).mode }; }
  catch (error) { return { ok: false, message: message(error, "Could not load the review mode.") }; }
}

export async function setEmailReviewModeAction(mode: unknown) {
  const access = await auth(); if (!access.ok) return access;
  const parsed = z.enum(["manual", "auto"]).safeParse(mode); if (!parsed.success) return { ok: false, message: "Invalid mode." };
  try { const saved = await saveEmailReviewConfig({ mode: parsed.data }, access.profile.id); return { ok: true, message: "", mode: saved.mode }; }
  catch (error) { return { ok: false, message: message(error, "Could not save the review mode.") }; }
}

export async function getExportMappingViewAction(tableId: unknown) {
  const access = await auth(); if (!access.ok) return access;
  const parsed = uuidSchema.safeParse(tableId); if (!parsed.success) return { ok: false, message: "Invalid table." };
  try { return { ok: true, message: "", view: await getExportMappingView(parsed.data) }; }
  catch (error) { return { ok: false, message: message(error, "Could not load export settings.") }; }
}

export async function saveExportMappingsAction(tableId: unknown, entries: unknown) {
  const access = await auth(); if (!access.ok) return access;
  const parsed = z.object({
    tableId: uuidSchema,
    entries: z.array(z.object({ targetKey: z.string().trim().min(1).max(120), columnId: uuidSchema.nullable() }).strict()).max(200),
  }).strict().safeParse({ tableId, entries });
  if (!parsed.success) return { ok: false, message: "Invalid mapping." };
  try { return await saveExportMappings(parsed.data.tableId, parsed.data.entries); }
  catch (error) { return { ok: false, message: message(error, "Could not save the mappings.") }; }
}

export async function getTableSpendAction(tableId: unknown) {
  const access = await auth(); if (!access.ok) return access;
  const parsed = uuidSchema.safeParse(tableId); if (!parsed.success) return { ok: false, message: "Invalid table." };
  try { return { ok: true, message: "", spend: await getTableSpend(parsed.data) }; }
  catch (error) { return { ok: false, message: message(error, "Could not load spend.") }; }
}

export async function getEnrichmentMetaAction(tableId?: unknown) {
  const access = await auth(); if (!access.ok) return access;
  const parsed = uuidSchema.safeParse(tableId);
  try {
    /* Scope the counts to the list when the caller names one, so they agree
       with the rows that list is showing. The canonical filter is read off the
       table here rather than accepted from the client: the scope of a count and
       the scope of the grid have to come from the same place, or they drift. */
    const canonical = parsed.success ? (await getTableById(parsed.data))?.canonical : undefined;
    const [segmentStats, filterOptions] = await Promise.all([getSegmentStats(canonical), getFilterOptions()]);
    return { ok: true, message: "", segmentStats, filterOptions };
  } catch (error) { return { ok: false, message: message(error, "Could not load prospect stats.") }; }
}

/* ── Per-table custom AI columns ─────────────────────────────────────────── */

export async function getTableColumnsAction(tableId: unknown) {
  const access = await auth(); if (!access.ok) return access;
  const parsed = uuidSchema.safeParse(tableId); if (!parsed.success) return { ok: false, message: "Invalid table." };
  try { return { ok: true, message: "", columns: await getTableColumns(parsed.data) }; }
  catch (error) { return { ok: false, message: message(error, "Could not load columns.") }; }
}

export async function runCustomColumnAction(columnId: unknown, leadId: unknown) {
  const access = await auth(); if (!access.ok) return access;
  const parsed = z.object({ columnId: uuidSchema, leadId: uuidSchema }).strict().safeParse({ columnId, leadId });
  if (!parsed.success) return { ok: false, message: "Invalid column run request." };
  try {
    const result = await runCustomColumn(parsed.data.columnId, parsed.data.leadId, access.profile.id);
    // Forward `blocked` ("waiting on <column>"): the autorun chain treats it as
    // a skip-and-retry, not a failure. Dropping it here made every blocked cell
    // look like an error to the client and stopped the row.
    return result.ok
      ? { ok: true, message: "", value: result.value, outcome: "written" as const }
      : { ok: false, message: result.message, ...(result.blocked ? { blocked: true as const } : {}) };
  } catch (error) { return { ok: false, message: message(error, "Column run failed.") }; }
}

const examplesSchema = z.array(z.string().max(500)).max(20);

export async function previewCustomColumnPromptAction(input: unknown) {
  const access = await auth(); if (!access.ok) return access;
  const parsed = z.object({
    tableId: uuidSchema,
    columnId: uuidSchema.nullable().default(null),
    prompt: z.string().max(8000),
    model: z.string().trim().max(100).default("claude-sonnet-5"),
    leadId: uuidSchema,
    examples: examplesSchema.optional(),
  }).strict().safeParse(input);
  if (!parsed.success) return { ok: false, message: "Invalid preview request." };
  try {
    const table = await getTableById(parsed.data.tableId); if (!table) return { ok: false, message: "Table not found." };
    const result = await previewCustomColumnPrompt(parsed.data);
    return result.ok
      ? { ok: true, message: "", full: result.full, missing: result.missing }
      : { ok: false, message: result.message };
  } catch (error) { return { ok: false, message: message(error, "Could not build preview.") }; }
}

export async function createCustomColumnAction(tableId: unknown, label: unknown, prompt: unknown, model: unknown, examples?: unknown, cliModel?: unknown, reasoningEffort?: unknown) {
  const access = await auth(); if (!access.ok) return access;
  const parsed = z.object({
    tableId: uuidSchema, label: z.string().trim().min(1).max(80),
    prompt: z.string().trim().min(1).max(8000), model: z.string().trim().max(100).default(""),
    cliModel: z.string().trim().max(100).default(""),
    reasoningEffort: z.string().trim().max(10).default(""),
    examples: examplesSchema.default([]),
  }).safeParse({ tableId, label, prompt, model, cliModel: cliModel ?? "", reasoningEffort: reasoningEffort ?? "", examples: examples ?? [] });
  if (!parsed.success) return { ok: false, message: "Invalid column." };
  const createModelError = unsupportedModelMessage(parsed.data.model || undefined);
  if (createModelError) return { ok: false, message: createModelError };
  const createCliError = unsupportedCliModelMessage(parsed.data.cliModel);
  if (createCliError) return { ok: false, message: createCliError };
  try { return { ok: true, message: "Column created.", column: await createCustomColumn(parsed.data) }; }
  catch (error) { return { ok: false, message: message(error, "Could not create column.") }; }
}

export async function updateCustomColumnAction(columnId: unknown, patch: unknown) {
  const access = await auth(); if (!access.ok) return access;
  const parsed = z.object({
    columnId: uuidSchema,
    patch: z.object({
      label: z.string().trim().min(1).max(80).optional(),
      prompt: z.string().trim().max(8000).optional(),
      model: z.string().trim().max(100).optional(),
      visible: z.boolean().optional(),
      sortOrder: z.number().int().min(0).max(100000).optional(),
      cliModel: z.string().trim().max(100).optional(),
      // "" clears back to off; the lib validates the tier.
      reasoningEffort: z.string().trim().max(10).optional(),
      examples: examplesSchema.optional(),
    }).strict(),
  }).strict().safeParse({ columnId, patch });
  if (!parsed.success) return { ok: false, message: "Invalid update." };
  const patchModelError = unsupportedModelMessage(parsed.data.patch.model || undefined);
  if (patchModelError) return { ok: false, message: patchModelError };
  const patchCliError = unsupportedCliModelMessage(parsed.data.patch.cliModel);
  if (patchCliError) return { ok: false, message: patchCliError };
  try { return { ok: true, message: "Column updated.", column: await updateCustomColumn(parsed.data.columnId, parsed.data.patch) }; }
  catch (error) { return { ok: false, message: message(error, "Could not update column.") }; }
}

export async function reorderColumnsAction(tableId: unknown, orderedIds: unknown) {
  const access = await auth(); if (!access.ok) return access;
  const parsed = z.object({ tableId: uuidSchema, orderedIds: z.array(uuidSchema).min(1).max(200) }).strict().safeParse({ tableId, orderedIds });
  if (!parsed.success) return { ok: false, message: "Invalid reorder." };
  try { await reorderColumns(parsed.data.tableId, parsed.data.orderedIds); return { ok: true, message: "" }; }
  catch (error) { return { ok: false, message: message(error, "Could not reorder columns.") }; }
}

export async function createEmailReviewColumnAction(tableId: unknown) {
  const access = await auth(); if (!access.ok) return access;
  const parsed = uuidSchema.safeParse(tableId); if (!parsed.success) return { ok: false, message: "Invalid table." };
  try { return { ok: true, message: "Email review column added.", column: await createEmailReviewColumn(parsed.data) }; }
  catch (error) { return { ok: false, message: message(error, "Could not add the email review column.") }; }
}

export async function runTitleCheckAction(columnId: unknown, leadId: unknown) {
  const access = await auth(); if (!access.ok) return access;
  const parsed = z.object({ columnId: uuidSchema, leadId: uuidSchema }).strict().safeParse({ columnId, leadId });
  if (!parsed.success) return { ok: false, message: "Invalid title check request." };
  try {
    const result = await runTitleCheck(parsed.data.columnId, parsed.data.leadId, access.profile.id);
    return result.ok
      ? { ok: true, message: "", answer: result.answer, reason: result.reason, outcome: "written" as const }
      : { ok: false, message: result.message };
  } catch (error) { return { ok: false, message: message(error, "Title check failed.") }; }
}

export async function createTitleCheckColumnAction(tableId: unknown) {
  const access = await auth(); if (!access.ok) return access;
  const parsed = uuidSchema.safeParse(tableId); if (!parsed.success) return { ok: false, message: "Invalid table." };
  try { return { ok: true, message: "Title check column added.", column: await createTitleCheckColumn(parsed.data) }; }
  catch (error) { return { ok: false, message: message(error, "Could not add the title check column.") }; }
}

export async function runEmailQaAction(columnId: unknown, leadId: unknown) {
  const access = await auth(); if (!access.ok) return access;
  const parsed = z.object({ columnId: uuidSchema, leadId: uuidSchema }).strict().safeParse({ columnId, leadId });
  if (!parsed.success) return { ok: false, message: "Invalid email review request." };
  try {
    const result = await runEmailQa(parsed.data.columnId, parsed.data.leadId, access.profile.id);
    return result.ok
      ? { ok: true, message: "", value: result.verdict === "ready" ? "Ready" : "Needs review", outcome: "written" as const }
      : { ok: false, message: result.message };
  } catch (error) { return { ok: false, message: message(error, "Email review failed.") }; }
}

export async function getEmailQaDetailsAction(columnId: unknown, leadId: unknown) {
  const access = await auth(); if (!access.ok) return access;
  const parsed = z.object({ columnId: uuidSchema, leadId: uuidSchema }).strict().safeParse({ columnId, leadId });
  if (!parsed.success) return { ok: false, message: "Invalid request." };
  try { return { ok: true, message: "", details: await getEmailQaInspection(parsed.data.columnId, parsed.data.leadId) }; }
  catch (error) { return { ok: false, message: message(error, "Could not load the email review.") }; }
}

export async function deleteCustomColumnAction(columnId: unknown) {
  const access = await auth(); if (!access.ok) return access;
  const parsed = uuidSchema.safeParse(columnId); if (!parsed.success) return { ok: false, message: "Invalid column." };
  try { await deleteCustomColumn(parsed.data); return { ok: true, message: "Column deleted." }; }
  catch (error) { return { ok: false, message: message(error, "Could not delete column.") }; }
}

export async function runFindEmailAction(leadId: unknown, runId: unknown) {
  const access = await auth(); if (!access.ok) return access;
  const parsed = runSchema.safeParse({ leadId, runId }); if (!parsed.success) return { ok: false, message: "Invalid find-email request." };
  return runFindEmailCore(parsed.data.leadId, parsed.data.runId);
}

export async function runValidateEmailAction(leadId: unknown, runId: unknown) {
  const access = await auth(); if (!access.ok) return access;
  const parsed = runSchema.safeParse({ leadId, runId }); if (!parsed.success) return { ok: false, message: "Invalid validation request." };
  return runValidateEmailCore(parsed.data.leadId, parsed.data.runId);
}

export async function runLinkedinVerifyAction(leadId: unknown, runId: unknown) {
  const access = await auth(); if (!access.ok) return access;
  const parsed = runSchema.safeParse({ leadId, runId }); if (!parsed.success) return { ok: false, message: "Invalid LinkedIn verify request." };
  return runLinkedinVerifyCore(parsed.data.leadId, parsed.data.runId);
}

export async function runPersonalizationAction(leadId: unknown, column: unknown, runId: unknown, tableId: unknown) {
  const access = await auth(); if (!access.ok) return access;
  const parsed = personalizationSchema.extend({ tableId: uuidSchema }).safeParse({ leadId, column, runId, tableId });
  if (!parsed.success) return { ok: false, message: "Invalid personalization request." };
  // The model is a property of the column in THIS table, so a hand re-run uses
  // exactly what the table shows rather than some hidden default.
  const columns = await getTableColumns(parsed.data.tableId);
  const columnRow = columns.find((c) => c.key === parsed.data.column);
  const model = columnRow ? await activeColumnModel(columnRow) : "";
  return runPersonalizationCore(parsed.data.leadId, parsed.data.column, parsed.data.runId, model);
}

export async function exportLeadToSmartleadAction(leadId: unknown, tableId: unknown, runId: unknown, expectedCampaignId: unknown) {
  const access = await auth(); if (!access.ok) return access;
  const parsed = z.object({ leadId: uuidSchema, tableId: uuidSchema, runId: z.string().trim().min(1).max(200), expectedCampaignId: z.string().regex(/^\d+$/) }).strict().safeParse({ leadId, tableId, runId, expectedCampaignId });
  if (!parsed.success) return { ok: false, message: "Invalid Smartlead export request." };
  return exportLeadCore(parsed.data.leadId, parsed.data.tableId, parsed.data.runId, parsed.data.expectedCampaignId);
}

/* Pull a lead out of the Smartlead campaign it was exported to (stops its
   sequence). Resolves the lead's Smartlead id by email, deletes it from the
   campaign, then marks the local export record as removed so the cell reflects
   it. Does not touch the lead record itself. */
export async function removeLeadFromCampaignAction(leadId: unknown, tableId: unknown) {
  const access = await auth(); if (!access.ok) return access;
  const parsed = z.object({ leadId: uuidSchema, tableId: uuidSchema }).strict().safeParse({ leadId, tableId });
  if (!parsed.success) return { ok: false, message: "Invalid remove request." };
  try {
    const table = await getTableById(parsed.data.tableId); if (!table) return { ok: false, message: "Table not found." };
    const effective = await getEffectiveCampaignForTable(parsed.data.tableId);
    if (!effective) return { ok: false, message: "This list is not tagged to a campaign." };
    const lead = await getLeadById(parsed.data.leadId); if (!lead) return { ok: false, message: "Lead not found." };
    if (!lead.email) return { ok: false, message: "This lead has no email to match in Smartlead." };
    const slLead = await resolveLeadByEmail(lead.email);
    if (!slLead) return { ok: false, message: "This lead was not found in Smartlead (nothing to remove)." };
    await removeCampaignLead(effective.id, slLead.id);
    const admin = getAdminClient();
    const now = new Date().toISOString();
    // Check both writes: a swallowed error here (e.g. a rejected status) would
    // leave a stale 'exported' record that blocks re-export, while the lead reads
    // "removed" - the split state this action caused before.
    const exportUpdate = await admin.from("enrichment_table_exports").upsert({ table_id: table.id, lead_id: lead.id, campaign_id: effective.id, campaign_name: effective.name, status: "removed", error: null, run_id: null, exported_at: now }, { onConflict: "table_id,lead_id,campaign_id" });
    if (exportUpdate.error) throw new Error(exportUpdate.error.message);
    const leadUpdate = await admin.from("leads").update({ smartlead_export_status: "removed", smartlead_export_error: null, updated_at: now }).eq("id", lead.id);
    if (leadUpdate.error) throw new Error(leadUpdate.error.message);
    await admin.from("lead_runs").insert({ lead_id: lead.id, action: "smartlead_remove", provider: "smartlead", ok: true, message: `Removed ${lead.email} from campaign ${effective.id}`, details: { table_id: table.id, campaign_id: effective.id, smartlead_lead_id: slLead.id } });
    return { ok: true, message: `Removed ${lead.email} from the campaign.` };
  } catch (error) { return { ok: false, message: message(error, "Could not remove the lead from Smartlead.") }; }
}

export async function listSuppressionsAction() {
  const access = await auth(); if (!access.ok) return access;
  try { return { ok: true, message: "", suppressions: await listSuppressions() }; } catch (error) { return { ok: false, message: message(error, "Could not load suppressions.") }; }
}
export async function addSuppressionAction(input: unknown) {
  const access = await auth(); if (!access.ok) return access;
  const parsed = suppressionSchema.safeParse(input); if (!parsed.success) return { ok: false, message: "Invalid suppression." };
  try {
    await addSuppression(parsed.data.kind, parsed.data.value, parsed.data.reason);
    let warning: string | null = null;
    try { await addToGlobalBlockList([parsed.data.value]); } catch (error) { warning = message(error, "Smartlead block-list update failed."); }
    return { ok: true, message: warning ? `Suppression saved locally. ${warning}` : "Suppression saved locally and in Smartlead.", suppressions: await listSuppressions() };
  } catch (error) { return { ok: false, message: message(error, "Could not add suppression.") }; }
}
export async function removeSuppressionAction(kind: unknown, value: unknown) {
  const access = await auth(); if (!access.ok) return access;
  const parsed = suppressionSchema.pick({ kind: true, value: true }).safeParse({ kind, value }); if (!parsed.success) return { ok: false, message: "Invalid suppression removal." };
  try { await removeSuppression(parsed.data.kind, parsed.data.value); return { ok: true, message: "Suppression removed locally.", suppressions: await listSuppressions() }; } catch (error) { return { ok: false, message: message(error, "Could not remove suppression.") }; }
}

export async function listViewsAction(tableId?: unknown) {
  const access = await auth(); if (!access.ok) return access;
  const parsed = uuidSchema.safeParse(tableId); if (!parsed.success) return { ok: false, message: "Invalid table id." };
  try { return { ok: true, message: "", views: await listEnrichmentViews(parsed.data) }; } catch (error) { return { ok: false, message: message(error, "Could not load views.") }; }
}
export async function saveViewAction(input: unknown) {
  const access = await auth(); if (!access.ok) return access;
  const parsed = viewSchema.extend({ tableId: uuidSchema }).strict().safeParse(input); if (!parsed.success) return { ok: false, message: "Invalid view." };
  try { return { ok: true, message: "View saved.", view: await upsertEnrichmentView({ tableId: parsed.data.tableId, name: parsed.data.name, profileId: access.profile.id, config: parsed.data.config }) }; } catch (error) { return { ok: false, message: message(error, "Could not save view.") }; }
}
export async function deleteViewAction(id: unknown, tableId?: unknown) {
  const access = await auth(); if (!access.ok) return access;
  const parsed = z.object({ id: uuidSchema, tableId: uuidSchema }).safeParse({ id, tableId }); if (!parsed.success) return { ok: false, message: "Invalid view id." };
  try { await deleteEnrichmentView(parsed.data.id, parsed.data.tableId); return { ok: true, message: "View deleted." }; } catch (error) { return { ok: false, message: message(error, "Could not delete view.") }; }
}
export async function getLeadRunsAction(leadId: unknown) {
  const access = await auth(); if (!access.ok) return access;
  const parsed = uuidSchema.safeParse(leadId); if (!parsed.success) return { ok: false, message: "Invalid lead id." };
  try { return { ok: true, message: "", runs: await getLeadRunHistory(parsed.data) }; } catch (error) { return { ok: false, message: message(error, "Could not load lead runs.") }; }
}

/* Models a column can be pinned to: whatever the gateway is serving right now,
   falling back to the static catalog when no gateway key is configured.

   Each option carries a human name and a one-line detail (price and context for
   a metered model, what it is for on the CLI side). The picker used to show the
   routing id alone, which turned a 200-model list into 200 near-identical slugs
   with no basis for choosing between them. */
function tokenCount(n: number): string {
  return n >= 950_000 ? `${Math.round(n / 1_000_000)}M` : `${Math.round(n / 1_000)}K`;
}
function gatewayDetail(model: { inputPer1M: number | null; outputPer1M: number | null; contextWindow: number | null }): string {
  const parts: string[] = [];
  if (model.inputPer1M !== null && model.outputPer1M !== null) {
    parts.push(`$${model.inputPer1M.toFixed(2)} / $${model.outputPer1M.toFixed(2)} per 1M`);
  }
  if (model.contextWindow) parts.push(`${tokenCount(model.contextWindow)} context`);
  return parts.join(" · ");
}

export async function getModelOptionsAction() {
  const access = await auth(); if (!access.ok) return access;
  try {
    const [gateway, config] = await Promise.all([listGatewayModels(), getEnrichmentRunnerConfig()]);
    /* Recommended first, in the order RECOMMENDED_GATEWAY_MODELS lists them,
       and only where the gateway actually serves the id - a shortcut that
       offers a model nobody can run is worse than no shortcut. The same model
       still appears under its vendor, so the sections stay independently
       complete and search finds it either way. */
    const byId = new Map(gateway.map((m) => [m.id, m]));
    const recommended = RECOMMENDED_GATEWAY_MODELS
      .map((id) => byId.get(id))
      .filter((m): m is NonNullable<typeof m> => Boolean(m))
      .map((m) => ({ id: m.id, label: m.name, group: "Recommended", detail: gatewayDetail(m) }));
    const apiModels = gateway.length
      ? [...recommended, ...gateway.map((m) => ({ id: m.id, label: m.name, group: vendorLabel(m.vendor), detail: gatewayDetail(m) }))]
      : ENRICHMENT_MODEL_CATALOG.filter((m) => m.provider === "gateway")
          .map((m) => ({ id: m.id, label: m.label, group: vendorLabel(m.id.slice(0, m.id.indexOf("/"))), detail: "" }));
    // CLI-mode choices: what the local CLIs accept. Superseded models keep their
    // own section so the four current ones are not buried among ten.
    const cliModels = CLI_MODEL_CATALOG.map((m) => ({
      id: m.id,
      label: m.label,
      group: `${m.cli === "claude" ? "Claude Code" : "Codex"}${m.legacy ? " · previous generations" : ""}`,
      detail: m.detail,
    }));
    return {
      ok: true,
      message: "",
      apiModels: withUniqueLabels(apiModels),
      cliModels: withUniqueLabels(cliModels),
      cliMode: config.provider === "cli-claude" || config.provider === "cli-codex",
      source: gateway.length ? "gateway" : "catalog",
    };
  } catch (error) { return { ok: false, message: message(error, "Could not load models.") }; }
}

/* Set a column's two models by table + key. Keyed rather than by id so it works
   uniformly for built-in, AI and email-QA columns - all three now carry their
   own model, and none of them should depend on a hidden default. */
export async function setColumnModelsAction(tableId: unknown, columnKey: unknown, models: unknown) {
  const access = await auth(); if (!access.ok) return access;
  const parsed = z.object({
    tableId: uuidSchema,
    columnKey: z.string().trim().min(1).max(60),
    models: z.object({
      model: z.string().trim().max(100).optional(),
      cliModel: z.string().trim().max(100).optional(),
      reasoningEffort: z.string().trim().max(10).optional(),
    }).strict(),
  }).strict().safeParse({ tableId, columnKey, models });
  if (!parsed.success) return { ok: false, message: "Invalid model selection." };
  const apiError = unsupportedModelMessage(parsed.data.models.model || undefined);
  if (apiError) return { ok: false, message: apiError };
  const cliError = unsupportedCliModelMessage(parsed.data.models.cliModel);
  if (cliError) return { ok: false, message: cliError };
  try {
    const count = await setColumnModels(parsed.data.tableId, parsed.data.columnKey, parsed.data.models);
    if (count === 0) return { ok: false, message: `No column "${parsed.data.columnKey}" on this list.` };
    return { ok: true, message: "Model updated." };
  } catch (error) { return { ok: false, message: message(error, "Could not update the model.") }; }
}

export async function getEnrichmentSettingsAction() {
  const access = await auth(); if (!access.ok) return access;
  try {
    const [config, prompts, status] = await Promise.all([getEnrichmentRunnerConfig(), getPersonalizationPromptConfig(), getSecretStatus()]);
    const keyStatus = {
      anthropic: status.enrichment_anthropic_api_key || Boolean(process.env.ANTHROPIC_API_KEY),
      openai: status.openai_api_key || Boolean(process.env.OPENAI_API_KEY),
      gateway: status.ai_gateway_api_key || Boolean(process.env.AI_GATEWAY_API_KEY),
    };
    return { ok: true, message: "", config: clientCompatibleRunnerConfig(config), prompts, catalog: ENRICHMENT_MODEL_CATALOG, keyStatus, anthropicKeyConfigured: keyStatus.anthropic };
  } catch (error) { return { ok: false, message: message(error, "Could not load prospect settings.") }; }
}
const runnerProviderSchema = z.enum(["anthropic-api", "openai-api", "gateway", "cli-claude", "cli-codex"]);
const RUNNER_PROVIDER_LABELS: Record<z.infer<typeof runnerProviderSchema>, string> = {
  "anthropic-api": "Anthropic API",
  "openai-api": "OpenAI API",
  gateway: "AI Gateway",
  "cli-claude": "Claude CLI",
  "cli-codex": "Codex CLI",
};
/* Quick provider switch for the header toggle: swaps ONLY the provider field
   and persists through the same validated save path as the settings dialog
   (which stays the detailed editor for models and concurrency). */
export async function setEnrichmentRunnerProviderAction(provider: unknown) {
  const access = await auth(); if (!access.ok) return access;
  const parsed = runnerProviderSchema.safeParse(provider); if (!parsed.success) return { ok: false, message: "Invalid runner provider." };
  try {
    const current = await getEnrichmentRunnerConfig();
    const config = await saveEnrichmentRunnerConfig({ ...current, provider: parsed.data }, access.profile.id);
    return { ok: true, message: `Runner switched to ${RUNNER_PROVIDER_LABELS[config.provider]}.`, config };
  } catch (error) { return { ok: false, message: message(error, "Could not switch the runner.") }; }
}
/* Quick model switch for the table header's picker: writes the ACTIVE API
   provider's model field through the same validated save path (its catalog
   check rejects unknown ids). CLI models stay a settings-dialog concern. */
export async function setEnrichmentRunnerModelAction(model: unknown) {
  const access = await auth(); if (!access.ok) return access;
  const parsed = z.string().trim().min(1).max(100).safeParse(model); if (!parsed.success) return { ok: false, message: "Invalid model." };
  try {
    const current = await getEnrichmentRunnerConfig();
    if (current.provider !== "anthropic-api" && current.provider !== "openai-api" && current.provider !== "gateway") {
      return { ok: false, message: "Switch to an API provider to pick its model here." };
    }
    const patch = current.provider === "gateway"
      ? { gatewayModel: parsed.data }
      : current.provider === "openai-api"
        ? { openaiModel: parsed.data }
        : { apiModel: parsed.data };
    const config = await saveEnrichmentRunnerConfig({ ...current, ...patch }, access.profile.id);
    return { ok: true, message: "Model updated.", config };
  } catch (error) { return { ok: false, message: message(error, "Could not change the model.") }; }
}
export async function saveEnrichmentSettingsAction(input: unknown) {
  const access = await auth(); if (!access.ok) return access;
  const parsed = z.object({ config: z.unknown(), prompts: z.unknown().optional() }).strict().safeParse(input); if (!parsed.success) return { ok: false, message: "Invalid prospect settings." };
  try {
    const config = await saveEnrichmentRunnerConfig(parsed.data.config, access.profile.id);
    const prompts = parsed.data.prompts === undefined ? await getPersonalizationPromptConfig() : await savePersonalizationPromptConfig(parsed.data.prompts, access.profile.id);
    return { ok: true, message: "Prospect settings saved.", config: clientCompatibleRunnerConfig(config), prompts };
  } catch (error) { return { ok: false, message: message(error, "Could not save prospect settings.") }; }
}
export async function getLeadDetailAction(leadId: unknown) {
  const access = await auth(); if (!access.ok) return access;
  const parsed = uuidSchema.safeParse(leadId); if (!parsed.success) return { ok: false, message: "Invalid lead id." };
  try { const lead = await getLeadById(parsed.data); return lead ? { ok: true, message: "", lead } : { ok: false, message: "Lead not found." }; } catch (error) { return { ok: false, message: message(error, "Could not load lead detail.") }; }
}
