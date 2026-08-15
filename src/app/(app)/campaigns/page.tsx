import { requireActiveProfile } from "@/lib/auth";
import { listCampaigns } from "@/lib/smartlead";
import { getTaxonomy } from "@/lib/taxonomy-store";
import { getAiSettings } from "@/lib/settings-store";
import { CampaignsClient } from "./campaigns-client";

export const dynamic = "force-dynamic";

// ?c=<campaign id> opens that campaign on load — the deep link the signals
// pipeline strip uses to jump from an automation to its campaign.
export default async function CampaignsPage({ searchParams }: { searchParams: Promise<{ c?: string }> }) {
  const [{ c }] = await Promise.all([searchParams, requireActiveProfile()]);

  // Smartlead may be unconfigured or unreachable — fall back to a friendly empty
  // state that points at Settings → Integrations rather than throwing. All
  // three loads are independent, so they run in one round trip.
  const [taxonomy, aiSettings, smartlead] = await Promise.all([
    getTaxonomy(),
    getAiSettings(),
    listCampaigns().then(
      (campaigns) => ({ campaigns, error: null as string | null }),
      (error: unknown) => ({
        campaigns: [] as { id: string; name: string; status: string | null; createdAt: string | null }[],
        error: error instanceof Error ? error.message : "Could not load campaigns from Smartlead.",
      }),
    ),
  ]);
  const campaigns = smartlead.campaigns;
  const smartleadError = smartlead.error;

  return (
    <CampaignsClient
      campaigns={campaigns}
      categories={taxonomy.active}
      aiSettings={aiSettings}
      smartleadError={smartleadError}
      initialSelectedId={c && campaigns.some((campaign) => campaign.id === c) ? c : null}
    />
  );
}
