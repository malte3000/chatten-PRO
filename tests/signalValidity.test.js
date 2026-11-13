import test from "node:test";
import assert from "node:assert/strict";
import { swingSignalValidity } from "../src/signalValidity.js";

test("a US swing signal remains current through the next session, then expires at its close", () => {
  const signalDate = "2026-09-28";
  const check = (time) => swingSignalValidity({ market: "usa", signalDate, now: Date.parse(time) });
  assert.deepEqual({ status: check("2026-09-28T20:01:00Z").status, expiry: check("2026-09-28T20:01:00Z").expirySession, close: check("2026-09-28T20:01:00Z").expiryLocalClose },
    { status: "CURRENT", expiry: "2026-09-29", close: "16:00" });
  assert.equal(check("2026-09-29T19:59:00Z").status, "CURRENT");
  assert.equal(check("2026-09-29T20:00:00Z").status, "EXPIRED");
});

test("holiday and early close move the signal deadline to the next actual session", () => {
  const check = (time) => swingSignalValidity({ market: "usa", signalDate: "2026-11-25", now: Date.parse(time) });
  assert.equal(check("2026-11-26T20:00:00Z").status, "CURRENT", "Thanksgiving does not end the signal");
  assert.equal(check("2026-11-27T17:59:00Z").status, "CURRENT");
  assert.deepEqual({ status: check("2026-11-27T18:00:00Z").status, expiry: check("2026-11-27T18:00:00Z").expirySession, close: check("2026-11-27T18:00:00Z").expiryLocalClose },
    { status: "EXPIRED", expiry: "2026-11-27", close: "13:00" });
});

test("Stockholm signal stays current over Christmas and expires at the next close", () => {
  const check = (time) => swingSignalValidity({ market: "stockholm", signalDate: "2026-12-23", now: Date.parse(time) });
  assert.equal(check("2026-12-27T20:00:00Z").status, "CURRENT");
  assert.equal(check("2026-12-28T16:29:00Z").status, "CURRENT");
  assert.equal(check("2026-12-28T16:30:00Z").status, "EXPIRED");
  assert.equal(check("2026-12-23T17:00:00Z").expirySession, "2026-12-28");
});

test("missing, future and non-session dates cannot appear as current TRADE signals", () => {
  const now = Date.parse("2026-09-29T15:00:00Z");
  for (const signalDate of [undefined, "2026-02-30", "2026-09-27", "2026-09-29"]) {
    assert.equal(swingSignalValidity({ market: "usa", signalDate, now }).status, "UNVERIFIED");
  }
  assert.equal(swingSignalValidity({ market: "off", signalDate: "2026-09-28", now }).status, "UNVERIFIED");
});
