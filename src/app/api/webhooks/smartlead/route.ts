import { after, NextResponse, type NextRequest } from "next/server";
import crypto from "node:crypto";
import { getEnv } from "@/lib/env";
import { ingestReplyPayload } from "@/lib/replies/ingest";
import { processPendingReplyEvents } from "@/lib/replies/process";

export const maxDuration = 60;

// Constant-time comparison over digests so length differences leak nothing.
function secretMatches(candidate: string | null | undefined) {
  if (!candidate) return false;
  const expected = crypto.createHash("sha256").update(getEnv().SMARTLEAD_WEBHOOK_SECRET).digest();
  const received = crypto.createHash("sha256").update(candidate).digest();
  return crypto.timingSafeEqual(expected, received);
}

export async function POST(request: NextRequest) {
  let payload: Record<string, unknown>;
  try {
    payload = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ ok: false, message: "Invalid JSON." }, { status: 400 });
  }

  const secret =
    request.nextUrl.searchParams.get("secret") ??
    (typeof payload.secret === "string" ? payload.secret : null);

  if (!secretMatches(secret)) {
    return NextResponse.json({ ok: false, message: "Unauthorized." }, { status: 401 });
  }

  const eventType = String(payload.event_type ?? payload.webhook_event_type ?? "").toUpperCase();
  if (eventType && !eventType.includes("REPLY")) {
    return NextResponse.json({ ok: true, ignored: true, eventType });
  }

  try {
    const { eventId, deduped, reason, transient } = await ingestReplyPayload(payload);

    // Transient store failure: 5xx so Smartlead redelivers instead of losing
    // the reply. Permanent skips (e.g. no lead email) still 200.
    if (!eventId && !deduped && transient) {
      return NextResponse.json({ ok: false, message: "Ingest failed." }, { status: 500 });
    }

    if (eventId && !deduped) {
      // Categorize after the response is sent so Smartlead gets a fast 200.
      // Batch of 2 (this event + maybe one straggler) fits the 60s window;
      // anything more waits for the 300s cron.
      after(async () => {
        try {
          await processPendingReplyEvents(2);
        } catch {
          // Cron / inbox-load drains will pick this event up.
        }
      });
    }

    return NextResponse.json({ ok: true, eventId, deduped, reason: eventId ? undefined : reason });
  } catch {
    return NextResponse.json({ ok: false, message: "Ingest failed." }, { status: 500 });
  }
}

export async function GET() {
  return NextResponse.json({ ok: true, service: "coldstack", accepts: "POST Smartlead EMAIL_REPLY" });
}
