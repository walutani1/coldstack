import "server-only";
import { z } from "zod";

const schema = z.object({
  NEXT_PUBLIC_SUPABASE_URL: z.string().url(),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().min(1),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
  ANTHROPIC_API_KEY: z.string().min(1),
  ANTHROPIC_MODEL: z.string().default("claude-haiku-4-5"),
  SMARTLEAD_API_KEY: z.string().min(1).optional(),
  LEADMAGIC_API_KEY: z.string().min(1).optional(),
  ZEROBOUNCE_API_KEY: z.string().min(1).optional(),
  // Signals: contact emails (Apollo) and company research (Firecrawl). Both
  // are also settable in Settings → Integrations, which takes precedence.
  APOLLO_API_KEY: z.string().min(1).optional(),
  FIRECRAWL_API_KEY: z.string().min(1).optional(),
  // Vercel AI Gateway: one key for every vendor, OpenAI chat-completions wire
  // format, no token markup. Settings -> Integrations takes precedence.
  AI_GATEWAY_API_KEY: z.string().min(1).optional(),
  AI_GATEWAY_BASE_URL: z.string().url().optional(),
  ZEROBOUNCE_API_BASE_URL: z.string().url().default("https://api.zerobounce.net/v2"),
  SMARTLEAD_API_BASE_URL: z.string().url().default("https://server.smartlead.ai/api/v1"),
  SMARTLEAD_WEBHOOK_SECRET: z.string().min(16),
  CRON_SECRET: z.string().min(16),
  APP_BASE_URL: z.string().url().default("http://localhost:3000"),
  APP_ENCRYPTION_KEY: z.string().min(32).optional(),
  // Notification email transport — everything optional; notifications are
  // simply unavailable (and the Notifications tab says why) until configured.
  // Provider is auto-detected from which credentials exist, or forced here.
  EMAIL_PROVIDER: z.enum(["resend", "smtp"]).optional(),
  NOTIFY_EMAIL_FROM: z.string().min(3).optional(),
  RESEND_API_KEY: z.string().min(1).optional(),
  SMTP_HOST: z.string().min(1).optional(),
  SMTP_PORT: z.coerce.number().int().positive().default(587),
  SMTP_USER: z.string().min(1).optional(),
  SMTP_PASS: z.string().min(1).optional(),
  SMTP_SECURE: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),
});

let cached: z.infer<typeof schema> | null = null;

export function getEnv() {
  if (!cached) {
    cached = schema.parse(process.env);
  }
  return cached;
}
