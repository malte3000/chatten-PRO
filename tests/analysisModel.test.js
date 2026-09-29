import test from "node:test";
import assert from "node:assert/strict";
import { READINESS_VERSION, evaluateReadiness, createAnalysisRecord, createRealTradeRecord } from "../src/analysisModel.js";

const marketData = {
  ticker: "NVDA", price: 100, validation: { valid: true },
  bars: [{ datetime: "2026-09-16", open: 99, high: 101, low: 98, close: 100, volume: 1000 }],
};
const news = { ticker: "NVDA", direction: "upp", direction_confidence: 100 };
const input = { ticker: "NVDA", marketData, news };

test("AI confidence of 100 cannot approve TRADE", () => assert.equal(evaluateReadiness(input).status, "WAIT"));
test("swing WATCH is only a measurable WAIT candidate, never TRADE", () => {
  const decision = evaluateReadiness({ ...input, strategy: { version: "swing-v-test", status: "WATCH", setups: ["BREAKOUT"] } });
  assert.equal(decision.status, "WAIT");
  assert.deepEqual(decision.reason_codes, ["NEWS_SUPPORTIVE", "SWING_WATCH_UNVALIDATED"]);
  assert.match(decision.reasons[1], /TRADE är spärrat/);
});
test("missing swing setup and unassessed setup fail closed for distinct reasons", () => {
  const noSetup = evaluateReadiness({ ...input, strategy: { status: "NO_SETUP", setups: [] } });
  const unassessed = evaluateReadiness({ ...input, strategy: { status: "NOT_ASSESSED", setups: [] } });
  assert.equal(noSetup.status, "NO_TRADE");
  assert.deepEqual(noSetup.reason_codes, ["SWING_NO_SETUP"]);
  assert.equal(unassessed.status, "NO_TRADE");
  assert.deepEqual(unassessed.reason_codes, ["SWING_NOT_ASSESSED"]);
  assert.notDeepEqual(noSetup.reasons, unassessed.reasons);
});
test("unknown strategy status cannot become a candidate", () => {
  const decision = evaluateReadiness({ ...input, strategy: { status: "UNKNOWN" } });
  assert.equal(decision.status, "NO_TRADE");
  assert.deepEqual(decision.reason_codes, ["STRATEGY_STATUS_INVALID"]);
});
test("no swing strategy, such as day mode, retains readiness WAIT without implying TRADE", () => {
  const decision = evaluateReadiness({ ...input, horizon: "samma handelsdag", strategy: null });
  assert.equal(decision.status, "WAIT");
  assert.deepEqual(decision.reason_codes, ["NEWS_SUPPORTIVE", "NO_VALIDATED_STRATEGY"]);
  assert.match(decision.reasons[1], /Validerad signalmotor, riskmotor och utvärderad edge saknas/);
});
test("every readiness outcome carries the same explicit decision version", () => {
  const cases = [
    input,
    { ...input, strategy: { status: "WATCH" } },
    { ...input, strategy: { status: "NO_SETUP" } },
    { ...input, strategy: { status: "NOT_ASSESSED" } },
    { ...input, strategy: { status: "UNKNOWN" } },
    { ...input, news: { ...news, direction: "ner" } },
    { ...input, marketData: null, errors: ["Provider unavailable"] },
  ];
  for (const candidate of cases) assert.equal(evaluateReadiness(candidate).version, READINESS_VERSION);
});
test("turning market control off cannot approve TRADE or bypass missing data", () => {
  assert.equal(evaluateReadiness({ ...input, market: "off" }).status, "WAIT");
  assert.equal(evaluateReadiness({ ...input, market: "off", marketData: null }).status, "NO_TRADE");
});
test("missing, mismatched and invalid market data fail closed", () => {
  for (const data of [null, { ...marketData, ticker: "AMD" }, { ...marketData, price: null }, { ...marketData, bars: [{ ...marketData.bars[0], low: 200 }] }]) {
    assert.equal(evaluateReadiness({ ...input, marketData: data }).status, "NO_TRADE");
  }
});
test("stale news or API errors fail closed", () => {
  assert.equal(evaluateReadiness({ ...input, news: { ...news, ticker: "AMD" } }).status, "NO_TRADE");
  assert.equal(evaluateReadiness({ ...input, errors: ["Provider unavailable"] }).status, "NO_TRADE");
});
test("bearish news never becomes bullish because confidence is low", () => {
  const decision = evaluateReadiness({ ...input, news: { ...news, direction: "ner", direction_confidence: 30 }, strategy: { status: "WATCH" } });
  assert.equal(decision.status, "NO_TRADE");
  assert.deepEqual(decision.reason_codes, ["NEWS_BEARISH"]);
});
test("same inputs produce identical decisions", () => assert.deepEqual(evaluateReadiness(input), evaluateReadiness(structuredClone(input))));
test("analysis observations retain WAIT but are not actual trades", () => {
  const record = createAnalysisRecord({ ...input, horizon: "week", market: "usa", decision: evaluateReadiness(input) }, { now: new Date("2026-09-16T12:00:00Z"), id: "fixed" });
  assert.equal(record.signal_inputs.decision.status, "WAIT");
  assert.equal(record.signal_inputs.decision.version, READINESS_VERSION);
  assert.deepEqual(record.signal_inputs.decision.reason_codes, ["NEWS_SUPPORTIVE", "NO_VALIDATED_STRATEGY"]);
  assert.equal(record.signal_inputs.record_type, "ANALYSIS");
  assert.equal(record.signal, "NO_TRADE");
  assert.equal(record.entry_price, null);
  assert.equal(record.winner, null);
  assert.equal(record.confidence, 0);
  assert.equal(record.trade_id, "NVDA-fixed");
});

test("analysis and manually logged trade retain experimental strategy version and source", () => {
  const strategy = { version: "swing-v-test", status: "WATCH", setups: ["PULLBACK"] };
  const record = createAnalysisRecord({ ...input, horizon: "week", market: "usa", decision: evaluateReadiness(input), strategy }, { now: new Date("2026-09-16T12:00:00Z"), id: "fixed" });
  assert.equal(record.strategy_version, "swing-v-test");
  const trade = createRealTradeRecord({ analysis: { ticker: "NVDA", horizon: "week", market: "usa", strategy, record, marketData }, direction: "LONG", entryPrice: 100, stopLoss: 95, target: 110, positionSize: 2, fees: 1 }, { now: new Date("2026-09-16T12:01:00Z"), id: "real" });
  assert.equal(trade.strategy_version, "swing-v-test");
  assert.equal(trade.signal_inputs.source_analysis_trade_id, record.trade_id);
  assert.deepEqual(trade.signal_inputs.strategy, strategy);
});
