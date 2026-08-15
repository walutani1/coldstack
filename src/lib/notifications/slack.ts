import "server-only";

const SEND_TIMEOUT_MS = 10_000;

/**
 * Normalize a Slack-style incoming-webhook URL, or null if unusable. Accepts
 * any https endpoint speaking the Slack payload shape (Slack, Mattermost,
 * Rocket.Chat, Discord's /slack suffix, ...); https is mandatory so a webhook
 * secret never travels in plaintext.
 */
export function normalizeWebhookUrl(raw: string): string | null {
  try {
    const url = new URL(raw.trim());
    if (url.protocol !== "https:") return null;
    return url.toString();
  } catch {
    return null;
  }
}

// Slack's mrkdwn requires these three escaped in message text.
export function escapeSlackText(text: string) {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export type SlackMessage = {
  /** Fallback line for clients that don't render blocks. */
  text: string;
  blocks?: unknown[];
};

export async function sendSlackMessage(
  webhookUrl: string,
  message: SlackMessage,
): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(message),
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return { ok: false, error: `Webhook ${res.status}: ${body.slice(0, 300)}` };
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
