"use server";

import { redirect } from "next/navigation";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { getAdminClient } from "@/lib/supabase/admin";
import { getEnv } from "@/lib/env";

export type LoginState = {
  ok?: boolean;
  message: string;
};

function safeNextPath(value: unknown): string {
  const path = String(value ?? "");
  // In-app paths only: no protocol-relative (//) and no backslash tricks
  // (browsers normalize "/\evil.com" to "//evil.com").
  return path.startsWith("/") && !path.startsWith("//") && !path.includes("\\") ? path : "/inbox";
}

async function findActiveProfileByEmail(email: string) {
  const { data } = await getAdminClient()
    .from("inbox_profiles")
    .select("id, is_active")
    .eq("email", email)
    .eq("is_active", true)
    .maybeSingle();
  return data;
}

/** Primary flow: email a one-time sign-in link (same as the sales portal). */
export async function sendMagicLinkAction(_previousState: LoginState, formData: FormData): Promise<LoginState> {
  const email = String(formData.get("email") ?? "")
    .trim()
    .toLowerCase();
  if (!email) {
    return { ok: false, message: "Enter your email." };
  }

  // Allowlist first — links are only ever sent to active inbox profiles.
  const profile = await findActiveProfileByEmail(email);
  if (!profile) {
    return { ok: false, message: "This email does not have inbox access." };
  }

  const next = safeNextPath(formData.get("next"));
  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.auth.signInWithOtp({
    email,
    options: {
      emailRedirectTo: `${getEnv().APP_BASE_URL}/auth/confirm?next=${encodeURIComponent(next)}`,
      shouldCreateUser: false,
    },
  });

  if (error) {
    return { ok: false, message: `Could not send the link: ${error.message}` };
  }

  return { ok: true, message: `Sign-in link sent to ${email}. Open it on this device.` };
}

/** Secondary flow: password sign-in. */
export async function signInAction(_previousState: LoginState, formData: FormData): Promise<LoginState> {
  const email = String(formData.get("email") ?? "")
    .trim()
    .toLowerCase();
  const password = String(formData.get("password") ?? "");

  if (!email || !password) {
    return { ok: false, message: "Enter your email and password." };
  }

  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.auth.signInWithPassword({ email, password });

  if (error) {
    return { ok: false, message: "That email or password is not correct." };
  }

  const {
    data: { user },
  } = await supabase.auth.getUser();

  // Allowlist gate: a valid session is not enough — the user must have an
  // active inbox profile (auth users are shared with the sales app).
  const profile = user ? await findActiveProfileByEmail((user.email ?? email).toLowerCase()) : null;

  if (!profile) {
    await supabase.auth.signOut();
    return { ok: false, message: "This account does not have inbox access." };
  }

  redirect(safeNextPath(formData.get("next")));
}

export async function signOutAction() {
  const supabase = await createSupabaseServerClient();
  await supabase.auth.signOut();
  redirect("/login");
}
