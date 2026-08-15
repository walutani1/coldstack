// Bootstrap the first active inbox member for a fresh installation.
// Usage: node scripts/bootstrap-admin.mjs you@example.com "Full Name"
import { createClient } from "@supabase/supabase-js";
import { loadEnv } from "./_env.mjs";

const { merged } = loadEnv();
const email = (process.argv[2] || "").trim().toLowerCase();
const fullName = (process.argv[3] || "").trim() || null;

function validEmail(value) {
  const parts = value.split("@");
  return (
    value.length <= 320 &&
    parts.length === 2 &&
    parts[0] &&
    parts[0].length <= 64 &&
    parts[1] &&
    parts[1].length <= 255 &&
    parts[1].includes(".") &&
    !/[\s,()<>;:\\"\[\]]/.test(value)
  );
}

async function findUser(admin, targetEmail) {
  const perPage = 1000;
  for (let page = 1; ; page += 1) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage });
    if (error) throw error;
    const user = data.users.find((candidate) => candidate.email?.toLowerCase() === targetEmail);
    if (user) return user;
    if (data.users.length < perPage) return null;
  }
}

async function main() {
  if (!validEmail(email)) {
    throw new Error('Pass a valid email: node scripts/bootstrap-admin.mjs you@example.com "Full Name"');
  }
  if (fullName && fullName.length > 120) throw new Error("Full name must be 120 characters or fewer.");
  if (!merged.NEXT_PUBLIC_SUPABASE_URL || !merged.SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error("Missing NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY.");
  }

  const admin = createClient(merged.NEXT_PUBLIC_SUPABASE_URL, merged.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // Auth users belong to the whole Supabase project, not only this app. Reuse
  // an existing account and grant inbox access only through inbox_profiles.
  let user = await findUser(admin, email);
  let created = false;
  if (!user) {
    const result = await admin.auth.admin.createUser({
      email,
      email_confirm: true,
      user_metadata: fullName ? { full_name: fullName } : undefined,
    });
    if (result.error) {
      // A concurrent bootstrap may have created the same auth user.
      user = await findUser(admin, email);
      if (!user) throw result.error;
    } else {
      user = result.data.user;
      created = true;
    }
  }

  // Only write full_name when provided — re-running without a name must not
  // wipe an existing member's stored name.
  const { error } = await admin.from("inbox_profiles").upsert(
    { id: user.id, email, is_active: true, ...(fullName ? { full_name: fullName } : {}) },
    { onConflict: "id" },
  );
  if (error) throw error;

  console.log(`${created ? "Created" : "Reused"} auth user and activated inbox profile for ${email}.`);
  console.log(`They can now request a magic link at ${(merged.APP_BASE_URL || "http://localhost:3000").replace(/\/$/, "")}/login.`);
}

main().catch((error) => {
  console.error("BOOTSTRAP FAILED:", error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
