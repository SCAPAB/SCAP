# Innehav

Portföljsystem för institutionella investerare. Det samlar direktägda aktier, aktie- och räntefonder samt private equity-fonder för en juridisk enhet (namn och org.nr anges under Administration → Organisation).

## Kör i GitHub Codespaces (ingen installation)

I repot på GitHub: **Code → Codespaces → Create codespace on main**. Codespacet installerar allt, skapar demodata och startar programmet. En webbläsarflik öppnas med inloggningssidan (port 5173). Logga in med `admin@innehav.local` / `innehav`.

Dela en länk med en kollega: gå till fliken **Ports** i Codespaces, högerklicka på port 5173 och välj **Port Visibility → Private to Organization**.

## Kom igång lokalt

```bash
npm install
npm run seed        # skapar databasen data/innehav.db med DEMODATA (raderar befintligt innehåll)
npm run dev         # API på :3001 och webb på http://localhost:5173
```

Produktionsläge: `npm run build && npm start`. Då serverar API:et den byggda klienten på http://localhost:3001.

Demoinloggning: `admin@innehav.local` (administratör), `granskare@innehav.local` (redigerare, för att prova fyra ögon-principen) och `lasare@innehav.local` (läsare). Lösenordet är `innehav` för alla tre.
Byt lösenorden innan systemet används på riktigt (Administration → Användare). Du kan också köra seed med `ADMIN_PASSWORD=...`.

> Demodata är syntetiskt. Kurser, valutakurser, NAV och kassaflöden är framslumpade och motsvarar inte verkliga marknadsdata.

## Struktur i menyn

Systemet är uppbyggt som en institutionell kapitalförvaltare (till exempel ett universitetsendowment eller en stiftelse) arbetar:

- **Portfölj:** Översikt · Allokering mot policy · Avkastning · Likviditet och åtaganden
- **Tillgångsslag:** Noterade aktier · Räntebärande · Private equity · Reala tillgångar · Absolute return
- **Operativt:** Inkorg · Rapportbevakning · Transaktioner · Kurser och valutor · Import
- **Register och rapporter:** Instrument · Rapporter · Administration

**Tillgångsslag** (ekonomisk exponering) är skilt från **förvaltningsform** (direktägd aktie, öppen fond eller sluten fond). En globalfond och en direktägd Apple-aktie hamnar båda under noterade aktier. En infrastrukturfond är en sluten fond men räknas till reala tillgångar. Beräkningsmetoden styrs av förvaltningsformen, medan segmenteringen och policyuppföljningen styrs av tillgångsslaget.

## Funktioner

| Område | Innehåll |
|---|---|
| Allokering mot policy | Faktisk vikt mot målvikt och tillåtet intervall per tillgångsslag, exponering inklusive outnyttjade åtaganden, belopp till målvikt och delsegment. Policyportföljen redigeras av administratör |
| Avkastning | Tidsviktad avkastning per tillgångsslag (1 mån–sedan start) och netto-IRR för slutna fonder |
| Likviditet och åtaganden | Outnyttjade åtaganden, aviserade anrop, täckningsgrad och kassaflödesprognos enligt Takahashi–Alexander-modellen |
| Rapportbevakning | Om varje GP har levererat kvartalsrapport (mottagen, väntar eller försenad) |
| Översikt | Marknadsvärde, tidsviktad avkastning (1 mån, 3 mån, i år, 1 år, 3 år, sedan start), värdeutveckling mot nettoinvesterat kapital, största innehav, fördelning per tillgångsslag, valuta, region, bransch, förvaltare, varning för inaktuella kurser och NAV |
| Aktier och fonder | Antal, GAV, kurs, anskaffnings- och marknadsvärde i SEK, orealiserat resultat uppdelat på kurs och valuta, realiserat resultat, utdelningar |
| PE-fonder | Åtagande, inbetalt, outnyttjat, utdelat, NAV (rullas fram från senaste rapport), DPI, RVPI, TVPI, IRR lokalt och i SEK, kassaflöden per år (J-kurva) |
| Instrumentvy | Kurshistorik, transaktioner, NAV-rapporter och instrumentfakta |
| Urval | Valfritt historiskt datum ("per datum") i alla vyer |
| Registrering | Transaktioner (köp, sälj, utdelning, avgift, åtagande, kapitalanrop, utdelning/återbetalning), instrument, kurser, valutakurser, NAV |
| Import | CSV eller inklistrat från Excel för transaktioner, kurser, valutakurser, NAV och instrument. Importen testkörs först och allt-eller-inget gäller |
| Rapporter | Innehavsrapport (per enhet, valfritt datum) och transaktionsrapport som CSV för Excel, samt utskrift och PDF av alla vyer |
| Säkerhet | Inloggning, roller (läsare, redigerare, administratör) och ändringslogg över alla ändringar |

## Inkorg – underlag med AI-förslag och manuellt godkännande

Grundprincip: **AI föreslår, människan godkänner.** Ingenting sparas i portföljen innan någon har godkänt posten.

1. **Ladda upp** PDF- eller bildfiler, gärna flera samtidigt. Samma fil kan inte laddas upp två gånger, eftersom kontrollen görs på filens SHA-256.
2. **AI-tolkning (Claude)** föreslår poster: kapitalanrop, utdelningar från PE-fonder, NAV från kapitalkontoutdrag, köp och sälj av fondandelar och aktier, aktieutdelningar, kurser och innehav. Varje fält får **värde, säkerhetsgrad, sidnummer och ordagrant citat**.
3. **Granskning bredvid källan.** Dokumentet visas till vänster, och när du klickar på ett fält **markeras värdet i dokumentet**. Fälten är märkta *AI · säker*, *AI · kontrollera*, *AI · osäker* (måste bekräftas), *Ändrad av dig* (med återställning) eller *Manuell*.
4. **Matchning** av investerare och instrument. Anger dokumentet en annan investerare än er enhet måste det bekräftas aktivt. Endast ISIN, org.nr, identiskt namn eller ett **inlärt namn** räknas som säker träff. Allt annat måste bekräftas eller väljas bland förslag. Fondnummer (IV/V), vehikel (huvudfond, parallell, feeder, "No. 2" eller co-invest) och andelsklass (A/B, valuta) hålls isär. När en matchning godkänns lärs namnet in per avsändare, så att nästa dokument från samma GP matchas säkert. Systemet varnar om avsändaren inte är fondens registrerade förvaltare, eller om enheten saknar åtagande i fonden.
5. **Egna kontroller** som inte bygger på AI: möjliga dubbletter, att delposterna summerar till totalen, att avgiftsdelen stämmer, att antal × kurs stämmer med likvidbeloppet, att försäljningen inte överstiger innehavet, att anropet ryms inom åtagandet, NAV-avvikelse mot förra rapporten justerad för flöden, **avstämning mot kapitalkontot** (åtagande, inbetalt, utdelat, outnyttjat) och **avstämning mot innehavsbesked**, med en knapp som skapar köp- eller säljposten för differensen.
6. **Förhandsvisning av effekten:** till exempel inbetalt, outnyttjat och NAV före och efter, eller antal, GAV och anskaffningsvärde före och efter.
7. **Delposter med bokföringskategori:** investering, förvaltningsavgift, fondkostnader, utjämningsränta (utanför åtagandet), återbetalt kapital, återinkallningsbart kapital (ökar outnyttjat åtagande), realiserad vinst, ränta/utdelning och källskatt.
8. **Fyra ögon-principen (valbar):** en användare granskar och markerar posten, en annan attesterar.
9. **Godkännande post för post.** Fel spärrar godkännandet, och varningar måste bekräftas aktivt. Ändringsloggen sparar vad AI föreslog, vad som ändrades, vilka osäkra värden som bekräftades och vilka varningar som accepterades. Transaktionen länkas till originaldokumentet.
10. **Tolkningsregler per avsändare** (GP, fondbolag eller bank) skickas med till AI:n. **Tolka om** kan ta en engångsinstruktion.

### Aktivera AI-tolkning

```bash
export ANTHROPIC_API_KEY=...        # nyckel från console.anthropic.com
export INNEHAV_AI_MODEL=claude-opus-5-5   # valfritt, detta är standard
```

Dokumenten skickas då till Anthropics API för tolkning. Kontrollera att det är förenligt med era riktlinjer för informationshantering. Utan nyckel fungerar Inkorgen ändå: posterna registreras manuellt med samma kontroller och samma godkännande.

### Demo utan API-nyckel

```bash
npm run demo        # demodata + fyra demodokument i data/demo-dokument/
npm run dev:demo    # startar med förinspelade AI-svar för demodokumenten
```

Ladda sedan upp PDF:erna från `data/demo-dokument/` i Inkorgen. Demodokumenten innehåller två avsiktliga avvikelser: ett saknat kapitalanrop för Demo Stiftelse och 1 500 för många aktier i innehavsbeskedet.

## Morningstar (Analytics Lab)

Under **Kurser och valutor → Morningstar** hämtas kurser och grunddata från Morningstar via LRF:s Analytics Lab-licens (Python-paketet `morningstar-data`).

1. **Anslut:** öppna Analytics Lab, välj **Analytics Lab → Copy Authentication Token** och klistra in nyckeln. Nyckeln hålls bara i serverns minne och visar när den går ut.
2. **Koppla instrument:** programmet söker på ISIN och föreslår rätt listning (instrumentets valuta och hemmabörs). Du bekräftar varje koppling, eller alla tydliga på en gång.
3. **Hämta kurser:** dagskurs för aktier och NAV för fonder, sedan senaste hämtningen eller från valt datum. Manuella kurser skrivs aldrig över. Stora avvikelser mot tidigare källa flaggas.
4. **Nytt instrument:** skriv ISIN och klicka på **Morningstar**. Namn, valuta, bransch eller kategori och tillgångsslag fylls i och kopplingen sparas.

Krav på servern: Python 3.9 eller senare och `pip install morningstar-data`. Codespaces installerar detta automatiskt i `.venv`. Datapunkts-id kan ändras med miljövariablerna `MS_DP_*` i `scripts/morningstar_bridge.py`. Nyckeln från Analytics Lab är kortlivad, så för helt automatisk nattlig hämtning behövs en långlivad API-nyckel från Morningstar.

## Beräkningsprinciper

- **Rapportvaluta** är SEK. Valutakurs anges som SEK per enhet.
- **Anskaffningsvärde** beräknas enligt genomsnittsmetoden, inklusive courtage. Anskaffningsvärdet i SEK räknas med valutakursen på affärsdagen.
- **Valutaeffekt** är anskaffningsvärdet i lokal valuta × dagens valutakurs minus anskaffningsvärdet i SEK.
- **PE-NAV:** senast rapporterade NAV plus kapitalanropens investeringsdel (avgifter ingår i inbetalt men inte i NAV) och minus utdelningar efter rapportdatum. Saknas rapport används inbetalt minus utdelat. Framräknade värden markeras med *.
- **Avkastning** är tidsviktad (TWR) och bryts vid varje transaktionsdag (flöden i slutet av dagen). Köp, försäljningar, anrop och utdelningar räknas som externa flöden.
- **Outnyttjat åtagande** = åtagande − anropat (exklusive utjämningsränta utanför åtagandet) + återinkallningsbara utdelningar.
- **Kassaflödesprognos** enligt Takahashi & Alexander (2002) med schablonparametrar per strategi (tillväxt, löptid, bow, anropstakt).
- **IRR** är XIRR på faktiska kassaflöden plus NAV som slutvärde.

Beräkningarna finns i `server/calc.ts` och testas i `server/calc.test.ts` (`npm test`).

## Struktur

```
server/   Express-API, SQLite (node:sqlite), beräkningar, import, AI-tolkning (ai.ts), förslag och kontroller (proposals.ts)
client/   React + Vite, svenskt gränssnitt
shared/   gemensamma typer
```

## Ej byggt ännu / förslag på nästa steg

- Automatisk kurs- och valutahämtning från en datakälla, till exempel Riksbanken för valutor och en kursleverantör.
- Index och jämförelseindex för avkastningsjämförelse.
- Fler instrumentslag (räntepapper, onoterade direktinvesteringar, fastigheter).
- SSO (Azure AD/Entra ID) och tvåfaktorsinloggning.
- Avstämning mot depåbank och PDF-rapporter med layout.
