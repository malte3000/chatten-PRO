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
  return Array.from({ length: 100 }, (_, index) => {
    const close = 50 + index;
    return { datetime: new Date(now - (99 - index) * 86400000).toISOString().slice(0, 10), open: close - 0.3, high: close + 0.5, low: close - 0.5, close, volume: 1_000_000 };
  });
}

test("swing model spots a pullback in a positive trend as a watch candidate only", () => {
  const bars = makeBars();
  bars[99].low = 139.8;
  const result = assessSwingSetup({ ticker: "NVDA", interval: "1day", bars }, { ticker: "NVDA", marketStatus: { market: "usa", isOpen: false }, now });
  assert.equal(result.status, "WATCH");
  assert.ok(result.setups.includes("PULLBACK"));
  assert.match(result.reasons.at(-1), /Ingen ingång/);
  assert.ok(result.plans[0].stop < bars[99].low);
  assert.equal(result.plans[0].theoretical_risk_reward, 2);
});

test("swing model spots a 20-session breakout only with elevated volume", () => {
  const bars = makeBars();
  bars[99] = { ...bars[99], open: 149, close: 152, high: 153, low: 149, volume: 1_500_000 };
  const result = assessSwingSetup({ ticker: "NVDA", interval: "1day", bars }, { ticker: "NVDA", marketStatus: { market: "usa", isOpen: false }, now });
  assert.equal(result.status, "WATCH");
  assert.ok(result.setups.includes("BREAKOUT"));
});

test("swing model ignores an unfinished daily candle and fails closed without matching data or exchange clock", () => {
  const bars = makeBars();
  bars[99] = { ...bars[99], open: 149, close: 200, high: 201, low: 149, volume: 5_000_000 };
  const data = { ticker: "NVDA", interval: "1day", bars };
  const openSession = assessSwingSetup(data, { ticker: "NVDA", marketStatus: { market: "usa", isOpen: true }, now });
  assert.equal(openSession.status, "NO_SETUP");
  assert.equal(openSession.metrics.latest_closed_candle, bars[98].datetime);
  assert.equal(assessSwingSetup(data, { ticker: "AMD", marketStatus: { market: "usa", isOpen: false }, now }).status, "NOT_ASSESSED");
  assert.equal(assessSwingSetup(data, { ticker: "NVDA", marketStatus: { market: "off", isOpen: true }, now }).status, "NOT_ASSESSED");
});
