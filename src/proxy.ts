import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

// First auth layer: every request must carry a valid Supabase session unless
// the path is explicitly public. Machine endpoints (/api/webhooks, /api/cron,
// the run-job tick) enforce their own secrets inside the route handlers.
const PUBLIC_FILE = /\.(?:svg|png|jpg|jpeg|gif|webp|ico|txt|xml|webmanifest)$/i;

function isPublic(pathname: string) {
  return (
    pathname === "/login" ||
    pathname.startsWith("/auth/") || // magic-link callback
    pathname.startsWith("/api/webhooks/") ||
    pathname.startsWith("/api/cron/") ||
    pathname === "/api/prospects/run-tick" || // CRON_SECRET-guarded run-job tick
    pathname.startsWith("/_next/") ||
    PUBLIC_FILE.test(pathname)
  );
}

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  if (isPublic(pathname)) {
    return NextResponse.next();
  }

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!supabaseUrl || !supabaseAnonKey) {
    return unauthorized(request);
  }

  let response = NextResponse.next({ request });

  const supabase = createServerClient(supabaseUrl, supabaseAnonKey, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet) {
        cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
        response = NextResponse.next({ request });
        cookiesToSet.forEach(({ name, value, options }) => response.cookies.set(name, value, options));
      },
    },
  });

  const { data, error } = await supabase.auth.getClaims();
  if (error || !data?.claims?.sub) {
    return unauthorized(request);
  }

  // The per-user allowlist (inbox_profiles.is_active) is enforced in the app
  // layout and in every server action via requireActiveProfile().
  return response;
}

function unauthorized(request: NextRequest) {
  if (request.nextUrl.pathname.startsWith("/api/")) {
    return NextResponse.json({ ok: false, message: "Authentication required." }, { status: 401 });
  }
  const loginUrl = new URL("/login", request.url);
  const next = request.nextUrl.pathname;
  if (next && next !== "/" && next.startsWith("/") && !next.startsWith("//")) {
    loginUrl.searchParams.set("next", next);
  }
  return NextResponse.redirect(loginUrl);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image).*)"],
};
