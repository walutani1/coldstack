import "server-only";

import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import { getEnv } from "@/lib/env";
import { getAdminClient } from "@/lib/supabase/admin";

export type SecretName =
  | "smartlead_api_key"
  | "zapmail_api_key"
  | "resend_api_key"
  | "smtp_password"
  | "enrichment_anthropic_api_key"
  | "openai_api_key"
  | "apify_api_key"
  | "leadmagic_api_key"
  | "zerobounce_api_key"
  | "apollo_api_key"
  | "firecrawl_api_key"
  | "ai_gateway_api_key";

type EncryptedPayload = {
  v: 1;
  alg: "aes-256-gcm";
  iv: string;
  tag: string;
  data: string;
};

export const SECRET_NAMES: SecretName[] = [
  "smartlead_api_key",
  "zapmail_api_key",
  "resend_api_key",
  "smtp_password",
  "enrichment_anthropic_api_key",
  "openai_api_key",
  "apify_api_key",
  "leadmagic_api_key",
  "zerobounce_api_key",
  "apollo_api_key",
  "firecrawl_api_key",
  "ai_gateway_api_key",
];
const CACHE_TTL_MS = 30_000;
let cachedRows: { expiresAt: number; promise: Promise<Map<SecretName, unknown>> } | null = null;

export function encryptionAvailable(): boolean {
  return Boolean(getEnv().APP_ENCRYPTION_KEY);
}

// scrypt is deliberately slow (~50-100ms, synchronous) and the passphrase is a
// static env var, so derive once per process — never per read: getSecret sits
// on the Smartlead request hot path.
let derivedKey: { passphrase: string; key: Buffer } | null = null;

function encryptionKey(): Buffer | null {
  const value = getEnv().APP_ENCRYPTION_KEY;
  if (!value) return null;
  if (!derivedKey || derivedKey.passphrase !== value) {
    derivedKey = { passphrase: value, key: scryptSync(value, "scaling-inbox-secrets", 32) };
  }
  return derivedKey.key;
}

function encrypt(plaintext: string, key: Buffer): EncryptedPayload {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const data = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return {
    v: 1,
    alg: "aes-256-gcm",
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    data: data.toString("base64"),
  };
}

function decrypt(payload: unknown, key: Buffer): string | null {
  try {
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
    const value = payload as Partial<EncryptedPayload>;
    if (
      value.v !== 1 ||
      value.alg !== "aes-256-gcm" ||
      typeof value.iv !== "string" ||
      typeof value.tag !== "string" ||
      typeof value.data !== "string"
    ) return null;
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(value.iv, "base64"));
    decipher.setAuthTag(Buffer.from(value.tag, "base64"));
    return Buffer.concat([
      decipher.update(Buffer.from(value.data, "base64")),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    return null;
  }
}

async function loadRows(): Promise<Map<SecretName, unknown>> {
  try {
    const { data, error } = await getAdminClient()
      .from("integration_secrets")
      .select("name, payload")
      .in("name", SECRET_NAMES);
    if (error) return new Map();
    return new Map(
      (data ?? [])
        .filter((row): row is { name: SecretName; payload: unknown } =>
          SECRET_NAMES.includes(row.name as SecretName),
        )
        .map((row) => [row.name, row.payload]),
    );
  } catch {
    return new Map();
  }
}

async function getRows(): Promise<Map<SecretName, unknown>> {
  const now = Date.now();
  if (!cachedRows || cachedRows.expiresAt <= now) {
    cachedRows = { expiresAt: now + CACHE_TTL_MS, promise: loadRows() };
  }
  return cachedRows.promise;
}

export function invalidateSecrets(): void {
  cachedRows = null;
}

export async function setSecret(
  name: SecretName,
  plaintext: string,
  updatedBy: string,
): Promise<{ ok: boolean; message: string }> {
  const key = encryptionKey();
  if (!key) return { ok: false, message: "APP_ENCRYPTION_KEY is not configured." };
  const { error } = await getAdminClient().from("integration_secrets").upsert({
    name,
    payload: encrypt(plaintext, key),
    updated_at: new Date().toISOString(),
    updated_by: updatedBy,
  });
  if (error) return { ok: false, message: error.message };
  invalidateSecrets();
  return { ok: true, message: "Integration secret saved." };
}

export async function clearSecret(name: SecretName): Promise<{ ok: boolean; message: string }> {
  const { error } = await getAdminClient().from("integration_secrets").delete().eq("name", name);
  if (error) return { ok: false, message: error.message };
  invalidateSecrets();
  return { ok: true, message: "Integration secret cleared." };
}

export async function getSecret(name: SecretName): Promise<string | null> {
  const key = encryptionKey();
  if (!key) return null;
  try {
    const payload = (await getRows()).get(name);
    return payload === undefined ? null : decrypt(payload, key);
  } catch {
    return null;
  }
}

export async function getSecretStatus(): Promise<Record<SecretName, boolean>> {
  const rows = await getRows();
  return {
    smartlead_api_key: rows.has("smartlead_api_key"),
    zapmail_api_key: rows.has("zapmail_api_key"),
    resend_api_key: rows.has("resend_api_key"),
    smtp_password: rows.has("smtp_password"),
    enrichment_anthropic_api_key: rows.has("enrichment_anthropic_api_key"),
    openai_api_key: rows.has("openai_api_key"),
    ai_gateway_api_key: rows.has("ai_gateway_api_key"),
    apify_api_key: rows.has("apify_api_key"),
    leadmagic_api_key: rows.has("leadmagic_api_key"),
    zerobounce_api_key: rows.has("zerobounce_api_key"),
    apollo_api_key: rows.has("apollo_api_key"),
    firecrawl_api_key: rows.has("firecrawl_api_key"),
  };
}
