import { getMarketStatus } from "../api/_market-hours.js";

const DAY_MS = 86400000;
const SUPPORTED_MARKETS = new Set(["usa", "stockholm"]);

function validDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const timestamp = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === value;
}

function tradingSession(market, date) {
  const status = getMarketStatus(market, new Date(`${date}T12:00:00Z`));
  return status.reason === "weekend" || status.reason === "holiday" ? null : status;
}

function adjacentSession(market, date, step) {
  const startingTime = Date.parse(`${date}T00:00:00Z`);
  for (let offset = 1; offset <= 15; offset += 1) {
    const candidate = new Date(startingTime + step * offset * DAY_MS).toISOString().slice(0, 10);
    const session = tradingSession(market, candidate);
    if (session) return session;
  }
  return null;
}

/**
 * A daily-bar TRADE remains a current assessment through the following
 * regular trading session. At that session's close a new completed bar is
 * expected, so the old assessment must no longer be presented as current.
 * This changes only presentation; the original decision remains in history.
 */
export function swingSignalValidity({ market, signalDate, now = Date.now() } = {}) {
  const timestamp = now instanceof Date ? now.getTime() : now;
  const unverified = { status: "UNVERIFIED", signalDate: signalDate || null, expectedSession: null, expirySession: null, expiryLocalClose: null };
  if (!SUPPORTED_MARKETS.has(market) || !validDate(signalDate) || !Number.isFinite(timestamp) || !Number.isFinite(new Date(timestamp).getTime())) return unverified;
  if (!tradingSession(market, signalDate)) return unverified;
  const clock = getMarketStatus(market, new Date(timestamp));
  const expected = clock.reason === "after_close" ? clock.sessionDate : adjacentSession(market, clock.sessionDate, -1)?.sessionDate;
  const expiry = adjacentSession(market, signalDate, 1);
  if (!validDate(expected) || !expiry) return unverified;
  return {
    status: signalDate === expected ? "CURRENT" : signalDate < expected ? "EXPIRED" : "UNVERIFIED",
    signalDate,
    expectedSession: expected,
    expirySession: expiry.sessionDate,
    expiryLocalClose: expiry.hours?.split("–")[1] || null,
  };
}
