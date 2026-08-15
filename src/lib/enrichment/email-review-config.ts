import "server-only";
import { z } from "zod";
import { getAdminClient } from "@/lib/supabase/admin";

/* Email-review policy, kept separate from the runner config (provider/concurrency
   are execution infra; review policy has its own lifecycle and will grow attempt
   / chat limits). Manual is the default whenever the row is absent or malformed:
   the reviewer proposes fixes and a human resolves them before export. Auto keeps
   the old behavior where the reviewer applies its own repairs. */

const SETTINGS_KEY = "email_review";

export const emailReviewConfigSchema = z.object({
  mode: z.enum(["manual", "auto"]).default("manual"),
}).strip();

export type EmailReviewConfig = z.infer<typeof emailReviewConfigSchema>;
export const DEFAULT_EMAIL_REVIEW_CONFIG: EmailReviewConfig = emailReviewConfigSchema.parse({});

export function parseEmailReviewConfig(value: unknown): EmailReviewConfig {
  const document = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  try { return emailReviewConfigSchema.parse(document); } catch { return DEFAULT_EMAIL_REVIEW_CONFIG; }
}

export async function getEmailReviewConfig(): Promise<EmailReviewConfig> {
  const { data, error } = await getAdminClient().from("app_settings").select("value").eq("key", SETTINGS_KEY).maybeSingle();
  if (error || !data) return DEFAULT_EMAIL_REVIEW_CONFIG;
  return parseEmailReviewConfig(data.value);
}

export async function saveEmailReviewConfig(value: unknown, updatedBy: string): Promise<EmailReviewConfig> {
  const parsed = parseEmailReviewConfig(value);
  const { error } = await getAdminClient().from("app_settings").upsert({
    key: SETTINGS_KEY, value: parsed, updated_at: new Date().toISOString(), updated_by: updatedBy,
  }, { onConflict: "key" });
  if (error) throw new Error(error.message);
  return parsed;
}
