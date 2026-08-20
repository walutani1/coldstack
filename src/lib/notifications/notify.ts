import "server-only";
import { getEnv } from "@/lib/env";
import { getAdminClient } from "@/lib/supabase/admin";
import { escapeHtml } from "@/lib/html";
import type { ReplyCategory } from "@/lib/taxonomy";
import { getTaxonomy } from "@/lib/taxonomy-store";
import type { NotificationChannel } from "@/lib/types";
import { sendNotificationEmail } from "@/lib/notifications/email";
import { escapeSlackText, sendSlackMessage, type SlackMessage } from "@/lib/notifications/slack";
import { splitQuotedText } from "@/lib/replies/quotes";

export type ReplyNotification = {
  proposalId: string | null;
  campaignId: string | null;
  category: ReplyCategory;
  leadName: string;
  leadEmail: string | null;
  company: string;
  campaignName: string | null;
  summary: string | null;
  nextStep: string | null;
  /** Plain text of the reply itself (may still contain quoted history —
      stripped at render time). Optional: older queued payloads lack it. */
  replyText?: string | null;
  /** True when the pipeline already applied the proposal (pure out-of-office). */
  autoApplied: boolean;
  /**
   * True when this reply arrived from a lead that was ALREADY marked a positive
   * lead before it — i.e. a follow-up on an established positive. Surfaces a
   * "follow-up with positive lead" tag AND bypasses the channel category filter
   * (a follow-up may re-classify as neutral, but we still want the heads-up so we
   * can follow up quickly).
   */
  followUpOnPositive: boolean;
};

const CHANNEL_COLUMNS = "id, channel_type, label, target, categories, campaign_ids, enabled, created_at";

/** null / empty categories = "all replies". */
export function channelMatchesCategory(channel: NotificationChannel, categoryValue: string) {
  return !channel.categories || channel.categories.length === 0 || channel.categories.includes(categoryValue);
}

export function channelMatchesNotification(
  channel: NotificationChannel,
  categoryValue: string,
  campaignId: string | null,
  options: { bypassCategory?: boolean } = {},
): boolean {
  // Empty campaign_ids matches everything, like categories — the create
  // action never stores [], but a DB-level [] must not silently mute a
  // channel.
  const campaignScope = channel.campaign_ids;
  const campaignMatches =
    !campaignScope ||
    campaignScope.length === 0 ||
    (campaignId !== null && campaignScope.includes(campaignId));
  // A follow-up from an already-positive lead always pings (subject to campaign
  // scope): the operator wants to react fast even if the reply itself reads
  // neutral and would otherwise miss the channel's category filter.
  const categoryMatches = options.bypassCategory || channelMatchesCategory(channel, categoryValue);
  return categoryMatches && campaignMatches;
}

function inboxUrl() {
  return `${getEnv().APP_BASE_URL.replace(/\/+$/, "")}/inbox`;
}

function leadLine(n: ReplyNotification) {
  const name = n.leadName || n.leadEmail || "Unknown lead";
  return n.company ? `${name} (${n.company})` : name;
}

const FOLLOW_UP_TAG = "Follow-up with positive lead";

export function formatEmailNotification(n: ReplyNotification) {
  const subject = `${n.followUpOnPositive ? `[${FOLLOW_UP_TAG}] ` : ""}${n.category.label}: ${leadLine(n)}`;
  const url = inboxUrl();

  const textLines = [
    ...(n.followUpOnPositive ? [`🔁 ${FOLLOW_UP_TAG}`] : []),
    `${leadLine(n)} replied: ${n.category.label}${n.autoApplied ? " (handled automatically)" : ""}`,
    n.leadEmail ? `From: ${n.leadEmail}` : "",
    n.campaignName ? `Campaign: ${n.campaignName}` : "",
    "",
    n.summary ?? "",
    n.nextStep ? `Next step: ${n.nextStep}` : "",
    "",
    `Review: ${url}`,
  ].filter((line, index, lines) => line !== "" || lines[index - 1] !== "");

  const tone =
    n.category.sentimentType === "positive" ? "#15803d" : n.category.sentimentType === "negative" ? "#b91c1c" : "#525252";
  const metaRow = (label: string, value: string) =>
    `<tr><td style="padding:2px 12px 2px 0;color:#737373;white-space:nowrap;">${label}</td><td style="padding:2px 0;color:#171717;">${escapeHtml(value)}</td></tr>`;

  const html = `
<div style="font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;max-width:560px;margin:0 auto;padding:24px 16px;color:#171717;">
  ${n.followUpOnPositive ? `<p style="margin:0 0 10px;display:inline-block;background:#dcfce7;color:#15803d;font-size:12px;font-weight:600;padding:4px 10px;border-radius:999px;">🔁 ${FOLLOW_UP_TAG}</p>` : ""}
  <p style="margin:0 0 4px;font-size:12px;letter-spacing:0.04em;text-transform:uppercase;color:${tone};font-weight:600;">
    ${escapeHtml(n.category.label)}${n.autoApplied ? " &middot; handled automatically" : ""}
  </p>
  <h2 style="margin:0 0 12px;font-size:18px;line-height:1.3;">${escapeHtml(leadLine(n))} replied</h2>
  ${n.summary ? `<p style="margin:0 0 12px;font-size:14px;line-height:1.5;">${escapeHtml(n.summary)}</p>` : ""}
  ${n.nextStep ? `<p style="margin:0 0 16px;font-size:13px;line-height:1.5;color:#525252;"><strong>Next step:</strong> ${escapeHtml(n.nextStep)}</p>` : ""}
  <table style="border-collapse:collapse;font-size:12.5px;margin:0 0 20px;">
    ${n.leadEmail ? metaRow("From", n.leadEmail) : ""}
    ${n.campaignName ? metaRow("Campaign", n.campaignName) : ""}
  </table>
  <a href="${escapeHtml(inboxUrl())}" style="display:inline-block;background:#171717;color:#fafafa;text-decoration:none;font-size:13px;font-weight:600;padding:8px 16px;border-radius:6px;">Open inbox</a>
</div>`.trim();

  return { subject, text: textLines.join("\n").trim(), html };
}

const REPLY_QUOTE_CAP = 1200;

/** The lead's own words — quoted history stripped, capped, mrkdwn-quoted.
    Null when nothing remains (e.g. a reply that was pure quoted thread). */
function slackReplyQuote(replyText: string): string | null {
  const visible = splitQuotedText(replyText).visible.trim();
  if (!visible) return null;
  const clipped = visible.length > REPLY_QUOTE_CAP ? `${visible.slice(0, REPLY_QUOTE_CAP).trimEnd()}…` : visible;
  const quoted = escapeSlackText(clipped)
    .split("\n")
    .map((line) => (line ? `> ${line}` : ">"))
    .join("\n");
  // Slack hard-caps a section's text at 3000 chars; escaping can expand it.
  return quoted.length > 2900 ? `${quoted.slice(0, 2900)}…` : quoted;
}

export function formatSlackNotification(n: ReplyNotification): SlackMessage {
  const emoji =
    n.category.sentimentType === "positive" ? "🟢" : n.category.sentimentType === "negative" ? "🔴" : "⚪";
  const headline = `${emoji} *${escapeSlackText(n.category.label)}*: ${escapeSlackText(leadLine(n))}${n.autoApplied ? " _(handled automatically)_" : ""}`;

  const replyQuote = n.replyText ? slackReplyQuote(n.replyText) : null;

  const detailLines = [
    n.summary ? escapeSlackText(n.summary) : "",
    n.nextStep ? `*Next step:* ${escapeSlackText(n.nextStep)}` : "",
  ].filter(Boolean);

  const contextBits = [
    n.leadEmail ? escapeSlackText(n.leadEmail) : "",
    n.campaignName ? escapeSlackText(n.campaignName) : "",
  ].filter(Boolean);

  const blocks: unknown[] = [
    ...(n.followUpOnPositive
      ? [{ type: "context", elements: [{ type: "mrkdwn", text: `🔁 *${FOLLOW_UP_TAG}*` }] }]
      : []),
    { type: "section", text: { type: "mrkdwn", text: headline } },
    ...(replyQuote
      ? [{ type: "section", text: { type: "mrkdwn", text: `*They wrote:*\n${replyQuote}` } }]
      : []),
    ...(detailLines.length
      ? [{ type: "section", text: { type: "mrkdwn", text: detailLines.join("\n") } }]
      : []),
    ...(contextBits.length
      ? [{ type: "context", elements: [{ type: "mrkdwn", text: contextBits.join("  ·  ") }] }]
      : []),
    {
      type: "actions",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "Open inbox" },
          url: inboxUrl(),
        },
      ],
    },
  ];

  return { text: `${n.followUpOnPositive ? `${FOLLOW_UP_TAG} — ` : ""}${n.category.label}: ${leadLine(n)}`, blocks };
}

// Immutable snapshot stored on each delivery job: what to send and how, so a
// retry never refetches Smartlead/thread state or a since-edited channel.
type DeliveryPayload = {
  notification: ReplyNotification;
  channel: { channel_type: string; target: string; label: string | null };
};

/** Send one notification over a channel's transport. No DB writes: the outbox
 *  row IS the record. Never throws. */
export async function sendToChannel(
  transport: { channel_type: string; target: string },
  notification: ReplyNotification,
): Promise<{ ok: boolean; error?: string }> {
  try {
    if (transport.channel_type === "email") {
      const { subject, text, html } = formatEmailNotification(notification);
      return await sendNotificationEmail({ to: transport.target, subject, text, html });
    }
    return await sendSlackMessage(transport.target, formatSlackNotification(notification));
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Enqueue a durable delivery job for every enabled channel whose filter matches
 * a freshly classified reply. Idempotent per (proposal, channel): a re-enqueue
 * (e.g. the reprocessing recovery path) is a no-op via the unique index, so a
 * reply can never be notified twice. Best-effort and never throws - the drainer
 * (eager + cron) does the actual sending.
 */
export async function enqueueReplyNotifications(notification: ReplyNotification): Promise<void> {
  try {
    if (!notification.proposalId) return; // outbox is keyed on the proposal
    const admin = getAdminClient();
    const { data } = await admin.from("notification_channels").select(CHANNEL_COLUMNS).eq("enabled", true);
    const channels = ((data ?? []) as NotificationChannel[]).filter((channel) =>
      channelMatchesNotification(channel, notification.category.value, notification.campaignId, {
        bypassCategory: notification.followUpOnPositive,
      }),
    );
    if (channels.length === 0) return;
    const now = new Date().toISOString();
    for (const channel of channels) {
      const payload: DeliveryPayload = {
        notification,
        channel: { channel_type: channel.channel_type, target: channel.target, label: channel.label },
      };
      const { error } = await admin.from("notification_deliveries").insert({
        channel_id: channel.id,
        proposal_id: notification.proposalId,
        kind: "reply",
        status: "pending",
        payload,
        next_attempt_at: now,
      });
      // 23505 = already enqueued for this (proposal, channel): the whole point of
      // the unique index. Any other error is swallowed; cron re-drains.
      if (error && error.code !== "23505") { /* best-effort */ }
    }
  } catch {
    // best-effort by contract
  }
}

type ClaimedDelivery = {
  id: string;
  channel_id: string;
  proposal_id: string | null;
  kind: string;
  payload: DeliveryPayload | null;
  attempt_count: number;
  claim_token: string;
};

const MAX_DELIVERY_ATTEMPTS = 6;

function backoffAt(attempt: number): string {
  // exp backoff (base 15s), capped at 10 min, with jitter.
  const base = Math.min(15_000 * 2 ** Math.max(0, attempt - 1), 600_000);
  const jitter = Math.round(base * 0.3 * Math.random());
  return new Date(Date.now() + base + jitter).toISOString();
}

/**
 * Claim and send due delivery jobs. Called eagerly right after enqueue and at the
 * start of cron, so a serverless cutoff between enqueue and send only delays a
 * notification to the next drain - it can never be lost. Claim-before-send (via
 * the RPC) means two concurrent drains never double-post the same job.
 */
export async function drainNotificationDeliveries(limit = 25): Promise<{ claimed: number; sent: number }> {
  const admin = getAdminClient();
  let sent = 0;
  let claimed: ClaimedDelivery[] = [];
  try {
    const res = await admin.rpc("notification_claim_deliveries", { p_limit: limit });
    claimed = ((res.data as ClaimedDelivery[] | null) ?? []);
  } catch {
    return { claimed: 0, sent: 0 };
  }
  const complete = (id: string, token: string, status: "sent" | "retry" | "dead", error: string | null, nextAt?: string) =>
    admin.rpc("notification_complete_delivery", {
      p_id: id, p_claim_token: token, p_status: status, p_error: error, p_next_attempt_at: nextAt ?? null,
    });

  await Promise.allSettled(claimed.map(async (job) => {
    if (!job.payload) { await complete(job.id, job.claim_token, "dead", "missing payload"); return; }
    const result = await sendToChannel(job.payload.channel, job.payload.notification);
    if (result.ok) { await complete(job.id, job.claim_token, "sent", null); sent += 1; return; }
    if (job.attempt_count >= MAX_DELIVERY_ATTEMPTS) { await complete(job.id, job.claim_token, "dead", result.error ?? "unknown"); return; }
    await complete(job.id, job.claim_token, "retry", result.error ?? "unknown", backoffAt(job.attempt_count));
  }));
  return { claimed: claimed.length, sent };
}

/**
 * Enqueue + immediately drain, so a matching reply is notified within seconds on
 * the happy path while staying durable if this invocation is cut off. Replaces
 * the old fire-and-forget notifyReplyCategorized.
 */
export async function notifyReplyCategorized(notification: ReplyNotification): Promise<void> {
  await enqueueReplyNotifications(notification);
  await drainNotificationDeliveries();
}

/** Sample payload for the Notifications tab "Send test" button. */
export async function buildTestNotification(): Promise<ReplyNotification> {
  const taxonomy = await getTaxonomy();
  return {
    proposalId: null,
    campaignId: null,
    category: taxonomy.byValue("interested") ?? taxonomy.fallback,
    leadName: "Test Lead",
    leadEmail: "lead@example.com",
    company: "Example Co",
    campaignName: "Test notification",
    summary: "This is a test notification from your inbox. The channel is wired up correctly.",
    nextStep: "Nothing to do. Real replies will look like this.",
    replyText: "Thanks for reaching out — this caught my eye. Could you send over a bit more detail on pricing?\n\nBest,\nTest",
    autoApplied: false,
    followUpOnPositive: false,
  };
}
