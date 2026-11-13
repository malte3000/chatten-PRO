import test from "node:test";
import assert from "node:assert/strict";
import { getMarketStatus } from "../api/_market-hours.js";
import { assessSwingSetup } from "../src/strategyModel.js";
import { createPaperObservation, settlePaperObservation, validatePaperObservation } from "../src/paperModel.js";
import { MAX_PAPER_FOLLOWUP_SYMBOLS, planPaperFollowup, runPaperFollowup } from "../src/paperFollowup.js";
import { loadPaperLog, savePaperLog } from "../src/paperStorage.js";

const signalTime = Date.parse("2026-09-28T21:00:00Z");
const nextClose = Date.parse("2026-09-29T21:00:00Z");

function makeBars() {
  const dates = [];
  let day = new Date("2026-09-28T00:00:00Z");
  while (dates.length < 100) {
    if (![0, 6].includes(day.getUTCDay())) dates.unshift(day.toISOString().slice(0, 10));
    day = new Date(day.getTime() - 86400000);
  }
  return dates.map((datetime, index) => {
    const close = 50 + index;
    return { datetime, open: close - 0.3, high: close + 0.5, low: close - 0.5, close, volume: index === 99 ? 1_500_000 : 1_000_000 };
  });
}

function fixture() {
  const marketData = { ticker: "TEST", requested_ticker: "TEST", exchange: "NASDAQ", currency: "USD",
    timezone: "America/New_York", interval: "1day", fetched_at: "2026-09-28T20:59:00.000Z", bars: makeBars() };
  const analysis = { ticker: "TEST", market: "usa", horizon: "1–5 handelsdagar (swingtrading)", decision: { status: "TRADE" },
    strategy: assessSwingSetup(marketData, { ticker: "TEST", marketStatus: getMarketStatus("usa", new Date(signalTime)), now: signalTime }),
    marketData, record: { trade_id: "TEST-analysis-1", signal_inputs: { record_type: "ANALYSIS" } } };
  assert.equal(analysis.strategy.status, "WATCH");
  const pending = createPaperObservation(analysis, { setup: "BREAKOUT", holdingSessions: 1, quantity: 2,
    feePerOrder: 1, slippageBps: 10, recordedAt: signalTime });
  const nextBar = { datetime: "2026-09-29", open: 149.7, high: 150.5, low: 149.5, close: 150, volume: 1_000_000 };
  const followup = { ...marketData, bars: [...marketData.bars, nextBar] };
  return { pending, followup };
}

function cloneTicker(record, ticker) {
  const sourceAnalysisTradeId = `${ticker}-analysis`;
  const next = { ...record, ticker, sourceAnalysisTradeId, id: `paper:${sourceAnalysisTradeId}:${record.setup}` };
  assert.ok(validatePaperObservation(next));
  return next;
}

function storageWith(records) {
  const entries = new Map();
  const storage = { getItem(key) { return entries.get(key) ?? null; }, setItem(key, value) { entries.set(key, value); } };
  savePaperLog(storage, records);
  return storage;
}

function locks() {
  return { requests: 0, request(_name, _options, callback) { this.requests += 1; return callback(); } };
}

test("follow-up plan skips completed records and waits for a later closed session without using data credits", () => {
  const { pending, followup } = fixture();
  const closed = settlePaperObservation(pending, followup, { now: nextClose });
  assert.equal(closed.status, "CLOSED");
  assert.deepEqual(planPaperFollowup([pending, closed], { now: signalTime + 60000 }), {
    targets: [], totalSymbols: 0, deferredSymbols: 0, openRecords: 1, waitingRecords: 1,
  });
  const plan = planPaperFollowup([pending, closed], { now: nextClose });
  assert.equal(plan.totalSymbols, 1);
  assert.equal(plan.targets[0].records, 1);
  assert.equal(plan.waitingRecords, 0);
});

test("one explicit request updates a pending observation using only closed daily data", async () => {
  const { pending, followup } = fixture();
  const storage = storageWith([pending]);
  const urls = [];
  const result = await runPaperFollowup({ storage, lockManager: locks(), now: () => nextClose,
    request: async (url) => { urls.push(url); return followup; } });
  assert.equal(urls.length, 1);
  assert.match(urls[0], /ticker=TEST/);
  assert.match(urls[0], /interval=1day/);
  assert.match(urls[0], /outputsize=200/);
  assert.deepEqual({ requests: result.attemptedRequests, symbols: result.checkedSymbols, records: result.updatedRecords, error: result.error },
    { requests: 1, symbols: 1, records: 1, error: null });
  assert.equal(result.records[0].status, "CLOSED");
  assert.equal(loadPaperLog(storage)[0].status, "CLOSED");
  assert.deepEqual(result.records[0].signalBar, pending.signalBar);
});

test("same-session click makes no provider request or local write", async () => {
  const { pending } = fixture();
  const storage = storageWith([pending]);
  const lockManager = locks();
  const result = await runPaperFollowup({ storage, lockManager, now: () => signalTime + 60000,
    request: async () => { throw new Error("A request should not be made"); } });
  assert.equal(result.attemptedRequests, 0);
  assert.equal(result.waitingRecords, 1);
  assert.deepEqual(loadPaperLog(storage), [pending]);
  assert.equal(lockManager.requests, 1);
});

test("provider quota error stops immediately and leaves the locked paper record unchanged", async () => {
  const { pending } = fixture();
  const storage = storageWith([pending]);
  const result = await runPaperFollowup({ storage, lockManager: locks(), now: () => nextClose,
    request: async () => { const error = new Error("Datakällans kvot är nådd."); error.status = 429; throw error; } });
  assert.equal(result.checkedSymbols, 0);
  assert.equal(result.attemptedRequests, 1);
  assert.deepEqual(result.error, { ticker: "TEST", stage: "market_data", status: 429, message: "Datakällans kvot är nådd." });
  assert.deepEqual(loadPaperLog(storage), [pending]);
});

test("mismatched provider identity cannot settle a paper result", async () => {
  const { pending, followup } = fixture();
  const storage = storageWith([pending]);
  const result = await runPaperFollowup({ storage, lockManager: locks(), now: () => nextClose,
    request: async () => ({ ...followup, ticker: "OTHER" }) });
  assert.equal(result.error, null);
  assert.equal(result.updatedRecords, 1);
  assert.equal(result.records[0].status, "NOT_ASSESSED");
  assert.match(result.records[0].assessmentError, /matchar inte/);
});

test("a missing completed session cannot be counted as a trade outcome", async () => {
  const { pending, followup } = fixture();
  const storage = storageWith([pending]);
  const result = await runPaperFollowup({ storage, lockManager: locks(), now: () => nextClose,
    request: async () => ({ ...followup, bars: followup.bars.slice(0, -1) }) });
  assert.equal(result.error, null);
  assert.equal(result.attemptedRequests, 1);
  assert.equal(result.records[0].status, "NOT_ASSESSED");
  assert.match(result.records[0].assessmentError, /2026-09-29/);
  assert.equal(result.records[0].winner, null);
  assert.equal(loadPaperLog(storage)[0].status, "NOT_ASSESSED");
});

test("up to five distinct symbols are planned per click, with same-symbol records sharing a request", () => {
  const { pending } = fixture();
  const records = ["AAA", "BBB", "CCC", "DDD", "EEE", "FFF"].map((ticker) => cloneTicker(pending, ticker));
  const duplicateSymbol = { ...records[0], sourceAnalysisTradeId: "AAA-second-analysis", id: "paper:AAA-second-analysis:BREAKOUT" };
  assert.ok(validatePaperObservation(duplicateSymbol));
  const plan = planPaperFollowup([...records, duplicateSymbol], { now: nextClose });
  assert.equal(plan.targets.length, MAX_PAPER_FOLLOWUP_SYMBOLS);
  assert.equal(plan.totalSymbols, 6);
  assert.equal(plan.deferredSymbols, 1);
  assert.equal(plan.targets[0].records, 2);
  assert.deepEqual(plan.targets[0].recordIds, [records[0].id, duplicateSymbol.id]);
  const nextPlan = planPaperFollowup([...records, duplicateSymbol], { now: nextClose, afterKey: plan.targets.at(-1).key });
  assert.equal(nextPlan.targets[0].ticker, "FFF");
  assert.throws(() => planPaperFollowup(records, { now: nextClose, maxSymbols: 6 }), /Ogiltig/);
});

test("a failed assessment does not keep later symbols out of every subsequent bounded batch", async () => {
  const { pending, followup } = fixture();
  const storage = storageWith(["AAA", "BBB", "CCC", "DDD", "EEE", "FFF"].map((ticker) => cloneTicker(pending, ticker)));
  const requested = [];
  const request = async (url) => {
    requested.push(new URL(url, "https://example.test").searchParams.get("ticker"));
    return { ...followup, ticker: "OTHER" };
  };
  await runPaperFollowup({ storage, lockManager: locks(), now: () => nextClose, request });
  assert.deepEqual(requested, ["AAA", "BBB", "CCC", "DDD", "EEE"]);
  assert.ok(loadPaperLog(storage).slice(0, 5).every((record) => record.status === "NOT_ASSESSED"));
  requested.length = 0;
  await runPaperFollowup({ storage, lockManager: locks(), now: () => nextClose, request });
  assert.equal(requested[0], "FFF");
  assert.equal(loadPaperLog(storage).at(-1).status, "NOT_ASSESSED");
});

test("a later provider failure preserves an earlier update and stops the bounded batch", async () => {
  const { pending, followup } = fixture();
  const first = cloneTicker(pending, "AAA");
  const second = cloneTicker(pending, "ZZZ");
  const storage = storageWith([first, second]);
  let calls = 0;
  const result = await runPaperFollowup({ storage, lockManager: locks(), now: () => nextClose,
    request: async () => { calls += 1; if (calls === 2) throw new Error("Tillfälligt nätfel");
      return { ...followup, ticker: "AAA", requested_ticker: "AAA" }; } });
  assert.equal(result.checkedSymbols, 1);
  assert.equal(result.attemptedRequests, 2);
  assert.equal(result.updatedRecords, 1);
  assert.equal(result.error.ticker, "ZZZ");
  assert.deepEqual(loadPaperLog(storage).map((record) => record.status), ["CLOSED", "PENDING_ENTRY"]);
});

test("a concurrent local close is re-read under the lock and never overwritten", async () => {
  const { pending, followup } = fixture();
  const closed = settlePaperObservation(pending, followup, { now: nextClose });
  const storage = storageWith([pending]);
  const result = await runPaperFollowup({ storage, lockManager: locks(), now: () => nextClose,
    request: async () => { savePaperLog(storage, [closed]); return followup; } });
  assert.equal(result.checkedSymbols, 1);
  assert.equal(result.checkedRecords, 0);
  assert.equal(result.updatedRecords, 0);
  assert.deepEqual(loadPaperLog(storage), [closed]);
});

test("a same-symbol observation added while the request is in flight is not assessed by the old plan", async () => {
  const { pending, followup } = fixture();
  const sourceAnalysisTradeId = "TEST-next-session-analysis";
  const later = {
    ...pending, id: `paper:${sourceAnalysisTradeId}:${pending.setup}`, sourceAnalysisTradeId,
    signalDate: "2026-09-29", signalBar: followup.bars.at(-1),
    recordedAt: "2026-09-29T21:05:00.000Z", sourceFetchedAt: "2026-09-29T21:04:00.000Z",
    plan: { ...pending.plan, entry_reference: 150, stop: 149, target: 152, risk_per_share: 1, theoretical_risk_reward: 2 },
  };
  assert.ok(validatePaperObservation(later));
  const storage = storageWith([pending]);
  const result = await runPaperFollowup({ storage, lockManager: locks(), now: () => nextClose,
    request: async () => { savePaperLog(storage, [pending, later]); return followup; } });
  assert.equal(result.checkedRecords, 1);
  assert.deepEqual(loadPaperLog(storage).map((record) => record.status), ["CLOSED", "PENDING_ENTRY"]);
});
