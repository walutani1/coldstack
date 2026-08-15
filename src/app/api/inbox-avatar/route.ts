import { NextResponse, type NextRequest } from "next/server";
import {
  getInboxAvatarUpstreamState,
  loadCachedAvatarImage,
  persistAvatarImage,
} from "@/lib/inbox-avatars";

/* Serves a sending inbox's Zapmail profile picture from OUR origin. Browsers
   never touch cdn.zapmail.ai directly — network filters that block Zapmail
   domains, and the sandboxed Gmail-preview iframe, all see a same-origin
   image. Session-gated by the proxy like every other non-public route (the
   <img> tag sends cookies on the same origin — the branding/logo idiom).

   Bytes come from three layers: a per-process cache, the live CDN (whose
   successes are persisted), and the durable inbox_avatar_images cache — the
   only layer that works where *.zapmail.ai is blocked entirely. */
export const dynamic = "force-dynamic";

const TTL_MS = 10 * 60_000;
const MAX_ENTRIES = 64; // ~1MB each; enough for every mailbox with headroom
const imageCache = new Map<string, { at: number; bytes: ArrayBuffer; type: string }>();

function remember(upstreamUrl: string, entry: { at: number; bytes: ArrayBuffer; type: string }) {
  // Map iteration is insertion-ordered, so the first key is the oldest.
  if (!imageCache.has(upstreamUrl) && imageCache.size >= MAX_ENTRIES) {
    imageCache.delete(imageCache.keys().next().value!);
  }
  imageCache.set(upstreamUrl, entry);
}

export async function GET(request: NextRequest) {
  const email = (request.nextUrl.searchParams.get("email") ?? "").trim().toLowerCase();
  if (!email || !email.includes("@")) return new NextResponse(null, { status: 400 });

  const upstreamUrl = (await getInboxAvatarUpstreamState()).map[email];
  if (!upstreamUrl) return new NextResponse(null, { status: 404 });

  let entry = imageCache.get(upstreamUrl);
  if (!entry || Date.now() - entry.at > TTL_MS) {
    const upstream = await fetch(upstreamUrl, { cache: "no-store" }).catch(() => null);
    if (upstream?.ok) {
      entry = {
        at: Date.now(),
        bytes: await upstream.arrayBuffer(),
        type: upstream.headers.get("content-type") ?? "image/png",
      };
      remember(upstreamUrl, entry);
      persistAvatarImage(upstreamUrl, entry.type, entry.bytes);
    } else if (!entry) {
      // CDN unreachable and nothing in-process: the durable cache decides.
      const cached = await loadCachedAvatarImage(upstreamUrl).catch(() => null);
      if (cached) {
        entry = { at: Date.now(), bytes: cached.bytes, type: cached.type };
        remember(upstreamUrl, entry);
      }
    }
    // An upstream hiccup with an in-process copy serves that stale copy; with
    // nothing anywhere, report not-found and the client falls back to its
    // placeholder.
    if (!entry) return new NextResponse(null, { status: 404 });
  }

  return new NextResponse(entry.bytes, {
    headers: {
      "Content-Type": entry.type,
      "Cache-Control": "private, max-age=600",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
