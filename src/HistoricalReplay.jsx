import React, { useState } from "react";
import { runSwingReplay } from "./backtestModel.js";

const CONTROL = "border border-cyan-800 bg-slate-950 text-slate-100 rounded px-3 py-2 text-sm";
const number = (value) => Number.isFinite(value) ? value.toLocaleString("sv-SE", { maximumFractionDigits: 2 }) : "—";

export default function HistoricalReplay({ marketData, market }) {
  const [setup, setSetup] = useState("PULLBACK");
  const [holding, setHolding] = useState("3");
  const [quantity, setQuantity] = useState("");
  const [fee, setFee] = useState("");
  const [slippage, setSlippage] = useState("");
  const [report, setReport] = useState(null);
  const [error, setError] = useState("");
  function change(setter, value) { setter(value); setReport(null); setError(""); }
  function simulate(event) {
    event.preventDefault();
    if (![quantity, fee, slippage].every((value) => value.trim())) { setError("Ange storlek, avgift och slippage uttryckligen, även om kostnaden är noll."); return; }
    const result = runSwingReplay({ marketData, market, setup, holdingSessions: Number(holding), quantity: Number(quantity), feePerOrder: Number(fee), slippageBps: Number(slippage), asOf: marketData?.fetched_at || Date.now() });
    setReport(result);
    setError(result.status === "INVALID" ? result.reasons.join(" ") : "");
  }
  const money = (value) => `${number(value)} ${marketData?.currency || "valuta"}`;
  return <details className="border-t border-slate-800 mt-3 pt-3 text-sm">
    <summary className="cursor-pointer text-cyan-300">Se mer – historiskt prisprov</summary>
    <div className="mt-3 space-y-3 text-slate-300">
      <p>Prova pullback eller breakout på de dagskurser som redan hämtats. Inga nya API-anrop görs. Detta är ett tekniskt experiment utan historiska nyheter, AI eller referensfilter.</p>
      <p className="text-xs text-amber-300">Det korta urvalet på upp till 100 dagsljus kan ge få eller inga simuleringar. Resultatet bevisar ingen edge och är inte botens uppmätta träffsäkerhet.</p>
      <form onSubmit={simulate} className="grid gap-3 sm:grid-cols-2">
        <label>Regel<select className={`${CONTROL} block w-full mt-1`} value={setup} onChange={(event) => change(setSetup, event.target.value)}><option value="PULLBACK">Pullback</option><option value="BREAKOUT">Breakout</option></select></label>
        <label>Max observerade sessioner<select className={`${CONTROL} block w-full mt-1`} value={holding} onChange={(event) => change(setHolding, event.target.value)}>{[1, 2, 3, 4, 5].map((value) => <option key={value} value={value}>{value}</option>)}</select></label>
        <label>Fast antal simulerade aktier<input className={`${CONTROL} block w-full mt-1`} type="number" min="1" step="1" required value={quantity} onChange={(event) => change(setQuantity, event.target.value)} /></label>
        <label>Avgift per order ({marketData?.currency || "valuta"})<input className={`${CONTROL} block w-full mt-1`} type="number" min="0" step="any" required value={fee} onChange={(event) => change(setFee, event.target.value)} /></label>
        <label>Slippage (baspunkter, 10 = 0,1 %)<input className={`${CONTROL} block w-full mt-1`} type="number" min="0" max="9999" step="any" required value={slippage} onChange={(event) => change(setSlippage, event.target.value)} /></label>
        <button className="rounded border border-cyan-700 px-4 py-2">Kör prisprov på hämtad data</button>
      </form>
      {error && <p role="alert" className="text-red-300">{error}</p>}
      {report?.status === "COMPLETED" && <div role="status" className="border border-slate-800 rounded p-3 space-y-2">
        <p>{report.closedBars} stängda dagsljus · första 60 för indikatorer · {report.startDate}–{report.endDate}.</p>
        <p>{report.metrics.tradeCount} stängda simuleringar · {report.openTrades.length} öppna, ej räknade i utfallet · {report.rejectedSignals.length} avvisade signaler.</p>
        <p>Vinster {report.metrics.wins} · förluster {report.metrics.losses} · break-even {report.metrics.breakEvens} · vinstandel {number(report.metrics.winRatePercent)}{report.metrics.winRatePercent !== null ? " %" : ""}.</p>
        <p>Simulerat netto {money(report.metrics.totalNetPnl)} · avgifter {money(report.metrics.totalFees)} · medelutfall {number(report.metrics.expectancyR)}R.</p>
        <p>Största realiserade nedgång {money(report.metrics.maxRealizedDrawdown)}. Fast antal per trade; ingen kontoavkastning beräknas.</p>
        <p className="text-xs text-slate-400">{report.version} · {report.strategyVersion}. Simuleringarna sparas inte som faktiska affärer i journalen.</p>
        <details><summary className="cursor-pointer text-cyan-300">Antaganden och simulerade affärer</summary>
          <ul className="list-disc pl-5 mt-2 space-y-1">{report.assumptions.map((text) => <li key={text}>{text}</li>)}</ul>
          <pre className="text-xs whitespace-pre-wrap break-all max-h-80 overflow-auto mt-3">{JSON.stringify(report, null, 2)}</pre>
        </details>
      </div>}
    </div>
  </details>;
}
