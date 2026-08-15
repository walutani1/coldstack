import "server-only";

import type { User } from "@supabase/supabase-js";
import { getEnv } from "@/lib/env";
import { getAdminClient } from "@/lib/supabase/admin";

export type TeamMember = {
  id: string;
  email: string;
  fullName: string | null;
  isActive: boolean;
  isSelf: boolean;
};

type ProfileRow = {
  id: string;
  email: string;
  full_name: string | null;
  is_active: boolean;
};

export async function listTeamMembers(selfId: string): Promise<TeamMember[]> {
  const { data, error } = await getAdminClient()
    .from("inbox_profiles")
    .select("id, email, full_name, is_active")
    .order("email", { ascending: true });
  if (error) throw new Error(error.message);

  return (data as ProfileRow[]).map((member) => ({
    id: member.id,
    email: member.email,
    fullName: member.full_name,
    isActive: member.is_active,
    isSelf: member.id === selfId,
  }));
}

export async function setMemberActive(
  id: string,
  active: boolean,
  selfId: string,
): Promise<{ ok: boolean; message: string }> {
  if (!active && id === selfId) {
    return { ok: false, message: "You cannot deactivate your own account." };
  }

  const admin = getAdminClient();
  const { data: member, error: memberError } = await admin
    .from("inbox_profiles")
    .select("id, is_active")
    .eq("id", id)
    .maybeSingle();
  if (memberError) return { ok: false, message: memberError.message };
  if (!member) return { ok: false, message: "Team member not found." };
  if (member.is_active === active) {
    return { ok: true, message: `Team member is already ${active ? "active" : "inactive"}.` };
  }

  if (!active) {
    const { count, error: countError } = await admin
      .from("inbox_profiles")
      .select("id", { count: "exact", head: true })
      .eq("is_active", true);
    if (countError) return { ok: false, message: countError.message };
    if ((count ?? 0) <= 1) {
      return { ok: false, message: "The last active team member cannot be deactivated." };
    }
  }

  // The count above is racy (read-then-write); migration 014's trigger is the
  // real guard and raises when a concurrent deactivation would leave zero
  // active members — map that (and its deadlock flavor) to a friendly message.
  const { error } = await admin.from("inbox_profiles").update({ is_active: active }).eq("id", id);
  if (error) {
    const raced = /last active team member|deadlock detected/i.test(error.message);
    return {
      ok: false,
      message: raced ? "The last active team member cannot be deactivated." : error.message,
    };
  }
  return { ok: true, message: `Team member ${active ? "activated" : "deactivated"}.` };
}

async function findAuthUserByEmail(email: string): Promise<User | null> {
  const admin = getAdminClient();
  const perPage = 1000;
  for (let page = 1; ; page += 1) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage });
    if (error) throw error;
    const match = data.users.find((user) => user.email?.toLowerCase() === email);
    if (match) return match;
    if (data.users.length < perPage) return null;
  }
}

async function activateProfile(
  id: string,
  email: string,
  fullName: string | null,
): Promise<{ ok: boolean; message: string }> {
  const admin = getAdminClient();
  // Only write full_name when a name was actually supplied — re-inviting an
  // existing member with the name box empty must not wipe their stored name.
  const nameFields = fullName ? { full_name: fullName } : {};
  const { error } = await admin.from("inbox_profiles").upsert(
    { id, email, is_active: true, ...nameFields },
    { onConflict: "id" },
  );
  if (!error) return { ok: true, message: "" };

  // A concurrent invite can win the profile insert. Treat that as success
  // when the row belongs to this auth user, and make sure it is reactivated.
  const { data: racedById, error: idError } = await admin
    .from("inbox_profiles")
    .select("id")
    .eq("id", id)
    .maybeSingle();
  if (idError) return { ok: false, message: idError.message };
  const emailLookup = racedById
    ? { data: racedById, error: null }
    : await admin.from("inbox_profiles").select("id").eq("email", email).maybeSingle();
  if (emailLookup.error || !emailLookup.data || emailLookup.data.id !== id) {
    return { ok: false, message: emailLookup.error?.message ?? error.message };
  }
  const { error: updateError } = await admin
    .from("inbox_profiles")
    .update({ email, is_active: true, ...nameFields })
    .eq("id", id);
  return updateError
    ? { ok: false, message: updateError.message }
    : { ok: true, message: "" };
}

export async function inviteMember(
  email: string,
  fullName: string | null,
  invitedBy: string,
): Promise<{ ok: boolean; message: string }> {
  const normalizedEmail = email.trim().toLowerCase();
  const normalizedName = fullName?.trim() || null;
  const emailParts = normalizedEmail.split("@");
  if (
    normalizedEmail.length > 320 ||
    emailParts.length !== 2 ||
    !emailParts[0] ||
    emailParts[0].length > 64 ||
    !emailParts[1] ||
    emailParts[1].length > 255 ||
    !emailParts[1].includes(".") ||
    /[\s,()<>;:\\"\[\]]/.test(normalizedEmail)
  ) {
    return { ok: false, message: "Enter a valid email address." };
  }
  if (normalizedName && normalizedName.length > 120) {
    return { ok: false, message: "Full name must be 120 characters or fewer." };
  }

  try {
    // Supabase Auth users are shared project-wide. Inviting here may reuse a
    // user created by another app in the same project; inbox_profiles remains
    // this app's explicit access boundary.
    let user = await findAuthUserByEmail(normalizedEmail);
    if (!user) {
      const { data, error } = await getAdminClient().auth.admin.createUser({
        email: normalizedEmail,
        email_confirm: true,
        user_metadata: normalizedName ? { full_name: normalizedName } : undefined,
      });
      if (error) {
        // Another operator may have created the same auth user after our lookup.
        user = await findAuthUserByEmail(normalizedEmail);
        if (!user) return { ok: false, message: error.message };
      } else {
        user = data.user;
      }
    }

    const activated = await activateProfile(user.id, normalizedEmail, normalizedName);
    if (!activated.ok) return activated;
    const appUrl = getEnv().APP_BASE_URL.replace(/\/$/, "");
    return {
      ok: true,
      message: `${normalizedEmail} is now a member. No email was sent, so let them know to request a magic link at ${appUrl}/login. Invited by ${invitedBy}.`,
    };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}
