import "server-only";
import { getAdminClient } from "@/lib/supabase/admin";
import { categorizeReply, type Extraction } from "@/lib/anthropic";
import {
  fetchReplyCategories,
  getMessageHistory,
  resolveSmartleadCategoryId,
  updateLeadCategory,
  type SmartleadMessage,
} from "@/lib/smartlead";
import type { DncReason } from "@/lib/taxonomy";
import { getTaxonomy } from "@/lib/taxonomy-store";
import {
  effectiveCategoryBehavior,
  getCampaignOverrides,
  getEffectiveAiSettings,
} from "@/lib/campaign-settings";
import { htmlToText } from "@/lib/html";
import { buildPrompt, renderThread } from "@/lib/replies/prompt";
import { applyProposal } from "@/lib/replies/apply";
import { cancelScheduledResumes } from "@/lib/replies/schedule";
import { getColleagues } from "@/lib/replies/research";
import { draftReply } from "@/lib/replies/draft";
import { notifyReplyCategorized } from "@/lib/notifications/notify";
import type { ReplyEventRow } from "@/lib/types";

export function isHumanReferral(
  extraction: Pick<Extraction, "is_referral" | "is_automated" | "email_defunct">,
): boolean {
  return extraction.is_referral && !extraction.is_automated && !extraction.email_defunct;
}

export function shouldAutoApplyDeadMailbox(input: {
  provider: string;
  emailDefunct: boolean;
  isAutomated: boolean;
  explicitDnc: boolean;
  supersededCount: number;
  replacing: boolean;
  enabled: boolean;
}): boolean {
  // Like the OOO branch, only a real AI read may trigger automation; the
  // Smartlead-fallback extraction never sets email_defunct today, but the
  // guard must not rely on that staying true.
  return input.provider.startsWith("anthropic") &&
    input.emailDefunct && input.isAutomated && !input.explicitDnc &&
    input.supersededCount === 0 && !input.replacing && input.enabled;
}

/**
 * Turn a received reply event into a pending proposal: fetch full thread
 * context, categorize + extract via the Claude API, map onto leads columns,
 * and insert a reply_proposals row. Returns the proposal id or an error.
 */
export async function processReplyEvent(
  event: ReplyEventRow,
  options: { userNote?: string; replaceProposalId?: string } = {},
): Promise<{ ok: boolean; proposalId?: string; error?: string }> {
  const admin = getAdminClient();
  const [taxonomy, settings, campaignOverrides] = await Promise.all([
    getTaxonomy(),
    getEffectiveAiSettings(event.campaign_id),
    event.campaign_id ? getCampaignOverrides(event.campaign_id) : Promise.resolve({}),
  ]);

  // Idempotent rerun guard: if a prior (crashed/stale-requeued) run already
  // produced an ACTIVE proposal for this event, reuse it rather than double-
  // creating. Declined proposals don't block — deliberate reprocessing
  // supersedes them first, then expects a fresh read.
  if (!options.replaceProposalId) {
    const { data: existing } = await admin
      .from("reply_proposals")
      .select("id")
      .eq("reply_event_id", event.id)
      .in("status", ["pending", "approved"])
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (existing) {
      await admin.from("reply_events").update({ status: "processed", process_error: null }).eq("id", event.id);
      return { ok: true, proposalId: existing.id as string };
    }
  }

  // Pull the authoritative thread; fall back to the stored body.
  let messages: SmartleadMessage[] = [];
  if (event.campaign_id && event.smartlead_lead_id) {
    try {
      messages = await getMessageHistory(event.campaign_id, event.smartlead_lead_id);
    } catch {
      messages = [];
    }
  }

  // Analyze THIS event's reply — not whatever arrived latest. Match by
  // Smartlead message id first, then by timestamp (with slack for clock
  // skew), then fall back to the stored body.
  const replyMessages = messages.filter((m) => m.type === "REPLY");
  const eventTime = new Date(event.received_at ?? event.created_at).getTime();
  const matchedById = event.smartlead_message_id
    ? replyMessages.find(
        (m) => m.message_id === event.smartlead_message_id || m.stats_id === event.smartlead_message_id,
      )
    : undefined;
  const matchedByTime = Number.isFinite(eventTime)
    ? [...replyMessages].filter((m) => {
        const t = new Date(m.time).getTime();
        return Number.isFinite(t) ? t <= eventTime + 120_000 : true;
      }).pop()
    : undefined;
  const matched = matchedById ?? matchedByTime ?? replyMessages[replyMessages.length - 1];
  const latestReply = matched ? htmlToText(matched.email_body) : htmlToText(event.body ?? "");

  if (!latestReply.trim()) {
    return { ok: false, error: "No reply text available to analyze." };
  }

  const thread = messages.length > 0 ? renderThread(messages) : `[LEAD REPLY]\n${latestReply}`;

  // Resolve lead display data from our DB when linked. `positive_lead` is read
  // BEFORE this reply's changes are applied, so it reflects PRIOR state — true
  // only when the lead was already an established positive lead, i.e. this reply
  // is a follow-up on it.
  let leadName = "";
  let company = "";
  let alreadyPositive = false;
  if (event.lead_id) {
    const { data: leadRow } = await admin
      .from("leads")
      .select("first_name, last_name, email, company, positive_lead")
      .eq("id", event.lead_id)
      .maybeSingle();
    if (leadRow) {
      const name = `${leadRow.first_name ?? ""} ${leadRow.last_name ?? ""}`.trim();
      leadName = name || (leadRow.email as string) || "";
      company = (leadRow.company as string | null) ?? "";
      alreadyPositive = leadRow.positive_lead === true;
    }
  }

  const smartleadValue = taxonomy.fromSmartleadLabel(event.smartlead_category);
  const prompt = buildPrompt({
    thread,
    latestReply,
    leadName,
    company,
    smartleadCategory: event.smartlead_category,
    categories: taxonomy.active,
    campaignContext: settings.campaignContext,
    userNote: options.userNote,
  });

  const result = await categorizeReply(prompt, {
    allowedValues: taxonomy.active.map((category) => category.value),
    fallbackValue: taxonomy.fallback.value,
    model: settings.model,
  });

  let extraction: Extraction;
  let provider: string;
  if (result.ok) {
    extraction = result.extraction;
    provider = `anthropic:${result.model}`;
  } else {
    // Fall back to Smartlead's own category so a proposal still appears.
    // Limitation: Smartlead's wrong-person tag has no automation signal, so
    // this fallback may still mark an automated handoff as a referral.
    extraction = {
      category: smartleadValue ?? taxonomy.fallback.value,
      positive_lead: taxonomy.resolve(smartleadValue).sentimentType === "positive",
      is_referral: smartleadValue === taxonomy.role("wrong_person")?.value,
      referee_name: null,
      referee_title: null,
      referee_email: null,
      summary: `AI could not analyze this reply (${result.error}); using Smartlead's category.`,
      next_step: "Review the reply manually.",
      reasoning: "Fallback to Smartlead auto-category.",
      is_automated: false,
      dnc: false,
      email_defunct: false,
      temporary_absence: false,
      ooo_return_date: null,
    };
    provider = "fallback";
  }

  // Resolve final actions.
  // - explicit dnc (hostile / "remove me") escalates the category and blocks the email.
  // - email_defunct blocks just that address (dead mailbox) WITHOUT branding the
  //   person as do-not-contact — the category stays whatever the AI read.
  const dncCategory = taxonomy.role("do_not_contact");
  const referralCategory = taxonomy.byValue("referral");
  const explicitDnc = extraction.dnc || extraction.category === dncCategory?.value;
  const defunct = extraction.email_defunct;
  const humanReferral = isHumanReferral(extraction);
  // A genuine human referral gets its own positive category — never one of the
  // three main positive buckets (interested/meeting/info) or Wrong Person.
  // explicitDnc still wins (a hostile "remove me" is never a referral); falls
  // back to the AI's category if the Referral category is somehow absent.
  const category =
    explicitDnc && dncCategory
      ? dncCategory.value
      : humanReferral && referralCategory
        ? referralCategory.value
        : extraction.category;
  const categoryDef = taxonomy.resolve(category);
  const categoryBehavior = effectiveCategoryBehavior(categoryDef, campaignOverrides);
  const categoryDnc = categoryBehavior.dnc || categoryDef.systemRole === "do_not_contact";
  const actionDnc = explicitDnc || categoryDnc || defunct;
  const dncReason: DncReason | null =
    explicitDnc || categoryDnc ? "explicit_request" : defunct ? "email_defunct" : null;
  const actionSuppress = categoryBehavior.suppress || actionDnc;

  // Pure automated OOO: don't propose marking the lead as "replied" — nobody
  // actually read our email. Everything else counts as a real reply.
  const humanReply = !extraction.is_automated || explicitDnc;

  const noteParts = [
    extraction.summary,
    extraction.next_step ? `Next: ${extraction.next_step}` : "",
    extraction.referee_title ? `Referral role: ${extraction.referee_title}` : "",
    extraction.referee_email ? `Referral email: ${extraction.referee_email}` : "",
    defunct ? "Email address reported as no longer in use." : "",
  ].filter(Boolean);

  const proposedChanges: Record<string, unknown> = {
    last_reply_date: new Date().toISOString(),
    latest_response: latestReply.slice(0, 2000),
    sentiment: categoryDef.label,
    notes_person: noteParts.join(" | ").slice(0, 1000),
  };
  // `referred` is sticky: set it when a human referral is detected, but never
  // write false over a value an earlier reply may have set — an unrelated OOO
  // auto-apply must not clobber last month's genuine referral.
  if (humanReferral) proposedChanges.referred = true;
  if (humanReply) {
    proposedChanges.replied = true;
    proposedChanges.positive_lead = categoryDef.sentimentType === "positive" ? true : extraction.positive_lead;
  }
  if (extraction.referee_name) {
    proposedChanges.referee_name = extraction.referee_name;
  }

  const actionValue = event.from_email ?? null;

  const { data: inserted, error: insertError } = await admin
    .from("reply_proposals")
    .insert({
      reply_event_id: event.id,
      lead_id: event.lead_id,
      smartlead_lead_id: event.smartlead_lead_id,
      lead_email: event.from_email,
      sentiment: categoryDef.label,
      sentiment_type: categoryDef.sentimentType,
      is_referral: humanReferral,
      positive_lead: categoryDef.sentimentType === "positive" ? true : extraction.positive_lead,
      summary: extraction.summary,
      next_step: extraction.next_step,
      reasoning: extraction.reasoning,
      ai_provider: provider,
      proposed_changes: proposedChanges,
      action_suppress: actionSuppress && Boolean(actionValue),
      action_dnc: actionDnc && Boolean(actionValue),
      action_value: actionValue,
      dnc_reason: actionDnc ? dncReason : null,
      ooo_return_date: extraction.ooo_return_date,
      status: "pending",
      user_note: options.userNote ?? null,
    })
    .select("id")
    .single();

  if (insertError) {
    return { ok: false, error: insertError.message };
  }

  // One active read per lead, decided by ARRIVAL ORDER — concurrent drains
  // can finish out of order, so this event only "wins" if no newer event
  // exists for the same address. Winning: cancel staged resumes and decline
  // older pendings. Losing: decline OWN proposal and touch nothing else
  // (especially not the newer event's freshly scheduled resume).
  let supersededByNewer = false;
  let supersededCount = 0;
  if (event.from_email) {
    const emailPattern = event.from_email.replace(/([\\%_*])/g, "\\$1");

    const { data: newerEvent } = await admin
      .from("reply_events")
      .select("id")
      .ilike("from_email", emailPattern)
      .gt("created_at", event.created_at)
      .neq("id", event.id)
      .in("status", ["received", "processing", "processed"])
      .limit(1)
      .maybeSingle();
    supersededByNewer = Boolean(newerEvent);

    if (supersededByNewer) {
      await admin
        .from("reply_proposals")
        .update({ status: "declined", resolved_at: new Date().toISOString(), resolved_by: "superseded (newer reply)" })
        .eq("id", inserted.id)
        .eq("status", "pending");
    } else {
      await cancelScheduledResumes(event.from_email, "Superseded by a newer reply.");
      const { data: supersededRows } = await admin
        .from("reply_proposals")
        .update({ status: "declined", resolved_at: new Date().toISOString(), resolved_by: "superseded (newer reply)" })
        .ilike("lead_email", emailPattern)
        .eq("status", "pending")
        .neq("id", inserted.id)
        .select("id");
      supersededCount = supersededRows?.length ?? 0;
    }
  }

  if (supersededByNewer) {
    // Still a successfully handled event — the newest read owns the lead.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const { error: doneError } = await admin
        .from("reply_events")
        .update({ status: "processed", process_error: null })
        .eq("id", event.id);
      if (!doneError) break;
    }
    return { ok: true, proposalId: inserted.id as string };
  }

  // Mirror the AI's read onto the lead in Smartlead right away (tag only —
  // pausing and block-list actions still wait for approval / automation).
  // Best-effort: a Smartlead hiccup must not fail categorization.
  if (event.campaign_id && event.smartlead_lead_id) {
    try {
      const categoryId = resolveSmartleadCategoryId(await fetchReplyCategories(), categoryDef.label);
      if (categoryId) {
        await updateLeadCategory({
          campaignId: event.campaign_id,
          smartleadLeadId: event.smartlead_lead_id,
          categoryId,
          pauseLead: false,
        });
      }
    } catch {
      // approve/auto-apply re-syncs the tag later
    }
  }

  // Enqueue + eager-drain notifications HERE, before the slow reply draft below.
  // The draft (colleague research + web + Claude, 30-50s) used to eat the 60s
  // serverless budget and strand the notification, which was the last step; now
  // the notification is durable (a persisted outbox row) and fired up front, so
  // a cutoff during drafting can never lose it. autoApplied is false at this
  // point, which is correct for every channel-matching (positive) category.
  if (!options.replaceProposalId) {
    await notifyReplyCategorized({
      proposalId: inserted.id as string,
      campaignId: event.campaign_id,
      category: categoryDef,
      leadName,
      leadEmail: event.from_email,
      company,
      campaignName: event.campaign_name,
      summary: extraction.summary,
      nextStep: extraction.next_step,
      replyText: latestReply,
      autoApplied: false,
      followUpOnPositive: alreadyPositive,
    });
  }

  // Pre-draft a reply for reply-worthy human responses,
  // with lean colleague research (CRM first, capped web search second).
  // Best-effort: failures leave the proposal without a draft.
  const draftWorthy =
    settings.draftingEnabled &&
    provider.startsWith("anthropic") &&
    !extraction.is_automated &&
    !actionDnc &&
    !defunct &&
    categoryBehavior.draftReply &&
    Boolean(event.from_email);

  if (draftWorthy) {
    try {
      const colleagues = await getColleagues({
        leadEmail: event.from_email!,
        companyName: company || null,
        colleagueResearchEnabled: settings.colleagueResearchEnabled,
        colleagueRolesHint: settings.colleagueRolesHint,
        model: settings.model,
      });
      const suggested = await draftReply({
        settings,
        guidance: categoryBehavior.draftGuidance,
        leadName,
        company,
        thread,
        latestReply,
        colleagues,
        userNote: options.userNote,
      });
      // Always store research (even an empty array) — that's the "we already
      // looked" cache that stops repeat web spend on the same company.
      await admin
        .from("reply_proposals")
        .update({ suggested_reply: suggested, research: colleagues })
        .eq("id", inserted.id);
    } catch {
      // draft is a convenience only
    }
  }

  // If re-generating (edit-with-context), supersede the old proposal. If the
  // supersede errors, remove the new proposal so two pendings never coexist.
  if (options.replaceProposalId) {
    const { error: supersedeError } = await admin
      .from("reply_proposals")
      .update({ status: "declined", resolved_at: new Date().toISOString(), resolved_by: "superseded" })
      .eq("id", options.replaceProposalId)
      .eq("status", "pending");
    if (supersedeError) {
      await admin.from("reply_proposals").delete().eq("id", inserted.id);
      return { ok: false, error: `Could not supersede the old proposal: ${supersedeError.message}` };
    }
  }

  // Mark the event handled; retry once — an event left in 'processing' would
  // be re-queued after the staleness window and produce a duplicate proposal.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const { error: doneError } = await admin
      .from("reply_events")
      .update({ status: "processed", process_error: null })
      .eq("id", event.id);
    if (!doneError) break;
  }

  // Pure out-of-office replies are time-sensitive and carry no destructive
  // actions — handle them automatically (pause + scheduled resume + Smartlead
  // tag). temporary_absence is required so generic autoresponders (ticket
  // acks, "we received your inquiry") never auto-pause a lead — those wait
  // for a human. And if this OOO just superseded another pending read (e.g.
  // a human "interested" reply answered by a vacation autoresponder), a human
  // must look instead of the automation burying it. If auto-apply fails, the
  // proposal stays pending for a human.
  const isPureOoo =
    provider.startsWith("anthropic") &&
    extraction.is_automated &&
    extraction.temporary_absence &&
    categoryDef.systemRole === "out_of_office" &&
    !actionDnc &&
    !actionSuppress &&
    supersededCount === 0;

  // Auto-apply pure OOO / dead-mailbox reads (the side effect is what matters;
  // the notification already fired above, so the ok result is no longer needed).
  const shouldAutoApplyOoo = isPureOoo && settings.autoHandleOoo && !options.replaceProposalId;
  if (shouldAutoApplyOoo) {
    await applyProposal(inserted.id as string, "auto (out of office)", settings);
  }

  const shouldAutoApplyDead = shouldAutoApplyDeadMailbox({
    provider,
    emailDefunct: extraction.email_defunct,
    isAutomated: extraction.is_automated,
    explicitDnc,
    supersededCount,
    replacing: Boolean(options.replaceProposalId),
    enabled: settings.autoHandleDeadMailbox,
  });
  if (shouldAutoApplyDead) {
    await applyProposal(inserted.id as string, "auto (dead mailbox)", settings);
  }

  // Notifications were already enqueued + drained above (before the slow draft),
  // so they survive a cutoff during drafting/auto-apply. The durable outbox and
  // the cron drain guarantee eventual delivery.

  return { ok: true, proposalId: inserted.id as string };
}

// Above the longest legitimate run (cron caps at 300s; webhook/page after()
// at 60s) so a slow-but-alive worker is never double-claimed.
const STALE_CLAIM_MINUTES = 20;

/**
 * Process queued reply events into pending proposals. Runs from three places
 * (webhook after(), inbox page-load drain, cron), so each event is atomically
 * claimed ('processing') before the AI call — losers of the race skip it.
 * Claims abandoned by a crashed worker re-queue after STALE_CLAIM_MINUTES.
 */
export async function processPendingReplyEvents(limit = 25) {
  const admin = getAdminClient();
  const staleCutoff = new Date(Date.now() - STALE_CLAIM_MINUTES * 60_000).toISOString();

  const { data: events, error } = await admin
    .from("reply_events")
    .select(
      "id, smartlead_message_id, smartlead_lead_id, lead_id, campaign_id, campaign_name, from_email, to_email, subject, body, smartlead_category, status, received_at, created_at",
    )
    .eq("source", "smartlead_webhook")
    .or(`status.eq.received,and(status.eq.processing,process_started_at.lt.${staleCutoff})`)
    .order("created_at", { ascending: true })
    .limit(Math.max(1, Math.min(limit, 100)));

  if (error) {
    return { processed: 0, failed: 0, total: 0, error: error.message };
  }

  let processed = 0;
  let failed = 0;
  let skipped = 0;

  for (const event of (events ?? []) as (ReplyEventRow & { status: string })[]) {
    // Atomic claim: only one concurrent drain wins each event.
    let claim = admin
      .from("reply_events")
      .update({ status: "processing", process_started_at: new Date().toISOString() })
      .eq("id", event.id)
      .eq("status", event.status);
    if (event.status === "processing") {
      claim = claim.lt("process_started_at", staleCutoff);
    }
    const { data: claimedRows, error: claimError } = await claim.select("id");
    if (claimError || !claimedRows || claimedRows.length === 0) {
      skipped += 1;
      continue;
    }

    const result = await processReplyEvent(event);
    if (result.ok) {
      processed += 1;
    } else {
      failed += 1;
      await admin
        .from("reply_events")
        .update({ status: "error", process_error: result.error ?? "unknown" })
        .eq("id", event.id);
    }
  }

  return { processed, failed, skipped, total: (events ?? []).length };
}
