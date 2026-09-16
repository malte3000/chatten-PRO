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

Nyhetsanalys körs även utanför öppettider. Ofullständiga (`pause_turn`,
`max_tokens`) och felaktigt formaterade svar nekas säkert. Strukturerad
provider-output och återupptagning av pausade sökningar är senare arbete.

## Marknadsskanner (experimentell första version)

Standardläget **Skanna marknaden** kräver inte en ticker. Välj USA/Sverige,
swing/daytrade och budget 20, 40 eller 100 aktier. Instrument hämtas automatiskt
från Twelve Datas `/stocks` (Common Stock, NASDAQ/NYSE eller OMX/XSTO).
Urvalet är deterministiskt för UTC-datum och varierar dagligen; det är INTE
hela börsen eller de bevisat bästa aktierna. Antal kontrollerade, lista och
bortgallringar visas. Av kräver att användaren väljer marknad för skanning.

Skannern hämtar 100 UTC-candles per aktie och kräver minst 60 giltiga candles,
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
Returnerad OHLCV sparas i rapportens data_snapshot tillsammans med UTC-tidszon,
intervall och hämttid för att testerna ska kunna reproduceras utan framtida data.
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

**Inloggningen använder ett gemensamt lösenord; journalen är gemensam.**
Personlig historik kräver riktig användaridentitet, databasägarskap och
serverkontroller/RLS. Öppna/stänga faktiska trades, avgifter och efteranalys
återstår. Kodtester verifierar inte anslutningen till live-Supabase.

## Körning och deployment

Installera med npm install eller pnpm install. Kör npm test och npm run build.
Det valfria `tests/uiSmoke.cjs` kräver Playwright och ett körande produktions-
preview. Det använder endast simulerade API-svar, inte livekonton.
npm run dev startar endast Vite; API kräver en serverlessmiljö, exempelvis
Vercel CLI eller Vercel deployment.

Använd Vercel för den funktionella appen. GitHub Pages-workflowen är endast
statisk förhandsvisning: Pages kör inte `/api/*.js`. Analys och journal kommer
inte fungera där; sidan visar fel i stället för falsk sparstatus.

Servermiljön behöver APP_LOGIN_PASSWORD, ANTHROPIC_API_KEY,
TWELVE_DATA_API_KEY, SUPABASE_URL och SUPABASE_SECRET_KEY. Lägg aldrig
hemligheter i frontend, VITE-variabler eller Git.

Vercel Preview blockerar POST till journalen som standard även om miljön
ärver produktionsnycklar. Sparfel visas då medvetet i appen. Aktivera
`PREVIEW_ALLOW_WRITES=true` endast efter att preview pekar på en separat
testdatabas. Läsning och analys är fortfarande tillåtna och externa analyser
förbrukar API-krediter; ingen livekörning ingår i de automatiska testerna.

## Nästa etapper

1. Användaridentitet och personlig journal med utfallsregistrering.
2. Reproducerbara quant-indikatorer och separat Risk Engine.
3. Backtest, out-of-sample och paper trading före TRADE-aktivering.
4. Utökad screening med bättre universumurval och distribuerade kvotjobb;
   derivat kräver separat produktspecifik data och riskanalys.
