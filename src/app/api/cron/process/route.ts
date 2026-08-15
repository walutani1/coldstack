import { NextResponse, type NextRequest } from "next/server";
import crypto from "node:crypto";
import { getEnv } from "@/lib/env";
import { processPendingReplyEvents } from "@/lib/replies/process";
import { executeDueScheduledActions } from "@/lib/replies/schedule";
import { sendDueScheduledReplies } from "@/lib/replies/scheduled-send";
import { maybeRotateWarmupTags } from "@/lib/warmup-tags";
import { runDailyCampaignInsightsMaintenance } from "@/lib/campaign-insights";
import { pollUntrackedReplies } from "@/lib/untracked/poll";
import { processPendingUntrackedReplies } from "@/lib/untracked/process";
import { processDueRunJobs } from "@/lib/enrichment/run-jobs";
import { processZapmailProvisions } from "@/lib/zapmail-provisions";
import { syncInboxAvatars } from "@/lib/inbox-avatars";
import { drainNotificationDeliveries } from "@/lib/notifications/notify";
import { runSignalAutomations } from "@/lib/signals/scheduler";

// Research + draft can add ~15-30s per reply-worthy event; a batch of 8 needs
// more than the old 60s ceiling.
export const maxDuration = 300;

function authorized(header: string | null) {
  if (!header) return false;
  const expected = crypto.createHash("sha256").update(`Bearer ${getEnv().CRON_SECRET}`).digest();
  const received = crypto.createHash("sha256").update(header).digest();
  return crypto.timingSafeEqual(expected, received);
}

// Vercel Cron sends `Authorization: Bearer ${CRON_SECRET}` automatically.
export async function GET(request: NextRequest) {
  if (!authorized(request.headers.get("authorization"))) {
    return NextResponse.json({ ok: false, message: "Unauthorized." }, { status: 401 });
  }

  // Drain the notification outbox FIRST: it's cheap and time-critical (a
  // teammate is waiting on the Slack ping), and must never be starved by the
  // slow research/draft batch. This is the durable backstop for any notification
  // whose eager drain was cut off mid-request.
  let notifications: unknown = null;
  try {
    notifications = await drainNotificationDeliveries(50);
  } catch (error) {
    notifications = { error: error instanceof Error ? error.message.slice(0, 200) : "error" };
  }

  // Resumes next: they're cheap and time-critical, and must never be starved
  // by a long research/draft batch eating the duration budget.
  const resumes = await executeDueScheduledActions(10);
  // Deliver replies whose scheduled time has arrived (cheap, time-sensitive).
  const scheduledReplies = await sendDueScheduledReplies(10);
  const result = await processPendingReplyEvents(8);

  let untracked: unknown;
  try {
    const poll = await pollUntrackedReplies();
    const process = await processPendingUntrackedReplies({ maxLlmCalls: 5, maxPrefilters: 25, softTimeMs: 60_000 });
    untracked = { poll, process };
  } catch (error) {
    untracked = { error: error instanceof Error ? error.message.slice(0, 500) : "Untracked reply processing failed." };
  }

  // Scheduled warmup-tag rotation (no-op unless enabled AND the interval has
  // elapsed — it claims its slot before rotating, so overlapping ticks skip).
  let warmupRotation: unknown = null;
  try {
    const rotation = await maybeRotateWarmupTags();
    warmupRotation = rotation.ran
      ? { ran: true, rotated: rotation.result.rotated.length, failed: rotation.result.failed.length }
      : rotation;
  } catch (error) {
    warmupRotation = { ran: false, reason: error instanceof Error ? error.message.slice(0, 200) : "error" };
  }

  let campaignInsightsMaintenance: unknown = null;
  try {
    campaignInsightsMaintenance = await runDailyCampaignInsightsMaintenance();
  } catch (error) {
    campaignInsightsMaintenance = {
      ran: false,
      reason: error instanceof Error ? error.message.slice(0, 200) : "error",
    };
  }

  // Safety net for durable enrichment run jobs: resume any whose self-chaining
  // ticks stalled (browser closed mid-run, a tick froze, a deploy interrupted).
  let runJobs: unknown = null;
  try {
    runJobs = await processDueRunJobs();
  } catch (error) {
    runJobs = { resumed: 0, reason: error instanceof Error ? error.message.slice(0, 200) : "error" };
  }

  // Zapmail provisioning watcher: advances open batches (activation -> image ->
  // export -> Smartlead defaults -> review). One cheap DB read when idle.
  let zapmailProvisions: unknown = null;
  try {
    zapmailProvisions = await processZapmailProvisions();
  } catch (error) {
    zapmailProvisions = { watched: 0, reason: error instanceof Error ? error.message.slice(0, 200) : "error" };
  }

  // Signals automations: advance open runs, start scheduled ones, autopush
  // where the operator has turned it on. Isolated like every other subsystem.
  let signals: unknown = null;
  try {
    signals = await runSignalAutomations();
  } catch (error) {
    signals = { error: error instanceof Error ? error.message.slice(0, 200) : "error" };
  }

  // Daily-gated backstop for the durable avatar snapshot + image cache — the
  // fallback pages use when Zapmail is unreachable (blocked networks, rate-
  // limited cold starts, local dev). Page loads refresh it organically, so
  // most ticks skip after two cheap DB reads without touching Zapmail.
  let inboxAvatars: unknown = null;
  try {
    inboxAvatars = await syncInboxAvatars();
  } catch (error) {
    inboxAvatars = { ran: false, reason: error instanceof Error ? error.message.slice(0, 200) : "error" };
  }

  return NextResponse.json({ ok: true, ...result, signals, notifications, resumes, scheduledReplies, untracked, warmupRotation, campaignInsightsMaintenance, runJobs, zapmailProvisions, inboxAvatars });
}
