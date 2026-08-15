// Framework-neutral autorun-chain logic, shared by the client worktable model
// (enrichment-model.ts, "use client") and the server run-job orchestrator
// (orchestrator.ts). Neither may import the other's module across the
// client/server boundary, so the pipeline order, per-step eligibility, the
// provider mapping, and staleness live here once and both sides import them.
//
// Functions are typed against minimal structural shapes (ChainLead/ChainColumn)
// so both the client and server EnrichmentLead/CustomColumn types satisfy them
// without either side importing the other's declarations.

import type { RunnableAction } from "@/lib/enrichment/types";

// Only the fields the chain reads. Both EnrichmentLead mirrors are a superset.
export type ChainLead = {
  email: string | null;
  emailStatus: string | null;
  firstName: string | null;
  lastName: string | null;
  domain: string | null;
  finalFirstName: string | null;
  finalTitle: string | null;
  finalCompanyName: string | null;
  operationsTask: string | null;
  opsCandidate: string | null;
  linkedinEmploymentStatus: string | null;
  suppressionReason: string | null;
  tableExportStatus: string | null;
  customCells: Record<string, string | null>;
  customCellGens: Record<string, number>;
};

export type ChainColumn = { key: string; generationVersion: number };

/* A custom cell is stale when it has a value but was generated before the
   column's current generation (its prompt/examples changed since). Stale cells
   keep their value but the autorun treats them as not-run so they regenerate. */
export function isCellStale(lead: ChainLead, column: ChainColumn): boolean {
  const value = lead.customCells?.[column.key];
  if (value == null || value === "") return false;
  const gen = lead.customCellGens?.[column.key];
  return typeof gen === "number" && gen < column.generationVersion;
}

/* ── Autorun waterfall ─────────────────────────────────────────────────────
   When Autorun is on, running one cell chains the remaining eligible steps for
   that row, in this pipeline order, until the final step (export). */
export const AUTORUN_ORDER: readonly RunnableAction[] = [
  "linkedin_verify",
  "find_email",
  "validate_email",
  "final_first_name",
  "final_title",
  "final_company_name",
  "operations_task",
  "ops_candidate",
  "smartlead_export",
];

// Built-in column key -> its run action. Mirrors TABLE_COLUMNS[].runAction in
// enrichment-model.ts. The only key that differs from its action is "linkedin".
export const BUILTIN_RUN_ACTION: Record<string, RunnableAction> = {
  linkedin: "linkedin_verify",
  validate_email: "validate_email",
  find_email: "find_email",
  final_first_name: "final_first_name",
  final_title: "final_title",
  final_company_name: "final_company_name",
  operations_task: "operations_task",
  ops_candidate: "ops_candidate",
  smartlead_export: "smartlead_export",
};

const PERSONALIZATION_FIELD = {
  final_first_name: "finalFirstName",
  final_title: "finalTitle",
  final_company_name: "finalCompanyName",
  operations_task: "operationsTask",
  ops_candidate: "opsCandidate",
} as const satisfies Record<string, keyof ChainLead>;

// The ChainLead field a built-in personalization action writes, or null for
// non-personalization built-ins (linkedin/find/validate/export). Used to detect
// a filled-but-stale built-in cell for "outdated" runs.
export function personalizationField(action: RunnableAction): keyof ChainLead | null {
  return (PERSONALIZATION_FIELD as Record<string, keyof ChainLead>)[action] ?? null;
}

/* Whether a downstream step should auto-run for a row given its current state.
   Mirrors each cell's manual-run guards and the server candidate rules, so the
   waterfall only runs steps that would actually do something. A confirmed
   LinkedIn departure halts the whole chain. */
export function autorunEligible(action: RunnableAction, lead: ChainLead, hasCampaignTag: boolean): boolean {
  if (lead.linkedinEmploymentStatus === "not_working") return false;
  // A "no" from the title check halts the whole chain: not a fit, don't spend
  // LinkedIn/email/LLM steps on it.
  if ((lead.customCells?.title_fit ?? "").trim().toLowerCase() === "no") return false;
  switch (action) {
    case "linkedin_verify":
      // Only ever the manual starting step (LinkedIn/Apify costs money); never
      // auto-triggered from an earlier cell.
      return false;
    case "find_email":
      return (!lead.email || lead.emailStatus === "invalid") && Boolean(lead.firstName && lead.lastName && lead.domain);
    case "validate_email":
      return Boolean(lead.email) && lead.emailStatus == null;
    case "final_first_name":
    case "final_title":
    case "final_company_name":
    case "operations_task":
    case "ops_candidate":
      return lead.emailStatus === "deliverable" && !lead[PERSONALIZATION_FIELD[action]];
    case "smartlead_export":
      return (
        lead.emailStatus === "deliverable" &&
        Boolean(lead.finalFirstName && lead.finalTitle && lead.finalCompanyName && lead.operationsTask && lead.opsCandidate) &&
        hasCampaignTag &&
        lead.tableExportStatus !== "exported" &&
        !lead.suppressionReason
      );
    default:
      return false;
  }
}

/* Provider classes drive bulk concurrency (mirrors the runner-config keys). */
export type ProviderClass = "llm" | "smartlead" | "leadmagic" | "zerobounce" | "apify";

export const ACTION_PROVIDER: Record<RunnableAction, ProviderClass> = {
  linkedin_verify: "apify",
  find_email: "leadmagic",
  validate_email: "zerobounce",
  final_first_name: "llm",
  final_title: "llm",
  final_company_name: "llm",
  operations_task: "llm",
  ops_candidate: "llm",
  smartlead_export: "smartlead",
};
