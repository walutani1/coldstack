import "server-only";

import {
  AI_GATEWAY_DEFAULT_BASE_URL,
  runChatCompletions,
  toGatewayModelId,
} from "@/lib/enrichment/llm-runner";
import { getSecret, type SecretName } from "@/lib/secrets";

/* One prompt in, one text answer out — the shared transport for the sequence
   editor's copy tools (spintax, spam check). No model picked = a direct
   Anthropic call on the default model, so the tools work without a gateway
   key; an explicit "vendor/model" id routes through the Vercel AI Gateway on
   the same transport enrichment columns use. */

export const ONE_SHOT_DEFAULT_MODEL = "claude-sonnet-5";

export type OneShotResult = { ok: true; text: string } | { ok: false; error: string };

async function keyFor(secretName: SecretName, envName: string): Promise<string | null> {
  let stored: string | null = null;
  try { stored = await getSecret(secretName); } catch { stored = null; }
  return stored ?? process.env[envName] ?? null;
}

export async function runOneShotPrompt(
  prompt: string,
  options: {
    // Gateway "vendor/model" id; unset keeps the direct Anthropic default.
    model?: string;
    maxTokens: number;
    // Applies to the direct Anthropic path only; the gateway transport owns
    // its own 60s budget.
    timeoutMs: number;
    timeoutMessage: string;
    /* Anthropic-only: pinned sampling for repeatable answers. Not sent through
       the gateway — several served models reject a non-default temperature. */
    temperature?: number;
  },
): Promise<OneShotResult> {
  if (options.model) {
    const apiKey = await keyFor("ai_gateway_api_key", "AI_GATEWAY_API_KEY");
    if (!apiKey) return { ok: false, error: "AI Gateway API key is not configured." };
    const model = toGatewayModelId(options.model);
    // Reasoning pinned off: every budget here is sized for the visible answer.
    const result = await runChatCompletions({
      provider: "gateway",
      vendor: model.slice(0, model.indexOf("/")),
      baseUrl: process.env.AI_GATEWAY_BASE_URL || AI_GATEWAY_DEFAULT_BASE_URL,
      apiKey,
      model,
      prompt,
      maxTokens: options.maxTokens,
      started: Date.now(),
      reasoningEffort: "none",
    });
    return result.ok ? { ok: true, text: result.text } : { ok: false, error: result.message };
  }

  const apiKey = await keyFor("enrichment_anthropic_api_key", "ANTHROPIC_API_KEY");
  if (!apiKey) return { ok: false, error: "Anthropic API key is not configured." };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs);
  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: ONE_SHOT_DEFAULT_MODEL,
        max_tokens: options.maxTokens,
        ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
        messages: [{ role: "user", content: prompt }],
      }),
      signal: controller.signal,
    });
    if (!response.ok) {
      const body = await response.text();
      return { ok: false, error: `Anthropic request failed: ${response.status} ${body.slice(0, 200)}` };
    }
    const body = await response.json() as { content?: { type?: string; text?: string }[] };
    const text = body.content?.find((item) => item.type === "text" && typeof item.text === "string")?.text ?? "";
    return { ok: true, text };
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      return { ok: false, error: options.timeoutMessage };
    }
    return { ok: false, error: error instanceof Error ? error.message : "The request failed." };
  } finally {
    clearTimeout(timer);
  }
}
