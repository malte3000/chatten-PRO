import test from "node:test";
import assert from "node:assert/strict";
import { getMarketStatus } from "../api/_market-hours.js";
import { assessSwingSetup } from "../src/strategyModel.js";
import { createPaperObservation } from "../src/paperModel.js";
import { closeTradingViewPaperEntry, createTradingViewPaperEntry } from "../src/tradingViewPaperModel.js";
import { decodeTradingViewPaperLog, encodeTradingViewPaperLog, loadTradingViewPaperOrders, mergeTradingViewPaperLogs, updateTradingViewPaperOrders } from "../src/tradingViewPaperStorage.js";

function source(analysisId = "import-test-1") {
  const dates = [];
  let date = new Date("2026-09-28T00:00:00Z");
  while (dates.length < 100) {
    if (![0, 6].includes(date.getUTCDay())) dates.unshift(date.toISOString().slice(0, 10));
    date = new Date(date.getTime() - 86_400_000);
  }
  const bars = dates.map((datetime, index) => {
    const close = 50 + index;
    return { datetime, open: close - 0.3, high: close + 0.5, low: close - 0.5, close, volume: index === 99 ? 1_500_000 : 1_000_000 };
  });
  const marketData = { ticker: "TEST", exchange: "NASDAQ", currency: "USD", timezone: "America/New_York", interval: "1day", fetched_at: "2026-09-28T20:59:00.000Z", bars };
  const analysis = { ticker: "TEST", market: "usa", horizon: "1–5 handelsdagar (swingtrading)", decision: { status: "TRADE" }, marketData,
    strategy: assessSwingSetup(marketData, { ticker: "TEST", marketStatus: getMarketStatus("usa", new Date("2026-09-28T21:00:00Z")), now: Date.parse("2026-09-28T21:00:00Z") }),
    record: { trade_id: analysisId, signal_inputs: { record_type: "ANALYSIS" } } };
  return createPaperObservation(analysis, { setup: "BREAKOUT", holdingSessions: 3, quantity: 2, feePerOrder: 1, slippageBps: 10, recordedAt: Date.parse("2026-09-28T21:00:00Z") });
}

function openOrder(analysisId = "import-test-1") {
  const observation = source(analysisId);
  return createTradingViewPaperEntry(observation, { entryAt: "2026-09-29T14:00:00.000Z", entryPrice: observation.plan.entry_reference,
    quantity: 2, entryFee: 1 }, { recordedAt: Date.parse("2026-09-29T14:05:00Z") });
}

function closedOrder(order, exitPrice = 151) {
  return closeTradingViewPaperEntry(order, { exitAt: "2026-09-29T19:30:00.000Z", exitPrice, exitQuantity: order.quantity, exitFee: 1 },
    { recordedAt: Date.parse("2026-09-29T19:35:00Z") });
}

function storage() {
  const values = new Map();
  return { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => { values.set(key, value); } };
}

const locks = { request(_key, _options, callback) { return callback(); } };

test("TradingView backup restores missing orders and ignores JSON property order", async () => {
  const original = openOrder();
  const backup = decodeTradingViewPaperLog(encodeTradingViewPaperLog([original]));
  const reordered = Object.fromEntries(Object.entries(backup[0]).reverse());
  const memory = storage();
  await updateTradingViewPaperOrders(memory, locks, (current) => mergeTradingViewPaperLogs(current, [reordered]));
  assert.deepEqual(loadTradingViewPaperOrders(memory), [reordered]);
  const again = await updateTradingViewPaperOrders(memory, locks, (current) => mergeTradingViewPaperLogs(current, [original]));
  assert.deepEqual(again, [reordered]);
});

test("backup can add a matching close, while an older open backup preserves a local close", async () => {
  const open = openOrder();
  const closed = closedOrder(open);
  const memory = storage();
  await updateTradingViewPaperOrders(memory, locks, () => [open]);
  await updateTradingViewPaperOrders(memory, locks, (current) => mergeTradingViewPaperLogs(current, [closed]));
  assert.deepEqual(loadTradingViewPaperOrders(memory), [closed]);
  await updateTradingViewPaperOrders(memory, locks, (current) => mergeTradingViewPaperLogs(current, [open]));
  assert.deepEqual(loadTradingViewPaperOrders(memory), [closed]);
});

test("conflicting entry, differing close and duplicate signal imports are atomic", async () => {
  const open = openOrder();
  const closed = closedOrder(open);
  const memory = storage();
  await updateTradingViewPaperOrders(memory, locks, () => [closed]);
  const before = loadTradingViewPaperOrders(memory);
  const conflictingEntry = { ...open, entryPrice: open.entryPrice + 0.01, entryWithinPlan: true };
  const conflictingClose = closedOrder(open, 152);
  const duplicateSignal = openOrder("import-test-2");
  assert.notEqual(duplicateSignal.id, open.id);
  for (const incoming of [conflictingEntry, conflictingClose, duplicateSignal]) {
    await assert.rejects(() => updateTradingViewPaperOrders(memory, locks, (current) => mergeTradingViewPaperLogs(current, [incoming])),
      /skrevs över|annan TradingView-order/);
    assert.deepEqual(loadTradingViewPaperOrders(memory), before);
  }
});
