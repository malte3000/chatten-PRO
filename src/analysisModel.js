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

export function createAnalysisRecord({ ticker, horizon, market, marketData, news, chart, decision }, { now = new Date(), id = globalThis.crypto.randomUUID() } = {}) {
  // Keep the existing database enum compatible. WAIT lives in the snapshot.
  // Analysis observations are never OPEN trades or measured probabilities.
  return {
    trade_id: `${normalizeTicker(ticker)}-${id}`, strategy_version: STRATEGY_VERSION,
    ticker: normalizeTicker(ticker), timestamp: now.toISOString(),
    signal: "NO_TRADE", direction: "NONE", confidence: 0,
    trade_status: "NO_TRADE", risk_engine_status: "NOT_EVALUATED",
    entry_price: null, stop_loss: null, target: null, risk_reward: null,
    result_percent: null, winner: null, news_confidence: news?.direction_confidence ?? null,
    signal_inputs: {
      record_type: "ANALYSIS", decision, horizon, market,
      market_data: marketData || null, news: news || null, chart: chart || null,
      probability_calibrated: false,
      confidence_note: "Legacy required field is 0; not a probability or measured accuracy.",
    },
    detected_errors: [], learning_tags: ["analysis_only", `market:${market}`],
  };
}
