import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import { getAdminClient } from "@/lib/supabase/admin";
import { getEnv } from "@/lib/env";

export type Colleague = {
  name: string;
  title: string | null;
  email: string | null;
  source: "crm" | "web";
};

// Lean guardrails: our own CRM is free and checked first; the web search only
// runs when the CRM yields fewer than MIN_CRM_HITS colleagues, and is capped
// at MAX_WEB_SEARCHES searches (~$0.01 each) on the cheap model. Results are
// carried forward for RESEARCH_TTL_DAYS per company domain — including empty
// results — so the same company is never paid for twice.
const MIN_CRM_HITS = 2;
const MAX_WEB_SEARCHES = 2;
const MAX_COLLEAGUES = 5;
const RESEARCH_TTL_DAYS = 30;

function escapeLike(value: string) {
  return value.replace(/([\\%_*])/g, "\\$1");
}

async function crmColleagues(domain: string, excludeEmail: string): Promise<Colleague[]> {
  const { data } = await getAdminClient()
    .from("leads")
    .select("first_name, last_name, title, email")
    .ilike("email", `%@${escapeLike(domain)}`)
    .limit(10);

  return (data ?? [])
    .filter((lead) => (lead.email as string)?.toLowerCase() !== excludeEmail.toLowerCase())
    .map((lead) => ({
      name: [lead.first_name, lead.last_name].filter(Boolean).join(" ").trim(),
      title: (lead.title as string | null) ?? null,
      email: (lead.email as string | null) ?? null,
      source: "crm" as const,
    }))
    .filter((colleague) => colleague.name)
    .slice(0, MAX_COLLEAGUES);
}

async function webColleagues(
  companyName: string,
  domain: string,
  colleagueRolesHint: string,
  model: string | null,
): Promise<Colleague[]> {
  const client = new Anthropic({ apiKey: getEnv().ANTHROPIC_API_KEY });

  try {
    const response = await client.messages.create({
      model: model ?? getEnv().ANTHROPIC_MODEL,
      max_tokens: 800,
      tools: [
        {
          type: "web_search_20250305",
          name: "web_search",
          max_uses: MAX_WEB_SEARCHES,
        } as Anthropic.Messages.ToolUnion,
      ],
      messages: [
        {
          role: "user",
          content: `Find people who currently work at the company "${companyName}" (website domain: ${domain}) in these kinds of roles: ${colleagueRolesHint}. Use at most ${MAX_WEB_SEARCHES} web searches (LinkedIn results and the company website are the best sources). Then output ONLY a JSON array, no prose: [{"name": "...", "title": "..." or null}]. Only include real names you actually found. Never guess or invent. If you find nobody, output [].`,
        },
      ],
    });

    const text = response.content.filter((block) => block.type === "text").map((block) => block.text).join("\n");
    const match = text.match(/\[[\s\S]*\]/);
    if (!match) return [];
    const parsed = JSON.parse(match[0]) as { name?: unknown; title?: unknown }[];
    return parsed
      .map((entry) => ({
        name: String(entry.name ?? "").trim(),
        title: entry.title ? String(entry.title).slice(0, 120) : null,
        email: null,
        source: "web" as const,
      }))
      .filter((colleague) => colleague.name && colleague.name.length <= 80)
      .slice(0, MAX_COLLEAGUES);
  } catch {
    // Research is a nice-to-have; drafting proceeds without it.
    return [];
  }
}

/**
 * Colleagues at the lead's company, for name-dropping in reply drafts.
 * CRM first (free); web search only when the CRM comes up short.
 */
export async function researchColleagues(input: {
  leadEmail: string;
  companyName: string | null;
  colleagueResearchEnabled: boolean;
  colleagueRolesHint: string;
  model?: string | null;
}): Promise<Colleague[]> {
  const domain = input.leadEmail.split("@")[1]?.toLowerCase();
  if (!domain) return [];

  const fromCrm = await crmColleagues(domain, input.leadEmail);
  if (!input.colleagueResearchEnabled || fromCrm.length >= MIN_CRM_HITS) return fromCrm;

  const fromWeb = await webColleagues(
    input.companyName || domain,
    domain,
    input.colleagueRolesHint,
    input.model ?? null,
  );

  // Dedupe by name (CRM wins — it has emails).
  const seen = new Set(fromCrm.map((c) => c.name.toLowerCase()));
  return [...fromCrm, ...fromWeb.filter((c) => !seen.has(c.name.toLowerCase()))].slice(0, MAX_COLLEAGUES);
}

/**
 * Research with carry-forward: a newer reply supersedes the old proposal but
 * inherits its company research. Any proposal for the same domain within the
 * TTL (even one that found nobody) means we already paid for the answer.
 */
export async function getColleagues(input: {
  leadEmail: string;
  companyName: string | null;
  colleagueResearchEnabled: boolean;
  colleagueRolesHint: string;
  model?: string | null;
}): Promise<Colleague[]> {
  const domain = input.leadEmail.split("@")[1]?.toLowerCase();
  if (!domain) return [];

  if (!input.colleagueResearchEnabled) {
    return crmColleagues(domain, input.leadEmail);
  }

  const { data } = await getAdminClient()
    .from("reply_proposals")
    .select("research")
    .not("research", "is", null)
    .ilike("lead_email", `%@${escapeLike(domain)}`)
    .gte("created_at", new Date(Date.now() - RESEARCH_TTL_DAYS * 86_400_000).toISOString())
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (data && Array.isArray(data.research)) {
    return (data.research as Colleague[]).slice(0, MAX_COLLEAGUES);
  }

  return researchColleagues(input);
}
