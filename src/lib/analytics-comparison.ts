import "server-only";

import { fetchCampaignAnalyticsRange, fetchCampaignBounceSplit, listCampaigns } from "@/lib/smartlead";
import { getAdminClient } from "@/lib/supabase/admin";

const DAY_MS = 86_400_000;
const PAGE_SIZE = 1000;
const QUERY_HARD_CAP = 10_000;
const PROPOSAL_CHUNK_SIZE = 200;
const PROVIDER_CONCURRENCY = 3;

export type CampaignComparisonRow = {
  id: string;
  name: string;
  status: string | null;
  sent: number | null;
  uniqueSent: number | null; // distinct contacts emailed, per Smartlead (unique within each campaign only)
  replies: number | null;
  bounces: number | null; // combined, as Smartlead's analytics endpoints report it
  leadBounces: number | null; // recipient bounces (Smartlead UI "Bounced")
  senderBounces: number | null; // sending-mailbox failures (Smartlead UI "Sender Bounced")
  replyRatePct: number | null;
  bounceRatePct: number | null; // recipient-bounce rate, matching Smartlead's UI
  senderBounceRatePct: number | null;
  capturedReplies: number;
  positive: number;
  providerError: string | null;
};

type ComparisonEvent = {
  id: string;
  lead_id: string | null;
  from_email: string | null;
  campaign_id: string | null;
  received_at: string | null;
  created_at: string;
};

type ComparisonProposal = {
  id: string;
  reply_event_id: string | null;
  created_at: string;
  sentiment_type: string | null;
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function rate(numerator: number, sent: number): number | null {
  return sent > 0 ? Math.min(100, Math.round((numerator / sent) * 1000) / 10) : null;
}

async function getCapturedStats(startDate: string, now: Date) {
  const admin = getAdminClient();
  const since = `${startDate}T00:00:00.000Z`;
  const events: ComparisonEvent[] = [];
  let totalCount: number | null = null;

  for (let offset = 0; offset < QUERY_HARD_CAP; offset += PAGE_SIZE) {
    const result = await admin
      .from("reply_events")
      .select(
        "id, lead_id, from_email, campaign_id, received_at, created_at",
        offset === 0 ? { count: "exact" } : undefined,
      )
      .gte("created_at", since)
      .eq("metric_eligible", true)
      .order("created_at", { ascending: false })
      .order("id", { ascending: false })
      .range(offset, offset + PAGE_SIZE - 1);
    if (result.error) throw new Error(`Campaign comparison events: ${result.error.message}`);
    if (offset === 0) totalCount = result.count;
    const page = (result.data ?? []) as ComparisonEvent[];
    events.push(...page);
    if (page.length < PAGE_SIZE) break;
  }

  if ((totalCount ?? events.length) > QUERY_HARD_CAP) {
    console.warn(
      `Campaign comparison events: ${totalCount ?? "more than"} rows matched; using the newest ${QUERY_HARD_CAP} by created_at/id.`,
    );
  }

  const startMs = Date.parse(since);
  const maxMs = now.getTime() + 10 * 60_000;
  const windowEvents = events.filter((event) => {
    const timestamp = Date.parse(event.received_at ?? event.created_at);
    return Number.isFinite(timestamp) && timestamp >= startMs && timestamp <= maxMs;
  });

  const proposals: ComparisonProposal[] = [];
  const eventIds = windowEvents.map((event) => event.id);
  for (let index = 0; index < eventIds.length; index += PROPOSAL_CHUNK_SIZE) {
    const result = await admin
      .from("reply_proposals")
      .select("id, reply_event_id, created_at, sentiment_type")
      .in("reply_event_id", eventIds.slice(index, index + PROPOSAL_CHUNK_SIZE));
    if (result.error) throw new Error(`Campaign comparison proposals: ${result.error.message}`);
    proposals.push(...((result.data ?? []) as ComparisonProposal[]));
  }

  const latestByEvent = new Map<string, ComparisonProposal>();
  for (const proposal of proposals) {
    const key = proposal.reply_event_id ?? proposal.id;
    const current = latestByEvent.get(key);
    if (
      !current ||
      proposal.created_at > current.created_at ||
      (proposal.created_at === current.created_at && proposal.id > current.id)
    ) {
      latestByEvent.set(key, proposal);
    }
  }

  // Per-person, matching the KPI tiles: a lead who replied five times to one
  // campaign is one captured reply there, not five. Unlinked senders key off
  // their address so they still count once instead of being dropped.
  const personKey = (event: ComparisonEvent) =>
    event.lead_id ??
    (event.from_email?.trim() ? `email:${event.from_email.trim().toLowerCase()}` : `event:${event.id}`);
  const grouped = new Map<string, { capturedReplies: Set<string>; positive: Set<string> }>();
  for (const event of windowEvents) {
    if (event.campaign_id === null) continue;
    const value = grouped.get(event.campaign_id) ?? { capturedReplies: new Set<string>(), positive: new Set<string>() };
    const person = personKey(event);
    value.capturedReplies.add(person);
    if (latestByEvent.get(event.id)?.sentiment_type === "positive") value.positive.add(person);
    grouped.set(event.campaign_id, value);
  }
  return new Map(
    [...grouped].map(([campaignId, value]) => [
      campaignId,
      { capturedReplies: value.capturedReplies.size, positive: value.positive.size },
    ]),
  );
}

export async function getCampaignComparison(
  days: 7 | 30 | 90,
  filter?: { mode: "include" | "exclude"; ids: string[] } | null,
): Promise<CampaignComparisonRow[]> {
  const now = new Date();
  const endDate = now.toISOString().slice(0, 10);
  const startDate = new Date(now.getTime() - (days - 1) * DAY_MS).toISOString().slice(0, 10);
  const [allCampaigns, capturedByCampaign] = await Promise.all([
    listCampaigns(),
    getCapturedStats(startDate, now),
  ]);
  // Exclude resolves against the FRESH campaign list here, server-side, so the
  // table can never disagree with the other panels' true exclude semantics.
  const ids = filter ? new Set(filter.ids) : null;
  const campaigns =
    ids === null
      ? allCampaigns
      : filter!.mode === "include"
        ? allCampaigns.filter((campaign) => ids.has(campaign.id))
        : allCampaigns.filter((campaign) => !ids.has(campaign.id));
  const rows = new Array<CampaignComparisonRow>(campaigns.length);
  let nextIndex = 0;

  const worker = async () => {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= campaigns.length) return;
      const campaign = campaigns[index];
      const captured = capturedByCampaign.get(campaign.id) ?? { capturedReplies: 0, positive: 0 };
      try {
        const metrics = await fetchCampaignAnalyticsRange(campaign.id, startDate, endDate);
        // The analytics endpoints only report combined bounces; the split
        // (recipient vs sending-mailbox) comes from the bounced statistics
        // rows, exactly how Smartlead's own UI derives it. Anchor the
        // recipient count to the range total so the pair always sums to it.
        let senderBounces = 0;
        if (metrics.bounces > 0) {
          const split = await fetchCampaignBounceSplit(campaign.id, startDate, endDate);
          senderBounces = Math.min(split.senderBounces, metrics.bounces);
        }
        const leadBounces = Math.max(0, metrics.bounces - senderBounces);
        rows[index] = {
          ...campaign,
          ...metrics,
          leadBounces,
          senderBounces,
          replyRatePct: rate(metrics.replies, metrics.sent),
          bounceRatePct: rate(leadBounces, metrics.sent),
          senderBounceRatePct: rate(senderBounces, metrics.sent),
          ...captured,
          providerError: null,
        };
      } catch (error) {
        rows[index] = {
          ...campaign,
          sent: null,
          uniqueSent: null,
          replies: null,
          bounces: null,
          leadBounces: null,
          senderBounces: null,
          replyRatePct: null,
          bounceRatePct: null,
          senderBounceRatePct: null,
          ...captured,
          providerError: errorMessage(error),
        };
      }
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(PROVIDER_CONCURRENCY, campaigns.length) }, () => worker()),
  );

  return rows.sort((a, b) => {
    if (a.sent === null && b.sent !== null) return 1;
    if (a.sent !== null && b.sent === null) return -1;
    if (a.sent !== b.sent) return (b.sent ?? 0) - (a.sent ?? 0);
    return a.name.localeCompare(b.name);
  });
}
