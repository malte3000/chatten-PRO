import { getMarketStatus } from "../api/_market-hours.js";
import { fetchJson } from "./apiClient.js";
import { settlePaperObservation, validatePaperObservation } from "./paperModel.js";
import { PAPER_STORAGE_KEY, loadPaperLog, updatePaperLog } from "./paperStorage.js";

export const MAX_PAPER_FOLLOWUP_SYMBOLS = 5;

const OPEN_STATUSES = new Set(["PENDING_ENTRY", "PENDING_OPEN", "NOT_ASSESSED"]);
const FOLLOWUP_CURSOR_KEY = "sannolikhet-paper-followup-cursor-v1";
const DAY_MS = 86400000;

function dateOnly(value) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null;
}

function previousSession(market, date) {
  let time = Date.parse(`${date}T00:00:00Z`);
  for (let attempt = 0; attempt < 15; attempt += 1) {
    time -= DAY_MS;
    const candidate = new Date(time).toISOString().slice(0, 10);
    const reason = getMarketStatus(market, new Date(`${candidate}T12:00:00Z`)).reason;
    if (reason !== "weekend" && reason !== "holiday") return candidate;
  }
  return null;
}

function latestCompletedSession(market, now) {
  const clock = getMarketStatus(market, new Date(now));
  if (!dateOnly(clock.sessionDate)) return null;
  if (clock.reason === "after_close") return clock.sessionDate;
  if (["open", "before_open", "weekend", "holiday"].includes(clock.reason)) {
    return previousSession(market, clock.sessionDate);
  }
  return null;
}

function identity(record) {
  return JSON.stringify([record.market, record.ticker, record.exchange, record.currency, record.timezone]);
}

/** Plan the explicit follow-up before spending any market-data requests. */
export function planPaperFollowup(records, { maxSymbols = MAX_PAPER_FOLLOWUP_SYMBOLS, now = Date.now(), afterKey = null } = {}) {
  if (!Array.isArray(records) || !Number.isInteger(maxSymbols) || maxSymbols < 1 || maxSymbols > MAX_PAPER_FOLLOWUP_SYMBOLS ||
      !Number.isFinite(now) || !Number.isFinite(new Date(now).getTime()) || (afterKey !== null && typeof afterKey !== "string")) {
    throw new Error("Ogiltig paperlogg, kontrolltid eller gräns för uppföljningen.");
  }
  const targets = new Map();
  let openRecords = 0;
  let waitingRecords = 0;
  for (const record of records) {
    if (!validatePaperObservation(record)) throw new Error("Paperloggen innehåller en ogiltig observation.");
    if (!OPEN_STATUSES.has(record.status)) continue;
    openRecords += 1;
    const latest = latestCompletedSession(record.market, now);
    if (!latest || record.signalDate >= latest) { waitingRecords += 1; continue; }
    const key = identity(record);
    if (!targets.has(key)) targets.set(key, { key, market: record.market, ticker: record.ticker, exchange: record.exchange, records: 0, recordIds: [] });
    targets.get(key).records += 1;
    targets.get(key).recordIds.push(record.id);
  }
  const ordered = [...targets.values()].sort((a, b) => a.key.localeCompare(b.key));
  const firstAfterCursor = afterKey === null ? 0 : ordered.findIndex((target) => target.key.localeCompare(afterKey) > 0);
  const start = firstAfterCursor < 0 ? 0 : firstAfterCursor;
  const rotated = [...ordered.slice(start), ...ordered.slice(0, start)];
  return {
    targets: rotated.slice(0, maxSymbols),
    totalSymbols: ordered.length,
    deferredSymbols: Math.max(0, ordered.length - maxSymbols),
    openRecords,
    waitingRecords,
  };
}

function marketDataUrl(target) {
  const params = new URLSearchParams({ ticker: target.ticker, exchange: target.exchange, interval: "1day", outputsize: "200" });
  return `/api/market-data?${params}`;
}

function failure(problem, target, stage) {
  return { ticker: target.ticker, stage, status: problem?.status || null, message: problem?.message || "Okänt fel." };
}

/**
 * One user click checks at most five distinct instruments, sequentially. A
 * fetched series is applied under the same local Web Lock as manual paper
 * edits; a later API error stops the batch and leaves earlier updates intact.
 * Cloud sync remains a separate, explicit user action.
 */
export async function runPaperFollowup({
  storage,
  lockManager,
  request = fetchJson,
  now = () => Date.now(),
  maxSymbols = MAX_PAPER_FOLLOWUP_SYMBOLS,
} = {}) {
  if (!storage || typeof storage.getItem !== "function" || typeof storage.setItem !== "function" ||
      !lockManager || typeof lockManager.request !== "function" || typeof request !== "function" || typeof now !== "function") {
    throw new Error("Säker lokal lagring och en giltig dataanslutning krävs för paperuppföljningen.");
  }
  const checkedAt = now();
  const { initial, afterKey } = await lockManager.request(PAPER_STORAGE_KEY, { mode: "exclusive" }, () => ({
    initial: loadPaperLog(storage), afterKey: storage.getItem(FOLLOWUP_CURSOR_KEY),
  }));
  const plan = planPaperFollowup(initial, { maxSymbols, now: checkedAt, afterKey });
  const result = { records: initial, plannedSymbols: plan.targets.length, deferredSymbols: plan.deferredSymbols,
    openRecords: plan.openRecords, waitingRecords: plan.waitingRecords,
    attemptedRequests: 0, checkedSymbols: 0, checkedRecords: 0, updatedRecords: 0, error: null };

  for (const target of plan.targets) {
    // Advance even when this symbol has unusable data or the provider fails,
    // so repeated clicks can reach the rest of the bounded queue.
    try {
      await lockManager.request(PAPER_STORAGE_KEY, { mode: "exclusive" }, () => storage.setItem(FOLLOWUP_CURSOR_KEY, target.key));
    } catch (problem) {
      result.error = failure(problem, target, "local_update");
      return result;
    }
    let data;
    result.attemptedRequests += 1;
    try {
      data = await request(marketDataUrl(target), { cache: "no-store" });
    } catch (problem) {
      result.error = failure(problem, target, "market_data");
      return result;
    }
    let checked = 0;
    let updated = 0;
    const plannedIds = new Set(target.recordIds);
    try {
      result.records = await updatePaperLog(storage, lockManager, (current) => current.map((record) => {
        if (!plannedIds.has(record.id) || !OPEN_STATUSES.has(record.status) || identity(record) !== target.key) return record;
        checked += 1;
        const next = settlePaperObservation(record, data, { now: checkedAt });
        if (JSON.stringify(next) !== JSON.stringify(record)) updated += 1;
        return next;
      }));
    } catch (problem) {
      result.error = failure(problem, target, "local_update");
      return result;
    }
    result.checkedSymbols += 1;
    result.checkedRecords += checked;
    result.updatedRecords += updated;
  }
  return result;
}
