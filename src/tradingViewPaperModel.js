import { getMarketStatus } from "../api/_market-hours.js";
import { PAPER_BASIS, PAPER_VERSION, validatePaperObservation } from "./paperModel.js";

export const TRADINGVIEW_PAPER_VERSION = "tradingview-paper-v1";
const DAY_MS = 86_400_000;
const CLOCK_SKEW_MS = 120_000;
const LATE_LOG_MS = 30 * 60_000;
const finite = (value) => typeof value === "number" && Number.isFinite(value);
const isoTime = (value) => typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const same = (a, b) => finite(a) && finite(b) && Math.abs(a - b) <= Math.max(1e-8, Math.max(Math.abs(a), Math.abs(b)) * Number.EPSILON * 16);
function validDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const time = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value;
}

function timestamp(value) {
  const time = value instanceof Date ? value.getTime() : typeof value === "number" ? value : Date.parse(value);
  if (!Number.isFinite(time) || !Number.isFinite(new Date(time).getTime())) throw new Error("Ogiltig tid för TradingView-paperordern.");
  return time;
}

function numberInput(value, name, { positive = false, integer = false } = {}) {
  if (value === "" || value === null || value === undefined || (typeof value === "string" && !value.trim())) throw new Error(`Ange ${name} uttryckligen.`);
  const number = Number(value);
  if (!Number.isFinite(number) || (positive ? number <= 0 : number < 0) || (integer && !Number.isSafeInteger(number))) throw new Error(`Ogiltigt värde för ${name}.`);
  return number;
}

function nextSession(market, signalDate) {
  let time = Date.parse(`${signalDate}T00:00:00Z`);
  for (let attempt = 0; attempt < 15; attempt += 1) {
    time += DAY_MS;
    const candidate = new Date(time).toISOString().slice(0, 10);
    const clock = getMarketStatus(market, new Date(`${candidate}T12:00:00Z`));
    if (clock.reason !== "weekend" && clock.reason !== "holiday") return candidate;
  }
  return null;
}

function signalIdentity(order) {
  return JSON.stringify([order.market, order.ticker, order.exchange.toUpperCase().replace(/[\s_-]/g, ""), order.signalDate, order.setup, order.strategyVersion, order.basis]);
}

/** Used to prevent a second TradingView order for the same locked signal. */
export function tradingViewPaperSignalKey(order) {
  if (!validateTradingViewPaperOrder(order)) throw new Error("TradingView-paperordern är ogiltig.");
  return signalIdentity(order);
}

/** Validates structure and arithmetic; local manual entries are not broker-verified. */
export function validateTradingViewPaperOrder(order) {
  if (!order || typeof order !== "object" || Array.isArray(order) || order.version !== TRADINGVIEW_PAPER_VERSION || !["OPEN", "CLOSED"].includes(order.status) || order.direction !== "LONG") return false;
  if (typeof order.sourcePaperObservationId !== "string" || !order.sourcePaperObservationId.startsWith("paper:") || order.id !== `tvpaper:${order.sourcePaperObservationId}` || order.sourcePaperVersion !== PAPER_VERSION || order.basis !== PAPER_BASIS.TECHNICAL_ONLY) return false;
  if (!["usa", "stockholm"].includes(order.market) || typeof order.ticker !== "string" || !/^[A-Z0-9.\-]{1,24}$/.test(order.ticker) || typeof order.exchange !== "string" || !order.exchange.trim() || typeof order.strategyVersion !== "string" || !order.strategyVersion.trim() || !["PULLBACK", "BREAKOUT"].includes(order.setup)) return false;
  if ((order.market === "usa" && (order.currency !== "USD" || order.timezone !== "America/New_York")) || (order.market === "stockholm" && (order.currency !== "SEK" || order.timezone !== "Europe/Stockholm"))) return false;
  if (!validDate(order.signalDate) || !isoTime(order.sourceRecordedAt) || !isoTime(order.entryAt) || !isoTime(order.entryRecordedAt)) return false;
  const entryTime = Date.parse(order.entryAt);
  const entryLogged = Date.parse(order.entryRecordedAt);
  if (entryTime <= Date.parse(order.sourceRecordedAt) || entryTime > entryLogged + CLOCK_SKEW_MS || entryLogged < Date.parse(order.sourceRecordedAt)) return false;
  const entryClock = getMarketStatus(order.market, new Date(entryTime));
  if (!entryClock.isOpen || entryClock.sessionDate !== nextSession(order.market, order.signalDate) || order.entryLateLogged !== (entryLogged - entryTime > LATE_LOG_MS)) return false;
  if (!finite(order.signalStop) || order.signalStop <= 0 || !finite(order.signalTarget) || order.signalTarget <= order.signalStop || !finite(order.entryPrice) || order.entryPrice <= 0 || !Number.isSafeInteger(order.quantity) || order.quantity < 1 || !finite(order.entryFee) || order.entryFee < 0 || !finite(order.entryPrice * order.quantity)) return false;
  const withinPlan = order.entryPrice > order.signalStop && order.entryPrice < order.signalTarget;
  if (order.entryWithinPlan !== withinPlan || !Number.isFinite((order.entryPrice - order.signalStop) * order.quantity)) return false;
  const exitKeys = ["exitAt", "exitPrice", "exitQuantity", "exitFee", "exitRecordedAt", "grossPnl", "totalFees", "netPnl", "resultR", "winner"];
  if (order.status === "OPEN") return exitKeys.every((key) => Object.hasOwn(order, key) && order[key] === null);
  if (!isoTime(order.exitAt) || !isoTime(order.exitRecordedAt) || Date.parse(order.exitAt) < entryTime || Date.parse(order.exitAt) > Date.parse(order.exitRecordedAt) + CLOCK_SKEW_MS || Date.parse(order.exitRecordedAt) < entryLogged) return false;
  if (!finite(order.exitPrice) || order.exitPrice <= 0 || order.exitQuantity !== order.quantity || !finite(order.exitFee) || order.exitFee < 0 || !finite(order.grossPnl) || !finite(order.totalFees) || !finite(order.netPnl)) return false;
  const gross = (order.exitPrice - order.entryPrice) * order.quantity;
  const totalFees = order.entryFee + order.exitFee;
  const net = gross - totalFees;
  if (![gross, totalFees, net].every(Number.isFinite) || !same(order.grossPnl, gross) || !same(order.totalFees, totalFees) || !same(order.netPnl, net)) return false;
  const initialRisk = withinPlan ? (order.entryPrice - order.signalStop) * order.quantity : null;
  const resultR = initialRisk > 0 ? net / initialRisk : null;
  if (resultR === null ? order.resultR !== null : !same(order.resultR, resultR)) return false;
  return order.winner === (Math.abs(net) <= 1e-8 ? null : net > 0);
}

/** Record an actual fake-money fill entered by the user from TradingView. */
export function createTradingViewPaperEntry(observation, { entryAt, entryPrice, quantity, entryFee } = {}, { recordedAt = Date.now() } = {}) {
  if (!validatePaperObservation(observation) || observation.version !== PAPER_VERSION || observation.basis !== PAPER_BASIS.TECHNICAL_ONLY) throw new Error("En aktuell, låst teknisk paperobservation krävs före TradingView-köpet.");
  if (!isoTime(entryAt)) throw new Error("Ange TradingViews köptid med datum och tidszon.");
  const loggedAt = timestamp(recordedAt);
  const entry = numberInput(entryPrice, "TradingViews köppris", { positive: true });
  const shares = numberInput(quantity, "antal aktier", { positive: true, integer: true });
  const fee = numberInput(entryFee, "köpavgift");
  const order = {
    version: TRADINGVIEW_PAPER_VERSION,
    id: `tvpaper:${observation.id}`, sourcePaperObservationId: observation.id,
    sourcePaperVersion: observation.version, sourceRecordedAt: observation.recordedAt,
    basis: observation.basis, direction: "LONG", status: "OPEN",
    ticker: observation.ticker, exchange: observation.exchange, currency: observation.currency,
    timezone: observation.timezone, market: observation.market, strategyVersion: observation.strategyVersion,
    setup: observation.setup, signalDate: observation.signalDate,
    signalStop: observation.plan.stop, signalTarget: observation.plan.target,
    entryAt, entryPrice: entry, quantity: shares, entryFee: fee,
    entryRecordedAt: new Date(loggedAt).toISOString(),
    entryLateLogged: loggedAt - Date.parse(entryAt) > LATE_LOG_MS,
    entryWithinPlan: entry > observation.plan.stop && entry < observation.plan.target,
    exitAt: null, exitPrice: null, exitQuantity: null, exitFee: null, exitRecordedAt: null,
    grossPnl: null, totalFees: null, netPnl: null, resultR: null, winner: null,
  };
  if (!validateTradingViewPaperOrder(order)) throw new Error("TradingView-köpet måste vara under nästa ordinarie handelssession efter den låsta signalen och ha giltiga pris- och kostnadsuppgifter.");
  return order;
}

/** Close an existing local TradingView paper order without changing its entry. */
export function closeTradingViewPaperEntry(openOrder, { exitAt, exitPrice, exitQuantity, exitFee } = {}, { recordedAt = Date.now() } = {}) {
  if (!validateTradingViewPaperOrder(openOrder) || openOrder.status !== "OPEN") throw new Error("Endast en giltig öppen TradingView-paperorder kan avslutas.");
  if (!isoTime(exitAt)) throw new Error("Ange TradingViews säljtidsstämpel med datum och tidszon.");
  const loggedAt = timestamp(recordedAt);
  const exit = numberInput(exitPrice, "TradingViews säljpris", { positive: true });
  const soldShares = numberInput(exitQuantity, "sålt antal aktier", { positive: true, integer: true });
  if (soldShares !== openOrder.quantity) throw new Error("Den här journalen kan bara avsluta hela positionen. Delvisa försäljningar stöds ännu inte.");
  const fee = numberInput(exitFee, "säljavgift");
  const grossPnl = (exit - openOrder.entryPrice) * openOrder.quantity;
  const totalFees = openOrder.entryFee + fee;
  const netPnl = grossPnl - totalFees;
  const initialRisk = openOrder.entryWithinPlan ? (openOrder.entryPrice - openOrder.signalStop) * openOrder.quantity : null;
  const order = {
    ...openOrder, status: "CLOSED", exitAt, exitPrice: exit, exitQuantity: soldShares, exitFee: fee,
    exitRecordedAt: new Date(loggedAt).toISOString(), grossPnl, totalFees, netPnl,
    resultR: initialRisk > 0 ? netPnl / initialRisk : null,
    winner: Math.abs(netPnl) <= 1e-8 ? null : netPnl > 0,
  };
  if (!validateTradingViewPaperOrder(order)) throw new Error("TradingView-avslutet är ogiltigt eller ligger före köpet.");
  return order;
}
