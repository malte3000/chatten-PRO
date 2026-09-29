import { validateMarketBars } from "../api/_market-data-validation.js";

const DAY_MS = 86400000;
const MARKET_CLOCKS = {
  usa: { timeZone: "America/New_York", closeMinutes: 16 * 60 },
  stockholm: { timeZone: "Europe/Stockholm", closeMinutes: 17 * 60 + 30 },
};
const CLOCK_REASONS = new Set(["open", "after_close", "before_open", "weekend", "holiday"]);

function dateMillis(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const timestamp = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === value ? timestamp : null;
}

function zonedClock(now, timeZone) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(new Date(now)).map(({ type, value }) => [type, value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, minutes: Number(parts.hour) * 60 + Number(parts.minute) };
}

/**
 * Daily timestamps are exchange session dates, not UTC instants. Twelve Data
 * ignores timezone for 1day: https://twelvedata.com/docs (time_series timezone).
 * The clock must describe the same market and dataset. Historical replay may
 * supply sessionDate explicitly and now after that session's close.
 * This is a five-calendar-day freshness cap, not a complete exchange calendar.
 */
export function selectClosedDailyBars(data, { marketStatus, now = Date.now(), minBars = 60 } = {}) {
  let sessionDate = null;
  const timeZone = data?.timezone || null;
  const invalid = (reason) => ({ valid: false, bars: [], reasons: [reason], sessionDate, latestDate: null, timeZone, excludedCurrentSession: false });
  const timestamp = now instanceof Date ? now.getTime() : now;
  if (typeof timestamp !== "number" || !Number.isFinite(timestamp) || !Number.isFinite(new Date(timestamp).getTime()) || !Number.isInteger(minBars) || minBars < 1) {
    return invalid("Ogiltig kontrolltid eller minsta antal dagskurser.");
  }
  const clockConfig = MARKET_CLOCKS[marketStatus?.market];
  if (!clockConfig || typeof marketStatus?.isOpen !== "boolean") return invalid("Tillförlitlig börsklocka saknas för dagsdata.");
  if (timeZone !== clockConfig.timeZone) return invalid("Dagsdatans börstidszon saknas eller matchar inte marknaden.");
  if (data?.interval !== "1day") return invalid("Färdigställda dagsdata kräver intervallet 1day.");

  const clock = zonedClock(timestamp, timeZone);
  sessionDate = marketStatus.sessionDate ?? clock.date;
  if (dateMillis(sessionDate) === null || sessionDate > clock.date) return invalid("Börsklockans sessionsdatum är ogiltigt eller ligger i framtiden.");
  const reason = marketStatus.reason;
  if (reason != null && !CLOCK_REASONS.has(reason)) return invalid("Börsklockans sessionsstatus är okänd.");
  if ((marketStatus.isOpen && reason != null && reason !== "open") || (!marketStatus.isOpen && reason === "open")) {
    return invalid("Börsklockans öppetstatus och sessionsstatus motsäger varandra.");
  }

  if (!Array.isArray(data?.bars) || !validateMarketBars(data.bars).valid) return invalid("Giltiga, unika och sorterade OHLC-candles saknas.");
  if (data.bars.some((bar) => dateMillis(bar.datetime) === null)) return invalid("Dagskurserna kräver verkliga sessionsdatum i formatet YYYY-MM-DD.");
  if (data.bars.some((bar) => bar.datetime > sessionDate || bar.datetime > clock.date)) return invalid("Dagsdatan innehåller en framtida session.");
  if (data.bars.some((bar) => !Number.isFinite(bar.volume) || bar.volume <= 0)) return invalid("Positiv och tillförlitlig volym krävs för varje dagskurs.");

  const weekday = new Date(`${sessionDate}T00:00:00Z`).getUTCDay();
  const weekend = weekday === 0 || weekday === 6;
  const closeMinutes = marketStatus.earlyClose === true ? 13 * 60 : clockConfig.closeMinutes;
  const timeHasPassedClose = sessionDate < clock.date || clock.minutes >= closeMinutes;
  if (reason === "after_close" && (!timeHasPassedClose || weekend)) return invalid("Kontrolltiden bekräftar inte att dagens ordinarie session har stängt.");
  const currentSessionClosed = !marketStatus.isOpen && !weekend && timeHasPassedClose && (reason === "after_close" || reason == null);
  // Remove only a candle stamped with this session's date. An open market does
  // not make yesterday's completed candle unfinished.
  const bars = currentSessionClosed ? [...data.bars] : data.bars.filter((bar) => bar.datetime < sessionDate);
  const excludedCurrentSession = bars.length !== data.bars.length;
  if (bars.length < minBars) return invalid(`Minst ${minBars} färdigställda dagscandles krävs.`);
  const latestDate = bars.at(-1).datetime;
  if ((dateMillis(clock.date) - dateMillis(latestDate)) / DAY_MS > 5) return invalid("Senaste färdigställda dagskursen är äldre än fem kalenderdagar.");

  return {
    valid: true, bars, sessionDate, latestDate, timeZone, excludedCurrentSession,
    reasons: excludedCurrentSession ? ["Candlen för den ännu inte färdigställda sessionen har uteslutits."] : [],
  };
}
