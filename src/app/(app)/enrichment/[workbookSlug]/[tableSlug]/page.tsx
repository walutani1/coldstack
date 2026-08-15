import { notFound } from "next/navigation";
import { requireActiveProfile } from "@/lib/auth";
import { getTableColumns } from "@/lib/enrichment/custom-columns";
import { getEnrichmentRunnerConfig } from "@/lib/enrichment/llm-runner";
import { getFilterOptions, getLeadsPage, getSegmentStats } from "@/lib/enrichment/queries";
import { resolveTable } from "@/lib/enrichment/workspace";
import { listCampaigns } from "@/lib/smartlead";
import { EnrichmentTable } from "../../enrichment-table";
import type { RunnerToggleConfig } from "../../runner-toggle";

export const dynamic = "force-dynamic";
// Bulk cell runs fan out provider calls (LLM, LeadMagic, ZeroBounce,
// Smartlead) from long-lived client worker pools against these actions;
// give the route far more than the platform default.
export const maxDuration = 300;

export default async function EnrichmentTablePage({
  params,
}: {
  params: Promise<{ workbookSlug: string; tableSlug: string }>;
}) {
  await requireActiveProfile();

  const { workbookSlug, tableSlug } = await params;
  const resolved = await resolveTable(workbookSlug, tableSlug);
  if (!resolved) notFound();
  const { workbook, table, siblings, effectiveCampaign } = resolved;

  // Smartlead may be unconfigured or unreachable; the campaign tag picker
  // then explains the degraded state instead of the page throwing.
  const campaignsPromise = listCampaigns().then(
    (campaigns) => ({ campaigns, smartleadError: false }),
    () => ({ campaigns: [] as { id: string; name: string; status: string | null }[], smartleadError: true }),
  );

  // A failed runner-config load hides the header's API/CLI toggle instead of
  // rendering it broken.
  const runnerConfigPromise = getEnrichmentRunnerConfig()
    .then((config): RunnerToggleConfig => ({
      provider: config.provider,
    }))
    .catch(() => null);

  const [initialPage, segmentStats, filterOptions, smartlead, runnerConfig, columns] = await Promise.all([
    getLeadsPage({ limit: 500, tableId: table.id, canonical: table.canonical }),
    // Scoped to THIS list, not the workspace: three lists share one lead pool,
    // so an unscoped call showed all three the same totals and none of them
    // matched the rows on screen.
    getSegmentStats(table.canonical),
    getFilterOptions(),
    campaignsPromise,
    runnerConfigPromise,
    getTableColumns(table.id),
  ]);

  return (
    <EnrichmentTable
      // Keyed per table: sheet-tab navigation re-renders this page without
      // remounting the client component, and every piece of grid state
      // (rows, filters, cell results, persistence effects) is per-table.
      key={table.id}
      tableId={table.id}
      tableSlug={table.slug}
      tableName={table.name}
      workbook={{ id: workbook.id, slug: workbook.slug, name: workbook.name }}
      siblings={siblings.map((sibling) => ({
        id: sibling.id,
        slug: sibling.slug,
        name: sibling.name,
        description: sibling.description,
      }))}
      campaignTag={effectiveCampaign}
      initialRows={initialPage.rows}
      initialTotal={initialPage.totalCount}
      initialStats={segmentStats}
      initialFilterOptions={filterOptions}
      campaigns={smartlead.campaigns}
      smartleadError={smartlead.smartleadError}
      runnerConfig={runnerConfig}
      isVercel={Boolean(process.env.VERCEL)}
      layoutVersion={table.layoutVersion === "v2" ? "v2" : "v1"}
      columns={columns}
    />
  );
}
