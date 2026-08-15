"use server";

import { z } from "zod";
import { requireActiveProfile } from "@/lib/auth";
import type { ActionResult } from "@/lib/types";
import {
  addSmartleadExportAccount,
  assignMailboxes,
  buyDomains,
  checkDomainsBulk,
  checkDomainsDns,
  createAddonMailboxesLink,
  createSubscriptionPurchaseLink,
  createWalletTopUpLink,
  exportMailboxesToSmartlead,
  enrichZapmailDomains,
  getDomainDnsRecords,
  getExportStatus,
  getWallet,
  isZapmailConfigured,
  listOwnedDomains,
  listSubscriptions,
  listThirdPartyAccounts,
  listWorkspaces,
  listZapmailMailboxes,
  retryFailedMailboxes,
  updateZapmailMailboxes,
  type ZapmailProvider,
  type ZapmailDomainQuote,
  type EnrichedDomain,
  type ZapmailDnsRecord,
  type ZapmailMailbox,
  type ZapmailMailboxSummary,
  type ZapmailOwnedDomain,
  type ZapmailSubscription,
  type ZapmailThirdPartyAccount,
  type ZapmailWallet,
  type ZapmailWorkspace,
} from "@/lib/zapmail";
import { generateDomainVariants, type DomainVariant } from "@/lib/domain-variants";
import { getAdminClient } from "@/lib/supabase/admin";

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

const providerSchema = z.enum(["GOOGLE", "MICROSOFT"]);

const domainNameSchema = z.string().trim().toLowerCase().regex(
  /^[a-z0-9][a-z0-9.-]{2,60}\.[a-z]{2,10}$/i,
);
const domainNamesSchema = z.array(domainNameSchema).min(1).max(20);
const idsSchema = (max: number) => z.array(z.string().trim().min(1).max(200)).min(1).max(max);
const domainIdSchema = z.string().trim().min(1).max(200);

export async function getZapmailStateAction(): Promise<
  ActionResult & {
    connected: boolean;
    wallet?: ZapmailWallet;
    workspaces?: ZapmailWorkspace[];
    ownedDomains?: ZapmailOwnedDomain[];
    mailboxes?: ZapmailMailbox[];
    summary?: ZapmailMailboxSummary;
    subscriptions?: ZapmailSubscription[];
    exportAccounts?: ZapmailThirdPartyAccount[];
  }
> {
  await requireActiveProfile();
  if (!(await isZapmailConfigured())) {
    return { ok: true, connected: false, message: "Zapmail is not configured." };
  }

  const outcomes = await Promise.allSettled([
    getWallet(),
    listWorkspaces(),
    listOwnedDomains(),
    listZapmailMailboxes(),
    listSubscriptions(),
    listThirdPartyAccounts(),
  ] as const);
  const notes: string[] = [];
  const noteFailure = (index: number, label: string) => {
    const outcome = outcomes[index];
    if (outcome.status === "rejected") {
      notes.push(`${label}: ${errorMessage(outcome.reason, "unavailable").slice(0, 120)}`);
    }
  };
  noteFailure(0, "Wallet");
  noteFailure(1, "Workspaces");
  noteFailure(2, "Domains");
  noteFailure(3, "Mailboxes");
  noteFailure(4, "Subscriptions");
  noteFailure(5, "Smartlead accounts");

  const result: Awaited<ReturnType<typeof getZapmailStateAction>> = {
    ok: true,
    connected: true,
    message: notes.length ? `Zapmail connected. Some data could not load: ${notes.join("; ")}` : "Zapmail connected.",
  };
  if (outcomes[0].status === "fulfilled") result.wallet = outcomes[0].value;
  if (outcomes[1].status === "fulfilled") result.workspaces = outcomes[1].value;
  if (outcomes[2].status === "fulfilled") result.ownedDomains = outcomes[2].value;
  if (outcomes[3].status === "fulfilled") {
    result.mailboxes = outcomes[3].value.mailboxes;
    result.summary = outcomes[3].value.summary;
  }
  if (outcomes[4].status === "fulfilled") result.subscriptions = outcomes[4].value;
  if (outcomes[5].status === "fulfilled") result.exportAccounts = outcomes[5].value;
  return result;
}

export async function checkZapmailDomainsAction(
  domainNames: string[],
): Promise<ActionResult & { quotes?: ZapmailDomainQuote[] }> {
  await requireActiveProfile();
  const parsed = domainNamesSchema.safeParse(domainNames);
  if (!parsed.success) return { ok: false, message: "Enter between 1 and 20 valid domain names." };
  try {
    const quotes = await checkDomainsBulk(parsed.data);
    return { ok: true, message: "Domain availability checked.", quotes };
  } catch (error) {
    return { ok: false, message: errorMessage(error, "Could not check domain availability.") };
  }
}

/* Domain suggestions for the buy flow: deterministic prefix/suffix variants
   of the operator's base name, priced and availability-checked through
   Zapmail's bulk search (20 names per call). Read-only. */
export async function suggestZapmailDomainsAction(
  base: string,
): Promise<ActionResult & { suggestions?: (ZapmailDomainQuote & { kind: DomainVariant["kind"] })[] }> {
  await requireActiveProfile();
  const parsedBase = z.string().trim().min(2).max(80).safeParse(base);
  if (!parsedBase.success) return { ok: false, message: "Enter a base name between 2 and 80 characters." };
  const variants = generateDomainVariants(parsedBase.data);
  if (variants.length === 0) {
    return { ok: false, message: "Could not derive a usable brand name from that input. Try just the name, like acmeindustries." };
  }
  try {
    const kinds = new Map(variants.map((variant) => [variant.domainName, variant.kind]));
    const quotes: ZapmailDomainQuote[] = [];
    for (let index = 0; index < variants.length; index += 20) {
      quotes.push(...await checkDomainsBulk(variants.slice(index, index + 20).map((variant) => variant.domainName)));
    }
    const order = new Map(variants.map((variant, index) => [variant.domainName, index]));
    const suggestions = quotes
      .map((quote) => ({ ...quote, kind: kinds.get(quote.domainName.toLowerCase()) ?? ("prefix" as const) }))
      .sort((a, b) =>
        Number(b.available) - Number(a.available) ||
        (order.get(a.domainName.toLowerCase()) ?? 99) - (order.get(b.domainName.toLowerCase()) ?? 99));
    return { ok: true, message: "Suggestions ready.", suggestions };
  } catch (error) {
    return { ok: false, message: errorMessage(error, "Could not check domain availability.") };
  }
}

const buyDomainsSchema = z.object({
  domains: z.array(z.object({ domainName: domainNameSchema, years: z.number().int().min(1).max(3) }).strict())
    .min(1).max(10)
    .refine((domains) => new Set(domains.map((domain) => domain.domainName)).size === domains.length),
  expectedTotal: z.number().finite().nonnegative(),
  useWallet: z.boolean(),
  provider: providerSchema.optional(),
}).strict();

export async function buyZapmailDomainsAction(input: {
  domains: { domainName: string; years: number }[];
  expectedTotal: number;
  useWallet: boolean;
  provider?: ZapmailProvider;
}): Promise<ActionResult & { paymentLink?: string | null }> {
  await requireActiveProfile();
  const parsed = buyDomainsSchema.safeParse(input);
  if (!parsed.success) return { ok: false, message: "Invalid domain purchase request." };
  try {
    // Idempotency guard: a previous attempt that timed out on OUR side may
    // still have completed at Zapmail. Never re-buy a domain already owned.
    const owned = await listOwnedDomains();
    const ownedNames = new Set(owned.map((domain) => domain.domain.toLowerCase()));
    const alreadyOwned = parsed.data.domains.filter((domain) => ownedNames.has(domain.domainName));
    if (alreadyOwned.length > 0) {
      return {
        ok: false,
        message: `Already purchased in Zapmail: ${alreadyOwned
          .map((domain) => domain.domainName)
          .join(", ")}. Remove ${alreadyOwned.length === 1 ? "it" : "them"} from the basket. The earlier purchase went through.`,
      };
    }
    const quotes = await checkDomainsBulk(parsed.data.domains.map((domain) => domain.domainName));
    const quoteMap = new Map(quotes.map((quote) => [quote.domainName.toLowerCase(), quote]));
    let currentTotal = 0;
    for (const domain of parsed.data.domains) {
      const quote = quoteMap.get(domain.domainName);
      const price = quote?.price == null ? Number.NaN : Number(quote.price);
      if (!quote?.available || !Number.isFinite(price)) {
        return { ok: false, message: "A domain is no longer available or its current price is unavailable. Refresh prices before purchasing." };
      }
      currentTotal += price * domain.years;
    }
    if (Math.abs(currentTotal - parsed.data.expectedTotal) > 0.005) {
      return { ok: false, message: "Domain prices changed. Review the current total before purchasing." };
    }
    if (parsed.data.useWallet) {
      const wallet = await getWallet();
      if (wallet.balance + 0.005 < currentTotal) {
        return { ok: false, message: "Your Zapmail wallet balance is too low. Top up first." };
      }
    }
    const purchase = await buyDomains(parsed.data.domains, parsed.data.useWallet, false, parsed.data.provider);
    return { ok: true, message: purchase.paymentLink ? "Continue to payment to complete the purchase." : "Domain purchase submitted.", paymentLink: purchase.paymentLink };
  } catch (error) {
    return { ok: false, message: errorMessage(error, "Could not purchase domains.") };
  }
}

export async function getZapmailOwnedDomainsAction(): Promise<ActionResult & { ownedDomains?: ZapmailOwnedDomain[] }> {
  await requireActiveProfile();
  try {
    const ownedDomains = await listOwnedDomains();
    return { ok: true, message: "Owned domains loaded.", ownedDomains };
  } catch (error) {
    return { ok: false, message: errorMessage(error, "Could not load owned domains.") };
  }
}

export async function getZapmailDomainsOverviewAction(): Promise<
  ActionResult & {
    connected: boolean;
    domains: EnrichedDomain[];
    checkedAt: string | null;
  }
> {
  await requireActiveProfile();

  if (!(await isZapmailConfigured())) {
    return {
      ok: true,
      connected: false,
      message: "Zapmail is not configured.",
      domains: [],
      checkedAt: null,
    };
  }

  try {
    const domains = await listOwnedDomains();
    const now = Date.now();

    if (domains.length === 0) {
      return {
        ok: true,
        connected: true,
        message: "No Zapmail domains found.",
        domains: [],
        checkedAt: new Date(now).toISOString(),
      };
    }

    try {
      const checks = [];
      const domainIds = domains.map((domain) => domain.id);
      for (let index = 0; index < domainIds.length; index += 50) {
        checks.push(...await checkDomainsDns(domainIds.slice(index, index + 50)));
      }
      const checkedAt = new Date().toISOString();

      return {
        ok: true,
        connected: true,
        message: "Zapmail domains loaded.",
        domains: enrichZapmailDomains(domains, checks, now),
        checkedAt,
      };
    } catch (error) {
      return {
        ok: true,
        connected: true,
        message: `Domains loaded. DNS health could not load: ${errorMessage(
          error,
          "unavailable",
        ).slice(0, 120)}`,
        domains: enrichZapmailDomains(domains, null, now),
        checkedAt: null,
      };
    }
  } catch (error) {
    return {
      ok: false,
      connected: true,
      message: errorMessage(error, "Could not load Zapmail domains."),
      domains: [],
      checkedAt: null,
    };
  }
}

export async function getDomainDnsRecordsAction(
  domainId: string,
): Promise<ActionResult & { records: ZapmailDnsRecord[] }> {
  await requireActiveProfile();
  const parsed = domainIdSchema.safeParse(domainId);
  if (!parsed.success) {
    return { ok: false, message: "Invalid Zapmail domain ID.", records: [] };
  }

  try {
    const records = await getDomainDnsRecords(parsed.data);
    return { ok: true, message: "DNS records loaded.", records };
  } catch (error) {
    return {
      ok: false,
      message: errorMessage(error, "Could not load DNS records."),
      records: [],
    };
  }
}

export async function getZapmailMailboxesAction(): Promise<ActionResult & { mailboxes?: ZapmailMailbox[]; summary?: ZapmailMailboxSummary }> {
  await requireActiveProfile();
  try {
    const result = await listZapmailMailboxes();
    return { ok: true, message: "Zapmail mailboxes loaded.", ...result };
  } catch (error) {
    return { ok: false, message: errorMessage(error, "Could not load Zapmail mailboxes.") };
  }
}

export async function checkZapmailDnsAction(domainIds: string[]) {
  await requireActiveProfile();
  const parsed = idsSchema(50).safeParse(domainIds);
  if (!parsed.success) return { ok: false as const, message: "Select between 1 and 50 valid domains." };
  try {
    return { ok: true as const, message: "DNS checks loaded.", checks: await checkDomainsDns(parsed.data) };
  } catch (error) {
    return { ok: false as const, message: errorMessage(error, "Could not check domain DNS.") };
  }
}

const usernameSchema = z.string().trim().regex(/^[a-z0-9](?:[a-z0-9._-]{0,30}[a-z0-9])?$/i)
  .refine((value) => !/[._-]{2}/.test(value));
const assignSchema = z.array(z.object({
  domainId: z.string().trim().min(1).max(200),
  domainName: domainNameSchema,
  boxes: z.array(z.object({
    firstName: z.string().trim().min(1).max(40),
    lastName: z.string().trim().min(1).max(40),
    username: usernameSchema,
  }).strict()).min(1).max(5),
}).strict()).min(1).max(10);

function mailboxAssignmentError(error: unknown): string {
  const message = errorMessage(error, "Could not assign mailboxes.");
  if (/quota|available mailbox|insufficient/i.test(message)) return `Mailbox quota unavailable: ${message}`;
  if (/24\s*(?:hour|hr)|one day/i.test(message)) return `Zapmail's 24-hour mailbox rule applies: ${message}`;
  return message;
}

export async function assignZapmailMailboxesAction(
  entries: z.input<typeof assignSchema>,
  provider?: ZapmailProvider,
): Promise<ActionResult> {
  await requireActiveProfile();
  const parsed = assignSchema.safeParse(entries);
  const parsedProvider = providerSchema.optional().safeParse(provider);
  if (!parsed.success || !parsedProvider.success) return { ok: false, message: "Invalid mailbox assignment details." };
  try {
    await assignMailboxes(parsed.data, parsedProvider.data);
    return { ok: true, message: "Mailbox assignment scheduled." };
  } catch (error) {
    return { ok: false, message: mailboxAssignmentError(error) };
  }
}

const AVATAR_BUCKET = "zapmail-avatars";
const AVATAR_TYPES: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" };

/* Stores a profile image in a public bucket so Zapmail can fetch it once
   (their update endpoint takes a URL and rehosts on cdn.zapmail.ai). */
export async function uploadZapmailAvatarAction(formData: FormData): Promise<ActionResult & { url?: string }> {
  await requireActiveProfile();
  const file = formData.get("file");
  if (!(file instanceof File)) return { ok: false, message: "Choose an image file." };
  const extension = AVATAR_TYPES[file.type];
  if (!extension) return { ok: false, message: "Use a PNG, JPEG, or WebP image." };
  if (file.size > 2 * 1024 * 1024) return { ok: false, message: "Keep the image under 2 MB." };
  try {
    const admin = getAdminClient();
    // Idempotent bucket setup; "already exists" is the steady state.
    const created = await admin.storage.createBucket(AVATAR_BUCKET, { public: true, fileSizeLimit: "2MB" });
    if (created.error && !/already exists|duplicate/i.test(created.error.message)) {
      return { ok: false, message: `Avatar storage unavailable: ${created.error.message}` };
    }
    const path = `${crypto.randomUUID()}.${extension}`;
    const uploaded = await admin.storage.from(AVATAR_BUCKET).upload(path, file, { contentType: file.type });
    if (uploaded.error) return { ok: false, message: `Could not store the image: ${uploaded.error.message}` };
    const { data } = admin.storage.from(AVATAR_BUCKET).getPublicUrl(path);
    if (!data.publicUrl) return { ok: false, message: "Could not resolve the image URL." };
    return { ok: true, message: "Image uploaded.", url: data.publicUrl };
  } catch (error) {
    return { ok: false, message: errorMessage(error, "Could not upload the image.") };
  }
}

const mailboxUpdateSchema = z.array(z.object({
  mailboxId: z.string().trim().min(1).max(200),
  firstName: z.string().trim().min(1).max(40).optional(),
  lastName: z.string().trim().min(1).max(40).optional(),
  username: usernameSchema.optional(),
  profilePicture: z.string().trim().url().max(500).optional(),
  removeProfilePicture: z.boolean().optional(),
}).strict()).min(1).max(100);

export async function updateZapmailMailboxesAction(
  updates: z.input<typeof mailboxUpdateSchema>,
): Promise<ActionResult & { results?: { mailboxId: string; profileUrl: string | null; failures: string[] }[] }> {
  await requireActiveProfile();
  const parsed = mailboxUpdateSchema.safeParse(updates);
  if (!parsed.success) return { ok: false, message: "Invalid mailbox update details." };
  // Only images we host (or Zapmail already hosts) may be pushed to their CDN.
  const supabaseHost = (() => {
    try { return new URL(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").host; } catch { return null; }
  })();
  for (const update of parsed.data) {
    if (!update.profilePicture) continue;
    const host = (() => { try { return new URL(update.profilePicture).host; } catch { return null; } })();
    const allowed = host !== null && (host === supabaseHost || host.endsWith(".zapmail.ai") || host === "cdn.zapmail.ai");
    if (!allowed) return { ok: false, message: "Profile pictures must be uploaded through this app first." };
  }
  try {
    const results = await updateZapmailMailboxes(parsed.data);
    const failed = results.filter((result) => result.failures.length > 0);
    return {
      ok: failed.length === 0,
      message: failed.length === 0
        ? "Mailbox updates are in progress at Zapmail."
        : `${failed.length} ${failed.length === 1 ? "mailbox" : "mailboxes"} reported problems: ${failed
            .map((result) => result.failures.join(", "))
            .join("; ")
            .slice(0, 250)}`,
      results,
    };
  } catch (error) {
    return { ok: false, message: errorMessage(error, "Could not update mailboxes.") };
  }
}

export async function retryZapmailMailboxesAction(domainIds: string[]): Promise<ActionResult> {
  await requireActiveProfile();
  const parsed = idsSchema(50).safeParse(domainIds);
  if (!parsed.success) return { ok: false, message: "Select between 1 and 50 valid domains." };
  try {
    await retryFailedMailboxes(parsed.data);
    return { ok: true, message: "Failed mailbox assignments queued for retry." };
  } catch (error) {
    return { ok: false, message: mailboxAssignmentError(error) };
  }
}

export async function createZapmailTopUpLinkAction(amount: number): Promise<ActionResult & { paymentLink?: string | null }> {
  await requireActiveProfile();
  const parsed = z.number().finite().min(10).max(5000).safeParse(amount);
  if (!parsed.success) return { ok: false, message: "Top-up amount must be between 10 and 5,000." };
  try { return { ok: true, message: "Top-up link created.", ...(await createWalletTopUpLink(parsed.data)) }; }
  catch (error) { return { ok: false, message: errorMessage(error, "Could not create a top-up link.") }; }
}

export async function createZapmailAddonLinkAction(quantity: number): Promise<ActionResult & { paymentLink?: string | null }> {
  await requireActiveProfile();
  const parsed = z.number().int().min(1).max(100).safeParse(quantity);
  if (!parsed.success) return { ok: false, message: "Mailbox quantity must be between 1 and 100." };
  try { return { ok: true, message: "Add-on link created.", ...(await createAddonMailboxesLink(parsed.data)) }; }
  catch (error) { return { ok: false, message: errorMessage(error, "Could not create an add-on link.") }; }
}

export async function createZapmailSubscriptionLinkAction(
  planName: "Starter" | "Growth" | "Pro",
  billingCycle: string,
): Promise<ActionResult & { paymentLink?: string | null }> {
  await requireActiveProfile();
  const parsed = z.object({ planName: z.enum(["Starter", "Growth", "Pro"]), billingCycle: z.string().trim().min(1).max(20) }).strict()
    .safeParse({ planName, billingCycle });
  if (!parsed.success) return { ok: false, message: "Invalid subscription selection." };
  try { return { ok: true, message: "Subscription link created.", ...(await createSubscriptionPurchaseLink(parsed.data.planName, parsed.data.billingCycle)) }; }
  catch (error) { return { ok: false, message: errorMessage(error, "Could not create a subscription link.") }; }
}

export async function getZapmailExportAccountsAction(): Promise<ActionResult & { exportAccounts?: ZapmailThirdPartyAccount[] }> {
  await requireActiveProfile();
  try { return { ok: true, message: "Smartlead export accounts loaded.", exportAccounts: await listThirdPartyAccounts() }; }
  catch (error) { return { ok: false, message: errorMessage(error, "Could not load Smartlead export accounts.") }; }
}

const exportAccountSchema = z.object({ email: z.string().trim().email().max(320), password: z.string().min(1).max(200) }).strict();

export async function addZapmailExportAccountAction(input: { email: string; password: string }): Promise<ActionResult> {
  await requireActiveProfile();
  const parsed = exportAccountSchema.safeParse(input);
  if (!parsed.success) return { ok: false, message: "Enter valid Smartlead login credentials." };
  try {
    // Pass-through only: the password is never stored or logged by this app.
    await addSmartleadExportAccount(parsed.data.email, parsed.data.password);
    return { ok: true, message: "Smartlead export account added." };
  } catch (error) {
    return { ok: false, message: errorMessage(error, "Could not add the Smartlead export account.") };
  }
}

const exportSchema = z.object({
  ids: idsSchema(100),
  thirdPartyAccountId: z.string().trim().min(1).max(200).optional(),
}).strict();

export async function exportZapmailMailboxesAction(input: { ids: string[]; thirdPartyAccountId?: string }) {
  await requireActiveProfile();
  const parsed = exportSchema.safeParse(input);
  if (!parsed.success) return { ok: false as const, message: "Select between 1 and 100 valid mailboxes." };
  try {
    return { ok: true as const, message: "Smartlead export queued.", ...(await exportMailboxesToSmartlead(parsed.data.ids, parsed.data.thirdPartyAccountId)) };
  } catch (error) {
    return { ok: false as const, message: errorMessage(error, "Could not export mailboxes to Smartlead.") };
  }
}

export async function getZapmailExportStatusAction(exportId: number) {
  await requireActiveProfile();
  const parsed = z.number().int().min(0).safeParse(exportId);
  if (!parsed.success) return { ok: false as const, message: "Invalid export ID." };
  try { return { ok: true as const, message: "Export status loaded.", export: await getExportStatus(parsed.data) }; }
  catch (error) { return { ok: false as const, message: errorMessage(error, "Could not load export status.") }; }
}

/* ── Provisioning pipeline (durable; advanced by the cron watcher) ────────── */

const provisionItemsSchema = z.array(z.object({
  email: z.string().trim().toLowerCase().email().max(200),
  domainName: domainNameSchema,
})).min(1).max(100);

export async function createZapmailProvisionAction(input: {
  provider: unknown;
  imageUrl: unknown;
  exportAccountId: unknown;
  notify: unknown;
  warmupDays: unknown;
  items: unknown;
}): Promise<ActionResult & { provisionId?: string }> {
  const profile = await requireActiveProfile();
  const parsed = z.object({
    provider: providerSchema,
    imageUrl: z.string().trim().url().max(500).nullable(),
    exportAccountId: z.string().trim().min(1).max(200).nullable(),
    notify: z.boolean(),
    // The DB check constraint carries the same set; keep the two in lockstep.
    warmupDays: z.union([z.literal(7), z.literal(14), z.literal(21), z.literal(30), z.literal(60), z.literal(90)]),
    items: provisionItemsSchema,
  }).safeParse(input);
  if (!parsed.success) return { ok: false, message: "Invalid provisioning request." };
  try {
    const { createZapmailProvision } = await import("@/lib/zapmail-provisions");
    const provisionId = await createZapmailProvision({ ...parsed.data, createdBy: profile.email });
    return { ok: true, message: "Provisioning batch created.", provisionId };
  } catch (error) {
    return { ok: false, message: errorMessage(error, "Could not create the provisioning batch.") };
  }
}

export async function listZapmailProvisionsAction(): Promise<
  ActionResult & { provisions?: import("@/lib/zapmail-provisions").ZapmailProvision[]; forwardingDefault?: string }
> {
  await requireActiveProfile();
  try {
    const { listProvisionsForReview } = await import("@/lib/zapmail-provisions");
    const { getInboxProvisioningConfig } = await import("@/lib/inbox-provisioning-config");
    const [provisions, config] = await Promise.all([listProvisionsForReview(), getInboxProvisioningConfig()]);
    return { ok: true, message: "Provisions loaded.", provisions, forwardingDefault: config.forwardingDomain };
  } catch (error) {
    return { ok: false, message: errorMessage(error, "Could not load provisioning batches.") };
  }
}

export async function approveZapmailProvisionAction(provisionId: unknown, emails: unknown): Promise<ActionResult> {
  await requireActiveProfile();
  const parsed = z.object({
    provisionId: z.string().uuid(),
    emails: z.array(z.string().trim().toLowerCase().email()).min(1).max(100),
  }).safeParse({ provisionId, emails });
  if (!parsed.success) return { ok: false, message: "Invalid approval request." };
  try {
    const { approveProvisionItems } = await import("@/lib/zapmail-provisions");
    await approveProvisionItems(parsed.data.provisionId, parsed.data.emails);
    return { ok: true, message: "Approved." };
  } catch (error) {
    return { ok: false, message: errorMessage(error, "Could not approve the inboxes.") };
  }
}

export async function dismissZapmailProvisionAction(provisionId: unknown): Promise<ActionResult> {
  await requireActiveProfile();
  const parsed = z.string().uuid().safeParse(provisionId);
  if (!parsed.success) return { ok: false, message: "Invalid batch." };
  try {
    const { dismissProvision } = await import("@/lib/zapmail-provisions");
    await dismissProvision(parsed.data);
    return { ok: true, message: "Batch dismissed." };
  } catch (error) {
    return { ok: false, message: errorMessage(error, "Could not dismiss the batch.") };
  }
}

/** Manual "check now": runs one watcher tick instead of waiting for the cron. */
export async function processZapmailProvisionsNowAction(): Promise<ActionResult & { advanced?: string[] }> {
  await requireActiveProfile();
  try {
    const { processZapmailProvisions } = await import("@/lib/zapmail-provisions");
    const result = await processZapmailProvisions();
    return { ok: true, message: `Checked ${result.watched} open ${result.watched === 1 ? "batch" : "batches"}.`, advanced: result.advanced };
  } catch (error) {
    return { ok: false, message: errorMessage(error, "Could not run the provisioning check.") };
  }
}

export async function setZapmailDomainForwardingAction(domainNames: unknown, forwardTo: unknown): Promise<ActionResult> {
  await requireActiveProfile();
  const parsed = z.object({
    domainNames: domainNamesSchema,
    // Zapmail accepts a bare domain or a full URL as the redirect target.
    forwardTo: z.string().trim().min(4).max(300),
  }).safeParse({ domainNames, forwardTo });
  if (!parsed.success) return { ok: false, message: "Enter a destination domain or URL." };
  try {
    // The client knows domain names; Zapmail's endpoint wants its domain ids.
    const owned = await listOwnedDomains();
    const wanted = new Set(parsed.data.domainNames);
    const ids = owned.filter((domain) => wanted.has(domain.domain.toLowerCase())).map((domain) => domain.id);
    if (ids.length === 0) return { ok: false, message: "Those domains were not found in Zapmail." };
    const { setDomainForwarding } = await import("@/lib/zapmail");
    await setDomainForwarding(ids, parsed.data.forwardTo);
    return { ok: true, message: `Forwarding set for ${ids.length} ${ids.length === 1 ? "domain" : "domains"}.` };
  } catch (error) {
    return { ok: false, message: errorMessage(error, "Could not set domain forwarding.") };
  }
}
