import type { Metadata } from "next";
import { after } from "next/server";
import { requireActiveProfile } from "@/lib/auth";
import { getInboxAvatarMap } from "@/lib/inbox-avatars";
import { getInboxConversations } from "@/lib/replies/queries";
import { processPendingReplyEvents } from "@/lib/replies/process";
import { getTaxonomy } from "@/lib/taxonomy-store";
import { getWorkspaceSettings } from "@/lib/settings-store";
import { getUntrackedCounts } from "@/lib/untracked/queries";
import { InboxClient } from "./inbox-client";

export const metadata: Metadata = { title: "Inbox" };
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export default async function InboxPage() {
  await requireActiveProfile();

  // Safety net: quietly drain anything the webhook didn't finish processing.
  // Batch of 2 fits the 60s window — the cron (300s) is the heavy lifter.
  after(async () => {
    try {
      await processPendingReplyEvents(2);
    } catch {
      // best-effort background drain
    }
  });

  const [conversations, taxonomy, workspace, untracked, inboxAvatars] = await Promise.all([
    getInboxConversations(),
    getTaxonomy(),
    getWorkspaceSettings(),
    // Badge count is best-effort: the inbox must render even if it fails.
    getUntrackedCounts().catch(() => ({ actionable: 0, cleaned: 0 })),
    // Real sending-inbox profile pictures (cached; failure = initials fallback).
    getInboxAvatarMap().catch(() => ({} as Record<string, string>)),
  ]);

  return (
    <InboxClient
      conversations={conversations}
      categories={taxonomy.active}
      inboxAvatars={inboxAvatars}
      timeZone={workspace.timeZone}
      timeLocale={workspace.timeLocale}
      untrackedCount={untracked.actionable}
    />
  );
}
