export async function readProviderJson(response) {
  try {
    return await response.json();
  } catch (error) {
    if (isTimeoutError(error)) throw error;
    return null;
  }
}

export function providerErrorMessage(data, fallback) {
  const message = data?.message ?? data?.error?.message ?? data?.error;
  return typeof message === "string" && message.trim() ? message.trim() : fallback;
}

export function isTimeoutError(error) {
  return error?.name === "TimeoutError" || error?.name === "AbortError";
}
