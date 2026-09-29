const MONEY_TOLERANCE = 1e-8;
const isPositive = (value) => Number.isFinite(value) && value > 0;
const isNonNegative = (value) => Number.isFinite(value) && value >= 0;
const hasText = (value) => typeof value === "string" && Boolean(value.trim());
const roundOutcome = (value) => Number(value.toFixed(8));
const sameNumber = (actual, expected) => Number.isFinite(actual) && Number.isFinite(expected) &&
  Math.abs(actual - expected) <= Math.max(MONEY_TOLERANCE, Math.max(Math.abs(actual), Math.abs(expected)) * Number.EPSILON * 16);

const REASONS = {
  NOT_REAL_TRADE: "Posten är en observation eller äldre post, ingen registrerad verklig trade.",
  NOT_CLOSED: "Traden är inte stängd och har inget färdigt utfall.",
  MISSING_ID: "Trade-ID saknas.",
  DUPLICATE_ID: "Trade-ID förekommer flera gånger; dubbla poster räknas inte.",
  MISSING_STRATEGY: "Strategiversion saknas.",
  MISSING_CURRENCY: "En uttrycklig valuta eller prisvaluta med tre bokstäver saknas.",
  INVALID_DIRECTION: "Riktning eller signal är ogiltig eller motsägande.",
  INVALID_PRICES_OR_SIZE: "Giltiga faktiska ingångs- och utgångspriser eller positionsstorlek saknas.",
  MISSING_OR_INVALID_FEES: "Faktiska ingångsavgifter, utgångsavgifter eller totalavgifter saknas eller är ogiltiga.",
  INVALID_FEE_TOTAL: "Totalavgiften stämmer inte med ingångs- och utgångsavgifterna.",
  MISSING_OR_INVALID_NET_OUTCOME: "Giltigt sparat bruttoresultat, nettoresultat eller procentresultat saknas.",
  INCONSISTENT_OUTCOME: "Sparat utfall stämmer inte med priser, riktning, storlek och faktiska avgifter.",
  INCONSISTENT_WINNER: "Vinstmarkeringen stämmer inte med nettoresultatet efter avgifter.",
  INVALID_CALCULATION: "Beloppen ger inget giltigt ändligt utfall.",
  MISSING_STOP: "Ursprunglig stop saknas; posten ingår inte i medelvärdet för R.",
  INVALID_STOP: "Stoppen ligger inte på risksidan om ingången; posten ingår inte i medelvärdet för R.",
  INVALID_R: "Sparat R-resultat saknas eller stämmer inte med nettoutfallet och ursprunglig stop.",
};

function exclusion(record, index, reasonCodes, category = "INVALID") {
  return { tradeId: hasText(record?.trade_id) ? record.trade_id : null, index, category, reasonCodes, reasons: reasonCodes.map((code) => REASONS[code]) };
}

function inspectOutcome(record) {
  const inputs = record.signal_inputs;
  const reasons = [];
  if (!hasText(record.trade_id)) reasons.push("MISSING_ID");
  if (!hasText(record.strategy_version)) reasons.push("MISSING_STRATEGY");
  // Preserve currency case: GBp (pence) and GBP must never share money totals.
  if (!hasText(inputs.currency) || !/^[A-Za-z]{3}$/.test(inputs.currency.trim())) reasons.push("MISSING_CURRENCY");
  const side = record.direction === "LONG" ? 1 : record.direction === "SHORT" ? -1 : 0;
  if (!side || record.signal !== (side === 1 ? "BUY" : "SELL")) reasons.push("INVALID_DIRECTION");
  const entryValue = record.entry_price * record.position_size;
  if (![record.entry_price, record.exit_price, record.position_size, entryValue].every(isPositive)) reasons.push("INVALID_PRICES_OR_SIZE");
  const entryFees = inputs.actual_entry_fees;
  const exitFees = inputs.actual_exit_fees;
  const totalFees = inputs.total_actual_fees;
  if (![entryFees, exitFees, totalFees].every(isNonNegative)) reasons.push("MISSING_OR_INVALID_FEES");
  else if (!sameNumber(totalFees, entryFees + exitFees)) reasons.push("INVALID_FEE_TOTAL");
  if (![inputs.gross_pnl, inputs.net_pnl, record.result_percent].every(Number.isFinite)) reasons.push("MISSING_OR_INVALID_NET_OUTCOME");
  if (reasons.length) return { reasons };

  const grossPnl = (record.exit_price - record.entry_price) * side * record.position_size;
  const rawNetPnl = grossPnl - totalFees;
  const netPnl = roundOutcome(rawNetPnl);
  const netPercent = rawNetPnl / entryValue * 100;
  if (![grossPnl, rawNetPnl, netPnl, netPercent].every(Number.isFinite)) reasons.push("INVALID_CALCULATION");
  else if (!sameNumber(inputs.gross_pnl, grossPnl) || !sameNumber(inputs.net_pnl, netPnl) || !sameNumber(record.result_percent, roundOutcome(netPercent))) reasons.push("INCONSISTENT_OUTCOME");
  const outcome = Math.abs(netPnl) < MONEY_TOLERANCE ? "BREAK_EVEN" : netPnl > 0 ? "WIN" : "LOSS";
  const expectedWinner = outcome === "BREAK_EVEN" ? null : outcome === "WIN";
  if (record.winner !== expectedWinner) reasons.push("INCONSISTENT_WINNER");
  if (reasons.length) return { reasons };

  let resultR = null;
  let rReason = null;
  const stop = record.stop_loss;
  if (stop == null) rReason = "MISSING_STOP";
  else if (!isPositive(stop) || (side === 1 ? stop >= record.entry_price : stop <= record.entry_price)) rReason = "INVALID_STOP";
  else {
    const riskAmount = Math.abs(record.entry_price - stop) * record.position_size;
    const expectedR = rawNetPnl / riskAmount;
    if (!isPositive(riskAmount) || !Number.isFinite(expectedR) || !sameNumber(record.result_r, roundOutcome(expectedR))) rReason = "INVALID_R";
    else resultR = record.result_r;
  }
  return {
    reasons: [], tradeId: record.trade_id, strategyVersion: record.strategy_version.trim(), currency: inputs.currency.trim(),
    entryValue, grossPnl: inputs.gross_pnl, netPnl: inputs.net_pnl, entryFees, exitFees, totalFees,
    outcome, resultR, rReason,
  };
}

function finiteSum(values) {
  const total = values.reduce((sum, value) => sum + value, 0);
  return Number.isFinite(total) ? total : null;
}

function ratio(numerator, denominator, scale = 1) {
  if (!Number.isFinite(numerator) || !isPositive(denominator)) return null;
  const value = numerator / denominator * scale;
  return Number.isFinite(value) ? value : null;
}

function summarizeGroup(trades) {
  const tradeCount = trades.length;
  const wins = trades.filter((trade) => trade.outcome === "WIN").length;
  const losses = trades.filter((trade) => trade.outcome === "LOSS").length;
  const breakEvens = tradeCount - wins - losses;
  const totalEntryValue = finiteSum(trades.map((trade) => trade.entryValue));
  const totalNetPnl = finiteSum(trades.map((trade) => trade.netPnl));
  const winAmount = finiteSum(trades.filter((trade) => trade.outcome === "WIN").map((trade) => trade.netPnl));
  const lossAmount = finiteSum(trades.filter((trade) => trade.outcome === "LOSS").map((trade) => -trade.netPnl));
  const rTrades = trades.filter((trade) => trade.resultR !== null);
  const profitFactor = ratio(winAmount, lossAmount);
  return {
    strategyVersion: trades[0].strategyVersion, currency: trades[0].currency,
    tradeCount, wins, losses, breakEvens, winRatePercent: wins / tradeCount * 100,
    totalEntryValue, totalGrossPnl: finiteSum(trades.map((trade) => trade.grossPnl)),
    totalEntryFees: finiteSum(trades.map((trade) => trade.entryFees)),
    totalExitFees: finiteSum(trades.map((trade) => trade.exitFees)),
    totalFees: finiteSum(trades.map((trade) => trade.totalFees)), totalNetPnl,
    // Weighted trade return on summed entry notional; never account return or compounded growth.
    netPercent: ratio(totalNetPnl, totalEntryValue, 100),
    expectancyNetPnl: ratio(totalNetPnl, tradeCount), profitFactor,
    profitFactorStatus: losses === 0 ? "NO_LOSSES" : profitFactor === null ? "INVALID_TOTALS" : "CALCULATED",
    averageR: ratio(finiteSum(rTrades.map((trade) => trade.resultR)), rTrades.length),
    rTradeCount: rTrades.length, rExcludedCount: tradeCount - rTrades.length,
    rExclusions: trades.filter((trade) => trade.rReason).map((trade) => ({ tradeId: trade.tradeId, reasonCode: trade.rReason, reason: REASONS[trade.rReason] })),
    feePaidTradeCount: trades.filter((trade) => trade.totalFees > 0).length,
    feeFreeTradeCount: trades.filter((trade) => trade.totalFees === 0).length,
    entryFeePaidTradeCount: trades.filter((trade) => trade.entryFees > 0).length,
    exitFeePaidTradeCount: trades.filter((trade) => trade.exitFees > 0).length,
  };
}

// Descriptive statistics for the supplied journal window. No estimate of future
// win probability, strategy edge or account performance is inferred from these records.
export function summarizePerformance(records = []) {
  const rows = Array.isArray(records) ? records : [];
  const closed = rows.filter((record) => record?.signal_inputs?.record_type === "REAL_TRADE" && record.trade_status === "CLOSED");
  const countsById = new Map();
  for (const record of closed) if (hasText(record.trade_id)) countsById.set(record.trade_id, (countsById.get(record.trade_id) || 0) + 1);
  const grouped = new Map();
  const exclusions = [];
  let includedCount = 0;
  for (const [index, record] of rows.entries()) {
    if (record?.signal_inputs?.record_type !== "REAL_TRADE") { exclusions.push(exclusion(record, index, ["NOT_REAL_TRADE"], "IGNORED")); continue; }
    if (record.trade_status !== "CLOSED") { exclusions.push(exclusion(record, index, ["NOT_CLOSED"], "IGNORED")); continue; }
    if (countsById.get(record.trade_id) > 1) { exclusions.push(exclusion(record, index, ["DUPLICATE_ID"])); continue; }
    const outcome = inspectOutcome(record);
    if (outcome.reasons.length) { exclusions.push(exclusion(record, index, outcome.reasons)); continue; }
    const key = JSON.stringify([outcome.strategyVersion, outcome.currency]);
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(outcome);
    includedCount++;
  }
  return {
    inputCount: rows.length, includedCount, excludedCount: exclusions.length,
    closedRealTradeCount: closed.length,
    openRealTradeCount: rows.filter((record) => record?.signal_inputs?.record_type === "REAL_TRADE" && record.trade_status === "OPEN").length,
    ignoredCount: exclusions.filter((item) => item.category === "IGNORED").length,
    invalidClosedCount: exclusions.filter((item) => item.category === "INVALID").length,
    groups: [...grouped.values()].map(summarizeGroup).sort((a, b) => a.strategyVersion.localeCompare(b.strategyVersion) || a.currency.localeCompare(b.currency)),
    exclusions,
  };
}
