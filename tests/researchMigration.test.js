import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const migration = new URL("../supabase/migrations/20261123183848_pattern_research_storage.sql", import.meta.url);
const tables = [
  "research_datasets", "research_market_bars", "research_runs",
  "research_pattern_events", "research_pattern_results",
  "research_model_versions", "research_forecasts",
];

test("research migration is additive and protects every new public table with RLS", async () => {
  const sql = (await readFile(migration, "utf8")).toLowerCase();
  assert.doesNotMatch(sql, /alter\s+table\s+public\.(trades|paper_observations)/);
  assert.doesNotMatch(sql, /drop\s+(table|column|schema)/);
  for (const table of tables) {
    assert.match(sql, new RegExp(`create\\s+table\\s+public\\.${table}\\b`));
    assert.match(sql, new RegExp(`alter\\s+table\\s+public\\.${table}\\s+enable\\s+row\\s+level\\s+security`));
    assert.match(sql, new RegExp(`revoke\\s+all\\s+on\\s+table\\s+public\\.${table}\\s+from\\s+public,\\s*anon,\\s*authenticated`));
  }
});

test("research migration grants only scoped, non-delete server access", async () => {
  const sql = (await readFile(migration, "utf8")).toLowerCase();
  assert.doesNotMatch(sql, /grant[^;]*\bdelete\b[^;]*to\s+service_role/);
  assert.doesNotMatch(sql, /grant[^;]*to\s+(anon|authenticated)/);
  assert.doesNotMatch(sql, /grant\s+usage,\s*select\s+on\s+all\s+sequences/);
  assert.match(sql, /revoke all on sequence public\.research_pattern_events_event_id_seq from public, anon, authenticated/);
  assert.match(sql, /revoke all on sequence public\.research_pattern_results_result_id_seq from public, anon, authenticated/);
});
