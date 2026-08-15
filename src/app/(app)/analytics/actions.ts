"use server";

import { z } from "zod";
import { requireActiveProfile, requireActiveProfileResult } from "@/lib/auth";
import { getAnalyticsDrilldown, type AnalyticsDrillKind } from "@/lib/crm/queries";
import {
  getCampaignComparison,
  type CampaignComparisonRow,
} from "@/lib/analytics-comparison";
import {
  getAnalyticsData,
  type AnalyticsData,
  type AnalyticsFilter,
} from "@/lib/replies/queries";
import { getSendVolume, type SendVolume } from "@/lib/send-volume";
import { listCampaigns } from "@/lib/smartlead";
import type { ActionResult } from "@/lib/types";

const daysSchema = z.union([z.literal(7), z.literal(30), z.literal(90)]);
const campaignIdsSchema = z.array(z.string().regex(/^\d+$/)).min(1).max(300);
const analyticsFilterSchema = z
  .object({
    days: daysSchema.optional(),
    campaigns: z
      .object({
        mode: z.enum(["include", "exclude"]),
        ids: campaignIdsSchema,
      })
      .strict()
      .nullable()
      .optional(),
  })
  .strict();

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

export async function getAnalyticsDataAction(
  filter: AnalyticsFilter,
): Promise<ActionResult & { data?: AnalyticsData }> {
  await requireActiveProfile();
  const parsed = analyticsFilterSchema.safeParse(filter);
  if (!parsed.success) return { ok: false, message: "Invalid analytics filters." };

  try {
    const data = await getAnalyticsData(parsed.data);
    return { ok: true, message: "Analytics loaded.", data };
  } catch (error) {
    return { ok: false, message: errorMessage(error, "Could not load analytics.") };
  }
}

const drillKindSchema = z.enum(["replies","positive","referrals","awaiting_review","ooo","dnc_asked","dnc_defunct","sent_from_inbox"]);

export async function getAnalyticsDrilldownAction(kind: AnalyticsDrillKind, filter: AnalyticsFilter): Promise<ActionResult & { data?: Awaited<ReturnType<typeof getAnalyticsDrilldown>> }> {
  const auth = await requireActiveProfileResult(); if (!auth.ok) return auth;
  const parsedKind=drillKindSchema.safeParse(kind); const parsedFilter=analyticsFilterSchema.safeParse(filter);
  if (!parsedKind.success || !parsedFilter.success) return { ok:false, message:"Invalid analytics drill-down request." };
  try { return { ok:true, message:"Analytics drill-down loaded.", data:await getAnalyticsDrilldown(parsedKind.data,parsedFilter.data) }; }
  catch (error) { return { ok:false, message:errorMessage(error,"Could not load analytics drill-down.") }; }
}

const comparisonFilterSchema = z
  .object({
    mode: z.enum(["include", "exclude"]),
    ids: campaignIdsSchema,
  })
  .strict()
  .nullable();

export async function getCampaignComparisonAction(
  days: 7 | 30 | 90,
  filter?: { mode: "include" | "exclude"; ids: string[] } | null,
): Promise<ActionResult & { rows?: CampaignComparisonRow[] }> {
  await requireActiveProfile();
  const parsedDays = daysSchema.safeParse(days);
  const parsedFilter = comparisonFilterSchema.safeParse(filter ?? null);
  if (!parsedDays.success || !parsedFilter.success) {
    return { ok: false, message: "Invalid campaign comparison filters." };
  }

  try {
    const rows = await getCampaignComparison(parsedDays.data, parsedFilter.data);
    return { ok: true, message: "Campaign comparison loaded.", rows };
  } catch (error) {
    return { ok: false, message: errorMessage(error, "Could not load campaign comparison.") };
  }
}

export async function getSendVolumeAction(
  days: 7 | 30 | 90,
): Promise<ActionResult & { data?: SendVolume }> {
  await requireActiveProfile();
  const parsedDays = daysSchema.safeParse(days);
  if (!parsedDays.success) return { ok: false, message: "Invalid send volume range." };

  try {
    const data = await getSendVolume(parsedDays.data);
    return { ok: true, message: "Send volume loaded.", data };
  } catch (error) {
    return { ok: false, message: errorMessage(error, "Could not load send volume.") };
  }
}

export async function listAnalyticsCampaignsAction(): Promise<
  ActionResult & { campaigns?: { id: string; name: string; status: string | null }[] }
> {
  await requireActiveProfile();
  try {
    const campaigns = (await listCampaigns()).sort((a, b) => a.name.localeCompare(b.name));
    return { ok: true, message: "Campaigns loaded.", campaigns };
  } catch (error) {
    return { ok: false, message: errorMessage(error, "Could not load campaigns.") };
  }
}
