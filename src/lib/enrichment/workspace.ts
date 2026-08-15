import "server-only";

import { z } from "zod";
import { getAdminClient } from "@/lib/supabase/admin";

export const canonicalFilterSchema = z.object({
  roleLevels: z.array(z.string().max(100)).max(50).optional(),
  emailStatuses: z.array(z.string().max(100)).max(50).optional(),
  countries: z.array(z.string().max(100)).max(50).optional(),
  hasEmail: z.boolean().optional(),
  qualifiedOnly: z.boolean().optional(),
  // Base-scope dimensions, set only in table config (never from user input).
  // minContacts relaxes the default >=2-contacts-per-company floor;
  // excludeCompanyRole drops any company that has a lead of that role (e.g. a
  // Decision Makers list excludes companies where we already have a manager).
  minContacts: z.number().int().min(1).max(100).optional(),
  excludeCompanyRole: z.string().max(100).optional(),
  // When false, the list drops the "must be in a send wave" gate and shows
  // every matching lead (default true preserves the prior behavior).
  requireSendWave: z.boolean().optional(),
}).strict();

export type CanonicalFilter = z.infer<typeof canonicalFilterSchema>;
export type Folder = { id: string; name: string; smartleadCampaignId: string | null; smartleadCampaignName: string | null; sortOrder: number; createdAt: string; updatedAt: string };
export type Workbook = { id: string; slug: string; name: string; description: string; folderId: string | null; smartleadCampaignId: string | null; smartleadCampaignName: string | null; sortOrder: number; createdAt: string; updatedAt: string };
export type TableSummary = { id: string; workbookId: string; slug: string; name: string; description: string; source: "leads"; config: Record<string, unknown>; canonical: CanonicalFilter; smartleadCampaignId: string | null; smartleadCampaignName: string | null; sortOrder: number; createdAt: string; updatedAt: string; layoutVersion: string };
export type WorkspaceTree = { folders: Folder[]; workbooks: (Workbook & { tables: TableSummary[] })[] };
export type EffectiveCampaign = { id: string; name: string; source: "table" | "workbook" | "folder" } | null;

const NAME_MAX = 80;
const DESCRIPTION_MAX = 300;

function cleanName(value: string) {
  const name = value.trim();
  if (!name || name.length > NAME_MAX) throw new Error(`Name must be between 1 and ${NAME_MAX} characters.`);
  return name;
}

function cleanDescription(value: string) {
  const description = value.trim();
  if (description.length > DESCRIPTION_MAX) throw new Error(`Description must be at most ${DESCRIPTION_MAX} characters.`);
  return description;
}

function baseSlug(value: string) {
  const slug = value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60).replace(/-+$/g, "");
  return slug || "untitled";
}

function folder(row: Record<string, unknown>): Folder {
  return { id: String(row.id), name: String(row.name), smartleadCampaignId: row.smartlead_campaign_id ? String(row.smartlead_campaign_id) : null, smartleadCampaignName: row.smartlead_campaign_name ? String(row.smartlead_campaign_name) : null, sortOrder: Number(row.sort_order), createdAt: String(row.created_at), updatedAt: String(row.updated_at) };
}

function workbook(row: Record<string, unknown>): Workbook {
  return { id: String(row.id), slug: String(row.slug), name: String(row.name), description: String(row.description), folderId: row.folder_id ? String(row.folder_id) : null, smartleadCampaignId: row.smartlead_campaign_id ? String(row.smartlead_campaign_id) : null, smartleadCampaignName: row.smartlead_campaign_name ? String(row.smartlead_campaign_name) : null, sortOrder: Number(row.sort_order), createdAt: String(row.created_at), updatedAt: String(row.updated_at) };
}

function table(row: Record<string, unknown>): TableSummary {
  const config = row.config && typeof row.config === "object" && !Array.isArray(row.config) ? row.config as Record<string, unknown> : {};
  const parsed = canonicalFilterSchema.safeParse(config);
  // Fail CLOSED: a config this code cannot interpret must never widen the
  // list to the whole pool (a list's rows can be exported to its campaign).
  const canonical: CanonicalFilter = parsed.success ? parsed.data : { roleLevels: ["__none__"] };
  return { id: String(row.id), workbookId: String(row.workbook_id), slug: String(row.slug), name: String(row.name), description: String(row.description), source: "leads", config, canonical, smartleadCampaignId: row.smartlead_campaign_id ? String(row.smartlead_campaign_id) : null, smartleadCampaignName: row.smartlead_campaign_name ? String(row.smartlead_campaign_name) : null, sortOrder: Number(row.sort_order), createdAt: String(row.created_at), updatedAt: String(row.updated_at), layoutVersion: typeof row.layout_version === "string" && row.layout_version ? row.layout_version : "v1" };
}

function fail(error: { message: string; code?: string } | null, context: string): never | void {
  if (error) throw new Error(`${context}: ${error.message}`);
}

async function nextSortOrder(relation: "enrichment_folders" | "enrichment_workbooks" | "enrichment_tables", workbookId?: string) {
  let query = getAdminClient().from(relation).select("sort_order").order("sort_order", { ascending: false }).limit(1);
  if (workbookId) query = query.eq("workbook_id", workbookId);
  const { data, error } = await query;
  fail(error, "Workspace sort order");
  return Number(data?.[0]?.sort_order ?? -1) + 1;
}

async function uniqueSlug(name: string, scope?: { workbookId: string }) {
  const base = baseSlug(name);
  for (let attempt = 1; attempt <= 9; attempt += 1) {
    const suffix = attempt === 1 ? "" : `-${attempt}`;
    const candidate = `${base.slice(0, 60 - suffix.length).replace(/-+$/g, "")}${suffix}`;
    let query = getAdminClient().from(scope ? "enrichment_tables" : "enrichment_workbooks").select("id").eq("slug", candidate).limit(1);
    if (scope) query = query.eq("workbook_id", scope.workbookId);
    const { data, error } = await query;
    fail(error, "Workspace slug lookup");
    if (!data?.length) return candidate;
  }
  throw new Error("Could not generate a unique slug after 9 attempts.");
}

export async function getWorkspaceTree(): Promise<WorkspaceTree> {
  const [foldersResult, workbooksResult] = await Promise.all([
    getAdminClient().from("enrichment_folders").select("id,name,smartlead_campaign_id,smartlead_campaign_name,sort_order,created_at,updated_at").order("sort_order").order("name").order("id"),
    getAdminClient().from("enrichment_workbooks").select("id,slug,name,description,folder_id,smartlead_campaign_id,smartlead_campaign_name,sort_order,created_at,updated_at,enrichment_tables(id,workbook_id,slug,name,description,source,config,smartlead_campaign_id,smartlead_campaign_name,sort_order,created_at,updated_at)").order("sort_order").order("name").order("id"),
  ]);
  fail(foldersResult.error, "Workspace folders");
  fail(workbooksResult.error, "Workspace workbooks");
  return {
    folders: (foldersResult.data ?? []).map((row) => folder(row)).sort((a, b) => a.sortOrder - b.sortOrder || a.name.toLowerCase().localeCompare(b.name.toLowerCase()) || a.id.localeCompare(b.id)),
    workbooks: (workbooksResult.data ?? []).map((row) => ({
      ...workbook(row),
      tables: ((row.enrichment_tables ?? []) as Record<string, unknown>[]).map(table).sort((a, b) => a.sortOrder - b.sortOrder || a.name.toLowerCase().localeCompare(b.name.toLowerCase()) || a.id.localeCompare(b.id)),
    })).sort((a, b) => a.sortOrder - b.sortOrder || a.name.toLowerCase().localeCompare(b.name.toLowerCase()) || a.id.localeCompare(b.id)),
  };
}

export async function createFolder(name: string) {
  const { data, error } = await getAdminClient().from("enrichment_folders").insert({ name: cleanName(name), sort_order: await nextSortOrder("enrichment_folders") }).select("id,name,sort_order,created_at,updated_at").single();
  fail(error, "Folder creation"); if (!data) throw new Error("Folder creation returned no row."); return folder(data);
}
export async function renameFolder(id: string, name: string) { const { data, error } = await getAdminClient().from("enrichment_folders").update({ name: cleanName(name) }).eq("id", id).select("id,name,sort_order,created_at,updated_at").single(); fail(error, "Folder rename"); if (!data) throw new Error("Folder rename returned no row."); return folder(data); }
export async function deleteFolder(id: string) { const { error } = await getAdminClient().from("enrichment_folders").delete().eq("id", id); if (error?.code === "23503") throw new Error("This folder contains workbooks. Move or delete them first."); fail(error, "Folder deletion"); }

export async function createWorkbook(name: string, description: string, folderId?: string | null) {
  const clean = cleanName(name); const { data, error } = await getAdminClient().from("enrichment_workbooks").insert({ slug: await uniqueSlug(clean), name: clean, description: cleanDescription(description), folder_id: folderId ?? null, sort_order: await nextSortOrder("enrichment_workbooks") }).select("*").single(); fail(error, "Workbook creation"); return workbook(data);
}
export async function renameWorkbook(id: string, name: string) { const { data, error } = await getAdminClient().from("enrichment_workbooks").update({ name: cleanName(name) }).eq("id", id).select("*").single(); fail(error, "Workbook rename"); return workbook(data); }
export async function moveWorkbookToFolder(id: string, folderId?: string | null) { const { data, error } = await getAdminClient().from("enrichment_workbooks").update({ folder_id: folderId ?? null }).eq("id", id).select("*").single(); fail(error, "Workbook move"); return workbook(data); }
export async function deleteWorkbook(id: string) { const { error } = await getAdminClient().from("enrichment_workbooks").delete().eq("id", id); if (error?.code === "23503") throw new Error("This workbook contains tables. Delete them first."); fail(error, "Workbook deletion"); }

export async function createTable(workbookId: string, name: string, description: string, config: unknown = {}) {
  const clean = cleanName(name); const canonical = canonicalFilterSchema.parse(config); const { data, error } = await getAdminClient().from("enrichment_tables").insert({ workbook_id: workbookId, slug: await uniqueSlug(clean, { workbookId }), name: clean, description: cleanDescription(description), config: canonical, sort_order: await nextSortOrder("enrichment_tables", workbookId) }).select("*").single(); fail(error, "Table creation"); return table(data);
}
export async function renameTable(id: string, name: string) { const { data, error } = await getAdminClient().from("enrichment_tables").update({ name: cleanName(name) }).eq("id", id).select("*").single(); fail(error, "Table rename"); return table(data); }
export async function moveTableToWorkbook(tableId: string, workbookId: string) {
  const current = await getTableById(tableId); if (!current) throw new Error("Table not found.");
  // A same-NAME collision in the target can never be fixed by slug retries;
  // detect it up front and fail with the real reason.
  const nameClash = await getAdminClient().from("enrichment_tables").select("id").eq("workbook_id", workbookId).ilike("name", current.name.replace(/[\\%_]/g, "\\$&")).limit(1);
  fail(nameClash.error, "Table move");
  if (nameClash.data?.length) throw new Error(`The target workbook already has a table named "${current.name}". Rename one first.`);
  const base = baseSlug(current.slug);
  const sortOrder = await nextSortOrder("enrichment_tables", workbookId);
  for (let attempt = 1; attempt <= 9; attempt += 1) {
    const suffix = attempt === 1 ? "" : `-${attempt}`;
    const slug = `${base.slice(0, 60 - suffix.length).replace(/-+$/g, "")}${suffix}`;
    const { data, error } = await getAdminClient().from("enrichment_tables").update({ workbook_id: workbookId, slug, sort_order: sortOrder }).eq("id", tableId).select("*").single();
    if (!error && data) return table(data);
    if (error?.code !== "23505") fail(error, "Table move");
  }
  throw new Error("Could not generate a unique table slug after 9 attempts.");
}
export async function reorderTable(tableId: string, direction: "left" | "right") {
  const current = await getTableById(tableId); if (!current) throw new Error("Table not found.");
  const tree = await getWorkspaceTree(); const siblings = tree.workbooks.find((item) => item.id === current.workbookId)?.tables ?? []; const index = siblings.findIndex((item) => item.id === tableId); const neighbor = siblings[index + (direction === "left" ? -1 : 1)]; if (!neighbor) return current;
  const { error } = await getAdminClient().rpc("enrichment_swap_table_sort_orders", { p_table_id: current.id, p_neighbor_id: neighbor.id }); fail(error, "Table reorder"); return { ...current, sortOrder: neighbor.sortOrder };
}
export async function deleteTable(id: string) { const { error } = await getAdminClient().from("enrichment_tables").delete().eq("id", id); fail(error, "Table deletion"); }
export async function setFolderCampaign(id: string, tag: { id: string; name: string } | null) { const { data, error } = await getAdminClient().from("enrichment_folders").update({ smartlead_campaign_id: tag?.id ?? null, smartlead_campaign_name: tag?.name ?? null }).eq("id", id).select("*").single(); fail(error, "Folder campaign update"); return folder(data); }
export async function setWorkbookCampaign(id: string, tag: { id: string; name: string } | null) { const { data, error } = await getAdminClient().from("enrichment_workbooks").update({ smartlead_campaign_id: tag?.id ?? null, smartlead_campaign_name: tag?.name ?? null }).eq("id", id).select("*").single(); fail(error, "Workbook campaign update"); return workbook(data); }
export async function setTableCampaign(id: string, tag: { id: string; name: string } | null) { const { data, error } = await getAdminClient().from("enrichment_tables").update({ smartlead_campaign_id: tag?.id ?? null, smartlead_campaign_name: tag?.name ?? null }).eq("id", id).select("*").single(); fail(error, "Table campaign update"); return table(data); }
export async function getTableById(id: string) { const { data, error } = await getAdminClient().from("enrichment_tables").select("*").eq("id", id).maybeSingle(); fail(error, "Table lookup"); return data ? table(data) : null; }
export function resolveEffectiveCampaign(selected: TableSummary, book: Workbook, parent: Folder | null): EffectiveCampaign {
  if (selected.smartleadCampaignId && selected.smartleadCampaignName) return { id: selected.smartleadCampaignId, name: selected.smartleadCampaignName, source: "table" };
  if (book.smartleadCampaignId && book.smartleadCampaignName) return { id: book.smartleadCampaignId, name: book.smartleadCampaignName, source: "workbook" };
  if (parent?.smartleadCampaignId && parent.smartleadCampaignName) return { id: parent.smartleadCampaignId, name: parent.smartleadCampaignName, source: "folder" };
  return null;
}
export async function resolveTable(workbookSlug: string, tableSlug: string) {
  const { data: book, error } = await getAdminClient().from("enrichment_workbooks").select("*").eq("slug", workbookSlug).maybeSingle(); fail(error, "Workbook lookup"); if (!book) return null;
  const [tablesResult, folderResult] = await Promise.all([
    getAdminClient().from("enrichment_tables").select("*").eq("workbook_id", book.id).order("sort_order").order("name").order("id"),
    book.folder_id ? getAdminClient().from("enrichment_folders").select("*").eq("id", book.folder_id).maybeSingle() : Promise.resolve({ data: null, error: null }),
  ]);
  fail(tablesResult.error, "Table lookup"); fail(folderResult.error, "Folder lookup");
  const siblings = (tablesResult.data ?? []).map(table); const selected = siblings.find((item) => item.slug === tableSlug); if (!selected) return null;
  const normalizedWorkbook = workbook(book); const normalizedFolder = folderResult.data ? folder(folderResult.data) : null;
  return { workbook: normalizedWorkbook, table: selected, siblings, folder: normalizedFolder, effectiveCampaign: resolveEffectiveCampaign(selected, normalizedWorkbook, normalizedFolder) };
}

export async function getEffectiveCampaignForTable(tableId: string): Promise<EffectiveCampaign> {
  const selected = await getTableById(tableId); if (!selected) return null;
  const { data: book, error } = await getAdminClient().from("enrichment_workbooks").select("*").eq("id", selected.workbookId).maybeSingle(); fail(error, "Workbook lookup"); if (!book) return null;
  const normalizedWorkbook = workbook(book);
  if (!normalizedWorkbook.folderId) return resolveEffectiveCampaign(selected, normalizedWorkbook, null);
  const { data: parent, error: folderError } = await getAdminClient().from("enrichment_folders").select("*").eq("id", normalizedWorkbook.folderId).maybeSingle(); fail(folderError, "Folder lookup");
  return resolveEffectiveCampaign(selected, normalizedWorkbook, parent ? folder(parent) : null);
}
