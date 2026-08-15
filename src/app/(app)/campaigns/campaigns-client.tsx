"use client";

import {
  Fragment,
  useCallback,
  useEffect,
  useRef,
  useState,
  useTransition,
  type CSSProperties,
  type ReactNode,
} from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  ArrowDownWideNarrow,
  ArrowLeft,
  ArrowUpNarrowWide,
  Ban,
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  Download,
  Ellipsis,
  ExternalLink,
  ImageOff,
  Info,
  Loader2,
  Mailbox,
  Megaphone,
  Pause,
  Pencil,
  PenLine,
  Play,
  Plus,
  RefreshCw,
  Search,
  SlidersHorizontal,
  Square,
  Tag,
  Trash2,
  Users,
  X,
} from "lucide-react";
import type { ReplyCategory, ReplySentimentType } from "@/lib/taxonomy";
import { textToSequenceHtml } from "@/lib/email-copy";
import { buildSmartleadCampaignUrl } from "@/lib/smartlead/links";
import {
  StyleExamplesEditor,
  type AiSettings,
  type StyleExample,
} from "../settings/settings-client";
import {
  addCampaignInboxesAction,
  addCampaignLeadsAction,
  createCampaignAction,
  deleteCampaignAction,
  generateCampaignBriefAction,
  getCampaignDetailAction,
  getCampaignDrilldownAction,
  getCampaignInsightsAction,
  getCampaignLeadsAction,
  getCampaignLeadsChunkAction,
  getCampaignOverviewAction,
  getCampaignPreviewLeadAction,
  getCampaignSentEmailsAction,
  getCampaignSequenceAction,
  getReplyWebhookStatusAction,
  getSmartleadCategoriesAction,
  pauseCampaignLeadAction,
  registerReplyWebhookAction,
  removeCampaignInboxesAction,
  removeCampaignLeadAction,
  resumeCampaignLeadAction,
  saveCampaignSequenceAction,
  setCampaignLeadCategoryAction,
  setCampaignStatusAction,
  unsubscribeCampaignLeadAction,
  updateCampaignGeneralSettingsAction,
  updateCampaignLeadAction,
  updateCampaignLimitsAction,
  updateCampaignOverridesAction,
  updateCampaignScheduleWindowAction,
} from "./actions";
import {
  MAX_SEQUENCE_STEPS,
  MAX_VARIANTS,
  SequenceCheckBanner,
  SequenceCopyCard,
  SequenceEditor,
  draftIsDirty,
  draftsFromSteps,
  newStepDraft,
  renumberSteps,
  type BodyDraft,
  type PreviewLeadData,
  type SequenceStep,
  type SequenceVariant,
  type StepDraft,
  type VariantDraft,
} from "./sequence-editor";
import { getAnalyticsDrilldownAction } from "../analytics/actions";
import { SkeletonChart, SkeletonKpiStrip } from "@/app/(app)/skeletons";
import { getCampaignInboxesAction, listInboxAccountsAction } from "../inboxes/actions";
import { getCrmLeadDetailAction } from "../leads/actions";
import { useToast } from "../toast";

/* ── Contract mirrors (declared locally so the client never imports a server
   module — same pattern as settings-client's local mirrors). ────────────── */
type CategoryOverride = {
  suppress?: boolean | null;
  dnc?: boolean | null;
  draftReply?: boolean | null;
  draftGuidance?: string | null;
};
type CampaignOverrides = {
  campaignContext?: string | null;
  draftingEnabled?: boolean | null;
  senderName?: string | null;
  senderTitle?: string | null;
  senderCompany?: string | null;
  draftContext?: string | null;
  styleExamples?: StyleExample[] | null;
  extraVoiceRules?: string | null;
  signature?: string | null;
  autoHandleOoo?: boolean | null;
  autoHandleDeadMailbox?: boolean | null;
  resumeBusinessDaysAfterReturn?: number | null;
  resumeDefaultWaitDays?: number | null;
  colleagueResearchEnabled?: boolean | null;
  colleagueRolesHint?: string | null;
  categories?: Record<string, CategoryOverride> | null;
};
type CampaignSummary = { id: string; name: string; status: string | null; createdAt: string | null };
type CampaignSchedule = {
  timezone: string;
  daysOfTheWeek: number[];
  startHour: string;
  endHour: string;
};
type CampaignDetail = {
  id: string;
  name: string;
  status: string | null;
  maxLeadsPerDay: number | null;
  minTimeBtwnEmails: number | null;
  schedule: CampaignSchedule | null;
  stopLeadSettings: string | null;
  tracking: { opens: boolean; clicks: boolean; unknown: string[] };
  sendAsPlainText: boolean;
  unsubscribeText: string;
  followUpPercentage: number | null;
  createdAt: string | null;
};
/* Sending-account mirror for the campaign's Inboxes section — only the fields
   this compact list renders (the full shape lives in inboxes-client). */
type CampaignInbox = {
  id: number;
  fromEmail: string;
  provider: string | null;
  messagePerDay: number | null;
  dailySentCount: number | null;
  smtpOk: boolean;
  imapOk: boolean;
  smtpError: string | null;
  imapError: string | null;
  isSuspended: boolean;
  warmup: { reputation: number | null } | null;
};

/* Lead-row mirror for the campaign's Leads section — the exact shape the
   getCampaignLeadsAction contract returns (declared locally so the client
   never imports the server module, same pattern as the mirrors above). */
type CampaignLeadRow = {
  mapId: string;
  leadId: string | null;
  status: string | null;
  addedAt: string | null;
  firstName: string;
  lastName: string;
  email: string;
  company: string;
  website: string;
  location: string;
  phone: string;
  linkedinUrl: string | null;
  companyUrl: string | null;
  categoryId: number | null;
  unsubscribed: boolean;
  variables: Record<string, string>;
};

/* Smartlead global reply category (mirrors SmartleadGlobalCategory over the
   getSmartleadCategoriesAction contract — declared locally so the client never
   imports the server module). */
type LeadCategory = { id: number; name: string; sentimentType: string };

/* One lead to add, matching the addCampaignLeadsAction contract element shape.
   Undefined fields are omitted before submit. */
type AddLeadInput = {
  email: string;
  firstName?: string;
  lastName?: string;
  company?: string;
  website?: string;
  location?: string;
  phone?: string;
  linkedinUrl?: string;
  companyUrl?: string;
  variables?: Record<string, string>;
};

/* Smartlead's leads endpoint pages 50 at a time (mirrors the action's
   LEADS_PAGE_SIZE) — used for pagination math and page prefetch keys. */
const LEADS_PAGE_SIZE = 50;
/* The bulk endpoint's maximum page size (mirrors the action's LEADS_BULK_CHUNK)
   — the load-all loop walks offsets 0, 100, 200, … at this stride. */
const LEADS_BULK_CHUNK = 100;
/* How many load-all chunk requests are kept in flight at once. */
const LEADS_LOAD_ALL_CONCURRENCY = 3;
type LeadsSortKey = "none" | "name" | "company" | "email" | "status";

type ActionResult = { ok: boolean; message: string };

/* ── Shared style constants (copied conventions, intentionally not shared) ── */

const BTN_BASE = `inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-md font-medium transition disabled:cursor-not-allowed disabled:opacity-50`;
const BTN_PRIMARY = `${BTN_BASE} bg-primary text-primary-foreground shadow-xs hover:opacity-90`;
const BTN_OUTLINE = `${BTN_BASE} border border-border bg-surface text-foreground shadow-xs hover:border-border-strong hover:bg-muted/60`;

const INPUT_CLASS =
  "h-8 w-full rounded-md border border-border bg-surface px-2.5 text-[12.5px] text-foreground shadow-xs outline-none transition placeholder:text-muted-foreground focus:border-ring";
const TEXTAREA_MULTI =
  "w-full rounded-md border border-border bg-surface px-2.5 py-2 text-[12.5px] leading-relaxed text-foreground shadow-xs outline-none transition placeholder:text-muted-foreground focus:border-ring resize-y";
/* Quiet square icon-button — the muted, hover-fills affordance used for the
   leads table's edit pencil and the lead editor's remove-variable X. */
const ICON_BTN_QUIET = `inline-flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted/70 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50`;

/* ── Category color dot (copied from settings-client conventions) ──────── */
const COLOR_SLUGS = ["gray", "blue", "green", "amber", "red", "violet", "teal", "rose"] as const;
type ColorSlug = (typeof COLOR_SLUGS)[number];
const COLOR_DOT: Record<ColorSlug, string> = {
  gray: "bg-[#9ca3af]",
  blue: "bg-[#3b82f6]",
  green: "bg-[#22c55e]",
  amber: "bg-[#f59e0b]",
  red: "bg-[#ef4444]",
  violet: "bg-[#8b5cf6]",
  teal: "bg-[#14b8a6]",
  rose: "bg-[#f43f5e]",
};
const SENTIMENT_TO_COLOR: Record<ReplySentimentType, ColorSlug> = {
  positive: "green",
  negative: "red",
  neutral: "gray",
};
function dotClass(color: string | null, sentiment: ReplySentimentType): string {
  const slug =
    color && (COLOR_SLUGS as readonly string[]).includes(color)
      ? (color as ColorSlug)
      : SENTIMENT_TO_COLOR[sentiment];
  return COLOR_DOT[slug];
}

/* ── Inbox presentation (local copies — deliberately NOT shared with
   inboxes-client; the two clients each own their tiny badge, per the brief) ── */
function reputationBadgeClass(value: number | null): string {
  if (value === null) return "bg-muted text-muted-foreground";
  if (value >= 90) return "bg-success-soft text-success";
  if (value >= 75) return "bg-warning-soft text-warning";
  return "bg-destructive-soft text-destructive";
}

function ReputationBadge({ value }: { value: number | null }) {
  return (
    <span
      data-tip="Warmup reputation"
      data-tip-down=""
      className={`shrink-0 rounded px-1.5 py-px text-[10px] font-semibold tabular-nums ${reputationBadgeClass(value)}`}
    >
      {value === null ? "—" : value}
    </span>
  );
}

/* Aggregate header band for the Inboxes section list — count, summed daily
   capacity, average warmup reputation, an attention pill, and a sent-today
   meter. Sits inside the list surface so the divide-y hairline separates it
   from the first row. */
function InboxSummaryBand({ inboxes }: { inboxes: CampaignInbox[] }) {
  const capacity = inboxes.reduce((sum, inbox) => sum + (inbox.messagePerDay ?? 0), 0);
  const sentToday = inboxes.reduce((sum, inbox) => sum + (inbox.dailySentCount ?? 0), 0);
  const reputations = inboxes
    .map((inbox) => inbox.warmup?.reputation)
    .filter((value): value is number => typeof value === "number");
  const avgReputation =
    reputations.length > 0
      ? Math.round(reputations.reduce((sum, value) => sum + value, 0) / reputations.length)
      : null;
  const attention = inboxes.filter(
    (inbox) => inbox.isSuspended || !inbox.smtpOk || !inbox.imapOk,
  ).length;
  const sentPct = capacity > 0 ? Math.min(100, Math.round((sentToday / capacity) * 100)) : null;

  const stat = (value: string, label: string) => (
    <span className="inline-flex items-baseline gap-1.5 whitespace-nowrap">
      <span className="font-mono text-[12.5px] font-semibold tabular-nums">{value}</span>
      <span className="text-[11px] text-muted-foreground">{label}</span>
    </span>
  );
  const sep = <span aria-hidden className="h-3.5 w-px shrink-0 bg-border-strong" />;

  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-t-xl bg-muted/45 px-4 py-2.5">
      {stat(String(inboxes.length), inboxes.length === 1 ? "inbox" : "inboxes")}
      {sep}
      {stat(String(capacity), "/day capacity")}
      {avgReputation !== null ? (
        <>
          {sep}
          {stat(`${avgReputation}%`, "avg reputation")}
        </>
      ) : null}
      {attention > 0 ? (
        <span className="rounded bg-warning-soft px-1.5 py-px text-[10px] font-medium text-warning">
          {attention} need{attention === 1 ? "s" : ""} attention
        </span>
      ) : null}
      <span className="ml-auto inline-flex items-center gap-2">
        {stat(String(sentToday), "sent today")}
        {sentPct !== null ? (
          <>
            <span className="h-[5px] w-24 overflow-hidden rounded-full bg-border/60">
              <span
                className="block h-full rounded-full bg-primary"
                style={{ width: `${sentPct}%` }}
              />
            </span>
            <span className="text-[10.5px] tabular-nums text-muted-foreground">{sentPct}%</span>
          </>
        ) : null}
      </span>
    </div>
  );
}

function titleCaseProvider(provider: string): string {
  return provider
    .split(/[\s_-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(" ");
}

function InboxConnDot({ label, ok, error }: { label: string; ok: boolean; error: string | null }) {
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

/* The sending account's real Zapmail profile picture, or a warning ring when
   the account would send faceless (the Inboxes page's roster treatment).
   `verified` false means Zapmail couldn't be checked — a missing src is then
   UNKNOWN, not missing, so the warning stays quiet (neutral placeholder). */
function SenderAvatar({ src, verified = true }: { src: string | null; verified?: boolean }) {
  const [broken, setBroken] = useState(false);
  if (src && !broken) {
    return (
      // eslint-disable-next-line @next/next/no-img-element -- external CDN avatar with graceful fallback
      <img src={src} alt="" onError={() => setBroken(true)} className="size-6 shrink-0 rounded-full object-cover" />
    );
  }
  if (!verified) {
    return (
      <span
        data-tip="Profile picture unavailable — couldn't reach Zapmail"
        data-tip-down=""
        className="flex size-6 shrink-0 items-center justify-center rounded-full bg-muted/70"
      >
        <ImageOff aria-hidden className="size-3 text-muted-foreground/70" />
      </span>
    );
  }
  return (
    <span
      data-tip="No profile picture — set one in Zapmail"
      data-tip-down=""
      className="flex size-6 shrink-0 items-center justify-center rounded-full border border-dashed border-warning bg-warning-soft/60"
    >
      <ImageOff aria-hidden className="size-3 text-warning" />
    </span>
  );
}

function clampInt(raw: string, min: number, max: number): number {
  const n = parseInt(raw, 10);
  if (Number.isNaN(n)) return min;
  return Math.min(max, Math.max(min, n));
}

/* ── Status presentation ──────────────────────────────────────────────── */
function statusTone(status: string | null): string {
  const s = (status ?? "").toUpperCase();
  if (s === "ACTIVE" || s === "START" || s === "RUNNING") return "bg-success-soft text-success";
  if (s === "PAUSED") return "bg-warning-soft text-warning";
  return "bg-muted text-muted-foreground";
}
function statusLabel(status: string | null): string {
  const s = (status ?? "").toUpperCase();
  return s || "UNKNOWN";
}
function isActive(status: string | null): boolean {
  const s = (status ?? "").toUpperCase();
  return s === "ACTIVE" || s === "START" || s === "RUNNING";
}
// Ordering for the list's "Status" sort and the status-filter dropdown: Active
// first, then Drafted, Paused, Stopped, Completed, everything else last.
function statusRank(status: string | null): number {
  const s = (status ?? "").toUpperCase();
  if (s === "ACTIVE" || s === "START" || s === "RUNNING") return 0;
  if (s === "DRAFTED" || s === "DRAFT") return 1;
  if (s === "PAUSED") return 2;
  if (s === "STOPPED") return 3;
  if (s === "COMPLETED") return 4;
  return 5;
}
// Title-case a single-word status for the filter dropdown (ACTIVE -> Active).
function titleCaseStatus(status: string): string {
  return status
    .toLowerCase()
    .replace(/\b\w/g, (ch) => ch.toUpperCase());
}

/* ── Lead status pill ──────────────────────────────────────────────────────
   The wrapper status a lead carries in the campaign. Mapped case-insensitively
   to a quiet pill; an unrecognized status keeps its raw label on a neutral
   pill so nothing is ever hidden. */
const LEAD_STATUS_PILL = "inline-flex items-center whitespace-nowrap rounded px-1.5 py-px text-[10px] font-medium tabular-nums";
function leadStatusPill(status: string): { label: string; className: string } {
  switch (status.trim().toUpperCase()) {
    case "STARTED":
      return { label: "Started", className: "bg-muted text-foreground" };
    case "INPROGRESS":
      return { label: "In progress", className: "bg-muted text-foreground" };
    case "COMPLETED":
      return { label: "Completed", className: "bg-success-soft text-success" };
    case "STOPPED":
      return { label: "Stopped", className: "bg-muted text-muted-foreground" };
    case "PAUSED":
      return { label: "Paused", className: "bg-muted text-muted-foreground" };
    case "BLOCKED":
      return { label: "Blocked", className: "bg-destructive-soft text-destructive" };
    default:
      return { label: status.trim(), className: "bg-muted text-muted-foreground" };
  }
}

/* ── Toggle switch (notifications/settings convention) ────────────────── */
function Toggle({
  checked,
  onChange,
  disabled,
  label,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
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

/* ── Customized marker ──────────────────────────────────────────────────
   A small accent dot that flags a row/field as overriding its workspace
   default, so inherited vs customized reads at a glance. */
function CustomizedDot({ title = "Customized" }: { title?: string }) {
  return <span data-tip={title} aria-label={title} className="size-1.5 shrink-0 rounded-full bg-primary" />;
}

/* ── macOS System Settings row grammar (mirrored in settings-client) ─────
   Classic System Settings: the group title + description live OUTSIDE the
   bordered card, as a section label above it, so the card contains only
   setting rows and titles read unmistakably as titles. */
function SettingGroup({
  title,
  description,
  control,
  children,
}: {
  title: string;
  description: string;
  control?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <section className="flex flex-col gap-2">
      <div className="flex items-start justify-between gap-4 px-1">
        <div className="flex flex-col gap-0.5">
          <h3 className="text-[12px] font-semibold tracking-tight">{title}</h3>
          <p className="max-w-4xl text-[11px] leading-relaxed text-muted-foreground">{description}</p>
        </div>
        {control ? <div className="shrink-0 pt-0.5">{control}</div> : null}
      </div>
      {children ? (
        <div className="divide-y divide-border overflow-hidden rounded-xl bg-surface shadow-xs">
          {children}
        </div>
      ) : null}
    </section>
  );
}

function SettingRow({
  label,
  description,
  customized = false,
  children,
}: {
  label: string;
  description?: string;
  customized?: boolean;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2 px-4 py-3.5 lg:flex-row lg:items-start lg:gap-6">
      <div className="lg:w-[280px] lg:shrink-0">
        <div className="flex items-center gap-1.5">
          <div className="text-[12.5px] font-medium text-foreground">{label}</div>
          {customized ? <CustomizedDot /> : null}
        </div>
        {description ? (
          <p className="mt-0.5 text-[11px] leading-relaxed text-muted-foreground">{description}</p>
        ) : null}
      </div>
      <div className="flex min-w-0 flex-col gap-1.5 lg:flex-1">{children}</div>
    </div>
  );
}

function SettingRowFull({
  label,
  description,
  customized = false,
  children,
}: {
  label: string;
  description?: string;
  customized?: boolean;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2 px-4 py-3.5">
      <div>
        <div className="flex items-center gap-1.5">
          <div className="text-[12.5px] font-medium text-foreground">{label}</div>
          {customized ? <CustomizedDot /> : null}
        </div>
        {description ? (
          <p className="mt-0.5 text-[11px] leading-relaxed text-muted-foreground">{description}</p>
        ) : null}
      </div>
      {children}
    </div>
  );
}

/* Shared modal exit driver: a close intent flips `closing`, which swaps the
   backdrop/panel enter classes for the matching exit classes; the caller's
   real unmount fires after the 150ms exit runs. Guards double-close and clears
   the timer on unmount. */
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

/* Slim save bar that sticks to the bottom of the section column and slides in
   only while there are unsaved changes. `label`/`saveLabel` let one primitive
   serve both the limits form and the overrides form. */
function SaveBar({
  saving,
  onCancel,
  onSave,
  label,
  saveLabel,
}: {
  saving: boolean;
  onCancel: () => void;
  onSave: () => void;
  label: string;
  saveLabel: string;
}) {
  return (
    <div className="sticky bottom-0 z-10 pt-2">
      <div
        className="anim-savebar-in flex items-center justify-between gap-3 rounded-xl border border-border bg-surface/95 px-4 py-2.5 shadow-pop backdrop-blur"
      >
        <span className="text-[12px] font-medium text-muted-foreground">{label}</span>
        <div className="flex items-center gap-2">
          <button type="button" onClick={onCancel} disabled={saving} className={`${BTN_OUTLINE} h-8 px-3 text-[12px]`}>
            Cancel
          </button>
          <button type="button" onClick={onSave} disabled={saving} className={`${BTN_PRIMARY} h-8 px-3 text-[12px]`}>
            <Check className="size-3.5" />
            {saving ? "Saving…" : saveLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ── Override affordance ──────────────────────────────────────────────────
   Every reply-handling field inherits the workspace default until it's
   customized. Not overridden → show the inherited value (muted) + an Edit
   button. Overridden → show the campaign control + a Reset-to-default link
   (which sends null for that field on save). */
function OverrideControl({
  overridden,
  inherited,
  onCustomize,
  onReset,
  disabled,
  children,
}: {
  overridden: boolean;
  inherited: ReactNode;
  onCustomize: () => void;
  onReset: () => void;
  disabled?: boolean;
  children: ReactNode;
}) {
  if (!overridden) {
    return (
      <div className="flex items-center justify-between gap-3">
        <span className="min-w-0 truncate text-[12px] text-muted-foreground">
          <span className="text-muted-foreground/70">Default:</span> {inherited}
        </span>
        <button
          type="button"
          disabled={disabled}
          onClick={onCustomize}
          className={`${BTN_OUTLINE} h-7 shrink-0 px-2.5 text-[11.5px]`}
        >
          <SlidersHorizontal className="size-3" />
          Edit
        </button>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-2">
      {children}
      <button
        type="button"
        disabled={disabled}
        onClick={onReset}
        className="self-start text-[11px] font-medium text-muted-foreground transition-colors hover:text-foreground"
      >
        Reset to default
      </button>
    </div>
  );
}

/* ── Per-category tri-state control (Inherit · On · Off) ───────────────────
   A three-segment control. Inherit sends `undefined`; On sends `true`; Off
   sends `false` — the exact contract the parent's setCat expects. */
function TriSegment({
  caption,
  value,
  inherited,
  onChange,
  disabled,
}: {
  caption: string;
  value: boolean | null | undefined;
  inherited: boolean;
  onChange: (next: boolean | undefined) => void;
  disabled?: boolean;
}) {
  const current = value === true ? "on" : value === false ? "off" : "inherit";
  const segments: { key: string; val: boolean | undefined; label: string; active: string }[] = [
    { key: "inherit", val: undefined, label: "Default", active: "bg-surface text-foreground" },
    { key: "on", val: true, label: "On", active: "bg-success-soft text-success" },
    { key: "off", val: false, label: "Off", active: "bg-destructive-soft text-destructive" },
  ];
  return (
    <div className="flex flex-col gap-1">
      <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">{caption}</span>
      <div className="inline-flex items-center gap-0.5 rounded-md border border-border bg-muted/40 p-0.5">
        {segments.map((segment) => {
          const active = segment.key === current;
          return (
            <button
              key={segment.key}
              type="button"
              disabled={disabled}
              onClick={() => onChange(segment.val)}
              className={`h-6 min-w-[48px] rounded px-2 text-[11px] font-medium transition disabled:opacity-50 ${
                active ? `${segment.active} shadow-xs` : "text-muted-foreground hover:text-foreground"
              }`}
            >
              {segment.label}
            </button>
          );
        })}
      </div>
      <span className="text-[10px] text-muted-foreground/70">Workspace: {inherited ? "On" : "Off"}</span>
    </div>
  );
}


/* ── Detail sub-navigation ─────────────────────────────────────────────────
   A macOS-style segmented control. One section body shows at a time so the
   operator always knows what they're editing. Override-bearing sections carry
   a live count badge. */
type Section = "overview" | "campaign" | "sequence" | "inboxes" | "leads" | "reply" | "categories";

function SectionSwitcher({
  section,
  onChange,
  replyCount,
  categoryCount,
}: {
  section: Section;
  onChange: (next: Section) => void;
  replyCount: number;
  categoryCount: number;
}) {
  // Sequence carries no badge: it's Smartlead truth, not an override.
  const items: { key: Section; label: string; count: number }[] = [
    { key: "overview", label: "Overview", count: 0 },
    { key: "campaign", label: "Campaign", count: 0 },
    { key: "sequence", label: "Sequence", count: 0 },
    { key: "inboxes", label: "Inboxes", count: 0 },
    { key: "leads", label: "Leads", count: 0 },
    { key: "reply", label: "Reply handling", count: replyCount },
    { key: "categories", label: "Categories", count: categoryCount },
  ];
  return (
    <div className="flex">
      <div className="inline-flex items-center gap-0.5 rounded-lg border border-border bg-muted/40 p-0.5">
        {items.map((item) => {
          const active = item.key === section;
          return (
            <button
              key={item.key}
              type="button"
              onClick={() => onChange(item.key)}
              aria-pressed={active}
              className={`inline-flex h-7 items-center gap-1.5 rounded-md px-3 text-[12px] font-medium transition ${
                active ? "bg-surface text-foreground shadow-xs" : "text-muted-foreground hover:text-foreground"
              }`}
            >
              {item.label}
              {item.count > 0 ? (
                <span
                  className={`rounded px-1 py-px text-[9.5px] font-semibold tabular-nums ${
                    active ? "bg-primary text-primary-foreground" : "bg-border text-muted-foreground"
                  }`}
                >
                  {item.count}
                </span>
              ) : null}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/* ── Campaign identity popover (detail header) ─────────────────────────────
   A quiet Info toggle next to the title that reveals the campaign's raw
   identity rows (ID, status, created date) with copy affordances — the
   delete-draft confirm panel's grammar, closed by Escape or an outside click
   (the campaign-filter popover idiom). */
function CampaignInfoRow({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (copiedTimer.current) clearTimeout(copiedTimer.current);
    },
    [],
  );
  const copyValue = () => {
    // clipboard is undefined on non-secure origins; the button just no-ops
    // there instead of throwing before the catch can run.
    void navigator.clipboard
      ?.writeText(value)
      .then(() => {
        setCopied(true);
        if (copiedTimer.current) clearTimeout(copiedTimer.current);
        copiedTimer.current = setTimeout(() => setCopied(false), 1500);
      })
      .catch(() => undefined);
  };
  return (
    <div className="flex items-center justify-between gap-2">
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="text-[10px] font-semibold uppercase tracking-wide text-foreground-subtle">
          {label}
        </span>
        <span className="truncate font-mono text-[12px] tabular-nums" title={value}>
          {value}
        </span>
      </div>
      <button
        type="button"
        aria-label={`Copy ${label.toLowerCase()}`}
        onClick={copyValue}
        className={`inline-flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted/70 hover:text-foreground`}
      >
        {copied ? <Check className="size-3 text-success" /> : <Copy className="size-3" />}
      </button>
    </div>
  );
}

function CampaignInfoPopover({ detail, status }: { detail: CampaignDetail; status: string | null }) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
        // Focus may be on a copy button inside the popover; return it to the
        // trigger instead of dropping it on <body>.
        triggerRef.current?.focus();
      }
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const created = detail.createdAt
    ? new Date(detail.createdAt).toLocaleDateString(undefined, {
        year: "numeric",
        month: "short",
        day: "numeric",
      })
    : null;

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        ref={triggerRef}
        aria-label="Campaign details"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((prev) => !prev)}
        className={`inline-flex size-5 items-center justify-center rounded text-muted-foreground transition-colors hover:text-foreground`}
      >
        <Info className="size-3.5" />
      </button>
      {open ? (
        <div className="absolute left-0 top-full z-20 mt-1.5 flex w-60 flex-col gap-2 rounded-lg border border-border bg-surface p-2.5 shadow-pop">
          <CampaignInfoRow label="Campaign ID" value={detail.id} />
          <CampaignInfoRow label="Status" value={statusLabel(status)} />
          {created ? <CampaignInfoRow label="Created" value={created} /> : null}
        </div>
      ) : null}
    </div>
  );
}

/* ── Overview (analytics) contract mirrors ─────────────────────────────────
   Declared locally so the client never imports the server module — same
   pattern as the CampaignOverrides / CampaignInbox mirrors above. Shapes match
   getCampaignOverviewAction's return exactly (structural typing keeps the
   assignment sound). */
type OverviewSummary = {
  sent: number;
  uniqueSent: number;
  opens: number;
  clicks: number;
  replies: number;
  bounces: number;
  unsubscribed: number;
  totalLeads: number;
  drafted: number;
  sequenceCount: number | null;
  leadStats: {
    total: number;
    notStarted: number;
    inProgress: number;
    paused: number;
    completed: number;
    stopped: number;
    blocked: number;
    interested: number;
  } | null;
};
type OverviewReplyStats = {
  replies30d: number;
  positive30d: number;
  perDay: { date: string; replies: number; positive: number }[];
  categories: { label: string; count: number; sentimentType: string }[];
};
type OverviewBounceSplit = { total: number; senderBounces: number; leadBounces: number };
type CampaignOverview = {
  summary: OverviewSummary;
  replyStats: OverviewReplyStats | null;
  bounceSplit: OverviewBounceSplit | null;
};
/* The KPI strip's time window and the per-window tile payload (mirrors
   getCampaignOverviewAction's tiles for bounded ranges). */
type OverviewRangeKey = "all" | "30d" | "7d";
type OverviewTiles = {
  sent: number;
  uniqueSent: number;
  opens: number;
  clicks: number;
  replies: number;
  bounces: number;
  unsubscribed: number;
  bounceSplit: OverviewBounceSplit | null;
};
const OVERVIEW_RANGE_OPTIONS: { key: OverviewRangeKey; label: string }[] = [
  { key: "all", label: "All time" },
  { key: "30d", label: "Last 30 days" },
  { key: "7d", label: "Last 7 days" },
];

/* ── Overview drill-down (KPI tile → record modal) contract mirrors ────────
   Same local-mirror pattern as above. Message rows match the rows in
   getCampaignDrilldownAction's data (Smartlead's message-level statistics);
   reply rows match getAnalyticsDrilldownAction's data.rows (our categorized
   reply events). */
type OverviewDrillKind = "sent" | "opened" | "clicked" | "replied" | "unsubscribed" | "bounced";
type DrillMessageRow = {
  statsId: string;
  leadId: string | null;
  leadName: string;
  leadEmail: string;
  leadCategory: string | null;
  sentTime: string | null;
  openTime: string | null;
  replyTime: string | null;
  subject: string | null;
  isBounced: boolean;
  bounceType: "recipient" | "sender" | null;
};
type DrillReplyRow = {
  leadId: string | null;
  leadName: string;
  company: string | null;
  email: string | null;
  campaignName: string | null;
  receivedAt: string;
  category: string | null;
  sentimentType: string | null;
  proposalStatus: string | null;
  snippet: string;
  smartleadLeadId: string | null;
};
/* The loaded page(s) for one drill kind. The two row shapes never mix: replies
   come from the analytics drill (categorized, last 30 days, capped at 200 by
   that contract), everything else pages through the campaign statistics
   endpoint by offset. */
type OverviewDrillData =
  | { mode: "messages"; rows: DrillMessageRow[]; total: number; truncated?: boolean }
  | { mode: "replies"; rows: DrillReplyRow[]; total: number };

const DRILL_TITLES: Record<OverviewDrillKind, string> = {
  sent: "Sent messages",
  opened: "Opened messages",
  clicked: "Clicked messages",
  replied: "Replies",
  unsubscribed: "Unsubscribed leads",
  bounced: "Bounced messages",
};

/* Lead-detail contract mirrors for the drill's side panel
   (getCrmLeadDetailAction's payload, narrowed to what the compact card
   renders; the same local-mirror pattern as the drill rows above). */
type DrillLeadDetailProposal = { sentiment: string | null; sentiment_type: string | null; status: string | null };
type DrillLeadDetailReply = {
  id: string;
  subject: string | null;
  snippet: string;
  smartlead_category: string | null;
  received_at: string | null;
  created_at: string;
  latestProposal: DrillLeadDetailProposal | null;
};
type DrillLeadDetailExport = { id: string; campaign_name: string | null; exported_at: string };
type DrillLeadDetailPayload = {
  lead: Record<string, unknown>;
  smartleadLeadId: string | null;
  replies: DrillLeadDetailReply[];
  repliesTotal: number;
  exports: DrillLeadDetailExport[];
};

/* One outbound email from the lead's Smartlead message history
   (getCampaignSentEmailsAction's data.emails; body already flattened to
   plain text server-side). */
type DrillSentEmail = {
  messageId: string;
  subject: string;
  bodyText: string;
  time: string | null;
  from: string;
  fromName: string | null;
};

/* Reads a trimmed string column off the loosely-typed lead record. */
function drillLeadField(lead: Record<string, unknown> | undefined, key: string): string | null {
  const value = lead?.[key];
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

/* Country lives in the raw import blob ("Lead Country"), not a column; this
   is the same source the CRM leads RPC computes it from. */
function drillLeadCountry(lead: Record<string, unknown> | undefined): string | null {
  const direct = drillLeadField(lead, "lead_country");
  if (direct) return direct;
  const raw = lead?.raw;
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const value = (raw as Record<string, unknown>)["Lead Country"];
    if (typeof value === "string" && value.trim() !== "") return value.trim();
  }
  return null;
}

/* "2026-07-03T09:12:00Z" → "Jul 3, 9:12 AM" in the viewer's locale, or null
   when the value is missing or unparsable so the caller can skip the cell. */
function formatDrillTime(iso: string | null): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

/* Compact large numbers (12,400 → "12.4k") for the KPI faces; the full value
   always rides along on the element's title so nothing is lost. */
function compactNumber(value: number): string {
  if (!Number.isFinite(value)) return "0";
  const abs = Math.abs(value);
  if (abs < 1000) return String(value);
  if (abs < 1_000_000) {
    const k = value / 1000;
    return `${Math.abs(k) >= 100 ? Math.round(k) : Math.round(k * 10) / 10}k`;
  }
  const m = value / 1_000_000;
  return `${Math.abs(m) >= 100 ? Math.round(m) : Math.round(m * 10) / 10}M`;
}

/* A part-of-sent rate as a tidy percent, or null when the denominator is 0 so
   the caller can render nothing instead of a divide-by-zero artifact. */
function ratePct(part: number, whole: number): string | null {
  if (whole <= 0) return null;
  // Total opens/clicks count repeat events, so cap the displayed rate.
  const pct = Math.min((part / whole) * 100, 100);
  const rounded = pct >= 10 ? Math.round(pct) : Math.round(pct * 10) / 10;
  return `${rounded}%`;
}

/* "YYYY-MM-DD" → "Jul 3", built from the date parts (never parsed as an ISO
   instant) so the label never drifts a day across timezones. */
function formatOverviewDay(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  if (!y || !m || !d) return iso;
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/* Small titled card for the Overview sections — the analytics twin of the
   inboxes Overview cards (kept local per the file-ownership rules). */
function OverviewCard({
  title,
  action,
  children,
}: {
  title: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="flex flex-col gap-2">
      <div className="flex h-7 shrink-0 items-center justify-between gap-3 px-1">
        <h3 className="text-[12px] font-semibold tracking-tight">{title}</h3>
        {action ? <div className="shrink-0">{action}</div> : null}
      </div>
      <div className="rounded-xl bg-surface p-4 shadow-xs">{children}</div>
    </section>
  );
}

/* One KPI face in the top strip: compact big number, quiet rate underneath.
   With `onOpen` the face is a drillable button (same visual, subtle hover fill,
   inset focus ring so the seam grid's overflow-hidden never clips it); without
   it the face stays an inert div, with `blockedTitle` explaining why when the
   reason isn't simply a zero count (e.g. tracking is disabled). */
function OverviewKpi({
  label,
  value,
  rate,
  onOpen = null,
  blockedTitle = null,
}: {
  label: string;
  value: number;
  rate: string | null;
  onOpen?: ((tile: HTMLButtonElement) => void) | null;
  blockedTitle?: string | null;
}) {
  const face = (
    <>
      <span className="text-[10px] font-semibold uppercase tracking-wide text-foreground-subtle">{label}</span>
      <span
        title={value.toLocaleString()}
        className="text-[20px] font-semibold leading-none tracking-tight font-mono tabular-nums"
      >
        {compactNumber(value)}
      </span>
      <span className="min-h-[13px] text-[10.5px] tabular-nums text-muted-foreground">{rate ?? ""}</span>
    </>
  );
  if (!onOpen) {
    return (
      <div data-tip={blockedTitle ?? undefined} data-tip-down={blockedTitle ? "" : undefined} className="flex flex-col gap-1 bg-surface px-4 py-3">
        {face}
      </div>
    );
  }
  return (
    <button
      type="button"
      onClick={(event) => onOpen(event.currentTarget)}
      className={`flex flex-col gap-1 bg-surface px-4 py-3 text-left transition-colors hover:bg-muted/50 focus-visible:ring-inset`}
    >
      {face}
    </button>
  );
}

/* An inline "big number + unit" pair used in the lead-progress fallback and
   "Interested" stat. */
function OverviewInlineStat({ value, label }: { value: number; label: string }) {
  return (
    <span className="flex items-baseline gap-1" title={value.toLocaleString()}>
      <span className="text-[15px] font-semibold tabular-nums">{compactNumber(value)}</span>
      <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">{label}</span>
    </span>
  );
}

/* Lead-progress buckets, in lifecycle order. Identity comes from the legend and
   the count next to each label — the fills are muted, desaturated tones (a
   primary ramp for progressing states, a neutral ramp for inert ones), never
   raw status colors. "interested" is deliberately absent: it overlaps the other
   buckets, so it rides beside the bar as its own stat, not a segment. */
const LEAD_BUCKETS = [
  { key: "notStarted", label: "Not started", cls: "bg-primary/15" },
  { key: "inProgress", label: "In progress", cls: "bg-primary/45" },
  { key: "paused", label: "Paused", cls: "bg-primary/25" },
  { key: "completed", label: "Completed", cls: "bg-primary" },
  { key: "stopped", label: "Stopped", cls: "bg-muted-foreground/40" },
  { key: "blocked", label: "Blocked", cls: "bg-muted-foreground/65" },
] as const;

function LeadProgress({ leadStats }: { leadStats: NonNullable<OverviewSummary["leadStats"]> }) {
  const segments = LEAD_BUCKETS.map((bucket) => ({
    ...bucket,
    value: leadStats[bucket.key],
  })).filter((segment) => segment.value > 0);
  const sum = segments.reduce((total, segment) => total + segment.value, 0);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-5">
        <div className="min-w-0 flex-1">
          {sum > 0 ? (
            <div className="flex h-2.5 gap-[2px] overflow-hidden rounded-full">
              {segments.map((segment) => (
                <div
                  key={segment.key}
                  className={segment.cls}
                  style={{ width: `${(segment.value / sum) * 100}%` }}
                  title={`${segment.label}: ${segment.value.toLocaleString()}`}
                />
              ))}
            </div>
          ) : (
            <div className="h-2.5 rounded-full bg-muted" />
          )}
        </div>
        <div className="shrink-0 text-right">
          <div title={leadStats.interested.toLocaleString()} className="text-[15px] font-semibold leading-none tabular-nums">
            {compactNumber(leadStats.interested)}
          </div>
          <div className="mt-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
            Interested
          </div>
        </div>
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-1.5">
        {segments.map((segment) => (
          <span key={segment.key} className="flex items-center gap-1.5 text-[11px]">
            <span className={`size-2 rounded-[3px] ${segment.cls}`} aria-hidden />
            <span className="text-muted-foreground">{segment.label}</span>
            <span className="font-medium tabular-nums" title={segment.value.toLocaleString()}>
              {compactNumber(segment.value)}
            </span>
          </span>
        ))}
      </div>
    </div>
  );
}

/* Replies, last 30 days — the DayColumnChart idiom rebuilt locally: columns
   fill the wrapper height, each day's replies scale to the peak, and the
   positive share paints as a darker segment at the base of the same column. */
/* Chart hover card — replaces the browser-default title bubble on the reply
   chart's columns. Surface card in the popover grammar (no menu animation: it
   follows the cursor, so per-column motion would flicker), anchored above the
   hovered column and clamped to the plot's edges; pointer-events off so a
   sweep can never get trapped on it. Analytics-client twin, kept local per
   the file-ownership rules. */
function ChartHoverCard({
  index,
  count,
  title,
  rows,
}: {
  index: number;
  count: number;
  title: string;
  rows: { label: string; value: number; dot?: string; muted?: boolean }[];
}) {
  const center = ((index + 0.5) / count) * 100;
  const position: CSSProperties =
    center <= 10 ? { left: 0 } : center >= 90 ? { right: 0 } : { left: `${center}%`, transform: "translateX(-50%)" };
  const hasDots = rows.some((row) => row.dot);
  return (
    <div
      className="pointer-events-none absolute bottom-full z-20 mb-1.5 min-w-[130px] rounded-lg border border-border bg-surface px-2.5 py-2 shadow-pop"
      style={position}
    >
      <p className="text-[10px] font-semibold uppercase tracking-[0.08em] text-foreground-subtle">{title}</p>
      <div className="mt-1.5 flex flex-col gap-1">
        {rows.map((row) => (
          <div key={row.label} className="flex items-center gap-1.5 text-[11.5px]">
            {hasDots ? (
              <i className="size-2 shrink-0 rounded-full" style={{ background: row.dot ?? "transparent" }} />
            ) : null}
            <span className="text-muted-foreground">{row.label}</span>
            <span className={`ml-auto pl-4 font-mono tabular-nums ${row.muted ? "text-muted-foreground" : "font-medium"}`}>
              {row.value.toLocaleString()}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function ReplyDayChart({ days }: { days: OverviewReplyStats["perDay"] }) {
  const [hovered, setHovered] = useState<number | null>(null);
  const max = days.reduce((peak, day) => Math.max(peak, day.replies), 0);
  const labelIndexes = new Set(
    days.length > 4 ? [0, Math.floor((days.length - 1) / 2), days.length - 1] : days.map((_, i) => i),
  );
  const hoveredDay = hovered !== null ? days[hovered] : null;
  return (
    <div className="flex flex-col gap-1">
      <div
        className="relative flex h-36 items-end gap-[3px] border-b border-border/70 pt-3"
        onMouseLeave={() => setHovered(null)}
      >
        {days.map((day, index) => {
          const total = max > 0 ? (day.replies / max) * 100 : 0;
          const positivePortion =
            day.replies > 0 ? (Math.min(day.positive, day.replies) / day.replies) * 100 : 0;
          return (
            <div
              key={day.date || index}
              onMouseEnter={() => setHovered(index)}
              // h-full is load-bearing: without a definite column height the
              // percentage-height bars inside resolve to 0 and nothing paints.
              className="flex h-full flex-1 flex-col justify-end transition-opacity hover:opacity-75"
            >
              <div
                className="flex w-full flex-col justify-end overflow-hidden rounded-t bg-primary/25"
                style={{ height: `${Math.max(total, day.replies > 0 ? 4 : 1.5)}%` }}
              >
                <div className="w-full bg-primary" style={{ height: `${positivePortion}%` }} />
              </div>
            </div>
          );
        })}
        {hoveredDay !== null && hovered !== null ? (
          <ChartHoverCard
            index={hovered}
            count={days.length}
            title={formatOverviewDay(hoveredDay.date)}
            rows={[
              { label: "Replies", value: hoveredDay.replies, dot: "color-mix(in srgb, var(--primary) 25%, var(--surface))" },
              { label: "Positive", value: hoveredDay.positive, dot: "var(--primary)" },
            ]}
          />
        ) : null}
      </div>
      <div className="flex gap-[3px]">
        {days.map((day, index) => (
          <div key={day.date || index} className="flex flex-1 justify-center">
            {labelIndexes.has(index) ? (
              <span className="whitespace-nowrap text-[9.5px] tabular-nums text-muted-foreground/70">
                {formatOverviewDay(day.date)}
              </span>
            ) : null}
          </div>
        ))}
      </div>
    </div>
  );
}

/* Reply categories — the top eight by count, each a label, a subtle bar scaled
   to the busiest category, and its count. */
function ReplyCategoryList({ categories }: { categories: OverviewReplyStats["categories"] }) {
  const top = categories.slice(0, 8);
  const max = top.reduce((peak, category) => Math.max(peak, category.count), 0);
  return (
    <div className="flex flex-col gap-2.5">
      {top.map((category) => (
        <div key={category.label} className="flex items-center gap-3">
          <span className="w-[132px] shrink-0 truncate text-[12px] text-foreground" title={category.label}>
            {category.label}
          </span>
          <div className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-muted">
            <div
              className="h-full rounded-full bg-primary/70"
              style={{ width: `${max > 0 ? (category.count / max) * 100 : 0}%` }}
            />
          </div>
          <span
            className="w-9 shrink-0 text-right text-[12px] font-medium tabular-nums"
            title={category.count.toLocaleString()}
          >
            {compactNumber(category.count)}
          </span>
        </div>
      ))}
    </div>
  );
}

/* One message-level record in the drill modal: identity line, quiet subject,
   event time(s) on the right. Bounced rows carry a recipient|sender badge
   (sender bounces are our own mailbox failing, not the recipient's). */
function MessageDrillRow({ row, kind, onSelect }: { row: DrillMessageRow; kind: OverviewDrillKind; onSelect: () => void }) {
  const openLike = kind === "opened" || kind === "clicked";
  const openTime = openLike ? formatDrillTime(row.openTime) : null;
  const sentTime = formatDrillTime(row.sentTime);
  return (
    <DrillLeadRowShell leadId={row.leadId} onSelect={onSelect}>
    <div className="flex items-start justify-between gap-3 border-b border-border/60 py-2.5 last:border-b-0">
      <div className="flex min-w-0 flex-col gap-0.5">
        <div className="flex min-w-0 items-baseline gap-2">
          <span className="truncate text-[12.5px] font-medium" title={row.leadName}>
            {row.leadName}
          </span>
          <span className="truncate text-[11px] text-muted-foreground" title={row.leadEmail}>
            {row.leadEmail}
          </span>
          {kind === "bounced" ? (
            row.bounceType === "sender" ? (
              <span
                data-tip="Sender-originated bounce: the sending mailbox failed, not the recipient."
                className="shrink-0 rounded bg-warning-soft px-1.5 py-px text-[10px] font-semibold text-warning"
              >
                Sender
              </span>
            ) : (
              <span className="shrink-0 rounded bg-muted px-1.5 py-px text-[10px] font-semibold text-muted-foreground">
                Recipient
              </span>
            )
          ) : null}
        </div>
        {kind !== "unsubscribed" && row.subject ? (
          <span className="truncate text-[11px] text-muted-foreground" title={row.subject}>
            {row.subject}
          </span>
        ) : null}
      </div>
      <div className="flex shrink-0 flex-col items-end gap-0.5 text-[11px] tabular-nums text-muted-foreground">
        {openLike && openTime ? (
          <span>
            {kind === "opened" ? "Opened" : "Clicked"} {openTime}
          </span>
        ) : null}
        {sentTime ? <span>Sent {sentTime}</span> : null}
      </div>
    </div>
    </DrillLeadRowShell>
  );
}

/* Shared outer chrome for a categorized reply card. Cards linked to a lead
   become buttons that open the lead-detail side panel (hover tint + chevron
   affordance on the right edge); unlinked cards stay inert and say why. */
function DrillLeadRowShell({
  leadId,
  onSelect,
  children,
}: {
  leadId: string | null;
  onSelect: () => void;
  children: ReactNode;
}) {
  const base = "flex flex-col gap-1.5 rounded-lg border border-border px-3 py-2.5";
  if (leadId === null) {
    return (
      <div title="Not linked to a lead" className={base}>
        {children}
      </div>
    );
  }
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onSelect();
        }
      }}
      className={`group relative cursor-pointer ${base} pr-8 transition-colors hover:bg-muted/40`}
    >
      {children}
      <ChevronRight className="pointer-events-none absolute right-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100" />
    </div>
  );
}

/* One categorized reply card in the drill modal: identity, category pill
   (tinted by sentiment), plain-text snippet, received time. */
function ReplyDrillCard({ row, onSelect }: { row: DrillReplyRow; onSelect: () => void }) {
  const received = formatDrillTime(row.receivedAt);
  const pillClass =
    row.sentimentType === "positive"
      ? "bg-success-soft text-success"
      : row.sentimentType === "negative"
        ? "bg-destructive-soft text-destructive"
        : "bg-muted text-muted-foreground";
  return (
    <DrillLeadRowShell leadId={row.leadId} onSelect={onSelect}>
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-baseline gap-2">
          <span className="truncate text-[12.5px] font-medium" title={row.leadName}>
            {row.leadName}
          </span>
          {row.email ? (
            <span className="truncate text-[11px] text-muted-foreground" title={row.email}>
              {row.email}
            </span>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {row.category ? (
            <span className={`rounded px-1.5 py-px text-[10px] font-semibold ${pillClass}`}>{row.category}</span>
          ) : null}
          {received ? <span className="text-[11px] tabular-nums text-muted-foreground">{received}</span> : null}
        </div>
      </div>
      {row.snippet ? (
        <p className="line-clamp-2 text-[11.5px] leading-relaxed text-muted-foreground">{row.snippet}</p>
      ) : null}
    </DrillLeadRowShell>
  );
}

/* ── Lead detail side panel (drill modal) ──────────────────────────────── */
function DrillPanelField({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[72px_1fr] items-baseline gap-2 text-[12px]">
      <span className="text-[11px] text-muted-foreground">{label}</span>
      <span className="min-w-0 truncate">{children}</span>
    </div>
  );
}

/* One outbound email in the lead panel's "Emails sent" list: a collapsed
   subject + sent-time row that expands in place to the sender line and the
   full plain-text body. Follow-up steps ride the first email's thread and
   often carry no subject of their own, hence the positional fallback. */
function DrillSentEmailCard({ email, index }: { email: DrillSentEmail; index: number }) {
  const [expanded, setExpanded] = useState(false);
  const time = formatDrillTime(email.time);
  const subject = email.subject.trim() || (index > 0 ? "Follow-up (same thread)" : "(no subject)");
  return (
    <div className="overflow-hidden rounded-lg border border-border/70">
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
        className="flex w-full items-center gap-2 px-3 py-2.5 text-left transition-colors hover:bg-muted/40"
      >
        <ChevronRight
          className={`size-3.5 shrink-0 text-muted-foreground transition-transform ${expanded ? "rotate-90" : ""}`}
        />
        <span className="min-w-0 flex-1 truncate text-[12px] font-medium" title={subject}>
          {subject}
        </span>
        {time ? <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">Sent {time}</span> : null}
      </button>
      {expanded ? (
        <div className="flex flex-col gap-1.5 border-t border-border/60 px-3 py-2.5">
          <p className="truncate text-[11px] text-muted-foreground" title={email.from}>
            From {email.fromName ? `${email.fromName} · ` : ""}
            {email.from}
          </p>
          <p className="max-h-56 overflow-y-auto whitespace-pre-wrap text-[11.5px] leading-relaxed">
            {email.bodyText.trim() || "(empty body)"}
          </p>
        </div>
      ) : null}
    </div>
  );
}

/* The compact lead card that mounts beside the drill panel. The outer wrapper
   carries positioning only (fixed + the persistent centering transform, the
   toast wrapper pattern); the enter/exit motion lives on the inner card via
   anim-drawer-in/out. At lg+ it anchors to the right of the shifted drill
   panel; below lg it overlays centered above the drill with a transparent
   click-to-close backdrop so nothing overflows the viewport. */
function DrillLeadDetailPanel({
  fallbackName,
  detail,
  error,
  sentEmails,
  sentError,
  closing,
  onClose,
  onRetry,
  onRetrySent,
  onOpenLeads,
}: {
  fallbackName: string;
  detail: DrillLeadDetailPayload | null;
  error: string | null;
  sentEmails: DrillSentEmail[] | null;
  sentError: string | null;
  closing: boolean;
  onClose: () => void;
  onRetry: () => void;
  onRetrySent: () => void;
  onOpenLeads: (searchTerm: string) => void;
}) {
  const lead = detail?.lead;
  const name =
    [drillLeadField(lead, "first_name"), drillLeadField(lead, "last_name")].filter(Boolean).join(" ") ||
    fallbackName;
  const subtitle = [drillLeadField(lead, "title"), drillLeadField(lead, "company")].filter(Boolean).join(" · ");
  const email = drillLeadField(lead, "email");
  const linkedin = drillLeadField(lead, "linkedin_url");
  const country = drillLeadCountry(lead);
  const latestExport = detail?.exports[0] ?? null;
  const campaignName = latestExport?.campaign_name ?? drillLeadField(lead, "smartlead_campaign_name");
  const recentReplies = detail ? detail.replies.slice(0, 3) : [];
  const moreReplies = detail ? detail.repliesTotal - recentReplies.length : 0;

  return (
    <div
      className="fixed inset-0 z-10 flex cursor-pointer items-center justify-center p-4 lg:inset-auto lg:left-[calc(50%+144px)] lg:top-1/2 lg:block lg:-translate-y-1/2 lg:p-0"
      onClick={(event) => {
        // Below lg this wrapper doubles as a transparent click-to-close
        // backdrop; at lg+ it shrink-wraps the card, so this never fires.
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-label={`Lead details: ${name}`}
        className={`flex max-h-[85vh] w-[400px] max-w-[calc(100vw-2rem)] cursor-auto flex-col overflow-hidden rounded-xl border border-border bg-surface shadow-pop ${
          closing ? "anim-drawer-out" : "anim-drawer-in"
        }`}
      >
        <div className="flex items-start justify-between gap-3 border-b border-border px-4 py-3">
          <div className="flex min-w-0 flex-col gap-0.5">
            <h3 className="truncate text-[13px] font-semibold tracking-tight">{name}</h3>
            {subtitle ? <p className="truncate text-[11px] text-muted-foreground">{subtitle}</p> : null}
          </div>
          <button type="button" aria-label="Close lead details" onClick={onClose} className={ICON_BTN_QUIET}>
            <X className="size-4" />
          </button>
        </div>

        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-4 py-4">
          {error !== null ? (
            <div className="flex items-center gap-2 py-4 text-[12px] text-muted-foreground">
              <span>{error}</span>
              <button
                type="button"
                onClick={onRetry}
                className={`font-medium text-primary transition-colors hover:opacity-80 rounded`}
              >
                Retry
              </button>
            </div>
          ) : detail === null ? (
            <div className="flex flex-col gap-2.5">
              {Array.from({ length: 4 }).map((_, index) => (
                <div key={index} className="flex items-center gap-3">
                  <div className="h-3.5 w-20 animate-pulse rounded bg-muted" />
                  <div className="h-3.5 flex-1 animate-pulse rounded bg-muted/70" />
                </div>
              ))}
            </div>
          ) : (
            <>
              <div className="flex flex-col gap-1.5">
                {email ? (
                  <DrillPanelField label="Email">
                    <a
                      href={`mailto:${email}`}
                      className={`text-foreground underline-offset-2 hover:underline`}
                    >
                      {email}
                    </a>
                  </DrillPanelField>
                ) : null}
                {linkedin ? (
                  <DrillPanelField label="LinkedIn">
                    <a
                      href={linkedin}
                      target="_blank"
                      rel="noreferrer"
                      className={`inline-flex max-w-full items-center gap-1 text-foreground underline-offset-2 hover:underline`}
                    >
                      <span className="min-w-0 truncate">{linkedin.replace(/^https?:\/\/(www\.)?/, "")}</span>
                      <ExternalLink className="size-3 shrink-0 text-muted-foreground" />
                    </a>
                  </DrillPanelField>
                ) : null}
                {country ? <DrillPanelField label="Country">{country}</DrillPanelField> : null}
                {!email && !linkedin && !country ? (
                  <p className="text-[12px] text-muted-foreground">No contact details stored.</p>
                ) : null}
              </div>

              <div className="flex flex-col gap-1.5">
                <h4 className="text-[10.5px] font-semibold uppercase tracking-[0.08em] text-foreground-subtle">
                  Campaign
                </h4>
                {campaignName ? (
                  <p className="flex min-w-0 items-baseline gap-2 text-[12px]">
                    <span className="inline-block max-w-[200px] truncate rounded bg-muted px-1.5 py-px align-middle text-[10.5px] font-medium text-muted-foreground">
                      {campaignName}
                    </span>
                    {latestExport ? (
                      <span className="shrink-0 text-[11px] text-muted-foreground">
                        exported {formatDrillTime(latestExport.exported_at)}
                      </span>
                    ) : null}
                  </p>
                ) : (
                  <p className="text-[12px] text-muted-foreground">Not exported to a campaign.</p>
                )}
              </div>

              <div className="flex flex-col gap-1.5">
                <h4 className="text-[10.5px] font-semibold uppercase tracking-[0.08em] text-foreground-subtle">
                  Emails sent{sentEmails !== null ? ` (${sentEmails.length.toLocaleString()})` : ""}
                </h4>
                {detail.smartleadLeadId === null ? (
                  <p className="text-[12px] text-muted-foreground">
                    Not linked to a Smartlead lead, so sent messages can&apos;t be looked up.
                  </p>
                ) : sentError !== null ? (
                  <div className="flex items-center gap-2 text-[12px] text-muted-foreground">
                    <span>{sentError}</span>
                    <button
                      type="button"
                      onClick={onRetrySent}
                      className={`font-medium text-primary transition-colors hover:opacity-80 rounded`}
                    >
                      Retry
                    </button>
                  </div>
                ) : sentEmails === null ? (
                  <div className="flex flex-col gap-1.5">
                    {Array.from({ length: 2 }).map((_, index) => (
                      <div key={index} className="h-9 animate-pulse rounded-lg bg-muted/70" />
                    ))}
                  </div>
                ) : sentEmails.length === 0 ? (
                  <p className="text-[12px] text-muted-foreground">No sent emails recorded for this campaign.</p>
                ) : (
                  sentEmails.map((email, index) => (
                    <DrillSentEmailCard key={email.messageId} email={email} index={index} />
                  ))
                )}
              </div>

              <div className="flex flex-col gap-1.5">
                <h4 className="text-[10.5px] font-semibold uppercase tracking-[0.08em] text-foreground-subtle">
                  Replies ({detail.repliesTotal.toLocaleString()})
                </h4>
                {recentReplies.length === 0 ? (
                  <p className="text-[12px] text-muted-foreground">No replies captured for this lead.</p>
                ) : (
                  recentReplies.map((reply) => {
                    const category = reply.latestProposal?.sentiment ?? reply.smartlead_category;
                    const sentimentType = reply.latestProposal?.sentiment_type ?? null;
                    const pillClass =
                      sentimentType === "positive"
                        ? "bg-success-soft text-success"
                        : sentimentType === "negative"
                          ? "bg-destructive-soft text-destructive"
                          : "bg-muted text-muted-foreground";
                    return (
                      <div key={reply.id} className="rounded-lg border border-border/70 px-3 py-2.5">
                        <div className="flex items-center gap-2">
                          <span className="min-w-0 flex-1 truncate text-[12px] font-medium">
                            {reply.subject?.trim() || "(no subject)"}
                          </span>
                          <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
                            {formatDrillTime(reply.received_at ?? reply.created_at)}
                          </span>
                        </div>
                        {reply.snippet ? (
                          <p className="mt-1 line-clamp-2 text-[11.5px] leading-relaxed text-muted-foreground">
                            {reply.snippet}
                          </p>
                        ) : null}
                        {category ? (
                          <span
                            className={`mt-1.5 inline-block max-w-40 truncate rounded px-1.5 py-px text-[10px] font-semibold ${pillClass}`}
                          >
                            {category}
                          </span>
                        ) : null}
                      </div>
                    );
                  })
                )}
                {moreReplies > 0 ? (
                  <p className="text-[11px] text-muted-foreground">
                    {moreReplies.toLocaleString()} more {moreReplies === 1 ? "reply" : "replies"}
                  </p>
                ) : null}
              </div>
            </>
          )}
        </div>

        {detail !== null && error === null ? (
          <div className="flex items-center justify-end border-t border-border px-4 py-3">
            <button
              type="button"
              onClick={() => onOpenLeads(email ?? name)}
              className={`${BTN_OUTLINE} h-7 px-3 text-[11.5px]`}
            >
              <ExternalLink className="size-3.5" />
              Open in Leads
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}

/* The KPI drill-down modal (host modal grammar: dimmed blurred backdrop,
   Escape and backdrop-click close, body scroll lock, internal scroll).
   Message kinds page through the campaign statistics offsets via Load more;
   Replies shows the analytics drill's categorized rows in one shot. */
function OverviewDrillModal({
  kind,
  campaignId,
  range,
  data,
  loadingMore,
  error,
  onRetry,
  onLoadMore,
  onClose,
}: {
  kind: OverviewDrillKind;
  campaignId: string;
  range: OverviewRangeKey;
  data: OverviewDrillData | null;
  loadingMore: boolean;
  error: string | null;
  onRetry: () => void;
  onLoadMore: () => void;
  onClose: () => void;
}) {
  const router = useRouter();
  const { closing, playExit } = useExit();
  const beginClose = () => playExit(onClose);

  /* ── Lead detail side panel state ──────────────────────────────────────
     Selecting a linked reply row opens the panel; selecting another row swaps
     its content in place (the panel stays mounted, so the drawer never
     re-slides). Payloads are cached per leadId for the modal's lifetime and a
     monotonic ticket guards rapid row-click switching. */
  const [panelLead, setPanelLead] = useState<{ leadId: string; fallbackName: string } | null>(null);
  const [panelClosing, setPanelClosing] = useState(false);
  const panelCloseTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [leadDetail, setLeadDetail] = useState<DrillLeadDetailPayload | null>(null);
  const [leadError, setLeadError] = useState<string | null>(null);
  const detailCache = useRef(new Map<string, DrillLeadDetailPayload>());
  const detailTicket = useRef(0);
  /* Sent-email history for the selected lead (the panel's "Emails sent"
     section). Keys off the Smartlead lead id the CRM detail resolves, so it
     loads once the detail lands; same cache + ticket idiom as the detail. */
  const [sentEmails, setSentEmails] = useState<DrillSentEmail[] | null>(null);
  const [sentError, setSentError] = useState<string | null>(null);
  const sentCache = useRef(new Map<string, DrillSentEmail[]>());
  const sentTicket = useRef(0);
  useEffect(
    () => () => {
      if (panelCloseTimer.current) clearTimeout(panelCloseTimer.current);
    },
    [],
  );

  const loadSentEmails = (smartleadLeadId: string) => {
    const ticket = sentTicket.current + 1;
    sentTicket.current = ticket;
    const cached = sentCache.current.get(smartleadLeadId) ?? null;
    setSentError(null);
    setSentEmails(cached);
    if (cached) return;
    void (async () => {
      try {
        const result = await getCampaignSentEmailsAction(campaignId, smartleadLeadId);
        if (sentTicket.current !== ticket) return;
        if (result.ok && result.data) {
          sentCache.current.set(smartleadLeadId, result.data.emails);
          setSentEmails(result.data.emails);
        } else {
          setSentError(result.message);
        }
      } catch {
        if (sentTicket.current !== ticket) return;
        setSentError("Could not load sent emails. Check your connection and retry.");
      }
    })();
  };

  /* The sent-email fetch chains off the detail landing (cached or fresh)
     because it needs the Smartlead lead id the detail resolves; unlinked
     leads skip it and the panel says why. */
  const loadLeadDetail = (leadId: string) => {
    const ticket = detailTicket.current + 1;
    detailTicket.current = ticket;
    const cached = detailCache.current.get(leadId) ?? null;
    setLeadError(null);
    setLeadDetail(cached);
    if (cached) {
      if (cached.smartleadLeadId !== null) loadSentEmails(cached.smartleadLeadId);
      return;
    }
    void (async () => {
      try {
        const result = await getCrmLeadDetailAction(leadId);
        if (detailTicket.current !== ticket) return;
        if (result.ok && result.data) {
          const next = result.data as unknown as DrillLeadDetailPayload;
          detailCache.current.set(leadId, next);
          setLeadDetail(next);
          if (next.smartleadLeadId !== null) loadSentEmails(next.smartleadLeadId);
        } else {
          setLeadError(result.message);
        }
      } catch {
        if (detailTicket.current !== ticket) return;
        setLeadError("Could not load lead details. Check your connection and retry.");
      }
    })();
  };

  const openLeadPanel = (row: { leadId: string | null; leadName: string; email?: string | null; leadEmail?: string }) => {
    if (row.leadId === null) return;
    // Reopening during the 150ms exit cancels it so the panel stays mounted.
    if (panelCloseTimer.current) {
      clearTimeout(panelCloseTimer.current);
      panelCloseTimer.current = null;
    }
    setPanelClosing(false);
    // Swapping leads drops the previous sent list immediately so it never
    // flashes under the new lead while its detail is still in flight.
    if (panelLead?.leadId !== row.leadId) {
      sentTicket.current += 1;
      setSentEmails(null);
      setSentError(null);
    }
    setPanelLead({ leadId: row.leadId, fallbackName: row.leadName || row.email || row.leadEmail || "Unknown" });
    loadLeadDetail(row.leadId);
  };

  const closeLeadPanel = useCallback(() => {
    if (panelCloseTimer.current) return;
    detailTicket.current += 1; // any in-flight detail fetch discards its result
    sentTicket.current += 1;
    setPanelClosing(true);
    panelCloseTimer.current = setTimeout(() => {
      panelCloseTimer.current = null;
      setPanelClosing(false);
      setPanelLead(null);
      setLeadDetail(null);
      setLeadError(null);
      setSentEmails(null);
      setSentError(null);
    }, 150);
  }, []);

  const panelOpen = panelLead !== null && !panelClosing;

  // Lock the page behind the modal (CampaignWizard idiom).
  useEffect(() => {
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
    };
  }, []);

  // Escape closes the lead side panel first when open (the drill shift
  // animates back), then a second Escape closes the modal (the
  // LeadEditorModal listener idiom).
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (panelOpen) closeLeadPanel();
      else beginClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [panelOpen, closeLeadPanel]);

  // Move focus into the dialog so keyboard users are not left behind the
  // backdrop (restore-to-tile is handled by the opener's anchor ref).
  const panelRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const t = window.setTimeout(() => panelRef.current?.focus(), 0);
    return () => window.clearTimeout(t);
  }, []);

  const rows = data?.rows ?? [];
  const total = data?.total ?? 0;
  const canLoadMore = data !== null && data.mode === "messages" && rows.length < total;
  const noun = (count: number) =>
    kind === "replied"
      ? count === 1
        ? "reply"
        : "replies"
      : count === 1
        ? "message record"
        : "message records";

  // The replies drill is day-bounded, so its jump-off carries the matching
  // window (all time keeps the drill's 30-day contract).
  const repliedDays = range === "7d" ? 7 : 30;
  const openInLeads = () => {
    router.push(
      `/leads?campaigns=${campaignId}&mode=include${kind === "replied" ? `&kind=replies&days=${repliedDays}` : ""}`,
    );
  };

  return (
    <div
      className={`fixed inset-0 z-50 flex cursor-pointer items-center justify-center bg-background/70 p-4 backdrop-blur-sm ${closing ? "anim-overlay-out" : "anim-overlay-in"}`}
      onClick={(event) => {
        if (event.target === event.currentTarget) beginClose();
      }}
    >
      {/* Shift wrapper, the ONE sanctioned persistent transform: while the
          lead side panel is open at lg+ the drill panel glides 212px left so
          the pair reads as a centered group. Safe because the drill panel
          contains no fixed or sticky descendants. Below lg the panel overlays
          instead, so no shift is applied. */}
      <div
        className={`w-full max-w-2xl cursor-auto transition-transform duration-200 ease-premium motion-reduce:transition-none ${
          panelOpen && !closing ? "lg:-translate-x-[212px]" : ""
        }`}
      >
        <div
          ref={panelRef}
          role="dialog"
          aria-modal="true"
          aria-label={DRILL_TITLES[kind]}
          tabIndex={-1}
          className={`flex max-h-[85vh] w-full flex-col overflow-hidden rounded-xl border border-border bg-surface shadow-pop outline-none ${closing ? "anim-panel-out" : "anim-panel-in"}`}
        >
          {/* Header */}
          <div className="flex items-start justify-between gap-3 border-b border-border px-4 py-3">
            <div className="flex min-w-0 flex-col gap-0.5">
              <h2 className="text-[13.5px] font-semibold tracking-tight">{DRILL_TITLES[kind]}</h2>
              <p className="text-[11px] text-muted-foreground">
                {kind === "replied"
                  ? `Replies captured by this app in the last ${repliedDays} days, with their categories.`
                  : range === "all"
                    ? "Message-level records from Smartlead's campaign statistics."
                    : `Message-level records from Smartlead's campaign statistics, last ${range === "7d" ? 7 : 30} days.`}
                {data?.mode === "messages" && data.truncated
                  ? ` Large window: showing the first ${data.total.toLocaleString()} scanned records.`
                  : null}
              </p>
            </div>
            <button type="button" aria-label="Close" onClick={beginClose} className={ICON_BTN_QUIET}>
              <X className="size-4" />
            </button>
          </div>

          {/* Body (internal scroll) */}
          <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
            {error !== null ? (
              <div className="flex items-center gap-2 py-6 text-[12px] text-muted-foreground">
                <span>{error}</span>
                <button
                  type="button"
                  onClick={onRetry}
                  className={`font-medium text-primary transition-colors hover:opacity-80 rounded`}
                >
                  Retry
                </button>
              </div>
            ) : data === null ? (
              <div className="flex flex-col gap-2 py-1">
                {Array.from({ length: 6 }).map((_, index) => (
                  <div key={index} className="flex flex-col gap-1.5 rounded-lg border border-border px-3 py-2.5">
                    <div className="h-3 w-40 animate-pulse rounded bg-muted" />
                    <div className="h-2.5 w-64 max-w-full animate-pulse rounded bg-muted" />
                  </div>
                ))}
              </div>
            ) : rows.length === 0 ? (
              <p className="py-6 text-center text-[12px] text-muted-foreground">No records to show.</p>
            ) : data.mode === "replies" ? (
              <div className="flex flex-col gap-2">
                {data.rows.map((row, index) => (
                  <ReplyDrillCard
                    key={`${row.receivedAt}:${row.email ?? row.leadName}:${index}`}
                    row={row}
                    onSelect={() => openLeadPanel(row)}
                  />
                ))}
              </div>
            ) : (
              <div className="flex flex-col">
                {data.rows.map((row) => (
                  <MessageDrillRow key={row.statsId} row={row} kind={kind} onSelect={() => openLeadPanel(row)} />
                ))}
              </div>
            )}
            {error === null && canLoadMore ? (
              <div className="flex justify-center pt-3">
                <button
                  type="button"
                  disabled={loadingMore}
                  onClick={onLoadMore}
                  className={`${BTN_OUTLINE} h-7 px-3 text-[11.5px]`}
                >
                  {loadingMore ? "Loading…" : "Load more"}
                </button>
              </div>
            ) : null}
          </div>

          {/* Footer */}
          <div className="flex items-center justify-between gap-3 border-t border-border px-4 py-3">
            <span className="text-[11px] tabular-nums text-muted-foreground">
              {data === null
                ? ""
                : rows.length < total
                  ? `Showing first ${rows.length.toLocaleString()} of ${total.toLocaleString()} ${noun(total)}`
                  : `${rows.length.toLocaleString()} ${noun(rows.length)}`}
            </span>
            <button type="button" onClick={openInLeads} className={`${BTN_OUTLINE} h-7 px-3 text-[11.5px]`}>
              <ExternalLink className="size-3.5" />
              Open in Leads
            </button>
          </div>
        </div>
      </div>

      {panelLead !== null ? (
        <DrillLeadDetailPanel
          fallbackName={panelLead.fallbackName}
          detail={leadDetail}
          error={leadError}
          sentEmails={sentEmails}
          sentError={sentError}
          closing={panelClosing || closing}
          onClose={closeLeadPanel}
          onRetry={() => loadLeadDetail(panelLead.leadId)}
          onRetrySent={() => {
            if (leadDetail?.smartleadLeadId) loadSentEmails(leadDetail.smartleadLeadId);
          }}
          onOpenLeads={(searchTerm) => router.push(`/leads?search=${encodeURIComponent(searchTerm)}`)}
        />
      ) : null}
    </div>
  );
}

/* The Overview (analytics) tab body: a calm, scannable read of the campaign's
   stats. Loads lazily and degrades section-by-section as the data contract
   allows. */
function CampaignOverviewSection({
  detail,
  overview,
  loading,
  error,
  onRetry,
}: {
  detail: CampaignDetail;
  overview: CampaignOverview | null;
  loading: boolean;
  error: string | null;
  onRetry: () => void;
}) {
  /* ── KPI drill-down state ────────────────────────────────────────────────
     `drillTicket` is monotonic: every open, retry, and close bumps or
     invalidates it, and an async result only lands if its captured ticket
     still matches (the loadAllGeneration idiom), so close then reopen never
     paints a stale in-flight page. Loaded pages are cached per
     kind+campaignId so reopening a tile is instant. */
  const [drillKind, setDrillKind] = useState<OverviewDrillKind | null>(null);
  const [drillData, setDrillData] = useState<OverviewDrillData | null>(null);
  const [drillError, setDrillError] = useState<string | null>(null);
  const [drillLoadingMore, setDrillLoadingMore] = useState(false);
  const drillTicket = useRef(0);
  const drillCache = useRef(new Map<string, OverviewDrillData>());
  // The tile that opened the modal, so closing restores keyboard focus to it.
  const drillAnchor = useRef<HTMLElement | null>(null);

  /* ── KPI time range ─────────────────────────────────────────────────────
     The segmented control above the KPI strip. "All time" reads the summary
     already loaded by the parent; bounded ranges fetch their tile counters
     once and cache per window, so switching back is instant. The ticket
     mirrors the drill's: a stale response never paints over a newer pick. */
  const [range, setRange] = useState<OverviewRangeKey>("all");
  const [rangeTiles, setRangeTiles] = useState<OverviewTiles | null>(null);
  const [rangeError, setRangeError] = useState<string | null>(null);
  const [rangeLoading, setRangeLoading] = useState(false);
  const rangeTicket = useRef(0);
  const rangeCache = useRef(new Map<OverviewRangeKey, OverviewTiles>());

  const changeRange = (next: OverviewRangeKey) => {
    // Re-clicking the active option must not spawn a duplicate fetch; the
    // error-state Retry button intentionally re-enters with the same range.
    if (next === range && rangeError === null) return;
    const ticket = rangeTicket.current + 1;
    rangeTicket.current = ticket;
    setRange(next);
    setRangeError(null);
    if (next === "all") {
      setRangeLoading(false);
      return;
    }
    const cached = rangeCache.current.get(next) ?? null;
    setRangeTiles(cached);
    if (cached) {
      setRangeLoading(false);
      return;
    }
    setRangeLoading(true);
    void (async () => {
      try {
        const result = await getCampaignOverviewAction(detail.id, next);
        if (rangeTicket.current !== ticket) return;
        if (result.ok && result.tiles) {
          rangeCache.current.set(next, result.tiles);
          setRangeTiles(result.tiles);
        } else {
          setRangeError(result.message);
        }
      } catch {
        if (rangeTicket.current !== ticket) return;
        setRangeError("Could not load the range analytics. Check your connection and retry.");
      } finally {
        if (rangeTicket.current === ticket) setRangeLoading(false);
      }
    })();
  };

  const fetchDrillPage = async (
    kind: OverviewDrillKind,
    ticket: number,
    offset: number,
    baseRows: DrillMessageRow[],
  ) => {
    const cacheKey = `${kind}:${detail.id}:${range}`;
    try {
      if (kind === "replied") {
        // Categorized reply rows from the analytics drill (preferred for
        // replies); its contract is one capped page, so no offset here.
        // The window follows the KPI range (all time keeps the 30-day drill).
        const result = await getAnalyticsDrilldownAction("replies", {
          days: range === "7d" ? 7 : 30,
          campaigns: { mode: "include", ids: [detail.id] },
        });
        if (drillTicket.current !== ticket) return;
        if (result.ok && result.data) {
          const next: OverviewDrillData = {
            mode: "replies",
            rows: result.data.rows,
            total: result.data.total,
          };
          drillCache.current.set(cacheKey, next);
          setDrillData(next);
        } else {
          setDrillError(result.message);
        }
      } else {
        const result = await getCampaignDrilldownAction(detail.id, kind, offset, range);
        if (drillTicket.current !== ticket) return;
        if (result.ok && result.data) {
          // Append by statsId so a shifted upstream page can't duplicate keys.
          const seen = new Set(baseRows.map((row) => row.statsId));
          const merged = [...baseRows, ...result.data.rows.filter((row) => !seen.has(row.statsId))];
          const next: OverviewDrillData = {
            mode: "messages",
            rows: merged,
            total: result.data.total,
            truncated: result.data.truncated,
          };
          drillCache.current.set(cacheKey, next);
          setDrillData(next);
        } else {
          setDrillError(result.message);
        }
      }
    } catch {
      if (drillTicket.current !== ticket) return;
      setDrillError("Could not load the records. Check your connection and retry.");
    } finally {
      if (drillTicket.current === ticket) setDrillLoadingMore(false);
    }
  };

  const openDrill = (kind: OverviewDrillKind, tile: HTMLElement) => {
    drillAnchor.current = tile;
    const ticket = drillTicket.current + 1;
    drillTicket.current = ticket;
    setDrillKind(kind);
    setDrillError(null);
    setDrillLoadingMore(false);
    const cached = drillCache.current.get(`${kind}:${detail.id}:${range}`) ?? null;
    setDrillData(cached);
    if (!cached) void fetchDrillPage(kind, ticket, 0, []);
  };

  const retryDrill = () => {
    if (drillKind === null) return;
    const ticket = drillTicket.current + 1;
    drillTicket.current = ticket;
    setDrillError(null);
    setDrillData(null);
    void fetchDrillPage(drillKind, ticket, 0, []);
  };

  const loadMoreDrill = () => {
    if (drillKind === null || drillData === null || drillData.mode !== "messages") return;
    if (drillLoadingMore || drillData.rows.length >= drillData.total) return;
    setDrillLoadingMore(true);
    void fetchDrillPage(drillKind, drillTicket.current, drillData.rows.length, drillData.rows);
  };

  const closeDrill = () => {
    drillTicket.current += 1; // any in-flight page discards its result
    setDrillKind(null);
    setDrillData(null);
    setDrillError(null);
    setDrillLoadingMore(false);
    const anchor = drillAnchor.current;
    drillAnchor.current = null;
    anchor?.focus();
  };

  if (!overview) {
    if (error) {
      return (
        <div className="flex items-center gap-2 text-[12px] text-muted-foreground">
          <span>{error}</span>
          <button
            type="button"
            onClick={onRetry}
            className={`font-medium text-primary transition-colors hover:opacity-80 rounded`}
          >
            Retry
          </button>
        </div>
      );
    }
    if (loading) {
      return (
        <div className="flex flex-col gap-5">
          <SkeletonKpiStrip tiles={8} />
          <div className="flex gap-4">
            {Array.from({ length: 2 }).map((_, index) => (
              <div key={index} className="h-16 flex-1 animate-pulse rounded-xl bg-surface" />
            ))}
          </div>
          <div className="rounded-xl bg-surface px-4 py-3.5 shadow-xs">
            <SkeletonChart height="h-36" bars={30} />
          </div>
        </div>
      );
    }
    return null;
  }

  const { summary, replyStats, bounceSplit } = overview;
  // The active window's tile counters: all time reads the summary the parent
  // already loaded; bounded ranges read the fetched tiles (null while their
  // first load is in flight, which paints the skeleton grid below).
  const tiles: OverviewTiles | null =
    range === "all"
      ? {
          sent: summary.sent,
          uniqueSent: summary.uniqueSent,
          opens: summary.opens,
          clicks: summary.clicks,
          replies: summary.replies,
          bounces: summary.bounces,
          unsubscribed: summary.unsubscribed,
          bounceSplit,
        }
      : rangeTiles;
  // Smartlead's bounce_count lumps recipient and sender bounces; when the
  // split is available the Bounced KPI shows recipient bounces (the number
  // Smartlead's own UI calls Bounced) and sender failures get their own tile.
  const senderBounces =
    tiles && tiles.bounceSplit ? Math.min(tiles.bounceSplit.senderBounces, tiles.bounces) : 0;
  const leadBounces = tiles ? Math.max(0, tiles.bounces - senderBounces) : 0;
  // A tile is drillable when its drill has records behind it; the Opens and
  // Clicks tiles additionally stay inert (with an explanatory title) when the
  // campaign's tracking for that signal is off. Bounced keys off the combined
  // count so sender-only bounces (KPI face 0) stay reachable; Sender bounces
  // opens the same bounced drill.
  const kpis: {
    label: string;
    value: number;
    rate: string | null;
    kind: OverviewDrillKind;
    drillable: boolean;
    blockedTitle?: string | null;
  }[] = tiles === null
    ? []
    : [
        { label: "Sent", value: tiles.sent, rate: null, kind: "sent", drillable: tiles.sent > 0 },
        {
          // Distinct leads emailed (Smartlead's unique_sent_count) — the
          // people behind the Sent messages. Not drillable: the messages
          // behind it are exactly the Sent drill.
          label: "Unique contacts",
          value: tiles.uniqueSent,
          rate:
            tiles.uniqueSent > 0 && tiles.sent > 0
              ? `≈${(Math.round((tiles.sent / tiles.uniqueSent) * 10) / 10).toLocaleString()} emails each`
              : null,
          kind: "sent",
          drillable: false,
          blockedTitle: "Distinct leads who received at least one email. The Sent tile lists the messages themselves.",
        },
        {
          label: "Opens",
          value: tiles.opens,
          rate: ratePct(tiles.opens, tiles.sent),
          kind: "opened",
          drillable: tiles.opens > 0 && detail.tracking.opens,
          blockedTitle: detail.tracking.opens ? null : "Open tracking is off for this campaign.",
        },
        {
          label: "Clicks",
          value: tiles.clicks,
          rate: ratePct(tiles.clicks, tiles.sent),
          kind: "clicked",
          drillable: tiles.clicks > 0 && detail.tracking.clicks,
          blockedTitle: detail.tracking.clicks ? null : "Click tracking is off for this campaign.",
        },
        {
          label: "Replies",
          value: tiles.replies,
          rate: ratePct(tiles.replies, tiles.sent),
          kind: "replied",
          drillable: tiles.replies > 0,
        },
        {
          label: "Bounced",
          value: leadBounces,
          rate: ratePct(leadBounces, tiles.sent),
          kind: "bounced",
          drillable: tiles.bounces > 0,
        },
        {
          label: "Sender bounces",
          value: senderBounces,
          rate: ratePct(senderBounces, tiles.sent),
          kind: "bounced",
          drillable: senderBounces > 0,
        },
        {
          label: "Unsubscribed",
          value: tiles.unsubscribed,
          rate: null,
          kind: "unsubscribed",
          drillable: tiles.unsubscribed > 0,
        },
      ];
  const hasReplies = replyStats !== null && replyStats.replies30d > 0;

  return (
    <div className="flex flex-col gap-6">
      {/* 1 · KPI strip with its time-range control */}
      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-end">
          <div
            role="group"
            aria-label="KPI time range"
            className="inline-flex items-center gap-0.5 rounded-md border border-border bg-muted/40 p-0.5"
          >
            {OVERVIEW_RANGE_OPTIONS.map((option) => {
              const active = option.key === range;
              return (
                <button
                  key={option.key}
                  type="button"
                  aria-pressed={active}
                  onClick={() => changeRange(option.key)}
                  className={`inline-flex h-7 items-center rounded px-2.5 text-[11.5px] font-medium transition ${
                    active
                      ? "bg-surface text-foreground shadow-xs"
                      : "text-muted-foreground hover:text-foreground"
                  }`}
                >
                  {option.label}
                </button>
              );
            })}
          </div>
        </div>
        {tiles === null ? (
          rangeError !== null ? (
            <div className="flex items-center gap-2 rounded-xl bg-surface px-4 py-6 text-[12px] text-muted-foreground shadow-xs">
              <span>{rangeError}</span>
              <button
                type="button"
                onClick={() => changeRange(range)}
                className={`font-medium text-primary transition-colors hover:opacity-80 rounded`}
              >
                Retry
              </button>
            </div>
          ) : (
            <SkeletonKpiStrip tiles={8} />
          )
        ) : (
          /* 8 faces as a 2×4 grid: eight-across squeezes each face below ~90px
             in the detail pane, which clips one-word labels (UNSUBSCRIBED). */
          <div className="grid grid-cols-2 gap-px overflow-hidden rounded-xl bg-border shadow-xs sm:grid-cols-4">
            {kpis.map((kpi) => (
              <OverviewKpi
                key={kpi.label}
                label={kpi.label}
                value={kpi.value}
                rate={kpi.rate}
                blockedTitle={kpi.blockedTitle ?? null}
                onOpen={kpi.drillable && !loading && !rangeLoading ? (tile) => openDrill(kpi.kind, tile) : null}
              />
            ))}
          </div>
        )}
      </div>

      {/* 2 · Lead progress */}
      <OverviewCard title="Lead progress">
        {summary.leadStats ? (
          <LeadProgress leadStats={summary.leadStats} />
        ) : (
          <div className="flex flex-wrap items-baseline gap-x-6 gap-y-2">
            <OverviewInlineStat value={summary.totalLeads} label="total leads" />
            <OverviewInlineStat value={summary.drafted} label="drafted" />
          </div>
        )}
      </OverviewCard>

      {/* 3 · Replies, last 30 days */}
      <OverviewCard
        title="Replies, last 30 days"
        action={
          hasReplies && replyStats.perDay.some((day) => day.replies > 0) ? (
            <span className="inline-flex items-baseline gap-1 rounded-md bg-muted/70 px-2 py-0.5 text-[11px] font-medium tabular-nums text-muted-foreground">
              Peak <span className="text-foreground">{replyStats.perDay.reduce((m, day) => Math.max(m, day.replies), 0)}</span>/day
            </span>
          ) : null
        }
      >
        {hasReplies ? (
          <ReplyDayChart days={replyStats.perDay} />
        ) : (
          <p className="text-[12px] text-muted-foreground">No replies captured in the last 30 days.</p>
        )}
      </OverviewCard>

      {/* 4 · Reply categories */}
      {hasReplies && replyStats.categories.length > 0 ? (
        <OverviewCard title="Reply categories">
          <ReplyCategoryList categories={replyStats.categories} />
        </OverviewCard>
      ) : null}

      {/* KPI drill-down modal */}
      {drillKind !== null ? (
        <OverviewDrillModal
          kind={drillKind}
          campaignId={detail.id}
          range={range}
          data={drillData}
          loadingMore={drillLoadingMore}
          error={drillError}
          onRetry={retryDrill}
          onLoadMore={loadMoreDrill}
          onClose={closeDrill}
        />
      ) : null}
    </div>
  );
}

/* ── Campaign insights (Overview right rail) contract mirrors ──────────────
   Same local-mirror pattern as the Overview analytics types above. Shapes
   match getCampaignInsightsAction's return (structural typing keeps the
   assignment sound; the follow-up union is relaxed to nullable timestamps). */
type InsightSignal = {
  key: string;
  severity: "warn" | "info";
  label: string;
  count: number;
  href: string;
};
type InsightFollowUp = {
  kind: "unsent_positive" | "scheduled_action";
  id: string;
  leadId: string | null;
  leadName: string;
  leadEmail: string;
  receivedAt: string | null;
  dueAt: string | null;
};
type CampaignBrief = {
  whatChanged: string;
  explanations: { claim: string; metric: string }[];
  recommendedTests: { action: string; expectedOutcome: string }[];
};
type CampaignInsights = {
  signals: InsightSignal[];
  followUps: InsightFollowUp[];
  followUpsTotal: number;
  benchmark: { line: string | null; computedAt: string | null };
  brief: CampaignBrief | null;
  briefMeta: { generatedAt: string | null; model: string | null; dirty: boolean };
  briefModel: { current: string; options: { id: string; label: string }[] };
};

/* Coarse past-tense relative time for the brief's "as of" line and reply
   recency ("just now", "5m ago", "3h ago", "2d ago"). */
function insightRelativeTime(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return "just now";
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/* Forward-looking due label for scheduled follow-ups: relative when near,
   a short date once it's more than a week out, "now" once it has passed. */
function followUpDueLabel(iso: string): string {
  const due = new Date(iso);
  const diff = due.getTime() - Date.now();
  if (diff <= 0) return "now";
  if (diff < 3_600_000) return `in ${Math.max(1, Math.round(diff / 60_000))}m`;
  if (diff < 86_400_000) return `in ${Math.round(diff / 3_600_000)}h`;
  if (diff < 7 * 86_400_000) return `in ${Math.round(diff / 86_400_000)}d`;
  return due.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/* Small titled card for the insights rail — OverviewCard's grammar with a
   tighter body suited to the 340px column. */
function InsightCard({
  title,
  action,
  children,
}: {
  title: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="flex flex-col gap-2">
      <div className="flex h-7 shrink-0 items-center justify-between gap-3 px-1">
        <h3 className="text-[12px] font-semibold tracking-tight">{title}</h3>
        {action ? <div className="shrink-0">{action}</div> : null}
      </div>
      <div className="flex flex-col gap-2 rounded-xl bg-surface px-4 py-3.5 shadow-xs">
        {children}
      </div>
    </section>
  );
}

const INSIGHT_SUBLABEL = "text-[10px] font-semibold uppercase tracking-wide text-foreground-subtle";

function CampaignInsightsRail({
  insights,
  loading,
  error,
  onRetry,
  briefPending,
  briefError,
  briefNote,
  onRegenerate,
  onRetryBrief,
}: {
  insights: CampaignInsights | null;
  loading: boolean;
  error: string | null;
  onRetry: () => void;
  briefPending: boolean;
  briefError: string | null;
  briefNote: string | null;
  onRegenerate: () => void;
  onRetryBrief: () => void;
}) {
  if (!insights) {
    if (error) {
      return (
        <div className="flex items-center gap-2 text-[12px] text-muted-foreground">
          <span>{error}</span>
          <button
            type="button"
            onClick={onRetry}
            className={`font-medium text-primary transition-colors hover:opacity-80 rounded`}
          >
            Retry
          </button>
        </div>
      );
    }
    if (loading) {
      return (
        <div className="flex flex-col gap-5">
          {["Needs attention", "Campaign brief", "Follow-up radar"].map((title) => (
            <section key={title} className="flex flex-col gap-2">
              <div className="flex h-7 shrink-0 items-center px-1">
                <h3 className="text-[12px] font-semibold tracking-tight">{title}</h3>
              </div>
              <div className="flex flex-col gap-2 rounded-xl bg-surface px-4 py-3.5 shadow-xs">
                <div className="h-3 w-3/4 animate-pulse rounded bg-muted" />
                <div className="h-3 w-1/2 animate-pulse rounded bg-muted" />
                <div className="h-3 w-2/3 animate-pulse rounded bg-muted" />
              </div>
            </section>
          ))}
        </div>
      );
    }
    return null;
  }

  const { brief, briefMeta, briefModel } = insights;
  // The stored model can predate the current option list; fall back to the
  // raw id so the footer line never goes blank.
  const modelLabel = (id: string | null) =>
    id === null ? null : (briefModel.options.find((option) => option.id === id)?.label ?? id);

  return (
    <div className="flex flex-col gap-5">
      {/* Needs attention: deterministic operational signals, each a jump-off link. */}
      <InsightCard title="Needs attention">
        {insights.signals.length === 0 ? (
          <div className="flex items-center gap-2 text-[12px] text-muted-foreground">
            <span className="size-1.5 shrink-0 rounded-full bg-success" />
            <span>Nothing needs attention.</span>
          </div>
        ) : (
          insights.signals.map((signal) => (
            <Link
              key={signal.key}
              href={signal.href}
              className={`-mx-1.5 flex items-start gap-2 rounded-md px-1.5 py-1 text-[12px] text-foreground transition-colors hover:bg-muted/60`}
            >
              <span
                className={`mt-[5px] size-1.5 shrink-0 rounded-full ${
                  signal.severity === "warn" ? "bg-warning" : "bg-muted-foreground/50"
                }`}
              />
              <span className="min-w-0 flex-1 leading-snug">{signal.label}</span>
            </Link>
          ))
        )}
      </InsightCard>

      {/* Campaign brief: cached AI summary. */}
      <InsightCard title="Campaign brief">
        {brief ? (
          <>
            {briefPending ? <p className="text-[11px] text-muted-foreground">Updating brief…</p> : null}
            <p className="text-[12px] leading-relaxed">{brief.whatChanged}</p>
            {brief.explanations.length > 0 ? (
              <div className="flex flex-col gap-1.5">
                <span className={INSIGHT_SUBLABEL}>Why</span>
                {brief.explanations.slice(0, 3).map((row, index) => (
                  <div key={index} className="flex flex-col gap-0.5">
                    <span className="text-[12px] leading-snug">{row.claim}</span>
                    <span className="text-[11px] leading-snug text-muted-foreground">{row.metric}</span>
                  </div>
                ))}
              </div>
            ) : null}
            {brief.recommendedTests.length > 0 ? (
              <div className="flex flex-col gap-1.5">
                <span className={INSIGHT_SUBLABEL}>Try next</span>
                {brief.recommendedTests.map((test, index) => (
                  <div key={index} className="flex flex-col gap-0.5">
                    <span className="text-[12px] leading-snug">{test.action}</span>
                    <span className="text-[11px] leading-snug text-muted-foreground">{test.expectedOutcome}</span>
                  </div>
                ))}
              </div>
            ) : null}
          </>
        ) : briefPending ? (
          <div className="flex flex-col gap-2 py-0.5">
            <div className="h-3 w-full animate-pulse rounded bg-muted" />
            <div className="h-3 w-5/6 animate-pulse rounded bg-muted" />
            <div className="h-3 w-2/3 animate-pulse rounded bg-muted" />
          </div>
        ) : briefError === null ? (
          <div className="flex items-center gap-2 text-[12px] text-muted-foreground">
            <span>No brief yet.</span>
            <button
              type="button"
              onClick={onRetryBrief}
              className={`font-medium text-primary transition-colors hover:opacity-80 rounded`}
            >
              Generate
            </button>
          </div>
        ) : null}
        {briefError ? (
          <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
            <span className="min-w-0 flex-1">{briefError}</span>
            <button
              type="button"
              onClick={onRetryBrief}
              className={`shrink-0 font-medium text-primary transition-colors hover:opacity-80 rounded`}
            >
              Retry
            </button>
          </div>
        ) : null}
        {briefNote ? <p className="text-[11px] text-muted-foreground">{briefNote}</p> : null}
        {brief ? (
          <div className="mt-1 flex items-center justify-between gap-2 border-t border-border pt-2">
            <span className="min-w-0 truncate text-[11px] text-muted-foreground">
              {briefMeta.generatedAt
                ? `Generated ${insightRelativeTime(briefMeta.generatedAt)}${
                    modelLabel(briefMeta.model) ? ` · ${modelLabel(briefMeta.model)}` : ""
                  }`
                : (modelLabel(briefMeta.model) ?? "")}
            </span>
            <button
              type="button"
              disabled={briefPending}
              onClick={onRegenerate}
              className={`${BTN_BASE} h-7 shrink-0 px-2 text-[11px] text-muted-foreground hover:bg-muted/70 hover:text-foreground`}
            >
              <RefreshCw className="size-3.5" />
              {briefPending ? "Regenerating…" : "Regenerate"}
            </button>
          </div>
        ) : null}
      </InsightCard>

      {/* Follow-up radar: the next few replies or scheduled touches waiting on us. */}
      <InsightCard title="Follow-up radar">
        {insights.followUps.length === 0 ? (
          <p className="text-[12px] text-muted-foreground">No follow-ups waiting.</p>
        ) : (
          insights.followUps.slice(0, 3).map((row) => (
            <div key={`${row.kind}:${row.id}`} className="flex min-w-0 flex-col gap-0.5">
              <span className="truncate text-[12px] font-medium" title={row.leadEmail}>
                {row.leadName || row.leadEmail}
              </span>
              <span className="truncate text-[11px] text-muted-foreground">
                {row.kind === "unsent_positive"
                  ? `Positive reply · ${row.receivedAt ? insightRelativeTime(row.receivedAt) : "recently"}`
                  : `Follow-up due ${row.dueAt ? followUpDueLabel(row.dueAt) : "soon"}`}
              </span>
            </div>
          ))
        )}
        {insights.followUpsTotal > 3 ? (
          <Link
            href="/inbox"
            className={`self-start rounded text-[11px] font-medium text-primary transition-colors hover:opacity-80`}
          >
            View all {insights.followUpsTotal}
          </Link>
        ) : null}
        {insights.benchmark.line ? (
          <p className="mt-1 border-t border-border pt-2 text-[11px] leading-relaxed text-muted-foreground">
            {insights.benchmark.line}
          </p>
        ) : null}
      </InsightCard>
    </div>
  );
}

/* ── Campaign creation wizard ──────────────────────────────────────────────
   A focused three-step modal (name · schedule · inboxes) over a dimmed page.
   Day numbers follow Smartlead's 1 = Monday … 7 = Sunday convention. */
const CURATED_TIMEZONES = [
  "America/New_York",
  "America/Chicago",
  "America/Denver",
  "America/Los_Angeles",
  "Europe/London",
  "Europe/Berlin",
  "Asia/Singapore",
  "Australia/Sydney",
];
function timezoneChoices(): string[] {
  const out: string[] = [];
  try {
    const browser = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (browser) out.push(browser);
  } catch {
    // resolvedOptions unavailable — fall through to the curated list.
  }
  for (const zone of CURATED_TIMEZONES) if (!out.includes(zone)) out.push(zone);
  return out;
}
const HOUR_OPTIONS = Array.from({ length: 24 }, (_, hour) => `${String(hour).padStart(2, "0")}:00`);
const DAY_PILLS: { value: number; label: string }[] = [
  { value: 1, label: "Mon" },
  { value: 2, label: "Tue" },
  { value: 3, label: "Wed" },
  { value: 4, label: "Thu" },
  { value: 5, label: "Fri" },
  { value: 6, label: "Sat" },
  { value: 7, label: "Sun" },
];

/* Schedule-editor zone list: the wizard's browser + curated choices, with the
   campaign's saved zone folded in first so an already-set (possibly exotic)
   zone always has a matching option. */
function scheduleZoneChoices(current: string | null): string[] {
  const out = timezoneChoices();
  if (current && !out.includes(current)) out.unshift(current);
  return out;
}
/* Whole-hour options (wizard idiom) with a saved off-grid value folded in so a
   half-hour window is never silently rewritten. */
function hourOptionsWith(current: string): string[] {
  if (HOUR_OPTIONS.includes(current)) return HOUR_OPTIONS;
  return [...HOUR_OPTIONS, current].sort();
}

/* The three "stop sending to a lead when" triggers Smartlead accepts. */
const STOP_LEAD_OPTIONS = [
  { value: "REPLY_TO_AN_EMAIL", label: "Replies to an email" },
  { value: "CLICK_ON_A_LINK", label: "Clicks a link" },
  { value: "OPEN_AN_EMAIL", label: "Opens an email" },
] as const;
type StopLeadSetting = (typeof STOP_LEAD_OPTIONS)[number]["value"];
function normalizeStopLead(raw: string | null): StopLeadSetting {
  const up = (raw ?? "").toUpperCase();
  return STOP_LEAD_OPTIONS.some((option) => option.value === up)
    ? (up as StopLeadSetting)
    : "REPLY_TO_AN_EMAIL";
}

function CampaignWizard({
  onClose,
  onCreated,
  showToast,
}: {
  onClose: () => void;
  onCreated: (id: string, name: string) => void;
  showToast: (ok: boolean, text: string) => void;
}) {
  const [pending, startTransition] = useTransition();
  const { closing, playExit } = useExit();
  const beginClose = () => {
    if (!pending) playExit(onClose);
  };
  const [step, setStep] = useState<1 | 2 | 3>(1);

  const [name, setName] = useState("");
  // Stored as the campaign's AI context (our settings store) — never Smartlead.
  const [description, setDescription] = useState("");
  const [zones] = useState<string[]>(() => timezoneChoices());
  const [timezone, setTimezone] = useState(zones[0] ?? "America/New_York");
  const [days, setDays] = useState<number[]>([1, 2, 3, 4, 5]);
  const [startHour, setStartHour] = useState("09:00");
  const [endHour, setEndHour] = useState("17:00");
  const [maxLeads, setMaxLeads] = useState("20");
  const [minMinutes, setMinMinutes] = useState("30");

  const [inboxes, setInboxes] = useState<CampaignInbox[] | null>(null);
  const [inboxError, setInboxError] = useState<string | null>(null);
  const [inboxLoading, startInboxLoad] = useTransition();
  const [selectedInboxIds, setSelectedInboxIds] = useState<Set<number>>(new Set());

  // Lock the page behind the modal.
  useEffect(() => {
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
    };
  }, []);

  // Escape closes the modal unless a create is in flight.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") beginClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pending]);

  // Zapmail profile pictures keyed by lowercased from_email (workspace-wide).
  const [inboxAvatars, setInboxAvatars] = useState<Record<string, string>>({});
  const [inboxAvatarsVerified, setInboxAvatarsVerified] = useState(false);
  const loadInboxes = () => {
    setInboxError(null);
    startInboxLoad(async () => {
      const result = await listInboxAccountsAction();
      if (result.ok && result.inboxes) {
        setInboxes(result.inboxes as CampaignInbox[]);
        if (result.avatars) setInboxAvatars(result.avatars);
        setInboxAvatarsVerified(result.avatarsVerified ?? false);
      } else {
        setInboxError(result.message);
      }
    });
  };

  const toggleDay = (value: number) =>
    setDays((prev) =>
      prev.includes(value) ? prev.filter((d) => d !== value) : [...prev, value].sort((a, b) => a - b),
    );
  const toggleInbox = (id: number) =>
    setSelectedInboxIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const nameValid = name.trim().length >= 1 && name.trim().length <= 120;
  const leadsValue = maxLeads.trim() ? clampInt(maxLeads, 1, 2000) : 0;
  const minutesValue = minMinutes.trim() ? clampInt(minMinutes, 1, 600) : 0;
  const scheduleValid =
    days.length >= 1 && startHour < endHour && leadsValue >= 1 && minutesValue >= 1;

  const goNext = () => {
    if (step === 1 && nameValid) setStep(2);
    else if (step === 2 && scheduleValid) {
      setStep(3);
      if (inboxes === null && !inboxLoading) loadInboxes();
    }
  };
  const goBack = () => setStep((prev) => (prev > 1 ? ((prev - 1) as 1 | 2 | 3) : prev));

  const create = () => {
    if (!nameValid || !scheduleValid) return;
    startTransition(async () => {
      const result = await createCampaignAction({
        name: name.trim(),
        description: description.trim() || undefined,
        schedule: {
          timezone,
          daysOfTheWeek: [...days].sort((a, b) => a - b),
          startHour,
          endHour,
          minTimeBtwnEmails: clampInt(minMinutes, 1, 600),
          maxNewLeadsPerDay: clampInt(maxLeads, 1, 2000),
        },
        inboxIds: [...selectedInboxIds],
      });
      showToast(result.ok, result.message);
      if (result.ok && result.campaignId) {
        const id = result.campaignId;
        playExit(() => onCreated(id, name.trim()));
      }
    });
  };

  const stepTabs: { n: 1 | 2 | 3; label: string }[] = [
    { n: 1, label: "Name" },
    { n: 2, label: "Schedule" },
    { n: 3, label: "Inboxes" },
  ];

  return (
    <div
      className={`fixed inset-0 z-50 flex cursor-pointer items-center justify-center bg-background/70 p-4 backdrop-blur-sm ${closing ? "anim-overlay-out" : "anim-overlay-in"}`}
      onClick={(event) => {
        if (event.target === event.currentTarget) beginClose();
      }}
    >
      <div className={`flex max-h-[90vh] w-full max-w-lg cursor-auto flex-col overflow-hidden rounded-xl border border-border bg-surface shadow-pop ${closing ? "anim-panel-out" : "anim-panel-in"}`}>
        {/* Header + progress */}
        <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-3">
          <div className="flex flex-col gap-0.5">
            <h2 className="text-[13.5px] font-semibold tracking-tight">New campaign</h2>
            <div className="flex items-center gap-1 text-[11px] text-muted-foreground">
              {stepTabs.map((tab, i) => (
                <Fragment key={tab.n}>
                  {i > 0 ? <span className="text-muted-foreground/50">·</span> : null}
                  <span
                    className={
                      tab.n === step
                        ? "font-semibold text-foreground"
                        : tab.n < step
                          ? "text-foreground/70"
                          : ""
                    }
                  >
                    {tab.n} {tab.label}
                  </span>
                </Fragment>
              ))}
            </div>
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

        {/* Body */}
        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
          {step === 1 ? (
            <div className="flex flex-col gap-4">
              <div className="flex flex-col gap-1.5">
                <label htmlFor="wizard-name" className="text-[11px] font-medium">
                  Campaign name
                </label>
                <input
                  id="wizard-name"
                  autoFocus
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && nameValid) goNext();
                  }}
                  maxLength={120}
                  placeholder="e.g. Q3 outbound (founders)"
                  className={INPUT_CLASS}
                />
                <p className="text-[11px] text-muted-foreground">
                  1–120 characters. You can rename it later in Smartlead.
                </p>
              </div>
              <div className="flex flex-col gap-1.5">
                <label htmlFor="wizard-description" className="text-[11px] font-medium">
                  Description
                </label>
                <textarea
                  id="wizard-description"
                  value={description}
                  onChange={(event) => setDescription(event.target.value)}
                  rows={3}
                  maxLength={2000}
                  placeholder="Optional"
                  className={TEXTAREA_MULTI}
                />
                <p className="text-[11px] text-muted-foreground">
                  What this campaign is about and who it targets. Our AI uses it to read replies
                  and write the campaign brief. Not sent to Smartlead.
                </p>
              </div>
            </div>
          ) : null}

          {step === 2 ? (
            <div className="flex flex-col gap-4">
              <div className="flex flex-col gap-1.5">
                <label htmlFor="wizard-tz" className="text-[11px] font-medium">
                  Time zone
                </label>
                <div className="relative">
                  <select
                    id="wizard-tz"
                    value={timezone}
                    onChange={(event) => setTimezone(event.target.value)}
                    className={`${INPUT_CLASS} appearance-none pr-7`}
                  >
                    {zones.map((zone) => (
                      <option key={zone} value={zone}>
                        {zone.replace(/_/g, " ")}
                      </option>
                    ))}
                  </select>
                  <ChevronDown className="pointer-events-none absolute right-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
                </div>
              </div>

              <div className="flex flex-col gap-1.5">
                <span className="text-[11px] font-medium">Sending days</span>
                <div className="flex flex-wrap gap-1.5">
                  {DAY_PILLS.map((day) => {
                    const on = days.includes(day.value);
                    return (
                      <button
                        key={day.value}
                        type="button"
                        aria-pressed={on}
                        onClick={() => toggleDay(day.value)}
                        className={`rounded-full border px-2.5 py-0.5 text-[11px] font-medium transition ${
                          on
                            ? "border-transparent bg-accent text-accent-foreground"
                            : "border-border bg-surface text-muted-foreground hover:text-foreground"
                        }`}
                      >
                        {day.label}
                      </button>
                    );
                  })}
                </div>
                {days.length === 0 ? (
                  <p className="text-[11px] text-destructive">Pick at least one sending day.</p>
                ) : null}
              </div>

              <div className="flex flex-wrap items-end gap-3">
                <div className="flex flex-col gap-1.5">
                  <label htmlFor="wizard-start" className="text-[11px] font-medium">
                    Start hour
                  </label>
                  <div className="relative w-28">
                    <select
                      id="wizard-start"
                      value={startHour}
                      onChange={(event) => setStartHour(event.target.value)}
                      className={`${INPUT_CLASS} appearance-none pr-7`}
                    >
                      {HOUR_OPTIONS.map((hour) => (
                        <option key={hour} value={hour}>
                          {hour}
                        </option>
                      ))}
                    </select>
                    <ChevronDown className="pointer-events-none absolute right-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
                  </div>
                </div>
                <div className="flex flex-col gap-1.5">
                  <label htmlFor="wizard-end" className="text-[11px] font-medium">
                    End hour
                  </label>
                  <div className="relative w-28">
                    <select
                      id="wizard-end"
                      value={endHour}
                      onChange={(event) => setEndHour(event.target.value)}
                      className={`${INPUT_CLASS} appearance-none pr-7`}
                    >
                      {HOUR_OPTIONS.map((hour) => (
                        <option key={hour} value={hour}>
                          {hour}
                        </option>
                      ))}
                    </select>
                    <ChevronDown className="pointer-events-none absolute right-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
                  </div>
                </div>
              </div>
              {startHour >= endHour ? (
                <p className="-mt-2 text-[11px] text-destructive">End hour must be after the start hour.</p>
              ) : null}

              <div className="flex flex-wrap items-end gap-3">
                <div className="flex flex-col gap-1.5">
                  <label htmlFor="wizard-leads" className="text-[11px] font-medium">
                    Max new leads / day
                  </label>
                  <input
                    id="wizard-leads"
                    type="number"
                    min={1}
                    max={2000}
                    value={maxLeads}
                    onChange={(event) => setMaxLeads(event.target.value)}
                    className={`${INPUT_CLASS} w-32`}
                  />
                </div>
                <div className="flex flex-col gap-1.5">
                  <label htmlFor="wizard-mins" className="text-[11px] font-medium">
                    Minutes between emails
                  </label>
                  <input
                    id="wizard-mins"
                    type="number"
                    min={1}
                    max={600}
                    value={minMinutes}
                    onChange={(event) => setMinMinutes(event.target.value)}
                    className={`${INPUT_CLASS} w-32`}
                  />
                </div>
              </div>
            </div>
          ) : null}

          {step === 3 ? (
            <div className="flex flex-col gap-3">
              <p className="text-[11px] text-muted-foreground">
                Choose the sending accounts for this campaign. You can also add inboxes later.
              </p>
              {inboxLoading && inboxes === null ? (
                <div className="flex items-center gap-2 text-[12px] text-muted-foreground">
                  <Loader2 className="size-4 animate-spin" />
                  Loading inboxes…
                </div>
              ) : inboxes === null ? (
                <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed border-border px-4 py-8 text-center">
                  <p className="max-w-xs text-[12px] leading-relaxed text-muted-foreground">
                    {inboxError ?? "Couldn't load inboxes."}
                  </p>
                  <button
                    type="button"
                    onClick={loadInboxes}
                    disabled={inboxLoading}
                    className={`${BTN_OUTLINE} h-8 px-3 text-[12px]`}
                  >
                    Retry
                  </button>
                </div>
              ) : inboxes.length === 0 ? (
                <div className="rounded-xl border border-dashed border-border px-4 py-8 text-center text-[12px] text-muted-foreground">
                  No inboxes connected yet. You can add them later.
                </div>
              ) : (
                <div className="flex max-h-72 flex-col divide-y divide-border overflow-y-auto rounded-xl border border-border">
                  {inboxes.map((inbox) => {
                    const checked = selectedInboxIds.has(inbox.id);
                    return (
                      <label
                        key={inbox.id}
                        className="flex cursor-pointer items-center gap-3 px-3 py-2.5 transition-colors hover:bg-muted/50"
                      >
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() => toggleInbox(inbox.id)}
                          className={`size-3.5 accent-[var(--primary)]`}
                        />
                        <SenderAvatar src={inboxAvatars[inbox.fromEmail.toLowerCase()] ?? null} verified={inboxAvatarsVerified} />
                        <div className="flex min-w-0 flex-1 flex-col gap-1">
                          <div className="flex items-center gap-2">
                            <span className="min-w-0 truncate text-[12.5px] font-medium">{inbox.fromEmail}</span>
                            {inbox.isSuspended ? (
                              <span className="shrink-0 rounded bg-destructive-soft px-1.5 py-px text-[10px] font-medium text-destructive">
                                Suspended
                              </span>
                            ) : null}
                          </div>
                          <span className="inline-flex items-center gap-1.5">
                            <InboxConnDot label="SMTP" ok={inbox.smtpOk} error={inbox.smtpError} />
                            <InboxConnDot label="IMAP" ok={inbox.imapOk} error={inbox.imapError} />
                          </span>
                        </div>
                        <ReputationBadge value={inbox.warmup?.reputation ?? null} />
                      </label>
                    );
                  })}
                </div>
              )}
              {inboxes && inboxes.length > 0 ? (
                <p className="text-[11px] text-muted-foreground">{selectedInboxIds.size} selected</p>
              ) : null}
            </div>
          ) : null}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between gap-2 border-t border-border px-4 py-3">
          <button
            type="button"
            disabled={pending}
            onClick={step === 1 ? beginClose : goBack}
            className={`${BTN_OUTLINE} h-8 px-3 text-[12px]`}
          >
            {step === 1 ? "Cancel" : "Back"}
          </button>
          {step < 3 ? (
            <button
              type="button"
              disabled={step === 1 ? !nameValid : !scheduleValid}
              onClick={goNext}
              className={`${BTN_PRIMARY} h-8 px-3 text-[12px]`}
            >
              Continue
            </button>
          ) : (
            <button
              type="button"
              disabled={pending || !nameValid || !scheduleValid}
              onClick={create}
              className={`${BTN_PRIMARY} h-8 px-3 text-[12px]`}
            >
              <Check className="size-3.5" />
              {pending ? "Creating…" : "Create campaign"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

/* ── Compact list-column select (leads-toolbar FilterSelect grammar, scaled
   down to fit the ~280px campaign column). ────────────────────────────────── */
function ListSelect({
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
    <div className="relative min-w-0 flex-1">
      <select
        value={value}
        onChange={onChange}
        aria-label={ariaLabel}
        className={`h-7 w-full appearance-none rounded-md border border-border bg-surface pl-2 pr-6 text-[11.5px] font-medium text-foreground shadow-xs transition focus:border-ring`}
      >
        {children}
      </select>
      <ChevronDown className="pointer-events-none absolute right-1.5 top-1/2 size-3 -translate-y-1/2 text-muted-foreground" />
    </div>
  );
}

/* ── Root: master-detail ──────────────────────────────────────────────── */
export function CampaignsClient({
  campaigns,
  categories,
  aiSettings,
  smartleadError,
  initialSelectedId = null,
}: {
  campaigns: CampaignSummary[];
  categories: ReplyCategory[];
  aiSettings: AiSettings;
  smartleadError: string | null;
  /** Deep link (?c=id): open this campaign on first render. */
  initialSelectedId?: string | null;
}) {
  const router = useRouter();
  const [summaries, setSummaries] = useState<CampaignSummary[]>(campaigns);
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => setSummaries(campaigns), [campaigns]);

  // List-column filtering + sorting: all local, derived in render, persisted
  // nowhere. "Newest" is the default only when the data carries createdAt;
  // otherwise the list has no meaningful recency and we fall back to name.
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [sortKey, setSortKey] = useState<"newest" | "name" | "status">(() =>
    campaigns.some((c) => c.createdAt) ? "newest" : "name",
  );

  const [wizardOpen, setWizardOpen] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [cache, setCache] = useState<
    Record<string, { detail: CampaignDetail; overrides: CampaignOverrides }>
  >({});
  const [loadingId, setLoadingId] = useState<string | null>(null);

  const [pending, startTransition] = useTransition();
  const [busyId, setBusyId] = useState<string | null>(null);

  const showToast = useToast();

  const run = (id: string | null, action: () => Promise<ActionResult>) => {
    setBusyId(id);
    startTransition(async () => {
      const result = await action();
      showToast(result.ok, result.message);
      // Only clear our own marker: a later run() may have claimed busyId, and
      // un-busying it early would re-arm its controls mid-flight.
      setBusyId((current) => (current === id ? null : current));
    });
  };

  const select = (id: string) => {
    setSelectedId(id);
    if (cache[id] || loadingId === id) return;
    setLoadingId(id);
    startTransition(async () => {
      const result = await getCampaignDetailAction(id);
      if (result.ok && result.detail) {
        const detail = result.detail;
        const overrides = result.overrides ?? {};
        setCache((prev) => ({ ...prev, [id]: { detail, overrides } }));
      } else {
        showToast(false, result.message);
      }
      setLoadingId((cur) => (cur === id ? null : cur));
    });
  };

  // Deep link (?c=id): select once on mount; after that the list owns selection.
  const deepLinked = useRef(false);
  useEffect(() => {
    if (deepLinked.current || !initialSelectedId) return;
    deepLinked.current = true;
    select(initialSelectedId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialSelectedId]);

  const onStatusChanged = (id: string, status: string) => {
    setCache((prev) =>
      prev[id] ? { ...prev, [id]: { ...prev[id], detail: { ...prev[id].detail, status } } } : prev,
    );
    setSummaries((prev) => prev.map((c) => (c.id === id ? { ...c, status } : c)));
  };
  const onLimitsSaved = (
    id: string,
    limits: {
      maxLeadsPerDay?: number | null;
      minTimeBtwnEmails?: number | null;
      followUpPercentage?: number | null;
    },
  ) => {
    // Only fields that were actually saved update the cache — an untouched
    // (or cleared) sibling must not overwrite the server value.
    const patch: Partial<CampaignDetail> = {};
    if (limits.maxLeadsPerDay !== undefined) patch.maxLeadsPerDay = limits.maxLeadsPerDay;
    if (limits.minTimeBtwnEmails !== undefined) patch.minTimeBtwnEmails = limits.minTimeBtwnEmails;
    if (limits.followUpPercentage !== undefined) patch.followUpPercentage = limits.followUpPercentage;
    setCache((prev) =>
      prev[id]
        ? { ...prev, [id]: { ...prev[id], detail: { ...prev[id].detail, ...patch } } }
        : prev,
    );
  };
  const onOverridesSaved = (id: string, overrides: CampaignOverrides) => {
    setCache((prev) => (prev[id] ? { ...prev, [id]: { ...prev[id], overrides } } : prev));
  };
  // General settings save patches only the changed detail fields; a name change
  // also updates the header title (via the cached detail) and the list row.
  const onGeneralSaved = (id: string, patch: Partial<CampaignDetail>) => {
    setCache((prev) =>
      prev[id]
        ? { ...prev, [id]: { ...prev[id], detail: { ...prev[id].detail, ...patch } } }
        : prev,
    );
    if (patch.name !== undefined) {
      const name = patch.name;
      setSummaries((prev) => prev.map((c) => (c.id === id ? { ...c, name } : c)));
    }
  };
  const onScheduleSaved = (id: string, schedule: CampaignSchedule) => {
    setCache((prev) =>
      prev[id]
        ? { ...prev, [id]: { ...prev[id], detail: { ...prev[id].detail, schedule } } }
        : prev,
    );
  };

  // New campaign lands as a draft: optimistically insert it, refresh the
  // server list (same revalidation the actions trigger), and select it.
  const onCreated = (id: string, name: string) => {
    setSummaries((prev) =>
      prev.some((c) => c.id === id)
        ? prev
        : [{ id, name, status: "DRAFTED", createdAt: new Date().toISOString() }, ...prev],
    );
    setWizardOpen(false);
    router.refresh();
    select(id);
  };

  // Deleted draft: drop it from the list + cache, clear selection if current.
  const onDeleted = (id: string) => {
    setSummaries((prev) => prev.filter((c) => c.id !== id));
    setCache((prev) => {
      if (!prev[id]) return prev;
      const next = { ...prev };
      delete next[id];
      return next;
    });
    setSelectedId((cur) => (cur === id ? null : cur));
    router.refresh();
  };

  // Per-campaign sequence cache (lazy-loaded on first visit to the Sequence
  // section) — mirrors the detail cache so switching campaigns doesn't refetch.
  const [seqCache, setSeqCache] = useState<Record<string, SequenceStep[]>>({});
  // null evicts the entry (e.g. saved but could not re-fetch server ids —
  // the next visit must reload from Smartlead rather than trust local state).
  const onSequenceLoaded = (id: string, steps: SequenceStep[] | null) =>
    setSeqCache((prev) => {
      if (steps) return { ...prev, [id]: steps };
      const rest = { ...prev };
      delete rest[id];
      return rest;
    });

  // Per-campaign preview-lead cache — fetched once, on first preview open.
  const [previewLeadCache, setPreviewLeadCache] = useState<Record<string, PreviewLeadData>>({});
  const onPreviewLeadLoaded = (id: string, data: PreviewLeadData) =>
    setPreviewLeadCache((prev) => ({ ...prev, [id]: data }));

  // Per-campaign sending-inbox cache — fetched once, on first visit to the
  // Inboxes section (mirrors the preview-lead cache so switching campaigns and
  // back doesn't refetch).
  const [inboxCache, setInboxCache] = useState<Record<string, CampaignInbox[]>>({});
  const onInboxesLoaded = (id: string, inboxes: CampaignInbox[]) =>
    setInboxCache((prev) => ({ ...prev, [id]: inboxes }));

  // Per-campaign leads cache — total + per-page rows, so first visits, page
  // flips, and revisits after switching campaigns never refetch a page already
  // seen (mirrors the sequence/inbox caches).
  const [leadsCache, setLeadsCache] = useState<
    Record<string, { total: number; pages: Record<number, CampaignLeadRow[]>; all?: CampaignLeadRow[] }>
  >({});
  const onLeadsLoaded = (id: string, total: number, page: number, rows: CampaignLeadRow[]) =>
    setLeadsCache((prev) => {
      const existing = prev[id] ?? { total, pages: {} };
      return { ...prev, [id]: { ...existing, total, pages: { ...existing.pages, [page]: rows } } };
    });
  // The load-all result (and edits to it) land in the same per-campaign cache
  // entry under `all`, so a revisit after switching campaigns is instant.
  const onAllLeadsLoaded = (id: string, total: number, all: CampaignLeadRow[]) =>
    setLeadsCache((prev) => {
      const existing = prev[id] ?? { total, pages: {} };
      return { ...prev, [id]: { ...existing, total, all } };
    });
  // Drop a campaign's leads cache entry entirely (used after adding leads, so
  // the next load rebuilds pages and the load-all set from Smartlead).
  const onLeadsInvalidated = (id: string) =>
    setLeadsCache((prev) => {
      if (!(id in prev)) return prev;
      const rest = { ...prev };
      delete rest[id];
      return rest;
    });

  const selectedEntry = selectedId ? cache[selectedId] : null;
  const selectedSummary = selectedId ? summaries.find((c) => c.id === selectedId) ?? null : null;

  // Which campaigns are known (from already-loaded detail) to carry overrides.
  // Purely client-side off the existing cache — no extra server calls.
  const overriddenIds = new Set<string>();
  for (const [id, entry] of Object.entries(cache)) {
    if (hasOverrides(entry.overrides)) overriddenIds.add(id);
  }

  // Distinct statuses actually present, ordered the same way the Status sort
  // groups them, for the filter dropdown. Feeds the "All statuses" + N options.
  const hasCreatedAt = summaries.some((c) => c.createdAt);
  const statusOptions = Array.from(
    new Set(summaries.map((c) => (c.status ?? "").toUpperCase()).filter(Boolean)),
  ).sort((a, b) => statusRank(a) - statusRank(b) || a.localeCompare(b));

  // Derived visible list: filter by name (case-insensitive) and status, then
  // sort. Selection is untouched: a campaign filtered out of view stays
  // selected (its detail keeps rendering on the right).
  const q = search.trim().toLowerCase();
  const filtered = summaries.filter((c) => {
    if (q && !c.name.toLowerCase().includes(q)) return false;
    if (statusFilter !== "all" && (c.status ?? "").toUpperCase() !== statusFilter) return false;
    return true;
  });
  const byName = (a: CampaignSummary, b: CampaignSummary) =>
    a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
  const visible = [...filtered].sort((a, b) => {
    if (sortKey === "name") return byName(a, b);
    if (sortKey === "status") return statusRank(a.status) - statusRank(b.status) || byName(a, b);
    // newest: createdAt desc, nulls last, ties by name
    const at = a.createdAt ?? "";
    const bt = b.createdAt ?? "";
    if (at === bt) return byName(a, b);
    if (!at) return 1;
    if (!bt) return -1;
    return at < bt ? 1 : -1;
  });
  const clearFilters = () => {
    setSearch("");
    setStatusFilter("all");
  };

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <header className="flex h-14 shrink-0 items-center gap-2 border-b border-border bg-surface px-5">
        <Megaphone className="size-4 text-muted-foreground" strokeWidth={1.75} />
        <h1 className="text-[15px] font-semibold tracking-tight">Campaigns</h1>
      </header>

      <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
        {/* Left: campaign list */}
        <aside className="flex shrink-0 flex-col border-b border-border lg:w-72 lg:border-b-0 lg:border-r">
          <div className="flex flex-col gap-2 border-b border-border px-4 py-2.5">
            <div className="flex items-center justify-between gap-2">
              <span className="flex min-w-0 items-baseline gap-1.5">
                <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                  All campaigns
                </span>
                {visible.length < summaries.length ? (
                  <span className="shrink-0 text-[10.5px] font-normal tabular-nums text-muted-foreground">
                    {visible.length} of {summaries.length}
                  </span>
                ) : null}
              </span>
              <button
                type="button"
                onClick={() => setWizardOpen(true)}
                className={`${BTN_PRIMARY} h-7 px-2.5 text-[11.5px]`}
              >
                <Plus className="size-3.5" />
                New campaign
              </button>
            </div>
            {summaries.length > 0 ? (
              <>
                <div className="relative">
                  <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
                  <input
                    value={search}
                    onChange={(event) => setSearch(event.target.value)}
                    placeholder="Search campaigns"
                    aria-label="Search campaigns"
                    className={`${INPUT_CLASS} h-7 pl-7 text-[12px]`}
                  />
                </div>
                <div className="flex items-center gap-1.5">
                  <ListSelect
                    value={statusFilter}
                    ariaLabel="Filter by status"
                    onChange={(event) => setStatusFilter(event.target.value)}
                  >
                    <option value="all">All statuses</option>
                    {statusOptions.map((status) => (
                      <option key={status} value={status}>
                        {titleCaseStatus(status)}
                      </option>
                    ))}
                  </ListSelect>
                  <ListSelect
                    value={sortKey}
                    ariaLabel="Sort campaigns"
                    onChange={(event) =>
                      setSortKey(event.target.value as "newest" | "name" | "status")
                    }
                  >
                    {hasCreatedAt ? <option value="newest">Newest</option> : null}
                    <option value="name">Name A to Z</option>
                    <option value="status">Status</option>
                  </ListSelect>
                </div>
              </>
            ) : null}
          </div>
          <div className="max-h-64 overflow-y-auto lg:max-h-none lg:flex-1">
            {summaries.length === 0 ? (
              <div className="p-4">
                <div className="flex flex-col gap-2 rounded-lg border border-dashed border-border px-3 py-6 text-center">
                  <p className="text-[12px] text-muted-foreground">
                    {smartleadError
                      ? "Couldn't load campaigns from Smartlead."
                      : "No campaigns found."}
                  </p>
                  <p className="text-[11px] leading-relaxed text-muted-foreground">
                    Connect your Smartlead API key in{" "}
                    <span className="font-medium text-foreground">Settings → Integrations</span> to see
                    your campaigns here.
                  </p>
                </div>
              </div>
            ) : visible.length === 0 ? (
              <div className="flex flex-col items-start gap-1.5 px-4 py-6">
                <p className="text-[12px] text-muted-foreground">No campaigns match.</p>
                <button
                  type="button"
                  onClick={clearFilters}
                  className={`rounded text-[11.5px] font-medium text-primary transition-colors hover:underline`}
                >
                  Clear
                </button>
              </div>
            ) : (
              <div className="flex flex-col p-2">
                {visible.map((campaign) => {
                  const active = campaign.id === selectedId;
                  return (
                    <button
                      key={campaign.id}
                      type="button"
                      onClick={() => select(campaign.id)}
                      className={`flex items-center gap-2.5 rounded-md px-2.5 py-2 text-left transition-colors ${
                        active ? "bg-accent text-accent-foreground" : "hover:bg-muted/60"
                      }`}
                    >
                      <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium">
                        {campaign.name}
                      </span>
                      {overriddenIds.has(campaign.id) ? (
                        <CustomizedDot title="Has overrides" />
                      ) : null}
                      <span
                        className={`shrink-0 rounded px-1.5 py-px text-[9.5px] font-semibold uppercase tracking-wide ${statusTone(
                          campaign.status,
                        )}`}
                      >
                        {statusLabel(campaign.status)}
                      </span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        </aside>

        {/* Right: detail */}
        <div className="min-w-0 flex-1 overflow-y-auto">
          {!selectedId ? (
            <div className="flex h-full items-center justify-center p-8">
              <div className="max-w-sm text-center">
                <span className="mx-auto flex size-10 items-center justify-center rounded-full bg-muted/60">
                  <Megaphone className="size-5 text-muted-foreground" strokeWidth={1.5} />
                </span>
                <p className="mt-3 text-[13px] font-medium">Select a campaign</p>
                <p className="mt-1 text-[12px] leading-relaxed text-muted-foreground">
                  Pick a campaign on the left to review its status, sending limits, and reply-handling
                  overrides.
                </p>
              </div>
            </div>
          ) : loadingId === selectedId && !selectedEntry ? (
            <DetailSkeleton />
          ) : selectedEntry ? (
            <DetailPanel
              key={selectedId}
              detail={selectedEntry.detail}
              baselineOverrides={selectedEntry.overrides}
              summaryStatus={selectedSummary?.status ?? selectedEntry.detail.status}
              categories={categories}
              aiSettings={aiSettings}
              run={run}
              pending={pending}
              busyId={busyId}
              showToast={showToast}
              onStatusChanged={onStatusChanged}
              onLimitsSaved={onLimitsSaved}
              onGeneralSaved={onGeneralSaved}
              onScheduleSaved={onScheduleSaved}
              onOverridesSaved={onOverridesSaved}
              onDeleted={onDeleted}
              cachedSequence={seqCache[selectedEntry.detail.id]}
              onSequenceLoaded={onSequenceLoaded}
              cachedPreviewLead={previewLeadCache[selectedEntry.detail.id]}
              onPreviewLeadLoaded={onPreviewLeadLoaded}
              cachedInboxes={inboxCache[selectedEntry.detail.id]}
              onInboxesLoaded={onInboxesLoaded}
              cachedLeads={leadsCache[selectedEntry.detail.id]}
              onLeadsLoaded={onLeadsLoaded}
              onAllLeadsLoaded={onAllLeadsLoaded}
              onLeadsInvalidated={onLeadsInvalidated}
            />
          ) : (
            <div className="flex h-full items-center justify-center p-8 text-[12.5px] text-muted-foreground">
              Couldn&rsquo;t load this campaign.
            </div>
          )}
        </div>
      </div>

      {wizardOpen ? (
        <CampaignWizard onClose={() => setWizardOpen(false)} onCreated={onCreated} showToast={showToast} />
      ) : null}
    </div>
  );
}

function DetailSkeleton() {
  return (
    <div className="mx-auto flex w-full max-w-[900px] flex-col gap-4 px-5 py-6">
      <div className="flex items-center gap-2 text-[12px] text-muted-foreground">
        <Loader2 className="size-4 animate-spin" />
        Loading campaign…
      </div>
      {[0, 1, 2].map((i) => (
        <div key={i} className="overflow-hidden rounded-xl bg-surface">
          <div className="flex flex-col gap-2 px-4 py-3.5">
            <div className="h-3.5 w-40 animate-pulse rounded bg-muted" />
            <div className="h-2.5 w-64 animate-pulse rounded bg-muted/70" />
          </div>
          <div className="divide-y divide-border border-t border-border">
            {[0, 1].map((j) => (
              <div key={j} className="flex items-center gap-4 px-4 py-4">
                <div className="h-3 w-48 animate-pulse rounded bg-muted" />
                <div className="ml-auto h-7 w-28 animate-pulse rounded bg-muted/70" />
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

/* ── Detail panel ─────────────────────────────────────────────────────── */
const OVERRIDE_SCALAR_KEYS = [
  "campaignContext",
  "draftingEnabled",
  "senderName",
  "senderTitle",
  "senderCompany",
  "draftContext",
  "extraVoiceRules",
  "signature",
  "autoHandleOoo",
  "autoHandleDeadMailbox",
  "resumeBusinessDaysAfterReturn",
  "resumeDefaultWaitDays",
  "colleagueResearchEnabled",
  "colleagueRolesHint",
] as const;

function cleanCategories(
  record: Record<string, CategoryOverride> | null | undefined,
): Record<string, CategoryOverride> {
  const out: Record<string, CategoryOverride> = {};
  for (const [key, value] of Object.entries(record ?? {})) {
    const entry: CategoryOverride = {};
    if (value.suppress === true || value.suppress === false) entry.suppress = value.suppress;
    if (value.dnc === true || value.dnc === false) entry.dnc = value.dnc;
    if (value.draftReply === true || value.draftReply === false) entry.draftReply = value.draftReply;
    if (typeof value.draftGuidance === "string" && value.draftGuidance.trim())
      entry.draftGuidance = value.draftGuidance;
    if (Object.keys(entry).length > 0) out[key] = entry;
  }
  return out;
}

/* Whether an overrides record customizes anything — same field semantics the
   save path uses, so a campaign's "customized" indicator matches what's saved. */
function hasOverrides(overrides: CampaignOverrides): boolean {
  for (const key of OVERRIDE_SCALAR_KEYS) {
    const v = overrides[key];
    if (v !== undefined && v !== null) return true;
  }
  if (
    overrides.styleExamples !== undefined &&
    overrides.styleExamples !== null &&
    overrides.styleExamples.length > 0
  )
    return true;
  if (Object.keys(cleanCategories(overrides.categories)).length > 0) return true;
  return false;
}

function textPreview(value: string): string {
  const trimmed = value.trim();
  return trimmed ? trimmed : "—";
}

/* ── Add-leads paste model ─────────────────────────────────────────────────
   The paste box accepts CSV or TSV — first row headers, following rows leads.
   Each header is mapped to a lead field, a custom variable, or ignored. The
   caps below mirror the addCampaignLeadsAction schema so the client trims to
   fit rather than letting the server reject a whole batch. */
const LEAD_MAX_ADD = 1000;
const LEAD_EMAIL_MAX = 320;
const LEAD_TEXT_MAX = 200;
const LEAD_URL_MAX = 500;
const LEAD_VAR_MAX = 20;
const LEAD_VAR_KEY_MAX = 80;
const LEAD_VAR_VALUE_MAX = 1000;

/* An email is never truncated to fit (a sliced address is a different,
   possibly deliverable address); rows failing this are counted out instead. */
const LEAD_EMAIL_RE = /^[A-Za-z0-9_'+.-]+@(?:[A-Za-z0-9-]+\.)+[A-Za-z0-9-]{2,}$/;
function isSubmittableEmail(value: string): boolean {
  return value.length > 0 && value.length <= LEAD_EMAIL_MAX && LEAD_EMAIL_RE.test(value);
}

type LeadMapTarget =
  | "email"
  | "firstName"
  | "lastName"
  | "company"
  | "website"
  | "location"
  | "phone"
  | "linkedinUrl"
  | "companyUrl"
  | "variable"
  | "ignore";

const LEAD_MAP_OPTIONS: { value: LeadMapTarget; label: string }[] = [
  { value: "email", label: "Email" },
  { value: "firstName", label: "First name" },
  { value: "lastName", label: "Last name" },
  { value: "company", label: "Company" },
  { value: "website", label: "Website" },
  { value: "location", label: "Location" },
  { value: "phone", label: "Phone" },
  { value: "linkedinUrl", label: "LinkedIn URL" },
  { value: "companyUrl", label: "Company URL" },
  { value: "variable", label: "Variable" },
  { value: "ignore", label: "Ignore" },
];

/* Longest string a given named target accepts (urls run longer). */
function leadTargetMax(target: LeadMapTarget): number {
  if (target === "website" || target === "linkedinUrl" || target === "companyUrl") return LEAD_URL_MAX;
  return LEAD_TEXT_MAX;
}

/* Best-guess mapping from a header name. Anything unrecognized becomes a
   custom variable (its header is the variable key). */
function guessLeadMapTarget(header: string): LeadMapTarget {
  const h = header.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (!h) return "ignore";
  if (h.includes("linkedin")) return "linkedinUrl";
  if (h === "companyurl" || h === "companywebsite" || h === "companysite" || h === "companydomain")
    return "companyUrl";
  if (h === "email" || h === "emailaddress" || h === "workemail" || h === "primaryemail" || h.endsWith("email"))
    return "email";
  if (h === "firstname" || h === "first" || h === "fname" || h === "givenname") return "firstName";
  if (h === "lastname" || h === "last" || h === "lname" || h === "surname" || h === "familyname")
    return "lastName";
  if (
    h === "company" ||
    h === "companyname" ||
    h === "organization" ||
    h === "organisation" ||
    h === "org" ||
    h === "account"
  )
    return "company";
  if (h === "website" || h === "url" || h === "site" || h === "domain" || h === "websiteurl" || h === "web")
    return "website";
  if (
    h === "location" ||
    h === "city" ||
    h === "country" ||
    h === "region" ||
    h === "state" ||
    h === "address" ||
    h === "geo"
  )
    return "location";
  if (h === "phone" || h === "phonenumber" || h === "mobile" || h === "tel" || h === "telephone" || h === "cell")
    return "phone";
  return "variable";
}

/* CSV vs TSV: whichever delimiter the header line carries more of. */
function detectDelimiter(text: string): "," | "\t" {
  const firstLine = text.split(/\r?\n/, 1)[0] ?? "";
  const tabs = (firstLine.match(/\t/g) ?? []).length;
  const commas = (firstLine.match(/,/g) ?? []).length;
  return tabs > commas ? "\t" : ",";
}

/* A small local delimited-text parser: handles double-quoted fields (with the
   delimiter or newlines inside them) and "" escapes. Rows that are entirely
   empty are dropped. */
function parseDelimited(text: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let field = "";
  let row: string[] = [];
  let inQuotes = false;
  let sawField = false;
  const endField = () => {
    row.push(field);
    field = "";
    sawField = true;
  };
  const endRow = () => {
    endField();
    if (row.some((value) => value.trim() !== "")) rows.push(row);
    row = [];
    sawField = false;
  };
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (inQuotes) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
      }
    } else if (char === '"') {
      inQuotes = true;
    } else if (char === delimiter) {
      endField();
    } else if (char === "\n") {
      endRow();
    } else if (char !== "\r") {
      field += char;
    }
  }
  if (field !== "" || sawField || row.length > 0) endRow();
  return rows;
}

/* Normalize Smartlead's sentiment label onto the dot palette's three tones. */
function normalizeSentiment(raw: string): ReplySentimentType {
  const s = raw.toLowerCase();
  if (s.includes("posit")) return "positive";
  if (s.includes("negativ")) return "negative";
  return "neutral";
}

/* ── Add-leads modal ───────────────────────────────────────────────────────
   Paste CSV/TSV, map each header, preview the parse, submit one capped batch.
   Parsing and the effective mapping are derived from the raw text and a small
   override map (no reset effects — a new paste re-derives its own guesses).
   On success the action's summary shows with a Done button; the parent has
   already invalidated and refreshed the leads caches by then. */
function AddLeadsModal({
  onSubmit,
  onClose,
}: {
  onSubmit: (leads: AddLeadInput[]) => Promise<ActionResult>;
  onClose: () => void;
}) {
  const [raw, setRaw] = useState("");
  const [overrides, setOverrides] = useState<Record<string, LeadMapTarget>>({});
  const [submitting, startSubmit] = useTransition();
  const [result, setResult] = useState<ActionResult | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const { closing, playExit } = useExit();
  const beginClose = () => {
    if (!submitting) playExit(onClose);
  };

  // Lock the page behind the modal (LeadEditorModal idiom).
  useEffect(() => {
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
    };
  }, []);

  // Escape closes when idle (never mid-submit, never over the done screen so
  // the summary is not dismissed by a stray keypress).
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !result?.ok) beginClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  // Everything below is derived from the raw text — no parse button, no effect.
  const delimiter = detectDelimiter(raw);
  const grid = raw.trim() ? parseDelimited(raw, delimiter) : [];
  const headers = grid.length > 0 ? grid[0].map((header) => header.trim()) : [];
  const dataRows = grid.slice(1);
  const effectiveTarget = (header: string, index: number): LeadMapTarget =>
    overrides[`${index}:${header}`] ?? guessLeadMapTarget(header);

  const emailColumns = headers
    .map((header, index) => (effectiveTarget(header, index) === "email" ? index : -1))
    .filter((index) => index >= 0);
  const emailIndex = emailColumns.length === 1 ? emailColumns[0] : -1;

  const parsedCount = dataRows.length;
  const missingEmail =
    emailIndex < 0
      ? parsedCount
      : dataRows.filter((cells) => !isSubmittableEmail((cells[emailIndex] ?? "").trim())).length;

  const setMapping = (header: string, index: number, target: LeadMapTarget) =>
    setOverrides((prev) => {
      const next = { ...prev, [`${index}:${header}`]: target };
      // Keep exactly one Email column: demote any other current Email to Variable.
      if (target === "email") {
        headers.forEach((otherHeader, otherIndex) => {
          if (otherIndex === index) return;
          const key = `${otherIndex}:${otherHeader}`;
          const current = next[key] ?? guessLeadMapTarget(otherHeader);
          if (current === "email") next[key] = "variable";
        });
      }
      return next;
    });

  const buildLeads = (): AddLeadInput[] => {
    const leads: AddLeadInput[] = [];
    for (const cells of dataRows) {
      const lead: AddLeadInput = { email: "" };
      const variables: Record<string, string> = {};
      headers.forEach((header, index) => {
        const target = effectiveTarget(header, index);
        if (target === "ignore") return;
        const value = (cells[index] ?? "").trim();
        if (target === "email") {
          if (index === emailIndex && isSubmittableEmail(value)) lead.email = value;
          return;
        }
        if (target === "variable") {
          if (!value || Object.keys(variables).length >= LEAD_VAR_MAX) return;
          const base = header.trim().slice(0, LEAD_VAR_KEY_MAX);
          if (!base) return;
          // Duplicate headers get a numeric suffix instead of last-write-wins.
          let key = base;
          for (let n = 2; key in variables; n += 1) {
            key = `${base.slice(0, LEAD_VAR_KEY_MAX - String(n).length - 1)}_${n}`;
          }
          variables[key] = value.slice(0, LEAD_VAR_VALUE_MAX);
          return;
        }
        const trimmed = value.slice(0, leadTargetMax(target));
        if (trimmed) lead[target] = trimmed;
      });
      if (Object.keys(variables).length > 0) lead.variables = variables;
      if (lead.email) leads.push(lead);
    }
    return leads;
  };

  const submit = () => {
    setFormError(null);
    if (emailColumns.length !== 1) {
      setFormError("Map exactly one column to Email.");
      return;
    }
    const leads = buildLeads();
    if (leads.length === 0) {
      setFormError("No rows with an email address to add.");
      return;
    }
    if (leads.length > LEAD_MAX_ADD) {
      setFormError(`Add at most ${LEAD_MAX_ADD.toLocaleString()} leads per submission. Split the list and try again.`);
      return;
    }
    startSubmit(async () => {
      const outcome = await onSubmit(leads);
      setResult(outcome);
    });
  };

  const submittableCount = emailColumns.length === 1 ? parsedCount - missingEmail : 0;

  return (
    <div
      className={`fixed inset-0 z-50 flex items-center justify-center bg-background/70 p-4 backdrop-blur-sm ${result?.ok ? "" : "cursor-pointer"} ${closing ? "anim-overlay-out" : "anim-overlay-in"}`}
      onClick={(event) => {
        if (event.target === event.currentTarget && !result?.ok) beginClose();
      }}
    >
      <div className={`flex max-h-[85vh] w-full max-w-2xl cursor-auto flex-col overflow-hidden rounded-xl border border-border bg-surface shadow-pop ${closing ? "anim-panel-out" : "anim-panel-in"}`}>
        {/* Header */}
        <div className="flex items-start justify-between gap-3 border-b border-border px-4 py-3">
          <div className="flex min-w-0 flex-col gap-0.5">
            <h2 className="text-[13.5px] font-semibold tracking-tight">Add leads</h2>
            <p className="text-[11px] text-muted-foreground">
              Paste CSV or TSV with a header row, then map each column.
            </p>
          </div>
          <button
            type="button"
            aria-label="Close"
            disabled={submitting}
            onClick={beginClose}
            className={`flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors duration-150 hover:bg-muted/70 hover:text-foreground disabled:opacity-50`}
          >
            <X className="size-3.5" />
          </button>
        </div>

        {result?.ok ? (
          /* Done screen: the action's summary + a single Done button. */
          <>
            <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 overflow-y-auto px-6 py-10 text-center">
              <span className="flex size-10 items-center justify-center rounded-full bg-success-soft">
                <Check className="size-5 text-success" />
              </span>
              <p className="max-w-md text-[13px] font-medium leading-relaxed">{result.message}</p>
            </div>
            <div className="flex items-center justify-end gap-2 border-t border-border px-4 py-3">
              <button type="button" onClick={beginClose} className={`${BTN_PRIMARY} h-8 px-3 text-[12px]`}>
                Done
              </button>
            </div>
          </>
        ) : (
          <>
            {/* Body */}
            <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-4 py-4">
              <div className="flex flex-col gap-1.5">
                <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                  Paste leads
                </span>
                <textarea
                  value={raw}
                  onChange={(event) => setRaw(event.target.value)}
                  disabled={submitting}
                  spellCheck={false}
                  rows={7}
                  placeholder={"email,first_name,company\njane@acme.com,Jane,Acme Inc"}
                  className={`${TEXTAREA_MULTI} min-h-[9rem] font-mono text-[12px] disabled:opacity-50`}
                />
              </div>

              {headers.length > 0 ? (
                <div className="flex flex-col gap-2">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                      Map columns
                    </span>
                    <span className="text-[11px] tabular-nums text-muted-foreground">
                      {delimiter === "\t" ? "Tab-separated" : "Comma-separated"}
                    </span>
                  </div>
                  <div className="flex flex-col divide-y divide-border overflow-hidden rounded-lg border border-border">
                    {headers.map((header, index) => {
                      const sample = (dataRows[0]?.[index] ?? "").trim();
                      return (
                        <div
                          key={`${index}:${header}`}
                          className="flex items-center gap-3 px-3 py-2"
                        >
                          <div className="flex min-w-0 flex-1 flex-col">
                            <span className="truncate font-mono text-[11.5px] font-medium" title={header}>
                              {header || <span className="italic text-muted-foreground">column {index + 1}</span>}
                            </span>
                            {sample ? (
                              <span className="truncate text-[10.5px] text-muted-foreground" title={sample}>
                                {sample}
                              </span>
                            ) : null}
                          </div>
                          <div className="relative shrink-0">
                            <select
                              value={effectiveTarget(header, index)}
                              onChange={(event) =>
                                setMapping(header, index, event.target.value as LeadMapTarget)
                              }
                              disabled={submitting}
                              aria-label={`Map column ${header || index + 1}`}
                              className="h-7 w-40 appearance-none rounded-md border border-border bg-surface pl-2 pr-6 text-[11.5px] font-medium text-foreground shadow-xs outline-none transition focus:border-ring disabled:opacity-50"
                            >
                              {LEAD_MAP_OPTIONS.map((option) => (
                                <option key={option.value} value={option.value}>
                                  {option.label}
                                </option>
                              ))}
                            </select>
                            <ChevronDown className="pointer-events-none absolute right-1.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
                          </div>
                        </div>
                      );
                    })}
                  </div>

                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11.5px] text-muted-foreground">
                    <span className="tabular-nums">
                      {parsedCount.toLocaleString()} {parsedCount === 1 ? "lead" : "leads"} parsed,{" "}
                      {missingEmail.toLocaleString()} without a valid email
                    </span>
                    {emailColumns.length === 0 ? (
                      <span className="text-warning">Map one column to Email.</span>
                    ) : emailColumns.length > 1 ? (
                      <span className="text-warning">Only one column can be Email.</span>
                    ) : missingEmail > 0 ? (
                      <span>Rows without a valid email are skipped.</span>
                    ) : null}
                  </div>
                </div>
              ) : raw.trim() ? (
                <p className="text-[11.5px] text-muted-foreground">
                  Could not read a header row from that text.
                </p>
              ) : null}

              {formError ? <p className="text-[11.5px] text-destructive">{formError}</p> : null}
              {result && !result.ok ? <p className="text-[11.5px] text-destructive">{result.message}</p> : null}
            </div>

            {/* Footer */}
            <div className="flex items-center justify-between gap-2 border-t border-border px-4 py-3">
              <span className="text-[11px] tabular-nums text-muted-foreground">
                {submittableCount > 0
                  ? `${submittableCount.toLocaleString()} ready to add`
                  : "Nothing to add yet"}
              </span>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={beginClose}
                  disabled={submitting}
                  className={`${BTN_OUTLINE} h-8 px-3 text-[12px]`}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={submit}
                  disabled={submitting || submittableCount <= 0}
                  className={`${BTN_PRIMARY} h-8 px-3 text-[12px]`}
                >
                  {submitting ? <Loader2 className="size-3.5 animate-spin" /> : <Plus className="size-3.5" />}
                  {submitting ? "Adding…" : "Add leads"}
                </button>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/* ── Per-row actions menu ──────────────────────────────────────────────────
   A quiet ellipsis button that opens a viewport-fixed card (fixed escapes the
   table's overflow clipping; a full-screen backdrop dismisses it on any
   outside click). Set category is a second step inside the same card, and
   Remove arms a two-click confirm that disarms after three seconds. */
function LeadActionsMenu({
  row,
  busy,
  categories,
  categoriesLoading,
  onEnsureCategories,
  onPause,
  onResume,
  onUnsubscribe,
  onSetCategory,
  onRemove,
}: {
  row: CampaignLeadRow;
  busy: boolean;
  categories: LeadCategory[] | null;
  categoriesLoading: boolean;
  onEnsureCategories: () => void;
  onPause: () => void;
  onResume: () => void;
  onUnsubscribe: () => void;
  onSetCategory: (categoryId: number) => void;
  onRemove: () => void;
}) {
  const [coords, setCoords] = useState<{ top: number; left: number } | null>(null);
  const [view, setView] = useState<"main" | "category">("main");
  const [removeArmed, setRemoveArmed] = useState(false);
  const removeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);

  useEffect(
    () => () => {
      if (removeTimer.current) clearTimeout(removeTimer.current);
    },
    [],
  );

  // The menu is position: fixed with coords snapshotted at open, so any
  // ancestor scroll would detach it from its row — close instead.
  const menuOpen = coords !== null;
  useEffect(() => {
    if (!menuOpen) return;
    const dismiss = () => setCoords(null);
    window.addEventListener("scroll", dismiss, { capture: true, passive: true });
    return () => window.removeEventListener("scroll", dismiss, { capture: true });
  }, [menuOpen]);

  const MENU_WIDTH = 224;
  const open = () => {
    const rect = triggerRef.current?.getBoundingClientRect();
    if (!rect) return;
    setCoords({ top: rect.bottom + 4, left: Math.max(8, rect.right - MENU_WIDTH) });
    setView("main");
    setRemoveArmed(false);
    onEnsureCategories();
  };
  const close = () => {
    setCoords(null);
    setRemoveArmed(false);
    setView("main");
    if (removeTimer.current) clearTimeout(removeTimer.current);
  };
  const runItem = (fn: () => void) => {
    close();
    fn();
  };
  const armRemove = () => {
    if (removeArmed) {
      runItem(onRemove);
      return;
    }
    setRemoveArmed(true);
    if (removeTimer.current) clearTimeout(removeTimer.current);
    removeTimer.current = setTimeout(() => setRemoveArmed(false), 3000);
  };

  const isPaused = (row.status ?? "").trim().toUpperCase() === "PAUSED";
  const itemClass = `flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12px] transition-colors`;

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        data-tip="Lead actions"
        aria-label="Lead actions"
        aria-haspopup="menu"
        disabled={busy}
        onClick={() => (coords ? close() : open())}
        className={ICON_BTN_QUIET}
      >
        {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Ellipsis className="size-3.5" />}
      </button>

      {coords ? (
        <>
          <div className="fixed inset-0 z-30 cursor-pointer" aria-hidden onMouseDown={close} />
          <div
            role="menu"
            className="anim-menu-in fixed z-40 w-56 overflow-hidden rounded-lg border border-border bg-surface p-1 shadow-pop"
            style={{ top: coords.top, left: coords.left }}
          >
            {view === "main" ? (
              <>
                {isPaused ? (
                  <button type="button" role="menuitem" onClick={() => runItem(onResume)} className={`${itemClass} hover:bg-muted/60`}>
                    <Play className="size-3.5 text-muted-foreground" />
                    Resume
                  </button>
                ) : (
                  <button type="button" role="menuitem" onClick={() => runItem(onPause)} className={`${itemClass} hover:bg-muted/60`}>
                    <Pause className="size-3.5 text-muted-foreground" />
                    Pause
                  </button>
                )}
                {!row.unsubscribed ? (
                  <button type="button" role="menuitem" onClick={() => runItem(onUnsubscribe)} className={`${itemClass} hover:bg-muted/60`}>
                    <Ban className="size-3.5 text-muted-foreground" />
                    Unsubscribe
                  </button>
                ) : null}
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => setView("category")}
                  className={`${itemClass} hover:bg-muted/60`}
                >
                  <Tag className="size-3.5 text-muted-foreground" />
                  Set category
                  <ChevronRight className="ml-auto size-3.5 text-muted-foreground" />
                </button>
                <div className="my-1 h-px bg-border" />
                <button
                  type="button"
                  role="menuitem"
                  onClick={armRemove}
                  className={`${itemClass} text-destructive hover:bg-destructive-soft`}
                >
                  <Trash2 className="size-3.5" />
                  {removeArmed ? "Remove? Click again" : "Remove"}
                </button>
              </>
            ) : (
              <>
                <button
                  type="button"
                  onClick={() => setView("main")}
                  className="flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-[11px] font-medium text-muted-foreground transition-colors hover:text-foreground"
                >
                  <ArrowLeft className="size-3.5" />
                  Set category
                </button>
                <div className="my-1 h-px bg-border" />
                <div className="max-h-64 overflow-y-auto">
                  {categoriesLoading && !categories ? (
                    <span className="flex items-center gap-2 px-2 py-1.5 text-[12px] text-muted-foreground">
                      <Loader2 className="size-3.5 animate-spin" />
                      Loading categories…
                    </span>
                  ) : categories && categories.length > 0 ? (
                    categories.map((category) => {
                      const active = row.categoryId === category.id;
                      return (
                        <button
                          key={category.id}
                          type="button"
                          role="menuitem"
                          onClick={() => runItem(() => onSetCategory(category.id))}
                          className={`${itemClass} hover:bg-muted/60`}
                        >
                          <span
                            className={`size-1.5 shrink-0 rounded-full ${dotClass(null, normalizeSentiment(category.sentimentType))}`}
                            aria-hidden
                          />
                          <span className="min-w-0 truncate" title={category.name}>
                            {category.name}
                          </span>
                          {active ? <Check className="ml-auto size-3.5 text-muted-foreground" /> : null}
                        </button>
                      );
                    })
                  ) : (
                    <div className="flex flex-col gap-1 px-2 py-1.5">
                      <span className="text-[12px] text-muted-foreground">No categories found.</span>
                      <button
                        type="button"
                        onClick={onEnsureCategories}
                        className="self-start text-[11px] font-medium text-muted-foreground transition-colors hover:text-foreground"
                      >
                        Retry
                      </button>
                    </div>
                  )}
                </div>
              </>
            )}
          </div>
        </>
      ) : null}
    </>
  );
}

/* ── Leads table ───────────────────────────────────────────────────────────
   A wide, scrollable table of the campaign's loaded leads. Fixed key columns
   (name · email · company · LinkedIn · location · status) followed by one
   column per merge variable present on the current page — the union of every
   row's `variables` keys, sorted, header labelled with the raw {{merge_tag}}
   name. Everything past the fixed set is data the sequence merges in, so it's
   surfaced verbatim. The filter and variable-column set are per page (the
   only rows in hand); page state and fetching live in the parent. */
function LeadsSection({
  campaignId,
  total,
  page,
  rows,
  loading,
  filter,
  onFilterChange,
  onGoToPage,
  onLeadPatched,
  allLeads,
  loadAllState,
  loadAllCount,
  onLoadAll,
  showToast,
  leadCategories,
  categoriesLoading,
  onEnsureCategories,
  busyLeadMapId,
  onPauseLead,
  onResumeLead,
  onUnsubscribeLead,
  onSetLeadCategory,
  onRemoveLead,
  onSubmitAddLeads,
}: {
  campaignId: string;
  total: number;
  page: number;
  rows: CampaignLeadRow[] | null;
  loading: boolean;
  filter: string;
  onFilterChange: (next: string) => void;
  onGoToPage: (page: number) => void;
  onLeadPatched: (updated: CampaignLeadRow) => void;
  allLeads: CampaignLeadRow[] | null;
  loadAllState: "idle" | "loading" | "error";
  loadAllCount: number;
  onLoadAll: () => void;
  showToast: (ok: boolean, text: string) => void;
  leadCategories: LeadCategory[] | null;
  categoriesLoading: boolean;
  onEnsureCategories: () => void;
  busyLeadMapId: string | null;
  onPauseLead: (row: CampaignLeadRow) => void;
  onResumeLead: (row: CampaignLeadRow) => void;
  onUnsubscribeLead: (row: CampaignLeadRow) => void;
  onSetLeadCategory: (row: CampaignLeadRow, categoryId: number) => void;
  onRemoveLead: (row: CampaignLeadRow) => void;
  onSubmitAddLeads: (leads: AddLeadInput[]) => Promise<ActionResult>;
}) {
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [editingLead, setEditingLead] = useState<CampaignLeadRow | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [sortKey, setSortKey] = useState<LeadsSortKey>("none");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");
  // Client-side view page, used only when the full set is loaded (page-mode
  // paging stays on the `page`/`onGoToPage` server path). The stored page is
  // tagged with the refine signature it belonged to, so any change to the
  // refine inputs derives back to the first view without a reset effect.
  const refineSignature = `${filter}\u0000${statusFilter}\u0000${sortKey}\u0000${sortDir}`;
  const [viewPageState, setViewPageState] = useState<{ signature: string; page: number }>({
    signature: refineSignature,
    page: 0,
  });
  const viewPage = viewPageState.signature === refineSignature ? viewPageState.page : 0;
  const setViewPage = (next: number) => setViewPageState({ signature: refineSignature, page: next });

  // Once the whole campaign is loaded, refine over that set; otherwise the
  // refine (and column pruning) is scoped to the rows in hand for this page.
  const loaded = allLeads !== null;
  const baseRows = loaded ? allLeads : rows;

  // Union of variable keys across the base set, sorted — one column each.
  const variableKeys: string[] = [];
  if (baseRows) {
    const seen = new Set<string>();
    for (const row of baseRows) for (const key of Object.keys(row.variables)) seen.add(key);
    variableKeys.push(...[...seen].sort((a, b) => a.localeCompare(b)));
  }

  // Smartlead keeps map rows whose lead was removed upstream (every identity
  // field empty). They must stay in the payload so offset pagination lines up
  // with the total, but a wall of em-dash rows is noise — collapse them into
  // one summary line (counted across the whole base set).
  const isRemoved = (row: CampaignLeadRow) =>
    !row.firstName && !row.lastName && !row.email && !row.company && Object.keys(row.variables).length === 0;
  const removedCount = baseRows === null ? 0 : baseRows.filter(isRemoved).length;

  // Client-side filter over the base set (name / email / company / any
  // variable value), case-insensitive.
  const query = filter.trim().toLowerCase();
  const filtered =
    baseRows === null
      ? []
      : baseRows.filter((row) => {
          if (isRemoved(row)) return false;
          if (query === "") return true;
          if (`${row.firstName} ${row.lastName}`.toLowerCase().includes(query)) return true;
          if (row.email.toLowerCase().includes(query)) return true;
          if (row.company.toLowerCase().includes(query)) return true;
          for (const value of Object.values(row.variables))
            if (value.toLowerCase().includes(query)) return true;
          return false;
        });

  // Status filter + sorting are page-scoped like the search (Smartlead's
  // leads endpoint offers no server-side sort or filter parameters).
  const statusOptions = (() => {
    const seen = new Set<string>();
    for (const row of baseRows ?? []) {
      if (!isRemoved(row) && row.status?.trim()) seen.add(row.status.trim().toUpperCase());
    }
    return [...seen].sort((a, b) => a.localeCompare(b));
  })();
  const statusFiltered =
    statusFilter === "all"
      ? filtered
      : statusFilter === "unsubscribed"
        ? filtered.filter((row) => row.unsubscribed)
        : filtered.filter((row) => (row.status ?? "").trim().toUpperCase() === statusFilter);
  const sortValue = (row: CampaignLeadRow): string => {
    if (sortKey === "name") return `${row.firstName} ${row.lastName}`.trim().toLowerCase();
    if (sortKey === "email") return row.email.toLowerCase();
    if (sortKey === "company") return row.company.toLowerCase();
    return (row.status ?? "").toLowerCase();
  };
  const visible =
    sortKey === "none"
      ? statusFiltered
      : [...statusFiltered].sort((a, b) => {
          // Empty values sink to the bottom in either direction.
          const av = sortValue(a);
          const bv = sortValue(b);
          if (!av && !bv) return 0;
          if (!av) return 1;
          if (!bv) return -1;
          return sortDir === "asc" ? av.localeCompare(bv) : bv.localeCompare(av);
        });
  const refining = filter.trim() !== "" || statusFilter !== "all" || sortKey !== "none";

  // Pagination: server-side over `total` when browsing pages, client-side over
  // the refined set once the whole campaign is loaded (Prev/Next never fetch).
  const refinedCount = visible.length;
  const pageCount = loaded
    ? Math.max(1, Math.ceil(refinedCount / LEADS_PAGE_SIZE))
    : Math.max(1, Math.ceil(total / LEADS_PAGE_SIZE));
  const currentPage = loaded ? Math.min(viewPage, pageCount - 1) : page;
  const rangeTotal = loaded ? refinedCount : total;
  const from = rangeTotal === 0 ? 0 : currentPage * LEADS_PAGE_SIZE + 1;
  const to = Math.min((currentPage + 1) * LEADS_PAGE_SIZE, rangeTotal);
  // Rows rendered in the table body: the current client-side window when
  // loaded (the refined set is the full campaign), else the refined page rows.
  const displayRows = loaded
    ? visible.slice(currentPage * LEADS_PAGE_SIZE, currentPage * LEADS_PAGE_SIZE + LEADS_PAGE_SIZE)
    : visible;
  // Columns that are empty across the refined set carry no information —
  // hide them instead of rendering a stripe of em dashes.
  const showCompany = visible.some((row) => row.company.trim());
  const showLocation = visible.some((row) => row.location.trim());
  // The category column appears only when at least one visible lead is
  // categorized (mirrors the empty-column hiding for company/location).
  const showCategory = visible.some((row) => row.categoryId !== null);
  const categoryFor = (categoryId: number | null): LeadCategory | null => {
    if (categoryId === null || !leadCategories) return null;
    return leadCategories.find((category) => category.id === categoryId) ?? null;
  };
  // +1 for the trailing action column (always present, no header label).
  const colSpan =
    4 + (showCompany ? 1 : 0) + (showLocation ? 1 : 0) + (showCategory ? 1 : 0) + variableKeys.length;

  // Load the category list lazily the first time any lead here is categorized
  // (the menu's first open triggers it too, whichever happens first).
  useEffect(() => {
    if (showCategory) onEnsureCategories();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showCategory]);

  const thBase =
    "whitespace-nowrap px-3 py-2 text-left text-[10px] font-semibold uppercase tracking-wide text-muted-foreground";
  const thVar =
    "whitespace-nowrap px-3 py-2 text-left font-mono text-[10px] font-medium normal-case text-muted-foreground";
  const dash = <span className="text-muted-foreground/70">—</span>;

  return (
    <div className="flex flex-col gap-3">
      <SettingGroup
        title="Leads"
        description="Everyone loaded into this campaign, with the variables the sequence merges in."
        control={
          <div className="flex shrink-0 items-center gap-2.5">
            <span className="text-[12px] font-medium tabular-nums text-muted-foreground">
              {total.toLocaleString()} leads
            </span>
            <button type="button" onClick={() => setAddOpen(true)} className={`${BTN_PRIMARY} h-7 px-2.5 text-[11.5px]`}>
              <Plus className="size-3.5" />
              Add leads
            </button>
          </div>
        }
      />

      {total === 0 ? (
        <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed border-border px-4 py-10 text-center">
          <span className="flex size-9 items-center justify-center rounded-full bg-muted/60">
            <Users className="size-4 text-muted-foreground" strokeWidth={1.5} />
          </span>
          <p className="text-[12.5px] text-muted-foreground">
            No leads have been loaded into this campaign yet.
          </p>
        </div>
      ) : (
        <>
          {/* Toolbar: search + status filter + sort, all scoped to this page */}
          <div className="flex flex-col gap-1">
            <div className="flex flex-wrap items-center gap-1.5">
              <div className="relative w-64">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
                <input
                  value={filter}
                  onChange={(event) => onFilterChange(event.target.value)}
                  placeholder={loaded ? "Filter all leads…" : "Filter leads on this page…"}
                  className={`${INPUT_CLASS} pl-8`}
                />
              </div>
              <div className="relative">
                <select
                  value={statusFilter}
                  onChange={(event) => setStatusFilter(event.target.value)}
                  aria-label="Filter by lead status"
                  className="h-7 appearance-none rounded-md border border-border bg-surface pl-2 pr-6 text-[11.5px] font-medium text-foreground shadow-xs outline-none transition focus:border-ring"
                >
                  <option value="all">All statuses</option>
                  {statusOptions.map((value) => (
                    <option key={value} value={value}>
                      {leadStatusPill(value).label}
                    </option>
                  ))}
                  <option value="unsubscribed">Unsubscribed</option>
                </select>
                <ChevronDown className="pointer-events-none absolute right-1.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
              </div>
              <div className="relative">
                <select
                  value={sortKey}
                  onChange={(event) => setSortKey(event.target.value as LeadsSortKey)}
                  aria-label="Sort leads"
                  className="h-7 appearance-none rounded-md border border-border bg-surface pl-2 pr-6 text-[11.5px] font-medium text-foreground shadow-xs outline-none transition focus:border-ring"
                >
                  <option value="none">Loaded order</option>
                  <option value="name">Name</option>
                  <option value="company">Company</option>
                  <option value="email">Email</option>
                  <option value="status">Status</option>
                </select>
                <ChevronDown className="pointer-events-none absolute right-1.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
              </div>
              {sortKey !== "none" ? (
                <button
                  type="button"
                  data-tip={sortDir === "asc" ? "Ascending. Click for descending." : "Descending. Click for ascending."}
                  data-tip-down=""
                  aria-label={sortDir === "asc" ? "Sort descending" : "Sort ascending"}
                  onClick={() => setSortDir((dir) => (dir === "asc" ? "desc" : "asc"))}
                  className={`flex size-7 shrink-0 items-center justify-center rounded-md border border-border bg-surface text-muted-foreground shadow-xs transition hover:text-foreground`}
                >
                  {sortDir === "asc" ? (
                    <ArrowUpNarrowWide className="size-3.5" />
                  ) : (
                    <ArrowDownWideNarrow className="size-3.5" />
                  )}
                </button>
              ) : null}

              {/* Load-all control / progress / loaded note — global refine. */}
              {allLeads === null ? (
                loadAllState === "loading" ? (
                  <div className="ml-1 flex items-center gap-2">
                    <Loader2 className="size-3.5 animate-spin text-muted-foreground" />
                    <span className="text-[11px] tabular-nums text-muted-foreground">
                      Loading {loadAllCount.toLocaleString()} of {total.toLocaleString()}…
                    </span>
                    <span className="h-1 w-40 overflow-hidden rounded bg-muted">
                      <span
                        className="block h-full rounded bg-primary transition-all"
                        style={{
                          width: `${total > 0 ? Math.min(100, (loadAllCount / total) * 100) : 0}%`,
                        }}
                      />
                    </span>
                  </div>
                ) : loadAllState === "error" ? (
                  <div className="ml-1 flex items-center gap-2">
                    <span className="text-[11px] text-muted-foreground">Couldn&rsquo;t load all leads</span>
                    <button
                      type="button"
                      onClick={onLoadAll}
                      className="text-[11px] font-medium text-muted-foreground transition hover:text-foreground"
                    >
                      Retry
                    </button>
                  </div>
                ) : (
                  <button type="button" onClick={onLoadAll} className={`${BTN_OUTLINE} ml-1 h-7 px-2.5 text-[11.5px]`}>
                    <Download className="size-3.5" />
                    Load all {total.toLocaleString()} leads
                  </button>
                )
              ) : (
                <span className="ml-1 text-[11px] text-muted-foreground">
                  All {total.toLocaleString()} leads loaded
                </span>
              )}

              {refining ? (
                <button
                  type="button"
                  onClick={() => {
                    onFilterChange("");
                    setStatusFilter("all");
                    setSortKey("none");
                  }}
                  className={`ml-1 text-[11px] font-medium text-muted-foreground transition hover:text-foreground`}
                >
                  Clear
                </button>
              ) : null}
            </div>
            {!loaded && refining ? (
              <span className="text-[11px] text-muted-foreground">
                Filters and sorting apply to this page only. Load all leads to search everything.
              </span>
            ) : null}
          </div>

          {/* Wide table — scrolls horizontally inside the card */}
          <div className="overflow-hidden rounded-xl bg-surface shadow-xs">
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-left">
                <thead>
                  <tr className="border-b border-border bg-surface-muted">
                    <th className={thBase}>Lead</th>
                    {showCompany ? <th className={thBase}>Company</th> : null}
                    <th className={thBase}>LinkedIn</th>
                    {showLocation ? <th className={thBase}>Location</th> : null}
                    <th className={thBase}>Status</th>
                    {showCategory ? <th className={thBase}>Category</th> : null}
                    {variableKeys.map((key) => (
                      <th key={key} className={thVar} title={key}>
                        {key}
                      </th>
                    ))}
                    <th className={`${thBase} w-16`} aria-hidden />
                  </tr>
                </thead>
                <tbody>
                  {baseRows === null ? (
                    <tr>
                      <td colSpan={colSpan} className="px-3 py-12 text-center">
                        <span className="inline-flex items-center gap-2 text-[12px] text-muted-foreground">
                          <Loader2 className="size-4 animate-spin" />
                          Loading leads…
                        </span>
                      </td>
                    </tr>
                  ) : displayRows.length === 0 ? (
                    <tr>
                      <td
                        colSpan={colSpan}
                        className="px-3 py-12 text-center text-[12px] text-muted-foreground"
                      >
                        {refining
                          ? loaded
                            ? "No leads match your filters."
                            : "No leads on this page match your filters."
                          : loaded
                            ? "No leads."
                            : "No leads on this page."}
                      </td>
                    </tr>
                  ) : (
                    displayRows.map((row) => {
                      const name = [row.firstName, row.lastName]
                        .map((part) => part.trim())
                        .filter(Boolean)
                        .join(" ");
                      const statusPill =
                        row.status && row.status.trim() ? leadStatusPill(row.status) : null;
                      return (
                        <tr
                          key={row.mapId}
                          className="border-b border-border/60 transition-colors hover:bg-muted/40"
                        >
                          <td className="px-3 py-2">
                            {name || row.email.trim() ? (
                              <span className="flex max-w-[240px] flex-col">
                                {name ? (
                                  <span className="truncate text-[12.5px] font-semibold" title={name}>
                                    {name}
                                  </span>
                                ) : null}
                                {row.email.trim() ? (
                                  <span className="truncate text-[11.5px] text-muted-foreground" title={row.email}>
                                    {row.email}
                                  </span>
                                ) : null}
                              </span>
                            ) : (
                              dash
                            )}
                          </td>
                          {showCompany ? (
                            <td className="px-3 py-2">
                              {row.company.trim() ? (
                                <span
                                  className="block max-w-[200px] truncate text-[12px]"
                                  title={row.company}
                                >
                                  {row.company}
                                </span>
                              ) : (
                                dash
                              )}
                            </td>
                          ) : null}
                          <td className="px-3 py-2">
                            {row.linkedinUrl ? (
                              <a
                                href={row.linkedinUrl}
                                target="_blank"
                                rel="noopener noreferrer"
                                data-tip="LinkedIn profile"
                                aria-label="LinkedIn profile"
                                className={`inline-flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted/70 hover:text-foreground`}
                              >
                                <ExternalLink className="size-3.5" />
                              </a>
                            ) : (
                              dash
                            )}
                          </td>
                          {showLocation ? (
                            <td className="px-3 py-2">
                              {row.location.trim() ? (
                                <span
                                  className="block max-w-[180px] truncate text-[12px]"
                                  title={row.location}
                                >
                                  {row.location}
                                </span>
                              ) : (
                                dash
                              )}
                            </td>
                          ) : null}
                          <td className="px-3 py-2">
                            {statusPill || row.unsubscribed ? (
                              <span className="flex flex-wrap items-center gap-1">
                                {statusPill ? (
                                  <span className={`${LEAD_STATUS_PILL} ${statusPill.className}`}>
                                    {statusPill.label}
                                  </span>
                                ) : null}
                                {row.unsubscribed ? (
                                  <span
                                    className={`${LEAD_STATUS_PILL} bg-destructive-soft text-destructive`}
                                  >
                                    Unsubscribed
                                  </span>
                                ) : null}
                              </span>
                            ) : (
                              dash
                            )}
                          </td>
                          {showCategory ? (
                            <td className="px-3 py-2">
                              {(() => {
                                const category = categoryFor(row.categoryId);
                                return category ? (
                                  <span className="inline-flex max-w-[180px] items-center gap-1.5">
                                    <span
                                      className={`size-1.5 shrink-0 rounded-full ${dotClass(null, normalizeSentiment(category.sentimentType))}`}
                                      aria-hidden
                                    />
                                    <span className="truncate text-[12px]" title={category.name}>
                                      {category.name}
                                    </span>
                                  </span>
                                ) : (
                                  dash
                                );
                              })()}
                            </td>
                          ) : null}
                          {variableKeys.map((key) => {
                            const value = row.variables[key];
                            return (
                              <td key={key} className="px-3 py-2">
                                {value && value.trim() ? (
                                  <span
                                    className="block max-w-[320px] truncate text-[12px]"
                                    title={value}
                                  >
                                    {value}
                                  </span>
                                ) : (
                                  dash
                                )}
                              </td>
                            );
                          })}
                          <td className="px-2 py-2">
                            {row.leadId !== null ? (
                              <div className="flex items-center justify-end gap-0.5">
                                <button
                                  type="button"
                                  data-tip="Edit lead"
                                  aria-label="Edit lead"
                                  onClick={() => setEditingLead(row)}
                                  className={ICON_BTN_QUIET}
                                >
                                  <Pencil className="size-3.5" />
                                </button>
                                <LeadActionsMenu
                                  row={row}
                                  busy={busyLeadMapId === row.mapId}
                                  categories={leadCategories}
                                  categoriesLoading={categoriesLoading}
                                  onEnsureCategories={onEnsureCategories}
                                  onPause={() => onPauseLead(row)}
                                  onResume={() => onResumeLead(row)}
                                  onUnsubscribe={() => onUnsubscribeLead(row)}
                                  onSetCategory={(categoryId) => onSetLeadCategory(row, categoryId)}
                                  onRemove={() => onRemoveLead(row)}
                                />
                              </div>
                            ) : null}
                          </td>
                        </tr>
                      );
                    })
                  )}
                  {removedCount > 0 && (loaded || !loading) ? (
                    <tr>
                      <td colSpan={colSpan} className="px-3 py-2 text-[11px] text-muted-foreground">
                        {removedCount.toLocaleString()} removed {removedCount === 1 ? "lead" : "leads"} hidden
                        {loaded ? "." : " on this page."}
                      </td>
                    </tr>
                  ) : null}
                </tbody>
              </table>
            </div>

            {/* Pagination footer — client-side flips when loaded, else server. */}
            <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border px-3 py-2.5">
              <span className="text-[11px] tabular-nums text-muted-foreground">
                Showing {from.toLocaleString()}–{to.toLocaleString()} of {rangeTotal.toLocaleString()}
                {loaded && refinedCount < total ? ` · filtered from ${total.toLocaleString()}` : ""}
              </span>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  disabled={currentPage === 0 || (!loaded && loading)}
                  onClick={() => (loaded ? setViewPage(currentPage - 1) : onGoToPage(page - 1))}
                  className={`${BTN_OUTLINE} h-7 px-2.5 text-[11.5px]`}
                >
                  Prev
                </button>
                <span className="text-[11px] tabular-nums text-muted-foreground">
                  Page {currentPage + 1} of {pageCount}
                </span>
                <button
                  type="button"
                  disabled={currentPage >= pageCount - 1 || (!loaded && loading)}
                  onClick={() => (loaded ? setViewPage(currentPage + 1) : onGoToPage(page + 1))}
                  className={`${BTN_OUTLINE} h-7 px-2.5 text-[11.5px]`}
                >
                  Next
                </button>
              </div>
            </div>
          </div>
        </>
      )}

      {editingLead ? (
        <LeadEditorModal
          lead={editingLead}
          campaignId={campaignId}
          showToast={showToast}
          onClose={() => setEditingLead(null)}
          onSaved={(updated) => {
            onLeadPatched(updated);
            setEditingLead(null);
          }}
        />
      ) : null}

      {addOpen ? (
        <AddLeadsModal onSubmit={onSubmitAddLeads} onClose={() => setAddOpen(false)} />
      ) : null}
    </div>
  );
}

/* ── Lead editor field ─────────────────────────────────────────────────────
   One labelled text input in the lead editor's identity/links groups — the
   modal's 10px uppercase label grammar over an INPUT_CLASS field. */
function LeadEditorField({
  label,
  value,
  onChange,
  placeholder,
  disabled,
}: {
  label: string;
  value: string;
  onChange: (next: string) => void;
  placeholder?: string;
  disabled?: boolean;
}) {
  return (
    <label className="flex min-w-0 flex-col gap-1">
      <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
        {label}
      </span>
      <input
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        disabled={disabled}
        className={`${INPUT_CLASS} disabled:opacity-50`}
      />
    </label>
  );
}

/* ── Lead editor modal ─────────────────────────────────────────────────────
   Edits a single campaign lead's identity fields and custom variables in the
   CampaignWizard modal idiom. Email is Smartlead's required identity anchor —
   shown but never editable; the row's existing email is always submitted.
   Variables are held as an ordered {key,value,removed} list so add/remove stay
   stable, and collapse to a record on save (removed keys omitted). Save sends
   the FULL lead body (the endpoint takes nothing less) and, on ok, patches the
   row in place through onSaved — no refetch. */
function LeadEditorModal({
  lead,
  campaignId,
  showToast,
  onClose,
  onSaved,
}: {
  lead: CampaignLeadRow;
  campaignId: string;
  showToast: (ok: boolean, text: string) => void;
  onClose: () => void;
  onSaved: (updated: CampaignLeadRow) => void;
}) {
  const [saving, startSaving] = useTransition();
  const { closing, playExit } = useExit();

  const [firstName, setFirstName] = useState(lead.firstName);
  const [lastName, setLastName] = useState(lead.lastName);
  const [company, setCompany] = useState(lead.company);
  const [location, setLocation] = useState(lead.location);
  const [phone, setPhone] = useState(lead.phone);
  const [linkedinUrl, setLinkedinUrl] = useState(lead.linkedinUrl ?? "");
  const [website, setWebsite] = useState(lead.website);
  const [companyUrl, setCompanyUrl] = useState(lead.companyUrl ?? "");

  type VarEntry = { key: string; value: string; removed: boolean };
  const [entries, setEntries] = useState<VarEntry[]>(() =>
    Object.entries(lead.variables).map(([key, value]) => ({ key, value, removed: false })),
  );
  const [adding, setAdding] = useState(false);
  const [newKey, setNewKey] = useState("");
  const [newValue, setNewValue] = useState("");
  const [keyError, setKeyError] = useState<string | null>(null);

  // Two-step armed discard on Cancel/X/Escape (the SequenceEditor pattern).
  const [closeArmed, setCloseArmed] = useState(false);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (closeTimer.current) clearTimeout(closeTimer.current);
  }, []);

  // Lock the page behind the modal (CampaignWizard idiom).
  useEffect(() => {
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
    };
  }, []);

  const activeVars = entries.filter((entry) => !entry.removed);
  const currentRecord: Record<string, string> = {};
  for (const entry of activeVars) currentRecord[entry.key] = entry.value;
  const sameVars = (() => {
    const keys = Object.keys(currentRecord);
    const baseKeys = Object.keys(lead.variables);
    return keys.length === baseKeys.length && keys.every((key) => lead.variables[key] === currentRecord[key]);
  })();
  const dirty =
    firstName !== lead.firstName ||
    lastName !== lead.lastName ||
    company !== lead.company ||
    location !== lead.location ||
    phone !== lead.phone ||
    linkedinUrl !== (lead.linkedinUrl ?? "") ||
    website !== lead.website ||
    companyUrl !== (lead.companyUrl ?? "") ||
    !sameVars;

  const requestClose = () => {
    if (saving) return;
    if (!dirty) {
      playExit(onClose);
      return;
    }
    if (!closeArmed) {
      setCloseArmed(true);
      if (closeTimer.current) clearTimeout(closeTimer.current);
      closeTimer.current = setTimeout(() => setCloseArmed(false), 3000);
      return;
    }
    playExit(onClose);
  };

  // Escape closes (armed-discard when dirty), never mid-save.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") requestClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const removeVar = (index: number) =>
    setEntries((prev) => prev.map((entry, i) => (i === index ? { ...entry, removed: true } : entry)));
  const undoRemove = (index: number) =>
    setEntries((prev) => prev.map((entry, i) => (i === index ? { ...entry, removed: false } : entry)));
  const setVarValue = (index: number, value: string) =>
    setEntries((prev) => prev.map((entry, i) => (i === index ? { ...entry, value } : entry)));

  const commitNewVar = () => {
    const key = newKey.trim();
    if (!/^[a-zA-Z0-9_]{1,80}$/.test(key)) {
      setKeyError("Letters, numbers, and underscores only.");
      return;
    }
    const existing = entries.findIndex((entry) => entry.key === key);
    if (existing !== -1) {
      if (!entries[existing].removed) {
        setKeyError("That variable already exists.");
        return;
      }
      // The key is present but struck through — restore it with the new value.
      setEntries((prev) =>
        prev.map((entry, i) => (i === existing ? { ...entry, removed: false, value: newValue } : entry)),
      );
    } else {
      setEntries((prev) => [...prev, { key, value: newValue, removed: false }]);
    }
    setNewKey("");
    setNewValue("");
    setKeyError(null);
    setAdding(false);
  };

  const save = () => {
    if (!lead.leadId) return;
    const variables: Record<string, string> = {};
    for (const entry of activeVars) variables[entry.key] = entry.value.trim();
    const input = {
      email: lead.email,
      firstName: firstName.trim(),
      lastName: lastName.trim(),
      company: company.trim(),
      website: website.trim(),
      location: location.trim(),
      phone: phone.trim(),
      linkedinUrl: linkedinUrl.trim(),
      companyUrl: companyUrl.trim(),
      variables,
    };
    startSaving(async () => {
      const result = await updateCampaignLeadAction(campaignId, lead.leadId as string, input);
      showToast(result.ok, result.message);
      if (result.ok) {
        playExit(() =>
          onSaved({
            ...lead,
            firstName: input.firstName,
            lastName: input.lastName,
            company: input.company,
            website: input.website,
            location: input.location,
            phone: input.phone,
            linkedinUrl: input.linkedinUrl || null,
            companyUrl: input.companyUrl || null,
            variables: input.variables,
          }),
        );
      }
    });
  };

  const displayName = [firstName, lastName]
    .map((part) => part.trim())
    .filter(Boolean)
    .join(" ");
  const groupLabel = "text-[10px] font-semibold uppercase tracking-wide text-muted-foreground";

  return (
    <div
      className={`fixed inset-0 z-50 flex cursor-pointer items-center justify-center bg-background/70 p-4 backdrop-blur-sm ${closing ? "anim-overlay-out" : "anim-overlay-in"}`}
      onClick={(event) => {
        if (event.target === event.currentTarget) requestClose();
      }}
    >
      <div className={`flex max-h-[85vh] w-full max-w-lg cursor-auto flex-col overflow-hidden rounded-xl border border-border bg-surface shadow-pop ${closing ? "anim-panel-out" : "anim-panel-in"}`}>
        {/* Header */}
        <div className="flex items-start justify-between gap-3 border-b border-border px-4 py-3">
          <div className="flex min-w-0 flex-col gap-0.5">
            <h2 className="truncate text-[13.5px] font-semibold tracking-tight" title={displayName || lead.email}>
              {displayName || lead.email}
            </h2>
            <p className="truncate text-[11px] text-muted-foreground" title={lead.email}>
              {lead.email} · not editable
            </p>
          </div>
          <button
            type="button"
            aria-label="Close"
            onClick={requestClose}
            className={`flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted/70 hover:text-foreground disabled:opacity-50`}
          >
            <X className="size-3.5" />
          </button>
        </div>

        {/* Body */}
        <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-4 py-4">
          {/* Identity */}
          <div className="flex flex-col gap-2.5">
            <span className={groupLabel}>Identity</span>
            <div className="grid grid-cols-2 gap-2">
              <LeadEditorField label="First name" value={firstName} onChange={setFirstName} disabled={saving} />
              <LeadEditorField label="Last name" value={lastName} onChange={setLastName} disabled={saving} />
            </div>
            <LeadEditorField label="Company" value={company} onChange={setCompany} disabled={saving} />
            <div className="grid grid-cols-2 gap-2">
              <LeadEditorField label="Location" value={location} onChange={setLocation} disabled={saving} />
              <LeadEditorField label="Phone" value={phone} onChange={setPhone} disabled={saving} />
            </div>
          </div>

          {/* Links */}
          <div className="flex flex-col gap-2.5">
            <span className={groupLabel}>Links</span>
            <LeadEditorField
              label="LinkedIn URL"
              value={linkedinUrl}
              onChange={setLinkedinUrl}
              placeholder="https://linkedin.com/in/…"
              disabled={saving}
            />
            <LeadEditorField
              label="Website"
              value={website}
              onChange={setWebsite}
              placeholder="https://…"
              disabled={saving}
            />
            <LeadEditorField
              label="Company URL"
              value={companyUrl}
              onChange={setCompanyUrl}
              placeholder="https://…"
              disabled={saving}
            />
          </div>

          {/* Variables */}
          <div className="flex flex-col gap-2.5">
            <span className={groupLabel}>Variables</span>
            {entries.length === 0 ? (
              <p className="text-[11px] text-muted-foreground">No custom variables on this lead.</p>
            ) : (
              <div className="flex flex-col gap-1.5">
                {entries.map((entry, index) =>
                  entry.removed ? (
                    <div key={entry.key} className="flex items-center gap-2 py-0.5">
                      <span
                        title={entry.key}
                        className="min-w-0 truncate font-mono text-[11px] text-muted-foreground line-through"
                      >
                        {entry.key}
                      </span>
                      <span className="text-[11px] text-muted-foreground">removed</span>
                      <button
                        type="button"
                        onClick={() => undoRemove(index)}
                        disabled={saving}
                        className="ml-auto text-[11px] font-medium text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50"
                      >
                        Undo
                      </button>
                    </div>
                  ) : (
                    <div key={entry.key} className="flex items-center gap-2">
                      <span
                        title={entry.key}
                        className="w-28 shrink-0 truncate font-mono text-[11px] text-muted-foreground"
                      >
                        {entry.key}
                      </span>
                      <input
                        value={entry.value}
                        onChange={(event) => setVarValue(index, event.target.value)}
                        disabled={saving}
                        className={`${INPUT_CLASS} flex-1 disabled:opacity-50`}
                      />
                      <button
                        type="button"
                        data-tip="Remove variable"
                        aria-label="Remove variable"
                        onClick={() => removeVar(index)}
                        disabled={saving}
                        className={ICON_BTN_QUIET}
                      >
                        <X className="size-3.5" />
                      </button>
                    </div>
                  ),
                )}
              </div>
            )}

            {adding ? (
              <div className="flex flex-col gap-1.5 rounded-lg border border-border bg-muted/30 p-2.5">
                <div className="flex items-center gap-2">
                  <input
                    autoFocus
                    value={newKey}
                    onChange={(event) => {
                      setNewKey(event.target.value);
                      if (keyError) setKeyError(null);
                    }}
                    placeholder="variable_key"
                    className={`${INPUT_CLASS} w-36 shrink-0 font-mono`}
                  />
                  <input
                    value={newValue}
                    onChange={(event) => setNewValue(event.target.value)}
                    placeholder="Value"
                    onKeyDown={(event) => {
                      if (event.key === "Enter") commitNewVar();
                    }}
                    className={`${INPUT_CLASS} flex-1`}
                  />
                  <button type="button" onClick={commitNewVar} className={`${BTN_PRIMARY} h-8 shrink-0 px-2.5 text-[12px]`}>
                    Add
                  </button>
                  <button
                    type="button"
                    aria-label="Cancel new variable"
                    onClick={() => {
                      setAdding(false);
                      setNewKey("");
                      setNewValue("");
                      setKeyError(null);
                    }}
                    className={ICON_BTN_QUIET}
                  >
                    <X className="size-3.5" />
                  </button>
                </div>
                {keyError ? <p className="text-[11px] text-destructive">{keyError}</p> : null}
              </div>
            ) : activeVars.length < 20 ? (
              <button
                type="button"
                onClick={() => setAdding(true)}
                disabled={saving}
                className={`self-start inline-flex items-center gap-1.5 text-[11.5px] font-medium text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50`}
              >
                <Plus className="size-3.5" />
                Add variable
              </button>
            ) : (
              <p className="text-[11px] text-muted-foreground">
                Smartlead allows at most 20 variables per lead.
              </p>
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 border-t border-border px-4 py-3">
          <button
            type="button"
            onClick={requestClose}
            className={`${
              closeArmed ? `${BTN_BASE} bg-destructive-soft text-destructive hover:opacity-90` : BTN_OUTLINE
            } h-8 px-3 text-[12px]`}
          >
            {closeArmed ? "Discard changes?" : "Cancel"}
          </button>
          <button
            type="button"
            disabled={!dirty || saving}
            onClick={save}
            className={`${BTN_PRIMARY} h-8 px-3 text-[12px]`}
          >
            <Check className="size-3.5" />
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}

function DetailPanel({
  detail,
  baselineOverrides,
  summaryStatus,
  categories,
  aiSettings,
  run,
  pending,
  busyId,
  showToast,
  onStatusChanged,
  onLimitsSaved,
  onGeneralSaved,
  onScheduleSaved,
  onOverridesSaved,
  onDeleted,
  cachedSequence,
  onSequenceLoaded,
  cachedPreviewLead,
  onPreviewLeadLoaded,
  cachedInboxes,
  onInboxesLoaded,
  cachedLeads,
  onLeadsLoaded,
  onAllLeadsLoaded,
  onLeadsInvalidated,
}: {
  detail: CampaignDetail;
  baselineOverrides: CampaignOverrides;
  summaryStatus: string | null;
  categories: ReplyCategory[];
  aiSettings: AiSettings;
  run: (id: string | null, action: () => Promise<ActionResult>) => void;
  pending: boolean;
  busyId: string | null;
  showToast: (ok: boolean, text: string) => void;
  onStatusChanged: (id: string, status: string) => void;
  onLimitsSaved: (
    id: string,
    limits: {
      maxLeadsPerDay?: number | null;
      minTimeBtwnEmails?: number | null;
      followUpPercentage?: number | null;
    },
  ) => void;
  onGeneralSaved: (id: string, patch: Partial<CampaignDetail>) => void;
  onScheduleSaved: (id: string, schedule: CampaignSchedule) => void;
  onOverridesSaved: (id: string, overrides: CampaignOverrides) => void;
  onDeleted: (id: string) => void;
  cachedSequence: SequenceStep[] | undefined;
  onSequenceLoaded: (id: string, steps: SequenceStep[] | null) => void;
  cachedPreviewLead: PreviewLeadData | undefined;
  onPreviewLeadLoaded: (id: string, data: PreviewLeadData) => void;
  cachedInboxes: CampaignInbox[] | undefined;
  onInboxesLoaded: (id: string, inboxes: CampaignInbox[]) => void;
  cachedLeads: { total: number; pages: Record<number, CampaignLeadRow[]>; all?: CampaignLeadRow[] } | undefined;
  onLeadsLoaded: (id: string, total: number, page: number, rows: CampaignLeadRow[]) => void;
  onAllLeadsLoaded: (id: string, total: number, all: CampaignLeadRow[]) => void;
  onLeadsInvalidated: (id: string) => void;
}) {
  const [status, setStatus] = useState<string | null>(summaryStatus ?? detail.status);

  // Which detail section is showing. Fresh mount (keyed per-campaign) opens on
  // "Overview" — the operator clicks a campaign and lands on its stats first,
  // then steps into the other tabs to change settings.
  const [section, setSection] = useState<Section>("overview");

  /* ── Sequence copy (Smartlead truth, not an override) ──────────────────
     Lazy-loaded on first visit to the Sequence section; seeded from the
     root-level per-campaign cache when this panel mounts. `seqBaseline`
     keeps the server's ORIGINAL html per body; `seqDrafts` is the editor
     model (plain text where the body parses, raw html otherwise). Form state
     lives here (not in the section body) so switching sections keeps edits. */
  const [seqBaseline, setSeqBaseline] = useState<SequenceStep[] | null>(cachedSequence ?? null);
  const [seqDrafts, setSeqDrafts] = useState<StepDraft[] | null>(
    cachedSequence ? draftsFromSteps(cachedSequence) : null,
  );
  const [seqError, setSeqError] = useState<string | null>(null);
  const [seqLoading, startSeqLoad] = useTransition();

  const loadSequence = () => {
    setSeqError(null);
    startSeqLoad(async () => {
      const result = await getCampaignSequenceAction(detail.id);
      if (result.ok && result.steps) {
        const steps = [...result.steps].sort((a, b) => a.seqNumber - b.seqNumber);
        setSeqBaseline(steps);
        setSeqDrafts(draftsFromSteps(steps));
        onSequenceLoaded(detail.id, steps);
      } else {
        setSeqError(result.message);
      }
    });
  };

  /* ── Sending inboxes (Smartlead truth, not an override) ────────────────
     Lazy-loaded on first visit to the Inboxes section; seeded from the
     root-level per-campaign cache so switching campaigns and back never
     refetches. */
  const [inboxes, setInboxes] = useState<CampaignInbox[] | null>(cachedInboxes ?? null);
  const [inboxError, setInboxError] = useState<string | null>(null);
  const [inboxLoading, startInboxLoad] = useTransition();
  // Zapmail profile pictures keyed by lowercased from_email (workspace-wide).
  const [inboxAvatars, setInboxAvatars] = useState<Record<string, string>>({});
  const [inboxAvatarsVerified, setInboxAvatarsVerified] = useState(false);

  const loadInboxes = () => {
    setInboxError(null);
    startInboxLoad(async () => {
      const result = await getCampaignInboxesAction(detail.id);
      if (result.ok && result.inboxes) {
        const list = result.inboxes as CampaignInbox[];
        setInboxes(list);
        if (result.avatars) setInboxAvatars(result.avatars);
        setInboxAvatarsVerified(result.avatarsVerified ?? false);
        onInboxesLoaded(detail.id, list);
      } else {
        setInboxError(result.message);
      }
    });
  };

  /* ── Leads (Smartlead truth, not an override) ──────────────────────────
     Lazy-loaded on first visit to the Leads section, page 0 first; seeded
     from the root-level per-campaign cache (total + per-page rows) so page
     flips and revisits after switching campaigns hit the cache, never the
     network. `leadsTotal === null` means "never loaded" — the trigger the
     section switcher and the initial loading/error states key off. */
  const [leadsTotal, setLeadsTotal] = useState<number | null>(cachedLeads?.total ?? null);
  const [leadsPages, setLeadsPages] = useState<Record<number, CampaignLeadRow[]>>(
    cachedLeads?.pages ?? {},
  );
  const [leadsPage, setLeadsPage] = useState(0);
  const [leadsError, setLeadsError] = useState<string | null>(null);
  const [leadsLoading, startLeadsLoad] = useTransition();
  const [leadsFilter, setLeadsFilter] = useState("");

  /* ── Load-all leads (client-side global refine) ────────────────────────
     A worker pool walks the campaign's leads in maximum-size chunks so the
     toolbar's search / status / sort can run over the WHOLE set instead of
     just the current 50-row page. `allLeads === null` means "not loaded";
     seeded from the root cache so a revisit is instant. The abort ref is set
     on unmount (campaign switch) — an in-flight loop then discards its
     partial results. */
  const [allLeads, setAllLeads] = useState<CampaignLeadRow[] | null>(cachedLeads?.all ?? null);
  const [loadAllState, setLoadAllState] = useState<"idle" | "loading" | "error">("idle");
  const [loadAllCount, setLoadAllCount] = useState(0);
  // Generation counter, not a boolean: every cache invalidation (unmount, add,
  // remove) bumps it so an in-flight load-all that finishes later discards its
  // pre-mutation snapshot instead of resurrecting it.
  const loadAllGeneration = useRef(0);
  useEffect(
    () => () => {
      loadAllGeneration.current += 1;
    },
    [],
  );

  const loadAllLeads = () => {
    const total = leadsTotal ?? 0;
    if (total <= 0) return;
    const generation = loadAllGeneration.current;
    setLoadAllState("loading");
    setLoadAllCount(0);

    // Offset queue (0, 100, 200, …) drained by a fixed pool of workers; each
    // result is stored by its offset so the final concat is in lead order.
    const offsets: number[] = [];
    for (let off = 0; off < total; off += LEADS_BULK_CHUNK) offsets.push(off);
    const chunks = new Map<number, CampaignLeadRow[]>();
    let cursor = 0;
    let fetched = 0;
    let failed = false;
    let resolvedTotal = total;

    // Claiming an offset (read + increment) has no await between the two, so
    // each worker takes a distinct offset even though they run concurrently.
    const runWorker = async (): Promise<void> => {
      while (cursor < offsets.length && loadAllGeneration.current === generation && !failed) {
        const off = offsets[cursor];
        cursor += 1;
        const result = await getCampaignLeadsChunkAction(detail.id, off);
        if (loadAllGeneration.current !== generation) return;
        if (!result.ok || !result.leads) {
          if (!failed) {
            failed = true;
            setLoadAllState("error");
            showToast(false, result.message || "Couldn't load all leads.");
          }
          return;
        }
        chunks.set(off, result.leads);
        if (typeof result.total === "number") resolvedTotal = result.total;
        fetched += result.leads.length;
        setLoadAllCount(fetched);
      }
    };

    void (async () => {
      const workerCount = Math.min(LEADS_LOAD_ALL_CONCURRENCY, offsets.length);
      await Promise.all(Array.from({ length: workerCount }, () => runWorker()));
      if (loadAllGeneration.current !== generation || failed) return;
      const merged: CampaignLeadRow[] = [];
      for (const off of offsets) {
        const rows = chunks.get(off);
        if (rows) merged.push(...rows);
      }
      const syncedTotal = Math.max(resolvedTotal, merged.length);
      setAllLeads(merged);
      setLeadsTotal(syncedTotal);
      setLoadAllState("idle");
      onAllLeadsLoaded(detail.id, syncedTotal, merged);
    })();
  };

  const loadLeadsPage = (page: number) => {
    setLeadsError(null);
    startLeadsLoad(async () => {
      const result = await getCampaignLeadsAction(detail.id, page);
      if (result.ok && result.leads) {
        const rows = result.leads;
        const total = result.total ?? 0;
        setLeadsTotal(total);
        setLeadsPages((prev) => ({ ...prev, [page]: rows }));
        onLeadsLoaded(detail.id, total, page, rows);
      } else {
        setLeadsError(result.message);
      }
    });
  };

  // Page flips hit the cache first, else fetch that page with the section's
  // loading idiom (the table body shows an inline spinner while it arrives).
  const goToLeadsPage = (page: number) => {
    setLeadsPage(page);
    if (!leadsPages[page] && !leadsLoading) loadLeadsPage(page);
  };

  // A saved lead edit patches the row in place (matched by mapId) on the
  // current page and pushes the patched page through the root cache — the same
  // no-refetch contract the page loader uses.
  const patchLead = (updated: CampaignLeadRow) => {
    const current = leadsPages[leadsPage];
    if (current) {
      const next = current.map((row) => (row.mapId === updated.mapId ? updated : row));
      setLeadsPages((prev) => ({ ...prev, [leadsPage]: next }));
      onLeadsLoaded(detail.id, leadsTotal ?? next.length, leadsPage, next);
    }
    // When the full set is loaded, edits must show everywhere the global
    // refine reads from — patch it (and the cache's `all`) by mapId too.
    if (allLeads) {
      const nextAll = allLeads.map((row) => (row.mapId === updated.mapId ? updated : row));
      setAllLeads(nextAll);
      onAllLeadsLoaded(detail.id, leadsTotal ?? nextAll.length, nextAll);
    }
  };

  /* ── Lead lifecycle (pause / resume / unsubscribe / category / remove) ──
     Reply categories load once, lazily (first row with a category or first
     menu open). Each mutation runs through the shared run/busyId idiom for
     per-row busy state and, on ok, patches BOTH caches coherently: every
     loaded page and the load-all set, with the root mirror kept in step. */
  const [leadCategories, setLeadCategories] = useState<LeadCategory[] | null>(null);
  const [categoriesLoading, startCategoriesLoad] = useTransition();
  const categoriesRequested = useRef(false);
  const ensureLeadCategories = () => {
    if (categoriesRequested.current || leadCategories) return;
    categoriesRequested.current = true;
    startCategoriesLoad(async () => {
      const result = await getSmartleadCategoriesAction();
      if (result.ok && result.categories) {
        setLeadCategories(result.categories as LeadCategory[]);
      } else {
        categoriesRequested.current = false; // allow a later retry
      }
    });
  };

  // Which row (if any) is mid-mutation, from the shared run/busyId idiom.
  const busyLeadMapId =
    pending && busyId && busyId.startsWith("lead:") ? busyId.slice("lead:".length) : null;

  /* Two row mutations can resolve between renders; building each patch from
     the render closure would let the second clobber the first. Mutations
     compound through `leadCachesPending` (the latest written value), which an
     effect clears once committed state has caught up. */
  const leadCachesPending = useRef<{
    pages: Record<number, CampaignLeadRow[]>;
    all: CampaignLeadRow[] | null;
    total: number | null;
  } | null>(null);
  useEffect(() => {
    leadCachesPending.current = null;
  }, [leadsPages, allLeads, leadsTotal]);

  const mutateLeadCaches = (
    fn: (base: {
      pages: Record<number, CampaignLeadRow[]>;
      all: CampaignLeadRow[] | null;
      total: number | null;
    }) => {
      pages: Record<number, CampaignLeadRow[]>;
      all: CampaignLeadRow[] | null;
      total: number | null;
    },
  ) => {
    const base = leadCachesPending.current ?? { pages: leadsPages, all: allLeads, total: leadsTotal };
    const next = fn(base);
    leadCachesPending.current = next;
    setLeadsPages(next.pages);
    setAllLeads(next.all);
    setLeadsTotal(next.total);
    const total = next.total ?? 0;
    for (const [key, pageRows] of Object.entries(next.pages)) onLeadsLoaded(detail.id, total, Number(key), pageRows);
    if (next.all) onAllLeadsLoaded(detail.id, total, next.all);
  };

  // Patch one row across every loaded page and the load-all set (matched by
  // mapId), syncing the root cache so a campaign switch and back stays true.
  const applyRowPatch = (mapId: string, patch: Partial<CampaignLeadRow>) => {
    const patchRows = (rows: CampaignLeadRow[]) =>
      rows.map((row) => (row.mapId === mapId ? { ...row, ...patch } : row));
    mutateLeadCaches((base) => ({
      pages: Object.fromEntries(
        Object.entries(base.pages).map(([key, pageRows]) => [key, patchRows(pageRows)]),
      ),
      all: base.all ? patchRows(base.all) : base.all,
      total: base.total,
    }));
  };

  // Drop a removed row. The page in view is spliced for instant feedback, but
  // every other cached page holds stale server offsets after a removal, so
  // they are dropped (root cache included) and page mode refetches in place.
  const applyRowRemove = (mapId: string) => {
    loadAllGeneration.current += 1;
    onLeadsInvalidated(detail.id);
    let nextTotal = 0;
    mutateLeadCaches((base) => {
      nextTotal = Math.max(0, (base.total ?? 1) - 1);
      const current = base.pages[leadsPage];
      return {
        pages: current ? { [leadsPage]: current.filter((row) => row.mapId !== mapId) } : {},
        all: base.all ? base.all.filter((row) => row.mapId !== mapId) : base.all,
        total: nextTotal,
      };
    });
    if (!allLeads) {
      const lastPage = Math.max(0, Math.ceil(nextTotal / LEADS_PAGE_SIZE) - 1);
      const target = Math.min(leadsPage, lastPage);
      if (target !== leadsPage) setLeadsPage(target);
      loadLeadsPage(target);
    }
  };

  const pauseLeadRow = (row: CampaignLeadRow) => {
    if (!row.leadId) return;
    const leadId = row.leadId;
    run(`lead:${row.mapId}`, async () => {
      const result = await pauseCampaignLeadAction(detail.id, leadId);
      if (result.ok) applyRowPatch(row.mapId, { status: "PAUSED" });
      return result;
    });
  };
  const resumeLeadRow = (row: CampaignLeadRow) => {
    if (!row.leadId) return;
    const leadId = row.leadId;
    run(`lead:${row.mapId}`, async () => {
      const result = await resumeCampaignLeadAction(detail.id, leadId);
      if (result.ok) applyRowPatch(row.mapId, { status: "STARTED" });
      return result;
    });
  };
  const unsubscribeLeadRow = (row: CampaignLeadRow) => {
    if (!row.leadId) return;
    const leadId = row.leadId;
    run(`lead:${row.mapId}`, async () => {
      const result = await unsubscribeCampaignLeadAction(detail.id, leadId);
      if (result.ok) applyRowPatch(row.mapId, { unsubscribed: true });
      return result;
    });
  };
  const setLeadCategoryRow = (row: CampaignLeadRow, categoryId: number) => {
    if (!row.leadId) return;
    const leadId = row.leadId;
    run(`lead:${row.mapId}`, async () => {
      const result = await setCampaignLeadCategoryAction(detail.id, leadId, categoryId, false);
      if (result.ok) applyRowPatch(row.mapId, { categoryId });
      return result;
    });
  };
  const removeLeadRow = (row: CampaignLeadRow) => {
    if (!row.leadId) return;
    const leadId = row.leadId;
    run(`lead:${row.mapId}`, async () => {
      const result = await removeCampaignLeadAction(detail.id, leadId);
      if (result.ok) applyRowRemove(row.mapId);
      return result;
    });
  };

  // Adding leads can shift counts and every page, so the simplest coherent
  // path clears both caches for this campaign and re-fetches the page in view.
  // leadsTotal is kept so the Leads section (and the modal showing the summary)
  // stay mounted while the current page reloads.
  const submitAddLeads = async (leads: AddLeadInput[]): Promise<ActionResult> => {
    const result = await addCampaignLeadsAction(detail.id, leads);
    if (result.ok) {
      loadAllGeneration.current += 1;
      onLeadsInvalidated(detail.id);
      setAllLeads(null);
      setLeadsPages({});
      setLoadAllState("idle");
      setLoadAllCount(0);
      loadLeadsPage(leadsPage);
    }
    return { ok: result.ok, message: result.message };
  };

  /* ── Inbox management (add / remove) ───────────────────────────────────
     The add panel lazily loads the full workspace roster (same action the
     wizard uses) and offers the inboxes NOT already assigned. Mutations
     never touch local state optimistically: they re-fetch this section's
     list on ok and sync the per-campaign cache. Per-control busy comes from
     the shared run/busyId idiom (like the sequence/limits/overrides saves). */
  const [addOpen, setAddOpen] = useState(false);
  const [roster, setRoster] = useState<CampaignInbox[] | null>(null);
  const [rosterError, setRosterError] = useState<string | null>(null);
  const [rosterLoading, startRosterLoad] = useTransition();
  const [addSelected, setAddSelected] = useState<Set<number>>(new Set());
  const [removeConfirmId, setRemoveConfirmId] = useState<number | null>(null);

  const addingInboxes = pending && busyId === `inbox-add:${detail.id}`;
  const removingInboxes = pending && busyId === `inbox-remove:${detail.id}`;
  const mutatingInboxes = addingInboxes || removingInboxes;

  const loadRoster = () => {
    setRosterError(null);
    startRosterLoad(async () => {
      const result = await listInboxAccountsAction();
      if (result.ok && result.inboxes) {
        setRoster(result.inboxes as CampaignInbox[]);
        // Roster rows may include inboxes the campaign map hasn't seen.
        if (result.avatars) setInboxAvatars((prev) => ({ ...prev, ...result.avatars }));
        if (result.avatarsVerified) setInboxAvatarsVerified(true);
      } else {
        setRosterError(result.message);
      }
    });
  };

  const openAddPanel = () => {
    setAddSelected(new Set());
    setAddOpen(true);
    if (roster === null && !rosterLoading) loadRoster();
  };
  const closeAddPanel = () => {
    setAddOpen(false);
    setAddSelected(new Set());
  };
  const toggleAddInbox = (id: number) =>
    setAddSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  // Re-fetch the assigned inboxes after a mutation and sync the root cache.
  const refreshInboxes = async () => {
    const refetched = await getCampaignInboxesAction(detail.id);
    if (refetched.ok && refetched.inboxes) {
      const list = refetched.inboxes as CampaignInbox[];
      setInboxes(list);
      onInboxesLoaded(detail.id, list);
    }
  };

  const confirmAddInboxes = () => {
    if (addSelected.size === 0) return;
    const ids = [...addSelected];
    run(`inbox-add:${detail.id}`, async () => {
      const result = await addCampaignInboxesAction(detail.id, ids);
      if (result.ok) {
        await refreshInboxes();
        closeAddPanel();
      }
      return result;
    });
  };
  const removeInbox = (id: number) =>
    run(`inbox-remove:${detail.id}`, async () => {
      const result = await removeCampaignInboxesAction(detail.id, [id]);
      if (result.ok) {
        setRemoveConfirmId(null);
        await refreshInboxes();
      }
      return result;
    });

  // Roster inboxes not already assigned to this campaign — the add candidates.
  const assignedInboxIds = new Set((inboxes ?? []).map((inbox) => inbox.id));
  const addableInboxes = (roster ?? []).filter((inbox) => !assignedInboxIds.has(inbox.id));

  // Switching to a lazily-loaded section for the first time triggers its load.
  const switchSection = (next: Section) => {
    setSection(next);
    if (next === "sequence" && seqBaseline === null && !seqLoading) loadSequence();
    if (next === "inboxes" && inboxes === null && !inboxLoading) loadInboxes();
    if (next === "leads" && leadsTotal === null && !leadsLoading) loadLeadsPage(leadsPage);
  };

  // Copy-only editing: ids and seqNumbers are never touched.
  const patchStepDraft = (index: number, draftPatch: Partial<StepDraft>) =>
    setSeqDrafts((prev) =>
      prev ? prev.map((draft, i) => (i === index ? { ...draft, ...draftPatch } : draft)) : prev,
    );
  const patchStepBody = (index: number, value: string) =>
    setSeqDrafts((prev) =>
      prev
        ? prev.map((draft, i) =>
            i === index && draft.body ? { ...draft, body: { ...draft.body, value } } : draft,
          )
        : prev,
    );
  const patchVariantDraft = (
    stepIndex: number,
    variantIndex: number,
    variantPatch: { subject?: string; bodyValue?: string },
  ) =>
    setSeqDrafts((prev) =>
      prev
        ? prev.map((draft, i) => {
            if (i !== stepIndex || !draft.variants) return draft;
            return {
              ...draft,
              variants: draft.variants.map((variant, j) =>
                j === variantIndex
                  ? {
                      ...variant,
                      subject:
                        variantPatch.subject !== undefined ? variantPatch.subject : variant.subject,
                      body:
                        variantPatch.bodyValue !== undefined
                          ? { ...variant.body, value: variantPatch.bodyValue }
                          : variant.body,
                    }
                  : variant,
              ),
            };
          })
        : prev,
    );

  // Variant (A/B) edits. A step is either a single body OR a list of variants;
  // splitting converts the body into variant A plus a copy as B, and removing
  // the last-but-one variant collapses back to a single body. New variants have
  // a null id (Smartlead assigns one on save); labels stay contiguous A, B, C.
  const splitStepIntoVariants = (index: number) =>
    setSeqDrafts((prev) =>
      prev
        ? prev.map((draft, i) => {
            if (i !== index || draft.variants || !draft.body) return draft;
            const a: VariantDraft = { id: null, label: "A", subject: draft.subject, body: draft.body };
            const b: VariantDraft = { id: null, label: "B", subject: draft.subject, body: { ...draft.body } };
            return { ...draft, body: null, variants: [a, b] };
          })
        : prev,
    );
  const addVariantToStep = (index: number) =>
    setSeqDrafts((prev) =>
      prev
        ? prev.map((draft, i) => {
            if (i !== index || !draft.variants || draft.variants.length >= MAX_VARIANTS) return draft;
            const base = draft.variants[0];
            const next: VariantDraft = {
              id: null,
              label: String.fromCharCode(65 + draft.variants.length),
              subject: base.subject,
              body: { ...base.body },
            };
            return { ...draft, variants: [...draft.variants, next] };
          })
        : prev,
    );
  const removeVariantFromStep = (index: number, variantIndex: number) =>
    setSeqDrafts((prev) =>
      prev
        ? prev.map((draft, i) => {
            if (i !== index || !draft.variants) return draft;
            const remaining = draft.variants.filter((_, j) => j !== variantIndex);
            if (remaining.length <= 1) {
              const only = remaining[0] ?? draft.variants[0];
              return { ...draft, variants: null, subject: only.subject, body: only.body };
            }
            return {
              ...draft,
              variants: remaining.map((variant, j) => ({ ...variant, label: String.fromCharCode(65 + j) })),
            };
          })
        : prev,
    );

  // Structural edits — the array order is truth, so every op renumbers
  // seqNumber to index + 1 while ids/subjects/bodies/delays travel with content.
  const addStep = () =>
    setSeqDrafts((prev) => {
      if (!prev || prev.length >= MAX_SEQUENCE_STEPS) return prev;
      return [...prev, newStepDraft(prev.length + 1)];
    });
  const removeStep = (index: number) =>
    setSeqDrafts((prev) => {
      if (!prev || prev.length <= 1) return prev;
      return renumberSteps(prev.filter((_, i) => i !== index));
    });
  const moveStep = (index: number, direction: -1 | 1) =>
    setSeqDrafts((prev) => {
      if (!prev) return prev;
      const target = index + direction;
      if (target < 0 || target >= prev.length) return prev;
      const next = [...prev];
      [next[index], next[target]] = [next[target], next[index]];
      return renumberSteps(next);
    });

  // Dirty = any per-step content change (via draftIsDirty), OR the composition
  // changed: a different number of steps, or the ordered ids diverge from the
  // baseline (a reorder even when every body is untouched).
  const seqDirty =
    seqBaseline !== null &&
    seqDrafts !== null &&
    (seqDrafts.length !== seqBaseline.length ||
      seqDrafts.some(
        (draft, i) =>
          (draft.origin?.id ?? null) !== (seqBaseline[i]?.id ?? null) || draftIsDirty(draft),
      ));
  const savingSequence = pending && busyId === `seq:${detail.id}`;

  /* FIDELITY CONTRACT: an untouched body sends the ORIGINAL html string
     byte-for-byte; only a genuinely edited text body is re-encoded; a raw
     body goes exactly as typed. */
  const bodyHtmlForSave = (originalHtml: string, body: BodyDraft): string => {
    if (body.mode === "raw") return body.value;
    if (body.value === body.baseline) return originalHtml; // untouched → byte-identical
    return textToSequenceHtml(body.value);
  };

  const saveSequence = () => {
    if (!seqDirty || !seqBaseline || !seqDrafts) return;

    // Inline validation (existing toast idiom): email 1 always needs a subject,
    // and a brand-new step (or any variant) can't be saved with an empty body.
    const fail = (message: string) => run(`seq:${detail.id}`, async () => ({ ok: false, message }));
    for (let i = 0; i < seqDrafts.length; i += 1) {
      const draft = seqDrafts[i];
      if (draft.variants && draft.variants.length > 0) {
        for (let vi = 0; vi < draft.variants.length; vi += 1) {
          const variant = draft.variants[vi];
          const label = variant.label?.trim() || String.fromCharCode(65 + vi);
          if (i === 0 && !variant.subject.trim()) {
            fail(`Email 1, variant ${label}, needs a subject line.`);
            return;
          }
          if (!variant.body.value.trim()) {
            fail(`Email ${i + 1}, variant ${label}, needs body text.`);
            return;
          }
        }
        continue;
      }
      if (i === 0 && !draft.subject.trim()) {
        fail("Email 1 needs a subject line.");
        return;
      }
      if (draft.origin === null && !(draft.body?.value ?? "").trim()) {
        fail(`Email ${i + 1} needs body text before you can save.`);
        return;
      }
    }

    const steps: SequenceStep[] = seqDrafts.map((draft, index) => {
      const seqNumber = index + 1;
      const origin = draft.origin;
      const id = origin?.id ?? null;

      // Variant step (existing variants, or a body just split into A/B). The
      // DRAFT's structure is truth — not the origin's — so added/removed/relabeled
      // variants persist. A variant's id is matched back by id (survives reorder);
      // a new variant (id null) gets its bytes freshly encoded and a real id from
      // Smartlead on save.
      if (draft.variants && draft.variants.length > 0) {
        const originVariant = (variantId: number | null) =>
          variantId !== null ? origin?.variants?.find((v) => v.id === variantId) ?? null : null;
        const variantHtml = (vd: VariantDraft): string => {
          const ov = originVariant(vd.id);
          return ov ? bodyHtmlForSave(ov.emailBody, vd.body) : textToSequenceHtml(vd.body.value);
        };
        const variants: SequenceVariant[] = draft.variants.map((vd) => ({
          id: vd.id,
          label: vd.label,
          subject: vd.subject,
          emailBody: variantHtml(vd),
        }));
        const originHadVariants = Boolean(origin?.variants && origin.variants.length > 0);
        return {
          id,
          seqNumber,
          delayInDays: draft.delayInDays,
          // Smartlead keeps a step-level subject/body next to the variants;
          // preserve the original for an existing variant step, otherwise mirror
          // variant A so a freshly-split step has a sensible top level.
          subject: origin && originHadVariants ? origin.subject : variants[0].subject,
          emailBody: origin && originHadVariants ? origin.emailBody : variants[0].emailBody,
          variants,
        };
      }

      // Single-body step (new, edited, or collapsed back down from variants).
      const body = draft.body ?? { mode: "text" as const, baseline: "", value: "" };
      const originWasSingle = origin !== null && !(origin.variants && origin.variants.length > 0);
      return {
        id,
        seqNumber,
        delayInDays: draft.delayInDays,
        subject: draft.subject,
        emailBody: originWasSingle ? bodyHtmlForSave(origin.emailBody, body) : textToSequenceHtml(body.value),
        variants: null,
      };
    });

    run(`seq:${detail.id}`, async () => {
      const result = await saveCampaignSequenceAction(detail.id, steps);
      if (result.ok) {
        // Re-fetch so server-assigned ids land on the newly-created steps.
        let refetched = await getCampaignSequenceAction(detail.id);
        if (!(refetched.ok && refetched.steps)) refetched = await getCampaignSequenceAction(detail.id);
        if (refetched.ok && refetched.steps) {
          const fresh = [...refetched.steps].sort((a, b) => a.seqNumber - b.seqNumber);
          setSeqBaseline(fresh);
          setSeqDrafts(draftsFromSteps(fresh));
          onSequenceLoaded(detail.id, fresh);
        } else if (steps.some((step) => step.id === null || (step.variants?.some((v) => v.id === null) ?? false))) {
          // The save landed but we could not learn the Smartlead ids of a new
          // step or a new variant. Adopting the sent payload as a clean baseline
          // would make the NEXT save re-create them (ids upload by absence) — so
          // drop the sequence state entirely and force a reload before editing.
          setSeqBaseline(null);
          setSeqDrafts(null);
          onSequenceLoaded(detail.id, null);
          setEditorStep(null);
          return {
            ok: true,
            message: "Sequence saved, but it could not be reloaded. Reopen the sequence before editing again.",
          };
        } else {
          // No new steps were created, so the sent payload (all real ids,
          // original bytes preserved) is a faithful baseline.
          setSeqBaseline(steps);
          setSeqDrafts(draftsFromSteps(steps));
          onSequenceLoaded(detail.id, steps);
        }
      }
      return result;
    });
  };
  const cancelSequence = () => setSeqDrafts(seqBaseline ? draftsFromSteps(seqBaseline) : null);

  /* ── Full-screen sequence editor ───────────────────────────────────────
     null = closed; a number opens the takeover focused on that step. The
     editor is a view over seqDrafts/seqBaseline — the summary list and the
     takeover share one source of truth. */
  const [editorStep, setEditorStep] = useState<number | null>(null);

  /* A campaign created here starts with NO sequence, and the editor renders a
     step at a time — so opening it on an empty draft list has nothing to show.
     Seed email 1 first, then open. Discarding restores the empty baseline, and
     the length guard on the takeover stays as the backstop. */
  const openSequenceEditor = (step: number) => {
    if (seqDrafts && seqDrafts.length === 0) setSeqDrafts([newStepDraft(1)]);
    setEditorStep(step);
  };

  // Real lead data (like Smartlead's own preview) — fetched once per
  // campaign, when the editor's live preview first needs it; root-cached.
  const [previewLead, setPreviewLead] = useState<PreviewLeadData | null>(cachedPreviewLead ?? null);
  const [previewLeadLoading, startPreviewLeadLoad] = useTransition();
  const loadPreviewLead = () => {
    startPreviewLeadLoad(async () => {
      const result = await getCampaignPreviewLeadAction(detail.id);
      // `computed` (sl_day_of_the_week etc.) comes back even when ok is false
      // or the campaign has no populated leads — always use it.
      const data: PreviewLeadData = {
        label: result.lead?.label ?? null,
        values: { ...(result.computed ?? {}), ...(result.lead?.values ?? {}) },
      };
      setPreviewLead(data);
      onPreviewLeadLoaded(detail.id, data);
    });
  };
  const ensurePreviewLead = () => {
    if (previewLead === null && !previewLeadLoading) loadPreviewLead();
  };
  // The editor's lead picker hands back a fully-merged PreviewLeadData
  // (computed tags + the picked lead's values) — store it through the same
  // state + root-cache path the loader uses, so the choice sticks for the
  // campaign until the panel is reopened.
  const selectPreviewLead = (data: PreviewLeadData) => {
    setPreviewLead(data);
    onPreviewLeadLoaded(detail.id, data);
  };
  // The Sequence tab's check rail needs the preview lead too (its known-token
  // set) — load it on any visit, not just when the editor opens.
  useEffect(() => {
    if (section === "sequence") ensurePreviewLead();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [section]);

  // Per-category disclosure state for guidance editing (UI only).
  const [guidanceOpen, setGuidanceOpen] = useState<Record<string, boolean>>({});
  const toggleGuidance = (value: string) =>
    setGuidanceOpen((prev) => ({ ...prev, [value]: !prev[value] }));

  // Override form + baseline (this component is remounted per-campaign via key,
  // so a fresh mount seeds cleanly from props).
  const [baseline, setBaseline] = useState<CampaignOverrides>(baselineOverrides);
  const [form, setForm] = useState<CampaignOverrides>(baselineOverrides);

  // Campaign description (AI context) — the Campaign tab's editing surface for
  // overrides.campaignContext (the only one; the Reply tab no longer edits it).
  // Saved as a single-field patch — updateCampaignOverrides MERGES per field
  // (null deletes the key), so sibling overrides are never touched — with
  // form/baseline kept in sync so the Reply tab's dirty diff never re-sends it.
  const [description, setDescription] = useState(baselineOverrides.campaignContext ?? "");
  const [descriptionBaseline, setDescriptionBaseline] = useState(description);
  const descriptionDirty = description !== descriptionBaseline;
  const savingDescription = pending && busyId === `desc:${detail.id}`;
  const saveDescription = () => {
    if (!descriptionDirty) return;
    const trimmed = description.trim();
    const value = trimmed || null;
    run(`desc:${detail.id}`, async () => {
      const result = await updateCampaignOverridesAction(detail.id, { campaignContext: value });
      if (result.ok) {
        setDescription(trimmed);
        setDescriptionBaseline(trimmed);
        setForm((prev) => ({ ...prev, campaignContext: value }));
        setBaseline((prev) => ({ ...prev, campaignContext: value }));
        onOverridesSaved(detail.id, { ...baseline, campaignContext: value });
      }
      return result;
    });
  };
  const cancelDescription = () => setDescription(descriptionBaseline);

  // Limits form (strings so a partially-cleared field is representable).
  const numToStr = (n: number | null) => (n === null ? "" : String(n));
  const [limits, setLimits] = useState({
    maxLeadsPerDay: numToStr(detail.maxLeadsPerDay),
    minTimeBtwnEmails: numToStr(detail.minTimeBtwnEmails),
    followUpPercentage: numToStr(detail.followUpPercentage),
  });
  const [limitsBaseline, setLimitsBaseline] = useState(limits);

  // General settings form (name, stop-lead trigger, plain text, unsubscribe
  // text) — seeded from the detail, saved as a dirty diff.
  const [general, setGeneral] = useState({
    name: detail.name,
    stopLeadSettings: normalizeStopLead(detail.stopLeadSettings),
    sendAsPlainText: detail.sendAsPlainText,
    unsubscribeText: detail.unsubscribeText,
    trackOpens: detail.tracking.opens,
    trackClicks: detail.tracking.clicks,
  });
  const [generalBaseline, setGeneralBaseline] = useState(general);

  // Schedule window form (timezone, sending days, hours) — prefilled from the
  // detail's schedule, or the wizard defaults when the campaign has none yet.
  const [scheduleZones] = useState<string[]>(() =>
    scheduleZoneChoices(detail.schedule?.timezone ?? null),
  );
  const [schedule, setSchedule] = useState({
    timezone: detail.schedule?.timezone ?? scheduleZones[0] ?? "America/New_York",
    days: detail.schedule?.daysOfTheWeek ?? [1, 2, 3, 4, 5],
    startHour: detail.schedule?.startHour ?? "09:00",
    endHour: detail.schedule?.endHour ?? "17:00",
  });
  const [scheduleBaseline, setScheduleBaseline] = useState(schedule);

  // Campaign Overview (analytics) — loaded lazily on the first visit to the
  // Overview tab (which is the default section, so effectively on mount). Its
  // own transition keeps the passive analytics fetch off the shared busy/run
  // path; the loaded value is cached in state so tab flips never refetch (this
  // panel is keyed per campaign, so a plain useState cache is enough).
  const [overview, setOverview] = useState<CampaignOverview | null>(null);
  const [overviewError, setOverviewError] = useState<string | null>(null);
  const [overviewLoading, startOverviewLoad] = useTransition();
  const overviewRequested = useRef(false);
  const loadOverview = () => {
    setOverviewError(null);
    startOverviewLoad(async () => {
      try {
        const result = await getCampaignOverviewAction(detail.id);
        if (result.ok && result.overview) setOverview(result.overview);
        else setOverviewError(result.message);
      } catch {
        // A transport failure must land on the inline Retry line, not the
        // route error boundary (this tab is the default landing view).
        setOverviewError("Could not load campaign analytics. Check your connection and retry.");
      }
    });
  };
  useEffect(() => {
    if (section === "overview" && !overviewRequested.current) {
      overviewRequested.current = true;
      loadOverview();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [section]);

  // Campaign insights (Overview right rail) — same lazy-load idiom as the
  // analytics above: fetched once on the first Overview visit, cached in
  // state, transport failures land on the rail's inline Retry line.
  const [insights, setInsights] = useState<CampaignInsights | null>(null);
  const [insightsError, setInsightsError] = useState<string | null>(null);
  const [insightsLoading, startInsightsLoad] = useTransition();
  const insightsRequested = useRef(false);

  // Brief generation shares one pending flag (auto-refresh, Regenerate, and
  // the post-model-change rebuild are mutually exclusive). The panel is keyed
  // per campaign, so an unmount simply drops any in-flight result.
  const [briefPending, setBriefPending] = useState(false);
  const [briefError, setBriefError] = useState<string | null>(null);
  const [briefNote, setBriefNote] = useState<string | null>(null);
  const briefAutoRequested = useRef(false);
  const briefNoteTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (briefNoteTimer.current) clearTimeout(briefNoteTimer.current);
  }, []);
  const flashBriefNote = (message: string) => {
    setBriefNote(message);
    if (briefNoteTimer.current) clearTimeout(briefNoteTimer.current);
    briefNoteTimer.current = setTimeout(() => setBriefNote(null), 6000);
  };
  const runBriefGeneration = async (force: boolean) => {
    setBriefPending(true);
    setBriefError(null);
    try {
      const result = await generateCampaignBriefAction(detail.id, force);
      if (result.cooldown) {
        // A blocked force keeps the existing brief; only surface the why.
        flashBriefNote(result.error ?? "Please wait two minutes before regenerating.");
      } else if (result.error) {
        setBriefError(result.error);
      } else if (result.brief) {
        const brief = result.brief;
        setInsights((prev) =>
          prev === null
            ? prev
            : {
                ...prev,
                brief,
                briefMeta: { generatedAt: result.generatedAt, model: result.model, dirty: false },
              },
        );
      }
    } catch {
      setBriefError("Could not update the brief. Check your connection and retry.");
    } finally {
      setBriefPending(false);
    }
  };
  const loadInsights = () => {
    setInsightsError(null);
    startInsightsLoad(async () => {
      try {
        const result = await getCampaignInsightsAction(detail.id);
        setInsights(result);
        // Opportunistic refresh: when the cached brief is missing or stale,
        // let the server decide whether to rebuild (non-forced, so it's
        // cheap). Once per panel; a reload after that changes nothing.
        if (!briefAutoRequested.current && (result.brief === null || result.briefMeta.dirty)) {
          briefAutoRequested.current = true;
          void runBriefGeneration(false);
        }
      } catch {
        setInsightsError("Could not load campaign insights. Check your connection and retry.");
      }
    });
  };
  useEffect(() => {
    if (section === "overview" && !insightsRequested.current) {
      insightsRequested.current = true;
      loadInsights();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [section]);

  // Reply webhook status — loaded lazily on the first visit to the Campaign tab.
  // Its own transition keeps the passive status check off the shared busy/run
  // path.
  type ReplyWebhookStatusView = { registered: boolean; name: string | null; url: string | null };
  const [webhookStatus, setWebhookStatus] = useState<ReplyWebhookStatusView | null>(null);
  const [webhookError, setWebhookError] = useState<string | null>(null);
  const [webhookLoading, startWebhookLoad] = useTransition();
  const webhookRequested = useRef(false);
  const loadWebhookStatus = () => {
    setWebhookError(null);
    startWebhookLoad(async () => {
      const result = await getReplyWebhookStatusAction(detail.id);
      if (result.ok && result.status) setWebhookStatus(result.status);
      else setWebhookError(result.message);
    });
  };
  useEffect(() => {
    if (section === "campaign" && !webhookRequested.current) {
      webhookRequested.current = true;
      loadWebhookStatus();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [section]);

  // Two-click confirm for pausing a running campaign.
  const [pauseArmed, setPauseArmed] = useState(false);
  const pauseTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (pauseTimer.current) clearTimeout(pauseTimer.current);
  }, []);

  // Inline confirm for deleting a drafted campaign (sign-out popover idiom).
  const [deleteDraftConfirm, setDeleteDraftConfirm] = useState(false);
  const deletingDraft = pending && busyId === `del:${detail.id}`;
  const isDrafted = (status ?? "").toUpperCase() === "DRAFTED";
  const confirmDeleteDraft = () => {
    setDeleteDraftConfirm(false);
    run(`del:${detail.id}`, async () => {
      const result = await deleteCampaignAction(detail.id);
      if (result.ok) onDeleted(detail.id);
      return result;
    });
  };

  const setField = <K extends keyof CampaignOverrides>(key: K, value: CampaignOverrides[K]) =>
    setForm((prev) => ({ ...prev, [key]: value }));

  const overridden = (key: (typeof OVERRIDE_SCALAR_KEYS)[number]) => {
    const v = form[key];
    return v !== undefined && v !== null;
  };
  const identityOverridden =
    overridden("senderName") || overridden("senderTitle") || overridden("senderCompany");
  const stylesOverridden = form.styleExamples !== undefined && form.styleExamples !== null;

  /* Build the patch: only changed fields, with an explicit null for anything
     reset to default. */
  const patch: CampaignOverrides = {};
  OVERRIDE_SCALAR_KEYS.forEach((key) => {
    const a = form[key] ?? null;
    const b = baseline[key] ?? null;
    if (a !== b) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (patch as any)[key] = a;
    }
  });
  // Drop modules whose reply is still empty (unusable examples) at save time.
  const formExamples =
    form.styleExamples === undefined || form.styleExamples === null
      ? null
      : form.styleExamples.filter((example) => example.reply.trim().length > 0);
  const baseExamples = baseline.styleExamples ?? null;
  if (JSON.stringify(formExamples) !== JSON.stringify(baseExamples)) {
    patch.styleExamples = formExamples;
  }
  const formCats = cleanCategories(form.categories);
  const baseCats = cleanCategories(baseline.categories);
  if (JSON.stringify(formCats) !== JSON.stringify(baseCats)) {
    patch.categories = formCats;
  }
  const overridesDirty = Object.keys(patch).length > 0;
  const savingOverrides = pending && busyId === `ov:${detail.id}`;

  // Live override counts for the section switcher badges. Campaign context
  // lives on the Campaign tab's Description card, and colleague research is a
  // plain campaign setting — none of the three count as reply overrides.
  const replyOverrideCount =
    (overridden("draftingEnabled") ? 1 : 0) +
    (identityOverridden ? 1 : 0) +
    (overridden("draftContext") ? 1 : 0) +
    (stylesOverridden ? 1 : 0) +
    (overridden("extraVoiceRules") ? 1 : 0) +
    (overridden("signature") ? 1 : 0) +
    (overridden("autoHandleOoo") ? 1 : 0) +
    (overridden("autoHandleDeadMailbox") ? 1 : 0) +
    (overridden("resumeBusinessDaysAfterReturn") ? 1 : 0) +
    (overridden("resumeDefaultWaitDays") ? 1 : 0);
  const categoryOverrideCount = Object.keys(cleanCategories(form.categories)).length;

  const saveOverrides = () => {
    if (!overridesDirty) return;
    run(`ov:${detail.id}`, async () => {
      const result = await updateCampaignOverridesAction(detail.id, patch);
      if (result.ok) {
        setBaseline(form);
        onOverridesSaved(detail.id, form);
      }
      return result;
    });
  };
  const cancelOverrides = () => setForm(baseline);

  // Limits — clamp to the server's accepted ranges so a save can't bounce.
  const parseLeads = (raw: string): number | null => {
    const trimmed = raw.trim();
    if (!trimmed) return null;
    return clampInt(trimmed, 1, 2000);
  };
  const parseMinutes = (raw: string): number | null => {
    const trimmed = raw.trim();
    if (!trimmed) return null;
    return clampInt(trimmed, 1, 600);
  };
  const parseFollowUp = (raw: string): number | null => {
    const trimmed = raw.trim();
    if (!trimmed) return null;
    return clampInt(trimmed, 0, 100);
  };
  const limitsDirty =
    limits.maxLeadsPerDay !== limitsBaseline.maxLeadsPerDay ||
    limits.minTimeBtwnEmails !== limitsBaseline.minTimeBtwnEmails ||
    limits.followUpPercentage !== limitsBaseline.followUpPercentage;
  const savingLimits = pending && busyId === `limits:${detail.id}`;

  const saveLimits = () => {
    if (!limitsDirty) return;
    const payload: { maxLeadsPerDay?: number; minTimeBtwnEmails?: number } = {};
    const ml = parseLeads(limits.maxLeadsPerDay);
    const mt = parseMinutes(limits.minTimeBtwnEmails);
    const fp = parseFollowUp(limits.followUpPercentage);
    if (limits.maxLeadsPerDay !== limitsBaseline.maxLeadsPerDay && ml !== null)
      payload.maxLeadsPerDay = ml;
    if (limits.minTimeBtwnEmails !== limitsBaseline.minTimeBtwnEmails && mt !== null)
      payload.minTimeBtwnEmails = mt;
    // The follow-up ratio lives on Smartlead's general-settings endpoint, not
    // the schedule endpoint the other two limits post to — saved separately.
    const sendFollowUp =
      limits.followUpPercentage !== limitsBaseline.followUpPercentage && fp !== null;
    if (Object.keys(payload).length === 0 && !sendFollowUp) {
      // Only change was clearing a field — nothing sendable.
      run(`limits:${detail.id}`, async () => ({ ok: false, message: "Enter a value for the sending limit first." }));
      return;
    }
    run(`limits:${detail.id}`, async () => {
      if (Object.keys(payload).length > 0) {
        const result = await updateCampaignLimitsAction(detail.id, payload);
        if (!result.ok) return result;
      }
      if (sendFollowUp) {
        const result = await updateCampaignGeneralSettingsAction(detail.id, {
          followUpPercentage: fp,
        });
        if (!result.ok) return result;
      }
      setLimitsBaseline(limits);
      onLimitsSaved(detail.id, {
        maxLeadsPerDay: payload.maxLeadsPerDay !== undefined ? ml : undefined,
        minTimeBtwnEmails: payload.minTimeBtwnEmails !== undefined ? mt : undefined,
        followUpPercentage: sendFollowUp ? fp : undefined,
      });
      return { ok: true, message: "Campaign limits updated." };
    });
  };
  const cancelLimits = () => setLimits(limitsBaseline);

  // General settings — dirty diff: send only fields that changed from baseline.
  const generalName = general.name.trim();
  const generalNameValid = generalName.length >= 1 && generalName.length <= 120;
  const generalUnsub = general.unsubscribeText.trim();
  const generalPatch: {
    name?: string;
    stopLeadSettings?: StopLeadSetting;
    sendAsPlainText?: boolean;
    unsubscribeText?: string;
    tracking?: { opens: boolean; clicks: boolean };
  } = {};
  if (generalName !== generalBaseline.name.trim()) generalPatch.name = generalName;
  if (general.stopLeadSettings !== generalBaseline.stopLeadSettings)
    generalPatch.stopLeadSettings = general.stopLeadSettings;
  if (general.sendAsPlainText !== generalBaseline.sendAsPlainText)
    generalPatch.sendAsPlainText = general.sendAsPlainText;
  if (generalUnsub !== generalBaseline.unsubscribeText.trim())
    generalPatch.unsubscribeText = generalUnsub;
  if (
    general.trackOpens !== generalBaseline.trackOpens ||
    general.trackClicks !== generalBaseline.trackClicks
  )
    generalPatch.tracking = { opens: general.trackOpens, clicks: general.trackClicks };
  const generalDirty = Object.keys(generalPatch).length > 0;
  const savingGeneral = pending && busyId === `gen:${detail.id}`;

  const saveGeneral = () => {
    if (!generalDirty) return;
    if (!generalNameValid) {
      run(`gen:${detail.id}`, async () => ({ ok: false, message: "Campaign name must be 1 to 120 characters." }));
      return;
    }
    run(`gen:${detail.id}`, async () => {
      const result = await updateCampaignGeneralSettingsAction(detail.id, generalPatch);
      if (result.ok) {
        // Baseline only: resetting the live form would clobber keystrokes
        // typed while the save was in flight (trimmed comparisons keep the
        // dirty flag honest without it).
        setGeneralBaseline({ ...general, name: generalName, unsubscribeText: generalUnsub });
        const detailPatch: Partial<CampaignDetail> = {};
        if (generalPatch.name !== undefined) detailPatch.name = generalPatch.name;
        if (generalPatch.stopLeadSettings !== undefined)
          detailPatch.stopLeadSettings = generalPatch.stopLeadSettings;
        if (generalPatch.sendAsPlainText !== undefined)
          detailPatch.sendAsPlainText = generalPatch.sendAsPlainText;
        if (generalPatch.unsubscribeText !== undefined)
          detailPatch.unsubscribeText = generalPatch.unsubscribeText;
        if (generalPatch.tracking !== undefined)
          detailPatch.tracking = {
            ...detail.tracking,
            opens: generalPatch.tracking.opens,
            clicks: generalPatch.tracking.clicks,
          };
        onGeneralSaved(detail.id, detailPatch);
      }
      return result;
    });
  };
  const cancelGeneral = () => setGeneral(generalBaseline);

  // Schedule window — sending limits are preserved server-side, so this save
  // carries only the timezone/days/hours window.
  const toggleScheduleDay = (value: number) =>
    setSchedule((prev) => ({
      ...prev,
      days: prev.days.includes(value)
        ? prev.days.filter((day) => day !== value)
        : [...prev.days, value].sort((a, b) => a - b),
    }));
  const scheduleDaysKey = (days: number[]) => [...days].sort((a, b) => a - b).join(",");
  const scheduleDirty =
    schedule.timezone !== scheduleBaseline.timezone ||
    schedule.startHour !== scheduleBaseline.startHour ||
    schedule.endHour !== scheduleBaseline.endHour ||
    scheduleDaysKey(schedule.days) !== scheduleDaysKey(scheduleBaseline.days);
  const scheduleValid = schedule.days.length >= 1 && schedule.startHour < schedule.endHour;
  const savingSchedule = pending && busyId === `sched:${detail.id}`;

  const saveSchedule = () => {
    if (!scheduleDirty) return;
    if (!scheduleValid) {
      run(`sched:${detail.id}`, async () => ({
        ok: false,
        message: "Pick at least one sending day and an end hour after the start hour.",
      }));
      return;
    }
    const payload: CampaignSchedule = {
      timezone: schedule.timezone,
      daysOfTheWeek: [...schedule.days].sort((a, b) => a - b),
      startHour: schedule.startHour,
      endHour: schedule.endHour,
    };
    run(`sched:${detail.id}`, async () => {
      const result = await updateCampaignScheduleWindowAction(detail.id, payload);
      if (result.ok) {
        setScheduleBaseline({ ...schedule, days: payload.daysOfTheWeek });
        onScheduleSaved(detail.id, payload);
      }
      return result;
    });
  };
  const cancelSchedule = () => setSchedule(scheduleBaseline);

  // Reply webhook connect — registers, then re-checks status.
  const connectingWebhook = pending && busyId === `wh:${detail.id}`;
  const connectWebhook = () => {
    run(`wh:${detail.id}`, async () => {
      const result = await registerReplyWebhookAction(detail.id);
      if (result.ok) loadWebhookStatus();
      return result;
    });
  };

  const changeStatus = (action: "START" | "PAUSED" | "STOPPED", nextStatus: string) => {
    run(`st:${detail.id}`, async () => {
      const result = await setCampaignStatusAction(detail.id, action);
      if (result.ok) {
        setStatus(nextStatus);
        onStatusChanged(detail.id, nextStatus);
      }
      return result;
    });
  };
  const statusBusy = pending && busyId === `st:${detail.id}`;
  const running = isActive(status);

  const requestPause = () => {
    if (!pauseArmed) {
      setPauseArmed(true);
      if (pauseTimer.current) clearTimeout(pauseTimer.current);
      pauseTimer.current = setTimeout(() => setPauseArmed(false), 3000);
      return;
    }
    setPauseArmed(false);
    changeStatus("PAUSED", "PAUSED");
  };

  return (
    // A stable left edge across every tab: the header and section switcher
    // always span the full pane (so nothing jumps while switching), while
    // each tab's BODY takes the width it deserves — settings forms keep a
    // readable column, the Leads data table uses the whole pane.
    <div className="flex w-full flex-col gap-5 px-6 py-6">
      {/* ── Panel header: identity + status pill + status actions ── */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-[15px] font-semibold tracking-tight">{detail.name}</h2>
            <span
              className={`rounded px-1.5 py-px text-[10px] font-semibold uppercase tracking-wide ${statusTone(
                status,
              )}`}
            >
              {statusLabel(status)}
            </span>
            <CampaignInfoPopover detail={detail} status={status} />
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <a
            href={buildSmartleadCampaignUrl(detail.id)}
            target="_blank"
            rel="noopener noreferrer"
            className={`${BTN_OUTLINE} h-8 px-3 text-[12px]`}
          >
            <ExternalLink className="size-3.5" />
            View in Smartlead
          </a>
          <button
            type="button"
            disabled={statusBusy || running}
            onClick={() => changeStatus("START", "ACTIVE")}
            className={`${BTN_OUTLINE} h-8 px-3 text-[12px]`}
          >
            <Play className="size-3.5" />
            Start
          </button>
          <button
            type="button"
            disabled={statusBusy || !running}
            onClick={requestPause}
            className={`${pauseArmed ? BTN_PRIMARY : BTN_OUTLINE} h-8 px-3 text-[12px]`}
          >
            <Pause className="size-3.5" />
            {pauseArmed ? "Confirm pause?" : "Pause"}
          </button>
          <button
            type="button"
            disabled={statusBusy}
            onClick={() => changeStatus("STOPPED", "STOPPED")}
            className={`${BTN_BASE} h-8 px-3 text-[12px] text-muted-foreground hover:bg-muted/70 hover:text-destructive`}
          >
            <Square className="size-3.5" />
            Stop
          </button>
          {isDrafted ? (
            <div className="relative">
              <button
                type="button"
                disabled={deletingDraft}
                aria-expanded={deleteDraftConfirm}
                onClick={() => setDeleteDraftConfirm((prev) => !prev)}
                className={`${BTN_BASE} h-8 px-3 text-[12px] text-muted-foreground hover:bg-muted/70 hover:text-destructive`}
              >
                <Trash2 className="size-3.5" />
                Delete draft
              </button>
              {deleteDraftConfirm ? (
                <div className="absolute right-0 top-full z-20 mt-1.5 flex w-60 flex-col gap-2 rounded-lg border border-border bg-surface p-2.5 shadow-pop">
                  <p className="text-[12px] font-medium leading-snug">Delete this draft?</p>
                  <p className="text-[11px] leading-relaxed text-muted-foreground">
                    This permanently removes the campaign from Smartlead. Only drafted campaigns can be
                    deleted.
                  </p>
                  <div className="flex gap-1.5">
                    <button
                      type="button"
                      autoFocus
                      onClick={() => setDeleteDraftConfirm(false)}
                      onKeyDown={(event) => {
                        if (event.key === "Escape") setDeleteDraftConfirm(false);
                      }}
                      className="flex h-7 flex-1 items-center justify-center rounded-md border border-border bg-surface text-[11.5px] font-medium text-foreground transition hover:bg-muted/60"
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      disabled={deletingDraft}
                      onClick={confirmDeleteDraft}
                      className="flex h-7 flex-1 items-center justify-center rounded-md bg-destructive-soft text-[11.5px] font-medium text-destructive transition hover:opacity-85 disabled:opacity-50"
                    >
                      {deletingDraft ? "Deleting…" : "Delete draft"}
                    </button>
                  </div>
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>

      {/* ── Section switcher ── */}
      <SectionSwitcher
        section={section}
        onChange={switchSection}
        replyCount={replyOverrideCount}
        categoryCount={categoryOverrideCount}
      />

      {/* Body width varies per tab; the shared left edge keeps it calm. */}
      <div
        className={`flex w-full flex-col gap-5 ${
          section === "leads"
            ? ""
            : section === "overview" || section === "sequence"
              ? "max-w-[1360px]"
              : "max-w-[900px]"
        }`}
      >

      {/* ── Overview: campaign analytics (default landing tab) with the
             insights rail beside it on wide screens, stacked below otherwise ── */}
      {section === "overview" ? (
        <div className="flex flex-col gap-5 xl:flex-row xl:items-start">
          <div className="min-w-0 max-w-[900px] flex-1">
            <CampaignOverviewSection
              detail={detail}
              overview={overview}
              loading={overviewLoading}
              error={overviewError}
              onRetry={loadOverview}
            />
          </div>
          {/* top-5 keeps a sliver of air below the pane's scroll edge (the
              scrolling ancestor itself has no padding, only the panel body). */}
          <aside className="w-full xl:sticky xl:top-5 xl:w-[340px] xl:shrink-0 xl:self-start">
            <CampaignInsightsRail
              insights={insights}
              loading={insightsLoading}
              error={insightsError}
              onRetry={loadInsights}
              briefPending={briefPending}
              briefError={briefError}
              briefNote={briefNote}
              onRegenerate={() => void runBriefGeneration(true)}
              onRetryBrief={() => void runBriefGeneration(insights?.brief ? true : false)}
            />
          </aside>
        </div>
      ) : null}

      {/* ── Campaign: general, schedule, sending limits, reply webhook ── */}
      {section === "campaign" ? (
        <div className="flex flex-col gap-6">
          {/* Description (AI context — ours, not Smartlead's) */}
          <div className="flex flex-col gap-2">
            <SettingGroup
              title="Description"
              description="Context our AI uses for this campaign. Smartlead never sees it."
            >
              <div className="flex flex-col gap-1.5 px-4 py-3.5">
                <textarea
                  value={description}
                  onChange={(event) => setDescription(event.target.value)}
                  rows={4}
                  maxLength={2000}
                  placeholder="What this campaign is about and who it targets…"
                  className={TEXTAREA_MULTI}
                />
                <p className="text-[11px] leading-relaxed text-muted-foreground">
                  When empty, the workspace default from Settings, Reply defaults applies.
                </p>
              </div>
            </SettingGroup>

            {descriptionDirty ? (
              <SaveBar
                saving={savingDescription}
                onCancel={cancelDescription}
                onSave={saveDescription}
                label="Unsaved description"
                saveLabel="Save description"
              />
            ) : null}
          </div>

          {/* General */}
          <div className="flex flex-col gap-2">
            <SettingGroup title="General" description="Name and delivery behavior for this campaign.">
              <SettingRowFull label="Campaign name" description="Shown across the app. 1 to 120 characters.">
                <input
                  value={general.name}
                  onChange={(event) => setGeneral((prev) => ({ ...prev, name: event.target.value }))}
                  maxLength={120}
                  placeholder="Campaign name"
                  className={INPUT_CLASS}
                />
                {general.name.trim().length === 0 ? (
                  <p className="text-[11px] text-destructive">Enter a campaign name.</p>
                ) : null}
              </SettingRowFull>

              <SettingRow
                label="Stop sending to a lead when"
                description="Smartlead stops the sequence for a lead on this signal."
              >
                <div className="relative w-full sm:w-64">
                  <select
                    value={general.stopLeadSettings}
                    onChange={(event) =>
                      setGeneral((prev) => ({
                        ...prev,
                        stopLeadSettings: event.target.value as StopLeadSetting,
                      }))
                    }
                    className={`${INPUT_CLASS} appearance-none pr-7`}
                  >
                    {STOP_LEAD_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                  <ChevronDown className="pointer-events-none absolute right-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
                </div>
              </SettingRow>

              <SettingRow label="Send as plain text" description="Strips HTML from outgoing emails.">
                <div className="flex lg:justify-start">
                  <Toggle
                    checked={general.sendAsPlainText}
                    onChange={(next) => setGeneral((prev) => ({ ...prev, sendAsPlainText: next }))}
                    disabled={savingGeneral}
                    label="Send as plain text"
                  />
                </div>
              </SettingRow>

              <SettingRow label="Track opens" description="Records when a lead opens an email.">
                <div className="flex lg:justify-start">
                  <Toggle
                    checked={general.trackOpens}
                    onChange={(next) => setGeneral((prev) => ({ ...prev, trackOpens: next }))}
                    disabled={savingGeneral}
                    label="Track opens"
                  />
                </div>
              </SettingRow>

              <SettingRow label="Track link clicks" description="Rewrites links to record clicks.">
                <div className="flex lg:justify-start">
                  <Toggle
                    checked={general.trackClicks}
                    onChange={(next) => setGeneral((prev) => ({ ...prev, trackClicks: next }))}
                    disabled={savingGeneral}
                    label="Track link clicks"
                  />
                </div>
              </SettingRow>

              <SettingRowFull
                label="Unsubscribe text"
                description="Appended as the unsubscribe line. Leave empty for none."
              >
                <input
                  value={general.unsubscribeText}
                  onChange={(event) =>
                    setGeneral((prev) => ({ ...prev, unsubscribeText: event.target.value }))
                  }
                  maxLength={500}
                  placeholder="e.g. Reply STOP to unsubscribe"
                  className={INPUT_CLASS}
                />
              </SettingRowFull>
            </SettingGroup>

            {generalDirty ? (
              <SaveBar
                saving={savingGeneral}
                onCancel={cancelGeneral}
                onSave={saveGeneral}
                label="Unsaved general settings"
                saveLabel="Save general"
              />
            ) : null}
          </div>

          {/* Schedule */}
          <div className="flex flex-col gap-2">
            <SettingGroup title="Schedule" description="When Smartlead is allowed to send for this campaign.">
              <SettingRow label="Time zone" description="Sending hours are interpreted in this zone.">
                <div className="relative w-full sm:w-64">
                  <select
                    value={schedule.timezone}
                    onChange={(event) => setSchedule((prev) => ({ ...prev, timezone: event.target.value }))}
                    className={`${INPUT_CLASS} appearance-none pr-7`}
                  >
                    {scheduleZones.map((zone) => (
                      <option key={zone} value={zone}>
                        {zone.replace(/_/g, " ")}
                      </option>
                    ))}
                  </select>
                  <ChevronDown className="pointer-events-none absolute right-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
                </div>
              </SettingRow>

              <SettingRow label="Sending days" description="Days of the week the campaign may send.">
                <div className="flex flex-wrap gap-1.5">
                  {DAY_PILLS.map((day) => {
                    const on = schedule.days.includes(day.value);
                    return (
                      <button
                        key={day.value}
                        type="button"
                        aria-pressed={on}
                        onClick={() => toggleScheduleDay(day.value)}
                        className={`rounded-full border px-2.5 py-0.5 text-[11px] font-medium transition ${
                          on
                            ? "border-transparent bg-accent text-accent-foreground"
                            : "border-border bg-surface text-muted-foreground hover:text-foreground"
                        }`}
                      >
                        {day.label}
                      </button>
                    );
                  })}
                </div>
                {schedule.days.length === 0 ? (
                  <p className="text-[11px] text-destructive">Pick at least one sending day.</p>
                ) : null}
              </SettingRow>

              <SettingRow label="Sending hours" description="The daily window sends are allowed in.">
                <div className="flex flex-wrap items-center gap-2">
                  <div className="relative w-28">
                    <select
                      aria-label="Start hour"
                      value={schedule.startHour}
                      onChange={(event) => setSchedule((prev) => ({ ...prev, startHour: event.target.value }))}
                      className={`${INPUT_CLASS} appearance-none pr-7`}
                    >
                      {hourOptionsWith(schedule.startHour).map((hour) => (
                        <option key={hour} value={hour}>
                          {hour}
                        </option>
                      ))}
                    </select>
                    <ChevronDown className="pointer-events-none absolute right-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
                  </div>
                  <span className="text-[12px] text-muted-foreground">to</span>
                  <div className="relative w-28">
                    <select
                      aria-label="End hour"
                      value={schedule.endHour}
                      onChange={(event) => setSchedule((prev) => ({ ...prev, endHour: event.target.value }))}
                      className={`${INPUT_CLASS} appearance-none pr-7`}
                    >
                      {hourOptionsWith(schedule.endHour).map((hour) => (
                        <option key={hour} value={hour}>
                          {hour}
                        </option>
                      ))}
                    </select>
                    <ChevronDown className="pointer-events-none absolute right-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
                  </div>
                </div>
                {schedule.startHour >= schedule.endHour ? (
                  <p className="text-[11px] text-destructive">End hour must be after the start hour.</p>
                ) : null}
              </SettingRow>
            </SettingGroup>

            <p className="px-1 text-[11px] leading-relaxed text-muted-foreground">
              {detail.schedule === null
                ? "This campaign has no schedule yet. Changes apply to future sends. Sending limits are managed separately and are not affected."
                : "Changes apply to future sends. Sending limits are managed separately and are not affected."}
            </p>

            {scheduleDirty ? (
              <SaveBar
                saving={savingSchedule}
                onCancel={cancelSchedule}
                onSave={saveSchedule}
                label="Unsaved schedule"
                saveLabel="Save schedule"
              />
            ) : null}
          </div>

          {/* Sending limits */}
          <div className="flex flex-col gap-2">
            <SettingGroup
              title="Sending limits"
              description="Throughput for this campaign in Smartlead."
            >
              <SettingRow
                label="Daily lead limit"
                description="Maximum new leads contacted per day."
              >
                <input
                  type="number"
                  min={1}
                  max={2000}
                  value={limits.maxLeadsPerDay}
                  onChange={(event) =>
                    setLimits((prev) => ({ ...prev, maxLeadsPerDay: event.target.value }))
                  }
                  placeholder="e.g. 50"
                  className={`${INPUT_CLASS} w-32`}
                />
              </SettingRow>

              <SettingRow
                label="Min minutes between emails"
                description="Minimum delay Smartlead waits between sends."
              >
                <input
                  type="number"
                  min={1}
                  max={600}
                  value={limits.minTimeBtwnEmails}
                  onChange={(event) =>
                    setLimits((prev) => ({ ...prev, minTimeBtwnEmails: event.target.value }))
                  }
                  placeholder="e.g. 10"
                  className={`${INPUT_CLASS} w-32`}
                />
              </SettingRow>

              <SettingRow
                label="Follow-up percentage"
                description="Share of each day's sends reserved for follow-ups — the rest contact new leads."
              >
                <div className="flex items-center gap-2">
                  <input
                    type="number"
                    min={0}
                    max={100}
                    value={limits.followUpPercentage}
                    onChange={(event) =>
                      setLimits((prev) => ({ ...prev, followUpPercentage: event.target.value }))
                    }
                    placeholder="e.g. 40"
                    className={`${INPUT_CLASS} w-32`}
                  />
                  <span className="text-[12px] text-muted-foreground">%</span>
                </div>
              </SettingRow>
            </SettingGroup>

            {limitsDirty ? (
              <SaveBar
                saving={savingLimits}
                onCancel={cancelLimits}
                onSave={saveLimits}
                label="Unsaved limits"
                saveLabel="Save limits"
              />
            ) : null}
          </div>

          {/* Reply webhook (quiet, standalone row) */}
          <div className="divide-y divide-border overflow-hidden rounded-xl bg-surface shadow-xs">
            <SettingRow
              label="Reply webhook"
              description="Delivers replies from this campaign into the app."
            >
              <div className="flex flex-wrap items-center gap-2.5">
                {webhookLoading && !webhookStatus ? (
                  <span className="inline-flex items-center gap-1.5 text-[12px] text-muted-foreground">
                    <Loader2 className="size-3.5 animate-spin" />
                    Checking status…
                  </span>
                ) : webhookStatus ? (
                  <>
                    <span
                      className={`rounded px-1.5 py-px text-[10px] font-semibold ${
                        webhookStatus.registered
                          ? "bg-success-soft text-success"
                          : "bg-warning-soft text-warning"
                      }`}
                    >
                      {webhookStatus.registered ? "Connected" : "Not connected"}
                    </span>
                    {!webhookStatus.registered ? (
                      <button
                        type="button"
                        disabled={connectingWebhook}
                        onClick={connectWebhook}
                        className={`${BTN_OUTLINE} h-7 px-2.5 text-[11.5px]`}
                      >
                        {connectingWebhook ? "Connecting…" : "Connect"}
                      </button>
                    ) : null}
                  </>
                ) : (
                  <span className="text-[12px] text-muted-foreground">
                    {webhookError ?? "Status unavailable."}
                  </span>
                )}
              </div>
            </SettingRow>
          </div>
        </div>
      ) : null}

      {/* ── Sequence: outbound email copy (lazy-loaded from Smartlead). The
             whole-sequence check surfaces as a banner above the timeline only
             when something is broken (clean = one quiet line). The writing
             tools (variables, spintax, per-email checks, spam) live inside
             the edit-sequence takeover. ── */}
      {section === "sequence" ? (
        <div className="flex flex-col gap-5">
          <div className="min-w-0">
            {seqLoading && seqDrafts === null ? (
              <div className="flex flex-col gap-4">
                <div className="flex items-center gap-2 text-[12px] text-muted-foreground">
                  <Loader2 className="size-4 animate-spin" />
                  Loading sequence…
                </div>
                <div className="overflow-hidden rounded-xl bg-surface">
                  <div className="flex flex-col gap-2 px-4 py-3.5">
                    <div className="h-3.5 w-40 animate-pulse rounded bg-muted" />
                    <div className="h-2.5 w-64 animate-pulse rounded bg-muted/70" />
                  </div>
                  <div className="divide-y divide-border border-t border-border">
                    {[0, 1].map((i) => (
                      <div key={i} className="flex flex-col gap-3 px-4 py-4">
                        <div className="h-3 w-32 animate-pulse rounded bg-muted" />
                        <div className="h-8 w-full animate-pulse rounded bg-muted/70" />
                        <div className="h-24 w-full animate-pulse rounded bg-muted/50" />
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            ) : seqDrafts === null ? (
              <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed border-border px-4 py-10 text-center">
                <p className="max-w-md text-[12.5px] leading-relaxed text-muted-foreground">
                  {seqError ?? "Couldn't load this campaign's sequence."}
                </p>
                <button
                  type="button"
                  onClick={loadSequence}
                  disabled={seqLoading}
                  className={`${BTN_OUTLINE} h-8 px-3 text-[12px]`}
                >
                  Retry
                </button>
              </div>
            ) : (
              <div className="flex flex-col gap-6">
                <div className="flex flex-col gap-3">
                  {/* External label line (System Settings grammar) — the timeline
                      below replaces a rows card with readable copy cards. */}
                  <SettingGroup
                    title="Email sequence"
                    description={
                      seqDrafts.length === 0
                        ? "No emails yet. Write the first one here — {option|option} spintax and {{merge_tags}} are preserved."
                        : `${seqDrafts.length} email${
                            seqDrafts.length === 1 ? "" : "s"
                          }. Outbound copy synced from Smartlead. {option|option} spintax and {{merge_tags}} are preserved.`
                    }
                    control={
                      <button
                        type="button"
                        onClick={() => openSequenceEditor(0)}
                        className={`${BTN_PRIMARY} h-8 px-3 text-[12px]`}
                      >
                        <PenLine className="size-3.5" />
                        {seqDrafts.length === 0 ? "Write first email" : "Edit sequence"}
                      </button>
                    }
                  />

                  {seqDrafts.length > 0 ? (
                    <SequenceCheckBanner
                      drafts={seqDrafts}
                      previewLead={previewLead}
                      onOpenStep={openSequenceEditor}
                    />
                  ) : null}

                  {seqDrafts.length === 0 ? (
                    <button
                      type="button"
                      onClick={() => openSequenceEditor(0)}
                      className="flex flex-col items-center gap-2 rounded-xl border border-dashed border-border px-4 py-8 text-center transition hover:border-border-strong hover:bg-muted/40"
                    >
                      <span className="flex size-9 items-center justify-center rounded-full bg-accent text-accent-foreground">
                        <PenLine className="size-4" />
                      </span>
                      <span className="text-[12.5px] font-medium text-foreground">Write the first email</span>
                      <span className="max-w-sm text-[11.5px] leading-relaxed text-muted-foreground">
                        This campaign has no sequence yet. Add email 1, then follow-ups — nothing sends until you set the campaign live.
                      </span>
                    </button>
                  ) : (
                    <div className="flex flex-col">
                      {seqDrafts.map((draft, index) => {
                        const nextDelay =
                          index < seqDrafts.length - 1 ? seqDrafts[index + 1].delayInDays : null;
                        return (
                          <Fragment key={draft.uid}>
                            <div className="flex gap-3">
                              {/* Numbered bubble + connector */}
                              <div className="flex w-7 shrink-0 flex-col items-center">
                                <span className="flex size-6 shrink-0 items-center justify-center rounded-full border border-border bg-surface text-[11px] font-semibold text-muted-foreground shadow-xs">
                                  {index + 1}
                                </span>
                                {nextDelay !== null ? (
                                  <span aria-hidden className="mt-1 w-px flex-1 bg-border" />
                                ) : null}
                              </div>
                              <div className="min-w-0 flex-1">
                                <SequenceCopyCard
                                  draft={draft}
                                  index={index}
                                  onOpen={() => openSequenceEditor(index)}
                                />
                              </div>
                            </div>
                            {nextDelay !== null ? (
                              <div className="flex gap-3">
                                <div className="flex w-7 shrink-0 justify-center">
                                  <span aria-hidden className="w-px self-stretch bg-border" />
                                </div>
                                <div className="flex items-center py-2">
                                  <span className="rounded-full border border-border bg-muted/40 px-2 py-px text-[10.5px] font-medium text-muted-foreground">
                                    {nextDelay === 0
                                      ? "Same day"
                                      : `${nextDelay} day${nextDelay === 1 ? "" : "s"} later`}
                                  </span>
                                </div>
                              </div>
                            ) : null}
                          </Fragment>
                        );
                      })}
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      ) : null}

      {/* ── Inboxes: the campaign's sending accounts (lazy-loaded from Smartlead) ── */}
      {section === "inboxes" ? (
        inboxLoading && inboxes === null ? (
          <div className="flex flex-col gap-4">
            <div className="flex items-center gap-2 text-[12px] text-muted-foreground">
              <Loader2 className="size-4 animate-spin" />
              Loading inboxes…
            </div>
            <div className="overflow-hidden rounded-xl bg-surface">
              <div className="divide-y divide-border">
                {[0, 1, 2].map((i) => (
                  <div key={i} className="flex items-center gap-4 px-4 py-4">
                    <div className="h-3 w-56 animate-pulse rounded bg-muted" />
                    <div className="ml-auto h-4 w-10 animate-pulse rounded bg-muted/70" />
                  </div>
                ))}
              </div>
            </div>
          </div>
        ) : inboxes === null ? (
          <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed border-border px-4 py-10 text-center">
            <p className="max-w-md text-[12.5px] leading-relaxed text-muted-foreground">
              {inboxError ?? "Couldn't load this campaign's inboxes."}
            </p>
            <button
              type="button"
              onClick={loadInboxes}
              disabled={inboxLoading}
              className={`${BTN_OUTLINE} h-8 px-3 text-[12px]`}
            >
              Retry
            </button>
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            <SettingGroup
              title="Sending accounts"
              description="The inboxes Smartlead sends this campaign from. Warmup reputation and connection health sync from Smartlead."
              control={
                <button
                  type="button"
                  onClick={addOpen ? closeAddPanel : openAddPanel}
                  disabled={mutatingInboxes}
                  aria-expanded={addOpen}
                  className={`${BTN_OUTLINE} h-7 px-2.5 text-[11.5px]`}
                >
                  <Plus className="size-3.5" />
                  Add inboxes
                </button>
              }
            />

            {/* ── Add-inboxes panel: workspace inboxes not already assigned ── */}
            {addOpen ? (
              <div className="flex flex-col gap-3 rounded-xl bg-surface p-3 shadow-xs">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[12px] font-medium">Add inboxes to this campaign</span>
                  <button
                    type="button"
                    onClick={closeAddPanel}
                    disabled={addingInboxes}
                    className="text-[11.5px] font-medium text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50"
                  >
                    Cancel
                  </button>
                </div>

                {rosterLoading && roster === null ? (
                  <div className="flex items-center gap-2 text-[12px] text-muted-foreground">
                    <Loader2 className="size-4 animate-spin" />
                    Loading inboxes…
                  </div>
                ) : roster === null ? (
                  <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed border-border px-4 py-8 text-center">
                    <p className="max-w-xs text-[12px] leading-relaxed text-muted-foreground">
                      {rosterError ?? "Couldn't load inboxes."}
                    </p>
                    <button
                      type="button"
                      onClick={loadRoster}
                      disabled={rosterLoading}
                      className={`${BTN_OUTLINE} h-8 px-3 text-[12px]`}
                    >
                      Retry
                    </button>
                  </div>
                ) : addableInboxes.length === 0 ? (
                  <p className="rounded-lg border border-dashed border-border px-4 py-6 text-center text-[12px] text-muted-foreground">
                    All workspace inboxes are already assigned.
                  </p>
                ) : (
                  <>
                    <div className="flex max-h-72 flex-col divide-y divide-border overflow-y-auto rounded-lg border border-border">
                      {addableInboxes.map((inbox) => {
                        const checked = addSelected.has(inbox.id);
                        return (
                          <label
                            key={inbox.id}
                            className="flex cursor-pointer items-center gap-3 px-3 py-2.5 transition-colors hover:bg-muted/50"
                          >
                            <input
                              type="checkbox"
                              checked={checked}
                              onChange={() => toggleAddInbox(inbox.id)}
                              disabled={addingInboxes}
                              className={`size-3.5 accent-[var(--primary)]`}
                            />
                            <SenderAvatar src={inboxAvatars[inbox.fromEmail.toLowerCase()] ?? null} verified={inboxAvatarsVerified} />
                            <div className="flex min-w-0 flex-1 flex-col gap-1">
                              <div className="flex items-center gap-2">
                                <span className="min-w-0 truncate text-[12.5px] font-medium">{inbox.fromEmail}</span>
                                {inbox.isSuspended ? (
                                  <span className="shrink-0 rounded bg-destructive-soft px-1.5 py-px text-[10px] font-medium text-destructive">
                                    Suspended
                                  </span>
                                ) : null}
                              </div>
                              <span className="inline-flex items-center gap-1.5">
                                <InboxConnDot label="SMTP" ok={inbox.smtpOk} error={inbox.smtpError} />
                                <InboxConnDot label="IMAP" ok={inbox.imapOk} error={inbox.imapError} />
                              </span>
                            </div>
                            <ReputationBadge value={inbox.warmup?.reputation ?? null} />
                          </label>
                        );
                      })}
                    </div>
                    <div className="flex items-center justify-end gap-2">
                      <span className="mr-auto text-[11px] text-muted-foreground">{addSelected.size} selected</span>
                      <button
                        type="button"
                        onClick={confirmAddInboxes}
                        disabled={addingInboxes || addSelected.size === 0}
                        className={`${BTN_PRIMARY} h-8 px-3 text-[12px]`}
                      >
                        <Plus className="size-3.5" />
                        {addingInboxes
                          ? "Adding…"
                          : addSelected.size > 0
                            ? `Add ${addSelected.size} inbox${addSelected.size === 1 ? "" : "es"}`
                            : "Add inboxes"}
                      </button>
                    </div>
                  </>
                )}
              </div>
            ) : null}

            {inboxes.length === 0 ? (
              <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed border-border px-4 py-10 text-center">
                <span className="flex size-9 items-center justify-center rounded-full bg-muted/60">
                  <Mailbox className="size-4 text-muted-foreground" strokeWidth={1.5} />
                </span>
                <p className="text-[12.5px] text-muted-foreground">
                  No sending accounts are assigned to this campaign yet.
                </p>
              </div>
            ) : (
              <div className="divide-y divide-border rounded-xl bg-surface shadow-xs">
                <InboxSummaryBand inboxes={inboxes} />
                {inboxes.map((inbox) => (
                  <div key={inbox.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
                    <SenderAvatar src={inboxAvatars[inbox.fromEmail.toLowerCase()] ?? null} verified={inboxAvatarsVerified} />
                    <div className="flex min-w-0 flex-1 flex-col gap-1">
                      <div className="flex items-center gap-2">
                        <span className="min-w-0 truncate text-[12.5px] font-medium">{inbox.fromEmail}</span>
                        {inbox.isSuspended ? (
                          <span className="shrink-0 rounded bg-destructive-soft px-1.5 py-px text-[10px] font-medium text-destructive">
                            Suspended
                          </span>
                        ) : null}
                      </div>
                      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                        {inbox.provider?.trim() ? (
                          <span className="shrink-0 rounded border border-border bg-surface px-1.5 py-px text-[10px] font-medium text-muted-foreground">
                            {titleCaseProvider(inbox.provider)}
                          </span>
                        ) : null}
                        <span className="inline-flex items-center gap-1.5">
                          <InboxConnDot label="SMTP" ok={inbox.smtpOk} error={inbox.smtpError} />
                          <InboxConnDot label="IMAP" ok={inbox.imapOk} error={inbox.imapError} />
                        </span>
                        {inbox.messagePerDay !== null ? (
                          <span className="text-[10.5px] tabular-nums text-muted-foreground">
                            {inbox.messagePerDay}/day
                          </span>
                        ) : null}
                      </div>
                    </div>
                    <ReputationBadge value={inbox.warmup?.reputation ?? null} />
                    <div className="relative shrink-0">
                      <button
                        type="button"
                        data-tip="Remove from campaign"
                        aria-label={`Remove ${inbox.fromEmail} from this campaign`}
                        aria-expanded={removeConfirmId === inbox.id}
                        disabled={mutatingInboxes}
                        onClick={() =>
                          setRemoveConfirmId((cur) => (cur === inbox.id ? null : inbox.id))
                        }
                        className={`flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted/70 hover:text-destructive disabled:cursor-not-allowed disabled:opacity-50`}
                      >
                        <X className="size-3.5" />
                      </button>
                      {removeConfirmId === inbox.id ? (
                        <div className="absolute right-0 top-full z-20 mt-1.5 flex w-64 flex-col gap-2 rounded-lg border border-border bg-surface p-2.5 shadow-pop">
                          <p className="text-[12px] font-medium leading-snug">
                            Remove {inbox.fromEmail} from this campaign?
                          </p>
                          <p className="text-[11px] leading-relaxed text-muted-foreground">
                            Smartlead stops sending this campaign from this inbox. The inbox stays
                            connected to your workspace.
                          </p>
                          <div className="flex gap-1.5">
                            <button
                              type="button"
                              autoFocus
                              onClick={() => setRemoveConfirmId(null)}
                              onKeyDown={(event) => {
                                if (event.key === "Escape") setRemoveConfirmId(null);
                              }}
                              className="flex h-7 flex-1 items-center justify-center rounded-md border border-border bg-surface text-[11.5px] font-medium text-foreground transition hover:bg-muted/60"
                            >
                              Cancel
                            </button>
                            <button
                              type="button"
                              disabled={mutatingInboxes}
                              onClick={() => removeInbox(inbox.id)}
                              className="flex h-7 flex-1 items-center justify-center rounded-md bg-destructive-soft text-[11.5px] font-medium text-destructive transition hover:opacity-85 disabled:opacity-50"
                            >
                              {removingInboxes ? "Removing…" : "Remove"}
                            </button>
                          </div>
                        </div>
                      ) : null}
                    </div>
                  </div>
                ))}
              </div>
            )}

            <Link
              href="/inboxes"
              className="self-start text-[11.5px] font-medium text-muted-foreground transition-colors hover:text-foreground"
            >
              Manage all inboxes →
            </Link>
          </div>
        )
      ) : null}

      {/* ── Leads: everyone loaded into the campaign + their merge variables ── */}
      {section === "leads" ? (
        leadsLoading && leadsTotal === null ? (
          <div className="flex flex-col gap-4">
            <div className="flex items-center gap-2 text-[12px] text-muted-foreground">
              <Loader2 className="size-4 animate-spin" />
              Loading leads…
            </div>
            <div className="overflow-hidden rounded-xl bg-surface">
              <div className="divide-y divide-border">
                {[0, 1, 2, 3].map((i) => (
                  <div key={i} className="flex items-center gap-4 px-4 py-4">
                    <div className="h-3 w-40 animate-pulse rounded bg-muted" />
                    <div className="h-3 w-52 animate-pulse rounded bg-muted/70" />
                    <div className="ml-auto h-4 w-16 animate-pulse rounded bg-muted/60" />
                  </div>
                ))}
              </div>
            </div>
          </div>
        ) : leadsTotal === null ? (
          <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed border-border px-4 py-10 text-center">
            <p className="max-w-md text-[12.5px] leading-relaxed text-muted-foreground">
              {leadsError ?? "Couldn't load this campaign's leads."}
            </p>
            <button
              type="button"
              onClick={() => loadLeadsPage(leadsPage)}
              disabled={leadsLoading}
              className={`${BTN_OUTLINE} h-8 px-3 text-[12px]`}
            >
              Retry
            </button>
          </div>
        ) : (
          <LeadsSection
            campaignId={detail.id}
            total={leadsTotal}
            page={leadsPage}
            rows={leadsPages[leadsPage] ?? null}
            loading={leadsLoading}
            filter={leadsFilter}
            onFilterChange={setLeadsFilter}
            onGoToPage={goToLeadsPage}
            onLeadPatched={patchLead}
            allLeads={allLeads}
            loadAllState={loadAllState}
            loadAllCount={loadAllCount}
            onLoadAll={loadAllLeads}
            showToast={showToast}
            leadCategories={leadCategories}
            categoriesLoading={categoriesLoading}
            onEnsureCategories={ensureLeadCategories}
            busyLeadMapId={busyLeadMapId}
            onPauseLead={pauseLeadRow}
            onResumeLead={resumeLeadRow}
            onUnsubscribeLead={unsubscribeLeadRow}
            onSetLeadCategory={setLeadCategoryRow}
            onRemoveLead={removeLeadRow}
            onSubmitAddLeads={submitAddLeads}
          />
        )
      ) : null}

      {/* ── Reply handling: the override groups (campaign context is edited on
             the Campaign tab's Description card, not here) ── */}
      {section === "reply" ? (
        <div className="flex flex-col gap-6">
          <SettingGroup
            title="How drafts are written"
            description="Override drafting behavior and voice for this campaign's replies."
          >
            <SettingRow
              label="Draft replies"
              description="Whether Claude pre-writes replies for this campaign."
              customized={overridden("draftingEnabled")}
            >
              <OverrideControl
                overridden={overridden("draftingEnabled")}
                inherited={aiSettings.draftingEnabled ? "On" : "Off"}
                onCustomize={() => setField("draftingEnabled", aiSettings.draftingEnabled)}
                onReset={() => setField("draftingEnabled", null)}
                disabled={savingOverrides}
              >
                <Toggle
                  checked={form.draftingEnabled ?? false}
                  onChange={(next) => setField("draftingEnabled", next)}
                  disabled={savingOverrides}
                  label="Draft replies for this campaign"
                />
              </OverrideControl>
            </SettingRow>

            <SettingRow
              label="Identity"
              description="The name, title, and company drafts are signed with."
              customized={identityOverridden}
            >
              <OverrideControl
                overridden={identityOverridden}
                inherited={
                  [aiSettings.senderName, aiSettings.senderTitle, aiSettings.senderCompany]
                    .filter((part) => part.trim())
                    .join(" · ") || "—"
                }
                onCustomize={() => {
                  setField("senderName", aiSettings.senderName);
                  setField("senderTitle", aiSettings.senderTitle);
                  setField("senderCompany", aiSettings.senderCompany);
                }}
                onReset={() => {
                  setField("senderName", null);
                  setField("senderTitle", null);
                  setField("senderCompany", null);
                }}
                disabled={savingOverrides}
              >
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                  <input
                    value={form.senderName ?? ""}
                    onChange={(event) => setField("senderName", event.target.value)}
                    placeholder="Jane Doe"
                    maxLength={120}
                    className={INPUT_CLASS}
                  />
                  <input
                    value={form.senderTitle ?? ""}
                    onChange={(event) => setField("senderTitle", event.target.value)}
                    placeholder="Head of Growth"
                    maxLength={120}
                    className={INPUT_CLASS}
                  />
                  <input
                    value={form.senderCompany ?? ""}
                    onChange={(event) => setField("senderCompany", event.target.value)}
                    placeholder="Acme Inc."
                    maxLength={120}
                    className={INPUT_CLASS}
                  />
                </div>
              </OverrideControl>
            </SettingRow>

            <SettingRowFull
              label="Draft context"
              description="Proof points and background the AI may cite when replying on this campaign."
              customized={overridden("draftContext")}
            >
              <OverrideControl
                overridden={overridden("draftContext")}
                inherited={textPreview(aiSettings.draftContext)}
                onCustomize={() => setField("draftContext", aiSettings.draftContext)}
                onReset={() => setField("draftContext", null)}
                disabled={savingOverrides}
              >
                <textarea
                  value={form.draftContext ?? ""}
                  onChange={(event) => setField("draftContext", event.target.value)}
                  placeholder="Background, offers, case studies for this campaign…"
                  maxLength={4000}
                  rows={4}
                  className={TEXTAREA_MULTI}
                />
              </OverrideControl>
            </SettingRowFull>

            <SettingRowFull
              label="Style examples"
              description="Override the workspace writing samples with ones specific to this campaign."
              customized={stylesOverridden}
            >
              <OverrideControl
                overridden={stylesOverridden}
                inherited={
                  aiSettings.styleExamples.length > 0
                    ? `${aiSettings.styleExamples.length} example${
                        aiSettings.styleExamples.length === 1 ? "" : "s"
                      }`
                    : "No examples"
                }
                onCustomize={() =>
                  setField(
                    "styleExamples",
                    aiSettings.styleExamples.map((example) => ({ ...example })),
                  )
                }
                onReset={() => setField("styleExamples", null)}
                disabled={savingOverrides}
              >
                <StyleExamplesEditor
                  value={form.styleExamples ?? []}
                  onChange={(next) => setField("styleExamples", next)}
                  disabled={savingOverrides}
                />
              </OverrideControl>
            </SettingRowFull>

            <SettingRow
              label="Extra voice rules"
              description="One rule per line."
              customized={overridden("extraVoiceRules")}
            >
              <OverrideControl
                overridden={overridden("extraVoiceRules")}
                inherited={textPreview(aiSettings.extraVoiceRules)}
                onCustomize={() => setField("extraVoiceRules", aiSettings.extraVoiceRules)}
                onReset={() => setField("extraVoiceRules", null)}
                disabled={savingOverrides}
              >
                <textarea
                  value={form.extraVoiceRules ?? ""}
                  onChange={(event) => setField("extraVoiceRules", event.target.value)}
                  placeholder={"Never use exclamation marks\nKeep it under 90 words"}
                  maxLength={1000}
                  rows={4}
                  className={TEXTAREA_MULTI}
                />
              </OverrideControl>
            </SettingRow>

            <SettingRow
              label="Signature"
              description="The sign-off block appended to drafts."
              customized={overridden("signature")}
            >
              <OverrideControl
                overridden={overridden("signature")}
                inherited={textPreview(aiSettings.signature)}
                onCustomize={() => setField("signature", aiSettings.signature)}
                onReset={() => setField("signature", null)}
                disabled={savingOverrides}
              >
                <textarea
                  value={form.signature ?? ""}
                  onChange={(event) => setField("signature", event.target.value)}
                  placeholder={"Best,\nJane\nHead of Growth, Acme Inc."}
                  maxLength={1000}
                  rows={4}
                  className={TEXTAREA_MULTI}
                />
              </OverrideControl>
            </SettingRow>
          </SettingGroup>

          <SettingGroup
            title="What happens automatically"
            description="Override which routine replies Claude resolves on its own for this campaign."
          >
            <SettingRow
              label="Auto-handle out-of-office replies"
              description="Approve pure OOO replies and schedule a resume."
              customized={overridden("autoHandleOoo")}
            >
              <OverrideControl
                overridden={overridden("autoHandleOoo")}
                inherited={aiSettings.autoHandleOoo ? "On" : "Off"}
                onCustomize={() => setField("autoHandleOoo", aiSettings.autoHandleOoo)}
                onReset={() => setField("autoHandleOoo", null)}
                disabled={savingOverrides}
              >
                <Toggle
                  checked={form.autoHandleOoo ?? false}
                  onChange={(next) => setField("autoHandleOoo", next)}
                  disabled={savingOverrides}
                  label="Auto-handle out-of-office replies"
                />
              </OverrideControl>
            </SettingRow>

            <SettingRow
              label="Auto-handle dead mailboxes"
              description="Approve automated dead-address notices: suppress and block the address without review."
              customized={overridden("autoHandleDeadMailbox")}
            >
              <OverrideControl
                overridden={overridden("autoHandleDeadMailbox")}
                inherited={aiSettings.autoHandleDeadMailbox ? "On" : "Off"}
                onCustomize={() => setField("autoHandleDeadMailbox", aiSettings.autoHandleDeadMailbox)}
                onReset={() => setField("autoHandleDeadMailbox", null)}
                disabled={savingOverrides}
              >
                <Toggle
                  checked={form.autoHandleDeadMailbox ?? false}
                  onChange={(next) => setField("autoHandleDeadMailbox", next)}
                  disabled={savingOverrides}
                  label="Auto-handle dead mailboxes"
                />
              </OverrideControl>
            </SettingRow>

            <SettingRow
              label="Resume after stated return"
              description="Business days to wait after the stated return date."
              customized={overridden("resumeBusinessDaysAfterReturn")}
            >
              <OverrideControl
                overridden={overridden("resumeBusinessDaysAfterReturn")}
                inherited={`${aiSettings.resumeBusinessDaysAfterReturn} business day${
                  aiSettings.resumeBusinessDaysAfterReturn === 1 ? "" : "s"
                }`}
                onCustomize={() =>
                  setField("resumeBusinessDaysAfterReturn", aiSettings.resumeBusinessDaysAfterReturn)
                }
                onReset={() => setField("resumeBusinessDaysAfterReturn", null)}
                disabled={savingOverrides}
              >
                <input
                  type="number"
                  min={0}
                  max={30}
                  value={String(form.resumeBusinessDaysAfterReturn ?? 0)}
                  onChange={(event) =>
                    setField("resumeBusinessDaysAfterReturn", clampInt(event.target.value, 0, 30))
                  }
                  className={`${INPUT_CLASS} w-24`}
                />
              </OverrideControl>
            </SettingRow>

            <SettingRow
              label="Resume when no date given"
              description="Days to wait when no return date is stated."
              customized={overridden("resumeDefaultWaitDays")}
            >
              <OverrideControl
                overridden={overridden("resumeDefaultWaitDays")}
                inherited={`${aiSettings.resumeDefaultWaitDays} day${
                  aiSettings.resumeDefaultWaitDays === 1 ? "" : "s"
                }`}
                onCustomize={() => setField("resumeDefaultWaitDays", aiSettings.resumeDefaultWaitDays)}
                onReset={() => setField("resumeDefaultWaitDays", null)}
                disabled={savingOverrides}
              >
                <input
                  type="number"
                  min={1}
                  max={60}
                  value={String(form.resumeDefaultWaitDays ?? 1)}
                  onChange={(event) =>
                    setField("resumeDefaultWaitDays", clampInt(event.target.value, 1, 60))
                  }
                  className={`${INPUT_CLASS} w-24`}
                />
              </OverrideControl>
            </SettingRow>

            {/* Colleague research is campaign-specific: a plain campaign
                control (no inherit/customize ceremony), still stored in the
                same overrides document — the workspace value is only the
                silent starting default. */}
            <SettingRow
              label="Colleague research"
              description="Search the web when a reply points elsewhere."
            >
              <div className="flex flex-col gap-3">
                <div className="flex lg:justify-start">
                  <Toggle
                    checked={form.colleagueResearchEnabled ?? aiSettings.colleagueResearchEnabled}
                    onChange={(next) => setField("colleagueResearchEnabled", next)}
                    disabled={savingOverrides}
                    label="Colleague research"
                  />
                </div>
                <div className="flex flex-col gap-1.5 border-l border-border pl-3">
                  <label className="text-[11px] font-medium text-muted-foreground">
                    Roles hint
                  </label>
                  <input
                    value={form.colleagueRolesHint ?? aiSettings.colleagueRolesHint ?? ""}
                    onChange={(event) => setField("colleagueRolesHint", event.target.value)}
                    disabled={
                      savingOverrides ||
                      !(form.colleagueResearchEnabled ?? aiSettings.colleagueResearchEnabled)
                    }
                    placeholder="e.g. VP of Sales, Head of Partnerships"
                    maxLength={300}
                    className={`${INPUT_CLASS} disabled:opacity-50`}
                  />
                  <p className="text-[11px] leading-relaxed text-muted-foreground">
                    Titles the AI prioritizes when finding the right colleague for this campaign.
                  </p>
                </div>
              </div>
            </SettingRow>
          </SettingGroup>

          {overridesDirty ? (
            <SaveBar
              saving={savingOverrides}
              onCancel={cancelOverrides}
              onSave={saveOverrides}
              label="Unsaved overrides"
              saveLabel="Save overrides"
            />
          ) : null}
        </div>
      ) : null}

      {/* ── Categories: per-category tri-states ── */}
      {section === "categories" ? (
        <div className="flex flex-col gap-6">
          <SettingGroup
            title="Per-category behavior"
            description="Override what each reply category does on this campaign. Each control uses your workspace default until you set On or Off."
          >
            {categories.map((category) => {
              const ov = form.categories?.[category.value] ?? {};
              const effectiveDraftOn =
                ov.draftReply === true || (ov.draftReply == null && category.draftReply);
              const catCustomized =
                ov.suppress === true ||
                ov.suppress === false ||
                ov.dnc === true ||
                ov.dnc === false ||
                ov.draftReply === true ||
                ov.draftReply === false ||
                (typeof ov.draftGuidance === "string" && ov.draftGuidance.trim().length > 0);
              const open = guidanceOpen[category.value] ?? false;

              const setCat = (field: keyof CategoryOverride, value: boolean | string | undefined) =>
                setForm((prev) => {
                  const cats = { ...(prev.categories ?? {}) };
                  const current = { ...(cats[category.value] ?? {}) };
                  if (value === undefined) delete current[field];
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any
                  else (current as any)[field] = value;
                  cats[category.value] = current;
                  return { ...prev, categories: cats };
                });

              return (
                <div key={category.id} className="px-4 py-3.5">
                  <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between lg:gap-6">
                    <div className="flex items-center gap-2 lg:w-[180px] lg:shrink-0 lg:pt-1">
                      <span
                        className={`size-2.5 shrink-0 rounded-full ${dotClass(
                          category.color,
                          category.sentimentType,
                        )}`}
                        aria-hidden
                      />
                      <span className="min-w-0 truncate text-[12.5px] font-medium">{category.label}</span>
                      {catCustomized ? <CustomizedDot /> : null}
                    </div>

                    <div className="flex flex-wrap gap-4">
                      <TriSegment
                        caption="Draft replies"
                        value={ov.draftReply}
                        inherited={category.draftReply}
                        onChange={(next) => setCat("draftReply", next)}
                        disabled={savingOverrides}
                      />
                      <TriSegment
                        caption="Suppress"
                        value={ov.suppress}
                        inherited={category.suppress}
                        onChange={(next) => setCat("suppress", next)}
                        disabled={savingOverrides}
                      />
                      <TriSegment
                        caption="Block list"
                        value={ov.dnc}
                        inherited={category.dnc}
                        onChange={(next) => setCat("dnc", next)}
                        disabled={savingOverrides}
                      />
                    </div>
                  </div>

                  {effectiveDraftOn ? (
                    <div className="mt-3">
                      <button
                        type="button"
                        onClick={() => toggleGuidance(category.value)}
                        aria-expanded={open}
                        className="flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground transition-colors hover:text-foreground"
                      >
                        <ChevronDown
                          className={`size-3.5 transition-transform ${open ? "" : "-rotate-90"}`}
                        />
                        Draft guidance
                        {ov.draftGuidance != null ? <CustomizedDot /> : null}
                      </button>

                      {open ? (
                        <div className="mt-2">
                          {ov.draftGuidance != null ? (
                            <div className="flex flex-col gap-1.5">
                              <textarea
                                value={ov.draftGuidance}
                                onChange={(event) => setCat("draftGuidance", event.target.value)}
                                placeholder="How should the AI draft replies here on this campaign?"
                                maxLength={2000}
                                rows={2}
                                className={TEXTAREA_MULTI}
                              />
                              <button
                                type="button"
                                disabled={savingOverrides}
                                onClick={() => setCat("draftGuidance", undefined)}
                                className="self-start text-[11px] font-medium text-muted-foreground transition-colors hover:text-foreground"
                              >
                                Reset to default
                              </button>
                            </div>
                          ) : (
                            <button
                              type="button"
                              disabled={savingOverrides}
                              onClick={() => setCat("draftGuidance", category.draftGuidance ?? "")}
                              className="self-start text-[11px] font-medium text-primary transition-colors hover:opacity-80"
                            >
                              Edit guidance
                            </button>
                          )}
                        </div>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              );
            })}

            {categories.length === 0 ? (
              <div className="px-4 py-6 text-center text-[12px] text-muted-foreground">
                No active categories to override.
              </div>
            ) : null}
          </SettingGroup>

          {overridesDirty ? (
            <SaveBar
              saving={savingOverrides}
              onCancel={cancelOverrides}
              onSave={saveOverrides}
              label="Unsaved overrides"
              saveLabel="Save overrides"
            />
          ) : null}
        </div>
      ) : null}
      </div>

      {/* ── Full-screen sequence editor takeover ── */}
      {editorStep !== null && seqDrafts && seqBaseline && seqDrafts.length > 0 ? (
        <SequenceEditor
          campaignName={detail.name}
          campaignId={detail.id}
          drafts={seqDrafts}
          initialStep={editorStep}
          onPatchStep={patchStepDraft}
          onPatchStepBody={patchStepBody}
          onPatchVariant={patchVariantDraft}
          onSplitStep={splitStepIntoVariants}
          onAddVariant={addVariantToStep}
          onRemoveVariant={removeVariantFromStep}
          onAddStep={addStep}
          onRemoveStep={removeStep}
          onMoveStep={moveStep}
          dirty={seqDirty}
          saving={savingSequence}
          onSave={saveSequence}
          onDiscard={cancelSequence}
          onExit={() => setEditorStep(null)}
          senderName={(form.senderName ?? aiSettings.senderName).trim() || "You"}
          previewLead={previewLead}
          previewLeadLoading={previewLeadLoading}
          onEnsurePreviewLead={ensurePreviewLead}
          onSelectPreviewLead={selectPreviewLead}
        />
      ) : null}
    </div>
  );
}
