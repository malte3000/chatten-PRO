export const CALIBRATION_VERSION = "probability-calibration-v0.1";

const finite = (value) => typeof value === "number" && Number.isFinite(value);
const round = (value, digits = 12) => {
  if (!finite(value)) return null;
  const factor = 10 ** digits;
  return Math.round((value + Number.EPSILON) * factor) / factor;
};

function wilson(successes, total, z = 1.959963984540054) {
  if (!total) return null;
  const estimate = successes / total;
  const denominator = 1 + z ** 2 / total;
  const center = (estimate + z ** 2 / (2 * total)) / denominator;
  const margin = z * Math.sqrt((estimate * (1 - estimate) + z ** 2 / (4 * total)) / total) / denominator;
  return { lower: round(Math.max(0, center - margin)), upper: round(Math.min(1, center + margin)), method: "wilson_score_95" };
}

function normalizeOutcome(value) {
  if (value === true || value === 1) return 1;
  if (value === false || value === 0) return 0;
  return null;
}

/**
 * Evaluates already resolved forecasts. It never trains, promotes, or updates a
 * production model. Calibration claims require a chronologically independent
 * input cohort selected by the caller.
 */
export function evaluateProbabilityCalibration(records, { bins = 10, minSampleSize = 100, epsilon = 1e-15 } = {}) {
  const invalid = (reason) => ({
    version: CALIBRATION_VERSION, status: "INVALID", reasons: [reason], sampleSize: 0,
    excludedCount: Array.isArray(records) ? records.length : 0,
    brierScore: null, logLoss: null, expectedCalibrationError: null, reliability: [],
  });
  if (!Array.isArray(records)) return invalid("Prognoserna måste vara en lista.");
  if (!Number.isInteger(bins) || bins < 2 || bins > 100 || !Number.isInteger(minSampleSize) || minSampleSize < 1 ||
      !finite(epsilon) || epsilon <= 0 || epsilon >= 0.5) return invalid("Kalibreringsparametrarna är ogiltiga.");

  const valid = [];
  const exclusions = [];
  for (const [index, record] of records.entries()) {
    const probability = record?.probability;
    const outcome = normalizeOutcome(record?.outcome);
    if (!finite(probability) || probability < 0 || probability > 1 || outcome === null) {
      exclusions.push({ index, reason: "Sannolikheten ska vara 0–1 och utfallet binärt." });
    } else {
      valid.push({ probability, outcome });
    }
  }
  if (!valid.length) return {
    ...invalid("Inga giltiga, avgjorda prognoser finns."), excludedCount: exclusions.length, exclusions,
  };

  const brierScore = valid.reduce((sum, item) => sum + (item.probability - item.outcome) ** 2, 0) / valid.length;
  const logLoss = -valid.reduce((sum, item) => {
    const p = Math.min(1 - epsilon, Math.max(epsilon, item.probability));
    return sum + item.outcome * Math.log(p) + (1 - item.outcome) * Math.log(1 - p);
  }, 0) / valid.length;
  const groups = Array.from({ length: bins }, (_, index) => ({
    bin: index + 1, lowerInclusive: index / bins, upperInclusive: (index + 1) / bins,
    predictions: [],
  }));
  for (const item of valid) groups[Math.min(bins - 1, Math.floor(item.probability * bins))].predictions.push(item);
  const reliability = groups.map((group) => {
    const count = group.predictions.length;
    const predictedMean = count ? group.predictions.reduce((sum, item) => sum + item.probability, 0) / count : null;
    const positives = group.predictions.reduce((sum, item) => sum + item.outcome, 0);
    const observedRate = count ? positives / count : null;
    return {
      bin: group.bin, lowerInclusive: group.lowerInclusive, upperInclusive: group.upperInclusive,
      count, predictedMean: round(predictedMean), positives,
      observedRate: round(observedRate), observedInterval: wilson(positives, count),
      calibrationGap: count ? round(observedRate - predictedMean) : null,
    };
  });
  const expectedCalibrationError = reliability.reduce((sum, group) =>
    sum + (group.count / valid.length) * Math.abs(group.calibrationGap || 0), 0);
  return {
    version: CALIBRATION_VERSION,
    status: valid.length >= minSampleSize ? "SUFFICIENT_DATA" : "INSUFFICIENT_DATA",
    reasons: valid.length >= minSampleSize ? [] : [`Minst ${minSampleSize} avgjorda prognoser krävs för kalibreringsbedömning.`],
    sampleSize: valid.length, requiredSampleSize: minSampleSize,
    excludedCount: exclusions.length, exclusions,
    brierScore: round(brierScore), logLoss: round(logLoss),
    expectedCalibrationError: round(expectedCalibrationError), reliability,
    assumptions: [
      "Måtten är meningsfulla som modellvalidering först på kronologiskt oberoende data.",
      "Reliability-grupperna använder lika breda sannolikhetsintervall; små grupper har stor osäkerhet.",
      "Resultatet ändrar eller befordrar aldrig en produktionsmodell automatiskt.",
    ],
  };
}
