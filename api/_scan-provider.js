import { validateMarketBars } from "./_market-data-validation.js";
import { screenInstrument, rankCandidates } from "../src/screening.js";
import { isTimeoutError, providerErrorMessage, readProviderJson } from "./_provider-response.js";

const universeCache = new Map();
const MAX_RUN = 100;
let nextBatchAt = 0;
export class ScanError extends Error {
  constructor(message, status = 502, retryAfterMs = 0) { super(message); this.status = status; this.retryAfterMs = retryAfterMs; }
}

async function provider(url) {
  let response;
  try { response = await fetch(url, { signal: AbortSignal.timeout(12000) }); }
  catch (error) { throw new ScanError(isTimeoutError(error) ? "Tidsgränsen för marknadsdata överskreds." : "Marknadsdatakällan svarade inte.", isTimeoutError(error) ? 504 : 502); }
  const data = await readProviderJson(response);
  if (response.status === 429 || Number(data?.code) === 429) throw new ScanError("Datakällans kvot är nådd. Försök igen senare.", 429, 61000);
  if (!response.ok || !data || data?.status === "error") throw new ScanError(providerErrorMessage(data, "Datakällan returnerade ett ogiltigt svar. Kontrollera täckning och abonnemang."));
  return data;
}

function hash(value) {
  let result = 2166136261;
  for (const letter of value) result = Math.imul(result ^ letter.charCodeAt(0), 16777619);
  return result >>> 0;
}

function isClearlyUnsupportedProduct(item) {
  const symbol = String(item.symbol || "").toUpperCase();
  const name = String(item.name || "").toUpperCase();
  return /^(?:BULL|BEAR|MINI|TURBO)(?:[.\s-]|$)/.test(symbol) ||
    /\.AVA\./.test(symbol) ||
    /\b(?:WARRANT|CERTIFICATE|MINI FUTURE|TURBO|BULL CERTIFICATE|BEAR CERTIFICATE)\b/.test(name);
}

export async function getUniverse(market, now = Date.now()) {
  const cached = universeCache.get(market);
  if (cached && now - cached.time < 3 * 3600000) return cached.items;
  const country = market === "usa" ? "United States" : "Sweden";
  const params = new URLSearchParams({ country, type: "Common Stock", format: "JSON" });
  const data = await provider(`https://api.twelvedata.com/stocks?${params}`);
  if (!Array.isArray(data.data)) throw new ScanError("Aktielistan har ett ogiltigt format.");
  const seen = new Set();
  const items = data.data.filter((item) => {
    const exchange = String(item.exchange || "");
    const supportedExchange = market === "usa" ? ["NASDAQ", "NYSE"].includes(exchange.toUpperCase()) : item.mic_code === "XSTO" || /stockholm|^OMX$/i.test(exchange);
    const key = `${item.symbol}:${exchange}`;
    if (!supportedExchange || item.type !== "Common Stock" || item.country !== country || !/^[A-Z0-9._ -]{1,20}$/i.test(item.symbol || "") || isClearlyUnsupportedProduct(item) || seen.has(key)) return false;
    seen.add(key); return true;
  }).map((item) => ({ symbol: item.symbol.toUpperCase(), name: String(item.name || item.symbol), exchange: String(item.exchange), mic_code: item.mic_code || null, currency: item.currency, country }));
  if (!items.length) throw new ScanError("Inga stödda aktier hittades på vald marknad. Sverigetäckning måste verifieras hos datakällan.");
  universeCache.set(market, { time: now, items });
  return items;
}

export async function scanBatch({ market, horizon, offset, limit, seed }, now = Date.now()) {
  const apiKey = process.env.TWELVE_DATA_API_KEY;
  if (!apiKey) throw new ScanError("TWELVE_DATA_API_KEY saknas på servern.", 500);
  const batchSize = Math.min(8, Math.max(1, Number.parseInt(process.env.SCAN_BATCH_SIZE || "4", 10) || 4));
  if (now < nextBatchAt) throw new ScanError("Skannern väntar på nästa databudgetfönster.", 429, nextBatchAt - now);
  const universe = await getUniverse(market, now);
  if (now < nextBatchAt) throw new ScanError("Skannern väntar på nästa databudgetfönster.", 429, nextBatchAt - now);
  const ordered = [...universe].sort((a, b) => hash(`${seed}:${a.symbol}:${a.exchange}`) - hash(`${seed}:${b.symbol}:${b.exchange}`) || a.symbol.localeCompare(b.symbol));
  const total = Math.min(limit, MAX_RUN, ordered.length);
  const selection = ordered.slice(offset, Math.min(offset + batchSize, total));
  if (!selection.length) return { results: [], next_offset: total, done: true, total, universe_size: universe.length, wait_ms: 0 };
  // Best-effort warm-instance throttle, plus client pacing. Not a distributed quota.
  nextBatchAt = now + 61000;
  const params = new URLSearchParams({ symbol: selection.map((item) => `${item.symbol}:${item.exchange}`).join(","), interval: horizon === "week" ? "1day" : "15min", outputsize: "100", timezone: "UTC", apikey: apiKey, format: "JSON" });
  const data = await provider(`https://api.twelvedata.com/time_series?${params}`);
  const results = selection.map((instrument) => {
    const raw = selection.length === 1 && data.values ? data : data[`${instrument.symbol}:${instrument.exchange}`] || data[instrument.symbol];
    if (Number(raw?.code) === 429) throw new ScanError("Datakällans kvot är nådd. Skanningen är inte komplett.", 429, 61000);
    if (!raw || raw.status === "error" || !Array.isArray(raw.values) || raw.meta?.symbol?.toUpperCase() !== instrument.symbol || raw.meta?.exchange?.toUpperCase() !== instrument.exchange.toUpperCase() || raw.meta?.currency !== instrument.currency) {
      const data_issue = !raw ? "MISSING_SERIES" : raw.status === "error" ? "PROVIDER_REJECTED" : !Array.isArray(raw.values) ? "INVALID_SERIES" : "IDENTITY_MISMATCH";
      return { ...instrument, status: "NOT_ASSESSED", rank_score: 0, metrics: null, data_issue, reasons: ["Kursdata för rätt aktie och börs kunde inte verifieras. Strategin har inte bedömts."] };
    }
    const toNumber = (value) => value === null || value === undefined || value === "" ? null : Number(value);
    const bars = raw.values.map((bar) => ({ datetime: bar.datetime, open: toNumber(bar.open), high: toNumber(bar.high), low: toNumber(bar.low), close: toNumber(bar.close), volume: toNumber(bar.volume) })).reverse();
    const marketData = {
      ticker: instrument.symbol,
      interval: horizon === "week" ? "1day" : "15min",
      timezone: raw.meta?.exchange_timezone || null,
      bars,
      validation: validateMarketBars(bars),
    };
    const screened = screenInstrument(instrument, marketData, { horizon, market, now });
    return {
      ...screened,
      data_snapshot: {
        source: "twelve_data", interval: horizon === "week" ? "1day" : "15min",
        timestamp_timezone: horizon === "week" ? raw.meta?.exchange_timezone || null : "UTC", fetched_at: new Date(now).toISOString(),
        timestamp_kind: horizon === "week" ? "exchange_session_date" : "utc_instant",
        validation: marketData.validation, bars, screening_selection: screened.screening_selection,
      },
    };
  });
  if (market === "stockholm" && results.every((item) => item.status === "NOT_ASSESSED")) {
    throw new ScanError("Stockholmsbörsens kursdata kunde inte verifieras hos datakällan. Skanningen avbröts utan tradebedömning. Kontrollera datatäckning och abonnemang.");
  }
  const nextOffset = offset + selection.length;
  return { results: rankCandidates(results), next_offset: nextOffset, done: nextOffset >= total, total, universe_size: universe.length, wait_ms: nextOffset >= total ? 0 : 61000, fetched_at: new Date(now).toISOString() };
}
