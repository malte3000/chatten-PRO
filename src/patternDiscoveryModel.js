export const PATTERN_DISCOVERY_VERSION = "pattern-discovery-v0.1";

export const DEFAULT_DRAWDOWN_THRESHOLDS = Object.freeze([
  ...Array.from({ length: 30 }, (_, index) => index + 1),
  35, 40, 50,
]);

const finite = (value) => typeof value === "number" && Number.isFinite(value);
const mean = (values) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;

function validSessionDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const time = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value;
}

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

// Peter J. Acklam's inverse-normal approximation keeps confidence levels
// explicit without adding a runtime dependency.
function inverseNormal(probability) {
  const a = [-39.6968302866538, 220.946098424521, -275.928510446969,
    138.357751867269, -30.6647980661472, 2.50662827745924];
  const b = [-54.4760987982241, 161.585836858041, -155.698979859887,
    66.8013118877197, -13.2806815528857];
  const c = [-0.00778489400243029, -0.322396458041136, -2.40075827716184,
    -2.54973253934373, 4.37466414146497, 2.93816398269878];
  const d = [0.00778469570904146, 0.32246712907004, 2.445134137143,
    3.75440866190742];
  const low = 0.02425;
  const high = 1 - low;
  if (probability < low) {
    const q = Math.sqrt(-2 * Math.log(probability));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (probability <= high) {
    const q = probability - 0.5;
    const r = q * q;
    return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q /
      (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
  }
  const q = Math.sqrt(-2 * Math.log(1 - probability));
  return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
    ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
}

function summarizeContinuous(values, confidenceLevel) {
  if (!values.length) return { sampleSize: 0, meanPct: null, medianPct: null, standardErrorPct: null, confidenceIntervalPct: null };
  const average = mean(values);
  let standardError = null;
  if (values.length > 1) {
    const variance = values.reduce((sum, value) => sum + (value - average) ** 2, 0) / (values.length - 1);
    standardError = Math.sqrt(variance / values.length);
  }
  const z = inverseNormal(0.5 + confidenceLevel / 2);
  return {
    sampleSize: values.length,
    meanPct: average,
    medianPct: median(values),
    standardErrorPct: standardError,
    confidenceIntervalPct: standardError === null ? null : {
      level: confidenceLevel, lower: average - z * standardError, upper: average + z * standardError,
      method: "normal_approximation_of_mean",
    },
  };
}

function summarizeProbability(successes, total, confidenceLevel) {
  if (!total) return { successes: 0, sampleSize: 0, probability: null, probabilityPct: null, confidenceInterval: null };
  const z = inverseNormal(0.5 + confidenceLevel / 2);
  const z2 = z ** 2;
  const estimate = successes / total;
  const denominator = 1 + z2 / total;
  const center = (estimate + z2 / (2 * total)) / denominator;
  const margin = z * Math.sqrt((estimate * (1 - estimate) + z2 / (4 * total)) / total) / denominator;
  const lower = Math.max(0, center - margin);
  const upper = Math.min(1, center + margin);
  return {
    successes, sampleSize: total, probability: estimate, probabilityPct: estimate * 100,
    confidenceInterval: { level: confidenceLevel, lower, upper, lowerPct: lower * 100, upperPct: upper * 100, method: "wilson_score" },
  };
}

function normalizePositiveList(values, { integer = false, maximum = 1000 } = {}) {
  if (!Array.isArray(values) || !values.length) return null;
  const normalized = [...new Set(values.map((value) => Math.abs(Number(value))))].sort((a, b) => a - b);
  return normalized.every((value) => finite(value) && value > 0 && value <= maximum && (!integer || Number.isInteger(value)))
    ? normalized : null;
}

function inspectDataset(dataset, datasetIndex) {
  const ticker = typeof dataset?.ticker === "string" ? dataset.ticker.trim().toUpperCase() : "";
  if (!ticker || !Array.isArray(dataset?.bars) || dataset.bars.length < 2) {
    return { valid: false, datasetIndex, ticker: ticker || null, reasons: ["Ticker och minst två dagsljus krävs."] };
  }
  if (dataset.interval != null && dataset.interval !== "1day") {
    return { valid: false, datasetIndex, ticker, reasons: ["Pattern Discovery kräver dagsdata med intervallet 1day."] };
  }
  const seen = new Set();
  const reasons = [];
  for (let index = 0; index < dataset.bars.length; index += 1) {
    const bar = dataset.bars[index];
    const previous = dataset.bars[index - 1];
    if (!bar || !validSessionDate(bar.datetime) || seen.has(bar.datetime) ||
        (previous && bar.datetime <= previous.datetime)) reasons.push(`Ogiltig eller osorterad tid vid index ${index}.`);
    seen.add(bar?.datetime);
    if (![bar?.open, bar?.high, bar?.low, bar?.close].every((value) => finite(value) && value > 0) ||
        bar.high < Math.max(bar.open, bar.close) || bar.low > Math.min(bar.open, bar.close) || bar.high < bar.low) {
      reasons.push(`Ogiltig OHLC vid index ${index}.`);
    }
    if (bar?.volume != null && (!finite(bar.volume) || bar.volume < 0)) reasons.push(`Ogiltig volym vid index ${index}.`);
    if (reasons.length >= 10) break;
  }
  return { valid: reasons.length === 0, datasetIndex, ticker, reasons };
}

function futureOutcome(bars, event, horizon, recoveryTargets, continuationTargets) {
  const finalIndex = event.eventIndex + horizon;
  if (finalIndex >= bars.length) return null;
  const future = bars.slice(event.eventIndex + 1, finalIndex + 1);
  const highest = Math.max(...future.map((bar) => bar.high));
  const lowest = Math.min(...future.map((bar) => bar.low));
  const terminalReturnPct = (bars[finalIndex].close / event.entryPrice - 1) * 100;
  const maxFavorableExcursionPct = (highest / event.entryPrice - 1) * 100;
  const maxAdverseExcursionPct = (lowest / event.entryPrice - 1) * 100;
  if (![terminalReturnPct, maxFavorableExcursionPct, maxAdverseExcursionPct].every(finite)) return null;
  return {
    horizonSessions: horizon,
    terminalDate: bars[finalIndex].datetime,
    terminalReturnPct,
    positiveTerminalReturn: terminalReturnPct > 0,
    maxFavorableExcursionPct,
    maxAdverseExcursionPct,
    fullRecovery: highest >= event.referencePrice,
    recoveryTargets: Object.fromEntries(recoveryTargets.map((target) => [String(target), maxFavorableExcursionPct >= target])),
    continuationTargets: Object.fromEntries(continuationTargets.map((target) => [String(target), maxAdverseExcursionPct <= -target])),
  };
}

function makeEvent({ datasetIndex, ticker, bars, eventIndex, eventType, window, threshold, observedMovePct, referencePrice, referenceDate }, config) {
  const entryPrice = bars[eventIndex].close;
  const event = {
    id: `${datasetIndex}:${ticker}:${eventType}:${window || 0}:${threshold}:${bars[eventIndex].datetime}`,
    datasetIndex, ticker, eventType, drawdownWindow: window,
    thresholdPct: -threshold, eventDate: bars[eventIndex].datetime, eventIndex,
    observedMovePct, referencePrice, referenceDate, entryPrice, outcomes: {},
  };
  for (const horizon of config.horizons) {
    const outcome = futureOutcome(bars, event, horizon, config.recoveryTargets, config.continuationTargets);
    if (outcome) event.outcomes[String(horizon)] = outcome;
  }
  return event;
}

function discoverEvents(dataset, datasetIndex, config) {
  const ticker = dataset.ticker.trim().toUpperCase();
  const bars = dataset.bars;
  const events = [];
  const minThreshold = config.thresholds[0];
  const lastDailyByThreshold = new Map();

  for (let index = 1; index < bars.length; index += 1) {
    const dropMagnitude = Math.max(0, (1 - bars[index].close / bars[index - 1].close) * 100);
    if (!finite(dropMagnitude)) continue;
    const bucket = [...config.thresholds].reverse().find((threshold) => dropMagnitude >= threshold);
    if (bucket != null && index - (lastDailyByThreshold.get(bucket) ?? -Infinity) > config.eventCooldown) {
      events.push(makeEvent({ datasetIndex, ticker, bars, eventIndex: index, eventType: "ONE_DAY_DROP",
        window: null, threshold: bucket, observedMovePct: -dropMagnitude,
        referencePrice: bars[index - 1].close, referenceDate: bars[index - 1].datetime }, config));
      lastDailyByThreshold.set(bucket, index);
    }
  }

  for (const window of config.drawdownWindows) {
    const crossed = new Set();
    const lastByThreshold = new Map();
    for (let index = window; index < bars.length; index += 1) {
      const prior = bars.slice(index - window, index);
      let peakIndex = 0;
      for (let offset = 1; offset < prior.length; offset += 1) {
        if (prior[offset].close >= prior[peakIndex].close) peakIndex = offset;
      }
      const peak = prior[peakIndex];
      const magnitude = Math.max(0, (1 - bars[index].close / peak.close) * 100);
      if (!finite(magnitude)) continue;
      if (magnitude < minThreshold) crossed.clear();
      for (const threshold of config.thresholds) {
        if (magnitude + 1e-12 < threshold || crossed.has(threshold)) continue;
        crossed.add(threshold);
        if (index - (lastByThreshold.get(threshold) ?? -Infinity) <= config.eventCooldown) continue;
        events.push(makeEvent({ datasetIndex, ticker, bars, eventIndex: index, eventType: `DRAWDOWN_${window}`,
          window, threshold, observedMovePct: -magnitude, referencePrice: peak.close,
          referenceDate: peak.datetime }, config));
        lastByThreshold.set(threshold, index);
      }
    }
  }
  return events;
}

function summaryKey(event) {
  return `${event.eventType}|${event.drawdownWindow || 0}|${event.thresholdPct}`;
}

function summarizeEvents(events, config) {
  const groups = new Map();
  for (const event of events) {
    const key = summaryKey(event);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(event);
  }
  return [...groups.values()].map((group) => {
    const first = group[0];
    const horizons = config.horizons.map((horizon) => {
      const outcomes = group.map((event) => event.outcomes[String(horizon)]).filter(Boolean);
      return {
        horizonSessions: horizon,
        status: outcomes.length >= config.minSampleSize ? "SUFFICIENT_DATA" : "INSUFFICIENT_DATA",
        sampleSize: outcomes.length,
        requiredSampleSize: config.minSampleSize,
        terminalReturn: summarizeContinuous(outcomes.map((outcome) => outcome.terminalReturnPct), config.confidenceLevel),
        positiveTerminalProbability: summarizeProbability(outcomes.filter((outcome) => outcome.positiveTerminalReturn).length, outcomes.length, config.confidenceLevel),
        recoveryProbabilities: config.recoveryTargets.map((targetPct) => ({
          targetPct,
          ...summarizeProbability(outcomes.filter((outcome) => outcome.recoveryTargets[String(targetPct)]).length, outcomes.length, config.confidenceLevel),
        })),
        continuationProbabilities: config.continuationTargets.map((targetPct) => ({
          furtherDeclinePct: targetPct,
          ...summarizeProbability(outcomes.filter((outcome) => outcome.continuationTargets[String(targetPct)]).length, outcomes.length, config.confidenceLevel),
        })),
        fullRecoveryProbability: summarizeProbability(outcomes.filter((outcome) => outcome.fullRecovery).length, outcomes.length, config.confidenceLevel),
        maxFavorableExcursion: summarizeContinuous(outcomes.map((outcome) => outcome.maxFavorableExcursionPct), config.confidenceLevel),
        maxAdverseExcursion: summarizeContinuous(outcomes.map((outcome) => outcome.maxAdverseExcursionPct), config.confidenceLevel),
      };
    });
    return {
      eventType: first.eventType, drawdownWindow: first.drawdownWindow,
      thresholdPct: first.thresholdPct, eventCount: group.length,
      datasetCount: new Set(group.map((event) => event.datasetIndex)).size,
      firstEventDate: group.map((event) => event.eventDate).sort()[0],
      lastEventDate: group.map((event) => event.eventDate).sort().at(-1),
      status: horizons.some((horizon) => horizon.status === "SUFFICIENT_DATA") ? "SUFFICIENT_DATA" : "INSUFFICIENT_DATA",
      horizons,
    };
  }).sort((a, b) => a.eventType.localeCompare(b.eventType) || b.thresholdPct - a.thresholdPct);
}

function invalid(reasons, config = null, dataQuality = null) {
  return {
    version: PATTERN_DISCOVERY_VERSION, status: "INVALID", reasons,
    config, dataQuality, observationPeriod: { startDate: null, endDate: null },
    events: [], summaries: [], dependence: null,
  };
}

/**
 * Descriptive event study. It estimates historical frequencies, not causal or
 * guaranteed future probabilities. Detection sees data through the event close;
 * outcomes start with the next supplied bar.
 */
export function analyzePatternDiscovery({
  datasets, drawdownWindows = [30, 90], horizons = [1, 5, 10, 20, 60],
  thresholds = DEFAULT_DRAWDOWN_THRESHOLDS, recoveryTargets = [3, 5, 10],
  continuationTargets = [3, 5, 10], minSampleSize = 20,
  confidenceLevel = 0.95, eventCooldown = 5,
} = {}) {
  const normalized = {
    drawdownWindows: normalizePositiveList(drawdownWindows, { integer: true, maximum: 1000 }),
    horizons: normalizePositiveList(horizons, { integer: true, maximum: 1000 }),
    thresholds: normalizePositiveList(thresholds, { maximum: 99 }),
    recoveryTargets: normalizePositiveList(recoveryTargets, { maximum: 99 }),
    continuationTargets: normalizePositiveList(continuationTargets, { maximum: 99 }),
    minSampleSize: Number(minSampleSize), confidenceLevel: Number(confidenceLevel), eventCooldown: Number(eventCooldown),
  };
  const configValid = normalized.drawdownWindows && normalized.horizons && normalized.thresholds &&
    normalized.recoveryTargets && normalized.continuationTargets &&
    Number.isInteger(normalized.minSampleSize) && normalized.minSampleSize > 0 &&
    finite(normalized.confidenceLevel) && normalized.confidenceLevel > 0.5 && normalized.confidenceLevel < 1 &&
    Number.isInteger(normalized.eventCooldown) && normalized.eventCooldown >= 0;
  if (!configValid) return invalid(["Analysparametrarna är ogiltiga."], normalized);
  if (!Array.isArray(datasets) || !datasets.length) return invalid(["Minst en historisk dataserie krävs."], normalized);

  const inspections = datasets.map(inspectDataset);
  const validDatasets = inspections.filter((item) => item.valid).map((item) => ({ dataset: datasets[item.datasetIndex], datasetIndex: item.datasetIndex }));
  const dataQuality = {
    inputDatasetCount: datasets.length, validDatasetCount: validDatasets.length,
    excludedDatasetCount: datasets.length - validDatasets.length,
    excludedDatasets: inspections.filter((item) => !item.valid).map(({ datasetIndex, ticker, reasons }) => ({ datasetIndex, ticker, reasons })),
  };
  if (!validDatasets.length) return invalid(["Ingen historisk dataserie klarade valideringen."], normalized, dataQuality);

  const dates = validDatasets.flatMap(({ dataset }) => [dataset.bars[0].datetime, dataset.bars.at(-1).datetime]).sort();
  const events = validDatasets.flatMap(({ dataset, datasetIndex }) => discoverEvents(dataset, datasetIndex, normalized));
  let overlappingOutcomePairs = 0;
  const maximumHorizon = normalized.horizons.at(-1);
  const eventsByDataset = new Map();
  for (const event of events) {
    if (!eventsByDataset.has(event.datasetIndex)) eventsByDataset.set(event.datasetIndex, []);
    eventsByDataset.get(event.datasetIndex).push(event.eventIndex);
  }
  // Count overlapping pairs with a moving left boundary instead of comparing
  // every event to every other event. This remains practical for large universes.
  for (const indexes of eventsByDataset.values()) {
    indexes.sort((a, b) => a - b);
    let left = 0;
    for (let right = 0; right < indexes.length; right += 1) {
      while (indexes[right] - indexes[left] > maximumHorizon) left += 1;
      overlappingOutcomePairs += right - left;
    }
  }
  const dependence = {
    overlappingOutcomeWindows: overlappingOutcomePairs > 0, overlappingOutcomePairs,
    maximumOutcomeHorizonSessions: maximumHorizon,
    crossThresholdDependence: true,
    note: "Händelser från samma instrument och överlappande utfallsperioder är inte oberoende. Konfidensintervallen är deskriptiva och klustrar ännu inte per instrument.",
  };
  return {
    version: PATTERN_DISCOVERY_VERSION,
    status: events.length ? "COMPLETED" : "NO_EVENTS",
    reasons: events.length ? [] : ["Inga kursfall passerade de valda trösklarna."],
    config: normalized, dataQuality,
    observationPeriod: { startDate: dates[0], endDate: dates.at(-1) },
    definitions: {
      oneDayDrop: "Stängning mot föregående stängning, grupperad i den högsta passerade tröskelns storleksintervall.",
      drawdown: "Första gången stängningen passerar respektive tröskel under en sammanhängande nedgång från högsta tidigare stängning inom fönstret.",
      outcome: "Framtida OHLC från och med nästa observerade session; terminalavkastning använder stängningen exakt vid horisonten.",
    },
    events, summaries: summarizeEvents(events, normalized), dependence,
  };
}
