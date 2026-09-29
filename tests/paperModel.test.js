import test from "node:test";
import assert from "node:assert/strict";
import { getMarketStatus } from "../api/_market-hours.js";
import { assessSwingSetup } from "../src/strategyModel.js";
import { createPaperObservation, settlePaperObservation, summarizePaperObservations, supportsPaperStrategyVersion, validatePaperObservation } from "../src/paperModel.js";

const monday = Date.parse("2026-09-28T21:00:00Z");
const options = { setup: "BREAKOUT", holdingSessions: 3, quantity: 2, feePerOrder: 1, slippageBps: 10, recordedAt: monday };

function makeBars() {
  const dates = [];
  let date = new Date("2026-09-28T00:00:00Z");
  while (dates.length < 100) {
    if (![0, 6].includes(date.getUTCDay())) dates.unshift(date.toISOString().slice(0, 10));
    date = new Date(date.getTime() - 86400000);
  }
  return dates.map((datetime, index) => {
    const close = 50 + index;
    return { datetime, open: close - 0.3, high: close + 0.5, low: close - 0.5, close, volume: index === 99 ? 1_500_000 : 1_000_000 };
  });
}

function fixture() {
  const data = { ticker: "TEST", requested_ticker: "TEST", exchange: "NASDAQ", currency: "USD", timezone: "America/New_York", interval: "1day", fetched_at: new Date(monday - 60000).toISOString(), bars: makeBars() };
  const strategy = assessSwingSetup(data, { ticker: "TEST", marketStatus: getMarketStatus("usa", new Date(monday)), now: monday });
  assert.equal(strategy.status, "WATCH");
  return { ticker: "TEST", market: "usa", horizon: "1–5 handelsdagar (swingtrading)", decision: { status: "WAIT" }, strategy, marketData: data, record: { trade_id: "TEST-analysis-1", signal_inputs: { record_type: "ANALYSIS" } } };
}

function day(datetime, open, high, low, close) { return { datetime, open, high, low, close, volume: 1_000_000 }; }
const later = (original, ...bars) => ({ ...original.marketData, bars: [...original.marketData.bars, ...bars] });
const tuesday = "2026-09-29";
const wednesday = "2026-09-30";
const thursday = "2026-10-01";
const closeTime = (date) => `${date}T21:00:00Z`;

test("captures a current WATCH once, freezes its signal inputs, and is JSON-valid", () => {
  const analysis = fixture();
  const before = structuredClone(analysis);
  const paper = createPaperObservation(analysis, options);
  assert.equal(paper.status, "PENDING_ENTRY");
  assert.equal(paper.id, "paper:TEST-analysis-1:BREAKOUT");
  assert.equal(paper.signalDate, "2026-09-28");
  assert.equal(paper.signalBar.close, 149);
  assert.ok(validatePaperObservation(paper));
  assert.ok(validatePaperObservation(JSON.parse(JSON.stringify(paper))));
  assert.deepEqual(analysis, before);
  assert.deepEqual(createPaperObservation(analysis, options), paper);
  analysis.marketData.bars.at(-1).close = 999;
  assert.equal(paper.signalBar.close, 149);
});

test("a captured v0.2 paper record remains a readable historical version after a future strategy bump", () => {
  const record = createPaperObservation(fixture(), options);
  assert.equal(record.strategyVersion, "swing-v0.2-experimental");
  assert.ok(validatePaperObservation(record));
  assert.equal(supportsPaperStrategyVersion(record.strategyVersion, "swing-v0.3-experimental"), true);
  assert.equal(supportsPaperStrategyVersion("unknown-version", "swing-v0.3-experimental"), false);
  assert.equal(validatePaperObservation({ ...record, strategyVersion: "unknown-version" }), false);
});

test("NO TRADE, NO_SETUP, daytrading and stale or retroactive signals cannot be captured", () => {
  for (const change of [
    (a) => { a.decision.status = "NO_TRADE"; },
    (a) => { a.strategy.status = "NO_SETUP"; },
    (a) => { a.horizon = "samma handelsdag (daytrading)"; },
    (a) => { a.marketData.fetched_at = "2026-09-28T18:00:00.000Z"; },
  ]) {
    const analysis = fixture(); change(analysis);
    assert.throws(() => createPaperObservation(analysis, options));
  }
  const retroactive = fixture();
  retroactive.marketData.fetched_at = "2026-09-29T20:59:00.000Z";
  assert.throws(() => createPaperObservation(retroactive, { ...options, recordedAt: "2026-09-29T21:00:00Z" }), /förväntade/);
});

test("the prior close cannot be captured after the next US session opens, including via import", () => {
  const duringOpen = fixture();
  duringOpen.marketData.fetched_at = "2026-09-29T14:59:00.000Z";
  assert.throws(() => createPaperObservation(duringOpen, { ...options, recordedAt: "2026-09-29T15:00:00Z" }), /öppnat/);
  const valid = createPaperObservation(fixture(), options);
  const forgedLate = { ...valid, recordedAt: "2026-09-29T15:00:00.000Z", sourceFetchedAt: "2026-09-29T14:59:00.000Z" };
  assert.equal(validatePaperObservation(forgedLate), false);
});

test("a fresh new signal after the next US session closes can be captured", () => {
  const analysis = fixture();
  const next = day(tuesday, 149.7, 150.5, 149.5, 150);
  next.volume = 1_500_000;
  analysis.marketData.bars.push(next);
  analysis.marketData.fetched_at = "2026-09-29T20:59:00.000Z";
  analysis.record.trade_id = "TEST-analysis-2";
  const at = Date.parse("2026-09-29T21:00:00Z");
  analysis.strategy = assessSwingSetup(analysis.marketData, { ticker: "TEST", marketStatus: getMarketStatus("usa", new Date(at)), now: at });
  assert.equal(analysis.strategy.status, "WATCH");
  const captured = createPaperObservation(analysis, { ...options, recordedAt: at });
  assert.equal(captured.signalDate, tuesday);
  assert.ok(validatePaperObservation(captured));
});

test("capture rejects mismatched identity or changed strategy plan", () => {
  const wrongExchange = fixture(); wrongExchange.marketData.exchange = "OMX";
  assert.throws(() => createPaperObservation(wrongExchange, options));
  const changedPlan = fixture(); changedPlan.strategy.plans.find((plan) => plan.setup === "BREAKOUT").stop -= 1;
  assert.throws(() => createPaperObservation(changedPlan, options), /låsta nivåer/);
  const impossibleFees = fixture();
  assert.throws(() => createPaperObservation(impossibleFees, { ...options, feePerOrder: Number.POSITIVE_INFINITY }));
});

test("same-day data stay pending; a later entry stays open and never counts as a result", () => {
  const analysis = fixture();
  const paper = createPaperObservation(analysis, options);
  assert.deepEqual(settlePaperObservation(paper, analysis.marketData, { now: monday + 60000 }), paper);
  const data = later(analysis, day(tuesday, 149.7, 150.5, 149.5, 150));
  const open = settlePaperObservation(paper, data, { now: closeTime(tuesday) });
  assert.equal(open.status, "PENDING_OPEN");
  assert.equal(open.entryDate, tuesday);
  assert.equal(open.entry, 149.7 * 1.001);
  assert.equal(open.holdingBars, 1);
  assert.ok(validatePaperObservation(open));
  assert.deepEqual(settlePaperObservation(open, data, { now: closeTime(tuesday) }), open);
  const summary = summarizePaperObservations([paper, open]);
  assert.equal(summary.totalCount, 1); // same ID is not double-counted
  assert.equal(summary.invalidCount, 1);
  assert.equal(summary.closedCount, 0);
  assert.deepEqual(summary.groups, []);
});

test("an unfinished current-session candle cannot settle a paper trade", () => {
  const analysis = fixture();
  const paper = createPaperObservation(analysis, options);
  const data = later(analysis, day(tuesday, 149.7, 180, 100, 150));
  const duringOpen = settlePaperObservation(paper, data, { now: "2026-09-29T15:00:00Z" });
  assert.equal(duringOpen.status, "PENDING_ENTRY");
  assert.equal(duringOpen.exitDate, null);
  assert.ok(validatePaperObservation(duringOpen));
});

test("the next opening outside the original stop/target rejects entry", () => {
  for (const bar of [day(tuesday, 147, 150, 146, 149), day(tuesday, 153, 154, 149, 151)]) {
    const analysis = fixture();
    const paper = createPaperObservation(analysis, options);
    const rejected = settlePaperObservation(paper, later(analysis, bar), { now: closeTime(tuesday) });
    assert.equal(rejected.status, "REJECTED_ENTRY");
    assert.ok(validatePaperObservation(rejected));
    assert.deepEqual(settlePaperObservation(rejected, null), rejected);
  }
});

test("fees and slippage enter both fills, with a timed close on the third observed session", () => {
  const analysis = fixture();
  const paper = createPaperObservation(analysis, options);
  const data = later(analysis,
    day(tuesday, 149.7, 150.5, 149.5, 150),
    day(wednesday, 150.7, 151.5, 150.5, 151),
    day(thursday, 151.7, 152.5, 151.5, 152));
  const closed = settlePaperObservation(paper, data, { now: closeTime(thursday) });
  assert.equal(closed.status, "CLOSED");
  assert.equal(closed.exitReason, "TIME_EXIT");
  assert.equal(closed.holdingBars, 3);
  assert.equal(closed.exit, 152 * 0.999);
  assert.equal(closed.totalFees, 2);
  assert.equal(closed.netPnl, (closed.exit - closed.entry) * 2 - 2);
  assert.equal(closed.resultR, closed.netPnl / ((closed.entry - closed.stop) * 2));
  assert.ok(validatePaperObservation(closed));
  assert.deepEqual(settlePaperObservation(closed, null), closed);
});

test("same-bar stop and target uses stop; a later stop gap fills at the worse opening", () => {
  const analysis = fixture();
  const paper = createPaperObservation(analysis, options);
  const both = settlePaperObservation(paper, later(analysis, day(tuesday, 149.7, 160, 147, 150)), { now: closeTime(tuesday) });
  assert.equal(both.exitReason, "STOP");
  assert.equal(both.ambiguousBar, true);
  assert.equal(both.exit, paper.plan.stop * 0.999);
  const gap = settlePaperObservation(paper, later(analysis,
    day(tuesday, 149.7, 150.5, 149.5, 150),
    day(wednesday, 140, 142, 139, 141)), { now: closeTime(wednesday) });
  assert.equal(gap.exitReason, "STOP_GAP");
  assert.equal(gap.exit, 140 * 0.999);
  assert.ok(gap.resultR < -1);
});

test("missing expected sessions, altered signal bar and identity mismatches stay unassessed", () => {
  const analysis = fixture();
  const paper = createPaperObservation(analysis, options);
  const missing = settlePaperObservation(paper, later(analysis, day(wednesday, 150.7, 151.5, 150.5, 151)), { now: closeTime(wednesday) });
  assert.equal(missing.status, "NOT_ASSESSED");
  assert.match(missing.assessmentError, /2026-09-29/);
  assert.ok(validatePaperObservation(missing));
  const changedSignal = structuredClone(analysis.marketData);
  changedSignal.bars.at(-1).volume += 1;
  assert.equal(settlePaperObservation(paper, changedSignal, { now: monday + 60000 }).status, "NOT_ASSESSED");
  assert.equal(settlePaperObservation(paper, { ...analysis.marketData, ticker: "OTHER" }, { now: monday + 60000 }).status, "NOT_ASSESSED");
  const recovered = settlePaperObservation(missing, later(analysis, day(tuesday, 149.7, 150.5, 149.5, 150), day(wednesday, 150.7, 151.5, 150.5, 151)), { now: closeTime(wednesday) });
  assert.equal(recovered.status, "PENDING_OPEN");
});

test("summary excludes pending and invalid records and keeps currencies in separate groups", () => {
  const analysis = fixture();
  const paper = createPaperObservation(analysis, { ...options, holdingSessions: 1 });
  const closed = settlePaperObservation(paper, later(analysis, day(tuesday, 149.7, 150.5, 149.5, 150)), { now: closeTime(tuesday) });
  const swedish = { ...closed, id: "paper:SE-analysis:BREAKOUT", sourceAnalysisTradeId: "SE-analysis", ticker: "SETEST", exchange: "OMX", currency: "SEK", timezone: "Europe/Stockholm", market: "stockholm" };
  assert.ok(validatePaperObservation(swedish));
  const corrupted = { ...closed, netPnl: closed.netPnl + 100 };
  assert.equal(validatePaperObservation(corrupted), false);
  const summary = summarizePaperObservations([closed, swedish, paper, corrupted]);
  assert.equal(summary.closedCount, 2);
  assert.equal(summary.invalidCount, 2);
  assert.equal(summary.groups.length, 2);
  assert.deepEqual(summary.groups.map((group) => group.currency).sort(), ["SEK", "USD"]);
  assert.ok(summary.groups.every((group) => group.closedCount === 1));
});
