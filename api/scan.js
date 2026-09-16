import { isAuthenticated } from "./_auth.js";
import { scanBatch } from "./_scan-provider.js";

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (!isAuthenticated(req)) return res.status(401).json({ error: "Du måste vara inloggad." });
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body || {};
    const { market, horizon, offset = 0, limit = 20, seed } = body;
    if (!["usa", "stockholm"].includes(market) || !["week", "day"].includes(horizon) ||
        !Number.isInteger(offset) || offset < 0 || offset > 100 || !Number.isInteger(limit) || limit < 1 || limit > 100 ||
        typeof seed !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(seed)) {
      return res.status(400).json({ error: "Ogiltiga skanningsinställningar. Välj USA/Sverige och högst 100 aktier." });
    }
    const result = await scanBatch({ market, horizon, offset, limit, seed });
    return res.status(200).json(result);
  } catch (error) {
    if (error.retryAfterMs) res.setHeader("Retry-After", String(Math.ceil(error.retryAfterMs / 1000)));
    return res.status(error.status || 502).json({ error: error.status ? error.message : "Skanningen misslyckades. Ingen trade godkändes.", retry_after_ms: error.retryAfterMs || 0 });
  }
}
