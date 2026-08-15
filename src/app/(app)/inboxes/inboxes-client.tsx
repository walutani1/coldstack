"use client";

import {
  startTransition as startBackground,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useTransition,
  type ReactNode,
} from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  Activity,
  AlertTriangle,
  ArrowDownWideNarrow,
  ArrowRight,
  ArrowUpNarrowWide,
  Ban,
  Check,
  CheckCircle2,
  CheckSquare,
  ChevronDown,
  ClipboardList,
  Dices,
  AtSign,
  Globe,
  ImageOff,
  Loader2,
  Minus,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  ShoppingBag,
  X,
  XCircle,
} from "lucide-react";
import {
  bulkSetWarmupEnabledAction,
  bulkUpdateDailyLimitAction,
  getInboxCampaignMapAction,
  getInboxWarmupStatsAction,
  getWarmupRotationAction,
  getWorkspaceSendStatsAction,
  getWorkspaceWarmupSeriesAction,
  rotateWarmupTagsNowAction,
  runInboxHealthAction,
  runWorkspaceHealthAction,
  setWarmupRotationAction,
  updateInboxDailyLimitAction,
  updateInboxIdentityAction,
  updateInboxWarmupAction,
} from "./actions";
import { addCampaignInboxesAction, removeCampaignInboxesAction } from "../campaigns/actions";
import { SkeletonChart } from "@/app/(app)/skeletons";
import { ZapmailFlow } from "./zapmail-client";
import { DomainsView } from "./domains-client";
import {
  approveZapmailProvisionAction,
  dismissZapmailProvisionAction,
  listZapmailProvisionsAction,
  processZapmailProvisionsNowAction,
  setZapmailDomainForwardingAction,
} from "./zapmail-actions";
import type { ZapmailProvision } from "@/lib/zapmail-provisions";
import { useToast } from "../toast";

/* ── Contract mirrors (declared locally so the client never imports a server
   module — same pattern as campaigns-client / settings-client). ─────────── */
type InboxWarmup = {
  status: string | null;
  reputation: number | null;
  totalSentCount: number;
  totalSpamCount: number;
  replyRatePercent: number | null;
  maxEmailPerDay: number | null;
  warmupMaxCount: number | null;
  warmupMinCount: number | null;
  warmupKey: string | null;
  isBlocked: boolean;
  blockedReason: string | null;
  warmupCreatedAt: string | null;
};
export type InboxAccount = {
  id: number;
  fromName: string;
  signature: string;
  bcc: string;
  timeToWaitMins: number | null;
  createdAt: string | null;
  fromEmail: string;
  provider: string | null;
  messagePerDay: number | null;
  dailySentCount: number;
  smtpOk: boolean;
  imapOk: boolean;
  smtpError: string | null;
  imapError: string | null;
  customTrackingDomain: string | null;
  isSuspended: boolean;
  tags: string[];
  warmup: InboxWarmup | null;
};
// Sending-identity patch mirror — matches updateInboxIdentityAction's server
// arg (lib InboxIdentityPatch). Only the changed fields ride along on a save.
// Note the asymmetry the lib itself carries: reads expose customTrackingDomain,
// the write field is customTrackingUrl.
type InboxIdentityPatch = {
  fromName?: string;
  signature?: string;
  bcc?: string;
  customTrackingUrl?: string;
  timeToWaitMins?: number;
};
type InboxWarmupStats = {
  sentCount: number;
  spamCount: number;
  inboxCount: number;
  receivedCount: number;
  byDate: { date: string; sentCount: number; replyCount: number; saveFromSpamCount: number }[];
};
type CampaignInboxMapEntry = {
  campaignId: string;
  name: string;
  status: string;
  accountIds: number[];
};
// Client-side warmup override — the shape the per-inbox warmup save produces,
// mirrored so a save can update the detail without refetching the whole roster.
// Warmup tags are an org-level control managed from the Tag Manager, so they
// never ride along on a per-inbox settings save.
type WarmupOverride = {
  enabled: boolean;
  totalPerDay: number;
  replyRatePercent: number;
};

// Workspace-wide warmup-tag rotation state (mirrored from the rotation actions).
type WarmupRotationState = {
  enabled: boolean;
  intervalDays: number;
  lastRotatedAt: string | null;
  claimedAt: string | null;
  lastSummary: { rotated: number; failed: number; skipped: number; at: string } | null;
};
type WorkspaceSendStats = { sent: number; replies: number; bounces: number; campaigns: number; days: number };

// Warmup-tag shape enforced by the Tag Manager's per-inbox input: two lowercase
// words (3–12 letters each) joined by a hyphen, e.g. group-broth.
const WARMUP_TAG_PATTERN = /^[a-z]{3,12}-[a-z]{3,12}$/;

// Overlay a saved override onto the server warmup shape so the card reflects the
// new status/limit/reply-rate immediately (and materialises a warmup object for
// an inbox that had none once warmup is enabled).
function applyWarmupOverride(warmup: InboxWarmup | null, override: WarmupOverride | undefined): InboxWarmup | null {
  if (!override) return warmup;
  const base: InboxWarmup = warmup ?? {
    status: null,
    reputation: null,
    totalSentCount: 0,
    totalSpamCount: 0,
    replyRatePercent: null,
    maxEmailPerDay: null,
    warmupMaxCount: null,
    warmupMinCount: null,
    warmupKey: null,
    isBlocked: false,
    blockedReason: null,
    warmupCreatedAt: null,
  };
  return {
    ...base,
    status: override.enabled ? "ACTIVE" : "PAUSED",
    warmupMaxCount: override.totalPerDay,
    replyRatePercent: override.replyRatePercent,
  };
}

// Overlay a saved identity patch onto the account so the detail header (and any
// re-seed of the identity form on reopen) reflects the new values without a
// refetch — the same override idiom the daily-limit save uses. Only fields the
// patch carries are touched; a cleared tracking domain reads back as None.
function applyIdentityOverride(inbox: InboxAccount, patch: InboxIdentityPatch | undefined): InboxAccount {
  if (!patch) return inbox;
  return {
    ...inbox,
    ...(patch.fromName !== undefined ? { fromName: patch.fromName } : {}),
    ...(patch.signature !== undefined ? { signature: patch.signature } : {}),
    ...(patch.bcc !== undefined ? { bcc: patch.bcc } : {}),
    ...(patch.customTrackingUrl !== undefined
      ? { customTrackingDomain: patch.customTrackingUrl.trim() || null }
      : {}),
    ...(patch.timeToWaitMins !== undefined ? { timeToWaitMins: patch.timeToWaitMins } : {}),
  };
}
type CheckStatus = "pass" | "warn" | "fail" | "skip";
type HealthCheck = { key: string; label: string; status: CheckStatus; detail: string; fix: string | null };
type HealthCategory = {
  key: "connection" | "authentication" | "warmup" | "volume";
  label: string;
  checks: HealthCheck[];
};
type HealthReport = {
  accountId: number;
  email: string;
  domain: string;
  score: number;
  grade: "healthy" | "attention" | "risk";
  categories: HealthCategory[];
  checkedAt: string;
};

/* ── Shared style constants (copied conventions, intentionally not shared) ── */

const BTN_BASE = `inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-md font-medium transition disabled:cursor-not-allowed disabled:opacity-50`;
const BTN_PRIMARY = `${BTN_BASE} bg-primary text-primary-foreground shadow-xs hover:opacity-90`;
const BTN_OUTLINE = `${BTN_BASE} border border-border bg-surface text-foreground shadow-xs hover:border-border-strong hover:bg-muted/60`;
const BTN_SUBTLE = `${BTN_BASE} bg-transparent text-muted-foreground hover:bg-muted/70 hover:text-foreground`;

const INPUT_CLASS =
  "h-8 w-full rounded-md border border-border bg-surface px-2.5 text-[12.5px] text-foreground shadow-xs outline-none transition placeholder:text-muted-foreground focus:border-ring";

/* ── Presentation helpers ─────────────────────────────────────────────── */
function domainOf(email: string): string {
  const at = email.lastIndexOf("@");
  return at >= 0 ? email.slice(at + 1).toLowerCase() : email.toLowerCase();
}

function titleCaseProvider(provider: string): string {
  return provider
    .split(/[\s_-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(" ");
}

// Deterministic group-header accent hues. Six desaturated, mid-lightness tints
// picked so the little marker reads clearly on both the light (#f7f7f6) and the
// dark (#0a0a0a) column background without ever coloring a whole row. The hue is
// stable per group: the same group name always hashes to the same slot.
const GROUP_HUES = [
  "#5c7aa6", // slate blue
  "#4f9c86", // muted teal
  "#a67c4f", // muted ochre
  "#8a6fb0", // muted violet
  "#b06f89", // muted rose
  "#4f8fa6", // muted cyan
] as const;

function groupHue(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i += 1) {
    hash = (hash * 31 + name.charCodeAt(i)) | 0;
  }
  return GROUP_HUES[Math.abs(hash) % GROUP_HUES.length];
}

// Warmup reputation thresholds — the single source of the badge treatment on
// this page (campaigns-client keeps its own local copy, per the brief).
function reputationBadgeClass(value: number | null): string {
  if (value === null) return "bg-muted text-muted-foreground";
  if (value >= 90) return "bg-success-soft text-success";
  if (value >= 75) return "bg-warning-soft text-warning";
  return "bg-destructive-soft text-destructive";
}

/* A reputation counts only after warmup traffic exists: Smartlead reports a
   flat 0 for a freshly added account (zero warmup history), which would render
   as a failing mailbox and drag every average down when it actually means
   "warmup has not started yet". The roster LIST endpoint always reports
   total_sent_count as 0 (live-verified - only the per-account stats endpoint
   fills it), so the signal is reputation === 0 itself: a warmup with real
   history never computes to a flat zero. All score reads go through this. */
function effectiveReputation(warmup: InboxAccount["warmup"]): number | null {
  if (!warmup || warmup.reputation === null) return null;
  if (warmup.reputation === 0) return null;
  return warmup.reputation;
}
function warmupPending(warmup: InboxAccount["warmup"]): boolean {
  return Boolean(warmup && warmup.reputation === 0 && warmup.status?.toUpperCase() !== "PAUSED");
}

/* ── Warmup timeline (how long an inbox has been warming) ────────────────
   Start: Smartlead's own warmup_created_at (per-account truth), then the
   provision batch's warmup start, then account creation as a weak last resort.
   Window: the batch's purchase-time choice, else the two-week house default.
   An inbox is "campaign-ready" once the window has fully elapsed. */
const DEFAULT_WARMUP_PERIOD_DAYS = 14;
export type InboxWarmupPlan = { days: number; startedAt: string | null };
type WarmupTimeline = { day: number; totalDays: number; ready: boolean; startedAtMs: number; readyAtMs: number };

function warmupTimeline(inbox: InboxAccount, plan: InboxWarmupPlan | undefined): WarmupTimeline | null {
  if (!inbox.warmup) return null;
  const started = inbox.warmup.warmupCreatedAt ?? plan?.startedAt ?? inbox.createdAt;
  const startedAtMs = started ? Date.parse(started) : Number.NaN;
  if (!Number.isFinite(startedAtMs)) return null;
  const totalDays = plan?.days ?? DEFAULT_WARMUP_PERIOD_DAYS;
  const elapsedDays = Math.floor((Date.now() - startedAtMs) / 86_400_000);
  return {
    day: Math.min(totalDays, Math.max(1, elapsedDays + 1)),
    totalDays,
    ready: elapsedDays >= totalDays,
    startedAtMs,
    readyAtMs: startedAtMs + totalDays * 86_400_000,
  };
}

function formatDay(ms: number, timeZone: string, timeLocale: string): string {
  try {
    return new Intl.DateTimeFormat(timeLocale, { month: "short", day: "numeric", timeZone }).format(ms);
  } catch {
    return new Date(ms).toDateString();
  }
}

function ReputationBadge({ value, pending }: { value: number | null; pending?: boolean }) {
  return (
    <span
      data-tip={pending ? "Warmup has not started yet - the score appears once warmup emails flow" : "Warmup reputation"}
      data-tip-down=""
      className={`shrink-0 rounded px-1.5 py-px text-[10px] font-semibold tabular-nums ${pending ? "bg-muted text-muted-foreground" : reputationBadgeClass(value)}`}
    >
      {pending ? "Warmup pending" : value === null ? "—" : value}
    </span>
  );
}

// Detail dual dots — one per protocol, each with its own error tooltip.
function ConnDot({ label, ok, error }: { label: string; ok: boolean; error: string | null }) {
  return (
    <span
      data-tip={ok ? `${label} connected` : `${label} error: ${error?.trim() || "connection failed"}`}
      data-tip-down=""
      className="inline-flex items-center gap-1"
    >
      <span className={`size-1.5 rounded-full ${ok ? "bg-success" : "bg-destructive"}`} aria-hidden />
      <span className="text-[10px] font-medium text-muted-foreground">{label}</span>
    </span>
  );
}

// Row-level single dot — green only when both protocols connect; the title
// lists both states so the collapsed dot never hides an error.
function CombinedConnDot({ inbox }: { inbox: InboxAccount }) {
  const ok = inbox.smtpOk && inbox.imapOk;
  const smtp = inbox.smtpOk ? "SMTP ok" : `SMTP error: ${inbox.smtpError?.trim() || "connection failed"}`;
  const imap = inbox.imapOk ? "IMAP ok" : `IMAP error: ${inbox.imapError?.trim() || "connection failed"}`;
  return (
    <span
      data-tip={`${smtp} · ${imap}`}
      data-tip-down=""
      role="img"
      aria-label={ok ? "Connection healthy" : "Connection issue"}
      className={`size-1.5 shrink-0 rounded-full ${ok ? "bg-success" : "bg-destructive"}`}
    />
  );
}

function StatePill({ label }: { label: string }) {
  return (
    <span className="shrink-0 rounded bg-destructive-soft px-1.5 py-px text-[10px] font-medium text-destructive">
      {label}
    </span>
  );
}

const GRADE_LABEL: Record<HealthReport["grade"], string> = {
  healthy: "Healthy",
  attention: "Needs attention",
  risk: "At risk",
};
const GRADE_BADGE: Record<HealthReport["grade"], string> = {
  healthy: "bg-success-soft text-success",
  attention: "bg-warning-soft text-warning",
  risk: "bg-destructive-soft text-destructive",
};
const GRADE_STROKE: Record<HealthReport["grade"], string> = {
  healthy: "var(--success)",
  attention: "var(--warning)",
  risk: "var(--destructive)",
};

function GradeChip({ grade, score }: { grade: HealthReport["grade"]; score?: number }) {
  return (
    <span className={`inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-px text-[10px] font-semibold ${GRADE_BADGE[grade]}`}>
      {GRADE_LABEL[grade]}
      {score !== undefined ? <span className="tabular-nums opacity-80">{score}</span> : null}
    </span>
  );
}

// Displayed times use the workspace timezone/locale (threaded from settings),
// pinned so server and client render identical strings (no hydration mismatch).
function formatTimestamp(iso: string, timeZone: string, timeLocale: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString(timeLocale, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone,
  });
}

// yyyy-mm-dd day labels for the warmup charts — pinned to UTC so the calendar
// day never shifts under a timezone offset.
function formatDayLabel(dateStr: string, timeLocale: string): string {
  const date = new Date(`${dateStr}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return dateStr;
  return date.toLocaleDateString(timeLocale, { month: "short", day: "numeric", timeZone: "UTC" });
}

function campaignStatusTone(status: string): string {
  const s = status.toUpperCase();
  if (s === "ACTIVE") return "bg-success-soft text-success";
  if (s === "PAUSED") return "bg-warning-soft text-warning";
  return "bg-muted text-muted-foreground";
}

function campaignStatusLabel(status: string): string {
  if (!status.trim()) return "Unknown";
  return status.charAt(0).toUpperCase() + status.slice(1).toLowerCase();
}

type GroupBy = "domain" | "campaign" | "provider" | "none";
type SortKey = "reputation" | "limit" | "replyRate" | "name";
type SortDir = "asc" | "desc";
type Chip = "issues" | "atrisk" | "blocked" | "warming" | "nophoto";
const CHIP_LABEL: Record<Chip, string> = { issues: "Issues", atrisk: "At risk", blocked: "Blocked", warming: "Warming", nophoto: "No photo" };

function sortNumber(
  inbox: InboxAccount,
  key: Exclude<SortKey, "name">,
  limitOverrides: Record<number, number>,
): number {
  if (key === "reputation") return effectiveReputation(inbox.warmup) ?? -1;
  // Sorting must agree with the displayed value, which reflects local edits.
  if (key === "limit") return limitOverrides[inbox.id] ?? inbox.messagePerDay ?? -1;
  return inbox.warmup?.replyRatePercent ?? -1;
}

/* ── Root: master-detail (like campaigns) ─────────────────────────────── */
export function InboxesClient({
  inboxes,
  smartleadError,
  inboxAvatars = {},
  avatarsVerified = false,
  warmupPlans = {},
  timeZone,
  timeLocale,
}: {
  inboxes: InboxAccount[];
  smartleadError: boolean;
  /** Sending-inbox email -> real profile picture URL (from Zapmail). */
  inboxAvatars?: Record<string, string>;
  /** False = Zapmail couldn't be checked; missing avatars are unknown, not
   *  missing, so every "sends faceless" warning must stay quiet. */
  avatarsVerified?: boolean;
  /** Sending-inbox email -> the warmup window its purchase batch chose. */
  warmupPlans?: Record<string, InboxWarmupPlan>;
  timeZone: string;
  timeLocale: string;
}) {
  const router = useRouter();
  const [selectedId, setSelectedId] = useState<number | null>(null);

  // Header toggle: the Smartlead inbox roster vs the Zapmail Domains dashboard.
  // Local state (no URL param) — mirrors the page's all-local view convention.
  const [view, setView] = useState<"inboxes" | "domains">("inboxes");

  // Buy-inboxes (Zapmail) takeover.
  const [zapmailOpen, setZapmailOpen] = useState(false);

  // Select mode + bulk selection over the list; the Tag Manager modal opens
  // from the Overview's Warmup tags card. Both share the Escape handler below.
  const [selectMode, setSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [tagManagerOpen, setTagManagerOpen] = useState(false);
  const [bulkPending, startBulk] = useTransition();
  const tagRotateBusyRef = useRef(false);

  // Toolbar state (mirrors the reply-inbox idiom).
  const [query, setQuery] = useState("");
  const [groupBy, setGroupBy] = useState<GroupBy>("domain");
  const [sortKey, setSortKey] = useState<SortKey>("reputation");
  const [sortDir, setSortDir] = useState<SortDir>("desc");
  const [chips, setChips] = useState<Set<Chip>>(new Set());
  const [campaignFilter, setCampaignFilter] = useState<string>("all");

  const [pending, startTransition] = useTransition();
  const [busyId, setBusyId] = useState<string | null>(null);

  // Health reports keyed by accountId — filled by a workspace run or per-inbox
  // runs, and read by both the master rows and the detail card.
  const [reports, setReports] = useState<Record<number, HealthReport>>({});

  // Bulk warmup day-series for every inbox (null until the mount fetch lands);
  // feeds the header chart, the row sparklines, and pre-fills the detail card.
  const [warmupSeries, setWarmupSeries] = useState<Record<number, InboxWarmupStats> | null>(null);
  const [sendStats, setSendStats] = useState<WorkspaceSendStats | null>(null);
  // Campaign → inbox assignments (null until loaded); powers campaign grouping,
  // the campaign filter select, and the detail Campaigns card.
  const [campaignMap, setCampaignMap] = useState<CampaignInboxMapEntry[] | null>(null);

  // Lazy per-inbox warmup fetch — only used as a fallback when the bulk series
  // has not arrived by the time an inbox is opened.
  const [warmupStats, setWarmupStats] = useState<Record<number, InboxWarmupStats>>({});
  const [warmupState, setWarmupState] = useState<Record<number, "loading" | "error">>({});

  // Management overrides — the page never refetches, so a successful save is
  // reflected by overlaying the new value (keyed by accountId) at render time.
  const [limitOverrides, setLimitOverrides] = useState<Record<number, number>>({});
  const [warmupOverrides, setWarmupOverrides] = useState<Record<number, WarmupOverride>>({});
  // Saved identity fields overlaid onto the account at render time (header +
  // form re-seed), accumulated across saves so successive edits stack.
  const [identityOverrides, setIdentityOverrides] = useState<Record<number, InboxIdentityPatch>>({});
  // Detail-pane mutations run on their own transition/marker so they never
  // entangle with the health-check busy semantics above.
  const [managing, startManage] = useTransition();
  const [manageBusy, setManageBusy] = useState<string | null>(null);

  const showToast = useToast();

  // Fire the bulk fetches once on mount — independent, low-priority, and
  // degrading silently: a failure just resolves to an empty map/series so
  // dependent UI falls back rather than breaking.
  useEffect(() => {
    startBackground(async () => {
      const result = await getWorkspaceWarmupSeriesAction();
      setWarmupSeries(result.ok && result.series ? result.series : {});
    });
    startBackground(async () => {
      const result = await getInboxCampaignMapAction();
      setCampaignMap(result.ok && result.campaigns ? result.campaigns : []);
    });
    startBackground(async () => {
      const result = await getWorkspaceSendStatsAction();
      setSendStats(result.ok && result.stats ? result.stats : null);
    });
  }, []);

  // Escape closes the Tag Manager first, otherwise leaves select mode — but
  // never while the Zapmail takeover owns the screen (it manages its own exit).
  useEffect(() => {
    if (!selectMode && !tagManagerOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || zapmailOpen) return;
      // The Tag Manager owns its own Escape-to-close (so its exit animation
      // plays and mid-rotation writes stay guarded); defer to it while open.
      if (tagManagerOpen) return;
      setSelectMode(false);
      setSelectedIds(new Set());
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [selectMode, tagManagerOpen, zapmailOpen]);

  const runWorkspaceHealth = () => {
    setBusyId("workspace");
    startTransition(async () => {
      const result = await runWorkspaceHealthAction();
      if (result.ok && result.reports) {
        setReports((prev) => {
          const next = { ...prev };
          for (const report of result.reports!) next[report.accountId] = report;
          return next;
        });
      }
      showToast(result.ok, result.message);
      // Only clear our own marker — a run started after this one must keep its
      // busy state (stale completions must not re-enable the buttons early).
      setBusyId((prev) => (prev === "workspace" ? null : prev));
    });
  };

  const runOneHealth = (id: number) => {
    setBusyId(`health:${id}`);
    startTransition(async () => {
      const result = await runInboxHealthAction(id);
      if (result.ok && result.report) {
        const report = result.report;
        setReports((prev) => ({ ...prev, [id]: report }));
      }
      showToast(result.ok, result.message);
      setBusyId((prev) => (prev === `health:${id}` ? null : prev));
    });
  };

  // Lazy warmup fetch — skipped entirely when the bulk series already has this
  // inbox (the common case). Runs outside the health transition.
  const loadWarmup = (id: number) => {
    if (warmupStats[id] || warmupSeries?.[id] || warmupState[id] === "loading") return;
    setWarmupState((prev) => ({ ...prev, [id]: "loading" }));
    void (async () => {
      const result = await getInboxWarmupStatsAction(id);
      if (result.ok && result.stats) {
        const stats = result.stats;
        setWarmupStats((prev) => ({ ...prev, [id]: stats }));
        setWarmupState((prev) => {
          const next = { ...prev };
          delete next[id];
          return next;
        });
      } else {
        setWarmupState((prev) => ({ ...prev, [id]: "error" }));
      }
    })();
  };

  const openInbox = (id: number) => {
    // Clicking the active row again toggles the detail closed (back to Overview).
    if (selectedId === id) {
      setSelectedId(null);
      return;
    }
    setSelectedId(id);
    // Warmup-disabled inboxes never render the activity block — skip the fetch.
    if (inboxes.find((i) => i.id === id)?.warmup) loadWarmup(id);
  };

  /* ── Select mode + bulk actions ── */
  const toggleSelect = (id: number) =>
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const toggleGroupSelect = (ids: number[]) =>
    setSelectedIds((prev) => {
      const next = new Set(prev);
      const allSelected = ids.length > 0 && ids.every((id) => next.has(id));
      for (const id of ids) {
        if (allSelected) next.delete(id);
        else next.add(id);
      }
      return next;
    });

  const clearSelection = () => setSelectedIds(new Set());
  const exitSelectMode = () => {
    setSelectMode(false);
    setSelectedIds(new Set());
  };

  // All bulk mutations run on one transition, toast the action's message
  // verbatim (it carries per-inbox failure summaries), and refresh so the
  // list reflects server truth. Optimistic per-inbox overrides for the touched
  // accounts are dropped so the refetched values win; on full success we also
  // clear the selection and leave select mode.
  const afterBulk = (
    result: { ok: boolean; message: string },
    clear?: { limits?: number[]; warmups?: number[] },
  ) => {
    showToast(result.ok, result.message);
    if (clear?.limits?.length) {
      setLimitOverrides((prev) => {
        const next = { ...prev };
        for (const id of clear.limits!) delete next[id];
        return next;
      });
    }
    if (clear?.warmups?.length) {
      setWarmupOverrides((prev) => {
        const next = { ...prev };
        for (const id of clear.warmups!) delete next[id];
        return next;
      });
    }
    router.refresh();
    if (result.ok) exitSelectMode();
  };

  // A killed serverless function (timeout on a very large batch) rejects the
  // action promise — without this the transition dies silently mid-bulk with
  // partial writes and no report.
  const guardBulk = (work: () => Promise<void>) => {
    startBulk(async () => {
      try {
        await work();
      } catch {
        showToast(false, "The bulk update was interrupted. Some inboxes may have changed. Refresh and re-check.");
        router.refresh();
      }
    });
  };

  const bulkDailyLimit = (value: number) => {
    const ids = [...effectiveSelectedIds];
    guardBulk(async () => {
      const result = await bulkUpdateDailyLimitAction(ids, value);
      afterBulk(result, { limits: ids });
    });
  };

  const bulkWarmup = (enabled: boolean) => {
    const ids = [...effectiveSelectedIds];
    guardBulk(async () => {
      const result = await bulkSetWarmupEnabledAction(ids, enabled);
      afterBulk(result, { warmups: ids });
    });
  };

  const bulkRotate = () => {
    const ids = [...effectiveSelectedIds];
    guardBulk(async () => {
      const result = await rotateWarmupTagsNowAction(ids);
      // A rotated tag must not stay hidden behind a stale manual-edit override.
      afterBulk(result, { warmups: ids });
    });
  };

  const bulkAddCampaign = (campaignId: string) => {
    const ids = [...effectiveSelectedIds];
    guardBulk(async () => {
      const result = await addCampaignInboxesAction(campaignId, ids);
      // Campaign membership is client-loaded (not a server prop), so router
      // refresh won't reload it — reconcile the in-memory map directly.
      if (result.ok) {
        setCampaignMap((prev) =>
          prev
            ? prev.map((campaign) =>
                campaign.campaignId === campaignId
                  ? { ...campaign, accountIds: [...new Set([...campaign.accountIds, ...ids])] }
                  : campaign,
              )
            : prev,
        );
      }
      afterBulk(result);
    });
  };

  // Membership edits mutate the loaded campaign map in place — grouping, the
  // filter select, and the detail card all read from it, so one update keeps
  // every view in sync without a refetch.
  const onCampaignMembershipChange = (accountId: number, campaignId: string, action: "added" | "removed") => {
    setCampaignMap((prev) => {
      if (!prev) return prev;
      return prev.map((campaign) => {
        if (campaign.campaignId !== campaignId) return campaign;
        const has = campaign.accountIds.includes(accountId);
        if (action === "added" && !has) return { ...campaign, accountIds: [...campaign.accountIds, accountId] };
        if (action === "removed" && has) {
          return { ...campaign, accountIds: campaign.accountIds.filter((id) => id !== accountId) };
        }
        return campaign;
      });
    });
  };

  const saveLimit = (accountId: number, value: number, onDone: () => void) => {
    setManageBusy("limit");
    startManage(async () => {
      const result = await updateInboxDailyLimitAction(accountId, value);
      if (result.ok) {
        setLimitOverrides((prev) => ({ ...prev, [accountId]: value }));
        onDone();
      }
      showToast(result.ok, result.message);
      setManageBusy((prev) => (prev === "limit" ? null : prev));
    });
  };

  const saveIdentity = (accountId: number, patch: InboxIdentityPatch, onDone: () => void) => {
    setManageBusy("identity");
    startManage(async () => {
      const result = await updateInboxIdentityAction(accountId, patch);
      if (result.ok) {
        // Stack onto any prior override so the header keeps every saved field.
        setIdentityOverrides((prev) => ({ ...prev, [accountId]: { ...prev[accountId], ...patch } }));
        onDone();
      }
      showToast(result.ok, result.message);
      setManageBusy((prev) => (prev === "identity" ? null : prev));
    });
  };

  const saveWarmup = (accountId: number, settings: WarmupOverride, onDone: () => void) => {
    setManageBusy("warmup");
    startManage(async () => {
      const result = await updateInboxWarmupAction(accountId, settings);
      if (result.ok) {
        setWarmupOverrides((prev) => ({ ...prev, [accountId]: settings }));
        onDone();
      }
      showToast(result.ok, result.message);
      setManageBusy((prev) => (prev === "warmup" ? null : prev));
    });
  };

  const removeCampaign = (accountId: number, campaignId: string, onDone: () => void) => {
    setManageBusy(`campaign:${campaignId}`);
    startManage(async () => {
      const result = await removeCampaignInboxesAction(campaignId, [accountId]);
      if (result.ok) {
        onCampaignMembershipChange(accountId, campaignId, "removed");
        onDone();
      }
      showToast(result.ok, result.message);
      setManageBusy((prev) => (prev === `campaign:${campaignId}` ? null : prev));
    });
  };

  const addCampaign = (accountId: number, campaignId: string, onDone: () => void) => {
    setManageBusy("campaign-add");
    startManage(async () => {
      const result = await addCampaignInboxesAction(campaignId, [accountId]);
      if (result.ok) {
        onCampaignMembershipChange(accountId, campaignId, "added");
        onDone();
      }
      showToast(result.ok, result.message);
      setManageBusy((prev) => (prev === "campaign-add" ? null : prev));
    });
  };

  const selected = selectedId !== null ? inboxes.find((i) => i.id === selectedId) ?? null : null;

  /* ── Header aggregates ── */
  const domains = useMemo(() => new Set(inboxes.map((i) => domainOf(i.fromEmail))), [inboxes]);
  const connectionIssues = inboxes.filter((i) => !i.smtpOk || !i.imapOk).length;
  // Unverified map = Zapmail unreachable; claiming "missing" would be a lie.
  const missingPhotos = avatarsVerified
    ? inboxes.filter((i) => !inboxAvatars[i.fromEmail.toLowerCase()]).length
    : 0;

  const gradeCounts = useMemo(() => {
    const counts = { healthy: 0, attention: 0, risk: 0 };
    for (const report of Object.values(reports)) counts[report.grade] += 1;
    return counts;
  }, [reports]);
  const checkedCount = Object.keys(reports).length;

  /* ── Campaign map derivations ── */
  const campaignsByAccount = useMemo(() => {
    const map = new Map<number, CampaignInboxMapEntry[]>();
    if (!campaignMap) return map;
    for (const campaign of campaignMap) {
      for (const id of campaign.accountIds) {
        const list = map.get(id);
        if (list) list.push(campaign);
        else map.set(id, [campaign]);
      }
    }
    return map;
  }, [campaignMap]);

  const campaignFilterIds = useMemo(() => {
    if (campaignFilter === "all" || !campaignMap) return null;
    const entry = campaignMap.find((c) => c.campaignId === campaignFilter);
    return new Set(entry ? entry.accountIds : []);
  }, [campaignFilter, campaignMap]);

  /* ── Filter (search + campaign + quick chips) ── */
  const matchesChip = (inbox: InboxAccount, chip: Chip): boolean => {
    const warmup = inbox.warmup;
    if (chip === "issues") {
      return !inbox.smtpOk || !inbox.imapOk || inbox.isSuspended || Boolean(warmup?.isBlocked);
    }
    if (chip === "blocked") return Boolean(warmup?.isBlocked);
    // Accounts sending without a face — fix in Zapmail before campaigns send.
    if (chip === "nophoto") return !inboxAvatars[inbox.fromEmail.toLowerCase()];
    if (chip === "warming") {
      const timeline = warmupTimeline(inbox, warmupPlans[inbox.fromEmail.toLowerCase()]);
      return Boolean(timeline && !timeline.ready && warmup?.status?.toUpperCase() !== "PAUSED");
    }
    // at risk (a not-yet-started warmup is pending, never "at risk")
    const reputation = effectiveReputation(warmup);
    return reports[inbox.id]?.grade === "risk" || (reputation != null && reputation < 75);
  };

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return inboxes.filter((inbox) => {
      if (q) {
        const hay = `${inbox.fromEmail} ${inbox.fromName} ${domainOf(inbox.fromEmail)}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      if (campaignFilterIds && !campaignFilterIds.has(inbox.id)) return false;
      for (const chip of chips) if (!matchesChip(inbox, chip)) return false;
      return true;
    });
    // reports/campaignFilterIds are captured by the predicate closures.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inboxes, query, campaignFilterIds, chips, reports]);

  // Selection is DERIVED against the current filter — bulk actions must never
  // silently mutate inboxes the user can no longer see. Rows hidden by a
  // filter drop out of the effective selection (and the count) immediately;
  // un-filtering brings their checkmarks back.
  // Plain derivation (the compiler memoizes) — cheap at any realistic count.
  const visibleIds = new Set(filtered.map((inbox) => inbox.id));
  const effectiveSelectedIds = new Set([...selectedIds].filter((id) => visibleIds.has(id)));

  /* ── Group + sort ── */
  const groups = useMemo(() => {
    const sortWithin = (list: InboxAccount[]) =>
      [...list].sort((a, b) => {
        const base =
          sortKey === "name"
            ? a.fromEmail.localeCompare(b.fromEmail)
            : sortNumber(a, sortKey, limitOverrides) - sortNumber(b, sortKey, limitOverrides);
        return sortDir === "asc" ? base : -base;
      });

    type Group = { key: string; label: string | null; accounts: InboxAccount[] };

    // Campaign grouping degrades to a flat list if the map never loaded.
    if (groupBy === "campaign" && campaignMap && campaignMap.length > 0) {
      const result: Group[] = [];
      const assigned = new Set<number>();
      const byId = new Map(filtered.map((i) => [i.id, i] as const));
      // With a campaign filter active, only that campaign's group renders —
      // overlap inboxes would otherwise surface foreign campaign headers
      // inside a view the user just narrowed to one campaign.
      const visible =
        campaignFilter === "all" ? campaignMap : campaignMap.filter((c) => c.campaignId === campaignFilter);
      for (const campaign of [...visible].sort((a, b) => a.name.localeCompare(b.name))) {
        const accounts: InboxAccount[] = [];
        for (const id of campaign.accountIds) {
          const inbox = byId.get(id);
          if (inbox) {
            accounts.push(inbox);
            assigned.add(id);
          }
        }
        if (accounts.length > 0) {
          result.push({ key: `c:${campaign.campaignId}`, label: campaign.name, accounts: sortWithin(accounts) });
        }
      }
      const unassigned = filtered.filter((i) => !assigned.has(i.id));
      if (unassigned.length > 0) {
        result.push({ key: "c:unassigned", label: "Unassigned", accounts: sortWithin(unassigned) });
      }
      return result;
    }

    if (groupBy === "provider") {
      const byProvider = new Map<string, InboxAccount[]>();
      for (const inbox of filtered) {
        const label = inbox.provider?.trim() ? titleCaseProvider(inbox.provider) : "Unknown provider";
        const list = byProvider.get(label);
        if (list) list.push(inbox);
        else byProvider.set(label, [inbox]);
      }
      return [...byProvider.entries()]
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([label, accounts]) => ({ key: `p:${label}`, label, accounts: sortWithin(accounts) }));
    }

    if (groupBy === "none" || groupBy === "campaign") {
      return filtered.length > 0
        ? [{ key: "all", label: null, accounts: sortWithin(filtered) }]
        : [];
    }

    // Domain (default).
    const byDomain = new Map<string, InboxAccount[]>();
    for (const inbox of filtered) {
      const domain = domainOf(inbox.fromEmail);
      const list = byDomain.get(domain);
      if (list) list.push(inbox);
      else byDomain.set(domain, [inbox]);
    }
    return [...byDomain.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([domain, accounts]) => ({ key: `d:${domain}`, label: domain, accounts: sortWithin(accounts) }));
  }, [filtered, groupBy, sortKey, sortDir, campaignMap, campaignFilter, limitOverrides]);

  const hasActiveFilters = chips.size > 0 || query.trim().length > 0;
  const clearFilters = () => {
    setChips(new Set());
    setQuery("");
  };
  const toggleChip = (chip: Chip) =>
    setChips((prev) => {
      const next = new Set(prev);
      if (next.has(chip)) next.delete(chip);
      else next.add(chip);
      return next;
    });

  // Spinners key off the specific run, but ALL run buttons disable while ANY
  // health transition is in flight — two overlapping runs just fight over
  // the same reports map.
  const workspaceBusy = pending && busyId === "workspace";
  const detailStats = selected ? warmupStats[selected.id] ?? warmupSeries?.[selected.id] : undefined;

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <header className="flex h-14 shrink-0 items-center gap-2 border-b border-border bg-surface px-5">
        {view === "domains" ? (
          <Globe className="size-4 text-muted-foreground" strokeWidth={1.75} />
        ) : (
          <AtSign className="size-4 text-muted-foreground" strokeWidth={1.75} />
        )}
        <h1 className="sr-only">{view === "domains" ? "Domains" : "Inboxes"}</h1>
        <div role="group" aria-label="View" className="flex items-center gap-0.5 rounded-md bg-muted/60 p-0.5">
          {(["inboxes", "domains"] as const).map((key) => (
            <button
              key={key}
              type="button"
              aria-pressed={view === key}
              onClick={() => setView(key)}
              className={`flex h-7 min-w-[78px] items-center justify-center rounded px-3 text-[12.5px] font-medium capitalize transition-colors ${
                view === key ? "bg-surface text-foreground shadow-xs" : "text-muted-foreground hover:text-foreground"
              }`}
            >
              {key}
            </button>
          ))}
        </div>
        <div className="ml-auto flex items-center gap-2">
          {view === "inboxes" && inboxes.length > 0 ? (
            <HeaderStats
              inboxes={inboxes}
              series={warmupSeries}
              sendStats={sendStats}
              counts={gradeCounts}
              checked={checkedCount}
              connectionIssues={connectionIssues}
              missingPhotos={missingPhotos}
              onShowOverview={() => setSelectedId(null)}
            />
          ) : null}
          <ProvisionReviewSection showToast={showToast} timeZone={timeZone} timeLocale={timeLocale} />
          <button
            type="button"
            onClick={() => setZapmailOpen(true)}
            className={`${BTN_OUTLINE} h-8 px-3 text-[12px]`}
          >
            <ShoppingBag className="size-3.5" />
            Buy inboxes
          </button>
        </div>
      </header>

      {view === "domains" ? (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <DomainsView timeZone={timeZone} timeLocale={timeLocale} />
        </div>
      ) : inboxes.length === 0 ? (
        <div className="flex flex-1 items-center justify-center p-8">
          <div className="max-w-sm text-center">
            <span className="mx-auto flex size-10 items-center justify-center rounded-full bg-muted/60">
              <AtSign className="size-5 text-muted-foreground" strokeWidth={1.5} />
            </span>
            <p className="mt-3 text-[13px] font-medium">
              {smartleadError ? "Couldn't load inboxes from Smartlead." : "No sending accounts yet"}
            </p>
            <p className="mt-1 text-[12px] leading-relaxed text-muted-foreground">
              Connect your Smartlead API key in{" "}
              <span className="font-medium text-foreground">Settings → Integrations</span> to see your
              sending accounts and warmup here.
            </p>
          </div>
        </div>
      ) : (
          <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
            {/* ── Master: toolbar + grouped list + bulk bar (full viewport height) ── */}
            <aside className="flex shrink-0 flex-col border-b border-border lg:h-full lg:min-h-0 lg:w-[380px] lg:border-b-0 lg:border-r">
              <div className="flex shrink-0 flex-col gap-1.5 border-b border-border px-3 py-2.5">
                <div className="relative">
                  <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
                  <input
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    placeholder="Search email, name, or domain"
                    aria-label="Search inboxes"
                    className={`${INPUT_CLASS} pl-8`}
                  />
                </div>

                {/* Filters: group/sort + campaign selects, then quick chips —
                    the exact control grammar of the reply inbox's toolbar. */}
                <div className="flex gap-1.5">
                  <FilterSelect
                    value={groupBy}
                    ariaLabel="Group inboxes"
                    onChange={(event) => setGroupBy(event.target.value as GroupBy)}
                  >
                    <option value="domain">By domain</option>
                    <option value="campaign">By campaign</option>
                    <option value="provider">By provider</option>
                    <option value="none">No grouping</option>
                  </FilterSelect>
                  <FilterSelect
                    value={sortKey}
                    ariaLabel="Sort inboxes"
                    onChange={(event) => setSortKey(event.target.value as SortKey)}
                  >
                    <option value="reputation">Reputation</option>
                    <option value="limit">Daily limit</option>
                    <option value="replyRate">Reply rate</option>
                    <option value="name">Name</option>
                  </FilterSelect>
                  <button
                    type="button"
                    data-tip={sortDir === "desc" ? "Descending. Click for ascending." : "Ascending. Click for descending."}
                    data-tip-down=""
                    aria-label={sortDir === "desc" ? "Sort ascending" : "Sort descending"}
                    onClick={() => setSortDir((dir) => (dir === "desc" ? "asc" : "desc"))}
                    className={`flex size-7 shrink-0 items-center justify-center rounded-md border border-border bg-surface text-muted-foreground shadow-xs transition hover:text-foreground`}
                  >
                    {sortDir === "desc" ? (
                      <ArrowDownWideNarrow className="size-3.5" />
                    ) : (
                      <ArrowUpNarrowWide className="size-3.5" />
                    )}
                  </button>
                </div>
                {campaignMap && campaignMap.length > 0 ? (
                  <FilterSelect
                    value={campaignFilter}
                    ariaLabel="Filter by campaign"
                    onChange={(event) => setCampaignFilter(event.target.value)}
                  >
                    <option value="all">All campaigns</option>
                    {[...campaignMap]
                      .sort((a, b) => a.name.localeCompare(b.name))
                      .map((campaign) => (
                        <option key={campaign.campaignId} value={campaign.campaignId}>
                          {campaign.name}
                        </option>
                      ))}
                  </FilterSelect>
                ) : null}
                <div className="flex flex-wrap items-center gap-1.5">
                  {(Object.keys(CHIP_LABEL) as Chip[]).map((chip) => (
                    <button
                      key={chip}
                      type="button"
                      aria-pressed={chips.has(chip)}
                      onClick={() => toggleChip(chip)}
                      className={`rounded-full border px-2 py-0.5 text-[11px] font-medium transition ${
                        chips.has(chip)
                          ? "border-transparent bg-accent text-accent-foreground"
                          : "border-border bg-surface text-muted-foreground hover:text-foreground"
                      }`}
                    >
                      {CHIP_LABEL[chip]}
                    </button>
                  ))}
                  <div className="ml-auto flex items-center gap-2">
                    {hasActiveFilters ? (
                      <button
                        type="button"
                        onClick={clearFilters}
                        className={`text-[11px] font-medium text-muted-foreground transition hover:text-foreground`}
                      >
                        Clear
                      </button>
                    ) : null}
                    <button
                      type="button"
                      aria-pressed={selectMode}
                      onClick={() =>
                        setSelectMode((mode) => {
                          if (mode) setSelectedIds(new Set());
                          return !mode;
                        })
                      }
                      className={`${BTN_SUBTLE} h-7 px-2 text-[11px]`}
                    >
                      <CheckSquare className="size-3.5" />
                      {selectMode ? "Done" : "Select"}
                    </button>
                  </div>
                </div>
              </div>

              <div className="max-h-72 overflow-y-auto lg:max-h-none lg:min-h-0 lg:flex-1">
                {groups.length > 0 ? (
                  <div className="flex flex-col p-2">
                    {groups.map((group) => {
                      const groupIds = group.accounts.map((account) => account.id);
                      const allSelected = groupIds.length > 0 && groupIds.every((id) => selectedIds.has(id));
                      const someSelected = groupIds.some((id) => selectedIds.has(id));
                      const grouped = group.label !== null;
                      const rows = group.accounts.map((inbox) => (
                        <InboxRow
                          key={inbox.id}
                          inbox={inbox}
                          limit={limitOverrides[inbox.id] ?? inbox.messagePerDay}
                          active={inbox.id === selectedId}
                          report={reports[inbox.id]}
                          series={warmupSeries?.[inbox.id]}
                          avatarSrc={inboxAvatars[inbox.fromEmail.toLowerCase()] ?? null}
                          avatarVerified={avatarsVerified}
                          timeline={warmupTimeline(inbox, warmupPlans[inbox.fromEmail.toLowerCase()])}
                          timeZone={timeZone}
                          timeLocale={timeLocale}
                          selectMode={selectMode}
                          selected={selectedIds.has(inbox.id)}
                          onSelect={() => openInbox(inbox.id)}
                          onToggleSelect={() => toggleSelect(inbox.id)}
                        />
                      ));
                      return (
                        <div
                          key={group.key}
                          className={`flex flex-col gap-1 ${grouped ? "mt-3 first:mt-0" : ""}`}
                        >
                          {grouped ? (
                            <div
                              className="sticky top-0 z-10 -mx-2 flex items-center gap-2 border-b border-border px-2 pb-1.5 pt-2"
                              // The group's own accent hue at a whisper, mixed
                              // opaquely over the surface so the sticky header
                              // never lets rows show through.
                              style={{ backgroundColor: `color-mix(in srgb, ${groupHue(group.key)} 9%, var(--color-surface))` }}
                            >
                              {selectMode ? (
                                <button
                                  type="button"
                                  aria-label={`Select all in ${group.label}`}
                                  aria-pressed={allSelected}
                                  onClick={() => toggleGroupSelect(groupIds)}
                                  className={`flex size-3.5 shrink-0 items-center justify-center rounded border transition ${
                                    allSelected
                                      ? "border-primary bg-primary text-primary-foreground"
                                      : someSelected
                                        ? "border-primary bg-primary/25 text-primary"
                                        : "border-border bg-surface"
                                  }`}
                                >
                                  {allSelected ? (
                                    <Check className="size-2.5" strokeWidth={3} />
                                  ) : someSelected ? (
                                    <Minus className="size-2.5" strokeWidth={3} />
                                  ) : null}
                                </button>
                              ) : null}
                              <span
                                aria-hidden
                                className="h-3 w-[3px] shrink-0 rounded-full"
                                style={{ backgroundColor: groupHue(group.key) }}
                              />
                              <span
                                title={group.label ?? undefined}
                                className="min-w-0 truncate text-[10.5px] font-semibold uppercase tracking-wide text-foreground/70"
                              >
                                {group.label}
                              </span>
                              <span className="text-[10px] font-medium tabular-nums text-muted-foreground/70">
                                {group.accounts.length}
                              </span>
                            </div>
                          ) : null}
                          {grouped ? <div className="flex flex-col gap-1 pl-1">{rows}</div> : rows}
                        </div>
                      );
                    })}
                  </div>
                ) : (
                  <div className="p-4">
                    <div className="rounded-lg border border-dashed border-border px-3 py-6 text-center text-[12px] text-muted-foreground">
                      No inboxes match these filters.
                    </div>
                  </div>
                )}
              </div>

              {/* Bulk bar docks at the bottom of the list column once a
                  selection exists — all actions run through one transition. */}
              {selectMode && effectiveSelectedIds.size > 0 ? (
                <BulkBar
                  count={effectiveSelectedIds.size}
                  campaigns={campaignMap}
                  pending={bulkPending}
                  onDailyLimit={bulkDailyLimit}
                  onWarmup={bulkWarmup}
                  onRotate={bulkRotate}
                  onAddCampaign={bulkAddCampaign}
                  onClear={clearSelection}
                />
              ) : null}
            </aside>

            {/* ── Right pane: Overview (no selection) or inbox detail ── */}
            <div className="min-w-0 flex-1 overflow-y-auto">
              {!selected ? (
                <Overview
                  inboxes={inboxes}
                  series={warmupSeries}
                  gradeCounts={gradeCounts}
                  checkedCount={checkedCount}
                  connectionIssues={connectionIssues}
                  missingPhotos={missingPhotos}
                  workspaceBusy={workspaceBusy}
                  healthDisabled={pending}
                  onRunWorkspaceHealth={runWorkspaceHealth}
                  domainCount={domains.size}
                  showToast={showToast}
                  timeZone={timeZone}
                  timeLocale={timeLocale}
                  onManageTags={() => setTagManagerOpen(true)}
                />
              ) : (
                <InboxDetail
                  key={selected.id}
                  inbox={applyIdentityOverride(selected, identityOverrides[selected.id])}
                  timeline={warmupTimeline(selected, warmupPlans[selected.fromEmail.toLowerCase()])}
                  report={reports[selected.id]}
                  stats={detailStats}
                  statsState={warmupState[selected.id]}
                  campaigns={campaignMap ? campaignsByAccount.get(selected.id) ?? [] : null}
                  availableCampaigns={
                    campaignMap ? campaignMap.filter((c) => !c.accountIds.includes(selected.id)) : null
                  }
                  limitOverride={limitOverrides[selected.id]}
                  warmupOverride={warmupOverrides[selected.id]}
                  onClose={() => setSelectedId(null)}
                  onSaveLimit={(value, onDone) => saveLimit(selected.id, value, onDone)}
                  onSaveWarmup={(settings, onDone) => saveWarmup(selected.id, settings, onDone)}
                  onSaveIdentity={(patch, onDone) => saveIdentity(selected.id, patch, onDone)}
                  onRemoveCampaign={(campaignId, onDone) => removeCampaign(selected.id, campaignId, onDone)}
                  onAddCampaign={(campaignId, onDone) => addCampaign(selected.id, campaignId, onDone)}
                  limitBusy={managing && manageBusy === "limit"}
                  warmupBusy={managing && manageBusy === "warmup"}
                  identityBusy={managing && manageBusy === "identity"}
                  addCampaignBusy={managing && manageBusy === "campaign-add"}
                  removingCampaignId={
                    managing && manageBusy?.startsWith("campaign:") ? manageBusy.slice(9) : null
                  }
                  manageDisabled={managing}
                  onRetryStats={() => loadWarmup(selected.id)}
                  onRunHealth={() => runOneHealth(selected.id)}
                  healthBusy={pending && (busyId === `health:${selected.id}` || busyId === "workspace")}
                  healthDisabled={pending}
                  timeZone={timeZone}
                  timeLocale={timeLocale}
                />
              )}
            </div>
          </div>
      )}

      {zapmailOpen ? <ZapmailFlow open onClose={() => setZapmailOpen(false)} /> : null}

      {tagManagerOpen ? (
        <TagManagerModal
          inboxes={inboxes}
          showToast={showToast}
          onTagsChanged={(ids) => {
            // A freshly saved or rotated tag must not stay hidden behind a
            // stale manual-edit override in the detail pane; refresh reloads
            // the roster so the modal's rows re-seed from server truth.
            setWarmupOverrides((prev) => {
              const next = { ...prev };
              for (const id of ids) delete next[id];
              return next;
            });
            router.refresh();
          }}
          onClose={() => setTagManagerOpen(false)}
          busyRef={tagRotateBusyRef}
        />
      ) : null}
    </div>
  );
}

/* ── Toolbar select — the reply inbox's exact bordered idiom ─────────────── */
function FilterSelect({
  value,
  onChange,
  ariaLabel,
  children,
}: {
  value: string;
  onChange: (event: React.ChangeEvent<HTMLSelectElement>) => void;
  ariaLabel: string;
  children: ReactNode;
}) {
  return (
    <div className="relative flex-1">
      <select
        value={value}
        onChange={onChange}
        aria-label={ariaLabel}
        className="h-7 w-full appearance-none rounded-md border border-border bg-surface pl-2 pr-6 text-[11.5px] font-medium text-foreground shadow-xs outline-none transition focus:border-ring"
      >
        {children}
      </select>
      <ChevronDown className="pointer-events-none absolute right-1.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
    </div>
  );
}

/* ── Overview (right pane default) ───────────────────────────────────────
   The workspace at a glance: warmup activity + health on top, the full-width
   health-score track below, and a slim org-level warmup-tag strip last. */
function Overview({
  inboxes,
  series,
  gradeCounts,
  checkedCount,
  connectionIssues,
  missingPhotos,
  workspaceBusy,
  healthDisabled,
  onRunWorkspaceHealth,
  domainCount,
  showToast,
  timeZone,
  timeLocale,
  onManageTags,
}: {
  inboxes: InboxAccount[];
  series: Record<number, InboxWarmupStats> | null;
  gradeCounts: { healthy: number; attention: number; risk: number };
  checkedCount: number;
  connectionIssues: number;
  missingPhotos: number;
  workspaceBusy: boolean;
  healthDisabled: boolean;
  onRunWorkspaceHealth: () => void;
  domainCount: number;
  showToast: (ok: boolean, text: string) => void;
  timeZone: string;
  timeLocale: string;
  onManageTags: () => void;
}) {
  return (
    <div className="mx-auto flex w-full max-w-[1060px] flex-col gap-5 px-5 py-6">
      <div className="grid gap-5 xl:grid-cols-[1.6fr_1fr]">
        <WarmupActivityCard series={series} timeLocale={timeLocale} />
        <HealthOverviewCard
          counts={gradeCounts}
          checked={checkedCount}
          total={inboxes.length}
          connectionIssues={connectionIssues}
          missingPhotos={missingPhotos}
          busy={workspaceBusy}
          disabled={healthDisabled}
          onRun={onRunWorkspaceHealth}
        />
      </div>
      {/* Full width: the split health-score track reads well wide, so it owns
          its own row rather than sharing a column. */}
      <ReputationCard inboxes={inboxes} domainCount={domainCount} />
      {/* Warmup tags are an org-level control — one slim line, not a card. */}
      <WarmupTagsStrip
        showToast={showToast}
        timeZone={timeZone}
        timeLocale={timeLocale}
        onManageTags={onManageTags}
      />
    </div>
  );
}

/* ── Overview · Warmup activity (14-day aggregate, hero-sized) ──────────── */
function WarmupActivityCard({
  series,
  timeLocale,
}: {
  series: Record<number, InboxWarmupStats> | null;
  timeLocale: string;
}) {
  const loaded = series !== null;
  const days = loaded ? aggregateSeries(series) : [];
  const max = days.reduce((m, d) => Math.max(m, d.sent), 0);
  const totalSends = days.reduce((sum, d) => sum + d.sent, 0);

  const caption =
    loaded && days.length > 0 ? (
      <span className="flex items-center gap-2 text-[11px] font-medium tabular-nums text-muted-foreground">
        {max > 0 ? (
          <span className="inline-flex items-baseline gap-1 rounded-md bg-muted/70 px-2 py-0.5">
            Peak <span className="text-foreground">{max}</span>/day
          </span>
        ) : null}
        <span>
          {totalSends.toLocaleString()} sent{days.length > 1 ? ` · last ${days.length} days` : ""}
        </span>
      </span>
    ) : null;

  return (
    <Card title="Warmup activity" action={caption} fill>
      {!loaded ? (
        <SkeletonChart height="h-40" bars={14} />
      ) : days.length === 0 ? (
        <div className="flex h-40 flex-col justify-end gap-2">
          <div className="flex items-end gap-[3px]">
            {Array.from({ length: 14 }).map((_, index) => (
              <div key={index} className="h-px flex-1 bg-border" />
            ))}
          </div>
          <p className="text-[11px] text-muted-foreground">No warmup activity yet.</p>
        </div>
      ) : (
        <DayColumnChart days={days} max={max} timeLocale={timeLocale} height="h-40" />
      )}
    </Card>
  );
}

/* ── Overview · Health (donut + grade counts + workspace run) ──────────── */
function HealthOverviewCard({
  counts,
  checked,
  total,
  connectionIssues,
  missingPhotos,
  busy,
  disabled,
  onRun,
}: {
  counts: { healthy: number; attention: number; risk: number };
  checked: number;
  total: number;
  connectionIssues: number;
  missingPhotos: number;
  busy: boolean;
  disabled: boolean;
  onRun: () => void;
}) {
  const hasReports = checked > 0;
  const action = hasReports ? (
    <button type="button" disabled={disabled} onClick={onRun} className={`${BTN_OUTLINE} h-7 px-2.5 text-[11px]`}>
      {busy ? <Loader2 className="size-3 animate-spin" /> : <Activity className="size-3" />}
      {busy ? "Checking…" : "Re-run all"}
    </button>
  ) : null;

  return (
    <Card title="Health" action={action} fill>
      <div className="flex items-center gap-4">
        <HealthDonut
          counts={counts}
          checked={checked}
          placeholder={!hasReports}
          centerText={hasReports ? `${checked}/${total}` : "—"}
          size={88}
        />
        {hasReports ? (
          <div className="flex flex-col gap-0.5 text-[11.5px]">
            {counts.healthy > 0 ? (
              <span className="font-medium tabular-nums text-success">{counts.healthy} healthy</span>
            ) : null}
            {counts.attention > 0 ? (
              <span className="font-medium tabular-nums text-warning">{counts.attention} attention</span>
            ) : null}
            {counts.risk > 0 ? (
              <span className="font-medium tabular-nums text-destructive">{counts.risk} at risk</span>
            ) : null}
            {connectionIssues > 0 ? (
              <span className="font-medium tabular-nums text-warning">
                {connectionIssues} connection {connectionIssues === 1 ? "issue" : "issues"}
              </span>
            ) : null}
            {missingPhotos > 0 ? (
              <span
                data-tip="Set profile pictures in Zapmail — these accounts send faceless"
                className="font-medium tabular-nums text-warning"
              >
                {missingPhotos} missing profile {missingPhotos === 1 ? "picture" : "pictures"}
              </span>
            ) : null}
          </div>
        ) : (
          <button type="button" disabled={disabled} onClick={onRun} className={`${BTN_PRIMARY} h-8 px-3 text-[12px]`}>
            {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Activity className="size-3.5" />}
            {busy ? "Checking…" : "Run health check"}
          </button>
        )}
      </div>
    </Card>
  );
}

/* ── Overview · Reputation (split track + band counts + avg) ───────────── */
function ReputationCard({ inboxes, domainCount }: { inboxes: InboxAccount[]; domainCount: number }) {
  const rated = inboxes
    .map((i) => effectiveReputation(i.warmup))
    .filter((r): r is number => r !== null);
  const high = rated.filter((r) => r >= 90).length;
  const mid = rated.filter((r) => r >= 75 && r < 90).length;
  const low = rated.filter((r) => r < 75).length;
  const unrated = inboxes.length - rated.length;
  const total = rated.length;
  const avg = total > 0 ? Math.round(rated.reduce((sum, r) => sum + r, 0) / total) : null;

  const caption = (
    <span className="text-[11px] text-muted-foreground">
      {inboxes.length} {inboxes.length === 1 ? "inbox" : "inboxes"} · {domainCount}{" "}
      {domainCount === 1 ? "domain" : "domains"}
    </span>
  );

  return (
    <Card title="Health score" action={caption}>
      <div className="flex flex-col gap-2">
        <div className="flex h-3 overflow-hidden rounded-full bg-muted">
          {total > 0 ? (
            <>
              {high > 0 ? <div className="bg-success" style={{ width: `${(high / total) * 100}%` }} /> : null}
              {mid > 0 ? <div className="bg-warning" style={{ width: `${(mid / total) * 100}%` }} /> : null}
              {low > 0 ? <div className="bg-destructive" style={{ width: `${(low / total) * 100}%` }} /> : null}
            </>
          ) : null}
        </div>
        <div className="flex items-center gap-3 text-[11px]">
          {/* Zero bands are noise — show only the populated ones. */}
          {high > 0 ? <BandCount value={high} label="≥90" className="text-success" /> : null}
          {mid > 0 ? <BandCount value={mid} label="75–89" className="text-warning" /> : null}
          {low > 0 ? <BandCount value={low} label="<75" className="text-destructive" /> : null}
          {unrated > 0 ? <span className="text-muted-foreground">· {unrated} unrated</span> : null}
          <span className="ml-auto font-medium tabular-nums">{avg !== null ? `Avg ${avg}` : "—"}</span>
        </div>
      </div>
    </Card>
  );
}

/* ── Overview · Warmup tags strip (org-level rotation, one slim line) ─────
   Warmup tags are an organization control rotated across every inbox, not a
   per-inbox setting — so they live on one line, not a full card. Rotation
   state loads on mount (busy semantics rehomed from the old card); Edit opens
   the Tag Manager, the single surface for per-inbox tags and full rotation. */
function WarmupTagsStrip({
  showToast,
  timeZone,
  timeLocale,
  onManageTags,
}: {
  showToast: (ok: boolean, text: string) => void;
  timeZone: string;
  timeLocale: string;
  onManageTags: () => void;
}) {
  const [state, setState] = useState<WarmupRotationState | null>(null);
  const [loadState, setLoadState] = useState<"loading" | "error" | "idle">("loading");
  const [, startRotation] = useTransition();
  const [busy, setBusy] = useState(false);

  // Load rotation state on mount (not lazily on click). The async body sets
  // state only after the fetch resolves — never synchronously in the effect.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const result = await getWarmupRotationAction();
      if (cancelled) return;
      if (result.ok && result.state) {
        setState(result.state);
        setLoadState("idle");
      } else {
        setLoadState("error");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const setRotation = (next: boolean) => {
    setBusy(true);
    startRotation(async () => {
      const result = await setWarmupRotationAction(next);
      if (result.ok && result.state) setState(result.state);
      showToast(result.ok, result.message);
      setBusy(false);
    });
  };

  const status =
    loadState === "loading"
      ? "Loading…"
      : loadState === "error" || !state
        ? "Rotation status unavailable"
        : state.lastRotatedAt
          ? `Last rotated ${formatTimestamp(state.lastRotatedAt, timeZone, timeLocale)}${
              state.lastSummary ? ` · ${state.lastSummary.rotated} rotated` : ""
            }`
          : "Never rotated yet.";

  return (
    <div className="flex items-center gap-3 rounded-xl bg-surface px-3.5 py-2.5 shadow-xs">
      <span className="flex shrink-0 items-center gap-1.5">
        <RefreshCw className="size-3.5 text-muted-foreground" />
        <span className="text-[12px] font-semibold tracking-tight">Warmup tags</span>
      </span>
      <span className="flex shrink-0 items-center gap-1.5">
        <span className="text-[11.5px] text-muted-foreground">Rotate automatically</span>
        <WarmupToggle
          checked={Boolean(state?.enabled)}
          disabled={busy || loadState !== "idle"}
          onChange={setRotation}
        />
      </span>
      <span className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground">{status}</span>
      <button type="button" onClick={onManageTags} className={`${BTN_OUTLINE} h-7 shrink-0 px-2.5 text-[11.5px]`}>
        <Pencil className="size-3" />
        Edit
      </button>
    </div>
  );
}

/* Shared modal exit driver: a close intent flips `closing`, which swaps the
   backdrop/panel enter classes for the matching exit classes; the real unmount
   fires after the 150ms exit runs. Guards double-close, clears on unmount. */
function useExit() {
  const [closing, setClosing] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  const playExit = (done: () => void) => {
    if (timer.current) return;
    setClosing(true);
    timer.current = setTimeout(done, 150);
  };
  return { closing, playExit };
}

/* ── Tag Manager modal (the single warmup-tag surface) ───────────────────
   One row per warmup-capable inbox: edit its tag inline, confirm to save, or
   roll a fresh one. "Rotate all" re-tags every warmup-active inbox at once —
   the org-level action that ALSO advances the auto-rotation schedule. A
   per-row rotate (single id) deliberately does NOT advance the schedule. */
function TagManagerModal({
  inboxes,
  showToast,
  onTagsChanged,
  onClose,
  busyRef,
}: {
  inboxes: InboxAccount[];
  showToast: (ok: boolean, text: string) => void;
  /** Clears stale detail-pane overrides for the touched ids and refreshes the
      roster so rows re-seed from server truth. */
  onTagsChanged: (ids: number[]) => void;
  onClose: () => void;
  /** Mirrors the mutation transition so the parent's Escape handler can refuse
      to tear the modal down mid-write. */
  busyRef: React.MutableRefObject<boolean>;
}) {
  const capable = inboxes.filter((i) => i.warmup);
  const eligible = capable.filter(
    (i) => !i.warmup!.isBlocked && i.warmup!.status?.toUpperCase() !== "PAUSED",
  );
  // One shared transition; a busy marker (`save:{id}` / `rotate:{id}` / "all")
  // drives per-control spinners while every control disables during any write.
  const [pending, startAction] = useTransition();
  const { closing, playExit } = useExit();
  const beginClose = () => {
    if (!pending) playExit(onClose);
  };
  // The modal owns its Escape-to-close so the exit animation plays; the parent
  // handler defers to this while the modal is open. Never mid-rotation.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") beginClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pending]);
  const [busyMarker, setBusyMarker] = useState<string | null>(null);
  // Draft tags keyed by inbox id — a row with no draft reads its current tag
  // from props, so a success (which deletes the draft) surfaces the refreshed
  // value straight away.
  const [drafts, setDrafts] = useState<Record<number, string>>({});
  const [invalidIds, setInvalidIds] = useState<Set<number>>(new Set());

  const draftFor = (inbox: InboxAccount) => drafts[inbox.id] ?? inbox.warmup?.warmupKey ?? "";

  const clearInvalid = (id: number) =>
    setInvalidIds((prev) => {
      if (!prev.has(id)) return prev;
      const next = new Set(prev);
      next.delete(id);
      return next;
    });

  // Every mutation funnels through here: mark busy, run, toast, and on success
  // drop the touched drafts + hand the ids to the parent (override clear +
  // refresh). A killed function (huge batch + timeout) rejects — report it
  // rather than dying silently with partial writes. The modal stays open.
  const runMutation = (
    marker: string,
    work: () => Promise<{ ok: boolean; message: string }>,
    clearIds: number[],
  ) => {
    setBusyMarker(marker);
    busyRef.current = true;
    startAction(async () => {
      try {
        const result = await work();
        showToast(result.ok, result.message);
        if (result.ok) {
          setDrafts((prev) => {
            const next = { ...prev };
            for (const id of clearIds) delete next[id];
            return next;
          });
          onTagsChanged(clearIds);
        }
      } catch {
        showToast(false, "The update was interrupted. Some tags may have changed. Refresh and re-check.");
      } finally {
        setBusyMarker(null);
        busyRef.current = false;
      }
    });
  };

  const saveRow = (inbox: InboxAccount) => {
    const tag = draftFor(inbox).trim();
    if (!WARMUP_TAG_PATTERN.test(tag)) {
      setInvalidIds((prev) => new Set(prev).add(inbox.id));
      return;
    }
    clearInvalid(inbox.id);
    runMutation(
      `save:${inbox.id}`,
      () =>
        updateInboxWarmupAction(inbox.id, {
          enabled: inbox.warmup?.status?.toUpperCase() !== "PAUSED",
          totalPerDay: inbox.warmup?.warmupMaxCount ?? 15,
          replyRatePercent: inbox.warmup?.replyRatePercent ?? 27,
          warmupKey: tag,
        }),
      [inbox.id],
    );
  };

  const rotateRow = (inbox: InboxAccount) =>
    runMutation(`rotate:${inbox.id}`, () => rotateWarmupTagsNowAction([inbox.id]), [inbox.id]);

  // No ids → full rotation across every warmup-active inbox; advances the
  // schedule, so we clear overrides for the whole eligible set.
  const rotateAll = () =>
    runMutation("all", () => rotateWarmupTagsNowAction(), eligible.map((i) => i.id));

  return (
    <div
      className={`fixed inset-0 z-50 flex cursor-pointer items-center justify-center bg-background/70 p-4 backdrop-blur-sm ${closing ? "anim-overlay-out" : "anim-overlay-in"}`}
      onClick={(event) => {
        if (event.target === event.currentTarget) beginClose();
      }}
    >
      <div className={`flex max-h-[85vh] w-full max-w-xl cursor-auto flex-col overflow-hidden rounded-xl border border-border bg-surface shadow-pop ${closing ? "anim-panel-out" : "anim-panel-in"}`}>
        <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-3">
          <div className="flex flex-col gap-0.5">
            <h2 className="text-[13.5px] font-semibold tracking-tight">Warmup tags</h2>
            <span className="text-[11px] text-muted-foreground">
              {capable.length} {capable.length === 1 ? "inbox" : "inboxes"}
            </span>
          </div>
          <button
            type="button"
            aria-label="Close"
            disabled={pending}
            onClick={beginClose}
            className={`flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors duration-150 hover:bg-muted/70 hover:text-foreground disabled:opacity-50`}
          >
            <X className="size-3.5" />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
          {capable.length === 0 ? (
            <p className="px-2 py-6 text-center text-[12px] text-muted-foreground">
              No warmup-capable inboxes.
            </p>
          ) : (
            <div className="flex flex-col">
              {capable.map((inbox) => {
                const blocked = Boolean(inbox.warmup?.isBlocked);
                const paused = inbox.warmup?.status?.toUpperCase() === "PAUSED";
                const disabled = blocked || paused;
                const current = inbox.warmup?.warmupKey ?? "";
                const value = draftFor(inbox);
                const dirty = value !== current;
                const invalid = invalidIds.has(inbox.id);
                const saving = busyMarker === `save:${inbox.id}`;
                const rotating = busyMarker === `rotate:${inbox.id}`;
                return (
                  <div key={inbox.id} className={`flex flex-col gap-1 rounded-md px-2 py-2 ${disabled ? "opacity-60" : ""}`}>
                    <div className="flex items-center gap-3">
                      <span title={inbox.fromEmail} className="min-w-0 flex-1 truncate text-[12.5px] font-medium">
                        {inbox.fromEmail}
                      </span>
                      {blocked ? (
                        <StatePill label="Blocked" />
                      ) : paused ? (
                        <span className="shrink-0 rounded bg-muted px-1.5 py-px text-[10px] font-medium text-muted-foreground">
                          Paused
                        </span>
                      ) : null}
                      <input
                        type="text"
                        value={value}
                        disabled={disabled || pending}
                        aria-label={`Warmup tag for ${inbox.fromEmail}`}
                        placeholder="group-broth"
                        spellCheck={false}
                        autoCapitalize="none"
                        onChange={(event) => {
                          const next = event.target.value.toLowerCase();
                          setDrafts((prev) => ({ ...prev, [inbox.id]: next }));
                          clearInvalid(inbox.id);
                        }}
                        onKeyDown={(event) => {
                          if (event.key === "Enter" && dirty && !disabled && !pending) saveRow(inbox);
                        }}
                        className={`h-7 w-40 shrink-0 rounded-md border bg-surface px-2 text-[12.5px] font-medium tabular-nums text-foreground shadow-xs outline-none transition focus:border-ring ${
                          invalid ? "border-destructive" : "border-border"
                        }`}
                      />
                      {dirty && !disabled ? (
                        <button
                          type="button"
                          disabled={pending}
                          onClick={() => saveRow(inbox)}
                          aria-label={`Save tag for ${inbox.fromEmail}`}
                          className={`${BTN_PRIMARY} h-7 shrink-0 px-2`}
                        >
                          {saving ? <Loader2 className="size-3.5 animate-spin" /> : <Check className="size-3.5" />}
                        </button>
                      ) : null}
                      <button
                        type="button"
                        disabled={disabled || pending}
                        onClick={() => rotateRow(inbox)}
                        data-tip="Roll a fresh tag for this inbox"
                        data-tip-down=""
                        aria-label={`Roll a fresh tag for ${inbox.fromEmail}`}
                        className={`inline-flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground/70 transition hover:text-foreground disabled:opacity-50`}
                      >
                        {rotating ? <Loader2 className="size-3.5 animate-spin" /> : <Dices className="size-3.5" />}
                      </button>
                    </div>
                    {invalid ? (
                      <p className="pl-1 text-[10.5px] text-destructive">
                        Two lowercase words joined by a hyphen, like group-broth.
                      </p>
                    ) : null}
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <div className="flex items-center justify-between gap-2 border-t border-border px-4 py-3">
          <button type="button" disabled={pending} onClick={beginClose} className={`${BTN_OUTLINE} h-8 px-3 text-[12px]`}>
            Cancel
          </button>
          <button
            type="button"
            disabled={pending || eligible.length === 0}
            onClick={rotateAll}
            className={`${BTN_PRIMARY} h-8 px-3 text-[12px]`}
          >
            {busyMarker === "all" ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />}
            {busyMarker === "all" ? "Rotating…" : "Rotate all"}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ── Bulk action bar (docks at the bottom of the list in select mode) ───── */
function BulkBar({
  count,
  campaigns,
  pending,
  onDailyLimit,
  onWarmup,
  onRotate,
  onAddCampaign,
  onClear,
}: {
  count: number;
  campaigns: CampaignInboxMapEntry[] | null;
  pending: boolean;
  onDailyLimit: (value: number) => void;
  onWarmup: (enabled: boolean) => void;
  onRotate: () => void;
  onAddCampaign: (campaignId: string) => void;
  onClear: () => void;
}) {
  const [panel, setPanel] = useState<"limit" | "campaign" | null>(null);
  const [limitValue, setLimitValue] = useState("100");
  const [campaignId, setCampaignId] = useState("");
  const campaignOptions = campaigns ? [...campaigns].sort((a, b) => a.name.localeCompare(b.name)) : [];

  const applyLimit = () => {
    const value = Number(limitValue);
    if (!Number.isInteger(value) || value < 1 || value > 2000) return;
    onDailyLimit(value);
  };

  return (
    <div className="flex shrink-0 flex-col gap-2 border-t border-border bg-surface px-3 py-2.5">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[12px] font-medium tabular-nums">{count} selected</span>
        <button
          type="button"
          onClick={onClear}
          className={`text-[11px] font-medium text-muted-foreground transition hover:text-foreground`}
        >
          Clear
        </button>
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        <button
          type="button"
          disabled={pending}
          onClick={() => setPanel((p) => (p === "limit" ? null : "limit"))}
          className={`${BTN_SUBTLE} h-7 px-2 text-[11px]`}
        >
          <Pencil className="size-3" />
          Daily limit
        </button>
        <button
          type="button"
          disabled={pending}
          onClick={() => onWarmup(true)}
          className={`${BTN_SUBTLE} h-7 px-2 text-[11px]`}
        >
          <Activity className="size-3" />
          Warmup on
        </button>
        <button
          type="button"
          disabled={pending}
          onClick={() => onWarmup(false)}
          className={`${BTN_SUBTLE} h-7 px-2 text-[11px]`}
        >
          <Minus className="size-3" />
          Warmup off
        </button>
        <button
          type="button"
          disabled={pending}
          onClick={onRotate}
          className={`${BTN_SUBTLE} h-7 px-2 text-[11px]`}
        >
          <RefreshCw className="size-3" />
          Rotate tags
        </button>
        {campaignOptions.length > 0 ? (
          <button
            type="button"
            disabled={pending}
            onClick={() => {
              setCampaignId(campaignOptions[0].campaignId);
              setPanel((p) => (p === "campaign" ? null : "campaign"));
            }}
            className={`${BTN_SUBTLE} h-7 px-2 text-[11px]`}
          >
            <Plus className="size-3" />
            Add to campaign
          </button>
        ) : null}
      </div>
      {panel === "limit" ? (
        <div className="flex items-center gap-1.5">
          <input
            type="number"
            min={1}
            max={2000}
            value={limitValue}
            disabled={pending}
            aria-label="Daily limit for selected inboxes"
            onChange={(event) => setLimitValue(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") applyLimit();
            }}
            className={`h-7 w-20 rounded-md border border-border bg-surface px-2 text-[12px] tabular-nums text-foreground shadow-xs outline-none transition focus:border-ring`}
          />
          <span className="text-[11px] text-muted-foreground">/day</span>
          <button type="button" disabled={pending} onClick={applyLimit} className={`${BTN_PRIMARY} h-7 px-2.5 text-[11px]`}>
            {pending ? <Loader2 className="size-3 animate-spin" /> : null}
            Apply
          </button>
        </div>
      ) : null}
      {panel === "campaign" && campaignOptions.length > 0 ? (
        <div className="flex items-center gap-1.5">
          <span className="relative flex-1">
            <select
              value={campaignId}
              disabled={pending}
              aria-label="Campaign to add selected inboxes to"
              onChange={(event) => setCampaignId(event.target.value)}
              className={`h-7 w-full appearance-none truncate rounded-md border border-border bg-surface pl-2 pr-6 text-[12px] text-foreground shadow-xs outline-none transition focus:border-ring`}
            >
              {campaignOptions.map((campaign) => (
                <option key={campaign.campaignId} value={campaign.campaignId}>
                  {campaign.name}
                </option>
              ))}
            </select>
            <ChevronDown className="pointer-events-none absolute right-1.5 top-1/2 size-3 -translate-y-1/2 text-muted-foreground" />
          </span>
          <button
            type="button"
            disabled={pending || !campaignId}
            onClick={() => onAddCampaign(campaignId)}
            className={`${BTN_PRIMARY} h-7 px-2.5 text-[11px]`}
          >
            {pending ? <Loader2 className="size-3 animate-spin" /> : null}
            Apply
          </button>
        </div>
      ) : null}
    </div>
  );
}

/* ── Header · Warmup activity (14-day aggregate across all inboxes) ─────── */
function aggregateSeries(series: Record<number, InboxWarmupStats>) {
  const byDate = new Map<string, { sent: number; reply: number; rescued: number }>();
  for (const stats of Object.values(series)) {
    for (const day of stats.byDate) {
      const entry = byDate.get(day.date) ?? { sent: 0, reply: 0, rescued: 0 };
      entry.sent += day.sentCount;
      entry.reply += day.replyCount;
      entry.rescued += day.saveFromSpamCount;
      byDate.set(day.date, entry);
    }
  }
  const sorted = [...byDate.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .slice(-14)
    .map(([date, value]) => ({ date, ...value }));
  // Smartlead pads the series with zero days on both ends — trim them (but
  // keep interior gaps) so the chart doesn't open with a run of empty columns.
  const first = sorted.findIndex((d) => d.sent > 0);
  if (first === -1) return [];
  let last = sorted.length - 1;
  while (last > first && sorted[last].sent === 0) last -= 1;
  return sorted.slice(first, last + 1);
}

/* ── Shared day-column chart: baseline, peak label, day axis, hover ─────── */
function DayColumnChart({
  days,
  max,
  timeLocale,
  height,
  rescueTicks = false,
}: {
  days: { date: string; sent: number; reply: number; rescued: number }[];
  max: number;
  timeLocale: string;
  height: string;
  rescueTicks?: boolean;
}) {
  // Axis labels on the first, middle, and last day — enough orientation
  // without a label per column.
  const labelIndexes = new Set(
    days.length > 4 ? [0, Math.floor((days.length - 1) / 2), days.length - 1] : days.map((_, i) => i),
  );
  return (
    // The baseline and axis hug the data: with few days the chart would
    // otherwise cluster bars on the left of a card-wide empty baseline.
    // Columns are NOT width-capped individually — the container is the only
    // width constraint, so bars and baseline always end together instead of
    // the baseline overhanging capped bars. (The peak is surfaced by callers
    // in the card header/summary, not floated over the bars.)
    <div className="flex flex-col gap-1" style={{ maxWidth: `${days.length * 52}px` }}>
      <div className={`relative flex ${height} items-end gap-[3px] border-b border-border/70 pt-3`}>
        {days.map((day, index) => {
          const total = max > 0 ? (day.sent / max) * 100 : 0;
          const replyPortion = day.sent > 0 ? (Math.min(day.reply, day.sent) / day.sent) * 100 : 0;
          return (
            <div
              key={day.date || index}
              title={`${formatDayLabel(day.date, timeLocale)} · ${day.sent} sent · ${day.reply} replies${
                day.rescued > 0 ? ` · ${day.rescued} rescued from spam` : ""
              }`}
              // h-full is load-bearing: without a definite column height the
              // percentage-height bars inside resolve to 0 and nothing paints.
              className="flex h-full flex-1 flex-col justify-end transition-opacity hover:opacity-75"
            >
              <div
                className="flex w-full flex-col justify-end overflow-hidden rounded-t-md bg-primary/25"
                style={{ height: `${Math.max(total, day.sent > 0 ? 4 : 1.5)}%` }}
              >
                <div className="w-full bg-primary" style={{ height: `${replyPortion}%` }} />
              </div>
            </div>
          );
        })}
      </div>
      {rescueTicks ? (
        <div className="flex gap-[3px]">
          {days.map((day, index) => (
            <div key={day.date || index} className="flex flex-1 justify-center">
              {day.rescued > 0 ? (
                <span title={`${day.rescued} rescued from spam`} className="size-1 rounded-full bg-destructive" />
              ) : null}
            </div>
          ))}
        </div>
      ) : null}
      <div className="flex gap-[3px]">
        {days.map((day, index) => (
          <div key={day.date || index} className="flex flex-1 justify-center">
            {labelIndexes.has(index) ? (
              <span className="whitespace-nowrap text-[9.5px] tabular-nums text-muted-foreground/70">
                {formatDayLabel(day.date, timeLocale)}
              </span>
            ) : null}
          </div>
        ))}
      </div>
    </div>
  );
}

function BandCount({ value, label, className }: { value: number; label: string; className: string }) {
  return (
    <span className={`flex items-baseline gap-1 font-medium tabular-nums ${className}`}>
      {value}
      <span className="text-[9.5px] font-medium uppercase tracking-wide text-muted-foreground">{label}</span>
    </span>
  );
}

/* ── Health donut (workspace grade mix) ────────────────────────────────── */
function HealthDonut({
  counts,
  checked,
  placeholder,
  centerText,
  size = 64,
  stroke = 8,
}: {
  counts: { healthy: number; attention: number; risk: number };
  checked: number;
  placeholder: boolean;
  centerText: string;
  size?: number;
  stroke?: number;
}) {
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  const segments = [
    { n: counts.healthy, color: "var(--success)" },
    { n: counts.attention, color: "var(--warning)" },
    { n: counts.risk, color: "var(--destructive)" },
  ].filter((s) => s.n > 0);

  let offset = 0;
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="shrink-0" aria-hidden>
      <circle cx={size / 2} cy={size / 2} r={radius} fill="none" stroke="var(--muted)" strokeWidth={stroke} />
      {!placeholder && checked > 0
        ? segments.map((segment, index) => {
            const length = (segment.n / checked) * circumference;
            const element = (
              <circle
                key={index}
                cx={size / 2}
                cy={size / 2}
                r={radius}
                fill="none"
                stroke={segment.color}
                strokeWidth={stroke}
                strokeDasharray={`${length} ${circumference - length}`}
                strokeDashoffset={-offset}
                transform={`rotate(-90 ${size / 2} ${size / 2})`}
              />
            );
            offset += length;
            return element;
          })
        : null}
      <text
        x="50%"
        y="50%"
        dominantBaseline="central"
        textAnchor="middle"
        className="fill-foreground text-[12px] font-semibold tabular-nums"
      >
        {centerText}
      </text>
    </svg>
  );
}

/* ── Header micro-stats: at-a-glance workspace pulse, visible even while a
   detail view is open. Status colors carry state; every mark sits next to a
   text value so nothing is color-alone. Clicking returns to the Overview. ── */
function HeaderStats({
  inboxes,
  series,
  sendStats,
  counts,
  checked,
  connectionIssues,
  missingPhotos,
  onShowOverview,
}: {
  inboxes: InboxAccount[];
  series: Record<number, InboxWarmupStats> | null;
  sendStats: WorkspaceSendStats | null;
  counts: { healthy: number; attention: number; risk: number };
  checked: number;
  connectionIssues: number;
  missingPhotos: number;
  onShowOverview: () => void;
}) {
  const days = series ? aggregateSeries(series) : [];
  const warmupSent = days.reduce((sum, day) => sum + day.sent, 0);

  const scored = inboxes
    .map((inbox) => effectiveReputation(inbox.warmup))
    .filter((value): value is number => value !== null);
  const high = scored.filter((value) => value >= 90).length;
  const mid = scored.filter((value) => value >= 75 && value < 90).length;
  const low = scored.filter((value) => value < 75).length;
  const avg = scored.length > 0 ? Math.round(scored.reduce((sum, value) => sum + value, 0) / scored.length) : null;

  const divider = <span aria-hidden className="h-6 w-px bg-border" />;

  return (
    <button
      type="button"
      onClick={onShowOverview}
      data-tip="Open the workspace overview"
      data-tip-down=""
      className={`hidden items-center gap-3.5 rounded-md px-2.5 py-1 transition-colors hover:bg-muted/50 has-[[data-tip]:hover]:after:hidden xl:flex`}
    >
      {days.length > 1 ? (
        <>
          <HeaderStat
            label={`Warmup · ${days.length}d`}
            title={`${warmupSent.toLocaleString()} warmup emails sent across all inboxes in the last ${days.length} days`}
          >
            <MicroTrend values={days.map((day) => day.sent)} />
            <span className="text-[11px] font-medium tabular-nums text-foreground">
              {warmupSent.toLocaleString()} sent
            </span>
          </HeaderStat>
          {divider}
        </>
      ) : null}

      {sendStats ? (
        <>
          <HeaderStat
            label={`Campaigns · ${sendStats.days}d`}
            title={`${sendStats.sent.toLocaleString()} campaign emails sent · ${sendStats.replies.toLocaleString()} replies · ${sendStats.bounces.toLocaleString()} bounced, across ${sendStats.campaigns} ${sendStats.campaigns === 1 ? "campaign" : "campaigns"} in the last ${sendStats.days} days`}
          >
            <span className="text-[11px] font-medium tabular-nums text-foreground">
              {sendStats.sent.toLocaleString()} sent
            </span>
            <span className="text-[11px] tabular-nums text-muted-foreground">
              · {sendStats.replies.toLocaleString()} {sendStats.replies === 1 ? "reply" : "replies"}
            </span>
          </HeaderStat>
          {divider}
        </>
      ) : null}

      <HeaderStat
        label="Health score"
        title={
          avg !== null
            ? `Average warmup health score across ${scored.length} inboxes: ${high} at 90 or above, ${mid} between 75 and 89, ${low} below 75`
            : "Warmup health scores unavailable"
        }
      >
        <span className="flex h-1.5 w-12 overflow-hidden rounded-full bg-muted">
          {scored.length > 0 ? (
            <>
              {high > 0 ? <span className="bg-success" style={{ width: `${(high / scored.length) * 100}%` }} /> : null}
              {mid > 0 ? <span className="bg-warning" style={{ width: `${(mid / scored.length) * 100}%` }} /> : null}
              {low > 0 ? <span className="bg-destructive" style={{ width: `${(low / scored.length) * 100}%` }} /> : null}
            </>
          ) : null}
        </span>
        <span className="text-[11px] font-medium tabular-nums text-foreground">
          {avg !== null ? `${avg} avg` : "—"}
        </span>
      </HeaderStat>
      {divider}

      <HeaderStat
        label="Deliverability check"
        title={
          checked > 0
            ? `${counts.healthy} healthy · ${counts.attention} need attention · ${counts.risk} at risk, of ${checked} inboxes checked`
            : "No deliverability check yet. Run one from the overview"
        }
      >
        <HealthDonut counts={counts} checked={checked} placeholder={checked === 0} centerText="" size={18} stroke={3.5} />
        <span className="text-[11px] font-medium tabular-nums text-foreground">
          {checked > 0 ? `${counts.healthy}/${checked} healthy` : "not run yet"}
        </span>
      </HeaderStat>

      {connectionIssues > 0 ? (
        <>
          {divider}
          <HeaderStat label="Issues" title="Inboxes with SMTP or IMAP failures">
            <AlertTriangle className="size-3 text-warning" />
            <span className="text-[11px] font-medium tabular-nums text-warning">
              {connectionIssues} {connectionIssues === 1 ? "inbox" : "inboxes"}
            </span>
          </HeaderStat>
        </>
      ) : null}

      {missingPhotos > 0 ? (
        <>
          {divider}
          <HeaderStat
            label="Profile photos"
            title="Sending accounts without a profile picture — set them in Zapmail so campaigns never send faceless"
          >
            <ImageOff className="size-3 text-warning" />
            <span className="text-[11px] font-medium tabular-nums text-warning">
              {missingPhotos} missing
            </span>
          </HeaderStat>
        </>
      ) : null}
    </button>
  );
}

/** One labeled header stat: a tiny caption over the mark + value row. */
function HeaderStat({ label, title, children }: { label: string; title: string; children: ReactNode }) {
  return (
    <span className="flex flex-col items-start gap-0.5" data-tip={title} data-tip-down="">
      <span className="text-[8.5px] font-semibold uppercase leading-none tracking-[0.08em] text-muted-foreground/70">
        {label}
      </span>
      <span className="flex h-4 items-center gap-1.5">{children}</span>
    </span>
  );
}

/** Bare trend polyline (56×16) for the header — single series, no axes.
    The y scale spans the data's own min–max (sparkline convention: the line
    shows shape, the number beside it shows magnitude) — a zero baseline would
    squash a tight band of values into a flat line hugging the top edge. */
function MicroTrend({ values }: { values: number[] }) {
  const width = 56;
  const height = 16;
  const pad = 2;
  const max = Math.max(...values);
  const min = Math.min(...values);
  const span = max - min;
  const points = values
    .map((value, index) => {
      const x = (index / (values.length - 1)) * (width - 2) + 1;
      const y = span === 0 ? height / 2 : height - pad - ((value - min) / span) * (height - pad * 2);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} className="shrink-0" aria-hidden>
      <polyline
        points={points}
        fill="none"
        stroke="var(--primary)"
        strokeWidth={1.25}
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  );
}

/* ── Row sparkline (7-day sentCount polyline) ──────────────────────────── */
function Sparkline({ series }: { series: InboxWarmupStats }) {
  const days = [...series.byDate].sort((a, b) => a.date.localeCompare(b.date)).slice(-7);
  if (days.length < 2) return null;
  const width = 44;
  const height = 14;
  const max = Math.max(1, ...days.map((d) => d.sentCount));
  const points = days
    .map((day, index) => {
      const x = (index / (days.length - 1)) * (width - 2) + 1;
      const y = height - 1 - (day.sentCount / max) * (height - 2);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} className="shrink-0" aria-hidden>
      <polyline
        points={points}
        fill="none"
        stroke="var(--primary)"
        strokeWidth={1.25}
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  );
}

/* ── Master row (two lines) ───────────────────────────────────────────── */
/* Tiny roster avatar: the real Zapmail profile picture when set, else a
   dashed placeholder ring - the contrast makes a missing image obvious at a
   glance, which is the point (verify every inbox has one). */
function InboxRowAvatar({ src, verified = true }: { src: string | null; verified?: boolean }) {
  const [broken, setBroken] = useState(false);
  if (src && !broken) {
    return (
      // eslint-disable-next-line @next/next/no-img-element -- external CDN avatar with graceful fallback
      <img src={src} alt="" onError={() => setBroken(true)} className="size-5 shrink-0 rounded-full object-cover" />
    );
  }
  if (!verified) {
    // Zapmail unreachable: the picture's existence is unknown, not missing.
    return (
      <span
        data-tip="Profile picture unavailable — couldn't reach Zapmail"
        data-tip-down=""
        className="flex size-5 shrink-0 items-center justify-center rounded-full bg-muted/70"
      >
        <ImageOff aria-hidden className="size-2.5 text-muted-foreground/70" />
      </span>
    );
  }
  return (
    <span
      data-tip="No profile picture — set one in Zapmail"
      data-tip-down=""
      className="flex size-5 shrink-0 items-center justify-center rounded-full border border-dashed border-warning bg-warning-soft/60"
    >
      <ImageOff aria-hidden className="size-2.5 text-warning" />
    </span>
  );
}

function InboxRow({
  inbox,
  limit,
  active,
  report,
  series,
  avatarSrc,
  avatarVerified,
  timeline,
  timeZone,
  timeLocale,
  selectMode,
  selected,
  onSelect,
  onToggleSelect,
}: {
  inbox: InboxAccount;
  limit: number | null;
  active: boolean;
  report: HealthReport | undefined;
  series: InboxWarmupStats | undefined;
  avatarSrc: string | null;
  avatarVerified: boolean;
  timeline: WarmupTimeline | null;
  timeZone: string;
  timeLocale: string;
  selectMode: boolean;
  selected: boolean;
  onSelect: () => void;
  onToggleSelect: () => void;
}) {
  const accent =
    report?.grade === "risk"
      ? "border-l-destructive"
      : report?.grade === "attention"
        ? "border-l-warning"
        : "border-l-transparent";
  const blocked = Boolean(inbox.warmup?.isBlocked);
  // In select mode the row toggles selection and highlights from the selection
  // set; otherwise it opens the detail and highlights the active inbox.
  const highlighted = selectMode ? selected : active;

  return (
    <button
      type="button"
      onClick={selectMode ? onToggleSelect : onSelect}
      aria-current={!selectMode && active ? "true" : undefined}
      aria-pressed={selectMode ? selected : undefined}
      className={`flex flex-col gap-1 rounded-md border-l-2 py-2 pl-2 pr-2.5 text-left transition-colors ${accent} ${
        highlighted ? "bg-accent text-accent-foreground" : "hover:bg-muted/60"
      }`}
    >
      <div className="flex items-center gap-2">
        {selectMode ? (
          <span
            aria-hidden
            className={`flex size-3.5 shrink-0 items-center justify-center rounded border transition ${
              selected ? "border-primary bg-primary text-primary-foreground" : "border-border bg-surface"
            }`}
          >
            {selected ? <Check className="size-2.5" strokeWidth={3} /> : null}
          </span>
        ) : null}
        <InboxRowAvatar src={avatarSrc} verified={avatarVerified} />
        <span title={inbox.fromEmail} className="min-w-0 flex-1 truncate text-[12.5px] font-medium">{inbox.fromEmail}</span>
        {timeline && !timeline.ready && !inbox.isSuspended && inbox.warmup?.status?.toUpperCase() !== "PAUSED" ? (
          <span
            data-tip={`Warming up: day ${timeline.day} of ${timeline.totalDays} · campaign-ready ${formatDay(timeline.readyAtMs, timeZone, timeLocale)}`}
            data-tip-down=""
            className="shrink-0 rounded bg-muted px-1.5 py-px text-[10px] font-medium tabular-nums text-muted-foreground"
          >
            day {timeline.day}/{timeline.totalDays}
          </span>
        ) : null}
        <ReputationBadge value={effectiveReputation(inbox.warmup)} pending={warmupPending(inbox.warmup)} />
      </div>
      <div className="flex items-center gap-2">
        <CombinedConnDot inbox={inbox} />
        {inbox.isSuspended ? (
          <StatePill label="Suspended" />
        ) : blocked ? (
          <StatePill label="Blocked" />
        ) : series ? (
          <Sparkline series={series} />
        ) : null}
        {limit !== null ? (
          <span className="ml-auto text-[10.5px] tabular-nums text-muted-foreground">{limit}/day</span>
        ) : null}
      </div>
    </button>
  );
}

/* ── Detail panel (signal first: health · warmup · campaigns) ─────────── */
function InboxDetail({
  inbox,
  timeline,
  report,
  stats,
  statsState,
  campaigns,
  availableCampaigns,
  limitOverride,
  warmupOverride,
  onClose,
  onSaveLimit,
  onSaveWarmup,
  onSaveIdentity,
  onRemoveCampaign,
  onAddCampaign,
  limitBusy,
  warmupBusy,
  identityBusy,
  addCampaignBusy,
  removingCampaignId,
  manageDisabled,
  onRetryStats,
  onRunHealth,
  healthBusy,
  healthDisabled,
  timeZone,
  timeLocale,
}: {
  inbox: InboxAccount;
  timeline: WarmupTimeline | null;
  report: HealthReport | undefined;
  stats: InboxWarmupStats | undefined;
  statsState: "loading" | "error" | undefined;
  campaigns: CampaignInboxMapEntry[] | null;
  availableCampaigns: CampaignInboxMapEntry[] | null;
  limitOverride: number | undefined;
  warmupOverride: WarmupOverride | undefined;
  onClose: () => void;
  onSaveLimit: (value: number, onDone: () => void) => void;
  onSaveWarmup: (settings: WarmupOverride, onDone: () => void) => void;
  onSaveIdentity: (patch: InboxIdentityPatch, onDone: () => void) => void;
  onRemoveCampaign: (campaignId: string, onDone: () => void) => void;
  onAddCampaign: (campaignId: string, onDone: () => void) => void;
  limitBusy: boolean;
  warmupBusy: boolean;
  identityBusy: boolean;
  addCampaignBusy: boolean;
  removingCampaignId: string | null;
  manageDisabled: boolean;
  onRetryStats: () => void;
  onRunHealth: () => void;
  healthBusy: boolean;
  healthDisabled: boolean;
  timeZone: string;
  timeLocale: string;
}) {
  const warmup = applyWarmupOverride(inbox.warmup, warmupOverride);
  const effectiveLimit = limitOverride ?? inbox.messagePerDay;

  return (
    <div className="mx-auto flex w-full max-w-[1060px] flex-col gap-5 px-5 py-6">
      {/* ── Identity header: who it is on top, facts as a labeled stat strip
             (the same grammar the cards use) instead of a run-on meta line. ── */}
      <div className="flex flex-col gap-3">
        <div className="flex items-start justify-between gap-3">
          <div className="flex min-w-0 flex-col gap-0.5">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-[15px] font-semibold tracking-tight">{inbox.fromEmail}</h2>
              {inbox.isSuspended ? (
                <span className="rounded bg-destructive-soft px-1.5 py-px text-[10px] font-semibold uppercase tracking-wide text-destructive">
                  Suspended
                </span>
              ) : null}
            </div>
            <p className="text-[12px] text-muted-foreground">
              {[inbox.fromName.trim(), inbox.provider ? titleCaseProvider(inbox.provider) : null]
                .filter(Boolean)
                .join(" · ")}
            </p>
          </div>
          <button
            type="button"
            aria-label="Close inbox detail"
            onClick={onClose}
            className={`flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted/70 hover:text-foreground`}
          >
            <X className="size-4" />
          </button>
        </div>
        <div className="flex flex-wrap items-start gap-x-7 gap-y-2">
          <Stat label="Connection">
            <span className="inline-flex items-center gap-2 text-[12.5px] font-medium">
              <ConnDot label="SMTP" ok={inbox.smtpOk} error={inbox.smtpError} />
              <ConnDot label="IMAP" ok={inbox.imapOk} error={inbox.imapError} />
            </span>
          </Stat>
          {effectiveLimit !== null ? (
            <Stat label="Daily limit">
              <DailyLimitControl
                limit={effectiveLimit}
                busy={limitBusy}
                disabled={manageDisabled}
                onSave={onSaveLimit}
              />
            </Stat>
          ) : null}
          <Stat label="Sent today">
            <span className="text-[12.5px] font-medium tabular-nums">{inbox.dailySentCount}</span>
          </Stat>
          <Stat label="Tracking domain">
            {inbox.customTrackingDomain?.trim() ? (
              <span
                title={inbox.customTrackingDomain}
                className="max-w-[220px] truncate text-[12.5px] font-medium"
              >
                {inbox.customTrackingDomain}
              </span>
            ) : (
              <span className="text-[12.5px] font-medium text-muted-foreground">None</span>
            )}
          </Stat>
        </div>
        {inbox.tags.length > 0 ? (
          <div className="flex flex-wrap items-center gap-1">
            {inbox.tags.map((tag, index) => (
              <span
                key={`${tag}-${index}`}
                className="rounded border border-border bg-surface px-1.5 py-px text-[10px] font-medium text-muted-foreground"
              >
                {tag}
              </span>
            ))}
          </div>
        ) : null}
      </div>

      {/* Health and warmup sit side by side once the viewport affords it —
          equal-height cards (grid default stretch) so the pair reads as one row. */}
      <div className="grid gap-5 xl:grid-cols-2">
      {/* ── Health card (promoted to top) ── */}
      <Card title="Health" fill>
        {!report ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 py-1">
            <HealthGauge placeholder />
            <button type="button" disabled={healthDisabled} onClick={onRunHealth} className={`${BTN_PRIMARY} h-8 px-3 text-[12px]`}>
              {healthBusy ? <Loader2 className="size-3.5 animate-spin" /> : <Activity className="size-3.5" />}
              {healthBusy ? "Checking…" : "Run health check"}
            </button>
          </div>
        ) : (
          <div className="flex flex-col gap-4">
            <div className="flex items-center gap-3">
              <HealthGauge score={report.score} grade={report.grade} />
              <div className="flex flex-col gap-1.5">
                <GradeChip grade={report.grade} />
                <span className="text-[11px] text-muted-foreground">
                  Checked {formatTimestamp(report.checkedAt, timeZone, timeLocale)}
                </span>
              </div>
              <button
                type="button"
                disabled={healthDisabled}
                onClick={onRunHealth}
                className={`${BTN_SUBTLE} ml-auto h-7 px-2.5 text-[11.5px]`}
              >
                {healthBusy ? <Loader2 className="size-3 animate-spin" /> : <Activity className="size-3" />}
                {healthBusy ? "Checking…" : "Re-run"}
              </button>
            </div>

            <div className="flex flex-col gap-2">
              {report.categories.map((category) => (
                <CategoryDisclosure key={category.key} category={category} />
              ))}
            </div>
          </div>
        )}
      </Card>

      {/* ── Warmup card ── */}
      <WarmupCard
        warmup={warmup}
        timeline={timeline}
        stats={stats}
        statsState={statsState}
        onRetryStats={onRetryStats}
        onSave={onSaveWarmup}
        busy={warmupBusy}
        disabled={manageDisabled}
        timeZone={timeZone}
        timeLocale={timeLocale}
      />
      </div>

      {/* ── Sending identity card (full width) ── */}
      <SendingIdentityCard
        inbox={inbox}
        onSave={onSaveIdentity}
        busy={identityBusy}
        disabled={manageDisabled}
      />

      {/* ── Campaigns card (hidden until the map loads) ── */}
      {campaigns !== null ? (
        <Card title="Campaigns">
          <div className="flex flex-col gap-3">
            {campaigns.length === 0 ? (
              <p className="text-[12px] text-muted-foreground">Not assigned to any campaign.</p>
            ) : (
              <div className="flex flex-col">
                {campaigns.map((campaign) => (
                  <CampaignRow
                    key={campaign.campaignId}
                    campaign={campaign}
                    onRemove={onRemoveCampaign}
                    busy={removingCampaignId === campaign.campaignId}
                    disabled={manageDisabled}
                  />
                ))}
              </div>
            )}
            <AddToCampaign
              available={availableCampaigns}
              onAdd={onAddCampaign}
              busy={addCampaignBusy}
              disabled={manageDisabled}
            />
          </div>
        </Card>
      ) : null}
    </div>
  );
}

/* ── Inline daily-limit editor (identity header) ──────────────────────────
   Quiet pencil swaps the "{limit}/day · {sent} sent today" span for a compact
   number field; the parent owns the transition and applies the override. */
function DailyLimitControl({
  limit,

  busy,
  disabled,
  onSave,
}: {
  limit: number;

  busy: boolean;
  disabled: boolean;
  onSave: (value: number, onDone: () => void) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(String(limit));
  const [invalid, setInvalid] = useState(false);

  const open = () => {
    setValue(String(limit));
    setInvalid(false);
    setEditing(true);
  };
  const submit = () => {
    const next = Number(value);
    if (!Number.isInteger(next) || next < 1 || next > 2000) {
      // A dead Save button with no feedback reads as broken.
      setInvalid(true);
      return;
    }
    setInvalid(false);
    onSave(next, () => setEditing(false));
  };

  if (!editing) {
    return (
      <span className="inline-flex items-center gap-1 text-[12.5px] font-medium tabular-nums">
        {limit}/day
        <button
          type="button"
          onClick={open}
          disabled={disabled}
          data-tip="Edit daily limit"
          data-tip-down=""
          aria-label="Edit daily limit"
          className={`inline-flex size-4 items-center justify-center rounded text-muted-foreground/70 transition hover:text-foreground disabled:opacity-50`}
        >
          <Pencil className="size-3" />
        </button>
      </span>
    );
  }

  return (
    <span className="inline-flex items-center gap-1">
      <input
        type="number"
        min={1}
        max={2000}
        value={value}
        autoFocus
        aria-label="Daily limit"
        disabled={busy}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") submit();
          if (event.key === "Escape") setEditing(false);
        }}
        className={`h-6 w-16 rounded-md border border-border bg-surface px-1.5 text-[12px] tabular-nums text-foreground shadow-xs outline-none transition focus:border-ring`}
      />
      <span className="text-[11px] text-muted-foreground">/day</span>
      <button type="button" disabled={busy || disabled} onClick={submit} className={`${BTN_PRIMARY} h-6 px-2 text-[11px]`}>
        {busy ? <Loader2 className="size-3 animate-spin" /> : "Save"}
      </button>
      <button type="button" disabled={busy} onClick={() => setEditing(false)} className={`${BTN_SUBTLE} h-6 px-2 text-[11px]`}>
        Cancel
      </button>
      {invalid ? <span className="text-[11px] text-destructive">1–2000</span> : null}
    </span>
  );
}

/* ── Warmup toggle (settings switch idiom) ────────────────────────────── */
function WarmupToggle({ checked, onChange, disabled }: { checked: boolean; onChange: (next: boolean) => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label="Warmup enabled"
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative h-[18px] w-8 shrink-0 rounded-full transition disabled:opacity-50 ${
        checked ? "bg-primary" : "bg-muted"
      }`}
    >
      <span
        className={`absolute top-[2px] size-[14px] rounded-full bg-surface shadow-xs transition-all ${
          checked ? "left-[16px]" : "left-[2px]"
        }`}
      />
    </button>
  );
}

/* ── Warmup card (read view · edit form · enable path) ────────────────── */
function WarmupCard({
  warmup,
  timeline,
  stats,
  statsState,
  onRetryStats,
  onSave,
  busy,
  disabled,
  timeZone,
  timeLocale,
}: {
  warmup: InboxWarmup | null;
  timeline: WarmupTimeline | null;
  stats: InboxWarmupStats | undefined;
  statsState: "loading" | "error" | undefined;
  onRetryStats: () => void;
  onSave: (settings: WarmupOverride, onDone: () => void) => void;
  busy: boolean;
  disabled: boolean;
  timeZone: string;
  timeLocale: string;
}) {
  const [editing, setEditing] = useState(false);
  const enabledDefault = warmup ? warmup.status?.toUpperCase() !== "PAUSED" : true;
  const [form, setForm] = useState({
    enabled: enabledDefault,
    totalPerDay: String(warmup?.warmupMaxCount ?? 15),
    replyRatePercent: String(warmup?.replyRatePercent ?? 27),
  });

  const [formError, setFormError] = useState<string | null>(null);

  const openEdit = (enabled: boolean) => {
    setForm({
      enabled,
      totalPerDay: String(warmup?.warmupMaxCount ?? 15),
      replyRatePercent: String(warmup?.replyRatePercent ?? 27),
    });
    setFormError(null);
    setEditing(true);
  };
  const submit = () => {
    const totalPerDay = Number(form.totalPerDay);
    const replyRatePercent = Number(form.replyRatePercent);
    // A dead Save button with no feedback reads as broken — name the range.
    if (!Number.isInteger(totalPerDay) || totalPerDay < 1 || totalPerDay > 200) {
      setFormError("Warmup emails/day must be 1–200.");
      return;
    }
    if (!Number.isInteger(replyRatePercent) || replyRatePercent < 0 || replyRatePercent > 100) {
      setFormError("Reply rate must be 0–100.");
      return;
    }
    setFormError(null);
    onSave({ enabled: form.enabled, totalPerDay, replyRatePercent }, () => setEditing(false));
  };

  const editAction =
    warmup && !editing ? (
      <button type="button" disabled={disabled} onClick={() => openEdit(enabledDefault)} className={`${BTN_SUBTLE} h-7 px-2.5 text-[11.5px]`}>
        Edit
      </button>
    ) : null;

  return (
    <Card title="Warmup" action={editAction} fill>
      {editing ? (
        <div className="flex flex-col gap-3">
          <div className="flex items-center justify-between gap-3">
            <span className="text-[11.5px] font-medium text-foreground">Enabled</span>
            <WarmupToggle checked={form.enabled} disabled={busy} onChange={(next) => setForm((prev) => ({ ...prev, enabled: next }))} />
          </div>
          <div className="flex flex-wrap gap-4">
            <label className="flex flex-col gap-1">
              <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Warmup emails/day</span>
              <input
                type="number"
                min={1}
                max={200}
                value={form.totalPerDay}
                disabled={busy}
                aria-label="Warmup emails per day"
                onChange={(event) => setForm((prev) => ({ ...prev, totalPerDay: event.target.value }))}
                className={`h-8 w-24 rounded-md border border-border bg-surface px-2 text-[12.5px] tabular-nums text-foreground shadow-xs outline-none transition focus:border-ring`}
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Reply rate %</span>
              <input
                type="number"
                min={0}
                max={100}
                value={form.replyRatePercent}
                disabled={busy}
                aria-label="Reply rate percent"
                onChange={(event) => setForm((prev) => ({ ...prev, replyRatePercent: event.target.value }))}
                className={`h-8 w-24 rounded-md border border-border bg-surface px-2 text-[12.5px] tabular-nums text-foreground shadow-xs outline-none transition focus:border-ring`}
              />
            </label>
          </div>
          <p className="text-[11px] text-muted-foreground">Ramp-up pacing is managed by Smartlead.</p>
          {formError ? <p className="text-[11px] text-destructive">{formError}</p> : null}
          <div className="flex items-center gap-1.5">
            <button type="button" disabled={busy || disabled} onClick={submit} className={`${BTN_PRIMARY} h-7 px-3 text-[11.5px]`}>
              {busy ? <Loader2 className="size-3.5 animate-spin" /> : null}
              {busy ? "Saving…" : "Save"}
            </button>
            <button type="button" disabled={busy} onClick={() => setEditing(false)} className={`${BTN_SUBTLE} h-7 px-2.5 text-[11.5px]`}>
              Cancel
            </button>
          </div>
        </div>
      ) : warmup ? (
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
            {warmup.status ? (
              <Stat label="Status">
                <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium capitalize text-foreground">
                  {warmup.status.toLowerCase()}
                </span>
              </Stat>
            ) : null}
            <Stat label="Health score">
              <ReputationBadge value={effectiveReputation(warmup)} pending={warmupPending(warmup)} />
            </Stat>
            {timeline ? (
              <Stat label="Warmup window">
                <span
                  data-tip={`Warming since ${formatDay(timeline.startedAtMs, timeZone, timeLocale)}`}
                  className="text-[12.5px] font-medium tabular-nums"
                >
                  {timeline.ready
                    ? `complete (${timeline.totalDays} days)`
                    : `day ${timeline.day} of ${timeline.totalDays} · ready ${formatDay(timeline.readyAtMs, timeZone, timeLocale)}`}
                </span>
              </Stat>
            ) : null}
            {warmup.warmupMinCount !== null && warmup.warmupMaxCount !== null ? (
              <Stat label="Send window">
                <span className="text-[12.5px] font-medium tabular-nums">
                  {warmup.warmupMinCount}–{warmup.warmupMaxCount}/day
                </span>
              </Stat>
            ) : null}
            {warmup.replyRatePercent !== null ? (
              <Stat label="Reply rate">
                <span className="text-[12.5px] font-medium tabular-nums">{warmup.replyRatePercent}%</span>
              </Stat>
            ) : null}
          </div>

          {warmup.isBlocked ? (
            <div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive-soft px-3 py-2 text-[11.5px] leading-relaxed text-destructive">
              <Ban className="mt-0.5 size-3.5 shrink-0" />
              <span>{warmup.blockedReason?.trim() || "This inbox is currently blocked from warmup."}</span>
            </div>
          ) : null}

          {/* Placement share (only meaningful once a real sample exists) */}
          {stats && stats.sentCount >= 10
            ? (() => {
                const pct = Math.round((Math.min(stats.inboxCount, stats.sentCount) / stats.sentCount) * 100);
                return (
                  <div className="flex flex-col gap-1">
                    <div className="flex h-2.5 overflow-hidden rounded-full bg-destructive-soft">
                      <div className="bg-primary" style={{ width: `${pct}%` }} />
                    </div>
                    <span className="text-[12px] tabular-nums text-muted-foreground">{pct}% inboxed</span>
                  </div>
                );
              })()
            : null}

          {/* 14-day warmup activity */}
          {stats || statsState ? (
            <div className="rounded-lg border border-border bg-subtle/60 px-3 py-3">
              {statsState === "loading" && !stats ? (
                <SkeletonChart height="h-24" bars={14} />
              ) : statsState === "error" && !stats ? (
                <div className="flex items-center justify-between gap-3">
                  <span className="text-[11.5px] text-muted-foreground">Couldn&rsquo;t load warmup activity.</span>
                  <button type="button" onClick={onRetryStats} className={`${BTN_OUTLINE} h-7 px-2.5 text-[11.5px]`}>
                    Retry
                  </button>
                </div>
              ) : stats ? (
                <WarmupActivity stats={stats} timeLocale={timeLocale} />
              ) : null}
            </div>
          ) : null}
        </div>
      ) : (
        <div className="flex flex-col items-start gap-2">
          <p className="text-[12px] text-muted-foreground">Warmup is not enabled for this inbox.</p>
          <button type="button" disabled={disabled} onClick={() => openEdit(true)} className={`${BTN_OUTLINE} h-7 px-2.5 text-[11.5px]`}>
            Enable warmup
          </button>
        </div>
      )}
    </Card>
  );
}

/* ── Sending identity card (dirty-diff form) ──────────────────────────────
   From name, signature, BCC, custom tracking domain, and per-send wait, edited
   in place. The save bar appears only when something differs from the seeded
   baseline, and a save sends ONLY the changed fields. Baseline + form are
   plain state seeded from the account on mount (the parent re-keys the detail
   per inbox, so switching inboxes reseeds); dirtiness and the light validity
   hints are derived at render, never synced through an effect. */
const IDENTITY_LABEL = "text-[10px] font-semibold uppercase tracking-wide text-muted-foreground";
const IDENTITY_CAPTION = "text-[11px] leading-relaxed text-muted-foreground";
// Deliberately lenient: a clear "this is not an address" check, not RFC 5322.
// The server holds the authoritative rule and rejects anything malformed.
const BCC_EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

type IdentityForm = {
  fromName: string;
  signature: string;
  bcc: string;
  trackingDomain: string;
  waitMins: string;
};

function seedIdentityForm(inbox: InboxAccount): IdentityForm {
  return {
    fromName: inbox.fromName,
    signature: inbox.signature,
    bcc: inbox.bcc,
    trackingDomain: inbox.customTrackingDomain ?? "",
    waitMins: inbox.timeToWaitMins === null ? "" : String(inbox.timeToWaitMins),
  };
}

function SendingIdentityCard({
  inbox,
  onSave,
  busy,
  disabled,
}: {
  inbox: InboxAccount;
  onSave: (patch: InboxIdentityPatch, onDone: () => void) => void;
  busy: boolean;
  disabled: boolean;
}) {
  const [baseline, setBaseline] = useState<IdentityForm>(() => seedIdentityForm(inbox));
  const [form, setForm] = useState<IdentityForm>(() => seedIdentityForm(inbox));
  const [formError, setFormError] = useState<string | null>(null);

  const setField = (field: keyof IdentityForm, value: string) => {
    setForm((prev) => ({ ...prev, [field]: value }));
    setFormError(null);
  };

  // Derived at render — no effect keeps the compiler happy and dirtiness exact.
  const dirty =
    form.fromName !== baseline.fromName ||
    form.signature !== baseline.signature ||
    form.bcc !== baseline.bcc ||
    form.trackingDomain !== baseline.trackingDomain ||
    form.waitMins !== baseline.waitMins;
  const bccTrimmed = form.bcc.trim();
  const bccInvalid = bccTrimmed !== "" && !BCC_EMAIL_PATTERN.test(bccTrimmed);

  const submit = () => {
    const patch: InboxIdentityPatch = {};
    // What the form should read after a successful save (normalized values).
    const saved = { ...form };

    if (form.fromName !== baseline.fromName) {
      const name = form.fromName.trim();
      if (name.length < 1 || name.length > 100) {
        setFormError("From name must be 1 to 100 characters.");
        return;
      }
      patch.fromName = name;
    }
    if (form.signature !== baseline.signature) {
      if (form.signature.length > 10_000) {
        setFormError("Signature must be 10000 characters or fewer.");
        return;
      }
      patch.signature = form.signature;
    }
    if (form.bcc !== baseline.bcc) {
      if (bccTrimmed !== "" && !BCC_EMAIL_PATTERN.test(bccTrimmed)) {
        setFormError("Enter a valid BCC email, or leave it empty.");
        return;
      }
      patch.bcc = bccTrimmed;
    }
    if (form.trackingDomain !== baseline.trackingDomain) {
      // Smartlead reads this back as a bare domain; normalize a pasted URL so
      // the optimistic override matches what a refetch would return.
      const bare = form.trackingDomain
        .trim()
        .replace(/^[a-z]+:\/\//i, "")
        .split("/")[0]
        .trim();
      saved.trackingDomain = bare;
      patch.customTrackingUrl = bare;
    }
    if (form.waitMins !== baseline.waitMins) {
      const mins = Number(form.waitMins);
      if (form.waitMins.trim() === "" || !Number.isInteger(mins) || mins < 0 || mins > 1440) {
        setFormError("Wait between sends must be 0 to 1440 minutes.");
        return;
      }
      patch.timeToWaitMins = mins;
    }
    if (Object.keys(patch).length === 0) return;

    setFormError(null);
    // Inputs are disabled while busy, so this snapshot is what the user saved.
    // Adopt it (with normalizations) as form and baseline on success.
    onSave(patch, () => {
      setBaseline(saved);
      setForm(saved);
    });
  };

  const discard = () => {
    setForm(baseline);
    setFormError(null);
  };

  return (
    <Card title="Sending identity">
      <div className="flex flex-col gap-4">
        <label className="flex flex-col gap-1">
          <span className={IDENTITY_LABEL}>From name</span>
          <input
            type="text"
            value={form.fromName}
            disabled={busy}
            maxLength={100}
            aria-label="From name"
            placeholder="Jane Doe"
            onChange={(event) => setField("fromName", event.target.value)}
            className={INPUT_CLASS}
          />
        </label>

        <label className="flex flex-col gap-1">
          <span className={IDENTITY_LABEL}>Signature</span>
          <textarea
            value={form.signature}
            disabled={busy}
            maxLength={10_000}
            rows={6}
            aria-label="Signature"
            spellCheck={false}
            placeholder="<p>Jane Doe</p>"
            onChange={(event) => setField("signature", event.target.value)}
            className="w-full resize-y rounded-md border border-border bg-surface px-2.5 py-2 font-mono text-[12px] leading-relaxed text-foreground shadow-xs outline-none transition placeholder:text-muted-foreground focus:border-ring"
          />
          <span className={IDENTITY_CAPTION}>Raw HTML, appended to outgoing emails exactly as written.</span>
        </label>

        <div className="grid gap-4 sm:grid-cols-2">
          <label className="flex flex-col gap-1">
            <span className={IDENTITY_LABEL}>BCC</span>
            <input
              type="text"
              inputMode="email"
              value={form.bcc}
              disabled={busy}
              maxLength={320}
              aria-label="BCC email"
              spellCheck={false}
              autoCapitalize="none"
              placeholder="archive@example.com"
              onChange={(event) => setField("bcc", event.target.value)}
              className={`${INPUT_CLASS} ${bccInvalid ? "border-destructive" : ""}`}
            />
            {bccInvalid ? (
              <span className="text-[11px] leading-relaxed text-destructive">
                That does not look like an email address.
              </span>
            ) : null}
          </label>

          <label className="flex flex-col gap-1">
            <span className={IDENTITY_LABEL}>Custom tracking domain</span>
            <input
              type="text"
              value={form.trackingDomain}
              disabled={busy}
              maxLength={255}
              aria-label="Custom tracking domain"
              spellCheck={false}
              autoCapitalize="none"
              placeholder="track.example.com"
              onChange={(event) => setField("trackingDomain", event.target.value)}
              className={INPUT_CLASS}
            />
            <span className={IDENTITY_CAPTION}>Bare domain, no protocol.</span>
          </label>
        </div>

        <label className="flex flex-col gap-1">
          <span className={IDENTITY_LABEL}>Wait between sends</span>
          <span className="flex items-center gap-1.5">
            <input
              type="number"
              min={0}
              max={1440}
              value={form.waitMins}
              disabled={busy}
              aria-label="Wait between sends in minutes"
              placeholder="0"
              onChange={(event) => setField("waitMins", event.target.value)}
              className="h-8 w-24 rounded-md border border-border bg-surface px-2 text-[12.5px] tabular-nums text-foreground shadow-xs outline-none transition focus:border-ring"
            />
            <span className="text-[11.5px] text-muted-foreground">minutes</span>
          </span>
        </label>

        {dirty ? (
          <div className="anim-savebar-in flex items-center gap-1.5 border-t border-border pt-3">
            <button type="button" disabled={busy || disabled} onClick={submit} className={`${BTN_PRIMARY} h-7 px-3 text-[11.5px]`}>
              {busy ? <Loader2 className="size-3.5 animate-spin" /> : null}
              {busy ? "Saving…" : "Save"}
            </button>
            <button type="button" disabled={busy} onClick={discard} className={`${BTN_SUBTLE} h-7 px-2.5 text-[11.5px]`}>
              Cancel
            </button>
            {formError ? <span className="text-[11px] text-destructive">{formError}</span> : null}
          </div>
        ) : null}
      </div>
    </Card>
  );
}

/* ── Campaign membership row (View · Remove with inline confirm) ───────── */
function CampaignRow({
  campaign,
  onRemove,
  busy,
  disabled,
}: {
  campaign: CampaignInboxMapEntry;
  onRemove: (campaignId: string, onDone: () => void) => void;
  busy: boolean;
  disabled: boolean;
}) {
  const [confirming, setConfirming] = useState(false);

  return (
    <div className="relative flex items-center gap-2 border-b border-border py-2 first:pt-0 last:border-b-0 last:pb-0">
      <span title={campaign.name} className="min-w-0 flex-1 truncate text-[12.5px] font-medium">{campaign.name}</span>
      <span className={`shrink-0 rounded px-1.5 py-px text-[10px] font-semibold ${campaignStatusTone(campaign.status)}`}>
        {campaignStatusLabel(campaign.status)}
      </span>
      <Link href="/campaigns" className={`${BTN_OUTLINE} h-7 shrink-0 px-2 text-[11px]`}>
        View
        <ArrowRight className="size-3" />
      </Link>
      <button
        type="button"
        disabled={disabled}
        aria-expanded={confirming}
        onClick={() => setConfirming(true)}
        className={`${BTN_SUBTLE} h-7 shrink-0 px-2 text-[11px] hover:text-destructive`}
      >
        Remove
      </button>
      {confirming ? (
        <div className="absolute right-0 top-full z-20 mt-1 flex w-60 flex-col gap-2 rounded-lg border border-border bg-surface p-2.5 shadow-pop">
          <p className="text-[12px] font-medium leading-snug">Remove this inbox from {campaign.name}?</p>
          <div className="flex gap-1.5">
            <button
              type="button"
              autoFocus
              disabled={busy}
              onClick={() => setConfirming(false)}
              onKeyDown={(event) => {
                if (event.key === "Escape") setConfirming(false);
              }}
              className="flex h-7 flex-1 items-center justify-center rounded-md border border-border bg-surface text-[11.5px] font-medium text-foreground transition hover:bg-muted/60 disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => onRemove(campaign.campaignId, () => setConfirming(false))}
              className="flex h-7 flex-1 items-center justify-center rounded-md bg-destructive-soft text-[11.5px] font-medium text-destructive transition hover:opacity-85 disabled:opacity-50"
            >
              {busy ? "Removing…" : "Remove"}
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

/* ── Add-to-campaign control (quiet button reveals a compact picker) ───── */
function AddToCampaign({
  available,
  onAdd,
  busy,
  disabled,
}: {
  available: CampaignInboxMapEntry[] | null;
  onAdd: (campaignId: string, onDone: () => void) => void;
  busy: boolean;
  disabled: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState("");
  const options = available ? [...available].sort((a, b) => a.name.localeCompare(b.name)) : [];

  // Hide the control entirely when the inbox is already in every campaign.
  if (options.length === 0) return null;

  if (!open) {
    return (
      <button
        type="button"
        disabled={disabled}
        onClick={() => {
          setSelected(options[0].campaignId);
          setOpen(true);
        }}
        className={`${BTN_SUBTLE} h-7 self-start px-2 text-[11.5px]`}
      >
        <Plus className="size-3" />
        Add to campaign
      </button>
    );
  }

  return (
    <div className="flex items-center gap-1.5">
      <span className="relative">
        <select
          value={selected}
          disabled={busy}
          aria-label="Campaign to add"
          onChange={(event) => setSelected(event.target.value)}
          className={`h-7 max-w-[220px] appearance-none truncate rounded-md border border-border bg-surface pl-2 pr-6 text-[12px] text-foreground shadow-xs outline-none transition focus:border-ring`}
        >
          {options.map((campaign) => (
            <option key={campaign.campaignId} value={campaign.campaignId}>
              {campaign.name}
            </option>
          ))}
        </select>
        <ChevronDown className="pointer-events-none absolute right-1.5 top-1/2 size-3 -translate-y-1/2 text-muted-foreground" />
      </span>
      <button
        type="button"
        disabled={busy || disabled || !selected}
        onClick={() => onAdd(selected, () => setOpen(false))}
        className={`${BTN_PRIMARY} h-7 px-2.5 text-[11px]`}
      >
        {busy ? <Loader2 className="size-3 animate-spin" /> : null}
        {busy ? "Adding…" : "Add"}
      </button>
      <button type="button" disabled={busy} onClick={() => setOpen(false)} className={`${BTN_SUBTLE} h-7 px-2 text-[11px]`}>
        Cancel
      </button>
    </div>
  );
}

/* ── Detail health gauge (radial score arc) ────────────────────────────── */
function HealthGauge({
  score,
  grade,
  placeholder,
}: {
  score?: number;
  grade?: HealthReport["grade"];
  placeholder?: boolean;
}) {
  const size = 72;
  const stroke = 6;
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  const clamped = Math.max(0, Math.min(100, score ?? 0));
  const length = placeholder ? 0 : (clamped / 100) * circumference;
  const color = placeholder || !grade ? "var(--border-strong)" : GRADE_STROKE[grade];

  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="shrink-0" aria-hidden>
      <circle cx={size / 2} cy={size / 2} r={radius} fill="none" stroke="var(--muted)" strokeWidth={stroke} />
      {/* length 0 is skipped entirely: a zero-length round-capped dash would
          still paint a dot at 12 o'clock. */}
      {!placeholder && length > 0 ? (
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke={color}
          strokeWidth={stroke}
          strokeDasharray={`${length} ${circumference - length}`}
          strokeLinecap="round"
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
        />
      ) : null}
      {!placeholder ? (
        <text
          x="50%"
          y="50%"
          dominantBaseline="central"
          textAnchor="middle"
          className="fill-foreground text-[20px] font-semibold font-mono tabular-nums"
        >
          {score}
        </text>
      ) : null}
    </svg>
  );
}

/* ── Category disclosure (collapsed by default; expanded when any fail) ─── */
const DOT_CLASS: Record<CheckStatus, string> = {
  pass: "bg-success",
  warn: "bg-warning",
  fail: "bg-destructive",
  skip: "bg-muted-foreground/40",
};

function CategoryDisclosure({ category }: { category: HealthCategory }) {
  const hasFail = category.checks.some((check) => check.status === "fail");
  return (
    <details open={hasFail} className="group overflow-hidden rounded-lg border border-border">
      <summary className={`flex list-none items-center gap-2 px-3 py-2`}>
        <span className="text-[10px] font-semibold uppercase tracking-wide text-foreground-subtle">{category.label}</span>
        <span className="ml-auto flex items-center gap-1">
          {category.checks.map((check) => (
            <span key={check.key} className={`size-1.5 rounded-full ${DOT_CLASS[check.status]}`} />
          ))}
        </span>
        <ChevronDown className="size-3.5 text-muted-foreground transition-transform group-open:rotate-180" />
      </summary>
      <div className="flex flex-col border-t border-border">
        {category.checks.map((check, index) => (
          <CheckRow key={check.key} check={check} first={index === 0} />
        ))}
      </div>
    </details>
  );
}

/* ── Section card (title + optional action, bordered body) ──────────────
   The title row has a FIXED height so cards align whether or not they carry
   an action button, and the body stretches so grid siblings match heights. */
function Card({
  title,
  action,
  fill = false,
  children,
}: {
  title: string;
  action?: ReactNode;
  /** Fill the grid row so side-by-side cards match heights. Off by default —
      an explicit h-full ignores items-start and manufactures empty space in
      short cards. */
  fill?: boolean;
  children: ReactNode;
}) {
  return (
    <section className={`flex ${fill ? "h-full " : ""}flex-col gap-2`}>
      <div className="flex h-7 shrink-0 items-center justify-between gap-3 px-1">
        <h3 className="text-[12px] font-semibold tracking-tight">{title}</h3>
        {action ? <div className="shrink-0">{action}</div> : null}
      </div>
      <div className={`${fill ? "flex-1 " : ""}rounded-xl bg-surface p-3.5 shadow-xs`}>
        {children}
      </div>
    </section>
  );
}

function Stat({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-[10px] font-semibold uppercase tracking-wide text-foreground-subtle">{label}</span>
      <div className="flex items-center">{children}</div>
    </div>
  );
}

/* ── 14-day warmup activity (pure divs, no chart lib) ─────────────────────
   Day bars are total warmup sends; the filled portion at the base is replies.
   Spam-rescue days carry a small destructive tick on the baseline row below. */
function WarmupActivity({ stats, timeLocale }: { stats: InboxWarmupStats; timeLocale: string }) {
  // Smartlead does not guarantee byDate ordering — sort before windowing.
  // It also pads both ends with zero days; trim them (keep interior gaps).
  const sorted = [...stats.byDate].sort((a, b) => a.date.localeCompare(b.date)).slice(-14);
  const firstActive = sorted.findIndex((d) => d.sentCount > 0);
  let lastActive = sorted.length - 1;
  while (lastActive > firstActive && sorted[lastActive]?.sentCount === 0) lastActive -= 1;
  const days = firstActive === -1 ? [] : sorted.slice(firstActive, lastActive + 1);
  const max = days.reduce((m, d) => Math.max(m, d.sentCount), 0);
  const rescued = days.reduce((sum, d) => sum + d.saveFromSpamCount, 0);

  const summary = [
    `${stats.sentCount} warmup send${stats.sentCount === 1 ? "" : "s"}`,
    `${stats.inboxCount} inboxed`,
  ];
  if (max > 0) summary.push(`peak ${max}/day`);
  if (rescued > 0) summary.push(`${rescued} rescued from spam`);

  return (
    <div className="flex flex-col gap-2">
      {days.length > 0 ? (
        <DayColumnChart
          days={days.map((day) => ({
            date: day.date,
            sent: day.sentCount,
            reply: day.replyCount,
            rescued: day.saveFromSpamCount,
          }))}
          max={max}
          timeLocale={timeLocale}
          height="h-24"
          rescueTicks
        />
      ) : (
        <p className="text-[11.5px] text-muted-foreground">No warmup activity in the last 14 days.</p>
      )}
      <p className="text-[11.5px] tabular-nums text-muted-foreground">{summary.join(" · ")}</p>
    </div>
  );
}

/* ── Health check row (Apple System Report grammar) ──────────────────────
   Pass rows stay quiet; warn/fail rows carry a soft tint so issues surface. */
const CHECK_ICON: Record<CheckStatus, typeof CheckCircle2> = {
  pass: CheckCircle2,
  warn: AlertTriangle,
  fail: XCircle,
  skip: Minus,
};
const CHECK_ICON_CLASS: Record<CheckStatus, string> = {
  pass: "text-success",
  warn: "text-warning",
  fail: "text-destructive",
  skip: "text-muted-foreground",
};
const CHECK_ROW_CLASS: Record<CheckStatus, string> = {
  pass: "bg-surface",
  warn: "bg-warning-soft/40",
  fail: "bg-destructive-soft/40",
  skip: "bg-surface",
};

function CheckRow({ check, first }: { check: HealthCheck; first: boolean }) {
  const Icon = CHECK_ICON[check.status];
  const emphasized = check.status === "warn" || check.status === "fail";
  return (
    <div
      className={`flex items-start gap-2.5 px-3 py-2 ${CHECK_ROW_CLASS[check.status]} ${
        first ? "" : "border-t border-border"
      }`}
    >
      <Icon className={`mt-px size-3.5 shrink-0 ${CHECK_ICON_CLASS[check.status]}`} strokeWidth={2} />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-2">
          <span className={`text-[12px] ${emphasized ? "font-semibold" : "font-medium"}`}>{check.label}</span>
          <span className="min-w-0 text-[11.5px] text-muted-foreground">{check.detail}</span>
        </div>
        {check.fix ? (
          <p className="mt-0.5 text-[11px] leading-relaxed text-muted-foreground">
            <span className="font-medium text-foreground/80">Fix:</span> {check.fix}
          </p>
        ) : null}
      </div>
    </div>
  );
}

/* ── Zapmail provisioning review ─────────────────────────────────────────
   Batches created by the buy wizard (or adopted manually) surface as a header
   button ("Review N inboxes") while the server-side watcher advances them:
   activation -> image -> export -> Smartlead defaults. Clicking opens a modal
   with per-inbox pipeline state, the applied defaults, domain forwarding, and
   approve/dismiss. Fine-tuning happens on the roster below - same accounts. */
const PROVISION_STATE_META: Record<string, { label: string; cls: string }> = {
  pending: { label: "Waiting", cls: "bg-muted text-muted-foreground" },
  active: { label: "Active", cls: "bg-muted text-muted-foreground" },
  // "imaged" is the export-ripe state; the profile picture itself applies in
  // the background (Zapmail rejects updates on brand-new mailboxes for a while).
  imaged: { label: "Ready to export", cls: "bg-muted text-foreground" },
  exported: { label: "Exporting", cls: "bg-warning/15 text-warning" },
  configured: { label: "Configured", cls: "bg-muted text-foreground" },
  review: { label: "Ready · review", cls: "bg-success-soft text-success" },
  approved: { label: "Approved", cls: "bg-success-soft text-success" },
  failed: { label: "Failed", cls: "bg-destructive/10 text-destructive" },
};
// Client copy of the server's warmupPeriodPhrase (that module is server-only).
function periodPhrase(days: number): string {
  if (days % 30 === 0) { const n = days / 30; return `${n} month${n === 1 ? "" : "s"}`; }
  if (days % 7 === 0) { const n = days / 7; return `${n} week${n === 1 ? "" : "s"}`; }
  return `${days} days`;
}

const PROVISION_STATUS_LABEL: Record<string, string> = {
  watching: "Waiting for activation",
  exporting: "Exporting to Smartlead",
  configuring: "Applying settings",
  review: "Needs review",
  expired: "Expired",
  error: "Error",
};

function ProvisionReviewSection({ showToast, timeZone, timeLocale }: { showToast: (ok: boolean, text: string) => void; timeZone: string; timeLocale: string }) {
  const [provisions, setProvisions] = useState<ZapmailProvision[]>([]);
  const [forwardingDefault, setForwardingDefault] = useState("");
  const [open, setOpen] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const result = await listZapmailProvisionsAction();
      if (result.ok && result.provisions) setProvisions(result.provisions);
      if (result.ok && result.forwardingDefault !== undefined) setForwardingDefault(result.forwardingDefault);
    } catch {
      // Silent: the button simply keeps its last state.
    }
  }, []);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  // Light auto-refresh while a batch is mid-pipeline, so the button and modal
  // track the watcher without a reload. Stops when everything is settled.
  const hasLive = provisions.some((p) => p.status === "watching" || p.status === "exporting" || p.status === "configuring");
  useEffect(() => {
    if (!hasLive) return;
    const timer = setInterval(() => void refresh(), 60_000);
    return () => clearInterval(timer);
  }, [hasLive, refresh]);

  // Complete batches stay listed while their profile image is still retrying.
  const openBatches = provisions.filter((p) => p.status !== "complete" || p.imageError);
  if (openBatches.length === 0) return null;
  const reviewCount = openBatches.reduce((sum, batch) => sum + batch.items.filter((i) => i.state === "review").length, 0);
  const inFlight = openBatches.reduce((sum, batch) => sum + batch.items.filter((i) => i.state !== "review" && i.state !== "approved" && i.state !== "failed").length, 0);
  const imagesRetrying = openBatches.filter((batch) => batch.imageError).length;

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={`${BTN_OUTLINE} relative h-8 px-3 text-[12px]`}
      >
        {reviewCount > 0 ? (
          <>
            <span className="absolute -right-0.5 -top-0.5 size-2 rounded-full bg-success" />
            <ClipboardList className="size-3.5" />
            Review {reviewCount} {reviewCount === 1 ? "inbox" : "inboxes"}
          </>
        ) : inFlight > 0 ? (
          <>
            <Loader2 className="size-3.5 animate-spin" />
            Provisioning {inFlight} {inFlight === 1 ? "inbox" : "inboxes"}
          </>
        ) : (
          <>
            <span className="absolute -right-0.5 -top-0.5 size-2 rounded-full bg-warning" />
            <RefreshCw className="size-3.5" />
            Profile {imagesRetrying === 1 ? "image" : "images"} retrying
          </>
        )}
      </button>
      {open ? (
        <ProvisionReviewModal
          batches={openBatches}
          forwardingDefault={forwardingDefault}
          showToast={showToast}
          refresh={refresh}
          timeZone={timeZone}
          timeLocale={timeLocale}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </>
  );
}

function ProvisionReviewModal({
  batches,
  forwardingDefault,
  showToast,
  refresh,
  timeZone,
  timeLocale,
  onClose,
}: {
  batches: ZapmailProvision[];
  forwardingDefault: string;
  showToast: (ok: boolean, text: string) => void;
  refresh: () => Promise<void>;
  timeZone: string;
  timeLocale: string;
  onClose: () => void;
}) {
  const router = useRouter();
  const { closing, playExit } = useExit();
  const [busy, setBusy] = useState<string | null>(null);
  const [forwardTo, setForwardTo] = useState<Record<string, string>>({});
  const beginClose = () => playExit(onClose);

  const run = async (key: string, fn: () => Promise<{ ok: boolean; message: string }>) => {
    setBusy(key);
    try {
      const result = await fn();
      showToast(result.ok, result.message);
      await refresh();
    } catch {
      showToast(false, "The action failed. Try again.");
    } finally {
      setBusy(null);
    }
  };

  return (
    <div
      className={`fixed inset-0 z-50 flex cursor-pointer items-center justify-center bg-background/70 p-4 backdrop-blur-sm ${closing ? "anim-overlay-out" : "anim-overlay-in"}`}
      onClick={(event) => {
        if (event.target === event.currentTarget) beginClose();
      }}
    >
      <div className={`flex max-h-[85vh] w-full max-w-2xl cursor-auto flex-col overflow-hidden rounded-xl border border-border bg-surface shadow-pop ${closing ? "anim-panel-out" : "anim-panel-in"}`}>
        <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-3">
          <div className="flex flex-col gap-0.5">
            <h2 className="text-[13.5px] font-semibold tracking-tight">Inbox provisioning</h2>
            <span className="text-[11px] text-muted-foreground">
              {batches.length} {batches.length === 1 ? "batch" : "batches"} · approve to finish setup
            </span>
          </div>
          <button type="button" aria-label="Close" onClick={beginClose} className={`${BTN_SUBTLE} size-7 p-0`}>
            <X className="size-4" />
          </button>
        </div>
        <div className="flex flex-col gap-3 overflow-y-auto p-4">
          {batches.map((batch) => {
            const domains = [...new Set(batch.items.map((i) => i.domainName))];
            const reviewable = batch.items.filter((i) => i.state === "review");
            const domainKey = domains.join(", ");
            return (
              <div key={batch.id} className="rounded-xl border border-border p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-[12.5px] font-semibold">{domainKey}</span>
                  <span className={`rounded px-1.5 py-px text-[10px] font-semibold ${batch.status === "review" ? "bg-success-soft text-success" : batch.status === "expired" || batch.status === "error" ? "bg-destructive/10 text-destructive" : "bg-muted text-muted-foreground"}`}>
                    {PROVISION_STATUS_LABEL[batch.status] ?? batch.status}
                  </span>
                  {batch.error ? <span className="text-[11px] text-destructive">{batch.error}</span> : null}
                </div>
                {batch.imageError ? (
                  <p className="mt-1.5 text-[11px] leading-relaxed text-warning">
                    Profile image not applied yet: Zapmail is refusing updates on these new mailboxes
                    (common right after creation). Retrying every 10 minutes until it lands.
                  </p>
                ) : null}
                <div className="mt-2 flex flex-col gap-1">
                  {batch.items.map((item) => {
                    const meta = PROVISION_STATE_META[item.state] ?? PROVISION_STATE_META.pending;
                    return (
                      <div key={item.email} className="flex items-center gap-2 text-[12px]" title={item.error ?? undefined}>
                        <span className="min-w-0 flex-1 truncate text-foreground">{item.email}</span>
                        <span className={`shrink-0 rounded px-1.5 py-px text-[10px] font-semibold ${meta.cls}`}>{meta.label}</span>
                      </div>
                    );
                  })}
                </div>
                {batch.status === "review" ? (
                  <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">
                    Defaults applied: 15 emails/day · warmup on, 20/day · 23% replies · fresh warmup tag.
                    Fine-tune any inbox from the list (same accounts), then approve.
                  </p>
                ) : null}
                <p className="mt-1.5 text-[11px] text-muted-foreground">
                  Warmup window: {periodPhrase(batch.warmupDays)}
                  {batch.warmupStartedAt
                    ? ` · campaign-ready ${formatDay(Date.parse(batch.warmupStartedAt) + batch.warmupDays * 86_400_000, timeZone, timeLocale)}`
                    : " · starts when the batch lands in Smartlead"}
                </p>
                <div className="mt-2.5 flex flex-wrap items-center gap-2 border-t border-border pt-2.5">
                  <span className="text-[11px] text-muted-foreground">Forwarding:</span>
                  <input
                    value={forwardTo[batch.id] ?? forwardingDefault}
                    onChange={(event) => setForwardTo((prev) => ({ ...prev, [batch.id]: event.target.value }))}
                    placeholder="example.com"
                    aria-label="Forwarding destination"
                    className="h-7 w-48 rounded-md border border-border bg-surface px-2 text-[11.5px] outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
                  />
                  <button
                    type="button"
                    onClick={() => void run(`forward-${batch.id}`, () => setZapmailDomainForwardingAction(domains, forwardTo[batch.id] ?? forwardingDefault))}
                    disabled={busy !== null || !(forwardTo[batch.id] ?? forwardingDefault).trim()}
                    className={`${BTN_OUTLINE} h-7 px-2 text-[11.5px]`}
                  >
                    {busy === `forward-${batch.id}` ? <Loader2 className="size-3 animate-spin" /> : null}
                    Set
                  </button>
                  <div className="ml-auto flex items-center gap-1.5">
                    <button
                      type="button"
                      onClick={() => void run(`check-${batch.id}`, processZapmailProvisionsNowAction)}
                      disabled={busy !== null}
                      className={`${BTN_OUTLINE} h-7 px-2 text-[11.5px]`}
                    >
                      {busy === `check-${batch.id}` ? <Loader2 className="size-3 animate-spin" /> : <RefreshCw className="size-3" />}
                      Check now
                    </button>
                    <button
                      type="button"
                      title="Dismiss this batch from the review list"
                      onClick={() => void run(`dismiss-${batch.id}`, () => dismissZapmailProvisionAction(batch.id))}
                      disabled={busy !== null}
                      className={`${BTN_SUBTLE} h-7 px-2 text-[11.5px]`}
                    >
                      Dismiss
                    </button>
                    {reviewable.length > 0 ? (
                      <button
                        type="button"
                        onClick={() =>
                          void run(`approve-${batch.id}`, async () => {
                            const result = await approveZapmailProvisionAction(batch.id, reviewable.map((i) => i.email));
                            // The roster is server-rendered; refresh so the newly
                            // exported accounts appear without a manual reload.
                            if (result.ok) router.refresh();
                            return result;
                          })
                        }
                        disabled={busy !== null}
                        className={`${BTN_PRIMARY} h-7 px-2.5 text-[11.5px]`}
                      >
                        {busy === `approve-${batch.id}` ? <Loader2 className="size-3 animate-spin" /> : <CheckCircle2 className="size-3" />}
                        Approve {reviewable.length === batch.items.length ? "all" : String(reviewable.length)}
                      </button>
                    ) : null}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
