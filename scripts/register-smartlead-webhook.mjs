// Point Smartlead EMAIL_REPLY webhooks at this app. Upserts by webhook name
// (also migrates registrations left by older deployments instead of creating
// duplicates). Run with no campaign ids to list your campaigns first.
//
// Usage:
//   node scripts/register-smartlead-webhook.mjs <base-url> <campaignId> [campaignId...]
//   node scripts/register-smartlead-webhook.mjs <base-url>        # lists campaigns
//   (base-url defaults to APP_BASE_URL from .env.local)
import { loadEnv } from "./_env.mjs";

const { merged } = loadEnv();

const API_KEY = merged.SMARTLEAD_API_KEY;
const SECRET = merged.SMARTLEAD_WEBHOOK_SECRET;
const BASE = merged.SMARTLEAD_API_BASE_URL || "https://server.smartlead.ai/api/v1";

const WEBHOOK_NAME = "Coldstack reply intake";
const LEGACY_NAMES = ["Scaling Inbox reply intake", "Clay reply intake"];

const args = process.argv.slice(2);
const urlArg = args[0] && !/^\d+$/.test(args[0]) ? args[0] : null;
const campaignIds = args.filter((arg) => /^\d+$/.test(arg)).map(Number);
const publicUrl = (urlArg || merged.APP_BASE_URL || "").replace(/\/$/, "");

async function api(path, init) {
  const url = new URL(`${BASE}${path}`);
  url.searchParams.set("api_key", API_KEY);
  const res = await fetch(url, init);
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text.slice(0, 300) };
  }
  return { status: res.status, ok: res.ok, json };
}

async function main() {
  if (!API_KEY) throw new Error("Missing SMARTLEAD_API_KEY.");
  if (!SECRET) throw new Error("Missing SMARTLEAD_WEBHOOK_SECRET.");
  if (!publicUrl || publicUrl.includes("localhost")) {
    throw new Error("Pass the deployed base URL, e.g. node scripts/register-smartlead-webhook.mjs https://your-app.vercel.app 1234567");
  }

  if (campaignIds.length === 0) {
    const campaignsRes = await api("/campaigns");
    const campaigns = Array.isArray(campaignsRes.json) ? campaignsRes.json : [];
    if (campaigns.length === 0) throw new Error("Could not fetch campaigns from Smartlead.");
    console.log("Pass one or more campaign ids to register. Your campaigns:\n");
    for (const campaign of campaigns) console.log(`  ${campaign.id}  ${campaign.name}`);
    return;
  }

  const webhookUrl = `${publicUrl}/api/webhooks/smartlead?secret=${encodeURIComponent(SECRET)}`;

  // Smartlead requires >=1 category on reply webhooks; passing all of them
  // means every reply fires regardless of Smartlead's own auto-category.
  const categoriesRes = await api("/leads/fetch-categories");
  const allCategories = (Array.isArray(categoriesRes.json) ? categoriesRes.json : [])
    .map((category) => category?.name)
    .filter(Boolean);
  if (allCategories.length === 0) throw new Error("Could not fetch Smartlead reply categories.");

  for (const campaignId of campaignIds) {
    const existing = await api(`/campaigns/${campaignId}/webhooks`);
    const list = Array.isArray(existing.json) ? existing.json : [];
    const match = list.find((w) => [WEBHOOK_NAME, ...LEGACY_NAMES].includes(w?.name));

    const result = await api(`/campaigns/${campaignId}/webhooks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: match?.id ?? null,
        name: WEBHOOK_NAME,
        webhook_url: webhookUrl,
        event_types: ["EMAIL_REPLY"],
        categories: allCategories,
      }),
    });

    console.log(
      `[campaign ${campaignId}] ${match ? `updated webhook #${match.id}` : "created webhook"} -> ${result.status} ${JSON.stringify(result.json).slice(0, 160)}`,
    );
  }

  console.log(`\nReply webhook now points at ${webhookUrl.replace(SECRET, "***")}`);
}

main().catch((error) => {
  console.error("ERROR:", error.message);
  process.exitCode = 1;
});
