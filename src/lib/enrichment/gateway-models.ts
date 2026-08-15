import "server-only";

import { AI_GATEWAY_DEFAULT_BASE_URL } from "@/lib/enrichment/llm-runner";
import { getSecret } from "@/lib/secrets";

/* The models the AI Gateway is serving RIGHT NOW.

   Model pickers used to read a hardcoded list, which meant every new model was
   a code change and anything released after the last edit was simply invisible
   to the operator. The gateway already publishes what it serves, so ask it. */

export type GatewayModel = {
  id: string;
  vendor: string;
  /* The vendor's own name for the model ("GPT 5.6 Luna"), not the routing id.
     The picker used to show ids only, which made a list of 300 near-identical
     slugs the operator had to decode. */
  name: string;
  // US dollars per million tokens, or null when the gateway does not price it.
  inputPer1M: number | null;
  outputPer1M: number | null;
  contextWindow: number | null;
};

// One fetch per process per TTL: opening the column editor repeatedly should not
// re-hit the network, and the served list changes on the order of days.
const TTL_MS = 10 * 60_000;
let cache: { at: number; models: GatewayModel[] } | null = null;

/* Ids that are a duplicate of another served id rather than a distinct model:
   "xai/grok-4.20-reasoning-beta" alongside "xai/grok-4.20-reasoning". Only the
   SHADOWED one is dropped - a "-preview" with no stable twin (say
   "google/gemini-3.1-pro-preview") is the only way to reach that model. */
const SHADOW_SUFFIX = /-(beta|preview|latest)$/;

function perMillion(value: unknown): number | null {
  const price = Number(value);
  // The gateway quotes dollars per token; a picker reads better per million.
  return Number.isFinite(price) && price > 0 ? price * 1_000_000 : null;
}

export async function listGatewayModels(force = false): Promise<GatewayModel[]> {
  if (!force && cache && Date.now() - cache.at < TTL_MS) return cache.models;

  let storedKey: string | null = null;
  try { storedKey = await getSecret("ai_gateway_api_key"); } catch { storedKey = null; }
  const apiKey = storedKey ?? process.env.AI_GATEWAY_API_KEY ?? null;
  // No key is not an error: the picker falls back to its static catalog.
  if (!apiKey) return [];

  const baseUrl = (process.env.AI_GATEWAY_BASE_URL || AI_GATEWAY_DEFAULT_BASE_URL).replace(/\/+$/, "");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetch(`${baseUrl}/models`, {
      headers: { authorization: `Bearer ${apiKey}` },
      signal: controller.signal,
    });
    // A transient failure must not blank the picker: keep serving the last good
    // list (the models did not disappear, our lookup did).
    if (!response.ok) return cache?.models ?? [];
    const body = await response.json() as {
      data?: { id?: unknown; name?: unknown; type?: unknown; context_window?: unknown; pricing?: { input?: unknown; output?: unknown } }[];
    };
    const entries = (body.data ?? [])
      .map((entry) => ({ ...entry, id: String(entry?.id ?? "").trim() }))
      // Gateway ids are "vendor/model"; anything else is not routable here.
      .filter((entry) => /^[^/\s]+\/[^/\s]+$/.test(entry.id))
      /* Of the ~325 ids the gateway serves, only the language ones can answer a
         prompt. Offering the image, video, speech, embedding and reranking
         models as column choices was offering ~115 guaranteed failures. */
      .filter((entry) => entry.type === "language");

    const served = new Set(entries.map((entry) => entry.id));
    const models = entries
      .filter((entry) => !(SHADOW_SUFFIX.test(entry.id) && served.has(entry.id.replace(SHADOW_SUFFIX, ""))))
      .map((entry) => ({
        id: entry.id,
        vendor: entry.id.slice(0, entry.id.indexOf("/")),
        name: typeof entry.name === "string" && entry.name.trim() ? entry.name.trim() : entry.id,
        inputPer1M: perMillion(entry.pricing?.input),
        outputPer1M: perMillion(entry.pricing?.output),
        contextWindow: Number.isFinite(Number(entry.context_window)) ? Number(entry.context_window) : null,
      }))
      .sort((a, b) => a.vendor.localeCompare(b.vendor) || a.name.localeCompare(b.name));
    cache = { at: Date.now(), models };
    return models;
  } catch {
    return cache?.models ?? [];
  } finally {
    clearTimeout(timer);
  }
}
