import "server-only";
import { z } from "zod";
import { getAdminClient } from "@/lib/supabase/admin";
import type { CanonicalFilter } from "@/lib/enrichment/workspace";
import {
  RUNNABLE_ACTIONS,
  normalizeEnrichmentLead,
  type Coworker,
  type EnrichmentLead,
  type EnrichmentView,
  type FilterOptions,
  type LeadRunEntry,
  type LeadsPageResult,
  type RunCandidate,
  type RunnableAction,
  type RunMode,
  type SegmentStats,
  type Suppression,
  type SuppressionKind,
  type WritebackOutcome,
} from "@/lib/enrichment/types";

const LEAD_COLUMNS = [
  "id",
  "company_id",
  "role_level",
  "first_name",
  "last_name",
  "title",
  "email",
  "email_status",
  "final_first_name",
  "final_title",
  "final_company_name",
  "operations_task",
  "ops_candidate",
  "personalization_updated_at",
  "smartlead_campaign_id",
  "smartlead_campaign_name",
  "smartlead_export_status",
  "smartlead_exported_at",
  "smartlead_export_error",
  "smartlead_lead_id",
  "linkedin_url",
  "company",
  "domain",
  "send_wave",
  "shared_company",
  "linkedin_employment_status",
  "linkedin_current_company",
  "linkedin_profile",
  "linkedin_checked_at",
  "raw",
  "updated_at",
].join(", ");

const rpcLeadSchema = z
  .object({
    id: z.string().uuid(),
    updated_at: z.string().min(1),
    total_count: z.union([z.number(), z.string()]).optional(),
    run_action: z.enum(RUNNABLE_ACTIONS).optional(),
  })
  .passthrough();

const statsRowSchema = z.object({
  total_leads: z.number(),
  companies: z.number(),
  managers: z.number(),
  directors: z.number(),
  wave_1: z.number(),
  wave_2: z.number(),
  shared_company: z.number(),
  known_email: z.number(),
  missing_email: z.number(),
  pending_validation: z.number(),
  deliverable: z.number(),
  risky: z.number(),
  invalid: z.number(),
  catch_all: z.number(),
});

const filterOptionsRowSchema = z.object({
  role_levels: z.array(z.string()),
  email_statuses: z.array(z.string()),
  countries: z.array(z.string()),
});

const suppressionRowSchema = z.object({
  id: z.string().uuid(),
  kind: z.enum(["email", "domain"]),
  value: z.string(),
  reason: z.string().nullable(),
  created_at: z.string(),
});

const runRowSchema = z.object({
  id: z.string().uuid(),
  lead_id: z.string().uuid().nullable(),
  action: z.string(),
  provider: z.string().nullable(),
  ok: z.boolean(),
  message: z.string().nullable(),
  details: z.unknown(),
  created_at: z.string(),
});

const viewRowSchema = z.object({
  id: z.string().uuid(),
  table_id: z.string(),
  name: z.string(),
  profile_id: z.string().uuid().nullable(),
  config: z.record(z.string(), z.unknown()),
  created_at: z.string(),
  updated_at: z.string(),
});

const writebackOutcomeSchema = z.enum(["written", "stale", "duplicate", "not_found"]);

function assertNoError(error: { message: string } | null, context: string) {
  if (error) throw new Error(`${context}: ${error.message}`);
}

function normalizeDirectLead(row: Record<string, unknown>): EnrichmentLead {
  const raw = row.raw && typeof row.raw === "object" && !Array.isArray(row.raw)
    ? (row.raw as Record<string, unknown>)
    : {};
  const countryValue = raw["Lead Country"];
  const cityValue = raw["Lead City"];
  const stateValue = raw["Lead State"];
  const clean = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim() : null);

  return normalizeEnrichmentLead({
    ...row,
    lead_city: clean(cityValue),
    lead_state: clean(stateValue),
    lead_country: clean(countryValue),
    suppression_reason: null,
  });
}

function normalizeSuppression(row: unknown): Suppression {
  const parsed = suppressionRowSchema.parse(row);
  return {
    id: parsed.id,
    kind: parsed.kind,
    value: parsed.value,
    reason: parsed.reason,
    createdAt: parsed.created_at,
  };
}

function normalizeRunEntry(row: unknown): LeadRunEntry {
  const parsed = runRowSchema.parse(row);
  return {
    id: parsed.id,
    leadId: parsed.lead_id,
    action: parsed.action,
    provider: parsed.provider,
    ok: parsed.ok,
    message: parsed.message,
    details: parsed.details,
    createdAt: parsed.created_at,
  };
}

function normalizeView(row: unknown): EnrichmentView {
  const parsed = viewRowSchema.parse(row);
  return {
    id: parsed.id,
    tableId: parsed.table_id,
    name: parsed.name,
    profileId: parsed.profile_id,
    config: parsed.config,
    createdAt: parsed.created_at,
    updatedAt: parsed.updated_at,
  };
}

export type LeadsPageParams = {
  limit?: number;
  offset?: number;
  search?: string | null;
  roleLevels?: string[];
  emailStatuses?: string[];
  countries?: string[];
  hasEmail?: boolean | null;
  qualifiedOnly?: boolean;
  // Restrict to specific lead ids (autorun waterfall run-state fetch).
  leadIds?: string[];
  sort?:
    | "contact"
    | "company"
    | "qualification"
    | "email"
    | "validate_email"
    | "email_status"
    | "final_first_name"
    | "final_title"
    | "final_company_name"
    | "operations_task"
    | "ops_candidate"
    | "smartlead_export"
    | null;
  sortDir?: "asc" | "desc";
  tableId?: string;
  canonical?: CanonicalFilter;
  // Run-state filter: a custom column's cell state, or leads that errored in a run.
  cellColumnId?: string | null;
  cellState?: "not_run" | "done" | "outdated" | null;
  cellGeneration?: number | null;
  erroredJobId?: string | null;
  queuedJobId?: string | null;
};

const IMPOSSIBLE_FILTER = "__none__";

function mergeArrays(user: string[] | undefined, canonical: string[] | undefined) {
  const left = user?.length ? user : undefined;
  const right = canonical?.length ? canonical : undefined;
  if (!left) return right ?? [];
  if (!right) return left;
  const allowed = new Set(right);
  const intersection = left.filter((value) => allowed.has(value));
  return intersection.length ? intersection : [IMPOSSIBLE_FILTER];
}

function mergedFilters(params: LeadsPageParams) {
  const canonical = params.canonical ?? {};
  let impossible = false;
  let hasEmail = params.hasEmail ?? null;
  if (canonical.hasEmail !== undefined) {
    if (hasEmail !== null && hasEmail !== canonical.hasEmail) impossible = true;
    else hasEmail = canonical.hasEmail;
  }
  // qualifiedOnly NARROWS, so intersection semantics demand OR: the canonical
  // constraint can never be relaxed by a user toggle.
  const qualifiedOnly = (canonical.qualifiedOnly ?? false) || (params.qualifiedOnly ?? false);
  const roleLevels = mergeArrays(params.roleLevels, canonical.roleLevels);
  return {
    roleLevels: impossible ? [IMPOSSIBLE_FILTER] : roleLevels,
    emailStatuses: mergeArrays(params.emailStatuses, canonical.emailStatuses),
    countries: mergeArrays(params.countries, canonical.countries),
    hasEmail,
    qualifiedOnly,
  };
}

export async function getLeadsPage(params: LeadsPageParams = {}): Promise<LeadsPageResult> {
  const filters = mergedFilters(params);
  const { data, error } = await getAdminClient().rpc("enrichment_leads_page", {
    p_limit: Math.max(1, Math.min(params.limit ?? 100, 500)),
    p_offset: Math.max(0, params.offset ?? 0),
    p_search: params.search?.trim() || null,
    p_role_levels: filters.roleLevels,
    p_email_statuses: filters.emailStatuses,
    p_countries: filters.countries,
    p_has_email: filters.hasEmail,
    p_qualified_only: filters.qualifiedOnly,
    p_sort: params.sort ?? null,
    p_sort_dir: params.sortDir ?? "asc",
    p_table_id: params.tableId ?? null,
    p_min_contacts: params.canonical?.minContacts ?? null,
    p_exclude_company_role: params.canonical?.excludeCompanyRole ?? null,
    p_require_send_wave: params.canonical?.requireSendWave ?? null,
    p_lead_ids: params.leadIds && params.leadIds.length > 0 ? params.leadIds : null,
    p_cell_column_id: params.cellColumnId ?? null,
    p_cell_state: params.cellState ?? null,
    p_cell_generation: params.cellGeneration ?? null,
    p_errored_job_id: params.erroredJobId ?? null,
    p_queued_job_id: params.queuedJobId ?? null,
  });
  assertNoError(error, "Enrichment leads page");

  const parsed = z.array(rpcLeadSchema).parse(data ?? []);
  return {
    rows: parsed.map((row) => normalizeEnrichmentLead(row)),
    totalCount: Number(parsed[0]?.total_count ?? 0),
  };
}

export async function getRunCandidates(
  action: RunnableAction,
  // 'count' is a durable-job-only mode (positional slice); this legacy RPC path
  // only supports the original four, so keep it out of the contract.
  mode: Exclude<RunMode, "count">,
  limit = 5000,
  promptUpdatedAt: string | null = null,
  tableId: string | null = null,
  canonical: CanonicalFilter = {},
): Promise<RunCandidate[]> {
  // "outdated" means the column's prompt changed after the last successful
  // run; without a prompt timestamp the RPC returns zero rows by design.
  const filters = mergedFilters({ canonical });
  const { data, error } = await getAdminClient().rpc("enrichment_run_candidates", {
    p_action: action,
    p_mode: mode,
    p_limit: Math.max(1, Math.min(limit, mode === "test10" ? 10 : 5000)),
    p_prompt_updated_at: promptUpdatedAt,
    p_role_levels: filters.roleLevels,
    p_email_statuses: filters.emailStatuses,
    p_countries: filters.countries,
    p_has_email: filters.hasEmail,
    p_qualified_only: filters.qualifiedOnly,
    p_table_id: tableId,
    p_min_contacts: canonical.minContacts ?? null,
    p_exclude_company_role: canonical.excludeCompanyRole ?? null,
    p_require_send_wave: canonical.requireSendWave ?? null,
  });
  assertNoError(error, "Enrichment run candidates");

  return z.array(rpcLeadSchema).parse(data ?? []).map((row) => ({
    ...normalizeEnrichmentLead(row),
    runAction: z.enum(RUNNABLE_ACTIONS).parse(row.run_action),
  }));
}

/* Email-health counts for one list, or for every lead when no canonical filter
   is given (the Enrichment home page, which IS workspace-wide).

   The filter is the same one enrichment_leads_page takes, so the totals equal
   what the grid reports for that list. Called without it this returns exactly
   what it always did - the RPC's parameters all default to the old behaviour. */
export async function getSegmentStats(canonical?: CanonicalFilter): Promise<SegmentStats> {
  const { data, error } = await getAdminClient().rpc(
    "enrichment_segment_stats",
    canonical
      ? {
          p_role_levels: canonical.roleLevels ?? [],
          p_email_statuses: canonical.emailStatuses ?? [],
          p_countries: canonical.countries ?? [],
          p_has_email: canonical.hasEmail ?? null,
          p_qualified_only: canonical.qualifiedOnly ?? false,
          p_min_contacts: canonical.minContacts ?? null,
          p_exclude_company_role: canonical.excludeCompanyRole ?? null,
          p_require_send_wave: canonical.requireSendWave ?? null,
        }
      : undefined,
  );
  assertNoError(error, "Enrichment segment stats");
  const row = statsRowSchema.parse((data ?? [])[0]);

  return {
    totalLeads: row.total_leads,
    companies: row.companies,
    managers: row.managers,
    directors: row.directors,
    wave1: row.wave_1,
    wave2: row.wave_2,
    sharedCompany: row.shared_company,
    knownEmail: row.known_email,
    missingEmail: row.missing_email,
    pendingValidation: row.pending_validation,
    deliverable: row.deliverable,
    risky: row.risky,
    invalid: row.invalid,
    catchAll: row.catch_all,
  };
}

export async function getFilterOptions(): Promise<FilterOptions> {
  const { data, error } = await getAdminClient().rpc("enrichment_filter_options");
  assertNoError(error, "Enrichment filter options");
  const row = filterOptionsRowSchema.parse((data ?? [])[0]);
  return {
    roleLevels: row.role_levels,
    emailStatuses: row.email_statuses,
    countries: row.countries,
  };
}

export async function getCoworker(leadId: string): Promise<Coworker | null> {
  const { data, error } = await getAdminClient().rpc("enrichment_coworker", {
    p_lead_id: leadId,
  });
  assertNoError(error, "Enrichment coworker");
  const row = z
    .object({ first_name: z.string(), role_level: z.string().nullable() })
    .nullable()
    .parse((data ?? [])[0] ?? null);
  return row ? { firstName: row.first_name, roleLevel: row.role_level } : null;
}

export async function commitWriteback(input: {
  leadId: string;
  column:
    | "final_first_name"
    | "final_title"
    | "final_company_name"
    | "operations_task"
    | "ops_candidate"
    | "email"
    | "email_status";
  value: string | null;
  expectedUpdatedAt: string;
  runId: string;
  provider: string | null;
  message: string | null;
  details?: Record<string, unknown>;
}): Promise<WritebackOutcome> {
  const { data, error } = await getAdminClient().rpc("enrichment_commit_writeback", {
    p_lead_id: input.leadId,
    p_column: input.column,
    p_value: input.value,
    p_expected_updated_at: input.expectedUpdatedAt,
    p_run_id: input.runId,
    p_provider: input.provider,
    p_message: input.message,
    p_details: input.details ?? {},
  });
  assertNoError(error, "Enrichment writeback");
  return writebackOutcomeSchema.parse(data);
}

export async function getLeadById(id: string): Promise<EnrichmentLead | null> {
  const { data, error } = await getAdminClient()
    .from("leads")
    .select(LEAD_COLUMNS)
    .eq("id", id)
    .maybeSingle();
  assertNoError(error, "Enrichment lead lookup");
  if (!data) return null;

  const lead = normalizeDirectLead(data as unknown as Record<string, unknown>);
  const matches = await Promise.all(
    ([
      ["email", lead.email],
      ["domain", lead.domain],
    ] as const).map(async ([kind, value]) => {
      if (!value?.trim()) return null;
      const result = await getAdminClient()
        .from("suppressions")
        .select("reason")
        .eq("kind", kind)
        .eq("value", value.trim().toLowerCase())
        .limit(1)
        .maybeSingle();
      assertNoError(result.error, "Enrichment suppression lookup");
      return result.data
        ? ((result.data.reason as string | null)?.trim() || `Suppressed (${kind})`)
        : null;
    }),
  );

  return { ...lead, suppressionReason: matches.find(Boolean) ?? null };
}

export async function listSuppressions(): Promise<Suppression[]> {
  const { data, error } = await getAdminClient()
    .from("suppressions")
    .select("id, kind, value, reason, created_at")
    .order("created_at", { ascending: false })
    .limit(1000);
  assertNoError(error, "Enrichment suppressions list");
  return (data ?? []).map(normalizeSuppression);
}

export async function addSuppression(
  kind: SuppressionKind,
  value: string,
  reason?: string | null,
): Promise<Suppression> {
  const cleanValue = value.trim().toLowerCase();
  if (!cleanValue) throw new Error("Suppression value is required.");
  if (kind === "email" && !cleanValue.includes("@")) {
    throw new Error("Email suppressions must be an email address.");
  }
  if (kind === "domain" && (cleanValue.includes("@") || !cleanValue.includes("."))) {
    throw new Error("Domain suppressions must be a bare domain like acme.com.");
  }

  const { data, error } = await getAdminClient()
    .from("suppressions")
    .upsert(
      { kind, value: cleanValue, reason: reason?.trim() || null },
      { onConflict: "kind,value" },
    )
    .select("id, kind, value, reason, created_at")
    .single();
  assertNoError(error, "Enrichment suppression upsert");
  return normalizeSuppression(data);
}

export async function removeSuppression(kind: SuppressionKind, value: string): Promise<void> {
  const { error } = await getAdminClient()
    .from("suppressions")
    .delete()
    .eq("kind", kind)
    .eq("value", value.trim().toLowerCase());
  assertNoError(error, "Enrichment suppression removal");
}

export async function getLeadRunHistory(leadId: string): Promise<LeadRunEntry[]> {
  const { data, error } = await getAdminClient()
    .from("lead_runs")
    .select("id, lead_id, action, provider, ok, message, details, created_at")
    .eq("lead_id", leadId)
    .order("created_at", { ascending: false })
    .limit(50);
  assertNoError(error, "Enrichment run history");
  return (data ?? []).map(normalizeRunEntry);
}

export async function listEnrichmentViews(tableId: string): Promise<EnrichmentView[]> {
  const { data, error } = await getAdminClient()
    .from("enrichment_views")
    .select("id, table_id, name, profile_id, config, created_at, updated_at")
    .eq("table_id", tableId)
    .order("created_at", { ascending: true });
  assertNoError(error, "Enrichment views list");
  return (data ?? []).map(normalizeView);
}

export async function upsertEnrichmentView(input: {
  tableId: string;
  name: string;
  profileId?: string | null;
  config: Record<string, unknown>;
}): Promise<EnrichmentView> {
  const name = input.name.trim();
  if (!name) throw new Error("View name is required.");

  const { data, error } = await getAdminClient()
    .from("enrichment_views")
    .upsert(
      {
        table_id: input.tableId,
        name,
        profile_id: input.profileId ?? null,
        config: input.config,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "table_id,name" },
    )
    .select("id, table_id, name, profile_id, config, created_at, updated_at")
    .single();
  assertNoError(error, "Enrichment view upsert");
  return normalizeView(data);
}

export async function deleteEnrichmentView(id: string, tableId: string): Promise<void> {
  const { error } = await getAdminClient().from("enrichment_views").delete().eq("id", id).eq("table_id", tableId);
  assertNoError(error, "Enrichment view deletion");
}
