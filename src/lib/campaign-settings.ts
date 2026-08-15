import "server-only";

import { z } from "zod";
import { getAdminClient } from "@/lib/supabase/admin";
import { getTaxonomy } from "@/lib/taxonomy-store";
import type { ReplyCategory } from "@/lib/taxonomy";
import {
  getAiSettings,
  styleExamplesSchema,
  type AiSettings,
  type StyleExample,
} from "@/lib/settings-store";

export type CategoryOverride = {
  suppress?: boolean | null;
  dnc?: boolean | null;
  draftReply?: boolean | null;
  draftGuidance?: string | null;
};

export type CampaignOverrides = {
  campaignContext?: string | null;
  draftingEnabled?: boolean | null;
  senderName?: string | null;
  senderTitle?: string | null;
  senderCompany?: string | null;
  draftContext?: string | null;
  styleExamples?: StyleExample[] | null;
  extraVoiceRules?: string | null;
  signature?: string | null;
  autoHandleOoo?: boolean | null;
  autoHandleDeadMailbox?: boolean | null;
  resumeBusinessDaysAfterReturn?: number | null;
  resumeDefaultWaitDays?: number | null;
  colleagueResearchEnabled?: boolean | null;
  colleagueRolesHint?: string | null;
  /**
   * Per-category behavior overrides, keyed by taxonomy value. In an update
   * patch this map uses REPLACEMENT semantics (it is the complete new state;
   * anything absent is removed) — unlike the scalar fields above, where
   * absent = keep and null = remove.
   */
  categories?: Record<string, CategoryOverride> | null;
};

const nullableText = (max: number) => z.string().max(max).nullable().optional();
const categoryOverrideSchema = z
  .object({
    suppress: z.boolean().nullable().optional(),
    dnc: z.boolean().nullable().optional(),
    draftReply: z.boolean().nullable().optional(),
    draftGuidance: nullableText(600),
  })
  .strict();

export const campaignOverridesSchema = z
  .object({
    campaignContext: nullableText(4000),
    draftingEnabled: z.boolean().nullable().optional(),
    senderName: nullableText(120),
    senderTitle: nullableText(120),
    senderCompany: nullableText(120),
    draftContext: nullableText(4000),
    styleExamples: styleExamplesSchema.nullable().optional(),
    extraVoiceRules: nullableText(1000),
    signature: nullableText(1000),
    autoHandleOoo: z.boolean().nullable().optional(),
    autoHandleDeadMailbox: z.boolean().nullable().optional(),
    resumeBusinessDaysAfterReturn: z.number().int().min(0).max(30).nullable().optional(),
    resumeDefaultWaitDays: z.number().int().min(1).max(60).nullable().optional(),
    colleagueResearchEnabled: z.boolean().nullable().optional(),
    colleagueRolesHint: nullableText(300),
    categories: z.record(z.string(), categoryOverrideSchema).nullable().optional(),
  })
  .strict();

const CAMPAIGN_ID_SCHEMA = z.string().min(1);
const CACHE_TTL_MS = 30_000;
const MAX_CACHE_ENTRIES = 200;
const cache = new Map<string, { expiresAt: number; promise: Promise<CampaignOverrides> }>();

function parseStored(value: unknown): CampaignOverrides {
  const parsed = campaignOverridesSchema.safeParse(value);
  return parsed.success ? parsed.data : {};
}

async function loadCampaignOverrides(campaignId: string): Promise<CampaignOverrides> {
  try {
    const { data, error } = await getAdminClient()
      .from("campaign_settings")
      .select("overrides")
      .eq("campaign_id", campaignId)
      .maybeSingle();
    if (error || !data) return {};
    return parseStored(data.overrides);
  } catch {
    return {};
  }
}

export async function getCampaignOverrides(campaignId: string): Promise<CampaignOverrides> {
  if (!CAMPAIGN_ID_SCHEMA.safeParse(campaignId).success) return {};
  const now = Date.now();
  const existing = cache.get(campaignId);
  if (existing && existing.expiresAt > now) return existing.promise;

  if (!existing && cache.size >= MAX_CACHE_ENTRIES) {
    const oldestKey = cache.keys().next().value as string | undefined;
    if (oldestKey) cache.delete(oldestKey);
  }
  const entry = {
    expiresAt: now + CACHE_TTL_MS,
    promise: loadCampaignOverrides(campaignId),
  };
  cache.delete(campaignId);
  cache.set(campaignId, entry);
  return entry.promise;
}

export function invalidateCampaignOverrides(campaignId?: string): void {
  if (campaignId === undefined) cache.clear();
  else cache.delete(campaignId);
}

// REPLACEMENT semantics: a `categories` map in a patch is the complete new
// category-override state (the UI always sends the full cleaned map). A field
// or category absent from the patch is therefore REMOVED — merge semantics
// here made "cycle back to Inherit" a silent no-op, because the client never
// sends explicit nulls for category fields.
function replaceCategoryOverrides(
  patch: Record<string, CategoryOverride>,
): Record<string, CategoryOverride> | undefined {
  const replaced: Record<string, CategoryOverride> = {};
  for (const [categoryValue, categoryPatch] of Object.entries(patch)) {
    const next: CategoryOverride = {};
    for (const [key, value] of Object.entries(categoryPatch) as [keyof CategoryOverride, boolean | string | null][]) {
      if (value !== null && value !== undefined) next[key] = value as never;
    }
    if (Object.keys(next).length > 0) replaced[categoryValue] = next;
  }
  return Object.keys(replaced).length > 0 ? replaced : undefined;
}

export async function updateCampaignOverrides(
  campaignId: string,
  patch: CampaignOverrides,
  updatedBy: string,
): Promise<{ ok: boolean; message: string }> {
  if (!CAMPAIGN_ID_SCHEMA.safeParse(campaignId).success) {
    return { ok: false, message: "Invalid campaign id." };
  }
  const parsed = campaignOverridesSchema.safeParse(patch);
  if (!parsed.success) return { ok: false, message: "Invalid campaign overrides." };

  const taxonomy = await getTaxonomy();
  const categoryValues = new Set(taxonomy.all.map((category) => category.value));
  if (parsed.data.categories && Object.keys(parsed.data.categories).some((key) => !categoryValues.has(key))) {
    return { ok: false, message: "Campaign overrides contain an unknown reply category." };
  }

  const admin = getAdminClient();
  const { data: existing, error: readError } = await admin
    .from("campaign_settings")
    .select("overrides")
    .eq("campaign_id", campaignId)
    .maybeSingle();
  if (readError) return { ok: false, message: readError.message };

  const current = existing ? parseStored(existing.overrides) : {};
  const next: CampaignOverrides = { ...current };
  for (const [key, value] of Object.entries(parsed.data) as [keyof CampaignOverrides, CampaignOverrides[keyof CampaignOverrides]][]) {
    if (key === "categories" && value && typeof value === "object" && !Array.isArray(value)) {
      const categories = replaceCategoryOverrides(value as Record<string, CategoryOverride>);
      if (categories) next.categories = categories;
      else delete next.categories;
    } else if (value === null) {
      delete next[key];
    } else {
      next[key] = value as never;
    }
  }

  const clean = campaignOverridesSchema.parse(next);
  const { data, error } = await admin
    .from("campaign_settings")
    .upsert({
      campaign_id: campaignId,
      overrides: clean,
      updated_at: new Date().toISOString(),
      updated_by: updatedBy,
    })
    .select("campaign_id")
    .single();
  if (error || !data) {
    return { ok: false, message: error?.message ?? "Could not update campaign overrides." };
  }

  invalidateCampaignOverrides(campaignId);
  return { ok: true, message: "Campaign overrides updated." };
}

export async function getEffectiveAiSettings(campaignId: string | null): Promise<AiSettings> {
  const workspace = await getAiSettings();
  if (!campaignId) return workspace;
  const overrides = await getCampaignOverrides(campaignId);
  const effective: AiSettings = { ...workspace };
  for (const key of [
    "campaignContext",
    "draftingEnabled",
    "senderName",
    "senderTitle",
    "senderCompany",
    "draftContext",
    "styleExamples",
    "extraVoiceRules",
    "signature",
    "autoHandleOoo",
    "autoHandleDeadMailbox",
    "resumeBusinessDaysAfterReturn",
    "resumeDefaultWaitDays",
    "colleagueResearchEnabled",
    "colleagueRolesHint",
  ] as const) {
    const value = overrides[key];
    if (value !== null && value !== undefined) effective[key] = value as never;
  }
  return effective;
}

export function effectiveCategoryBehavior(
  category: ReplyCategory,
  overrides: CampaignOverrides,
): { suppress: boolean; dnc: boolean; draftReply: boolean; draftGuidance: string | null } {
  const override = overrides.categories?.[category.value];
  return {
    suppress: override?.suppress ?? category.suppress,
    dnc: override?.dnc ?? category.dnc,
    draftReply: override?.draftReply ?? category.draftReply,
    draftGuidance: override?.draftGuidance ?? category.draftGuidance,
  };
}
