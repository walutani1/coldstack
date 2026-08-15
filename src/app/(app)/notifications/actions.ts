"use server";

import { revalidatePath } from "next/cache";
import { requireActiveProfile } from "@/lib/auth";
import { getAdminClient } from "@/lib/supabase/admin";
import { getTaxonomy } from "@/lib/taxonomy-store";
import { normalizeWebhookUrl } from "@/lib/notifications/slack";
import { buildTestNotification, sendToChannel } from "@/lib/notifications/notify";
import type { ActionResult, NotificationChannel } from "@/lib/types";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const CHANNEL_COLUMNS = "id, channel_type, label, target, categories, campaign_ids, enabled, created_at";
const MAX_CHANNELS = 20;

function validUuid(value: unknown): string | null {
  return typeof value === "string" && UUID_PATTERN.test(value) ? value : null;
}

export async function createNotificationChannelAction(input: {
  channelType: string;
  target: string;
  label: string;
  /** Selected category values; null = all replies. */
  categories: string[] | null;
  /** Selected Smartlead campaign ids; null = all campaigns. */
  campaignIds: string[] | null;
}): Promise<ActionResult> {
  const profile = await requireActiveProfile();
  const taxonomy = await getTaxonomy();
  const categoryValues = new Set(taxonomy.all.map((category) => category.value));

  const channelType =
    input.channelType === "email" || input.channelType === "slack" ? input.channelType : null;
  if (!channelType) {
    return { ok: false, message: "Invalid channel type." };
  }

  let target = typeof input.target === "string" ? input.target.trim() : "";
  if (!target || target.length > 2000) {
    return { ok: false, message: "Enter a destination for the channel." };
  }
  if (channelType === "email") {
    if (!EMAIL_PATTERN.test(target) || target.length > 320) {
      return { ok: false, message: "Enter a valid email address." };
    }
    target = target.toLowerCase();
  } else {
    const normalized = normalizeWebhookUrl(target);
    if (!normalized) {
      return { ok: false, message: "Enter a valid https:// incoming-webhook URL." };
    }
    target = normalized;
  }

  const label = typeof input.label === "string" ? input.label.trim().slice(0, 80) : "";

  let categories: string[] | null = null;
  if (Array.isArray(input.categories)) {
    const picked = [...new Set(input.categories)].filter(
      (value): value is string => typeof value === "string" && categoryValues.has(value),
    );
    if (picked.length === 0) {
      return { ok: false, message: "Pick at least one category, or switch to all replies." };
    }
    // Selecting every ACTIVE category (all the UI offers) means "all" — store
    // null so categories added later are included automatically.
    const activeValues = new Set(taxonomy.active.map((category) => category.value));
    const coversAllActive =
      picked.length >= activeValues.size && [...activeValues].every((value) => picked.includes(value));
    categories = coversAllActive ? null : picked;
  }

  let campaignIds: string[] | null = null;
  if (input.campaignIds !== null) {
    if (!Array.isArray(input.campaignIds)) {
      return { ok: false, message: "Invalid campaign selection." };
    }
    const picked = [...new Set(input.campaignIds)];
    if (
      picked.length === 0 ||
      picked.length > 50 ||
      picked.some((value) => typeof value !== "string" || value.length > 32 || !/^\d+$/.test(value))
    ) {
      return { ok: false, message: "Select 1 to 50 valid campaigns, or switch to all campaigns." };
    }
    campaignIds = picked;
  }

  const admin = getAdminClient();
  const { count } = await admin
    .from("notification_channels")
    .select("id", { count: "exact", head: true });
  if ((count ?? 0) >= MAX_CHANNELS) {
    return { ok: false, message: `Channel limit reached (${MAX_CHANNELS}). Remove one first.` };
  }

  const { error } = await admin.from("notification_channels").insert({
    channel_type: channelType,
    target,
    label: label || null,
    categories,
    campaign_ids: campaignIds,
    created_by: profile.email,
  });
  if (error) {
    return { ok: false, message: error.message };
  }
  revalidatePath("/notifications");
  return { ok: true, message: "Channel added." };
}

export async function setChannelEnabledAction(id: string, enabled: boolean): Promise<ActionResult> {
  await requireActiveProfile();
  const channelId = validUuid(id);
  if (!channelId) {
    return { ok: false, message: "Invalid channel id." };
  }

  const { error } = await getAdminClient()
    .from("notification_channels")
    .update({ enabled: Boolean(enabled), updated_at: new Date().toISOString() })
    .eq("id", channelId);
  if (error) {
    return { ok: false, message: error.message };
  }
  revalidatePath("/notifications");
  return { ok: true, message: enabled ? "Channel enabled." : "Channel paused." };
}

export async function deleteChannelAction(id: string): Promise<ActionResult> {
  await requireActiveProfile();
  const channelId = validUuid(id);
  if (!channelId) {
    return { ok: false, message: "Invalid channel id." };
  }

  const { error } = await getAdminClient().from("notification_channels").delete().eq("id", channelId);
  if (error) {
    return { ok: false, message: error.message };
  }
  revalidatePath("/notifications");
  return { ok: true, message: "Channel removed." };
}

/** Push a sample notification through the channel so misconfig shows up now. */
export async function sendTestNotificationAction(id: string): Promise<ActionResult> {
  await requireActiveProfile();
  const channelId = validUuid(id);
  if (!channelId) {
    return { ok: false, message: "Invalid channel id." };
  }

  const { data } = await getAdminClient()
    .from("notification_channels")
    .select(CHANNEL_COLUMNS)
    .eq("id", channelId)
    .maybeSingle();
  if (!data) {
    return { ok: false, message: "Channel not found." };
  }

  // A test bypasses the durable outbox (no proposal): send straight over the
  // channel's transport and record a one-off audit row.
  const channel = data as NotificationChannel;
  const result = await sendToChannel(
    { channel_type: channel.channel_type, target: channel.target },
    await buildTestNotification(),
  );
  try {
    await getAdminClient().from("notification_deliveries").insert({
      channel_id: channel.id, proposal_id: null, kind: "test",
      status: result.ok ? "sent" : "dead", error: result.ok ? null : (result.error ?? "unknown").slice(0, 1000),
      sent_at: result.ok ? new Date().toISOString() : null,
    });
  } catch { /* audit only */ }
  revalidatePath("/notifications");
  return result.ok
    ? { ok: true, message: "Test notification sent." }
    : { ok: false, message: result.error ?? "Send failed." };
}
