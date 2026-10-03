import React, { useEffect, useRef, useState } from "react";
import { PAPER_BASIS, createPaperObservation, paperObservationBasis, settlePaperObservation, summarizePaperObservations } from "./paperModel.js";
import { PAPER_STORAGE_KEY, decodePaperLog, encodePaperLog, loadPaperLog, mergePaperLogs, updatePaperLog } from "./paperStorage.js";

const CONTROL = "border border-cyan-800 bg-slate-950 text-slate-100 rounded px-3 py-2 text-sm";
const LABELS = { PENDING_ENTRY: "Väntar på framtida dagskurs", PENDING_OPEN: "Öppen simulering", REJECTED_ENTRY: "Ingång avvisad", CLOSED: "Simulerat avslutad", NOT_ASSESSED: "Kan inte bedömas med nuvarande data" };
const formatted = (value) => Number.isFinite(value) ? value.toLocaleString("sv-SE", { maximumFractionDigits: 2 }) : "—";

function initialState() {
  try { return { records: loadPaperLog(window.localStorage), storageError: "" }; }
  catch (error) { return { records: [], storageError: `Den lokala paperloggen kunde inte läsas: ${error.message} Inga poster har skrivits över.` }; }
}

export default function PaperJournal({ latestAnalysis }) {
  const [state, setState] = useState(initialState);
  const [setup, setSetup] = useState("");
  const [holding, setHolding] = useState("3");
  const [quantity, setQuantity] = useState("");
  const [fee, setFee] = useState("");
  const [slippage, setSlippage] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const importInput = useRef(null);
  const basis = paperObservationBasis(latestAnalysis);
  const candidate = basis !== null;
  const technicalOnly = basis === PAPER_BASIS.TECHNICAL_ONLY;
  const plans = candidate ? latestAnalysis.strategy.plans : [];
  const selectedSetup = plans.some((plan) => plan.setup === setup) ? setup : plans[0]?.setup || "";

  useEffect(() => {
    const syncFromOtherTab = (event) => {
      if (event.key !== PAPER_STORAGE_KEY && event.key !== null) return;
      try {
        const records = loadPaperLog(window.localStorage);
        setState({ records, storageError: "" });
      } catch (problem) {
        setState((previous) => ({ ...previous, storageError: `Den lokala paperloggen ändrades i en annan flik men kunde inte läsas: ${problem.message} Inga poster har skrivits över.` }));
      }
    };
    window.addEventListener("storage", syncFromOtherTab);
    return () => window.removeEventListener("storage", syncFromOtherTab);
  }, []);

  useEffect(() => {
    const data = latestAnalysis?.marketData;
    if (!data || data.interval !== "1day" || state.storageError || !state.records.length) return;
    let active = true;
    updatePaperLog(window.localStorage, navigator.locks, (current) => current.map((record) => {
      if (record.ticker !== data.ticker || record.market !== latestAnalysis.market || record.exchange !== data.exchange || record.currency !== data.currency || record.timezone !== data.timezone || ["CLOSED", "REJECTED_ENTRY"].includes(record.status)) return record;
      return settlePaperObservation(record, data);
    })).then((records) => {
      if (active) setState((previous) => JSON.stringify(previous.records) === JSON.stringify(records) ? previous : { records, storageError: "" });
    }).catch((problem) => {
      if (active) setError(`Paperutfallet kunde inte kontrolleras eller lagras lokalt: ${problem.message}`);
    });
    return () => { active = false; };
  }, [latestAnalysis?.record?.trade_id, latestAnalysis?.marketData, latestAnalysis?.market, state.records, state.storageError]);

  async function saveCandidate(event) {
    event.preventDefault(); setError(""); setNotice("");
    if (state.storageError) { setError(state.storageError); return; }
    if (![quantity, fee, slippage].every((value) => value.trim())) { setError("Ange antal, avgift och slippage uttryckligen, även om kostnaden är noll."); return; }
    try {
      const next = await updatePaperLog(window.localStorage, navigator.locks, (current) => {
        const record = createPaperObservation(latestAnalysis, { setup: selectedSetup, holdingSessions: Number(holding), quantity: Number(quantity), feePerOrder: Number(fee), slippageBps: Number(slippage) });
        if (current.some((item) => item.id === record.id)) throw new Error("Det här upplägget från samma analys finns redan i paperloggen.");
        return [...current, record];
      });
      setState({ records: next, storageError: "" });
      setNotice(technicalOnly
        ? "Det tekniska upplägget är låst och sparat lokalt. Nyheter påverkar inte beslutet; ingen affär har genomförts."
        : "Bevakningskandidaten är låst och sparad lokalt. Den är ingen TRADE-signal eller genomförd affär.");
    } catch (problem) { setError(problem.message); }
  }

  function exportLog() {
    try {
      const records = loadPaperLog(window.localStorage);
      const json = encodePaperLog(records);
      setState({ records, storageError: "" });
      const url = URL.createObjectURL(new Blob([json], { type: "application/json" }));
      const link = document.createElement("a");
      link.href = url; link.download = `paperlog-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.append(link); link.click(); link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      setNotice("En kopia av den lokala paperloggen laddades ned."); setError("");
    } catch (problem) { setError(problem.message); }
  }

  async function importLog(event) {
    const file = event.target.files?.[0];
    if (!file) return;
    setError(""); setNotice("");
    try {
      if (state.storageError) throw new Error(state.storageError);
      if (file.size > 750_000) throw new Error("Importfilen är för stor.");
      const incoming = decodePaperLog(await file.text());
      let added = 0;
      const next = await updatePaperLog(window.localStorage, navigator.locks, (current) => {
        const merged = mergePaperLogs(current, incoming);
        added = merged.length - current.length;
        return merged;
      });
      setState({ records: next, storageError: "" });
      setNotice(`${added} nya paperobservationer importerades. Befintliga poster ändrades inte.`);
    } catch (problem) { setError(`Importen avbröts: ${problem.message}`); }
    finally { if (importInput.current) importInput.current.value = ""; }
  }

  const summary = summarizePaperObservations(state.records);
  return <section className="border border-slate-800 rounded-lg p-4 space-y-3" aria-label="Paperlogg">
    <h2 className="font-semibold">Paperlogg · experimentell</h2>
    <p className="text-xs text-slate-400">Paperobservationer sparas bara i den här webbläsaren på denna preview-adress. De synkas inte mellan datorer eller till Supabase. Exportera en JSON-kopia för att flytta eller säkerhetskopiera loggen.</p>
    <p className="text-xs text-amber-300">En paperobservation är en förhandslåst simulering, ingen TRADE-signal eller riktig order. Endast avslutade simuleringar får ett vinst- eller förlustutfall; NO TRADE räknas aldrig som vinst.</p>
    {candidate && <details className="border-t border-slate-800 pt-3">
      <summary className="cursor-pointer text-cyan-300">{technicalOnly ? "Spara teknisk BEVAKA-kandidat lokalt" : "Spara aktuell BEVAKA-kandidat lokalt"}</summary>
      {technicalOnly && <p className="text-xs text-amber-300 mt-3">Detta är en teknisk paperobservation för att mäta upplägget. Nyheter påverkar inte beslutet. AVVAKTA är ingen godkänd TRADE-signal eller order.</p>}
      <form className="grid gap-3 sm:grid-cols-2 mt-3 text-sm" onSubmit={saveCandidate}>
        <label>Upplägg<select className={`${CONTROL} block w-full mt-1`} value={selectedSetup} onChange={(event) => setSetup(event.target.value)}>{plans.map((plan) => <option value={plan.setup} key={plan.setup}>{plan.setup}</option>)}</select></label>
        <label>Max observerade sessioner<select className={`${CONTROL} block w-full mt-1`} value={holding} onChange={(event) => setHolding(event.target.value)}>{[1, 2, 3, 4, 5].map((value) => <option value={value} key={value}>{value}</option>)}</select></label>
        <label>Fast simulerat aktieantal<input className={`${CONTROL} block w-full mt-1`} type="number" min="1" step="1" required value={quantity} onChange={(event) => setQuantity(event.target.value)} /></label>
        <label>Avgift per order ({latestAnalysis.marketData?.currency || "valuta"})<input className={`${CONTROL} block w-full mt-1`} type="number" min="0" step="any" required value={fee} onChange={(event) => setFee(event.target.value)} /></label>
        <label>Slippage i baspunkter<input className={`${CONTROL} block w-full mt-1`} type="number" min="0" max="9999" step="any" required value={slippage} onChange={(event) => setSlippage(event.target.value)} /></label>
        <button className="rounded border border-cyan-700 px-4 py-2 disabled:opacity-40" disabled={Boolean(state.storageError)}>Spara paperobservation</button>
      </form>
      <p className="text-xs text-slate-400 mt-3">När du senare analyserar samma aktie igen kontrolleras nya färdigställda dagskurser. Ingen bakgrundsbevakning eller extra API-förfrågan startas av loggen.</p>
    </details>}
    <div className="flex flex-wrap gap-3 items-center text-sm">
      <button className={CONTROL} onClick={exportLog} disabled={!state.records.length}>Exportera JSON-kopia</button>
      <label className="text-slate-300">Importera JSON-kopia<input ref={importInput} className="block mt-1 text-xs" type="file" accept=".json,application/json" onChange={importLog} disabled={Boolean(state.storageError)} /></label>
    </div>
    {state.storageError && <p role="alert" className="text-red-300 text-sm">{state.storageError}</p>}
    {error && <p role="alert" className="text-red-300 text-sm">{error}</p>}
    {notice && <p role="status" className="text-cyan-300 text-sm">{notice}</p>}
    <p className="text-sm">{summary.totalCount} observationer · {summary.closedCount} avslutade · {summary.pendingEntryCount + summary.pendingOpenCount} väntar/öppna · {summary.rejectedEntryCount} avvisade ingångar · {summary.notAssessedCount} utan bedömbara data.</p>
    {!state.records.length && <p className="text-sm text-slate-400">Inga paperobservationer ännu.</p>}
    {(summary.groups || []).map((group) => <div className="border border-slate-800 rounded p-3 text-sm" key={JSON.stringify([group.paperVersion, group.strategyVersion, group.setup, group.currency, group.basis])}>
      <p className="font-medium">{group.paperVersion} · {group.strategyVersion} · {group.setup} · {group.currency} · {group.basis === PAPER_BASIS.TECHNICAL_ONLY ? "tekniskt upplägg" : "äldre nyhetsstyrt upplägg"}</p>
      <p className="mt-1">{group.closedCount} avslutade · {group.wins} vinster · {group.losses} förluster · vinstandel {formatted(group.winRatePercent)}{group.winRatePercent === null ? "" : "%"}</p>
      <p>Simulerat netto {formatted(group.totalNetPnl)} {group.currency} · avgifter {formatted(group.totalFees)} {group.currency} · medelutfall {formatted(group.expectancyR)}R.</p>
    </div>)}
    {state.records.length > 0 && <details className="border-t border-slate-800 pt-3 text-sm"><summary className="cursor-pointer text-cyan-300">Se paperobservationer</summary>
      <div className="divide-y divide-slate-800 mt-2">{[...state.records].reverse().slice(0, 20).map((record) => <article key={record.id} className="py-2">
        <p className="font-medium">{record.ticker} · {record.setup} · {LABELS[record.status] || record.status}</p>
        <p className="text-xs text-slate-400">Signal {record.signalDate} · {record.strategyVersion} · {record.currency} · max {record.holdingSessions} sessioner · {record.version === "paper-forward-v0.3" ? "tekniskt AVVAKTA, nyheter ej beslutsgrundande" : record.basis === PAPER_BASIS.TECHNICAL_ONLY ? "äldre tekniskt test, NO TRADE" : "äldre test med nyhetsanalys"}</p>
        {record.status === "CLOSED" && <p>Simulerat netto {formatted(record.netPnl)} {record.currency} · {formatted(record.resultR)}R · utgång {record.exitDate}.</p>}
        {record.status === "NOT_ASSESSED" && <p className="text-xs text-amber-300">{record.assessmentError}</p>}
      </article>)}</div>
      {state.records.length > 20 && <p className="text-xs text-slate-400">De senaste 20 visas här. Exportfilen innehåller alla {state.records.length}.</p>}
    </details>}
  </section>;
}
