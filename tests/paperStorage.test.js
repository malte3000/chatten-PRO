import test from "node:test";
import assert from "node:assert/strict";
import { getMarketStatus } from "../api/_market-hours.js";
import { assessSwingSetup } from "../src/strategyModel.js";
import { createPaperObservation } from "../src/paperModel.js";
import { PAPER_STORAGE_KEY, decodePaperLog, encodePaperLog, loadPaperLog, mergePaperLogs, savePaperLog, updatePaperLog } from "../src/paperStorage.js";

function observation() {
  const now = Date.parse("2026-09-28T21:00:00Z");
  const dates = [];
  let day = new Date("2026-09-28T00:00:00Z");
  while (dates.length < 100) {
    if (![0, 6].includes(day.getUTCDay())) dates.unshift(day.toISOString().slice(0, 10));
    day = new Date(day.getTime() - 86400000);
  }
  const bars = dates.map((datetime, index) => {
    const close = 50 + index;
    return { datetime, open: close - 0.3, high: close + 0.5, low: close - 0.5, close, volume: index === 99 ? 1_500_000 : 1_000_000 };
  });
  const marketData = { ticker: "TEST", exchange: "NASDAQ", currency: "USD", timezone: "America/New_York", interval: "1day", fetched_at: new Date(now - 60000).toISOString(), bars };
  const analysis = { ticker: "TEST", market: "usa", horizon: "1–5 handelsdagar (swingtrading)", marketData, decision: { status: "WAIT" }, strategy: assessSwingSetup(marketData, { ticker: "TEST", marketStatus: getMarketStatus("usa", new Date(now)), now }), record: { trade_id: "TEST-example-1", signal_inputs: { record_type: "ANALYSIS" } } };
  return createPaperObservation(analysis, { setup: "BREAKOUT", holdingSessions: 3, quantity: 2, feePerOrder: 1, slippageBps: 10, recordedAt: now });
}

function memoryStorage() {
  const values = new Map();
  return { getItem: (key) => values.has(key) ? values.get(key) : null, setItem: (key, value) => { values.set(key, value); }, values };
}

test("a valid local log roundtrips for export and import without changing the observation", () => {
  const record = observation();
  const storage = memoryStorage();
  assert.deepEqual(loadPaperLog(storage), []);
  savePaperLog(storage, [record]);
  assert.deepEqual(loadPaperLog(storage), [record]);
  assert.deepEqual(decodePaperLog(encodePaperLog([record])), [record]);
  assert.match(storage.getItem(PAPER_STORAGE_KEY), /paper-log-v1/);
});

test("malformed, duplicated and tampered imports fail before any local write", () => {
  const record = observation();
  const storage = memoryStorage();
  savePaperLog(storage, [record]);
  const original = storage.getItem(PAPER_STORAGE_KEY);
  const tampered = { ...record, netPnl: 10 };
  for (const input of ["{", JSON.stringify({ format: "unknown", records: [record] }), JSON.stringify({ format: "sannolikhet-paper-log-v1", records: [record, record] }), JSON.stringify({ format: "sannolikhet-paper-log-v1", records: [tampered] })]) {
    assert.throws(() => decodePaperLog(input));
    assert.equal(storage.getItem(PAPER_STORAGE_KEY), original);
  }
  assert.throws(() => savePaperLog(storage, [tampered]));
  assert.equal(storage.getItem(PAPER_STORAGE_KEY), original);
});

test("merge adds disjoint observations, accepts identical copies and blocks conflicting IDs", () => {
  const first = observation();
  const second = { ...first, sourceAnalysisTradeId: "TEST-example-2", id: "paper:TEST-example-2:BREAKOUT" };
  assert.deepEqual(mergePaperLogs([first], [first, second]), [first, second]);
  assert.throws(() => mergePaperLogs([first], [{ ...first, status: "NOT_ASSESSED", assessmentError: "Saknad framtida session." }]));
});

test("a storage write failure propagates and leaves the old log untouched", () => {
  const record = observation();
  const storage = memoryStorage();
  savePaperLog(storage, [record]);
  const old = storage.getItem(PAPER_STORAGE_KEY);
  const failing = { getItem: storage.getItem, setItem() { throw new Error("QuotaExceeded"); } };
  assert.throws(() => savePaperLog(failing, [record]), /QuotaExceeded/);
  assert.equal(storage.getItem(PAPER_STORAGE_KEY), old);
});

test("locked updates read fresh storage so two tabs preserve each other's observations", async () => {
  const first = observation();
  const second = { ...first, sourceAnalysisTradeId: "TEST-example-2", id: "paper:TEST-example-2:BREAKOUT" };
  const storage = memoryStorage();
  const lockManager = { request: async (_name, _options, callback) => callback() };
  const staleTabA = [];
  const staleTabB = [];
  await updatePaperLog(storage, lockManager, (current) => mergePaperLogs(current, [...staleTabA, first]));
  await updatePaperLog(storage, lockManager, (current) => mergePaperLogs(current, [...staleTabB, second]));
  assert.deepEqual(loadPaperLog(storage), [first, second]);
  const original = storage.getItem(PAPER_STORAGE_KEY);
  await assert.rejects(() => updatePaperLog(storage, null, (current) => [...current, second]), /säker lagring mellan flikar/);
  await assert.rejects(() => updatePaperLog(storage, lockManager, () => [first, { ...second, netPnl: 12 }]), /ogiltig observation/);
  assert.equal(storage.getItem(PAPER_STORAGE_KEY), original);
});
