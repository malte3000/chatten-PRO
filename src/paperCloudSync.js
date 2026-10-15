import { mergePaperObservationCopies, mergePaperObservationLists } from "./paperSyncModel.js";
import { PAPER_STORAGE_KEY, encodePaperLog, loadPaperLog, savePaperLog } from "./paperStorage.js";

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
}

const same = (a, b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));

function checkedRows(rows, userId) {
  if (!Array.isArray(rows)) throw new Error("Den synkade paperloggen har ett ogiltigt svar.");
  const seen = new Set();
  for (const row of rows) {
    if (!row || row.userId !== userId || !row.id || row.record?.id !== row.id || seen.has(row.id)) {
      throw new Error("Den synkade paperloggen innehåller fel ägare eller dubbla observations-ID.");
    }
    seen.add(row.id);
  }
  return rows;
}

function assertClient(client, userId, storage, lockManager) {
  if (client?.enabled === false) throw new Error(client.reason || "Molnsynkning är avstängd.");
  if (!userId || typeof userId !== "string" ||
      !["listObservations", "ensureCapture", "advanceObservation"].every((name) => typeof client?.[name] === "function")) {
    throw new Error("En personlig inloggning och anslutning krävs för att synka paperloggen.");
  }
  if (!storage || typeof storage.getItem !== "function" || typeof storage.setItem !== "function" ||
      !lockManager || typeof lockManager.request !== "function") {
    throw new Error("Säker lokal lagring mellan flikar saknas. Exportera en JSON-kopia innan du fortsätter.");
  }
}

/**
 * Explicit, user-triggered sync only. Every conflict is checked before a
 * remote write; the last remote read and local merge run inside a Web Lock.
 * A failed cloud step never overwrites the browser's existing paper log.
 */
export async function syncPaperCloud({ client, userId, storage, lockManager }) {
  assertClient(client, userId, storage, lockManager);

  const local = await lockManager.request(PAPER_STORAGE_KEY, { mode: "exclusive" }, () => loadPaperLog(storage));
  const before = checkedRows(await client.listObservations(userId), userId);
  // This validates every shared ID and detects conflicting locked captures or
  // outcomes before ensureCapture/advanceObservation can write anything.
  const preflight = mergePaperObservationLists(local, before.map((row) => row.record));
  // The browser format has both count and byte limits. Check the union now so
  // a predictable capacity failure cannot follow a partial cloud upload.
  encodePaperLog(preflight);

  const remoteById = new Map(before.map((row) => [row.id, row]));
  let uploaded = 0;
  let advanced = 0;

  for (const record of local) {
    let row = remoteById.get(record.id);
    if (!row) {
      // Existing browser records are imported as unverified local history.
      // The database inserts a valid PENDING_ENTRY row; a later CAS update
      // carries the previously saved outcome, if there is one.
      row = await client.ensureCapture(userId, record, { provenance: "local_import" });
      checkedRows([row], userId);
      uploaded += 1;
    }

    const desired = mergePaperObservationCopies(record, row.record);
    if (!same(desired, row.record)) {
      await client.advanceObservation(userId, row, desired);
      advanced += 1;
    }
  }

  // Another tab may have changed localStorage while the network calls ran.
  // Re-read it under the same lock, then either merge all remote rows safely
  // or leave it completely untouched when a conflict is found.
  return lockManager.request(PAPER_STORAGE_KEY, { mode: "exclusive" }, async () => {
    const after = checkedRows(await client.listObservations(userId), userId);
    // Read localStorage after the awaited network request so an external
    // writer cannot slip a change between the read and our final save.
    const current = loadPaperLog(storage);
    const records = mergePaperObservationLists(current, after.map((row) => row.record));
    const previousById = new Map(current.map((record) => [record.id, record]));
    const downloaded = records.reduce((count, record) => {
      const previous = previousById.get(record.id);
      return count + (!previous || !same(previous, record) ? 1 : 0);
    }, 0);
    if (!same(records, current)) savePaperLog(storage, records);
    return { records, uploaded, downloaded, advanced };
  });
}
