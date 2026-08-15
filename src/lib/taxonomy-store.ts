import "server-only";

import { getAdminClient } from "@/lib/supabase/admin";
import {
  SEEDED_REPLY_CATEGORIES,
  categoryByValue,
  categoryFromLabel,
  fallbackCategory,
  roleCategory,
  smartleadCategoryToValue,
  type ReplyCategory,
  type ReplySentimentType,
  type SystemRole,
} from "@/lib/taxonomy";

const CACHE_TTL_MS = 30_000;
const CATEGORY_COLUMNS =
  "id, value, label, description, sentiment_type, suppress, dnc, draft_reply, draft_guidance, color, sort_order, active, system_role";

type CategoryRow = {
  id: string;
  value: string;
  label: string;
  description: string | null;
  sentiment_type: ReplySentimentType;
  suppress: boolean;
  dnc: boolean;
  draft_reply: boolean;
  draft_guidance: string | null;
  color: string | null;
  sort_order: number;
  active: boolean;
  system_role: SystemRole | null;
};

export type Taxonomy = {
  all: ReplyCategory[];
  active: ReplyCategory[];
  byValue(value: string | null | undefined): ReplyCategory | null;
  resolve(value: string | null | undefined): ReplyCategory;
  fromLabel(label: string | null | undefined): ReplyCategory | null;
  fromSmartleadLabel(label: string | null | undefined): string | null;
  fallback: ReplyCategory;
  role(role: SystemRole): ReplyCategory | null;
};

export type CreateCategoryInput = {
  label: string;
  description?: string | null;
  sentimentType: ReplySentimentType;
  suppress: boolean;
  dnc: boolean;
  draftReply: boolean;
  draftGuidance?: string | null;
  color?: string | null;
};

export type UpdateCategoryPatch = Partial<CreateCategoryInput> & {
  sortOrder?: number;
  active?: boolean;
};

type MutationResult = { ok: boolean; message: string };
type CreateResult = MutationResult & { category?: ReplyCategory };

let cached: { expiresAt: number; promise: Promise<Taxonomy> } | null = null;

function fromRow(row: CategoryRow): ReplyCategory {
  return {
    id: row.id,
    value: row.value,
    label: row.label,
    description: row.description,
    sentimentType: row.sentiment_type,
    suppress: row.suppress,
    dnc: row.dnc,
    draftReply: row.draft_reply,
    draftGuidance: row.draft_guidance,
    color: row.color,
    sortOrder: row.sort_order,
    active: row.active,
    systemRole: row.system_role,
  };
}

function buildTaxonomy(rows: readonly ReplyCategory[]): Taxonomy {
  const all = rows.map((category) => ({ ...category }));
  const active = all.filter((category) => category.active);
  const fallback = fallbackCategory(all);
  return {
    all,
    active,
    byValue: (value) => categoryByValue(all, value),
    resolve: (value) => categoryByValue(all, value) ?? fallback,
    fromLabel: (label) => categoryFromLabel(all, label),
    fromSmartleadLabel: (label) => smartleadCategoryToValue(active, label),
    fallback,
    role: (role) => roleCategory(all, role),
  };
}

async function loadTaxonomy(): Promise<Taxonomy> {
  try {
    const { data, error } = await getAdminClient()
      .from("reply_categories")
      .select(CATEGORY_COLUMNS)
      .order("sort_order", { ascending: true });
    if (error || !data || data.length === 0) return buildTaxonomy(SEEDED_REPLY_CATEGORIES);
    return buildTaxonomy((data as CategoryRow[]).map(fromRow));
  } catch {
    return buildTaxonomy(SEEDED_REPLY_CATEGORIES);
  }
}

export async function getTaxonomy(): Promise<Taxonomy> {
  const now = Date.now();
  if (!cached || cached.expiresAt <= now) {
    cached = { expiresAt: now + CACHE_TTL_MS, promise: loadTaxonomy() };
  }
  return cached.promise;
}

export function invalidateTaxonomy(): void {
  cached = null;
}

export async function listCategories(): Promise<ReplyCategory[]> {
  return (await getTaxonomy()).all;
}

function slugFromLabel(label: string): string {
  return (
    label
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .replace(/_+/g, "_") || "category"
  );
}

function nullableText(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

export async function createCategory(input: CreateCategoryInput): Promise<CreateResult> {
  const label = input.label.trim();
  if (!label) return { ok: false, message: "Category label is required." };

  const taxonomy = await getTaxonomy();
  if (taxonomy.all.some((category) => category.label.toLowerCase() === label.toLowerCase())) {
    return { ok: false, message: "A category with that label already exists." };
  }

  const values = new Set(taxonomy.all.map((category) => category.value));
  const baseValue = slugFromLabel(label);
  let value = baseValue;
  let suffix = 2;
  while (values.has(value)) {
    value = `${baseValue}_${suffix}`;
    suffix += 1;
  }
  const sortOrder = taxonomy.all.reduce((max, category) => Math.max(max, category.sortOrder), -1) + 1;

  const { data, error } = await getAdminClient()
    .from("reply_categories")
    .insert({
      value,
      label,
      description: nullableText(input.description),
      sentiment_type: input.sentimentType,
      suppress: input.suppress,
      dnc: input.dnc,
      draft_reply: input.draftReply,
      draft_guidance: nullableText(input.draftGuidance),
      color: nullableText(input.color),
      sort_order: sortOrder,
    })
    .select(CATEGORY_COLUMNS)
    .single();
  if (error || !data) {
    return { ok: false, message: error?.message ?? "Could not create category." };
  }

  invalidateTaxonomy();
  return { ok: true, message: "Category created.", category: fromRow(data as CategoryRow) };
}

// The static-seed fallback uses synthetic "seed-*" ids. A mutation against one
// would .eq() zero real rows yet report success — refuse instead so a transient
// DB read blip inside the cache window can't produce silent no-op "updates".
function fallbackTaxonomyGuard(taxonomy: Taxonomy): MutationResult | null {
  if (taxonomy.all.some((category) => category.id.startsWith("seed-"))) {
    return { ok: false, message: "Category data is temporarily unavailable. Try again in a moment." };
  }
  return null;
}

export async function updateCategory(id: string, patch: UpdateCategoryPatch): Promise<MutationResult> {
  const taxonomy = await getTaxonomy();
  const unavailable = fallbackTaxonomyGuard(taxonomy);
  if (unavailable) return unavailable;
  const existing = taxonomy.all.find((category) => category.id === id);
  if (!existing) return { ok: false, message: "Category not found." };

  if (patch.active === false && existing.systemRole) {
    return { ok: false, message: "System categories cannot be deactivated." };
  }

  const label = patch.label === undefined ? undefined : patch.label.trim();
  if (label !== undefined) {
    if (!label) return { ok: false, message: "Category label is required." };
    if (
      taxonomy.all.some(
        (category) => category.id !== id && category.label.toLowerCase() === label.toLowerCase(),
      )
    ) {
      return { ok: false, message: "A category with that label already exists." };
    }
  }

  const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (label !== undefined) updates.label = label;
  if (patch.description !== undefined) updates.description = nullableText(patch.description);
  if (patch.sentimentType !== undefined) updates.sentiment_type = patch.sentimentType;
  if (patch.suppress !== undefined) updates.suppress = patch.suppress;
  if (patch.dnc !== undefined) updates.dnc = patch.dnc;
  if (patch.draftReply !== undefined) updates.draft_reply = patch.draftReply;
  if (patch.draftGuidance !== undefined) updates.draft_guidance = nullableText(patch.draftGuidance);
  if (patch.color !== undefined) updates.color = nullableText(patch.color);
  if (patch.sortOrder !== undefined) updates.sort_order = patch.sortOrder;
  if (patch.active !== undefined) updates.active = patch.active;

  const { error } = await getAdminClient().from("reply_categories").update(updates).eq("id", id);
  if (error) return { ok: false, message: error.message };
  invalidateTaxonomy();
  return { ok: true, message: "Category updated." };
}

export async function deleteCategory(id: string): Promise<MutationResult> {
  const taxonomy = await getTaxonomy();
  const unavailable = fallbackTaxonomyGuard(taxonomy);
  if (unavailable) return unavailable;
  const existing = taxonomy.all.find((category) => category.id === id);
  if (!existing) return { ok: false, message: "Category not found." };
  if (existing.systemRole) {
    return { ok: false, message: "System categories cannot be deleted." };
  }

  const admin = getAdminClient();
  const [{ count: proposalCount, error: proposalError }, { count: channelCount, error: channelError }] =
    await Promise.all([
      admin
        .from("reply_proposals")
        .select("id", { count: "exact", head: true })
        .eq("sentiment", existing.label),
      admin
        .from("notification_channels")
        .select("id", { count: "exact", head: true })
        .contains("categories", [existing.value]),
    ]);
  if (proposalError || channelError) {
    return { ok: false, message: proposalError?.message ?? channelError?.message ?? "Could not check category usage." };
  }

  if ((proposalCount ?? 0) > 0 || (channelCount ?? 0) > 0) {
    const { error } = await admin
      .from("reply_categories")
      .update({ active: false, updated_at: new Date().toISOString() })
      .eq("id", id);
    if (error) return { ok: false, message: error.message };
    invalidateTaxonomy();
    return { ok: true, message: "Category is in use, so it was deactivated instead of deleted." };
  }

  const { error } = await admin.from("reply_categories").delete().eq("id", id);
  if (error) return { ok: false, message: error.message };
  invalidateTaxonomy();
  return { ok: true, message: "Category deleted." };
}

export async function reorderCategories(orderedIds: string[]): Promise<MutationResult> {
  const taxonomy = await getTaxonomy();
  const unavailable = fallbackTaxonomyGuard(taxonomy);
  if (unavailable) return unavailable;
  const uniqueIds = new Set(orderedIds);
  if (
    uniqueIds.size !== orderedIds.length ||
    orderedIds.length !== taxonomy.all.length ||
    taxonomy.all.some((category) => !uniqueIds.has(category.id))
  ) {
    return { ok: false, message: "Category order must include every category exactly once." };
  }

  const admin = getAdminClient();
  const results = await Promise.all(
    orderedIds.map((id, sortOrder) =>
      admin
        .from("reply_categories")
        .update({ sort_order: sortOrder, updated_at: new Date().toISOString() })
        .eq("id", id),
    ),
  );
  const failure = results.find((result) => result.error);
  if (failure?.error) return { ok: false, message: failure.error.message };
  invalidateTaxonomy();
  return { ok: true, message: "Category order updated." };
}
