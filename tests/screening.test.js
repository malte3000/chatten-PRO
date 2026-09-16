import test from "node:test";
import assert from "node:assert/strict";
import { ema, screenInstrument, rankCandidates } from "../src/screening.js";

const now = Date.parse("2026-09-16T16:00:00Z");
const instrument = { symbol: "NVDA", exchange: "NASDAQ", currency: "USD" };
const bars = Array.from({ length: 100 }, (_, index) => {
  const close = 50 + index;
  return { datetime: new Date(now - (99 - index) * 86400000).toISOString().slice(0, 10), open: close - 0.5, high: close + 1, low: close - 1, close, volume: index === 99 ? 2e6 : 1e6 };
});
const data = { ticker: "NVDA", bars };

test("EMA uses an SMA seed and is reproducible", () => {
  assert.equal(ema([1, 2, 3, 4], 3), 3);
  assert.equal(ema([1, 2], 3), null);
});
test("positive candidate passes experimental filters but cannot become TRADE", () => {
  const result = screenInstrument(instrument, data, { now });
  assert.equal(result.status, "WAIT");
  assert.equal(result.metrics.atr, 2);
  assert.equal(result.metrics.rvol, 2);
  assert.ok(result.metrics.ema20 > result.metrics.ema50);
  assert.equal(result.rank_score, 4);
  assert.deepEqual(result, screenInstrument(instrument, structuredClone(data), { now }));
});
test("wrong ticker, insufficient bars, and missing volume fail closed", () => {
  for (const value of [{ ...data, ticker: "AMD" }, { ...data, bars: bars.slice(-30) }, { ...data, bars: bars.map((bar) => ({ ...bar, volume: null })) }]) {
    assert.equal(screenInstrument(instrument, value, { now }).status, "NO_TRADE");
  }
});
test("old or future timestamps are rejected", () => {
  for (const clock of [now + 8 * 86400000, now - 86400000]) assert.equal(screenInstrument(instrument, data, { now: clock }).status, "NO_TRADE");
});
test("falling prices and low liquidity cannot pass", () => {
  const falling = bars.map((bar, index) => ({ ...bar, open: 199 - index, close: 199 - index, high: 200 - index, low: 198 - index }));
  assert.equal(screenInstrument(instrument, { ...data, bars: falling }, { now }).status, "NO_TRADE");
  const lowVolume = bars.map((bar) => ({ ...bar, volume: bar.volume / 1e5 }));
  assert.equal(screenInstrument(instrument, { ...data, bars: lowVolume }, { now }).status, "NO_TRADE");
});
test("ranking is stable and leaves original results untouched", () => {
  const items = [{ symbol: "Z", exchange: "NYSE", status: "NO_TRADE", rank_score: 4 }, { symbol: "B", exchange: "NYSE", status: "WAIT", rank_score: 3 }, { symbol: "A", exchange: "NYSE", status: "WAIT", rank_score: 3 }];
  assert.deepEqual(rankCandidates(items).map((item) => item.symbol), ["A", "B", "Z"]);
  assert.equal(items[0].symbol, "Z");
});
