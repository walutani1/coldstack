// Durable run-job lifecycle + worker. A run is created (candidates materialized
// as job items), then advanced by the server in bounded ticks with genuine
// per-provider concurrency. Ticks self-chain so a run drains fast locally; the
// 10-minute cron is a safety net that resumes any run whose ticks stalled. All
// progress persists, so a refresh, navigation, sleep, or deploy never loses it.

import { getAdminClient } from "@/lib/supabase/admin";
import { getEnv } from "@/lib/env";
import { getLeadsPage, type LeadsPageParams } from "@/lib/enrichment/queries";
import { getTableColumns } from "@/lib/enrichment/custom-columns";
import { getEffectiveCampaignForTable, getTableById } from "@/lib/enrichment/workspace";
import { getEnrichmentRunnerConfig, getStoredEnrichmentRunnerProvider } from "@/lib/enrichment/llm-runner";
import { getPersonalizationPromptConfig } from "@/lib/enrichment/personalization";
import type { ProviderClass } from "@/lib/enrichment/chain";
import { getSecret } from "@/lib/secrets";
import {
  buildSemaphores, buildSteps, findStartStep, runLeadChain, startStepCandidateFilter,
  type RunContext, type Step,
} from "@/lib/enrichment/orchestrator";
import crypto from "node:crypto";

// The toolbar filters + sort a run should be scoped to, so a run only touches
// the leads currently shown on screen (not the whole list).
export type RunFilters = Pick<
  LeadsPageParams,
  "search" | "roleLevels" | "emailStatuses" | "countries" | "hasEmail" | "qualifiedOnly" | "sort" | "sortDir" | "cellColumnId" | "cellState" | "cellGeneration" | "erroredJobId" | "queuedJobId"
>;

export type RunJobKind = "column" | "waterfall";
export type RunJobMode = "test10" | "unrun" | "outdated" | "force" | "count";
export type RunJobStatus = "materializing" | "pending" | "running" | "done" | "canceled" | "failed";

export type RunJob = {
  id: string;
  tableId: string;
  kind: RunJobKind;
  startColumnKey: string;
  mode: RunJobMode;
  status: RunJobStatus;
  total: number;
  done: number;
  failed: number;
  includeExport: boolean;
  error: string | null;
};

function toJob(row: Record<string, unknown>): RunJob {
  return {
    id: String(row.id),
    tableId: String(row.table_id),
    kind: row.kind as RunJobKind,
    startColumnKey: String(row.start_column_key),
    mode: row.mode as RunJobMode,
    status: row.status as RunJobStatus,
    total: Number(row.total ?? 0),
    done: Number(row.done ?? 0),
    failed: Number(row.failed ?? 0),
    includeExport: Boolean(row.include_export),
    error: row.error ? String(row.error) : null,
  };
}

const JOB_COLUMNS = "id, table_id, kind, start_column_key, mode, status, total, done, failed, include_export, run_id, concurrency, error";

// How long one tick works before handing off to a fresh self-chained tick.
// Kept under the route's maxDuration so a tick always finishes cleanly.
const TICK_BUDGET_MS = 230_000;
const ITEM_INSERT_CHUNK = 1000;
// Stop the whole run if this many consecutive leads fail: a systemic problem
// (bad key, campaign untagged) should not burn calls across every remaining row.
const CONSECUTIVE_FAILURE_LIMIT = 30;

/* ── Creation ─────────────────────────────────────────────────────────────── */

export async function createRunJob(input: {
  tableId: string;
  kind: RunJobKind;
  startColumnKey: string;
  mode: RunJobMode;
  includeExport: boolean;
  createdBy: string;
  filters?: RunFilters;
  // For mode 'count': how many rows to run, and the 0-based row offset to start at.
  count?: number;
  offset?: number;
  // For mode 'count': the EXACT rows the operator was looking at, captured from
  // the on-screen list at click time. When present these win over count/offset -
  // see resolveCandidates for why re-querying by offset could not match the view.
  leadIds?: string[];
}): Promise<{ ok: true; jobId: string; total: number } | { ok: false; message: string }> {
  const admin = getAdminClient();
  const table = await getTableById(input.tableId);
  if (!table) return { ok: false, message: "Table not found." };

  // A runner pinned to a local CLI can only execute on the local machine; this
  // deployment would coerce every call onto the metered API. Refuse loudly
  // instead of creating a job prod is not allowed to advance.
  if (process.env.VERCEL) {
    const stored = await getStoredEnrichmentRunnerProvider();
    if (stored === "cli-claude" || stored === "cli-codex") {
      return { ok: false, message: "The runner is set to the local CLI. Start runs from the local app, or switch the runner to an API model in Settings." };
    }
  }

  // One active run per list: a second run would build its own semaphores and
  // double the per-provider ceilings. Blocks a double-click or a second tab
  // (the client guards its own tab; this covers the rest).
  const active = await admin.from("enrichment_run_jobs").select("id", { count: "exact", head: true }).eq("table_id", table.id).in("status", ["materializing", "pending", "running"]);
  if (active.error) return { ok: false, message: active.error.message };
  if ((active.count ?? 0) > 0) return { ok: false, message: "A run is already in progress for this list. Let it finish or stop it first." };

  const columns = await getTableColumns(table.id);
  const steps = buildSteps(columns, table.layoutVersion);
  const startStep = findStartStep(steps, input.startColumnKey);
  if (!startStep) return { ok: false, message: "That column is not a runnable step." };

  const campaign = await getEffectiveCampaignForTable(table.id);
  const campaignTag = campaign ? { id: campaign.id, name: campaign.name } : null;
  const emailQaColumnKey = columns.find((c) => c.kind === "email_qa")?.key ?? null;
  const promptUpdatedAt = (await getPersonalizationPromptConfig()).updatedAtByColumn;

  const leadIds = await resolveCandidates(startStep, input.mode, table.canonical, table.id, {
    campaignTag, emailQaColumnKey, includeExport: input.includeExport, promptUpdatedAt,
  }, input.filters, { count: input.count, offset: input.offset, leadIds: input.leadIds });

  const config = await getEnrichmentRunnerConfig();
  // Create as 'materializing' (non-runnable) so no tick or cron touches the job
  // until every item chunk is inserted; then flip to pending. A create that dies
  // mid-insert leaves a materializing job that nothing runs.
  const { data, error } = await admin.from("enrichment_run_jobs").insert({
    table_id: table.id,
    kind: input.kind,
    start_column_key: input.startColumnKey,
    mode: input.mode,
    status: "materializing",
    total: leadIds.length,
    include_export: input.includeExport,
    concurrency: config.concurrency,
    created_by: input.createdBy,
    last_tick_at: new Date().toISOString(),
  }).select("id").single();
  if (error) return { ok: false, message: error.message };
  const jobId = String((data as { id: string }).id);

  for (let i = 0; i < leadIds.length; i += ITEM_INSERT_CHUNK) {
    const rows = leadIds.slice(i, i + ITEM_INSERT_CHUNK).map((leadId) => ({ job_id: jobId, lead_id: leadId }));
    const inserted = await admin.from("enrichment_run_job_items").insert(rows);
    if (inserted.error) {
      await admin.from("enrichment_run_jobs").update({ status: "failed", error: `Could not materialize run items: ${inserted.error.message}`.slice(0, 500), updated_at: new Date().toISOString() }).eq("id", jobId);
      return { ok: false, message: inserted.error.message };
    }
  }

  // All items in place: flip to a runnable status atomically from the client's view.
  await admin.from("enrichment_run_jobs").update({
    status: leadIds.length > 0 ? "pending" : "done",
    last_tick_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }).eq("id", jobId);

  if (leadIds.length > 0) void triggerTick(jobId);
  return { ok: true, jobId, total: leadIds.length };
}

// Page the table view and keep the leads the start column+mode selects. One
// unified path for built-in and custom starts, so neither hits a 5k cap.
async function resolveCandidates(
  step: Step,
  mode: RunJobMode,
  canonical: RunContext["canonical"],
  tableId: string,
  ctxLite: Pick<RunContext, "campaignTag" | "emailQaColumnKey" | "includeExport" | "promptUpdatedAt">,
  filters?: RunFilters,
  slice?: { count?: number; offset?: number; leadIds?: string[] },
): Promise<string[]> {
  // A Set dedupes across page boundaries: if a lead shifts position between two
  // 500-row page reads it could otherwise be selected twice, and job_items has a
  // (job_id, lead_id) primary key, so a duplicate would fail the whole insert.
  const ids = new Set<string>();
  // An explicit row snapshot means "run exactly what I was looking at". Resolving
  // by offset instead re-queries at click time, and any filter whose membership
  // depends on cell state (Not run / Done / Outdated) SHIFTS as earlier rows
  // fill - so row 3 of the list the operator read is not row 3 of the list the
  // query returns. The snapshot removes that whole class of drift; the offset
  // path below stays for slices bigger than the client had loaded.
  if (slice?.leadIds?.length) {
    for (const id of slice.leadIds) ids.add(id);
    return [...ids];
  }
  // 'count' takes a positional slice of the filtered/sorted view: up to `count`
  // rows starting at row `offset`. Other modes scan from the top.
  const cap = mode === "test10" ? 10 : mode === "count" ? Math.max(0, Math.floor(slice?.count ?? 0)) : 20000;
  const startOffset = mode === "count" ? Math.max(0, Math.floor(slice?.offset ?? 0)) : 0;
  const pageSize = 500;
  if (cap === 0) return [];
  for (let offset = startOffset; ids.size < cap; offset += pageSize) {
    // Scope to the leads the user is currently looking at: same toolbar filters
    // and sort as the on-screen view. For test10, "first 10" then matches the
    // first 10 rows on screen.
    const page = await getLeadsPage({ ...filters, tableId, canonical, limit: pageSize, offset });
    if (!page.rows.length) break;
    for (const row of page.rows) {
      if (startStepCandidateFilter(step, mode, row, ctxLite)) ids.add(row.id);
      if (ids.size >= cap) break;
    }
    if (page.rows.length < pageSize) break;
  }
  return [...ids];
}

/* ── Worker ───────────────────────────────────────────────────────────────── */

// Advance one job by a bounded tick. Returns how many items remain so the
// caller (tick route) knows whether to self-chain. Concurrency-safe: another
// tick or the cron running the same job just claims different items.
async function countRemaining(admin: ReturnType<typeof getAdminClient>, jobId: string): Promise<number> {
  const res = await admin.from("enrichment_run_job_items").select("lead_id", { count: "exact", head: true }).eq("job_id", jobId).in("status", ["pending", "running"]);
  // A failed count must NEVER read as "0 remaining" - during a network blip that
  // would mark a half-finished job done. Throw; the tick 500s and is re-kicked.
  if (res.error) throw new Error(res.error.message);
  return res.count ?? 0;
}
function sleepMs(ms: number): Promise<void> { return new Promise((r) => setTimeout(r, ms)); }

// Transient-fault tolerance for the engine's own bookkeeping RPCs: a network
// blip (wifi drop, Supabase hiccup) must pause the run, not kill it. Retry
// briefly; a persistent failure ends the TICK (the durable state resumes on the
// next kick) instead of marking the whole job failed.
async function rpcWithRetry<T>(call: () => PromiseLike<{ data: T; error: { message: string } | null }>, attempts = 3): Promise<{ data: T | null; error: string | null }> {
  let last = "";
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const res = await call();
    if (!res.error) return { data: res.data, error: null };
    last = res.error.message;
    if (attempt < attempts) await sleepMs(attempt * 2000);
  }
  return { data: null, error: last };
}

export async function processRunJob(jobId: string, budgetMs = TICK_BUDGET_MS): Promise<{ remaining: number; status: RunJobStatus }> {
  const admin = getAdminClient();

  // HARD spend guard: when the runner is pinned to a local CLI, prod must never
  // advance run items - on Vercel the CLI is coerced to the metered Anthropic
  // API, which would silently bill API credits for a run the operator believes
  // is on the subscription. Returning 'pending' (not 'running') keeps the tick
  // route from self-chaining here; the cron may keep kicking and each kick
  // no-ops, leaving the local server as the only executor.
  if (process.env.VERCEL) {
    const stored = await getStoredEnrichmentRunnerProvider();
    if (stored === "cli-claude" || stored === "cli-codex") {
      return { remaining: await countRemaining(admin, jobId), status: "pending" };
    }
  }

  const owner = crypto.randomUUID();
  // Single-writer tick lease: only one tick advances a job at a time, so a
  // self-chain plus the cron safety net can never build two semaphore sets and
  // double every provider ceiling. Requires a runnable (pending/running) job.
  const lease = await admin.rpc("enrichment_run_acquire_tick", { p_job_id: jobId, p_owner: owner, p_ttl_seconds: 60 });
  if (lease.error) throw new Error(lease.error.message);
  if (lease.data !== true) {
    const cur = await admin.from("enrichment_run_jobs").select("status").eq("id", jobId).maybeSingle();
    const status = ((cur.data as { status?: string } | null)?.status as RunJobStatus) ?? "running";
    return { remaining: await countRemaining(admin, jobId), status };
  }

  try {
    const loaded = await admin.from("enrichment_run_jobs").select(JOB_COLUMNS).eq("id", jobId).maybeSingle();
    if (loaded.error) throw new Error(loaded.error.message);
    if (!loaded.data) return { remaining: 0, status: "failed" };
    const job = toJob(loaded.data as Record<string, unknown>);
    if (job.status !== "pending" && job.status !== "running") return { remaining: 0, status: job.status };

    // Promote to running WITHOUT clobbering a concurrent cancel.
    await admin.from("enrichment_run_jobs").update({ status: "running", last_tick_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq("id", jobId).in("status", ["pending", "running"]);

    const ctx = await buildRunContext(job, loaded.data as Record<string, unknown>);
    if (!ctx) {
      await failJob(jobId, "Run configuration could not be loaded (table, columns, or campaign missing).");
      return { remaining: 0, status: "failed" };
    }

    const deadline = Date.now() + budgetMs;
    let canceled = false;
    let systemicFailure: string | null = null;
    let fatalError: string | null = null;
    let consecutiveSystemic = 0;
    let processed = 0;
    ctx.stopped = () => canceled || systemicFailure !== null || fatalError !== null || Date.now() > deadline;

    // Renew the lease + heartbeat, and observe an external cancel promptly.
    const cancelWatch = setInterval(() => {
      void admin.rpc("enrichment_run_renew_tick", { p_job_id: jobId, p_owner: owner, p_ttl_seconds: 60 }).then(() => {});
      void admin.from("enrichment_run_jobs").select("status").eq("id", jobId).maybeSingle().then((r) => {
        if ((r.data as { status?: string } | null)?.status === "canceled") canceled = true;
      });
    }, 3000);

    const pool = Math.max(1, Math.min(16, sumConcurrency(ctx)));
    const claimBatch = Math.max(pool, 8); // ~one wave; avoids stranding claimed rows at the deadline
    const queue: string[] = [];
    let drained = false;
    let refilling: Promise<void> | null = null;
    const refill = async () => {
      if (drained) return;
      const claimed = await rpcWithRetry(() => admin.rpc("enrichment_run_claim_items", { p_job_id: jobId, p_limit: claimBatch }));
      if (claimed.error) { fatalError = claimed.error; drained = true; return; }
      const rows = (claimed.data as { lead_id: string }[] | null) ?? [];
      if (rows.length === 0) drained = true;
      else queue.push(...rows.map((r) => r.lead_id));
    };

    const worker = async () => {
      while (!ctx.stopped()) {
        if (queue.length === 0) {
          if (drained) break;
          if (!refilling) refilling = refill().finally(() => { refilling = null; });
          await refilling;
          if (queue.length === 0 && drained) break;
          continue;
        }
        const leadId = queue.shift();
        if (leadId == null) continue;
        // Record which cell this row is on so the UI can walk the spinner across
        // the row instead of parking it on the start column. Display-only and
        // fire-and-forget: a failed write must never slow down or fail the run.
        const result = await runLeadChain(leadId, job.startColumnKey, job.kind, job.mode, ctx, (stepKey) => {
          void admin.from("enrichment_run_job_items")
            .update({ current_step: stepKey })
            .eq("job_id", jobId).eq("lead_id", leadId)
            .then(() => undefined, () => undefined);
        });
        if (result.status === "stopped") break; // leave claimed; reclaimed after the stale window
        // A transient infra error (network blip, CLI timeout) is not a verdict on
        // the lead: re-queue it (capped) instead of failing it terminally, so a
        // one-second Supabase hiccup no longer permanently kills a runnable row.
        const done = result.status === "failed" && result.retryable
          ? await rpcWithRetry(() => admin.rpc("enrichment_run_retry_or_fail", { p_job_id: jobId, p_lead_id: leadId, p_error: result.error ?? null }))
          : await rpcWithRetry(() => admin.rpc("enrichment_run_complete_item", { p_job_id: jobId, p_lead_id: leadId, p_status: result.status, p_error: result.error ?? null }));
        if (done.error) { fatalError = done.error; break; }
        processed += 1;
        // The breaker exists for SYSTEMIC failures (bad key, untagged campaign)
        // that would fail every remaining row; per-row precondition misses do not
        // count, so a force run over invalid rows does not abort the whole run.
        if (result.status === "failed" && result.systemic) {
          consecutiveSystemic += 1;
          if (consecutiveSystemic >= CONSECUTIVE_FAILURE_LIMIT) systemicFailure = result.error ?? "Repeated systemic failures.";
        } else {
          consecutiveSystemic = 0;
        }
      }
    };

    try {
      await Promise.all(Array.from({ length: pool }, () => worker()));
    } finally {
      clearInterval(cancelWatch);
      for (const sem of Object.values(ctx.semaphores)) sem.drain();
    }

    const remaining = await countRemaining(admin, jobId);
    // An engine RPC that kept failing through its retries is a transient outage
    // (network drop, Supabase blip), not a verdict on the run: end this tick
    // with the job still runnable. Progress is durable; the self-chain, cron, or
    // a watchdog kick resumes exactly where the claims left off.
    if (fatalError) {
      await admin.from("enrichment_run_jobs").update({ last_tick_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq("id", jobId).in("status", ["pending", "running"]);
      return { remaining, status: "running" };
    }
    if (systemicFailure) { await failJob(jobId, systemicFailure); return { remaining, status: "failed" }; }

    // A cancel may have landed during the tick; never overwrite it.
    const latest = await admin.from("enrichment_run_jobs").select("status").eq("id", jobId).maybeSingle();
    if ((latest.data as { status?: string } | null)?.status === "canceled") return { remaining, status: "canceled" };

    if (remaining === 0) {
      await admin.from("enrichment_run_jobs").update({ status: "done", last_tick_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq("id", jobId).in("status", ["pending", "running"]);
      return { remaining: 0, status: "done" };
    }
    // Claimed nothing but work remains => items are still inside a prior dead
    // tick's reclaim window. Pace the self-chain so it does not hot-loop until
    // that window expires.
    if (processed === 0 && !ctx.stopped()) await sleepMs(Math.min(15_000, budgetMs));
    await admin.from("enrichment_run_jobs").update({ last_tick_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq("id", jobId).in("status", ["pending", "running"]);
    return { remaining, status: "running" };
  } finally {
    await admin.rpc("enrichment_run_release_tick", { p_job_id: jobId, p_owner: owner });
  }
}

// Pool size = sum of per-provider ceilings (capped), so leads sitting at
// different providers can all be in flight without any provider overflowing.
function sumConcurrency(ctx: RunContext): number {
  return (["llm", "smartlead", "leadmagic", "zerobounce", "apify"] as ProviderClass[])
    .reduce((n, p) => n + ctx.concurrencyByProvider[p], 0);
}

async function buildRunContext(job: RunJob, row: Record<string, unknown>): Promise<RunContext | null> {
  const table = await getTableById(job.tableId);
  if (!table) return null;
  const columns = await getTableColumns(table.id);
  const steps = buildSteps(columns, table.layoutVersion);
  if (!findStartStep(steps, job.startColumnKey)) return null;
  const campaign = await getEffectiveCampaignForTable(table.id);
  const campaignTag = campaign ? { id: campaign.id, name: campaign.name } : null;
  const emailQaColumnKey = columns.find((c) => c.kind === "email_qa")?.key ?? null;
  const promptUpdatedAt = (await getPersonalizationPromptConfig()).updatedAtByColumn;
  const findEmailConfigured = Boolean((await getSecret("leadmagic_api_key")) ?? process.env.LEADMAGIC_API_KEY);

  const config = await getEnrichmentRunnerConfig();
  const stored = row.concurrency as Partial<Record<ProviderClass, number>> | null;
  const concurrencyByProvider: Record<ProviderClass, number> = {
    llm: stored?.llm ?? config.concurrency.llm,
    smartlead: stored?.smartlead ?? config.concurrency.smartlead,
    leadmagic: stored?.leadmagic ?? config.concurrency.leadmagic,
    zerobounce: stored?.zerobounce ?? config.concurrency.zerobounce,
    apify: stored?.apify ?? config.concurrency.apify,
  };

  return {
    tableId: table.id,
    canonical: table.canonical,
    runId: String(row.run_id),
    updatedBy: String(row.created_by ?? "run-job"),
    steps,
    campaignTag,
    emailQaColumnKey,
    includeExport: job.includeExport,
    cliMode: config.provider === "cli-claude" || config.provider === "cli-codex",
    findEmailConfigured,
    promptUpdatedAt,
    semaphores: buildSemaphores(concurrencyByProvider),
    pauseUntil: { llm: 0, smartlead: 0, leadmagic: 0, zerobounce: 0, apify: 0 },
    concurrencyByProvider,
    stopped: () => false,
  };
}

async function failJob(jobId: string, error: string): Promise<void> {
  await getAdminClient().from("enrichment_run_jobs").update({ status: "failed", error: error.slice(0, 500), updated_at: new Date().toISOString() }).eq("id", jobId);
}

/* ── Status / cancel ──────────────────────────────────────────────────────── */

export async function getRunJob(jobId: string): Promise<RunJob | null> {
  const loaded = await getAdminClient().from("enrichment_run_jobs").select(JOB_COLUMNS).eq("id", jobId).maybeSingle();
  if (loaded.error) throw new Error(loaded.error.message);
  return loaded.data ? toJob(loaded.data as Record<string, unknown>) : null;
}

// The most recent active (or just-finished) job for a table, so the client can
// resume its progress view after a refresh.
export async function getLatestRunJobForTable(tableId: string): Promise<RunJob | null> {
  const loaded = await getAdminClient().from("enrichment_run_jobs").select(JOB_COLUMNS).eq("table_id", tableId).order("created_at", { ascending: false }).limit(1).maybeSingle();
  if (loaded.error) throw new Error(loaded.error.message);
  return loaded.data ? toJob(loaded.data as Record<string, unknown>) : null;
}

export async function cancelRunJob(jobId: string): Promise<void> {
  await getAdminClient().from("enrichment_run_jobs").update({ status: "canceled", updated_at: new Date().toISOString() }).eq("id", jobId).in("status", ["pending", "running"]);
}

/* ── Triggers ─────────────────────────────────────────────────────────────── */

// Fire a tick for a job (fire-and-forget). Self-chaining and first-kick both use
// this. On the local dev server the fetch runs to completion; on Vercel the cron
// safety net covers any tick that a frozen function did not get to chain.
export async function triggerTick(jobId: string): Promise<void> {
  const env = getEnv();
  try {
    await fetch(`${env.APP_BASE_URL}/api/prospects/run-tick`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${env.CRON_SECRET}` },
      body: JSON.stringify({ jobId }),
    });
  } catch {
    // Best effort: the cron will resume a stalled run.
  }
}

// Cron safety net: kick a fresh tick for any active job whose self-chaining
// stalled (no heartbeat lately). It only TRIGGERS ticks - it does not process
// inline - so it always fits the cron route's duration, and the tick lease keeps
// a kicked tick from colliding with one that is somehow still alive.
export async function processDueRunJobs(maxJobs = 10): Promise<{ resumed: number }> {
  const admin = getAdminClient();
  const staleBefore = new Date(Date.now() - 60_000).toISOString();
  const due = await admin.from("enrichment_run_jobs")
    .select("id")
    .in("status", ["pending", "running"])
    .or(`last_tick_at.is.null,last_tick_at.lt.${staleBefore}`)
    .order("created_at", { ascending: true })
    .limit(maxJobs);
  if (due.error) throw new Error(due.error.message);
  const jobs = (due.data as { id: string }[] | null) ?? [];
  for (const j of jobs) void triggerTick(j.id);
  return { resumed: jobs.length };
}
