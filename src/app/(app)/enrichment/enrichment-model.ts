"use client";

/* Contract mirrors, column model, and style constants for the Enrichment
   worktable. Types are declared locally so the client never imports a server
   module - the same pattern inboxes-client and campaigns-client follow. The
   shapes mirror src/lib/enrichment/types.ts exactly. */

export type EnrichmentLead = {
  id: string;
  companyId: string | null;
  roleLevel: string | null;
  firstName: string | null;
  lastName: string | null;
  title: string | null;
  email: string | null;
  emailStatus: string | null;
  finalFirstName: string | null;
  finalTitle: string | null;
  finalCompanyName: string | null;
  operationsTask: string | null;
  opsCandidate: string | null;
  personalizationUpdatedAt: string | null;
  smartleadCampaignId: string | null;
  smartleadCampaignName: string | null;
  smartleadExportStatus: string | null;
  smartleadExportedAt: string | null;
  smartleadExportError: string | null;
  tableExportStatus: string | null;
  tableExportedAt: string | null;
  tableExportError: string | null;
  smartleadLeadId: string | null;
  linkedinUrl: string | null;
  company: string | null;
  domain: string | null;
  sendWave: number | null;
  sharedCompany: boolean | null;
  leadCity: string | null;
  leadState: string | null;
  leadCountry: string | null;
  suppressionReason: string | null;
  linkedinEmploymentStatus: string | null;
  linkedinCurrentCompany: string | null;
  linkedinCheckedAt: string | null;
  linkedinProfile: unknown;
  companySummary: unknown;
  customCells: Record<string, string | null>;
  customCellGens: Record<string, number>;
  updatedAt: string;
};

// Chain logic (staleness, autorun order/eligibility, provider mapping) is shared
// with the server orchestrator; import locally and re-export so client callers
// keep importing it from this model module.
import {
  isCellStale, autorunEligible, AUTORUN_ORDER, ACTION_PROVIDER, BUILTIN_RUN_ACTION, type ProviderClass,
} from "@/lib/enrichment/chain";
export { isCellStale, autorunEligible, AUTORUN_ORDER, ACTION_PROVIDER, BUILTIN_RUN_ACTION };
export type { ProviderClass };

/* ── Per-table custom AI columns (v2 layout) ─────────────────────────────
   Client mirror of src/lib/enrichment/custom-columns.ts's CustomColumn; the
   server module is server-only, so the client cannot import its types. */
export type CustomColumnKind = "builtin" | "source" | "ai" | "email_qa";

export type CustomColumn = {
  id: string;
  tableId: string;
  key: string;
  label: string;
  kind: CustomColumnKind;
  prompt: string | null;
  model: string | null;
  // The CLI-mode model; `model` above is the API-mode one.
  cliModel: string | null;
  // API-mode reasoning tier ("low" | "medium" | "high"); null = off.
  reasoningEffort: string | null;
  sourceKeys: string[];
  sortOrder: number;
  visible: boolean;
  generationVersion: number;
  examples: string[];
  /* A pinned value the column returns instead of calling a model. Present in
     the payload all along (getTableColumns sends it verbatim); typed here now
     that the client has to tell "runs a prompt" from "returns a constant". */
  constantValue: string | null;
};

export type LayoutVersion = "v1" | "v2";

/* Email-review (QA) cell inspection payload, stored in the cell's details jsonb
   and shown in the click-to-inspect dialog. Mirrors the server shape in
   src/lib/enrichment/email-qa.ts. */
export type EmailQaEmail = { step: number; subject: string; body: string; unfilled: string[] };
export type EmailQaVariable = { name: string; value: string; filled: boolean };
export type EmailQaRepair = { name: string; from: string; to: string | null; accepted: boolean; reason: string; note: string };
export type EmailQaContext = {
  finalFirstName: string; firstNameRaw: string; finalCompanyName: string; companyRaw: string;
  title: string; roleLevel: string; companyWhatTheyMake: string; companyMarkets: string;
  companySummary: string; linkedinHeadline: string;
};
export type EmailQaDetails = {
  verdict: "ready" | "needs_review";
  reviewed?: boolean;
  campaignName?: string;
  emails: EmailQaEmail[];
  variables: EmailQaVariable[];
  context: EmailQaContext | null;
  issues: string[];
  repairs: EmailQaRepair[];
};

/* What the column editor's API-mode picker shows for the moment between opening
   and the gateway's live list arriving. Ids are in gateway "vendor/model" form
   because that is what an API-mode column stores; a bare id here would offer a
   value the save path then has to rewrite. The live list replaces this entirely
   (see getModelOptionsAction), so it only needs to cover the common picks. */
export const AI_MODEL_OPTIONS: { provider: "OpenAI" | "Anthropic"; id: string; label: string }[] = [
  { provider: "OpenAI", id: "openai/gpt-5.6-luna", label: "GPT 5.6 Luna" },
  { provider: "OpenAI", id: "openai/gpt-5.6-terra", label: "GPT 5.6 Terra" },
  { provider: "OpenAI", id: "openai/gpt-5.6-sol", label: "GPT 5.6 Sol" },
  { provider: "Anthropic", id: "anthropic/claude-haiku-4.5", label: "Claude Haiku 4.5" },
  { provider: "Anthropic", id: "anthropic/claude-sonnet-5", label: "Claude Sonnet 5" },
  { provider: "Anthropic", id: "anthropic/claude-opus-5", label: "Claude Opus 5" },
];

/* Built-in lead fields usable as {{variables}} in a custom column prompt, on top
   of every other column's key. Mirrors the lead-token map in
   buildVariableMap (custom-columns.ts); resolution is authoritative server-side. */
export const LEAD_VARIABLE_TOKENS: { key: string; label: string }[] = [
  { key: "first_name", label: "First name" },
  { key: "title", label: "Job title" },
  { key: "company", label: "Company" },
  { key: "role_level", label: "Role level" },
  { key: "company_summary", label: "Company research" },
  { key: "linkedin_experience", label: "LinkedIn experience" },
];

export type PromptVariable = { key: string; label: string; group: "Lead" | "Column" };

/* The {{variable}} options offered in the column editor: the other AI columns
   first (their output can feed this one), then the built-in lead fields. Only AI
   columns are offered as column variables; built-in grid columns (contact,
   qualification, linkedin, ...) are display constructs whose keys are not lead
   fields and would resolve to empty, so offering them would mislead. A lead token
   shadowed by a same-key AI column is dropped (the column wins on resolution). */
export function promptVariablesFor(columns: CustomColumn[], excludeColumnId: string | null): PromptVariable[] {
  // Reserved lead-token keys always resolve to the curated lead value, so an AI
  // column keyed the same is not offered (it can't be referenced by that key).
  const reserved = new Set(LEAD_VARIABLE_TOKENS.map((t) => t.key));
  const cols = columns
    .filter((c) => c.kind === "ai" && c.id !== excludeColumnId && c.key.trim().length > 0 && !reserved.has(c.key))
    .map((c) => ({ key: c.key, label: c.label, group: "Column" as const }));
  const lead = LEAD_VARIABLE_TOKENS.map((t) => ({ key: t.key, label: t.label, group: "Lead" as const }));
  return [...cols, ...lead];
}

export type SegmentStats = {
  totalLeads: number;
  companies: number;
  managers: number;
  directors: number;
  wave1: number;
  wave2: number;
  sharedCompany: number;
  knownEmail: number;
  missingEmail: number;
  pendingValidation: number;
  deliverable: number;
  // Separate buckets, matching the email-status filter's own values: a merged
  // "risky" count could not be reproduced by clicking it.
  risky: number;
  catchAll: number;
  invalid: number;
};

export type FilterOptions = {
  roleLevels: string[];
  emailStatuses: string[];
  countries: string[];
};

export type EnrichmentView = {
  id: string;
  tableId: string;
  name: string;
  profileId: string | null;
  config: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
};

export type SuppressionKind = "email" | "domain";

export type Suppression = {
  id: string;
  kind: SuppressionKind;
  value: string;
  reason: string | null;
  createdAt: string;
};

export type LeadRunEntry = {
  id: string;
  leadId: string | null;
  action: string;
  provider: string | null;
  ok: boolean;
  message: string | null;
  details: unknown;
  createdAt: string;
};

export type SmartleadCampaignOption = { id: string; name: string; status: string | null };

/* ── Workbook workspace mirrors (server shapes live in enrichment/workspace.ts) ── */

export type WorkbookRef = { id: string; slug: string; name: string };

/* One sheet tab: a sibling table in the active workbook. */
export type SheetTab = { id: string; slug: string; name: string; description: string };

/* A workbook option for the "Move to workbook" dialog. */
export type WorkbookOption = { id: string; slug: string; name: string };

export type CampaignTag = { id: string; name: string; source?: "table" | "workbook" | "folder" };

export type WritebackOutcome = "written" | "stale" | "duplicate" | "not_found";
export const WRITEBACK_OUTCOMES: readonly WritebackOutcome[] = ["written", "stale", "duplicate", "not_found"];

export const RUNNABLE_ACTIONS = [
  "linkedin_verify",
  "find_email",
  "validate_email",
  "final_first_name",
  "final_title",
  "final_company_name",
  "operations_task",
  "ops_candidate",
  "smartlead_export",
] as const;
export type RunnableAction = (typeof RUNNABLE_ACTIONS)[number];
export type RunMode = "test10" | "unrun" | "outdated" | "force" | "count";

export const PERSONALIZATION_ACTIONS = [
  "final_first_name",
  "final_title",
  "final_company_name",
  "operations_task",
  "ops_candidate",
] as const;
export type PersonalizationAction = (typeof PERSONALIZATION_ACTIONS)[number];

/* Columns whose output depends on an editable prompt - the only ones where the
   "outdated" bulk mode is meaningful (operations_task is a fixed campaign value). */
export const AI_PROMPT_COLUMNS = [
  "final_first_name",
  "final_title",
  "final_company_name",
  "ops_candidate",
] as const;
export type AiPromptColumn = (typeof AI_PROMPT_COLUMNS)[number];

export function isPersonalizationAction(action: RunnableAction): action is PersonalizationAction {
  return (PERSONALIZATION_ACTIONS as readonly string[]).includes(action);
}

export function isAiPromptColumn(action: RunnableAction): action is AiPromptColumn {
  return (AI_PROMPT_COLUMNS as readonly string[]).includes(action);
}

/* ── Model identity, sized for a column header ────────────────────────────

   A header has room for a word, not "openai/gpt-5.6-luna". Shorten to the part
   that actually tells one choice from another: inside the GPT-5.6 family that
   is the codename (Luna / Sol / Terra, which is how they are referred to
   everywhere), and for Claude it is the tier plus version. The full id stays in
   the tooltip, so nothing is lost - only the noise every row would repeat. */
export type ModelVendor = "openai" | "anthropic" | "google" | "xai" | "zai" | "other";

export function modelVendor(model: string): ModelVendor {
  const id = model.trim().toLowerCase();
  const slash = id.indexOf("/");
  const known: Record<string, ModelVendor> = { openai: "openai", anthropic: "anthropic", google: "google", xai: "xai", zai: "zai" };
  if (slash > 0) return known[id.slice(0, slash)] ?? "other";
  // CLI ids carry no vendor prefix, so read it off the family instead.
  if (/^claude/.test(id)) return "anthropic";
  if (/^(gpt|o\d|codex)/.test(id)) return "openai";
  if (/^gemini|^gemma/.test(id)) return "google";
  if (/^grok/.test(id)) return "xai";
  if (/^glm/.test(id)) return "zai";
  return "other";
}

export function shortModelName(model: string): string {
  const trimmed = model.trim();
  const bare = trimmed.includes("/") ? trimmed.slice(trimmed.indexOf("/") + 1) : trimmed;
  if (!bare) return "";
  const capitalize = (word: string) => word.charAt(0).toUpperCase() + word.slice(1);
  // GPT-5.6 Luna / Sol / Terra: the codename is the whole distinction.
  const codename = /^gpt-\d+(?:\.\d+)?-(luna|sol|terra)$/i.exec(bare);
  if (codename) return capitalize(codename[1].toLowerCase());
  // claude-sonnet-5, claude-haiku-4-5 (dashes) and claude-haiku-4.5 (the
  // gateway's spelling) all have to land on the same label.
  const claude = /^claude-([a-z]+)-([\d.-]+)$/i.exec(bare);
  if (claude) return `${capitalize(claude[1].toLowerCase())} ${claude[2].replace(/-/g, ".")}`;
  if (/^gpt-/i.test(bare)) return `GPT-${bare.slice(4).replace(/-/g, " ")}`;
  if (/^grok-/i.test(bare)) return `Grok ${bare.slice(5).replace(/-/g, " ")}`;
  if (/^glm-/i.test(bare)) return `GLM ${bare.slice(4).replace(/-/g, " ")}`;
  if (/^gemini-/i.test(bare)) return `Gemini ${bare.slice(7).replace(/-/g, " ")}`;
  return bare;
}

// How a vendor is NAMED. How it is DRAWN lives in ../brand-marks (VendorMark),
// which holds the actual logomarks and is shared with Settings.
export const MODEL_VENDOR_LABEL: Record<ModelVendor, string> = {
  openai: "OpenAI",
  anthropic: "Anthropic",
  google: "Google",
  xai: "xAI",
  zai: "Z.ai",
  other: "",
};


export const ACTION_LABELS: Record<RunnableAction, string> = {
  linkedin_verify: "LinkedIn: At company?",
  find_email: "LeadMagic: Find Email",
  validate_email: "ZeroBounce: Validate Email",
  final_first_name: "Final first_name",
  final_title: "Final title",
  final_company_name: "Final company_name",
  operations_task: "Operations task",
  ops_candidate: "Ops candidate",
  smartlead_export: "Smartlead: Export",
};

export const RUN_MODE_LABELS: Record<RunMode, string> = {
  test10: "Test on 10 rows",
  unrun: "Run rows without results or with errors",
  outdated: "Run outdated cells (prompt changed)",
  force: "Force run all eligible rows",
  count: "Run a specific number of rows",
};

/* Mirror of the server runner + prompt settings (getEnrichmentSettingsAction). */
export type RunnerSettings = {
  config: {
    // Mode only. Which model runs is stored per column (its API choice and its
    // CLI choice), so nothing here can contradict what the table displays.
    provider: string;
    concurrency: Record<ProviderClass, number>;
  };
  prompts: {
    prompts: Record<AiPromptColumn, string>;
    examples?: Record<string, NormalizationExample[]>;
    updatedAt?: string;
    updatedAtByColumn: Record<string, string>;
    models: Record<string, string>;
  };
};

export type NormalizationExample = { original: string; normalized: string };

/* Mirror of the server prompt defaults, used only for the Reset button in the
   prompt editor (src/lib/enrichment/personalization.ts). */
export const DEFAULT_PROMPTS: Record<AiPromptColumn, string> = {
  final_first_name:
    "Normalize the lead's first name for a cold email. Return only a clean human first name with natural capitalization. Remove last names, initials, honorifics, punctuation, and placeholders. Return an empty value if it cannot be trusted.",
  final_title:
    "Normalize the raw job title for the sentence I noticed you're {{title}}. Return a short, all-lowercase English noun phrase including a, an, or the. Remove seniority filler, locations, company names, and separator tails. Prefer natural shorthand. Return only the phrase.",
  final_company_name:
    "Normalize the company name as an employee would casually say it. Remove legal suffixes, trademark symbols, and noisy punctuation while keeping meaningful brand words. Return only the cleaned company name.",
  ops_candidate:
    'Select the same-company operations coworker\'s clean first name for the phrase thought it might be you or {{ops_candidate}}. If unavailable or untrustworthy, return "someone on your ops team". Return only the value.',
};

/* Slim per-cell result kept in state and persisted to sessionStorage. */
export type CellResult = {
  ok: boolean;
  message: string;
  outcome?: WritebackOutcome;
  fallback?: boolean;
};

/* ── Column model ─────────────────────────────────────────────────────── */

export type SortKey =
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
  | "smartlead_export";

export type SortState = { key: SortKey; dir: "asc" | "desc" } | null;

export type ColumnId =
  | "contact"
  | "company"
  | "qualification"
  | "email"
  | "linkedin"
  | "validate_email"
  | "email_status"
  | "find_email"
  | "final_first_name"
  | "final_title"
  | "final_company_name"
  | "operations_task"
  | "ops_candidate"
  | "smartlead_export"
  | "last_run";

export type ColumnDef = {
  id: ColumnId;
  label: string;
  width: number;
  minWidth: number;
  sortKey?: SortKey;
  runAction?: RunnableAction;
};

export const TABLE_COLUMNS: readonly ColumnDef[] = [
  { id: "contact", label: "Contact", width: 220, minWidth: 140, sortKey: "contact" },
  { id: "company", label: "Company", width: 200, minWidth: 120, sortKey: "company" },
  { id: "qualification", label: "Qualification", width: 140, minWidth: 110, sortKey: "qualification" },
  { id: "email", label: "Email", width: 210, minWidth: 160, sortKey: "email" },
  { id: "linkedin", label: "LinkedIn: At company?", width: 170, minWidth: 130, runAction: "linkedin_verify" },
  { id: "validate_email", label: "ZeroBounce: Validate Email", width: 190, minWidth: 150, sortKey: "validate_email", runAction: "validate_email" },
  { id: "email_status", label: "Email status", width: 130, minWidth: 100, sortKey: "email_status" },
  { id: "find_email", label: "LeadMagic: Find Email", width: 190, minWidth: 150, runAction: "find_email" },
  { id: "final_first_name", label: "Final first_name", width: 170, minWidth: 120, sortKey: "final_first_name", runAction: "final_first_name" },
  { id: "final_title", label: "Final title", width: 190, minWidth: 120, sortKey: "final_title", runAction: "final_title" },
  { id: "final_company_name", label: "Final company_name", width: 200, minWidth: 130, sortKey: "final_company_name", runAction: "final_company_name" },
  { id: "operations_task", label: "Operations task", width: 190, minWidth: 120, sortKey: "operations_task", runAction: "operations_task" },
  { id: "ops_candidate", label: "Ops candidate", width: 170, minWidth: 120, sortKey: "ops_candidate", runAction: "ops_candidate" },
  { id: "smartlead_export", label: "Smartlead: Export", width: 210, minWidth: 180, sortKey: "smartlead_export", runAction: "smartlead_export" },
  { id: "last_run", label: "Last row run", width: 220, minWidth: 170 },
];

export const DEFAULT_COLUMN_WIDTHS: Record<ColumnId, number> = Object.fromEntries(
  TABLE_COLUMNS.map((column) => [column.id, column.width]),
) as Record<ColumnId, number>;

export const PAGE_SIZE = 500;
export const ROW_HEIGHT_ESTIMATE = 58;
export const ROW_OVERSCAN = 8;

/* ── Browser storage (namespaced per table uuid) ──────────────────────── */

export type StorageKeys = {
  columnWidths: string;
  filters: string;
  runState: string;
};

export function makeStorageKeys(tableId: string): StorageKeys {
  const prefix = `enrichment:${tableId}:v1`;
  return {
    columnWidths: `${prefix}:column-widths`,
    filters: `${prefix}:filters`,
    runState: `${prefix}:run-state`,
  };
}

/* The pre-workbook table stored its state under a slug-based prefix. Copy
   those values into the uuid-namespaced keys once, only for the table that
   still carries the legacy slug, and only where the new key is absent (so a
   later visit never clobbers newer state). Idempotent by construction. */
const LEGACY_STORAGE_PREFIX = "enrichment:two-contact-leads:v1";

export function migrateLegacyStorage(keys: StorageKeys, tableSlug: string, workbookSlug: string): void {
  // Only the ORIGINAL seeded table may adopt the legacy prefix; a new table
  // that happens to reuse the slug in another workbook must start clean.
  if (workbookSlug !== "manufacturing-ops") return;
  if (tableSlug !== "two-contact-leads") return;
  try {
    const localPairs: [string, string][] = [
      [`${LEGACY_STORAGE_PREFIX}:column-widths`, keys.columnWidths],
      [`${LEGACY_STORAGE_PREFIX}:filters`, keys.filters],
    ];
    for (const [legacyKey, newKey] of localPairs) {
      if (window.localStorage.getItem(newKey) !== null) continue;
      const legacy = window.localStorage.getItem(legacyKey);
      if (legacy !== null) window.localStorage.setItem(newKey, legacy);
    }
    if (window.sessionStorage.getItem(keys.runState) === null) {
      const legacyRunState = window.sessionStorage.getItem(`${LEGACY_STORAGE_PREFIX}:run-state`);
      if (legacyRunState !== null) window.sessionStorage.setItem(keys.runState, legacyRunState);
    }
  } catch {
    // Storage blocked or full: skip migration; the table still works.
  }
}

/* ── Filters ──────────────────────────────────────────────────────────── */

export type HasEmailFilter = "all" | "has" | "missing";

// Run-state filter: not_run/done/outdated apply to the chosen custom column;
// errored means the lead failed in the most recent run job for the table;
// queued means the lead is still waiting or in flight in the current run job.
export type RunStateFilter = "all" | "not_run" | "done" | "outdated" | "errored" | "queued";

export type Filters = {
  search: string;
  roleLevel: string;
  emailStatus: string;
  country: string;
  hasEmail: HasEmailFilter;
  qualifiedOnly: boolean;
  runState: RunStateFilter;
  runStateColumnKey: string | null;
};

export const DEFAULT_FILTERS: Filters = {
  search: "",
  roleLevel: "all",
  emailStatus: "all",
  country: "all",
  hasEmail: "all",
  qualifiedOnly: false,
  runState: "all",
  runStateColumnKey: null,
};

/* Snapshot of the toolbar filters in the server's CanonicalFilter shape, for
   "Start from current filters" on a new table. Search and sort are session
   state, not part of a list's base filter, so they are not captured. */
export type CanonicalFilterConfig = {
  roleLevels?: string[];
  emailStatuses?: string[];
  countries?: string[];
  hasEmail?: boolean;
  qualifiedOnly?: boolean;
};

export function encodeCanonicalFilter(filters: Filters): CanonicalFilterConfig | undefined {
  const config: CanonicalFilterConfig = {};
  if (filters.roleLevel !== "all") config.roleLevels = [filters.roleLevel];
  if (filters.emailStatus !== "all") config.emailStatuses = [filters.emailStatus];
  if (filters.country !== "all") config.countries = [filters.country];
  if (filters.hasEmail !== "all") config.hasEmail = filters.hasEmail === "has";
  if (filters.qualifiedOnly) config.qualifiedOnly = true;
  return Object.keys(config).length > 0 ? config : undefined;
}

/* Saved-view / localStorage config shape (kept as plain JSON). */
export type ViewConfig = Filters & { sortKey: string; sortDir: string };

export function encodeViewConfig(filters: Filters, sort: SortState): ViewConfig {
  return { ...filters, sortKey: sort?.key ?? "", sortDir: sort?.dir ?? "" };
}

const SORT_KEYS: readonly SortKey[] = TABLE_COLUMNS.flatMap((column) => (column.sortKey ? [column.sortKey] : []));

export function decodeViewConfig(config: Record<string, unknown>): { filters: Filters; sort: SortState } {
  const str = (value: unknown, fallback: string) => (typeof value === "string" ? value : fallback);
  const hasEmail = config.hasEmail === "has" || config.hasEmail === "missing" ? config.hasEmail : "all";
  const sortKey = SORT_KEYS.find((key) => key === config.sortKey) ?? null;
  const sortDir = config.sortDir === "desc" ? "desc" : "asc";
  // not_run / done / outdated are pure cell state: they mean the same thing in a
  // new session, so they survive a refresh (filtering to "Not run" to line up a
  // bulk run should not evaporate when the page reloads). errored / queued point
  // at a specific run job id that only exists in the session that started it, so
  // those still fall back to "all" rather than restoring a filter that would
  // silently match nothing.
  const durableRunStates: RunStateFilter[] = ["not_run", "done", "outdated"];
  const runState = durableRunStates.find((state) => state === config.runState) ?? "all";
  const runStateColumnKey =
    runState !== "all" && typeof config.runStateColumnKey === "string" && config.runStateColumnKey
      ? config.runStateColumnKey
      : null;
  return {
    filters: {
      search: str(config.search, ""),
      roleLevel: str(config.roleLevel, "all"),
      emailStatus: str(config.emailStatus, "all"),
      country: str(config.country, "all"),
      hasEmail,
      qualifiedOnly: config.qualifiedOnly === true,
      runState,
      runStateColumnKey,
    },
    sort: sortKey ? { key: sortKey, dir: sortDir } : null,
  };
}

/* ── Presentation helpers ─────────────────────────────────────────────── */

export function leadName(lead: Pick<EnrichmentLead, "firstName" | "lastName" | "email">): string {
  return [lead.firstName, lead.lastName].filter(Boolean).join(" ") || lead.email || "Lead";
}

const COUNTRY_ABBREVIATIONS: Record<string, string> = {
  "United States": "US",
  "United Kingdom": "UK",
  Canada: "CA",
  Australia: "AU",
  "New Zealand": "NZ",
};

export function contactMeta(lead: EnrichmentLead): string {
  const role = lead.roleLevel && lead.roleLevel !== "unknown" ? lead.roleLevel : null;
  const wave = lead.sendWave != null ? `W${lead.sendWave}` : null;
  const country = lead.leadCountry ? COUNTRY_ABBREVIATIONS[lead.leadCountry] ?? lead.leadCountry : null;
  const location = [lead.leadCity, country].filter(Boolean).join(", ") || null;
  return [role, wave, location].filter(Boolean).join(" · ");
}

export function hasCampaignVariables(lead: EnrichmentLead): boolean {
  return Boolean(
    lead.finalFirstName && lead.finalTitle && lead.finalCompanyName && lead.operationsTask && lead.opsCandidate,
  );
}

export type PillTone = "success" | "warning" | "destructive" | "info" | "muted";

export type Qualification = { ready: boolean; label: string; detail: string; tone: PillTone };

/* Live campaign-fit summary reporting the FIRST blocker, adapted to the gates
   the host actions actually enforce (no Clay targeting-title heuristics here;
   the backend's qualifiedOnly filter owns qualification server-side). */
export function getQualification(lead: EnrichmentLead): Qualification {
  if (lead.suppressionReason) {
    return { ready: false, label: "Suppressed", detail: lead.suppressionReason, tone: "destructive" };
  }
  if (!lead.email) {
    return { ready: false, label: "No email", detail: "Run LeadMagic Find Email.", tone: "muted" };
  }
  if (lead.emailStatus === "invalid") {
    return { ready: false, label: "Email invalid", detail: "ZeroBounce marked this email invalid.", tone: "destructive" };
  }
  if (lead.emailStatus === "risky") {
    return { ready: false, label: "Email risky", detail: "ZeroBounce marked this email risky (catch-all).", tone: "warning" };
  }
  if (lead.emailStatus !== "deliverable") {
    return { ready: false, label: "Not validated", detail: "Run ZeroBounce validation.", tone: "muted" };
  }
  if (!hasCampaignVariables(lead)) {
    return {
      ready: false,
      label: "Vars missing",
      detail: "Run the personalization columns to fill the campaign variables.",
      tone: "info",
    };
  }
  return { ready: true, label: "Ready", detail: "Passes every campaign gate.", tone: "success" };
}

/* v2 "company_summary" source column: reads the same companies.company_summary
   jsonb the custom-column runner exposes as the {{company_summary}} variable
   (src/lib/enrichment/custom-columns.ts). Client-side, un-trusted shape, so every
   field is optional. */
export type CompanySummary = { whatTheyMake: string; markets: string; summary: string };

export function readCompanySummary(value: unknown): CompanySummary | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
  const whatTheyMake = str(record.what_they_make);
  const markets = str(record.markets);
  const summary = str(record.summary);
  if (!whatTheyMake && !markets && !summary) return null;
  return { whatTheyMake, markets, summary };
}

export function emailStatusTone(status: string | null): PillTone {
  if (status === "deliverable") return "success";
  if (status === "catch_all") return "warning";
  if (status === "risky") return "warning";
  if (status === "invalid") return "destructive";
  return "muted";
}

// ZeroBounce statuses render with a friendly label; "catch_all" reads "catch-all".
export function emailStatusLabel(status: string | null): string {
  if (!status) return "not run";
  return status === "catch_all" ? "catch-all" : status;
}

/* The LinkedIn employment check renders as a plain-language pill; "Unsure" and
   "not run" never block downstream steps (only a confirmed "Left" does). */
export function linkedinStatusPill(status: string | null): { tone: PillTone; label: string } {
  switch (status) {
    case "working": return { tone: "success", label: "At company" };
    case "not_working": return { tone: "destructive", label: "Left company" };
    case "uncertain": return { tone: "warning", label: "Unsure" };
    default: return { tone: "muted", label: "not run" };
  }
}

export const PILL_TONE_CLASS: Record<PillTone, string> = {
  success: "bg-success-soft text-success",
  warning: "bg-warning-soft text-warning",
  destructive: "bg-destructive-soft text-destructive",
  info: "bg-info-soft text-info",
  muted: "bg-muted text-muted-foreground",
};

/* ── CSV (client-assembled; formula-injection guarded) ────────────────── */

export function csvField(value: string | number | boolean | null | undefined): string {
  if (value === null || value === undefined) return "";
  let text = String(value);
  // A leading = + - @ (after whitespace) turns a cell into a formula in
  // spreadsheet apps; neutralize with a leading apostrophe.
  if (/^\s*[=+\-@]/.test(text)) text = `'${text}`;
  if (/[",\r\n]/.test(text)) text = `"${text.replace(/"/g, '""')}"`;
  return text;
}

export const CSV_COLUMNS: readonly { header: string; value: (lead: EnrichmentLead) => string | number | boolean | null }[] = [
  { header: "first_name", value: (lead) => lead.firstName },
  { header: "last_name", value: (lead) => lead.lastName },
  { header: "title", value: (lead) => lead.title },
  { header: "company", value: (lead) => lead.company },
  { header: "domain", value: (lead) => lead.domain },
  { header: "email", value: (lead) => lead.email },
  { header: "email_status", value: (lead) => lead.emailStatus },
  { header: "role_level", value: (lead) => lead.roleLevel },
  { header: "send_wave", value: (lead) => lead.sendWave },
  { header: "lead_city", value: (lead) => lead.leadCity },
  { header: "lead_state", value: (lead) => lead.leadState },
  { header: "lead_country", value: (lead) => lead.leadCountry },
  { header: "final_first_name", value: (lead) => lead.finalFirstName },
  { header: "final_title", value: (lead) => lead.finalTitle },
  { header: "final_company_name", value: (lead) => lead.finalCompanyName },
  { header: "operations_task", value: (lead) => lead.operationsTask },
  { header: "ops_candidate", value: (lead) => lead.opsCandidate },
  { header: "export_status", value: (lead) => lead.tableExportStatus },
  { header: "exported_at", value: (lead) => lead.tableExportedAt },
  { header: "export_error", value: (lead) => lead.tableExportError },
  { header: "linkedin_url", value: (lead) => lead.linkedinUrl },
  { header: "suppression_reason", value: (lead) => lead.suppressionReason },
];

/* ── Action-result plumbing ───────────────────────────────────────────── */

export type NormalizedResult = CellResult & {
  value?: string | null;
  kind?: string;
  retryAfterMs?: number;
  /** Server said this cell is waiting on a dependency that has not run yet. NOT
   *  a failure: the autorun fixpoint retries it once the dependency fills, the
   *  same way the server-side waterfall treats a blocked step. */
  blocked?: boolean;
};

/* Server actions widen `ok` to boolean, so the client narrows by property
   presence and normalizes run results into one shape. */
export function normalizeRunResult(raw: unknown): NormalizedResult {
  const record = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const outcome = WRITEBACK_OUTCOMES.find((candidate) => candidate === record.outcome);
  return {
    ok: record.ok === true,
    message: typeof record.message === "string" && record.message ? record.message : "The action returned no message.",
    outcome,
    fallback: record.fallback === true || undefined,
    blocked: record.blocked === true || undefined,
    value: typeof record.value === "string" || record.value === null ? (record.value as string | null) : undefined,
    kind: typeof record.kind === "string" ? record.kind : undefined,
    retryAfterMs:
      typeof record.retryAfterMs === "number" && Number.isFinite(record.retryAfterMs)
        ? Math.max(0, Math.min(record.retryAfterMs, 300_000))
        : undefined,
  };
}

/* Auth failures must stop a whole bulk run with one toast instead of N
   per-cell failures. */
export function isAuthFailure(result: { ok: boolean; message: string }): boolean {
  return !result.ok && /session|sign in/i.test(result.message);
}

export function isRateLimited(result: NormalizedResult): boolean {
  return !result.ok && (result.kind === "rate_limit" || /rate.?limit/i.test(result.message));
}

/* The export action rejects every remaining row once the list's campaign tag
   no longer matches the tag the run started with: stop the whole bulk run
   with one toast (mirrors the auth-stop idiom). */
export function isCampaignChangedFailure(result: { ok: boolean; message: string }): boolean {
  // Covers both the changed-tag rejection and the tag-cleared rejection so a
  // mid-run untag stops the whole run instead of failing every row.
  return !result.ok && (/campaign.*chang/i.test(result.message) || /tag this list/i.test(result.message));
}

/* ── Shared style constants (copied conventions, intentionally not shared) ── */

export const BTN_BASE = `inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-md font-medium transition disabled:cursor-not-allowed disabled:opacity-50`;
export const BTN_PRIMARY = `${BTN_BASE} bg-primary text-primary-foreground shadow-xs hover:opacity-90`;
export const BTN_OUTLINE = `${BTN_BASE} border border-border bg-surface text-foreground shadow-xs hover:border-border-strong hover:bg-muted/60`;
export const BTN_SUBTLE = `${BTN_BASE} bg-transparent text-muted-foreground hover:bg-muted/70 hover:text-foreground`;

export const INPUT_CLASS =
  "h-8 w-full rounded-md border border-border bg-surface px-2.5 text-[12.5px] text-foreground shadow-xs outline-none transition placeholder:text-muted-foreground focus:border-ring";

export const SELECT_CLASS =
  "h-7 appearance-none rounded-md border border-border bg-surface pl-2 pr-6 text-[11.5px] font-medium text-foreground shadow-xs outline-none transition focus:border-ring";

export function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}
