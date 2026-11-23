export const EVENT_BACKTEST_VERSION = "event-backtest-v0.1";

const OUTCOMES = Object.freeze(["TARGET_FIRST", "STOP_FIRST", "TIE", "TIME_EXIT"]);
const finite = (value) => typeof value === "number" && Number.isFinite(value);
const symbol = (value) => typeof value === "string" ? value.trim().toUpperCase() : "";

function timestamp(value) {
  if (typeof value !== "string" || !value.trim()) return NaN;
  const normalized = /^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T00:00:00Z` : value;
  return Date.parse(normalized);
}

function round(value, digits = 10) {
  if (!finite(value)) return null;
  const factor = 10 ** digits;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

function mean(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function sampleDeviation(values) {
  if (values.length < 2) return null;
  const average = mean(values);
  return Math.sqrt(values.reduce((sum, value) => sum + (value - average) ** 2, 0) / (values.length - 1));
}

// Wilson score interval is stable for small samples and never extends outside 0..1.
function wilson(successes, total, z = 1.959963984540054) {
  if (!Number.isInteger(successes) || !Number.isInteger(total) || total <= 0 || successes < 0 || successes > total) {
    return { estimate: null, lower: null, upper: null, sampleSize: total > 0 ? total : 0 };
  }
  const p = successes / total;
  const denominator = 1 + z ** 2 / total;
  const center = (p + z ** 2 / (2 * total)) / denominator;
  const margin = z * Math.sqrt((p * (1 - p) + z ** 2 / (4 * total)) / total) / denominator;
  return {
    estimate: round(p), lower: round(Math.max(0, center - margin)),
    upper: round(Math.min(1, center + margin)), sampleSize: total,
  };
}

function invalidBar(bar) {
  if (!bar || typeof bar !== "object" || !finite(timestamp(bar.datetime))) return true;
  if (![bar.open, bar.high, bar.low, bar.close].every((value) => finite(value) && value > 0)) return true;
  return bar.high < Math.max(bar.open, bar.close, bar.low) ||
    bar.low > Math.min(bar.open, bar.close, bar.high);
}

function invalidResult(reason, index) {
  return {
    eventIndex: index, status: "REJECTED", outcome: "REJECTED", reasons: [reason],
    ticker: null, datasetIndex: null, signalIndex: null, signalDate: null,
    entryIndex: null, entryDate: null, exitIndex: null, exitDate: null,
    entry: null, target: null, stop: null, exit: null, grossPnl: null,
    totalFees: null, netPnl: null, netReturnPct: null, holdingBars: null,
    ambiguous: false, metadata: null,
  };
}

function notAssessedResult(reason, index, identity = {}) {
  return {
    ...invalidResult(reason, index), ...identity, status: "NOT_ASSESSED",
    outcome: "NOT_ASSESSED",
  };
}

function resolveEvent(event, datasets, index) {
  if (!event || typeof event !== "object" || Array.isArray(event)) {
    return { error: invalidResult("Händelsen måste vara ett objekt.", index) };
  }
  let datasetIndex = Number.isInteger(event.datasetIndex) ? event.datasetIndex : null;
  if (datasetIndex === null && symbol(event.ticker)) {
    const matches = datasets.flatMap((dataset, candidate) => symbol(dataset?.ticker) === symbol(event.ticker) ? [candidate] : []);
    if (matches.length === 1) datasetIndex = matches[0];
  }
  if (datasetIndex === null || datasetIndex < 0 || datasetIndex >= datasets.length) {
    return { error: invalidResult("Händelsen pekar inte på en entydig dataserie.", index) };
  }
  const dataset = datasets[datasetIndex];
  const ticker = symbol(dataset?.ticker);
  const bars = dataset?.bars;
  const identity = {
    ticker: ticker || null, datasetIndex, signalIndex: null,
    signalDate: typeof event.signalDate === "string" ? event.signalDate : null,
    metadata: event.metadata && typeof event.metadata === "object" ? { ...event.metadata } : null,
  };
  if (!ticker || (event.ticker != null && symbol(event.ticker) !== ticker)) {
    return { error: notAssessedResult("Händelsens ticker matchar inte dataserien.", index, identity) };
  }
  if (!Array.isArray(bars) || bars.length < 2) {
    return { error: notAssessedResult("Dataserien saknar tillräckliga dagsljus.", index, identity) };
  }
  let signalIndex = Number.isInteger(event.signalIndex) ? event.signalIndex : null;
  if (signalIndex === null && typeof event.signalDate === "string") {
    signalIndex = bars.findIndex((bar) => bar?.datetime === event.signalDate);
  }
  if (!Number.isInteger(signalIndex) || signalIndex < 0 || signalIndex >= bars.length) {
    return { error: invalidResult("Händelsen saknar ett giltigt signalindex eller signaldatum.", index) };
  }
  identity.signalIndex = signalIndex;
  identity.signalDate = bars[signalIndex]?.datetime || identity.signalDate;
  if (typeof event.signalDate === "string" && bars[signalIndex]?.datetime !== event.signalDate) {
    return { error: notAssessedResult("Signalindex och signaldatum beskriver olika dagsljus.", index, identity) };
  }
  if (invalidBar(bars[signalIndex])) {
    return { error: notAssessedResult("Signalljuset är ogiltigt.", index, identity) };
  }
  if (signalIndex > 0 && timestamp(bars[signalIndex - 1]?.datetime) >= timestamp(bars[signalIndex]?.datetime)) {
    return { error: notAssessedResult("Dataserien är inte strikt kronologisk vid signalen.", index, identity) };
  }
  return { dataset, datasetIndex, ticker, bars, signalIndex, identity };
}

function executionPrice(rawPrice, side, action, executionRate) {
  const adverseDirection = side === "LONG"
    ? (action === "ENTRY" ? 1 : -1)
    : (action === "ENTRY" ? -1 : 1);
  return rawPrice * (1 + adverseDirection * executionRate);
}

function calculateTrade({ entry, rawExit, side, quantity, feePerOrder, executionRate }) {
  const exit = executionPrice(rawExit, side, "EXIT", executionRate);
  const direction = side === "LONG" ? 1 : -1;
  const grossPnl = (exit - entry) * direction * quantity;
  const totalFees = feePerOrder * 2;
  const netPnl = grossPnl - totalFees;
  const notional = entry * quantity;
  return {
    exit: round(exit), grossPnl: round(grossPnl), totalFees: round(totalFees),
    netPnl: round(netPnl), netReturnPct: round(netPnl / notional * 100),
  };
}

function assessEvent(resolved, eventIndex, options) {
  const { bars, datasetIndex, ticker, signalIndex, identity } = resolved;
  const entryIndex = signalIndex + 1;
  if (entryIndex >= bars.length) {
    return notAssessedResult("Ingen senare session finns för ingång.", eventIndex, identity);
  }
  const lastIndex = entryIndex + options.horizon - 1;
  if (lastIndex >= bars.length) {
    return notAssessedResult("En fullständig framtida utfallsperiod saknas.", eventIndex, {
      ...identity, entryIndex, entryDate: bars[entryIndex]?.datetime || null,
    });
  }
  const window = bars.slice(entryIndex, lastIndex + 1);
  let previousTime = timestamp(bars[signalIndex].datetime);
  for (const bar of window) {
    const time = timestamp(bar?.datetime);
    if (invalidBar(bar) || !finite(time) || time <= previousTime) {
      return notAssessedResult("Utfallsperioden innehåller ogiltiga eller oordnade dagsljus.", eventIndex, {
        ...identity, entryIndex, entryDate: bars[entryIndex]?.datetime || null,
      });
    }
    previousTime = time;
  }

  const rawEntry = window[0].open;
  const entry = executionPrice(rawEntry, options.side, "ENTRY", options.executionRate);
  const target = options.side === "LONG"
    ? entry * (1 + options.targetPct / 100)
    : entry * (1 - options.targetPct / 100);
  const stop = options.side === "LONG"
    ? entry * (1 - options.stopPct / 100)
    : entry * (1 + options.stopPct / 100);
  if (![entry, target, stop].every((value) => finite(value) && value > 0)) {
    return notAssessedResult("Ingången gav ogiltiga mål- eller stopnivåer.", eventIndex, identity);
  }

  let outcome = "TIME_EXIT";
  let rawExit = window.at(-1).close;
  let exitIndex = lastIndex;
  let ambiguous = false;
  for (let offset = 0; offset < window.length; offset += 1) {
    const bar = window[offset];
    const index = entryIndex + offset;
    const targetGap = options.side === "LONG" ? bar.open >= target : bar.open <= target;
    const stopGap = options.side === "LONG" ? bar.open <= stop : bar.open >= stop;
    if (stopGap) {
      outcome = "STOP_FIRST"; rawExit = bar.open; exitIndex = index; break;
    }
    if (targetGap) {
      // Do not claim favorable price improvement when a daily bar opens beyond the target.
      outcome = "TARGET_FIRST"; rawExit = target; exitIndex = index; break;
    }
    const targetTouched = options.side === "LONG" ? bar.high >= target : bar.low <= target;
    const stopTouched = options.side === "LONG" ? bar.low <= stop : bar.high >= stop;
    if (targetTouched && stopTouched) {
      ambiguous = true; exitIndex = index;
      if (options.ambiguousPolicy === "STOP_FIRST") {
        outcome = "STOP_FIRST"; rawExit = stop;
      } else {
        outcome = "TIE"; rawExit = null;
      }
      break;
    }
    if (stopTouched) { outcome = "STOP_FIRST"; rawExit = stop; exitIndex = index; break; }
    if (targetTouched) { outcome = "TARGET_FIRST"; rawExit = target; exitIndex = index; break; }
  }

  const base = {
    eventIndex, status: "COMPLETED", outcome, reasons: [], ticker, datasetIndex,
    signalIndex, signalDate: bars[signalIndex].datetime, entryIndex,
    entryDate: bars[entryIndex].datetime, exitIndex, exitDate: bars[exitIndex].datetime,
    entry: round(entry), target: round(target), stop: round(stop), holdingBars: exitIndex - entryIndex + 1,
    ambiguous, metadata: identity.metadata,
  };
  if (outcome === "TIE") {
    return {
      ...base, exit: null, grossPnl: null, totalFees: null, netPnl: null, netReturnPct: null,
      reasons: ["Mål och stop träffades inom samma dagsljus; intradagsordningen är okänd."],
    };
  }
  const trade = calculateTrade({ entry, rawExit, ...options });
  if (![trade.exit, trade.grossPnl, trade.totalFees, trade.netPnl, trade.netReturnPct].every(finite)) {
    return notAssessedResult("Pris, storlek eller kostnader gav ett icke-finit utfall.", eventIndex, identity);
  }
  return { ...base, ...trade };
}

function financialSummary(results) {
  const resolved = results.filter((result) => result.status === "COMPLETED" && result.outcome !== "TIE" && finite(result.netPnl));
  const wins = resolved.filter((result) => result.netPnl > 0);
  const losses = resolved.filter((result) => result.netPnl < 0);
  const returns = resolved.map((result) => result.netReturnPct);
  const average = mean(returns);
  const deviation = sampleDeviation(returns);
  const downsideDeviation = returns.length
    ? Math.sqrt(returns.reduce((sum, value) => sum + Math.min(0, value) ** 2, 0) / returns.length)
    : null;
  const profits = wins.reduce((sum, result) => sum + result.netPnl, 0);
  const lossesAmount = -losses.reduce((sum, result) => sum + result.netPnl, 0);
  let cumulative = 0, peak = 0, maxDrawdown = 0;
  for (const result of [...resolved].sort((a, b) => timestamp(a.entryDate) - timestamp(b.entryDate) || a.eventIndex - b.eventIndex)) {
    cumulative += result.netPnl;
    peak = Math.max(peak, cumulative);
    maxDrawdown = Math.max(maxDrawdown, peak - cumulative);
  }
  return {
    financialSampleSize: resolved.length, wins: wins.length, losses: losses.length,
    breakEvens: resolved.length - wins.length - losses.length,
    winRate: resolved.length ? round(wins.length / resolved.length) : null,
    averageWin: wins.length ? round(mean(wins.map((result) => result.netPnl))) : null,
    averageLoss: losses.length ? round(mean(losses.map((result) => result.netPnl))) : null,
    expectancy: resolved.length ? round(mean(resolved.map((result) => result.netPnl))) : null,
    expectancyReturnPct: average === null ? null : round(average),
    profitFactor: lossesAmount > 0 ? round(profits / lossesAmount) : null,
    sharpePerTrade: deviation && deviation > 0 ? round(average / deviation) : null,
    sortinoPerTrade: downsideDeviation && downsideDeviation > 0 ? round(average / downsideDeviation) : null,
    maxRealizedDrawdown: round(maxDrawdown),
    totalFees: round(resolved.reduce((sum, result) => sum + result.totalFees, 0)),
  };
}

function stabilitySummary(results) {
  const groups = new Map();
  for (const result of results.filter((item) => item.status === "COMPLETED")) {
    const explicit = typeof result.metadata?.period === "string" && result.metadata.period.trim()
      ? result.metadata.period.trim() : null;
    const key = explicit || String(new Date(timestamp(result.signalDate)).getUTCFullYear());
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(result);
  }
  return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([period, items]) => {
    const financial = financialSummary(items);
    return {
      period, eventCount: items.length,
      targetCount: items.filter((item) => item.outcome === "TARGET_FIRST").length,
      stopCount: items.filter((item) => item.outcome === "STOP_FIRST").length,
      tieCount: items.filter((item) => item.outcome === "TIE").length,
      timeExitCount: items.filter((item) => item.outcome === "TIME_EXIT").length,
      financialSampleSize: financial.financialSampleSize,
      winRate: financial.winRate, expectancy: financial.expectancy,
    };
  });
}

function overlapSummary(results) {
  const assessed = results.filter((result) => result.status === "COMPLETED");
  let pairs = 0;
  const involved = new Set();
  for (let left = 0; left < assessed.length; left += 1) {
    for (let right = left + 1; right < assessed.length; right += 1) {
      const a = assessed[left], b = assessed[right];
      if (a.datasetIndex !== b.datasetIndex) continue;
      if (a.entryIndex <= b.exitIndex && b.entryIndex <= a.exitIndex) {
        pairs += 1; involved.add(a.eventIndex); involved.add(b.eventIndex);
      }
    }
  }
  return {
    overlappingEventPairs: pairs, eventsInOverlappingWindows: involved.size,
    note: "Överlappande utfallsperioder är statistiskt beroende och ska inte behandlas som helt oberoende observationer.",
  };
}

function invalidReport(reason) {
  return {
    version: EVENT_BACKTEST_VERSION, status: "INVALID", reasons: [reason], options: null,
    input: { datasetCount: 0, eventCount: 0 }, results: [], metrics: null,
    dependence: { overlappingEventPairs: 0, eventsInOverlappingWindows: 0, note: null },
    assumptions: [],
  };
}

/**
 * Event-based daily-OHLC backtest. Signals are known at signalIndex close and
 * execution starts at the next observed open. This function never generates
 * events; callers must discover them using information available at signal time.
 */
export function runEventBacktest({
  datasets, events, targetPct = 5, stopPct = 3, horizon = 20,
  side = "LONG", entryTiming = "NEXT_OPEN", quantity = 1,
  feePerOrder = 0, slippageBps = 0, spreadBps = 0, ambiguousPolicy = "TIE",
} = {}) {
  if (!Array.isArray(datasets) || !Array.isArray(events)) return invalidReport("Dataserier och händelser måste vara listor.");
  if (!finite(targetPct) || targetPct <= 0 || targetPct >= 100 || !finite(stopPct) || stopPct <= 0 || stopPct >= 100) {
    return invalidReport("Mål och stop måste vara positiva procenttal under 100.");
  }
  if (!Number.isInteger(horizon) || horizon < 1 || horizon > 252 || !finite(quantity) || quantity <= 0 ||
      !finite(feePerOrder) || feePerOrder < 0 || !finite(feePerOrder * 2) || !finite(slippageBps) || slippageBps < 0 || slippageBps >= 10000 ||
      !finite(spreadBps) || spreadBps < 0 || spreadBps >= 10000 || !["LONG", "SHORT"].includes(side) ||
      entryTiming !== "NEXT_OPEN" || !["TIE", "STOP_FIRST"].includes(ambiguousPolicy)) {
    return invalidReport("Backtestinställningarna är ogiltiga.");
  }
  const executionRate = (slippageBps + spreadBps / 2) / 10000;
  if (executionRate >= 1) return invalidReport("Samlad slippage och halv spread måste vara under 100 procent.");
  const options = { targetPct, stopPct, horizon, side, entryTiming, quantity, feePerOrder, slippageBps, spreadBps, ambiguousPolicy, executionRate };
  const seen = new Set();
  const results = events.map((event, index) => {
    const resolved = resolveEvent(event, datasets, index);
    if (resolved.error) return resolved.error;
    const key = `${resolved.datasetIndex}:${resolved.signalIndex}`;
    if (seen.has(key)) return invalidResult("Samma dataserie och signal får bara testas en gång per körning.", index);
    seen.add(key);
    return assessEvent(resolved, index, options);
  });
  const completed = results.filter((result) => result.status === "COMPLETED");
  const counts = Object.fromEntries(OUTCOMES.map((outcome) => [outcome, completed.filter((result) => result.outcome === outcome).length]));
  const probabilities = Object.fromEntries(OUTCOMES.map((outcome) => [outcome, wilson(counts[outcome], completed.length)]));
  const financial = financialSummary(results);
  const rejectedCount = results.filter((result) => result.status === "REJECTED").length;
  const notAssessedCount = results.filter((result) => result.status === "NOT_ASSESSED").length;
  const status = events.length === 0 ? "EMPTY" : completed.length === 0 ? "NOT_ASSESSED" : rejectedCount || notAssessedCount ? "PARTIAL" : "COMPLETED";
  return {
    version: EVENT_BACKTEST_VERSION, status, reasons: [],
    options: { ...options, executionRate: round(executionRate) },
    input: { datasetCount: datasets.length, eventCount: events.length }, results,
    metrics: {
      assessedEventCount: completed.length, rejectedEventCount: rejectedCount, notAssessedEventCount: notAssessedCount,
      outcomeCounts: counts, outcomeProbabilities: probabilities, ...financial,
      stability: stabilitySummary(results),
      ratioConvention: "Sharpe och Sortino beräknas på nettoavkastning per avslutad händelse, utan annualisering eller riskfri ränta. TIE exkluderas från penningmåtten.",
    },
    dependence: overlapSummary(results),
    assumptions: [
      "Signalen antas vara känd först efter signalperiodens stängning; ingång sker tidigast nästa observerade öppning.",
      "Stop-gap fylls vid öppningen. Målgap får ingen gynnsam prisförbättring utöver målnivån.",
      ambiguousPolicy === "TIE"
        ? "Om mål och stop träffas i samma dagsljus utan intradagsdata redovisas TIE utan antaget penningutfall."
        : "Om mål och stop träffas i samma dagsljus används den konservativa regeln stop först.",
      "Slippage försämrar båda fills. Angiven spread delas lika mellan köp- och säljsidan. Avgift tas per order.",
      "Resultaten är historiska simuleringar, inte en garanti eller kalibrerad prognos för framtida utfall.",
    ],
  };
}
