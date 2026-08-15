// Point the Smartlead EMAIL_REPLY webhook for both campaigns at this app.
// Upserts by webhook name (also migrates the old tunnel-era "Clay reply intake"
// registration instead of creating duplicates).
//
// Usage:
//   node scripts/register-smartlead-webhook.mjs [https://your-deployment.vercel.app]
//   (defaults to APP_BASE_URL from .env.local)
import { loadEnv } from "./_env.mjs";

const { merged } = loadEnv();

const API_KEY = merged.SMARTLEAD_API_KEY;
const SECRET = merged.SMARTLEAD_WEBHOOK_SECRET;
const BASE = merged.SMARTLEAD_API_BASE_URL || "https://server.smartlead.ai/api/v1";

const CAMPAIGNS = [
  { id: 3566006, name: "Manufacturing Operations Senior/Managers" },
  { id: 3588358, name: "Manufacturing Operations Directors" },
];

const WEBHOOK_NAME = "Scaling Inbox reply intake";
const LEGACY_NAMES = ["Clay reply intake"];

const publicUrl = (process.argv[2] || merged.APP_BASE_URL || "").replace(/\/$/, "");

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
    throw new Error("Pass the deployed base URL, e.g. node scripts/register-smartlead-webhook.mjs https://your-app.vercel.app");
  }

  const webhookUrl = `${publicUrl}/api/webhooks/smartlead?secret=${encodeURIComponent(SECRET)}`;

  // Smartlead requires >=1 category on reply webhooks; passing all of them
  // means every reply fires regardless of Smartlead's own auto-category.
  const categoriesRes = await api("/leads/fetch-categories");
  const allCategories = (Array.isArray(categoriesRes.json) ? categoriesRes.json : [])
    .map((category) => category?.name)
    .filter(Boolean);
  if (allCategories.length === 0) throw new Error("Could not fetch Smartlead reply categories.");

  for (const campaign of CAMPAIGNS) {
    const existing = await api(`/campaigns/${campaign.id}/webhooks`);
    const list = Array.isArray(existing.json) ? existing.json : [];
    const match = list.find((w) => [WEBHOOK_NAME, ...LEGACY_NAMES].includes(w?.name));

    const result = await api(`/campaigns/${campaign.id}/webhooks`, {
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
      `[${campaign.name}] ${match ? `updated webhook #${match.id}` : "created webhook"} -> ${result.status} ${JSON.stringify(result.json).slice(0, 160)}`,
    );
  }

  console.log(`\nReply webhook now points at ${webhookUrl.replace(SECRET, "***")}`);
}

main().catch((error) => {
  console.error("ERROR:", error.message);
  process.exitCode = 1;
});
