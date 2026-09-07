export default async function handler(req, res) {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseSecretKey = process.env.SUPABASE_SECRET_KEY;

  if (!supabaseUrl || !supabaseSecretKey) {
    return res.status(500).json({
      error: "Supabase är inte konfigurerat på servern",
    });
  }

  const headers = {
    apikey: supabaseSecretKey,
    Authorization: `Bearer ${supabaseSecretKey}`,
    "Content-Type": "application/json",
  };

  try {
    // ---------------------------------
    // POST = SPARA EN NY TRADE
    // ---------------------------------
    if (req.method === "POST") {
      const trade =
        typeof req.body === "string"
          ? JSON.parse(req.body)
          : req.body || {};

      const requiredFields = [
        "trade_id",
        "strategy_version",
        "ticker",
        "timestamp",
        "signal",
        "direction",
        "confidence",
      ];

      const missingFields = requiredFields.filter(
        (field) =>
          trade[field] === undefined ||
          trade[field] === null ||
          trade[field] === ""
      );

      if (missingFields.length > 0) {
        return res.status(400).json({
          error: "Obligatoriska fält saknas",
          missing_fields: missingFields,
        });
      }

      const response = await fetch(
        `${supabaseUrl}/rest/v1/trades`,
        {
          method: "POST",
          headers: {
            ...headers,
            Prefer: "return=representation",
          },
          body: JSON.stringify(trade),
        }
      );

      const data = await response.json();

      if (!response.ok) {
        console.error("Supabase insert error:", data);

        return res.status(response.status).json({
          error: "Kunde inte spara traden",
          details: data,
        });
      }

      return res.status(201).json({
        success: true,
        trade: data[0] || data,
      });
    }

    // ---------------------------------
    // GET = HÄMTA SENASTE TRADES
    // ---------------------------------
    if (req.method === "GET") {
      const response = await fetch(
        `${supabaseUrl}/rest/v1/trades?select=*&order=timestamp.desc&limit=100`,
        {
          method: "GET",
          headers,
        }
      );

      const data = await response.json();

      if (!response.ok) {
        console.error("Supabase read error:", data);

        return res.status(response.status).json({
          error: "Kunde inte hämta trades",
          details: data,
        });
      }

      return res.status(200).json({
        success: true,
        trades: data,
      });
    }

    return res.status(405).json({
      error: "Method not allowed",
    });
  } catch (error) {
    console.error("Trades API error:", error);

    return res.status(500).json({
      error: "Serverfel",
      message: error.message,
    });
  }
}
