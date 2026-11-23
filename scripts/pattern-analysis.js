import { readFile, writeFile } from "node:fs/promises";
import { analyzePatternDiscovery } from "../src/patternDiscoveryModel.js";
import { runEventBacktest } from "../src/eventBacktestModel.js";

const HELP = `Offline Pattern Discovery och event-backtest – endast forskning/simulering.
Inga nätverksanrop, databasändringar eller verkliga order görs.

Användning:
  node scripts/pattern-analysis.js --input <data.json> --output <rapport.json>
    --window 30|90 --threshold <procent> --horizon <sessioner>
    --recovery-target <procent> --continuation-target <procent>
    --quantity <helt antal> --fee <avgift per order>
    --slippage-bps <baspunkter> --spread-bps <baspunkter>
    [--ambiguous TIE|STOP_FIRST]

Input är antingen en JSON-lista med dataserier eller {"datasets":[...]}. Varje
dataserie har ticker och stigande unika dagsbars med datetime, open, high, low,
close och valfri volume. Justering för splittar/utdelningar och point-in-time-
universum måste vara verifierad i källdatan; CLI:t antar inte att detta är gjort.

Händelsen är första passeringen av vald drawdown från högsta tidigare stängning
inom fönstret. Backtest går in vid nästa öppning. TIE är standard när mål och
stop träffas i samma dagsljus utan intradagsordning; STOP_FIRST är konservativt.
Alla kostnadsantaganden är obligatoriska, även när värdet är 0.
Rapporten skrivs till en ny fil och skriver aldrig över en befintlig rapport.
  --help  Visa denna hjälp.
`;

const FLAGS = new Set([
  "--input", "--output", "--window", "--threshold", "--horizon",
  "--recovery-target", "--continuation-target", "--quantity", "--fee",
  "--slippage-bps", "--spread-bps", "--ambiguous",
]);
const REQUIRED = [...FLAGS].filter((flag) => flag !== "--ambiguous");

function parseArguments(args) {
  if (args.length === 1 && args[0] === "--help") return null;
  const values = new Map();
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (!FLAGS.has(flag)) throw new Error(`Okänd parameter: ${flag}.`);
    if (values.has(flag)) throw new Error(`Parametern ${flag} har angetts flera gånger.`);
    const value = args[++index];
    if (!value || value.startsWith("--")) throw new Error(`Värde saknas för ${flag}.`);
    values.set(flag, value);
  }
  const missing = REQUIRED.filter((flag) => !values.has(flag));
  if (missing.length) throw new Error(`Obligatoriska parametrar saknas: ${missing.join(", ")}.`);
  const number = (flag, { integer = false, minimum = 0, maximum = Number.MAX_VALUE } = {}) => {
    const text = values.get(flag);
    const parsed = Number(text);
    if (!text?.trim() || !Number.isFinite(parsed) || parsed < minimum || parsed > maximum || (integer && !Number.isSafeInteger(parsed))) {
      throw new Error(`${flag} har ett ogiltigt värde.`);
    }
    return parsed;
  };
  const window = number("--window", { integer: true, minimum: 2, maximum: 1000 });
  if (![30, 90].includes(window)) throw new Error("--window ska vara 30 eller 90.");
  const ambiguousPolicy = values.get("--ambiguous") || "TIE";
  if (!["TIE", "STOP_FIRST"].includes(ambiguousPolicy)) throw new Error("--ambiguous ska vara TIE eller STOP_FIRST.");
  return {
    input: values.get("--input"), output: values.get("--output"), window,
    threshold: number("--threshold", { minimum: 0.000001, maximum: 99 }),
    horizon: number("--horizon", { integer: true, minimum: 1, maximum: 1000 }),
    recoveryTarget: number("--recovery-target", { minimum: 0.000001, maximum: 99 }),
    continuationTarget: number("--continuation-target", { minimum: 0.000001, maximum: 99 }),
    quantity: number("--quantity", { integer: true, minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
    feePerOrder: number("--fee", { minimum: 0 }),
    slippageBps: number("--slippage-bps", { minimum: 0, maximum: 9999 }),
    spreadBps: number("--spread-bps", { minimum: 0, maximum: 9999 }),
    ambiguousPolicy,
  };
}

async function readDatasets(path) {
  let content;
  try { content = await readFile(path, "utf8"); }
  catch (error) { throw new Error(`Kunde inte läsa ${path} (${error.code || "läsfel"}).`); }
  let parsed;
  try { parsed = JSON.parse(content.replace(/^\uFEFF/, "")); }
  catch { throw new Error(`Filen ${path} innehåller ogiltig JSON.`); }
  const datasets = Array.isArray(parsed) ? parsed : parsed?.datasets;
  if (!Array.isArray(datasets) || !datasets.length) throw new Error("Input måste innehålla minst en dataserie.");
  return datasets;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (!options) { process.stdout.write(HELP); return; }
  const datasets = await readDatasets(options.input);
  const pattern = analyzePatternDiscovery({
    datasets, drawdownWindows: [options.window], horizons: [options.horizon],
    thresholds: [options.threshold], recoveryTargets: [options.recoveryTarget],
    continuationTargets: [options.continuationTarget], minSampleSize: 20,
  });
  const selectedEvents = pattern.events.filter((event) =>
    event.eventType === `DRAWDOWN_${options.window}` && Math.abs(event.thresholdPct) === options.threshold);
  const eventBacktest = runEventBacktest({
    datasets,
    events: selectedEvents.map((event) => ({
      datasetIndex: event.datasetIndex, ticker: event.ticker,
      signalIndex: event.eventIndex, signalDate: event.eventDate,
      metadata: { patternEventId: event.id, thresholdPct: event.thresholdPct, eventType: event.eventType },
    })),
    targetPct: options.recoveryTarget, stopPct: options.continuationTarget,
    horizon: options.horizon, side: "LONG", entryTiming: "NEXT_OPEN",
    quantity: options.quantity, feePerOrder: options.feePerOrder,
    slippageBps: options.slippageBps, spreadBps: options.spreadBps,
    ambiguousPolicy: options.ambiguousPolicy,
  });
  const report = {
    status: pattern.status === "INVALID" || eventBacktest.status === "INVALID" ? "INVALID" : "COMPLETED",
    simulation: true,
    runConfig: {
      drawdownWindow: options.window, thresholdPct: options.threshold, horizonSessions: options.horizon,
      recoveryTargetPct: options.recoveryTarget, continuationTargetPct: options.continuationTarget,
      quantity: options.quantity, feePerOrder: options.feePerOrder,
      slippageBps: options.slippageBps, spreadBps: options.spreadBps,
      ambiguousPolicy: options.ambiguousPolicy,
    },
    limitations: [
      "Historiska frekvenser är inte en garanti eller personlig rekommendation.",
      "Dataleverantörens justeringar, avnoterade bolag och point-in-time-universum måste verifieras separat.",
      "Wilson-intervall är deskriptiva; observationer från samma instrument kan vara beroende.",
    ],
    patternDiscovery: pattern,
    eventBacktest,
  };
  try { await writeFile(options.output, `${JSON.stringify(report, null, 2)}\n`, { flag: "wx", encoding: "utf8" }); }
  catch (error) {
    if (error.code === "EEXIST") throw new Error(`Rapportfilen ${options.output} finns redan. Välj en ny --output; inget skrevs över.`);
    throw new Error(`Kunde inte skriva ${options.output} (${error.code || "skrivfel"}).`);
  }
  process.stdout.write(`Pattern Discovery: ${selectedEvents.length} händelser · backtest ${eventBacktest.status}.\nRapport sparad: ${options.output}\n`);
  if (report.status === "INVALID") process.exitCode = 1;
}

main().catch((error) => {
  process.stderr.write(`Fel: ${error.message}\nVisa hjälp med node scripts/pattern-analysis.js --help.\n`);
  process.exitCode = 1;
});
