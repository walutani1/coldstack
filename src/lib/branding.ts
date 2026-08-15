import "server-only";

import { getAdminClient } from "@/lib/supabase/admin";

// Workspace logo, stored as a base64 blob in its own app_settings row so the
// (hot, widely-loaded) workspace settings document never carries image bytes.
const LOGO_KEY = "workspace_logo";
const CACHE_TTL_MS = 30_000;

export const LOGO_MAX_BYTES = 262_144; // 256 KB
export const LOGO_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/svg+xml"]);

export type WorkspaceLogo = {
  mime: string;
  data: Buffer;
  /** Cache-busting token (updatedAt in ms) — changes on every upload. */
  version: string;
};

type StoredLogo = { v: 1; mime: string; data: string; updatedAt: string };

let cached: { expiresAt: number; promise: Promise<WorkspaceLogo | null> } | null = null;

async function loadLogo(): Promise<WorkspaceLogo | null> {
  try {
    const { data, error } = await getAdminClient()
      .from("app_settings")
      .select("value")
      .eq("key", LOGO_KEY)
      .maybeSingle();
    if (error || !data?.value) return null;
    const stored = data.value as Partial<StoredLogo>;
    if (
      stored.v !== 1 ||
      typeof stored.mime !== "string" ||
      typeof stored.data !== "string" ||
      !LOGO_MIME_TYPES.has(stored.mime)
    ) {
      return null;
    }
    const updatedMs = Date.parse(stored.updatedAt ?? "");
    return {
      mime: stored.mime,
      data: Buffer.from(stored.data, "base64"),
      version: Number.isFinite(updatedMs) ? String(updatedMs) : "1",
    };
  } catch {
    return null;
  }
}

export async function getWorkspaceLogo(): Promise<WorkspaceLogo | null> {
  const now = Date.now();
  if (!cached || cached.expiresAt <= now) {
    cached = { expiresAt: now + CACHE_TTL_MS, promise: loadLogo() };
  }
  return cached.promise;
}

export function invalidateWorkspaceLogo(): void {
  cached = null;
}

export async function setWorkspaceLogo(
  bytes: Buffer,
  mime: string,
  updatedBy: string,
): Promise<{ ok: boolean; message: string }> {
  if (!LOGO_MIME_TYPES.has(mime)) {
    return { ok: false, message: "Use a PNG, JPEG, WebP, or SVG image." };
  }
  if (bytes.length === 0 || bytes.length > LOGO_MAX_BYTES) {
    return { ok: false, message: "Logo must be between 1 byte and 256 KB." };
  }

  const stored: StoredLogo = {
    v: 1,
    mime,
    data: bytes.toString("base64"),
    updatedAt: new Date().toISOString(),
  };
  const { error } = await getAdminClient()
    .from("app_settings")
    .upsert({ key: LOGO_KEY, value: stored, updated_at: stored.updatedAt, updated_by: updatedBy });
  if (error) {
    return { ok: false, message: error.message };
  }
  invalidateWorkspaceLogo();
  return { ok: true, message: "Logo updated." };
}

export async function clearWorkspaceLogo(): Promise<{ ok: boolean; message: string }> {
  const { error } = await getAdminClient().from("app_settings").delete().eq("key", LOGO_KEY);
  if (error) {
    return { ok: false, message: error.message };
  }
  invalidateWorkspaceLogo();
  return { ok: true, message: "Logo removed." };
}
