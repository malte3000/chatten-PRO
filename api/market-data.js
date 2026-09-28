import { isAuthenticated } from "./_auth.js";
import { validateMarketBars } from "./_market-data-validation.js";
import { isTimeoutError, providerErrorMessage, readProviderJson } from "./_provider-response.js";
const ALLOWED_INTERVALS = new Set([
  "1min",
  "5min",
  "15min",
  "30min",
  "1h",
  "1day",
]);

function toNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export default async function handler(req, res) {
  if (!isAuthenticated(req)) {
    return res.status(401).json({
      error: "Unauthorized",
      message: "Du måste vara inloggad.",
    });
  }

  if (req.method !== "GET") {
    return res.status(405).json({
      error: "Method not allowed",
    });
  }

  try {
    const apiKey = process.env.TWELVE_DATA_API_KEY;

    if (!apiKey) {
      return res.status(500).json({
        error: "TWELVE_DATA_API_KEY saknas",
      });
    }

    const ticker = String(req.query.ticker || "")
      .trim()
      .toUpperCase();

    const interval = String(req.query.interval || "1min");
    const exchange = String(req.query.exchange || "").trim();
    if (exchange && !/^[A-Za-z0-9._ -]{1,60}$/.test(exchange)) return res.status(400).json({ error: "Ogiltig börs" });

    const requestedOutputSize = Number.parseInt(
      req.query.outputsize || "100",
      10
    );

    const outputsize = Math.min(
      200,
      Math.max(
        2,
        Number.isFinite(requestedOutputSize)
          ? requestedOutputSize
          : 100
      )
    );

    if (!ticker) {
      return res.status(400).json({
        error: "Ticker saknas",
      });
    }

    if (!ALLOWED_INTERVALS.has(interval)) {
      return res.status(400).json({
        error: "Ogiltigt intervall",
      });
    }

    const params = new URLSearchParams({
      symbol: ticker,
      interval,
      outputsize: String(outputsize),
      apikey: apiKey,
      format: "JSON",
      timezone: "UTC",
    });
    if (exchange) params.set("exchange", exchange);

    const response = await fetch(
      `https://api.twelvedata.com/time_series?${params.toString()}`,
      { signal: AbortSignal.timeout(15000) }
    );

    const data = await readProviderJson(response);

    if (!response.ok || !data || data?.status === "error") {
      return res.status(502).json({
        error: "Market data provider error",
        message: providerErrorMessage(data, "Twelve Data returnerade ett ogiltigt svar."),
      });
    }

    if (!Array.isArray(data?.values) || data.values.length === 0) {
      return res.status(502).json({
        error: "Ingen marknadsdata returnerades",
      });
    }

    if (String(data.meta?.symbol || "").toUpperCase() !== ticker ||
        (exchange && String(data.meta?.exchange || "").toUpperCase() !== exchange.toUpperCase())) {
      return res.status(502).json({ error: "Prisdata matchar inte vald aktie och börs." });
    }

    const bars = data.values
      .map((bar) => ({
        datetime: bar.datetime,
        open: toNumber(bar.open),
        high: toNumber(bar.high),
        low: toNumber(bar.low),
        close: toNumber(bar.close),
        volume: toNumber(bar.volume),
      }))
      .reverse();

    const latest = bars[bars.length - 1];
const validation = validateMarketBars(bars);

if (!validation.valid) {
  return res.status(502).json({
    error: "Invalid market data",
    message: "Marknadsdatan innehåller ogiltiga candles.",
    validation,
  });
}
    return res.status(200).json({
      source: "twelve_data",
      requested_ticker: ticker,
      requested_exchange: exchange || null,
      ticker: data.meta?.symbol || ticker,
      interval: data.meta?.interval || interval,
      exchange: data.meta?.exchange || null,
      currency: data.meta?.currency || null,
      timezone: data.meta?.exchange_timezone || null,
      fetched_at: new Date().toISOString(),
validation,

price: latest?.close ?? null,
latest,

bars,
    });
  } catch (error) {
    console.error("Market data error:", error);

    return res.status(isTimeoutError(error) ? 504 : 502).json({
      error: isTimeoutError(error) ? "Tidsgränsen för marknadsdata överskreds." : "Kunde inte hämta marknadsdata",
      message: isTimeoutError(error) ? "Twelve Data svarade inte inom 15 sekunder." : error.message,
    });
  }
}
