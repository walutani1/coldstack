import "server-only";

import { getAdminClient } from "@/lib/supabase/admin";
import { fetchUntrackedRepliesPage, type UntrackedProviderPage } from "@/lib/smartlead/master-inbox";

const PROVIDER = "smartlead";
const PAGE_SIZE = 100;

type SyncState = {
  next_offset: number; consecutive_failures: number; updated_at: string;
};

function sameUtcDay(value: string, now = new Date()) {
  return value.slice(0, 10) === now.toISOString().slice(0, 10);
}

async function state(): Promise<SyncState> {
  const admin = getAdminClient();
  const { data, error } = await admin.from("untracked_reply_sync_state").select("next_offset,consecutive_failures,updated_at").eq("provider", PROVIDER).maybeSingle();
  if (error) throw new Error(`Untracked sync state: ${error.message}`);
  if (data) return data as SyncState;
  const inserted = await admin.from("untracked_reply_sync_state").insert({ provider: PROVIDER }).select("next_offset,consecutive_failures,updated_at").single();
  if (inserted.error) throw new Error(`Untracked sync state create: ${inserted.error.message}`);
  return inserted.data as SyncState;
}

async function persistPage(page: UntrackedProviderPage, seenAt: string): Promise<{ inserted: number; seen: number }> {
  if (!page.replies.length) return { inserted: 0, seen: 0 };
  const admin = getAdminClient();
  const replies = [...new Map(page.replies.map((reply) => [reply.providerReplyId, reply])).values()];
  const ids = replies.map((reply) => reply.providerReplyId);
  const { data: existing, error: findError } = await admin.from("untracked_replies")
    .select("provider_reply_id,subject,body_text,raw,provider_received_at,from_email,from_name,to_email,cc,bcc,account_id,provider_message_id,uid")
    .eq("provider", PROVIDER).in("provider_reply_id", ids);
  if (findError) throw new Error(`Untracked poll lookup: ${findError.message}`);
  const existingById = new Map((existing ?? []).map((row) => [String(row.provider_reply_id), row]));
  const rows = replies.map((reply) => {
    const old = existingById.get(reply.providerReplyId);
    return {
      provider: PROVIDER, provider_reply_id: reply.providerReplyId,
      account_id: old?.account_id ?? reply.accountId, provider_message_id: old?.provider_message_id ?? reply.providerMessageId,
      uid: old?.uid ?? reply.uid, from_email: old?.from_email ?? reply.fromEmail, from_name: old?.from_name ?? reply.fromName,
      to_email: old?.to_email ?? reply.toEmail, cc: old?.cc ?? reply.cc, bcc: old?.bcc ?? reply.bcc,
      subject: old?.subject ?? reply.subject, body_text: old?.body_text ?? reply.bodyText,
      raw: old?.raw ?? reply.raw, provider_received_at: old?.provider_received_at ?? reply.providerReceivedAt,
      first_seen_at: old ? undefined : seenAt, last_seen_at: seenAt,
    };
  }).map((row) => Object.fromEntries(Object.entries(row).filter(([, value]) => value !== undefined)));
  const { error } = await admin.from("untracked_replies").upsert(rows, { onConflict: "provider,provider_reply_id" });
  if (error) throw new Error(`Untracked poll upsert: ${error.message}`);
  return { inserted: rows.length - existingById.size, seen: rows.length };
}

export async function pollUntrackedReplies(): Promise<{
  fetched: number; inserted: number; pages: number; deepPages: number; skipped?: string; error?: string;
}> {
  const admin = getAdminClient();
  let sync: SyncState;
  try { sync = await state(); } catch (error) { return { fetched: 0, inserted: 0, pages: 0, deepPages: 0, error: error instanceof Error ? error.message : String(error) }; }
  if (sync.consecutive_failures >= 5 && sameUtcDay(sync.updated_at)) {
    return { fetched: 0, inserted: 0, pages: 0, deepPages: 0, skipped: "circuit_open" };
  }
  const seenAt = new Date().toISOString();
  let fetched = 0, inserted = 0, pages = 0, deepPages = 0;
  let totalCount: number | null = null;
  try {
    for (let pageIndex = 0; pageIndex < 5; pageIndex += 1) {
      const page = await fetchUntrackedRepliesPage({ limit: PAGE_SIZE, offset: pageIndex * PAGE_SIZE });
      totalCount = page.totalCount ?? totalCount;
      const saved = await persistPage(page, seenAt);
      fetched += saved.seen; inserted += saved.inserted; pages += 1;
      if (!page.hasMore || page.replies.length < PAGE_SIZE || saved.inserted === 0) break;
    }

    let cursor = Math.max(PAGE_SIZE, sync.next_offset || 500);
    for (let step = 0; step < 3; step += 1) {
      if (totalCount !== null && cursor >= totalCount) { cursor = PAGE_SIZE; break; }
      const page = await fetchUntrackedRepliesPage({ limit: PAGE_SIZE, offset: cursor });
      totalCount = page.totalCount ?? totalCount;
      const saved = await persistPage(page, seenAt);
      fetched += saved.seen; inserted += saved.inserted; pages += 1; deepPages += 1;
      cursor += PAGE_SIZE;
      if (!page.hasMore || page.replies.length < PAGE_SIZE) { cursor = PAGE_SIZE; break; }
    }
    const completed = totalCount !== null && cursor === PAGE_SIZE;
    const { error } = await admin.from("untracked_reply_sync_state").upsert({
      provider: PROVIDER, next_offset: cursor, scan_started_at: sync.next_offset === cursor ? undefined : seenAt,
      last_completed_at: completed ? seenAt : undefined, last_success_at: seenAt,
      consecutive_failures: 0, last_error: null,
    }, { onConflict: "provider" });
    if (error) throw new Error(`Untracked sync success state: ${error.message}`);
    return { fetched, inserted, pages, deepPages };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await admin.from("untracked_reply_sync_state").upsert({ provider: PROVIDER,
      consecutive_failures: sync.consecutive_failures + 1, last_error: message.slice(0, 2000) }, { onConflict: "provider" });
    return { fetched, inserted, pages, deepPages, error: message };
  }
}
