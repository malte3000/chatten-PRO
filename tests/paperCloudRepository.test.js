import test from "node:test";
import assert from "node:assert/strict";
import { getMarketStatus } from "../api/_market-hours.js";
import { assessSwingSetup } from "../src/strategyModel.js";
import { createPaperObservation, settlePaperObservation } from "../src/paperModel.js";
import { createPaperCloudRepository, PaperCloudConflictError } from "../src/paperCloudRepository.js";

const ownerId = "11111111-1111-4111-8111-111111111111";
const otherId = "22222222-2222-4222-8222-222222222222";
const outcomeFields = ["assessmentError", "rejectionReason", "entryDate", "entry", "stop", "target", "initialRisk", "holdingBars", "exitDate", "exit", "exitReason", "ambiguousBar", "grossPnl", "totalFees", "netPnl", "resultR", "winner"];

function fixture() {
  const now = Date.parse("2026-09-28T21:00:00Z");
  const dates = [];
  let date = new Date("2026-09-28T00:00:00Z");
  while (dates.length < 100) {
    if (![0, 6].includes(date.getUTCDay())) dates.unshift(date.toISOString().slice(0, 10));
    date = new Date(date.getTime() - 86400000);
  }
  const bars = dates.map((datetime, index) => {
    const close = 50 + index;
    return { datetime, open: close - 0.3, high: close + 0.5, low: close - 0.5, close, volume: index === 99 ? 1_500_000 : 1_000_000 };
  });
  const marketData = { ticker: "TEST", requested_ticker: "TEST", exchange: "NASDAQ", currency: "USD", timezone: "America/New_York", interval: "1day", fetched_at: new Date(now - 60000).toISOString(), bars };
  const analysis = { ticker: "TEST", market: "usa", horizon: "1–5 handelsdagar (swingtrading)", decision: { status: "WAIT" }, marketData, strategy: assessSwingSetup(marketData, { ticker: "TEST", marketStatus: getMarketStatus("usa", new Date(now)), now }), record: { trade_id: "TEST-analysis-1", signal_inputs: { record_type: "ANALYSIS" } } };
  const record = createPaperObservation(analysis, { setup: "BREAKOUT", holdingSessions: 3, quantity: 2, feePerOrder: 1, slippageBps: 10, recordedAt: now });
  const later = { ...marketData, bars: [...bars,
    { datetime: "2026-09-29", open: 149.7, high: 150.5, low: 149.5, close: 150, volume: 1_000_000 },
    { datetime: "2026-09-30", open: 150.7, high: 151.5, low: 150.5, close: 151, volume: 1_000_000 },
    { datetime: "2026-10-01", open: 151.7, high: 152.5, low: 151.5, close: 152, volume: 1_000_000 },
  ] };
  const opened = settlePaperObservation(record, { ...later, bars: later.bars.slice(0, -2) }, { now: "2026-09-29T21:00:00Z" });
  const unassessed = settlePaperObservation(record, { ...later, ticker: "OTHER" }, { now: "2026-10-01T21:00:00Z" });
  const closed = settlePaperObservation(record, later, { now: "2026-10-01T21:00:00Z" });
  assert.equal(opened.status, "PENDING_OPEN");
  assert.equal(unassessed.status, "NOT_ASSESSED");
  assert.equal(closed.status, "CLOSED");
  return { record, opened, unassessed, closed };
}

function fakeSupabase() {
  const rows = new Map();
  const calls = [];
  let activeUser = ownerId;
  let anonymous = false;
  const keyOf = (row) => `${row.user_id}:${row.observation_id}`;
  const matches = (row, filters) => filters.every(([field, value]) => row[field] === value);

  function query(action, payload) {
    const filters = [];
    let max = Infinity;
    const api = {
      select() { return api; },
      eq(field, value) { filters.push([field, value]); return api; },
      order() { return api; },
      limit(value) { max = value; return api; },
      async maybeSingle() { return { data: [...rows.values()].find((row) => matches(row, filters)) || null, error: null }; },
      async single() { return execute(); },
      then(resolve, reject) { return Promise.resolve(execute()).then(resolve, reject); },
    };
    function execute() {
      calls.push({ action, payload, filters });
      if (action === "insert") {
        const key = keyOf(payload);
        if (rows.has(key)) return { data: null, error: { code: "23505", message: "duplicate key" } };
        const row = { ...payload, status: "PENDING_ENTRY", progress: Object.fromEntries(outcomeFields.map((field) => [field, null])), revision: 0, captured_at: "2026-09-28T21:00:01Z", updated_at: "2026-09-28T21:00:01Z" };
        rows.set(key, row);
        return { data: row, error: null };
      }
      if (action === "update") {
        const existing = [...rows.values()].filter((row) => matches(row, filters));
        const updated = existing.map((row) => {
          const next = { ...row, ...payload, updated_at: "2026-10-01T21:00:01Z" };
          rows.set(keyOf(row), next);
          return next;
        });
        return { data: updated, error: null };
      }
      return { data: [...rows.values()].filter((row) => matches(row, filters)).slice(0, max), error: null };
    }
    return api;
  }
  return {
    rows, calls,
    setUser(value) { activeUser = value; },
    setAnonymous(value) { anonymous = value; },
    auth: { async getUser() { return { data: { user: { id: activeUser, is_anonymous: anonymous } }, error: null }; } },
    from(name) {
      assert.equal(name, "paper_observations");
      return {
        select: () => query("select"),
        insert: (payload) => query("insert", payload),
        update: (payload) => query("update", payload),
      };
    },
  };
}

test("new capture is inserted once, listed by verified owner, and never overwritten", async () => {
  const db = fakeSupabase();
  const repo = createPaperCloudRepository(db);
  const { record } = fixture();
  const first = await repo.ensureCapture(ownerId, record);
  assert.equal(first.revision, 0);
  assert.equal(first.provenance, "new_capture");
  assert.deepEqual(first.record, record);
  assert.deepEqual(await repo.listObservations(ownerId), [first]);
  assert.deepEqual(await repo.ensureCapture(ownerId, record), first);
  await assert.rejects(repo.ensureCapture(ownerId, { ...record, feePerOrder: 2 }), PaperCloudConflictError);
  assert.equal(db.rows.size, 1);
  assert.equal(db.rows.values().next().value.capture.status, undefined);
  assert.equal(db.rows.values().next().value.capture.netPnl, undefined);
});

test("advance uses revision compare-and-swap and preserves immutable capture", async () => {
  const db = fakeSupabase();
  const repo = createPaperCloudRepository(db);
  const { record, closed } = fixture();
  const initial = await repo.ensureCapture(ownerId, record);
  const advanced = await repo.advanceObservation(ownerId, initial, closed);
  assert.equal(advanced.revision, 1);
  assert.equal(advanced.record.status, "CLOSED");
  assert.equal(advanced.record.netPnl, closed.netPnl);
  assert.deepEqual(advanced.record, closed);
  assert.deepEqual(await repo.advanceObservation(ownerId, advanced, closed), advanced);
  await assert.rejects(repo.advanceObservation(ownerId, initial, closed), (error) => error.code === "PAPER_CLOUD_CONFLICT");
  assert.deepEqual(db.rows.values().next().value.capture.signalBar, record.signalBar);
  assert.equal(db.calls.filter((call) => call.action === "update").length, 2);
  assert.deepEqual(db.calls.find((call) => call.action === "update").filters, [["user_id", ownerId], ["observation_id", record.id], ["revision", 0]]);
});

test("verified identity and immutable capture block cross-user and conflicting writes", async () => {
  const db = fakeSupabase();
  const repo = createPaperCloudRepository(db);
  const { record, closed } = fixture();
  const initial = await repo.ensureCapture(ownerId, record);
  db.setUser(otherId);
  await assert.rejects(repo.listObservations(ownerId), /verifierad användarsession/);
  await assert.rejects(repo.ensureCapture(ownerId, record), /verifierad användarsession/);
  await assert.rejects(repo.advanceObservation(ownerId, initial, closed), /verifierad användarsession/);
  db.setUser(ownerId);
  db.setAnonymous(true);
  await assert.rejects(repo.listObservations(ownerId), /verifierad användarsession/);
  db.setAnonymous(false);
  await assert.rejects(repo.advanceObservation(ownerId, initial, { ...closed, sourceFetchedAt: "2026-09-28T20:58:00.000Z" }), PaperCloudConflictError);
  assert.equal(db.rows.values().next().value.revision, 0);
});

test("manual import can stage an older closed record without pretending it was newly captured", async () => {
  const db = fakeSupabase();
  const repo = createPaperCloudRepository(db);
  const { closed } = fixture();
  const pending = await repo.ensureCapture(ownerId, closed, { provenance: "local_import" });
  assert.equal(pending.provenance, "local_import");
  assert.equal(pending.record.status, "PENDING_ENTRY");
  const imported = await repo.advanceObservation(ownerId, pending, closed);
  assert.equal(imported.record.status, "CLOSED");
  assert.equal(imported.provenance, "local_import");
  await assert.rejects(repo.ensureCapture(ownerId, closed, { provenance: "new_capture" }), /ny molnobservation/);
});

test("an unassessable refresh cannot erase a confirmed open simulation", async () => {
  const db = fakeSupabase();
  const repo = createPaperCloudRepository(db);
  const { record, opened, unassessed } = fixture();
  const initial = await repo.ensureCapture(ownerId, record);
  const current = await repo.advanceObservation(ownerId, initial, opened);
  await assert.rejects(repo.advanceObservation(ownerId, current, unassessed), PaperCloudConflictError);
  assert.equal(db.rows.values().next().value.status, "PENDING_OPEN");
});
