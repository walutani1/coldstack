import { requireActiveProfile } from "@/lib/auth";
import { getAdminClient } from "@/lib/supabase/admin";
import { getEmailTransportStatus } from "@/lib/notifications/email";
import { getTaxonomy } from "@/lib/taxonomy-store";
import { getAiSettings, getIntegrationSettings, getWorkspaceSettings } from "@/lib/settings-store";
import { getAiUsageOverview } from "@/lib/usage";
import { getIntegrationStatus } from "@/lib/integration-status";
import { getWorkspaceLogo } from "@/lib/branding";
import { listTeamMembers } from "@/lib/team";
import { listCampaigns } from "@/lib/smartlead";
import type { NotificationChannel, NotificationDelivery } from "@/lib/types";
import { SettingsClient } from "./settings-client";

export const dynamic = "force-dynamic";

export default async function SettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ section?: string }>;
}) {
  const [{ section }, profile] = await Promise.all([searchParams, requireActiveProfile()]);

  const admin = getAdminClient();
  const [
    taxonomy,
    aiSettings,
    integrationSettings,
    integrationStatus,
    workspaceSettings,
    teamMembers,
    logo,
    channelsRes,
    deliveriesRes,
    emailStatus,
  ] = await Promise.all([
    getTaxonomy(),
    getAiSettings(),
    getIntegrationSettings(),
    getIntegrationStatus(),
    getWorkspaceSettings(),
    listTeamMembers(profile.id),
    getWorkspaceLogo(),
    admin
      .from("notification_channels")
      .select("id, channel_type, label, target, categories, campaign_ids, enabled, created_at")
      .order("created_at", { ascending: true }),
    admin
      .from("notification_deliveries")
      .select("id, channel_id, kind, status, error, created_at")
      .order("created_at", { ascending: false })
      .limit(10),
    getEmailTransportStatus(),
  ]);

  // Best-effort campaign list for the per-channel scope picker; an unconfigured
  // or unreachable Smartlead simply yields no campaign pills.
  let campaigns: { id: string; name: string }[] = [];
  try {
    campaigns = (await listCampaigns()).map((campaign) => ({ id: campaign.id, name: campaign.name }));
  } catch {
    campaigns = [];
  }

  // Usage rollup is best-effort too: a slow gateway or query must never take
  // the whole settings page down with it.
  const aiUsage = await getAiUsageOverview().catch(() => null);

  return (
    <SettingsClient
      categories={taxonomy.all}
      aiSettings={aiSettings}
      integrationSettings={integrationSettings}
      integrationStatus={integrationStatus}
      workspaceSettings={workspaceSettings}
      teamMembers={teamMembers}
      logoVersion={logo?.version ?? null}
      initialSection={section}
      notificationChannels={(channelsRes.data ?? []) as NotificationChannel[]}
      notificationDeliveries={(deliveriesRes.data ?? []) as NotificationDelivery[]}
      notificationEmailStatus={emailStatus}
      notificationCategories={taxonomy.active}
      notificationCampaigns={campaigns}
      aiUsage={aiUsage}
    />
  );
}
