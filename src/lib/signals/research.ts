import "server-only";

import Anthropic from "@anthropic-ai/sdk";
import { getEnv } from "@/lib/env";
import { getSecret } from "@/lib/secrets";
import { AI_GATEWAY_DEFAULT_BASE_URL } from "@/lib/enrichment/llm-runner";
import { getAdminClient } from "@/lib/supabase/admin";
import { firecrawlScrape, firecrawlSearch, type WebSearchResult } from "@/lib/signals/firecrawl";
import { getActiveFunnelConfig } from "@/lib/signals/config";
import { COMPANY_COLUMNS, toCompanyDto } from "@/lib/signals/store";
import type { SignalCompanyDto } from "@/lib/signals/types";

// Vendor-prefixed ids route through the AI Gateway (same convention as the
// funnel stages); a bare Claude id stays on the first-party Anthropic API.
// SIGNALS_RESEARCH_MODEL still overrides either way.
const RESEARCH_MODEL = process.env.SIGNALS_RESEARCH_MODEL || "openai/gpt-5.6-luna";

const HOMEPAGE_CAP = 15_000;

// Aggregators and socials never count as "the company's website".
const NON_COMPANY_HOSTS =
  /linkedin\.com|indeed\.com|glassdoor\.|ziprecruiter\.com|facebook\.com|instagram\.com|twitter\.com|x\.com|youtube\.com|wikipedia\.org|crunchbase\.com|bloomberg\.com|yelp\.com|bbb\.org/i;

function pickWebsite(results: WebSearchResult[]): string | null {
  for (const result of results) {
    try {
      const url = new URL(result.url);
      if (NON_COMPANY_HOSTS.test(url.hostname)) continue;
      return `${url.protocol}//${url.hostname}`;
    } catch {
      continue;
    }
  }
  return null;
}

function buildPrompt(input: {
  name: string;
  industries: string | null;
  websiteUrl: string | null;
  hiringTitles: string[];
  homepage: string;
  snippets: WebSearchResult[];
  studioContext: string;
}): string {
  const snippetBlock = input.snippets
    .slice(0, 6)
    .map((s) => `- ${s.title ?? s.url} (${s.url})${s.description ? `: ${s.description.slice(0, 300)}` : ""}`)
    .join("\n");
  return [
    "You are a sales researcher for the business described in the studio context below. Our outreach hook: when a company posts a job matching the context's hiring signal, we reach out and offer to deliver part of that work — often before they finish hiring for it.",
    "",
    "Studio context:",
    input.studioContext.slice(0, 2_500),
    "",
    `Research subject: ${input.name}`,
    input.industries ? `LinkedIn industry: ${input.industries}` : "",
    input.websiteUrl ? `Website: ${input.websiteUrl}` : "Website: not found",
    input.hiringTitles.length > 0 ? `Currently hiring (from LinkedIn job postings): ${input.hiringTitles.join("; ")}` : "",
    "",
    "Web search snippets:",
    snippetBlock || "(none)",
    "",
    "Homepage content (markdown, truncated):",
    input.homepage ? input.homepage.slice(0, HOMEPAGE_CAP) : "(homepage could not be scraped)",
    "",
    "Write a concise research brief in markdown. Use exactly these ### sections:",
    "### What they do",
    "### Scale & operations",
    "### Signal evidence",
    "### Why the hiring signal matters",
    "### Outreach angle",
    "Rules: under 350 words total. Only state facts supported by the material above; say \"unknown\" rather than invent. The outreach angle must reference the specific role(s) they are hiring for. No preamble, start directly with the first section header.",
  ]
    .filter((line) => line !== "")
    .join("\n");
}

export type ResearchOutcome = { company: SignalCompanyDto; started: boolean };

// Plain-prose completion for the brief, routed by model id: gateway for
// prefixed ids, first-party Anthropic otherwise.
async function completeBrief(model: string, prompt: string): Promise<string> {
  if (model.includes("/")) {
    const stored = await getSecret("ai_gateway_api_key").catch(() => null);
    const apiKey = stored ?? process.env.AI_GATEWAY_API_KEY ?? "";
    if (!apiKey) throw new Error("Missing AI Gateway key. Add it under Settings → Integrations, or set AI_GATEWAY_API_KEY.");
    const baseUrl = (process.env.AI_GATEWAY_BASE_URL || AI_GATEWAY_DEFAULT_BASE_URL).replace(/\/+$/, "");
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model, max_completion_tokens: 1500, messages: [{ role: "user", content: prompt }] }),
      signal: AbortSignal.timeout(90_000),
    });
    if (response.status === 402) throw new Error("The AI Gateway has no credit. Fund it at vercel.com or set SIGNALS_RESEARCH_MODEL back to a Claude id.");
    if (response.status === 401 || response.status === 403) throw new Error("The AI Gateway rejected the API key.");
    if (!response.ok) throw new Error(`AI Gateway request failed: ${response.status} ${(await response.text()).slice(0, 200)}`);
    const body = (await response.json()) as { choices?: { message?: { content?: string | null } }[] };
    return (body.choices?.[0]?.message?.content ?? "").trim();
  }
  const anthropic = new Anthropic({ apiKey: getEnv().ANTHROPIC_API_KEY });
  const response = await anthropic.messages.create({
    model,
    max_tokens: 1500,
    messages: [{ role: "user", content: prompt }],
  });
  return response.content
    .filter((block): block is Anthropic.TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("\n")
    .trim();
}

// supabase-js cannot statically parse a select() built from a shared column
// constant, so rows come back typed as errors; cast through the DTO mapper's
// own input type instead of re-declaring the row shape here.
type CompanyRow = Parameters<typeof toCompanyDto>[0];
const asCompanyRow = (row: unknown): CompanyRow => row as CompanyRow;

// Full research pass for one company: discover website (Firecrawl search) ->
// scrape homepage -> LLM brief. Runs inline in a server action (~10-30s).
// A status CAS keeps two clicks from double-spending; rerun from done/failed
// is allowed (research is cheap and companies change).
export async function runCompanyResearch(companyId: string): Promise<ResearchOutcome> {
  const db = getAdminClient();
  // Claimable when not running — or when a "running" claim is stale (the
  // server died mid-research and nothing will ever finish it).
  const staleBefore = new Date(Date.now() - 3 * 60_000).toISOString();
  const { data: claimed, error: claimError } = await db
    .from("signal_companies")
    .update({ research_status: "running", research_error: null, updated_at: new Date().toISOString() })
    .eq("id", companyId)
    .or(`research_status.neq.running,updated_at.lt.${staleBefore}`)
    .select(COMPANY_COLUMNS);
  if (claimError) throw new Error(`Could not start research: ${claimError.message}`);
  if ((claimed ?? []).length === 0) {
    const { data: current } = await db.from("signal_companies").select(COMPANY_COLUMNS).eq("id", companyId).maybeSingle();
    if (!current) throw new Error("Company not found.");
    return { company: toCompanyDto(asCompanyRow(current)), started: false };
  }
  const company = asCompanyRow(claimed![0]);

  try {
    const { data: jobRows } = await db
      .from("signal_jobs")
      .select("title")
      .eq("company_id", companyId)
      .order("first_seen_at", { ascending: false })
      .limit(5);
    const hiringTitles = [...new Set((jobRows ?? []).map((row) => row.title as string))];

    // Website discovery + info snippets in one search.
    const query = `${company.name} ${company.industries ?? ""} company official website`.replace(/\s+/g, " ").trim();
    let snippets: WebSearchResult[] = [];
    try {
      snippets = await firecrawlSearch(query, 6);
    } catch {
      // Search down: research can still proceed on a known website alone.
    }
    const websiteUrl = (company.website_url as string | null) ?? pickWebsite(snippets);

    let homepage = "";
    let homepageTitle: string | null = null;
    if (websiteUrl) {
      try {
        const scraped = await firecrawlScrape(websiteUrl);
        homepage = scraped.markdown;
        homepageTitle = scraped.title;
      } catch {
        // A blocked homepage is not fatal; the brief says what it lacked.
      }
    }
    if (!homepage && snippets.length === 0) {
      throw new Error("No web material found: search returned nothing and the website could not be scraped.");
    }

    const { config } = await getActiveFunnelConfig();
    const brief = await completeBrief(
      RESEARCH_MODEL,
      buildPrompt({
        name: company.name as string,
        industries: company.industries as string | null,
        websiteUrl,
        hiringTitles,
        homepage,
        snippets,
        studioContext: config.studioContext,
      }),
    );
    if (!brief) throw new Error("The model returned an empty brief.");

    const sources = [
      ...(websiteUrl ? [{ url: websiteUrl, title: homepageTitle ?? "Company website" }] : []),
      ...snippets.map((s) => ({ url: s.url, title: s.title })),
    ].slice(0, 8);

    const { data: done, error: doneError } = await db
      .from("signal_companies")
      .update({
        website_url: websiteUrl,
        research_status: "done",
        research_brief: brief,
        research_sources: sources,
        research_model: RESEARCH_MODEL,
        research_error: null,
        researched_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("id", companyId)
      .select(COMPANY_COLUMNS)
      .single();
    if (doneError || !done) throw new Error(`Could not store research: ${doneError?.message}`);
    return { company: toCompanyDto(asCompanyRow(done)), started: true };
  } catch (error) {
    const message = (error instanceof Error ? error.message : "Research failed.").slice(0, 500);
    const { data: failed } = await db
      .from("signal_companies")
      .update({ research_status: "failed", research_error: message, updated_at: new Date().toISOString() })
      .eq("id", companyId)
      .select(COMPANY_COLUMNS)
      .single();
    if (failed) return { company: toCompanyDto(asCompanyRow(failed)), started: true };
    throw error;
  }
}
