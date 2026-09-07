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

function numberOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
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
  vol,
  drift,
  horizonAmount,
  horizonUnit,
  momentum,
  momentumScore,
  thesis,
  aiAnalysis,
  newsAnalysis,
  market,
  marketStatus,
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
        : numberOrNull(price),

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
    result_r: null,
    winner: null,
    exit_reason: null,

    post_trade_analysis: null,

    signal_inputs: {
      simulator_version: "v2.0",

      market,
      market_status: marketStatus
        ? {
            is_open: Boolean(marketStatus.isOpen),
            hours: marketStatus.hours || null,
          }
        : null,

      current_price: numberOrNull(price),

      volatility_annual_pct: numberOrNull(vol),
      drift_annual_pct: numberOrNull(drift),

      horizon: {
        amount: numberOrNull(horizonAmount),
        unit: horizonUnit || null,
        label: result.horizonLabel || null,
      },

      thesis: thesis || null,
      momentum: momentum || null,
      momentum_score: roundScore(momentumScore),

      monte_carlo: {
        probability_up: roundScore(result.mcProb),
        simulations: numberOrNull(result.nsim),
        big_up_pct: roundScore(result.bigUpPct),
        big_down_pct: roundScore(result.bigDownPct),
      },

      ai: {
        score:
          typeof result.aiScore === "number"
            ? roundScore(result.aiScore)
            : null,

        amd_confidence:
          typeof result.amdConfidence === "number"
            ? roundScore(result.amdConfidence)
            : null,

        amd_phase: result.amdPhase || null,
        amd_status: result.amdStatus || null,

        analysis: aiAnalysis || null,
      },

      news: {
        score:
          typeof result.newsScore === "number"
            ? roundScore(result.newsScore)
            : null,

        confidence: newsConfidence,

        analysis: newsAnalysis || null,
      },

      ensemble: {
        score: roundScore(result.ensemble),
        weights: result.weights || null,
      },
    },

    detected_errors: [],

    learning_tags: [
      "auto_logged",
      `market:${market}`,
    ],
  };
}
