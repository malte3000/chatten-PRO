import test from "node:test";
import assert from "node:assert/strict";
import { ema, screenInstrument, rankCandidates } from "../src/screening.js";
import { assessSwingSetup } from "../src/strategyModel.js";

const now = Date.parse("2026-09-16T16:00:00Z");
const instrument = { symbol: "NVDA", exchange: "NASDAQ", currency: "USD", country: "United States", type: "Common Stock" };
const bars = Array.from({ length: 100 }, (_, index) => {
  const close = 50 + index;
  return { datetime: new Date(now - (100 - index) * 86400000).toISOString().slice(0, 10), open: close - 0.5, high: close + 1, low: close - 1, close, volume: index === 99 ? 2e6 : 1e6 };
});
bars[99] = { ...bars[99], close: 150, high: 151 };
const data = { ticker: "NVDA", interval: "1day", timezone: "America/New_York", bars };
const swingOptions = { market: "usa", now };
const marketStatus = { market: "usa", isOpen: true, reason: "open", sessionDate: "2026-09-16" };

test("EMA uses an SMA seed and is reproducible", () => {
  assert.equal(ema([1, 2, 3, 4], 3), 3);
  assert.equal(ema([1, 2], 3), null);
});
test("completed 20-day breakout emits one experimental, unfilled swing TRADE signal", () => {
  const result = screenInstrument(instrument, data, swingOptions);
  assert.equal(result.status, "TRADE");
  assert.equal(result.decision.status, "TRADE");
  assert.equal(result.primary_setup, "BREAKOUT");
  assert.equal(result.signal_plan.setup, "BREAKOUT");
  assert.ok(result.metrics.atr > 2);
  assert.equal(result.metrics.rvol, 2);
  assert.ok(result.metrics.ema20 > result.metrics.ema50);
  assert.equal(result.rank_score, 4);
  assert.deepEqual(result.screening_setups, ["BREAKOUT"]);
  assert.ok(assessSwingSetup(data, { ticker: "NVDA", marketStatus, now }).setups.includes("BREAKOUT"));
  assert.deepEqual(result, screenInstrument(instrument, structuredClone(data), swingOptions));
});
test("wrong ticker, insufficient bars, and missing volume are not assessed", () => {
  for (const [value, dataIssue] of [
    [{ ...data, ticker: "AMD" }, "INSTRUMENT_MISMATCH"],
    [{ ...data, bars: bars.slice(-30) }, "INSUFFICIENT_BARS"],
    [{ ...data, bars: bars.map((bar) => ({ ...bar, volume: null })) }, "UNRELIABLE_VOLUME"],
  ]) {
    const result = screenInstrument(instrument, value, swingOptions);
    assert.equal(result.status, "NOT_ASSESSED");
    assert.equal(result.data_issue, dataIssue);
    assert.equal(result.metrics, null);
  }
});
test("old or future timestamps are rejected", () => {
  for (const clock of [now + 8 * 86400000, now - 2 * 86400000]) {
    const result = screenInstrument(instrument, data, { market: "usa", now: clock });
    assert.equal(result.status, "NOT_ASSESSED");
    assert.ok(result.data_issue);
  }
});
test("a missing just-closed daily session cannot become a swing candidate", () => {
  const result = screenInstrument(instrument, data, { market: "usa", now: Date.parse("2026-09-16T21:00:00Z") });
  assert.equal(result.status, "NOT_ASSESSED");
  assert.match(result.reasons.join(" "), /2026-09-16/);
});
test("swing screen discards an unfinished daily candle and uses it only after close", () => {
  const current = { datetime: "2026-09-16", open: 150, high: 151, low: 149, close: 150, volume: 100 };
  const withCurrent = { ...data, bars: [...bars, current] };
  const open = screenInstrument(instrument, withCurrent, swingOptions);
  assert.equal(open.status, "TRADE");
  assert.equal(open.metrics.latest_datetime, "2026-09-15");
  assert.equal(open.metrics.rvol, 2);
  assert.equal(open.screening_selection.excluded_current_session, true);
  assert.equal(withCurrent.bars.length, 101);
  const unfinishedWithoutVolume = screenInstrument(instrument, { ...data, bars: [...bars, { ...current, volume: 0, high: 149 }] }, swingOptions);
  assert.equal(unfinishedWithoutVolume.status, "TRADE");
  assert.equal(unfinishedWithoutVolume.metrics.latest_datetime, "2026-09-15");

  const closed = screenInstrument(instrument, withCurrent, { market: "usa", now: Date.parse("2026-09-16T21:00:00Z") });
  assert.equal(closed.status, "NO_TRADE");
  assert.equal(closed.metrics.latest_datetime, "2026-09-16");
  assert.equal(closed.screening_selection.excluded_current_session, false);
  assert.ok(closed.reasons.some((reason) => reason.includes("Ingen pullback-, breakout-, range breakout- eller reboundregel")));
});
test("swing screen fails closed without matching exchange timezone or market clock", () => {
  for (const variant of [
    { marketData: { ...data, timezone: null }, options: swingOptions },
    { marketData: { ...data, timezone: "Europe/Stockholm" }, options: swingOptions },
    { marketData: data, options: { now } },
    { marketData: data, options: { market: "usa", now: Number.NaN } },
  ]) {
    const result = screenInstrument(instrument, variant.marketData, variant.options);
    assert.equal(result.status, "NOT_ASSESSED");
    assert.ok(result.data_issue);
    assert.equal(result.metrics, null);
  }
});
test("one unreliable historical volume bar is an unavailable assessment, not a filter rejection", () => {
  const historicalVolumeGap = bars.map((bar, index) => index === 12 ? { ...bar, volume: 0 } : bar);
  const result = screenInstrument(instrument, { ...data, bars: historicalVolumeGap }, swingOptions);
  assert.equal(result.status, "NOT_ASSESSED");
  assert.equal(result.data_issue, "UNRELIABLE_VOLUME");
  assert.equal(result.metrics, null);
  assert.match(result.reasons.join(" "), /volym/);
});
test("an ordinary rising swing trend without a pullback or volume-backed breakout remains NO_TRADE", () => {
  const ordinaryVolume = bars.map((bar, index) => ({ ...bar, volume: index === bars.length - 1 ? 8e5 : 1e6 }));
  const result = screenInstrument(instrument, { ...data, bars: ordinaryVolume }, swingOptions);
  assert.equal(result.status, "NO_TRADE");
  assert.equal(result.data_issue, null);
  assert.ok(result.metrics);
  assert.deepEqual(result.screening_setups, []);
  assert.deepEqual(result.reasons, ["Ingen pullback-, breakout-, range breakout- eller reboundregel uppfylldes."]);
  assert.equal(assessSwingSetup({ ...data, bars: ordinaryVolume }, { ticker: "NVDA", marketStatus, now }).status, "NO_SETUP");
});

test("scanner and individual analysis agree on a short range breakout", () => {
  const rangeBars = bars.map((bar) => ({ ...bar, volume: 1e6 }));
  for (const [offset, close] of [144.5, 144.6, 144.7].entries()) {
    rangeBars[96 + offset] = { ...rangeBars[96 + offset], open: close - 0.3, high: close + 0.5, low: close - 0.5, close };
  }
  rangeBars[99] = { ...rangeBars[99], open: 144.9, high: 145.8, low: 144.8, close: 145.3 };
  const candidateData = { ...data, bars: rangeBars };
  const scanned = screenInstrument(instrument, candidateData, swingOptions);
  const analyzed = assessSwingSetup(candidateData, { ticker: "NVDA", marketStatus, now });
  assert.equal(scanned.status, "TRADE");
  assert.deepEqual(scanned.screening_setups, ["RANGE_BREAKOUT"]);
  assert.deepEqual(scanned.screening_setups, analyzed.setups);
  assert.deepEqual(scanned.screening_plans, analyzed.plans);
});

test("scanner can discover a rebound despite negative short-term momentum", () => {
  const reboundBars = bars.map((bar) => ({ ...bar, volume: 1e6 }));
  for (const [offset, close] of [138, 136, 133].entries()) {
    reboundBars[96 + offset] = { ...reboundBars[96 + offset], open: close - 0.3, high: close + 0.5, low: close - 0.5, close };
  }
  reboundBars[99] = { ...reboundBars[99], open: 132, high: 134.5, low: 131.5, close: 134 };
  const candidateData = { ...data, bars: reboundBars };
  const scanned = screenInstrument(instrument, candidateData, swingOptions);
  const analyzed = assessSwingSetup(candidateData, { ticker: "NVDA", marketStatus, now });
  assert.equal(scanned.status, "TRADE");
  assert.ok(scanned.metrics.momentum_pct < 0);
  assert.deepEqual(scanned.screening_setups, ["REBOUND"]);
  assert.deepEqual(scanned.screening_setups, analyzed.setups);
  assert.deepEqual(scanned.screening_plans, analyzed.plans);
});

test("a valid EMA20 pullback with below-average volume remains a swing analysis candidate", () => {
  const pullbackBars = bars.map((bar, index) => index === bars.length - 1 ? { ...bar, low: 139.8, volume: 8e5 } : bar);
  const pullbackData = { ...data, bars: pullbackBars };
  const result = screenInstrument(instrument, pullbackData, swingOptions);
  assert.equal(result.status, "TRADE");
  assert.ok(result.metrics.rvol < 1);
  assert.deepEqual(result.screening_setups, ["PULLBACK"]);
  assert.deepEqual(assessSwingSetup(pullbackData, { ticker: "NVDA", marketStatus, now }).setups, ["PULLBACK"]);
});

test("a 20-day breakout uses prior median volume just like the swing strategy", () => {
  const breakoutBars = bars.map((bar, index) => ({ ...bar, volume: [85, 90].includes(index) ? 1e7 : index === 99 ? 1.3e6 : 1e6 }));
  const breakoutData = { ...data, bars: breakoutBars };
  const result = screenInstrument(instrument, breakoutData, swingOptions);
  assert.equal(result.status, "TRADE");
  assert.ok(result.metrics.rvol < 1);
  assert.ok(result.metrics.volume_vs_prior_median >= 1.2);
  assert.deepEqual(result.screening_setups, ["BREAKOUT"]);
  assert.deepEqual(assessSwingSetup(breakoutData, { ticker: "NVDA", marketStatus, now }).setups, ["BREAKOUT"]);
});

test("day screen still requires relative volume", () => {
  const intradayBars = bars.map((bar, index) => ({
    ...bar, datetime: new Date(now - (100 - index) * 15 * 60000).toISOString().slice(0, 16).replace("T", " "), volume: index === 99 ? 8e5 : 1e6,
  }));
  const result = screenInstrument(instrument, { ticker: "NVDA", interval: "15min", timezone: "UTC", bars: intradayBars }, { horizon: "day", market: "usa", now });
  assert.equal(result.status, "NO_TRADE");
  assert.deepEqual(result.reasons, ["Senaste candle har inte förhöjd volym."]);
  assert.deepEqual(result.screening_setups, []);
});
test("falling prices and low liquidity cannot pass", () => {
  const falling = bars.map((bar, index) => ({ ...bar, open: 199 - index, close: 199 - index, high: 200 - index, low: 198 - index }));
  assert.equal(screenInstrument(instrument, { ...data, bars: falling }, swingOptions).status, "NO_TRADE");
  const lowVolume = bars.map((bar) => ({ ...bar, volume: bar.volume / 1e5 }));
  assert.equal(screenInstrument(instrument, { ...data, bars: lowVolume }, swingOptions).status, "NO_TRADE");
});
test("ranking is stable and leaves original results untouched", () => {
  const items = [{ symbol: "Z", exchange: "NYSE", status: "NO_TRADE", rank_score: 4 }, { symbol: "B", exchange: "NYSE", status: "WAIT", rank_score: 3 }, { symbol: "A", exchange: "NYSE", status: "TRADE", rank_score: 3 }];
  assert.deepEqual(rankCandidates(items).map((item) => item.symbol), ["A", "B", "Z"]);
  assert.equal(items[0].symbol, "Z");
});
