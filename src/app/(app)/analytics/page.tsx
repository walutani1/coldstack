import type { Metadata } from "next";
import { BarChart3 } from "lucide-react";
import { requireActiveProfile } from "@/lib/auth";
import { getAnalyticsData } from "@/lib/replies/queries";
import { listCampaigns } from "@/lib/smartlead";
import { AnalyticsClient } from "./analytics-client";

export const metadata: Metadata = { title: "Analytics" };
export const dynamic = "force-dynamic";

export default async function AnalyticsPage() {
  await requireActiveProfile();

  // Server-provided initial payload: a 30-day, all-campaigns view so the first
  // paint needs no client fetch or skeleton. The campaign choice list degrades
  // to empty if Smartlead is unreachable so the page still renders (the filter
  // just offers nothing to pick, and every panel stays workspace-wide).
  const [initialData, campaigns] = await Promise.all([
    getAnalyticsData({ days: 30 }),
    listCampaigns()
      .then((rows) => [...rows].sort((a, b) => a.name.localeCompare(b.name)))
      .catch(() => [] as { id: string; name: string; status: string | null }[]),
  ]);

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* Same header bar grammar as every other page (icon + 15px title). */}
      <header className="flex h-14 shrink-0 items-center gap-2 border-b border-border bg-surface px-5">
        <BarChart3 className="size-4 text-muted-foreground" strokeWidth={1.75} />
        <h1 className="text-[15px] font-semibold tracking-tight">Analytics</h1>
      </header>
      <AnalyticsClient initialData={initialData} campaigns={campaigns} />
    </div>
  );
}
