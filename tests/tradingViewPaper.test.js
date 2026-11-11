import test from "node:test";
import assert from "node:assert/strict";
import { getMarketStatus } from "../api/_market-hours.js";
import { assessSwingSetup } from "../src/strategyModel.js";
import { createPaperObservation, validatePaperObservation } from "../src/paperModel.js";
import { closeTradingViewPaperEntry, createTradingViewPaperEntry, validateTradingViewPaperOrder } from "../src/tradingViewPaperModel.js";
import { TRADINGVIEW_PAPER_STORAGE_KEY, decodeTradingViewPaperLog, encodeTradingViewPaperLog, loadTradingViewPaperOrders, saveTradingViewPaperOrders, updateTradingViewPaperOrders } from "../src/tradingViewPaperStorage.js";

const signalTime = Date.parse("2026-09-28T21:00:00Z");
const buyTime = "2026-09-29T14:00:00.000Z";
const buyLogged = Date.parse("2026-09-29T14:05:00Z");
const sellTime = "2026-09-29T19:30:00.000Z";
const sellLogged = Date.parse("2026-09-29T19:35:00Z");

function observation(analysisId = "TEST-analysis-1") {
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
  const analysis = { ticker: "TEST", market: "usa", horizon: "1–5 handelsdagar (swingtrading)", decision: { status: "WAIT" },
    marketData, strategy: assessSwingSetup(marketData, { ticker: "TEST", marketStatus: getMarketStatus("usa", new Date(signalTime)), now: signalTime }),
    record: { trade_id: analysisId, signal_inputs: { record_type: "ANALYSIS" } } };
  assert.equal(analysis.strategy.status, "WATCH");
  const record = createPaperObservation(analysis, { setup: "BREAKOUT", holdingSessions: 3, quantity: 2, feePerOrder: 1, slippageBps: 10, recordedAt: signalTime });
  assert.ok(validatePaperObservation(record));
  return record;
}

function entry(source = observation(), overrides = {}, recordedAt = buyLogged) {
  return createTradingViewPaperEntry(source, { entryAt: buyTime, entryPrice: source.plan.entry_reference,
    quantity: 2, entryFee: 1, ...overrides }, { recordedAt });
}

function storage() {
  const values = new Map();
  return { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => { values.set(key, value); } };
}

const locks = { request(_key, _options, callback) { return callback(); } };

test("a TradingView buy is a separate manual paper fill tied to the locked signal", () => {
  const source = observation();
  const order = entry(source);
  assert.equal(order.status, "OPEN");
  assert.equal(order.direction, "LONG");
  assert.equal(order.sourcePaperObservationId, source.id);
  assert.equal(order.signalDate, source.signalDate);
  assert.equal(order.entryAt, buyTime);
  assert.equal(order.entryWithinPlan, true);
  assert.equal(order.entryLateLogged, false);
  assert.equal(order.netPnl, null);
  assert.ok(validateTradingViewPaperOrder(order));
});

test("entry rejects retrospective wrong-session fills, off-hours times, future timestamps and missing costs", () => {
  const source = observation();
  for (const entryAt of ["2026-09-28T14:00:00.000Z", "2026-09-29T12:00:00.000Z", "2026-09-30T14:00:00.000Z", "2026-10-03T14:00:00.000Z"]) {
    assert.throws(() => entry(source, { entryAt }), /nästa ordinarie handelssession/);
  }
  assert.throws(() => entry(source, { entryAt: "2026-09-29T15:00:00.000Z" }), /nästa ordinarie handelssession/);
  assert.throws(() => entry(source, { entryFee: "" }), /köpavgift/);
  assert.throws(() => entry(source, { quantity: 1.5 }), /antal aktier/);
  assert.throws(() => entry(source, { entryPrice: 0 }), /köppris/);
});

test("late manual logging is explicit and cannot masquerade as prompt capture", () => {
  const source = observation();
  const late = entry(source, {}, Date.parse("2026-09-29T20:00:00Z"));
  assert.equal(late.entryLateLogged, true);
  assert.ok(validateTradingViewPaperOrder(late));
  assert.equal(validateTradingViewPaperOrder({ ...late, entryLateLogged: false }), false);
});

test("closing uses TradingView fill and fees while leaving the locked entry intact", () => {
  const open = entry();
  const closed = closeTradingViewPaperEntry(open, { exitAt: sellTime, exitPrice: 151, exitQuantity: 2, exitFee: 1 }, { recordedAt: sellLogged });
  assert.equal(closed.status, "CLOSED");
  assert.equal(closed.entryPrice, open.entryPrice);
  assert.equal(closed.entryAt, open.entryAt);
  assert.equal(closed.sourcePaperObservationId, open.sourcePaperObservationId);
  assert.equal(closed.grossPnl, (151 - open.entryPrice) * 2);
  assert.equal(closed.exitQuantity, open.quantity);
  assert.equal(closed.totalFees, 2);
  assert.equal(closed.netPnl, closed.grossPnl - 2);
  assert.ok(Number.isFinite(closed.resultR));
  assert.equal(closed.winner, closed.netPnl > 0);
  assert.ok(validateTradingViewPaperOrder(closed));
  assert.throws(() => closeTradingViewPaperEntry(closed, { exitAt: sellTime, exitPrice: 152, exitQuantity: 2, exitFee: 1 }, { recordedAt: sellLogged }), /öppen/);
});

test("a partial TradingView sale cannot be mislabeled as a closed whole position", () => {
  const open = entry();
  assert.throws(() => closeTradingViewPaperEntry(open, { exitAt: sellTime, exitPrice: 151, exitQuantity: 1, exitFee: 1 }, { recordedAt: sellLogged }), /Delvisa försäljningar/);
  assert.throws(() => closeTradingViewPaperEntry(open, { exitAt: sellTime, exitPrice: 151, exitFee: 1 }, { recordedAt: sellLogged }), /sålt antal aktier/);
});

test("off-plan TradingView buys remain recorded but have no comparable R", () => {
  const source = observation();
  const open = entry(source, { entryPrice: source.plan.stop - 1 });
  assert.equal(open.entryWithinPlan, false);
  const closed = closeTradingViewPaperEntry(open, { exitAt: sellTime, exitPrice: source.plan.stop + 2, exitQuantity: 2, exitFee: 0 }, { recordedAt: sellLogged });
  assert.ok(validateTradingViewPaperOrder(closed));
  assert.equal(closed.resultR, null);
  assert.equal(closed.winner, true);
});

test("local TradingView log roundtrips, blocks duplicate signals and rejects altered arithmetic", () => {
  const first = entry();
  const copyOfSignal = entry(observation("TEST-analysis-2"));
  assert.notEqual(copyOfSignal.id, first.id);
  const memory = storage();
  saveTradingViewPaperOrders(memory, [first]);
  assert.deepEqual(loadTradingViewPaperOrders(memory), [first]);
  assert.deepEqual(decodeTradingViewPaperLog(encodeTradingViewPaperLog([first])), [first]);
  assert.match(memory.getItem(TRADINGVIEW_PAPER_STORAGE_KEY), /tradingview-paper-log-v1/);
  assert.throws(() => saveTradingViewPaperOrders(memory, [first, copyOfSignal]), /Samma låsta signal/);
  assert.equal(validateTradingViewPaperOrder({ ...first, signalDate: "2026-99-99" }), false);
  assert.throws(() => decodeTradingViewPaperLog(JSON.stringify({ format: "sannolikhet-tradingview-paper-log-v1", records: [{ ...first, signalDate: "2026-99-99" }] })), /ogiltig order/);
  const closed = closeTradingViewPaperEntry(first, { exitAt: sellTime, exitPrice: 151, exitQuantity: 2, exitFee: 1 }, { recordedAt: sellLogged });
  assert.throws(() => saveTradingViewPaperOrders(memory, [{ ...closed, netPnl: closed.netPnl + 10 }]), /ogiltig order/);
  assert.deepEqual(loadTradingViewPaperOrders(memory), [first]);
});

test("locked local update allows one close and refuses later edits to entry or final outcome", async () => {
  const memory = storage();
  const first = entry();
  await updateTradingViewPaperOrders(memory, locks, (current) => [...current, first]);
  const editedEntry = { ...first, entryPrice: first.entryPrice + 0.01 };
  assert.ok(validateTradingViewPaperOrder(editedEntry));
  await assert.rejects(() => updateTradingViewPaperOrders(memory, locks, () => [editedEntry]), /låsta ingång/);
  assert.deepEqual(loadTradingViewPaperOrders(memory), [first]);
  const closed = closeTradingViewPaperEntry(first, { exitAt: sellTime, exitPrice: 151, exitQuantity: 2, exitFee: 1 }, { recordedAt: sellLogged });
  await updateTradingViewPaperOrders(memory, locks, () => [closed]);
  assert.deepEqual(loadTradingViewPaperOrders(memory), [closed]);
  const revised = closeTradingViewPaperEntry(first, { exitAt: sellTime, exitPrice: 152, exitQuantity: 2, exitFee: 1 }, { recordedAt: sellLogged });
  await assert.rejects(() => updateTradingViewPaperOrders(memory, locks, () => [revised]), /låsta ingång/);
  assert.deepEqual(loadTradingViewPaperOrders(memory), [closed]);
});
