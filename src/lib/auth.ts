import "server-only";
import { cache } from "react";
import { redirect } from "next/navigation";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { getAdminClient } from "@/lib/supabase/admin";

export type InboxProfile = {
  id: string;
  email: string;
  full_name: string | null;
  is_active: boolean;
};

// Second auth layer (after the proxy's session check): the signed-in user must
// also have an active inbox_profiles row. Auth users are shared with the sales
// app, so a valid session alone is not enough.
// react cache(): layout and page both gate on this during one render pass;
// memoizing per request halves the auth round trips on every navigation.
export const getActiveProfile = cache(async function getActiveProfile(): Promise<InboxProfile | null> {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
    error,
  } = await supabase.auth.getUser();

  if (error || !user) return null;

  const { data, error: profileError } = await getAdminClient()
    .from("inbox_profiles")
    .select("id, email, full_name, is_active")
    .eq("id", user.id)
    .eq("is_active", true)
    .maybeSingle();

  if (profileError || !data) return null;
  return data as InboxProfile;
});

export async function requireActiveProfile(): Promise<InboxProfile> {
  const profile = await getActiveProfile();
  if (!profile) {
    redirect("/login");
  }
  return profile;
}

export async function requireActiveProfileResult(): Promise<
  { ok: true; profile: InboxProfile } | { ok: false; message: string }
> {
  const profile = await getActiveProfile();
  return profile
    ? { ok: true, profile }
    : { ok: false, message: "Your session expired or your account is not on the allowlist. Sign in again." };
}
