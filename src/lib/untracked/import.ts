import "server-only";

import { categorizeReply, type Extraction } from "@/lib/anthropic";
import { effectiveCategoryBehavior, getEffectiveAiSettings } from "@/lib/campaign-settings";
import { htmlToText } from "@/lib/html";
import { notifyReplyCategorized } from "@/lib/notifications/notify";
import { buildPrompt } from "@/lib/replies/prompt";
import { getAdminClient } from "@/lib/supabase/admin";
import { getTaxonomy } from "@/lib/taxonomy-store";
import type { DncReason } from "@/lib/taxonomy";

export type NewUntrackedContact = { email: string; first_name?: string | null; last_name?: string | null; company?: string | null; domain?: string | null };

export async function processImportedReplyEvent(eventId: string): Promise<{ ok: boolean; proposalId?: string; error?: string }> {
  const admin = getAdminClient();
  const eventResult = await admin.from("reply_events")
    .select("id,lead_id,campaign_id,campaign_name,from_email,subject,body,source,status,received_at,created_at")
    .eq("id", eventId).eq("source", "smartlead_untracked_import").maybeSingle();
  if (eventResult.error || !eventResult.data) return { ok: false, error: eventResult.error?.message ?? "Imported reply event not found." };
  const event = eventResult.data;
  const existing = await admin.from("reply_proposals")
    .select("id")
    .eq("reply_event_id", event.id)
    .in("status", ["pending", "approved"])
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (existing.error) return { ok: false, error: existing.error.message };
  if (existing.data) {
    await admin.from("reply_events").update({ status: "processed", process_error: null }).eq("id", event.id);
    return { ok: true, proposalId: existing.data.id as string };
  }
  const latestReply = htmlToText(event.body ?? "");
  if (!latestReply.trim()) return { ok: false, error: "No stored reply text available to analyze." };
  const [taxonomy, settings, leadResult] = await Promise.all([
    getTaxonomy(), getEffectiveAiSettings(event.campaign_id),
    event.lead_id ? admin.from("leads").select("first_name,last_name,email,company,positive_lead").eq("id", event.lead_id).maybeSingle() : Promise.resolve({ data: null, error: null }),
  ]);
  const lead = leadResult.data;
  const leadName = lead ? `${lead.first_name ?? ""} ${lead.last_name ?? ""}`.trim() || lead.email || "" : "";
  const company = lead?.company ?? "";
  // Prior state (imports are read-only until this proposal is applied), so true
  // means this recovered reply is a follow-up on an already-positive lead.
  const alreadyPositive = lead?.positive_lead === true;
  const prompt = buildPrompt({
    thread: `[RECOVERED LEAD REPLY]\n${latestReply}`, latestReply, leadName, company,
    smartleadCategory: null, categories: taxonomy.active, campaignContext: settings.campaignContext,
  });
  const result = await categorizeReply(prompt, { allowedValues: taxonomy.active.map((category) => category.value), fallbackValue: taxonomy.fallback.value, model: settings.model });
  if (!result.ok) {
    await admin.from("reply_events").update({ status: "error", process_error: result.error }).eq("id", eventId);
    return { ok: false, error: result.error };
  }
  const extraction: Extraction = result.extraction;
  const dncCategory = taxonomy.role("do_not_contact");
  const explicitDnc = extraction.dnc || extraction.category === dncCategory?.value;
  const defunct = extraction.email_defunct;
  const category = explicitDnc && dncCategory ? dncCategory.value : extraction.category;
  const categoryDef = taxonomy.resolve(category);
  const behavior = effectiveCategoryBehavior(categoryDef, {});
  const actionDnc = explicitDnc || behavior.dnc || categoryDef.systemRole === "do_not_contact" || defunct;
  const dncReason: DncReason | null = explicitDnc || behavior.dnc || categoryDef.systemRole === "do_not_contact" ? "explicit_request" : defunct ? "email_defunct" : null;
  const humanReferral = extraction.is_referral && !extraction.is_automated && !extraction.email_defunct;
  const proposedChanges: Record<string, unknown> = {
    last_reply_date: event.received_at ?? event.created_at, latest_response: latestReply.slice(0, 2000),
    sentiment: categoryDef.label,
    notes_person: [`Recovered reply: ${extraction.summary}`, extraction.next_step ? `Next: ${extraction.next_step}` : ""].filter(Boolean).join(" | ").slice(0, 1000),
    referred: humanReferral,
  };
  if (!extraction.is_automated || explicitDnc) {
    proposedChanges.replied = true;
    proposedChanges.positive_lead = categoryDef.sentimentType === "positive" ? true : extraction.positive_lead;
  }
  if (extraction.referee_name) proposedChanges.referee_name = extraction.referee_name;
  const inserted = await admin.from("reply_proposals").insert({
    reply_event_id: event.id, lead_id: event.lead_id, smartlead_lead_id: null, lead_email: event.from_email,
    sentiment: categoryDef.label, sentiment_type: categoryDef.sentimentType, is_referral: humanReferral,
    positive_lead: categoryDef.sentimentType === "positive" ? true : extraction.positive_lead,
    summary: extraction.summary, next_step: extraction.next_step, reasoning: extraction.reasoning,
    ai_provider: `anthropic:${result.model}`, proposed_changes: proposedChanges,
    action_suppress: (behavior.suppress || actionDnc) && Boolean(event.from_email),
    action_dnc: actionDnc && Boolean(event.from_email), action_value: event.from_email,
    dnc_reason: actionDnc ? dncReason : null, ooo_return_date: extraction.ooo_return_date,
    status: "pending", suggested_reply: null, research: null,
  }).select("id").single();
  if (inserted.error) return { ok: false, error: inserted.error.message };
  await admin.from("reply_events").update({ status: "processed", process_error: null }).eq("id", eventId);
  await notifyReplyCategorized({
    proposalId: inserted.data.id, campaignId: event.campaign_id, category: categoryDef,
    leadName: leadName || "Recovered contact", leadEmail: event.from_email, company,
    campaignName: event.campaign_name, summary: `Recovered reply: ${extraction.summary}`,
    nextStep: extraction.next_step, replyText: latestReply,
    autoApplied: false, followUpOnPositive: alreadyPositive,
  });
  return { ok: true, proposalId: inserted.data.id as string };
}

export async function importUntrackedReply(input: {
  stagingId: string; leadId?: string | null; campaignId?: string | null;
  createContact?: NewUntrackedContact | null; reviewerEmail: string;
}) {
  const { data, error } = await getAdminClient().rpc("import_untracked_reply", {
    p_staging_id: input.stagingId, p_chosen_lead_id: input.leadId ?? null,
    p_chosen_campaign_id: input.campaignId ?? null, p_new_contact: input.createContact ?? null,
    p_reviewer_email: input.reviewerEmail,
  });
  if (error) return { ok: false as const, error: error.message };
  const row = Array.isArray(data) ? data[0] : data;
  if (!row?.event_id) return { ok: false as const, error: "Import RPC returned no event." };
  const processing = await processImportedReplyEvent(String(row.event_id));
  return { ok: true as const, eventId: String(row.event_id), leadId: row.lead_id ? String(row.lead_id) : null, processing };
}
