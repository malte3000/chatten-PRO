import { validatePaperObservation } from "./paperModel.js";

// The capture is fixed at registration. Only the simulation's assessment can
// advance as completed daily bars become available.
const OUTCOME_KEYS = Object.freeze([
  "assessmentError", "rejectionReason", "entryDate", "entry", "stop", "target",
  "initialRisk", "holdingBars", "exitDate", "exit", "exitReason", "ambiguousBar",
  "grossPnl", "totalFees", "netPnl", "resultR", "winner",
]);
const PROGRESS_KEYS = new Set(["status", ...OUTCOME_KEYS]);
const ENTRY_KEYS = ["entryDate", "entry", "stop", "target", "initialRisk"];

function plainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function snapshot(value) {
  try { return JSON.parse(JSON.stringify(value)); }
  catch { throw new Error("Paperobservationen kan inte serialiseras som JSON."); }
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (plainObject(value)) return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  return value;
}

const equal = (a, b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));

function assertRecord(record) {
  if (!validatePaperObservation(record)) throw new Error("Paperobservationen är ogiltig.");
}

export function splitPaperObservation(record) {
  assertRecord(record);
  const capture = {};
  const progress = {};
  for (const [key, value] of Object.entries(snapshot(record))) {
    (PROGRESS_KEYS.has(key) ? progress : capture)[key] = value;
  }
  return { capture, progress };
}

export function rehydratePaperObservation(capture, progress) {
  if (!plainObject(capture) || !plainObject(progress) ||
      Object.keys(capture).some((key) => PROGRESS_KEYS.has(key)) ||
      Object.keys(progress).some((key) => !PROGRESS_KEYS.has(key))) {
    throw new Error("Paperobservationens låsta uppgifter och utfall är felaktigt uppdelade.");
  }
  const record = { ...snapshot(capture), ...snapshot(progress) };
  assertRecord(record);
  return record;
}

function compatibleEntry(earlier, later) {
  return ENTRY_KEYS.every((key) => equal(earlier[key], later[key]));
}

function laterProgress(a, b) {
  if (equal(a, b)) return a;
  const aFinal = a.status === "CLOSED" || a.status === "REJECTED_ENTRY";
  const bFinal = b.status === "CLOSED" || b.status === "REJECTED_ENTRY";
  if (aFinal && bFinal) throw new Error("Paperobservationen har motstridiga slutliga utfall.");

  // Missing or inconsistent follow-up data can temporarily mark an observation
  // unassessable. Keep that warning over the initial pending state, but do not
  // let it erase a confirmed entry or final outcome from another device.
  if (a.status === "NOT_ASSESSED" && b.status === "NOT_ASSESSED") {
    return equal(a, b) || a.assessmentError.localeCompare(b.assessmentError) >= 0 ? a : b;
  }
  if (a.status === "NOT_ASSESSED") return b.status === "PENDING_ENTRY" ? a : b;
  if (b.status === "NOT_ASSESSED") return a.status === "PENDING_ENTRY" ? b : a;

  if (a.status === "PENDING_ENTRY") return b;
  if (b.status === "PENDING_ENTRY") return a;

  if (a.status === "PENDING_OPEN" && b.status === "PENDING_OPEN") {
    if (!compatibleEntry(a, b)) throw new Error("Paperobservationen har motstridiga simulerade ingångar.");
    if (a.holdingBars === b.holdingBars) throw new Error("Paperobservationen har motstridiga öppna utfall.");
    return a.holdingBars > b.holdingBars ? a : b;
  }

  const open = a.status === "PENDING_OPEN" ? a : b;
  const final = a.status === "PENDING_OPEN" ? b : a;
  if (final.status !== "CLOSED" || !compatibleEntry(open, final) || final.holdingBars < open.holdingBars) {
    throw new Error("Paperobservationen har oförenliga ingångar eller utfall.");
  }
  return final;
}

export function mergePaperObservationCopies(local, remote) {
  const a = splitPaperObservation(local);
  const b = splitPaperObservation(remote);
  if (a.capture.id !== b.capture.id) throw new Error("Paperobservationerna har olika ID.");
  if (!equal(a.capture, b.capture)) throw new Error(`Observation ${a.capture.id} har motstridiga låsta signaluppgifter.`);
  return rehydratePaperObservation(a.capture, laterProgress(a.progress, b.progress));
}

export function mergePaperObservationLists(localRecords, remoteRecords) {
  if (!Array.isArray(localRecords) || !Array.isArray(remoteRecords)) throw new Error("Paperloggarna måste vara listor.");
  const merged = [];
  const byId = new Map();
  for (const [side, records] of [["lokal", localRecords], ["synkad", remoteRecords]]) {
    const seen = new Set();
    for (const record of records) {
      assertRecord(record);
      if (seen.has(record.id)) throw new Error(`Den ${side}a paperloggen innehåller dubbla observations-ID.`);
      seen.add(record.id);
      const index = byId.get(record.id);
      if (index === undefined) {
        byId.set(record.id, merged.length);
        merged.push(snapshot(record));
      } else {
        merged[index] = mergePaperObservationCopies(merged[index], record);
      }
    }
  }
  return merged;
}
