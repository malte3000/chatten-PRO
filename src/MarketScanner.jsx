import React, { useEffect, useRef, useState } from "react";
import { rankCandidates, SCREEN_VERSION } from "./screening.js";
import { fetchJson } from "./apiClient.js";
import NewsEvidence from "./NewsEvidence.jsx";

const LABELS = { WAIT: "AVVAKTA", NO_TRADE: "NO TRADE", NOT_ASSESSED: "EJ BEDÖMT · KURSDATA EJ VERIFIERAD" };

async function api(url, body, signal) {
  return fetchJson(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal });
}

function pause(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new DOMException("Avbruten", "AbortError")); return; }
    const done = () => { signal.removeEventListener("abort", abort); resolve(); };
    const timer = setTimeout(done, ms);
    const abort = () => { clearTimeout(timer); reject(new DOMException("Avbruten", "AbortError")); };
    signal.addEventListener("abort", abort, { once: true });
  });
}

export default function MarketScanner({ market, horizon, onAnalyze, onSaved }) {
  const [limit, setLimit] = useState(20);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState("");
  const [report, setReport] = useState(null);
  const [error, setError] = useState("");
  const [saveState, setSaveState] = useState("idle");
  const [record, setRecord] = useState(null);
  const [creditUsage, setCreditUsage] = useState(null);
  const [creditUsageBusy, setCreditUsageBusy] = useState(false);
  const [creditUsageError, setCreditUsageError] = useState("");
  const revision = useRef(0);
  const controller = useRef(null);

  function reset() {
    revision.current++; controller.current?.abort();
    setBusy(false); setReport(null); setError(""); setProgress(""); setSaveState("idle"); setRecord(null);
  }
  useEffect(() => {
    reset();
    return () => { revision.current++; controller.current?.abort(); };
  }, [market, horizon]);

  async function save(snapshot, version) {
    setSaveState("saving");
    try {
      await api("/api/trades", snapshot);
      if (version === revision.current) setSaveState("saved");
      onSaved();
    } catch (problem) {
      if (version === revision.current) {
        if (problem.code === "PREVIEW_READ_ONLY") setSaveState("read_only");
        else { setSaveState("failed"); setError(`Skanningen kunde inte sparas: ${problem.message}`); }
      }
    }
  }

  async function showCreditUsage() {
    if (creditUsageBusy) return;
    setCreditUsageBusy(true);
    setCreditUsageError("");
    try {
      const usage = await fetchJson("/api/credit-usage", { method: "GET", cache: "no-store" });
      if (!Number.isSafeInteger(usage.current_usage) || !Number.isSafeInteger(usage.plan_limit)) {
        throw new Error("Twelve Data returnerade inte läsbara kreditvärden.");
      }
      setCreditUsage(usage);
    } catch (problem) {
      setCreditUsage(null);
      setCreditUsageError(problem.message);
    } finally {
      setCreditUsageBusy(false);
    }
  }

  async function start() {
    if (busy || market === "off") return;
    reset();
    const version = revision.current;
    const abort = new AbortController(); controller.current = abort;
    setBusy(true);
    const seed = new Date().toISOString().slice(0, 10);
    let offset = 0;
    let results = [];
    let universeSize = 0;
    let target = limit;
    let complete = false;
    let scanError = "";
    try {
      let quotaRetries = 0;
      while (!complete) {
        setProgress(`Kontrollerar aktier · ${offset}/${target}…`);
        let batch;
        try { batch = await api("/api/scan", { market, horizon, limit, offset, seed }, abort.signal); }
        catch (problem) {
          if (problem.status === 429 && problem.retryMs && quotaRetries < 2) {
            quotaRetries++;
            setProgress(`Databudgeten är upptagen. Väntar ${Math.ceil(problem.retryMs / 1000)} sekunder · ${offset}/${target}.`);
            await pause(Math.min(problem.retryMs, 120000), abort.signal); continue;
          }
          throw problem;
        }
        if (!Array.isArray(batch.results) || !Number.isInteger(batch.next_offset) || batch.next_offset <= offset || batch.next_offset > limit) throw new Error("Skannerns svar är ogiltigt.");
        quotaRetries = 0;
        offset = batch.next_offset; target = batch.total; universeSize = batch.universe_size;
        // Keep the technical result visible if a later news request fails.
        results = rankCandidates([...results, ...batch.results.map((item) => ({ ...item, screening_status: item.status }))]);
        complete = batch.done === true;
        if (version !== revision.current) return;
        setReport({ results, checked: offset, target, universeSize, complete: false, seed });
        if (!complete) {
          setProgress(`Väntar på databudget · ${offset}/${target} aktier kontrollerade. Du kan stoppa skanningen.`);
          await pause(Math.max(0, Math.min(batch.wait_ms || 0, 120000)), abort.signal);
        }
      }
      const shortlist = results.filter((item) => item.status === "WAIT").slice(0, 3);
      for (let index = 0; index < shortlist.length; index++) {
        const item = shortlist[index];
        setProgress(`Analyserar nyheter · ${index + 1}/${shortlist.length} kandidater…`);
        try {
          const news = await api("/api/analyze-news", { ticker: item.symbol, companyName: item.name, exchange: item.exchange, horizonText: horizon === "week" ? "1–5 handelsdagar (swingtrading)" : "samma handelsdag", market }, abort.signal);
          if (news.ticker !== item.symbol || !["upp", "ner", "oklart"].includes(news.direction)) throw new Error("Nyhetsanalysen matchar inte kandidaten.");
          item.news = news;
          if (news.direction === "ner") { item.status = "NO_TRADE"; item.reasons = [...item.reasons, "Nyhetsläget talar mot en lång position."]; }
        } catch (problem) {
          if (abort.signal.aborted) throw problem;
          item.status = "NO_TRADE"; item.news_error = problem.message;
          item.reasons = [...item.reasons, `Nyhetsanalysen misslyckades: ${problem.message}`];
        }
      }
    } catch (problem) {
      if (version !== revision.current) return;
      complete = false;
      scanError = abort.signal.aborted ? "Skanningen stoppades. Resultatet är ofullständigt." : problem.message;
      setError(scanError);
    } finally {
      if (version === revision.current) {
        const final = { results: rankCandidates(results), checked: offset, target, universeSize, complete, seed, scanError };
        const assessedCount = final.results.filter((item) => item.status === "WAIT" || item.status === "NO_TRADE").length;
        const unavailableCount = final.results.filter((item) => item.status === "NOT_ASSESSED").length;
        const scanStatus = assessedCount === 0 ? "NOT_ASSESSED" : unavailableCount > 0 ? "PARTIALLY_ASSESSED" : "ASSESSED";
        setReport(offset > 0 ? final : null); setBusy(false); setProgress("");
        if (offset > 0) {
          const snapshot = {
            trade_id: `SCAN-${crypto.randomUUID()}`, strategy_version: SCREEN_VERSION,
            ticker: market === "usa" ? "SCAN-USA" : "SCAN-SE", timestamp: new Date().toISOString(),
            signal: "NO_TRADE", direction: "NONE", confidence: 0, trade_status: "NO_TRADE",
            risk_engine_status: "NOT_EVALUATED", winner: null, result_percent: null,
            signal_inputs: { record_type: "SCAN", market, horizon, ...final, scan_status: scanStatus, probability_calibrated: false },
            learning_tags: ["screening_only"], detected_errors: scanError ? [scanError] : [],
          };
          setRecord(snapshot); void save(snapshot, version);
        }
      }
    }
  }

  const candidates = report?.results.filter((item) => item.status === "WAIT") || [];
  const technicalCandidates = report?.results.filter((item) => item.screening_status === "WAIT") || [];
  const newsErrors = technicalCandidates.filter((item) => item.news_error);
  const rejected = report?.results.filter((item) => item.status === "NO_TRADE") || [];
  const unavailable = report?.results.filter((item) => item.status === "NOT_ASSESSED") || [];
  return <section className="border border-cyan-900 rounded-lg p-4 space-y-3" aria-label="Marknadsskanner">
    <div className="flex flex-wrap gap-3 items-end">
      <label className="text-xs text-slate-400">Skanningsbudget
        <select className="block mt-1 border border-cyan-800 bg-slate-950 rounded px-3 py-2 text-sm text-slate-100" value={limit} disabled={busy} onChange={(event) => { reset(); setLimit(Number(event.target.value)); }}>
          <option value={20}>20 aktier</option><option value={40}>40 aktier</option><option value={100}>100 aktier</option>
        </select>
      </label>
      <button className="rounded bg-cyan-300 text-slate-950 px-5 py-3 font-semibold disabled:opacity-40" disabled={busy || market === "off"} onClick={start}>{busy ? "Skannar…" : "Skanna marknaden"}</button>
      {busy && <button className="border border-slate-700 rounded px-3 py-2" onClick={() => controller.current?.abort()}>Stoppa</button>}
      <button className="border border-cyan-800 rounded px-3 py-2 text-sm text-cyan-300 disabled:opacity-40" disabled={busy || creditUsageBusy} onClick={showCreditUsage}>{creditUsageBusy ? "Läser krediter…" : "Visa API-krediter"}</button>
    </div>
    <p className="text-xs text-slate-400">Kreditkontrollen görs bara när du klickar och kostar själv 1 Twelve Data-kredit.</p>
    {creditUsage && <div role="status" className="text-sm text-slate-200">
      <p>Twelve Data: {creditUsage.current_usage} av {creditUsage.plan_limit} API-krediter använda under aktuell minut.</p>
      {Number.isSafeInteger(creditUsage.daily_usage) && Number.isSafeInteger(creditUsage.plan_daily_limit) && <p>{creditUsage.daily_usage} av {creditUsage.plan_daily_limit} använda under aktuell UTC-dag.</p>}
      <p className="text-xs text-slate-400">Avläst {creditUsage.fetched_at ? new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Stockholm", dateStyle: "short", timeStyle: "medium" }).format(new Date(creditUsage.fetched_at)) : "just nu"} (svensk tid).</p>
    </div>}
    {creditUsageError && <p role="alert" className="text-sm text-amber-300">Kunde inte visa API-krediter: {creditUsageError}</p>}
    <p className="text-xs text-slate-400">Automatiskt urval av stödda aktier, inte hela börsen. Ett nytt klick samma UTC-dag ger normalt samma aktier; en större budget utökar urvalet. Skanningen kan ta flera minuter på grund av API-kvoten. Nyheter hämtas för högst tre kandidater.</p>
    {market === "off" && <p className="text-sm text-amber-300">Välj USA eller Sverige för att ange vilken marknad som ska skannas. Av finns kvar för manuell analys.</p>}
    <p className="text-xs text-slate-400">Skannern försöker utesluta warranter och certifikat, men datakällans produktklassning behöver verifieras. Separat produktdata och riskkontroll krävs för dem.</p>
    {market === "stockholm" && <p className="text-xs text-slate-400">Sveriges aktielista kan innehålla instrument utan tillgänglig prisdata. De markeras EJ BEDÖMT; ingen teknisk slutsats dras.</p>}
    {progress && <p role="status" className="text-sm text-cyan-300">{progress}</p>}
    {error && <p role="alert" className="text-sm text-amber-300">{error}</p>}
    {report && <>
      <h2 className="font-semibold">{report.checked}/{report.target} kontrollerade · {report.universeSize} i datakällans aktielista</h2>
      <p className="text-xs text-slate-400">{busy ? "Pågående skanning" : report.complete ? "Urvalet färdigskannat" : "Ofullständig skanning"} · {technicalCandidates.length} tekniska kandidater · {candidates.length} kvar som AVVAKTA{newsErrors.length > 0 ? ` · ${newsErrors.length} med nyhetsfel` : ""} · {rejected.length} NO TRADE · {unavailable.length} ej bedömda (kursdata ej verifierad). Inga godkända TRADE-signaler.</p>
      {!busy && report.checked > 0 && !technicalCandidates.length && <p className="text-sm">{rejected.length === 0
        ? `EJ BEDÖMT · Ingen av de ${report.checked} kontrollerade aktierna kunde bedömas med tillgänglig prisdata.`
        : report.complete
          ? `NO TRADE för de ${rejected.length} bedömda aktierna i det här urvalet. Ingen blev analyskandidat.`
          : `Ofullständigt urval · Hittills ingen analyskandidat bland de ${rejected.length} bedömda aktierna.`}
        {unavailable.length > 0 && rejected.length > 0 && ` ${unavailable.length} ${unavailable.length === 1 ? "aktie" : "aktier"} kunde inte bedömas eftersom kursdata inte kunde verifieras.`} Övriga {Math.max(0, report.universeSize - report.checked)} aktier i datakällans lista har inte kontrollerats.</p>}
      {technicalCandidates.slice(0, 5).map((item) => <article key={`${item.symbol}:${item.exchange}`} className="border-t border-slate-800 pt-3 space-y-2 text-sm">
        <div className="flex flex-wrap justify-between gap-2"><h3 className="font-semibold">{item.symbol} · {item.name}</h3><span className="text-cyan-300">{LABELS[item.status]}</span></div>
        <p className="text-xs text-slate-400">{item.exchange} · {item.currency} · Filterpoäng {item.rank_score}/4, inte vinstsannolikhet</p>
        {item.metrics?.price && <p className="text-xs text-slate-400">Senaste candlepris: {item.metrics.price.toFixed(2)} {item.currency} · {item.metrics.latest_datetime} {item.data_snapshot?.timestamp_kind === "exchange_session_date" || horizon === "week" ? "(sessionsdatum)" : "UTC"}</p>}
        <p>{item.news_error ? `Tekniskt upplägg hittat, men nyhetsanalysen misslyckades: ${item.news_error}` : item.news?.summary || "Tekniska försöksfilter uppfyllda. Nyhetsanalys " + (busy ? "kan återstå." : "saknas för denna kandidat.")}</p>
        <NewsEvidence news={item.news} />
        <button className="border border-cyan-800 rounded px-3 py-2 disabled:opacity-40" disabled={busy} onClick={() => onAnalyze(item)}>Öppna samlad analys</button>
        <details><summary className="cursor-pointer text-cyan-300">Se mer – tester och nyheter</summary>
          <ul className="list-disc pl-5 mt-2">{item.reasons.map((reason) => <li key={reason}>{reason}</li>)}</ul>
          {item.news && <p className="whitespace-pre-wrap mt-2">{item.news.reasoning}</p>}
          <pre className="text-xs whitespace-pre-wrap break-all max-h-64 overflow-auto mt-2">{JSON.stringify({ metrics: item.metrics, news: item.news || null, data_snapshot: item.data_snapshot || null }, null, 2)}</pre>
        </details>
      </article>)}
      <details className="border-t border-slate-800 pt-3"><summary className="cursor-pointer text-sm text-cyan-300">Se mer – alla {report.results.length} instrument och bedömningar</summary>
        <p className="text-xs text-slate-400 mt-2">{horizon === "week"
          ? "Försöksfilter för swing: pris över EMA20 över EMA50, positivt femdagarsmomentum och antingen rekyl mot EMA20 eller utbrott över 20-dagars högsta med minst 1,2 gånger medianvolymen. ATR 0,2–8 procent och tillräcklig omsättning krävs. Bara färdigställda dagskurser används."
          : "Försöksfilter för daytrade: pris över EMA20 över EMA50, positivt fem-candle-momentum, RVOL minst 1, ATR 0,2–8 procent och tillräcklig candle-omsättning. Senaste 15-minuterscandle kan vara ofullständig."} Ingen validerad edge eller uppmätt träffsäkerhet.</p>
        {report.results.map((item) => <div className="text-xs mt-3" key={`${item.symbol}:${item.exchange}`}><strong className={item.status === "NOT_ASSESSED" ? "text-amber-300" : undefined}>{item.symbol} · {item.exchange} · {LABELS[item.status]}</strong><p>{item.reasons.join(" ")}</p></div>)}
      </details>
      <p role="status" className="text-xs text-slate-400">{saveState === "saved" ? "Skanningsrapporten är sparad i journalen, separat från faktiska trades." : saveState === "saving" ? "Sparar skanningsrapport…" : saveState === "read_only" ? "Skanningsresultatet visas här, men previewns gemensamma journal är skrivskyddad. En BEVAKA-kandidat kan sparas separat i den lokala paperloggen efter samlad analys." : "Skanningen är inte sparad."}</p>
      {saveState === "failed" && record && <button className="text-sm text-cyan-300" onClick={() => save(record, revision.current)}>Försök spara skanningen igen</button>}
    </>}
  </section>;
}
