# Granskning 2026-11-15 – leverans F1–F12
Granskad gren: `forbattring/2026-11-15` (till och med `3df7e53`). Oberoende granskning i steg 5 i agentflödet improve.

## Utfall
**ÅTGÄRDA FÖRST.** F1 räknar fel avkastning i det vanligaste fallet, ett köp eller anrop mitt i en vecka efter kursrörelser, och det är sämre än på `main`. F9 kan dessutom märka en transaktion som "Attesterad" fast bara en person har registrerat den. Resten av leveransen håller god kvalitet och ryms inom F1–F12.

## Blockerande fynd

1. **F1 – avkastningen späds ut när ett inflöde kommer efter flera dagars kursrörelse (Kritisk).**
   - **Var:** `server/calc.ts:479–483` (`valueSeries`, nämnaren `prevValue + flow`).
   - **Vad som är fel:** Serien bryts bara vid veckopunkter och transaktionsdagar. Ett inflöde räknas därför som investerat från den *föregående brytpunkten*, som kan ligga upp till sex dagar tidigare, och inte från dagens början. Kursrörelser under de dagarna mäts då mot V0 + F.
   - **Verifierat:** Aktie A köps, 1 000 st à 100, den 2026-01-05. Kursen stiger till 110 fram till 2026-01-09, och samma dag köps aktie B för 1 000 000 med oförändrad kurs. Rätt avkastning (TWR) sedan start är 10 %. Grenen ger 0,91 %, och samma fall på `main` ger 10,00 %. Inget test fångar det.
   - **Förslag:** Lägg in en brytpunkt dagen före varje dag med nettoinflöde (`addDays(d, -1)`), så att delperioden med inflödet blir exakt en dag. Lägg till ett enhetstest med just det här fallet.

2. **F9 – attesten följer transaktionens id, och id:t kan återanvändas (Hög).**
   - **Var:** `server/changes.ts:21–27` (`ATTESTED_SQL` och `isAttested` via `proposals.result_ref`). I `server/schema.sql` har `transactions.id INTEGER PRIMARY KEY` ingen `AUTOINCREMENT`.
   - **Verifierat:** Ett attesterat anrop (#4) togs bort via en attesterad begäran. Ett nytt anrop via `POST /transactions` fick då id 4 och visas som `attested=1`. `PUT` ger 409, och den attesterade ändringsbegäran #1 visar den nya transaktionen som om det vore den borttagna.
   - **Förslag:** Vid borttag (både direkt och via begäran) ändras förslagets `result_ref` till exempelvis `deleted:transaction:4`. Alternativt sparas attesten på transaktionsraden, eller så migreras tabellen till `AUTOINCREMENT`. `change_requests` bör dessutom spara ett eget förevärde, och `listChangeRequests` bör visa det i stället för att hämta den aktuella raden.

3. **F2 – "1 mån" och "3 mån" vid månadsslut börjar fel dag (Medel, ger fel siffror).**
   - **Var:** `server/calc.ts`, `periodStarts` och `back()`, där `setUTCMonth` slår över till nästa månad.
   - **Verifierat:** Per 2026-12-31 börjar "3 mån" 2026-10-01 i stället för 2026-09-30. Per 2026-03-31 börjar "1 mån" 2026-03-03.
   - **Förslag:** Begränsa till månadens sista dag. Lägg till ett test per 2026-12-31 och 2026-03-31.

## Ej blockerande fynd
- **F10:** `POST /transactions` tar nu emot ett anrop som bara består av avgifter (`amount` 0 och `fee` > 0). Det är rimligt och ryms i F10, men beslutsfattaren bör se det uttryckligen.
- **"Attesterad" kräver inte två olika personer:** `ATTESTED_SQL` kontrollerar inte att `prepared_by <> decided_by`. När fyra ögon är avslaget kan samma person granska och godkänna, och posten märks då ändå som "Attesterad".
- **Gammal ändringsbegäran skriver över senare ändringar:** Godkännandet skriver hela den sparade `payload`, även om transaktionen har ändrats efter att begäran skapades. Spara förevärdet och avvisa begäran om det inte längre stämmer.
- **Attestanten ser inte alla ändrade fält:** I Inkorgens kort "Ändringar som väntar på attest" saknas `entity_id` i `CHANGE_FIELDS` (`client/src/pages/Inbox.tsx`).
- **Missvisande felmeddelande:** När ett åtagande sänks under det som redan är anropat blir felet "Kapitalanropet … överstiger outnyttjat åtagande …".
- **Kvar sedan tidigare:**
  - Om en importfil har en försäljning före ett köp samma dag stoppas raden.
  - Flöden på seriens första dag syns inte i "Sedan start".
- **Grundläggande begränsning:** En administratör kan skapa en extra användare och attestera sin egen begäran. Det hör till F13, F16 och frågan om två administratörer.
- **Godkänt:**
  - Omfånget håller sig till F1–F12.
  - `audit_log` fylls i vid skapande, attest och avslag.
  - Migreringen är `CREATE TABLE IF NOT EXISTS`.
  - Behörigheterna är rimliga.
  - Import och Inkorg kan inte kringgå låset.

## Vad jag kontrollerade
- **Tester och bygg:** `npm test` gav 165 av 165 godkända. `npm run typecheck` och `npx vite build` gick igenom.
- **Testfilerna:** Inga förväntade värden eller steg i `tests/scenarios/` är ändrade. Tillägg finns i 07, 14 och 16, och texten i beskrivningen i 15 är rättad.
- **Egna uträkningar** i en instans med tillfällig databas, med jämförelse mot `main`:
  - **F1:** 10 % på `main` mot 0,91 % på grenen.
  - **F2:** `periodStarts` per månadsslut.
  - **F5:** gränser för outnyttjat åtagande, avgifter utanför åtagandet och sänkt åtagande.
  - **F6:** NAV och avgifter vid utdelning med källskatt.
  - **F7:** IRR för hela portföljen.
  - **F8:** antal saknade rapporter och försening.
  - **F9:** låsning, attest av egen begäran och borttag via attesterad begäran.
- **Kodläsning:** F3, F4 och F10–F12.

---

# Runda 2 – granskning av rättelserna (efter `097f1bd`)

## Utfall
**ÅTGÄRDA FÖRST.** F1 och F9 är rättade och håller i alla prov. Migreringen bevarar data, kolumner och index och rullas tillbaka om något går fel. F2 är bara delvis rättad: per 30 juni, som är ett kvartalsslut, börjar "3 mån" fortfarande fel dag.

## Blockerande fynd
**B1 (Hög) – F2 är bara halvt rättad. Ett månadsslut ger fel startdag när asOf-månaden har färre dagar än målmånaden.**
- **Var:** `server/calc.ts`, `periodStarts` → `back()`. Dagnumret begränsas till målmånadens längd, men startdagen flyttas aldrig fram till målmånadens sista dag.
- **Exempel:**
  - 2026-06-30: "3 mån" = 03-30 och "1 mån" = 05-30
  - 2026-04-30: "1 mån" = 03-30
  - 2026-09-30 och 2026-11-30: "1 mån" = 08-30 respektive 10-30
  - 2026-02-28: "1 mån" = 01-28
  - 2024-02-29: "1 mån" = 01-29
  - 2025-02-28: "1 år" = 2024-02-28
- **Verifierat:** I en egen instans med kurs 100 per 03-30 och 110 per 03-31 till 06-30 gav "3 mån" per 2026-06-30 10 % i stället för 0 %. README lovar att perioden "vid månadsslut börjar på månadens sista dag".
- **Förslag:** Om asOf är sista dagen i sin månad används sista dagen i målmånaden. Annars används nuvarande begränsning. Lägg till enhetstest för 06-30 (3M = 03-31), 04-30 (1M = 03-31), 02-28 (1M = 01-31) och 2025-02-28 (1Y = 2024-02-29), och ett scenario per 2026-06-30.

## Ej blockerande fynd
1. **Låg:** `ALTER TABLE change_requests ADD COLUMN before_value` och ifyllnaden från `audit_log` körs utanför `BEGIN`/`COMMIT`. Lägg båda i samma transaktion.
2. **Låg:** En användarskapad vy på `transactions` stoppar starten med ett tekniskt fel. Återställningen fungerar, men felmeddelandet bör vara begripligt, och `PRAGMA foreign_key_check` bör köras före `COMMIT`.
3. **Låg:** `server/migrering.test.ts` bygger den "gamla" databasen ur dagens `schema.sql`. Använd det verkliga schemat från `main` som fixtur.

## Vad jag kontrollerade
- **Testkörningar:**
  - `npm test`: 188 av 188 godkända.
  - `npm run typecheck` och `npx vite build` går igenom.
  - Inga befintliga förväntade värden eller kontroller är ändrade.
  - Ändringen av indata i scenario 25 (105 000 varav avgift 5 000) är rimlig.
  - Scenario 24–26 föll mot `097f1bd`, så de prövar verkligen rättelserna.
- **F1:**
  - Granskningens fall ger 10,00 % (tidigare 0,91 %).
  - Inflöde på seriens första dag, inflöde dagen efter ett annat inflöde (16,83 %), försäljning, inflöde på helgdag, och försäljning och köp samma dag ger alla rätt resultat, både totalt och per tillgångsslag.
- **F9, migreringen:**
  - En databas skapad på `main` (med kolumner tillagda via ALTER, `document_id`, `result_ref` och ett borttag) gav identiska rader och värden efter migreringen, liksom `table_info`, index och främmande nycklar.
  - `integrity_check` gav ok och `foreign_key_check` var tom.
  - Migreringen är idempotent.
  - `sqlite_sequence` täcker det borttagna id:t.
  - `before_value` fylls i ur `audit_log`.
  - Ett nytt anrop ärver inte attest.
- **F2:** 12-31, 03-31, 05-31 och 05-15 är korrekta. Felen syns i B1.
