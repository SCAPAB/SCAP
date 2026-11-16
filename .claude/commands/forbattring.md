---
description: Agentflödet Förbättring – placerare testar, senior utvecklare föreslår, människa godkänner, implementerare bygger, granskare granskar, människa för in i main.
argument-hint: [fokus för placeraren, t.ex. "private equity och kapitalanrop"]
---

Kör agentflödet **Förbättring** för Innehav i den här ordningen. Följ `docs/agentfloden/REGLER.md`. Hoppa aldrig över ett mänskligt beslut. Spärrarna i `.claude/hooks/agentvakt.mjs` och beslutskontrollen på GitHub gäller hela vägen.

Datum `<datum>` är dagens datum när flödet startar (ÅÅÅÅ-MM-DD) och används i alla filnamn och i grenen.

1. **Placerare.** Starta agenten `placerare` med fokus: "$ARGUMENTS". Inget fokus betyder hela systemet. Säg då till användaren att en körning utan fokus tar längre tid och kostar mer, och att ett fokus ger en mindre och mer hanterbar omgång. Vänta tills `docs/agentfloden/forbattring/<datum>-1-placerare.md` finns. Visa en kort sammanfattning. Commit:a rapporten och nya scenarier på `main`, eller via en gren och pull request om `main` är skyddad.

2. **Senior utvecklare.** Starta agenten `senior-utvecklare` med placerarens rapport. Vänta tills `docs/agentfloden/forbattring/<datum>-2-forslag.md` finns. Commit:a den på samma sätt.

3. **Människans beslut om vad som ska byggas.**
   - Presentera förslagen (id, rubrik, prioritet, storlek och en mening om nyttan) och vilka den senior utvecklaren rekommenderar för den här omgången.
   - Visa stickproven: de förväntade värden med uträkning som ska kontrolleras. Be användaren titta på dem, eftersom även facit är framtaget av en agent.
   - Fråga vilka förslag som godkänns. Fyll i *Beslut* först **efter** ett uttryckligt svar: `Status: GODKÄND` eller `DELVIS GODKÄND`, användarens namn i `Godkänd av`, dagens datum, `[x]` för godkända förslag och eventuell kommentar. Godkänns inget sätts `Status: AVSLAG` och flödet avslutas.
   - Gissa aldrig ett godkännande och tolka aldrig tystnad som ja. Bara huvudsessionen får fylla i beslutet. Agenterna stoppas av spärren.
   - Commit:a beslutet på `main` **innan** bygget börjar. Beslutskontrollen på GitHub underkänner en pull request där beslutet ändras.

4. **Implementerare.** Starta agenten `implementerare` med förslagsfilen. Den bygger på grenen `forbattring/<datum>`, skriver `<datum>-3-leverans.md`, pushar grenen och öppnar en pull request mot `main`. Vänta på länken.

5. **Granskare.** Starta agenten `granskare` för att granska grenen `forbattring/<datum>` enligt avsnittet *Granskning av en leverans* i dess instruktion. Den skriver `<datum>-4-granskning.md`. Commit:a och pusha den till grenen. Är utfallet `ÅTGÄRDA FÖRST`: låt `implementerare` rätta de blockerande fynden och låt sedan `granskare` kontrollera rättelserna. Gör högst två rundor. Därefter avgör människan.

6. **Människans beslut om sammanslagning.**
   - Sammanfatta vad som byggdes, granskningens utfall, testresultatet på GitHub och vad som återstår.
   - Ge länken till pull requesten. Människan granskar och slår ihop den på GitHub.
   - Agenter slår aldrig ihop, godkänner eller stänger pull requests.
