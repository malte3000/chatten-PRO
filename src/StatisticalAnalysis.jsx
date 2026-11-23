import React, { useMemo, useState } from "react";
import { analyzePatternDiscovery, PATTERN_DISCOVERY_VERSION } from "./patternDiscoveryModel.js";

const CONTROL = "border border-cyan-800 bg-slate-950 text-slate-100 rounded px-3 py-2 text-sm";
const THRESHOLDS = [...Array.from({ length: 30 }, (_, index) => index + 1), 35, 40, 50];
const HORIZONS = [1, 5, 10, 20, 60];
const TARGETS = [3, 5, 10];
const MIN_SAMPLE_SIZE = 20;

const finite = (value) => typeof value === "number" && Number.isFinite(value);
const numeric = (value) => {
  const parsed = typeof value === "string" && value.trim() ? Number(value) : value;
  return finite(parsed) ? parsed : null;
};
const firstNumber = (object, keys) => {
  for (const key of keys) {
    const value = numeric(object?.[key]);
    if (value !== null) return value;
  }
  return null;
};
const formatNumber = (value, digits = 2) => finite(value)
  ? value.toLocaleString("sv-SE", { minimumFractionDigits: 0, maximumFractionDigits: digits })
  : "—";
const formatPercent = (value) => finite(value) ? `${formatNumber(value, 1)} %` : "—";

function normalizeProbability(value) {
  const number = numeric(value);
  if (number === null || number < 0) return null;
  if (number <= 1) return number * 100;
  return number <= 100 ? number : null;
}

function arrayFrom(value) {
  if (Array.isArray(value)) return value;
  if (value && typeof value === "object") return Object.values(value);
  return [];
}

function selectedBucket(report, { eventType, window, threshold, horizon }) {
  const roots = [report?.summaries, report?.groups, report?.patterns, report?.results, report?.analyses, report?.buckets]
    .flatMap(arrayFrom);
  const windowKeys = ["window", "window_sessions", "windowSessions", "drawdown_window", "drawdownWindow", "lookback", "lookback_sessions"];
  const thresholdKeys = ["threshold", "threshold_pct", "thresholdPct", "thresholdPercent", "drawdown_pct", "drawdownPercent"];
  const matches = roots.filter((item) => {
    if (!item || typeof item !== "object") return false;
    const itemWindow = firstNumber(item, windowKeys);
    const itemThreshold = Math.abs(firstNumber(item, thresholdKeys) ?? NaN);
    const type = String(item.event_type || item.eventType || item.type || "").toUpperCase();
    const typeMatches = eventType === "ONE_DAY_DROP"
      ? type === "ONE_DAY_DROP"
      : (itemWindow === window || type === `DRAWDOWN_${window}`) && (!type || type.includes("DRAWDOWN"));
    return typeMatches && itemThreshold === threshold;
  });
  const bucket = matches[0] || null;
  if (!bucket) return { bucket: null, outcome: null };
  const horizons = bucket.horizons || bucket.outcomes_by_horizon || bucket.outcomesByHorizon || bucket.outcomes;
  const outcome = Array.isArray(horizons)
    ? horizons.find((item) => firstNumber(item, ["horizon", "horizon_sessions", "horizonSessions", "sessions", "days"]) === horizon)
    : horizons?.[horizon] || horizons?.[String(horizon)] || null;
  return { bucket, outcome: outcome || bucket };
}

function selectedProbability(container, kind, target) {
  const sources = kind === "recovery"
    ? [container?.recovery_probabilities, container?.recoveryProbabilities, container?.recovery]
    : [container?.continuation_probabilities, container?.continuationProbabilities, container?.continuation];
  const items = sources.flatMap(arrayFrom);
  const match = items.find((item) => {
    const itemTarget = Math.abs(firstNumber(item, ["target", "target_pct", "targetPct", "targetPercent", "furtherDeclinePct", "threshold", "threshold_pct"]) ?? NaN);
    return itemTarget === target;
  });
  if (match && typeof match === "object") return match;
  const source = sources.find((value) => value && typeof value === "object" && !Array.isArray(value));
  return source?.[target] || source?.[String(target)] || null;
}

function intervalFrom(item) {
  const interval = item?.confidence_interval || item?.confidenceInterval || item?.wilson_interval || item?.interval;
  if (Array.isArray(interval) && interval.length >= 2) {
    return [normalizeProbability(interval[0]), normalizeProbability(interval[1])];
  }
  if (interval && typeof interval === "object") {
    const explicitLowerPct = numeric(interval.lowerPct);
    const explicitUpperPct = numeric(interval.upperPct);
    return [
      explicitLowerPct ?? normalizeProbability(interval.lower ?? interval.low ?? interval.min),
      explicitUpperPct ?? normalizeProbability(interval.upper ?? interval.high ?? interval.max),
    ];
  }
  const lower = normalizeProbability(item?.ci_lower ?? item?.lower);
  const upper = normalizeProbability(item?.ci_upper ?? item?.upper);
  return lower === null && upper === null ? null : [lower, upper];
}

function probabilityView(item, fallbackSample, fallbackStatus) {
  const sampleSize = firstNumber(item, ["sample_size", "sampleSize", "observations", "count", "n"]) ?? fallbackSample;
  const status = String(item?.status || fallbackStatus || "").toUpperCase();
  const explicitPct = numeric(item?.probabilityPct);
  const probability = explicitPct ?? normalizeProbability(item?.probability ?? item?.rate ?? item?.value ?? item?.percent);
  const interval = intervalFrom(item);
  const unavailable = !finite(sampleSize) || sampleSize < MIN_SAMPLE_SIZE || probability === null ||
    status.includes("INSUFFICIENT") || status.includes("INVALID") || status.includes("NOT_ASSESSED");
  return { sampleSize, status, probability: unavailable ? null : probability, interval: unavailable ? null : interval };
}

function marketRegime(marketData) {
  const bars = Array.isArray(marketData?.bars) ? marketData.bars : [];
  const closes = bars.map((bar) => numeric(bar?.close)).filter((value) => value !== null);
  if (closes.length < 50) return { label: "Ej bedömt", detail: "Minst 50 giltiga stängningskurser krävs för den beskrivande regimkontrollen." };
  const ema = (period) => {
    let value = closes.slice(0, period).reduce((sum, item) => sum + item, 0) / period;
    const alpha = 2 / (period + 1);
    for (const item of closes.slice(period)) value += alpha * (item - value);
    return value;
  };
  const price = closes.at(-1);
  const ema20 = ema(20);
  const ema50 = ema(50);
  const momentum = price / closes.at(-6) - 1;
  const direction = price > ema20 && ema20 > ema50 && momentum > 0
    ? "Stigande" : price < ema20 && ema20 < ema50 && momentum < 0 ? "Fallande" : "Sidledes/blandad";
  const logReturns = closes.slice(1).map((close, index) => Math.log(close / closes[index]));
  const deviation = (values) => {
    if (values.length < 2) return null;
    const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
    return Math.sqrt(values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (values.length - 1));
  };
  const recent = deviation(logReturns.slice(-20));
  const prior = deviation(logReturns.slice(-40, -20));
  const volatility = finite(recent) && finite(prior) && prior > 0
    ? recent > prior * 1.25 ? "högre volatilitet" : recent < prior * 0.8 ? "lägre volatilitet" : "normal volatilitet"
    : "volatilitet ej jämförbar";
  return {
    label: `${direction} · ${volatility}`,
    detail: "Beskrivande EMA20/EMA50-, femsessionsmomentum- och volatilitetsjämförelse, inte en tränad marknadsregimmodell.",
  };
}

function MetricCard({ title, value, children, tone = "text-cyan-300" }) {
  return <section className="border border-slate-800 rounded p-3" aria-label={title}>
    <h4 className="text-xs uppercase tracking-wide text-slate-400">{title}</h4>
    <p className={`mt-2 text-lg font-semibold ${tone}`}>{value}</p>
    <div className="mt-2 text-xs text-slate-400 space-y-1">{children}</div>
  </section>;
}

function ProbabilityCard({ title, view, description }) {
  const available = finite(view.probability);
  return <MetricCard title={title} value={available ? formatPercent(view.probability) : "Otillräckligt underlag"} tone={available ? "text-cyan-300" : "text-amber-300"}>
    <p>{description}</p>
    <p>{finite(view.sampleSize) ? `${view.sampleSize} historiska observationer.` : "Antal historiska observationer saknas."}</p>
    {available && view.interval?.every(finite) && <p>95 % osäkerhetsintervall: {formatPercent(view.interval[0])}–{formatPercent(view.interval[1])}.</p>}
    {available && !view.interval?.every(finite) && <p className="text-amber-300">Osäkerhetsintervall saknas; siffran ska tolkas försiktigt.</p>}
    {!available && <p>Minst {MIN_SAMPLE_SIZE} jämförbara observationer krävs innan en sannolikhet visas.</p>}
  </MetricCard>;
}

export default function StatisticalAnalysis({ marketData, market, ticker }) {
  const [eventType, setEventType] = useState("DRAWDOWN");
  const [window, setWindow] = useState(30);
  const [threshold, setThreshold] = useState(10);
  const [horizon, setHorizon] = useState(20);
  const [recoveryTarget, setRecoveryTarget] = useState(5);
  const [continuationTarget, setContinuationTarget] = useState(3);

  const analysis = useMemo(() => {
    if (!marketData || marketData.interval !== "1day" || !Array.isArray(marketData.bars)) {
      return { report: null, error: "Statistisk mönsteranalys kräver hämtade stängda dagskurser." };
    }
    try {
      const report = analyzePatternDiscovery({
        datasets: [marketData],
        drawdownWindows: [window],
        horizons: [horizon],
        thresholds: [threshold],
        recoveryTargets: [recoveryTarget],
        continuationTargets: [continuationTarget],
        minSampleSize: MIN_SAMPLE_SIZE,
        eventCooldown: 5,
      });
      return { report, error: null };
    } catch (error) {
      return { report: null, error: error instanceof Error ? error.message : "Analysen kunde inte beräknas." };
    }
  }, [marketData, window, threshold, horizon, recoveryTarget, continuationTarget]);

  const selection = selectedBucket(analysis.report, { eventType, window, threshold, horizon });
  const sampleSize = firstNumber(selection.outcome, ["sample_size", "sampleSize", "observations", "count", "n"])
    ?? firstNumber(selection.bucket, ["sample_size", "sampleSize", "observations", "event_count", "eventCount", "count", "n"])
    ?? firstNumber(analysis.report?.summary, ["sample_size", "sampleSize", "observations", "event_count", "eventCount", "count", "n"]);
  const fallbackStatus = selection.outcome?.status || selection.bucket?.status || analysis.report?.status;
  const recovery = probabilityView(selectedProbability(selection.outcome, "recovery", recoveryTarget), sampleSize, fallbackStatus);
  const continuation = probabilityView(selectedProbability(selection.outcome, "continuation", continuationTarget), sampleSize, fallbackStatus);
  const regime = useMemo(() => marketRegime(marketData), [marketData]);
  const meanReturn = firstNumber(selection.outcome?.terminalReturn, ["meanPct", "mean_return_pct", "meanReturnPct", "average_return_pct", "averageReturnPct"])
    ?? firstNumber(selection.outcome, ["mean_return_pct", "meanReturnPct", "average_return_pct", "averageReturnPct"]);
  const medianReturn = firstNumber(selection.outcome?.terminalReturn, ["medianPct", "median_return_pct", "medianReturnPct"])
    ?? firstNumber(selection.outcome, ["median_return_pct", "medianReturnPct"]);
  const maxAdverse = firstNumber(selection.outcome?.maxAdverseExcursion, ["meanPct", "mean", "averagePct"])
    ?? firstNumber(selection.outcome, ["mean_max_adverse_excursion_pct", "meanMaxAdverseExcursionPct", "max_adverse_excursion_pct"]);
  const confidenceAvailable = finite(recovery.probability) || finite(continuation.probability);
  const reportReasons = arrayFrom(analysis.report?.reasons).filter((item) => typeof item === "string");

  return <details className="border-t border-slate-800 mt-3 pt-3 text-sm">
    <summary className="cursor-pointer text-cyan-300">Se mer – statistisk mönsteranalys</summary>
    <div className="mt-3 space-y-4 text-slate-300">
      <div>
        <h3 className="font-semibold text-slate-100">Pattern Explorer · första versionen</h3>
        <p className="mt-1 text-xs text-slate-400">Analyserar enbart redan hämtade dagskurser för {String(ticker || marketData?.ticker || "vald aktie").toUpperCase()}. Inga nya API-anrop eller journalskrivningar görs.</p>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <label>Händelsetyp
          <select className={`${CONTROL} block w-full mt-1`} value={eventType} onChange={(event) => setEventType(event.target.value)}>
            <option value="DRAWDOWN">Fall från tidigare topp</option><option value="ONE_DAY_DROP">Fall under en handelsdag</option>
          </select>
        </label>
        <label>Drawdown-fönster
          <select className={`${CONTROL} block w-full mt-1 disabled:opacity-50`} disabled={eventType === "ONE_DAY_DROP"} value={window} onChange={(event) => setWindow(Number(event.target.value))}>
            <option value={30}>30 handelssessioner</option><option value={90}>90 handelssessioner</option>
          </select>
        </label>
        <label>Nedgång från tidigare topp
          <select className={`${CONTROL} block w-full mt-1`} value={threshold} onChange={(event) => setThreshold(Number(event.target.value))}>
            {THRESHOLDS.map((value) => <option key={value} value={value}>−{value} %</option>)}
          </select>
        </label>
        <label>Utfallshorisont
          <select className={`${CONTROL} block w-full mt-1`} value={horizon} onChange={(event) => setHorizon(Number(event.target.value))}>
            {HORIZONS.map((value) => <option key={value} value={value}>{value} handelssessioner</option>)}
          </select>
        </label>
        <label>Positivt kursmål
          <select className={`${CONTROL} block w-full mt-1`} value={recoveryTarget} onChange={(event) => setRecoveryTarget(Number(event.target.value))}>
            {TARGETS.map((value) => <option key={value} value={value}>+{value} %</option>)}
          </select>
        </label>
        <label>Ytterligare nedgång
          <select className={`${CONTROL} block w-full mt-1`} value={continuationTarget} onChange={(event) => setContinuationTarget(Number(event.target.value))}>
            {TARGETS.map((value) => <option key={value} value={value}>−{value} %</option>)}
          </select>
        </label>
        <label className="text-slate-500">Volym- och volatilitetsfilter
          <select className={`${CONTROL} block w-full mt-1 opacity-60`} disabled value="all" aria-describedby="future-filters">
            <option value="all">Alla · kräver större underlag</option>
          </select>
        </label>
      </div>
      <p id="future-filters" className="text-xs text-slate-500">Kombinationsfilter aktiveras först när flera instrument och ett tillräckligt stort urval finns, så att små stickprov inte presenteras som ett samband.</p>

      {analysis.error && <p role="alert" className="text-amber-300">{analysis.error}</p>}
      {!analysis.error && reportReasons.length > 0 && <ul className="list-disc pl-5 text-xs text-amber-300">{reportReasons.map((reason) => <li key={reason}>{reason}</li>)}</ul>}

      <div className="grid gap-3 sm:grid-cols-2">
        <ProbabilityCard title="Recovery Probability" view={recovery} description={`Historisk andel som nådde +${recoveryTarget} % inom ${horizon} sessioner efter ${eventType === "ONE_DAY_DROP" ? `ett endagsfall i intervallet kring −${threshold} %` : `första passeringen av −${threshold} % från tidigare topp`}.`} />
        <ProbabilityCard title="Continuation Probability" view={continuation} description={`Historisk andel som föll ytterligare ${continuationTarget} % inom ${horizon} sessioner. Detta är inte komplementet till återhämtningssiffran.`} />
        <MetricCard title="Historical Pattern Match" value={finite(sampleSize) ? `${sampleSize} händelser` : "Inga verifierade träffar"} tone={finite(sampleSize) && sampleSize >= MIN_SAMPLE_SIZE ? "text-cyan-300" : "text-amber-300"}>
          <p>Första tröskelpassering per sammanhängande nedgång, med cooldown för att begränsa beroende observationer.</p>
          <p>{eventType === "ONE_DAY_DROP" ? "En handelsdag" : `${window}-sessioners tidigare topp`} · −{threshold} % · {horizon}-sessioners utfall.</p>
        </MetricCard>
        <MetricCard title="Pattern Performance" value={finite(meanReturn) ? `${formatPercent(meanReturn)} i medel` : "Kan inte beräknas"} tone={finite(meanReturn) ? "text-slate-200" : "text-amber-300"}>
          <p>Median: {finite(medianReturn) ? formatPercent(medianReturn) : "saknas"}.</p>
          <p>Genomsnittlig maximal ytterligare nedgång: {finite(maxAdverse) ? formatPercent(maxAdverse) : "saknas"}.</p>
          <p>Historiska observationer, inte en modellprognos.</p>
        </MetricCard>
        <MetricCard title="Market Regime" value={regime.label} tone="text-slate-200">
          <p>{regime.detail}</p><p>Vald marknad: {market === "stockholm" ? "Stockholm" : market === "usa" ? "USA" : "ej verifierad"}.</p>
        </MetricCard>
        <MetricCard title="Confidence & Risk" value={confidenceAvailable ? "Osäkerhet redovisad" : "Otillräcklig säkerhet"} tone={confidenceAvailable ? "text-cyan-300" : "text-amber-300"}>
          <p>{confidenceAvailable ? "Visade sannolikheter klarar minimiurvalet; kontrollera fortfarande intervallets bredd." : `Sannolikheter döljs tills minst ${MIN_SAMPLE_SIZE} jämförbara observationer finns.`}</p>
          <p>{analysis.report?.dependence?.overlappingOutcomeWindows
            ? `${analysis.report.dependence.overlappingOutcomePairs} par har överlappande utfallsperioder och är därför inte oberoende.`
            : "Inga överlappande utfallspar identifierades i det valda urvalet."}</p>
        </MetricCard>
      </div>

      <div className="overflow-x-auto border border-slate-800 rounded">
        <table className="w-full text-left text-xs">
          <caption className="sr-only">Vald historisk mönsteranalys</caption>
          <thead className="bg-slate-900 text-slate-400"><tr><th className="p-2">Fönster</th><th className="p-2">Fall</th><th className="p-2">Horisont</th><th className="p-2">Urval</th><th className="p-2">Medel</th><th className="p-2">Median</th></tr></thead>
          <tbody><tr><td className="p-2">{eventType === "ONE_DAY_DROP" ? "1 dag" : window}</td><td className="p-2">−{threshold} %</td><td className="p-2">{horizon}</td><td className="p-2">{finite(sampleSize) ? sampleSize : "—"}</td><td className="p-2">{finite(meanReturn) ? formatPercent(meanReturn) : "—"}</td><td className="p-2">{finite(medianReturn) ? formatPercent(medianReturn) : "—"}</td></tr></tbody>
        </table>
      </div>

      <p className="text-xs text-amber-300">Historiska frekvenser är inte en garanti eller personlig rekommendation. Den här lokala första versionen använder endast den korta prisserie som redan har hämtats; den är inte ett test på flera aktier, överlevnadsbias-korrigerad data eller oberoende testdata.</p>
      <details><summary className="cursor-pointer text-cyan-300">Metod och rå rapport</summary>
        <p className="mt-2 text-xs text-slate-400">{analysis.report?.version || PATTERN_DISCOVERY_VERSION} · framtida kurser används endast för att mäta utfallet efter en historisk händelse.</p>
        <pre className="text-xs whitespace-pre-wrap break-all max-h-80 overflow-auto mt-2">{JSON.stringify(analysis.report, null, 2)}</pre>
      </details>
    </div>
  </details>;
}
