"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireActiveProfile, requireActiveProfileResult } from "@/lib/auth";
import { registerSmartleadWebhookAction } from "../settings/actions";
import {
  campaignOverridesSchema,
  getCampaignOverrides,
  updateCampaignOverrides,
  type CampaignOverrides,
} from "@/lib/campaign-settings";
import {
  addCampaignLeads,
  addCampaignInboxes,
  createCampaign,
  createCampaignSchedule,
  deleteCampaign,
  fetchCampaignDetail,
  fetchCampaignAnalyticsRange,
  fetchCampaignAnalyticsSummary,
  fetchCampaignBounceSplit,
  fetchCampaignStatisticsRows,
  fetchCampaignStatisticsRowsInRange,
  fetchCampaignLeadsPage,
  fetchCampaignPreviewLead,
  fetchCampaignSequence,
  getCampaignSenderAccounts,
  getCampaignSenderNames,
  getMessageHistory,
  getReplyWebhookStatus,
  listSmartleadCategories,
  pauseCampaignLead,
  removeCampaignInboxes,
  removeCampaignLead,
  resumeLead,
  saveCampaignSequence,
  setCampaignLeadCategory,
  unsubscribeCampaignLead,
  updateCampaignSettings,
  updateCampaignGeneralSettings as updateCampaignGeneralSettingsRequest,
  updateCampaignScheduleWindow,
  updateCampaignStatus,
  updateCampaignLead,
  type CampaignLeadRow,
  type CampaignLeadUpdate,
  type AddLeadsInput,
  type AddLeadsResult,
  type CampaignAnalyticsSummary,
  type CampaignBounceSplit,
  type CampaignStatisticsKind,
  type CampaignGeneralPatch,
  type CampaignRangeAnalytics,
  type CampaignScheduleInput,
  type CampaignPreviewLead,
  type SequenceStep,
  type SmartleadCampaignDetail,
  type SmartleadCampaignStatus,
  type ReplyWebhookStatus,
  type SmartleadGlobalCategory,
} from "@/lib/smartlead";
import { getWorkspaceSettings } from "@/lib/settings-store";
import { htmlToText } from "@/lib/html";
import { GATEWAY_MODEL_PATTERN, toGatewayModelId } from "@/lib/enrichment/llm-runner";
import { getInboxAvatarMap } from "@/lib/inbox-avatars";
import { generateSpintax } from "@/lib/spintax";
import { runSpamCheck, type SpamCheckResult } from "@/lib/spam-check";
import { getAdminClient } from "@/lib/supabase/admin";
import { getCampaignReplyStats, type CampaignReplyStats } from "@/lib/replies/queries";
import {
  CAMPAIGN_BRIEF_FORCE_COOLDOWN_MS,
  CAMPAIGN_BRIEF_MODEL_OPTIONS,
  computeCampaignInsights,
  claimCampaignBriefForceCooldown,
  generateCampaignBrief,
  getBenchmark,
  getCachedCampaignBrief,
  getCampaignBriefModel,
  markCampaignBriefDirty,
  releaseCampaignBriefForceCooldown,
  setCampaignBriefModel,
} from "@/lib/campaign-insights";
import type { ActionResult } from "@/lib/types";

const campaignIdSchema = z.string().regex(/^\d+$/);
const campaignDrillKindSchema = z.enum(["sent","opened","clicked","replied","unsubscribed","bounced"]);
const campaignDrillOffsetSchema = z.number().int().min(0).max(5_000);
const overviewRangeSchema = z.enum(["all", "30d", "7d"]);

export type CampaignOverviewRange = z.infer<typeof overviewRangeSchema>;

/* Start/end (YYYY-MM-DD, inclusive) for a bounded range: today minus 6 or 29
   through today — the dateRanges() convention in campaign-insights. */
function overviewRangeDates(range: "30d" | "7d"): { start: string; end: string } {
  const format = (date: Date) => date.toISOString().slice(0, 10);
  const now = new Date();
  const back = range === "7d" ? 6 : 29;
  return { start: format(new Date(now.getTime() - back * 86_400_000)), end: format(now) };
}

export type CampaignDrillRow = Awaited<ReturnType<typeof fetchCampaignStatisticsRows>>["rows"][number] & { leadId: string | null };

/* Smartlead's statistics rows carry emails, not our lead ids. Resolve in one
   batch so every row can open the lead side panel; misses stay null. */
async function attachLeadIds(rows: Awaited<ReturnType<typeof fetchCampaignStatisticsRows>>["rows"]): Promise<CampaignDrillRow[]> {
  const emails = [...new Set(rows.map((row) => row.leadEmail).filter(Boolean))];
  const leadIdByEmail = new Map<string, string>();
  // Chunked: a range scan can return ~1000 rows, and one .in() with that many
  // emails overflows the PostgREST GET URL and silently degrades to no matches.
  for (let index = 0; index < emails.length; index += 200) {
    const lookup = await getAdminClient().from("leads").select("id, email").in("email", emails.slice(index, index + 200));
    for (const row of lookup.data ?? []) {
      if (typeof row.email === "string") leadIdByEmail.set(row.email.toLowerCase(), String(row.id));
    }
  }
  return rows.map((row) => ({ ...row, leadId: leadIdByEmail.get(row.leadEmail.toLowerCase()) ?? null }));
}

export async function getCampaignDrilldownAction(campaignId: string, kind: CampaignStatisticsKind, offset = 0, range: CampaignOverviewRange = "all"): Promise<ActionResult & { data?: { rows: CampaignDrillRow[]; total: number; truncated: boolean } }> {
  const auth=await requireActiveProfileResult(); if (!auth.ok) return auth;
  const id=campaignIdSchema.safeParse(campaignId); const parsedKind=campaignDrillKindSchema.safeParse(kind); const parsedOffset=campaignDrillOffsetSchema.safeParse(offset); const parsedRange=overviewRangeSchema.safeParse(range);
  if (!id.success || !parsedKind.success || !parsedOffset.success || !parsedRange.success) return { ok:false, message:"Invalid campaign drill-down request." };
  try {
    // Bounded ranges scan pages and filter by timestamp server-side (the
    // /statistics endpoint rejects date params). The scan is capped, so
    // `truncated` marks a window whose total reflects only what was scanned.
    const data = parsedRange.data === "all"
      ? { ...(await fetchCampaignStatisticsRows(id.data,parsedKind.data,parsedOffset.data)), truncated: false }
      : await (async () => {
          const { start, end } = overviewRangeDates(parsedRange.data as "30d" | "7d");
          return fetchCampaignStatisticsRowsInRange(id.data,parsedKind.data,start,end);
        })();
    const rows = await attachLeadIds(data.rows);
    return { ok:true, message:"Campaign drill-down loaded.", data: { rows, total: data.total, truncated: data.truncated } };
  }
  catch (error) { return { ok:false, message:errorMessage(error,"Could not load campaign drill-down.") }; }
}

const smartleadLeadIdSchema = z.string().regex(/^\d+$/);

export type CampaignSentEmail = {
  messageId: string;
  subject: string;
  bodyText: string;
  time: string | null;
  from: string;
  fromName: string | null;
};

/* The outbound half of a lead's Smartlead message history — the emails this
   campaign actually delivered to them. Bodies are flattened to plain text
   here so the client never renders provider HTML; sender display names are
   best-effort (the history endpoint returns bare addresses only). */
export async function getCampaignSentEmailsAction(campaignId: string, smartleadLeadId: string): Promise<ActionResult & { data?: { emails: CampaignSentEmail[] } }> {
  const auth=await requireActiveProfileResult(); if (!auth.ok) return auth;
  const id=campaignIdSchema.safeParse(campaignId); const leadId=smartleadLeadIdSchema.safeParse(smartleadLeadId);
  if (!id.success || !leadId.success) return { ok:false, message:"Invalid sent-email request." };
  try {
    const [history, senderNames] = await Promise.all([
      getMessageHistory(id.data, leadId.data),
      getCampaignSenderNames(id.data).catch(() => ({}) as Record<string, string>),
    ]);
    const emails = history
      .filter((message) => message.type !== "REPLY")
      .map((message, index) => ({
        messageId: message.message_id || `${message.time}:${index}`,
        subject: message.subject,
        bodyText: htmlToText(message.email_body),
        time: message.time || null,
        from: message.from,
        fromName: senderNames[message.from.trim().toLowerCase()] ?? null,
      }));
    return { ok:true, message:"Sent emails loaded.", data:{ emails } };
  }
  catch (error) { return { ok:false, message:errorMessage(error,"Could not load the sent emails.") }; }
}
const statusSchema = z.enum(["START", "PAUSED", "STOPPED"]);
const hourSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
const timezoneSchema = z.string().trim().min(1).refine((timezone) => {
  try {
    new Intl.DateTimeFormat(undefined, { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}, "Invalid IANA time zone.");
const inboxIdsSchema = z.array(z.number().int().positive());
const scheduleWindowSchema = z
  .object({
    timezone: timezoneSchema,
    daysOfTheWeek: z.array(z.number().int().min(1).max(7)).min(1),
    startHour: hourSchema,
    endHour: hourSchema,
  })
  .strict()
  .refine((schedule) => schedule.startHour < schedule.endHour, {
    message: "Schedule start hour must be before end hour.",
    path: ["endHour"],
  });
const scheduleSchema = z
  .object({
    timezone: timezoneSchema,
    daysOfTheWeek: z.array(z.number().int().min(1).max(7)).min(1),
    startHour: hourSchema,
    endHour: hourSchema,
    minTimeBtwnEmails: z.number().int().min(1).max(600),
    maxNewLeadsPerDay: z.number().int().min(1).max(2000),
  })
  .strict()
  .refine((schedule) => schedule.startHour < schedule.endHour, {
    message: "Schedule start hour must be before end hour.",
    path: ["endHour"],
  });
const createCampaignSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    description: z.string().trim().max(2000).optional(),
    schedule: scheduleSchema,
    inboxIds: inboxIdsSchema,
  })
  .strict();
const limitsSchema = z
  .object({
    maxLeadsPerDay: z.number().int().min(1).max(2000).optional(),
    minTimeBtwnEmails: z.number().int().min(1).max(600).optional(),
  })
  .strict()
  .refine((value) => value.maxLeadsPerDay !== undefined || value.minTimeBtwnEmails !== undefined);
const generalSettingsSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    stopLeadSettings: z.enum(["REPLY_TO_AN_EMAIL", "CLICK_ON_A_LINK", "OPEN_AN_EMAIL"]).optional(),
    tracking: z.object({ opens: z.boolean(), clicks: z.boolean() }).strict().optional(),
    sendAsPlainText: z.boolean().optional(),
    unsubscribeText: z.string().trim().max(500).optional(),
    followUpPercentage: z.number().int().min(0).max(100).optional(),
  })
  .strict()
  .refine((value) => Object.values(value).some((field) => field !== undefined));
// This action transports the complete sequence returned by Smartlead. Keep
// its shape/invariant checks, but do not reject an existing legacy sequence
// merely because it exceeds today's editor authoring caps. The client still
// limits new delays to 0..90 and does not add steps or variants.
const sequenceVariantSchema = z
  .object({
    id: z.number().int().nonnegative().nullable(),
    label: z.string().nullable(),
    subject: z.string(),
    emailBody: z.string(),
  })
  .strict();
const sequenceStepSchema = z
  .object({
    id: z.number().int().nonnegative().nullable(),
    seqNumber: z.number().int().min(1),
    delayInDays: z.number().int().min(0),
    subject: z.string(),
    emailBody: z.string(),
    variants: z.array(sequenceVariantSchema).min(1).nullable(),
  })
  .strict();
const sequenceSchema = z
  .array(sequenceStepSchema)
  .min(1)
  .superRefine((steps, context) => {
    const seen = new Set<number>();
    for (const [index, step] of steps.entries()) {
      if (seen.has(step.seqNumber)) {
        context.addIssue({
          code: "custom",
          message: "Sequence step numbers must be unique.",
          path: [index, "seqNumber"],
        });
      }
      seen.add(step.seqNumber);
    }
    // Contiguity (1..N) is only enforced when the write CREATES steps: our
    // editor renumbers on add/remove/reorder, so a gap there is a client bug.
    // Copy-only saves of an existing sequence pass seqNumbers through
    // untouched, and Smartlead's own UI can leave read-legal gaps — rejecting
    // those would brick editing on legacy campaigns.
    if (steps.some((step) => step.id === null)) {
      const ordered = [...seen].sort((a, b) => a - b);
      if (ordered.some((seqNumber, index) => seqNumber !== index + 1)) {
        context.addIssue({
          code: "custom",
          message: "Sequence step numbers must be contiguous from 1 through N.",
          path: [],
        });
      }
    }
  });

function parseCampaignId(campaignId: unknown): string | null {
  const parsed = campaignIdSchema.safeParse(campaignId);
  return parsed.success ? parsed.data : null;
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

export async function createCampaignAction(input: {
  name: string;
  description?: string;
  schedule: CampaignScheduleInput;
  inboxIds: number[];
}): Promise<ActionResult & { campaignId?: string }> {
  const profile = await requireActiveProfile();
  const parsed = createCampaignSchema.safeParse(input);
  if (!parsed.success) return { ok: false, message: "Invalid campaign setup." };

  let campaignId: string | null = null;
  try {
    const created = await createCampaign(parsed.data.name);
    campaignId = created.id;
    await createCampaignSchedule(campaignId, parsed.data.schedule);
    await addCampaignInboxes(campaignId, parsed.data.inboxIds);
    // The description lives in OUR settings store (as this campaign's AI
    // context), never in Smartlead. Best-effort: its failure must not roll
    // back a campaign that already exists.
    if (parsed.data.description) {
      try {
        await updateCampaignOverrides(campaignId, { campaignContext: parsed.data.description }, profile.email);
      } catch {
        // The Campaign tab's Description card can set it later.
      }
    }
    revalidatePath("/campaigns");
    return { ok: true, message: "Campaign created.", campaignId };
  } catch (error) {
    const message = errorMessage(error, "Could not create campaign.");
    if (campaignId === null) return { ok: false, message };

    try {
      await deleteCampaign(campaignId);
      return { ok: false, message };
    } catch (rollbackError) {
      const cleanupMessage = errorMessage(rollbackError, "cleanup failed");
      return {
        ok: false,
        message: `${message} A partially-created campaign (${campaignId}) may exist in Smartlead because cleanup also failed: ${cleanupMessage}`,
        campaignId,
      };
    }
  }
}

export async function addCampaignInboxesAction(
  campaignId: string,
  accountIds: number[],
): Promise<ActionResult> {
  await requireActiveProfile();
  const id = parseCampaignId(campaignId);
  const parsedAccountIds = inboxIdsSchema.safeParse(accountIds);
  if (!id || !parsedAccountIds.success) return { ok: false, message: "Invalid campaign inbox assignment." };

  try {
    await addCampaignInboxes(id, parsedAccountIds.data);
    void markCampaignBriefDirty(id).catch(() => undefined);
    revalidatePath("/campaigns");
    return { ok: true, message: "Campaign inboxes added." };
  } catch (error) {
    return { ok: false, message: errorMessage(error, "Could not add campaign inboxes.") };
  }
}

export async function removeCampaignInboxesAction(
  campaignId: string,
  accountIds: number[],
): Promise<ActionResult> {
  await requireActiveProfile();
  const id = parseCampaignId(campaignId);
  const parsedAccountIds = inboxIdsSchema.safeParse(accountIds);
  if (!id || !parsedAccountIds.success) return { ok: false, message: "Invalid campaign inbox assignment." };

  try {
    await removeCampaignInboxes(id, parsedAccountIds.data);
    void markCampaignBriefDirty(id).catch(() => undefined);
    revalidatePath("/campaigns");
    return { ok: true, message: "Campaign inboxes removed." };
  } catch (error) {
    return { ok: false, message: errorMessage(error, "Could not remove campaign inboxes.") };
  }
}

export async function deleteCampaignAction(campaignId: string): Promise<ActionResult> {
  await requireActiveProfile();
  const id = parseCampaignId(campaignId);
  if (!id) return { ok: false, message: "Invalid Smartlead campaign ID." };

  try {
    const detail = await fetchCampaignDetail(id);
    if (detail.status !== "DRAFTED") {
      return { ok: false, message: "Only DRAFTED campaigns can be deleted." };
    }
    await deleteCampaign(id);
    revalidatePath("/campaigns");
    return { ok: true, message: "Campaign deleted." };
  } catch (error) {
    return { ok: false, message: errorMessage(error, "Could not delete campaign.") };
  }
}

export async function getCampaignDetailAction(
  campaignId: string,
): Promise<ActionResult & { detail?: SmartleadCampaignDetail; overrides?: CampaignOverrides }> {
  await requireActiveProfile();
  const id = parseCampaignId(campaignId);
  if (!id) return { ok: false, message: "Invalid Smartlead campaign ID." };

  try {
    const [detail, overrides] = await Promise.all([
      fetchCampaignDetail(id),
      getCampaignOverrides(id),
    ]);
    return { ok: true, message: "Campaign loaded.", detail, overrides };
  } catch (error) {
    return { ok: false, message: errorMessage(error, "Could not load campaign.") };
  }
}

export async function getCampaignSequenceAction(
  campaignId: string,
): Promise<ActionResult & { steps?: SequenceStep[] }> {
  await requireActiveProfile();
  const id = parseCampaignId(campaignId);
  if (!id) return { ok: false, message: "Invalid Smartlead campaign ID." };

  try {
    const steps = await fetchCampaignSequence(id);
    return { ok: true, message: "Campaign sequence loaded.", steps };
  } catch (error) {
    return { ok: false, message: errorMessage(error, "Could not load campaign sequence.") };
  }
}

export async function saveCampaignSequenceAction(
  campaignId: string,
  steps: SequenceStep[],
): Promise<ActionResult> {
  await requireActiveProfile();
  const id = parseCampaignId(campaignId);
  const parsed = sequenceSchema.safeParse(steps);
  if (!id || !parsed.success) return { ok: false, message: "Invalid campaign sequence." };

  try {
    await saveCampaignSequence(id, parsed.data);
    void markCampaignBriefDirty(id).catch(() => undefined);
    revalidatePath("/campaigns");
    return { ok: true, message: "Campaign sequence saved." };
  } catch (error) {
    return { ok: false, message: errorMessage(error, "Could not save campaign sequence.") };
  }
}

const spamCheckInputSchema = z.object({
  subject: z.string().max(300),
  body: z.string().min(10).max(8000),
}).strict();

/* An editor tool's model override: "" (or unset) keeps the tool's default
   transport; anything else must be a routable gateway id. */
const toolModelSchema = z.string().trim().max(100).default("");
function parseToolModel(value: unknown): { ok: true; model: string | undefined } | { ok: false } {
  const parsed = toolModelSchema.safeParse(value ?? "");
  if (!parsed.success) return { ok: false };
  if (parsed.data && !GATEWAY_MODEL_PATTERN.test(toGatewayModelId(parsed.data))) return { ok: false };
  return { ok: true, model: parsed.data || undefined };
}

/* One focused model read of the current email draft: spam-risk score plus
   the exact phrases driving it, each with a concrete fix. */
export async function checkSequenceSpamAction(
  input: { subject: string; body: string },
  options?: { model?: string },
): Promise<ActionResult & { report?: SpamCheckResult }> {
  const auth = await requireActiveProfileResult();
  if (!auth.ok) return auth;
  const parsed = spamCheckInputSchema.safeParse(input);
  if (!parsed.success) return { ok: false, message: "Write at least a short body before running the spam check." };
  const model = parseToolModel(options?.model);
  if (!model.ok) return { ok: false, message: "Pick a model in vendor/model form." };
  const result = await runSpamCheck(parsed.data, { model: model.model });
  return result.ok
    ? { ok: true, message: "Spam check complete.", report: result.result }
    : { ok: false, message: result.error };
}

const spintaxInputSchema = z.string().trim().min(3).max(400);
const spintaxOptionsSchema = z.object({
  instructions: z.string().trim().max(500).default(""),
}).strict();

/* AI spintax for the sequence builder rail: one line in, Smartlead-format
   spin blocks out ({option a|option b}), {{variables}} preserved. Optional
   operator guidance rides along in the prompt; an optional gateway model id
   reroutes the call off the default Anthropic transport. */
export async function generateSpintaxAction(
  text: string,
  options?: { instructions?: string; model?: string },
): Promise<ActionResult & { spintax?: string }> {
  const auth = await requireActiveProfileResult();
  if (!auth.ok) return auth;
  const parsed = spintaxInputSchema.safeParse(text);
  if (!parsed.success) return { ok: false, message: "Enter a line between 3 and 400 characters." };
  const parsedOptions = spintaxOptionsSchema.safeParse({ instructions: options?.instructions ?? "" });
  if (!parsedOptions.success) return { ok: false, message: "Invalid spintax options." };
  const model = parseToolModel(options?.model);
  if (!model.ok) return { ok: false, message: "Pick a model in vendor/model form." };
  const result = await generateSpintax(parsed.data, {
    instructions: parsedOptions.data.instructions || undefined,
    model: model.model,
  });
  return result.ok
    ? { ok: true, message: "Spintax ready.", spintax: result.spintax }
    : { ok: false, message: result.error };
}

export async function updateCampaignOverridesAction(
  campaignId: string,
  patch: CampaignOverrides,
): Promise<ActionResult> {
  const profile = await requireActiveProfile();
  const id = parseCampaignId(campaignId);
  if (!id) return { ok: false, message: "Invalid Smartlead campaign ID." };
  const parsed = campaignOverridesSchema.safeParse(patch);
  if (!parsed.success) return { ok: false, message: "Invalid campaign overrides." };

  const result = await updateCampaignOverrides(id, parsed.data, profile.email);
  if (result.ok) revalidatePath("/campaigns");
  return result;
}

export async function setCampaignStatusAction(
  campaignId: string,
  status: SmartleadCampaignStatus,
): Promise<ActionResult> {
  await requireActiveProfile();
  const id = parseCampaignId(campaignId);
  const parsedStatus = statusSchema.safeParse(status);
  if (!id || !parsedStatus.success) return { ok: false, message: "Invalid campaign status update." };

  try {
    await updateCampaignStatus(id, parsedStatus.data);
    void markCampaignBriefDirty(id).catch(() => undefined);
    revalidatePath("/campaigns");
    return { ok: true, message: `Campaign status set to ${parsedStatus.data}.` };
  } catch (error) {
    return { ok: false, message: errorMessage(error, "Could not update campaign status.") };
  }
}

export async function updateCampaignLimitsAction(
  campaignId: string,
  patch: { maxLeadsPerDay?: number; minTimeBtwnEmails?: number },
): Promise<ActionResult> {
  await requireActiveProfile();
  const id = parseCampaignId(campaignId);
  const parsed = limitsSchema.safeParse(patch);
  if (!id || !parsed.success) return { ok: false, message: "Invalid campaign limits." };

  try {
    await updateCampaignSettings(id, parsed.data);
    revalidatePath("/campaigns");
    return { ok: true, message: "Campaign limits updated." };
  } catch (error) {
    return { ok: false, message: errorMessage(error, "Could not update campaign limits.") };
  }
}

export async function updateCampaignGeneralSettingsAction(
  campaignId: string,
  patch: CampaignGeneralPatch,
): Promise<ActionResult> {
  await requireActiveProfile();
  const id = parseCampaignId(campaignId);
  const parsed = generalSettingsSchema.safeParse(patch);
  if (!id || !parsed.success) return { ok: false, message: "Invalid campaign general settings." };

  try {
    await updateCampaignGeneralSettingsRequest(id, parsed.data);
    void markCampaignBriefDirty(id).catch(() => undefined);
    revalidatePath("/campaigns");
    return { ok: true, message: "Campaign general settings updated." };
  } catch (error) {
    return { ok: false, message: errorMessage(error, "Could not update campaign general settings.") };
  }
}

export async function updateCampaignScheduleWindowAction(
  campaignId: string,
  window: { timezone: string; daysOfTheWeek: number[]; startHour: string; endHour: string },
): Promise<ActionResult> {
  await requireActiveProfile();
  const id = parseCampaignId(campaignId);
  const parsed = scheduleWindowSchema.safeParse(window);
  if (!id || !parsed.success) return { ok: false, message: "Invalid campaign schedule." };

  try {
    await updateCampaignScheduleWindow(id, parsed.data);
    void markCampaignBriefDirty(id).catch(() => undefined);
    revalidatePath("/campaigns");
    return { ok: true, message: "Campaign schedule updated." };
  } catch (error) {
    return { ok: false, message: errorMessage(error, "Could not update campaign schedule.") };
  }
}

export async function getReplyWebhookStatusAction(
  campaignId: string,
): Promise<ActionResult & { status?: ReplyWebhookStatus }> {
  await requireActiveProfile();
  const id = parseCampaignId(campaignId);
  if (!id) return { ok: false, message: "Invalid Smartlead campaign ID." };

  try {
    const status = await getReplyWebhookStatus(id);
    return { ok: true, message: "Smartlead reply webhook status loaded.", status };
  } catch (error) {
    return { ok: false, message: errorMessage(error, "Could not load Smartlead reply webhook status.") };
  }
}

export async function registerReplyWebhookAction(campaignId: string): Promise<ActionResult> {
  return registerSmartleadWebhookAction(campaignId);
}

export type CampaignOverview = {
  summary: CampaignAnalyticsSummary;
  replyStats: CampaignReplyStats | null;
  bounceSplit: CampaignBounceSplit | null;
};

/* The KPI tile payload for a bounded range: the analytics-by-date counters
   plus the range's bounce split, shaped like the summary fields the tiles
   read. */
export type CampaignOverviewTiles = CampaignRangeAnalytics & {
  bounceSplit: CampaignBounceSplit | null;
};

/**
 * The campaign's landing analytics. Range "all" (the default) is the full
 * Overview payload: Smartlead's all-time counters and lead progress plus our
 * own classified reply stats, each source degrading independently so a
 * partial failure still renders. Bounded ranges ("30d"/"7d") return only the
 * KPI tile counters for that window.
 */
export async function getCampaignOverviewAction(
  campaignId: string,
  range: CampaignOverviewRange = "all",
): Promise<ActionResult & { overview?: CampaignOverview; tiles?: CampaignOverviewTiles }> {
  await requireActiveProfile();
  const id = parseCampaignId(campaignId);
  const parsedRange = overviewRangeSchema.safeParse(range);
  if (!id || !parsedRange.success) return { ok: false, message: "Invalid campaign overview request." };

  try {
    if (parsedRange.data !== "all") {
      const { start, end } = overviewRangeDates(parsedRange.data);
      const [analytics, bounceSplit] = await Promise.all([
        fetchCampaignAnalyticsRange(id, start, end),
        fetchCampaignBounceSplit(id, start, end).catch(() => null),
      ]);
      return { ok: true, message: "Campaign overview loaded.", tiles: { ...analytics, bounceSplit } };
    }

    const [summary, replyStats, bounceSplit] = await Promise.all([
      fetchCampaignAnalyticsSummary(id),
      getCampaignReplyStats(id).catch(() => null),
      // Recipient vs sending-mailbox bounces (Smartlead lumps them in
      // bounce_count); degrade to null so the tab still renders.
      fetchCampaignBounceSplit(id).catch(() => null),
    ]);
    return { ok: true, message: "Campaign overview loaded.", overview: { summary, replyStats, bounceSplit } };
  } catch (error) {
    return { ok: false, message: errorMessage(error, "Could not load campaign analytics.") };
  }
}

export async function getCampaignInsightsAction(campaignId: string) {
  await requireActiveProfile();
  const id = parseCampaignId(campaignId);
  if (!id) throw new Error("Invalid Smartlead campaign ID.");

  // Benchmark, cached brief, and model are independent side dishes; if one of
  // their reads fails the operational rail still renders (matching how
  // getCampaignOverviewAction degrades per source).
  const [insights, benchmark, cached, configuredModel] = await Promise.all([
    computeCampaignInsights(id),
    getBenchmark(id).catch(() => ({ line: null, computedAt: null })),
    getCachedCampaignBrief(id).catch(() => ({
      brief: null,
      generatedAt: null,
      model: null,
      // A failed cache read must not trigger a fresh generation.
      dirty: false,
      inputTokens: null,
      outputTokens: null,
    })),
    getCampaignBriefModel().catch(() => "claude-sonnet-5"),
  ]);
  return {
    signals: insights.signals,
    followUps: insights.followUps,
    followUpsTotal: insights.followUpsTotal,
    benchmark,
    brief: cached.brief,
    briefMeta: {
      generatedAt: cached.generatedAt,
      model: cached.model,
      dirty: cached.dirty,
    },
    briefModel: {
      current: configuredModel,
      options: CAMPAIGN_BRIEF_MODEL_OPTIONS,
    },
  };
}

export async function setCampaignBriefModelAction(
  campaignId: string,
  model: string,
): Promise<ActionResult & { model?: string }> {
  const auth = await requireActiveProfileResult();
  if (!auth.ok) return auth;
  const id = parseCampaignId(campaignId);
  if (!id) return { ok: false, message: "Invalid Smartlead campaign ID." };
  try {
    const saved = await setCampaignBriefModel(model, auth.profile.email);
    // The stored brief was written by the previous model; flag it so the next
    // view or regenerate rebuilds with the new one.
    await markCampaignBriefDirty(id);
    return { ok: true, message: "Campaign brief model saved.", model: saved };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : "Could not save the brief model." };
  }
}

export async function generateCampaignBriefAction(campaignId: string, force = false) {
  await requireActiveProfile();
  const id = parseCampaignId(campaignId);
  if (!id) throw new Error("Invalid Smartlead campaign ID.");

  if (force) {
    const cooldown = claimCampaignBriefForceCooldown(id);
    if (!cooldown.allowed) {
      return {
        brief: null,
        error: "Please wait two minutes before forcing another campaign brief.",
        cached: true,
        cooldown: true,
        retryAfterMs: cooldown.retryAfterMs,
      };
    }
    // The in-memory claim is per serverless instance; generated_at is the
    // cross-instance floor, so parallel tabs or lambdas cannot each buy a
    // fresh LLM call inside the window.
    const cached = await getCachedCampaignBrief(id).catch(() => null);
    const lastGeneratedMs = cached?.generatedAt ? Date.parse(cached.generatedAt) : 0;
    const dbRetryAfterMs = lastGeneratedMs + CAMPAIGN_BRIEF_FORCE_COOLDOWN_MS - Date.now();
    if (Number.isFinite(lastGeneratedMs) && dbRetryAfterMs > 0) {
      releaseCampaignBriefForceCooldown(id);
      return {
        brief: null,
        error: "Please wait two minutes before forcing another campaign brief.",
        cached: true,
        cooldown: true,
        retryAfterMs: dbRetryAfterMs,
      };
    }
    await markCampaignBriefDirty(id);
  }

  const result = await generateCampaignBrief(id, { force });
  // A force that produced no brief bought nothing; free the cooldown so the
  // operator's retry surfaces the real error instead of the wait message.
  if (force && result.error) releaseCampaignBriefForceCooldown(id);
  return { ...result, cooldown: false, retryAfterMs: 0 };
}

const LEADS_PAGE_SIZE = 50;
const leadIdSchema = z.string().regex(/^\d+$/);
const leadTextSchema = z.string().trim().max(200);
const leadUrlSchema = z.string().trim().max(500);
const leadUpdateSchema = z
  .object({
    email: z.string().trim().email().max(320),
    firstName: leadTextSchema,
    lastName: leadTextSchema,
    company: leadTextSchema,
    website: leadUrlSchema,
    location: leadTextSchema,
    phone: z.string().trim().max(50),
    linkedinUrl: leadUrlSchema,
    companyUrl: leadUrlSchema,
    variables: z
      .record(z.string().trim().min(1).max(80), z.string().trim().max(1000))
      .refine((value) => Object.keys(value).length <= 20, {
        message: "Smartlead allows at most 20 custom variables per lead.",
      }),
  })
  .strict();
const leadVariablesSchema = z
  .record(z.string().trim().min(1).max(80), z.string().trim().max(1000))
  .refine((value) => Object.keys(value).length <= 20, {
    message: "Smartlead allows at most 20 custom variables per lead.",
  });
const addLeadSchema = z
  .object({
    email: z.string().trim().email().max(320),
    firstName: leadTextSchema.optional(),
    lastName: leadTextSchema.optional(),
    company: leadTextSchema.optional(),
    website: leadUrlSchema.optional(),
    location: leadTextSchema.optional(),
    phone: leadTextSchema.optional(),
    linkedinUrl: leadUrlSchema.optional(),
    companyUrl: leadUrlSchema.optional(),
    variables: leadVariablesSchema.optional(),
  })
  .strict();
const categoryIdSchema = z.number().int().min(0);

export async function addCampaignLeadsAction(
  campaignId: string,
  leads: AddLeadsInput,
): Promise<ActionResult & { result?: AddLeadsResult }> {
  await requireActiveProfile();
  const id = parseCampaignId(campaignId);
  if (!id || !Array.isArray(leads) || leads.length === 0 || leads.length > 1000) {
    return { ok: false, message: "Invalid campaign leads." };
  }

  // Validate per row so one malformed email drops that row instead of
  // dead-ending the whole batch with a generic error.
  const validLeads: z.infer<typeof addLeadSchema>[] = [];
  let rejectedRows = 0;
  for (const lead of leads) {
    const row = addLeadSchema.safeParse(lead);
    if (row.success) validLeads.push(row.data);
    else rejectedRows += 1;
  }
  if (validLeads.length === 0) {
    return { ok: false, message: "No valid leads in the submission. Check the email column." };
  }

  const seen = new Set<string>();
  let inBatchDuplicates = 0;
  const unique = validLeads.filter((lead) => {
    const email = lead.email.toLowerCase();
    if (seen.has(email)) {
      inBatchDuplicates += 1;
      return false;
    }
    seen.add(email);
    return true;
  });

  try {
    const providerResult = await addCampaignLeads(id, unique);
    const result = {
      ...providerResult,
      duplicates: providerResult.duplicates + inBatchDuplicates,
      invalid: providerResult.invalid + rejectedRows,
    };
    const rejected = [
      result.duplicates ? `${result.duplicates} duplicates` : null,
      result.invalid ? `${result.invalid} invalid` : null,
      result.blocked ? `${result.blocked} blocked` : null,
    ].filter((part): part is string => part !== null);
    revalidatePath("/campaigns");
    return {
      ok: true,
      message: `Added ${result.uploaded} ${result.uploaded === 1 ? "lead" : "leads"}.${rejected.length ? ` ${rejected.join(", ")}.` : ""}`,
      result,
    };
  } catch (error) {
    return { ok: false, message: errorMessage(error, "Could not add campaign leads.") };
  }
}

export async function pauseCampaignLeadAction(
  campaignId: string,
  leadId: string,
): Promise<ActionResult> {
  await requireActiveProfile();
  const id = parseCampaignId(campaignId);
  const lead = leadIdSchema.safeParse(leadId);
  if (!id || !lead.success) return { ok: false, message: "Invalid campaign lead." };
  try {
    await pauseCampaignLead(id, lead.data);
    revalidatePath("/campaigns");
    return { ok: true, message: "Lead paused." };
  } catch (error) {
    return { ok: false, message: errorMessage(error, "Could not pause the lead.") };
  }
}

export async function resumeCampaignLeadAction(
  campaignId: string,
  leadId: string,
): Promise<ActionResult> {
  await requireActiveProfile();
  const id = parseCampaignId(campaignId);
  const lead = leadIdSchema.safeParse(leadId);
  if (!id || !lead.success) return { ok: false, message: "Invalid campaign lead." };
  try {
    await resumeLead(id, lead.data);
    revalidatePath("/campaigns");
    return { ok: true, message: "Lead resumed." };
  } catch (error) {
    return { ok: false, message: errorMessage(error, "Could not resume the lead.") };
  }
}

export async function unsubscribeCampaignLeadAction(
  campaignId: string,
  leadId: string,
): Promise<ActionResult> {
  await requireActiveProfile();
  const id = parseCampaignId(campaignId);
  const lead = leadIdSchema.safeParse(leadId);
  if (!id || !lead.success) return { ok: false, message: "Invalid campaign lead." };
  try {
    await unsubscribeCampaignLead(id, lead.data);
    revalidatePath("/campaigns");
    return { ok: true, message: "Lead unsubscribed from this campaign." };
  } catch (error) {
    return { ok: false, message: errorMessage(error, "Could not unsubscribe the lead.") };
  }
}

export async function removeCampaignLeadAction(
  campaignId: string,
  leadId: string,
): Promise<ActionResult> {
  await requireActiveProfile();
  const id = parseCampaignId(campaignId);
  const lead = leadIdSchema.safeParse(leadId);
  if (!id || !lead.success) return { ok: false, message: "Invalid campaign lead." };
  try {
    await removeCampaignLead(id, lead.data);
    revalidatePath("/campaigns");
    return { ok: true, message: "Lead removed." };
  } catch (error) {
    return { ok: false, message: errorMessage(error, "Could not remove the lead.") };
  }
}

export async function setCampaignLeadCategoryAction(
  campaignId: string,
  leadId: string,
  categoryId: number,
  pauseLead: boolean,
): Promise<ActionResult> {
  await requireActiveProfile();
  const id = parseCampaignId(campaignId);
  const lead = leadIdSchema.safeParse(leadId);
  const category = categoryIdSchema.safeParse(categoryId);
  const pause = z.boolean().safeParse(pauseLead);
  if (!id || !lead.success || !category.success || !pause.success) {
    return { ok: false, message: "Invalid lead category update." };
  }
  try {
    await setCampaignLeadCategory(id, lead.data, category.data, pause.data);
    revalidatePath("/campaigns");
    return { ok: true, message: "Lead category updated." };
  } catch (error) {
    return { ok: false, message: errorMessage(error, "Could not update the lead category.") };
  }
}

export async function getSmartleadCategoriesAction(): Promise<
  ActionResult & { categories?: SmartleadGlobalCategory[] }
> {
  await requireActiveProfile();
  try {
    const categories = await listSmartleadCategories();
    return { ok: true, message: "Smartlead categories loaded.", categories };
  } catch (error) {
    return { ok: false, message: errorMessage(error, "Could not load Smartlead categories.") };
  }
}

// Bulk loading uses the endpoint's maximum page size (live-verified: 100;
// larger limits return 400) so a full campaign needs the fewest requests.
const LEADS_BULK_CHUNK = 100;
const leadsOffsetSchema = z.number().int().min(0).max(100_000);

/** One maximum-size chunk of campaign leads, for the client's load-all loop. */
export async function getCampaignLeadsChunkAction(
  campaignId: string,
  offset: number,
): Promise<ActionResult & { total?: number; leads?: CampaignLeadRow[]; offset?: number; chunk?: number }> {
  await requireActiveProfile();
  const id = parseCampaignId(campaignId);
  const parsedOffset = leadsOffsetSchema.safeParse(offset);
  if (!id || !parsedOffset.success) return { ok: false, message: "Invalid leads request." };

  try {
    const result = await fetchCampaignLeadsPage(id, parsedOffset.data, LEADS_BULK_CHUNK);
    return {
      ok: true,
      message: "Leads chunk loaded.",
      total: result.total,
      leads: result.leads,
      offset: parsedOffset.data,
      chunk: LEADS_BULK_CHUNK,
    };
  } catch (error) {
    return { ok: false, message: errorMessage(error, "Could not load leads.") };
  }
}

/**
 * Update a lead's identity fields and custom variables. The email is the
 * identity anchor Smartlead requires in the body — the UI never changes it.
 */
export async function updateCampaignLeadAction(
  campaignId: string,
  leadId: string,
  input: CampaignLeadUpdate,
): Promise<ActionResult> {
  await requireActiveProfile();
  const id = parseCampaignId(campaignId);
  const lead = leadIdSchema.safeParse(leadId);
  const parsed = leadUpdateSchema.safeParse(input);
  if (!id || !lead.success || !parsed.success) {
    return { ok: false, message: "Invalid lead update." };
  }
  try {
    await updateCampaignLead(id, lead.data, parsed.data);
    return { ok: true, message: "Lead updated." };
  } catch (error) {
    return { ok: false, message: errorMessage(error, "Could not update the lead.") };
  }
}

const leadsPageSchema = z.number().int().min(0).max(10_000);

/** One page of the campaign's loaded leads (fixed page size, offset-based). */
export async function getCampaignLeadsAction(
  campaignId: string,
  page: number,
): Promise<ActionResult & { total?: number; leads?: CampaignLeadRow[]; page?: number; pageSize?: number }> {
  await requireActiveProfile();
  const id = parseCampaignId(campaignId);
  const parsedPage = leadsPageSchema.safeParse(page);
  if (!id || !parsedPage.success) return { ok: false, message: "Invalid leads request." };

  try {
    const result = await fetchCampaignLeadsPage(id, parsedPage.data * LEADS_PAGE_SIZE, LEADS_PAGE_SIZE);
    return {
      ok: true,
      message: "Campaign leads loaded.",
      total: result.total,
      leads: result.leads,
      page: parsedPage.data,
      pageSize: LEADS_PAGE_SIZE,
    };
  } catch (error) {
    return { ok: false, message: errorMessage(error, "Could not load campaign leads.") };
  }
}

/* Smartlead's computed merge tags (sl_day_of_the_week and friends) in the
   workspace timezone — shared by both preview-lead actions. */
async function computedPreviewTags(): Promise<Record<string, string>> {
  const workspace = await getWorkspaceSettings();
  const weekday = new Intl.DateTimeFormat("en-US", {
    weekday: "long",
    timeZone: workspace.timeZone,
  }).format(new Date());
  return { sl_day_of_the_week: weekday, sl_day_of_week: weekday };
}

/**
 * Real-lead data for sequence previews: a populated lead from the campaign
 * plus Smartlead's computed tags (sl_day_of_the_week and friends) in the
 * workspace timezone. Missing tags render as variables in the preview.
 */
export async function getCampaignPreviewLeadAction(
  campaignId: string,
): Promise<ActionResult & { lead?: CampaignPreviewLead | null; computed?: Record<string, string> }> {
  await requireActiveProfile();
  const id = parseCampaignId(campaignId);
  if (!id) return { ok: false, message: "Invalid campaign id." };

  const computed = await computedPreviewTags();

  try {
    const lead = await fetchCampaignPreviewLead(id);
    return { ok: true, message: lead ? "Preview lead loaded." : "No populated leads in this campaign yet.", lead, computed };
  } catch (error) {
    // Preview data is a convenience — surface the computed tags regardless.
    return { ok: false, message: errorMessage(error, "Could not load a preview lead."), lead: null, computed };
  }
}

const previewLeadQuerySchema = z.string().max(200);
/* Enough options to fill the picker (and Shuffle's lead pool) without
   scrolling forever. */
const PREVIEW_SEARCH_MATCHES = 10;
/* Smartlead's leads endpoint has no search parameter, so matching means
   scanning pages. Bounded so one keystroke can never fan out across a
   50k-lead campaign. */
const PREVIEW_SEARCH_SCAN_CAP = 1_000;

export type PreviewLeadOption = {
  label: string;
  /** Merge-tag values keyed like the sequence copy sees them (first_name…). */
  values: Record<string, string>;
};

function previewOptionFromRow(row: CampaignLeadRow): PreviewLeadOption | null {
  const values: Record<string, string> = {};
  const fields: [string, string][] = [
    ["first_name", row.firstName],
    ["last_name", row.lastName],
    ["email", row.email],
    ["company_name", row.company],
    ["website", row.website],
    ["location", row.location],
    ["phone_number", row.phone],
  ];
  for (const [key, value] of fields) if (value) values[key] = value;
  for (const [key, value] of Object.entries(row.variables)) if (value) values[key] = value;
  if (!values.first_name && !values.email) return null; // removed/placeholder map rows
  const name = [values.first_name, values.last_name].filter(Boolean).join(" ") || values.email;
  return { label: values.company_name ? `${name} · ${values.company_name}` : name, values };
}

/* The campaign's sending accounts joined with their Zapmail profile pictures,
   for the sequence preview's "from" identity — so the mock shows the real
   face and address a lead would see, and makes a faceless account obvious. */
export async function listCampaignSenderAccountsAction(
  campaignId: string,
): Promise<ActionResult & { senders?: { email: string; name: string | null; avatarUrl: string | null }[] }> {
  const auth = await requireActiveProfileResult();
  if (!auth.ok) return auth;
  const id = parseCampaignId(campaignId);
  if (!id) return { ok: false, message: "Invalid campaign." };
  try {
    const [accounts, avatars] = await Promise.all([
      getCampaignSenderAccounts(id),
      getInboxAvatarMap().catch(() => ({}) as Record<string, string>),
    ]);
    return {
      ok: true,
      message: "Senders loaded.",
      senders: accounts.map((account) => ({ ...account, avatarUrl: avatars[account.email] ?? null })),
    };
  } catch (error) {
    return { ok: false, message: errorMessage(error, "Could not load the campaign's sending accounts.") };
  }
}

/**
 * Leads matching a search, for the sequence preview's lead picker. An empty
 * query returns the campaign's first populated leads (the picker's default
 * list). `exhausted` reports whether the scan reached the campaign's end —
 * false means matches beyond the scan cap may exist.
 */
export async function searchCampaignPreviewLeadsAction(
  campaignId: string,
  query: string,
): Promise<ActionResult & { leads?: PreviewLeadOption[]; computed?: Record<string, string>; exhausted?: boolean }> {
  await requireActiveProfile();
  const id = parseCampaignId(campaignId);
  const parsedQuery = previewLeadQuerySchema.safeParse(query);
  if (!id || !parsedQuery.success) return { ok: false, message: "Invalid lead search." };
  const needle = parsedQuery.data.trim().toLowerCase();

  try {
    const matches: PreviewLeadOption[] = [];
    let offset = 0;
    let exhausted = false;
    while (matches.length < PREVIEW_SEARCH_MATCHES && offset < PREVIEW_SEARCH_SCAN_CAP) {
      const page = await fetchCampaignLeadsPage(id, offset, LEADS_BULK_CHUNK);
      for (const row of page.leads) {
        if (matches.length >= PREVIEW_SEARCH_MATCHES) break;
        const option = previewOptionFromRow(row);
        if (!option) continue;
        if (needle) {
          const haystack = [
            `${row.firstName} ${row.lastName}`,
            row.email,
            row.company,
          ].join(" ").toLowerCase();
          if (!haystack.includes(needle)) continue;
        }
        matches.push(option);
      }
      offset += LEADS_BULK_CHUNK;
      if (offset >= page.total || page.leads.length < LEADS_BULK_CHUNK) {
        exhausted = true;
        break;
      }
    }
    return {
      ok: true,
      message: "Preview leads searched.",
      leads: matches,
      computed: await computedPreviewTags(),
      exhausted,
    };
  } catch (error) {
    return { ok: false, message: errorMessage(error, "Could not search the campaign's leads.") };
  }
}
