import "server-only";

import { getAdminClient } from "@/lib/supabase/admin";
import { getSecret } from "@/lib/secrets";
import type { SignalRunDto, SignalRunStatus } from "@/lib/signals/types";

// Credentials travel in headers, never in the URL — query-string API keys are
// being deprecated by these providers and leak into logs and proxies.
export function apifyAuth(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

// Job-board scrapers, one Apify actor per source:
// - linkedin: worldunboxer/rapid-linkedin-scraper — structured filters, one
//   run covers many titles; full description + company metadata (~$0.50/1k).
// - indeed: borderline/indeed-scraper — one query per run (we fan out one run
//   per title); full description + company profile incl. employee-count range
//   and revenue (~$5/1k). The employee count feeds the size filter as an
//   'indeed_profile' headcount source.
const ACTORS: Record<JobSource, string> = {
  linkedin: "worldunboxer~rapid-linkedin-scraper",
  indeed: "borderline~indeed-scraper",
};

export type JobSource = "linkedin" | "indeed";

function actorPath(source: JobSource): string {
  if (source === "indeed") return process.env.SIGNALS_APIFY_ACTOR_INDEED ?? ACTORS.indeed;
  return process.env.SIGNALS_APIFY_ACTOR ?? ACTORS.linkedin;
}

// Settings-stored key first (the same order contacts.ts uses — the encrypted
// store is the operator's canonical home for it), then the environment under
// its various casings. This module was the one Apify consumer that read env
// only, which had the daily cron failing for weeks while Settings truthfully
// said the key was configured.
async function apifyToken(): Promise<string> {
  const stored = await getSecret("apify_api_key").catch(() => null);
  if (stored) return stored;
  const direct = process.env.APIFY_TOKEN || process.env.APIFY_API_KEY;
  if (direct) return direct;
  for (const [key, value] of Object.entries(process.env)) {
    if (value && /^apify[_-]?(?:api[_-]?)?(?:key|token)$/i.test(key)) return value;
  }
  return "";
}

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

/* ── Item normalization ─────────────────────────────────────────────── */

export type NormalizedJob = {
  source: JobSource;
  externalJobId: string;
  jobUrl: string;
  title: string;
  companyName: string;
  companyLinkedinUrl: string | null;
  companyIndeedUrl: string | null;
  companyLogoUrl: string | null;
  // Indeed company profiles report an employee-count range ("51 to 200").
  companyHeadcount: { count: number; label: string } | null;
  location: string | null;
  timePosted: string | null;
  postedAt: string | null;
  numApplicants: string | null;
  salaryRange: string | null;
  seniorityLevel: string | null;
  employmentType: string | null;
  jobFunction: string | null;
  industries: string | null;
  easyApply: boolean | null;
  applyUrl: string | null;
  contactEmail: string | null;
  description: string | null;
  searchKeyword: string | null;
  raw: Record<string, unknown>;
};

// "5 days ago" / "2 weeks ago" / "just now" -> absolute timestamp relative to
// ingest. Approximate by design; the raw label is stored alongside.
export function parsePostedAt(label: string, now: Date): string | null {
  const text = label.trim().toLowerCase();
  if (!text) return null;
  if (/just now|moments? ago|today/.test(text)) return now.toISOString();
  const match = text.match(/(\d+)\s+(minute|hour|day|week|month|year)s?\s+ago/);
  if (!match) return null;
  const amount = Number(match[1]);
  const unitMs: Record<string, number> = {
    minute: 60_000,
    hour: 3_600_000,
    day: 86_400_000,
    week: 7 * 86_400_000,
    month: 30 * 86_400_000,
    year: 365 * 86_400_000,
  };
  return new Date(now.getTime() - amount * unitMs[match[2]]).toISOString();
}

// Canonical identity for the SAME real-world company across automations, used
// by the profile lease so research and rosters are bought once. The LinkedIn
// slug is the strongest signal, then the domain; a bare name is last because
// two unrelated "Acme Logistics" would otherwise share a research brief.
export function profileKeyFor(linkedinUrl: string | null, domain: string | null, nameKey: string): string {
  const slug = linkedinUrl?.match(/linkedin\.com\/company\/([^/?#]+)/i)?.[1]?.toLowerCase();
  if (slug && !/^\d+$/.test(slug)) return slug;
  const host = domain?.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").split("/")[0];
  if (host) return host;
  return `name:${nameKey}`;
}

// Company comparison key: lowercase, drop legal suffixes and punctuation.
// Mirrors enrichment/apify.ts's normCompany so both features agree on
// "same company". Conservative: an empty key falls back to the raw name.
export function companyNameKey(name: string): string {
  const key = String(name || "")
    .normalize("NFKC")
    .replace(/[­​-‏‪-‮⁠-⁤﻿]/g, "")
    .toLowerCase()
    .replace(/[.,/#!$%^&*;:{}=\-_`~()"']/g, " ")
    .replace(/\b(inc|llc|l\.?l\.?c|ltd|limited|gmbh|corp|corporation|co|company|plc|s\.?a|ag|bv|b\.?v|pty|group|holdings?|the)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return key || String(name || "").trim().toLowerCase();
}

// "10,000+" -> 10000 · "51 to 200" -> 126 (midpoint) · "1,001 to 5,000" -> 3001.
export function parseHeadcountRange(label: string): number | null {
  const numbers = label.match(/[\d,]+/g)?.map((part) => Number(part.replace(/,/g, ""))).filter((n) => Number.isFinite(n) && n > 0) ?? [];
  if (numbers.length === 0) return null;
  if (numbers.length === 1) return numbers[0];
  return Math.round((numbers[0] + numbers[1]) / 2);
}

export function normalizeLinkedinItem(item: unknown, now: Date): NormalizedJob | null {
  if (!item || typeof item !== "object") return null;
  const it = item as Record<string, unknown>;
  const externalJobId = str(it.job_id);
  const title = str(it.job_title);
  const companyName = str(it.company_name);
  if (!externalJobId || !title || !companyName) return null;
  const timePosted = str(it.time_posted) || null;
  // The raw HTML duplicates job_description at ~2KB per row; drop it.
  const raw = { ...it };
  delete raw.job_description_raw_html;
  return {
    source: "linkedin",
    externalJobId,
    jobUrl: str(it.job_url) || `https://www.linkedin.com/jobs/view/${externalJobId}`,
    title,
    companyName,
    companyLinkedinUrl: str(it.company_url) || null,
    companyIndeedUrl: null,
    companyLogoUrl: str(it.company_logo_url) || null,
    companyHeadcount: null,
    location: str(it.location) || null,
    timePosted,
    postedAt: timePosted ? parsePostedAt(timePosted, now) : null,
    numApplicants: str(it.num_applicants) || null,
    salaryRange: str(it.salary_range) || null,
    seniorityLevel: str(it.seniority_level) || null,
    employmentType: str(it.employment_type) || null,
    jobFunction: str(it.job_function) || null,
    industries: str(it.industries) || null,
    easyApply: typeof it.easy_apply === "boolean" ? it.easy_apply : null,
    applyUrl: str(it.apply_url) || null,
    contactEmail: str(it.contact_email) || null,
    description: str(it.job_description) || null,
    searchKeyword: str(it.search_keyword) || null,
    raw,
  };
}

export function normalizeIndeedItem(item: unknown, now: Date, searchKeyword: string | null): NormalizedJob | null {
  if (!item || typeof item !== "object") return null;
  const it = item as Record<string, unknown>;
  const externalJobId = str(it.jobKey);
  const title = str(it.title);
  const companyName = str(it.companyName);
  if (!externalJobId || !title || !companyName) return null;

  const location = (it.location ?? {}) as Record<string, unknown>;
  const salary = (it.salary ?? {}) as Record<string, unknown>;
  const salaryText =
    str(salary.text) ||
    (typeof salary.min === "number" || typeof salary.max === "number"
      ? [salary.min, salary.max].filter((n) => typeof n === "number").join(" - ")
      : "");
  const jobTypes = Array.isArray(it.jobType) ? (it.jobType as unknown[]).map((t) => str(t)).filter(Boolean) : [];
  const occupations = Array.isArray(it.occupation) ? (it.occupation as unknown[]).map((o) => str(o)).filter(Boolean) : [];
  const emails = Array.isArray(it.emails) ? (it.emails as unknown[]).map((e) => str(e)).filter(Boolean) : [];
  const datePublished = str(it.datePublished);
  let postedAt: string | null = null;
  if (datePublished) {
    const parsed = new Date(datePublished);
    if (!Number.isNaN(parsed.getTime())) postedAt = parsed.toISOString();
  }
  const headcountLabel = str(it.companyNumEmployees);
  const headcount = headcountLabel ? parseHeadcountRange(headcountLabel) : null;

  const raw = { ...it };
  delete raw.descriptionHtml;

  return {
    source: "indeed",
    externalJobId,
    jobUrl: str(it.jobUrl) || `https://www.indeed.com/viewjob?jk=${externalJobId}`,
    title,
    companyName,
    companyLinkedinUrl: null,
    companyIndeedUrl: str(it.companyUrl) || null,
    companyLogoUrl: str(it.companyLogoUrl) || null,
    companyHeadcount: headcount !== null ? { count: headcount, label: headcountLabel } : null,
    location: str(location.formattedAddressShort) || str(location.city) || null,
    timePosted: str(it.age) || null,
    postedAt: postedAt ?? (str(it.age) ? parsePostedAt(str(it.age), now) : null),
    numApplicants: null,
    salaryRange: salaryText || null,
    seniorityLevel: null,
    employmentType: jobTypes.join(", ") || null,
    jobFunction: null,
    industries: occupations.join(", ") || null,
    easyApply: null,
    applyUrl: str(it.applyUrl) || null,
    contactEmail: emails[0] ?? null,
    description: str(it.descriptionText) || null,
    searchKeyword,
    raw,
  };
}

/* ── Actor run lifecycle ────────────────────────────────────────────── */

type SearchConfigRow = {
  id: string;
  automation_id: string;
  source: JobSource;
  job_titles: string[] | null;
  location: string | null;
  cities: string[] | null;
  experience: string | null;
  employment_type: string | null;
  work_arrangement: string | null;
  posted_within: string | null;
  max_jobs: number;
};

function buildLinkedinInput(search: SearchConfigRow): Record<string, unknown> {
  const input: Record<string, unknown> = {
    jobs_titles: (search.job_titles ?? []).filter(Boolean),
    location: search.location || "United States",
    jobs_entries: search.max_jobs,
  };
  const cities = (search.cities ?? []).filter(Boolean);
  if (cities.length > 0) input.cities = cities;
  if (search.experience) input.experience = search.experience;
  if (search.employment_type) input.employment_type = search.employment_type;
  if (search.work_arrangement) input.work_arrangement = search.work_arrangement;
  if (search.posted_within && search.posted_within !== "Any Time") input.posted_within = search.posted_within;
  return input;
}

// Our shared search fields → borderline/indeed-scraper's dialect. One query
// per run, so the caller fans out one run per title.
function buildIndeedInput(search: SearchConfigRow, title: string, maxRows: number): Record<string, unknown> {
  const input: Record<string, unknown> = {
    country: "us",
    query: title,
    maxRows,
    sort: "date",
  };
  if (search.location && !/^united states$/i.test(search.location.trim())) input.location = search.location;
  const posted: Record<string, string> = { "Past 24 hours": "1", "Past Week": "7", "Past Month": "14" };
  if (search.posted_within && posted[search.posted_within]) input.fromDays = posted[search.posted_within];
  const jobType: Record<string, string> = {
    "Full-time": "fulltime",
    "Part-time": "parttime",
    Contract: "contract",
    Temporary: "temporary",
    Internship: "internship",
  };
  if (search.employment_type && jobType[search.employment_type]) input.jobType = jobType[search.employment_type];
  if (search.work_arrangement === "Remote") input.remote = "remote";
  if (search.work_arrangement === "Hybrid") input.remote = "hybrid";
  const level: Record<string, string> = {
    Intern: "entry_level",
    Assistant: "entry_level",
    Junior: "entry_level",
    "Mid-Senior": "mid_level",
    Director: "senior_level",
    Executive: "senior_level",
  };
  if (search.experience && level[search.experience]) input.level = level[search.experience];
  return input;
}

function toRunDto(row: {
  id: string;
  search_id: string;
  status: string;
  jobs_found: number | null;
  jobs_new: number | null;
  jobs_seen_again: number | null;
  error: string | null;
  started_at: string;
  finished_at: string | null;
}): SignalRunDto {
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

const RUN_COLUMNS = "id, search_id, status, jobs_found, jobs_new, jobs_seen_again, error, started_at, finished_at";

async function startApifyRun(actor: string, input: Record<string, unknown>, token: string): Promise<{ id: string; datasetId: string | null }> {
  const start = await fetch(`https://api.apify.com/v2/acts/${actor}/runs`, {
    method: "POST",
    headers: { "content-type": "application/json", ...apifyAuth(token) },
    body: JSON.stringify(input),
    signal: AbortSignal.timeout(30_000),
  });
  const startJson = (await start.json().catch(() => ({}))) as {
    data?: { id?: string; defaultDatasetId?: string };
    error?: { message?: string };
  };
  if (!start.ok || !startJson.data?.id) {
    throw new Error(`Apify run start failed: HTTP ${start.status} ${startJson.error?.message ?? ""}`.trim());
  }
  return { id: startJson.data.id, datasetId: startJson.data.defaultDatasetId ?? null };
}

// Start the scrape(s) for a saved search and record them. LinkedIn covers all
// titles in one actor run; Indeed takes one query per run, so we fan out one
// run per title (the per-run row cap splits max_jobs across titles). Run rows
// carry the Apify run id, so ingestion is not tied to this request surviving.
// sampleLimit caps rows for a test run: prove the automation finds the right
// companies for cents before letting it loose on the full search.
export async function startHiringRuns(searchId: string, sampleLimit?: number): Promise<SignalRunDto[]> {
  const token = await apifyToken();
  if (!token) throw new Error("Missing Apify token. Add it under Settings → Integrations, or set APIFY_TOKEN.");
  const db = getAdminClient();

  const { data: search, error: searchError } = await db
    .from("signal_searches")
    .select("id, automation_id, source, job_titles, location, cities, experience, employment_type, work_arrangement, posted_within, max_jobs")
    .eq("id", searchId)
    .maybeSingle();
  if (searchError || !search) throw new Error(searchError?.message ?? "Search not found.");
  const config = search as SearchConfigRow;
  const titles = (config.job_titles ?? []).filter(Boolean);
  if (titles.length === 0) throw new Error("Search has no job titles.");

  // One live scrape batch per search: a concurrent duplicate would only
  // double-bill and race the same dedupe window.
  const { data: open } = await db
    .from("signal_runs")
    .select("id")
    .eq("search_id", searchId)
    .in("status", ["running", "ingesting"])
    .limit(1);
  if ((open ?? []).length > 0) throw new Error("A scrape for this search is already running.");

  if (sampleLimit && sampleLimit > 0) config.max_jobs = Math.min(config.max_jobs, sampleLimit);
  const source = config.source === "indeed" ? "indeed" : "linkedin";
  const starts: { apifyRunId: string; datasetId: string | null }[] = [];
  if (source === "linkedin") {
    const started = await startApifyRun(actorPath("linkedin"), buildLinkedinInput(config), token);
    starts.push({ apifyRunId: started.id, datasetId: started.datasetId });
  } else {
    const perTitle = Math.max(5, Math.ceil(config.max_jobs / titles.length));
    for (const title of titles) {
      const started = await startApifyRun(actorPath("indeed"), buildIndeedInput(config, title, perTitle), token);
      starts.push({ apifyRunId: started.id, datasetId: started.datasetId });
    }
  }

  const { data: runs, error: insertError } = await db
    .from("signal_runs")
    .insert(starts.map((start) => ({ search_id: searchId, automation_id: config.automation_id, apify_run_id: start.apifyRunId, apify_dataset_id: start.datasetId, status: "running" })))
    .select(RUN_COLUMNS);
  if (insertError || !runs || runs.length === 0) {
    throw new Error(`Scrape started on Apify but could not be recorded: ${insertError?.message}`);
  }
  await db.from("signal_searches").update({ last_run_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq("id", searchId);
  return (runs as Parameters<typeof toRunDto>[0][]).map(toRunDto);
}

// Advance a run: poll Apify once; on SUCCEEDED claim the ingest (status CAS so
// two pollers never double-ingest) and upsert companies + jobs. Safe to call
// from any request at any time — this is what makes runs survive a closed tab.
export async function checkHiringRun(runId: string): Promise<SignalRunDto> {
  const db = getAdminClient();
  const { data: run, error } = await db.from("signal_runs").select(`${RUN_COLUMNS}, apify_run_id, apify_dataset_id`).eq("id", runId).maybeSingle();
  if (error || !run) throw new Error(error?.message ?? "Run not found.");
  if (run.status === "succeeded" || run.status === "failed") return toRunDto(run);
  if (run.status === "ingesting") return toRunDto(run);

  const token = await apifyToken();
  if (!token) throw new Error("Missing Apify token. Add it under Settings → Integrations, or set APIFY_TOKEN.");

  const st = await fetch(`https://api.apify.com/v2/actor-runs/${run.apify_run_id}`, { headers: apifyAuth(token), signal: AbortSignal.timeout(30_000) });
  const stJson = (await st.json().catch(() => ({}))) as { data?: { status?: string; defaultDatasetId?: string } };
  const apifyStatus = stJson.data?.status ?? "";

  if (apifyStatus === "FAILED" || apifyStatus === "ABORTED" || apifyStatus === "TIMED-OUT") {
    const { data: failed } = await db
      .from("signal_runs")
      .update({ status: "failed", error: `Apify run ${apifyStatus}.`, finished_at: new Date().toISOString() })
      .eq("id", runId)
      .select(RUN_COLUMNS)
      .single();
    return failed ? toRunDto(failed) : toRunDto({ ...run, status: "failed" });
  }
  if (apifyStatus !== "SUCCEEDED") return toRunDto(run); // READY / RUNNING — poll again later.

  // Claim the ingest step.
  const { data: claimed } = await db
    .from("signal_runs")
    .update({ status: "ingesting" })
    .eq("id", runId)
    .eq("status", "running")
    .select("id");
  if ((claimed ?? []).length === 0) {
    const { data: latest } = await db.from("signal_runs").select(RUN_COLUMNS).eq("id", runId).single();
    return latest ? toRunDto(latest) : toRunDto(run);
  }

  try {
    // The search's source decides which normalizer reads the dataset.
    const { data: searchRow } = await db.from("signal_searches").select("source, job_titles, automation_id").eq("id", run.search_id).maybeSingle();
    const source: JobSource = searchRow?.source === "indeed" ? "indeed" : "linkedin";
    const datasetId = run.apify_dataset_id ?? stJson.data?.defaultDatasetId;
    const res = await fetch(`https://api.apify.com/v2/datasets/${datasetId}/items?clean=true`, {
      headers: apifyAuth(token),
      signal: AbortSignal.timeout(120_000),
    });
    if (!res.ok) throw new Error(`Dataset fetch failed: HTTP ${res.status}`);
    const items = (await res.json().catch(() => [])) as unknown[];
    const automationId = String(searchRow?.automation_id ?? "");
    if (!automationId) throw new Error("Search is not attached to an automation.");
    const stats = await ingestJobs(run.search_id, runId, source, Array.isArray(items) ? items : [], automationId);
    const { data: done } = await db
      .from("signal_runs")
      .update({
        status: "succeeded",
        jobs_found: stats.found,
        jobs_new: stats.inserted,
        jobs_seen_again: stats.seenAgain,
        finished_at: new Date().toISOString(),
      })
      .eq("id", runId)
      .select(RUN_COLUMNS)
      .single();
    return done ? toRunDto(done) : toRunDto({ ...run, status: "succeeded" });
  } catch (ingestError) {
    const message = ingestError instanceof Error ? ingestError.message : "Ingest failed.";
    const { data: failed } = await db
      .from("signal_runs")
      .update({ status: "failed", error: message.slice(0, 500), finished_at: new Date().toISOString() })
      .eq("id", runId)
      .select(RUN_COLUMNS)
      .single();
    return failed ? toRunDto(failed) : toRunDto({ ...run, status: "failed" });
  }
}

// Upsert companies (dedupe on name_key) then jobs (dedupe on source +
// external id). Re-seen jobs get a fresh last_seen_at; their first-seen
// provenance (search_id, run_id, first_seen_at, triage status) is untouched.
async function ingestJobs(
  searchId: string,
  runId: string,
  source: JobSource,
  items: unknown[],
  automationId: string,
): Promise<{ found: number; inserted: number; seenAgain: number }> {
  const db = getAdminClient();
  const now = new Date();
  const jobs = items
    .map((item) => (source === "indeed" ? normalizeIndeedItem(item, now, null) : normalizeLinkedinItem(item, now)))
    .filter((job): job is NormalizedJob => job !== null);
  // Duplicate ids inside one dataset would make a single upsert statement
  // fail ("cannot affect row a second time"), so collapse them first.
  const byJobId = new Map<string, NormalizedJob>();
  for (const job of jobs) if (!byJobId.has(job.externalJobId)) byJobId.set(job.externalJobId, job);
  const unique = [...byJobId.values()];
  if (unique.length === 0) return { found: items.length, inserted: 0, seenAgain: 0 };

  // Companies: insert only the missing keys — a plain upsert would overwrite
  // research fields and operator-curated data on existing rows.
  const byKey = new Map<string, NormalizedJob>();
  for (const job of unique) {
    const key = companyNameKey(job.companyName);
    if (!byKey.has(key)) byKey.set(key, job);
  }
  const keys = [...byKey.keys()];
  // Scoped to this automation: another automation's row for the same company
  // carries ITS verdict, and writing into it would silently overwrite that.
  const { data: existingCompanies, error: companiesError } = await db
    .from("signal_companies")
    .select("id, name_key")
    .eq("automation_id", automationId)
    .in("name_key", keys);
  if (companiesError) throw new Error(`Company lookup failed: ${companiesError.message}`);
  const companyIdByKey = new Map((existingCompanies ?? []).map((row) => [row.name_key as string, row.id as string]));
  const missing = keys.filter((key) => !companyIdByKey.has(key));
  if (missing.length > 0) {
    const rows = missing.map((key) => {
      const job = byKey.get(key)!;
      return {
        automation_id: automationId,
        name: job.companyName,
        name_key: key,
        // Canonical cross-automation identity, so the profile lease can tell
        // that two automations found the same real company.
        profile_key: profileKeyFor(job.companyLinkedinUrl, null, key),
        linkedin_url: job.companyLinkedinUrl,
        indeed_url: job.companyIndeedUrl,
        logo_url: job.companyLogoUrl,
        industries: job.industries,
      };
    });
    // ignoreDuplicates guards the ingest-vs-ingest race on (automation, name).
    const { data: created, error: insertError } = await db
      .from("signal_companies")
      .upsert(rows, { onConflict: "automation_id,name_key", ignoreDuplicates: true })
      .select("id, name_key");
    if (insertError) throw new Error(`Company insert failed: ${insertError.message}`);
    for (const row of created ?? []) companyIdByKey.set(row.name_key as string, row.id as string);
    const unmapped = missing.filter((key) => !companyIdByKey.has(key));
    if (unmapped.length > 0) {
      const { data: refetched } = await db
        .from("signal_companies")
        .select("id, name_key")
        .eq("automation_id", automationId)
        .in("name_key", unmapped);
      for (const row of refetched ?? []) companyIdByKey.set(row.name_key as string, row.id as string);
    }
  }

  // Indeed company profiles carry a reported employee-count range: better
  // than an LLM estimate, weaker than a verified source — never downgrade
  // 'verified', always upgrade 'llm_estimate' or unknown.
  for (const [key, job] of byKey) {
    const companyId = companyIdByKey.get(key);
    if (!companyId) continue;
    if (job.companyHeadcount) {
      await db
        .from("signal_companies")
        .update({
          headcount: job.companyHeadcount.count,
          headcount_source: "indeed_profile",
          headcount_confidence: "high",
          indeed_url: job.companyIndeedUrl,
          updated_at: now.toISOString(),
        })
        .eq("id", companyId)
        // NULL never matches .neq — spell out "unset or non-verified".
        .or("headcount_source.is.null,headcount_source.neq.verified");
    } else if (job.companyIndeedUrl) {
      await db.from("signal_companies").update({ indeed_url: job.companyIndeedUrl }).eq("id", companyId).is("indeed_url", null);
    }
  }

  const jobIds = unique.map((job) => job.externalJobId);
  // Scoped to this automation. Globally-scoped, a posting already ingested by
  // another automation would read as "seen", this automation would record no
  // evidence for it, and its company would never be evaluated at all.
  const { data: existingJobs, error: existingError } = await db
    .from("signal_jobs")
    .select("external_job_id")
    .eq("automation_id", automationId)
    .eq("source", source)
    .in("external_job_id", jobIds);
  if (existingError) throw new Error(`Job lookup failed: ${existingError.message}`);
  const seen = new Set((existingJobs ?? []).map((row) => row.external_job_id as string));

  const fresh = unique.filter((job) => !seen.has(job.externalJobId));
  if (fresh.length > 0) {
    const rows = fresh.map((job) => ({
      automation_id: automationId,
      search_id: searchId,
      run_id: runId,
      company_id: companyIdByKey.get(companyNameKey(job.companyName)) ?? null,
      source: job.source,
      external_job_id: job.externalJobId,
      job_url: job.jobUrl,
      title: job.title,
      company_name: job.companyName,
      company_linkedin_url: job.companyLinkedinUrl,
      company_logo_url: job.companyLogoUrl,
      location: job.location,
      time_posted: job.timePosted,
      posted_at: job.postedAt,
      num_applicants: job.numApplicants,
      salary_range: job.salaryRange,
      seniority_level: job.seniorityLevel,
      employment_type: job.employmentType,
      job_function: job.jobFunction,
      industries: job.industries,
      easy_apply: job.easyApply,
      apply_url: job.applyUrl,
      contact_email: job.contactEmail,
      description: job.description,
      search_keyword: job.searchKeyword,
      raw: job.raw,
    }));
    const { error: jobsError } = await db.from("signal_jobs").upsert(rows, { onConflict: "automation_id,source,external_job_id", ignoreDuplicates: true });
    if (jobsError) throw new Error(`Job insert failed: ${jobsError.message}`);
  }
  if (seen.size > 0) {
    await db
      .from("signal_jobs")
      .update({ last_seen_at: now.toISOString() })
      .eq("automation_id", automationId)
      .eq("source", source)
      .in("external_job_id", [...seen]);
  }

  // Funnel hook: fresh postings are new evidence. Companies already through
  // the funnel get flagged for auto re-evaluation (kills can resurrect,
  // qualified rows refresh); pending ones just get their rollup updated.
  const touchedCompanyIds = [...new Set(fresh.map((job) => companyIdByKey.get(companyNameKey(job.companyName))).filter((id): id is string => Boolean(id)))];
  for (const companyId of touchedCompanyIds) {
    const { data: companyRow } = await db.from("signal_companies").select("funnel_state, flags").eq("id", companyId).maybeSingle();
    if (!companyRow) continue;
    const { count } = await db.from("signal_jobs").select("id", { count: "exact", head: true }).eq("company_id", companyId);
    const flags = { ...((companyRow.flags ?? {}) as Record<string, unknown>) };
    if (["qualified", "killed", "errored"].includes(companyRow.funnel_state as string)) flags.newEvidence = true;
    await db
      .from("signal_companies")
      .update({ evidence_count: count ?? 0, latest_evidence_at: now.toISOString(), flags, updated_at: now.toISOString() })
      .eq("id", companyId);
  }

  return { found: items.length, inserted: fresh.length, seenAgain: seen.size };
}
