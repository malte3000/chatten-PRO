import test from "node:test";
import assert from "node:assert/strict";
import { analyzePatternDiscovery, DEFAULT_DRAWDOWN_THRESHOLDS, PATTERN_DISCOVERY_VERSION } from "../src/patternDiscoveryModel.js";

function data(closes, ticker = "TEST") {
  return { ticker, bars: closes.map((close, index) => ({
    datetime: `2026-01-${String(index + 1).padStart(2, "0")}`,
    open: close, high: close * 1.01, low: close * 0.99, close, volume: 1000,
  })) };
}

const run = (datasets, extra = {}) => analyzePatternDiscovery({
  datasets, drawdownWindows: [3], horizons: [1, 2], thresholds: [5, 10],
  recoveryTargets: [3], continuationTargets: [3], minSampleSize: 2,
  eventCooldown: 1, ...extra,
});

test("exports the requested documented threshold grid", () => {
  assert.equal(PATTERN_DISCOVERY_VERSION, "pattern-discovery-v0.1");
  assert.deepEqual(DEFAULT_DRAWDOWN_THRESHOLDS.slice(0, 30), Array.from({ length: 30 }, (_, index) => index + 1));
  assert.deepEqual(DEFAULT_DRAWDOWN_THRESHOLDS.slice(-3), [35, 40, 50]);
});

test("uses only the prior rolling high and records first threshold crossings", () => {
  const report = run([data([100, 105, 110, 103, 98, 97, 110])]);
  const drawdowns = report.events.filter((event) => event.eventType === "DRAWDOWN_3");
  assert.deepEqual(drawdowns.map((event) => [event.thresholdPct, event.eventDate]), [
    [-5, "2026-01-04"], [-10, "2026-01-05"],
  ]);
  assert.equal(drawdowns[0].referencePrice, 110);
  assert.equal(drawdowns[0].referenceDate, "2026-01-03");
});

test("does not duplicate a crossed threshold inside one continuous episode", () => {
  const report = run([data([100, 101, 102, 96, 95, 94, 93, 92])], { thresholds: [5], horizons: [1] });
  const drawdowns = report.events.filter((event) => event.eventType === "DRAWDOWN_3");
  assert.equal(drawdowns.length, 1);
  assert.equal(drawdowns[0].eventDate, "2026-01-04");
});

test("one-day drops use one magnitude bucket instead of duplicating every passed level", () => {
  const report = run([data([100, 89, 90, 90, 90])], { horizons: [1], eventCooldown: 0 });
  const daily = report.events.filter((event) => event.eventType === "ONE_DAY_DROP");
  assert.equal(daily.length, 1);
  assert.equal(daily[0].thresholdPct, -10);
  assert.ok(daily[0].observedMovePct < -10);
});

test("outcomes start after the event and use exact future horizons", () => {
  const report = run([data([100, 100, 100, 90, 94, 80, 100])]);
  const event = report.events.find((item) => item.eventType === "DRAWDOWN_3" && item.thresholdPct === -10);
  assert.ok(event);
  assert.equal(event.entryPrice, 90);
  assert.equal(event.outcomes["1"].terminalReturnPct, (94 / 90 - 1) * 100);
  assert.equal(event.outcomes["1"].recoveryTargets["3"], true);
  assert.equal(event.outcomes["1"].continuationTargets["3"], false);
  assert.equal(event.outcomes["2"].continuationTargets["3"], true);
  assert.equal(event.outcomes["2"].fullRecovery, false);
});

test("future changes cannot alter detection or prior-horizon results", () => {
  const original = data([100, 100, 100, 90, 91, 92, 93]);
  const before = structuredClone(original);
  const first = run([original]);
  const changed = structuredClone(original);
  changed.bars[6] = { ...changed.bars[6], open: 300, high: 303, low: 297, close: 300 };
  const later = run([changed]);
  const select = (report) => report.events.filter((event) => event.eventDate === "2026-01-04")
    .map((event) => ({ eventType: event.eventType, thresholdPct: event.thresholdPct, one: event.outcomes["1"], two: event.outcomes["2"] }));
  assert.deepEqual(select(later), select(first));
  assert.deepEqual(original, before);
});

test("reports Wilson uncertainty and insufficient samples without inventing confidence", () => {
  const report = run([data([100, 100, 100, 90, 94, 95])], { minSampleSize: 20, horizons: [1] });
  const summary = report.summaries.find((item) => item.eventType === "DRAWDOWN_3" && item.thresholdPct === -10);
  const horizon = summary.horizons[0];
  assert.equal(summary.status, "INSUFFICIENT_DATA");
  assert.equal(horizon.status, "INSUFFICIENT_DATA");
  assert.equal(horizon.sampleSize, 1);
  assert.equal(horizon.recoveryProbabilities[0].confidenceInterval.method, "wilson_score");
  assert.equal(horizon.terminalReturn.standardErrorPct, null);
  assert.equal(horizon.terminalReturn.confidenceIntervalPct, null);
});

test("summaries include mean, median, excursions and full recovery", () => {
  const first = data([100, 100, 100, 90, 95, 100], "ONE");
  const second = data([100, 100, 100, 90, 85, 80], "TWO");
  const report = run([first, second], { horizons: [1], minSampleSize: 2 });
  const summary = report.summaries.find((item) => item.eventType === "DRAWDOWN_3" && item.thresholdPct === -10);
  const horizon = summary.horizons[0];
  assert.equal(horizon.status, "SUFFICIENT_DATA");
  assert.equal(horizon.sampleSize, 2);
  assert.ok(Number.isFinite(horizon.terminalReturn.meanPct));
  assert.ok(Number.isFinite(horizon.terminalReturn.medianPct));
  assert.ok(horizon.maxFavorableExcursion.meanPct > horizon.maxAdverseExcursion.meanPct);
  assert.equal(horizon.fullRecoveryProbability.sampleSize, 2);
});

test("invalid series are excluded and all-invalid input fails safely", () => {
  const valid = data([100, 90, 91]);
  const invalid = data([100, 90, 91], "BAD");
  invalid.bars[1].datetime = invalid.bars[0].datetime;
  const partial = run([valid, invalid], { horizons: [1] });
  assert.equal(partial.dataQuality.validDatasetCount, 1);
  assert.equal(partial.dataQuality.excludedDatasetCount, 1);
  const failed = run([invalid]);
  assert.equal(failed.status, "INVALID");
  assert.equal(failed.events.length, 0);
});

test("an explicitly intraday dataset cannot be misrepresented as daily research", () => {
  const dataset = data([100, 99], "INTRA");
  const report = analyzePatternDiscovery({ datasets: [{ ...dataset, interval: "15min" }] });
  assert.equal(report.status, "INVALID");
  assert.match(report.dataQuality.excludedDatasets[0].reasons[0], /dagsdata/);
});

test("invalid calendar dates cannot enter a historical event study", () => {
  const dataset = data([100, 99]);
  dataset.bars[1].datetime = "2026-02-31";
  const report = analyzePatternDiscovery({ datasets: [dataset] });
  assert.equal(report.status, "INVALID");
  assert.match(report.dataQuality.excludedDatasets[0].reasons[0], /tid/);
});

test("overlapping events are disclosed and identical inputs are reproducible", () => {
  const input = [data([100, 100, 100, 94, 89, 91, 88, 90])];
  const first = run(input, { eventCooldown: 0 });
  assert.equal(first.dependence.overlappingOutcomeWindows, true);
  assert.ok(first.dependence.overlappingOutcomePairs > 0);
  assert.deepEqual(run(input, { eventCooldown: 0 }), first);
});

test("rejects malformed configuration", () => {
  assert.equal(run([data([100, 90])], { confidenceLevel: 1 }).status, "INVALID");
  assert.equal(run([data([100, 90])], { horizons: [0] }).status, "INVALID");
  assert.equal(run([], {}).status, "INVALID");
});
