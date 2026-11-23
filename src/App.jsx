import React, { useEffect, useRef, useState } from "react";
import { normalizeTicker, evaluateReadiness, createAnalysisRecord, createRealTradeRecord } from "./analysisModel.js";
import { fetchJson } from "./apiClient.js";
import { assessSwingSetup } from "./strategyModel.js";
import { calculatePositionSize } from "./riskModel.js";
import { swingSignalValidity } from "./signalValidity.js";
import MarketScanner from "./MarketScanner.jsx";
import PerformanceSummary from "./PerformanceSummary.jsx";
import HistoricalReplay from "./HistoricalReplay.jsx";
import StatisticalAnalysis from "./StatisticalAnalysis.jsx";
import PaperJournal from "./PaperJournal.jsx";
import NewsEvidence from "./NewsEvidence.jsx";
import SignalJournal from "./SignalJournal.jsx";
import { appendSignalLog, signalFromAnalysis } from "./signalLog.js";

const LABELS = { TRADE: "TRADE · EXPERIMENTELL", WAIT: "AVVAKTA", NO_TRADE: "NO TRADE", NOT_ASSESSED: "EJ BEDÖMT" };
const SETUP_LABELS = { PULLBACK: "rekyl mot EMA20", BREAKOUT: "20-dagarsutbrott", RANGE_BREAKOUT: "kort konsolideringsutbrott", REBOUND: "återhämtning i upptrend" };
const CONTROL = "border border-cyan-800 bg-slate-950 text-slate-100 rounded px-3 py-2 text-sm";
const ALLOWED_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);
const MAX_IMAGE_BYTES = 3 * 1024 * 1024;

async function request(url, options = {}) {
  return fetchJson(url, options);
}

function Details({ title, children }) {
  return <details className="border-t border-slate-800 mt-3 pt-3 text-sm">
    <summary className="cursor-pointer text-cyan-300">Se mer – {title}</summary>
    <div className="mt-3 space-y-3 text-slate-300">{children}</div>
  </details>;
}

const MARKET_CLOCK_LABELS = {
  open: "öppen",
  after_close: "stängd efter dagens handel",
  before_open: "ännu inte öppen",
  weekend: "helgstängd",
  holiday: "helgdagsstängd",
};

function SwingDataCheck({ result, signalValidity }) {
  const { marketData, marketStatus, strategy } = result;
  const latestDate = marketData?.latest?.datetime || marketData?.bars?.at(-1)?.datetime || null;
  return <div className="border border-slate-800 rounded p-3 mt-3 text-sm" aria-label="Datakontroll för swing">
    <div className="flex justify-between gap-3"><h3 className="font-semibold">Datakontroll</h3><span className={strategy.status === "NOT_ASSESSED" || (signalValidity && signalValidity.status !== "CURRENT") ? "text-amber-300" : "text-slate-300"}>{signalValidity && signalValidity.status !== "CURRENT" ? "HISTORISK BEDÖMNING" : strategy.status === "NOT_ASSESSED" ? "EJ BEDÖMT" : "BEDÖMD"}</span></div>
    {marketData
      ? <>
        <p className="mt-1">Senaste levererade dagskurs: <strong>{latestDate || "saknas"}</strong>{marketData.exchange ? ` · ${marketData.exchange}` : ""}.</p>
        {marketData.excluded_current_session && <p className="text-slate-400">Dagens ofärdiga dagskurs uteslöts.</p>}
        {marketData.fetched_at && <p className="text-slate-400">Data hämtad: {marketData.fetched_at}.</p>}
      </>
      : <p className="mt-1 text-amber-300">Marknadsdata saknas. Se felorsaken ovan.</p>}
    {marketStatus
      ? <p className="text-slate-400">Börsklocka: {MARKET_CLOCK_LABELS[marketStatus.reason] || marketStatus.label || "status okänd"}{marketStatus.sessionDate ? ` · lokalt börsdatum ${marketStatus.sessionDate}` : ""}.</p>
      : <p className="text-amber-300">{result.market === "off" ? "Marknadskontrollen är av; swingupplägget bedöms inte." : "Börsklockan kunde inte verifieras. Se felorsaken ovan."}</p>}
    {strategy.status === "NOT_ASSESSED" && <p className="text-amber-300 mt-1">Regeln kunde inte bedöma detta underlag. Ingen slutsats om affärsläget har dragits.</p>}
  </div>;
}

function RealTradeForm({ analysis, onSave }) {
  const [direction, setDirection] = useState("LONG");
  const [entry, setEntry] = useState("");
  const [stop, setStop] = useState("");
  const [target, setTarget] = useState("");
  const [size, setSize] = useState("");
  const [fees, setFees] = useState("0");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  async function submit(event) {
    event.preventDefault(); setError(""); setSaving(true);
    try {
      const record = createRealTradeRecord({ analysis, direction, entryPrice: entry, stopLoss: stop, target, positionSize: size, fees });
      await onSave(record); setSaved(true);
    } catch (problem) { setError(problem.message); }
    finally { setSaving(false); }
  }
  return <Details title="registrera en faktisk trade">
    <p>Registrera bara en affär som du själv faktiskt har lagt. En TRADE-signal är ett tekniskt förslag och lägger ingen order.</p>
    {saved ? <p role="status">Faktisk trade sparad som öppen.</p> : <form className="grid gap-3 sm:grid-cols-2" onSubmit={submit}>
      <label>Riktning<select className={`${CONTROL} block w-full mt-1`} value={direction} onChange={(event) => setDirection(event.target.value)}><option value="LONG">Lång</option><option value="SHORT">Kort</option></select></label>
      <label>Faktiskt ingångspris<input className={`${CONTROL} block w-full mt-1`} type="number" min="0.000001" step="any" required value={entry} onChange={(event) => setEntry(event.target.value)} /></label>
      <label>Stoppris, om satt<input className={`${CONTROL} block w-full mt-1`} type="number" min="0.000001" step="any" value={stop} onChange={(event) => setStop(event.target.value)} /></label>
      <label>Målpris, om satt<input className={`${CONTROL} block w-full mt-1`} type="number" min="0.000001" step="any" value={target} onChange={(event) => setTarget(event.target.value)} /></label>
      <label>Antal aktier/enheter<input className={`${CONTROL} block w-full mt-1`} type="number" min="0.000001" step="any" required value={size} onChange={(event) => setSize(event.target.value)} /></label>
      <label>Avgift vid ingång ({analysis.marketData?.currency || "kontovaluta"})<input className={`${CONTROL} block w-full mt-1`} type="number" min="0" step="any" value={fees} onChange={(event) => setFees(event.target.value)} /></label>
      {error && <p role="alert" className="sm:col-span-2 text-red-300">{error}</p>}
      <button className="sm:col-span-2 rounded bg-cyan-300 text-slate-950 px-4 py-2 font-semibold disabled:opacity-40" disabled={saving}>{saving ? "Sparar…" : "Spara faktisk trade"}</button>
    </form>}
  </Details>;
}

function CloseTradeForm({ trade, onClose }) {
  const [exit, setExit] = useState("");
  const [fees, setFees] = useState("0");
  const [reason, setReason] = useState("MANUAL");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  async function submit(event) {
    event.preventDefault(); setError(""); setSaving(true);
    try { await onClose({ trade_id: trade.trade_id, exit_price: Number(exit), fees: Number(fees), exit_reason: reason }); }
    catch (problem) { setError(problem.message); }
    finally { setSaving(false); }
  }
  return <Details title="registrera utgång">
    <form className="grid gap-3 sm:grid-cols-2" onSubmit={submit}>
      <label>Faktiskt utgångspris<input className={`${CONTROL} block w-full mt-1`} type="number" min="0.000001" step="any" required value={exit} onChange={(event) => setExit(event.target.value)} /></label>
      <label>Avgift vid utgång ({trade.signal_inputs?.currency || "kontovaluta"})<input className={`${CONTROL} block w-full mt-1`} type="number" min="0" step="any" value={fees} onChange={(event) => setFees(event.target.value)} /></label>
      <label>Avslutsorsak<select className={`${CONTROL} block w-full mt-1`} value={reason} onChange={(event) => setReason(event.target.value)}><option value="TARGET">Mål</option><option value="STOP_LOSS">Stop</option><option value="MANUAL">Manuellt</option><option value="TIME_EXIT">Tidsgräns</option><option value="SIGNAL_REVERSAL">Signal vände</option><option value="END_OF_DAY">Sessionsslut</option><option value="OTHER">Annat</option></select></label>
      {error && <p role="alert" className="sm:col-span-2 text-red-300">{error}</p>}
      <button className="sm:col-span-2 border border-cyan-700 rounded px-4 py-2 disabled:opacity-40" disabled={saving}>{saving ? "Sparar…" : "Stäng och beräkna utfall"}</button>
    </form>
    <p className="text-xs text-slate-500">Nettoresultat beräknas från riktning, priser, storlek samt ingångs- och utgångsavgifter.</p>
  </Details>;
}

function RiskCalculator({ plan, currency }) {
  const [capital, setCapital] = useState("");
  const [riskPercent, setRiskPercent] = useState("");
  const [fees, setFees] = useState("0");
  const calculation = calculatePositionSize({ capital, riskPercent, entry: plan.entry_reference, stop: plan.stop, estimatedFees: fees });
  const money = (value) => `${Number(value).toFixed(2)} ${currency || "valuta"}`;
  return <Details title={`${SETUP_LABELS[plan.setup] || plan.setup} · provisorisk riskplan`}>
    <p>Referenspris {money(plan.entry_reference)} · tänkt stop {money(plan.stop)} · teoretiskt mål {money(plan.target)} · {plan.theoretical_risk_reward}R före kostnader. Nivåerna utgår från senaste stängda dagskurs och måste jämföras med faktiskt ingångspris.</p>
    <div className="grid gap-3 sm:grid-cols-3">
      <label>Kontokapital ({currency || "valuta"})<input className={`${CONTROL} block w-full mt-1`} type="number" min="0.01" step="any" value={capital} onChange={(event) => setCapital(event.target.value)} /></label>
      <label>Max risk per trade (%)<input className={`${CONTROL} block w-full mt-1`} type="number" min="0.01" max="100" step="any" value={riskPercent} onChange={(event) => setRiskPercent(event.target.value)} /></label>
      <label>Uppskattade avgifter ({currency || "valuta"})<input className={`${CONTROL} block w-full mt-1`} type="number" min="0" step="any" value={fees} onChange={(event) => setFees(event.target.value)} /></label>
    </div>
    {calculation.status === "CALCULATED" && <p role="status">Kalkyl: högst {calculation.max_shares} hela aktier · planerad risk {money(calculation.planned_risk)} · positionsvärde {money(calculation.position_value)}.</p>}
    {calculation.status !== "CALCULATED" && <p className="text-xs text-slate-400">{calculation.reason}</p>}
    <p className="text-xs text-amber-300">Kalkylatorn är inte ett godkännande, rekommendation eller validerad Risk Engine. Den modellerar inte spread, gap eller slippage.</p>
  </Details>;
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
  const [signalLogError, setSignalLogError] = useState("");
  const [saveState, setSaveState] = useState("idle");
  const [newsLoading, setNewsLoading] = useState(false);
  const [history, setHistory] = useState([]);
  const [historyLoaded, setHistoryLoaded] = useState(false);
  const [historyError, setHistoryError] = useState("");
  const [historyLoading, setHistoryLoading] = useState(false);
  const [displayNow, setDisplayNow] = useState(() => Date.now());
  const revision = useRef(0);
  const controller = useRef(null);
  const newsController = useRef(null);
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
      if (version === historyRevision.current) { setHistoryLoading(false); setHistoryLoaded(true); }
    }
  }

  useEffect(() => {
    return () => { controller.current?.abort(); newsController.current?.abort(); revision.current++; historyRevision.current++; };
  }, []);

  useEffect(() => {
    const update = () => setDisplayNow(Date.now());
    const timer = window.setInterval(update, 5000);
    window.addEventListener("focus", update);
    document.addEventListener("visibilitychange", update);
    return () => { window.clearInterval(timer); window.removeEventListener("focus", update); document.removeEventListener("visibilitychange", update); };
  }, []);

  function invalidate() {
    revision.current++; controller.current?.abort(); newsController.current?.abort();
    setBusy(false); setNewsLoading(false); setResult(null); setSaveState("idle"); setNotice(""); setSignalLogError("");
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
    if (!ALLOWED_IMAGE_TYPES.has(file.type) || file.size > MAX_IMAGE_BYTES) {
      setNotice("Välj en JPEG-, PNG-, WebP- eller GIF-bild på högst 3 MB."); event.target.value = ""; return;
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
      if (snapshot.version === revision.current) {
        if (error.code === "PREVIEW_READ_ONLY") setSaveState("read_only");
        else { setSaveState("failed"); setNotice(`Analysen kunde inte sparas: ${error.message}`); }
      }
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
        request(`/api/market-data?ticker=${encodeURIComponent(currentTicker)}&exchange=${encodeURIComponent(currentExchange)}&interval=${horizon === "week" ? "1day" : "15min"}&outputsize=100${horizon === "week" && ["usa", "stockholm"].includes(market) ? `&verify_stock=1&market=${encodeURIComponent(market)}` : ""}`, { signal: abort.signal, cache: "no-store" }),
        !override && image ? post("/api/analyze-image", { ticker: currentTicker, imageBase64: image.base64, imageMediaType: image.type, market }) : Promise.resolve(null),
        horizon === "week" && ["usa", "stockholm"].includes(market)
          ? request(`/api/market-status?market=${encodeURIComponent(market)}`, { signal: abort.signal, cache: "no-store" })
          : Promise.resolve(null),
      ]);
      if (version !== revision.current) return;
      const values = responses.map((response) => response.status === "fulfilled" ? response.value : null);
      const errors = responses[0].status === "rejected" ? [`Marknadsdata: ${responses[0].reason.message}`] : [];
      if (responses[2].status === "rejected") errors.push(`Börsklocka: ${responses[2].reason.message}`);
      const assessedAt = Date.now();
      const analysis = {
        ticker: currentTicker, companyName: override?.name || values[0]?.verified_instrument?.name || null, horizon: horizonText, horizonCode: horizon, market,
        evaluatedAt: new Date(assessedAt).toISOString(),
        marketData: values[0], marketStatus: values[2], news: null, chart: values[1],
        newsRequested: false, newsError: null,
        strategy: horizon === "week" ? assessSwingSetup(values[0], { ticker: currentTicker, marketStatus: values[2], now: assessedAt }) : null,
      };
      analysis.decision = evaluateReadiness({ ...analysis, errors, now: assessedAt });
      if (responses[1].status === "rejected") analysis.chartError = responses[1].reason.message;
      const snapshot = { ...analysis, version, record: createAnalysisRecord(analysis) };
      setResult(snapshot);
      if (analysis.decision.status === "TRADE") {
        try {
          const entry = signalFromAnalysis(analysis, analysis.evaluatedAt);
          await appendSignalLog(window.localStorage, navigator.locks, [entry]);
          window.dispatchEvent(new Event("signal-log-updated"));
        } catch (problem) {
          if (version === revision.current) setSignalLogError(`TRADE-signalen visas, men kunde inte sparas i den lokala signalloggen: ${problem.message}`);
        }
      }
      await persist(snapshot);
    } catch (error) {
      if (version === revision.current) setNotice(`Analysen misslyckades. Ingen trade godkändes: ${error.message}`);
    } finally {
      if (version === revision.current) setBusy(false);
    }
  }

  async function loadOptionalNews(snapshot) {
    if (!snapshot || newsLoading) return;
    newsController.current?.abort();
    const abort = new AbortController(); newsController.current = abort;
    const version = snapshot.version;
    setNewsLoading(true);
    setResult((current) => current?.version === version ? { ...current, newsRequested: true, newsError: null } : current);
    try {
      const news = await request("/api/analyze-news", {
        method: "POST", headers: { "Content-Type": "application/json" }, signal: abort.signal,
        body: JSON.stringify({ ticker: snapshot.ticker, companyName: snapshot.companyName, exchange: snapshot.marketData?.exchange, horizonText: snapshot.horizon, market: snapshot.market }),
      });
      if (version === revision.current) setResult((current) => current?.version === version ? { ...current, news, newsError: null } : current);
    } catch (error) {
      if (version === revision.current) setResult((current) => current?.version === version ? { ...current, news: null, newsError: error.message } : current);
    } finally {
      if (version === revision.current) setNewsLoading(false);
    }
  }

  async function saveRealTrade(record) {
    await request("/api/trades", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(record) });
    await refreshHistory();
  }

  async function closeRealTrade(update) {
    await request("/api/trades", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(update) });
    await refreshHistory();
  }

  const resultSignalValidity = result?.decision.status === "TRADE"
    ? swingSignalValidity({ market: result.market, signalDate: result.strategy?.metrics?.latest_closed_candle, now: Math.max(displayNow, Date.now()) })
    : null;
  const resultStatus = resultSignalValidity && resultSignalValidity.status !== "CURRENT" ? "NOT_ASSESSED" : result?.decision.status;
  const expiredResultSignal = resultSignalValidity && resultSignalValidity.status !== "CURRENT";

  return <main className="min-h-screen text-slate-200 p-4 md:p-8">
    <div className="max-w-3xl mx-auto space-y-5">
      <header>
        <p className="text-xs tracking-widest text-cyan-400">SWINGTRADING // ANALYSFÖRHANDSVISNING</p>
        <h1 className="text-2xl font-semibold mt-2">Sannolikhetsterminal</h1>
        <p className="text-sm text-slate-400 mt-2">Tydliga mönster, kontrollerad risk och uppföljningsbara signaler.</p>
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
        {market === "off" && <p className="text-xs text-amber-300">Marknadskontrollen är av för analysen. Utan verifierad börsklocka kan swinganalysen inte ge en TRADE-signal.</p>}
        {mode === "analysis" && <Details title="valfri graf">
          <p>Tickern måste vara korrekt. En uppladdad bild bevisar inte vilket instrument den visar.</p>
          <input ref={fileInput} type="file" accept="image/jpeg,image/png,image/webp,image/gif" disabled={!normalizeTicker(ticker) || busy} onChange={selectImage} />
          {image && <><img src={image.preview} alt={`Graf som användaren kopplat till ${normalizeTicker(ticker)}`} className="max-h-64 w-full object-contain" /><button className={CONTROL} onClick={() => { invalidate(); setImage(null); fileInput.current.value = ""; }}>Ta bort graf</button></>}
          {image && <label className="block"><input type="checkbox" checked={image.confirmed} disabled={busy} onChange={(event) => { invalidate(); setImage({ ...image, confirmed: event.target.checked }); }} /> Jag bekräftar att grafen visar {normalizeTicker(ticker)}.</label>}
        </Details>}
      </section>
      {mode === "scan" && <MarketScanner market={market} horizon={horizon} now={displayNow} onSaved={refreshHistory} onAnalyze={(item) => {
        invalidate(); setMode("analysis"); setTicker(item.symbol); setExchange(item.exchange); setImage(null);
        if (fileInput.current) fileInput.current.value = "";
        void start(item);
      }} />}
      {notice && <p role="status" className="text-sm text-amber-300">{notice}</p>}
      {signalLogError && <p role="alert" className="text-sm text-red-300">{signalLogError}</p>}
      {result && <section className="border border-cyan-900 rounded-lg p-4" aria-label="Samlad analys">
        <div className="flex justify-between gap-3"><h2 className="font-semibold">{result.ticker} · Samlad analys</h2><span className={expiredResultSignal ? "text-amber-300 font-bold" : "text-cyan-300 font-bold"}>{LABELS[resultStatus] || "EJ BEDÖMT"}</span></div>
        {resultSignalValidity && <p role="status" className={`text-sm mt-2 ${expiredResultSignal ? "text-amber-300" : "text-slate-300"}`}>{expiredResultSignal
          ? `Den tidigare TRADE-signalen från dagskurs ${resultSignalValidity.signalDate || "okänt datum"} är inte längre aktuell. ${resultSignalValidity.status === "EXPIRED" ? "Nästa handelssession har stängt." : "Signalens sessionsdatum kunde inte verifieras."} Gör en ny analys innan du överväger en order.`
          : `Signal baserad på stängd dagskurs ${resultSignalValidity.signalDate}. Gäller längst till stängningen ${resultSignalValidity.expirySession} kl. ${resultSignalValidity.expiryLocalClose} lokal börstid. Kontrollera då aktuell kurs och gör en ny analys.`}</p>}
        <ul className="text-sm text-slate-300 mt-3 space-y-1 list-disc pl-5">{result.decision.reasons.map((reason) => <li key={reason}>{reason}</li>)}</ul>
        {result.strategy && <SwingDataCheck result={result} signalValidity={resultSignalValidity} />}
        {result.strategy && <div className="border border-slate-800 rounded p-3 mt-3" aria-label="Experimentell swingbedömning">
          <div className="flex justify-between gap-3"><h3 className="font-semibold">Swingupplägg · experimentellt</h3><span className={expiredResultSignal ? "text-amber-300" : "text-cyan-300"}>{expiredResultSignal ? "HISTORISKT UPPLÄGG" : result.strategy.status === "WATCH" ? "UPPLÄGG HITTAT" : result.strategy.status === "NO_SETUP" ? "INGET UPPLÄGG" : "EJ BEDÖMT"}</span></div>
          <p className="text-xs text-slate-400 mt-1">{result.strategy.version} · {result.strategy.setups.length ? result.strategy.setups.map((setup) => SETUP_LABELS[setup] || setup).join(" + ") : result.strategy.status === "NO_SETUP" ? "ingen regel uppfylld" : "reglerna kunde inte bedömas"}</p>
          {result.strategy.metrics?.latest_closed_candle && <p className="text-xs text-slate-400 mt-1">Bedömd stängd dagskurs: {result.strategy.metrics.latest_closed_candle}{result.marketData?.excluded_current_session ? " · dagens ofärdiga kurs uteslöts" : ""}.</p>}
          <ul className="text-sm mt-2 list-disc pl-5">{result.strategy.reasons.map((reason) => <li key={reason}>{reason}</li>)}</ul>
          {!expiredResultSignal && result.strategy.plans.map((plan) => <RiskCalculator key={`${result.record.trade_id}-${plan.setup}`} plan={plan} currency={result.marketData?.currency} />)}
          {resultStatus === "TRADE" && <p className="text-sm text-cyan-300 mt-2">Teknisk TRADE-signal för ett kommande ingångsläge. Kontrollera faktiskt pris mot stop och mål innan en order. Du väljer själv om du handlar; terminalen lägger ingen order.</p>}
          {result.strategy.status === "WATCH" && resultStatus !== "TRADE" && !expiredResultSignal && <p className="text-sm text-amber-300 mt-2">Ett mönster hittades men slutbedömningen godkände ingen signal. Se orsaken ovan.</p>}
          <p className="text-xs text-amber-300 mt-2">Reglerna är experimentella och deras träffsäkerhet är inte uppmätt. Stop och positionskalkyl begränsar planerad risk men skyddar inte mot gap och slippage.</p>
          <HistoricalReplay key={result.record.trade_id} marketData={result.marketData} market={market} />
          <StatisticalAnalysis key={`${result.record.trade_id}-statistics`} marketData={result.marketData} market={result.market} ticker={result.ticker} />
        </div>}
        {result.news && <p className="text-sm mt-3 text-slate-400">{result.news.summary || result.news.reasoning?.slice(0, 220) || "Nyhetsanalysen saknar sammanfattning."}</p>}
        {result.newsError && <p role="status" className="text-sm mt-3 text-amber-300">Valfria nyheter kunde inte hämtas: {result.newsError}. Det tekniska beslutet påverkas inte.</p>}
        {(!result.news || result.newsError) && <button className={`${CONTROL} mt-3 disabled:opacity-40`} disabled={newsLoading} onClick={() => loadOptionalNews(result)}>{newsLoading ? "Hämtar valfri nyhetsbakgrund…" : result.newsError ? "Försök hämta nyhetsbakgrund igen" : "Hämta valfri nyhetsbakgrund"}</button>}
        <p className="text-xs text-slate-400 mt-2">Nyhetsbakgrunden hämtas separat efter beslutet och sparas inte i journalposten.</p>
        <NewsEvidence news={result.news} />
        <p role="status" className="text-xs text-slate-400 mt-3">{saveState === "saved" ? "Analysen och beslutet är sparade i journalen. Ingen faktisk trade har registrerats." : saveState === "saving" ? "Sparar analys…" : saveState === "read_only" ? "Analysen visas här, men previewns gemensamma journal är skrivskyddad." : "Inte sparat i journalen."}</p>
        {saveState === "failed" && <button className={`${CONTROL} mt-2`} onClick={() => persist(result)}>Försök spara igen</button>}
        {saveState === "saved" && <RealTradeForm key={result.record.trade_id} analysis={result} onSave={saveRealTrade} />}
        <Details title="nyheter, graf och data">
          <h3 className="font-semibold">Nyheter · valfri bakgrund</h3><p className="whitespace-pre-wrap">{result.news?.reasoning || (newsLoading ? "Nyheter hämtas separat…" : result.newsRequested ? "Nyhetsanalysen kunde inte hämtas." : "Nyheter hämtades inte för den här analysen.")}</p>
          <p className="text-xs text-slate-400">Nyhetsinformationen påverkar inte TRADE/NO TRADE och är inte en validerad handelssignal.</p>
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
        {!historyLoaded && !historyLoading && <p className="text-sm text-slate-400 mt-3">Den gemensamma journalen hämtas bara när du trycker Uppdatera. Signalanalys och lokal paperlogg fungerar även om journalens databas är pausad.</p>}
        {historyError && <p role="alert" className="text-sm text-red-300 mt-3">Journalen kunde inte hämtas: {historyError}</p>}
        {historyLoaded && !historyError && !historyLoading && !history.length && <p className="text-sm text-slate-400 mt-3">Inga sparade poster.</p>}
        {historyLoaded && !historyError && !historyLoading && <PerformanceSummary history={history} />}
        <div className="mt-3 divide-y divide-slate-800">{history.slice(0, 5).map((trade) => {
          const analysis = trade.signal_inputs?.record_type === "ANALYSIS";
          const scan = trade.signal_inputs?.record_type === "SCAN";
          const realTrade = trade.signal_inputs?.record_type === "REAL_TRADE";
          const decision = trade.signal_inputs?.decision;
          const scanAssessment = { NOT_ASSESSED: "ej bedömt", PARTIALLY_ASSESSED: "delvis bedömt", ASSESSED: "bedömt" }[trade.signal_inputs?.scan_status];
          return <article key={trade.trade_id} className="py-3 text-sm">
            <div className="flex justify-between gap-3"><span>{trade.ticker}</span><span>{scan ? "Skanningsrapport" : analysis ? `Historiskt analysförslag · ${LABELS[decision?.status] || "EJ BEDÖMT"}` : realTrade ? `Faktisk trade · ${trade.direction}` : `Äldre post · ${trade.signal}`}</span></div>
            <p className="text-xs text-slate-400 mt-1">{new Date(trade.timestamp).toLocaleString("sv-SE")} · {scan ? `${trade.signal_inputs.checked} aktier kontrollerade · ${trade.signal_inputs.complete ? "komplett urval" : "ofullständig"}${scanAssessment ? ` · ${scanAssessment}` : ""}` : analysis ? "Analysförslag" : realTrade ? trade.trade_status : trade.trade_status}</p>
            {realTrade && trade.trade_status === "CLOSED" && Number.isFinite(trade.result_percent) && <p>Nettoresultat: {trade.result_percent.toFixed(2)}%{Number.isFinite(trade.result_r) ? ` · ${trade.result_r.toFixed(2)}R` : ""} · {trade.winner === null ? "break-even" : trade.winner ? "vinst" : "förlust"}</p>}
            {realTrade && trade.trade_status === "OPEN" && <CloseTradeForm trade={trade} onClose={closeRealTrade} />}
            <Details title="journalpost"><pre className="text-xs whitespace-pre-wrap break-all max-h-64 overflow-auto">{JSON.stringify(trade, null, 2)}</pre></Details>
          </article>;
        })}</div>
      </section>
      <SignalJournal />
      <PaperJournal latestAnalysis={expiredResultSignal ? null : result} />
      <footer className="text-xs text-slate-500">Prototyp, inte en validerad handelsstrategi. Risk Engine, personlig tradeuppföljning och produktdata för derivat återstår. Ingen träffsäkerhet utlovas.</footer>
    </div>
  </main>;
}
