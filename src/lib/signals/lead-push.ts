import "server-only";

import { getAdminClient } from "@/lib/supabase/admin";
import { createTable, createWorkbook, getTableById, getWorkspaceTree } from "@/lib/enrichment/workspace";
import { getTableColumns } from "@/lib/enrichment/custom-columns";
import { buildSteps } from "@/lib/enrichment/orchestrator";
import { createRunJob } from "@/lib/enrichment/run-jobs";
import type { LeadListRow, LeadListSummary, SignalContactDto } from "@/lib/signals/types";
import { getCompanyContacts } from "@/lib/signals/contacts";
import { attachLeadToClaim, claimLead, getAutomation, leadIdentityKey, setAutomationTable } from "@/lib/signals/automations";

// One-click push: picked contacts with found emails become rows in
// public.leads (role_level 'signal', source 'signal-hiring') inside a rolling
// "Hiring Signals" prospects table, where the existing enrichment machinery
// (copy variables, validation, Smartlead export) takes over.

const WORKBOOK_NAME = "Signals";
const TABLE_NAME = "Hiring Signals";
export const SIGNAL_ROLE_LEVEL = "signal";
const LEAD_SOURCE = "signal-hiring";

/* ── Release cadence ────────────────────────────────────────────────────
   A posting is a decaying signal, so the second contact at a company goes out
   about a week after the first — not after the first sequence finishes. Two
   rules make that safe:
     1. The gap is measured from when contact 1's first email ACTUALLY SENT,
        not from when we pushed them: Smartlead's schedule, throttle and warmup
        can hold a pushed lead for a day or two, which would quietly compress
        the gap.
     2. Any reply from ANYONE at the company stops everyone else there,
        permanently. Smartlead stops a lead on reply but has no notion of a
        company, so this is ours to enforce — and it matters more at a 7-day
        gap, because contact 1 is still mid-sequence when contact 2 comes up. */

export type ReleaseDecision =
  | { release: true }
  | { release: false; reason: string };

export async function releaseDecisionFor(contact: {
  id: string;
  companyId: string;
  pickOrder: number | null;
}, gapDays: number): Promise<ReleaseDecision> {
  const db = getAdminClient();
  if (contact.pickOrder === null) return { release: false, reason: "Not picked." };
  // The primary always goes immediately — it is the signal's first touch.
  if (contact.pickOrder <= 1) return { release: true };

  const { data: earlier } = await db
    .from("signal_contacts")
    .select("id, lead_id, pushed_at, pick_order")
    .eq("company_id", contact.companyId)
    .not("pick_order", "is", null)
    .lt("pick_order", contact.pickOrder);
  const predecessors = earlier ?? [];
  if (predecessors.length === 0) return { release: true };

  const leadIds = predecessors.map((row) => row.lead_id as string | null).filter((id): id is string => Boolean(id));
  if (leadIds.length === 0) return { release: false, reason: "Waiting on the first contact to be pushed." };

  const { data: leads } = await db
    .from("leads")
    .select("id, company_id, replied, last_email_sent, last_email_date")
    .in("id", leadIds);

  // Anyone at this company already in conversation ends the sequence for the rest.
  const companyIds = [...new Set((leads ?? []).map((row) => row.company_id as string | null).filter(Boolean))] as string[];
  if (companyIds.length > 0) {
    const { data: replies } = await db
      .from("leads")
      .select("id, first_name, last_name")
      .in("company_id", companyIds)
      .eq("replied", true)
      .limit(1);
    if (replies?.length) {
      const who = [replies[0].first_name, replies[0].last_name].filter(Boolean).join(" ") || "someone";
      return { release: false, reason: `${who} at this company already replied — the rest stay out.` };
    }
  }

  const sentAt = (leads ?? [])
    .map((row) => (row.last_email_sent as string | null) ?? (row.last_email_date as string | null))
    .filter((value): value is string => Boolean(value))
    .sort()[0];
  if (!sentAt) return { release: false, reason: "Waiting on the first email to send." };
  const dueAt = new Date(new Date(sentAt).getTime() + gapDays * 86_400_000);
  if (dueAt > new Date()) {
    const days = Math.max(1, Math.ceil((dueAt.getTime() - Date.now()) / 86_400_000));
    return { release: false, reason: `Releases in ${days} day${days === 1 ? "" : "s"}.` };
  }
  return { release: true };
}

/* ── Lead list (cross-company view) ─────────────────────────────────── */

export async function getLeadList(automationId?: string): Promise<LeadListSummary> {
  const db = getAdminClient();
  const { data: contactRows, error } = await db
    .from("signal_contacts")
    .select(
      "id, company_id, full_name, first_name, last_name, title, location, about, picture_url, linkedin_url, linkedin_member_id, tenure_months, started_on, employment_status, current_employer, rank, rank_score, rank_reason, matched_reports_to, status, exclusion_reason, pick_order, pick_by_operator, email, email_status, email_source, email_error, email_checked_at, lead_id, pushed_at",
    )
    .not("pick_order", "is", null)
    .order("pick_order");
  if (error) throw new Error(`Could not load the lead list: ${error.message}`);

  const companyIds = [...new Set((contactRows ?? []).map((row) => row.company_id as string))];
  const { data: companyRows, error: companiesError } = companyIds.length
    ? await db.from("signal_companies").select("id, name, logo_url, score, industries, funnel_state, automation_id").in("id", companyIds)
    : { data: [], error: null };
  if (companiesError) throw new Error(`Could not load lead-list companies: ${companiesError.message}`);
  const companies = new Map((companyRows ?? []).map((row) => [row.id as string, row]));

  const rows: LeadListRow[] = [];
  for (const row of contactRows ?? []) {
    const company = companies.get(row.company_id as string);
    // Only qualified companies belong on the list (an override-killed company
    // may still hold stale picks).
    if (!company || company.funnel_state !== "qualified") continue;
    if (automationId && company.automation_id !== automationId) continue;
    rows.push({
      contact: {
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
      },
      companyId: String(row.company_id),
      companyName: (company.name as string) ?? "",
      companyLogoUrl: (company.logo_url as string | null) ?? null,
      companyScore: (company.score as number | null) ?? null,
      companyIndustries: (company.industries as string | null) ?? null,
    });
  }

  rows.sort((a, b) => (b.companyScore ?? 0) - (a.companyScore ?? 0) || a.companyName.localeCompare(b.companyName) || (a.contact.pickOrder ?? 9) - (b.contact.pickOrder ?? 9));
  return {
    rows,
    ready: rows.filter((row) => row.contact.pushedAt === null && row.contact.emailStatus === "found").length,
    missingEmail: rows.filter((row) => row.contact.pushedAt === null && row.contact.emailStatus !== "found").length,
    pushed: rows.filter((row) => row.contact.pushedAt !== null).length,
  };
}

/* ── Push ───────────────────────────────────────────────────────────── */

// "Jackson, Mississippi, United States" -> city/state/country parts that feed
// leads.raw (the prospects RPC reads Lead City/State/Country from raw).
export function parseLocation(location: string | null): { city: string | null; state: string | null; country: string } {
  const parts = (location ?? "").split(",").map((part) => part.trim()).filter(Boolean);
  const known = ["United States", "United Kingdom", "Canada", "Australia", "South Africa", "Mexico", "Germany", "France", "India"];
  const last = parts[parts.length - 1] ?? "";
  const country = known.find((name) => name.toLowerCase() === last.toLowerCase()) ?? "United States";
  const rest = country.toLowerCase() === last.toLowerCase() ? parts.slice(0, -1) : parts;
  return { city: rest[0] ?? null, state: rest[1] ?? null, country };
}

function cleanDomain(value: string | null): string | null {
  if (!value) return null;
  const domain = value
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .split("/")[0];
  return domain || null;
}

async function ensureSignalsTable(automationId?: string): Promise<{ workbookSlug: string; tableSlug: string; tableId: string }> {
  const tree = await getWorkspaceTree();

  // The automation's recorded table wins: it survives renames outright. The
  // Aug-13 duplicate ("Hiring Signals" appearing next to the renamed "Hiring
  // Signals - Modernization US") happened because resolution started from an
  // exact name match instead of this id.
  if (automationId) {
    const automation = await getAutomation(automationId);
    if (automation?.prospectTableId) {
      for (const book of tree.workbooks) {
        const hit = book.tables.find((item) => item.id === automation.prospectTableId);
        if (hit) return { workbookSlug: book.slug, tableSlug: hit.slug, tableId: hit.id };
      }
    }
  }

  let book = tree.workbooks.find((item) => item.name.toLowerCase() === WORKBOOK_NAME.toLowerCase());
  if (!book) {
    const created = await createWorkbook(WORKBOOK_NAME, "Leads sourced from the Signals tab.");
    book = { ...created, tables: [] };
  }
  // Prefix match, not equality: the operator renames tables ("Hiring Signals"
  // became "Hiring Signals - Modernization US") and a rename must never spawn
  // a parallel table. Oldest wins so the established table keeps receiving.
  const existing = tree.workbooks
    .find((item) => item.id === book.id)
    ?.tables.find((item) => item.name.toLowerCase().startsWith(TABLE_NAME.toLowerCase()));
  if (existing) return { workbookSlug: book.slug, tableSlug: existing.slug, tableId: existing.id };
  const table = await createTable(book.id, TABLE_NAME, "Picked contacts from qualified hiring-signal companies.", {
    roleLevels: [SIGNAL_ROLE_LEVEL],
    minContacts: 1,
    requireSendWave: false,
  });
  // v1 is the legacy hardcoded grid (final_title / operations_task / ops
  // candidate); it ignores per-table columns entirely, so this table's
  // signal_* columns would never render. The signals table is v2 by
  // definition — it exists to carry its own column set.
  await getAdminClient().from("enrichment_tables").update({ layout_version: "v2" }).eq("id", table.id);
  return { workbookSlug: book.slug, tableSlug: table.slug, tableId: table.id };
}

/* The whole point of the hiring play is that we know what they posted, but the
   funnel's evidence lives in signal_* tables the enrichment side cannot see.
   Copy it onto the public company as `hiring_signal`, which every AI column
   already reads through the company_summary source key. Merged, never
   overwritten: a company sourced by another campaign keeps its scraped
   research and gains this alongside it. */
const JD_EXCERPT_CAP = 1500;

export async function attachHiringSignalSummary(
  companyId: string,
  signalCompanyId: string,
  researchBrief: string | null,
): Promise<void> {
  const db = getAdminClient();
  const { data: jobs } = await db
    .from("signal_jobs")
    .select("title, description")
    .eq("company_id", signalCompanyId)
    .order("first_seen_at", { ascending: false })
    .limit(3);
  const titles = [...new Set((jobs ?? []).map((row) => (row.title as string | null) ?? "").filter(Boolean))];
  const description = ((jobs ?? [])[0]?.description as string | null) ?? "";
  if (titles.length === 0 && !researchBrief) return;

  const block = [
    titles.length ? `Roles they are currently hiring for: ${titles.join("; ")}` : "",
    description ? `Job description (excerpt):\n${description.slice(0, JD_EXCERPT_CAP)}` : "",
    researchBrief ? `Research brief:\n${researchBrief}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");

  const { data: existing } = await db.from("companies").select("company_summary").eq("id", companyId).maybeSingle();
  const current =
    existing?.company_summary && typeof existing.company_summary === "object" && !Array.isArray(existing.company_summary)
      ? (existing.company_summary as Record<string, unknown>)
      : {};
  await db.from("companies").update({ company_summary: { ...current, hiring_signal: block } }).eq("id", companyId);
}

async function ensureCompany(name: string, domain: string | null): Promise<string> {
  const db = getAdminClient();
  if (domain) {
    const { data } = await db.from("companies").select("id").eq("domain", domain).limit(1);
    if (data?.length) return data[0].id as string;
  }
  const { data: byName } = await db.from("companies").select("id").ilike("name", name.replace(/[\\%_]/g, "\\$&")).limit(1);
  if (byName?.length) return byName[0].id as string;
  const { data: created, error } = await db.from("companies").insert({ name, domain }).select("id").single();
  if (error || !created) throw new Error(`Company insert failed: ${error?.message}`);
  return created.id as string;
}

export type PushResult = {
  pushed: number;
  linked: number; // matched an existing lead instead of inserting
  skipped: number; // no email yet
  held: number; // waiting on the release gap, a reply, or another campaign
  workbookSlug: string;
  tableSlug: string;
};

// Push every ready lead-list row into public.leads. Idempotent: contacts with
// lead_id are never re-pushed; existing leads (same email or LinkedIn URL)
// are linked, not duplicated.
export async function pushLeadList(automationId?: string): Promise<PushResult> {
  const db = getAdminClient();
  const list = await getLeadList(automationId);
  const target = await ensureSignalsTable(automationId);

  // Record where this automation's leads land, so the UI can draw the line
  // from automation to enrichment table instead of leaving it folklore.
  if (automationId) {
    const automation = await getAutomation(automationId);
    if (automation && automation.prospectTableId !== target.tableId) {
      await setAutomationTable(automationId, target.tableId);
    }
  }

  let pushed = 0;
  let linked = 0;
  let skipped = 0;
  let held = 0;

  for (const row of list.rows) {
    const contact = row.contact;
    if (contact.pushedAt !== null) continue;
    if (contact.emailStatus !== "found" || !contact.email) {
      skipped += 1;
      continue;
    }

    const { data: companyRow } = await db
      .from("signal_companies")
      .select("id, name, domain, website_url, industries, headcount, score, research_brief, automation_id")
      .eq("id", contact.companyId)
      .single();
    if (!companyRow) continue;
    const automationId = companyRow.automation_id as string;
    const automation = await getAutomation(automationId);

    // Cadence gate: a runner-up waits out the release gap and never goes at all
    // if anyone at the company has replied.
    const decision = await releaseDecisionFor(
      { id: contact.id, companyId: contact.companyId, pickOrder: contact.pickOrder },
      automation?.releaseGapDays ?? 7,
    );
    if (!decision.release) {
      await db.from("signal_contacts").update({ release_blocked_reason: decision.reason }).eq("id", contact.id);
      held += 1;
      continue;
    }

    // One person, one campaign — claimed on the human's identity, not on this
    // automation's copy of their contact row.
    const identity = leadIdentityKey({ email: contact.email, linkedinUrl: contact.linkedinUrl });
    if (identity) {
      const claim = await claimLead(identity, {
        automationId,
        contactId: contact.id,
        campaignId: automation?.campaignId ?? null,
        campaignName: automation?.campaignName ?? null,
      });
      if (!claim.ok) {
        await db
          .from("signal_contacts")
          .update({ release_blocked_reason: `Already in ${claim.campaignName ?? "another campaign"}.` })
          .eq("id", contact.id);
        held += 1;
        continue;
      }
    }
    const domain = cleanDomain((companyRow.domain as string | null) ?? (companyRow.website_url as string | null));

    // Existing lead (CRM overlap): link rather than duplicate. Two exact
    // lookups — .or() string syntax is fragile with emails as literals.
    const emailNorm = contact.email.trim().toLowerCase();
    let existingLead = (await db.from("leads").select("id, company_id").ilike("email", emailNorm.replace(/[\\%_]/g, "\\$&")).limit(1)).data;
    if (!existingLead?.length && contact.linkedinUrl) {
      existingLead = (await db.from("leads").select("id, company_id").eq("linkedin_url", contact.linkedinUrl).limit(1)).data;
    }
    if (existingLead?.length) {
      // A linked lead still gets enriched against this campaign's copy, so it
      // needs the signal too.
      const linkedCompanyId = existingLead[0].company_id as string | null;
      if (linkedCompanyId) {
        await attachHiringSignalSummary(linkedCompanyId, contact.companyId, companyRow.research_brief as string | null);
      }
      await db
        .from("signal_contacts")
        .update({ lead_id: existingLead[0].id as string, pushed_at: new Date().toISOString(), updated_at: new Date().toISOString() })
        .eq("id", contact.id);
      linked += 1;
      continue;
    }

    const companyId = await ensureCompany((companyRow.name as string) ?? row.companyName, domain);
    await attachHiringSignalSummary(companyId, contact.companyId, companyRow.research_brief as string | null);
    const location = parseLocation(contact.location);
    const { data: lead, error: leadError } = await db
      .from("leads")
      .insert({
        company_id: companyId,
        role_level: SIGNAL_ROLE_LEVEL,
        first_name: contact.firstName,
        last_name: contact.lastName,
        title: contact.title,
        email: contact.email,
        linkedin_url: contact.linkedinUrl,
        company: (companyRow.name as string) ?? row.companyName,
        domain,
        website: (companyRow.website_url as string | null) ?? null,
        industry: (companyRow.industries as string | null) ?? null,
        employee_count: (companyRow.headcount as number | null) ?? null,
        source: LEAD_SOURCE,
        raw: {
          "Lead City": location.city ?? "",
          "Lead State": location.state ?? "",
          "Lead Country": location.country,
          "Signal Score": companyRow.score ?? null,
          "Signal Company Id": contact.companyId,
          "Signal Pick": contact.pickOrder === 1 ? "primary" : "backup",
          "Email Source": contact.emailSource ?? "",
        },
      })
      .select("id")
      .single();
    if (leadError || !lead) throw new Error(`Lead insert failed for ${contact.fullName}: ${leadError?.message}`);

    await db
      .from("signal_contacts")
      .update({ lead_id: lead.id as string, pushed_at: new Date().toISOString(), released_at: new Date().toISOString(), release_blocked_reason: null, updated_at: new Date().toISOString() })
      .eq("id", contact.id);
    if (identity) await attachLeadToClaim(identity, lead.id as string);
    pushed += 1;
  }

  return { pushed, linked, skipped, held, workbookSlug: target.workbookSlug, tableSlug: target.tableSlug };
}

/* ── Automated enrichment + export ────────────────────────────────────── */

// Kick the full chain (enrich → validate → email QA → Smartlead export) over
// every not-yet-run lead in the signals table. This is what turns autopush
// into a hands-off pipeline: pushed leads flow to the campaign without the
// operator touching "Run" or "Push to campaign". Piggybacks entirely on the
// durable run-job machinery — includeExport runs the smartlead_export step for
// each lead the moment it finishes validation with a deliverable email and a
// "Ready" email review, and createRunJob refuses to stack a second run while
// one is active on the table.
export async function startSignalsEnrichmentRun(
  automationId?: string,
): Promise<{ ok: true; jobId: string; total: number } | { ok: false; message: string }> {
  const target = await ensureSignalsTable(automationId);
  const table = await getTableById(target.tableId);
  if (!table) return { ok: false, message: "Signals table not found." };
  const steps = buildSteps(await getTableColumns(table.id), table.layoutVersion);
  const first = steps[0];
  if (!first) return { ok: false, message: "The signals table has no runnable steps." };
  return createRunJob({
    tableId: table.id,
    kind: "waterfall",
    startColumnKey: first.key,
    mode: "unrun",
    includeExport: true,
    createdBy: "signals-autopush",
  });
}

// Re-export for the drawer: contacts of one company (already ranked).
export { getCompanyContacts };
