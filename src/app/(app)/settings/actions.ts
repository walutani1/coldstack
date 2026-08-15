"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireActiveProfile } from "@/lib/auth";
import {
  createCategory,
  deleteCategory,
  reorderCategories,
  updateCategory,
  type CreateCategoryInput,
  type UpdateCategoryPatch,
} from "@/lib/taxonomy-store";
import type { ReplyCategory, ReplySentimentType } from "@/lib/taxonomy";
import type { ActionResult } from "@/lib/types";
import {
  isValidTimeLocale,
  isValidTimeZone,
  updateAiSettings,
  updateIntegrationSettings,
  updateWorkspaceSettings,
  type AiSettings,
  type IntegrationSettings,
  type WorkspaceSettings,
  styleExamplesSchema,
} from "@/lib/settings-store";
import { clearSecret, setSecret, type SecretName } from "@/lib/secrets";
import { listCampaigns, registerReplyWebhook } from "@/lib/smartlead";
import { inviteMember, setMemberActive } from "@/lib/team";
import { clearWorkspaceLogo, LOGO_MAX_BYTES, LOGO_MIME_TYPES, setWorkspaceLogo } from "@/lib/branding";

const SENTIMENT_TYPES = new Set<ReplySentimentType>(["positive", "negative", "neutral"]);
const COLORS = new Set(["gray", "blue", "green", "amber", "red", "violet", "teal", "rose"]);

type CategoryActionResult = ActionResult & { category?: ReplyCategory };

function validText(
  value: unknown,
  field: string,
  maxLength: number,
  required = false,
): { ok: true; value: string | null } | { ok: false; message: string } {
  if (value === undefined || value === null) {
    return required
      ? { ok: false, message: `${field} is required.` }
      : { ok: true, value: null };
  }
  if (typeof value !== "string") return { ok: false, message: `${field} is invalid.` };
  const trimmed = value.trim();
  if (required && !trimmed) return { ok: false, message: `${field} is required.` };
  if (trimmed.length > maxLength) {
    return { ok: false, message: `${field} must be ${maxLength} characters or fewer.` };
  }
  return { ok: true, value: trimmed || null };
}

function validColor(value: unknown): value is string | null | undefined {
  return value === undefined || value === null || (typeof value === "string" && COLORS.has(value));
}

function revalidateTaxonomyPaths() {
  revalidatePath("/settings");
  revalidatePath("/inbox");
  revalidatePath("/notifications");
}

export async function createCategoryAction(input: CreateCategoryInput): Promise<CategoryActionResult> {
  await requireActiveProfile();
  const label = validText(input?.label, "Label", 60, true);
  if (!label.ok) return label;
  const description = validText(input?.description, "Description", 300);
  if (!description.ok) return description;
  const guidance = validText(input?.draftGuidance, "Draft guidance", 600);
  if (!guidance.ok) return guidance;
  if (!SENTIMENT_TYPES.has(input?.sentimentType)) {
    return { ok: false, message: "Invalid sentiment type." };
  }
  if (!validColor(input?.color)) return { ok: false, message: "Invalid category color." };
  if (
    typeof input?.suppress !== "boolean" ||
    typeof input?.dnc !== "boolean" ||
    typeof input?.draftReply !== "boolean"
  ) {
    return { ok: false, message: "Invalid category flags." };
  }

  const result = await createCategory({
    ...input,
    label: label.value!,
    description: description.value,
    draftGuidance: guidance.value,
    color: input.color ?? null,
  });
  if (result.ok) revalidateTaxonomyPaths();
  return result;
}

export async function updateCategoryAction(
  id: string,
  patch: UpdateCategoryPatch,
): Promise<ActionResult> {
  await requireActiveProfile();
  const clean: UpdateCategoryPatch = {};

  if (patch.label !== undefined) {
    const label = validText(patch.label, "Label", 60, true);
    if (!label.ok) return label;
    clean.label = label.value!;
  }
  if (patch.description !== undefined) {
    const description = validText(patch.description, "Description", 300);
    if (!description.ok) return description;
    clean.description = description.value;
  }
  if (patch.draftGuidance !== undefined) {
    const guidance = validText(patch.draftGuidance, "Draft guidance", 600);
    if (!guidance.ok) return guidance;
    clean.draftGuidance = guidance.value;
  }
  if (patch.sentimentType !== undefined) {
    if (!SENTIMENT_TYPES.has(patch.sentimentType)) {
      return { ok: false, message: "Invalid sentiment type." };
    }
    clean.sentimentType = patch.sentimentType;
  }
  if (patch.color !== undefined) {
    if (!validColor(patch.color)) return { ok: false, message: "Invalid category color." };
    clean.color = patch.color;
  }
  for (const key of ["suppress", "dnc", "draftReply", "active"] as const) {
    if (patch[key] !== undefined) {
      if (typeof patch[key] !== "boolean") return { ok: false, message: "Invalid category flags." };
      clean[key] = patch[key];
    }
  }
  if (patch.sortOrder !== undefined) {
    if (!Number.isInteger(patch.sortOrder) || patch.sortOrder < 0) {
      return { ok: false, message: "Invalid category order." };
    }
    clean.sortOrder = patch.sortOrder;
  }

  const result = await updateCategory(id, clean);
  if (result.ok) revalidateTaxonomyPaths();
  return result;
}

export async function deleteCategoryAction(id: string): Promise<ActionResult> {
  await requireActiveProfile();
  const result = await deleteCategory(id);
  if (result.ok) revalidateTaxonomyPaths();
  return result;
}

export async function reorderCategoriesAction(orderedIds: string[]): Promise<ActionResult> {
  await requireActiveProfile();
  if (!Array.isArray(orderedIds) || orderedIds.some((id) => typeof id !== "string")) {
    return { ok: false, message: "Invalid category order." };
  }
  const result = await reorderCategories(orderedIds);
  if (result.ok) revalidateTaxonomyPaths();
  return result;
}

const aiSettingsPatchSchema = z
  .object({
    campaignContext: z.string().max(4000).optional(),
    model: z.string().max(64).regex(/^[a-z0-9.:-]+$/).nullable().optional(),
    draftingEnabled: z.boolean().optional(),
    senderName: z.string().max(120).optional(),
    senderTitle: z.string().max(120).optional(),
    senderCompany: z.string().max(120).optional(),
    draftContext: z.string().max(4000).optional(),
    styleExamples: styleExamplesSchema.optional(),
    extraVoiceRules: z.string().max(1000).optional(),
    signature: z.string().max(1000).optional(),
    autoHandleOoo: z.boolean().optional(),
    resumeBusinessDaysAfterReturn: z.number().int().min(0).max(30).optional(),
    resumeDefaultWaitDays: z.number().int().min(1).max(60).optional(),
    colleagueResearchEnabled: z.boolean().optional(),
    colleagueRolesHint: z.string().max(300).optional(),
  })
  .strict();

export async function updateAiSettingsAction(patch: Partial<AiSettings>): Promise<ActionResult> {
  const profile = await requireActiveProfile();
  const parsed = aiSettingsPatchSchema.safeParse(patch);
  if (!parsed.success) return { ok: false, message: "Invalid AI and automation settings." };

  const result = await updateAiSettings(parsed.data, profile.email);
  if (result.ok) revalidatePath("/settings");
  return result;
}

const integrationSettingsPatchSchema = z
  .object({
    smartleadApiBaseUrl: z
      .string()
      .trim()
      .url()
      .max(500)
      // https only: the API key is sent to whatever host is configured here.
      .refine((value) => value.startsWith("https://"), { message: "Must be an https:// URL." })
      .nullable()
      .optional(),
    zapmailWorkspaceId: z.string().trim().max(100).optional(),
    zapmailServiceProvider: z.enum(["GOOGLE", "MICROSOFT"]).optional(),
    emailProvider: z.enum(["resend", "smtp"]).nullable().optional(),
    emailFrom: z.string().trim().min(1).max(500).nullable().optional(),
    smtpHost: z.string().trim().min(1).max(500).nullable().optional(),
    smtpPort: z.number().int().min(1).max(65535).nullable().optional(),
    smtpUser: z.string().trim().min(1).max(500).nullable().optional(),
    smtpSecure: z.boolean().nullable().optional(),
  })
  .strict();
const secretNames = new Set<SecretName>([
  "smartlead_api_key",
  "zapmail_api_key",
  "resend_api_key",
  "smtp_password",
  "enrichment_anthropic_api_key",
  "openai_api_key",
  "apify_api_key",
  "leadmagic_api_key",
  "zerobounce_api_key",
  "apollo_api_key",
  "firecrawl_api_key",
  "ai_gateway_api_key",
]);

function revalidateIntegrationPaths(includeNotifications = false) {
  revalidatePath("/settings");
  if (includeNotifications) revalidatePath("/notifications");
}

export async function updateIntegrationSettingsAction(
  patch: Partial<IntegrationSettings>,
): Promise<ActionResult> {
  const profile = await requireActiveProfile();
  const parsed = integrationSettingsPatchSchema.safeParse(patch);
  if (!parsed.success) return { ok: false, message: "Invalid integration settings." };
  const result = await updateIntegrationSettings(parsed.data, profile.email);
  if (result.ok) revalidateIntegrationPaths(true);
  return result;
}

export async function setIntegrationSecretAction(
  name: SecretName,
  value: string,
): Promise<ActionResult> {
  const profile = await requireActiveProfile();
  if (!secretNames.has(name)) return { ok: false, message: "Invalid integration secret." };
  if (typeof value !== "string") return { ok: false, message: "Secret value is invalid." };
  const trimmed = value.trim();
  if (!trimmed) return { ok: false, message: "Secret value is required." };
  if (trimmed.length > 500) return { ok: false, message: "Secret value must be 500 characters or fewer." };
  const result = await setSecret(name, trimmed, profile.email);
  if (result.ok) revalidateIntegrationPaths(name !== "smartlead_api_key");
  return result;
}

export async function clearIntegrationSecretAction(name: SecretName): Promise<ActionResult> {
  await requireActiveProfile();
  if (!secretNames.has(name)) return { ok: false, message: "Invalid integration secret." };
  const result = await clearSecret(name);
  if (result.ok) revalidateIntegrationPaths(name !== "smartlead_api_key");
  return result;
}

export async function testSmartleadConnectionAction(): Promise<ActionResult> {
  await requireActiveProfile();
  try {
    const campaigns = await listCampaigns();
    revalidateIntegrationPaths();
    return {
      ok: true,
      message: `Smartlead connection successful. Found ${campaigns.length} campaign${campaigns.length === 1 ? "" : "s"}.`,
    };
  } catch (error) {
    revalidateIntegrationPaths();
    return {
      ok: false,
      message: `Smartlead connection failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

export async function listSmartleadCampaignsAction(): Promise<
  ActionResult & { campaigns?: { id: string; name: string; status: string | null }[] }
> {
  await requireActiveProfile();
  try {
    const campaigns = await listCampaigns();
    revalidateIntegrationPaths();
    return { ok: true, message: `Found ${campaigns.length} Smartlead campaign${campaigns.length === 1 ? "" : "s"}.`, campaigns };
  } catch (error) {
    revalidateIntegrationPaths();
    return {
      ok: false,
      message: `Could not list Smartlead campaigns: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

export async function registerSmartleadWebhookAction(campaignId: string): Promise<ActionResult> {
  await requireActiveProfile();
  if (typeof campaignId !== "string" || !/^\d+$/.test(campaignId) || campaignId.length > 30) {
    return { ok: false, message: "Invalid Smartlead campaign ID." };
  }
  const result = await registerReplyWebhook(campaignId);
  revalidateIntegrationPaths();
  return result;
}

const workspaceSettingsPatchSchema = z
  .object({
    workspaceName: z.string().trim().min(1).max(60).optional(),
    tagline: z.string().trim().max(120).optional(),
    timeZone: z.string().trim().refine(isValidTimeZone).optional(),
    timeLocale: z.string().trim().refine(isValidTimeLocale).optional(),
  })
  .strict();

export async function updateWorkspaceSettingsAction(
  patch: Partial<WorkspaceSettings>,
): Promise<ActionResult> {
  const profile = await requireActiveProfile();
  const parsed = workspaceSettingsPatchSchema.safeParse(patch);
  if (!parsed.success) return { ok: false, message: "Invalid workspace settings." };

  const result = await updateWorkspaceSettings(parsed.data, profile.email);
  if (result.ok) {
    revalidatePath("/settings");
    revalidatePath("/login");
    revalidatePath("/", "layout");
  }
  return result;
}

const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .max(320)
  .refine((value) => {
    const parts = value.split("@");
    return (
      parts.length === 2 &&
      !!parts[0] &&
      parts[0].length <= 64 &&
      !!parts[1] &&
      parts[1].length <= 255 &&
      parts[1].includes(".") &&
      !/[\s,()<>;:\\"\[\]]/.test(value)
    );
  });
const fullNameSchema = z.string().trim().max(120).nullable();

export async function inviteMemberAction(
  email: string,
  fullName: string | null,
): Promise<ActionResult> {
  const profile = await requireActiveProfile();
  const parsedEmail = emailSchema.safeParse(email);
  const parsedName = fullNameSchema.safeParse(fullName);
  if (!parsedEmail.success) return { ok: false, message: "Enter a valid email address." };
  if (!parsedName.success) {
    return { ok: false, message: "Full name must be 120 characters or fewer." };
  }

  const result = await inviteMember(parsedEmail.data, parsedName.data || null, profile.email);
  if (result.ok) revalidatePath("/settings");
  return result;
}

export async function setMemberActiveAction(id: string, active: boolean): Promise<ActionResult> {
  const profile = await requireActiveProfile();
  if (!z.string().uuid().safeParse(id).success || typeof active !== "boolean") {
    return { ok: false, message: "Invalid team member update." };
  }

  const result = await setMemberActive(id, active, profile.id);
  if (result.ok) revalidatePath("/settings");
  return result;
}

export async function uploadWorkspaceLogoAction(formData: FormData): Promise<ActionResult> {
  const profile = await requireActiveProfile();

  const file = formData.get("logo");
  if (!(file instanceof File)) {
    return { ok: false, message: "Choose an image file." };
  }
  if (file.size === 0 || file.size > LOGO_MAX_BYTES) {
    return { ok: false, message: "Logo must be a non-empty image under 256 KB." };
  }
  if (!LOGO_MIME_TYPES.has(file.type)) {
    return { ok: false, message: "Use a PNG, JPEG, WebP, or SVG image." };
  }

  const bytes = Buffer.from(await file.arrayBuffer());
  const result = await setWorkspaceLogo(bytes, file.type, profile.email);
  // The logo renders in the app shell on every page.
  if (result.ok) revalidatePath("/", "layout");
  return result;
}

export async function removeWorkspaceLogoAction(): Promise<ActionResult> {
  await requireActiveProfile();
  const result = await clearWorkspaceLogo();
  if (result.ok) revalidatePath("/", "layout");
  return result;
}


/* ── Inbox provisioning defaults ──────────────────────────────────────────── */

export async function getInboxProvisioningAction(): Promise<
  ActionResult & { config?: { forwardingDomain: string } }
> {
  await requireActiveProfile();
  try {
    const { getInboxProvisioningConfig } = await import("@/lib/inbox-provisioning-config");
    return { ok: true, message: "Loaded.", config: await getInboxProvisioningConfig() };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : "Could not load inbox settings." };
  }
}

export async function saveInboxProvisioningAction(forwardingDomain: unknown): Promise<ActionResult> {
  const profile = await requireActiveProfile();
  const parsed = z.string().trim().max(300).safeParse(forwardingDomain);
  if (!parsed.success) return { ok: false, message: "Enter a forwarding domain or URL." };
  try {
    const { saveInboxProvisioningConfig } = await import("@/lib/inbox-provisioning-config");
    await saveInboxProvisioningConfig({ forwardingDomain: parsed.data }, profile.email);
    return { ok: true, message: "Inbox provisioning defaults saved." };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : "Could not save inbox settings." };
  }
}

/** Set the workspace forwarding domain on EVERY active Zapmail domain that is
 *  not already pointing at it. Explicit operator action, never automatic. */
export async function applyForwardingToAllDomainsAction(): Promise<ActionResult & { updated?: number }> {
  await requireActiveProfile();
  try {
    const { getInboxProvisioningConfig } = await import("@/lib/inbox-provisioning-config");
    const target = (await getInboxProvisioningConfig()).forwardingDomain.trim();
    if (!target) return { ok: false, message: "Set a forwarding domain first." };
    const { listOwnedDomains, setDomainForwarding } = await import("@/lib/zapmail");
    const normalize = (value: string) => value.replace(/^https?:\/\//, "").replace(/\/$/, "").toLowerCase();
    const owned = await listOwnedDomains();
    const ids = owned
      .filter((domain) => (domain.status ?? "").toUpperCase() === "ACTIVE")
      .filter((domain) => normalize(domain.forwardTo ?? "") !== normalize(target))
      .map((domain) => domain.id);
    if (ids.length === 0) return { ok: true, message: "All domains already forward there.", updated: 0 };
    await setDomainForwarding(ids, target);
    return { ok: true, message: `Forwarding set on ${ids.length} ${ids.length === 1 ? "domain" : "domains"}.`, updated: ids.length };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : "Could not apply forwarding." };
  }
}
