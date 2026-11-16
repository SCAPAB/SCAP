# Agentflöden

Ett agentflöde är en kedja av agenter med tydliga överlämningar och mänskliga beslut där det behövs. Alla flöden följer de gemensamma reglerna i [RULES.md](RULES.md).

| Flöde | Syfte | Starta | Steg |
|---|---|---|---|
| [improve](workflows/improve.md) | Hitta fel och brister ur en institutionell placerares perspektiv och bygga det som godkänns | `/improve [fokus]` | investor-qa → tech-lead → **Människa** → implementer → reviewer → **Människa** (pull request) |

## Struktur och namngivning
Namn och sökvägar är på engelska enligt vanlig konvention. Innehållet i dokumenten är på svenska.

```
.claude/
  agents/<role>.md            en agent per roll: investor-qa, tech-lead, implementer, reviewer
  commands/<workflow>.md      ett kommando per flöde: /improve, /new-workflow
  hooks/guardrails.mjs        tekniska spärrar (körs före varje verktygsanrop)
  settings.json               kopplar in spärrarna
docs/agents/
  README.md                   den här katalogen
  RULES.md                    gemensamma regler för alla agenter
  TEMPLATE.md                 mall för nya flöden
  workflows/<workflow>.md     beskrivning av varje flöde
  runs/<workflow>/<ÅÅÅÅ-MM-DD>/  en mapp per körning:
    1-findings.md  2-proposal.md  3-delivery.md  4-review.md
scripts/check-approval.mjs    beslutskontrollen på GitHub
.github/workflows/ci.yml      jobben test och approval-check
```

| Sak | Konvention | Exempel |
|---|---|---|
| Agent | Roll som substantiv, kebab-case | `investor-qa`, `tech-lead`, `reviewer` |
| Flöde och kommando | Verb eller kort substantiv, kebab-case | `improve`, `new-workflow` |
| Gren för en körning | `<workflow>/<ÅÅÅÅ-MM-DD>` | `improve/2026-11-15` |
| Fil i en körning | `<steg>-<artefakt>.md`, döpt efter vad filen innehåller, inte efter agenten | `2-proposal.md` |
| Förslags-id och commits | `F<n>`, commit-rubrik `F<n>: …` | `F3: valutakurs från senare datum används aldrig` |

## Agenter
Agenterna finns i `.claude/agents/` och kan återanvändas i flera flöden.

| Agent | Roll | Ändrar kod |
|---|---|---|
| `investor-qa` | Arbetar i systemet som en institutionell placerare, kontrollerar siffror och beskriver behov | Nej |
| `tech-lead` | Verifierar fynd och skriver prioriterade förslag med beslutsavsnitt | Nej |
| `implementer` | Bygger det som en människa har godkänt och öppnar en pull request | Ja, på egen gren |
| `reviewer` | Oberoende granskning av en leverans, eller fristående helhetsgranskning | Nej |

## Så hålls flödena säkra
Alla flöden följer samma principer, som brukar räknas som god praxis för agentflöden:

1. **Människan beslutar två gånger:** vad som ska byggas (innan) och om det byggda får gå in i `main` (efter, i en pull request).
2. **Den som bygger granskar inte sitt eget arbete.** En separat agent granskar ändringen, och testerna körs av GitHub, inte av agenten själv.
3. **Testerna är kontraktet.** Fel blir först körbara scenarier med handräknade värden, och förväntade värden ändras aldrig för att testerna ska bli gröna.
4. **Tekniska spärrar, inte bara instruktioner.** Det viktigaste spärras i kod: guardrails-hooken i Claude Code, beslutskontrollen och grenskyddet på GitHub. Se tabellen i [workflows/improve.md](workflows/improve.md#kontroller-som-inte-bygger-på-att-agenterna-lyder).
5. **Minsta behörighet.** Agenter som bedömer kan inte ändra kod. Den som bygger arbetar bara på en egen gren.
6. **Allt är spårbart i git:** rapport, förslag, beslut, leverans och granskning ligger som filer per omgång.
7. **Lagom stora omgångar och kostnadstak.** Ett fokus per körning, några få förslag per pull request och `maxTurns` för varje agent.

## Skapa ett nytt flöde
Kör `/new-workflow` i Claude Code och beskriv vad flödet ska åstadkomma. Claude föreslår steg, agenter och var människan ska besluta, och skapar filerna först när du har godkänt upplägget. Mallen finns i [TEMPLATE.md](TEMPLATE.md).
