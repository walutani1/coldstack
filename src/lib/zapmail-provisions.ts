import "server-only";

import { getAdminClient } from "@/lib/supabase/admin";
import {
  exportMailboxesToSmartlead,
  listOwnedDomains,
  listZapmailMailboxes,
  setDomainForwarding,
  updateZapmailMailboxes,
  type ZapmailMailbox,
} from "@/lib/zapmail";
import { getInboxProvisioningConfig } from "@/lib/inbox-provisioning-config";
import { listInboxAccounts, updateInboxDailyLimit, updateInboxWarmup } from "@/lib/smartlead";
import { generateWarmupTag } from "@/lib/warmup-tags";
import { escapeSlackText, normalizeWebhookUrl, sendSlackMessage } from "@/lib/notifications/slack";

/* Durable Zapmail provisioning pipeline. A batch records the operator's intent
   at inbox-creation time (image, auto-export account, notify); the cron tick
   advances it server-side because activation can take ~2 hours and must not
   depend on the wizard tab staying open:

     watching    mailboxes pending -> active; once every survivor is active (or
                 the deadline passes), fire ONE bulk export to Smartlead.
     exporting   wait for the accounts to appear in Smartlead (ground truth is
                 the account existing, not the export-status string), then apply
                 the sending/warmup defaults per account.
     review      all done; a human reviews + approves in the Inboxes tab.
     complete    every item approved.

   The profile image is a SEPARATE background concern (tickImages): Zapmail's
   mailbox-update endpoint keeps 500ing for a while after creation even when the
   mailbox already reports ACTIVE (live-reproduced 2026-07-17), so imaging
   retries every tick until the batch deadline and must never delay - let alone
   expire - the Smartlead export. The latest failure is recorded on the batch
   (image_error) so the review card can surface it instead of a silent stall.

   One Slack message per batch when it reaches review, one on expiry, and one
   when its warmup window completes (tickWarmupReady) - never a message per
   inbox. */

/* Operator-approved defaults (2026-07-16) applied to each account the moment it
   lands in Smartlead. The review step exists precisely so these can be adjusted
   per batch before the inboxes are considered ready. */
const DEFAULT_DAILY_LIMIT = 15;
const DEFAULT_WARMUP_PER_DAY = 20;
const DEFAULT_WARMUP_REPLY_RATE = 23;
// After the export fires, how long we wait for accounts to appear in Smartlead
// before flagging the stragglers and moving on.
const EXPORT_WAIT_MS = 24 * 3600_000;
// The operator picks the warmup window in the buy wizard; two weeks is the
// house default for inboxes provisioned outside it.
export const DEFAULT_WARMUP_PERIOD_DAYS = 14;
export const WARMUP_PERIOD_OPTIONS = [7, 14, 21, 30, 60, 90] as const;

/** "2-week" / "1-month" phrasing for Slack and UI copy. */
export function warmupPeriodLabel(days: number): string {
  if (days % 30 === 0) return `${days / 30}-month`;
  if (days % 7 === 0) return `${days / 7}-week`;
  return `${days}-day`;
}

/** "2 weeks" / "1 month" - the noun-phrase variant. */
export function warmupPeriodPhrase(days: number): string {
  if (days % 30 === 0) { const n = days / 30; return `${n} month${n === 1 ? "" : "s"}`; }
  if (days % 7 === 0) { const n = days / 7; return `${n} week${n === 1 ? "" : "s"}`; }
  return `${days} days`;
}

export type ProvisionItemState =
  | "pending" | "active" | "imaged" | "exported" | "configured" | "review" | "approved" | "failed";

export type ZapmailProvisionItem = {
  email: string;
  domainName: string;
  mailboxId: string | null;
  state: ProvisionItemState;
  smartleadAccountId: number | null;
  error: string | null;
};

export type ZapmailProvision = {
  id: string;
  provider: string;
  status: "watching" | "exporting" | "configuring" | "review" | "complete" | "expired" | "error";
  imageUrl: string | null;
  imageError: string | null;
  exportAccountId: string | null;
  exportId: number | null;
  notify: boolean;
  deadlineAt: string;
  warmupDays: number;
  warmupStartedAt: string | null;
  error: string | null;
  createdAt: string;
  items: ZapmailProvisionItem[];
};

const ACTIVE_RE = /active|success|complete|ready|created|done/i;

function rowToItem(row: Record<string, unknown>): ZapmailProvisionItem {
  return {
    email: String(row.email),
    domainName: String(row.domain_name),
    mailboxId: row.mailbox_id ? String(row.mailbox_id) : null,
    state: row.state as ProvisionItemState,
    smartleadAccountId: row.smartlead_account_id == null ? null : Number(row.smartlead_account_id),
    error: row.error ? String(row.error) : null,
  };
}

function rowToProvision(row: Record<string, unknown>, items: ZapmailProvisionItem[]): ZapmailProvision {
  return {
    id: String(row.id),
    provider: String(row.provider ?? "GOOGLE"),
    status: row.status as ZapmailProvision["status"],
    imageUrl: row.image_url ? String(row.image_url) : null,
    imageError: row.image_error ? String(row.image_error) : null,
    exportAccountId: row.export_account_id ? String(row.export_account_id) : null,
    exportId: row.export_id == null ? null : Number(row.export_id),
    notify: Boolean(row.notify),
    deadlineAt: String(row.deadline_at),
    warmupDays: Number(row.warmup_days ?? DEFAULT_WARMUP_PERIOD_DAYS),
    warmupStartedAt: row.warmup_started_at ? String(row.warmup_started_at) : null,
    error: row.error ? String(row.error) : null,
    createdAt: String(row.created_at),
    items,
  };
}

async function loadProvisions(statuses: string[]): Promise<ZapmailProvision[]> {
  const admin = getAdminClient();
  const batches = await admin.from("zapmail_provisions").select("*").in("status", statuses).order("created_at");
  if (batches.error) throw new Error(batches.error.message);
  const rows = (batches.data ?? []) as Record<string, unknown>[];
  if (rows.length === 0) return [];
  const items = await admin.from("zapmail_provision_items").select("*").in("provision_id", rows.map((r) => String(r.id)));
  if (items.error) throw new Error(items.error.message);
  const byBatch = new Map<string, ZapmailProvisionItem[]>();
  for (const item of (items.data ?? []) as Record<string, unknown>[]) {
    const key = String(item.provision_id);
    if (!byBatch.has(key)) byBatch.set(key, []);
    byBatch.get(key)!.push(rowToItem(item));
  }
  return rows.map((row) => rowToProvision(row, (byBatch.get(String(row.id)) ?? []).sort((a, b) => a.email.localeCompare(b.email))));
}

async function setItemState(provisionId: string, emails: string[], state: ProvisionItemState, extra?: { mailboxIds?: Map<string, string>; accountIds?: Map<string, number>; error?: string }): Promise<void> {
  const admin = getAdminClient();
  for (const email of emails) {
    const patch: Record<string, unknown> = { state, updated_at: new Date().toISOString() };
    if (extra?.mailboxIds?.has(email)) patch.mailbox_id = extra.mailboxIds.get(email);
    if (extra?.accountIds?.has(email)) patch.smartlead_account_id = extra.accountIds.get(email);
    if (extra?.error !== undefined) patch.error = extra.error;
    const res = await admin.from("zapmail_provision_items").update(patch).eq("provision_id", provisionId).eq("email", email);
    if (res.error) throw new Error(res.error.message);
  }
}

async function setBatch(provisionId: string, patch: Record<string, unknown>): Promise<void> {
  const res = await getAdminClient().from("zapmail_provisions").update({ ...patch, updated_at: new Date().toISOString() }).eq("id", provisionId);
  if (res.error) throw new Error(res.error.message);
}

/* One clean Slack message per batch to the channels that carry the positive-lead
   reply notifications (enabled slack channels whose category filter includes
   "positive" or is empty = all). Best effort: a Slack failure never blocks the
   pipeline. */
async function sendProvisionSlack(text: string): Promise<void> {
  try {
    const admin = getAdminClient();
    const res = await admin.from("notification_channels").select("target, categories, enabled, channel_type").eq("enabled", true).eq("channel_type", "slack");
    if (res.error) return;
    for (const row of (res.data ?? []) as Record<string, unknown>[]) {
      const categories = Array.isArray(row.categories) ? (row.categories as string[]) : null;
      if (categories && categories.length > 0 && !categories.includes("positive")) continue;
      const url = normalizeWebhookUrl(String(row.target ?? ""));
      if (!url) continue;
      await sendSlackMessage(url, { text });
    }
  } catch {
    // Never let a notification failure interrupt provisioning.
  }
}

export async function createZapmailProvision(input: {
  provider: string;
  imageUrl: string | null;
  exportAccountId: string | null;
  notify: boolean;
  warmupDays: number;
  createdBy: string;
  items: { email: string; domainName: string }[];
}): Promise<string> {
  const admin = getAdminClient();
  const batch = await admin.from("zapmail_provisions").insert({
    provider: input.provider,
    image_url: input.imageUrl,
    export_account_id: input.exportAccountId,
    notify: input.notify,
    warmup_days: input.warmupDays,
    created_by: input.createdBy,
  }).select("id").single();
  if (batch.error) throw new Error(batch.error.message);
  const provisionId = String((batch.data as { id: string }).id);
  const rows = input.items.map((item) => ({
    provision_id: provisionId,
    email: item.email.toLowerCase(),
    domain_name: item.domainName.toLowerCase(),
  }));
  const items = await admin.from("zapmail_provision_items").insert(rows);
  if (items.error) throw new Error(items.error.message);
  return provisionId;
}

/* ── The cron tick ────────────────────────────────────────────────────────── */

export async function processZapmailProvisions(): Promise<{ watched: number; advanced: string[] }> {
  const advanced: string[] = [];
  const open = await loadProvisions(["watching", "exporting", "configuring"]);

  // One mailbox listing covers every batch this tick (rate limits are tight).
  // It is also needed when a settled batch still owes profile pictures
  // (image_error set) - otherwise completed batches would end imaging retries
  // the moment the pipeline goes quiet. A transient listing failure skips the
  // phases that need it; the warmup-ready check below runs regardless (it only
  // reads our own tables).
  let needMailboxes = open.length > 0;
  if (!needMailboxes) {
    const owing = await getAdminClient()
      .from("zapmail_provisions")
      .select("id")
      .not("image_error", "is", null)
      .gt("created_at", new Date(Date.now() - IMAGE_RETRY_WINDOW_MS).toISOString())
      .limit(1);
    needMailboxes = !owing.error && (owing.data?.length ?? 0) > 0;
  }
  let byEmail: Map<string, ZapmailMailbox> | null = null;
  if (needMailboxes) {
    try {
      byEmail = new Map((await listZapmailMailboxes()).mailboxes.map((m) => [m.email.toLowerCase(), m]));
    } catch {
      byEmail = null;
    }
  }

  if (byEmail) {
    for (const batch of open) {
      try {
        if (batch.status === "watching") await tickWatching(batch, byEmail, advanced);
        else await tickExporting(batch, advanced);
      } catch (error) {
        // A batch-level error is recorded but never stops the other batches.
        await setBatch(batch.id, { error: (error instanceof Error ? error.message : "provisioning tick failed").slice(0, 300) }).catch(() => {});
      }
    }
    await tickImages(byEmail, advanced).catch(() => {});
  }

  await tickWarmupReady(advanced).catch(() => {});
  return { watched: open.length, advanced };
}

async function tickWatching(batch: ZapmailProvision, byEmail: Map<string, ZapmailMailbox>, advanced: string[]): Promise<void> {
  const mailboxIds = new Map<string, string>();
  const newlyActive: string[] = [];

  for (const item of batch.items) {
    if (item.state !== "pending" && item.state !== "active") continue;
    const mailbox = byEmail.get(item.email);
    if (!mailbox) continue;
    mailboxIds.set(item.email, mailbox.id);
    // An active mailbox is cleared for export immediately ("imaged" is the
    // export-ripe state). The profile picture is applied by tickImages in the
    // background - Zapmail rejects mailbox updates for a while after creation
    // even on ACTIVE mailboxes, and a cosmetic 500 must never stall (or at the
    // deadline, EXPIRE) the Smartlead export.
    if (ACTIVE_RE.test(mailbox.status ?? "")) newlyActive.push(item.email);
  }
  if (newlyActive.length > 0) await setItemState(batch.id, newlyActive, "imaged", { mailboxIds });

  const fresh = await loadProvisions(["watching"]);
  const current = fresh.find((b) => b.id === batch.id);
  if (!current) return;
  const imaged = current.items.filter((i) => i.state === "imaged");
  const unresolved = current.items.filter((i) => i.state === "pending" || i.state === "active");
  const pastDeadline = Date.now() > Date.parse(current.deadlineAt);

  if (unresolved.length > 0 && !pastDeadline) return; // keep watching

  if (imaged.length === 0) {
    // Nothing ever activated by the deadline: give up loudly.
    await setItemState(current.id, unresolved.map((i) => i.email), "failed", { error: "not active by the deadline" });
    await setBatch(current.id, { status: "expired", error: "No mailbox became active before the deadline." });
    if (current.notify) {
      await sendProvisionSlack(`:warning: Zapmail provisioning expired: none of ${current.items.length} inboxes became active within 48h (${escapeSlackText(current.items.map((i) => i.email).join(", "))}).`);
      await setBatch(current.id, { notified_at: new Date().toISOString() });
    }
    advanced.push(`${current.id}:expired`);
    return;
  }

  if (unresolved.length > 0) {
    // Past the deadline with a partial batch: flag the stragglers, ship the rest.
    await setItemState(current.id, unresolved.map((i) => i.email), "failed", { error: "not active by the deadline" });
  }

  // The batch's domains are settled at this point: apply the workspace default
  // forwarding once, so every sending domain redirects without manual setup.
  await applyDefaultForwarding([...new Set(current.items.map((i) => i.domainName))]);

  if (!current.exportAccountId) {
    await setItemState(current.id, imaged.map((i) => i.email), "review");
    await setBatch(current.id, { status: "review" });
    advanced.push(`${current.id}:review(no-export)`);
    return;
  }

  const ids = imaged.map((i) => i.mailboxId).filter((id): id is string => Boolean(id));
  const { exportId } = await exportMailboxesToSmartlead(ids, current.exportAccountId);
  await setItemState(current.id, imaged.map((i) => i.email), "exported");
  await setBatch(current.id, { status: "exporting", export_id: exportId });
  advanced.push(`${current.id}:exporting`);
}

/* Point the given domains' website redirect at the workspace default. One-shot
   per batch (called at the watching -> exporting/review transition); domains
   already forwarding to the target are skipped, and a failure is swallowed -
   the review card's manual control remains the fallback. */
async function applyDefaultForwarding(domainNames: string[]): Promise<void> {
  try {
    const target = (await getInboxProvisioningConfig()).forwardingDomain.trim();
    if (!target) return;
    const wanted = new Set(domainNames.map((d) => d.toLowerCase()));
    const owned = await listOwnedDomains();
    const ids = owned
      .filter((domain) => wanted.has(domain.domain.toLowerCase()))
      .filter((domain) => (domain.forwardTo ?? "").replace(/^https?:\/\//, "").replace(/\/$/, "").toLowerCase() !== target.replace(/^https?:\/\//, "").replace(/\/$/, "").toLowerCase())
      .map((domain) => domain.id);
    if (ids.length > 0) await setDomainForwarding(ids, target);
  } catch {
    // Best effort; the operator can set forwarding from the review card.
  }
}

async function tickExporting(batch: ZapmailProvision, advanced: string[]): Promise<void> {
  const waiting = batch.items.filter((i) => i.state === "exported");
  if (waiting.length > 0) {
    // Ground truth is the account existing in Smartlead, not the export-status
    // string (its vocabulary is undocumented).
    const accounts = await listInboxAccounts();
    const byEmail = new Map(accounts.map((a) => [a.fromEmail.toLowerCase(), a]));
    for (const item of waiting) {
      const account = byEmail.get(item.email);
      if (!account) continue;
      // Apply the operator defaults the moment the account lands. Failures leave
      // the item in 'exported' so the next tick retries.
      try {
        await updateInboxDailyLimit(account.id, DEFAULT_DAILY_LIMIT);
        await updateInboxWarmup(account.id, {
          enabled: true,
          totalPerDay: DEFAULT_WARMUP_PER_DAY,
          replyRatePercent: DEFAULT_WARMUP_REPLY_RATE,
          warmupKey: generateWarmupTag(),
        });
        await setItemState(batch.id, [item.email], "review", { accountIds: new Map([[item.email, account.id]]) });
      } catch (error) {
        await setItemState(batch.id, [item.email], "exported", { error: (error instanceof Error ? error.message : "settings failed").slice(0, 200) });
      }
    }
  }

  const fresh = await loadProvisions(["exporting", "configuring"]);
  const current = fresh.find((b) => b.id === batch.id);
  if (!current) return;
  const stillWaiting = current.items.filter((i) => i.state === "exported");
  const landed = current.items.filter((i) => i.state === "review" || i.state === "approved");
  const exportStarted = Date.parse(current.createdAt); // upper bound; deadline covers the watch phase
  const waitedOut = Date.now() > Math.max(exportStarted, Date.parse(current.deadlineAt)) + EXPORT_WAIT_MS;

  if (stillWaiting.length > 0 && !waitedOut) return;

  if (stillWaiting.length > 0) {
    await setItemState(current.id, stillWaiting.map((i) => i.email), "failed", { error: "never appeared in Smartlead after export" });
  }
  // The review flip is also warmup start: every landed account had its warmup
  // enabled just above. The timestamp anchors the campaign-ready notification
  // (warmup_started_at + warmup_days); a batch where nothing landed never warms.
  await setBatch(current.id, {
    status: "review",
    ...(landed.length > 0 && !current.warmupStartedAt ? { warmup_started_at: new Date().toISOString() } : {}),
  });
  advanced.push(`${current.id}:review`);

  if (current.notify && !current.error) {
    const failed = current.items.filter((i) => i.state === "failed");
    const domains = [...new Set(current.items.map((i) => i.domainName))].join(", ");
    const lines = [
      `:mailbox_with_mail: ${landed.length} new ${landed.length === 1 ? "inbox" : "inboxes"} on ${escapeSlackText(domains)} ${landed.length === 1 ? "is" : "are"} live in Smartlead`,
      `Warmup on (${DEFAULT_WARMUP_PER_DAY}/day, ${DEFAULT_WARMUP_REPLY_RATE}% replies), sending limit ${DEFAULT_DAILY_LIMIT}/day.`,
      `They stay warming for ${warmupPeriodPhrase(current.warmupDays)} - you'll get a ping here when the batch is campaign-ready.`,
      `Review and approve them in the Inboxes tab.`,
      ...(failed.length ? [`:warning: ${failed.length} did not make it: ${escapeSlackText(failed.map((i) => i.email).join(", "))}`] : []),
    ];
    await sendProvisionSlack(lines.join("\n"));
    await setBatch(current.id, { notified_at: new Date().toISOString() });
  }
}

/* ── Background imaging (never blocks the export pipeline) ────────────────
   Zapmail's PUT /v1/mailbox/update went down platform-wide on 2026-07-17 (500s
   even on a no-op update to a months-old mailbox the same endpoint updated on
   7/12), so this retries every tick for any batch with an image until every
   surviving mailbox has a picture. The window is 90 days from batch creation
   (raised from 30 on 2026-08-12: the outage had run 26 days and the first
   batches were 4 days from silently aging out) - long enough to ride out a
   Zapmail outage and apply pictures the moment their endpoint recovers,
   without retrying dead batches forever. The last failure is recorded on the
   batch (image_error) so the review card can say "still retrying" instead of
   stalling silently. */
const IMAGE_RETRY_WINDOW_MS = 90 * 24 * 3600_000;

async function tickImages(byEmail: Map<string, ZapmailMailbox>, advanced: string[]): Promise<void> {
  const admin = getAdminClient();
  const res = await admin
    .from("zapmail_provisions")
    .select("id, image_url, image_error")
    .not("image_url", "is", null)
    .in("status", ["watching", "exporting", "configuring", "review", "complete"])
    .gt("created_at", new Date(Date.now() - IMAGE_RETRY_WINDOW_MS).toISOString());
  if (res.error || !res.data?.length) return;
  const batches = res.data as { id: string; image_url: string; image_error: string | null }[];
  const items = await admin
    .from("zapmail_provision_items")
    .select("provision_id, email, state")
    .in("provision_id", batches.map((b) => b.id));
  if (items.error) return;
  const byBatch = new Map<string, { email: string; state: string }[]>();
  for (const row of (items.data ?? []) as { provision_id: string; email: string; state: string }[]) {
    if (!byBatch.has(row.provision_id)) byBatch.set(row.provision_id, []);
    byBatch.get(row.provision_id)!.push(row);
  }

  for (const batch of batches) {
    const missing = (byBatch.get(batch.id) ?? [])
      .filter((item) => item.state !== "failed")
      .map((item) => byEmail.get(item.email.toLowerCase()))
      .filter((m): m is ZapmailMailbox => Boolean(m && ACTIVE_RE.test(m.status ?? "") && !m.profilePicture));
    if (missing.length === 0) {
      // Everything that can carry a picture has one; clear a stale error note.
      if (batch.image_error) await setBatch(batch.id, { image_error: null }).catch(() => {});
      continue;
    }
    try {
      await updateZapmailMailboxes(missing.map((m) => ({ mailboxId: m.id, profilePicture: batch.image_url })));
      await setBatch(batch.id, { image_error: null }).catch(() => {});
      advanced.push(`${batch.id}:imaged(${missing.length})`);
    } catch (error) {
      const message = error instanceof Error ? error.message : "image update failed";
      await setBatch(batch.id, { image_error: message.slice(0, 300) }).catch(() => {});
    }
  }
}

/* ── Campaign-ready notification ──────────────────────────────────────────
   Once a batch's warmup window (warmup_started_at + warmup_days) has elapsed,
   send ONE Slack message. Claim-then-send: the notified_at stamp is written
   atomically first (conditioned on it still being null), so overlapping cron
   runs can never double-post; a Slack outage after a claim costs at most that
   one message, which the review card still shows as ready. */
async function tickWarmupReady(advanced: string[]): Promise<void> {
  const admin = getAdminClient();
  const res = await admin
    .from("zapmail_provisions")
    .select("id, notify, warmup_days, warmup_started_at")
    .in("status", ["review", "complete"])
    .not("warmup_started_at", "is", null)
    .is("warmup_ready_notified_at", null);
  if (res.error || !res.data?.length) return;

  for (const row of res.data as { id: string; notify: boolean; warmup_days: number; warmup_started_at: string }[]) {
    const days = Number(row.warmup_days ?? DEFAULT_WARMUP_PERIOD_DAYS);
    const started = Date.parse(row.warmup_started_at);
    if (!Number.isFinite(started) || Date.now() < started + days * 86_400_000) continue;

    const claim = await admin
      .from("zapmail_provisions")
      .update({ warmup_ready_notified_at: new Date().toISOString(), updated_at: new Date().toISOString() })
      .eq("id", row.id)
      .is("warmup_ready_notified_at", null)
      .select("id");
    if (claim.error || !claim.data?.length) continue; // another run claimed it

    if (!row.notify) continue;
    const items = await admin
      .from("zapmail_provision_items")
      .select("email, domain_name, state")
      .eq("provision_id", row.id)
      .in("state", ["review", "approved"]);
    const landed = (items.data ?? []) as { email: string; domain_name: string }[];
    if (items.error || landed.length === 0) continue;

    const domains = [...new Set(landed.map((i) => i.domain_name))];
    const domainNote = domains.length <= 5 ? ` (${escapeSlackText(domains.join(", "))})` : "";
    await sendProvisionSlack(
      `:rocket: Inbox batch campaign-ready: ${landed.length} ${landed.length === 1 ? "inbox" : "inboxes"} across ${domains.length} ${domains.length === 1 ? "domain" : "domains"}${domainNote} finished the ${warmupPeriodLabel(days)} warmup window and can join campaigns.`,
    );
    advanced.push(`${row.id}:warmup-ready`);
  }
}

/* ── Per-inbox warmup plan (for the Inboxes page) ─────────────────────────
   Maps inbox email -> the warmup window its provision batch was bought with.
   Display code prefers Smartlead's own warmup_created_at for the start (it is
   per-account truth); the batch startedAt is the fallback, and batches created
   later win if an email ever reappears. */
export type InboxWarmupPlan = { days: number; startedAt: string | null };

export async function getWarmupPlansByEmail(): Promise<Record<string, InboxWarmupPlan>> {
  const admin = getAdminClient();
  const batches = await admin
    .from("zapmail_provisions")
    .select("id, warmup_days, warmup_started_at, created_at")
    .in("status", ["watching", "exporting", "configuring", "review", "complete"])
    .order("created_at", { ascending: true });
  if (batches.error || !batches.data?.length) return {};
  const rows = batches.data as { id: string; warmup_days: number; warmup_started_at: string | null }[];
  const items = await admin
    .from("zapmail_provision_items")
    .select("provision_id, email")
    .in("provision_id", rows.map((r) => r.id));
  if (items.error) return {};
  const byId = new Map(rows.map((r) => [r.id, r]));
  const plans: Record<string, InboxWarmupPlan> = {};
  for (const item of (items.data ?? []) as { provision_id: string; email: string }[]) {
    const batch = byId.get(item.provision_id);
    if (!batch) continue;
    plans[item.email.toLowerCase()] = {
      days: Number(batch.warmup_days ?? DEFAULT_WARMUP_PERIOD_DAYS),
      startedAt: batch.warmup_started_at,
    };
  }
  return plans;
}

/* ── Review surface ───────────────────────────────────────────────────────── */

export async function listProvisionsForReview(): Promise<ZapmailProvision[]> {
  const provisions = await loadProvisions(["watching", "exporting", "configuring", "review", "expired", "error", "complete"]);
  /* A complete batch normally needs no attention, but profile pictures can
     still be retrying after completion (imageError) — keep those visible so
     the stall is never silent. */
  return provisions.filter((p) => p.status !== "complete" || p.imageError !== null);
}

export async function approveProvisionItems(provisionId: string, emails: string[]): Promise<void> {
  await setItemState(provisionId, emails.map((e) => e.toLowerCase()), "approved");
  const fresh = await loadProvisions(["review", "expired", "error"]);
  const current = fresh.find((b) => b.id === provisionId);
  if (current && current.items.every((i) => i.state === "approved" || i.state === "failed")) {
    await setBatch(provisionId, { status: "complete" });
  }
}

export async function dismissProvision(provisionId: string): Promise<void> {
  await setBatch(provisionId, { status: "complete" });
}
