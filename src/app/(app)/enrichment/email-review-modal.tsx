"use client";

/* Email review before export. A swipe-through queue of leads whose rendered
   emails were flagged by the QA check: read the emails, pick a fix per flagged
   field (or keep the original / regenerate with a note), then apply, decline +
   export anyway, or decline + hold. Built on the host's modal grammar
   (ModalShell) and shared button/pill atoms; mirrors the inbox proposal-review
   feel (approve / decline / re-run with a note). */

import { useEffect, useMemo, useRef, useState, useCallback, type ReactNode } from "react";
import { AlertTriangle, ChevronLeft, ChevronRight, Loader2, RotateCcw } from "lucide-react";
import { ModalShell, Pill } from "./enrichment-dialogs";
import { BTN_OUTLINE, BTN_PRIMARY, BTN_SUBTLE } from "./enrichment-model";
import {
  chatReviewAction,
  clearReviewColumnAction,
  getReviewDetailAction,
  getReviewQueueAction,
  resolveReviewAction,
  selectReviewProposalAction,
} from "./actions";
import type {
  ResolveDecision,
  ReviewDetail,
  ReviewProposal,
  ReviewQueueRow,
} from "@/lib/enrichment/email-review";
import type { QaEmail } from "@/lib/enrichment/email-qa";

/* ── Presentational atoms ─────────────────────────────────────────────── */

function LoadingRow({ text }: { text: string }) {
  return (
    <div className="flex items-center gap-2 rounded-md border border-border bg-muted/20 p-4 text-[12.5px] text-muted-foreground">
      <Loader2 className="size-4 animate-spin" />
      {text}
    </div>
  );
}

function ErrorInline({ message }: { message: string }) {
  return (
    <div className="rounded-md border border-destructive/30 bg-destructive-soft p-2.5 text-[11.5px] leading-4 text-destructive">
      {message}
    </div>
  );
}

function ErrorBox({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="space-y-2">
      <div className="rounded-md border border-destructive/30 bg-destructive-soft p-3 text-[12.5px] text-destructive">
        {message}
      </div>
      {onRetry ? (
        <button type="button" onClick={onRetry} className={`${BTN_OUTLINE} h-8 px-3 text-[12px]`}>
          Retry
        </button>
      ) : null}
    </div>
  );
}

function SectionLabel({ children }: { children: ReactNode }) {
  return (
    <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">{children}</div>
  );
}

/* One rendered email in the preview: step, subject (or the threaded-follow-up
   note when there is none), and the body as pre-wrapped text. */
function EmailCard({ email }: { email: QaEmail }) {
  return (
    <div className="rounded-lg border border-border bg-muted/20 p-3">
      <div className="mb-1.5 flex flex-wrap items-center gap-1.5">
        <Pill tone="muted" label={`Step ${email.step}`} />
        {email.unfilled.length ? <Pill tone="warning" label={`${email.unfilled.length} unfilled`} /> : null}
      </div>
      {email.subject ? (
        <div className="text-[12.5px] font-medium text-foreground">{email.subject}</div>
      ) : (
        <div className="text-[11.5px] italic text-muted-foreground">Follow-up, threaded to the previous email.</div>
      )}
      <div className="mt-1 whitespace-pre-wrap break-words text-[12.5px] leading-5 text-foreground">{email.body}</div>
    </div>
  );
}

function RadioDot({ active }: { active: boolean }) {
  return (
    <span
      className={`mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full border ${
        active ? "border-primary" : "border-border"
      }`}
    >
      {active ? <span className="size-2 rounded-full bg-primary" /> : null}
    </span>
  );
}

/* A selectable candidate (or the "keep original" choice): a radio-style row that
   shows a short caption, an optional chat note, and the value. */
function OptionButton({
  active,
  onClick,
  caption,
  note,
  value,
  disabled,
}: {
  active: boolean;
  onClick: () => void;
  caption: string;
  note?: string | null;
  value: string | null;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`flex w-full items-start gap-2.5 rounded-md border p-2.5 text-left transition disabled:cursor-not-allowed disabled:opacity-50 ${
        active ? "border-primary bg-primary/5" : "border-border bg-surface hover:bg-muted/40"
      }`}
    >
      <RadioDot active={active} />
      <span className="min-w-0 flex-1 space-y-1">
        <span className="flex flex-wrap items-center gap-1.5">
          <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">{caption}</span>
          {note ? <span className="text-[11px] italic text-muted-foreground">Note: {note}</span> : null}
        </span>
        <span className="block whitespace-pre-wrap break-words text-[12.5px] leading-5 text-foreground">
          {value && value.length ? value : "(empty)"}
        </span>
      </span>
    </button>
  );
}

/* A flagged field with no auto-fix (validation failed or not a regenerable
   column): the source has to be edited by hand, so it is shown, not selectable. */
function FailedNote() {
  return (
    <div className="flex items-start gap-2.5 rounded-md border border-dashed border-border bg-muted/20 p-2.5">
      <AlertTriangle className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
      <div className="space-y-0.5">
        <p className="text-[12px] font-medium">Could not auto-fix</p>
        <p className="text-[11.5px] leading-4 text-muted-foreground">Edit the source field, then re-run the email review.</p>
      </div>
    </div>
  );
}

/* ── Grouping ─────────────────────────────────────────────────────────── */

type ColumnGroup = {
  columnKey: string;
  columnLabel: string;
  columnId: string | null;
  issue: string | null;
  originalValue: string | null;
  proposals: ReviewProposal[];
};

const STALE_MESSAGE =
  "This lead's emails changed since it was flagged. Re-run the email review, then review again.";

/* ── Modal ────────────────────────────────────────────────────────────── */

export function EmailReviewModal({
  tableId,
  onClose,
  onResolved,
}: {
  tableId: string;
  onClose: () => void;
  onResolved: () => void;
}) {
  const [queue, setQueue] = useState<ReviewQueueRow[] | null>(null);
  const [queueError, setQueueError] = useState<string | null>(null);
  const [resolvedAny, setResolvedAny] = useState(false);

  // rawIndex is clamped into range on read, so removing an item never points at
  // a hole (the next item slides into the same slot) and never flashes empty.
  const [rawIndex, setRawIndex] = useState(0);
  const total = queue?.length ?? 0;
  const index = total > 0 ? Math.min(rawIndex, total - 1) : 0;
  const currentItem = queue && total > 0 ? queue[index] : undefined;

  const totalRef = useRef(total);
  useEffect(() => {
    totalRef.current = total;
  }, [total]);

  const [detail, setDetail] = useState<ReviewDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [detailNonce, setDetailNonce] = useState(0);
  const detailTicket = useRef(0);

  // Per-column ephemeral UI, keyed by columnKey, reset whenever the card changes.
  const [chatText, setChatText] = useState<Record<string, string>>({});
  const [chatBusy, setChatBusy] = useState<Record<string, boolean>>({});
  const [colError, setColError] = useState<Record<string, string | null>>({});

  const [resolving, setResolving] = useState<ResolveDecision | null>(null);
  const [resolveError, setResolveError] = useState<string | null>(null);
  const [resolveStale, setResolveStale] = useState(false);

  // Initial queue load.
  useEffect(() => {
    let cancelled = false;
    setQueue(null);
    setQueueError(null);
    void (async () => {
      // The server actions widen `ok` to boolean (no explicit return type), which
      // breaks discriminated-union narrowing here; assert the documented contract.
      const res = (await getReviewQueueAction(tableId)) as
        | { ok: true; items: ReviewQueueRow[] }
        | { ok: false; message: string };
      if (cancelled) return;
      if (res.ok) setQueue(res.items);
      else {
        setQueue([]);
        setQueueError(res.message);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [tableId]);

  // Load the current card's detail whenever the item (or a retry nonce) changes.
  const currentId = currentItem?.id;
  useEffect(() => {
    setChatText({});
    setChatBusy({});
    setColError({});
    setResolveError(null);
    setResolveStale(false);
    if (!currentId) {
      setDetail(null);
      setDetailLoading(false);
      setDetailError(null);
      return;
    }
    const ticket = ++detailTicket.current;
    setDetail(null);
    setDetailError(null);
    setDetailLoading(true);
    void (async () => {
      const res = (await getReviewDetailAction(currentId)) as
        | { ok: true; detail: ReviewDetail }
        | { ok: false; message: string };
      if (ticket !== detailTicket.current) return;
      setDetailLoading(false);
      if (res.ok) setDetail(res.detail);
      else setDetailError(res.message);
    })();
  }, [currentId, detailNonce]);

  const goPrev = useCallback(() => {
    setRawIndex((i) => {
      const n = totalRef.current;
      if (n <= 0) return i;
      return Math.max(0, Math.min(i, n - 1) - 1);
    });
  }, []);
  const goNext = useCallback(() => {
    setRawIndex((i) => {
      const n = totalRef.current;
      if (n <= 0) return i;
      return Math.min(n - 1, Math.min(i, n - 1) + 1);
    });
  }, []);

  // Left / right arrows swipe between leads, unless the caret is in a field.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
      const el = event.target as HTMLElement | null;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable)) return;
      if (event.key === "ArrowLeft") {
        event.preventDefault();
        goPrev();
      } else if (event.key === "ArrowRight") {
        event.preventDefault();
        goNext();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [goPrev, goNext]);

  const groups = useMemo<ColumnGroup[]>(() => {
    if (!detail) return [];
    const map = new Map<string, ColumnGroup>();
    for (const p of detail.proposals) {
      const existing = map.get(p.columnKey);
      if (!existing) {
        map.set(p.columnKey, {
          columnKey: p.columnKey,
          columnLabel: p.columnLabel,
          columnId: p.columnId,
          issue: p.issue,
          originalValue: p.originalValue,
          proposals: [p],
        });
        continue;
      }
      if (!existing.columnId && p.columnId) existing.columnId = p.columnId;
      // The initial proposal owns the issue + original value for the column.
      if (p.kind === "initial") {
        existing.issue = p.issue;
        existing.originalValue = p.originalValue;
      }
      existing.proposals.push(p);
    }
    return [...map.values()];
  }, [detail]);

  const updateProposals = (fn: (props: ReviewProposal[]) => ReviewProposal[]) =>
    setDetail((prev) => (prev ? { ...prev, proposals: fn(prev.proposals) } : prev));

  const selectCandidate = async (proposal: ReviewProposal) => {
    if (proposal.proposedValue == null) return;
    const columnKey = proposal.columnKey;
    // Remember the prior pick so a failed select rolls back cleanly.
    const prior = detail?.proposals.find((x) => x.columnKey === columnKey && x.selected)?.id ?? null;
    setColError((e) => ({ ...e, [columnKey]: null }));
    updateProposals((props) =>
      props.map((x) => (x.columnKey === columnKey ? { ...x, selected: x.id === proposal.id } : x)),
    );
    const res = await selectReviewProposalAction(proposal.id);
    if (!res.ok) {
      updateProposals((props) =>
        props.map((x) => (x.columnKey === columnKey ? { ...x, selected: x.id === prior } : x)),
      );
      setColError((e) => ({ ...e, [columnKey]: res.message ?? "Could not select this suggestion." }));
    }
  };

  const keepOriginal = async (columnKey: string, columnId: string | null) => {
    const prior = detail?.proposals.filter((x) => x.columnKey === columnKey && x.selected).map((x) => x.id) ?? [];
    setColError((e) => ({ ...e, [columnKey]: null }));
    updateProposals((props) => props.map((x) => (x.columnKey === columnKey ? { ...x, selected: false } : x)));
    if (!columnId || prior.length === 0) return; // nothing selected server-side to clear
    if (!currentItem) return;
    const res = await clearReviewColumnAction(currentItem.id, columnId);
    if (!res.ok) {
      // Roll back to the prior selection so the UI matches the server.
      updateProposals((props) => props.map((x) => (x.columnKey === columnKey ? { ...x, selected: prior.includes(x.id) } : x)));
      setColError((e) => ({ ...e, [columnKey]: ("message" in res && res.message) ? res.message : "Could not update the selection." }));
    }
  };

  const sendChat = async (columnKey: string, columnId: string) => {
    if (!currentItem) return;
    const text = (chatText[columnKey] ?? "").trim();
    if (!text || chatBusy[columnKey]) return;
    setChatBusy((b) => ({ ...b, [columnKey]: true }));
    setColError((e) => ({ ...e, [columnKey]: null }));
    const res = await chatReviewAction(currentItem.id, columnId, text, crypto.randomUUID());
    setChatBusy((b) => ({ ...b, [columnKey]: false }));
    if ("proposal" in res) {
      updateProposals((props) => [...props, res.proposal]);
      setChatText((t) => ({ ...t, [columnKey]: "" }));
    } else {
      setColError((e) => ({ ...e, [columnKey]: res.message }));
    }
  };

  const resolve = async (decision: ResolveDecision) => {
    if (!currentItem || resolving) return;
    setResolving(decision);
    setResolveError(null);
    const resolvedId = currentItem.id;
    const res = await resolveReviewAction(resolvedId, decision, crypto.randomUUID());
    setResolving(null);
    if (res.ok) {
      setResolvedAny(true);
      setQueue((prev) => (prev ? prev.filter((q) => q.id !== resolvedId) : prev));
      onResolved();
    } else if ("stale" in res && res.stale) {
      setResolveStale(true);
      setResolveError(res.message);
    } else {
      setResolveError(res.message);
    }
  };

  const staleBlocked = Boolean(detail?.stale) || resolveStale;
  const canExportOrApply = Boolean(currentItem) && !resolving && !detailLoading && Boolean(detail) && !staleBlocked;
  const canHold = Boolean(currentItem) && !resolving;

  /* ── Footer ─────────────────────────────────────────────────────────── */

  let footer: ReactNode = null;
  if (queue !== null && total === 0) {
    footer = (
      <button type="button" onClick={onClose} className={`${BTN_OUTLINE} h-8 px-3 text-[12px]`}>
        Close
      </button>
    );
  } else if (queue !== null && total > 0) {
    footer = (
      <>
        <button
          type="button"
          disabled={!canHold}
          onClick={() => void resolve("declined_hold")}
          className={`${BTN_SUBTLE} h-8 px-3 text-[12px]`}
        >
          {resolving === "declined_hold" ? <Loader2 className="size-3.5 animate-spin" /> : null}
          Decline, hold
        </button>
        <button
          type="button"
          disabled={!canExportOrApply}
          onClick={() => void resolve("declined_export")}
          className={`${BTN_OUTLINE} h-8 px-3 text-[12px]`}
        >
          {resolving === "declined_export" ? <Loader2 className="size-3.5 animate-spin" /> : null}
          Decline, export anyway
        </button>
        <button
          type="button"
          disabled={!canExportOrApply}
          onClick={() => void resolve("accepted")}
          className={`${BTN_PRIMARY} h-8 px-3 text-[12px]`}
        >
          {resolving === "accepted" ? <Loader2 className="size-3.5 animate-spin" /> : null}
          Apply selected fixes
        </button>
      </>
    );
  }

  /* ── Body ───────────────────────────────────────────────────────────── */

  let body: ReactNode;
  if (queue === null) {
    body = <LoadingRow text="Loading review queue..." />;
  } else if (total === 0) {
    if (queueError) {
      body = <ErrorBox message={queueError} />;
    } else {
      body = (
        <div className="flex flex-col items-center gap-1.5 py-8 text-center">
          <p className="text-[13.5px] font-semibold tracking-tight">
            {resolvedAny ? "All caught up" : "No leads need review"}
          </p>
          <p className="max-w-xs text-[12px] leading-4 text-muted-foreground">
            {resolvedAny
              ? "Every flagged lead has been resolved. You can close this and export."
              : "Nothing in this list was flagged by the email review."}
          </p>
        </div>
      );
    }
  } else {
    body = (
      <div className="flex flex-col gap-4">
        <div className="flex items-center justify-between gap-2">
          <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            Reviewing {index + 1} of {total}
          </span>
          <div className="flex items-center gap-1">
            <button
              type="button"
              aria-label="Previous lead"
              disabled={index === 0}
              onClick={goPrev}
              className={`flex size-7 items-center justify-center rounded-md border border-border text-muted-foreground transition hover:bg-muted/60 disabled:opacity-40`}
            >
              <ChevronLeft className="size-4" />
            </button>
            <button
              type="button"
              aria-label="Next lead"
              disabled={index >= total - 1}
              onClick={goNext}
              className={`flex size-7 items-center justify-center rounded-md border border-border text-muted-foreground transition hover:bg-muted/60 disabled:opacity-40`}
            >
              <ChevronRight className="size-4" />
            </button>
          </div>
        </div>

        <div className="space-y-0.5">
          <h3 className="text-[14px] font-semibold tracking-tight">{currentItem?.leadName}</h3>
          <p className="text-[12px] text-muted-foreground">{currentItem?.company || "No company"}</p>
        </div>

        {staleBlocked ? (
          <div className="flex items-start gap-2 rounded-md border border-warning/30 bg-warning-soft p-3 text-[12px] leading-4 text-warning">
            <AlertTriangle className="mt-0.5 size-4 shrink-0" />
            <p>{resolveStale && resolveError ? resolveError : STALE_MESSAGE}</p>
          </div>
        ) : null}

        {detailLoading ? (
          <LoadingRow text="Loading this lead..." />
        ) : detailError ? (
          <ErrorBox message={detailError} onRetry={() => setDetailNonce((n) => n + 1)} />
        ) : detail ? (
          <div className="flex flex-col gap-4">
            <section className="space-y-2">
              <SectionLabel>Emails</SectionLabel>
              <div className="space-y-2">
                {detail.emails.length ? (
                  detail.emails.map((email) => <EmailCard key={email.step} email={email} />)
                ) : (
                  <p className="text-[12px] text-muted-foreground">No rendered emails for this lead.</p>
                )}
              </div>
            </section>

            <section className="space-y-2">
              <SectionLabel>Flagged fields</SectionLabel>
              {groups.length ? (
                <div className="space-y-3">
                  {groups.map((group) => {
                    const selectedId = group.proposals.find((p) => p.selected)?.id ?? null;
                    const chatValue = chatText[group.columnKey] ?? "";
                    const busy = Boolean(chatBusy[group.columnKey]);
                    const err = colError[group.columnKey];
                    const groupColumnId = group.columnId;
                    return (
                      <div key={group.columnKey} className="space-y-2.5 rounded-lg border border-border p-3">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="text-[12.5px] font-semibold">{group.columnLabel}</span>
                          <Pill tone="warning" label="flagged" />
                        </div>
                        {group.issue ? (
                          <p className="text-[11.5px] leading-4 text-muted-foreground">{group.issue}</p>
                        ) : null}

                        <div className="space-y-1.5">
                          <OptionButton
                            active={selectedId == null}
                            onClick={() => void keepOriginal(group.columnKey, group.columnId)}
                            caption="Keep original"
                            value={group.originalValue}
                          />
                          {group.proposals.map((proposal) =>
                            proposal.proposedValue == null ? (
                              <FailedNote key={proposal.id} />
                            ) : (
                              <OptionButton
                                key={proposal.id}
                                active={proposal.selected}
                                onClick={() => void selectCandidate(proposal)}
                                caption={proposal.kind === "chat" ? "Regenerated" : "Suggested fix"}
                                note={proposal.instruction}
                                value={proposal.proposedValue}
                              />
                            ),
                          )}
                        </div>

                        {err ? <ErrorInline message={err} /> : null}

                        {groupColumnId ? (
                          <div className="space-y-1.5">
                            <textarea
                              value={chatValue}
                              rows={2}
                              maxLength={2000}
                              disabled={busy}
                              onChange={(event) =>
                                setChatText((t) => ({ ...t, [group.columnKey]: event.target.value }))
                              }
                              placeholder="Add an instruction and regenerate, e.g. keep it under 12 words."
                              className="w-full resize-y rounded-md border border-border bg-surface px-2.5 py-2 text-[12.5px] leading-5 text-foreground outline-none transition placeholder:text-muted-foreground focus:border-ring disabled:opacity-50"
                            />
                            <div className="flex items-center justify-between gap-2">
                              <span className="text-[10px] text-muted-foreground">{chatValue.length}/2000</span>
                              <button
                                type="button"
                                disabled={busy || !chatValue.trim()}
                                onClick={() => void sendChat(group.columnKey, groupColumnId)}
                                className={`${BTN_OUTLINE} h-7 px-2.5 text-[12px]`}
                              >
                                {busy ? (
                                  <Loader2 className="size-3.5 animate-spin" />
                                ) : (
                                  <RotateCcw className="size-3.5" />
                                )}
                                Regenerate
                              </button>
                            </div>
                          </div>
                        ) : null}
                      </div>
                    );
                  })}
                </div>
              ) : (
                <p className="text-[12px] text-muted-foreground">Nothing flagged for this lead.</p>
              )}
            </section>

            {resolveError && !resolveStale ? <ErrorInline message={resolveError} /> : null}
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <ModalShell
      title="Email review"
      description="Approve the proposed fixes, or decline, before these leads export."
      widthClass="max-w-2xl"
      onClose={onClose}
      footer={footer}
    >
      {body}
    </ModalShell>
  );
}
