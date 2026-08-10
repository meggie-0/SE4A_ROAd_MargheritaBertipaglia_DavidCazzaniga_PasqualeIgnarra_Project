---
description: Implementa e verifica una milestone di ROAd dall'inizio alla pull request
argument-hint: "<milestone> (es. M3)"
allowed-tools: Read, Write, Edit, Glob, Grep, Bash, TodoWrite
---

Implementa la milestone **$1** del progetto ROAd.

Procedi in quest'ordine, senza saltare passaggi:

1. Leggi `CLAUDE.md` e la sezione di **$1** in `MILESTONES.md`. Se qualcosa è ambiguo o in
   contraddizione con il DD, fermati e chiedi invece di decidere da solo.
2. Verifica che il cancello della milestone precedente sia verde (`pnpm gate <precedente>`). Se non
   lo è, non iniziare: segnalalo.
3. Crea il branch: `git switch -c feat/$1-<slug>`.
4. Definisci prima le **porte** dei moduli coinvolti, poi le implementazioni. Nessun import che
   attraversi i confini fra moduli.
5. Scrivi i test insieme al codice, non dopo. Ogni `describe` che copre un requisito porta il tag
   nel titolo, es. `describe('[R5][NFR7] ...')`.
6. Esegui `pnpm verify` di continuo, non solo alla fine.
7. Scrivi il cancello in `apps/api/test/gates/$1.gate.spec.ts` traducendo in test il criterio di
   completamento di `MILESTONES.md`. Deve fallire se la milestone non è davvero finita.
8. Quando `pnpm verify`, `pnpm gate $1` e `pnpm trace` sono verdi, apri la pull request con
   `gh pr create`, con un corpo che elenca: cosa è stato implementato, i requisiti coperti, come si
   verifica, e ogni decisione presa che non era già scritta nei documenti.
9. **Fermati.** Il merge lo fa il team.

Se durante il lavoro emerge che il DD è impreciso o incompleto, non aggirarlo silenziosamente:
segnalalo nel corpo della PR e proponi la modifica al documento.
