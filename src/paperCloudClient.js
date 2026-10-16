import { createClient } from "@supabase/supabase-js";
import { createPaperCloudRepository } from "./paperCloudRepository.js";

const disabled = (code, reason) => ({ enabled: false, code, reason });

function projectUrl(value) {
  try {
    const url = new URL(value);
    const local = ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
    if ((url.protocol !== "https:" && !(local && url.protocol === "http:")) ||
        url.username || url.password || url.search || url.hash || url.pathname !== "/") return null;
    return url.origin;
  } catch {
    return null;
  }
}

export function resolvePaperCloudConfig(env = import.meta.env) {
  if (env?.VITE_PAPER_CLOUD_ENABLED !== "true") {
    return disabled("PAPER_CLOUD_DISABLED", "Molnsynkning för paperloggen är avstängd.");
  }

  const url = projectUrl(env?.VITE_PAPER_SUPABASE_URL);
  const publishableKey = env?.VITE_PAPER_SUPABASE_PUBLISHABLE_KEY;
  if (!url || typeof publishableKey !== "string" || !/^sb_publishable_[A-Za-z0-9_-]+$/.test(publishableKey)) {
    return disabled("PAPER_CLOUD_MISCONFIGURED", "Molnsynkning kräver en giltig Supabase-URL och en publishable-nyckel.");
  }
  return { enabled: true, url, publishableKey };
}

export function paperAuthRedirectError(location = globalThis.location) {
  const hash = new URLSearchParams(location?.hash?.replace(/^#/, "") || "");
  const query = new URLSearchParams(location?.search?.replace(/^\?/, "") || "");
  const params = hash.has("error") || hash.has("error_code") ? hash : query;
  if (!params.has("error") && !params.has("error_code")) return "";
  if (params.get("error_code") === "otp_expired") {
    return "Bekräftelselänken är ogiltig eller har gått ut. Ange din e-postadress och välj Skicka ny bekräftelselänk.";
  }
  return "Bekräftelselänken kunde inte användas. Ange din e-postadress och välj Skicka ny bekräftelselänk.";
}

/** Optional personal Auth client. It never receives the server's secret key. */
export function createPaperCloudClient({
  env = import.meta.env,
  clientFactory = createClient,
  origin = globalThis.location?.origin,
} = {}) {
  const config = resolvePaperCloudConfig(env);
  if (!config.enabled) return config;

  const client = clientFactory(config.url, config.publishableKey, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
  });
  const paper = createPaperCloudRepository(client);
  function confirmationRedirect() {
    if (!origin) throw new Error("Sidans adress saknas för verifieringslänken.");
    return new URL("/", origin).href;
  }

  return {
    enabled: true,
    async signUp(email, password) {
      return client.auth.signUp({ email, password, options: { emailRedirectTo: confirmationRedirect() } });
    },
    async resendSignupConfirmation(email) {
      return client.auth.resend({ type: "signup", email, options: { emailRedirectTo: confirmationRedirect() } });
    },
    signIn(email, password) {
      return client.auth.signInWithPassword({ email, password });
    },
    signOut() {
      return client.auth.signOut();
    },
    getSession() {
      return client.auth.getSession();
    },
    getUser() {
      return client.auth.getUser();
    },
    onAuthStateChange(callback) {
      return client.auth.onAuthStateChange(callback);
    },
    listObservations: paper.listObservations,
    ensureCapture: paper.ensureCapture,
    advanceObservation: paper.advanceObservation,
  };
}
