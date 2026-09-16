import { isAuthenticated } from "./_auth.js";
import { getMarketStatus } from "./_market-hours.js";

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
    const { ticker, companyName = "", exchange = "", horizonText, market = "stockholm" } = req.body || {};

    if (!ticker || !ticker.trim()) {
      return res.status(400).json({
        error: "Ticker eller bolagsnamn saknas",
      });
    }

    const marketStatus = getMarketStatus(market);
    // News remains relevant outside exchange hours. No trade approval here.

    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },

      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 1500,

        tools: [
          {
            type: "web_search_20250305",
            name: "web_search",
          },
        ],

        messages: [
          {
            role: "user",

            content: `
Analysera färska nyheter för aktien eller bolaget "${ticker}".
Bolagskontext: ${String(companyName).slice(0, 160)}. Börs: ${String(exchange).slice(0, 60)}.
Om bolaget inte kan identifieras säkert: direction = "oklart". Blanda inte ihop bolag som har liknande tickers.

Användaren analyserar en möjlig aktieposition med en hållperiod på ungefär ${
              horizonText || "samma handelsdag"
            }.

Sök efter aktuella:

- bolagsnyheter
- kvartalsrapporter
- guidance
- kontrakt
- regulatoriska beslut
- analytikerändringar
- produktnyheter
- rättsprocesser
- andra konkreta händelser som rimligen kan påverka aktiekursen kortsiktigt.

Fokusera främst på bolagsspecifika nyheter.

Allmänt marknadssentiment får bara användas som sekundär information.

Eftersom detta kan användas för hävstångscertifikat är det viktigare att bedöma hur tydlig riktningen är än att gissa en stor procentuell rörelse.

Var konservativ.

Om nyhetsläget är svagt, gammalt, motstridigt eller saknar tydlig kortsiktig effekt ska riktningen vara "oklart" och confidence vara låg.

Svara ENDAST med ett giltigt JSON-objekt.

Exakt format:

{
  "direction": "upp",
  "direction_confidence": 50,
  "probability_up": null,
  "summary": "Kort sammanfattning på högst två meningar",
  "magnitude_note": "",
  "key_news": [
    {
      "headline": "",
      "impact": "neutral"
    }
  ],
  "reasoning": ""
}

Tillåtna värden:

direction:
"upp"
"ner"
"oklart"

impact:
"positiv"
"negativ"
"neutral"

direction_confidence ska vara ett heltal mellan 0 och 100: säkerhet i riktningsbedömningen, INTE sannolikhet för uppgång.
probability_up ska vara null. Ingen statistiskt kalibrerad sannolikhetsmodell finns här.

Skriv all text på svenska.
`,
          },
        ],
      }),
    });

    const data = await response.json();

    if (!response.ok) {
      console.error("Anthropic error:", data);

      return res.status(response.status).json({
        error: "Anthropic API error",
        details: data,
      });
    }

    if (data.stop_reason === "pause_turn" || data.stop_reason === "max_tokens") {
      return res.status(502).json({ error: "Nyhetsanalysen blev inte komplett. Ingen signal skapades." });
    }

    const textBlocks = (data.content || [])
      .filter((block) => block.type === "text")
      .map((block) => block.text);

    if (textBlocks.length === 0) {
      return res.status(500).json({
        error: "Inget textsvar från modellen",
      });
    }

    const text = textBlocks[textBlocks.length - 1];

    const clean = text
      .replace(/```json/gi, "")
      .replace(/```/g, "")
      .trim();

    const analysis = JSON.parse(clean);

    if (!analysis || !["upp", "ner", "oklart"].includes(analysis.direction) ||
        !Number.isInteger(analysis.direction_confidence) || analysis.direction_confidence < 0 || analysis.direction_confidence > 100 ||
        typeof analysis.summary !== "string" || typeof analysis.reasoning !== "string" ||
        !Array.isArray(analysis.key_news) || !analysis.key_news.every((item) =>
          item && typeof item.headline === "string" && ["positiv", "negativ", "neutral"].includes(item.impact))) {
      return res.status(502).json({ error: "Nyhetsanalysens format är ogiltigt. Ingen signal skapades." });
    }

    return res.status(200).json({ ...analysis, ticker: ticker.trim().toUpperCase(), probability_up: null, marketStatus });
  } catch (error) {
    console.error(error);

    return res.status(500).json({
      error: "Kunde inte analysera nyheterna",
      message: error.message,
    });
  }
}

