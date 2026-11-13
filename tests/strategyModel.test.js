import test from "node:test";
import assert from "node:assert/strict";
import { assessSwingSetup, evaluateSwingPatterns, SWING_SETUP_IDS, SWING_STRATEGY_VERSION } from "../src/strategyModel.js";

test("unavailable swing input returns an empty plan list so the result card remains renderable", () => {
  const result = assessSwingSetup(null, { ticker: "NVDA" });
  assert.equal(result.status, "NOT_ASSESSED");
  assert.deepEqual(result.plans, []);
});

const now = Date.parse("2026-09-28T20:00:00Z");
function makeBars() {
  const dates = [];
  let day = new Date("2026-09-28T00:00:00Z");
  while (dates.length < 100) {
    if (![0, 6].includes(day.getUTCDay())) dates.unshift(day.toISOString().slice(0, 10));
    day = new Date(day.getTime() - 86400000);
  }
  return dates.map((datetime, index) => {
    const close = 50 + index;
    return { datetime, open: close - 0.3, high: close + 0.5, low: close - 0.5, close, volume: 1_000_000 };
  });
}

test("swing model spots a pullback in a positive trend as a watch candidate only", () => {
  const bars = makeBars();
  bars[99].low = 139.8;
  const result = assessSwingSetup({ ticker: "NVDA", interval: "1day", timezone: "America/New_York", bars }, { ticker: "NVDA", marketStatus: { market: "usa", isOpen: false }, now });
  assert.equal(result.status, "WATCH");
  assert.ok(result.setups.includes("PULLBACK"));
  assert.match(result.reasons.at(-1), /provisoriska/);
  assert.ok(result.plans[0].stop < bars[99].low);
  assert.equal(result.plans[0].theoretical_risk_reward, 2);
});

test("swing model spots a 20-session breakout only with elevated volume", () => {
  const bars = makeBars();
  bars[99] = { ...bars[99], open: 149, close: 152, high: 153, low: 149, volume: 1_500_000 };
  const result = assessSwingSetup({ ticker: "NVDA", interval: "1day", timezone: "America/New_York", bars }, { ticker: "NVDA", marketStatus: { market: "usa", isOpen: false }, now });
  assert.equal(result.status, "WATCH");
  assert.ok(result.setups.includes("BREAKOUT"));
});

test("swing model ignores an unfinished daily candle and fails closed without matching data or exchange clock", () => {
  const bars = makeBars();
  bars[99] = { ...bars[99], open: 149, close: 200, high: 201, low: 149, volume: 5_000_000 };
  const data = { ticker: "NVDA", interval: "1day", timezone: "America/New_York", bars };
  const openSession = assessSwingSetup(data, { ticker: "NVDA", marketStatus: { market: "usa", isOpen: true }, now });
  assert.equal(openSession.status, "NO_SETUP");
  assert.equal(openSession.metrics.latest_closed_candle, bars[98].datetime);
  const unfinished = { ...data, bars: [...bars.slice(0, -1), { ...bars[99], high: 1, volume: 0 }] };
  const stillOpen = assessSwingSetup(unfinished, { ticker: "NVDA", marketStatus: { market: "usa", isOpen: true }, now });
  assert.equal(stillOpen.status, "NO_SETUP");
  assert.equal(stillOpen.metrics.latest_closed_candle, bars[98].datetime);
  assert.equal(assessSwingSetup(data, { ticker: "AMD", marketStatus: { market: "usa", isOpen: false }, now }).status, "NOT_ASSESSED");
  assert.equal(assessSwingSetup(data, { ticker: "NVDA", marketStatus: { market: "off", isOpen: true }, now }).status, "NOT_ASSESSED");
});

test("an open session keeps the latest candle when it is from yesterday", () => {
  const bars = makeBars().slice(0, -1);
  const result = assessSwingSetup({ ticker: "NVDA", interval: "1day", timezone: "America/New_York", bars }, { ticker: "NVDA", marketStatus: { market: "usa", isOpen: true }, now });
  assert.equal(result.metrics.latest_closed_candle, bars.at(-1).datetime);
});

test("swing analysis does not use Friday's signal after Monday has closed without Monday data", () => {
  const bars = makeBars().slice(0, -1);
  const result = assessSwingSetup({ ticker: "NVDA", interval: "1day", timezone: "America/New_York", bars }, {
    ticker: "NVDA", marketStatus: { market: "usa", isOpen: false, reason: "after_close", sessionDate: "2026-09-28" }, now,
  });
  assert.equal(result.status, "NOT_ASSESSED");
  assert.match(result.reasons.join(" "), /2026-09-28/);
});

test("swing assessment requires daily exchange dates and trustworthy positive volume", () => {
  const data = { ticker: "NVDA", interval: "1day", timezone: "America/New_York", bars: makeBars() };
  data.bars[20].volume = null;
  assert.equal(assessSwingSetup(data, { ticker: "NVDA", marketStatus: { market: "usa", isOpen: false }, now }).status, "NOT_ASSESSED");
});

test("short range breakout is distinct from the 20-day breakout and has a finite plan", () => {
  const bars = makeBars();
  for (const [offset, close] of [144.5, 144.6, 144.7].entries()) {
    bars[96 + offset] = { ...bars[96 + offset], open: close - 0.3, high: close + 0.5, low: close - 0.5, close };
  }
  bars[99] = { ...bars[99], open: 144.9, high: 145.8, low: 144.8, close: 145.3 };
  const result = evaluateSwingPatterns(bars);
  assert.equal(result.status, "WATCH");
  assert.deepEqual(result.setups, ["RANGE_BREAKOUT"]);
  assert.ok(result.metrics.prior_3_day_range <= 2 * result.metrics.prior_atr);
  assert.ok(result.metrics.last_closed_price <= result.metrics.prior_20_day_high);
  const plan = result.plans[0];
  assert.equal(plan.setup, "RANGE_BREAKOUT");
  assert.equal(plan.stop, plan.entry_reference - result.metrics.atr);
  assert.equal(plan.target, plan.entry_reference + 2 * plan.risk_per_share);
  assert.ok(SWING_SETUP_IDS.includes(plan.setup));
  assert.equal(SWING_STRATEGY_VERSION, "swing-v0.5-experimental");
});

test("range consolidation is measured against volatility before the breakout candle", () => {
  const bars = makeBars();
  bars[80] = { ...bars[80], high: 150 };
  for (const [offset, close] of [144.3, 144.4, 144.5].entries()) {
    bars[96 + offset] = { ...bars[96 + offset], open: close - 0.2, high: 148, low: 143, close };
  }
  bars[99] = { ...bars[99], open: 147.2, high: 160, low: 142, close: 148.2 };
  const result = evaluateSwingPatterns(bars);
  assert.ok(!result.setups.includes("RANGE_BREAKOUT"));
  assert.ok(result.metrics.prior_3_day_range > 2 * result.metrics.prior_atr);
  assert.ok(result.metrics.prior_3_day_range <= 2 * result.metrics.atr);
});

test("bullish rebound within rising longer trend can qualify without positive five-day momentum", () => {
  const bars = makeBars();
  for (const [offset, close] of [138, 136, 133].entries()) {
    bars[96 + offset] = { ...bars[96 + offset], open: close - 0.3, high: close + 0.5, low: close - 0.5, close };
  }
  bars[99] = { ...bars[99], open: 132, high: 134.5, low: 131.5, close: 134 };
  const result = evaluateSwingPatterns(bars);
  assert.equal(result.status, "WATCH");
  assert.deepEqual(result.setups, ["REBOUND"]);
  assert.ok(result.metrics.ema50 > result.metrics.ema50_five_bars_ago);
  assert.ok(result.metrics.momentum_pct < 0);
  assert.ok(result.metrics.prior_two_bar_fall_atr >= 0.75);
  assert.equal(result.plans[0].stop, bars[99].low - 0.25 * result.metrics.atr);
  assert.equal(result.plans[0].target, result.plans[0].entry_reference + 2 * result.plans[0].risk_per_share);
});

test("an unfinished next-day candle cannot alter a locked range signal", () => {
  const bars = makeBars();
  for (const [offset, close] of [144.5, 144.6, 144.7].entries()) {
    bars[96 + offset] = { ...bars[96 + offset], open: close - 0.3, high: close + 0.5, low: close - 0.5, close };
  }
  bars[99] = { ...bars[99], open: 144.9, high: 145.8, low: 144.8, close: 145.3 };
  const marketStatus = { market: "usa", isOpen: true, reason: "open", sessionDate: "2026-09-29" };
  const assessmentNow = Date.parse("2026-09-29T15:00:00Z");
  const data = { ticker: "NVDA", interval: "1day", timezone: "America/New_York", bars };
  const locked = assessSwingSetup(data, { ticker: "NVDA", marketStatus, now: assessmentNow });
  const withUnfinished = assessSwingSetup({ ...data, bars: [...bars, {
    datetime: "2026-09-29", open: 145.3, high: 500, low: 0, close: 500, volume: 0,
  }] }, { ticker: "NVDA", marketStatus, now: assessmentNow });
  assert.equal(locked.status, "WATCH");
  assert.deepEqual(withUnfinished, locked);
  assert.deepEqual(locked.setups, ["RANGE_BREAKOUT"]);
});
