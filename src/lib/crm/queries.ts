import "server-only";
import { getAdminClient } from "@/lib/supabase/admin";
import { getTaxonomy } from "@/lib/taxonomy-store";
import { htmlToText } from "@/lib/html";
import { latestPerEvent, type AnalyticsFilter } from "@/lib/replies/queries";
import { resolveLeadByEmail } from "@/lib/smartlead";

export type CrmLeadsFilter = {
  limit?: number; offset?: number; search?: string | null; campaignIds?: string[]; campaignExcludeIds?: string[];
  replied?: boolean | null; sentimentTypes?: string[]; categories?: string[];
  referral?: boolean | null; dnc?: boolean | null; dncReasons?: string[];
  dncApprovedOnly?: boolean; proposalStatuses?: string[];
  replyFrom?: string | null; replyTo?: string | null; exportedFrom?: string | null; exportedTo?: string | null;
  sort?: "name" | "company" | "exported_at" | "last_reply_at"; sortDir?: "asc" | "desc";
  membership?: ("exported" | "legacy" | "reply_only")[];
};

export type CrmLeadRow = {
  id: string; firstName: string | null; lastName: string | null; title: string | null;
  company: string | null; domain: string | null; email: string | null; linkedinUrl: string | null;
  country: string | null; membershipSource: "exported" | "legacy" | "reply_only";
  campaignId: string | null; campaignName: string | null; exportedAt: string | null;
  smartleadLeadId: string | null; lastReplyAt: string | null; lastReplyEventId: string | null;
  lastReplyCategory: string | null; lastReplySentimentType: string | null; replied: boolean; positiveAny: boolean;
};

type RpcLead = Record<string, unknown> & { id: string; total_count?: number | string };
const nullableString = (value: unknown) => typeof value === "string" ? value : null;
const escapeLike = (value: string) => value.replace(/[\\%_]/g, "\\$&");

function normalizeLead(row: RpcLead): CrmLeadRow {
  return {
    id: row.id, firstName: nullableString(row.first_name), lastName: nullableString(row.last_name),
    title: nullableString(row.title), company: nullableString(row.company), domain: nullableString(row.domain),
    email: nullableString(row.email), linkedinUrl: nullableString(row.linkedin_url), country: nullableString(row.lead_country),
    membershipSource: row.membership_source as CrmLeadRow["membershipSource"], campaignId: nullableString(row.campaign_id),
    campaignName: nullableString(row.campaign_name), exportedAt: nullableString(row.exported_at),
    smartleadLeadId: nullableString(row.smartlead_lead_id), lastReplyAt: nullableString(row.last_reply_at),
    lastReplyEventId: nullableString(row.last_reply_event_id), lastReplyCategory: nullableString(row.last_reply_category),
    lastReplySentimentType: nullableString(row.last_reply_sentiment_type), replied: row.replied === true, positiveAny: row.positive_any === true,
  };
}

/** p_search is already escaped here; crm_leads_page uses LIKE ... ESCAPE '\\'. */
export async function getCrmLeadsPage(filter: CrmLeadsFilter = {}) {
  const { data, error } = await getAdminClient().rpc("crm_leads_page", {
    p_limit: filter.limit ?? 50, p_offset: filter.offset ?? 0,
    p_search: filter.search?.trim() ? escapeLike(filter.search.trim()) : null,
    p_campaign_ids: filter.campaignIds?.length ? filter.campaignIds : null,
    p_campaigns_exclude: filter.campaignExcludeIds?.length ? filter.campaignExcludeIds : null,
    p_replied: filter.replied ?? null,
    p_sentiment_types: filter.sentimentTypes?.length ? filter.sentimentTypes : null,
    p_categories: filter.categories?.length ? filter.categories.map((label) => label.trim().toLowerCase()) : null, p_referral: filter.referral ?? null,
    p_dnc: filter.dnc ?? null, p_dnc_reasons: filter.dncReasons?.length ? filter.dncReasons : null,
    p_dnc_approved_only: filter.dncApprovedOnly ?? false,
    p_proposal_statuses: filter.proposalStatuses?.length ? filter.proposalStatuses : null,
    p_reply_from: filter.replyFrom ?? null, p_reply_to: filter.replyTo ?? null,
    p_exported_from: filter.exportedFrom ?? null, p_exported_to: filter.exportedTo ?? null,
    p_sort: filter.sort ?? "last_reply_at", p_sort_dir: filter.sortDir ?? "desc",
    p_membership: filter.membership?.length ? filter.membership : null,
  });
  if (error) throw new Error(`CRM leads page: ${error.message}`);
  const rows = (data ?? []) as RpcLead[];
  return { rows: rows.map(normalizeLead), total: Number(rows[0]?.total_count ?? 0) };
}

export async function getCrmLeadDetail(leadId: string, repliesOffset = 0) {
  const admin = getAdminClient();
  const [leadRes, repliesRes, exportsRes, runsRes] = await Promise.all([
    admin.from("leads").select("*").eq("id", leadId).single(),
    admin.from("reply_events").select("id, lead_id, smartlead_lead_id, campaign_id, campaign_name, from_email, subject, body, smartlead_category, received_at, created_at", { count: "exact" }).eq("lead_id", leadId).order("received_at", { ascending: false, nullsFirst: false }).order("created_at", { ascending: false }).order("id", { ascending: false }).range(repliesOffset, repliesOffset + 49),
    admin.from("enrichment_table_exports").select("*").eq("lead_id", leadId).order("exported_at", { ascending: false }),
    admin.from("lead_runs").select("*").eq("lead_id", leadId).order("created_at", { ascending: false }).limit(50),
  ]);
  for (const [name, result] of [["lead", leadRes], ["replies", repliesRes], ["exports", exportsRes], ["runs", runsRes]] as const) {
    if (result.error) throw new Error(`CRM detail ${name}: ${result.error.message}`);
  }
  const events = (repliesRes.data ?? []) as Array<Record<string, unknown> & { id: string; body?: string | null }>;
  const ids = events.map((event) => event.id);
  const proposalRes = ids.length ? await admin.from("reply_proposals").select("*").in("reply_event_id", ids).order("created_at", { ascending: false }).order("id", { ascending: false }) : { data: [], error: null };
  if (proposalRes.error) throw new Error(`CRM detail proposals: ${proposalRes.error.message}`);
  const latest = latestPerEvent((proposalRes.data ?? []) as Array<{ id: string; reply_event_id: string | null; created_at: string }>);
  const lead = leadRes.data as Record<string, unknown>;

  // Smartlead lead id for the drawer's "Open in Smartlead" deep link
  // (app.smartlead.ai/app/lead/{id}/view). The shared leads table rarely
  // stores it, so fall back to the lead's reply events, then one live
  // Smartlead lookup by email. Best-effort: when every source misses, the
  // drawer link degrades to the campaign inbox.
  let smartleadLeadId =
    typeof lead.smartlead_lead_id === "string" && lead.smartlead_lead_id.trim()
      ? lead.smartlead_lead_id.trim()
      : null;
  if (!smartleadLeadId) {
    const fromEvent = events.find(
      (event) => typeof event.smartlead_lead_id === "string" && (event.smartlead_lead_id as string).trim(),
    );
    if (fromEvent) smartleadLeadId = (fromEvent.smartlead_lead_id as string).trim();
  }
  if (!smartleadLeadId && typeof lead.email === "string" && lead.email.trim()) {
    smartleadLeadId = await resolveLeadByEmail(lead.email.trim())
      .then((resolved) => resolved?.id ?? null)
      .catch(() => null);
  }

  return {
    lead,
    smartleadLeadId,
    replies: events.map((event) => ({ ...event, latestProposal: latest.get(event.id) ?? null, snippet: htmlToText(event.body ?? "").slice(0, 200) })),
    repliesTotal: repliesRes.count ?? 0, exports: exportsRes.data ?? [], leadRuns: runsRes.data ?? [],
  };
}

/* ── Lead editing ──────────────────────────────────────────────────────────
   Optimistic-concurrency writeback on public.leads. The guard `.eq("updated_at",
   expectedUpdatedAt)` mirrors the enrichment writeback marker (016): a stale
   marker matches zero rows, so a concurrent edit never silently clobbers. Only
   the provided fields are written; rawPatch spread-merges into the raw jsonb. */
export type CrmLeadPatch = {
  firstName?: string; lastName?: string; title?: string;
  company?: string; domain?: string; linkedinUrl?: string;
  rawPatch?: Record<string, string>;
};

const CRM_LEAD_COLUMNS: Record<Exclude<keyof CrmLeadPatch, "rawPatch">, string> = {
  firstName: "first_name", lastName: "last_name", title: "title",
  company: "company", domain: "domain", linkedinUrl: "linkedin_url",
};

export async function updateCrmLead(
  leadId: string,
  patch: CrmLeadPatch,
  expectedUpdatedAt: string,
): Promise<{ outcome: "written" | "stale"; lead: Record<string, unknown> | null }> {
  const admin = getAdminClient();
  const update: Record<string, unknown> = { updated_at: new Date().toISOString() };
  for (const [field, column] of Object.entries(CRM_LEAD_COLUMNS) as [keyof typeof CRM_LEAD_COLUMNS, string][]) {
    const value = patch[field];
    if (value !== undefined) update[column] = value.trim() === "" ? null : value;
  }
  if (patch.rawPatch && Object.keys(patch.rawPatch).length > 0) {
    const current = await admin.from("leads").select("raw").eq("id", leadId).single();
    if (current.error) throw new Error(`CRM lead update (raw fetch): ${current.error.message}`);
    const existing = current.data?.raw;
    const merged =
      existing && typeof existing === "object" && !Array.isArray(existing)
        ? { ...(existing as Record<string, unknown>) }
        : {};
    for (const [key, value] of Object.entries(patch.rawPatch)) merged[key] = value;
    update.raw = merged;
  }
  const { data, error } = await admin
    .from("leads")
    .update(update)
    .eq("id", leadId)
    .eq("updated_at", expectedUpdatedAt)
    .select("*")
    .maybeSingle();
  if (error) throw new Error(`CRM lead update: ${error.message}`);
  if (!data) return { outcome: "stale", lead: null };
  return { outcome: "written", lead: data as Record<string, unknown> };
}

/** Records a crm_edit run against the lead (Activity feed). Non-fatal: callers
    treat a logging failure as a soft error and keep the successful write. */
export async function logCrmLeadEdit(leadId: string, changed: string[]) {
  const { error } = await getAdminClient().from("lead_runs").insert({
    lead_id: leadId,
    action: "crm_edit",
    provider: "inbox",
    ok: true,
    message: `Edited ${changed.join(", ")}`.slice(0, 500),
    details: { changed },
  });
  if (error) throw new Error(`CRM lead edit log: ${error.message}`);
}

export type AnalyticsDrillKind = "replies" | "positive" | "referrals" | "awaiting_review" | "ooo" | "dnc_asked" | "dnc_defunct" | "sent_from_inbox";
/** One row per LEAD (except sent_from_inbox, which is per message we sent).
 *  `replyCount` is how many messages that lead contributed to this drill kind —
 *  1 for most, higher for a repeat replier; the row shows their FIRST such
 *  message and the lead detail panel holds the rest. */
export type AnalyticsDrillRow = { leadId: string | null; leadName: string; company: string | null; email: string | null; campaignName: string | null; receivedAt: string; category: string | null; sentimentType: string | null; proposalStatus: string | null; snippet: string; smartleadLeadId: string | null; replyCount: number };

type DrillEvent = { id: string; lead_id: string | null; smartlead_lead_id: string | null; campaign_id: string | null; campaign_name: string | null; from_email: string | null; body: string | null; smartlead_category: string | null; received_at: string | null; created_at: string };
type DrillProposal = { id: string; reply_event_id: string | null; created_at: string; sentiment: string | null; sentiment_type: string | null; is_referral: boolean; action_dnc: boolean; dnc_reason: string | null; status: string };

async function fetchDrillNewest<T>(table: string, columns: string, since: string, metricEligible = false): Promise<T[]> {
  const rows: T[]=[];
  for (let offset=0;offset<10_000;offset+=100) {
    let query=getAdminClient().from(table).select(columns).gte("created_at",since);
    if(metricEligible) query=query.eq("metric_eligible",true);
    const result=await query.order("created_at",{ascending:false}).order("id",{ascending:false}).range(offset,offset+99);
    if (result.error) throw new Error(`Analytics drill ${table}: ${result.error.message}`);
    const page=(result.data??[]) as T[]; rows.push(...page); if(page.length<100) break;
  }
  return rows;
}

export async function getAnalyticsDrilldown(kind: AnalyticsDrillKind, filter: AnalyticsFilter = {}) {
  const admin = getAdminClient(); const now = Date.now(); const days = filter.days ?? 90;
  const since = new Date(now - days * 86_400_000).toISOString(); const until = now + 10 * 60_000;
  if (kind === "sent_from_inbox") {
    const pages=[];
    const ids = filter.campaigns?.ids ?? [];
    for(let offset=0;offset<200;offset+=100){let query=admin.from("reply_sends").select("id, lead_id, reply_event_id, smartlead_lead_id, campaign_id, to_email, body, created_at").eq("status","sent").gte("created_at",since).order("created_at",{ascending:false}).order("id",{ascending:false}).range(offset,offset+99);if(filter.campaigns?.mode==="include")query=query.in("campaign_id",ids);if(filter.campaigns?.mode==="exclude"&&ids.length)query=query.or(`campaign_id.is.null,campaign_id.not.in.(${ids.join(",")})`);const result=await query;if(result.error)throw new Error(`Analytics send drilldown: ${result.error.message}`);pages.push(...(result.data??[]));if((result.data??[]).length<100)break;}
    const countRes=await admin.rpc("crm_analytics_drill_count",{p_kind:kind,p_from:since,p_to:new Date(until).toISOString(),p_campaign_mode:filter.campaigns?.mode??null,p_campaign_ids:ids,p_ooo_labels:[]});if(countRes.error)throw new Error(`Analytics send drilldown count: ${countRes.error.message}`);
    const sends = pages as Array<Record<string, unknown>>; const leadIds = [...new Set(sends.map(r => nullableString(r.lead_id)).filter((x): x is string => !!x))];
    const leadsRes = leadIds.length ? await admin.from("leads").select("id, first_name, last_name, company, email").in("id", leadIds) : { data: [], error: null };
    const leadMap = new Map((leadsRes.data ?? []).map((lead) => [String(lead.id), lead]));
    // Sends stay per-message: this tile counts replies WE sent (outbound
    // activity), so one row per send is the honest grain — nothing to collapse.
    return { rows: sends.map((send) => { const leadId=nullableString(send.lead_id); const lead=leadId ? leadMap.get(leadId) : undefined; return { leadId, leadName: lead ? `${lead.first_name ?? ""} ${lead.last_name ?? ""}`.trim() : nullableString(send.to_email) ?? "Unknown", company: lead ? nullableString(lead.company) : null, email: lead ? nullableString(lead.email) : nullableString(send.to_email), campaignName: null, receivedAt: String(send.created_at), category: "Sent from inbox", sentimentType: null, proposalStatus: "sent", snippet: htmlToText(String(send.body ?? "")).slice(0,200), smartleadLeadId: nullableString(send.smartlead_lead_id), replyCount: 1 }; }), total: Number(countRes.data??0), linkedLeadCount: sends.filter(r => r.lead_id != null).length, kind, leadsMappable: false };
  }
  const [eventsRaw, proposals, taxonomy] = await Promise.all([
    fetchDrillNewest<DrillEvent>("reply_events", "id, lead_id, smartlead_lead_id, campaign_id, campaign_name, from_email, body, smartlead_category, received_at, created_at", since, true),
    fetchDrillNewest<DrillProposal>("reply_proposals", "id, reply_event_id, created_at, sentiment, sentiment_type, is_referral, action_dnc, dnc_reason, status", since), getTaxonomy(),
  ]);
  const campaignIds = new Set(filter.campaigns?.ids ?? []);
  const events = eventsRaw.filter(e => { const time=new Date(e.received_at ?? e.created_at).getTime(); if (time < now-days*86_400_000 || time > until) return false; if (!filter.campaigns) return true; return filter.campaigns.mode === "include" ? e.campaign_id !== null && campaignIds.has(e.campaign_id) : e.campaign_id === null || !campaignIds.has(e.campaign_id); });
  const latest = latestPerEvent(proposals); const oooLabels = new Set(taxonomy.all.filter(c => c.systemRole === "out_of_office").map(c => c.label.trim().toLowerCase()));
  const selected = events.filter(event => { const p=latest.get(event.id); if (kind === "replies") return true; if (!p) return false; if (kind === "positive") return p.sentiment_type === "positive"; if (kind === "referrals") return p.is_referral; if (kind === "awaiting_review") return p.status === "pending"; if (kind === "ooo") return p.sentiment !== null && oooLabels.has(p.sentiment.trim().toLowerCase()); if (kind === "dnc_defunct") return p.action_dnc && p.status === "approved" && p.dnc_reason === "email_defunct"; return p.action_dnc && p.status === "approved" && p.dnc_reason !== "email_defunct"; });
  // Collapse to ONE ROW PER LEAD so the list matches the tile it was opened
  // from: three positive replies from one person is one positive lead, not
  // three. Keep that lead's EARLIEST matching message — the one that first put
  // them in this bucket (e.g. marked them a positive lead) — and count the rest.
  // Nothing is lost: clicking the row opens the lead detail panel, which lists
  // every reply they have ever sent.
  const eventTime=(event: DrillEvent)=>new Date(event.received_at??event.created_at).getTime();
  const personOf=(event: DrillEvent)=>event.lead_id??(event.from_email?.trim()?`email:${event.from_email.trim().toLowerCase()}`:`event:${event.id}`);
  const byPerson=new Map<string,{first:DrillEvent;count:number}>();
  for (const event of selected) {
    const entry=byPerson.get(personOf(event));
    if (!entry) { byPerson.set(personOf(event),{first:event,count:1}); continue; }
    entry.count+=1;
    // Ties broken by id so the chosen message is stable across reloads.
    const older=eventTime(event)<eventTime(entry.first)||(eventTime(event)===eventTime(entry.first)&&event.id<entry.first.id);
    if (older) entry.first=event;
  }
  const collapsed=[...byPerson.values()].sort((a,b)=>eventTime(b.first)-eventTime(a.first)||(a.first.id<b.first.id?1:-1));
  const shown=collapsed.slice(0,200); const leadIds=[...new Set(shown.map(item=>item.first.lead_id).filter((x): x is string=>!!x))]; const leadsRes=leadIds.length ? await admin.from("leads").select("id, first_name, last_name, company, email").in("id",leadIds) : {data:[],error:null}; if (leadsRes.error) throw new Error(`Analytics drill leads: ${leadsRes.error.message}`); const leadMap=new Map((leadsRes.data??[]).map(l=>[String(l.id),l]));
  const rows: AnalyticsDrillRow[]=shown.map(({first:event,count})=>{const p=latest.get(event.id);const lead=event.lead_id?leadMap.get(event.lead_id):undefined;return {leadId:event.lead_id,leadName:lead?`${lead.first_name??""} ${lead.last_name??""}`.trim():(event.from_email??"Unknown"),company:lead?nullableString(lead.company):null,email:lead?nullableString(lead.email):event.from_email,campaignName:event.campaign_name,receivedAt:event.received_at??event.created_at,category:p?.sentiment??event.smartlead_category,sentimentType:p?.sentiment_type??null,proposalStatus:p?.status??null,snippet:htmlToText(event.body??"").slice(0,200),smartleadLeadId:event.smartlead_lead_id,replyCount:count};});
  const [countRes,repliesCountRes]=await Promise.all([admin.rpc("crm_analytics_drill_count",{p_kind:kind,p_from:since,p_to:new Date(until).toISOString(),p_campaign_mode:filter.campaigns?.mode??null,p_campaign_ids:[...campaignIds],p_ooo_labels:[...oooLabels]}),kind==="positive"?admin.rpc("crm_analytics_drill_count",{p_kind:"replies",p_from:since,p_to:new Date(until).toISOString(),p_campaign_mode:filter.campaigns?.mode??null,p_campaign_ids:[...campaignIds],p_ooo_labels:[]}):Promise.resolve({data:null,error:null})]);
  if(countRes.error||repliesCountRes.error)throw new Error(`Analytics drill count: ${(countRes.error??repliesCountRes.error)?.message}`);
  // `total` counts distinct LEADS and `rows` is now one per lead, so the two
  // share a grain — the tile, the list length, and the header all agree.
  return { rows, total: Number(countRes.data??0), linkedLeadCount: rows.filter(row=>row.leadId!==null).length, kind, leadsMappable: true, ...(kind === "positive" ? { repliesTotal: Number(repliesCountRes.data??0) } : {}) };
}
