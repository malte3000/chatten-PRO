export const STRATEGY_VERSION = "v0.1";

function roundScore(value) {
  const number = Number(value);

  if (!Number.isFinite(number)) {
    return null;
  }

  return Math.max(
    0,
    Math.min(100, Math.round(number * 100) / 100)
  );
}

function getSignal(ensemble) {
  if (ensemble >= 60) {
    return {
      signal: "BUY",
      direction: "LONG",
      confidence: roundScore(ensemble),
    };
  }

  if (ensemble <= 40) {
    return {
      signal: "SELL",
      direction: "SHORT",
      confidence: roundScore(100 - ensemble),
    };
  }

  // Confidence här betyder hur starkt systemet anser
  // att NO_TRADE är rätt beslut.
  const noTradeConfidence =
    100 - Math.abs(ensemble - 50) * 2;

  return {
    signal: "NO_TRADE",
    direction: "NONE",
    confidence: roundScore(noTradeConfidence),
  };
}

function getChartPattern(aiAnalysis) {
  if (!aiAnalysis) return null;

  const pattern = aiAnalysis.technical_pattern;

  if (typeof pattern === "string") {
    return pattern;
  }

  if (pattern && typeof pattern === "object") {
    return pattern.name || pattern.label || null;
  }

  return aiAnalysis.candlestick_pattern || null;
}

function getChartConfidence(aiAnalysis) {
  if (!aiAnalysis) return null;

  const pattern = aiAnalysis.technical_pattern;

  if (
    pattern &&
    typeof pattern === "object" &&
    typeof pattern.confidence === "number"
  ) {
    return roundScore(pattern.confidence);
  }

  if (typeof aiAnalysis.pattern_confidence === "number") {
    return roundScore(aiAnalysis.pattern_confidence);
  }

  return null;
}

function getSafeTrend(aiAnalysis, momentum) {
  const trend = aiAnalysis?.trend || momentum;

  if (
    trend === "bullish" ||
    trend === "bearish" ||
    trend === "neutral" ||
    trend === "unclear"
  ) {
    return trend;
  }

  return null;
}

function createTradeId(ticker) {
  const randomPart =
    globalThis.crypto?.randomUUID?.() ||
    `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

  return `${ticker}-${randomPart}`;
}

export function buildTradeRecord({
  ticker,
  result,
  price,
  momentum,
  momentumScore,
  aiAnalysis,
  newsAnalysis,
  market,
}) {
  const cleanTicker = ticker.trim().toUpperCase();

  if (!cleanTicker) {
    throw new Error("Ticker saknas");
  }

  if (!result || typeof result.ensemble !== "number") {
    throw new Error("Simulatorresultat saknas");
  }

  const decision = getSignal(result.ensemble);

  const newsConfidence =
    typeof newsAnalysis?.confidence === "number"
      ? roundScore(newsAnalysis.confidence)
      : null;

  const catalystStrength =
    typeof newsAnalysis?.catalyst_strength === "number"
      ? Math.max(
          0,
          Math.min(10, newsAnalysis.catalyst_strength)
        )
      : null;

  return {
    trade_id: createTradeId(cleanTicker),
    strategy_version: STRATEGY_VERSION,

    ticker: cleanTicker,
    company_name: null,
    timestamp: new Date().toISOString(),

    signal: decision.signal,
    direction: decision.direction,
    confidence: decision.confidence,

    entry_price:
      decision.signal === "NO_TRADE"
        ? null
        : Number(price),

    stop_loss: null,
    target: null,
    exit_price: null,

    risk_reward: null,
    position_size: null,
    risk_percent: null,
    risk_amount: null,

    technical_score: null,

    momentum_score:
      typeof momentumScore === "number"
        ? roundScore(momentumScore)
        : null,

    volume_score: null,
    volatility_score: null,

    trend: getSafeTrend(aiAnalysis, momentum),

    support: null,
    resistance: null,
    rvol: null,
    atr: null,

    news_score:
      typeof result.newsScore === "number"
        ? roundScore(result.newsScore)
        : null,

    news_confidence: newsConfidence,
    catalyst_strength: catalystStrength,

    chart_pattern: getChartPattern(aiAnalysis),
    chart_confidence: getChartConfidence(aiAnalysis),

    market_regime: null,
    sector_direction: null,
    index_direction: null,

    risk_engine_status: "NOT_EVALUATED",
    risk_rejection_reason: null,

    trade_status:
      decision.signal === "NO_TRADE"
        ? "NO_TRADE"
        : "SIGNAL_ONLY",

    result_percent: null,
    result_R: null,
    winner: null,
    exit_reason: null,

    post_trade_analysis: null,

    detected_errors: [],

    learning_tags: [
      "auto_logged",
      `market:${market}`,
    ],
  };
}
