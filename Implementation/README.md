# ROAd — Robotaxi Optimized Allocation

Prototipo del sistema di gestione di una flotta di robotaxi a Milano descritto dal RASD e dal DD di
progetto (Politecnico di Milano, *Software Engineering for Automation*).

Questa cartella contiene l'implementazione. I documenti autorevoli sono `docs/RASD.md`,
`docs/DD.md`, `MILESTONES.md` (cosa si implementa e in che ordine) e `HARNESS.md` (come si
verifica). Le regole permanenti per chi scrive codice — confini fra moduli, visibilità dei design
pattern, determinismo, tracciabilità — stanno in `CLAUDE.md`.

## Stato

Milestone corrente: **M8 — Client**. Il backend è completo nei suoi manager (M1–M6) e parla con
fornitori veri (M7): OSRM per percorsi e tempi di arrivo — con cache e ripiego sulla stima lineare
quando non risponde — e un **simulatore di flotta** che guida i veicoli lungo la rotta comandata e
ne pubblica la telemetria.

Da questa milestone il sistema ha due interfacce vere. La **dashboard dell'operatore** (DD §3.2)
mostra la flotta viva su una mappa Leaflet con i marker colorati per stato, il pannello strategia
con il toggle Auto/Manual sempre visibile, gli alert degli switch automatici e dei riposizionamenti,
e una status bar che riassume la flotta per stato. L'**app del passeggero** (DD §3.1) è centrata
sulla mappa: si toccano ritiro e destinazione, si sceglie fra corsa immediata e programmata, si
preme un pulsante solo — e da lì la stessa schermata diventa una vista di stato live, guidata dalle
notifiche, che segue la corsa fino a destinazione. Dalla stessa schermata si aggiornano i propri
dati e la password (R2). Restano i test di sistema (M9).

Il sistema funziona **senza rete**: se `OSRM_BASE_URL` è vuota o il fornitore non risponde, i
percorsi si stimano in linea d'aria e nessuna richiesta di corsa va persa. I due client scaricano
le tessere della mappa da OpenStreetMap: senza connessione restano usabili, con lo sfondo grigio.

## Struttura

```
Implementation/
├─ apps/
│  ├─ api/          backend NestJS: API Gateway e, da M1, i manager del DD §2.2
│  ├─ web/          dashboard dell'operatore di flotta (DD §3.2)
│  └─ passenger/    app del passeggero, PWA responsive (DD §3.1)
├─ packages/
│  └─ shared/       tipi e schemi condivisi. È una foglia: non dipende da apps/
├─ contracts/
│  └─ openapi.json  contratto pubblicato, generato e committato (HARNESS.md §4)
├─ tools/
│  ├─ simulator/    simulatore di flotta (M7): un pacchetto, non un modulo dell'API — sta
│  │                dall'altra parte della porta, come OSRM, ed è sostituibile da veicoli veri
│  └─ ...           harness di verifica: verify, trace, gate, dev, db, e2e
├─ docker/          inizializzazione del database di sviluppo
└─ docs/            RASD, DD e docs/requirements.json (sorgente di `pnpm trace`)
```

## Prerequisiti

| Strumento | Versione | Note |
|---|---|---|
| Node.js | ≥ 20.11 (consigliata 22 LTS) | la CI gira su 22 |
| pnpm | ≥ 9 | `corepack enable && corepack prepare pnpm@11 --activate` |
| Docker | qualsiasi versione recente con Compose v2 | serve per Postgres e per i test di integrazione |
| Git | — | — |

## Installazione ed esecuzione

```bash
# 1. dipendenze di tutto il monorepo
pnpm install

# 2. configurazione: copiare il file di esempio e adattarlo se serve
cp .env.example .env          # su Windows: copy .env.example .env
#    I valori di default bastano in locale. In qualunque altro posto vanno cambiati almeno
#    JWT_SECRET e le due password SEED_*: sono credenziali di sviluppo, scritte in chiaro.

# 3. database di sviluppo (Postgres 16 con l'estensione btree_gist)
docker compose up -d

# 4. schema e dati di partenza
pnpm db:migrate
pnpm db:seed

# 5. tutto in esecuzione: API, dashboard operatore, app passeggero
pnpm dev
```

Dopo `pnpm dev`:

| Servizio | Indirizzo |
|---|---|
| API | <http://localhost:3000> |
| Contratto OpenAPI (Swagger UI) | <http://localhost:3000/docs> |
| Dashboard operatore | <http://localhost:5173> |
| App passeggero | <http://localhost:5174> |

Per entrare servono gli account seminati: l'operatore con `SEED_OPERATOR_*`, il passeggero con
`SEED_PASSENGER_*` — o uno nuovo, creato dall'app passeggero stessa. In fondo a entrambe le
schermate resta l'indicatore dello stato letto da `GET /health`: dice a colpo d'occhio se una
schermata ferma è una flotta ferma o un backend spento.

> `pnpm db:migrate` applica le migrazioni TypeORM (compila prima l'API, perché lo schema vive dentro
> il modulo `persistence`). `pnpm db:seed` è **ripetibile**: svuota le tabelle di dominio e ricarica
> zone, flotta, domanda e i due account di partenza, così eseguirlo due volte non è un errore.
>
> Gli account seminati sono quelli di `SEED_OPERATOR_*` e `SEED_PASSENGER_*`. Il passeggero si
> potrebbe anche creare da `POST /auth/register`; l'operatore no, ed è voluto — il RASD prevede la
> registrazione dei soli passeggeri, quindi senza il seed non esisterebbe alcun modo di entrare
> come operatore.
>
> L'API applica le migrazioni da sé alla prima query, il che rende il comando manuale una comodità e
> non un obbligo. È la scelta giusta per un prototipo, ma va detta: con il tier applicativo
> replicato (NFR3), due istanze che partono insieme su un database non migrato le eseguirebbero in
> parallelo. In un deploy vero le migrazioni sono un passo a sé, prima di avviare le repliche.

## Verifica

```bash
pnpm verify        # il controllo completo: tipi, lint, architettura, contratto, test
```

`pnpm verify` è ciò che esegue anche la CI, senza varianti. Se è verde in locale dev'essere verde
in CI: una divergenza fra i due è un bug dell'harness.

**Docker dev'essere in esecuzione.** Da M1 il cancello di milestone e i test di integrazione
avviano un container Postgres usa e getta (Testcontainers): il vincolo di esclusione sulle riserve
è una funzione del database, e verificarlo su un doppio in memoria significherebbe verificare il
doppio. Senza Docker, `pnpm verify` fallisce ai passi `gate` e `integration`.

| Comando | Cosa fa |
|---|---|
| `pnpm verify` | il controllo completo e veloce |
| `pnpm typecheck` | solo controllo dei tipi, strict ovunque |
| `pnpm lint` | ESLint, regole di determinismo e Prettier |
| `pnpm arch` | confini fra moduli (dependency-cruiser + test sugli `exports` dei `@Module`) |
| `pnpm contract` | rigenera l'OpenAPI e fallisce se diverge da `contracts/openapi.json` |
| `pnpm contract:update` | aggiorna `contracts/openapi.json` dopo una modifica voluta dell'API |
| `pnpm test:unit` | test unitari |
| `pnpm test:int` | test di integrazione su Postgres reale (Testcontainers), da M1 |
| `pnpm gate <M>` | il cancello di una milestone, es. `pnpm gate M1` |
| `pnpm trace` | matrice requisito → test |
| `pnpm verify:e2e` | stack completo con Playwright; lento, a fine milestone |

`pnpm verify:e2e` prepara il database (Postgres, migrazioni e seed), alza da solo i tre servizi e
guida un browser vero; la prima volta i browser vanno scaricati con
`pnpm exec playwright install chromium`. Gli screenshot finiscono in `e2e/screenshots/`. Serve perché esistono difetti che nessun controllo senza browser può vedere:
la prima versione di M0 passava tutto con `packages/shared` compilato solo in CommonJS, e falliva
solo a runtime dentro la pagina.

## Come è organizzato il codice

Ogni componente del DD §2.2 è un modulo sotto `apps/api/src/`, raggiungibile **solo** attraverso la
sua porta — una classe astratta che dichiara le operazioni e fa da token di iniezione. Chi usa
l'allocazione inietta `AllocationPort`, mai `AllocationManager`. `pnpm arch` verifica il vincolo, e
il senso è pratico: un membro del team deve poter riscrivere da zero un singolo modulo, o l'intero
frontend, senza toccare nient'altro.

Nel codice di dominio non esistono `new Date()`, `Math.random()` né timer: il tempo si chiede a
`ClockPort`, la casualità a `RandomPort`, e le attività periodiche sono metodi `runOnce()` pubblici
chiamati dallo scheduler in produzione e direttamente dai test. `pnpm lint` fallisce se trova
un'eccezione fuori da `apps/api/src/platform/`.

I client non importano niente da `apps/api`: conoscono il backend solo attraverso
`contracts/openapi.json` e i tipi di `packages/shared`.

Ciò che ROAd non controlla — mappe, traffico, flotta — sta dietro `ExternalServicesPort`, con un
adapter per fornitore. Nessun altro file cita un URL, un protocollo o un SDK, ed è la formulazione
verificabile di NFR8 (DD §4.3): il giorno in cui i robotaxi fossero veri, cambierebbe un adapter e
nessun manager. Il simulatore avanza solo quando qualcuno gli dice di avanzare — un `@Cron` in
esecuzione normale, i test un tick alla volta — perché il tempo del mondo simulato non è
l'orologio di sistema (CLAUDE.md Regola 3).

## Contribuire

Una sessione di lavoro = una milestone = un branch = una pull request. Il flusso completo, gli
hook e i divieti sono in `CLAUDE.md` §Regola 5. In sintesi: non si lavora su `main`, non si
dichiara finita una milestone con `pnpm verify` rosso, e il merge lo fa il team.
