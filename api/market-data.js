import { isAuthenticated } from "./_auth.js";

const ALLOWED_INTERVALS = new Set([
  "1min",
  "5min",
  "15min",
  "30min",
  "1h",
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
    });

    const response = await fetch(
      `https://api.twelvedata.com/time_series?${params.toString()}`
    );

    const data = await response.json();

    if (!response.ok || data?.status === "error") {
      return res.status(502).json({
        error: "Market data provider error",
        message:
          data?.message ||
          "Kunde inte hämta marknadsdata.",
      });
    }

    if (!Array.isArray(data?.values) || data.values.length === 0) {
      return res.status(502).json({
        error: "Ingen marknadsdata returnerades",
      });
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

    return res.status(200).json({
      source: "twelve_data",
      ticker: data.meta?.symbol || ticker,
      interval: data.meta?.interval || interval,
      exchange: data.meta?.exchange || null,
      currency: data.meta?.currency || null,
      timezone: data.meta?.exchange_timezone || null,
      fetched_at: new Date().toISOString(),

      price: latest?.close ?? null,
      latest,

      bars,
    });
  } catch (error) {
    console.error("Market data error:", error);

    return res.status(500).json({
      error: "Kunde inte hämta marknadsdata",
      message: error.message,
    });
  }
}