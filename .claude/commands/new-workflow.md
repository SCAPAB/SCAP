---
description: Skapa ett nytt agentflöde (agenter, kommando och dokumentation) enligt projektets mall.
argument-hint: [vad flödet ska åstadkomma]
---

Hjälp användaren att skapa ett nytt agentflöde för Innehav. Önskemål: "$ARGUMENTS"

1. Läs `docs/agents/README.md`, `docs/agents/RULES.md`, `docs/agents/TEMPLATE.md` och de befintliga agenterna i `.claude/agents/`.
2. Om önskemålet är oklart, ställ högst tre korta frågor: vad flödet ska leverera, vem som ska besluta och när, och om något ska ändras (kod, data) eller bara bedömas.
3. Föreslå ett upplägg:
   - flödets namn (kort, svenska, utan å/ä/ö i fil- och kommandonamn)
   - stegen i ordning, med agent, vad varje agent gör och vilken fil den lämnar
   - var människan beslutar (alltid före steg som ändrar kod eller data, och genom en pull request innan något når `main`)
   - vilka befintliga agenter som återanvänds och vilka nya som behövs
   - ett mermaid-diagram
4. Vänta på att användaren uttryckligen godkänner upplägget. Skapa inga filer innan dess.
5. Skapa sedan, enligt `TEMPLATE.md` (inklusive avsnittet *Om flödet ändrar kod* om flödet bygger något):
   - nya agenter i `.claude/agents/`
   - kommandot `.claude/commands/<workflow>.md`
   - `docs/agents/workflows/<workflow>.md`
   - en ny rad i flödestabellen i `docs/agents/README.md`
   Uppdatera också agenttabellen om nya agenter tillkommer.
6. Commit:a med ett svenskt meddelande och berätta hur flödet startas. Nya agenter och kommandon laddas när en ny Claude Code-session startar.
