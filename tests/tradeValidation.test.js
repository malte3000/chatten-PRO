import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import tradesHandler from "../api/trades.js";
import { createAnalysisRecord, createRealTradeRecord } from "../src/analysisModel.js";

function response() {
  return { code: 200, status(code) { this.code = code; return this; }, json(data) { this.data = data; return this; } };
}

function setup(t) {
  const keys = ["APP_LOGIN_PASSWORD", "SUPABASE_URL", "SUPABASE_SECRET_KEY", "VERCEL_ENV", "PREVIEW_ALLOW_WRITES"];
  const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  const savedFetch = globalThis.fetch;
  process.env.APP_LOGIN_PASSWORD = "validation-test-password";
  process.env.SUPABASE_URL = "https://example.invalid";
  process.env.SUPABASE_SECRET_KEY = "sb_secret_validation_test";
  delete process.env.VERCEL_ENV;
  delete process.env.PREVIEW_ALLOW_WRITES;
  t.after(() => {
    globalThis.fetch = savedFetch;
    for (const key of keys) if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key];
  });
  const payload = Buffer.from(JSON.stringify({ exp: Date.now() + 60000 })).toString("base64url");
  const signature = crypto.createHmac("sha256", process.env.APP_LOGIN_PASSWORD).update(payload).digest("base64url");
  return { cookie: `chatten_pro_session=${payload}.${signature}` };
}

function realTrade(direction = "LONG") {
  return createRealTradeRecord({
    analysis: { ticker: "NVDA" }, direction, entryPrice: 100,
    stopLoss: direction === "LONG" ? 95 : 105,
    target: direction === "LONG" ? 110 : 90,
    positionSize: 2, fees: 1,
  }, { id: "validation" });
}

test("POST accepts valid manual LONG and SHORT trades without changing observation records", async (t) => {
  const headers = setup(t);
  const records = [realTrade(), realTrade("SHORT"), createAnalysisRecord({ ticker: "NVDA" }, { id: "analysis" })];
  records.push({ ...records[2], trade_id: "scan", signal_inputs: { record_type: "SCAN" } });
  let calls = 0;
  globalThis.fetch = async (_url, options) => {
    calls++;
    assert.equal(options.method, "POST");
    assert.equal(options.headers.Authorization, undefined);
    return { ok: true, json: async () => [JSON.parse(options.body)] };
  };
  for (const record of records) {
    const res = response();
    await tradesHandler({ method: "POST", headers, body: record }, res);
    assert.equal(res.code, 201);
    assert.deepEqual(res.data.trade, JSON.parse(JSON.stringify(record)));
  }
  assert.equal(calls, records.length);
});

test("POST rejects invalid manual trade values before contacting Supabase", async (t) => {
  const headers = setup(t);
  globalThis.fetch = async () => { assert.fail("invalid trades must not be inserted"); };
  const mutations = [
    { entry_price: 0 }, { entry_price: "100" }, { entry_price: true },
    { position_size: 0 }, { position_size: Infinity }, { position_size: 1e308 },
    { direction: "NONE" }, { signal: "SELL" },
    { stop_loss: 100 }, { stop_loss: 101 }, { target: 99 },
    { signal_inputs: { record_type: "REAL_TRADE", actual_entry_fees: -1 } },
    { signal_inputs: { record_type: "REAL_TRADE", actual_entry_fees: "invalid" } },
    { signal_inputs: { record_type: "REAL_TRADE", actual_entry_fees: null } },
    { trade_status: "CLOSED" }, { winner: true },
  ];
  for (const mutation of mutations) {
    const res = response();
    await tradesHandler({ method: "POST", headers, body: { ...realTrade(), ...mutation } }, res);
    assert.equal(res.code, 400, JSON.stringify(mutation));
    assert.equal(res.data.error, "Ogiltig verklig trade");
  }
  for (const mutation of [{ stop_loss: 99 }, { target: 101 }]) {
    const res = response();
    await tradesHandler({ method: "POST", headers, body: { ...realTrade("SHORT"), ...mutation } }, res);
    assert.equal(res.code, 400);
  }
});

test("PATCH rejects corrupt stored entry fees instead of writing a NaN result", async (t) => {
  const headers = setup(t);
  for (const entryFees of ["broken", null, false, -1, Infinity]) {
    const stored = realTrade();
    stored.signal_inputs.actual_entry_fees = entryFees;
    let calls = 0;
    globalThis.fetch = async (_url, options = {}) => {
      calls++;
      assert.notEqual(options.method, "PATCH");
      return { ok: true, json: async () => [stored] };
    };
    const res = response();
    await tradesHandler({ method: "PATCH", headers, body: { trade_id: stored.trade_id, exit_price: 110, fees: 1, exit_reason: "TARGET" } }, res);
    assert.equal(res.code, 409);
    assert.match(res.data.error, /ingångsavgifter/);
    assert.equal(calls, 1);
  }
});

test("PATCH only calculates R from a valid stop on the risk side", async (t) => {
  const headers = setup(t);
  for (const [direction, stop] of [["LONG", 105], ["LONG", 100], ["SHORT", 95], ["SHORT", "broken"]]) {
    const stored = { ...realTrade(direction), stop_loss: stop };
    globalThis.fetch = async (_url, options = {}) => {
      assert.notEqual(options.method, "PATCH");
      return { ok: true, json: async () => [stored] };
    };
    const res = response();
    await tradesHandler({ method: "PATCH", headers, body: { trade_id: stored.trade_id, exit_price: 110, exit_reason: "MANUAL" } }, res);
    assert.equal(res.code, 409);
    assert.match(res.data.error, /risksidan/);
  }
});

test("PATCH preserves older numeric fees and closes a trade without a stop with no R", async (t) => {
  const headers = setup(t);
  for (const entryFees of [undefined, "2.5"]) {
    const stored = { ...realTrade(), stop_loss: null };
    if (entryFees === undefined) delete stored.signal_inputs.actual_entry_fees;
    else stored.signal_inputs.actual_entry_fees = entryFees;
    globalThis.fetch = async (_url, options = {}) => ({
      ok: true, json: async () => [options.method === "PATCH" ? { ...stored, ...JSON.parse(options.body) } : stored],
    });
    const res = response();
    await tradesHandler({ method: "PATCH", headers, body: { trade_id: stored.trade_id, exit_price: 110, fees: 1, exit_reason: "TARGET" } }, res);
    assert.equal(res.code, 200);
    assert.equal(res.data.trade.result_r, null);
    assert.equal(res.data.trade.signal_inputs.net_pnl, entryFees === undefined ? 19 : 16.5);
  }
});

test("PATCH rejects boolean prices and invalid fees before contacting Supabase", async (t) => {
  const headers = setup(t);
  globalThis.fetch = async () => { assert.fail("invalid close inputs must not reach Supabase"); };
  for (const mutation of [{ exit_price: true }, { fees: null }, { fees: false }, { fees: " " }, { fees: "invalid" }]) {
    const res = response();
    await tradesHandler({ method: "PATCH", headers, body: { trade_id: "NVDA-validation", exit_price: 110, fees: 1, exit_reason: "TARGET", ...mutation } }, res);
    assert.equal(res.code, 400);
  }
});
