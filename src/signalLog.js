import { validatePaperObservation } from "./paperModel.js";
import { READINESS_VERSION } from "./analysisModel.js";
import { SWING_STRATEGY_VERSION } from "./strategyModel.js";

export const SIGNAL_LOG_FORMAT = "sannolikhet-signal-log-v1";
export const SIGNAL_STORAGE_KEY = "sannolikhet-trade-signals-v1";
const MAX_RECORDS = 3000;
const MAX_BYTES = 2_500_000;
const SOURCES = new Set(["SCAN", "MANUAL"]);
const SETUPS = new Set(["PULLBACK", "BREAKOUT", "RANGE_BREAKOUT", "REBOUND"]);
const MARKETS = { usa: "USD", stockholm: "SEK" };
const PLAN_FIELDS = ["entry_reference", "stop", "target", "risk_per_share", "theoretical_risk_reward"];
const finite = (value) => typeof value === "number" && Number.isFinite(value);
const iso = (value) => typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const date = (value) => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
const normalizedExchange = (value) => String(value || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
const identity = (record) => JSON.stringify([record.market, record.ticker, normalizedExchange(record.exchange), record.signalDate, record.strategyVersion]);
const planSnapshot = (plan) => ({ setup: plan.setup, ...Object.fromEntries(PLAN_FIELDS.map((field) => [field, plan[field]])) });
const immutable = (record) => JSON.stringify([record.ticker, record.market, record.exchange, record.currency, record.strategyVersion, record.signalDate, record.signalClose, record.setups, record.plans]);

function createEntry({ source, ticker, market, exchange, currency, strategyVersion, signalDate, signalClose, plans, sourceFetchedAt, capturedAt }) {
  const item = {
    version: SIGNAL_LOG_FORMAT, id: "", ticker: String(ticker || "").trim().toUpperCase(), market,
    exchange: String(exchange || "").trim().toUpperCase(), currency, strategyVersion, signalDate,
    signalClose, setups: plans.map((plan) => plan.setup), plans: plans.map(planSnapshot),
    capturedAt, sourceFetchedAt, sources: [source], outcomes: {},
  };
  item.id = identity(item);
  if (!validateSignalEntry(item)) throw new Error("TRADE-signalen saknar en giltig identitet, tidpunkt eller låst riskplan.");
  return item;
}

/** Return null for any non-TRADE analysis; it must never enter hit-rate data. */
export function signalFromAnalysis(analysis, capturedAt = new Date().toISOString()) {
  if (analysis?.decision?.status !== "TRADE") return null;
  if (analysis.decision.version !== READINESS_VERSION || analysis.horizonCode !== "week" ||
      analysis.strategy?.version !== SWING_STRATEGY_VERSION || analysis.strategy?.status !== "WATCH" ||
      analysis.marketData?.validation?.valid !== true) throw new Error("Analysens TRADE-signal har inte verifierats av den aktuella signalmotorn.");
  const signalDate = analysis.strategy?.metrics?.latest_closed_candle;
  const signalBar = analysis.marketData?.bars?.find((bar) => bar.datetime === signalDate);
  return createEntry({
    source: "MANUAL", ticker: analysis.ticker, market: analysis.market,
    exchange: analysis.marketData?.exchange, currency: analysis.marketData?.currency,
    strategyVersion: analysis.strategy?.version, signalDate, signalClose: signalBar?.close,
    plans: analysis.strategy?.plans || [], sourceFetchedAt: analysis.marketData?.fetched_at, capturedAt,
  });
}

/** A scan can finish in several batches, so capture each emitted batch immediately. */
export function signalFromScanItem(item, { market, horizon, capturedAt = new Date().toISOString() } = {}) {
  if (item?.status !== "TRADE") return null;
  if (horizon !== "week" || item.decision?.status !== "TRADE" || item.decision?.version !== READINESS_VERSION ||
      item.swing_strategy_version !== SWING_STRATEGY_VERSION ||
      item.screening_setups?.join("|") !== item.screening_plans?.map((plan) => plan.setup).join("|")) throw new Error("Skannerns TRADE-signal saknar bekräftad swingbedömning.");
  const signalDate = item.screening_selection?.latest_closed_datetime;
  const signalBar = item.data_snapshot?.bars?.find((bar) => bar.datetime === signalDate);
  return createEntry({
    source: "SCAN", ticker: item.symbol, market, exchange: item.exchange, currency: item.currency,
    strategyVersion: item.swing_strategy_version, signalDate, signalClose: signalBar?.close,
    plans: item.screening_plans || [], sourceFetchedAt: item.data_snapshot?.fetched_at, capturedAt,
  });
}

export function validateSignalEntry(record) {
  if (!record || record.version !== SIGNAL_LOG_FORMAT || !MARKETS[record.market] || record.currency !== MARKETS[record.market] ||
      !/^[A-Z0-9.\-]+$/.test(record.ticker || "") || !normalizedExchange(record.exchange) ||
      typeof record.strategyVersion !== "string" || !record.strategyVersion || !date(record.signalDate) ||
      !finite(record.signalClose) || record.signalClose <= 0 || !iso(record.capturedAt) || !iso(record.sourceFetchedAt) ||
      Date.parse(record.sourceFetchedAt) > Date.parse(record.capturedAt) + 120000 ||
      record.id !== identity(record) || !Array.isArray(record.sources) || !record.sources.length ||
      new Set(record.sources).size !== record.sources.length || record.sources.some((source) => !SOURCES.has(source)) ||
      !Array.isArray(record.setups) || !record.setups.length || new Set(record.setups).size !== record.setups.length ||
      record.setups.some((setup) => !SETUPS.has(setup)) || !Array.isArray(record.plans) || record.plans.length !== record.setups.length) return false;
  for (let i = 0; i < record.plans.length; i += 1) {
    const plan = record.plans[i];
    if (!plan || plan.setup !== record.setups[i] || PLAN_FIELDS.some((field) => !finite(plan[field]) || plan[field] <= 0) ||
        plan.entry_reference !== record.signalClose || plan.stop >= plan.entry_reference || plan.target <= plan.entry_reference ||
        Math.abs(plan.risk_per_share - (plan.entry_reference - plan.stop)) > 1e-6) return false;
  }
  if (!record.outcomes || typeof record.outcomes !== "object" || Array.isArray(record.outcomes)) return false;
  for (const [setup, outcome] of Object.entries(record.outcomes)) {
    if (!record.setups.includes(setup) || outcome?.kind !== "SIMULATED" || typeof outcome.paperId !== "string" || !outcome.paperId ||
        !["CLOSED", "REJECTED_ENTRY", "NOT_ASSESSED"].includes(outcome.status)) return false;
    if (outcome.status === "CLOSED" && (!date(outcome.exitDate) || !finite(outcome.resultR) || !finite(outcome.netPnl) ||
        ![true, false, null].includes(outcome.winner))) return false;
  }
  return true;
}

function inspect(records) {
  if (!Array.isArray(records) || records.length > MAX_RECORDS) throw new Error(`Signalloggen kan innehålla högst ${MAX_RECORDS} signaler.`);
  const ids = new Set();
  for (const record of records) {
    if (!validateSignalEntry(record)) throw new Error("Signalloggen innehåller en ogiltig signal. Ingen post skrevs över.");
    if (ids.has(record.id)) throw new Error("Signalloggen innehåller dubbla signal-ID. Ingen post skrevs över.");
    ids.add(record.id);
  }
  return records;
}

export function encodeSignalLog(records) {
  const encoded = JSON.stringify({ format: SIGNAL_LOG_FORMAT, records: inspect(records) });
  if (new TextEncoder().encode(encoded).length > MAX_BYTES) throw new Error("Signalloggen är för stor för lokal lagring. Exportera en JSON-kopia.");
  return encoded;
}

export function decodeSignalLog(text) {
  if (typeof text !== "string" || new TextEncoder().encode(text).length > MAX_BYTES) throw new Error("Signalfilen är för stor eller ogiltig.");
  let parsed;
  try { parsed = JSON.parse(text); } catch { throw new Error("Signalfilen innehåller inte giltig JSON."); }
  if (parsed?.format !== SIGNAL_LOG_FORMAT) throw new Error("Signalfilens formatversion stöds inte.");
  return inspect(parsed.records);
}

export function loadSignalLog(storage) {
  const raw = storage.getItem(SIGNAL_STORAGE_KEY);
  return raw === null ? [] : decodeSignalLog(raw);
}

export function mergeSignals(existing, incoming) {
  inspect(existing); inspect(incoming);
  const merged = [...existing];
  const byId = new Map(merged.map((record, index) => [record.id, index]));
  for (const entry of incoming) {
    const index = byId.get(entry.id);
    if (index === undefined) { byId.set(entry.id, merged.length); merged.push(entry); continue; }
    const known = merged[index];
    if (immutable(known) !== immutable(entry)) throw new Error(`Signalen ${entry.ticker} ${entry.signalDate} har olika låsta nivåer. Ingen post skrevs över.`);
    merged[index] = { ...known, sources: [...new Set([...known.sources, ...entry.sources])] };
  }
  inspect(merged);
  return merged;
}

export async function appendSignalLog(storage, lockManager, entries) {
  const incoming = entries.filter(Boolean);
  if (!incoming.length) return { records: loadSignalLog(storage), added: 0 };
  if (!lockManager?.request) throw new Error("Webbläsaren saknar stöd för säker lagring mellan flikar.");
  return lockManager.request(SIGNAL_STORAGE_KEY, { mode: "exclusive" }, () => {
    const current = loadSignalLog(storage);
    const next = mergeSignals(current, incoming);
    const encoded = encodeSignalLog(next);
    if (encoded !== encodeSignalLog(current)) storage.setItem(SIGNAL_STORAGE_KEY, encoded);
    return { records: next, added: next.length - current.length };
  });
}

/** Attach an existing paper simulation outcome without calling it an executed trade. */
export async function attachPaperOutcomes(storage, lockManager, observations) {
  const settled = observations.filter((item) => ["CLOSED", "REJECTED_ENTRY", "NOT_ASSESSED"].includes(item?.status) && validatePaperObservation(item));
  if (!settled.length) return 0;
  if (!lockManager?.request) throw new Error("Webbläsaren saknar stöd för säker lagring mellan flikar.");
  const byIdentity = new Map();
  for (const paper of settled) {
    const key = JSON.stringify([paper.market, paper.ticker, normalizedExchange(paper.exchange), paper.signalDate, paper.strategyVersion]);
    const group = byIdentity.get(key) || [];
    group.push(paper);
    byIdentity.set(key, group);
  }
  return lockManager.request(SIGNAL_STORAGE_KEY, { mode: "exclusive" }, () => {
    const current = loadSignalLog(storage);
    let updated = 0;
    const next = current.map((entry) => {
      const outcomes = { ...entry.outcomes };
      for (const paper of byIdentity.get(entry.id) || []) {
        if (!entry.setups.includes(paper.setup)) continue;
        const outcome = { kind: "SIMULATED", paperId: paper.id, status: paper.status,
          exitDate: paper.status === "CLOSED" ? paper.exitDate : null,
          resultR: paper.status === "CLOSED" ? paper.resultR : null,
          netPnl: paper.status === "CLOSED" ? paper.netPnl : null,
          winner: paper.status === "CLOSED" ? paper.winner : null };
        if (outcomes[paper.setup]?.paperId && outcomes[paper.setup].paperId !== paper.id) throw new Error("Två paperobservationer gör anspråk på samma låsta signal.");
        if (JSON.stringify(outcomes[paper.setup]) !== JSON.stringify(outcome)) { outcomes[paper.setup] = outcome; updated += 1; }
      }
      return { ...entry, outcomes };
    });
    const encoded = encodeSignalLog(next);
    if (encoded !== encodeSignalLog(current)) storage.setItem(SIGNAL_STORAGE_KEY, encoded);
    return updated;
  });
}
