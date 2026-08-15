import { notFound, redirect } from "next/navigation";
import { requireActiveProfile } from "@/lib/auth";
import { getWorkspaceTree } from "@/lib/enrichment/workspace";

export const dynamic = "force-dynamic";

/* A workbook URL lands on its first table. The tree already orders tables by
   (sort_order, lower(name), id), so the first entry is the leftmost tab. */
export default async function WorkbookPage({
  params,
}: {
  params: Promise<{ workbookSlug: string }>;
}) {
  await requireActiveProfile();

  const { workbookSlug } = await params;
  // Legacy: the pre-workbook route was /enrichment/two-contact-leads. Old
  // links must keep working, so redirect before any workbook lookup.
  if (workbookSlug === "two-contact-leads") {
    redirect("/enrichment/manufacturing-ops/two-contact-leads");
  }

  const tree = await getWorkspaceTree();
  const workbook = tree.workbooks.find((item) => item.slug === workbookSlug);
  if (!workbook) notFound();

  const firstTable = workbook.tables[0];
  if (!firstTable) notFound();

  redirect(`/enrichment/${workbook.slug}/${firstTable.slug}`);
}
