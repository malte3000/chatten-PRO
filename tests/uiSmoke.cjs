// Optional browser smoke test. Requires Playwright and a running Vite server.
// PLAYWRIGHT_MODULE may point to a bundled Playwright installation.
const assert = require("node:assert/strict");

function createMockApi() {
  const saved = [];
  function dailyBars() {
    const lastDate = new Date();
    lastDate.setUTCHours(0, 0, 0, 0);
    lastDate.setUTCDate(lastDate.getUTCDate() - 1);
    const dates = [];
    let date = lastDate;
    while (dates.length < 100) {
      if (![0, 6].includes(date.getUTCDay())) dates.unshift(date.toISOString().slice(0, 10));
      date = new Date(date.getTime() - 86400000);
    }
    const bars = dates.map((datetime, index) => {
      const close = 50 + index;
      return { datetime, open: close - 0.3, high: close + 0.5, low: close - 0.5, close, volume: 1000000 };
    });
    bars[79].low = 119.8;
    bars[99].low = 139.8;
    return bars;
  }
  function handleApi({ pathname, method = "GET", body: input = {}, searchParams = new URLSearchParams() }) {
    if (pathname === "/api/session") return { status: 200, body: { authenticated: true } };
    if (pathname === "/api/scan") return { status: 200, body: {
      results: [
        { symbol: "NVDA", name: "NVIDIA", exchange: "NASDAQ", currency: "USD", status: "WAIT", rank_score: 4, metrics: { rvol: 2, atr: 2 }, reasons: ["Experimental trend filters passed"] },
        { symbol: "BAD", name: "Rejected", exchange: "NYSE", status: "NO_TRADE", rank_score: 0, reasons: ["Missing reliable volume"] },
      ], next_offset: 2, total: 2, universe_size: 1000, done: true, wait_ms: 0,
    } };
    if (pathname === "/api/market-data") {
      const ticker = searchParams.get("ticker");
      if (ticker === "FAILDATA") return { status: 502, body: { error: "Simulerat marknadsdatafel" } };
      const bars = dailyBars();
      return { status: 200, body: {
        ticker, requested_ticker: ticker, exchange: searchParams.get("exchange") || "NASDAQ", currency: "USD",
        interval: searchParams.get("interval") || "1day", timezone: "America/New_York", fetched_at: new Date().toISOString(),
        validation: { valid: true }, bars, latest: bars.at(-1), price: bars.at(-1).close,
      } };
    }
    if (pathname === "/api/analyze-news") {
      if (input.ticker === "FAIL") return { status: 502, body: { error: "Simulerat nyhetsfel" } };
      return { status: 200, body: {
        ticker: input.ticker, direction: "upp", direction_confidence: 100, probability_up: null,
        summary: "Kort nyhetssammanfattning.", reasoning: "Fullständig motivering som visas under Se mer.", key_news: [],
        marketStatus: { market: input.market || "usa", isOpen: false, label: "Mockad stängd börs" },
      } };
    }
    if (pathname === "/api/trades") {
      if (method === "POST") {
        saved.unshift(structuredClone(input));
        return { status: 201, body: { success: true, trade: structuredClone(input) } };
      }
      if (method === "PATCH") {
        const trade = saved.find((record) => record.trade_id === input.trade_id);
        if (!trade || trade.trade_status !== "OPEN" || trade.signal_inputs?.record_type !== "REAL_TRADE") {
          return { status: 409, body: { error: "Endast en öppen faktisk trade kan stängas i mockjournalen." } };
        }
        const exit = Number(input.exit_price);
        const fees = Number(input.fees || 0);
        const entry = Number(trade.entry_price);
        const size = Number(trade.position_size);
        const side = trade.direction === "LONG" ? 1 : trade.direction === "SHORT" ? -1 : 0;
        if (![exit, entry, size].every((value) => Number.isFinite(value) && value > 0) || !Number.isFinite(fees) || fees < 0 || !side) {
          return { status: 400, body: { error: "Ogiltiga avslutsvärden i mockjournalen." } };
        }
        const gross = (exit - entry) * side * size;
        const totalFees = Number(trade.signal_inputs.actual_entry_fees || 0) + fees;
        const net = Number((gross - totalFees).toFixed(8));
        const risk = trade.stop_loss == null ? null : Math.abs(entry - Number(trade.stop_loss)) * size;
        Object.assign(trade, {
          trade_status: "CLOSED", exit_price: exit, exit_reason: input.exit_reason,
          result_percent: Number((net / (entry * size) * 100).toFixed(8)), result_r: risk ? Number((net / risk).toFixed(8)) : null,
          winner: Math.abs(net) < 1e-8 ? null : net > 0,
          signal_inputs: { ...trade.signal_inputs, closed_at: new Date().toISOString(), actual_exit_fees: fees, total_actual_fees: totalFees, gross_pnl: gross, net_pnl: net },
        });
        return { status: 200, body: { success: true, trade: structuredClone(trade) } };
      }
      if (method === "GET") return { status: 200, body: { success: true, trades: structuredClone(saved) } };
    }
    return { status: 404, body: { error: "Ingen mock finns för denna API-route." } };
  }
  return { saved, handleApi };
}

async function runSmoke() {
  const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
  let browser;
  try { browser = await chromium.launch({ headless: true, timeout: 10000 }); }
  catch { browser = await chromium.launch({ headless: true, channel: "msedge", timeout: 10000 }); }
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const mock = createMockApi();
    const { saved } = mock;
    await page.route("**/api/**", async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      const input = request.postData() ? request.postDataJSON() : {};
      const { status, body } = mock.handleApi({ pathname: url.pathname, method: request.method(), body: input, searchParams: url.searchParams });
      await route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
    });
    await page.goto(process.env.TEST_URL || "http://127.0.0.1:5173");
    try { await page.getByRole("heading", { name: "Sannolikhetsterminal", exact: true }).waitFor({ timeout: 10000 }); }
    catch (error) { console.log("UI diagnostics:", await page.locator("body").innerText(), errors); throw error; }
    const scanner = page.getByRole("region", { name: "Marknadsskanner" });
    await scanner.getByRole("button", { name: "Skanna marknaden", exact: true }).click();
    await page.getByText("Skanningsrapporten är sparad i journalen, separat från faktiska trades.").waitFor();
    assert.equal(saved[0].signal_inputs.record_type, "SCAN");
    assert.equal(saved[0].signal_inputs.checked, 2);
    await page.screenshot({ path: "tests/preview-scanner-desktop.png", fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
    await page.screenshot({ path: "tests/preview-scanner-mobile.png", fullPage: true });
    await scanner.getByRole("button", { name: "Öppna samlad analys" }).click();
    await page.getByText("Analysförslaget är sparat i journalen.", { exact: false }).waitFor();
    assert.equal(saved[0].ticker, "NVDA");
    assert.equal(saved[0].signal_inputs.record_type, "ANALYSIS");
    const savedBeforeManual = saved.length;
    const ticker = page.getByRole("textbox", { name: "Aktie / ticker" });
    await ticker.fill("");
    assert.equal(await page.getByRole("button", { name: "Starta analys" }).isDisabled(), true);
    await ticker.fill("NVDA");
    await page.getByRole("button", { name: "Starta analys" }).click();
    await page.getByText("Analysförslaget är sparat i journalen.", { exact: false }).waitFor();
    assert.equal(saved.length, savedBeforeManual + 1);
    assert.equal(saved[0].signal_inputs.decision.status, "WAIT");
    assert.equal(saved[0].winner, null);
    const result = page.getByRole("region", { name: "Samlad analys" });
    await result.getByText("BEVAKA", { exact: true }).waitFor();
    assert.equal(saved[0].signal_inputs.strategy.status, "WATCH");
    const newsDetails = result.getByText("Se mer – nyheter, graf och data", { exact: true });
    assert.equal(await result.getByText("Fullständig motivering som visas under Se mer.", { exact: true }).isVisible(), false);
    await newsDetails.click();
    assert.equal(await result.getByText("Fullständig motivering som visas under Se mer.", { exact: true }).isVisible(), true);
    await newsDetails.click();
    const replay = result.locator("details").filter({ hasText: "Se mer – historiskt prisprov" });
    await replay.locator("summary").first().click();
    await replay.getByLabel("Fast antal simulerade aktier").fill("2");
    await replay.getByLabel("Avgift per order (USD)").fill("1");
    await replay.getByLabel("Slippage (baspunkter, 10 = 0,1 %)").fill("10");
    const savedBeforeReplay = saved.length;
    await replay.getByRole("button", { name: "Kör prisprov på hämtad data", exact: true }).click();
    await replay.getByText(/1 stängda simuleringar/).waitFor();
    assert.equal(saved.length, savedBeforeReplay);
    await replay.locator("summary").first().click();
    const risk = result.locator("details").filter({ hasText: "Se mer – pullback · provisorisk riskplan" });
    await risk.locator("summary").click();
    await risk.getByLabel("Kontokapital (USD)").fill("10000");
    await risk.getByLabel("Max risk per trade (%)").fill("1");
    await risk.getByText(/Kalkyl: högst \d+ hela aktier/).waitFor();
    assert.equal(saved[0].signal_inputs.decision.status, "WAIT");
    assert.equal(saved[0].trade_status, "NO_TRADE");
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.screenshot({ path: "tests/preview-desktop.png", fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
    await page.screenshot({ path: "tests/preview-mobile.png", fullPage: true });

    const realTrade = result.locator("details").filter({ hasText: "Se mer – registrera en faktisk trade" });
    await realTrade.locator("summary").click();
    await realTrade.getByLabel("Faktiskt ingångspris").fill("100");
    await realTrade.getByLabel("Stoppris, om satt").fill("95");
    await realTrade.getByLabel("Målpris, om satt").fill("110");
    await realTrade.getByLabel("Antal aktier/enheter").fill("2");
    await realTrade.getByLabel("Avgift vid ingång (USD)").fill("1");
    await realTrade.getByRole("button", { name: "Spara faktisk trade", exact: true }).click();
    await realTrade.getByText("Faktisk trade sparad som öppen.").waitFor();
    assert.equal(saved[0].signal_inputs.record_type, "REAL_TRADE");
    assert.equal(saved[0].trade_status, "OPEN");
    assert.ok(saved[0].signal_inputs.source_analysis_trade_id);
    const journal = page.getByRole("region", { name: "Journal" });
    const closeTrade = journal.locator("details").filter({ hasText: "Se mer – registrera utgång" });
    await closeTrade.locator("summary").click();
    await closeTrade.getByLabel("Faktiskt utgångspris").fill("110");
    await closeTrade.getByLabel("Avgift vid utgång (USD)").fill("1");
    await closeTrade.getByLabel("Avslutsorsak").selectOption("TARGET");
    await closeTrade.getByRole("button", { name: "Stäng och beräkna utfall", exact: true }).click();
    await journal.getByText("Nettoresultat: 9.00% · 1.80R · vinst", { exact: true }).waitFor();
    assert.equal(saved[0].trade_status, "CLOSED");
    assert.equal(saved[0].result_percent, 9);
    assert.equal(saved[0].result_r, 1.8);
    await journal.getByText("Utfall i hämtad journal", { exact: true }).click();
    await journal.getByText("Avslutade faktiska trades med giltigt utfall: 1.", { exact: true }).waitFor();
    assert.equal(await journal.getByText("1,80 R", { exact: true }).isVisible(), true);

    await ticker.fill("AMD");
    assert.equal(await page.getByRole("region", { name: "Samlad analys" }).count(), 0);
    for (const failedTicker of ["FAIL", "FAILDATA"]) {
      await ticker.fill(failedTicker);
      await page.getByRole("button", { name: "Starta analys" }).click();
      await page.getByText("Analysförslaget är sparat i journalen.", { exact: false }).waitFor();
      assert.equal(saved[0].signal_inputs.decision.status, "NO_TRADE");
      assert.equal(saved[0].signal_inputs.strategy.status, "NOT_ASSESSED");
      assert.deepEqual(saved[0].signal_inputs.strategy.plans, []);
      await page.getByRole("region", { name: "Samlad analys" }).getByText("EJ BEDÖMT", { exact: true }).waitFor();
    }
    assert.deepEqual(errors, []);
    console.log("Browser smoke passed: scanner, swing watch/risk calculation, actual trade save/close, details, ticker invalidation, mobile layout, missing-provider regression.");
  } finally { await browser.close(); }
}

module.exports = { createMockApi };
if (require.main === module) runSmoke().catch((error) => { console.error(error); process.exitCode = 1; });
