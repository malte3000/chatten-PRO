import { selectClosedDailyBars } from "./dailyBars.js";
import { assessSwingSetup, SWING_SETUP_IDS, SWING_STRATEGY_VERSION } from "./strategyModel.js";
import { assessSwingViability } from "./swingViability.js";

export const STRATEGY_VERSION = "v0.2-readiness";
export const READINESS_VERSION = "readiness-v0.6";
export const normalizeTicker = (value) => String(value || "").trim().toUpperCase();
const readinessDecision = (status, reasons, reason_codes) => ({ version: READINESS_VERSION, status, reasons, reason_codes });
const MARKET_CURRENCIES = { usa: "USD", stockholm: "SEK" };
const isPositive = (value) => Number.isFinite(value) && value > 0;
const sameNumber = (a, b) => Number.isFinite(a) && Number.isFinite(b) &&
  Math.abs(a - b) <= Math.max(1e-8, Math.max(Math.abs(a), Math.abs(b)) * 1e-10);

function validPlans(strategy, latestPrice) {
  if (!Array.isArray(strategy?.setups) || !Array.isArray(strategy?.plans) ||
      strategy.setups.length === 0 || strategy.setups.length !== strategy.plans.length ||
      new Set(strategy.setups).size !== strategy.setups.length ||
      strategy.setups.some((setup) => !SWING_SETUP_IDS.includes(setup))) return false;
  return strategy.plans.every((plan, index) => {
    if (!plan || plan.setup !== strategy.setups[index] ||
        ![plan.entry_reference, plan.stop, plan.target, plan.risk_per_share, plan.theoretical_risk_reward].every(isPositive) ||
        !sameNumber(plan.entry_reference, latestPrice) || plan.stop >= plan.entry_reference || plan.target <= plan.entry_reference) return false;
    const risk = plan.entry_reference - plan.stop;
    return sameNumber(plan.risk_per_share, risk) &&
      sameNumber(plan.theoretical_risk_reward, (plan.target - plan.entry_reference) / risk);
  });
}

// A TRADE is an unfilled technical signal, never an executed order or a measured probability.
// News and an optional chart do not enter the decision.
export function evaluateReadiness({ ticker, marketData, marketStatus, market, horizonCode, strategy, errors = [], now = Date.now() }) {
  if (!Array.isArray(errors)) return readinessDecision("NOT_ASSESSED", ["Uppströmsfelens format är ogiltigt."], ["UPSTREAM_ERROR"]);
  if (errors.length) return readinessDecision("NOT_ASSESSED", errors.map(String), ["UPSTREAM_ERROR"]);
  if (horizonCode !== "week") {
    return readinessDecision("NOT_ASSESSED", ["En färdigställd swingbedömning saknas för vald tidshorisont."], ["HORIZON_UNSUPPORTED"]);
  }
  if (!MARKET_CURRENCIES[market] || marketStatus?.market !== market || marketStatus?.reason == null) {
    return readinessDecision("NOT_ASSESSED", ["Tillförlitlig börsklocka för den valda marknaden saknas."], ["MARKET_CLOCK_UNVERIFIED"]);
  }
  const symbol = normalizeTicker(ticker);
  const matches = Boolean(symbol) && normalizeTicker(marketData?.ticker) === symbol &&
    (!marketData?.requested_ticker || normalizeTicker(marketData.requested_ticker) === symbol) &&
    (!marketData?.requested_exchange || normalizeTicker(marketData.requested_exchange) === normalizeTicker(marketData.exchange));
  if (!marketData || !matches || marketData.validation?.valid !== true) {
    return readinessDecision("NOT_ASSESSED", ["Validerad marknadsdata för aktuell aktie och börs saknas."], ["MARKET_DATA_INVALID"]);
  }
  if (marketData.currency !== MARKET_CURRENCIES[market]) {
    return readinessDecision("NOT_ASSESSED", ["Prisdatans valuta stöds inte för vald marknad."], ["CURRENCY_UNSUPPORTED"]);
  }
  const verified = marketData.verified_instrument;
  if (verified?.type !== "Common Stock" || normalizeTicker(verified.symbol) !== symbol ||
      normalizeTicker(verified.exchange) !== normalizeTicker(marketData.exchange) ||
      verified.currency !== marketData.currency ||
      verified.country !== (market === "usa" ? "United States" : "Sweden")) {
    return readinessDecision("NOT_ASSESSED", ["Aktietyp, ticker och börs kunde inte verifieras mot datakällans aktielista."], ["INSTRUMENT_UNVERIFIED"]);
  }
  const selection = selectClosedDailyBars(marketData, { marketStatus, now, requireExpectedSession: true });
  if (!selection.valid) return readinessDecision("NOT_ASSESSED", selection.reasons, ["CLOSED_BARS_UNVERIFIED"]);
  const latest = selection.bars.at(-1);
  if (!isPositive(marketData.price) || !sameNumber(marketData.price, latest.close) ||
      (marketData.latest && (marketData.latest.datetime !== latest.datetime || !sameNumber(marketData.latest.close, latest.close)))) {
    return readinessDecision("NOT_ASSESSED", ["Senaste priset matchar inte den färdigställda dagskursen."], ["PRICE_INVALID"]);
  }
  if (!strategy || strategy.status === "NOT_ASSESSED") {
    return readinessDecision("NOT_ASSESSED", ["Ett bedömt swingupplägg saknas för vald horisont."], ["SWING_NOT_ASSESSED"]);
  }
  if (strategy.version !== SWING_STRATEGY_VERSION) {
    return readinessDecision("NOT_ASSESSED", ["Strategibedömningen använder en äldre eller okänd version."], ["STRATEGY_VERSION_INVALID"]);
  }
  if (!["WATCH", "NO_SETUP"].includes(strategy.status)) {
    return readinessDecision("NOT_ASSESSED", ["Strategibedömningen har en ogiltig status."], ["STRATEGY_STATUS_INVALID"]);
  }
  const expected = assessSwingSetup(marketData, { ticker: symbol, marketStatus, now });
  if (expected.status !== strategy.status || expected.version !== strategy.version ||
      JSON.stringify(expected.setups) !== JSON.stringify(strategy.setups) ||
      JSON.stringify(expected.metrics) !== JSON.stringify(strategy.metrics) ||
      JSON.stringify(expected.plans) !== JSON.stringify(strategy.plans)) {
    return readinessDecision("NOT_ASSESSED", ["Swingupplägget matchar inte de verifierade dagskurserna."], ["STRATEGY_SNAPSHOT_MISMATCH"]);
  }
  if (strategy.status === "NO_SETUP") {
    return readinessDecision("NO_TRADE", ["Inget swingupplägg uppfyllde reglerna på senaste stängda dagsljuset."], ["SWING_NO_SETUP"]);
  }
  if (strategy.metrics?.latest_closed_candle !== selection.latestDate ||
      !sameNumber(strategy.metrics?.last_closed_price, latest.close) || !validPlans(strategy, latest.close)) {
    return readinessDecision("NOT_ASSESSED", ["Swinguppläggets datum, pris eller risknivåer kunde inte verifieras."], ["PLAN_INVALID"]);
  }
  // Match the scanner's basic viability thresholds using only the 20 completed
  // sessions before the signal candle; these are not claims of profitability.
  const viability = assessSwingViability(selection.bars, strategy.metrics.atr, market);
  if (viability.status !== "PASS") return readinessDecision(viability.status, viability.reasons, viability.reason_codes);
  return readinessDecision("TRADE", [
    `Ett tekniskt swingupplägg (${strategy.setups.join(" + ")}) uppfyllde reglerna på färdigställd dagskurs. Nyheter ingår inte i beslutet.`,
    "Signalen har en förutbestämd riskplan men ingen affär har genomförts. Utfallet och strategins träffsäkerhet är ännu inte fastställda.",
  ], ["SWING_SETUP_CONFIRMED"]);
}

export function createAnalysisRecord({ ticker, horizon, horizonCode, market, marketStatus, evaluatedAt, marketData, news, newsRequested = false, newsError = null, chart, decision, strategy }, { now = new Date(), id = globalThis.crypto.randomUUID() } = {}) {
  // Signal-only analyses are separate from actual fills, positions and outcomes.
  const tradeSignal = decision?.version === READINESS_VERSION && decision.status === "TRADE" &&
    strategy?.version === SWING_STRATEGY_VERSION && Array.isArray(strategy.plans) && strategy.plans.length > 0;
  return {
    trade_id: `${normalizeTicker(ticker)}-${id}`, strategy_version: strategy?.version || STRATEGY_VERSION,
    ticker: normalizeTicker(ticker), timestamp: now.toISOString(),
    signal: tradeSignal ? "BUY" : "NO_TRADE", direction: tradeSignal ? "LONG" : "NONE", confidence: 0,
    trade_status: tradeSignal ? "SIGNAL_ONLY" : "NO_TRADE", risk_engine_status: "NOT_EVALUATED",
    entry_price: null, stop_loss: null, target: null, risk_reward: null,
    result_percent: null, winner: null, news_confidence: news?.direction_confidence ?? null,
    signal_inputs: {
      record_type: "ANALYSIS", decision, horizon, horizon_code: horizonCode || null,
      market, market_status: marketStatus || null,
      evaluated_at: typeof evaluatedAt === "string" && Number.isFinite(Date.parse(evaluatedAt)) ? evaluatedAt : null,
      strategy: strategy || null,
      signal_plan: tradeSignal ? { ...strategy.plans[0] } : null,
      market_data: marketData || null, news: news || null, chart: chart || null,
      news_requested: newsRequested === true,
      news_error: typeof newsError === "string" && newsError.trim() ? newsError.trim() : null,
      probability_calibrated: false,
      confidence_note: "Legacy required field is 0; not a probability or measured accuracy.",
    },
    detected_errors: [], learning_tags: ["analysis_only", `market:${market}`],
  };
}

export function createRealTradeRecord({ analysis, direction, entryPrice, stopLoss = null, target = null, positionSize = null, fees = 0 }, { now = new Date(), id = globalThis.crypto.randomUUID() } = {}) {
  const normalizedDirection = String(direction || "").toUpperCase();
  const entry = Number(entryPrice);
  const stop = stopLoss === "" || stopLoss == null ? null : Number(stopLoss);
  const takeProfit = target === "" || target == null ? null : Number(target);
  const size = positionSize === "" || positionSize == null ? null : Number(positionSize);
  const feeAmount = Number(fees || 0);
  if (!analysis || !normalizeTicker(analysis.ticker)) throw new Error("En giltig aktieanalys krävs.");
  if (!["LONG", "SHORT"].includes(normalizedDirection)) throw new Error("Välj lång eller kort riktning.");
  if (!Number.isFinite(entry) || entry <= 0) throw new Error("Ange ett giltigt faktiskt ingångspris.");
  if (stop !== null && (!Number.isFinite(stop) || stop <= 0 || (normalizedDirection === "LONG" ? stop >= entry : stop <= entry))) throw new Error("Stoppen måste ligga på risksidan om ingången.");
  if (takeProfit !== null && (!Number.isFinite(takeProfit) || takeProfit <= 0 || (normalizedDirection === "LONG" ? takeProfit <= entry : takeProfit >= entry))) throw new Error("Målnivån måste ligga i affärens riktning från ingången.");
  if (size === null || !Number.isFinite(size) || size <= 0) throw new Error("Ange faktisk positionsstorlek för att kunna mäta utfallet efter avgifter.");
  if (!Number.isFinite(feeAmount) || feeAmount < 0) throw new Error("Avgifter kan inte vara negativa.");
  const side = normalizedDirection === "LONG" ? 1 : -1;
  const risk = stop === null ? null : Math.abs(entry - stop);
  const reward = takeProfit === null ? null : (takeProfit - entry) * side;
  return {
    trade_id: `${normalizeTicker(analysis.ticker)}-${id}`,
    strategy_version: analysis.strategy?.version || analysis.record?.strategy_version || STRATEGY_VERSION,
    ticker: normalizeTicker(analysis.ticker), timestamp: now.toISOString(),
    signal: normalizedDirection === "LONG" ? "BUY" : "SELL", direction: normalizedDirection,
    confidence: 0, entry_price: entry, stop_loss: stop, target: takeProfit,
    risk_reward: risk && reward > 0 ? reward / risk : null,
    position_size: size, trade_status: "OPEN", risk_engine_status: "NOT_EVALUATED",
    exit_price: null, result_percent: null, result_r: null, winner: null,
    signal_inputs: {
      record_type: "REAL_TRADE", source_analysis_trade_id: analysis.record?.trade_id || null,
      horizon: analysis.horizon || null, market: analysis.market || null,
      currency: analysis.marketData?.currency || null,
      source_decision: analysis.decision || null, strategy: analysis.strategy || null,
      actual_entry_fees: feeAmount,
      entered_at: now.toISOString(), probability_calibrated: false,
    },
    detected_errors: [], learning_tags: ["real_trade", `market:${analysis.market || "unknown"}`],
  };
}
