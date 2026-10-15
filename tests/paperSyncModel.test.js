import test from "node:test";
import assert from "node:assert/strict";
import { getMarketStatus } from "../api/_market-hours.js";
import { assessSwingSetup } from "../src/strategyModel.js";
import { createPaperObservation, settlePaperObservation, validatePaperObservation } from "../src/paperModel.js";
import { mergePaperObservationCopies, mergePaperObservationLists, rehydratePaperObservation, splitPaperObservation } from "../src/paperSyncModel.js";

const signalTime = Date.parse("2026-09-28T21:00:00Z");

function fixture() {
  const dates = [];
  let date = new Date("2026-09-28T00:00:00Z");
  while (dates.length < 100) {
    if (![0, 6].includes(date.getUTCDay())) dates.unshift(date.toISOString().slice(0, 10));
    date = new Date(date.getTime() - 86400000);
  }
  const bars = dates.map((datetime, index) => {
    const close = 50 + index;
    return { datetime, open: close - 0.3, high: close + 0.5, low: close - 0.5, close, volume: index === 99 ? 1_500_000 : 1_000_000 };
  });
  const marketData = { ticker: "TEST", requested_ticker: "TEST", exchange: "NASDAQ", currency: "USD", timezone: "America/New_York", interval: "1day", fetched_at: new Date(signalTime - 60000).toISOString(), bars };
  const strategy = assessSwingSetup(marketData, { ticker: "TEST", marketStatus: getMarketStatus("usa", new Date(signalTime)), now: signalTime });
  return { ticker: "TEST", market: "usa", horizon: "1–5 handelsdagar (swingtrading)", decision: { status: "WAIT" }, strategy, marketData, record: { trade_id: "TEST-analysis-1", signal_inputs: { record_type: "ANALYSIS" } } };
}

const day = (datetime, open, high, low, close) => ({ datetime, open, high, low, close, volume: 1_000_000 });
const followup = (analysis, ...bars) => ({ ...analysis.marketData, bars: [...analysis.marketData.bars, ...bars] });
const closeTime = (date) => `${date}T21:00:00Z`;

function sequence() {
  const analysis = fixture();
  const pending = createPaperObservation(analysis, { setup: "BREAKOUT", holdingSessions: 3, quantity: 2, feePerOrder: 1, slippageBps: 10, recordedAt: signalTime });
  const first = day("2026-09-29", 149.7, 150.5, 149.5, 150);
  const second = day("2026-09-30", 150.7, 151.5, 150.5, 151);
  const third = day("2026-10-01", 151.7, 152.5, 151.5, 152);
  const openOne = settlePaperObservation(pending, followup(analysis, first), { now: closeTime(first.datetime) });
  const openTwo = settlePaperObservation(pending, followup(analysis, first, second), { now: closeTime(second.datetime) });
  const closed = settlePaperObservation(pending, followup(analysis, first, second, third), { now: closeTime(third.datetime) });
  return { analysis, pending, openOne, openTwo, closed, first, second, third };
}

test("split and rehydrate preserve locked captures and every supported paper version", () => {
  const { pending } = sequence();
  const old = { ...pending, version: "paper-forward-v0.2", strategyVersion: "swing-v0.2-experimental", sourceDecisionStatus: "NO_TRADE" };
  const legacy = { ...old, version: "paper-forward-v0.1" };
  delete legacy.basis;
  delete legacy.sourceDecisionStatus;
  for (const record of [pending, old, legacy]) {
    assert.ok(validatePaperObservation(record));
    const { capture, progress } = splitPaperObservation(record);
    assert.equal(capture.status, undefined);
    assert.equal(progress.signalBar, undefined);
    assert.deepEqual(rehydratePaperObservation(capture, progress), record);
    assert.throws(() => rehydratePaperObservation(capture, { ...progress, signalDate: "2026-09-29" }), /uppdelade/);
  }
});

test("merge advances a single observation across pending, open, and closed states in either order", () => {
  const { pending, openOne, openTwo, closed } = sequence();
  assert.equal(openOne.status, "PENDING_OPEN");
  assert.equal(openTwo.holdingBars, 2);
  assert.equal(closed.status, "CLOSED");
  for (const [earlier, later] of [[pending, openOne], [openOne, openTwo], [openTwo, closed], [pending, closed]]) {
    assert.deepEqual(mergePaperObservationCopies(earlier, later), later);
    assert.deepEqual(mergePaperObservationCopies(later, earlier), later);
  }
  assert.deepEqual(mergePaperObservationCopies(closed, structuredClone(closed)), closed);
});

test("an unassessable follow-up remains visible over an initial pending copy", () => {
  const { analysis, pending } = sequence();
  const missing = settlePaperObservation(pending, followup(analysis, day("2026-09-30", 150.7, 151.5, 150.5, 151)), { now: closeTime("2026-09-30") });
  assert.equal(missing.status, "NOT_ASSESSED");
  assert.deepEqual(mergePaperObservationCopies(missing, pending), missing);
  assert.deepEqual(mergePaperObservationCopies(pending, missing), missing);
});

test("an unassessable follow-up cannot erase a known entry or final result", () => {
  const { analysis, pending, openOne, closed } = sequence();
  const missing = settlePaperObservation(pending, followup(analysis, day("2026-09-30", 150.7, 151.5, 150.5, 151)), { now: closeTime("2026-09-30") });
  for (const assessed of [openOne, closed]) {
    assert.deepEqual(mergePaperObservationCopies(missing, assessed), assessed);
    assert.deepEqual(mergePaperObservationCopies(assessed, missing), assessed);
  }
});

test("conflicting locked fields, simulated entries, and final outcomes stop reconciliation", () => {
  const { analysis, pending, openOne, closed, first, second, third } = sequence();
  assert.throws(() => mergePaperObservationCopies(pending, { ...pending, quantity: 3 }), /låsta signaluppgifter/);
  const otherOpen = settlePaperObservation(pending, followup(analysis, { ...first, open: 149.8 }), { now: closeTime(first.datetime) });
  assert.equal(otherOpen.status, "PENDING_OPEN");
  assert.throws(() => mergePaperObservationCopies(openOne, otherOpen), /ingångar/);
  const otherClose = settlePaperObservation(pending, followup(analysis, first, second, { ...third, close: 151.8 }), { now: closeTime(third.datetime) });
  assert.equal(otherClose.status, "CLOSED");
  assert.notEqual(otherClose.netPnl, closed.netPnl);
  assert.throws(() => mergePaperObservationCopies(closed, otherClose), /slutliga utfall/);
});

test("a rejected next opening may supersede pending, but cannot coexist with an open simulation", () => {
  const { analysis, pending, openOne } = sequence();
  const rejected = settlePaperObservation(pending, followup(analysis, day("2026-09-29", 147, 150, 146, 149)), { now: closeTime("2026-09-29") });
  assert.equal(rejected.status, "REJECTED_ENTRY");
  assert.deepEqual(mergePaperObservationCopies(pending, rejected), rejected);
  assert.throws(() => mergePaperObservationCopies(openOne, rejected), /oförenliga/);
});

test("list merge keeps local order, adds remote records, and rejects duplicates", () => {
  const { pending, closed } = sequence();
  const second = { ...pending, id: "paper:TEST-analysis-2:BREAKOUT", sourceAnalysisTradeId: "TEST-analysis-2" };
  assert.ok(validatePaperObservation(second));
  assert.deepEqual(mergePaperObservationLists([pending], [closed, second]), [closed, second]);
  assert.throws(() => mergePaperObservationLists([pending, pending], []), /dubbla/);
  assert.throws(() => mergePaperObservationLists([], [second, second]), /dubbla/);
});
