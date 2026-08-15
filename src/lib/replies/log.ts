import "server-only";
import { getAdminClient } from "@/lib/supabase/admin";

export async function logRun(input: { leadId: string | null; action: string; ok: boolean; message: string }) {
  await getAdminClient()
    .from("lead_runs")
    .insert({
      lead_id: input.leadId,
      action: input.action,
      provider: "inbox",
      ok: input.ok,
      message: input.message.slice(0, 500),
    });
}
