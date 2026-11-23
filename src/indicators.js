export function ema(values, period) {
  if (!Array.isArray(values) || !Number.isInteger(period) || period < 1 || values.length < period ||
      values.some((value) => typeof value !== "number" || !Number.isFinite(value))) return null;
  let value = values.slice(0, period).reduce((sum, item) => sum + item, 0) / period;
  const alpha = 2 / (period + 1);
  for (const item of values.slice(period)) value += alpha * (item - value);
  return value;
}

export function sma(values, period) {
  if (!Array.isArray(values) || !Number.isInteger(period) || period < 1 || values.length < period) return null;
  const window = values.slice(-period);
  if (window.some((value) => typeof value !== "number" || !Number.isFinite(value))) return null;
  return window.reduce((sum, value) => sum + value, 0) / period;
}

// Wilder RSI. This is descriptive input for research, never a probability by itself.
export function rsi(values, period = 14) {
  if (!Array.isArray(values) || !Number.isInteger(period) || period < 2 || values.length < period + 1 ||
      values.some((value) => typeof value !== "number" || !Number.isFinite(value) || value <= 0)) return null;
  const changes = values.slice(1).map((value, index) => value - values[index]);
  let averageGain = changes.slice(0, period).reduce((sum, change) => sum + Math.max(0, change), 0) / period;
  let averageLoss = changes.slice(0, period).reduce((sum, change) => sum + Math.max(0, -change), 0) / period;
  for (const change of changes.slice(period)) {
    averageGain = (averageGain * (period - 1) + Math.max(0, change)) / period;
    averageLoss = (averageLoss * (period - 1) + Math.max(0, -change)) / period;
  }
  if (averageLoss === 0) return averageGain === 0 ? 50 : 100;
  return 100 - 100 / (1 + averageGain / averageLoss);
}

function emaSeries(values, period) {
  if (!Array.isArray(values) || !Number.isInteger(period) || period < 1 || values.length < period ||
      values.some((value) => typeof value !== "number" || !Number.isFinite(value))) return [];
  const output = [];
  let current = values.slice(0, period).reduce((sum, value) => sum + value, 0) / period;
  output.push(current);
  const alpha = 2 / (period + 1);
  for (const value of values.slice(period)) {
    current += alpha * (value - current);
    output.push(current);
  }
  return output;
}

export function macd(values, { fast = 12, slow = 26, signal = 9 } = {}) {
  if (!Number.isInteger(fast) || !Number.isInteger(slow) || !Number.isInteger(signal) ||
      fast < 1 || slow <= fast || signal < 1 || !Array.isArray(values) || values.length < slow + signal - 1 ||
      values.some((value) => typeof value !== "number" || !Number.isFinite(value))) return null;
  const fastSeries = emaSeries(values, fast);
  const slowSeries = emaSeries(values, slow);
  const offset = slow - fast;
  const line = slowSeries.map((slowValue, index) => fastSeries[index + offset] - slowValue);
  const signalLine = emaSeries(line, signal);
  const macdValue = line.at(-1);
  const signalValue = signalLine.at(-1);
  if (![macdValue, signalValue].every(Number.isFinite)) return null;
  return { macd: macdValue, signal: signalValue, histogram: macdValue - signalValue };
}

export function atr(bars, period = 14) {
  if (!Array.isArray(bars) || !Number.isInteger(period) || period < 1 || bars.length < period + 1) return null;
  const ranges = bars.slice(1).map((bar, index) => {
    const previousClose = bars[index]?.close;
    if (![bar?.high, bar?.low, previousClose].every((value) => typeof value === "number" && Number.isFinite(value))) return null;
    return Math.max(bar.high - bar.low, Math.abs(bar.high - previousClose), Math.abs(bar.low - previousClose));
  });
  if (ranges.some((value) => value === null || value < 0)) return null;
  let value = ranges.slice(0, period).reduce((sum, range) => sum + range, 0) / period;
  for (const range of ranges.slice(period)) value = (value * (period - 1) + range) / period;
  return value;
}

export function realizedVolatility(values, { period = 20, annualization = 252 } = {}) {
  if (!Array.isArray(values) || !Number.isInteger(period) || period < 2 || !Number.isFinite(annualization) || annualization <= 0 ||
      values.length < period + 1 || values.some((value) => typeof value !== "number" || !Number.isFinite(value) || value <= 0)) return null;
  const returns = values.slice(-(period + 1)).slice(1).map((value, index) => Math.log(value / values.slice(-(period + 1))[index]));
  const mean = returns.reduce((sum, value) => sum + value, 0) / returns.length;
  const variance = returns.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (returns.length - 1);
  const volatility = Math.sqrt(variance * annualization) * 100;
  return Number.isFinite(volatility) ? volatility : null;
}
