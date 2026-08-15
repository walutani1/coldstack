import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

// Cookie-based client bound to the signed-in user (anon key + session JWT).
// Used only for auth: sign-in, sign-out, and reading the current user.
export async function createSupabaseServerClient() {
  const cookieStore = await cookies();

  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) => cookieStore.set(name, value, options));
          } catch {
            // Server Components cannot set cookies; the proxy refreshes sessions.
          }
        },
      },
    },
  );
}
