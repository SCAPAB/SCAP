# Förbättring 2026-11-15, steg 1: placerarens rapport

**Skriven av:** agenten placerare
**Fokus:** inget särskilt fokus, hela systemet
**Testinstans:** egen server på port 3105 med tillfällig databas (`INNEHAV_DB` i en temporär katalog). `data/innehav.db` har inte rörts. Servern är stoppad och de temporära filerna är borttagna.
**Version:** `main` vid commit `ed98651`
**Datum i kontrollerna:** `asOf = 2026-09-30` om inget annat anges. All data är testdata med fiktiva namn.

---

## 1. Vad jag gjorde

Jag byggde upp en portfölj för en stiftelse från noll, i huvudsak via gränssnittet (Playwright). API:et använde jag för större datamängder och för kontrollerna. Inkorgen kördes utan AI-nyckel, så alla poster där registrerades manuellt.

### 1.1 Grunddata
| Vad | Hur | Värde |
|---|---|---|
| Juridisk enhet | Gränssnittet: Administration → Organisation | Stiftelsen Testkapitalet (testdata), 802000-0001 |
| Policyportfölj | Gränssnittet: Allokering → Ändra policyportfölj (min / mål / max) | Noterade aktier 35/45/55, Räntebärande 15/20/25, Private equity 10/15/20, Reala tillgångar 5/10/15, Absolute return 5/10/15 |
| Valutakurser | Gränssnittet: Import → Valutakurser (19 rader) | USD: 2025-10-01 9,50 · 2026-01-02 10,00 · 01-20 10,10 · 03-31 10,50 · 06-10 10,30 · 06-30 10,20 · 08-14 10,00 · 08-31 9,90 · 09-01 9,90 · 09-30 9,80. EUR: 2025-10-01 11,00 · 11-14 11,05 · 12-31 11,10 · 2026-01-02 11,00 · 03-31 11,20 · 04-10 11,25 · 06-30 11,40 · 08-20 11,00 · 09-30 11,10 |
| Användare | Gränssnittet: Administration → Användare | Kontrollant (redigerare) för fyra ögon och en läsare |
| Fyra ögon | Gränssnittet: Administration → Kontroller | Påslagen mitt i testet |

### 1.2 Liggare (inmatning och förväntat utfall per 2026-09-30)
| # | Instrument (tillgångsslag) | Händelse | Väg | Förväntat |
|---|---|---|---|---|
| A | Nordbolaget AB (aktie, SEK, Noterade aktier) | Köp 1 000 à 200 + courtage 100 (2026-01-15), köp 500 à 230 + 50 (02-15), utdelning 7 500 (04-20), sälj 600 à 250 − 75 (05-15), kurs 240 (09-30) | Instrument och första köpet via gränssnittet, resten via API | Antal 900, GAV 210,10, anskaffning 189 090, realiserat 149 925 − 126 060 = 23 865, MV 216 000, orealiserat 26 910 |
| B | Transatlantic Tech Inc (aktie, USD) | Köp 200 à 150 + 10 (01-20, kurs 10,10), köp 100 à 180 + 10 (06-10, 10,30), utdelning 300 − källskatt 45 (08-15, kursen tas från 08-14 = 10,00), sälj 100 à 200 − 10 (09-01, 9,90), kurs 190 | API, valutakurs hämtad från registret | Anskaffning SEK 303 101 + 185 503 = 488 604, avgående 162 868, realiserat 197 901 − 162 868 = 35 033, kvar 325 736 (lokalt 32 013,33), MV 200 × 190 × 9,8 = 372 400, orealiserat 46 664, valutaeffekt 32 013,33 × 9,8 − 325 736 = −12 005,33, utdelning netto 2 550 |
| C | Europa Aktiefond A (fond, EUR, Noterade aktier) | Köp 500 à 100 (01-02, 11,00), kurs 108 | API | Anskaffning 550 000, MV 599 400, orealiserat 49 400, valutaeffekt 5 000 |
| D | Svensk Räntefond (fond, SEK, Räntebärande) | Köp 4 000 à 100 (01-02), köp 1 000 à 101 (06-30), kurser 100 / 101 / 102 | API och import av kurser | Anskaffning 501 000, MV 510 000, TWR sedan start 102/100 − 1 = 2,0 % |
| E | Global Multi-Strategy Hedge (fond, USD, Absolute return) | Köp 30 à 1 000 (01-02, 10,00), månads-NAV 1 050 per 08-31 | API | MV 30 × 1 050 × 9,8 = 308 700, valutaeffekt −6 000, TWR 2,9 %, ska flaggas som inaktuell (kurs 08-31) |
| F | Nordic Buyout Fund IV (sluten fond, SEK, Private equity) | Åtagande 2 000 000 (2025-06-01), anrop 380 000 + avgift 20 000 (2025-09-01), anrop 300 000 + 20 000 (2026-02-15), NAV 390 000 (2025-12-31) och 720 000 (2026-03-31) via import, utdelning 150 000 varav **100 000 återinkallningsbart** (05-20) via Inkorgen, aviserat anrop 3: 250 000 + 20 000 (2026-10-15) via Inkorgen. Q2-rapporten saknas | API, import och Inkorgen | Inbetalt 720 000, outnyttjat 2 000 000 − 720 000 + 100 000 = 1 380 000, utdelat 150 000, NAV 720 000 − 150 000 = 570 000 (framräknat), DPI 0,2083, TVPI 1,000, IRR 0 % (summan av flödena är 0). Rapporten för Q2 är försenad (förfallodag 2026-09-28). |
| G | Euro Infrastructure Partners II (sluten fond, EUR, Reala tillgångar) | Åtagande 300 000 (2025-10-01), anrop 1 (2025-11-15) via Inkorgen: investering 45 000 + förvaltningsavgift 3 000 + utjämningsränta 1 000 utanför åtagandet, NAV 44 000 (2025-12-31) via import, anrop 2: 30 000 + 2 000 (2026-04-10), **ersatt av en reviderad avi**: 28 000 + 2 000, NAV 80 000 (2026-06-30) via Inkorgen med kapitalkontoutdrag, utdelning 6 000 (08-20) | Inkorgen, import och API | Inbetalt 49 000 + 30 000 = 79 000, outnyttjat 300 000 − 48 000 − 30 000 = 222 000, utdelat 6 000, NAV 80 000 − 6 000 = 74 000, NAV SEK 821 400, outnyttjat SEK 2 464 200, inbetalt SEK 541 450 + 337 500 = 878 950, DPI 0,0759, TVPI 1,0127, IRR SEK 1,35 % (XIRR i Python) |

Underlag i Inkorgen (fiktiva PDF:er): avi för G-anrop 1, F-utdelning 1, samma F-utdelning omskickad som ny fil, kapitalkontoutdrag för G per Q2, reviderad avi för G-anrop 2 och avi för F-anrop 3.

**Portföljen per 2026-09-30:** marknadsvärde 216 000 + 372 400 + 599 400 + 510 000 + 308 700 + 570 000 + 821 400 = **3 397 900 kr**. Outnyttjade åtaganden 1 380 000 + 2 464 200 = **3 844 200 kr**.

---

## 2. Kontrollresultat

Toleransen är 0,01 för belopp och 0,0001 för nyckeltal.

| Kontroll | Förväntat | Programmet visar | OK/FEL |
|---|---|---|---|
| A antal / GAV / anskaffning | 900 / 210,10 / 189 090 | 900 / 210,10 / 189 090 | OK |
| A realiserat / orealiserat / MV | 23 865 / 26 910 / 216 000 | 23 865 / 26 910 / 216 000 | OK |
| B anskaffning SEK / realiserat | 325 736 / 35 033 | 325 736 / 35 033 | OK |
| B MV / orealiserat / valutaeffekt | 372 400 / 46 664 / −12 005,33 | 372 400 / 46 664 / −12 005,33 | OK |
| B utdelning (valutakurs från 08-14) | 2 550 | 2 550 | OK |
| C MV / valutaeffekt | 599 400 / 5 000 | 599 400 / 5 000 | OK |
| D MV / GAV | 510 000 / 100,20 | 510 000 / 100,20 | OK |
| E MV / valutaeffekt / inaktuell kurs flaggas | 308 700 / −6 000 / ja | 308 700 / −6 000 / ja | OK |
| F inbetalt / outnyttjat (med återinkallningsbart) | 720 000 / 1 380 000 | 720 000 / 1 380 000 | OK |
| F NAV / DPI / TVPI / IRR | 570 000* / 0,2083 / 1,000 / 0 % | 570 000* / 0,2083 / 1,000 / 0 % | OK |
| F avgifter utanför NAV (instrumentvyn) | 40 000 | 0 | **FEL** (fel 9) |
| G inbetalt / outnyttjat (utjämningsränta utanför åtagandet) | 79 000 / 222 000 | 79 000 / 222 000 | OK |
| G NAV lokalt / SEK / outnyttjat SEK | 74 000 / 821 400 / 2 464 200 | 74 000 / 821 400 / 2 464 200 | OK |
| G DPI / TVPI / IRR SEK | 0,0759 / 1,0127 / 1,35 % | 0,0759 / 1,0127 / 1,35 % | OK |
| G per 2026-06-29 (före Q2-rapporten): NAV / NAV SEK | 44 000 + 30 000 = 74 000 / 832 500 | 74 000 / 832 500 | OK |
| F och G per 2025-12-30 (ingen rapport): NAV = investeringsdelen | 380 000 / 45 000 | 380 000 / 45 000 | OK (README säger "inbetalt minus utdelat", se fel 14) |
| NAV-rapport och flöden samma dag: flödet ingår i rapporten | 500 000 | 500 000 | OK |
| Avgift utanför åtagandet (PE-typen Avgift, 500 EUR) | inbetalt +500, outnyttjat oförändrat | så | OK |
| Översikt: marknadsvärde / antal innehav | 3 397 900 / 7 | 3 397 900 / 7 | OK |
| Översikt: outnyttjat / total exponering | 3 844 200 / 7 242 100 | 3 844 200 / 7 242 100 | OK |
| Översikt: utdelningar i år / nettoinvesterat i år | 10 050 / 2 248 428 | 10 050 / 2 248 428 | OK |
| Översikt: värdeförändring i år (värde 2025-12-31 = 390 000 + 44 000 × 11,10 = 878 400) | 2 519 500 | 2 520 650 | **FEL** (fel 2) |
| Allokering: Noterade aktier 1 187 800 = 34,957 %, under intervallet | under, till mål 341 255 | under, 341 255 | OK |
| Allokering: Räntebärande 15,009 % / PE 16,775 % / Reala 24,174 % (över) / AR 9,085 % | ok / ok / över / ok | samma | OK |
| Allokering: exponering inkl. åtaganden per tillgångsslag | PE 1 380 000, Reala 2 464 200 | samma | OK |
| Avkastning Räntebärande sedan start | 2,0 % | 2,0 % | OK |
| Avkastning Absolute return sedan start | 2,9 % | 2,9 % | OK |
| Avkastning Total portfölj sedan start | inte handräknat i helhet. Avgiften i G-anrop 1 (44 200 kr) ensam ger −11,6 % mot F:s 380 000 kr | −4,0 % (index 100 → 88,37 veckan för G-anrop 1) | **FEL** (fel 3) |
| Avkastning: IRR på raden Total portfölj | hela portföljens IRR | 0,7 % = de slutna fondernas IRR (XIRR i Python: 0,70 %) | **FEL** (fel 11) |
| Likviditet: outnyttjat / likvida noterade / täckningsgrad | 3 844 200 / 1 697 800 (exkl. hedgefonden) / 0,4417 | samma | OK |
| Likviditet: aviserat anrop 2026-10-15 | 270 000 | 270 000 | OK |
| Rapportbevakning per 2026-09-30 | F försenad 2 d, G mottagen | så | OK |
| Rapportbevakning per 2026-12-31 (F saknar Q2 och Q3) | F 94 dagar sen | 2 dagar | **FEL** (fel 10) |
| Innehavsrapport CSV: alla värden ovan | enligt liggaren | stämmer rad för rad | OK |
| Transaktionsrapport CSV | belopp och valutakurser enligt liggaren | stämmer ("Belopp SEK" är exklusive avgift, se behov) | OK |
| Inkorgen: förhandsvisning för F-utdelning med återinkallningsbart | outnyttjat 1 280 000 → 1 380 000, NAV 720 000 → 570 000 | så | OK |
| Inkorgen: avstämning mot kapitalkontoutdrag G | åtagande, utdelat och outnyttjat stämmer. Inbetalt 80 000 enligt GP mot 81 000 bokfört (utjämningsräntan) | varning för inbetalt, övrigt OK | OK (se behov 9) |
| Inkorgen: samma fil två gånger | stoppas | "Samma fil är redan uppladdad" | OK |
| Inkorgen: samma avi som ny fil (samma belopp och dag) | dubblettvarning som måste kvitteras | så | OK |
| Inkorgen: reviderad avi (samma fond och dag, annat belopp) | dubblettvarning | "Ingen liknande transaktion finns" | **FEL** (fel 8) |
| Inkorgen: manuell post utan AI kan godkännas i gränssnittet | ja | nej, "Välj juridisk enhet" går inte att åtgärda | **FEL** (fel 5) |
| Fyra ögon: samma användare granskar och attesterar | stoppas | stoppas | OK |
| Fyra ögon: en annan användare attesterar | godkänns | godkänns | OK |
| Fyra ögon: attesterad transaktion ändras eller tas bort av en användare | stoppas | sparas direkt | **FEL** (fel 1) |
| Läsare försöker registrera, attestera, läsa logg | 403 | 403 | OK |
| Sälj 1 000 A när innehavet är 900 | stoppas | stoppas | OK |
| Import av två sälj om 500 när innehavet är 900 | rad 2 stoppas och inget sparas | så | OK |
| Rättelse av köp (1 000 → 100) när 800 redan sålts | stoppas | sparas, realiserat blir 86 000 | **FEL** (fel 4) |
| Köp i CHF utan någon CHF-kurs | stoppas | stoppas | OK |
| Köp i USD före första USD-kursen | stoppas | bokas med en kurs från ett senare datum | **FEL** (fel 6) |
| Anrop 500 000 EUR när 220 000 EUR återstår (manuellt) | stoppas eller varnas | sparas, outnyttjat visas som 0 | **FEL** (fel 7) |
| Kända fel 04–07 | ska fortfarande fela | felar fortfarande (alla fyra) | bekräftat |

---

## 3. Fel

Felen är sorterade efter allvar för förvaltningen. Fel 1–11 har varsin scenariofil. Fel 12–14 gäller bara gränssnittet eller dokumentationen och går inte att uttrycka som API-scenario.

### Fel 1 (allvarligt). Fyra ögon kan kringgås: en attesterad transaktion kan ändras eller tas bort av en enda användare
**Återskapa:** Slå på fyra ögon. Användare 1 granskar ett kapitalanrop i Inkorgen och användare 2 attesterar. Därefter ändrar användare 1 beloppet under Transaktioner (`PUT /api/transactions/:id`) eller tar bort transaktionen. Det går igenom utan ny attest. Samma användare kan också boka ett kapitalanrop direkt (`POST /api/transactions`) utan någon andra person (Import provade jag inte med fyra ögon, men den har ingen attestering alls). I testet tog jag bort det attesterade anropet #17 och bokade ett nytt anrop som administratör ensam, trots att fyra ögon var påslaget.
**Konsekvens:** Kontrollen ger en falsk trygghet. Revisor och styrelse kan inte lita på att bokade kassaflöden har attesterats av två personer. Ändringsloggen visar visserligen vad som hänt, men det upptäcks bara om någon aktivt granskar loggen.
**Scenario:** `15-fyra-ogon-attesterad-transaktion.json`

### Fel 2 (allvarligt). Avkastning och värdeförändring "i år" (och 1/3 mån) mäts från närmaste veckopunkt, inte från periodens startdag
**Återskapa:** Köp 100 aktier à 100 (2025-12-01). Kurs 120 per 2025-12-31 och 132 per 2026-06-30. Per 2026-06-30 visar programmet **avkastning i år 32 %** (rätt: 10 %) och **värdeförändring i år 3 200 kr** (rätt: 1 200 kr). Värdeserien tas fram var 7:e dag räknat från första affärsdagen, och perioden startar vid den senaste punkten före 2025-12-31 (här 2025-12-29). I min portfölj hamnade därför NAV-omvärderingarna per 2025-12-31 i 2026. Samma sak syns under Avkastning: Reala tillgångar har +9,6 % på 3 månader men +4,2 % i år, eftersom Q2-rapporten per 2026-06-30 räknas in i perioden "3 mån".
**Konsekvens:** Avkastning i år är den siffra som styrelsen och investeringskommittén tittar på först. Årsskiftets bokslutsvärderingar hamnar på fel år, och perioderna stämmer inte med depåbankens eller förvaltarnas rapporter.
**Scenario:** `08-avkastning-i-ar-fran-arsskiftet.json`

### Fel 3 (allvarligt). Avgifter i ett kapitalanrop slår mot den portfölj som fanns före anropet, och ger en falsk förlust i tidsviktad avkastning
**Återskapa:** Räntefond 100 000 kr med oförändrad kurs. Ett PE-anrop på 980 000 + avgift 20 000. Programmet visar Total portfölj sedan start **−20,0 %** (rätt: 1 080 000 / 1 100 000 − 1 = −1,8 %) och Private equity sedan start **0,0 %** (rätt: −2,0 %). Flödet läggs i slutet av dagen, så avgiften mäts mot värdet före anropet. I min portfölj sjönk totalindex från 100 till 88,4 veckan då G-anrop 1 gjordes (avgifter 44 200 kr mot F:s NAV 380 000), och därför visar Total portfölj −4,0 % sedan start trots att alla tillgångsslag är positiva sedan start.
**Konsekvens:** Den tidsviktade avkastningen ska enligt uppdraget inte påverkas av in- och utflöden, men här styrs den av storleken och tidpunkten för kapitalanropen. Siffran går inte att använda i rapporteringen till styrelsen eller vid jämförelse mot index.
**Scenario:** `09-avkastning-avgift-i-kapitalanrop.json`

### Fel 4 (allvarligt). Rättelse eller borttag av ett köp kontrolleras inte mot senare försäljningar
**Återskapa:** Köp 1 000 (2026-01-10) och sälj 800 (2026-03-10). Rätta köpet till 100 st: det sparas, innehavet blir 0 och realiserat 86 000. Ta bort köpet: det sparas, och realiserat blir 96 000 (hela likviden räknas som vinst). Att flytta köpet till efter försäljningen går också igenom. Detta är en annan väg än den kända bakdaterade försäljningen (scenario 06).
**Konsekvens:** En vanlig rättelse kan förstöra innehav, anskaffningsvärde och realiserat resultat utan varning, och felet syns inte i innehavslistan eftersom positionen försvinner. Det påverkar skatt och redovisning.
**Scenario:** `11-rattelse-av-kop-efter-forsaljning.json`

### Fel 5 (allvarligt för drift utan AI). En manuellt registrerad post i Inkorgen går inte att godkänna i gränssnittet
**Återskapa:** Utan `ANTHROPIC_API_KEY`: ladda upp ett underlag, välj "Lägg till post manuellt → Kapitalanrop", välj instrument och fyll i fälten. Under Investerare visas enhetens namn, men posten har ingen enhet (`entity_id = null`). Kontrollen "Välj juridisk enhet" blockerar godkännandet, och det finns ingen knapp eller lista för att välja eller bekräfta enheten (matchningsrutan visas bara för AI-poster). Jag kom bara vidare genom att sätta enheten via API:et.
**Konsekvens:** README lovar att Inkorgen fungerar utan AI, men i praktiken kan ingen post bokas den vägen. Arbetsflödet med underlag och fyra ögon blir oanvändbart utan AI-nyckel.
**Scenario:** `10-inkorg-manuell-post-enhet.json`

### Fel 6 (medel). Valutakurs från ett senare datum används tyst för tidigare affärer och värderingar
**Återskapa:** Den första USD-kursen gäller 2025-10-01 (9,50). Ett köp 2025-01-15 utan angiven valutakurs bokas med 9,50, och en värdering per 2025-06-30 använder också 9,50, utan varning. För en valuta helt utan kurser stoppas köpet ("Valutakurs för CHF saknas"), så beteendet är inte konsekvent.
**Konsekvens:** Anskaffningsvärdet i SEK kan bli fel (i scenariot 225 000 i stället för 110 000 kr), och historiska rapporter kan tyst bygga på framtida kurser.
**Scenario:** `13-valutakurs-fran-senare-datum.json`

### Fel 7 (medel). Kapitalanrop som överstiger outnyttjat åtagande sparas utan kontroll vid manuell registrering, och outnyttjat visas som 0
**Återskapa:** Fonden G hade 220 000 EUR outnyttjat. Ett manuellt anrop på 500 000 EUR sparades (201). Outnyttjat visades som 0 i stället för −280 000, och fondens outnyttjade belopp föll bort ur Allokering ("Inkl. outnyttjade åtaganden") och ur Likviditet. Inkorgen har en kontroll för samma sak, men den manuella vägen saknar den (Import går genom samma validering som den manuella vägen, men det provade jag inte separat).
**Konsekvens:** En felslagen siffra (en nolla för mycket) blåser upp inbetalt och NAV, och eftersom outnyttjat sätts till 0 döljs felet i stället för att synas.
**Scenario:** `12-kapitalanrop-over-ataganden.json`

### Fel 8 (medel). Dubblettkontrollen i Inkorgen missar en reviderad avi
**Återskapa:** Anrop 2 i G är bokat 2026-04-10 (30 000 + 2 000). GP skickar en reviderad avi för samma anrop (totalt 30 000, varav avgift 2 000). Kontrollen säger "Ingen liknande transaktion finns sedan tidigare". Bara exakt samma belopp ger en dubblettvarning.
**Konsekvens:** Reviderade avier är vanliga. Utan varning bokas anropet två gånger, så inbetalt, NAV och likviditetsprognos blir fel.
**Scenario:** `14-inkorg-reviderad-avi-dubblett.json`

### Fel 9 (medel). Förvaltningsavgifter i kapitalanrop redovisas inte som avgifter
**Återskapa:** Fonden F har anropat 40 000 kr i förvaltningsavgifter. Instrumentvyn visar "Fees (utanför NAV) 0,00" (fältet `fees`), och bara avgiftstransaktioner av typen Avgift räknas.
**Konsekvens:** Avgiftsuppföljningen (ILPA-rapportering, kostnadsredovisning till styrelsen) visar noll fast avgifter har betalats. Etiketten är dessutom på engelska.
**Scenario:** `17-pe-avgifter-i-kapitalanrop.json`

### Fel 10 (lågt till medel). Rapportbevakningen räknar förseningen från det senaste kvartalet i stället för från den äldsta saknade rapporten
**Återskapa:** Fonden F:s senaste rapport avser 2026-03-31. Per 2026-12-31 saknas rapporterna för Q2 (förfallodag 2026-09-28) och Q3 (2026-12-29). Programmet visar "Försenad (2 d)". Rätt är 94 dagar, och två rapporter saknas.
**Konsekvens:** Den GP som har varit sen längst ser minst sen ut, och det går inte att se hur många rapporter som saknas.
**Scenario:** `16-rapportbevakning-flera-saknade-kvartal.json`

### Fel 11 (lågt). "IRR sedan start" på raden Total portfölj är de slutna fondernas IRR
**Återskapa:** En aktie +50 % och en PE-fond 0 %, med lika stora belopp under exakt ett år. Hela portföljens IRR är 25 %, men raden Total portfölj visar 0 %. I min portfölj visade raden 0,7 %, vilket är F och G tillsammans.
**Konsekvens:** Raden är missvisande i en tabell som går till investeringskommittén.
**Scenario:** `18-irr-total-portfolj.json`

### Fel 12 (medel, bara gränssnittet). "Belopp" betyder olika saker i Inkorgen och i formuläret Ny transaktion
I Inkorgen är **Belopp** det totala anropet inklusive avgift, och avgiften är en del av det ("varav"). I Ny transaktion heter fältet **Anropat belopp**, men det betyder investeringsdelen, och avgiften läggs till ovanpå. Samma avi (totalt 49 000 varav avgift 4 000) ger inbetalt 49 000 i Inkorgen men 53 000 om man skriver av avin i Ny transaktion. Formuläret för typen Avgift har både "Avgiftsbelopp" och "Avgift". Felet går inte att uttrycka som ett API-scenario, eftersom API:et i sig är konsekvent (scenario 03).
**Konsekvens:** Det blir systematiska fel i inbetalt kapital beroende på vem som registrerar och var.

### Fel 13 (lågt, bara gränssnittet). Formuläret under Administration → Organisation visar inte nuvarande namn och organisationsnummer
Fälten är tomma trots att enheten har ett namn. Den som bara vill rätta organisationsnumret riskerar att spara ett tomt eller nytt namn.

### Fel 14 (lågt, dokumentation). README beskriver NAV utan rapport fel
README säger "Saknas rapport används inbetalt minus utdelat". Programmet använder investeringsdelen (utan avgifter), vilket stämmer med beräkningsprincipen ovanför i samma README och med mina förväntade värden. Texten bör rättas så att den inte vilseleder.

### Kända fel som fortfarande gäller
Scenario 04 (tom portfölj visar "Sedan start 0,0 %", syns också i gränssnittet), 05 (saknad valutakurs ger ogiltigt portföljvärde), 06 (bakdaterad försäljning) och 07 (negativt belopp i Inkorgen) felar fortfarande på samma sätt.

### Mindre iakttagelser (inga scenarier)
- När en utdelning från en sluten fond har avgift eller källskatt minskar framräknat NAV bara med nettobeloppet. Avdraget syns då inte som en förlust förrän nästa rapport kommer. Det är osäkert vilken princip som avses.
- En godkänd post i Inkorgen visar bara vem som attesterade, inte vem som granskade. Båda namnen behövs för revisionen.
- En fond som bara har ett åtagande, utan anrop, flaggas som "NAV saknas" på Översikten.
- IRR visas för fonder som är yngre än ett år (G per 2025-12-30: −49,9 %). En sådan IRR är inte meningsfull.

---

## 4. Behov som placerare

Behoven är ordnade efter hur mycket de hindrar skarp drift.

1. **Kassa och likvida medel som eget innehav.** Det finns inget kassakonto, och likvider från köp, försäljningar, anrop och utdelningar bokas inte mot något konto. Allokeringen säger själv att "Likvida medel ingår inte". Jag kan alltså inte stämma av mot depåbanken, se om kassan räcker till nästa anrop eller rapportera kassa som tillgångsslag mot policyn. Det är det första jag skulle sakna i skarp drift.
2. **Avstämning mot depåbank och förvaltare.** Jag behöver kunna läsa in depåbankens innehavs- och transaktionsfil och se avvikelser per instrument och per dag. Avstämningen mot kapitalkontoutdrag i Inkorgen är bra men görs post för post. Jag behöver dessutom en lista över fonder där bokfört och GP:s kapitalkonto inte stämmer.
3. **Kontroller som gäller överallt.** Fyra ögon, och kontrollerna för dubbletter, åtagande, innehav och valutakurs, bör gälla oavsett om något registreras i Inkorgen, i Ny transaktion eller via Import. I dag finns de bara i Inkorgen. En attesterad post ska bara kunna rättas genom en ny attesterad post (rättelse eller makulering), inte genom att skrivas över.
4. **Jämförelseindex.** Styrelsen frågar alltid hur vi gått mot policyportföljens index. Jag behöver index per tillgångsslag, ett sammanvägt policyindex och aktiv avkastning per period. För private markets behövs dessutom ett PME-mått (till exempel Kaplan–Schoar) mot ett noterat index.
5. **Rapportpaket till styrelse och investeringskommitté.** Jag behöver ett kvartalspaket med allokering mot policy (inklusive historik), avkastning per period mot index, åtaganden och anropstakt, de största innehaven, avvikelser och limitbrott, och rapportbevakningen, som PDF med layout och som CSV. Innehavsrapporten i CSV saknar i dag tillgångsslag och delsegment, och för slutna fonder saknas inbetalt och utdelat i SEK.
6. **Likviditetsplanering de närmaste 12 månaderna, per månad eller kvartal.** Prognosen börjar på nästa kalenderår (per 2026-09-30 visas 2027 först), så Q4 2026 saknas helt. Jag behöver aviserade anrop, prognos och kassa i samma tidslinje, med stresscenarier (anropen går snabbare och utdelningarna uteblir) och en täckningsgrad som tar hänsyn till kassan och till noterade innehavs likviditet.
7. **Pacing av nya åtaganden.** Prognosen räknar inte med nya åtaganden. Jag behöver kunna lägga in planerade åtaganden per år och strategi och se vart allokeringen mot policy tar vägen de kommande 5–10 åren. Det är så vi beslutar om nästa års åtagandebudget.
8. **Historik för policyportföljen.** Målvikterna sparas utan datum. När policyn ändras måste gamla rapporter fortfarande visa den policy som gällde då, och ändringen måste kunna spåras till ett styrelsebeslut.
9. **Kapitalkontot som GP:n redovisar det.** Jag behöver se anropat mot åtagandet skilt från avgifter utanför åtagandet (utjämningsränta). Avstämningen varnade för 80 000 mot 81 000 i inbetalt, och skillnaden var utjämningsräntan som GP:n inte räknar in. Det ska gå att stämma av utan manuella förklaringar. Jag behöver också en uppdelning av avgifter per år (förvaltningsavgift, fondkostnader, carry) för ILPA-rapportering.
10. **Rimlig gräns för inaktuella värderingar per instrument.** Hedgefonden med månads-NAV flaggas som inaktuell redan efter 7 dagar, och PE-fonder först efter 200 dagar. Gränsen behöver kunna sättas per instrument (daglig kurs, månads-NAV eller kvartals-NAV). Inaktuella valutakurser behöver också flaggas.
11. **Revision och spårbarhet.** Jag behöver kunna ta ut ändringsloggen per transaktion och per period, med granskare, attestant, originalunderlag och före- och eftervärden, som en exporterbar rapport till revisorn. Jag behöver också kunna låsa en period (till exempel efter kvartalsbokslut) så att historiska siffror inte ändras i efterhand.
12. **Tydlig och enhetlig registrering av kapitalanrop och utdelningar.** Samma fältnamn och samma betydelse i Ny transaktion, Inkorgen och Import (se fel 12). Återinkallningsbart belopp och avgifter utanför åtagandet ska gå att ange även i Ny transaktion och Import. I dag kan de bara anges i Inkorgen.
13. **Tillgångsslag vid import av instrument.** Importen av instrument har ingen kolumn för tillgångsslag eller delsegment, så en infrastrukturfond eller hedgefond måste klassas om för hand efteråt.
14. **Avräkning per likviddag.** Transaktionsrapporten har en kolumn "Belopp SEK" exklusive courtage och avgift. För avstämning mot bankkontot behöver jag likvidbeloppet i SEK och likviddagen.

---

## 5. Vad jag inte testade

- AI-tolkning i Inkorgen (ingen API-nyckel). Alla poster registrerades manuellt.
- Morningstar-kopplingen.
- Flera juridiska enheter (programmet tillåter bara en).
- Fullständig handräkning av den tidsviktade avkastningen för hela portföljen och för Noterade aktier och Private equity. Jag kontrollerade Räntebärande och Absolute return, som båda stämde, och isolerade felen i fel 2 och 3 med egna små scenarier.
- Prognosmodellens parametrar (Takahashi–Alexander) kontrollerades inte mot egen uträkning.
- Avvecklad fond (helt utdelad) och "Visa avslutade".
- Utskrift och PDF, mobilvy och prestanda med stora datamängder.
- Säkerhet utöver rollerna (sessioner, lösenordsbyte, brute force).

---

## 6. Scenariofiler

Alla är märkta med `kantFel` på de kontroller som visar felet. Hela scenariokörningen (`node --no-warnings --import tsx --test server/scenarios.test.ts`) ger 89 tester: 57 godkända, 0 fel och 32 todo. Jag har kontrollerat att varje todo faller på själva felet, och att övriga kontroller i samma scenarier går igenom (till exempel marknadsvärde, inbetalt, outnyttjat och NAV).

| Fil | Fel |
|---|---|
| `tests/scenarios/08-avkastning-i-ar-fran-arsskiftet.json` | Fel 2 |
| `tests/scenarios/09-avkastning-avgift-i-kapitalanrop.json` | Fel 3 |
| `tests/scenarios/10-inkorg-manuell-post-enhet.json` | Fel 5 |
| `tests/scenarios/11-rattelse-av-kop-efter-forsaljning.json` | Fel 4 |
| `tests/scenarios/12-kapitalanrop-over-ataganden.json` | Fel 7 |
| `tests/scenarios/13-valutakurs-fran-senare-datum.json` | Fel 6 |
| `tests/scenarios/14-inkorg-reviderad-avi-dubblett.json` | Fel 8 |
| `tests/scenarios/15-fyra-ogon-attesterad-transaktion.json` | Fel 1 |
| `tests/scenarios/16-rapportbevakning-flera-saknade-kvartal.json` | Fel 10 |
| `tests/scenarios/17-pe-avgifter-i-kapitalanrop.json` | Fel 9 |
| `tests/scenarios/18-irr-total-portfolj.json` | Fel 11 |

Anmärkningar om förväntade värden som kan diskuteras:
- **12:** Jag förväntar mig att anropet stoppas (400), på samma sätt som en försäljning som överstiger innehavet. Om man i stället väljer att varna och visa ett negativt outnyttjat belopp behöver scenariot motiveras om.
- **11 och 15:** Statuskoden för stoppat borttag eller stoppad ändring är satt till 409, i linje med andra konflikter i API:et.
- **09:** Det förväntade värdet bygger på att flödet räknas i början av dagen (eller likvärdig Modified Dietz-viktning). Det är den vedertagna lösningen när värdeförändringen samma dag orsakas av själva flödet.
