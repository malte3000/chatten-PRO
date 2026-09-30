export async function fetchJson(url, options = {}) {
  const response = await fetch(url, { credentials: "include", ...options });
  const body = await response.text();
  let data = null;
  if (body) {
    try { data = JSON.parse(body); } catch { /* Some deployment errors are HTML, not JSON. */ }
  }
  if (!response.ok) {
    const message = data?.message || data?.details?.message || data?.details?.error?.message || data?.error;
    const error = new Error(typeof message === "string" && message.trim()
      ? message.trim()
      : `Servern svarade med HTTP ${response.status} utan ett läsbart API-fel. Kontrollera deployment- och funktionsloggarna.`);
    error.status = response.status;
    error.code = data?.code;
    error.retryMs = data?.retry_after_ms;
    throw error;
  }
  if (!data || typeof data !== "object") {
    throw new Error(`Servern returnerade inte giltig JSON (HTTP ${response.status}). Kontrollera att API-funktionen är driftsatt.`);
  }
  return data;
}
