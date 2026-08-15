"use client";

import { useRouter } from "next/navigation";
import type {
  AutomationSummary,
  CompaniesPage,
  FunnelConfigVersion,
  FunnelCounts,
  FunnelRunDto,
  SignalSearchDto,
} from "@/lib/signals/types";
import { AutomationsHome } from "./automations-client";
import { SignalsClient } from "./signals-client";

// Two screens, one tab: the automations list, or one automation's results.
// The selection lives in the URL so a lead is linkable.
export function SignalsShell({
  automations,
  selectedId,
  initialPage,
  initialCounts,
  initialOpenRun,
  initialLastRun,
  initialConfig,
  initialSearches,
  initialError,
  tableLink,
}: {
  automations: AutomationSummary[];
  selectedId: string | null;
  initialPage: CompaniesPage | null;
  initialCounts: FunnelCounts | null;
  initialOpenRun: FunnelRunDto | null;
  initialLastRun: FunnelRunDto | null;
  initialConfig: FunnelConfigVersion | null;
  initialSearches: SignalSearchDto[];
  initialError: string | null;
  tableLink: { name: string; href: string } | null;
}) {
  const router = useRouter();
  const selected = automations.find((row) => row.automation.id === selectedId) ?? null;

  if (!selected) {
    return <AutomationsHome initial={automations} onOpen={(id) => router.push(`/signals?a=${id}`)} />;
  }

  return (
    <SignalsClient
      automation={selected.automation}
      onBack={() => router.push("/signals")}
      initialPage={initialPage}
      initialCounts={initialCounts}
      initialOpenRun={initialOpenRun}
      initialLastRun={initialLastRun}
      initialConfig={initialConfig}
      initialSearches={initialSearches}
      initialError={initialError}
      tableLink={tableLink}
    />
  );
}
