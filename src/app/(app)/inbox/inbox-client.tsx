"use client";

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useTransition,
  type ComponentType,
} from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  ArrowDownWideNarrow,
  ArrowRight,
  ArrowUpNarrowWide,
  Ban,
  Bot,
  Check,
  ChevronDown,
  Clock,
  Copy,
  CornerUpLeft,
  Database,
  Ellipsis,
  ExternalLink,
  History,
  Inbox as InboxIcon,
  Loader2,
  MailQuestion,
  MailX,
  PanelRightClose,
  PenLine,
  RefreshCw,
  RotateCcw,
  Search,
  Send,
  ShieldAlert,
  Sparkles,
  Tag,
  UserRound,
  Users,
  X,
} from "lucide-react";
import type { Conversation, SendContext, ThreadMessage } from "@/lib/types";
import { splitQuotedText } from "@/lib/replies/quotes";
import { DNC_REASON_LABELS, type ReplyCategory } from "@/lib/taxonomy";
import {
  approveProposalAction,
  cancelScheduledReplyAction,
  declineProposalAction,
  drainRepliesAction,
  loadThreadAction,
  regenerateProposalAction,
  scheduleReplyAction,
  sendReplyAction,
  setProposalCategoryAction,
} from "./actions";
import { useToast } from "../toast";

type Tab = "pending" | "all" | "done";
type Proposal = Conversation["proposals"][number];

// Quick-filter chips: each ANDs an orthogonal predicate onto the list.
type FlagFilter = "referral" | "blocked" | "positive";
const FLAG_LABELS: Record<FlagFilter, string> = {
  referral: "Referrals",
  blocked: "Blocked / DNC",
  positive: "Positive leads",
};

function matchesFlag(conv: Conversation, flag: FlagFilter, positiveValues: Set<string>): boolean {
  const latest = conv.proposals[0];
  if (flag === "referral") return Boolean(latest?.isReferral);
  if (flag === "blocked") return Boolean(latest?.actionDnc || latest?.actionSuppress);
  // "Positive leads" = the conversation's current tag is a positive-sentiment
  // category (Interested / Meeting Request / Information Request, plus any
  // custom positive tag). Driven by the tag itself — NOT the classifier's
  // separate positive_lead hint, which can fire on a neutral/negative tag.
  return conv.categoryValue
    ? positiveValues.has(conv.categoryValue)
    : conv.sentimentType === "positive";
}

// Thread cache entry — loading is DERIVED (absent entry === still fetching),
// which keeps the fetch effect free of synchronous setState.
type ScheduledReplyInfo = { id: string; body: string; scheduledAt: string };
type ThreadState = {
  messages: ThreadMessage[];
  sendContext: SendContext;
  scheduledReply: ScheduledReplyInfo | null;
};

// Schedule-send presets (mirror of the server contract; label + fixed hint).
type SchedulePresetKey = "in_3_hours" | "tomorrow_morning" | "tomorrow_afternoon" | "monday_morning";
const SCHEDULE_PRESETS: { key: SchedulePresetKey; label: string; hint: string }[] = [
  { key: "in_3_hours", label: "In 3 hours", hint: "" },
  { key: "tomorrow_morning", label: "Tomorrow morning", hint: "8:00 AM" },
  { key: "tomorrow_afternoon", label: "Tomorrow afternoon", hint: "1:00 PM" },
  { key: "monday_morning", label: "Monday morning", hint: "8:00 AM" },
];

const RAIL_COLLAPSED_KEY = "inbox.ai-rail-collapsed";

const FIELD_LABELS: Record<string, string> = {
  replied: "Replied",
  sentiment: "Sentiment",
  positive_lead: "Positive lead",
  referred: "Referred us",
  referee_name: "Referral name",
  notes_person: "Notes",
  latest_response: "Latest response",
  last_reply_date: "Last reply",
};

// Six hashed avatar tones (+ brand for our own outbound), matching the mockup.
const TONES = ["emerald", "amber", "sky", "violet", "rose", "teal"] as const;
type Tone = (typeof TONES)[number] | "brand";

// Both themes live in the --tone-* tokens (globals.css), so the class list
// carries no literal colour and needs no dark: variant.
const TONE_CLASS: Record<Tone, string> = {
  emerald: "bg-tone-emerald-bg text-tone-emerald-fg",
  amber: "bg-tone-amber-bg text-tone-amber-fg",
  sky: "bg-tone-sky-bg text-tone-sky-fg",
  violet: "bg-tone-violet-bg text-tone-violet-fg",
  rose: "bg-tone-rose-bg text-tone-rose-fg",
  teal: "bg-tone-teal-bg text-tone-teal-fg",
  brand: "bg-primary/10 text-primary",
};

const BTN_BASE =
  "inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-md font-medium transition disabled:cursor-not-allowed disabled:opacity-50";
const BTN_PRIMARY = `${BTN_BASE} bg-primary text-primary-foreground shadow-xs hover:opacity-90`;
const BTN_OUTLINE = `${BTN_BASE} border border-border bg-surface text-foreground shadow-xs hover:border-border-strong hover:bg-muted/60`;
const BTN_SUBTLE = `${BTN_BASE} bg-transparent text-muted-foreground hover:bg-muted/70 hover:text-foreground`;
const BTN_GHOST = `${BTN_BASE} bg-transparent text-foreground hover:bg-muted/70`;

type BadgeVariant = "outline" | "success" | "info" | "warning" | "ghost" | "destructive";
const BADGE_VARIANT: Record<BadgeVariant, string> = {
  outline: "border border-border bg-surface font-normal text-foreground",
  success: "bg-success-soft text-success",
  info: "bg-info-soft text-info",
  warning: "bg-warning-soft text-warning",
  ghost: "bg-muted text-muted-foreground",
  destructive: "bg-destructive-soft text-destructive",
};

// Displayed times use the workspace timezone/locale (threaded from settings),
// pinned so server and client render identical strings (no hydration mismatch).
function timeLabel(iso: string, timeZone: string, timeLocale: string) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const diff = Date.now() - date.getTime();
  if (diff < 60_000) return "now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h`;
  if (diff < 7 * 86_400_000) return date.toLocaleDateString(timeLocale, { weekday: "short", timeZone });
  return date.toLocaleDateString(timeLocale, { month: "short", day: "numeric", timeZone });
}

function fullTime(iso: string, timeZone: string, timeLocale: string) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString(timeLocale, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone,
    timeZoneName: "short", // e.g. "Jul 8, 3:57 PM EDT"
  });
}

function shortDate(iso: string, timeZone: string, timeLocale: string) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString(timeLocale, { month: "short", day: "numeric", timeZone });
}

function initialsOf(name: string) {
  return (
    name
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part[0]?.toUpperCase())
      .join("") || "?"
  );
}

function avatarTone(seed: string): Exclude<Tone, "brand"> {
  let hash = 0;
  for (let i = 0; i < seed.length; i += 1) hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
  return TONES[hash % TONES.length];
}

function changeValueLabel(key: string, value: unknown, timeZone: string, timeLocale: string): string {
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (value == null) return "—";
  const text = String(value);
  if (key === "last_reply_date") return fullTime(text, timeZone, timeLocale);
  return text.length > 90 ? `${text.slice(0, 90)}…` : text;
}

function previewOf(text: string) {
  return text.replace(/\s+/g, " ").trim();
}

/** Derived list-row / thread status pill. */
function statusOf(conv: Conversation): { label: string; variant: BadgeVariant } | null {
  if (conv.hasPending) return { label: "Needs review", variant: "warning" };
  const proposal = conv.proposals[0];
  if (!proposal) return null;
  if (proposal.status === "approved") return { label: "Approved", variant: "success" };
  if (proposal.status === "declined") return { label: "Declined", variant: "ghost" };
  return null;
}

function categoryLabel(conv: Conversation, labelByValue: Map<string, string>): string | null {
  if (conv.categoryValue) {
    return labelByValue.get(conv.categoryValue) ?? conv.proposals[0]?.sentiment ?? conv.categoryValue;
  }
  return conv.proposals[0]?.sentiment ?? null;
}

/* ── Shared presentational atoms ──────────────────────────────────────── */

/**
 * Official LinkedIn "in" bug (blue rounded square, white glyph) as an inline
 * SVG — brand colors are hardcoded so surrounding text color can't recolor it.
 */
function LinkedInLogo({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden="true" focusable="false">
      <rect width="24" height="24" rx="4" fill="#0A66C2" />
      <path
        fill="#ffffff"
        transform="translate(3.6 3.6) scale(0.7)"
        d="M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433a2.062 2.062 0 1 1 0-4.125 2.062 2.062 0 0 1 0 4.125zM7.119 20.452H3.555V9h3.564v11.452z"
      />
    </svg>
  );
}

function Avatar({ tone, initials, className, src }: { tone: Tone; initials: string; className?: string; src?: string | null }) {
  // Real profile picture when we have one (our sending inboxes carry the same
  // image Zapmail applied); a load failure quietly falls back to initials.
  const [broken, setBroken] = useState(false);
  if (src && !broken) {
    return (
      // eslint-disable-next-line @next/next/no-img-element -- external CDN avatar with graceful fallback
      <img
        src={src}
        alt=""
        onError={() => setBroken(true)}
        className={`shrink-0 rounded-full object-cover ${className ?? "size-8"}`}
      />
    );
  }
  return (
    <span
      className={`flex shrink-0 items-center justify-center rounded-full font-semibold tracking-tight ${TONE_CLASS[tone]} ${className ?? "size-8 text-[11px]"}`}
    >
      {initials}
    </span>
  );
}

function Badge({
  variant,
  children,
  className,
}: {
  variant: BadgeVariant;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2 text-[11px] font-medium leading-5 tracking-tight ${BADGE_VARIANT[variant]} ${className ?? ""}`}
    >
      {children}
    </span>
  );
}

function Module({
  title,
  icon: Icon,
  children,
}: {
  title: string;
  icon: ComponentType<{ className?: string }>;
  children: React.ReactNode;
}) {
  const [collapsed, setCollapsed] = useState(false);
  return (
    <div className="shrink-0 overflow-hidden rounded-lg border border-border bg-background">
      <button
        type="button"
        onClick={() => setCollapsed((value) => !value)}
        className="flex w-full items-center gap-1.5 px-3 py-2.5 text-left text-[10px] font-semibold uppercase tracking-[0.08em] text-foreground-subtle transition hover:bg-muted/40"
      >
        <Icon className="size-3.5 shrink-0 text-primary" />
        <span>{title}</span>
        <ChevronDown
          className={`ml-auto size-3.5 text-muted-foreground transition-transform duration-200 ${collapsed ? "-rotate-90" : ""}`}
        />
      </button>
      <div
        className={`grid transition-all duration-200 ease-premium ${collapsed ? "grid-rows-[0fr] opacity-0" : "grid-rows-[1fr] opacity-100"}`}
      >
        <div className="min-h-0 overflow-hidden">
          <div className="px-3 pb-3">{children}</div>
        </div>
      </div>
    </div>
  );
}

/** LinkedIn-style profile preview for the selected lead (right rail). */
function LinkedInModule({ conversation }: { conversation: Conversation }) {
  if (!conversation.linkedinUrl) return null;
  const headline = [conversation.title, conversation.company].filter(Boolean).join(" at ");
  const industry = conversation.industry
    ? conversation.industry.charAt(0).toUpperCase() + conversation.industry.slice(1)
    : null;
  const meta = [
    industry,
    conversation.employeeCount != null ? `${conversation.employeeCount.toLocaleString()} employees` : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <Module title="LinkedIn" icon={LinkedInLogo}>
      <div className="flex items-start gap-2.5">
        <Avatar tone={avatarTone(conversation.name)} initials={initialsOf(conversation.name)} />
        <div className="min-w-0">
          <div className="truncate text-[13px] font-semibold tracking-tight">{conversation.name}</div>
          {headline ? <div className="text-[12px] leading-snug text-muted-foreground">{headline}</div> : null}
          {meta ? <div className="mt-0.5 text-[11.5px] text-muted-foreground">{meta}</div> : null}
        </div>
      </div>
      <a
        href={conversation.linkedinUrl}
        target="_blank"
        rel="noopener noreferrer"
        referrerPolicy="no-referrer"
        aria-label={`View ${conversation.name}'s LinkedIn profile (opens in new tab)`}
        className={`${BTN_OUTLINE} mt-2.5 h-8 w-full px-3 text-xs`}
      >
        <LinkedInLogo className="size-3.5 shrink-0" />
        View profile
      </a>
    </Module>
  );
}

/* ── Thread message row ───────────────────────────────────────────────── */

function MessageRow({
  message,
  senderName,
  tone,
  avatarSrc,
  defaultOpen,
  counterparty,
  timeZone,
  timeLocale,
}: {
  message: ThreadMessage;
  senderName: string;
  tone: Tone;
  avatarSrc?: string | null;
  defaultOpen: boolean;
  counterparty: string;
  timeZone: string;
  timeLocale: string;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const [quotedOpen, setQuotedOpen] = useState(false);
  const initials = initialsOf(senderName);
  const senderEmail = message.from.includes("@") ? message.from : null;
  const toLine = message.to || counterparty;
  const { visible, quoted } = useMemo(() => splitQuotedText(message.bodyText), [message.bodyText]);

  return (
    <div className="border-b border-border last:border-b-0" data-latest-message={defaultOpen ? "true" : undefined}>
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-start gap-3 rounded-md px-1 py-3 text-left transition hover:bg-muted/30"
      >
        <Avatar tone={tone} initials={initials} src={avatarSrc} className="mt-0.5 size-8 text-[11px]" />
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
            <span className="truncate text-[13.5px] font-semibold tracking-tight">{senderName}</span>
            {open && senderEmail ? (
              <span className="text-[11.5px] text-muted-foreground">&lt;{senderEmail}&gt;</span>
            ) : null}
            <span className="ml-auto shrink-0 text-[11.5px] tabular text-muted-foreground">{fullTime(message.time, timeZone, timeLocale)}</span>
          </span>
          {open ? (
            toLine ? (
              <span className="mt-0.5 block text-[11.5px] text-muted-foreground">
                to <span className="text-muted-foreground/80">{toLine}</span>
              </span>
            ) : null
          ) : (
            <span className="mt-0.5 block truncate text-[12.5px] text-muted-foreground">
              {previewOf(visible || message.bodyText)}
            </span>
          )}
        </span>
      </button>
      <div
        className={`grid transition-all duration-200 ease-premium ${open ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0"}`}
      >
        <div className="min-h-0 overflow-hidden">
          <div className="pb-5 pl-12 pr-1">
            {visible ? <div className="whitespace-pre-wrap text-[14px] leading-7">{visible}</div> : null}
            {quoted ? (
              <div className={visible ? "mt-2" : ""}>
                <button
                  type="button"
                  onClick={() => setQuotedOpen((value) => !value)}
                  className="inline-flex items-center gap-1.5 rounded-md border border-border bg-muted/50 px-2 py-0.5 text-[11px] font-medium text-muted-foreground transition hover:bg-muted hover:text-foreground"
                >
                  <Ellipsis className="size-3.5" />
                  {quotedOpen ? "Hide quoted text" : "Show quoted text"}
                </button>
                {quotedOpen ? (
                  <div className="mt-2 whitespace-pre-wrap border-l-2 border-border pl-3 text-[13px] leading-6 text-muted-foreground">
                    {quoted}
                  </div>
                ) : null}
              </div>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}

/* ── Flat divided thread (keyed by conversation so group toggle resets) ─── */

function ThreadList({
  selected,
  messages,
  threadLoading,
  timeZone,
  timeLocale,
  inboxAvatars,
}: {
  selected: Conversation;
  messages: ThreadMessage[];
  threadLoading: boolean;
  timeZone: string;
  timeLocale: string;
  inboxAvatars: Record<string, string>;
}) {
  const [outreachOpen, setOutreachOpen] = useState(false);

  const leadTone = avatarTone(selected.name);
  const firstInbound = messages.findIndex((m) => m.direction === "inbound");
  const groupCount = firstInbound > 0 ? firstInbound : 0;
  const leading = groupCount > 0 ? messages.slice(0, groupCount) : [];
  const rest = groupCount > 0 ? messages.slice(groupCount) : messages;
  const lastIndex = messages.length - 1;

  const rowFor = (message: ThreadMessage, globalIndex: number) => (
    <MessageRow
      key={`${message.time}-${globalIndex}`}
      message={message}
      senderName={message.direction === "outbound" ? (message.fromName ?? "You") : selected.name}
      tone={message.direction === "outbound" ? "brand" : leadTone}
      // Our outbound mail wears the sending inbox's real profile picture (the
      // one Zapmail applied), matched by the from address.
      avatarSrc={message.direction === "outbound" && message.from.includes("@") ? inboxAvatars[message.from.trim().toLowerCase()] ?? null : null}
      counterparty={message.direction === "outbound" ? selected.leadEmail : "you"}
      defaultOpen={globalIndex === lastIndex}
      timeZone={timeZone}
      timeLocale={timeLocale}
    />
  );

  const dateRange =
    leading.length > 0
      ? (() => {
          const first = shortDate(leading[0].time, timeZone, timeLocale);
          const last = shortDate(leading[leading.length - 1].time, timeZone, timeLocale);
          return first === last ? first : `${first} – ${last}`;
        })()
      : "";

  return (
    <div>
      {leading.length > 0 ? (
        <div className="mb-1">
          <button
            type="button"
            onClick={() => setOutreachOpen((value) => !value)}
            className="flex w-full items-center gap-2 rounded-md px-1 py-2.5 text-left text-[12.5px] text-muted-foreground transition hover:bg-muted/30 hover:text-foreground"
          >
            <History className="size-3.5 shrink-0" />
            {leading.length} earlier outreach email{leading.length > 1 ? "s" : ""}
            {dateRange ? ` · ${dateRange}` : ""}
            <ChevronDown
              className={`ml-auto size-3.5 transition-transform duration-200 ${outreachOpen ? "" : "-rotate-90"}`}
            />
          </button>
          {outreachOpen ? (
            <div className="border-t border-dashed border-border">
              {leading.map((message, index) => rowFor(message, index))}
            </div>
          ) : null}
        </div>
      ) : null}

      {rest.map((message, index) => rowFor(message, groupCount + index))}

      {threadLoading ? (
        <p className="flex items-center gap-1.5 py-3 text-[11.5px] text-muted-foreground">
          <Loader2 className="size-3 animate-spin" /> Syncing full thread from Smartlead…
        </p>
      ) : null}
    </div>
  );
}

/* ── Re-run editor (keyed by proposal so it resets on switch/replace) ───── */

function ReRunSection({
  proposalId,
  busy,
  onRerun,
}: {
  proposalId: string;
  busy: string | null;
  onRerun: (note: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const busyThis = busy === `regen-${proposalId}`;

  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)} className={`${BTN_SUBTLE} mt-2 h-8 w-full text-[13px]`}>
        Add context &amp; re-run analysis
      </button>
    );
  }

  return (
    <div className="mt-2">
      <textarea
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        rows={3}
        autoFocus
        placeholder="What did the AI get wrong? e.g. “This is actually a meeting request, so book it.”"
        className="w-full resize-y rounded-md border border-border bg-surface px-2.5 py-2 text-[12.5px] leading-relaxed outline-none transition placeholder:text-muted-foreground focus:border-ring focus:ring-2 focus:ring-ring/20"
      />
      <div className="mt-2 flex justify-end gap-2">
        <button type="button" onClick={() => setOpen(false)} className={`${BTN_GHOST} h-7 px-2.5 text-xs`}>
          Cancel
        </button>
        <button
          type="button"
          disabled={busy !== null || !draft.trim()}
          onClick={() => onRerun(draft)}
          className={`${BTN_PRIMARY} h-7 px-2.5 text-xs`}
        >
          {busyThis ? <Loader2 className="size-3 animate-spin" /> : <RotateCcw className="size-3" />}
          Re-run analysis
        </button>
      </div>
    </div>
  );
}

/* ── Main client ──────────────────────────────────────────────────────── */

export function InboxClient({
  conversations,
  categories,
  timeZone,
  timeLocale,
  untrackedCount,
  inboxAvatars = {},
}: {
  conversations: Conversation[];
  categories: ReplyCategory[];
  timeZone: string;
  timeLocale: string;
  untrackedCount: number;
  /** Sending-inbox email -> real profile picture URL (from Zapmail). */
  inboxAvatars?: Record<string, string>;
}) {
  const router = useRouter();
  const [tab, setTab] = useState<Tab>("pending");
  const [query, setQuery] = useState("");
  const [categoryFilter, setCategoryFilter] = useState<string>("all");
  const [campaignFilter, setCampaignFilter] = useState<string>("all");
  const [flagFilters, setFlagFilters] = useState<Set<FlagFilter>>(new Set());
  const [sortOrder, setSortOrder] = useState<"newest" | "oldest">("newest");
  const [selectedKeyState, setSelectedKeyState] = useState<string | null>(null);
  const [threads, setThreads] = useState<Record<string, ThreadState>>({});
  const [composer, setComposer] = useState<Record<string, string>>({});
  const [sendKeys, setSendKeys] = useState<Record<string, string>>({});
  const [scheduleMenuOpen, setScheduleMenuOpen] = useState(false);
  const [customScheduleOpen, setCustomScheduleOpen] = useState(false);
  const [customScheduleValue, setCustomScheduleValue] = useState("");
  const [customScheduleMin, setCustomScheduleMin] = useState("");
  // Right rail starts open (matches the server render); the stored preference
  // is applied after mount so small screens keep it tucked away across visits.
  const [railOpen, setRailOpen] = useState(true);
  // Floating-sheet reply: the composer is closed until Reply (or R) opens it.
  const [replyOpen, setReplyOpen] = useState(false);
  /* The open sheet floats over the thread, so the scroller needs exactly the
     sheet's height as extra bottom clearance — otherwise the end of the email
     can never scroll out from underneath it. Measured live because the
     textarea is user-resizable. */
  const sheetRef = useRef<HTMLDivElement | null>(null);
  const [sheetHeight, setSheetHeight] = useState(0);
  const showToast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const [, startTransition] = useTransition();
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  // Synchronous double-click guard for sends (state updates are async).
  const sendingRef = useRef(false);
  // Keys we've already kicked off a thread fetch for — prevents refetch loops
  // without any synchronous setState inside the effect.
  const fetchingRef = useRef<Set<string>>(new Set());

  const campaigns = useMemo(
    () => [...new Set(conversations.map((c) => c.campaignName).filter(Boolean))].sort() as string[],
    [conversations],
  );

  const categoryLabelByValue = useMemo(
    () => new Map(categories.map((category) => [category.value, category.label])),
    [categories],
  );

  const positiveCategoryValues = useMemo(
    () =>
      new Set(
        categories.filter((category) => category.sentimentType === "positive").map((category) => category.value),
      ),
    [categories],
  );

  const hasActiveFilters = categoryFilter !== "all" || campaignFilter !== "all" || flagFilters.size > 0;

  const clearFilters = () => {
    setCategoryFilter("all");
    setCampaignFilter("all");
    setFlagFilters(new Set());
  };

  const toggleFlag = (flag: FlagFilter) => {
    // Flag pills (Referrals / Blocked / Positive leads) filter on a lead-level
    // attribute that spans review states — a positive lead is often already
    // handled. Turning one ON widens the tab to "All" so the pill actually
    // reveals its matches instead of silently ANDing with an empty review queue.
    const adding = !flagFilters.has(flag);
    setFlagFilters((prev) => {
      const next = new Set(prev);
      if (next.has(flag)) next.delete(flag);
      else next.add(flag);
      return next;
    });
    if (adding) setTab("all");
  };

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = conversations.filter((c) => {
      if (tab === "pending" && !c.hasPending) return false;
      if (tab === "done" && (c.hasPending || c.proposals.length === 0)) return false;
      if (categoryFilter !== "all" && c.categoryValue !== categoryFilter) return false;
      if (campaignFilter !== "all" && c.campaignName !== campaignFilter) return false;
      for (const flag of flagFilters) if (!matchesFlag(c, flag, positiveCategoryValues)) return false;
      if (!q) return true;
      return [c.name, c.leadEmail, c.company ?? "", c.snippet, c.campaignName ?? ""]
        .join(" ")
        .toLowerCase()
        .includes(q);
    });
    return list.sort((a, b) =>
      sortOrder === "newest" ? b.latestAt.localeCompare(a.latestAt) : a.latestAt.localeCompare(b.latestAt),
    );
  }, [conversations, tab, query, categoryFilter, campaignFilter, flagFilters, sortOrder, positiveCategoryValues]);

  // Effective selection is DERIVED (no effect / no setState-in-effect): use the
  // explicit pick when it still exists, otherwise fall back to the active filter.
  const selectedKey = useMemo(() => {
    if (selectedKeyState && conversations.some((c) => c.key === selectedKeyState)) return selectedKeyState;
    return filtered[0]?.key ?? conversations[0]?.key ?? null;
  }, [selectedKeyState, conversations, filtered]);

  const selected = useMemo(
    () => conversations.find((c) => c.key === selectedKey) ?? null,
    [conversations, selectedKey],
  );

  // Cache the authoritative thread per (conversation, latest event) so a NEW
  // inbound reply refetches, while re-selecting an unchanged thread does not.
  const latestEventId = selected?.events[selected.events.length - 1]?.id ?? null;
  const threadKey = selected && latestEventId ? `${selected.key}:${latestEventId}` : null;

  useEffect(() => {
    if (!threadKey || !latestEventId) return;
    if (threads[threadKey] || fetchingRef.current.has(threadKey)) return;
    fetchingRef.current.add(threadKey);
    loadThreadAction(latestEventId)
      .then((result) => {
        setThreads((prev) => ({
          ...prev,
          [threadKey]: { messages: result.messages, sendContext: result.sendContext, scheduledReply: result.scheduledReply },
        }));
      })
      .catch(() => {
        setThreads((prev) => ({ ...prev, [threadKey]: { messages: [], sendContext: null, scheduledReply: null } }));
      })
      .finally(() => {
        fetchingRef.current.delete(threadKey);
      });
  }, [threadKey, latestEventId, threads]);

  useEffect(() => {
    // Deferred so the read+setState lands outside the effect body (host idiom)
    // and never mismatches the server's expanded render.
    const t = window.setTimeout(() => {
      try {
        if (window.localStorage.getItem(RAIL_COLLAPSED_KEY) === "1") setRailOpen(false);
      } catch {
        // localStorage unavailable, so the rail just starts expanded.
      }
    }, 0);
    return () => window.clearTimeout(t);
  }, []);

  const toggleRail = () => {
    const next = !railOpen;
    setRailOpen(next);
    try {
      window.localStorage.setItem(RAIL_COLLAPSED_KEY, next ? "0" : "1");
    } catch {
      // localStorage unavailable, so the choice just won't persist.
    }
  };

  const run = (id: string, action: () => Promise<{ ok: boolean; message: string }>) => {
    setBusy(id);
    action()
      .then((result) => {
        showToast(result.ok, result.message);
        startTransition(() => router.refresh());
      })
      .catch(() => showToast(false, "Something went wrong."))
      .finally(() => setBusy(null));
  };

  const thread = threadKey ? threads[threadKey] : undefined;
  const threadLoading = threadKey != null && thread === undefined;

  const fallbackMessages: ThreadMessage[] = selected
    ? selected.events.map((event) => ({
        direction: "inbound" as const,
        from: selected.leadEmail,
        fromName: null,
        to: "",
        subject: event.subject ?? "",
        bodyText: event.bodyText,
        time: event.receivedAt,
      }))
    : [];
  const messages = thread && thread.messages.length > 0 ? thread.messages : fallbackMessages;
  const sendContext = thread?.sendContext ?? null;

  // Bring the newest message into view on conversation switch and first thread
  // load; sends and re-renders within the same conversation don't re-scroll.
  const scrolledMarkerRef = useRef<string | null>(null);
  useEffect(() => {
    const container = scrollRef.current;
    if (!selectedKey || !container) return;
    const marker = `${selectedKey}:${messages.length > 0 ? "loaded" : "empty"}`;
    if (scrolledMarkerRef.current === marker) return;
    scrolledMarkerRef.current = marker;
    const latest = container.querySelector<HTMLElement>('[data-latest-message="true"]');
    if (latest) latest.scrollIntoView({ block: "nearest" });
    else container.scrollTo({ top: 0 });
  }, [selectedKey, messages.length]);

  const activeProposal: Proposal | null = selected
    ? (selected.proposals.find((p) => p.status === "pending") ?? selected.proposals[0] ?? null)
    : null;

  const composerValue = selected ? (composer[selected.key] ?? "") : "";

  const handleSend = () => {
    if (!selected || !latestEventId || !composerValue.trim() || sendingRef.current) return;
    sendingRef.current = true;
    const key = selected.key;
    const idempotencyKey = sendKeys[key] ?? crypto.randomUUID();
    setBusy("send");
    sendReplyAction({ eventId: latestEventId, body: composerValue, idempotencyKey })
      .then((result) => {
        showToast(result.ok, result.message);
        // Rotate the key after every attempt: a failed Smartlead send keeps
        // its reply_sends row, so retrying must use a fresh key.
        setSendKeys((prev) => ({ ...prev, [key]: crypto.randomUUID() }));
        if (result.ok) {
          setComposer((prev) => ({ ...prev, [key]: "" }));
          setReplyOpen(false);
          setThreads((prev) => {
            if (!threadKey) return prev;
            const current = prev[threadKey];
            if (!current) return prev;
            return {
              ...prev,
              [threadKey]: {
                ...current,
                messages: [
                  ...current.messages,
                  {
                    direction: "outbound",
                    from: "you",
                    // Attribute the optimistic bubble like the thread's other
                    // outbound mail (same sending inbox).
                    fromName: [...current.messages].reverse().find((m) => m.direction === "outbound")?.fromName ?? null,
                    to: selected.leadEmail,
                    subject: "",
                    bodyText: composerValue.trim(),
                    time: new Date().toISOString(),
                  },
                ],
              },
            };
          });
          startTransition(() => router.refresh());
        }
      })
      .catch(() => showToast(false, "Send failed."))
      .finally(() => {
        sendingRef.current = false;
        setBusy(null);
      });
  };

  const scheduledReply = thread?.scheduledReply ?? null;

  const scheduleFormatter = useMemo(
    () =>
      new Intl.DateTimeFormat(timeLocale || undefined, {
        weekday: "short",
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
        timeZone,
      }),
    [timeLocale, timeZone],
  );

  // datetime-local floor, computed when the picker opens (an event handler, so
  // the impure clock read is fine). The server does the authoritative validation
  // in the workspace time zone.
  const openCustomSchedule = () => {
    const d = new Date(Date.now() + 60_000);
    const pad = (n: number) => String(n).padStart(2, "0");
    setCustomScheduleMin(
      `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`,
    );
    setCustomScheduleOpen(true);
  };

  const handleSchedule = (when: { preset: SchedulePresetKey } | { customLocal: string }) => {
    if (!selected || !latestEventId || !composerValue.trim() || sendingRef.current) return;
    sendingRef.current = true;
    const key = selected.key;
    const draft = composerValue;
    const idempotencyKey = sendKeys[key] ?? crypto.randomUUID();
    setBusy("schedule");
    setScheduleMenuOpen(false);
    setCustomScheduleOpen(false);
    scheduleReplyAction({ eventId: latestEventId, body: draft, when, idempotencyKey })
      .then((result) => {
        showToast(result.ok, result.message);
        setSendKeys((prev) => ({ ...prev, [key]: crypto.randomUUID() }));
        if (result.ok && result.scheduledAt && result.id) {
          const scheduledAt = result.scheduledAt;
          const id = result.id;
          setComposer((prev) => ({ ...prev, [key]: "" }));
          if (threadKey) {
            setThreads((prev) => {
              const current = prev[threadKey];
              if (!current) return prev;
              return { ...prev, [threadKey]: { ...current, scheduledReply: { id, body: draft, scheduledAt } } };
            });
          }
        }
      })
      .catch(() => showToast(false, "Could not schedule the reply."))
      .finally(() => {
        sendingRef.current = false;
        setBusy(null);
      });
  };

  const handleCancelScheduled = () => {
    if (!selected || !threadKey || !scheduledReply) return;
    const { id, body } = scheduledReply;
    setBusy("cancel-schedule");
    cancelScheduledReplyAction(id)
      .then((result) => {
        showToast(result.ok, result.ok ? "Scheduled reply canceled — draft restored." : result.message);
        if (result.ok) {
          setThreads((prev) => {
            const current = prev[threadKey];
            if (!current) return prev;
            return { ...prev, [threadKey]: { ...current, scheduledReply: null } };
          });
          setComposer((prev) => ({ ...prev, [selected.key]: body }));
          requestAnimationFrame(() => composerRef.current?.focus());
        }
      })
      .catch(() => showToast(false, "Could not cancel the scheduled reply."))
      .finally(() => setBusy(null));
  };

  const copyEmail = () => {
    if (!selected) return;
    navigator.clipboard
      .writeText(selected.leadEmail)
      .then(() => showToast(true, "Email address copied."))
      .catch(() => showToast(false, "Couldn’t copy the email."));
  };

  const useInComposer = () => {
    if (!selected || !activeProposal?.suggestedReply) return;
    setComposer((prev) => ({ ...prev, [selected.key]: activeProposal.suggestedReply ?? "" }));
    setReplyOpen(true);
    requestAnimationFrame(() => composerRef.current?.focus());
  };

  /* Selecting another thread starts with the reply card closed — unless that
     thread already has a draft in progress, which must stay visible. Deferred
     so the read+setState lands outside the effect body (host idiom). */
  useEffect(() => {
    const t = window.setTimeout(() => {
      setReplyOpen(Boolean(selected && (composer[selected.key] ?? "").trim()));
    }, 0);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected?.key]);

  const openReply = (draft?: string) => {
    if (draft !== undefined && selected) {
      setComposer((prev) => ({ ...prev, [selected.key]: draft }));
    }
    setReplyOpen(true);
    requestAnimationFrame(() => composerRef.current?.focus({ preventScroll: true }));
  };

  // ResizeObserver fires once on observe, so this also takes the initial
  // measurement. Re-attached per thread: the sheet element remounts with it.
  useEffect(() => {
    const node = sheetRef.current;
    if (!node) return;
    const observer = new ResizeObserver(() => setSheetHeight(node.offsetHeight));
    observer.observe(node);
    return () => observer.disconnect();
  }, [threadKey, sendContext, scheduledReply]);

  /* "R" opens the reply sheet — the pill advertises it. Ignored while typing
     anywhere, so the list search and the composer keep their letters. */
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "r" && event.key !== "R") return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest("input, textarea, select, [contenteditable=true]")) return;
      if (!selected || !sendContext || scheduledReply || replyOpen) return;
      event.preventDefault();
      openReply();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const pendingCount = conversations.filter((c) => c.hasPending).length;
  const selectedStatus = selected ? statusOf(selected) : null;
  // The inbox this reply will send from — the thread's own outbound mail knows.
  const replyFromEmail =
    [...messages].reverse().find((m) => m.direction === "outbound" && m.from.includes("@"))?.from ??
    null;
  const threadSubject = messages[0]?.subject || selected?.events[selected.events.length - 1]?.subject || "";
  const threadSync = threadLoading
    ? "Syncing…"
    : thread && thread.messages.length > 0
      ? "Synced from Smartlead"
      : "Local copy";

  return (
    <div
      className={`grid h-full min-h-0 ${
        railOpen ? "grid-cols-[336px_minmax(0,1fr)_352px]" : "grid-cols-[336px_minmax(0,1fr)_44px]"
      }`}
    >
      {/* ── List pane ─────────────────────────────────────────────────── */}
      <aside className="flex min-h-0 flex-col border-r border-border bg-surface">
        <div className="flex h-12 shrink-0 items-center gap-1.5 border-b border-border-strong bg-surface px-3">
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search replies"
              className="h-8 w-full rounded-md border border-border bg-surface pl-7 pr-2.5 text-[13px] outline-none transition placeholder:text-muted-foreground focus:border-ring"
            />
          </div>
          <button
            type="button"
            data-tip={sortOrder === "newest" ? "Newest first. Click for oldest first." : "Oldest first. Click for newest first."}
            data-tip-down=""
            aria-label={sortOrder === "newest" ? "Sort newest first" : "Sort oldest first"}
            onClick={() => setSortOrder((order) => (order === "newest" ? "oldest" : "newest"))}
            className="flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition hover:bg-muted/70 hover:text-foreground"
          >
            {sortOrder === "newest" ? <ArrowDownWideNarrow className="size-4" /> : <ArrowUpNarrowWide className="size-4" />}
          </button>
          <button
            type="button"
            data-tip="Check for new replies"
            data-tip-down=""
            aria-label="Check for new replies"
            disabled={busy === "drain"}
            onClick={() => run("drain", () => drainRepliesAction())}
            className="flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition hover:bg-muted/70 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
          >
            {busy === "drain" ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
          </button>
          <Link
            href="/inbox/untracked"
            data-tip="Untracked replies"
            data-tip-down=""
            aria-label={`Untracked replies${untrackedCount > 0 ? ` (${untrackedCount} need review)` : ""}`}
            className="relative flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition hover:bg-muted/70 hover:text-foreground"
          >
            <MailQuestion className="size-4" />
            {untrackedCount > 0 ? (
              <span className="tabular absolute -right-0.5 -top-0.5 min-w-3.5 rounded-full bg-primary px-1 text-center text-[9px] font-semibold leading-[14px] text-primary-foreground">
                {untrackedCount > 99 ? "99+" : untrackedCount}
              </span>
            ) : null}
          </Link>
        </div>

        <div className="flex items-baseline gap-2 px-3.5 pb-0.5 pt-3">
          <h2 className="text-[13.5px] font-semibold tracking-tight">Inbox</h2>
          <span className="tabular rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
            {conversations.length}
          </span>
          {pendingCount > 0 ? (
            <span className="ml-auto text-[11px] font-semibold text-primary">{pendingCount} need review</span>
          ) : null}
        </div>

        <div className="mx-3 my-2 flex shrink-0 gap-1 rounded-md bg-muted/60 p-0.5">
          {(
            [
              ["pending", `Needs review${pendingCount ? ` · ${pendingCount}` : ""}`],
              ["all", "All"],
              ["done", "Handled"],
            ] as [Tab, string][]
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              onClick={() => setTab(value)}
              className={`h-7 flex-auto whitespace-nowrap rounded px-2 text-[11.5px] font-medium transition ${
                tab === value ? "bg-surface text-foreground shadow-xs" : "text-muted-foreground hover:text-foreground"
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        {/* Filters: category / campaign selects + quick flag chips */}
        <div className="flex shrink-0 flex-col gap-1.5 px-3 pb-2">
          <div className="flex gap-1.5">
            <div className="relative flex-1">
              <select
                value={categoryFilter}
                onChange={(event) => setCategoryFilter(event.target.value)}
                aria-label="Filter by category"
                className="h-7 w-full appearance-none rounded-md border border-border bg-surface pl-2 pr-6 text-[11.5px] font-medium text-foreground shadow-xs outline-none transition focus:border-ring"
              >
                <option value="all">All categories</option>
                {categories.map((category) => (
                  <option key={category.value} value={category.value}>
                    {category.label}
                  </option>
                ))}
              </select>
              <ChevronDown className="pointer-events-none absolute right-1.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            </div>
            {campaigns.length > 1 ? (
              <div className="relative flex-1">
                <select
                  value={campaignFilter}
                  onChange={(event) => setCampaignFilter(event.target.value)}
                  aria-label="Filter by campaign"
                  className="h-7 w-full appearance-none rounded-md border border-border bg-surface pl-2 pr-6 text-[11.5px] font-medium text-foreground shadow-xs outline-none transition focus:border-ring"
                >
                  <option value="all">All campaigns</option>
                  {campaigns.map((campaign) => (
                    <option key={campaign} value={campaign}>
                      {campaign}
                    </option>
                  ))}
                </select>
                <ChevronDown className="pointer-events-none absolute right-1.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
              </div>
            ) : null}
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            {(Object.keys(FLAG_LABELS) as FlagFilter[]).map((flag) => (
              <button
                key={flag}
                type="button"
                aria-pressed={flagFilters.has(flag)}
                onClick={() => toggleFlag(flag)}
                className={`rounded-full border px-2 py-0.5 text-[11px] font-medium transition ${
                  flagFilters.has(flag)
                    ? "border-transparent bg-accent text-accent-foreground"
                    : "border-border bg-surface text-muted-foreground hover:text-foreground"
                }`}
              >
                {FLAG_LABELS[flag]}
              </button>
            ))}
            {hasActiveFilters ? (
              <button
                type="button"
                onClick={clearFilters}
                className="ml-auto text-[11px] font-medium text-muted-foreground transition hover:text-foreground"
              >
                Clear
              </button>
            ) : null}
          </div>
        </div>

        <div className="scroll-thin flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto px-2 pb-3">
          {filtered.length === 0 ? (
            <div className="flex flex-col items-center gap-2 px-6 py-16 text-center">
              <InboxIcon className="size-7 text-muted-foreground" />
              <p className="text-xs text-muted-foreground">
                {hasActiveFilters || query
                  ? "No conversations match these filters."
                  : tab === "pending"
                    ? "Nothing needs review. Nice."
                    : "No conversations match."}
              </p>
              {hasActiveFilters ? (
                <button
                  type="button"
                  onClick={clearFilters}
                  className="text-[11px] font-medium text-primary transition hover:underline"
                >
                  Clear filters
                </button>
              ) : null}
            </div>
          ) : (
            filtered.map((conversation) => {
              const isSelected = conversation.key === selectedKey;
              const proposal = conversation.proposals.find((p) => p.status === "pending") ?? conversation.proposals[0];
              const status = statusOf(conversation);
              const category = categoryLabel(conversation, categoryLabelByValue);
              return (
                <button
                  key={conversation.key}
                  type="button"
                  onClick={() => setSelectedKeyState(conversation.key)}
                  className={`relative flex w-full items-start gap-2.5 rounded-lg p-2.5 text-left transition ${
                    isSelected
                      ? "bg-accent before:absolute before:-left-2 before:top-1/2 before:h-7 before:w-[3px] before:-translate-y-1/2 before:rounded-r-full before:bg-primary before:content-['']"
                      : "hover:bg-muted/50"
                  }`}
                >
                  <Avatar
                    tone={avatarTone(conversation.name)}
                    initials={initialsOf(conversation.name)}
                    className="mt-0.5 size-8 text-[11px]"
                  />
                  <span className="min-w-0 flex-1">
                    <span className="flex items-baseline justify-between gap-2">
                      <span
                        className={`truncate text-[13px] tracking-tight ${conversation.hasPending ? "font-semibold" : "font-medium"}`}
                      >
                        {conversation.name}
                      </span>
                      <span
                        className={`tabular shrink-0 text-[11px] ${conversation.hasPending ? "font-semibold text-foreground" : "text-muted-foreground"}`}
                      >
                        {timeLabel(conversation.latestAt, timeZone, timeLocale)}
                      </span>
                    </span>
                    <span className="mt-1 line-clamp-2 text-[12px] leading-snug text-muted-foreground">
                      {conversation.snippet || conversation.company || conversation.leadEmail}
                    </span>
                    <span className="mt-2 flex flex-wrap items-center gap-1.5">
                      {category ? <Badge variant="outline">{category}</Badge> : null}
                      {status ? <Badge variant={status.variant}>{status.label}</Badge> : null}
                      {proposal?.isReferral ? <Badge variant="info">Referral</Badge> : null}
                      {proposal?.actionDnc ? (
                        <Badge variant="destructive">
                          <Ban className="size-3" />
                          {proposal.dncReason === "email_defunct" ? "Dead mailbox" : "DNC"}
                        </Badge>
                      ) : null}
                      {conversation.hasPending ? (
                        <span className="ml-auto size-1.5 shrink-0 rounded-full bg-primary" />
                      ) : null}
                    </span>
                  </span>
                </button>
              );
            })
          )}
        </div>
      </aside>

      {/* ── Thread pane ───────────────────────────────────────────────── */}
      <section className="relative flex min-h-0 min-w-0 flex-col bg-background">
        {selected ? (
          <>
            <div className="flex h-12 shrink-0 items-center gap-2 border-b border-border bg-surface/85 px-3 backdrop-blur">
              <button type="button" onClick={copyEmail} className={`${BTN_OUTLINE} h-8 px-3 text-[13px]`}>
                <Copy className="size-3.5" />
                Copy email
              </button>
              {selected.smartleadUrl ? (
                <a
                  href={selected.smartleadUrl}
                  target="_blank"
                  rel="noreferrer"
                  className={`${BTN_OUTLINE} h-8 px-3 text-[13px]`}
                >
                  <ExternalLink className="size-3.5" />
                  Open in Smartlead
                </a>
              ) : null}
              <div className="flex-1" />
              {selected.campaignName ? (
                <Badge variant="outline" className="hidden lg:inline-flex">
                  {selected.campaignName}
                </Badge>
              ) : null}
            </div>

            <div ref={scrollRef} className="scroll-thin min-h-0 flex-1 overflow-y-auto">
              {threadLoading && messages.length === 0 ? (
                <div className="flex h-full items-center justify-center gap-2 text-xs text-muted-foreground">
                  <Loader2 className="size-4 animate-spin" /> Loading thread…
                </div>
              ) : (
                /* pb-24 clears the floating reply pill; with the sheet open the
                   clearance grows to the sheet's measured height so the end of
                   the email can always scroll out from underneath it. */
                <div
                  className="mx-auto max-w-[720px] px-7 pb-24 pt-6 transition-[padding-bottom] duration-300 ease-[var(--ease-premium)]"
                  style={
                    replyOpen && sendContext && !scheduledReply && sheetHeight > 0
                      ? { paddingBottom: sheetHeight + 32 }
                      : undefined
                  }
                >
                  <div className="flex items-start gap-3">
                    <Avatar
                      tone={avatarTone(selected.name)}
                      initials={initialsOf(selected.name)}
                      className="size-10 text-[13px]"
                    />
                    <div className="min-w-0">
                      <h1 className="text-[16px] font-semibold leading-tight tracking-tight">{selected.name}</h1>
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        &lt;{selected.leadEmail}&gt; · {fullTime(selected.latestAt, timeZone, timeLocale)}
                      </p>
                    </div>
                  </div>

                  <div className="mt-4 grid grid-cols-3 gap-x-4 gap-y-3.5 rounded-xl bg-surface p-4 shadow-xs">
                    <ContextField label="Company" value={selected.company ?? "—"} />
                    <ContextField label="Title" value={selected.title ?? "—"} />
                    <ContextField label="Campaign" value={selected.campaignName ?? "—"} />
                    <ContextField label="Last inbound" value={fullTime(selected.latestAt, timeZone, timeLocale)} tabular />
                    <ContextField
                      label="Status"
                      value={
                        selectedStatus ? <Badge variant={selectedStatus.variant}>{selectedStatus.label}</Badge> : "—"
                      }
                    />
                    <ContextField label="Thread sync" value={threadSync} />
                  </div>

                  <p className="mb-1 mt-6 text-[11px] font-semibold uppercase tracking-[0.08em] text-foreground-subtle">
                    Email thread{threadSubject ? ` · ${threadSubject}` : ""}
                  </p>

                  <ThreadList key={selected.key} selected={selected} messages={messages} threadLoading={threadLoading} timeZone={timeZone} timeLocale={timeLocale} inboxAvatars={inboxAvatars} />

                  {/* ── Reply, variant 2 (floating pill → sheet): the thread
                         stays immersive; composing happens in a sheet that
                         springs up from a floating pill. Only thread-state
                         facts stay inline here: a scheduled reply (a pending
                         outbound) and the reply-unavailable note. The pill and
                         sheet are absolute against the pane, so they escape
                         this scroller and never scroll away. ── */}
                  <div className="mt-6">
                {sendContext ? (
                  scheduledReply ? (
                    <div className="flex flex-col gap-2 rounded-lg border border-border bg-muted/30 px-3 py-2.5">
                      <div className="flex items-center gap-2">
                        <Clock className="size-4 shrink-0 text-primary" />
                        <span className="text-[12.5px] font-medium">
                          Scheduled to send {scheduleFormatter.format(new Date(scheduledReply.scheduledAt))}
                        </span>
                        <button
                          type="button"
                          onClick={handleCancelScheduled}
                          disabled={busy !== null}
                          className={`${BTN_SUBTLE} ml-auto h-7 gap-1 px-2 text-[12px]`}
                        >
                          {busy === "cancel-schedule" ? (
                            <Loader2 className="size-3.5 animate-spin" />
                          ) : (
                            <X className="size-3.5" />
                          )}
                          Cancel send
                        </button>
                      </div>
                      <p className="max-h-16 overflow-hidden whitespace-pre-wrap text-[12.5px] leading-relaxed text-muted-foreground">
                        {scheduledReply.body}
                      </p>
                    </div>
                  ) : (
                    <>
                      <button
                        type="button"
                        onClick={() => openReply()}
                        className={`absolute bottom-4 left-1/2 z-10 inline-flex -translate-x-1/2 items-center gap-2 rounded-full bg-primary py-2 pl-3.5 pr-3 text-[13px] font-medium text-primary-foreground shadow-pop transition-all duration-200 ease-[var(--ease-premium)] hover:opacity-90 ${
                          replyOpen ? "pointer-events-none translate-y-2 opacity-0" : "opacity-100"
                        }`}
                      >
                        <CornerUpLeft className="size-3.5" />
                        Reply
                        <kbd className="rounded bg-primary-foreground/20 px-1.5 py-0.5 font-mono text-[10.5px] font-semibold text-primary-foreground">
                          R
                        </kbd>
                      </button>
                      <div
                        ref={sheetRef}
                        className={`absolute bottom-4 left-1/2 z-10 w-[min(600px,calc(100%-48px))] origin-bottom -translate-x-1/2 rounded-xl border border-border bg-surface p-3 shadow-pop transition-all duration-300 ease-[var(--ease-premium)] ${
                          replyOpen
                            ? "translate-y-0 scale-100 opacity-100"
                            : "pointer-events-none translate-y-6 scale-[0.96] opacity-0"
                        }`}
                      >
                      <div className="flex items-center gap-2 px-0.5 pb-2.5 text-[12px] text-muted-foreground">
                        <span className="min-w-0 truncate">
                          To <span className="font-medium text-foreground">{selected.name}</span>
                          {replyFromEmail ? <> · from {replyFromEmail}</> : null}
                        </span>
                        <button
                          type="button"
                          onClick={() => setReplyOpen(false)}
                          className="ml-auto inline-flex shrink-0 items-center gap-1 text-[11.5px] font-medium text-muted-foreground transition-colors hover:text-foreground"
                        >
                          Esc
                          <X className="size-3.5" />
                        </button>
                      </div>
                      <textarea
                        ref={composerRef}
                        value={composerValue}
                        onChange={(event) => setComposer((prev) => ({ ...prev, [selected.key]: event.target.value }))}
                        onKeyDown={(event) => {
                          if (event.key === "Escape") setReplyOpen(false);
                        }}
                        placeholder={`Reply to ${selected.name.split(/\s+/)[0] || selected.name}…`}
                        className="min-h-24 w-full resize-y rounded-lg border border-transparent bg-muted/30 px-3 py-2.5 text-[14px] leading-relaxed outline-none transition placeholder:text-muted-foreground focus:border-ring focus:bg-surface"
                      />
                      <div className="mt-2 flex items-center gap-2">
                        <span className="flex-1 text-[11.5px] text-muted-foreground">
                          Sends from the campaign inbox via Smartlead
                        </span>
                        {activeProposal?.suggestedReply ? (
                          <button
                            type="button"
                            onClick={useInComposer}
                            disabled={busy !== null}
                            className={`${BTN_OUTLINE} h-8 shrink-0 px-3 text-[13px]`}
                          >
                            <Sparkles className="size-3.5" />
                            AI draft
                          </button>
                        ) : null}
                        <div className="relative shrink-0">
                          <button
                            type="button"
                            aria-expanded={scheduleMenuOpen}
                            onClick={() => {
                              setScheduleMenuOpen((open) => !open);
                              setCustomScheduleOpen(false);
                            }}
                            disabled={busy !== null || !composerValue.trim()}
                            className={`${BTN_OUTLINE} h-8 px-3 text-[13px]`}
                          >
                            {busy === "schedule" ? (
                              <Loader2 className="size-3.5 animate-spin" />
                            ) : (
                              <Clock className="size-3.5" />
                            )}
                            Schedule reply
                          </button>
                          {scheduleMenuOpen ? (
                            <>
                              <button
                                type="button"
                                aria-hidden
                                tabIndex={-1}
                                onClick={() => {
                                  setScheduleMenuOpen(false);
                                  setCustomScheduleOpen(false);
                                }}
                                className="fixed inset-0 z-30 cursor-default"
                              />
                              <div className="absolute bottom-full right-0 z-40 mb-1.5 w-60 rounded-lg border border-border bg-surface p-1 shadow-pop anim-menu-in">
                                <p className="px-2 pb-1 pt-1.5 text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
                                  Schedule send
                                </p>
                                {SCHEDULE_PRESETS.map((preset) => (
                                  <button
                                    key={preset.key}
                                    type="button"
                                    onClick={() => handleSchedule({ preset: preset.key })}
                                    className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12.5px] transition-colors hover:bg-muted/70"
                                  >
                                    <Clock className="size-3.5 shrink-0 text-muted-foreground" />
                                    <span className="flex-1">{preset.label}</span>
                                    {preset.hint ? (
                                      <span className="text-[11px] tabular-nums text-muted-foreground">{preset.hint}</span>
                                    ) : null}
                                  </button>
                                ))}
                                <div className="my-1 border-t border-border" />
                                {customScheduleOpen ? (
                                  <div className="px-1.5 pb-1 pt-0.5">
                                    <input
                                      type="datetime-local"
                                      value={customScheduleValue}
                                      min={customScheduleMin}
                                      onChange={(event) => setCustomScheduleValue(event.target.value)}
                                      className="w-full rounded-md border border-border bg-surface px-2 py-1.5 text-[12.5px] outline-none focus:border-ring"
                                    />
                                    <p className="mt-1 px-0.5 text-[10.5px] text-muted-foreground">Uses your workspace time zone</p>
                                    <div className="mt-1.5 flex gap-1.5">
                                      <button
                                        type="button"
                                        onClick={() => setCustomScheduleOpen(false)}
                                        className={`${BTN_SUBTLE} h-7 flex-1 px-2 text-[12px]`}
                                      >
                                        Back
                                      </button>
                                      <button
                                        type="button"
                                        disabled={!customScheduleValue}
                                        onClick={() => handleSchedule({ customLocal: customScheduleValue })}
                                        className={`${BTN_PRIMARY} h-7 flex-1 px-2 text-[12px]`}
                                      >
                                        Schedule
                                      </button>
                                    </div>
                                  </div>
                                ) : (
                                  <button
                                    type="button"
                                    onClick={openCustomSchedule}
                                    className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12.5px] transition-colors hover:bg-muted/70"
                                  >
                                    <PenLine className="size-3.5 shrink-0 text-muted-foreground" />
                                    Pick date &amp; time…
                                  </button>
                                )}
                              </div>
                            </>
                          ) : null}
                        </div>
                        <button
                          type="button"
                          onClick={handleSend}
                          disabled={busy !== null || !composerValue.trim()}
                          className={`${BTN_PRIMARY} h-8 shrink-0 px-3 text-[13px]`}
                        >
                          {busy === "send" ? <Loader2 className="size-3.5 animate-spin" /> : <Send className="size-3.5" />}
                          Send
                        </button>
                      </div>
                      </div>
                    </>
                  )
                ) : (
                  <p className="rounded-lg bg-muted/60 px-3 py-2.5 text-center text-[11.5px] text-muted-foreground">
                    {threadLoading
                      ? "Checking whether this thread can be replied to…"
                      : "Replying from here is unavailable. This thread isn’t linked to a Smartlead inbox."}
                  </p>
                )}
                  </div>
                </div>
              )}
            </div>
          </>
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
            <InboxIcon className="size-9 text-muted-foreground" />
            <div>
              <p className="text-sm font-medium">No conversation selected</p>
              <p className="mt-1 text-xs text-muted-foreground">Replies land here as leads respond to your campaigns.</p>
            </div>
          </div>
        )}
      </section>

      {/* ── Review rail ───────────────────────────────────────────────── */}
      <aside className="flex min-h-0 flex-col border-l border-border bg-surface">
        {!railOpen ? (
          <div className="flex h-12 shrink-0 items-center justify-center border-b border-border-strong">
            <button
              type="button"
              onClick={toggleRail}
              aria-label={
                selected?.hasPending ? "Show AI read panel — approval needed" : "Show AI read panel"
              }
              data-tip={selected?.hasPending ? "Show AI read — approval needed" : "Show AI read"}
              data-tip-down=""
              data-tip-end=""
              className={`${BTN_SUBTLE} relative size-8`}
            >
              <Bot className="size-4 text-primary" />
              {/* The hidden panel holds the approve/decline actions — surface
                  that a decision is waiting even while the rail is collapsed. */}
              {selected?.hasPending ? (
                <span
                  aria-hidden
                  className="absolute right-0.5 top-0.5 size-2 rounded-full bg-warning ring-2 ring-surface"
                />
              ) : null}
            </button>
          </div>
        ) : selected && activeProposal ? (
          <>
            <div className="flex h-12 shrink-0 items-center gap-2 border-b border-border-strong bg-surface pl-4 pr-2">
              <Bot className="size-4 text-primary" />
              <span className="text-[13.5px] font-semibold tracking-tight">AI read</span>
              <span className="tabular ml-auto text-[11px] text-muted-foreground">
                {fullTime(activeProposal.createdAt, timeZone, timeLocale)}
              </span>
              <button
                type="button"
                onClick={toggleRail}
                aria-label="Hide AI read panel"
                data-tip="Hide panel"
                data-tip-down=""
                data-tip-end=""
                className={`${BTN_SUBTLE} size-7 shrink-0`}
              >
                <PanelRightClose className="size-4" />
              </button>
            </div>

            <div className="scroll-thin flex min-h-0 flex-1 flex-col gap-2.5 overflow-y-auto p-3">
              {/* 1 · Category & summary */}
              <Module title="Category & summary" icon={Tag}>
                <div className="relative">
                  <select
                    value={categories.find((c) => c.label === activeProposal.sentiment)?.value ?? "uncategorizable"}
                    disabled={activeProposal.status !== "pending" || busy !== null}
                    onChange={(event) =>
                      run(`category-${activeProposal.id}`, () =>
                        setProposalCategoryAction(activeProposal.id, event.target.value),
                      )
                    }
                    className="h-9 w-full appearance-none rounded-md border border-border bg-surface px-3 pr-8 text-[13px] font-medium shadow-xs outline-none transition focus:border-ring disabled:cursor-not-allowed disabled:opacity-70"
                  >
                    {categories.map((category) => (
                      <option key={category.value} value={category.value}>
                        {category.label}
                      </option>
                    ))}
                  </select>
                  <ChevronDown className="pointer-events-none absolute right-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                </div>

                {activeProposal.summary ? (
                  <p className="mt-2.5 text-[12.5px] leading-relaxed">{activeProposal.summary}</p>
                ) : null}

                {activeProposal.nextStep ? (
                  <p className="mt-2 flex items-start gap-1.5 text-xs font-medium">
                    <ArrowRight className="mt-0.5 size-3.5 shrink-0 text-primary" />
                    {activeProposal.nextStep}
                  </p>
                ) : null}

                {activeProposal.reasoning ? (
                  <details className="group mt-3">
                    <summary className="flex cursor-pointer list-none items-center gap-1.5 text-xs font-medium text-muted-foreground transition hover:text-foreground">
                      Why this category
                      <ChevronDown className="size-3.5 transition-transform group-open:rotate-180" />
                    </summary>
                    <p className="mt-2 text-xs leading-relaxed text-muted-foreground">{activeProposal.reasoning}</p>
                  </details>
                ) : null}

                {activeProposal.userNote ? (
                  <p className="mt-3 rounded-md bg-muted/60 px-2.5 py-2 text-xs text-muted-foreground">
                    <span className="font-semibold">Your context:</span> {activeProposal.userNote}
                  </p>
                ) : null}
              </Module>

              {/* 2 · Suggested reply */}
              {activeProposal.suggestedReply ? (
                <Module title="Suggested reply" icon={PenLine}>
                  <div className="max-h-48 overflow-y-auto whitespace-pre-wrap rounded-lg border border-primary/25 bg-primary-soft/55 px-3 py-2.5 text-[12.5px] leading-relaxed">
                    {activeProposal.suggestedReply}
                  </div>
                  <button type="button" onClick={useInComposer} className={`${BTN_OUTLINE} mt-2 h-7 w-full text-xs`}>
                    <Send className="size-3.5" />
                    Use in composer
                  </button>
                </Module>
              ) : null}

              {/* 3 · People at company */}
              {activeProposal.research.length > 0 ? (
                <Module title={`People at ${selected.company ?? "this company"}`} icon={Users}>
                  <div className="flex flex-wrap gap-1.5">
                    {activeProposal.research.map((person) => (
                      <span
                        key={person.name}
                        data-tip={person.source === "crm" ? "From our lead list" : "Found via web search"}
                        className="inline-flex items-center gap-1.5 rounded-full border border-border bg-surface px-2.5 py-1 text-[12px]"
                      >
                        {person.name}
                        {person.title ? <span className="text-muted-foreground">· {person.title}</span> : null}
                        <span className={`size-1.5 rounded-full ${person.source === "crm" ? "bg-success" : "bg-info"}`} />
                      </span>
                    ))}
                  </div>
                </Module>
              ) : null}

              {/* 3b · LinkedIn preview (lead data — shown whenever a profile URL exists) */}
              <LinkedInModule conversation={selected} />

              {/* 4 · Referral card */}
              {activeProposal.isReferral &&
              (activeProposal.proposedChanges.referee_name || activeProposal.summary?.toLowerCase().includes("refer")) ? (
                <div className="shrink-0 rounded-lg border border-info/20 bg-info-soft p-3">
                  <p className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.08em] text-info">
                    <UserRound className="size-3.5" /> Referral
                  </p>
                  <p className="mt-1.5 text-[13px] font-medium">
                    {String(activeProposal.proposedChanges.referee_name ?? "See notes")}
                  </p>
                </div>
              ) : null}

              {/* 5 · Warning cards (dead mailbox / DNC / suppress) */}
              {activeProposal.actionDnc ? (
                <div
                  className={`flex shrink-0 items-start gap-2.5 rounded-lg p-3 text-xs leading-relaxed ${
                    activeProposal.dncReason === "email_defunct"
                      ? "bg-warning-soft text-warning"
                      : "bg-destructive-soft text-destructive"
                  }`}
                >
                  {activeProposal.dncReason === "email_defunct" ? (
                    <MailX className="mt-0.5 size-4 shrink-0" />
                  ) : (
                    <ShieldAlert className="mt-0.5 size-4 shrink-0" />
                  )}
                  <span>
                    <strong className="font-semibold">
                      {activeProposal.dncReason === "email_defunct" ? "Dead mailbox." : "Do Not Contact."}
                    </strong>{" "}
                    Approving blocks <span className="font-medium">{activeProposal.actionValue}</span> in Smartlead (this
                    address only).
                    {activeProposal.dncReason ? ` Reason: ${DNC_REASON_LABELS[activeProposal.dncReason]}.` : ""}
                  </span>
                </div>
              ) : activeProposal.actionSuppress ? (
                <div className="flex shrink-0 items-start gap-2.5 rounded-lg bg-warning-soft p-3 text-xs leading-relaxed text-warning">
                  <ShieldAlert className="mt-0.5 size-4 shrink-0" />
                  <span>Approving adds {activeProposal.actionValue} to the local suppression list.</span>
                </div>
              ) : null}

              {/* 6 · CRM updates on approve */}
              {Object.keys(activeProposal.proposedChanges).filter((key) => key !== "latest_response").length > 0 ? (
                <Module title="CRM updates on approve" icon={Database}>
                  <dl>
                    {Object.entries(activeProposal.proposedChanges)
                      .filter(([key]) => key !== "latest_response")
                      .map(([key, value]) => (
                        <div
                          key={key}
                          className="flex justify-between gap-3 border-b border-dashed border-border py-1.5 text-xs last:border-b-0"
                        >
                          <dt className="text-muted-foreground">{FIELD_LABELS[key] ?? key}</dt>
                          <dd className="text-right font-medium">{changeValueLabel(key, value, timeZone, timeLocale)}</dd>
                        </div>
                      ))}
                  </dl>
                </Module>
              ) : null}

              {selected.proposals.length > 1 ? (
                <p className="pb-1 pt-1 text-center text-[11px] text-muted-foreground">
                  {selected.proposals.length - 1} earlier read{selected.proposals.length > 2 ? "s" : ""} on this thread
                </p>
              ) : null}
            </div>

            {/* Pinned footer */}
            <div className="shrink-0 border-t border-border bg-surface p-3">
              {activeProposal.status === "pending" ? (
                <>
                  <div className="flex gap-2">
                    <button
                      type="button"
                      disabled={busy !== null}
                      onClick={() => run(`approve-${activeProposal.id}`, () => approveProposalAction(activeProposal.id))}
                      className={`${BTN_PRIMARY} h-9 flex-1 text-[13px]`}
                    >
                      {busy === `approve-${activeProposal.id}` ? (
                        <Loader2 className="size-4 animate-spin" />
                      ) : (
                        <Check className="size-4" />
                      )}
                      Approve
                    </button>
                    <button
                      type="button"
                      disabled={busy !== null}
                      onClick={() => run(`decline-${activeProposal.id}`, () => declineProposalAction(activeProposal.id))}
                      className={`${BTN_OUTLINE} h-9 flex-1 text-[13px]`}
                    >
                      {busy === `decline-${activeProposal.id}` ? (
                        <Loader2 className="size-4 animate-spin" />
                      ) : (
                        <X className="size-4" />
                      )}
                      Decline
                    </button>
                  </div>
                  <ReRunSection
                    key={activeProposal.id}
                    proposalId={activeProposal.id}
                    busy={busy}
                    onRerun={(note) =>
                      run(`regen-${activeProposal.id}`, () => regenerateProposalAction(activeProposal.id, note))
                    }
                  />
                </>
              ) : (
                <div
                  className={`flex items-center gap-2.5 rounded-lg px-3 py-2.5 ${
                    activeProposal.status === "approved" ? "bg-success-soft" : "bg-muted"
                  }`}
                >
                  <span
                    className={`flex size-7 shrink-0 items-center justify-center rounded-full ${
                      activeProposal.status === "approved"
                        ? "bg-success/15 text-success"
                        : "bg-foreground/10 text-muted-foreground"
                    }`}
                  >
                    {activeProposal.status === "approved" ? <Check className="size-4" /> : <X className="size-4" />}
                  </span>
                  <div className="min-w-0">
                    <p
                      className={`text-[13px] font-semibold leading-tight ${
                        activeProposal.status === "approved" ? "text-success" : "text-foreground"
                      }`}
                    >
                      {activeProposal.status === "approved" ? "Approved" : "Declined"}
                    </p>
                    {activeProposal.resolvedBy || activeProposal.resolvedAt ? (
                      <p className="mt-0.5 truncate text-[11.5px] text-muted-foreground">
                        {[
                          activeProposal.resolvedBy ? `by ${activeProposal.resolvedBy.split("@")[0]}` : null,
                          activeProposal.resolvedAt ? fullTime(activeProposal.resolvedAt, timeZone, timeLocale) : null,
                        ]
                          .filter(Boolean)
                          .join(" · ")}
                      </p>
                    ) : null}
                  </div>
                </div>
              )}
            </div>
          </>
        ) : (
          <>
            <div className="flex h-12 shrink-0 items-center gap-2 border-b border-border-strong bg-surface pl-4 pr-2">
              <Bot className="size-4 text-primary" />
              <span className="text-[13.5px] font-semibold tracking-tight">AI read</span>
              <button
                type="button"
                onClick={toggleRail}
                aria-label="Hide AI read panel"
                data-tip="Hide panel"
                data-tip-down=""
                data-tip-end=""
                className={`${BTN_SUBTLE} ml-auto size-7 shrink-0`}
              >
                <PanelRightClose className="size-4" />
              </button>
            </div>
            {selected ? (
              <div className="scroll-thin flex min-h-0 flex-1 flex-col gap-2.5 overflow-y-auto p-3">
                <div className="flex flex-col items-center gap-3 px-3 py-10 text-center">
                  <Bot className="size-7 text-muted-foreground" />
                  <p className="text-xs leading-relaxed text-muted-foreground">
                    No AI read yet for this conversation.
                    <br />
                    Use “Check for new replies” to process the queue.
                  </p>
                </div>
                <LinkedInModule conversation={selected} />
              </div>
            ) : null}
          </>
        )}
      </aside>
    </div>
  );
}

function ContextField({
  label,
  value,
  tabular,
}: {
  label: string;
  value: React.ReactNode;
  tabular?: boolean;
}) {
  return (
    <div>
      <div className="text-[10px] font-semibold uppercase tracking-[0.06em] text-foreground-subtle">{label}</div>
      <div className={`mt-1 text-[12.5px] font-medium tracking-tight ${tabular ? "tabular" : ""}`}>{value}</div>
    </div>
  );
}
