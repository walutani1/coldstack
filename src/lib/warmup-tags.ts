import "server-only";

import { randomInt } from "node:crypto";
import { getAdminClient } from "@/lib/supabase/admin";
import { listInboxAccounts, updateInboxWarmup } from "@/lib/smartlead";

/**
 * Warmup identifier tags. Smartlead stamps this tag on every warmup email so
 * its filters can recognize warmup traffic; a static tag is also a fingerprint
 * spam filters can learn, which is why tags rotate. The API accepts any
 * string (live-verified), but Smartlead's own generator uses two five-letter
 * words joined by a hyphen ("group-broth", "apple-juice") — generated tags
 * match that shape so they are indistinguishable from native ones.
 */

// Neutral, common five-letter words — nothing salesy or spam-adjacent.
const FIVE_LETTER_WORDS = [
  "amber", "apple", "aspen", "badge", "bagel", "basil", "beach", "birch",
  "blaze", "bloom", "brave", "brick", "brook", "broth", "candy", "cedar",
  "chalk", "charm", "chess", "cider", "clear", "cliff", "cloud", "coral",
  "creek", "crest", "crisp", "daisy", "dance", "dawns", "delta", "diner",
  "dough", "dunes", "eagle", "early", "earth", "ember", "fable", "fence",
  "ferns", "field", "flame", "flint", "flute", "frost", "gears", "glade",
  "gleam", "globe", "grain", "grape", "grass", "grove", "haven", "hazel",
  "heath", "hedge", "hills", "honey", "index", "ivory", "jelly", "juice",
  "kites", "lakes", "lemon", "light", "lilac", "linen", "lodge", "lunar",
  "maple", "marsh", "meads", "mints", "mocha", "mural", "north", "notch",
  "oasis", "ocean", "olive", "onion", "orbit", "otter", "paint", "palms",
  "pearl", "pecan", "petal", "piano", "pines", "plaza", "plums", "polar",
  "ponds", "prism", "quail", "quill", "raven", "reeds", "ridge", "river",
  "roast", "robin", "salsa", "sands", "shade", "shell", "shore", "slate",
  "smile", "solar", "spice", "sprig", "stone", "storm", "swans", "swirl",
  "syrup", "table", "tides", "tiger", "toast", "torch", "trail", "tulip",
  "vines", "wagon", "wafer", "waves", "wheat", "woods", "zesty",
];

export const WARMUP_TAG_PATTERN = /^[a-z]{3,12}-[a-z]{3,12}$/;

const GENERATED_WORDS = new Set(FIVE_LETTER_WORDS);
const TAG_TOKEN = /(?:^|[^a-z-])([a-z]{3,12})-([a-z]{3,12})(?![a-z-])/g;

/**
 * Find a warmup identifier tag inside message text. A token counts when it is
 * one of the live account tags (catches Smartlead-native tags we didn't
 * generate) or when both words come from the generator's word list (catches
 * rotated-out tags still arriving in flight). Shape alone is never enough —
 * ordinary hyphenated words ("long-term") share it.
 */
export function findWarmupTag(text: string, liveTags: ReadonlySet<string>): string | null {
  const haystack = text.toLowerCase();
  for (const tag of liveTags) {
    if (tag.length >= 5 && haystack.includes(tag)) return tag;
  }
  for (const match of haystack.matchAll(TAG_TOKEN)) {
    if (GENERATED_WORDS.has(match[1]) && GENERATED_WORDS.has(match[2])) return `${match[1]}-${match[2]}`;
  }
  return null;
}

export function generateWarmupTag(exclude?: string | null): string {
  let tag = "";
  // Re-roll on the (unlikely) doubled word or a collision with the current tag.
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const first = FIVE_LETTER_WORDS[randomInt(FIVE_LETTER_WORDS.length)];
    const second = FIVE_LETTER_WORDS[randomInt(FIVE_LETTER_WORDS.length)];
    tag = `${first}-${second}`;
    if (first !== second && tag !== exclude) return tag;
  }
  return tag;
}

/* ── Rotation schedule state (app_settings, same pattern as settings-store) ── */

const ROTATION_KEY = "warmup_tag_rotation";

export type WarmupRotationState = {
  enabled: boolean;
  intervalDays: number;
  /** COMPLETION time of the last successful rotation — what the UI shows. */
  lastRotatedAt: string | null;
  /** Time the last run CLAIMED its slot (set before rotating). Drives the
      due-check so a crashed run doesn't re-fire every cron tick, without
      masquerading as a successful rotation in the UI. */
  claimedAt: string | null;
  lastSummary: { rotated: number; failed: number; skipped: number; at: string } | null;
};

export const DEFAULT_ROTATION_STATE: WarmupRotationState = {
  enabled: false,
  intervalDays: 14,
  lastRotatedAt: null,
  claimedAt: null,
  lastSummary: null,
};

function parseRotationState(value: unknown): WarmupRotationState {
  const raw = value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  const interval = Number(raw.intervalDays);
  const summary =
    raw.lastSummary && typeof raw.lastSummary === "object" && !Array.isArray(raw.lastSummary)
      ? (raw.lastSummary as Record<string, unknown>)
      : null;
  return {
    enabled: raw.enabled === true,
    intervalDays: Number.isInteger(interval) && interval >= 1 && interval <= 90 ? interval : 14,
    lastRotatedAt: typeof raw.lastRotatedAt === "string" && raw.lastRotatedAt ? raw.lastRotatedAt : null,
    claimedAt: typeof raw.claimedAt === "string" && raw.claimedAt ? raw.claimedAt : null,
    lastSummary: summary
      ? {
          rotated: Number(summary.rotated) || 0,
          failed: Number(summary.failed) || 0,
          skipped: Number(summary.skipped) || 0,
          at: typeof summary.at === "string" ? summary.at : "",
        }
      : null,
  };
}

export async function getWarmupRotationState(): Promise<WarmupRotationState> {
  try {
    const { data, error } = await getAdminClient()
      .from("app_settings")
      .select("value")
      .eq("key", ROTATION_KEY)
      .maybeSingle();
    if (error || !data) return { ...DEFAULT_ROTATION_STATE };
    return parseRotationState(data.value);
  } catch {
    return { ...DEFAULT_ROTATION_STATE };
  }
}

async function writeRotationState(state: WarmupRotationState): Promise<void> {
  const { error } = await getAdminClient()
    .from("app_settings")
    .upsert({ key: ROTATION_KEY, value: state }, { onConflict: "key" });
  if (error) throw new Error(`Could not save warmup rotation settings: ${error.message}`);
}

export async function setWarmupRotationEnabled(enabled: boolean): Promise<WarmupRotationState> {
  const current = await getWarmupRotationState();
  const next = { ...current, enabled };
  await writeRotationState(next);
  return next;
}

/* ── The rotation itself ─────────────────────────────────────────────── */

export type RotationResult = {
  rotated: { email: string; tag: string }[];
  failed: { email: string; message: string }[];
  skipped: number; // warmup-disabled or blocked accounts
};

/**
 * Give warmup-active inboxes a fresh identifier tag — every one, or only the
 * requested accountIds. Preserves each account's current warmup volume and
 * reply rate (the endpoint requires the full settings body). Blocked or
 * warmup-less accounts are skipped.
 */
export async function rotateAllWarmupTags(accountIds?: number[]): Promise<RotationResult> {
  const accounts = await listInboxAccounts();
  const result: RotationResult = { rotated: [], failed: [], skipped: 0 };

  const requested = accountIds && accountIds.length > 0 ? new Set(accountIds) : null;
  const scoped = requested ? accounts.filter((account) => requested.has(account.id)) : accounts;
  // Mirrors the UI's own "warming" definition (anything not PAUSED counts) so
  // an unusual status value is never silently skipped while showing as enabled.
  const eligible = scoped.filter(
    (account) =>
      account.warmup && !account.warmup.isBlocked && account.warmup.status?.toUpperCase() !== "PAUSED",
  );
  result.skipped = scoped.length - eligible.length;

  // Sequential with a small gap — 20+ rapid warmup writes would trip
  // Smartlead's request-rate ceiling.
  for (const account of eligible) {
    const warmup = account.warmup!;
    const tag = generateWarmupTag(warmup.warmupKey);
    try {
      await updateInboxWarmup(account.id, {
        enabled: true,
        totalPerDay: warmup.warmupMaxCount ?? 15,
        replyRatePercent: warmup.replyRatePercent ?? 27,
        warmupKey: tag,
      });
      result.rotated.push({ email: account.fromEmail, tag });
    } catch (error) {
      result.failed.push({
        email: account.fromEmail,
        message: error instanceof Error ? error.message.slice(0, 200) : "Unknown error",
      });
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  return result;
}

async function recordRotation(result: RotationResult): Promise<WarmupRotationState> {
  const current = await getWarmupRotationState();
  const at = new Date().toISOString();
  const next: WarmupRotationState = {
    ...current,
    lastRotatedAt: at,
    lastSummary: {
      rotated: result.rotated.length,
      failed: result.failed.length,
      skipped: result.skipped,
      at,
    },
  };
  await writeRotationState(next);
  return next;
}

export async function rotateAllWarmupTagsNow(
  accountIds?: number[],
): Promise<{ result: RotationResult; state: WarmupRotationState }> {
  const result = await rotateAllWarmupTags(accountIds);
  // Selective rotations don't reset the automatic schedule — only a full
  // rotation counts as "everything is fresh".
  const state = accountIds && accountIds.length > 0 ? await getWarmupRotationState() : await recordRotation(result);
  return { result, state };
}

/**
 * Cron hook: rotate when enabled and due. The slot is claimed (claimedAt)
 * before rotating so back-to-back cron ticks don't re-fire; this is a
 * read-then-write guard, not an atomic compare-and-set — truly concurrent
 * runs are benign anyway (sequential per-inbox writes, last tag wins).
 * lastRotatedAt only advances on COMPLETION, so a crashed run never shows
 * as a successful rotation in the UI.
 */
export async function maybeRotateWarmupTags(): Promise<
  { ran: false; reason: string } | { ran: true; result: RotationResult }
> {
  const state = await getWarmupRotationState();
  if (!state.enabled) return { ran: false, reason: "disabled" };
  const completed = state.lastRotatedAt ? Date.parse(state.lastRotatedAt) : 0;
  const claimed = state.claimedAt ? Date.parse(state.claimedAt) : 0;
  const last = Math.max(Number.isFinite(completed) ? completed : 0, Number.isFinite(claimed) ? claimed : 0);
  const dueAt = last + state.intervalDays * 24 * 60 * 60 * 1000;
  if (Date.now() < dueAt) return { ran: false, reason: "not due" };

  await writeRotationState({ ...state, claimedAt: new Date().toISOString() });
  const result = await rotateAllWarmupTags();
  await recordRotation(result);
  return { ran: true, result };
}
