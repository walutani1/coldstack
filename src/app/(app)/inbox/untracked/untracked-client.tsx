"use client";

import { useState } from "react";
import Link from "next/link";
import {
  ArrowLeft,
  ChevronDown,
  Loader2,
  MailQuestion,
  RotateCcw,
  ShieldAlert,
  Undo2,
} from "lucide-react";
import {
  dismissUntrackedReplyAction,
  getUntrackedOverviewAction,
  importUntrackedReplyAction,
  reclassifyUntrackedReplyAction,
  restoreUntrackedReplyAction,
} from "./actions";
import { useToast } from "../../toast";

/* ── Contract mirrors (see src/lib/untracked/queries.ts + candidates.ts) ── */

export type UntrackedCandidate = {
  index: number;
  leadId: string;
  name: string;
  email: string | null;
  company: string | null;
  domain: string | null;
  campaignIds: string[];
  evidence: string[];
};

export type UntrackedProposedContact = {
  email: string;
  first_name: string | null;
  last_name: string | null;
  company: string | null;
  domain: string | null;
};

export type UntrackedRow = {
  id: string;
  from_email: string | null;
  from_name: string | null;
  to_email: string | null;
  subject: string | null;
  body_text: string | null;
  provider_received_at: string | null;
  first_seen_at: string | null;
  status: string;
  automation_kind: string | null;
  classification_rule: string | null;
  candidate_snapshot: UntrackedCandidate[] | null;
  suggested_lead_id: string | null;
  suggested_campaign_id: string | null;
  match_confidence: number | null;
  match_rationale: string | null;
  proposed_contact: UntrackedProposedContact | null;
  last_error: string | null;
};

export type UntrackedGroupCounts = {
  actionable: number;
  cleaned: number;
  dismissed: number;
  imported: number;
  error: number;
};

export type UntrackedOverview = {
  rows: UntrackedRow[];
  page: number;
  pageSize: number;
  total: number;
  byStatus: Record<string, number>;
  groups: UntrackedGroupCounts;
};

export type CampaignOption = { id: string; name: string };

/* ── Tabs: UI group → server group → staging statuses ─────────────────── */
// actionable → new, processing, suggested, possible_match, unmatched
// cleaned    → automated, duplicate
// dismissed  → dismissed
// imported   → imported, importing
// error      → error

type TabKey = "actionable" | "cleaned" | "dismissed" | "imported" | "error";

const TABS: { key: TabKey; label: string }[] = [
  { key: "actionable", label: "Needs review" },
  { key: "cleaned", label: "Cleaned" },
  { key: "dismissed", label: "Dismissed" },
  { key: "imported", label: "Imported" },
  { key: "error", label: "Errors" },
];

const EMPTY_LINE: Record<TabKey, string> = {
  actionable: "Nothing needs review.",
  cleaned: "Nothing has been auto-cleaned.",
  dismissed: "No dismissed replies.",
  imported: "Nothing imported yet.",
  error: "No errors.",
};

/* ── Shared idioms (mirrored from inbox-client) ───────────────────────── */

const BTN_BASE =
  "inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-md font-medium transition disabled:cursor-not-allowed disabled:opacity-50";
const BTN_PRIMARY = `${BTN_BASE} bg-primary text-primary-foreground shadow-xs hover:opacity-90`;
const BTN_OUTLINE = `${BTN_BASE} border border-border bg-surface text-foreground shadow-xs hover:border-border-strong hover:bg-muted/60`;
const BTN_SUBTLE = `${BTN_BASE} bg-transparent text-muted-foreground hover:bg-muted/70 hover:text-foreground`;
const BTN_GHOST = `${BTN_BASE} bg-transparent text-foreground hover:bg-muted/70`;

const SELECT_CLASS =
  "h-7 w-full appearance-none rounded-md border border-border bg-surface pl-2 pr-6 text-[11.5px] font-medium text-foreground shadow-xs outline-none transition focus:border-ring disabled:cursor-not-allowed disabled:opacity-60";
const INPUT_CLASS =
  "h-7 w-full rounded-md border border-border bg-surface px-2 text-[11.5px] outline-none transition placeholder:text-muted-foreground focus:border-ring";

type BadgeVariant = "outline" | "success" | "info" | "warning" | "ghost" | "destructive";
const BADGE_VARIANT: Record<BadgeVariant, string> = {
  outline: "border border-border bg-surface font-normal text-foreground",
  success: "bg-success-soft text-success",
  info: "bg-info-soft text-info",
  warning: "bg-warning-soft text-warning",
  ghost: "bg-muted text-muted-foreground",
  destructive: "bg-destructive-soft text-destructive",
};

const STATUS_CHIP: Record<string, { label: string; variant: BadgeVariant }> = {
  new: { label: "Queued", variant: "ghost" },
  processing: { label: "Processing", variant: "ghost" },
  suggested: { label: "Suggested match", variant: "info" },
  possible_match: { label: "Possible match", variant: "warning" },
  unmatched: { label: "Unmatched", variant: "outline" },
  automated: { label: "Auto-cleaned", variant: "ghost" },
  duplicate: { label: "Duplicate", variant: "ghost" },
  importing: { label: "Importing", variant: "info" },
  imported: { label: "Imported", variant: "success" },
  dismissed: { label: "Dismissed", variant: "ghost" },
  error: { label: "Error", variant: "destructive" },
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const CREATE_CHOICE = "__create__";
const NO_CAMPAIGN = "__none__";

function Badge({ variant, children }: { variant: BadgeVariant; children: React.ReactNode }) {
  return (
    <span
      className={`inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2 text-[11px] font-medium leading-5 tracking-tight ${BADGE_VARIANT[variant]}`}
    >
      {children}
    </span>
  );
}

// Relative received-time, pinned to the workspace timezone/locale so server
// and client render identical strings (same rule as the inbox list).
function timeLabel(iso: string | null, timeZone: string, timeLocale: string) {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const diff = Date.now() - date.getTime();
  if (diff < 60_000) return "now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h`;
  if (diff < 7 * 86_400_000) return date.toLocaleDateString(timeLocale, { weekday: "short", timeZone });
  return date.toLocaleDateString(timeLocale, { month: "short", day: "numeric", timeZone });
}

// body_text/subject are untrusted external email content: rendered as plain
// text nodes only (React escapes), collapsed and hard-truncated.
function previewText(value: string | null, max = 500) {
  const collapsed = (value ?? "").replace(/\s+/g, " ").trim();
  return collapsed.length > max ? `${collapsed.slice(0, max)}…` : collapsed;
}

function clip(value: string | null, max: number) {
  const text = (value ?? "").trim();
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/* ── Per-row review card ──────────────────────────────────────────────── */

function ReviewCard({
  row,
  campaigns,
  timeZone,
  timeLocale,
  onImported,
  onDismissed,
  onRestored,
  onReclassified,
}: {
  row: UntrackedRow;
  campaigns: CampaignOption[];
  timeZone: string;
  timeLocale: string;
  onImported: (rowId: string, message: string) => void;
  onDismissed: (rowId: string) => void;
  onRestored: (rowId: string) => void;
  onReclassified: (message: string) => void;
}) {
  const candidates = row.candidate_snapshot ?? [];
  const suggestion =
    row.suggested_lead_id != null
      ? (candidates.find((candidate) => candidate.leadId === row.suggested_lead_id) ?? null)
      : null;

  const campaignsOfLead = (leadId: string): string[] => {
    const candidate = candidates.find((item) => item.leadId === leadId);
    return candidate ? [...new Set(candidate.campaignIds)] : [];
  };

  // Default campaign for a lead choice: honor the classifier suggestion for
  // the suggested lead; otherwise a lead with exactly one campaign preselects
  // it, multiple campaigns force an explicit decision (empty sentinel).
  const defaultCampaignFor = (choiceValue: string): string => {
    if (!choiceValue || choiceValue === CREATE_CHOICE) return NO_CAMPAIGN;
    if (choiceValue === row.suggested_lead_id && row.suggested_campaign_id) return row.suggested_campaign_id;
    const ids = campaignsOfLead(choiceValue);
    if (ids.length === 1) return ids[0];
    return ids.length > 1 ? "" : NO_CAMPAIGN;
  };

  // Suggested/possible_match preselect the suggestion; unmatched starts empty
  // (proposed_contact only prefills the form once "Create new contact…" is chosen).
  const initialChoice = row.suggested_lead_id && suggestion ? row.suggested_lead_id : "";
  const [choice, setChoice] = useState<string>(initialChoice);
  const [campaign, setCampaign] = useState<string>(() => defaultCampaignFor(initialChoice));
  const [contact, setContact] = useState(() => ({
    email: row.proposed_contact?.email ?? row.from_email ?? "",
    first_name: row.proposed_contact?.first_name ?? "",
    last_name: row.proposed_contact?.last_name ?? "",
    company: row.proposed_contact?.company ?? "",
  }));
  const [pending, setPending] = useState<"import" | "dismiss" | "restore" | "reclassify" | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const chip = STATUS_CHIP[row.status] ?? { label: row.status, variant: "ghost" as BadgeVariant };
  const sender = clip(row.from_name, 80) || clip(row.from_email, 120) || "Unknown sender";
  const senderEmail = row.from_name && row.from_email ? clip(row.from_email, 120) : null;
  const received = timeLabel(row.provider_received_at ?? row.first_seen_at, timeZone, timeLocale);
  const preview = previewText(row.body_text);

  const reviewable = ["suggested", "possible_match", "unmatched"].includes(row.status);
  const leadChosen = choice !== "" && choice !== CREATE_CHOICE;
  const campaignRequired = leadChosen && campaignsOfLead(choice).length > 1 && campaign === "";
  const contactValid = choice === CREATE_CHOICE && EMAIL_RE.test(contact.email.trim());
  const canImport = (leadChosen || contactValid) && !campaignRequired;

  // Every campaign id the row references stays selectable even if the
  // Smartlead campaign list failed to load (label falls back to the raw id).
  const knownIds = new Set(campaigns.map((option) => option.id));
  const extraIds = [
    ...new Set(
      [row.suggested_campaign_id, ...candidates.flatMap((candidate) => candidate.campaignIds)].filter(
        (id): id is string => Boolean(id) && !knownIds.has(id as string),
      ),
    ),
  ];

  const pickChoice = (value: string) => {
    setChoice(value);
    setCampaign(defaultCampaignFor(value));
    setNote(null);
  };

  const run = async (
    kind: "import" | "dismiss" | "restore" | "reclassify",
    action: () => Promise<{ ok: boolean; message: string }>,
    onOk: (message: string) => void,
  ) => {
    setPending(kind);
    setNote(null);
    try {
      const result = await action();
      if (result.ok) onOk(result.message);
      else setNote(result.message);
    } catch {
      setNote("Something went wrong. Try again.");
    } finally {
      setPending(null);
    }
  };

  const handleImport = () =>
    run(
      "import",
      () =>
        importUntrackedReplyAction(
          row.id,
          choice === CREATE_CHOICE
            ? {
                createContact: {
                  email: contact.email.trim(),
                  first_name: contact.first_name.trim() || null,
                  last_name: contact.last_name.trim() || null,
                  company: contact.company.trim() || null,
                  domain: row.proposed_contact?.domain ?? null,
                },
                campaignId: campaign && campaign !== NO_CAMPAIGN ? campaign : null,
              }
            : { leadId: choice, campaignId: campaign && campaign !== NO_CAMPAIGN ? campaign : null },
        ),
      (message) => onImported(row.id, message),
    );

  return (
    <article className="rounded-lg bg-surface p-3 shadow-xs">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-baseline gap-x-1.5">
            <span className="max-w-full truncate text-[12px] font-medium tracking-tight">{sender}</span>
            {senderEmail ? <span className="truncate text-[11px] text-muted-foreground">{senderEmail}</span> : null}
          </div>
          <div className="mt-0.5 truncate text-[12px] font-medium">{clip(row.subject, 160) || "(no subject)"}</div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Badge variant={chip.variant}>{chip.label}</Badge>
          {received ? <span className="tabular text-[11px] text-muted-foreground">{received}</span> : null}
        </div>
      </div>

      {preview ? (
        <p className="mt-1.5 line-clamp-3 break-words text-[11px] leading-relaxed text-muted-foreground">{preview}</p>
      ) : null}

      {row.status === "automated" || row.status === "duplicate" ? (
        <p className="mt-1.5 text-[11px] text-muted-foreground">
          Cleaned · {row.automation_kind ?? "duplicate"} · rule: {row.classification_rule ?? "unknown"}
        </p>
      ) : null}

      {row.status === "new" || row.status === "processing" ? (
        <p className="mt-1.5 text-[11px] text-muted-foreground">
          {row.status === "processing" ? "Being classified right now." : "Waiting for automatic matching."}
        </p>
      ) : null}

      {(row.status === "suggested" || row.status === "possible_match") && suggestion ? (
        <div className="mt-2 rounded-md bg-muted/40 px-2.5 py-2">
          <p className="text-[12px]">
            Looks like: <span className="font-medium">{clip(suggestion.name, 80)}</span>
            {suggestion.email ? ` (${clip(suggestion.email, 120)})` : ""}
            {suggestion.company ? ` · ${clip(suggestion.company, 80)}` : ""}
            {row.match_confidence != null ? (
              <span className="text-[11px] text-muted-foreground"> · {Math.round(row.match_confidence * 100)}% match</span>
            ) : null}
          </p>
          {row.match_rationale ? (
            <p className="mt-0.5 text-[11px] leading-relaxed text-muted-foreground">{clip(row.match_rationale, 300)}</p>
          ) : null}
        </div>
      ) : null}

      {row.status === "error" && row.last_error ? (
        <p className="mt-1.5 break-words text-[11px] text-muted-foreground">Last error: {clip(row.last_error, 300)}</p>
      ) : null}

      {reviewable ? (
        <div className="mt-2.5 flex flex-col gap-2">
          <div className="flex flex-col gap-1.5 sm:flex-row">
            <div className="relative flex-1">
              <select
                value={choice}
                onChange={(event) => pickChoice(event.target.value)}
                disabled={pending !== null}
                aria-label="Attach to lead"
                className={SELECT_CLASS}
              >
                <option value="">Choose a lead…</option>
                {candidates.map((candidate) => (
                  <option key={candidate.leadId} value={candidate.leadId}>
                    {[candidate.name, candidate.email, candidate.company].filter(Boolean).join(" · ")}
                  </option>
                ))}
                <option value={CREATE_CHOICE}>Create new contact…</option>
              </select>
              <ChevronDown className="pointer-events-none absolute right-1.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            </div>
            <div className="relative flex-1">
              <select
                value={campaign}
                onChange={(event) => setCampaign(event.target.value)}
                disabled={pending !== null}
                aria-label="Attribute to campaign"
                className={SELECT_CLASS}
              >
                {campaignRequired ? (
                  <option value="" disabled>
                    Choose a campaign…
                  </option>
                ) : null}
                <option value={NO_CAMPAIGN}>No campaign</option>
                {campaigns.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.name}
                  </option>
                ))}
                {extraIds.map((id) => (
                  <option key={id} value={id}>
                    Campaign {id}
                  </option>
                ))}
              </select>
              <ChevronDown className="pointer-events-none absolute right-1.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            </div>
          </div>

          {choice === CREATE_CHOICE ? (
            <div className="grid grid-cols-2 gap-1.5">
              <input
                value={contact.email}
                onChange={(event) => setContact((prev) => ({ ...prev, email: event.target.value }))}
                placeholder="Email"
                aria-label="New contact email"
                className={`${INPUT_CLASS} col-span-2 sm:col-span-1`}
              />
              <input
                value={contact.company}
                onChange={(event) => setContact((prev) => ({ ...prev, company: event.target.value }))}
                placeholder="Company"
                aria-label="New contact company"
                className={`${INPUT_CLASS} col-span-2 sm:col-span-1`}
              />
              <input
                value={contact.first_name}
                onChange={(event) => setContact((prev) => ({ ...prev, first_name: event.target.value }))}
                placeholder="First name"
                aria-label="New contact first name"
                className={INPUT_CLASS}
              />
              <input
                value={contact.last_name}
                onChange={(event) => setContact((prev) => ({ ...prev, last_name: event.target.value }))}
                placeholder="Last name"
                aria-label="New contact last name"
                className={INPUT_CLASS}
              />
            </div>
          ) : null}

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              disabled={pending !== null || !canImport}
              onClick={handleImport}
              className={`${BTN_PRIMARY} h-8 px-3 text-[12px]`}
            >
              {pending === "import" ? <Loader2 className="size-3.5 animate-spin" /> : null}
              {pending === "import" ? "Importing…" : "Import & analyze"}
            </button>
            <button
              type="button"
              disabled={pending !== null}
              onClick={() => run("dismiss", () => dismissUntrackedReplyAction(row.id), () => onDismissed(row.id))}
              className={`${BTN_GHOST} h-8 px-2.5 text-[12px]`}
            >
              {pending === "dismiss" ? <Loader2 className="size-3.5 animate-spin" /> : null}
              Dismiss
            </button>
            {row.status === "unmatched" ? (
              <button
                type="button"
                disabled={pending !== null}
                onClick={() => run("reclassify", () => reclassifyUntrackedReplyAction(row.id), onReclassified)}
                className={`${BTN_SUBTLE} ml-auto h-8 px-2.5 text-[12px]`}
              >
                {pending === "reclassify" ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : (
                  <RotateCcw className="size-3.5" />
                )}
                Re-run matching
              </button>
            ) : null}
          </div>
          {campaignRequired ? (
            <p className="text-[11px] text-muted-foreground">This lead is in more than one campaign. Pick one (or No campaign) to import.</p>
          ) : null}
        </div>
      ) : null}

      {row.status === "new" ? (
        <div className="mt-2 flex items-center gap-2">
          <button
            type="button"
            disabled={pending !== null}
            onClick={() => run("dismiss", () => dismissUntrackedReplyAction(row.id), () => onDismissed(row.id))}
            className={`${BTN_GHOST} h-8 px-2.5 text-[12px]`}
          >
            {pending === "dismiss" ? <Loader2 className="size-3.5 animate-spin" /> : null}
            Dismiss
          </button>
        </div>
      ) : null}

      {row.status === "dismissed" ? (
        <div className="mt-2 flex items-center gap-2">
          <button
            type="button"
            disabled={pending !== null}
            onClick={() => run("restore", () => restoreUntrackedReplyAction(row.id), () => onRestored(row.id))}
            className={`${BTN_GHOST} h-8 px-2.5 text-[12px]`}
          >
            {pending === "restore" ? <Loader2 className="size-3.5 animate-spin" /> : <Undo2 className="size-3.5" />}
            Restore
          </button>
        </div>
      ) : null}

      {row.status === "error" ? (
        <div className="mt-2 flex items-center gap-2">
          <button
            type="button"
            disabled={pending !== null}
            onClick={() => run("reclassify", () => reclassifyUntrackedReplyAction(row.id), onReclassified)}
            className={`${BTN_OUTLINE} h-8 px-2.5 text-[12px]`}
          >
            {pending === "reclassify" ? <Loader2 className="size-3.5 animate-spin" /> : <RotateCcw className="size-3.5" />}
            Re-run
          </button>
        </div>
      ) : null}

      {note ? <p className="mt-2 text-[11px] text-destructive">{note}</p> : null}
    </article>
  );
}

/* ── Page client ──────────────────────────────────────────────────────── */

type GroupState = { rows: UntrackedRow[]; total: number; page: number };

export function UntrackedClient({
  initialOverview,
  campaigns,
  timeZone,
  timeLocale,
}: {
  initialOverview: UntrackedOverview;
  campaigns: CampaignOption[];
  timeZone: string;
  timeLocale: string;
}) {
  const [tab, setTab] = useState<TabKey>("actionable");
  const [groups, setGroups] = useState<Partial<Record<TabKey, GroupState>>>({
    actionable: { rows: initialOverview.rows, total: initialOverview.total, page: initialOverview.page },
  });
  const [counts, setCounts] = useState<UntrackedGroupCounts>(initialOverview.groups);
  const [tabLoading, setTabLoading] = useState(false);
  const [moreLoading, setMoreLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const showToast = useToast();

  const fetchGroup = async (key: TabKey, page: number, mode: "replace" | "append") => {
    try {
      const result = await getUntrackedOverviewAction({ group: key, page });
      if (!result.ok) {
        setLoadError(result.message);
        return;
      }
      const overview = result.overview as UntrackedOverview;
      setLoadError(null);
      setCounts(overview.groups);
      setGroups((prev) => {
        const existing = prev[key];
        const incoming = overview.rows;
        const rows =
          mode === "append" && existing
            ? [...existing.rows, ...incoming.filter((row) => !existing.rows.some((item) => item.id === row.id))]
            : incoming;
        return { ...prev, [key]: { rows, total: overview.total, page: overview.page } };
      });
    } catch {
      setLoadError("Could not load untracked replies. Try again.");
    }
  };

  const selectTab = (key: TabKey) => {
    setTab(key);
    setLoadError(null);
    if (!groups[key]) {
      setTabLoading(true);
      void fetchGroup(key, 1, "replace").finally(() => setTabLoading(false));
    }
  };

  const removeRow = (rowId: string, key: TabKey) =>
    setGroups((prev) => {
      const existing = prev[key];
      if (!existing) return prev;
      const rows = existing.rows.filter((row) => row.id !== rowId);
      if (rows.length === existing.rows.length) return prev;
      return { ...prev, [key]: { ...existing, rows, total: Math.max(0, existing.total - 1) } };
    });

  // Cross-group moves adjust counts locally and drop the destination group's
  // cache so the next visit refetches fresh rows.
  const invalidate = (key: TabKey) =>
    setGroups((prev) => {
      if (!(key in prev)) return prev;
      const next = { ...prev };
      delete next[key];
      return next;
    });

  const handleImported = (rowId: string, message: string) => {
    removeRow(rowId, "actionable");
    setCounts((prev) => ({ ...prev, actionable: Math.max(0, prev.actionable - 1), imported: prev.imported + 1 }));
    invalidate("imported");
    showToast(true, message);
  };

  const handleDismissed = (rowId: string) => {
    removeRow(rowId, "actionable");
    setCounts((prev) => ({ ...prev, actionable: Math.max(0, prev.actionable - 1), dismissed: prev.dismissed + 1 }));
    invalidate("dismissed");
    showToast(true, "Dismissed.");
  };

  const handleRestored = (rowId: string) => {
    removeRow(rowId, "dismissed");
    setCounts((prev) => ({ ...prev, dismissed: Math.max(0, prev.dismissed - 1), actionable: prev.actionable + 1 }));
    invalidate("actionable");
    showToast(true, "Restored to review.");
  };

  const handleReclassified = (message: string) => {
    showToast(true, message);
    // Reclassification can move the row to any group: drop every cache and
    // refetch the visible tab (its overview also refreshes all counts).
    setGroups({});
    setTabLoading(true);
    void fetchGroup(tab, 1, "replace").finally(() => setTabLoading(false));
  };

  const current = groups[tab];
  const hasMore = current != null && current.rows.length < current.total;

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <header className="flex h-14 shrink-0 items-center gap-3 border-b border-border bg-surface px-4">
        <Link
          href="/inbox"
          className="inline-flex shrink-0 items-center gap-1.5 text-[12px] font-medium text-muted-foreground transition hover:text-foreground"
        >
          <ArrowLeft className="size-3.5" />
          Back to inbox
        </Link>
        <span className="h-4 w-px shrink-0 bg-border" aria-hidden />
        <MailQuestion className="size-4 shrink-0 text-muted-foreground" strokeWidth={1.75} />
        <h1 className="shrink-0 text-[15px] font-semibold tracking-tight">Untracked replies</h1>
        <p className="hidden min-w-0 truncate text-[12px] text-muted-foreground md:block">
          Inbound email that could not be tied to a tracked lead. Import the real ones, ignore the noise.
        </p>
      </header>

      <div className="flex shrink-0 items-center border-b border-border bg-surface px-4 py-2">
        <div className="flex gap-1 rounded-md bg-muted/60 p-0.5">
          {TABS.map(({ key, label }) => (
            <button
              key={key}
              type="button"
              onClick={() => selectTab(key)}
              className={`h-7 whitespace-nowrap rounded px-2.5 text-[11.5px] font-medium transition ${
                tab === key ? "bg-surface text-foreground shadow-xs" : "text-muted-foreground hover:text-foreground"
              }`}
            >
              {counts[key] > 0 ? `${label} · ${counts[key]}` : label}
            </button>
          ))}
        </div>
      </div>

      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-2 px-5 py-4">
          {loadError ? (
            <div className="flex items-center gap-2 rounded-lg bg-destructive-soft px-3 py-2.5 text-[12px] text-destructive">
              <ShieldAlert className="size-3.5 shrink-0" />
              <span className="min-w-0 break-words">{loadError}</span>
              <button
                type="button"
                onClick={() => {
                  setTabLoading(true);
                  void fetchGroup(tab, 1, "replace").finally(() => setTabLoading(false));
                }}
                className="ml-auto shrink-0 text-[11px] font-medium underline-offset-2 hover:underline"
              >
                Retry
              </button>
            </div>
          ) : null}

          {tabLoading && !current ? (
            <>
              {[0, 1, 2].map((index) => (
                <div key={index} className="h-20 animate-pulse rounded-lg border border-border bg-muted/40" />
              ))}
            </>
          ) : current && current.rows.length === 0 ? (
            <div className="flex items-center gap-2 px-1 py-10 text-[12px] text-muted-foreground">
              {tab === "actionable" ? <span className="size-1.5 shrink-0 rounded-full bg-success" aria-hidden /> : null}
              <span>{EMPTY_LINE[tab]}</span>
            </div>
          ) : (
            <>
              {(current?.rows ?? []).map((row) => (
                <ReviewCard
                  key={row.id}
                  row={row}
                  campaigns={campaigns}
                  timeZone={timeZone}
                  timeLocale={timeLocale}
                  onImported={handleImported}
                  onDismissed={handleDismissed}
                  onRestored={handleRestored}
                  onReclassified={handleReclassified}
                />
              ))}
              {hasMore ? (
                <button
                  type="button"
                  disabled={moreLoading}
                  onClick={() => {
                    setMoreLoading(true);
                    void fetchGroup(tab, (current?.page ?? 1) + 1, "append").finally(() => setMoreLoading(false));
                  }}
                  className={`${BTN_OUTLINE} h-8 self-center px-3 text-[12px]`}
                >
                  {moreLoading ? <Loader2 className="size-3.5 animate-spin" /> : null}
                  Load more
                </button>
              ) : null}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
