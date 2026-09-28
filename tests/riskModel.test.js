import test from "node:test";
import assert from "node:assert/strict";
import { calculatePositionSize } from "../src/riskModel.js";

test("risk calculator limits whole-share quantity by both risk budget and cash capital", () => {
  const result = calculatePositionSize({ capital: 10000, riskPercent: 1, entry: 100, stop: 95, estimatedFees: 10 });
  assert.equal(result.status, "CALCULATED");
  assert.equal(result.shares_within_risk, 18);
  assert.equal(result.shares_within_cash_capital, 99);
  assert.equal(result.max_shares, 18);
  assert.equal(result.planned_risk, 100);
  assert.equal(result.position_value, 1800);
});

test("risk calculator reports unaffordable or invalid inputs without a size", () => {
  assert.equal(calculatePositionSize({ capital: 50, riskPercent: 1, entry: 100, stop: 95 }).status, "TOO_SMALL");
  assert.equal(calculatePositionSize({ capital: 10000, riskPercent: 0.01, entry: 100, stop: 95 }).status, "TOO_SMALL");
  assert.equal(calculatePositionSize({ capital: 10000, riskPercent: 1, entry: 100, stop: 100 }).status, "NOT_CONFIGURED");
});
