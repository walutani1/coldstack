import "server-only";

import { getSecret } from "@/lib/secrets";

// Thin Firecrawl v2 client (live-verified shapes):
//   POST /v2/search -> { success, data: { web: [{ url, title, description }] } }
//   POST /v2/scrape -> { success, data: { markdown, metadata } }

const BASE_URL = "https://api.firecrawl.dev";

// The Settings-managed encrypted secret wins; the environment variable keeps
// working (stored under various casings, e.g. Firecrawl_API_Key).
function firecrawlEnvToken(): string {
  const direct = process.env.FIRECRAWL_API_KEY;
  if (direct) return direct;
  for (const [key, value] of Object.entries(process.env)) {
    if (value && /^firecrawl[_-]?(?:api[_-]?)?(?:key|token)$/i.test(key)) return value;
  }
  return "";
}

async function firecrawlToken(): Promise<string> {
  const stored = await getSecret("firecrawl_api_key").catch(() => null);
  return stored || firecrawlEnvToken();
}

export async function hasFirecrawlKey(): Promise<boolean> {
  return Boolean(await firecrawlToken());
}

async function post<T>(path: string, body: Record<string, unknown>, timeoutMs: number): Promise<T> {
  const token = await firecrawlToken();
  if (!token) throw new Error("Missing Firecrawl key. Add it in Settings → Integrations (or FIRECRAWL_API_KEY).");
  const res = await fetch(`${BASE_URL}${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const json = (await res.json().catch(() => ({}))) as { success?: boolean; error?: string; data?: unknown };
  if (!res.ok || json.success === false) {
    throw new Error(`Firecrawl ${path} failed: HTTP ${res.status} ${json.error ?? ""}`.trim());
  }
  return json.data as T;
}

export type WebSearchResult = { url: string; title: string | null; description: string | null };

export async function firecrawlSearch(query: string, limit = 5): Promise<WebSearchResult[]> {
  const data = await post<{ web?: unknown[] }>("/v2/search", { query, limit }, 30_000);
  const web = Array.isArray(data?.web) ? data.web : [];
  return web
    .map((item) => {
      const it = (item ?? {}) as Record<string, unknown>;
      return {
        url: typeof it.url === "string" ? it.url : "",
        title: typeof it.title === "string" ? it.title : null,
        description: typeof it.description === "string" ? it.description : null,
      };
    })
    .filter((item) => item.url.length > 0);
}

export type ScrapeResult = { markdown: string; title: string | null; description: string | null };

export async function firecrawlScrape(url: string): Promise<ScrapeResult> {
  const data = await post<{ markdown?: unknown; metadata?: Record<string, unknown> }>(
    "/v2/scrape",
    { url, formats: ["markdown"], onlyMainContent: true },
    60_000,
  );
  const metadata = data?.metadata ?? {};
  const title = metadata["ogTitle"] ?? metadata["og:title"] ?? metadata["title"];
  const description = metadata["ogDescription"] ?? metadata["og:description"] ?? metadata["description"];
  return {
    markdown: typeof data?.markdown === "string" ? data.markdown : "",
    title: typeof title === "string" ? title : null,
    description: typeof description === "string" ? description : null,
  };
}
