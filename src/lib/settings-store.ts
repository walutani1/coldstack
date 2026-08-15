import "server-only";

import { z } from "zod";
import { getAdminClient } from "@/lib/supabase/admin";

export type StyleExample = {
  id: string;
  leadMessage: string;
  reply: string;
};

export type AiSettings = {
  campaignContext: string;
  model: string | null;
  draftingEnabled: boolean;
  senderName: string;
  senderTitle: string;
  senderCompany: string;
  draftContext: string;
  styleExamples: StyleExample[];
  extraVoiceRules: string;
  signature: string;
  autoHandleOoo: boolean;
  autoHandleDeadMailbox: boolean;
  resumeBusinessDaysAfterReturn: number;
  resumeDefaultWaitDays: number;
  colleagueResearchEnabled: boolean;
  colleagueRolesHint: string;
};

export type IntegrationSettings = {
  smartleadApiBaseUrl: string | null;
  zapmailWorkspaceId: string;
  zapmailServiceProvider: "GOOGLE" | "MICROSOFT";
  emailProvider: "resend" | "smtp" | null;
  emailFrom: string | null;
  smtpHost: string | null;
  smtpPort: number | null;
  smtpUser: string | null;
  smtpSecure: boolean | null;
};

export type WorkspaceSettings = {
  workspaceName: string;
  tagline: string;
  timeZone: string;
  timeLocale: string;
};

export const DEFAULT_WORKSPACE_SETTINGS: WorkspaceSettings = {
  workspaceName: "Coldstack",
  tagline: "Cold email workspace",
  timeZone: "UTC",
  timeLocale: "en-US",
};

export const DEFAULT_INTEGRATION_SETTINGS: IntegrationSettings = {
  smartleadApiBaseUrl: null,
  zapmailWorkspaceId: "",
  zapmailServiceProvider: "GOOGLE",
  emailProvider: null,
  emailFrom: null,
  smtpHost: null,
  smtpPort: null,
  smtpUser: null,
  smtpSecure: null,
};

export const DEFAULT_AI_SETTINGS: AiSettings = {
  campaignContext:
    "This is a B2B cold-outreach campaign. The goal is to reach the right decision-maker and start a conversation.",
  model: null,
  draftingEnabled: true,
  senderName: "",
  senderTitle: "",
  senderCompany: "",
  draftContext:
    "You are drafting a friendly, low-pressure reply on behalf of the sender to keep the conversation moving.",
  styleExamples: [],
  extraVoiceRules: "",
  signature: "",
  autoHandleOoo: true,
  autoHandleDeadMailbox: true,
  resumeBusinessDaysAfterReturn: 2,
  resumeDefaultWaitDays: 10,
  colleagueResearchEnabled: true,
  colleagueRolesHint: "operations, customer service, or other roles relevant to this outreach",
};

export const styleExampleSchema = z
  .object({
    id: z.string().min(1).max(2000),
    leadMessage: z.string().max(2000),
    reply: z.string().min(1).max(2000),
  })
  .strict();
export const styleExamplesSchema = z.array(styleExampleSchema).max(6);

const modelSchema = z.string().max(64).regex(/^[a-z0-9.:-]+$/).nullable();
const settingsSchema = z.object({
  campaignContext: z.string().max(4000).catch(DEFAULT_AI_SETTINGS.campaignContext),
  model: modelSchema.catch(DEFAULT_AI_SETTINGS.model),
  draftingEnabled: z.boolean().catch(DEFAULT_AI_SETTINGS.draftingEnabled),
  senderName: z.string().max(120).catch(DEFAULT_AI_SETTINGS.senderName),
  senderTitle: z.string().max(120).catch(DEFAULT_AI_SETTINGS.senderTitle),
  senderCompany: z.string().max(120).catch(DEFAULT_AI_SETTINGS.senderCompany),
  draftContext: z.string().max(4000).catch(DEFAULT_AI_SETTINGS.draftContext),
  styleExamples: styleExamplesSchema.catch(DEFAULT_AI_SETTINGS.styleExamples),
  extraVoiceRules: z.string().max(1000).catch(DEFAULT_AI_SETTINGS.extraVoiceRules),
  signature: z.string().max(1000).catch(DEFAULT_AI_SETTINGS.signature),
  autoHandleOoo: z.boolean().catch(DEFAULT_AI_SETTINGS.autoHandleOoo),
  autoHandleDeadMailbox: z.boolean().catch(DEFAULT_AI_SETTINGS.autoHandleDeadMailbox),
  resumeBusinessDaysAfterReturn: z
    .number()
    .int()
    .min(0)
    .max(30)
    .catch(DEFAULT_AI_SETTINGS.resumeBusinessDaysAfterReturn),
  resumeDefaultWaitDays: z
    .number()
    .int()
    .min(1)
    .max(60)
    .catch(DEFAULT_AI_SETTINGS.resumeDefaultWaitDays),
  colleagueResearchEnabled: z.boolean().catch(DEFAULT_AI_SETTINGS.colleagueResearchEnabled),
  colleagueRolesHint: z.string().max(300).catch(DEFAULT_AI_SETTINGS.colleagueRolesHint),
});
const settingsPatchSchema = z
  .object({
    campaignContext: z.string().max(4000).optional(),
    model: modelSchema.optional(),
    draftingEnabled: z.boolean().optional(),
    senderName: z.string().max(120).optional(),
    senderTitle: z.string().max(120).optional(),
    senderCompany: z.string().max(120).optional(),
    draftContext: z.string().max(4000).optional(),
    styleExamples: styleExamplesSchema.optional(),
    extraVoiceRules: z.string().max(1000).optional(),
    signature: z.string().max(1000).optional(),
    autoHandleOoo: z.boolean().optional(),
    autoHandleDeadMailbox: z.boolean().optional(),
    resumeBusinessDaysAfterReturn: z.number().int().min(0).max(30).optional(),
    resumeDefaultWaitDays: z.number().int().min(1).max(60).optional(),
    colleagueResearchEnabled: z.boolean().optional(),
    colleagueRolesHint: z.string().max(300).optional(),
  })
  .strict();

// https only: the Smartlead API key travels to whatever host is configured
// here, so a plaintext or internal-network target must never be accepted.
const nullableUrlSchema = z
  .string()
  .url()
  .max(500)
  .refine((value) => value.startsWith("https://"), { message: "Must be an https:// URL." })
  .nullable();
const nullableTextSchema = z.string().min(1).max(500).nullable();
const integrationSettingsSchema = z.object({
  smartleadApiBaseUrl: nullableUrlSchema.catch(DEFAULT_INTEGRATION_SETTINGS.smartleadApiBaseUrl),
  zapmailWorkspaceId: z.string().trim().catch(DEFAULT_INTEGRATION_SETTINGS.zapmailWorkspaceId),
  zapmailServiceProvider: z
    .enum(["GOOGLE", "MICROSOFT"])
    .catch(DEFAULT_INTEGRATION_SETTINGS.zapmailServiceProvider),
  emailProvider: z.enum(["resend", "smtp"]).nullable().catch(DEFAULT_INTEGRATION_SETTINGS.emailProvider),
  emailFrom: nullableTextSchema.catch(DEFAULT_INTEGRATION_SETTINGS.emailFrom),
  smtpHost: nullableTextSchema.catch(DEFAULT_INTEGRATION_SETTINGS.smtpHost),
  smtpPort: z.number().int().min(1).max(65535).nullable().catch(DEFAULT_INTEGRATION_SETTINGS.smtpPort),
  smtpUser: nullableTextSchema.catch(DEFAULT_INTEGRATION_SETTINGS.smtpUser),
  smtpSecure: z.boolean().nullable().catch(DEFAULT_INTEGRATION_SETTINGS.smtpSecure),
});
const integrationSettingsPatchSchema = z
  .object({
    smartleadApiBaseUrl: nullableUrlSchema.optional(),
    zapmailWorkspaceId: z.string().trim().optional(),
    zapmailServiceProvider: z.enum(["GOOGLE", "MICROSOFT"]).optional(),
    emailProvider: z.enum(["resend", "smtp"]).nullable().optional(),
    emailFrom: nullableTextSchema.optional(),
    smtpHost: nullableTextSchema.optional(),
    smtpPort: z.number().int().min(1).max(65535).nullable().optional(),
    smtpUser: nullableTextSchema.optional(),
    smtpSecure: z.boolean().nullable().optional(),
  })
  .strict();

export function isValidTimeZone(value: string): boolean {
  try {
    if (typeof Intl.supportedValuesOf === "function") {
      // ECMA-402's primary-identifier list can omit the valid UTC alias.
      return value === "UTC" || Intl.supportedValuesOf("timeZone").includes(value);
    }
    new Intl.DateTimeFormat(undefined, { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

export function isValidTimeLocale(value: string): boolean {
  try {
    new Intl.DateTimeFormat(value);
    // Structurally valid but unknown tags (for example xx-INVALID) can silently
    // fall back to the runtime locale, so require actual runtime support too.
    return Intl.DateTimeFormat.supportedLocalesOf([value]).length === 1;
  } catch {
    return false;
  }
}

const timeZoneSchema = z.string().refine(isValidTimeZone);
const timeLocaleSchema = z.string().refine(isValidTimeLocale);
const workspaceSettingsSchema = z.object({
  workspaceName: z.string().min(1).max(60).catch(DEFAULT_WORKSPACE_SETTINGS.workspaceName),
  tagline: z.string().max(120).catch(DEFAULT_WORKSPACE_SETTINGS.tagline),
  timeZone: timeZoneSchema.catch(DEFAULT_WORKSPACE_SETTINGS.timeZone),
  timeLocale: timeLocaleSchema.catch(DEFAULT_WORKSPACE_SETTINGS.timeLocale),
});
const workspaceSettingsPatchSchema = z
  .object({
    workspaceName: z.string().min(1).max(60).optional(),
    tagline: z.string().max(120).optional(),
    timeZone: timeZoneSchema.optional(),
    timeLocale: timeLocaleSchema.optional(),
  })
  .strict();

const CACHE_TTL_MS = 30_000;
const SETTINGS_KEY = "ai_automation";
const INTEGRATIONS_KEY = "integrations";
const WORKSPACE_KEY = "workspace";
let cached: { expiresAt: number; promise: Promise<AiSettings> } | null = null;
let integrationsCached: { expiresAt: number; promise: Promise<IntegrationSettings> } | null = null;
let workspaceCached: { expiresAt: number; promise: Promise<WorkspaceSettings> } | null = null;

function parseSettings(value: unknown): AiSettings {
  const document = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  return settingsSchema.parse({ ...DEFAULT_AI_SETTINGS, ...document });
}

function parseIntegrationSettings(value: unknown): IntegrationSettings {
  const document = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  return integrationSettingsSchema.parse({ ...DEFAULT_INTEGRATION_SETTINGS, ...document });
}

function parseWorkspaceSettings(value: unknown): WorkspaceSettings {
  const document = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  return workspaceSettingsSchema.parse({ ...DEFAULT_WORKSPACE_SETTINGS, ...document });
}

async function loadAiSettings(): Promise<AiSettings> {
  try {
    const { data, error } = await getAdminClient()
      .from("app_settings")
      .select("value")
      .eq("key", SETTINGS_KEY)
      .maybeSingle();
    if (error || !data) return { ...DEFAULT_AI_SETTINGS };
    return parseSettings(data.value);
  } catch {
    return { ...DEFAULT_AI_SETTINGS };
  }
}

export async function getAiSettings(): Promise<AiSettings> {
  const now = Date.now();
  if (!cached || cached.expiresAt <= now) {
    cached = { expiresAt: now + CACHE_TTL_MS, promise: loadAiSettings() };
  }
  return cached.promise;
}

export function invalidateAiSettings(): void {
  cached = null;
}

async function loadIntegrationSettings(): Promise<IntegrationSettings> {
  try {
    const { data, error } = await getAdminClient()
      .from("app_settings")
      .select("value")
      .eq("key", INTEGRATIONS_KEY)
      .maybeSingle();
    if (error || !data) return { ...DEFAULT_INTEGRATION_SETTINGS };
    return parseIntegrationSettings(data.value);
  } catch {
    return { ...DEFAULT_INTEGRATION_SETTINGS };
  }
}

export async function getIntegrationSettings(): Promise<IntegrationSettings> {
  const now = Date.now();
  if (!integrationsCached || integrationsCached.expiresAt <= now) {
    integrationsCached = { expiresAt: now + CACHE_TTL_MS, promise: loadIntegrationSettings() };
  }
  return integrationsCached.promise;
}

export function invalidateIntegrationSettings(): void {
  integrationsCached = null;
}

async function loadWorkspaceSettings(): Promise<WorkspaceSettings> {
  try {
    const { data, error } = await getAdminClient()
      .from("app_settings")
      .select("value")
      .eq("key", WORKSPACE_KEY)
      .maybeSingle();
    if (error || !data) return { ...DEFAULT_WORKSPACE_SETTINGS };
    return parseWorkspaceSettings(data.value);
  } catch {
    return { ...DEFAULT_WORKSPACE_SETTINGS };
  }
}

export async function getWorkspaceSettings(): Promise<WorkspaceSettings> {
  const now = Date.now();
  if (!workspaceCached || workspaceCached.expiresAt <= now) {
    workspaceCached = { expiresAt: now + CACHE_TTL_MS, promise: loadWorkspaceSettings() };
  }
  return workspaceCached.promise;
}

export function invalidateWorkspaceSettings(): void {
  workspaceCached = null;
}

export async function updateAiSettings(
  patch: Partial<AiSettings>,
  updatedBy: string,
): Promise<{ ok: boolean; message: string }> {
  const parsed = settingsPatchSchema.safeParse(patch);
  if (!parsed.success) return { ok: false, message: "Invalid AI and automation settings." };

  const { data: existing, error: readError } = await getAdminClient()
    .from("app_settings")
    .select("value")
    .eq("key", SETTINGS_KEY)
    .maybeSingle();
  if (readError) return { ok: false, message: readError.message };

  const current = existing ? parseSettings(existing.value) : { ...DEFAULT_AI_SETTINGS };
  const value = settingsSchema.parse({ ...current, ...parsed.data });
  const { data, error } = await getAdminClient()
    .from("app_settings")
    .upsert({
      key: SETTINGS_KEY,
      value,
      updated_at: new Date().toISOString(),
      updated_by: updatedBy,
    })
    .select("value")
    .single();
  if (error || !data) {
    return { ok: false, message: error?.message ?? "Could not update AI and automation settings." };
  }

  invalidateAiSettings();
  return { ok: true, message: "AI and automation settings updated." };
}

export async function updateIntegrationSettings(
  patch: Partial<IntegrationSettings>,
  updatedBy: string,
): Promise<{ ok: boolean; message: string }> {
  const parsed = integrationSettingsPatchSchema.safeParse(patch);
  if (!parsed.success) return { ok: false, message: "Invalid integration settings." };

  const { data: existing, error: readError } = await getAdminClient()
    .from("app_settings")
    .select("value")
    .eq("key", INTEGRATIONS_KEY)
    .maybeSingle();
  if (readError) return { ok: false, message: readError.message };

  const current = existing
    ? parseIntegrationSettings(existing.value)
    : { ...DEFAULT_INTEGRATION_SETTINGS };
  const value = integrationSettingsSchema.parse({ ...current, ...parsed.data });
  const { data, error } = await getAdminClient()
    .from("app_settings")
    .upsert({
      key: INTEGRATIONS_KEY,
      value,
      updated_at: new Date().toISOString(),
      updated_by: updatedBy,
    })
    .select("value")
    .single();
  if (error || !data) {
    return { ok: false, message: error?.message ?? "Could not update integration settings." };
  }

  invalidateIntegrationSettings();
  return { ok: true, message: "Integration settings updated." };
}

export async function updateWorkspaceSettings(
  patch: Partial<WorkspaceSettings>,
  updatedBy: string,
): Promise<{ ok: boolean; message: string }> {
  const parsed = workspaceSettingsPatchSchema.safeParse(patch);
  if (!parsed.success) return { ok: false, message: "Invalid workspace settings." };

  const { data: existing, error: readError } = await getAdminClient()
    .from("app_settings")
    .select("value")
    .eq("key", WORKSPACE_KEY)
    .maybeSingle();
  if (readError) return { ok: false, message: readError.message };

  const current = existing
    ? parseWorkspaceSettings(existing.value)
    : { ...DEFAULT_WORKSPACE_SETTINGS };
  const value = workspaceSettingsSchema.parse({ ...current, ...parsed.data });
  const { data, error } = await getAdminClient()
    .from("app_settings")
    .upsert({
      key: WORKSPACE_KEY,
      value,
      updated_at: new Date().toISOString(),
      updated_by: updatedBy,
    })
    .select("value")
    .single();
  if (error || !data) {
    return { ok: false, message: error?.message ?? "Could not update workspace settings." };
  }

  invalidateWorkspaceSettings();
  return { ok: true, message: "Workspace settings updated." };
}
