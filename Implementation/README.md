# ROAd — Robotaxi Optimized Allocation

Prototipo del sistema di gestione di una flotta di robotaxi a Milano descritto dal RASD e dal DD di
progetto (Politecnico di Milano, *Software Engineering for Automation*).

Questa cartella contiene l'implementazione. I documenti autorevoli sono `docs/RASD.md`,
`docs/DD.md`, `MILESTONES.md` (cosa si implementa e in che ordine) e `HARNESS.md` (come si
verifica). Le regole permanenti per chi scrive codice — confini fra moduli, visibilità dei design
pattern, determinismo, tracciabilità — stanno in `CLAUDE.md`.

## Stato

Milestone corrente: **M1 — PersistenceManager e schema**. Sopra il walking skeleton di M0 ci sono
ora lo schema del database, il modulo `persistence` con la sua porta e i dati di partenza (le 16
zone di Milano, 20 robotaxi, una settimana di domanda simulata). L'invariante centrale — due
riserve dello stesso veicolo non si sovrappongono mai — è garantita da un vincolo di esclusione di
PostgreSQL, non dal codice applicativo. I manager di dominio arrivano da M1b in poi, nell'ordine di
integrazione bottom-up del DD §5.2.

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
├─ tools/           harness di verifica: verify, trace, gate, dev, db, e2e
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

I due client mostrano per ora una sola cosa: lo stato letto da `GET /health`. È poco per uno
schermo, ma è la prova che la catena client → contratto HTTP → API funziona prima che venga scritta
una riga di logica di dominio; le schermate vere arrivano con M8.

> `pnpm db:migrate` applica le migrazioni TypeORM (compila prima l'API, perché lo schema vive dentro
> il modulo `persistence`). `pnpm db:seed` è **ripetibile**: svuota le tabelle di dominio e ricarica
> zone, flotta e domanda, così eseguirlo due volte non è un errore.
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

`pnpm verify:e2e` alza da solo i tre servizi e guida un browser vero; la prima volta i browser
vanno scaricati con `pnpm exec playwright install chromium`. Gli screenshot finiscono in
`e2e/screenshots/`. Serve perché esistono difetti che nessun controllo senza browser può vedere:
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

## Contribuire

Una sessione di lavoro = una milestone = un branch = una pull request. Il flusso completo, gli
hook e i divieti sono in `CLAUDE.md` §Regola 5. In sintesi: non si lavora su `main`, non si
dichiara finita una milestone con `pnpm verify` rosso, e il merge lo fa il team.
