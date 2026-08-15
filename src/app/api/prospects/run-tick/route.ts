import { NextResponse, type NextRequest } from "next/server";
import crypto from "node:crypto";
import { getEnv } from "@/lib/env";
import { processRunJob, triggerTick } from "@/lib/enrichment/run-jobs";

// A tick advances one durable run job by a bounded chunk, then self-chains a
// fresh tick if work remains. Authorized with the same CRON_SECRET the cron
// endpoint uses (createRunJob and the self-chain both send it).
export const maxDuration = 300;

function authorized(header: string | null) {
  if (!header) return false;
  const expected = crypto.createHash("sha256").update(`Bearer ${getEnv().CRON_SECRET}`).digest();
  const received = crypto.createHash("sha256").update(header).digest();
  return expected.length === received.length && crypto.timingSafeEqual(expected, received);
}

export async function POST(request: NextRequest) {
  if (!authorized(request.headers.get("authorization"))) {
    return NextResponse.json({ ok: false, message: "Unauthorized." }, { status: 401 });
  }
  let jobId: string | null = null;
  try {
    const body = (await request.json()) as { jobId?: unknown };
    if (typeof body.jobId === "string") jobId = body.jobId;
  } catch {
    // fall through to the 400 below
  }
  if (!jobId) return NextResponse.json({ ok: false, message: "Missing jobId." }, { status: 400 });

  try {
    const result = await processRunJob(jobId);
    // Self-chain the next tick immediately when more work remains, so a run
    // drains without waiting for the 10-minute cron.
    if (result.status === "running" && result.remaining > 0) void triggerTick(jobId);
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    // The self-chain IS the only thing driving a run locally - the cron that
    // this used to rely on runs on Vercel, and there it no-ops for a CLI runner.
    // So a single throw (a Supabase ECONNRESET mid-tick is the common one) used
    // to end an overnight run permanently, leaving the job stuck on
    // status='running' with nothing touching it. Re-chain after a short pause so
    // a blip costs one tick instead of the whole run; the pause keeps a
    // hard-failing job from spinning.
    setTimeout(() => { void triggerTick(jobId); }, 15_000);
    return NextResponse.json({ ok: false, message: error instanceof Error ? error.message.slice(0, 300) : "Tick failed." }, { status: 500 });
  }
}
