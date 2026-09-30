import { validateMarketBars } from "../api/_market-data-validation.js";
import { getMarketStatus } from "../api/_market-hours.js";
import { selectClosedDailyBars } from "./dailyBars.js";

export const SCREEN_VERSION = "v0.2-experimental";

export function ema(values, period) {
  if (values.length < period) return null;
  let value = values.slice(0, period).reduce((sum, item) => sum + item, 0) / period;
  const alpha = 2 / (period + 1);
  for (const item of values.slice(period)) value += alpha * (item - value);
  return value;
}

export function screenInstrument(instrument, marketData, { horizon = "week", market = null, now = Date.now() } = {}) {
  const reasons = [];
  const base = { ...instrument, status: "NO_TRADE", rank_score: 0, metrics: null, reasons, screen_version: SCREEN_VERSION, screening_selection: null };
  const sourceBars = marketData?.bars;
  if (marketData?.ticker !== instrument.symbol || !Array.isArray(sourceBars) || sourceBars.length < 60) {
    reasons.push("Minst 60 giltiga candles för rätt instrument krävs."); return base;
  }
  let bars = sourceBars;
  if (horizon === "week") {
    if (!["usa", "stockholm"].includes(market) || !Number.isFinite(now)) {
      reasons.push("Tillförlitlig börsklocka saknas för färdigställda dagskurser."); return base;
    }
    const marketStatus = getMarketStatus(market, new Date(now));
    // The current session may have zero volume or an unfinished OHLC range.
    // Exclude it before validating the completed bars used for screening.
    const unfinishedDate = marketStatus.reason === "after_close" ? null : marketStatus.sessionDate;
    const completedBars = unfinishedDate ? sourceBars.filter((bar) => bar?.datetime !== unfinishedDate) : sourceBars;
    const selection = selectClosedDailyBars({ ...marketData, bars: completedBars }, { marketStatus, now, minBars: 60 });
    if (!selection.valid) { reasons.push(...selection.reasons); return base; }
    bars = selection.bars;
    base.screening_selection = {
      latest_closed_datetime: selection.latestDate,
      session_date: selection.sessionDate,
      excluded_current_session: completedBars.length !== sourceBars.length || selection.excludedCurrentSession,
      time_zone: selection.timeZone,
    };
  } else if (!validateMarketBars(bars).valid) {
    reasons.push("Minst 60 giltiga candles för rätt instrument krävs."); return base;
  }
  if (bars.some((bar) => !Number.isFinite(bar.volume) || bar.volume <= 0)) {
    reasons.push("Tillförlitlig volymdata saknas."); return base;
  }
  // Request UTC timestamps from the provider; never assume local-exchange time.
  const latestTime = Date.parse(`${bars.at(-1).datetime.replace(" ", "T")}Z`);
  const maxAge = horizon === "week" ? 7 * 86400000 : 36 * 3600000;
  if (!Number.isFinite(latestTime) || now - latestTime > maxAge || latestTime > now + 900000) {
    reasons.push("Prisdatans tid är ogiltig eller för gammal för horisonten."); return base;
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
  const turnover = baseline.reduce((sum, bar) => sum + bar.close * bar.volume, 0) / baseline.length;
  const momentumPct = (price / closes.at(-6) - 1) * 100;
  const atrPct = atr / price * 100;
  const minimumTurnover = instrument.currency === "USD" ? 1e6 : instrument.currency === "SEK" ? 1e7 : null;
  base.metrics = { price, ema20, ema50, atr, atr_pct: atrPct, rvol, momentum_pct: momentumPct, average_bar_turnover: turnover, latest_datetime: bars.at(-1).datetime };
  if (minimumTurnover === null || turnover < minimumTurnover) reasons.push("För låg omsättning eller ej stödd valuta.");
  if (atrPct < 0.2 || atrPct > 8) reasons.push("Volatilitet utanför skannerns försöksintervall.");
  if (!(price > ema20 && ema20 > ema50)) reasons.push("Ingen tydlig positiv EMA-trend.");
  if (momentumPct <= 0) reasons.push("Momentum är inte positivt.");
  if (rvol < 1) reasons.push("Senaste candle har inte förhöjd volym.");
  if (reasons.length) return base;
  base.status = "WAIT";
  // Filter/ranking strength is NOT a probability. All rules are experimental.
  base.rank_score = (rvol >= 1.5 ? 2 : 1) + (momentumPct >= 1 ? 2 : 1);
  base.reasons = ["Positiv trend, momentum och volym klarar försöksfiltren.", "Endast analyskandidat. Risk Engine och strategivalidering saknas."];
  return base;
}

export function rankCandidates(items) {
  return [...items].sort((a, b) => (b.status === "WAIT") - (a.status === "WAIT") || b.rank_score - a.rank_score || `${a.symbol}:${a.exchange}`.localeCompare(`${b.symbol}:${b.exchange}`));
}
