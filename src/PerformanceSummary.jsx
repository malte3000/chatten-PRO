import React from "react";
import { summarizePerformance } from "./performanceModel.js";

const numberFormat = new Intl.NumberFormat("sv-SE", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const number = (value) => Number.isFinite(value) ? numberFormat.format(value) : "saknas";
const money = (value, currency) => Number.isFinite(value) ? `${number(value)} ${currency}` : "kan inte beräknas";

function Metric({ label, children }) {
  return <div><dt className="text-xs text-slate-400">{label}</dt><dd className="mt-1 text-sm text-slate-200">{children}</dd></div>;
}

export default function PerformanceSummary({ history = [] }) {
  const statistics = summarizePerformance(Array.isArray(history) ? history.slice(0, 100) : []);
  const invalid = statistics.exclusions.filter((item) => item.category === "INVALID");
  return <details className="border-t border-slate-800 mt-3 pt-3 text-sm">
    <summary className="cursor-pointer text-cyan-300">Utfall i hämtad journal</summary>
    <div className="mt-3 space-y-3">
      <p className="text-slate-300">Avslutade faktiska trades med giltigt utfall: {statistics.includedCount}.</p>
      <p className="text-xs text-slate-400">Omfattar högst de 100 senast hämtade journalposterna. Statistik över registrerade affärer visar inte kontoavkastning eller framtida vinstsannolikhet.</p>
      {!statistics.groups.length && <p className="text-slate-400">Inga giltiga avslutade faktiska trades.</p>}
      {statistics.groups.map((group) => <section key={JSON.stringify([group.strategyVersion, group.currency])} className="border border-slate-800 rounded p-3 space-y-3" aria-label={`${group.strategyVersion} i ${group.currency}`}>
        <div>
          <h3 className="font-semibold break-words">{group.strategyVersion} · {group.currency}</h3>
          <p className="text-xs text-slate-400 mt-1">{group.tradeCount} avslutade · {group.wins} vinster · {group.losses} förluster · {group.breakEvens} break-even</p>
        </div>
        <dl className="grid gap-3 sm:grid-cols-2">
          <Metric label="Andel vinster bland avslutade trades">{number(group.winRatePercent)}%</Metric>
          <Metric label="Netto efter faktiska avgifter">{money(group.totalNetPnl, group.currency)}</Metric>
          <Metric label="Faktiska avgifter">
            {money(group.totalFees, group.currency)}
            <span className="block text-xs text-slate-400 mt-1">{group.feePaidTradeCount} trades med avgift · {group.feeFreeTradeCount} utan avgift</span>
          </Metric>
          <Metric label="Medel-R">
            {Number.isFinite(group.averageR) ? `${number(group.averageR)} R` : "saknas"}
            <span className="block text-xs text-slate-400 mt-1">Baserat på {group.rTradeCount} giltiga stoppar och R-utfall.</span>
          </Metric>
          <Metric label="Profit factor">{group.profitFactor === null ? group.profitFactorStatus === "NO_LOSSES" ? "saknar förluster" : "kan inte beräknas" : number(group.profitFactor)}</Metric>
          <Metric label="Genomsnittligt netto per trade">{money(group.expectancyNetPnl, group.currency)}</Metric>
          <Metric label="Netto / summerat ingångsvärde">{Number.isFinite(group.netPercent) ? `${number(group.netPercent)}%` : "kan inte beräknas"}</Metric>
        </dl>
        {group.rExcludedCount > 0 && <p className="text-xs text-slate-400">{group.rExcludedCount} trades saknar giltig ursprunglig stop eller R-resultat och ingår därför inte i medel-R.</p>}
      </section>)}
      {statistics.invalidClosedCount > 0 && <details className="border-t border-slate-800 pt-3">
        <summary className="cursor-pointer text-amber-300">{statistics.invalidClosedCount} avslutade faktiska trades är uteslutna – se orsaker</summary>
        <ul className="mt-3 space-y-3 text-sm text-slate-300">
          {invalid.map((item) => <li key={`${item.tradeId || "post"}-${item.index}`}>
            <p className="font-medium break-all">{item.tradeId || `Journalpost ${item.index + 1}`}</p>
            <p className="text-xs text-slate-400 mt-1">{item.reasons.join(" ")}</p>
          </li>)}
        </ul>
      </details>}
    </div>
  </details>;
}
