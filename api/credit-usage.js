import { isAuthenticated } from "./_auth.js";
import { isTimeoutError, readProviderJson } from "./_provider-response.js";

function nonnegativeInteger(value) {
  if (typeof value === "string" && /^(?:0|[1-9]\d*)$/.test(value.trim())) {
    value = Number(value);
  }
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function creditHeaders(headers) {
  const credits = {};
  for (const [header, field] of [
    ["api-credits-used", "used"],
    ["api-credits-left", "left"],
    ["api-credits-request", "request"],
  ]) {
    const value = nonnegativeInteger(headers?.get?.(header));
    if (value !== null) credits[field] = value;
  }
  return credits;
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "private, no-store, max-age=0");

  if (!isAuthenticated(req)) {
    return res.status(401).json({ error: "Du måste vara inloggad." });
  }
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const apiKey = process.env.TWELVE_DATA_API_KEY;
  if (!apiKey) {
    return res.status(503).json({ error: "Twelve Data är inte konfigurerat." });
  }

  try {
    const response = await fetch("https://api.twelvedata.com/api_usage?format=JSON&timezone=UTC", {
      method: "GET",
      headers: { Accept: "application/json", Authorization: `apikey ${apiKey}` },
      cache: "no-store",
      signal: AbortSignal.timeout(10000),
    });
    const credits = creditHeaders(response.headers);
    const data = await readProviderJson(response);

    if (!response.ok || (data?.status !== undefined && data.status !== "ok")) {
      const limited = response.status === 429 || Number(data?.code) === 429;
      return res.status(limited ? 429 : 502).json({
        error: limited ? "Twelve Datas kreditgräns är nådd." : "Kunde inte läsa Twelve Datas kreditanvändning.",
        credits,
      });
    }

    if (!data || typeof data !== "object" || Array.isArray(data)) {
      return res.status(502).json({ error: "Twelve Data returnerade ett ogiltigt användningssvar." });
    }

    const currentUsage = nonnegativeInteger(data.current_usage);
    const planLimit = nonnegativeInteger(data.plan_limit);
    if (currentUsage === null || planLimit === null) {
      return res.status(502).json({ error: "Twelve Data returnerade ett ogiltigt användningssvar." });
    }

    const result = {
      source: "twelve_data",
      fetched_at: new Date().toISOString(),
      current_usage: currentUsage,
      plan_limit: planLimit,
      credits,
    };
    if (typeof data.plan_category === "string" &&
        /^[A-Za-z0-9][A-Za-z0-9 +._-]{0,63}$/.test(data.plan_category)) {
      result.plan_category = data.plan_category;
    }
    for (const field of ["daily_usage", "plan_daily_limit"]) {
      const value = nonnegativeInteger(data[field]);
      if (value !== null) result[field] = value;
    }
    return res.status(200).json(result);
  } catch (error) {
    const timeout = isTimeoutError(error);
    return res.status(timeout ? 504 : 502).json({
      error: timeout ? "Twelve Data svarade inte inom 10 sekunder." : "Kunde inte läsa Twelve Datas kreditanvändning.",
    });
  }
}
