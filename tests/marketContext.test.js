import test from "node:test";
import assert from "node:assert/strict";
import { selectClosedDailyBars } from "../src/dailyBars.js";
import { assessMarketContext, MARKET_CONTEXT_VERSION } from "../src/marketContext.js";

const now = Date.parse("2026-09-28T21:00:00Z");
const marketStatus = { market: "usa", isOpen: false, reason: "after_close", sessionDate: "2026-09-28" };
const options = { ticker: "NVDA", benchmarkTicker: "SPY", marketStatus, now };

function sessionDates(length = 100, end = "2026-09-28") {
  const dates = [];
  for (let date = new Date(`${end}T00:00:00Z`); dates.length < length; date.setUTCDate(date.getUTCDate() - 1)) {
    if (![0, 6].includes(date.getUTCDay())) dates.unshift(date.toISOString().slice(0, 10));
  }
  return dates;
}

function candle(datetime, close) {
  return { datetime, open: close, high: close + 2, low: close - 2, close, volume: 1_000_000 };
}

function data(ticker = "NVDA", { length = 100, end = "2026-09-28", price = (index) => 100 + 2 * index } = {}) {
  return {
    ticker, interval: "1day", exchange: ticker === "SPY" ? "NYSE Arca" : "NASDAQ",
    currency: "USD", timezone: "America/New_York",
    bars: sessionDates(length, end).map((date, index) => candle(date, price(index))),
  };
}

function inputs() {
  return [data(), data("SPY", { price: (index) => 200 + index })];
}

test("market context confirms only experimental trend and matched relative price returns", () => {
  const [stock, benchmark] = inputs();
  const result = assessMarketContext(stock, benchmark, options);
  assert.equal(result.version, MARKET_CONTEXT_VERSION);
  assert.equal(result.status, "CONFIRMED");
  assert.equal(result.metrics.shared_sessions, 21);
  assert.equal(result.metrics.stock_return_20_sessions_pct, (298 / 258 - 1) * 100);
  assert.equal(result.metrics.benchmark_return_20_sessions_pct, (299 / 279 - 1) * 100);
  assert.equal(result.metrics.relative_strength_20_sessions_pct, result.metrics.stock_return_20_sessions_pct - result.metrics.benchmark_return_20_sessions_pct);
  assert.ok(result.metrics.benchmark_price > result.metrics.benchmark_ema20);
  assert.ok(result.metrics.benchmark_ema20 > result.metrics.benchmark_ema50);
  assert.deepEqual(result.data_dates, { stock: "2026-09-28", benchmark: "2026-09-28", relative_start: sessionDates().at(-21), relative_end: "2026-09-28", session: "2026-09-28" });
  assert.match(result.reasons.at(-1), /ingen köpsignal.*vinstsannolikhet/);
  assert.equal("probability_up" in result, false);
  assert.deepEqual(result, assessMarketContext(structuredClone(stock), structuredClone(benchmark), options));
});

test("negative benchmark trend blocks even when the stock outperforms", () => {
  const stock = data();
  const benchmark = data("SPY", { price: (index) => 400 - index });
  const result = assessMarketContext(stock, benchmark, options);
  assert.equal(result.status, "BLOCKED");
  assert.equal(result.metrics.benchmark_trend_positive, false);
  assert.equal(result.metrics.relative_strength_positive, true);
});

test("positive price and EMA structure still needs positive five-session momentum", () => {
  const [stock, benchmark] = inputs();
  benchmark.bars[99] = candle("2026-09-28", 293);
  const result = assessMarketContext(stock, benchmark, options);
  assert.ok(result.metrics.benchmark_price > result.metrics.benchmark_ema20);
  assert.ok(result.metrics.benchmark_ema20 > result.metrics.benchmark_ema50);
  assert.ok(result.metrics.benchmark_momentum_5_sessions_pct < 0);
  assert.equal(result.status, "BLOCKED");
});

test("flat or negative relative strength cannot confirm the context", () => {
  const [stock, benchmark] = inputs();
  const equal = assessMarketContext({ ...stock, bars: structuredClone(benchmark.bars) }, benchmark, options);
  assert.equal(equal.status, "BLOCKED");
  assert.equal(equal.metrics.relative_strength_20_sessions_pct, 0);
  const weaker = assessMarketContext(data("NVDA", { price: (index) => 200 + 0.1 * index }), benchmark, options);
  assert.equal(weaker.status, "BLOCKED");
  assert.ok(weaker.metrics.relative_strength_20_sessions_pct < 0);
});

test("explicit instrument, market, currency and exchange identity are required", () => {
  const [stock, benchmark] = inputs();
  for (const [left, right, opts] of [
    [stock, benchmark, { ...options, benchmarkTicker: undefined }],
    [stock, benchmark, { ...options, benchmarkTicker: "NVDA" }],
    [{ ...stock, ticker: "AMD" }, benchmark, options],
    [stock, { ...benchmark, ticker: "QQQ" }, options],
    [stock, { ...benchmark, currency: "SEK" }, options],
    [{ ...stock, currency: null }, benchmark, options],
    [{ ...stock, exchange: "OMX" }, benchmark, options],
    [stock, { ...benchmark, exchange: null }, options],
    [{ ...stock, market: "stockholm" }, benchmark, options],
    [stock, benchmark, { ...options, marketStatus: { market: "off", isOpen: true } }],
    [stock, benchmark, { ...options, marketStatus: undefined }],
  ]) {
    const result = assessMarketContext(left, right, opts);
    assert.equal(result.status, "NOT_ASSESSED");
    assert.equal(result.metrics, null);
  }
});

test("different latest dates and missing dates within the relative window fail closed", () => {
  const [stock, benchmark] = inputs();
  for (const right of [
    { ...benchmark, bars: benchmark.bars.slice(0, -1) },
    { ...benchmark, bars: benchmark.bars.filter((_, index) => index !== 90) },
    { ...benchmark, bars: benchmark.bars.filter((_, index) => index < 79 || index >= 89) },
  ]) {
    const result = assessMarketContext(stock, right, options);
    assert.equal(result.status, "NOT_ASSESSED");
    assert.match(result.reasons[0], /21.*sessionsdatum/);
  }
});

test("Stockholm uses a separate explicit compatible instrument and SEK session metadata", () => {
  const [stock, benchmark] = inputs();
  const convert = (value, ticker) => ({ ...value, ticker, exchange: "OMX", currency: "SEK", timezone: "Europe/Stockholm" });
  const result = assessMarketContext(convert(stock, "VOLV B"), convert(benchmark, "BENCHMARK"), {
    ticker: "VOLV B", benchmarkTicker: "BENCHMARK", now,
    marketStatus: { market: "stockholm", isOpen: false, reason: "after_close", sessionDate: "2026-09-28" },
  });
  assert.equal(result.status, "CONFIRMED");
});

test("an open exchange keeps yesterday's final daily candle and removes only today's bar", () => {
  const clock = { market: "usa", isOpen: true, reason: "open", sessionDate: "2026-09-28" };
  const activeNow = Date.parse("2026-09-28T15:00:00Z");
  const yesterday = data("NVDA", { end: "2026-09-25" });
  const retained = selectClosedDailyBars(yesterday, { marketStatus: clock, now: activeNow });
  assert.equal(retained.valid, true);
  assert.equal(retained.bars.length, 100);
  assert.equal(retained.latestDate, "2026-09-25");
  assert.equal(retained.excludedCurrentSession, false);
  const current = selectClosedDailyBars(data(), { marketStatus: clock, now: activeNow });
  assert.equal(current.valid, true);
  assert.equal(current.bars.length, 99);
  assert.equal(current.latestDate, "2026-09-25");
  assert.equal(current.excludedCurrentSession, true);
  const paired = assessMarketContext(...inputs(), { ...options, marketStatus: clock, now: activeNow });
  assert.equal(paired.status, "CONFIRMED");
  assert.equal(paired.data_dates.relative_end, "2026-09-25");
});

test("closed-before-open, weekend and holiday do not mark today's daily candle complete", () => {
  for (const [reason, end, at] of [
    ["before_open", "2026-09-28", "2026-09-28T12:00:00Z"],
    ["weekend", "2026-09-27", "2026-09-27T22:00:00Z"],
    ["holiday", "2026-09-28", "2026-09-28T22:00:00Z"],
  ]) {
    const input = data("NVDA", { end });
    if (reason === "weekend") input.bars.push(candle(end, 301));
    const result = selectClosedDailyBars(input, { marketStatus: { market: "usa", isOpen: false, reason, sessionDate: end }, now: Date.parse(at) });
    assert.equal(result.valid, true);
    assert.ok(result.latestDate < end);
    assert.equal(result.excludedCurrentSession, true);
  }
});

test("missing sessionDate uses exchange timezone at UTC midnight and through DST", () => {
  const today = data("NVDA", { end: "2026-09-28" });
  const result = selectClosedDailyBars(today, { marketStatus: { market: "usa", isOpen: false }, now: Date.parse("2026-09-29T00:30:00Z") });
  assert.equal(result.valid, true);
  assert.equal(result.sessionDate, "2026-09-28");
  assert.equal(result.latestDate, "2026-09-28");
  for (const [end, before, after] of [
    ["2026-07-01", "2026-07-01T19:59:00Z", "2026-07-01T20:00:00Z"],
    ["2026-01-07", "2026-01-07T20:59:00Z", "2026-01-07T21:00:00Z"],
  ]) {
    const input = data("NVDA", { end });
    const open = selectClosedDailyBars(input, { marketStatus: { market: "usa", isOpen: false }, now: Date.parse(before) });
    const closed = selectClosedDailyBars(input, { marketStatus: { market: "usa", isOpen: false }, now: Date.parse(after) });
    assert.ok(open.latestDate < end);
    assert.equal(closed.latestDate, end);
  }
});

test("confirmed early close and explicit historic sessionDate support replay", () => {
  const early = data("NVDA", { end: "2026-11-27" });
  const result = selectClosedDailyBars(early, { marketStatus: { market: "usa", isOpen: false, reason: "after_close", earlyClose: true, sessionDate: "2026-11-27" }, now: Date.parse("2026-11-27T18:01:00Z") });
  assert.equal(result.valid, true);
  assert.equal(result.latestDate, "2026-11-27");
  const swedish = { ...data(), timezone: "Europe/Stockholm" };
  const historic = selectClosedDailyBars(swedish, { marketStatus: { market: "stockholm", isOpen: false, reason: "after_close", sessionDate: "2026-09-28" }, now: Date.parse("2026-09-28T23:59:00Z") });
  assert.equal(historic.valid, true);
  assert.equal(historic.sessionDate, "2026-09-28");
  assert.equal(historic.latestDate, "2026-09-28");
});

test("invalid data, interval, date, duplicate, order, OHLC and volume fail closed", () => {
  const original = data();
  const alter = (change) => {
    const copy = structuredClone(original);
    change(copy);
    return copy;
  };
  for (const input of [
    null,
    { ...original, interval: "15min" },
    { ...original, timezone: null },
    { ...original, timezone: "UTC" },
    { ...original, bars: original.bars.slice(-59) },
    alter((copy) => { copy.bars[50].datetime = "2026-02-30"; }),
    alter((copy) => { copy.bars[99].datetime += " 00:00:00"; }),
    alter((copy) => { copy.bars[50] = structuredClone(copy.bars[49]); }),
    alter((copy) => { [copy.bars[50], copy.bars[51]] = [copy.bars[51], copy.bars[50]]; }),
    alter((copy) => { copy.bars[99].high = copy.bars[99].low - 1; }),
    alter((copy) => { copy.bars[99].volume = 0; }),
    alter((copy) => { copy.bars[99].volume = null; }),
    alter((copy) => { copy.bars[99].close = "298"; }),
  ]) {
    const result = selectClosedDailyBars(input, { marketStatus, now });
    assert.equal(result.valid, false);
    assert.deepEqual(result.bars, []);
    assert.equal(assessMarketContext(input, inputs()[1], options).status, "NOT_ASSESSED");
  }
});

test("future sessions, stale history and contradictory or invalid clocks fail closed", () => {
  const original = data();
  for (const [input, opts] of [
    [data("NVDA", { end: "2026-09-29" }), { marketStatus, now }],
    [data("NVDA", { end: "2026-09-22" }), { marketStatus, now }],
    [original, { marketStatus: { ...marketStatus, sessionDate: "2026-09-29" }, now }],
    [original, { marketStatus: { ...marketStatus, isOpen: true }, now }],
    [original, { marketStatus: { ...marketStatus, reason: "open" }, now }],
    [original, { marketStatus: { ...marketStatus, reason: "unknown" }, now }],
    [original, { marketStatus: { ...marketStatus, isOpen: null }, now }],
    [original, { marketStatus, now: Date.parse("2026-09-28T12:00:00Z") }],
    [original, { marketStatus, now: NaN }],
    [original, { marketStatus, now: 1e30 }],
    [original, { marketStatus, now: "2026-09-28" }],
  ]) {
    assert.equal(selectClosedDailyBars(input, opts).valid, false);
  }
});

test("five-calendar-day freshness boundary is explicit and both inputs remain untouched", () => {
  const at = Date.parse("2026-09-28T21:00:00Z");
  const allowed = data("NVDA", { end: "2026-09-23" });
  assert.equal(selectClosedDailyBars(allowed, { marketStatus, now: at }).valid, true);
  const [stock, benchmark] = inputs();
  const previous = structuredClone([stock, benchmark]);
  assessMarketContext(stock, benchmark, options);
  selectClosedDailyBars(stock, { marketStatus: { market: "usa", isOpen: true, reason: "open", sessionDate: "2026-09-28" }, now: Date.parse("2026-09-28T15:00:00Z") });
  assert.deepEqual([stock, benchmark], previous);
});
