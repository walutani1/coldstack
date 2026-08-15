import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { getEnv } from "@/lib/env";

export const ExtractionSchema = z.object({
  category: z.string(),
  positive_lead: z.boolean(),
  is_referral: z.boolean(),
  referee_name: z.string().nullable(),
  referee_title: z.string().nullable(),
  referee_email: z.string().nullable(),
  summary: z.string(),
  next_step: z.string(),
  reasoning: z.string(),
  is_automated: z.boolean(),
  dnc: z.boolean(),
  email_defunct: z.boolean(),
  temporary_absence: z.boolean(),
  ooo_return_date: z.string().nullable(),
});

export type Extraction = z.infer<typeof ExtractionSchema>;

// Structured-output schema: guarantees the response is valid JSON in exactly
// this shape, so no regex extraction is needed on the happy path.
function extractionJsonSchema(allowedValues: string[]) {
  return {
    type: "object",
    additionalProperties: false,
    required: [
      "category",
      "positive_lead",
      "is_referral",
      "referee_name",
      "referee_title",
      "referee_email",
      "summary",
      "next_step",
      "reasoning",
      "is_automated",
      "dnc",
      "email_defunct",
      "temporary_absence",
      "ooo_return_date",
    ],
    properties: {
      category: { type: "string", enum: allowedValues },
      positive_lead: { type: "boolean" },
      is_referral: { type: "boolean" },
      referee_name: { type: ["string", "null"] },
      referee_title: { type: ["string", "null"] },
      referee_email: { type: ["string", "null"] },
      summary: { type: "string" },
      next_step: { type: "string" },
      reasoning: { type: "string" },
      is_automated: { type: "boolean" },
      dnc: { type: "boolean" },
      email_defunct: { type: "boolean" },
      temporary_absence: { type: "boolean" },
      ooo_return_date: { type: ["string", "null"] },
    },
  };
}

let client: Anthropic | null = null;

function getClient() {
  if (!client) {
    client = new Anthropic({ apiKey: getEnv().ANTHROPIC_API_KEY });
  }
  return client;
}

function clamp(value: string | null, max: number) {
  return value ? value.slice(0, max) : value;
}

function normalize(extraction: Extraction, allowedValues: string[], fallbackValue: string): Extraction {
  return {
    ...extraction,
    category: allowedValues.includes(extraction.category) ? extraction.category : fallbackValue,
    referee_name: clamp(extraction.referee_name, 120),
    referee_title: clamp(extraction.referee_title, 160),
    referee_email: clamp(extraction.referee_email, 160),
    summary: extraction.summary.slice(0, 400),
    next_step: extraction.next_step.slice(0, 400),
    reasoning: extraction.reasoning.slice(0, 400),
    // Only a strict ISO date survives; anything else is treated as undated.
    ooo_return_date:
      extraction.ooo_return_date && /^\d{4}-\d{2}-\d{2}$/.test(extraction.ooo_return_date)
        ? extraction.ooo_return_date
        : null,
  };
}

export type CategorizeResult =
  | { ok: true; extraction: Extraction; model: string }
  | { ok: false; error: string };

/**
 * Categorize one reply via the Claude API. Uses structured outputs so the
 * response is schema-valid JSON; falls back to plain prompting + JSON
 * extraction if the configured model rejects output_config.
 */
export async function categorizeReply(
  prompt: string,
  options: { allowedValues: string[]; fallbackValue: string; model?: string | null },
): Promise<CategorizeResult> {
  const model = options.model ?? getEnv().ANTHROPIC_MODEL;
  const schema = extractionJsonSchema(options.allowedValues);

  try {
    let text: string | null = null;

    try {
      const response = await getClient().messages.create({
        model,
        max_tokens: 1500,
        messages: [{ role: "user", content: prompt }],
        output_config: { format: { type: "json_schema", schema } },
      });
      if (response.stop_reason === "refusal") {
        return { ok: false, error: "Model declined to process this reply." };
      }
      const block = response.content.find((b) => b.type === "text");
      text = block && block.type === "text" ? block.text : null;
    } catch (error) {
      if (error instanceof Anthropic.BadRequestError) {
        // Model/config rejected structured outputs — plain prompt fallback.
        const response = await getClient().messages.create({
          model,
          max_tokens: 1500,
          messages: [{ role: "user", content: prompt }],
        });
        const block = response.content.find((b) => b.type === "text");
        const rawText = block && block.type === "text" ? block.text : "";
        text = rawText.match(/\{[\s\S]*\}/)?.[0] ?? null;
      } else {
        throw error;
      }
    }

    if (!text) {
      return { ok: false, error: "Model returned no usable output." };
    }

    const parsed = ExtractionSchema.safeParse(JSON.parse(text));
    if (!parsed.success) {
      return { ok: false, error: "Model output failed schema validation." };
    }

    return {
      ok: true,
      extraction: normalize(parsed.data, options.allowedValues, options.fallbackValue),
      model,
    };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Claude API request failed." };
  }
}
