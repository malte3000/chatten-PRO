import test from "node:test";
import assert from "node:assert/strict";
import { ema, screenInstrument, rankCandidates } from "../src/screening.js";

const now = Date.parse("2026-09-16T16:00:00Z");
const instrument = { symbol: "NVDA", exchange: "NASDAQ", currency: "USD" };
const bars = Array.from({ length: 100 }, (_, index) => {
  const close = 50 + index;
  return { datetime: new Date(now - (100 - index) * 86400000).toISOString().slice(0, 10), open: close - 0.5, high: close + 1, low: close - 1, close, volume: index === 99 ? 2e6 : 1e6 };
});
const data = { ticker: "NVDA", interval: "1day", timezone: "America/New_York", bars };
const swingOptions = { market: "usa", now };

test("EMA uses an SMA seed and is reproducible", () => {
  assert.equal(ema([1, 2, 3, 4], 3), 3);
  assert.equal(ema([1, 2], 3), null);
});
test("positive candidate passes experimental filters but cannot become TRADE", () => {
  const result = screenInstrument(instrument, data, swingOptions);
  assert.equal(result.status, "WAIT");
  assert.equal(result.metrics.atr, 2);
  assert.equal(result.metrics.rvol, 2);
  assert.ok(result.metrics.ema20 > result.metrics.ema50);
  assert.equal(result.rank_score, 4);
  assert.deepEqual(result, screenInstrument(instrument, structuredClone(data), swingOptions));
});
test("wrong ticker, insufficient bars, and missing volume fail closed", () => {
  for (const value of [{ ...data, ticker: "AMD" }, { ...data, bars: bars.slice(-30) }, { ...data, bars: bars.map((bar) => ({ ...bar, volume: null })) }]) {
    assert.equal(screenInstrument(instrument, value, swingOptions).status, "NO_TRADE");
  }
});
test("old or future timestamps are rejected", () => {
  for (const clock of [now + 8 * 86400000, now - 2 * 86400000]) assert.equal(screenInstrument(instrument, data, { market: "usa", now: clock }).status, "NO_TRADE");
});
test("swing screen discards an unfinished daily candle and uses it only after close", () => {
  const current = { datetime: "2026-09-16", open: 150, high: 151, low: 149, close: 150, volume: 100 };
  const withCurrent = { ...data, bars: [...bars, current] };
  const open = screenInstrument(instrument, withCurrent, swingOptions);
  assert.equal(open.status, "WAIT");
  assert.equal(open.metrics.latest_datetime, "2026-09-15");
  assert.equal(open.metrics.rvol, 2);
  assert.equal(open.screening_selection.excluded_current_session, true);
  assert.equal(withCurrent.bars.length, 101);
  const unfinishedWithoutVolume = screenInstrument(instrument, { ...data, bars: [...bars, { ...current, volume: 0, high: 149 }] }, swingOptions);
  assert.equal(unfinishedWithoutVolume.status, "WAIT");
  assert.equal(unfinishedWithoutVolume.metrics.latest_datetime, "2026-09-15");

  const closed = screenInstrument(instrument, withCurrent, { market: "usa", now: Date.parse("2026-09-16T21:00:00Z") });
  assert.equal(closed.status, "NO_TRADE");
  assert.equal(closed.metrics.latest_datetime, "2026-09-16");
  assert.equal(closed.screening_selection.excluded_current_session, false);
  assert.ok(closed.reasons.includes("Senaste candle har inte förhöjd volym."));
});
test("swing screen fails closed without matching exchange timezone or market clock", () => {
  for (const variant of [
    { marketData: { ...data, timezone: null }, options: swingOptions },
    { marketData: { ...data, timezone: "Europe/Stockholm" }, options: swingOptions },
    { marketData: data, options: { now } },
    { marketData: data, options: { market: "usa", now: Number.NaN } },
  ]) {
    const result = screenInstrument(instrument, variant.marketData, variant.options);
    assert.equal(result.status, "NO_TRADE");
    assert.equal(result.metrics, null);
  }
});
test("falling prices and low liquidity cannot pass", () => {
  const falling = bars.map((bar, index) => ({ ...bar, open: 199 - index, close: 199 - index, high: 200 - index, low: 198 - index }));
  assert.equal(screenInstrument(instrument, { ...data, bars: falling }, swingOptions).status, "NO_TRADE");
  const lowVolume = bars.map((bar) => ({ ...bar, volume: bar.volume / 1e5 }));
  assert.equal(screenInstrument(instrument, { ...data, bars: lowVolume }, swingOptions).status, "NO_TRADE");
});
test("ranking is stable and leaves original results untouched", () => {
  const items = [{ symbol: "Z", exchange: "NYSE", status: "NO_TRADE", rank_score: 4 }, { symbol: "B", exchange: "NYSE", status: "WAIT", rank_score: 3 }, { symbol: "A", exchange: "NYSE", status: "WAIT", rank_score: 3 }];
  assert.deepEqual(rankCandidates(items).map((item) => item.symbol), ["A", "B", "Z"]);
  assert.equal(items[0].symbol, "Z");
});
