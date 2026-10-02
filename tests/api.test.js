import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import newsHandler from "../api/analyze-news.js";
import imageHandler from "../api/analyze-image.js";
import marketDataHandler from "../api/market-data.js";
import tradesHandler from "../api/trades.js";
import { createAnalysisRecord, createRealTradeRecord } from "../src/analysisModel.js";

function response() {
  return { code: 200, status(code) { this.code = code; return this; }, json(data) { this.data = data; return this; } };
}

function setup(t) {
  const oldFetch = globalThis.fetch;
  const keys = ["APP_LOGIN_PASSWORD", "ANTHROPIC_API_KEY", "TWELVE_DATA_API_KEY", "SUPABASE_URL", "SUPABASE_SECRET_KEY", "VERCEL_ENV", "PREVIEW_ALLOW_WRITES"];
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
const chartAnalysis = {
  chart_type: "candlestick", price_detected: null, premarket_detected: false,
  premarket_move_pct: null, premarket_notes: null, volatility_estimate: 35,
  drift_estimate: 0, trend: "neutral", confidence: 50, reasoning: "Försiktig grafbedömning.",
  candlestick_pattern: null, candlestick_reasoning: null, amd_phase: "unclear",
  amd_confidence: null, amd_reasoning: "Otydlig fas.", commentary: "",
};
const imageInput = { ticker: "NVDA", market: "stockholm", imageBase64: "eA==", imageMediaType: "image/png" };

test("Anthropic routes report a missing server key before calling the provider", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-09-28T09:00:00Z") });
  const headers = setup(t);
  delete process.env.ANTHROPIC_API_KEY;
  globalThis.fetch = async () => { throw new Error("provider must not be called"); };
  const news = response();
  await newsHandler({ method: "POST", headers, body: { ticker: "NVDA" } }, news);
  assert.equal(news.code, 500);
  assert.match(news.data.error, /ANTHROPIC_API_KEY/);
  const image = response();
  await imageHandler({ method: "POST", headers, body: { ticker: "NVDA", imageBase64: "eA==", imageMediaType: "image/png", market: "stockholm" } }, image);
  assert.equal(image.code, 500);
  assert.match(image.data.error, /ANTHROPIC_API_KEY/);
});

test("market data translates a provider timeout into a clear gateway timeout", async (t) => {
  const headers = setup(t);
  process.env.TWELVE_DATA_API_KEY = "test-only-market-key";
  globalThis.fetch = async () => { throw new DOMException("Timed out", "TimeoutError"); };
  const res = response();
  await marketDataHandler({ method: "GET", headers, query: { ticker: "NVDA", interval: "1day" } }, res);
  assert.equal(res.code, 504);
  assert.match(res.data.message, /15 sekunder/);
});

test("news without actual search evidence remains unclear even when the model claims a direction", async (t) => {
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
  assert.equal(res.data.direction, "oklart");
  assert.equal(res.data.direction_confidence, 0);
  assert.equal(res.data.probability_up, null);
  assert.equal(res.data.marketStatus.isOpen, false);
  assert.deepEqual(res.data.source_evidence.sources, []);
  assert.equal(res.data.source_evidence.freshness_verified, false);
  assert.deepEqual(res.data.key_news, []);
});

test("actual Anthropic web results and citations are surfaced without claiming event freshness", async (t) => {
  const headers = setup(t);
  globalThis.fetch = async () => ({ ok: true, json: async () => ({
    stop_reason: "end_turn", content: [
      { type: "server_tool_use", name: "web_search", input: { query: "NVDA news" } },
      { type: "web_search_tool_result", content: [
        { type: "web_search_result", url: "https://example.com/article", title: "Issuer update", page_age: "October 2, 2026" },
        { type: "web_search_result", url: "javascript:alert(1)", title: "Unsafe URL" },
      ] },
      { type: "text", text: JSON.stringify(analysis), citations: [
        { type: "web_search_result_location", url: "https://example.com/article", title: "Issuer update" },
      ] },
    ],
  }) });
  const res = response();
  await newsHandler({ method: "POST", headers, body: { ticker: "NVDA" } }, res);
  assert.equal(res.code, 200);
  assert.equal(res.data.direction, "upp");
  assert.equal(res.data.direction_confidence, 30);
  assert.deepEqual(res.data.source_evidence.sources, [
    { url: "https://example.com/article", title: "Issuer update", kind: "citation" },
  ]);
  assert.equal(res.data.source_evidence.freshness_verified, false);
  assert.equal(Object.hasOwn(res.data.source_evidence.sources[0], "page_age"), false);
});

test("Anthropic billing failures remain errors, never neutral news", async (t) => {
  const headers = setup(t);
  globalThis.fetch = async () => ({ ok: false, status: 400, json: async () => ({ error: { message: "Your credit balance is too low to access the Anthropic API." } }) });
  const res = response();
  await newsHandler({ method: "POST", headers, body: { ticker: "PAYC" } }, res);
  assert.equal(res.code, 400);
  assert.match(res.data.message, /credit balance is too low/);
  assert.equal(res.data.direction, undefined);
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

test("HTTP success with a web search tool error cannot confirm fresh news", async (t) => {
  const headers = setup(t);
  globalThis.fetch = async () => ({ ok: true, json: async () => ({
    stop_reason: "end_turn", content: [
      { type: "web_search_tool_result", content: { type: "web_search_tool_result_error", error_code: "unavailable" } },
      { type: "text", text: JSON.stringify(analysis) },
    ],
  }) });
  const res = response();
  await newsHandler({ method: "POST", headers, body: { ticker: "NVDA" } }, res);
  assert.equal(res.code, 502);
  assert.match(res.data.error, /Nyhetssökningen misslyckades/);
  assert.equal(res.data.direction, undefined);
});

test("provider body-read timeouts retain the explicit gateway timeout", async (t) => {
  const headers = setup(t);
  process.env.TWELVE_DATA_API_KEY = "test-only-market-key";
  globalThis.fetch = async () => ({ ok: true, json: async () => { throw new DOMException("Body timed out", "TimeoutError"); } });
  const res = response();
  await marketDataHandler({ method: "GET", headers, query: { ticker: "NVDA", interval: "1day" } }, res);
  assert.equal(res.code, 504);
});

test("unsupported, malformed, and oversized image inputs never reach Anthropic", async (t) => {
  const headers = setup(t);
  globalThis.fetch = async () => { throw new Error("invalid image must not reach provider"); };
  for (const [patch, expectedStatus] of [
    [{ imageMediaType: "image/svg+xml" }, 400],
    [{ imageBase64: "not base64" }, 400],
    [{ imageBase64: {} }, 400],
    [{ ticker: {} }, 400],
    [{ imageBase64: Buffer.alloc(3 * 1024 * 1024 + 1).toString("base64") }, 413],
  ]) {
    const res = response();
    await imageHandler({ method: "POST", headers, body: { ...imageInput, ...patch } }, res);
    assert.equal(res.code, expectedStatus);
  }
});

test("complete chart analysis validates its shape and returns ticker context", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-09-28T09:00:00Z") });
  const headers = setup(t);
  globalThis.fetch = async (_url, options) => {
    const request = JSON.parse(options.body);
    assert.equal(request.messages[0].content[0].source.media_type, "image/png");
    return { ok: true, json: async () => ({ stop_reason: "end_turn", content: [{ type: "text", text: JSON.stringify(chartAnalysis) }] }) };
  };
  const res = response();
  // A 3 MiB binary image expands to 4 MiB base64 and stays below Vercel's 4.5 MB payload cap.
  await imageHandler({ method: "POST", headers, body: { ...imageInput, ticker: " nvda ", imageBase64: Buffer.alloc(3 * 1024 * 1024).toString("base64") } }, res);
  assert.equal(res.code, 200);
  assert.equal(res.data.ticker, "NVDA");
  assert.equal(res.data.confidence, 50);
});

test("paused, truncated, or invalid chart analysis cannot produce accepted output", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-09-28T09:00:00Z") });
  const headers = setup(t);
  for (const [stopReason, value] of [
    ["pause_turn", chartAnalysis], ["max_tokens", chartAnalysis],
    ["end_turn", { confidence: 50 }],
    ["end_turn", { ...chartAnalysis, confidence: 999 }],
    ["end_turn", { ...chartAnalysis, price_detected: -1 }],
    ["end_turn", { ...chartAnalysis, amd_phase: "unknown" }],
  ]) {
    globalThis.fetch = async () => ({ ok: true, json: async () => ({ stop_reason: stopReason, content: [{ type: "text", text: JSON.stringify(value) }] }) });
    const res = response();
    await imageHandler({ method: "POST", headers, body: imageInput }, res);
    assert.equal(res.code, 502);
    assert.equal(res.data.confidence, undefined);
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

test("new Supabase secret keys use apikey without an invalid JWT bearer header", async (t) => {
  const headers = setup(t);
  process.env.SUPABASE_SECRET_KEY = "sb_secret_test_only";
  globalThis.fetch = async (url, options) => {
    assert.equal(options.headers.apikey, "sb_secret_test_only");
    assert.equal(options.headers.Authorization, undefined);
    return { ok: true, json: async () => [] };
  };
  const res = response();
  await tradesHandler({ method: "GET", headers }, res);
  assert.equal(res.code, 200);
});

test("real trade closes with direction-aware net percentage and R after fees", async (t) => {
  const headers = setup(t);
  const record = createRealTradeRecord({
    analysis: { ticker: "NVDA", horizon: "1–5 handelsdagar", market: "usa", record: { trade_id: "NVDA-analysis", strategy_version: "v-test" } },
    direction: "LONG", entryPrice: "100", stopLoss: "95", target: "110", positionSize: "2", fees: "1",
  }, { now: new Date("2026-09-20T12:00:00Z"), id: "actual" });
  assert.equal(record.trade_status, "OPEN");
  assert.equal(record.signal_inputs.record_type, "REAL_TRADE");
  let stored = record;
  globalThis.fetch = async (url, options = {}) => {
    assert.ok(url.startsWith("https://example.invalid/rest/v1/trades?"));
    if (options.method === "PATCH") {
      Object.assign(stored, JSON.parse(options.body));
      return { ok: true, json: async () => [stored] };
    }
    return { ok: true, json: async () => [stored] };
  };
  const res = response();
  await tradesHandler({ method: "PATCH", headers, body: { trade_id: record.trade_id, exit_price: 110, fees: 1, exit_reason: "TARGET" } }, res);
  assert.equal(res.code, 200);
  assert.equal(res.data.trade.result_percent, 9);
  assert.equal(res.data.trade.result_r, 1.8);
  assert.equal(res.data.trade.winner, true);
  assert.equal(res.data.trade.signal_inputs.total_actual_fees, 2);

  const shortRecord = createRealTradeRecord({
    analysis: { ticker: "NVDA", record: { trade_id: "NVDA-analysis" } },
    direction: "SHORT", entryPrice: 50, stopLoss: 55, target: 40, positionSize: 3,
  }, { id: "short" });
  stored = shortRecord;
  const shortClose = response();
  await tradesHandler({ method: "PATCH", headers, body: { trade_id: shortRecord.trade_id, exit_price: 40, fees: 0, exit_reason: "TARGET" } }, shortClose);
  assert.equal(shortClose.data.trade.result_percent, 20);
  assert.equal(shortClose.data.trade.result_r, 2);

  const flatRecord = createRealTradeRecord({
    analysis: { ticker: "NVDA" }, direction: "LONG", entryPrice: 100,
    stopLoss: 95, target: 110, positionSize: 2, fees: 1,
  }, { id: "flat" });
  stored = flatRecord;
  const flatClose = response();
  await tradesHandler({ method: "PATCH", headers, body: { trade_id: flatRecord.trade_id, exit_price: 101, fees: 1, exit_reason: "MANUAL" } }, flatClose);
  assert.equal(flatClose.data.trade.result_percent, 0);
  assert.equal(flatClose.data.trade.winner, null);
});

test("real trade record validates side, prices and size", () => {
  const analysisInput = { analysis: { ticker: "NVDA" }, direction: "LONG", entryPrice: 100, stopLoss: 95, target: 110, positionSize: 2 };
  assert.throws(() => createRealTradeRecord({ ...analysisInput, direction: "BUY" }), /lång eller kort/);
  assert.throws(() => createRealTradeRecord({ ...analysisInput, stopLoss: 101 }), /risksidan/);
  assert.throws(() => createRealTradeRecord({ ...analysisInput, positionSize: null }), /positionsstorlek/);
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
  assert.equal(blocked.data.code, "PREVIEW_READ_ONLY");
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

test("journal timeout returns an explicit gateway timeout", async (t) => {
  const headers = setup(t);
  globalThis.fetch = async () => { throw new DOMException("Timed out", "TimeoutError"); };
  const res = response();
  await tradesHandler({ method: "GET", headers }, res);
  assert.equal(res.code, 504);
  assert.match(res.data.message, /12 sekunder/);
});
