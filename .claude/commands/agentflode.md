---
description: Kör agentflödet – placerare testar, senior utvecklare föreslår, människa godkänner, implementerare bygger.
argument-hint: [fokus för placeraren, t.ex. "private equity och kapitalanrop"]
---

Kör agentflödet för Innehav i den här ordningen. Hoppa aldrig över godkännandet.

1. **Placerare.** Starta agenten `placerare` med fokus: "$ARGUMENTS" (inget fokus = hela systemet). Vänta tills rapporten `docs/agentflode/<datum>-1-placerare.md` finns. Visa användaren en kort sammanfattning.
2. **Senior utvecklare.** Starta agenten `senior-utvecklare` med placerarens rapport. Vänta tills `docs/agentflode/<datum>-2-forslag.md` finns.
3. **Människans beslut.** Presentera förslagen för användaren (id, rubrik, prioritet, storlek och en mening om nyttan) och fråga vilka som ska godkännas.
   - Fyll i *Beslut* i förslagsfilen först **efter** att användaren uttryckligen har svarat: `Status: GODKÄND` eller `DELVIS GODKÄND`, användarens namn i `Godkänd av`, dagens datum, `[x]` för godkända förslag och användarens eventuella kommentar.
   - Godkänner användaren inget, sätt `Status: AVSLAG` och avsluta.
   - Gissa aldrig ett godkännande och tolka aldrig tystnad som ja.
4. **Implementerare.** Starta agenten `implementerare` med förslagsfilen. Vänta på leveransen `docs/agentflode/<datum>-3-leverans.md`.
5. **Avslut.** Sammanfatta för användaren vad som byggdes, på vilken gren och vad som återstår. Fråga om grenen ska föras in i `main`.

Commit:a rapporterna i `docs/agentflode/` så att beslutskedjan är spårbar.
