import test from "node:test";
import assert from "node:assert/strict";
import { atr, macd, realizedVolatility, rsi, sma } from "../src/indicators.js";

test("transparent research indicators are deterministic and reject insufficient data", () => {
  const values = Array.from({ length: 40 }, (_, index) => 100 + index);
  assert.equal(sma(values, 5), 137);
  assert.equal(rsi(values, 14), 100);
  assert.equal(rsi(values.slice(0, 10), 14), null);
  assert.deepEqual(macd(values), macd([...values]));
  assert.equal(macd(values.slice(0, 20)), null);
});

test("Wilder ATR includes gaps and realized volatility returns an annualized percentage", () => {
  const bars = Array.from({ length: 16 }, (_, index) => ({
    open: 100 + index,
    high: 102 + index,
    low: 99 + index,
    close: 101 + index,
  }));
  assert.equal(atr(bars, 14), 3);
  const volatility = realizedVolatility(bars.map((bar) => bar.close), { period: 10 });
  assert.ok(Number.isFinite(volatility));
  assert.ok(volatility >= 0);
});

test("flat prices produce neutral RSI and zero realized volatility", () => {
  const values = Array(30).fill(100);
  assert.equal(rsi(values), 50);
  assert.equal(realizedVolatility(values), 0);
});
