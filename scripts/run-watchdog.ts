// Keep a local run alive overnight.
//
// A run is driven entirely by the tick route self-chaining. On Vercel a cron
// backstops that, but locally there is no cron (and on Vercel the cron no-ops
// while the runner is pinned to a CLI), so anything that breaks the chain
// outright - the dev server restarting, the machine sleeping, a crash between
// the tick failing and its retry firing - leaves the job stuck on
// status='running' with nothing touching it. That is how a 1000-row run stopped
// dead at 72 rows and sat idle for 6.5 hours.
//
// This polls the job and re-kicks a tick whenever last_tick_at goes stale. It is
// idempotent: the tick route takes a lease, so a kick that lands while a tick is
// genuinely working is a no-op.
//
// Run:  NODE_OPTIONS="--conditions=react-server" npx tsx scripts/run-watchdog.ts <jobId> [staleSeconds]
import "./load-env";
import { createClient } from "@supabase/supabase-js";

const jobId = process.argv[2];
const staleSeconds = Number(process.argv[3] ?? 420);
if (!jobId) {
  console.error("usage: run-watchdog.ts <jobId> [staleSeconds]");
  process.exit(1);
}

const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
  auth: { autoRefreshToken: false, persistSession: false },
});
const base = (process.env.APP_BASE_URL || "http://localhost:3000").replace(/\/+$/, "");
const secret = process.env.CRON_SECRET;

async function kick(reason: string) {
  try {
    const res = await fetch(`${base}/api/prospects/run-tick`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${secret}` },
      body: JSON.stringify({ jobId }),
    });
    console.log(`${new Date().toISOString()} kicked (${reason}) -> HTTP ${res.status}`);
  } catch (error) {
    console.log(`${new Date().toISOString()} kick failed (${reason}): ${String(error).slice(0, 120)}`);
  }
}

async function loop() {
  for (;;) {
    try {
      const { data, error } = await admin
        .from("enrichment_run_jobs")
        .select("status,total,done,failed,last_tick_at")
        .eq("id", jobId)
        .maybeSingle();
      if (error) throw new Error(error.message);
      if (!data) { console.error("job not found"); return; }
      const job = data as { status: string; total: number; done: number; failed: number; last_tick_at: string | null };
      if (["done", "failed", "canceled"].includes(job.status)) {
        console.log(`${new Date().toISOString()} job ${job.status}: ${job.done} done / ${job.failed} failed of ${job.total}. Watchdog exiting.`);
        return;
      }
      const ageS = job.last_tick_at ? (Date.now() - Date.parse(job.last_tick_at)) / 1000 : Infinity;
      const line = `${job.done}+${job.failed}/${job.total}, last tick ${Math.round(ageS)}s ago`;
      if (ageS > staleSeconds) await kick(line);
      else console.log(`${new Date().toISOString()} alive (${line})`);
    } catch (error) {
      // A watchdog that dies on a network blip is not a watchdog.
      console.log(`${new Date().toISOString()} poll failed: ${String(error).slice(0, 120)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 60_000));
  }
}

void loop();
