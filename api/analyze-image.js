import { isAuthenticated } from "./_auth.js";
import { getMarketStatus } from "./_market-hours.js";
import { isTimeoutError, providerErrorMessage, readProviderJson } from "./_provider-response.js";

const ALLOWED_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);
const MAX_IMAGE_BYTES = 3 * 1024 * 1024;
const MAX_BASE64_LENGTH = 4 * Math.ceil(MAX_IMAGE_BYTES / 3);
const BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/;
const nullableString = (value) => value === null || typeof value === "string";
const finiteNumber = (value) => typeof value === "number" && Number.isFinite(value);
const percentage = (value) => finiteNumber(value) && value >= 0 && value <= 100;

function validChartAnalysis(analysis) {
  return analysis && !Array.isArray(analysis) &&
    ["candlestick", "line", "other", "unclear"].includes(analysis.chart_type) &&
    (analysis.price_detected === null || (finiteNumber(analysis.price_detected) && analysis.price_detected > 0)) &&
    typeof analysis.premarket_detected === "boolean" &&
    (analysis.premarket_move_pct === null || finiteNumber(analysis.premarket_move_pct)) &&
    nullableString(analysis.premarket_notes) &&
    finiteNumber(analysis.volatility_estimate) && analysis.volatility_estimate >= 0 &&
    finiteNumber(analysis.drift_estimate) &&
    ["bullish", "bearish", "neutral", "unclear"].includes(analysis.trend) &&
    percentage(analysis.confidence) && typeof analysis.reasoning === "string" &&
    nullableString(analysis.candlestick_pattern) && nullableString(analysis.candlestick_reasoning) &&
    ["accumulation", "manipulation", "distribution", "unclear"].includes(analysis.amd_phase) &&
    (analysis.amd_confidence === null || percentage(analysis.amd_confidence)) &&
    typeof analysis.amd_reasoning === "string" && typeof analysis.commentary === "string";
}

export default async function handler(req, res) {
    if (!isAuthenticated(req)) {
    return res.status(401).json({
      error: "Unauthorized",
      message: "Du måste vara inloggad.",
    });
  }
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const {
  imageBase64,
  imageMediaType,
  ticker = "",
  market = "stockholm",
} = req.body || {};

    if (!imageBase64 || !imageMediaType) {
      return res.status(400).json({ error: "Bild saknas" });
    }

    if (typeof imageBase64 !== "string" || !ALLOWED_IMAGE_TYPES.has(imageMediaType) || typeof ticker !== "string") {
      return res.status(400).json({ error: "Välj en bild i JPEG-, PNG-, WebP- eller GIF-format och en giltig ticker." });
    }
    if (imageBase64.length > MAX_BASE64_LENGTH) {
      return res.status(413).json({ error: "Bilden får vara högst 3 MB." });
    }
    if (imageBase64.length % 4 !== 0 || !BASE64_PATTERN.test(imageBase64)) {
      return res.status(400).json({ error: "Bildens base64-data är ogiltig." });
    }
    if (Buffer.byteLength(imageBase64, "base64") > MAX_IMAGE_BYTES) {
      return res.status(413).json({ error: "Bilden får vara högst 3 MB." });
    }

    const marketStatus = getMarketStatus(market);
    if (!marketStatus.isOpen) {
      return res.status(423).json({ error: "MARKET_CLOSED", message: `${marketStatus.label} är stängd. AI-analysen kördes inte.`, marketStatus });
    }

    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      return res.status(500).json({ error: "ANTHROPIC_API_KEY saknas på servern." });
    }

    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 1200,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "image",
                source: {
                  type: "base64",
                  media_type: imageMediaType,
                  data: imageBase64,
                },
              },
              {
                type: "text",
                text: `Du analyserar en bild av en aktiekursgraf för daytrading.

Aktie/ticker: ${ticker.trim() || "okänd"}.
Använd tickern som kontext, men hitta inte på information som inte syns i grafen.

Gör följande:

1. Identifiera graftyp: candlestick, linje eller annat.
2. Läs endast av siffror och information som faktiskt syns. Gissa inte.
3. Identifiera nuvarande/senaste pris om det går.
4. Bedöm volatilitet baserat primärt på ordinarie handel.
5. Bedöm kortsiktig trend och momentum.
6. Om candlestick-graf: analysera de senaste candlarna och identifiera tydliga candlestick-mönster.
7. Identifiera eventuell pre-market/after-hours separat.
8. Gör separat en försiktig AMD-bedömning:
   accumulation, manipulation, distribution eller unclear.
9. Gör en försiktig riktningsbedömning för den korta horisont grafen antyder. Confidence är säkerhet i bedömningen, inte en statistiskt kalibrerad sannolikhet.

Var konservativ. Teknisk analys och grafmönster har begränsad prediktiv kraft.

Svara ENDAST med ett giltigt JSON-objekt i exakt följande format:

{
  "chart_type": "candlestick",
  "price_detected": null,
  "premarket_detected": false,
  "premarket_move_pct": null,
  "premarket_notes": null,
  "volatility_estimate": 35,
  "drift_estimate": 0,
  "trend": "neutral",
  "confidence": 50,
  "reasoning": "",
  "candlestick_pattern": null,
  "candlestick_reasoning": null,
  "amd_phase": "unclear",
  "amd_confidence": null,
  "amd_reasoning": "",
  "commentary": ""
}

Tillåtna chart_type: candlestick, line, other, unclear.
Tillåtna trend: bullish, bearish, neutral, unclear.
Tillåtna amd_phase: accumulation, manipulation, distribution, unclear.
confidence och amd_confidence ska ligga mellan 0 och 100. amd_confidence får vara null.
price_detected ska vara ett positivt tal eller null. volatility_estimate ska vara ett icke-negativt tal. drift_estimate och premarket_move_pct ska vara tal; premarket_move_pct får vara null.
När uppgifter inte syns, använd null för de nullable fälten och unclear för otydliga klassificeringar.`
              }
            ]
          }
        ]
      }),
      signal: AbortSignal.timeout(50000),
    });

    const data = await readProviderJson(response);

    if (!response.ok || !data) {
      console.error("Anthropic error:", data);
      return res.status(response.ok ? 502 : response.status).json({
        error: "Anthropic API error",
        message: providerErrorMessage(data, response.ok ? "Anthropic returnerade ett ogiltigt svar." : "Anthropic kunde inte slutföra förfrågan."),
      });
    }

    if (data.stop_reason !== "end_turn") {
      return res.status(502).json({ error: "Grafanalysen blev inte komplett. Ingen signal skapades." });
    }

    const textBlock = (data.content || []).find(
      (block) => block.type === "text"
    );

    if (!textBlock) {
      return res.status(500).json({
        error: "Inget textsvar från modellen",
      });
    }

    const clean = textBlock.text
      .replace(/```json/gi, "")
      .replace(/```/g, "")
      .trim();

    const analysis = JSON.parse(clean);

    if (!validChartAnalysis(analysis)) {
      return res.status(502).json({ error: "Grafanalysens format är ogiltigt. Ingen signal skapades." });
    }

    return res.status(200).json({
  ...analysis,
  ticker: ticker.trim().toUpperCase() || null,
});
  } catch (error) {
    console.error(error);

    return res.status(isTimeoutError(error) ? 504 : 502).json({
      error: isTimeoutError(error) ? "Tidsgränsen för grafanalysen överskreds." : "Kunde inte analysera bilden",
      message: isTimeoutError(error) ? "Anthropic svarade inte inom 50 sekunder." : error.message,
    });
  }
}

