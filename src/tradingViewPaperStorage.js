import { tradingViewPaperSignalKey, validateTradingViewPaperOrder } from "./tradingViewPaperModel.js";

export const TRADINGVIEW_PAPER_STORAGE_KEY = "sannolikhet-tradingview-paper-orders-v1";
export const TRADINGVIEW_PAPER_LOG_FORMAT = "sannolikhet-tradingview-paper-log-v1";
const MAX_RECORDS = 500;
const MAX_BYTES = 500_000;
const EXIT_KEYS = new Set(["status", "exitAt", "exitPrice", "exitQuantity", "exitFee", "exitRecordedAt", "grossPnl", "totalFees", "netPnl", "resultR", "winner"]);

function inspect(records) {
  if (!Array.isArray(records) || records.length > MAX_RECORDS) throw new Error(`TradingView-paperloggen får innehålla högst ${MAX_RECORDS} order.`);
  const ids = new Set();
  const signalKeys = new Set();
  for (const record of records) {
    if (!validateTradingViewPaperOrder(record)) throw new Error("TradingView-paperloggen innehåller en ogiltig order.");
    const signal = tradingViewPaperSignalKey(record);
    if (ids.has(record.id) || signalKeys.has(signal)) throw new Error("Samma låsta signal har redan en TradingView-paperorder.");
    ids.add(record.id);
    signalKeys.add(signal);
  }
  return records;
}

export function encodeTradingViewPaperLog(records) {
  const value = JSON.stringify({ format: TRADINGVIEW_PAPER_LOG_FORMAT, records: inspect(records) });
  if (new TextEncoder().encode(value).length > MAX_BYTES) throw new Error("TradingView-paperloggen är för stor för lokal lagring.");
  return value;
}

export function decodeTradingViewPaperLog(value) {
  if (typeof value !== "string" || new TextEncoder().encode(value).length > MAX_BYTES) throw new Error("TradingView-paperloggen är för stor eller ogiltig.");
  let parsed;
  try { parsed = JSON.parse(value); }
  catch { throw new Error("TradingView-paperloggen innehåller inte giltig JSON."); }
  if (!parsed || parsed.format !== TRADINGVIEW_PAPER_LOG_FORMAT) throw new Error("TradingView-paperloggens formatversion stöds inte.");
  return inspect(parsed.records);
}

export function loadTradingViewPaperOrders(storage) {
  const raw = storage.getItem(TRADINGVIEW_PAPER_STORAGE_KEY);
  return raw === null ? [] : decodeTradingViewPaperLog(raw);
}

export function saveTradingViewPaperOrders(storage, records) {
  storage.setItem(TRADINGVIEW_PAPER_STORAGE_KEY, encodeTradingViewPaperLog(records));
}

function sameData(left, right) {
  if (left === right) return true;
  if (left === null || right === null || typeof left !== "object" || typeof right !== "object") return false;
  if (Array.isArray(left) !== Array.isArray(right)) return false;
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  return leftKeys.length === rightKeys.length && leftKeys.every((key) => Object.hasOwn(right, key) && sameData(left[key], right[key]));
}

function unchangedEntry(before, after) {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const key of keys) {
    if (EXIT_KEYS.has(key)) continue;
    if (!sameData(before[key], after[key])) return false;
  }
  return true;
}

function validTransition(before, after) {
  if (sameData(before, after)) return true;
  if (before.status === "OPEN" && after.status === "CLOSED" && unchangedEntry(before, after)) return true;
  return false;
}

/** Merge backups without discarding a later close or changing a locked fill. */
export function mergeTradingViewPaperLogs(existing, incoming) {
  const left = inspect(existing);
  const right = inspect(incoming);
  const merged = [...left];
  const byId = new Map(left.map((record, index) => [record.id, index]));
  const bySignal = new Map(left.map((record) => [tradingViewPaperSignalKey(record), record.id]));
  for (const record of right) {
    const index = byId.get(record.id);
    if (index !== undefined) {
      const known = merged[index];
      if (sameData(known, record)) continue;
      if (validTransition(known, record)) {
        merged[index] = record;
        continue;
      }
      if (validTransition(record, known)) continue;
      throw new Error(`TradingView-order ${record.id} skiljer sig från den lokala journalen. Ingen order skrevs över.`);
    }
    const signal = tradingViewPaperSignalKey(record);
    if (bySignal.has(signal)) throw new Error(`Den låsta signalen för ${record.ticker} har redan en annan TradingView-order. Ingen order skrevs över.`);
    merged.push(record);
    byId.set(record.id, merged.length - 1);
    bySignal.set(signal, record.id);
  }
  return inspect(merged);
}

/** Locked updates preserve earlier entries and immutable closed outcomes. */
export async function updateTradingViewPaperOrders(storage, lockManager, transform) {
  if (!lockManager?.request) throw new Error("Webbläsaren saknar säker lagring mellan flikar för TradingView-paperloggen.");
  return lockManager.request(TRADINGVIEW_PAPER_STORAGE_KEY, { mode: "exclusive" }, () => {
    const current = loadTradingViewPaperOrders(storage);
    const next = transform(current);
    const encoded = encodeTradingViewPaperLog(next);
    const after = new Map(next.map((record) => [record.id, record]));
    for (const old of current) {
      const latest = after.get(old.id);
      if (!latest || !validTransition(old, latest)) throw new Error("En befintlig TradingView-paperorder kan inte raderas eller få sin låsta ingång ändrad.");
    }
    if (encoded !== encodeTradingViewPaperLog(current)) storage.setItem(TRADINGVIEW_PAPER_STORAGE_KEY, encoded);
    return next;
  });
}
