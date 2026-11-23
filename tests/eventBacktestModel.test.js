import test from "node:test";
import assert from "node:assert/strict";
import { runEventBacktest, EVENT_BACKTEST_VERSION } from "../src/eventBacktestModel.js";

const day = (index) => `2025-01-${String(index + 1).padStart(2, "0")}`;
function dataset(overrides = {}, length = 12) {
  const bars = Array.from({ length }, (_, index) => ({
    datetime: day(index), open: 100, high: 102, low: 98, close: 100, volume: 1000,
  }));
  for (const [index, patch] of Object.entries(overrides)) Object.assign(bars[Number(index)], patch);
  return { ticker: "TEST", currency: "USD", bars };
}

test("target hit is evaluated only after next-open entry", () => {
  const data = dataset({
    2: { high: 200 }, // Signal-day prices must not settle the event.
    3: { open: 100, high: 106, low: 99, close: 104 },
  });
  const report = runEventBacktest({ datasets: [data], events: [{ datasetIndex: 0, signalIndex: 2, signalDate: day(2) }], horizon: 3 });
  assert.equal(report.version, EVENT_BACKTEST_VERSION);
  assert.equal(report.status, "COMPLETED");
  assert.equal(report.results[0].entryIndex, 3);
  assert.equal(report.results[0].outcome, "TARGET_FIRST");
  assert.equal(report.results[0].exit, 105);
  assert.equal(report.metrics.outcomeProbabilities.TARGET_FIRST.estimate, 1);
});

test("same daily bar target and stop is a tie by default", () => {
  const data = dataset({ 3: { open: 100, high: 110, low: 90, close: 101 } });
  const report = runEventBacktest({ datasets: [data], events: [{ datasetIndex: 0, signalIndex: 2 }], horizon: 2 });
  const result = report.results[0];
  assert.equal(result.outcome, "TIE");
  assert.equal(result.ambiguous, true);
  assert.equal(result.netPnl, null);
  assert.equal(report.metrics.financialSampleSize, 0);
  assert.equal(report.metrics.outcomeCounts.TIE, 1);
});

test("conservative ambiguity policy resolves to stop first", () => {
  const data = dataset({ 3: { open: 100, high: 110, low: 90, close: 101 } });
  const report = runEventBacktest({ datasets: [data], events: [{ datasetIndex: 0, signalIndex: 2 }], horizon: 2, ambiguousPolicy: "STOP_FIRST" });
  assert.equal(report.results[0].outcome, "STOP_FIRST");
  assert.equal(report.results[0].exit, 97);
  assert.equal(report.results[0].netPnl, -3);
});

test("stop gaps use the worse opening while target gaps assume no improvement", () => {
  const stopData = dataset({ 3: { open: 100, high: 102, low: 98, close: 100 }, 4: { open: 90, high: 92, low: 88, close: 91 } });
  const targetData = dataset({ 3: { open: 100, high: 102, low: 98, close: 100 }, 4: { open: 110, high: 112, low: 108, close: 111 } });
  const report = runEventBacktest({
    datasets: [stopData, { ...targetData, ticker: "TWO" }],
    events: [{ datasetIndex: 0, signalIndex: 2 }, { datasetIndex: 1, signalIndex: 2 }], horizon: 2,
  });
  assert.equal(report.results[0].outcome, "STOP_FIRST");
  assert.equal(report.results[0].exit, 90);
  assert.equal(report.results[1].outcome, "TARGET_FIRST");
  assert.equal(report.results[1].entry, 100);
  assert.equal(report.results[1].exit, 105);
});

test("fees, spread and slippage adversely affect both executions", () => {
  const data = dataset({
    3: { open: 100, high: 102, low: 99, close: 101 },
    4: { open: 101, high: 103, low: 100, close: 102 },
  });
  const report = runEventBacktest({
    datasets: [data], events: [{ datasetIndex: 0, signalIndex: 2 }],
    targetPct: 50, stopPct: 50, horizon: 2, quantity: 2,
    feePerOrder: 1, slippageBps: 10, spreadBps: 20,
  });
  const result = report.results[0];
  assert.equal(result.outcome, "TIME_EXIT");
  assert.equal(result.entry, 100.2);
  assert.equal(result.exit, 101.796);
  assert.equal(result.grossPnl, 3.192);
  assert.equal(result.totalFees, 2);
  assert.equal(result.netPnl, 1.192);
});

test("short side applies direction-aware target, stop, gap and PnL", () => {
  const winner = dataset({ 3: { open: 100, high: 101, low: 94, close: 95 } });
  const loser = { ...dataset({ 3: { open: 100, high: 102, low: 98, close: 100 }, 4: { open: 105, high: 106, low: 104, close: 105 } }), ticker: "SHORT2" };
  const report = runEventBacktest({
    datasets: [winner, loser], events: [{ datasetIndex: 0, signalIndex: 2 }, { datasetIndex: 1, signalIndex: 2 }],
    side: "SHORT", horizon: 2,
  });
  assert.equal(report.results[0].target, 95);
  assert.equal(report.results[0].stop, 103);
  assert.equal(report.results[0].outcome, "TARGET_FIRST");
  assert.equal(report.results[0].netPnl, 5);
  assert.equal(report.results[1].outcome, "STOP_FIRST");
  assert.equal(report.results[1].entry, 100);
  assert.equal(report.results[1].exit, 105);
  assert.ok(report.results[1].netPnl < 0);
});

test("incomplete future horizon is not assessed and never uses a partial result", () => {
  const data = dataset({}, 5);
  const report = runEventBacktest({ datasets: [data], events: [{ datasetIndex: 0, signalIndex: 2 }], horizon: 3 });
  assert.equal(report.status, "NOT_ASSESSED");
  assert.equal(report.results[0].status, "NOT_ASSESSED");
  assert.match(report.results[0].reasons[0], /fullständig framtida/);
  assert.equal(report.metrics.assessedEventCount, 0);
});

test("prices beyond the requested horizon cannot change an earlier result", () => {
  const original = dataset({ 3: { close: 101 }, 4: { close: 102 } });
  const changed = structuredClone(original);
  Object.assign(changed.bars[8], { open: 1, high: 1000, low: 1, close: 900 });
  const event = [{ datasetIndex: 0, signalIndex: 2 }];
  const a = runEventBacktest({ datasets: [original], events: event, targetPct: 50, stopPct: 50, horizon: 2 });
  const b = runEventBacktest({ datasets: [changed], events: event, targetPct: 50, stopPct: 50, horizon: 2 });
  assert.deepEqual(a.results, b.results);
});

test("identity mismatches, duplicates and malformed bars fail closed", () => {
  const data = dataset({ 4: { low: 110, high: 100 } });
  const report = runEventBacktest({
    datasets: [data], horizon: 3,
    events: [
      { datasetIndex: 0, ticker: "WRONG", signalIndex: 2 },
      { datasetIndex: 0, signalIndex: 1, signalDate: day(2) },
      { datasetIndex: 0, signalIndex: 2 },
      { datasetIndex: 0, signalIndex: 2 },
    ],
  });
  assert.deepEqual(report.results.map((item) => item.status), ["NOT_ASSESSED", "NOT_ASSESSED", "NOT_ASSESSED", "REJECTED"]);
  assert.equal(report.status, "NOT_ASSESSED");
});

test("results are deterministic, inputs immutable, and overlap is disclosed", () => {
  const data = dataset({}, 12);
  const inputs = {
    datasets: [data],
    events: [{ datasetIndex: 0, signalIndex: 1 }, { datasetIndex: 0, signalIndex: 2 }],
    targetPct: 50, stopPct: 50, horizon: 4,
  };
  const before = structuredClone(inputs);
  const first = runEventBacktest(inputs);
  const second = runEventBacktest(inputs);
  assert.deepEqual(first, second);
  assert.deepEqual(inputs, before);
  assert.equal(first.dependence.overlappingEventPairs, 1);
  assert.equal(first.dependence.eventsInOverlappingWindows, 2);
});

test("metrics include intervals, expectancy, drawdown and period stability", () => {
  const win = dataset({ 3: { high: 106, low: 99 } });
  const loss = { ...dataset({ 3: { high: 101, low: 96 } }), ticker: "LOSS" };
  const report = runEventBacktest({
    datasets: [win, loss],
    events: [
      { datasetIndex: 0, signalIndex: 2, metadata: { period: "validation" } },
      { datasetIndex: 1, signalIndex: 2, metadata: { period: "validation" } },
    ], horizon: 2, feePerOrder: 0.5,
  });
  assert.deepEqual(report.metrics.outcomeCounts, { TARGET_FIRST: 1, STOP_FIRST: 1, TIE: 0, TIME_EXIT: 0 });
  assert.equal(report.metrics.outcomeProbabilities.TARGET_FIRST.sampleSize, 2);
  assert.ok(report.metrics.outcomeProbabilities.TARGET_FIRST.lower > 0);
  assert.equal(report.metrics.financialSampleSize, 2);
  assert.equal(report.metrics.totalFees, 2);
  assert.ok(report.metrics.maxRealizedDrawdown > 0);
  assert.equal(report.metrics.stability[0].period, "validation");
  assert.equal(report.metrics.stability[0].eventCount, 2);
});

test("invalid top-level parameters return an explicit invalid report", () => {
  assert.equal(runEventBacktest().status, "INVALID");
  assert.equal(runEventBacktest({ datasets: [], events: [], horizon: 0 }).status, "INVALID");
  assert.equal(runEventBacktest({ datasets: [], events: [], side: "BOTH" }).status, "INVALID");
  assert.equal(runEventBacktest({ datasets: [], events: [], ambiguousPolicy: "TARGET_FIRST" }).status, "INVALID");
});

test("overflowing money assumptions never produce a completed non-finite trade", () => {
  const data = dataset({ 1: { high: 200, close: 150 } }, 4);
  const report = runEventBacktest({
    datasets: [data], events: [{ datasetIndex: 0, signalIndex: 0 }],
    horizon: 2, targetPct: 99, quantity: Number.MAX_VALUE, feePerOrder: 0,
  });
  assert.equal(report.status, "NOT_ASSESSED");
  assert.equal(report.results[0].status, "NOT_ASSESSED");
  assert.match(report.results[0].reasons[0], /icke-finit/);
});
