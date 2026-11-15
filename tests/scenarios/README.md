# Testscenarier

Varje fil beskriver en affärshändelse från början till slut, med **handräknade förväntade värden**. Scenarierna körs automatiskt med `npm test`. Varje scenario körs mot en egen, tom instans av programmet med tillfällig databas, så den riktiga datan berörs aldrig.

## Format

```json
{
  "namn": "Kort namn på scenariot",
  "beskrivning": "Vad som händer och hur de förväntade värdena är uträknade",
  "datum": "2026-06-30",
  "steg": [
    { "anrop": "POST /api/instruments", "data": { "type": "EQUITY", "name": "Testbolaget", "currency": "SEK" }, "spara": "aktie" },
    { "anrop": "POST /api/transactions", "data": { "entity_id": 1, "instrument_id": "{{aktie}}", "type": "BUY", "trade_date": "2026-01-10", "quantity": 100, "price": 100, "amount": 10000 } },
    { "beskrivning": "Felaktig post stoppas", "anrop": "POST /api/transactions", "data": { }, "forvantadStatus": 400, "felInnehaller": "…" }
  ],
  "kontroller": [
    { "namn": "Marknadsvärde", "hamta": "GET /api/instruments/{{aktie}}?asOf={{datum}}", "falt": "total.mvBase", "forvantat": 15000, "tolerans": 0.01 }
  ]
}
```

| Fält | Betydelse |
|---|---|
| `steg[].anrop` | HTTP-metod och sökväg i API:et |
| `steg[].spara` | Sparar svarets `id` under ett alias som kan användas som `{{alias}}` |
| `steg[].forvantadStatus` / `felInnehaller` | Används för steg som ska stoppas, med förväntad HTTP-status och text i felmeddelandet |
| `kontroller[].falt` | Fält i svaret med punktnotation och filter, t.ex. `total.nav`, `rows[key=PUBLIC_EQUITY].value`, `proposals[0].canApprove` |
| `kontroller[].forvantat` | Förväntat värde. Tal jämförs med `tolerans` (standard 0,01) |
| `kontroller[].innehaller` | Svaret ska innehålla texten |
| `kontroller[].arTal` | Värdet ska vara ett giltigt tal |
| `kantFel` | Märker steg eller kontroller som visar ett **känt fel** som inte är åtgärdat. De körs och redovisas som TODO men stoppar inte testkörningen. Ta bort märkningen när felet är rättat. |

## Regler för nya scenarier
- Räkna ut förväntade värden **för hand** och visa uträkningen i `beskrivning`. Läs inte beräkningskoden för att ta fram dem.
- Ett scenario = en affärshändelse. Hellre många små än ett stort.
- Varje fel som hittas (av en människa eller en agent) läggs till som scenario med `kantFel`. Då kan felet aldrig komma tillbaka obemärkt.
- Använd fasta datum och fiktiva namn.
