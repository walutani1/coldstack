import "server-only";

import { getAdminClient } from "@/lib/supabase/admin";
import { fetchCampaignInboxAccounts } from "@/lib/smartlead";

export type MatchCandidate = {
  index: number;
  leadId: string;
  name: string;
  email: string | null;
  company: string | null;
  domain: string | null;
  campaignIds: string[];
  evidence: string[];
};

type LeadRow = {
  id: string; first_name: string | null; last_name: string | null; email: string | null;
  company: string | null; domain: string | null; smartlead_campaign_id: string | null;
};

function escapeLike(value: string) { return value.replace(/([\\%_*])/g, "\\$1"); }
function emailDomain(email: string | null | undefined) { return email?.split("@")[1]?.trim().toLowerCase() || null; }
function tokens(value: string | null | undefined) {
  return new Set((value ?? "").toLowerCase().match(/[a-z0-9]{2,}/g) ?? []);
}

export async function buildCandidates(reply: {
  from_email: string | null; from_name: string | null; to_email: string | null; provider_received_at?: string | null;
}): Promise<MatchCandidate[]> {
  const admin = getAdminClient();
  const email = reply.from_email?.trim().toLowerCase() || null;
  const domain = emailDomain(email);
  const nameTokens = [...tokens(reply.from_name)].slice(0, 3);
  const select = "id,first_name,last_name,email,company,domain,smartlead_campaign_id";
  const requests: PromiseLike<{ data: LeadRow[] | null; error: { message: string } | null }>[] = [];
  if (email) requests.push(admin.from("leads").select(select).ilike("email", escapeLike(email)).limit(25) as never);
  if (domain) requests.push(admin.from("leads").select(select).or(`domain.ilike.${escapeLike(domain)},email.ilike.*@${escapeLike(domain)}`).limit(100) as never);
  for (const token of nameTokens) {
    requests.push(admin.from("leads").select(select).or(`first_name.ilike.*${escapeLike(token)}*,last_name.ilike.*${escapeLike(token)}*`).limit(40) as never);
  }
  const results = await Promise.all(requests);
  const rows = new Map<string, LeadRow>();
  for (const result of results) {
    if (result.error) throw new Error(`Untracked candidates: ${result.error.message}`);
    for (const row of result.data ?? []) rows.set(row.id, row);
  }

  const scored = [...rows.values()].map((lead) => {
    const evidence: string[] = [];
    let score = 0;
    if (email && lead.email?.trim().toLowerCase() === email) { score += 1000; evidence.push("exact email"); }
    const leadDomain = lead.domain?.trim().toLowerCase() || emailDomain(lead.email);
    if (domain && leadDomain === domain) { score += 80; evidence.push("same domain"); }
    const overlap = [...tokens(`${lead.first_name ?? ""} ${lead.last_name ?? ""}`)].filter((token) => tokens(reply.from_name).has(token));
    if (overlap.length) { score += overlap.length * 35; evidence.push(`name token: ${overlap.join(", ")}`); }
    return { lead, evidence, score };
  });

  const preliminary = scored.sort((a, b) => b.score - a.score || a.lead.id.localeCompare(b.lead.id));
  const exact = preliminary.filter((item) => item.evidence.includes("exact email"));
  const selected = [...exact, ...preliminary.filter((item) => !item.evidence.includes("exact email"))].slice(0, Math.max(12, exact.length));

  const leadIds = selected.map((item) => item.lead.id);
  if (leadIds.length) {
    const recent = await admin.from("reply_events").select("lead_id,received_at,created_at")
      .in("lead_id", leadIds).eq("metric_eligible", true).order("created_at", { ascending: false }).limit(200);
    if (!recent.error && reply.provider_received_at) {
      const target = Date.parse(reply.provider_received_at);
      for (const item of selected) {
        const closest = (recent.data ?? []).filter((row) => row.lead_id === item.lead.id)
          .map((row) => Math.abs(Date.parse(row.received_at ?? row.created_at) - target))
          .filter(Number.isFinite).sort((a, b) => a - b)[0];
        if (closest !== undefined && closest <= 30 * 86_400_000) item.evidence.push("reply activity within 30 days");
      }
    }
  }

  const recipient = reply.to_email?.trim().toLowerCase();
  const campaignIds = [...new Set(selected.map((item) => item.lead.smartlead_campaign_id).filter((id): id is string => Boolean(id)))];
  if (recipient) {
    await Promise.all(campaignIds.map(async (campaignId) => {
      try {
        const accounts = await fetchCampaignInboxAccounts(campaignId);
        if (accounts.some((account) => account.fromEmail.trim().toLowerCase() === recipient)) {
          for (const item of selected) if (item.lead.smartlead_campaign_id === campaignId) item.evidence.push(`recipient alias serves campaign ${campaignId}`);
        }
      } catch { /* weak evidence is best-effort */ }
    }));
  }

  return selected.slice(0, Math.max(12, exact.length)).map((item, index) => ({
    index,
    leadId: item.lead.id,
    name: `${item.lead.first_name ?? ""} ${item.lead.last_name ?? ""}`.trim() || item.lead.email || "Unknown",
    email: item.lead.email,
    company: item.lead.company,
    domain: item.lead.domain ?? emailDomain(item.lead.email),
    campaignIds: item.lead.smartlead_campaign_id ? [item.lead.smartlead_campaign_id] : [],
    evidence: item.evidence,
  }));
}
