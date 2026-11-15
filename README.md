# Innehav

Portföljsystem för institutionella investerare. Det samlar direktägda aktier, aktie- och räntefonder samt private equity-fonder för flera juridiska enheter i en och samma vy.

## Kom igång

```bash
npm install
npm run seed        # skapar databasen data/innehav.db med DEMODATA (raderar befintligt innehåll)
npm run dev         # API på :3001 och webb på http://localhost:5173
```

Produktionsläge: `npm run build && npm start`. Då serverar API:et den byggda klienten på http://localhost:3001.

Demoinloggning: `admin@innehav.local` / `innehav` (administratör) och `lasare@innehav.local` / `innehav` (läsare).
Byt lösenorden innan systemet används på riktigt (Administration → Användare). Du kan också köra seed med `ADMIN_PASSWORD=...`.

> Demodata är syntetiskt. Kurser, valutakurser, NAV och kassaflöden är framslumpade och motsvarar inte verkliga marknadsdata.

## Funktioner

| Område | Innehåll |
|---|---|
| Översikt | Marknadsvärde, tidsviktad avkastning (1 mån, 3 mån, i år, 1 år, 3 år, sedan start), värdeutveckling mot nettoinvesterat kapital, största innehav, fördelning per tillgångsslag, valuta, region, bransch, förvaltare och juridisk enhet, varning för inaktuella kurser och NAV |
| Aktier och fonder | Antal, GAV, kurs, anskaffnings- och marknadsvärde i SEK, orealiserat resultat uppdelat på kurs och valuta, realiserat resultat, utdelningar |
| PE-fonder | Åtagande, inbetalt, outnyttjat, utdelat, NAV (rullas fram från senaste rapport), DPI, RVPI, TVPI, IRR lokalt och i SEK, kassaflöden per år (J-kurva) |
| Instrumentvy | Kurshistorik, transaktioner, NAV-rapporter, innehav per juridisk enhet |
| Urval | Valfria juridiska enheter och valfritt historiskt datum ("per datum") i alla vyer |
| Registrering | Transaktioner (köp, sälj, utdelning, avgift, åtagande, kapitalanrop, utdelning/återbetalning), instrument, kurser, valutakurser, NAV |
| Import | CSV eller inklistrat från Excel för transaktioner, kurser, valutakurser, NAV och instrument. Importen testkörs först och allt-eller-inget gäller |
| Rapporter | Innehavsrapport (per enhet, valfritt datum) och transaktionsrapport som CSV för Excel, samt utskrift och PDF av alla vyer |
| Säkerhet | Inloggning, roller (läsare, redigerare, administratör) och ändringslogg över alla ändringar |

## Inkorg – underlag med AI-förslag och manuellt godkännande

Grundprincip: **AI föreslår, människan godkänner.** Ingenting sparas i portföljen innan någon har godkänt posten.

1. **Ladda upp** PDF- eller bildfiler, gärna flera samtidigt. Samma fil kan inte laddas upp två gånger, eftersom kontrollen görs på filens SHA-256.
2. **AI-tolkning (Claude)** föreslår poster: kapitalanrop, utdelningar från PE-fonder, NAV från kapitalkontoutdrag, köp och sälj av fondandelar och aktier, aktieutdelningar, kurser och innehav. Varje fält får **värde, säkerhetsgrad, sidnummer och ordagrant citat**.
3. **Granskning bredvid källan.** Dokumentet visas till vänster, och när du klickar på ett fält **markeras värdet i dokumentet**. Fälten är märkta *AI · säker*, *AI · kontrollera*, *AI · osäker* (måste bekräftas), *Ändrad av dig* (med återställning) eller *Manuell*.
4. **Matchning** mot juridisk enhet (org.nr eller namn) och instrument (ISIN eller namn, där "Fund IV" aldrig blandas ihop med "Fund V"). Investeraretiketten i dokumentet verifieras mot vald enhet.
5. **Egna kontroller** som inte bygger på AI: möjliga dubbletter, att delposterna summerar till totalen, att avgiftsdelen stämmer, att antal × kurs stämmer med likvidbeloppet, att försäljningen inte överstiger innehavet, att anropet ryms inom åtagandet, NAV-avvikelse mot förra rapporten justerad för flöden, **avstämning mot kapitalkontot** (åtagande, inbetalt, utdelat, outnyttjat) och **avstämning mot innehavsbesked**, med en knapp som skapar köp- eller säljposten för differensen.
6. **Förhandsvisning av effekten:** till exempel inbetalt, outnyttjat och NAV före och efter, eller antal, GAV och anskaffningsvärde före och efter.
7. **Godkännande post för post.** Fel spärrar godkännandet, och varningar måste bekräftas aktivt. Ändringsloggen sparar vad AI föreslog, vad som ändrades, vilka osäkra värden som bekräftades och vilka varningar som accepterades. Transaktionen länkas till originaldokumentet.
8. **Tolkningsregler per avsändare** (GP, fondbolag eller bank) skickas med till AI:n. **Tolka om** kan ta en engångsinstruktion.

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

## Beräkningsprinciper

- **Rapportvaluta** är SEK. Valutakurs anges som SEK per enhet.
- **Anskaffningsvärde** beräknas enligt genomsnittsmetoden, per juridisk enhet och inklusive courtage. Anskaffningsvärdet i SEK räknas med valutakursen på affärsdagen.
- **Valutaeffekt** är anskaffningsvärdet i lokal valuta × dagens valutakurs minus anskaffningsvärdet i SEK.
- **PE-NAV:** senast rapporterade NAV plus kapitalanropens investeringsdel (avgifter ingår i inbetalt men inte i NAV) och minus utdelningar efter rapportdatum. Saknas rapport används inbetalt minus utdelat. Framräknade värden markeras med *.
- **Avkastning** är tidsviktad (TWR), länkad Modified Dietz per vecka. Köp, försäljningar, anrop och utdelningar räknas som externa flöden, så insättningar påverkar inte avkastningen.
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
