import React, { useEffect, useRef, useState } from "react";
import { PAPER_BASIS, PAPER_VERSION } from "./paperModel.js";
import { closeTradingViewPaperEntry, createTradingViewPaperEntry } from "./tradingViewPaperModel.js";
import { TRADINGVIEW_PAPER_STORAGE_KEY, decodeTradingViewPaperLog, encodeTradingViewPaperLog, loadTradingViewPaperOrders, mergeTradingViewPaperLogs, updateTradingViewPaperOrders } from "./tradingViewPaperStorage.js";

const CONTROL = "border border-cyan-800 bg-slate-950 text-slate-100 rounded px-3 py-2 text-sm";
const formatted = (value) => Number.isFinite(value) ? value.toLocaleString("sv-SE", { maximumFractionDigits: 2 }) : "—";

function localTimeAsIso(value) {
  const time = new Date(value);
  if (!value || !Number.isFinite(time.getTime())) throw new Error("Ange datum och klockslag i datorns lokala tidszon.");
  return time.toISOString();
}

function initialState() {
  try { return { orders: loadTradingViewPaperOrders(window.localStorage), error: "" }; }
  catch (problem) { return { orders: [], error: `TradingView-paperloggen kunde inte läsas: ${problem.message} Inga order har skrivits över.` }; }
}

function EntryForm({ observation, onSave, disabled }) {
  const [entryAt, setEntryAt] = useState("");
  const [entryPrice, setEntryPrice] = useState("");
  const [quantity, setQuantity] = useState("");
  const [entryFee, setEntryFee] = useState("");
  return <details className="border-t border-slate-800 pt-2">
    <summary className="cursor-pointer text-cyan-300">Registrera TradingView-paperköp för {observation.ticker} · signal {observation.signalDate}</summary>
    <p className="text-xs text-slate-400 mt-2">Ange bara en order som verkligen fylldes i TradingViews paperkonto under första ordinarie handelssessionen efter signalen. Skriv tid i datorns lokala tidszon. Lägg inte in en order som bara planerades.</p>
    <p className="text-xs text-amber-300 mt-2">Låst plan: {observation.setup} · stopp {formatted(observation.plan.stop)} · mål {formatted(observation.plan.target)} {observation.currency}. Fyllning utanför intervallet registreras men räknas inte som jämförbart R-utfall.</p>
    <form className="grid gap-3 sm:grid-cols-2 mt-3 text-sm" onSubmit={(event) => {
      event.preventDefault();
      onSave(observation, { entryAt, entryPrice, quantity, entryFee });
    }}>
      <label>Köptid i lokal tid<input className={`${CONTROL} block w-full mt-1`} type="datetime-local" required value={entryAt} onChange={(event) => setEntryAt(event.target.value)} /></label>
      <label>Fyllt köppris ({observation.currency})<input className={`${CONTROL} block w-full mt-1`} type="number" min="0.000001" step="any" required value={entryPrice} onChange={(event) => setEntryPrice(event.target.value)} /></label>
      <label>Fyllt antal aktier<input className={`${CONTROL} block w-full mt-1`} type="number" min="1" step="1" required value={quantity} onChange={(event) => setQuantity(event.target.value)} /></label>
      <label>Köpavgift ({observation.currency}, ange 0 om ingen)<input className={`${CONTROL} block w-full mt-1`} type="number" min="0" step="any" required value={entryFee} onChange={(event) => setEntryFee(event.target.value)} /></label>
      <button className={CONTROL} disabled={disabled}>Spara fyllt paperköp</button>
    </form>
  </details>;
}

function ExitForm({ order, onClose, disabled }) {
  const [exitAt, setExitAt] = useState("");
  const [exitPrice, setExitPrice] = useState("");
  const [exitQuantity, setExitQuantity] = useState("");
  const [exitFee, setExitFee] = useState("");
  return <details className="mt-2">
    <summary className="cursor-pointer text-cyan-300">Registrera full försäljning från TradingView</summary>
    <p className="text-xs text-amber-300 mt-2">Registrera bara om alla {order.quantity} aktier såldes i en fyllning. Delvisa försäljningar och flera fyllnadspriser kan inte räknas korrekt här.</p>
    <form className="grid gap-3 sm:grid-cols-2 mt-3 text-sm" onSubmit={(event) => {
      event.preventDefault();
      onClose(order.id, { exitAt, exitPrice, exitQuantity, exitFee });
    }}>
      <label>Säljtid i lokal tid<input className={`${CONTROL} block w-full mt-1`} type="datetime-local" required value={exitAt} onChange={(event) => setExitAt(event.target.value)} /></label>
      <label>Fyllt säljpris ({order.currency})<input className={`${CONTROL} block w-full mt-1`} type="number" min="0.000001" step="any" required value={exitPrice} onChange={(event) => setExitPrice(event.target.value)} /></label>
      <label>Antal sålda aktier (hela innehavet: {order.quantity})<input className={`${CONTROL} block w-full mt-1`} type="number" min={order.quantity} max={order.quantity} step="1" required value={exitQuantity} onChange={(event) => setExitQuantity(event.target.value)} /></label>
      <label>Säljavgift ({order.currency}, ange 0 om ingen)<input className={`${CONTROL} block w-full mt-1`} type="number" min="0" step="any" required value={exitFee} onChange={(event) => setExitFee(event.target.value)} /></label>
      <button className={CONTROL} disabled={disabled}>Spara avslutad paperorder</button>
    </form>
  </details>;
}

export default function TradingViewPaperLedger({ observations }) {
  const [state, setState] = useState(initialState);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [visibleCount, setVisibleCount] = useState(20);
  const importInput = useRef(null);

  useEffect(() => {
    const fromOtherTab = (event) => {
      if (event.key !== TRADINGVIEW_PAPER_STORAGE_KEY && event.key !== null) return;
      try { setState({ orders: loadTradingViewPaperOrders(window.localStorage), error: "" }); }
      catch (problem) { setState((old) => ({ ...old, error: `TradingView-paperloggen ändrades i en annan flik men kunde inte läsas: ${problem.message}` })); }
    };
    window.addEventListener("storage", fromOtherTab);
    return () => window.removeEventListener("storage", fromOtherTab);
  }, []);

  async function saveEntry(observation, input) {
    if (busy || state.error) return;
    setBusy(true); setError(""); setNotice("");
    try {
      const next = await updateTradingViewPaperOrders(window.localStorage, navigator.locks, (current) => {
        const order = createTradingViewPaperEntry(observation, { ...input, entryAt: localTimeAsIso(input.entryAt) });
        return [...current, order];
      });
      setState({ orders: next, error: "" });
      setNotice("TradingViews fyllda paperköp är sparat lokalt, separat från terminalens teoretiska simulering. Exportera gärna en kopia.");
    } catch (problem) { setError(problem.message); }
    finally { setBusy(false); }
  }

  async function saveExit(orderId, input) {
    if (busy || state.error) return;
    setBusy(true); setError(""); setNotice("");
    try {
      const next = await updateTradingViewPaperOrders(window.localStorage, navigator.locks, (current) => {
        if (!current.some((order) => order.id === orderId)) throw new Error("Paperordern finns inte längre i den lokala journalen.");
        return current.map((order) => order.id === orderId ? closeTradingViewPaperEntry(order, { ...input, exitAt: localTimeAsIso(input.exitAt) }) : order);
      });
      setState({ orders: next, error: "" });
      setNotice("TradingViews fyllda försäljning är sparad lokalt. Resultatet beräknas från angivna fyllnadspriser och avgifter.");
    } catch (problem) { setError(problem.message); }
    finally { setBusy(false); }
  }

  function exportOrders() {
    try {
      const orders = loadTradingViewPaperOrders(window.localStorage);
      const url = URL.createObjectURL(new Blob([encodeTradingViewPaperLog(orders)], { type: "application/json" }));
      const link = document.createElement("a");
      link.href = url; link.download = `tradingview-paper-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.append(link); link.click(); link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      setState({ orders, error: "" }); setError(""); setNotice("En JSON-kopia av TradingView-paperordrarna laddades ned.");
    } catch (problem) { setError(problem.message); }
  }

  async function importOrders(event) {
    const file = event.target.files?.[0];
    if (!file || busy) return;
    setBusy(true); setError(""); setNotice("");
    try {
      if (state.error) throw new Error(state.error);
      if (file.size > 500_000) throw new Error("Importfilen är för stor.");
      const incoming = decodeTradingViewPaperLog(await file.text());
      let added = 0;
      let closedFromBackup = 0;
      const next = await updateTradingViewPaperOrders(window.localStorage, navigator.locks, (current) => {
        const merged = mergeTradingViewPaperLogs(current, incoming);
        added = merged.length - current.length;
        const oldById = new Map(current.map((order) => [order.id, order]));
        closedFromBackup = merged.filter((order) => oldById.get(order.id)?.status === "OPEN" && order.status === "CLOSED").length;
        return merged;
      });
      setState({ orders: next, error: "" });
      setNotice(`${added} nya TradingView-paperorder importerades; ${closedFromBackup} befintliga öppna order fick sitt avslut från kopian. Befintliga låsta uppgifter ändrades inte.`);
    } catch (problem) { setError(`Importen avbröts: ${problem.message}`); }
    finally { setBusy(false); if (importInput.current) importInput.current.value = ""; }
  }

  const orders = state.orders;
  const byObservationId = new Map(orders.map((order) => [order.sourcePaperObservationId, order]));
  const eligible = (Array.isArray(observations) ? observations : []).filter((record) => record.version === PAPER_VERSION && record.basis === PAPER_BASIS.TECHNICAL_ONLY);
  const visibleObservations = eligible.slice().reverse().slice(0, visibleCount);
  const visibleObservationIds = new Set(visibleObservations.map((record) => record.id));
  const otherOrders = orders.filter((order) => !visibleObservationIds.has(order.sourcePaperObservationId));
  const closed = orders.filter((order) => order.status === "CLOSED").length;
  return <section className="border-t border-slate-800 pt-3 space-y-3 text-sm" aria-label="TradingView-paperjournal">
    <h3 className="font-semibold">TradingView · manuella paperköp</h3>
    <p className="text-xs text-slate-400">Köp och sälj görs av dig i TradingViews paperkonto. Ange de fyllda priserna här efteråt. Den här journalen är lokal i webbläsaren och ingår inte i molnsynken eller paperloggens teoretiska resultat.</p>
    <p className="text-xs text-amber-300">Orderuppgifterna kommer från din manuella inmatning och är inte verifierade mot TradingView. En sent registrerad fyllning markeras särskilt. Exportera båda JSON-kopiorna om du vill säkerhetskopiera både signaler och paperorder.</p>
    <p>{orders.length} TradingView-paperorder · {orders.length - closed} öppna · {closed} avslutade.</p>
    <div className="flex flex-wrap items-end gap-3">
      <button type="button" className={CONTROL} onClick={exportOrders} disabled={!orders.length || Boolean(state.error) || busy}>Exportera TradingView-order (JSON)</button>
      <label className="text-slate-300">Importera TradingView-order (JSON)<input ref={importInput} className="block mt-1 text-xs" type="file" accept=".json,application/json" onChange={importOrders} disabled={busy || Boolean(state.error)} /></label>
    </div>
    {state.error && <p role="alert" className="text-red-300">{state.error}</p>}
    {error && <p role="alert" className="text-red-300">{error}</p>}
    {notice && <p role="status" className="text-cyan-300">{notice}</p>}
    {eligible.length === 0 && orders.length === 0 && <p className="text-slate-400">Lås först en teknisk TRADE-signal i paperloggen.</p>}
    {visibleObservations.map((observation) => {
      const order = byObservationId.get(observation.id);
      return <div key={observation.id} className="border border-slate-800 rounded p-3">
        {order ? <>
          <p className="font-medium">{order.ticker} · {order.setup} · {order.status === "CLOSED" ? "avslutad" : "öppen"} TradingView-paperorder</p>
          <p className="text-xs text-slate-400">Signal {order.signalDate} · köpt {new Date(order.entryAt).toLocaleString("sv-SE")} · {order.quantity} aktier × {formatted(order.entryPrice)} {order.currency} · köpavgift {formatted(order.entryFee)} {order.currency}.</p>
          {order.entryLateLogged && <p className="text-xs text-amber-300">Köpet registrerades mer än 30 minuter efter angiven fyllning. Kontrollera mot TradingViews orderhistorik.</p>}
          {!order.entryWithinPlan && <p className="text-xs text-amber-300">Köppriset låg utanför den låsta stopp/mål-planen. R-utfall är inte jämförbart med upplägget.</p>}
          {order.status === "OPEN" ? <ExitForm order={order} onClose={saveExit} disabled={busy || Boolean(state.error)} /> :
            <p>Sålt {new Date(order.exitAt).toLocaleString("sv-SE")} för {formatted(order.exitPrice)} {order.currency} · netto {formatted(order.netPnl)} {order.currency} · {order.resultR === null ? "R saknas" : `${formatted(order.resultR)}R`}.</p>}
        </> : <EntryForm observation={observation} onSave={saveEntry} disabled={busy || Boolean(state.error)} />}
      </div>;
    })}
    {eligible.length > visibleCount && <button type="button" className={CONTROL} onClick={() => setVisibleCount((count) => count + 20)}>Visa fler äldre låsta signaler ({eligible.length - visibleCount} kvar)</button>}
    {otherOrders.map((order) => <div key={order.id} className="border border-slate-800 rounded p-3">
      <p className="font-medium">{order.ticker} · {order.setup} · {order.status === "CLOSED" ? "avslutad" : "öppen"} TradingView-paperorder</p>
      <p className="text-xs text-slate-400">Signal {order.signalDate} · köp {formatted(order.entryPrice)} {order.currency} × {order.quantity}.</p>
      {order.status === "OPEN" ? <ExitForm order={order} onClose={saveExit} disabled={busy || Boolean(state.error)} /> : <p>TradingView-paperutfall (manuellt rapporterat): netto {formatted(order.netPnl)} {order.currency} · {order.resultR === null ? "R saknas" : `${formatted(order.resultR)}R`}.</p>}
    </div>)}
    {otherOrders.length > 0 && <p className="text-xs text-amber-300">Order utan synlig signal visas separat. Exportera både signaler och TradingView-order om du vill spara ett komplett underlag.</p>}
  </section>;
}
