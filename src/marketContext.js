import { selectClosedDailyBars } from "./dailyBars.js";
import { ema } from "./screening.js";

export const MARKET_CONTEXT_VERSION = "market-context-v0.1-experimental";

const MARKETS = {
  usa: { currency: "USD", exchanges: new Set(["NASDAQ", "NASDAQGS", "NASDAQGM", "NASDAQCM", "NYSE", "NYSEARCA", "ARCA", "AMEX", "NYSEAMERICAN", "BATS", "CBOE", "XNAS", "XNYS", "ARCX", "XASE"]) },
  stockholm: { currency: "SEK", exchanges: new Set(["OMX", "XSTO", "STOCKHOLM", "NASDAQSTOCKHOLM", "OMXSTOCKHOLM"]) },
};
const symbol = (value) => typeof value === "string" ? value.trim().toUpperCase() : "";
const exchange = (value) => symbol(value).replace(/[\s_-]/g, "");

/**
 * A benchmark is an explicitly selected instrument, never inferred from ticker.
 * This long-side research filter compares closing-price returns in the same
 * currency; it does not establish total return, a trade entry, or probability.
 * Both series must have identical last 21 closed session dates (20 intervals).
 */
export function assessMarketContext(stockData, benchmarkData, { ticker, benchmarkTicker, marketStatus, now = Date.now() } = {}) {
  const stockTicker = symbol(ticker);
  const referenceTicker = symbol(benchmarkTicker);
  const base = {
    version: MARKET_CONTEXT_VERSION, status: "NOT_ASSESSED", ticker: stockTicker || null,
    benchmark_ticker: referenceTicker || null, metrics: null,
    data_dates: { stock: null, benchmark: null, relative_start: null, relative_end: null, session: null },
  };
  const unavailable = (reason) => ({ ...base, reasons: [reason] });
  if (!stockTicker || !referenceTicker || stockTicker === referenceTicker) return unavailable("En aktie och ett separat referensinstrument måste väljas uttryckligen.");
  if (symbol(stockData?.ticker) !== stockTicker || symbol(benchmarkData?.ticker) !== referenceTicker) return unavailable("Dagsdatan matchar inte de valda instrumenten.");

  const market = MARKETS[marketStatus?.market];
  if (!market) return unavailable("Marknadskontexten kräver en stödd och aktiverad marknadskontroll.");
  for (const [name, data] of [["Aktien", stockData], ["Referensinstrumentet", benchmarkData]]) {
    if (symbol(data?.currency) !== market.currency) return unavailable(`${name} saknar rätt jämförbar valuta för marknaden.`);
    if (!market.exchanges.has(exchange(data?.exchange))) return unavailable(`${name} saknar en identifierad kompatibel börs.`);
    if (data?.market != null && data.market !== marketStatus.market) return unavailable(`${name} tillhör en annan marknad än börsklockan.`);
  }

  const stock = selectClosedDailyBars(stockData, { marketStatus, now });
  const benchmark = selectClosedDailyBars(benchmarkData, { marketStatus, now });
  base.data_dates = { ...base.data_dates, stock: stock.latestDate, benchmark: benchmark.latestDate, session: stock.sessionDate };
  if (!stock.valid) return unavailable(`Aktien: ${stock.reasons[0]}`);
  if (!benchmark.valid) return unavailable(`Referensinstrumentet: ${benchmark.reasons[0]}`);

  const stockWindow = stock.bars.slice(-21);
  const benchmarkWindow = benchmark.bars.slice(-21);
  const stockByDate = new Map(stockWindow.map((bar) => [bar.datetime, bar]));
  const pairs = benchmarkWindow.flatMap((bar) => stockByDate.has(bar.datetime) ? [{ stock: stockByDate.get(bar.datetime), benchmark: bar }] : []);
  if (pairs.length !== 21 || stock.latestDate !== benchmark.latestDate) return unavailable("Relativ styrka kräver samma senaste 21 färdigställda sessionsdatum i båda dataserierna för en avkastning över 20 sessioner.");

  const benchmarkCloses = benchmark.bars.map((bar) => bar.close);
  const benchmarkPrice = benchmarkCloses.at(-1);
  const benchmarkEma20 = ema(benchmarkCloses, 20);
  const benchmarkEma50 = ema(benchmarkCloses, 50);
  const benchmarkMomentum = (benchmarkPrice / benchmarkCloses.at(-6) - 1) * 100;
  const stockReturn = (pairs.at(-1).stock.close / pairs[0].stock.close - 1) * 100;
  const benchmarkReturn = (pairs.at(-1).benchmark.close / pairs[0].benchmark.close - 1) * 100;
  const relativeStrength = stockReturn - benchmarkReturn;
  const trend = benchmarkPrice > benchmarkEma20 && benchmarkEma20 > benchmarkEma50 && benchmarkMomentum > 0;
  const strength = relativeStrength > 0;
  const metrics = {
    benchmark_price: benchmarkPrice, benchmark_ema20: benchmarkEma20, benchmark_ema50: benchmarkEma50,
    benchmark_momentum_5_sessions_pct: benchmarkMomentum,
    stock_return_20_sessions_pct: stockReturn, benchmark_return_20_sessions_pct: benchmarkReturn,
    relative_strength_20_sessions_pct: relativeStrength, benchmark_trend_positive: trend,
    relative_strength_positive: strength, shared_sessions: pairs.length,
  };
  if (Object.values(metrics).some((value) => typeof value === "number" && !Number.isFinite(value))) return unavailable("Prisnivåerna gav ogiltiga beräkningar för marknadskontexten.");
  const reasons = [
    trend ? "Referensinstrumentets stängningskurs ligger över EMA20 över EMA50 med positivt momentum över fem sessioner." : "Referensinstrumentet klarar inte det positiva trend- och momentumfiltret.",
    strength ? "Aktien har högre prisavkastning än referensinstrumentet över samma 20 sessioner." : "Aktien har inte högre prisavkastning än referensinstrumentet över samma 20 sessioner.",
    ...stock.reasons, ...benchmark.reasons,
    "Experimentella trösklar för långsidan. Bekräftat filter är ingen köpsignal, validerad edge eller vinstsannolikhet. Prisavkastningen inkluderar inte utdelningar eller valutakonvertering.",
  ];
  return {
    ...base, status: trend && strength ? "CONFIRMED" : "BLOCKED", metrics, reasons,
    data_dates: { ...base.data_dates, relative_start: pairs[0].stock.datetime, relative_end: pairs.at(-1).stock.datetime },
  };
}
