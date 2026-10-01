import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import handler from "../api/credit-usage.js";

function response() {
  return {
    code: 200,
    headers: {},
    setHeader(name, value) { this.headers[name] = value; },
    status(code) { this.code = code; return this; },
    json(data) { this.data = data; return this; },
  };
}

function setup(t) {
  const oldFetch = globalThis.fetch;
  const oldPassword = process.env.APP_LOGIN_PASSWORD;
  const oldKey = process.env.TWELVE_DATA_API_KEY;
  process.env.APP_LOGIN_PASSWORD = "test-only-password";
  process.env.TWELVE_DATA_API_KEY = "test-only-secret-key";
  t.after(() => {
    globalThis.fetch = oldFetch;
    if (oldPassword === undefined) delete process.env.APP_LOGIN_PASSWORD;
    else process.env.APP_LOGIN_PASSWORD = oldPassword;
    if (oldKey === undefined) delete process.env.TWELVE_DATA_API_KEY;
    else process.env.TWELVE_DATA_API_KEY = oldKey;
  });
  const payload = Buffer.from(JSON.stringify({ exp: Date.now() + 60000 })).toString("base64url");
  const signature = crypto.createHmac("sha256", process.env.APP_LOGIN_PASSWORD).update(payload).digest("base64url");
  return { cookie: `chatten_pro_session=${payload}.${signature}` };
}

test("credit usage requires a session and GET before spending a provider credit", async (t) => {
  const headers = setup(t);
  let calls = 0;
  globalThis.fetch = async () => { calls++; throw new Error("unexpected provider call"); };
  const unauthorized = response();
  await handler({ method: "GET", headers: {} }, unauthorized);
  assert.equal(unauthorized.code, 401);
  const wrongMethod = response();
  await handler({ method: "POST", headers }, wrongMethod);
  assert.equal(wrongMethod.code, 405);
  assert.equal(wrongMethod.headers.Allow, "GET");
  assert.equal(calls, 0);
  assert.match(unauthorized.headers["Cache-Control"], /no-store/);
  assert.match(wrongMethod.headers["Cache-Control"], /no-store/);
});

test("credit usage sends the configured key only in the provider authorization header and returns allowlisted fields", async (t) => {
  const headers = setup(t);
  let calls = 0;
  globalThis.fetch = async (url, options) => {
    calls++;
    assert.equal(url, "https://api.twelvedata.com/api_usage?format=JSON&timezone=UTC");
    assert.equal(options.method, "GET");
    assert.equal(options.cache, "no-store");
    assert.equal(options.headers.Authorization, "apikey test-only-secret-key");
    assert.equal(options.headers.Accept, "application/json");
    assert.ok(options.signal);
    return {
      ok: true,
      status: 200,
      headers: new Headers({
        "api-credits-used": "3",
        "api-credits-left": "5",
        "api-credits-request": "1",
        "x-secret": "do-not-return",
      }),
      json: async () => ({
        timestamp: "2026-10-01 12:00:00",
        current_usage: "3",
        plan_limit: 8,
        plan_category: "Basic",
        daily_usage: 201,
        plan_daily_limit: 800,
        api_key: "do-not-return",
        account: { email: "do-not-return@example.com" },
      }),
    };
  };
  const res = response();
  await handler({ method: "GET", headers }, res);
  assert.equal(res.code, 200);
  assert.equal(calls, 1);
  assert.match(res.headers["Cache-Control"], /no-store/);
  assert.equal(res.data.source, "twelve_data");
  assert.equal(res.data.current_usage, 3);
  assert.equal(res.data.plan_limit, 8);
  assert.equal(res.data.plan_category, "Basic");
  assert.equal(res.data.daily_usage, 201);
  assert.equal(res.data.plan_daily_limit, 800);
  assert.deepEqual(res.data.credits, { used: 3, left: 5, request: 1 });
  assert.ok(Number.isFinite(Date.parse(res.data.fetched_at)));
  assert.equal(JSON.stringify(res.data).includes("test-only-secret-key"), false);
  assert.equal(JSON.stringify(res.data).includes("do-not-return"), false);
  assert.equal(res.data.timestamp, undefined);
});

test("credit usage omits invalid optional fields and rejects malformed usage numbers", async (t) => {
  const headers = setup(t);
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    headers: new Headers({ "api-credits-used": "secret", "api-credits-left": "4" }),
    json: async () => ({ current_usage: 4, plan_limit: 8, daily_usage: -1, plan_category: "Basic\nsecret" }),
  });
  const optional = response();
  await handler({ method: "GET", headers }, optional);
  assert.equal(optional.code, 200);
  assert.deepEqual(optional.data.credits, { left: 4 });
  assert.equal(optional.data.daily_usage, undefined);
  assert.equal(optional.data.plan_category, undefined);

  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    headers: new Headers(),
    json: async () => ({ current_usage: "unknown", plan_limit: 8 }),
  });
  const invalid = response();
  await handler({ method: "GET", headers }, invalid);
  assert.equal(invalid.code, 502);
  assert.equal(invalid.data.current_usage, undefined);

  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    headers: new Headers(),
    json: async () => ({ status: "unexpected", current_usage: 4, plan_limit: 8 }),
  });
  const invalidStatus = response();
  await handler({ method: "GET", headers }, invalidStatus);
  assert.equal(invalidStatus.code, 502);
});

test("credit usage gives safe errors for provider limits, failures, invalid JSON, and timeout", async (t) => {
  const headers = setup(t);
  const cases = [
    [{ ok: false, status: 429, headers: new Headers({ "api-credits-left": "0" }), json: async () => ({ status: "error", code: 429, message: "test-only-secret-key" }) }, 429],
    [{ ok: false, status: 401, headers: new Headers(), json: async () => ({ status: "error", message: "test-only-secret-key" }) }, 502],
    [{ ok: true, status: 200, headers: new Headers(), json: async () => { throw new SyntaxError("test-only-secret-key"); } }, 502],
    [{ ok: true, status: 200, headers: new Headers(), json: async () => { throw new DOMException("body timed out", "TimeoutError"); } }, 504],
  ];
  for (const [providerResponse, status] of cases) {
    globalThis.fetch = async () => providerResponse;
    const res = response();
    await handler({ method: "GET", headers }, res);
    assert.equal(res.code, status);
    assert.equal(JSON.stringify(res.data).includes("test-only-secret-key"), false);
  }
  globalThis.fetch = async () => { throw new DOMException("test-only-secret-key", "TimeoutError"); };
  const timeout = response();
  await handler({ method: "GET", headers }, timeout);
  assert.equal(timeout.code, 504);
  assert.equal(JSON.stringify(timeout.data).includes("test-only-secret-key"), false);
});

test("credit usage does not call the provider when the server key is absent", async (t) => {
  const headers = setup(t);
  delete process.env.TWELVE_DATA_API_KEY;
  globalThis.fetch = async () => { throw new Error("unexpected provider call"); };
  const res = response();
  await handler({ method: "GET", headers }, res);
  assert.equal(res.code, 503);
});
