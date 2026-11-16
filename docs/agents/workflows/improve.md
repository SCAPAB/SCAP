# Workflow: improve (förbättring)

**Syfte:** hitta fel och brister ur en institutionell placerares perspektiv och bygga det som en människa godkänner.
**Starta:** `/improve [fokus]`

```mermaid
flowchart LR
    P["investor-qa<br/>testar som institutionell placerare<br/>fel → testscenarier"] -->|1-findings.md| S["tech-lead<br/>verifierar och föreslår"]
    S -->|2-proposal.md| H{"Människa<br/>godkänner vad som byggs<br/>+ stickprov av facit"}
    H -->|AVSLAG| X["Avslutas"]
    H -->|GODKÄND / DELVIS| I["implementer<br/>bygger på egen gren<br/>öppnar pull request"]
    I -->|3-delivery.md + PR| G["reviewer<br/>oberoende granskning av ändringen"]
    G -->|ÅTGÄRDA FÖRST| I
    G -->|4-review.md| M{"Människa<br/>slår ihop på GitHub<br/>när testerna är gröna"}
```

Här sparas varje omgång av flödet, så att det i efterhand går att se vem som föreslog, godkände, byggde, granskade och förde in vad.

| Fil | Skrivs av | Innehåll |
|---|---|---|
| `<datum>/1-findings.md` | Agenten **investor-qa** | Vad som testades, kontrollresultat, fel och behov. Varje fel blir också ett scenario i `tests/scenarios/` |
| `<datum>/2-proposal.md` | Agenten **tech-lead** | Prioriterade förslag med lösning, acceptanskriterier och stickprov, plus beslutsavsnitt |
| *(beslut 1)* | **Människa** | Godkänner förslag (`[x] Godkänn`, status, namn, datum). Commit:as på `main` innan bygget |
| `<datum>/3-delivery.md` | Agenten **implementer** | Vad som byggdes, hur det verifierats, gren, commits och pull request |
| `<datum>/4-review.md` | Agenten **reviewer** | Oberoende granskning av ändringen: utfall, blockerande och ej blockerande fynd |
| *(beslut 2)* | **Människa** | Slår ihop pull requesten på GitHub |

## Kontroller som inte bygger på att agenterna lyder
| Kontroll | Var | Vad den stoppar |
|---|---|---|
| Guardrails | `.claude/hooks/guardrails.mjs` (körs före varje verktygsanrop) | Push till `main`, sammanslagning eller godkännande av pull requests, ändrat grenskydd, ändringar i den riktiga datan, agenter som fyller i eller ändrar beslutet, agenter som ändrar spärrarna |
| Beslutskontroll | GitHub, jobbet `approval-check` | Pull request från `improve/<datum>` utan mänskligt beslut på `main`, med commits för förslag som inte är godkända eller med ändrat beslut |
| Tester | GitHub, jobbet `test` | Fel i beräkningar, scenarier, typer och bygge |
| Grenskydd | GitHub, inställning för `main` | Ändringar i `main` utan pull request och gröna kontroller |
