import { requireActiveProfile } from "@/lib/auth";
import { getInboxAvatarState, type InboxAvatarState } from "@/lib/inbox-avatars";
import { getWorkspaceSettings } from "@/lib/settings-store";
import { listInboxAccounts } from "@/lib/smartlead";
import { getWarmupPlansByEmail, type InboxWarmupPlan } from "@/lib/zapmail-provisions";
import { InboxesClient, type InboxAccount } from "./inboxes-client";

export const dynamic = "force-dynamic";
// Bulk actions and tag rotation fan out one paced Smartlead write per inbox
// (~1s each) — a large selection needs far more than the platform default.
export const maxDuration = 300;

export default async function InboxesPage() {
  await requireActiveProfile();

  // An unconfigured or unreachable Smartlead yields no accounts plus a flag so
  // the client shows a calm "connect Smartlead" empty state — the same tone the
  // campaigns page uses for the identical failure. Settings and the roster are
  // independent, so they load in parallel.
  const [workspace, roster, avatarState, warmupPlans] = await Promise.all([
    getWorkspaceSettings(),
    listInboxAccounts().then(
      (accounts) => ({ inboxes: accounts as InboxAccount[], smartleadError: false }),
      () => ({ inboxes: [] as InboxAccount[], smartleadError: true }),
    ),
    // Real profile pictures from Zapmail (durably cached; a total failure
    // yields an UNVERIFIED empty map so the client never claims "missing").
    getInboxAvatarState().catch(() => ({ map: {}, verified: false }) as InboxAvatarState),
    // Warmup windows chosen at purchase (failure = house default for all).
    getWarmupPlansByEmail().catch(() => ({} as Record<string, InboxWarmupPlan>)),
  ]);
  const inboxes = roster.inboxes;
  const smartleadError = roster.smartleadError;

  return (
    <InboxesClient
      inboxes={inboxes}
      smartleadError={smartleadError}
      inboxAvatars={avatarState.map}
      avatarsVerified={avatarState.verified}
      warmupPlans={warmupPlans}
      timeZone={workspace.timeZone}
      timeLocale={workspace.timeLocale}
    />
  );
}
