export function isClearlyUnsupportedProduct(item) {
  const symbol = String(item?.symbol || "").toUpperCase();
  const name = String(item?.name || "").toUpperCase();
  return /^(?:BULL|BEAR|MINI|TURBO)(?:[.\s-]|$)/.test(symbol) ||
    /\.AVA\./.test(symbol) ||
    /\.(?:WT|WTS|WS)(?:\.[A-Z])?$/.test(symbol) ||
    /\b(?:WARRANTS?|CERTIFICATES?|MINI FUTURE|TURBO|BULL CERTIFICATE|BEAR CERTIFICATE)\b/.test(name);
}

export function isSupportedCommonStock(item, market) {
  const exchange = String(item?.exchange || "");
  const supportedExchange = market === "usa"
    ? ["NASDAQ", "NYSE"].includes(exchange.toUpperCase())
    : market === "stockholm" && (item?.mic_code === "XSTO" || /stockholm|^OMX$/i.test(exchange));
  return Boolean(supportedExchange) && item?.type === "Common Stock" &&
    item?.country === (market === "usa" ? "United States" : "Sweden") &&
    String(item?.currency || "").toUpperCase() === (market === "usa" ? "USD" : "SEK") &&
    /^[A-Z0-9._ -]{1,20}$/i.test(item?.symbol || "") && !isClearlyUnsupportedProduct(item);
}
