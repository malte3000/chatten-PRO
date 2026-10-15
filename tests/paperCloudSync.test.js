import test from "node:test";
import assert from "node:assert/strict";
import { getMarketStatus } from "../api/_market-hours.js";
import { assessSwingSetup } from "../src/strategyModel.js";
import { createPaperObservation, settlePaperObservation, validatePaperObservation } from "../src/paperModel.js";
import { syncPaperCloud } from "../src/paperCloudSync.js";
import { rehydratePaperObservation, splitPaperObservation } from "../src/paperSyncModel.js";
import { loadPaperLog, savePaperLog } from "../src/paperStorage.js";

const userId = "11111111-1111-4111-8111-111111111111";
const signalTime = Date.parse("2026-09-28T21:00:00Z");

function observations() {
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
  const marketData = { ticker: "TEST", requested_ticker: "TEST", exchange: "NASDAQ", currency: "USD", timezone: "America/New_York", interval: "1day", fetched_at: new Date(signalTime - 60000).toISOString(), bars };
  const analysis = { ticker: "TEST", market: "usa", horizon: "1–5 handelsdagar (swingtrading)", decision: { status: "WAIT" }, marketData, strategy: assessSwingSetup(marketData, { ticker: "TEST", marketStatus: getMarketStatus("usa", new Date(signalTime)), now: signalTime }), record: { trade_id: "TEST-analysis-1", signal_inputs: { record_type: "ANALYSIS" } } };
  const pending = createPaperObservation(analysis, { setup: "BREAKOUT", holdingSessions: 3, quantity: 2, feePerOrder: 1, slippageBps: 10, recordedAt: signalTime });
  const followup = { ...marketData, bars: [...bars,
    { datetime: "2026-09-29", open: 149.7, high: 150.5, low: 149.5, close: 150, volume: 1_000_000 },
    { datetime: "2026-09-30", open: 150.7, high: 151.5, low: 150.5, close: 151, volume: 1_000_000 },
    { datetime: "2026-10-01", open: 151.7, high: 152.5, low: 151.5, close: 152, volume: 1_000_000 },
  ] };
  const closed = settlePaperObservation(pending, followup, { now: "2026-10-01T21:00:00Z" });
  assert.equal(closed.status, "CLOSED");
  return { pending, closed };
}

function storageWith(records = []) {
  const entries = new Map();
  const storage = { getItem(key) { return entries.get(key) ?? null; }, setItem(key, value) { entries.set(key, value); } };
  savePaperLog(storage, records);
  return storage;
}

function lockManager() {
  return { calls: 0, request(_name, _options, callback) { this.calls += 1; return callback(); } };
}

function row(record, revision = 0, provenance = "local_import") {
  return { userId, id: record.id, record: structuredClone(record), revision, provenance, capturedAt: "2026-10-01T21:00:00Z", updatedAt: "2026-10-01T21:00:00Z" };
}

function fakeCloud(initial = []) {
  const rows = new Map(initial.map((item) => [item.id, structuredClone(item)]));
  const calls = { list: 0, ensure: 0, advance: 0 };
  let failAdvance = false;
  let onList = null;
  return {
    rows, calls,
    failNextAdvance() { failAdvance = true; },
    onList(callback) { onList = callback; },
    async listObservations(owner) {
      assert.equal(owner, userId);
      calls.list += 1;
      if (onList) await onList(calls.list);
      return structuredClone([...rows.values()]);
    },
    async ensureCapture(owner, record, { provenance }) {
      assert.equal(owner, userId);
      assert.equal(provenance, "local_import");
      calls.ensure += 1;
      if (rows.has(record.id)) return structuredClone(rows.get(record.id));
      const { capture, progress } = splitPaperObservation(record);
      const pendingProgress = Object.fromEntries(Object.keys(progress).map((key) => [key, key === "status" ? "PENDING_ENTRY" : null]));
      const inserted = row(rehydratePaperObservation(capture, pendingProgress));
      rows.set(record.id, inserted);
      return structuredClone(inserted);
    },
    async advanceObservation(owner, current, nextRecord) {
      assert.equal(owner, userId);
      calls.advance += 1;
      if (failAdvance) { failAdvance = false; throw new Error("Tillfälligt nätfel"); }
      const existing = rows.get(current.id);
      assert.equal(existing.revision, current.revision);
      assert.ok(validatePaperObservation(nextRecord));
      const updated = row(nextRecord, existing.revision + 1, existing.provenance);
      rows.set(current.id, updated);
      return structuredClone(updated);
    },
  };
}

test("manual sync imports a closed local observation in two steps and is idempotent", async () => {
  const { closed } = observations();
  const storage = storageWith([closed]);
  const cloud = fakeCloud();
  const locks = lockManager();
  const first = await syncPaperCloud({ client: cloud, userId, storage, lockManager: locks });
  assert.deepEqual({ uploaded: first.uploaded, downloaded: first.downloaded, advanced: first.advanced }, { uploaded: 1, downloaded: 0, advanced: 1 });
  assert.deepEqual(first.records, [closed]);
  assert.equal(cloud.rows.get(closed.id).provenance, "local_import");
  assert.equal(cloud.rows.get(closed.id).record.status, "CLOSED");
  assert.equal(locks.calls, 2);

  const second = await syncPaperCloud({ client: cloud, userId, storage, lockManager: locks });
  assert.deepEqual({ uploaded: second.uploaded, downloaded: second.downloaded, advanced: second.advanced }, { uploaded: 0, downloaded: 0, advanced: 0 });
  assert.deepEqual(loadPaperLog(storage), [closed]);
});

test("remote-only records download and local later progress advances by CAS", async () => {
  const { pending, closed } = observations();
  const another = { ...pending, id: "paper:TEST-analysis-2:BREAKOUT", sourceAnalysisTradeId: "TEST-analysis-2" };
  assert.ok(validatePaperObservation(another));
  const storage = storageWith([closed]);
  const cloud = fakeCloud([row(pending), row(another)]);
  const result = await syncPaperCloud({ client: cloud, userId, storage, lockManager: lockManager() });
  assert.deepEqual({ uploaded: result.uploaded, downloaded: result.downloaded, advanced: result.advanced }, { uploaded: 0, downloaded: 1, advanced: 1 });
  assert.deepEqual(loadPaperLog(storage), [closed, another]);
  assert.equal(cloud.rows.get(pending.id).record.status, "CLOSED");
});

test("preflight conflict rejects all cloud writes and preserves local data", async () => {
  const { pending } = observations();
  const incompatible = { ...pending, quantity: 3 };
  assert.ok(validatePaperObservation(incompatible));
  const storage = storageWith([pending]);
  const cloud = fakeCloud([row(incompatible)]);
  await assert.rejects(syncPaperCloud({ client: cloud, userId, storage, lockManager: lockManager() }), /motstridiga låsta/);
  assert.equal(cloud.calls.ensure, 0);
  assert.equal(cloud.calls.advance, 0);
  assert.deepEqual(loadPaperLog(storage), [pending]);
});

test("preflight rejects a local and cloud union above browser capacity before writes", async () => {
  const { pending } = observations();
  const storage = storageWith([pending]);
  const remote = Array.from({ length: 500 }, (_, index) => {
    const sourceAnalysisTradeId = `TEST-analysis-remote-${index}`;
    const record = { ...pending, sourceAnalysisTradeId, id: `paper:${sourceAnalysisTradeId}:BREAKOUT` };
    return row(record);
  });
  const cloud = fakeCloud(remote);
  await assert.rejects(syncPaperCloud({ client: cloud, userId, storage, lockManager: lockManager() }), /högst 500/);
  assert.equal(cloud.calls.ensure, 0);
  assert.equal(cloud.calls.advance, 0);
  assert.deepEqual(loadPaperLog(storage), [pending]);
});

test("failed imported outcome is retryable without losing the local record", async () => {
  const { closed } = observations();
  const storage = storageWith([closed]);
  const cloud = fakeCloud();
  cloud.failNextAdvance();
  await assert.rejects(syncPaperCloud({ client: cloud, userId, storage, lockManager: lockManager() }), /nätfel/);
  assert.deepEqual(loadPaperLog(storage), [closed]);
  assert.equal(cloud.rows.get(closed.id).record.status, "PENDING_ENTRY");
  const retry = await syncPaperCloud({ client: cloud, userId, storage, lockManager: lockManager() });
  assert.deepEqual({ uploaded: retry.uploaded, downloaded: retry.downloaded, advanced: retry.advanced }, { uploaded: 0, downloaded: 0, advanced: 1 });
  assert.equal(cloud.rows.get(closed.id).record.status, "CLOSED");
});

test("final merge respects a concurrent local change instead of overwriting it", async () => {
  const { pending, closed } = observations();
  const storage = storageWith([pending]);
  const cloud = fakeCloud([row(closed)]);
  const changed = { ...pending, quantity: 3 };
  cloud.onList((number) => { if (number === 2) savePaperLog(storage, [changed]); });
  await assert.rejects(syncPaperCloud({ client: cloud, userId, storage, lockManager: lockManager() }), /motstridiga låsta/);
  assert.deepEqual(loadPaperLog(storage), [changed]);
});

test("missing Web Lock stops before any cloud request", async () => {
  const { pending } = observations();
  const cloud = fakeCloud();
  await assert.rejects(syncPaperCloud({ client: cloud, userId, storage: storageWith([pending]), lockManager: null }), /Säker lokal lagring/);
  assert.equal(cloud.calls.list, 0);
});
