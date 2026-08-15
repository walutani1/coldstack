import "server-only";

import { fetchWorkspaceDayWiseSendStats, type WorkspaceDaySendStats } from "@/lib/smartlead";
import { getAdminClient } from "@/lib/supabase/admin";

const DAY_MS = 86_400_000;

export type SendVolume = {
  /* One entry per day of the window, oldest first (zeros for silent days). */
  perDay: WorkspaceDaySendStats[];
  /* Window totals summed from perDay — matches /analytics/overall-stats-v2. */
  totalSent: number;
  totalBounced: number;
  /* Distinct leads whose latest campaign push falls in the window (see
     migration 058 for the exact semantics), and the all-time count. */
  leadsSent: number;
  leadsSentAllTime: number;
};

async function countLeadsSent(from: string | null, to: string | null): Promise<number> {
  const admin = getAdminClient();
  const result = await admin.rpc("analytics_leads_sent_count", {
    p_from: from,
    p_to: to,
    p_campaign_mode: null,
    p_campaign_ids: null,
  });
  if (result.error) throw new Error(`Leads sent count: ${result.error.message}`);
  return Number(result.data ?? 0);
}

/**
 * Workspace-wide send volume for the global analytics view. Deliberately NOT
 * campaign-filterable: the day-wise Smartlead endpoint only reports the whole
 * workspace, and a section where one tile obeyed the campaign filter while its
 * neighbors ignored it would lie. The filter-aware per-campaign numbers live
 * in the campaign comparison table instead.
 */
export async function getSendVolume(days: 7 | 30 | 90): Promise<SendVolume> {
  const now = new Date();
  const endDate = now.toISOString().slice(0, 10);
  const startDate = new Date(now.getTime() - (days - 1) * DAY_MS).toISOString().slice(0, 10);
  // The leads window matches the day-wise window's start-of-first-day, with a
  // small forward tolerance like the reply queries use.
  const from = `${startDate}T00:00:00.000Z`;
  const to = new Date(now.getTime() + 10 * 60_000).toISOString();

  const [perDay, leadsSent, leadsSentAllTime] = await Promise.all([
    fetchWorkspaceDayWiseSendStats(startDate, endDate),
    countLeadsSent(from, to),
    countLeadsSent(null, null),
  ]);

  return {
    perDay,
    totalSent: perDay.reduce((sum, day) => sum + day.sent, 0),
    totalBounced: perDay.reduce((sum, day) => sum + day.bounced, 0),
    leadsSent,
    leadsSentAllTime,
  };
}
