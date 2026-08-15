"use client";

/* Drill-down modal for the Analytics KPI tiles, built on the host's modal
   grammar (ModalShell in prospects/enrichment-dialogs: backdrop + centered
   bg-surface card, Escape + backdrop close, body scroll lock, focus moved in
   after paint and restored to the opening tile on close). Data loads on open
   through getAnalyticsDrilldownAction and is cached per kind + filter
   signature for the life of the page. Rows linked to a lead open a compact
   lead-detail side panel beside the modal (getCrmLeadDetailAction, cached per
   leadId for the modal's lifetime). */

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { ArrowUpRight, ChevronRight, ExternalLink, X } from "lucide-react";
import { getAnalyticsDrilldownAction } from "./actions";
import { getCrmLeadDetailAction } from "../leads/actions";

/* ── Contract mirrors (declared locally so this client file never imports a
   server-only module, the same pattern as analytics-client; only the action
   function crosses the boundary). ───────────────────────────────────────── */
export type AnalyticsDrillKind =
  | "replies"
  | "positive"
  | "referrals"
  | "awaiting_review"
  | "ooo"
  | "dnc_asked"
  | "dnc_defunct"
  | "sent_from_inbox";

export type AnalyticsDrillRow = {
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
  /** Messages this lead contributed to this drill kind; >1 for a repeat replier. */
  replyCount: number;
};

export type AnalyticsDrillPayload = {
  /** One entry per LEAD (per message for sent_from_inbox). */
  rows: AnalyticsDrillRow[];
  /** Distinct LEADS matching this kind — the number on the KPI tile. */
  total: number;
  linkedLeadCount: number;
  leadsMappable: boolean;
  /** Distinct leads who replied at all (positive drill only) — the rate denominator. */
  repliesTotal?: number;
};

export type AnalyticsDrillCampaigns = { mode: "include" | "exclude"; ids: string[] } | null;

/* Lead-detail contract mirrors for the side panel (getCrmLeadDetailAction's
   payload, narrowed to the fields the compact card renders; the same
   local-mirror pattern as the drill contract above). */
type LeadDetailProposal = { sentiment: string | null; sentiment_type: string | null; status: string | null };
type LeadDetailReply = {
  id: string;
  subject: string | null;
  snippet: string;
  smartlead_category: string | null;
  received_at: string | null;
  created_at: string;
  latestProposal: LeadDetailProposal | null;
};
type LeadDetailExport = { id: string; campaign_name: string | null; exported_at: string };
type LeadDetailPayload = {
  lead: Record<string, unknown>;
  replies: LeadDetailReply[];
  repliesTotal: number;
  exports: LeadDetailExport[];
};

/* Reads a trimmed string column off the loosely-typed lead record. */
function leadField(lead: Record<string, unknown> | undefined, key: string): string | null {
  const value = lead?.[key];
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
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

/* Country lives in the raw import blob ("Lead Country"), not a column; this
   is the same source the CRM leads RPC computes it from. */
function leadCountry(lead: Record<string, unknown> | undefined): string | null {
  const direct = leadField(lead, "lead_country");
  if (direct) return direct;
  const raw = lead?.raw;
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const value = (raw as Record<string, unknown>)["Lead Country"];
    if (typeof value === "string" && value.trim() !== "") return value.trim();
  }
  return null;
}

/* ── Shared style constants (copied conventions, intentionally not shared) ── */
const BTN_BASE = `inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-md font-medium transition disabled:cursor-not-allowed disabled:opacity-50`;
const BTN_OUTLINE = `${BTN_BASE} border border-border bg-surface text-foreground shadow-xs hover:border-border-strong hover:bg-muted/60`;
const BTN_PRIMARY = `${BTN_BASE} bg-primary text-primary-foreground shadow-xs hover:opacity-90`;

const NUM = new Intl.NumberFormat("en-US");

/* Sentiment token colors for the category pill (settings-client grammar). */
function sentimentPillTone(sentimentType: string | null): string {
  if (sentimentType === "positive") return "bg-success-soft text-success";
  if (sentimentType === "negative") return "bg-destructive-soft text-destructive";
  return "bg-muted text-muted-foreground";
}

const DATE_FMT = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
});
function formatDate(iso: string): string {
  const parsed = new Date(iso);
  return Number.isNaN(parsed.getTime()) ? iso : DATE_FMT.format(parsed);
}

/* ── Per-kind copy ───────────────────────────────────────────────────────── */
const KIND_META: Record<AnalyticsDrillKind, { title: string; description: string }> = {
  replies: { title: "Replies", description: "Replies captured in the selected window." },
  positive: { title: "Positive replies", description: "Replies categorized as positive." },
  referrals: { title: "Referrals captured", description: "Replies that hand off to a colleague." },
  awaiting_review: { title: "Awaiting review", description: "Reply proposals waiting for your approval." },
  ooo: { title: "Out of office", description: "Automated out-of-office responses." },
  dnc_asked: { title: "Blocked · asked", description: "Leads who explicitly asked not to be contacted." },
  dnc_defunct: { title: "Blocked · dead mailbox", description: "Addresses that are no longer in use." },
  sent_from_inbox: { title: "Replies sent from inbox", description: "Messages sent from the reply inbox." },
};

/* ── Row atoms ───────────────────────────────────────────────────────────── */
function Identity({ row }: { row: AnalyticsDrillRow }) {
  const name = row.leadName || row.email || "Unknown";
  return (
    <>
      <span className="min-w-0 truncate text-[12.5px] font-medium">{name}</span>
      {row.company ? (
        <span className="min-w-0 truncate text-[11.5px] text-muted-foreground">{row.company}</span>
      ) : row.email && row.email !== name ? (
        <span className="min-w-0 truncate text-[11.5px] text-muted-foreground">{row.email}</span>
      ) : null}
      {/* The row shows this lead's FIRST message in this bucket; the badge is how
          a repeat replier stays visible after the collapse, and hints that
          opening the lead reveals the rest. */}
      {row.replyCount > 1 ? (
        <span className="shrink-0 whitespace-nowrap rounded-full bg-muted px-1.5 py-px text-[10px] font-medium tabular-nums text-muted-foreground">
          {row.replyCount} replies
        </span>
      ) : null}
    </>
  );
}

function RowDate({ value }: { value: string }) {
  return (
    <span className="ml-auto shrink-0 whitespace-nowrap text-[11px] tabular-nums text-muted-foreground">
      {formatDate(value)}
    </span>
  );
}

/* Shared outer chrome for a drill row. Rows linked to a lead become buttons
   that open the lead-detail side panel (hover tint + chevron affordance on the
   right edge); unlinked rows keep the plain card and say why they are inert. */
function LeadRowShell({
  leadId,
  onSelect,
  children,
}: {
  leadId: string | null;
  onSelect: () => void;
  children: ReactNode;
}) {
  if (leadId === null) {
    return (
      <div title="Not linked to a lead" className="rounded-lg border border-border bg-surface p-3">
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
      className={`group relative cursor-pointer rounded-lg border border-border bg-surface p-3 pr-8 transition-colors hover:bg-muted/40`}
    >
      {children}
      <ChevronRight className="pointer-events-none absolute right-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100" />
    </div>
  );
}

/* Reply card: replies / positive / referrals / ooo / awaiting_review. */
function ReplyRow({ row, onSelect }: { row: AnalyticsDrillRow; onSelect: () => void }) {
  return (
    <LeadRowShell leadId={row.leadId} onSelect={onSelect}>
      <div className="flex items-center gap-2">
        <Identity row={row} />
        {row.campaignName ? (
          <span className="max-w-40 shrink-0 truncate rounded bg-muted px-1.5 py-px text-[10px] font-medium text-muted-foreground">
            {row.campaignName}
          </span>
        ) : null}
        <RowDate value={row.receivedAt} />
      </div>
      {row.category || row.proposalStatus === "pending" ? (
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
          {row.category ? (
            <span className={`rounded px-1.5 py-px text-[10px] font-medium ${sentimentPillTone(row.sentimentType)}`}>
              {row.category}
            </span>
          ) : null}
          {row.proposalStatus === "pending" ? (
            <span className="text-[11px] text-muted-foreground">Pending review</span>
          ) : null}
        </div>
      ) : null}
      {row.snippet ? (
        <p className="mt-1.5 text-[12px] leading-relaxed text-muted-foreground">{row.snippet}</p>
      ) : null}
    </LeadRowShell>
  );
}

/* Blocked rows: identity + reason line + date. */
function DncRow({
  row,
  kind,
  onSelect,
}: {
  row: AnalyticsDrillRow;
  kind: AnalyticsDrillKind;
  onSelect: () => void;
}) {
  const reason =
    row.category ?? (kind === "dnc_defunct" ? "Mailbox no longer in use" : "Asked not to be contacted");
  return (
    <LeadRowShell leadId={row.leadId} onSelect={onSelect}>
      <div className="flex items-center gap-2">
        <Identity row={row} />
        <RowDate value={row.receivedAt} />
      </div>
      <p className="mt-1 text-[11.5px] text-muted-foreground">{reason}</p>
    </LeadRowShell>
  );
}

/* Send metadata rows: sent_from_inbox. */
function SentRow({ row, onSelect }: { row: AnalyticsDrillRow; onSelect: () => void }) {
  return (
    <LeadRowShell leadId={row.leadId} onSelect={onSelect}>
      <div className="flex items-center gap-2">
        <Identity row={row} />
        <span className="shrink-0 rounded bg-muted px-1.5 py-px text-[10px] font-medium text-muted-foreground">
          Sent
        </span>
        <RowDate value={row.receivedAt} />
      </div>
      {row.snippet ? (
        <p className="mt-1.5 text-[12px] leading-relaxed text-muted-foreground">{row.snippet}</p>
      ) : null}
    </LeadRowShell>
  );
}

function DrillRow({
  kind,
  row,
  onSelect,
}: {
  kind: AnalyticsDrillKind;
  row: AnalyticsDrillRow;
  onSelect: () => void;
}) {
  if (kind === "sent_from_inbox") return <SentRow row={row} onSelect={onSelect} />;
  if (kind === "dnc_asked" || kind === "dnc_defunct") return <DncRow row={row} kind={kind} onSelect={onSelect} />;
  return <ReplyRow row={row} onSelect={onSelect} />;
}

/* ── Lead detail side panel ──────────────────────────────────────────────── */
function PanelField({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[72px_1fr] items-baseline gap-2 text-[12px]">
      <span className="text-[11px] text-muted-foreground">{label}</span>
      <span className="min-w-0 truncate">{children}</span>
    </div>
  );
}

/* The compact lead card that mounts beside the drill panel. The outer wrapper
   carries positioning only (fixed + the persistent centering transform, the
   toast wrapper pattern); the enter/exit motion lives on the inner card via
   anim-drawer-in/out. At lg+ it anchors to the right of the shifted drill
   panel; below lg it overlays centered above the drill with a transparent
   click-to-close backdrop so nothing overflows the viewport. */
function LeadDetailPanel({
  fallbackName,
  detail,
  error,
  closing,
  onClose,
  onRetry,
  onOpenLeads,
}: {
  fallbackName: string;
  detail: LeadDetailPayload | null;
  error: string | null;
  closing: boolean;
  onClose: () => void;
  onRetry: () => void;
  onOpenLeads: (searchTerm: string) => void;
}) {
  const lead = detail?.lead;
  const name =
    [leadField(lead, "first_name"), leadField(lead, "last_name")].filter(Boolean).join(" ") || fallbackName;
  const title = leadField(lead, "title");
  const company = leadField(lead, "company");
  const website = companyWebsite(leadField(lead, "domain"));
  const email = leadField(lead, "email");
  const linkedin = leadField(lead, "linkedin_url");
  const country = leadCountry(lead);
  const latestExport = detail?.exports[0] ?? null;
  const campaignName = latestExport?.campaign_name ?? leadField(lead, "smartlead_campaign_name");
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
            {title || company ? (
              <p className="flex min-w-0 items-center gap-1 text-[11px] text-muted-foreground">
                {title ? <span className="truncate">{title}</span> : null}
                {title && company ? <span>·</span> : null}
                {company && website ? (
                  <a
                    href={website.href}
                    target="_blank"
                    rel="noopener noreferrer"
                    className={`inline-flex min-w-0 items-center gap-1 underline-offset-2 hover:underline`}
                  >
                    <span className="truncate">{company}</span>
                    <ExternalLink className="size-3 shrink-0" />
                  </a>
                ) : company ? <span className="truncate">{company}</span> : null}
              </p>
            ) : null}
          </div>
          <button
            type="button"
            aria-label="Close lead details"
            onClick={onClose}
            className={`flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors duration-150 hover:bg-muted/70 hover:text-foreground`}
          >
            <X className="size-3.5" />
          </button>
        </div>

        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-4 py-4">
          {error !== null ? (
            <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed border-border px-4 py-6 text-center">
              <p className="text-[12px] leading-relaxed text-muted-foreground">{error}</p>
              <button type="button" onClick={onRetry} className={`${BTN_OUTLINE} h-8 px-3 text-[12px]`}>
                Retry
              </button>
            </div>
          ) : detail === null ? (
            <div className="flex flex-col gap-2.5">
              {[0, 1, 2, 3].map((index) => (
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
                  <PanelField label="Email">
                    <a
                      href={`mailto:${email}`}
                      className={`text-foreground underline-offset-2 hover:underline`}
                    >
                      {email}
                    </a>
                  </PanelField>
                ) : null}
                {linkedin ? (
                  <PanelField label="LinkedIn">
                    <a
                      href={linkedin}
                      target="_blank"
                      rel="noreferrer"
                      className={`inline-flex max-w-full items-center gap-1 text-foreground underline-offset-2 hover:underline`}
                    >
                      <span className="min-w-0 truncate">{linkedin.replace(/^https?:\/\/(www\.)?/, "")}</span>
                      <ExternalLink className="size-3 shrink-0 text-muted-foreground" />
                    </a>
                  </PanelField>
                ) : null}
                {country ? <PanelField label="Country">{country}</PanelField> : null}
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
                        exported {formatDate(latestExport.exported_at)}
                      </span>
                    ) : null}
                  </p>
                ) : (
                  <p className="text-[12px] text-muted-foreground">Not exported to a campaign.</p>
                )}
              </div>

              <div className="flex flex-col gap-1.5">
                <h4 className="text-[10.5px] font-semibold uppercase tracking-[0.08em] text-foreground-subtle">
                  Replies ({NUM.format(detail.repliesTotal)})
                </h4>
                {recentReplies.length === 0 ? (
                  <p className="text-[12px] text-muted-foreground">No replies captured for this lead.</p>
                ) : (
                  recentReplies.map((reply) => {
                    const category = reply.latestProposal?.sentiment ?? reply.smartlead_category;
                    return (
                      <div key={reply.id} className="rounded-lg border border-border/70 px-3 py-2.5">
                        <div className="flex items-center gap-2">
                          <span className="min-w-0 flex-1 truncate text-[12px] font-medium">
                            {reply.subject?.trim() || "(no subject)"}
                          </span>
                          <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
                            {formatDate(reply.received_at ?? reply.created_at)}
                          </span>
                        </div>
                        {reply.snippet ? (
                          <p className="mt-1 line-clamp-2 text-[11.5px] leading-relaxed text-muted-foreground">
                            {reply.snippet}
                          </p>
                        ) : null}
                        {category ? (
                          <span
                            className={`mt-1.5 inline-block max-w-40 truncate rounded px-1.5 py-px text-[10px] font-medium ${sentimentPillTone(
                              reply.latestProposal?.sentiment_type ?? null,
                            )}`}
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
                    {NUM.format(moreReplies)} more {moreReplies === 1 ? "reply" : "replies"}
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
              className={`${BTN_PRIMARY} h-8 px-3 text-[12px]`}
            >
              Open in Leads
              <ArrowUpRight className="size-3.5" />
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}

/* ── Modal ───────────────────────────────────────────────────────────────── */
export function AnalyticsDrilldownModal({
  kind,
  days,
  campaigns,
  fallbackRepliesTotal,
  cache,
  onClose,
}: {
  kind: AnalyticsDrillKind;
  days: 7 | 30 | 90;
  campaigns: AnalyticsDrillCampaigns;
  /* Denominator for the "positive" header when the payload omits its own. */
  fallbackRepliesTotal: number;
  cache: Map<string, AnalyticsDrillPayload>;
  onClose: () => void;
}) {
  const router = useRouter();
  const panelRef = useRef<HTMLDivElement>(null);

  // Exit animation: a close intent flips `closing`, swapping the in-animations
  // for the out-animations, then unmounts (via the parent's onClose) after the
  // panel-out finishes. A ref guards against a double close re-arming the timer.
  const [closing, setClosing] = useState(false);
  const closingRef = useRef(false);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const requestClose = useCallback(() => {
    if (closingRef.current) return;
    closingRef.current = true;
    setClosing(true);
    closeTimer.current = setTimeout(onClose, 150);
  }, [onClose]);

  /* ── Lead detail side panel state ──────────────────────────────────────
     Selecting a linked row opens the panel; selecting another row swaps its
     content in place (the panel stays mounted, so the drawer never
     re-slides). Payloads are cached per leadId for the modal's lifetime and
     a monotonic ticket guards rapid row-click switching. */
  const [panelLead, setPanelLead] = useState<{ leadId: string; fallbackName: string } | null>(null);
  const [panelClosing, setPanelClosing] = useState(false);
  const panelCloseTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [leadDetail, setLeadDetail] = useState<LeadDetailPayload | null>(null);
  const [leadError, setLeadError] = useState<string | null>(null);
  const detailCache = useRef(new Map<string, LeadDetailPayload>());
  const detailTicket = useRef(0);

  const loadLeadDetail = (leadId: string) => {
    const ticket = detailTicket.current + 1;
    detailTicket.current = ticket;
    const cached = detailCache.current.get(leadId) ?? null;
    setLeadError(null);
    setLeadDetail(cached);
    if (cached) return;
    void (async () => {
      try {
        const result = await getCrmLeadDetailAction(leadId);
        if (detailTicket.current !== ticket) return;
        if (result.ok && result.data) {
          const data = result.data as unknown as LeadDetailPayload;
          detailCache.current.set(leadId, data);
          setLeadDetail(data);
        } else {
          setLeadError(result.message);
        }
      } catch {
        if (detailTicket.current !== ticket) return;
        setLeadError("Could not load lead details. Check your connection and retry.");
      }
    })();
  };

  const openLeadPanel = (row: AnalyticsDrillRow) => {
    if (row.leadId === null) return;
    // Reopening during the 150ms exit cancels it so the panel stays mounted.
    if (panelCloseTimer.current) {
      clearTimeout(panelCloseTimer.current);
      panelCloseTimer.current = null;
    }
    setPanelClosing(false);
    setPanelLead({ leadId: row.leadId, fallbackName: row.leadName || row.email || "Unknown" });
    loadLeadDetail(row.leadId);
  };

  const closeLeadPanel = useCallback(() => {
    if (panelCloseTimer.current) return;
    detailTicket.current += 1; // any in-flight detail fetch discards its result
    setPanelClosing(true);
    panelCloseTimer.current = setTimeout(() => {
      panelCloseTimer.current = null;
      setPanelClosing(false);
      setPanelLead(null);
      setLeadDetail(null);
      setLeadError(null);
    }, 150);
  }, []);

  const panelOpen = panelLead !== null && !panelClosing;

  useEffect(
    () => () => {
      if (closeTimer.current) clearTimeout(closeTimer.current);
      if (panelCloseTimer.current) clearTimeout(panelCloseTimer.current);
    },
    [],
  );

  // kind + filter are frozen for the life of one open: the page snapshots them
  // at click time and the controls sit behind the backdrop, so the signature
  // is computed once per mount.
  const signature = `${kind}|${days}|${
    campaigns ? `${campaigns.mode}:${[...campaigns.ids].sort().join(",")}` : "all"
  }`;
  // Cache hit resolves during render (the Map is read-only here), so a reopen
  // of an already-loaded view never shows a skeleton and never sets state
  // synchronously from an effect.
  const [payload, setPayload] = useState<AnalyticsDrillPayload | null>(() => cache.get(signature) ?? null);
  const [error, setError] = useState<string | null>(null);
  // Monotonic ticket (host idiom): only the newest request may write, even
  // across rapid open / close / reopen of the same view.
  const requestTicket = useRef(0);

  const load = () => {
    const ticket = requestTicket.current + 1;
    requestTicket.current = ticket;
    void (async () => {
      try {
        const result = await getAnalyticsDrilldownAction(kind, { days, campaigns });
        if (requestTicket.current !== ticket) return;
        if (result.ok && result.data) {
          cache.set(signature, result.data);
          setPayload(result.data);
        } else {
          setError(result.message);
        }
      } catch {
        if (requestTicket.current !== ticket) return;
        setError("Could not load the drill-down. Check your connection and retry.");
      }
    })();
  };

  // Fetch on open (this component only mounts while the modal is open). A
  // cache hit already populated state in the initializer, so this is a no-op
  // then, and it never sets state synchronously.
  useEffect(() => {
    if (cache.get(signature)) return;
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Remember the opening tile before focus moves into the dialog; restore on
  // close. Declared before the focus-panel effect so it captures first.
  useEffect(() => {
    const opener = document.activeElement;
    return () => {
      if (opener instanceof HTMLElement) opener.focus();
    };
  }, []);

  // Lock the page behind the modal (host ModalShell idiom).
  useEffect(() => {
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
    };
  }, []);

  // Escape closes the lead side panel first when open (the drill shift
  // animates back), then a second Escape closes the modal.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (panelOpen) closeLeadPanel();
      else requestClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [panelOpen, closeLeadPanel, requestClose]);

  // Move focus into the dialog after it paints.
  useEffect(() => {
    const raf = requestAnimationFrame(() => panelRef.current?.focus());
    return () => cancelAnimationFrame(raf);
  }, []);

  const meta = KIND_META[kind];
  // Both numbers are distinct-lead counts (they back the KPI tiles), so the copy
  // says "leads" — the rows below are the individual messages behind them.
  const description =
    kind === "positive" && payload
      ? `${NUM.format(payload.total)} positive of ${NUM.format(
          payload.repliesTotal ?? fallbackRepliesTotal,
        )} leads · Last ${days} days`
      : `${meta.description} Last ${days} days.`;

  const leadsUrl = (search?: string) => {
    const query = new URLSearchParams({ kind, days: String(days) });
    if (campaigns) {
      query.set("campaigns", campaigns.ids.join(","));
      query.set("mode", campaigns.mode);
    }
    if (search?.trim()) query.set("search", search.trim().slice(0, 200));
    return `/leads?${query.toString()}`;
  };
  const openInLeads = () => router.push(leadsUrl());

  const showLeads = payload !== null && payload.leadsMappable;
  const showInbox =
    kind === "awaiting_review" || (kind === "sent_from_inbox" && payload !== null && !payload.leadsMappable);

  // Rows are one per lead (per message only for sent_from_inbox), so `total`
  // and the row count share a grain and the noun follows the kind.
  const rowNoun = kind === "sent_from_inbox" ? "message records" : "leads";
  const footerNotes: string[] = [];
  if (payload && payload.total > payload.rows.length) {
    footerNotes.push(`Showing first ${payload.rows.length} of ${NUM.format(payload.total)} ${rowNoun}`);
  }
  if (payload && payload.linkedLeadCount < payload.rows.length) {
    footerNotes.push(`${payload.linkedLeadCount} linked to leads`);
  }

  return (
    <div
      className={`fixed inset-0 z-50 flex cursor-pointer items-center justify-center bg-background/70 p-4 backdrop-blur-sm ${
        closing ? "anim-overlay-out" : "anim-overlay-in"
      }`}
      onClick={(event) => {
        if (event.target === event.currentTarget) requestClose();
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
          tabIndex={-1}
          role="dialog"
          aria-modal="true"
          aria-label={meta.title}
          className={`flex max-h-[85vh] w-full flex-col overflow-hidden rounded-xl border border-border bg-surface shadow-pop outline-none ${
            closing ? "anim-panel-out" : "anim-panel-in"
          }`}
        >
          <div className="flex items-start justify-between gap-3 border-b border-border px-4 py-3">
            <div className="flex min-w-0 flex-col gap-0.5">
              <h2 className="truncate text-[13.5px] font-semibold tracking-tight">{meta.title}</h2>
              <p className="text-[11px] text-muted-foreground">{description}</p>
            </div>
            <button
              type="button"
              aria-label="Close"
              onClick={requestClose}
              className={`flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors duration-150 hover:bg-muted/70 hover:text-foreground`}
            >
              <X className="size-3.5" />
            </button>
          </div>

          <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-4 py-4">
            {payload === null && error !== null ? (
              <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed border-border px-4 py-8 text-center">
                <p className="max-w-md text-[12.5px] leading-relaxed text-muted-foreground">{error}</p>
                <button
                  type="button"
                  onClick={() => {
                    setError(null);
                    load();
                  }}
                  className={`${BTN_OUTLINE} h-8 px-3 text-[12px]`}
                >
                  Retry
                </button>
              </div>
            ) : payload === null ? (
              [0, 1, 2, 3, 4].map((index) => (
                <div key={index} className="rounded-lg border border-border p-3">
                  <div className="flex items-center justify-between">
                    <div className="h-3.5 w-40 animate-pulse rounded bg-muted" />
                    <div className="h-3 w-20 animate-pulse rounded bg-muted/70" />
                  </div>
                  <div className="mt-2 h-3 w-full animate-pulse rounded bg-muted/60" />
                  <div className="mt-1.5 h-3 w-2/3 animate-pulse rounded bg-muted/60" />
                </div>
              ))
            ) : payload.rows.length === 0 ? (
              <p className="px-1 py-6 text-center text-[12.5px] text-muted-foreground">
                Nothing to show for this selection.
              </p>
            ) : (
              // Rows carry no stable id; the list is replaced wholesale per
              // payload, so an index key is safe here.
              payload.rows.map((row, index) => (
                <DrillRow key={index} kind={kind} row={row} onSelect={() => openLeadPanel(row)} />
              ))
            )}
          </div>

          {payload !== null ? (
            <div className="flex items-center justify-between gap-3 border-t border-border px-4 py-3">
              <p className="min-w-0 truncate text-[11px] text-muted-foreground">{footerNotes.join(" · ")}</p>
              <div className="flex shrink-0 items-center gap-2">
                {showInbox ? (
                  <button
                    type="button"
                    onClick={() => router.push("/inbox")}
                    className={`${BTN_OUTLINE} h-8 px-3 text-[12px]`}
                  >
                    Open Inbox
                  </button>
                ) : null}
                {showLeads ? (
                  <button type="button" onClick={openInLeads} className={`${BTN_PRIMARY} h-8 px-3 text-[12px]`}>
                    Open in Leads
                    <ArrowUpRight className="size-3.5" />
                  </button>
                ) : null}
              </div>
            </div>
          ) : null}
        </div>
      </div>

      {panelLead !== null ? (
        <LeadDetailPanel
          fallbackName={panelLead.fallbackName}
          detail={leadDetail}
          error={leadError}
          closing={panelClosing || closing}
          onClose={closeLeadPanel}
          onRetry={() => loadLeadDetail(panelLead.leadId)}
          onOpenLeads={(searchTerm) => router.push(leadsUrl(searchTerm))}
        />
      ) : null}
    </div>
  );
}
