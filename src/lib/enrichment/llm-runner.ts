import "server-only";

import { z } from "zod";
import { codexLastMessagePath, runCliPrompt, withModelFlag } from "@/lib/enrichment/cli-runner";
import { getSecret } from "@/lib/secrets";
import { getAdminClient } from "@/lib/supabase/admin";

const concurrencyValueSchema = z.number().int().min(1).max(20);

/* ── Vercel AI Gateway ──────────────────────────────────────────────────────
   One key, many vendors, OpenAI chat-completions wire format, no token markup.
   Model ids are "vendor/model". The catalog below only SEEDS the settings
   picker: any well-formed id is accepted, because the gateway is the authority
   on what it serves and new models ship faster than this file. Verify live ids
   and prices with scripts/gateway-check.ts. */
export const AI_GATEWAY_DEFAULT_BASE_URL = "https://ai-gateway.vercel.sh/v1";
export const GATEWAY_MODEL_PATTERN = /^[a-z0-9][\w.-]*\/[\w.:-]+$/i;

/* ── Reasoning effort ──────────────────────────────────────────────────────
   One normalized dial across every vendor: the gateway maps `reasoning.effort`
   onto each vendor's own knob (OpenAI reasoning_effort, Anthropic thinking
   budgets, ...) and no-ops where a model has none, so the UI never needs
   per-family names. Hidden reasoning bills against the same completion cap as
   the visible answer, so an effort must ADD headroom on top of the
   answer-sized budget — without it, thinking eats the budget and cells come
   back truncated (the original Luna incident this file documents below). */
export const REASONING_EFFORTS = ["low", "medium", "high"] as const;
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];
const REASONING_HEADROOM: Record<ReasoningEffort, number> = { low: 2_000, medium: 8_000, high: 24_000 };

export function isReasoningEffort(value: unknown): value is ReasoningEffort {
  return typeof value === "string" && (REASONING_EFFORTS as readonly string[]).includes(value);
}

/* Options for one runEnrichmentPrompt call: the answer-sized budget, plus
   thinking headroom when the column asked for reasoning. Null/unknown effort
   means off — exactly the pre-knob behavior. */
export function reasoningOptions(
  answerTokens: number,
  effort: string | null | undefined,
): { maxTokens: number; reasoningEffort?: ReasoningEffort } {
  const cleaned = (effort ?? "").trim().toLowerCase();
  if (!isReasoningEffort(cleaned)) return { maxTokens: answerTokens };
  return { maxTokens: answerTokens + REASONING_HEADROOM[cleaned], reasoningEffort: cleaned };
}

/* Does this provider cost per token? Everything that is not a local CLI does.
   Written as "not cli" rather than a suffix match so a new metered provider is
   counted as metered by default - the safe direction for spend reporting, and
   the reason "gateway" (no "-api" suffix) must never be classed as free. */
export function isMeteredProvider(provider: string | null | undefined): boolean {
  return Boolean(provider) && !String(provider).startsWith("cli");
}

// Bare model id -> gateway id, so an operator (or a legacy per-column override)
// can write "gpt-5.6-luna" and still route through the gateway.
export function toGatewayModelId(model: string): string {
  if (model.includes("/")) return model;
  if (/^gpt/i.test(model)) return `openai/${model}`;
  if (/^claude/i.test(model)) return `anthropic/${model}`;
  if (/^grok/i.test(model)) return `xai/${model}`;
  if (/^glm/i.test(model)) return `zai/${model}`;
  return model;
}

/* Models selectable in CLI mode: what `claude --model` / `codex -m` accept.

   ONE ROW PER REAL MODEL, identified by its full pinned name. The list used to
   carry both the alias and the pinned id for each model ("opus" AND
   "claude-opus-5"), plus "[1m]" rows - 13 entries for 5 models, where picking
   the wrong twin changed nothing. Two rules keep it honest:

   - Full names, never aliases. An alias re-points itself when a new model ships
     (`opus` moved from Opus 4.7 to 4.8 to 5), so a column pinned to one would
     silently change model mid-campaign and make an A/B unrepeatable. Every id
     here is a pinned snapshot: from the 4.6 generation on, the dateless id IS
     the snapshot.
   - No "[1m]" rows. That suffix widens the context window, and Opus 5, Sonnet 5
     and Fable 5 are natively 1M anyway (the docs say sonnet[1m] "has no effect"
     there). These calls are one-shot prompts of a few hundred tokens, so the
     window is never the constraint - the rows were pure noise.

   Labels and blurbs follow the vendors' own naming (platform.claude.com model
   overview; developers.openai.com/codex/models) so what is on screen matches
   how these models are referred to everywhere else.

   Availability is enforced by the CLI at call time (an unavailable model returns
   a clear error), so this list stays a convenience rather than a gate - the
   picker accepts anything typed in regardless. */
export type CliModelEntry = {
  cli: "claude" | "codex";
  id: string;
  label: string;
  detail: string;
  // Superseded by a current model. Kept selectable, shown in its own section.
  legacy?: boolean;
};

export const CLI_MODEL_CATALOG: CliModelEntry[] = [
  { cli: "claude", id: "", label: "Claude Code default", detail: "Whatever model the CLI is set to" },
  { cli: "claude", id: "claude-fable-5", label: "Claude Fable 5", detail: "Highest capability, for long-running work" },
  { cli: "claude", id: "claude-opus-5", label: "Claude Opus 5", detail: "Complex reasoning and agentic work" },
  { cli: "claude", id: "claude-sonnet-5", label: "Claude Sonnet 5", detail: "Best balance of speed and intelligence" },
  { cli: "claude", id: "claude-haiku-4-5", label: "Claude Haiku 4.5", detail: "Fastest, with near-frontier quality" },
  { cli: "claude", id: "claude-opus-4-8", label: "Claude Opus 4.8", detail: "Previous Opus generation", legacy: true },
  { cli: "claude", id: "claude-opus-4-7", label: "Claude Opus 4.7", detail: "Previous Opus generation", legacy: true },
  { cli: "claude", id: "claude-opus-4-6", label: "Claude Opus 4.6", detail: "Previous Opus generation", legacy: true },
  { cli: "claude", id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6", detail: "Previous Sonnet generation", legacy: true },
  { cli: "claude", id: "claude-sonnet-4-5", label: "Claude Sonnet 4.5", detail: "Previous Sonnet generation", legacy: true },
  { cli: "codex", id: "", label: "Codex default", detail: "Whatever model the CLI is set to" },
  { cli: "codex", id: "gpt-5.6-sol", label: "GPT-5.6 Sol", detail: "Deepest analysis, for work that needs polish" },
  { cli: "codex", id: "gpt-5.6-terra", label: "GPT-5.6 Terra", detail: "Everyday workhorse, strong reasoning" },
  { cli: "codex", id: "gpt-5.6-luna", label: "GPT-5.6 Luna", detail: "Fastest and cheapest of the 5.6 family" },
  { cli: "codex", id: "gpt-5.5", label: "GPT-5.5", detail: "Previous generation", legacy: true },
];

/* Gateway ids surfaced above the vendor sections in API mode.

   The gateway serves ~200 text models and the great majority are irrelevant to
   short enrichment prompts, so this is a shortcut to the handful worth running
   here - NOT a filter. Every served model stays listed below, and an id that
   stops being served simply drops out (the list is intersected with what the
   gateway answers with), so nothing here can rot into a dead option. */
export const RECOMMENDED_GATEWAY_MODELS: string[] = [
  "openai/gpt-5.6-luna",
  "openai/gpt-5.6-terra",
  "openai/gpt-5.6-sol",
  "anthropic/claude-haiku-4.5",
  "anthropic/claude-sonnet-5",
  "anthropic/claude-opus-5",
  "google/gemini-3.6-flash",
  "xai/grok-4.5",
  "zai/glm-5.2",
];

/* Vendor slug -> the name the vendor uses for itself. Anything unlisted is
   title-cased, so a new vendor reads acceptably without a code change. */
const VENDOR_LABELS: Record<string, string> = {
  ai21: "AI21", alibaba: "Alibaba", amazon: "Amazon", anthropic: "Anthropic", "arcee-ai": "Arcee AI",
  baseten: "Baseten", bytedance: "ByteDance", cerebras: "Cerebras", cohere: "Cohere", deepseek: "DeepSeek",
  google: "Google", inception: "Inception", inclusionai: "InclusionAI", interfaze: "Interfaze",
  kwaipilot: "KwaiPilot", meta: "Meta", minimax: "MiniMax", mistral: "Mistral", moonshotai: "Moonshot AI",
  morph: "Morph", nvidia: "NVIDIA", openai: "OpenAI", perplexity: "Perplexity", poolside: "Poolside",
  sakana: "Sakana", stepfun: "StepFun", tencent: "Tencent", thinkingmachines: "Thinking Machines",
  vercel: "Vercel", xai: "xAI", xiaomi: "Xiaomi", zai: "Z.ai",
};

export function vendorLabel(slug: string): string {
  return VENDOR_LABELS[slug] ?? slug.replace(/(^|[-_])([a-z])/g, (_, sep: string, ch: string) => (sep ? " " : "") + ch.toUpperCase());
}

/* The picker shows names, not routing ids. That only holds while a name
   identifies exactly one model, and the gateway's own metadata breaks it:
   "openai/gpt-5.2-pro" is published as "GPT 5.2 " (trailing space, "Pro"
   dropped), which trims to the same name as "openai/gpt-5.2" - two identical
   rows, one of them 12x the price. Where a name repeats inside its section, and
   only there, the id goes back on the label. */
export function withUniqueLabels<T extends { id: string; label: string; group: string }>(options: T[]): T[] {
  const seen = new Map<string, number>();
  for (const option of options) {
    const key = `${option.group}|${option.label}`;
    seen.set(key, (seen.get(key) ?? 0) + 1);
  }
  return options.map((option) => (seen.get(`${option.group}|${option.label}`) ?? 0) > 1
    ? { ...option, label: `${option.label} (${option.id.slice(option.id.indexOf("/") + 1)})` }
    : option);
}

export const ENRICHMENT_MODEL_CATALOG: {
  provider: "anthropic-api" | "openai-api" | "gateway";
  id: string;
  label: string;
}[] = [
  { provider: "anthropic-api", id: "claude-sonnet-5", label: "Claude Sonnet 5" },
  { provider: "anthropic-api", id: "claude-haiku-4-5", label: "Claude Haiku 4.5" },
  { provider: "anthropic-api", id: "claude-opus-4-8", label: "Claude Opus 4.8" },
  { provider: "openai-api", id: "gpt-5.5", label: "GPT-5.5" },
  { provider: "openai-api", id: "gpt-5.4", label: "GPT-5.4" },
  { provider: "openai-api", id: "gpt-5.4-mini", label: "GPT-5.4 Mini" },
  { provider: "openai-api", id: "gpt-5.4-nano", label: "GPT-5.4 Nano" },
  { provider: "gateway", id: "openai/gpt-5.6-luna", label: "GPT-5.6 Luna" },
  { provider: "gateway", id: "openai/gpt-5.6-terra", label: "GPT-5.6 Terra" },
  { provider: "gateway", id: "openai/gpt-5.6-sol", label: "GPT-5.6 Sol" },
  // The gateway spells Anthropic point versions with a dot ("claude-haiku-4.5"),
  // unlike the first-party API's dashes ("claude-haiku-4-5"). Verified against
  // GET /models - a dashed id is simply not served.
  { provider: "gateway", id: "anthropic/claude-haiku-4.5", label: "Claude Haiku 4.5" },
  { provider: "gateway", id: "anthropic/claude-sonnet-5", label: "Claude Sonnet 5" },
  { provider: "gateway", id: "anthropic/claude-opus-5", label: "Claude Opus 5" },
  { provider: "gateway", id: "xai/grok-4.5", label: "Grok 4.5" },
  { provider: "gateway", id: "zai/glm-5.2", label: "GLM-5.2" },
  { provider: "gateway", id: "zai/glm-4.7", label: "GLM-4.7" },
];

export const enrichmentRunnerConfigSchema = z.object({
  /* The runner config carries the MODE only. Which model runs is a property of
     each column (enrichment_columns.model / .cli_model), so the table shows what
     it will actually do - there is deliberately no workspace-wide default model
     to silently drive columns whose selector says something else. */
  provider: z.enum(["anthropic-api", "openai-api", "gateway", "cli-claude", "cli-codex"]).default("cli-claude"),
  concurrency: z.object({
    llm: concurrencyValueSchema.default(3),
    smartlead: concurrencyValueSchema.default(1),
    leadmagic: concurrencyValueSchema.default(3),
    zerobounce: concurrencyValueSchema.default(4),
    apify: concurrencyValueSchema.default(3),
  }).default({ llm: 3, smartlead: 1, leadmagic: 3, zerobounce: 4, apify: 3 }),
}).strict();

export type EnrichmentRunnerConfig = z.infer<typeof enrichmentRunnerConfigSchema>;
export const DEFAULT_ENRICHMENT_RUNNER_CONFIG: EnrichmentRunnerConfig = enrichmentRunnerConfigSchema.parse({});
const SETTINGS_KEY = "enrichment_runner";

// Model fields that used to live on the workspace config. Dropped rather than
// honoured: a stored value must never quietly override a column's own choice.
const LEGACY_MODEL_KEYS = ["apiModel", "openaiModel", "gatewayModel", "cliClaudeModel", "cliCodexModel"] as const;

export function parseEnrichmentRunnerConfig(value: unknown): EnrichmentRunnerConfig {
  const raw = value && typeof value === "object" && !Array.isArray(value) ? { ...(value as Record<string, unknown>) } : {};
  for (const key of LEGACY_MODEL_KEYS) delete raw[key];
  const document = raw;
  const parsed = enrichmentRunnerConfigSchema.parse({ ...DEFAULT_ENRICHMENT_RUNNER_CONFIG, ...document });
  return process.env.VERCEL && (parsed.provider === "cli-claude" || parsed.provider === "cli-codex")
    ? { ...parsed, provider: "anthropic-api" }
    : parsed;
}

export async function getEnrichmentRunnerConfig(): Promise<EnrichmentRunnerConfig> {
  const { data, error } = await getAdminClient().from("app_settings").select("value").eq("key", SETTINGS_KEY).maybeSingle();
  if (error || !data) return parseEnrichmentRunnerConfig({});
  try { return parseEnrichmentRunnerConfig(data.value); } catch { return parseEnrichmentRunnerConfig({}); }
}

// The provider exactly as stored, WITHOUT the Vercel coercion to an API model.
// Callers that must never spend API credits behind the operator's back (the run
// worker) use this to detect that the runner is pinned to a local CLI.
export async function getStoredEnrichmentRunnerProvider(): Promise<EnrichmentRunnerConfig["provider"]> {
  const { data, error } = await getAdminClient().from("app_settings").select("value").eq("key", SETTINGS_KEY).maybeSingle();
  if (error || !data) return DEFAULT_ENRICHMENT_RUNNER_CONFIG.provider;
  try { return parseEnrichmentRunnerConfig(data.value).provider; }
  catch { return DEFAULT_ENRICHMENT_RUNNER_CONFIG.provider; }
}

export async function saveEnrichmentRunnerConfig(value: unknown, updatedBy: string): Promise<EnrichmentRunnerConfig> {
  const parsed = enrichmentRunnerConfigSchema.parse(parseEnrichmentRunnerConfig(value));
  if (process.env.VERCEL && (parsed.provider === "cli-claude" || parsed.provider === "cli-codex")) {
    throw new Error("CLI enrichment providers are unavailable on Vercel. Choose an API provider.");
  }
  const { error } = await getAdminClient().from("app_settings").upsert({
    key: SETTINGS_KEY,
    value: parsed,
    updated_at: new Date().toISOString(),
    updated_by: updatedBy,
  });
  if (error) throw new Error(error.message);
  return parsed;
}

export type EnrichmentUsage = { inputTokens: number; outputTokens: number };
export type EnrichmentPromptResult =
  | { ok: true; text: string; provider: string; usage: EnrichmentUsage | null; durationMs: number }
  | { ok: false; kind: "auth" | "rate_limit" | "timeout" | "transport" | "refusal"; message: string; provider: string; retryAfterMs?: number };

function retryAfterMs(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}

/* OpenAI chat-completions transport, shared by the direct OpenAI API and the
   Vercel AI Gateway (which implements the same wire format). Keeping one copy
   means a fix to refusal/usage/timeout handling lands for both.

   Exported so a verification script can force a route: runEnrichmentPrompt
   picks the provider from the WORKSPACE config, which would make a
   "check the gateway" script silently pass by running on the local CLI. */
export async function runChatCompletions(input: {
  provider: EnrichmentRunnerConfig["provider"];
  vendor: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  prompt: string;
  maxTokens: number;
  started: number;
  reasoningEffort?: string;
}): Promise<EnrichmentPromptResult> {
  const { provider, vendor, baseUrl, apiKey, model, prompt, maxTokens, started, reasoningEffort } = input;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60_000);
  try {
    const response = await fetch(`${baseUrl.replace(/\/+$/, "")}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        max_completion_tokens: maxTokens,
        /* On a reasoning model max_completion_tokens covers hidden reasoning
           tokens AND the visible answer, and every budget in this codebase was
           sized for the answer alone. GPT-5.6 Luna spent 194 of a 220-token
           cell budget thinking, leaving 25 for the output - so a cell either
           came back truncated or finished with "length" and was reported as a
           refusal. The QA gate's 150-token calls could not have completed at
           all. Asking for no reasoning restores what those budgets meant, and
           matches what the Claude CLI was doing before the switch to the API.
           Callers that want a model to think can pass an effort explicitly.
           Verified accepted (and a no-op) by vendors whose models do not offer
           a "none" tier, so this needs no per-model branching. */
        ...(reasoningEffort ? { reasoning: { effort: reasoningEffort } } : {}),
        messages: [{ role: "user", content: prompt }],
      }),
      signal: controller.signal,
    });
    if (response.status === 401 || response.status === 403) {
      return { ok: false, kind: "auth", message: `${vendor} rejected the API key.`, provider };
    }
    if (response.status === 429) {
      return { ok: false, kind: "rate_limit", message: `${vendor} rate limit reached.`, provider, retryAfterMs: retryAfterMs(response.headers.get("retry-after")) };
    }
    if (!response.ok) {
      const body = await response.text();
      return { ok: false, kind: "transport", message: `${vendor} request failed: ${response.status} ${body.slice(0, 300)}`, provider };
    }
    const body = await response.json() as {
      choices?: {
        finish_reason?: string | null;
        message?: { content?: string | null; refusal?: string | null };
      }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    const choice = body.choices?.[0];
    /* "length" is a budget problem, not a refusal. Reporting it as one sent
       operators looking for a content policy issue when the answer was simply
       cut off - so name the cause and the lever. */
    if (choice?.finish_reason === "length") {
      return { ok: false, kind: "refusal", message: `${vendor} hit the ${maxTokens}-token limit for this cell before finishing${reasoningEffort ? "" : " (reasoning tokens count toward it)"}.`, provider };
    }
    if (choice?.message?.refusal || choice?.finish_reason === "content_filter") {
      return { ok: false, kind: "refusal", message: `${vendor} stopped with ${choice.finish_reason ?? "refusal"}.`, provider };
    }
    const text = choice?.message?.content;
    const usage = body.usage ? { inputTokens: body.usage.prompt_tokens ?? 0, outputTokens: body.usage.completion_tokens ?? 0 } : null;
    return text
      ? { ok: true, text, provider, usage, durationMs: Date.now() - started }
      : { ok: false, kind: "refusal", message: `${vendor} returned no usable text.`, provider };
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      return { ok: false, kind: "timeout", message: `${vendor} request timed out after 60s.`, provider };
    }
    return { ok: false, kind: "transport", message: error instanceof Error ? error.message : `${vendor} request failed.`, provider };
  } finally {
    clearTimeout(timer);
  }
}

/* Run one prompt on ONE explicitly chosen model.

   `model` is required: every caller reads it off the column being generated, so
   nothing runs on a model the operator cannot see in the table. The workspace
   config supplies only the MODE (CLI vs a metered API), and the model's own
   shape picks the transport within that mode. */
export async function runEnrichmentPrompt(
  prompt: string,
  /* `reasoningEffort` defaults to "none": every maxTokens here is sized for the
     visible answer, and a reasoning model silently spending that budget on
     hidden tokens is a behaviour change nobody chose. Pass an explicit effort
     ("low" ... "max") for a call that should genuinely think. */
  options: { model: string; maxTokens?: number; reasoningEffort?: string },
): Promise<EnrichmentPromptResult> {
  // Wall-clock for "how long this cell took". Includes the small config/setup
  // cost, which is part of producing the value.
  const started = Date.now();
  const config = await getEnrichmentRunnerConfig();
  // A per-call model override (a custom column can pin its own model) picks the
  // transport that MATCHES THE MODEL, and stays on the local subscription when
  // the workspace runner is a CLI one: gpt-* runs on the Codex CLI, claude-* on
  // the Claude CLI. Sending a gpt-* column to the metered OpenAI API while the
  // runner is set to a CLI would bill for a run the operator explicitly asked to
  // keep on the subscription (and used to fail outright with "OpenAI API key is
  // not configured", since a CLI workspace has no reason to hold one). Only an
  // API runner routes overrides to the metered APIs. On Vercel the config is
  // already coerced off cli-* by parseEnrichmentRunnerConfig, so a deployed run
  // still uses the APIs exactly as before.
  const model = options.model.trim();
  const slash = model.indexOf("/");
  const vendor = slash > 0 ? model.slice(0, slash).toLowerCase() : null;
  // CLI mode never opens a metered door: whatever the model says, the work runs
  // on the subscription CLI that can serve it (codex for gpt/o-series, claude
  // otherwise, matching the aliases the Claude CLI accepts).
  const cliMode = config.provider === "cli-claude" || config.provider === "cli-codex";
  let provider: EnrichmentRunnerConfig["provider"];
  if (cliMode) {
    const wantsCodex = vendor === "openai" || (!vendor && /^(gpt|o\d|codex)/i.test(model));
    provider = wantsCodex ? "cli-codex" : "cli-claude";
  } else if (vendor) {
    provider = "gateway"; // one metered door for every vendor
  } else if (model.startsWith("gpt")) {
    provider = "openai-api";
  } else if (model.startsWith("claude")) {
    provider = "anthropic-api";
  } else {
    provider = "gateway";
  }
  // CLI model values are interpolated into a shell command. Allow the character
  // set the CLIs actually use - including the brackets in "opus[1m]" - and let
  // buildCliCommand quote it so a bracketed id is never glob-expanded.
  const cliModelOverride = /^[\w.:\[\]-]*$/.test(model) ? model : "";
  if (provider === "cli-claude" || provider === "cli-codex") {
    if (process.env.VERCEL) return { ok: false, kind: "transport", message: "CLI enrichment is unavailable on Vercel.", provider };
    // codex exec takes the prompt on stdin ("-") and writes its FINAL message to
    // --output-last-message; its stdout is a transcript and must never be used as
    // a cell value. --ask-for-approval is NOT a valid `codex exec` flag (it
    // belongs to the interactive command) and made every codex call exit with a
    // usage error. --skip-git-repo-check keeps it working regardless of the
    // server's working directory.
    const buildCodexCommand = (outputFile: string) =>
      withModelFlag(
        `codex exec --sandbox read-only --skip-git-repo-check -o "${outputFile}" -`,
        "-m",
        cliModelOverride,
      );
    // The local CLI fails transiently under batch load (a short rate-limit prints
    // to stdout and exits 1). Retry a few times with growing backoff so an
    // overnight run rides over blips instead of failing the lead. A timeout is not
    // retried (it already waited the full budget).
    const maxAttempts = 3;
    let lastMessage = "CLI enrichment failed.";
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      // Fresh output file per attempt so a retry can never read the previous
      // attempt's leftover message.
      const outputFile = provider === "cli-codex" ? codexLastMessagePath() : null;
      const command = provider === "cli-claude"
        ? withModelFlag("claude -p", "--model", cliModelOverride)
        : buildCodexCommand(outputFile!);
      try {
        const result = await runCliPrompt(command, prompt, outputFile ? { outputFile } : {});
        // An empty result means codex exited cleanly but wrote no final message;
        // treating that as success would blank the cell, so retry it like a fault.
        if (!result.stdout.trim()) throw new Error("CLI returned no output.");
        // The CLI (local Claude/Codex subscription) has no per-token API cost and
        // does not report usage over plain output; record timing only.
        return { ok: true, text: result.stdout, provider, usage: null, durationMs: Date.now() - started };
      } catch (error) {
        lastMessage = error instanceof Error ? error.message : "CLI enrichment failed.";
        if (/timed out/i.test(lastMessage)) return { ok: false, kind: "timeout", message: lastMessage, provider };
        if (attempt < maxAttempts) await new Promise((resolve) => setTimeout(resolve, attempt * 4000));
      }
    }
    return { ok: false, kind: "transport", message: lastMessage, provider };
  }

  if (provider === "openai-api") {
    let storedKey: string | null = null;
    try { storedKey = await getSecret("openai_api_key"); } catch { storedKey = null; }
    const apiKey = storedKey ?? process.env.OPENAI_API_KEY ?? null;
    if (!apiKey) return { ok: false, kind: "auth", message: "OpenAI API key is not configured.", provider };
    return runChatCompletions({
      provider,
      vendor: "OpenAI",
      baseUrl: "https://api.openai.com/v1",
      apiKey,
      model,
      prompt,
      maxTokens: options?.maxTokens ?? 512,
      reasoningEffort: options?.reasoningEffort ?? "none",
      started,
    });
  }

  if (provider === "gateway") {
    let storedKey: string | null = null;
    try { storedKey = await getSecret("ai_gateway_api_key"); } catch { storedKey = null; }
    const apiKey = storedKey ?? process.env.AI_GATEWAY_API_KEY ?? null;
    if (!apiKey) return { ok: false, kind: "auth", message: "AI Gateway key is not configured (Settings -> Integrations, or AI_GATEWAY_API_KEY).", provider };
    return runChatCompletions({
      provider,
      vendor: "AI Gateway",
      baseUrl: process.env.AI_GATEWAY_BASE_URL || AI_GATEWAY_DEFAULT_BASE_URL,
      apiKey,
      model: toGatewayModelId(model),
      prompt,
      maxTokens: options?.maxTokens ?? 512,
      reasoningEffort: options?.reasoningEffort ?? "none",
      started,
    });
  }

  let storedKey: string | null = null;
  try { storedKey = await getSecret("enrichment_anthropic_api_key"); } catch { storedKey = null; }
  const apiKey = storedKey ?? process.env.ANTHROPIC_API_KEY ?? null;
  if (!apiKey) return { ok: false, kind: "auth", message: "Anthropic API key is not configured.", provider };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60_000);
  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model, max_tokens: options?.maxTokens ?? 128, messages: [{ role: "user", content: prompt }] }),
      signal: controller.signal,
    });
    if (response.status === 401 || response.status === 403) {
      return { ok: false, kind: "auth", message: "Anthropic rejected the API key.", provider };
    }
    if (response.status === 429) {
      return { ok: false, kind: "rate_limit", message: "Anthropic rate limit reached.", provider, retryAfterMs: retryAfterMs(response.headers.get("retry-after")) };
    }
    if (!response.ok) {
      const body = await response.text();
      return { ok: false, kind: "transport", message: `Anthropic request failed: ${response.status} ${body.slice(0, 300)}`, provider };
    }
    const body = await response.json() as { stop_reason?: string; content?: { type?: string; text?: string }[]; usage?: { input_tokens?: number; output_tokens?: number } };
    if (body.stop_reason === "refusal" || body.stop_reason === "max_tokens") {
      return { ok: false, kind: "refusal", message: `Anthropic stopped with ${body.stop_reason}.`, provider };
    }
    const text = body.content?.find((item) => item.type === "text" && typeof item.text === "string")?.text;
    const usage = body.usage ? { inputTokens: body.usage.input_tokens ?? 0, outputTokens: body.usage.output_tokens ?? 0 } : null;
    return text
      ? { ok: true, text, provider, usage, durationMs: Date.now() - started }
      : { ok: false, kind: "refusal", message: "Anthropic returned no usable text.", provider };
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      return { ok: false, kind: "timeout", message: "Anthropic request timed out after 60s.", provider };
    }
    return { ok: false, kind: "transport", message: error instanceof Error ? error.message : "Anthropic request failed.", provider };
  } finally {
    clearTimeout(timer);
  }
}
