import test from "node:test";
import assert from "node:assert/strict";
import { assessSwingSetup } from "../src/strategyModel.js";

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
  assert.match(result.reasons.at(-1), /Ingen ingång/);
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
