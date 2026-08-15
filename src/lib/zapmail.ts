import "server-only";

import { getSecret } from "@/lib/secrets";
import { getIntegrationSettings } from "@/lib/settings-store";

export type ZapmailDomainQuote = { domainName: string; available: boolean; premium: boolean; price: string | null; renewPrice: string | null };
export type ZapmailOwnedDomainMailbox = {
  id: string;
  username: string;
  domain: string;
  firstName: string;
  lastName: string;
  status: string | null;
  createdAt: string | null;
};
export type ZapmailOwnedDomain = {
  id: string;
  domain: string;
  status: string | null;
  nameServers: string[];
  assignedMailboxesCount: number;
  createdAt: string | null;
  workspaceId: string | null;
  updatedAt: string | null;
  registeredOn: string | null;
  expireOn: string | null;
  autoRenew: boolean;
  forwardTo: string | null;
  forwardToAddedOnReseller: boolean;
  maskForwarding: boolean;
  dmarcEmail: string | null;
  dmarcEmailAddedToReseller: boolean;
  forwardingEmail: string | null;
  forwardingEmailAdded: boolean;
  catchAllEmail: string | null;
  catchAllEmailAdded: boolean;
  expectedNameServers: string[] | null;
  dnsBoxInvalidNameServers: boolean;
  dnsAuthenticationInProgress: boolean;
  dnsShieldEnabled: boolean;
  dnsShieldUpdateInProgress: boolean | null;
  isCloudflareConnected: boolean;
  isWarmedUp: boolean;
  captchaEnabled: boolean;
  unusedDomainNotification: string | boolean | null;
  transferRequired: boolean;
  transferInternally: boolean;
  isAftermarket: boolean;
  tags: string[];
  mailboxes: ZapmailOwnedDomainMailbox[];
};
export type ZapmailDnsCheck = { id: string; domain: string; spf: boolean; dmarc: boolean; dkim: boolean; mx: boolean };
export type ZapmailDomainHealth = {
  checked: boolean;
  spf: boolean | null;
  dkim: boolean | null;
  dmarc: boolean | null;
  mx: boolean | null;
  nameserversOk: boolean;
  authenticationIdle: boolean;
  healthy: boolean | null;
};
export type EnrichedDomain = ZapmailOwnedDomain & {
  health: ZapmailDomainHealth;
  expiringSoon: boolean;
};
export type ZapmailDnsRecord = {
  id: string;
  type: string;
  host: string;
  value: string;
  ttl: number | null;
  priority: number | null;
};
export type ZapmailMailbox = { id: string; email: string; username: string; firstName: string; lastName: string; status: string | null; domain: string; domainId: string | null; isWarmedUp: boolean; profilePicture: string | null };
export type ZapmailMailboxSummary = { purchased: number; assigned: number; active: number; available: number; scheduled: number };
export type ZapmailWallet = { balance: number; autoRechargeEnabled: boolean };
export type ZapmailWorkspace = { id: string; name: string; domainCount: number; mailboxCount: number };
export type ZapmailThirdPartyAccount = { id: string; app: string; email: string };
export type ZapmailSubscription = { id: string | null; planName: string | null; billingCycle: string | null; status: string | null; mailboxCount: number | null };

const DEFAULT_BASE_URL = "https://api.zapmail.ai/api";
const REQUEST_TIMEOUT_MS = 15_000;
// Endpoint docs consistently use x-auth-zapmail, but an intro page showed
// x-api-key. Keep this centralized until a live key can confirm the contract.
export const ZAPMAIL_AUTH_HEADER_NAME = "x-auth-zapmail" as const;
export const ZAPMAIL_FALLBACK_AUTH_HEADER_NAME = "x-api-key" as const;
let workingAuthHeader: string = ZAPMAIL_AUTH_HEADER_NAME;

type JsonObject = Record<string, unknown>;
export type ZapmailProvider = "GOOGLE" | "MICROSOFT";
type RequestOptions = {
  method?: "GET" | "POST" | "PUT";
  params?: Record<string, string>;
  body?: unknown;
  timeoutMs?: number;
  // Purchase flows choose the provider in the UI; when set it overrides the
  // stored default for this request's x-service-provider header.
  provider?: ZapmailProvider;
};

export async function resolveZapmailConfig(): Promise<{
  apiKey: string | null;
  workspaceId: string | null;
  serviceProvider: "GOOGLE" | "MICROSOFT";
}> {
  const [settings, storedApiKey] = await Promise.all([
    getIntegrationSettings(),
    getSecret("zapmail_api_key"),
  ]);
  return {
    apiKey: storedApiKey?.trim() || process.env.ZAPMAIL_API_KEY?.trim() || null,
    workspaceId: settings.zapmailWorkspaceId.trim() || null,
    serviceProvider: settings.zapmailServiceProvider,
  };
}

export async function isZapmailConfigured(): Promise<boolean> {
  return Boolean((await resolveZapmailConfig()).apiKey);
}

function objectOrNull(value: unknown): JsonObject | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : null;
}

function unwrapData(value: unknown): unknown {
  let current = value;
  for (let depth = 0; depth < 3; depth += 1) {
    const object = objectOrNull(current);
    if (!object || !("data" in object) || object.data === undefined) break;
    current = object.data;
  }
  return current;
}

function firstArray(value: unknown, keys: string[]): JsonObject[] {
  if (Array.isArray(value)) return value.filter((item): item is JsonObject => objectOrNull(item) !== null);
  const candidates: unknown[] = [value, unwrapData(value)];
  for (const candidate of candidates) {
    if (Array.isArray(candidate)) return candidate.filter((item): item is JsonObject => objectOrNull(item) !== null);
    const object = objectOrNull(candidate);
    if (!object) continue;
    for (const key of keys) {
      if (Array.isArray(object[key])) {
        return (object[key] as unknown[]).filter((item): item is JsonObject => objectOrNull(item) !== null);
      }
    }
  }
  return [];
}

function stringOrNull(value: unknown): string | null {
  return value === null || value === undefined || value === "" ? null : String(value);
}

function numberOr(value: unknown, fallback = 0): number {
  const result = Number(value);
  return Number.isFinite(result) ? result : fallback;
}

function numberOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const result = Number(value);
  return Number.isFinite(result) ? result : null;
}

function booleanOr(value: unknown, fallback = false): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    if (value.toLowerCase() === "true") return true;
    if (value.toLowerCase() === "false") return false;
  }
  if (typeof value === "number") return value !== 0;
  return fallback;
}

function booleanOrNull(value: unknown): boolean | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    if (value.toLowerCase() === "true") return true;
    if (value.toLowerCase() === "false") return false;
  }
  if (typeof value === "number") return value !== 0;
  return null;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (typeof item !== "string" && typeof item !== "number") return [];
    const normalized = String(item).trim();
    return normalized ? [normalized] : [];
  });
}

function nullableStringArray(value: unknown): string[] | null {
  return value === null || value === undefined ? null : stringArray(value);
}

function tagArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const object = objectOrNull(item);
    const candidate = object ? object.name ?? object.label ?? object.id : item;
    if (typeof candidate !== "string" && typeof candidate !== "number") return [];
    const normalized = String(candidate).trim();
    return normalized ? [normalized] : [];
  });
}

function stringOrBooleanOrNull(value: unknown): string | boolean | null {
  if (typeof value === "boolean") return value;
  if (typeof value === "string" || typeof value === "number") return stringOrNull(value);
  return null;
}

function responseMessage(value: unknown): string | null {
  for (const candidate of [value, unwrapData(value)]) {
    const message = objectOrNull(candidate)?.message;
    if (typeof message === "string" && message.trim()) return message.trim().slice(0, 300);
  }
  return null;
}

function isOkFalse(value: unknown): boolean {
  return [value, unwrapData(value)].some((candidate) => {
    const object = objectOrNull(candidate);
    return object?.ok === false || object?.success === false;
  });
}

function payloadObject(value: unknown): JsonObject {
  return objectOrNull(unwrapData(value)) ?? objectOrNull(value) ?? {};
}

async function fetchWithAuth(
  url: URL,
  options: RequestOptions,
  config: Awaited<ReturnType<typeof resolveZapmailConfig>>,
  authHeader: string,
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? REQUEST_TIMEOUT_MS);
  try {
    const headers: Record<string, string> = { [authHeader]: config.apiKey! };
    if (config.workspaceId) headers["x-workspace-key"] = config.workspaceId;
    const provider = options.provider ?? config.serviceProvider;
    if (provider) headers["x-service-provider"] = provider;
    if (options.body !== undefined) headers["Content-Type"] = "application/json";
    return await fetch(url, {
      method: options.method ?? "GET",
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      cache: "no-store",
      signal: controller.signal,
    });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error("Zapmail request timed out. Retry in a moment.");
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function request(path: string, options: RequestOptions = {}): Promise<unknown> {
  const config = await resolveZapmailConfig();
  if (!config.apiKey) throw new Error("Zapmail API key is not configured.");
  const baseUrl = (process.env.ZAPMAIL_API_BASE_URL?.trim() || DEFAULT_BASE_URL).replace(/\/$/, "");
  const url = new URL(`${baseUrl}${path}`);
  for (const [key, value] of Object.entries(options.params ?? {})) url.searchParams.set(key, value);

  let response = await fetchWithAuth(url, options, config, workingAuthHeader);
  // Auth-header fallback (docs are inconsistent about the header name) is
  // GET-ONLY: whether Zapmail authenticates before or after executing a
  // mutation is unverified, so a POST/PUT must never be replayed. Reads run
  // first in every flow, which pins workingAuthHeader before any mutation.
  const method = options.method ?? "GET";
  if ((response.status === 401 || response.status === 403) && method === "GET") {
    const alternateHeader = workingAuthHeader === ZAPMAIL_AUTH_HEADER_NAME
      ? ZAPMAIL_FALLBACK_AUTH_HEADER_NAME
      : ZAPMAIL_AUTH_HEADER_NAME;
    response = await fetchWithAuth(url, options, config, alternateHeader);
    if (response.status !== 401 && response.status !== 403) workingAuthHeader = alternateHeader;
  }

  /* Zapmail's rate limit is tight (~20 req/min) and pages fan several reads
     out at once, so a GET that trips 429 waits once and retries instead of
     failing the whole page. Mutations still surface the 429 immediately —
     whether the throttled call executed is unknowable, so never replay it. */
  if (response.status === 429 && method === "GET") {
    const retryAfter = Number(response.headers.get("retry-after"));
    const waitMs = Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter * 1000, 10_000) : 3_000;
    await new Promise((resolve) => setTimeout(resolve, waitMs));
    response = await fetchWithAuth(url, options, config, workingAuthHeader);
  }

  const text = await response.text().catch(() => "");
  let parsed: unknown = null;
  if (text) {
    try { parsed = JSON.parse(text); } catch { parsed = { message: text.slice(0, 300) }; }
  }
  if (response.status === 429) {
    throw new Error("Zapmail rate limit reached. Wait a moment and retry.");
  }
  if (!response.ok || isOkFalse(parsed)) {
    const message = responseMessage(parsed) ?? (text.slice(0, 300) || `HTTP ${response.status}`);
    throw new Error(message.slice(0, 300));
  }
  return parsed;
}

export async function getWallet(): Promise<ZapmailWallet> {
  const object = payloadObject(await request("/v2/wallet/balance"));
  return {
    balance: numberOr(object.walletBalance ?? object.balance),
    autoRechargeEnabled: booleanOr(object.autoRechargeEnabled),
  };
}

export async function createWalletTopUpLink(amount: number): Promise<{ paymentLink: string | null }> {
  const object = payloadObject(await request("/v2/wallet/balance", { method: "POST", body: { amount } }));
  return { paymentLink: stringOrNull(object.paymentLink) };
}

export async function createAddonMailboxesLink(quantity: number): Promise<{ paymentLink: string | null }> {
  const object = payloadObject(await request("/v2/wallet/buy-addon-mailboxes", {
    method: "POST", params: { quantity: String(quantity) },
  }));
  return { paymentLink: stringOrNull(object.paymentLink) };
}

export async function listWorkspaces(): Promise<ZapmailWorkspace[]> {
  const raw = await request("/v2/workspaces", { params: { page: "1", limit: "100" } });
  // Live-verified shape: the caller's active workspace arrives as
  // data.currentWorkspace while data.workspaces[] holds only OTHER
  // workspaces (empty for a single-workspace account). Counts come split
  // per provider as strings (domainCountGoogle/"10", ...Microsoft/"0").
  const container = payloadObject(raw);
  const rows = firstArray(raw, ["workspaces", "items", "results"]);
  const current = objectOrNull(container.currentWorkspace);
  if (current && !rows.some((row) => String(row.id ?? "") === String(current.id ?? ""))) {
    rows.unshift(current);
  }
  return rows.map((workspace) => ({
    id: String(workspace.id ?? ""),
    name: String(workspace.name ?? ""),
    domainCount: numberOr(workspace.domainCount ?? workspace.domain_count,
      numberOr(workspace.domainCountGoogle) + numberOr(workspace.domainCountMicrosoft)),
    mailboxCount: numberOr(workspace.mailboxCount ?? workspace.mailbox_count,
      numberOr(workspace.totalMailboxesPurchasedGoogle) + numberOr(workspace.totalMailboxesPurchasedMicrosoft)),
  })).filter((workspace) => workspace.id);
}

export async function checkDomainsBulk(names: string[]): Promise<ZapmailDomainQuote[]> {
  const raw = await request("/v2/domains/available-bulk", { method: "POST", body: { domainNames: names } });
  return firstArray(raw, ["domains", "items", "results"]).map((domain) => {
    const status = String(domain.status ?? "").toLowerCase();
    return {
      domainName: String(domain.domainName ?? domain.domain ?? ""),
      available: domain.available === undefined ? status === "available" : booleanOr(domain.available),
      premium: booleanOr(domain.isPremiumDomain ?? domain.premium),
      price: stringOrNull(domain.domainPrice ?? domain.price),
      renewPrice: stringOrNull(domain.renewPrice ?? domain.renew_price),
    };
  }).filter((domain) => domain.domainName);
}

export async function buyDomains(
  domains: { domainName: string; years: number }[],
  useWallet: boolean,
  enableDnsShield = false,
  provider?: ZapmailProvider,
): Promise<{ paymentLink: string | null }> {
  // Domain registration can legitimately take a while — a short timeout here
  // would abort our side while the charge completes at Zapmail.
  const object = payloadObject(await request("/v2/domains/buy", {
    method: "POST", body: { domains, useWallet, enableDnsShield }, timeoutMs: 60_000, provider,
  }));
  return { paymentLink: stringOrNull(object.paymentLink) };
}

export async function listOwnedDomains(): Promise<ZapmailOwnedDomain[]> {
  const domains: ZapmailOwnedDomain[] = [];
  const limit = 100;

  for (let page = 1; page <= 20; page += 1) {
    const raw = await request("/v2/domains", {
      params: { contains: "", page: String(page), limit: String(limit) },
    });
    const rows = firstArray(raw, ["domains", "items", "results"]);

    domains.push(...rows.map((domain): ZapmailOwnedDomain => {
      const domainName = stringOrNull(domain.domain ?? domain.domainName) ?? "";
      const mailboxes = firstArray(domain.mailboxes, [])
        .map((mailbox): ZapmailOwnedDomainMailbox => ({
          id: stringOrNull(mailbox.id) ?? "",
          username: stringOrNull(mailbox.username ?? mailbox.mailboxUsername) ?? "",
          domain: stringOrNull(mailbox.domain) ?? domainName,
          firstName: stringOrNull(mailbox.firstName ?? mailbox.first_name) ?? "",
          lastName: stringOrNull(mailbox.lastName ?? mailbox.last_name) ?? "",
          status: stringOrNull(mailbox.status),
          createdAt: stringOrNull(mailbox.createdAt ?? mailbox.created_at),
        }))
        .filter((mailbox) => mailbox.id && mailbox.username);

      return {
        id: stringOrNull(domain.id) ?? "",
        domain: domainName,
        status: stringOrNull(domain.status),
        nameServers: stringArray(domain.nameServers ?? domain.name_servers),
        assignedMailboxesCount: numberOr(
          domain.assignedMailboxesCount ?? domain.assigned_mailboxes_count,
        ),
        createdAt: stringOrNull(domain.createdAt ?? domain.created_at),
        workspaceId: stringOrNull(domain.workspaceId ?? domain.workspace_id),
        updatedAt: stringOrNull(domain.updatedAt ?? domain.updated_at),
        registeredOn: stringOrNull(domain.registeredOn ?? domain.registered_on),
        expireOn: stringOrNull(domain.expireOn ?? domain.expire_on),
        autoRenew: booleanOr(domain.autoRenew ?? domain.auto_renew),
        forwardTo: stringOrNull(domain.forwardTo ?? domain.forward_to),
        forwardToAddedOnReseller: booleanOr(
          domain.forwardToAddedOnReseller ?? domain.forward_to_added_on_reseller,
        ),
        maskForwarding: booleanOr(domain.maskForwarding ?? domain.mask_forwarding),
        dmarcEmail: stringOrNull(domain.dmarcEmail ?? domain.dmarc_email),
        dmarcEmailAddedToReseller: booleanOr(
          domain.dmarcEmailAddedToReseller ?? domain.dmarc_email_added_to_reseller,
        ),
        forwardingEmail: stringOrNull(domain.forwardingEmail ?? domain.forwarding_email),
        forwardingEmailAdded: booleanOr(
          domain.forwardingEmailAdded ?? domain.forwarding_email_added,
        ),
        catchAllEmail: stringOrNull(domain.catchAllEmail ?? domain.catch_all_email),
        catchAllEmailAdded: booleanOr(domain.catchAllEmailAdded ?? domain.catch_all_email_added),
        expectedNameServers: nullableStringArray(
          domain.expectedNameServers ?? domain.expected_name_servers,
        ),
        dnsBoxInvalidNameServers: booleanOr(
          domain.dnsBoxInvalidNameServers ?? domain.dns_box_invalid_name_servers,
        ),
        dnsAuthenticationInProgress: booleanOr(
          domain.dnsAuthenticationInProgress ?? domain.dns_authentication_in_progress,
        ),
        dnsShieldEnabled: booleanOr(domain.dnsShieldEnabled ?? domain.dns_shield_enabled),
        dnsShieldUpdateInProgress: booleanOrNull(
          domain.dnsShieldUpdateInProgress ?? domain.dns_shield_update_in_progress,
        ),
        isCloudflareConnected: booleanOr(
          domain.isCloudflareConnected ?? domain.is_cloudflare_connected,
        ),
        isWarmedUp: booleanOr(domain.isWarmedUp ?? domain.is_warmed_up),
        captchaEnabled: booleanOr(domain.captchaEnabled ?? domain.captcha_enabled),
        unusedDomainNotification: stringOrBooleanOrNull(
          domain.unusedDomainNotification ?? domain.unused_domain_notification,
        ),
        transferRequired: booleanOr(domain.transferRequired ?? domain.transfer_required),
        transferInternally: booleanOr(domain.transferInternally ?? domain.transfer_internally),
        isAftermarket: booleanOr(
          domain.isaftermarket ?? domain.isAftermarket ?? domain.is_aftermarket,
        ),
        tags: tagArray(domain.tags),
        mailboxes,
      };
    }).filter((domain) => domain.id && domain.domain));

    if (rows.length < limit) break;
  }

  return domains;
}

export async function getDomainDnsRecords(domainId: string): Promise<ZapmailDnsRecord[]> {
  const raw = await request("/v2/dns/", { params: { id: domainId } });
  const data = unwrapData(raw);
  const dataObject = objectOrNull(data);
  const records = Array.isArray(dataObject?.domainDnsRecords)
    ? firstArray(dataObject.domainDnsRecords, [])
    : firstArray(data, ["records"]);

  return records.map((record): ZapmailDnsRecord => ({
    id: stringOrNull(record.id ?? record.dnsRecordId) ?? "",
    type: (stringOrNull(record.type ?? record.recordType) ?? "").trim().toUpperCase(),
    host: stringOrNull(record.name ?? record.host) ?? "",
    value: stringOrNull(record.content ?? record.value) ?? "",
    ttl: numberOrNull(record.ttl),
    priority: numberOrNull(record.priority),
  })).filter((record) => record.id && record.type && record.host);
}

export async function checkDomainsDns(domainIds: string[]): Promise<ZapmailDnsCheck[]> {
  const raw = await request("/v2/domains/dns/check", { method: "POST", body: { domainIds } });
  return firstArray(raw, ["domains", "checks", "items", "results"]).map((domain) => ({
    id: String(domain.id ?? domain.domainId ?? ""),
    domain: String(domain.domain ?? domain.domainName ?? ""),
    spf: booleanOr(domain.spfRecord ?? domain.spf),
    dmarc: booleanOr(domain.dmarcRecords ?? domain.dmarc),
    dkim: booleanOr(domain.dkimRecords ?? domain.dkim),
    mx: booleanOr(domain.mxRecords ?? domain.mx),
  })).filter((domain) => domain.id);
}

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1_000;

export function enrichZapmailDomains(
  domains: ZapmailOwnedDomain[],
  checks: ZapmailDnsCheck[] | null,
  now: number,
): EnrichedDomain[] {
  const checksById = new Map((checks ?? []).map((check) => [check.id, check]));

  return domains.map((domain) => {
    const check = checksById.get(domain.id) ?? null;
    const nameserversOk = !domain.dnsBoxInvalidNameServers;
    const authenticationIdle = !domain.dnsAuthenticationInProgress;
    const healthy = check === null
      ? null
      : domain.status?.toUpperCase() === "ACTIVE"
        && check.spf
        && check.dkim
        && check.dmarc
        && check.mx
        && nameserversOk
        && authenticationIdle;
    const expiryTime = domain.expireOn === null ? Number.NaN : Date.parse(domain.expireOn);
    const expiringSoon = !domain.autoRenew
      && Number.isFinite(expiryTime)
      && expiryTime >= now
      && expiryTime <= now + THIRTY_DAYS_MS;

    return {
      ...domain,
      health: {
        checked: check !== null,
        spf: check?.spf ?? null,
        dkim: check?.dkim ?? null,
        dmarc: check?.dmarc ?? null,
        mx: check?.mx ?? null,
        nameserversOk,
        authenticationIdle,
        healthy,
      },
      expiringSoon,
    };
  });
}

export async function assignMailboxes(entries: {
  domainId: string;
  domainName: string;
  boxes: { firstName: string; lastName: string; username: string }[];
}[], provider?: ZapmailProvider): Promise<void> {
  const body: Record<string, { firstName: string; lastName: string; mailboxUsername: string; domainName: string }[]> = {};
  for (const entry of entries) {
    body[entry.domainId] = entry.boxes.map((box) => ({
      firstName: box.firstName,
      lastName: box.lastName,
      mailboxUsername: box.username,
      domainName: entry.domainName,
    }));
  }
  await request("/v2/mailboxes", { method: "POST", body, provider });
}

export type ZapmailMailboxUpdate = {
  mailboxId: string;
  firstName?: string;
  lastName?: string;
  username?: string;
  // A publicly fetchable image URL; Zapmail fetches it once and rehosts on
  // its own CDN (docs: PUT /v2/mailboxes).
  profilePicture?: string;
  removeProfilePicture?: boolean;
};

export async function updateZapmailMailboxes(
  updates: ZapmailMailboxUpdate[],
): Promise<{ mailboxId: string; profileUrl: string | null; failures: string[] }[]> {
  /* PUT /v2/mailboxes (same mailboxData body and response as the old
     /v1/mailbox/update, which Zapmail retired silently — it 500s on every
     call since 2026-07-17 instead of redirecting; live-verified the v2 path
     applies pictures on 2026-08-12). */
  const raw = await request("/v2/mailboxes", {
    method: "PUT",
    body: { mailboxData: updates },
    timeoutMs: 60_000,
  });
  return firstArray(raw, ["data", "items", "results"]).map((row) => ({
    mailboxId: String(row.mailboxId ?? row.id ?? ""),
    profileUrl: stringOrNull(row.profileUrl ?? row.profilePicture),
    failures: Array.isArray(row.failureDetails) ? row.failureDetails.map(String) : [],
  })).filter((row) => row.mailboxId);
}

export async function retryFailedMailboxes(domainIds: string[]): Promise<void> {
  await request("/v2/mailboxes/retry-failed", { method: "PUT", body: { domainIds } });
}

/** Point domain forwarding (the website redirect for cold-email domains) at a
 *  destination URL/domain. Docs: POST /v2/domains/forwarding with domainIds +
 *  forwardTo. The current value reads back as `forwardTo` on GET /v2/domains. */
export async function setDomainForwarding(domainIds: string[], forwardTo: string): Promise<void> {
  if (domainIds.length === 0) return;
  await request("/v2/domains/forwarding", {
    method: "POST",
    body: { domainIds, forwardTo, contains: "" },
  });
}

function mailboxListAndContainer(raw: unknown): { rows: JsonObject[]; container: JsonObject; domainPageCount: number } {
  const unwrapped = unwrapData(raw);
  const container = objectOrNull(unwrapped) ?? objectOrNull(raw) ?? {};
  // Live-verified shape: mailboxes arrive NESTED per domain
  // (data.domains[].mailboxes[]), and the list paginates by DOMAIN. A flat
  // mailboxes array is kept as a fallback for older shapes.
  const domainRows = Array.isArray(container.domains)
    ? (container.domains as unknown[]).filter((item): item is JsonObject => objectOrNull(item) !== null)
    : [];
  if (domainRows.length > 0) {
    const rows: JsonObject[] = [];
    for (const domainRow of domainRows) {
      const boxes = Array.isArray(domainRow.mailboxes) ? domainRow.mailboxes : [];
      for (const box of boxes) {
        const object = objectOrNull(box);
        if (!object) continue;
        rows.push({
          ...object,
          domain: object.domain ?? domainRow.domain,
          domainId: object.domainId ?? domainRow.id,
        });
      }
    }
    return { rows, container, domainPageCount: domainRows.length };
  }
  const flat = firstArray(raw, ["mailboxes", "accounts", "items", "results"]);
  return { rows: flat, container, domainPageCount: flat.length };
}

function normalizeMailbox(mailbox: JsonObject): ZapmailMailbox {
  const nestedDomain = objectOrNull(mailbox.domainDetails ?? mailbox.domain);
  const email = String(mailbox.email ?? mailbox.mailboxEmail ?? mailbox.emailAddress ?? "");
  const domain = typeof mailbox.domain === "string"
    ? mailbox.domain
    : String(mailbox.domainName ?? nestedDomain?.domain ?? nestedDomain?.domainName ?? email.split("@")[1] ?? "");
  const username = String(mailbox.username ?? mailbox.mailboxUsername ?? email.split("@")[0] ?? "");
  return {
    id: String(mailbox.id ?? mailbox.mailboxId ?? ""),
    email,
    username,
    firstName: String(mailbox.firstName ?? mailbox.first_name ?? ""),
    lastName: String(mailbox.lastName ?? mailbox.last_name ?? ""),
    status: stringOrNull(mailbox.status),
    domain,
    domainId: stringOrNull(mailbox.domainId ?? mailbox.domain_id ?? nestedDomain?.id),
    isWarmedUp: booleanOr(mailbox.isWarmedUp ?? mailbox.is_warmed_up ?? mailbox.warmedUp),
    profilePicture: stringOrNull(mailbox.profilePicture ?? mailbox.profile_picture),
  };
}

function normalizeSummary(container: JsonObject): ZapmailMailboxSummary {
  const aggregates = objectOrNull(container.aggregates ?? container.summary) ?? container;
  return {
    purchased: numberOr(aggregates.purchasedMailboxes ?? aggregates.purchased),
    assigned: numberOr(aggregates.totalAssignedMailboxes ?? aggregates.assigned),
    active: numberOr(aggregates.totalActiveMailboxes ?? aggregates.active),
    available: numberOr(aggregates.availableMailboxes ?? aggregates.available),
    scheduled: numberOr(aggregates.scheduledMailboxes ?? aggregates.scheduled),
  };
}

export async function listZapmailMailboxes(page = 1): Promise<{ mailboxes: ZapmailMailbox[]; summary: ZapmailMailboxSummary }> {
  const mailboxes: ZapmailMailbox[] = [];
  let summary: ZapmailMailboxSummary = { purchased: 0, assigned: 0, active: 0, available: 0, scheduled: 0 };
  const startPage = Number.isInteger(page) && page > 0 ? page : 1;
  for (let offset = 0; offset < 10; offset += 1) {
    const raw = await request("/v2/mailboxes/list", {
      params: { page: String(startPage + offset), limit: "100", contains: "" },
    });
    const normalized = mailboxListAndContainer(raw);
    if (offset === 0) summary = normalizeSummary(normalized.container);
    mailboxes.push(...normalized.rows.map(normalizeMailbox));
    // Pagination counts DOMAINS per page, not mailboxes.
    if (normalized.domainPageCount < 100) break;
  }
  return { mailboxes, summary };
}

export async function listSubscriptions(): Promise<ZapmailSubscription[]> {
  const raw = await request("/v2/subscriptions");
  return firstArray(raw, ["subscriptions", "items", "results"]).map((subscription) => ({
    id: stringOrNull(subscription.id),
    planName: stringOrNull(subscription.planName ?? subscription.plan_name),
    billingCycle: stringOrNull(subscription.billingCycle ?? subscription.billing_cycle),
    status: stringOrNull(subscription.status),
    mailboxCount: subscription.mailboxCount === undefined && subscription.mailbox_count === undefined
      ? null : numberOr(subscription.mailboxCount ?? subscription.mailbox_count),
  }));
}

export async function createSubscriptionPurchaseLink(
  planName: "Starter" | "Growth" | "Pro",
  billingCycle: string,
): Promise<{ paymentLink: string | null }> {
  const object = payloadObject(await request("/v2/subscriptions/purchase", {
    method: "POST", params: { planName, billingCycle },
  }));
  return { paymentLink: stringOrNull(object.paymentLink) };
}

export async function listThirdPartyAccounts(): Promise<ZapmailThirdPartyAccount[]> {
  // Live-verified 2026-07-16: the endpoint 400s without the `app` query param,
  // and rows carry the platform under `appName` (not `app`).
  const raw = await request("/v2/exports/accounts/third-party", { params: { app: "SMARTLEAD" } });
  return firstArray(raw, ["accounts", "items", "results"]).map((account) => ({
    id: String(account.id ?? ""), app: String(account.appName ?? account.app ?? ""), email: String(account.email ?? ""),
  })).filter((account) => account.id && account.app.toUpperCase() === "SMARTLEAD");
}

export async function addSmartleadExportAccount(email: string, password: string): Promise<void> {
  await request("/v2/exports/accounts/third-party", {
    method: "POST", body: { email, password, app: "SMARTLEAD" },
  });
}

export async function exportMailboxesToSmartlead(
  ids: string[],
  thirdPartyAccountId?: string,
): Promise<{ exportId: number | null }> {
  const raw = await request("/v2/exports/mailboxes", {
    method: "POST",
    body: {
      apps: ["SMARTLEAD"], ids, excludeIds: [], tagIds: [], status: "", contains: "",
      ...(thirdPartyAccountId ? { thirdPartyAccountId } : {}),
    },
  });
  const object = payloadObject(raw);
  const value = object.exportId ?? object.export_id ?? object.id;
  const exportId = Number(value);
  return { exportId: Number.isInteger(exportId) && exportId >= 0 ? exportId : null };
}

export async function getExportStatus(exportId: number): Promise<{
  exportId: number;
  status: string | null;
  failureReason: string | null;
}> {
  const object = payloadObject(await request("/v2/exports/status", {
    params: { exportId: String(exportId) },
  }));
  return {
    exportId: numberOr(object.export_id ?? object.exportId, exportId),
    status: stringOrNull(object.status),
    failureReason: stringOrNull(object.failure_reason ?? object.failureReason),
  };
}
