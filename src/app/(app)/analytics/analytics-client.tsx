"use client";

import { useEffect, useRef, useState, useTransition, type CSSProperties } from "react";
import { AlertTriangle, Check, ChevronDown, ChevronRight, Loader2, Search, X } from "lucide-react";
import {
  getAnalyticsDataAction,
  getCampaignComparisonAction,
  getSendVolumeAction,
} from "./actions";
import {
  AnalyticsDrilldownModal,
  type AnalyticsDrillCampaigns,
  type AnalyticsDrillKind,
  type AnalyticsDrillPayload,
} from "./analytics-drilldown";
import { SkeletonChart, SkeletonTable } from "@/app/(app)/skeletons";

/* ── Contract mirrors (declared locally so the client never imports a
   server-only module — the same pattern as inboxes-client / campaigns-client;
   only the action functions cross the boundary). ───────────────────────── */
// Mirrors AnalyticsData in src/lib/replies/queries.ts. Every count here is a
// count of distinct LEADS, not messages — see that file for why.
type AnalyticsData = {
  totalReplies: number;
  replies7d: number;
  replies30d: number;
  categorizedLeads: number;
  pendingCount: number;
  approvedCount: number;
  positiveCount: number;
  negativeCount: number;
  neutralCount: number;
  referralCount: number;
  oooCount: number;
  dncExplicit: number;
  dncDefunct: number;
  sentFromInbox: number;
  sentFromInboxIsWorkspaceWide: boolean;
  windowDays: number;
  perDay: { date: string; positive: number; negative: number; neutral: number }[];
  categories: { label: string; count: number; sentimentType: string }[];
  campaigns: { id: string | null; name: string; replies: number; positive: number }[];
};

type CampaignComparisonRow = {
  id: string;
  name: string;
  status: string | null;
  sent: number | null;
  uniqueSent: number | null;
  replies: number | null;
  bounces: number | null;
  leadBounces: number | null;
  senderBounces: number | null;
  replyRatePct: number | null;
  bounceRatePct: number | null;
  senderBounceRatePct: number | null;
  capturedReplies: number;
  positive: number;
  providerError: string | null;
};

// Mirrors SendVolume in src/lib/send-volume.ts.
type SendVolumeData = {
  perDay: { date: string; sent: number; opened: number; replied: number; bounced: number; unsubscribed: number }[];
  totalSent: number;
  totalBounced: number;
  leadsSent: number;
  leadsSentAllTime: number;
};

type CampaignChoice = { id: string; name: string; status: string | null };
type Days = 7 | 30 | 90;
type Mode = "include" | "exclude";
type CampaignSelection = { mode: Mode; ids: string[] };

/* ── Shared style constants (copied conventions, intentionally not shared) ── */
const BTN_BASE = `inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-md font-medium transition disabled:cursor-not-allowed disabled:opacity-50`;
const BTN_OUTLINE = `${BTN_BASE} border border-border bg-surface text-foreground shadow-xs hover:border-border-strong hover:bg-muted/60`;
const BTN_SUBTLE = `${BTN_BASE} bg-transparent text-muted-foreground hover:bg-muted/70 hover:text-foreground`;

/* ── Chart palette (mirrors the previous server page) ───────────────────── */
const CHART_POSITIVE = "var(--primary)";
const CHART_NEGATIVE = "color-mix(in srgb, var(--destructive) 75%, var(--surface))";
const CHART_NEUTRAL = "var(--border-strong)";

// Category fill: label-specific tones first, then fall back to sentiment type.
function categoryColor(label: string, sentimentType: string): string {
  if (label === "Information Request") return "var(--info)";
  if (label === "Wrong Person") return "var(--warning)";
  if (sentimentType === "positive") return CHART_POSITIVE;
  if (sentimentType === "negative") return CHART_NEGATIVE;
  return CHART_NEUTRAL;
}

/* ── Campaign status pill (matches the campaigns page grammar) ───────────── */
function statusTone(status: string | null): string {
  const s = (status ?? "").toUpperCase();
  if (s === "ACTIVE" || s === "START" || s === "RUNNING") return "bg-success-soft text-success";
  if (s === "PAUSED") return "bg-warning-soft text-warning";
  return "bg-muted text-muted-foreground";
}
function statusLabel(status: string | null): string {
  return (status ?? "").toUpperCase() || "UNKNOWN";
}
function StatusPill({ status }: { status: string | null }) {
  return (
    <span
      className={`shrink-0 rounded px-1.5 py-px text-[9.5px] font-semibold uppercase tracking-wide ${statusTone(status)}`}
    >
      {statusLabel(status)}
    </span>
  );
}

/* ── Number formatting: compact in the cell, full value on hover ────────── */
const COMPACT = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });
const FULL = new Intl.NumberFormat("en-US");

// A muted dot stands in for a null metric so an empty cell never reads as zero.
function Num({ value }: { value: number | null }) {
  if (value === null) {
    return (
      <span className="text-muted-foreground/40" title="No data">
        ·
      </span>
    );
  }
  return (
    <span className="font-mono tabular-nums" title={FULL.format(value)}>
      {COMPACT.format(value)}
    </span>
  );
}

function Rate({ value }: { value: number | null }) {
  if (value === null) return <span className="text-muted-foreground/40">·</span>;
  return <span className="font-mono tabular-nums">{value.toFixed(1)}%</span>;
}

/* ── Stable date labels (explicit locale + UTC so server and client agree) ─ */
const AXIS_FMT = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
function axisLabel(date: string): string {
  const parsed = new Date(`${date}T00:00:00Z`);
  return Number.isNaN(parsed.getTime()) ? date : AXIS_FMT.format(parsed);
}

/* ── KPI card (same grammar as the previous server page) ────────────────── */
// With onOpen the tile is a real <button> that opens the drill-down modal,
// keeping the exact card visual. Zero-value tiles pass no onOpen and stay a
// plain card with no affordance; while a filter transition is pending the
// button is disabled (and the affordance suppressed) so a modal never opens
// over stale filters.
function Kpi({
  label,
  value,
  hint,
  tone,
  onOpen,
  disabled,
}: {
  label: string;
  value: string | number;
  hint?: string;
  tone?: string;
  onOpen?: () => void;
  disabled?: boolean;
}) {
  const body = (
    <>
      <p className="flex min-h-[2.5em] items-start text-[10px] font-semibold uppercase leading-tight tracking-[0.08em] text-foreground-subtle">{label}</p>
      <p className={`mt-1.5 text-[28px] font-semibold leading-none tracking-tight font-mono tabular-nums ${tone ?? ""}`}>
        {value}
      </p>
      {hint ? <p className="mt-1.5 min-h-[2.4em] text-[11.5px] leading-[1.2] text-muted-foreground">{hint}</p> : null}
    </>
  );

  if (!onOpen) {
    return <div className="rounded-xl bg-surface p-4 shadow-xs">{body}</div>;
  }

  return (
    <button
      type="button"
      onClick={onOpen}
      disabled={disabled}
      aria-haspopup="dialog"
      className={`relative rounded-xl bg-surface p-4 text-left shadow-xs transition ${
        disabled ? "cursor-default" : "group hover:border-border-strong hover:ring-1 hover:ring-ring/30"
      }`}
    >
      {body}
      <ChevronRight
        aria-hidden
        className="absolute right-3 top-3.5 size-3.5 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100"
      />
    </button>
  );
}

/* ── Range segmented control ────────────────────────────────────────────── */
function RangeControl({ value, onChange }: { value: Days; onChange: (days: Days) => void }) {
  const options: { days: Days; label: string }[] = [
    { days: 7, label: "7 days" },
    { days: 30, label: "30 days" },
    { days: 90, label: "90 days" },
  ];
  return (
    <div role="group" aria-label="Date range" className="flex items-center gap-0.5 rounded-lg bg-muted/60 p-0.5">
      {options.map((option) => (
        <button
          key={option.days}
          type="button"
          aria-pressed={value === option.days}
          onClick={() => onChange(option.days)}
          className={`rounded-md px-2.5 py-1 text-[11.5px] font-medium tabular-nums transition ${
            value === option.days
              ? "bg-surface text-foreground shadow-xs"
              : "text-muted-foreground hover:text-foreground"
          }`}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

/* ── Campaign multi-select popover (include / exclude) ──────────────────── */
function CampaignFilter({
  campaigns,
  mode,
  selectedIds,
  onModeChange,
  onToggle,
  onClear,
}: {
  campaigns: CampaignChoice[];
  mode: Mode;
  selectedIds: Set<string>;
  onModeChange: (mode: Mode) => void;
  onToggle: (id: string) => void;
  onClear: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const count = selectedIds.size;
  const label = count === 0 ? "All campaigns" : mode === "include" ? `${count} included` : `${count} excluded`;
  const q = query.trim().toLowerCase();
  const filtered = q ? campaigns.filter((campaign) => campaign.name.toLowerCase().includes(q)) : campaigns;

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        disabled={campaigns.length === 0}
        aria-expanded={open}
        className={`${BTN_OUTLINE} h-8 px-3 text-[12px]`}
      >
        <span className="whitespace-nowrap">{label}</span>
        <ChevronDown className="size-3.5 text-muted-foreground" />
      </button>

      {open ? (
        <div
          className="anim-menu-in absolute left-0 z-30 mt-1.5 w-72 rounded-xl border border-border bg-surface p-2 shadow-pop"
          style={{ "--menu-origin": "top left" } as CSSProperties}
        >
          <div className="flex gap-0.5 rounded-lg bg-muted/60 p-0.5">
            {(["include", "exclude"] as Mode[]).map((value) => (
              <button
                key={value}
                type="button"
                aria-pressed={mode === value}
                onClick={() => onModeChange(value)}
                className={`flex-1 rounded-md px-2 py-1 text-[11.5px] font-medium capitalize transition ${
                  mode === value ? "bg-surface text-foreground shadow-xs" : "text-muted-foreground hover:text-foreground"
                }`}
              >
                {value}
              </button>
            ))}
          </div>

          {campaigns.length > 6 ? (
            <div className="relative mt-1.5">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search campaigns"
                aria-label="Search campaigns"
                className="h-8 w-full rounded-md border border-border bg-surface pl-8 pr-2.5 text-[12.5px] text-foreground shadow-xs outline-none transition placeholder:text-muted-foreground focus:border-ring"
              />
            </div>
          ) : null}

          <div className="mt-1.5 max-h-64 overflow-y-auto">
            {filtered.length === 0 ? (
              <p className="px-2 py-3 text-center text-[12px] text-muted-foreground">No campaigns match.</p>
            ) : (
              filtered.map((campaign) => {
                const checked = selectedIds.has(campaign.id);
                return (
                  <button
                    key={campaign.id}
                    type="button"
                    onClick={() => onToggle(campaign.id)}
                    aria-pressed={checked}
                    className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12.5px] transition hover:bg-muted/60`}
                  >
                    <span
                      className={`flex size-3.5 shrink-0 items-center justify-center rounded border transition ${
                        checked ? "border-primary bg-primary text-primary-foreground" : "border-border bg-surface"
                      }`}
                    >
                      {checked ? <Check className="size-2.5" strokeWidth={3} /> : null}
                    </span>
                    <span className="min-w-0 flex-1 truncate">{campaign.name}</span>
                    <StatusPill status={campaign.status} />
                  </button>
                );
              })
            )}
          </div>

          <div className="mt-1.5 flex items-center justify-between border-t border-border pt-1.5">
            <span className="text-[11px] text-muted-foreground">{label}</span>
            {count > 0 ? (
              <button
                type="button"
                onClick={onClear}
                className={`text-[11px] font-medium text-muted-foreground transition hover:text-foreground`}
              >
                Clear
              </button>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}

/* ── Chart hover card ─────────────────────────────────────────────────────
   Replaces the browser-default title bubble on chart columns: a surface card
   in the popover grammar (minus the menu animation — it follows the cursor,
   so per-column motion would flicker), anchored above the hovered column and
   clamped to the plot's edges. pointer-events-none so a sweep across the
   chart can never get trapped on its own tooltip. */
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
  // If any row carries a series dot, dotless rows get a transparent spacer so
  // their labels stay on the same left edge.
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
              {FULL.format(row.value)}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ── Categorized replies per day (stacked column chart) ─────────────────── */
function CategorizedChart({
  perDay,
}: {
  perDay: { date: string; positive: number; negative: number; neutral: number }[];
}) {
  const [hovered, setHovered] = useState<number | null>(null);
  const peak = perDay.reduce((max, day) => Math.max(max, day.positive + day.negative + day.neutral), 0);
  const max = Math.max(1, peak);
  // Axis labels on the first, middle, and last day — orientation without a
  // label per column (which 90 columns could never fit).
  const labelIndexes = new Set(
    perDay.length > 4 ? [0, Math.floor((perDay.length - 1) / 2), perDay.length - 1] : perDay.map((_, index) => index),
  );
  const hoveredDay = hovered !== null ? perDay[hovered] : null;

  return (
    <div className="mt-5 flex flex-col gap-1">
      <div
        className="relative flex h-40 items-end gap-[2px] border-b border-border/70 pt-3"
        onMouseLeave={() => setHovered(null)}
      >
        {perDay.map((day, index) => {
          const total = day.positive + day.negative + day.neutral;
          return (
            <div
              key={day.date}
              onMouseEnter={() => setHovered(index)}
              // h-full is load-bearing: the stacked segments size as a
              // percentage of the column, so the column needs a definite height.
              className="flex h-full flex-1 flex-col justify-end overflow-hidden rounded-t transition-opacity hover:opacity-75"
            >
              <div style={{ height: `${(day.neutral / max) * 100}%`, background: CHART_NEUTRAL }} />
              <div style={{ height: `${(day.negative / max) * 100}%`, background: CHART_NEGATIVE }} />
              <div style={{ height: `${(day.positive / max) * 100}%`, background: CHART_POSITIVE }} />
              {total === 0 ? <div className="h-px w-full shrink-0 bg-border" /> : null}
            </div>
          );
        })}
        {hoveredDay !== null && hovered !== null ? (
          <ChartHoverCard
            index={hovered}
            count={perDay.length}
            title={axisLabel(hoveredDay.date)}
            rows={[
              { label: "Positive", value: hoveredDay.positive, dot: CHART_POSITIVE },
              { label: "Negative", value: hoveredDay.negative, dot: CHART_NEGATIVE },
              { label: "Neutral", value: hoveredDay.neutral, dot: CHART_NEUTRAL },
              { label: "Total", value: hoveredDay.positive + hoveredDay.negative + hoveredDay.neutral, muted: true },
            ]}
          />
        ) : null}
      </div>
      <div className="flex gap-[2px]">
        {perDay.map((day, index) => (
          <div key={day.date} className="flex flex-1 justify-center">
            {labelIndexes.has(index) ? (
              <span className="whitespace-nowrap text-[9.5px] tabular-nums text-muted-foreground/70">
                {axisLabel(day.date)}
              </span>
            ) : null}
          </div>
        ))}
      </div>
    </div>
  );
}

/* ── Send volume (workspace-wide sending per day) ───────────────────────── */
// Deliberately NOT campaign-filterable: Smartlead's day-wise stats endpoint
// only reports the whole workspace, and a section where one number obeyed the
// campaign filter while its neighbors ignored it would lie. The filter-aware
// per-campaign send counts live in the comparison table below.
const CHART_SENT = "var(--info)";

function SendVolumeStat({ value, label, title }: { value: number; label: string; title?: string }) {
  return (
    <div className="flex items-baseline gap-1.5" title={title}>
      <span className="font-mono text-[20px] font-semibold leading-none tracking-tight tabular-nums">
        {FULL.format(value)}
      </span>
      <span className="whitespace-nowrap text-[11.5px] text-muted-foreground">{label}</span>
    </div>
  );
}

function SendVolumeChart({ perDay }: { perDay: SendVolumeData["perDay"] }) {
  const [hovered, setHovered] = useState<number | null>(null);
  const max = Math.max(1, ...perDay.map((day) => day.sent));
  // First / middle / last axis labels — the CategorizedChart idiom.
  const labelIndexes = new Set(
    perDay.length > 4 ? [0, Math.floor((perDay.length - 1) / 2), perDay.length - 1] : perDay.map((_, index) => index),
  );
  const hoveredDay = hovered !== null ? perDay[hovered] : null;

  return (
    <div className="mt-5 flex flex-col gap-1">
      <div
        className="relative flex h-40 items-end gap-[2px] border-b border-border/70 pt-3"
        onMouseLeave={() => setHovered(null)}
      >
        {perDay.map((day, index) => (
          <div
            key={day.date}
            onMouseEnter={() => setHovered(index)}
            className="flex h-full flex-1 flex-col justify-end transition-opacity hover:opacity-75"
          >
            <div className="w-full rounded-t" style={{ height: `${(day.sent / max) * 100}%`, background: CHART_SENT }} />
            {day.sent === 0 ? <div className="h-px w-full shrink-0 bg-border" /> : null}
          </div>
        ))}
        {hoveredDay !== null && hovered !== null ? (
          <ChartHoverCard
            index={hovered}
            count={perDay.length}
            title={axisLabel(hoveredDay.date)}
            rows={[
              { label: "Sent", value: hoveredDay.sent, dot: CHART_SENT },
              { label: "Bounced", value: hoveredDay.bounced, muted: true },
            ]}
          />
        ) : null}
      </div>
      <div className="flex gap-[2px]">
        {perDay.map((day, index) => (
          <div key={day.date} className="flex flex-1 justify-center">
            {labelIndexes.has(index) ? (
              <span className="whitespace-nowrap text-[9.5px] tabular-nums text-muted-foreground/70">
                {axisLabel(day.date)}
              </span>
            ) : null}
          </div>
        ))}
      </div>
    </div>
  );
}

function SendVolumeSection({ days }: { days: Days }) {
  const [data, setData] = useState<SendVolumeData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startLoad] = useTransition();
  // Monotonic ticket + loaded-signature ref, same contract as the comparison
  // table: one load per window, stale completions never write.
  const requestTicket = useRef(0);
  const loadedDays = useRef<Days | null>(null);

  const load = () => {
    const ticket = requestTicket.current + 1;
    requestTicket.current = ticket;
    loadedDays.current = days;
    setError(null);
    startLoad(async () => {
      try {
        const result = await getSendVolumeAction(days);
        if (requestTicket.current !== ticket) return;
        if (result.ok && result.data) setData(result.data);
        else setError(result.message);
      } catch {
        if (requestTicket.current !== ticket) return;
        setError("Could not load send volume. Check your connection and retry.");
      }
    });
  };

  useEffect(() => {
    if (loadedDays.current === days) return;
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [days]);

  const peak = data ? data.perDay.reduce((max, day) => Math.max(max, day.sent), 0) : 0;

  return (
    <section className="rounded-xl bg-surface p-5 shadow-xs">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-2">
        <div>
          <h2 className="text-[13.5px] font-semibold tracking-tight">Send volume</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">Emails sent per day · every campaign in the workspace · last {days} days</p>
        </div>
        {pending && data !== null ? (
          <span className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
            <Loader2 className="size-3 animate-spin" />
            Updating
          </span>
        ) : null}
        {data !== null ? (
          <div className="ml-auto flex flex-wrap items-baseline gap-x-5 gap-y-2">
            {peak > 0 ? <SendVolumeStat value={peak} label="peak / day" /> : null}
            <SendVolumeStat value={data.totalSent} label="emails sent" />
            <SendVolumeStat
              value={data.leadsSent}
              label="leads sent"
              title={`Distinct leads pushed into a campaign in this window (latest push date) · ${FULL.format(data.leadsSentAllTime)} all time`}
            />
          </div>
        ) : null}
      </div>

      {data === null && pending ? (
        <div className="mt-5">
          <SkeletonChart height="h-40" bars={Math.min(days, 45)} />
        </div>
      ) : data === null ? (
        <div className="mt-4 flex flex-col items-center gap-3 rounded-lg border border-dashed border-border px-4 py-8 text-center">
          <p className="max-w-md text-[12.5px] leading-relaxed text-muted-foreground">
            {error ?? "Could not load the send volume."}
          </p>
          <button type="button" onClick={load} className={`${BTN_OUTLINE} h-8 px-3 text-[12px]`}>
            Retry
          </button>
        </div>
      ) : data.totalSent === 0 ? (
        <p className="mt-4 text-[12px] text-muted-foreground">No emails sent in this window.</p>
      ) : (
        <div className={pending ? "opacity-60 transition-opacity" : "transition-opacity"}>
          {error ? (
            <div className="mt-3 flex items-center gap-2 text-[11.5px] text-warning">
              <AlertTriangle className="size-3.5" />
              <span>Showing the previous results.</span>
              <button type="button" onClick={load} className={`font-medium underline-offset-2 hover:underline`}>
                Retry
              </button>
            </div>
          ) : null}
          <SendVolumeChart perDay={data.perDay} />
        </div>
      )}
    </section>
  );
}

/* ── Campaign comparison table (the centerpiece) ────────────────────────── */
function CampaignComparison({ days, filter }: { days: Days; filter: CampaignSelection | null }) {
  // filter: null = every campaign. The server resolves include/exclude against
  // its own fresh campaign list, so this table can never disagree with the
  // other panels' filter semantics (and never trips the id-count cap).
  const [rows, setRows] = useState<CampaignComparisonRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startLoad] = useTransition();
  // Monotonic ticket: only the newest request may write, even when two
  // requests share the same filter signature (fast flip there and back).
  const requestTicket = useRef(0);
  const loadedSignature = useRef<string | null>(null);

  const signature = `${days}|${filter === null ? "all" : `${filter.mode}:${[...filter.ids].sort().join(",")}`}`;

  const load = () => {
    const ticket = requestTicket.current + 1;
    requestTicket.current = ticket;
    loadedSignature.current = signature;
    setError(null);
    startLoad(async () => {
      try {
        const result = await getCampaignComparisonAction(days, filter);
        // Ignore a stale completion — a newer request has superseded this one.
        if (requestTicket.current !== ticket) return;
        if (result.ok && result.rows) setRows(result.rows);
        else setError(result.message);
      } catch {
        if (requestTicket.current !== ticket) return;
        setError("Could not load campaign comparison. Check your connection and retry.");
      }
    });
  };

  // Ref-guarded, signature-keyed: one load on mount, one more whenever the
  // range or campaign selection changes (never a duplicate for the same view).
  useEffect(() => {
    if (loadedSignature.current === signature) return;
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature]);

  // Footer totals over the listed (filter-resolved) campaigns. Rows whose
  // provider fetch failed carry null metrics; they are skipped from every sum
  // and disclosed next to the label so a partial outage can't silently
  // undercount. Unique is per-campaign uniques summed — a contact present in
  // two campaigns counts twice (Smartlead has no cross-campaign dedupe).
  const totals =
    rows === null || rows.length === 0
      ? null
      : (() => {
          const sum = (pick: (row: CampaignComparisonRow) => number | null) =>
            rows.reduce((acc, row) => acc + (pick(row) ?? 0), 0);
          const sent = sum((row) => row.sent);
          const pct = (numerator: number) =>
            sent > 0 ? Math.min(100, Math.round((numerator / sent) * 1000) / 10) : null;
          const replies = sum((row) => row.replies);
          const leadBounces = sum((row) => row.leadBounces);
          const senderBounces = sum((row) => row.senderBounces);
          return {
            sent,
            uniqueSent: sum((row) => row.uniqueSent),
            replies,
            replyRatePct: pct(replies),
            leadBounces,
            bounceRatePct: pct(leadBounces),
            senderBounceRatePct: pct(senderBounces),
            captured: sum((row) => row.capturedReplies),
            positive: sum((row) => row.positive),
            unreachable: rows.filter((row) => row.providerError !== null).length,
          };
        })();

  return (
    <section className="rounded-xl bg-surface p-5 shadow-xs">
      <div className="flex items-baseline gap-3">
        <h2 className="text-[13.5px] font-semibold tracking-tight">Campaign comparison</h2>
        {pending && rows !== null ? (
          <span className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
            <Loader2 className="size-3 animate-spin" />
            Updating
          </span>
        ) : null}
      </div>

      {rows === null && pending ? (
        // Structural stand-in sized to the real table below: 10 columns
        // (Campaign, Sent, Unique, Replies, Reply rate, Bounced, Bounce rate,
        // Sender bounce rate, Captured, Positive) and a full page of rows, so
        // data arriving does not shift the layout.
        <div className="mt-3 overflow-x-auto">
          <SkeletonTable rows={8} cols={10} className="min-w-[820px]" />
        </div>
      ) : rows === null ? (
        <div className="mt-4 flex flex-col items-center gap-3 rounded-lg border border-dashed border-border px-4 py-8 text-center">
          <p className="max-w-md text-[12.5px] leading-relaxed text-muted-foreground">
            {error ?? "Could not load the campaign comparison."}
          </p>
          <button type="button" onClick={load} className={`${BTN_OUTLINE} h-8 px-3 text-[12px]`}>
            Retry
          </button>
        </div>
      ) : rows.length === 0 ? (
        <p className="mt-4 text-[12px] text-muted-foreground">No campaigns to compare in this selection.</p>
      ) : (
        <>
          {error ? (
            <div className="mt-3 flex items-center gap-2 text-[11.5px] text-warning">
              <AlertTriangle className="size-3.5" />
              <span>Showing the previous results.</span>
              <button
                type="button"
                onClick={load}
                className={`font-medium underline-offset-2 hover:underline`}
              >
                Retry
              </button>
            </div>
          ) : null}
          <div className="mt-3 overflow-x-auto">
            <table className={`w-full min-w-[820px] border-separate border-spacing-0 ${pending ? "opacity-60 transition-opacity" : "transition-opacity"}`}>
              <thead>
                <tr className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                  <th className="rounded-l-md border-b border-border bg-surface-muted py-2 pl-3 pr-3 text-left font-semibold">Campaign</th>
                  <th className="border-b border-border bg-surface-muted px-2 py-2 text-right font-semibold">Sent</th>
                  <th className="border-b border-border bg-surface-muted px-2 py-2 text-right font-semibold" title="Distinct contacts emailed, per Smartlead">Unique</th>
                  <th className="border-b border-border bg-surface-muted px-2 py-2 text-right font-semibold">Replies</th>
                  <th className="border-b border-border bg-surface-muted px-2 py-2 text-right font-semibold">Reply rate</th>
                  <th className="border-b border-border bg-surface-muted px-2 py-2 text-right font-semibold">Bounced</th>
                  <th className="border-b border-border bg-surface-muted px-2 py-2 text-right font-semibold">Bounce rate</th>
                  <th className="border-b border-border bg-surface-muted px-2 py-2 text-right font-semibold">Sender bounce rate</th>
                  <th className="border-b border-border bg-surface-muted px-2 py-2 text-right font-semibold">Captured</th>
                  <th className="rounded-r-md border-b border-border bg-surface-muted py-2 pl-2 pr-3 text-right font-semibold">Positive</th>
                </tr>
              </thead>
              <tbody className="text-[12.5px] [&>tr>td]:border-b [&>tr>td]:border-border/70 [&>tr:last-child>td]:border-b-0">
                {rows.map((row) => (
                  <tr key={row.id}>
                    <td className="py-2.5 pr-3">
                      <div className="flex items-center gap-2">
                        <span className="min-w-0 truncate font-medium">{row.name}</span>
                        <StatusPill status={row.status} />
                      </div>
                      {row.providerError ? (
                        <span
                          title={row.providerError}
                          className="mt-0.5 flex items-center gap-1 text-[11px] text-warning"
                        >
                          <AlertTriangle className="size-3" />
                          Smartlead data unavailable
                        </span>
                      ) : null}
                    </td>
                    <td className="px-2 py-2.5 text-right"><Num value={row.sent} /></td>
                    <td className="px-2 py-2.5 text-right"><Num value={row.uniqueSent} /></td>
                    <td className="px-2 py-2.5 text-right"><Num value={row.replies} /></td>
                    <td className="px-2 py-2.5 text-right"><Rate value={row.replyRatePct} /></td>
                    <td className="px-2 py-2.5 text-right"><Num value={row.leadBounces} /></td>
                    <td className="px-2 py-2.5 text-right"><Rate value={row.bounceRatePct} /></td>
                    <td className="px-2 py-2.5 text-right" title={row.senderBounces !== null ? `${row.senderBounces.toLocaleString()} sender bounce${row.senderBounces === 1 ? "" : "s"}` : undefined}><Rate value={row.senderBounceRatePct} /></td>
                    <td className="px-2 py-2.5 text-right"><Num value={row.capturedReplies} /></td>
                    <td className="py-2.5 pl-2 text-right font-medium text-success">
                      <Num value={row.positive} />
                    </td>
                  </tr>
                ))}
              </tbody>
              {totals !== null ? (
                // The totals row bookends the table in the header's own band
                // (surface-muted + semibold) so the summary reads at a glance
                // instead of blending into the body rows.
                <tfoot>
                  <tr className="text-[12.5px] font-semibold [&>td]:border-t [&>td]:border-border [&>td]:bg-surface-muted">
                    <td className="rounded-bl-md py-2.5 pr-3">
                      <div className="flex items-center gap-2">
                        <span>Total · {rows.length} campaign{rows.length === 1 ? "" : "s"}</span>
                        {totals.unreachable > 0 ? (
                          <span className="flex items-center gap-1 text-[11px] font-normal text-warning">
                            <AlertTriangle className="size-3" />
                            excludes {totals.unreachable} unreachable
                          </span>
                        ) : null}
                      </div>
                    </td>
                    <td className="px-2 py-2.5 text-right"><Num value={totals.sent} /></td>
                    <td className="px-2 py-2.5 text-right" title="Per-campaign uniques summed; a contact in two campaigns counts twice"><Num value={totals.uniqueSent} /></td>
                    <td className="px-2 py-2.5 text-right"><Num value={totals.replies} /></td>
                    <td className="px-2 py-2.5 text-right"><Rate value={totals.replyRatePct} /></td>
                    <td className="px-2 py-2.5 text-right"><Num value={totals.leadBounces} /></td>
                    <td className="px-2 py-2.5 text-right"><Rate value={totals.bounceRatePct} /></td>
                    <td className="px-2 py-2.5 text-right"><Rate value={totals.senderBounceRatePct} /></td>
                    <td className="px-2 py-2.5 text-right"><Num value={totals.captured} /></td>
                    <td className="rounded-br-md py-2.5 pl-2 text-right text-success"><Num value={totals.positive} /></td>
                  </tr>
                </tfoot>
              ) : null}
            </table>
          </div>
        </>
      )}
    </section>
  );
}

/* ── Root ───────────────────────────────────────────────────────────────── */
// Initial view is the server payload: 30 days, no campaign filter. Keeping the
// signature ref seeded to that exact view means the mount effect is a no-op and
// the first paint never refetches.
const INITIAL_SIGNATURE = "30|none|";

export function AnalyticsClient({
  initialData,
  campaigns,
}: {
  initialData: AnalyticsData;
  campaigns: CampaignChoice[];
}) {
  const [days, setDays] = useState<Days>(30);
  const [mode, setMode] = useState<Mode>("include");
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  const [data, setData] = useState<AnalyticsData>(initialData);
  const [dataError, setDataError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  // Drill-down: the open request snapshots kind + filters at click time, so
  // the modal can never disagree with the tiles it was opened from. Payloads
  // are cached per kind + filter signature for the life of the page; the Map
  // is created once and only read during render.
  const [drill, setDrill] = useState<{
    kind: AnalyticsDrillKind;
    days: Days;
    campaigns: AnalyticsDrillCampaigns;
  } | null>(null);
  const [drillCache] = useState(() => new Map<string, AnalyticsDrillPayload>());
  // Monotonic ticket so only the newest request writes, even when two requests
  // share a signature (flip away and back before the first resolves).
  const requestTicket = useRef(0);
  const loadedSignature = useRef<string>(INITIAL_SIGNATURE);

  // Mode is irrelevant while nothing is selected, so it is folded out of the
  // signature there — flipping the toggle then never triggers a refetch.
  const sortedIds = [...selectedIds].sort();
  const filterSignature = `${days}|${selectedIds.size ? mode : "none"}|${sortedIds.join(",")}`;

  const loadData = () => {
    const ticket = requestTicket.current + 1;
    requestTicket.current = ticket;
    loadedSignature.current = filterSignature;
    const filter = {
      days,
      campaigns: selectedIds.size ? { mode, ids: [...selectedIds] } : null,
    };
    startTransition(async () => {
      try {
        const result = await getAnalyticsDataAction(filter);
        // Only the latest request may write — stale wins are dropped.
        if (requestTicket.current !== ticket) return;
        if (result.ok && result.data) {
          setData(result.data);
          setDataError(null);
        } else {
          // Keep the stale data on screen; surface a quiet line with Retry.
          setDataError(result.message);
        }
      } catch {
        // Transport failure (offline, mid-deploy): same contract — stale data
        // stays visible with a Retry line, never the route error screen.
        if (requestTicket.current !== ticket) return;
        setDataError("Could not load analytics. Check your connection and retry.");
      }
    });
  };

  useEffect(() => {
    if (loadedSignature.current === filterSignature) return;
    loadData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filterSignature]);

  const toggleCampaign = (id: string) =>
    setSelectedIds((previous) => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const clearCampaigns = () => setSelectedIds(new Set());
  const resetAll = () => {
    setDays(30);
    setMode("include");
    setSelectedIds(new Set());
  };

  // The comparison table receives the raw include/exclude selection; the
  // server resolves it against its own fresh campaign list.
  const comparisonFilter: CampaignSelection | null =
    selectedIds.size === 0 ? null : { mode, ids: [...selectedIds] };

  // Distinct categorized LEADS, not positive+negative+neutral: those buckets
  // overlap (one lead can reply both positively and negatively), so summing
  // them would over-count the denominator and understate the rate.
  const categorized = data.categorizedLeads;
  const positiveRate = categorized > 0 ? Math.round((data.positiveCount / categorized) * 100) : 0;
  const peakPerDay = data.perDay.reduce(
    (max, day) => Math.max(max, day.positive + day.negative + day.neutral),
    0,
  );
  const maxCategory = data.categories.reduce((max, category) => Math.max(max, category.count), 1);
  const maxCampaign = data.campaigns.reduce((max, campaign) => Math.max(max, campaign.replies), 1);

  // For a 7-day window "N in the last 7 days" would just repeat the headline
  // number, so the hint describes the window instead. Keyed to the DATA's
  // window (not the control) so stale data is never mislabeled after a failed
  // range switch.
  const repliesHint =
    data.windowDays === 7 ? "Across the last 7 days" : `${data.replies7d} in the last 7 days`;
  const sentHint = data.sentFromInboxIsWorkspaceWide ? "Workspace-wide" : "Via Smartlead threads";

  const filtersActive = days !== 30 || selectedIds.size > 0;
  const busyClass = pending ? "opacity-60 transition-opacity" : "transition-opacity";

  // A tile is drillable only when its underlying count is nonzero (zero tiles
  // render as plain cards with no affordance).
  const drillOpen = (kind: AnalyticsDrillKind, count: number) =>
    count > 0
      ? () => setDrill({ kind, days, campaigns: selectedIds.size ? { mode, ids: sortedIds } : null })
      : undefined;

  return (
    <>
      {/* One quiet controls row under the header (reply-inbox toolbar idiom). */}
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border bg-surface px-5 py-2.5">
        <RangeControl value={days} onChange={setDays} />
        <CampaignFilter
          campaigns={campaigns}
          mode={mode}
          selectedIds={selectedIds}
          onModeChange={setMode}
          onToggle={toggleCampaign}
          onClear={clearCampaigns}
        />
        {filtersActive ? (
          <button type="button" onClick={resetAll} className={`${BTN_SUBTLE} h-8 px-2.5 text-[11.5px]`}>
            <X className="size-3.5" />
            Reset
          </button>
        ) : null}
        {pending ? (
          <span className="flex items-center gap-1.5 text-[11.5px] text-muted-foreground">
            <Loader2 className="size-3.5 animate-spin" />
            Updating
          </span>
        ) : null}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex max-w-[1600px] flex-col gap-4 p-6 xl:p-8">
          {dataError ? (
            <div className="flex flex-wrap items-center gap-2 rounded-lg border border-destructive/30 bg-destructive-soft px-3 py-2 text-[12px] text-destructive">
              <AlertTriangle className="size-3.5" />
              <span>{dataError}</span>
              <button
                type="button"
                onClick={loadData}
                className={`font-medium underline-offset-2 hover:underline`}
              >
                Retry
              </button>
            </div>
          ) : null}

          {/* 1 · KPI strip (each nonzero tile drills into its records) */}
          <div className={`grid grid-cols-2 gap-3 lg:grid-cols-4 2xl:grid-cols-8 ${busyClass}`}>
            <Kpi label="Leads replied" value={data.totalReplies} hint={repliesHint} onOpen={drillOpen("replies", data.totalReplies)} disabled={pending} />
            <Kpi label="Positive rate" value={`${positiveRate}%`} hint={`${data.positiveCount} of ${categorized} leads`} tone="text-success" onOpen={drillOpen("positive", data.positiveCount)} disabled={pending} />
            <Kpi label="Referrals captured" value={data.referralCount} hint="Leads who handed us off" onOpen={drillOpen("referrals", data.referralCount)} disabled={pending} />
            <Kpi
              label="Awaiting review"
              value={data.pendingCount}
              hint={`${data.approvedCount} leads approved so far`}
              tone={data.pendingCount > 0 ? "text-primary" : undefined}
              onOpen={drillOpen("awaiting_review", data.pendingCount)}
              disabled={pending}
            />
            <Kpi label="Out of office" value={data.oooCount} hint="Automated responses" onOpen={drillOpen("ooo", data.oooCount)} disabled={pending} />
            <Kpi label="Blocked · asked" value={data.dncExplicit} hint="Explicit do-not-contact" tone="text-destructive" onOpen={drillOpen("dnc_asked", data.dncExplicit)} disabled={pending} />
            <Kpi label="Blocked · dead mailbox" value={data.dncDefunct} hint="Addresses no longer in use" tone="text-warning" onOpen={drillOpen("dnc_defunct", data.dncDefunct)} disabled={pending} />
            <Kpi label="Replies sent from inbox" value={data.sentFromInbox} hint={sentHint} onOpen={drillOpen("sent_from_inbox", data.sentFromInbox)} disabled={pending} />
          </div>

          {/* 2 · Send volume (workspace-wide, lazy, self-loading) */}
          <SendVolumeSection days={days} />

          {/* 3 · Categorized replies per day */}
          <div className={`rounded-xl bg-surface p-5 shadow-xs ${busyClass}`}>
            <div className="flex items-baseline gap-3">
              <div>
                <h2 className="text-[13.5px] font-semibold tracking-tight">Categorized replies per day</h2>
                <p className="mt-0.5 text-xs text-muted-foreground">Last {data.windowDays} days</p>
              </div>
              <div className="ml-auto flex items-center gap-3.5">
                {peakPerDay > 0 ? (
                  <span className="inline-flex items-baseline gap-1 rounded-md bg-muted/70 px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
                    Peak <span className="tabular-nums text-foreground">{peakPerDay}</span>/day
                  </span>
                ) : null}
                <div className="flex items-center gap-3.5 text-[11.5px] text-muted-foreground">
                  <span className="flex items-center gap-1.5"><i className="size-2 rounded-full" style={{ background: CHART_POSITIVE }} /> Positive</span>
                  <span className="flex items-center gap-1.5"><i className="size-2 rounded-full" style={{ background: CHART_NEGATIVE }} /> Negative</span>
                  <span className="flex items-center gap-1.5"><i className="size-2 rounded-full" style={{ background: CHART_NEUTRAL }} /> Neutral</span>
                </div>
              </div>
            </div>
            {data.totalReplies === 0 ? (
              <p className="mt-6 text-[12px] text-muted-foreground">No replies captured in this window.</p>
            ) : (
              <CategorizedChart perDay={data.perDay} />
            )}
          </div>

          {/* 4 · Campaign comparison (lazy, self-loading) */}
          <CampaignComparison days={days} filter={comparisonFilter} />

          {/* 5 · Reply categories + By campaign */}
          <div className={`grid gap-4 lg:grid-cols-2 ${busyClass}`}>
            <div className="rounded-xl bg-surface p-5 shadow-xs">
              <h2 className="text-[13.5px] font-semibold tracking-tight">Reply categories</h2>
              <p className="mt-0.5 text-xs text-muted-foreground">Distinct leads per category</p>
              <div className="mt-3 flex flex-col">
                {data.categories.length === 0 ? (
                  <p className="text-xs text-muted-foreground">No categorized replies yet.</p>
                ) : (
                  data.categories.slice(0, 10).map((category) => (
                    <div
                      key={category.label}
                      className="grid grid-cols-[150px_1fr_40px] items-center gap-3 py-[7px] text-[12.5px]"
                    >
                      <span className="truncate">{category.label}</span>
                      <div className="h-2 overflow-hidden rounded-full bg-muted">
                        <div
                          className="h-full rounded-full"
                          style={{
                            width: `${(category.count / maxCategory) * 100}%`,
                            background: categoryColor(category.label, category.sentimentType),
                          }}
                        />
                      </div>
                      <span className="text-right tabular-nums text-muted-foreground">{category.count}</span>
                    </div>
                  ))
                )}
              </div>
            </div>

            <div className="rounded-xl bg-surface p-5 shadow-xs">
              <h2 className="text-[13.5px] font-semibold tracking-tight">By campaign</h2>
              <p className="mt-0.5 text-xs text-muted-foreground">Distinct leads per campaign</p>
              <div className="mt-2 flex flex-col">
                {data.campaigns.length === 0 ? (
                  <p className="text-xs text-muted-foreground">No replies attributed to campaigns yet.</p>
                ) : (
                  data.campaigns.map((campaign) => (
                    <div
                      key={campaign.id ?? `name:${campaign.name}`}
                      className="grid grid-cols-[1fr_auto] items-center gap-3 border-b border-border py-2.5 text-[13px] last:border-b-0"
                    >
                      <div className="flex items-center gap-2.5">
                        <span className="min-w-0 truncate">{campaign.name}</span>
                        <div className="h-1.5 w-16 shrink-0 overflow-hidden rounded-full bg-muted">
                          <div
                            className="h-full rounded-full bg-primary/70"
                            style={{ width: `${(campaign.replies / maxCampaign) * 100}%` }}
                          />
                        </div>
                      </div>
                      <span className="shrink-0 whitespace-nowrap text-[12.5px] tabular-nums text-muted-foreground">
                        {campaign.replies} lead{campaign.replies === 1 ? "" : "s"}
                        {campaign.positive > 0 ? (
                          <span className="ml-1 font-medium text-success">· {campaign.positive} positive</span>
                        ) : null}
                      </span>
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>
        </div>
      </div>

      {drill ? (
        <AnalyticsDrilldownModal
          kind={drill.kind}
          days={drill.days}
          campaigns={drill.campaigns}
          fallbackRepliesTotal={data.totalReplies}
          cache={drillCache}
          onClose={() => setDrill(null)}
        />
      ) : null}
    </>
  );
}
