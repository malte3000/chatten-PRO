import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import handler from "../api/scan.js";

function response() { return { code: 200, headers: {}, setHeader(key, value) { this.headers[key] = value; }, status(code) { this.code = code; return this; }, json(data) { this.data = data; return this; } }; }
function setup(t) {
  const originalFetch = globalThis.fetch;
  const keys = ["APP_LOGIN_PASSWORD", "TWELVE_DATA_API_KEY", "SCAN_BATCH_SIZE"];
  const original = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  process.env.APP_LOGIN_PASSWORD = "test-only-password";
  process.env.TWELVE_DATA_API_KEY = "test-only-key";
  process.env.SCAN_BATCH_SIZE = "4";
  t.after(() => { globalThis.fetch = originalFetch; for (const key of keys) { if (original[key] === undefined) delete process.env[key]; else process.env[key] = original[key]; } });
  const payload = Buffer.from(JSON.stringify({ exp: Date.now() + 60000 })).toString("base64url");
  const signature = crypto.createHmac("sha256", process.env.APP_LOGIN_PASSWORD).update(payload).digest("base64url");
  return { cookie: `chatten_pro_session=${payload}.${signature}` };
}
const body = { market: "usa", horizon: "week", offset: 0, limit: 20, seed: "2026-09-16" };

test("scan requires auth and validates market and bounds before provider calls", async (t) => {
  const headers = setup(t);
  globalThis.fetch = async () => { throw new Error("must not be called"); };
  const unauth = response(); await handler({ method: "POST", headers: {}, body }, unauth);
  assert.equal(unauth.code, 401);
  for (const invalid of [{ ...body, market: "off" }, { ...body, limit: 101 }, { ...body, offset: -1 }, { ...body, horizon: "unknown" }]) {
    const res = response(); await handler({ method: "POST", headers, body: invalid }, res); assert.equal(res.code, 400);
  }
});
test("scanner selects provider instruments, excludes unsupported products and throttles subsequent batches", async (t) => {
  const headers = setup(t);
  let timeCalls = 0;
  globalThis.fetch = async (url) => {
    const request = new URL(url);
    if (request.pathname === "/stocks") {
      assert.equal(request.searchParams.get("country"), "United States");
      return { ok: true, json: async () => ({ data: [
        { symbol: "NVDA", exchange: "NASDAQ", country: "United States", currency: "USD", type: "Common Stock" },
        { symbol: "CERT", exchange: "NASDAQ", country: "United States", currency: "USD", type: "Structured Product" },
        { symbol: "OTC", exchange: "OTC", country: "United States", currency: "USD", type: "Common Stock" },
      ] }) };
    }
    timeCalls++;
    assert.equal(request.searchParams.get("symbol"), "NVDA:NASDAQ");
    assert.equal(request.searchParams.get("timezone"), "UTC");
    assert.equal(request.searchParams.get("apikey"), "test-only-key");
    return { ok: true, json: async () => ({ meta: { symbol: "AMD", exchange: "NASDAQ", currency: "USD" }, values: [] }) };
  };
  const res = response(); await handler({ method: "POST", headers, body }, res);
  assert.equal(res.code, 200);
  assert.equal(res.data.universe_size, 1);
  assert.equal(res.data.results[0].status, "NOT_ASSESSED");
  assert.equal(res.data.results[0].data_issue, "IDENTITY_MISMATCH");
  assert.equal(res.data.done, true);
  assert.equal(JSON.stringify(res.data).includes("test-only-key"), false);
  const repeated = response(); await handler({ method: "POST", headers, body }, repeated);
  assert.equal(repeated.code, 429);
  assert.ok(repeated.data.retry_after_ms > 0);
  assert.equal(timeCalls, 1);
});

test("Swedish scan excludes obvious products and separates valid candidates from unavailable data", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() + 120000 });
  const headers = setup(t);
  const clock = Date.now();
  globalThis.fetch = async (url) => {
    const request = new URL(url);
    if (request.pathname === "/stocks") return { ok: true, json: async () => ({ data: [
      { symbol: "DEMO", exchange: "OMX", mic_code: "XSTO", country: "Sweden", currency: "SEK", type: "Common Stock" },
      { symbol: "OTHER", exchange: "OMX", mic_code: "XSTO", country: "Sweden", currency: "SEK", type: "Common Stock" },
      { symbol: "BULL.EVO.X6.AVA.4", exchange: "OMX", mic_code: "XSTO", country: "Sweden", currency: "SEK", type: "Common Stock" },
      { symbol: "MINI.L.WDC.AVA.01", exchange: "OMX", mic_code: "XSTO", country: "Sweden", currency: "SEK", type: "Common Stock" },
    ] }) };
    assert.deepEqual(new Set(request.searchParams.get("symbol").split(",")), new Set(["DEMO:OMX", "OTHER:OMX"]));
    const values = Array.from({ length: 100 }, (_, index) => {
      const close = 50 + index;
      return { datetime: new Date(clock - (100 - index) * 86400000).toISOString().slice(0, 10), open: String(close - 0.5), high: String(close + 1), low: String(close - 1), close: String(index === 99 ? close + 0.5 : close), volume: index === 99 ? "2000000" : "1000000" };
    }).reverse();
    return { ok: true, json: async () => ({
      "DEMO:OMX": { meta: { symbol: "DEMO", exchange: "OMX", currency: "SEK", exchange_timezone: "Europe/Stockholm" }, values },
      "OTHER:OMX": { status: "error", code: 403, message: "Provider access denied" },
    }) };
  };
  const res = response();
  await handler({ method: "POST", headers, body: { ...body, market: "stockholm" } }, res);
  assert.equal(res.code, 200);
  assert.equal(res.data.universe_size, 2);
  const candidate = res.data.results.find((item) => item.symbol === "DEMO");
  const unavailable = res.data.results.find((item) => item.symbol === "OTHER");
  assert.equal(candidate.status, "WAIT");
  assert.deepEqual(candidate.screening_setups, ["BREAKOUT"]);
  assert.equal(candidate.metrics.rvol, 2);
  assert.equal(candidate.metrics.atr, 2);
  assert.equal(candidate.currency, "SEK");
  assert.equal(candidate.data_snapshot.bars.length, 100);
  assert.equal(candidate.data_snapshot.timestamp_timezone, "Europe/Stockholm");
  assert.equal(candidate.data_snapshot.timestamp_kind, "exchange_session_date");
  assert.equal(candidate.data_snapshot.screening_selection.latest_closed_datetime, candidate.data_snapshot.bars.at(-1).datetime);
  assert.equal(unavailable.status, "NOT_ASSESSED");
  assert.equal(unavailable.data_issue, "PROVIDER_REJECTED");
  assert.equal(unavailable.metrics, null);
});

test("Swedish scan aborts after first wholly unassessed batch without claiming NO TRADE", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() + 240000 });
  const headers = setup(t);
  let timeCalls = 0;
  globalThis.fetch = async (url) => {
    if (new URL(url).pathname === "/stocks") return { ok: true, json: async () => ({ data: [
      { symbol: "DEMO", exchange: "OMX", mic_code: "XSTO", country: "Sweden", currency: "SEK", type: "Common Stock" },
      { symbol: "OTHER", exchange: "OMX", mic_code: "XSTO", country: "Sweden", currency: "SEK", type: "Common Stock" },
    ] }) };
    timeCalls++;
    return { ok: true, json: async () => ({
      "DEMO:OMX": { status: "error", code: 403 },
      "OTHER:OMX": { status: "error", code: 403 },
    }) };
  };
  const res = response();
  await handler({ method: "POST", headers, body: { ...body, market: "stockholm" } }, res);
  assert.equal(res.code, 502);
  assert.match(res.data.error, /utan tradebedömning/);
  assert.equal(JSON.stringify(res.data).includes("NO_TRADE"), false);
  assert.equal(timeCalls, 1);
});
