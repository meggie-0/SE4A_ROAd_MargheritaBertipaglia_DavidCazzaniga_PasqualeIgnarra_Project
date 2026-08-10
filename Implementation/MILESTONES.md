# ROAd — milestone operative

Istruzioni di lavoro per Claude Code. Una sessione = una milestone = un branch = una pull request.
L'ordine segue il DD §5.2 (integrazione bottom-up): un componente si integra solo dopo quelli da cui
dipende. I sistemi esterni sono mock fino a M7.

Prima di iniziare una milestone: leggi `CLAUDE.md`, leggi la sezione della milestone qui sotto,
crea il branch. Prima di chiuderla: `pnpm verify` e `pnpm gate <M>` verdi, poi `gh pr create`.

---

## Librerie ammesse

Non introdurne altre senza chiedere.

**Backend** — `@nestjs/*` (core, common, config, jwt, passport, swagger, schedule, websockets,
platform-socket.io, typeorm), `typeorm`, `pg`, `passport-jwt`, `bcrypt`, `zod`, `socket.io`.
**Frontend** — `react`, `react-dom`, `react-router-dom`, `leaflet`, `react-leaflet`,
`@tanstack/react-query`, `socket.io-client`, `zod`, `tailwindcss`.
**Test e tooling** — `jest`, `ts-jest`, `supertest`, `testcontainers`, `@playwright/test`,
`dependency-cruiser`, `eslint`, `prettier`, `typescript`, `vite`, `pnpm`.

---

## M0 — Walking skeleton

**Obiettivo:** avere la catena di verifica e di deploy funzionante *prima* di scrivere logica di
dominio. Non implementare nulla del dominio in questa milestone.

Da fare:

- Monorepo pnpm: `apps/api`, `apps/web`, `apps/passenger`, `packages/shared`, `tools/`.
- TypeScript strict ovunque, ESLint + Prettier condivisi, incluse le regole `no-restricted-syntax`
  per il determinismo (CLAUDE.md Regola 3).
- `.dependency-cruiser.cjs` con le regole di `HARNESS.md` §3, più `test/arch/exports.spec.ts`.
- `docker-compose.yml` con Postgres 16 e l'estensione `btree_gist` disponibile.
- Script `verify`, `typecheck`, `lint`, `arch`, `contract`, `test:unit`, `test:int`, `gate`, `trace`,
  `verify:e2e`, `dev`, `db:migrate`, `db:seed` nel `package.json` radice.
- `tools/trace/trace.mjs` che implementa `HARNESS.md` §5 leggendo `docs/requirements.json`.
- `apps/api`: modulo `platform` con `ClockPort`, `RandomPort`, `SystemClock`, `SeededRandom`,
  `FakeClock`, `FixedRandom`; modulo `gateway` con `GET /health`; `@nestjs/swagger` configurato e
  `contracts/openapi.json` generato e committato.
- `apps/web` e `apps/passenger`: pagina minima che legge `/health` dall'API.
- `.github/workflows/ci.yml` come da `HARNESS.md` §8.
- `.env.example` completo e `README.md` con le istruzioni di installazione ed esecuzione (richieste
  dalle linee guida del corso §5.3): prerequisiti, `pnpm install`, `docker compose up -d`,
  `pnpm db:migrate`, `pnpm db:seed`, `pnpm dev`.

**Cancello M0:** `pnpm verify` esiste e passa; la CI è verde; i tre servizi rispondono su `/health`;
`pnpm trace` gira senza errori (con zero requisiti attesi a questo punto).

---

## M1 — PersistenceManager e schema

**Copre:** NFR1, NFR4, G10

Entità TypeORM e migrazioni per: `user`, `robotaxi`, `zone`, `ride_request`, `booking`,
`robotaxi_reservation`, `demand_sample`, `demand_event`, `maintenance_record`, `system_mode`,
`notification`.

Il vincolo centrale, in migrazione:

```sql
CREATE EXTENSION IF NOT EXISTS btree_gist;

ALTER TABLE robotaxi_reservation
  ADD CONSTRAINT no_overlapping_reservations
  EXCLUDE USING gist (robotaxi_id WITH =, period WITH &&);
```

`PersistencePort`: `create`, `update`, `filterAvailable`, `reserve`. `filterAvailable` esclude i
veicoli con una riserva sovrapposta alla finestra richiesta. L'assegnazione immediata usa
`SELECT ... FOR UPDATE SKIP LOCKED` sui candidati.

### Zone di Milano

Seed con le zone reali sotto. Le coordinate sono centroidi indicativi, da rifinire; il raggio serve
solo a decidere l'appartenenza di un punto.

| Zona | Lat | Lon | Profilo di domanda |
|---|---|---|---|
| Duomo / Centro | 45.4642 | 9.1900 | alta e costante nelle ore diurne |
| Stazione Centrale | 45.4863 | 9.2050 | picchi mattina presto e sera |
| Porta Garibaldi | 45.4847 | 9.1874 | punte pendolari, uffici |
| Isola | 45.4900 | 9.1900 | serale |
| Navigli / Darsena | 45.4500 | 9.1750 | notturna, forte nel fine settimana |
| San Siro | 45.4781 | 9.1240 | bassa di base, picco a fine evento |
| CityLife | 45.4780 | 9.1560 | uffici, ore di punta |
| Politecnico Leonardo | 45.4781 | 9.2270 | orari di lezione |
| Politecnico Bovisa | 45.5030 | 9.1560 | orari di lezione |
| Bicocca | 45.5150 | 9.2110 | orari di lezione e uffici |
| Lambrate | 45.4850 | 9.2380 | pendolare |
| Porta Romana | 45.4490 | 9.2050 | residenziale, serale |
| Porta Venezia | 45.4740 | 9.2050 | serale |
| Cadorna | 45.4680 | 9.1750 | pendolare |
| Linate | 45.4451 | 9.2767 | a ondate, legata ai voli |
| Rho Fiera | 45.5180 | 9.0850 | bassa di base, picco durante le fiere |

Il modello di domanda ha due livelli: una **base** per zona e fascia oraria settimanale
(`demand_sample`), e degli **eventi** con orario di fine e moltiplicatore (`demand_event`) — partita
a San Siro, salone a Rho Fiera, spettacolo alla Scala. I dati sono simulati: va scritto nelle
assunzioni, e il RASD già tratta la sorgente di domanda come dipendenza esterna.

Seed: 20 robotaxi distribuiti sulle zone, le 16 zone, una settimana di `demand_sample`, due o tre
`demand_event` di esempio.

**Cancello M1:** due transazioni concorrenti che prenotano lo stesso veicolo su intervalli
sovrapposti — esattamente una riesce, l'altra fallisce per violazione del vincolo di esclusione.
`filterAvailable` esclude correttamente i veicoli già riservati nella finestra richiesta.

---

## M1b — AuthenticationManager

**Copre:** R1, R2, G1, NFR3

`AuthPort`: `register`, `authenticate`, `updateProfile`. JWT firmato, ruoli `PASSENGER` e
`OPERATOR`, guard Nest applicati nel modulo `gateway`. Password con bcrypt. Nessuno stato di sessione
lato server, così il tier applicativo resta replicabile (NFR3). Un solo access token, niente refresh.

**Cancello M1b:** registrazione, login e aggiornamento profilo funzionano; un token `PASSENGER`
riceve 403 sugli endpoint operatore e viceversa; una password non viene mai restituita né loggata.

---

## M2 — FleetMonitor e Robotaxi (State)

**Copre:** R7, R9, G6, G8, NFR5

Classi di stato come da `CLAUDE.md` Regola 2. Transizioni ammesse secondo la FSM del RASD §3.2; ogni
altra solleva `IllegalTransitionError`. Persistenza come colonna enum, ricostruzione tramite
`RobotaxiStateFactory`.

`FleetMonitorPort`: `getCandidates`, `getAvailableRobotaxis`, `getFleetStatus`, `assign`,
`requestRebalancing`. `MaintenancePort`: `requestMaintenance`, `completeMaintenance`; un veicolo in
manutenzione non compare mai fra i candidati.

**Cancello M2:** copertura esaustiva della FSM — tutte le transizioni legali riescono, **tutte** le
illegali sollevano l'eccezione tipizzata; lo stato sopravvive a persistenza e ricostruzione; un
veicolo in manutenzione è escluso dai candidati.

---

## M3 — AllocationManager e strategie (Strategy)

**Copre:** R5, R8, G4, G5, NFR7

`AllocationStrategy` con `selectRobotaxi(request, candidates)`. `NearestAvailableStrategy` usa la
distanza haversine. `MinimumEtaStrategy` chiede gli ETA a `ExternalServicesPort` (in questa
milestone un mock deterministico). `AllocationManager` è il contesto: `allocate`,
`setActiveStrategy`, `getActiveStrategy`. Endpoint operatore per leggere e cambiare la strategia.

I pareggi vanno risolti in modo deterministico e documentato (per esempio: a parità di metrica vince
l'id lessicograficamente minore). Senza questa regola i test diventano instabili.

**Cancello M3:** per ciascuna strategia — flotta vuota → nessuna assegnazione; nessun candidato
idoneo → nessuna assegnazione; un solo idoneo → quello; più candidati → il corretto secondo la
metrica; valori di frontiera su distanza ed ETA; pareggi risolti in modo deterministico. Aggiungere
una terza strategia fittizia nel test richiede solo una classe e una registrazione (NFR7).

---

## M4 — RideRequestManager

**Copre:** R3, R4, G2, G3

`RideRequestPort`: `submitImmediate`, `submitAdvance`, `cancel`.

`submitImmediate`: validazione → candidati da `FleetMonitorPort` → `AllocationPort.allocate` →
assegnazione atomica. `submitAdvance`: filtro candidati sulla timeline → booking e reservation
scritti nella **stessa transazione**. `cancel`: rilascia la riserva e riporta il veicolo ad
`available`.

**Cancello M4:** catena richiesta → allocazione → assegnazione completa; una prenotazione anticipata
o scrive entrambe le righe o nessuna (verificato forzando un errore a metà transazione);
l'annullamento libera la riserva e la finestra torna prenotabile.

---

## M5 — NotificationManager (Observer) e push

**Copre:** R6, G7, NFR2

Eventi di dominio emessi da `fleet` e `rides`. `NotificationPort.update(event)`. Subscriber
espliciti `PassengerSession` e `OperatorDashboardSession`, registrati alla connessione e
deregistrati alla disconnessione. Socket.IO con autenticazione JWT sull'handshake, una room per
passeggero e una per operatore. Il modulo `gateway` inoltra i push.

**Cancello M5:** un passeggero connesso riceve `assigned → arriving → arrived → in_ride` per la
propria corsa e **nessun** evento relativo a corse altrui; un operatore riceve gli eventi di flotta;
alla disconnessione il subscriber viene rimosso e non restano riferimenti.

---

## M6 — ModeController e RebalancingManager

**Copre:** R10, R11, R12, R13, G9, NFR9, NFR10

`ModePort`: `onTrafficLevel`, `setManual`, `enableAuto`, `getMode`. Comportamento richiesto dal RASD
§2.4:

- default `NearestAvailable`;
- traffico **Medium** → alert all'operatore, **nessun** cambio di strategia;
- traffico **High** → passaggio automatico a `MinimumETA`;
- ritorno a `NearestAvailable` **solo** quando il traffico rientra su **Low** (isteresi, NFR9);
- una scelta manuale porta in Manual mode e sospende ogni switch automatico finché l'operatore non
  riabilita Auto esplicitamente (NFR10).

`RebalancingPort`: `analyzeDemand` combina base storica e eventi attivi per stimare la domanda per
zona; `rebalance` invia i veicoli inattivi verso le zone scoperte e produce alert in dashboard.
`RebalancingScheduler` espone `runOnce()` chiamato da `@Cron` in produzione e dai test direttamente.

**Cancello M6:** sequenza Low→Medium→High→Medium→Low con alert su Medium senza cambio, switch su
High, ritorno alla strategia di default solo all'ultimo Low; in Manual mode nessuno switch
automatico fino a `enableAuto()`; `analyzeDemand` su un dataset noto (compreso un evento a San Siro)
restituisce le zone attese nell'ordine atteso.

---

## M7 — ExternalServicesGateway reale e simulatore

**Copre:** NFR8

`ExternalServicesPort` come facade, un adapter per fornitore: OSRM per route ed ETA (con cache e
fallback a stima lineare), sorgente traffico, sorgente domanda, flotta.

L'adapter flotta è il **simulatore**: a ogni `tick()` avanza i veicoli lungo la polyline assegnata e
ne pubblica la telemetria. Vive in `tools/simulator` ed è raggiunto solo attraverso la porta, quindi
sostituibile da veicoli reali senza toccare i manager. Sotto test avanza solo su `tick()` esplicito;
in esecuzione normale ha un ciclo proprio.

**Cancello M7:** configurando gli adapter reali il sistema funziona senza mock; con OSRM
irraggiungibile il fallback produce comunque un ETA e nessuna richiesta va persa; il simulatore
porta un veicolo da `assigned` ad `arrived` in un numero deterministico di tick.

---

## M8 — Client

**Copre:** R1, R2, R3, R4, R6, R7, R8, NFR6

**Dashboard operatore** (DD §3.2): mappa Leaflet con marker colorati per stato, pannello strategia
con toggle Auto/Manual sempre visibile, pannello alert per switch automatici e suggerimenti di
rebalancing, status bar con riepilogo della flotta per stato.

**App passeggero** (DD §3.1, realizzata come PWA responsive): schermata centrata sulla mappa,
selezione pickup e destinazione, scelta fra corsa immediata e programmata, un solo pulsante di
richiesta; dopo la richiesta la stessa schermata diventa vista di stato live guidata dalle notifiche.

Entrambi i client consumano **solo** l'HTTP pubblico e i tipi di `packages/shared`. Nessun import da
`apps/api`.

**Cancello M8:** Playwright — un passeggero richiede una corsa e vede lo stato aggiornarsi fino a
`in_ride`; un operatore cambia strategia e vede la dashboard passare a Manual; screenshot salvati
per entrambi i flussi.

---

## M9 — Test di sistema e demo

- I quattro scenari del RASD end-to-end su staging.
- Test di concorrenza: due richieste simultanee per l'ultimo robotaxi disponibile, esattamente una
  assegnata (NFR1, NFR4).
- `pnpm trace` senza requisiti scoperti.
- README verificato eseguendo le istruzioni da zero su una macchina pulita.
- Dataset di demo: una serata con partita a San Siro, per mostrare il rebalancing.

**Cancello M9:** tutti i cancelli precedenti verdi, `verify:e2e` verde, `pnpm trace` completo.
