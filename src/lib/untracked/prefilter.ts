import "server-only";

import { getAdminClient } from "@/lib/supabase/admin";
import { findWarmupTag } from "@/lib/warmup-tags";

export type PrefilterReply = {
  provider_message_id: string | null;
  from_email: string | null;
  from_name: string | null;
  subject: string | null;
  body_text: string | null;
  to_email?: string | null;
};

export type PrefilterDecision = {
  status: "duplicate" | "automated" | "error";
  classificationRule: string;
  automationKind?: "self_mail" | "internal_loop" | "delivery" | "bounce" | "ooo" | "system" | "warmup";
  lastError?: string;
};

const DELIVERY = /^(?:mailer-daemon|postmaster)(?:@|$)/i;
const BOUNCE = /delivery status notification|undeliverable|mail delivery failed|delivery has failed|quota exceeded|address rejected|recipient address rejected|user unknown|mailbox unavailable|returned mail/i;
const OOO = /^(?:re:\s*)?(?:automatic reply|auto(?:matic)?[- ]?reply|out of (?:the )?office)\b/i;
const ACK = /(?:we (?:have )?received|your (?:request|ticket|message)|thank you for contacting|case (?:has been )?created|do not reply)/i;
// DMARC/TLS-RPT aggregate reports: mailbox providers mail these to the rua/ruf
// addresses in our DNS records; they dominate the live untracked feed and must
// never reach the LLM queue.
const REPORT_SENDER = /(?:^|[-_.])dmarc(?:[-_.]|report|@)|^tlsrpt(?:@|[-_.])/i;
const REPORT_SUBJECT = /^(?:\[preview\]\s*)?(?:dmarc aggregate report|report domain:|tls report)/i;

export async function runDeterministicPrefilter(
  reply: PrefilterReply,
  sendingAliases: ReadonlySet<string>,
  warmupTags: ReadonlySet<string>,
): Promise<PrefilterDecision | null> {
  if (reply.provider_message_id) {
    const { data, error } = await getAdminClient().from("reply_events").select("id")
      .eq("smartlead_message_id", reply.provider_message_id).limit(1).maybeSingle();
    if (error) throw new Error(`Duplicate prefilter: ${error.message}`);
    if (data) return { status: "duplicate", classificationRule: "duplicate_tracked_message_id" };
  }
  const from = reply.from_email?.trim().toLowerCase() ?? "";
  const to = reply.to_email?.trim().toLowerCase() ?? "";
  if (from && sendingAliases.has(from)) {
    return { status: "automated", classificationRule: "sending_alias_sender", automationKind: to && sendingAliases.has(to) ? "internal_loop" : "self_mail" };
  }
  if (DELIVERY.test(from) || /MAILER-DAEMON/i.test(reply.from_name ?? "")) {
    return { status: "automated", classificationRule: "delivery_system_sender", automationKind: "delivery" };
  }
  if (REPORT_SENDER.test(from.split("@")[0] ?? "") || REPORT_SUBJECT.test(reply.subject?.trim() ?? "")) {
    return { status: "automated", classificationRule: "dmarc_report", automationKind: "system" };
  }
  const content = `${reply.subject ?? ""}\n${reply.body_text ?? ""}`;
  // Warmup-network mail carries the identifier tag Smartlead stamps on it
  // ("spice-grape"); senders are external, so the alias rule never catches it.
  if (findWarmupTag(content, warmupTags)) {
    return { status: "automated", classificationRule: "warmup_tag", automationKind: "warmup" };
  }
  if (BOUNCE.test(content)) return { status: "automated", classificationRule: "dsn_bounce_signature", automationKind: "bounce" };
  if (OOO.test(reply.subject ?? "")) return { status: "automated", classificationRule: "autoresponder_subject", automationKind: "ooo" };
  if (/^(?:no[-_.]?reply|donotreply)(?:@|$)/i.test(from) && ACK.test(reply.body_text ?? "")) {
    return { status: "automated", classificationRule: "noreply_acknowledgement", automationKind: "system" };
  }
  if (!reply.subject?.trim() && !reply.body_text?.trim()) {
    return { status: "error", classificationRule: "empty_payload", lastError: "empty payload" };
  }
  return null;
}
