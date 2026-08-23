const MARKETS = {
  stockholm: { label: "Nasdaq Stockholm", timeZone: "Europe/Stockholm", open: 540, close: 1050 },
  usa: { label: "USA (Nasdaq/NYSE)", timeZone: "America/New_York", open: 570, close: 960 },
};

const iso = (year, month, day) => `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
const utcDate = (year, month, day) => new Date(Date.UTC(year, month - 1, day));
const addDays = (date, days) => new Date(date.getTime() + days * 86400000);
const dateKey = (date) => iso(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate());

function zonedParts(date, timeZone) {
  return Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone, year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", weekday: "short", hourCycle: "h23",
    }).formatToParts(date).map(({ type, value }) => [type, value])
  );
}

function easter(year) {
  const a = year % 19, b = Math.floor(year / 100), c = year % 100;
  const d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  return utcDate(year, month, ((h + l - 7 * m + 114) % 31) + 1);
}

function nthWeekday(year, month, weekday, occurrence) {
  const first = utcDate(year, month, 1);
  return iso(year, month, 1 + ((7 + weekday - first.getUTCDay()) % 7) + (occurrence - 1) * 7);
}

function lastWeekday(year, month, weekday) {
  const last = utcDate(year, month + 1, 0);
  return iso(year, month, last.getUTCDate() - ((7 + last.getUTCDay() - weekday) % 7));
}

function observed(year, month, day) {
  const date = utcDate(year, month, day);
  return dateKey(addDays(date, date.getUTCDay() === 6 ? -1 : date.getUTCDay() === 0 ? 1 : 0));
}

function fridayBetween(year, month, startDay, endDay) {
  for (let day = startDay; day <= endDay; day += 1) {
    const date = utcDate(year, month, day);
    if (date.getUTCDay() === 5) return dateKey(date);
  }
}

function previousWeekday(date) {
  let result = addDays(date, -1);
  while (result.getUTCDay() === 0 || result.getUTCDay() === 6) result = addDays(result, -1);
  return result;
}

function calendar(market, year) {
  const easterSunday = easter(year);
  if (market === "usa") {
    const thanksgiving = nthWeekday(year, 11, 4, 4);
    const independenceObserved = observed(year, 7, 4);
    return {
      closed: new Set([
        observed(year, 1, 1), observed(year + 1, 1, 1), nthWeekday(year, 1, 1, 3),
        nthWeekday(year, 2, 1, 3), dateKey(addDays(easterSunday, -2)), lastWeekday(year, 5, 1),
        observed(year, 6, 19), independenceObserved, nthWeekday(year, 9, 1, 1), thanksgiving,
        observed(year, 12, 25),
      ]),
      early: new Set([
        dateKey(addDays(new Date(`${thanksgiving}T00:00:00Z`), 1)),
        dateKey(previousWeekday(new Date(`${independenceObserved}T00:00:00Z`))),
        iso(year, 12, 24),
      ]),
    };
  }

  return {
    closed: new Set([
      iso(year, 1, 1), iso(year, 1, 6), dateKey(addDays(easterSunday, -2)),
      dateKey(addDays(easterSunday, 1)), iso(year, 5, 1), dateKey(addDays(easterSunday, 39)),
      iso(year, 6, 6), fridayBetween(year, 6, 19, 25), iso(year, 12, 24),
      iso(year, 12, 25), iso(year, 12, 26), iso(year, 12, 31),
    ]),
    early: new Set([
      iso(year, 1, 5), dateKey(addDays(easterSunday, -3)), iso(year, 4, 30),
      dateKey(addDays(easterSunday, 38)), fridayBetween(year, 10, 30, 36),
    ]),
  };
}

export function getMarketStatus(marketId = "stockholm", now = new Date()) {
  const id = MARKETS[marketId] ? marketId : "stockholm";
  const market = MARKETS[id];
  const parts = zonedParts(now, market.timeZone);
  const day = `${parts.year}-${parts.month}-${parts.day}`;
  const minutes = Number(parts.hour) * 60 + Number(parts.minute);
  const schedule = calendar(id, Number(parts.year));
  const weekend = parts.weekday === "Sat" || parts.weekday === "Sun";
  const holiday = schedule.closed.has(day);
  const earlyClose = schedule.early.has(day);
  const close = earlyClose ? 780 : market.close;
  const isOpen = !weekend && !holiday && minutes >= market.open && minutes < close;
  const reason = weekend ? "weekend" : holiday ? "holiday" : minutes < market.open ? "before_open" : minutes >= close ? "after_close" : "open";
  const time = (value) => `${String(Math.floor(value / 60)).padStart(2, "0")}:${String(value % 60).padStart(2, "0")}`;

  return { market: id, label: market.label, isOpen, reason, localTime: `${parts.hour}:${parts.minute}`, hours: `${time(market.open)}–${time(close)}`, earlyClose };
}

