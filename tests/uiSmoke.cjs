// Optional browser smoke test. Requires Playwright and a running Vite server.
// PLAYWRIGHT_MODULE may point to a bundled Playwright installation.
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");

function createMockApi() {
  const saved = [];
  const newsRequests = [];
  let marketStatusFails = false;
  let paperPhase = null;
  function dailyBars() {
    const lastDate = new Date("2026-09-29T12:00:00Z");
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
    if (paperPhase === "followup") {
      bars.shift();
      bars.push({ datetime: "2026-09-29", open: 149.7, high: 150.5, low: 149.5, close: 150, volume: 1000000 });
    }
    return bars;
  }
  function scanCandidate(symbol, name, rank, isDay) {
    const bars = dailyBars();
    const plan = { setup: "PULLBACK", entry_reference: 149, stop: 139, target: 169, risk_per_share: 10, theoretical_risk_reward: 2 };
    return {
      symbol, name, exchange: "NASDAQ", currency: "USD", status: isDay ? "WAIT" : "TRADE",
      rank_score: rank, metrics: { rvol: rank / 2, atr: 2, price: 149, latest_datetime: "2026-09-28" },
      screening_selection: isDay ? null : { latest_closed_datetime: "2026-09-28" },
      swing_strategy_version: isDay ? null : "swing-v0.5-experimental",
      screening_setups: isDay ? [] : ["PULLBACK"], screening_plans: isDay ? [] : [plan],
      primary_setup: isDay ? null : "PULLBACK", signal_plan: isDay ? null : plan,
      decision: isDay ? null : { version: "readiness-v0.6", status: "TRADE" },
      data_snapshot: isDay ? null : { fetched_at: "2026-09-28T21:00:00.000Z", bars },
      reasons: ["Experimental trend filters passed"],
    };
  }
  function handleApi({ pathname, method = "GET", body: input = {}, searchParams = new URLSearchParams() }) {
    if (pathname === "/api/session") return { status: 200, body: { authenticated: true } };
    if (pathname === "/api/scan" && input.market === "stockholm") return { status: 200, body: {
      results: [
        { symbol: "TESTA", name: "Testbolag A", exchange: "OMX", currency: "SEK", status: "NOT_ASSESSED", rank_score: 0, metrics: null, reasons: ["Kursdata för rätt aktie och börs kunde inte verifieras."] },
        { symbol: "TESTB", name: "Testbolag B", exchange: "OMX", currency: "SEK", status: "NOT_ASSESSED", rank_score: 0, metrics: null, reasons: ["Kursdata för rätt aktie och börs kunde inte verifieras."] },
      ], next_offset: 2, total: 2, universe_size: 200, done: true, wait_ms: 0,
    } };
    if (pathname === "/api/scan") {
      const isDay = input.horizon === "day";
      return { status: 200, body: {
      results: [
        scanCandidate("NVDA", "NVIDIA", 4, isDay),
        scanCandidate("MOCKA", "Mock A", 3, isDay),
        scanCandidate("MOCKB", "Mock B", 2, isDay),
        scanCandidate("MOCKC", "Mock C", 1, isDay),
        { symbol: "BAD", name: "Rejected", exchange: "NYSE", status: "NO_TRADE", rank_score: 0, reasons: ["Missing reliable volume"] },
      ], next_offset: 5, total: 5, universe_size: 1000, done: true, wait_ms: 0,
    } };
    }
    if (pathname === "/api/market-data") {
      const ticker = searchParams.get("ticker");
      if (ticker === "FAILDATA") return { status: 502, body: { error: "Simulerat marknadsdatafel" } };
      const bars = dailyBars();
      return { status: 200, body: {
        ticker, requested_ticker: ticker, exchange: searchParams.get("exchange") || "NASDAQ", currency: "USD",
        verified_instrument: { symbol: ticker, name: ticker, exchange: searchParams.get("exchange") || "NASDAQ", currency: "USD", country: "United States", type: "Common Stock" },
        interval: searchParams.get("interval") || "1day", timezone: "America/New_York",
        fetched_at: paperPhase === null || paperPhase === "signal" ? "2026-09-28T21:00:00.000Z" : "2026-09-29T21:00:00.000Z",
        validation: { valid: true }, bars, latest: bars.at(-1), price: bars.at(-1).close,
      } };
    }
    if (pathname === "/api/market-status" && marketStatusFails) return { status: 502, body: { error: "Simulerat börsklocksfel" } };
    if (pathname === "/api/market-status" && paperPhase !== null) return { status: 200, body: {
      market: searchParams.get("market"), isOpen: false, label: "Mockad stängd börs",
      reason: "after_close", sessionDate: paperPhase === "signal" ? "2026-09-28" : "2026-09-29",
      timeZone: "America/New_York", earlyClose: false,
    } };
    if (pathname === "/api/market-status") return { status: 200, body: {
      market: searchParams.get("market"), isOpen: false, label: "Mockad stängd börs",
      reason: "after_close", sessionDate: "2026-09-28",
      timeZone: "America/New_York", earlyClose: false,
    } };
    if (pathname === "/api/analyze-news") {
      newsRequests.push(input.ticker);
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
  return { saved, newsRequests, handleApi, setMarketStatusFailure: (value) => { marketStatusFails = value; }, setPaperPhase: (value) => { paperPhase = value; } };
}

async function runSmoke() {
  const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
  let browser;
  try { browser = await chromium.launch({ headless: true, timeout: 10000 }); }
  catch { browser = await chromium.launch({ headless: true, channel: "msedge", timeout: 10000 }); }
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await page.clock.install({ time: new Date("2026-09-28T21:00:00Z") });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const mock = createMockApi();
    const { saved, newsRequests } = mock;
    const routeMockApi = async (target, mockApi) => target.route("**/api/**", async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      if (url.pathname.endsWith(".js")) { await route.continue(); return; }
      const input = request.postData() ? request.postDataJSON() : {};
      const { status, body } = mockApi.handleApi({ pathname: url.pathname, method: request.method(), body: input, searchParams: url.searchParams });
      await route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
    });
    await routeMockApi(page, mock);
    await page.goto(process.env.TEST_URL || "http://127.0.0.1:5173");
    try { await page.getByRole("heading", { name: "Sannolikhetsterminal", exact: true }).waitFor({ timeout: 10000 }); }
    catch (error) { console.log("UI diagnostics:", await page.locator("body").innerText(), errors); throw error; }
    await page.getByLabel("Marknad (välj aktiens börs)").selectOption("stockholm");
    const swedishScanner = page.getByRole("region", { name: "Marknadsskanner" });
    await swedishScanner.getByRole("button", { name: "Skanna marknaden", exact: true }).click();
    await swedishScanner.getByText("Skanningsrapporten är sparad i journalen, separat från faktiska trades.").waitFor();
    await swedishScanner.getByText(/EJ BEDÖMT · Ingen av de 2 kontrollerade aktierna kunde bedömas/).waitFor();
    assert.equal((await swedishScanner.innerText()).includes("NO TRADE"), false);
    assert.equal(saved[0].signal_inputs.scan_status, "NOT_ASSESSED");
    assert.deepEqual(saved[0].signal_inputs.results.map((item) => item.status), ["NOT_ASSESSED", "NOT_ASSESSED"]);
    await swedishScanner.getByText("Se mer – alla 2 instrument och bedömningar").click();
    await swedishScanner.getByText("TESTA · OMX · EJ BEDÖMT").waitFor();
    await page.getByLabel("Marknad (välj aktiens börs)").selectOption("usa");
    const scanner = page.getByRole("region", { name: "Marknadsskanner" });
    await scanner.getByRole("button", { name: "Skanna marknaden", exact: true }).click();
    await page.getByText("Skanningsrapporten är sparad i journalen, separat från faktiska trades.").waitFor();
    assert.equal(saved[0].signal_inputs.record_type, "SCAN");
    assert.equal(saved[0].signal_inputs.checked, 5);
    assert.equal(saved[0].strategy_version, "v0.7-experimental");
    assert.equal(saved[0].signal_inputs.scan_decision_policy, "TECHNICAL_ONLY");
    assert.deepEqual(saved[0].signal_inputs.results.filter((item) => item.status === "TRADE").map((item) => item.symbol), ["NVDA", "MOCKA", "MOCKB", "MOCKC"]);
    assert.deepEqual(newsRequests, [], "Scanning must not request or require news for technical signals");
    await scanner.getByText("4 aktuella experimentella TRADE-signaler", { exact: false }).waitFor();
    const signalJournal = page.getByRole("region", { name: "TRADE-signallogg" });
    await signalJournal.getByText("4 registrerade signaler", { exact: false }).waitFor();
    const [scanDownload] = await Promise.all([
      page.waitForEvent("download"),
      scanner.getByRole("button", { name: "Exportera skanningsrapport (JSON)" }).click(),
    ]);
    const scanJson = await fs.readFile(await scanDownload.path(), "utf8");
    const scanReport = JSON.parse(scanJson);
    assert.equal(scanReport.format, "sannolikhet-scan-report-v1");
    assert.equal(scanReport.market, "usa");
    assert.equal(scanReport.horizon, "week");
    assert.equal(scanReport.requested_limit, 20);
    assert.equal(scanReport.complete, true);
    assert.equal(scanReport.checked, 5);
    assert.equal(scanReport.results.length, 5);
    assert.deepEqual(scanReport.results.map((item) => item.status).sort(), ["NO_TRADE", "TRADE", "TRADE", "TRADE", "TRADE"]);
    assert.ok(scanReport.results.every((item) => Array.isArray(item.reasons) && item.reasons.length));
    assert.ok(scanReport.scan_started_at && scanReport.scan_finished_at && scanReport.seed);
    assert.equal(/api.?key|password|auth.?token/i.test(scanJson), false);
    await page.screenshot({ path: "tests/preview-scanner-desktop.png", fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
    await page.screenshot({ path: "tests/preview-scanner-mobile.png", fullPage: true });
    await scanner.getByRole("button", { name: "Öppna samlad analys" }).first().click();
    await page.getByText("Analysen och beslutet är sparade i journalen.", { exact: false }).waitFor();
    assert.equal(saved[0].ticker, "NVDA");
    assert.equal(saved[0].signal_inputs.record_type, "ANALYSIS");
    const savedBeforeManual = saved.length;
    const ticker = page.getByRole("textbox", { name: "Aktie / ticker" });
    await ticker.fill("");
    assert.equal(await page.getByRole("button", { name: "Starta analys" }).isDisabled(), true);
    await ticker.fill("NVDA");
    await page.getByRole("button", { name: "Starta analys" }).click();
    await page.getByText("Analysen och beslutet är sparade i journalen.", { exact: false }).waitFor();
    assert.equal(saved.length, savedBeforeManual + 1);
    assert.equal(saved[0].signal_inputs.decision.status, "TRADE");
    await signalJournal.getByText("4 registrerade signaler", { exact: false }).waitFor();
    assert.equal(saved[0].winner, null);
    const result = page.getByRole("region", { name: "Samlad analys" });
    await result.getByText("UPPLÄGG HITTAT", { exact: true }).waitFor();
    await result.locator('[aria-label="Datakontroll för swing"]').getByText(/Senaste levererade dagskurs:/).waitFor();
    assert.equal(saved[0].signal_inputs.strategy.status, "WATCH");
    assert.equal(saved[0].signal_inputs.news_requested, false);
    assert.deepEqual(newsRequests, []);
    const newsDetails = result.getByText("Se mer – nyheter, graf och data", { exact: true });
    await newsDetails.click();
    await result.getByText("Nyheter hämtades inte för den här analysen.", { exact: true }).waitFor();
    await newsDetails.click();
    const savedBeforeOptionalNews = saved.length;
    await result.getByRole("button", { name: "Hämta valfri nyhetsbakgrund" }).click();
    await result.getByText("Kort nyhetssammanfattning.", { exact: true }).waitFor();
    assert.deepEqual(newsRequests, ["NVDA"]);
    assert.equal(saved.length, savedBeforeOptionalNews);
    assert.equal(saved[0].signal_inputs.news_requested, false);
    assert.equal(saved[0].signal_inputs.decision.status, "TRADE");
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
    const risk = result.locator("details").filter({ hasText: "Se mer – rekyl mot EMA20 · provisorisk riskplan" });
    await risk.locator("summary").click();
    await risk.getByLabel("Kontokapital (USD)").fill("10000");
    await risk.getByLabel("Max risk per trade (%)").fill("1");
    await risk.getByText(/Kalkyl: högst \d+ hela aktier/).waitFor();
    assert.equal(saved[0].signal_inputs.decision.status, "TRADE");
    assert.equal(saved[0].trade_status, "SIGNAL_ONLY");
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
    await ticker.fill("AMD");
    assert.equal(await page.getByRole("region", { name: "Samlad analys" }).count(), 0);
    for (const failedTicker of ["FAIL", "FAILDATA"]) {
      await ticker.fill(failedTicker);
      await page.getByRole("button", { name: "Starta analys" }).click();
      await page.getByText("Analysen och beslutet är sparade i journalen.", { exact: false }).waitFor();
      assert.equal(saved[0].signal_inputs.decision.status, failedTicker === "FAIL" ? "TRADE" : "NOT_ASSESSED");
      assert.equal(saved[0].signal_inputs.strategy.status, failedTicker === "FAIL" ? "WATCH" : "NOT_ASSESSED");
      if (failedTicker === "FAILDATA") {
        assert.deepEqual(saved[0].signal_inputs.strategy.plans, []);
        const failedAnalysis = page.getByRole("region", { name: "Samlad analys" });
        await failedAnalysis.locator('[aria-label="Datakontroll för swing"]').getByText("Marknadsdata saknas. Se felorsaken ovan.").waitFor();
        await failedAnalysis.locator('[aria-label="Experimentell swingbedömning"]').getByText("EJ BEDÖMT", { exact: true }).waitFor();
      } else {
        assert.ok(saved[0].signal_inputs.strategy.plans.length > 0);
        await page.getByRole("region", { name: "Samlad analys" }).getByText("UPPLÄGG HITTAT", { exact: true }).waitFor();
        const failedAnalysis = page.getByRole("region", { name: "Samlad analys" });
        await failedAnalysis.getByRole("button", { name: "Hämta valfri nyhetsbakgrund" }).click();
        await failedAnalysis.getByText(/Valfria nyheter kunde inte hämtas: Simulerat nyhetsfel/).waitFor();
        assert.equal(saved[0].signal_inputs.decision.status, "TRADE");
      }
    }
    await journal.getByText("Utfall i hämtad journal", { exact: true }).click();
    await journal.getByText("Avslutade faktiska trades med giltigt utfall: 1.", { exact: true }).waitFor();
    assert.match(await journal.getByText("Medel-R", { exact: true }).locator("..").innerText(), /1,80 R/);
    await page.getByLabel("Tidshorisont").selectOption("day");
    await page.getByRole("navigation", { name: "Analysläge" }).getByRole("button", { name: "Skanna marknaden" }).click();
    const dayScanner = page.getByRole("region", { name: "Marknadsskanner" });
    await dayScanner.getByRole("button", { name: "Skanna marknaden", exact: true }).click();
    await dayScanner.getByText("4 tekniska förfilterträffar (inte TRADE-signaler)", { exact: false }).waitFor();
    await dayScanner.getByText("Daytradeskannern är ett tekniskt förfilter.", { exact: false }).waitFor();
    await dayScanner.getByRole("button", { name: "Öppna samlad analys" }).first().click();
    await page.getByText("Analysen och beslutet är sparade i journalen.", { exact: false }).waitFor();
    assert.equal(saved[0].signal_inputs.decision.status, "NOT_ASSESSED");
    await page.getByLabel("Tidshorisont").selectOption("week");
    mock.setMarketStatusFailure(true);
    await page.getByRole("button", { name: "Starta analys" }).click();
    await page.getByText("Analysen och beslutet är sparade i journalen.", { exact: false }).waitFor();
    assert.equal(saved[0].signal_inputs.strategy.status, "NOT_ASSESSED");
    assert.equal(saved[0].signal_inputs.decision.status, "NOT_ASSESSED");
    await page.getByRole("region", { name: "Samlad analys" }).locator('[aria-label="Datakontroll för swing"]').getByText("Börsklockan kunde inte verifieras. Se felorsaken ovan.").waitFor();
    await page.getByRole("region", { name: "Samlad analys" }).getByRole("button", { name: "Hämta valfri nyhetsbakgrund" }).click();
    await page.getByRole("region", { name: "Samlad analys" }).getByText("Kort nyhetssammanfattning.", { exact: true }).waitFor();
    assert.equal(saved[0].signal_inputs.decision.status, "NOT_ASSESSED");

    const paperPage = await browser.newPage({ viewport: { width: 1280, height: 900 }, timezoneId: "Europe/Stockholm" });
    paperPage.on("pageerror", (error) => errors.push(error.message));
    const paperMock = createMockApi();
    paperMock.setPaperPhase("signal");
    await paperPage.clock.install({ time: new Date("2026-09-28T21:00:00Z") });
    await routeMockApi(paperPage, paperMock);
    await paperPage.goto(process.env.TEST_URL || "http://127.0.0.1:5173");
    await paperPage.getByRole("heading", { name: "Sannolikhetsterminal", exact: true }).waitFor();
    await paperPage.getByLabel("Tidshorisont").selectOption("week");
    await paperPage.getByLabel("Marknad (välj aktiens börs)").selectOption("usa");
    await paperPage.getByRole("navigation", { name: "Analysläge" }).getByRole("button", { name: "Analysera en aktie" }).click();
    await paperPage.getByRole("textbox", { name: "Aktie / ticker" }).fill("NVDA");
    await paperPage.getByRole("button", { name: "Starta analys" }).click();
    await paperPage.getByRole("region", { name: "Samlad analys" }).getByText("UPPLÄGG HITTAT", { exact: true }).waitFor();
    const paperJournal = paperPage.getByRole("region", { name: "Paperlogg" });
    await paperJournal.getByText("Spara teknisk TRADE-signal för uppföljning", { exact: true }).click();
    await paperJournal.getByLabel("Max observerade sessioner").selectOption("1");
    await paperJournal.getByLabel("Fast simulerat aktieantal").fill("2");
    await paperJournal.getByLabel("Avgift per order (USD)").fill("1");
    await paperJournal.getByLabel("Slippage i baspunkter").fill("10");
    await paperJournal.getByRole("button", { name: "Spara paperobservation" }).click();
    await paperJournal.getByText("TRADE-signalens tekniska upplägg är låst och sparat lokalt.", { exact: false }).waitFor();
    const readPaper = () => paperPage.evaluate(() => JSON.parse(localStorage.getItem("sannolikhet-paper-observations-v1")).records);
    const [captured] = await readPaper();
    assert.equal(captured.status, "PENDING_ENTRY");
    assert.equal(captured.signalDate, "2026-09-28");
    assert.equal(captured.sourceDecisionStatus, "TRADE");
    assert.equal(captured.holdingSessions, 1);
    assert.equal(captured.feePerOrder, 1);
    assert.equal(captured.slippageBps, 10);
    await paperPage.getByRole("button", { name: "Starta analys" }).click();
    await paperPage.getByRole("region", { name: "Samlad analys" }).getByText("UPPLÄGG HITTAT", { exact: true }).waitFor();
    await paperJournal.getByText("Spara teknisk TRADE-signal för uppföljning", { exact: true }).click();
    await paperJournal.getByLabel("Max observerade sessioner").selectOption("1");
    await paperJournal.getByLabel("Fast simulerat aktieantal").fill("2");
    await paperJournal.getByLabel("Avgift per order (USD)").fill("1");
    await paperJournal.getByLabel("Slippage i baspunkter").fill("10");
    await paperJournal.getByRole("button", { name: "Spara paperobservation" }).click();
    await paperJournal.getByText(/Samma aktie, upplägg och signaldatum finns redan i paperloggen/).waitFor();
    assert.equal((await readPaper()).length, 1);

    paperMock.setPaperPhase("stale");
    await paperPage.clock.setFixedTime(new Date("2026-09-29T14:05:00Z"));
    const tradingView = paperPage.getByRole("region", { name: "TradingView-paperjournal" });
    await tradingView.getByText(/Registrera TradingView-paperköp för NVDA/).click();
    await tradingView.getByLabel("Köptid i lokal tid").fill("2026-09-29T16:00");
    await tradingView.getByLabel("Fyllt köppris (USD)").fill(String(captured.plan.entry_reference));
    await tradingView.getByLabel("Fyllt antal aktier").fill("2");
    await tradingView.getByLabel("Köpavgift (USD, ange 0 om ingen)").fill("1");
    await tradingView.getByRole("button", { name: "Spara fyllt paperköp" }).click();
    await tradingView.getByText(/TradingViews fyllda paperköp är sparat lokalt/).waitFor();
    const readTradingView = () => paperPage.evaluate(() => JSON.parse(localStorage.getItem("sannolikhet-tradingview-paper-orders-v1")).records);
    assert.equal((await readTradingView())[0].status, "OPEN");
    assert.equal((await readTradingView())[0].entryLateLogged, false);

    await paperPage.clock.setFixedTime(new Date("2026-09-29T21:00:00Z"));
    await paperPage.clock.runFor(60_000);
    await paperJournal.getByRole("button", { name: "Kontrollera öppna paperposter" }).click();
    await paperJournal.getByText(/1 instrument kontrollerades med 1 dataanrop/).waitFor();
    assert.equal((await readPaper())[0].status, "NOT_ASSESSED");

    paperMock.setPaperPhase("followup");
    await paperJournal.getByRole("button", { name: "Kontrollera öppna paperposter" }).click();
    await paperJournal.getByText(/1 observationer · 1 avslutade/).waitFor();
    const [settled] = await readPaper();
    assert.equal(settled.id, captured.id);
    assert.equal(settled.status, "CLOSED");
    assert.equal(settled.entryDate, "2026-09-29");
    assert.equal(settled.exitDate, "2026-09-29");
    assert.equal(settled.holdingBars, 1);
    assert.equal(settled.exitReason, "TIME_EXIT");
    assert.ok(Number.isFinite(settled.netPnl));
    assert.ok(Number.isFinite(settled.resultR));
    await tradingView.getByText("Registrera full försäljning från TradingView").click();
    await tradingView.getByLabel("Säljtid i lokal tid").fill("2026-09-29T21:30");
    await tradingView.getByLabel("Fyllt säljpris (USD)").fill("151");
    await tradingView.getByLabel("Antal sålda aktier (hela innehavet: 2)").fill("2");
    await tradingView.getByLabel("Säljavgift (USD, ange 0 om ingen)").fill("1");
    await tradingView.getByRole("button", { name: "Spara avslutad paperorder" }).click();
    await tradingView.getByText(/TradingViews fyllda försäljning är sparad lokalt/).waitFor();
    const [manual] = await readTradingView();
    assert.equal(manual.status, "CLOSED");
    assert.equal(manual.sourcePaperObservationId, captured.id);
    assert.equal(manual.netPnl, (151 - manual.entryPrice) * 2 - 2);
    assert.equal((await readPaper())[0].netPnl, settled.netPnl);
    await paperPage.reload();
    assert.equal((await readPaper())[0].status, "CLOSED");
    assert.equal((await readTradingView())[0].status, "CLOSED");
    assert.deepEqual(errors, []);
    console.log("Browser smoke passed: scanner export, swing TRADE, duplicate guard, TradingView manual paper fill and close, theoretical paper follow-up with stale-data retry, optional news, day prefilter, real trade mock, missing market clock and mobile layout.");
  } finally { await browser.close(); }
}

module.exports = { createMockApi };
if (require.main === module) runSmoke().catch((error) => { console.error(error); process.exitCode = 1; });
