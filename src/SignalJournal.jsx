import React, { useEffect, useState } from "react";
import { SIGNAL_STORAGE_KEY, encodeSignalLog, loadSignalLog } from "./signalLog.js";

const CONTROL = "border border-cyan-800 bg-slate-950 text-slate-100 rounded px-3 py-2 text-sm";
const formatted = (value) => Number.isFinite(value) ? value.toLocaleString("sv-SE", { maximumFractionDigits: 2 }) : "—";

function readState() {
  try { return { records: loadSignalLog(window.localStorage), error: "" }; }
  catch (problem) { return { records: [], error: `Signalloggen kunde inte läsas: ${problem.message}` }; }
}

export default function SignalJournal() {
  const [state, setState] = useState(readState);
  const [notice, setNotice] = useState("");
  useEffect(() => {
    const sameTab = () => setState(readState());
    const anotherTab = (event) => { if (event.key === SIGNAL_STORAGE_KEY || event.key === null) setState(readState()); };
    window.addEventListener("signal-log-updated", sameTab);
    window.addEventListener("storage", anotherTab);
    return () => { window.removeEventListener("signal-log-updated", sameTab); window.removeEventListener("storage", anotherTab); };
  }, []);

  function exportLog() {
    try {
      const records = loadSignalLog(window.localStorage);
      const url = URL.createObjectURL(new Blob([encodeSignalLog(records)], { type: "application/json" }));
      const link = document.createElement("a");
      link.href = url; link.download = `trade-signaler-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.append(link); link.click(); link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      setState({ records, error: "" }); setNotice("En JSON-kopia av de lokala signalerna laddades ned.");
    } catch (problem) { setState((previous) => ({ ...previous, error: `Signalloggen kunde inte exporteras: ${problem.message}` })); }
  }

  const simulated = state.records.filter((record) => Object.keys(record.outcomes).length > 0).length;
  return <section className="border border-slate-800 rounded-lg p-4 space-y-3" aria-label="TRADE-signallogg">
    <h2 className="font-semibold">TRADE-signaler · lokal logg</h2>
    <p className="text-xs text-slate-400">Varje ny experimentell TRADE-signal från skanning eller enskild analys sparas automatiskt i den här webbläsaren med datum, upplägg och låsta nivåer. Samma aktie och dagskurs räknas en gång även om du analyserar den igen. Loggen innehåller inga order och synkas inte mellan datorer.</p>
    <p className="text-xs text-amber-300">Antal signaler är inte träffsäkerhet. Enstaka paperutfall är simuleringar; signaler utan uppföljda utfall får inte räknas som vinster eller förluster. Exportera regelbundet en JSON-kopia.</p>
    <p className="text-sm">{state.records.length} registrerade signaler · {simulated} med minst ett länkat simulerat utfall.</p>
    <button className={CONTROL} onClick={exportLog} disabled={!state.records.length || Boolean(state.error)}>Exportera signallogg (JSON)</button>
    {state.error && <p role="alert" className="text-sm text-red-300">{state.error}</p>}
    {notice && <p role="status" className="text-sm text-cyan-300">{notice}</p>}
    {state.records.length > 0 && <details className="text-sm border-t border-slate-800 pt-3"><summary className="cursor-pointer text-cyan-300">Se registrerade signaler</summary>
      <div className="divide-y divide-slate-800 mt-2">{[...state.records].reverse().slice(0, 20).map((record) => <article key={record.id} className="py-2">
        <p className="font-medium">{record.ticker} · {record.signalDate} · {record.setups.join(" + ")}</p>
        <p className="text-xs text-slate-400">{record.market === "usa" ? "USA" : "Sverige"} · {record.strategyVersion} · {record.sources.join(" + ")} · registrerad {new Date(record.capturedAt).toLocaleString("sv-SE")}</p>
        <p className="text-xs text-slate-400">Primär plan: referens {formatted(record.plans[0].entry_reference)}, stopp {formatted(record.plans[0].stop)}, mål {formatted(record.plans[0].target)} {record.currency}.</p>
        {Object.keys(record.outcomes).length > 0 && <p className="text-xs text-amber-300">Simulerat utfall finns för {Object.keys(record.outcomes).join(" + ")}. Ingen faktisk order är bekräftad.</p>}
      </article>)}</div>
      {state.records.length > 20 && <p className="text-xs text-slate-400">De senaste 20 visas här. Exportfilen innehåller alla {state.records.length}.</p>}
    </details>}
  </section>;
}
