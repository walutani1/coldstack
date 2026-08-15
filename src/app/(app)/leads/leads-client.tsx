"use client";

import { useCallback, useEffect, useRef, useState, useTransition, type CSSProperties } from "react";
import { useRouter } from "next/navigation";
import {
  AlertTriangle,
  ArrowDownWideNarrow,
  ArrowUpNarrowWide,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  ListFilter,
  Loader2,
  Lock,
  Pencil,
  Search,
  Users,
  X,
} from "lucide-react";
import { buildSmartleadConversationUrl } from "@/lib/smartlead/links";
import { getCrmLeadDetailAction, getCrmLeadsPageAction, updateCrmLeadAction } from "./actions";
import { useToast } from "../toast";

/* ── Contract mirrors (declared locally so the client never imports a
   server-only module - the same pattern as the other page clients; only the
   action functions cross the boundary). ─────────────────────────────────── */
export type CampaignChoice = { id: string; name: string; status: string | null };

export type LeadRow = {
  id: string;
  firstName: string | null;
  lastName: string | null;
  title: string | null;
  company: string | null;
  domain: string | null;
  email: string | null;
  linkedinUrl: string | null;
  country: string | null;
  membershipSource: "exported" | "legacy" | "reply_only";
  campaignId: string | null;
  campaignName: string | null;
  exportedAt: string | null;
  smartleadLeadId: string | null;
  lastReplyAt: string | null;
  lastReplyEventId: string | null;
  lastReplyCategory: string | null;
  lastReplySentimentType: string | null;
  replied: boolean;
  positiveAny: boolean;
};

/** Filter state the server page seeds from the deep-link contract. The extra
    fields (categories, proposalStatuses, dncReasons, dncApprovedOnly) have no
    toolbar control of their own - a kind banner explains them, and Clear
    resets them along with everything else. */
export type InitialLeadsView = {
  campaignIds: string[];
  campaignMode: "include" | "exclude";
  search: string;
  replied: boolean;
  positive: boolean;
  referral: boolean;
  dnc: boolean;
  dncReasons: string[];
  dncApprovedOnly: boolean;
  proposalStatuses: string[];
  categories: string[];
  days: 0 | 7 | 30 | 90;
};

type SortKey = "last_reply_at" | "exported_at" | "name" | "company";
type Membership = "all" | "exported" | "reply_only";

type LeadsView = InitialLeadsView & {
  membership: Membership;
  sort: SortKey;
  dir: "asc" | "desc";
  page: number;
};

type LeadsPage = { rows: LeadRow[]; total: number };

type DetailProposal = {
  sentiment: string | null;
  sentiment_type: string | null;
  status: string | null;
};

type DetailReply = {
  id: string;
  subject: string | null;
  snippet: string;
  smartlead_category: string | null;
  campaign_name: string | null;
  received_at: string | null;
  created_at: string;
  latestProposal: DetailProposal | null;
};

type DetailExport = {
  id: string;
  campaign_id: string;
  campaign_name: string | null;
  status: string;
  error: string | null;
  exported_at: string;
};

type DetailRun = {
  id: string;
  action: string;
  ok: boolean;
  message: string | null;
  created_at: string;
};

type LeadDetail = {
  lead: Record<string, unknown>;
  /** Resolved server-side (leads column, reply events, then a live Smartlead
      lookup) so the drawer can deep-link to the lead's own Smartlead page. */
  smartleadLeadId: string | null;
  replies: DetailReply[];
  repliesTotal: number;
  exports: DetailExport[];
  leadRuns: DetailRun[];
};

/* ── Shared style constants (copied conventions, intentionally not shared) ── */
const BTN_BASE = `inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-md font-medium transition disabled:cursor-not-allowed disabled:opacity-50`;
const BTN_OUTLINE = `${BTN_BASE} border border-border bg-surface text-foreground shadow-xs hover:border-border-strong hover:bg-muted/60`;
const BTN_SUBTLE = `${BTN_BASE} bg-transparent text-muted-foreground hover:bg-muted/70 hover:text-foreground`;
const BTN_PRIMARY = `${BTN_BASE} bg-primary text-primary-foreground shadow-xs hover:bg-primary/90`;
const INPUT_CLASS =
  "h-8 w-full rounded-md border border-border bg-surface px-2.5 text-[12.5px] text-foreground shadow-xs outline-none transition placeholder:text-muted-foreground focus:border-ring";

const PAGE_SIZE = 50;
const FULL = new Intl.NumberFormat("en-US");

/* ── Presentation helpers ────────────────────────────────────────────────── */
function nameOf(row: LeadRow): string {
  return `${row.firstName ?? ""} ${row.lastName ?? ""}`.trim() || row.email || "Unknown";
}

function companyWebsite(domain: string | null): { domain: string; href: string } | null {
  if (!domain) return null;
  const normalized = domain.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/+$/, "");
  // Interior whitespace means malformed data ("acme .com"); refuse to
  // fabricate a hostname out of it.
  if (/\s/.test(normalized)) return null;
  const hostname = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
  return hostname.test(normalized) ? { domain: normalized, href: `https://${normalized}` } : null;
}

/** Workspace-pinned dates: explicit locale + zone so server and client render
    identical strings (no hydration mismatch), same idiom as the reply inbox. */
function shortDate(iso: string | null, timeZone: string, timeLocale: string): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleDateString(timeLocale, { month: "short", day: "numeric", year: "numeric", timeZone });
}

function fullTime(iso: string | null, timeZone: string, timeLocale: string): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleString(timeLocale, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone,
  });
}

/** Category pill tone keyed off the sentiment-type token, matching the app's
    reply-pill grammar (success / destructive / muted soft pairs). */
function sentimentTone(sentimentType: string | null): string {
  if (sentimentType === "positive") return "bg-success-soft text-success";
  if (sentimentType === "negative") return "bg-destructive-soft text-destructive";
  return "bg-muted text-muted-foreground";
}

function CategoryPill({ label, sentimentType }: { label: string; sentimentType: string | null }) {
  return (
    <span
      title={label}
      className={`inline-block max-w-[160px] truncate rounded px-1.5 py-px align-middle text-[10.5px] font-medium ${sentimentTone(sentimentType)}`}
    >
      {label}
    </span>
  );
}

function QuietPill({ label }: { label: string }) {
  return (
    <span
      title={label}
      className="inline-block max-w-[180px] truncate rounded bg-muted px-1.5 py-px align-middle text-[10.5px] font-medium text-muted-foreground"
    >
      {label}
    </span>
  );
}

/** A muted dot stands in for a missing value so an empty cell never reads as
    data (the analytics table's idiom). */
function Blank() {
  return <span className="text-muted-foreground/40">·</span>;
}

/* ── Toolbar select - the reply inbox's exact bordered idiom, toolbar-sized ── */
function FilterSelect({
  value,
  onChange,
  ariaLabel,
  children,
}: {
  value: string;
  onChange: (event: React.ChangeEvent<HTMLSelectElement>) => void;
  ariaLabel: string;
  children: React.ReactNode;
}) {
  return (
    <div className="relative">
      <select
        value={value}
        onChange={onChange}
        aria-label={ariaLabel}
        className={`h-8 appearance-none rounded-md border border-border bg-surface pl-2.5 pr-7 text-[12px] font-medium text-foreground shadow-xs transition focus:border-ring`}
      >
        {children}
      </select>
      <ChevronDown className="pointer-events-none absolute right-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
    </div>
  );
}

/* ── Campaign multi-select popover (analytics idiom, include-only: the leads
   filter takes a concrete id list; exclude deep-links are complemented on the
   server before they reach this control) ────────────────────────────────── */
function CampaignFilter({
  campaigns,
  selectedIds,
  mode,
  onToggle,
  onClear,
}: {
  campaigns: CampaignChoice[];
  selectedIds: string[];
  mode: "include" | "exclude";
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

  const selected = new Set(selectedIds);
  const count = selected.size;
  const label = count === 0
    ? "All campaigns"
    : `${mode === "exclude" ? "Excluding" : "Including"} ${count} campaign${count === 1 ? "" : "s"}`;
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
          {campaigns.length > 6 ? (
            <div className="relative">
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
                const checked = selected.has(campaign.id);
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

/* ── Lead detail drawer (host modal grammar: backdrop, Escape, scroll lock) ── */
function DrawerSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="border-b border-border px-5 py-4">
      <h3 className="text-[10.5px] font-semibold uppercase tracking-[0.08em] text-foreground-subtle">{title}</h3>
      <div className="mt-2.5">{children}</div>
    </section>
  );
}

function IdentityRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[88px_1fr] items-baseline gap-2 text-[12.5px]">
      <span className="text-[11px] text-muted-foreground">{label}</span>
      <span className="min-w-0 truncate">{children}</span>
    </div>
  );
}

/* ── Lead editing ─────────────────────────────────────────────────────────
   The drawer edits the app's own stored lead (never Smartlead copies). The
   form baselines off the freshly loaded detail so a save diff carries only the
   changed fields; the lead's updated_at rides along as the concurrency marker.
   The patch type mirrors the server action's contract locally (the client
   never imports the server-only queries module). */
type LeadEditPatch = {
  firstName?: string;
  lastName?: string;
  title?: string;
  company?: string;
  domain?: string;
  linkedinUrl?: string;
  rawPatch?: Record<string, string>;
};

type EditForm = {
  firstName: string;
  lastName: string;
  title: string;
  company: string;
  domain: string;
  linkedinUrl: string;
  raw: Record<string, string>;
};

const EMPTY_FORM: EditForm = {
  firstName: "",
  lastName: "",
  title: "",
  company: "",
  domain: "",
  linkedinUrl: "",
  raw: {},
};

const IDENTITY_COLUMNS: { field: Exclude<keyof EditForm, "raw">; column: string; label: string; long?: boolean }[] = [
  { field: "firstName", column: "first_name", label: "First name" },
  { field: "lastName", column: "last_name", label: "Last name" },
  { field: "title", column: "title", label: "Title" },
  { field: "company", column: "company", label: "Company" },
  { field: "domain", column: "domain", label: "Domain", long: true },
  { field: "linkedinUrl", column: "linkedin_url", label: "LinkedIn", long: true },
];

function leadString(lead: Record<string, unknown>, key: string): string {
  return typeof lead[key] === "string" ? (lead[key] as string) : "";
}

function stringRawEntries(lead: Record<string, unknown>): [string, string][] {
  const raw = lead.raw;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
  return Object.entries(raw as Record<string, unknown>)
    .filter((entry): entry is [string, string] => typeof entry[1] === "string" && entry[1].trim() !== "")
    .sort(([a], [b]) => a.localeCompare(b));
}

function nonStringRawEntries(lead: Record<string, unknown>): [string, unknown][] {
  const raw = lead.raw;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
  return Object.entries(raw as Record<string, unknown>)
    .filter((entry) => typeof entry[1] !== "string")
    .sort(([a], [b]) => a.localeCompare(b));
}

function makeBaseline(lead: Record<string, unknown>): EditForm {
  return {
    firstName: leadString(lead, "first_name"),
    lastName: leadString(lead, "last_name"),
    title: leadString(lead, "title"),
    company: leadString(lead, "company"),
    domain: leadString(lead, "domain"),
    linkedinUrl: leadString(lead, "linkedin_url"),
    raw: Object.fromEntries(stringRawEntries(lead)),
  };
}

/** Fresh DB row (snake_case) → the table row's editable columns, so the list
    reflects the edit without a refetch. */
function rowPatchFromLead(lead: Record<string, unknown>): Partial<LeadRow> {
  const value = (key: string): string | null => (typeof lead[key] === "string" ? (lead[key] as string) : null);
  return {
    firstName: value("first_name"),
    lastName: value("last_name"),
    title: value("title"),
    company: value("company"),
    domain: value("domain"),
    linkedinUrl: value("linkedin_url"),
  };
}

function buildEditPatch(form: EditForm, baseline: EditForm): LeadEditPatch {
  const patch: LeadEditPatch = {};
  for (const { field } of IDENTITY_COLUMNS) {
    if (form[field] !== baseline[field]) patch[field] = form[field];
  }
  const rawPatch: Record<string, string> = {};
  for (const key of Object.keys(form.raw)) {
    if (form.raw[key] !== baseline.raw[key]) rawPatch[key] = form.raw[key];
  }
  if (Object.keys(rawPatch).length > 0) patch.rawPatch = rawPatch;
  return patch;
}

function isDirty(form: EditForm, baseline: EditForm | null): boolean {
  if (!baseline) return false;
  return Object.keys(buildEditPatch(form, baseline)).length > 0;
}

function EditField({
  label,
  value,
  onChange,
  disabled,
  maxLength,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  disabled: boolean;
  maxLength: number;
}) {
  return (
    <label className="grid grid-cols-[88px_1fr] items-center gap-2 text-[12.5px]">
      <span className="text-[11px] text-muted-foreground">{label}</span>
      <input
        value={value}
        onChange={(event) => onChange(event.target.value)}
        disabled={disabled}
        maxLength={maxLength}
        className={INPUT_CLASS}
      />
    </label>
  );
}

function LeadDrawer({
  row,
  timeZone,
  timeLocale,
  onClose,
  onPatch,
}: {
  row: LeadRow;
  timeZone: string;
  timeLocale: string;
  onClose: () => void;
  onPatch: (patch: Partial<LeadRow>) => void;
}) {
  const [detail, setDetail] = useState<LeadDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const [moreBusy, setMoreBusy] = useState(false);
  const loadedFor = useRef<string | null>(null);

  // Edit mode: a baseline snapshot captured on entry lets the save diff carry
  // only the changed fields, and Cancel revert to it.
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState<EditForm>(EMPTY_FORM);
  const [baseline, setBaseline] = useState<EditForm | null>(null);
  const [saving, setSaving] = useState(false);
  const [discardArmed, setDiscardArmed] = useState(false);
  const showToast = useToast();
  const dirty = editing && isDirty(form, baseline);

  // Exit animation: a close intent flips `closing`, swapping the drawer-in for
  // drawer-out (and the backdrop to overlay-out), then unmounts via onClose
  // after the slide finishes. A ref guards against a double close.
  const [closing, setClosing] = useState(false);
  const closingRef = useRef(false);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const requestClose = useCallback(() => {
    if (closingRef.current) return;
    closingRef.current = true;
    setClosing(true);
    closeTimer.current = setTimeout(onClose, 150);
  }, [onClose]);
  // Guarded close: dirty edits arm a one-shot discard confirm before closing.
  const attemptClose = useCallback(() => {
    if (dirty && !discardArmed) {
      setDiscardArmed(true);
      return;
    }
    requestClose();
  }, [dirty, discardArmed, requestClose]);
  useEffect(
    () => () => {
      if (closeTimer.current) clearTimeout(closeTimer.current);
    },
    [],
  );

  // All setState happens after the awaited action resolves - nothing runs
  // synchronously inside the effect body below.
  const load = () => {
    startTransition(async () => {
      try {
        const result = await getCrmLeadDetailAction(row.id, 0);
        if (result.ok && result.data) {
          setDetail(result.data as unknown as LeadDetail);
          setError(null);
        } else {
          setError(result.message);
        }
      } catch {
        setError("Could not load lead details. Check your connection and retry.");
      }
    });
  };

  // Ref-guarded single fetch per lead (the drawer is keyed by lead id).
  useEffect(() => {
    if (loadedFor.current === row.id) return;
    loadedFor.current = row.id;
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [row.id]);

  // Body scroll locks while the drawer is open (mount-scoped).
  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, []);

  // Escape closes (guarded through attemptClose so dirty edits confirm first).
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") attemptClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [attemptClose]);

  const loadMore = async () => {
    if (!detail || moreBusy) return;
    setMoreBusy(true);
    try {
      const result = await getCrmLeadDetailAction(row.id, detail.replies.length);
      if (result.ok && result.data) {
        const page = result.data as unknown as LeadDetail;
        setDetail((previous) =>
          previous
            ? { ...previous, replies: [...previous.replies, ...page.replies], repliesTotal: page.repliesTotal }
            : previous,
        );
      } else {
        setError(result.message);
      }
    } catch {
      setError("Could not load more replies. Check your connection and retry.");
    } finally {
      setMoreBusy(false);
    }
  };

  const enterEdit = () => {
    if (!detail) return;
    const base = makeBaseline(detail.lead);
    setBaseline(base);
    setForm(base);
    setDiscardArmed(false);
    setEditing(true);
  };

  const cancelEdit = () => {
    if (baseline) setForm(baseline);
    setEditing(false);
    setDiscardArmed(false);
  };

  const save = async () => {
    if (!detail || !baseline || saving) return;
    const patch = buildEditPatch(form, baseline);
    if (Object.keys(patch).length === 0) {
      setEditing(false);
      setDiscardArmed(false);
      return;
    }
    const updatedAt = typeof detail.lead.updated_at === "string" ? detail.lead.updated_at : "";
    if (!updatedAt) {
      showToast(false, "This lead is missing a version marker. Close and reopen to edit.");
      return;
    }
    setSaving(true);
    try {
      const result = await updateCrmLeadAction(row.id, patch, updatedAt);
      if (result.ok && result.data) {
        const fresh = result.data.lead;
        const nextBaseline = makeBaseline(fresh);
        setDetail((previous) => (previous ? { ...previous, lead: fresh } : previous));
        setBaseline(nextBaseline);
        setForm(nextBaseline);
        setEditing(false);
        setDiscardArmed(false);
        onPatch(rowPatchFromLead(fresh));
        showToast(true, result.message);
      } else {
        // Stale or validation failure: keep the edits in the form to retry.
        showToast(false, result.message);
      }
    } catch {
      showToast(false, "Could not save. Check your connection and retry.");
    } finally {
      setSaving(false);
    }
  };

  const smartleadUrl = buildSmartleadConversationUrl({
    campaignId: row.campaignId,
    smartleadLeadId: detail?.smartleadLeadId ?? row.smartleadLeadId,
  });

  const raw = detail?.lead.raw;
  const rawEntries =
    raw && typeof raw === "object" && !Array.isArray(raw)
      ? Object.entries(raw as Record<string, unknown>)
          .filter((entry): entry is [string, string] => typeof entry[1] === "string" && entry[1].trim() !== "")
          .sort(([a], [b]) => a.localeCompare(b))
      : [];
  const rawNonString = detail ? nonStringRawEntries(detail.lead) : [];

  const name = nameOf(row);
  const website = companyWebsite(row.domain);

  return (
    <div
      className={`fixed inset-0 z-50 flex cursor-pointer justify-end bg-background/70 backdrop-blur-sm ${
        closing ? "anim-overlay-out" : "anim-overlay-in"
      }`}
      onClick={(event) => {
        if (event.target === event.currentTarget) attemptClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`Lead details: ${name}`}
        className={`flex h-full w-[560px] max-w-full cursor-auto flex-col overflow-hidden border-l border-border bg-surface shadow-pop ${
          closing ? "anim-drawer-out" : "anim-drawer-in"
        }`}
      >
        <div className="flex items-center justify-between gap-3 border-b border-border px-5 py-3">
          <div className="min-w-0">
            <h2 className="truncate text-[14px] font-semibold tracking-tight">{name}</h2>
            <p className="truncate text-[11.5px] text-muted-foreground">
              {[row.title, row.company].filter(Boolean).join(" · ") || row.email || ""}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            {detail && !editing ? (
              <button
                type="button"
                onClick={enterEdit}
                data-tip="Edit lead"
                data-tip-down=""
                className={`${BTN_SUBTLE} h-7 px-2 text-[12px]`}
              >
                <Pencil className="size-3.5" />
                Edit
              </button>
            ) : editing ? (
              <button
                type="button"
                onClick={cancelEdit}
                disabled={saving}
                data-tip="Cancel editing"
                data-tip-down=""
                className={`${BTN_SUBTLE} h-7 px-2 text-[12px]`}
              >
                Cancel
              </button>
            ) : null}
            <button
              type="button"
              aria-label="Close"
              autoFocus
              onClick={attemptClose}
              className={`flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors duration-150 hover:bg-muted/70 hover:text-foreground`}
            >
              <X className="size-3.5" />
            </button>
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto">
          {/* View mode: identity renders from the row immediately - no fetch
              needed. Edit mode swaps it for inputs (email stays a locked
              anchor). */}
          {editing ? (
            <section className="border-b border-border px-5 py-4">
              <div className="flex flex-col gap-2">
                {IDENTITY_COLUMNS.map(({ field, label, long }) => (
                  <EditField
                    key={field}
                    label={label}
                    value={form[field]}
                    onChange={(value) => setForm((previous) => ({ ...previous, [field]: value }))}
                    disabled={saving}
                    maxLength={long ? 500 : 200}
                  />
                ))}
                <div
                  className="grid grid-cols-[88px_1fr] items-center gap-2 text-[12.5px]"
                  data-tip="Email is the lead's identity and cannot be edited here."
                >
                  <span className="text-[11px] text-muted-foreground">Email</span>
                  <span className="inline-flex min-w-0 items-center gap-1.5 text-muted-foreground">
                    <Lock className="size-3 shrink-0" />
                    <span className="truncate">{row.email ?? "No email on file"}</span>
                  </span>
                </div>
              </div>
            </section>
          ) : (
            <section className="border-b border-border px-5 py-4">
              <div className="flex flex-col gap-1.5">
                {row.email ? (
                  <IdentityRow label="Email">
                    <a href={`mailto:${row.email}`} className={`text-foreground underline-offset-2 hover:underline`}>
                      {row.email}
                    </a>
                  </IdentityRow>
                ) : null}
                {row.linkedinUrl ? (
                  <IdentityRow label="LinkedIn">
                    <a
                      href={row.linkedinUrl}
                      target="_blank"
                      rel="noreferrer"
                      className={`inline-flex items-center gap-1 text-foreground underline-offset-2 hover:underline`}
                    >
                      <span className="max-w-[320px] truncate">{row.linkedinUrl.replace(/^https?:\/\/(www\.)?/, "")}</span>
                      <ExternalLink className="size-3 shrink-0 text-muted-foreground" />
                    </a>
                  </IdentityRow>
                ) : null}
                {website ? (
                  <IdentityRow label="Website">
                    <a
                      href={website.href}
                      target="_blank"
                      rel="noopener noreferrer"
                      className={`inline-flex items-center gap-1 text-foreground underline-offset-2 hover:underline`}
                    >
                      <span className="max-w-[320px] truncate">{website.domain}</span>
                      <ExternalLink className="size-3 shrink-0 text-muted-foreground" />
                    </a>
                  </IdentityRow>
                ) : null}
                {row.country ? <IdentityRow label="Country">{row.country}</IdentityRow> : null}
                {row.membershipSource === "reply_only" ? (
                  <IdentityRow label="Source">
                    <QuietPill label="Reply only" />
                  </IdentityRow>
                ) : null}
              </div>
              {smartleadUrl ? (
                <a
                  href={smartleadUrl}
                  target="_blank"
                  rel="noreferrer"
                  className={`${BTN_OUTLINE} mt-3 h-8 px-3 text-[12px]`}
                >
                  <ExternalLink className="size-3.5" />
                  Open in Smartlead
                </a>
              ) : null}
            </section>
          )}

          <DrawerSection title="Campaign & export history">
            {row.campaignName ? (
              <div className="flex items-center gap-2 text-[12.5px]">
                <QuietPill label={row.campaignName} />
                {row.exportedAt ? (
                  <span className="text-[11.5px] text-muted-foreground">
                    exported {shortDate(row.exportedAt, timeZone, timeLocale)}
                  </span>
                ) : null}
              </div>
            ) : (
              <p className="text-[12px] text-muted-foreground">Not exported to a campaign.</p>
            )}
            {detail && detail.exports.length > 0 ? (
              <div className="mt-2.5 flex flex-col gap-1.5">
                {detail.exports.map((entry) => (
                  <div key={entry.id} className="flex items-center gap-2 text-[12px]">
                    <span
                      data-tip={entry.status === "failed" ? (entry.error ?? "Export failed") : "Exported"}
                      className={`rounded px-1.5 py-px text-[10px] font-semibold uppercase tracking-wide ${
                        entry.status === "exported"
                          ? "bg-success-soft text-success"
                          : "bg-destructive-soft text-destructive"
                      }`}
                    >
                      {entry.status}
                    </span>
                    <span className="min-w-0 truncate">{entry.campaign_name ?? `Campaign ${entry.campaign_id}`}</span>
                    <span className="ml-auto shrink-0 text-[11px] tabular-nums text-muted-foreground">
                      {shortDate(entry.exported_at, timeZone, timeLocale)}
                    </span>
                  </div>
                ))}
              </div>
            ) : null}
          </DrawerSection>

          {error ? (
            <div className="mx-5 mt-4 flex flex-wrap items-center gap-2 rounded-lg border border-destructive/30 bg-destructive-soft px-3 py-2 text-[12px] text-destructive">
              <AlertTriangle className="size-3.5" />
              <span>{error}</span>
              <button
                type="button"
                onClick={() => {
                  setError(null);
                  load();
                }}
                className={`font-medium underline-offset-2 hover:underline`}
              >
                Retry
              </button>
            </div>
          ) : null}

          {detail === null && !error ? (
            <div className="flex flex-col gap-2.5 px-5 py-5">
              {[0, 1, 2, 3].map((index) => (
                <div key={index} className="flex items-center gap-3">
                  <div className="h-3.5 w-32 animate-pulse rounded bg-muted" />
                  <div className="h-3.5 flex-1 animate-pulse rounded bg-muted/70" />
                </div>
              ))}
            </div>
          ) : null}

          {detail ? (
            <>
              <DrawerSection title={`Replies (${FULL.format(detail.repliesTotal)})`}>
                {detail.replies.length === 0 ? (
                  <p className="text-[12px] text-muted-foreground">No replies captured for this lead.</p>
                ) : (
                  <div className="flex flex-col gap-3">
                    {detail.replies.map((reply) => {
                      const category = reply.latestProposal?.sentiment ?? reply.smartlead_category;
                      const status = reply.latestProposal?.status ?? null;
                      return (
                        <div key={reply.id} className="rounded-lg border border-border/70 px-3 py-2.5">
                          <div className="flex items-center gap-2">
                            <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium">
                              {reply.subject?.trim() || "(no subject)"}
                            </span>
                            <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
                              {fullTime(reply.received_at ?? reply.created_at, timeZone, timeLocale)}
                            </span>
                          </div>
                          {reply.snippet ? (
                            <p className="mt-1 line-clamp-2 text-[12px] leading-relaxed text-muted-foreground">
                              {reply.snippet}
                            </p>
                          ) : null}
                          <div className="mt-1.5 flex items-center gap-2">
                            {category ? (
                              <CategoryPill
                                label={category}
                                sentimentType={reply.latestProposal?.sentiment_type ?? null}
                              />
                            ) : null}
                            {status ? (
                              <span className="text-[11px] capitalize text-muted-foreground">{status}</span>
                            ) : null}
                          </div>
                        </div>
                      );
                    })}
                    {detail.replies.length < detail.repliesTotal ? (
                      <button
                        type="button"
                        onClick={loadMore}
                        disabled={moreBusy}
                        className={`${BTN_OUTLINE} h-7 self-start px-2.5 text-[11.5px]`}
                      >
                        {moreBusy ? <Loader2 className="size-3 animate-spin" /> : null}
                        Load more ({FULL.format(detail.repliesTotal - detail.replies.length)} more)
                      </button>
                    ) : null}
                  </div>
                )}
              </DrawerSection>

              <DrawerSection title="Activity">
                {detail.leadRuns.length === 0 ? (
                  <p className="text-[12px] text-muted-foreground">No recorded runs.</p>
                ) : (
                  <div className="flex flex-col gap-1.5">
                    {detail.leadRuns.map((run) => (
                      <div key={run.id} className="flex items-center gap-2 text-[11.5px] text-muted-foreground">
                        {run.ok ? (
                          <Check className="size-3 shrink-0 text-success" />
                        ) : (
                          <AlertTriangle className="size-3 shrink-0 text-warning" />
                        )}
                        <span className="shrink-0 font-medium text-foreground/80">{run.action}</span>
                        <span title={run.message ?? undefined} className="min-w-0 truncate">
                          {run.message ?? ""}
                        </span>
                        <span className="ml-auto shrink-0 tabular-nums">
                          {shortDate(run.created_at, timeZone, timeLocale)}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </DrawerSection>

              <details className="group px-5 py-4">
                <summary
                  className={`flex cursor-pointer list-none items-center gap-1.5 text-[10.5px] font-semibold uppercase tracking-[0.08em] text-foreground-subtle`}
                >
                  <ChevronRight className="size-3.5 transition-transform group-open:rotate-90" />
                  All stored fields ({rawEntries.length})
                </summary>
                {editing ? (
                  rawEntries.length === 0 && rawNonString.length === 0 ? (
                    <p className="mt-2.5 text-[12px] text-muted-foreground">No stored fields.</p>
                  ) : (
                    <div className="mt-2.5 flex flex-col gap-1.5 text-[12px]">
                      {/* String values edit inline; the key stays fixed. */}
                      {rawEntries.map(([key]) => (
                        <label key={key} className="grid grid-cols-[minmax(120px,38%)_1fr] items-center gap-x-3">
                          <span title={key} className="truncate text-muted-foreground">
                            {key}
                          </span>
                          <input
                            value={form.raw[key] ?? ""}
                            onChange={(event) =>
                              setForm((previous) => ({ ...previous, raw: { ...previous.raw, [key]: event.target.value } }))
                            }
                            disabled={saving}
                            maxLength={1000}
                            className={INPUT_CLASS}
                          />
                        </label>
                      ))}
                      {/* Non-string values stay read-only. */}
                      {rawNonString.map(([key, value]) => (
                        <div key={key} className="grid grid-cols-[minmax(120px,38%)_1fr] items-center gap-x-3">
                          <span title={key} className="truncate text-muted-foreground">
                            {key}
                          </span>
                          <span className="min-w-0 truncate text-muted-foreground/70">
                            {value === null ? "null" : typeof value === "object" ? JSON.stringify(value) : String(value)}
                          </span>
                        </div>
                      ))}
                    </div>
                  )
                ) : rawEntries.length === 0 ? (
                  <p className="mt-2.5 text-[12px] text-muted-foreground">No stored fields.</p>
                ) : (
                  <div className="mt-2.5 grid grid-cols-[minmax(120px,38%)_1fr] gap-x-3 gap-y-1.5 text-[12px]">
                    {rawEntries.map(([key, value]) => (
                      <div key={key} className="contents">
                        <span title={key} className="truncate text-muted-foreground">
                          {key}
                        </span>
                        <span title={value} className="min-w-0 truncate">
                          {value}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </details>
            </>
          ) : null}

          {pending && detail !== null ? (
            <div className="flex items-center gap-1.5 px-5 pb-4 text-[11px] text-muted-foreground">
              <Loader2 className="size-3 animate-spin" />
              Updating
            </div>
          ) : null}
        </div>

        {/* Dirty-diff save bar pins to the drawer bottom. A dirty Escape/backdrop
            close arms the discard confirm shown here first. */}
        {editing && (dirty || discardArmed) ? (
          <div className="shrink-0 border-t border-border bg-surface/95 px-5 py-3 backdrop-blur">
            <div className="anim-savebar-in flex items-center justify-between gap-3">
              {discardArmed ? (
                <>
                  <span className="text-[12px] font-medium text-foreground">Discard unsaved edits?</span>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => setDiscardArmed(false)}
                      className={`${BTN_OUTLINE} h-8 px-3 text-[12px]`}
                    >
                      Keep editing
                    </button>
                    <button
                      type="button"
                      onClick={requestClose}
                      className={`${BTN_SUBTLE} h-8 px-3 text-[12px] text-destructive hover:bg-destructive-soft`}
                    >
                      Discard
                    </button>
                  </div>
                </>
              ) : (
                <>
                  <span className="text-[12px] font-medium text-muted-foreground">Unsaved changes</span>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={cancelEdit}
                      disabled={saving}
                      className={`${BTN_OUTLINE} h-8 px-3 text-[12px]`}
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      onClick={save}
                      disabled={saving}
                      className={`${BTN_PRIMARY} h-8 px-3 text-[12px]`}
                    >
                      {saving ? <Loader2 className="size-3.5 animate-spin" /> : <Check className="size-3.5" />}
                      {saving ? "Saving…" : "Save"}
                    </button>
                  </div>
                </>
              )}
            </div>
            <p className="mt-1.5 text-[11px] text-muted-foreground">
              Edits update this app&apos;s stored lead. Copies already exported to Smartlead campaigns are not changed.
            </p>
          </div>
        ) : null}
      </div>
    </div>
  );
}

/* ── Root ───────────────────────────────────────────────────────────────── */
export function LeadsClient({
  initialView,
  initialPage,
  initialError,
  kindLabel,
  campaigns,
  timeZone,
  timeLocale,
}: {
  initialView: InitialLeadsView;
  initialPage: LeadsPage | null;
  initialError: string | null;
  kindLabel: string | null;
  campaigns: CampaignChoice[];
  timeZone: string;
  timeLocale: string;
}) {
  const router = useRouter();

  const [view, setView] = useState<LeadsView>(() => ({
    ...initialView,
    membership: "all",
    sort: "last_reply_at",
    dir: "desc",
    page: 0,
  }));
  const [searchInput, setSearchInput] = useState(initialView.search);
  const [data, setData] = useState<LeadsPage | null>(initialPage);
  const [error, setError] = useState<string | null>(initialError);
  const [pending, startTransition] = useTransition();
  const [banner, setBanner] = useState(kindLabel !== null);
  const [openLead, setOpenLead] = useState<LeadRow | null>(null);

  // Monotonic ticket so only the newest request writes, plus a signature ref
  // seeded to the server-rendered view so the mount effect is a no-op (the
  // analytics-client idiom).
  const signature = JSON.stringify(view);
  const requestTicket = useRef(0);
  const loadedSignature = useRef(signature);

  const load = () => {
    const ticket = requestTicket.current + 1;
    requestTicket.current = ticket;
    loadedSignature.current = signature;
    const snapshot = view;
    startTransition(async () => {
      try {
        const result = await getCrmLeadsPageAction({
          limit: PAGE_SIZE,
          offset: snapshot.page * PAGE_SIZE,
          search: snapshot.search.trim() ? snapshot.search.trim() : null,
          campaignIds:
            snapshot.campaignMode === "include" && snapshot.campaignIds.length ? snapshot.campaignIds : undefined,
          campaignExcludeIds:
            snapshot.campaignMode === "exclude" && snapshot.campaignIds.length ? snapshot.campaignIds : undefined,
          replied: snapshot.replied ? true : null,
          sentimentTypes: snapshot.positive ? ["positive"] : undefined,
          categories: snapshot.categories.length ? snapshot.categories : undefined,
          referral: snapshot.referral ? true : null,
          dnc: snapshot.dnc ? true : null,
          dncReasons: snapshot.dnc && snapshot.dncReasons.length ? snapshot.dncReasons : undefined,
          dncApprovedOnly: snapshot.dnc && snapshot.dncApprovedOnly ? true : undefined,
          proposalStatuses: snapshot.proposalStatuses.length ? snapshot.proposalStatuses : undefined,
          replyFrom: snapshot.days ? new Date(Date.now() - snapshot.days * 86_400_000).toISOString() : null,
          sort: snapshot.sort,
          sortDir: snapshot.dir,
          membership:
            snapshot.membership === "exported"
              ? ["exported", "legacy"]
              : snapshot.membership === "reply_only"
                ? ["reply_only"]
                : undefined,
        });
        // Only the latest request may write - stale completions are dropped.
        if (requestTicket.current !== ticket) return;
        if (result.ok && result.data) {
          setData(result.data);
          setError(null);
        } else {
          // Keep the stale rows on screen, dimmed, with a Retry line.
          setError(result.message);
        }
      } catch {
        if (requestTicket.current !== ticket) return;
        setError("Could not load leads. Check your connection and retry.");
      }
    });
  };

  useEffect(() => {
    if (loadedSignature.current === signature) return;
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature]);

  // Debounced search (300ms): the timeout callback is the only writer, so the
  // effect body itself never sets state.
  useEffect(() => {
    const handle = setTimeout(() => {
      setView((previous) =>
        previous.search === searchInput ? previous : { ...previous, search: searchInput, page: 0 },
      );
    }, 300);
    return () => clearTimeout(handle);
  }, [searchInput]);

  const patchView = (patch: Partial<LeadsView>) => setView((previous) => ({ ...previous, ...patch, page: 0 }));

  const toggleCampaign = (id: string) =>
    setView((previous) => ({
      ...previous,
      campaignIds: previous.campaignIds.includes(id)
        ? previous.campaignIds.filter((existing) => existing !== id)
        : [...previous.campaignIds, id],
      page: 0,
    }));

  const filtersActive =
    view.search !== "" ||
    view.campaignIds.length > 0 ||
    view.replied ||
    view.positive ||
    view.referral ||
    view.dnc ||
    view.categories.length > 0 ||
    view.proposalStatuses.length > 0 ||
    view.membership !== "all" ||
    view.days !== 0;

  const clearFilters = () => {
    setSearchInput("");
    patchView({
      search: "",
      campaignIds: [],
      campaignMode: "include",
      replied: false,
      positive: false,
      referral: false,
      dnc: false,
      dncReasons: [],
      dncApprovedOnly: false,
      proposalStatuses: [],
      categories: [],
      membership: "all",
      days: 0,
    });
  };

  const dismissBanner = () => {
    setBanner(false);
    // Clears the deep-link params; the applied filters stay until Clear.
    router.replace("/leads", { scroll: false });
  };

  const chips: { key: "replied" | "positive" | "referral" | "dnc"; label: string; active: boolean }[] = [
    { key: "replied", label: "Replied", active: view.replied },
    { key: "positive", label: "Positive", active: view.positive },
    { key: "referral", label: "Referral", active: view.referral },
    { key: "dnc", label: "DNC", active: view.dnc },
  ];

  const toggleChip = (key: "replied" | "positive" | "referral" | "dnc") => {
    if (key === "dnc") {
      // Turning DNC off (or freshly on) also drops any deep-linked narrowing.
      patchView({ dnc: !view.dnc, dncReasons: [], dncApprovedOnly: false });
    } else {
      patchView({ [key]: !view[key] } as Partial<LeadsView>);
    }
  };

  const totalPages = data ? Math.max(1, Math.ceil(data.total / PAGE_SIZE)) : 1;
  const busyClass = pending ? "opacity-60 transition-opacity" : "transition-opacity";

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* Same header bar grammar as every other page (icon + 15px title). */}
      <header className="flex h-14 shrink-0 items-center gap-2 border-b border-border bg-surface px-5">
        <Users className="size-4 text-muted-foreground" strokeWidth={1.75} />
        <h1 className="text-[15px] font-semibold tracking-tight">Leads</h1>
        <p className="hidden min-w-0 truncate text-[12px] text-muted-foreground lg:block">
          Everyone pushed to a Smartlead campaign, plus reply-only contacts captured by the webhook.
        </p>
        {data ? (
          <span className="ml-auto shrink-0 text-[12px] tabular-nums text-muted-foreground">
            {FULL.format(data.total)} {data.total === 1 ? "lead" : "leads"}
          </span>
        ) : null}
      </header>

      {banner && kindLabel ? (
        <div className="flex shrink-0 items-center gap-2 border-b border-border bg-muted/40 px-5 py-1.5 text-[12px] text-muted-foreground">
          <ListFilter className="size-3.5 shrink-0" />
          <span className="min-w-0 truncate">
            Filtered from analytics: <span className="font-medium text-foreground">{kindLabel}</span>
          </span>
          <button
            type="button"
            aria-label="Dismiss"
            onClick={dismissBanner}
            className={`ml-auto flex size-6 shrink-0 items-center justify-center rounded-md transition-colors hover:bg-muted/70 hover:text-foreground`}
          >
            <X className="size-3.5" />
          </button>
        </div>
      ) : null}

      {/* One quiet controls row under the header (reply-inbox toolbar idiom). */}
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border bg-surface px-5 py-2.5">
        <div className="relative w-60">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <input
            value={searchInput}
            onChange={(event) => setSearchInput(event.target.value)}
            placeholder="Search name, email, or company"
            aria-label="Search leads"
            className={`${INPUT_CLASS} pl-8`}
          />
        </div>

        <CampaignFilter
          campaigns={campaigns}
          selectedIds={view.campaignIds}
          mode={view.campaignMode}
          onToggle={toggleCampaign}
          onClear={() => patchView({ campaignIds: [] })}
        />

        <div className="flex items-center gap-1.5">
          {chips.map((chip) => (
            <button
              key={chip.key}
              type="button"
              aria-pressed={chip.active}
              onClick={() => toggleChip(chip.key)}
              className={`rounded-full border px-2 py-0.5 text-[11px] font-medium transition ${
                chip.active
                  ? "border-transparent bg-accent text-accent-foreground"
                  : "border-border bg-surface text-muted-foreground hover:text-foreground"
              }`}
            >
              {chip.label}
            </button>
          ))}
        </div>

        <FilterSelect
          value={view.membership}
          ariaLabel="Filter by membership"
          onChange={(event) => patchView({ membership: event.target.value as Membership })}
        >
          <option value="all">All leads</option>
          <option value="exported">Exported</option>
          <option value="reply_only">Reply only</option>
        </FilterSelect>

        <FilterSelect
          value={String(view.days)}
          ariaLabel="Reply window"
          onChange={(event) => patchView({ days: Number(event.target.value) as LeadsView["days"] })}
        >
          <option value="0">Any time</option>
          <option value="7">Last 7 days</option>
          <option value="30">Last 30 days</option>
          <option value="90">Last 90 days</option>
        </FilterSelect>

        <div className="flex items-center gap-1.5">
          <FilterSelect
            value={view.sort}
            ariaLabel="Sort leads"
            onChange={(event) => patchView({ sort: event.target.value as SortKey })}
          >
            <option value="last_reply_at">Last reply</option>
            <option value="exported_at">Exported</option>
            <option value="name">Name</option>
            <option value="company">Company</option>
          </FilterSelect>
          <button
            type="button"
            data-tip={view.dir === "desc" ? "Descending. Click for ascending." : "Ascending. Click for descending."}
            data-tip-down=""
            aria-label={view.dir === "desc" ? "Sort ascending" : "Sort descending"}
            onClick={() => patchView({ dir: view.dir === "desc" ? "asc" : "desc" })}
            className={`flex size-8 shrink-0 items-center justify-center rounded-md border border-border bg-surface text-muted-foreground shadow-xs transition hover:text-foreground`}
          >
            {view.dir === "desc" ? (
              <ArrowDownWideNarrow className="size-3.5" />
            ) : (
              <ArrowUpNarrowWide className="size-3.5" />
            )}
          </button>
        </div>

        {filtersActive ? (
          <button type="button" onClick={clearFilters} className={`${BTN_SUBTLE} h-8 px-2.5 text-[11.5px]`}>
            <X className="size-3.5" />
            Clear
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
        <div className="px-5 py-4">
          {error && data !== null ? (
            <div className="mb-3 flex flex-wrap items-center gap-2 rounded-lg border border-destructive/30 bg-destructive-soft px-3 py-2 text-[12px] text-destructive">
              <AlertTriangle className="size-3.5" />
              <span>{error}</span>
              <button
                type="button"
                onClick={load}
                className={`font-medium underline-offset-2 hover:underline`}
              >
                Retry
              </button>
            </div>
          ) : null}

          {data === null ? (
            <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed border-border px-4 py-10 text-center">
              <p className="max-w-md text-[12.5px] leading-relaxed text-muted-foreground">
                {error ?? "Could not load leads."}
              </p>
              <button type="button" onClick={load} className={`${BTN_OUTLINE} h-8 px-3 text-[12px]`}>
                Retry
              </button>
            </div>
          ) : data.rows.length === 0 ? (
            <div className="rounded-lg border border-dashed border-border px-3 py-10 text-center text-[12.5px] text-muted-foreground">
              No leads match these filters.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className={`w-full min-w-[860px] border-separate border-spacing-0 ${busyClass}`}>
                <thead>
                  <tr className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                    <th className="rounded-l-md border-b border-border bg-surface-muted py-2 pl-3 pr-3 text-left font-semibold">Lead</th>
                    <th className="border-b border-border bg-surface-muted px-2 py-2 text-left font-semibold">Company</th>
                    <th className="border-b border-border bg-surface-muted px-2 py-2 text-left font-semibold">Campaign</th>
                    <th className="border-b border-border bg-surface-muted px-2 py-2 text-left font-semibold">Membership</th>
                    <th className="border-b border-border bg-surface-muted px-2 py-2 text-left font-semibold">Exported</th>
                    <th className="border-b border-border bg-surface-muted px-2 py-2 text-left font-semibold">Last reply</th>
                    <th className="w-8 rounded-r-md border-b border-border bg-surface-muted py-2 pl-2 pr-3" aria-label="Open" />
                  </tr>
                </thead>
                <tbody className="text-[12.5px] [&>tr>td]:border-b [&>tr>td]:border-border/70 [&>tr:last-child>td]:border-b-0">
                  {data.rows.map((row) => (
                    <tr
                      key={row.id}
                      onClick={() => setOpenLead(row)}
                      className="group cursor-pointer transition-colors odd:bg-transparent even:bg-subtle hover:bg-muted/40"
                    >
                      <td className="max-w-[240px] py-2.5 pr-3">
                        <div className="truncate font-medium">{nameOf(row)}</div>
                        {row.email ? (
                          <div className="truncate text-[11px] text-muted-foreground">{row.email}</div>
                        ) : null}
                      </td>
                      <td className="max-w-[200px] px-2 py-2.5">
                        {row.company ? (
                          companyWebsite(row.domain) ? (
                            <a
                              href={companyWebsite(row.domain)!.href}
                              target="_blank"
                              rel="noopener noreferrer"
                              onClick={(event) => event.stopPropagation()}
                              className={`inline-flex max-w-full items-center gap-1 underline-offset-2 hover:underline`}
                            >
                              <span className="truncate">{row.company}</span>
                              <ExternalLink className="size-3 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
                            </a>
                          ) : (
                            <div className="truncate">{row.company}</div>
                          )
                        ) : <Blank />}
                        {row.domain ? (
                          <div className="truncate text-[11px] text-muted-foreground">{row.domain}</div>
                        ) : null}
                      </td>
                      <td className="max-w-[200px] px-2 py-2.5">
                        {row.campaignName ? <QuietPill label={row.campaignName} /> : null}
                      </td>
                      <td className="px-2 py-2.5">
                        {row.membershipSource === "reply_only" ? <QuietPill label="Reply only" /> : null}
                      </td>
                      <td className="whitespace-nowrap px-2 py-2.5 tabular-nums text-muted-foreground">
                        {shortDate(row.exportedAt, timeZone, timeLocale) ?? <Blank />}
                      </td>
                      <td className="max-w-[240px] px-2 py-2.5">
                        {row.lastReplyAt ? (
                          <div className="flex items-center gap-1.5">
                            {row.positiveAny ? (
                              <span
                                data-tip="Has a positive reply"
                                className="size-1.5 shrink-0 rounded-full bg-success"
                              />
                            ) : null}
                            {row.lastReplyCategory ? (
                              <CategoryPill
                                label={row.lastReplyCategory}
                                sentimentType={row.lastReplySentimentType}
                              />
                            ) : null}
                            <span className="whitespace-nowrap text-[11px] tabular-nums text-muted-foreground">
                              {shortDate(row.lastReplyAt, timeZone, timeLocale)}
                            </span>
                          </div>
                        ) : (
                          <Blank />
                        )}
                      </td>
                      <td className="py-2.5 pl-2">
                        <button
                          type="button"
                          aria-label={`Open ${nameOf(row)}`}
                          onClick={(event) => {
                            event.stopPropagation();
                            setOpenLead(row);
                          }}
                          className={`flex size-6 items-center justify-center rounded-md text-muted-foreground/70 transition hover:bg-muted/70 hover:text-foreground`}
                        >
                          <ChevronRight className="size-3.5" />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      {data !== null && data.rows.length > 0 ? (
        <div className="flex shrink-0 items-center justify-between border-t border-border px-5 py-2">
          <span className="text-[11.5px] tabular-nums text-muted-foreground">
            Page {view.page + 1} of {FULL.format(totalPages)}
          </span>
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              disabled={view.page === 0 || pending}
              onClick={() => setView((previous) => ({ ...previous, page: Math.max(0, previous.page - 1) }))}
              className={`${BTN_OUTLINE} h-7 px-2 text-[11.5px]`}
            >
              <ChevronLeft className="size-3.5" />
              Prev
            </button>
            <button
              type="button"
              disabled={view.page + 1 >= totalPages || pending}
              onClick={() => setView((previous) => ({ ...previous, page: previous.page + 1 }))}
              className={`${BTN_OUTLINE} h-7 px-2 text-[11.5px]`}
            >
              Next
              <ChevronRight className="size-3.5" />
            </button>
          </div>
        </div>
      ) : null}

      {openLead ? (
        <LeadDrawer
          key={openLead.id}
          row={openLead}
          timeZone={timeZone}
          timeLocale={timeLocale}
          onClose={() => setOpenLead(null)}
          onPatch={(patch) => {
            const id = openLead.id;
            // Reflect the edit in the open drawer's row and the table without a
            // refetch (both drop stale completions naturally on the next load).
            setOpenLead((previous) => (previous && previous.id === id ? { ...previous, ...patch } : previous));
            setData((previous) =>
              previous
                ? { ...previous, rows: previous.rows.map((entry) => (entry.id === id ? { ...entry, ...patch } : entry)) }
                : previous,
            );
          }}
        />
      ) : null}
    </div>
  );
}
