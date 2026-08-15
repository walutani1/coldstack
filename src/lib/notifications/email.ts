import "server-only";
import { getEnv } from "@/lib/env";
import { getSecret } from "@/lib/secrets";
import { getIntegrationSettings } from "@/lib/settings-store";
import type { EmailTransportStatus } from "@/lib/types";

const SEND_TIMEOUT_MS = 10_000;
type ValueSource = "app" | "env";

type ResolvedEmailTransport = {
  status: EmailTransportStatus;
  resendApiKey: string | null;
  smtpHost: string | null;
  smtpPort: number;
  smtpUser: string | null;
  smtpPassword: string | null;
  smtpSecure: boolean;
};

function combinedSource(sources: ValueSource[]): "app" | "env" | "mixed" {
  const unique = new Set(sources);
  if (unique.size > 1) return "mixed";
  return unique.has("app") ? "app" : "env";
}

async function resolveEmailTransport(): Promise<ResolvedEmailTransport> {
  const [settings, appResendKey, appSmtpPassword] = await Promise.all([
    getIntegrationSettings(),
    getSecret("resend_api_key"),
    getSecret("smtp_password"),
  ]);
  const env = getEnv();
  const emailFrom = settings.emailFrom ?? env.NOTIFY_EMAIL_FROM ?? null;
  const smtpHost = settings.smtpHost ?? env.SMTP_HOST ?? null;
  const smtpPort = settings.smtpPort ?? env.SMTP_PORT;
  const smtpUser = settings.smtpUser ?? env.SMTP_USER ?? null;
  const smtpSecure = settings.smtpSecure ?? env.SMTP_SECURE;
  const resendApiKey = appResendKey || env.RESEND_API_KEY || null;
  const smtpPassword = appSmtpPassword || env.SMTP_PASS || null;
  const provider =
    settings.emailProvider ??
    env.EMAIL_PROVIDER ??
    (resendApiKey ? "resend" : smtpHost ? "smtp" : null);

  const sources: ValueSource[] = [];
  if (provider) {
    sources.push(
      settings.emailProvider
        ? "app"
        : env.EMAIL_PROVIDER
          ? "env"
          : provider === "resend" && appResendKey
            ? "app"
            : provider === "smtp" && settings.smtpHost
              ? "app"
              : "env",
    );
  }
  if (emailFrom) sources.push(settings.emailFrom ? "app" : "env");
  if (provider === "resend" && resendApiKey) sources.push(appResendKey ? "app" : "env");
  if (provider === "smtp") {
    if (smtpHost) sources.push(settings.smtpHost ? "app" : "env");
    sources.push(settings.smtpPort != null ? "app" : "env");
    sources.push(settings.smtpSecure != null ? "app" : "env");
    if (smtpUser) sources.push(settings.smtpUser ? "app" : "env");
    if (smtpPassword) sources.push(appSmtpPassword ? "app" : "env");
  }
  const source = combinedSource(sources);

  const base = { resendApiKey, smtpHost, smtpPort, smtpUser, smtpPassword, smtpSecure };
  if (!provider) {
    return {
      ...base,
      status: {
        configured: false,
        reason: "No email transport configured. Set RESEND_API_KEY or SMTP_HOST (see .env.example).",
        source,
      },
    };
  }
  if (provider === "resend" && !resendApiKey) {
    return {
      ...base,
      status: {
        configured: false,
        reason: source === "env" ? "EMAIL_PROVIDER=resend requires RESEND_API_KEY." : "The Resend provider requires an API key.",
        source,
      },
    };
  }
  if (provider === "smtp" && !smtpHost) {
    return {
      ...base,
      status: {
        configured: false,
        reason: source === "env" ? "EMAIL_PROVIDER=smtp requires SMTP_HOST." : "The SMTP provider requires a host.",
        source,
      },
    };
  }
  if (!emailFrom) {
    return {
      ...base,
      status: {
        configured: false,
        reason:
          source === "env"
            ? 'Set NOTIFY_EMAIL_FROM to the sender address (e.g. "Coldstack <inbox@example.com>").'
            : 'Set the notification From address (e.g. "Coldstack <inbox@example.com>").',
        source,
      },
    };
  }
  return { ...base, status: { configured: true, provider, from: emailFrom, source } };
}

/** Resolve app settings and encrypted credentials first, then fall back per field to env. */
export async function getEmailTransportStatus(): Promise<EmailTransportStatus> {
  return (await resolveEmailTransport()).status;
}

export async function sendNotificationEmail(input: {
  to: string;
  subject: string;
  text: string;
  html: string;
}): Promise<{ ok: boolean; error?: string }> {
  const transport = await resolveEmailTransport();
  const { status } = transport;
  if (!status.configured) return { ok: false, error: status.reason };

  try {
    if (status.provider === "resend") {
      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${transport.resendApiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          from: status.from,
          to: [input.to],
          subject: input.subject,
          text: input.text,
          html: input.html,
        }),
        signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        return { ok: false, error: `Resend ${res.status}: ${body.slice(0, 300)}` };
      }
      return { ok: true };
    }

    const { default: nodemailer } = await import("nodemailer");
    const transporter = nodemailer.createTransport({
      host: transport.smtpHost!,
      port: transport.smtpPort,
      secure: transport.smtpSecure,
      auth: transport.smtpUser
        ? { user: transport.smtpUser, pass: transport.smtpPassword ?? "" }
        : undefined,
      connectionTimeout: SEND_TIMEOUT_MS,
      greetingTimeout: SEND_TIMEOUT_MS,
      socketTimeout: SEND_TIMEOUT_MS,
    });
    await transporter.sendMail({
      from: status.from,
      to: input.to,
      subject: input.subject,
      text: input.text,
      html: input.html,
    });
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
