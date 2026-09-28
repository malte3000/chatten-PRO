import { validateMarketBars } from "../api/_market-data-validation.js";

export const STRATEGY_VERSION = "v0.2-readiness";
export const normalizeTicker = (value) => String(value || "").trim().toUpperCase();

// Readiness only. AI confidence cannot approve a trade. TRADE remains disabled
// until a tested signal engine and risk engine are implemented.
export function evaluateReadiness({ ticker, marketData, news, errors = [] }) {
  const reasons = [...errors];
  const matches = normalizeTicker(marketData?.ticker) === normalizeTicker(ticker) &&
    (!marketData?.requested_ticker || normalizeTicker(marketData.requested_ticker) === normalizeTicker(ticker));
  if (!marketData || !matches || !marketData.validation?.valid || !validateMarketBars(marketData.bars).valid) {
    reasons.push("Validerad marknadsdata för aktuell ticker saknas.");
  }
  if (!Number.isFinite(marketData?.price) || marketData.price <= 0) reasons.push("Giltigt aktuellt pris saknas.");
  if (!news || normalizeTicker(news.ticker) !== normalizeTicker(ticker)) reasons.push("Nyhetsanalys för aktuell ticker saknas.");
  if (news && !["upp", "ner", "oklart"].includes(news.direction)) reasons.push("Nyhetsriktningen är ogiltig.");
  if (reasons.length) return { status: "NO_TRADE", reasons };
  if (news.direction === "ner") return { status: "NO_TRADE", reasons: ["Nyhetsläget talar mot en lång position."] };
  return { status: "WAIT", reasons: [
    news.direction === "upp" ? "Nyhetsläget kan motivera fortsatt analys, inte en trade." : "Nyhetsläget ger ingen tydlig riktning.",
    "Teknisk signalmotor, riskplan och strategivalidering saknas. TRADE är spärrat.",
  ] };
}

export function createAnalysisRecord({ ticker, horizon, market, marketData, news, chart, decision, strategy }, { now = new Date(), id = globalThis.crypto.randomUUID() } = {}) {
  // Keep the existing database enum compatible. WAIT lives in the snapshot.
  // Analysis observations are never OPEN trades or measured probabilities.
  return {
    trade_id: `${normalizeTicker(ticker)}-${id}`, strategy_version: strategy?.version || STRATEGY_VERSION,
    ticker: normalizeTicker(ticker), timestamp: now.toISOString(),
    signal: "NO_TRADE", direction: "NONE", confidence: 0,
    trade_status: "NO_TRADE", risk_engine_status: "NOT_EVALUATED",
    entry_price: null, stop_loss: null, target: null, risk_reward: null,
    result_percent: null, winner: null, news_confidence: news?.direction_confidence ?? null,
    signal_inputs: {
      record_type: "ANALYSIS", decision, horizon, market, strategy: strategy || null,
      market_data: marketData || null, news: news || null, chart: chart || null,
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
