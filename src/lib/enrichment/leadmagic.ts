import "server-only";

import type { EnrichmentLead } from "@/lib/enrichment/types";

const BASE_URL = "https://api.leadmagic.io";

export type EmailFinderResult = {
  email: string | null;
  source: "leadmagic";
  raw: Record<string, unknown>;
};

export class LeadMagicClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;

  constructor(options: { apiKey?: string; baseUrl?: string } = {}) {
    const apiKey = options.apiKey ?? process.env.LEADMAGIC_API_KEY;
    if (!apiKey) throw new Error("Missing LEADMAGIC_API_KEY.");
    this.apiKey = apiKey;
    this.baseUrl = (options.baseUrl ?? BASE_URL).replace(/\/$/, "");
  }

  async findEmail(lead: EnrichmentLead): Promise<EmailFinderResult> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30_000);
    try {
      const response = await fetch(`${this.baseUrl}/v1/people/email-finder`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-API-Key": this.apiKey },
        body: JSON.stringify({
          first_name: lead.firstName,
          last_name: lead.lastName,
          company_name: lead.company,
          company_domain: lead.domain,
          domain: lead.domain,
          linkedin_url: lead.linkedinUrl,
        }),
        signal: controller.signal,
      });
      const text = await response.text();
      // Status check first: an HTML error body would make JSON.parse throw a
      // SyntaxError that masks the real status code.
      if (!response.ok) throw new Error(`LeadMagic email finder failed: ${response.status} ${text.slice(0, 300)}`);
      const raw = text ? JSON.parse(text) as Record<string, unknown> : {};
      const nested = [raw.data, raw.result].filter(
        (value): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value),
      );
      const email = [raw.email, raw.business_email, raw.work_email, ...nested.map((value) => value.email)]
        .find((value): value is string => typeof value === "string" && value.includes("@")) ?? null;
      return { email, source: "leadmagic", raw };
    } finally {
      clearTimeout(timer);
    }
  }
}
