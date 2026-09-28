export function calculatePositionSize({ capital, riskPercent, entry, stop, estimatedFees = 0 }) {
  const accountCapital = Number(capital);
  const riskPct = Number(riskPercent);
  const entryPrice = Number(entry);
  const stopPrice = Number(stop);
  const fees = Number(estimatedFees || 0);
  if (![accountCapital, riskPct, entryPrice, stopPrice, fees].every(Number.isFinite) || accountCapital <= 0 || riskPct <= 0 || riskPct > 100 || entryPrice <= 0 || stopPrice <= 0 || fees < 0 || stopPrice === entryPrice) {
    return { status: "NOT_CONFIGURED", reason: "Ange kapital, riskprocent, giltiga prisnivåer och icke-negativa uppskattade avgifter." };
  }
  const riskBudget = accountCapital * riskPct / 100;
  const riskPerShare = Math.abs(entryPrice - stopPrice);
  const sharesWithinRisk = Math.max(0, Math.floor((riskBudget - fees) / riskPerShare));
  const sharesWithinCashCapital = Math.max(0, Math.floor((accountCapital - fees) / entryPrice));
  const maximumShares = Math.min(sharesWithinRisk, sharesWithinCashCapital);
  return {
    status: maximumShares > 0 ? "CALCULATED" : "TOO_SMALL",
    risk_budget: riskBudget,
    risk_per_share: riskPerShare,
    shares_within_risk: sharesWithinRisk,
    shares_within_cash_capital: sharesWithinCashCapital,
    max_shares: maximumShares,
    planned_risk: maximumShares * riskPerShare + fees,
    position_value: maximumShares * entryPrice,
    reason: maximumShares > 0 ? null : sharesWithinCashCapital === 0
      ? "Kapitalet räcker inte till en hel aktie och de angivna avgifterna."
      : "Riskbudgeten räcker inte till en hel aktie med de angivna nivåerna och avgifterna.",
  };
}
