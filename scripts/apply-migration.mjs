// Applies supabase/migrations/005_inbox_portal.sql to the shared project via
// the Supabase Management API. Idempotent (create if not exists / on conflict).
import fs from "node:fs";
import path from "node:path";
import { appRoot, loadEnv, managementSql } from "./_env.mjs";

loadEnv();
const file = process.argv[2] || "005_inbox_portal.sql";
const sql = fs.readFileSync(path.join(appRoot, "supabase", "migrations", file), "utf8");
await managementSql(sql);
console.log(`Applied ${file}.`);

const check = await managementSql(`
  select (select count(*) from inbox_profiles where is_active) as active_profiles,
         (select count(*) from information_schema.columns
            where table_name = 'reply_proposals' and column_name in ('dnc_reason','resolved_by')) as new_columns,
         (select count(*) from information_schema.tables where table_name = 'reply_sends') as reply_sends_table;
`);
console.log("Verify:", JSON.stringify(check));
