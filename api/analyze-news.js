export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const { ticker, horizonText } = req.body || {};

    if (!ticker || !ticker.trim()) {
      return res.status(400).json({
        error: "Ticker eller bolagsnamn saknas",
      });
    }

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

Användaren funderar på en DAYTRADE med en hållperiod på ungefär ${
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
  "confidence": 50,
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

confidence ska vara ett heltal mellan 0 och 100.

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

    return res.status(200).json(analysis);
  } catch (error) {
    console.error(error);

    return res.status(500).json({
      error: "Kunde inte analysera nyheterna",
      message: error.message,
    });
  }
}
