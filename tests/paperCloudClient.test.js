import test from "node:test";
import assert from "node:assert/strict";
import { createPaperCloudClient, resolvePaperCloudConfig } from "../src/paperCloudClient.js";

const configured = {
  VITE_PAPER_CLOUD_ENABLED: "true",
  VITE_PAPER_SUPABASE_URL: "https://paper.example.com/",
  VITE_PAPER_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_test_only",
};

test("paper cloud is opt-in and never constructs a client while disabled", () => {
  let created = false;
  const cloud = createPaperCloudClient({
    env: { ...configured, VITE_PAPER_CLOUD_ENABLED: "false" },
    clientFactory() { created = true; throw new Error("should not run"); },
  });
  assert.equal(cloud.enabled, false);
  assert.equal(cloud.code, "PAPER_CLOUD_DISABLED");
  assert.equal(created, false);
  assert.equal(resolvePaperCloudConfig({}).enabled, false);
});

test("paper cloud refuses missing, secret, and malformed browser configuration", () => {
  for (const env of [
    { ...configured, VITE_PAPER_SUPABASE_URL: "" },
    { ...configured, VITE_PAPER_SUPABASE_URL: "http://paper.example.com" },
    { ...configured, VITE_PAPER_SUPABASE_URL: "https://paper.example.com/path" },
    { ...configured, VITE_PAPER_SUPABASE_URL: "https://paper.example.com/?token=secret" },
    { ...configured, VITE_PAPER_SUPABASE_PUBLISHABLE_KEY: "sb_secret_do_not_expose" },
    { ...configured, VITE_PAPER_SUPABASE_PUBLISHABLE_KEY: "" },
  ]) {
    const result = resolvePaperCloudConfig(env);
    assert.equal(result.enabled, false);
    assert.equal(result.code, "PAPER_CLOUD_MISCONFIGURED");
    assert.equal(JSON.stringify(result).includes("sb_secret_"), false);
  }
  assert.equal(resolvePaperCloudConfig({ ...configured, VITE_PAPER_SUPABASE_URL: "http://localhost:54321/" }).enabled, true);
});

test("configured client forwards Auth calls and confirms email on the current origin", async () => {
  const calls = [];
  const callback = () => {};
  const subscription = { unsubscribe() {} };
  const response = { data: { user: { id: "user-1" } }, error: null };
  const cloud = createPaperCloudClient({
    env: configured,
    origin: "https://preview.example.com",
    clientFactory(url, key, options) {
      calls.push(["factory", url, key, options]);
      return { from() { throw new Error("paper table should not be accessed by Auth calls"); }, auth: {
        signUp: async (body) => { calls.push(["signUp", body]); return response; },
        signInWithPassword: async (body) => { calls.push(["signIn", body]); return response; },
        signOut: async () => { calls.push(["signOut"]); return response; },
        getSession: async () => { calls.push(["getSession"]); return response; },
        getUser: async () => { calls.push(["getUser"]); return response; },
        onAuthStateChange: (listener) => { calls.push(["onAuthStateChange", listener]); return { data: { subscription } }; },
      } };
    },
  });

  assert.equal(cloud.enabled, true);
  assert.equal(calls[0][1], "https://paper.example.com");
  assert.equal(calls[0][2], configured.VITE_PAPER_SUPABASE_PUBLISHABLE_KEY);
  assert.equal(calls[0][3].auth.persistSession, true);
  assert.deepEqual(await cloud.signUp("malte@example.com", "password"), response);
  assert.deepEqual(calls[1][1], { email: "malte@example.com", password: "password", options: { emailRedirectTo: "https://preview.example.com/" } });
  assert.deepEqual(await cloud.signIn("malte@example.com", "password"), response);
  assert.deepEqual(calls[2][1], { email: "malte@example.com", password: "password" });
  assert.deepEqual(await cloud.getSession(), response);
  assert.deepEqual(await cloud.getUser(), response);
  assert.deepEqual(await cloud.signOut(), response);
  assert.equal(cloud.onAuthStateChange(callback).data.subscription, subscription);
  assert.equal(calls.at(-1)[1], callback);
});

test("sign-up fails closed when there is no browser origin", async () => {
  let called = false;
  const cloud = createPaperCloudClient({
    env: configured,
    origin: "",
    clientFactory: () => ({ from() {}, auth: { getUser() {}, signUp() { called = true; } } }),
  });
  await assert.rejects(cloud.signUp("malte@example.com", "password"), /adress saknas/);
  assert.equal(called, false);
});
