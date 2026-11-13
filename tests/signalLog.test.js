import test from "node:test";
import assert from "node:assert/strict";
import { READINESS_VERSION } from "../src/analysisModel.js";
import { SWING_STRATEGY_VERSION, assessSwingSetup } from "../src/strategyModel.js";
import { getMarketStatus } from "../api/_market-hours.js";
import { validateMarketBars } from "../api/_market-data-validation.js";
import { createPaperObservation, settlePaperObservation } from "../src/paperModel.js";
import {
  SIGNAL_STORAGE_KEY, SIGNAL_LOG_FORMAT, signalFromAnalysis, signalFromScanItem,
  validateSignalEntry, encodeSignalLog, decodeSignalLog, loadSignalLog, mergeSignals, appendSignalLog, attachPaperOutcomes,
} from "../src/signalLog.js";

const plan = { setup: "BREAKOUT", entry_reference: 100, stop: 95, target: 110, risk_per_share: 5, theoretical_risk_reward: 2 };
const capturedAt = "2026-11-12T22:00:00.000Z";
const sourceFetchedAt = "2026-11-12T21:59:00.000Z";
const candle = { datetime: "2026-11-12", open: 99, high: 101, low: 98, close: 100, volume: 1_000_000 };
function manual() {
  return {
    ticker: "TEST", market: "usa", horizonCode: "week", decision: { version: READINESS_VERSION, status: "TRADE" },
    strategy: { version: SWING_STRATEGY_VERSION, status: "WATCH", setups: ["BREAKOUT"], plans: [plan], metrics: { latest_closed_candle: candle.datetime } },
    marketData: { ticker: "TEST", exchange: "NASDAQ", currency: "USD", fetched_at: sourceFetchedAt, validation: { valid: true }, bars: [candle] },
  };
}
function scan() {
  return {
    symbol: "TEST", exchange: "NASDAQ", currency: "USD", status: "TRADE", decision: { version: READINESS_VERSION, status: "TRADE" },
    swing_strategy_version: SWING_STRATEGY_VERSION, screening_selection: { latest_closed_datetime: candle.datetime },
    screening_setups: ["BREAKOUT"], screening_plans: [plan], primary_setup: "BREAKOUT", signal_plan: plan,
    data_snapshot: { fetched_at: sourceFetchedAt, bars: [candle] },
  };
}
function memoryStorage() {
  const values = new Map();
  return { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), values };
}
const lock = { request: async (_name, _options, callback) => callback() };

test("manual and scanner TRADE produce one immutable, roundtrippable signal", () => {
  const fromManual = signalFromAnalysis(manual(), capturedAt);
  const fromScan = signalFromScanItem(scan(), { market: "usa", horizon: "week", capturedAt });
  assert.equal(validateSignalEntry(fromManual), true);
  assert.equal(validateSignalEntry(fromScan), true);
  assert.equal(fromManual.id, fromScan.id);
  assert.deepEqual(mergeSignals([fromManual], [fromScan]), [{ ...fromManual, sources: ["MANUAL", "SCAN"] }]);
  const encoded = encodeSignalLog([fromManual]);
  assert.deepEqual(decodeSignalLog(encoded), [fromManual]);
  assert.match(encoded, new RegExp(SIGNAL_LOG_FORMAT));
});

test("non-TRADE decisions do not enter the signal log", () => {
  assert.equal(signalFromAnalysis({ ...manual(), decision: { status: "NO_TRADE" } }), null);
  assert.equal(signalFromScanItem({ ...scan(), status: "NO_TRADE" }, { market: "usa", horizon: "week" }), null);
  assert.throws(() => signalFromAnalysis({ ...manual(), decision: { status: "TRADE", version: "old" } }, capturedAt), /verifierats/);
  assert.throws(() => signalFromScanItem(scan(), { market: "usa", horizon: "day", capturedAt }), /bekräftad/);
});

test("same ticker and session with changed risk plan is a visible conflict", () => {
  const first = signalFromAnalysis(manual(), capturedAt);
  const changed = signalFromScanItem({ ...scan(), screening_plans: [{ ...plan, target: 112 }] }, { market: "usa", horizon: "week", capturedAt });
  assert.throws(() => mergeSignals([first], [changed]), /olika låsta nivåer/);
  assert.equal(validateSignalEntry({ ...first, plans: [{ ...plan, stop: 100 }] }), false);
});

test("locked append deduplicates sources and never overwrites a damaged local log", async () => {
  const storage = memoryStorage();
  const fromScan = signalFromScanItem(scan(), { market: "usa", horizon: "week", capturedAt });
  const fromManual = signalFromAnalysis(manual(), capturedAt);
  assert.deepEqual(await appendSignalLog(storage, lock, [fromScan]), { records: [fromScan], added: 1 });
  const merged = await appendSignalLog(storage, lock, [fromManual]);
  assert.equal(merged.added, 0);
  assert.deepEqual(merged.records[0].sources, ["SCAN", "MANUAL"]);
  assert.equal(storage.getItem(SIGNAL_STORAGE_KEY), encodeSignalLog(merged.records));
  storage.setItem(SIGNAL_STORAGE_KEY, "{bad json");
  await assert.rejects(() => appendSignalLog(storage, lock, [fromScan]), /giltig JSON/);
  assert.equal(storage.getItem(SIGNAL_STORAGE_KEY), "{bad json");
  assert.throws(() => loadSignalLog(storage), /giltig JSON/);
});

test("a later paper simulation attaches an outcome without turning the signal into an order", async () => {
  const date = "2026-09-28";
  const capturedAt = `${date}T21:00:00.000Z`;
  const dates = [];
  let day = Date.parse(`${date}T00:00:00Z`);
  while (dates.length < 100) {
    if (![0, 6].includes(new Date(day).getUTCDay())) dates.unshift(new Date(day).toISOString().slice(0, 10));
    day -= 86_400_000;
  }
  const bars = dates.map((datetime, index) => {
    const close = 50 + index;
    return { datetime, open: close - 0.3, high: close + 0.5, low: close - 0.5, close, volume: index === 99 ? 1_500_000 : 1_000_000 };
  });
  const marketData = {
    ticker: "TEST", exchange: "NASDAQ", currency: "USD", timezone: "America/New_York", interval: "1day",
    fetched_at: "2026-09-28T20:59:00.000Z", bars, validation: validateMarketBars(bars),
  };
  const at = Date.parse(capturedAt);
  const analysis = {
    ticker: "TEST", market: "usa", horizon: "1–5 handelsdagar (swingtrading)", horizonCode: "week",
    marketData, decision: { version: READINESS_VERSION, status: "TRADE" },
    strategy: assessSwingSetup(marketData, { ticker: "TEST", marketStatus: getMarketStatus("usa", new Date(at)), now: at }),
    record: { trade_id: "TEST-paper-example", signal_inputs: { record_type: "ANALYSIS" } },
  };
  const signal = signalFromAnalysis(analysis, capturedAt);
  const paper = createPaperObservation(analysis, { setup: "BREAKOUT", holdingSessions: 1, quantity: 1, feePerOrder: 0, slippageBps: 0, recordedAt: at });
  const nextOpen = paper.plan.entry_reference;
  const future = { datetime: "2026-09-29", open: nextOpen, high: nextOpen + 0.05, low: nextOpen - 0.05, close: nextOpen + 0.05, volume: 1_000_000 };
  const followup = { ...marketData, fetched_at: "2026-09-29T21:00:00.000Z", bars: [...bars, future] };
  const settled = settlePaperObservation(paper, followup, { now: Date.parse("2026-09-29T21:01:00.000Z") });
  assert.equal(settled.status, "CLOSED");
  const storage = memoryStorage();
  await appendSignalLog(storage, lock, [signal]);
  assert.equal(await attachPaperOutcomes(storage, lock, [settled]), 1);
  const linked = loadSignalLog(storage)[0];
  assert.equal(linked.outcomes.BREAKOUT.kind, "SIMULATED");
  assert.equal(linked.outcomes.BREAKOUT.status, "CLOSED");
  assert.equal(linked.outcomes.BREAKOUT.paperId, paper.id);
  assert.equal(await attachPaperOutcomes(storage, lock, [settled]), 0);
});
