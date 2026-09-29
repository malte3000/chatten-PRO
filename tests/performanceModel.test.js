import test from "node:test";
import assert from "node:assert/strict";
import { summarizePerformance } from "../src/performanceModel.js";

let nextId = 0;
function closedTrade({ id = `trade-${++nextId}`, strategy = "swing-v1", currency = "USD", direction = "LONG", entry = 100, exit = 110, size = 2, stop = 95, entryFees = 1, exitFees = 1 } = {}) {
  const gross = (exit - entry) * size * (direction === "LONG" ? 1 : -1);
  const net = gross - entryFees - exitFees;
  return {
    trade_id: id, strategy_version: strategy, ticker: "NVDA", trade_status: "CLOSED",
    signal: direction === "LONG" ? "BUY" : "SELL", direction, confidence: 0,
    entry_price: entry, exit_price: exit, position_size: size, stop_loss: stop,
    result_percent: Number((net / (entry * size) * 100).toFixed(8)),
    result_r: stop == null ? null : Number((net / (Math.abs(entry - stop) * size)).toFixed(8)),
    winner: Math.abs(net) < 1e-8 ? null : net > 0,
    signal_inputs: { record_type: "REAL_TRADE", currency, actual_entry_fees: entryFees, actual_exit_fees: exitFees, total_actual_fees: entryFees + exitFees, gross_pnl: gross, net_pnl: Number(net.toFixed(8)) },
  };
}

function approximately(actual, expected) {
  assert.ok(Math.abs(actual - expected) < 1e-8, `${actual} differs from ${expected}`);
}

test("only closed actual trades count; observations, legacy records and open trades cannot inflate performance", () => {
  const actual = closedTrade();
  const rows = [actual,
    { ...closedTrade(), confidence: 100, signal_inputs: { record_type: "ANALYSIS", probability_up: 99 } },
    { ...closedTrade(), signal_inputs: { record_type: "SCAN" } },
    { ...closedTrade(), signal_inputs: null },
    { ...closedTrade(), trade_status: "OPEN" },
  ];
  const summary = summarizePerformance(rows);
  assert.equal(summary.inputCount, 5);
  assert.equal(summary.includedCount, 1);
  assert.equal(summary.closedRealTradeCount, 1);
  assert.equal(summary.openRealTradeCount, 1);
  assert.equal(summary.ignoredCount, 4);
  assert.equal(summary.invalidClosedCount, 0);
  assert.equal(summary.groups[0].totalNetPnl, 18);
  assert.equal(summary.groups[0].netPercent, 9);
  assert.equal(summary.groups[0].averageR, 1.8);
  assert.equal("probability" in summary.groups[0], false);
  assert.deepEqual(summarizePerformance(null).groups, []);
});

test("net fees determine SHORT wins, gross winners that lose after fees, and break-even", () => {
  const rows = [
    closedTrade({ direction: "SHORT", exit: 90, stop: 105 }),
    closedTrade({ exit: 101, entryFees: 2, exitFees: 2 }),
    closedTrade({ exit: 101 }),
  ];
  const group = summarizePerformance(rows).groups[0];
  assert.equal(group.tradeCount, 3);
  assert.equal(group.wins, 1);
  assert.equal(group.losses, 1);
  assert.equal(group.breakEvens, 1);
  approximately(group.winRatePercent, 100 / 3);
  assert.equal(group.totalEntryValue, 600);
  assert.equal(group.totalGrossPnl, 24);
  assert.equal(group.totalEntryFees, 4);
  assert.equal(group.totalExitFees, 4);
  assert.equal(group.totalFees, 8);
  assert.equal(group.totalNetPnl, 16);
  approximately(group.netPercent, 16 / 600 * 100);
  approximately(group.expectancyNetPnl, 16 / 3);
  assert.equal(group.profitFactor, 9);
  approximately(group.averageR, 1.6 / 3);
  assert.equal(group.rTradeCount, 3);
  assert.equal(group.feePaidTradeCount, 3);
  assert.equal(group.feeFreeTradeCount, 0);
});

test("money statistics separate strategy versions and currencies, including pound and pence units", () => {
  const rows = [
    closedTrade({ strategy: "v1", currency: "USD" }),
    closedTrade({ strategy: "v1", currency: "SEK" }),
    closedTrade({ strategy: "v2", currency: "USD" }),
    closedTrade({ strategy: "v1", currency: "GBP" }),
    closedTrade({ strategy: "v1", currency: "GBp" }),
  ];
  const summary = summarizePerformance(rows);
  assert.equal(summary.groups.length, 5);
  for (const group of summary.groups) {
    assert.equal(group.tradeCount, 1);
    assert.equal(group.totalNetPnl, 18);
  }
  assert.equal("totalNetPnl" in summary, false);
});

test("missing, non-finite and contradictory outcomes are excluded with concrete reasons", () => {
  const cases = [
    ["MISSING_STRATEGY", (record) => { record.strategy_version = ""; }],
    ["MISSING_CURRENCY", (record) => { record.signal_inputs.currency = null; }],
    ["INVALID_PRICES_OR_SIZE", (record) => { record.position_size = NaN; }],
    ["INVALID_DIRECTION", (record) => { record.direction = "NONE"; }],
    ["MISSING_OR_INVALID_FEES", (record) => { delete record.signal_inputs.actual_entry_fees; }],
    ["MISSING_OR_INVALID_FEES", (record) => { record.signal_inputs.actual_exit_fees = null; }],
    ["MISSING_OR_INVALID_FEES", (record) => { record.signal_inputs.total_actual_fees = Infinity; }],
    ["INVALID_FEE_TOTAL", (record) => { record.signal_inputs.total_actual_fees = 5; }],
    ["MISSING_OR_INVALID_NET_OUTCOME", (record) => { record.signal_inputs.net_pnl = NaN; }],
    ["INCONSISTENT_OUTCOME", (record) => { record.signal_inputs.net_pnl = 19; }],
    ["INCONSISTENT_OUTCOME", (record) => { record.result_percent = 10; }],
    ["INCONSISTENT_WINNER", (record) => { record.winner = false; }],
  ];
  for (const [code, mutate] of cases) {
    const record = closedTrade(); mutate(record);
    const summary = summarizePerformance([record]);
    assert.equal(summary.includedCount, 0, code);
    assert.equal(summary.invalidClosedCount, 1, code);
    assert.ok(summary.exclusions[0].reasonCodes.includes(code), code);
    assert.ok(summary.exclusions[0].reasons.every((reason) => typeof reason === "string" && reason.length > 0));
  }
});

test("R uses only outcomes with an original risk-side stop and a consistent saved R", () => {
  const valid = closedTrade();
  const missingStop = closedTrade({ stop: null });
  const wrongSideStop = closedTrade({ direction: "SHORT", exit: 90, stop: 95 });
  const corruptR = closedTrade(); corruptR.result_r = 99;
  const group = summarizePerformance([valid, missingStop, wrongSideStop, corruptR]).groups[0];
  assert.equal(group.tradeCount, 4);
  assert.equal(group.totalNetPnl, 72);
  assert.equal(group.averageR, 1.8);
  assert.equal(group.rTradeCount, 1);
  assert.equal(group.rExcludedCount, 3);
  assert.deepEqual(group.rExclusions.map((item) => item.reasonCode), ["MISSING_STOP", "INVALID_STOP", "INVALID_R"]);
});

test("net percentage is weighted by entry value and expectancy is average money per actual trade", () => {
  const group = summarizePerformance([
    closedTrade({ size: 1, entryFees: 0, exitFees: 0 }),
    closedTrade({ entry: 10, exit: 5, size: 1, stop: 8, entryFees: 0, exitFees: 0 }),
  ]).groups[0];
  assert.equal(group.totalEntryValue, 110);
  assert.equal(group.totalNetPnl, 5);
  approximately(group.netPercent, 5 / 110 * 100);
  assert.equal(group.expectancyNetPnl, 2.5);
  assert.equal(group.profitFactor, 2);
  assert.equal(group.averageR, -0.25);
  assert.equal(group.feeFreeTradeCount, 2);
  assert.equal(group.entryFeePaidTradeCount, 0);
  assert.equal(group.exitFeePaidTradeCount, 0);
});

test("profit factor stays unavailable without recorded losses instead of implying infinite performance", () => {
  const onlyWin = summarizePerformance([closedTrade()]).groups[0];
  assert.equal(onlyWin.profitFactor, null);
  assert.equal(onlyWin.profitFactorStatus, "NO_LOSSES");
  const onlyLoss = summarizePerformance([closedTrade({ exit: 90 })]).groups[0];
  assert.equal(onlyLoss.profitFactor, 0);
  assert.equal(onlyLoss.profitFactorStatus, "CALCULATED");
  assert.equal(onlyLoss.expectancyNetPnl, -22);
  const flat = summarizePerformance([closedTrade({ exit: 101, stop: null })]).groups[0];
  assert.equal(flat.profitFactor, null);
  assert.equal(flat.averageR, null);
  assert.equal(flat.expectancyNetPnl, 0);
});

test("duplicate closed trade IDs are excluded rather than counted twice or chosen arbitrarily", () => {
  const one = closedTrade({ id: "duplicate" });
  const two = closedTrade({ id: "duplicate", exit: 90 });
  const summary = summarizePerformance([one, two]);
  assert.equal(summary.includedCount, 0);
  assert.equal(summary.invalidClosedCount, 2);
  assert.ok(summary.exclusions.every((item) => item.reasonCodes.includes("DUPLICATE_ID")));
});

test("overflowed totals stay unavailable instead of producing Infinity or NaN statistics", () => {
  const group = summarizePerformance([
    closedTrade({ entry: 1e308, exit: 1.1e308, size: 1, stop: 9.5e307, entryFees: 0, exitFees: 0 }),
    closedTrade({ entry: 1e308, exit: 1.1e308, size: 1, stop: 9.5e307, entryFees: 0, exitFees: 0 }),
  ]).groups[0];
  assert.equal(group.tradeCount, 2);
  assert.equal(group.totalEntryValue, null);
  assert.equal(group.netPercent, null);
  for (const value of Object.values(group)) if (typeof value === "number") assert.ok(Number.isFinite(value));
});
