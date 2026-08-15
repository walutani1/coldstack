"use server";

import { z } from "zod";
import { requireActiveProfileResult } from "@/lib/auth";
import { getActiveFunnelConfig, saveFunnelConfig } from "@/lib/signals/config";
import { getOpenFunnelRun, pauseOrResumeFunnelRun, startFunnelRun, tickFunnelRun } from "@/lib/signals/funnel";
import {
  getCompaniesPage,
  getCompanyDetail,
  getFunnelCounts,
  getStageKills,
  setOverride,
  setReviewState,
} from "@/lib/signals/funnel-store";
import { listCampaigns } from "@/lib/smartlead";
import {
  archiveAutomation,
  automationInputSchema,
  createAutomation,
  listAutomationSummaries,
  setAutomationCampaign,
  updateAutomation,
} from "@/lib/signals/automations";
import {
  advanceContactSourcing,
  findContactEmail,
  getCompanyContacts,
  getContact,
  queueContactSourcing,
  setContactPick,
} from "@/lib/signals/contacts";
import { getLeadList, pushLeadList, startSignalsEnrichmentRun, type PushResult } from "@/lib/signals/lead-push";
import { runCompanyResearch } from "@/lib/signals/research";
import { archiveSignalSearch, createSignalSearch, listSignalSearches, updateSignalSearch } from "@/lib/signals/store";
import {
  FUNNEL_STAGES,
  type CompaniesPage,
  type CompanyDetail,
  type FunnelConfigVersion,
  type FunnelCounts,
  type FunnelRunDto,
  type AutomationDto,
  type AutomationSummary,
  type FunnelStage,
  type LeadListSummary,
  type SignalCompanyDto,
  type SignalContactDto,
  type SignalSearchDto,
} from "@/lib/signals/types";
import {
  SEARCH_ARRANGEMENT_OPTIONS,
  SEARCH_EMPLOYMENT_OPTIONS,
  SEARCH_EXPERIENCE_OPTIONS,
  SEARCH_POSTED_OPTIONS,
} from "@/lib/signals/options";

type Fail = { ok: false; message: string };

async function guard(): Promise<Fail | null> {
  const auth = await requireActiveProfileResult();
  return auth.ok ? null : { ok: false, message: "Your session has expired. Refresh and sign in again." };
}

function failMessage(error: unknown, fallback: string): string {
  if (error instanceof z.ZodError) return error.issues[0]?.message ?? fallback;
  return error instanceof Error ? error.message : fallback;
}

const uuidSchema = z.string().uuid();

/* ── Funnel runs ────────────────────────────────────────────────────── */

export async function runFunnelAction(automationId: string, options?: { sampleLimit?: number }): Promise<{ ok: true; run: FunnelRunDto } | Fail> {
  const denied = await guard();
  if (denied) return denied;
  try {
    const sampleLimit = options?.sampleLimit ? z.number().int().min(1).max(50).parse(options.sampleLimit) : undefined;
    return { ok: true, run: await startFunnelRun({ trigger: "manual", automationId: uuidSchema.parse(automationId), sampleLimit }) };
  } catch (error) {
    return { ok: false, message: failMessage(error, "Could not start the funnel run.") };
  }
}

export async function reevaluateAction(automationId: string, companyId: string | null): Promise<{ ok: true; run: FunnelRunDto } | Fail> {
  const denied = await guard();
  if (denied) return denied;
  try {
    if (companyId) uuidSchema.parse(companyId);
    return { ok: true, run: await startFunnelRun({ trigger: "reevaluate", automationId: uuidSchema.parse(automationId), companyId: companyId ?? undefined }) };
  } catch (error) {
    return { ok: false, message: failMessage(error, "Could not start the re-evaluation.") };
  }
}

// Client polls this while a run is open; each call advances the run one step
// (scrape polling or one company through the pipeline).
export async function tickFunnelAction(runId: string): Promise<{ ok: true; run: FunnelRunDto } | Fail> {
  const denied = await guard();
  if (denied) return denied;
  try {
    return { ok: true, run: await tickFunnelRun(uuidSchema.parse(runId)) };
  } catch (error) {
    return { ok: false, message: failMessage(error, "Funnel tick failed.") };
  }
}

export async function controlFunnelAction(runId: string, action: "pause" | "resume" | "stop"): Promise<{ ok: true; run: FunnelRunDto } | Fail> {
  const denied = await guard();
  if (denied) return denied;
  try {
    return { ok: true, run: await pauseOrResumeFunnelRun(uuidSchema.parse(runId), z.enum(["pause", "resume", "stop"]).parse(action)) };
  } catch (error) {
    return { ok: false, message: failMessage(error, "Could not update the run.") };
  }
}

export async function getOpenRunAction(automationId?: string): Promise<{ ok: true; run: FunnelRunDto | null } | Fail> {
  const denied = await guard();
  if (denied) return denied;
  try {
    return { ok: true, run: await getOpenFunnelRun(automationId) };
  } catch (error) {
    return { ok: false, message: failMessage(error, "Could not load the run.") };
  }
}

/* ── Results table ──────────────────────────────────────────────────── */

const companiesFilterSchema = z.object({
  automationId: z.string().uuid().nullable(),
  view: z.enum(["qualified", "killed", "errored", "flagged", "all"]),
  reviewState: z.enum(["new", "approved", "archived", "all"]),
  killedStage: z.enum(FUNNEL_STAGES).nullable(),
  q: z.string().trim().max(120).nullable(),
  limit: z.number().int().min(1).max(100),
  offset: z.number().int().min(0).max(100_000),
});

export async function getCompaniesAction(
  filter: unknown,
): Promise<{ ok: true; page: CompaniesPage; counts: FunnelCounts } | Fail> {
  const denied = await guard();
  if (denied) return denied;
  try {
    const parsed = companiesFilterSchema.parse(filter);
    const [page, counts] = await Promise.all([getCompaniesPage(parsed), getFunnelCounts(parsed.automationId ?? undefined)]);
    return { ok: true, page, counts };
  } catch (error) {
    return { ok: false, message: failMessage(error, "Could not load companies.") };
  }
}

export async function getCompanyDetailAction(companyId: string): Promise<{ ok: true; company: CompanyDetail } | Fail> {
  const denied = await guard();
  if (denied) return denied;
  try {
    const company = await getCompanyDetail(uuidSchema.parse(companyId));
    if (!company) return { ok: false, message: "Company not found." };
    return { ok: true, company };
  } catch (error) {
    return { ok: false, message: failMessage(error, "Could not load the company.") };
  }
}

export async function getStageKillsAction(stage: string): Promise<{ ok: true; kills: Awaited<ReturnType<typeof getStageKills>> } | Fail> {
  const denied = await guard();
  if (denied) return denied;
  try {
    const parsed = z.enum(FUNNEL_STAGES).parse(stage) as FunnelStage;
    return { ok: true, kills: await getStageKills(parsed) };
  } catch (error) {
    return { ok: false, message: failMessage(error, "Could not load stage audit.") };
  }
}

/* ── Review + overrides ─────────────────────────────────────────────── */

export async function setReviewAction(
  companyId: string,
  state: "new" | "approved" | "archived",
  reason: string | null,
): Promise<{ ok: true } | Fail> {
  const denied = await guard();
  if (denied) return denied;
  try {
    await setReviewState(uuidSchema.parse(companyId), z.enum(["new", "approved", "archived"]).parse(state), reason ? reason.slice(0, 300) : null);
    return { ok: true };
  } catch (error) {
    return { ok: false, message: failMessage(error, "Could not update the company.") };
  }
}

export async function setOverrideAction(
  companyId: string,
  override: "qualified" | "killed" | null,
  note: string | null,
): Promise<{ ok: true } | Fail> {
  const denied = await guard();
  if (denied) return denied;
  try {
    await setOverride(
      uuidSchema.parse(companyId),
      override === null ? null : z.enum(["qualified", "killed"]).parse(override),
      note ? note.slice(0, 300) : null,
    );
    return { ok: true };
  } catch (error) {
    return { ok: false, message: failMessage(error, "Could not set the override.") };
  }
}

export async function researchCompanyAction(companyId: string): Promise<{ ok: true; company: SignalCompanyDto } | Fail> {
  const denied = await guard();
  if (denied) return denied;
  try {
    const { company } = await runCompanyResearch(uuidSchema.parse(companyId));
    return { ok: true, company };
  } catch (error) {
    return { ok: false, message: failMessage(error, "Research failed.") };
  }
}

/* ── Config ─────────────────────────────────────────────────────────── */

export async function getConfigAction(automationId?: string): Promise<{ ok: true; config: FunnelConfigVersion; searches: SignalSearchDto[] } | Fail> {
  const denied = await guard();
  if (denied) return denied;
  try {
    const [config, searches] = await Promise.all([getActiveFunnelConfig(), listSignalSearches(automationId)]);
    return { ok: true, config, searches };
  } catch (error) {
    return { ok: false, message: failMessage(error, "Could not load the funnel config.") };
  }
}

export async function saveConfigAction(input: unknown, note: string | null): Promise<{ ok: true; config: FunnelConfigVersion } | Fail> {
  const denied = await guard();
  if (denied) return denied;
  try {
    const auth = await requireActiveProfileResult();
    const email = auth.ok ? auth.profile.email : null;
    return { ok: true, config: await saveFunnelConfig(input, note ? note.slice(0, 200) : null, email) };
  } catch (error) {
    return { ok: false, message: failMessage(error, "Could not save the config.") };
  }
}

/* ── Searches (managed inside Signals config) ───────────────────────── */

const enumOrNull = (values: readonly string[]) =>
  z
    .string()
    .trim()
    .max(40)
    .nullable()
    .transform((value) => (value && values.includes(value) ? value : null));

const searchInputSchema = z.object({
  name: z.string().trim().min(1, "Give the search a name.").max(80),
  source: z.enum(["linkedin", "indeed"]).catch("linkedin"),
  jobTitles: z.array(z.string().trim().min(1).max(120)).min(1, "Add at least one job title.").max(20),
  location: z.string().trim().min(1).max(120).catch("United States"),
  cities: z.array(z.string().trim().min(1).max(120)).max(30),
  experience: enumOrNull(SEARCH_EXPERIENCE_OPTIONS),
  employmentType: enumOrNull(SEARCH_EMPLOYMENT_OPTIONS),
  workArrangement: enumOrNull(SEARCH_ARRANGEMENT_OPTIONS),
  postedWithin: enumOrNull(SEARCH_POSTED_OPTIONS),
  maxJobs: z.number().int().min(1).max(1000),
});

export async function saveSearchAction(
  automationId: string,
  id: string | null,
  input: unknown,
): Promise<{ ok: true; searches: SignalSearchDto[] } | Fail> {
  const denied = await guard();
  if (denied) return denied;
  try {
    const parsed = searchInputSchema.parse(input);
    if (id) {
      uuidSchema.parse(id);
      await updateSignalSearch(id, parsed);
    } else {
      await createSignalSearch(parsed, uuidSchema.parse(automationId));
    }
    return { ok: true, searches: await listSignalSearches(uuidSchema.parse(automationId)) };
  } catch (error) {
    return { ok: false, message: failMessage(error, "Could not save the search.") };
  }
}

export async function archiveSearchAction(automationId: string, id: string): Promise<{ ok: true; searches: SignalSearchDto[] } | Fail> {
  const denied = await guard();
  if (denied) return denied;
  try {
    await archiveSignalSearch(uuidSchema.parse(id));
    return { ok: true, searches: await listSignalSearches(uuidSchema.parse(automationId)) };
  } catch (error) {
    return { ok: false, message: failMessage(error, "Could not archive the search.") };
  }
}

/* ── Automations ────────────────────────────────────────────────────── */

export async function listAutomationsAction(): Promise<{ ok: true; automations: AutomationSummary[] } | Fail> {
  const denied = await guard();
  if (denied) return denied;
  try {
    return { ok: true, automations: await listAutomationSummaries() };
  } catch (error) {
    return { ok: false, message: failMessage(error, "Could not load automations.") };
  }
}

export async function createAutomationAction(input: unknown): Promise<{ ok: true; automation: AutomationDto } | Fail> {
  const denied = await guard();
  if (denied) return denied;
  try {
    return { ok: true, automation: await createAutomation(input) };
  } catch (error) {
    return { ok: false, message: failMessage(error, "Could not create the automation.") };
  }
}

export async function updateAutomationAction(id: string, patch: unknown): Promise<{ ok: true; automation: AutomationDto } | Fail> {
  const denied = await guard();
  if (denied) return denied;
  try {
    const parsed = automationInputSchema.partial().extend({ status: z.enum(["draft", "active", "paused"]).optional() }).parse(patch);
    return { ok: true, automation: await updateAutomation(uuidSchema.parse(id), parsed) };
  } catch (error) {
    return { ok: false, message: failMessage(error, "Could not update the automation.") };
  }
}

export async function archiveAutomationAction(id: string): Promise<{ ok: true } | Fail> {
  const denied = await guard();
  if (denied) return denied;
  try {
    await archiveAutomation(uuidSchema.parse(id));
    return { ok: true };
  } catch (error) {
    return { ok: false, message: failMessage(error, "Could not archive the automation.") };
  }
}

// Campaigns the automation can feed. Smartlead is the source of truth.
export async function listCampaignsAction(): Promise<{ ok: true; campaigns: { id: string; name: string; status: string | null }[] } | Fail> {
  const denied = await guard();
  if (denied) return denied;
  try {
    const campaigns = await listCampaigns();
    return { ok: true, campaigns: campaigns.map((c) => ({ id: c.id, name: c.name, status: c.status })) };
  } catch (error) {
    return { ok: false, message: failMessage(error, "Could not load campaigns from Smartlead.") };
  }
}

export async function bindCampaignAction(
  automationId: string,
  tag: { id: string; name: string } | null,
): Promise<{ ok: true; automation: AutomationDto } | Fail> {
  const denied = await guard();
  if (denied) return denied;
  try {
    const parsed = tag ? z.object({ id: z.string().regex(/^\d+$/), name: z.string().trim().min(1).max(200) }).parse(tag) : null;
    return { ok: true, automation: await setAutomationCampaign(uuidSchema.parse(automationId), parsed) };
  } catch (error) {
    return { ok: false, message: failMessage(error, "Could not bind the campaign.") };
  }
}

/* ── Contacts + lead list ───────────────────────────────────────────── */

// Drawer poll while a roster is pending/sourcing: advances the state machine
// (start pending runs, ingest finished ones) and returns fresh contacts.
export async function pollContactsAction(companyId: string): Promise<{ ok: true; contacts: SignalContactDto[]; contactsState: string } | Fail> {
  const denied = await guard();
  if (denied) return denied;
  try {
    const id = uuidSchema.parse(companyId);
    await advanceContactSourcing();
    const [contacts, detail] = await Promise.all([getCompanyContacts(id), getCompanyDetail(id)]);
    return { ok: true, contacts, contactsState: detail?.contactsState ?? "none" };
  } catch (error) {
    return { ok: false, message: failMessage(error, "Could not check contact sourcing.") };
  }
}

export async function resourceContactsAction(companyId: string): Promise<{ ok: true } | Fail> {
  const denied = await guard();
  if (denied) return denied;
  try {
    await queueContactSourcing(uuidSchema.parse(companyId));
    return { ok: true };
  } catch (error) {
    return { ok: false, message: failMessage(error, "Could not queue contact sourcing.") };
  }
}

export async function setContactPickAction(contactId: string, pickOrder: 1 | 2 | null): Promise<{ ok: true; contacts: SignalContactDto[] } | Fail> {
  const denied = await guard();
  if (denied) return denied;
  try {
    const id = uuidSchema.parse(contactId);
    const parsedPick = pickOrder === null ? null : (z.union([z.literal(1), z.literal(2)]).parse(pickOrder) as 1 | 2);
    await setContactPick(id, parsedPick);
    const contact = await getContact(id);
    if (!contact) return { ok: false, message: "Contact not found." };
    return { ok: true, contacts: await getCompanyContacts(contact.companyId) };
  } catch (error) {
    return { ok: false, message: failMessage(error, "Could not update the pick.") };
  }
}

export async function findContactEmailAction(contactId: string): Promise<{ ok: true; contact: SignalContactDto } | Fail> {
  const denied = await guard();
  if (denied) return denied;
  try {
    const contact = await findContactEmail(uuidSchema.parse(contactId));
    if (!contact) return { ok: false, message: "Contact not found." };
    return { ok: true, contact };
  } catch (error) {
    return { ok: false, message: failMessage(error, "Email lookup failed.") };
  }
}

export async function getLeadListAction(automationId?: string): Promise<{ ok: true; list: LeadListSummary } | Fail> {
  const denied = await guard();
  if (denied) return denied;
  try {
    return { ok: true, list: await getLeadList(automationId ? uuidSchema.parse(automationId) : undefined) };
  } catch (error) {
    return { ok: false, message: failMessage(error, "Could not load the lead list.") };
  }
}

export async function pushLeadListAction(automationId?: string): Promise<{ ok: true; result: PushResult; list: LeadListSummary } | Fail> {
  const denied = await guard();
  if (denied) return denied;
  try {
    const scoped = automationId ? uuidSchema.parse(automationId) : undefined;
    const result = await pushLeadList(scoped);
    // The manual button gets the same hands-off tail as autopush: newly landed
    // leads immediately enter the enrich → validate → export chain. Best
    // effort — "a run is already in progress" is normal and not a push failure.
    if (result.pushed + result.linked > 0) void startSignalsEnrichmentRun(scoped);
    return { ok: true, result, list: await getLeadList(scoped) };
  } catch (error) {
    return { ok: false, message: failMessage(error, "Push failed.") };
  }
}
