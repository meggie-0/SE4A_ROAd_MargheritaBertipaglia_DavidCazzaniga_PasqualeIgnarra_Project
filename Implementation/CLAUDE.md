# ROAd — istruzioni permanenti di progetto

Leggi questo file per intero prima di toccare qualsiasi cosa. Le regole qui dentro non sono
preferenze stilistiche: sono invarianti verificate da `pnpm verify`, e violarle fa fallire la build.

## Cos'è ROAd

Sistema di gestione di una flotta di robotaxi a Milano. I passeggeri richiedono corse immediate o
prenotate; il sistema assegna il veicolo secondo una strategia di allocazione che l'operatore di
flotta può cambiare a runtime; traccia il ciclo di vita di ogni veicolo, notifica i passeggeri e
riposiziona proattivamente i veicoli inattivi verso le zone di domanda prevista.

Progetto universitario (Politecnico di Milano, Software Engineering for Automation). L'obiettivo
non è un prodotto: è un prototipo *stabile e coerente con i documenti di progetto*. Le linee guida
del corso dicono testualmente di privilegiare stabilità e qualità del codice rispetto alla quantità
di funzionalità. Comportati di conseguenza: mai aggiungere feature non richieste, mai "migliorare"
il design divergendo dal DD.

## Documenti autorevoli

| Documento | Percorso | Ruolo |
|---|---|---|
| RASD | `docs/RASD.md` (originale in `../RASD/`) | Requisiti R1–R13, NFR1–NFR10, goal G1–G10 |
| DD | `docs/DD.md` (originale in `../DD/`) | Architettura, componenti, pattern, ordine di integrazione |
| Milestone | `MILESTONES.md` | Cosa implementare, in che ordine, con quale criterio di completamento |
| Harness | `HARNESS.md` | Come si verifica il lavoro |

**Il DD ha la precedenza sul tuo giudizio.** Se pensi che il design sia migliorabile, non
cambiarlo: fermati e segnalalo all'utente. Se una modifica al codice rende il DD falso, la modifica
va accompagnata dall'aggiornamento del DD nello stesso commit.

---

## Regola 1 — Confini fra moduli

Ogni componente del DD §2.2 è un modulo NestJS sotto `apps/api/src/`. **Un modulo è raggiungibile
solo attraverso la sua porta.** Nient'altro del suo contenuto è visibile da fuori.

Una porta è una classe astratta che dichiara le operazioni e funziona da token di iniezione:

```ts
// src/allocation/allocation.port.ts
export abstract class AllocationPort {
  abstract allocate(request: RideRequest, candidates: Robotaxi[]): Promise<Robotaxi | null>;
  abstract setActiveStrategy(name: StrategyName, source: 'auto' | 'manual'): Promise<void>;
  abstract getActiveStrategy(): Promise<StrategyName>;
}
```

```ts
// src/allocation/allocation.module.ts
// Nota: allocation NON importa FleetModule. I candidati glieli passa `rides`,
// come da DD §2.2.1. Aggiungere quell'arco è una divergenza dal DD.
@Module({
  imports: [ExternalModule, PersistenceModule, PlatformModule],
  providers: [
    NearestAvailableStrategy,
    MinimumEtaStrategy,
    { provide: AllocationPort, useClass: AllocationManager },
  ],
  exports: [AllocationPort],           // SOLO la porta
})
export class AllocationModule {}
```

Chi usa l'allocazione inietta `AllocationPort`, mai `AllocationManager`.

**Vincoli meccanici (verificati da `pnpm arch`):**

- Nessun file fuori da `src/<modulo>/` può importare da `src/<modulo>/` tranne i file
  `src/<modulo>/*.port.ts` (e i tipi da essi esposti) e `src/<modulo>/<modulo>.module.ts`. Il
  plurale è voluto: `platform` espone `clock.port.ts` e `random.port.ts`.
- L'array `exports` di un `@Module` può contenere solo classi il cui nome finisce in `Port`.
- Nessuna dipendenza circolare fra moduli.
- `apps/*` può importare da `packages/shared`. Mai il contrario.
- `apps/web` e `apps/passenger` non importano nulla da `apps/api`: parlano solo tramite il
  contratto HTTP in `contracts/openapi.json` e i tipi in `packages/shared`.

Il senso di tutto questo: un membro del team deve poter riscrivere da zero un singolo modulo — o
l'intero frontend — senza toccare nient'altro. Se stai per scrivere un import che attraversa un
confine, stai sbagliando qualcosa.

### Moduli e porte

| Modulo | Porta | Operazioni (DD §2.2) |
|---|---|---|
| `auth` | `AuthPort`, `access-control.port.ts` (`TokenVerifierPort`) | `register`, `authenticate`, `updateProfile`; `verify` |
| `rides` | `RideRequestPort`, `AdvanceBookingActivatorPort`, `RideLifecyclePort` | `submitImmediate`, `submitAdvance`, `cancel`; `runOnce`; `startPickupNavigation`, `pickupReached`, `startRide`, `completeRide` |
| `allocation` | `AllocationPort` | `allocate`, `setActiveStrategy`, `getActiveStrategy` |
| `mode` | `ModePort`, `traffic-monitor.port.ts` (`TrafficMonitorPort`) | `onTrafficLevel`, `setManual`, `enableAuto`, `getMode`; `runOnce` |
| `fleet` | `FleetMonitorPort`, `robotaxi.port.ts` | `getCandidates`, `getBookableRobotaxis`, `getAvailableRobotaxis`, `getFleetStatus`, `assign`, `startPickupNavigation`, `pickupReached`, `startRide`, `completeRide`, `releaseAssignment`, `requestRebalancing` |
| `rebalancing` | `RebalancingPort` | `analyzeDemand`, `rebalance` |
| `maintenance` | `MaintenancePort` | `requestMaintenance`, `completeMaintenance` |
| `notifications` | `NotificationPort`, `session.port.ts` (`NotificationSessionPort`) | `update`; `registerSession`, `removeSession`, `registeredSessions` |
| `persistence` | `PersistencePort` | `create`, `update`, `find`, `filterAvailable`, `reserve` |
| `external` | `ExternalServicesPort` | `getETA`, `getTraffic`; `getDemandData`, `commandRoute`, `readTelemetry` arrivano con M7 |
| `platform` | `ClockPort`, `RandomPort` | `now`, `next` |
| `gateway` | — | Controller REST e WebSocket. Importa solo porte. |

---

## Regola 2 — I pattern devono restare visibili

NestJS tende a nascondere i design pattern dietro la dependency injection. Qui i pattern sono
oggetto di valutazione: devono essere leggibili aprendo il codice, non deducibili dalla
configurazione.

**Strategy** — interfaccia `AllocationStrategy` con `selectRobotaxi(request, candidates)`, due classi
concrete `NearestAvailableStrategy` e `MinimumEtaStrategy`. `AllocationManager` è il contesto e
delega. Aggiungere una terza strategia deve richiedere solo una nuova classe più una riga di
registrazione (NFR7).

**State** — una classe per stato: `AvailableState`, `AssignedState`, `ArrivingState`,
`ArrivedState`, `InRideState`, `RebalancingState`, `MaintenanceState`. Sono **sette**: la macchina
autorevole è quella del **DD §2.6.3, Figura 2.10**, non quella a sei stati del RASD §3.2. Ogni
classe espone i propri metodi di transizione e solleva `IllegalTransitionError` per quelle non
ammesse (NFR5). Lo stato si persiste come colonna enum e l'oggetto si ricostruisce via
`RobotaxiStateFactory`. **Vietato** implementare la macchina a stati con `switch` sparsi nei service.

**Observer** — `Robotaxi` e `Ride` implementano `Subject`; `NotificationManager` è l'unico observer
registrato su di loro e implementa `update(event)`. I subscriber di secondo livello sono oggetti
espliciti (`PassengerAppSession`, `OperatorDashboardSession`), registrati alla connessione e
deregistrati alla disconnessione. L'`EventEmitter` di Nest può fare da trasporto, ma non sostituisce
le classi observer. Le due relazioni hanno vite diverse: vedi DD §2.3.3.

`notifyObservers()` si chiama **dopo** aver persistito la transizione, e a chiamarlo è il componente
che ha scritto — non la classe di stato. Una transizione legale in lettura può non esserlo più in
scrittura (`ConcurrentTransitionError`), e una scrittura si disfa mentre una notifica no: si notifica
ciò che è successo, non ciò che si stava per fare (DD §2.3.3, decisione D39).

---

## Regola 3 — Determinismo

Nel codice di dominio **non esistono** `new Date()`, `Date.now()`, `Math.random()`, `setTimeout`,
`setInterval`.

- L'ora si ottiene sempre da `ClockPort.now()`.
- I numeri casuali sempre da `RandomPort.next()`.
- Le esecuzioni periodiche sono un metodo pubblico chiamato dallo scheduler in produzione e
  direttamente dai test.
- Il simulatore di flotta avanza per `tick()` espliciti, mai su orologio di sistema, quando è sotto
  test.

Questa regola esiste perché i test su prenotazioni anticipate, isteresi e rebalancing dipendono dal
tempo. Senza controllo del tempo diventano instabili, e un test instabile è peggio di nessun test:
ti porterebbe a modificare codice sano inseguendo fallimenti che non esistono. `pnpm lint` fallisce
se trova una di queste chiamate fuori da `src/platform/`.

---

## Regola 4 — Ogni requisito ha un test che lo nomina

Ogni `describe` di test che copre un requisito lo dichiara nel titolo, con il tag fra parentesi
quadre:

```ts
describe('[R5][NFR7] Automated Vehicle Allocation', () => { ... });
describe('[NFR5] Robotaxi state transitions', () => { ... });
```

`pnpm trace` legge tutti i titoli, li incrocia con `docs/requirements.json` e stampa la matrice
requisito → test. **Fallisce se un requisito previsto dalla milestone corrente non ha almeno un
test.** L'output è anche la tabella di tracciabilità che serve al DD §4.

---

## Regola 5 — Flusso di lavoro

Una sessione = una milestone. All'inizio di ogni sessione:

1. Leggi `MILESTONES.md` e individua la milestone corrente.
2. Crea il branch: `git switch -c feat/<milestone>-<slug>` (es. `feat/M3-allocation`).
3. Implementa in incrementi piccoli, eseguendo `pnpm verify` di continuo.
4. Scrivi il cancello della milestone in `apps/api/test/gates/<milestone>.gate.spec.ts`.
5. Quando `pnpm verify` e `pnpm gate <milestone>` sono verdi, apri la pull request con `gh pr create`.
6. **Fermati lì.** Il merge in `main` lo fa il team, non tu. `gh pr merge` è vietato.

Non si lavora mai direttamente su `main`. L'hook di pre-push lo impedisce.

Commit in inglese, imperativo, con il tag della milestone:
`M3: add MinimumEtaStrategy with ETA boundary tests`

---

## Comandi

| Comando | Cosa fa |
|---|---|
| `pnpm verify` | Il controllo completo e veloce. **Eseguilo dopo ogni modifica significativa.** |
| `pnpm typecheck` | Solo controllo dei tipi |
| `pnpm lint` | ESLint + regole di determinismo |
| `pnpm arch` | Confini fra moduli (dependency-cruiser) |
| `pnpm contract` | Rigenera l'OpenAPI e fallisce se diverge da `contracts/openapi.json` |
| `pnpm test:unit` | Test unitari |
| `pnpm test:int` | Test di integrazione su Postgres reale (Testcontainers) |
| `pnpm gate <M>` | Il cancello di una milestone |
| `pnpm trace` | Matrice di copertura dei requisiti |
| `pnpm verify:e2e` | Stack completo + Playwright. Lento: solo a fine milestone. |
| `pnpm db:migrate` / `pnpm db:seed` | Migrazioni e dati di partenza |
| `pnpm dev` | Avvia API, dashboard e app passeggero in locale |

Se `pnpm verify` fallisce, il tuo lavoro non è finito. Non dichiarare completata una milestone con
la verifica rossa, non disabilitare test per farla passare, non aggiungere `.skip`.

---

## Ambiente del team

Il team lavora su **Windows con Windows PowerShell 5.1**. Quando proponi comandi da eseguire a mano:

- **Non usare `&&`**: non è un separatore valido in PowerShell 5.1. Scrivi un comando per riga.
- Non usare sintassi da shell Unix (`export`, `$(...)`, `rm -rf`, heredoc). Gli equivalenti
  PowerShell sono `$env:VAR="..."`, `Remove-Item`, e così via.
- I percorsi di Windows usano `\` e vanno fra virgolette se contengono spazi.
- Docker Desktop deve essere in esecuzione perché i test di integrazione funzionino: se un comando
  lo richiede, dillo esplicitamente.

Questo vale solo per i comandi che chiedi all'utente di eseguire. Dentro il codice, negli script
`package.json` e nella CI si usa sintassi portabile, perché la CI gira su Linux.

## Cose da non fare

- Non cambiare l'architettura decisa nel DD senza chiedere.
- Non introdurre librerie non elencate in `MILESTONES.md` senza chiedere.
- Non aggiungere funzionalità non richieste dai requisiti.
- Non toccare i PDF in `../RASD/` e `../DD/`.
- Non scrivere segreti nel codice: tutto da variabili d'ambiente, con `.env.example` aggiornato.
- Non usare `any` in TypeScript. Lo strict mode è attivo e il lint lo vieta.
- Non lasciare `TODO` senza un test che fallisce o una nota nella PR.
