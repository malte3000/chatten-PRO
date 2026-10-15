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

  return {
    enabled: true,
    async signUp(email, password) {
      if (!origin) throw new Error("Sidans adress saknas för verifieringslänken.");
      const emailRedirectTo = new URL("/", origin).href;
      return client.auth.signUp({ email, password, options: { emailRedirectTo } });
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
