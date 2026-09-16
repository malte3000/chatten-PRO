import React, { useEffect, useRef, useState } from "react";
import { normalizeTicker, evaluateReadiness, createAnalysisRecord } from "./analysisModel.js";
import MarketScanner from "./MarketScanner.jsx";

const LABELS = { TRADE: "TRADE", WAIT: "AVVAKTA", NO_TRADE: "NO TRADE" };
const CONTROL = "border border-cyan-800 bg-slate-950 text-slate-100 rounded px-3 py-2 text-sm";

async function request(url, options = {}) {
  const response = await fetch(url, { credentials: "include", ...options });
  const data = await response.json();
  if (!response.ok) throw new Error(data.message || data.error || "Förfrågan misslyckades");
  return data;
}

function Details({ title, children }) {
  return <details className="border-t border-slate-800 mt-3 pt-3 text-sm">
    <summary className="cursor-pointer text-cyan-300">Se mer – {title}</summary>
    <div className="mt-3 space-y-3 text-slate-300">{children}</div>
  </details>;
}

export default function App() {
  const [mode, setMode] = useState("scan");
  const [exchange, setExchange] = useState("");
  const [ticker, setTicker] = useState("");
  const [horizon, setHorizon] = useState("week");
  const [market, setMarket] = useState("usa");
  const [image, setImage] = useState(null);
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [saveState, setSaveState] = useState("idle");
  const [history, setHistory] = useState([]);
  const [historyError, setHistoryError] = useState("");
  const [historyLoading, setHistoryLoading] = useState(false);
  const revision = useRef(0);
  const controller = useRef(null);
  const fileInput = useRef(null);
  const historyRevision = useRef(0);

  async function refreshHistory() {
    const version = ++historyRevision.current;
    setHistoryLoading(true); setHistoryError("");
    try {
      const data = await request("/api/trades");
      if (!Array.isArray(data.trades)) throw new Error("Journalens svar är ogiltigt");
      if (version === historyRevision.current) setHistory(data.trades);
    } catch (error) {
      if (version === historyRevision.current) setHistoryError(error.message);
    } finally {
      if (version === historyRevision.current) setHistoryLoading(false);
    }
  }

  useEffect(() => {
    void refreshHistory();
    return () => { controller.current?.abort(); revision.current++; historyRevision.current++; };
  }, []);

  function invalidate() {
    revision.current++; controller.current?.abort();
    setBusy(false); setResult(null); setSaveState("idle"); setNotice("");
  }

  function changeTicker(value) {
    invalidate(); setTicker(value); setImage(null); setExchange("");
    if (fileInput.current) fileInput.current.value = "";
  }

  function selectImage(event) {
    const file = event.target.files?.[0];
    if (!file) return;
    invalidate();
    const version = revision.current;
    setImage(null);
    if (!file.type.startsWith("image/") || file.size > 4 * 1024 * 1024) {
      setNotice("Välj en bild mindre än 4 MB."); event.target.value = ""; return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      if (version !== revision.current) return;
      setImage({ preview: reader.result, base64: reader.result.split(",")[1], type: file.type, confirmed: false });
      setNotice(`Bekräfta att grafen gäller ${normalizeTicker(ticker)}. Systemet identifierar inte tickern från bilden.`);
    };
    reader.onerror = () => { if (version === revision.current) setNotice("Bilden kunde inte läsas."); };
    reader.readAsDataURL(file);
  }

  async function persist(snapshot) {
    setSaveState("saving");
    try {
      await request("/api/trades", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(snapshot.record) });
      if (snapshot.version === revision.current) setSaveState("saved");
      void refreshHistory();
    } catch (error) {
      if (snapshot.version === revision.current) { setSaveState("failed"); setNotice(`Analysen kunde inte sparas: ${error.message}`); }
    }
  }

  async function start(override = null) {
    if (!normalizeTicker(override?.symbol || ticker) || busy || (!override && image && !image.confirmed)) return;
    invalidate();
    const version = revision.current;
    const abort = new AbortController(); controller.current = abort;
    setBusy(true);
    const currentTicker = normalizeTicker(override?.symbol || ticker);
    const currentExchange = override?.exchange || exchange;
    const horizonText = horizon === "week" ? "1–5 handelsdagar (swingtrading)" : "samma handelsdag (daytrading)";
    const post = (url, body) => request(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: abort.signal });
    try {
      const responses = await Promise.allSettled([
        request(`/api/market-data?ticker=${encodeURIComponent(currentTicker)}&exchange=${encodeURIComponent(currentExchange)}&interval=${horizon === "week" ? "1day" : "15min"}&outputsize=100`, { signal: abort.signal }),
        post("/api/analyze-news", { ticker: currentTicker, companyName: override?.name, exchange: currentExchange, horizonText, market }),
        !override && image ? post("/api/analyze-image", { ticker: currentTicker, imageBase64: image.base64, imageMediaType: image.type, market }) : Promise.resolve(null),
      ]);
      if (version !== revision.current) return;
      const values = responses.map((response) => response.status === "fulfilled" ? response.value : null);
      const errors = responses.slice(0, 2).flatMap((response, index) => response.status === "rejected" ? [`${index === 0 ? "Marknadsdata" : "Nyheter"}: ${response.reason.message}`] : []);
      const analysis = { ticker: currentTicker, horizon: horizonText, market, marketData: values[0], news: values[1], chart: values[2] };
      analysis.decision = evaluateReadiness({ ...analysis, errors });
      if (responses[2].status === "rejected") analysis.chartError = responses[2].reason.message;
      const snapshot = { ...analysis, version, record: createAnalysisRecord(analysis) };
      setResult(snapshot); await persist(snapshot);
    } catch (error) {
      if (version === revision.current) setNotice(`Analysen misslyckades. Ingen trade godkändes: ${error.message}`);
    } finally {
      if (version === revision.current) setBusy(false);
    }
  }

  return <main className="min-h-screen text-slate-200 p-4 md:p-8">
    <div className="max-w-3xl mx-auto space-y-5">
      <header>
        <p className="text-xs tracking-widest text-cyan-400">SWINGTRADING // ANALYSFÖRHANDSVISNING</p>
        <h1 className="text-2xl font-semibold mt-2">Sannolikhetsterminal</h1>
        <p className="text-sm text-slate-400 mt-2">Ett analysflöde. Tydligt beslut. Hellre avstå än gissa.</p>
      </header>
      <nav className="flex flex-wrap gap-2" aria-label="Analysläge">
        <button aria-pressed={mode === "scan"} className={CONTROL} onClick={() => { invalidate(); setMode("scan"); }}>Skanna marknaden</button>
        <button aria-pressed={mode === "analysis"} className={CONTROL} onClick={() => { invalidate(); setMode("analysis"); }}>Analysera en aktie</button>
      </nav>
      <section className="border border-cyan-900 rounded-lg p-4 space-y-3" aria-label="Starta analys">
        <div className="grid gap-3 sm:grid-cols-3">
          {mode === "analysis" && <label className="text-xs text-slate-400">Aktie / ticker
            <input className={`${CONTROL} block w-full mt-1`} value={ticker} onChange={(event) => changeTicker(event.target.value)} placeholder="t.ex. NVDA" maxLength={20} />
          </label>}
          <label className="text-xs text-slate-400">Tidshorisont
            <select className={`${CONTROL} block w-full mt-1`} value={horizon} onChange={(event) => { invalidate(); setHorizon(event.target.value); }}>
              <option value="week">Swing · 1–5 handelsdagar</option><option value="day">Daytrade · under dagen</option>
            </select>
          </label>
          <label className="text-xs text-slate-400">Marknad (välj aktiens börs)
            <select className={`${CONTROL} block w-full mt-1`} value={market} onChange={(event) => { invalidate(); setMarket(event.target.value); }}>
              <option value="usa">USA</option><option value="stockholm">Sverige · Stockholm</option><option value="off">Av · endast analys</option>
            </select>
          </label>
        </div>
        {mode === "analysis" && <button className="rounded bg-cyan-300 text-slate-950 px-5 py-3 font-semibold disabled:opacity-40" disabled={busy || !normalizeTicker(ticker) || Boolean(image && !image.confirmed)} onClick={() => start()}>{busy ? "Hämtar data och analyserar…" : "Starta analys"}</button>}
        <p className="text-xs text-slate-400">Nyheter hämtas även när börsen är stängd.</p>
        {market === "off" && <p className="text-xs text-amber-300">Marknadskontrollen är av för analysen. Detta ändrar inte datakällans börs och kringgår inte riskregler eller TRADE-spärren.</p>}
        {mode === "analysis" && <Details title="valfri graf">
          <p>Tickern måste vara korrekt. En uppladdad bild bevisar inte vilket instrument den visar.</p>
          <input ref={fileInput} type="file" accept="image/*" disabled={!normalizeTicker(ticker) || busy} onChange={selectImage} />
          {image && <><img src={image.preview} alt={`Graf som användaren kopplat till ${normalizeTicker(ticker)}`} className="max-h-64 w-full object-contain" /><button className={CONTROL} onClick={() => { invalidate(); setImage(null); fileInput.current.value = ""; }}>Ta bort graf</button></>}
          {image && <label className="block"><input type="checkbox" checked={image.confirmed} disabled={busy} onChange={(event) => { invalidate(); setImage({ ...image, confirmed: event.target.checked }); }} /> Jag bekräftar att grafen visar {normalizeTicker(ticker)}.</label>}
        </Details>}
      </section>
      {mode === "scan" && <MarketScanner market={market} horizon={horizon} onSaved={refreshHistory} onAnalyze={(item) => {
        invalidate(); setMode("analysis"); setTicker(item.symbol); setExchange(item.exchange); setImage(null);
        if (fileInput.current) fileInput.current.value = "";
        void start(item);
      }} />}
      {notice && <p role="status" className="text-sm text-amber-300">{notice}</p>}
      {result && <section className="border border-cyan-900 rounded-lg p-4" aria-label="Samlad analys">
        <div className="flex justify-between gap-3"><h2 className="font-semibold">{result.ticker} · Samlad analys</h2><span className="text-cyan-300 font-bold">{LABELS[result.decision.status]}</span></div>
        <ul className="text-sm text-slate-300 mt-3 space-y-1 list-disc pl-5">{result.decision.reasons.map((reason) => <li key={reason}>{reason}</li>)}</ul>
        {result.news && <p className="text-sm mt-3 text-slate-400">{result.news.summary || result.news.reasoning?.slice(0, 220) || "Nyhetsanalysen saknar sammanfattning."}</p>}
        <p role="status" className="text-xs text-slate-400 mt-3">{saveState === "saved" ? "Analysförslaget är sparat i journalen. Ingen faktisk trade har registrerats." : saveState === "saving" ? "Sparar analysförslag…" : "Inte sparat i journalen."}</p>
        {saveState === "failed" && <button className={`${CONTROL} mt-2`} onClick={() => persist(result)}>Försök spara igen</button>}
        <Details title="nyheter, graf och data">
          <h3 className="font-semibold">Nyhetsanalys</h3><p className="whitespace-pre-wrap">{result.news?.reasoning || "Nyhetsanalys saknas."}</p>
          {result.news?.magnitude_note && <p>{result.news.magnitude_note}</p>}
          <ul className="list-disc pl-5">{result.news?.key_news?.map((item, index) => <li key={index}>[{item.impact}] {item.headline}</li>)}</ul>
          <p className="text-xs text-slate-400">AI:ns riktningssäkerhet: {result.news?.direction_confidence ?? "saknas"}. Detta är inte uppmätt träffsäkerhet eller sannolikhet för vinst.</p>
          {result.chartError && <p>Grafanalys: {result.chartError}</p>}
          <h3 className="font-semibold">Fullständig analysoutput och datasnapshot</h3>
          <pre className="text-xs whitespace-pre-wrap break-all max-h-96 overflow-auto">{JSON.stringify({ news: result.news, chart: result.chart, marketData: result.marketData }, null, 2)}</pre>
        </Details>
      </section>}
      <section className="border border-slate-800 rounded-lg p-4" aria-label="Journal">
        <div className="flex justify-between items-center"><h2 className="font-semibold">Senaste analyser och trades</h2><button className={CONTROL} disabled={historyLoading} onClick={refreshHistory}>{historyLoading ? "Hämtar…" : "Uppdatera"}</button></div>
        <p className="text-xs text-amber-300 mt-3">Nuvarande inloggning är gemensam. Journalen är inte personlig ännu. Analysförslag räknas inte som genomförda trades eller vinster.</p>
        {historyError && <p role="alert" className="text-sm text-red-300 mt-3">Journalen kunde inte hämtas: {historyError}</p>}
        {!historyError && !historyLoading && !history.length && <p className="text-sm text-slate-400 mt-3">Inga sparade poster.</p>}
        <div className="mt-3 divide-y divide-slate-800">{history.slice(0, 5).map((trade) => {
          const analysis = trade.signal_inputs?.record_type === "ANALYSIS";
          const scan = trade.signal_inputs?.record_type === "SCAN";
          const decision = trade.signal_inputs?.decision;
          return <article key={trade.trade_id} className="py-3 text-sm">
            <div className="flex justify-between gap-3"><span>{trade.ticker}</span><span>{scan ? "Skanningsrapport" : analysis ? LABELS[decision?.status] || "NO TRADE" : `Äldre post · ${trade.signal}`}</span></div>
            <p className="text-xs text-slate-400 mt-1">{new Date(trade.timestamp).toLocaleString("sv-SE")} · {scan ? `${trade.signal_inputs.checked} aktier kontrollerade · ${trade.signal_inputs.complete ? "komplett urval" : "ofullständig"}` : analysis ? "Analysförslag" : trade.trade_status}</p>
            {!analysis && trade.trade_status === "CLOSED" && Number.isFinite(trade.result_percent) && <p>Registrerat utfall: {trade.result_percent.toFixed(2)}%</p>}
            <Details title="journalpost"><pre className="text-xs whitespace-pre-wrap break-all max-h-64 overflow-auto">{JSON.stringify(trade, null, 2)}</pre></Details>
          </article>;
        })}</div>
      </section>
      <footer className="text-xs text-slate-500">Prototyp, inte en validerad handelsstrategi. Risk Engine, personlig tradeuppföljning och produktdata för derivat återstår. Ingen träffsäkerhet utlovas.</footer>
    </div>
  </main>;
}
