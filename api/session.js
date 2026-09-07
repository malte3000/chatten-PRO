import crypto from "crypto";

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

    if (!crypto.timingSafeEqual(receivedBuffer, expectedBuffer)) {
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
  if (req.method !== "GET") {
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

  const cookies = getCookies(req);
  const sessionToken = cookies.chatten_pro_session;

  const authenticated = verifySessionToken(
    sessionToken,
    loginPassword
  );

  return res.status(200).json({
    authenticated,
  });
}
