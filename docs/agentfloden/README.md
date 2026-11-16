# Agentflöden

Ett agentflöde är en kedja av agenter med tydliga överlämningar och mänskliga beslut där det behövs. Alla flöden följer de gemensamma reglerna i [REGLER.md](REGLER.md).

| Flöde | Syfte | Starta | Steg |
|---|---|---|---|
| [Förbättring](forbattring/) | Hitta fel och brister ur en institutionell placerares perspektiv och bygga det som godkänns | `/forbattring [fokus]` | placerare → senior-utvecklare → **Människa** → implementerare → granskare → **Människa** (pull request) |

## Agenter
Agenterna finns i `.claude/agents/` och kan återanvändas i flera flöden.

| Agent | Roll | Ändrar kod |
|---|---|---|
| `placerare` | Arbetar i systemet som en institutionell placerare, kontrollerar siffror och beskriver behov | Nej |
| `senior-utvecklare` | Verifierar fynd och skriver prioriterade förslag med beslutsavsnitt | Nej |
| `implementerare` | Bygger det som en människa har godkänt och öppnar en pull request | Ja, på egen gren |
| `granskare` | Oberoende granskning av en leverans, eller fristående helhetsgranskning | Nej |

## Så hålls flödena säkra
Alla flöden följer samma principer, som brukar räknas som god praxis för agentflöden:

1. **Människan beslutar två gånger:** vad som ska byggas (innan) och om det byggda får gå in i `main` (efter, i en pull request).
2. **Den som bygger granskar inte sitt eget arbete.** En separat agent granskar ändringen, och testerna körs av GitHub, inte av agenten själv.
3. **Testerna är kontraktet.** Fel blir först körbara scenarier med handräknade värden, och förväntade värden ändras aldrig för att testerna ska bli gröna.
4. **Tekniska spärrar, inte bara instruktioner.** Det viktigaste spärras i kod: agentvakten i Claude Code, beslutskontrollen och grenskyddet på GitHub. Se tabellen i [forbattring/README.md](forbattring/README.md#kontroller-som-inte-bygger-på-att-agenterna-lyder).
5. **Minsta behörighet.** Agenter som bedömer kan inte ändra kod. Den som bygger arbetar bara på en egen gren.
6. **Allt är spårbart i git:** rapport, förslag, beslut, leverans och granskning ligger som filer per omgång.
7. **Lagom stora omgångar och kostnadstak.** Ett fokus per körning, några få förslag per pull request och `maxTurns` för varje agent.

## Skapa ett nytt flöde
Kör `/nytt-agentflode` i Claude Code och beskriv vad flödet ska åstadkomma. Claude föreslår steg, agenter och var människan ska besluta, och skapar filerna först när du har godkänt upplägget. Mallen finns i [MALL.md](MALL.md).
