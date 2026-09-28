import crypto from "crypto";
import { isTimeoutError } from "./_provider-response.js";
import { entryFeesForTrade, hasRiskSideStop, tradeNumber, validateRealTradeRecord } from "./_trade-validation.js";

function getCookies(req) {
  const cookieHeader = req.headers.cookie || "";

  return cookieHeader.split(";").reduce((cookies, cookie) => {
    const separatorIndex = cookie.indexOf("=");

    if (separatorIndex === -1) return cookies;

    const key = cookie.slice(0, separatorIndex).trim();
    const value = cookie.slice(separatorIndex + 1).trim();

    cookies[key] = value;

    return cookies;
  }, {});
}

function verifySessionToken(token, secret) {
  if (!token || !secret) {
    return false;
  }

  try {
    const parts = token.split(".");

    if (parts.length !== 2) {
      return false;
    }

    const [encodedPayload, receivedSignature] = parts;

    const expectedSignature = crypto
      .createHmac("sha256", secret)
      .update(encodedPayload)
      .digest("base64url");

    const receivedBuffer = Buffer.from(receivedSignature);
    const expectedBuffer = Buffer.from(expectedSignature);

    if (receivedBuffer.length !== expectedBuffer.length) {
      return false;
    }

    const validSignature = crypto.timingSafeEqual(
      receivedBuffer,
      expectedBuffer
    );

    if (!validSignature) {
      return false;
    }

    const payload = JSON.parse(
      Buffer.from(encodedPayload, "base64url").toString("utf8")
    );

    if (!payload.exp || Date.now() > payload.exp) {
      return false;
    }

    return true;
  } catch {
    return false;
  }
}

export default async function handler(req, res) {
  const loginPassword = process.env.APP_LOGIN_PASSWORD;

  if (!loginPassword) {
    return res.status(500).json({
      error: "Login är inte konfigurerat på servern",
    });
  }

  // ---------------------------------
  // KONTROLLERA INLOGGNING
  // ---------------------------------

  const cookies = getCookies(req);
  const sessionToken = cookies.chatten_pro_session;

  if (!verifySessionToken(sessionToken, loginPassword)) {
    return res.status(401).json({
      error: "Unauthorized",
      message: "Du måste vara inloggad.",
    });
  }

  // Preview deployments may inherit production credentials. Never write by default.
  if (["POST", "PATCH"].includes(req.method) && process.env.VERCEL_ENV === "preview" && process.env.PREVIEW_ALLOW_WRITES !== "true") {
    return res.status(409).json({
      error: "Sparande är avstängt i testmiljön",
      message: "Aktivera endast PREVIEW_ALLOW_WRITES med en separat testdatabas.",
    });
  }

  const supabaseUrl = process.env.SUPABASE_URL?.replace(/\/+$/, "");
  const supabaseSecretKey = process.env.SUPABASE_SECRET_KEY;

  if (!supabaseUrl || !supabaseSecretKey) {
    return res.status(500).json({
      error: "Supabase är inte konfigurerat på servern",
    });
  }

  const headers = {
    apikey: supabaseSecretKey,
    "Content-Type": "application/json",
  };
  // New secret keys are not JWTs. Legacy service_role keys still use Bearer.
  if (!supabaseSecretKey.startsWith("sb_secret_")) {
    headers.Authorization = `Bearer ${supabaseSecretKey}`;
  }

  try {
    // ---------------------------------
    // POST = SPARA NY TRADE
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

      const validationErrors = validateRealTradeRecord(trade);
      if (validationErrors.length) {
        return res.status(400).json({ error: "Ogiltig verklig trade", details: validationErrors });
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
          signal: AbortSignal.timeout(12000),
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

    // PATCH = close an explicitly logged real trade and calculate its outcome server-side.
    if (req.method === "PATCH") {
      const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body || {};
      const tradeId = String(body.trade_id || "").trim();
      const exitPrice = tradeNumber(body.exit_price);
      const fees = body.fees === undefined ? 0 : tradeNumber(body.fees);
      const allowedReasons = ["TARGET", "STOP_LOSS", "MANUAL", "TIME_EXIT", "SIGNAL_REVERSAL", "END_OF_DAY", "OTHER"];
      if (!tradeId || tradeId.length > 150 || !Number.isFinite(exitPrice) || exitPrice <= 0 || !Number.isFinite(fees) || fees < 0 || !allowedReasons.includes(body.exit_reason)) {
        return res.status(400).json({ error: "Ange trade-ID, giltigt slutpris, icke-negativa avgifter och en giltig avslutsorsak." });
      }

      const lookup = new URLSearchParams({ select: "*", trade_id: `eq.${tradeId}`, limit: "1" });
      const existingResponse = await fetch(`${supabaseUrl}/rest/v1/trades?${lookup}`, { headers, signal: AbortSignal.timeout(12000) });
      const existingData = await existingResponse.json();
      if (!existingResponse.ok) {
        console.error("Supabase trade lookup error:", existingData);
        return res.status(existingResponse.status).json({ error: "Kunde inte hitta journalposten", details: existingData });
      }
      const existing = Array.isArray(existingData) ? existingData[0] : null;
      if (!existing || existing.trade_status !== "OPEN" || existing.signal_inputs?.record_type !== "REAL_TRADE") {
        return res.status(409).json({ error: "Endast en öppen, manuellt registrerad verklig trade kan stängas." });
      }
      const entry = tradeNumber(existing.entry_price);
      const size = tradeNumber(existing.position_size);
      const side = existing.direction === "LONG" ? 1 : existing.direction === "SHORT" ? -1 : 0;
      if (!Number.isFinite(entry) || entry <= 0 || !Number.isFinite(size) || size <= 0 || !Number.isFinite(entry * size) || entry * size <= 0 || !side) {
        return res.status(409).json({ error: "Journalposten saknar giltigt ingångspris, riktning eller positionsstorlek." });
      }
      const entryFees = entryFeesForTrade(existing);
      if (!Number.isFinite(entryFees) || entryFees < 0) {
        return res.status(409).json({ error: "Journalposten har ogiltiga ingångsavgifter. Rätta posten innan den stängs." });
      }
      const stop = existing.stop_loss == null ? null : tradeNumber(existing.stop_loss);
      if (stop !== null && !hasRiskSideStop(existing.direction, entry, stop)) {
        return res.status(409).json({ error: "Journalpostens stop måste ligga på risksidan om ingången för att beräkna resultat i R." });
      }
      const grossPnl = (exitPrice - entry) * side * size;
      const riskAmount = stop === null ? null : Math.abs(entry - stop) * size;
      const totalFees = entryFees + fees;
      const rawNetPnl = grossPnl - totalFees;
      const rawResultPercent = rawNetPnl / (entry * size) * 100;
      const rawResultR = riskAmount === null ? null : rawNetPnl / riskAmount;
      if (![grossPnl, totalFees, rawNetPnl, rawResultPercent].every(Number.isFinite) || (riskAmount !== null && (!Number.isFinite(riskAmount) || riskAmount <= 0 || !Number.isFinite(rawResultR)))) {
        return res.status(400).json({ error: "Beloppen är för stora för att beräkna ett giltigt tradeutfall." });
      }
      const netPnl = Number(rawNetPnl.toFixed(8));
      const resultPercent = Number(rawResultPercent.toFixed(8));
      const signalInputs = { ...existing.signal_inputs, closed_at: new Date().toISOString(), actual_exit_fees: fees, total_actual_fees: totalFees, gross_pnl: grossPnl, net_pnl: netPnl };
      const update = {
        trade_status: "CLOSED", exit_price: exitPrice, exit_reason: body.exit_reason,
        result_percent: resultPercent,
        result_r: rawResultR === null ? null : Number(rawResultR.toFixed(8)),
        winner: Math.abs(netPnl) < 1e-8 ? null : netPnl > 0, signal_inputs: signalInputs,
      };
      if (typeof body.post_trade_analysis === "string") update.post_trade_analysis = body.post_trade_analysis.slice(0, 2000);
      const updateQuery = new URLSearchParams({ trade_id: `eq.${tradeId}`, trade_status: "eq.OPEN" });
      const updateResponse = await fetch(`${supabaseUrl}/rest/v1/trades?${updateQuery}`, {
        method: "PATCH", headers: { ...headers, Prefer: "return=representation" }, body: JSON.stringify(update), signal: AbortSignal.timeout(12000),
      });
      const updatedData = await updateResponse.json();
      if (!updateResponse.ok) {
        console.error("Supabase trade close error:", updatedData);
        return res.status(updateResponse.status).json({ error: "Kunde inte stänga journalposten", details: updatedData });
      }
      if (!Array.isArray(updatedData) || updatedData.length !== 1) return res.status(409).json({ error: "Journalposten ändrades redan eller kunde inte uppdateras." });
      return res.status(200).json({ success: true, trade: updatedData[0] });
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
          signal: AbortSignal.timeout(12000),
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

    return res.status(isTimeoutError(error) ? 504 : 502).json({
      error: isTimeoutError(error) ? "Tidsgränsen för journalen överskreds." : "Kunde inte slutföra journalförfrågan",
      message: isTimeoutError(error) ? "Supabase svarade inte inom 12 sekunder." : error.message,
    });
  }
}
