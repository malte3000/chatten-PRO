# Sannolikhetsterminal

React/Vite. Swingtrading först, daytrading sekundärt. Ingen orderläggning.

## Första etappen: kompakt analys

Ange en ticker och välj horisont. **Starta analys** hämtar OHLCV och fattar det
tekniska beslutet utan nyheter. Därefter kan användaren separat hämta valfri
nyhetsbakgrund; den påverkar inte beslutet och sparas inte i journalposten.
En valfri graf kräver
explicit tickerbekräftelse. **Se mer** öppnar
hela analysoutputen och datasnapshoten. Byte av ticker, marknad eller horisont
ogiltigförklarar resultat och avbryter gamla förfrågningar.
Marknad kan väljas som USA, Sverige/Stockholm eller Av (endast analys).
Av kringgår inte kraven på verifierad börsklocka och kursdata.

Samlad swinganalys ger **TRADE · EXPERIMENTELL** när ett tekniskt upplägg och
grundkraven på data, omsättning, volatilitet och provisoriska risknivåer klaras.
Giltig data utan upplägg eller med för låg omsättning/olämplig volatilitet ger
NO TRADE. Saknad eller motsägelsefull data ger EJ BEDÖMT, inte en teknisk slutsats.
TRADE är en signal om ett möjligt framtida ingångsläge, aldrig en lagd order
eller en uppmätt vinstsannolikhet. Användaren avgör själv om någon affär görs.
AI-confidence används aldrig som uppgångssannolikhet. Ingen träffsäkerhet är
uppmätt eller utlovad. Den gamla simulatorn finns i `src/LegacySimulator.jsx`
som arkiverad kod och är inte monterad i appen.

I `readiness-v0.6` verifieras den aktuella strategisnapshoten mot färdigställda
dagskurser innan ett `WATCH`-upplägg kan bli TRADE. `NO_SETUP` ger NO TRADE;
fel i data, börsklocka eller strategisnapshot ger EJ BEDÖMT. Nyheter påverkar
inte beslutet. Daytradeläget saknar ännu en bedömd egen strategi och kan inte
ge TRADE.
Beslutets version och orsakskoder sparas i analyssnapshoten så att poster
från olika urvalsregler inte blandas.

`swing-v0.5-experimental` känner igen fyra separata uppgångsupplägg:
pullback mot EMA20, 20-dagarsutbrott med volym, utbrott ur en kort
konsolidering och återhämtning efter nedgång i en större stigande trend.
Ett upplägg räcker; de behöver inte inträffa samtidigt. Mönsterbedömningen
är `WATCH` eller `NO_SETUP` internt. Den samlade analysen kan ge TRADE först
efter sina ytterligare kontroller. Referensfiltret används ännu inte i vanlig
analys. Reglernas lönsamhet är inte validerad. En signal kan visa provisorisk
stop, 2R-målnivå och en kalkyl av högsta hela aktieantalet utifrån användarens
eget kapital och riskprocent. Kalkylen är inte en validerad Risk Engine och
stoppen skyddar inte mot gap eller slippage.

Swingbedömningen kontrollerar börsens tidszon och verkliga sessionsdatum.
Dagens ofärdiga dagsljus tas bort; gårdagens behålls även om börsen är öppen.
Alla använda dagsljus kräver positiv volym. Dagens ofärdiga ljus utesluts före
OHLC-/volymvalidering i både skanner och manuell analys. Live-swingbedömningen
kräver kursen från senast avslutade handelssession enligt börsklockan; annars
blir den ej bedömd. Det generella dagsdataurvalet har dessutom en gräns på fem
kalenderdagar, men verifierar inte alla saknade äldre sessioner.
Den manuella analysen visar leverantörens senaste kursdatum, börsklockans status
och hämtningstid även när upplägget blir EJ BEDÖMT. Ett datafel går därmed att
skilja från ett bedömt NO TRADE utan upplägg. Kursdata och börsklocka hämtas
utan cache eftersom dagens status kan ändras under testet.

Valfri nyhetsanalys kan köras även utanför öppettider, men den ingår inte i
beslutet och körs inte automatiskt av skannern. Ett nyhetsfel fördröjer inte
det tekniska beslutet. Ofullständiga (`pause_turn`,
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
från Twelve Datas `/stocks` (Common Stock, NASDAQ/NYSE eller OMX/XSTO) och
begränsas till USD för USA respektive SEK för Stockholm innan kursdata hämtas.
Urvalet är deterministiskt för UTC-datum och varierar dagligen; ett nytt klick
samma dag ger normalt samma första 20, och en större budget utökar urvalet.
Det är INTE hela börsen eller de bevisat bästa aktierna. Antal kontrollerade,
lista och bortgallringar visas. Av kräver att användaren väljer marknad för
skanning.

Skannern hämtar 100 candles per aktie och kräver minst 60 giltiga candles,
volymdata, rätt symbol/börs/valuta och tillräckligt färska tidsstämplar.
Gemensamma försöksgränser är ATR 0,2–8 procent och genomsnittlig omsättning
minst 1 M USD / 10 M SEK. Swing (`v0.7-experimental`) använder samma fyra
upplägg som manuell analys: pullback, 20-dagarsutbrott, kort
konsolideringsutbrott eller återhämtning i en större stigande trend. Varje
upplägg bedöms var för sig på färdigställda dagskurser. Daytradens tekniska
förfilter kräver fortfarande pris > EMA20 > EMA50, positivt fem-candle-momentum
och RVOL >= 1; omsättningen gäller per 15-minuterscandle. RVOL jämför senaste candle med
föregående 20 candles, inte samma klockslag andra dagar.
I daytradeläge kan senaste 15-minuterscandle vara ofullständig. Dessa
startregler är inte backtestade och kan missa bra lägen. Filterpoäng 0–4 är
aldrig vinstsannolikhet.

Skannern bedömer tekniska kandidater utan Anthropic-anrop. En swingträff är
en analyskandidat; när den öppnas i samlad analys kan den ge en experimentell
TRADE-signal efter samma verifiering som en manuellt angiven aktie. Skanningen
i sig är ingen order. Dayträffar är bara tekniska förfilterträffar och kan
inte ge TRADE innan en separat daytradestrategi finns. Saknad eller negativ
nyhetsanalys ändrar inte försöksutfallet. Nya skanningar märks med
`TECHNICAL_ONLY` och screen-version så att regelversioner hålls isär.
En positiv nyhetsriktning utan faktiskt sökresultat eller citat nedgraderas
till oklar. Visade sökkällor är länkar för kontroll, inte en verifiering av
publiceringsdatum eller påståendenas relevans för den valda horisonten.
Uppenbara hävstångsprodukter filtreras bort även när aktielistan felaktigt märker
dem som Common Stock. Produktklassningen är ännu inte fullständigt verifierad;
warranter/certifikat kräver separat produktdata och riskanalys.

Om datakällan inte ger verifierbar kursdata för en symbol får den EJ BEDÖMT,
inte NO TRADE. Om en hel Stockholmsbatch saknar verifierbar kursdata avbryts
skanningen utan tradebedömning, så den inte fortsätter dra API-krediter eller
visar ett falskt 20/20 NO TRADE-resultat.
EJ BEDÖMT gäller även när en prisserie inte går att bedöma på grund av för få
candles, ogiltig klocka, för gamla data eller
otillförlitlig volym. Giltiga data som inte klarar de tekniska försöksfiltren
ger fortfarande NO TRADE.

Serverendpoint `/api/scan` är autentiserad och väljer instrument på servern;
klienten skickar inte godtyckliga tickers. `SCAN_BATCH_SIZE` är 1–8, standard 4.
Varje symbol drar en API-kredit även i batch. Mellan batcher väntar klienten
61 sekunder. Aktielistan cachas i serverminnet i tre timmar. Kvotkontrollen i
serverminnet är best-effort per varm instans, inte en global begränsning mellan
Vercel-instanser eller andra API-anrop. Kör inte samtidiga skanningar innan en
distribuerad kvot/jobbtjänst finns. Start sker endast vid klick, ingen bakgrunds-
automation. Browser måste vara öppen; Stoppa bevarar en ofullständig rapport.
Den inloggningsskyddade knappen **Visa API-krediter** läser Twelve Datas
`/api_usage` vid klick och visar minutens användning samt dagskvoten när
leverantören skickar den. Varje sådan kontroll kostar själv en API-kredit.

En rapport sparas via befintlig `/api/trades` med `record_type=SCAN` i
`signal_inputs`, syntetisk ticker SCAN-USA/SCAN-SE och inga tradeutfall.
Journal/statistik måste skilja SCAN, ANALYSIS och faktiska trades.
Returnerad OHLCV sparas i rapportens data_snapshot tillsammans med tidszon,
intervall och hämttid för att testerna ska kunna reproduceras utan framtida data.
Dagskurser är börsens lokala sessionsdatum; intradagskurser begärs i UTC.
Detta följer [Twelve Datas tidszonsregler för time_series](https://twelvedata.com/docs).
Publik OMX/XSTO-listning ger inte prisdatatäckning. Twelve Datas
[EOD-guide](https://support.twelvedata.com/en/articles/12682324-end-of-day-eod-pricing-market-data)
listar XSTO bland börser som kräver separat licens eller saknar EOD-data, och
[XSTO-sidan](https://twelvedata.com/exchanges/xsto) visar referensdata men inga
Core price-endpoints. Därför kan Sverige inte användas för denna skanner utan
verifierat stöd för samma börs och intervall hos datakällan. Live-Supabase är
inte verifierad. Tester använder simulerade svar.

Providerreferenser: [instrumentlistor](https://support.twelvedata.com/en/articles/5620513-how-to-find-all-available-symbols-at-twelve-data),
[batch och krediter](https://support.twelvedata.com/en/articles/5203360-batch-api-requests).

## Journal och Supabase

Varje analysförslag skickas till `/api/trades`. Sparstatus och fel visas.
Journalen hämtar senaste poster från samma endpoint. Ett förslag är inte en
genomförd trade och räknas inte som en vinst/förlust.

Befintligt databasformat behålls: en experimentell TRADE-analys sparas som
`signal=BUY`, `direction=LONG`, `trade_status=SIGNAL_ONLY`, utan ingångspris
eller utfall. NO TRADE och EJ BEDÖMT sparas med `signal=NO_TRADE`,
`direction=NONE`, `trade_status=NO_TRADE`; exakt UI-beslut ligger i
`signal_inputs.decision`. `confidence=0` är en kompatibilitetsmarkör, inte
en sannolikhet. Statistik måste skilja `record_type=ANALYSIS` från trades.

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

## Pattern Discovery och sannolikhetsanalys (första version)

Swinganalysens detaljvy innehåller en lokal **Pattern Explorer** för redan
hämtade dagskurser. Den skiljer endagsfall från första passeringen av en
drawdowntröskel från högsta tidigare stängning under 30 eller 90 sessioner.
Tillgängliga trösklar är 1–30 procent samt 35, 40 och 50 procent. Utfall mäts
efter 1, 5, 10, 20 eller 60 observerade sessioner.

`pattern-discovery-v0.1` redovisar antal händelser, observationsperiod,
terminalavkastning, medel/median, maximal gynnsam och negativ rörelse, full
återhämtning samt Recovery och Continuation Probability. Binära frekvenser får
Wilson-intervall. Samma sammanhängande drawdown registreras inte på varje
efterföljande dag, och utfallsdata börjar först efter händelsens stängning.
Överlappande utfallsperioder redovisas uttryckligen som statistiskt beroende.
Gränssnittet döljer sannolikheten när färre än 20 jämförbara utfall finns.

Den inbyggda vyn analyserar bara den korta serie som den vanliga analysen redan
hämtat. Den är därför främst en transparent funktionskontroll och kommer ofta
att visa **otillräckligt underlag**. Den ändrar inte BUY/TRADE eller NO TRADE:
historiska frekvenser får inte bli ett signalfilter förrän en större,
point-in-time-korrekt datamängd har validerats oberoende.

För större sparade dataset finns ett reproducerbart offlineflöde:

```sh
pnpm run pattern-analysis -- --input datasets.json --output pattern-report.json --window 30 --threshold 10 --horizon 20 --recovery-target 5 --continuation-target 3 --quantity 1 --fee 1 --slippage-bps 10 --spread-bps 5
```

Input är en JSON-lista med dataserier, eller `{ "datasets": [...] }`. Varje
serie har `ticker` och stigande dagsbars med `datetime`, OHLC och valfri volym.
CLI:t kombinerar Pattern Discovery med `event-backtest-v0.1`: ingång vid nästa
öppning, mål/stop, tidsutgång, gap, spread, slippage och båda orderavgifterna.
Om mål och stop träffas i samma dagsljus blir utfallet `TIE` som standard; välj
`--ambiguous STOP_FIRST` för en uttryckligen konservativ regel. Rapportfilen får
inte finnas sedan tidigare och skrivs aldrig över.

Backtestet redovisar bland annat utfallsfrekvenser med Wilson-intervall,
genomsnittlig vinst/förlust, expectancy, profit factor, Sharpe/Sortino per
observation, realiserad drawdown, periodstabilitet och beroende mellan
överlappande händelser. Det är fortfarande deskriptiv forskning, inte bevisad
prediktiv förmåga. Leverantörens split-/utdelningsjustering, avnoterade bolag,
historiskt aktieuniversum och licensvillkor måste verifieras innan större
slutsatser dras.

Transparenta indikatorfunktioner för SMA, Wilder RSI, MACD, Wilder ATR och
realiserad volatilitet finns som grund för senare kombinationstester. De används
ännu inte för att höja signalens confidence.

`probability-calibration-v0.1` kan utvärdera redan avgjorda prognoser med Brier
score, log loss, expected calibration error och reliability-grupper med
Wilson-intervall. Den tränar eller befordrar aldrig en modell automatiskt och
kräver att anroparen väljer ett kronologiskt oberoende utvärderingsurval.

Den additiva Supabase-migrationen i `supabase/migrations` beskriver separat,
server-only lagring för dataset, dagsbars, forskningskörningar, händelser,
resultat, modellversioner och uppföljda prognoser. Den ändrar inte befintliga
journal- eller papertabeller, ger ingen browserroll åtkomst och är inte
automatiskt applicerad på någon live-databas.

## Historiskt prisprov (experimentellt)

Swinganalysens **Se mer – historiskt prisprov** kör ett av de fyra aktuella
swinguppläggen lokalt på redan hämtade dagskurser. Ange fast antal aktier, avgift per order
och slippage uttryckligen. Provet gör inga API-anrop eller journalskrivningar.
Upp till 100 dagsljus, varav de första 60 används för indikatorer, är ett kort
urval och kan ge få eller inga simuleringar. Historiska nyheter och AI ingår inte.

`daily-replay-v0.3-experimental` fattar beslut med endast då tillgängliga
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
bekräftar inte en edge. Kontrollerad out-of-sample-uppföljning, tillräckligt
många framtida utfall och riskarbete återstår innan någon slutsats om
lönsamhet eller användning med riktiga pengar kan dras.

## Automatisk lokal TRADE-signallogg

Varje verifierad experimentell TRADE-signal från en skanningsbatch eller en
enskild analys sparas automatiskt i webbläsarens separata signallogg. Den låser
marknad, ticker, börs, signaldatum, strategiversion, upptäckta upplägg och deras
referenspris, stopp och mål. Samma signal från både skanner och manuell analys
räknas en gång; motstridiga låsta nivåer skrivs inte över. Panelen kan exportera
alla poster som JSON. Om lokal lagring misslyckas visas ett fel medan signalen
fortfarande kan granskas på skärmen.

Signalloggen innehåller inga order och synkas inte mellan webbläsare eller
datorer. En avslutad paperobservation kan länkas till sin signal som ett
**simulerat** utfall. Övriga signaler har inget uppmätt utfall; antalet loggade
signaler eller enstaka simuleringar är inte en verifierad träffsäkerhet.

## Paperlogg för framtida utfall (experimentell)

För det första sammanhängande paperprovet används **USA + swing**. Kör en
skanning när den senaste stängda dagskursen har levererats och exportera hela
skanningsrapporten, även om allt blev NO TRADE eller EJ BEDÖMT. Öppna samlad
analys för varje teknisk kandidat som ska ingå i provet och spara en låst
paperobservation för varje TRADE-signal innan nästa handelssession öppnar. Använd samma
innehavstid, antal, avgift och slippage för varje nytt prov. När nästa
handelssession har stängt kan **Kontrollera öppna paperposter** hämta senare
kurser; exportera sedan paperloggen som JSON. En signal för samma aktie,
upplägg och signaldatum kan bara sparas en gång, även om analysen körs om.

USA:s avslutade dagskurs kan komma först en tid efter börsens stängning.
Twelve Data anger att historisk/EOD-data på Basic blir tillgänglig efter
midnatt i New York inför nästa handelsdag
([Twelve Data: US equities market data](https://support.twelvedata.com/en/articles/9935903-us-equities-market-data)).
Om terminalen visar **EJ BEDÖMT · KURSDATA EJ VERIFIERAD** därför att senaste
stängda sessionen saknas, vänta tills rätt dagsdatum finns i datakontrollen
och analysera igen före nästa öppning. Ett nytt försök kan förbruka API-krediter.

Terminalen simulerar ett köp vid nästa öppning från dagskurser och låsta
antaganden. **TradingView · manuella paperköp** är en separat lokal journal för
de order som faktiskt fylls i TradingViews paperkonto. För varje låst signal
kan användaren ange köptid, fyllt köppris, antal och avgift under nästa
ordinarie handelssession, och senare säljtid, fyllt säljpris, sålt antal och avgift.
Journalen avslutar bara hela positioner; delvisa försäljningar stöds ännu inte.
Nettoresultat och R räknas från de manuellt angivna fyllnaderna och blandas
inte med terminalens teoretiska simulering. Uppgifterna är inte verifierade
mot TradingView. Exportera därför både paperobservationer och TradingView-order
som varsin JSON-kopia; båda kan importeras igen utan att redan låsta utfall skrivs över. Ändra inte försöksreglerna utifrån några få tidiga
utfall; då blir resultatet svårt att tolka.

En experimentell teknisk TRADE-signal kan sparas som en lokal paperobservation.
Nyheter är valfri bakgrund och påverkar inte beslutet. Nya poster använder
`paper-forward-v0.4` och hålls åtskilda från äldre v0.1–v0.3-poster, som
fortfarande kan läsas och följas upp. Redan sparade v0.4-observationer från
`swing-v0.4-experimental` fortsätter också att vara läsbara och möjliga att
följa upp efter övergången till `swing-v0.5-experimental`. En paperobservation
är ett mätresultat, inte en genomförd affär. Äldre manuella paperorder kopplade till v0.3-poster
kan fortfarande läsas och avslutas.
Signalens datum, strategi, prisnivåer och uttryckliga antaganden om antal,
avgifter, slippage och max innehavstid låses innan senare dagskurser finns.
Nya färdigställda dagskurser kontrolleras med knappen **Kontrollera öppna paperposter**. Knappen visar hur många
instrument som kan kontrolleras innan användaren startar den. Ett klick hämtar
högst fem instrument sekventiellt via marknadsdata-API:t och kan förbruka
API-kvot. Ett nät- eller kvotfel stoppar fortsättningen; redan sparade lokala
uppdateringar finns kvar. Ingen bakgrundskörning eller order startas. Utfallet
kan vara väntande, simulerat avslutat, avvisad ingång eller ej bedömbart.
Vinst/förlust och netto räknas bara för avslutade simuleringar. NO TRADE är ett
avstående och räknas aldrig som en lyckad trade.

Paperloggen lagras först i den aktuella webbläsaren på **previewns branch-adress**.
I den aktiverade previewn kan användaren logga in i ett personligt paperkonto och
trycka **Synka paperloggen nu** för att föra över poster till det separata
Supabase-testprojektet och hämta dem på en annan dator. Synken sker inte
automatiskt. Olika previewdomäner har varsin lokal lagring; JSON-export ger en
extra kopia som kan importeras manuellt. Olika poster med samma ID skrivs inte
över vid import. Lokala och importerade observationer samt deras simulerade
utfall är inte oberoende verifierade och kan inte ensamma fastställa
strategins lönsamhet.

En personlig molnsynk finns i koden och är **avstängd som standard** i nya
miljöer. Ett separat Supabase Free-testprojekt, `chatten-pro-paper-sync-test`
(`bcvcwrtfxlwqbntnibtk`), har fått tabellen i
[`supabase/paper_sync_schema.sql`](supabase/paper_sync_schema.sql). Ett
transaktionsbaserat prov i
[`supabase/paper_sync_rls_check.sql`](supabase/paper_sync_rls_check.sql)
bekräftade att två användare bara ser och ändrar sina egna poster, att
anonym Auth nekas och att testdata rullas tillbaka. Supabases säkerhetsrådgivare
visade inga kvarvarande varningar efter att direkt anrop till triggerfunktioner
spärrades. Befintliga `trades` och lokala paperfiler påverkas inte.
Terminalens serverjournal använder fortfarande sin tidigare Supabase-konfiguration;
paperloggens webbläsarklient använder enbart det nya testprojektet.

Testprojektets Auth Site URL och enda redirect-URL är previewgrenens fasta
adress. E-postinloggning och bekräftelse är aktiva; anonym inloggning är av.
På Vercel är `VITE_PAPER_CLOUD_ENABLED=true`, `VITE_PAPER_SUPABASE_URL` och
`VITE_PAPER_SUPABASE_PUBLISHABLE_KEY` begränsade till
`codex/market-scanner-preview`. De används först av ett **nytt preview-bygge**.
Ingen serverhemlighet får användas i `VITE_`-variabler. För ett end-to-end-prov
behöver en teamadress skapa och bekräfta ett personligt Auth-konto i previewn,
sedan synka en paperobservation och kontrollera den från en andra webbläsare.
Det SQL-baserade RLS-provet ersätter inte det webbläsarprovet.
Standardutskicket för Auth kan kräva egen SMTP för e-postadresser utanför
projektets team ([Supabase Auth SMTP](https://supabase.com/docs/guides/auth/auth-smtp)).

Synk görs manuellt efter personlig inloggning. Lokal logg och molnlogg
jämförs före skrivning; motstridiga låsta signaler eller slututfall stoppar
synken utan att skriva över dem. Äldre lokala observationer märks som
`local_import`. Import av ett redan avslutat utfall sker i två steg och kan
behöva upprepas om nätet bryts mellan stegen. Även nya webbläsarobservationer
är klientdata, inte serververifierade handelsutfall. Ingen synkad post får
användas som verifierad träffsäkerhet eller bevis för användning med riktiga pengar.
Paperstatistiken håller olika antaganden om max innehavstid, aktieantal,
avgift och slippage åtskilda. Håll antagandena fasta under ett paperprov och
exportera en JSON-kopia efter varje ny observation och uppföljning.

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
ärver produktionsnycklar. Skanning och analys visas ändå, med tydlig status att
deras rapporter inte har journalförts. Aktivera
`PREVIEW_ALLOW_WRITES=true` endast efter att preview pekar på en separat
testdatabas. Läsning och analys är fortfarande tillåtna och externa analyser
förbrukar API-krediter; ingen livekörning ingår i de automatiska testerna.

## Nästa etapper

1. Användaridentitet och personlig journal.
2. Separat Risk Engine med konfigurerbara riskgränser.
3. Historiskt prov på kontrollerade marknadsdata och framåtriktad uppföljning av experimentella TRADE-signaler före påståenden om träffsäkerhet.
4. Koppla och utvärdera referensfiltret i vanlig analys samt utökad screening och
   distribuerade kvotjobb. Derivat kräver separat produktspecifik data och
   riskanalys.
