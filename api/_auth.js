import crypto from "crypto";

export function getCookies(req) {
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

export function verifySessionToken(token, secret) {
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

export function isAuthenticated(req) {
  const loginPassword = process.env.APP_LOGIN_PASSWORD;

  if (!loginPassword) {
    return false;
  }

  const cookies = getCookies(req);

  return verifySessionToken(
    cookies.chatten_pro_session,
    loginPassword
  );
}
