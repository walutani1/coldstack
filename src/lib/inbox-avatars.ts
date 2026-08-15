import "server-only";

import { getAdminClient } from "@/lib/supabase/admin";
import { isZapmailConfigured, listZapmailMailboxes } from "@/lib/zapmail";

/* The real profile pictures our sending inboxes wear, straight from Zapmail
   (which rehosts them on its CDN). Keyed by lowercase email.

   Zapmail is unreachable more often than it sounds: some operator networks
   block *.zapmail.ai outright (content filters), and in production every cold
   serverless instance starts with an empty cache against a ~20 req/min rate
   limit. So the map lives in three layers: a per-process cache for the hot
   path, and a durable Supabase snapshot (inbox_avatar_snapshot, kept fresh by
   the cron and by every successful live fetch) that answers when Zapmail
   can't. `verified` distinguishes "this mailbox has no picture" from "we
   couldn't check" — the missing-photo warnings must only fire on the former. */

const LIVE_TTL_MS = 10 * 60_000;
const LIVE_FAILURE_BACKOFF_MS = 60_000;
const DB_TTL_MS = 5 * 60_000;
// A snapshot older than this can't vouch for missing pictures. Page loads
// refresh it organically wherever Zapmail is reachable and the cron backstop
// syncs daily, so crossing this line means the sync is genuinely broken.
const SNAPSHOT_FRESH_MS = 48 * 60 * 60_000;

type UpstreamState = { map: Record<string, string>; verified: boolean };

let liveCache: { at: number; map: Record<string, string> } | null = null;
let liveFailureAt = 0;
let dbCache: { at: number; map: Record<string, string>; snapshotAt: number } | null = null;

async function fetchLiveMap(): Promise<Record<string, string>> {
  const { mailboxes } = await listZapmailMailboxes();
  const map: Record<string, string> = {};
  for (const mailbox of mailboxes) {
    if (mailbox.profilePicture) map[mailbox.email.toLowerCase()] = mailbox.profilePicture;
  }
  return map;
}

/* Upsert the fresh map, then sweep rows the upsert didn't touch (this pass's
   timestamp is the watermark). Never persists an empty map: zero
   pictured-mailboxes is indistinguishable from a mangled API response, and a
   wiped snapshot would take every fallback reader down with it. */
async function persistSnapshotNow(map: Record<string, string>): Promise<void> {
  const emails = Object.keys(map);
  if (emails.length === 0) return;
  const admin = getAdminClient();
  const now = new Date().toISOString();
  const { error } = await admin
    .from("inbox_avatar_snapshot")
    .upsert(emails.map((email) => ({ email, url: map[email], updated_at: now })));
  if (!error) await admin.from("inbox_avatar_snapshot").delete().lt("updated_at", now);
}

async function loadDbSnapshot(): Promise<{ map: Record<string, string>; snapshotAt: number } | null> {
  const { data, error } = await getAdminClient()
    .from("inbox_avatar_snapshot")
    .select("email, url, updated_at");
  if (error || !data || data.length === 0) return null;
  const map: Record<string, string> = {};
  let snapshotAt = 0;
  for (const row of data) {
    map[String(row.email)] = String(row.url);
    const at = Date.parse(String(row.updated_at));
    if (Number.isFinite(at) && at > snapshotAt) snapshotAt = at;
  }
  return { map, snapshotAt };
}

/** email → cdn.zapmail.ai URL, plus whether missing keys are meaningful.
 *  For the /api/inbox-avatar proxy route and the cron sync only: browsers
 *  must never be handed these URLs directly (see getInboxAvatarState). */
export async function getInboxAvatarUpstreamState(): Promise<UpstreamState> {
  const now = Date.now();
  if (liveCache && now - liveCache.at < LIVE_TTL_MS) return { map: liveCache.map, verified: true };

  if (now - liveFailureAt > LIVE_FAILURE_BACKOFF_MS) {
    try {
      if (await isZapmailConfigured()) {
        const map = await fetchLiveMap();
        liveCache = { at: now, map };
        void persistSnapshotNow(map).catch(() => {});
        return { map, verified: true };
      }
    } catch {
      liveFailureAt = now;
    }
  }

  // Fallback 1: the durable snapshot — reachable even where Zapmail isn't.
  if (!dbCache || now - dbCache.at > DB_TTL_MS) {
    const db = await loadDbSnapshot().catch(() => null);
    if (db) dbCache = { at: now, ...db };
  }
  if (dbCache) return { map: dbCache.map, verified: now - dbCache.snapshotAt < SNAPSHOT_FRESH_MS };

  // Fallback 2: the last in-process fetch, however stale — it was real once.
  if (liveCache) return { map: liveCache.map, verified: true };
  return { map: {}, verified: false };
}

/** Our own image URL for an inbox's avatar — same-origin, so it loads in the
 *  sandboxed sequence-preview iframe and on networks whose content filters
 *  block *.zapmail.ai (the operator's does). */
export function inboxAvatarProxyPath(email: string): string {
  return `/api/inbox-avatar?email=${encodeURIComponent(email.trim().toLowerCase())}`;
}

export type InboxAvatarState = { map: Record<string, string>; verified: boolean };

/* What pages and actions consume: the same keys as upstream (an entry exists
   exactly when the mailbox HAS a picture), values are the proxy path rather
   than the raw CDN URL, and `verified` says whether a MISSING entry may be
   presented as "no profile picture" (false = we couldn't check, stay quiet). */
export async function getInboxAvatarState(): Promise<InboxAvatarState> {
  const upstream = await getInboxAvatarUpstreamState();
  return {
    map: Object.fromEntries(
      Object.keys(upstream.map).map((email) => [email, inboxAvatarProxyPath(email)]),
    ),
    verified: upstream.verified,
  };
}

/** Back-compat shape for decorative consumers (inbox thread avatars, sequence
 *  preview) that fall back to initials and never warn about missing photos. */
export async function getInboxAvatarMap(): Promise<Record<string, string>> {
  return (await getInboxAvatarState()).map;
}

/* ── Durable image bytes (inbox_avatar_images, one row per CDN URL) ──────── */

export async function loadCachedAvatarImage(
  url: string,
): Promise<{ bytes: ArrayBuffer; type: string } | null> {
  const { data, error } = await getAdminClient()
    .from("inbox_avatar_images")
    .select("content_type, image_base64")
    .eq("url", url)
    .maybeSingle();
  if (error || !data) return null;
  const buffer = Buffer.from(String(data.image_base64), "base64");
  if (buffer.byteLength === 0) return null;
  return {
    bytes: buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer,
    type: String(data.content_type || "image/png"),
  };
}

export function persistAvatarImage(url: string, type: string, bytes: ArrayBuffer): void {
  void getAdminClient()
    .from("inbox_avatar_images")
    .upsert({
      url,
      content_type: type,
      image_base64: Buffer.from(bytes).toString("base64"),
      fetched_at: new Date().toISOString(),
    })
    .then(undefined, () => {});
}

/* ── Cron sync: refresh the snapshot and backfill image bytes ────────────── */

const SYNC_IMAGE_FETCH_LIMIT = 12; // ~1MB each; the rest catch up next runs
// The cron is a BACKSTOP, not the primary refresher — every successful live
// fetch on a page load persists the snapshot too, and the proxy caches image
// bytes on first view. So a daily sync is plenty; ticks in between cost two
// small Supabase reads and never touch Zapmail.
const SYNC_MIN_INTERVAL_MS = 24 * 60 * 60_000;

export async function syncInboxAvatars(): Promise<{
  ran: boolean;
  mailboxes?: number;
  imagesFetched?: number;
  imagesPending?: number;
  reason?: string;
}> {
  if (!(await isZapmailConfigured())) return { ran: false, reason: "Zapmail is not configured." };

  const gate = await getAdminClient().from("inbox_avatar_snapshot").select("url, updated_at");
  if (gate.data && gate.data.length > 0) {
    let latest = 0;
    for (const row of gate.data) {
      const at = Date.parse(String(row.updated_at));
      if (Number.isFinite(at) && at > latest) latest = at;
    }
    if (Date.now() - latest < SYNC_MIN_INTERVAL_MS) {
      const urls = [...new Set(gate.data.map((row) => String(row.url)))];
      const { data: images } = await getAdminClient()
        .from("inbox_avatar_images")
        .select("url")
        .in("url", urls);
      const have = new Set((images ?? []).map((row) => String(row.url)));
      if (urls.every((url) => have.has(url))) {
        return { ran: false, reason: "Snapshot fresh and all images cached." };
      }
    }
  }

  const map = await fetchLiveMap();
  liveCache = { at: Date.now(), map };
  await persistSnapshotNow(map);

  const admin = getAdminClient();
  const urls = [...new Set(Object.values(map))];
  const { data: existing } = await admin.from("inbox_avatar_images").select("url");
  const have = new Set((existing ?? []).map((row) => String(row.url)));

  // Sweep rows for URLs no mailbox wears anymore.
  const stale = [...have].filter((url) => !urls.includes(url));
  if (stale.length > 0) await admin.from("inbox_avatar_images").delete().in("url", stale);

  let fetched = 0;
  const missing = urls.filter((url) => !have.has(url));
  for (const url of missing.slice(0, SYNC_IMAGE_FETCH_LIMIT)) {
    const response = await fetch(url, { cache: "no-store" }).catch(() => null);
    if (!response?.ok) continue;
    const bytes = await response.arrayBuffer();
    if (bytes.byteLength === 0) continue;
    await admin.from("inbox_avatar_images").upsert({
      url,
      content_type: response.headers.get("content-type") ?? "image/png",
      image_base64: Buffer.from(bytes).toString("base64"),
      fetched_at: new Date().toISOString(),
    });
    fetched += 1;
  }
  return {
    ran: true,
    mailboxes: Object.keys(map).length,
    imagesFetched: fetched,
    imagesPending: Math.max(0, missing.length - fetched),
  };
}
