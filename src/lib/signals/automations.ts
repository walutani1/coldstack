import "server-only";

import { z } from "zod";
import { getAdminClient } from "@/lib/supabase/admin";
import { getActiveFunnelConfig } from "@/lib/signals/config";
import type { AutomationCriteria, AutomationDto, AutomationSummary, FunnelConfig } from "@/lib/signals/types";

// An automation is the unit of work: its own searches, its own targeting
// criteria, its own campaign and prospect list. Judgment (studio context,
// prompts, models, weights, spend caps) stays global in signal_configs —
// that is who we are, not what this play targets.

export const DEFAULT_AUTOMATION_ID = "a0000000-0000-4000-8000-000000000001";

const AUTOMATION_COLUMNS =
  "id, name, status, criteria, smartlead_campaign_id, smartlead_campaign_name, prospect_table_id, " +
  "schedule, autopush, contacts_per_company, release_gap_days, archived, last_run_at, created_at, updated_at";

export const criteriaSchema = z
  .object({
    headcount: z.object({ min: z.number().int().min(1).max(100_000), max: z.number().int().min(1).max(1_000_000) }).optional(),
    industries: z
      .object({
        blocked: z.array(z.string().trim().min(1).max(80)).max(50),
        preferred: z.array(z.string().trim().min(1).max(80)).max(50),
      })
      .optional(),
    qualifiedThreshold: z.number().int().min(1).max(100).optional(),
    evidenceWindowDays: z.number().int().min(7).max(365).optional(),
  })
  .strict();

export const automationInputSchema = z.object({
  name: z.string().trim().min(1, "Give the automation a name.").max(80),
  criteria: criteriaSchema.default({}),
  contactsPerCompany: z.number().int().min(1).max(3).default(2),
  releaseGapDays: z.number().int().min(1).max(60).default(7),
  schedule: z.object({ frequency: z.enum(["manual", "daily"]).default("manual"), hourUtc: z.number().int().min(0).max(23).default(13) }).default({ frequency: "manual", hourUtc: 13 }),
  autopush: z.boolean().default(false),
});

type Row = Record<string, unknown>;

function toDto(row: Row): AutomationDto {
  const schedule = (row.schedule ?? {}) as { frequency?: string; hourUtc?: number };
  return {
    id: String(row.id),
    name: String(row.name),
    status: (row.status as AutomationDto["status"]) ?? "draft",
    criteria: (row.criteria ?? {}) as AutomationCriteria,
    campaignId: (row.smartlead_campaign_id as string | null) ?? null,
    campaignName: (row.smartlead_campaign_name as string | null) ?? null,
    prospectTableId: (row.prospect_table_id as string | null) ?? null,
    schedule: { frequency: schedule.frequency === "daily" ? "daily" : "manual", hourUtc: typeof schedule.hourUtc === "number" ? schedule.hourUtc : 13 },
    autopush: row.autopush === true,
    contactsPerCompany: Number(row.contacts_per_company ?? 2),
    releaseGapDays: Number(row.release_gap_days ?? 7),
    archived: row.archived === true,
    lastRunAt: (row.last_run_at as string | null) ?? null,
    createdAt: String(row.created_at),
  };
}

export async function listAutomations(): Promise<AutomationDto[]> {
  const db = getAdminClient();
  const { data, error } = await db
    .from("signal_automations")
    .select(AUTOMATION_COLUMNS)
    .eq("archived", false)
    .order("created_at", { ascending: true });
  if (error) throw new Error(`Could not load automations: ${error.message}`);
  return ((data ?? []) as unknown as Row[]).map(toDto);
}

export async function getAutomation(id: string): Promise<AutomationDto | null> {
  const db = getAdminClient();
  const { data, error } = await db.from("signal_automations").select(AUTOMATION_COLUMNS).eq("id", id).maybeSingle();
  if (error) throw new Error(`Could not load the automation: ${error.message}`);
  return data ? toDto(data as unknown as Row) : null;
}

export async function createAutomation(input: unknown): Promise<AutomationDto> {
  const parsed = automationInputSchema.parse(input);
  if (parsed.criteria.headcount && parsed.criteria.headcount.min > parsed.criteria.headcount.max) {
    throw new Error("Headcount min cannot exceed max.");
  }
  const db = getAdminClient();
  const { data, error } = await db
    .from("signal_automations")
    .insert({
      name: parsed.name,
      status: "draft",
      criteria: parsed.criteria,
      contacts_per_company: parsed.contactsPerCompany,
      release_gap_days: parsed.releaseGapDays,
      schedule: parsed.schedule,
      autopush: parsed.autopush,
    })
    .select(AUTOMATION_COLUMNS)
    .single();
  if (error || !data) throw new Error(`Could not create the automation: ${error?.message}`);
  return toDto(data as unknown as Row);
}

export async function updateAutomation(id: string, patch: Partial<z.infer<typeof automationInputSchema>> & { status?: AutomationDto["status"] }): Promise<AutomationDto> {
  const db = getAdminClient();
  const update: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (patch.name !== undefined) update.name = z.string().trim().min(1).max(80).parse(patch.name);
  if (patch.criteria !== undefined) update.criteria = criteriaSchema.parse(patch.criteria);
  if (patch.contactsPerCompany !== undefined) update.contacts_per_company = z.number().int().min(1).max(3).parse(patch.contactsPerCompany);
  if (patch.releaseGapDays !== undefined) update.release_gap_days = z.number().int().min(1).max(60).parse(patch.releaseGapDays);
  if (patch.schedule !== undefined) update.schedule = patch.schedule;
  if (patch.autopush !== undefined) update.autopush = Boolean(patch.autopush);
  if (patch.status !== undefined) update.status = z.enum(["draft", "active", "paused"]).parse(patch.status);
  const { data, error } = await db.from("signal_automations").update(update).eq("id", id).select(AUTOMATION_COLUMNS).single();
  if (error || !data) throw new Error(`Could not update the automation: ${error?.message}`);
  return toDto(data as unknown as Row);
}

export async function setAutomationCampaign(id: string, tag: { id: string; name: string } | null): Promise<AutomationDto> {
  const db = getAdminClient();
  const { data, error } = await db
    .from("signal_automations")
    .update({
      smartlead_campaign_id: tag?.id ?? null,
      smartlead_campaign_name: tag?.name ?? null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", id)
    .select(AUTOMATION_COLUMNS)
    .single();
  if (error || !data) throw new Error(`Could not bind the campaign: ${error?.message}`);
  return toDto(data as unknown as Row);
}

export async function setAutomationTable(id: string, tableId: string | null): Promise<void> {
  const db = getAdminClient();
  const { error } = await db.from("signal_automations").update({ prospect_table_id: tableId, updated_at: new Date().toISOString() }).eq("id", id);
  if (error) throw new Error(`Could not bind the prospect list: ${error.message}`);
}

export async function archiveAutomation(id: string): Promise<void> {
  const db = getAdminClient();
  const { error } = await db.from("signal_automations").update({ archived: true, status: "paused", updated_at: new Date().toISOString() }).eq("id", id);
  if (error) throw new Error(`Could not archive the automation: ${error.message}`);
}

/* ── Effective config ───────────────────────────────────────────────────
   Global judgment + this automation's targeting. The merged object is what
   every stage reads, and it is snapshotted onto the run so an audit stays
   truthful after the automation is edited. */
export async function getEffectiveConfig(automationId: string): Promise<{ config: FunnelConfig; version: number; criteria: AutomationCriteria }> {
  const [{ config: global, version }, automation] = await Promise.all([getActiveFunnelConfig(), getAutomation(automationId)]);
  const criteria = automation?.criteria ?? {};
  return {
    version,
    criteria,
    config: {
      ...global,
      headcount: criteria.headcount ?? global.headcount,
      industries: criteria.industries ?? global.industries,
      qualifiedThreshold: criteria.qualifiedThreshold ?? global.qualifiedThreshold,
      evidenceWindowDays: criteria.evidenceWindowDays ?? global.evidenceWindowDays,
    },
  };
}

/* ── Guardrail: pay for a company's facts exactly once ──────────────────
   Research briefs and LinkedIn rosters describe a real-world company, not an
   automation's opinion of it. Two automations that both surface the same
   company must not both buy them. A lease decides who pays; everyone else
   copies the result. Facts also expire — a hiring signal is only useful for
   about two months, and a roster decays fastest. */
export const RESEARCH_TTL_DAYS = 56;
export const ROSTER_TTL_DAYS = 42;

function ttlCutoff(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString();
}

export type ProfileWork = "research" | "roster";

// True when this company may spend money on `work`. False means a fresh result
// was copied from a sibling automation, or another worker holds the lease.
export async function claimProfileWork(companyId: string, work: ProfileWork): Promise<{ mayPay: boolean; copiedFrom: string | null }> {
  const db = getAdminClient();
  const { data: company } = await db
    .from("signal_companies")
    .select("id, profile_key, automation_id")
    .eq("id", companyId)
    .maybeSingle();
  const profileKey = (company?.profile_key as string | null) ?? null;
  if (!profileKey) return { mayPay: true, copiedFrom: null };

  const ttl = work === "research" ? RESEARCH_TTL_DAYS : ROSTER_TTL_DAYS;
  const fresh = ttlCutoff(ttl);
  const statusCol = work === "research" ? "research_status" : "roster_status";
  const fetchedCol = work === "research" ? "research_fetched_at" : "roster_fetched_at";
  const ownerCol = work === "research" ? "research_company_id" : "roster_company_id";

  // Ensure the claim row exists so the conditional update below has a target.
  await db.from("signal_profile_claims").upsert({ profile_key: profileKey }, { onConflict: "profile_key", ignoreDuplicates: true });

  const { data: claim } = await db.from("signal_profile_claims").select("*").eq("profile_key", profileKey).maybeSingle();
  const claimRow = (claim ?? {}) as Record<string, unknown>;
  const status = claimRow[statusCol] as string | undefined;
  const fetchedAt = claimRow[fetchedCol] as string | null | undefined;
  const owner = claimRow[ownerCol] as string | null | undefined;

  // Someone already bought it recently — copy rather than re-buy.
  if (status === "done" && fetchedAt && fetchedAt >= fresh && owner && owner !== companyId) {
    return { mayPay: false, copiedFrom: owner };
  }
  // In flight elsewhere and the lease is still good — wait, do not double-buy.
  const leaseUntil = claimRow.lease_until as string | null | undefined;
  if (status === "running" && leaseUntil && leaseUntil > new Date().toISOString() && owner && owner !== companyId) {
    return { mayPay: false, copiedFrom: null };
  }

  // Take the lease. The paid call outlives any SQL transaction, so this is a
  // row-level lease with an expiry rather than a lock.
  const { data: won } = await db
    .from("signal_profile_claims")
    .update({
      [statusCol]: "running",
      [ownerCol]: companyId,
      lease_until: new Date(Date.now() + 15 * 60_000).toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("profile_key", profileKey)
    .or(`${statusCol}.is.null,${statusCol}.neq.running,lease_until.lt.${new Date().toISOString()}`)
    .select("profile_key");
  return { mayPay: (won ?? []).length > 0, copiedFrom: null };
}

export async function finishProfileWork(companyId: string, work: ProfileWork, ok: boolean): Promise<void> {
  const db = getAdminClient();
  const { data: company } = await db.from("signal_companies").select("profile_key").eq("id", companyId).maybeSingle();
  const profileKey = (company?.profile_key as string | null) ?? null;
  if (!profileKey) return;
  const statusCol = work === "research" ? "research_status" : "roster_status";
  const fetchedCol = work === "research" ? "research_fetched_at" : "roster_fetched_at";
  await db
    .from("signal_profile_claims")
    .update({
      [statusCol]: ok ? "done" : "failed",
      [fetchedCol]: ok ? new Date().toISOString() : null,
      lease_until: null,
      updated_at: new Date().toISOString(),
    })
    .eq("profile_key", profileKey);
}

// Copy a sibling automation's fresh research onto this company. Only the
// automation-independent facts travel; the verdict never does.
export async function copyResearchFrom(companyId: string, sourceCompanyId: string): Promise<boolean> {
  const db = getAdminClient();
  const { data: source } = await db
    .from("signal_companies")
    .select("research_status, research_brief, research_sources, research_model, researched_at, website_url, domain, headcount, headcount_source, headcount_confidence, headcount_anchor, linkedin_employee_count, linkedin_profile_count")
    .eq("id", sourceCompanyId)
    .maybeSingle();
  if (!source || source.research_status !== "done") return false;
  const { error } = await db
    .from("signal_companies")
    .update({ ...source, profile_copied_from: sourceCompanyId, researched_at_copy: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq("id", companyId);
  return !error;
}

/* ── Guardrail: one person, one campaign ────────────────────────────────
   Identity is the human (email / LinkedIn member), not the per-automation
   contact row — otherwise two automations each push the same person into their
   own campaign and both believe they own them. */
export function leadIdentityKey(contact: { email: string | null; linkedinMemberId?: string | null; linkedinUrl?: string | null }): string | null {
  if (contact.email?.trim()) return `email:${contact.email.trim().toLowerCase()}`;
  if (contact.linkedinMemberId?.trim()) return `member:${contact.linkedinMemberId.trim()}`;
  if (contact.linkedinUrl?.trim()) return `li:${contact.linkedinUrl.trim().toLowerCase()}`;
  return null;
}

export async function claimLead(
  identityKey: string,
  input: { automationId: string; contactId: string; campaignId: string | null; campaignName: string | null },
): Promise<{ ok: true } | { ok: false; heldBy: string; campaignName: string | null }> {
  const db = getAdminClient();
  const { error } = await db.from("signal_lead_claims").insert({
    identity_key: identityKey,
    automation_id: input.automationId,
    contact_id: input.contactId,
    smartlead_campaign_id: input.campaignId,
    smartlead_campaign_name: input.campaignName,
  });
  if (!error) return { ok: true };
  if (error.code !== "23505") throw new Error(`Lead claim failed: ${error.message}`);
  const { data: held } = await db.from("signal_lead_claims").select("automation_id, smartlead_campaign_name").eq("identity_key", identityKey).maybeSingle();
  return { ok: false, heldBy: String(held?.automation_id ?? "another automation"), campaignName: (held?.smartlead_campaign_name as string | null) ?? null };
}

export async function attachLeadToClaim(identityKey: string, leadId: string): Promise<void> {
  const db = getAdminClient();
  await db.from("signal_lead_claims").update({ lead_id: leadId }).eq("identity_key", identityKey);
}

/* ── List summaries ─────────────────────────────────────────────────────
   The automations screen answers one question per card: what did this find,
   and is anything waiting on me. Everything else is one level deeper. */
export async function listAutomationSummaries(): Promise<AutomationSummary[]> {
  const db = getAdminClient();
  const automations = await listAutomations();
  if (automations.length === 0) return [];
  const ids = automations.map((a) => a.id);

  const [searches, companies, contacts, openRuns] = await Promise.all([
    db.from("signal_searches").select("automation_id, job_titles").eq("archived", false).in("automation_id", ids),
    db.from("signal_companies").select("automation_id, funnel_state").in("automation_id", ids),
    db
      .from("signal_contacts")
      .select("company_id, email_status, pushed_at, pick_order, signal_companies!inner(automation_id, funnel_state)")
      .not("pick_order", "is", null),
    db.from("signal_funnel_runs").select("automation_id").in("status", ["running", "paused"]).in("automation_id", ids),
  ]);

  const bucket = () => ({ searches: 0, titles: 0, scanned: 0, qualified: 0, filtered: 0, ready: 0, awaiting: 0 });
  const tally = new Map(ids.map((id) => [id, bucket()]));
  for (const row of searches.data ?? []) {
    const entry = tally.get(row.automation_id as string);
    if (!entry) continue;
    entry.searches += 1;
    entry.titles += ((row.job_titles as string[] | null) ?? []).length;
  }
  for (const row of companies.data ?? []) {
    const entry = tally.get(row.automation_id as string);
    if (!entry) continue;
    entry.scanned += 1;
    if (row.funnel_state === "qualified") entry.qualified += 1;
    else if (row.funnel_state === "killed") entry.filtered += 1;
  }
  for (const row of contacts.data ?? []) {
    const company = row.signal_companies as unknown as { automation_id: string; funnel_state: string } | null;
    if (!company || company.funnel_state !== "qualified") continue;
    const entry = tally.get(company.automation_id);
    if (!entry) continue;
    if (row.pushed_at) continue;
    if (row.email_status === "found") entry.ready += 1;
    else entry.awaiting += 1;
  }
  const running = new Set((openRuns.data ?? []).map((row) => row.automation_id as string));

  return automations.map((automation) => {
    const entry = tally.get(automation.id) ?? bucket();
    return {
      automation,
      searchCount: entry.searches,
      titleCount: entry.titles,
      scanned: entry.scanned,
      qualified: entry.qualified,
      leadsReady: entry.ready,
      leadsAwaitingEmail: entry.awaiting,
      filteredOut: entry.filtered,
      running: running.has(automation.id),
    };
  });
}
