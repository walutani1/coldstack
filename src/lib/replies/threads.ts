import "server-only";
import { getCampaignSenderNames, getMessageHistory } from "@/lib/smartlead";
import { htmlToText } from "@/lib/html";
import type { ReplyEventRow, SendContext, ThreadMessage } from "@/lib/types";

/**
 * Build the full conversation thread for an event. Pulls the authoritative
 * history from Smartlead when possible; falls back to the stored reply body.
 * Also derives the context needed to send a reply into the same thread.
 */
export async function getThreadForEvent(
  event: Pick<ReplyEventRow, "campaign_id" | "smartlead_lead_id" | "from_email" | "to_email" | "subject" | "body" | "received_at" | "created_at">,
): Promise<{ messages: ThreadMessage[]; sendContext: SendContext }> {
  if (event.campaign_id && event.smartlead_lead_id) {
    try {
      // Sender display names are best-effort: the thread must still render if
      // the email-accounts endpoint fails.
      const [history, senderNames] = await Promise.all([
        getMessageHistory(event.campaign_id, event.smartlead_lead_id),
        getCampaignSenderNames(event.campaign_id).catch(() => ({}) as Record<string, string>),
      ]);
      if (history.length > 0) {
        const messages: ThreadMessage[] = history.map((m) => ({
          direction: m.type === "REPLY" ? "inbound" : "outbound",
          from: m.from,
          fromName: m.type === "REPLY" ? null : (senderNames[m.from.trim().toLowerCase()] ?? null),
          to: m.to,
          subject: m.subject,
          bodyText: htmlToText(m.email_body),
          time: m.time,
        }));

        const latestReply = [...history].reverse().find((m) => m.type === "REPLY");
        const sendContext: SendContext =
          latestReply && latestReply.stats_id && latestReply.message_id && latestReply.time
            ? {
                campaignId: event.campaign_id,
                emailStatsId: latestReply.stats_id,
                replyMessageId: latestReply.message_id,
                replyEmailTime: latestReply.time,
              }
            : null;

        return { messages, sendContext };
      }
    } catch {
      // fall through to the stored body
    }
  }

  const bodyText = htmlToText(event.body ?? "");
  return {
    messages: bodyText
      ? [
          {
            direction: "inbound",
            from: event.from_email ?? "",
            fromName: null,
            to: event.to_email ?? "",
            subject: event.subject ?? "",
            bodyText,
            time: event.received_at ?? event.created_at,
          },
        ]
      : [],
    sendContext: null,
  };
}
