// Server-side autorun-chain executor for durable run jobs. Client-invoked
// Server Functions are dispatched one at a time in this Next.js, so real
// per-provider concurrency has to run here, on the server, where Promise
// concurrency is genuine. This module runs one lead's chain (start column,
// then the eligible downstream cascade for a waterfall) against a shared set of
// per-provider semaphores, so many leads run at once without any provider ever
// exceeding its configured ceiling.
//
// The chain rules (order, eligibility, gates, provider mapping) come from the
// shared chain.ts so this mirrors the client worktable exactly. The run logic
// comes from the auth-less cores (runners.ts) and the custom/title/QA runners.

import { getLeadsPage } from "@/lib/enrichment/queries";
import type { EnrichmentLead } from "@/lib/enrichment/types";
import type { RunnableAction } from "@/lib/enrichment/types";
import type { CanonicalFilter } from "@/lib/enrichment/workspace";
import {
  columnModelForMode, runCustomColumn, runTitleCheck, TITLE_FIT_KEY, type CustomColumn,
} from "@/lib/enrichment/custom-columns";
import { runEmailQa } from "@/lib/enrichment/email-qa";
import {
  exportLeadCore, runFindEmailCore, runLinkedinVerifyCore, runPersonalizationCore, runValidateEmailCore,
} from "@/lib/enrichment/runners";
import {
  ACTION_PROVIDER, AUTORUN_ORDER, autorunEligible, BUILTIN_RUN_ACTION, isCellStale, personalizationField, type ProviderClass,
} from "@/lib/enrichment/chain";
import { PERSONALIZATION_COLUMNS, type PersonalizationColumn } from "@/lib/enrichment/personalization";

const PERSONALIZATION_SET = new Set<string>(PERSONALIZATION_COLUMNS);

/* ── Stop-aware counting semaphore ──────────────────────────────────────────
   acquire resolves true when it holds a permit, or false if the run was stopped
   while it waited (drain wakes every waiter with false). A caller that gets
   false must NOT release. */
export class Semaphore {
  private available: number;
  private readonly waiters: Array<(granted: boolean) => void> = [];
  constructor(permits: number) { this.available = Math.max(1, Math.floor(permits)); }
  async acquire(): Promise<boolean> {
    if (this.available > 0) { this.available -= 1; return true; }
    return new Promise<boolean>((resolve) => this.waiters.push(resolve));
  }
  release(): void {
    const next = this.waiters.shift();
    if (next) next(true);
    else this.available += 1;
  }
  drain(): void {
    while (this.waiters.length) this.waiters.shift()!(false);
  }
}

export type Step = { key: string; action?: RunnableAction; column?: CustomColumn };

export type RunContext = {
  tableId: string;
  canonical: CanonicalFilter;
  runId: string;
  updatedBy: string;
  steps: Step[];
  campaignTag: { id: string; name: string } | null;
  emailQaColumnKey: string | null;
  includeExport: boolean;
  // Which model field each column reads this run (CLI choice vs API choice).
  cliMode: boolean;
  // Whether a LeadMagic key exists (env or stored secret). Without one the
  // find_email step is skipped as a waterfall follow-up instead of failing rows.
  findEmailConfigured: boolean;
  // Per-action prompt-updated timestamps, so a built-in personalization column's
  // "outdated" run can find filled-but-stale cells (there is no generation for
  // built-ins, only the lead's personalization_updated_at vs the prompt's).
  promptUpdatedAt: Record<string, string>;
  semaphores: Record<ProviderClass, Semaphore>;
  pauseUntil: Record<ProviderClass, number>;
  concurrencyByProvider: Record<ProviderClass, number>;
  stopped: () => boolean;
};

// Build the ordered step list, mirroring the client's autorunSteps exactly:
// v2 derives the chain from the table's visible columns in sort order (AI/email-qa
// -> custom runner, built-in -> run action); anything else (v1, or a table with no
// seeded columns) uses the fixed built-in AUTORUN_ORDER so v1 tables (e.g.
// Champions) still run.
export function buildSteps(columns: CustomColumn[], layoutVersion: string): Step[] {
  if (layoutVersion !== "v2" || columns.length === 0) {
    return AUTORUN_ORDER.map((action) => ({ key: action, action }));
  }
  const ordered = columns
    .filter((c) => c.visible)
    .slice()
    .sort((a, b) => a.sortOrder - b.sortOrder);
  const steps: Step[] = [];
  for (const column of ordered) {
    if (column.kind === "ai" || column.kind === "email_qa") steps.push({ key: column.key, column });
    else if (column.kind === "builtin") {
      const action = BUILTIN_RUN_ACTION[column.key];
      // Carry the column: the personalization built-ins read their model off it
      // exactly like an AI column does.
      if (action) steps.push({ key: column.key, action, column });
    }
  }
  return steps;
}

// Resolve the start step from a client-supplied key. Custom columns pass their
// column key (== step.key); built-in menus pass the run ACTION (which matches
// step.action on both v1 action-keyed steps and v2 column-keyed steps).
export function findStartStep(steps: Step[], startKey: string): Step | undefined {
  return steps.find((s) => s.key === startKey || s.action === startKey);
}

export function buildSemaphores(concurrency: Record<ProviderClass, number>): Record<ProviderClass, Semaphore> {
  return {
    llm: new Semaphore(concurrency.llm),
    smartlead: new Semaphore(concurrency.smartlead),
    leadmagic: new Semaphore(concurrency.leadmagic),
    zerobounce: new Semaphore(concurrency.zerobounce),
    apify: new Semaphore(concurrency.apify),
  };
}

function nowMs(): number { return Date.now(); }

async function stopAwareSleep(ms: number, ctx: RunContext): Promise<void> {
  const end = nowMs() + ms;
  while (nowMs() < end) {
    if (ctx.stopped()) return;
    await new Promise((r) => setTimeout(r, Math.min(200, Math.max(1, end - nowMs()))));
  }
}

function isRateLimited(result: { message: string; kind?: string }): boolean {
  if (result.kind === "rate_limit") return true;
  return /rate.?limit|429|too many requests/i.test(result.message);
}

type StepRunResult = {
  ok: boolean;
  message: string;
  value?: string | null;
  outcome?: string;
  blocked?: boolean;
  kind?: string;
  retryAfterMs?: number;
};

// Run one provider call through its semaphore, honoring the provider pause
// window and retrying rate limits with backoff taken OUTSIDE the permit (so a
// backing-off row never occupies a slot). Returns null if the run was stopped
// or the retries were exhausted.
async function withProvider(
  ctx: RunContext,
  provider: ProviderClass,
  fn: () => Promise<StepRunResult>,
): Promise<StepRunResult | null> {
  const MAX_ATTEMPTS = 4;
  let attempts = 0;
  while (attempts < MAX_ATTEMPTS) {
    if (ctx.stopped()) return null;
    // Wait out any provider pause window BEFORE taking a permit; re-evaluate
    // afterward without consuming a retry attempt.
    const pause = ctx.pauseUntil[provider] - nowMs();
    if (pause > 0) { await stopAwareSleep(pause, ctx); continue; }

    const granted = await ctx.semaphores[provider].acquire();
    if (!granted) return null; // drained by stop
    // A stop or a fresh 429 (another row) may have landed while we waited for the
    // permit. Recheck both before spending the call.
    if (ctx.stopped()) { ctx.semaphores[provider].release(); return null; }
    if (ctx.pauseUntil[provider] > nowMs()) { ctx.semaphores[provider].release(); continue; }

    attempts += 1;
    let result: StepRunResult;
    try {
      result = await fn();
    } catch (error) {
      ctx.semaphores[provider].release();
      return { ok: false, message: error instanceof Error ? error.message : "Step failed." };
    }
    ctx.semaphores[provider].release();

    if (result.ok || !isRateLimited(result)) return result;
    // Rate limited: set the shared pause window, then back off outside the permit.
    const wait = result.retryAfterMs && result.retryAfterMs > 0 ? result.retryAfterMs : 15_000 * attempts;
    ctx.pauseUntil[provider] = Math.max(ctx.pauseUntil[provider], nowMs() + wait);
    await stopAwareSleep(wait, ctx);
  }
  return null;
}

async function runBuiltinStep(action: RunnableAction, leadId: string, ctx: RunContext, column?: CustomColumn): Promise<StepRunResult> {
  if (action === "linkedin_verify") return runLinkedinVerifyCore(leadId, ctx.runId);
  if (action === "find_email") return runFindEmailCore(leadId, ctx.runId);
  if (action === "validate_email") return runValidateEmailCore(leadId, ctx.runId);
  if (action === "smartlead_export") {
    if (!ctx.campaignTag) return { ok: false, message: "No campaign tag for export." };
    return exportLeadCore(leadId, ctx.tableId, ctx.runId, ctx.campaignTag.id);
  }
  if (PERSONALIZATION_SET.has(action)) {
    const model = column ? columnModelForMode(column, ctx.cliMode) : "";
    return runPersonalizationCore(leadId, action as PersonalizationColumn, ctx.runId, model, column?.reasoningEffort ?? null);
  }
  return { ok: false, message: `Unknown action ${action}.` };
}

async function runCustomStep(column: CustomColumn, leadId: string, ctx: RunContext): Promise<StepRunResult> {
  if (column.key === TITLE_FIT_KEY) {
    const r = await runTitleCheck(column.id, leadId, ctx.updatedBy);
    return r.ok ? { ok: true, message: "", value: r.answer, outcome: "written" } : { ok: false, message: r.message };
  }
  if (column.kind === "email_qa") {
    const r = await runEmailQa(column.id, leadId, ctx.updatedBy);
    return r.ok ? { ok: true, message: "", value: r.verdict === "ready" ? "Ready" : "Needs review", outcome: "written" } : { ok: false, message: r.message };
  }
  const r = await runCustomColumn(column.id, leadId, ctx.updatedBy);
  return r.ok ? { ok: true, message: "", value: r.value, outcome: "written" } : { ok: false, message: r.message, blocked: r.blocked };
}

// Apply a built-in step's result to the local lead copy (mirror of the client's
// patchForAction) so the next step sees the new value without a refetch.
function applyBuiltinPatch(lead: EnrichmentLead, action: RunnableAction, value: string | null): EnrichmentLead {
  switch (action) {
    case "linkedin_verify": return { ...lead, linkedinEmploymentStatus: value, linkedinCheckedAt: new Date().toISOString() };
    case "find_email": return value ? { ...lead, email: value, emailStatus: null } : lead;
    case "validate_email": return { ...lead, emailStatus: value as EnrichmentLead["emailStatus"] };
    case "final_first_name": return { ...lead, finalFirstName: value };
    case "final_title": return { ...lead, finalTitle: value };
    case "final_company_name": return { ...lead, finalCompanyName: value };
    case "operations_task": return { ...lead, operationsTask: value };
    case "ops_candidate": return { ...lead, opsCandidate: value };
    case "smartlead_export": return { ...lead, tableExportStatus: "exported", tableExportError: null, tableExportedAt: new Date().toISOString() };
    default: return lead;
  }
}

function applyCustomPatch(lead: EnrichmentLead, column: CustomColumn, value: string | null): EnrichmentLead {
  return {
    ...lead,
    customCells: { ...(lead.customCells ?? {}), [column.key]: value },
    customCellGens: { ...(lead.customCellGens ?? {}), [column.key]: column.generationVersion },
  };
}

// Whether a chain step should run now for this row. Mirrors the client's
// stepEligible: hard halts stop everything, export is gated on the review + tag.
function stepEligible(step: Step, lead: EnrichmentLead, ctx: RunContext): boolean {
  if (lead.linkedinEmploymentStatus === "not_working") return false;
  if ((lead.customCells?.title_fit ?? "").trim().toLowerCase() === "no") return false;
  if (step.action === "smartlead_export") {
    if (!ctx.includeExport || !ctx.campaignTag) return false;
    // Already-exported leads stay ELIGIBLE: exportLeadCore refreshes their
    // campaign variables in place (values regenerated after the original push
    // otherwise never reach Smartlead - the July-3 era leads rendered blank
    // fields for 12 days because this line used to skip them).
    if (lead.emailStatus !== "deliverable" || lead.suppressionReason) return false;
    if (ctx.emailQaColumnKey && (lead.customCells?.[ctx.emailQaColumnKey] ?? "") !== "Ready") return false;
    return true;
  }
  if (step.action === "linkedin_verify") return lead.linkedinEmploymentStatus == null;
  // With no LeadMagic key configured, find_email can only throw. An invalid
  // email is a validation OUTCOME, not a run failure: skip the step so the row
  // completes cleanly and the lead waits in the phase-2 (email-finding) pool.
  if (step.action === "find_email" && !ctx.findEmailConfigured) return false;
  if (step.action) return autorunEligible(step.action, lead, Boolean(ctx.campaignTag));
  const column = step.column!;
  const filled = (lead.customCells?.[column.key] ?? "").trim() !== "";
  if (filled && !isCellStale(lead, column)) return false;
  if (column.key === TITLE_FIT_KEY) return true;
  if (column.kind === "email_qa") return lead.emailStatus === "deliverable" && Boolean(ctx.campaignTag);
  return lead.emailStatus === "deliverable";
}

// applied  - the step ran and changed state (real progress).
// noop     - the step ran but nothing changed / it was correctly skipped.
// blocked  - a custom cell is waiting on a dependency that has not run.
// halt     - a genuine failure; stop this one lead.
// stopped  - the run was stopped (cancel/deadline) before the call completed.
type StepStatus = "applied" | "noop" | "blocked" | "halt" | "stopped";
type StepOutcome = { status: StepStatus; lead: EnrichmentLead; message?: string };

// A systemic failure (bad key, untagged campaign, misconfig) fails EVERY row the
// same way; the worker uses this to trip its circuit breaker. Per-row precondition
// misses ("needs an email", "depends on ...") are NOT systemic.
export function isSystemicFailure(message: string): boolean {
  return /unauthorized|not authorized|forbidden|api key|invalid key|not configured|no api key|campaign|secret|permission denied/i.test(message);
}

// A transient INFRASTRUCTURE error (a Supabase/network ECONNRESET, a socket
// hang-up, a CLI call that ran past its timeout) is not a verdict on the lead:
// the same row usually succeeds on the next try. The worker re-queues these
// (up to a cap) instead of failing them terminally. Deliberately narrow - a
// missing API key or a "profile not found" is a real, non-retryable outcome and
// must NOT match here, or the run would loop on hopeless rows.
export function isTransientError(message: string): boolean {
  return /fetch failed|terminated|econnreset|etimedout|econnrefused|enotfound|socket hang up|network|timed out|timeout|502|503|504|bad gateway|service unavailable|gateway timeout/i.test(message);
}

async function executeStep(step: Step, lead: EnrichmentLead, ctx: RunContext): Promise<StepOutcome> {
  const provider: ProviderClass = step.action ? ACTION_PROVIDER[step.action] : "llm";
  let current = lead;
  // Optimistic-write rejections (the row changed under us) mean the value was NOT
  // written; refetch the row and retry the same step rather than counting it done.
  for (let staleTry = 0; staleTry < 3; staleTry += 1) {
    const result = await withProvider(ctx, provider, () =>
      step.action ? runBuiltinStep(step.action, current.id, ctx, step.column) : runCustomStep(step.column!, current.id, ctx));
    if (result === null) return { status: "stopped", lead: current };
    if (result.outcome === "stale") {
      const fresh = await refetchLead(current.id, ctx);
      if (!fresh) return { status: "noop", lead: current }; // left the table filter
      current = fresh;
      continue;
    }
    if (!result.ok) {
      if (result.blocked) return { status: "blocked", lead: current, message: result.message };
      return { status: "halt", lead: current, message: result.message };
    }
    const applied = result.outcome === "written" || (result.outcome === "duplicate" && result.value != null);
    if (!applied) return { status: "noop", lead: current };
    const patched = step.action
      ? applyBuiltinPatch(current, step.action, result.value ?? null)
      : applyCustomPatch(current, step.column!, result.value ?? null);
    return { status: "applied", lead: patched };
  }
  return { status: "noop", lead: current }; // kept losing the optimistic race; move on
}

async function refetchLead(leadId: string, ctx: RunContext): Promise<EnrichmentLead | null> {
  const page = await getLeadsPage({ tableId: ctx.tableId, canonical: ctx.canonical, leadIds: [leadId], limit: 1 });
  return page.rows[0] ?? null;
}

// The start step's own column is the gate (title check / linkedin), so it is not
// subject to that gate.
function isGateStep(step: Step): boolean {
  return step.column?.key === TITLE_FIT_KEY || step.action === "linkedin_verify";
}
function isHardHalted(lead: EnrichmentLead): boolean {
  return lead.linkedinEmploymentStatus === "not_working" || (lead.customCells?.title_fit ?? "").trim().toLowerCase() === "no";
}

export type LeadChainResult = { status: "done" | "failed" | "stopped"; error?: string; systemic?: boolean; retryable?: boolean };

// Run one lead: the mode-selected start column, then (for a waterfall) the
// eligible downstream cascade to a fixpoint. Candidate lists can be minutes old,
// so the start step re-checks hard gates and its candidate filter at execution
// time. A genuine failure stops only this lead; others are unaffected.
export async function runLeadChain(
  leadId: string,
  startKey: string,
  kind: "column" | "waterfall",
  mode: "test10" | "unrun" | "outdated" | "force" | "count",
  ctx: RunContext,
  // Display-only progress hook: fires with the step key as each step begins so
  // the caller can record where the row is and the UI can move the spinner off
  // the start column. Best-effort - never awaited, never affects the run.
  onStep?: (stepKey: string) => void,
): Promise<LeadChainResult> {
  if (ctx.stopped()) return { status: "stopped" };
  const startStep = findStartStep(ctx.steps, startKey);
  if (!startStep) return { status: "failed", error: `Start column ${startKey} is not a runnable step.` };
  const startIndex = ctx.steps.indexOf(startStep);

  let lead = await refetchLead(leadId, ctx);
  if (!lead) return { status: "failed", error: "Lead not found." };

  // Re-evaluate at execution time: a hard halt (not a fit / left company) or a
  // cell another actor filled since materialization means this row is no longer a
  // valid start candidate. Correctly skipped, not failed.
  if (!isGateStep(startStep) && isHardHalted(lead)) return { status: "done" };

  // The candidate filter gates ONLY the start step, not the whole chain. A
  // waterfall resume whose start cell is already filled (an earlier tick ran it,
  // then a deadline/stop interrupted the cascade, or another actor filled it)
  // must still run the downstream steps - otherwise the lead is stranded
  // half-personalized: title_fit written, nothing after it, and marked done. For
  // a column run there is nothing downstream, so a satisfied filter means done.
  const runStart = startStepCandidateFilter(startStep, mode, lead, ctx);
  if (!runStart && kind === "column") return { status: "done" };
  if (runStart) {
    onStep?.(startStep.key);
    const start = await executeStep(startStep, lead, ctx);
    if (start.status === "stopped") return { status: "stopped" };
    if (start.status === "blocked") return { status: "failed", error: `Start column ${startKey} is blocked: ${start.message ?? "a dependency has not run."}` };
    if (start.status === "halt") return { status: "failed", error: start.message ?? `Start column ${startKey} failed.`, systemic: isSystemicFailure(start.message ?? ""), retryable: isTransientError(start.message ?? "") };
    lead = start.lead;
  }

  if (kind === "column") return { status: "done" };

  // Waterfall: fixpoint over the downstream steps (mirror continueAutorun). A
  // stop mid-cascade leaves already-applied cells written; the item is reclaimed
  // and re-run, and the downstream eligibility skips the filled cells.
  let progressed = true;
  let guard = 0;
  while (progressed && guard < ctx.steps.length * 2) {
    guard += 1;
    progressed = false;
    for (let i = startIndex + 1; i < ctx.steps.length; i += 1) {
      if (ctx.stopped()) return { status: "stopped" };
      const step = ctx.steps[i];
      if (!stepEligible(step, lead, ctx)) continue;
      onStep?.(step.key);
      const outcome = await executeStep(step, lead, ctx);
      if (outcome.status === "stopped") return { status: "stopped" };
      // A blocked downstream cell is not a failure: skip it this pass; the
      // fixpoint retries after a dependency fills.
      if (outcome.status === "halt") return { status: "failed", error: outcome.message ?? `Step ${step.key} failed.`, systemic: isSystemicFailure(outcome.message ?? ""), retryable: isTransientError(outcome.message ?? "") };
      lead = outcome.lead;
      if (outcome.status === "applied") progressed = true;
    }
  }
  return { status: "done" };
}

// Candidate selection for the START column of a run, given a mode. Built-in
// steps use autorunEligible against normalized leads; custom columns reuse the
// custom candidate logic. This is exported for the job creator.
export function startStepCandidateFilter(
  step: Step,
  mode: "test10" | "unrun" | "outdated" | "force" | "count",
  lead: EnrichmentLead,
  ctx: Pick<RunContext, "campaignTag" | "emailQaColumnKey" | "includeExport" | "promptUpdatedAt">,
): boolean {
  // force/test10/count run the selected row regardless of its current value;
  // count differs only in that candidate selection took a positional slice.
  if (mode === "force" || mode === "test10" || mode === "count") return true;
  if (step.column) {
    const column = step.column;
    const filled = (lead.customCells?.[column.key] ?? "").trim() !== "";
    if (mode === "unrun") return !filled;
    return filled && isCellStale(lead, column); // outdated
  }
  const action = step.action!;
  if (mode === "unrun") return autorunEligible(action, lead, Boolean(ctx.campaignTag));
  // outdated (built-in): only AI-prompt personalization columns have a staleness
  // signal - the lead's personalization_updated_at predates the prompt's edit.
  const field = personalizationField(action);
  const promptAt = ctx.promptUpdatedAt?.[action];
  if (!field || !promptAt) return false;
  const value = lead[field];
  const filled = typeof value === "string" ? value.trim() !== "" : value != null;
  return filled && (lead.personalizationUpdatedAt == null || lead.personalizationUpdatedAt < promptAt);
}
