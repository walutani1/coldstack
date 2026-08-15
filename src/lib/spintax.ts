import "server-only";

import { runOneShotPrompt } from "@/lib/llm-oneshot";

/* Smartlead spintax rules (verified against their help center):
   spin blocks use SINGLE braces with pipes, {like this|as in this}, and can
   sit anywhere in a line alongside {{variables}}, which use double braces
   and must be left untouched. */

export type SpintaxResult =
  | { ok: true; spintax: string }
  | { ok: false; error: string };

export type SpintaxOptions = {
  // Free-form operator guidance folded into the prompt ("keep it casual",
  // "vary the opener more, never reword the ask").
  instructions?: string;
  // Gateway "vendor/model" id. Unset keeps the default direct Anthropic call.
  model?: string;
};

function balancedBraces(value: string): boolean {
  let depth = 0;
  for (const char of value) {
    if (char === "{") depth += 1;
    if (char === "}") depth -= 1;
    if (depth < 0) return false;
  }
  return depth === 0;
}

function buildPrompt(text: string, instructions?: string): string {
  return [
    "Rewrite the given cold-email line as Smartlead spintax.",
    "Rules:",
    "- Spin blocks use SINGLE curly braces with pipe separators: {option one|option two|option three}.",
    "- Give 3 or 4 natural-sounding options per spun segment. Spin the phrases that benefit from variation; keep anchor words shared.",
    "- Preserve any {{variable}} tokens (double braces) exactly as written, outside the spin options or repeated identically inside each option.",
    "- Keep the meaning, register, and rough length of the original.",
    "- No nested spin blocks. No em dashes.",
    "- Return ONLY the spintax line, no explanations, no quotes, no markdown.",
    ...(instructions
      ? ["Extra guidance from the operator (follow it within the rules above):", instructions]
      : []),
    `LINE: ${text}`,
  ].join("\n");
}

export async function generateSpintax(text: string, options: SpintaxOptions = {}): Promise<SpintaxResult> {
  const result = await runOneShotPrompt(buildPrompt(text, options.instructions), {
    model: options.model,
    maxTokens: 500,
    timeoutMs: 30_000,
    timeoutMessage: "The spintax request timed out.",
  });
  if (!result.ok) return result;

  const spintax = result.text.trim().replace(/^```[a-z]*\s*/i, "").replace(/\s*```$/, "").replace(/—/g, ",").trim();
  if (!spintax) return { ok: false, error: "The model returned no spintax." };
  if (!balancedBraces(spintax)) return { ok: false, error: "The model returned unbalanced braces. Try again." };
  if (spintax.length > 1200) return { ok: false, error: "The result came back too long. Try a shorter line." };
  return { ok: true, spintax };
}
