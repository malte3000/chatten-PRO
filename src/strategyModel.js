import { selectClosedDailyBars } from "./dailyBars.js";
import { ema } from "./screening.js";

export const SWING_STRATEGY_VERSION = "swing-v0.2-experimental";

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

export function assessSwingSetup(marketData, { ticker, marketStatus, now = Date.now() } = {}) {
  const unavailable = (reason) => ({ version: SWING_STRATEGY_VERSION, status: "NOT_ASSESSED", setups: [], plans: [], metrics: null, reasons: [reason] });
  if (!marketStatus || marketStatus.market === "off") return unavailable("Marknadskontrollen saknar tillförlitlig börsklocka.");
  if (String(marketData?.ticker || "").trim().toUpperCase() !== String(ticker || "").trim().toUpperCase()) return unavailable("Marknadsdatan matchar inte den valda aktien.");
  const selection = selectClosedDailyBars(marketData, { marketStatus, now });
  if (!selection.valid) return unavailable(selection.reasons.join(" "));
  const bars = selection.bars;
  const latest = bars.at(-1);

  const closes = bars.map((bar) => bar.close);
  const price = closes.at(-1);
  const ema20 = ema(closes, 20);
  const ema50 = ema(closes, 50);
  const recent = bars.slice(-21, -1);
  const ranges = bars.slice(1).map((bar, index) => Math.max(bar.high - bar.low, Math.abs(bar.high - bars[index].close), Math.abs(bar.low - bars[index].close)));
  const atr = ranges.slice(-14).reduce((sum, value) => sum + value, 0) / 14;
  const momentumPct = (price / closes.at(-6) - 1) * 100;
  const priorHigh = Math.max(...recent.map((bar) => bar.high));
  const priorMedianVolume = median(recent.map((bar) => bar.volume));
  const volumeRatio = latest.volume / priorMedianVolume;
  if (![price, ema20, ema50, atr, momentumPct, priorHigh, volumeRatio].every(Number.isFinite) || atr <= 0) return unavailable("Prisnivåerna gav ogiltiga indikatorer eller risknivåer.");
  const trend = price > ema20 && ema20 > ema50 && momentumPct > 0;
  const pullback = trend && latest.low <= ema20 + 0.2 * atr && latest.low >= ema20 - 0.8 * atr && latest.close > ema20;
  const breakout = trend && latest.close > priorHigh && volumeRatio >= 1.2;
  const setups = [];
  if (pullback) setups.push("PULLBACK");
  if (breakout) setups.push("BREAKOUT");
  const metrics = { last_closed_price: price, ema20, ema50, atr, momentum_pct: momentumPct, prior_20_day_high: priorHigh, volume_vs_prior_median: volumeRatio, latest_closed_candle: latest.datetime };
  const plans = setups.map((setup) => {
    const stop = setup === "PULLBACK" ? latest.low - 0.25 * atr : price - atr;
    const riskPerShare = price - stop;
    return { setup, entry_reference: price, stop, target: price + 2 * riskPerShare, risk_per_share: riskPerShare, theoretical_risk_reward: 2 };
  });
  if (plans.some((plan) => ![plan.stop, plan.target, plan.risk_per_share].every(Number.isFinite) || plan.stop <= 0 || plan.risk_per_share <= 0)) return unavailable("Upplägget gav ogiltiga stop- eller målnivåer.");
  return {
    version: SWING_STRATEGY_VERSION,
    status: setups.length ? "WATCH" : "NO_SETUP",
    setups,
    plans,
    metrics,
    reasons: setups.length
      ? ["Positiv trend och momentum på färdigställda dagscandles.", ...setups.map((setup) => setup === "PULLBACK" ? "Dagsljuset återtog EMA20 efter en begränsad rekyl." : "Stängningskursen bröt 20-dagars högsta med förhöjd volym."), "Experimentell bevakningskandidat. Ingen ingång, riskplan eller validerad edge är fastställd."]
      : ["Ingen pullback- eller breakoutregel uppfylldes i den positiva trendkonfigurationen."],
  };
}
