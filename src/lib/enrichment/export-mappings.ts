import "server-only";

import { getAdminClient } from "@/lib/supabase/admin";
import { getCampaignSequences } from "@/lib/smartlead";
import { getTableColumns } from "@/lib/enrichment/custom-columns";
import { getEffectiveCampaignForTable } from "@/lib/enrichment/workspace";

/* Export variable mapping: which table column feeds each Smartlead {{variable}}
   when a lead is exported. The map lives in enrichment_export_mappings and is
   read on export by getCustomExportVariables and, for preview parity, by the
   email review (buildEmailQaPayload overlays it). This module powers the export
   column's settings dialog: it lists the tagged campaign's variables, classifies
   each as auto-filled or mappable, and persists the operator's choices. */

const TEMPLATE_VAR_RE = /\{\{\s*([a-zA-Z_][\w.]*)\s*\}\}/g;

/* Variables Smartlead fills from the native lead fields we push on export
   (see exportLeadCore / addCampaignLeads) plus its own runtime tokens (sl_*).
   These are not mapped to a column; the dialog shows them as auto-filled. */
const NATIVE_SOURCE: Record<string, string> = {
  first_name: "Cleaned first name",
  last_name: "Last name",
  email: "Email address",
  company_name: "Cleaned company name",
  website: "Company website (domain)",
  linkedin_profile: "LinkedIn URL",
};

function nativeSource(name: string): string | null {
  if (name.startsWith("sl_")) return "Filled by Smartlead at send time";
  return NATIVE_SOURCE[name] ?? null;
}

export type ExportVariableRow =
  | { name: string; kind: "auto"; source: string }
  | { name: string; kind: "custom"; columnId: string | null; suggestedColumnId: string | null };

export type ExportColumnOption = { id: string; key: string; label: string };

export type ExportMappingView = {
  campaign: { id: string; name: string } | null;
  campaignError: string | null;
  variables: ExportVariableRow[];
  columns: ExportColumnOption[];
};

/** Everything the export settings dialog needs: the tagged campaign, the variables
   its sequence uses (auto vs mappable), the current/suggested column per mappable
   variable, and the columns that can supply a value. */
export async function getExportMappingView(tableId: string): Promise<ExportMappingView> {
  const campaign = await getEffectiveCampaignForTable(tableId);
  const columnsAll = await getTableColumns(tableId);
  // Only AI columns are valid mapping targets: their values live in
  // enrichment_cell_values, which is what the export reads (getCustomExportVariables).
  // Source columns are computed from lead/company data (not cells), so mapping to
  // one would silently export blank; builtin/qa/export columns are not values.
  const candidates = columnsAll.filter((c) => c.kind === "ai");
  const columns: ExportColumnOption[] = candidates.map((c) => ({ id: c.id, key: c.key, label: c.label }));
  const columnById = new Map(candidates.map((c) => [c.id, c]));
  const columnByKey = new Map(candidates.map((c) => [c.key, c]));

  if (!campaign) {
    return { campaign: null, campaignError: null, variables: [], columns };
  }

  // The variables the campaign's sequence actually uses (union across steps and
  // every A/B variant), in first-seen order.
  let usedNames: string[];
  try {
    const sequences = await getCampaignSequences(campaign.id);
    const seen = new Set<string>();
    const ordered: string[] = [];
    for (const seq of sequences) {
      const scan = [seq.subject, seq.body, ...(seq.variantTexts ?? [])].join("\n");
      for (const m of scan.matchAll(TEMPLATE_VAR_RE)) {
        if (!seen.has(m[1])) { seen.add(m[1]); ordered.push(m[1]); }
      }
    }
    usedNames = ordered;
  } catch (error) {
    return { campaign: { id: campaign.id, name: campaign.name }, campaignError: error instanceof Error ? error.message : "Could not load the campaign sequence.", variables: [], columns };
  }

  // Existing persisted mappings for this table's custom variables.
  const { data: maps } = await getAdminClient()
    .from("enrichment_export_mappings")
    .select("target_key, column_id, enabled")
    .eq("table_id", tableId).eq("target", "custom_variable");
  const mappedColumnByKey = new Map(
    ((maps ?? []) as { target_key: string; column_id: string; enabled: boolean }[])
      .filter((m) => m.enabled)
      .map((m) => [m.target_key, m.column_id]),
  );

  const variables: ExportVariableRow[] = usedNames.map((name) => {
    const source = nativeSource(name);
    if (source) return { name, kind: "auto", source };
    // A persisted mapping wins; otherwise suggest a same-key column (not saved
    // until the operator confirms).
    const mapped = mappedColumnByKey.get(name);
    const columnId = mapped && columnById.has(mapped) ? mapped : null;
    const suggestedColumnId = columnId ? null : columnByKey.get(name)?.id ?? null;
    return { name, kind: "custom", columnId, suggestedColumnId };
  });

  return { campaign: { id: campaign.id, name: campaign.name }, campaignError: null, variables, columns };
}

export type ExportMappingEntry = { targetKey: string; columnId: string | null };

/** Persist the operator's variable -> column choices. A null columnId clears the
   mapping (the variable falls back to a same-key column at send/preview time, or
   sends blank if there is none). Validates each column belongs to the table. */
export async function saveExportMappings(tableId: string, entries: ExportMappingEntry[]): Promise<{ ok: true } | { ok: false; message: string }> {
  const admin = getAdminClient();
  const clean = entries
    .map((e) => ({ targetKey: String(e.targetKey ?? "").trim(), columnId: e.columnId ? String(e.columnId) : null }))
    .filter((e) => e.targetKey.length > 0 && e.targetKey.length <= 120);

  const columnIds = [...new Set(clean.map((e) => e.columnId).filter((id): id is string => Boolean(id)))];
  if (columnIds.length) {
    // Must belong to this table AND be an AI column: only AI columns store their
    // value in enrichment_cell_values, which is what the export reads. Mapping a
    // source/builtin column would silently export blank.
    const { data: valid, error } = await admin.from("enrichment_columns").select("id, kind").eq("table_id", tableId).in("id", columnIds);
    if (error) return { ok: false, message: error.message };
    const aiIds = new Set((valid ?? []).filter((r) => (r as { kind?: string }).kind === "ai").map((r) => String((r as { id: string }).id)));
    const bad = columnIds.find((id) => !aiIds.has(id));
    if (bad) return { ok: false, message: "Variables can only be mapped to an AI column on this list." };
  }

  const toUpsert = clean.filter((e) => e.columnId).map((e) => ({
    table_id: tableId, column_id: e.columnId, target: "custom_variable", target_key: e.targetKey, enabled: true, updated_at: new Date().toISOString(),
  }));
  const toClear = clean.filter((e) => !e.columnId).map((e) => e.targetKey);

  if (toUpsert.length) {
    const { error } = await admin.from("enrichment_export_mappings").upsert(toUpsert, { onConflict: "table_id,target,target_key" });
    if (error) return { ok: false, message: error.message };
  }
  if (toClear.length) {
    const { error } = await admin.from("enrichment_export_mappings").delete()
      .eq("table_id", tableId).eq("target", "custom_variable").in("target_key", toClear);
    if (error) return { ok: false, message: error.message };
  }
  return { ok: true };
}
