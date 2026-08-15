import "server-only";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { getEnv } from "@/lib/env";

let cached: SupabaseClient | null = null;

// Service-role client. Bypasses RLS — server-side only, never sent to the
// browser. Every call site sits behind requireActiveProfile() or a webhook /
// cron secret check.
export function getAdminClient() {
  if (!cached) {
    const env = getEnv();
    cached = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
  }
  return cached;
}
