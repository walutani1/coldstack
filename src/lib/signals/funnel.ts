import "server-only";

import { getAdminClient } from "@/lib/supabase/admin";
import { checkHiringRun, startHiringRuns } from "@/lib/signals/apify-jobs";
import { advanceContactSourcing } from "@/lib/signals/contacts";
import { getEffectiveConfig } from "@/lib/signals/automations";
import { getFunnelConfigVersion } from "@/lib/signals/config";
import {
  composeScore,
  estimateUsd,
  SpendCapError,
  stageAgency,
  stageIndustry,
  stageJdScoring,
  stageResearch,
  stageRollup,
  stageSize,
  stageTitleGate,
  type EvidenceJob,
  type PipelineCompany,
  type SpendTracker,
  type StageOutcome,
} from "@/lib/signals/stages";
import type { FunnelConfig, FunnelRunDto, FunnelStage } from "@/lib/signals/types";

// The funnel engine. One funnel run at a time; poll-driven ticks advance it
// (scrape phase, then claim-and-process one company per tick so a tick stays
// within a serverless request). The run row is durable — any later tick can
// finish the work, so progress never depends on a tab staying open.
//
// NOTE for the cron phase: ticks are currently driven by client polling
// (pollFunnelAction). The cron trigger just calls the same tickFunnelRun in a
// route handler loop — no engine changes needed.

const RUN_COLUMNS = "id, automation_id, status, trigger, config_version, search_ids, stats, spend_estimate_usd, spend_cap_usd, error, started_at, finished_at";

type RunRow = {
  id: string;
  automation_id: string;
  status: string;
  trigger: string;
  config_version: number | null;
  search_ids: string[];
  stats: Record<string, unknown>;
  spend_estimate_usd: number | string;
  spend_cap_usd: number | string | null;
  error: string | null;
  started_at: string;
  finished_at: string | null;
};

function toRunDto(row: RunRow): FunnelRunDto {
  return {
    id: row.id,
    automationId: row.automation_id,
    status: row.status as FunnelRunDto["status"],
    trigger: row.trigger as FunnelRunDto["trigger"],
    configVersion: row.config_version,
    searchIds: row.search_ids ?? [],
    stats: (row.stats ?? {}) as FunnelRunDto["stats"],
    spendEstimateUsd: Number(row.spend_estimate_usd ?? 0),
    spendCapUsd: row.spend_cap_usd === null ? null : Number(row.spend_cap_usd),
    error: row.error,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  };
}

async function loadRun(runId: string): Promise<RunRow> {
  const db = getAdminClient();
  const { data, error } = await db.from("signal_funnel_runs").select(RUN_COLUMNS).eq("id", runId).maybeSingle();
  if (error || !data) throw new Error(error?.message ?? "Funnel run not found.");
  return data as RunRow;
}

async function patchRun(runId: string, patch: Record<string, unknown>): Promise<RunRow> {
  const db = getAdminClient();
  const { data, error } = await db.from("signal_funnel_runs").update(patch).eq("id", runId).select(RUN_COLUMNS).single();
  if (error || !data) throw new Error(error?.message ?? "Could not update funnel run.");
  return data as RunRow;
}

// Latest finished run — feeds the results table's "Last run" summary line.
export async function getLastFinishedFunnelRun(automationId?: string): Promise<FunnelRunDto | null> {
  const db = getAdminClient();
  let query = db.from("signal_funnel_runs").select(RUN_COLUMNS).in("status", ["succeeded", "failed"]);
  if (automationId) query = query.eq("automation_id", automationId);
  const { data, error } = await query.order("started_at", { ascending: false }).limit(1).maybeSingle();
  if (error) throw new Error(`Could not load the last run: ${error.message}`);
  return data ? toRunDto(data as RunRow) : null;
}

// One open run PER AUTOMATION (a partial unique index enforces it in the DB) —
// two automations may run at once because their companies no longer overlap.
export async function getOpenFunnelRun(automationId?: string): Promise<FunnelRunDto | null> {
  const db = getAdminClient();
  let query = db.from("signal_funnel_runs").select(RUN_COLUMNS).in("status", ["running", "paused"]);
  if (automationId) query = query.eq("automation_id", automationId);
  const { data, error } = await query.order("started_at", { ascending: false }).limit(1).maybeSingle();
  if (error) throw new Error(`Could not load funnel run: ${error.message}`);
  return data ? toRunDto(data as RunRow) : null;
}

export async function getOpenFunnelRuns(): Promise<FunnelRunDto[]> {
  const db = getAdminClient();
  const { data, error } = await db.from("signal_funnel_runs").select(RUN_COLUMNS).in("status", ["running", "paused"]);
  if (error) throw new Error(`Could not load funnel runs: ${error.message}`);
  return ((data ?? []) as RunRow[]).map(toRunDto);
}

/* ── Start ──────────────────────────────────────────────────────────── */

// Manual "Run funnel": scrape every active search, then process companies
// with new/changed evidence. `reevaluate` skips scraping and re-runs existing
// companies against the active config instead.
export async function startFunnelRun(options: {
  trigger: "manual" | "reevaluate" | "cron";
  automationId: string;
  companyId?: string;
  // Test run: scrape a small slice and judge it without touching a campaign.
  sampleLimit?: number;
}): Promise<FunnelRunDto> {
  const db = getAdminClient();
  const open = await getOpenFunnelRun(options.automationId);
  if (open) throw new Error(open.status === "paused" ? "This automation has a paused run — resume or stop it first." : "This automation is already running.");

  const { config, version, criteria } = await getEffectiveConfig(options.automationId);

  let searchIds: string[] = [];
  const scrapeRunIds: string[] = [];
  if (options.trigger !== "reevaluate") {
    const { data: searches, error } = await db
      .from("signal_searches")
      .select("id")
      .eq("archived", false)
      .eq("automation_id", options.automationId);
    if (error) throw new Error(`Could not load searches: ${error.message}`);
    searchIds = (searches ?? []).map((row) => row.id as string);
    if (searchIds.length === 0) throw new Error("This automation has no searches yet — add at least one job title first.");
  } else {
    // Re-evaluation: reset THIS automation's companies to pending (state only —
    // review decisions, overrides, and audit history are untouched).
    let query = db
      .from("signal_companies")
      .update({ funnel_state: "pending", claimed_at: null })
      .eq("automation_id", options.automationId)
      .in("funnel_state", ["qualified", "killed", "errored"]);
    if (options.companyId) query = query.eq("id", options.companyId);
    const { error } = await query;
    if (error) throw new Error(`Could not queue re-evaluation: ${error.message}`);
  }

  const { data: run, error: insertError } = await db
    .from("signal_funnel_runs")
    .insert({
      automation_id: options.automationId,
      trigger: options.trigger,
      config_version: version,
      // Snapshot the targeting so the audit stays truthful after an edit.
      effective_criteria: criteria,
      search_ids: searchIds,
      spend_cap_usd: config.spend.perRunCapUsd,
      stats: {
        phase: options.trigger === "reevaluate" ? "processing" : "scraping",
        scrapeRunIds: [],
        ...(options.sampleLimit ? { sampleLimit: options.sampleLimit, testRun: true } : {}),
      },
    })
    .select(RUN_COLUMNS)
    .single();
  if (insertError || !run) throw new Error(`Could not create funnel run: ${insertError?.message}`);

  await db.from("signal_automations").update({ last_run_at: new Date().toISOString() }).eq("id", options.automationId);

  if (options.trigger !== "reevaluate") {
    // Start scrapes now; failures on individual searches don't sink the run.
    const failures: string[] = [];
    for (const searchId of searchIds) {
      try {
        const scrapes = await startHiringRuns(searchId, options.sampleLimit);
        scrapeRunIds.push(...scrapes.map((scrape) => scrape.id));
      } catch (error) {
        failures.push(error instanceof Error ? error.message : "scrape failed");
      }
    }
    if (scrapeRunIds.length === 0) {
      const failed = await patchRun(run.id, {
        status: "failed",
        error: `No scrapes could start: ${failures[0] ?? "unknown"}`,
        finished_at: new Date().toISOString(),
      });
      return toRunDto(failed);
    }
    const updated = await patchRun(run.id, {
      stats: { phase: "scraping", scrapeRunIds, scrapesTotal: scrapeRunIds.length, scrapesDone: 0, scrapeFailures: failures },
    });
    return toRunDto(updated);
  }
  return toRunDto(run as RunRow);
}

export async function pauseOrResumeFunnelRun(runId: string, action: "pause" | "resume" | "stop"): Promise<FunnelRunDto> {
  const run = await loadRun(runId);
  if (run.status === "succeeded" || run.status === "failed") return toRunDto(run);
  if (action === "pause") return toRunDto(await patchRun(runId, { status: "paused" }));
  if (action === "resume") return toRunDto(await patchRun(runId, { status: "running" }));
  return toRunDto(await patchRun(runId, { status: "failed", error: "Stopped by operator.", finished_at: new Date().toISOString() }));
}

/* ── Tick ───────────────────────────────────────────────────────────── */

// One poll-driven advance. Scrape phase: poll open scrapes (ingest happens in
// checkHiringRun). Processing phase: claim one company, run the pipeline.
export async function tickFunnelRun(runId: string): Promise<FunnelRunDto> {
  const db = getAdminClient();
  let run = await loadRun(runId);
  if (run.status !== "running") return toRunDto(run);

  const stats = { ...(run.stats ?? {}) } as Record<string, unknown>;

  // Phase A: scrapes.
  if (stats.phase === "scraping") {
    const scrapeRunIds = (stats.scrapeRunIds ?? []) as string[];
    let done = 0;
    let jobsFound = 0;
    let jobsNew = 0;
    for (const scrapeId of scrapeRunIds) {
      const scrape = await checkHiringRun(scrapeId);
      if (scrape.status === "succeeded" || scrape.status === "failed") {
        done += 1;
        jobsFound += scrape.jobsFound ?? 0;
        jobsNew += scrape.jobsNew ?? 0;
      }
    }
    stats.scrapesDone = done;
    stats.jobsFound = jobsFound;
    stats.jobsNew = jobsNew;
    if (done < scrapeRunIds.length) {
      run = await patchRun(runId, { stats });
      return toRunDto(run);
    }
    stats.phase = "processing";
    run = await patchRun(runId, { stats });
  }

  // Contact sourcing advances every processing tick, so rosters for freshly
  // qualified companies start while later companies are still being judged.
  // Roster spend (Apify, not tokens) is folded into the run's estimate.
  const automationId = run.automation_id;
  const contactsProgress = await advanceContactSourcing(automationId);
  stats.contactsActive = contactsProgress.active;
  if (contactsProgress.spendUsd > 0) {
    stats.contactsSpendUsd = Number((((stats.contactsSpendUsd as number) ?? 0) + contactsProgress.spendUsd).toFixed(4));
    const fresh = await loadRun(runId);
    await patchRun(runId, { spend_estimate_usd: (Number(fresh.spend_estimate_usd ?? 0) + contactsProgress.spendUsd).toFixed(4) });
  }

  // Phase B: claim one company (pending, new-evidence, or stale claim).
  const claimId = await claimNextCompany(automationId);
  if (!claimId) {
    // Companies are done; keep the run open while rosters are still landing
    // so the poll loop keeps driving them home.
    if (contactsProgress.active > 0) {
      run = await patchRun(runId, { stats });
      return toRunDto(run);
    }
    // Nothing left — finalize with totals and this run's kill breakdown
    // (feeds the "Last run" summary line; reused prior verdicts write no new
    // stage rows, so the breakdown covers freshly-decided kills).
    const totals = await countStates(automationId);
    const { data: killRows } = await db
      .from("signal_stage_results")
      .select("stage")
      .eq("funnel_run_id", runId)
      .eq("verdict", "kill");
    const stageKills: Record<string, number> = {};
    for (const row of killRows ?? []) {
      const stage = row.stage as string;
      stageKills[stage] = (stageKills[stage] ?? 0) + 1;
    }
    stats.phase = "done";
    stats.qualified = totals.qualified;
    stats.killed = totals.killed;
    stats.errored = totals.errored;
    stats.stageKills = stageKills;
    run = await patchRun(runId, { status: "succeeded", stats, finished_at: new Date().toISOString() });
    return toRunDto(run);
  }

  // The run pinned a global config version for prompt/model auditability;
  // this automation's criteria are layered back on so targeting stays its own.
  const configVersion = run.config_version;
  const pinned = configVersion !== null ? await getFunnelConfigVersion(configVersion) : null;
  const effective = await getEffectiveConfig(automationId);
  const activeConfig = pinned ? { ...pinned, ...criteriaSlice(effective.config) } : effective.config;

  const spendTracker = makeSpendTracker(runId, Number(run.spend_estimate_usd ?? 0), run.spend_cap_usd === null ? null : Number(run.spend_cap_usd), activeConfig);

  try {
    await runCompanyPipeline(claimId, activeConfig, configVersion, runId, spendTracker);
    stats.companiesProcessed = ((stats.companiesProcessed as number) ?? 0) + 1;
  } catch (error) {
    if (error instanceof SpendCapError) {
      // Unclaim and pause — resumable once the operator raises/accepts spend.
      await db.from("signal_companies").update({ funnel_state: "pending", claimed_at: null }).eq("id", claimId).eq("funnel_state", "processing");
      run = await patchRun(runId, { status: "paused", stats, error: "Spend cap reached — resume to continue." });
      return toRunDto(run);
    }
    throw error;
  }

  const { count: remaining } = await db
    .from("signal_companies")
    .select("id", { count: "exact", head: true })
    .eq("automation_id", automationId)
    .eq("funnel_state", "pending");
  stats.companiesRemaining = remaining ?? 0;
  run = await patchRun(runId, { stats });
  return toRunDto(run);
}

function criteriaSlice(config: FunnelConfig) {
  return {
    headcount: config.headcount,
    industries: config.industries,
    qualifiedThreshold: config.qualifiedThreshold,
    evidenceWindowDays: config.evidenceWindowDays,
  };
}

async function claimNextCompany(automationId: string): Promise<string | null> {
  const db = getAdminClient();
  const staleBefore = new Date(Date.now() - 5 * 60_000).toISOString();
  // Candidates: pending, flagged new-evidence, or a stale processing claim.
  const { data: candidates, error } = await db
    .from("signal_companies")
    .select("id, funnel_state, claimed_at, flags")
    // Scoped: without this, a concurrent automation's run could claim this
    // company and stamp its own config version and audit onto it.
    .eq("automation_id", automationId)
    .or(`funnel_state.eq.pending,and(funnel_state.eq.processing,claimed_at.lt.${staleBefore}),flags->>newEvidence.eq.true`)
    .order("updated_at", { ascending: true })
    .limit(5);
  if (error) throw new Error(`Could not find work: ${error.message}`);
  for (const candidate of candidates ?? []) {
    // CAS claim: only one tick wins a company.
    const { data: claimed } = await db
      .from("signal_companies")
      .update({ funnel_state: "processing", claimed_at: new Date().toISOString() })
      .eq("id", candidate.id)
      .neq("funnel_state", "processing")
      .select("id");
    if ((claimed ?? []).length > 0) return candidate.id as string;
    // Stale-claim reclaim path.
    if (candidate.funnel_state === "processing") {
      const { data: reclaimed } = await db
        .from("signal_companies")
        .update({ claimed_at: new Date().toISOString() })
        .eq("id", candidate.id)
        .eq("funnel_state", "processing")
        .lt("claimed_at", staleBefore)
        .select("id");
      if ((reclaimed ?? []).length > 0) return candidate.id as string;
    }
  }
  return null;
}

async function countStates(automationId: string): Promise<{ qualified: number; killed: number; errored: number }> {
  const db = getAdminClient();
  const countFor = async (state: string) => {
    const { count } = await db
      .from("signal_companies")
      .select("id", { count: "exact", head: true })
      .eq("automation_id", automationId)
      .eq("funnel_state", state);
    return count ?? 0;
  };
  const [qualified, killed, errored] = await Promise.all([countFor("qualified"), countFor("killed"), countFor("errored")]);
  return { qualified, killed, errored };
}

function makeSpendTracker(runId: string, alreadySpent: number, capUsd: number | null, config: FunnelConfig): SpendTracker {
  const db = getAdminClient();
  let spent = alreadySpent;
  return {
    companyTokens: { used: 0, cap: config.spend.perCompanyMaxTokens },
    checkBeforeCall: async () => {
      if (capUsd !== null && spent >= capUsd) {
        throw new SpendCapError(`Run spend estimate $${spent.toFixed(2)} reached the $${capUsd.toFixed(2)} cap.`);
      }
    },
    record: async (model, inputTokens, outputTokens) => {
      spent += estimateUsd(model, inputTokens, outputTokens);
      await db.from("signal_funnel_runs").update({ spend_estimate_usd: spent.toFixed(4) }).eq("id", runId);
    },
  };
}

/* ── Per-company pipeline ───────────────────────────────────────────── */

async function recordStage(companyId: string, runId: string | null, configVersion: number | null, outcome: StageOutcome & { error?: string | null }): Promise<void> {
  const db = getAdminClient();
  await db.from("signal_stage_results").insert({
    company_id: companyId,
    funnel_run_id: runId,
    stage: outcome.stage,
    verdict: outcome.verdict,
    output: outcome.output,
    rationale: outcome.rationale,
    raw_text: outcome.rawText,
    error: outcome.error ?? null,
    config_version: configVersion,
    model: outcome.model,
    input_tokens: outcome.inputTokens || null,
    output_tokens: outcome.outputTokens || null,
    latency_ms: outcome.latencyMs || null,
  });
}

// A prior AI-stage result is reusable when the stage-relevant config slice is
// unchanged and no new evidence arrived since it was produced. Deterministic
// stages always recompute (free).
async function reusableResult(
  companyId: string,
  stage: FunnelStage,
  latestEvidenceAt: string | null,
  activeSlice: string,
  sliceOf: (config: FunnelConfig) => string,
): Promise<Record<string, unknown> | null> {
  const db = getAdminClient();
  const { data } = await db
    .from("signal_stage_results")
    .select("verdict, output, config_version, created_at")
    .eq("company_id", companyId)
    .eq("stage", stage)
    .neq("verdict", "error")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!data || data.config_version === null) return null;
  if (latestEvidenceAt && String(data.created_at) < latestEvidenceAt) return null;
  const config = await getFunnelConfigVersion(data.config_version as number);
  if (!config || sliceOf(config) !== activeSlice) return null;
  return { verdict: data.verdict as string, output: (data.output ?? {}) as Record<string, unknown> };
}

export async function runCompanyPipeline(
  companyId: string,
  config: FunnelConfig,
  configVersion: number | null,
  runId: string | null,
  spend: SpendTracker,
): Promise<void> {
  const db = getAdminClient();
  const { data: companyRow, error: companyError } = await db
    .from("signal_companies")
    .select("id, name, domain, industries, headcount, headcount_source, headcount_confidence, linkedin_employee_count, headcount_anchor, research_status, research_brief, website_url, review_state, override, override_note, funnel_state, score, flags")
    .eq("id", companyId)
    .single();
  if (companyError || !companyRow) throw new Error(companyError?.message ?? "Company not found.");

  const windowStart = new Date(Date.now() - config.evidenceWindowDays * 86_400_000).toISOString();
  const { data: jobRows, error: jobsError } = await db
    .from("signal_jobs")
    .select("id, title, description, industries, seniority_level, posted_at, first_seen_at")
    .eq("company_id", companyId)
    .or(`posted_at.gte.${windowStart},and(posted_at.is.null,first_seen_at.gte.${windowStart})`)
    .order("first_seen_at", { ascending: false })
    .limit(30);
  if (jobsError) throw new Error(`Could not load evidence: ${jobsError.message}`);
  const evidence: EvidenceJob[] = (jobRows ?? []).map((row) => ({
    id: row.id as string,
    title: row.title as string,
    description: (row.description as string | null) ?? null,
    industries: (row.industries as string | null) ?? null,
    seniorityLevel: (row.seniority_level as string | null) ?? null,
    postedAt: (row.posted_at as string | null) ?? null,
    firstSeenAt: row.first_seen_at as string,
  }));

  const company: PipelineCompany = {
    id: companyRow.id as string,
    name: companyRow.name as string,
    domain: (companyRow.domain as string | null) ?? null,
    industries: (companyRow.industries as string | null) ?? null,
    headcount: (companyRow.headcount as number | null) ?? null,
    headcount_source: (companyRow.headcount_source as PipelineCompany["headcount_source"]) ?? null,
    headcount_confidence: (companyRow.headcount_confidence as PipelineCompany["headcount_confidence"]) ?? null,
    linkedin_employee_count: (companyRow.linkedin_employee_count as number | null) ?? null,
    headcount_anchor: (companyRow.headcount_anchor as number | null) ?? null,
    research_status: (companyRow.research_status as string) ?? "none",
    research_brief: (companyRow.research_brief as string | null) ?? null,
    flags: ((companyRow.flags ?? {}) as Record<string, unknown>),
  };
  const priorState = companyRow.funnel_state as string;
  const priorScore = companyRow.score as number | null;
  const reviewState = companyRow.review_state as string | null;
  const override = companyRow.override as "qualified" | "killed" | null;
  const latestEvidenceAt = evidence[0]?.firstSeenAt ?? null;

  const flags: Record<string, unknown> = { ...company.flags };
  delete flags.newEvidence;

  let killed: { stage: FunnelStage; reason: string } | null = null;
  let jdOutput: { industryFit: number; industryRationale: string; titleStrength: number; titleRationale: string; jdSignals: number; jdRationale: string; reportsTo?: string | null } | null = null;
  let currentStage: FunnelStage = "rollup";

  try {
    // No evidence in the window: nothing to judge — kill at rollup with a
    // clear reason (stale evidence, never contributes to the qualified list).
    if (evidence.length === 0) {
      const outcome: StageOutcome = { stage: "rollup", verdict: "kill", output: { evidenceCount: 0 }, rationale: `No postings within the ${config.evidenceWindowDays}-day evidence window.`, rawText: null, model: null, inputTokens: 0, outputTokens: 0, latencyMs: 0 };
      await recordStage(companyId, runId, configVersion, outcome);
      killed = { stage: "rollup", reason: outcome.rationale! };
    }

    // 1. Rollup + CRM overlap.
    if (!killed) {
      currentStage = "rollup";
      const rollup = await stageRollup(company, evidence);
      await recordStage(companyId, runId, configVersion, rollup);
      if ((rollup.output?.crmOverlap as boolean) === true) flags.crmOverlap = true;
      else delete flags.crmOverlap;
    }

    // 2. Industry screen (deterministic).
    if (!killed) {
      currentStage = "industry";
      const industry = stageIndustry(company, config);
      await recordStage(companyId, runId, configVersion, industry);
      if (industry.verdict === "kill") killed = { stage: "industry", reason: industry.rationale! };
      if ((industry.output?.unknownIndustry as boolean) === true) flags.unknownIndustry = true;
      else delete flags.unknownIndustry;
    }

    // 3. Agency screen (reusable AI).
    if (!killed) {
      currentStage = "agency";
      const slice = JSON.stringify({ p: config.prompts.agency, m: config.models.agency });
      const prior = await reusableResult(companyId, "agency", latestEvidenceAt, slice, (c) => JSON.stringify({ p: c.prompts.agency, m: c.models.agency }));
      if (prior) {
        if (prior.verdict === "kill") killed = { stage: "agency", reason: "Staffing agency (prior verdict reused)." };
      } else {
        const agency = await stageAgency(company, evidence, config, spend);
        await recordStage(companyId, runId, configVersion, agency);
        if (agency.verdict === "kill") killed = { stage: "agency", reason: agency.rationale! };
      }
    }

    // 4. Title gate (reusable AI) — deliberately BEFORE research: it needs
    // only titles + studio context (Haiku), so QA/test-automation noise dies
    // before we pay Firecrawl + Sonnet to research it (cheap kills first).
    let validTitles: string[] = [];
    if (!killed) {
      currentStage = "title_gate";
      const slice = JSON.stringify({ p: config.prompts.titleGate, m: config.models.titleGate, ctx: config.studioContext });
      const prior = await reusableResult(companyId, "title_gate", latestEvidenceAt, slice, (c) => JSON.stringify({ p: c.prompts.titleGate, m: c.models.titleGate, ctx: c.studioContext }));
      if (prior) {
        validTitles = Array.isArray(prior.output && (prior.output as Record<string, unknown>).validTitles) ? ((prior.output as Record<string, unknown>).validTitles as string[]) : [];
        if (prior.verdict === "kill") killed = { stage: "title_gate", reason: "No valid titles (prior verdict reused)." };
      } else {
        const gate = await stageTitleGate(company, evidence, config, spend);
        await recordStage(companyId, runId, configVersion, gate);
        validTitles = (gate.output?.validTitles as string[]) ?? [];
        if (gate.verdict === "kill") killed = { stage: "title_gate", reason: gate.rationale! };
      }
    }

    // 5. Research (reused when done).
    if (!killed) {
      currentStage = "research";
      const research = await stageResearch(company);
      if (research.verdict !== "skip") await recordStage(companyId, runId, configVersion, research);
    }

    // 6. Size filter (verified kills only; estimate is score-only + flag).
    if (!killed) {
      currentStage = "size";
      const size = await stageSize(company, config, spend);
      await recordStage(companyId, runId, configVersion, size);
      if (size.verdict === "kill") killed = { stage: "size", reason: size.rationale! };
      if (company.headcount_source === "llm_estimate") flags.estimateBased = true;
      else delete flags.estimateBased;
    }

    // 7. JD scoring (reusable AI).
    if (!killed) {
      currentStage = "jd_scoring";
      const slice = JSON.stringify({ p: config.prompts.jdScoring, m: config.models.jdScoring, ctx: config.studioContext, w: config.weights, n: config.jdTopN });
      const prior = await reusableResult(companyId, "jd_scoring", latestEvidenceAt, slice, (c) => JSON.stringify({ p: c.prompts.jdScoring, m: c.models.jdScoring, ctx: c.studioContext, w: c.weights, n: c.jdTopN }));
      if (prior && prior.output) {
        jdOutput = prior.output as unknown as typeof jdOutput;
      } else {
        const jd = await stageJdScoring(company, evidence, validTitles, config, spend);
        await recordStage(companyId, runId, configVersion, jd);
        jdOutput = jd.output as unknown as typeof jdOutput;
      }
      // Persist the reporting line so contact ranking can target that person
      // even on a later re-rank that never re-runs this stage.
      const reportsTo = (jdOutput as { reportsTo?: string | null } | null)?.reportsTo ?? null;
      await db.from("signal_companies").update({ reports_to_title: reportsTo }).eq("id", companyId);
    }

    // 8. Score composer + final state.
    currentStage = "score";
    const now = new Date().toISOString();
    if (!killed && jdOutput) {
      const { score, breakdown } = composeScore({ company, evidenceCount: evidence.length, jd: jdOutput, config });
      const qualified = score >= config.qualifiedThreshold;
      const scoreOutcome: StageOutcome = {
        stage: "score",
        verdict: qualified ? "pass" : "kill",
        output: { score, breakdown: breakdown as unknown as Record<string, unknown>[] } as unknown as Record<string, unknown>,
        rationale: `Score ${score}/100 vs threshold ${config.qualifiedThreshold} — ${qualified ? "qualified" : "below threshold"}.`,
        rawText: null, model: null, inputTokens: 0, outputTokens: 0, latencyMs: 0,
      };
      await recordStage(companyId, runId, configVersion, scoreOutcome);
      if (!qualified) killed = { stage: "score", reason: scoreOutcome.rationale! };

      if (priorState === "qualified" && priorScore !== null && priorScore !== score) flags.updated = true;

      // Sticky decisions: operator overrides and approved/archived reviews are
      // never flipped by re-evaluation (locked PRD rules).
      const sticky = override !== null || (priorState === "qualified" && (reviewState === "approved" || reviewState === "archived"));
      const finalQualified = override === "qualified" ? true : override === "killed" ? false : sticky && priorState === "qualified" ? true : qualified;

      await db
        .from("signal_companies")
        .update({
          funnel_state: finalQualified ? "qualified" : "killed",
          killed_stage: finalQualified ? null : (override === "killed" ? "override" : killed?.stage ?? null),
          kill_reason: finalQualified ? null : (override === "killed" ? (companyRow.override_note as string | null) ?? "Operator override." : killed?.reason ?? null),
          funnel_error: null,
          review_state: finalQualified ? (reviewState ?? "new") : reviewState,
          score,
          score_breakdown: breakdown,
          flags,
          evidence_count: evidence.length,
          latest_evidence_at: latestEvidenceAt,
          claimed_at: null,
          evaluated_config_version: configVersion,
          updated_at: now,
        })
        .eq("id", companyId);
      // Auto contact sourcing: a freshly qualified company queues its roster
      // pull (companies already sourced keep their contacts untouched).
      if (finalQualified) {
        await db.from("signal_companies").update({ contacts_state: "pending" }).eq("id", companyId).eq("contacts_state", "none");
      }
      return;
    }

    // Killed before scoring.
    const sticky = override === "qualified" || (priorState === "qualified" && (reviewState === "approved" || reviewState === "archived"));
    await db
      .from("signal_companies")
      .update(
        sticky
          ? { funnel_state: "qualified", flags: { ...flags, updated: true }, evidence_count: evidence.length, latest_evidence_at: latestEvidenceAt, claimed_at: null, evaluated_config_version: configVersion, updated_at: now }
          : {
              funnel_state: "killed",
              killed_stage: killed?.stage ?? null,
              kill_reason: killed?.reason ?? null,
              funnel_error: null,
              score: null,
              score_breakdown: null,
              flags,
              evidence_count: evidence.length,
              latest_evidence_at: latestEvidenceAt,
              claimed_at: null,
              evaluated_config_version: configVersion,
              updated_at: now,
            },
      )
      .eq("id", companyId);
    if (sticky) {
      await db.from("signal_companies").update({ contacts_state: "pending" }).eq("id", companyId).eq("contacts_state", "none");
    }
  } catch (error) {
    if (error instanceof SpendCapError) throw error;
    const message = (error instanceof Error ? error.message : "Stage failed.").slice(0, 500);
    await recordStage(companyId, runId, configVersion, {
      stage: currentStage,
      verdict: "error",
      output: null,
      rationale: null,
      rawText: null,
      model: null,
      inputTokens: 0,
      outputTokens: 0,
      latencyMs: 0,
      error: message,
    });
    await db
      .from("signal_companies")
      .update({ funnel_state: "errored", funnel_error: message, claimed_at: null, updated_at: new Date().toISOString() })
      .eq("id", companyId);
  }
}
