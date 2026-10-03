import { validateMarketBars } from "../api/_market-data-validation.js";
import { getMarketStatus } from "../api/_market-hours.js";
import { selectClosedDailyBars } from "./dailyBars.js";

export const SCREEN_VERSION = "v0.5-experimental";

export function ema(values, period) {
  if (values.length < period) return null;
  let value = values.slice(0, period).reduce((sum, item) => sum + item, 0) / period;
  const alpha = 2 / (period + 1);
  for (const item of values.slice(period)) value += alpha * (item - value);
  return value;
}

export function screenInstrument(instrument, marketData, { horizon = "week", market = null, now = Date.now() } = {}) {
  const reasons = [];
  const base = { ...instrument, status: "NOT_ASSESSED", rank_score: 0, metrics: null, reasons, screen_version: SCREEN_VERSION, screening_selection: null, screening_setups: [], data_issue: null };
  const unavailable = (code, reason) => { base.data_issue = code; reasons.push(reason); return base; };
  const sourceBars = marketData?.bars;
  if (marketData?.ticker !== instrument.symbol) return unavailable("INSTRUMENT_MISMATCH", "Kursdatan matchar inte den valda aktien.");
  if (!Array.isArray(sourceBars) || sourceBars.length < 60) return unavailable("INSUFFICIENT_BARS", "Minst 60 giltiga candles för rätt instrument krävs.");
  let bars = sourceBars;
  if (horizon === "week") {
    if (!["usa", "stockholm"].includes(market) || !Number.isFinite(now)) {
      return unavailable("MARKET_CLOCK_UNVERIFIED", "Tillförlitlig börsklocka saknas för färdigställda dagskurser.");
    }
    const marketStatus = getMarketStatus(market, new Date(now));
    // The current session may have zero volume or an unfinished OHLC range.
    // Exclude it before validating the completed bars used for screening.
    const unfinishedDate = marketStatus.reason === "after_close" ? null : marketStatus.sessionDate;
    const completedBars = unfinishedDate ? sourceBars.filter((bar) => bar?.datetime !== unfinishedDate) : sourceBars;
    if (completedBars.some((bar) => !Number.isFinite(bar?.volume) || bar.volume <= 0)) {
      return unavailable("UNRELIABLE_VOLUME", "Positiv och tillförlitlig volym krävs för varje använd dagskurs.");
    }
    const selection = selectClosedDailyBars({ ...marketData, bars: completedBars }, { marketStatus, now, minBars: 60 });
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
  if (horizon === "week") Object.assign(base.metrics, { prior_20_day_high: priorHigh, volume_vs_prior_median: volumeVsMedian });
  base.status = "NO_TRADE";
  if (minimumTurnover === null || turnover < minimumTurnover) reasons.push("För låg omsättning eller ej stödd valuta.");
  if (atrPct < 0.2 || atrPct > 8) reasons.push("Volatilitet utanför skannerns försöksintervall.");
  if (!(price > ema20 && ema20 > ema50)) reasons.push("Ingen tydlig positiv EMA-trend.");
  if (momentumPct <= 0) reasons.push("Momentum är inte positivt.");
  const swingSetups = [];
  if (horizon === "week") {
    // Match the experiment's completed-candle swing setups: a pullback does not
    // require elevated volume, while a breakout uses the prior median volume.
    const positiveTrend = price > ema20 && ema20 > ema50 && momentumPct > 0;
    const pullback = positiveTrend && bars.at(-1).low <= ema20 + 0.2 * atr && bars.at(-1).low >= ema20 - 0.8 * atr && price > ema20;
    const breakout = positiveTrend && price > priorHigh && volumeVsMedian >= 1.2;
    if (pullback) swingSetups.push("PULLBACK");
    if (breakout) swingSetups.push("BREAKOUT");
    if (positiveTrend && !swingSetups.length) reasons.push("Varken rekyl mot EMA20 eller 20-dagars utbrott med volym bekräftades.");
  } else if (rvol < 1) {
    reasons.push("Senaste candle har inte förhöjd volym.");
  }
  if (reasons.length) return base;
  base.status = "WAIT";
  base.screening_setups = swingSetups;
  // Filter/ranking strength is NOT a probability. All rules are experimental.
  base.rank_score = (rvol >= 1.5 ? 2 : 1) + (momentumPct >= 1 ? 2 : 1);
  base.reasons = horizon === "week"
    ? ["Positiv trend och momentum samt experimentellt swingupplägg: " + base.screening_setups.join(" + ") + ".", "Endast analyskandidat. Risk Engine och strategivalidering saknas."]
    : ["Positiv trend, momentum och volym klarar försöksfiltren.", "Endast analyskandidat. Risk Engine och strategivalidering saknas."];
  return base;
}

export function rankCandidates(items) {
  return [...items].sort((a, b) => (b.status === "WAIT") - (a.status === "WAIT") || b.rank_score - a.rank_score || `${a.symbol}:${a.exchange}`.localeCompare(`${b.symbol}:${b.exchange}`));
}
