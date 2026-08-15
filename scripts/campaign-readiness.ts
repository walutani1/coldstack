import { loadEnvConfig } from "@next/env";

// How many leads still need validation / enrichment before they can be
// exported to a campaign. Counts come from the same enrichment_run_candidates
// RPC the run buttons use, so they match what a run would actually process.
//
// Run (mac):     NODE_OPTIONS=--conditions=react-server npx tsx scripts/campaign-readiness.ts [campaign-name-match]
// Run (windows): $env:NODE_OPTIONS="--conditions=react-server"; npx tsx scripts/campaign-readiness.ts director
//
// The argument is a case-insensitive substring of the Smartlead campaign name
// a folder/workbook/table is tagged with. Default: "director".

loadEnvConfig(process.cwd());

const COPY_COLUMNS = ["final_first_name", "final_title", "final_company_name", "operations_task", "ops_candidate"] as const;
/* Not a knob. enrichment_run_candidates clamps its own output with
   `least(coalesce(p_limit,5000),1),5000)` and takes no offset, so 5000 is the
   most any caller can see and a bigger p_limit changes nothing. A queue that
   reports 5000 is therefore "5000 or more", never a total - budget off the
   enrichment queue, which sits below the ceiling, and treat validation as a
   floor. Raising this needs a paged count in SQL, not a bigger number here. */
const LIMIT = 5000;
const PAGE = 1000; // PostgREST truncates any response at 1000 rows; page past it.

function count(n: number): string {
  return n >= LIMIT ? `${n}+ (RPC ceiling — true total is higher)` : String(n);
}

type Canonical = { roleLevels?: string[]; emailStatuses?: string[]; countries?: string[]; hasEmail?: boolean; qualifiedOnly?: boolean; minContacts?: number; excludeCompanyRole?: string; requireSendWave?: boolean };

// getRunCandidates caps at one PostgREST response (1000 rows), which silently
// under-counts big queues. Same RPC and filters, but paged with .range().
async function candidateIds(db: Awaited<ReturnType<typeof import("@/lib/supabase/admin")["getAdminClient"]>>, action: string, tableId: string, canonical: Canonical): Promise<Set<string>> {
  const params = {
    p_action: action,
    p_mode: "unrun",
    p_limit: LIMIT,
    p_prompt_updated_at: null,
    p_role_levels: canonical.roleLevels ?? [],
    p_email_statuses: canonical.emailStatuses ?? [],
    p_countries: canonical.countries ?? [],
    p_has_email: canonical.hasEmail ?? null,
    p_qualified_only: canonical.qualifiedOnly ?? false,
    p_table_id: tableId,
    p_min_contacts: canonical.minContacts ?? null,
    p_exclude_company_role: canonical.excludeCompanyRole ?? null,
    p_require_send_wave: canonical.requireSendWave ?? null,
  };
  const ids = new Set<string>();
  for (let from = 0; from < LIMIT; from += PAGE) {
    const { data, error } = await db.rpc("enrichment_run_candidates", params).range(from, from + PAGE - 1);
    if (error) throw new Error(`Run candidates (${action}): ${error.message}`);
    for (const row of data ?? []) ids.add(String(row.id));
    if ((data ?? []).length < PAGE) break;
  }
  return ids;
}

async function main() {
  if (!process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error("Missing NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY — run this where .env.local lives.");
  }
  const match = (process.argv[2] ?? "director").toLowerCase();
  const [{ getAdminClient }, { getWorkspaceTree, resolveEffectiveCampaign }] = await Promise.all([
    import("@/lib/supabase/admin"),
    import("@/lib/enrichment/workspace"),
  ]);

  const tree = await getWorkspaceTree();
  const folders = new Map(tree.folders.map((f) => [f.id, f]));
  const targets = tree.workbooks.flatMap((book) =>
    book.tables
      .map((table) => ({ book, table, campaign: resolveEffectiveCampaign(table, book, book.folderId ? folders.get(book.folderId) ?? null : null) }))
      .filter((entry) => entry.campaign && entry.campaign.name.toLowerCase().includes(match)),
  );
  if (!targets.length) {
    console.log(`No lists are tagged to a campaign matching "${match}". Tag the list (or its workbook/folder) to the campaign first.`);
    return;
  }

  const totals = { validate: 0, enrich: 0, ready: 0, exported: 0 };
  for (const { book, table, campaign } of targets) {
    const db = getAdminClient();
    const [validate, exportReady, ...columns] = await Promise.all([
      candidateIds(db, "validate_email", table.id, table.canonical),
      candidateIds(db, "smartlead_export", table.id, table.canonical),
      ...COPY_COLUMNS.map((action) => candidateIds(db, action, table.id, table.canonical)),
    ]);
    // A lead missing several copy columns counts once: it is one lead that
    // still has to go through the enrichment run.
    const needsEnrichment = new Set(columns.flatMap((ids) => [...ids]));
    const { count: exported, error } = await getAdminClient()
      .from("enrichment_table_exports")
      .select("id", { count: "exact", head: true })
      .eq("table_id", table.id)
      .eq("campaign_id", campaign!.id)
      .eq("status", "exported");
    if (error) throw new Error(`Export count failed: ${error.message}`);

    console.log(`\n${book.name} / ${table.name}  ->  ${campaign!.name} (tagged on ${campaign!.source})`);
    console.log(`  needs validation (has email, never validated): ${count(validate.size)}`);
    console.log(`  needs enrichment (deliverable, copy columns missing): ${count(needsEnrichment.size)}`);
    console.log(`  ready to export now: ${count(exportReady.size)}`);
    console.log(`  already exported to this campaign: ${exported ?? 0}`);
    totals.validate += validate.size;
    totals.enrich += needsEnrichment.size;
    totals.ready += exportReady.size;
    totals.exported += exported ?? 0;
  }

  console.log(`\nTOTAL across ${targets.length} list${targets.length === 1 ? "" : "s"}`);
  console.log(`  validation queue:  ${count(totals.validate)}`);
  console.log(`  enrichment queue:  ${count(totals.enrich)}`);
  console.log(`  ready to export:   ${count(totals.ready)}`);
  console.log(`  already exported:  ${totals.exported}`);
  console.log(`\nPipeline backlog before export: ${totals.validate + totals.enrich} (validated leads flow into the enrichment queue once deliverable).`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
