import "server-only";
import { getAdminClient } from "@/lib/supabase/admin";
import { getWorkspaceSettings } from "@/lib/settings-store";
import { getTaxonomy } from "@/lib/taxonomy-store";
import { htmlToText } from "@/lib/html";
import { buildSmartleadConversationUrl } from "@/lib/smartlead/links";
import { normalizeLinkedInUrl } from "@/lib/linkedin";
import type { Conversation, EventDto, ProposalDto } from "@/lib/types";

const WINDOW_DAYS = 90;
const PAGE_SIZE = 1000;
const QUERY_HARD_CAP = 10_000;

function isoDaysAgo(days: number) {
  return new Date(Date.now() - days * 86_400_000).toISOString();
}

export async function fetchNewestRows<T>(
  table: string,
  columns: string,
  since: string,
  context: string,
  cap: number = QUERY_HARD_CAP,
  metricEligible = false,
): Promise<T[]> {
  const admin = getAdminClient();
  const rows: T[] = [];
  let totalCount: number | null = null;

  for (let offset = 0; offset < cap; offset += PAGE_SIZE) {
    let query = admin
      .from(table)
      .select(columns, offset === 0 ? { count: "exact" } : undefined)
      .gte("created_at", since);
    if (metricEligible) query = query.eq("metric_eligible", true);
    const result = await query
      .order("created_at", { ascending: false })
      .order("id", { ascending: false })
      .range(offset, offset + PAGE_SIZE - 1);
    if (result.error) throw new Error(`${context}: ${result.error.message}`);
    if (offset === 0) totalCount = result.count;

    const page = (result.data ?? []) as T[];
    rows.push(...page);
    if (page.length < PAGE_SIZE) break;
  }

  if ((totalCount ?? rows.length) > cap) {
    console.warn(
      `${context}: ${totalCount ?? "more than"} rows matched; using the newest ${cap} by created_at/id.`,
    );
  }
  return rows;
}

export function latestPerEvent<T extends { id: string; reply_event_id: string | null; created_at: string }>(rows: T[]) {
  const latest = new Map<string, T>();
  for (const row of rows) {
    const key = row.reply_event_id ?? row.id;
    const existing = latest.get(key);
    if (
      !existing ||
      row.created_at > existing.created_at ||
      (row.created_at === existing.created_at && row.id > existing.id)
    ) {
      latest.set(key, row);
    }
  }
  return latest;
}

function dateKey(date: Date, formatter: Intl.DateTimeFormat): string {
  const parts = formatter.formatToParts(date);
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  const day = parts.find((part) => part.type === "day")?.value;
  if (!year || !month || !day) throw new Error("Could not format analytics date bucket.");
  return `${year}-${month}-${day}`;
}

function localCalendarDates(now: Date, formatter: Intl.DateTimeFormat, count: number): string[] {
  const today = dateKey(now, formatter);
  const [year, month, day] = today.split("-").map(Number);
  const anchor = Date.UTC(year, month - 1, day);
  return Array.from({ length: count }, (_, index) =>
    new Date(anchor - (count - index - 1) * 86_400_000).toISOString().slice(0, 10),
  );
}

type RawEvent = {
  id: string;
  smartlead_lead_id: string | null;
  lead_id: string | null;
  campaign_id: string | null;
  campaign_name: string | null;
  from_email: string | null;
  subject: string | null;
  body: string | null;
  smartlead_category: string | null;
  received_at: string | null;
  created_at: string;
};

type RawProposal = {
  id: string;
  reply_event_id: string | null;
  lead_id: string | null;
  lead_email: string | null;
  status: "pending" | "approved" | "declined";
  sentiment: string | null;
  sentiment_type: "positive" | "negative" | "neutral" | null;
  is_referral: boolean;
  positive_lead: boolean | null;
  summary: string | null;
  next_step: string | null;
  reasoning: string | null;
  ai_provider: string | null;
  proposed_changes: unknown;
  action_suppress: boolean;
  action_dnc: boolean;
  action_value: string | null;
  dnc_reason: "explicit_request" | "email_defunct" | null;
  user_note: string | null;
  suggested_reply: string | null;
  research: unknown;
  created_at: string;
  resolved_at: string | null;
  resolved_by: string | null;
};

function parseChanges(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value === "string") {
    try {
      return JSON.parse(value) as Record<string, unknown>;
    } catch {
      return {};
    }
  }
  return {};
}

function toProposalDto(row: RawProposal): ProposalDto {
  return {
    id: row.id,
    replyEventId: row.reply_event_id,
    leadId: row.lead_id,
    leadEmail: row.lead_email,
    status: row.status,
    sentiment: row.sentiment,
    sentimentType: row.sentiment_type,
    isReferral: row.is_referral,
    positiveLead: row.positive_lead,
    summary: row.summary,
    nextStep: row.next_step,
    reasoning: row.reasoning,
    aiProvider: row.ai_provider,
    proposedChanges: parseChanges(row.proposed_changes),
    actionSuppress: row.action_suppress,
    actionDnc: row.action_dnc,
    actionValue: row.action_value,
    dncReason: row.dnc_reason,
    userNote: row.user_note,
    suggestedReply: row.suggested_reply,
    research: Array.isArray(row.research)
      ? (row.research as { name: string; title: string | null; email: string | null; source: "crm" | "web" }[])
      : [],
    createdAt: row.created_at,
    resolvedAt: row.resolved_at,
    resolvedBy: row.resolved_by,
  };
}

/** Everything the inbox needs, grouped into per-lead conversations. */
export async function getInboxConversations(): Promise<Conversation[]> {
  const admin = getAdminClient();
  const taxonomy = await getTaxonomy();
  const since = isoDaysAgo(WINDOW_DAYS);

  // Tighter caps than analytics: this is a hot interactive path that also
  // runs htmlToText per event — bound it near the old 500/800 limits (now
  // deterministically the NEWEST rows) instead of paging toward 10k.
  const [events, proposals] = await Promise.all([
    fetchNewestRows<RawEvent>(
      "reply_events",
      "id, smartlead_lead_id, lead_id, campaign_id, campaign_name, from_email, subject, body, smartlead_category, received_at, created_at",
      since,
      "Inbox events query",
      1000,
    ),
    fetchNewestRows<RawProposal>(
      "reply_proposals",
      "id, reply_event_id, lead_id, lead_email, status, sentiment, sentiment_type, is_referral, positive_lead, summary, next_step, reasoning, ai_provider, proposed_changes, action_suppress, action_dnc, action_value, dnc_reason, user_note, suggested_reply, research, created_at, resolved_at, resolved_by",
      since,
      "Inbox proposals query",
      2000,
    ),
  ]);

  // Resolve lead display data for linked events.
  const leadIds = [...new Set(events.map((e) => e.lead_id).filter(Boolean))] as string[];
  const leadsById = new Map<
    string,
    {
      first_name: string | null;
      last_name: string | null;
      company: string | null;
      title: string | null;
      linkedin_url: string | null;
      industry: string | null;
      employee_count: number | null;
    }
  >();
  if (leadIds.length > 0) {
    const leads = [];
    for (let offset = 0; offset < leadIds.length; offset += 500) {
      const result = await admin
        .from("leads")
        .select("id, first_name, last_name, company, title, linkedin_url, industry, employee_count")
        .in("id", leadIds.slice(offset, offset + 500));
      if (result.error) throw new Error(`Inbox leads query: ${result.error.message}`);
      leads.push(...(result.data ?? []));
    }
    for (const lead of leads) {
      // employee_count is stored as text in the CRM import — coerce defensively.
      const employeeCount = Number(lead.employee_count);
      leadsById.set(lead.id as string, {
        first_name: (lead.first_name as string | null) ?? null,
        last_name: (lead.last_name as string | null) ?? null,
        company: (lead.company as string | null) ?? null,
        title: (lead.title as string | null) ?? null,
        linkedin_url: normalizeLinkedInUrl(lead.linkedin_url as string | null),
        industry: (lead.industry as string | null) ?? null,
        employee_count: Number.isFinite(employeeCount) && employeeCount > 0 ? employeeCount : null,
      });
    }
  }

  const eventById = new Map(events.map((e) => [e.id, e]));
  const byKey = new Map<string, Conversation>();

  const conversationFor = (email: string, seed: Partial<Conversation> = {}) => {
    const key = email.toLowerCase();
    let conversation = byKey.get(key);
    if (!conversation) {
      conversation = {
        key,
        leadEmail: email,
        leadId: null,
        name: email.split("@")[0],
        company: null,
        title: null,
        linkedinUrl: null,
        industry: null,
        employeeCount: null,
        campaignName: null,
        lastInboundAt: null,
        latestAt: "1970-01-01T00:00:00.000Z",
        snippet: "",
        hasPending: false,
        categoryValue: null,
        sentimentType: null,
        events: [],
        proposals: [],
        ...seed,
      };
      byKey.set(key, conversation);
    }
    return conversation;
  };

  for (const event of events) {
    if (!event.from_email) continue;
    const conversation = conversationFor(event.from_email);
    const lead = event.lead_id ? leadsById.get(event.lead_id) : undefined;
    if (event.lead_id && !conversation.leadId) conversation.leadId = event.lead_id;
    if (lead) {
      const name = `${lead.first_name ?? ""} ${lead.last_name ?? ""}`.trim();
      if (name) conversation.name = name;
      conversation.company = conversation.company ?? lead.company;
      conversation.title = conversation.title ?? lead.title;
      conversation.linkedinUrl = conversation.linkedinUrl ?? lead.linkedin_url;
      conversation.industry = conversation.industry ?? lead.industry;
      conversation.employeeCount = conversation.employeeCount ?? lead.employee_count;
    }
    if (event.campaign_name && !conversation.campaignName) conversation.campaignName = event.campaign_name;
    conversation.smartleadUrl =
      conversation.smartleadUrl ??
      buildSmartleadConversationUrl({
        campaignId: event.campaign_id,
        smartleadLeadId: event.smartlead_lead_id,
      });

    const dto: EventDto = {
      id: event.id,
      subject: event.subject,
      bodyText: htmlToText(event.body ?? "").slice(0, 4000),
      smartleadCategory: event.smartlead_category,
      campaignId: event.campaign_id,
      campaignName: event.campaign_name,
      smartleadLeadId: event.smartlead_lead_id,
      receivedAt: event.received_at ?? event.created_at,
    };
    conversation.events.push(dto);
    if (!conversation.lastInboundAt || dto.receivedAt > conversation.lastInboundAt) conversation.lastInboundAt = dto.receivedAt;
    if (dto.receivedAt > conversation.latestAt) conversation.latestAt = dto.receivedAt;
  }

  for (const proposal of proposals) {
    const viaEvent = proposal.reply_event_id ? eventById.get(proposal.reply_event_id) : undefined;
    const email = viaEvent?.from_email ?? proposal.lead_email;
    if (!email) continue;
    const conversation = conversationFor(email);
    if (proposal.lead_id && !conversation.leadId) conversation.leadId = proposal.lead_id;
    conversation.proposals.push(toProposalDto(proposal));
    if (proposal.created_at > conversation.latestAt) conversation.latestAt = proposal.created_at;
  }

  for (const conversation of byKey.values()) {
    conversation.events.sort((a, b) => a.receivedAt.localeCompare(b.receivedAt));
    conversation.proposals.sort(
      (a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id),
    );
    const latest = new Map<string, ProposalDto>();
    for (const proposal of conversation.proposals) {
      const key = proposal.replyEventId ?? proposal.id;
      if (!latest.has(key)) latest.set(key, proposal);
    }
    conversation.hasPending = [...latest.values()].some((proposal) => proposal.status === "pending");
    const latestProposal = conversation.proposals[0];
    conversation.categoryValue = latestProposal ? (taxonomy.fromLabel(latestProposal.sentiment)?.value ?? null) : null;
    conversation.sentimentType = latestProposal?.sentimentType ?? null;
    const lastEvent = conversation.events[conversation.events.length - 1];
    conversation.snippet = (latestProposal?.summary || lastEvent?.bodyText || "").slice(0, 160);
  }

  return [...byKey.values()].sort((a, b) => b.latestAt.localeCompare(a.latestAt));
}

// Deliberately a raw indexed COUNT, not a latest-per-event dedup: this badge
// renders on every navigation (app layout is force-dynamic), and a superseded
// proposal left 'pending' is a transient state — the supersede path declines
// it. Paging thousands of rows per click to shave that window isn't worth it.
export async function getPendingCount(): Promise<number> {
  const { count } = await getAdminClient()
    .from("reply_proposals")
    .select("id", { count: "exact", head: true })
    .eq("status", "pending")
    .gte("created_at", isoDaysAgo(WINDOW_DAYS)); // matches the inbox window
  return count ?? 0;
}

/**
 * Every count below is a count of PEOPLE, not messages: a lead who replies five
 * times is one reply and (if any of those reads positive) one positive lead.
 * Counting per message let one chatty lead read as five separate warm leads.
 * The per-message records are still exact — the drill-down list and the lead
 * detail panel show every individual reply.
 */
export type AnalyticsData = {
  totalReplies: number;
  replies7d: number;
  replies30d: number;
  /**
   * Distinct leads with at least one categorized reply — the honest denominator
   * for positive rate. NOT positive+negative+neutral: a lead who replied both
   * positively and negatively counts in both buckets, so summing them would
   * over-count and push the rate below its true value.
   */
  categorizedLeads: number;
  pendingCount: number;
  approvedCount: number;
  positiveCount: number;
  negativeCount: number;
  neutralCount: number;
  referralCount: number;
  oooCount: number;
  dncExplicit: number;
  dncDefunct: number;
  sentFromInbox: number;
  sentFromInboxIsWorkspaceWide: boolean;
  windowDays: number;
  perDay: { date: string; positive: number; negative: number; neutral: number }[];
  categories: { label: string; count: number; sentimentType: string }[];
  campaigns: { id: string | null; name: string; replies: number; positive: number }[];
};

export type AnalyticsFilter = {
  days?: 7 | 30 | 90;
  campaigns?: { mode: "include" | "exclude"; ids: string[] } | null;
};

export type CampaignReplyStats = {
  replies30d: number;
  positive30d: number;
  perDay: { date: string; replies: number; positive: number }[]; // last 30 local days
  categories: { label: string; count: number; sentimentType: string }[];
};

/**
 * Reply-side stats for ONE campaign over the last 30 days, from our own
 * ingested events (classified richer than Smartlead's counters, but only
 * covering replies captured since the webhook was installed).
 */
export async function getCampaignReplyStats(campaignId: string): Promise<CampaignReplyStats> {
  const admin = getAdminClient();
  const workspace = await getWorkspaceSettings();
  const now = new Date();
  const since = isoDaysAgo(30);

  // Events are campaign-scoped, paginated to the shared hard cap so a busy
  // campaign is not silently undercounted by a flat limit.
  type StatsEvent = {
    id: string;
    lead_id: string | null;
    from_email: string | null;
    received_at: string | null;
    created_at: string;
  };
  const events: StatsEvent[] = [];
  for (let offset = 0; offset < QUERY_HARD_CAP; offset += PAGE_SIZE) {
    const result = await admin
      .from("reply_events")
      .select("id, lead_id, from_email, received_at, created_at")
      .eq("campaign_id", campaignId)
      .eq("metric_eligible", true)
      .gte("created_at", since)
      .order("created_at", { ascending: false })
      .order("id", { ascending: false })
      .range(offset, offset + PAGE_SIZE - 1);
    if (result.error) throw new Error(`Campaign reply stats events: ${result.error.message}`);
    const page = (result.data ?? []) as StatsEvent[];
    events.push(...page);
    if (page.length < PAGE_SIZE) break;
  }

  // Proposals are fetched only for this campaign's events (the table has no
  // campaign_id column, and a workspace-wide limit would let other campaigns'
  // proposals crowd these out).
  type StatsProposal = {
    id: string;
    reply_event_id: string | null;
    created_at: string;
    sentiment: string | null;
    sentiment_type: string | null;
  };
  const proposals: StatsProposal[] = [];
  const eventIds = events.map((event) => event.id);
  for (let index = 0; index < eventIds.length; index += 200) {
    const chunk = eventIds.slice(index, index + 200);
    const result = await admin
      .from("reply_proposals")
      .select("id, reply_event_id, created_at, sentiment, sentiment_type")
      .in("reply_event_id", chunk);
    if (result.error) throw new Error(`Campaign reply stats proposals: ${result.error.message}`);
    proposals.push(...((result.data ?? []) as StatsProposal[]));
  }
  const latest = latestPerEvent(proposals);

  const dayFormatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: workspace.timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const perDayMap = new Map<string, { replies: number; positive: number }>();
  for (const date of localCalendarDates(now, dayFormatter, 30)) {
    perDayMap.set(date, { replies: 0, positive: 0 });
  }

  // Headline counts are per PERSON (one lead replying five times is one reply,
  // one positive); the per-day series stays per reply, since it charts message
  // volume over time. Unlinked senders key off their address so they still count.
  const personKey = (event: StatsEvent) =>
    event.lead_id ??
    (event.from_email?.trim() ? `email:${event.from_email.trim().toLowerCase()}` : `event:${event.id}`);
  const categoriesMap = new Map<string, { people: Set<string>; sentimentType: string }>();
  const repliedPeople = new Set<string>();
  const positivePeople = new Set<string>();
  for (const event of events) {
    const person = personKey(event);
    repliedPeople.add(person);
    const day = dateKey(new Date(event.received_at ?? event.created_at), dayFormatter);
    const bucket = perDayMap.get(day);
    if (bucket) bucket.replies += 1;
    const proposal = latest.get(event.id);
    const type = proposal?.sentiment_type ?? "neutral";
    if (proposal && type === "positive") {
      positivePeople.add(person);
      if (bucket) bucket.positive += 1;
    }
    if (proposal) {
      const label = proposal.sentiment ?? "Uncategorizable";
      const entry = categoriesMap.get(label) ?? { people: new Set<string>(), sentimentType: type };
      entry.people.add(person);
      categoriesMap.set(label, entry);
    }
  }

  return {
    replies30d: repliedPeople.size,
    positive30d: positivePeople.size,
    perDay: [...perDayMap.entries()].map(([date, value]) => ({ date, ...value })),
    categories: [...categoriesMap.entries()]
      .map(([label, value]) => ({ label, count: value.people.size, sentimentType: value.sentimentType }))
      .sort((a, b) => b.count - a.count),
  };
}

export async function getAnalyticsData(filter: AnalyticsFilter = {}): Promise<AnalyticsData> {
  const admin = getAdminClient();
  const now = new Date();
  const days = filter.days ?? 90;
  const campaignFilter = filter.campaigns ?? null;
  const since = new Date(now.getTime() - days * 86_400_000).toISOString();
  const [taxonomy, workspace] = await Promise.all([getTaxonomy(), getWorkspaceSettings()]);

  const [proposals, rawEvents, sendsRes] = await Promise.all([
    fetchNewestRows<{
      id: string;
      reply_event_id: string | null;
      created_at: string;
      sentiment: string | null;
      sentiment_type: string | null;
      is_referral: boolean;
      action_dnc: boolean;
      dnc_reason: string | null;
      status: string;
    }>(
      "reply_proposals",
      "id, reply_event_id, created_at, sentiment, sentiment_type, is_referral, action_dnc, dnc_reason, status",
      since,
      "Analytics proposals query",
    ),
    fetchNewestRows<{
      id: string;
      lead_id: string | null;
      from_email: string | null;
      campaign_id: string | null;
      campaign_name: string | null;
      received_at: string | null;
      created_at: string;
    }>(
      "reply_events",
      "id, lead_id, from_email, campaign_id, campaign_name, received_at, created_at",
      since,
      "Analytics events query",
      QUERY_HARD_CAP,
      true,
    ),
    (async () => {
      const sentCount = async (campaignIds?: string[]) => {
        let query = admin
          .from("reply_sends")
          .select("id", { count: "exact", head: true })
          .eq("status", "sent")
          .gte("created_at", since);
        if (campaignIds) {
          if (campaignIds.length === 0) return { count: 0, error: null };
          query = query.in("campaign_id", campaignIds);
        }
        return query;
      };

      const total = await sentCount();
      if (total.error || !campaignFilter) return total;
      const matching = await sentCount(campaignFilter.ids);
      if (matching.error) return matching;
      return {
        count:
          campaignFilter.mode === "include"
            ? matching.count
            : Math.max(0, (total.count ?? 0) - (matching.count ?? 0)),
        error: null,
      };
    })(),
  ]);
  if (sendsRes.error) throw new Error(`Analytics sends query: ${sendsRes.error.message}`);

  const nowMs = now.getTime();
  // received_at is Smartlead's clock, not ours — allow a little forward skew
  // so a just-arrived reply is never transiently dropped from the counts.
  const FUTURE_SKEW_MS = 10 * 60_000;
  const within = (iso: string, days: number) => {
    const timestamp = new Date(iso).getTime();
    return (
      Number.isFinite(timestamp) && timestamp <= nowMs + FUTURE_SKEW_MS && timestamp >= nowMs - days * 86_400_000
    );
  };
  const eventTimestamp = (event: (typeof rawEvents)[number]) => event.received_at ?? event.created_at;
  const eventsInWindow = rawEvents.filter((event) => within(eventTimestamp(event), days));
  // Filter events before proposals and every derived KPI are joined/counting.
  // Null campaign ids cannot match an include, but remain in exclude views.
  const campaignIds = new Set(campaignFilter?.ids ?? []);
  const events = campaignFilter
    ? eventsInWindow.filter((event) =>
        campaignFilter.mode === "include"
          ? event.campaign_id !== null && campaignIds.has(event.campaign_id)
          : event.campaign_id === null || !campaignIds.has(event.campaign_id),
      )
    : eventsInWindow;
  const eventById = new Map(events.map((event) => [event.id, event]));

  // The identity a KPI counts. lead_id is nullable (a reply from someone with no
  // CRM row), and a plain count(distinct lead_id) would silently DROP those —
  // undercounting real people. Fall back to the sender address, then the event
  // id, so every replier counts exactly once.
  const personKey = (event: (typeof rawEvents)[number]) =>
    event.lead_id ??
    (event.from_email?.trim() ? `email:${event.from_email.trim().toLowerCase()}` : `event:${event.id}`);
  const distinctPeople = (rows: typeof events) => new Set(rows.map(personKey)).size;

  // De-duplicate to the latest proposal per event (regenerations supersede).
  const latestByEvent = latestPerEvent(proposals);
  const unique = [...latestByEvent.values()].filter(
    (proposal) => proposal.reply_event_id !== null && eventById.has(proposal.reply_event_id),
  );

  const dayFormatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: workspace.timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const perDayMap = new Map<string, { positive: number; negative: number; neutral: number }>();
  // Return the complete requested window; the UI may window it further.
  for (const date of localCalendarDates(now, dayFormatter, Math.min(days, 90))) {
    perDayMap.set(date, { positive: 0, negative: 0, neutral: 0 });
  }

  // Each KPI is a SET of people, so a lead who replies repeatedly lands in a
  // bucket once. Membership is ANY-history within the window: a lead who ever
  // replied positively is a positive lead, even if their latest message is an
  // out-of-office autoresponder. (Newest-reply semantics would let that
  // autoresponder erase a genuine positive from the count.)
  const categoriesMap = new Map<string, { people: Set<string>; sentimentType: string }>();
  const categorizedPeople = new Set<string>();
  const positivePeople = new Set<string>();
  const negativePeople = new Set<string>();
  const neutralPeople = new Set<string>();
  const referralPeople = new Set<string>();
  const oooPeople = new Set<string>();
  const dncExplicitPeople = new Set<string>();
  const dncDefunctPeople = new Set<string>();
  const pendingPeople = new Set<string>();
  const approvedPeople = new Set<string>();

  for (const proposal of unique) {
    // `unique` already dropped proposals whose event is outside the window, so
    // this lookup always hits; the guard just keeps the key derivation total.
    const event = proposal.reply_event_id ? eventById.get(proposal.reply_event_id) : undefined;
    if (!event) continue;
    const person = personKey(event);
    const type = proposal.sentiment_type ?? "neutral";
    categorizedPeople.add(person);
    if (type === "positive") positivePeople.add(person);
    else if (type === "negative") negativePeople.add(person);
    else neutralPeople.add(person);
    if (proposal.is_referral) referralPeople.add(person);
    if (taxonomy.fromLabel(proposal.sentiment)?.systemRole === "out_of_office") oooPeople.add(person);
    // "Blocked" KPIs count executed blocks only — approval is what fires them.
    if (proposal.action_dnc && proposal.status === "approved") {
      if (proposal.dnc_reason === "email_defunct") dncDefunctPeople.add(person);
      else dncExplicitPeople.add(person);
    }
    if (proposal.status === "pending") pendingPeople.add(person);
    if (proposal.status === "approved") approvedPeople.add(person);
    const label = proposal.sentiment ?? "Uncategorizable";
    const entry = categoriesMap.get(label) ?? { people: new Set<string>(), sentimentType: type };
    entry.people.add(person);
    categoriesMap.set(label, entry);

    // The per-day chart stays per REPLY — it is labelled "Categorized replies
    // per day" and is a message-volume series, not a people count.
    const day = dateKey(new Date(eventTimestamp(event)), dayFormatter);
    const bucket = perDayMap.get(day);
    if (bucket) {
      if (type === "positive") bucket.positive += 1;
      else if (type === "negative") bucket.negative += 1;
      else bucket.neutral += 1;
    }
  }

  // Campaign breakdown from events; positives via each event's latest proposal.
  // Also per-person. A lead who replied to two campaigns counts once in EACH —
  // correct per campaign, so these columns intentionally don't sum to the tile.
  const campaignMap = new Map<
    string,
    { id: string | null; name: string; replies: Set<string>; positive: Set<string> }
  >();
  for (const event of events) {
    const name = event.campaign_name ?? (event.campaign_id ? `Campaign ${event.campaign_id}` : "Unknown campaign");
    const key = event.campaign_id === null ? `name:${name}` : `id:${event.campaign_id}`;
    const entry =
      campaignMap.get(key) ?? { id: event.campaign_id, name, replies: new Set<string>(), positive: new Set<string>() };
    const person = personKey(event);
    entry.replies.add(person);
    const proposal = latestByEvent.get(event.id);
    if (proposal?.sentiment_type === "positive") entry.positive.add(person);
    campaignMap.set(key, entry);
  }

  return {
    totalReplies: distinctPeople(events),
    replies7d: distinctPeople(events.filter((event) => within(eventTimestamp(event), 7))),
    replies30d: distinctPeople(events.filter((event) => within(eventTimestamp(event), 30))),
    categorizedLeads: categorizedPeople.size,
    pendingCount: pendingPeople.size,
    approvedCount: approvedPeople.size,
    positiveCount: positivePeople.size,
    negativeCount: negativePeople.size,
    neutralCount: neutralPeople.size,
    referralCount: referralPeople.size,
    oooCount: oooPeople.size,
    dncExplicit: dncExplicitPeople.size,
    dncDefunct: dncDefunctPeople.size,
    sentFromInbox: sendsRes.count ?? 0,
    sentFromInboxIsWorkspaceWide: false,
    windowDays: days,
    perDay: [...perDayMap.entries()].map(([date, counts]) => ({ date, ...counts })),
    categories: [...categoriesMap.entries()]
      .map(([label, value]) => ({ label, count: value.people.size, sentimentType: value.sentimentType }))
      .sort((a, b) => b.count - a.count),
    campaigns: [...campaignMap.values()]
      .map((entry) => ({ id: entry.id, name: entry.name, replies: entry.replies.size, positive: entry.positive.size }))
      .sort((a, b) => b.replies - a.replies),
  };
}
