import "server-only";

export type ZeroBounceStatus = "valid" | "invalid" | "catch-all" | "unknown" | "spamtrap" | "abuse" | "do_not_mail";
export type ZeroBounceResponse = {
  address?: string; status?: ZeroBounceStatus | string; sub_status?: string; free_email?: boolean;
  catchall_domain?: boolean | null; did_you_mean?: string | null; account?: string; domain?: string;
  mx_found?: string | boolean; mx_record?: string; smtp_provider?: string | null; processed_at?: string; error?: string;
};

export class ZeroBounceClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;

  constructor(apiKey = process.env.ZEROBOUNCE_API_KEY, baseUrl = process.env.ZEROBOUNCE_API_BASE_URL ?? "https://api.zerobounce.net/v2") {
    if (!apiKey) throw new Error("Missing ZEROBOUNCE_API_KEY.");
    this.apiKey = apiKey;
    this.baseUrl = baseUrl.replace(/\/$/, "");
  }

  async validate(email: string, timeoutSeconds = 10) {
    const url = new URL(`${this.baseUrl}/validate`);
    url.searchParams.set("api_key", this.apiKey);
    url.searchParams.set("email", email);
    url.searchParams.set("timeout", String(timeoutSeconds));
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30_000);
    try {
      const response = await fetch(url, { cache: "no-store", signal: controller.signal });
      const raw = await response.json() as ZeroBounceResponse;
      if (!response.ok || raw.error) throw new Error(raw.error || `ZeroBounce failed: ${response.status}`);
      return { status: normalizeZeroBounceStatus(raw.status), raw };
    } finally {
      clearTimeout(timer);
    }
  }
}

export function normalizeZeroBounceStatus(status: string | undefined): ZeroBounceStatus {
  const normalized = String(status ?? "").toLowerCase();
  return ["valid", "invalid", "catch-all", "unknown", "spamtrap", "abuse", "do_not_mail"].includes(normalized)
    ? normalized as ZeroBounceStatus
    : "unknown";
}

export function mapZeroBounceToEmailStatus(status: ZeroBounceStatus): "deliverable" | "catch_all" | "risky" | "invalid" {
  if (status === "valid") return "deliverable";
  if (["invalid", "spamtrap", "abuse", "do_not_mail"].includes(status)) return "invalid";
  // Catch-all is marked distinctly and never proceeds (only "deliverable" does);
  // catch-alls are handled later in a separate table.
  if (status === "catch-all") return "catch_all";
  return "risky";
}
