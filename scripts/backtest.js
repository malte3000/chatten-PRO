import { readFile, writeFile } from "node:fs/promises";
import { runSwingReplay } from "../src/backtestModel.js";

const HELP = `Offlineprisprov av experimentella swingregler – endast simulering.
Inga nätverksanrop, API-anrop, databasändringar eller verkliga order görs.

Användning:
  node scripts/backtest.js --input <data.json> --output <rapport.json>
    --market usa|stockholm --setup BREAKOUT|PULLBACK --holding 1..5
    --quantity <helt aktieantal> --fee <avgift per order>
    --slippage-bps <baspunkter per fill> --as-of <ISO-klocka med tidszon>
    [--benchmark <referensdata.json> --benchmark-ticker <ticker>]

Alla parametrar ovan utom referensdata är obligatoriska. Avgift och slippage
måste anges uttryckligen, även om värdet är 0. Avgiften är i aktiens valuta
och tas vid både ingång och utgång. Slippage ska vara >= 0 och < 10000.
Innehavstiden räknas i observerade dagsljus. Exempel på ISO-klocka:
2026-09-29T23:00:00Z eller 2026-09-30T01:00:00+02:00.

Input och referensdata är JSON med ticker, currency, timezone, exchange,
interval: "1day" och bars, i samma format som terminalens market-data-svar.
Varje bar innehåller datetime, open, high, low, close och volume.
Referensfil och referensticker ska anges tillsammans. Med referensdata krävs
marknadsfiltret; utan referensdata är filtret uttryckligen av i rapporten.

Rapporten skrivs till en NY fil; en befintlig fil skrivs aldrig över.
Ogiltigt dataunderlag kan ge en diagnostisk INVALID-rapport och exitkod 1.
Resultatet är ett tekniskt prisexperiment, ingen validerad handelsstrategi.
  --help  Visa denna hjälp.
`;

const VALUE_FLAGS = new Set([
  "--input", "--output", "--benchmark", "--benchmark-ticker", "--market",
  "--setup", "--holding", "--quantity", "--fee", "--slippage-bps", "--as-of",
]);
const REQUIRED = ["--input", "--output", "--market", "--setup", "--holding", "--quantity", "--fee", "--slippage-bps", "--as-of"];

function parseArguments(args) {
  const options = new Map();
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (flag === "--help") {
      if (args.length !== 1) throw new Error("Använd --help utan andra parametrar.");
      return null;
    }
    if (!VALUE_FLAGS.has(flag)) throw new Error(`Okänd parameter: ${flag}.`);
    if (options.has(flag)) throw new Error(`Parametern ${flag} har angetts flera gånger.`);
    const value = args[++index];
    if (!value || value.startsWith("--")) throw new Error(`Värde saknas för ${flag}.`);
    options.set(flag, value);
  }
  const missing = REQUIRED.filter((flag) => !options.has(flag));
  if (missing.length) throw new Error(`Obligatoriska parametrar saknas: ${missing.join(", ")}.`);
  if (!["usa", "stockholm"].includes(options.get("--market"))) throw new Error("--market ska vara usa eller stockholm.");
  if (!["BREAKOUT", "PULLBACK"].includes(options.get("--setup"))) throw new Error("--setup ska vara BREAKOUT eller PULLBACK.");
  if (options.has("--benchmark") !== options.has("--benchmark-ticker")) throw new Error("--benchmark och --benchmark-ticker ska anges tillsammans.");

  const integer = (flag, minimum, maximum = Number.MAX_SAFE_INTEGER) => {
    const text = options.get(flag);
    const value = Number(text);
    if (!/^\d+$/.test(text) || !Number.isSafeInteger(value) || value < minimum || value > maximum) {
      throw new Error(`${flag} ska vara ett heltal mellan ${minimum} och ${maximum}.`);
    }
    return value;
  };
  const nonnegative = (flag) => {
    const text = options.get(flag);
    const value = Number(text);
    if (!text.trim() || !Number.isFinite(value) || value < 0) throw new Error(`${flag} ska vara ett ändligt tal som är minst 0.`);
    return value;
  };
  const holdingSessions = integer("--holding", 1, 5);
  const quantity = integer("--quantity", 1);
  const feePerOrder = nonnegative("--fee");
  const slippageBps = nonnegative("--slippage-bps");
  if (!Number.isFinite(feePerOrder * 2)) throw new Error("--fee är för stor för att beräkna båda orderavgifterna.");
  if (slippageBps >= 10000) throw new Error("--slippage-bps ska vara mindre än 10000.");
  const asOf = options.get("--as-of");
  const iso = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/.exec(asOf);
  const dateOnly = iso ? Date.parse(`${iso[1]}T00:00:00Z`) : NaN;
  if (!iso || !Number.isFinite(Date.parse(asOf)) || !Number.isFinite(dateOnly) ||
      new Date(dateOnly).toISOString().slice(0, 10) !== iso[1] ||
      Number(iso[2]) > 23 || Number(iso[3]) > 59 || Number(iso[4] || 0) > 59) {
    throw new Error("--as-of ska vara en giltig ISO-klocka med tidszon, exempelvis 2026-09-29T23:00:00Z.");
  }
  const benchmarkTicker = options.get("--benchmark-ticker")?.trim().toUpperCase() || null;
  if (options.has("--benchmark-ticker") && !benchmarkTicker) throw new Error("--benchmark-ticker får inte vara tom.");
  return {
    input: options.get("--input"), output: options.get("--output"), benchmark: options.get("--benchmark") || null,
    replay: { market: options.get("--market"), setup: options.get("--setup"), holdingSessions, quantity,
      feePerOrder, slippageBps, asOf, benchmarkTicker, marketContextMode: options.has("--benchmark") ? "required" : "off" },
  };
}

async function readJson(path) {
  let content;
  try { content = await readFile(path, "utf8"); }
  catch (error) { throw new Error(`Kunde inte läsa JSON-filen ${path} (${error.code || "läsfel"}).`); }
  try { return JSON.parse(content.replace(/^\uFEFF/, "")); }
  catch { throw new Error(`Filen ${path} innehåller ogiltig JSON.`); }
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (!options) { process.stdout.write(HELP); return; }
  const marketData = await readJson(options.input);
  const benchmarkData = options.benchmark ? await readJson(options.benchmark) : null;
  const report = runSwingReplay({ ...options.replay, marketData, benchmarkData });
  // Preserve the explicit run clock and CLI options even in an INVALID diagnostic report.
  const output = { ...report, simulation: true, runConfig: { ...options.replay } };
  try { await writeFile(options.output, `${JSON.stringify(output, null, 2)}\n`, { flag: "wx", encoding: "utf8" }); }
  catch (error) {
    if (error.code === "EEXIST") throw new Error(`Rapportfilen ${options.output} finns redan. Välj en ny --output; inget skrevs över.`);
    throw new Error(`Kunde inte skriva rapportfilen ${options.output} (${error.code || "skrivfel"}).`);
  }
  if (report.status === "INVALID") {
    process.stderr.write(`Ogiltigt simuleringstest: ${(report.reasons || []).join(" ")}\nDiagnostik sparad: ${options.output}\n`);
    process.exitCode = 1;
    return;
  }
  const count = report.metrics?.tradeCount ?? 0;
  const net = report.metrics?.totalNetPnl;
  process.stdout.write(`Experimentell simulering: ${count} stängda och ${report.openTrades?.length || 0} öppna simuleringar.\n`);
  if (typeof net === "number" && Number.isFinite(net)) process.stdout.write(`Netto i stängda simuleringar: ${net.toFixed(2)} ${report.currency || ""}.\n`);
  process.stdout.write(`Rapport sparad: ${options.output}\n`);
}

main().catch((error) => {
  process.stderr.write(`Fel: ${error.message}\nVisa anvisningar med node scripts/backtest.js --help.\n`);
  process.exitCode = 1;
});
