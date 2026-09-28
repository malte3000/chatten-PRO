import test from "node:test";
import assert from "node:assert/strict";
import { fetchJson } from "../src/apiClient.js";

test("API client extracts useful errors from JSON and HTML failures", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async () => new Response(JSON.stringify({ error: "Provider error", message: "API key saknas" }), { status: 502, headers: { "Content-Type": "application/json" } });
  await assert.rejects(fetchJson("/api/news"), (error) => error.status === 502 && error.message === "API key saknas");
  globalThis.fetch = async () => new Response("<html>Function error</html>", { status: 504, headers: { "Content-Type": "text/html" } });
  await assert.rejects(fetchJson("/api/news"), (error) => error.status === 504 && /funktionsloggarna/.test(error.message));
});

test("API client preserves scanner retry timing", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async () => new Response(JSON.stringify({ error: "Kvot upptagen", retry_after_ms: 61000 }), { status: 429 });
  await assert.rejects(fetchJson("/api/scan"), (error) => error.status === 429 && error.retryMs === 61000);
});
