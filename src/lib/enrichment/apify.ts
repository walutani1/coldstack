import "server-only";

import type { EnrichmentLead } from "@/lib/enrichment/types";

// harvestapi/linkedin-profile-scraper: cookieless, ~$4 per 1,000 profiles,
// API-runnable. Input field is `urls`; it returns experience[].companyName +
// a top-level currentPosition, which is what lets us read "is the target-company
// role still current (present)?" deterministically.
const DEFAULT_ACTOR = "harvestapi~linkedin-profile-scraper";
const DEFAULT_URL_FIELD = "urls";

export type LinkedinStatus = "working" | "not_working" | "uncertain";

export type LinkedinPosition = { company: string; title: string; current: boolean; caption: string };

export type LinkedinProfile = {
  ok: boolean;
  fullName: string;
  headline: string;
  currentCompanies: string[];
  positions: LinkedinPosition[];
  sourceUrl: string;
  actor: string;
  scrapedAt: string;
  raw?: unknown;
};

export type LinkedinVerifyResult = {
  status: LinkedinStatus;
  currentCompany: string | null;
  reason: string;
  profile: LinkedinProfile;
};

// The operator stores the token under various casings (Apify_API_Key,
// APIFY_TOKEN, ...). process.env keys are case-sensitive, so scan for any key
// that looks like an Apify key/token.
function apifyToken(): string {
  const direct = process.env.APIFY_TOKEN || process.env.APIFY_API_KEY;
  if (direct) return direct;
  for (const [key, value] of Object.entries(process.env)) {
    if (value && /^apify[_-]?(?:api[_-]?)?(?:key|token)$/i.test(key)) return value;
  }
  return "";
}

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

// Match on the LinkedIn public identifier (the /in/<slug> part) so http vs
// https, www, trailing slashes, and query strings all agree.
function slugOf(u: string): string {
  const m = String(u || "").match(/\/in\/([^/?#]+)/i);
  return (m ? m[1] : String(u || "")).toLowerCase().replace(/\/+$/, "");
}

// Reduce a company name to a comparable core: lowercase, drop legal suffixes and
// punctuation, collapse whitespace. Conservative on purpose — we would rather be
// "uncertain" than wrongly flag someone as departed.
function normCompany(name: string): string {
  return String(name || "")
    .normalize("NFKC")
    // LinkedIn injects invisible characters into company names (zero-width
    // spaces/joiners, bidi marks, BOM, soft hyphens). JS's \s does not catch
    // most of these, so a name that looks identical would fail to match. Strip
    // them before normalising.
    .replace(/[\u00ad\u200b-\u200f\u202a-\u202e\u2060-\u2064\ufeff]/g, "")
    .toLowerCase()
    .replace(/[.,/#!$%^&*;:{}=\-_`~()"']/g, " ")
    .replace(/\b(inc|llc|l\.?l\.?c|ltd|limited|gmbh|corp|corporation|co|company|plc|s\.?a|ag|bv|b\.?v|pty|group|holdings?|the)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function companiesMatch(a: string, b: string): boolean {
  const na = normCompany(a);
  const nb = normCompany(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  const [shorter, longer] = na.length <= nb.length ? [na, nb] : [nb, na];
  return shorter.length >= 4 && longer.includes(shorter);
}

// Normalize an Apify item into current-employment facts. Tuned for harvestapi
// (experience[].companyName + top-level currentPosition), with fallbacks for
// other actors' field names.
export function normalizeProfile(item: unknown, sourceUrl: string, actor: string, scrapedAt: string): LinkedinProfile {
  const empty: LinkedinProfile = { ok: false, fullName: "", headline: "", currentCompanies: [], positions: [], sourceUrl, actor, scrapedAt };
  if (!item || typeof item !== "object") return empty;
  const it = item as Record<string, unknown>;
  const fullName = str(it.fullName) || `${str(it.firstName)} ${str(it.lastName)}`.trim() || str(it.name);
  const headline = str(it.headline) || str(it.occupation) || str(it.subTitle);
  const expRaw = it.experience || it.experiences || it.positions || it.workExperience || [];
  const positions: LinkedinPosition[] = (Array.isArray(expRaw) ? expRaw : []).map((e) => {
    const ex = (e && typeof e === "object" ? e : {}) as Record<string, unknown>;
    const companyObj = ex.company && typeof ex.company === "object" ? (ex.company as Record<string, unknown>) : null;
    const company = str(ex.companyName) || str(ex.company) || str(ex.organisation) || (companyObj ? str(companyObj.name) : "") || str(ex.subtitle);
    const title = str(ex.position) || str(ex.title) || str(ex.role);
    const caption = str(ex.duration) || str(ex.caption) || str(ex.dateRange) || "";
    const endRaw = (ex.endDate ?? ex.end ?? ex.ends_at ?? null) as unknown;
    const end = typeof endRaw === "string" ? endRaw : "";
    const current = ex.current === true || ex.isCurrent === true || /present|current/i.test(end) || /present|current/i.test(caption);
    return { company, title, current, caption };
  }).filter((p) => p.company || p.title);

  // Current employer: harvestapi's top-level currentPosition first (most
  // authoritative), then any explicitly-current experience.
  const cp = it.currentPosition;
  const cpList = Array.isArray(cp) ? cp : cp ? [cp] : [];
  const currentCompanies: string[] = [];
  const pushUnique = (c: string) => { if (c && !currentCompanies.some((x) => x.toLowerCase() === c.toLowerCase())) currentCompanies.push(c); };
  for (const c of cpList) {
    const co = c && typeof c === "object" ? (c as Record<string, unknown>) : {};
    pushUnique(str(co.companyName) || str(co.company) || (typeof c === "string" ? str(c) : ""));
  }
  for (const p of positions.filter((p) => p.current)) pushUnique(p.company);
  const topCompany = str(it.companyName) || str(it.company);
  if (topCompany) pushUnique(topCompany);

  const ok = Boolean(fullName || headline || positions.length);
  return { ok, fullName, headline, currentCompanies, positions: positions.slice(0, 12), sourceUrl, actor, scrapedAt, raw: item };
}

// Deterministic employment status: does the company we have on file still show
// as a CURRENT (present) role? Conservative — only "not_working" when the target
// clearly appears as a past role and a different current employer exists.
export function determineStatus(profile: LinkedinProfile, company: string | null): { status: LinkedinStatus; currentCompany: string | null; reason: string } {
  const target = str(company);
  const currentCompany = profile.currentCompanies[0] ?? null;
  if (!profile.ok) return { status: "uncertain", currentCompany, reason: "No usable LinkedIn data was returned." };
  if (!target) return { status: "uncertain", currentCompany, reason: "No company on file to compare against." };

  const currentMatch = profile.currentCompanies.some((c) => companiesMatch(c, target))
    || profile.positions.some((p) => p.current && companiesMatch(p.company, target));
  if (currentMatch) return { status: "working", currentCompany, reason: `Current role at ${target} is marked present.` };

  const pastMatch = profile.positions.some((p) => !p.current && companiesMatch(p.company, target));
  if (pastMatch && profile.currentCompanies.length > 0) {
    return { status: "not_working", currentCompany, reason: `${target} shows only as a past role; now at ${currentCompany ?? "another company"}.` };
  }
  return { status: "uncertain", currentCompany, reason: `Could not confirm a current role at ${target} from the profile.` };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// 3 attempts total. An actor run already polls up to ~3 min, so the backoff is
// short relative to the work: retrying is about riding out a blip, not waiting
// out a long outage (the run job's own retry/resume covers that).
const APIFY_ATTEMPTS = 3;

// Exponential (4s, 12s) with jitter, so two rows retrying together don't
// resubmit to Apify in lockstep.
function backoffMs(attempt: number): number {
  const base = 4_000 * 3 ** (attempt - 1);
  return Math.round(base + Math.random() * base * 0.25);
}

/* Auth/permission problems and a missing input are deterministic - they fail
   the same way on every attempt, so retrying only wastes actor minutes. */
function isPermanentApifyError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /HTTP (?:401|403|404)\b|unauthorized|forbidden|invalid token|missing apify token|has no linkedin url/i.test(message);
}

// Run the actor for a single profile URL, poll to completion, return the item
// whose /in/<slug> matches the requested URL.
async function scrapeOne(url: string, token: string, actor: string, urlField: string): Promise<unknown> {
  // Token in the header, never the URL — query-string API keys are being
  // deprecated by these providers and leak into logs and proxies.
  const auth = { authorization: `Bearer ${token}` };
  const start = await fetch(`https://api.apify.com/v2/acts/${actor}/runs`, {
    method: "POST",
    headers: { "content-type": "application/json", ...auth },
    body: JSON.stringify({ [urlField]: [url] }),
    signal: AbortSignal.timeout(30_000),
  });
  const startJson = (await start.json().catch(() => ({}))) as { data?: { id?: string; defaultDatasetId?: string } };
  if (!start.ok || !startJson.data?.id) {
    throw new Error(`Apify run start failed: HTTP ${start.status} ${JSON.stringify(startJson).slice(0, 300)}`);
  }
  const runId = startJson.data.id;
  const datasetId = startJson.data.defaultDatasetId;
  for (let i = 0; i < 45; i += 1) {
    await sleep(4_000);
    const st = await fetch(`https://api.apify.com/v2/actor-runs/${runId}`, { headers: auth, signal: AbortSignal.timeout(30_000) });
    const stj = (await st.json().catch(() => ({}))) as { data?: { status?: string } };
    const status = stj.data?.status;
    if (status === "SUCCEEDED") break;
    if (status === "FAILED" || status === "ABORTED" || status === "TIMED-OUT") throw new Error(`Apify run ${status}.`);
    if (i === 44) throw new Error("Apify run timed out.");
  }
  const res = await fetch(`https://api.apify.com/v2/datasets/${datasetId}/items?clean=true`, { headers: auth, signal: AbortSignal.timeout(60_000) });
  const items = (await res.json().catch(() => [])) as unknown[];
  const arr = Array.isArray(items) ? items : [];
  // harvestapi free-plan runs return an {error: "..."} object instead of a profile.
  const first = arr[0] as Record<string, unknown> | undefined;
  if (first && typeof first.error === "string" && !first.publicIdentifier && !first.experience) {
    throw new Error(`Apify actor error: ${first.error}`);
  }
  const want = slugOf(url);
  for (const raw of arr) {
    const it = raw as Record<string, unknown>;
    for (const cand of [it.publicIdentifier, it.originalQuery, it.linkedinUrl, it.url, it.profileUrl, it.inputUrl]) {
      if (typeof cand === "string" && cand && slugOf(cand) === want) return it;
    }
  }
  return arr[0] ?? null;
}

export class ApifyClient {
  private readonly token: string;
  private readonly actor: string;
  private readonly urlField: string;

  constructor(options: { token?: string; actor?: string; urlField?: string } = {}) {
    const token = options.token ?? apifyToken();
    if (!token) throw new Error("Missing Apify token. Add APIFY_TOKEN to the environment.");
    this.token = token;
    this.actor = options.actor ?? process.env.APIFY_ACTOR ?? DEFAULT_ACTOR;
    this.urlField = options.urlField ?? process.env.APIFY_URL_FIELD ?? DEFAULT_URL_FIELD;
  }

  async verifyEmployment(lead: EnrichmentLead): Promise<LinkedinVerifyResult> {
    const url = str(lead.linkedinUrl);
    if (!url) throw new Error("Lead has no LinkedIn URL.");
    // A LinkedIn check is one actor run over the public web: capacity errors,
    // an ABORTED/TIMED-OUT run, and 429/5xx on run-start are all transient and
    // usually clear on a second attempt. Retrying matters more here than
    // elsewhere because this step is the FIRST gate of the autorun waterfall —
    // a single flaky scrape used to stop the whole row before ZeroBounce,
    // personalization, or export ever ran.
    let lastError: unknown;
    for (let attempt = 1; attempt <= APIFY_ATTEMPTS; attempt += 1) {
      const scrapedAt = new Date().toISOString();
      try {
        const item = await scrapeOne(url, this.token, this.actor, this.urlField);
        const profile = normalizeProfile(item, url, this.actor, scrapedAt);
        const { status, currentCompany, reason } = determineStatus(profile, lead.company);
        return { status, currentCompany, reason, profile };
      } catch (error) {
        lastError = error;
        // A bad token / forbidden actor fails identically every time; burning
        // three actor runs on it just wastes minutes and credit.
        if (attempt === APIFY_ATTEMPTS || isPermanentApifyError(error)) throw error;
        await sleep(backoffMs(attempt));
      }
    }
    throw lastError instanceof Error ? lastError : new Error("Apify verification failed.");
  }
}
