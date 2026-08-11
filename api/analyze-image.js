export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const { imageBase64, imageMediaType } = req.body || {};

    if (!imageBase64 || !imageMediaType) {
      return res.status(400).json({ error: "Bild saknas" });
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
9. Uppskatta sannolikheten att kursen står högre efter den korta horisont grafen antyder.

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
}`
              }
            ]
          }
        ]
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

    return res.status(200).json(analysis);
  } catch (error) {
    console.error(error);

    return res.status(500).json({
      error: "Kunde inte analysera bilden",
      message: error.message,
    });
  }
}
