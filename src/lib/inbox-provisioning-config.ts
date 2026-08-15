import "server-only";

import { z } from "zod";
import { getAdminClient } from "@/lib/supabase/admin";

/* Workspace-wide inbox provisioning defaults. The forwarding domain is where
   every sending domain's website redirect points (set once here instead of per
   batch); the provisioning watcher applies it automatically when a batch's
   domains finish activating, and the review card prefills with it. */

const SETTINGS_KEY = "inbox_provisioning";

export const inboxProvisioningConfigSchema = z.object({
  forwardingDomain: z.string().trim().max(300).default(""),
}).strip();

export type InboxProvisioningConfig = z.infer<typeof inboxProvisioningConfigSchema>;
export const DEFAULT_INBOX_PROVISIONING_CONFIG: InboxProvisioningConfig = inboxProvisioningConfigSchema.parse({});

export async function getInboxProvisioningConfig(): Promise<InboxProvisioningConfig> {
  const { data, error } = await getAdminClient().from("app_settings").select("value").eq("key", SETTINGS_KEY).maybeSingle();
  if (error || !data) return DEFAULT_INBOX_PROVISIONING_CONFIG;
  try { return inboxProvisioningConfigSchema.parse(data.value); } catch { return DEFAULT_INBOX_PROVISIONING_CONFIG; }
}

export async function saveInboxProvisioningConfig(value: unknown, updatedBy: string): Promise<InboxProvisioningConfig> {
  const parsed = inboxProvisioningConfigSchema.parse(value);
  const { error } = await getAdminClient().from("app_settings").upsert({
    key: SETTINGS_KEY, value: parsed, updated_at: new Date().toISOString(), updated_by: updatedBy,
  }, { onConflict: "key" });
  if (error) throw new Error(error.message);
  return parsed;
}
