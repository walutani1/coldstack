"use server";

import { z } from "zod";
import { requireActiveProfileResult } from "@/lib/auth";
import {
  getCrmLeadDetail,
  getCrmLeadsPage,
  logCrmLeadEdit,
  updateCrmLead,
  type CrmLeadPatch,
  type CrmLeadsFilter,
} from "@/lib/crm/queries";
import type { ActionResult } from "@/lib/types";

const strings = z.array(z.string().trim().min(1).max(200)).max(50);
const optionalDate = z.iso.datetime().nullable().optional();
const filterSchema = z.object({
  limit: z.number().int().min(1).max(100).optional(), offset: z.number().int().min(0).max(1_000_000).optional(),
  search: z.string().trim().max(200).nullable().optional(),
  campaignIds: z.array(z.string().regex(/^\d+$/)).max(300).optional(),
  campaignExcludeIds: z.array(z.string().regex(/^\d+$/)).max(300).optional(),
  replied: z.boolean().nullable().optional(), sentimentTypes: strings.optional(), categories: strings.optional(),
  referral: z.boolean().nullable().optional(), dnc: z.boolean().nullable().optional(), dncReasons: strings.optional(),
  dncApprovedOnly: z.boolean().optional(), proposalStatuses: strings.optional(), replyFrom: optionalDate, replyTo: optionalDate,
  exportedFrom: optionalDate, exportedTo: optionalDate, sort: z.enum(["name","company","exported_at","last_reply_at"]).optional(),
  sortDir: z.enum(["asc","desc"]).optional(), membership: z.array(z.enum(["exported","legacy","reply_only"])).max(3).optional(),
}).strict();
const leadIdSchema = z.string().uuid();
const offsetSchema = z.number().int().min(0).max(1_000_000);

const shortText = z.string().trim().max(200);
const longText = z.string().trim().max(500);
const rawPatchSchema = z
  .record(z.string().trim().min(1).max(120), z.string().max(1000))
  .refine((record) => Object.keys(record).length <= 30, "Too many stored fields changed at once.");
const leadPatchSchema = z
  .object({
    firstName: shortText.optional(), lastName: shortText.optional(), title: shortText.optional(),
    company: shortText.optional(), domain: longText.optional(), linkedinUrl: longText.optional(),
    rawPatch: rawPatchSchema.optional(),
  })
  .strict()
  .refine(
    (patch) =>
      patch.firstName !== undefined || patch.lastName !== undefined || patch.title !== undefined ||
      patch.company !== undefined || patch.domain !== undefined || patch.linkedinUrl !== undefined ||
      (patch.rawPatch !== undefined && Object.keys(patch.rawPatch).length > 0),
    "No changes to save.",
  );
// The concurrency marker is echoed straight back to the DB guard; validate it
// as a bounded opaque string so a timestamptz's offset/precision never fails it.
const updatedAtSchema = z.string().trim().min(1).max(64);

const FIELD_LABELS: Record<Exclude<keyof CrmLeadPatch, "rawPatch">, string> = {
  firstName: "first name", lastName: "last name", title: "title",
  company: "company", domain: "domain", linkedinUrl: "LinkedIn",
};

function describeChanges(patch: CrmLeadPatch): string[] {
  const changed: string[] = [];
  for (const [field, label] of Object.entries(FIELD_LABELS) as [keyof typeof FIELD_LABELS, string][]) {
    if (patch[field] !== undefined) changed.push(label);
  }
  if (patch.rawPatch) changed.push(...Object.keys(patch.rawPatch));
  return changed;
}

export async function getCrmLeadsPageAction(filter: CrmLeadsFilter): Promise<ActionResult & { data?: Awaited<ReturnType<typeof getCrmLeadsPage>> }> {
  const auth = await requireActiveProfileResult(); if (!auth.ok) return auth;
  const parsed = filterSchema.safeParse(filter); if (!parsed.success) return { ok:false, message:"Invalid CRM leads filters." };
  try { return { ok:true, message:"CRM leads loaded.", data:await getCrmLeadsPage(parsed.data) }; }
  catch (error) { return { ok:false, message:error instanceof Error ? error.message : "Could not load CRM leads." }; }
}

export async function getCrmLeadDetailAction(leadId: string, repliesOffset = 0): Promise<ActionResult & { data?: Awaited<ReturnType<typeof getCrmLeadDetail>> }> {
  const auth = await requireActiveProfileResult(); if (!auth.ok) return auth;
  const id=leadIdSchema.safeParse(leadId); const offset=offsetSchema.safeParse(repliesOffset);
  if (!id.success || !offset.success) return { ok:false, message:"Invalid CRM lead detail request." };
  try { return { ok:true, message:"CRM lead detail loaded.", data:await getCrmLeadDetail(id.data,offset.data) }; }
  catch (error) { return { ok:false, message:error instanceof Error ? error.message : "Could not load CRM lead detail." }; }
}

export async function updateCrmLeadAction(
  leadId: string,
  patch: CrmLeadPatch,
  expectedUpdatedAt: string,
): Promise<ActionResult & { data?: { lead: Record<string, unknown> } }> {
  const auth = await requireActiveProfileResult(); if (!auth.ok) return auth;
  const id = leadIdSchema.safeParse(leadId);
  const marker = updatedAtSchema.safeParse(expectedUpdatedAt);
  const parsed = leadPatchSchema.safeParse(patch);
  if (!id.success || !marker.success || !parsed.success) return { ok:false, message:"Invalid lead edit." };
  try {
    const result = await updateCrmLead(id.data, parsed.data, marker.data);
    if (result.outcome === "stale" || !result.lead) {
      return { ok:false, message:"This lead changed elsewhere. Close and reopen to edit the latest version." };
    }
    const changed = describeChanges(parsed.data);
    // The write already landed; a logging failure must not fail the action.
    try { await logCrmLeadEdit(id.data, changed); } catch { /* non-fatal */ }
    return { ok:true, message:`Saved ${changed.length} ${changed.length === 1 ? "change" : "changes"}.`, data:{ lead: result.lead } };
  } catch (error) {
    return { ok:false, message:error instanceof Error ? error.message : "Could not save lead edits." };
  }
}
