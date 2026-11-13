import test from "node:test";
import assert from "node:assert/strict";
import { READINESS_VERSION, evaluateReadiness, createAnalysisRecord, createRealTradeRecord } from "../src/analysisModel.js";
import { assessSwingSetup, SWING_STRATEGY_VERSION } from "../src/strategyModel.js";
import { screenInstrument } from "../src/screening.js";

const now = Date.parse("2026-09-28T21:00:00Z");
const marketStatus = {
  market: "usa", isOpen: false, reason: "after_close", sessionDate: "2026-09-28",
  timeZone: "America/New_York", earlyClose: false,
};

function makeBars() {
  const dates = [];
  let day = new Date("2026-09-28T00:00:00Z");
  while (dates.length < 100) {
    if (![0, 6].includes(day.getUTCDay())) dates.unshift(day.toISOString().slice(0, 10));
    day = new Date(day.getTime() - 86400000);
  }
  const bars = dates.map((datetime, index) => {
    const close = 50 + index;
    return { datetime, open: close - 0.3, high: close + 0.5, low: close - 0.5, close, volume: 1_000_000 };
  });
  bars.at(-1).low = 139.8;
  return bars;
}

function inputFor(bars = makeBars()) {
  const marketData = {
    ticker: "NVDA", requested_ticker: "NVDA", exchange: "NASDAQ", requested_exchange: "NASDAQ",
    currency: "USD", interval: "1day", timezone: "America/New_York", validation: { valid: true },
    verified_instrument: { symbol: "NVDA", name: "NVIDIA", exchange: "NASDAQ", currency: "USD", country: "United States", type: "Common Stock" },
    bars, latest: bars.at(-1), price: bars.at(-1).close,
  };
  return {
    ticker: "NVDA", market: "usa", horizonCode: "week", marketStatus,
    evaluatedAt: new Date(now).toISOString(), marketData, now,
    strategy: assessSwingSetup(marketData, { ticker: "NVDA", marketStatus, now }),
  };
}

const statusOf = (input) => evaluateReadiness(input).status;

test("a fresh assessed swing setup emits an unfilled TRADE signal with a version and reasons", () => {
  const input = inputFor();
  assert.equal(input.strategy.status, "WATCH");
  assert.ok(input.strategy.setups.includes("PULLBACK"));
  const decision = evaluateReadiness(input);
  assert.equal(decision.status, "TRADE");
  assert.equal(decision.version, READINESS_VERSION);
  assert.deepEqual(decision.reason_codes, ["SWING_SETUP_CONFIRMED"]);
  assert.match(decision.reasons.join(" "), /ingen affär har genomförts/i);
  assert.equal(statusOf({ ...input, news: { direction: "ner", direction_confidence: 99 } }), "TRADE");
  assert.equal(statusOf({ ...input, news: { direction: "upp", direction_confidence: 99 } }), "TRADE");
});

test("a genuine NO_SETUP produces NO_TRADE", () => {
  const bars = makeBars();
  bars.at(-1).low = 148.5;
  const input = inputFor(bars);
  assert.equal(input.strategy.status, "NO_SETUP");
  const decision = evaluateReadiness(input);
  assert.equal(decision.status, "NO_TRADE");
  assert.deepEqual(decision.reason_codes, ["SWING_NO_SETUP"]);
});

test("manual TRADE and scanner agree on the same viability thresholds", () => {
  const normal = inputFor();
  const illiquidBars = makeBars().map((bar) => ({ ...bar, volume: 1_000 }));
  const illiquid = inputFor(illiquidBars);
  const highAtrBars = makeBars().map((bar) => ({ ...bar, high: bar.close + 20, low: bar.close - 20 }));
  const highAtr = inputFor(highAtrBars);
  const lowAtrBars = makeBars().map((bar, index) => {
    const close = 1_000 + index * 0.1;
    return { ...bar, open: close - 0.03, high: close + 0.05, low: close - 0.05, close };
  });
  lowAtrBars.at(-1).low = 1_008.95;
  const lowAtr = inputFor(lowAtrBars);
  const cases = [
    [normal, "TRADE", "TRADE", null],
    [illiquid, "NO_TRADE", "NO_TRADE", "LIQUIDITY_BELOW_MINIMUM"],
    [highAtr, "NO_TRADE", "NO_TRADE", "ATR_OUT_OF_RANGE"],
    [lowAtr, "NO_TRADE", "NO_TRADE", "ATR_OUT_OF_RANGE"],
  ];
  for (const [input, decisionStatus, scanStatus, reason] of cases) {
    assert.equal(input.strategy.status, "WATCH");
    const decision = evaluateReadiness(input);
    const screen = screenInstrument({ symbol: "NVDA", exchange: "NASDAQ", currency: "USD", country: "United States", type: "Common Stock" },
      input.marketData, { market: "usa", horizon: "week", now });
    assert.equal(decision.status, decisionStatus);
    assert.equal(screen.status, scanStatus);
    if (reason) assert.ok(decision.reason_codes.includes(reason));
  }
});

test("the additional range breakout and rebound families can independently emit a swing signal", () => {
  const rangeBars = makeBars();
  for (const [offset, close] of [144.5, 144.6, 144.7].entries()) {
    rangeBars[96 + offset] = { ...rangeBars[96 + offset], open: close - 0.3, high: close + 0.5, low: close - 0.5, close };
  }
  rangeBars[99] = { ...rangeBars[99], open: 144.9, high: 145.8, low: 144.8, close: 145.3 };
  const reboundBars = makeBars();
  for (const [offset, close] of [138, 136, 133].entries()) {
    reboundBars[96 + offset] = { ...reboundBars[96 + offset], open: close - 0.3, high: close + 0.5, low: close - 0.5, close };
  }
  reboundBars[99] = { ...reboundBars[99], open: 132, high: 134.5, low: 131.5, close: 134 };
  for (const [bars, setup] of [[rangeBars, "RANGE_BREAKOUT"], [reboundBars, "REBOUND"]]) {
    const input = inputFor(bars);
    assert.deepEqual(input.strategy.setups, [setup]);
    assert.equal(statusOf(input), "TRADE");
  }
});

test("a supported Stockholm/SEK instrument uses its own market clock and turnover threshold", () => {
  const usa = inputFor();
  const stockholmClock = { ...marketStatus, market: "stockholm", timeZone: "Europe/Stockholm" };
  const marketData = { ...usa.marketData, ticker: "TESTA", requested_ticker: "TESTA", currency: "SEK", exchange: "OMX", requested_exchange: "OMX", timezone: "Europe/Stockholm", verified_instrument: { symbol: "TESTA", name: "Testbolag", exchange: "OMX", currency: "SEK", country: "Sweden", type: "Common Stock" } };
  const input = {
    ...usa, ticker: "TESTA", market: "stockholm", marketStatus: stockholmClock, marketData,
    strategy: assessSwingSetup(marketData, { ticker: "TESTA", marketStatus: stockholmClock, now }),
  };
  assert.equal(input.strategy.status, "WATCH");
  assert.equal(statusOf(input), "TRADE");
});

test("an unfinished current candle is excluded before validating the completed swing signal", () => {
  const base = inputFor();
  const nextNow = Date.parse("2026-09-29T15:00:00Z");
  const nextClock = { ...marketStatus, isOpen: true, reason: "open", sessionDate: "2026-09-29" };
  const unfinished = { datetime: "2026-09-29", open: 150, high: 1, low: 149, close: 150, volume: 0 };
  const data = { ...base.marketData, bars: [...base.marketData.bars, unfinished] };
  const strategy = assessSwingSetup(data, { ticker: "NVDA", marketStatus: nextClock, now: nextNow });
  assert.equal(strategy.status, "WATCH");
  assert.equal(statusOf({ ...base, now: nextNow, marketStatus: nextClock, marketData: data, strategy }), "TRADE");
});

test("upstream, data and exchange-clock failures are not mistaken for NO_TRADE", () => {
  const input = inputFor();
  const cases = [
    [{ ...input, errors: ["Provider unavailable"] }, "UPSTREAM_ERROR"],
    [{ ...input, marketData: null }, "MARKET_DATA_INVALID"],
    [{ ...input, marketData: { ...input.marketData, ticker: "AMD" } }, "MARKET_DATA_INVALID"],
    [{ ...input, marketData: { ...input.marketData, validation: { valid: false } } }, "MARKET_DATA_INVALID"],
    [{ ...input, marketData: { ...input.marketData, currency: "EUR" } }, "CURRENCY_UNSUPPORTED"],
    [{ ...input, marketData: { ...input.marketData, verified_instrument: null } }, "INSTRUMENT_UNVERIFIED"],
    [{ ...input, marketData: { ...input.marketData, verified_instrument: { ...input.marketData.verified_instrument, type: "ETF" } } }, "INSTRUMENT_UNVERIFIED"],
    [{ ...input, marketData: { ...input.marketData, price: 200 } }, "PRICE_INVALID"],
    [{ ...input, marketStatus: null }, "MARKET_CLOCK_UNVERIFIED"],
    [{ ...input, market: "off" }, "MARKET_CLOCK_UNVERIFIED"],
    [{ ...input, marketStatus: { ...marketStatus, isOpen: true } }, "CLOSED_BARS_UNVERIFIED"],
    [{ ...input, marketStatus: { ...marketStatus, sessionDate: "2026-09-29" }, now: Date.parse("2026-09-29T21:00:00Z") }, "CLOSED_BARS_UNVERIFIED"],
  ];
  for (const [candidate, reason] of cases) {
    const decision = evaluateReadiness(candidate);
    assert.equal(decision.status, "NOT_ASSESSED", reason);
    assert.ok(decision.reason_codes.includes(reason));
  }
});

test("an unsupported or stale strategy cannot turn a valid price series into TRADE", () => {
  const input = inputFor();
  const cases = [
    [{ ...input, strategy: null }, "SWING_NOT_ASSESSED"],
    [{ ...input, strategy: { ...input.strategy, status: "NOT_ASSESSED" } }, "SWING_NOT_ASSESSED"],
    [{ ...input, strategy: { ...input.strategy, version: "swing-old" } }, "STRATEGY_VERSION_INVALID"],
    [{ ...input, strategy: { ...input.strategy, status: "UNKNOWN" } }, "STRATEGY_STATUS_INVALID"],
    [{ ...input, strategy: { ...input.strategy, setups: ["UNKNOWN"], plans: input.strategy.plans } }, "STRATEGY_SNAPSHOT_MISMATCH"],
    [{ ...input, strategy: { ...input.strategy, plans: [] } }, "STRATEGY_SNAPSHOT_MISMATCH"],
    [{ ...input, strategy: { ...input.strategy, metrics: { ...input.strategy.metrics, latest_closed_candle: "2026-09-25" } } }, "STRATEGY_SNAPSHOT_MISMATCH"],
    [{ ...input, strategy: { ...input.strategy, plans: [{ ...input.strategy.plans[0], stop: input.strategy.plans[0].entry_reference }] } }, "STRATEGY_SNAPSHOT_MISMATCH"],
  ];
  for (const [candidate, reason] of cases) {
    const decision = evaluateReadiness(candidate);
    assert.equal(decision.status, "NOT_ASSESSED", reason);
    assert.deepEqual(decision.reason_codes, [reason]);
  }
});

test("day mode without an assessed daily swing setup stays unassessed", () => {
  const input = inputFor();
  const dayWithDailyData = evaluateReadiness({ ...input, horizonCode: "day" });
  assert.equal(dayWithDailyData.status, "NOT_ASSESSED");
  assert.deepEqual(dayWithDailyData.reason_codes, ["HORIZON_UNSUPPORTED"]);
  assert.equal(statusOf({ ...input, horizonCode: "day", marketData: { ...input.marketData, interval: "15min" }, strategy: null }), "NOT_ASSESSED");
  assert.equal(statusOf({ ...input, horizonCode: undefined }), "NOT_ASSESSED");
});

test("a TRADE analysis journal row is signal-only and keeps its locked plan separate from an actual fill", () => {
  const input = inputFor();
  const decision = evaluateReadiness(input);
  const record = createAnalysisRecord({ ...input, horizon: "week", decision }, { now: new Date(now), id: "fixed" });
  assert.equal(record.strategy_version, SWING_STRATEGY_VERSION);
  assert.equal(record.trade_id, "NVDA-fixed");
  assert.equal(record.signal, "BUY");
  assert.equal(record.direction, "LONG");
  assert.equal(record.trade_status, "SIGNAL_ONLY");
  assert.equal(record.signal_inputs.record_type, "ANALYSIS");
  assert.deepEqual(record.signal_inputs.decision, decision);
  assert.deepEqual(record.signal_inputs.signal_plan, input.strategy.plans[0]);
  assert.deepEqual(record.signal_inputs.market_status, marketStatus);
  assert.equal(record.signal_inputs.horizon_code, "week");
  assert.equal(record.signal_inputs.evaluated_at, new Date(now).toISOString());
  assert.equal(record.entry_price, null);
  assert.equal(record.position_size, undefined);
  assert.equal(record.winner, null);
  assert.equal(record.result_percent, null);
  assert.equal(record.confidence, 0);
  assert.equal(record.signal_inputs.probability_calibrated, false);
  const actual = createRealTradeRecord({
    analysis: { ...input, horizon: "week", decision, record }, direction: "LONG",
    entryPrice: 150, stopLoss: 145, target: 160, positionSize: 2, fees: 1,
  }, { now: new Date(now + 60000), id: "actual" });
  assert.equal(actual.signal_inputs.record_type, "REAL_TRADE");
  assert.equal(actual.signal_inputs.source_analysis_trade_id, record.trade_id);
  assert.equal(actual.trade_status, "OPEN");
  assert.equal(actual.entry_price, 150);
});

test("NO_SETUP and unassessed analyses retain schema-compatible non-trade fields", () => {
  const bars = makeBars(); bars.at(-1).low = 148.5;
  const noSetup = inputFor(bars);
  const noSetupRecord = createAnalysisRecord({ ...noSetup, decision: evaluateReadiness(noSetup) }, { now: new Date(now), id: "no-setup" });
  const unassessed = { ...inputFor(), errors: ["Provider unavailable"] };
  const unassessedRecord = createAnalysisRecord({ ...unassessed, decision: evaluateReadiness(unassessed) }, { now: new Date(now), id: "unassessed" });
  for (const record of [noSetupRecord, unassessedRecord]) {
    assert.equal(record.signal, "NO_TRADE");
    assert.equal(record.direction, "NONE");
    assert.equal(record.trade_status, "NO_TRADE");
    assert.equal(record.signal_inputs.signal_plan, null);
    assert.equal(record.winner, null);
  }
  assert.equal(unassessedRecord.signal_inputs.decision.status, "NOT_ASSESSED");
  assert.notDeepEqual(noSetupRecord.signal_inputs.decision.reason_codes, unassessedRecord.signal_inputs.decision.reason_codes);
});

test("identical inputs yield identical readiness results", () => {
  const input = inputFor();
  assert.deepEqual(evaluateReadiness(input), evaluateReadiness(structuredClone(input)));
});
