import test from "node:test";
import assert from "node:assert/strict";
import { runSwingReplay } from "../src/backtestModel.js";

// Synthetic weekday prices test execution mechanics, not strategy profitability.
function makeData(count = 66) {
  const dates = [];
  let date = new Date("2026-09-28T00:00:00Z");
  while (dates.length < count) {
    if (![0, 6].includes(date.getUTCDay())) dates.unshift(date.toISOString().slice(0, 10));
    date = new Date(date.getTime() - 86400000);
  }
  return { ticker: "TEST", currency: "USD", exchange: "NASDAQ", timezone: "America/New_York", interval: "1day", bars: dates.map((datetime, index) => {
    const close = 50 + index;
    return { datetime, open: close - 0.3, high: close + 0.5, low: close - 0.5, close, volume: index === 59 ? 1_500_000 : 1_000_000 };
  }) };
}
const options = { market: "usa", setup: "BREAKOUT", holdingSessions: 3, quantity: 2, feePerOrder: 1, slippageBps: 0, asOf: "2026-09-28T22:00:00Z" };
const run = (marketData, extra = {}) => runSwingReplay({ ...options, marketData, ...extra });

test("close signal enters next open, recomputes target/R, and charges both orders", () => {
  const data = makeData();
  const report = run(data);
  assert.equal(report.status, "COMPLETED");
  assert.equal(report.closedTrades.length, 1);
  const trade = report.closedTrades[0];
  assert.equal(trade.signalDate, data.bars[59].datetime);
  assert.equal(trade.entryDate, data.bars[60].datetime);
  assert.equal(trade.entry, data.bars[60].open);
  assert.equal(trade.stop, report.decisions[0].plan.stop);
  assert.equal(trade.target, trade.entry + 2 * (trade.entry - trade.stop));
  assert.equal(trade.holdingBars, 3);
  assert.equal(trade.exitReason, "TIME_EXIT");
  assert.equal(trade.totalFees, 2);
  assert.equal(trade.netPnl, (trade.exit - trade.entry) * 2 - 2);
  assert.equal(trade.resultR, trade.netPnl / ((trade.entry - trade.stop) * 2));
  assert.equal(trade.type, "SIMULATED_TRADE");
});

test("a next-open gap below stop or beyond original target rejects the entry", () => {
  for (const open of [100, 115]) {
    const data = makeData();
    data.bars[60] = { ...data.bars[60], open, low: Math.min(open - 0.5, 109.5), high: Math.max(open + 0.5, 110.5) };
    const report = run(data);
    assert.equal(report.closedTrades.length, 0);
    assert.match(report.rejectedSignals[0].reason, /giltiga prisnivåer/);
  }
});

test("a later stop gap fills at the worse opening price and applies slippage", () => {
  const data = makeData();
  data.bars[61] = { ...data.bars[61], open: 100, close: 101, low: 99, high: 102 };
  const report = run(data, { slippageBps: 10 });
  const trade = report.closedTrades[0];
  assert.equal(trade.exitReason, "STOP_GAP");
  assert.equal(trade.exit, 100 * 0.999);
  assert.equal(trade.entry, data.bars[60].open * 1.001);
  assert.ok(trade.resultR < -1);
});

test("both levels touched in the same bar resolve to stop first", () => {
  const data = makeData();
  data.bars[60] = { ...data.bars[60], low: 100, high: 120 };
  const trade = run(data).closedTrades[0];
  assert.equal(trade.exitReason, "STOP");
  assert.equal(trade.ambiguousBar, true);
  assert.equal(trade.holdingBars, 1);
  assert.equal(trade.exit, trade.stop);
  assert.ok(trade.netPnl < 0);
});

test("target gap does not assume price improvement beyond target", () => {
  const data = makeData();
  data.bars[61] = { ...data.bars[61], open: 120, close: 121, low: 119, high: 122 };
  const trade = run(data).closedTrades[0];
  assert.equal(trade.exitReason, "TARGET_GAP");
  assert.equal(trade.exit, trade.target);
});

test("unclosed final positions are reported separately and excluded from win rate", () => {
  const data = makeData();
  data.bars[59].volume = 1_000_000;
  data.bars[64].volume = 1_500_000;
  const report = run(data, { holdingSessions: 5 });
  assert.equal(report.openTrades.length, 1);
  assert.equal(report.openTrades[0].status, "OPEN");
  assert.equal(report.openTrades[0].netPnl, null);
  assert.equal(report.metrics.tradeCount, 0);
  assert.equal(report.metrics.winRatePercent, null);
});

test("future price changes cannot alter an earlier decision or closed trade; inputs stay intact", () => {
  const data = makeData();
  const before = structuredClone(data);
  const original = run(data);
  assert.deepEqual(data, before);
  const changed = structuredClone(data);
  changed.bars[64] = { ...changed.bars[64], open: 200, close: 201, low: 199, high: 202, volume: 10_000_000 };
  const later = run(changed);
  assert.deepEqual(later.decisions[0], original.decisions[0]);
  assert.deepEqual(later.closedTrades[0], original.closedTrades[0]);
  assert.deepEqual(run(data), original);
});

test("required context rejects weak benchmarks and never sees future benchmark prices", () => {
  const data = makeData();
  const reference = { ...makeData(), ticker: "REF", bars: makeData().bars.map((bar, index) => ({ ...bar, open: 200 - index, high: 201 - index, low: 199 - index, close: 200 - index })) };
  const report = run(data, { marketContextMode: "required", benchmarkData: reference, benchmarkTicker: "REF" });
  assert.equal(report.status, "COMPLETED");
  assert.equal(report.closedTrades.length, 0);
  assert.equal(report.decisions[0].context.status, "BLOCKED");
  reference.bars[65] = { ...reference.bars[65], open: 1000, high: 1001, low: 999, close: 1000 };
  assert.deepEqual(run(data, { marketContextMode: "required", benchmarkData: reference, benchmarkTicker: "REF" }).decisions[0], report.decisions[0]);
});

test("invalid clocks, malformed benchmark and non-finite totals fail safely", () => {
  const data = makeData();
  assert.equal(run(data, { asOf: 1e30 }).status, "INVALID");
  assert.equal(run(data, { quantity: 1e30 }).status, "INVALID");
  assert.equal(run(data, { benchmarkData: { ...data, ticker: "REF", bars: [...data.bars, null] }, benchmarkTicker: "REF", marketContextMode: "required" }).status, "INVALID");
  const many = makeData(90);
  many.bars.forEach((bar, index) => { if (index >= 59) bar.volume = 2_000_000 + index * 1_000_000; });
  const report = run(many, { feePerOrder: 8e307, holdingSessions: 1 });
  assert.equal(report.status, "INVALID");
  assert.match(report.reasons[0], /Summerade/);
  data.bars[20].volume = 0;
  assert.equal(run(data).status, "INVALID");
});
