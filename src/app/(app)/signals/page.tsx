import type { Metadata } from "next";
import { requireActiveProfile } from "@/lib/auth";
import { getAdminClient } from "@/lib/supabase/admin";
import { getTableById } from "@/lib/enrichment/workspace";
import { listAutomationSummaries } from "@/lib/signals/automations";
import { getActiveFunnelConfig } from "@/lib/signals/config";
import { getLastFinishedFunnelRun, getOpenFunnelRun } from "@/lib/signals/funnel";
import { getCompaniesPage, getFunnelCounts } from "@/lib/signals/funnel-store";
import { listSignalSearches } from "@/lib/signals/store";
import type {
  AutomationSummary,
  CompaniesPage,
  FunnelConfigVersion,
  FunnelCounts,
  FunnelRunDto,
  SignalSearchDto,
} from "@/lib/signals/types";
import { SignalsShell } from "./signals-shell";

export const metadata: Metadata = { title: "Signals" };
export const dynamic = "force-dynamic";

// ?a=<automation id> opens one automation; without it the tab is the list of
// automations, which is the screen the operator lands on.
export default async function SignalsPage({ searchParams }: { searchParams: Promise<{ a?: string }> }) {
  await requireActiveProfile();
  const { a } = await searchParams;

  let automations: AutomationSummary[] = [];
  let initialError: string | null = null;
  try {
    automations = await listAutomationSummaries();
  } catch (error) {
    initialError = error instanceof Error ? error.message : "Could not load automations.";
  }

  const selected = a && automations.some((row) => row.automation.id === a) ? a : null;

  let initialPage: CompaniesPage | null = null;
  let counts: FunnelCounts | null = null;
  let openRun: FunnelRunDto | null = null;
  let lastRun: FunnelRunDto | null = null;
  let config: FunnelConfigVersion | null = null;
  let searches: SignalSearchDto[] = [];
  // Where this automation's pushed leads live, for the pipeline strip. Best
  // effort: a missing table just renders as "appears on first push".
  let tableLink: { name: string; href: string } | null = null;
  if (selected) {
    const selectedRow = automations.find((row) => row.automation.id === selected);
    const tableId = selectedRow?.automation.prospectTableId ?? null;
    if (tableId) {
      try {
        const table = await getTableById(tableId);
        if (table) {
          const { data: book } = await getAdminClient().from("enrichment_workbooks").select("slug").eq("id", table.workbookId).maybeSingle();
          if (book?.slug) tableLink = { name: table.name, href: `/enrichment/${book.slug}/${table.slug}` };
        }
      } catch {
        // Table lookup is decoration; the automation screen must not fail on it.
      }
    }
  }
  if (selected) {
    try {
      [initialPage, counts, openRun, lastRun, config, searches] = await Promise.all([
        getCompaniesPage({ automationId: selected, view: "qualified", reviewState: "all", killedStage: null, q: null, limit: 50, offset: 0 }),
        getFunnelCounts(selected),
        getOpenFunnelRun(selected),
        getLastFinishedFunnelRun(selected),
        getActiveFunnelConfig(),
        listSignalSearches(selected),
      ]);
    } catch (error) {
      initialError = error instanceof Error ? error.message : "Could not load signals.";
    }
  }

  return (
    <SignalsShell
      automations={automations}
      selectedId={selected}
      initialPage={initialPage}
      initialCounts={counts}
      initialOpenRun={openRun}
      initialLastRun={lastRun}
      initialConfig={config}
      initialSearches={searches}
      initialError={initialError}
      tableLink={tableLink}
    />
  );
}
