"use client";

/* Dialogs for the Enrichment worktable, built on the host's modal grammar
   (AddLeadsModal / LeadEditorModal in campaigns-client): backdrop + centered
   bg-surface card, Escape + backdrop close, body scroll lock, focus handling. */

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ChangeEvent as ReactChangeEvent,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { AlertTriangle, Ban, Check, CheckCircle2, ChevronDown, Loader2, Plus, X } from "lucide-react";
import {
  addSuppressionAction,
  getEnrichmentSettingsAction,
  getExportMappingViewAction,
  getWorkspaceTreeAction,
  listSuppressionsAction,
  removeSuppressionAction,
  saveEnrichmentSettingsAction,
  saveExportMappingsAction,
} from "./actions";
import {
  ACTION_LABELS,
  BTN_OUTLINE,
  BTN_PRIMARY,
  DEFAULT_PROMPTS,
  INPUT_CLASS,
  PILL_TONE_CLASS,
  RUN_MODE_LABELS,
  isAiPromptColumn,
  leadName,
  linkedinStatusPill,
  type AiPromptColumn,
  type CampaignTag,
  type CellResult,
  type EnrichmentLead,
  type LeadRunEntry,
  type EmailQaDetails,
  type NormalizationExample,
  type PillTone,
  type PromptVariable,
  type ProviderClass,
  type RunMode,
  type RunnableAction,
  type SmartleadCampaignOption,
  type Suppression,
  type SuppressionKind,
  type WorkbookOption,
} from "./enrichment-model";

/* ── Shared atoms ─────────────────────────────────────────────────────── */

export function Pill({ tone, label, title }: { tone: PillTone; label: string; title?: string }) {
  return (
    <span
      title={title}
      className={`inline-flex max-w-full shrink-0 items-center rounded px-1.5 py-px text-[10px] font-medium ${PILL_TONE_CLASS[tone]}`}
    >
      <span className="truncate">{label}</span>
    </span>
  );
}

export function ModalShell({
  title,
  description,
  onClose,
  closeDisabled = false,
  widthClass = "max-w-lg",
  children,
  footer,
}: {
  title: string;
  description?: string;
  onClose: () => void;
  closeDisabled?: boolean;
  widthClass?: string;
  children: ReactNode;
  footer?: ReactNode;
}) {
  const panelRef = useRef<HTMLDivElement>(null);

  // Exit animation: a close intent flips `closing`, swapping the in-animations
  // for the out-animations, then unmounts (via the parent's onClose) after the
  // panel-out finishes. A ref guards against a double close re-arming the timer.
  const [closing, setClosing] = useState(false);
  const closingRef = useRef(false);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const requestClose = useCallback(() => {
    if (closeDisabled || closingRef.current) return;
    closingRef.current = true;
    setClosing(true);
    closeTimer.current = setTimeout(onClose, 150);
  }, [closeDisabled, onClose]);
  useEffect(
    () => () => {
      if (closeTimer.current) clearTimeout(closeTimer.current);
    },
    [],
  );

  // Lock the page behind the modal (LeadEditorModal idiom).
  useEffect(() => {
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
    };
  }, []);

  // Escape closes when idle. A child that handles Escape itself (e.g. the prompt
  // editor's variable dropdown) calls preventDefault, so honor defaultPrevented
  // and don't close the modal out from under it.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.defaultPrevented) requestClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [requestClose]);

  // Move focus into the dialog after it paints.
  useEffect(() => {
    const raf = requestAnimationFrame(() => panelRef.current?.focus());
    return () => cancelAnimationFrame(raf);
  }, []);

  return (
    <div
      className={`fixed inset-0 z-50 flex cursor-pointer items-center justify-center bg-background/70 p-4 backdrop-blur-sm ${
        closing ? "anim-overlay-out" : "anim-overlay-in"
      }`}
      onClick={(event) => {
        if (event.target === event.currentTarget) requestClose();
      }}
    >
      <div
        ref={panelRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={`flex max-h-[85vh] w-full ${widthClass} cursor-auto flex-col overflow-hidden rounded-xl border border-border bg-surface shadow-pop outline-none ${
          closing ? "anim-panel-out" : "anim-panel-in"
        }`}
      >
        <div className="flex items-start justify-between gap-3 border-b border-border px-4 py-3">
          <div className="flex min-w-0 flex-col gap-0.5">
            <h2 className="truncate text-[13.5px] font-semibold tracking-tight">{title}</h2>
            {description ? <p className="text-[11px] text-muted-foreground">{description}</p> : null}
          </div>
          <button
            type="button"
            aria-label="Close"
            disabled={closeDisabled}
            onClick={requestClose}
            className={`flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors duration-150 hover:bg-muted/70 hover:text-foreground disabled:opacity-50`}
          >
            <X className="size-3.5" />
          </button>
        </div>
        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-4 py-4">{children}</div>
        {footer ? (
          <div className="flex items-center justify-end gap-2 border-t border-border px-4 py-3">{footer}</div>
        ) : null}
      </div>
    </div>
  );
}

function ResultCard({ result }: { result: CellResult }) {
  return (
    <div className="flex items-start gap-2 rounded-md border border-border bg-muted/30 p-3">
      {result.ok ? (
        <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-success" />
      ) : (
        <AlertTriangle className="mt-0.5 size-4 shrink-0 text-destructive" />
      )}
      <div className="min-w-0">
        <div className="flex items-center gap-2 text-[13px] font-medium">
          {result.ok ? "Succeeded" : "Failed"}
          {result.outcome ? <Pill tone={result.ok ? "success" : "warning"} label={result.outcome} /> : null}
          {result.fallback ? (
            <Pill
              tone="warning"
              label="fallback"
              title="Deterministic fallback: the model output was unavailable or unusable, so the rule-based normalizer supplied this value."
            />
          ) : null}
        </div>
        <p className="mt-1 break-words text-[12.5px] leading-5 text-muted-foreground">{result.message}</p>
      </div>
    </div>
  );
}

/* ── Run output (single cell) ─────────────────────────────────────────── */

export type RunDetails = { title: string; result: CellResult };

export function RunDetailsDialog({ details, onClose }: { details: RunDetails; onClose: () => void }) {
  return (
    <ModalShell
      title={details.title}
      description="Cell automation output from the latest run in this session."
      onClose={onClose}
      footer={
        <button type="button" onClick={onClose} className={`${BTN_OUTLINE} h-8 px-3 text-[12px]`}>
          Close
        </button>
      }
    >
      <ResultCard result={details.result} />
    </ModalShell>
  );
}

/* ── Run history (per lead, from lead_runs) ───────────────────────────── */

export type RunHistoryState = { leadName: string; entries: LeadRunEntry[]; loading: boolean };

function formatRunTimestamp(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

/* Token + time for one run, from the run's stored details (AI columns + title
   check record these). Null when the run has no recorded spend (e.g. an API-free
   built-in, or a legacy row from before accounting was added). */
function runSpendLine(details: unknown): string | null {
  if (!details || typeof details !== "object") return null;
  const d = details as Record<string, unknown>;
  const input = typeof d.input_tokens === "number" ? d.input_tokens : 0;
  const output = typeof d.output_tokens === "number" ? d.output_tokens : 0;
  const ms = typeof d.duration_ms === "number" ? d.duration_ms : null;
  const tokens = input + output;
  if (tokens === 0 && ms == null) return null;
  const parts: string[] = [];
  if (tokens > 0) parts.push(`${tokens.toLocaleString("en-US")} tokens`);
  if (ms != null) parts.push(ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`);
  return parts.join(" · ");
}

export function RunHistoryDialog({ history, onClose }: { history: RunHistoryState; onClose: () => void }) {
  return (
    <ModalShell
      title={`${history.leadName} · Run history`}
      description="Every logged run for this lead."
      widthClass="max-w-xl"
      onClose={onClose}
    >
      <div className="overflow-hidden rounded-lg border border-border">
        {history.loading ? (
          <div className="flex items-center gap-2 p-4 text-[12.5px] text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
            Loading history...
          </div>
        ) : history.entries.length === 0 ? (
          <div className="p-4 text-[12.5px] text-muted-foreground">
            No logged runs yet. Runs are recorded from the moment run logging was enabled.
          </div>
        ) : (
          <div className="divide-y divide-border">
            {history.entries.map((entry) => {
              const spendLine = runSpendLine(entry.details);
              return (
              <div key={entry.id} className="flex items-start gap-2 p-2.5 text-[12px]">
                {entry.ok ? (
                  <CheckCircle2 className="mt-0.5 size-3.5 shrink-0 text-success" />
                ) : (
                  <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-destructive" />
                )}
                <div className="min-w-0 flex-1 space-y-0.5">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="font-medium">{entry.action}</span>
                    {entry.provider ? <Pill tone="muted" label={entry.provider} /> : null}
                    <span className="ml-auto whitespace-nowrap text-[11px] text-muted-foreground">
                      {formatRunTimestamp(entry.createdAt)}
                    </span>
                  </div>
                  {entry.message ? (
                    <p className="break-words leading-4 text-muted-foreground">{entry.message}</p>
                  ) : null}
                  {spendLine ? (
                    <p className="tabular-nums text-[11px] text-muted-foreground">{spendLine}</p>
                  ) : null}
                </div>
              </div>
              );
            })}
          </div>
        )}
      </div>
    </ModalShell>
  );
}

/* ── Lead detail (contact + ops-candidate context) ────────────────────── */

export type LeadDetailState = { leadId: string; leadName: string; lead: EnrichmentLead | null; loading: boolean };

function DetailRow({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="grid grid-cols-[130px_1fr] gap-2 text-[12px]">
      <div className="text-muted-foreground">{label}</div>
      <div className={`min-w-0 truncate ${mono ? "font-mono text-[11.5px]" : ""}`} title={value}>
        {value}
      </div>
    </div>
  );
}

/* Defensively read the jsonb payload the Apify LinkedIn check stored on the
   lead (shape from src/lib/enrichment/apify.ts). Returns null when there is
   nothing worth showing. */
function readLinkedinProfile(value: unknown): { headline: string; positions: { title: string; company: string; current: boolean; caption: string }[] } | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  const positions = Array.isArray(v.positions)
    ? v.positions.map((p) => {
        const o = (p && typeof p === "object" ? p : {}) as Record<string, unknown>;
        return {
          title: typeof o.title === "string" ? o.title : "",
          company: typeof o.company === "string" ? o.company : "",
          current: o.current === true,
          caption: typeof o.caption === "string" ? o.caption : "",
        };
      })
    : [];
  const headline = typeof v.headline === "string" ? v.headline : "";
  if (!headline && positions.length === 0) return null;
  return { headline, positions };
}

export function LeadDetailDialog({
  detail,
  onClose,
  onSuppress,
  suppressPending,
}: {
  detail: LeadDetailState;
  onClose: () => void;
  onSuppress: (kind: SuppressionKind) => void;
  suppressPending: boolean;
}) {
  const lead = detail.lead;
  return (
    <ModalShell
      title={detail.leadName}
      description="Lead details, campaign variables, and the selected ops candidate."
      widthClass="max-w-xl"
      onClose={onClose}
      footer={
        <>
          {lead && !lead.suppressionReason ? (
            <>
              {lead.email ? (
                <button
                  type="button"
                  disabled={suppressPending}
                  onClick={() => onSuppress("email")}
                  data-tip="Suppress this email locally and on the Smartlead global block list."
                  className={`${BTN_OUTLINE} h-8 px-3 text-[12px]`}
                >
                  <Ban className="size-3.5" />
                  Suppress email
                </button>
              ) : null}
              {lead.domain ? (
                <button
                  type="button"
                  disabled={suppressPending}
                  onClick={() => onSuppress("domain")}
                  data-tip="Suppress the whole domain locally and on the Smartlead global block list."
                  className={`${BTN_OUTLINE} h-8 px-3 text-[12px]`}
                >
                  <Ban className="size-3.5" />
                  Suppress domain
                </button>
              ) : null}
            </>
          ) : null}
          <button type="button" onClick={onClose} className={`${BTN_PRIMARY} h-8 px-3 text-[12px]`}>
            Close
          </button>
        </>
      }
    >
      {detail.loading ? (
        <div className="flex items-center gap-2 rounded-md border border-border bg-muted/30 p-3 text-[12.5px] text-muted-foreground">
          <Loader2 className="size-4 animate-spin" />
          Loading lead details...
        </div>
      ) : !lead ? (
        <div className="rounded-md border border-destructive/30 bg-destructive-soft p-3 text-[12.5px] text-destructive">
          Could not load this lead.
        </div>
      ) : (
        <>
          {lead.suppressionReason ? (
            <div className="rounded-md border border-destructive/30 bg-destructive-soft p-3 text-[12.5px] text-destructive">
              Suppressed: {lead.suppressionReason}
            </div>
          ) : null}
          <section className="space-y-2">
            <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Contact</div>
            <div className="space-y-2 rounded-md border border-border bg-muted/20 p-3">
              <DetailRow label="Name" value={leadName(lead)} />
              <DetailRow label="Title" value={lead.title ?? "No title"} />
              <DetailRow label="Company" value={lead.company ?? "No company"} />
              <DetailRow label="Domain" value={lead.domain ?? "No domain"} mono />
              <DetailRow label="Email" value={lead.email ?? "No email"} mono />
              <DetailRow label="Email status" value={lead.emailStatus ?? "not run"} />
              <DetailRow label="Role" value={lead.roleLevel ?? "unknown"} />
              <DetailRow label="Wave" value={lead.sendWave != null ? `Wave ${lead.sendWave}` : "No wave"} />
              <DetailRow
                label="Location"
                value={[lead.leadCity, lead.leadState, lead.leadCountry].filter(Boolean).join(", ") || "Unknown"}
              />
              {lead.linkedinUrl ? (
                <a
                  href={lead.linkedinUrl}
                  target="_blank"
                  rel="noreferrer"
                  className={`inline-flex text-[12px] font-medium underline-offset-2 hover:underline`}
                >
                  LinkedIn profile
                </a>
              ) : null}
            </div>
          </section>
          <section className="space-y-2">
            <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
              LinkedIn employment
            </div>
            <div className="space-y-2 rounded-md border border-border bg-muted/20 p-3">
              <div className="flex items-center justify-between gap-2">
                <span className="text-[12px] text-muted-foreground">Still at the company?</span>
                <Pill {...linkedinStatusPill(lead.linkedinEmploymentStatus)} />
              </div>
              <DetailRow label="Company on file" value={lead.company ?? "No company"} />
              <DetailRow label="Currently at" value={lead.linkedinCurrentCompany ?? "Unknown"} />
              {lead.linkedinCheckedAt ? <DetailRow label="Checked" value={formatRunTimestamp(lead.linkedinCheckedAt)} /> : null}
              {(() => {
                const profile = readLinkedinProfile(lead.linkedinProfile);
                if (!profile) {
                  return (
                    <p className="pt-1 text-[11px] leading-4 text-muted-foreground">
                      Run the LinkedIn check to pull their current employment straight from the profile.
                    </p>
                  );
                }
                return (
                  <>
                    {profile.headline ? <DetailRow label="Headline" value={profile.headline} /> : null}
                    {profile.positions.length ? (
                      <div className="space-y-1 pt-1">
                        <div className="text-[11px] font-medium text-muted-foreground">Experience</div>
                        <ul className="space-y-1">
                          {profile.positions.map((position, index) => (
                            <li key={index} className="flex items-baseline justify-between gap-2 text-[11.5px]">
                              <span className="min-w-0 truncate">
                                {[position.title, position.company].filter(Boolean).join(" @ ") || "Role"}
                              </span>
                              <span className={`shrink-0 text-[10.5px] ${position.current ? "font-medium text-success" : "text-muted-foreground"}`}>
                                {position.current ? "present" : position.caption || "past"}
                              </span>
                            </li>
                          ))}
                        </ul>
                      </div>
                    ) : null}
                  </>
                );
              })()}
            </div>
          </section>
          <section className="space-y-2">
            <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
              Campaign variables
            </div>
            <div className="space-y-2 rounded-md border border-border bg-muted/20 p-3">
              <DetailRow label="final_first_name" value={lead.finalFirstName ?? "empty"} />
              <DetailRow label="final_title" value={lead.finalTitle ?? "empty"} />
              <DetailRow label="final_company_name" value={lead.finalCompanyName ?? "empty"} />
              <DetailRow label="operations_task" value={lead.operationsTask ?? "empty"} />
              <DetailRow label="ops_candidate" value={lead.opsCandidate ?? "empty"} />
              <p className="pt-1 text-[11px] leading-4 text-muted-foreground">
                The ops candidate is a same-company coworker chosen at run time. The selection context is recorded in
                the run history for this lead.
              </p>
            </div>
          </section>
          <section className="space-y-2">
            <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Last export</div>
            <div className="space-y-2 rounded-md border border-border bg-muted/20 p-3">
              <DetailRow label="Status" value={lead.smartleadExportStatus ?? "not exported"} />
              <DetailRow label="Campaign" value={lead.smartleadCampaignName ?? lead.smartleadCampaignId ?? "None"} />
              {lead.smartleadExportedAt ? (
                <DetailRow label="Exported" value={formatRunTimestamp(lead.smartleadExportedAt)} />
              ) : null}
              {lead.smartleadExportError ? <DetailRow label="Last error" value={lead.smartleadExportError} /> : null}
              <p className="pt-1 text-[11px] leading-4 text-muted-foreground">
                The most recent Smartlead export for this lead across every list. Each list tracks its own export state
                in the grid.
              </p>
            </div>
          </section>
        </>
      )}
    </ModalShell>
  );
}

/* ── Suppressions manager ─────────────────────────────────────────────── */

export function SuppressionsDialog({
  onClose,
  showToast,
  onChanged,
}: {
  onClose: () => void;
  showToast: (ok: boolean, text: string) => void;
  onChanged: () => void;
}) {
  const [items, setItems] = useState<Suppression[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [kind, setKind] = useState<SuppressionKind>("email");
  const [value, setValue] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const result = await listSuppressionsAction();
      if (cancelled) return;
      const suppressions = result.ok ? result.suppressions : undefined;
      if (suppressions) setItems(suppressions);
      else {
        setItems([]);
        setLoadError(result.message);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const add = async () => {
    const cleanValue = value.trim().toLowerCase();
    if (!cleanValue || busy) return;
    setBusy("add");
    try {
      const result = await addSuppressionAction({ kind, value: cleanValue, reason: reason.trim() || null });
      showToast(result.ok, result.message);
      const suppressions = result.ok ? result.suppressions : undefined;
      if (suppressions) {
        setItems(suppressions);
        setValue("");
        setReason("");
        onChanged();
      }
    } finally {
      setBusy(null);
    }
  };

  const remove = async (item: Suppression) => {
    if (busy) return;
    setBusy(item.id);
    try {
      const result = await removeSuppressionAction(item.kind, item.value);
      showToast(result.ok, result.message);
      const suppressions = result.ok ? result.suppressions : undefined;
      if (suppressions) {
        setItems(suppressions);
        onChanged();
      }
    } finally {
      setBusy(null);
    }
  };

  return (
    <ModalShell
      title="Suppressions"
      description="Suppressed emails and domains are blocked from Smartlead export. Removal here is local only."
      widthClass="max-w-xl"
      onClose={onClose}
      closeDisabled={busy !== null}
    >
      <div className="flex flex-wrap items-end gap-2">
        <div className="relative">
          <select
            value={kind}
            onChange={(event) => setKind(event.target.value === "domain" ? "domain" : "email")}
            aria-label="Suppression kind"
            className="h-8 appearance-none rounded-md border border-border bg-surface pl-2 pr-6 text-[12px] font-medium text-foreground shadow-xs outline-none transition focus:border-ring"
          >
            <option value="email">Email</option>
            <option value="domain">Domain</option>
          </select>
          <ChevronDown className="pointer-events-none absolute right-1.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
        </div>
        <input
          value={value}
          onChange={(event) => setValue(event.target.value)}
          placeholder={kind === "email" ? "jane@acme.com" : "acme.com"}
          aria-label="Suppression value"
          className={`${INPUT_CLASS} w-52 flex-1`}
          onKeyDown={(event) => {
            if (event.key === "Enter") void add();
          }}
        />
        <input
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          placeholder="Reason (optional)"
          aria-label="Suppression reason"
          className={`${INPUT_CLASS} w-44 flex-1`}
          onKeyDown={(event) => {
            if (event.key === "Enter") void add();
          }}
        />
        <button
          type="button"
          disabled={!value.trim() || busy !== null}
          onClick={() => void add()}
          className={`${BTN_PRIMARY} h-8 px-3 text-[12px]`}
        >
          {busy === "add" ? <Loader2 className="size-3.5 animate-spin" /> : <Plus className="size-3.5" />}
          Add
        </button>
      </div>

      <div className="overflow-hidden rounded-lg border border-border">
        {items === null ? (
          <div className="flex items-center gap-2 p-4 text-[12.5px] text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
            Loading suppressions...
          </div>
        ) : items.length === 0 ? (
          <div className="p-4 text-[12.5px] text-muted-foreground">{loadError ?? "No suppressions yet."}</div>
        ) : (
          <div className="divide-y divide-border">
            {items.map((item) => (
              <div key={item.id} className="flex items-center gap-2 px-3 py-2 text-[12px]">
                <Pill tone="muted" label={item.kind} />
                <span className="min-w-0 flex-1 truncate font-mono text-[11.5px]" title={item.value}>
                  {item.value}
                </span>
                {item.reason ? (
                  <span className="min-w-0 max-w-48 truncate text-muted-foreground" title={item.reason}>
                    {item.reason}
                  </span>
                ) : null}
                <button
                  type="button"
                  aria-label={`Remove suppression ${item.value}`}
                  disabled={busy !== null}
                  onClick={() => void remove(item)}
                  className={`flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted/70 hover:text-destructive disabled:opacity-50`}
                >
                  {busy === item.id ? <Loader2 className="size-3 animate-spin" /> : <X className="size-3" />}
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </ModalShell>
  );
}

/* ── Prospect settings (runner, model, bulk concurrency) ──────────────── */

export type RunnerProvider = "anthropic-api" | "openai-api" | "gateway" | "cli-claude" | "cli-codex";

type LaneKey = "llm" | "smartlead" | "leadmagic" | "zerobounce";

export type ProspectRunnerConfig = {
  provider: RunnerProvider;
  concurrency: Record<LaneKey, number>;
};

type ModelCatalogEntry = { provider: string; id: string; label: string };
type ApiKeyStatus = { anthropic: boolean; openai: boolean; gateway: boolean };

const RUNNER_PROVIDER_OPTIONS: { value: RunnerProvider; label: string }[] = [
  { value: "anthropic-api", label: "Anthropic API" },
  { value: "openai-api", label: "OpenAI API" },
  { value: "gateway", label: "AI Gateway (all vendors)" },
  { value: "cli-claude", label: "Claude CLI (this machine)" },
  { value: "cli-codex", label: "Codex CLI (this machine)" },
];

/* The four bulk-run lanes, in display order. Labels are operator-facing; keys
   map to the runner config's concurrency object. */
const CONCURRENCY_LANES: { key: LaneKey; label: string }[] = [
  { key: "llm", label: "AI" },
  { key: "leadmagic", label: "LeadMagic" },
  { key: "zerobounce", label: "ZeroBounce" },
  { key: "smartlead", label: "Smartlead" },
];

const RUNNER_CAPTION =
  "CLI runners work only where the app runs next to the CLI. The deployed app uses API runners.";
const CONCURRENCY_CAPTION = "Parallel requests per provider during bulk runs.";

const SETTINGS_SELECT_CLASS =
  "h-8 w-full appearance-none rounded-md border border-border bg-surface pl-2.5 pr-7 text-[12.5px] text-foreground shadow-xs outline-none transition focus:border-ring disabled:cursor-not-allowed disabled:opacity-50";

function isRunnerProvider(value: unknown): value is RunnerProvider {
  return RUNNER_PROVIDER_OPTIONS.some((option) => option.value === value);
}

function clampLane(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return 1;
  return Math.min(10, Math.max(1, parsed));
}

/* The three metered providers, and which form/key-status field each one reads,
   so the picker, the dropdown, the key pill, and the save payload can never
   drift apart as providers are added. */

/* Concurrency is edited as strings so partially typed numbers never snap
   underneath the cursor; clamping to 1..10 happens at diff/save time. */
type SettingsForm = Omit<ProspectRunnerConfig, "concurrency"> & { concurrency: Record<LaneKey, string> };

type SettingsPhase =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | {
      kind: "ready";
      form: SettingsForm;
      baseline: ProspectRunnerConfig;
      catalog: ModelCatalogEntry[];
      keyStatus: ApiKeyStatus;
    };

function readySettingsPhase(
  config: {
    provider: string;
    concurrency: Record<LaneKey, number>;
  },
  catalog: ModelCatalogEntry[],
  keyStatus: ApiKeyStatus,
): SettingsPhase {
  const provider = isRunnerProvider(config.provider) ? config.provider : "anthropic-api";
  const baseline: ProspectRunnerConfig = {
    provider,
    concurrency: {
      llm: config.concurrency.llm,
      leadmagic: config.concurrency.leadmagic,
      zerobounce: config.concurrency.zerobounce,
      smartlead: config.concurrency.smartlead,
    },
  };
  return {
    kind: "ready",
    form: {
      ...baseline,
      concurrency: {
        llm: String(baseline.concurrency.llm),
        leadmagic: String(baseline.concurrency.leadmagic),
        zerobounce: String(baseline.concurrency.zerobounce),
        smartlead: String(baseline.concurrency.smartlead),
      },
    },
    baseline,
    catalog,
    keyStatus,
  };
}

function SettingsSkeleton() {
  return (
    <div className="flex flex-col gap-4" aria-hidden>
      {[0, 1].map((index) => (
        <div key={index} className="flex flex-col gap-1.5">
          <div className="h-3 w-16 rounded bg-muted" />
          <div className="h-8 w-full rounded-md bg-muted/60" />
        </div>
      ))}
      <div className="flex flex-col gap-1.5">
        <div className="h-3 w-20 rounded bg-muted" />
        <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
          {CONCURRENCY_LANES.map((lane) => (
            <div key={lane.key} className="h-8 rounded-md bg-muted/60" />
          ))}
        </div>
      </div>
      <div className="flex items-center gap-2 text-[12px] text-muted-foreground">
        <Loader2 className="size-3.5 animate-spin" />
        Loading prospect settings...
      </div>
    </div>
  );
}

export function ProspectSettingsDialog({
  onClose,
  showToast,
  onSaved,
}: {
  onClose: () => void;
  showToast: (ok: boolean, text: string) => void;
  onSaved?: (config: ProspectRunnerConfig) => void;
}) {
  const [phase, setPhase] = useState<SettingsPhase>({ kind: "loading" });
  const [saving, setSaving] = useState(false);
  // Monotonic ticket: only the newest load may apply, and a save invalidates
  // any load still in flight (so a stale response never clobbers the result).
  const ticketRef = useRef(0);

  const load = useCallback(async () => {
    const ticket = ++ticketRef.current;
    setPhase({ kind: "loading" });
    try {
      const result = await getEnrichmentSettingsAction();
      if (ticket !== ticketRef.current) return;
      if (!result.ok || !result.config || !result.catalog || !result.keyStatus) {
        setPhase({ kind: "error", message: result.message || "Could not load prospect settings." });
        return;
      }
      setPhase(readySettingsPhase(result.config, result.catalog, result.keyStatus));
    } catch (error) {
      if (ticket !== ticketRef.current) return;
      setPhase({
        kind: "error",
        message: error instanceof Error && error.message ? error.message : "Could not load prospect settings.",
      });
    }
  }, []);

  // Lazy-load on open, deferred a tick so the fetch kickoff (and its setState)
  // never runs synchronously inside the effect body.
  useEffect(() => {
    const timer = window.setTimeout(() => {
      void load();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  const ready = phase.kind === "ready" ? phase : null;

  const patchForm = (patch: Partial<SettingsForm>) =>
    setPhase((prev) => (prev.kind === "ready" ? { ...prev, form: { ...prev.form, ...patch } } : prev));
  const setLane = (key: LaneKey, value: string) =>
    setPhase((prev) =>
      prev.kind === "ready"
        ? { ...prev, form: { ...prev.form, concurrency: { ...prev.form.concurrency, [key]: value } } }
        : prev,
    );

  const normalized: ProspectRunnerConfig | null = ready
    ? {
        provider: ready.form.provider,
        concurrency: {
          llm: clampLane(ready.form.concurrency.llm),
          leadmagic: clampLane(ready.form.concurrency.leadmagic),
          zerobounce: clampLane(ready.form.concurrency.zerobounce),
          smartlead: clampLane(ready.form.concurrency.smartlead),
        },
      }
    : null;

  // Field-wise diff: JSON.stringify would flag a false diff on key order alone.
  const dirty =
    ready !== null &&
    normalized !== null &&
    (normalized.provider !== ready.baseline.provider ||
      CONCURRENCY_LANES.some((lane) => normalized.concurrency[lane.key] !== ready.baseline.concurrency[lane.key]));

  const save = async () => {
    if (!ready || !normalized || !dirty || saving) return;
    const ticket = ++ticketRef.current;
    setSaving(true);
    try {
      const result = await saveEnrichmentSettingsAction({ config: normalized });
      showToast(result.ok, result.message || (result.ok ? "Prospect settings saved." : "Could not save prospect settings."));
      if (result.ok && result.config) {
        if (ticket === ticketRef.current) {
          const savedProvider = isRunnerProvider(result.config.provider) ? result.config.provider : normalized.provider;
          onSaved?.({ ...normalized, ...result.config, provider: savedProvider });
        }
        onClose();
      }
    } catch (error) {
      showToast(false, error instanceof Error && error.message ? error.message : "Could not save prospect settings.");
    } finally {
      setSaving(false);
    }
  };


  return (
    <ModalShell
      title="Prospect settings"
      description="Runner, model, and bulk concurrency for prospect enrichment."
      onClose={onClose}
      closeDisabled={saving}
      footer={
        ready ? (
          <>
            <button type="button" disabled={saving} onClick={onClose} className={`${BTN_OUTLINE} h-8 px-3 text-[12px]`}>
              Cancel
            </button>
            <button
              type="button"
              disabled={saving || !dirty}
              onClick={() => void save()}
              className={`${BTN_PRIMARY} h-8 px-3 text-[12px]`}
            >
              {saving ? <Loader2 className="size-3.5 animate-spin" /> : null}
              {saving ? "Saving..." : "Save settings"}
            </button>
          </>
        ) : (
          <button type="button" onClick={onClose} className={`${BTN_OUTLINE} h-8 px-3 text-[12px]`}>
            Close
          </button>
        )
      }
    >
      {phase.kind === "loading" ? (
        <SettingsSkeleton />
      ) : phase.kind === "error" ? (
        <div className="flex flex-col gap-3">
          <div className="rounded-md border border-destructive/30 bg-destructive-soft p-3 text-[12.5px] text-destructive">
            {phase.message}
          </div>
          <button type="button" onClick={() => void load()} className={`${BTN_OUTLINE} h-8 self-start px-3 text-[12px]`}>
            Retry
          </button>
        </div>
      ) : ready ? (
        <>
          <div className="flex flex-col gap-1.5">
            <label
              htmlFor="prospect-settings-runner"
              className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground"
            >
              Runner
            </label>
            <div className="relative">
              <select
                id="prospect-settings-runner"
                value={ready.form.provider}
                disabled={saving}
                onChange={(event) => {
                  const next = event.target.value;
                  if (isRunnerProvider(next)) patchForm({ provider: next });
                }}
                className={SETTINGS_SELECT_CLASS}
              >
                {RUNNER_PROVIDER_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
              <ChevronDown className="pointer-events-none absolute right-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            </div>
            <p className="text-[11px] leading-4 text-muted-foreground">{RUNNER_CAPTION}</p>
          </div>

          {/* Models are chosen per column (each column stores an API choice
              and a CLI choice), so there is deliberately no workspace-wide
              model here to contradict what the table shows. */}

          <div className="flex flex-col gap-1.5">
            <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Concurrency</span>
            <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
              {CONCURRENCY_LANES.map((lane) => (
                <label key={lane.key} className="flex flex-col gap-1">
                  <span className="text-[11px] font-medium text-muted-foreground">{lane.label}</span>
                  <input
                    type="number"
                    min={1}
                    max={10}
                    step={1}
                    inputMode="numeric"
                    value={ready.form.concurrency[lane.key]}
                    disabled={saving}
                    onChange={(event) => setLane(lane.key, event.target.value)}
                    className={INPUT_CLASS}
                  />
                </label>
              ))}
            </div>
            <p className="text-[11px] leading-4 text-muted-foreground">{CONCURRENCY_CAPTION}</p>
          </div>
        </>
      ) : null}
    </ModalShell>
  );
}

/* ── Model-only editor ─────────────────────────────────────────────────────

   For a column that runs a model but has nothing else to configure - the email
   QA gate, whose prompts are built in code from the sequence it is judging.
   Without this the gate had no editor at all, so its model could only be
   changed from a script and read as hard-wired. */
export function ColumnModelDialog({
  title,
  description,
  initialModel,
  initialCliModel,
  initialReasoningEffort = "",
  apiModels,
  cliModels,
  cliMode = false,
  modelsLoading = false,
  modelSource = "catalog",
  pending,
  onSave,
  onClose,
}: {
  title: string;
  description: string;
  initialModel: string;
  initialCliModel: string;
  initialReasoningEffort?: string;
  apiModels: ModelOption[];
  cliModels: ModelOption[];
  cliMode?: boolean;
  modelsLoading?: boolean;
  modelSource?: "gateway" | "catalog";
  pending: boolean;
  onSave: (models: { model: string; cliModel: string; reasoningEffort: string }) => void;
  onClose: () => void;
}) {
  const [model, setModel] = useState(initialModel);
  const [cliModel, setCliModel] = useState(initialCliModel);
  const [reasoningEffort, setReasoningEffort] = useState(initialReasoningEffort);
  const dirty = model !== initialModel || cliModel !== initialCliModel || reasoningEffort !== initialReasoningEffort;

  return (
    <ModalShell
      title={title}
      description={description}
      onClose={onClose}
      closeDisabled={pending}
      footer={
        <>
          <button type="button" disabled={pending} onClick={onClose} className={`${BTN_OUTLINE} h-8 px-3 text-[12px]`}>
            Cancel
          </button>
          <button
            type="button"
            disabled={pending || !dirty}
            onClick={() => onSave({ model: model.trim(), cliModel: cliModel.trim(), reasoningEffort })}
            className={`${BTN_PRIMARY} h-8 px-3 text-[12px]`}
          >
            {pending ? <Loader2 className="size-3.5 animate-spin" /> : null}
            {pending ? "Saving..." : "Save model"}
          </button>
        </>
      }
    >
      <ColumnModelFields
        idPrefix="column-model"
        model={model}
        cliModel={cliModel}
        onModelChange={setModel}
        onCliModelChange={setCliModel}
        reasoningEffort={reasoningEffort}
        onReasoningEffortChange={setReasoningEffort}
        disabled={pending}
        apiModels={apiModels}
        cliModels={cliModels}
        cliMode={cliMode}
        loading={modelsLoading}
        source={modelSource}
      />
    </ModalShell>
  );
}

/* ── Prompt editor (AI personalization columns) ───────────────────────── */

export function PromptEditorDialog({
  column,
  initialPrompt,
  initialExamples,
  initialModel,
  initialCliModel,
  apiModels,
  cliModels,
  cliMode = false,
  modelsLoading = false,
  modelSource = "catalog",
  pending,
  onSave,
  onClose,
}: {
  column: AiPromptColumn;
  initialPrompt: string;
  initialExamples: NormalizationExample[];
  initialModel: string;
  initialCliModel: string;
  apiModels: ModelOption[];
  cliModels: ModelOption[];
  cliMode?: boolean;
  modelsLoading?: boolean;
  modelSource?: "gateway" | "catalog";
  pending: boolean;
  onSave: (column: AiPromptColumn, prompt: string, examples: NormalizationExample[], model: string, cliModel: string) => void;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState(initialPrompt);
  const [model, setModel] = useState(initialModel);
  const [cliModel, setCliModel] = useState(initialCliModel);
  const [examples, setExamples] = useState<NormalizationExample[]>(initialExamples);
  const MAX = 20;
  const setAt = (i: number, patch: Partial<NormalizationExample>) =>
    setExamples((current) => current.map((e, idx) => (idx === i ? { ...e, ...patch } : e)));
  const removeAt = (i: number) => setExamples((current) => current.filter((_, idx) => idx !== i));
  const add = () => setExamples((current) => (current.length >= MAX ? current : [...current, { original: "", normalized: "" }]));

  return (
    <ModalShell
      title={`${ACTION_LABELS[column]} prompt`}
      description="The instruction the model receives for this column, alongside the row source data."
      widthClass="max-w-xl"
      onClose={onClose}
      closeDisabled={pending}
      footer={
        <>
          <button
            type="button"
            disabled={pending}
            onClick={() => setDraft(DEFAULT_PROMPTS[column])}
            className={`${BTN_OUTLINE} h-8 px-3 text-[12px]`}
          >
            Reset default
          </button>
          <button type="button" disabled={pending} onClick={onClose} className={`${BTN_OUTLINE} h-8 px-3 text-[12px]`}>
            Cancel
          </button>
          <button
            type="button"
            disabled={pending || !draft.trim()}
            onClick={() => onSave(column, draft, examples, model.trim(), cliModel.trim())}
            className={`${BTN_PRIMARY} h-8 px-3 text-[12px]`}
          >
            {pending ? <Loader2 className="size-3.5 animate-spin" /> : null}
            {pending ? "Saving..." : "Save prompt"}
          </button>
        </>
      }
    >
      <div className="flex flex-col gap-1.5">
        <label
          htmlFor="enrichment-prompt"
          className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground"
        >
          Prompt
        </label>
        <textarea
          id="enrichment-prompt"
          value={draft}
          disabled={pending}
          spellCheck={false}
          rows={12}
          onChange={(event) => setDraft(event.target.value)}
          className="min-h-[16rem] w-full resize-y rounded-md border border-border bg-surface px-2.5 py-2 font-mono text-[12px] leading-5 text-foreground shadow-xs outline-none transition placeholder:text-muted-foreground focus:border-ring disabled:opacity-50"
        />
      </div>
      <ColumnModelFields
        idPrefix="enrichment-prompt"
        model={model}
        cliModel={cliModel}
        onModelChange={setModel}
        onCliModelChange={setCliModel}
        disabled={pending}
        apiModels={apiModels}
        cliModels={cliModels}
        cliMode={cliMode}
        loading={modelsLoading}
        source={modelSource}
      />
      <div className="flex flex-col gap-1.5">
        <div className="flex items-center justify-between gap-2">
          <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
            Examples (Original {"→"} Normalized)
          </span>
          <button
            type="button"
            disabled={pending || examples.length >= MAX}
            onClick={add}
            className={`${BTN_OUTLINE} h-7 gap-1 px-2 text-[11px]`}
          >
            <Plus className="size-3.5" />
            Add example
          </button>
        </div>
        {examples.length === 0 ? (
          <p className="text-[11px] leading-4 text-muted-foreground">
            Add a few Original {"→"} Normalized pairs to teach the model exactly how you want values cleaned. They
            are sent to the model alongside the prompt.
          </p>
        ) : (
          <div className="flex flex-col gap-1">
            {examples.map((example, index) => (
              <div key={index} className="flex items-center gap-1.5">
                <input
                  value={example.original}
                  disabled={pending}
                  maxLength={300}
                  placeholder="Original"
                  onChange={(event) => setAt(index, { original: event.target.value })}
                  className={`${INPUT_CLASS} h-8`}
                />
                <span className="shrink-0 text-muted-foreground">{"→"}</span>
                <input
                  value={example.normalized}
                  disabled={pending}
                  maxLength={300}
                  placeholder="Normalized"
                  onChange={(event) => setAt(index, { normalized: event.target.value })}
                  className={`${INPUT_CLASS} h-8`}
                />
                <button
                  type="button"
                  disabled={pending}
                  onClick={() => removeAt(index)}
                  aria-label="Remove example"
                  className={`flex size-7 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-destructive-soft hover:text-destructive disabled:opacity-50`}
                >
                  <X className="size-3.5" />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
      <div className="rounded-md border border-border bg-muted/30 px-3 py-2 text-[11px] leading-4 text-muted-foreground">
        Saving a changed prompt marks existing cells for this column as outdated, so the run mode
        &quot;{RUN_MODE_LABELS.outdated}&quot; picks them up. If the model output is unusable, runs fall back to the
        deterministic normalizer and the cell shows a fallback marker.
      </div>
    </ModalShell>
  );
}

/* ── Custom AI column editor (v2 layout: per-table columns) ───────────── */

/* Prompt editor with {{variable}} autocomplete. Typing "{{" opens a filtered
   list of the other columns' keys and the built-in lead fields; selecting one
   inserts {{key}}. The same variables are also offered as click-to-insert chips
   under the field. Resolution happens server-side at run/preview time. */
function PromptTemplateField({
  value,
  onChange,
  variables,
  disabled,
}: {
  value: string;
  onChange: (next: string) => void;
  variables: PromptVariable[];
  disabled: boolean;
}) {
  const ref = useRef<HTMLTextAreaElement | null>(null);
  const pendingCaret = useRef<number | null>(null);
  // Last known selection while the field was focused, so a chip clicked when the
  // textarea is blurred inserts at the real cursor (a blurred textarea reports
  // selectionStart 0), not at the start of the prompt.
  const lastSelection = useRef<{ start: number; end: number } | null>(null);
  const [trigger, setTrigger] = useState<{ start: number; query: string } | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);

  const filtered = trigger
    ? variables.filter((v) => {
        const q = trigger.query.toLowerCase();
        return !q || v.key.toLowerCase().includes(q) || v.label.toLowerCase().includes(q);
      })
    : [];

  // Restore the caret after a programmatic insert (the value is parent-owned, so
  // the position must be reapplied once the new value has rendered).
  useEffect(() => {
    if (pendingCaret.current != null && ref.current) {
      const pos = pendingCaret.current;
      pendingCaret.current = null;
      ref.current.focus();
      ref.current.setSelectionRange(pos, pos);
    }
  }, [value]);

  useEffect(() => {
    setActiveIndex(0);
  }, [trigger?.query]);

  const detectTrigger = (text: string, caret: number) => {
    const before = text.slice(0, caret);
    const match = before.match(/\{\{\s*([\w.]*)$/);
    setTrigger(match ? { start: caret - match[0].length, query: match[1] } : null);
  };

  const rememberSelection = (el: HTMLTextAreaElement) => {
    lastSelection.current = { start: el.selectionStart ?? el.value.length, end: el.selectionEnd ?? el.value.length };
  };

  const handleChange = (event: ReactChangeEvent<HTMLTextAreaElement>) => {
    const text = event.target.value;
    onChange(text);
    rememberSelection(event.target);
    detectTrigger(text, event.target.selectionStart ?? text.length);
  };

  const refreshFromRef = () => {
    const el = ref.current;
    if (!el) return;
    rememberSelection(el);
    detectTrigger(el.value, el.selectionStart ?? el.value.length);
  };

  const insertVariable = (key: string) => {
    const el = ref.current;
    const focused = el != null && typeof document !== "undefined" && document.activeElement === el;
    // Prefer the live selection when focused; fall back to the last remembered
    // one (chip clicked while blurred), then to the end of the prompt.
    const sel = focused && el ? { start: el.selectionStart ?? value.length, end: el.selectionEnd ?? value.length } : lastSelection.current;
    const selStart = sel?.start ?? value.length;
    const selEnd = sel?.end ?? selStart;
    // When the autocomplete drove the insert, replace the "{{query" fragment.
    const start = trigger ? trigger.start : selStart;
    const end = trigger ? Math.max(selEnd, trigger.start) : selEnd;
    const token = `{{${key}}}`;
    const next = value.slice(0, start) + token + value.slice(end);
    const caretAfter = start + token.length;
    pendingCaret.current = caretAfter;
    lastSelection.current = { start: caretAfter, end: caretAfter };
    onChange(next);
    setTrigger(null);
  };

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (!trigger || filtered.length === 0) return;
    if (event.key === "ArrowDown") { event.preventDefault(); setActiveIndex((i) => (i + 1) % filtered.length); }
    else if (event.key === "ArrowUp") { event.preventDefault(); setActiveIndex((i) => (i - 1 + filtered.length) % filtered.length); }
    else if (event.key === "Enter" || event.key === "Tab") { event.preventDefault(); insertVariable(filtered[activeIndex].key); }
    // Stop, don't just preventDefault: ModalShell's window keydown listener would
    // otherwise close the whole editor and discard the draft on this Escape.
    else if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); setTrigger(null); }
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="relative">
        <textarea
          ref={ref}
          id="custom-column-prompt"
          value={value}
          disabled={disabled}
          spellCheck={false}
          rows={10}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          onKeyUp={refreshFromRef}
          onClick={refreshFromRef}
          onSelect={(event) => rememberSelection(event.currentTarget)}
          onBlur={() => window.setTimeout(() => setTrigger(null), 120)}
          className="min-h-[13rem] w-full resize-y rounded-md border border-border bg-surface px-2.5 py-2 font-mono text-[12px] leading-5 text-foreground shadow-xs outline-none transition placeholder:text-muted-foreground focus:border-ring disabled:opacity-50"
        />
        {trigger && filtered.length > 0 ? (
          <ul
            role="listbox"
            className="anim-menu-in absolute left-2 top-full z-50 mt-1 max-h-56 w-72 overflow-auto rounded-md border border-border bg-surface p-1 shadow-pop"
            style={{ "--menu-origin": "top left" } as CSSProperties}
          >
            {filtered.map((v, i) => (
              <li key={v.key}>
                <button
                  type="button"
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => insertVariable(v.key)}
                  className={`flex w-full items-center justify-between gap-2 rounded px-2 py-1.5 text-left text-[12px] ${
                    i === activeIndex ? "bg-muted" : "hover:bg-muted/60"
                  }`}
                >
                  <span className="min-w-0 flex-1 truncate">
                    <span className="font-mono text-foreground">{`{{${v.key}}}`}</span>
                    {v.label && v.label.toLowerCase() !== v.key.toLowerCase() ? (
                      <span className="ml-1.5 text-muted-foreground">{v.label}</span>
                    ) : null}
                  </span>
                  <span className="shrink-0 text-[10px] uppercase tracking-wide text-muted-foreground">{v.group}</span>
                </button>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
      {variables.length > 0 ? (
        <div className="flex flex-wrap items-center gap-1">
          <span className="mr-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">Insert</span>
          {variables.map((v) => (
            <button
              key={v.key}
              type="button"
              disabled={disabled}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => insertVariable(v.key)}
              title={`Insert {{${v.key}}} (${v.label})`}
              className={`rounded border border-border bg-muted/40 px-1.5 py-0.5 font-mono text-[10px] text-foreground transition hover:bg-muted disabled:opacity-50`}
            >
              {`{{${v.key}}}`}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/* Collapsible few-shot examples: each example is one line, added/removed
   independently. Stored per column and appended to the prompt at run time (shown
   in the preview), so nothing is hidden. */
function ExamplesEditor({
  examples,
  onChange,
  disabled,
}: {
  examples: string[];
  onChange: (next: string[]) => void;
  disabled: boolean;
}) {
  const MAX_EXAMPLES = 20;
  const [open, setOpen] = useState(examples.length > 0);
  const setAt = (index: number, value: string) => onChange(examples.map((e, i) => (i === index ? value : e)));
  const removeAt = (index: number) => onChange(examples.filter((_, i) => i !== index));
  const add = () => { if (examples.length >= MAX_EXAMPLES) return; onChange([...examples, ""]); setOpen(true); };

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between gap-2">
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          className={`flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground transition-colors hover:text-foreground`}
        >
          <ChevronDown className={`size-3 transition-transform ${open ? "" : "-rotate-90"}`} />
          Examples{examples.length ? ` (${examples.length})` : ""}
        </button>
        <button
          type="button"
          disabled={disabled || examples.length >= MAX_EXAMPLES}
          title={examples.length >= MAX_EXAMPLES ? `Up to ${MAX_EXAMPLES} examples` : undefined}
          onClick={add}
          className={`${BTN_OUTLINE} h-7 gap-1 px-2 text-[11px]`}
        >
          <Plus className="size-3.5" />
          Add example
        </button>
      </div>
      {open ? (
        examples.length === 0 ? (
          <p className="text-[11px] leading-4 text-muted-foreground">
            No examples yet. Add finished outputs in the exact style you want back. They are appended to the prompt as
            guides (the model won&apos;t copy them verbatim).
          </p>
        ) : (
          <div className="flex flex-col gap-1">
            {examples.map((example, index) => (
              <div key={index} className="flex items-center gap-1.5">
                <span className="select-none font-mono text-[11px] text-muted-foreground">-</span>
                <input
                  value={example}
                  disabled={disabled}
                  maxLength={500}
                  onChange={(event) => setAt(index, event.target.value)}
                  placeholder="A finished output in the style you want"
                  className={`${INPUT_CLASS} h-8`}
                />
                <button
                  type="button"
                  disabled={disabled}
                  onClick={() => removeAt(index)}
                  aria-label="Remove example"
                  className={`flex size-7 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-destructive-soft hover:text-destructive disabled:opacity-50`}
                >
                  <X className="size-3.5" />
                </button>
              </div>
            ))}
          </div>
        )
      ) : null}
    </div>
  );
}

export type ModelOption = { id: string; label: string; group: string; detail?: string };

/* Model picker: a combobox, not a <datalist> and not a <select>.

   A fixed <select> was the wrong shape here - the gateway serves hundreds of
   models and adds more weekly, so any hardcoded list is stale on arrival (this
   is why GPT-5.6 Luna was unpickable). But the <datalist> that replaced it was
   wrong in two ways that both read as "the picker is broken":

   - The browser draws its popup with the OS theme and positions it wherever it
     likes, so on a light page in dark mode it appeared as a black panel outside
     the dialog. None of it is styleable.
   - A datalist filters its suggestions against whatever is ALREADY in the input.
     A column pinned to "openai/gpt-5.4-mini" therefore offered exactly one
     suggestion - itself - and every other model looked unavailable.

   So: own the popup. Opening shows the whole list regardless of the current
   value (`query` is separate from `value` and starts empty); typing filters it.
   Free text still wins - the field accepts any id, because the gateway is the
   authority on what it serves and answers at run time. */
export function ModelPicker({
  id,
  value,
  onChange,
  disabled,
  options,
  loading,
  placeholder,
}: {
  id: string;
  value: string;
  onChange: (next: string) => void;
  disabled: boolean;
  options: ModelOption[];
  loading: boolean;
  placeholder: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  // Fixed coordinates, because the dialog body scrolls behind `overflow-hidden`:
  // an absolutely positioned menu would be clipped at the panel's edge.
  const [rect, setRect] = useState<{ left: number; width: number; top: number; maxHeight: number } | null>(null);
  const anchorRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  /* Matched on the raw value, empty string included: the CLI list carries a real
     "" row ("Claude Code default"), so an unset CLI model has a name to show
     rather than looking like a blank the operator forgot to fill in. The API
     list has no "" row, so an unset one correctly falls through to the
     placeholder. */
  const selected = options.find((option) => option.id === value);

  /* Ids stay in the haystack even though no row prints one: pasting
     "openai/gpt-5.6-luna" should find Luna. Names alone are what the operator
     reads; ids are what the operator sometimes arrives with. */
  const filtered = query.trim()
    ? options.filter((option) => {
        const needle = query.trim().toLowerCase();
        return `${option.label} ${option.id} ${option.group}`.toLowerCase().includes(needle);
      })
    : options;

  // Measure against the viewport and flip upward when the field sits low enough
  // that a downward menu would run off the bottom.
  const place = useCallback(() => {
    const anchor = anchorRef.current;
    if (!anchor) return;
    const box = anchor.getBoundingClientRect();
    const below = window.innerHeight - box.bottom - 8;
    const above = box.top - 8;
    // These fields sit near the bottom of a tall dialog, so opening downward is
    // usually the cramped direction. Take whichever side is roomier once the
    // preferred one drops under a usable height.
    const flip = below < 240 && above > below;
    const height = Math.min(320, Math.max(flip ? above : below, 120));
    setRect({
      left: box.left,
      width: box.width,
      top: flip ? Math.max(8, box.top - height - 4) : box.bottom + 4,
      maxHeight: height,
    });
  }, []);

  useEffect(() => {
    if (!open) return;
    place();
    // Any ancestor can scroll (the dialog body does), so listen in the capture
    // phase rather than binding to one element.
    const onScroll = () => place();
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onScroll);
    return () => {
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onScroll);
    };
  }, [open, place]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (anchorRef.current?.contains(target) || listRef.current?.contains(target)) return;
      setOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    return () => document.removeEventListener("mousedown", onPointerDown);
  }, [open]);

  // Keep the highlighted row in view when arrowing past the fold.
  useEffect(() => {
    if (!open) return;
    listRef.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: "nearest" });
  }, [open, activeIndex]);

  const openMenu = () => {
    if (disabled) return;
    setQuery("");
    // Against `options`, not `filtered`: clearing the query is what makes the
    // whole list visible, and `filtered` still reflects the query being cleared.
    setActiveIndex(Math.max(0, options.findIndex((option) => option.id === value)));
    setOpen(true);
  };

  /* Keep focus on the field after choosing. Blurring here would mean the next
     click lands on an already-unfocused input, so `onFocus` fires and reopens -
     but a click on a still-focused one fires no focus event at all, which is
     why the field also reopens on click below. */
  const commit = (next: string) => {
    onChange(next);
    setOpen(false);
    setQuery("");
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (!open) { openMenu(); return; }
      if (!filtered.length) return;
      const step = event.key === "ArrowDown" ? 1 : -1;
      setActiveIndex((i) => (i + step + filtered.length) % filtered.length);
    } else if (event.key === "Enter") {
      event.preventDefault();
      // Enter on a typed id that matches nothing keeps the typed value: pasting
      // an id the gateway serves but this list has not heard of is supported.
      if (open && filtered[activeIndex]) commit(filtered[activeIndex].id);
      else { commit(query.trim() || value); }
    } else if (event.key === "Escape") {
      if (!open) return;
      // Stop, don't just preventDefault: ModalShell's window keydown listener
      // would otherwise close the whole editor and discard the draft.
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
      setQuery("");
    } else if (event.key === "Tab") {
      setOpen(false);
    }
  };

  // Closed and set: show the friendly name and let the id ride underneath, so a
  // glance answers "what is this column running" without decoding a slug.
  const display = open ? query : selected ? selected.label : value;

  let lastGroup: string | null = null;
  let lastRoot: string | null = null;
  return (
    <div ref={anchorRef} className="relative">
      <div className="relative">
        <input
          id={id}
          ref={inputRef}
          role="combobox"
          aria-expanded={open}
          aria-controls={`${id}-listbox`}
          aria-autocomplete="list"
          value={display}
          disabled={disabled}
          spellCheck={false}
          autoComplete="off"
          maxLength={100}
          placeholder={loading ? "Loading models..." : placeholder}
          onChange={(event) => { setQuery(event.target.value); setActiveIndex(0); if (!open) setOpen(true); }}
          onFocus={openMenu}
          onClick={() => { if (!open) openMenu(); }}
          onKeyDown={onKeyDown}
          className={`${INPUT_CLASS} cursor-pointer pr-8 disabled:opacity-50`}
        />
        <ChevronDown
          aria-hidden
          onMouseDown={(event) => { event.preventDefault(); if (open) setOpen(false); else { inputRef.current?.focus(); openMenu(); } }}
          className={`pointer-events-auto absolute right-2 top-1/2 size-3.5 -translate-y-1/2 cursor-pointer text-muted-foreground transition-transform ${open ? "rotate-180" : ""}`}
        />
      </div>
      {open && rect
        ? createPortal(
            <div
              ref={listRef}
              id={`${id}-listbox`}
              role="listbox"
              className="anim-menu-in fixed z-[60] overflow-y-auto overscroll-contain rounded-md border border-border bg-surface p-1 shadow-pop"
              style={{ left: rect.left, top: rect.top, width: rect.width, maxHeight: rect.maxHeight, "--menu-origin": "top left" } as CSSProperties}
            >
              {filtered.length === 0 ? (
                <p className="px-2 py-3 text-[11.5px] text-muted-foreground">
                  No model matches. Press Enter to use &ldquo;{query.trim()}&rdquo; anyway.
                </p>
              ) : (
                filtered.map((option, index) => {
                  /* Groups arrive as "Claude Code" and "Claude Code · previous
                     generations". Split them: a new VENDOR gets a rule above it
                     and a full-strength heading, while its own sub-sections are
                     only labelled - so Claude and Codex read as two blocks
                     rather than four similar-looking headings in a row. */
                  const root = option.group.split(" · ")[0];
                  const newGroup = option.group !== lastGroup;
                  const newRoot = newGroup && root !== lastRoot;
                  // A filtered list can open straight into a sub-section (search
                  // "4.8"), so a new root spells out the whole group rather than
                  // labelling legacy rows with the vendor's main heading.
                  const header = newGroup ? (newRoot ? option.group : option.group.slice(root.length + 3)) : null;
                  const rule = newRoot && lastRoot !== null;
                  lastGroup = option.group;
                  lastRoot = root;
                  return (
                    <div key={`${option.group}:${option.id || "default"}`}>
                      {rule ? <div className="my-1.5 border-t border-border" /> : null}
                      {header ? (
                        <div
                          className={`sticky top-0 z-10 bg-surface px-2 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-wide ${
                            newRoot ? "text-foreground" : "text-muted-foreground"
                          }`}
                        >
                          {header}
                        </div>
                      ) : null}
                      <button
                        type="button"
                        role="option"
                        aria-selected={option.id === value}
                        data-active={index === activeIndex}
                        tabIndex={-1}
                        onMouseDown={(event) => event.preventDefault()}
                        onMouseEnter={() => setActiveIndex(index)}
                        onClick={() => commit(option.id)}
                        className={`flex w-full items-center gap-2 rounded px-2 py-1.5 text-left ${
                          index === activeIndex ? "bg-muted" : "hover:bg-muted/60"
                        }`}
                      >
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-[12px] font-medium text-foreground">{option.label}</span>
                          {option.detail ? (
                            <span className="mt-0.5 block truncate text-[11px] text-muted-foreground">{option.detail}</span>
                          ) : null}
                        </span>
                        {option.id === value ? <Check className="size-3.5 shrink-0 text-success" /> : null}
                      </button>
                    </div>
                  );
                })
              )}
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}

/* Both of a column's models, side by side. Showing them together (rather than
   only the active mode's) is the point: the pair IS the column's configuration,
   and a reader can see what happens in either mode without toggling anything. */
export function ColumnModelFields({
  idPrefix,
  model,
  cliModel,
  onModelChange,
  onCliModelChange,
  reasoningEffort,
  onReasoningEffortChange,
  disabled,
  apiModels,
  cliModels,
  cliMode,
  loading,
  source,
}: {
  idPrefix: string;
  model: string;
  cliModel: string;
  onModelChange: (next: string) => void;
  onCliModelChange: (next: string) => void;
  /* Reasoning is one normalized dial for every vendor (the gateway maps it to
     each family's own knob), applied in API mode. Omit the handler to hide
     the field. "" = off. */
  reasoningEffort?: string;
  onReasoningEffortChange?: (next: string) => void;
  disabled: boolean;
  apiModels: ModelOption[];
  cliModels: ModelOption[];
  cliMode: boolean;
  loading: boolean;
  source: "gateway" | "catalog";
}) {
  /* Label row, then field, then hint - the same three-part grammar as every
     other field in these dialogs. The "active now" badge belongs on the label
     row: sitting below the input it read as a validation message about the
     value rather than a note about which mode the runner is in. */
  const field = (
    key: "api" | "cli",
    { label, value, onValueChange, options, hint, placeholder }: {
      label: string;
      value: string;
      onValueChange: (next: string) => void;
      options: ModelOption[];
      hint: string;
      placeholder: string;
    },
  ) => (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between gap-2">
        <label htmlFor={`${idPrefix}-${key}`} className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
          {label}
        </label>
        {(key === "cli") === cliMode ? (
          <span className="inline-flex items-center rounded bg-success-soft px-1.5 py-px text-[10px] font-medium text-success">
            active now
          </span>
        ) : null}
      </div>
      <ModelPicker
        id={`${idPrefix}-${key}`}
        value={value}
        onChange={onValueChange}
        disabled={disabled}
        options={options}
        loading={loading}
        placeholder={placeholder}
      />
      <p className="text-[11px] leading-4 text-muted-foreground">{hint}</p>
    </div>
  );

  const gatewayCount = new Set(apiModels.map((option) => option.id)).size;
  return (
    <div className="flex flex-col gap-3">
      {field("api", {
        label: "Model — API mode",
        value: model,
        onValueChange: onModelChange,
        options: apiModels,
        placeholder: "Search models…",
        hint: source === "gateway"
          ? `${gatewayCount} text models live from the AI Gateway. Search, or paste any id it serves.`
          : "Add an AI Gateway key in Settings to pick from every model it serves.",
      })}
      {onReasoningEffortChange ? (
        <div className="flex flex-col gap-1.5">
          <label
            htmlFor={`${idPrefix}-reasoning`}
            className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground"
          >
            Reasoning — API mode
          </label>
          <select
            id={`${idPrefix}-reasoning`}
            value={reasoningEffort ?? ""}
            disabled={disabled}
            onChange={(event) => onReasoningEffortChange(event.target.value)}
            className={SETTINGS_SELECT_CLASS}
          >
            <option value="">Off — answer directly, fastest and cheapest</option>
            <option value="low">Low — brief hidden thinking</option>
            <option value="medium">Medium — solid reasoning before answering</option>
            <option value="high">High — deepest reasoning, slowest and most tokens</option>
          </select>
          <p className="text-[11px] leading-4 text-muted-foreground">
            One dial for every vendor — the gateway translates it per model family and ignores it where a model
            has no reasoning. Thinking tokens bill as output; the run adds token headroom automatically.
          </p>
        </div>
      ) : null}
      {field("cli", {
        label: "Model — CLI mode",
        value: cliModel,
        onValueChange: onCliModelChange,
        options: cliModels,
        placeholder: "Search models…",
        hint: "Runs on your local Claude Code or Codex subscription, with no per-token cost.",
      })}
    </div>
  );
}

export function CustomColumnEditorDialog({
  mode,
  initialLabel,
  initialPrompt,
  initialModel,
  initialCliModel,
  initialReasoningEffort = "",
  initialExamples,
  apiModels,
  cliModels,
  cliMode = false,
  modelsLoading = false,
  modelSource = "catalog",
  variables,
  previewLeadName,
  onPreview,
  pending,
  deletePending = false,
  onSave,
  onDelete,
  onClose,
}: {
  mode: "create" | "edit";
  initialLabel: string;
  initialPrompt: string;
  initialModel: string;
  initialCliModel: string;
  initialReasoningEffort?: string;
  initialExamples: string[];
  apiModels: ModelOption[];
  cliModels: ModelOption[];
  cliMode?: boolean;
  modelsLoading?: boolean;
  modelSource?: "gateway" | "catalog";
  variables: PromptVariable[];
  previewLeadName: string | null;
  onPreview?: (prompt: string, model: string, examples: string[]) => Promise<{ ok: boolean; full?: string; missing?: string[]; message?: string }>;
  pending: boolean;
  deletePending?: boolean;
  onSave: (label: string, prompt: string, model: string, cliModel: string, examples: string[], reasoningEffort: string) => void;
  onDelete?: () => void;
  onClose: () => void;
}) {
  const [label, setLabel] = useState(initialLabel);
  const [prompt, setPrompt] = useState(initialPrompt);
  const [model, setModel] = useState(initialModel);
  const [cliModel, setCliModel] = useState(initialCliModel);
  const [reasoningEffort, setReasoningEffort] = useState(initialReasoningEffort);
  const [examples, setExamples] = useState<string[]>(initialExamples);
  const [deleteArmed, setDeleteArmed] = useState(false);
  // The prompt field is one box with two views: write it, or see it resolved for
  // a real lead. There is no second "full prompt" - this IS the full prompt.
  const [view, setView] = useState<"edit" | "preview">("edit");
  const [preview, setPreview] = useState<{ loading: boolean; text: string | null; missing: string[]; error: string | null }>(
    { loading: false, text: null, missing: [], error: null },
  );
  const busy = pending || deletePending;
  const canSave = label.trim().length > 0 && prompt.trim().length > 0;
  const canPreview = Boolean(onPreview && previewLeadName);

  const runPreview = async () => {
    if (!onPreview) return;
    setPreview({ loading: true, text: null, missing: [], error: null });
    const res = await onPreview(prompt, model.trim(), examples);
    setPreview(
      res.ok
        ? { loading: false, text: res.full ?? "", missing: res.missing ?? [], error: null }
        : { loading: false, text: null, missing: [], error: res.message ?? "Preview failed." },
    );
  };

  const showPreview = () => {
    if (!canPreview) return;
    setView("preview");
    void runPreview();
  };

  return (
    <ModalShell
      title={mode === "create" ? "Add AI column" : `Edit "${initialLabel}"`}
      description="This prompt is the full prompt sent to the model. Use {{variables}} to pull in lead data or another column's output, then it writes the result into this cell."
      widthClass="max-w-xl"
      onClose={onClose}
      closeDisabled={busy}
      footer={
        <>
          {mode === "edit" && onDelete ? (
            deleteArmed ? (
              <button
                type="button"
                disabled={busy}
                onClick={onDelete}
                className={`h-8 rounded-md px-3 text-[12px] font-medium text-destructive transition-colors hover:bg-destructive-soft disabled:opacity-50`}
              >
                {deletePending ? <Loader2 className="mr-1 inline size-3.5 animate-spin" /> : null}
                Confirm delete
              </button>
            ) : (
              <button
                type="button"
                disabled={busy}
                onClick={() => setDeleteArmed(true)}
                className={`h-8 rounded-md px-3 text-[12px] font-medium text-destructive transition-colors hover:bg-destructive-soft disabled:opacity-50`}
              >
                Delete column
              </button>
            )
          ) : null}
          <span className="flex-1" />
          <button type="button" disabled={busy} onClick={onClose} className={`${BTN_OUTLINE} h-8 px-3 text-[12px]`}>
            Cancel
          </button>
          <button
            type="button"
            disabled={busy || !canSave}
            onClick={() => onSave(label.trim(), prompt.trim(), model.trim(), cliModel.trim(), examples, reasoningEffort)}
            className={`${BTN_PRIMARY} h-8 px-3 text-[12px]`}
          >
            {pending ? <Loader2 className="size-3.5 animate-spin" /> : null}
            {pending ? "Saving..." : mode === "create" ? "Add column" : "Save column"}
          </button>
        </>
      }
    >
      <div className="flex flex-col gap-1.5">
        <label
          htmlFor="custom-column-label"
          className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground"
        >
          Column name
        </label>
        <input
          id="custom-column-label"
          value={label}
          maxLength={80}
          disabled={busy}
          onChange={(event) => setLabel(event.target.value)}
          className={INPUT_CLASS}
        />
      </div>
      <div className="flex flex-col gap-1.5">
        <div className="flex items-center justify-between gap-2">
          <label
            htmlFor="custom-column-prompt"
            className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground"
          >
            Prompt sent to the model
          </label>
          <div className="flex items-center rounded-md border border-border p-0.5">
            <button
              type="button"
              disabled={busy}
              onClick={() => setView("edit")}
              className={`h-6 rounded px-2 text-[11px] font-medium transition-colors ${
                view === "edit" ? "bg-muted text-foreground" : "text-muted-foreground hover:text-foreground"
              }`}
            >
              Edit
            </button>
            <button
              type="button"
              disabled={busy || !canPreview}
              title={canPreview ? undefined : "Load at least one lead in the table to preview"}
              onClick={showPreview}
              className={`h-6 rounded px-2 text-[11px] font-medium transition-colors disabled:opacity-40 ${
                view === "preview" ? "bg-muted text-foreground" : "text-muted-foreground hover:text-foreground"
              }`}
            >
              Preview
            </button>
          </div>
        </div>
        {view === "edit" ? (
          <>
            <PromptTemplateField value={prompt} onChange={setPrompt} variables={variables} disabled={busy} />
            <p className="text-[11px] leading-4 text-muted-foreground">
              Type <span className="font-mono">{"{{"}</span> to insert a lead field or another column&apos;s output. What
              you write here is exactly what the model receives.
            </p>
          </>
        ) : (
          <>
            <div className="flex items-center justify-between gap-2">
              <p className="text-[11px] leading-4 text-muted-foreground">
                Your prompt, resolved for {previewLeadName}.
              </p>
              <button
                type="button"
                disabled={busy || preview.loading}
                onClick={() => void runPreview()}
                className={`${BTN_OUTLINE} h-6 px-2 text-[11px]`}
              >
                {preview.loading ? <Loader2 className="size-3.5 animate-spin" /> : null}
                Refresh
              </button>
            </div>
            {preview.error ? <p className="text-[11px] leading-4 text-destructive">{preview.error}</p> : null}
            {preview.missing.length > 0 ? (
              <p className="text-[11px] leading-4 text-destructive">
                Unknown variables (resolved to empty): {preview.missing.map((key) => `{{${key}}}`).join(", ")}
              </p>
            ) : null}
            <pre className="min-h-[13rem] max-h-[26rem] overflow-auto whitespace-pre-wrap rounded-md border border-border bg-muted/30 px-2.5 py-2 font-mono text-[11px] leading-5 text-foreground">
              {preview.loading ? "Resolving..." : preview.text != null ? preview.text || "(empty prompt)" : ""}
            </pre>
          </>
        )}
      </div>
      <ExamplesEditor examples={examples} onChange={setExamples} disabled={busy} />
      <div className="flex flex-col gap-1.5">
        <label
          htmlFor="custom-column-model"
          className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground"
        >
          Model
        </label>
        <ColumnModelFields
          idPrefix="custom-column"
          model={model}
          cliModel={cliModel}
          onModelChange={setModel}
          onCliModelChange={setCliModel}
          reasoningEffort={reasoningEffort}
          onReasoningEffortChange={setReasoningEffort}
          disabled={busy}
          apiModels={apiModels}
          cliModels={cliModels}
          cliMode={cliMode}
          loading={modelsLoading}
          source={modelSource}
        />
      </div>
      {mode === "edit" ? (
        <div className="rounded-md border border-border bg-muted/30 px-3 py-2 text-[11px] leading-4 text-muted-foreground">
          Saving a changed prompt marks existing cells for this column as outdated. Use the column&apos;s run menu to
          rerun them. Renaming the column keeps its <span className="font-mono">{"{{variable}}"}</span> reference stable.
        </div>
      ) : null}
    </ModalShell>
  );
}

/* ── Email review (QA) inspection ─────────────────────────────────────── */

export function EmailQaDialog({
  leadName,
  loading,
  details,
  onClose,
}: {
  leadName: string;
  loading: boolean;
  details: EmailQaDetails | null;
  onClose: () => void;
}) {
  const ready = details?.verdict === "ready";
  return (
    <ModalShell
      title={`Email review · ${leadName}`}
      description={details?.campaignName ? `Against "${details.campaignName}", exactly as it will send.` : "The 3 emails filled in, every variable, and any issues."}
      widthClass="max-w-3xl"
      onClose={onClose}
      footer={
        <>
          <span className="flex-1" />
          <button type="button" onClick={onClose} className={`${BTN_OUTLINE} h-8 px-3 text-[12px]`}>Close</button>
        </>
      }
    >
      {loading ? (
        <div className="flex items-center gap-2 py-8 text-[12px] text-muted-foreground">
          <Loader2 className="size-4 animate-spin" /> Loading the review...
        </div>
      ) : !details ? (
        <p className="py-8 text-[12px] text-muted-foreground">No review yet. Run the email review for this lead first.</p>
      ) : (
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-1">
            <div className="flex items-center gap-2">
              <Pill tone={details.reviewed === false ? "muted" : ready ? "success" : "warning"} label={details.reviewed === false ? "Not reviewed yet" : ready ? "Ready to send" : "Needs review"} />
              {details.repairs.length > 0 ? (
                <span className="text-[11px] text-muted-foreground">
                  {details.repairs.filter((r) => r.accepted).length}/{details.repairs.length} variables auto-repaired
                </span>
              ) : null}
            </div>
            <p className="text-[11px] leading-4 text-muted-foreground">
              The emails below reflect the campaign&apos;s current copy. The verdict is from the last review; re-run the
              column after changing copy.
            </p>
          </div>

          {details.issues.length > 0 ? (
            <div className="rounded-md border border-destructive/40 bg-destructive-soft/40 px-3 py-2">
              <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-destructive">Issues</p>
              <ul className="list-disc space-y-0.5 pl-4 text-[12px] text-foreground">
                {details.issues.map((issue, i) => <li key={i}>{issue}</li>)}
              </ul>
            </div>
          ) : null}

          <div className="flex flex-col gap-3">
            <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">The 3 emails, filled in</p>
            {details.emails.map((email) => (
              <div key={email.step} className="rounded-md border border-border bg-surface">
                <div className="border-b border-border px-3 py-1.5 text-[11px]">
                  <span className="font-semibold text-foreground">Email {email.step}</span>
                  <span className="ml-2 text-muted-foreground">{email.subject || "(no subject line)"}</span>
                </div>
                <pre className="max-h-64 overflow-auto whitespace-pre-wrap px-3 py-2 font-sans text-[12px] leading-5 text-foreground">{email.body}</pre>
              </div>
            ))}
          </div>

          <div className="flex flex-col gap-1.5">
            <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Variables (check for hallucinations)</p>
            <div className="overflow-x-auto rounded-md border border-border">
              <table className="w-full text-left text-[12px]">
                <thead className="bg-muted/40 text-[10px] uppercase tracking-wide text-muted-foreground">
                  <tr>
                    <th className="px-2.5 py-1.5 font-semibold">Variable</th>
                    <th className="px-2.5 py-1.5 font-semibold">Value</th>
                  </tr>
                </thead>
                <tbody>
                  {details.variables.map((v) => (
                    <tr key={v.name} className="border-t border-border align-top">
                      <td className="whitespace-nowrap px-2.5 py-1.5 font-mono text-[11px] text-muted-foreground">{v.name}</td>
                      <td className={`px-2.5 py-1.5 ${v.filled ? "text-foreground" : "text-destructive"}`}>{v.filled ? v.value : "(blank)"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {details.context ? (
            <div className="flex flex-col gap-1.5">
              <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Original fields (source of truth)</p>
              <div className="grid grid-cols-1 gap-x-4 gap-y-1 rounded-md border border-border bg-muted/20 px-3 py-2 text-[12px] sm:grid-cols-2">
                <QaField label="Company (normalized)" value={details.context.finalCompanyName || "(missing - falls back to raw)"} />
                <QaField label="Company (raw)" value={details.context.companyRaw} />
                <QaField label="First name" value={details.context.finalFirstName || details.context.firstNameRaw} />
                <QaField label="Title" value={`${details.context.title}${details.context.roleLevel ? ` (${details.context.roleLevel})` : ""}`} />
                <QaField label="LinkedIn headline" value={details.context.linkedinHeadline} />
                <QaField label="Makes" value={details.context.companyWhatTheyMake} />
                <QaField label="Markets" value={details.context.companyMarkets} />
                <QaField label="Research summary" value={details.context.companySummary} />
              </div>
            </div>
          ) : null}

          {details.repairs.length > 0 ? (
            <div className="flex flex-col gap-1.5">
              <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Auto-repairs</p>
              <ul className="space-y-1 text-[12px]">
                {details.repairs.map((r, i) => (
                  <li key={i} className="rounded-md border border-border px-2.5 py-1.5">
                    <span className="font-mono text-[11px] text-muted-foreground">{r.name}</span>{" "}
                    <span className={r.accepted ? "text-success" : "text-destructive"}>{r.accepted ? "fixed" : "still flagged"}</span>
                    <div className="mt-0.5 text-muted-foreground">Was: {r.from || "(blank)"}</div>
                    <div className="text-foreground">Now: {r.to ?? "(could not regenerate)"}</div>
                    {r.note ? <div className="mt-0.5 text-[11px] text-muted-foreground">{r.note}</div> : null}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      )}
    </ModalShell>
  );
}

function QaField({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <span className="text-muted-foreground">{label}: </span>
      <span className="text-foreground">{value || "(none)"}</span>
    </div>
  );
}

/* ── Campaign tag picker (per-list Smartlead campaign) ────────────────── */

function campaignStatusTone(status: string | null): PillTone {
  const normalized = status?.toUpperCase() ?? "";
  if (normalized === "ACTIVE" || normalized === "COMPLETED") return "success";
  if (normalized === "PAUSED") return "warning";
  return "muted";
}

export function CampaignTagDialog({
  campaigns,
  smartleadError,
  current,
  caption,
  pending,
  onSave,
  onRemove,
  onClose,
}: {
  campaigns: SmartleadCampaignOption[];
  smartleadError: boolean;
  current: CampaignTag | null;
  caption?: string;
  pending: boolean;
  onSave: (tag: CampaignTag) => void;
  /* Removing the tag lives HERE rather than as an X on the chip. Untagging a
     list stops every export from it, and the chip used to sit in the filter row
     beside "Clear filters" - one destructive config change and one harmless
     view reset, a pixel apart. Given only when there is a table-level tag to
     remove: an inherited one is cleared on whatever set it. */
  onRemove?: () => void;
  onClose: () => void;
}) {
  const [selectedId, setSelectedId] = useState(current?.id ?? "");
  const [removeArmed, setRemoveArmed] = useState(false);
  const [query, setQuery] = useState("");
  const searchable = campaigns.length > 6;
  const trimmedQuery = query.trim().toLowerCase();
  const visible = trimmedQuery
    ? campaigns.filter((campaign) => campaign.name.toLowerCase().includes(trimmedQuery))
    : campaigns;
  const selected = campaigns.find((campaign) => campaign.id === selectedId) ?? null;

  return (
    <ModalShell
      title="Tag campaign"
      description={caption ?? "Every export from this list goes to the tagged Smartlead campaign."}
      onClose={onClose}
      closeDisabled={pending}
      footer={
        <>
          {onRemove ? (
            removeArmed ? (
              <button
                type="button"
                disabled={pending}
                onClick={onRemove}
                className={`mr-auto h-8 rounded-md bg-destructive-soft px-3 text-[12px] font-medium text-destructive transition-colors disabled:opacity-50`}
              >
                {pending ? <Loader2 className="size-3.5 animate-spin" /> : "Remove tag — exports stop"}
              </button>
            ) : (
              <button
                type="button"
                disabled={pending}
                onClick={() => setRemoveArmed(true)}
                className={`mr-auto h-8 rounded-md px-3 text-[12px] font-medium text-destructive transition-colors hover:bg-destructive-soft disabled:opacity-50`}
              >
                Remove tag
              </button>
            )
          ) : null}
          <button type="button" disabled={pending} onClick={onClose} className={`${BTN_OUTLINE} h-8 px-3 text-[12px]`}>
            Cancel
          </button>
          <button
            type="button"
            disabled={pending || !selected || (selected.id === current?.id && (current?.source ?? "table") === "table")}
            onClick={() => {
              if (selected) onSave({ id: selected.id, name: selected.name });
            }}
            className={`${BTN_PRIMARY} h-8 px-3 text-[12px]`}
          >
            {pending ? <Loader2 className="size-3.5 animate-spin" /> : null}
            {pending ? "Tagging..." : "Tag campaign"}
          </button>
        </>
      }
    >
      {searchable ? (
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search campaigns"
          aria-label="Search campaigns"
          className={INPUT_CLASS}
        />
      ) : null}
      {campaigns.length === 0 ? (
        <div className="rounded-md border border-border bg-muted/30 px-3 py-2 text-[11.5px] leading-4 text-muted-foreground">
          {smartleadError
            ? "The Smartlead campaign list could not be loaded. Check the API key under Settings, then reload this page."
            : "No Smartlead campaigns were found. Create one in Smartlead first, then reload this page."}
        </div>
      ) : visible.length === 0 ? (
        <div className="rounded-md border border-border bg-muted/30 px-3 py-2 text-[11.5px] text-muted-foreground">
          No campaigns match the search.
        </div>
      ) : (
        <div className="max-h-72 overflow-y-auto rounded-lg border border-border" role="radiogroup" aria-label="Smartlead campaign">
          <div className="divide-y divide-border">
            {visible.map((campaign) => {
              const isSelected = campaign.id === selectedId;
              return (
                <button
                  key={campaign.id}
                  type="button"
                  role="radio"
                  aria-checked={isSelected}
                  disabled={pending}
                  onClick={() => setSelectedId(campaign.id)}
                  className={`flex w-full items-center gap-2 px-3 py-2 text-left text-[12.5px] transition-colors hover:bg-muted/60 disabled:opacity-50 ${
                    isSelected ? "bg-muted/50" : ""
                  }`}
                >
                  <span className="min-w-0 flex-1 truncate font-medium" title={campaign.name}>
                    {campaign.name}
                  </span>
                  {campaign.status ? (
                    <Pill tone={campaignStatusTone(campaign.status)} label={campaign.status.toLowerCase()} />
                  ) : null}
                  {isSelected ? <CheckCircle2 className="size-3.5 shrink-0 text-primary" /> : null}
                </button>
              );
            })}
          </div>
        </div>
      )}
      <p className="text-[11px] leading-4 text-muted-foreground">
        Exports require a deliverable email and skip suppressed and already-exported leads.
      </p>
    </ModalShell>
  );
}

/* ── Smartlead export settings (campaign + variable mapping) ──────────────── */

type ExportVariableRow =
  | { name: string; kind: "auto"; source: string }
  | { name: string; kind: "custom"; columnId: string | null; suggestedColumnId: string | null };
type ExportColumnOption = { id: string; key: string; label: string };
type ExportMappingView = {
  campaign: { id: string; name: string } | null;
  campaignError: string | null;
  variables: ExportVariableRow[];
  columns: ExportColumnOption[];
};

/* The gear on the Smartlead export column. Tags the campaign this list exports to
   AND maps each of the campaign's {{variables}} to the column that fills it, so
   the right value lands in the right merge tag. Native tags (first_name,
   company_name, day of week) are shown as auto-filled; the rest are mappable. */
export function ExportSettingsDialog({
  tableId,
  campaigns,
  smartleadError,
  currentTag,
  tagPending,
  onTagCampaign,
  onClose,
}: {
  tableId: string;
  campaigns: SmartleadCampaignOption[];
  smartleadError: boolean;
  currentTag: CampaignTag | null;
  tagPending: boolean;
  onTagCampaign: (tag: CampaignTag) => Promise<void> | void;
  onClose: () => void;
}) {
  const [view, setView] = useState<ExportMappingView | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [savedMsg, setSavedMsg] = useState<string | null>(null);
  const [picking, setPicking] = useState(!currentTag);
  const [query, setQuery] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const res = await getExportMappingViewAction(tableId);
    if (!res.ok) {
      setError(res.message || "Could not load export settings.");
      setView(null);
      setLoading(false);
      return;
    }
    const next = res.view as ExportMappingView;
    setView(next);
    const seeded: Record<string, string> = {};
    for (const v of next.variables) if (v.kind === "custom") seeded[v.name] = v.columnId ?? v.suggestedColumnId ?? "";
    setDraft(seeded);
    setLoading(false);
  }, [tableId]);

  useEffect(() => {
    void load();
  }, [load]);

  const busy = saving || tagPending;
  const selectCampaign = async (tag: CampaignTag) => {
    setPicking(false);
    setSavedMsg(null);
    await onTagCampaign(tag);
    await load();
  };

  const save = async () => {
    if (!view) return;
    setSaving(true);
    setError(null);
    setSavedMsg(null);
    const entries = view.variables
      .filter((v): v is Extract<ExportVariableRow, { kind: "custom" }> => v.kind === "custom")
      .map((v) => ({ targetKey: v.name, columnId: draft[v.name] || null }));
    const res = await saveExportMappingsAction(tableId, entries);
    setSaving(false);
    if (!res.ok) {
      setError(res.message || "Could not save the mappings.");
      return;
    }
    setSavedMsg("Mappings saved.");
    await load();
  };

  const trimmedQuery = query.trim().toLowerCase();
  const searchable = campaigns.length > 6;
  const visibleCampaigns = trimmedQuery ? campaigns.filter((c) => c.name.toLowerCase().includes(trimmedQuery)) : campaigns;
  const customVars = view ? view.variables.filter((v): v is Extract<ExportVariableRow, { kind: "custom" }> => v.kind === "custom") : [];
  const autoVars = view ? view.variables.filter((v): v is Extract<ExportVariableRow, { kind: "auto" }> => v.kind === "auto") : [];

  return (
    <ModalShell
      title="Smartlead export"
      description="Set the campaign this list exports to, and map each campaign variable to the column that fills it."
      onClose={onClose}
      closeDisabled={busy}
      widthClass="max-w-xl"
      footer={
        <>
          {savedMsg ? <span className="mr-auto text-[11px] text-muted-foreground">{savedMsg}</span> : null}
          <button type="button" disabled={busy} onClick={onClose} className={`${BTN_OUTLINE} h-8 px-3 text-[12px]`}>
            Done
          </button>
          <button
            type="button"
            disabled={busy || !view || !currentTag || customVars.length === 0}
            onClick={() => void save()}
            className={`${BTN_PRIMARY} h-8 px-3 text-[12px]`}
          >
            {saving ? <Loader2 className="size-3.5 animate-spin" /> : null}
            {saving ? "Saving..." : "Save mappings"}
          </button>
        </>
      }
    >
      {/* Campaign */}
      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Campaign</span>
          {currentTag && !picking ? (
            <button
              type="button"
              disabled={busy}
              onClick={() => setPicking(true)}
              className={`text-[11.5px] font-medium text-primary hover:underline disabled:opacity-50 rounded`}
            >
              Change
            </button>
          ) : null}
        </div>
        {currentTag && !picking ? (
          <div className="flex items-center gap-2 rounded-lg border border-border bg-muted/30 px-3 py-2">
            <CheckCircle2 className="size-3.5 shrink-0 text-primary" />
            <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium" title={currentTag.name}>
              {currentTag.name}
            </span>
            {currentTag.source && currentTag.source !== "table" ? (
              <span className="text-[10px] text-muted-foreground">via {currentTag.source}</span>
            ) : null}
          </div>
        ) : (
          <>
            {searchable ? (
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search campaigns"
                aria-label="Search campaigns"
                className={INPUT_CLASS}
              />
            ) : null}
            {campaigns.length === 0 ? (
              <div className="rounded-md border border-border bg-muted/30 px-3 py-2 text-[11.5px] leading-4 text-muted-foreground">
                {smartleadError
                  ? "The Smartlead campaign list could not be loaded. Check the API key under Settings, then reload this page."
                  : "No Smartlead campaigns were found. Create one in Smartlead first, then reload this page."}
              </div>
            ) : visibleCampaigns.length === 0 ? (
              <div className="rounded-md border border-border bg-muted/30 px-3 py-2 text-[11.5px] text-muted-foreground">
                No campaigns match the search.
              </div>
            ) : (
              <div className="max-h-56 overflow-y-auto rounded-lg border border-border" role="radiogroup" aria-label="Smartlead campaign">
                <div className="divide-y divide-border">
                  {visibleCampaigns.map((campaign) => {
                    const isSelected = campaign.id === currentTag?.id;
                    return (
                      <button
                        key={campaign.id}
                        type="button"
                        role="radio"
                        aria-checked={isSelected}
                        disabled={busy}
                        onClick={() => void selectCampaign({ id: campaign.id, name: campaign.name })}
                        className={`flex w-full items-center gap-2 px-3 py-2 text-left text-[12.5px] transition-colors hover:bg-muted/60 disabled:opacity-50 ${
                          isSelected ? "bg-muted/50" : ""
                        }`}
                      >
                        <span className="min-w-0 flex-1 truncate font-medium" title={campaign.name}>
                          {campaign.name}
                        </span>
                        {campaign.status ? <Pill tone={campaignStatusTone(campaign.status)} label={campaign.status.toLowerCase()} /> : null}
                        {isSelected ? <CheckCircle2 className="size-3.5 shrink-0 text-primary" /> : null}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
          </>
        )}
      </div>

      {/* Variables */}
      <div className="flex flex-col gap-2">
        <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Variables</span>
        {!currentTag ? (
          <p className="text-[11.5px] leading-4 text-muted-foreground">Tag a campaign above to map its variables.</p>
        ) : loading ? (
          <div className="flex items-center gap-2 px-1 py-2 text-[11.5px] text-muted-foreground">
            <Loader2 className="size-3.5 animate-spin" /> Loading variables...
          </div>
        ) : error && !view ? (
          <div className="flex items-start gap-2 rounded-md border border-border bg-destructive/5 px-3 py-2 text-[11.5px] text-destructive">
            <AlertTriangle className="mt-px size-3.5 shrink-0" /> {error}
          </div>
        ) : view?.campaignError ? (
          <div className="flex items-start gap-2 rounded-md border border-border bg-muted/30 px-3 py-2 text-[11.5px] text-muted-foreground">
            <AlertTriangle className="mt-px size-3.5 shrink-0" /> The campaign sequence could not be read: {view.campaignError}
          </div>
        ) : view && customVars.length === 0 && autoVars.length === 0 ? (
          <p className="text-[11.5px] leading-4 text-muted-foreground">This campaign&apos;s emails use no variables.</p>
        ) : (
          <div className="flex flex-col gap-3">
            {view && customVars.length === 0 ? (
              <p className="text-[11.5px] leading-4 text-muted-foreground">This campaign uses only auto-filled variables. Nothing to map.</p>
            ) : null}
            {customVars.length > 0 && view && view.columns.length === 0 ? (
              <div className="flex items-start gap-2 rounded-md border border-border bg-muted/30 px-3 py-2 text-[11.5px] text-muted-foreground">
                <AlertTriangle className="mt-px size-3.5 shrink-0" /> This list has no AI or source columns to map these variables to. Add columns first.
              </div>
            ) : null}
            {customVars.map((v) => {
              const value = draft[v.name] ?? "";
              const isSuggested = !v.columnId && Boolean(v.suggestedColumnId) && value === v.suggestedColumnId;
              return (
                <div key={v.name} className="flex items-center gap-2">
                  <code className="w-40 shrink-0 truncate rounded bg-muted/60 px-1.5 py-1 font-mono text-[11px] text-foreground" title={`{{${v.name}}}`}>
                    {`{{${v.name}}}`}
                  </code>
                  <div className="relative min-w-0 flex-1">
                    <select
                      value={value}
                      disabled={busy || !view || view.columns.length === 0}
                      onChange={(event) => {
                        setSavedMsg(null);
                        setDraft((d) => ({ ...d, [v.name]: event.target.value }));
                      }}
                      className={SETTINGS_SELECT_CLASS}
                      aria-label={`Column for ${v.name}`}
                    >
                      <option value="">Not mapped (sends blank)</option>
                      {view?.columns.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.label}
                        </option>
                      ))}
                    </select>
                    <ChevronDown className="pointer-events-none absolute right-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
                  </div>
                  {!value ? (
                    <span className="flex shrink-0 items-center gap-1 text-[10px] text-amber-600" title="No column mapped; this variable sends blank.">
                      <AlertTriangle className="size-3" /> blank
                    </span>
                  ) : isSuggested ? (
                    <span className="shrink-0 text-[10px] text-muted-foreground" title="Auto-matched by name. Save to keep it.">
                      suggested
                    </span>
                  ) : (
                    <span className="w-10 shrink-0" />
                  )}
                </div>
              );
            })}
            {autoVars.length > 0 ? (
              <div className="flex flex-col gap-1 rounded-lg border border-border bg-muted/20 px-3 py-2">
                <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">Filled automatically</span>
                {autoVars.map((v) => (
                  <div key={v.name} className="flex items-center gap-2 text-[11.5px]">
                    <code className="font-mono text-[11px] text-muted-foreground">{`{{${v.name}}}`}</code>
                    <span className="text-muted-foreground">— {v.source}</span>
                  </div>
                ))}
              </div>
            ) : null}
            {error && view ? (
              <div className="flex items-start gap-2 rounded-md border border-border bg-destructive/5 px-3 py-2 text-[11.5px] text-destructive">
                <AlertTriangle className="mt-px size-3.5 shrink-0" /> {error}
              </div>
            ) : null}
          </div>
        )}
      </div>
    </ModalShell>
  );
}

/* ── New table ────────────────────────────────────────────────────────── */

export function NewTableDialog({
  hasActiveFilters,
  pending,
  onCreate,
  onClose,
}: {
  hasActiveFilters: boolean;
  pending: boolean;
  onCreate: (name: string, description: string, snapshotFilters: boolean) => void;
  onClose: () => void;
}) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [snapshotFilters, setSnapshotFilters] = useState(false);
  const canSubmit = Boolean(name.trim()) && !pending;

  return (
    <ModalShell
      title="New table"
      description="Adds a list to this workbook. Every list works over the same lead pool."
      onClose={onClose}
      closeDisabled={pending}
      footer={
        <>
          <button type="button" disabled={pending} onClick={onClose} className={`${BTN_OUTLINE} h-8 px-3 text-[12px]`}>
            Cancel
          </button>
          <button
            type="button"
            disabled={!canSubmit}
            onClick={() => onCreate(name.trim(), description.trim(), snapshotFilters)}
            className={`${BTN_PRIMARY} h-8 px-3 text-[12px]`}
          >
            {pending ? <Loader2 className="size-3.5 animate-spin" /> : null}
            {pending ? "Creating..." : "Create table"}
          </button>
        </>
      }
    >
      <div className="flex flex-col gap-1.5">
        <label
          htmlFor="enrichment-new-table-name"
          className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground"
        >
          Name
        </label>
        <input
          id="enrichment-new-table-name"
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="Wave 2 send list"
          maxLength={80}
          disabled={pending}
          className={INPUT_CLASS}
          onKeyDown={(event) => {
            if (event.key === "Enter" && canSubmit) onCreate(name.trim(), description.trim(), snapshotFilters);
          }}
        />
      </div>
      <div className="flex flex-col gap-1.5">
        <label
          htmlFor="enrichment-new-table-description"
          className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground"
        >
          Description (optional)
        </label>
        <input
          id="enrichment-new-table-description"
          value={description}
          onChange={(event) => setDescription(event.target.value)}
          placeholder="What this list is for"
          maxLength={300}
          disabled={pending}
          className={INPUT_CLASS}
        />
      </div>
      <label className="flex cursor-pointer items-start gap-2 text-[12px]">
        <input
          type="checkbox"
          checked={snapshotFilters}
          disabled={pending || !hasActiveFilters}
          onChange={(event) => setSnapshotFilters(event.target.checked)}
          className={`mt-0.5 size-3.5 shrink-0 accent-[var(--primary)]`}
        />
        <span className={hasActiveFilters ? "" : "text-muted-foreground"}>
          Start from current filters
          <span className="block text-[11px] leading-4 text-muted-foreground">
            {hasActiveFilters
              ? "Snapshots the toolbar filters into the new list's base filter."
              : "No toolbar filters are active right now."}
          </span>
        </span>
      </label>
    </ModalShell>
  );
}

/* ── Rename table ─────────────────────────────────────────────────────── */

export function RenameTableDialog({
  initialName,
  pending,
  onSave,
  onClose,
}: {
  initialName: string;
  pending: boolean;
  onSave: (name: string) => void;
  onClose: () => void;
}) {
  const [name, setName] = useState(initialName);
  const canSubmit = Boolean(name.trim()) && name.trim() !== initialName && !pending;

  return (
    <ModalShell
      title="Rename table"
      description="The tab keeps its link; only the display name changes."
      widthClass="max-w-sm"
      onClose={onClose}
      closeDisabled={pending}
      footer={
        <>
          <button type="button" disabled={pending} onClick={onClose} className={`${BTN_OUTLINE} h-8 px-3 text-[12px]`}>
            Cancel
          </button>
          <button
            type="button"
            disabled={!canSubmit}
            onClick={() => onSave(name.trim())}
            className={`${BTN_PRIMARY} h-8 px-3 text-[12px]`}
          >
            {pending ? <Loader2 className="size-3.5 animate-spin" /> : null}
            {pending ? "Renaming..." : "Rename"}
          </button>
        </>
      }
    >
      <div className="flex flex-col gap-1.5">
        <label
          htmlFor="enrichment-rename-table"
          className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground"
        >
          Name
        </label>
        <input
          id="enrichment-rename-table"
          value={name}
          onChange={(event) => setName(event.target.value)}
          maxLength={80}
          disabled={pending}
          className={INPUT_CLASS}
          onKeyDown={(event) => {
            if (event.key === "Enter" && canSubmit) onSave(name.trim());
          }}
        />
      </div>
    </ModalShell>
  );
}

/* ── Move table to another workbook ───────────────────────────────────── */

export function MoveToWorkbookDialog({
  currentWorkbookId,
  tableName,
  pending,
  onMove,
  onClose,
}: {
  currentWorkbookId: string;
  tableName: string;
  pending: boolean;
  onMove: (workbook: WorkbookOption) => void;
  onClose: () => void;
}) {
  const [workbooks, setWorkbooks] = useState<WorkbookOption[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState("");

  // The workbook tree is fetched lazily, only when this dialog opens.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const result = await getWorkspaceTreeAction();
        if (cancelled) return;
        if (result.ok && "tree" in result && result.tree) {
          setWorkbooks(
            result.tree.workbooks
              .filter((workbook) => workbook.id !== currentWorkbookId)
              .map((workbook) => ({ id: workbook.id, slug: workbook.slug, name: workbook.name })),
          );
        } else {
          setWorkbooks([]);
          setLoadError(result.message || "Could not load workbooks.");
        }
      } catch {
        if (cancelled) return;
        setWorkbooks([]);
        setLoadError("Could not load workbooks.");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [currentWorkbookId]);

  const selected = workbooks?.find((workbook) => workbook.id === selectedId) ?? null;

  return (
    <ModalShell
      title="Move to workbook"
      description={`Moves "${tableName}" with its saved views and export history.`}
      widthClass="max-w-sm"
      onClose={onClose}
      closeDisabled={pending}
      footer={
        <>
          <button type="button" disabled={pending} onClick={onClose} className={`${BTN_OUTLINE} h-8 px-3 text-[12px]`}>
            Cancel
          </button>
          <button
            type="button"
            disabled={pending || !selected}
            onClick={() => {
              if (selected) onMove(selected);
            }}
            className={`${BTN_PRIMARY} h-8 px-3 text-[12px]`}
          >
            {pending ? <Loader2 className="size-3.5 animate-spin" /> : null}
            {pending ? "Moving..." : "Move table"}
          </button>
        </>
      }
    >
      {workbooks === null ? (
        <div className="flex items-center gap-2 rounded-md border border-border bg-muted/30 p-3 text-[12.5px] text-muted-foreground">
          <Loader2 className="size-4 animate-spin" />
          Loading workbooks...
        </div>
      ) : workbooks.length === 0 ? (
        <div className="rounded-md border border-border bg-muted/30 px-3 py-2 text-[11.5px] leading-4 text-muted-foreground">
          {loadError ?? "There is no other workbook to move this table into."}
        </div>
      ) : (
        <div className="max-h-64 overflow-y-auto rounded-lg border border-border" role="radiogroup" aria-label="Target workbook">
          <div className="divide-y divide-border">
            {workbooks.map((workbook) => {
              const isSelected = workbook.id === selectedId;
              return (
                <button
                  key={workbook.id}
                  type="button"
                  role="radio"
                  aria-checked={isSelected}
                  disabled={pending}
                  onClick={() => setSelectedId(workbook.id)}
                  className={`flex w-full items-center gap-2 px-3 py-2 text-left text-[12.5px] transition-colors hover:bg-muted/60 disabled:opacity-50 ${
                    isSelected ? "bg-muted/50" : ""
                  }`}
                >
                  <span className="min-w-0 flex-1 truncate font-medium" title={workbook.name}>
                    {workbook.name}
                  </span>
                  {isSelected ? <CheckCircle2 className="size-3.5 shrink-0 text-primary" /> : null}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </ModalShell>
  );
}

/* ── Save view ────────────────────────────────────────────────────────── */

export function SaveViewDialog({
  pending,
  onSave,
  onClose,
}: {
  pending: boolean;
  onSave: (name: string) => void;
  onClose: () => void;
}) {
  const [name, setName] = useState("");

  return (
    <ModalShell
      title="Save view"
      description="Saves the current search, filters, and sort as a reusable view."
      widthClass="max-w-sm"
      onClose={onClose}
      closeDisabled={pending}
      footer={
        <>
          <button type="button" disabled={pending} onClick={onClose} className={`${BTN_OUTLINE} h-8 px-3 text-[12px]`}>
            Cancel
          </button>
          <button
            type="button"
            disabled={pending || !name.trim()}
            onClick={() => onSave(name)}
            className={`${BTN_PRIMARY} h-8 px-3 text-[12px]`}
          >
            {pending ? "Saving..." : "Save view"}
          </button>
        </>
      }
    >
      <div className="flex flex-col gap-1.5">
        <label
          htmlFor="enrichment-view-name"
          className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground"
        >
          View name
        </label>
        <input
          id="enrichment-view-name"
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="Wave 1 · US · Ready"
          maxLength={120}
          className={INPUT_CLASS}
          onKeyDown={(event) => {
            if (event.key === "Enter" && name.trim() && !pending) onSave(name);
          }}
        />
        <p className="text-[11px] text-muted-foreground">Saving with an existing name replaces that view.</p>
      </div>
    </ModalShell>
  );
}

/* ── Bulk run confirmation ────────────────────────────────────────────── */

export type BulkPrompt = {
  action: RunnableAction;
  mode: RunMode;
  ids: string[];
  provider: ProviderClass;
  concurrency: number;
};

const MODE_EXPLANATIONS: Record<RunMode, string> = {
  test10: "Runs at most 10 candidate rows so the output can be checked before a full run.",
  unrun: "Rows that already have results are skipped, so nothing is charged twice.",
  outdated:
    "Re-runs populated cells generated before this column's prompt last changed. Cells generated with the current prompt are skipped.",
  force: "Force run re-processes every eligible row even if it already has a result. This spends credits again.",
  count: "Runs a set number of rows starting at a chosen row in the current view, so a big list can be enriched in measured batches.",
};

export function BulkConfirmDialog({
  prompt,
  onCancel,
  onStart,
}: {
  prompt: BulkPrompt;
  onCancel: () => void;
  onStart: () => void;
}) {
  return (
    <ModalShell
      title={`Run column · ${ACTION_LABELS[prompt.action]}`}
      description={RUN_MODE_LABELS[prompt.mode]}
      widthClass="max-w-md"
      onClose={onCancel}
      footer={
        <>
          <button type="button" onClick={onCancel} className={`${BTN_OUTLINE} h-8 px-3 text-[12px]`}>
            Cancel
          </button>
          <button
            type="button"
            disabled={prompt.ids.length === 0}
            onClick={onStart}
            className={`${BTN_PRIMARY} h-8 px-3 text-[12px]`}
          >
            {prompt.ids.length === 0 ? "Nothing to run" : "Start run"}
          </button>
        </>
      }
    >
      <div className="space-y-2 text-[12.5px]">
        <div className="flex items-center justify-between gap-2">
          <span className="text-muted-foreground">Rows to run</span>
          <span className="font-medium tabular-nums">{prompt.ids.length.toLocaleString("en-US")}</span>
        </div>
        <div className="flex items-center justify-between gap-2">
          <span className="text-muted-foreground">Provider</span>
          <Pill tone="muted" label={prompt.provider} />
        </div>
        <div className="flex items-center justify-between gap-2">
          <span className="text-muted-foreground">Concurrency</span>
          <span className="tabular-nums">{prompt.concurrency} parallel</span>
        </div>
      </div>
      <p className="text-[11px] leading-4 text-muted-foreground">
        {MODE_EXPLANATIONS[prompt.mode]} Candidates are selected by run mode across the whole table, not just the
        current view. If the provider reports rate limiting, the run pauses briefly and resumes on its own.
      </p>
    </ModalShell>
  );
}

/* ── Column run menu items (shared between menu render sites) ─────────── */

export function runModesFor(action: RunnableAction): RunMode[] {
  return isAiPromptColumn(action) ? ["test10", "unrun", "outdated", "force"] : ["test10", "unrun", "force"];
}
