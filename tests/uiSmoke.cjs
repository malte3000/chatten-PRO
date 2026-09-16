// Optional browser smoke test. Requires Playwright and a running Vite server.
// PLAYWRIGHT_MODULE may point to a bundled Playwright installation.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const assert = require("node:assert/strict");

(async () => {
  let browser;
  try { browser = await chromium.launch({ headless: true, timeout: 10000 }); }
  catch { browser = await chromium.launch({ headless: true, channel: "msedge", timeout: 10000 }); }
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const saved = [];
    await page.route("**/api/**", async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      let body;
      let status = 200;
      if (url.pathname === "/api/session") body = { authenticated: true };
      else if (url.pathname === "/api/scan") {
        const input = request.postDataJSON();
        assert.equal(input.market, "usa"); assert.equal(input.limit, 20); assert.equal(input.horizon, "week");
        body = { results: [
          { symbol: "NVDA", name: "NVIDIA", exchange: "NASDAQ", currency: "USD", status: "WAIT", rank_score: 4, metrics: { rvol: 2, atr: 2 }, reasons: ["Experimental trend filters passed"] },
          { symbol: "BAD", name: "Rejected", exchange: "NYSE", status: "NO_TRADE", rank_score: 0, reasons: ["Missing reliable volume"] },
        ], next_offset: 2, total: 2, universe_size: 1000, done: true, wait_ms: 0 };
      }
      else if (url.pathname === "/api/trades") {
        if (request.method() === "POST") { const record = request.postDataJSON(); saved.unshift(record); body = { success: true, trade: record }; status = 201; }
        else body = { trades: saved };
      } else if (url.pathname === "/api/market-data") {
        if (url.searchParams.get("exchange")) assert.equal(url.searchParams.get("exchange"), "NASDAQ");
        assert.equal(url.searchParams.get("interval"), "1day");
        body = { ticker: url.searchParams.get("ticker"), price: 100, validation: { valid: true }, bars: [{ datetime: "2026-09-16", open: 99, high: 101, low: 98, close: 100, volume: 1000 }] };
      } else if (url.pathname === "/api/analyze-news") {
        const input = request.postDataJSON();
        body = { ticker: input.ticker, direction: "upp", direction_confidence: 100, summary: "Kort nyhetssammanfattning.", reasoning: "Fullständig motivering som visas under Se mer.", key_news: [] };
        if (input.ticker === "FAIL") { body = { error: "Simulerat nyhetsfel" }; status = 502; }
      } else body = {};
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
    assert.equal(await result.getByText("Fullständig motivering som visas under Se mer.", { exact: true }).isVisible(), false);
    await result.locator("summary").click();
    assert.equal(await result.getByText("Fullständig motivering som visas under Se mer.", { exact: true }).isVisible(), true);
    await result.locator("summary").click();
    await page.screenshot({ path: "tests/preview-desktop.png", fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
    await page.screenshot({ path: "tests/preview-mobile.png", fullPage: true });
    await ticker.fill("AMD");
    assert.equal(await page.getByRole("region", { name: "Samlad analys" }).count(), 0);
    await ticker.fill("FAIL");
    await page.getByRole("button", { name: "Starta analys" }).click();
    await page.getByText("Analysförslaget är sparat i journalen.", { exact: false }).waitFor();
    assert.equal(saved[0].signal_inputs.decision.status, "NO_TRADE");
    assert.deepEqual(errors, []);
    console.log("Browser smoke passed: compact flow, save/read, details, ticker invalidation, mobile layout, fail-closed errors.");
  } finally { await browser.close(); }
})().catch((error) => { console.error(error); process.exitCode = 1; });
