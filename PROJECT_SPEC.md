# PROJECT_SPEC.md

## Projekt: Sannolikhetsterminal / Signal Bot

### Version
0.1 – Grundspecifikation

---

# 1. Syfte

Projektets mål är att bygga en seriös signal-bot för aktier som analyserar marknadsdata och endast ger en trade-signal när tillräckligt många faktorer talar för samma riktning.

Boten ska prioritera:

1. Positiv förväntad avkastning över många trades.
2. Kapitalbevarande och kontrollerad risk.
3. Färre men bättre signaler framför många mediokra signaler.
4. Mätbara och reproducerbara beslut.
5. Kontinuerlig utvärdering av vilka delar av strategin som faktiskt fungerar.

Ett långsiktigt och ambitiöst mål är cirka 70–80 % vinnande trades för de signaler som boten faktiskt väljer att handla.

Detta är dock INTE viktigare än positiv expectancy.

En strategi med lägre win rate men bättre total lönsamhet är bättre än en strategi med hög win rate men negativt väntevärde.

---

# 2. Grundprincip

AI ska INTE vara hela tradingstrategin.

AI ska främst automatisera sådant en mänsklig trader annars hade behövt göra manuellt, exempelvis:

- läsa nyheter
- läsa rapporter
- identifiera katalysatorer
- analysera grafbilder
- klassificera marknadsläge
- sammanfatta information
- göra post-trade-analyser
- hitta möjliga återkommande fel

Så mycket som möjligt av själva tradinglogiken ska baseras på:

- marknadsdata
- matematiska indikatorer
- tydliga regler
- statistiskt verifierade samband

---

# 3. Tillåtna slutresultat

Signal Engine ska kunna returnera:

- BUY
- SELL
- NO TRADE

NO TRADE är ett viktigt och normalt resultat.

Boten ska aldrig känna sig tvingad att skapa en signal.

Om informationen är svag, motsägelsefull eller risk/reward är dålig ska resultatet vara NO TRADE.

---

# 4. Systemets huvudmoduler

Systemet ska byggas modulärt.

## 4.1 Market Data Module

Ansvar:

- prisdata
- Open
- High
- Low
- Close
- Volume
- intraday candles
- historiska candles
- pre-market
- after-hours om datakällan stödjer detta
- timestamps

Datan ska komma från en riktig marknadsdata-API.

---

## 4.2 Data Validation Module

Kontrollerar bland annat:

- saknade candles
- dubbla datapunkter
- felaktiga priser
- felaktiga tidsstämplar
- tidszon
- orimliga prisförändringar
- splits
- eventuella dataproblem

Ingen signal ska skapas från data som inte klarar valideringen.

---

## 4.3 Technical Analysis Module

Ska huvudsakligen vara regel- och matematikbaserad.

Möjliga faktorer:

- trend
- momentum
- RSI
- SMA
- EMA
- VWAP
- ATR
- support
- resistance
- breakout
- breakdown
- trend strength
- pris relativt VWAP
- pris relativt moving averages

Alla beräkningar ska vara reproducerbara.

Samma input ska ge samma output.

---

## 4.4 Volume Analysis Module

Analyserar bland annat:

- nuvarande volym
- genomsnittlig volym
- Relative Volume / RVOL
- volume spikes
- volym vid breakout
- förändring i volym
- eventuell köp-/säljobalans om datan stödjer detta

---

## 4.5 Volatility Module

Analyserar:

- ATR
- intraday range
- historisk volatilitet
- onormala rörelser
- gap
- eventuell event-risk

Extrem volatilitet ska kunna:

- sänka confidence
- minska position size
- blockera en trade helt

---

## 4.6 Chart / Pattern Analysis Module

Den befintliga AI-bildanalysen kan användas och utvecklas.

Den ska kunna identifiera exempelvis:

- candlestick-pattern
- breakoutområde
- konsolidering
- trendkanal
- support/resistance
- tekniska formationsområden
- eventuella AMD-liknande strukturer

När ett mönster hittas ska det om möjligt returneras som strukturerad data.

Exempel:

{
  "pattern": "bull_flag",
  "confidence": 74,
  "coordinates": {
    "x1": 0.42,
    "y1": 0.28,
    "x2": 0.71,
    "y2": 0.63
  }
}

Koordinater ska valideras innan frontend använder dem.

AI får aldrig låtsas att den ser ett mönster om bilden är för otydlig.

---

# 5. News Analysis Module

AI används för att automatisera nyhetsanalysen.

Den ska prioritera bolagsspecifika nyheter.

Exempel:

- kvartalsrapporter
- guidance
- kontrakt
- regulatoriska beslut
- analytikerändringar
- produktnyheter
- rättsprocesser
- förvärv
- insiderinformation som är offentligt publicerad
- andra konkreta bolagshändelser

Marknads-, sektor- och råvarunyheter får användas som sekundär information.

AI ska skilja mellan:

- specifikt bolag
- sektor
- råvara
- generell marknad

Exempeloutput:

{
  "direction": "bullish",
  "confidence": 78,
  "catalyst_strength": 8,
  "subject_type": "company",
  "resolved_ticker": "NVDA"
}

AI ska vara konservativ.

Om nyhetsläget är svagt eller oklart ska confidence vara låg.

---

# 6. Earnings / Event Module

Ska hålla reda på händelser som kan påverka risken.

Exempel:

- earnings
- guidance
- Fed
- CPI
- jobbrapporter
- FDA-beslut
- stora produktlanseringar
- regulatoriska beslut

Boten ska kunna neka en trade om en stor binär händelse ligger för nära.

---

# 7. Market Regime Module

Analyserar marknaden runt den enskilda aktien.

Exempel:

- risk-on
- risk-off
- bullish
- bearish
- neutral
- hög volatilitet
- låg volatilitet

Möjliga inputs:

- S&P 500
- Nasdaq
- relevant sektor
- VIX
- räntor
- breadth
- index momentum

En stark individuell aktiesignal ska kunna få lägre confidence om marknaden går kraftigt åt motsatt håll.

---

# 8. Signal Engine

Signal Engine väger ihop systemets olika analyser.

Exempel:

Technical Score: 81
Momentum Score: 78
Volume Score: 84
News Score: 73
Market Regime Score: 67
Volatility Score: 71

Resultat:

BUY / SELL / NO TRADE

Vikterna ska INTE antas vara optimala från början.

De ska senare justeras utifrån backtesting och verkliga resultat.

Signal Engine ska vara reproducerbar.

AI ska inte ensam få bestämma BUY eller SELL.

---

# 9. Confidence Engine

Confidence ska INTE bara vara AI:s magkänsla.

Confidence ska med tiden kalibreras mot faktiska resultat.

Exempel:

90–100 confidence
→ ska statistiskt prestera bättre än 70–79.

Om detta inte stämmer måste confidence-modellen justeras.

Målet är att ett confidence-värde ska ha verklig statistisk betydelse.

---

# 10. Risk Management Module

Riskhanteringen är en separat del från Signal Engine.

En BUY-signal betyder inte automatiskt att en trade får genomföras.

Risk Engine ska bland annat kunna beräkna:

- entry
- stop loss
- target
- risk/reward
- position size
- risk i procent av totalt kapital
- maximal dagsrisk
- maximal veckorisk
- maximal total exponering
- antal samtidiga trades

Exakta riskgränser ska kunna konfigureras senare.

Risk Engine ska kunna returnera:

APPROVED

eller

REJECTED

Exempel:

REJECTED
Reason: Risk/reward too low

---

# 11. Trade Setup Module

För varje godkänd signal ska boten kunna skapa en strukturerad trade-plan.

Exempel:

Ticker: NVDA

Direction: LONG

Entry:
184.20

Stop:
181.80

Target:
189.00

Risk:
2.40 USD/share

Potential reward:
4.80 USD/share

Risk/Reward:
2.0

Confidence:
81

---

# 12. Trade Schema

Alla signaler ska sparas i ett standardiserat format.

Varje trade ska minst kunna innehålla:

- trade_id
- strategy_version
- ticker
- company_name
- timestamp
- direction
- signal
- confidence

Pris:

- entry_price
- stop_loss
- target
- exit_price

Risk:

- risk_reward
- position_size
- risk_percent
- risk_amount

Teknisk analys:

- technical_score
- momentum_score
- volume_score
- volatility_score
- trend
- support
- resistance
- rvol
- atr

AI:

- news_score
- news_confidence
- catalyst_strength
- chart_pattern
- chart_confidence

Marknad:

- market_regime
- sector_direction
- index_direction

Resultat:

- trade_status
- result_percent
- result_R
- winner
- exit_reason

Efteranalys:

- post_trade_analysis
- detected_errors
- learning_tags

All information ska sparas som den såg ut VID SIGNALTILLFÄLLET.

Ingen framtida information får läcka in.

---

# 13. Trade Logger

Trade Logger ska byggas tidigt.

Den ska automatiskt spara:

- alla signaler
- alla inputs
- confidence
- strategi-version
- entry
- stop
- target
- senare trade-resultat

Data ska gå att använda för:

- statistik
- backtesting
- learning engine
- debugging
- jämförelse mellan strategiversioner

---

# 14. Backtesting Engine

Backtesting ska simulera hur strategin hade fungerat historiskt.

Den ska bland annat mäta:

- antal trades
- vinnande trades
- förlorande trades
- win rate
- average winner
- average loser
- expectancy
- profit factor
- max drawdown
- total return
- resultat i R

Backtesting ska inkludera realistiska kostnader:

- spread
- courtage
- slippage

Strategin får aldrig använda information som ännu inte var känd vid tidpunkten för traden.

Look-ahead bias måste undvikas.

---

# 15. Viktiga performance metrics

Win rate är viktigt men är INTE det enda måttet.

Prioriterade metrics:

## Expectancy

Förväntat resultat per trade.

Exempel:

+0.21R expectancy

är positivt även om inte alla trades vinner.

## Profit Factor

Gross profits / Gross losses.

Över 1.0 innebär positiv historisk lönsamhet.

Målet bör vara tydligt över 1.0 efter kostnader.

## Maximum Drawdown

Hur stor nedgång strategin haft från topp till botten.

## Win Rate

Andel vinnande trades.

Ambitiöst långsiktigt mål:

cirka 70–80 %

men endast om detta kan uppnås utan att försämra strategins totala expectancy.

---

# 16. Out-of-Sample Testing

Strategin får inte bedömas enbart på data den utvecklats på.

Exempel:

2022–2024:
utveckling

2025:
out-of-sample test

Strategin får inte optimeras på testdatan i efterhand och sedan låtsas som att resultatet fortfarande är out-of-sample.

---

# 17. Walk-Forward Testing

Strategin ska senare kunna testas med rullande perioder.

Exempel:

Train:
2022–2023

Test:
2024

Sedan:

Train:
2023–2024

Test:
2025

Detta hjälper till att se om strategin fungerar i olika marknadsmiljöer.

---

# 18. Paper Trading

Innan riktiga pengar används ska boten kunna köras live med simulerade trades.

Paper trading ska använda verklig live-data.

Boten ska skapa signalen innan resultatet är känt.

Vi ska sedan jämföra:

- live win rate
- backtest win rate
- expectancy
- slippage
- signal quality
- drawdown

---

# 19. Post-Trade Analysis

Varje avslutad trade ska automatiskt analyseras.

Systemet ska fråga:

- Vad gick rätt?
- Vad gick fel?
- Vilka signaler var starka?
- Vilka signaler var missvisande?
- Fanns det en riskfaktor som boten missade?
- Fanns samma problem i tidigare trades?
- Hur presterar liknande setups historiskt?

Exempel:

Trade:
LOSS -1R

Possible issue:
Breakout occurred with low relative volume.

Historical similar setups:
67

Win rate:
41 %

---

# 20. Learning Engine

Learning Engine ska analysera stora grupper av trades.

Den ska leta efter återkommande samband.

Exempel:

Breakout + RVOL < 1.2

Trades:
87

Win rate:
39 %

Breakout + RVOL > 1.5

Trades:
112

Win rate:
71 %

Learning Engine kan då föreslå:

Require RVOL > 1.3 for breakout trades.

---

# 21. Learning Engine får INTE ändra strategin direkt

Detta är en mycket viktig säkerhetsregel.

Systemet får aldrig göra:

LOSS
→ ändra strategi

Istället:

Nya trades
↓
Upptäck möjligt mönster
↓
Skapa hypotes
↓
Backtest
↓
Out-of-sample test
↓
Walk-forward
↓
Paper trading
↓
Godkänn eller neka ändringen

Endast verifierade förbättringar får införas.

---

# 22. Undvik overfitting

Systemet ska försöka undvika att skapa regler som bara passar historiska data.

Nya regler ska helst:

- fungera på många trades
- fungera på flera aktier
- fungera under flera tidsperioder
- fungera i olika marknadsregimer
- fungera på out-of-sample-data

En regel baserad på exempelvis 7 trades ska inte automatiskt anses vara en edge.

---

# 23. Strategy Versioning

Varje större förändring av strategin ska versionshanteras.

Exempel:

v1.0
v1.1
v1.2
v2.0

För varje version ska resultaten kunna jämföras.

Exempel:

v1.0

Trades:
850

Win rate:
63 %

Expectancy:
+0.17R

Profit factor:
1.36

v1.1

Trades:
840

Win rate:
67 %

Expectancy:
+0.25R

Profit factor:
1.61

På så sätt kan vi se om en förändring faktiskt förbättrade strategin.

---

# 24. Dashboard

Frontend ska på sikt kunna innehålla sektioner för:

- LIVE SIGNALS
- STOCK ANALYSIS
- AI ANALYSIS
- NEWS
- TRADE SETUPS
- TRADE HISTORY
- PERFORMANCE
- BACKTESTING
- PAPER TRADING
- LEARNING ENGINE
- STRATEGY VERSION
- SYSTEM STATUS

Dashboarden ska prioritera tydlighet framför onödigt mycket information.

---

# 25. Säkerhet

API-nycklar får ALDRIG ligga i frontend.

Hemligheter ska endast finnas som server-side environment variables.

Exempel:

ANTHROPIC_API_KEY

Frontend ska anropa backend.

Backend kommunicerar sedan med externa API:er.

Ingen API-nyckel ska committas till GitHub.

---

# 26. AI-regler

AI ska:

- vara konservativ
- skilja fakta från antaganden
- returnera strukturerad data
- kunna säga "unclear"
- kunna säga att information saknas
- inte hitta på prisinformation
- inte hitta på nyheter
- inte ge hög confidence utan tillräckliga bevis

AI:s outputs ska loggas så att deras historiska kvalitet kan mätas.

---

# 27. Kodprinciper

Projektet ska:

- byggas modulärt
- undvika enorma funktioner
- ha tydliga namn
- ha gemensamma schemas
- separera frontend från backend-logik
- undvika duplicerad kod
- validera externa API-svar
- hantera API-fel
- inte krascha om ett API är tillfälligt nere

Alla större ändringar ska testas med:

npm run build

innan de mergas.

---

# 28. Prioriterad byggordning

Systemet ska i första hand byggas i följande ordning:

1. PROJECT_SPEC
2. Trade Schema
3. Trade Logger / Database
4. Market Data
5. Data Validation
6. Technical Analysis
7. Volume Analysis
8. Volatility Analysis
9. Signal Engine v1
10. Risk Engine
11. Trade Setup
12. Backtesting
13. Out-of-Sample
14. Walk-Forward
15. News / AI improvements
16. Market Regime
17. Confidence Calibration
18. Paper Trading
19. Post-Trade Analysis
20. Learning Engine
21. Strategy Versioning
22. Dashboard improvements
23. Eventuell broker-integration

---

# 29. Riktiga pengar

Automatisk handel med riktiga pengar är INTE en tidig funktion.

Systemet ska först visa fungerande resultat genom:

Backtesting
↓
Out-of-sample
↓
Walk-forward
↓
Paper trading

för ett tillräckligt stort antal trades.

Broker-integration ska byggas separat och får inte kringgå Risk Engine.

---

# 30. Huvudmål för projektet

Boten ska inte försöka förutsäga varje rörelse på marknaden.

Målet är istället:

Hitta situationer där sannolikheten och risk/reward ser tillräckligt bra ut för att en trade ska vara motiverad.

Boten ska bli bättre genom:

- bättre data
- bättre statistik
- fler observationer
- systematisk testning
- kontrollerad feedback

inte genom att bara bli mer självsäker.

Det viktigaste måttet är om systemet skapar en robust positiv edge över ett stort antal trades.
