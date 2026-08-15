import "server-only";
import { getAdminClient } from "@/lib/supabase/admin";
import { resolveLeadByEmail } from "@/lib/smartlead";
import { markCampaignBriefDirty } from "@/lib/campaign-insights";

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

/**
 * Store one inbound Smartlead reply as a reply_events row (status 'received').
 * Deduped by message id; resolves our lead_id (by email) and the Smartlead
 * lead id. Returns the event id, or null if it was a duplicate/non-reply.
 */
export async function ingestReplyPayload(
  payload: Record<string, unknown>,
): Promise<{ eventId: string | null; deduped: boolean; reason?: string; transient?: boolean }> {
  const admin = getAdminClient();
  const lead = (payload.lead as Record<string, unknown> | undefined) ?? {};

  // Smartlead's real EMAIL_REPLY webhook is sender-centric: `from_email` is
  // OUR sending alias and the lead lives in `sl_lead_email` / `to_email`.
  // Synthetic/backfill payloads put the lead in `from_email` + `lead.email`.
  const isSmartleadWebhook = typeof payload.sl_lead_email === "string" && payload.sl_lead_email.trim() !== "";

  const fromEmail = isSmartleadWebhook
    ? (payload.sl_lead_email as string).trim()
    : firstString(payload.lead_email, lead.email, payload.from_email, payload.to);
  const toEmail = isSmartleadWebhook
    ? firstString(payload.from_email, payload.sender_email)
    : firstString(payload.to_email, payload.sender_email, payload.from);
  const body = firstString(payload.reply_body, payload.email_body, payload.reply_message, payload.message);
  const subject = firstString(payload.subject, payload.reply_subject);
  const messageId = firstString(
    payload.message_id,
    payload.reply_message_id,
    payload.stats_id,
    payload.sl_message_id,
  );
  const campaignId = payload.campaign_id != null ? String(payload.campaign_id) : null;
  const campaignName = firstString(payload.campaign_name);
  const category = firstString(payload.reply_category, payload.lead_category, payload.category);
  // Validate the timestamp — an unparseable value would fail the insert on
  // every Smartlead redelivery (permanent error dressed as transient).
  const receivedAtRaw = firstString(payload.time_replied, payload.time, payload.event_timestamp, payload.created_at);
  const receivedAt = receivedAtRaw && !Number.isNaN(new Date(receivedAtRaw).getTime()) ? receivedAtRaw : null;
  const smartleadLeadIdFromPayload = firstString(
    payload.sl_email_lead_id != null ? String(payload.sl_email_lead_id) : null,
    lead.id != null ? String(lead.id) : null,
    payload.lead_id != null ? String(payload.lead_id) : null,
  );

  if (!fromEmail) {
    return { eventId: null, deduped: false, reason: "No lead email in payload." };
  }

  // Dedupe by message id (also enforced by the unique index — see below).
  if (messageId) {
    const { data: existing } = await admin
      .from("reply_events")
      .select("id")
      .eq("smartlead_message_id", messageId)
      .limit(1)
      .maybeSingle();
    if (existing) {
      return { eventId: existing.id as string, deduped: true };
    }
  }

  // Resolve our lead by email (case-insensitive EXACT match — escape LIKE
  // metacharacters, including PostgREST's `*` alias, so a crafted payload
  // can't wildcard-match another lead).
  const emailPattern = fromEmail.replace(/([\\%_*])/g, "\\$1");
  const { data: leadRow } = await admin
    .from("leads")
    .select("id")
    .ilike("email", emailPattern)
    .limit(1)
    .maybeSingle();

  // Resolve the Smartlead lead id (needed to pull the thread) if not in payload.
  let smartleadLeadId = smartleadLeadIdFromPayload;
  if (!smartleadLeadId) {
    try {
      const lookup = await resolveLeadByEmail(fromEmail);
      smartleadLeadId = lookup?.id ?? null;
    } catch {
      smartleadLeadId = null;
    }
  }

  // Never persist the webhook auth secret inside the raw payload.
  const rawPayload = { ...payload };
  delete rawPayload.secret;
  delete rawPayload.secret_key;

  const { data: inserted, error } = await admin
    .from("reply_events")
    .insert({
      smartlead_message_id: messageId,
      smartlead_lead_id: smartleadLeadId,
      lead_id: (leadRow?.id as string | undefined) ?? null,
      campaign_id: campaignId,
      campaign_name: campaignName,
      from_email: fromEmail,
      to_email: toEmail,
      subject,
      body,
      smartlead_category: category,
      raw: rawPayload,
      status: "received",
      received_at: receivedAt ?? new Date().toISOString(),
      source: "smartlead_webhook",
      source_ref: null,
      metric_eligible: true,
    })
    .select("id")
    .single();

  if (error) {
    // Unique violation on smartlead_message_id: a concurrent delivery won.
    if (error.code === "23505" && messageId) {
      const { data: winner } = await admin
        .from("reply_events")
        .select("id")
        .eq("smartlead_message_id", messageId)
        .limit(1)
        .maybeSingle();
      return { eventId: (winner?.id as string | undefined) ?? null, deduped: true };
    }
    // Transient DB failure: the caller should 5xx so Smartlead redelivers.
    return { eventId: null, deduped: false, reason: error.message, transient: true };
  }

  void markCampaignBriefDirty(campaignId).catch(() => undefined);
  return { eventId: inserted.id as string, deduped: false };
}
