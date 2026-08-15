import type { Metadata } from "next";
import { requireActiveProfile } from "@/lib/auth";
import { listCampaigns } from "@/lib/smartlead";
import { getWorkspaceSettings } from "@/lib/settings-store";
import { getUntrackedOverview } from "@/lib/untracked/queries";
import { UntrackedClient, type UntrackedOverview, type UntrackedRow } from "./untracked-client";

export const metadata: Metadata = { title: "Untracked replies" };
export const dynamic = "force-dynamic";

export default async function UntrackedRepliesPage() {
  await requireActiveProfile();
  const [overview, campaigns, workspace] = await Promise.all([
    getUntrackedOverview({ group: "actionable" }),
    // Campaign labels are a nicety: a Smartlead outage must not take the
    // review surface down (ids still render via the client's fallback).
    listCampaigns().catch(() => []),
    getWorkspaceSettings(),
  ]);

  const initialOverview: UntrackedOverview = { ...overview, rows: overview.rows as UntrackedRow[] };

  return (
    <UntrackedClient
      initialOverview={initialOverview}
      campaigns={campaigns.map((campaign) => ({ id: campaign.id, name: campaign.name }))}
      timeZone={workspace.timeZone}
      timeLocale={workspace.timeLocale}
    />
  );
}
