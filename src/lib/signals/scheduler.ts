import "server-only";

import { getAdminClient } from "@/lib/supabase/admin";
import { listAutomations } from "@/lib/signals/automations";
import { getOpenFunnelRuns, startFunnelRun, tickFunnelRun } from "@/lib/signals/funnel";
import { pushLeadList, startSignalsEnrichmentRun } from "@/lib/signals/lead-push";

// Cron driver. Called every 10 minutes from /api/cron/process, which is what
// turns an automation from "a thing you click" into a thing that runs. Three
// jobs, cheapest first, each independent so one failure cannot starve the rest:
//   1. advance any run already open (this is what actually spends money),
//   2. start today's run for automations whose scheduled hour has arrived,
//   3. push ready leads for automations the operator has trusted with autopush.

// A tick processes one company; the budget bounds one cron invocation.
const MAX_TICKS_PER_RUN = 8;

export async function runSignalAutomations(): Promise<{
  advanced: number;
  started: string[];
  pushed: number;
  errors: string[];
}> {
  const db = getAdminClient();
  const errors: string[] = [];
  let advanced = 0;
  let pushed = 0;
  const started: string[] = [];

  // 1. Advance open runs.
  let open: Awaited<ReturnType<typeof getOpenFunnelRuns>> = [];
  try {
    open = await getOpenFunnelRuns();
  } catch (error) {
    errors.push(`open runs: ${error instanceof Error ? error.message : "failed"}`);
  }
  for (const run of open) {
    if (run.status !== "running") continue; // paused runs wait for a human
    try {
      let current = run;
      for (let i = 0; i < MAX_TICKS_PER_RUN; i += 1) {
        current = await tickFunnelRun(current.id);
        advanced += 1;
        if (current.status !== "running") break;
        if (current.stats.phase === "scraping") break; // scrapes need wall-clock, not ticks
      }
    } catch (error) {
      errors.push(`tick ${run.id}: ${error instanceof Error ? error.message : "failed"}`);
    }
  }

  const automations = await listAutomations().catch((error) => {
    errors.push(`automations: ${error instanceof Error ? error.message : "failed"}`);
    return [];
  });
  const busy = new Set(open.map((run) => run.automationId));

  // 2. Start scheduled runs. "Daily at hour H" means: the hour has arrived and
  // this automation has not run since midnight UTC today.
  const now = new Date();
  const startOfDay = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString();
  for (const automation of automations) {
    if (automation.status !== "active" || automation.schedule.frequency !== "daily") continue;
    if (busy.has(automation.id)) continue;
    if (now.getUTCHours() < automation.schedule.hourUtc) continue;
    if (automation.lastRunAt && automation.lastRunAt >= startOfDay) continue;
    try {
      await startFunnelRun({ trigger: "cron", automationId: automation.id });
      started.push(automation.name);
    } catch (error) {
      // "already running" is normal under a race; anything else is worth seeing.
      const message = error instanceof Error ? error.message : "failed";
      if (!/already running|paused run/i.test(message)) errors.push(`start ${automation.name}: ${message}`);
    }
  }

  // 3. Autopush. Only for automations the operator has explicitly trusted, and
  // only ones bound to a campaign — pushing into nothing is a silent no-op.
  // Per automation, so each one's leads land in ITS recorded prospect table.
  const autopushable = automations.filter((a) => a.autopush && a.status === "active" && a.campaignId);
  for (const automation of autopushable) {
    try {
      const result = await pushLeadList(automation.id);
      pushed += result.pushed;
      // 4. Run the whole chain — enrich, validate, email QA, then Smartlead
      // export — whenever new leads landed OR a lead already in the table has
      // never started it (a push from before this automation existed, or a
      // run that died before reaching them). The chain's first step is the
      // LinkedIn employment verify, so "never started" is an employment
      // status that is still null; without this catch-up such leads would
      // wait forever for a push that never comes. createRunJob refuses while
      // a run is active on the table, and the null-status guard means an idle
      // cron pass creates no empty jobs.
      let needsRun = result.pushed + result.linked > 0;
      if (!needsRun) {
        const { count } = await db
          .from("leads")
          .select("id", { count: "exact", head: true })
          .eq("role_level", "signal")
          .is("linkedin_employment_status", null);
        needsRun = (count ?? 0) > 0;
      }
      if (needsRun) {
        const run = await startSignalsEnrichmentRun(automation.id);
        if (!run.ok && !/already in progress/i.test(run.message)) {
          errors.push(`enrichment run ${automation.name}: ${run.message}`);
        }
      }
    } catch (error) {
      errors.push(`autopush ${automation.name}: ${error instanceof Error ? error.message : "failed"}`);
    }
  }

  // Keep the release timer moving even when nothing else happened: a runner-up
  // whose gap has elapsed should not wait for the next scrape to go out.
  await db.from("signal_contacts").update({ release_blocked_reason: null }).not("release_blocked_reason", "is", null).lt("updated_at", new Date(Date.now() - 6 * 3_600_000).toISOString());

  return { advanced, started, pushed, errors };
}
