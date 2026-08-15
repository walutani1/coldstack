import "server-only";

import { htmlToText } from "@/lib/html";
import { getAdminClient } from "@/lib/supabase/admin";

export type UntrackedGroup = "all" | "actionable" | "cleaned" | "dismissed" | "imported" | "error";
const GROUPS: Record<Exclude<UntrackedGroup, "all">, string[]> = {
  actionable: ["new","processing","suggested","possible_match","unmatched"],
  cleaned: ["automated","duplicate"], dismissed: ["dismissed"], imported: ["imported","importing"], error: ["error"],
};

async function exactGroupCounts(groups: Partial<typeof GROUPS>) {
  const admin = getAdminClient();
  const entries = await Promise.all(Object.entries(groups).map(async ([group, statuses]) => {
    const result = await admin.from("untracked_replies").select("id", { count: "exact", head: true }).in("status", statuses);
    if (result.error) throw new Error(`Untracked ${group} count: ${result.error.message}`);
    return [group, result.count ?? 0] as const;
  }));
  return Object.fromEntries(entries) as Record<string, number>;
}

export async function getUntrackedOverview(input: { page?: number; pageSize?: number; group?: UntrackedGroup; status?: string } = {}) {
  const admin = getAdminClient();
  const page = Math.max(1, input.page ?? 1), pageSize = Math.max(1, Math.min(input.pageSize ?? 50, 100));
  let query = admin.from("untracked_replies").select("*", { count: "exact" });
  if (input.status) query = query.eq("status", input.status);
  else if (input.group && input.group !== "all") query = query.in("status", GROUPS[input.group]);
  const [rowsResult, groupCounts] = await Promise.all([
    query.order("first_seen_at", { ascending: false }).order("id", { ascending: false }).range((page - 1) * pageSize, page * pageSize - 1),
    exactGroupCounts(GROUPS),
  ]);
  if (rowsResult.error) throw new Error(`Untracked overview: ${rowsResult.error.message}`);
  // Smartlead's visible_text is sometimes raw HTML source; flatten it here so
  // the review cards read as prose. The provider payload (raw) never ships to
  // the client.
  const rows = (rowsResult.data ?? []).map((row) => {
    const rest = { ...(row as Record<string, unknown>) };
    delete rest.raw;
    const body = typeof rest.body_text === "string"
      ? htmlToText(rest.body_text).replace(/\s+/g, " ").trim().slice(0, 1200)
      : rest.body_text;
    return { ...rest, body_text: body };
  });
  return { rows, page, pageSize, total: rowsResult.count ?? 0, byStatus: {},
    groups: { actionable: groupCounts.actionable ?? 0, cleaned: groupCounts.cleaned ?? 0,
      dismissed: groupCounts.dismissed ?? 0, imported: groupCounts.imported ?? 0, error: groupCounts.error ?? 0 } };
}

export async function getUntrackedCounts() {
  const counts = await exactGroupCounts({ actionable: GROUPS.actionable, cleaned: GROUPS.cleaned });
  return {
    actionable: counts.actionable ?? 0,
    cleaned: counts.cleaned ?? 0,
  };
}
