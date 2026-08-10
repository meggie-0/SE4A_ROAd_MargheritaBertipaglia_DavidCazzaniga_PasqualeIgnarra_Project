---
description: Esegue la verifica completa e riporta lo stato di salute del progetto
allowed-tools: Bash, Read, Grep
---

Esegui `pnpm verify` e riporta il risultato.

Se fallisce: individua la causa reale, non il sintomo. In particolare, prima di modificare il codice
di dominio chiediti se il test che fallisce è instabile per una violazione della Regola 3 di
`CLAUDE.md` (uso di `new Date()`, `Math.random()`, timer reali). In quel caso il problema è il
determinismo, non la logica.

Non disabilitare test, non aggiungere `.skip`, non allentare le regole di lint o di architettura per
far passare la verifica.

Al termine riporta in modo compatto: quale passo è fallito, perché, e cosa proponi di fare.
