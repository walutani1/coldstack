import "server-only";

import { getAdminClient } from "@/lib/supabase/admin";
import { getCompanyContacts } from "@/lib/signals/contacts";
import { toCompanyDto } from "@/lib/signals/store";
import {
  FUNNEL_STAGES,
  type CompaniesFilter,
  type CompaniesPage,
  type CompanyDetail,
  type CompanyPick,
  type CompanyResultRow,
  type FunnelCounts,
  type FunnelStage,
  type ScoreFactor,
  type SignalJobRow,
  type StageResultDto,
} from "@/lib/signals/types";

const COMPANY_ROW_COLUMNS =
  "id, name, logo_url, domain, website_url, linkedin_url, industries, headcount, headcount_source, headcount_confidence, " +
  "funnel_state, killed_stage, kill_reason, funnel_error, review_state, archived_reason, override, override_note, " +
  "score, score_breakdown, flags, evidence_count, latest_evidence_at, updated_at, " +
  "contacts_state, contacts_error, roster_count, linkedin_employee_count, reports_to_title";

type CompanyDb = Record<string, unknown>;

function toResultRow(row: CompanyDb, topJobTitle: string | null, picks: CompanyPick[] = []): CompanyResultRow {
  const breakdown = Array.isArray(row.score_breakdown) ? (row.score_breakdown as ScoreFactor[]) : null;
  return {
    id: row.id as string,
    name: row.name as string,
    logoUrl: (row.logo_url as string | null) ?? null,
    domain: (row.domain as string | null) ?? null,
    websiteUrl: (row.website_url as string | null) ?? null,
    linkedinUrl: (row.linkedin_url as string | null) ?? null,
    industries: (row.industries as string | null) ?? null,
    headcount: (row.headcount as number | null) ?? null,
    headcountSource: (row.headcount_source as CompanyResultRow["headcountSource"]) ?? null,
    headcountConfidence: (row.headcount_confidence as CompanyResultRow["headcountConfidence"]) ?? null,
    linkedinEmployeeCount: (row.linkedin_employee_count as number | null) ?? null,
    reportsToTitle: (row.reports_to_title as string | null) ?? null,
    contactsState: (row.contacts_state as CompanyResultRow["contactsState"]) ?? "none",
    contactsError: (row.contacts_error as string | null) ?? null,
    rosterCount: (row.roster_count as number | null) ?? null,
    funnelState: row.funnel_state as CompanyResultRow["funnelState"],
    killedStage: (row.killed_stage as FunnelStage | "override" | null) ?? null,
    killReason: (row.kill_reason as string | null) ?? null,
    funnelError: (row.funnel_error as string | null) ?? null,
    reviewState: (row.review_state as CompanyResultRow["reviewState"]) ?? null,
    archivedReason: (row.archived_reason as string | null) ?? null,
    override: (row.override as CompanyResultRow["override"]) ?? null,
    overrideNote: (row.override_note as string | null) ?? null,
    score: (row.score as number | null) ?? null,
    scoreBreakdown: breakdown,
    flags: ((row.flags ?? {}) as CompanyResultRow["flags"]),
    evidenceCount: (row.evidence_count as number) ?? 0,
    latestEvidenceAt: (row.latest_evidence_at as string | null) ?? null,
    topJobTitle,
    picks,
    updatedAt: row.updated_at as string,
  };
}

// PostgREST filter builders are structurally identical across select/count
// queries; typing them precisely buys nothing here.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function applyView(query: any, filter: CompaniesFilter) {
  let q = query;
  // Every list is one automation's world: another automation's verdict on the
  // same company is a different, equally valid answer.
  if (filter.automationId) q = q.eq("automation_id", filter.automationId);
  if (filter.view === "qualified") q = q.eq("funnel_state", "qualified");
  else if (filter.view === "killed") q = q.eq("funnel_state", "killed");
  else if (filter.view === "errored") q = q.eq("funnel_state", "errored");
  else if (filter.view === "flagged") {
    q = q.or("flags->>crmOverlap.eq.true,flags->>estimateBased.eq.true,flags->>unknownIndustry.eq.true,flags->>newEvidence.eq.true");
  }
  if (filter.view === "qualified" && filter.reviewState !== "all") q = q.eq("review_state", filter.reviewState);
  if (filter.view === "killed" && filter.killedStage) q = q.eq("killed_stage", filter.killedStage);
  if (filter.q) {
    const escaped = filter.q.replace(/[%_,()]/g, " ").trim();
    if (escaped) q = q.or(`name.ilike.%${escaped}%,industries.ilike.%${escaped}%,domain.ilike.%${escaped}%`);
  }
  return q;
}

export async function getCompaniesPage(filter: CompaniesFilter): Promise<CompaniesPage> {
  const db = getAdminClient();
  let query = db.from("signal_companies").select(COMPANY_ROW_COLUMNS, { count: "exact" });
  query = applyView(query, filter);
  // New reviews first inside qualified; then best score; then recency.
  if (filter.view === "qualified") query = query.order("review_state", { ascending: false, nullsFirst: false });
  const { data, error, count } = await query
    .order("score", { ascending: false, nullsFirst: false })
    .order("updated_at", { ascending: false })
    .range(filter.offset, filter.offset + filter.limit - 1);
  if (error) throw new Error(`Could not load companies: ${error.message}`);
  const rows = (data ?? []) as unknown as CompanyDb[];

  // Picked contacts, inlined so the list shows company + people together.
  const picksByCompany = new Map<string, CompanyPick[]>();
  if (rows.length > 0) {
    const { data: pickRows } = await db
      .from("signal_contacts")
      .select("id, company_id, full_name, title, pick_order, matched_reports_to, email, email_status, pushed_at, release_blocked_reason")
      .in("company_id", rows.map((row) => row.id as string))
      .not("pick_order", "is", null)
      .order("pick_order");
    for (const pick of pickRows ?? []) {
      const companyId = pick.company_id as string;
      const list = picksByCompany.get(companyId) ?? [];
      list.push({
        id: pick.id as string,
        fullName: (pick.full_name as string | null) ?? "",
        title: pick.title as string | null,
        pickOrder: Number(pick.pick_order ?? 0),
        matchedReportsTo: pick.matched_reports_to === true,
        email: pick.email as string | null,
        emailStatus: (pick.email_status as CompanyPick["emailStatus"]) ?? null,
        pushedAt: pick.pushed_at as string | null,
        releaseBlockedReason: pick.release_blocked_reason as string | null,
      });
      picksByCompany.set(companyId, list);
    }
  }

  // One representative posting title per company for the table.
  const ids = rows.map((row) => row.id as string);
  const titleByCompany = new Map<string, string>();
  if (ids.length > 0) {
    const { data: jobs } = await db
      .from("signal_jobs")
      .select("company_id, title, first_seen_at")
      .in("company_id", ids)
      .order("first_seen_at", { ascending: false })
      .limit(ids.length * 4);
    for (const job of jobs ?? []) {
      const companyId = job.company_id as string;
      if (!titleByCompany.has(companyId)) titleByCompany.set(companyId, job.title as string);
    }
  }

  return {
    rows: rows.map((row) => toResultRow(row, titleByCompany.get(row.id as string) ?? null, picksByCompany.get(row.id as string) ?? [])),
    total: count ?? 0,
  };
}

// Pipeline-strip counts, derived from company end-states: kills attributed to
// their stage, survivors flowing through. Errors are shown in totals (their
// stage is visible per-company in the audit trail).
export async function getFunnelCounts(automationId?: string): Promise<FunnelCounts> {
  const db = getAdminClient();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const countWhere = async (apply: (q: any) => any): Promise<number> => {
    let base = db.from("signal_companies").select("id", { count: "exact", head: true });
    if (automationId) base = base.eq("automation_id", automationId);
    const { count } = await apply(base);
    return count ?? 0;
  };

  const [companies, pending, processing, qualified, killed, errored, overridden] = await Promise.all([
    countWhere((q) => q),
    countWhere((q) => q.eq("funnel_state", "pending")),
    countWhere((q) => q.eq("funnel_state", "processing")),
    countWhere((q) => q.eq("funnel_state", "qualified")),
    countWhere((q) => q.eq("funnel_state", "killed")),
    countWhere((q) => q.eq("funnel_state", "errored")),
    countWhere((q) => q.not("override", "is", null)),
  ]);

  const killsByStage = new Map<FunnelStage, number>();
  await Promise.all(
    FUNNEL_STAGES.map(async (stage) => {
      killsByStage.set(stage, await countWhere((q) => q.eq("funnel_state", "killed").eq("killed_stage", stage)));
    }),
  );

  const stages = {} as FunnelCounts["stages"];
  let entering = qualified + killed;
  for (const stage of FUNNEL_STAGES) {
    const kill = killsByStage.get(stage) ?? 0;
    const pass = Math.max(0, entering - kill);
    stages[stage] = { pass, kill, error: 0 };
    entering = pass;
  }

  return {
    stages,
    totals: { companies, pending: pending + processing, qualified, killed, errored, overridden },
  };
}

const JOB_ROW_COLUMNS =
  "id, source, search_id, company_id, title, company_name, company_logo_url, location, time_posted, posted_at, salary_range, " +
  "seniority_level, employment_type, industries, job_url, easy_apply, status, search_keyword, first_seen_at, description";

export async function getCompanyDetail(companyId: string): Promise<CompanyDetail | null> {
  const db = getAdminClient();
  const { data: row, error } = await db
    .from("signal_companies")
    .select(`${COMPANY_ROW_COLUMNS}, research_status, research_brief, research_sources, research_model, research_error, researched_at, linkedin_url, logo_url`)
    .eq("id", companyId)
    .maybeSingle();
  if (error) throw new Error(`Could not load company: ${error.message}`);
  if (!row) return null;

  const [{ data: jobRows }, { data: resultRows }, contacts] = await Promise.all([
    db.from("signal_jobs").select(JOB_ROW_COLUMNS).eq("company_id", companyId).order("first_seen_at", { ascending: false }).limit(20),
    db
      .from("signal_stage_results")
      .select("id, stage, verdict, output, rationale, raw_text, error, config_version, model, input_tokens, output_tokens, latency_ms, created_at")
      .eq("company_id", companyId)
      .order("created_at", { ascending: false })
      .limit(60),
    getCompanyContacts(companyId),
  ]);

  const jobs: SignalJobRow[] = ((jobRows ?? []) as unknown as CompanyDb[]).map((job) => ({
    id: job.id as string,
    source: (job.source === "indeed" ? "indeed" : "linkedin") as SignalJobRow["source"],
    searchId: (job.search_id as string | null) ?? null,
    companyId: (job.company_id as string | null) ?? null,
    title: job.title as string,
    companyName: job.company_name as string,
    companyLogoUrl: (job.company_logo_url as string | null) ?? null,
    location: (job.location as string | null) ?? null,
    timePosted: (job.time_posted as string | null) ?? null,
    postedAt: (job.posted_at as string | null) ?? null,
    salaryRange: (job.salary_range as string | null) ?? null,
    seniorityLevel: (job.seniority_level as string | null) ?? null,
    employmentType: (job.employment_type as string | null) ?? null,
    industries: (job.industries as string | null) ?? null,
    jobUrl: job.job_url as string,
    easyApply: (job.easy_apply as boolean | null) ?? null,
    status: (job.status as SignalJobRow["status"]) ?? "new",
    searchKeyword: (job.search_keyword as string | null) ?? null,
    firstSeenAt: job.first_seen_at as string,
  }));

  const stageResults: StageResultDto[] = ((resultRows ?? []) as unknown as CompanyDb[]).map((result) => ({
    id: result.id as string,
    stage: result.stage as FunnelStage,
    verdict: result.verdict as StageResultDto["verdict"],
    output: (result.output as Record<string, unknown> | null) ?? null,
    rationale: (result.rationale as string | null) ?? null,
    rawText: (result.raw_text as string | null) ?? null,
    error: (result.error as string | null) ?? null,
    configVersion: (result.config_version as number | null) ?? null,
    model: (result.model as string | null) ?? null,
    inputTokens: (result.input_tokens as number | null) ?? null,
    outputTokens: (result.output_tokens as number | null) ?? null,
    latencyMs: (result.latency_ms as number | null) ?? null,
    createdAt: result.created_at as string,
  }));

  const company = toCompanyDto(row as never);
  return {
    ...toResultRow(row, jobs[0]?.title ?? null),
    researchStatus: company.researchStatus,
    researchBrief: company.researchBrief,
    researchSources: company.researchSources,
    researchedAt: company.researchedAt,
    jobs,
    stageResults,
    contacts,
  };
}

// Recent kills for one stage — the pipeline strip's "what did this stage
// kill, and why" audit (kill transparency requirement).
export async function getStageKills(stage: FunnelStage, limit = 12): Promise<{ companyId: string; companyName: string; rationale: string | null; createdAt: string }[]> {
  const db = getAdminClient();
  const { data, error } = await db
    .from("signal_stage_results")
    .select("company_id, rationale, created_at")
    .eq("stage", stage)
    .eq("verdict", "kill")
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw new Error(`Could not load stage kills: ${error.message}`);
  const rows = data ?? [];
  const ids = [...new Set(rows.map((row) => row.company_id as string))];
  const names = new Map<string, string>();
  if (ids.length > 0) {
    const { data: companies } = await db.from("signal_companies").select("id, name").in("id", ids);
    for (const company of companies ?? []) names.set(company.id as string, company.name as string);
  }
  return rows.map((row) => ({
    companyId: row.company_id as string,
    companyName: names.get(row.company_id as string) ?? "Unknown",
    rationale: (row.rationale as string | null) ?? null,
    createdAt: row.created_at as string,
  }));
}

/* ── Review + override mutations ────────────────────────────────────── */

export async function setReviewState(companyId: string, state: "new" | "approved" | "archived", reason: string | null): Promise<void> {
  const db = getAdminClient();
  const { error } = await db
    .from("signal_companies")
    .update({ review_state: state, archived_reason: state === "archived" ? reason : null, updated_at: new Date().toISOString() })
    .eq("id", companyId)
    .eq("funnel_state", "qualified");
  if (error) throw new Error(`Could not update review state: ${error.message}`);
}

// Overrides apply immediately and stick: re-evaluation never flips them.
export async function setOverride(companyId: string, override: "qualified" | "killed" | null, note: string | null): Promise<void> {
  const db = getAdminClient();
  const patch: Record<string, unknown> = {
    override,
    override_note: override ? note : null,
    override_at: override ? new Date().toISOString() : null,
    updated_at: new Date().toISOString(),
  };
  if (override === "qualified") {
    patch.funnel_state = "qualified";
    patch.killed_stage = null;
    patch.kill_reason = null;
  } else if (override === "killed") {
    patch.funnel_state = "killed";
    patch.killed_stage = "override";
    patch.kill_reason = note || "Operator override.";
  }
  const { error } = await db.from("signal_companies").update(patch).eq("id", companyId);
  if (error) throw new Error(`Could not set override: ${error.message}`);
  if (override === "qualified") {
    // Qualified needs a review state; only set it where missing.
    await db.from("signal_companies").update({ review_state: "new" }).eq("id", companyId).is("review_state", null);
  }
}
