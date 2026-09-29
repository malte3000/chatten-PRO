# Sannolikhetsterminal

React/Vite. Swingtrading först, daytrading sekundärt. Ingen orderläggning.

## Första etappen: kompakt analys

Ange en ticker och välj horisont. **Starta analys** hämtar OHLCV och nyheter
parallellt. En valfri graf kräver explicit tickerbekräftelse. **Se mer** öppnar
hela analysoutputen och datasnapshoten. Byte av ticker, marknad eller horisont
ogiltigförklarar resultat och avbryter gamla förfrågningar.
Marknad kan väljas som USA, Sverige/Stockholm eller Av (endast analys).
Av påverkar öppettidskontrollen, inte datakällans börs eller TRADE-spärren.

Besluten är TRADE, AVVAKTA och NO TRADE. **TRADE är spärrat i denna etapp**:
teknisk signalmotor, riskplan och strategivalidering är inte implementerade.
Giltiga inputs kan ge AVVAKTA; saknade/ogiltiga inputs ger NO TRADE.
AI-confidence används aldrig som uppgångssannolikhet. Ingen träffsäkerhet är
uppmätt eller utlovad. Den gamla simulatorn finns i `src/LegacySimulator.jsx`
som arkiverad kod och är inte monterad i appen.

Manuell aktieanalys i swingläge visar nu även en experimentell pullback-/breakout-
bevakning på färdigställda dagsljus. Den är märkt WATCH/NO_SETUP och använder
ännu inget referensfilter i den vanliga analysen. Reglerna är inte historiskt
validerade. En WATCH kan
visa provisorisk ATR-stop, 2R-målnivå och en kalkyl av högsta hela aktieantalet
från användarens eget kapital och riskprocent. Detta är inte en validerad
Risk Engine och kan inte godkänna TRADE.

`swing-v0.2-experimental` kontrollerar börsens tidszon och verkliga sessionsdatum.
Dagens ofärdiga dagsljus tas bort; gårdagens behålls även om börsen är öppen.
Alla använda dagsljus kräver positiv volym. Färskhetsgränsen är fem kalenderdagar,
inte en fullständig kontroll av saknade handelssessioner.

Nyhetsanalys körs även utanför öppettider. Ofullständiga (`pause_turn`,
`max_tokens`) och felaktigt formaterade svar nekas säkert. Strukturerad
provider-output och återupptagning av pausade sökningar är senare arbete.
Även sökverktygsfel inuti ett HTTP 200-svar nekas. Grafbilder begränsas till
JPEG, PNG, WebP och GIF, högst 3 MiB; bildanalys måste vara komplett och ha
giltiga fält innan den visas som godkänd API-output.
Anthropic-funktionerna rapporterar saknad servernyckel tydligt; Twelve Data har
15 sekunders timeout, Anthropic 50 sekunder och Supabase 12 sekunder per anrop.
`vercel.json` sätter funktionernas tidsgränser så långa nyhetssökningar får tid
att slutföras. API-klienten visar begripligare fel även när deploymentplattformen
svarar med HTML i stället för JSON.

## Marknadsskanner (experimentell första version)

Standardläget **Skanna marknaden** kräver inte en ticker. Välj USA/Sverige,
swing/daytrade och budget 20, 40 eller 100 aktier. Instrument hämtas automatiskt
från Twelve Datas `/stocks` (Common Stock, NASDAQ/NYSE eller OMX/XSTO).
Urvalet är deterministiskt för UTC-datum och varierar dagligen; det är INTE
hela börsen eller de bevisat bästa aktierna. Antal kontrollerade, lista och
bortgallringar visas. Av kräver att användaren väljer marknad för skanning.

Skannern hämtar 100 candles per aktie och kräver minst 60 giltiga candles,
volymdata, rätt symbol/börs/valuta och tillräckligt färska tidsstämplar.
Försöksfilter: pris > EMA20 > EMA50, positivt fem-candle-momentum, RVOL >= 1,
ATR 0,2–8 procent och genomsnittlig candle-omsättning >= 1 M USD / 10 M SEK.
För daytrade gäller omsättningen per 15-minuterscandle, inte per dag.
RVOL jämför senaste candle med föregående 20 candles; inte samma klockslag
andra dagar. Senaste candle kan vara ofullständig. Dessa startregler är inte
backtestade och kan missa bra lägen. Filterpoäng 0–4 är aldrig vinstsannolikhet.

Nyheter hämtas automatiskt för högst tre främsta tekniska kandidater.
Negativa nyheter eller nyhetsfel blockerar kandidaten. Andra kandidater
märks som utan nyhetsanalys och kan öppnas i den samlade analysen.
Alla positiva kandidater stannar på AVVAKTA tills Risk Engine och tester finns.
Warranter/certifikat erbjuds inte utan separat produktdata och riskanalys.

Serverendpoint `/api/scan` är autentiserad och väljer instrument på servern;
klienten skickar inte godtyckliga tickers. `SCAN_BATCH_SIZE` är 1–8, standard 4.
Varje symbol drar en API-kredit även i batch. Mellan batcher väntar klienten
61 sekunder. Aktielistan cachas i serverminnet i tre timmar. Kvotkontrollen i
serverminnet är best-effort per varm instans, inte en global begränsning mellan
Vercel-instanser eller andra API-anrop. Kör inte samtidiga skanningar innan en
distribuerad kvot/jobbtjänst finns. Start sker endast vid klick, ingen bakgrunds-
automation. Browser måste vara öppen; Stoppa bevarar en ofullständig rapport.

En rapport sparas via befintlig `/api/trades` med `record_type=SCAN` i
`signal_inputs`, syntetisk ticker SCAN-USA/SCAN-SE och inga tradeutfall.
Journal/statistik måste skilja SCAN, ANALYSIS och faktiska trades.
Returnerad OHLCV sparas i rapportens data_snapshot tillsammans med tidszon,
intervall och hämttid för att testerna ska kunna reproduceras utan framtida data.
Dagskurser är börsens lokala sessionsdatum; intradagskurser begärs i UTC.
Detta följer [Twelve Datas tidszonsregler för time_series](https://twelvedata.com/docs).
Publik OMX/XSTO-listning är kontrollerad, men abonnemangets pris-/volymtäckning,
livekvot och live-Supabase är inte verifierade. Tester använder simulerade svar.

Providerreferenser: [instrumentlistor](https://support.twelvedata.com/en/articles/5620513-how-to-find-all-available-symbols-at-twelve-data),
[batch och krediter](https://support.twelvedata.com/en/articles/5203360-batch-api-requests).

## Journal och Supabase

Varje analysförslag skickas till `/api/trades`. Sparstatus och fel visas.
Journalen hämtar senaste poster från samma endpoint. Ett förslag är inte en
genomförd trade och räknas inte som en vinst/förlust.

Befintligt databasformat behålls: analysförslag har `signal=NO_TRADE`,
`direction=NONE`, `trade_status=NO_TRADE`. Exakt UI-beslut (inklusive WAIT)
ligger i `signal_inputs.decision`. `confidence=0` är en kompatibilitetsmarkör,
inte en sannolikhet. Statistik måste skilja `record_type=ANALYSIS` från trades.

En användare kan manuellt registrera en redan tagen aktieaffär från en analys
med riktning, faktiskt ingångspris, antal, valfri stop/målnivå och ingångsavgift.
Öppna manuella affärer kan stängas i journalen med utgångspris, utgångsavgift
och avslutsorsak. Servern beräknar nettoresultat i procent och, om stop finns,
R-resultat. Posten märks `record_type=REAL_TRADE` och länkas till analysen.
Detta är journalföring av användarens affär; terminalens analys godkänner den inte.

**Utfall i hämtad journal** räknar bara giltiga avslutade REAL_TRADE, grupperade
per strategiversion och valuta. Priser, storlek, faktiska avgifter och sparat
netto kontrolleras mot varandra; felaktiga och dubbla poster utesluts med orsaker.
Medel-R använder bara trades med giltig ursprunglig stop och R. Om inga förluster
finns är profit factor inte beräknad. Underlaget är högst de 100 senast hämtade
posterna, inte hela livstidshistoriken. Netto / summerat ingångsvärde är inte
kontots avkastning, och vinstandelen är inte en prognos.

## Historiskt prisprov (experimentellt)

Swinganalysens **Se mer – historiskt prisprov** kör pullback eller breakout
lokalt på redan hämtade dagskurser. Ange fast antal aktier, avgift per order
och slippage uttryckligen. Provet gör inga API-anrop eller journalskrivningar.
Upp till 100 dagsljus, varav de första 60 används för indikatorer, är ett kort
urval och kan ge få eller inga simuleringar. Historiska nyheter och AI ingår inte.

`daily-replay-v0.1-experimental` fattar beslut med endast då tillgängliga
stängningsdata. Ingång sker tidigast vid nästa observerade öppning, försämrad
av slippage. Ursprunglig stop behålls; mål och R räknas om från simulerad ingång.
Öppning utanför signalens nivåer avvisas. Stop-gap fylls vid sämre öppningspris.
Om både stop och mål träffas samma dagsljus används stop först. Vid målgap
antas inget bättre pris än målet, och slippage dras även från målutgången.
Innehavstiden är 1–5 observerade dagsljus med en position åt gången. Båda
orderavgifterna dras. Öppna slutpositioner ingår inte i utfallsstatistiken.
Drawdown gäller realiserade resultat; inget kontokapital eller marknadsvärde
simuleras. Nästa öppning är en separat exekveringstid från beslutet vid
stängning, enligt den vanliga [barbaserade exekveringsmodellen](https://www.backtrader.com/docu/quickstart/quickstart/).

För större sparade underlag finns ett offline-CLI, högst 5 000 stängda dagsljus:

```sh
npm run backtest -- --input data.json --output rapport.json --market usa --setup BREAKOUT --holding 3 --quantity 2 --fee 1 --slippage-bps 10 --as-of 2026-09-28T22:00:00Z
```

Input har samma JSON-format som `/api/market-data`: ticker, currency, exchange,
timezone, interval `1day` och stigande unika bars med datum, OHLC och volume.
Använd en ny rapportfil; CLI skriver aldrig över en befintlig. `--help` beskriver
alla parametrar. Kostnaderna i exemplet är antaganden, inte en rekommendation.

Lägg till `--benchmark referens.json --benchmark-ticker SPY` bara när filen
faktiskt är dagsdata för det uttryckligen valda referensinstrumentet. Då krävs
`market-context-v0.1-experimental`: positiv benchmarktrend (pris över EMA20
över EMA50 och positivt femsessionsmomentum) samt aktiens högre prisavkastning
över samma 20 sessioner. Börs, valuta, tidszon och senaste 21 datum måste matcha.
Saknade data ger NOT_ASSESSED och negativa filter BLOCKED; bara CONFIRMED
släpper igenom signalen i detta prov. Ingen extra referensdata hämtas automatiskt.

Detta är ett prisexperiment för LONG-regler. Saknade sessioner, justering för
splittar/utdelningar, överlevnadsbias, spread, likviditet och verkliga fills
måste utredas i ett bredare prov. Backtestmotorn gör ingen sådan kontroll och
bekräftar inte en edge. Out-of-sample, paper trading och validerad Risk Engine
krävs fortfarande före TRADE.

**Inloggningen använder ett gemensamt lösenord; journalen är gemensam.**
Personlig historik kräver riktig användaridentitet, databasägarskap och
serverkontroller/RLS. Kodtester verifierar inte anslutningen till live-Supabase.
För en ny databas finns tabellformatet i [supabase/schema.sql](supabase/schema.sql).
Kör det i Supabase SQL Editor innan journal-API:t används. Om `trades` redan
finns ska dess kolumner jämföras med filen; `CREATE TABLE IF NOT EXISTS` ändrar
inte en befintlig tabell.

## Körning och deployment

Installera med npm install eller pnpm install. Kör npm test och npm run build.
Det valfria `tests/uiSmoke.cjs` kräver Playwright och ett körande produktions-
preview. Det använder endast simulerade API-svar, inte livekonton.
Manuella anslutningskontroller och lokal UI-verifiering sparas lokalt i
NIGHT_WORK_STATUS.md. Statusfilen och skärmbilder från kontrollerna ingår inte
i den publicerade koden.
npm run dev startar endast Vite; API kräver en serverlessmiljö, exempelvis
Vercel CLI eller Vercel deployment.

Använd Vercel för den funktionella appen. GitHub Pages-workflowen är endast
statisk förhandsvisning: Pages kör inte `/api/*.js`. Analys och journal kommer
inte fungera där; sidan visar fel i stället för falsk sparstatus.

Servermiljön behöver APP_LOGIN_PASSWORD, ANTHROPIC_API_KEY,
TWELVE_DATA_API_KEY, SUPABASE_URL och SUPABASE_SECRET_KEY. Lägg aldrig
hemligheter i frontend, VITE-variabler eller Git.

För lokal åtkomst finns [.env.example](.env.example). Kopiera till `.env.local`
och fyll i lokalt. Filen är Git-ignorerad och måste läsas av backend-/testprocessen;
den startar inga API-funktioner med bara Vite. Supabase stöder både ny servernyckel
(`sb_secret_...`, endast `apikey`-header) och äldre `service_role`-JWT.
Deployment kräver separat Vercel-projektåtkomst och tabelländringar separat
Supabase SQL-/administrationsåtkomst.

Vercel Preview blockerar skrivningar (POST/PATCH) till journalen som standard även om miljön
ärver produktionsnycklar. Sparfel visas då medvetet i appen. Aktivera
`PREVIEW_ALLOW_WRITES=true` endast efter att preview pekar på en separat
testdatabas. Läsning och analys är fortfarande tillåtna och externa analyser
förbrukar API-krediter; ingen livekörning ingår i de automatiska testerna.

## Nästa etapper

1. Användaridentitet och personlig journal.
2. Separat Risk Engine med konfigurerbara riskgränser.
3. Historiskt prov på kontrollerade marknadsdata, out-of-sample och paper trading före TRADE-aktivering.
4. Koppla och utvärdera referensfiltret i vanlig analys samt utökad screening och
   distribuerade kvotjobb. Derivat kräver separat produktspecifik data och
   riskanalys.
