import test from "node:test";
import assert from "node:assert/strict";
import { evaluateReadiness, createAnalysisRecord } from "../src/analysisModel.js";

const marketData = {
  ticker: "NVDA", price: 100, validation: { valid: true },
  bars: [{ datetime: "2026-09-16", open: 99, high: 101, low: 98, close: 100, volume: 1000 }],
};
const news = { ticker: "NVDA", direction: "upp", direction_confidence: 100 };
const input = { ticker: "NVDA", marketData, news };

test("AI confidence of 100 cannot approve TRADE", () => assert.equal(evaluateReadiness(input).status, "WAIT"));
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
  assert.equal(evaluateReadiness({ ...input, news: { ...news, direction: "ner", direction_confidence: 30 } }).status, "NO_TRADE");
});
test("same inputs produce identical decisions", () => assert.deepEqual(evaluateReadiness(input), evaluateReadiness(structuredClone(input))));
test("analysis observations retain WAIT but are not actual trades", () => {
  const record = createAnalysisRecord({ ...input, horizon: "week", market: "usa", decision: evaluateReadiness(input) }, { now: new Date("2026-09-16T12:00:00Z"), id: "fixed" });
  assert.equal(record.signal_inputs.decision.status, "WAIT");
  assert.equal(record.signal_inputs.record_type, "ANALYSIS");
  assert.equal(record.signal, "NO_TRADE");
  assert.equal(record.entry_price, null);
  assert.equal(record.winner, null);
  assert.equal(record.confidence, 0);
  assert.equal(record.trade_id, "NVDA-fixed");
});
