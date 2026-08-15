"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { BindCampaignModal } from "./automations-client";
import {
  Archive,
  ArrowLeft,
  ArrowUpRight,
  Building2,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  Globe,
  Loader2,
  Mail,
  Pause,
  Pencil,
  Play,
  Plus,
  Radar,
  RefreshCw,
  Search as SearchIcon,
  Send,
  Settings2,
  ShieldAlert,
  Square,
  Star,
  Trash2,
  Undo2,
  X,
  Zap,
} from "lucide-react";
import {
  SEARCH_ARRANGEMENT_OPTIONS,
  SEARCH_EMPLOYMENT_OPTIONS,
  SEARCH_EXPERIENCE_OPTIONS,
  SEARCH_POSTED_OPTIONS,
} from "@/lib/signals/options";
import {
  FUNNEL_STAGES,
  FUNNEL_STAGE_LABELS,
  type CompaniesFilter,
  type CompaniesPage,
  type CompanyPick,
  type CompanyDetail,
  type CompanyResultRow,
  type FunnelConfig,
  type FunnelConfigVersion,
  type FunnelCounts,
  type FunnelRunDto,
  type AutomationDto,
  type FunnelStage,
  type SignalContactDto,
  type SignalSearchDto,
  type SignalSearchInput,
  type StageResultDto,
} from "@/lib/signals/types";
import {
  archiveSearchAction,
  controlFunnelAction,
  findContactEmailAction,
  getCompaniesAction,
  getCompanyDetailAction,
  pollContactsAction,
  pushLeadListAction,
  updateAutomationAction,
  reevaluateAction,
  researchCompanyAction,
  resourceContactsAction,
  runFunnelAction,
  saveConfigAction,
  saveSearchAction,
  setContactPickAction,
  setOverrideAction,
  setReviewAction,
  tickFunnelAction,
} from "./actions";
import { useToast } from "../toast";

/* ── Shared idioms (app-wide button/input/badge grammar) ──────────────── */

const BTN_BASE =
  "inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-md font-medium transition disabled:cursor-not-allowed disabled:opacity-50";
const BTN_PRIMARY = `${BTN_BASE} bg-primary text-primary-foreground shadow-xs hover:opacity-90`;
const BTN_OUTLINE = `${BTN_BASE} border border-border bg-surface text-foreground shadow-xs hover:border-border-strong hover:bg-muted/60`;
const BTN_GHOST = `${BTN_BASE} bg-transparent text-muted-foreground hover:bg-muted/70 hover:text-foreground`;

const SELECT_CLASS =
  "h-7 appearance-none rounded-md border border-border bg-surface pl-2 pr-6 text-[11.5px] font-medium text-foreground shadow-xs outline-none transition focus:border-ring disabled:cursor-not-allowed disabled:opacity-60";
const INPUT_CLASS =
  "h-7 w-full rounded-md border border-border bg-surface px-2 text-[11.5px] outline-none transition placeholder:text-muted-foreground focus:border-ring";
const TEXTAREA_CLASS =
  "w-full rounded-md border border-border bg-surface px-2 py-1.5 text-[12px] leading-relaxed outline-none transition placeholder:text-muted-foreground focus:border-ring";

type BadgeVariant = "outline" | "success" | "info" | "warning" | "ghost" | "destructive";
const BADGE_VARIANT: Record<BadgeVariant, string> = {
  outline: "border border-border bg-surface font-normal text-foreground",
  success: "bg-success-soft text-success",
  info: "bg-info-soft text-info",
  warning: "bg-warning-soft text-warning",
  ghost: "bg-muted text-muted-foreground",
  destructive: "bg-destructive-soft text-destructive",
};

function Badge({ variant, children, className = "" }: { variant: BadgeVariant; children: React.ReactNode; className?: string }) {
  return (
    <span className={`inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2 text-[11px] font-medium leading-5 tracking-tight ${BADGE_VARIANT[variant]} ${className}`}>
      {children}
    </span>
  );
}

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

function useDrawerChrome(requestClose: () => void) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") requestClose();
    };
    window.addEventListener("keydown", onKey);
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = previous;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}

// killed_stage can also be the pseudo-stage "override".
function stageLabel(stage: FunnelStage | "override" | null): string {
  if (!stage) return "funnel";
  if (stage === "override") return "Operator override";
  return FUNNEL_STAGE_LABELS[stage] ?? stage;
}

function CompanyLogo({ src, name, sizeClass }: { src: string | null; name: string; sizeClass: string }) {
  const [broken, setBroken] = useState(false);
  if (src && !broken) {
    return (
      // eslint-disable-next-line @next/next/no-img-element -- external CDN logo with graceful fallback
      <img src={src} alt="" onError={() => setBroken(true)} className={`${sizeClass} shrink-0 rounded-md border border-border bg-surface object-contain`} />
    );
  }
  return (
    <span className={`${sizeClass} flex shrink-0 items-center justify-center rounded-md bg-muted text-[11px] font-semibold uppercase text-muted-foreground`}>
      {name.trim().charAt(0) || "?"}
    </span>
  );
}

/* ── Minimal markdown for research briefs ─────────────────────────────── */

function boldSpans(text: string, keyBase: string) {
  const parts = text.split("**");
  return parts.map((part, index) =>
    index % 2 === 1 ? (
      <strong key={`${keyBase}-${index}`} className="font-semibold text-foreground">{part}</strong>
    ) : (
      <span key={`${keyBase}-${index}`}>{part}</span>
    ),
  );
}

function MarkdownLite({ text }: { text: string }) {
  const blocks = useMemo(() => {
    const lines = text.split(/\r?\n/);
    const out: ({ kind: "h"; text: string } | { kind: "p"; text: string } | { kind: "ul"; items: string[] })[] = [];
    for (const raw of lines) {
      const line = raw.trim();
      if (!line) continue;
      const header = line.match(/^#{1,4}\s+(.*)$/);
      if (header) {
        out.push({ kind: "h", text: header[1] });
        continue;
      }
      const bullet = line.match(/^[-*]\s+(.*)$/);
      if (bullet) {
        const last = out[out.length - 1];
        if (last?.kind === "ul") last.items.push(bullet[1]);
        else out.push({ kind: "ul", items: [bullet[1]] });
        continue;
      }
      out.push({ kind: "p", text: line });
    }
    return out;
  }, [text]);
  return (
    <div className="flex flex-col gap-1.5">
      {blocks.map((block, index) => {
        if (block.kind === "h") {
          return (
            <h4 key={index} className="mt-2 text-[10.5px] font-semibold uppercase tracking-[0.08em] text-muted-foreground first:mt-0">{block.text}</h4>
          );
        }
        if (block.kind === "ul") {
          return (
            <ul key={index} className="flex list-disc flex-col gap-1 pl-4 text-[12px] leading-relaxed text-foreground">
              {block.items.map((item, itemIndex) => (
                <li key={itemIndex}>{boldSpans(item, `${index}-${itemIndex}`)}</li>
              ))}
            </ul>
          );
        }
        return (
          <p key={index} className="text-[12px] leading-relaxed text-foreground">{boldSpans(block.text, String(index))}</p>
        );
      })}
    </div>
  );
}

/* ── Tag input ────────────────────────────────────────────────────────── */

function TagInput({
  value,
  onChange,
  placeholder,
  disabled,
  ariaLabel,
}: {
  value: string[];
  onChange: (next: string[]) => void;
  placeholder: string;
  disabled: boolean;
  ariaLabel: string;
}) {
  const [draft, setDraft] = useState("");
  const commit = () => {
    const parts = draft
      .split(/[,;]/)
      .map((part) => part.trim())
      .filter(Boolean)
      .filter((part) => !value.some((existing) => existing.toLowerCase() === part.toLowerCase()));
    if (parts.length > 0) onChange([...value, ...parts]);
    setDraft("");
  };
  return (
    <div className={`flex min-h-[34px] flex-wrap items-center gap-1 rounded-md border border-border bg-surface px-1.5 py-1 transition focus-within:border-ring ${disabled ? "opacity-60" : ""}`}>
      {value.map((tag) => (
        <span key={tag} className="inline-flex items-center gap-1 rounded bg-muted px-1.5 py-0.5 text-[11px] font-medium text-foreground">
          {tag}
          <button type="button" aria-label={`Remove ${tag}`} disabled={disabled} onClick={() => onChange(value.filter((item) => item !== tag))} className="text-muted-foreground transition hover:text-foreground">
            <X className="size-3" />
          </button>
        </span>
      ))}
      <input
        value={draft}
        disabled={disabled}
        aria-label={ariaLabel}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === ",") {
            event.preventDefault();
            commit();
          } else if (event.key === "Backspace" && draft === "" && value.length > 0) {
            onChange(value.slice(0, -1));
          }
        }}
        onBlur={commit}
        placeholder={value.length === 0 ? placeholder : ""}
        className="h-6 min-w-24 flex-1 bg-transparent px-1 text-[11.5px] outline-none placeholder:text-muted-foreground"
      />
    </div>
  );
}

/* ── Score + verdict chrome ───────────────────────────────────────────── */

function ScoreChip({ score, threshold }: { score: number | null; threshold: number }) {
  if (score === null) return <span className="tabular w-9 text-right text-[11px] text-muted-foreground">—</span>;
  const cls = score >= threshold ? "bg-success-soft text-success" : score >= threshold - 20 ? "bg-warning-soft text-warning" : "bg-muted text-muted-foreground";
  return <span className={`tabular inline-flex h-6 w-9 items-center justify-center rounded-md text-[12px] font-semibold ${cls}`}>{score}</span>;
}

const FLAG_LABELS: { key: keyof CompanyResultRow["flags"]; label: string }[] = [
  { key: "crmOverlap", label: "Already in CRM" },
  { key: "estimateBased", label: "Headcount is an LLM estimate" },
  { key: "unknownIndustry", label: "Industry unknown" },
  { key: "updated", label: "Updated by new evidence" },
  { key: "newEvidence", label: "New evidence pending re-evaluation" },
];

function FlagDots({ flags }: { flags: CompanyResultRow["flags"] }) {
  const active = FLAG_LABELS.filter(({ key }) => flags[key] === true);
  if (active.length === 0) return null;
  return (
    <span className="flex shrink-0 items-center gap-1">
      {active.map(({ key, label }) => (
        <span key={key} data-tip={label} className="size-1.5 rounded-full bg-info" aria-label={label} />
      ))}
    </span>
  );
}

function headcountLabel(row: Pick<CompanyResultRow, "headcount" | "headcountSource" | "linkedinEmployeeCount">): string | null {
  if (row.headcount === null) {
    return row.linkedinEmployeeCount ? `${row.linkedinEmployeeCount} on LinkedIn` : null;
  }
  const size = `${row.headcountSource === "llm_estimate" ? "~" : ""}${row.headcount} ppl`;
  // Show the observation the estimate was built on — it is the hard number.
  return row.linkedinEmployeeCount ? `${size} · ${row.linkedinEmployeeCount} on LinkedIn` : size;
}

/* ── Last-run summary line ────────────────────────────────────────────── */

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

// The funnel shape, shown at the moment it matters: after a run. One line —
// what was scraped, where kills happened, what qualified, what it cost.
function LastRunLine({ run }: { run: FunnelRunDto; totalCompanies?: number }) {
  const kills = Object.entries(run.stats.stageKills ?? {})
    .filter(([, count]) => count > 0)
    .sort(([a], [b]) => FUNNEL_STAGES.indexOf(a as FunnelStage) - FUNNEL_STAGES.indexOf(b as FunnelStage))
    .map(([stage, count]) => `${count} at ${(FUNNEL_STAGE_LABELS[stage as FunnelStage] ?? stage).toLowerCase()}`)
    .join(", ");
  const scraped = run.stats.jobsFound !== undefined ? `${run.stats.jobsFound} jobs scraped (${run.stats.jobsNew ?? 0} new)` : null;
  const parts = [
    scraped,
    kills ? `killed ${kills}` : null,
    `${run.stats.qualified ?? 0} qualified`,
    `~${run.spendEstimateUsd.toFixed(2)}`,
  ].filter(Boolean);
  return (
    <p className="px-1 text-[11px] leading-relaxed text-muted-foreground">
      <span className="font-medium text-foreground">
        {run.status === "failed" ? "Last run failed" : "Last run"} {run.finishedAt ? timeAgo(run.finishedAt) : ""}
        {run.trigger === "reevaluate" ? " (re-evaluation)" : ""}:
      </span>{" "}
      {run.status === "failed" ? (run.error ?? "unknown failure") : parts.join(" · ")}
    </p>
  );
}

/* ── Company row ──────────────────────────────────────────────────────── */

/* The merged view's unit: one qualified company and the people we'll email
   at it. Header reads the decision (score, who they are, what they posted);
   the contacts underneath carry their own one-word status. */
function pickStatus(pick: CompanyPick): { label: string; variant: BadgeVariant } {
  if (pick.pushedAt) return { label: "Pushed", variant: "success" };
  if (pick.releaseBlockedReason) return { label: pick.releaseBlockedReason, variant: "ghost" };
  if (pick.emailStatus === "found") return { label: "Ready", variant: "success" };
  if (pick.emailStatus === "pending") return { label: "Finding email…", variant: "info" };
  return { label: "Needs email", variant: "warning" };
}

function CompanyGroup({
  row,
  threshold,
  busyContactId,
  onOpen,
  onFindEmail,
}: {
  row: CompanyResultRow;
  threshold: number;
  busyContactId: string | null;
  onOpen: () => void;
  onFindEmail: (contactId: string) => void;
}) {
  const sourcing = row.contactsState === "pending" || row.contactsState === "sourcing";
  return (
    <div className="overflow-hidden rounded-xl bg-surface shadow-xs transition hover:shadow-pop">
      <button type="button" onClick={onOpen} className="flex w-full items-center gap-3 px-3.5 pb-2 pt-3 text-left">
        <ScoreChip score={row.score} threshold={threshold} />
        <CompanyLogo src={row.logoUrl} name={row.name} sizeClass="size-8" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-[13px] font-semibold tracking-tight">{row.name}</p>
          <p className="truncate text-[11px] text-muted-foreground">
            {[row.industries, headcountLabel(row)].filter(Boolean).join(" · ") || "—"}
          </p>
        </div>
        {row.topJobTitle ? (
          <span className="hidden max-w-64 truncate text-[11.5px] text-muted-foreground lg:block" data-tip="The posting that qualified this company">
            Hiring: {row.topJobTitle}
          </span>
        ) : null}
      </button>
      <div className="flex flex-col border-t border-border/60 px-3.5 py-1">
        {sourcing ? (
          <p className="flex items-center gap-2 py-2 text-[11.5px] text-muted-foreground">
            <Loader2 className="size-3.5 animate-spin" />
            Finding the right people…
          </p>
        ) : row.picks.length === 0 ? (
          <p className="py-2 text-[11.5px] text-muted-foreground">No contacts picked yet — open the company to choose.</p>
        ) : (
          row.picks.map((pick) => {
            const status = pickStatus(pick);
            return (
              <div key={pick.id} className="flex items-center gap-2.5 py-1.5">
                <span className={`size-1.5 shrink-0 rounded-full ${pick.pickOrder === 1 ? "bg-primary" : "bg-muted-foreground/40"}`} data-tip={pick.pickOrder === 1 ? "Primary" : "Backup — releases after the primary"} />
                <span className="min-w-0 flex-initial truncate text-[12px] font-medium">{pick.fullName}</span>
                {pick.matchedReportsTo ? <Badge variant="info">Named in the JD</Badge> : null}
                <span className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground">{[pick.title, pick.email].filter(Boolean).join(" · ")}</span>
                <Badge variant={status.variant} className="max-w-56 truncate">{status.label}</Badge>
                {!pick.pushedAt && pick.emailStatus !== "found" && pick.emailStatus !== "pending" ? (
                  <button
                    type="button"
                    disabled={busyContactId === pick.id}
                    onClick={() => onFindEmail(pick.id)}
                    className={`${BTN_OUTLINE} h-6 px-2 text-[10.5px]`}
                  >
                    {busyContactId === pick.id ? <Loader2 className="size-3 animate-spin" /> : <Mail className="size-3" />}
                    Find email
                  </button>
                ) : null}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

function CompanyRow({ row, threshold, onOpen }: { row: CompanyResultRow; threshold: number; onOpen: () => void }) {
  const meta = [row.industries, headcountLabel(row), `${row.evidenceCount} posting${row.evidenceCount === 1 ? "" : "s"}`]
    .filter(Boolean)
    .join(" · ");
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onOpen();
        }
      }}
      className="group flex cursor-pointer items-center gap-3 px-3 py-2.5 transition hover:bg-muted/40"
    >
      <ScoreChip score={row.score} threshold={threshold} />
      <CompanyLogo src={row.logoUrl} name={row.name} sizeClass="size-8" />
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-1.5">
          <span className="truncate text-[12.5px] font-medium tracking-tight">{row.name}</span>
          <FlagDots flags={row.flags} />
        </div>
        <p className="truncate text-[11px] text-muted-foreground">{meta || "—"}</p>
      </div>

      {row.topJobTitle ? (
        <span className="hidden max-w-56 truncate text-[11px] text-muted-foreground lg:block">{row.topJobTitle}</span>
      ) : null}

      {row.funnelState === "killed" ? (
        <Badge variant="ghost">
          {row.killedStage === "override" ? "Override" : row.killedStage ? FUNNEL_STAGE_LABELS[row.killedStage] : "Killed"}
        </Badge>
      ) : row.funnelState === "errored" ? (
        <Badge variant="destructive">Errored</Badge>
      ) : row.override ? (
        <Badge variant="info">Override</Badge>
      ) : row.reviewState === "approved" ? (
        <Badge variant="success">Approved</Badge>
      ) : row.reviewState === "archived" ? (
        <Badge variant="ghost">Archived</Badge>
      ) : row.funnelState === "qualified" ? (
        <Badge variant="info">New</Badge>
      ) : (
        <Badge variant="ghost">{row.funnelState}</Badge>
      )}
    </div>
  );
}

/* ── Company drawer ───────────────────────────────────────────────────── */

function DrawerCard({ title, action, children }: { title: string; action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="rounded-lg border border-border bg-surface">
      <div className="flex h-9 items-center justify-between gap-2 border-b border-border px-3">
        <h3 className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">{title}</h3>
        {action ?? null}
      </div>
      <div className="px-3 py-2.5">{children}</div>
    </section>
  );
}

const VERDICT_CHIP: Record<StageResultDto["verdict"], { label: string; variant: BadgeVariant }> = {
  pass: { label: "Pass", variant: "success" },
  kill: { label: "Kill", variant: "destructive" },
  flag: { label: "Flag", variant: "warning" },
  score: { label: "Scored", variant: "info" },
  skip: { label: "Reused", variant: "ghost" },
  error: { label: "Error", variant: "destructive" },
};

function StageResultItem({ result }: { result: StageResultDto }) {
  const chip = VERDICT_CHIP[result.verdict] ?? { label: result.verdict, variant: "ghost" as BadgeVariant };
  const meta = [
    result.model,
    result.inputTokens !== null ? `${(result.inputTokens ?? 0) + (result.outputTokens ?? 0)} tok` : null,
    result.configVersion !== null ? `config v${result.configVersion}` : null,
    new Date(result.createdAt).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }),
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <div className="flex flex-col gap-1 py-2 first:pt-0 last:pb-0">
      <div className="flex items-center gap-2">
        <span className="text-[11.5px] font-semibold">{FUNNEL_STAGE_LABELS[result.stage] ?? result.stage}</span>
        <Badge variant={chip.variant}>{chip.label}</Badge>
        <span className="ml-auto text-[10px] text-muted-foreground">{meta}</span>
      </div>
      {result.rationale ? <p className="break-words text-[11.5px] leading-relaxed text-foreground">{result.rationale}</p> : null}
      {result.error ? <p className="break-words text-[11.5px] leading-relaxed text-destructive">{result.error}</p> : null}
      {result.rawText ? (
        <details className="group">
          <summary className="cursor-pointer text-[10.5px] font-medium text-muted-foreground transition hover:text-foreground">Raw model output</summary>
          <pre className="scroll-thin mt-1 overflow-x-auto rounded-md bg-muted/50 p-2 text-[10.5px] leading-relaxed">{result.rawText}</pre>
        </details>
      ) : null}
    </div>
  );
}

function tenureLabel(months: number | null): string | null {
  if (!months || months <= 0) return null;
  const years = Math.floor(months / 12);
  const rem = months % 12;
  if (years <= 0) return `${months}mo here`;
  if (rem === 0) return `${years}y here`;
  return `${years}y ${rem}mo here`;
}

function ContactAvatar({ src, name }: { src: string | null; name: string }) {
  const initials = name.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]?.toUpperCase() ?? "").join("") || "?";
  if (src) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={src}
        alt=""
        className="size-8 shrink-0 rounded-full object-cover"
        onError={(event) => {
          event.currentTarget.style.display = "none";
          event.currentTarget.nextElementSibling?.classList.remove("hidden");
        }}
      />
    );
  }
  return <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-accent text-[11px] font-semibold text-accent-foreground">{initials}</span>;
}

const EMAIL_PILL: Record<NonNullable<SignalContactDto["emailStatus"]>, { label: string; variant: BadgeVariant }> = {
  found: { label: "Email found", variant: "success" },
  pending: { label: "Finding…", variant: "info" },
  not_found: { label: "No email", variant: "ghost" },
  error: { label: "Email error", variant: "warning" },
};

function ContactRow({
  contact,
  busy,
  onPick,
  onFindEmail,
}: {
  contact: SignalContactDto;
  busy: boolean;
  onPick: (order: 1 | 2 | null) => void;
  onFindEmail: () => void;
}) {
  const excluded = contact.status === "excluded";
  const meta = [contact.title, tenureLabel(contact.tenureMonths), contact.location].filter(Boolean).join(" · ");
  const pill = contact.emailStatus ? EMAIL_PILL[contact.emailStatus] : null;
  return (
    <div className={`flex items-start gap-2.5 py-2 first:pt-0 last:pb-0 ${excluded ? "opacity-55" : ""}`}>
      <ContactAvatar src={contact.pictureUrl} name={contact.fullName} />
      <span className="hidden size-8 shrink-0 items-center justify-center rounded-full bg-accent text-[11px] font-semibold text-accent-foreground">
        {contact.fullName.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]?.toUpperCase() ?? "").join("") || "?"}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="truncate text-[12px] font-medium">{contact.fullName}</span>
          {contact.pickOrder === 1 ? <Badge variant="info">Primary</Badge> : null}
          {contact.pickOrder === 2 ? <Badge variant="outline">Backup</Badge> : null}
          {contact.linkedinUrl ? (
            <a href={contact.linkedinUrl} target="_blank" rel="noreferrer" aria-label="Profile on LinkedIn" className="inline-flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground transition hover:bg-muted hover:text-foreground">
              <ArrowUpRight className="size-3" />
            </a>
          ) : null}
        </div>
        <p className="truncate text-[10.5px] text-muted-foreground">{meta || "—"}</p>
        <div className="mt-1 flex flex-wrap items-center gap-1.5">
          {contact.rankReason && !excluded ? <span className="text-[10px] text-muted-foreground">{contact.rankReason}</span> : null}
          {excluded ? (
            <span className={`text-[10px] ${contact.employmentStatus === "departed" ? "text-warning" : "text-muted-foreground"}`}>
              {contact.exclusionReason ?? "Excluded"}
            </span>
          ) : null}
          {pill ? <Badge variant={pill.variant}>{pill.label}</Badge> : null}
          {contact.emailStatus === "found" && contact.email ? <span className="truncate text-[10.5px] text-foreground">{contact.email}</span> : null}
        </div>
      </div>
      {!excluded ? (
        <div className="flex shrink-0 items-center gap-1">
          {contact.pickOrder !== 1 ? (
            <button type="button" disabled={busy} onClick={() => onPick(1)} className={`${BTN_GHOST} h-6 px-1.5 text-[10.5px]`} data-tip="Set as primary" data-tip-down="" data-tip-end="">
              <Star className="size-3" />
            </button>
          ) : null}
          {contact.pickOrder !== 2 ? (
            <button type="button" disabled={busy} onClick={() => onPick(2)} className={`${BTN_GHOST} h-6 px-1.5 text-[10.5px]`} data-tip="Set as backup" data-tip-down="" data-tip-end="">
              +2
            </button>
          ) : null}
          {contact.pickOrder !== null ? (
            <>
              {contact.emailStatus !== "found" ? (
                <button type="button" disabled={busy} onClick={onFindEmail} className={`${BTN_GHOST} h-6 px-1.5 text-[10.5px]`} data-tip="Find email" data-tip-down="" data-tip-end="">
                  <Mail className="size-3" />
                </button>
              ) : null}
              <button type="button" disabled={busy} onClick={() => onPick(null)} className={`${BTN_GHOST} h-6 px-1.5 text-[10.5px]`} data-tip="Remove from list" data-tip-down="" data-tip-end="">
                <X className="size-3" />
              </button>
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

// Contacts panel inside the company drawer: roster sourcing state, ranked
// people, primary/backup picks, and per-contact email lookup. Polls while a
// roster is still landing so the list fills in without a manual refresh.
function ContactsCard({ company, reload }: { company: CompanyDetail; reload: () => Promise<void> }) {
  const showToast = useToast();
  const [busyId, setBusyId] = useState<string | null>(null);
  const state = company.contactsState;

  useEffect(() => {
    if (state !== "pending" && state !== "sourcing") return;
    let cancelled = false;
    const poll = async () => {
      while (!cancelled) {
        await new Promise((resolve) => setTimeout(resolve, 4_000));
        if (cancelled) break;
        const result = await pollContactsAction(company.id);
        if (cancelled) break;
        if (result.ok && (result.contactsState === "sourced" || result.contactsState === "errored")) {
          await reload();
          break;
        }
        await reload();
      }
    };
    void poll();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, company.id]);

  const pick = async (contactId: string, order: 1 | 2 | null) => {
    setBusyId(contactId);
    try {
      const result = await setContactPickAction(contactId, order);
      if (!result.ok) showToast(false, result.message);
      await reload();
    } finally {
      setBusyId(null);
    }
  };
  const findEmail = async (contactId: string) => {
    setBusyId(contactId);
    try {
      const result = await findContactEmailAction(contactId);
      if (!result.ok) showToast(false, result.message);
      else if (result.contact.emailStatus === "found") showToast(true, `Email found via ${result.contact.emailSource}.`);
      else showToast(false, result.contact.emailError ?? "No email found.");
      await reload();
    } finally {
      setBusyId(null);
    }
  };
  const resource = async () => {
    setBusyId("resource");
    try {
      const result = await resourceContactsAction(company.id);
      if (!result.ok) showToast(false, result.message);
      else showToast(true, "Re-sourcing contacts…");
      await reload();
    } finally {
      setBusyId(null);
    }
  };

  const picks = company.contacts.filter((contact) => contact.pickOrder !== null).sort((a, b) => (a.pickOrder ?? 9) - (b.pickOrder ?? 9));
  const others = company.contacts.filter((contact) => contact.pickOrder === null);
  const inFlight = state === "pending" || state === "sourcing";

  return (
    <DrawerCard
      title={`Contacts${company.linkedinEmployeeCount ? ` — ${company.linkedinEmployeeCount} current on LinkedIn` : company.rosterCount ? ` — ${company.rosterCount} on the roster` : ""}`}
      action={
        // "none" happens for companies that qualified before contact sourcing
        // existed — they need a way in, so the button doubles as the starter.
        state === "sourced" || state === "errored" || state === "none" ? (
          <button type="button" disabled={busyId !== null} onClick={() => void resource()} className={`${BTN_OUTLINE} h-7 px-2 text-[11px]`}>
            {busyId === "resource" ? <Loader2 className="size-3 animate-spin" /> : <RefreshCw className="size-3" />}
            {state === "none" ? "Find contacts" : "Re-source"}
          </button>
        ) : null
      }
    >
      {inFlight ? (
        <div className="flex items-center gap-2 text-[11.5px] text-muted-foreground">
          <Loader2 className="size-3.5 animate-spin" />
          {state === "pending" ? "Queued — pulling the LinkedIn roster shortly…" : "Pulling the LinkedIn roster and ranking contacts…"}
        </div>
      ) : state === "errored" ? (
        <p className={`text-[11.5px] leading-relaxed ${company.contactsError?.includes("rate limit") ? "text-warning" : "text-destructive"}`}>
          {company.contactsError ?? "Contact sourcing failed."}
          {company.contactsError?.includes("rate limit") ? "" : " Re-source to retry."}
        </p>
      ) : state === "none" ? (
        <p className="text-[11.5px] leading-relaxed text-muted-foreground">
          Newly qualified companies get their roster pulled automatically. This one qualified earlier — use Find contacts.
        </p>
      ) : company.contacts.length === 0 ? (
        <p className="text-[11.5px] leading-relaxed text-muted-foreground">No employees found on LinkedIn for this company.</p>
      ) : (
        <div className="flex flex-col gap-2.5">
          {picks.length > 0 ? (
            <div className="flex flex-col divide-y divide-border rounded-md bg-info-soft/30 px-2">
              {picks.map((contact) => (
                <ContactRow key={contact.id} contact={contact} busy={busyId === contact.id} onPick={(order) => void pick(contact.id, order)} onFindEmail={() => void findEmail(contact.id)} />
              ))}
            </div>
          ) : (
            <p className="text-[11px] text-muted-foreground">No one picked yet — star the best person to add them to the lead list.</p>
          )}
          {others.length > 0 ? (
            <details className="group">
              <summary className="cursor-pointer text-[10.5px] font-medium text-muted-foreground transition hover:text-foreground">
                Full roster ({others.length} more)
              </summary>
              <div className="mt-1 flex flex-col divide-y divide-border">
                {others.map((contact) => (
                  <ContactRow key={contact.id} contact={contact} busy={busyId === contact.id} onPick={(order) => void pick(contact.id, order)} onFindEmail={() => void findEmail(contact.id)} />
                ))}
              </div>
            </details>
          ) : null}
        </div>
      )}
    </DrawerCard>
  );
}

function CompanyDrawer({
  companyId,
  threshold,
  onClose,
  onChanged,
  onReevaluate,
}: {
  companyId: string;
  threshold: number;
  onClose: () => void;
  onChanged: () => void;
  onReevaluate: (companyId: string) => void;
}) {
  const exit = useExit();
  const requestClose = () => exit.playExit(onClose);
  useDrawerChrome(requestClose);
  const showToast = useToast();
  const [company, setCompany] = useState<CompanyDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [overridePrompt, setOverridePrompt] = useState<"qualified" | "killed" | null>(null);
  const [overrideNote, setOverrideNote] = useState("");

  const reload = useCallback(async () => {
    const result = await getCompanyDetailAction(companyId);
    if (result.ok) {
      setCompany(result.company);
      setError(null);
    } else {
      setError(result.message);
    }
  }, [companyId]);

  useEffect(() => {
    // Async fetch-on-open; state lands after the await, not synchronously.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void reload();
  }, [reload]);

  const act = async (key: string, run: () => Promise<{ ok: boolean; message?: string }>, okMessage: string) => {
    setPending(key);
    try {
      const result = await run();
      if (result.ok) {
        showToast(true, okMessage);
        await reload();
        onChanged();
      } else {
        showToast(false, result.message ?? "Something went wrong.");
      }
    } catch {
      showToast(false, "Something went wrong. Try again.");
    } finally {
      setPending(null);
    }
  };

  const verdictBanner = () => {
    if (!company) return null;
    if (company.override) {
      return (
        <div className="flex items-start gap-2 rounded-lg bg-info-soft px-3 py-2.5 text-[12px] text-info">
          <ShieldAlert className="mt-0.5 size-3.5 shrink-0" />
          <span className="min-w-0 break-words">
            Operator override: forced {company.override}.{company.overrideNote ? ` “${company.overrideNote}”` : ""} Re-evaluation never flips this.
          </span>
        </div>
      );
    }
    if (company.funnelState === "killed") {
      return (
        <div className="flex items-start gap-2 rounded-lg bg-muted px-3 py-2.5 text-[12px] text-foreground">
          <X className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
          <span className="min-w-0 break-words">
            Killed at <span className="font-medium">{stageLabel(company.killedStage)}</span>
            {company.killReason ? ` — ${company.killReason}` : ""}
          </span>
        </div>
      );
    }
    if (company.funnelState === "errored") {
      return (
        <div className="flex items-start gap-2 rounded-lg bg-destructive-soft px-3 py-2.5 text-[12px] text-destructive">
          <ShieldAlert className="mt-0.5 size-3.5 shrink-0" />
          <span className="min-w-0 break-words">Errored: {company.funnelError ?? "unknown failure"}. Re-evaluate to retry.</span>
        </div>
      );
    }
    return null;
  };

  return (
    <div className="fixed inset-0 z-40 flex justify-end">
      <div aria-hidden="true" onClick={requestClose} className={`absolute inset-0 bg-black/40 ${exit.closing ? "anim-overlay-out" : "anim-overlay-in"}`} />
      <div
        role="dialog"
        aria-label="Company details"
        className={`relative ml-auto flex h-full w-full max-w-[640px] flex-col border-l border-border bg-background shadow-pop ${exit.closing ? "anim-drawer-out" : "anim-drawer-in"}`}
      >
        <div className="flex items-start justify-between gap-3 border-b border-border bg-surface px-4 py-3">
          <div className="flex min-w-0 items-center gap-2.5">
            <CompanyLogo src={company?.logoUrl ?? null} name={company?.name ?? "?"} sizeClass="size-9" />
            <div className="min-w-0">
              <h2 className="truncate text-[14px] font-semibold tracking-tight">{company?.name ?? "Loading…"}</h2>
              <p className="truncate text-[12px] text-muted-foreground">
                {company ? [company.industries, headcountLabel(company)].filter(Boolean).join(" · ") || "—" : ""}
              </p>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            {company ? <ScoreChip score={company.score} threshold={threshold} /> : null}
            {company?.websiteUrl ? (
              <a href={company.websiteUrl} target="_blank" rel="noreferrer" aria-label="Website" data-tip="Website" data-tip-down="" data-tip-end="" className="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground transition hover:bg-muted/70 hover:text-foreground">
                <Globe className="size-4" />
              </a>
            ) : null}
            {company?.linkedinUrl ? (
              <a href={company.linkedinUrl} target="_blank" rel="noreferrer" aria-label="LinkedIn" data-tip="Company on LinkedIn" data-tip-down="" data-tip-end="" className="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground transition hover:bg-muted/70 hover:text-foreground">
                <Building2 className="size-4" />
              </a>
            ) : null}
            <button type="button" aria-label="Close" onClick={requestClose} className="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground transition hover:bg-muted/70 hover:text-foreground">
              <X className="size-4" />
            </button>
          </div>
        </div>

        <div className="scroll-thin flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-4 py-3.5">
          {error ? (
            <div className="flex items-center gap-2 rounded-lg bg-destructive-soft px-3 py-2.5 text-[12px] text-destructive">
              <ShieldAlert className="size-3.5 shrink-0" />
              <span className="min-w-0 break-words">{error}</span>
            </div>
          ) : null}
          {!company && !error ? (
            <>
              {[0, 1, 2].map((index) => (
                <div key={index} className="h-24 animate-pulse rounded-lg border border-border bg-muted/40" />
              ))}
            </>
          ) : null}

          {company ? (
            <>
              {verdictBanner()}

              {/* Actions — the lead list is the one review gate, so there is
                  no Approve step: pushing IS approval. Dismiss hides a company
                  you never want to work. */}
              <div className="flex flex-wrap items-center gap-2">
                {company.funnelState === "qualified" && company.reviewState !== "archived" ? (
                  <button type="button" disabled={pending !== null} onClick={() => void act("archive", () => setReviewAction(company.id, "archived", null), "Dismissed — hidden from results.")} className={`${BTN_GHOST} h-8 px-2.5 text-[12px]`}>
                    {pending === "archive" ? <Loader2 className="size-3.5 animate-spin" /> : <Archive className="size-3.5" />}
                    Dismiss
                  </button>
                ) : null}
                {company.funnelState === "qualified" && company.reviewState === "archived" ? (
                  <button type="button" disabled={pending !== null} onClick={() => void act("unreview", () => setReviewAction(company.id, "new", null), "Restored to results.")} className={`${BTN_GHOST} h-8 px-2.5 text-[12px]`}>
                    <Undo2 className="size-3.5" />
                    Restore
                  </button>
                ) : null}
                {company.override === null ? (
                  <button
                    type="button"
                    disabled={pending !== null}
                    onClick={() => setOverridePrompt(company.funnelState === "qualified" ? "killed" : "qualified")}
                    className={`${BTN_OUTLINE} h-8 px-2.5 text-[12px]`}
                  >
                    <ShieldAlert className="size-3.5" />
                    {company.funnelState === "qualified" ? "Force-kill" : "Force-qualify"}
                  </button>
                ) : (
                  <button type="button" disabled={pending !== null} onClick={() => void act("override", () => setOverrideAction(company.id, null, null), "Override cleared — next re-evaluation decides.")} className={`${BTN_OUTLINE} h-8 px-2.5 text-[12px]`}>
                    <Undo2 className="size-3.5" />
                    Clear override
                  </button>
                )}
                <button
                  type="button"
                  disabled={pending !== null}
                  onClick={() => onReevaluate(company.id)}
                  className={`${BTN_GHOST} ml-auto h-8 px-2.5 text-[12px]`}
                  data-tip="Re-run this company through the funnel"
                  data-tip-end=""
                >
                  <RefreshCw className="size-3.5" />
                  Re-evaluate
                </button>
              </div>

              {overridePrompt ? (
                <div className="flex flex-col gap-2 rounded-lg border border-border bg-surface p-3">
                  <p className="text-[12px] font-medium">Force-{overridePrompt === "qualified" ? "qualify" : "kill"} {company.name}? This sticks — re-evaluation never flips it.</p>
                  <input value={overrideNote} onChange={(event) => setOverrideNote(event.target.value)} placeholder="Optional note (why)" className={INPUT_CLASS} />
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      disabled={pending !== null}
                      onClick={() =>
                        void act("override", () => setOverrideAction(company.id, overridePrompt, overrideNote.trim() || null), "Override set.").then(() => {
                          setOverridePrompt(null);
                          setOverrideNote("");
                        })
                      }
                      className={`${BTN_PRIMARY} h-7 px-2.5 text-[11.5px]`}
                    >
                      Confirm
                    </button>
                    <button type="button" onClick={() => setOverridePrompt(null)} className={`${BTN_GHOST} h-7 px-2.5 text-[11.5px]`}>
                      Cancel
                    </button>
                  </div>
                </div>
              ) : null}

              {/* Score breakdown */}
              {company.scoreBreakdown && company.scoreBreakdown.length > 0 ? (
                <DrawerCard title={`Score breakdown — ${company.score}/100 (threshold ${threshold})`}>
                  <div className="flex flex-col gap-2.5">
                    {company.scoreBreakdown.map((factor) => (
                      <div key={factor.key} className="flex flex-col gap-1">
                        <div className="flex items-baseline justify-between gap-2">
                          <span className="text-[11.5px] font-medium">{factor.label}</span>
                          <span className="tabular text-[11px] text-muted-foreground">{factor.points}/{factor.max}</span>
                        </div>
                        <div className="h-1 overflow-hidden rounded-full bg-muted">
                          <div className="h-full rounded-full bg-primary/70" style={{ width: `${factor.max > 0 ? Math.round((factor.points / factor.max) * 100) : 0}%` }} />
                        </div>
                        <p className="text-[11px] leading-relaxed text-muted-foreground">{factor.rationale}</p>
                      </div>
                    ))}
                  </div>
                </DrawerCard>
              ) : null}

              {/* Contacts — only for qualified companies (the outreach targets) */}
              {company.funnelState === "qualified" ? <ContactsCard company={company} reload={reload} /> : null}

              {/* Research */}
              <DrawerCard
                title="Company research"
                action={
                  <button
                    type="button"
                    disabled={pending !== null}
                    onClick={() => void act("research", () => researchCompanyAction(company.id), "Research refreshed.")}
                    className={`${BTN_OUTLINE} h-7 px-2 text-[11px]`}
                  >
                    {pending === "research" ? <Loader2 className="size-3 animate-spin" /> : <RefreshCw className="size-3" />}
                    {company.researchStatus === "done" ? "Re-run" : "Research"}
                  </button>
                }
              >
                {company.researchBrief ? (
                  <div className="flex flex-col gap-2.5">
                    <MarkdownLite text={company.researchBrief} />
                    {company.researchSources.length > 0 ? (
                      <div className="flex flex-col gap-1 border-t border-border pt-2">
                        <span className="text-[10px] font-medium uppercase tracking-[0.06em] text-muted-foreground">Sources</span>
                        {company.researchSources.slice(0, 5).map((source) => (
                          <a key={source.url} href={source.url} target="_blank" rel="noreferrer" className="inline-flex min-w-0 items-center gap-1 text-[11px] text-info underline-offset-2 hover:underline">
                            <ExternalLink className="size-3 shrink-0" />
                            <span className="truncate">{source.title || source.url}</span>
                          </a>
                        ))}
                      </div>
                    ) : null}
                  </div>
                ) : (
                  <p className="text-[11.5px] leading-relaxed text-muted-foreground">
                    {company.researchStatus === "failed" ? "Research failed — retry above." : "No research yet — the funnel runs it automatically, or trigger it here."}
                  </p>
                )}
              </DrawerCard>

              {/* Evidence */}
              <DrawerCard title={`Evidence — ${company.jobs.length} posting${company.jobs.length === 1 ? "" : "s"}`}>
                {company.jobs.length === 0 ? (
                  <p className="text-[11.5px] text-muted-foreground">No postings on file.</p>
                ) : (
                  <div className="flex flex-col divide-y divide-border">
                    {company.jobs.map((job) => (
                      <div key={job.id} className="flex items-center gap-2 py-1.5 first:pt-0 last:pb-0">
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-[12px] font-medium">{job.title}</p>
                          <p className="truncate text-[10.5px] text-muted-foreground">
                            {[job.source === "indeed" ? "Indeed" : "LinkedIn", job.location, job.timePosted, job.salaryRange].filter(Boolean).join(" · ")}
                          </p>
                        </div>
                        <a href={job.jobUrl} target="_blank" rel="noreferrer" aria-label="View posting on LinkedIn" className="inline-flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground transition hover:bg-muted hover:text-foreground">
                          <ArrowUpRight className="size-3.5" />
                        </a>
                      </div>
                    ))}
                  </div>
                )}
              </DrawerCard>

              {/* Audit trail — collapsed by default. Kill transparency is a
                  hard requirement, but it is for when a verdict is disputed,
                  not for every glance at a lead. */}
              {company.stageResults.length > 0 ? (
                <details className="group rounded-lg border border-border bg-surface">
                  <summary className="flex h-9 cursor-pointer items-center px-3 text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground transition hover:text-foreground">
                    Full analysis · {company.stageResults.length} stages
                  </summary>
                  <div className="flex flex-col divide-y divide-border px-3 pb-2.5">
                    {company.stageResults.map((result) => (
                      <StageResultItem key={result.id} result={result} />
                    ))}
                  </div>
                </details>
              ) : null}
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
}

/* ── Search dialog (inside config) ────────────────────────────────────── */

const EMPTY_SEARCH: SignalSearchInput = {
  name: "",
  source: "linkedin",
  jobTitles: [],
  location: "United States",
  cities: [],
  experience: null,
  employmentType: null,
  workArrangement: null,
  postedWithin: "Past 24 hours",
  maxJobs: 100,
};

function EnumSelect({
  label,
  value,
  options,
  onChange,
  disabled,
}: {
  label: string;
  value: string | null;
  options: readonly string[];
  onChange: (next: string | null) => void;
  disabled: boolean;
}) {
  return (
    <label className="flex min-w-0 flex-col gap-1">
      <span className="text-[11px] font-medium text-muted-foreground">{label}</span>
      <div className="relative">
        <select value={value ?? ""} disabled={disabled} onChange={(event) => onChange(event.target.value || null)} className={`${SELECT_CLASS} w-full`}>
          <option value="">Any</option>
          {options.map((option) => (
            <option key={option} value={option}>{option}</option>
          ))}
        </select>
        <ChevronDown className="pointer-events-none absolute right-1.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
      </div>
    </label>
  );
}

function SearchEditor({
  automationId,
  search,
  onSaved,
  onArchived,
  onCancel,
}: {
  automationId: string;
  search: SignalSearchDto | null;
  onSaved: (searches: SignalSearchDto[]) => void;
  onArchived: (searches: SignalSearchDto[]) => void;
  onCancel: () => void;
}) {
  const [form, setForm] = useState<SignalSearchInput>(() =>
    search
      ? {
          name: search.name,
          source: search.source,
          jobTitles: search.jobTitles,
          location: search.location,
          cities: search.cities,
          experience: search.experience,
          employmentType: search.employmentType,
          workArrangement: search.workArrangement,
          postedWithin: search.postedWithin,
          maxJobs: search.maxJobs,
        }
      : EMPTY_SEARCH,
  );
  const [pending, setPending] = useState<"save" | "archive" | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const set = <K extends keyof SignalSearchInput>(key: K, value: SignalSearchInput[K]) => setForm((prev) => ({ ...prev, [key]: value }));
  const canSave = form.name.trim().length > 0 && form.jobTitles.length > 0 && pending === null;

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-border bg-subtle p-3">
      <div className="flex flex-col gap-1">
        <span className="text-[11px] font-medium text-muted-foreground">Job board</span>
        <div className="flex gap-1 self-start rounded-md bg-muted/60 p-0.5">
          {(["linkedin", "indeed"] as const).map((source) => (
            <button
              key={source}
              type="button"
              disabled={pending !== null}
              onClick={() => set("source", source)}
              className={`h-7 rounded px-2.5 text-[11.5px] font-medium transition ${form.source === source ? "bg-surface text-foreground shadow-xs" : "text-muted-foreground hover:text-foreground"}`}
            >
              {source === "linkedin" ? "LinkedIn" : "Indeed"}
            </button>
          ))}
        </div>
        {form.source === "indeed" ? (
          <p className="text-[10.5px] leading-snug text-muted-foreground">
            Indeed runs one scrape per title (max jobs splits across titles) and reports company size. Cities are ignored — use the location field. On-site can&rsquo;t be filtered; &ldquo;Past Month&rdquo; maps to the last 14 days.
          </p>
        ) : null}
      </div>
      <label className="flex flex-col gap-1">
        <span className="text-[11px] font-medium text-muted-foreground">Name</span>
        <input value={form.name} disabled={pending !== null} onChange={(event) => set("name", event.target.value)} placeholder="e.g. Automation roles — manufacturing" className={INPUT_CLASS} />
      </label>
      <div className="flex flex-col gap-1">
        <span className="text-[11px] font-medium text-muted-foreground">Job titles</span>
        <TagInput value={form.jobTitles} onChange={(next) => set("jobTitles", next.slice(0, 20))} placeholder="Controls Engineer, Process Automation…  (Enter adds)" disabled={pending !== null} ariaLabel="Job titles" />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <label className="flex flex-col gap-1">
          <span className="text-[11px] font-medium text-muted-foreground">Location</span>
          <input value={form.location} disabled={pending !== null} onChange={(event) => set("location", event.target.value)} className={INPUT_CLASS} />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-[11px] font-medium text-muted-foreground">Max jobs per run</span>
          <input
            type="number"
            min={1}
            max={1000}
            value={form.maxJobs}
            disabled={pending !== null}
            onChange={(event) => {
              const next = Number(event.target.value);
              set("maxJobs", Number.isFinite(next) ? Math.min(1000, Math.max(1, Math.round(next))) : 100);
            }}
            className={`${INPUT_CLASS} tabular`}
          />
        </label>
      </div>
      {form.source === "linkedin" ? (
        <div className="flex flex-col gap-1">
          <span className="text-[11px] font-medium text-muted-foreground">Cities (optional)</span>
          <TagInput value={form.cities} onChange={(next) => set("cities", next.slice(0, 30))} placeholder="Chicago, Dallas, …" disabled={pending !== null} ariaLabel="Cities" />
        </div>
      ) : null}
      <div className="grid grid-cols-2 gap-3">
        <EnumSelect label="Posted within" value={form.postedWithin} options={SEARCH_POSTED_OPTIONS} onChange={(next) => set("postedWithin", next)} disabled={pending !== null} />
        <EnumSelect label="Experience" value={form.experience} options={SEARCH_EXPERIENCE_OPTIONS} onChange={(next) => set("experience", next)} disabled={pending !== null} />
        <EnumSelect label="Job type" value={form.employmentType} options={SEARCH_EMPLOYMENT_OPTIONS} onChange={(next) => set("employmentType", next)} disabled={pending !== null} />
        <EnumSelect label="Workplace" value={form.workArrangement} options={SEARCH_ARRANGEMENT_OPTIONS} onChange={(next) => set("workArrangement", next)} disabled={pending !== null} />
      </div>
      {note ? <p className="text-[11px] text-destructive">{note}</p> : null}
      <div className="flex items-center gap-2">
        {search ? (
          <button
            type="button"
            disabled={pending !== null}
            onClick={async () => {
              setPending("archive");
              const result = await archiveSearchAction(automationId, search.id);
              setPending(null);
              if (result.ok) onArchived(result.searches);
              else setNote(result.message);
            }}
            className={`${BTN_GHOST} h-7 px-2 text-[11.5px] text-destructive hover:bg-destructive-soft hover:text-destructive`}
          >
            <Trash2 className="size-3.5" />
            Archive
          </button>
        ) : null}
        <button type="button" onClick={onCancel} className={`${BTN_OUTLINE} ml-auto h-7 px-2.5 text-[11.5px]`}>
          Cancel
        </button>
        <button
          type="button"
          disabled={!canSave}
          onClick={async () => {
            setPending("save");
            setNote(null);
            const result = await saveSearchAction(automationId, search?.id ?? null, { ...form, name: form.name.trim(), location: form.location.trim() || "United States" });
            setPending(null);
            if (result.ok) onSaved(result.searches);
            else setNote(result.message);
          }}
          className={`${BTN_PRIMARY} h-7 px-2.5 text-[11.5px]`}
        >
          {pending === "save" ? <Loader2 className="size-3.5 animate-spin" /> : null}
          {search ? "Save search" : "Create search"}
        </button>
      </div>
    </div>
  );
}

/* ── Config drawer ────────────────────────────────────────────────────── */

// One section at a time, picked from the rail on the left — each section is a
// small, focused form instead of one long scroll.
const CONFIG_SECTIONS = [
  { key: "context", label: "Studio context", blurb: "What the AI stages know about us — feeds the title gate and JD scoring." },
  { key: "searches", label: "Searches", blurb: "The job-board searches (LinkedIn, Indeed) every funnel run scrapes." },
  { key: "filters", label: "Company filters", blurb: "Deterministic screens: headcount target and industry lists." },
  { key: "gates", label: "AI gates", blurb: "Prompts and models for the agency screen, title gate, and JD scoring." },
  { key: "scoring", label: "Scoring", blurb: "Factor weights and the qualified threshold." },
  { key: "spend", label: "Spend rails", blurb: "Hard caps so a run can never surprise you." },
] as const;
type ConfigSectionKey = (typeof CONFIG_SECTIONS)[number]["key"];

function ConfigField({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5 rounded-lg border border-border bg-surface p-3">
      <span className="text-[11.5px] font-semibold">{label}</span>
      {children}
      {hint ? <p className="text-[10.5px] leading-snug text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

function ConfigDrawer({
  automationId,
  config,
  searches,
  onClose,
  onSaved,
  onSearchesChanged,
  onReevaluateAll,
}: {
  automationId: string;
  config: FunnelConfigVersion;
  searches: SignalSearchDto[];
  onClose: () => void;
  onSaved: (config: FunnelConfigVersion) => void;
  onSearchesChanged: (searches: SignalSearchDto[]) => void;
  onReevaluateAll: () => void;
}) {
  const exit = useExit();
  const requestClose = () => exit.playExit(onClose);
  useDrawerChrome(requestClose);
  const showToast = useToast();
  const [section, setSection] = useState<ConfigSectionKey>("context");
  const [form, setForm] = useState<FunnelConfig>(config.config);
  const [saving, setSaving] = useState(false);
  const [editingSearch, setEditingSearch] = useState<SignalSearchDto | null | "new">(null);
  const dirty = useMemo(() => JSON.stringify(form) !== JSON.stringify(config.config), [form, config.config]);
  const active = CONFIG_SECTIONS.find((entry) => entry.key === section)!;

  const save = async () => {
    setSaving(true);
    const result = await saveConfigAction(form, null);
    setSaving(false);
    if (result.ok) {
      showToast(true, `Config saved as v${result.config.version}. Applies to future runs — Re-evaluate redoes past companies.`);
      onSaved(result.config);
    } else {
      showToast(false, result.message);
    }
  };

  return (
    <div className="fixed inset-0 z-40 flex justify-end">
      <div aria-hidden="true" onClick={requestClose} className={`absolute inset-0 bg-black/40 ${exit.closing ? "anim-overlay-out" : "anim-overlay-in"}`} />
      <div
        role="dialog"
        aria-label="Funnel configuration"
        className={`relative ml-auto flex h-full w-full max-w-[720px] flex-col border-l border-border bg-background shadow-pop ${exit.closing ? "anim-drawer-out" : "anim-drawer-in"}`}
      >
        <div className="flex items-center justify-between gap-3 border-b border-border bg-surface px-4 py-3">
          <div>
            <h2 className="text-[14px] font-semibold tracking-tight">Funnel config</h2>
            <p className="text-[11px] text-muted-foreground">v{config.version} active · every save creates a new version</p>
          </div>
          <div className="flex items-center gap-2">
            {dirty ? <span className="text-[10.5px] text-warning">Unsaved changes</span> : null}
            <button type="button" disabled={!dirty || saving} onClick={() => void save()} className={`${BTN_PRIMARY} h-7 px-2.5 text-[11.5px]`}>
              {saving ? <Loader2 className="size-3.5 animate-spin" /> : null}
              Save as v{config.version + 1}
            </button>
            <button type="button" aria-label="Close" onClick={requestClose} className="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground transition hover:bg-muted/70 hover:text-foreground">
              <X className="size-4" />
            </button>
          </div>
        </div>

        <div className="flex min-h-0 flex-1">
          {/* Section rail */}
          <nav className="flex w-44 shrink-0 flex-col gap-0.5 border-r border-border bg-surface px-2 py-3">
            {CONFIG_SECTIONS.map((entry) => (
              <button
                key={entry.key}
                type="button"
                onClick={() => setSection(entry.key)}
                className={`rounded-md px-2.5 py-1.5 text-left text-[12px] font-medium transition ${
                  section === entry.key ? "bg-accent text-accent-foreground" : "text-muted-foreground hover:bg-muted/60 hover:text-foreground"
                }`}
              >
                {entry.label}
              </button>
            ))}
            <div className="mt-auto flex flex-col gap-1.5 px-1 pt-3">
              <button type="button" onClick={onReevaluateAll} className={`${BTN_OUTLINE} h-7 px-2 text-[11px]`}>
                <RefreshCw className="size-3" />
                Re-evaluate all
              </button>
              <p className="text-[9.5px] leading-snug text-muted-foreground">
                Redoes past companies with the active config. Approvals and overrides never flip.
              </p>
            </div>
          </nav>

          {/* Section body */}
          <div className="scroll-thin flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-4 py-4">
            <div>
              <h3 className="text-[13px] font-semibold tracking-tight">{active.label}</h3>
              <p className="text-[11px] text-muted-foreground">{active.blurb}</p>
            </div>

            {section === "context" ? (
              <ConfigField
                label="Studio context"
                hint="Describe what you build, who you target, what a valid role looks like, and explicit disqualifiers. The title gate and JD scoring read this verbatim."
              >
                <textarea
                  value={form.studioContext}
                  onChange={(event) => setForm((prev) => ({ ...prev, studioContext: event.target.value }))}
                  rows={18}
                  className={TEXTAREA_CLASS}
                />
              </ConfigField>
            ) : null}

            {section === "searches" ? (
              <>
                <div className="flex flex-col gap-1.5">
                  {searches.map((search) => (
                    <div key={search.id} className="flex items-center gap-2 rounded-lg border border-border bg-surface px-3 py-2.5">
                      <div className="min-w-0 flex-1">
                        <div className="flex min-w-0 items-center gap-1.5">
                          <p className="truncate text-[12px] font-medium">{search.name}</p>
                          <Badge variant="ghost" className="shrink-0">{search.source === "indeed" ? "Indeed" : "LinkedIn"}</Badge>
                        </div>
                        <p className="truncate text-[10.5px] text-muted-foreground">
                          {search.jobTitles.join(", ")} · {search.location} · up to {search.maxJobs} jobs
                        </p>
                      </div>
                      <button type="button" aria-label={`Edit ${search.name}`} onClick={() => setEditingSearch(search)} className="inline-flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground transition hover:bg-muted hover:text-foreground">
                        <Pencil className="size-3.5" />
                      </button>
                    </div>
                  ))}
                  {searches.length === 0 ? <p className="text-[11.5px] text-muted-foreground">No searches yet — the funnel needs at least one.</p> : null}
                </div>
                {editingSearch !== null ? (
                  <SearchEditor
                    automationId={automationId}
                    search={editingSearch === "new" ? null : editingSearch}
                    onSaved={(next) => {
                      onSearchesChanged(next);
                      setEditingSearch(null);
                      showToast(true, "Search saved.");
                    }}
                    onArchived={(next) => {
                      onSearchesChanged(next);
                      setEditingSearch(null);
                      showToast(true, "Search archived.");
                    }}
                    onCancel={() => setEditingSearch(null)}
                  />
                ) : (
                  <button type="button" onClick={() => setEditingSearch("new")} className={`${BTN_OUTLINE} h-7 self-start px-2.5 text-[11.5px]`}>
                    <Plus className="size-3.5" />
                    New search
                  </button>
                )}
              </>
            ) : null}

            {section === "filters" ? (
              <>
                <ConfigField
                  label="Headcount target"
                  hint="Hard kills only on verified headcount (your data source, when connected). LLM estimates just lower the size-fit score; unknown passes with a flag."
                >
                  <div className="grid grid-cols-2 gap-3">
                    <label className="flex flex-col gap-1">
                      <span className="text-[10.5px] text-muted-foreground">Min</span>
                      <input type="number" min={1} value={form.headcount.min} onChange={(event) => setForm((prev) => ({ ...prev, headcount: { ...prev.headcount, min: Math.max(1, Math.round(Number(event.target.value) || 1)) } }))} className={`${INPUT_CLASS} tabular`} />
                    </label>
                    <label className="flex flex-col gap-1">
                      <span className="text-[10.5px] text-muted-foreground">Max</span>
                      <input type="number" min={1} value={form.headcount.max} onChange={(event) => setForm((prev) => ({ ...prev, headcount: { ...prev.headcount, max: Math.max(1, Math.round(Number(event.target.value) || 1)) } }))} className={`${INPUT_CLASS} tabular`} />
                    </label>
                  </div>
                </ConfigField>
                <ConfigField label="Blocked industries" hint="Deterministic kill when the LinkedIn industry contains any of these.">
                  <TagInput value={form.industries.blocked} onChange={(next) => setForm((prev) => ({ ...prev, industries: { ...prev.industries, blocked: next.slice(0, 50) } }))} placeholder="Staffing and Recruiting, …" disabled={false} ariaLabel="Blocked industries" />
                </ConfigField>
                <ConfigField label="Preferred industries" hint="Boosts the industry-fit factor; everything not blocked still flows through.">
                  <TagInput value={form.industries.preferred} onChange={(next) => setForm((prev) => ({ ...prev, industries: { ...prev.industries, preferred: next.slice(0, 50) } }))} placeholder="Manufacturing, Logistics, …" disabled={false} ariaLabel="Preferred industries" />
                </ConfigField>
                <ConfigField label="Evidence" hint="Postings older than the window stop counting; the top N descriptions feed JD scoring.">
                  <div className="grid grid-cols-2 gap-3">
                    <label className="flex flex-col gap-1">
                      <span className="text-[10.5px] text-muted-foreground">Window (days)</span>
                      <input type="number" min={7} max={365} value={form.evidenceWindowDays} onChange={(event) => setForm((prev) => ({ ...prev, evidenceWindowDays: Math.min(365, Math.max(7, Math.round(Number(event.target.value) || 45))) }))} className={`${INPUT_CLASS} tabular`} />
                    </label>
                    <label className="flex flex-col gap-1">
                      <span className="text-[10.5px] text-muted-foreground">JDs read per company</span>
                      <input type="number" min={1} max={5} value={form.jdTopN} onChange={(event) => setForm((prev) => ({ ...prev, jdTopN: Math.min(5, Math.max(1, Math.round(Number(event.target.value) || 3))) }))} className={`${INPUT_CLASS} tabular`} />
                    </label>
                  </div>
                </ConfigField>
              </>
            ) : null}

            {section === "gates" ? (
              <>
                <ConfigField label="Agency screen" hint="Kills staffing agencies, recruiters, and job boards posting for unnamed clients.">
                  <textarea value={form.prompts.agency} onChange={(event) => setForm((prev) => ({ ...prev, prompts: { ...prev.prompts, agency: event.target.value } }))} rows={4} className={TEXTAREA_CLASS} />
                  <ModelSelect label="Model" value={form.models.agency} onChange={(next) => setForm((prev) => ({ ...prev, models: { ...prev.models, agency: next } }))} />
                </ConfigField>
                <ConfigField label="Title gate" hint="Runs before research so noise dies cheaply. Kills when no posting title is a valid automation/modernization role. When unsure, it kills (precision bias).">
                  <textarea value={form.prompts.titleGate} onChange={(event) => setForm((prev) => ({ ...prev, prompts: { ...prev.prompts, titleGate: event.target.value } }))} rows={4} className={TEXTAREA_CLASS} />
                  <ModelSelect label="Model" value={form.models.titleGate} onChange={(next) => setForm((prev) => ({ ...prev, models: { ...prev.models, titleGate: next } }))} />
                </ConfigField>
                <ConfigField label="JD scoring" hint="Reads the valid-title job descriptions and scores industry fit, title strength, and modernization signals.">
                  <textarea value={form.prompts.jdScoring} onChange={(event) => setForm((prev) => ({ ...prev, prompts: { ...prev.prompts, jdScoring: event.target.value } }))} rows={4} className={TEXTAREA_CLASS} />
                  <ModelSelect label="Model" value={form.models.jdScoring} onChange={(next) => setForm((prev) => ({ ...prev, models: { ...prev.models, jdScoring: next } }))} />
                </ConfigField>
                <ConfigField label="Headcount estimate" hint="Fills the size filter's estimate when no verified headcount exists.">
                  <ModelSelect label="Model" value={form.models.facts} onChange={(next) => setForm((prev) => ({ ...prev, models: { ...prev.models, facts: next } }))} />
                </ConfigField>
              </>
            ) : null}

            {section === "scoring" ? (
              <>
                <ConfigField label="Factor weights" hint="Relative importance — scores normalize to 0–100, so the threshold keeps its meaning when weights change.">
                  <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                    {(
                      [
                        ["sizeFit", "Size fit"],
                        ["industryFit", "Industry fit"],
                        ["titleStrength", "Title strength"],
                        ["jdSignals", "JD signals"],
                        ["evidenceVolume", "Evidence volume"],
                      ] as const
                    ).map(([key, label]) => (
                      <label key={key} className="flex flex-col gap-1">
                        <span className="text-[10.5px] text-muted-foreground">{label}</span>
                        <input
                          type="number"
                          min={0}
                          max={100}
                          value={form.weights[key]}
                          onChange={(event) => setForm((prev) => ({ ...prev, weights: { ...prev.weights, [key]: Math.min(100, Math.max(0, Math.round(Number(event.target.value) || 0))) } }))}
                          className={`${INPUT_CLASS} tabular`}
                        />
                      </label>
                    ))}
                  </div>
                </ConfigField>
                <ConfigField label="Qualified threshold" hint="Companies scoring at or above this land in the Qualified list as New.">
                  <input
                    type="number"
                    min={1}
                    max={100}
                    value={form.qualifiedThreshold}
                    onChange={(event) => setForm((prev) => ({ ...prev, qualifiedThreshold: Math.min(100, Math.max(1, Math.round(Number(event.target.value) || 70))) }))}
                    className={`${INPUT_CLASS} tabular w-28`}
                  />
                </ConfigField>
              </>
            ) : null}

            {section === "spend" ? (
              <>
                <ConfigField label="Per-run cap (USD)" hint="The run pauses (resumably) when the estimated model spend hits this.">
                  <input
                    type="number"
                    min={0.5}
                    step={0.5}
                    value={form.spend.perRunCapUsd}
                    onChange={(event) => setForm((prev) => ({ ...prev, spend: { ...prev.spend, perRunCapUsd: Math.max(0.5, Number(event.target.value) || 5) } }))}
                    className={`${INPUT_CLASS} tabular w-28`}
                  />
                </ConfigField>
                <ConfigField label="Per-company token cap" hint="No single company can consume more than this many model tokens in one pass.">
                  <input
                    type="number"
                    min={5000}
                    step={5000}
                    value={form.spend.perCompanyMaxTokens}
                    onChange={(event) => setForm((prev) => ({ ...prev, spend: { ...prev.spend, perCompanyMaxTokens: Math.max(5000, Math.round(Number(event.target.value) || 60000)) } }))}
                    className={`${INPUT_CLASS} tabular w-36`}
                  />
                </ConfigField>
              </>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}

function ModelSelect({ label, value, onChange }: { label: string; value: string; onChange: (next: string) => void }) {
  return (
    <label className="flex items-center gap-2">
      <span className="text-[10.5px] text-muted-foreground">{label}</span>
      <div className="relative">
        <select value={value} onChange={(event) => onChange(event.target.value)} className={SELECT_CLASS}>
          <option value="claude-haiku-4-5">Haiku 4.5 (cheap)</option>
          <option value="claude-sonnet-5">Sonnet 5</option>
          <option value="claude-opus-5">Opus 5</option>
        </select>
        <ChevronDown className="pointer-events-none absolute right-1.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
      </div>
    </label>
  );
}

/* ── Page client ──────────────────────────────────────────────────────── */

type ViewKey = CompaniesFilter["view"];

const PAGE_SIZE = 50;


export function SignalsClient({
  automation,
  onBack,
  initialPage,
  initialCounts,
  initialOpenRun,
  initialLastRun,
  initialConfig,
  initialSearches,
  initialError,
  tableLink,
}: {
  automation: AutomationDto;
  onBack: () => void;
  initialPage: CompaniesPage | null;
  initialCounts: FunnelCounts | null;
  initialOpenRun: FunnelRunDto | null;
  initialLastRun: FunnelRunDto | null;
  initialConfig: FunnelConfigVersion | null;
  initialSearches: SignalSearchDto[];
  initialError: string | null;
  tableLink: { name: string; href: string } | null;
}) {
  const showToast = useToast();
  const router = useRouter();
  const automationId = automation.id;

  const [config, setConfig] = useState<FunnelConfigVersion | null>(initialConfig);
  const [searches, setSearches] = useState<SignalSearchDto[]>(initialSearches);
  const [run, setRun] = useState<FunnelRunDto | null>(initialOpenRun);
  const [lastRun, setLastRun] = useState<FunnelRunDto | null>(initialLastRun);
  const [view, setView] = useState<ViewKey>("qualified");
  const [q, setQ] = useState("");
  const [rows, setRows] = useState<CompanyResultRow[]>(initialPage?.rows ?? []);
  const [total, setTotal] = useState(initialPage?.total ?? 0);
  const [counts, setCounts] = useState<FunnelCounts | null>(initialCounts);
  const [listLoading, setListLoading] = useState(false);
  const [moreLoading, setMoreLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(initialError);
  const [drawerCompanyId, setDrawerCompanyId] = useState<string | null>(null);
  const [configOpen, setConfigOpen] = useState(false);
  const [killedStage, setKilledStage] = useState<FunnelStage | null>(null);
  const [runStarting, setRunStarting] = useState(false);
  const [pushing, setPushing] = useState(false);
  const [bindOpen, setBindOpen] = useState(false);

  const threshold = config?.config.qualifiedThreshold ?? 70;

  const filterRef = useRef({ view, q, killedStage });
  useEffect(() => {
    filterRef.current = { view, q, killedStage };
  });

  const fetchPage = useCallback(async () => {
    const { view: viewNow, q: qNow, killedStage: stageNow } = filterRef.current;
    try {
      const result = await getCompaniesAction({ automationId, view: viewNow, reviewState: "all", killedStage: stageNow, q: qNow.trim() || null, limit: PAGE_SIZE, offset: 0 });
      const now = filterRef.current;
      if (now.view !== viewNow || now.q !== qNow || now.killedStage !== stageNow) return;
      if (!result.ok) {
        setLoadError(result.message);
        return;
      }
      setLoadError(null);
      setRows(result.page.rows);
      setTotal(result.page.total);
      setCounts(result.counts);
    } catch {
      setLoadError("Could not load companies. Try again.");
    }
  }, [automationId]);

  const firstRender = useRef(true);
  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    setListLoading(true);
    const timer = setTimeout(
      () => {
        void fetchPage().finally(() => setListLoading(false));
      },
      q ? 300 : 0,
    );
    return () => clearTimeout(timer);
  }, [view, q, killedStage, fetchPage]);

  const loadMore = async () => {
    setMoreLoading(true);
    try {
      const result = await getCompaniesAction({ automationId, view, reviewState: "all", killedStage, q: q.trim() || null, limit: PAGE_SIZE, offset: rows.length });
      if (result.ok) {
        setRows((prev) => [...prev, ...result.page.rows.filter((row) => !prev.some((item) => item.id === row.id))]);
        setTotal(result.page.total);
        setCounts(result.counts);
      } else {
        setLoadError(result.message);
      }
    } finally {
      setMoreLoading(false);
    }
  };

  /* ── Run loop: sequential ticks; each tick advances the run ── */

  const runRef = useRef(run);
  useEffect(() => {
    runRef.current = run;
  });
  const loopActive = useRef(false);
  useEffect(() => {
    if (!run || run.status !== "running" || loopActive.current) return;
    loopActive.current = true;
    let cancelled = false;

    const loop = async () => {
      let processedSinceRefresh = 0;
      while (!cancelled) {
        const current = runRef.current;
        if (!current || current.status !== "running") break;
        let next: FunnelRunDto | null = null;
        try {
          const result = await tickFunnelAction(current.id);
          if (!result.ok) {
            showToast(false, result.message);
            break;
          }
          next = result.run;
        } catch {
          // Transient network failure — retry on the next lap.
        }
        if (cancelled) break;
        if (next) {
          setRun(next);
          runRef.current = next;
          if (next.status === "succeeded") {
            showToast(true, `Funnel run finished: ${next.stats.qualified ?? 0} qualified, ${next.stats.killed ?? 0} killed${(next.stats.errored ?? 0) > 0 ? `, ${next.stats.errored} errored` : ""} · ~$${next.spendEstimateUsd.toFixed(2)} spent.`);
            setRun(null);
            setLastRun(next);
            void fetchPage();
            break;
          }
          if (next.status === "failed") {
            showToast(false, next.error ?? "The funnel run failed.");
            setRun(null);
            setLastRun(next);
            void fetchPage();
            break;
          }
          if (next.status === "paused") {
            showToast(false, next.error ?? "Run paused.");
            break;
          }
          processedSinceRefresh += 1;
          if (processedSinceRefresh >= 3) {
            processedSinceRefresh = 0;
            void fetchPage();
          }
        }
        await new Promise((resolve) => setTimeout(resolve, 1_200));
      }
      loopActive.current = false;
    };
    void loop();
    return () => {
      cancelled = true;
      loopActive.current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [run?.id, run?.status]);

  const startRun = async () => {
    if (runStarting) return;
    setRunStarting(true);
    try {
      const result = await runFunnelAction(automationId);
      if (result.ok) {
        setRun(result.run);
        showToast(true, "Funnel run started — scraping, then filtering and scoring.");
      } else {
        showToast(false, result.message);
      }
    } finally {
      setRunStarting(false);
    }
  };

  const startReevaluate = async (companyId: string | null) => {
    const result = await reevaluateAction(automationId, companyId);
    if (result.ok) {
      setRun(result.run);
      setDrawerCompanyId(null);
      setConfigOpen(false);
      showToast(true, companyId ? "Re-evaluating this company." : "Re-evaluating all companies against the active config.");
    } else {
      showToast(false, result.message);
    }
  };

  const controlRun = async (action: "pause" | "resume" | "stop") => {
    if (!run) return;
    const result = await controlFunnelAction(run.id, action);
    if (result.ok) {
      if (result.run.status === "failed" || result.run.status === "succeeded") {
        setRun(null);
        setLastRun(result.run);
        void fetchPage();
      } else {
        setRun(result.run);
      }
    } else {
      showToast(false, result.message);
    }
  };

  const runPill = () => {
    if (!run) return null;
    const phase = run.stats.phase === "scraping"
      ? `Scraping ${run.stats.scrapesDone ?? 0}/${run.stats.scrapesTotal ?? run.searchIds.length}`
      : `Processing · ${run.stats.companiesRemaining ?? "…"} left`;
    return (
      <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 text-[11px] font-medium leading-6 ${run.status === "paused" ? "bg-warning-soft text-warning" : "bg-info-soft text-info"}`}>
        {run.status === "paused" ? <Pause className="size-3" /> : <Loader2 className="size-3 animate-spin" />}
        {run.status === "paused" ? "Paused" : phase} · ~${run.spendEstimateUsd.toFixed(2)}
      </span>
    );
  };

  const visibleRows = view === "qualified" ? rows.filter((row) => row.reviewState !== "archived") : rows;
  const readyCount = view === "qualified"
    ? visibleRows.reduce((sum, row) => sum + row.picks.filter((pick) => pick.emailStatus === "found" && !pick.pushedAt).length, 0)
    : 0;

  const [busyContactId, setBusyContactId] = useState<string | null>(null);
  const findEmailInline = async (contactId: string) => {
    setBusyContactId(contactId);
    try {
      const result = await findContactEmailAction(contactId);
      if (!result.ok) showToast(false, result.message);
      else if (result.contact.emailStatus === "found") showToast(true, `Email found via ${result.contact.emailSource}.`);
      else showToast(false, result.contact.emailError ?? "No email found.");
      void fetchPage();
    } finally {
      setBusyContactId(null);
    }
  };

  const pushReady = async () => {
    setPushing(true);
    try {
      const result = await pushLeadListAction(automationId);
      if (!result.ok) {
        showToast(false, result.message);
        return;
      }
      const { pushed, linked, skipped, held } = result.result;
      const parts = [pushed ? `${pushed} pushed` : null, linked ? `${linked} linked` : null, held ? `${held} held for later` : null, skipped ? `${skipped} skipped` : null].filter(Boolean);
      showToast(true, parts.length ? `${parts.join(", ")} — Enrichment takes over from here.` : "Nothing new to push.");
      void fetchPage();
    } finally {
      setPushing(false);
    }
  };

  // Auto vs manual push. Auto = the cron pushes ready leads, runs the
  // pre-configured enrichment chain, and exports to the campaign as each lead
  // passes email review — no buttons. Optimistic with revert on failure.
  const [autopush, setAutopush] = useState(automation.autopush);
  const [autopushSaving, setAutopushSaving] = useState(false);
  const setPushMode = async (next: boolean) => {
    if (next === autopush || autopushSaving) return;
    setAutopush(next);
    setAutopushSaving(true);
    try {
      const result = await updateAutomationAction(automationId, { autopush: next });
      if (!result.ok) {
        setAutopush(!next);
        showToast(false, result.message);
        return;
      }
      showToast(true, next ? "Auto-pilot on: pushes, enriches and exports on the 10-minute cron." : "Manual mode: leads wait for the push button.");
    } finally {
      setAutopushSaving(false);
    }
  };

  const qualifiedCount = counts?.totals.qualified ?? 0;

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* One automation's screen: its name, where it sends, and the controls.
          The page description and the signal-type nav both live on the
          automations list now — this header is about THIS play, so it carries
          nothing that repeats on every visit. */}
      <header className="flex h-14 shrink-0 items-center gap-3 border-b border-border bg-surface px-4">
        <button type="button" onClick={onBack} aria-label="All automations" className={`${BTN_GHOST} h-7 shrink-0 px-2 text-[11.5px]`}>
          <ArrowLeft className="size-3.5" />
          Automations
        </button>
        <h1 className="min-w-0 shrink truncate text-[15px] font-semibold tracking-tight">{automation.name}</h1>
        <div className="ml-auto flex shrink-0 items-center gap-2">
          {runPill()}
          {run ? (
            <>
              {run.status === "running" ? (
                <button type="button" aria-label="Pause run" data-tip="Pause" data-tip-down="" onClick={() => void controlRun("pause")} className={`${BTN_OUTLINE} size-7 p-0`}>
                  <Pause className="size-3.5" />
                </button>
              ) : (
                <button type="button" aria-label="Resume run" data-tip="Resume" data-tip-down="" onClick={() => void controlRun("resume")} className={`${BTN_OUTLINE} size-7 p-0`}>
                  <Play className="size-3.5" />
                </button>
              )}
              <button type="button" aria-label="Stop run" data-tip="Stop" data-tip-down="" onClick={() => void controlRun("stop")} className={`${BTN_OUTLINE} size-7 p-0`}>
                <Square className="size-3.5" />
              </button>
            </>
          ) : (
            <button type="button" disabled={runStarting} onClick={() => void startRun()} className={`${BTN_PRIMARY} h-7 px-2.5 text-[11.5px]`}>
              {runStarting ? <Loader2 className="size-3.5 animate-spin" /> : <Play className="size-3.5" />}
              Run funnel
            </button>
          )}
          <button type="button" onClick={() => setConfigOpen(true)} className={`${BTN_OUTLINE} h-7 px-2.5 text-[11.5px]`}>
            <Settings2 className="size-3.5" />
            Config
          </button>
        </div>
      </header>

      {/* ── Pipeline strip: the whole journey this automation's leads take.
          Signals is where you are; the other two stops are links, so the
          connection between tabs is drawn on screen instead of remembered. */}
      <div className="flex h-9 shrink-0 items-center gap-1.5 overflow-x-auto whitespace-nowrap border-b border-border bg-surface px-4 text-[11.5px]">
        <span className="mr-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Pipeline</span>
        <span className="inline-flex h-6 shrink-0 items-center rounded-full bg-accent px-2.5 font-medium text-accent-foreground">
          Signals · {qualifiedCount} qualified
        </span>
        <ChevronRight className="size-3.5 shrink-0 text-muted-foreground/50" />
        {tableLink ? (
          <Link
            href={tableLink.href}
            className="inline-flex h-6 shrink-0 items-center gap-1 rounded-full bg-muted px-2.5 font-medium text-muted-foreground transition-colors hover:text-foreground"
            data-tip="The enrichment table pushed leads land in"
            data-tip-down=""
          >
            Enrichment · {tableLink.name}
            <ArrowUpRight className="size-3" />
          </Link>
        ) : (
          <span
            className="inline-flex h-6 shrink-0 items-center rounded-full bg-muted/50 px-2.5 text-muted-foreground/60"
            data-tip="Appears after the first push"
            data-tip-down=""
          >
            Enrichment · no leads pushed yet
          </span>
        )}
        <ChevronRight className="size-3.5 shrink-0 text-muted-foreground/50" />
        {automation.campaignId && automation.campaignName ? (
          <>
            <Link
              href={`/campaigns?c=${encodeURIComponent(automation.campaignId)}`}
              className="inline-flex h-6 min-w-0 shrink items-center gap-1 rounded-full bg-muted px-2.5 font-medium text-muted-foreground transition-colors hover:text-foreground"
              data-tip="The campaign exported leads send from"
              data-tip-down=""
            >
              <span className="truncate">Campaign · {automation.campaignName}</span>
              <ArrowUpRight className="size-3 shrink-0" />
            </Link>
            <button
              type="button"
              onClick={() => setBindOpen(true)}
              aria-label="Change campaign"
              data-tip="Change campaign"
              data-tip-down=""
              className="flex size-6 shrink-0 items-center justify-center rounded-full text-muted-foreground/60 transition-colors hover:bg-muted hover:text-foreground"
            >
              <Settings2 className="size-3" />
            </button>
          </>
        ) : (
          <button
            type="button"
            onClick={() => setBindOpen(true)}
            className="inline-flex h-6 shrink-0 items-center rounded-full bg-warning-soft px-2.5 font-medium text-warning transition hover:opacity-80"
          >
            Bind a campaign
          </button>
        )}
      </div>

      {/* One toolbar, one list. The push button is the only action; everything
          that used to be a tab row is either a quiet link (rejects) or gone. */}
      <div className="flex h-11 shrink-0 items-center gap-2 border-b border-border bg-surface px-4">
        {view === "qualified" ? (
          <>
            <div
              role="group"
              aria-label="Push mode"
              className="flex items-center gap-0.5 rounded-md border border-border bg-surface p-0.5 shadow-xs"
            >
              <button
                type="button"
                aria-pressed={autopush}
                disabled={autopushSaving}
                onClick={() => void setPushMode(true)}
                data-tip="Push, enrich and export automatically on the 10-minute cron"
                data-tip-down=""
                className={`flex h-6 items-center gap-1 rounded px-2 text-[11px] font-medium transition-colors ${
                  autopush ? "bg-muted text-foreground" : "text-muted-foreground hover:text-foreground"
                }`}
              >
                <Zap className="size-3" />
                Auto
              </button>
              <button
                type="button"
                aria-pressed={!autopush}
                disabled={autopushSaving}
                onClick={() => void setPushMode(false)}
                data-tip="Leads wait until you press the push button"
                data-tip-down=""
                className={`flex h-6 items-center rounded px-2 text-[11px] font-medium transition-colors ${
                  !autopush ? "bg-muted text-foreground" : "text-muted-foreground hover:text-foreground"
                }`}
              >
                Manual
              </button>
            </div>
            {autopush ? (
              <span className="inline-flex items-center gap-1.5 text-[11.5px] text-muted-foreground">
                <span className="size-1.5 rounded-full bg-success" />
                Pushes, enriches &amp; exports automatically
                {readyCount > 0 ? <span className="tabular-nums">· {readyCount} queued</span> : null}
              </span>
            ) : (
              <button
                type="button"
                disabled={pushing || readyCount === 0}
                onClick={() => void pushReady()}
                className={`${BTN_PRIMARY} h-7 px-2.5 text-[11.5px]`}
                data-tip={readyCount === 0 ? "No leads with a found email yet" : undefined}
                data-tip-down=""
              >
                {pushing ? <Loader2 className="size-3.5 animate-spin" /> : <Send className="size-3.5" />}
                Push {readyCount > 0 ? `${readyCount} ` : ""}to campaign
              </button>
            )}
            <div className="relative w-56">
              <SearchIcon className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <input value={q} onChange={(event) => setQ(event.target.value)} placeholder="Company, industry, person…" aria-label="Filter" className={`${INPUT_CLASS} pl-7`} />
            </div>
            <div className="ml-auto flex items-center gap-3 text-[11.5px]">
              {(counts?.totals.errored ?? 0) > 0 ? (
                <button type="button" onClick={() => setView("errored")} className="text-warning underline-offset-2 transition hover:underline">
                  {counts?.totals.errored} errored ›
                </button>
              ) : null}
              <button type="button" onClick={() => setView("killed")} className="text-muted-foreground underline-offset-2 transition hover:text-foreground hover:underline">
                {counts?.totals.killed ?? 0} filtered out ›
              </button>
            </div>
          </>
        ) : (
          <>
            <button type="button" onClick={() => { setView("qualified"); setKilledStage(null); }} className={`${BTN_GHOST} h-7 px-2 text-[11.5px]`}>
              <ArrowLeft className="size-3.5" />
              Results
            </button>
            <span className="text-[12px] font-medium">
              {view === "errored" ? `Errored · ${counts?.totals.errored ?? 0}` : `Filtered out · ${counts?.totals.killed ?? 0}`}
            </span>
            {view === "killed" ? (
              <div className="relative">
                <select
                  value={killedStage ?? ""}
                  onChange={(event) => setKilledStage((event.target.value || null) as FunnelStage | null)}
                  aria-label="Filter by killing stage"
                  className={SELECT_CLASS}
                >
                  <option value="">Any reason</option>
                  {FUNNEL_STAGES.map((stage) => {
                    const kills = counts?.stages[stage]?.kill ?? 0;
                    return (
                      <option key={stage} value={stage}>
                        {FUNNEL_STAGE_LABELS[stage]}
                        {kills > 0 ? ` · ${kills}` : ""}
                      </option>
                    );
                  })}
                </select>
                <ChevronDown className="pointer-events-none absolute right-1.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
              </div>
            ) : null}
            <div className="relative ml-auto w-52">
              <SearchIcon className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <input value={q} onChange={(event) => setQ(event.target.value)} placeholder="Company, industry…" aria-label="Filter" className={`${INPUT_CLASS} pl-7`} />
            </div>
          </>
        )}
      </div>

      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-5xl flex-col gap-3 px-5 py-4">
          <>
          {view === "qualified" && !run && lastRun ? <LastRunLine run={lastRun} /> : null}
          {loadError ? (
            <div className="flex items-center gap-2 rounded-lg bg-destructive-soft px-3 py-2.5 text-[12px] text-destructive">
              <ShieldAlert className="size-3.5 shrink-0" />
              <span className="min-w-0 break-words">{loadError}</span>
              <button
                type="button"
                onClick={() => {
                  setListLoading(true);
                  void fetchPage().finally(() => setListLoading(false));
                }}
                className="ml-auto shrink-0 text-[11px] font-medium underline-offset-2 hover:underline"
              >
                Retry
              </button>
            </div>
          ) : null}

          {listLoading ? (
            <div className="flex flex-col gap-px overflow-hidden rounded-xl bg-surface shadow-xs">
              {[0, 1, 2, 3, 4, 5].map((index) => (
                <div key={index} className="flex items-center gap-3 px-3 py-2.5">
                  <div className="h-6 w-9 animate-pulse rounded-md bg-muted" />
                  <div className="size-8 animate-pulse rounded-md bg-muted" />
                  <div className="flex flex-1 flex-col gap-1.5">
                    <div className="h-3.5 w-56 animate-pulse rounded bg-muted" />
                    <div className="h-3 w-40 animate-pulse rounded bg-muted" />
                  </div>
                </div>
              ))}
            </div>
          ) : visibleRows.length === 0 ? (
            view === "qualified" && qualifiedCount === 0 && !q ? (
              <div className="flex flex-col items-center gap-3 rounded-xl bg-surface px-6 py-16 text-center shadow-xs">
                <span className="flex size-12 items-center justify-center rounded-full bg-accent text-accent-foreground">
                  <Radar className="size-5" strokeWidth={1.75} />
                </span>
                <div className="max-w-md">
                  <h2 className="text-[15px] font-semibold tracking-tight">No qualified companies yet</h2>
                  <p className="mt-1 text-[12.5px] leading-relaxed text-muted-foreground">
                    {run
                      ? "The funnel is running — qualified companies will appear here as they clear the gates."
                      : counts && counts.totals.companies > 0
                        ? "Run the funnel to filter and score the scraped companies, or loosen the filters in Config."
                        : "Run the funnel: it scrapes your searches, kills the noise (agencies, wrong industry, QA roles), researches the rest, and scores what's left."}
                  </p>
                </div>
                {!run ? (
                  <button type="button" disabled={runStarting} onClick={() => void startRun()} className={`${BTN_PRIMARY} h-8 px-3.5 text-[12px]`}>
                    {runStarting ? <Loader2 className="size-3.5 animate-spin" /> : <Play className="size-3.5" />}
                    Run funnel
                  </button>
                ) : null}
              </div>
            ) : (
              <div className="px-1 py-10 text-center text-[12px] text-muted-foreground">
                {q ? "Nothing matches this filter." : "Nothing here."}
              </div>
            )
          ) : (
            <>
              {view === "qualified" ? (
                <div className="flex flex-col gap-2.5">
                  {visibleRows.map((row) => (
                    <CompanyGroup key={row.id} row={row} threshold={threshold} busyContactId={busyContactId} onOpen={() => setDrawerCompanyId(row.id)} onFindEmail={(contactId) => void findEmailInline(contactId)} />
                  ))}
                </div>
              ) : (
              <div className="flex flex-col divide-y divide-border overflow-hidden rounded-xl bg-surface shadow-xs">
                {visibleRows.map((row) => (
                  <CompanyRow key={row.id} row={row} threshold={threshold} onOpen={() => setDrawerCompanyId(row.id)} />
                ))}
              </div>
              )}
              {rows.length < total ? (
                <button type="button" disabled={moreLoading} onClick={() => void loadMore()} className={`${BTN_OUTLINE} h-8 self-center px-3 text-[12px]`}>
                  {moreLoading ? <Loader2 className="size-3.5 animate-spin" /> : null}
                  Load more ({rows.length} of {total})
                </button>
              ) : null}
            </>
          )}


          </>
        </div>
      </div>

      {drawerCompanyId ? (
        <CompanyDrawer
          companyId={drawerCompanyId}
          threshold={threshold}
          onClose={() => setDrawerCompanyId(null)}
          onChanged={() => void fetchPage()}
          onReevaluate={(companyId) => void startReevaluate(companyId)}
        />
      ) : null}

      {bindOpen ? (
        <BindCampaignModal
          automationId={automationId}
          automationName={automation.name}
          current={automation.campaignId && automation.campaignName ? { id: automation.campaignId, name: automation.campaignName } : null}
          onClose={() => setBindOpen(false)}
          onChanged={() => router.refresh()}
        />
      ) : null}

      {configOpen && config ? (
        <ConfigDrawer
          automationId={automationId}
          config={config}
          searches={searches}
          onClose={() => setConfigOpen(false)}
          onSaved={(next) => setConfig(next)}
          onSearchesChanged={(next) => setSearches(next)}
          onReevaluateAll={() => void startReevaluate(null)}
        />
      ) : null}
    </div>
  );
}
