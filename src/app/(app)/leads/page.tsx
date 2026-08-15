import type { Metadata } from "next";
import { requireActiveProfile } from "@/lib/auth";
import { getCrmLeadsPage, type CrmLeadsFilter } from "@/lib/crm/queries";
import { getWorkspaceSettings } from "@/lib/settings-store";
import { listCampaigns } from "@/lib/smartlead";
import { getTaxonomy } from "@/lib/taxonomy-store";
import { LeadsClient, type CampaignChoice, type InitialLeadsView, type LeadRow } from "./leads-client";

export const metadata: Metadata = { title: "Leads" };
export const dynamic = "force-dynamic";

/* Deep-link contract (analytics/campaign modals link here):
   /leads?kind=replies|positive|referrals|awaiting_review|ooo|dnc_asked|dnc_defunct
         &days=7|30|90&campaigns=<csv ids>&mode=include|exclude&search=<text>
   Unknown or malformed values are ignored, never an error. */

const KIND_LABELS = {
  replies: "All replies",
  positive: "Positive replies",
  referrals: "Referrals",
  awaiting_review: "Awaiting review",
  ooo: "Out of office",
  dnc_asked: "Do not contact (asked)",
  dnc_defunct: "Do not contact (dead mailbox)",
} as const;
type Kind = keyof typeof KIND_LABELS;

const first = (value: string | string[] | undefined): string | null =>
  Array.isArray(value) ? (value[0] ?? null) : (value ?? null);

/** Start of the rolling reply window. Kept outside the component body: request
    handlers are allowed wall-clock reads, but the compiler's purity lint is not
    told this is a server component, so the impure call lives here. */
function isoDaysAgo(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString();
}

export default async function LeadsPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  await requireActiveProfile();

  const params = await searchParams;

  // Defensive parse: every param independently validated; anything off-contract
  // is dropped so a stale or hand-edited link still lands on a working page.
  const kindRaw = first(params.kind);
  const kind: Kind | null = kindRaw !== null && kindRaw in KIND_LABELS ? (kindRaw as Kind) : null;

  const daysRaw = first(params.days);
  const days: 7 | 30 | 90 | null =
    daysRaw === "7" ? 7 : daysRaw === "30" ? 30 : daysRaw === "90" ? 90 : null;

  const csvIds = (first(params.campaigns) ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter((id) => /^\d+$/.test(id))
    .slice(0, 300);
  const mode = first(params.mode) === "exclude" ? "exclude" : "include";
  const search = (first(params.search) ?? "").trim().slice(0, 200);

  // The campaign roster only feeds the toolbar. Native include/exclude RPC
  // parameters keep deep-link data filtering exact if Smartlead is down.
  const workspacePromise = getWorkspaceSettings();
  const campaignsPromise = listCampaigns()
    .then((rows) => [...rows].sort((a, b) => a.name.localeCompare(b.name)))
    .catch(() => [] as CampaignChoice[]);

  // kind -> CrmLeadsFilter, expanded server-side.
  const filter: CrmLeadsFilter = {
    limit: 50,
    offset: 0,
    search: search || null,
    sort: "last_reply_at",
    sortDir: "desc",
  };
  let categories: string[] = [];
  if (kind === "replies") filter.replied = true;
  if (kind === "positive") filter.sentimentTypes = ["positive"];
  if (kind === "referrals") filter.referral = true;
  if (kind === "awaiting_review") filter.proposalStatuses = ["pending"];
  if (kind === "ooo") {
    // Out-of-office is a taxonomy role, not a fixed label -- expand it here.
    const taxonomy = await getTaxonomy();
    categories = taxonomy.all
      .filter((category) => category.systemRole === "out_of_office")
      .map((category) => category.label);
    if (categories.length > 0) filter.categories = categories;
  }
  if (kind === "dnc_asked") {
    // DncReason has exactly two values, so "everything except email_defunct"
    // is expressible precisely as explicit_request.
    filter.dnc = true;
    filter.dncApprovedOnly = true;
    filter.dncReasons = ["explicit_request"];
  }
  if (kind === "dnc_defunct") {
    filter.dnc = true;
    filter.dncApprovedOnly = true;
    filter.dncReasons = ["email_defunct"];
  }
  if (days !== null) filter.replyFrom = isoDaysAgo(days);
  if (csvIds.length > 0 && mode === "include") filter.campaignIds = csvIds;
  if (csvIds.length > 0 && mode === "exclude") filter.campaignExcludeIds = csvIds;

  // First page rendered server-side so the initial paint needs no client fetch.
  // A query failure degrades to the client's error state with Retry.
  let initialPage: { rows: LeadRow[]; total: number } | null = null;
  let initialError: string | null = null;
  const pagePromise = getCrmLeadsPage(filter);
  const [workspace, campaigns] = await Promise.all([workspacePromise, campaignsPromise]);
  try {
    initialPage = await pagePromise;
  } catch (error) {
    initialError = error instanceof Error ? error.message : "Could not load leads.";
  }

  const initialView: InitialLeadsView = {
    campaignIds: csvIds,
    campaignMode: mode,
    search,
    replied: filter.replied === true,
    positive: kind === "positive",
    referral: filter.referral === true,
    dnc: filter.dnc === true,
    dncReasons: filter.dncReasons ?? [],
    dncApprovedOnly: filter.dncApprovedOnly === true,
    proposalStatuses: filter.proposalStatuses ?? [],
    categories,
    days: days ?? 0,
  };

  return (
    <LeadsClient
      initialView={initialView}
      initialPage={initialPage}
      initialError={initialError}
      kindLabel={kind ? KIND_LABELS[kind] : null}
      campaigns={campaigns}
      timeZone={workspace.timeZone}
      timeLocale={workspace.timeLocale}
    />
  );
}
