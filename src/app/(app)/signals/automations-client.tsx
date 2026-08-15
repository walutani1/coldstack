"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowRight, Briefcase, Check, ChevronDown, Loader2, PenLine, Plus, Radar, Send, Trash2, X } from "lucide-react";
import { textToSequenceHtml } from "@/lib/email-copy";
import { SEARCH_POSTED_OPTIONS } from "@/lib/signals/options";
import type { AutomationSummary } from "@/lib/signals/types";
import {
  MAX_SEQUENCE_STEPS,
  MAX_VARIANTS,
  SequenceEditor,
  draftIsDirty,
  draftsFromSteps,
  newStepDraft,
  renumberSteps,
  type PreviewLeadData,
  type SequenceStep,
  type StepDraft,
} from "../campaigns/sequence-editor";
import {
  createCampaignAction,
  getCampaignPreviewLeadAction,
  getCampaignSequenceAction,
  saveCampaignSequenceAction,
} from "../campaigns/actions";
import {
  archiveAutomationAction,
  bindCampaignAction,
  createAutomationAction,
  listAutomationsAction,
  listCampaignsAction,
  saveSearchAction,
  updateAutomationAction,
} from "./actions";
import { useToast } from "../toast";

/* Automations home: one card per play, each answering "what did this find and
   is anything waiting on me". Setup is a three-step wizard — Find → Campaign →
   Activate — and the campaign step can CREATE the campaign and write its
   emails right here, hosting the real sequence editor as a takeover. */

const BTN_BASE =
  "inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-md font-medium transition disabled:cursor-not-allowed disabled:opacity-50";
const BTN_PRIMARY = `${BTN_BASE} bg-primary text-primary-foreground shadow-xs hover:opacity-90`;
const BTN_OUTLINE = `${BTN_BASE} border border-border bg-surface text-foreground shadow-xs hover:border-border-strong hover:bg-muted/60`;
const BTN_GHOST = `${BTN_BASE} bg-transparent text-muted-foreground hover:bg-muted/70 hover:text-foreground`;
const INPUT_CLASS =
  "h-8 w-full rounded-md border border-border bg-surface px-2.5 text-[12.5px] text-foreground shadow-xs outline-none transition placeholder:text-muted-foreground focus:border-ring";
const SELECT_CLASS =
  "h-8 appearance-none rounded-md border border-border bg-surface pl-2.5 pr-7 text-[12.5px] font-medium text-foreground shadow-xs outline-none transition focus:border-ring";

/* ── Home cards ─────────────────────────────────────────────────────── */

function StatusDot({ summary }: { summary: AutomationSummary }) {
  const { automation, running } = summary;
  const tone = running
    ? "bg-info animate-pulse"
    : automation.status === "active"
      ? "bg-success"
      : automation.status === "paused"
        ? "bg-warning"
        : "bg-muted-foreground/40";
  const label = running ? "Running" : automation.status === "active" ? "Active" : automation.status === "paused" ? "Paused" : "Draft";
  return (
    <span className="flex items-center gap-1.5" data-tip={label}>
      <span className={`size-1.5 shrink-0 rounded-full ${tone}`} />
      <span className="text-[11px] text-muted-foreground">{label}</span>
    </span>
  );
}

/* The settings screen's switch, sized for the card row. Checked = the cron
   will start this automation's daily runs; off = paused, runs wait. */
function StatusSwitch({ checked, busy, label, onChange }: { checked: boolean; busy: boolean; label: string; onChange: (next: boolean) => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={busy}
      data-tip={checked ? "Daily runs on — click to pause" : "Paused — click to resume daily runs"}
      onClick={(event) => {
        event.stopPropagation();
        onChange(!checked);
      }}
      className={`relative h-[18px] w-8 shrink-0 rounded-full transition disabled:opacity-50 ${checked ? "bg-primary" : "bg-muted"}`}
    >
      <span className={`absolute top-[2px] size-[14px] rounded-full bg-surface shadow-xs transition-all ${checked ? "left-[16px]" : "left-[2px]"}`} />
    </button>
  );
}

function AutomationCard({ summary, onOpen, onDelete, onSetStatus }: { summary: AutomationSummary; onOpen: () => void; onDelete: () => Promise<void>; onSetStatus: (next: "active" | "paused") => Promise<void> }) {
  const { automation } = summary;
  const [armed, setArmed] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [toggling, setToggling] = useState(false);
  const armTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (armTimer.current) clearTimeout(armTimer.current);
  }, []);
  const outcome = summary.scanned === 0 ? "Nothing scanned yet" : `${summary.scanned} scanned · ${summary.qualified} qualified`;
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") onOpen();
      }}
      className="group flex w-full cursor-pointer flex-col gap-2 rounded-xl bg-surface px-4 py-3.5 text-left shadow-xs transition hover:shadow-pop"
    >
      <div className="flex items-center gap-2.5">
        <StatusSwitch
          checked={automation.status === "active"}
          busy={toggling}
          label={`${automation.status === "active" ? "Pause" : "Resume"} ${automation.name}`}
          onChange={(next) => {
            setToggling(true);
            void onSetStatus(next ? "active" : "paused").finally(() => setToggling(false));
          }}
        />
        <StatusDot summary={summary} />
        <span className="min-w-0 flex-1 truncate text-[13.5px] font-semibold tracking-tight">{automation.name}</span>
        {automation.campaignName ? (
          <span className="hidden max-w-[200px] truncate rounded-full bg-muted px-2 text-[11px] leading-5 text-muted-foreground sm:inline">
            {automation.campaignName}
          </span>
        ) : (
          <span className="hidden rounded-full bg-warning-soft px-2 text-[11px] leading-5 text-warning sm:inline">No campaign</span>
        )}
        <button
          type="button"
          disabled={deleting}
          onClick={(event) => {
            event.stopPropagation();
            if (!armed) {
              setArmed(true);
              if (armTimer.current) clearTimeout(armTimer.current);
              armTimer.current = setTimeout(() => setArmed(false), 3000);
              return;
            }
            setArmed(false);
            setDeleting(true);
            void onDelete().finally(() => setDeleting(false));
          }}
          className={`${BTN_GHOST} h-6 shrink-0 px-1.5 text-[10.5px] opacity-0 transition group-hover:opacity-100 focus-visible:opacity-100 ${armed ? "bg-destructive-soft text-destructive opacity-100 hover:bg-destructive-soft hover:text-destructive" : "hover:text-destructive"}`}
          data-tip={armed ? undefined : "Delete this automation (its companies and leads are kept)"}
          data-tip-down=""
          aria-label={`Delete ${automation.name}`}
        >
          {deleting ? <Loader2 className="size-3 animate-spin" /> : armed ? "Delete?" : <Trash2 className="size-3" />}
        </button>
        <ArrowRight className="size-3.5 shrink-0 text-muted-foreground transition group-hover:translate-x-0.5" />
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11.5px] text-muted-foreground">
        <span>{summary.titleCount} title{summary.titleCount === 1 ? "" : "s"}</span>
        <span aria-hidden>·</span>
        <span>{outcome}</span>
        {summary.leadsReady > 0 ? (
          <>
            <span aria-hidden>·</span>
            <span className="font-medium text-success">{summary.leadsReady} ready to push</span>
          </>
        ) : null}
        {summary.leadsAwaitingEmail > 0 ? (
          <>
            <span aria-hidden>·</span>
            <span>{summary.leadsAwaitingEmail} awaiting email</span>
          </>
        ) : null}
      </div>
    </div>
  );
}

/* ── Title chips (the search's real shape, not a free textarea) ─────── */

function TitleChips({ titles, onChange }: { titles: string[]; onChange: (next: string[]) => void }) {
  const [draft, setDraft] = useState("");
  const commit = () => {
    const parts = draft.split(/[,\n]/).map((part) => part.trim()).filter(Boolean);
    if (parts.length === 0) return;
    const merged = [...titles];
    for (const part of parts) if (!merged.some((t) => t.toLowerCase() === part.toLowerCase())) merged.push(part);
    onChange(merged.slice(0, 20));
    setDraft("");
  };
  return (
    <div className="flex min-h-8 flex-wrap items-center gap-1.5 rounded-md border border-border bg-surface px-2 py-1.5 transition focus-within:border-ring">
      {titles.map((title) => (
        <span key={title} className="inline-flex items-center gap-1 rounded bg-muted px-1.5 py-0.5 text-[11.5px]">
          {title}
          <button
            type="button"
            aria-label={`Remove ${title}`}
            onClick={() => onChange(titles.filter((t) => t !== title))}
            className="text-muted-foreground transition hover:text-foreground"
          >
            <X className="size-3" />
          </button>
        </span>
      ))}
      <input
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === ",") {
            event.preventDefault();
            commit();
          } else if (event.key === "Backspace" && !draft && titles.length > 0) {
            onChange(titles.slice(0, -1));
          }
        }}
        onBlur={commit}
        placeholder={titles.length === 0 ? "AI Implementation Manager, RPA Developer…  (Enter adds)" : ""}
        className="min-w-[180px] flex-1 bg-transparent text-[12.5px] outline-none placeholder:text-muted-foreground"
      />
    </div>
  );
}

/* ── Sequence-editor host ───────────────────────────────────────────────
   The editor is a controlled component; this owns its draft state for one
   campaign. Always refetches on open, so server-assigned ids are the baseline
   and a second save can never re-create steps. */

function CampaignCopyHost({
  campaignId,
  campaignName,
  onExit,
}: {
  campaignId: string;
  campaignName: string;
  onExit: (emailCount: number) => void;
}) {
  const showToast = useToast();
  const [baseline, setBaseline] = useState<SequenceStep[] | null>(null);
  const [drafts, setDrafts] = useState<StepDraft[] | null>(null);
  const [saving, setSaving] = useState(false);
  const [previewLead, setPreviewLead] = useState<PreviewLeadData | null>(null);
  const [previewLeadLoading, setPreviewLeadLoading] = useState(false);
  const loadedPreview = useRef(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const result = await getCampaignSequenceAction(campaignId);
      if (cancelled) return;
      const steps = result.ok && result.steps ? [...result.steps].sort((a, b) => a.seqNumber - b.seqNumber) : [];
      setBaseline(steps);
      setDrafts(steps.length > 0 ? draftsFromSteps(steps) : [newStepDraft(1)]);
    })();
    return () => {
      cancelled = true;
    };
  }, [campaignId]);

  const ensurePreviewLead = () => {
    if (loadedPreview.current) return;
    loadedPreview.current = true;
    setPreviewLeadLoading(true);
    void (async () => {
      const result = await getCampaignPreviewLeadAction(campaignId);
      const computed = (result as { computed?: Record<string, string> }).computed ?? {};
      setPreviewLead({ label: result.ok ? result.lead?.label ?? null : null, values: { ...computed, ...(result.ok ? result.lead?.values ?? {} : {}) } });
      setPreviewLeadLoading(false);
    })();
  };

  const patch = (updater: (prev: StepDraft[]) => StepDraft[]) => setDrafts((prev) => (prev ? updater(prev) : prev));

  const save = () => {
    if (!drafts || saving) return;
    // Email 1 needs a subject; every body needs text (per variant when split).
    for (let i = 0; i < drafts.length; i += 1) {
      const draft = drafts[i];
      const variants = draft.variants;
      if (variants && variants.length > 0) {
        for (let vi = 0; vi < variants.length; vi += 1) {
          if (i === 0 && !variants[vi].subject.trim()) {
            showToast(false, `Email 1 variant ${String.fromCharCode(65 + vi)} needs a subject.`);
            return;
          }
          if (!variants[vi].body.value.trim()) {
            showToast(false, `Email ${i + 1} variant ${String.fromCharCode(65 + vi)} needs body text.`);
            return;
          }
        }
      } else {
        if (i === 0 && !draft.subject.trim()) {
          showToast(false, "Email 1 needs a subject before you can save.");
          return;
        }
        if (!(draft.body?.value ?? "").trim()) {
          showToast(false, `Email ${i + 1} needs body text before you can save.`);
          return;
        }
      }
    }

    /* Fidelity: an untouched existing body ships its ORIGINAL html bytes;
       only genuinely edited text is re-encoded; raw html goes as typed. */
    const bodyHtml = (originalHtml: string | undefined, body: { mode: "text" | "raw"; baseline: string; value: string }): string => {
      if (body.mode === "raw") return body.value;
      if (originalHtml !== undefined && body.value === body.baseline) return originalHtml;
      return textToSequenceHtml(body.value);
    };

    const steps: SequenceStep[] = drafts.map((draft, index) => {
      const origin = draft.origin;
      if (draft.variants && draft.variants.length > 0) {
        const originHadVariants = Boolean(origin?.variants && origin.variants.length > 0);
        const variants = draft.variants.map((vd) => {
          const ov = vd.id !== null ? origin?.variants?.find((v) => v.id === vd.id) : undefined;
          return { id: vd.id, label: vd.label, subject: vd.subject, emailBody: bodyHtml(ov?.emailBody, vd.body) };
        });
        return {
          id: origin?.id ?? null,
          seqNumber: index + 1,
          delayInDays: draft.delayInDays,
          subject: origin && originHadVariants ? origin.subject : variants[0].subject,
          emailBody: origin && originHadVariants ? origin.emailBody : variants[0].emailBody,
          variants,
        };
      }
      const body = draft.body ?? { mode: "text" as const, baseline: "", value: "" };
      const originSingle = origin !== null && !(origin.variants && origin.variants.length > 0);
      return {
        id: origin?.id ?? null,
        seqNumber: index + 1,
        delayInDays: draft.delayInDays,
        subject: draft.subject,
        emailBody: bodyHtml(originSingle ? origin.emailBody : undefined, body),
        variants: null,
      };
    });

    setSaving(true);
    void (async () => {
      try {
        const result = await saveCampaignSequenceAction(campaignId, steps);
        if (!result.ok) {
          showToast(false, result.message);
          return;
        }
        // Refetch so server-assigned ids become the baseline (ids upload by
        // absence — adopting the sent payload would re-create steps next save).
        const fresh = await getCampaignSequenceAction(campaignId);
        if (fresh.ok && fresh.steps) {
          const sorted = [...fresh.steps].sort((a, b) => a.seqNumber - b.seqNumber);
          setBaseline(sorted);
          setDrafts(draftsFromSteps(sorted));
          showToast(true, "Sequence saved.");
        } else {
          setBaseline(null);
          setDrafts(null);
          showToast(true, "Sequence saved, but it could not be reloaded. Reopen the editor before editing again.");
          onExit(steps.length);
        }
      } finally {
        setSaving(false);
      }
    })();
  };

  if (!drafts || drafts.length === 0) {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-background">
        <Loader2 className="size-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const dirty = (baseline !== null && drafts.length !== baseline.length) || drafts.some(draftIsDirty);

  return (
    <SequenceEditor
      campaignName={campaignName}
      campaignId={campaignId}
      drafts={drafts}
      initialStep={0}
      onPatchStep={(index, stepPatch) => patch((prev) => prev.map((d, i) => (i === index ? { ...d, ...stepPatch } : d)))}
      onPatchStepBody={(index, value) => patch((prev) => prev.map((d, i) => (i === index && d.body ? { ...d, body: { ...d.body, value } } : d)))}
      onPatchVariant={(si, vi, variantPatch) =>
        patch((prev) =>
          prev.map((d, i) =>
            i === si && d.variants
              ? {
                  ...d,
                  variants: d.variants.map((v, j) =>
                    j === vi
                      ? { ...v, ...(variantPatch.subject !== undefined ? { subject: variantPatch.subject } : {}), ...(variantPatch.bodyValue !== undefined ? { body: { ...v.body, value: variantPatch.bodyValue } } : {}) }
                      : v,
                  ),
                }
              : d,
          ),
        )
      }
      onSplitStep={(index) =>
        patch((prev) =>
          prev.map((d, i) =>
            i === index && d.body
              ? {
                  ...d,
                  variants: [
                    { id: null, label: null, subject: d.subject, body: d.body },
                    { id: null, label: null, subject: d.subject, body: { mode: "text", baseline: "", value: "" } },
                  ],
                  body: null,
                }
              : d,
          ),
        )
      }
      onAddVariant={(index) =>
        patch((prev) =>
          prev.map((d, i) =>
            i === index && d.variants && d.variants.length < MAX_VARIANTS
              ? { ...d, variants: [...d.variants, { id: null, label: null, subject: d.variants[0]?.subject ?? "", body: { mode: "text", baseline: "", value: "" } }] }
              : d,
          ),
        )
      }
      onRemoveVariant={(index, variantIndex) =>
        patch((prev) =>
          prev.map((d, i) => {
            if (i !== index || !d.variants) return d;
            const remaining = d.variants.filter((_, j) => j !== variantIndex);
            if (remaining.length <= 1) return { ...d, subject: remaining[0]?.subject ?? d.subject, body: remaining[0]?.body ?? { mode: "text", baseline: "", value: "" }, variants: null };
            return { ...d, variants: remaining };
          }),
        )
      }
      onAddStep={() => patch((prev) => (prev.length >= MAX_SEQUENCE_STEPS ? prev : [...prev, newStepDraft(prev.length + 1)]))}
      onRemoveStep={(index) => patch((prev) => (prev.length <= 1 ? prev : renumberSteps(prev.filter((_, i) => i !== index))))}
      onMoveStep={(index, direction) =>
        patch((prev) => {
          const target = index + direction;
          if (target < 0 || target >= prev.length) return prev;
          const next = [...prev];
          [next[index], next[target]] = [next[target], next[index]];
          return renumberSteps(next);
        })
      }
      dirty={dirty}
      saving={saving}
      onSave={save}
      onDiscard={() => setDrafts(baseline && baseline.length > 0 ? draftsFromSteps(baseline) : [newStepDraft(1)])}
      onExit={() => onExit(baseline?.length ?? 0)}
      senderName="You"
      previewLead={previewLead}
      previewLeadLoading={previewLeadLoading}
      onEnsurePreviewLead={ensurePreviewLead}
      onSelectPreviewLead={setPreviewLead}
    />
  );
}

/* ── Campaign step (shared by the wizard and the bind popup) ─────────── */

type CampaignTag = { id: string; name: string };

function CampaignPicker({
  automationId,
  automationName,
  bound,
  onBound,
  onWriteCopy,
  emailCount,
}: {
  automationId: string;
  automationName: string;
  bound: CampaignTag | null;
  onBound: (tag: CampaignTag) => void;
  onWriteCopy: (tag: CampaignTag) => void;
  emailCount: number | null;
}) {
  const showToast = useToast();
  const [campaigns, setCampaigns] = useState<{ id: string; name: string; status: string | null }[] | null>(null);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState(automationName);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const result = await listCampaignsAction();
      if (cancelled) return;
      setCampaigns(result.ok ? result.campaigns : []);
      if (!result.ok) showToast(false, result.message);
    })();
    return () => {
      cancelled = true;
    };
  }, [showToast]);

  const bind = async (tag: CampaignTag) => {
    setBusy(true);
    try {
      const result = await bindCampaignAction(automationId, tag);
      if (!result.ok) {
        showToast(false, result.message);
        return;
      }
      onBound(tag);
    } finally {
      setBusy(false);
    }
  };

  const createNew = async () => {
    const name = newName.trim();
    if (!name) return;
    setBusy(true);
    try {
      // Sensible schedule so the campaign is valid from birth; refine it any
      // time in the Campaigns tab.
      const created = await createCampaignAction({
        name,
        description: `Created from the Signals automation "${automationName}".`,
        schedule: { timezone: "America/New_York", daysOfTheWeek: [1, 2, 3, 4, 5], startHour: "09:00", endHour: "17:00", minTimeBtwnEmails: 30, maxNewLeadsPerDay: 20 },
        inboxIds: [],
      });
      if (!created.ok || !created.campaignId) {
        showToast(false, created.message);
        return;
      }
      const tag = { id: created.campaignId, name };
      const boundResult = await bindCampaignAction(automationId, tag);
      if (!boundResult.ok) {
        showToast(false, boundResult.message);
        return;
      }
      showToast(true, "Campaign created.");
      setCreating(false);
      onBound(tag);
      onWriteCopy(tag);
    } finally {
      setBusy(false);
    }
  };

  if (bound) {
    return (
      <div className="flex flex-col gap-2.5">
        <div className="flex items-center gap-2.5 rounded-lg border border-border bg-surface p-3">
          <Check className="size-4 shrink-0 text-success" />
          <div className="min-w-0 flex-1">
            <p className="truncate text-[12.5px] font-medium">{bound.name}</p>
            <p className="text-[11px] text-muted-foreground">
              {emailCount === null ? "Checking the sequence…" : emailCount === 0 ? "No emails yet — write them before this can send." : `${emailCount} email${emailCount === 1 ? "" : "s"} in the sequence.`}
            </p>
          </div>
          <button type="button" disabled={busy} onClick={() => onWriteCopy(bound)} className={`${BTN_PRIMARY} h-8 shrink-0 px-3 text-[12px]`}>
            <PenLine className="size-3.5" />
            {emailCount ? "Edit the emails" : "Write the emails"}
          </button>
        </div>
        <button type="button" onClick={() => onBound(null as unknown as CampaignTag)} className={`${BTN_GHOST} h-7 self-start px-2 text-[11.5px]`}>
          Choose a different campaign
        </button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2.5">
      {creating ? (
        <div className="flex flex-col gap-2 rounded-lg border border-border p-3">
          <label className="flex flex-col gap-1">
            <span className="text-[11.5px] font-medium">Campaign name</span>
            <input value={newName} onChange={(event) => setNewName(event.target.value)} className={INPUT_CLASS} autoFocus />
          </label>
          <p className="text-[11px] leading-relaxed text-muted-foreground">
            Created with a weekday 9–5 ET schedule and no inboxes yet — you write the emails next, and attach inboxes in Campaigns when you are ready to send.
          </p>
          <div className="flex items-center gap-2">
            <button type="button" disabled={busy || !newName.trim()} onClick={() => void createNew()} className={`${BTN_PRIMARY} h-8 px-3 text-[12px]`}>
              {busy ? <Loader2 className="size-3.5 animate-spin" /> : <PenLine className="size-3.5" />}
              Create &amp; write the emails
            </button>
            <button type="button" onClick={() => setCreating(false)} className={`${BTN_GHOST} h-8 px-2.5 text-[12px]`}>
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <button type="button" onClick={() => setCreating(true)} className={`${BTN_OUTLINE} h-9 justify-start px-3 text-[12.5px]`}>
          <Plus className="size-4" />
          New campaign for this automation
        </button>
      )}

      {campaigns === null ? (
        <div className="flex items-center gap-2 py-4 text-[12px] text-muted-foreground">
          <Loader2 className="size-3.5 animate-spin" />
          Loading campaigns…
        </div>
      ) : campaigns.length === 0 ? null : (
        <div className="flex flex-col gap-1.5">
          <p className="text-[11px] font-medium uppercase tracking-[0.06em] text-muted-foreground">Or pick an existing one</p>
          <div className="scroll-thin flex max-h-56 flex-col divide-y divide-border overflow-y-auto rounded-lg border border-border">
            {campaigns.map((item) => (
              <button
                key={item.id}
                type="button"
                disabled={busy}
                onClick={() => void bind({ id: item.id, name: item.name })}
                className="flex items-center gap-2 px-3 py-2 text-left transition hover:bg-muted/50"
              >
                <span className="min-w-0 flex-1 truncate text-[12.5px]">{item.name}</span>
                {item.status ? <span className="text-[10.5px] uppercase tracking-wide text-muted-foreground">{item.status}</span> : null}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/* Bind/change the campaign from an automation's detail screen — same picker,
   same in-place create + copy flow as the wizard. */
export function BindCampaignModal({
  automationId,
  automationName,
  current,
  onClose,
  onChanged,
}: {
  automationId: string;
  automationName: string;
  current: CampaignTag | null;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [bound, setBound] = useState<CampaignTag | null>(current);
  const [copyFor, setCopyFor] = useState<CampaignTag | null>(null);
  const [emailCount, setEmailCount] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      if (!bound) {
        // Async so the reset never runs synchronously inside the effect body.
        await Promise.resolve();
        if (!cancelled) setEmailCount(null);
        return;
      }
      const result = await getCampaignSequenceAction(bound.id);
      if (!cancelled) setEmailCount(result.ok && result.steps ? result.steps.length : 0);
    })();
    return () => {
      cancelled = true;
    };
  }, [bound]);

  if (copyFor) {
    return (
      <CampaignCopyHost
        campaignId={copyFor.id}
        campaignName={copyFor.name}
        onExit={(count) => {
          setEmailCount(count);
          setCopyFor(null);
          onChanged();
        }}
      />
    );
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/70 p-4 backdrop-blur-sm anim-overlay-in">
      <div className="flex max-h-[85vh] w-full max-w-xl flex-col overflow-hidden rounded-xl border border-border bg-surface shadow-pop anim-panel-in">
        <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-3">
          <h2 className="text-[13.5px] font-semibold tracking-tight">Campaign for “{automationName}”</h2>
          <button type="button" aria-label="Close" onClick={onClose} className="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground transition hover:bg-muted/70 hover:text-foreground">
            <X className="size-4" />
          </button>
        </div>
        <div className="scroll-thin min-h-0 flex-1 overflow-y-auto px-4 py-4">
          <CampaignPicker
            automationId={automationId}
            automationName={automationName}
            bound={bound}
            emailCount={emailCount}
            onBound={(tag) => {
              setBound(tag ?? null);
              if (tag) onChanged();
            }}
            onWriteCopy={(tag) => setCopyFor(tag)}
          />
        </div>
      </div>
    </div>
  );
}

/* ── The wizard: Find → Campaign → Activate ─────────────────────────── */

type WizardStep = 1 | 2 | 3;

function Wizard({ onClose, onCreated }: { onClose: () => void; onCreated: (id: string) => void }) {
  const showToast = useToast();
  const [step, setStep] = useState<WizardStep>(1);
  const [busy, setBusy] = useState(false);

  // Step 1 — the search's real shape.
  const [name, setName] = useState("");
  const [titles, setTitles] = useState<string[]>([]);
  const [boards, setBoards] = useState<{ linkedin: boolean; indeed: boolean }>({ linkedin: true, indeed: false });
  const [location, setLocation] = useState("United States");
  const [postedWithin, setPostedWithin] = useState<string>("Past Week");
  const [maxJobs, setMaxJobs] = useState("100");
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [minSize, setMinSize] = useState("");
  const [maxSize, setMaxSize] = useState("");

  // Step 2 — the campaign.
  const [automationId, setAutomationId] = useState<string | null>(null);
  const [campaign, setCampaign] = useState<CampaignTag | null>(null);
  const [copyFor, setCopyFor] = useState<CampaignTag | null>(null);
  const [emailCount, setEmailCount] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      if (!campaign) {
        await Promise.resolve();
        if (!cancelled) setEmailCount(null);
        return;
      }
      const result = await getCampaignSequenceAction(campaign.id);
      if (!cancelled) setEmailCount(result.ok && result.steps ? result.steps.length : 0);
    })();
    return () => {
      cancelled = true;
    };
  }, [campaign]);

  const createAutomationAndSearches = async () => {
    setBusy(true);
    try {
      const criteria: Record<string, unknown> = {};
      const min = Number(minSize);
      const max = Number(maxSize);
      if (Number.isFinite(min) && Number.isFinite(max) && min > 0 && max > 0) criteria.headcount = { min, max };
      const created = await createAutomationAction({ name: name.trim(), criteria });
      if (!created.ok) {
        showToast(false, created.message);
        return;
      }
      const id = created.automation.id;
      setAutomationId(id);

      const sources = [boards.linkedin ? "linkedin" : null, boards.indeed ? "indeed" : null].filter(Boolean) as ("linkedin" | "indeed")[];
      for (const source of sources) {
        const result = await saveSearchAction(id, null, {
          name: `${name.trim()} — ${source === "linkedin" ? "LinkedIn" : "Indeed"}`,
          source,
          jobTitles: titles,
          location: location.trim() || "United States",
          cities: [],
          experience: null,
          employmentType: null,
          workArrangement: null,
          postedWithin,
          maxJobs: Math.max(1, Math.min(1000, Number(maxJobs) || 100)),
        });
        if (!result.ok) showToast(false, `${source === "linkedin" ? "LinkedIn" : "Indeed"} search: ${result.message}`);
      }
      setStep(2);
    } finally {
      setBusy(false);
    }
  };

  const finish = async (activate: boolean) => {
    if (!automationId) return;
    setBusy(true);
    try {
      if (activate) {
        const updated = await updateAutomationAction(automationId, { status: "active" });
        if (!updated.ok) {
          showToast(false, updated.message);
          return;
        }
      }
      showToast(true, activate ? "Automation is live." : "Saved as a draft.");
      onCreated(automationId);
    } finally {
      setBusy(false);
    }
  };

  const step1Valid = name.trim().length > 0 && titles.length > 0 && (boards.linkedin || boards.indeed);

  // The editor takeover replaces the wizard visually; wizard state lives here,
  // so closing the editor lands back on the same step with nothing lost.
  if (copyFor) {
    return (
      <CampaignCopyHost
        campaignId={copyFor.id}
        campaignName={copyFor.name}
        onExit={(count) => {
          setEmailCount(count);
          setCopyFor(null);
        }}
      />
    );
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/70 p-4 backdrop-blur-sm anim-overlay-in">
      <div className="flex max-h-[88vh] w-full max-w-xl flex-col overflow-hidden rounded-xl border border-border bg-surface shadow-pop anim-panel-in">
        <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-3">
          <div className="flex items-center gap-2">
            {([1, 2, 3] as WizardStep[]).map((n) => (
              <span key={n} className="flex items-center gap-2">
                <span className={`flex size-5 items-center justify-center rounded-full text-[10.5px] font-semibold ${step >= n ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground"}`}>
                  {step > n ? <Check className="size-3" /> : n}
                </span>
                <span className={`text-[11.5px] ${step === n ? "font-medium text-foreground" : "text-muted-foreground"}`}>
                  {n === 1 ? "Find" : n === 2 ? "Campaign" : "Activate"}
                </span>
                {n < 3 ? <span aria-hidden className="h-px w-5 bg-border" /> : null}
              </span>
            ))}
          </div>
          <button type="button" aria-label="Close" onClick={onClose} className="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground transition hover:bg-muted/70 hover:text-foreground">
            <X className="size-4" />
          </button>
        </div>

        <div className="scroll-thin min-h-0 flex-1 overflow-y-auto px-4 py-4">
          {step === 1 ? (
            <div className="flex flex-col gap-3">
              <div>
                <h2 className="text-[14px] font-semibold tracking-tight">What are they hiring for?</h2>
                <p className="mt-0.5 text-[12px] text-muted-foreground">The roles that mean a company is modernizing.</p>
              </div>
              <label className="flex flex-col gap-1">
                <span className="text-[11.5px] font-medium">Automation name</span>
                <input value={name} onChange={(event) => setName(event.target.value)} placeholder="e.g. AI &amp; transformation hires — US" className={INPUT_CLASS} />
              </label>
              <div className="flex flex-col gap-1">
                <span className="text-[11.5px] font-medium">Job titles</span>
                <TitleChips titles={titles} onChange={setTitles} />
              </div>
              <div className="flex flex-wrap items-end gap-3">
                <div className="flex flex-col gap-1">
                  <span className="text-[11.5px] font-medium">Job boards</span>
                  <div className="flex h-8 items-center gap-3">
                    <label className="flex cursor-pointer items-center gap-1.5 text-[12.5px]">
                      <input type="checkbox" checked={boards.linkedin} onChange={(event) => setBoards((b) => ({ ...b, linkedin: event.target.checked }))} className="size-3.5 accent-[var(--primary)]" />
                      LinkedIn
                    </label>
                    <label className="flex cursor-pointer items-center gap-1.5 text-[12.5px]">
                      <input type="checkbox" checked={boards.indeed} onChange={(event) => setBoards((b) => ({ ...b, indeed: event.target.checked }))} className="size-3.5 accent-[var(--primary)]" />
                      Indeed
                    </label>
                  </div>
                </div>
                <label className="flex min-w-40 flex-1 flex-col gap-1">
                  <span className="text-[11.5px] font-medium">Location</span>
                  <input value={location} onChange={(event) => setLocation(event.target.value)} className={INPUT_CLASS} />
                </label>
                <label className="flex flex-col gap-1">
                  <span className="text-[11.5px] font-medium">Posted</span>
                  <span className="relative">
                    <select value={postedWithin} onChange={(event) => setPostedWithin(event.target.value)} className={SELECT_CLASS}>
                      {SEARCH_POSTED_OPTIONS.map((option) => (
                        <option key={option} value={option}>{option}</option>
                      ))}
                    </select>
                    <ChevronDown className="pointer-events-none absolute right-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
                  </span>
                </label>
                <label className="flex w-24 flex-col gap-1">
                  <span className="text-[11.5px] font-medium">Max jobs</span>
                  <input value={maxJobs} onChange={(event) => setMaxJobs(event.target.value)} inputMode="numeric" className={INPUT_CLASS} />
                </label>
              </div>

              <button type="button" onClick={() => setShowAdvanced((v) => !v)} className={`${BTN_GHOST} h-7 self-start px-2 text-[11.5px]`}>
                {showAdvanced ? "Hide company filters" : "Which companies count — using your defaults"}
              </button>
              {showAdvanced ? (
                <div className="flex items-end gap-2 rounded-lg border border-border p-3">
                  <label className="flex flex-1 flex-col gap-1">
                    <span className="text-[11px] font-medium">Min employees</span>
                    <input value={minSize} onChange={(event) => setMinSize(event.target.value)} inputMode="numeric" placeholder="50" className={INPUT_CLASS} />
                  </label>
                  <label className="flex flex-1 flex-col gap-1">
                    <span className="text-[11px] font-medium">Max employees</span>
                    <input value={maxSize} onChange={(event) => setMaxSize(event.target.value)} inputMode="numeric" placeholder="100" className={INPUT_CLASS} />
                  </label>
                </div>
              ) : null}
            </div>
          ) : null}

          {step === 2 && automationId ? (
            <div className="flex flex-col gap-3">
              <div>
                <h2 className="text-[14px] font-semibold tracking-tight">Where should these leads go?</h2>
                <p className="mt-0.5 text-[12px] text-muted-foreground">Create the campaign here — emails included — or pick an existing one.</p>
              </div>
              <CampaignPicker
                automationId={automationId}
                automationName={name.trim()}
                bound={campaign}
                emailCount={emailCount}
                onBound={(tag) => setCampaign(tag ?? null)}
                onWriteCopy={(tag) => setCopyFor(tag)}
              />
            </div>
          ) : null}

          {step === 3 ? (
            <div className="flex flex-col gap-3">
              <div>
                <h2 className="text-[14px] font-semibold tracking-tight">Ready to go</h2>
                <p className="mt-0.5 text-[12px] leading-relaxed text-muted-foreground">
                  Active means it scrapes on schedule, filters, researches, finds the right people and their emails — then waits for your push.
                </p>
              </div>
              <dl className="flex flex-col gap-1.5 rounded-lg border border-border p-3 text-[12px]">
                <div className="flex justify-between gap-3"><dt className="text-muted-foreground">Name</dt><dd className="truncate font-medium">{name}</dd></div>
                <div className="flex justify-between gap-3"><dt className="text-muted-foreground">Titles</dt><dd>{titles.length}</dd></div>
                <div className="flex justify-between gap-3"><dt className="text-muted-foreground">Boards</dt><dd>{[boards.linkedin ? "LinkedIn" : null, boards.indeed ? "Indeed" : null].filter(Boolean).join(" + ")}</dd></div>
                <div className="flex justify-between gap-3"><dt className="text-muted-foreground">Campaign</dt><dd className="truncate">{campaign?.name ?? "Not set"}</dd></div>
                <div className="flex justify-between gap-3">
                  <dt className="text-muted-foreground">Emails</dt>
                  <dd className={emailCount ? "" : "text-warning"}>{emailCount ? `${emailCount} written` : "None yet"}</dd>
                </div>
              </dl>
              {!campaign || !emailCount ? (
                <p className="rounded-lg bg-warning-soft px-3 py-2 text-[11.5px] leading-relaxed text-warning">
                  {!campaign ? "Without a campaign, leads pile up in the list but have nowhere to go." : "The campaign has no emails yet — write them before pushing leads."}
                </p>
              ) : null}
            </div>
          ) : null}
        </div>

        <div className="flex items-center justify-between gap-2 border-t border-border px-4 py-3">
          <button type="button" onClick={step === 1 ? onClose : () => setStep((s) => (s - 1) as WizardStep)} className={`${BTN_GHOST} h-8 px-2.5 text-[12px]`}>
            {step === 1 ? "Cancel" : "Back"}
          </button>
          {step === 1 ? (
            <button type="button" disabled={!step1Valid || busy} onClick={() => void createAutomationAndSearches()} className={`${BTN_PRIMARY} h-8 px-3.5 text-[12px]`}>
              {busy ? <Loader2 className="size-3.5 animate-spin" /> : null}
              Continue
            </button>
          ) : step === 2 ? (
            <button type="button" onClick={() => setStep(3)} className={`${BTN_PRIMARY} h-8 px-3.5 text-[12px]`}>Continue</button>
          ) : (
            <div className="flex items-center gap-2">
              <button type="button" disabled={busy} onClick={() => void finish(false)} className={`${BTN_OUTLINE} h-8 px-3 text-[12px]`}>Save as draft</button>
              <button type="button" disabled={busy} onClick={() => void finish(true)} className={`${BTN_PRIMARY} h-8 px-3.5 text-[12px]`}>
                {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Send className="size-3.5" />}
                Activate
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/* ── Home ───────────────────────────────────────────────────────────── */

// The signals tab's left nav. Hiring is the only type that exists today;
// adding the next one is a row here plus the machinery behind it. The nav is
// a fixed list rather than something derived from the automations, so a type
// shows up the moment it's real, before anyone has built a play on it.
const SIGNAL_TYPES = [
  { id: "hiring", label: "Hiring", icon: Briefcase },
] as const;

type SignalTypeId = (typeof SIGNAL_TYPES)[number]["id"];

export function AutomationsHome({
  initial,
  onOpen,
}: {
  initial: AutomationSummary[];
  onOpen: (automationId: string) => void;
}) {
  const [rows, setRows] = useState<AutomationSummary[]>(initial);
  const [wizardOpen, setWizardOpen] = useState(false);
  // Automations carry no type of their own yet — every one is a hiring play —
  // so the selection only drives the nav's active row. When a second type
  // lands the rows will need tagging and this becomes a real filter.
  const [signalType, setSignalType] = useState<SignalTypeId>(SIGNAL_TYPES[0].id);
  const activeType = SIGNAL_TYPES.find((type) => type.id === signalType) ?? SIGNAL_TYPES[0];

  const reload = useCallback(async () => {
    const result = await listAutomationsAction();
    if (result.ok) setRows(result.automations);
  }, []);

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* The tab's own header names the tab and nothing else. Anything scoped
          to one signal type — the count of leads waiting, the button that
          builds one — belongs beside that type's list, not up here. */}
      <header className="flex h-14 shrink-0 items-center gap-3 border-b border-border bg-surface px-4">
        <Radar className="size-4 shrink-0 text-muted-foreground" strokeWidth={1.75} />
        <h1 className="shrink-0 text-[15px] font-semibold tracking-tight">Signals</h1>
      </header>

      <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
        {/* Left: the signal types. One row per type, the way campaigns lists
            campaigns — the old segmented chip pair didn't have room to grow. */}
        <aside className="flex shrink-0 flex-col border-b border-border bg-surface lg:w-56 lg:border-b-0 lg:border-r">
          <nav aria-label="Signal types" className="flex flex-col gap-0.5 p-2 lg:flex-1">
            <span className="px-2.5 pb-1 pt-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Signal types</span>
            {SIGNAL_TYPES.map((type) => {
              const Icon = type.icon;
              const active = type.id === signalType;
              return (
                <button
                  key={type.id}
                  type="button"
                  aria-current={active ? "page" : undefined}
                  onClick={() => setSignalType(type.id)}
                  className={`flex items-center gap-2.5 rounded-md px-2.5 py-2 text-left transition-colors ${
                    active ? "bg-accent text-accent-foreground" : "text-foreground hover:bg-muted/60"
                  }`}
                >
                  <Icon className="size-3.5 shrink-0" strokeWidth={1.75} />
                  <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium">{type.label}</span>
                </button>
              );
            })}
          </nav>
          <p className="hidden px-4 pb-3.5 text-[11px] leading-relaxed text-muted-foreground/70 lg:block">More signal types are on the way.</p>
        </aside>

        {/* Right: the automations for the selected type */}
        <div className="scroll-thin min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto flex w-full max-w-3xl flex-col gap-2.5 px-5 py-5">
            {rows.length === 0 ? (
              <div className="flex flex-col items-center gap-3 rounded-xl bg-surface px-6 py-16 text-center shadow-xs">
                <span className="flex size-12 items-center justify-center rounded-full bg-accent text-accent-foreground">
                  <Radar className="size-5" strokeWidth={1.75} />
                </span>
                <div className="max-w-md">
                  <h2 className="text-[15px] font-semibold tracking-tight">No {activeType.label.toLowerCase()} automations yet</h2>
                  <p className="mt-1 text-[12.5px] leading-relaxed text-muted-foreground">
                    An automation watches job boards for the roles that mean a company is modernizing, filters out the noise, finds the right person, and hands you a lead list for one campaign.
                  </p>
                </div>
                <button type="button" onClick={() => setWizardOpen(true)} className={`${BTN_PRIMARY} h-8 px-3.5 text-[12px]`}>
                  <Plus className="size-3.5" />
                  New automation
                </button>
              </div>
            ) : (
              <>
                <div className="flex items-center justify-between gap-2 pb-0.5">
                  <h2 className="min-w-0 truncate text-[13px] font-semibold tracking-tight">{activeType.label}</h2>
                  <button type="button" onClick={() => setWizardOpen(true)} className={`${BTN_PRIMARY} h-7 shrink-0 px-2.5 text-[11.5px]`}>
                    <Plus className="size-3.5" />
                    New automation
                  </button>
                </div>
                {rows.map((row) => (
                  <AutomationCard
                    key={row.automation.id}
                    summary={row}
                    onOpen={() => onOpen(row.automation.id)}
                    onDelete={async () => {
                      const result = await archiveAutomationAction(row.automation.id);
                      if (result.ok) setRows((prev) => prev.filter((item) => item.automation.id !== row.automation.id));
                    }}
                    onSetStatus={async (next) => {
                      const result = await updateAutomationAction(row.automation.id, { status: next });
                      if (result.ok) {
                        setRows((prev) => prev.map((item) => (item.automation.id === row.automation.id ? { ...item, automation: result.automation } : item)));
                      }
                    }}
                  />
                ))}
              </>
            )}
          </div>
        </div>
      </div>

      {wizardOpen ? (
        <Wizard
          onClose={() => setWizardOpen(false)}
          onCreated={(id) => {
            setWizardOpen(false);
            void reload();
            onOpen(id);
          }}
        />
      ) : null}
    </div>
  );
}
