"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireActiveProfileResult } from "@/lib/auth";
import { listCampaigns } from "@/lib/smartlead";
import { getAdminClient } from "@/lib/supabase/admin";
import { importUntrackedReply } from "@/lib/untracked/import";
import { loadSenderContext, processOneUntrackedReply, type UntrackedRow } from "@/lib/untracked/process";
import { getUntrackedCounts, getUntrackedOverview, type UntrackedGroup } from "@/lib/untracked/queries";

const UuidSchema = z.string().uuid();
const ContactSchema = z.object({
  email: z.string().email().max(320), first_name: z.string().trim().max(100).nullish(),
  last_name: z.string().trim().max(100).nullish(), company: z.string().trim().max(200).nullish(),
  domain: z.string().trim().max(253).nullish(),
}).strict();
const ImportChoiceSchema = z.object({
  leadId: z.string().uuid().nullish(), createContact: ContactSchema.nullish(), campaignId: z.string().trim().max(100).nullish(),
}).strict().refine((value) => Boolean(value.leadId) !== Boolean(value.createContact), "Choose exactly one existing lead or new contact.");

export async function getUntrackedOverviewAction(input: { page?: number; pageSize?: number; group?: UntrackedGroup; status?: string } = {}) {
  const auth = await requireActiveProfileResult();
  if (!auth.ok) return auth;
  try { return { ok: true as const, overview: await getUntrackedOverview(input) }; }
  catch (error) { return { ok: false as const, message: error instanceof Error ? error.message : "Could not load untracked replies." }; }
}

export async function importUntrackedReplyAction(stagingId: string, choice: { leadId?: string | null; createContact?: z.infer<typeof ContactSchema> | null; campaignId?: string | null }) {
  const auth = await requireActiveProfileResult(); if (!auth.ok) return auth;
  const id = UuidSchema.safeParse(stagingId), parsed = ImportChoiceSchema.safeParse(choice);
  if (!id.success || !parsed.success) return { ok: false as const, message: parsed.success ? "Invalid staging id." : parsed.error.issues[0]?.message ?? "Invalid import choice." };
  const admin = getAdminClient();
  if (parsed.data.leadId) {
    const lead = await admin.from("leads").select("id").eq("id", parsed.data.leadId).maybeSingle();
    if (lead.error || !lead.data) return { ok: false as const, message: "Chosen lead does not exist." };
  }
  if (parsed.data.campaignId) {
    try {
      const campaigns = await listCampaigns();
      if (!campaigns.some((campaign) => campaign.id === parsed.data.campaignId)) return { ok: false as const, message: "Chosen campaign does not exist." };
    } catch (error) { return { ok: false as const, message: `Could not validate campaign: ${error instanceof Error ? error.message : String(error)}` }; }
  }
  const result = await importUntrackedReply({ stagingId: id.data, leadId: parsed.data.leadId, campaignId: parsed.data.campaignId,
    createContact: parsed.data.createContact, reviewerEmail: auth.profile.email });
  if (!result.ok) return { ok: false as const, message: result.error };
  revalidatePath("/inbox"); revalidatePath("/inbox/untracked");
  return { ok: true as const, message: result.processing.ok ? "Recovered reply imported for review." : `Imported, but analysis needs retry: ${result.processing.error}`,
    eventId: result.eventId, leadId: result.leadId, proposalId: result.processing.proposalId ?? null };
}

export async function dismissUntrackedReplyAction(stagingId: string) {
  const auth = await requireActiveProfileResult(); if (!auth.ok) return auth;
  const id = UuidSchema.safeParse(stagingId); if (!id.success) return { ok: false as const, message: "Invalid staging id." };
  const result = await getAdminClient().from("untracked_replies").update({ status: "dismissed", reviewed_by: auth.profile.email, reviewed_at: new Date().toISOString() })
    .eq("id", id.data).not("status", "in", "(imported,importing)").select("id");
  if (result.error || !result.data?.length) return { ok: false as const, message: result.error?.message ?? "Reply could not be dismissed." };
  revalidatePath("/inbox"); revalidatePath("/inbox/untracked"); return { ok: true as const, message: "Dismissed." };
}

export async function restoreUntrackedReplyAction(stagingId: string) {
  const auth = await requireActiveProfileResult(); if (!auth.ok) return auth;
  const id = UuidSchema.safeParse(stagingId); if (!id.success) return { ok: false as const, message: "Invalid staging id." };
  const result = await getAdminClient().from("untracked_replies").update({ status: "unmatched", reviewed_by: auth.profile.email, reviewed_at: new Date().toISOString() })
    .eq("id", id.data).eq("status", "dismissed").select("id");
  if (result.error || !result.data?.length) return { ok: false as const, message: result.error?.message ?? "Dismissed reply not found." };
  revalidatePath("/inbox"); revalidatePath("/inbox/untracked"); return { ok: true as const, message: "Restored to unmatched." };
}

export async function reclassifyUntrackedReplyAction(stagingId: string) {
  const auth = await requireActiveProfileResult(); if (!auth.ok) return auth;
  const id = UuidSchema.safeParse(stagingId); if (!id.success) return { ok: false as const, message: "Invalid staging id." };
  const admin = getAdminClient();
  const found = await admin.from("untracked_replies").select("id,provider_message_id,from_email,from_name,to_email,subject,body_text,provider_received_at,attempt_count,status,updated_at,reviewed_at")
    .eq("id", id.data).maybeSingle();
  if (found.error || !found.data) return { ok: false as const, message: "Untracked reply not found." };
  if (found.data.reviewed_at && Date.now() - Date.parse(found.data.reviewed_at) < 120_000) return { ok: false as const, message: "Wait two minutes before reclassifying this reply again." };
  if (["imported","importing","dismissed"].includes(found.data.status)) return { ok: false as const, message: "This reply cannot be reclassified in its current state." };
  const now = new Date().toISOString();
  const claim = await admin.from("untracked_replies").update({ status: "processing", process_started_at: now, reviewed_at: now, reviewed_by: auth.profile.email }).eq("id", id.data).eq("updated_at", found.data.updated_at).select("id");
  if (claim.error || !claim.data?.length) return { ok: false as const, message: "Reply changed while reclassification started. Refresh and retry." };
  try {
    const result = await processOneUntrackedReply(found.data as UntrackedRow, await loadSenderContext());
    revalidatePath("/inbox"); revalidatePath("/inbox/untracked"); return { ok: true as const, message: `Reclassified as ${result.status}.`, status: result.status };
  } catch (error) {
    await admin.from("untracked_replies").update({ status: "error", process_started_at: null, last_error: error instanceof Error ? error.message : String(error) }).eq("id", id.data);
    revalidatePath("/inbox"); revalidatePath("/inbox/untracked");
    return { ok: false as const, message: error instanceof Error ? error.message : "Reclassification failed." };
  }
}

export async function getUntrackedCountAction() {
  const auth = await requireActiveProfileResult(); if (!auth.ok) return auth;
  try { return { ok: true as const, ...(await getUntrackedCounts()) }; }
  catch (error) { return { ok: false as const, message: error instanceof Error ? error.message : "Could not load counts." }; }
}
