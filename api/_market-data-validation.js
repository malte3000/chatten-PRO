function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

export function validateCandle(bar, index = null) {
  const errors = [];

  if (!bar || typeof bar !== "object") {
    return {
      valid: false,
      errors: ["Candlen är inte ett giltigt objekt"],
    };
  }

  if (!bar.datetime || typeof bar.datetime !== "string") {
    errors.push("datetime saknas eller är ogiltig");
  }

  const requiredPrices = ["open", "high", "low", "close"];

  for (const field of requiredPrices) {
    if (!isFiniteNumber(bar[field])) {
      errors.push(`${field} saknas eller är inte ett giltigt tal`);
    } else if (bar[field] <= 0) {
      errors.push(`${field} måste vara större än 0`);
    }
  }

  const hasValidOhlc = requiredPrices.every((field) =>
    isFiniteNumber(bar[field])
  );

  if (hasValidOhlc) {
    if (bar.high < bar.low) {
      errors.push("high är lägre än low");
    }

    if (bar.high < bar.open) {
      errors.push("high är lägre än open");
    }

    if (bar.high < bar.close) {
      errors.push("high är lägre än close");
    }

    if (bar.low > bar.open) {
      errors.push("low är högre än open");
    }

    if (bar.low > bar.close) {
      errors.push("low är högre än close");
    }
  }

  if (
    bar.volume !== null &&
    bar.volume !== undefined &&
    (!isFiniteNumber(bar.volume) || bar.volume < 0)
  ) {
    errors.push("volume är ogiltig");
  }

  return {
    valid: errors.length === 0,
    index,
    datetime: bar.datetime || null,
    errors,
  };
}

export function validateMarketBars(bars) {
  if (!Array.isArray(bars) || bars.length === 0) {
    return {
      valid: false,
      totalBars: 0,
      validBars: 0,
      invalidBars: 0,
      errors: [
        {
          index: null,
          datetime: null,
          errors: ["Inga candles finns att validera"],
        },
      ],
    };
  }

  const invalid = [];
const datasetErrors = [];
const seenDatetimes = new Set();

bars.forEach((bar, index) => {
  const datetime = bar?.datetime;

  if (typeof datetime === "string" && datetime) {
    if (seenDatetimes.has(datetime)) {
      datasetErrors.push({
        index,
        datetime,
        errors: ["Duplicerad candle-tid"],
      });
    }

    seenDatetimes.add(datetime);

    if (index > 0) {
      const previousDatetime = bars[index - 1]?.datetime;

      if (
        typeof previousDatetime === "string" &&
        previousDatetime &&
        datetime < previousDatetime
      ) {
        datasetErrors.push({
          index,
          datetime,
          errors: [
            `Candles ligger i fel tidsordning: ${datetime} efter ${previousDatetime}`,
          ],
        });
      }
    }
  }

  const result = validateCandle(bar, index);

  if (!result.valid) {
    invalid.push(result);
  }
});

const allErrors = [...invalid, ...datasetErrors];

const invalidIndexes = new Set(
  allErrors
    .map((item) => item.index)
    .filter((index) => index !== null)
);

return {
  valid: allErrors.length === 0,
  totalBars: bars.length,
  validBars: bars.length - invalidIndexes.size,
  invalidBars: invalidIndexes.size,
  errors: allErrors.slice(0, 20),
};
}