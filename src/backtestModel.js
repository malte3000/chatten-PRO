import { getMarketStatus } from "../api/_market-hours.js";
import { selectClosedDailyBars } from "./dailyBars.js";
import { assessSwingSetup, SWING_STRATEGY_VERSION } from "./strategyModel.js";
import { assessMarketContext } from "./marketContext.js";

export const REPLAY_VERSION = "daily-replay-v0.1-experimental";
const SETUPS = new Set(["PULLBACK", "BREAKOUT"]);
const finite = (value) => typeof value === "number" && Number.isFinite(value);

function summarize(trades) {
  if (!trades.length) return { tradeCount: 0, wins: 0, losses: 0, breakEvens: 0, winRatePercent: null, totalNetPnl: 0, totalFees: 0, expectancyR: null, profitFactor: null, maxRealizedDrawdown: 0, maxRealizedDrawdownR: 0 };
  const profits = trades.reduce((sum, trade) => sum + Math.max(0, trade.netPnl), 0);
  const lossesAmount = trades.reduce((sum, trade) => sum - Math.min(0, trade.netPnl), 0);
  let cumulative = 0, peak = 0, drawdown = 0, cumulativeR = 0, peakR = 0, drawdownR = 0;
  for (const trade of trades) {
    cumulative += trade.netPnl;
    peak = Math.max(peak, cumulative);
    drawdown = Math.max(drawdown, peak - cumulative);
    cumulativeR += trade.resultR;
    peakR = Math.max(peakR, cumulativeR);
    drawdownR = Math.max(drawdownR, peakR - cumulativeR);
  }
  return {
    tradeCount: trades.length,
    wins: trades.filter((trade) => trade.netPnl > 1e-8).length,
    losses: trades.filter((trade) => trade.netPnl < -1e-8).length,
    breakEvens: trades.filter((trade) => Math.abs(trade.netPnl) <= 1e-8).length,
    winRatePercent: trades.filter((trade) => trade.netPnl > 1e-8).length / trades.length * 100,
    totalNetPnl: cumulative, totalFees: trades.reduce((sum, trade) => sum + trade.totalFees, 0),
    expectancyR: cumulativeR / trades.length,
    profitFactor: lossesAmount > 0 ? profits / lossesAmount : null,
    profitFactorNote: lossesAmount === 0 ? "Inga förluster i detta urval; kvoten kan inte beräknas." : null,
    maxRealizedDrawdown: drawdown, maxRealizedDrawdownR: drawdownR,
  };
}

// This is a price-only experiment, not a replay of historical AI/news decisions.
// A pending signal contains only information available at the previous close.
export function runSwingReplay({ marketData, benchmarkData = null, benchmarkTicker = null, market = "usa", setup, holdingSessions, quantity, feePerOrder, slippageBps, marketContextMode = "off", asOf = Date.now() } = {}) {
  const invalid = (reason) => ({ version: REPLAY_VERSION, status: "INVALID", reasons: [reason], closedTrades: [], openTrades: [], rejectedSignals: [], decisions: [], metrics: summarize([]) });
  if (!SETUPS.has(setup) || !["usa", "stockholm"].includes(market) || !["off", "required"].includes(marketContextMode)) return invalid("Välj pullback eller breakout, stödd marknad och giltigt referensfilter.");
  if (!Number.isInteger(holdingSessions) || holdingSessions < 1 || holdingSessions > 5 || !Number.isSafeInteger(quantity) || quantity < 1 || !finite(feePerOrder) || feePerOrder < 0 || !finite(feePerOrder * 2) || !finite(slippageBps) || slippageBps < 0 || slippageBps >= 10000) return invalid("Ange 1–5 observerade sessioner, exakt positivt helt aktieantal, avgift per order och slippage 0–9999 baspunkter.");
  const asOfTime = typeof asOf === "number" ? asOf : Date.parse(asOf);
  if (!Number.isFinite(asOfTime) || !Number.isFinite(new Date(asOfTime).getTime())) return invalid("Provets slutklocka är ogiltig.");
  const clock = getMarketStatus(market, new Date(asOfTime));
  const selection = selectClosedDailyBars(marketData, { marketStatus: clock, now: asOfTime });
  if (!selection.valid) return invalid(selection.reasons.join(" "));
  const bars = selection.bars;
  if (bars.length < 61 || bars.length > 5000 || !String(marketData.ticker || "").trim() || !String(marketData.currency || "").trim()) return invalid("Minst 61 och högst 5000 stängda dagsljus samt ticker och valuta krävs.");
  if (marketContextMode === "required" && (!benchmarkData || !benchmarkTicker)) return invalid("Referensdata och dess ticker krävs när marknadsfiltret är på.");
  if (marketContextMode === "required" && (!Array.isArray(benchmarkData.bars) || benchmarkData.bars.some((bar) => !bar || typeof bar.datetime !== "string"))) return invalid("Referensdatan saknar giltiga daterade dagsljus.");

  const closedTrades = [], rejectedSignals = [], decisions = [];
  let pending = null, position = null;
  const slip = slippageBps / 10000;
  for (let index = 59; index < bars.length; index += 1) {
    const bar = bars[index];
    if (pending) {
      const entry = bar.open * (1 + slip);
      const stop = pending.plan.stop;
      const risk = entry - stop;
      const target = entry + pending.plan.theoretical_risk_reward * risk;
      if (stop <= 0 || risk * quantity <= 0 || bar.open <= stop || entry <= stop || bar.open >= pending.plan.target || entry >= pending.plan.target || ![entry, risk, target, risk * quantity, entry * quantity].every(Number.isFinite) || target <= entry) {
        rejectedSignals.push({ signalDate: pending.signalDate, entryDate: bar.datetime, reason: "Nästa öppning eller simulerad ingång ligger utanför signalens giltiga prisnivåer." });
      } else {
        position = { type: "SIMULATED_TRADE", status: "OPEN", ticker: marketData.ticker, currency: marketData.currency, strategyVersion: SWING_STRATEGY_VERSION, setup, signalDate: pending.signalDate, entryDate: bar.datetime, entryIndex: index, entry, stop, target, initialRisk: risk * quantity, quantity, entryFee: feePerOrder, signalPlan: pending.plan, context: pending.context, winner: null, netPnl: null, resultR: null };
      }
      pending = null;
    }
    if (position) {
      let rawExit = null, exitReason = null, ambiguousBar = false;
      if (bar.open <= position.stop) { rawExit = bar.open; exitReason = "STOP_GAP"; }
      else if (bar.open >= position.target) { rawExit = position.target; exitReason = "TARGET_GAP"; }
      else if (bar.low <= position.stop) { rawExit = position.stop; exitReason = "STOP"; ambiguousBar = bar.high >= position.target; }
      else if (bar.high >= position.target) { rawExit = position.target; exitReason = "TARGET"; }
      else if (index - position.entryIndex + 1 >= holdingSessions) { rawExit = bar.close; exitReason = "TIME_EXIT"; }
      if (rawExit !== null) {
        const exit = rawExit * (1 - slip);
        const grossPnl = (exit - position.entry) * quantity;
        const totalFees = feePerOrder * 2;
        const netPnl = grossPnl - totalFees;
        const resultR = netPnl / position.initialRisk;
        if (![exit, grossPnl, netPnl, resultR].every(Number.isFinite)) return invalid("Prisnivåer eller storlek gav ett icke-finit simulerat utfall.");
        closedTrades.push({ ...position, status: "CLOSED", exitDate: bar.datetime, exit, exitReason, ambiguousBar, holdingBars: index - position.entryIndex + 1, grossPnl, totalFees, netPnl, resultR, winner: Math.abs(netPnl) <= 1e-8 ? null : netPnl > 0 });
        position = null;
      }
    }
    if (position) continue;
    const prefix = { ...marketData, bars: bars.slice(0, index + 1) };
    const decisionClock = { market, isOpen: false, reason: "after_close", sessionDate: bar.datetime };
    const decisionTime = Date.parse(`${bar.datetime}T23:59:59Z`);
    const assessment = assessSwingSetup(prefix, { ticker: marketData.ticker, marketStatus: decisionClock, now: decisionTime });
    const plan = assessment.plans.find((candidate) => candidate.setup === setup);
    if (!plan) continue;
    let context = null;
    if (marketContextMode === "required") {
      // Slice at the decision date before computing indicators or date joins.
      const benchmarkPrefix = { ...benchmarkData, bars: Array.isArray(benchmarkData.bars) ? benchmarkData.bars.filter((candidate) => candidate.datetime <= bar.datetime) : null };
      context = assessMarketContext(prefix, benchmarkPrefix, { ticker: marketData.ticker, benchmarkTicker, marketStatus: decisionClock, now: decisionTime });
    }
    decisions.push({ signalDate: bar.datetime, setup, plan: { ...plan }, context });
    if (context && context.status !== "CONFIRMED") {
      rejectedSignals.push({ signalDate: bar.datetime, reason: `Marknadsfilter: ${context.reasons.join(" ")}` });
    } else if (index === bars.length - 1) {
      rejectedSignals.push({ signalDate: bar.datetime, reason: "Ingen senare observerad session finns för ingång." });
    } else {
      pending = { signalDate: bar.datetime, plan: { ...plan }, context };
    }
  }
  const metrics = summarize(closedTrades);
  if (Object.values(metrics).some((value) => typeof value === "number" && !Number.isFinite(value))) return invalid("Summerade simulerade utfall gav ett icke-finit resultat.");
  return {
    version: REPLAY_VERSION, status: "COMPLETED", strategyVersion: SWING_STRATEGY_VERSION,
    ticker: marketData.ticker, currency: marketData.currency, startDate: bars[0].datetime, endDate: bars.at(-1).datetime,
    asOf: new Date(asOfTime).toISOString(), dataSource: marketData.source || "user_supplied", benchmarkTicker: marketContextMode === "required" ? benchmarkTicker : null,
    inputBars: marketData.bars.length, closedBars: bars.length, warmupBars: 60,
    options: { market, setup, holdingSessions, quantity, feePerOrder, slippageBps, marketContextMode },
    assumptions: [
      "Tekniskt prisprov av experimentella LONG-regler. Historiska nyheter, AI och aktieurval ingår inte.",
      "Signal på stängningsdata; ingång tidigast nästa observerade dagsljus vid open plus slippage. En position åt gången.",
      "Signalen behåller sin stop. Mål och R räknas om från faktisk simulerad ingång. Ogiltiga ingångsgap avvisas.",
      "Stop kontrolleras före mål om båda träffas i samma dagsljus. Mål är en beröringsutlöst marketexit, inte en garanterad limitfill.",
      "Avgift tas vid båda orderna, slippage försämrar båda fills. Inga spread-, likviditets- eller volymfillmodeller finns.",
      "Innehavstid räknas i observerade dagsljus. Saknade handelssessioner, splittar, utdelningar och överlevnadsbias måste kontrolleras i underlaget.",
      "Statistiken gäller bara stängda simuleringar. Drawdown gäller realiserade utfall, inte kontots löpande marknadsvärde.",
      "Detta är varken ett out-of-sample-prov, en kalibrerad sannolikhet eller tillstånd att handla.",
    ],
    closedTrades, openTrades: position ? [position] : [], rejectedSignals, decisions,
    metrics,
  };
}
