// Shared live/replay viability checks. These thresholds are experimental
// screening rules, not estimated probabilities or evidence of profitability.
export function assessSwingViability(bars, atr, market) {
  if (!Array.isArray(bars) || bars.length < 21 || !Number.isFinite(atr) || atr <= 0 ||
      !["usa", "stockholm"].includes(market)) {
    return { status: "NOT_ASSESSED", reasons: ["Omsättning eller volatilitet kunde inte beräknas."], reason_codes: ["VIABILITY_DATA_INVALID"] };
  }
  const latest = bars.at(-1);
  const priorTwenty = bars.slice(-21, -1);
  const averageTurnover = priorTwenty.reduce((sum, bar) => sum + bar.close * bar.volume, 0) / priorTwenty.length;
  const atrPercent = atr / latest?.close * 100;
  if (![averageTurnover, atrPercent].every(Number.isFinite) || !Number.isFinite(latest?.close) || latest.close <= 0) {
    return { status: "NOT_ASSESSED", reasons: ["Omsättning eller volatilitet kunde inte beräknas."], reason_codes: ["VIABILITY_DATA_INVALID"] };
  }
  const reasons = [];
  const reason_codes = [];
  const minimumTurnover = market === "usa" ? 1e6 : 1e7;
  if (averageTurnover < minimumTurnover) {
    reasons.push("Genomsnittlig omsättning under föregående 20 sessioner är för låg för försöksregeln.");
    reason_codes.push("LIQUIDITY_BELOW_MINIMUM");
  }
  if (atrPercent < 0.2 || atrPercent > 8) {
    reasons.push("ATR i förhållande till priset ligger utanför försöksintervallet 0,2–8 procent.");
    reason_codes.push("ATR_OUT_OF_RANGE");
  }
  return { status: reason_codes.length ? "NO_TRADE" : "PASS", reasons, reason_codes,
    average_turnover: averageTurnover, atr_percent: atrPercent };
}
