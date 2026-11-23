import test from "node:test";
import assert from "node:assert/strict";
import { evaluateProbabilityCalibration } from "../src/probabilityCalibration.js";

test("perfect resolved forecasts have zero Brier score and near-zero log loss", () => {
  const report = evaluateProbabilityCalibration([
    { probability: 1, outcome: true }, { probability: 0, outcome: false },
  ], { bins: 2, minSampleSize: 2 });
  assert.equal(report.status, "SUFFICIENT_DATA");
  assert.equal(report.brierScore, 0);
  assert.ok(report.logLoss < 1e-10);
});

test("reliability bins report observed rates, Wilson uncertainty and ECE", () => {
  const report = evaluateProbabilityCalibration([
    { probability: 0.7, outcome: 1 }, { probability: 0.7, outcome: 0 },
    { probability: 0.8, outcome: 1 }, { probability: 0.2, outcome: 0 },
  ], { bins: 5, minSampleSize: 4 });
  assert.ok(report.reliability.some((bin) => bin.count > 0 && bin.observedInterval));
  assert.ok(report.expectedCalibrationError >= 0);
  assert.ok(report.brierScore > 0);
});

test("small and invalid samples are explicit instead of implying calibration", () => {
  const report = evaluateProbabilityCalibration([
    { probability: 0.6, outcome: true }, { probability: 2, outcome: false },
  ], { minSampleSize: 10 });
  assert.equal(report.status, "INSUFFICIENT_DATA");
  assert.equal(report.sampleSize, 1);
  assert.equal(report.excludedCount, 1);
});

test("calibration evaluation is deterministic and does not mutate input", () => {
  const input = [{ probability: 0.4, outcome: 0 }, { probability: 0.6, outcome: 1 }];
  const before = structuredClone(input);
  assert.deepEqual(evaluateProbabilityCalibration(input), evaluateProbabilityCalibration(input));
  assert.deepEqual(input, before);
});

test("malformed records and options fail safely", () => {
  assert.equal(evaluateProbabilityCalibration(null).status, "INVALID");
  assert.equal(evaluateProbabilityCalibration([], { bins: 1 }).status, "INVALID");
  assert.equal(evaluateProbabilityCalibration([{ probability: NaN, outcome: true }]).status, "INVALID");
});
