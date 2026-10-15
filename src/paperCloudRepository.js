import { validatePaperObservation } from "./paperModel.js";
import { mergePaperObservationCopies } from "./paperSyncModel.js";

const TABLE = "paper_observations";
const MAX_ROWS = 500;
const OUTCOME_FIELDS = [
  "assessmentError", "rejectionReason", "entryDate", "entry", "stop", "target",
  "initialRisk", "holdingBars", "exitDate", "exit", "exitReason", "ambiguousBar",
  "grossPnl", "totalFees", "netPnl", "resultR", "winner",
];
const CAPTURE_FIELDS = [
  "version", "id", "sourceAnalysisTradeId", "basis", "sourceDecisionStatus",
  "ticker", "exchange", "currency", "timezone", "market", "strategyVersion",
  "setup", "signalDate", "recordedAt", "sourceFetchedAt", "signalBar", "plan",
  "holdingSessions", "quantity", "feePerOrder", "slippageBps",
];
const ALLOWED_FIELDS = new Set([...CAPTURE_FIELDS, "status", ...OUTCOME_FIELDS]);

export class PaperCloudConflictError extends Error {
  constructor(message = "Paperobservationen har ändrats på en annan enhet. Läs in den senaste versionen innan du fortsätter.") {
    super(message);
    this.name = "PaperCloudConflictError";
    this.code = "PAPER_CLOUD_CONFLICT";
  }
}

function sameJson(left, right) {
  const canonical = (value) => {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === "object") {
      return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
    }
    return value;
  };
  return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
}

function splitRecord(record) {
  if (!validatePaperObservation(record) || Object.keys(record).some((key) => !ALLOWED_FIELDS.has(key))) {
    throw new Error("Paperobservationen har ett ogiltigt eller okänt format.");
  }
  const capture = Object.fromEntries(CAPTURE_FIELDS.filter((key) => Object.hasOwn(record, key)).map((key) => [key, record[key]]));
  const progress = Object.fromEntries(OUTCOME_FIELDS.map((key) => [key, record[key]]));
  return { capture, status: record.status, progress };
}

function restoreRow(row, userId) {
  if (!row || row.user_id !== userId || !row.capture || row.capture.id !== row.observation_id ||
      !["new_capture", "local_import"].includes(row.provenance) ||
      !Number.isSafeInteger(row.revision) || row.revision < 0 ||
      !row.progress || typeof row.progress !== "object" || Array.isArray(row.progress) ||
      Object.keys(row.progress).some((key) => !OUTCOME_FIELDS.includes(key))) {
    throw new Error("En synkad paperobservation har ogiltigt format.");
  }
  const progress = Object.fromEntries(OUTCOME_FIELDS.map((key) => [key, row.progress[key] ?? null]));
  const record = { ...row.capture, status: row.status, ...progress };
  splitRecord(record);
  return {
    userId,
    id: row.observation_id,
    record,
    revision: row.revision,
    provenance: row.provenance,
    capturedAt: row.captured_at,
    updatedAt: row.updated_at,
  };
}

function unwrap(result) {
  if (result.error) throw result.error;
  return result.data;
}

export function createPaperCloudRepository(supabase) {
  if (!supabase?.auth?.getUser || !supabase?.from) {
    throw new Error("Supabase-klienten för personlig paperlogg saknas.");
  }

  async function verifyOwner(userId) {
    const { data, error } = await supabase.auth.getUser();
    if (error) throw error;
    if (!userId || data?.user?.id !== userId || data.user.is_anonymous === true) {
      throw new Error("Den personliga paperloggen kräver en verifierad användarsession.");
    }
    return userId;
  }

  async function readOne(userId, id) {
    const row = unwrap(await supabase.from(TABLE).select("*")
      .eq("user_id", userId).eq("observation_id", id).maybeSingle());
    return row ? restoreRow(row, userId) : null;
  }

  return {
    async listObservations(userId) {
      await verifyOwner(userId);
      const rows = unwrap(await supabase.from(TABLE).select("*")
        .eq("user_id", userId).order("captured_at", { ascending: false }).limit(MAX_ROWS + 1));
      if (!Array.isArray(rows) || rows.length > MAX_ROWS) {
        throw new Error(`Molnloggen innehåller fler än ${MAX_ROWS} poster eller har ett ogiltigt svar.`);
      }
      return rows.map((row) => restoreRow(row, userId));
    },

    /** Idempotent INSERT: never overwrite an existing immutable capture. */
    async ensureCapture(userId, record, { provenance = "new_capture" } = {}) {
      await verifyOwner(userId);
      if (!["new_capture", "local_import"].includes(provenance)) {
        throw new Error("Paperobservationens ursprung är ogiltigt.");
      }
      const { capture, status } = splitRecord(record);
      if (provenance === "new_capture" && status !== "PENDING_ENTRY") {
        throw new Error("En ny molnobservation måste sparas innan utfallet finns.");
      }
      const result = await supabase.from(TABLE).insert({
        user_id: userId,
        observation_id: capture.id,
        capture,
        provenance,
      }).select("*").single();
      if (!result.error) return restoreRow(result.data, userId);
      if (result.error.code !== "23505") throw result.error;

      const existing = await readOne(userId, capture.id);
      if (!existing || existing.provenance !== provenance || !sameJson(splitRecord(existing.record).capture, capture)) {
        throw new PaperCloudConflictError("En annan paperobservation med samma ID finns redan i molnet. Ingen post skrevs över.");
      }
      return existing;
    },

    /** Compare-and-swap update; the SQL trigger also requires revision + 1. */
    async advanceObservation(userId, current, nextRecord) {
      await verifyOwner(userId);
      if (!current || current.userId !== userId || !Number.isSafeInteger(current.revision) || current.revision < 0) {
        throw new Error("Den senast lästa molnrevisionen saknas.");
      }
      const before = splitRecord(current.record);
      const next = splitRecord(nextRecord);
      if (!sameJson(before.capture, next.capture) || current.id !== next.capture.id) {
        throw new PaperCloudConflictError("Signalens låsta uppgifter skiljer sig. Ingen molnpost ändrades.");
      }
      if (sameJson(before, next)) return current;
      let merged;
      try { merged = mergePaperObservationCopies(current.record, nextRecord); }
      catch (error) { throw new PaperCloudConflictError(error.message); }
      if (!sameJson(merged, nextRecord)) {
        throw new PaperCloudConflictError("En äldre bedömning kan inte ersätta en senare molnrevision.");
      }
      if (["CLOSED", "REJECTED_ENTRY"].includes(before.status)) {
        throw new PaperCloudConflictError("En avslutad paperobservation kan inte ändras.");
      }
      if (before.status === "PENDING_OPEN" && next.status === "PENDING_ENTRY") {
        throw new PaperCloudConflictError("Paperobservationens status kan inte gå bakåt.");
      }
      const rows = unwrap(await supabase.from(TABLE).update({
        status: next.status,
        progress: next.progress,
        revision: current.revision + 1,
      }).eq("user_id", userId).eq("observation_id", current.id)
        .eq("revision", current.revision).select("*"));
      if (!Array.isArray(rows) || rows.length !== 1) throw new PaperCloudConflictError();
      return restoreRow(rows[0], userId);
    },
  };
}
