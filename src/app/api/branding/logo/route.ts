import { NextResponse } from "next/server";
import { getWorkspaceLogo } from "@/lib/branding";

// Serves the workspace logo. Session-gated by the proxy like every other
// non-public route; the sidebar <img> sends cookies on the same origin. The
// ?v= query param (logo version) makes the immutable cache safe.
export const dynamic = "force-dynamic";

export async function GET() {
  const logo = await getWorkspaceLogo();
  if (!logo) {
    return new NextResponse(null, { status: 404 });
  }

  return new NextResponse(new Uint8Array(logo.data), {
    headers: {
      "Content-Type": logo.mime,
      "Cache-Control": "private, max-age=31536000, immutable",
      "X-Content-Type-Options": "nosniff",
      // Defense in depth for SVG: scripts never run even if the URL is opened
      // as a document instead of through an <img> tag.
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'",
      ETag: `"${logo.version}"`,
    },
  });
}
