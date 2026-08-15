"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireActiveProfile } from "@/lib/auth";
import { getInboxAvatarState, type InboxAvatarState } from "@/lib/inbox-avatars";
import {
  resolveDomainDns,
  runInboxHealth,
  type DomainDnsResult,
  type HealthReport,
} from "@/lib/inbox-health";
import {
  fetchCampaignAnalyticsRange,
  fetchCampaignInboxAccounts,
  fetchInboxAccount,
  fetchInboxWarmupStats,
  listCampaigns,
  listInboxAccounts,
  updateInboxDailyLimit,
  updateInboxIdentity,
  updateInboxWarmup,
  type InboxAccount,
  type InboxIdentityPatch,
  type InboxWarmupStats,
} from "@/lib/smartlead";
import {
  generateWarmupTag,
  getWarmupRotationState,
  rotateAllWarmupTagsNow,
  setWarmupRotationEnabled,
  WARMUP_TAG_PATTERN,
  type WarmupRotationState,
} from "@/lib/warmup-tags";
import type { ActionResult } from "@/lib/types";

const accountIdSchema = z.number().int().positive();
const campaignIdSchema = z.string().regex(/^\d+$/);

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

function sendingDomain(account: InboxAccount): string | null {
  const at = account.fromEmail.lastIndexOf("@");
  const domain = at >= 0 ? account.fromEmail.slice(at + 1).trim().toLowerCase() : "";
  return domain || null;
}

async function mapWithConcurrency<T, R>(
  values: T[],
  concurrency: number,
  mapper: (value: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let nextIndex = 0;
  async function worker() {
    for (;;) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= values.length) return;
      results[index] = await mapper(values[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, () => worker()));
  return results;
}

const dailyLimitSchema = z.number().int().min(1).max(2000);
const customTrackingUrlPattern = /^(?:https?:\/\/)?[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?(?::\d{1,5})?(?:[/?#][^\s]*)?$/i;
const inboxIdentityPatchSchema = z
  .object({
    fromName: z.string().trim().min(1).max(100).optional(),
    signature: z.string().max(10_000).optional(),
    bcc: z.union([z.literal(""), z.string().trim().email().max(320)]).optional(),
    customTrackingUrl: z
      .union([z.literal(""), z.string().trim().max(255).regex(customTrackingUrlPattern)])
      .optional(),
    timeToWaitMins: z.number().int().min(0).max(1440).optional(),
  })
  .strict()
  .refine((patch) => Object.keys(patch).length > 0, { message: "At least one identity field is required." });
const warmupSettingsSchema = z
  .object({
    enabled: z.boolean(),
    totalPerDay: z.number().int().min(1).max(200),
    replyRatePercent: z.number().int().min(0).max(100),
    // Identifier tag stamped on warmup emails. Smartlead accepts any string
    // (live-verified); we hold the line at the word-word shape its own
    // generator uses so tags stay indistinguishable from native ones.
    warmupKey: z.string().trim().toLowerCase().regex(WARMUP_TAG_PATTERN).optional(),
  })
  .strict();

export async function updateInboxDailyLimitAction(
  accountId: number,
  maxEmailPerDay: number,
): Promise<ActionResult> {
  await requireActiveProfile();
  const id = accountIdSchema.safeParse(accountId);
  const limit = dailyLimitSchema.safeParse(maxEmailPerDay);
  if (!id.success || !limit.success) return { ok: false, message: "Invalid daily limit." };
  try {
    await updateInboxDailyLimit(id.data, limit.data);
    return { ok: true, message: `Daily limit set to ${limit.data}.` };
  } catch (error) {
    return { ok: false, message: errorMessage(error, "Could not update the daily limit.") };
  }
}

export async function updateInboxIdentityAction(
  accountId: number,
  patch: InboxIdentityPatch,
): Promise<ActionResult> {
  await requireActiveProfile();
  const id = accountIdSchema.safeParse(accountId);
  const parsed = inboxIdentityPatchSchema.safeParse(patch);
  if (!id.success || !parsed.success) return { ok: false, message: "Invalid inbox identity settings." };
  try {
    await updateInboxIdentity(id.data, parsed.data);
    revalidatePath("/inboxes");
    return { ok: true, message: "Inbox sending identity updated." };
  } catch (error) {
    return { ok: false, message: errorMessage(error, "Could not update inbox identity settings.") };
  }
}

export async function updateInboxWarmupAction(
  accountId: number,
  settings: { enabled: boolean; totalPerDay: number; replyRatePercent: number; warmupKey?: string },
): Promise<ActionResult> {
  await requireActiveProfile();
  const id = accountIdSchema.safeParse(accountId);
  const parsed = warmupSettingsSchema.safeParse(settings);
  if (!id.success || !parsed.success) {
    return { ok: false, message: "Invalid warmup settings. The tag must be two lowercase words joined by a hyphen." };
  }
  try {
    await updateInboxWarmup(id.data, parsed.data);
    return { ok: true, message: parsed.data.enabled ? "Warmup settings updated." : "Warmup disabled." };
  } catch (error) {
    return { ok: false, message: errorMessage(error, "Could not update warmup settings.") };
  }
}

/** Fresh word-word warmup tag (server-side wordlist keeps clients thin). */
export async function generateWarmupTagAction(current?: string): Promise<ActionResult & { tag: string }> {
  await requireActiveProfile();
  return { ok: true, message: "Tag generated.", tag: generateWarmupTag(current ?? null) };
}

export async function getWarmupRotationAction(): Promise<ActionResult & { state?: WarmupRotationState }> {
  await requireActiveProfile();
  try {
    return { ok: true, message: "Rotation settings loaded.", state: await getWarmupRotationState() };
  } catch (error) {
    return { ok: false, message: errorMessage(error, "Could not load rotation settings.") };
  }
}

export async function setWarmupRotationAction(enabled: boolean): Promise<ActionResult & { state?: WarmupRotationState }> {
  await requireActiveProfile();
  const parsed = z.boolean().safeParse(enabled);
  if (!parsed.success) return { ok: false, message: "Invalid rotation setting." };
  try {
    const state = await setWarmupRotationEnabled(parsed.data);
    return {
      ok: true,
      message: parsed.data
        ? `Automatic rotation on. Fresh tags every ${state.intervalDays} days.`
        : "Automatic rotation off.",
      state,
    };
  } catch (error) {
    return { ok: false, message: errorMessage(error, "Could not save rotation settings.") };
  }
}

const rotateIdsSchema = z.array(accountIdSchema).min(1).max(200).optional();

/** Rotate every warmup-active inbox, or only `accountIds` when provided. */
export async function rotateWarmupTagsNowAction(accountIds?: number[]): Promise<
  ActionResult & { state?: WarmupRotationState; rotated?: number; failed?: number; skipped?: number }
> {
  await requireActiveProfile();
  const ids = rotateIdsSchema.safeParse(accountIds);
  if (!ids.success) return { ok: false, message: "Invalid inbox selection." };
  try {
    const { result, state } = await rotateAllWarmupTagsNow(ids.data);
    const failNote = result.failed.length > 0 ? ` ${result.failed.length} failed. Check Smartlead.` : "";
    return {
      ok: result.failed.length === 0,
      message: `Rotated warmup tags on ${result.rotated.length} ${result.rotated.length === 1 ? "inbox" : "inboxes"}.${failNote}`,
      state,
      rotated: result.rotated.length,
      failed: result.failed.length,
      skipped: result.skipped,
    };
  } catch (error) {
    return { ok: false, message: errorMessage(error, "Could not rotate warmup tags.") };
  }
}

/* ── Bulk settings — Smartlead has no bulk account endpoints, so these fan
   out sequentially with pacing and report per-inbox failures instead of
   aborting the batch. Campaign assignment (add/removeCampaignInboxesAction)
   is genuinely bulk on Smartlead's side and lives in campaigns/actions. ── */

export type BulkOutcome = { done: number; failures: { email: string; message: string }[] };

const bulkIdsSchema = z.array(accountIdSchema).min(1).max(200);
const BULK_PACE_MS = 350; // stay inside Smartlead's request-rate ceiling

async function runBulk(
  accountIds: number[],
  operation: (account: InboxAccount) => Promise<void>,
): Promise<BulkOutcome> {
  const accounts = await listInboxAccounts();
  const byId = new Map(accounts.map((account) => [account.id, account]));
  const outcome: BulkOutcome = { done: 0, failures: [] };
  for (const id of accountIds) {
    const account = byId.get(id);
    if (!account) {
      outcome.failures.push({ email: `#${id}`, message: "Inbox not found in Smartlead." });
      continue;
    }
    try {
      await operation(account);
      outcome.done += 1;
    } catch (error) {
      outcome.failures.push({
        email: account.fromEmail,
        message: error instanceof Error ? error.message.slice(0, 200) : "Unknown error",
      });
    }
    await new Promise((resolve) => setTimeout(resolve, BULK_PACE_MS));
  }
  return outcome;
}

function bulkMessage(verb: string, outcome: BulkOutcome): string {
  const failNote =
    outcome.failures.length > 0
      ? ` ${outcome.failures.length} failed: ${outcome.failures
          .slice(0, 3)
          .map((failure) => failure.email)
          .join(", ")}${outcome.failures.length > 3 ? "…" : ""}.`
      : "";
  return `${verb} ${outcome.done} ${outcome.done === 1 ? "inbox" : "inboxes"}.${failNote}`;
}

export async function bulkUpdateDailyLimitAction(
  accountIds: number[],
  maxEmailPerDay: number,
): Promise<ActionResult & { outcome?: BulkOutcome }> {
  await requireActiveProfile();
  const ids = bulkIdsSchema.safeParse(accountIds);
  const limit = dailyLimitSchema.safeParse(maxEmailPerDay);
  if (!ids.success || !limit.success) return { ok: false, message: "Invalid bulk daily-limit request." };
  try {
    const outcome = await runBulk(ids.data, (account) => updateInboxDailyLimit(account.id, limit.data));
    return { ok: outcome.failures.length === 0, message: bulkMessage(`Daily limit set to ${limit.data} on`, outcome), outcome };
  } catch (error) {
    return { ok: false, message: errorMessage(error, "Could not update daily limits.") };
  }
}

export async function bulkSetWarmupEnabledAction(
  accountIds: number[],
  enabled: boolean,
): Promise<ActionResult & { outcome?: BulkOutcome }> {
  await requireActiveProfile();
  const ids = bulkIdsSchema.safeParse(accountIds);
  const flag = z.boolean().safeParse(enabled);
  if (!ids.success || !flag.success) return { ok: false, message: "Invalid bulk warmup request." };
  try {
    // Preserves each inbox's current warmup volume and reply rate — the
    // endpoint requires the full settings body alongside the flag.
    const outcome = await runBulk(ids.data, (account) =>
      updateInboxWarmup(account.id, {
        enabled: flag.data,
        totalPerDay: account.warmup?.warmupMaxCount ?? 15,
        replyRatePercent: account.warmup?.replyRatePercent ?? 27,
      }),
    );
    return {
      ok: outcome.failures.length === 0,
      message: bulkMessage(flag.data ? "Warmup enabled on" : "Warmup disabled on", outcome),
      outcome,
    };
  } catch (error) {
    return { ok: false, message: errorMessage(error, "Could not update warmup settings.") };
  }
}

export type WorkspaceSendStats = {
  sent: number;
  replies: number;
  bounces: number;
  campaigns: number;
  days: number;
};

const SEND_STATS_DAYS = 7;

/**
 * Real campaign sends across every campaign for the trailing week — the
 * header's counterpart to warmup volume. One range query per campaign,
 * concurrency-limited; a campaign whose analytics fail is skipped rather
 * than sinking the whole stat.
 */
export async function getWorkspaceSendStatsAction(): Promise<ActionResult & { stats?: WorkspaceSendStats }> {
  await requireActiveProfile();
  try {
    const campaigns = await listCampaigns();
    const format = (date: Date) => date.toISOString().slice(0, 10);
    const end = new Date();
    const start = new Date(end.getTime() - (SEND_STATS_DAYS - 1) * 24 * 60 * 60 * 1000);
    const results = await mapWithConcurrency(campaigns, 4, async (campaign) => {
      try {
        return await fetchCampaignAnalyticsRange(campaign.id, format(start), format(end));
      } catch {
        return null;
      }
    });
    const stats: WorkspaceSendStats = { sent: 0, replies: 0, bounces: 0, campaigns: 0, days: SEND_STATS_DAYS };
    for (const result of results) {
      if (!result) continue;
      stats.campaigns += 1;
      stats.sent += result.sent;
      stats.replies += result.replies;
      stats.bounces += result.bounces;
    }
    return { ok: true, message: "Send stats loaded.", stats };
  } catch (error) {
    return { ok: false, message: errorMessage(error, "Could not load campaign send stats.") };
  }
}

export type CampaignInboxMapEntry = {
  campaignId: string;
  name: string;
  status: string;
  accountIds: number[];
};

/**
 * Which campaigns each inbox sends for — one Smartlead call per campaign,
 * concurrency-limited. Campaigns whose account list fails are skipped
 * rather than failing the whole map (grouping degrades, never breaks).
 */
export async function getInboxCampaignMapAction(): Promise<
  ActionResult & { campaigns?: CampaignInboxMapEntry[] }
> {
  await requireActiveProfile();
  try {
    const all = await listCampaigns();
    const entries = await mapWithConcurrency(all, 4, async (campaign) => {
      try {
        const accounts = await fetchCampaignInboxAccounts(campaign.id);
        return {
          campaignId: campaign.id,
          name: campaign.name,
          status: campaign.status ?? "",
          accountIds: accounts.map((account) => account.id),
        };
      } catch {
        return null;
      }
    });
    return {
      ok: true,
      message: "Campaign inbox map loaded.",
      campaigns: entries.filter((entry): entry is CampaignInboxMapEntry => entry !== null),
    };
  } catch (error) {
    return { ok: false, message: errorMessage(error, "Could not load campaign inbox assignments.") };
  }
}

/**
 * Warmup day-series for every workspace inbox in one round trip — feeds the
 * workspace charts and pre-fills the per-inbox activity views. Accounts whose
 * stats fail are simply absent from the map.
 */
export async function getWorkspaceWarmupSeriesAction(): Promise<
  ActionResult & { series?: Record<number, InboxWarmupStats> }
> {
  await requireActiveProfile();
  try {
    const accounts = await listInboxAccounts();
    const entries = await mapWithConcurrency(accounts, 4, async (account) => {
      try {
        return { id: account.id, stats: await fetchInboxWarmupStats(account.id) };
      } catch {
        return null;
      }
    });
    const series: Record<number, InboxWarmupStats> = {};
    for (const entry of entries) {
      if (entry) series[entry.id] = entry.stats;
    }
    return { ok: true, message: "Warmup activity loaded.", series };
  } catch (error) {
    return { ok: false, message: errorMessage(error, "Could not load warmup activity.") };
  }
}

/** Workspace inbox roster for pickers (e.g. campaign creation). `avatars` maps
 *  lowercased from_email → Zapmail profile picture, so pickers can show the
 *  face an account sends with (and flag the ones sending without one).
 *  `avatarsVerified` false means the map couldn't be checked against Zapmail —
 *  missing entries must render as unknown, never as "no picture". */
export async function listInboxAccountsAction(): Promise<
  ActionResult & { inboxes?: InboxAccount[]; avatars?: Record<string, string>; avatarsVerified?: boolean }
> {
  await requireActiveProfile();
  try {
    const [inboxes, avatarState] = await Promise.all([
      listInboxAccounts(),
      getInboxAvatarState().catch(() => ({ map: {}, verified: false }) as InboxAvatarState),
    ]);
    return {
      ok: true,
      message: "Inboxes loaded.",
      inboxes,
      avatars: avatarState.map,
      avatarsVerified: avatarState.verified,
    };
  } catch (error) {
    return { ok: false, message: errorMessage(error, "Could not load inboxes.") };
  }
}

export async function getInboxWarmupStatsAction(
  accountId: number,
): Promise<ActionResult & { stats?: InboxWarmupStats }> {
  await requireActiveProfile();
  const parsed = accountIdSchema.safeParse(accountId);
  if (!parsed.success) return { ok: false, message: "Invalid Smartlead email account ID." };
  try {
    const stats = await fetchInboxWarmupStats(parsed.data);
    return { ok: true, message: "Inbox warmup stats loaded.", stats };
  } catch (error) {
    return { ok: false, message: errorMessage(error, "Could not load inbox warmup stats.") };
  }
}

export async function runInboxHealthAction(
  accountId: number,
): Promise<ActionResult & { report?: HealthReport }> {
  await requireActiveProfile();
  const parsed = accountIdSchema.safeParse(accountId);
  if (!parsed.success) return { ok: false, message: "Invalid Smartlead email account ID." };
  try {
    const [account, stats] = await Promise.all([
      fetchInboxAccount(parsed.data),
      fetchInboxWarmupStats(parsed.data).catch(() => null),
    ]);
    const domain = sendingDomain(account);
    if (!domain) throw new Error("The inbox does not have a valid sending domain.");
    const dns = await resolveDomainDns(domain, account.customTrackingDomain, account.provider);
    const report = await runInboxHealth(account, stats, dns);
    return { ok: true, message: "Inbox health check completed.", report };
  } catch (error) {
    return { ok: false, message: errorMessage(error, "Could not run the inbox health check.") };
  }
}

export async function runWorkspaceHealthAction(): Promise<
  ActionResult & {
    reports?: HealthReport[];
    failures?: { accountId: number; email: string; message: string }[];
  }
> {
  await requireActiveProfile();
  try {
    const accounts = await listInboxAccounts();
    const dnsByDomain = new Map<string, Promise<DomainDnsResult>>();
    const outcomes = await mapWithConcurrency(accounts, 4, async (account) => {
      try {
        const domain = sendingDomain(account);
        if (!domain) throw new Error("The inbox does not have a valid sending domain.");
        const stats = await fetchInboxWarmupStats(account.id).catch(() => null);
        let dnsPromise = dnsByDomain.get(domain);
        if (!dnsPromise) {
          dnsPromise = resolveDomainDns(domain, account.customTrackingDomain, account.provider);
          dnsByDomain.set(domain, dnsPromise);
        }
        const report = await runInboxHealth(account, stats, await dnsPromise);
        return { report, failure: null };
      } catch (error) {
        return {
          report: null,
          failure: {
            accountId: account.id,
            email: account.fromEmail,
            message: errorMessage(error, "Could not check this inbox."),
          },
        };
      }
    });
    const reports = outcomes.flatMap((outcome) => (outcome.report ? [outcome.report] : []));
    const failures = outcomes.flatMap((outcome) => (outcome.failure ? [outcome.failure] : []));
    return {
      ok: true,
      message: `Checked ${reports.length} of ${accounts.length} inboxes.`,
      reports,
      failures,
    };
  } catch (error) {
    return { ok: false, message: errorMessage(error, "Could not run workspace inbox health checks.") };
  }
}

export async function getCampaignInboxesAction(
  campaignId: string,
): Promise<
  ActionResult & { inboxes?: InboxAccount[]; avatars?: Record<string, string>; avatarsVerified?: boolean }
> {
  await requireActiveProfile();
  const parsed = campaignIdSchema.safeParse(campaignId);
  if (!parsed.success) return { ok: false, message: "Invalid Smartlead campaign ID." };
  try {
    const [inboxes, avatarState] = await Promise.all([
      fetchCampaignInboxAccounts(parsed.data),
      getInboxAvatarState().catch(() => ({ map: {}, verified: false }) as InboxAvatarState),
    ]);
    return {
      ok: true,
      message: "Campaign inboxes loaded.",
      inboxes,
      avatars: avatarState.map,
      avatarsVerified: avatarState.verified,
    };
  } catch (error) {
    return { ok: false, message: errorMessage(error, "Could not load campaign inboxes.") };
  }
}
