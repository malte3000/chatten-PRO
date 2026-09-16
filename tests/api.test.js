import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import newsHandler from "../api/analyze-news.js";
import tradesHandler from "../api/trades.js";
import { createAnalysisRecord } from "../src/analysisModel.js";

function response() {
  return { code: 200, status(code) { this.code = code; return this; }, json(data) { this.data = data; return this; } };
}

function setup(t) {
  const oldFetch = globalThis.fetch;
  const keys = ["APP_LOGIN_PASSWORD", "ANTHROPIC_API_KEY", "SUPABASE_URL", "SUPABASE_SECRET_KEY", "VERCEL_ENV", "PREVIEW_ALLOW_WRITES"];
  const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  delete process.env.VERCEL_ENV;
  delete process.env.PREVIEW_ALLOW_WRITES;
  process.env.APP_LOGIN_PASSWORD = "test-only-password";
  process.env.ANTHROPIC_API_KEY = "test-only-key";
  process.env.SUPABASE_URL = "https://example.invalid";
  process.env.SUPABASE_SECRET_KEY = "test-only-secret";
  t.after(() => {
    globalThis.fetch = oldFetch;
    for (const key of keys) { if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key]; }
  });
  const payload = Buffer.from(JSON.stringify({ exp: Date.now() + 60000 })).toString("base64url");
  const signature = crypto.createHmac("sha256", process.env.APP_LOGIN_PASSWORD).update(payload).digest("base64url");
  return { cookie: `chatten_pro_session=${payload}.${signature}` };
}

const analysis = { direction: "upp", direction_confidence: 30, probability_up: 99, summary: "Kort nyhetsbild.", reasoning: "Fullständig text.", key_news: [] };

test("news runs for a closed market and never treats AI confidence as probability", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-09-19T12:00:00Z") });
  const headers = setup(t);
  globalThis.fetch = async (_url, options) => {
    assert.equal(options.headers["x-api-key"], "test-only-key");
    return { ok: true, json: async () => ({ stop_reason: "end_turn", content: [{ type: "text", text: JSON.stringify(analysis) }] }) };
  };
  const res = response();
  // Unknown/closed market does not gate the outbound news search.
  await newsHandler({ method: "POST", headers, body: { ticker: " nvda ", market: "stockholm", horizonText: "1–5 handelsdagar" } }, res);
  assert.equal(res.code, 200);
  assert.equal(res.data.ticker, "NVDA");
  assert.equal(res.data.direction_confidence, 30);
  assert.equal(res.data.probability_up, null);
  assert.equal(res.data.marketStatus.isOpen, false);
});

test("paused, truncated, or invalid news is rejected", async (t) => {
  const headers = setup(t);
  for (const result of [
    { stop_reason: "pause_turn", content: [] },
    { stop_reason: "max_tokens", content: [] },
    { stop_reason: "end_turn", content: [{ type: "text", text: JSON.stringify({ ...analysis, direction_confidence: 130 }) }] },
  ]) {
    globalThis.fetch = async () => ({ ok: true, json: async () => result });
    const res = response();
    await newsHandler({ method: "POST", headers, body: { ticker: "NVDA" } }, res);
    assert.equal(res.code, 502);
  }
});

test("trade save and journal read roundtrip through mocked Supabase", async (t) => {
  const headers = setup(t);
  const record = createAnalysisRecord({ ticker: "NVDA", decision: { status: "WAIT", reasons: ["Risk pending"] } }, { id: "fixed" });
  let stored;
  globalThis.fetch = async (url, options) => {
    assert.ok(url.startsWith("https://example.invalid/rest/v1/trades"));
    assert.equal(options.headers.Authorization, "Bearer test-only-secret");
    if (options.method === "POST") stored = JSON.parse(options.body);
    return { ok: true, json: async () => [stored] };
  };
  const saved = response();
  await tradesHandler({ method: "POST", headers, body: record }, saved);
  assert.equal(saved.code, 201);
  const read = response();
  await tradesHandler({ method: "GET", headers }, read);
  assert.equal(read.code, 200);
  assert.equal(read.data.trades[0].signal_inputs.decision.status, "WAIT");
  assert.equal(read.data.trades[0].winner, null);
});

test("unauthenticated requests never reach Supabase", async (t) => {
  setup(t);
  globalThis.fetch = async () => { throw new Error("must not run"); };
  const res = response();
  await tradesHandler({ method: "GET", headers: {} }, res);
  assert.equal(res.code, 401);
});

test("preview cannot write to Supabase unless explicitly enabled", async (t) => {
  const headers = setup(t);
  process.env.VERCEL_ENV = "preview";
  let calls = 0;
  globalThis.fetch = async () => { calls++; return { ok: true, json: async () => [] }; };
  const blocked = response();
  await tradesHandler({ method: "POST", headers, body: {} }, blocked);
  assert.equal(blocked.code, 409);
  assert.equal(calls, 0);
  const read = response();
  await tradesHandler({ method: "GET", headers }, read);
  assert.equal(read.code, 200);
  process.env.PREVIEW_ALLOW_WRITES = "true";
  const enabled = response();
  const record = createAnalysisRecord({ ticker: "NVDA", decision: { status: "WAIT", reasons: [] } }, { id: "preview" });
  await tradesHandler({ method: "POST", headers, body: record }, enabled);
  assert.equal(enabled.code, 201);
  assert.equal(calls, 2);
});

test("Supabase failure is not reported as saved", async (t) => {
  const headers = setup(t);
  globalThis.fetch = async () => ({ ok: false, status: 503, json: async () => ({ message: "mock unavailable" }) });
  const res = response();
  await tradesHandler({ method: "GET", headers }, res);
  assert.equal(res.code, 503);
  assert.notEqual(res.data.success, true);
});
