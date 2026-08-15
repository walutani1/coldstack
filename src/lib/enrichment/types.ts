export type EmailStatus = "deliverable" | "risky" | "invalid" | string;

export type EnrichmentLead = {
  id: string;
  companyId: string | null;
  roleLevel: string | null;
  firstName: string | null;
  lastName: string | null;
  title: string | null;
  email: string | null;
  emailStatus: EmailStatus | null;
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
  // Per-key generation_version of each custom cell, to detect a stale cell
  // (older than its column's generation) after a prompt edit.
  customCellGens: Record<string, number>;
  updatedAt: string;
};

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

export type RunCandidate = EnrichmentLead & {
  runAction: RunnableAction;
};

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
  // Separate buckets, matching the email-status filter's own values, so a count
  // shown in the UI can be reproduced by filtering to it.
  risky: number;
  catchAll: number;
  invalid: number;
};

export type FilterOptions = {
  roleLevels: string[];
  emailStatuses: string[];
  countries: string[];
};

export type LeadsPageResult = {
  rows: EnrichmentLead[];
  totalCount: number;
};

export type WritebackOutcome = "written" | "stale" | "duplicate" | "not_found";

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

export type Coworker = {
  firstName: string;
  roleLevel: string | null;
};

type RpcLeadRow = Record<string, unknown>;

function nullableString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

export function normalizeEnrichmentLead(row: RpcLeadRow): EnrichmentLead {
  if (typeof row.id !== "string" || typeof row.updated_at !== "string") {
    throw new Error("Invalid enrichment lead row.");
  }

  return {
    id: row.id,
    companyId: nullableString(row.company_id),
    roleLevel: nullableString(row.role_level),
    firstName: nullableString(row.first_name),
    lastName: nullableString(row.last_name),
    title: nullableString(row.title),
    email: nullableString(row.email),
    emailStatus: nullableString(row.email_status),
    finalFirstName: nullableString(row.final_first_name),
    finalTitle: nullableString(row.final_title),
    finalCompanyName: nullableString(row.final_company_name),
    operationsTask: nullableString(row.operations_task),
    opsCandidate: nullableString(row.ops_candidate),
    personalizationUpdatedAt: nullableString(row.personalization_updated_at),
    smartleadCampaignId: nullableString(row.smartlead_campaign_id),
    smartleadCampaignName: nullableString(row.smartlead_campaign_name),
    smartleadExportStatus: nullableString(row.smartlead_export_status),
    smartleadExportedAt: nullableString(row.smartlead_exported_at),
    smartleadExportError: nullableString(row.smartlead_export_error),
    tableExportStatus: nullableString(row.table_export_status),
    tableExportedAt: nullableString(row.table_exported_at),
    tableExportError: nullableString(row.table_export_error),
    smartleadLeadId: nullableString(row.smartlead_lead_id),
    linkedinUrl: nullableString(row.linkedin_url),
    company: nullableString(row.company),
    domain: nullableString(row.domain),
    sendWave: typeof row.send_wave === "number" ? row.send_wave : null,
    sharedCompany: typeof row.shared_company === "boolean" ? row.shared_company : null,
    leadCity: nullableString(row.lead_city),
    leadState: nullableString(row.lead_state),
    leadCountry: nullableString(row.lead_country),
    suppressionReason: nullableString(row.suppression_reason),
    linkedinEmploymentStatus: nullableString(row.linkedin_employment_status),
    linkedinCurrentCompany: nullableString(row.linkedin_current_company),
    linkedinCheckedAt: nullableString(row.linkedin_checked_at),
    linkedinProfile: row.linkedin_profile ?? null,
    companySummary: row.company_summary ?? null,
    customCells:
      row.custom_cells && typeof row.custom_cells === "object" && !Array.isArray(row.custom_cells)
        ? (row.custom_cells as Record<string, string | null>)
        : {},
    customCellGens:
      row.custom_cell_gens && typeof row.custom_cell_gens === "object" && !Array.isArray(row.custom_cell_gens)
        ? (row.custom_cell_gens as Record<string, number>)
        : {},
    updatedAt: row.updated_at,
  };
}
