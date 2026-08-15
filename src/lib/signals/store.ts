import "server-only";

import { getAdminClient } from "@/lib/supabase/admin";
import type {
  SignalCompanyDto,
  SignalJobDetail,
  SignalJobRow,
  SignalJobsFilter,
  SignalJobsPage,
  SignalJobStatus,
  SignalRunDto,
  SignalRunStatus,
  SignalSearchDto,
  SignalSearchInput,
} from "@/lib/signals/types";

const RUN_COLUMNS = "id, search_id, status, jobs_found, jobs_new, jobs_seen_again, error, started_at, finished_at";

const JOB_ROW_COLUMNS =
  "id, source, search_id, company_id, title, company_name, company_logo_url, location, time_posted, posted_at, salary_range, " +
  "seniority_level, employment_type, industries, job_url, easy_apply, status, search_keyword, first_seen_at";

type RunRow = {
  id: string;
  search_id: string;
  status: string;
  jobs_found: number | null;
  jobs_new: number | null;
  jobs_seen_again: number | null;
  error: string | null;
  started_at: string;
  finished_at: string | null;
};

function toRunDto(row: RunRow): SignalRunDto {
  return {
    id: row.id,
    searchId: row.search_id,
    status: row.status as SignalRunStatus,
    jobsFound: row.jobs_found,
    jobsNew: row.jobs_new,
    jobsSeenAgain: row.jobs_seen_again,
    error: row.error,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  };
}

type JobRowDb = {
  id: string;
  source: string;
  search_id: string | null;
  company_id: string | null;
  title: string;
  company_name: string;
  company_logo_url: string | null;
  location: string | null;
  time_posted: string | null;
  posted_at: string | null;
  salary_range: string | null;
  seniority_level: string | null;
  employment_type: string | null;
  industries: string | null;
  job_url: string;
  easy_apply: boolean | null;
  status: string;
  search_keyword: string | null;
  first_seen_at: string;
};

function toJobRow(row: JobRowDb): SignalJobRow {
  return {
    id: row.id,
    source: row.source === "indeed" ? "indeed" : "linkedin",
    searchId: row.search_id,
    companyId: row.company_id,
    title: row.title,
    companyName: row.company_name,
    companyLogoUrl: row.company_logo_url,
    location: row.location,
    timePosted: row.time_posted,
    postedAt: row.posted_at,
    salaryRange: row.salary_range,
    seniorityLevel: row.seniority_level,
    employmentType: row.employment_type,
    industries: row.industries,
    jobUrl: row.job_url,
    easyApply: row.easy_apply,
    status: row.status as SignalJobStatus,
    searchKeyword: row.search_keyword,
    firstSeenAt: row.first_seen_at,
  };
}

type CompanyRowDb = {
  id: string;
  name: string;
  linkedin_url: string | null;
  logo_url: string | null;
  industries: string | null;
  website_url: string | null;
  research_status: string;
  research_brief: string | null;
  research_sources: unknown;
  research_model: string | null;
  research_error: string | null;
  researched_at: string | null;
};

export function toCompanyDto(row: CompanyRowDb): SignalCompanyDto {
  const sources = Array.isArray(row.research_sources)
    ? (row.research_sources as { url?: unknown; title?: unknown }[])
        .filter((source) => typeof source?.url === "string")
        .map((source) => ({ url: source.url as string, title: typeof source.title === "string" ? source.title : null }))
    : [];
  return {
    id: row.id,
    name: row.name,
    linkedinUrl: row.linkedin_url,
    logoUrl: row.logo_url,
    industries: row.industries,
    websiteUrl: row.website_url,
    researchStatus: row.research_status as SignalCompanyDto["researchStatus"],
    researchBrief: row.research_brief,
    researchSources: sources,
    researchModel: row.research_model,
    researchError: row.research_error,
    researchedAt: row.researched_at,
  };
}

export const COMPANY_COLUMNS =
  "id, name, linkedin_url, logo_url, industries, website_url, research_status, research_brief, research_sources, " +
  "research_model, research_error, researched_at";

/* ── Searches ───────────────────────────────────────────────────────── */

// Active searches, each with its most recent run so the UI can show
// last-run stats and resume polling any run that is still open.
export async function listSignalSearches(automationId?: string): Promise<SignalSearchDto[]> {
  const db = getAdminClient();
  let query = db
    .from("signal_searches")
    .select("id, name, source, job_titles, location, cities, experience, employment_type, work_arrangement, posted_within, max_jobs, created_at, last_run_at")
    .eq("archived", false);
  // Searches belong to one automation; an unscoped call is only for maintenance.
  if (automationId) query = query.eq("automation_id", automationId);
  const { data: searches, error } = await query.order("created_at", { ascending: true });
  if (error) throw new Error(`Could not load signal searches: ${error.message}`);
  const rows = searches ?? [];
  if (rows.length === 0) return [];

  const { data: runs, error: runsError } = await db
    .from("signal_runs")
    .select(RUN_COLUMNS)
    .in("search_id", rows.map((row) => row.id))
    .order("started_at", { ascending: false });
  if (runsError) throw new Error(`Could not load signal runs: ${runsError.message}`);
  const latestBySearch = new Map<string, RunRow>();
  for (const run of (runs ?? []) as RunRow[]) {
    if (!latestBySearch.has(run.search_id)) latestBySearch.set(run.search_id, run);
  }

  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    source: (row.source === "indeed" ? "indeed" : "linkedin"),
    jobTitles: (row.job_titles ?? []) as string[],
    location: row.location ?? "United States",
    cities: (row.cities ?? []) as string[],
    experience: row.experience,
    employmentType: row.employment_type,
    workArrangement: row.work_arrangement,
    postedWithin: row.posted_within,
    maxJobs: row.max_jobs,
    createdAt: row.created_at,
    lastRunAt: row.last_run_at,
    latestRun: latestBySearch.has(row.id) ? toRunDto(latestBySearch.get(row.id)!) : null,
  }));
}

export async function createSignalSearch(input: SignalSearchInput, automationId: string): Promise<string> {
  const db = getAdminClient();
  const { data, error } = await db
    .from("signal_searches")
    .insert({
      automation_id: automationId,
      name: input.name,
      source: input.source,
      job_titles: input.jobTitles,
      location: input.location,
      cities: input.cities,
      experience: input.experience,
      employment_type: input.employmentType,
      work_arrangement: input.workArrangement,
      posted_within: input.postedWithin,
      max_jobs: input.maxJobs,
    })
    .select("id")
    .single();
  if (error || !data) throw new Error(`Could not create search: ${error?.message}`);
  return data.id as string;
}

export async function updateSignalSearch(id: string, input: SignalSearchInput): Promise<void> {
  const db = getAdminClient();
  const { error } = await db
    .from("signal_searches")
    .update({
      name: input.name,
      source: input.source,
      job_titles: input.jobTitles,
      location: input.location,
      cities: input.cities,
      experience: input.experience,
      employment_type: input.employmentType,
      work_arrangement: input.workArrangement,
      posted_within: input.postedWithin,
      max_jobs: input.maxJobs,
      updated_at: new Date().toISOString(),
    })
    .eq("id", id);
  if (error) throw new Error(`Could not update search: ${error.message}`);
}

// Archive, not delete: runs and jobs keep their provenance rows.
export async function archiveSignalSearch(id: string): Promise<void> {
  const db = getAdminClient();
  const { error } = await db
    .from("signal_searches")
    .update({ archived: true, updated_at: new Date().toISOString() })
    .eq("id", id);
  if (error) throw new Error(`Could not archive search: ${error.message}`);
}

/* ── Jobs ───────────────────────────────────────────────────────────── */

export async function getSignalJobsPage(filter: SignalJobsFilter): Promise<SignalJobsPage> {
  const db = getAdminClient();

  const base = () => {
    let query = db.from("signal_jobs").select(JOB_ROW_COLUMNS, { count: "exact" });
    if (filter.searchId) query = query.eq("search_id", filter.searchId);
    if (filter.q) {
      const escaped = filter.q.replace(/[%_,()]/g, " ").trim();
      if (escaped) {
        query = query.or(
          `title.ilike.%${escaped}%,company_name.ilike.%${escaped}%,location.ilike.%${escaped}%,industries.ilike.%${escaped}%`,
        );
      }
    }
    return query;
  };

  let pageQuery = base();
  if (filter.status !== "all") pageQuery = pageQuery.eq("status", filter.status);
  const { data, error, count } = await pageQuery
    .order("first_seen_at", { ascending: false })
    .order("id", { ascending: false })
    .range(filter.offset, filter.offset + filter.limit - 1);
  if (error) throw new Error(`Could not load jobs: ${error.message}`);

  // Tab counts honor the search/text filter but not the active status tab.
  const countFor = async (status: SignalJobStatus | "all") => {
    let query = db.from("signal_jobs").select("id", { count: "exact", head: true });
    if (filter.searchId) query = query.eq("search_id", filter.searchId);
    if (filter.q) {
      const escaped = filter.q.replace(/[%_,()]/g, " ").trim();
      if (escaped) {
        query = query.or(
          `title.ilike.%${escaped}%,company_name.ilike.%${escaped}%,location.ilike.%${escaped}%,industries.ilike.%${escaped}%`,
        );
      }
    }
    if (status !== "all") query = query.eq("status", status);
    const { count: value, error: countError } = await query;
    if (countError) throw new Error(`Could not count jobs: ${countError.message}`);
    return value ?? 0;
  };

  const [allCount, newCount, shortlistedCount, dismissedCount] = await Promise.all([
    filter.status === "all" ? Promise.resolve(count ?? 0) : countFor("all"),
    filter.status === "new" ? Promise.resolve(count ?? 0) : countFor("new"),
    filter.status === "shortlisted" ? Promise.resolve(count ?? 0) : countFor("shortlisted"),
    filter.status === "dismissed" ? Promise.resolve(count ?? 0) : countFor("dismissed"),
  ]);

  return {
    rows: ((data ?? []) as unknown as JobRowDb[]).map(toJobRow),
    total: count ?? 0,
    counts: { all: allCount, new: newCount, shortlisted: shortlistedCount, dismissed: dismissedCount },
  };
}

export async function getSignalJobDetail(jobId: string): Promise<SignalJobDetail | null> {
  const db = getAdminClient();
  const { data: job, error } = await db
    .from("signal_jobs")
    .select(`${JOB_ROW_COLUMNS}, description, job_function, num_applicants, apply_url, contact_email, company_linkedin_url`)
    .eq("id", jobId)
    .maybeSingle();
  if (error) throw new Error(`Could not load job: ${error.message}`);
  if (!job) return null;

  let company: SignalCompanyDto | null = null;
  if (job.company_id) {
    const { data: companyRow } = await db
      .from("signal_companies")
      .select(COMPANY_COLUMNS)
      .eq("id", job.company_id)
      .maybeSingle();
    if (companyRow) company = toCompanyDto(companyRow as unknown as CompanyRowDb);
  }

  return {
    ...toJobRow(job as JobRowDb),
    description: (job.description as string | null) ?? null,
    jobFunction: (job.job_function as string | null) ?? null,
    numApplicants: (job.num_applicants as string | null) ?? null,
    applyUrl: (job.apply_url as string | null) ?? null,
    contactEmail: (job.contact_email as string | null) ?? null,
    companyLinkedinUrl: (job.company_linkedin_url as string | null) ?? null,
    company,
  };
}

export async function setSignalJobStatus(jobId: string, status: SignalJobStatus): Promise<void> {
  const db = getAdminClient();
  const { error } = await db.from("signal_jobs").update({ status }).eq("id", jobId);
  if (error) throw new Error(`Could not update job: ${error.message}`);
}

/* ── Runs ───────────────────────────────────────────────────────────── */

// Open runs across all searches: the page resumes polling these on load, which
// is how a scrape started in a since-closed tab still lands in the DB.
export async function listOpenSignalRuns(): Promise<SignalRunDto[]> {
  const db = getAdminClient();
  const { data, error } = await db
    .from("signal_runs")
    .select(RUN_COLUMNS)
    .in("status", ["running", "ingesting"])
    .order("started_at", { ascending: false });
  if (error) throw new Error(`Could not load open runs: ${error.message}`);
  return ((data ?? []) as RunRow[]).map(toRunDto);
}
