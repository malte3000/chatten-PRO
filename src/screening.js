import { validateMarketBars } from "../api/_market-data-validation.js";
import { getMarketStatus } from "../api/_market-hours.js";
import { selectClosedDailyBars } from "./dailyBars.js";
import { evaluateReadiness } from "./analysisModel.js";
import { ema } from "./indicators.js";
import { evaluateSwingPatterns, SWING_STRATEGY_VERSION } from "./strategyModel.js";

export { ema } from "./indicators.js";
export const SCREEN_VERSION = "v0.7-experimental";

export function screenInstrument(instrument, marketData, { horizon = "week", market = null, now = Date.now() } = {}) {
  const reasons = [];
  const base = { ...instrument, status: "NOT_ASSESSED", rank_score: 0, metrics: null, reasons, screen_version: SCREEN_VERSION, swing_strategy_version: horizon === "week" ? SWING_STRATEGY_VERSION : null, screening_selection: null, screening_setups: [], screening_plans: [], primary_setup: null, signal_plan: null, decision: null, data_issue: null };
  const unavailable = (code, reason) => { base.data_issue = code; reasons.push(reason); return base; };
  const sourceBars = marketData?.bars;
  if (marketData?.ticker !== instrument.symbol) return unavailable("INSTRUMENT_MISMATCH", "Kursdatan matchar inte den valda aktien.");
  if (!Array.isArray(sourceBars) || sourceBars.length < 60) return unavailable("INSUFFICIENT_BARS", "Minst 60 giltiga candles för rätt instrument krävs.");
  let bars = sourceBars;
  let marketStatus = null;
  if (horizon === "week") {
    if (!["usa", "stockholm"].includes(market) || !Number.isFinite(now)) {
      return unavailable("MARKET_CLOCK_UNVERIFIED", "Tillförlitlig börsklocka saknas för färdigställda dagskurser.");
    }
    marketStatus = getMarketStatus(market, new Date(now));
    // The current session may have zero volume or an unfinished OHLC range.
    // Exclude it before validating the completed bars used for screening.
    const unfinishedDate = marketStatus.reason === "after_close" ? null : marketStatus.sessionDate;
    const completedBars = unfinishedDate ? sourceBars.filter((bar) => bar?.datetime !== unfinishedDate) : sourceBars;
    if (completedBars.some((bar) => !Number.isFinite(bar?.volume) || bar.volume <= 0)) {
      return unavailable("UNRELIABLE_VOLUME", "Positiv och tillförlitlig volym krävs för varje använd dagskurs.");
    }
    const selection = selectClosedDailyBars({ ...marketData, bars: completedBars }, { marketStatus, now, minBars: 60, requireExpectedSession: true });
    if (!selection.valid) return unavailable("INVALID_DAILY_DATA", selection.reasons.join(" "));
    bars = selection.bars;
    base.screening_selection = {
      latest_closed_datetime: selection.latestDate,
      session_date: selection.sessionDate,
      excluded_current_session: completedBars.length !== sourceBars.length || selection.excludedCurrentSession,
      time_zone: selection.timeZone,
    };
  } else if (!validateMarketBars(bars).valid) {
    return unavailable("INVALID_INTRADAY_DATA", "Minst 60 giltiga candles för rätt instrument krävs.");
  }
  if (bars.some((bar) => !Number.isFinite(bar.volume) || bar.volume <= 0)) {
    return unavailable("UNRELIABLE_VOLUME", "Tillförlitlig volymdata saknas.");
  }
  const swingAssessment = horizon === "week" ? evaluateSwingPatterns(bars) : null;
  if (swingAssessment?.status === "NOT_ASSESSED") {
    return unavailable("INVALID_SWING_PATTERN_DATA", swingAssessment.reasons.join(" "));
  }
  // Request UTC timestamps from the provider; never assume local-exchange time.
  const latestTime = Date.parse(`${bars.at(-1).datetime.replace(" ", "T")}Z`);
  const maxAge = horizon === "week" ? 7 * 86400000 : 36 * 3600000;
  if (!Number.isFinite(latestTime) || now - latestTime > maxAge || latestTime > now + 900000) {
    return unavailable("STALE_OR_INVALID_PRICE_TIME", "Prisdatans tid är ogiltig eller för gammal för horisonten.");
  }
  const closes = bars.map((bar) => bar.close);
  const price = closes.at(-1);
  const ema20 = ema(closes, 20);
  const ema50 = ema(closes, 50);
  const ranges = bars.slice(1).map((bar, index) => Math.max(bar.high - bar.low, Math.abs(bar.high - bars[index].close), Math.abs(bar.low - bars[index].close)));
  const atr = ranges.slice(-14).reduce((sum, value) => sum + value, 0) / 14;
  const baseline = bars.slice(-21, -1);
  const avgVolume = baseline.reduce((sum, bar) => sum + bar.volume, 0) / baseline.length;
  const rvol = bars.at(-1).volume / avgVolume;
  const sortedBaselineVolumes = baseline.map((bar) => bar.volume).sort((a, b) => a - b);
  const medianVolume = (sortedBaselineVolumes[9] + sortedBaselineVolumes[10]) / 2;
  const volumeVsMedian = bars.at(-1).volume / medianVolume;
  const priorHigh = Math.max(...baseline.map((bar) => bar.high));
  const turnover = baseline.reduce((sum, bar) => sum + bar.close * bar.volume, 0) / baseline.length;
  const momentumPct = (price / closes.at(-6) - 1) * 100;
  const atrPct = atr / price * 100;
  const minimumTurnover = instrument.currency === "USD" ? 1e6 : instrument.currency === "SEK" ? 1e7 : null;
  if (![price, ema20, ema50, atr, avgVolume, medianVolume, rvol, volumeVsMedian, priorHigh, turnover, momentumPct, atrPct].every(Number.isFinite) || avgVolume <= 0 || medianVolume <= 0) {
    return unavailable("INVALID_INDICATORS", "Pris- eller volymdata gav ogiltiga indikatorer.");
  }
  base.metrics = { price, ema20, ema50, atr, atr_pct: atrPct, rvol, momentum_pct: momentumPct, average_bar_turnover: turnover, latest_datetime: bars.at(-1).datetime };
  if (horizon === "week") Object.assign(base.metrics, {
    prior_20_day_high: priorHigh, volume_vs_prior_median: volumeVsMedian,
    prior_3_day_high: swingAssessment.metrics.prior_3_day_high,
    prior_3_day_range: swingAssessment.metrics.prior_3_day_range,
    prior_two_bar_fall_atr: swingAssessment.metrics.prior_two_bar_fall_atr,
  });
  base.status = "NO_TRADE";
  if (minimumTurnover === null || turnover < minimumTurnover) reasons.push("För låg omsättning eller ej stödd valuta.");
  if (atrPct < 0.2 || atrPct > 8) reasons.push("Volatilitet utanför skannerns försöksintervall.");
  if (horizon === "week") {
    if (swingAssessment.status === "NO_SETUP") reasons.push(...swingAssessment.reasons);
  } else {
    if (!(price > ema20 && ema20 > ema50)) reasons.push("Ingen tydlig positiv EMA-trend.");
    if (momentumPct <= 0) reasons.push("Momentum är inte positivt.");
    if (rvol < 1) reasons.push("Senaste candle har inte förhöjd volym.");
  }
  if (reasons.length) return base;
  base.screening_setups = swingAssessment?.setups || [];
  base.screening_plans = swingAssessment?.plans || [];
  if (horizon === "week") {
    const completedData = {
      ...marketData, ticker: instrument.symbol, requested_ticker: instrument.symbol,
      exchange: instrument.exchange, requested_exchange: instrument.exchange,
      currency: instrument.currency, bars, latest: bars.at(-1), price,
      verified_instrument: instrument.type === "Common Stock" ? {
        symbol: instrument.symbol, name: instrument.name || instrument.symbol,
        exchange: instrument.exchange, currency: instrument.currency,
        country: instrument.country, type: instrument.type,
      } : null,
      validation: validateMarketBars(bars),
    };
    const strategy = { version: SWING_STRATEGY_VERSION, ...swingAssessment };
    const decision = evaluateReadiness({ ticker: instrument.symbol, market, horizonCode: "week", marketStatus, marketData: completedData, strategy, now });
    base.decision = decision;
    if (decision.status !== "TRADE") {
      base.status = decision.status === "NO_TRADE" ? "NO_TRADE" : "NOT_ASSESSED";
      base.data_issue = decision.reason_codes[0] || "SIGNAL_VERIFICATION_FAILED";
      base.reasons = decision.reasons;
      if (base.status === "NOT_ASSESSED") base.metrics = null;
      return base;
    }
    base.status = "TRADE";
    base.primary_setup = swingAssessment.setups[0];
    base.signal_plan = { ...swingAssessment.plans[0] };
  } else {
    base.status = "WAIT";
  }
  // Filter/ranking strength is NOT a probability. All rules are experimental.
  base.rank_score = (rvol >= 1.5 ? 2 : 1) + (momentumPct >= 1 ? 2 : 1);
  base.reasons = horizon === "week"
    ? ["Experimentellt swingupplägg på färdigställda dagskurser: " + base.screening_setups.join(" + ") + ".", "Teknisk TRADE-signal utan genomförd order. Uppläggets lönsamhet är inte validerad."]
    : ["Positiv trend, momentum och volym klarar försöksfiltren.", "Endast analyskandidat. Risk Engine och strategivalidering saknas."];
  return base;
}

export function rankCandidates(items) {
  const priority = (item) => item.status === "TRADE" ? 2 : item.status === "WAIT" ? 1 : 0;
  return [...items].sort((a, b) => priority(b) - priority(a) || b.rank_score - a.rank_score || `${a.symbol}:${a.exchange}`.localeCompare(`${b.symbol}:${b.exchange}`));
}
