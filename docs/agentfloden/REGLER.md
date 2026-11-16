# Gemensamma regler för alla agenter och agentflöden

Varje agent i `.claude/agents/` läser den här filen först. Reglerna gäller i alla flöden om inte flödets egen beskrivning säger något annat.

## Data och miljö
- Rör aldrig den riktiga databasen (`data/innehav.db`), uppladdade dokument (`data/documents/`) eller en server som redan körs.
- Prova alltid i en egen testinstans med tillfällig databas, och stoppa den när du är klar:
  ```bash
  export TESTDB=$(mktemp -d)/test.db
  npx vite build >/dev/null && INNEHAV_DB=$TESTDB PORT=<ledig port 3100–3199> node --no-warnings --import tsx server/index.ts > /tmp/innehav-<agent>.log 2>&1 &
  ```
  Programmet startar tomt. Logga in med `admin@innehav.local` / `innehav`.
- Använd fasta datum (`asOf`) så att resultaten inte beror på dagens datum.
- All påhittad data är testdata. Använd fiktiva namn för onoterade fonder och motparter.

## Testning
- Kända och nya fel dokumenteras som **testscenarier** i `tests/scenarios/` (format i `tests/scenarios/README.md`), med handräknade förväntade värden och märkningen `kantFel` tills felet är rättat.
- Ta aldrig bort en kontroll och ändra aldrig ett förväntat värde för att få testerna gröna. Om scenariot visar sig vara fel ska det motiveras med en uträkning.
- `npm test` körs automatiskt på GitHub vid varje push och pull request (`.github/workflows/test.yml`).

## Människan bestämmer
- Ett steg som kräver mänskligt godkännande markeras i flödet med **Människa**. Agenter får aldrig fylla i ett godkännande själva, gissa ett godkännande eller tolka tystnad som ja.
- Beslutsavsnitt har alltid formen:
  ```
  ## Beslut (fylls i av människa)
  Status: VÄNTAR PÅ GODKÄNNANDE | GODKÄND | DELVIS GODKÄND | AVSLAG
  Godkänd av:
  Datum:
  Kommentar:
  ```
  Varje enskild punkt som kan godkännas har en kryssruta `- [ ] Godkänn`.
- En agent som utför något (ändrar kod eller data) kontrollerar först att beslutet finns och bara gäller det som är ikryssat.

## Kod
- Endast agenter vars roll uttryckligen är att ändra kod får göra det, och då alltid på en egen gren (`<flöde>/<datum>`), aldrig direkt på `main`. Ändringar når `main` bara via en pull request som en människa slår ihop. Ingen agent slår ihop, godkänner eller stänger pull requests.
- Tester först (`server/*.test.ts`). `npm test`, `npx tsc -p tsconfig.json --noEmit` och `npx vite build` ska vara gröna.
- Gränssnittet är på svenska. Behåll formspråket i `client/src/styles.css`.
- AI föreslår och människan godkänner. Allt loggas i `audit_log` och inget får bokas i tysthet.

## Tekniska spärrar
Reglerna ovan förstärks av spärrar som gäller oavsett instruktioner. Försök inte kringgå dem. Om en spärr stoppar något du behöver göra: stanna och beskriv varför i din leverans.
- **Agentvakten** (`.claude/hooks/agentvakt.mjs`) körs före varje verktygsanrop i Claude Code. Den stoppar push till `main`, sammanslagning och godkännande av pull requests, ändringar i grenskyddet och i den riktiga datan. För agenter stoppar den också ändringar i beslutsavsnitt och i spärrarna själva, och att servern startas utan tillfällig databas. Spärren testas i `server/agentvakt.test.ts`.
- **Beslutskontrollen** (`scripts/kontrollera-beslut.mjs`) körs på GitHub för varje pull request från en flödesgren `<flöde>/<datum>`. Den kräver ett mänskligt beslut på `main` och att varje commit med förslags-id (`F3: …`) gäller ett godkänt förslag.
- **Grenskyddet på GitHub** kräver pull request och gröna kontroller för `main`.

## Överlämning mellan agenter
- Varje steg lämnar en fil i flödets mapp: `docs/agentfloden/<flöde>/<ÅÅÅÅ-MM-DD>-<stegnr>-<namn>.md`.
- Nästa steg läser bara den filen. Skriv därför så att den går att förstå utan annat sammanhang.
- Skriv på svenska och i klartext. Rapportera bara det du faktiskt har gjort eller sett, och markera osäkerheter.
- Filerna commit:as så att beslutskedjan är spårbar.
