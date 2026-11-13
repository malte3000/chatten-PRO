import { validateMarketBars } from "../api/_market-data-validation.js";
import { selectClosedDailyBars } from "./dailyBars.js";
import { ema } from "./indicators.js";

export const SWING_STRATEGY_VERSION = "swing-v0.5-experimental";
export const SWING_SETUP_IDS = Object.freeze(["PULLBACK", "BREAKOUT", "RANGE_BREAKOUT", "REBOUND"]);

const SETUP_REASONS = {
  PULLBACK: "Dagsljuset återtog EMA20 efter en begränsad rekyl.",
  BREAKOUT: "Stängningskursen bröt 20-dagars högsta med förhöjd volym.",
  RANGE_BREAKOUT: "Stängningskursen bröt en kort, begränsad konsolidering i positiv trend.",
  REBOUND: "Kursen vände upp efter en nedgång över två dagsljus medan EMA50 fortsatte stiga.",
};

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function unavailable(reason) {
  return { status: "NOT_ASSESSED", setups: [], plans: [], metrics: null, reasons: [reason] };
}

/** Price-only pattern evaluation. The caller must separately confirm the exchange session is closed. */
export function evaluateSwingPatterns(bars) {
  if (!Array.isArray(bars) || bars.length < 60 || !validateMarketBars(bars).valid ||
      bars.some((bar) => !Number.isFinite(bar.volume) || bar.volume <= 0)) {
    return unavailable("Minst 60 giltiga färdigställda dagskurser med positiv volym krävs.");
  }

  const latest = bars.at(-1);
  const closes = bars.map((bar) => bar.close);
  const price = latest.close;
  const ema20 = ema(closes, 20);
  const ema50 = ema(closes, 50);
  const ema50FiveBarsAgo = ema(closes.slice(0, -5), 50);
  const priorTwenty = bars.slice(-21, -1);
  const priorThree = bars.slice(-4, -1);
  const ranges = bars.slice(1).map((bar, index) => Math.max(
    bar.high - bar.low,
    Math.abs(bar.high - bars[index].close),
    Math.abs(bar.low - bars[index].close),
  ));
  const atr = ranges.slice(-14).reduce((sum, value) => sum + value, 0) / 14;
  const priorAtr = ranges.slice(-15, -1).reduce((sum, value) => sum + value, 0) / 14;
  const momentumPct = (price / closes.at(-6) - 1) * 100;
  const priorHigh = Math.max(...priorTwenty.map((bar) => bar.high));
  const priorThreeHigh = Math.max(...priorThree.map((bar) => bar.high));
  const priorThreeLow = Math.min(...priorThree.map((bar) => bar.low));
  const priorThreeRange = priorThreeHigh - priorThreeLow;
  const priorMedianVolume = median(priorTwenty.map((bar) => bar.volume));
  const volumeRatio = latest.volume / priorMedianVolume;
  const priorTwoBarFall = closes.at(-4) - closes.at(-2);
  if (![price, ema20, ema50, ema50FiveBarsAgo, atr, momentumPct, priorHigh,
    priorThreeHigh, priorThreeRange, volumeRatio, priorTwoBarFall, priorAtr].every(Number.isFinite) || atr <= 0 || priorAtr <= 0) {
    return unavailable("Prisnivåerna gav ogiltiga indikatorer eller risknivåer.");
  }

  const positiveTrend = price > ema20 && ema20 > ema50 && momentumPct > 0;
  const pullback = positiveTrend && latest.low <= ema20 + 0.2 * atr &&
    latest.low >= ema20 - 0.8 * atr;
  const breakout = positiveTrend && price > priorHigh && volumeRatio >= 1.2;
  const rangeBreakout = positiveTrend && price > priorThreeHigh && price <= priorHigh &&
    priorThreeRange <= 2 * priorAtr && volumeRatio >= 1;
  const rebound = ema20 > ema50 && ema50 > ema50FiveBarsAgo &&
    price >= ema50 && price <= ema20 && latest.close > latest.open &&
    price > closes.at(-2) && priorTwoBarFall >= 0.75 * atr;

  const setups = [];
  if (pullback) setups.push("PULLBACK");
  if (breakout) setups.push("BREAKOUT");
  if (rangeBreakout) setups.push("RANGE_BREAKOUT");
  if (rebound) setups.push("REBOUND");
  const metrics = {
    last_closed_price: price, ema20, ema50, ema50_five_bars_ago: ema50FiveBarsAgo,
    atr, prior_atr: priorAtr, momentum_pct: momentumPct, prior_20_day_high: priorHigh,
    prior_3_day_high: priorThreeHigh, prior_3_day_range: priorThreeRange,
    prior_two_bar_fall_atr: priorTwoBarFall / atr,
    volume_vs_prior_median: volumeRatio, latest_closed_candle: latest.datetime,
  };
  const plans = setups.map((setup) => {
    const stop = setup === "PULLBACK" || setup === "REBOUND"
      ? latest.low - 0.25 * atr : price - atr;
    const riskPerShare = price - stop;
    return { setup, entry_reference: price, stop, target: price + 2 * riskPerShare,
      risk_per_share: riskPerShare, theoretical_risk_reward: 2 };
  });
  if (plans.some((plan) => ![plan.stop, plan.target, plan.risk_per_share].every(Number.isFinite) ||
      plan.stop <= 0 || plan.risk_per_share <= 0 || plan.target <= price)) {
    return unavailable("Upplägget gav ogiltiga stop- eller målnivåer.");
  }
  return {
    status: setups.length ? "WATCH" : "NO_SETUP", setups, plans, metrics,
    reasons: setups.length
      ? ["Minst ett tekniskt upplägg uppfylldes på färdigställda dagskurser.",
        ...setups.map((setup) => SETUP_REASONS[setup]),
        "Experimentell bevakningskandidat. Nivåerna är provisoriska; uppläggets lönsamhet är inte validerad."]
      : ["Ingen pullback-, breakout-, range breakout- eller reboundregel uppfylldes."],
  };
}

export function assessSwingSetup(marketData, { ticker, marketStatus, now = Date.now() } = {}) {
  const withVersion = (result) => ({ version: SWING_STRATEGY_VERSION, ...result });
  if (!marketStatus || marketStatus.market === "off") return withVersion(unavailable("Marknadskontrollen saknar tillförlitlig börsklocka."));
  if (String(marketData?.ticker || "").trim().toUpperCase() !== String(ticker || "").trim().toUpperCase()) {
    return withVersion(unavailable("Marknadsdatan matchar inte den valda aktien."));
  }
  const selection = selectClosedDailyBars(marketData, { marketStatus, now,
    requireExpectedSession: marketStatus.reason != null });
  if (!selection.valid) return withVersion(unavailable(selection.reasons.join(" ")));
  return withVersion(evaluateSwingPatterns(selection.bars));
}
