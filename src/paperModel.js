import { getMarketStatus } from "../api/_market-hours.js";
import { validateCandle } from "../api/_market-data-validation.js";
import { selectClosedDailyBars } from "./dailyBars.js";
import { assessSwingSetup, SWING_STRATEGY_VERSION } from "./strategyModel.js";

export const PAPER_VERSION = "paper-forward-v0.2";
const LEGACY_PAPER_VERSION = "paper-forward-v0.1";
export const PAPER_BASIS = Object.freeze({ WITH_NEWS: "WITH_NEWS", TECHNICAL_ONLY: "TECHNICAL_ONLY" });
// Keep versions that could already have produced a paper observation here when
// the live strategy changes. Creation below still requires the current model.
export const PAPER_HISTORICAL_SWING_VERSIONS = Object.freeze(["swing-v0.2-experimental"]);
export const supportsPaperStrategyVersion = (version, currentVersion = SWING_STRATEGY_VERSION) =>
  version === currentVersion || PAPER_HISTORICAL_SWING_VERSIONS.includes(version);
const DAY_MS = 86400000;
const MAX_CAPTURE_DELAY_MS = 30 * 60000;
const MARKETS = {
  usa: { currency: "USD", timezone: "America/New_York", exchanges: new Set(["NASDAQ", "NASDAQGS", "NASDAQGM", "NASDAQCM", "NYSE", "NYSEARCA", "ARCA", "AMEX", "NYSEAMERICAN", "BATS", "CBOE", "XNAS", "XNYS", "ARCX", "XASE"]) },
  stockholm: { currency: "SEK", timezone: "Europe/Stockholm", exchanges: new Set(["OMX", "XSTO", "STOCKHOLM", "NASDAQSTOCKHOLM", "OMXSTOCKHOLM"]) },
};
const STATUSES = new Set(["PENDING_ENTRY", "PENDING_OPEN", "REJECTED_ENTRY", "CLOSED", "NOT_ASSESSED"]);
const SETUPS = new Set(["PULLBACK", "BREAKOUT"]);
const text = (value) => typeof value === "string" ? value.trim() : "";
const upper = (value) => text(value).toUpperCase();
const exchangeKey = (value) => upper(value).replace(/[\s_-]/g, "");
const finite = (value) => typeof value === "number" && Number.isFinite(value);
const isoTime = (value) => typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const dateTime = (value) => value instanceof Date ? value.getTime() : typeof value === "number" ? value : Date.parse(value);
const dateKey = (value) => new Date(value).toISOString().slice(0, 10);
const addDay = (value) => dateKey(Date.parse(`${value}T00:00:00Z`) + DAY_MS);
const previousDay = (value) => dateKey(Date.parse(`${value}T00:00:00Z`) - DAY_MS);
const same = (a, b) => finite(a) && finite(b) && Math.abs(a - b) <= Math.max(1e-8, Math.max(Math.abs(a), Math.abs(b)) * Number.EPSILON * 16);
const emptyOutcome = () => ({ assessmentError: null, rejectionReason: null, entryDate: null, entry: null, stop: null, target: null, initialRisk: null, holdingBars: null, exitDate: null, exit: null, exitReason: null, ambiguousBar: null, grossPnl: null, totalFees: null, netPnl: null, resultR: null, winner: null });

function validDate(value) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(`${value}T00:00:00Z`)) && dateKey(Date.parse(`${value}T00:00:00Z`)) === value;
}

function isSession(market, date) {
  const status = getMarketStatus(market, new Date(`${date}T12:00:00Z`));
  return status.reason !== "weekend" && status.reason !== "holiday";
}

function expectedClosedDate(market, now) {
  const clock = getMarketStatus(market, new Date(now));
  let date = clock.reason === "after_close" ? clock.sessionDate : previousDay(clock.sessionDate);
  for (let tries = 0; tries < 15; tries += 1) {
    if (isSession(market, date)) return date;
    date = previousDay(date);
  }
  return null;
}

function nextSession(market, date) {
  let next = date;
  for (let tries = 0; tries < 15; tries += 1) {
    next = addDay(next);
    if (isSession(market, next)) return next;
  }
  return null;
}

function baseValid(record) {
  if (!record || typeof record !== "object" || Array.isArray(record) || ![PAPER_VERSION, LEGACY_PAPER_VERSION].includes(record.version) || !STATUSES.has(record.status)) return false;
  if (record.version === PAPER_VERSION && !(
    (record.basis === PAPER_BASIS.WITH_NEWS && record.sourceDecisionStatus === "WAIT") ||
    (record.basis === PAPER_BASIS.TECHNICAL_ONLY && record.sourceDecisionStatus === "NO_TRADE")
  )) return false;
  if (record.version === LEGACY_PAPER_VERSION && (record.basis !== undefined || record.sourceDecisionStatus !== undefined)) return false;
  if (!text(record.sourceAnalysisTradeId) || record.id !== `paper:${record.sourceAnalysisTradeId}:${record.setup}` || !SETUPS.has(record.setup)) return false;
  const config = MARKETS[record.market];
  if (!config || !text(record.ticker) || upper(record.ticker) !== record.ticker || !text(record.exchange) || !config.exchanges.has(exchangeKey(record.exchange)) || record.currency !== config.currency || record.timezone !== config.timezone || !supportsPaperStrategyVersion(record.strategyVersion)) return false;
  if (!validDate(record.signalDate) || !isoTime(record.recordedAt) || !isoTime(record.sourceFetchedAt) || Date.parse(record.sourceFetchedAt) > Date.parse(record.recordedAt) + 120000 || Date.parse(record.recordedAt) - Date.parse(record.sourceFetchedAt) > MAX_CAPTURE_DELAY_MS) return false;
  if (!Number.isInteger(record.holdingSessions) || record.holdingSessions < 1 || record.holdingSessions > 5 || !Number.isSafeInteger(record.quantity) || record.quantity < 1 || !finite(record.feePerOrder) || record.feePerOrder < 0 || !finite(record.feePerOrder * 2) || !finite(record.slippageBps) || record.slippageBps < 0 || record.slippageBps >= 10000) return false;
  if (!record.signalBar || record.signalBar.datetime !== record.signalDate || !validateCandle(record.signalBar).valid || !finite(record.signalBar.volume) || record.signalBar.volume <= 0) return false;
  const plan = record.plan;
  if (!plan || plan.setup !== record.setup || !finite(plan.entry_reference) || !finite(plan.stop) || !finite(plan.target) || !finite(plan.risk_per_share) || !finite(plan.theoretical_risk_reward) || plan.entry_reference <= plan.stop || plan.stop <= 0 || plan.theoretical_risk_reward <= 0 || !same(plan.entry_reference, record.signalBar.close) || !same(plan.risk_per_share, plan.entry_reference - plan.stop) || !same(plan.target, plan.entry_reference + plan.theoretical_risk_reward * plan.risk_per_share)) return false;
  const captureClock = getMarketStatus(record.market, new Date(record.recordedAt));
  // Once the next session is open, a prior close is no longer a forward
  // observation: intraday prices have already begun revealing the outcome.
  return !captureClock.isOpen && expectedClosedDate(record.market, Date.parse(record.recordedAt)) === record.signalDate;
}

/** This validates structure and arithmetic, not authenticity of editable local files. */
export function validatePaperObservation(record) {
  if (!baseValid(record)) return false;
  const outcome = emptyOutcome();
  const keys = Object.keys(outcome);
  if (keys.some((key) => !(key in record))) return false;
  if (record.status === "NOT_ASSESSED") return text(record.assessmentError).length > 0 && keys.slice(1).every((key) => record[key] === null);
  if (record.assessmentError !== null) return false;
  if (record.status === "PENDING_ENTRY") return keys.slice(1).every((key) => record[key] === null);
  if (record.status === "REJECTED_ENTRY") return text(record.rejectionReason).length > 0 && record.entryDate === nextSession(record.market, record.signalDate) && keys.filter((key) => !["assessmentError", "rejectionReason", "entryDate"].includes(key)).every((key) => record[key] === null);
  if (record.rejectionReason !== null || record.entryDate !== nextSession(record.market, record.signalDate) || !finite(record.entry) || !finite(record.stop) || !finite(record.target) || !finite(record.initialRisk) || record.entry <= record.stop || record.entry >= record.plan.target || record.stop !== record.plan.stop || record.target <= record.entry || !same(record.target, record.entry + record.plan.theoretical_risk_reward * (record.entry - record.stop)) || !same(record.initialRisk, (record.entry - record.stop) * record.quantity) || !Number.isInteger(record.holdingBars) || record.holdingBars < 1 || record.holdingBars > record.holdingSessions) return false;
  if (record.status === "PENDING_OPEN") return record.holdingBars < record.holdingSessions && ["exitDate", "exit", "exitReason", "ambiguousBar", "grossPnl", "totalFees", "netPnl", "resultR", "winner"].every((key) => record[key] === null);
  if (!validDate(record.exitDate) || record.exitDate < record.entryDate || !["STOP_GAP", "TARGET_GAP", "STOP", "TARGET", "TIME_EXIT"].includes(record.exitReason) || !finite(record.exit) || record.exit <= 0 || typeof record.ambiguousBar !== "boolean" || !finite(record.grossPnl) || !finite(record.totalFees) || !finite(record.netPnl) || !finite(record.resultR) || !same(record.grossPnl, (record.exit - record.entry) * record.quantity) || !same(record.totalFees, record.feePerOrder * 2) || !same(record.netPnl, record.grossPnl - record.totalFees) || !same(record.resultR, record.netPnl / record.initialRisk)) return false;
  let elapsedSessions = 1, elapsedDate = record.entryDate;
  while (elapsedDate < record.exitDate && elapsedSessions <= record.holdingSessions) { elapsedDate = nextSession(record.market, elapsedDate); elapsedSessions += 1; }
  if (elapsedDate !== record.exitDate || elapsedSessions !== record.holdingBars || (record.exitReason === "TIME_EXIT" && record.holdingBars !== record.holdingSessions)) return false;
  return record.winner === (Math.abs(record.netPnl) <= 1e-8 ? null : record.netPnl > 0);
}

/** A missing news response may be logged as a technical experiment, never as a cleared signal. */
export function paperObservationBasis(analysis) {
  if (analysis?.strategy?.status !== "WATCH") return null;
  if (analysis?.decision?.status === "WAIT") return PAPER_BASIS.WITH_NEWS;
  const codes = analysis?.decision?.reason_codes;
  if (analysis?.decision?.status === "NO_TRADE" && analysis.news == null && Array.isArray(codes) &&
      codes.includes("NEWS_MISSING_OR_MISMATCHED") &&
      codes.every((code) => ["NEWS_MISSING_OR_MISMATCHED", "UPSTREAM_ERROR"].includes(code))) {
    return PAPER_BASIS.TECHNICAL_ONLY;
  }
  return null;
}

export function createPaperObservation(analysis, { setup, holdingSessions, quantity, feePerOrder, slippageBps, recordedAt = Date.now() } = {}) {
  const now = dateTime(recordedAt);
  if (!Number.isFinite(now) || !Number.isFinite(new Date(now).getTime())) throw new Error("Ogiltig tid för paperobservationen.");
  const market = analysis?.market;
  const config = MARKETS[market];
  const basis = paperObservationBasis(analysis);
  if (!config || !SETUPS.has(setup) || !/swingtrading/i.test(String(analysis?.horizon || "")) || !basis || analysis?.strategy?.version !== SWING_STRATEGY_VERSION) throw new Error("Endast ett aktuellt experimentellt swingupplägg med BEVAKA, eller ett sådant tekniskt upplägg där enbart nyhetsanalysen saknas, kan följas på papper.");
  const data = analysis.marketData;
  const ticker = upper(analysis.ticker);
  if (!ticker || upper(data?.ticker) !== ticker || (data.requested_ticker && upper(data.requested_ticker) !== ticker) || data.currency !== config.currency || !config.exchanges.has(exchangeKey(data.exchange)) || (data.requested_exchange && exchangeKey(data.requested_exchange) !== exchangeKey(data.exchange)) || data.timezone !== config.timezone || (data.market && data.market !== market)) throw new Error("Aktie, börs, valuta eller tidszon matchar inte den valda marknaden.");
  if (!text(analysis.record?.trade_id) || analysis.record?.signal_inputs?.record_type !== "ANALYSIS") throw new Error("Analysen saknar ett eget ID och en giltig observationstyp.");
  const fetched = Date.parse(data.fetched_at);
  if (!Number.isFinite(fetched) || fetched > now + 120000 || now - fetched > MAX_CAPTURE_DELAY_MS) throw new Error("Analysens prisdata är för gammal eller tidsstämplad i framtiden. Kör en ny analys.");
  const clock = getMarketStatus(market, new Date(now));
  if (clock.isOpen) throw new Error("Nästa handelssession har öppnat; gårdagens signal kan inte registreras som en förhandslåst paperobservation.");
  const selection = selectClosedDailyBars(data, { marketStatus: clock, now });
  if (!selection.valid || selection.latestDate !== expectedClosedDate(market, now)) throw new Error("Det senaste förväntade stängda börsljuset saknas; registrera inte signalen i efterhand.");
  const reassessed = assessSwingSetup(data, { ticker, marketStatus: clock, now });
  const plan = reassessed.plans.find((candidate) => candidate.setup === setup);
  const shownPlan = analysis.strategy.plans?.find((candidate) => candidate.setup === setup);
  if (reassessed.status !== "WATCH" || analysis.strategy.metrics?.latest_closed_candle !== selection.latestDate || !plan || !shownPlan || ["entry_reference", "stop", "target", "risk_per_share", "theoretical_risk_reward"].some((key) => !same(shownPlan[key], plan[key]))) throw new Error("Signalens låsta nivåer matchar inte dagens färdigställda kursdata.");
  const sourceAnalysisTradeId = analysis.record.trade_id;
  const record = {
    version: PAPER_VERSION, id: `paper:${sourceAnalysisTradeId}:${setup}`, sourceAnalysisTradeId,
    basis, sourceDecisionStatus: analysis.decision.status,
    ticker, exchange: data.exchange, currency: data.currency, timezone: data.timezone, market,
    strategyVersion: reassessed.version, setup, signalDate: selection.latestDate,
    recordedAt: new Date(now).toISOString(), sourceFetchedAt: new Date(fetched).toISOString(),
    signalBar: { ...selection.bars.at(-1) }, plan: { ...plan },
    holdingSessions, quantity, feePerOrder, slippageBps, status: "PENDING_ENTRY", ...emptyOutcome(),
  };
  if (!validatePaperObservation(record)) throw new Error("Ange 1–5 sessioner, helt antal aktier och giltiga kostnader för paperobservationen.");
  return record;
}

function notAssessed(record, reason) {
  return { ...record, status: "NOT_ASSESSED", ...emptyOutcome(), assessmentError: reason };
}

export function settlePaperObservation(observation, marketData, { now = Date.now() } = {}) {
  if (!validatePaperObservation(observation)) throw new Error("Paperobservationen är ogiltig eller ändrad.");
  if (["CLOSED", "REJECTED_ENTRY"].includes(observation.status)) return observation;
  const at = dateTime(now);
  if (!Number.isFinite(at) || !Number.isFinite(new Date(at).getTime()) || at < Date.parse(observation.recordedAt)) return notAssessed(observation, "Ogiltig kontrolltid för senare börsdata.");
  const config = MARKETS[observation.market];
  if (upper(marketData?.ticker) !== observation.ticker || (marketData?.requested_ticker && upper(marketData.requested_ticker) !== observation.ticker) || exchangeKey(marketData?.exchange) !== exchangeKey(observation.exchange) || (marketData?.requested_exchange && exchangeKey(marketData.requested_exchange) !== exchangeKey(observation.exchange)) || marketData?.currency !== observation.currency || marketData?.timezone !== config.timezone || marketData?.interval !== "1day" || (marketData.market && marketData.market !== observation.market)) return notAssessed(observation, "Uppföljningsdatan matchar inte aktie, börs, valuta, tidszon och dagsintervall.");
  const clock = getMarketStatus(observation.market, new Date(at));
  const selection = selectClosedDailyBars(marketData, { marketStatus: clock, now: at, minBars: 1 });
  if (!selection.valid) return notAssessed(observation, selection.reasons.join(" "));
  const signal = selection.bars.find((bar) => bar.datetime === observation.signalDate);
  if (!signal || ["open", "high", "low", "close", "volume"].some((key) => !same(signal[key], observation.signalBar[key]))) return notAssessed(observation, "Det ursprungliga signal-ljuset saknas eller har ändrats i uppföljningsdatan.");
  const byDate = new Map(selection.bars.map((bar) => [bar.datetime, bar]));
  const finalExpected = expectedClosedDate(observation.market, at);
  let date = observation.signalDate;
  let position = null;
  for (let count = 0; count < 5000; count += 1) {
    date = nextSession(observation.market, date);
    if (!date || date > finalExpected) break;
    const bar = byDate.get(date);
    if (!bar) return notAssessed(observation, `En förväntad färdigställd handelssession saknas: ${date}.`);
    if (!position) {
      const entry = bar.open * (1 + observation.slippageBps / 10000);
      const stop = observation.plan.stop;
      const risk = entry - stop;
      const target = entry + observation.plan.theoretical_risk_reward * risk;
      if (![entry, risk, target, risk * observation.quantity].every(Number.isFinite)) return notAssessed(observation, "Prisnivåerna gav en ogiltig simulerad ingång.");
      if (bar.open <= stop || entry <= stop || bar.open >= observation.plan.target || entry >= observation.plan.target || target <= entry) {
        return { ...observation, status: "REJECTED_ENTRY", ...emptyOutcome(), entryDate: date, rejectionReason: "Nästa öppning låg utanför signalens giltiga prisnivåer." };
      }
      position = { entryDate: date, entry, stop, target, initialRisk: risk * observation.quantity };
    }
    const holdingBars = position.entryDate === date ? 1 : position.holdingBars + 1;
    position.holdingBars = holdingBars;
    let rawExit = null, exitReason = null, ambiguousBar = false;
    if (bar.open <= position.stop) { rawExit = bar.open; exitReason = "STOP_GAP"; }
    else if (bar.open >= position.target) { rawExit = position.target; exitReason = "TARGET_GAP"; }
    else if (bar.low <= position.stop) { rawExit = position.stop; exitReason = "STOP"; ambiguousBar = bar.high >= position.target; }
    else if (bar.high >= position.target) { rawExit = position.target; exitReason = "TARGET"; }
    else if (holdingBars >= observation.holdingSessions) { rawExit = bar.close; exitReason = "TIME_EXIT"; }
    if (rawExit !== null) {
      const exit = rawExit * (1 - observation.slippageBps / 10000);
      const grossPnl = (exit - position.entry) * observation.quantity;
      const totalFees = observation.feePerOrder * 2;
      const netPnl = grossPnl - totalFees;
      const resultR = netPnl / position.initialRisk;
      if (![exit, grossPnl, totalFees, netPnl, resultR].every(Number.isFinite) || exit <= 0) return notAssessed(observation, "Prisnivåerna gav ett ogiltigt simulerat resultat.");
      return { ...observation, status: "CLOSED", ...emptyOutcome(), ...position, exitDate: date, exit, exitReason, ambiguousBar, grossPnl, totalFees, netPnl, resultR, winner: Math.abs(netPnl) <= 1e-8 ? null : netPnl > 0 };
    }
  }
  if (position) return { ...observation, status: "PENDING_OPEN", ...emptyOutcome(), ...position };
  return { ...observation, status: "PENDING_ENTRY", ...emptyOutcome() };
}

export function summarizePaperObservations(records) {
  const summary = { totalCount: 0, closedCount: 0, pendingEntryCount: 0, pendingOpenCount: 0, rejectedEntryCount: 0, notAssessedCount: 0, invalidCount: 0, groups: [] };
  const groups = new Map();
  const seen = new Set();
  for (const record of Array.isArray(records) ? records : []) {
    if (!validatePaperObservation(record) || seen.has(record.id)) { summary.invalidCount += 1; continue; }
    seen.add(record.id); summary.totalCount += 1;
    const counter = { CLOSED: "closedCount", PENDING_ENTRY: "pendingEntryCount", PENDING_OPEN: "pendingOpenCount", REJECTED_ENTRY: "rejectedEntryCount", NOT_ASSESSED: "notAssessedCount" }[record.status];
    summary[counter] += 1;
    if (record.status !== "CLOSED") continue;
    const basis = record.version === LEGACY_PAPER_VERSION ? PAPER_BASIS.WITH_NEWS : record.basis;
    const key = JSON.stringify([record.strategyVersion, record.setup, record.currency, basis]);
    if (!groups.has(key)) groups.set(key, { strategyVersion: record.strategyVersion, setup: record.setup, currency: record.currency, basis, closedCount: 0, wins: 0, losses: 0, breakEvens: 0, winRatePercent: null, totalNetPnl: 0, totalFees: 0, expectancyR: null, profitFactor: null, _sumR: 0, _profits: 0, _losses: 0 });
    const group = groups.get(key);
    group.closedCount += 1; group.wins += record.winner === true ? 1 : 0; group.losses += record.winner === false ? 1 : 0; group.breakEvens += record.winner === null ? 1 : 0;
    group.totalNetPnl += record.netPnl; group.totalFees += record.totalFees; group._sumR += record.resultR;
    group._profits += Math.max(0, record.netPnl); group._losses -= Math.min(0, record.netPnl);
  }
  summary.groups = [...groups.values()].map((group) => {
    const { _sumR, _profits, _losses, ...publicGroup } = group;
    return { ...publicGroup, totalNetPnl: Number.isFinite(group.totalNetPnl) ? group.totalNetPnl : null, totalFees: Number.isFinite(group.totalFees) ? group.totalFees : null, winRatePercent: group.wins / group.closedCount * 100, expectancyR: Number.isFinite(_sumR) ? _sumR / group.closedCount : null, profitFactor: _losses > 0 && Number.isFinite(_profits / _losses) ? _profits / _losses : null };
  }).sort((a, b) => JSON.stringify([a.strategyVersion, a.setup, a.currency, a.basis]).localeCompare(JSON.stringify([b.strategyVersion, b.setup, b.currency, b.basis])));
  return summary;
}
