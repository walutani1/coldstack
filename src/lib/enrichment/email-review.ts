import "server-only";
import { createHash } from "node:crypto";
import { getAdminClient } from "@/lib/supabase/admin";
import { buildEmailQaPayload, type QaEmail } from "@/lib/enrichment/email-qa";
import { generateCustomColumnValue, getColumnById } from "@/lib/enrichment/custom-columns";

/* Human-review-before-export operations. In manual mode the email reviewer opens
   a review item with proposed fixes (see email-qa.ts proposeReview); these run the
   queue, the per-lead detail (live-rendered so a since-edited email is caught), the
   atomic resolve, and the chat-driven regeneration. */

export type ReviewQueueRow = {
  id: string;
  leadId: string;
  leadName: string;
  company: string;
  issueCount: number;
  createdAt: string;
};

export type ReviewProposal = {
  id: string;
  columnId: string | null;
  columnKey: string;
  columnLabel: string;
  kind: "initial" | "chat";
  issue: string | null;
  instruction: string | null;
  originalValue: string | null;
  proposedValue: string | null;
  validationStatus: string;
  selected: boolean;
  createdAt: string;
};

export type ReviewDetail = {
  id: string;
  tableId: string;
  leadId: string;
  leadName: string;
  company: string;
  status: string;
  lockVersion: number;
  issues: string[];
  emails: QaEmail[];
  stale: boolean;
  proposals: ReviewProposal[];
};

function leadName(row: { first_name?: unknown; last_name?: unknown }): string {
  return [String(row.first_name ?? "").trim(), String(row.last_name ?? "").trim()].filter(Boolean).join(" ");
}

function toProposal(row: Record<string, unknown>): ReviewProposal {
  return {
    id: String(row.id),
    columnId: row.column_id ? String(row.column_id) : null,
    columnKey: String(row.column_key),
    columnLabel: String(row.column_label),
    kind: (row.kind as "initial" | "chat") ?? "initial",
    issue: row.issue == null ? null : String(row.issue),
    instruction: row.instruction == null ? null : String(row.instruction),
    originalValue: row.original_value == null ? null : String(row.original_value),
    proposedValue: row.proposed_value == null ? null : String(row.proposed_value),
    validationStatus: String(row.validation_status ?? "valid"),
    selected: Boolean(row.selected),
    createdAt: String(row.created_at),
  };
}

/** Current pending review items for a table, with the lead's identity + issue count. */
export async function getReviewQueue(tableId: string): Promise<ReviewQueueRow[]> {
  const admin = getAdminClient();
  const items = await admin
    .from("enrichment_review_items")
    .select("id, lead_id, issues, created_at")
    .eq("table_id", tableId).eq("is_current", true).eq("status", "pending")
    .order("created_at", { ascending: true });
  if (items.error) throw new Error(items.error.message);
  const rows = (items.data ?? []) as { id: string; lead_id: string; issues: unknown; created_at: string }[];
  if (!rows.length) return [];
  const leadIds = [...new Set(rows.map((r) => r.lead_id))];
  const leads = await admin.from("leads").select("id, first_name, last_name, company").in("id", leadIds);
  const byId = new Map((leads.data ?? []).map((l) => [String((l as { id: string }).id), l as Record<string, unknown>]));
  return rows.map((r) => {
    const l = byId.get(r.lead_id) ?? {};
    return {
      id: r.id, leadId: r.lead_id, leadName: leadName(l) || "Unknown lead",
      company: String((l as { company?: unknown }).company ?? "").trim(),
      issueCount: Array.isArray(r.issues) ? r.issues.length : 0, createdAt: r.created_at,
    };
  });
}

/** Full detail for one review item, live-rendered so a since-edited email is caught. */
export async function getReviewDetail(itemId: string): Promise<ReviewDetail | null> {
  const admin = getAdminClient();
  const it = await admin.from("enrichment_review_items").select("*").eq("id", itemId).maybeSingle();
  if (it.error) throw new Error(it.error.message);
  if (!it.data) return null;
  const item = it.data as Record<string, unknown>;
  const [lead, props] = await Promise.all([
    admin.from("leads").select("first_name, last_name, company").eq("id", String(item.lead_id)).maybeSingle(),
    admin.from("enrichment_review_proposals").select("*").eq("review_item_id", itemId).order("created_at", { ascending: true }),
  ]);
  const leadRow = (lead.data ?? {}) as Record<string, unknown>;

  // Live-render the emails and compare to the snapshot hash: if the campaign copy
  // or the lead's values changed since flagging, acceptance is disabled upstream.
  let emails: QaEmail[] = [];
  let stale = false;
  try {
    const live = await buildEmailQaPayload(String(item.campaign_id), String(item.table_id), String(item.lead_id));
    emails = live.emails;
    const liveHash = createHash("sha256").update(JSON.stringify(live.emails)).digest("hex").slice(0, 32);
    stale = Boolean(item.campaign_copy_hash) && liveHash !== String(item.campaign_copy_hash);
  } catch {
    // Campaign untagged or copy unavailable: fall back to the stored snapshot.
    const snap = item.snapshot as { emails?: QaEmail[] } | null;
    emails = snap?.emails ?? [];
    stale = true;
  }

  return {
    id: String(item.id), tableId: String(item.table_id), leadId: String(item.lead_id),
    leadName: leadName(leadRow) || "Unknown lead", company: String(leadRow.company ?? "").trim(),
    status: String(item.status), lockVersion: Number(item.lock_version ?? 0),
    issues: Array.isArray(item.issues) ? (item.issues as unknown[]).map(String) : [],
    emails, stale,
    proposals: ((props.data ?? []) as Record<string, unknown>[]).map(toProposal),
  };
}

export type ResolveDecision = "accepted" | "declined_export" | "declined_hold";

/** Resolve a review atomically (per-cell CAS in the RPC). Returns the final status. */
export async function resolveReview(itemId: string, decision: ResolveDecision, resolver: string, resolutionKey: string): Promise<{ ok: true; status: string } | { ok: false; message: string; stale?: boolean }> {
  const admin = getAdminClient();
  const res = await admin.rpc("enrichment_review_resolve", { p_item_id: itemId, p_decision: decision, p_resolver: resolver, p_resolution_key: resolutionKey });
  if (res.error) {
    const staleMatch = /stale_cell:(\S+)/.exec(res.error.message);
    if (staleMatch) return { ok: false, stale: true, message: `${staleMatch[1]} changed since it was flagged. Re-run the email review for this lead, then review again.` };
    return { ok: false, message: res.error.message };
  }
  return { ok: true, status: String(res.data) };
}

/** Regenerate a cell from a reviewer's chat instruction; append it as a proposal. */
export async function chatReview(itemId: string, columnId: string, instruction: string, requestKey: string, createdBy: string): Promise<{ ok: true; proposal: ReviewProposal } | { ok: false; message: string }> {
  const admin = getAdminClient();
  const it = await admin.from("enrichment_review_items").select("lead_id, status").eq("id", itemId).maybeSingle();
  if (it.error) return { ok: false, message: it.error.message };
  if (!it.data) return { ok: false, message: "Review not found." };
  if ((it.data as { status?: string }).status !== "pending") return { ok: false, message: "This review is already resolved." };
  const leadId = String((it.data as { lead_id: string }).lead_id);

  // Dedup a double-clicked send before it spends on the model.
  const existing = await admin.from("enrichment_review_proposals").select("*").eq("request_key", requestKey).maybeSingle();
  if (existing.data) return { ok: true, proposal: toProposal(existing.data as Record<string, unknown>) };

  const column = await getColumnById(columnId);
  if (!column) return { ok: false, message: "Column not found." };
  const gen = await generateCustomColumnValue(columnId, leadId, instruction);

  const insert = await admin.from("enrichment_review_proposals").insert({
    review_item_id: itemId, column_id: columnId, column_key: column.key, column_label: column.label,
    kind: "chat", instruction, proposed_value: gen.ok ? gen.value : null,
    validation_status: gen.ok ? "valid" : "failed", selected: false,
    provider: gen.ok ? gen.provider : null, request_key: requestKey, created_by: createdBy,
  }).select("*").single();
  if (insert.error) return { ok: false, message: insert.error.message };
  return { ok: true, proposal: toProposal(insert.data as Record<string, unknown>) };
}

/** "Keep original" for a column: clear every selection so accept applies nothing
   for it. Without this, the default-selected initial proposal would still apply. */
export async function clearColumnSelection(itemId: string, columnId: string): Promise<{ ok: boolean; message?: string }> {
  const res = await getAdminClient().from("enrichment_review_proposals").update({ selected: false }).eq("review_item_id", itemId).eq("column_id", columnId);
  if (res.error) return { ok: false, message: res.error.message };
  return { ok: true };
}

/** Pick which candidate to use for a column (one selected per column). */
export async function selectProposal(proposalId: string): Promise<{ ok: boolean; message?: string }> {
  const admin = getAdminClient();
  const p = await admin.from("enrichment_review_proposals").select("id, review_item_id, column_id, proposed_value").eq("id", proposalId).maybeSingle();
  if (p.error) return { ok: false, message: p.error.message };
  if (!p.data) return { ok: false, message: "Proposal not found." };
  const row = p.data as { review_item_id: string; column_id: string | null; proposed_value: string | null };
  if (!row.column_id) return { ok: false, message: "This item has no regenerable value to select." };
  if (row.proposed_value == null) return { ok: false, message: "This suggestion has no value to apply." };
  // Clear the column's other selections first (unique index allows one selected).
  const clear = await admin.from("enrichment_review_proposals").update({ selected: false }).eq("review_item_id", row.review_item_id).eq("column_id", row.column_id);
  if (clear.error) return { ok: false, message: clear.error.message };
  const set = await admin.from("enrichment_review_proposals").update({ selected: true }).eq("id", proposalId);
  if (set.error) return { ok: false, message: set.error.message };
  return { ok: true };
}
