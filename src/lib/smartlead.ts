import "server-only";
import { getEnv } from "@/lib/env";
import { getSecret } from "@/lib/secrets";
import { getIntegrationSettings } from "@/lib/settings-store";

export type SmartleadMessage = {
  type: string; // "SENT" | "REPLY"
  from: string;
  to: string;
  subject: string;
  email_body: string;
  time: string;
  message_id: string;
  stats_id: string | null;
  cc: string | null;
  bcc: string | null;
};

export type SmartleadLeadLookup = {
  id: string;
  email: string;
  first_name: string | null;
  last_name: string | null;
  company_name: string | null;
};

export type SmartleadCampaignDetail = {
  id: string;
  name: string;
  status: string | null;
  maxLeadsPerDay: number | null;
  minTimeBtwnEmails: number | null;
  trackSettings: unknown;
  scheduleSummary: string | null;
  schedule: {
    timezone: string;
    daysOfTheWeek: number[];
    startHour: string;
    endHour: string;
  } | null;
  stopLeadSettings: string | null;
  tracking: { opens: boolean; clicks: boolean; unknown: string[] };
  sendAsPlainText: boolean;
  unsubscribeText: string;
  followUpPercentage: number | null;
  createdAt: string | null;
};

// Smartlead normalizes tracking enums on write (DONT_TRACK_EMAIL_OPEN is
// stored as DONT_EMAIL_OPEN). Treat aliases as one semantic flag, write the
// live-accepted input form, and PRESERVE unknown members verbatim so a
// future provider enum is never silently dropped.
export type TrackingFlag = "opens" | "clicks";
const TRACK_ALIASES: Record<TrackingFlag, { write: string; reads: string[] }> = {
  opens: { write: "DONT_TRACK_EMAIL_OPEN", reads: ["DONT_TRACK_EMAIL_OPEN", "DONT_EMAIL_OPEN"] },
  clicks: { write: "DONT_TRACK_LINK_CLICK", reads: ["DONT_TRACK_LINK_CLICK", "DONT_LINK_CLICK"] },
};

function trackSettingMembers(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.filter((member): member is string => typeof member === "string");
  if (typeof raw !== "string") return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((member): member is string => typeof member === "string")
      : [];
  } catch {
    return [];
  }
}

export function parseTrackSettings(raw: unknown): { opens: boolean; clicks: boolean; unknown: string[] } {
  const members = trackSettingMembers(raw);
  const recognized = new Set(Object.values(TRACK_ALIASES).flatMap((alias) => alias.reads));
  return {
    opens: !members.some((member) => TRACK_ALIASES.opens.reads.includes(member)),
    clicks: !members.some((member) => TRACK_ALIASES.clicks.reads.includes(member)),
    unknown: members.filter((member) => !recognized.has(member)),
  };
}

export function buildTrackSettings(
  current: unknown,
  next: { opens: boolean; clicks: boolean },
): string[] {
  const settings = [...parseTrackSettings(current).unknown];
  for (const flag of ["opens", "clicks"] as const) {
    if (!next[flag]) settings.push(TRACK_ALIASES[flag].write);
  }
  return settings;
}

export type SmartleadCampaignStatus = "START" | "PAUSED" | "STOPPED";

export type SmartleadCampaignLimitsPatch = {
  maxLeadsPerDay?: number;
  minTimeBtwnEmails?: number;
};

export type CampaignScheduleInput = {
  timezone: string;
  daysOfTheWeek: number[];
  startHour: string;
  endHour: string;
  minTimeBtwnEmails: number;
  maxNewLeadsPerDay: number;
};

export type CampaignGeneralPatch = {
  name?: string;
  stopLeadSettings?: string;
  tracking?: { opens: boolean; clicks: boolean };
  sendAsPlainText?: boolean;
  unsubscribeText?: string;
  /** 0–100: share of daily sends reserved for follow-ups vs new leads. */
  followUpPercentage?: number;
};

export type SequenceVariant = {
  id: number | null;
  label: string | null;
  subject: string;
  emailBody: string;
};

export type SequenceStep = {
  id: number | null;
  seqNumber: number;
  delayInDays: number;
  subject: string;
  emailBody: string;
  variants: SequenceVariant[] | null;
};

// Interactive-path retry: short backoff on rate limits / transient 5xx.
const RETRY_DELAYS_MS = [2_000, 6_000];
const WEBHOOK_NAME = "Coldstack reply intake";
const LEGACY_WEBHOOK_NAMES = ["Scaling Inbox reply intake", "Clay reply intake"];

export async function resolveSmartleadConfig(): Promise<{
  apiKey: string | null;
  baseUrl: string;
  source: "app" | "env" | "none";
}> {
  const [settings, storedApiKey] = await Promise.all([
    getIntegrationSettings(),
    getSecret("smartlead_api_key"),
  ]);
  const appApiKey = storedApiKey?.trim() || null;
  const env = getEnv();
  return {
    apiKey: appApiKey ?? env.SMARTLEAD_API_KEY ?? null,
    baseUrl: settings.smartleadApiBaseUrl ?? env.SMARTLEAD_API_BASE_URL,
    source: appApiKey ? "app" : env.SMARTLEAD_API_KEY ? "env" : "none",
  };
}

function isRetryable(status: number) {
  return status === 429 || (status >= 500 && status <= 504);
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function request(
  path: string,
  options: {
    method?: "GET" | "POST" | "DELETE";
    params?: Record<string, string>;
    body?: unknown;
    retriable?: boolean;
    rejectOkFalse?: boolean;
    rawErrorBody?: boolean;
  } = {},
) {
  const config = await resolveSmartleadConfig();
  if (!config.apiKey) throw new Error("Smartlead API key is not configured.");
  const url = new URL(`${config.baseUrl.replace(/\/$/, "")}${path}`);
  url.searchParams.set("api_key", config.apiKey);
  for (const [key, value] of Object.entries(options.params ?? {})) {
    url.searchParams.set(key, value);
  }

  // Non-idempotent calls (sending mail) must not auto-retry: a timeout after
  // Smartlead dispatched would deliver the same email twice.
  const maxRetries = options.retriable === false ? 0 : RETRY_DELAYS_MS.length;

  for (let attempt = 0; ; attempt += 1) {
    let response: Response;
    try {
      response = await fetch(url, {
        method: options.method ?? "GET",
        headers: options.body !== undefined ? { "Content-Type": "application/json" } : undefined,
        body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
        cache: "no-store",
      });
    } catch (networkError) {
      if (attempt < maxRetries) {
        await sleep(RETRY_DELAYS_MS[attempt]);
        continue;
      }
      throw networkError;
    }

    if (response.ok) {
      const text = await response.text();
      let parsed: unknown;
      try {
        parsed = text ? JSON.parse(text) : null;
      } catch {
        return { message: text.slice(0, 500) };
      }
      if (
        options.rejectOkFalse &&
        parsed &&
        typeof parsed === "object" &&
        "ok" in parsed &&
        (parsed as { ok?: unknown }).ok === false
      ) {
        throw new Error(text.slice(0, 300));
      }
      return parsed;
    }

    if (isRetryable(response.status) && attempt < maxRetries) {
      await sleep(RETRY_DELAYS_MS[attempt]);
      continue;
    }

    const details = await response.text().catch(() => "");
    const errorBody = options.rawErrorBody ? details : details.slice(0, 300);
    throw new Error(`Smartlead ${options.method ?? "GET"} ${path} failed: ${response.status} ${errorBody}`);
  }
}

function coerceArray(json: unknown): Record<string, unknown>[] {
  const value = json as { history?: unknown; data?: { history?: unknown } } | unknown[];
  if (Array.isArray(value)) return value as Record<string, unknown>[];
  if (value && Array.isArray((value as { history?: unknown }).history)) {
    return (value as { history: Record<string, unknown>[] }).history;
  }
  const data = (value as { data?: { history?: unknown } })?.data;
  if (data && Array.isArray(data.history)) return data.history as Record<string, unknown>[];
  return [];
}

function coerceList(json: unknown): Record<string, unknown>[] {
  if (Array.isArray(json)) return json as Record<string, unknown>[];
  if (!json || typeof json !== "object") return [];
  const value = json as { data?: unknown; campaigns?: unknown; webhooks?: unknown };
  for (const candidate of [value.data, value.campaigns, value.webhooks]) {
    if (Array.isArray(candidate)) return candidate as Record<string, unknown>[];
  }
  return [];
}

/** Resolve a Smartlead lead record (and its id) by email address. */
export async function resolveLeadByEmail(email: string): Promise<SmartleadLeadLookup | null> {
  const raw = (await request("/leads/", { params: { email } })) as Record<string, unknown> | null;
  if (!raw || !raw.id) return null;
  return {
    id: String(raw.id),
    email: String(raw.email ?? email),
    first_name: raw.first_name ? String(raw.first_name) : null,
    last_name: raw.last_name ? String(raw.last_name) : null,
    company_name: raw.company_name ? String(raw.company_name) : null,
  };
}

/**
 * Sender display names for a campaign's sending inboxes, keyed by lowercased
 * from_email. This is the name leads actually see on our outbound mail (the
 * message-history API returns bare addresses only).
 */
export async function getCampaignSenderNames(campaignId: string): Promise<Record<string, string>> {
  const raw = await request(`/campaigns/${encodeURIComponent(campaignId)}/email-accounts`);
  const names: Record<string, string> = {};
  for (const account of coerceArray(raw)) {
    const email = account.from_email ? String(account.from_email).trim().toLowerCase() : "";
    const name = account.from_name ? String(account.from_name).trim() : "";
    if (email && name) names[email] = name;
  }
  return names;
}

/** The campaign's sending accounts (from_email + from_name), deduped by email
 *  — the identities leads actually see on our outbound mail. Unlike
 *  getCampaignSenderNames, accounts without a from_name are kept. */
export async function getCampaignSenderAccounts(
  campaignId: string,
): Promise<{ email: string; name: string | null }[]> {
  const raw = await request(`/campaigns/${encodeURIComponent(campaignId)}/email-accounts`);
  const seen = new Map<string, { email: string; name: string | null }>();
  for (const account of coerceArray(raw)) {
    const email = account.from_email ? String(account.from_email).trim().toLowerCase() : "";
    if (!email || seen.has(email)) continue;
    const name = account.from_name ? String(account.from_name).trim() : "";
    seen.set(email, { email, name: name || null });
  }
  return [...seen.values()];
}

export type SmartleadSequenceEmail = {
  step: number;
  subject: string;
  body: string;
  /* Subject+body of every active variant for an A/B-tested step (present only
     when the step has variants), so QA/mapping detect variables used in a variant
     that is not the one shown - including a variant's own subject line. */
  variantTexts?: string[];
};

/** The campaign's email sequence (subject + HTML body per step, with {{variable}}
 *  and {spintax} intact), ordered by step. This is the exact copy Smartlead will
 *  send, so the QA column previews and checks against the live template.
 *
 *  A step running an A/B test keeps its copy in `sequence_variants` and leaves the
 *  top-level `email_body` empty; we fall back to the first active variant so the
 *  preview never shows a blank email, and expose every active variant body so the
 *  variable check covers all of them. Deleted or empty variants are ignored. */
export async function getCampaignSequences(campaignId: string): Promise<SmartleadSequenceEmail[]> {
  const raw = await request(`/campaigns/${encodeURIComponent(campaignId)}/sequences`);
  return coerceArray(raw)
    .map((s) => {
      const topSubject = String(s.subject ?? "");
      const topBody = String(s.email_body ?? "");
      const activeVariants = (Array.isArray(s.sequence_variants) ? s.sequence_variants : [])
        .filter((v): v is Record<string, unknown> => Boolean(v) && typeof v === "object" && !(v as Record<string, unknown>).is_deleted)
        .map((v) => ({ subject: String(v.subject ?? ""), body: String(v.email_body ?? "") }))
        .filter((v) => v.body.trim().length > 0);
      const useVariant = topBody.trim().length === 0 && activeVariants.length > 0;
      return {
        step: Number(s.seq_number ?? 0),
        subject: useVariant ? activeVariants[0].subject || topSubject : topSubject,
        body: useVariant ? activeVariants[0].body : topBody,
        variantTexts: activeVariants.length ? activeVariants.map((v) => `${v.subject}\n${v.body}`) : undefined,
      };
    })
    .sort((a, b) => a.step - b.step);
}

/** Full message thread (sent + replies) for a lead in a campaign, oldest first. */
export async function getMessageHistory(campaignId: string, smartleadLeadId: string): Promise<SmartleadMessage[]> {
  const raw = await request(
    `/campaigns/${encodeURIComponent(campaignId)}/leads/${encodeURIComponent(smartleadLeadId)}/message-history`,
  );
  const history = coerceArray(raw).map((m) => ({
    type: String(m.type ?? ""),
    from: String(m.from ?? ""),
    to: String(m.to ?? ""),
    subject: String(m.subject ?? ""),
    email_body: String(m.email_body ?? ""),
    time: String(m.time ?? ""),
    message_id: String(m.message_id ?? ""),
    stats_id: m.stats_id != null ? String(m.stats_id) : m.email_stats_id != null ? String(m.email_stats_id) : null,
    cc: m.cc != null ? String(m.cc) : null,
    bcc: m.bcc != null ? String(m.bcc) : null,
  }));

  // Defensive: downstream code assumes oldest-first; don't rely on Smartlead's
  // implicit ordering. Unparseable times sort to the front (stable).
  return history.sort((a, b) => {
    const ta = new Date(a.time).getTime();
    const tb = new Date(b.time).getTime();
    return (Number.isFinite(ta) ? ta : 0) - (Number.isFinite(tb) ? tb : 0);
  });
}

/**
 * Add emails (or domains) to Smartlead's global block list (DNC). Passing a
 * bare email blocks just that address account-wide — not the whole domain.
 */
export async function addToGlobalBlockList(entries: string[]) {
  const clean = entries.map((entry) => entry.trim()).filter(Boolean);
  if (clean.length === 0) return { ok: true as const, raw: null };
  const raw = await request("/leads/add-domain-block-list", {
    method: "POST",
    body: { domain_block_list: clean, client_id: null },
  });
  return { ok: true as const, raw };
}

/** Reply within an existing Smartlead thread (sends from the campaign inbox). */
export async function sendReply(input: {
  campaignId: string;
  emailStatsId: string;
  bodyHtml: string;
  replyMessageId: string;
  replyEmailTime: string;
  cc?: string;
  bcc?: string;
}) {
  return request(`/campaigns/${encodeURIComponent(input.campaignId)}/reply-email-thread`, {
    method: "POST",
    retriable: false,
    body: {
      email_stats_id: input.emailStatsId,
      email_body: input.bodyHtml,
      reply_message_id: input.replyMessageId,
      reply_email_time: input.replyEmailTime,
      cc: input.cc || undefined,
      bcc: input.bcc || undefined,
      add_signature: false,
    },
  });
}

export type SmartleadGlobalCategory = { id: number; name: string; sentimentType: string };

let categoryCache: SmartleadGlobalCategory[] | null = null;

/** Smartlead's canonical reply categories, cached per instance. */
export async function fetchReplyCategories(): Promise<SmartleadGlobalCategory[]> {
  if (!categoryCache) {
    const raw = await request("/leads/fetch-categories");
    const parsed = (Array.isArray(raw) ? raw : [])
      .map((c: Record<string, unknown>) => ({
        id: Number(c.id),
        name: String(c.name ?? ""),
        sentimentType: String(c.sentiment_type ?? ""),
      }))
      .filter((c) => Number.isFinite(c.id) && c.name);
    // Never cache a malformed/empty response — that would silently disable
    // tag sync and OOO pausing until the instance recycles.
    if (parsed.length === 0) return [];
    categoryCache = parsed;
  }
  return categoryCache;
}

export async function listSmartleadCategories(): Promise<SmartleadGlobalCategory[]> {
  return fetchReplyCategories();
}

/** Match one of our category labels to Smartlead's category id. */
export function resolveSmartleadCategoryId(categories: { id: number; name: string }[], label: string): number | null {
  const normalized = label.trim().toLowerCase();
  const exact = categories.find((c) => c.name.toLowerCase() === normalized);
  if (exact) return exact.id;
  // Ours says "Uncategorizable"; Smartlead names it "Uncategorizable by Ai".
  if (normalized.startsWith("uncategorizable")) {
    return categories.find((c) => c.name.toLowerCase().startsWith("uncategorizable"))?.id ?? null;
  }
  return null;
}

/** Set the lead's reply category inside Smartlead (mirrors our approved tag). */
export async function updateLeadCategory(input: {
  campaignId: string;
  smartleadLeadId: string;
  categoryId: number;
  pauseLead: boolean;
}) {
  return request(
    `/campaigns/${encodeURIComponent(input.campaignId)}/leads/${encodeURIComponent(input.smartleadLeadId)}/category`,
    {
      method: "POST",
      body: { category_id: input.categoryId, pause_lead: input.pauseLead },
      rejectOkFalse: true,
    },
  );
}

/** Resume a paused lead's sequence (used after an OOO wait elapses). */
export async function resumeLead(campaignId: string, smartleadLeadId: string) {
  return request(
    `/campaigns/${encodeURIComponent(campaignId)}/leads/${encodeURIComponent(smartleadLeadId)}/resume`,
    { method: "POST", body: {}, rejectOkFalse: true },
  );
}

export async function pauseCampaignLead(campaignId: string, leadId: string): Promise<void> {
  await request(
    `/campaigns/${encodeURIComponent(campaignId)}/leads/${encodeURIComponent(leadId)}/pause`,
    { method: "POST", body: {}, rejectOkFalse: true },
  );
}

export async function unsubscribeCampaignLead(campaignId: string, leadId: string): Promise<void> {
  await request(
    `/campaigns/${encodeURIComponent(campaignId)}/leads/${encodeURIComponent(leadId)}/unsubscribe`,
    { method: "POST", body: {}, rejectOkFalse: true },
  );
}

export async function removeCampaignLead(campaignId: string, leadId: string): Promise<void> {
  await request(
    `/campaigns/${encodeURIComponent(campaignId)}/leads/${encodeURIComponent(leadId)}`,
    { method: "DELETE", rejectOkFalse: true },
  );
}

export async function setCampaignLeadCategory(
  campaignId: string,
  leadId: string,
  categoryId: number,
  pauseLead: boolean,
): Promise<void> {
  await updateLeadCategory({
    campaignId,
    smartleadLeadId: leadId,
    categoryId,
    pauseLead,
  });
}

export async function listCampaignWebhooks(campaignId: string) {
  return request(`/campaigns/${encodeURIComponent(campaignId)}/webhooks`);
}

export type CampaignRangeAnalytics = {
  sent: number;
  uniqueSent: number;
  opens: number;
  clicks: number;
  replies: number;
  bounces: number;
  unsubscribed: number;
};

export type CampaignAnalyticsSummary = {
  sent: number;
  uniqueSent: number;
  opens: number;
  clicks: number;
  replies: number;
  bounces: number;
  unsubscribed: number;
  totalLeads: number;
  drafted: number;
  sequenceCount: number | null;
  leadStats: {
    total: number;
    notStarted: number;
    inProgress: number;
    paused: number;
    completed: number;
    stopped: number;
    blocked: number;
    interested: number;
  } | null;
};

/**
 * All-time campaign analytics. Live-verified shape from
 * GET /campaigns/{id}/analytics: string counts (sent_count, reply_count,
 * bounce_count, total_count, drafted_count, unsubscribed_count, open_count,
 * click_count, sequence_count) plus campaign_lead_stats
 * { total, notStarted, inprogress, paused, completed, stopped, blocked,
 *   interested } as numbers.
 */
export async function fetchCampaignAnalyticsSummary(campaignId: string): Promise<CampaignAnalyticsSummary> {
  const raw = await request(`/campaigns/${encodeURIComponent(campaignId)}/analytics`);
  const data = (unwrapObjectData(raw) ?? {}) as Record<string, unknown>;
  const stats =
    data.campaign_lead_stats && typeof data.campaign_lead_stats === "object" && !Array.isArray(data.campaign_lead_stats)
      ? (data.campaign_lead_stats as Record<string, unknown>)
      : null;
  return {
    sent: integerOrDefault(data.sent_count, 0),
    uniqueSent: integerOrDefault(data.unique_sent_count, 0),
    opens: integerOrDefault(data.open_count, 0),
    clicks: integerOrDefault(data.click_count, 0),
    replies: integerOrDefault(data.reply_count, 0),
    bounces: integerOrDefault(data.bounce_count, 0),
    unsubscribed: integerOrDefault(data.unsubscribed_count, 0),
    totalLeads: integerOrDefault(data.total_count, 0),
    drafted: integerOrDefault(data.drafted_count, 0),
    sequenceCount: integerOrNull(data.sequence_count),
    leadStats: stats
      ? {
          total: integerOrDefault(stats.total, 0),
          notStarted: integerOrDefault(stats.notStarted, 0),
          inProgress: integerOrDefault(stats.inprogress, 0),
          paused: integerOrDefault(stats.paused, 0),
          completed: integerOrDefault(stats.completed, 0),
          stopped: integerOrDefault(stats.stopped, 0),
          blocked: integerOrDefault(stats.blocked, 0),
          interested: integerOrDefault(stats.interested, 0),
        }
      : null,
  };
}

/**
 * Aggregate campaign analytics for a date range (YYYY-MM-DD, inclusive).
 * Live-verified: GET /campaigns/{id}/analytics-by-date returns the full
 * counter set as strings (sent_count, unique_sent_count, open_count,
 * click_count, reply_count, bounce_count, unsubscribed_count, …).
 */
export async function fetchCampaignAnalyticsRange(
  campaignId: string,
  startDate: string,
  endDate: string,
): Promise<CampaignRangeAnalytics> {
  const raw = await request(`/campaigns/${encodeURIComponent(campaignId)}/analytics-by-date`, {
    params: { start_date: startDate, end_date: endDate },
  });
  const data = (unwrapObjectData(raw) ?? {}) as Record<string, unknown>;
  return {
    sent: integerOrDefault(data.sent_count, 0),
    uniqueSent: integerOrDefault(data.unique_sent_count, 0),
    opens: integerOrDefault(data.open_count, 0),
    clicks: integerOrDefault(data.click_count, 0),
    replies: integerOrDefault(data.reply_count, 0),
    bounces: integerOrDefault(data.bounce_count, 0),
    unsubscribed: integerOrDefault(data.unsubscribed_count, 0),
  };
}

export type WorkspaceDaySendStats = {
  /** ISO date (YYYY-MM-DD), one entry per day of the requested range. */
  date: string;
  sent: number;
  opened: number;
  replied: number;
  bounced: number;
  unsubscribed: number;
};

const DAY_MONTH_ABBREVS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

/**
 * Workspace-wide per-day send stats across ALL campaigns (YYYY-MM-DD range,
 * inclusive). Live-verified shape from GET /analytics/day-wise-overall-stats:
 * { data: { day_wise_stats: [ { date: "21 Jul", day_name, email_engagement_metrics:
 *   { sent, opened, replied, bounced, unsubscribed } } ] } } — numbers, not
 * strings, unlike the per-campaign analytics endpoints. The sibling
 * /analytics/overall-stats-v2 window aggregate matched this endpoint's sum
 * exactly on live data, so callers derive totals by summing instead of a
 * second call. (/analytics/campaign/overall-stats silently ignores its date
 * params on live data — do not use it.)
 *
 * The API returns year-less dates ("21 Jul"), so rows are re-keyed against the
 * requested range locally; a day the API omits reads as zeros. Ranges are
 * capped at 366 days, past which day+month keys would collide.
 */
export async function fetchWorkspaceDayWiseSendStats(
  startDate: string,
  endDate: string,
): Promise<WorkspaceDaySendStats[]> {
  const startMs = Date.parse(`${startDate}T00:00:00Z`);
  const endMs = Date.parse(`${endDate}T00:00:00Z`);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || startMs > endMs) {
    throw new Error("Invalid day-wise stats range.");
  }
  if (endMs - startMs > 366 * 86_400_000) throw new Error("Day-wise stats range is limited to a year.");

  const raw = await request("/analytics/day-wise-overall-stats", {
    params: { start_date: startDate, end_date: endDate },
  });
  const data = unwrapObjectData(raw) ?? {};
  const rows = Array.isArray(data.day_wise_stats) ? (data.day_wise_stats as Record<string, unknown>[]) : [];

  // "21 Jul" → "21 Jul" but tolerate zero-padded days; unknown labels are
  // skipped rather than guessed.
  const byDayMonth = new Map<string, Record<string, unknown>>();
  for (const row of rows) {
    const match = /^(\d{1,2})\s+([A-Za-z]{3})/.exec(String(row.date ?? "").trim());
    if (!match) continue;
    byDayMonth.set(`${Number(match[1])} ${match[2]}`, row);
  }

  const days: WorkspaceDaySendStats[] = [];
  for (let ms = startMs; ms <= endMs; ms += 86_400_000) {
    const day = new Date(ms);
    const key = `${day.getUTCDate()} ${DAY_MONTH_ABBREVS[day.getUTCMonth()]}`;
    const metrics =
      byDayMonth.get(key)?.email_engagement_metrics && typeof byDayMonth.get(key)?.email_engagement_metrics === "object"
        ? (byDayMonth.get(key)!.email_engagement_metrics as Record<string, unknown>)
        : null;
    days.push({
      date: day.toISOString().slice(0, 10),
      sent: integerOrDefault(metrics?.sent, 0),
      opened: integerOrDefault(metrics?.opened, 0),
      replied: integerOrDefault(metrics?.replied, 0),
      bounced: integerOrDefault(metrics?.bounced, 0),
      unsubscribed: integerOrDefault(metrics?.unsubscribed, 0),
    });
  }
  return days;
}

/**
 * Split a campaign's bounces into recipient bounces and sender bounces the
 * way Smartlead's own UI does. Live-verified: GET /campaigns/{id}/statistics
 * with email_status=bounced returns one row per bounced message; rows whose
 * lead_category is "Sender Originated Bounce" are the sender-side failures
 * (mailbox problems), the rest are recipient bounces. The analytics
 * endpoints only expose the combined bounce_count.
 */
export type CampaignBounceSplit = { total: number; senderBounces: number; leadBounces: number };

export type CampaignStatisticsKind = "sent" | "opened" | "clicked" | "replied" | "unsubscribed" | "bounced";
export type CampaignStatisticsRow = {
  statsId: string; leadName: string; leadEmail: string; leadCategory: string | null;
  sentTime: string | null; openTime: string | null; replyTime: string | null;
  subject: string | null; isBounced: boolean; bounceType: "recipient" | "sender" | null;
};

export async function fetchCampaignStatisticsRows(campaignId: string, kind: CampaignStatisticsKind, offset = 0): Promise<{ rows: CampaignStatisticsRow[]; total: number }> {
  // Start paging AT the requested offset (Load more must not re-walk the
  // provider from zero on every click); the client dedupes across appends.
  const limit=100; const seen=new Set<string>(); const collected: CampaignStatisticsRow[]=[]; let total=0;
  const start=Math.floor(offset/limit)*limit;
  for (let pageOffset=start; pageOffset < offset + 200; pageOffset += limit) {
    const params: Record<string,string>={ offset:String(pageOffset), limit:String(limit) };
    if (kind !== "sent") params.email_status=kind;
    const raw=await request(`/campaigns/${encodeURIComponent(campaignId)}/statistics`,{params});
    const envelope=raw && typeof raw === "object" ? raw as Record<string,unknown> : {};
    const rows=Array.isArray(envelope.data) ? envelope.data as Record<string,unknown>[] : [];
    const stats=envelope.total_stats;
    if (typeof stats === "number" || typeof stats === "string") total=integerOrDefault(stats,total);
    else if (stats && typeof stats === "object") {
      const record=stats as Record<string,unknown>;
      total=integerOrDefault(record.total ?? record[`${kind}_count`] ?? record.sent_count,total);
    }
    for (const row of rows) {
      const id=String(row.stats_id ?? row.id ?? `${row.lead_email ?? ""}:${row.sent_time ?? ""}:${row.subject ?? ""}`);
      if (seen.has(id)) continue; seen.add(id);
      const category=typeof row.lead_category === "string" ? row.lead_category : null;
      collected.push({ statsId:id, leadName:String(row.lead_name ?? row.name ?? "Unknown"), leadEmail:String(row.lead_email ?? row.email ?? ""), leadCategory:category,
        sentTime:typeof row.sent_time === "string"?row.sent_time:null, openTime:typeof row.open_time === "string"?row.open_time:null,
        replyTime:typeof row.reply_time === "string"?row.reply_time:null, subject:typeof row.subject === "string"?row.subject:null,
        isBounced:kind === "bounced", bounceType:kind === "bounced" ? (category === "Sender Originated Bounce" ? "sender" : "recipient") : null });
    }
    if (rows.length < limit) break;
  }
  return { rows:collected.slice(offset-start,offset-start+200), total: total || collected.length };
}

/**
 * All statistics rows for a kind whose relevant timestamp falls inside a
 * YYYY-MM-DD range (inclusive). The /statistics endpoint rejects date params
 * (live-verified 400 "start_date is not allowed"), so this walks the pages
 * and filters in our code — the fetchCampaignBounceSplit idiom. The kind's
 * clock: opened→open_time, clicked→click_time, everything else (sent,
 * bounced, unsubscribed) → sent_time, matching the bounce split's convention.
 * Returns every matching row up to the caps; when `truncated` is true the
 * total reflects only what was scanned, not the full window.
 */
export async function fetchCampaignStatisticsRowsInRange(
  campaignId: string,
  kind: CampaignStatisticsKind,
  startDate: string,
  endDate: string,
): Promise<{ rows: CampaignStatisticsRow[]; total: number; truncated: boolean }> {
  const limit = 100;
  // Unlike the bounce split (bounces are inherently few), a "sent" scan can
  // meet tens of thousands of rows; both caps below bound the request count
  // so one drill click can never walk the provider for minutes.
  const MAX_ROWS = 1000;
  const MAX_PAGES = 60;
  let truncated = false;
  const timeKey = kind === "opened" ? "open_time" : kind === "clicked" ? "click_time" : "sent_time";
  const seen = new Set<string>();
  const collected: CampaignStatisticsRow[] = [];
  for (let page = 0; page < MAX_PAGES; page += 1) {
    if (collected.length >= MAX_ROWS) {
      truncated = true;
      break;
    }
    const params: Record<string, string> = { offset: String(page * limit), limit: String(limit) };
    if (kind !== "sent") params.email_status = kind;
    const raw = await request(`/campaigns/${encodeURIComponent(campaignId)}/statistics`, { params });
    // Read `data` off the RAW response: unwrapObjectData drops arrays.
    const envelope = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
    const rows = Array.isArray(envelope.data) ? (envelope.data as Record<string, unknown>[]) : [];
    for (const row of rows) {
      const day = typeof row[timeKey] === "string" ? (row[timeKey] as string).slice(0, 10) : null;
      if (!day || day < startDate || day > endDate) continue;
      const id = String(row.stats_id ?? row.id ?? `${row.lead_email ?? ""}:${row.sent_time ?? ""}:${row.subject ?? ""}`);
      if (seen.has(id)) continue;
      seen.add(id);
      const category = typeof row.lead_category === "string" ? row.lead_category : null;
      collected.push({
        statsId: id,
        leadName: String(row.lead_name ?? row.name ?? "Unknown"),
        leadEmail: String(row.lead_email ?? row.email ?? ""),
        leadCategory: category,
        sentTime: typeof row.sent_time === "string" ? row.sent_time : null,
        openTime: typeof row.open_time === "string" ? row.open_time : null,
        replyTime: typeof row.reply_time === "string" ? row.reply_time : null,
        subject: typeof row.subject === "string" ? row.subject : null,
        isBounced: kind === "bounced",
        bounceType: kind === "bounced" ? (category === "Sender Originated Bounce" ? "sender" : "recipient") : null,
      });
    }
    if (rows.length < limit) break;
    if (page === MAX_PAGES - 1) truncated = true;
  }
  return { rows: collected, total: collected.length, truncated };
}

export async function fetchCampaignBounceSplit(
  campaignId: string,
  startDate?: string,
  endDate?: string,
): Promise<CampaignBounceSplit> {
  const limit = 100;
  let total = 0;
  let senderBounces = 0;
  // Page to exhaustion; the safety cap (10k rows) is far above any real
  // campaign's bounce count, so a range filter never sees a truncated scan.
  for (let page = 0; page < 100; page += 1) {
    const raw = await request(`/campaigns/${encodeURIComponent(campaignId)}/statistics`, {
      params: { email_status: "bounced", offset: String(page * limit), limit: String(limit) },
    });
    // Read `data` off the RAW response: unwrapObjectData would unwrap the
    // rows array itself and lose it (it returns objects only).
    const envelope = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
    const rows = Array.isArray(envelope.data) ? (envelope.data as Record<string, unknown>[]) : [];
    for (const row of rows) {
      // Range filter on the send date (YYYY-MM-DD inclusive), matching how
      // the analytics-by-date range is expressed.
      const sentDay = typeof row.sent_time === "string" ? row.sent_time.slice(0, 10) : null;
      if (startDate && (!sentDay || sentDay < startDate)) continue;
      if (endDate && (!sentDay || sentDay > endDate)) continue;
      total += 1;
      if (row.lead_category === "Sender Originated Bounce") senderBounces += 1;
    }
    if (rows.length < limit) break;
  }
  return { total, senderBounces, leadBounces: Math.max(0, total - senderBounces) };
}

// The campaign roster is read on almost every navigation (filters, pickers,
// export targets) but changes rarely; a short process-local cache absorbs the
// sequential pagination cost. Mutations that change the roster invalidate it.
let campaignsCache: { expiresAt: number; rows: { id: string; name: string; status: string | null; createdAt: string | null }[] } | null = null;
const CAMPAIGNS_CACHE_MS = 60_000;

export function invalidateCampaignsCache(): void {
  campaignsCache = null;
}

export async function listCampaigns(): Promise<{ id: string; name: string; status: string | null; createdAt: string | null }[]> {
  if (campaignsCache && campaignsCache.expiresAt > Date.now()) return campaignsCache.rows;
  const rows = await listCampaignsUncached();
  campaignsCache = { expiresAt: Date.now() + CAMPAIGNS_CACHE_MS, rows };
  return rows;
}

async function listCampaignsUncached(): Promise<{ id: string; name: string; status: string | null; createdAt: string | null }[]> {
  const limit = 100;
  const campaigns: { id: string; name: string; status: string | null; createdAt: string | null }[] = [];
  const seen = new Set<string>();
  for (let page = 0; page < 30; page += 1) {
    const raw = await request("/campaigns", {
      params: { offset: String(page * limit), limit: String(limit) },
    });
    const rows = coerceList(raw);
    let added = 0;
    for (const campaign of rows) {
      if (campaign.id == null) continue;
      const id = String(campaign.id);
      if (seen.has(id)) continue;
      seen.add(id);
      campaigns.push({
        id,
        name: String(campaign.name ?? `Campaign ${campaign.id}`),
        status: campaign.status == null ? null : String(campaign.status),
        createdAt: typeof campaign.created_at === "string" ? campaign.created_at : null,
      });
      added += 1;
    }
    if (rows.length < limit || added === 0) break;
  }
  return campaigns;
}

export async function createCampaign(name: string): Promise<{ id: string }> {
  const response = await request("/campaigns/create", {
    method: "POST",
    body: { name },
    retriable: false,
    rejectOkFalse: true,
  });
  const campaign = unwrapObjectData(response);
  if (!campaign || campaign.id == null) {
    throw new Error(`Smartlead returned an invalid campaign creation response: ${writeResponseBody(response)}`);
  }
  invalidateCampaignsCache();
  return { id: String(campaign.id) };
}

export async function createCampaignSchedule(
  campaignId: string,
  schedule: CampaignScheduleInput,
): Promise<void> {
  await request(`/campaigns/${encodeURIComponent(campaignId)}/schedule`, {
    method: "POST",
    body: {
      timezone: schedule.timezone,
      days_of_the_week: schedule.daysOfTheWeek,
      start_hour: schedule.startHour,
      end_hour: schedule.endHour,
      min_time_btw_emails: schedule.minTimeBtwnEmails,
      max_new_leads_per_day: schedule.maxNewLeadsPerDay,
    },
    rejectOkFalse: true,
  });
}

export async function updateCampaignScheduleWindow(
  campaignId: string,
  window: { timezone: string; daysOfTheWeek: number[]; startHour: string; endHour: string },
): Promise<void> {
  const response = await request(`/campaigns/${encodeURIComponent(campaignId)}`);
  const campaign = unwrapObjectData(response);
  if (!campaign) {
    throw new Error(`Smartlead returned an invalid campaign detail: ${writeResponseBody(response)}`);
  }
  // A campaign that never had a schedule reads back null limits; substitute
  // the wizard defaults rather than posting nulls the API may reject.
  const minTime = integerOrNull(campaign.min_time_btwn_emails) ?? 30;
  const maxLeads = integerOrNull(campaign.max_leads_per_day) ?? 20;
  await request(`/campaigns/${encodeURIComponent(campaignId)}/schedule`, {
    method: "POST",
    body: {
      timezone: window.timezone,
      days_of_the_week: window.daysOfTheWeek,
      start_hour: window.startHour,
      end_hour: window.endHour,
      min_time_btw_emails: minTime,
      max_new_leads_per_day: maxLeads,
    },
    rejectOkFalse: true,
  });
}

export async function addCampaignInboxes(campaignId: string, accountIds: number[]): Promise<void> {
  if (accountIds.length === 0) return;
  await request(`/campaigns/${encodeURIComponent(campaignId)}/email-accounts`, {
    method: "POST",
    body: { email_account_ids: accountIds },
    rejectOkFalse: true,
  });
}

export async function removeCampaignInboxes(campaignId: string, accountIds: number[]): Promise<void> {
  if (accountIds.length === 0) return;
  await request(`/campaigns/${encodeURIComponent(campaignId)}/email-accounts`, {
    method: "DELETE",
    body: { email_account_ids: accountIds },
    rejectOkFalse: true,
  });
}

/**
 * Update a sending account's daily limit. Verified with a no-op live write:
 * POST /email-accounts/{id}/ with max_email_per_day is honored and reads back
 * as message_per_day.
 */
export async function updateInboxDailyLimit(accountId: number, maxEmailPerDay: number): Promise<void> {
  await request(`/email-accounts/${encodeURIComponent(String(accountId))}/`, {
    method: "POST",
    body: { max_email_per_day: maxEmailPerDay },
    rejectOkFalse: true,
  });
}

export type InboxIdentityPatch = {
  fromName?: string;
  signature?: string;
  bcc?: string;
  customTrackingUrl?: string;
  timeToWaitMins?: number;
};

/** Update only the provided sending-identity fields on an email account. */
export async function updateInboxIdentity(accountId: number, patch: InboxIdentityPatch): Promise<void> {
  const body: Record<string, unknown> = {};
  if (patch.fromName !== undefined) body.from_name = patch.fromName;
  if (patch.signature !== undefined) body.signature = patch.signature;
  if (patch.bcc !== undefined) body.bcc = patch.bcc;
  if (patch.customTrackingUrl !== undefined) body.custom_tracking_url = patch.customTrackingUrl;
  if (patch.timeToWaitMins !== undefined) body.time_to_wait_in_mins = patch.timeToWaitMins;
  if (Object.keys(body).length === 0) throw new Error("Inbox identity patch cannot be empty.");

  await request(`/email-accounts/${encodeURIComponent(String(accountId))}/`, {
    method: "POST",
    body,
    rejectOkFalse: true,
  });
}

/**
 * Update an account's warmup settings. Verified live: POST
 * /email-accounts/{id}/warmup with warmup_enabled/total_warmup_per_day/
 * reply_rate_percentage. daily_rampup is intentionally not sent — its current
 * value is not readable, so writing a guess would silently change ramp
 * behavior.
 */
export async function updateInboxWarmup(
  accountId: number,
  settings: { enabled: boolean; totalPerDay: number; replyRatePercent: number; warmupKey?: string },
): Promise<void> {
  await request(`/email-accounts/${encodeURIComponent(String(accountId))}/warmup`, {
    method: "POST",
    body: {
      warmup_enabled: settings.enabled,
      total_warmup_per_day: settings.totalPerDay,
      reply_rate_percentage: settings.replyRatePercent,
      // warmup_key_id is the identifier tag stamped on warmup emails
      // (live-verified: any string is accepted; Smartlead's own generator
      // uses two five-letter words, e.g. "group-broth").
      ...(settings.warmupKey ? { warmup_key_id: settings.warmupKey } : {}),
    },
    rejectOkFalse: true,
  });
}

export async function deleteCampaign(campaignId: string): Promise<void> {
  await request(`/campaigns/${encodeURIComponent(campaignId)}`, {
    method: "DELETE",
    rejectOkFalse: true,
  });
  invalidateCampaignsCache();
}

function nullableNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function integerOrNull(value: unknown): number | null {
  const number = nullableNumber(value);
  return number !== null && Number.isInteger(number) && number >= 0 ? number : null;
}

function integerOrDefault(value: unknown, fallback: number): number {
  const number = nullableNumber(value);
  return number !== null && Number.isInteger(number) && number >= 0 ? number : fallback;
}

function stringOrEmpty(value: unknown): string {
  return value == null ? "" : String(value);
}

function writeResponseBody(raw: unknown): string {
  if (typeof raw === "string") return raw;
  try {
    return JSON.stringify(raw);
  } catch {
    return String(raw);
  }
}

function unwrapObjectData(response: unknown): Record<string, unknown> | null {
  const raw =
    response && typeof response === "object" && !Array.isArray(response) && "data" in response
      ? ((response as { data?: unknown }).data ?? response)
      : response;
  return raw && typeof raw === "object" && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : null;
}

function jsonValueSummary(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function normalizeCampaignSchedule(value: unknown): SmartleadCampaignDetail["schedule"] {
  let parsed = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value);
    } catch {
      return null;
    }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const cron = parsed as Record<string, unknown>;
  if (
    typeof cron.tz !== "string" ||
    !Array.isArray(cron.days) ||
    !cron.days.every((day) => Number.isInteger(day)) ||
    typeof cron.startHour !== "string" ||
    typeof cron.endHour !== "string"
  ) {
    return null;
  }
  return {
    timezone: cron.tz,
    daysOfTheWeek: cron.days as number[],
    startHour: cron.startHour,
    endHour: cron.endHour,
  };
}

export async function fetchCampaignDetail(campaignId: string): Promise<SmartleadCampaignDetail> {
  const response = await request(`/campaigns/${encodeURIComponent(campaignId)}`);
  const campaign = unwrapObjectData(response);
  if (!campaign) {
    throw new Error(`Smartlead returned an invalid campaign detail: ${writeResponseBody(response)}`);
  }
  const trackSettings = campaign.track_settings ?? null;
  return {
    id: String(campaign.id ?? campaignId),
    name: String(campaign.name ?? `Campaign ${campaignId}`),
    status: campaign.status == null ? null : String(campaign.status),
    maxLeadsPerDay: nullableNumber(campaign.max_leads_per_day),
    minTimeBtwnEmails: nullableNumber(campaign.min_time_btwn_emails),
    trackSettings,
    scheduleSummary: jsonValueSummary(campaign.scheduler_cron_value),
    schedule: normalizeCampaignSchedule(campaign.scheduler_cron_value),
    stopLeadSettings: campaign.stop_lead_settings == null ? null : String(campaign.stop_lead_settings),
    tracking: parseTrackSettings(trackSettings),
    sendAsPlainText: campaign.send_as_plain_text === true,
    unsubscribeText: stringOrEmpty(campaign.unsubscribe_text),
    followUpPercentage: nullableNumber(campaign.follow_up_percentage),
    createdAt: campaign.created_at == null ? null : String(campaign.created_at),
  };
}

export async function updateCampaignGeneralSettings(
  campaignId: string,
  patch: CampaignGeneralPatch,
): Promise<void> {
  const body: Record<string, unknown> = {};
  if (patch.name !== undefined) body.name = patch.name;
  if (patch.stopLeadSettings !== undefined) body.stop_lead_settings = patch.stopLeadSettings;
  if (patch.sendAsPlainText !== undefined) body.send_as_plain_text = patch.sendAsPlainText;
  if (patch.unsubscribeText !== undefined) body.unsubscribe_text = patch.unsubscribeText;
  if (patch.followUpPercentage !== undefined) body.follow_up_percentage = patch.followUpPercentage;
  if (patch.tracking !== undefined) {
    const response = await request(`/campaigns/${encodeURIComponent(campaignId)}`);
    const campaign = unwrapObjectData(response);
    if (!campaign) {
      throw new Error(`Smartlead returned an invalid campaign detail: ${writeResponseBody(response)}`);
    }
    body.track_settings = buildTrackSettings(campaign.track_settings, patch.tracking);
  }
  await request(`/campaigns/${encodeURIComponent(campaignId)}/settings`, {
    method: "POST",
    body,
    rejectOkFalse: true,
  });
  invalidateCampaignsCache();
}

export async function fetchCampaignSequence(campaignId: string): Promise<SequenceStep[]> {
  const response = await request(`/campaigns/${encodeURIComponent(campaignId)}/sequences`);

  return coerceList(response)
    .map((step, index): SequenceStep => {
      const delayDetails =
        step.seq_delay_details &&
        typeof step.seq_delay_details === "object" &&
        !Array.isArray(step.seq_delay_details)
          ? (step.seq_delay_details as Record<string, unknown>)
          : null;
      const rawVariants = step.sequence_variants;
      // An empty variants array means "plain step" — normalize to null so the
      // save path never emits `seq_variants: []` (which validation rejects).
      const variants = Array.isArray(rawVariants) && rawVariants.length > 0
        ? rawVariants.map((rawVariant): SequenceVariant => {
            const variant =
              rawVariant && typeof rawVariant === "object"
                ? (rawVariant as Record<string, unknown>)
                : {};
            return {
              id: integerOrNull(variant.id),
              label:
                variant.variant_label == null && variant.label == null
                  ? null
                  : String(variant.variant_label ?? variant.label),
              subject: stringOrEmpty(variant.subject),
              emailBody: stringOrEmpty(variant.email_body),
            };
          })
        : null;

      return {
        id: integerOrNull(step.id),
        seqNumber: integerOrDefault(step.seq_number, index + 1),
        // Smartlead's API is asymmetric here (verified with a disposable test
        // campaign): READS return seq_delay_details.delayInDays (camelCase),
        // while WRITES require delay_in_days (snake_case, see save below).
        delayInDays: integerOrDefault(
          delayDetails?.delayInDays ?? delayDetails?.delay_in_days,
          0,
        ),
        subject: stringOrEmpty(step.subject),
        emailBody: stringOrEmpty(step.email_body),
        variants,
      };
    })
    .sort((a, b) => a.seqNumber - b.seqNumber);
}

export async function saveCampaignSequence(
  campaignId: string,
  steps: SequenceStep[],
): Promise<void> {
  await request(`/campaigns/${encodeURIComponent(campaignId)}/sequences`, {
    method: "POST",
    body: {
      sequences: steps.map((step) => ({
        ...(step.id === null ? {} : { id: step.id }),
        seq_number: step.seqNumber,
        seq_delay_details: { delay_in_days: step.delayInDays },
        subject: step.subject,
        email_body: step.emailBody,
        ...(step.variants === null
          ? {}
          : {
              seq_variants: step.variants.map((variant) => ({
                id: variant.id,
                subject: variant.subject,
                email_body: variant.emailBody,
                variant_label: variant.label,
              })),
            }),
      })),
    },
    rejectOkFalse: true,
    rawErrorBody: true,
  });
}

export type CampaignPreviewLead = {
  /** e.g. "Jane Doe · Acme" — safe to show in the preview footer. */
  label: string;
  /** Merge-tag values: standard lead fields + Smartlead custom fields. */
  values: Record<string, string>;
};

/**
 * A real lead from the campaign to substitute into sequence previews (the
 * same data Smartlead's own preview uses). Returns the first populated lead
 * from the first page, or null when the campaign has none.
 */
export type CampaignLeadRow = {
  mapId: string;
  /** Smartlead lead id — null when the lead was removed upstream. */
  leadId: string | null;
  status: string | null;
  addedAt: string | null;
  firstName: string;
  lastName: string;
  email: string;
  company: string;
  website: string;
  location: string;
  phone: string;
  linkedinUrl: string | null;
  companyUrl: string | null;
  categoryId: number | null;
  unsubscribed: boolean;
  /** Flat custom variables exactly as the sequence merge tags see them. */
  variables: Record<string, string>;
};

export type CampaignLeadsPage = { total: number; leads: CampaignLeadRow[] };

/**
 * One page of a campaign's loaded leads. Live-verified shape:
 * { total_leads, data: [{ campaign_lead_map_id, status, created_at,
 *   lead: { first_name, …, custom_fields (object OR JSON string),
 *   linkedin_profile, company_url, is_unsubscribed } }], offset, limit }.
 * Some map rows carry an all-null lead (removed upstream) — they are kept so
 * offset pagination stays aligned with total_leads.
 */
export async function fetchCampaignLeadsPage(
  campaignId: string,
  offset: number,
  limit: number,
): Promise<CampaignLeadsPage> {
  const raw = await request(`/campaigns/${encodeURIComponent(campaignId)}/leads`, {
    params: { offset: String(offset), limit: String(limit) },
  });
  const envelope = (raw ?? {}) as { total_leads?: unknown; data?: unknown };
  const rows = (Array.isArray(envelope.data) ? envelope.data : []) as {
    campaign_lead_map_id?: unknown;
    lead_category_id?: unknown;
    status?: unknown;
    created_at?: unknown;
    lead?: Record<string, unknown> | null;
  }[];

  const text = (value: unknown): string => (typeof value === "string" ? value.trim() : "");
  const leads: CampaignLeadRow[] = rows.map((row, index) => {
    const lead = row.lead && typeof row.lead === "object" ? row.lead : {};
    let custom = lead.custom_fields;
    if (typeof custom === "string") {
      try {
        custom = JSON.parse(custom);
      } catch {
        custom = null;
      }
    }
    const variables: Record<string, string> = {};
    if (custom && typeof custom === "object" && !Array.isArray(custom)) {
      for (const [key, value] of Object.entries(custom as Record<string, unknown>)) {
        if (value != null && String(value).trim()) variables[key] = String(value).trim();
      }
    }
    return {
      mapId: String(row.campaign_lead_map_id ?? `${offset + index}`),
      leadId: lead.id == null ? null : String(lead.id),
      status: row.status == null ? null : String(row.status),
      addedAt: row.created_at == null ? null : String(row.created_at),
      firstName: text(lead.first_name),
      lastName: text(lead.last_name),
      email: text(lead.email),
      company: text(lead.company_name),
      website: text(lead.website),
      location: text(lead.location),
      phone: text(lead.phone_number),
      linkedinUrl: text(lead.linkedin_profile) || null,
      companyUrl: text(lead.company_url) || null,
      categoryId: integerOrNull(row.lead_category_id),
      unsubscribed: lead.is_unsubscribed === true,
      variables,
    };
  });

  return { total: integerOrDefault(envelope.total_leads, leads.length), leads };
}

export type CampaignLeadUpdate = {
  email: string;
  firstName: string;
  lastName: string;
  company: string;
  website: string;
  location: string;
  phone: string;
  linkedinUrl: string;
  companyUrl: string;
  variables: Record<string, string>;
};

export type AddLeadsInput = {
  email: string;
  firstName?: string;
  lastName?: string;
  company?: string;
  website?: string;
  location?: string;
  phone?: string;
  linkedinUrl?: string;
  companyUrl?: string;
  variables?: Record<string, string>;
}[];

export type AddLeadsResult = {
  uploaded: number;
  duplicates: number;
  invalid: number;
  blocked: number;
  alreadyInCampaign: number;
  limitExhausted: boolean;
  totalLeads: number;
};

export async function addCampaignLeads(
  campaignId: string,
  leads: AddLeadsInput,
): Promise<AddLeadsResult> {
  const result: AddLeadsResult = {
    uploaded: 0,
    duplicates: 0,
    invalid: 0,
    blocked: 0,
    alreadyInCampaign: 0,
    limitExhausted: false,
    totalLeads: 0,
  };

  for (let offset = 0; offset < leads.length; offset += 100) {
    if (offset > 0) await sleep(300);
    const chunk = leads.slice(offset, offset + 100);
    let response: unknown;
    try {
      response = await request(`/campaigns/${encodeURIComponent(campaignId)}/leads`, {
        method: "POST",
        body: {
          lead_list: chunk.map((lead) => ({
            email: lead.email,
            ...(lead.firstName !== undefined ? { first_name: lead.firstName } : {}),
            ...(lead.lastName !== undefined ? { last_name: lead.lastName } : {}),
            ...(lead.company !== undefined ? { company_name: lead.company } : {}),
            ...(lead.website !== undefined ? { website: lead.website } : {}),
            ...(lead.location !== undefined ? { location: lead.location } : {}),
            ...(lead.phone !== undefined ? { phone_number: lead.phone } : {}),
            ...(lead.linkedinUrl !== undefined ? { linkedin_profile: lead.linkedinUrl } : {}),
            ...(lead.companyUrl !== undefined ? { company_url: lead.companyUrl } : {}),
            ...(lead.variables !== undefined ? { custom_fields: lead.variables } : {}),
          })),
        },
        rejectOkFalse: true,
      });
    } catch (error) {
      // A mid-batch failure must not hide what already landed; a retry is
      // safe because Smartlead reports re-sends as already_added_to_campaign.
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Added ${result.uploaded} of ${leads.length} leads before Smartlead rejected a batch (retrying is safe; already-added leads are skipped). ${detail}`,
      );
    }
    const data = (response ?? {}) as Record<string, unknown>;
    result.uploaded += integerOrDefault(data.upload_count, 0);
    result.duplicates += integerOrDefault(data.duplicate_count, 0);
    result.invalid += integerOrDefault(data.invalid_email_count, 0);
    result.blocked += integerOrDefault(data.block_count, 0);
    result.alreadyInCampaign += integerOrDefault(data.already_added_to_campaign, 0);
    result.totalLeads += integerOrDefault(data.total_leads, 0);
    result.limitExhausted ||= data.is_lead_limit_exhausted === true;
  }

  return result;
}

/**
 * Update a campaign lead. Live-verified: POST /campaigns/{id}/leads/{leadId}
 * requires `email` in the body and accepts the full lead shape; a sentinel
 * custom_fields write applied and restored cleanly. Email is sent as the
 * identity anchor — the app never edits it.
 */
export async function updateCampaignLead(
  campaignId: string,
  leadId: string,
  input: CampaignLeadUpdate,
): Promise<void> {
  await request(
    `/campaigns/${encodeURIComponent(campaignId)}/leads/${encodeURIComponent(leadId)}`,
    {
      method: "POST",
      body: {
        email: input.email,
        first_name: input.firstName,
        last_name: input.lastName,
        company_name: input.company,
        website: input.website,
        location: input.location,
        phone_number: input.phone,
        linkedin_profile: input.linkedinUrl,
        company_url: input.companyUrl,
        custom_fields: input.variables,
      },
      rejectOkFalse: true,
    },
  );
}

export async function fetchCampaignPreviewLead(campaignId: string): Promise<CampaignPreviewLead | null> {
  const raw = await request(`/campaigns/${encodeURIComponent(campaignId)}/leads`, {
    params: { offset: "0", limit: "20" },
  });
  const rows = ((raw as { data?: unknown })?.data ?? []) as { lead?: Record<string, unknown> }[];

  for (const row of rows) {
    const lead = row?.lead;
    if (!lead || typeof lead !== "object") continue;
    const values: Record<string, string> = {};

    for (const field of ["first_name", "last_name", "email", "company_name", "website", "location", "phone_number"]) {
      const value = lead[field];
      if (typeof value === "string" && value.trim()) values[field] = value.trim();
    }

    // custom_fields arrives as an object or a JSON string depending on the
    // ingestion path; both hold flat string values.
    let custom = lead.custom_fields;
    if (typeof custom === "string") {
      try {
        custom = JSON.parse(custom);
      } catch {
        custom = null;
      }
    }
    if (custom && typeof custom === "object" && !Array.isArray(custom)) {
      for (const [key, value] of Object.entries(custom as Record<string, unknown>)) {
        if (value != null && String(value).trim()) values[key] = String(value).trim();
      }
    }

    if (!values.first_name && !values.email) continue; // empty placeholder rows exist
    const name = [values.first_name, values.last_name].filter(Boolean).join(" ") || values.email;
    const label = values.company_name ? `${name} · ${values.company_name}` : name;
    return { label, values };
  }
  return null;
}

export async function updateCampaignStatus(
  campaignId: string,
  status: SmartleadCampaignStatus,
): Promise<void> {
  await request(`/campaigns/${encodeURIComponent(campaignId)}/status`, {
    method: "POST",
    body: { status },
    rejectOkFalse: true,
  });
}

export async function updateCampaignSettings(
  campaignId: string,
  patch: SmartleadCampaignLimitsPatch,
): Promise<void> {
  // Sending limits live on Smartlead's SCHEDULE endpoint, with different key
  // names than the campaign GET returns (verified live: POST /settings 400s
  // on "max_leads_per_day"). The schedule POST requires the FULL schedule
  // (timezone/days/hours), so read the current one and merge the new limits
  // into it. scheduler_cron_value looks like
  // {"tz":"America/Bogota","days":[1,2,3,4,5],"endHour":"18:00","startHour":"09:00"}
  // and arrives as an object or a JSON string depending on the campaign.
  const response = await request(`/campaigns/${encodeURIComponent(campaignId)}`);
  const campaign = unwrapObjectData(response);
  if (!campaign) {
    throw new Error(`Smartlead returned an invalid campaign detail: ${writeResponseBody(response)}`);
  }

  let cron: { tz?: string; days?: number[]; startHour?: string; endHour?: string } = {};
  const rawCron = campaign.scheduler_cron_value;
  try {
    const parsed = typeof rawCron === "string" ? JSON.parse(rawCron) : rawCron;
    cron = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    cron = {};
  }
  if (!cron.tz || !Array.isArray(cron.days) || !cron.startHour || !cron.endHour) {
    throw new Error(
      "This campaign has no schedule yet. Set its sending schedule in Smartlead once before editing limits here.",
    );
  }

  await request(`/campaigns/${encodeURIComponent(campaignId)}/schedule`, {
    method: "POST",
    body: {
      timezone: cron.tz,
      days_of_the_week: cron.days,
      start_hour: cron.startHour,
      end_hour: cron.endHour,
      min_time_btw_emails: patch.minTimeBtwnEmails ?? campaign.min_time_btwn_emails,
      max_new_leads_per_day: patch.maxLeadsPerDay ?? campaign.max_leads_per_day,
    },
    rejectOkFalse: true,
  });
}

export async function upsertCampaignWebhook(
  campaignId: string,
  options: { id?: number | null; name: string; webhookUrl: string; eventTypes: string[]; categories?: string[] },
) {
  return request(`/campaigns/${encodeURIComponent(campaignId)}/webhooks`, {
    method: "POST",
    body: {
      id: options.id ?? null,
      name: options.name,
      webhook_url: options.webhookUrl,
      event_types: options.eventTypes,
      categories: options.categories ?? [],
    },
  });
}

export async function registerReplyWebhook(
  campaignId: string,
): Promise<{ ok: boolean; message: string }> {
  try {
    const env = getEnv();
    const webhookUrl = `${env.APP_BASE_URL.replace(/\/+$/, "")}/api/webhooks/smartlead?secret=${encodeURIComponent(env.SMARTLEAD_WEBHOOK_SECRET)}`;
    const categories = (await fetchReplyCategories()).map((category) => category.name);
    if (categories.length === 0) {
      return { ok: false, message: "Could not fetch Smartlead reply categories." };
    }

    const existing = coerceList(await listCampaignWebhooks(campaignId));
    const match = existing.find((webhook) =>
      [WEBHOOK_NAME, ...LEGACY_WEBHOOK_NAMES].includes(String(webhook.name ?? "")),
    );
    const rawId = match?.id;
    const id = rawId == null ? null : Number(rawId);
    await upsertCampaignWebhook(campaignId, {
      id: Number.isFinite(id) ? id : null,
      name: WEBHOOK_NAME,
      webhookUrl,
      eventTypes: ["EMAIL_REPLY"],
      categories,
    });
    return {
      ok: true,
      message: match ? "Smartlead reply webhook updated." : "Smartlead reply webhook registered.",
    };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : "Could not register Smartlead reply webhook.",
    };
  }
}

export type ReplyWebhookStatus = { registered: boolean; name: string | null; url: string | null };

export async function getReplyWebhookStatus(campaignId: string): Promise<ReplyWebhookStatus> {
  const webhooks = coerceList(await listCampaignWebhooks(campaignId));
  const match = webhooks.find((webhook) =>
    [WEBHOOK_NAME, ...LEGACY_WEBHOOK_NAMES].includes(String(webhook.name ?? "")),
  );
  return {
    registered: match !== undefined,
    name: match?.name == null ? null : String(match.name),
    url: match?.webhook_url == null ? null : String(match.webhook_url),
  };
}

export type InboxWarmup = {
  status: string | null;
  reputation: number | null;
  totalSentCount: number;
  totalSpamCount: number;
  replyRatePercent: number | null;
  maxEmailPerDay: number | null;
  warmupMaxCount: number | null;
  warmupMinCount: number | null;
  isBlocked: boolean;
  blockedReason: string | null;
  /** Warmup identifier tag stamped on warmup emails (warmup_key_id). */
  warmupKey: string | null;
  /** When warmup was configured for this account (warmup_created_at) - the
      per-account ground truth for "warming since". */
  warmupCreatedAt: string | null;
};

export type InboxAccount = {
  id: number;
  fromName: string;
  signature: string;
  bcc: string;
  timeToWaitMins: number | null;
  /** When the account was added to Smartlead (weak fallback for warmup age). */
  createdAt: string | null;
  fromEmail: string;
  provider: string | null;
  messagePerDay: number | null;
  dailySentCount: number;
  smtpOk: boolean;
  imapOk: boolean;
  smtpError: string | null;
  imapError: string | null;
  customTrackingDomain: string | null;
  isSuspended: boolean;
  tags: string[];
  warmup: InboxWarmup | null;
};

export type InboxWarmupStats = {
  sentCount: number;
  spamCount: number;
  inboxCount: number;
  receivedCount: number;
  byDate: { date: string; sentCount: number; replyCount: number; saveFromSpamCount: number }[];
};

function inboxList(response: unknown): Record<string, unknown>[] {
  if (Array.isArray(response)) return response as Record<string, unknown>[];
  if (!response || typeof response !== "object") return [];
  const envelope = response as Record<string, unknown>;
  for (const candidate of [envelope.data, envelope.email_accounts, envelope.accounts, envelope.results]) {
    if (Array.isArray(candidate)) return candidate as Record<string, unknown>[];
    if (candidate && typeof candidate === "object" && !Array.isArray(candidate)) {
      const nested = candidate as Record<string, unknown>;
      for (const rows of [nested.email_accounts, nested.accounts, nested.results]) {
        if (Array.isArray(rows)) return rows as Record<string, unknown>[];
      }
    }
  }
  return [];
}

function percentNumber(value: unknown): number | null {
  const normalized = typeof value === "string" ? value.trim().replace(/%$/, "") : value;
  const number = nullableNumber(normalized);
  return number !== null && number >= 0 && number <= 100 ? number : null;
}

function nullableString(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text || null;
}

function normalizeInboxAccount(raw: Record<string, unknown>): InboxAccount | null {
  const id = integerOrNull(raw.id);
  if (id === null || id < 1) return null;
  const warmupRaw =
    raw.warmup_details && typeof raw.warmup_details === "object" && !Array.isArray(raw.warmup_details)
      ? (raw.warmup_details as Record<string, unknown>)
      : null;
  const blockedReason = warmupRaw ? nullableString(warmupRaw.blocked_reason) : null;
  const tags = Array.isArray(raw.tags)
    ? raw.tags
        .map((tag) => {
          if (typeof tag === "string") return tag.trim();
          if (!tag || typeof tag !== "object" || Array.isArray(tag)) return "";
          const record = tag as Record<string, unknown>;
          return String(record.name ?? record.tag_name ?? record.label ?? "").trim();
        })
        .filter((tag): tag is string => Boolean(tag))
    : [];

  return {
    id,
    fromName: stringOrEmpty(raw.from_name),
    signature: stringOrEmpty(raw.signature),
    bcc: stringOrEmpty(raw.bcc_email),
    timeToWaitMins: integerOrNull(raw.minTimeToWaitInMins),
    createdAt: nullableString(raw.created_at),
    fromEmail: stringOrEmpty(raw.from_email),
    provider: nullableString(raw.type),
    messagePerDay: integerOrNull(raw.message_per_day),
    dailySentCount: integerOrDefault(raw.daily_sent_count, 0),
    smtpOk: raw.is_smtp_success === true,
    imapOk: raw.is_imap_success === true,
    smtpError: nullableString(raw.smtp_failure_error),
    imapError: nullableString(raw.imap_failure_error),
    customTrackingDomain: nullableString(raw.custom_tracking_domain),
    isSuspended: raw.is_suspended === true,
    tags,
    warmup: warmupRaw
      ? {
          status: nullableString(warmupRaw.status),
          reputation: percentNumber(warmupRaw.warmup_reputation),
          totalSentCount: integerOrDefault(warmupRaw.total_sent_count, 0),
          totalSpamCount: integerOrDefault(warmupRaw.total_spam_count, 0),
          replyRatePercent: percentNumber(warmupRaw.reply_rate),
          maxEmailPerDay: integerOrNull(warmupRaw.max_email_per_day),
          warmupMaxCount: integerOrNull(warmupRaw.warmup_max_count),
          warmupMinCount: integerOrNull(warmupRaw.warmup_min_count),
          isBlocked: warmupRaw.is_warmup_blocked === true || blockedReason !== null,
          blockedReason,
          warmupKey: nullableString(warmupRaw.warmup_key_id),
          warmupCreatedAt: nullableString(warmupRaw.warmup_created_at),
        }
      : null,
  };
}

function requireInboxAccount(response: unknown, accountId: number): InboxAccount {
  const raw = unwrapObjectData(response);
  const account = raw ? normalizeInboxAccount(raw) : null;
  if (!account) {
    throw new Error(`Smartlead returned an invalid email account ${accountId}: ${writeResponseBody(response)}`);
  }
  return account;
}

export async function listInboxAccounts(): Promise<InboxAccount[]> {
  const limit = 100;
  const accounts: InboxAccount[] = [];
  // Dedup by id: if Smartlead ever ignored `offset`, repeated pages would
  // otherwise multiply every account (and break React keys downstream).
  const seen = new Set<number>();
  for (let page = 0; page < 10; page += 1) {
    const response = await request("/email-accounts/", {
      params: { offset: String(page * limit), limit: String(limit) },
    });
    const rows = inboxList(response);
    let added = 0;
    for (const row of rows) {
      const account = normalizeInboxAccount(row);
      if (account && !seen.has(account.id)) {
        seen.add(account.id);
        accounts.push(account);
        added += 1;
      }
    }
    if (rows.length < limit || added === 0) break;
  }
  return accounts;
}

export async function fetchInboxAccount(accountId: number): Promise<InboxAccount> {
  const response = await request(`/email-accounts/${encodeURIComponent(String(accountId))}/`);
  return requireInboxAccount(response, accountId);
}

export async function fetchInboxWarmupStats(accountId: number): Promise<InboxWarmupStats> {
  const response = await request(`/email-accounts/${encodeURIComponent(String(accountId))}/warmup-stats`);
  const stats = unwrapObjectData(response);
  if (!stats) {
    throw new Error(`Smartlead returned invalid warmup stats for email account ${accountId}: ${writeResponseBody(response)}`);
  }
  const rawByDate = Array.isArray(stats.stats_by_date) ? stats.stats_by_date : [];
  return {
    sentCount: integerOrDefault(stats.sent_count, 0),
    spamCount: integerOrDefault(stats.spam_count, 0),
    inboxCount: integerOrDefault(stats.inbox_count, 0),
    receivedCount: integerOrDefault(stats.warmup_email_received_count, 0),
    byDate: rawByDate.map((value) => {
      const day = value && typeof value === "object" && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : {};
      return {
        date: stringOrEmpty(day.date),
        sentCount: integerOrDefault(day.sent_count, 0),
        replyCount: integerOrDefault(day.reply_count, 0),
        saveFromSpamCount: integerOrDefault(day.save_from_spam_count, 0),
      };
    }),
  };
}

export async function fetchCampaignInboxAccounts(campaignId: string): Promise<InboxAccount[]> {
  const response = await request(`/campaigns/${encodeURIComponent(campaignId)}/email-accounts`);
  return inboxList(response)
    .map(normalizeInboxAccount)
    .filter((account): account is InboxAccount => account !== null);
}
