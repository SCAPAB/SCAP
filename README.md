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

## Beräkningsprinciper

- **Rapportvaluta** är SEK. Valutakurs anges som SEK per enhet.
- **Anskaffningsvärde** beräknas enligt genomsnittsmetoden, per juridisk enhet och inklusive courtage. Anskaffningsvärdet i SEK räknas med valutakursen på affärsdagen.
- **Valutaeffekt** är anskaffningsvärdet i lokal valuta × dagens valutakurs minus anskaffningsvärdet i SEK.
- **PE-NAV:** senast rapporterade NAV plus kapitalanrop och minus utdelningar efter rapportdatum. Saknas rapport används inbetalt minus utdelat. Framräknade värden markeras med *.
- **Avkastning** är tidsviktad (TWR), länkad Modified Dietz per vecka. Köp, försäljningar, anrop och utdelningar räknas som externa flöden, så insättningar påverkar inte avkastningen.
- **IRR** är XIRR på faktiska kassaflöden plus NAV som slutvärde.

Beräkningarna finns i `server/calc.ts` och testas i `server/calc.test.ts` (`npm test`).

## Struktur

```
server/   Express-API, SQLite (node:sqlite), beräkningar, import
client/   React + Vite, svenskt gränssnitt
shared/   gemensamma typer
```

## Ej byggt ännu / förslag på nästa steg

- Automatisk kurs- och valutahämtning från en datakälla, till exempel Riksbanken för valutor och en kursleverantör.
- Index och jämförelseindex för avkastningsjämförelse.
- Fler instrumentslag (räntepapper, onoterade direktinvesteringar, fastigheter).
- SSO (Azure AD/Entra ID) och tvåfaktorsinloggning.
- Avstämning mot depåbank och PDF-rapporter med layout.
