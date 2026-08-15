// Shared Signals DTOs crossing the server/client boundary. Server queries
// (store.ts) produce these; the /signals client consumes them untouched.

export type SignalRunStatus = "running" | "ingesting" | "succeeded" | "failed";

export type SignalRunDto = {
  id: string;
  searchId: string;
  status: SignalRunStatus;
  jobsFound: number | null;
  jobsNew: number | null;
  jobsSeenAgain: number | null;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
};

export type JobBoardSource = "linkedin" | "indeed";

export type SignalSearchDto = {
  id: string;
  name: string;
  source: JobBoardSource;
  jobTitles: string[];
  location: string;
  cities: string[];
  experience: string | null;
  employmentType: string | null;
  workArrangement: string | null;
  postedWithin: string | null;
  maxJobs: number;
  createdAt: string;
  lastRunAt: string | null;
  latestRun: SignalRunDto | null;
};

export type SignalSearchInput = {
  name: string;
  source: JobBoardSource;
  jobTitles: string[];
  location: string;
  cities: string[];
  experience: string | null;
  employmentType: string | null;
  workArrangement: string | null;
  postedWithin: string | null;
  maxJobs: number;
};

export type SignalJobStatus = "new" | "shortlisted" | "dismissed";

export type SignalJobRow = {
  id: string;
  source: JobBoardSource;
  searchId: string | null;
  companyId: string | null;
  title: string;
  companyName: string;
  companyLogoUrl: string | null;
  location: string | null;
  timePosted: string | null;
  postedAt: string | null;
  salaryRange: string | null;
  seniorityLevel: string | null;
  employmentType: string | null;
  industries: string | null;
  jobUrl: string;
  easyApply: boolean | null;
  status: SignalJobStatus;
  searchKeyword: string | null;
  firstSeenAt: string;
};

export type SignalCompanyDto = {
  id: string;
  name: string;
  linkedinUrl: string | null;
  logoUrl: string | null;
  industries: string | null;
  websiteUrl: string | null;
  researchStatus: "none" | "running" | "done" | "failed";
  researchBrief: string | null;
  researchSources: { url: string; title: string | null }[];
  researchModel: string | null;
  researchError: string | null;
  researchedAt: string | null;
};

export type SignalJobDetail = SignalJobRow & {
  description: string | null;
  jobFunction: string | null;
  numApplicants: string | null;
  applyUrl: string | null;
  contactEmail: string | null;
  companyLinkedinUrl: string | null;
  company: SignalCompanyDto | null;
};

export type SignalJobsFilter = {
  status: SignalJobStatus | "all";
  searchId: string | null;
  q: string | null;
  limit: number;
  offset: number;
};

export type SignalJobsCounts = { all: number; new: number; shortlisted: number; dismissed: number };

export type SignalJobsPage = {
  rows: SignalJobRow[];
  total: number;
  counts: SignalJobsCounts;
};

/* ── Funnel (v2) ────────────────────────────────────────────────────── */

// Stage keys in pipeline order. Deterministic stages are free to recompute;
// AI stages record model + tokens and are reused when config/evidence allow.
// Order matters: cheap kills first. The title gate needs only titles +
// studio context (Haiku), so it runs BEFORE research — QA/test-automation
// noise dies before we pay Firecrawl + Sonnet to research it.
export const FUNNEL_STAGES = [
  "rollup",
  "industry",
  "agency",
  "title_gate",
  "research",
  "size",
  "jd_scoring",
  "score",
] as const;
export type FunnelStage = (typeof FUNNEL_STAGES)[number];

export const FUNNEL_STAGE_LABELS: Record<FunnelStage, string> = {
  rollup: "Rollup",
  industry: "Industry screen",
  agency: "Agency screen",
  research: "Research",
  size: "Size filter",
  title_gate: "Title gate",
  jd_scoring: "JD scoring",
  score: "Score",
};

// The full funnel setup, stored as immutable versioned snapshots in
// signal_configs. Editing any part creates a new version; stage results
// record the version that produced them.
export type FunnelConfig = {
  studioContext: string;
  headcount: { min: number; max: number };
  industries: { blocked: string[]; preferred: string[] };
  evidenceWindowDays: number;
  jdTopN: number;
  models: { agency: string; facts: string; titleGate: string; jdScoring: string };
  weights: { sizeFit: number; industryFit: number; titleStrength: number; jdSignals: number; evidenceVolume: number };
  qualifiedThreshold: number;
  prompts: { agency: string; titleGate: string; jdScoring: string };
  spend: { perRunCapUsd: number; perCompanyMaxTokens: number };
};

export type FunnelConfigVersion = { version: number; config: FunnelConfig; createdAt: string; note: string | null };

export type ScoreFactor = {
  key: "sizeFit" | "industryFit" | "titleStrength" | "jdSignals" | "evidenceVolume";
  label: string;
  points: number;
  max: number;
  rationale: string;
};

export type FunnelState = "pending" | "processing" | "qualified" | "killed" | "errored";
export type ReviewState = "new" | "approved" | "archived";

export type StageResultDto = {
  id: string;
  stage: FunnelStage;
  verdict: "pass" | "kill" | "flag" | "score" | "error" | "skip";
  output: Record<string, unknown> | null;
  rationale: string | null;
  rawText: string | null;
  error: string | null;
  configVersion: number | null;
  model: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  latencyMs: number | null;
  createdAt: string;
};

export type FunnelRunStatus = "running" | "paused" | "succeeded" | "failed";

export type FunnelRunDto = {
  id: string;
  automationId: string;
  status: FunnelRunStatus;
  trigger: "manual" | "reevaluate" | "new_evidence" | "cron";
  configVersion: number | null;
  searchIds: string[];
  stats: {
    phase?: "scraping" | "processing" | "done";
    scrapeRunIds?: string[];
    scrapesDone?: number;
    scrapesTotal?: number;
    jobsFound?: number;
    jobsNew?: number;
    companiesProcessed?: number;
    companiesRemaining?: number;
    qualified?: number;
    killed?: number;
    errored?: number;
    // Kills decided during THIS run, by stage (for the last-run summary).
    stageKills?: Record<string, number>;
    // Contact sourcing progress (rosters still pending/in flight).
    contactsActive?: number;
    contactsSpendUsd?: number;
  };
  spendEstimateUsd: number;
  spendCapUsd: number | null;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
};

/* ── Automations (v3) ───────────────────────────────────────────────── */

// Per-automation targeting. Anything omitted falls back to the global config,
// so an automation only states what makes it different.
export type AutomationCriteria = {
  headcount?: { min: number; max: number };
  industries?: { blocked: string[]; preferred: string[] };
  qualifiedThreshold?: number;
  evidenceWindowDays?: number;
};

export type AutomationStatus = "draft" | "active" | "paused";

export type AutomationDto = {
  id: string;
  name: string;
  status: AutomationStatus;
  criteria: AutomationCriteria;
  campaignId: string | null;
  campaignName: string | null;
  prospectTableId: string | null;
  schedule: { frequency: "manual" | "daily"; hourUtc: number };
  autopush: boolean;
  contactsPerCompany: number;
  releaseGapDays: number;
  archived: boolean;
  lastRunAt: string | null;
  createdAt: string;
};

// What the automations list shows per card — the outcome, not the machinery.
export type AutomationSummary = {
  automation: AutomationDto;
  searchCount: number;
  titleCount: number;
  scanned: number;
  qualified: number;
  leadsReady: number;
  leadsAwaitingEmail: number;
  filteredOut: number;
  running: boolean;
};

/* ── Contacts (v3) ──────────────────────────────────────────────────── */

// Contact-sourcing lifecycle on a qualified company. Poll-driven like
// research: pending -> sourcing (Apify roster run in flight) -> sourced.
export type ContactsState = "none" | "pending" | "sourcing" | "sourced" | "errored";

export type SignalContactDto = {
  id: string;
  companyId: string;
  fullName: string;
  firstName: string | null;
  lastName: string | null;
  title: string | null;
  location: string | null;
  about: string | null;
  pictureUrl: string | null;
  linkedinUrl: string | null;
  tenureMonths: number | null;
  startedOn: string | null;
  rank: number | null;
  rankScore: number | null;
  rankReason: string | null;
  employmentStatus: "current" | "departed" | "unknown" | null;
  currentEmployer: string | null;
  // Chosen because the job description named their title as the reporting line.
  matchedReportsTo: boolean;
  status: "candidate" | "selected" | "excluded";
  exclusionReason: string | null;
  // 1 = primary, 2 = backup, null = not in the lead list.
  pickOrder: number | null;
  pickByOperator: boolean;
  email: string | null;
  emailStatus: "pending" | "found" | "not_found" | "error" | null;
  emailSource: string | null;
  emailError: string | null;
  leadId: string | null;
  pushedAt: string | null;
};

// One row of the cross-company lead list: a picked contact plus enough
// company context to judge it at a glance.
export type LeadListRow = {
  contact: SignalContactDto;
  companyId: string;
  companyName: string;
  companyLogoUrl: string | null;
  companyScore: number | null;
  companyIndustries: string | null;
};

export type LeadListSummary = {
  rows: LeadListRow[];
  ready: number; // picked + email found + not pushed
  missingEmail: number; // picked but no email yet
  pushed: number;
};

// The two people this automation will email at a company, inlined on the
// results list so the operator sees company + who in one glance.
export type CompanyPick = {
  id: string;
  fullName: string;
  title: string | null;
  pickOrder: number;
  matchedReportsTo: boolean;
  email: string | null;
  emailStatus: "pending" | "found" | "not_found" | "error" | null;
  pushedAt: string | null;
  releaseBlockedReason: string | null;
};

export type CompanyResultRow = {
  id: string;
  name: string;
  logoUrl: string | null;
  domain: string | null;
  websiteUrl: string | null;
  linkedinUrl: string | null;
  industries: string | null;
  headcount: number | null;
  headcountSource: "verified" | "indeed_profile" | "llm_estimate" | null;
  headcountConfidence: "high" | "low" | null;
  // Title the posted role reports to, verbatim from the JD (null when unstated).
  reportsToTitle: string | null;
  // Employees observed on LinkedIn with their current employer verified —
  // a floor on true headcount, and what the estimate is grounded in.
  linkedinEmployeeCount: number | null;
  contactsState: ContactsState;
  contactsError: string | null;
  rosterCount: number | null;
  funnelState: FunnelState;
  killedStage: FunnelStage | "override" | null;
  killReason: string | null;
  funnelError: string | null;
  reviewState: ReviewState | null;
  archivedReason: string | null;
  override: "qualified" | "killed" | null;
  overrideNote: string | null;
  score: number | null;
  scoreBreakdown: ScoreFactor[] | null;
  flags: { crmOverlap?: boolean; estimateBased?: boolean; updated?: boolean; newEvidence?: boolean; unknownIndustry?: boolean };
  evidenceCount: number;
  latestEvidenceAt: string | null;
  topJobTitle: string | null;
  picks: CompanyPick[];
  updatedAt: string;
};

export type CompanyDetail = CompanyResultRow & {
  researchStatus: "none" | "running" | "done" | "failed";
  researchBrief: string | null;
  researchSources: { url: string; title: string | null }[];
  researchedAt: string | null;
  jobs: SignalJobRow[];
  stageResults: StageResultDto[];
  contacts: SignalContactDto[];
};

export type FunnelCounts = {
  // Per-stage: companies whose latest result at this stage passed / were
  // killed here / errored here. Overridden companies counted separately.
  stages: Record<FunnelStage, { pass: number; kill: number; error: number }>;
  totals: { companies: number; pending: number; qualified: number; killed: number; errored: number; overridden: number };
};

export type CompaniesFilter = {
  // Which automation's results these are. Null only in legacy/global reads.
  automationId: string | null;
  view: "qualified" | "killed" | "errored" | "flagged" | "all";
  reviewState: ReviewState | "all";
  // Drill-down from the pipeline strip: only companies killed at this stage.
  killedStage: FunnelStage | null;
  q: string | null;
  limit: number;
  offset: number;
};

export type CompaniesPage = { rows: CompanyResultRow[]; total: number };
