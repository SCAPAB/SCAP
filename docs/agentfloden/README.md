# Agentflöden

Ett agentflöde är en kedja av agenter med tydliga överlämningar och mänskliga beslut där det behövs. Alla flöden följer de gemensamma reglerna i [REGLER.md](REGLER.md).

| Flöde | Syfte | Starta | Steg |
|---|---|---|---|
| [Förbättring](forbattring/) | Hitta fel och brister ur en institutionell placerares perspektiv och bygga det som godkänns | `/forbattring [fokus]` | placerare → senior-utvecklare → **Människa** → implementerare |

## Agenter
Agenterna finns i `.claude/agents/` och kan återanvändas i flera flöden.

| Agent | Roll | Ändrar kod |
|---|---|---|
| `placerare` | Arbetar i systemet som en institutionell placerare, kontrollerar siffror och beskriver behov | Nej |
| `senior-utvecklare` | Verifierar fynd och skriver prioriterade förslag med beslutsavsnitt | Nej |
| `implementerare` | Bygger det som en människa har godkänt | Ja, på egen gren |
| `granskare` | Fristående helhetsgranskning | Nej |

## Skapa ett nytt flöde
Kör `/nytt-agentflode` i Claude Code och beskriv vad flödet ska åstadkomma. Claude föreslår steg, agenter och var människan ska besluta, och skapar filerna först när du har godkänt upplägget. Mallen finns i [MALL.md](MALL.md).
