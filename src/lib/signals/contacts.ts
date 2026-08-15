import "server-only";

import { getAdminClient } from "@/lib/supabase/admin";
import { getSecret } from "@/lib/secrets";
import { apifyAuth, companyNameKey } from "@/lib/signals/apify-jobs";
import { claimProfileWork, finishProfileWork } from "@/lib/signals/automations";
import { LeadMagicClient } from "@/lib/enrichment/leadmagic";
import type { EnrichmentLead } from "@/lib/enrichment/types";
import type { SignalContactDto } from "@/lib/signals/types";

// Contact sourcing for qualified companies: pull the LinkedIn employee roster
// via harvestapi/linkedin-company-employees (Full mode — includes headline,
// about text, and experience; ~$0.008/profile + $0.02/start), rank the roster
// deterministically, auto-pick primary + backup, then find emails through the
// Apollo -> LeadMagic waterfall. Poll-driven like scrapes/research: 'pending'
// starts an Apify run, 'sourcing' polls it, ingest completes to 'sourced'.

const ROSTER_ACTOR = "harvestapi~linkedin-company-employees";
// Target companies are 50-100 people; 150 covers stragglers without letting a
// mis-scoped enterprise page burn dollars.
const ROSTER_MAX_ITEMS = 150;
export const ROSTER_START_USD = 0.02;
export const ROSTER_PROFILE_USD = 0.008;

async function apifyToken(): Promise<string> {
  const stored = await getSecret("apify_api_key").catch(() => null);
  if (stored) return stored;
  const direct = process.env.APIFY_TOKEN || process.env.APIFY_API_KEY;
  if (direct) return direct;
  for (const [key, value] of Object.entries(process.env)) {
    if (value && /^apify[_-]?(?:api[_-]?)?(?:key|token)$/i.test(key)) return value;
  }
  return "";
}

// Key resolution matches the rest of the app: the Settings-managed encrypted
// secret wins, and the environment variable keeps working as a fallback (the
// operator stores those under varied casings, e.g. Apollo_API_Key).
function scanKey(pattern: RegExp): string {
  for (const [key, value] of Object.entries(process.env)) {
    if (value && pattern.test(key)) return value;
  }
  return "";
}
export async function apolloKey(): Promise<string> {
  const stored = await getSecret("apollo_api_key").catch(() => null);
  return stored || process.env.APOLLO_API_KEY || scanKey(/^apollo[_-]?(?:io[_-]?)?(?:api[_-]?)?(?:key|token)$/i);
}
export async function leadmagicKey(): Promise<string> {
  const stored = await getSecret("leadmagic_api_key").catch(() => null);
  return stored || process.env.LEADMAGIC_API_KEY || scanKey(/^lead[_-]?magic[_-]?(?:api[_-]?)?(?:key|token)$/i);
}

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

/* ── Ranking ────────────────────────────────────────────────────────── */

// Company-wide leaders. They score below a department head who owns the
// function the posting serves, but stay strong so a company whose only
// leadership is a founder still produces a good target.
const GENERAL_LEADERS: { score: number; label: string; pattern: RegExp }[] = [
  { score: 80, label: "Owner / founder", pattern: /\b(owner|founder|co[- ]?founder|founding|principal|proprietor)\b/i },
  { score: 78, label: "CEO / president", pattern: /\b(ceo|chief executive|president)\b/i },
  { score: 76, label: "GM / managing director", pattern: /\b(general manager|managing director|managing partner)\b/i },
  { score: 60, label: "Other C-level", pattern: /\b(chief\s+\w+\s+officer|cro|cco|cmo)\b/i },
];

// Departments the posted role typically lands in. Whoever runs one of these
// owns the pain the posting describes, so they outrank the top executive: at
// an SMB the department lead lives the problem daily, while the CEO is a
// layer removed.
const DOMAINS: { key: string; label: string; pattern: RegExp }[] = [
  // "operating"/"information officer" matter: without them a COO or CIO falls
  // through to the generic C-level tier instead of ranking as the head of the
  // function they actually own.
  { key: "operations", label: "operations", pattern: /\b(operations?|operating|ops|coo|plant|production|manufactur\w*|warehouse|distribution|logistics|supply chain|fleet|dispatch|field service|service delivery|branch)\b/i },
  { key: "technology", label: "technology / systems", pattern: /\b(it|information technology|information officer|technolog\w*|technical|systems?|software|application\w*|digital|data|automation|erp|infrastructure|cio|cto)\b/i },
  { key: "finance", label: "finance / business systems", pattern: /\b(finance|financial|accounting|controller|comptroller|business (?:systems?|operations|administration)|administrative|back office|cfo)\b/i },
];

// Seniority tiers, most senior first. "Head of X" and bare functional titles
// like Controller read as department heads at companies this size.
const SENIORITY: { key: "chief" | "vp" | "director" | "manager"; points: number; pattern: RegExp }[] = [
  { key: "chief", points: 95, pattern: /\b(chief|coo|cio|cto|cfo|cdo|caio)\b/i },
  { key: "vp", points: 90, pattern: /\b(vp|vice president|svp|evp)\b/i },
  { key: "director", points: 88, pattern: /\b(director|head of|head,|controller|comptroller)\b/i },
  { key: "manager", points: 70, pattern: /\b(manager|supervisor|superintendent|coordinator|lead)\b/i },
];

const EXCLUDE_PATTERN = /\b(hr|human resources|recruit(er|ing|ment)?|talent|people (ops|operations|officer|partner)|hiring)\b/i;

function normalizeForMatch(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

// A contact whose title matches a qualifying posted title is plausibly the
// hiring manager (or the role itself, filled) — "never contact any hiring
// manager" is a locked rule, so exclude rather than rank.
function matchesPostedRole(title: string, validTitles: string[]): boolean {
  const norm = normalizeForMatch(title);
  if (!norm) return false;
  for (const posted of validTitles) {
    const postedNorm = normalizeForMatch(posted);
    if (!postedNorm) continue;
    if (norm.includes(postedNorm) || postedNorm.includes(norm)) return true;
    const postedWords = postedNorm.split(" ").filter((word) => word.length > 3);
    if (postedWords.length >= 2) {
      const hits = postedWords.filter((word) => norm.includes(word)).length;
      if (hits >= Math.max(2, postedWords.length - 1)) return true;
    }
  }
  return false;
}

// Preferred target: whoever runs the department the posted role will serve —
// "head of operations" beats "CEO" — falling back to the top executive when
// the company has no such leader (common under ~50 people). Generic leaders
// keep their old standing, so a company with only a founder still ranks well.
export function rankContact(title: string | null, validTitles: string[]): { score: number; reason: string; excluded: string | null } {
  const text = (title ?? "").trim();
  if (!text) return { score: 0, reason: "No title on the profile.", excluded: null };
  if (EXCLUDE_PATTERN.test(text)) return { score: 0, reason: "HR / recruiting", excluded: "HR or recruiting role — never a target." };
  if (matchesPostedRole(text, validTitles)) {
    return { score: 0, reason: "Matches posted role", excluded: "Title matches the posted signal role — likely the hire itself." };
  }

  const domain = DOMAINS.find((entry) => entry.pattern.test(text)) ?? null;
  const seniority = SENIORITY.find((entry) => entry.pattern.test(text)) ?? null;

  // Department head for a function the hire serves — the strongest target.
  if (domain && seniority) {
    const owns = seniority.key === "manager" ? "Runs" : "Heads";
    return { score: seniority.points, reason: `${owns} ${domain.label}`, excluded: null };
  }

  // General leadership: the fallback when nobody owns the function.
  for (const bucket of GENERAL_LEADERS) {
    if (bucket.pattern.test(text)) return { score: bucket.score, reason: bucket.label, excluded: null };
  }
  if (seniority) return { score: 40, reason: `${seniority.key === "manager" ? "Manager" : "Leader"}, unrelated department`, excluded: null };
  return { score: 10, reason: "Non-leadership role", excluded: null };
}

/* ── Roster run lifecycle ───────────────────────────────────────────── */

type CompanyRow = {
  id: string;
  name: string;
  domain: string | null;
  linkedin_url: string | null;
  website_url: string | null;
  contacts_state: string;
  contacts_run_id: string | null;
  flags: Record<string, unknown> | null;
};

async function loadCompany(companyId: string): Promise<CompanyRow> {
  const db = getAdminClient();
  const { data, error } = await db
    .from("signal_companies")
    .select("id, name, domain, linkedin_url, website_url, contacts_state, contacts_run_id, flags")
    .eq("id", companyId)
    .single();
  if (error || !data) throw new Error(error?.message ?? "Company not found.");
  return data as CompanyRow;
}

// Start the roster scrape. CAS on contacts_state so concurrent ticks and the
// drawer button can race safely; only the winner starts (and pays for) a run.
export async function startContactSourcing(companyId: string): Promise<boolean> {
  const db = getAdminClient();
  const company = await loadCompany(companyId);
  if (!company.linkedin_url) {
    await db
      .from("signal_companies")
      .update({ contacts_state: "errored", contacts_error: "No LinkedIn company URL — the roster scrape needs one.", updated_at: new Date().toISOString() })
      .eq("id", companyId)
      .in("contacts_state", ["none", "pending", "errored"]);
    return false;
  }
  const token = await apifyToken();
  if (!token) throw new Error("Missing Apify token. Add it in Settings → Integrations (or APIFY_TOKEN).");

  const { data: claimed } = await db
    .from("signal_companies")
    .update({ contacts_state: "sourcing", contacts_error: null, updated_at: new Date().toISOString() })
    .eq("id", companyId)
    .in("contacts_state", ["none", "pending", "errored"])
    .select("id");
  if ((claimed ?? []).length === 0) return false;

  // A roster describes the real company, not this automation's opinion of it.
  // If another automation already bought a fresh one, copy it instead of paying
  // twice; if one is in flight there, wait for it.
  const lease = await claimProfileWork(companyId, "roster");
  if (!lease.mayPay) {
    const copied = lease.copiedFrom ? await copyRosterFrom(companyId, lease.copiedFrom) : false;
    await db
      .from("signal_companies")
      .update(
        copied
          ? { contacts_state: "sourced", contacts_sourced_at: new Date().toISOString(), updated_at: new Date().toISOString() }
          : { contacts_state: "pending", updated_at: new Date().toISOString() },
      )
      .eq("id", companyId)
      .eq("contacts_state", "sourcing");
    if (copied) {
      await rankAndPick(companyId);
      await findEmailsForPicks(companyId);
    }
    return false;
  }

  try {
    const input = {
      companies: [company.linkedin_url],
      profileScraperMode: "Full ($8 per 1k)",
      maxItems: ROSTER_MAX_ITEMS,
    };
    const res = await fetch(`https://api.apify.com/v2/acts/${ROSTER_ACTOR}/runs`, {
      method: "POST",
      headers: { "content-type": "application/json", ...apifyAuth(token) },
      body: JSON.stringify(input),
      signal: AbortSignal.timeout(30_000),
    });
    const json = (await res.json().catch(() => ({}))) as { data?: { id?: string }; error?: { message?: string } };
    if (!res.ok || !json.data?.id) throw new Error(`Apify roster run failed to start: HTTP ${res.status} ${json.error?.message ?? ""}`.trim());
    await db.from("signal_companies").update({ contacts_run_id: json.data.id, updated_at: new Date().toISOString() }).eq("id", companyId);
    return true;
  } catch (error) {
    const message = (error instanceof Error ? error.message : "Roster run failed to start.").slice(0, 400);
    await db
      .from("signal_companies")
      .update({ contacts_state: "errored", contacts_error: message, updated_at: new Date().toISOString() })
      .eq("id", companyId)
      .eq("contacts_state", "sourcing");
    await finishProfileWork(companyId, "roster", false);
    return false;
  }
}

export const RATE_LIMIT_MARKER = "LinkedIn rate limit";

// Read the failed run's log tail for a human reason. Rate limiting is the
// common one and is temporary, so it gets a marker the retry sweep matches on.
async function failureReason(runId: string, token: string): Promise<string | null> {
  try {
    const res = await fetch(`https://api.apify.com/v2/logs/${runId}`, { headers: apifyAuth(token), signal: AbortSignal.timeout(20_000) });
    if (!res.ok) return null;
    const log = (await res.text()).slice(-4000);
    if (/rate limit/i.test(log)) {
      return `${RATE_LIMIT_MARKER} hit on the shared scraper (resets hourly) — this retries automatically.`;
    }
    const errorLine = log.split("\n").reverse().find((line) => /error|failed/i.test(line));
    return errorLine ? errorLine.replace(/^\S+\s+/, "").slice(0, 300) : null;
  } catch {
    return null;
  }
}

// Poll a sourcing company's Apify run; on success ingest + rank + pick + find
// emails. Returns the roster spend estimate added (0 while still running).
export async function checkContactSourcing(companyId: string): Promise<{ done: boolean; spendUsd: number }> {
  const db = getAdminClient();
  const company = await loadCompany(companyId);
  if (company.contacts_state !== "sourcing") return { done: company.contacts_state === "sourced" || company.contacts_state === "errored", spendUsd: 0 };
  if (!company.contacts_run_id) {
    // Claimed but the start request never recorded a run id (crashed between
    // the CAS and the insert) — reset so the next tick retries.
    await db.from("signal_companies").update({ contacts_state: "pending", updated_at: new Date().toISOString() }).eq("id", companyId).eq("contacts_state", "sourcing");
    return { done: false, spendUsd: 0 };
  }
  const token = await apifyToken();
  if (!token) throw new Error("Missing Apify token.");

  const res = await fetch(`https://api.apify.com/v2/actor-runs/${company.contacts_run_id}`, { headers: apifyAuth(token), signal: AbortSignal.timeout(30_000) });
  const json = (await res.json().catch(() => ({}))) as { data?: { status?: string; defaultDatasetId?: string } };
  const status = json.data?.status ?? "";
  if (status === "FAILED" || status === "ABORTED" || status === "TIMED-OUT") {
    // The run object carries no status message, so the reason lives in the
    // log — worth reading: LinkedIn rate limits are shared across the actor's
    // users, hourly, and self-heal (see the retry sweep below).
    const reason = await failureReason(company.contacts_run_id, token);
    await db
      .from("signal_companies")
      .update({ contacts_state: "errored", contacts_error: reason ?? `Apify roster run ${status}.`, updated_at: new Date().toISOString() })
      .eq("id", companyId)
      .eq("contacts_state", "sourcing");
    await finishProfileWork(companyId, "roster", false);
    return { done: true, spendUsd: 0 };
  }
  if (status !== "SUCCEEDED") return { done: false, spendUsd: 0 };

  const itemsRes = await fetch(`https://api.apify.com/v2/datasets/${json.data?.defaultDatasetId}/items?clean=true`, {
    headers: apifyAuth(token),
    signal: AbortSignal.timeout(120_000),
  });
  if (!itemsRes.ok) {
    await db
      .from("signal_companies")
      .update({ contacts_state: "errored", contacts_error: `Roster dataset fetch failed: HTTP ${itemsRes.status}`, updated_at: new Date().toISOString() })
      .eq("id", companyId)
      .eq("contacts_state", "sourcing");
    await finishProfileWork(companyId, "roster", false);
    return { done: true, spendUsd: 0 };
  }
  const items = (await itemsRes.json().catch(() => [])) as unknown[];

  try {
    const counts = await ingestRoster(companyId, Array.isArray(items) ? items : [], { name: company.name, linkedinUrl: company.linkedin_url });
    await rankAndPick(companyId);
    await findEmailsForPicks(companyId);
    await db
      .from("signal_companies")
      .update({
        contacts_state: "sourced",
        contacts_error: null,
        contacts_sourced_at: new Date().toISOString(),
        roster_count: counts.total,
        linkedin_profile_count: counts.total,
        // Observed employees, not a census — the size stage treats it as a
        // floor and re-estimates from it (see 063).
        linkedin_employee_count: counts.employedHere,
        updated_at: new Date().toISOString(),
      })
      .eq("id", companyId)
      .eq("contacts_state", "sourcing");
    await requeueForResize(companyId, counts.employedHere);
    await finishProfileWork(companyId, "roster", true);
    return { done: true, spendUsd: ROSTER_START_USD + counts.total * ROSTER_PROFILE_USD };
  } catch (error) {
    const message = (error instanceof Error ? error.message : "Roster ingest failed.").slice(0, 400);
    await db
      .from("signal_companies")
      .update({ contacts_state: "errored", contacts_error: message, updated_at: new Date().toISOString() })
      .eq("id", companyId)
      .eq("contacts_state", "sourcing");
    await finishProfileWork(companyId, "roster", false);
    return { done: true, spendUsd: 0 };
  }
}

// A fresh observation the current estimate was not built on: send the company
// back through the funnel once so the size stage re-estimates from it. The AI
// stages are reused (same config, same evidence), so this costs one small
// sizing call, and operator decisions stay sticky. Terminates because the
// stage records the anchor it used.
async function requeueForResize(companyId: string, observed: number): Promise<void> {
  if (observed <= 0) return;
  const db = getAdminClient();
  const { data } = await db
    .from("signal_companies")
    .select("headcount_source, headcount_anchor, funnel_state")
    .eq("id", companyId)
    .maybeSingle();
  if (!data) return;
  // Verified and company-reported figures outrank an observed LinkedIn floor.
  if (data.headcount_source === "verified" || data.headcount_source === "indeed_profile") return;
  if (data.headcount_anchor === observed) return;
  if (data.funnel_state !== "qualified" && data.funnel_state !== "killed") return;
  await db.from("signal_companies").update({ funnel_state: "pending", claimed_at: null }).eq("id", companyId);
}

// Clone a sibling automation's roster. Only the profile facts travel — rank,
// picks, push state and email provenance are this automation's own, and
// cloning them would let two campaigns believe they own the same person.
async function copyRosterFrom(companyId: string, sourceCompanyId: string): Promise<boolean> {
  const db = getAdminClient();
  const { data: source } = await db
    .from("signal_contacts")
    .select("full_name, first_name, last_name, title, location, about, picture_url, linkedin_url, linkedin_member_id, tenure_months, started_on, employment_status, current_employer, email, email_status, email_source, email_checked_at, provider, provider_payload")
    .eq("company_id", sourceCompanyId);
  if (!source?.length) return false;
  const { error } = await db
    .from("signal_contacts")
    .upsert(
      source.map((row) => ({ ...row, company_id: companyId, status: "candidate", pick_order: null, pick_by_operator: false, lead_id: null, pushed_at: null })),
      { onConflict: "company_id,linkedin_member_id", ignoreDuplicates: true },
    );
  if (error) return false;
  const { data: counts } = await db
    .from("signal_companies")
    .select("roster_count, linkedin_profile_count, linkedin_employee_count")
    .eq("id", sourceCompanyId)
    .maybeSingle();
  if (counts) await db.from("signal_companies").update(counts).eq("id", companyId);
  return true;
}

/* ── Ingest ─────────────────────────────────────────────────────────── */

type NormalizedContact = {
  memberId: string;
  firstName: string;
  lastName: string;
  title: string | null;
  location: string | null;
  about: string | null;
  pictureUrl: string | null;
  linkedinUrl: string | null;
  tenureMonths: number | null;
  startedOn: string | null;
  // Current-employer check against the company we searched: "yes" (a current
  // position names it), "no" (positions exist but all name someone else — the
  // person has moved on), "unknown" (no position data to check).
  employedHere: "yes" | "no" | "unknown";
  currentEmployer: string | null;
  raw: Record<string, unknown>;
};

// "3 yrs 2 mos" / "5 mos" / "1 yr" -> months.
function parseDuration(text: string): number | null {
  if (!text) return null;
  const years = Number(text.match(/(\d+)\s*(?:yrs?|years?)/i)?.[1] ?? 0);
  const months = Number(text.match(/(\d+)\s*(?:mos?|months?)/i)?.[1] ?? 0);
  const total = years * 12 + months;
  return total > 0 ? total : null;
}

// The /company/<slug> segment, when the URL uses a slug rather than a numeric id.
function companySlug(url: string | null): string | null {
  const slug = url?.match(/\/company\/([^/?#]+)/i)?.[1]?.toLowerCase() ?? null;
  return slug && !/^\d+$/.test(slug) ? slug : null;
}

// harvestapi item -> contact. Field shapes differ by scraper mode: Full mode
// returns `currentPosition[]` (rich: position, duration, company identity),
// Short mode returns `currentPositions[]`. Read both — reading only one silently
// falls back to `headline`, which is often just the person's name.
export function normalizeRosterItem(item: unknown, target: { name: string; linkedinUrl: string | null }): NormalizedContact | null {
  if (!item || typeof item !== "object") return null;
  const it = item as Record<string, unknown>;
  const memberId = str(it.id) || str(it.publicIdentifier);
  const firstName = str(it.firstName);
  const lastName = str(it.lastName);
  if (!memberId || (!firstName && !lastName)) return null;

  const positions = [
    ...(Array.isArray(it.currentPosition) ? (it.currentPosition as Record<string, unknown>[]) : []),
    ...(Array.isArray(it.currentPositions) ? (it.currentPositions as Record<string, unknown>[]) : []),
  ].filter((p): p is Record<string, unknown> => Boolean(p) && typeof p === "object");

  // Does any current position name the company we searched? Match on the
  // LinkedIn slug first (exact), then on the normalized company name so that
  // numeric-id company URLs still resolve.
  const targetSlug = companySlug(target.linkedinUrl);
  const targetKey = companyNameKey(target.name);
  const matches = (position: Record<string, unknown>) => {
    const slug = str(position.companyUniversalName).toLowerCase() || companySlug(str(position.companyLinkedinUrl));
    if (slug && targetSlug && slug === targetSlug) return true;
    const name = str(position.companyName);
    return Boolean(name) && companyNameKey(name) === targetKey;
  };
  const here = positions.find(matches) ?? null;
  const employedHere: NormalizedContact["employedHere"] = here ? "yes" : positions.length > 0 ? "no" : "unknown";
  const current = here ?? positions[0] ?? null;

  // Full mode: duration text + startDate. Short mode: tenure objects.
  const tenureObject = (current?.tenureAtCompany ?? current?.tenureAtPosition ?? null) as Record<string, unknown> | null;
  const tenureMonths = tenureObject
    ? Number(tenureObject.numYears ?? 0) * 12 + Number(tenureObject.numMonths ?? 0)
    : parseDuration(str(current?.duration));
  const startDate = (current?.startDate ?? current?.startedOn ?? null) as Record<string, unknown> | null;
  const startedOn = startDate?.year
    ? `${startDate.year}${startDate.month ? `-${String(startDate.month).padStart(2, "0")}` : ""}`
    : null;

  const location = (it.location ?? null) as Record<string, unknown> | string | null;
  const locationText =
    typeof location === "string" ? location : str(location?.linkedinText) || str(location?.parsed) || str(current?.location);

  // Full mode exposes the vanity slug; short mode only the hashed member URL.
  const vanity = str(it.publicIdentifier);
  const linkedinUrl = vanity ? `https://www.linkedin.com/in/${vanity}` : str(it.linkedinUrl) || null;

  // Keep the payload lean: these arrays are long and unused downstream.
  const raw = { ...it };
  for (const key of ["experience", "education", "skills", "courses", "patents", "projects", "publications", "certifications", "receivedRecommendations", "volunteering", "interests", "honorsAndAwards", "coverPicture", "profilePicture", "photo", "moreProfiles"]) {
    delete raw[key];
  }

  return {
    memberId,
    firstName,
    lastName,
    // The position title beats the headline ("Ty Park", "--", "X at Y" are all
    // real headlines we saw); the headline is only a fallback.
    title: str(current?.position) || str(current?.title) || str(it.headline) || null,
    location: locationText || null,
    about: str(it.about) || str(it.summary) || null,
    pictureUrl: str(it.pictureUrl) || str((it.profilePicture as Record<string, unknown>)?.url) || null,
    linkedinUrl,
    tenureMonths: tenureMonths && Number.isFinite(tenureMonths) && tenureMonths > 0 ? tenureMonths : null,
    startedOn,
    employedHere,
    currentEmployer: str(current?.companyName) || null,
    raw: raw as Record<string, unknown>,
  };
}

async function ingestRoster(companyId: string, items: unknown[], target: { name: string; linkedinUrl: string | null }): Promise<{ total: number; employedHere: number }> {
  const db = getAdminClient();
  const contacts = items.map((item) => normalizeRosterItem(item, target)).filter((c): c is NormalizedContact => c !== null);
  const byMember = new Map<string, NormalizedContact>();
  for (const contact of contacts) if (!byMember.has(contact.memberId)) byMember.set(contact.memberId, contact);
  const unique = [...byMember.values()];
  const employedHere = unique.filter((contact) => contact.employedHere !== "no").length;
  if (unique.length === 0) return { total: 0, employedHere: 0 };

  const { data: existing, error } = await db
    .from("signal_contacts")
    .select("id, linkedin_member_id")
    .eq("company_id", companyId);
  if (error) throw new Error(`Contact lookup failed: ${error.message}`);
  const existingByMember = new Map((existing ?? []).map((row) => [row.linkedin_member_id as string, row.id as string]));

  const now = new Date().toISOString();
  for (const contact of unique) {
    const base = {
      full_name: `${contact.firstName} ${contact.lastName}`.trim(),
      first_name: contact.firstName || null,
      last_name: contact.lastName || null,
      title: contact.title,
      location: contact.location,
      about: contact.about,
      picture_url: contact.pictureUrl,
      linkedin_url: contact.linkedinUrl,
      tenure_months: contact.tenureMonths,
      started_on: contact.startedOn,
      employment_status: contact.employedHere === "yes" ? "current" : contact.employedHere === "no" ? "departed" : "unknown",
      current_employer: contact.currentEmployer,
      provider: "harvestapi",
      provider_payload: contact.raw,
      updated_at: now,
    };
    const existingId = existingByMember.get(contact.memberId);
    if (existingId) {
      // Refresh profile facts; never touch pick/email/push state on re-source.
      const { error: updateError } = await db.from("signal_contacts").update(base).eq("id", existingId);
      if (updateError) throw new Error(`Contact update failed: ${updateError.message}`);
    } else {
      const { error: insertError } = await db
        .from("signal_contacts")
        .insert({ ...base, company_id: companyId, linkedin_member_id: contact.memberId, status: "candidate" });
      if (insertError && insertError.code !== "23505") throw new Error(`Contact insert failed: ${insertError.message}`);
    }
  }
  return { total: unique.length, employedHere };
}

/* ── Rank + auto-pick ───────────────────────────────────────────────── */

// How closely a contact's title matches the title the JD says the role reports
// to. 2 = the reporting title's distinctive words are all present, 1 = the head
// noun matches (a "Director of Operations" for a JD naming "Operations
// Director"), 0 = no match. Deliberately word-based: JDs phrase the same job a
// dozen ways, but they rarely change the nouns.
export function reportsToMatch(contactTitle: string | null, reportsTo: string | null): 0 | 1 | 2 {
  if (!contactTitle || !reportsTo) return 0;
  // Collapse the spelled-out C-suite phrases to the abbreviation FIRST, so
  // "Chief Operating Officer" and "COO" become the same single token. Expanding
  // the abbreviation instead would inflate one side's word count and make an
  // exact match unreachable.
  const PHRASES: [RegExp, string][] = [
    [/\bchief\s+oper(?:ating|ations)\s+officer\b/g, "coo"],
    [/\bchief\s+executive\s+officer\b/g, "ceo"],
    [/\bchief\s+financial\s+officer\b/g, "cfo"],
    [/\bchief\s+technology\s+officer\b/g, "cto"],
    [/\bchief\s+information\s+officer\b/g, "cio"],
    [/\bvice\s+president\b/g, "vp"],
  ];
  const norm = (value: string) => {
    let text = value.toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
    for (const [pattern, token] of PHRASES) text = text.replace(pattern, token);
    return text;
  };
  const STOP = new Set(["of", "the", "and", "for", "to", "a", "an", "senior", "sr", "junior", "jr"]);
  const words = (value: string) => norm(value).split(" ").filter((w) => w && !STOP.has(w));
  const target = words(reportsTo);
  const actual = new Set(words(contactTitle));
  if (target.length === 0) return 0;

  const hits = target.filter((word) => actual.has(word)).length;
  if (hits === target.length) return 2;
  // Head noun = the role word ("director", "manager", "officer"), which is what
  // survives rephrasing; require it plus at least one qualifier.
  const ROLE_WORDS = ["director", "manager", "officer", "president", "head", "chief", "lead", "owner", "controller"];
  const sharedRole = target.some((word) => ROLE_WORDS.includes(word) && actual.has(word));
  return sharedRole && hits >= 2 ? 1 : 0;
}

async function reportsToFor(companyId: string): Promise<string | null> {
  const db = getAdminClient();
  const { data } = await db.from("signal_companies").select("reports_to_title").eq("id", companyId).maybeSingle();
  return (data?.reports_to_title as string | null) ?? null;
}

async function latestValidTitles(companyId: string): Promise<string[]> {
  const db = getAdminClient();
  const { data } = await db
    .from("signal_stage_results")
    .select("output")
    .eq("company_id", companyId)
    .eq("stage", "title_gate")
    .neq("verdict", "error")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  const output = (data?.output ?? {}) as Record<string, unknown>;
  return Array.isArray(output.validTitles) ? (output.validTitles as string[]).filter((t) => typeof t === "string") : [];
}

export async function rankAndPick(companyId: string): Promise<void> {
  const db = getAdminClient();
  const [validTitles, reportsTo] = await Promise.all([latestValidTitles(companyId), reportsToFor(companyId)]);
  const { data: rows, error } = await db
    .from("signal_contacts")
    .select("id, title, tenure_months, status, pick_order, pick_by_operator, exclusion_reason, employment_status, current_employer")
    .eq("company_id", companyId);
  if (error) throw new Error(`Contact rank load failed: ${error.message}`);

  const ranked = (rows ?? [])
    .map((row) => {
      const title = (row.title as string | null) ?? null;
      const verdict = rankContact(title, validTitles);
      // Someone who has moved on is never a target, whatever their title.
      const departed = row.employment_status === "departed";
      const employer = (row.current_employer as string | null) ?? null;
      let resolved = departed
        ? { score: 0, reason: "No longer here", excluded: `Left the company${employer ? ` — now at ${employer}` : ""}.` }
        : verdict;
      // The JD named who this role answers to — beats every heuristic, because
      // the company itself told us. Never resurrects an excluded contact (HR,
      // departed, or the posted role itself stay out).
      const match = resolved.excluded === null ? reportsToMatch(title, reportsTo) : 0;
      if (match > 0) {
        resolved = {
          score: match === 2 ? 200 : 150,
          reason: `The posting reports to ${reportsTo}`,
          excluded: null,
        };
      }
      return {
        id: row.id as string,
        ...resolved,
        matchedReportsTo: match > 0,
        tenure: (row.tenure_months as number | null) ?? 0,
        operatorPick: row.pick_by_operator === true,
        pickOrder: row.pick_order as number | null,
      };
    })
    .sort((a, b) => b.score - a.score || (b.tenure ?? 0) - (a.tenure ?? 0));

  // Sticky operator picks survive re-ranking; auto picks are recomputed.
  const operatorPicked = ranked.filter((r) => r.operatorPick && r.pickOrder !== null);
  const autoSlots = Math.max(0, 2 - operatorPicked.length);
  const taken = new Set(operatorPicked.map((r) => r.id));
  const autoPicks = ranked.filter((r) => !taken.has(r.id) && r.excluded === null && r.score >= 45).slice(0, autoSlots);
  const usedOrders = new Set(operatorPicked.map((r) => r.pickOrder as number));
  let nextOrder = 1;
  const orderFor = () => {
    while (usedOrders.has(nextOrder)) nextOrder += 1;
    usedOrders.add(nextOrder);
    return nextOrder;
  };
  const autoOrder = new Map(autoPicks.map((r) => [r.id, orderFor()]));

  const now = new Date().toISOString();
  for (let index = 0; index < ranked.length; index += 1) {
    const entry = ranked[index];
    const isOperator = entry.operatorPick && entry.pickOrder !== null;
    const auto = autoOrder.get(entry.id) ?? null;
    const { error: updateError } = await db
      .from("signal_contacts")
      .update({
        rank: index + 1,
        rank_score: entry.score,
        rank_reason: entry.reason,
        status: isOperator ? "selected" : entry.excluded !== null ? "excluded" : auto !== null ? "selected" : "candidate",
        exclusion_reason: entry.excluded,
        pick_order: isOperator ? entry.pickOrder : auto,
        matched_reports_to: entry.matchedReportsTo,
        updated_at: now,
      })
      .eq("id", entry.id);
    if (updateError) throw new Error(`Contact rank update failed: ${updateError.message}`);
  }
}

/* ── Email waterfall ────────────────────────────────────────────────── */

type EmailAttempt = { email: string | null; source: string | null; error: string | null };

// harvestapi returns LinkedIn's hashed member URL (/in/ACwAA…) rather than the
// vanity slug; Apollo cannot resolve those, so only a real slug is worth
// sending — a hashed one would just weaken an otherwise good name+domain match.
function vanityLinkedinUrl(url: string | null): string | undefined {
  if (!url) return undefined;
  return /\/in\/ACw[A-Za-z0-9_-]+/.test(url) ? undefined : url;
}

async function findEmailApollo(
  contact: { firstName: string | null; lastName: string | null; linkedinUrl: string | null },
  company: { name: string; domain: string | null },
): Promise<EmailAttempt> {
  const key = await apolloKey();
  if (!key) return { email: null, source: null, error: "Apollo key not configured" };
  try {
    const res = await fetch("https://api.apollo.io/api/v1/people/match", {
      method: "POST",
      // Key in the header (Apollo is deprecating URL-parameter keys), and the
      // reveal flags stay off so a lookup can never bill personal-email or
      // phone credits.
      headers: { "content-type": "application/json", accept: "application/json", "x-api-key": key },
      body: JSON.stringify({
        first_name: contact.firstName ?? undefined,
        last_name: contact.lastName ?? undefined,
        organization_name: company.name,
        domain: company.domain ?? undefined,
        linkedin_url: vanityLinkedinUrl(contact.linkedinUrl),
        reveal_personal_emails: false,
        reveal_phone_number: false,
      }),
      signal: AbortSignal.timeout(30_000),
    });
    const json = (await res.json().catch(() => ({}))) as { person?: { email?: string | null } };
    if (!res.ok) return { email: null, source: null, error: `Apollo HTTP ${res.status}` };
    const email = str(json.person?.email);
    if (!email || !email.includes("@") || email.includes("email_not_unlocked")) return { email: null, source: null, error: null };
    return { email, source: "apollo", error: null };
  } catch (error) {
    return { email: null, source: null, error: (error instanceof Error ? error.message : "Apollo failed").slice(0, 200) };
  }
}

async function findEmailLeadMagic(
  contact: { firstName: string | null; lastName: string | null; linkedinUrl: string | null },
  company: { name: string; domain: string | null },
): Promise<EmailAttempt> {
  const key = await leadmagicKey();
  if (!key) return { email: null, source: null, error: "LeadMagic key not configured" };
  try {
    const client = new LeadMagicClient({ apiKey: key });
    const lead = {
      firstName: contact.firstName ?? "",
      lastName: contact.lastName ?? "",
      company: company.name,
      domain: company.domain ?? "",
      linkedinUrl: contact.linkedinUrl ?? "",
    } as unknown as EnrichmentLead;
    const result = await client.findEmail(lead);
    return { email: result.email, source: result.email ? "leadmagic" : null, error: null };
  } catch (error) {
    return { email: null, source: null, error: (error instanceof Error ? error.message : "LeadMagic failed").slice(0, 200) };
  }
}

// Waterfall for one contact: Apollo first (existing paid account), LeadMagic
// second. "Not found with no provider errors" is a real verdict ('not_found');
// provider-config errors leave 'error' so the operator sees why.
export async function findContactEmail(contactId: string): Promise<SignalContactDto | null> {
  const db = getAdminClient();
  const { data: row, error } = await db
    .from("signal_contacts")
    .select("id, company_id, first_name, last_name, linkedin_url, email")
    .eq("id", contactId)
    .single();
  if (error || !row) throw new Error(error?.message ?? "Contact not found.");
  const { data: companyRow } = await db.from("signal_companies").select("name, domain, website_url").eq("id", row.company_id as string).single();
  const domain =
    (companyRow?.domain as string | null) ??
    ((companyRow?.website_url as string | null)?.replace(/^https?:\/\/(www\.)?/, "").split("/")[0] || null);
  const company = { name: (companyRow?.name as string) ?? "", domain };
  const contact = { firstName: row.first_name as string | null, lastName: row.last_name as string | null, linkedinUrl: row.linkedin_url as string | null };

  await db.from("signal_contacts").update({ email_status: "pending", updated_at: new Date().toISOString() }).eq("id", contactId);

  const attempts: EmailAttempt[] = [];
  let found: EmailAttempt | null = null;
  for (const provider of [findEmailApollo, findEmailLeadMagic]) {
    const attempt = await provider(contact, company);
    attempts.push(attempt);
    if (attempt.email) {
      found = attempt;
      break;
    }
  }

  const errors = attempts.map((a) => a.error).filter(Boolean);
  const allErrored = !found && errors.length === attempts.length && attempts.length > 0;
  await db
    .from("signal_contacts")
    .update({
      email: found?.email ?? (row.email as string | null),
      email_source: found?.source ?? null,
      email_status: found ? "found" : allErrored ? "error" : "not_found",
      email_error: found ? null : errors.join(" · ").slice(0, 300) || null,
      email_checked_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", contactId);
  return getContact(contactId);
}

// Emails for the current picks that have not been checked yet.
export async function findEmailsForPicks(companyId: string): Promise<void> {
  const db = getAdminClient();
  const { data: picks } = await db
    .from("signal_contacts")
    .select("id, email_status")
    .eq("company_id", companyId)
    .not("pick_order", "is", null)
    .order("pick_order");
  for (const pick of picks ?? []) {
    if (pick.email_status === "found") continue;
    await findContactEmail(pick.id as string);
  }
}

/* ── Reads + operator actions ───────────────────────────────────────── */

const CONTACT_COLUMNS =
  "id, company_id, full_name, first_name, last_name, title, location, about, picture_url, linkedin_url, linkedin_member_id, tenure_months, started_on, employment_status, current_employer, rank, rank_score, rank_reason, matched_reports_to, status, exclusion_reason, pick_order, pick_by_operator, email, email_status, email_source, email_error, email_checked_at, lead_id, pushed_at";

function toContactDto(row: Record<string, unknown>): SignalContactDto {
  return {
    id: String(row.id),
    companyId: String(row.company_id),
    fullName: (row.full_name as string | null) ?? "",
    firstName: row.first_name as string | null,
    lastName: row.last_name as string | null,
    title: row.title as string | null,
    location: row.location as string | null,
    about: row.about as string | null,
    pictureUrl: row.picture_url as string | null,
    linkedinUrl: row.linkedin_url as string | null,
    tenureMonths: row.tenure_months as number | null,
    startedOn: row.started_on as string | null,
    rank: row.rank as number | null,
    rankScore: row.rank_score as number | null,
    rankReason: row.rank_reason as string | null,
    employmentStatus: (row.employment_status as SignalContactDto["employmentStatus"]) ?? null,
    currentEmployer: row.current_employer as string | null,
    matchedReportsTo: row.matched_reports_to === true,
    status: (row.status as SignalContactDto["status"]) ?? "candidate",
    exclusionReason: row.exclusion_reason as string | null,
    pickOrder: row.pick_order as number | null,
    pickByOperator: row.pick_by_operator === true,
    email: row.email as string | null,
    emailStatus: row.email_status as SignalContactDto["emailStatus"],
    emailSource: row.email_source as string | null,
    emailError: row.email_error as string | null,
    leadId: row.lead_id as string | null,
    pushedAt: row.pushed_at as string | null,
  };
}

export async function getContact(contactId: string): Promise<SignalContactDto | null> {
  const db = getAdminClient();
  const { data } = await db.from("signal_contacts").select(CONTACT_COLUMNS).eq("id", contactId).maybeSingle();
  return data ? toContactDto(data as Record<string, unknown>) : null;
}

export async function getCompanyContacts(companyId: string): Promise<SignalContactDto[]> {
  const db = getAdminClient();
  const { data, error } = await db
    .from("signal_contacts")
    .select(CONTACT_COLUMNS)
    .eq("company_id", companyId)
    .order("rank", { ascending: true, nullsFirst: false })
    .limit(200);
  if (error) throw new Error(`Could not load contacts: ${error.message}`);
  return ((data ?? []) as Record<string, unknown>[]).map(toContactDto);
}

// Operator pick toggle: set someone as primary/backup, or unpick. Sticky —
// re-sourcing never reverts an operator's choice.
export async function setContactPick(contactId: string, pickOrder: 1 | 2 | null): Promise<void> {
  const db = getAdminClient();
  const { data: row, error } = await db.from("signal_contacts").select("id, company_id").eq("id", contactId).single();
  if (error || !row) throw new Error(error?.message ?? "Contact not found.");
  const now = new Date().toISOString();
  if (pickOrder !== null) {
    // Displace whoever holds this slot (their status returns to candidate).
    await db
      .from("signal_contacts")
      .update({ pick_order: null, status: "candidate", pick_by_operator: true, updated_at: now })
      .eq("company_id", row.company_id as string)
      .eq("pick_order", pickOrder)
      .neq("id", contactId);
  }
  const { error: updateError } = await db
    .from("signal_contacts")
    .update({
      pick_order: pickOrder,
      status: pickOrder !== null ? "selected" : "candidate",
      pick_by_operator: true,
      updated_at: now,
    })
    .eq("id", contactId);
  if (updateError) throw new Error(`Pick update failed: ${updateError.message}`);
  if (pickOrder !== null) {
    const contact = await getContact(contactId);
    if (contact && contact.emailStatus !== "found") await findContactEmail(contactId);
  }
}

// Queue a (re-)source. 'sourced' companies re-enter 'pending'; the funnel tick
// or drawer polling advances it.
export async function queueContactSourcing(companyId: string): Promise<void> {
  const db = getAdminClient();
  const { error } = await db
    .from("signal_companies")
    .update({ contacts_state: "pending", contacts_error: null, updated_at: new Date().toISOString() })
    .eq("id", companyId)
    .in("contacts_state", ["none", "sourced", "errored"]);
  if (error) throw new Error(`Could not queue contact sourcing: ${error.message}`);
}

/* ── Tick driver ────────────────────────────────────────────────────── */

// Advance contact sourcing across companies: poll all in-flight rosters, then
// start up to `maxStarts` pending ones. Returns whether any work remains and
// the spend added this tick. Called from the funnel tick and the poll action.
export async function advanceContactSourcing(automationId?: string, maxStarts = 2): Promise<{ active: number; spendUsd: number }> {
  const db = getAdminClient();
  let spendUsd = 0;
  // PostgREST builders are structurally identical here; typing the wrapper
  // precisely sends tsc into an unbounded instantiation.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const scoped = (q: any) => (automationId ? q.eq("automation_id", automationId) : q);

  const { data: sourcing } = await scoped(
    db.from("signal_companies").select("id").eq("contacts_state", "sourcing"),
  ).limit(20);
  for (const row of sourcing ?? []) {
    const result = await checkContactSourcing(row.id as string);
    spendUsd += result.spendUsd;
  }

  // Rate-limit failures reset hourly upstream, so re-queue them after a
  // cool-off instead of leaving them stuck (each start costs $0.02, so the
  // cool-off — not a retry counter — is what bounds the spend).
  const retryBefore = new Date(Date.now() - 35 * 60_000).toISOString();
  await scoped(
    db.from("signal_companies").update({ contacts_state: "pending", contacts_error: null }).eq("contacts_state", "errored"),
  )
    .eq("funnel_state", "qualified")
    .like("contacts_error", `%${RATE_LIMIT_MARKER}%`)
    .lt("updated_at", retryBefore);

  const { data: pending } = await scoped(
    db.from("signal_companies").select("id").eq("funnel_state", "qualified").eq("contacts_state", "pending"),
  ).limit(maxStarts);
  for (const row of pending ?? []) {
    await startContactSourcing(row.id as string);
  }

  const { count } = await scoped(
    db.from("signal_companies").select("id", { count: "exact", head: true }),
  ).in("contacts_state", ["pending", "sourcing"]);
  return { active: count ?? 0, spendUsd };
}
