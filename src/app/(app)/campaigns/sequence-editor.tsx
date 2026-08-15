"use client";

/* ── Sequence editor ───────────────────────────────────────────────────────
   The full-screen email-sequence authoring takeover, extracted from
   campaigns-client so other surfaces (Signals automations) can build a
   campaign's copy without leaving their own flow. Everything here is
   presentational and controlled: the draft state machine still lives in the
   host (campaigns-client's DetailPanel), which passes drafts down and receives
   mutations back. The only server calls are the two campaign-agnostic tools
   (spintax generation and the spam check) — neither takes a campaign id. */

import {
  Fragment,
  useEffect,
  useMemo,
  useRef,
  useState,
  useTransition,
  type FormEvent as ReactFormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";
import {
  ArrowDown,
  ArrowLeft,
  ArrowUp,
  Check,
  ChevronsUpDown,
  Copy,
  ExternalLink,
  Eye,
  PanelRightClose,
  PanelRightOpen,
  PenLine,
  Plus,
  RefreshCw,
  Search,
  Shuffle,
  Trash2,
  X,
} from "lucide-react";
import {
  buildPreviewHtml,
  parseSimpleHtml,
  resolveSpintax,
  substituteMergeTags,
} from "@/lib/email-copy";
import { buildSmartleadCampaignUrl } from "@/lib/smartlead/links";
import {
  checkSequenceSpamAction,
  generateSpintaxAction,
  listCampaignSenderAccountsAction,
  searchCampaignPreviewLeadsAction,
} from "./actions";
import { getModelOptionsAction } from "../enrichment/actions";
import { ModelPicker, type ModelOption } from "../enrichment/enrichment-dialogs";
import { AI_MODEL_OPTIONS } from "../enrichment/enrichment-model";

/* ── Contract mirrors (declared locally so the client never imports a server
   module — the campaigns file's mirror pattern). This module owns them; the
   campaigns client imports them from here so the two can never drift. ───── */
export type SequenceVariant = {
  id: number | null;
  label: string | null;
  subject: string;
  emailBody: string;
};
export type SequenceStep = {
  id: number | null;
  seqNumber: number;
  delayInDays: number;
  subject: string; // used when variants is null
  emailBody: string; // used when variants is null
  variants: SequenceVariant[] | null;
};

/* ── Shared style constants (copied conventions, intentionally not shared) ── */

const BTN_BASE = `inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-md font-medium transition disabled:cursor-not-allowed disabled:opacity-50`;
const BTN_PRIMARY = `${BTN_BASE} bg-primary text-primary-foreground shadow-xs hover:opacity-90`;
const BTN_OUTLINE = `${BTN_BASE} border border-border bg-surface text-foreground shadow-xs hover:border-border-strong hover:bg-muted/60`;

const INPUT_CLASS =
  "h-8 w-full rounded-md border border-border bg-surface px-2.5 text-[12.5px] text-foreground shadow-xs outline-none transition placeholder:text-muted-foreground focus:border-ring";
const TEXTAREA_MULTI =
  "w-full rounded-md border border-border bg-surface px-2.5 py-2 text-[12.5px] leading-relaxed text-foreground shadow-xs outline-none transition placeholder:text-muted-foreground focus:border-ring resize-y";

function clampInt(raw: string, min: number, max: number): number {
  const n = parseInt(raw, 10);
  if (Number.isNaN(n)) return min;
  return Math.min(max, Math.max(min, n));
}

/* A small accent dot that flags a row/field as overriding its default. */
function CustomizedDot({ title = "Customized" }: { title?: string }) {
  return <span data-tip={title} aria-label={title} className="size-1.5 shrink-0 rounded-full bg-primary" />;
}

/* ── Sequence editor model ─────────────────────────────────────────────────
   Fidelity contract: a body parses into human-editable plain text ONLY when
   it is entirely Smartlead's simple dialect (`parseSimpleHtml`); anything
   richer stays raw html so nothing is silently destroyed. The ORIGINAL html
   string always lives in the baseline steps — an untouched body is sent back
   byte-identical, and only genuinely edited text is re-encoded. */
export type BodyDraft = {
  mode: "text" | "raw";
  reason?: string; // why the body couldn't be parsed (raw mode only)
  baseline: string; // parsed text (text mode) or original html (raw mode)
  value: string; // current editable value
};
export type VariantDraft = { id: number | null; label: string | null; subject: string; body: BodyDraft };
export type StepDraft = {
  uid: string; // stable local identity — React keys + baseline mapping (NOT seqNumber)
  origin: SequenceStep | null; // baseline this draft came from; null for a NEW step
  seqNumber: number; // display only — recomputed to index + 1 on add/remove/reorder
  delayInDays: number;
  subject: string;
  body: BodyDraft | null; // null when the step uses variants
  variants: VariantDraft[] | null;
};

/* Smartlead-safe sanity cap on sequence length. */
export const MAX_SEQUENCE_STEPS = 10;

/* A/B testing cap per step. Smartlead supports variants; this is a UI-side cap. */
export const MAX_VARIANTS = 5;

/* Whether the xl+ preview pane is docked open. Same si-* namespace as the
   sidebar and theme keys. */
const PREVIEW_PANE_KEY = "si-sequence-preview";

let stepUidCounter = 0;
function makeStepUid(): string {
  stepUidCounter += 1;
  return `step-${stepUidCounter}`;
}

function bodyDraftFrom(html: string): BodyDraft {
  const parsed = parseSimpleHtml(html);
  return parsed.ok
    ? { mode: "text", baseline: parsed.text, value: parsed.text }
    : { mode: "raw", reason: parsed.reason, baseline: html, value: html };
}

export function draftsFromSteps(steps: SequenceStep[]): StepDraft[] {
  return steps.map((step) => {
    const variants = step.variants && step.variants.length > 0 ? step.variants : null;
    return {
      uid: makeStepUid(),
      origin: step,
      seqNumber: step.seqNumber,
      delayInDays: step.delayInDays,
      subject: step.subject,
      body: variants ? null : bodyDraftFrom(step.emailBody),
      variants: variants
        ? variants.map((variant) => ({
            id: variant.id,
            label: variant.label,
            subject: variant.subject,
            body: bodyDraftFrom(variant.emailBody),
          }))
        : null,
    };
  });
}

/* A blank appended step: no id yet (id null goes up on save), text body, and a
   same-thread default (empty subject — step ≥2 with no subject is a reply). */
export function newStepDraft(seqNumber: number): StepDraft {
  return {
    uid: makeStepUid(),
    origin: null,
    seqNumber,
    // Email 1's delay is measured from when the lead is added, so it opens at 0
    // — a first touch should not sit in a queue. Follow-ups default to 3 days.
    delayInDays: seqNumber === 1 ? 0 : 3,
    subject: "",
    body: { mode: "text", baseline: "", value: "" },
    variants: null,
  };
}

/* The steps ARRAY order is truth: after any add/remove/reorder, seqNumber is
   just index + 1 for every step (each step's id/subject/body/delay travel with
   the step content, so only the display number is rewritten). */
export function renumberSteps(drafts: StepDraft[]): StepDraft[] {
  return drafts.map((draft, index) =>
    draft.seqNumber === index + 1 ? draft : { ...draft, seqNumber: index + 1 },
  );
}

/* Per-step dirty check — the exact comparisons the sequence dirty flag has
   always used, factored so the editor rail can badge individual steps. */
function stepDraftDirty(draft: StepDraft, step: SequenceStep): boolean {
  if (draft.delayInDays !== step.delayInDays) return true;
  // A structural switch between a single body and variants is always a change.
  const originHasVariants = Boolean(step.variants && step.variants.length > 0);
  const draftHasVariants = Boolean(draft.variants && draft.variants.length > 0);
  if (originHasVariants !== draftHasVariants) return true;
  if (draft.body && (draft.subject !== step.subject || draft.body.value !== draft.body.baseline))
    return true;
  const stepVariants = step.variants;
  if (draft.variants && stepVariants) {
    // Added or removed a variant.
    if (draft.variants.length !== stepVariants.length) return true;
    for (let j = 0; j < draft.variants.length; j += 1) {
      const vd = draft.variants[j];
      const sv = stepVariants[j];
      if (!sv) return true;
      if (vd.subject !== sv.subject || vd.body.value !== vd.body.baseline) return true;
      if ((vd.label ?? "") !== (sv.label ?? "")) return true;
    }
  }
  return false;
}

/* Content dirtiness that maps to the step object (via its origin), not its
   position: a NEW step (no origin) is always dirty, an edited step diverges
   from the baseline it came from. Reorder/removal are array-level (below). */
export function draftIsDirty(draft: StepDraft): boolean {
  return draft.origin === null || stepDraftDirty(draft, draft.origin);
}

/* Empty subject = same-thread send; borrow the nearest earlier subject so
   summaries and previews read like the real thread. */
function previousThreadSubject(drafts: StepDraft[], stepIndex: number): string | null {
  for (let i = stepIndex - 1; i >= 0; i -= 1) {
    const draft = drafts[i];
    const subject = draft.body ? draft.subject : draft.variants?.[0]?.subject ?? "";
    if (subject.trim()) return subject;
  }
  return null;
}

/* Whether any body in the step is raw html (can't be text-edited). */
function stepHasRawBody(draft: StepDraft): boolean {
  if (draft.body?.mode === "raw") return true;
  return draft.variants?.some((variant) => variant.body.mode === "raw") ?? false;
}

function variantLabelText(variant: VariantDraft, index: number): string {
  return variant.label && variant.label.trim()
    ? variant.label.trim()
    : `Variant ${String.fromCharCode(65 + index)}`;
}

/* ── Readable copy rendering (summary timeline) ────────────────────────────
   Merge tags render as inline amber chips WITHOUT dangerouslySetInnerHTML:
   the text is split on the merge-tag pattern and each token becomes either a
   plain text node or a chip element. Line breaks survive via
   whitespace-pre-wrap on the container. */
const MERGE_TAG_SPLIT = /(\{\{\s*[a-zA-Z0-9_.]+\s*\}\})/g;
const MERGE_TAG_EXACT = /^\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}$/;

function MergeTagText({ text }: { text: string }) {
  const parts = text.split(MERGE_TAG_SPLIT);
  return (
    <>
      {parts.map((part, index) => {
        const tag = MERGE_TAG_EXACT.exec(part);
        if (tag) {
          return (
            <span
              key={index}
              className="rounded bg-warning-soft px-[3px] text-[0.92em] font-medium text-warning"
            >
              {tag[1]}
            </span>
          );
        }
        return <Fragment key={index}>{part}</Fragment>;
      })}
    </>
  );
}

/* A brace group containing a pipe = spintax (merge tags are alphanumeric-only
   so they never match). Presence is all the summary badge needs. */
function hasSpintax(text: string): boolean {
  return /\{[^{}]*\|[^{}]*\}/.test(text);
}

/* ── Copy card (summary timeline) ──────────────────────────────────────────
   One readable email per card: resolved subject, first-option spintax body
   with merge-tag chips, meta badges. The whole card is a button that opens
   the full-screen editor at this step. */
export function SequenceCopyCard({
  draft,
  index,
  onOpen,
}: {
  draft: StepDraft;
  index: number;
  onOpen: () => void;
}) {
  const body = draft.body ?? draft.variants?.[0]?.body ?? null;
  const subjectRaw = draft.body ? draft.subject : draft.variants?.[0]?.subject ?? "";
  const isRaw = body?.mode === "raw";
  // Raw bodies show their tag-stripped text; text bodies show the copy as-is.
  const bodyText = body
    ? isRaw
      ? body.value.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim()
      : body.value
    : "";
  const resolvedBody = resolveSpintax(bodyText, "first");
  const resolvedSubject = subjectRaw.trim() ? resolveSpintax(subjectRaw, "first") : null;
  const spintaxPresent = hasSpintax(bodyText) || hasSpintax(subjectRaw);
  // Clamp long copy (~8 lines) behind a bottom fade; heuristic keeps short
  // cards mask-free so their last line never washes out.
  const clamped = resolvedBody.split("\n").length > 8 || resolvedBody.length > 600;

  return (
    <button
      type="button"
      onClick={onOpen}
      className={`group relative w-full rounded-xl border border-border bg-surface p-4 text-left shadow-xs transition hover:border-border-strong hover:shadow-pop`}
    >
      {/* Hover/focus Edit affordance */}
      <span
        aria-hidden
        className={`${BTN_OUTLINE} pointer-events-none absolute right-3 top-3 h-7 px-2.5 text-[11.5px] opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100`}
      >
        <PenLine className="size-3" />
        Edit
      </span>

      <div className="flex flex-col gap-1 pr-16">
        {index === 0 ? (
          <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
            {draft.delayInDays === 0
              ? "Sends when the lead is added"
              : `Sends ${draft.delayInDays} day${draft.delayInDays === 1 ? "" : "s"} after the lead is added`}
          </span>
        ) : null}
        <div className="text-[13px] font-medium leading-snug">
          {resolvedSubject ? (
            <MergeTagText text={resolvedSubject} />
          ) : (
            <span className="font-normal italic text-muted-foreground">
              Same thread as previous email
            </span>
          )}
        </div>
      </div>

      <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
        {draft.variants ? (
          <span
            data-tip="Showing Variant A"
            className="rounded bg-muted px-1.5 py-px text-[10px] font-medium text-muted-foreground"
          >
            A/B ×{draft.variants.length} · Variant A shown
          </span>
        ) : null}
        {spintaxPresent ? (
          <span className="rounded bg-muted px-1.5 py-px text-[10px] font-medium text-muted-foreground">
            Spintax · first variation shown
          </span>
        ) : null}
        {isRaw ? (
          <span
            data-tip={body?.reason}
            className="rounded bg-warning-soft px-1.5 py-px text-[10px] font-medium text-warning"
          >
            Raw HTML
          </span>
        ) : null}
      </div>

      <div className={`relative mt-3 ${clamped ? "max-h-[10.5rem] overflow-hidden" : ""}`}>
        <p className="whitespace-pre-wrap text-[12.5px] leading-relaxed text-foreground/90">
          <MergeTagText text={resolvedBody} />
        </p>
        {clamped ? (
          <span
            aria-hidden
            className="pointer-events-none absolute inset-x-0 bottom-0 h-10 bg-gradient-to-t from-surface to-transparent"
          />
        ) : null}
      </div>
    </button>
  );
}

/* ── Gmail-style preview ───────────────────────────────────────────────────
   Rendered inside a sandboxed iframe (no scripts, isolated CSS) so neither
   the app theme nor the previewed html can bleed either way. Always light,
   like Gmail's default reading pane. */

/* Real lead data for the preview (like Smartlead's own preview): merged
   computed tags (day-of-week etc.) + the first populated lead's fields.
   Fetched once per campaign, cached at the root. */
export type PreviewLeadData = {
  label: string | null; // "Jane Doe · Acme" or null when no lead was found
  values: Record<string, string>;
};

/* A rendered preview snapshot. Spintax is resolved when this is built (so
   typing with the debounced "first" mode never reshuffles); merge tags are
   substituted with the lead's real values, unknown tags become amber chips. */
type PreviewRender = {
  subjectText: string | null; // null → same-thread note in the Gmail chrome
  bodyHtml: string;
};

function buildPreviewRender(
  subjectRaw: string | null,
  source: string,
  isHtml: boolean,
  values: Record<string, string> | undefined,
  mode: "first" | "random",
): PreviewRender {
  return {
    subjectText: subjectRaw ? substituteMergeTags(resolveSpintax(subjectRaw, mode), values) : null,
    bodyHtml: buildPreviewHtml(source, { isHtml, spintax: mode, values }),
  };
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function gmailPreviewSrcdoc(input: {
  subjectText: string | null;
  senderName: string;
  senderEmail: string | null;
  avatarUrl: string | null;
  toName: string;
  bodyHtml: string;
}): string {
  const name = escapeHtml(input.senderName);
  const toName = escapeHtml(input.toName);
  const initial = escapeHtml((input.senderName.trim()[0] ?? "Y").toUpperCase());
  // The real Zapmail profile picture when the sending account has one — the
  // letter fallback doubles as a "this account sends faceless" tell.
  const avatar = input.avatarUrl
    ? `<img class="avatar" src="${escapeHtml(input.avatarUrl)}" alt="">`
    : `<div class="avatar">${initial}</div>`;
  const addr = input.senderEmail ? escapeHtml(input.senderEmail) : "via your Smartlead sender";
  const subject = input.subjectText
    ? escapeHtml(input.subjectText)
    : `<span style="color:#80868b;font-style:italic;">(same thread as previous step)</span>`;
  const time = new Date().toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  return `<!doctype html>
<html><head><meta charset="utf-8"><style>
  body{margin:0;background:#fff;color:#222;font-family:'Google Sans',Roboto,Arial,sans-serif;}
  .wrap{max-width:680px;margin:0 auto;padding:24px 28px;}
  .subject{font-size:20px;font-weight:400;color:#1f1f1f;margin:0 0 6px;line-height:1.3;}
  .labels{margin:0 0 20px;}
  .label{display:inline-block;background:#eeeeee;border-radius:4px;color:#5e5e5e;font-size:11px;padding:2px 6px;}
  .sender{display:flex;align-items:flex-start;gap:12px;margin-bottom:20px;}
  .avatar{width:40px;height:40px;border-radius:50%;background:#673ab7;color:#fff;display:flex;align-items:center;justify-content:center;font-size:18px;flex:none;object-fit:cover;}
  .meta{flex:1;min-width:0;}
  .name{font-size:14px;font-weight:700;color:#1f1f1f;}
  .addr{font-size:12px;color:#5e5e5e;font-weight:400;}
  .to{font-size:12px;color:#5e5e5e;margin-top:1px;}
  .time{font-size:12px;color:#5e5e5e;white-space:nowrap;}
  .body{font-size:13.5px;line-height:1.5;color:#222;text-align:left;word-wrap:break-word;}
  .actions{margin-top:28px;display:flex;gap:8px;}
  .pill{border:1px solid #747775;border-radius:18px;padding:7px 20px;font-size:13px;font-weight:500;color:#444746;background:#fff;}
</style></head><body><div class="wrap">
  <h1 class="subject">${subject}</h1>
  <p class="labels"><span class="label">Inbox &times;</span></p>
  <div class="sender">
    ${avatar}
    <div class="meta">
      <div><span class="name">${name}</span> <span class="addr">&lt;${addr}&gt;</span></div>
      <div class="to">to ${toName} &#9662;</div>
    </div>
    <div class="time">${time} (2 minutes ago)</div>
  </div>
  <div class="body">${input.bodyHtml}</div>
  <div class="actions"><span class="pill">&#8617; Reply</span><span class="pill">&#8618; Forward</span></div>
</div></body></html>`;
}

/* ── Preview lead picker ───────────────────────────────────────────────────
   Smartlead-style: preview any lead from the campaign, not just the first
   populated one. A combobox in the preview footer — the trigger shows the
   current lead; opening it searches the campaign's leads by name, email, or
   company (server-scanned, since Smartlead's leads endpoint has no search
   parameter). Selecting a lead swaps the whole preview context: merge-tag
   substitution, variable examples, and the known-token checks all follow. */

/* Contract mirror of the search action's PreviewLeadOption (the file's
   mirror pattern — the client never imports a server module's types). */
type PreviewLeadOption = { label: string; values: Record<string, string> };

const PREVIEW_PICKER_DEBOUNCE_MS = 300;

function PreviewLeadPicker({
  campaignId,
  lead,
  onSelect,
}: {
  campaignId: string;
  lead: PreviewLeadData;
  onSelect: (lead: PreviewLeadData) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [options, setOptions] = useState<PreviewLeadOption[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [exhausted, setExhausted] = useState(true);
  const [highlight, setHighlight] = useState(0);
  // Computed tags (sl_day_of_week…) ride along with every search response;
  // the latest set is merged into whichever lead gets picked.
  const computedRef = useRef<Record<string, string>>({});
  // Monotonic request id — a slow earlier search must never clobber a newer one.
  const requestSeq = useRef(0);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const runSearch = (value: string) => {
    const seq = ++requestSeq.current;
    setSearching(true);
    setError(null);
    void searchCampaignPreviewLeadsAction(campaignId, value).then((result) => {
      if (seq !== requestSeq.current) return;
      setSearching(false);
      if (result.ok && result.leads) {
        setOptions(result.leads);
        setExhausted(result.exhausted ?? true);
        setHighlight(0);
        if (result.computed) computedRef.current = result.computed;
      } else {
        setError(result.message);
      }
    });
  };

  // Debounced search while open; opening fires immediately (empty query =
  // the campaign's first leads, so the list is never blank on open).
  useEffect(() => {
    if (!open) return;
    const timer = setTimeout(() => runSearch(query), options === null ? 0 : PREVIEW_PICKER_DEBOUNCE_MS);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, query]);

  const openPicker = () => {
    setOpen(true);
    requestAnimationFrame(() => inputRef.current?.focus());
  };
  const closePicker = () => {
    setOpen(false);
    setQuery("");
  };

  const pick = (option: PreviewLeadOption) => {
    onSelect({ label: option.label, values: { ...computedRef.current, ...option.values } });
    closePicker();
  };

  const list = options ?? [];
  const active = Math.min(highlight, Math.max(list.length - 1, 0));
  const onSearchKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      if (list.length > 0) setHighlight((active + 1) % list.length);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      if (list.length > 0) setHighlight((active - 1 + list.length) % list.length);
    } else if (event.key === "Enter") {
      event.preventDefault();
      if (list[active]) pick(list[active]);
    } else if (event.key === "Escape") {
      // Consume it here so the takeover's window listener doesn't close.
      event.preventDefault();
      event.stopPropagation();
      closePicker();
    }
  };

  return (
    <div
      className="relative flex min-w-0"
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) closePicker();
      }}
    >
      <button
        type="button"
        onClick={() => (open ? closePicker() : openPicker())}
        aria-expanded={open}
        aria-haspopup="listbox"
        data-tip="Preview a different lead"
        className="flex min-w-0 items-center gap-1 rounded px-1 py-0.5 text-[11px] text-muted-foreground transition-colors hover:bg-muted/70 hover:text-foreground"
      >
        <span className="min-w-0 truncate font-medium text-foreground">{lead.label}</span>
        <ChevronsUpDown className="size-3 shrink-0" />
      </button>

      {open ? (
        <div className="absolute bottom-full left-0 z-30 mb-1.5 flex w-72 max-w-[80vw] flex-col rounded-lg border border-border bg-surface shadow-pop">
          <div className="flex items-center gap-1.5 border-b border-border px-2.5 py-2">
            <Search className="size-3 shrink-0 text-muted-foreground" />
            <input
              ref={inputRef}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={onSearchKeyDown}
              placeholder="Search by name, email, or company"
              className="w-full bg-transparent text-[12px] text-foreground outline-none placeholder:text-muted-foreground"
            />
          </div>
          <div role="listbox" aria-label="Preview lead" className="max-h-56 overflow-y-auto py-1">
            {error !== null ? (
              <p className="px-2.5 py-1.5 text-[11px] leading-relaxed text-destructive">{error}</p>
            ) : list.length === 0 ? (
              <p className="px-2.5 py-1.5 text-[11px] text-muted-foreground">
                {searching ? "Searching…" : query.trim() ? "No matching leads." : "No leads in this campaign yet."}
              </p>
            ) : (
              list.map((option, index) => (
                <button
                  key={`${option.values.email ?? option.label}-${index}`}
                  type="button"
                  role="option"
                  aria-selected={index === active}
                  tabIndex={-1}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => pick(option)}
                  onMouseEnter={() => setHighlight(index)}
                  className={`flex w-full flex-col px-2.5 py-1.5 text-left ${index === active ? "bg-muted/70" : ""}`}
                >
                  <span className="min-w-0 truncate text-[12px] font-medium">{option.label}</span>
                  {option.values.email ? (
                    <span className="min-w-0 truncate text-[11px] text-muted-foreground">
                      {option.values.email}
                    </span>
                  ) : null}
                </button>
              ))
            )}
          </div>
          {/* A stale flash of the previous list is worse than a quiet spinner
              line; searching shows under the results, not instead of them. */}
          {searching && list.length > 0 ? (
            <p className="border-t border-border px-2.5 py-1.5 text-[10.5px] text-muted-foreground">Searching…</p>
          ) : !exhausted ? (
            <p className="border-t border-border px-2.5 py-1.5 text-[10.5px] leading-relaxed text-muted-foreground">
              Searched the campaign&rsquo;s first 1,000 leads.
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/* Contract mirror of listCampaignSenderAccountsAction's sender rows. */
type PreviewSender = { email: string; name: string | null; avatarUrl: string | null };

/* ── Live preview pane (shared by the editor's side pane and its small-screen
   overlay) — the sandboxed Gmail iframe plus the sender/lead/spintax footer. */
function SequencePreviewPane({
  render,
  senderName,
  sender,
  senders,
  onSelectSender,
  campaignId,
  lead,
  leadLoading,
  onSelectLead,
  onShuffle,
}: {
  render: PreviewRender | null;
  senderName: string;
  sender: PreviewSender | null;
  senders: PreviewSender[];
  onSelectSender: (email: string) => void;
  campaignId: string;
  lead: PreviewLeadData | null;
  leadLoading: boolean;
  onSelectLead: (lead: PreviewLeadData) => void;
  onShuffle: () => void;
}) {
  const toName = (lead?.values.first_name ?? "").trim() || "lead";
  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* allow-same-origin WITHOUT allow-scripts: nothing can execute inside,
          but subresource requests are first-party — the /api/inbox-avatar
          proxy image needs the session cookie, which an opaque-origin iframe
          would strip. */}
      <iframe
        sandbox="allow-same-origin"
        title="Email preview"
        srcDoc={
          render
            ? gmailPreviewSrcdoc({
                subjectText: render.subjectText,
                senderName: sender?.name || senderName,
                senderEmail: sender?.email ?? null,
                avatarUrl: sender?.avatarUrl ?? null,
                toName,
                bodyHtml: render.bodyHtml,
              })
            : "<!doctype html><html><body style=\"background:#fff\"></body></html>"
        }
        className="w-full min-h-0 flex-1 bg-white"
      />
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-x-3 gap-y-1.5 border-t border-border px-3 py-2">
        {leadLoading && !lead ? (
          <span className="min-w-0 truncate text-[11px] text-muted-foreground">Loading lead data…</span>
        ) : lead?.label ? (
          <PreviewLeadPicker campaignId={campaignId} lead={lead} onSelect={onSelectLead} />
        ) : (
          <span className="min-w-0 truncate text-[11px] text-muted-foreground">
            No lead data yet. Variables shown as placeholders
          </span>
        )}
        <div className="flex min-w-0 items-center gap-2">
          {senders.length > 0 ? (
            <label className="flex min-w-0 items-center gap-1 text-[11px] text-muted-foreground">
              from
              <select
                value={sender?.email ?? ""}
                onChange={(event) => onSelectSender(event.target.value)}
                aria-label="Preview sending account"
                className="h-7 max-w-[190px] truncate rounded-md border border-border bg-surface px-1 text-[11px] text-foreground outline-none focus:border-ring"
              >
                {senders.map((option) => (
                  <option key={option.email} value={option.email}>
                    {option.avatarUrl ? option.email : `${option.email} (no photo)`}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          <button type="button" onClick={onShuffle} className={`${BTN_OUTLINE} h-7 shrink-0 px-2.5 text-[11.5px]`}>
            <Shuffle className="size-3" />
            Shuffle
          </button>
        </div>
      </div>
    </div>
  );
}

/* ── Sequence variables (builder rail, checks, autocomplete) ───────────────
   Smartlead's merge-tag model: {{variable}} (double braces, case-sensitive)
   over the standard lead fields, the lead list's custom fields, and the
   sl_* computed tags; {option a|option b} spin blocks use single braces. */
const STANDARD_LEAD_FIELDS = [
  "first_name",
  "last_name",
  "email",
  "company_name",
  "website",
  "location",
  "phone_number",
] as const;

/* Smartlead's dynamic-date tag with its two quoted, user-editable arguments:
   {{sl_date "2 days from now" "MMMM Do YYYY"}}. */
const SL_DATE_TOKEN = /^sl_date\s+"[^"]*"\s+"[^"]*"$/;

/* first_name → "First name"; camelCase custom keys → "Camel case". */
function friendlyVariableLabel(key: string): string {
  const spaced = key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .trim();
  if (!spaced) return key;
  const lower = spaced.toLowerCase();
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}

type VariableEntry = {
  key: string; // exact content between the braces — {{key}} is what's inserted
  label: string;
  example: string | null;
  helper?: string;
  group: "lead" | "custom" | "smart";
};

/* Standard fields first (with the preview lead's real values as examples),
   then the lead list's custom fields, then the sl_* smart variables. */
function buildVariableEntries(previewLead: PreviewLeadData | null): VariableEntry[] {
  const values = previewLead?.values ?? {};
  const entries: VariableEntry[] = STANDARD_LEAD_FIELDS.map((key) => ({
    key,
    label: friendlyVariableLabel(key),
    example: (values[key] ?? "").trim() || null,
    group: "lead" as const,
  }));
  Object.keys(values)
    .filter(
      (key) =>
        !(STANDARD_LEAD_FIELDS as readonly string[]).includes(key) && !key.startsWith("sl_"),
    )
    .sort()
    .forEach((key) =>
      entries.push({
        key,
        label: friendlyVariableLabel(key),
        example: values[key].trim() || null,
        group: "custom",
      }),
    );
  entries.push(
    {
      key: "sl_day_of_week",
      label: "Day of week",
      example: (values.sl_day_of_week ?? "").trim() || "Friday",
      group: "smart",
    },
    { key: "sl_time_of_day", label: "Time of day", example: "morning", group: "smart" },
    {
      key: 'sl_date "2 days from now" "MMMM Do YYYY"',
      label: "Dynamic date",
      example: "July 14th 2026",
      helper: "Edit the quoted parts after pasting.",
      group: "smart",
    },
  );
  return entries;
}

/* The token set the unknown-variable check accepts. Null while no preview
   lead has loaded — other leads' custom fields are unknowable then, so the
   scan raises structural errors only. */
function knownTokensFor(previewLead: PreviewLeadData | null): Set<string> | null {
  if (previewLead === null || previewLead.label === null) return null;
  const known = new Set<string>(STANDARD_LEAD_FIELDS);
  for (const key of Object.keys(previewLead.values)) known.add(key);
  known.add("sl_day_of_week");
  known.add("sl_time_of_day");
  return known;
}

type CopyIssue = { severity: "error" | "warn"; message: string };

/* Structural + variable checks over one subject or body string. Pure. */
function scanCopyText(text: string, known: Set<string> | null): CopyIssue[] {
  const issues: CopyIssue[] = [];

  // Brace balance — a walk, so `}a{` inversions are caught, not just counts.
  let depth = 0;
  let inverted = false;
  for (const ch of text) {
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth < 0) inverted = true;
    }
  }
  if (depth !== 0 || inverted) {
    issues.push({ severity: "error", message: "Unbalanced curly braces" });
  }

  if (/\{\{\s*\}\}/.test(text)) {
    issues.push({ severity: "error", message: "Empty {{ }} variable" });
  }

  // Spin blocks: single-brace groups containing a pipe. An empty (or
  // whitespace-only) option silently sends nothing for that pick.
  for (const match of text.matchAll(/\{([^{}]*)\}/g)) {
    const inner = match[1];
    if (!inner.includes("|")) continue;
    if (inner.split("|").some((option) => option.trim() === "")) {
      issues.push({ severity: "error", message: "Empty spin option" });
      break;
    }
  }

  if (known) {
    const seen = new Set<string>();
    for (const match of text.matchAll(/\{\{([^{}]*)\}\}/g)) {
      const token = match[1].trim();
      if (!token || seen.has(token)) continue;
      seen.add(token);
      if (known.has(token) || SL_DATE_TOKEN.test(token)) continue;
      issues.push({
        severity: "warn",
        message: `{{${token}}}: Not one of this campaign's variables`,
      });
    }
  }
  return issues;
}

type SequenceCheckGroup = { key: string; stepIndex: number; title: string; issues: CopyIssue[] };

/* Every step and variant's subject + body, grouped for the check banner. */
function collectSequenceIssues(
  drafts: StepDraft[],
  known: Set<string> | null,
): SequenceCheckGroup[] {
  const groups: SequenceCheckGroup[] = [];
  const push = (key: string, stepIndex: number, title: string, subject: string, body: string) => {
    const issues = [
      ...scanCopyText(subject, known).map((issue) => ({
        ...issue,
        message: `Subject: ${issue.message}`,
      })),
      ...scanCopyText(body, known).map((issue) => ({
        ...issue,
        message: `Body: ${issue.message}`,
      })),
    ];
    if (issues.length > 0) groups.push({ key, stepIndex, title, issues });
  };
  drafts.forEach((draft, index) => {
    if (draft.variants) {
      draft.variants.forEach((variant, j) =>
        push(
          `${draft.uid}-${j}`,
          index,
          `Email ${index + 1} · ${variantLabelText(variant, j)}`,
          variant.subject,
          variant.body.value,
        ),
      );
    } else {
      push(draft.uid, index, `Email ${index + 1}`, draft.subject, draft.body?.value ?? "");
    }
  });
  return groups;
}

/* One 11px line under an editor field listing its issues — destructive when
   anything is a structural error, warning tone for unknown variables. */
function CopyIssueLine({ issues }: { issues: CopyIssue[] }) {
  if (issues.length === 0) return null;
  const hasError = issues.some((issue) => issue.severity === "error");
  return (
    <p className={`text-[11px] leading-relaxed ${hasError ? "text-destructive" : "text-warning"}`}>
      {issues.map((issue) => issue.message).join(" · ")}
    </p>
  );
}

/* ── {{ variable autocomplete ──────────────────────────────────────────────
   One reusable dropdown for the editor's subject input and body textarea,
   wired via a render prop: the child spreads `bind` onto its field (keeping
   its own ref and onChange). Opens when the text before the caret matches
   {{partial; ArrowUp/Down + Enter or click inserts the variable and the
   closing braces (skipped when the next two chars are already }}). The field
   element is captured from the events themselves (never read during render). */
type VariableField = HTMLInputElement | HTMLTextAreaElement;

function VariableAutocomplete({
  entries,
  onValueChange,
  containerClassName,
  menuClassName,
  children,
}: {
  entries: VariableEntry[];
  onValueChange: (next: string) => void;
  containerClassName?: string;
  menuClassName?: string;
  children: (bind: {
    onInput: (event: ReactFormEvent<VariableField>) => void;
    onKeyDown: (event: ReactKeyboardEvent<VariableField>) => void;
    onKeyUp: (event: ReactKeyboardEvent<VariableField>) => void;
    onClick: (event: ReactMouseEvent<VariableField>) => void;
    onBlur: () => void;
  }) => ReactNode;
}) {
  // The field the last event came from — for the dropdown's click-to-insert,
  // which has no field event of its own. State (not a ref) so the render-prop
  // closures stay ref-free; setting the same element again bails out.
  const [fieldEl, setFieldEl] = useState<VariableField | null>(null);
  const [context, setContext] = useState<{ start: number; partial: string } | null>(null);
  const [highlight, setHighlight] = useState(0);

  const filtered = context
    ? entries.filter((entry) =>
        entry.key.toLowerCase().startsWith(context.partial.toLowerCase()),
      )
    : [];
  const visible = context !== null && filtered.length > 0;
  const active = Math.min(highlight, Math.max(filtered.length - 1, 0));

  /* Re-derive the {{partial context from the field's own value + caret (DOM
     truth, so it works during the same event that changed the value). */
  const syncFrom = (el: VariableField) => {
    setFieldEl(el);
    const caret = el.selectionStart;
    if (caret === null || caret !== el.selectionEnd) {
      setContext(null);
      return;
    }
    const match = /\{\{([A-Za-z0-9_]*)$/.exec(el.value.slice(0, caret));
    if (!match) {
      setContext(null);
      return;
    }
    const next = { start: caret - match[1].length, partial: match[1] };
    if (!context || context.start !== next.start || context.partial !== next.partial) {
      setContext(next);
      setHighlight(0);
    }
  };

  const insertAt = (el: VariableField, entry: VariableEntry) => {
    if (!context) return;
    const caretNow = context.start + context.partial.length;
    const after = el.value.slice(caretNow);
    const closing = after.startsWith("}}") ? "" : "}}";
    const nextValue = el.value.slice(0, context.start) + entry.key + closing + after;
    const nextCaret = context.start + entry.key.length + 2;
    onValueChange(nextValue);
    setContext(null);
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(nextCaret, nextCaret);
    });
  };

  const onKeyDown = (event: ReactKeyboardEvent<VariableField>) => {
    if (!visible) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setHighlight((active + 1) % filtered.length);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setHighlight((active - 1 + filtered.length) % filtered.length);
    } else if (event.key === "Enter") {
      event.preventDefault();
      insertAt(event.currentTarget, filtered[active]);
    } else if (event.key === "Escape") {
      // Consume it here so the takeover's window listener doesn't close.
      event.preventDefault();
      event.stopPropagation();
      setContext(null);
    }
  };

  return (
    <div className={containerClassName ?? "relative"}>
      {children({
        onInput: (event) => syncFrom(event.currentTarget),
        onKeyDown,
        onKeyUp: (event) => syncFrom(event.currentTarget),
        onClick: (event) => syncFrom(event.currentTarget),
        onBlur: () => setContext(null),
      })}
      {visible ? (
        <div
          role="listbox"
          aria-label="Variables"
          className={`absolute z-30 max-h-48 w-72 max-w-full overflow-auto rounded-lg border border-border bg-surface py-1 shadow-pop ${
            menuClassName ?? "left-0 top-full mt-1"
          }`}
        >
          {filtered.map((entry, index) => (
            <button
              key={entry.key}
              type="button"
              role="option"
              aria-selected={index === active}
              tabIndex={-1}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => {
                if (fieldEl) insertAt(fieldEl, entry);
              }}
              onMouseEnter={() => setHighlight(index)}
              className={`flex w-full items-baseline justify-between gap-3 px-2.5 py-1.5 text-left ${
                index === active ? "bg-muted/70" : ""
              }`}
            >
              <span className="whitespace-nowrap text-[12px] font-medium">{entry.label}</span>
              <span className="min-w-0 truncate text-[11px] text-muted-foreground">
                {entry.example ?? ""}
              </span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/* ── Editor tools panel: AI spintax ───────────────────────────────────────
   Lives in the edit-sequence takeover's tools panel. Insert drops the whole
   spintax line at the caret of the last-focused editor field; when no field
   has been focused yet it falls back to copying (the copied-swap idiom). */

/* The "" row is a tool's built-in default (the direct Anthropic call in
   lib/llm-oneshot.ts), given a real row so the picker always shows a name. */
const TOOL_DEFAULT_MODEL: ModelOption = {
  id: "",
  label: "Claude Sonnet 5",
  group: "Default",
  detail: "Standard model",
};
const TOOL_FALLBACK_MODELS: ModelOption[] = [
  TOOL_DEFAULT_MODEL,
  ...AI_MODEL_OPTIONS.map((m) => ({ id: m.id, label: m.label, group: m.provider })),
];
/* The gateway's served list changes on the order of days, not tab opens: one
   fetch per page load, shared by every tool with a picker. The promise itself
   is memoized because the spintax and spam tabs mount together. */
let toolModelCache: ModelOption[] | null = null;
let toolModelFetch: Promise<ModelOption[] | null> | null = null;
function fetchToolModels(): Promise<ModelOption[] | null> {
  toolModelFetch ??= getModelOptionsAction()
    .then((result) => {
      if (!result.ok || !result.apiModels?.length) return null;
      toolModelCache = [TOOL_DEFAULT_MODEL, ...result.apiModels];
      return toolModelCache;
    })
    .catch(() => null);
  return toolModelFetch;
}

/* Model options for an editor tool: the static catalog immediately, upgraded
   to the gateway's live list once the shared fetch lands. */
function useToolModelOptions(): { modelOptions: ModelOption[]; modelsLoading: boolean } {
  const [modelOptions, setModelOptions] = useState<ModelOption[]>(toolModelCache ?? TOOL_FALLBACK_MODELS);
  const [modelsLoading, setModelsLoading] = useState(() => !toolModelCache);
  useEffect(() => {
    if (toolModelCache) return;
    let cancelled = false;
    void fetchToolModels().then((models) => {
      if (cancelled) return;
      if (models) setModelOptions(models);
      setModelsLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, []);
  return { modelOptions, modelsLoading };
}

function SpintaxTool({ onInsert }: { onInsert: (text: string) => boolean }) {
  const [input, setInput] = useState("");
  const [instructions, setInstructions] = useState("");
  const [model, setModel] = useState("");
  const { modelOptions, modelsLoading } = useToolModelOptions();
  const [spintax, setSpintax] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [generating, startGenerating] = useTransition();
  const [flash, setFlash] = useState<"copy" | "insert" | null>(null);
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (flashTimer.current) clearTimeout(flashTimer.current);
    },
    [],
  );
  const showFlash = (kind: "copy" | "insert") => {
    setFlash(kind);
    if (flashTimer.current) clearTimeout(flashTimer.current);
    flashTimer.current = setTimeout(() => setFlash(null), 1500);
  };

  const canGenerate = input.trim().length >= 3;
  const generate = () => {
    if (!canGenerate || generating) return;
    setError(null);
    startGenerating(async () => {
      const result = await generateSpintaxAction(input.trim(), {
        instructions: instructions.trim(),
        model,
      });
      // The last output stays up until a generate succeeds.
      if (result.ok && result.spintax) setSpintax(result.spintax);
      else setError(result.message);
    });
  };
  const copyOutput = (kind: "copy" | "insert") => {
    if (!spintax) return;
    void navigator.clipboard
      ?.writeText(spintax)
      .then(() => showFlash(kind))
      .catch(() => undefined);
  };
  const insertOutput = () => {
    if (!spintax) return;
    // No editor field focused yet — fall back to the copy affordance.
    if (!onInsert(spintax)) copyOutput("insert");
  };

  return (
    <div className="flex flex-col gap-2.5">
      <p className="text-[11px] leading-relaxed text-muted-foreground">
        Write a line; get Smartlead spin options. One option is picked per send.
      </p>
      <div className="flex flex-col gap-1">
        <label htmlFor="spintax-line" className="text-[11px] font-medium">
          Line to spin
        </label>
        <textarea
          id="spintax-line"
          value={input}
          onChange={(event) => setInput(event.target.value)}
          rows={2}
          maxLength={400}
          placeholder="e.g. quick question about how you handle order intake"
          className={TEXTAREA_MULTI}
        />
      </div>
      <div className="flex flex-col gap-1">
        <label htmlFor="spintax-instructions" className="text-[11px] font-medium">
          Extra instructions <span className="font-normal text-muted-foreground">· optional</span>
        </label>
        <textarea
          id="spintax-instructions"
          value={instructions}
          onChange={(event) => setInstructions(event.target.value)}
          rows={2}
          maxLength={500}
          placeholder="e.g. keep it casual, vary the opener more, never reword the ask"
          className={TEXTAREA_MULTI}
        />
      </div>
      <div className="flex flex-col gap-1">
        <label htmlFor="spintax-model" className="text-[11px] font-medium">
          Model
        </label>
        <ModelPicker
          id="spintax-model"
          value={model}
          onChange={setModel}
          disabled={generating}
          options={modelOptions}
          loading={modelsLoading}
          placeholder="Claude Sonnet 5"
        />
      </div>
      <button
        type="button"
        disabled={generating || !canGenerate}
        onClick={generate}
        className={`${BTN_PRIMARY} h-8 self-start px-3 text-[12px]`}
      >
        {generating ? "Generating…" : "Generate"}
      </button>
      {error ? <p className="text-[11px] text-muted-foreground">{error}</p> : null}
      {spintax !== null ? (
        <div className="flex flex-col gap-1.5">
          <div className="break-words rounded-md border border-border bg-subtle p-2.5 text-[12px] leading-relaxed">
            {spintax}
          </div>
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={insertOutput}
              className={`${BTN_OUTLINE} h-7 px-2.5 text-[11.5px]`}
            >
              {flash === "insert" ? <Check className="size-3 text-success" /> : <Plus className="size-3" />}
              {flash === "insert" ? "Copied" : "Insert"}
            </button>
            <button
              type="button"
              onClick={() => copyOutput("copy")}
              className={`${BTN_OUTLINE} h-7 px-2.5 text-[11.5px]`}
            >
              {flash === "copy" ? <Check className="size-3 text-success" /> : <Copy className="size-3" />}
              {flash === "copy" ? "Copied" : "Copy"}
            </button>
            <button
              type="button"
              disabled={generating || !canGenerate}
              onClick={generate}
              className={`${BTN_BASE} h-7 px-2.5 text-[11.5px] text-muted-foreground hover:bg-muted/70 hover:text-foreground`}
            >
              <RefreshCw className="size-3" />
              Regenerate
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

/* ── Editor tools panel: variables ────────────────────────────────────────
   Insert drops the {{token}} at the caret of the last-focused editor field
   (falling back to copy when none has been focused); the icon stays as the
   quiet copy affordance. */
function VariableRow({
  entry,
  showExample,
  onInsert,
}: {
  entry: VariableEntry;
  showExample: boolean;
  onInsert: (text: string) => boolean;
}) {
  const [flash, setFlash] = useState<"copy" | "insert" | null>(null);
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (flashTimer.current) clearTimeout(flashTimer.current);
    },
    [],
  );
  const token = `{{${entry.key}}}`;
  const copyToken = (kind: "copy" | "insert") => {
    void navigator.clipboard
      ?.writeText(token)
      .then(() => {
        setFlash(kind);
        if (flashTimer.current) clearTimeout(flashTimer.current);
        flashTimer.current = setTimeout(() => setFlash(null), 1500);
      })
      .catch(() => undefined);
  };
  const insertToken = () => {
    // No editor field focused yet — fall back to the copy affordance.
    if (!onInsert(token)) copyToken("insert");
  };
  return (
    <div className="flex items-center justify-between gap-2">
      <div className="flex min-w-0 flex-col">
        <span className="text-[12px] font-medium">{entry.label}</span>
        {showExample && entry.example ? (
          <span className="min-w-0 truncate text-[11px] text-muted-foreground">
            {entry.example}
          </span>
        ) : null}
        {entry.helper ? (
          <span className="text-[10.5px] text-muted-foreground">{entry.helper}</span>
        ) : null}
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <button
          type="button"
          onClick={insertToken}
          className={`${BTN_OUTLINE} h-6 px-2 text-[11px]`}
        >
          {flash === "insert" ? "Copied" : "Insert"}
        </button>
        <button
          type="button"
          data-tip="Copy variable"
          aria-label="Copy variable"
          onClick={() => copyToken("copy")}
          className={`inline-flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted/70 hover:text-foreground`}
        >
          {flash === "copy" ? <Check className="size-3 text-success" /> : <Copy className="size-3" />}
        </button>
      </div>
    </div>
  );
}

function VariablesTool({
  previewLead,
  loading,
  onInsert,
}: {
  previewLead: PreviewLeadData | null;
  loading: boolean;
  onInsert: (text: string) => boolean;
}) {
  const entries = buildVariableEntries(previewLead);
  const hasLead = previewLead !== null && previewLead.label !== null;
  const leadEntries = entries.filter((entry) => entry.group !== "smart");
  const smartEntries = entries.filter((entry) => entry.group === "smart");
  const pending = previewLead === null;

  return (
    <div className="flex flex-col gap-2.5">
      <p className="text-[11px] leading-relaxed text-muted-foreground">
        Insert one into your copy; Smartlead fills it per lead.
      </p>
      {pending ? (
        <div className="flex flex-col gap-2 py-1" aria-hidden aria-busy={loading}>
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-3.5 w-full animate-pulse rounded bg-muted" />
          ))}
        </div>
      ) : (
        <>
          <div className="flex flex-col gap-2">
            {leadEntries.map((entry) => (
              <VariableRow key={entry.key} entry={entry} showExample={hasLead} onInsert={onInsert} />
            ))}
          </div>
          {!hasLead ? (
            <p className="text-[11px] leading-relaxed text-muted-foreground">
              Add leads to see real example values.
            </p>
          ) : null}
          <div className="flex flex-col gap-2 border-t border-border pt-2.5">
            <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
              Smart variables
            </span>
            {smartEntries.map((entry) => (
              <VariableRow key={entry.key} entry={entry} showExample onInsert={onInsert} />
            ))}
          </div>
          <p className="text-[10.5px] text-muted-foreground">Variables are case-sensitive.</p>
        </>
      )}
    </div>
  );
}

/* ── Sequence check: one issue row + the grouped whole-sequence list ──────
   Shared between the Sequence tab's check card and the editor's Checks tab. */
function IssueDotRow({ issue }: { issue: CopyIssue }) {
  return (
    <div className="flex items-start gap-1.5 text-[11px] leading-relaxed text-muted-foreground">
      <span
        aria-hidden
        className={`mt-[5px] size-1.5 shrink-0 rounded-full ${
          issue.severity === "error" ? "bg-destructive" : "bg-warning"
        }`}
      />
      <span className="min-w-0 break-words">{issue.message}</span>
    </div>
  );
}

function SequenceIssueList({ groups }: { groups: SequenceCheckGroup[] }) {
  if (groups.length === 0) {
    return (
      <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
        <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-success" />
        All variables and spin blocks look good.
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-2.5">
      {groups.map((group) => (
        <div key={group.key} className="flex flex-col gap-1">
          <span className="text-[11px] font-semibold">{group.title}</span>
          {group.issues.map((issue, index) => (
            <IssueDotRow key={index} issue={issue} />
          ))}
        </div>
      ))}
    </div>
  );
}

/* ── Sequence tab: live whole-sequence check ──────────────────────────────
   Point-of-action validation, not a standing panel: clean is one quiet line,
   problems become a full-width alert where every group is a button that opens
   the editor at the offending email (the same checks re-run live in there —
   the Checks tab plus inline lines under each field). */
export function SequenceCheckBanner({
  drafts,
  previewLead,
  onOpenStep,
}: {
  drafts: StepDraft[];
  previewLead: PreviewLeadData | null;
  onOpenStep: (index: number) => void;
}) {
  const known = useMemo(() => knownTokensFor(previewLead), [previewLead]);
  const groups = useMemo(() => collectSequenceIssues(drafts, known), [drafts, known]);

  if (groups.length === 0) {
    return (
      <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
        <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-success" />
        Variables and spin blocks check out across every email.
      </div>
    );
  }

  const issueCount = groups.reduce((sum, group) => sum + group.issues.length, 0);
  const hasError = groups.some((group) => group.issues.some((issue) => issue.severity === "error"));
  const tone = hasError
    ? { chrome: "border-destructive/30 bg-destructive-soft/40", text: "text-destructive" }
    : { chrome: "border-warning/30 bg-warning-soft/40", text: "text-warning" };
  return (
    <div className={`flex flex-col gap-2 rounded-xl border px-4 py-3 ${tone.chrome}`}>
      <div className="flex items-center gap-1.5">
        <span aria-hidden className={`size-1.5 shrink-0 rounded-full ${hasError ? "bg-destructive" : "bg-warning"}`} />
        <h3 className={`text-[12px] font-semibold tracking-tight ${tone.text}`}>
          Sequence check: {issueCount} issue{issueCount === 1 ? "" : "s"} to fix before this copy sends clean
        </h3>
      </div>
      <div className="flex flex-col gap-2">
        {groups.map((group) => (
          <div key={group.key} className="flex flex-col gap-1">
            <button
              type="button"
              onClick={() => onOpenStep(group.stepIndex)}
              className="group flex items-center gap-1 self-start text-[11px] font-semibold text-foreground transition-colors hover:text-foreground/70"
            >
              {group.title}
              <span className="text-muted-foreground transition-colors group-hover:text-foreground/70">
                · Fix in editor →
              </span>
            </button>
            {group.issues.map((issue, index) => (
              <IssueDotRow key={index} issue={issue} />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

/* ── Editor tools panel: spam check ───────────────────────────────────────
   Contract mirror for checkSequenceSpamAction's report (declared locally so
   the client never imports the server module — the file's mirror pattern). */
type SpamFinding = {
  phrase: string;
  field: "subject" | "body";
  reason: string;
  severity: "low" | "medium" | "high";
  suggestion: string;
  suggestionKind: "replacement" | "rewrite";
};
type SpamReport = {
  score: number;
  verdict: "low" | "medium" | "high";
  summary: string;
  findings: SpamFinding[];
  droppedFindings: number;
};

const SPAM_VERDICT_LABEL: Record<SpamReport["verdict"], string> = {
  low: "Low risk",
  medium: "Medium risk",
  high: "High risk",
};
const SPAM_VERDICT_CHIP: Record<SpamReport["verdict"], string> = {
  low: "bg-success-soft text-success",
  medium: "bg-warning-soft text-warning",
  high: "bg-destructive-soft text-destructive",
};
const SPAM_VERDICT_BAR: Record<SpamReport["verdict"], string> = {
  low: "bg-success",
  medium: "bg-warning",
  high: "bg-destructive",
};
const SPAM_SEVERITY_DOT: Record<SpamFinding["severity"], string> = {
  low: "bg-muted-foreground/50",
  medium: "bg-warning",
  high: "bg-destructive",
};

/* One finding: severity dot + quoted phrase + field tag + reason, then the
   suggestion block with Apply (first exact occurrence, via the normal state
   path) and Copy. Apply disables when the phrase no longer occurs verbatim. */
function SpamFindingCard({
  finding,
  currentText,
  saving,
  onApply,
}: {
  finding: SpamFinding;
  currentText: string;
  saving: boolean;
  onApply: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (copiedTimer.current) clearTimeout(copiedTimer.current);
    },
    [],
  );
  const copySuggestion = () => {
    void navigator.clipboard
      ?.writeText(finding.suggestion)
      .then(() => {
        setCopied(true);
        if (copiedTimer.current) clearTimeout(copiedTimer.current);
        copiedTimer.current = setTimeout(() => setCopied(false), 1500);
      })
      .catch(() => undefined);
  };
  const present = currentText.includes(finding.phrase);
  return (
    <div className="flex flex-col gap-1.5 rounded-lg border border-border bg-surface p-2.5">
      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 items-start gap-1.5">
          <span
            aria-hidden
            className={`mt-[5px] size-1.5 shrink-0 rounded-full ${SPAM_SEVERITY_DOT[finding.severity]}`}
          />
          <span className="min-w-0 break-words text-[12px] font-medium">
            &ldquo;{finding.phrase}&rdquo;
          </span>
        </div>
        <span className="shrink-0 text-[10px] text-muted-foreground">
          {finding.field === "subject" ? "Subject" : "Body"}
        </span>
      </div>
      <p className="text-[11px] leading-relaxed text-muted-foreground">{finding.reason}</p>
      <div className="flex flex-col gap-1 rounded-md bg-subtle p-2">
        <div className="flex items-center justify-between gap-2">
          <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
            Try instead:
          </span>
          <span className="text-[10px] text-muted-foreground">
            {finding.suggestionKind === "replacement" ? "Replacement" : "Rewrite"}
          </span>
        </div>
        <p className="break-words text-[12px] leading-relaxed">{finding.suggestion}</p>
        <div className="flex items-center gap-1.5 pt-0.5">
          <button
            type="button"
            disabled={!present || saving}
            onClick={onApply}
            className={`${BTN_OUTLINE} h-6 px-2 text-[11px]`}
          >
            Apply
          </button>
          <button
            type="button"
            onClick={copySuggestion}
            className={`${BTN_BASE} h-6 px-2 text-[11px] text-muted-foreground hover:bg-muted/70 hover:text-foreground`}
          >
            {copied ? <Check className="size-3 text-success" /> : <Copy className="size-3" />}
            {copied ? "Copied" : "Copy"}
          </button>
          {!present ? <span className="text-[10px] text-muted-foreground">Text changed</span> : null}
        </div>
      </div>
    </div>
  );
}

// The spam tool remounts per edited email (it is keyed), so the model choice
// lives at module level to survive switching emails within the session.
let lastSpamCheckModel = "";

/* The Spam tab: one AI read of the CURRENT step/variant's subject + body.
   Mounted with a per-email key, so switching the edited email clears the
   result (it belongs to one draft). */
function SpamCheckTool({
  subject,
  body,
  saving,
  onReplace,
}: {
  subject: string;
  body: string;
  saving: boolean;
  onReplace: (field: "subject" | "body", next: string) => void;
}) {
  const [report, setReport] = useState<SpamReport | null>(null);
  const [checkedDraft, setCheckedDraft] = useState<{ subject: string; body: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [checking, startChecking] = useTransition();
  const [model, setModel] = useState(() => lastSpamCheckModel);
  const { modelOptions, modelsLoading } = useToolModelOptions();
  const pickModel = (next: string) => {
    lastSpamCheckModel = next;
    setModel(next);
  };

  const canRun = body.trim().length >= 10;
  const runCheck = () => {
    if (!canRun || checking) return;
    setError(null);
    startChecking(async () => {
      const result = await checkSequenceSpamAction({ subject, body }, { model });
      if (result.ok && result.report) {
        setReport(result.report);
        setCheckedDraft({ subject, body });
      } else {
        setError(result.message);
      }
    });
  };

  const drifted =
    checkedDraft !== null && (checkedDraft.subject !== subject || checkedDraft.body !== body);

  const applyFinding = (finding: SpamFinding) => {
    const current = finding.field === "subject" ? subject : body;
    const index = current.indexOf(finding.phrase);
    if (index === -1) return;
    onReplace(
      finding.field,
      current.slice(0, index) + finding.suggestion + current.slice(index + finding.phrase.length),
    );
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-1">
        <label htmlFor="spam-check-model" className="text-[11px] font-medium">
          Model
        </label>
        <ModelPicker
          id="spam-check-model"
          value={model}
          onChange={pickModel}
          disabled={checking}
          options={modelOptions}
          loading={modelsLoading}
          placeholder="Claude Sonnet 5"
        />
      </div>
      <button
        type="button"
        disabled={checking || !canRun}
        onClick={runCheck}
        className={`${BTN_PRIMARY} h-8 self-start px-3 text-[12px]`}
      >
        {checking ? "Checking…" : "Run spam check"}
      </button>
      {error ? (
        <div className="flex flex-col items-start gap-1.5">
          <p className="text-[11px] leading-relaxed text-destructive">{error}</p>
          <button
            type="button"
            disabled={checking || !canRun}
            onClick={runCheck}
            className={`${BTN_OUTLINE} h-7 px-2.5 text-[11.5px]`}
          >
            Retry
          </button>
        </div>
      ) : null}
      {report === null && error === null ? (
        <p className="text-[11px] leading-relaxed text-muted-foreground">
          Scores this email&rsquo;s spam-filter risk and pins the exact phrases that raise it, each
          with a suggested fix. Write at least a short body, then run it against the email you are
          editing.
        </p>
      ) : null}
      {report !== null ? (
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <div className="flex items-baseline gap-1">
              <span className="text-[24px] font-semibold leading-none font-mono tabular-nums tracking-tight">
                {report.score}
              </span>
              <span className="text-[12px] text-muted-foreground">/100</span>
              <span
                className={`ml-auto self-center rounded px-1.5 py-px text-[10px] font-semibold ${SPAM_VERDICT_CHIP[report.verdict]}`}
              >
                {SPAM_VERDICT_LABEL[report.verdict]}
              </span>
            </div>
            <div className="h-1.5 rounded-full bg-muted">
              <div
                className={`h-full rounded-full ${SPAM_VERDICT_BAR[report.verdict]}`}
                style={{ width: `${Math.min(Math.max(report.score, 0), 100)}%` }}
              />
            </div>
            <p className="text-[11px] leading-relaxed text-muted-foreground">{report.summary}</p>
          </div>
          {report.findings.length === 0 ? (
            <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
              <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-success" />
              No risky phrases pinned in this draft.
            </div>
          ) : (
            <div className="flex flex-col gap-2">
              {report.findings.map((finding, index) => (
                <SpamFindingCard
                  key={index}
                  finding={finding}
                  currentText={finding.field === "subject" ? subject : body}
                  saving={saving}
                  onApply={() => applyFinding(finding)}
                />
              ))}
            </div>
          )}
          {report.droppedFindings > 0 ? (
            <p className="text-[10.5px] leading-relaxed text-muted-foreground">
              {report.droppedFindings} suggestion{report.droppedFindings === 1 ? "" : "s"} could not
              be pinned to exact text and {report.droppedFindings === 1 ? "was" : "were"} dropped.
            </p>
          ) : null}
          {drifted ? (
            <p className="text-[10.5px] text-muted-foreground">Draft changed since this check.</p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/* ── Editor tools panel: tab strip ────────────────────────────────────── */
type ToolsTab = "variables" | "spintax" | "checks" | "spam";
const TOOLS_TABS: { key: ToolsTab; label: string }[] = [
  { key: "variables", label: "Variables" },
  { key: "spintax", label: "Spintax" },
  { key: "checks", label: "Checks" },
  { key: "spam", label: "Spam" },
];

/* ── Full-screen sequence editor ───────────────────────────────────────────
   A takeover VIEW over the panel's sequence draft state — one source of
   truth: every edit flows through the same patch handlers, and dirty/save
   use the exact same code paths as before. */
export function SequenceEditor({
  campaignName,
  campaignId,
  drafts,
  initialStep,
  onPatchStep,
  onPatchStepBody,
  onPatchVariant,
  onSplitStep,
  onAddVariant,
  onRemoveVariant,
  onAddStep,
  onRemoveStep,
  onMoveStep,
  dirty,
  saving,
  onSave,
  onDiscard,
  onExit,
  senderName,
  previewLead,
  previewLeadLoading,
  onEnsurePreviewLead,
  onSelectPreviewLead,
}: {
  campaignName: string;
  campaignId: string;
  drafts: StepDraft[];
  initialStep: number;
  onPatchStep: (index: number, patch: Partial<StepDraft>) => void;
  onPatchStepBody: (index: number, value: string) => void;
  onPatchVariant: (
    stepIndex: number,
    variantIndex: number,
    patch: { subject?: string; bodyValue?: string },
  ) => void;
  onSplitStep: (index: number) => void;
  onAddVariant: (index: number) => void;
  onRemoveVariant: (index: number, variantIndex: number) => void;
  onAddStep: () => void;
  onRemoveStep: (index: number) => void;
  onMoveStep: (index: number, direction: -1 | 1) => void;
  dirty: boolean;
  saving: boolean;
  onSave: () => void;
  onDiscard: () => void;
  onExit: () => void;
  senderName: string;
  previewLead: PreviewLeadData | null;
  previewLeadLoading: boolean;
  onEnsurePreviewLead: () => void;
  onSelectPreviewLead: (lead: PreviewLeadData) => void;
}) {
  const [activeStep, setActiveStep] = useState(() =>
    Math.min(Math.max(initialStep, 0), drafts.length - 1),
  );
  const [activeVariant, setActiveVariant] = useState(0);
  // User unchecked "Same thread" while the subject is still empty.
  const [threadOverride, setThreadOverride] = useState(false);
  const [previewOverlayOpen, setPreviewOverlayOpen] = useState(false);
  // The xl+ side pane costs 400px of editor width, which is most of a laptop
  // screen. Collapsing it is remembered, so the choice survives navigation.
  const [previewPaneOpen, setPreviewPaneOpen] = useState(true);
  useEffect(() => {
    const t = window.setTimeout(() => {
      try {
        if (window.localStorage.getItem(PREVIEW_PANE_KEY) === "collapsed") setPreviewPaneOpen(false);
      } catch {
        // localStorage unavailable, so the pane just stays open.
      }
    }, 0);
    return () => window.clearTimeout(t);
  }, []);
  const togglePreviewPane = () => {
    setPreviewPaneOpen((open) => {
      const next = !open;
      try {
        window.localStorage.setItem(PREVIEW_PANE_KEY, next ? "expanded" : "collapsed");
      } catch {
        // localStorage unavailable, so the choice just won't persist.
      }
      return next;
    });
  };
  const [previewRender, setPreviewRender] = useState<PreviewRender | null>(null);
  /* The campaign's sending accounts (with Zapmail avatars) — the preview can
     mimic any of them; defaults to the first. */
  const [previewSenders, setPreviewSenders] = useState<PreviewSender[]>([]);
  const [previewSenderEmail, setPreviewSenderEmail] = useState<string | null>(null);
  const previewSender = previewSenders.find((s) => s.email === previewSenderEmail) ?? previewSenders[0] ?? null;
  // Inline delete confirmation for the active step (sign-out popover idiom).
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);

  // Two-click confirm before discarding unsaved edits (Back or Escape).
  const [backArmed, setBackArmed] = useState(false);
  const backTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (backTimer.current) clearTimeout(backTimer.current);
  }, []);

  const subjectRef = useRef<HTMLInputElement | null>(null);
  const bodyRef = useRef<HTMLTextAreaElement | null>(null);

  // Last-focused editor field — the tools panel's Insert buttons target its
  // caret. State, not a ref, for the same reason as the autocomplete's
  // fieldEl; setting the same element again bails out.
  const [lastField, setLastField] = useState<VariableField | null>(null);

  // Which tools-panel tab is showing; persists while the takeover is open.
  const [toolsTab, setToolsTab] = useState<ToolsTab>("variables");

  /* Shuffle's lead pool: the campaign's first populated leads (the same
     empty-query list the picker opens with), fetched once per editor mount.
     Refs, not state — only the shuffle click reads it. */
  const leadPool = useRef<PreviewLeadData[] | null>(null);
  const leadPoolPending = useRef(false);
  const ensureLeadPool = () => {
    if (leadPool.current !== null || leadPoolPending.current) return;
    leadPoolPending.current = true;
    void searchCampaignPreviewLeadsAction(campaignId, "").then((result) => {
      leadPoolPending.current = false;
      if (result.ok && result.leads) {
        leadPool.current = result.leads.map((option) => ({
          label: option.label,
          values: { ...(result.computed ?? {}), ...option.values },
        }));
      }
    });
  };

  // Fetch the real preview lead once per campaign (root-cached), plus the
  // campaign's sending accounts for the preview's "from" identity.
  useEffect(() => {
    onEnsurePreviewLead();
    ensureLeadPool();
    void listCampaignSenderAccountsAction(campaignId).then((result) => {
      if (result.ok && result.senders?.length) setPreviewSenders(result.senders);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Lock the page behind the takeover.
  useEffect(() => {
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
    };
  }, []);

  const draft = drafts[activeStep];
  const variants = draft.variants;
  const variantIndex = variants ? Math.min(activeVariant, variants.length - 1) : 0;
  const variant = variants ? variants[variantIndex] : null;
  const body = variant ? variant.body : draft.body;
  const subject = variant ? variant.subject : draft.subject;

  const setSubject = (next: string) =>
    variant
      ? onPatchVariant(activeStep, variantIndex, { subject: next })
      : onPatchStep(activeStep, { subject: next });
  const setBody = (next: string) =>
    variant ? onPatchVariant(activeStep, variantIndex, { bodyValue: next }) : onPatchStepBody(activeStep, next);

  /* Insert text at the caret of the last-focused editor field. The value
     flows through setSubject/setBody — the exact state path typing takes, so
     dirty tracking is identical. Focus and the caret land after the inserted
     text (the autocomplete's requestAnimationFrame idiom). Returns false when
     no live field can take it; callers fall back to copying. */
  const insertAtCaret = (text: string): boolean => {
    const el = lastField;
    if (!el || el.disabled) return false;
    if (el !== subjectRef.current && el !== bodyRef.current) return false;
    const start = el.selectionStart ?? el.value.length;
    const end = el.selectionEnd ?? start;
    const nextValue = el.value.slice(0, start) + text + el.value.slice(end);
    if (el === subjectRef.current) setSubject(nextValue);
    else setBody(nextValue);
    const caret = start + text.length;
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(caret, caret);
    });
    return true;
  };

  // Empty subject IS same-thread semantics — the checkbox never writes a
  // placeholder into the field. Email 1 has no checkbox.
  const sameThread = activeStep > 0 && !threadOverride && subject === "";
  // Checking the box clears the subject (the wire format), so stash what was
  // typed and put it back if the box is unchecked without leaving the field.
  const stashedSubjectRef = useRef("");
  const toggleSameThread = () => {
    if (sameThread) {
      setThreadOverride(true);
      if (stashedSubjectRef.current) setSubject(stashedSubjectRef.current);
    } else {
      stashedSubjectRef.current = subject;
      setThreadOverride(false);
      setSubject("");
    }
  };

  const switchStep = (index: number) => {
    setActiveStep(index);
    setActiveVariant(0);
    setThreadOverride(false);
    stashedSubjectRef.current = "";
    setDeleteConfirmOpen(false);
  };
  const switchVariant = (index: number) => {
    setActiveVariant(index);
    setThreadOverride(false);
    stashedSubjectRef.current = "";
  };
  // Split the current single-body email into A/B, landing on the new variant B.
  const handleSplitTest = () => {
    onSplitStep(activeStep);
    setActiveVariant(1);
    setThreadOverride(false);
  };
  // Append a variant and focus it (its index is the current variant count).
  const handleAddVariant = () => {
    if (!variants || variants.length >= MAX_VARIANTS) return;
    onAddVariant(activeStep);
    setActiveVariant(variants.length);
    setThreadOverride(false);
  };
  // Remove the active variant; collapsing to one variant lands back on the body.
  const handleRemoveVariant = () => {
    if (!variants) return;
    onRemoveVariant(activeStep, variantIndex);
    setActiveVariant(0);
    setThreadOverride(false);
  };

  /* Add/remove/reorder mutate the shared drafts array in the parent; the editor
     owns only which step is focused, so each wrapper keeps activeStep pointing
     at the same content after the array shifts. */
  const handleAddStep = () => {
    if (drafts.length >= MAX_SEQUENCE_STEPS) return;
    onAddStep();
    switchStep(drafts.length); // the appended step's index
  };
  const handleMoveStep = (index: number, direction: -1 | 1) => {
    const target = index + direction;
    if (target < 0 || target >= drafts.length) return;
    onMoveStep(index, direction);
    switchStep(target); // follow the moved step
  };
  const removeStepAt = (index: number) => {
    onRemoveStep(index);
    setDeleteConfirmOpen(false);
    // The active step is the one being removed; land on the step that slides
    // into its place (or the new last step when the last one was removed).
    switchStep(Math.min(index, drafts.length - 2));
  };
  const requestDeleteStep = (index: number) => {
    // Unsaved (never-persisted) steps delete with no confirmation.
    if (drafts[index]?.origin === null) {
      removeStepAt(index);
      return;
    }
    setDeleteConfirmOpen(true);
  };

  // Focus follows the switched step: subject when editable, else the body.
  useEffect(() => {
    const subjectEl = subjectRef.current;
    if (subjectEl && !subjectEl.disabled) subjectEl.focus();
    else bodyRef.current?.focus();
  }, [activeStep, variantIndex]);

  // Back/Escape: clean → exit; dirty → explicit "Discard changes?" confirm.
  const requestClose = () => {
    if (deleteConfirmOpen) {
      setDeleteConfirmOpen(false);
      return;
    }
    if (previewOverlayOpen) {
      setPreviewOverlayOpen(false);
      return;
    }
    if (!dirty) {
      onExit();
      return;
    }
    if (!backArmed) {
      setBackArmed(true);
      if (backTimer.current) clearTimeout(backTimer.current);
      backTimer.current = setTimeout(() => setBackArmed(false), 3000);
      return;
    }
    setBackArmed(false);
    onDiscard();
    onExit();
  };
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") requestClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  /* Live preview, ~300ms debounced. The debounce always resolves spintax with
     the deterministic "first" pick — a stable seed, so typing never
     reshuffles. */
  const borrowed = subject.trim() ? null : previousThreadSubject(drafts, activeStep);
  const previewSubjectSource = subject.trim() ? subject : borrowed ? `Re: ${borrowed}` : null;
  const bodyValue = body ? body.value : "";
  const bodyIsHtml = body ? body.mode === "raw" : false;

  // {{ autocomplete entries + inline field checks (same rules as the
  // Sequence tab's check card; unknown-variable warnings only once a
  // preview lead has loaded).
  const variableEntries = useMemo(() => buildVariableEntries(previewLead), [previewLead]);
  const knownTokens = useMemo(() => knownTokensFor(previewLead), [previewLead]);
  const subjectIssues = useMemo(() => scanCopyText(subject, knownTokens), [subject, knownTokens]);
  const bodyIssues = useMemo(() => scanCopyText(bodyValue, knownTokens), [bodyValue, knownTokens]);

  // Checks tab: the current email's issues flat (field-prefixed like the
  // whole-sequence groups), plus the grouped scan across every step/variant.
  const currentEmailIssues = useMemo<CopyIssue[]>(
    () => [
      ...subjectIssues.map((issue) => ({ ...issue, message: `Subject: ${issue.message}` })),
      ...bodyIssues.map((issue) => ({ ...issue, message: `Body: ${issue.message}` })),
    ],
    [subjectIssues, bodyIssues],
  );
  const sequenceGroups = useMemo(
    () => collectSequenceIssues(drafts, knownTokens),
    [drafts, knownTokens],
  );
  /* A lead swap that came from Shuffle already carries its own random-mode
     render; the debounced rebuild would flip that snapshot back to the
     "first" pick, so it skips exactly that one change. */
  const shuffledLead = useRef<PreviewLeadData | null>(null);
  useEffect(() => {
    if (previewLead !== null && shuffledLead.current === previewLead) {
      shuffledLead.current = null;
      return;
    }
    const timer = setTimeout(() => {
      setPreviewRender(
        buildPreviewRender(previewSubjectSource, bodyValue, bodyIsHtml, previewLead?.values, "first"),
      );
    }, 300);
    return () => clearTimeout(timer);
  }, [previewSubjectSource, bodyValue, bodyIsHtml, previewLead]);

  /* Shuffle re-rolls everything at once: a different lead from the pool (once
     it has loaded) AND fresh random spintax picks, so clicking through walks
     people × variations. The next keystroke settles back to "first". */
  const shuffle = () => {
    ensureLeadPool(); // retry path when the mount fetch failed
    let lead = previewLead;
    const others = (leadPool.current ?? []).filter((option) => option.label !== previewLead?.label);
    if (others.length > 0) {
      lead = others[Math.floor(Math.random() * others.length)];
      shuffledLead.current = lead;
      onSelectPreviewLead(lead);
    }
    setPreviewRender(
      buildPreviewRender(previewSubjectSource, bodyValue, bodyIsHtml, lead?.values, "random"),
    );
  };

  const railItem = (stepDraft: StepDraft, index: number) => {
    const active = index === activeStep;
    const isDirty = draftIsDirty(stepDraft);
    return (
      <div key={stepDraft.uid} className="flex shrink-0 flex-col lg:w-full">
        <button
          type="button"
          onClick={() => switchStep(index)}
          aria-current={active ? "true" : undefined}
          className={`flex items-center gap-2 rounded-md px-2.5 py-1.5 text-left transition-colors lg:w-full lg:py-2 ${
            active ? "bg-accent text-accent-foreground" : "hover:bg-muted/60"
          }`}
        >
          <div className="flex min-w-0 flex-col">
            <span className="whitespace-nowrap text-[12px] font-medium">Email {stepDraft.seqNumber}</span>
            <span className={`text-[10.5px] ${active ? "text-accent-foreground/70" : "text-muted-foreground"}`}>
              {index === 0 ? `Day ${stepDraft.delayInDays}` : `+${stepDraft.delayInDays}d`}
            </span>
          </div>
          <div className="ml-auto flex items-center gap-1.5 pl-2">
            {stepDraft.variants ? (
              <span
                data-tip={`A/B test with ${stepDraft.variants.length} variants`}
                className={`flex items-center gap-1 whitespace-nowrap rounded-full px-1.5 py-0.5 text-[9.5px] font-semibold ${
                  active
                    ? "bg-surface text-foreground shadow-xs"
                    : "bg-accent text-accent-foreground"
                }`}
              >
                <Shuffle className="size-2.5" />
                {stepDraft.variants.length === 1 ? "1 variant" : `${stepDraft.variants.length} variants`}
              </span>
            ) : null}
            {stepHasRawBody(stepDraft) ? (
              <span data-tip="Contains raw HTML" aria-label="Contains raw HTML" className="size-1.5 rounded-full bg-warning" />
            ) : null}
            {isDirty ? <CustomizedDot title="Unsaved edits" /> : null}
          </div>
        </button>

        {/* Reorder / delete controls for the focused step only. */}
        {active ? (
          <div className="relative mt-0.5 flex items-center gap-0.5 px-1">
            <button
              type="button"
              data-tip="Move up"
              aria-label="Move up"
              disabled={saving || index === 0}
              onClick={() => handleMoveStep(index, -1)}
              className={`flex size-6 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted/70 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40`}
            >
              <ArrowUp className="size-3.5" />
            </button>
            <button
              type="button"
              data-tip="Move down"
              aria-label="Move down"
              disabled={saving || index === drafts.length - 1}
              onClick={() => handleMoveStep(index, 1)}
              className={`flex size-6 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted/70 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40`}
            >
              <ArrowDown className="size-3.5" />
            </button>
            <button
              type="button"
              data-tip="Delete email"
              aria-label="Delete email"
              disabled={saving || drafts.length <= 1}
              onClick={() => requestDeleteStep(index)}
              className={`ml-auto flex size-6 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted/70 hover:text-destructive disabled:cursor-not-allowed disabled:opacity-40`}
            >
              <Trash2 className="size-3.5" />
            </button>

            {deleteConfirmOpen ? (
              <div className="absolute right-0 top-full z-20 mt-1 flex w-52 flex-col gap-2 rounded-lg border border-border bg-surface p-2.5 shadow-pop">
                <p className="text-[12px] font-medium leading-snug">Delete email {stepDraft.seqNumber}?</p>
                <p className="text-[11px] leading-relaxed text-muted-foreground">
                  This deletes the step from Smartlead when you save.
                </p>
                <div className="flex gap-1.5">
                  <button
                    type="button"
                    autoFocus
                    onClick={() => setDeleteConfirmOpen(false)}
                    onKeyDown={(event) => {
                      if (event.key === "Escape") setDeleteConfirmOpen(false);
                    }}
                    className="flex h-7 flex-1 items-center justify-center rounded-md border border-border bg-surface text-[11.5px] font-medium text-foreground transition hover:bg-muted/60"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    disabled={saving}
                    onClick={() => removeStepAt(index)}
                    className="flex h-7 flex-1 items-center justify-center rounded-md bg-destructive-soft text-[11.5px] font-medium text-destructive transition hover:opacity-85 disabled:opacity-50"
                  >
                    Delete
                  </button>
                </div>
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    );
  };

  return (
    <div className="fixed inset-0 z-40 flex flex-col bg-background">
      {/* ── Header bar ── */}
      <header className="flex h-14 shrink-0 items-center gap-3 border-b border-border bg-surface px-4">
        <button
          type="button"
          onClick={requestClose}
          className={`${
            backArmed ? `${BTN_BASE} bg-destructive-soft text-destructive hover:opacity-90` : BTN_OUTLINE
          } h-8 px-3 text-[12px]`}
        >
          <ArrowLeft className="size-3.5" />
          {backArmed ? "Discard changes?" : "Back"}
        </button>
        <div className="flex min-w-0 items-center gap-1.5 text-[13px]">
          <span className="min-w-0 truncate font-semibold tracking-tight">{campaignName}</span>
          <span className="text-muted-foreground/60">/</span>
          <span className="shrink-0 text-muted-foreground">Sequence</span>
        </div>
        <div className="ml-auto flex shrink-0 items-center gap-2">
          {dirty ? (
            <span className="hidden text-[11px] text-muted-foreground sm:inline">Unsaved changes</span>
          ) : null}
          <button
            type="button"
            onClick={() => setPreviewOverlayOpen(true)}
            className={`${BTN_OUTLINE} h-8 px-3 text-[12px] xl:hidden`}
          >
            <Eye className="size-3.5" />
            Preview
          </button>
          {/* At xl+ the preview is a docked pane rather than an overlay, so the
              same control collapses it instead of opening anything. */}
          <button
            type="button"
            onClick={togglePreviewPane}
            aria-expanded={previewPaneOpen}
            className={`${BTN_OUTLINE} hidden h-8 px-3 text-[12px] xl:inline-flex`}
          >
            {previewPaneOpen ? <PanelRightClose className="size-3.5" /> : <PanelRightOpen className="size-3.5" />}
            {previewPaneOpen ? "Hide preview" : "Preview"}
          </button>
          <a
            href={buildSmartleadCampaignUrl(campaignId)}
            target="_blank"
            rel="noopener noreferrer"
            className={`${BTN_OUTLINE} hidden h-8 px-3 text-[12px] sm:inline-flex`}
          >
            <ExternalLink className="size-3.5" />
            View in Smartlead
          </a>
          <button
            type="button"
            disabled={!dirty || saving}
            onClick={onSave}
            className={`${BTN_PRIMARY} h-8 px-3 text-[12px]`}
          >
            <Check className="size-3.5" />
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </header>

      {/* Below lg the main area becomes one scroll column (nav chips, fields,
          then the tools panel); at lg+ each pane manages its own overflow. */}
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto lg:flex-row lg:overflow-hidden">
        {/* ── Left rail: one item per email (horizontal chips below lg) ── */}
        <nav
          aria-label="Sequence emails"
          className="flex shrink-0 items-center gap-1 overflow-x-auto border-b border-border px-2 py-2 lg:w-[215px] lg:flex-col lg:items-stretch lg:overflow-y-auto lg:overflow-x-visible lg:border-b-0 lg:border-r"
        >
          <div className="hidden px-2.5 pb-1 pt-1.5 text-[10px] font-semibold uppercase tracking-wide text-foreground-subtle lg:block">
            Emails
          </div>
          {drafts.map(railItem)}
          {drafts.length < MAX_SEQUENCE_STEPS ? (
            <button
              type="button"
              onClick={handleAddStep}
              disabled={saving}
              className={`flex shrink-0 items-center gap-1.5 rounded-md px-2.5 py-1.5 text-[12px] font-medium text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50 lg:mt-1 lg:w-full lg:py-2`}
            >
              <Plus className="size-3.5" />
              Add step
            </button>
          ) : (
            <span className="shrink-0 whitespace-nowrap px-2.5 py-1.5 text-[10.5px] text-muted-foreground lg:w-full">
              Max {MAX_SEQUENCE_STEPS} steps
            </span>
          )}
        </nav>

        {/* ── Center editor ── */}
        <div className="flex min-w-0 flex-1 flex-col lg:min-h-0 lg:overflow-hidden">
          <div className="mx-auto flex h-full w-full min-w-0 max-w-[760px] flex-col gap-4 px-6 py-5">
            <div className="flex flex-wrap items-center gap-2">
              {variants ? (
                <>
                  <span className="text-[10px] font-semibold uppercase tracking-wide text-foreground-subtle">
                    A/B test
                  </span>
                  <div
                    role="group"
                    aria-label="Variants"
                    className="flex items-center gap-0.5 rounded-lg border border-border bg-muted/60 p-0.5"
                  >
                    {variants.map((item, j) => {
                      const active = j === variantIndex;
                      return (
                        <button
                          key={j}
                          type="button"
                          aria-pressed={active}
                          onClick={() => switchVariant(j)}
                          className={`rounded-md px-3 py-1 text-[11.5px] transition ${
                            active
                              ? "bg-primary font-semibold text-primary-foreground shadow-sm"
                              : "font-medium text-muted-foreground hover:bg-surface hover:text-foreground"
                          }`}
                        >
                          {variantLabelText(item, j)}
                        </button>
                      );
                    })}
                  </div>
                  {variants.length < MAX_VARIANTS ? (
                    <button
                      type="button"
                      onClick={handleAddVariant}
                      disabled={saving}
                      data-tip="Add another variant"
                      className={`flex items-center gap-1 rounded-md px-2 py-1 text-[11.5px] font-medium text-muted-foreground transition hover:bg-muted/60 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50`}
                    >
                      <Plus className="size-3.5" />
                      Add variant
                    </button>
                  ) : null}
                  {variants.length > 1 ? (
                    <button
                      type="button"
                      onClick={handleRemoveVariant}
                      disabled={saving}
                      data-tip={`Remove variant ${variantLabelText(variants[variantIndex], variantIndex)}`}
                      aria-label={`Remove variant ${variantLabelText(variants[variantIndex], variantIndex)}`}
                      className={`ml-auto flex items-center gap-1 rounded-md px-2 py-1 text-[11.5px] font-medium text-muted-foreground transition hover:bg-destructive/10 hover:text-destructive disabled:cursor-not-allowed disabled:opacity-50`}
                    >
                      <X className="size-3.5" />
                      Remove {variantLabelText(variants[variantIndex], variantIndex)}
                    </button>
                  ) : null}
                </>
              ) : (
                <button
                  type="button"
                  onClick={handleSplitTest}
                  disabled={saving}
                  data-tip="Turn this email into an A/B split test"
                  className={`flex items-center gap-1.5 rounded-md border border-dashed border-border px-2.5 py-1 text-[11.5px] font-medium text-muted-foreground transition hover:border-solid hover:bg-muted/60 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50`}
                >
                  <Shuffle className="size-3.5" />
                  Split test
                </button>
              )}
            </div>

            {/* Subject */}
            <div className="flex flex-col gap-1.5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <label htmlFor="seq-editor-subject" className="text-[11px] font-medium">
                  Subject
                </label>
                {activeStep > 0 ? (
                  <label className="flex cursor-pointer items-center gap-1.5 text-[11px] text-muted-foreground">
                    <input
                      type="checkbox"
                      checked={sameThread}
                      onChange={toggleSameThread}
                      disabled={saving}
                      className={`size-3.5 accent-[var(--primary)]`}
                    />
                    Same thread as previous email
                  </label>
                ) : null}
              </div>
              <VariableAutocomplete entries={variableEntries} onValueChange={setSubject}>
                {(bind) => (
                  <input
                    id="seq-editor-subject"
                    ref={subjectRef}
                    value={subject}
                    onChange={(event) => setSubject(event.target.value)}
                    onFocus={(event) => setLastField(event.currentTarget)}
                    {...bind}
                    disabled={sameThread || saving}
                    placeholder={sameThread ? "Re: (previous email's subject)" : "Subject line"}
                    className={`${INPUT_CLASS} ${
                      sameThread
                        ? "cursor-not-allowed border-dashed bg-muted/50 shadow-none"
                        : "disabled:opacity-50"
                    }`}
                  />
                )}
              </VariableAutocomplete>
              <CopyIssueLine issues={subjectIssues} />
              {sameThread ? (
                <p className="text-[11px] text-muted-foreground">
                  Sends as a reply in the previous email&rsquo;s thread.
                </p>
              ) : null}
            </div>

            {/* Delay */}
            <div className="flex flex-wrap items-center gap-2">
              <label htmlFor="seq-editor-delay" className="text-[11px] font-medium">
                Wait
              </label>
              <input
                id="seq-editor-delay"
                type="number"
                min={0}
                max={90}
                value={String(draft.delayInDays)}
                disabled={saving}
                onChange={(event) =>
                  onPatchStep(activeStep, { delayInDays: clampInt(event.target.value, 0, 90) })
                }
                className={`${INPUT_CLASS} w-20 disabled:opacity-50`}
              />
              <span className="text-[11px] text-muted-foreground">
                {activeStep === 0 ? "days after the lead is added" : "days after previous email"}
              </span>
            </div>

            {/* Body — fills the remaining height */}
            <div className="flex min-h-0 flex-1 flex-col gap-1.5">
              <div className="flex flex-wrap items-center gap-2">
                <label htmlFor="seq-editor-body" className="text-[11px] font-medium">
                  Body
                </label>
                {body?.mode === "raw" ? (
                  <span
                    data-tip={body.reason}
                    className="rounded bg-warning-soft px-1.5 py-px text-[10px] font-medium text-warning"
                  >
                    Raw HTML. This step uses formatting the text editor can&rsquo;t represent
                  </span>
                ) : null}
              </div>
              <VariableAutocomplete
                entries={variableEntries}
                onValueChange={setBody}
                containerClassName="relative flex min-h-0 flex-1 flex-col"
                menuClassName="bottom-2 left-3"
              >
                {(bind) => (
                  <textarea
                    id="seq-editor-body"
                    ref={bodyRef}
                    value={bodyValue}
                    onChange={(event) => setBody(event.target.value)}
                    onFocus={(event) => setLastField(event.currentTarget)}
                    {...bind}
                    maxLength={20000}
                    disabled={saving}
                    className={`min-h-[220px] w-full flex-1 resize-none rounded-lg border border-border bg-surface px-4 py-3.5 text-foreground shadow-xs outline-none transition placeholder:text-muted-foreground focus:border-ring disabled:opacity-50 lg:min-h-0 ${
                      bodyIsHtml ? "font-mono text-[12.5px] leading-relaxed" : "text-[14px] leading-[1.6]"
                    }`}
                  />
                )}
              </VariableAutocomplete>
              <CopyIssueLine issues={bodyIssues} />
            </div>
          </div>
        </div>

        {/* ── Tools panel: tabbed writing tools beside the editor at lg+,
               stacked under the fields below. Inactive tabs stay mounted
               (hidden) so spintax output and spam results survive tab
               switches; the spam tool's per-email key still clears its
               result when the edited email changes. ── */}
        <div className="flex w-full shrink-0 flex-col border-t border-border lg:min-h-0 lg:w-[340px] lg:border-l lg:border-t-0">
          <div className="flex shrink-0 px-3 pt-3">
            <div className="flex w-full items-center gap-0.5 rounded-lg border border-border bg-muted/40 p-0.5">
              {TOOLS_TABS.map((item) => {
                const active = item.key === toolsTab;
                return (
                  <button
                    key={item.key}
                    type="button"
                    aria-pressed={active}
                    onClick={() => setToolsTab(item.key)}
                    className={`h-6 flex-1 rounded-md px-2 text-[11px] font-medium transition ${
                      active
                        ? "bg-surface text-foreground shadow-xs"
                        : "text-muted-foreground hover:text-foreground"
                    }`}
                  >
                    {item.label}
                  </button>
                );
              })}
            </div>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-3.5 py-3.5">
            <div className={toolsTab === "variables" ? "" : "hidden"}>
              <VariablesTool
                previewLead={previewLead}
                loading={previewLeadLoading}
                onInsert={insertAtCaret}
              />
            </div>
            <div className={toolsTab === "spintax" ? "" : "hidden"}>
              <SpintaxTool onInsert={insertAtCaret} />
            </div>
            <div className={toolsTab === "checks" ? "flex flex-col gap-3.5" : "hidden"}>
              <div className="flex flex-col gap-2">
                <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                  This email
                </span>
                {currentEmailIssues.length === 0 ? (
                  <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                    <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-success" />
                    No issues in this email&rsquo;s subject or body.
                  </div>
                ) : (
                  currentEmailIssues.map((issue, index) => <IssueDotRow key={index} issue={issue} />)
                )}
              </div>
              <div className="flex flex-col gap-2 border-t border-border pt-3">
                <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                  Whole sequence
                </span>
                <SequenceIssueList groups={sequenceGroups} />
              </div>
            </div>
            <div className={toolsTab === "spam" ? "" : "hidden"}>
              <SpamCheckTool
                key={`${draft.uid}:${variantIndex}`}
                subject={subject}
                body={bodyValue}
                saving={saving}
                onReplace={(field, next) => (field === "subject" ? setSubject(next) : setBody(next))}
              />
            </div>
          </div>
        </div>

        {/* ── Right pane: live Gmail preview (xl+, collapsible) ── */}
        {previewPaneOpen ? (
          <div className="hidden w-[400px] shrink-0 flex-col border-l border-border xl:flex">
            <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border bg-surface px-3">
              <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                Live preview
              </span>
              <button
                type="button"
                aria-label="Hide preview"
                data-tip="Hide preview"
                onClick={togglePreviewPane}
                className="ml-auto flex size-6 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted/70 hover:text-foreground"
              >
                <PanelRightClose className="size-3.5" />
              </button>
            </div>
            <SequencePreviewPane
              render={previewRender}
              senderName={senderName}
              sender={previewSender}
              senders={previewSenders}
              onSelectSender={setPreviewSenderEmail}
              campaignId={campaignId}
              lead={previewLead}
              leadLoading={previewLeadLoading}
              onSelectLead={onSelectPreviewLead}
              onShuffle={shuffle}
            />
          </div>
        ) : null}
      </div>

      {/* ── Preview overlay below xl ── */}
      {previewOverlayOpen ? (
        <div className="fixed inset-0 z-50 flex flex-col bg-background xl:hidden">
          <div className="flex h-12 shrink-0 items-center justify-between border-b border-border bg-surface px-4">
            <span className="text-[12.5px] font-semibold tracking-tight">Live preview</span>
            <button
              type="button"
              aria-label="Close preview"
              onClick={() => setPreviewOverlayOpen(false)}
              className={`flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted/70 hover:text-foreground`}
            >
              <X className="size-3.5" />
            </button>
          </div>
          <SequencePreviewPane
            render={previewRender}
            senderName={senderName}
            sender={previewSender}
            senders={previewSenders}
            onSelectSender={setPreviewSenderEmail}
            campaignId={campaignId}
            lead={previewLead}
            leadLoading={previewLeadLoading}
            onSelectLead={onSelectPreviewLead}
            onShuffle={shuffle}
          />
        </div>
      ) : null}
    </div>
  );
}
