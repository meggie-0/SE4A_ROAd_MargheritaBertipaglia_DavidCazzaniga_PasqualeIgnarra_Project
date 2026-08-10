# ROAd — Robotaxi Optimized Allocation

Prototipo del sistema di gestione di una flotta di robotaxi a Milano descritto dal RASD e dal DD di
progetto (Politecnico di Milano, *Software Engineering for Automation*).

Questa cartella contiene l'implementazione. I documenti autorevoli sono `docs/RASD.md`,
`docs/DD.md`, `MILESTONES.md` (cosa si implementa e in che ordine) e `HARNESS.md` (come si
verifica). Le regole permanenti per chi scrive codice — confini fra moduli, visibilità dei design
pattern, determinismo, tracciabilità — stanno in `CLAUDE.md`.

## Stato

Milestone corrente: **M0 — walking skeleton**. Esiste la catena di verifica end-to-end e i tre
servizi si parlano; la logica di dominio arriva da M1 in poi, nell'ordine di integrazione bottom-up
del DD §5.2.

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

In M0 i due client mostrano una sola cosa: lo stato letto da `GET /health`. È poco per uno
schermo, ma è la prova che la catena client → contratto HTTP → API funziona prima che venga scritta
una riga di logica di dominio.

> `pnpm db:migrate` e `pnpm db:seed` in M0 non hanno ancora nulla da fare e lo dicono
> esplicitamente: schema e seed sono il contenuto di M1. I comandi esistono già perché sono i passi
> di installazione documentati, e un comando mancante è peggio di un comando che spiega cosa manca.

## Verifica

```bash
pnpm verify        # il controllo completo: tipi, lint, architettura, contratto, test
```

`pnpm verify` è ciò che esegue anche la CI, senza varianti. Se è verde in locale dev'essere verde
in CI: una divergenza fra i due è un bug dell'harness.

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
| `pnpm gate <M>` | il cancello di una milestone, es. `pnpm gate M0` |
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
