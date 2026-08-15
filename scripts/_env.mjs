// Shared env loader for setup scripts. Loads this app's .env.local first,
// then optionally fills gaps from a sibling "Clay" workspace's .env.local
// (legacy shared-credentials location; skipped when absent). Never prints
// values.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const appRoot = path.resolve(here, "..");
export const clayRoot = path.resolve(appRoot, "..", "Clay");

export function parseEnvFile(filePath) {
  const map = {};
  if (!fs.existsSync(filePath)) return map;
  for (const line of fs.readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    map[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
  }
  return map;
}

export function loadEnv() {
  const app = parseEnvFile(path.join(appRoot, ".env.local"));
  const clay = parseEnvFile(path.join(clayRoot, ".env.local"));
  const merged = { ...clay, ...app };
  for (const [key, value] of Object.entries(merged)) {
    // THIS project's .env.local wins over whatever the shell already exported.
    // A stale global (e.g. a SUPABASE_ACCESS_TOKEN left in ~/.zprofile from
    // another account) otherwise silently shadows the file, and the failure
    // arrives as a 403 "insufficient privileges" that reads like the file's
    // credential is wrong when it was never the one being sent.
    if (key in app) process.env[key] = value;
    else if (!(key in process.env)) process.env[key] = value;
  }
  return { app, clay, merged };
}

export async function managementSql(query) {
  const ref = process.env.SUPABASE_PROJECT_REF;
  const token = process.env.SUPABASE_ACCESS_TOKEN;
  if (!ref || !token) throw new Error("Missing SUPABASE_PROJECT_REF / SUPABASE_ACCESS_TOKEN (Clay/.env.local).");
  const res = await fetch(`https://api.supabase.com/v1/projects/${ref}/database/query`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query }),
  });
  if (!res.ok) throw new Error(`Supabase SQL failed ${res.status}: ${await res.text()}`);
  return res.json();
}
