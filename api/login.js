import crypto from "crypto";

function safeEqual(a, b) {
  const aBuffer = Buffer.from(String(a));
  const bBuffer = Buffer.from(String(b));

  if (aBuffer.length !== bBuffer.length) {
    return false;
  }

  return crypto.timingSafeEqual(aBuffer, bBuffer);
}

function createSessionToken(secret) {
  const payload = {
    exp: Date.now() + 1000 * 60 * 60 * 24 * 7,
    nonce: crypto.randomBytes(16).toString("hex"),
  };

  const encodedPayload = Buffer.from(
    JSON.stringify(payload)
  ).toString("base64url");

  const signature = crypto
    .createHmac("sha256", secret)
    .update(encodedPayload)
    .digest("base64url");

  return `${encodedPayload}.${signature}`;
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({
      error: "Method not allowed",
    });
  }

  const loginPassword = process.env.APP_LOGIN_PASSWORD;

  if (!loginPassword) {
    return res.status(500).json({
      error: "Login är inte konfigurerat på servern",
    });
  }

  try {
    const body =
      typeof req.body === "string"
        ? JSON.parse(req.body)
        : req.body || {};

    const password = body.password;

    if (!password) {
      return res.status(400).json({
        error: "Lösenord saknas",
      });
    }

    if (!safeEqual(password, loginPassword)) {
      return res.status(401).json({
        error: "Fel lösenord",
      });
    }

    const token = createSessionToken(loginPassword);

    res.setHeader(
      "Set-Cookie",
      `chatten_pro_session=${token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=604800`
    );

    return res.status(200).json({
      success: true,
      message: "Inloggning lyckades",
    });
  } catch (error) {
    console.error("Login error:", error);

    return res.status(500).json({
      error: "Serverfel",
      message: error.message,
    });
  }
}
