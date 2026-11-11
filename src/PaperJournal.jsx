import React, { useEffect, useRef, useState } from "react";
import PaperCloudPanel from "./PaperCloudPanel.jsx";
import TradingViewPaperLedger from "./TradingViewPaperLedger.jsx";
import { resolvePaperCloudConfig } from "./paperCloudClient.js";
import { MAX_PAPER_FOLLOWUP_SYMBOLS, planPaperFollowup, runPaperFollowup } from "./paperFollowup.js";
import { PAPER_BASIS, createPaperObservation, paperObservationBasis, summarizePaperObservations } from "./paperModel.js";
import { PAPER_STORAGE_KEY, decodePaperLog, encodePaperLog, findDuplicatePaperSignal, loadPaperLog, mergePaperLogs, updatePaperLog } from "./paperStorage.js";

const CONTROL = "border border-cyan-800 bg-slate-950 text-slate-100 rounded px-3 py-2 text-sm";
const LABELS = { PENDING_ENTRY: "Väntar på framtida dagskurs", PENDING_OPEN: "Öppen simulering", REJECTED_ENTRY: "Ingång avvisad", CLOSED: "Simulerat avslutad", NOT_ASSESSED: "Kan inte bedömas med nuvarande data" };
const CLOUD_ENABLED = resolvePaperCloudConfig().enabled;
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
  const [followupBusy, setFollowupBusy] = useState(false);
  const [followupClock, setFollowupClock] = useState(Date.now);
  const [showCloudSync, setShowCloudSync] = useState(false);
  const importInput = useRef(null);
  const basis = paperObservationBasis(latestAnalysis);
  const candidate = basis !== null;
  const technicalOnly = basis === PAPER_BASIS.TECHNICAL_ONLY;
  const plans = candidate ? latestAnalysis.strategy.plans : [];
  const selectedSetup = plans.some((plan) => plan.setup === setup) ? setup : plans[0]?.setup || "";
  const selectedPlan = plans.find((plan) => plan.setup === selectedSetup);

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
    const timer = window.setInterval(() => setFollowupClock(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);

  async function saveCandidate(event) {
    event.preventDefault(); setError(""); setNotice("");
    if (state.storageError) { setError(state.storageError); return; }
    if (![quantity, fee, slippage].every((value) => value.trim())) { setError("Ange antal, avgift och slippage uttryckligen, även om kostnaden är noll."); return; }
    try {
      const next = await updatePaperLog(window.localStorage, navigator.locks, (current) => {
        const record = createPaperObservation(latestAnalysis, { setup: selectedSetup, holdingSessions: Number(holding), quantity: Number(quantity), feePerOrder: Number(fee), slippageBps: Number(slippage) });
        if (findDuplicatePaperSignal(current, record)) throw new Error("Samma aktie, upplägg och signaldatum finns redan i paperloggen. En ny analys ger inte en ny paperaffär.");
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

  async function checkPaperOutcomes() {
    if (followupBusy || state.storageError) return;
    setFollowupBusy(true); setError(""); setNotice("");
    try {
      const result = await runPaperFollowup({ storage: window.localStorage, lockManager: navigator.locks });
      setState({ records: loadPaperLog(window.localStorage), storageError: "" });
      setFollowupClock(Date.now());
      if (result.error) {
        setError(`Uppföljningen stoppades vid ${result.error.ticker}: ${result.error.message} ${result.checkedSymbols} instrument hann kontrolleras. Redan sparade uppdateringar finns kvar lokalt.`);
      } else if (result.attemptedRequests === 0) {
        setNotice("Ingen ny stängd handelssession finns att kontrollera för de öppna observationerna ännu. Inga dataanrop gjordes.");
      } else {
        setNotice(`${result.checkedSymbols} instrument kontrollerades med ${result.attemptedRequests} dataanrop; ${result.updatedRecords} observationer uppdaterades lokalt. ${result.deferredSymbols ? `${result.deferredSymbols} instrument återstår till nästa kontroll. ` : ""}Exportera gärna en JSON-kopia som backup.`);
      }
    } catch (problem) {
      setError(`Paperuppföljningen kunde inte slutföras: ${problem.message}`);
    } finally { setFollowupBusy(false); }
  }

  const summary = summarizePaperObservations(state.records);
  const followupPlan = state.storageError ? null : planPaperFollowup(state.records, { now: followupClock });
  return <section className="border border-slate-800 rounded-lg p-4 space-y-3" aria-label="Paperlogg">
    <h2 className="font-semibold">Paperlogg · experimentell</h2>
    <p className="text-xs text-slate-400">{CLOUD_ENABLED
      ? "Paperobservationer sparas i den här webbläsaren. Exportera en JSON-kopia som backup. Valfri molnsynk kan öppnas nedan om du senare vill flytta loggen."
      : "Paperobservationer sparas bara i den här webbläsaren på denna preview-adress. De synkas inte mellan datorer eller till Supabase. Exportera en JSON-kopia för att flytta eller säkerhetskopiera loggen."}</p>
    <p className="text-xs text-amber-300">En paperobservation är en förhandslåst simulering, ingen TRADE-signal eller riktig order. Statistiken bygger på lokalt skapade eller importerade poster utan oberoende verifiering. Endast avslutade simuleringar får ett vinst- eller förlustutfall; NO TRADE räknas aldrig som vinst.</p>
    {candidate && <details className="border-t border-slate-800 pt-3">
      <summary className="cursor-pointer text-cyan-300">{technicalOnly ? "Spara teknisk BEVAKA-kandidat lokalt" : "Spara aktuell BEVAKA-kandidat lokalt"}</summary>
      {technicalOnly && <p className="text-xs text-amber-300 mt-3">Detta är en teknisk paperobservation för att mäta upplägget. Nyheter påverkar inte beslutet. AVVAKTA är ingen godkänd TRADE-signal eller order.</p>}
      {selectedPlan && <p className="text-xs text-cyan-300 mt-2">TradingView-paperprov: signalens referenspris {formatted(selectedPlan.entry_reference)}, stopp {formatted(selectedPlan.stop)} och mål {formatted(selectedPlan.target)} {latestAnalysis.marketData?.currency}. Ett fiktivt köp nästa session räknas bara som inom planen när fyllnadspriset ligger över stopp och under mål. Terminalen lägger ingen order.</p>}
      <p className="text-xs text-slate-400 mt-3">Lås observationen efter den valda börsens stängning, innan nästa handelssession öppnar. Använd samma innehavstid, antal, avgift och slippage under testet så att resultaten går att jämföra.</p>
      <form className="grid gap-3 sm:grid-cols-2 mt-3 text-sm" onSubmit={saveCandidate}>
        <label>Upplägg<select className={`${CONTROL} block w-full mt-1`} value={selectedSetup} onChange={(event) => setSetup(event.target.value)}>{plans.map((plan) => <option value={plan.setup} key={plan.setup}>{plan.setup}</option>)}</select></label>
        <label>Max observerade sessioner<select className={`${CONTROL} block w-full mt-1`} value={holding} onChange={(event) => setHolding(event.target.value)}>{[1, 2, 3, 4, 5].map((value) => <option value={value} key={value}>{value}</option>)}</select></label>
        <label>Fast simulerat aktieantal<input className={`${CONTROL} block w-full mt-1`} type="number" min="1" step="1" required value={quantity} onChange={(event) => setQuantity(event.target.value)} /></label>
        <label>Avgift per order ({latestAnalysis.marketData?.currency || "valuta"})<input className={`${CONTROL} block w-full mt-1`} type="number" min="0" step="any" required value={fee} onChange={(event) => setFee(event.target.value)} /></label>
        <label>Slippage i baspunkter<input className={`${CONTROL} block w-full mt-1`} type="number" min="0" max="9999" step="any" required value={slippage} onChange={(event) => setSlippage(event.target.value)} /></label>
        <button className="rounded border border-cyan-700 px-4 py-2 disabled:opacity-40" disabled={Boolean(state.storageError)}>Spara paperobservation</button>
      </form>
      <p className="text-xs text-slate-400 mt-3">Nya färdigställda dagskurser kontrolleras bara när du trycker på paperuppföljningen nedan. Ingen bakgrundsbevakning startas.</p>
    </details>}
    {followupPlan && followupPlan.openRecords > 0 && <div className="border border-slate-800 rounded p-3 space-y-2 text-sm" aria-label="Paperuppföljning">
      <h3 className="font-semibold">Följ upp öppna paperposter</h3>
      <p className="text-slate-400">{followupPlan.openRecords} öppna observationer · {followupPlan.waitingRecords} väntar på en senare stängd handelssession. {followupPlan.totalSymbols} instrument kan kontrolleras nu.</p>
      <p className="text-amber-300">Ett klick kan göra högst {MAX_PAPER_FOLLOWUP_SYMBOLS} sekventiella marknadsdataanrop ({followupPlan.targets.length} planerade nu). Varje anrop kan förbruka API-kvot. Resultaten sparas lokalt i den här webbläsaren.</p>
      <button className={CONTROL} onClick={checkPaperOutcomes} disabled={followupBusy || followupPlan.targets.length === 0}>{followupBusy ? "Kontrollerar paperposter…" : "Kontrollera öppna paperposter"}</button>
      {followupPlan.deferredSymbols > 0 && <p className="text-slate-400">{followupPlan.deferredSymbols} ytterligare instrument får kontrolleras vid ett senare klick.</p>}
    </div>}
    <div className="flex flex-wrap gap-3 items-center text-sm">
      <button className={CONTROL} onClick={exportLog} disabled={!state.records.length}>Exportera JSON-kopia</button>
      <label className="text-slate-300">Importera JSON-kopia<input ref={importInput} className="block mt-1 text-xs" type="file" accept=".json,application/json" onChange={importLog} disabled={Boolean(state.storageError)} /></label>
    </div>
    {CLOUD_ENABLED && <div className="border-t border-slate-800 pt-3">
      <button type="button" className="text-sm text-cyan-300" onClick={() => setShowCloudSync((visible) => !visible)}>{showCloudSync ? "Dölj valfri molnsynk" : "Visa valfri molnsynk"}</button>
    </div>}
    {showCloudSync && <PaperCloudPanel localCount={state.storageError ? null : state.records.length} onSynced={(records) => setState({ records, storageError: "" })} />}
    {state.storageError && <p role="alert" className="text-red-300 text-sm">{state.storageError}</p>}
    {error && <p role="alert" className="text-red-300 text-sm">{error}</p>}
    {notice && <p role="status" className="text-cyan-300 text-sm">{notice}</p>}
    <p className="text-sm">{summary.totalCount} observationer · {summary.closedCount} avslutade · {summary.pendingEntryCount + summary.pendingOpenCount} väntar/öppna · {summary.rejectedEntryCount} avvisade ingångar · {summary.notAssessedCount} utan bedömbara data.</p>
    {!state.records.length && <p className="text-sm text-slate-400">Inga paperobservationer ännu.</p>}
    {(summary.groups || []).map((group) => <div className="border border-slate-800 rounded p-3 text-sm" key={JSON.stringify([group.paperVersion, group.strategyVersion, group.setup, group.currency, group.basis, group.holdingSessions, group.quantity, group.feePerOrder, group.slippageBps])}>
      <p className="font-medium">{group.paperVersion} · {group.strategyVersion} · {group.setup} · {group.currency} · {group.basis === PAPER_BASIS.TECHNICAL_ONLY ? "tekniskt upplägg" : "äldre nyhetsstyrt upplägg"}</p>
      <p className="text-xs text-slate-400">Max {group.holdingSessions} sessioner · {group.quantity} aktier · avgift {formatted(group.feePerOrder)} {group.currency}/order · slippage {formatted(group.slippageBps)} bp</p>
      <p className="mt-1">{group.closedCount} avslutade simuleringar · {group.wins} positiva utfall · {group.losses} negativa utfall</p>
      <p>Simulerat netto {formatted(group.totalNetPnl)} {group.currency} · avgifter {formatted(group.totalFees)} {group.currency} · medelutfall {formatted(group.expectancyR)}R.</p>
      <p className="text-xs text-amber-300">Underlag: {group.closedCount} avslutade paperobservationer. Utfallen är inte oberoende verifierade och visar inte strategins träffsäkerhet.</p>
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
    <TradingViewPaperLedger observations={state.storageError ? [] : state.records} />
  </section>;
}
