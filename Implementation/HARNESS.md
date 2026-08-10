# ROAd — harness di verifica

Questo documento specifica come si verifica il lavoro. È rivolto sia a Claude Code (che deve
costruire l'harness in M0 e usarlo sempre) sia al team.

## Principio

Un agente lavora bene quanto è buono il suo ciclo di feedback. L'harness esiste per rispondere in
pochi minuti a una domanda sola: **il progetto è sano?** Tutto ciò che conta deve essere dentro
quella risposta, altrimenti non conta davvero.

---

## 1. `pnpm verify` — il controllo principale

Composizione, nell'ordine (fallisce al primo errore, dal più veloce al più lento):

| # | Passo | Comando | Cosa protegge |
|---|---|---|---|
| 1 | Tipi | `tsc --noEmit` su tutti i workspace, strict | Errori grossolani, niente `any` |
| 2 | Lint | `eslint` + regole custom di determinismo | Regola 3 di CLAUDE.md |
| 3 | Architettura | `depcruise` con `.dependency-cruiser.cjs` | Confini fra moduli, Regola 1 |
| 4 | Contratto | rigenera OpenAPI e diff con `contracts/openapi.json` | Intercambiabilità del frontend |
| 5 | Unit | `jest --selectProjects unit` | Logica di dominio |
| 6 | Integrazione | `jest --selectProjects integration` su Postgres Testcontainers | Persistenza, concorrenza, catene fra moduli |

Obiettivo di durata: sotto i 3 minuti. Se cresce oltre, si sposta qualcosa in `verify:e2e`.

`pnpm verify:e2e` è separato: alza lo stack con Docker Compose e guida i due client con Playwright,
inclusi screenshot che possono essere riletti per controllare il risultato visivo. Gira a fine
milestone e in CI sul branch `main`.

### Regola d'oro

La CI di GitHub Actions esegue **esattamente** `pnpm verify`, non una lista parallela di comandi. Se
è verde in locale dev'essere verde in CI. Ogni divergenza fra i due è un bug dell'harness.

---

## 2. Determinismo

Senza questo, i test su tempo e casualità diventano instabili e l'harness perde credibilità.

**`ClockPort`** in `src/platform/clock.port.ts`. Implementazione di produzione: orologio di sistema.
Implementazione di test: `FakeClock` con `setNow()` e `advance(duration)`.

**`RandomPort`** in `src/platform/random.port.ts`. Produzione: PRNG con seed da configurazione.
Test: sequenza fissa.

**Scheduler.** `RebalancingScheduler` e il ciclo del simulatore espongono `runOnce()` pubblico. In
produzione lo chiama `@Cron`; nei test lo chiamano i test. Nessun `setInterval` nel dominio.

**Database.** Ogni test di integrazione parte da un container Postgres pulito con migrazioni
applicate e seed a valori fissi. Nessun test dipende dall'ordine di esecuzione degli altri.

**Regola di lint.** `no-restricted-syntax` blocca `new Date()`, `Date.now()`, `Math.random()`,
`setTimeout`, `setInterval` ovunque tranne `src/platform/**` e i file di configurazione.

---

## 3. Confini fra moduli

`.dependency-cruiser.cjs` codifica le regole di CLAUDE.md §Regola 1:

Attenzione a due dettagli, perché la regola è facile da scrivere in modo che *sembri* funzionare:
dependency-cruiser interpola dentro `to` solo i gruppi catturati in `from`, e li interpola con il
**numero** del gruppo (`$1`), non con il nome. La forma nominata `$<mod>` non viene sostituita —
verificato su dependency-cruiser 17.4.3, e sbaglia nel modo peggiore: la regola non riconosce più
gli import interni a un modulo e segnala come violazione ogni file che importa un proprio vicino,
sembrando severissima mentre è soltanto rotta. Le eccezioni ammesse sono **tutti** i `*.port.ts`
alla radice del modulo — al plurale, perché `platform` espone `clock.port.ts` e `random.port.ts` —
più il `*.module.ts`, che serve agli `imports` di Nest.

```js
forbidden: [
  {
    name: 'no-cross-module-internals',
    comment: 'Un modulo è raggiungibile solo dalle sue porte.',
    severity: 'error',
    from: { path: '^apps/api/src/([^/]+)/' },
    to: {
      path: '^apps/api/src/[^/]+/',
      pathNot: [
        '^apps/api/src/$1/',                        // dentro lo stesso modulo: libero
        '^apps/api/src/[^/]+/[^/]+\\.port\\.ts$',   // le porte
        '^apps/api/src/[^/]+/[^/]+\\.module\\.ts$', // i moduli Nest
      ],
    },
  },
  { name: 'no-circular', severity: 'error', from: {}, to: { circular: true } },
  {
    name: 'shared-is-a-leaf',
    severity: 'error',
    from: { path: '^packages/shared/' },
    to: { path: '^apps/' },
  },
  {
    name: 'frontend-never-imports-backend',
    severity: 'error',
    from: { path: '^apps/(web|passenger)/' },
    to: { path: '^apps/api/' },
  },
]
```

Un test aggiuntivo (`test/arch/exports.spec.ts`) analizza i file `*.module.ts` e fallisce se un
array `exports` contiene una classe il cui nome non finisce in `Port`.

---

## 4. Contratto API e intercambiabilità del frontend

Il backend genera `contracts/openapi.json` dai decoratori Nest tramite `@nestjs/swagger`. Il file è
**committato**. `pnpm contract` lo rigenera e fallisce se differisce da quello in repo.

Effetto: nessuna modifica all'API può passare inosservata. Se è voluta, va committata insieme al
codice e compare nel diff della PR, dove il team la vede. Se non è voluta, la build si ferma.

I tipi condivisi in `packages/shared` sono la sorgente unica di verità per DTO ed enum. Chi volesse
riscrivere la dashboard in un altro framework parte da `contracts/openapi.json` e non ha bisogno di
leggere una riga di NestJS. Questo è ciò che rende il frontend sostituibile, e va verificato da un
test end-to-end che usa **solo** l'HTTP pubblico, senza importare nulla dal backend.

---

## 5. Tracciabilità eseguibile

`docs/requirements.json` elenca R1–R14, NFR1–NFR10, G1–G10 con titolo e milestone di competenza —
**34 voci**, goal compresi. I goal si coprono attraverso i test dei requisiti che li realizzano: un
test può portare più tag, `describe('[G2][R3] ...')`.

Gli NFR hanno una formulazione operativa falsificabile in DD §4.3. Vale la pena rileggerla prima di
scrivere il test: senza, requisiti come NFR3 o NFR8 finiscono coperti da test che non asseriscono
nulla, che è esattamente ciò contro cui mette in guardia il §9 qui sotto.

I titoli dei `describe` portano i tag: `describe('[R4][NFR4] Advance booking', ...)`.

`pnpm trace` produce:

```
REQUISITO  TITOLO                              MILESTONE  TEST
R1         Registration and Login              M1b        4
R4         Advance Booking                     M4         11
R14        Ride Cancellation                   M4         3
NFR9       Stability of Auto-Switching         M6         3
G2         Request an immediate robotaxi ride  M4         6
...
Copertura milestone completate: 34/34 ✓
```

Fallisce se un requisito assegnato a una milestone già completata ha zero test. L'output serve
anche come base per la tabella di tracciabilità del DD §4.

---

## 6. Cancelli di milestone

Ogni milestone ha un file `apps/api/test/gates/<M>.gate.spec.ts` che traduce il suo criterio di
completamento in test eseguibili. `pnpm gate M3` esegue solo quello.

Regola: **non si passa alla milestone successiva finché il cancello della precedente non è verde**,
e i cancelli già passati non tornano mai rossi (girano tutti dentro `pnpm verify`).

| Cancello | Cosa deve dimostrare |
|---|---|
| M0 | `pnpm verify` esiste e passa; CI verde; l'API risponde su `/health` e i due client rispondono su `/` mostrandone lo stato |
| M1 | Due transazioni concorrenti che prenotano lo stesso veicolo su intervalli sovrapposti: esattamente una riesce, l'altra fallisce per violazione del vincolo di esclusione |
| M1b | Registrazione e login funzionano; un token `PASSENGER` riceve 403 sugli endpoint operatore e viceversa; un token emesso da un'istanza è accettato da una seconda che non ha visto il login (NFR3) |
| M2 | Tutte le transizioni legali della FSM a sette stati del **DD §2.6.3, Figura 2.10** riescono; **tutte** quelle illegali sollevano `IllegalTransitionError`; lo stato sopravvive a un giro di persistenza e ricostruzione |
| M3 | Per ciascuna strategia: flotta vuota → nessuna assegnazione; un solo candidato idoneo → quello; più candidati → il corretto secondo la metrica; valori di frontiera su distanza ed ETA a parità di punteggio risolti in modo deterministico |
| M4 | Catena richiesta → allocazione → assegnazione completa; prenotazione anticipata scrive booking e reservation nella stessa transazione; l'annullamento (R14) rilascia la riserva e riporta il veicolo ad `available`; `AdvanceBookingActivator.runOnce()` attiva una prenotazione dovuta e ne ri-alloca una il cui veicolo non è più idoneo |
| M5 | Un passeggero connesso riceve `assigned → arriving → arrived → in_ride` per la propria corsa e **nessun** evento di corse altrui; un operatore riceve gli eventi di flotta |
| M6 | Sequenza traffico Low→Medium→High→Medium→Low: alert su Medium senza cambio, switch a MinimumETA su High, ritorno a NearestAvailable **solo** all'ultimo Low. In Manual mode nessuno switch automatico avviene fino a `enableAuto()` esplicito, che rivaluta subito l'ultimo livello noto. `analyzeDemand()` su un dataset noto restituisce le zone attese nell'ordine atteso |
| M7 | Con adapter reali configurati, il sistema funziona senza mock; se OSRM è irraggiungibile il fallback lineare produce comunque un ETA e il sistema non si blocca |
| M8 | Playwright: un passeggero richiede una corsa e vede lo stato aggiornarsi fino a `in_ride`; un operatore cambia strategia e vede la dashboard passare a Manual |
| M9 | I quattro scenari del RASD end-to-end; test di concorrenza sull'ultimo veicolo disponibile; `pnpm trace` senza requisiti scoperti |

---

## 7. Hook e automatismi

Configurati in `.claude/settings.json`.

**Dopo ogni modifica a un file TypeScript** parte ESLint su quel file. Se restano errori, vengono
riportati subito invece di accumularsi.

**Prima di ogni `git push`** l'hook rifiuta se il branch corrente è `main` ed esegue `pnpm verify`,
bloccando il push se rosso. Non è possibile spingere lavoro rotto.

**Alla fine di ogni turno** parte `pnpm verify`. Se fallisce, la sessione non si chiude e l'errore
viene rimandato indietro perché venga corretto. Questo impedisce il fallimento più comune, cioè
dichiarare fatto qualcosa che non compila.

`gh pr merge` e `git push --force` sono vietati dalla configurazione dei permessi.

Gli hook non bloccano finché `node_modules` non esiste, quindi non intralciano il primo setup. Se
l'hook di fine turno rallenta troppo le sessioni esplorative, si può alleggerire sostituendo
`pnpm verify` con `pnpm typecheck && pnpm test:unit` dentro `.claude/hooks/stop-verify.mjs`,
lasciando la verifica completa all'hook di pre-push, che è quello che conta davvero.

---

## 8. CI

`.github/workflows/ci.yml`, su ogni push e ogni pull request:

```
setup node + pnpm → pnpm install --frozen-lockfile → pnpm verify
```

Su `main` si aggiunge `pnpm verify:e2e` e il deploy. Un solo job, gli stessi comandi del locale.

---

## 9. Cosa NON deve fare l'harness

Non deve misurare la copertura come obiettivo a sé: una percentuale alta con test che non asseriscono
nulla è peggio di pochi test buoni. La soglia (70% su `allocation`, `fleet`, `persistence`) serve
solo da allarme, non da traguardo.

Non deve testare i dettagli di implementazione interni ai moduli: i test attraversano le porte, così
riscrivere un modulo non costringe a riscriverne i test. È questa la prova che i moduli sono davvero
intercambiabili.
