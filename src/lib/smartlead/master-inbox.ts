import "server-only";

import { z } from "zod";
import { resolveSmartleadConfig } from "@/lib/smartlead";

const RawReplySchema = z.object({
  id: z.union([z.string(), z.number()]).transform(String),
  account_id: z.union([z.string(), z.number()]).nullish().transform((value) => value == null ? null : String(value)),
  message_id: z.string().nullish(),
  uid: z.union([z.string(), z.number()]).nullish().transform((value) => value == null ? null : String(value)),
  sender_detail: z.string().nullish(),
  recipient_detail: z.string().nullish(),
  cc: z.unknown().nullish(),
  bcc: z.unknown().nullish(),
  subject: z.string().nullish(),
  visible_text: z.string().nullish(),
  reply_picked_time: z.string().nullish(),
  created_at: z.string().nullish(),
  updated_at: z.string().nullish(),
}).passthrough();

const PageSchema = z.object({
  replies: z.array(RawReplySchema),
  totalCount: z.number().int().nonnegative().optional(),
  pagination: z.object({
    limit: z.number().int().nonnegative().optional(),
    offset: z.number().int().nonnegative().optional(),
    totalCount: z.number().int().nonnegative().optional(),
    hasMore: z.boolean().optional(),
  }).passthrough().optional(),
}).passthrough();

const EnvelopeSchema = z.object({
  ok: z.boolean().optional(),
  data: z.unknown().optional(),
}).passthrough();

export type UntrackedProviderReply = {
  providerReplyId: string;
  accountId: string | null;
  providerMessageId: string | null;
  uid: string | null;
  fromEmail: string | null;
  fromName: string | null;
  toEmail: string | null;
  cc: unknown;
  bcc: unknown;
  subject: string | null;
  bodyText: string | null;
  providerReceivedAt: string | null;
  raw: Record<string, unknown>;
};

export type UntrackedProviderPage = {
  replies: UntrackedProviderReply[];
  totalCount: number | null;
  hasMore: boolean;
  limit: number;
  offset: number;
};

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function findPage(value: unknown): unknown {
  let current: unknown = value;
  for (let depth = 0; depth < 5; depth += 1) {
    const record = object(current);
    if (!record) break;
    if (Array.isArray(record.replies)) return record;
    current = record.data;
  }
  return value;
}

export function parseMailbox(value: string | null | undefined): { email: string | null; name: string | null } {
  const text = value?.trim();
  if (!text) return { email: null, name: null };
  const bracket = text.match(/^\s*(?:"([^"]+)"|([^<]*?))?\s*<\s*([^<>\s]+@[^<>\s]+)\s*>\s*$/);
  if (bracket) return { email: bracket[3].trim().toLowerCase(), name: (bracket[1] ?? bracket[2] ?? "").trim() || null };
  const bare = text.match(/[^\s<>,;]+@[^\s<>,;]+/);
  return { email: bare?.[0].toLowerCase() ?? null, name: bare ? null : text };
}

function validDate(...values: (string | null | undefined)[]): string | null {
  for (const value of values) {
    if (value && Number.isFinite(Date.parse(value))) return new Date(value).toISOString();
  }
  return null;
}

export async function fetchUntrackedRepliesPage(input: {
  limit?: number;
  offset?: number;
  fetchBody?: boolean;
  fetchAttachments?: boolean;
} = {}): Promise<UntrackedProviderPage> {
  const limit = Math.max(1, Math.min(input.limit ?? 100, 100));
  const offset = Math.max(0, input.offset ?? 0);
  const config = await resolveSmartleadConfig();
  if (!config.apiKey) throw new Error("Smartlead API key is not configured.");
  const url = new URL(`${config.baseUrl.replace(/\/$/, "")}/master-inbox/untracked-replies`);
  url.searchParams.set("api_key", config.apiKey);
  url.searchParams.set("limit", String(limit));
  url.searchParams.set("offset", String(offset));
  if (input.fetchBody !== undefined) url.searchParams.set("fetchBody", String(input.fetchBody));
  if (input.fetchAttachments !== undefined) url.searchParams.set("fetchAttachments", String(input.fetchAttachments));

  const response = await fetch(url, { cache: "no-store" });
  const text = await response.text();
  if (!response.ok) throw new Error(`Smartlead untracked replies ${response.status}: ${text.slice(0, 500)}`);
  let json: unknown;
  try { json = JSON.parse(text); } catch { throw new Error("Smartlead untracked replies returned invalid JSON."); }
  const envelope = EnvelopeSchema.safeParse(json);
  if (!envelope.success) throw new Error("Smartlead untracked replies returned an invalid envelope.");
  const page = PageSchema.safeParse(findPage(json));
  if (!page.success) throw new Error(`Smartlead untracked replies schema mismatch: ${page.error.issues[0]?.message ?? "unknown"}`);
  const totalCount = page.data.totalCount ?? page.data.pagination?.totalCount ?? null;
  return {
    replies: page.data.replies.map((raw) => {
      const sender = parseMailbox(raw.sender_detail);
      const recipient = parseMailbox(raw.recipient_detail);
      return {
        providerReplyId: raw.id,
        accountId: raw.account_id,
        providerMessageId: raw.message_id?.trim() || null,
        uid: raw.uid,
        fromEmail: sender.email,
        fromName: sender.name,
        toEmail: recipient.email,
        cc: raw.cc ?? null,
        bcc: raw.bcc ?? null,
        subject: raw.subject?.trim() || null,
        bodyText: raw.visible_text?.trim() || null,
        providerReceivedAt: validDate(raw.reply_picked_time, raw.created_at, raw.updated_at),
        raw: raw as Record<string, unknown>,
      };
    }),
    totalCount,
    hasMore: page.data.pagination?.hasMore ?? (totalCount !== null ? offset + page.data.replies.length < totalCount : page.data.replies.length === limit),
    limit: page.data.pagination?.limit ?? limit,
    offset: page.data.pagination?.offset ?? offset,
  };
}
