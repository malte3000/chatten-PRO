import { validatePaperObservation } from "./paperModel.js";

export const PAPER_STORAGE_KEY = "sannolikhet-paper-observations-v1";
export const PAPER_LOG_FORMAT = "sannolikhet-paper-log-v1";
const MAX_RECORDS = 500;
const MAX_BYTES = 750_000;

function inspect(records) {
  if (!Array.isArray(records) || records.length > MAX_RECORDS) throw new Error(`Paperloggen kan innehålla högst ${MAX_RECORDS} observationer.`);
  const ids = new Set();
  for (const record of records) {
    if (!validatePaperObservation(record)) throw new Error("Paperloggen innehåller en ogiltig observation.");
    if (ids.has(record.id)) throw new Error("Paperloggen innehåller dubbla observations-ID.");
    ids.add(record.id);
  }
  return records;
}

export function encodePaperLog(records) {
  const text = JSON.stringify({ format: PAPER_LOG_FORMAT, records: inspect(records) });
  if (new TextEncoder().encode(text).length > MAX_BYTES) throw new Error("Paperloggen är för stor för lokal lagring.");
  return text;
}

export function decodePaperLog(text) {
  if (typeof text !== "string" || new TextEncoder().encode(text).length > MAX_BYTES) throw new Error("Importfilen är för stor eller saknar giltigt textinnehåll.");
  let parsed;
  try { parsed = JSON.parse(text); }
  catch { throw new Error("Paperloggen innehåller inte giltig JSON."); }
  if (!parsed || parsed.format !== PAPER_LOG_FORMAT) throw new Error("Paperloggens formatversion stöds inte.");
  return inspect(parsed.records);
}

export function loadPaperLog(storage) {
  const raw = storage.getItem(PAPER_STORAGE_KEY);
  return raw === null ? [] : decodePaperLog(raw);
}

export function savePaperLog(storage, records) {
  // Validation and serialization finish before the first write. A failing
  // storage provider cannot make an in-memory observation appear saved.
  storage.setItem(PAPER_STORAGE_KEY, encodePaperLog(records));
}

export async function updatePaperLog(storage, lockManager, transform) {
  if (!lockManager?.request) throw new Error("Webbläsaren saknar stöd för säker lagring mellan flikar. Exportera loggen och använd en modern webbläsare.");
  return lockManager.request(PAPER_STORAGE_KEY, { mode: "exclusive" }, () => {
    const current = loadPaperLog(storage);
    const next = transform(current);
    const encoded = encodePaperLog(next);
    if (encoded !== encodePaperLog(current)) storage.setItem(PAPER_STORAGE_KEY, encoded);
    return next;
  });
}

export function mergePaperLogs(existing, incoming) {
  const left = inspect(existing);
  const right = inspect(incoming);
  const merged = [...left];
  const byId = new Map(left.map((record) => [record.id, record]));
  for (const record of right) {
    const known = byId.get(record.id);
    if (known && JSON.stringify(known) !== JSON.stringify(record)) throw new Error(`Observation ${record.id} har olika innehåll i lokal logg och importfil. Ingen post skrevs över.`);
    if (!known) { merged.push(record); byId.set(record.id, record); }
  }
  inspect(merged);
  return merged;
}
