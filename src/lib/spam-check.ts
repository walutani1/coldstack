import "server-only";

import { z } from "zod";
import { runOneShotPrompt } from "@/lib/llm-oneshot";

/* Focused deliverability read of one cold-email draft: a single model call
   that scores spam-filter risk and pins it to the exact phrases that create
   it, each with a concrete fix (replacement word or rewritten sentence).
   {{variables}} and {a|b} spintax are evaluated as filled/worst-option, never
   flagged as spam themselves. */

export const spamFindingSchema = z.object({
  phrase: z.string().trim().min(1).max(200),
  field: z.enum(["subject", "body"]),
  reason: z.string().trim().min(1).max(160),
  severity: z.enum(["low", "medium", "high"]),
  suggestion: z.string().trim().min(1).max(400),
  suggestionKind: z.enum(["replacement", "rewrite"]),
}).strict();

export const spamCheckSchema = z.object({
  score: z.number().int().min(0).max(100),
  verdict: z.enum(["low", "medium", "high"]),
  summary: z.string().trim().min(1).max(240),
  findings: z.array(spamFindingSchema).max(8),
}).strict();

export type SpamCheckResult = z.infer<typeof spamCheckSchema> & {
  /** Findings the model claimed but that failed grounding: the phrase is not
      verbatim in the copy, or the suggestion does not actually change it. */
  droppedFindings: number;
};

export type SpamCheckOptions = {
  // Gateway "vendor/model" id. Unset keeps the default direct Anthropic call.
  model?: string;
};

function cleanText(value: string): string {
  return value.replace(/—/g, ",");
}

// Case/whitespace-insensitive equality: "Head of Partnerships" suggested as
// the fix for "Head of Partnerships" is a no-op, not a finding.
function sameText(a: string, b: string): boolean {
  const normalize = (value: string) => value.replace(/\s+/g, " ").trim().toLowerCase();
  return normalize(a) === normalize(b);
}

export async function runSpamCheck(
  input: { subject: string; body: string },
  options: SpamCheckOptions = {},
): Promise<{ ok: true; result: SpamCheckResult } | { ok: false; error: string }> {
  const prompt = [
    "You are an email deliverability specialist reviewing ONE cold-email draft before it is sent through Google/Microsoft mailboxes.",
    "Score how likely this copy is to be filtered to spam, considering: trigger words (free, guarantee, act now, pricing pressure), shouty formatting (all caps, !!, $$$), deceptive framing, link/attachment bait phrasing, and overall salesiness relative to a plain human note. Shorter, plainer, personal copy scores lower.",
    "The draft may contain {{variables}} (assume a sensible personal value is filled in) and {option a|option b} spin blocks (judge the riskiest option). NEVER flag the braces syntax itself.",
    "Only flag wording the sender can rewrite. NEVER flag factual identifiers - a person's name, job title, company name, or the value a {{variable}} fills in. A fix cannot change facts.",
    "Return STRICT JSON only, no markdown, exactly this shape:",
    '{"score": <int 0-100, 0 = clean inbox-ready, 100 = near-certain spam>, "verdict": "low"|"medium"|"high", "summary": <one sentence, max 200 chars>, "findings": [{"phrase": <EXACT substring copied verbatim from the subject or body>, "field": "subject"|"body", "reason": <why it raises filter risk, max 140 chars>, "severity": "low"|"medium"|"high", "suggestion": <a drop-in replacement word/phrase OR a rewritten version of the sentence>, "suggestionKind": "replacement"|"rewrite"}]}',
    "Suggestion rules: the suggestion must genuinely change the risky wording - never repeat the phrase unchanged or nearly unchanged. A \"replacement\" must read grammatically when swapped in for the exact phrase; when no drop-in substitute works, rewrite the whole sentence and mark it \"rewrite\". If you cannot offer a better wording, leave that finding out entirely.",
    "Rules: at most 8 findings, ordered most damaging first. Every phrase MUST be copied character-for-character from the draft. verdict low = score 0-24, medium = 25-59, high = 60-100. No em dashes anywhere.",
    `SUBJECT: ${JSON.stringify(input.subject)}`,
    `BODY: ${JSON.stringify(input.body)}`,
  ].join("\n");

  // Temperature 0 so the same draft scores the same on every run (Anthropic
  // path only; see runOneShotPrompt).
  const response = await runOneShotPrompt(prompt, {
    model: options.model,
    maxTokens: 1200,
    timeoutMs: 45_000,
    timeoutMessage: "The spam check timed out. Run it again.",
    temperature: 0,
  });
  if (!response.ok) return response;

  const candidate = response.text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  let parsed: z.infer<typeof spamCheckSchema>;
  try {
    parsed = spamCheckSchema.parse(JSON.parse(candidate));
  } catch {
    return { ok: false, error: "The model returned an invalid spam report. Run the check again." };
  }
  /* Ground every finding: a phrase that is not verbatim in its field is a
     hallucination, and a suggestion that leaves the phrase unchanged fixes
     nothing - both get dropped rather than shown as applyable. */
  const grounded = parsed.findings.filter(
    (finding) =>
      (finding.field === "subject" ? input.subject : input.body).includes(finding.phrase) &&
      !sameText(finding.suggestion, finding.phrase),
  );
  return {
    ok: true,
    result: {
      ...parsed,
      summary: cleanText(parsed.summary),
      findings: grounded.map((finding) => ({
        ...finding,
        reason: cleanText(finding.reason),
        suggestion: cleanText(finding.suggestion),
      })),
      droppedFindings: parsed.findings.length - grounded.length,
    },
  };
}
