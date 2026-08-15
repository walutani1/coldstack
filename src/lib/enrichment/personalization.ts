import "server-only";

import { z } from "zod";
import { reasoningOptions, runEnrichmentPrompt, type EnrichmentPromptResult } from "@/lib/enrichment/llm-runner";
import type { Coworker, EnrichmentLead } from "@/lib/enrichment/types";
import { getAdminClient } from "@/lib/supabase/admin";

export const PERSONALIZATION_COLUMNS = ["final_first_name", "final_title", "final_company_name", "operations_task", "ops_candidate"] as const;
export type PersonalizationColumn = (typeof PERSONALIZATION_COLUMNS)[number];
export const AI_PERSONALIZATION_COLUMNS = ["final_first_name", "final_title", "final_company_name", "ops_candidate"] as const;
export type AiPersonalizationColumn = (typeof AI_PERSONALIZATION_COLUMNS)[number];
export const MANUFACTURING_OPS_TASK = "order intake and scheduling";
export const OPS_CANDIDATE_FALLBACK = "someone on your ops team";

export const DEFAULT_PERSONALIZATION_PROMPTS: Record<AiPersonalizationColumn, string> = {
  final_first_name: "Normalize the lead's first name for a cold email. Return only a clean human first name with natural capitalization. Remove last names, initials, honorifics, punctuation, and placeholders. Return an empty value if it cannot be trusted.",
  final_title: "Normalize the raw job title for the sentence I noticed you're {{title}}. Return a short, all-lowercase English noun phrase including a, an, or the. Remove seniority filler, locations, company names, and separator tails. Prefer natural shorthand. Return only the phrase.",
  final_company_name: "Normalize the company name as an employee would casually say it. Remove legal suffixes, trademark symbols, and noisy punctuation while keeping meaningful brand words. Return only the cleaned company name.",
  ops_candidate: `Select the same-company operations coworker's clean first name for the phrase thought it might be you or {{ops_candidate}}. If unavailable or untrustworthy, return "${OPS_CANDIDATE_FALLBACK}". Return only the value.`,
};

export type NormalizationExample = { original: string; normalized: string };

const promptConfigSchema = z.object({
  prompts: z.object({
    final_first_name: z.string().trim().min(1).max(8000),
    final_title: z.string().trim().min(1).max(8000),
    final_company_name: z.string().trim().min(1).max(8000),
    ops_candidate: z.string().trim().min(1).max(8000),
  }),
  // Per-column few-shot pairs (Original -> Normalized) appended to the prompt.
  examples: z.record(
    z.string(),
    z.array(z.object({ original: z.string().max(300), normalized: z.string().max(300) })).max(20),
  ).default({}),
  updatedAt: z.string().optional(),
  updatedAtByColumn: z.record(z.string(), z.string()).default({}),
  models: z.record(z.string(), z.string()).default({}),
}).strict();

export type PersonalizationPromptConfig = z.infer<typeof promptConfigSchema>;
const DEFAULT_PROMPT_CONFIG: PersonalizationPromptConfig = promptConfigSchema.parse({ prompts: DEFAULT_PERSONALIZATION_PROMPTS });
const SETTINGS_KEY = "enrichment_prompts";

export async function getPersonalizationPromptConfig(): Promise<PersonalizationPromptConfig> {
  const { data, error } = await getAdminClient().from("app_settings").select("value").eq("key", SETTINGS_KEY).maybeSingle();
  if (error || !data) return DEFAULT_PROMPT_CONFIG;
  try {
    const value = data.value && typeof data.value === "object" && !Array.isArray(data.value)
      ? data.value as Record<string, unknown>
      : {};
    const prompts = value.prompts && typeof value.prompts === "object" && !Array.isArray(value.prompts)
      ? value.prompts as Record<string, unknown>
      : {};
    return promptConfigSchema.parse({ ...DEFAULT_PROMPT_CONFIG, ...value, prompts: { ...DEFAULT_PERSONALIZATION_PROMPTS, ...prompts } });
  } catch { return DEFAULT_PROMPT_CONFIG; }
}

export async function savePersonalizationPromptConfig(value: unknown, updatedBy: string): Promise<PersonalizationPromptConfig> {
  const parsed = promptConfigSchema.parse(value);
  const saved = { ...parsed, updatedAt: new Date().toISOString() };
  const { error } = await getAdminClient().from("app_settings").upsert({
    key: SETTINGS_KEY, value: saved, updated_at: saved.updatedAt, updated_by: updatedBy,
  });
  if (error) throw new Error(error.message);
  return saved;
}

const COMPANY_SUFFIX_PATTERN = /\b(incorporated|inc|llc|l\.l\.c|ltd|limited|corp|corporation|co|company|plc|gmbh|ag|sa|s\.a|srl|bv|nv|lp|llp|holdings?|group)\b\.?/gi;
const TITLE_NOISE_PATTERN = /\b(sr|senior|jr|ii|iii|iv|remote|hybrid|full[-\s]?time|part[-\s]?time)\b\.?/gi;

export function normalizeFirstName(value: string | null | undefined): string | null {
  const cleaned = value?.replace(/\([^)]*\)/g, " ").replace(/["'`]/g, "").replace(/[^a-zA-ZÀ-ž\s-]/g, " ").replace(/\s+/g, " ").trim();
  const first = cleaned?.split(/\s+/)[0];
  if (!first || first.length < 2) return null;
  return first.split("-").filter(Boolean).map((part) => part[0].toUpperCase() + part.slice(1).toLowerCase()).join("-");
}

export function normalizeCompanyName(company: string | null | undefined): string | null {
  if (!company) return null;
  const clean = company.replace(/\([^)]*\)/g, " ").replace(/[®,™]/g, "").replace(/[,&]+$/g, "").replace(COMPANY_SUFFIX_PATTERN, "").replace(/\s{2,}/g, " ").replace(/\s+[,.-]\s*$/g, "").trim();
  return clean || company.trim();
}

export function normalizeTitle(title: string | null | undefined): string | null {
  if (!title) return null;
  let clean = title.replace(/\([^)]*\)/g, " ").replace(/(\s[-–]\s|[|/]).*$/g, " ").replace(/\bat\s+[\w.&' -]+$/i, " ").replace(TITLE_NOISE_PATTERN, "").replace(/\s+/g, " ").trim().toLowerCase();
  const replacements: [RegExp, string][] = [
    [/\bvice president\b/g, "vp"], [/\bchief executive officer\b/g, "ceo"], [/\bchief operating officer\b/g, "coo"],
    [/\bchief financial officer\b/g, "cfo"], [/\bgestionnaire\b/g, "manager"], [/\bdirecteur\b|\bdirectrice\b/g, "director"],
    [/\bopérations?\b/g, "operations"], [/\busine\b/g, "plant"],
  ];
  for (const [pattern, replacement] of replacements) clean = clean.replace(pattern, replacement);
  clean = clean.split(/\s*,\s*/)[0].replace(/^(a|an|the)\s+/, "").replace(/^vp (?!of\b)/, "vp of ").replace(/[\s.,;:-]+$/g, "").trim();
  if (!clean) return null;
  const singular = /\b(ceo|coo|cfo|cto|president|vp|director|head|chief|owner|founder|gm|manager)\b/.test(clean);
  return `${singular ? "the" : /^[aeiou]/.test(clean) ? "an" : "a"} ${clean}`;
}

export function sanitizeFinalTitle(value: string | null | undefined, rawTitle: string | null | undefined): string | null {
  const normalized = normalizeTitle(value);
  const bare = normalized?.replace(/^(a|an|the)\s+/, "") ?? "";
  return !normalized || /^(leading|managing|heading|overseeing|running|driving)\b/.test(bare) ? normalizeTitle(rawTitle) : normalized;
}

export function deterministicValue(column: PersonalizationColumn, lead: EnrichmentLead, coworker?: Coworker | null): string | null {
  if (column === "final_first_name") return normalizeFirstName(lead.firstName);
  if (column === "final_title") return normalizeTitle(lead.title);
  if (column === "final_company_name") return normalizeCompanyName(lead.company);
  if (column === "operations_task") return MANUFACTURING_OPS_TASK;
  return normalizeFirstName(coworker?.firstName) ?? OPS_CANDIDATE_FALLBACK;
}

// Few-shot Original -> Normalized pairs appended to the column prompt so the
// model matches the operator's normalization by example.
function personalizationExamplesBlock(examples: NormalizationExample[]): string {
  const clean = examples
    .map((e) => ({ original: e.original.trim(), normalized: e.normalized.trim() }))
    .filter((e) => e.original && e.normalized);
  if (!clean.length) return "";
  return `\n\nExamples (Original -> Normalized):\n${clean.map((e) => `- ${JSON.stringify(e.original)} -> ${JSON.stringify(e.normalized)}`).join("\n")}`;
}

export function buildPersonalizationPrompt(column: PersonalizationColumn, prompt: string, lead: EnrichmentLead, coworker?: Coworker | null, examples: NormalizationExample[] = []): string {
  return `You are generating one Clay-style table cell value.\n\nDo not browse the web.\nDo not inspect or edit files.\nDo not call tools.\nReturn only valid JSON matching this exact shape:\n{"value":"..."}\n\nColumn: ${column}\n\nColumn prompt:\n${prompt}${personalizationExamplesBlock(examples)}\n\nCurrent lead source data:\n${JSON.stringify({ first_name: lead.firstName, last_name: lead.lastName, title: lead.title, company: lead.company, domain: lead.domain, email: lead.email, role_level: lead.roleLevel, send_wave: lead.sendWave }, null, 2)}\n\nSame-company coworker source data:\n${JSON.stringify(coworker ? { first_name: coworker.firstName, role_level: coworker.roleLevel } : null, null, 2)}\n\nRules:\n- Return one concise string value for the requested column.\n- Always write the value in natural English; if the source data is in another language, translate its meaning to English (keep people's names and brand names as they are).\n- Do not include markdown, code fences, explanations, or extra keys.\n- If the column prompt says to return an empty value, use {"value":""}.`;
}

export function parsePersonalizationValue(output: string): string | null {
  const clean = output.trim();
  const candidate = clean.match(/\{[\s\S]*\}/)?.[0] ?? clean;
  let value: unknown;
  try { value = (JSON.parse(candidate) as { value?: unknown }).value; }
  catch { value = clean.replace(/^```(?:json)?/i, "").replace(/```$/i, ""); }
  if (typeof value !== "string") return null;
  const sanitized = value.replace(/\r?\n/g, " ").replace(/^["']|["']$/g, "").replace(/\s+/g, " ").trim();
  return sanitized && sanitized.length <= 180 ? sanitized : null;
}

export type PersonalizationGeneration =
  | { ok: true; value: string; provider: string; fallback: boolean; runner: EnrichmentPromptResult }
  | { ok: false; message: string; provider: string; kind: "auth" | "rate_limit" | "timeout" | "transport"; retryAfterMs?: number };

export async function generatePersonalizationValue(column: PersonalizationColumn, lead: EnrichmentLead, model: string, coworker?: Coworker | null, reasoningEffort?: string | null): Promise<PersonalizationGeneration> {
  const config = await getPersonalizationPromptConfig();
  const prompt = column === "operations_task"
    ? `Return only the concise operations task "${MANUFACTURING_OPS_TASK}" unless the source data clearly requires an equally concise correction.`
    : config.prompts[column];
  const examples = config.examples?.[column] ?? [];
  const runner = await runEnrichmentPrompt(buildPersonalizationPrompt(column, prompt, lead, coworker, examples), { model, ...reasoningOptions(512, reasoningEffort) });
  if (runner.ok) {
    const parsed = parsePersonalizationValue(runner.text);
    const value = column === "final_title" ? sanitizeFinalTitle(parsed, lead.title) : parsed;
    if (value) return { ok: true, value, provider: runner.provider, fallback: false, runner };
  } else if (runner.kind !== "refusal") {
    return { ok: false, message: runner.message, provider: runner.provider, kind: runner.kind, retryAfterMs: runner.retryAfterMs };
  }
  const fallback = deterministicValue(column, lead, coworker);
  return fallback
    ? { ok: true, value: fallback, provider: runner.provider, fallback: true, runner }
    : { ok: false, message: `${column} could not be generated from the available source data.`, provider: runner.provider, kind: "transport" };
}
