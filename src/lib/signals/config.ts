import "server-only";

import { z } from "zod";
import { getAdminClient } from "@/lib/supabase/admin";
import type { FunnelConfig, FunnelConfigVersion } from "@/lib/signals/types";

// Versioned funnel configuration. Every save inserts a new immutable row in
// signal_configs; the highest version is active. Stage results record the
// version that produced them, so audits stay explainable after tuning.

const configSchema = z.object({
  studioContext: z.string().trim().min(1).max(6000),
  headcount: z.object({ min: z.number().int().min(1).max(100_000), max: z.number().int().min(1).max(1_000_000) }),
  industries: z.object({
    blocked: z.array(z.string().trim().min(1).max(80)).max(50),
    preferred: z.array(z.string().trim().min(1).max(80)).max(50),
  }),
  evidenceWindowDays: z.number().int().min(7).max(365),
  jdTopN: z.number().int().min(1).max(5),
  models: z.object({
    agency: z.string().trim().min(1).max(60),
    facts: z.string().trim().min(1).max(60),
    titleGate: z.string().trim().min(1).max(60),
    jdScoring: z.string().trim().min(1).max(60),
  }),
  weights: z.object({
    sizeFit: z.number().int().min(0).max(100),
    industryFit: z.number().int().min(0).max(100),
    titleStrength: z.number().int().min(0).max(100),
    jdSignals: z.number().int().min(0).max(100),
    evidenceVolume: z.number().int().min(0).max(100),
  }),
  qualifiedThreshold: z.number().int().min(1).max(100),
  prompts: z.object({
    agency: z.string().trim().min(1).max(4000),
    titleGate: z.string().trim().min(1).max(4000),
    jdScoring: z.string().trim().min(1).max(4000),
  }),
  spend: z.object({
    perRunCapUsd: z.number().min(0.5).max(200),
    perCompanyMaxTokens: z.number().int().min(5_000).max(500_000),
  }),
});

// Starter studio context: a fictional worked example showing the level of
// specificity the funnel needs to score well. Rewrite it in the Signals
// config UI to describe YOUR business, the hiring signal you act on, and
// your valid/invalid role rules before running the funnel for real.
const DEFAULT_STUDIO_CONTEXT = `EXAMPLE — replace with your own business context in Settings → Signals.

We are an agency that designs and runs customer-support operations for mid-sized e-commerce brands — help desk setup, macros and automation, self-service knowledge bases, and support analytics. Our sweet spot is brands with 20–200 employees whose support still runs on shared inboxes and spreadsheets.

Our hiring-signal play: when such a company posts a job to build out or modernize customer support — a first support-operations hire, a help-desk migration, a CX-systems role — we reach out and offer to stand up part of that work before they finish hiring.

THE KEY DISTINCTION: we want the systems/operations hire that signals a support transformation, NOT the routine frontline roles these companies always hire.

VALID signal roles (any of):
- Support operations: Support Operations Manager/Analyst, CX Operations, Customer Experience Systems, Help Desk Administrator (Zendesk/Intercom/Gorgias admin).
- Support tooling & automation: Support Automation Specialist, Chatbot/AI Support Specialist, Knowledge Base Manager, Self-Service Lead.
- First-of-kind leadership at a company without a support org: Head of Support at a brand that clearly has none today.

NOT VALID — kill these (routine roles they already hire):
- Frontline agents: Customer Service Representative, Support Agent, Call Center roles at any volume.
- Adjacent-but-different: Sales Ops, Marketing Ops, IT helpdesk for internal employees.
- Any role at a company whose product IS customer-support software or outsourced support.

AMBIGUITY RULE: a vague title ("Operations Specialist", "Systems Analyst") is valid ONLY if the description is about customer-support processes, tooling, or automation. If it reads like general admin or internal IT, kill it.

Strong JD signals: shared inbox overwhelmed, "first hire of this kind", migrate to a help desk, build macros/workflows, reduce response times, evaluate AI/chatbots, knowledge base from scratch. Weak/negative: mature support org, existing support-ops team, seasonal agent hiring.`;

const DEFAULT_AGENCY_PROMPT = `Decide whether the company that posted these jobs is a staffing agency, recruiting firm, or job board posting on behalf of unnamed clients — rather than the actual employer. Recruiters, "talent solutions", staffing, RPO, and IT-consulting bodyshops that place contractors count as agencies. A normal company hiring for itself does not.`;

const DEFAULT_TITLE_GATE_PROMPT = `Using the studio context, decide whether AT LEAST ONE of these job titles is a genuine signal role we could act on under the context's VALID rules. Titles matching the context's NOT VALID rules never pass. Apply the ambiguity rule: a vague title only passes when the description clearly matches what the context targets. When unsure, fail the gate (precision over recall) and say why.`;

const DEFAULT_JD_PROMPT = `Using the studio context, read the job descriptions and score this company as an outreach target. First verify the role really matches the context's VALID rules — if the description matches a NOT VALID pattern, score title_strength and jd_signals near zero. Then judge: how well their industry fits the target profile, how strong the valid titles are as a signal, and what the descriptions reveal about the need the context targets. Be conservative — inflated scores waste outreach; say "unknown" rather than invent facts.`;

export const DEFAULT_FUNNEL_CONFIG: FunnelConfig = {
  studioContext: DEFAULT_STUDIO_CONTEXT,
  headcount: { min: 20, max: 200 },
  industries: {
    // Companies that build or sell what you offer are never your buyer —
    // block them so they die free at the deterministic screen.
    blocked: [
      "Staffing and Recruiting",
      "Human Resources Services",
      "Software Development",
      "IT Services and IT Consulting",
      "Outsourcing and Offshoring Consulting",
    ],
    preferred: [
      "Retail",
      "E-commerce",
      "Consumer Goods",
      "Apparel and Fashion",
      "Food and Beverage Services",
    ],
  },
  evidenceWindowDays: 45,
  jdTopN: 3,
  models: {
    agency: "claude-haiku-4-5",
    facts: "claude-haiku-4-5",
    titleGate: "claude-haiku-4-5",
    jdScoring: "claude-sonnet-5",
  },
  weights: { sizeFit: 25, industryFit: 20, titleStrength: 20, jdSignals: 25, evidenceVolume: 10 },
  qualifiedThreshold: 70,
  prompts: { agency: DEFAULT_AGENCY_PROMPT, titleGate: DEFAULT_TITLE_GATE_PROMPT, jdScoring: DEFAULT_JD_PROMPT },
  spend: { perRunCapUsd: 5, perCompanyMaxTokens: 60_000 },
};

export async function getActiveFunnelConfig(): Promise<FunnelConfigVersion> {
  const db = getAdminClient();
  const { data, error } = await db
    .from("signal_configs")
    .select("version, config, note, created_at")
    .order("version", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`Could not load funnel config: ${error.message}`);
  if (data) {
    const parsed = configSchema.safeParse(data.config);
    // A stored config that fails today's schema (e.g. after a code change)
    // falls back to defaults for the missing parts rather than breaking runs.
    const config = parsed.success ? parsed.data : { ...DEFAULT_FUNNEL_CONFIG, ...(data.config as Partial<FunnelConfig>) };
    return { version: data.version as number, config: config as FunnelConfig, createdAt: data.created_at as string, note: (data.note as string | null) ?? null };
  }
  // First use: seed version 1 with defaults.
  return saveFunnelConfig(DEFAULT_FUNNEL_CONFIG, "Seeded defaults", null);
}

export async function saveFunnelConfig(input: unknown, note: string | null, createdBy: string | null): Promise<FunnelConfigVersion> {
  const config = configSchema.parse(input);
  if (config.headcount.min > config.headcount.max) throw new Error("Headcount min cannot exceed max.");
  const db = getAdminClient();
  const { data, error } = await db
    .from("signal_configs")
    .insert({ config, note, created_by: createdBy })
    .select("version, config, note, created_at")
    .single();
  if (error || !data) throw new Error(`Could not save funnel config: ${error?.message}`);
  return { version: data.version as number, config: data.config as FunnelConfig, createdAt: data.created_at as string, note: (data.note as string | null) ?? null };
}

export async function getFunnelConfigVersion(version: number): Promise<FunnelConfig | null> {
  const db = getAdminClient();
  const { data } = await db.from("signal_configs").select("config").eq("version", version).maybeSingle();
  return data ? (data.config as FunnelConfig) : null;
}
