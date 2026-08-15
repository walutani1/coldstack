import { Table2 } from "lucide-react";
import { requireActiveProfile } from "@/lib/auth";
import { getSegmentStats } from "@/lib/enrichment/queries";
import { getWorkspaceTree, type WorkspaceTree } from "@/lib/enrichment/workspace";
import { listCampaigns } from "@/lib/smartlead";
import { EnrichmentHomeClient, type TableStats } from "./enrichment-home-client";

export const dynamic = "force-dynamic";

/* One segment-stats RPC per table; a failed call just drops that table's
   numbers (its card renders without them) instead of failing the page. */
async function loadTableStats(tree: WorkspaceTree): Promise<Record<string, TableStats>> {
  const pairs = await Promise.all(
    tree.workbooks.flatMap((wb) =>
      wb.tables.map(async (t): Promise<[string, TableStats] | null> => {
        try {
          const s = await getSegmentStats(t.canonical);
          return [t.id, { leads: s.totalLeads, deliverable: s.deliverable, pending: s.pendingValidation }];
        } catch {
          return null;
        }
      }),
    ),
  );
  return Object.fromEntries(pairs.filter((p): p is [string, TableStats] => p !== null));
}

export default async function EnrichmentPage() {
  await requireActiveProfile();

  // The tree is the page; the Smartlead campaign list degrades quietly so the
  // landing still renders if the upstream hiccups. An empty campaign list
  // tells the client Smartlead is unreachable (tag controls disable
  // themselves). Per-table stats chain on the tree and degrade to hidden
  // numbers. No workspace-wide stat strip here: the numbers that matter live
  // on each workbook and table row.
  const treePromise = getWorkspaceTree();
  const [tree, smartlead, tableStats] = await Promise.all([
    treePromise,
    listCampaigns().then((rows) => ({ rows, error: false })).catch(() => ({ rows: [] as { id: string; name: string; status: string | null }[], error: true })),
    treePromise.then(loadTableStats).catch(() => ({} as Record<string, TableStats>)),
  ]);

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <header className="flex h-14 shrink-0 items-center gap-2 border-b border-border bg-surface px-5">
        <Table2 className="size-4 text-muted-foreground" strokeWidth={1.75} />
        <h1 className="text-[15px] font-semibold tracking-tight">Enrichment</h1>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <EnrichmentHomeClient
          tree={tree}
          campaigns={smartlead.rows}
          smartleadError={smartlead.error}
          tableStats={tableStats}
        />
      </div>
    </div>
  );
}
