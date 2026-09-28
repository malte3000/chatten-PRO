// Journal entries use JSON numbers. Accept numeric strings on close for compatibility
// with older stored entries, but never turn null, booleans or blanks into zero.
export function tradeNumber(value) {
  if (typeof value !== "number" && (typeof value !== "string" || !value.trim())) return NaN;
  return Number(value);
}

export function entryFeesForTrade(trade) {
  const value = trade.signal_inputs?.actual_entry_fees;
  return value === undefined ? 0 : tradeNumber(value);
}

export function hasRiskSideStop(direction, entry, stop) {
  return Number.isFinite(stop) && stop > 0 && (direction === "LONG" ? stop < entry : direction === "SHORT" && stop > entry);
}

export function validateRealTradeRecord(trade) {
  if (trade.signal_inputs?.record_type !== "REAL_TRADE") return [];
  const errors = [];
  const direction = trade.direction;
  const entry = trade.entry_price;
  const size = trade.position_size;
  if (!["LONG", "SHORT"].includes(direction)) errors.push("Välj en giltig lång eller kort riktning.");
  if (trade.signal !== (direction === "LONG" ? "BUY" : direction === "SHORT" ? "SELL" : null)) errors.push("Signal och riktning måste stämma överens.");
  if (!Number.isFinite(entry) || entry <= 0) errors.push("Ange ett giltigt faktiskt ingångspris.");
  if (!Number.isFinite(size) || size <= 0 || !Number.isFinite(entry * size) || entry * size <= 0) errors.push("Ange en giltig faktisk positionsstorlek.");
  if (trade.stop_loss != null && !hasRiskSideStop(direction, entry, trade.stop_loss)) errors.push("Stoppen måste ligga på risksidan om ingången.");
  const target = trade.target;
  if (target != null && (!Number.isFinite(target) || target <= 0 || (direction === "LONG" ? target <= entry : direction === "SHORT" ? target >= entry : true))) errors.push("Målnivån måste ligga i affärens riktning från ingången.");
  const entryFees = trade.signal_inputs.actual_entry_fees;
  if (entryFees !== undefined && (!Number.isFinite(entryFees) || entryFees < 0)) errors.push("Ingångsavgifter måste vara ett giltigt icke-negativt belopp.");
  if (trade.trade_status !== "OPEN") errors.push("En ny verklig trade måste registreras som öppen.");
  if (["exit_price", "result_percent", "result_r", "winner", "exit_reason"].some((field) => trade[field] != null)) errors.push("Avslutsutfall beräknas när traden stängs.");
  return errors;
}
