# ROAd — Robotaxi Optimized Allocation

Prototipo del sistema di gestione di una flotta di robotaxi a Milano descritto dal RASD e dal DD di
progetto (Politecnico di Milano, *Software Engineering for Automation*).

Questa cartella contiene l'implementazione. I documenti autorevoli sono `docs/RASD.md`,
`docs/DD.md`, `MILESTONES.md` (cosa si implementa e in che ordine) e `HARNESS.md` (come si
verifica). Le regole permanenti per chi scrive codice — confini fra moduli, visibilità dei design
pattern, determinismo, tracciabilità — stanno in `CLAUDE.md`.

## Stato

Milestone corrente: **M9 — Test di sistema e demo**, l'ultima. Il backend è completo nei suoi
manager (M1–M6) e parla con fornitori veri (M7): OSRM per percorsi e tempi di arrivo — con cache e
ripiego sulla stima lineare quando non risponde — e un **simulatore di flotta** che guida i veicoli
lungo la rotta comandata e ne pubblica la telemetria.

Il sistema ha due interfacce vere (M8). La **dashboard dell'operatore** (DD §3.2) mostra la flotta
viva su una mappa Leaflet con i marker colorati per stato, il pannello strategia con il toggle
Auto/Manual sempre visibile, gli alert degli switch automatici e dei riposizionamenti, e una status
bar che riassume la flotta per stato. L'**app del passeggero** (DD §3.1) è centrata sulla mappa: si
toccano ritiro e destinazione, si sceglie fra corsa immediata e programmata, si preme un pulsante
solo — e da lì la stessa schermata diventa una vista di stato live, guidata dalle notifiche, che
segue la corsa fino a destinazione, con il robotaxi disegnato sulla mappa dall'assegnazione fino
all'arrivo. Da entrambi i client si aggiornano i propri dati e la password (R2).

Con M9 arrivano i **quattro scenari del RASD** eseguiti dall'inizio alla fine
(`apps/api/test/integration/scenarios/`), il test di concorrenza sull'ultimo veicolo disponibile e
il dataset di dimostrazione della serata a San Siro.

La posizione dei veicoli si rinnova **due volte al secondo**: il simulatore avanza, la telemetria
scrive e i due client rileggono alla stessa cadenza — una sola costante, `FLEET_POSITION_REFRESH_MS`
in `packages/shared`. La velocità del mondo simulato non è cambiata (sei volte il tempo reale): è il
passo a essersi accorciato, e un veicolo che prima saltava da un punto all'altro ora scorre.

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

### Credenziali di accesso

Le due schermate chiedono di entrare. `pnpm db:seed` crea questi due account, prendendo indirizzo e
password dall'ambiente: sono i valori di `.env.example`, quindi chi non ha toccato il file trova
esattamente questi.

| Dove | Indirizzo | Email | Password |
|---|---|---|---|
| Dashboard operatore (<http://localhost:5173>) | `SEED_OPERATOR_EMAIL` | `operatore@road.example` | `operatore-di-sviluppo` |
| App passeggero (<http://localhost:5174>) | `SEED_PASSENGER_EMAIL` | `passeggero@road.example` | `passeggero-di-sviluppo` |

> **Sono credenziali di sviluppo, scritte in chiaro qui perché servono a far partire una
> dimostrazione su una macchina locale.** Ovunque non sia quello, vanno cambiate nel `.env` prima di
> seminare — insieme a `JWT_SECRET` — e questa tabella smette di valere: il seed legge l'ambiente,
> non questo file.

Dal lato passeggero un account nuovo si può anche creare dall'app stessa («Registrati»): il RASD
prevede la registrazione dei soli passeggeri, quindi l'operatore esiste **solo** se il seed è stato
eseguito. Se la schermata dell'operatore rifiuta le credenziali, quasi sempre manca `pnpm db:seed`.

In fondo a entrambe le schermate resta l'indicatore dello stato letto da `GET /health`: dice a colpo
d'occhio se una schermata ferma è una flotta ferma o un backend spento.

## Le dimostrazioni

Quattro comandi, uno per scenario del RASD. Ciascuno **ricostruisce i dati di partenza**, alza i tre
servizi e guida un browser vero, lasciando gli screenshot in `e2e/screenshots/demo/`.

```bash
pnpm demo:immediate      # scenario 1 — corsa immediata
pnpm demo:advance        # scenario 2 — prenotazione anticipata
pnpm demo:traffic        # scenario 3 — traffico, isteresi, rientro in Auto
pnpm demo:rebalancing    # scenario 4 — riposizionamento verso San Siro
```

Prerequisiti: gli stessi dell'installazione — Docker in esecuzione e `pnpm install` fatto — più i
browser di Playwright, che si installano una volta sola:

```bash
pnpm exec playwright install chromium
```

> **A stack fermo.** I comandi **rifiutano di partire** se le porte 3000, 5173 o 5174 sono occupate,
> e lo fanno apposta. Un `pnpm dev` già avviato verrebbe riusato, e quei processi hanno letto le
> variabili d'ambiente all'avvio: la demo girerebbe con la configurazione sbagliata senza dare un
> solo segnale. Il messaggio d'errore riporta il comando per chiudere ciò che è rimasto aperto.

**Stato: solo `demo:immediate` ha il proprio script.** Gli altri tre hanno già la configurazione —
è ciò che questo lavoro ha aggiunto — e si fermano con un messaggio esplicito finché lo script non
c'è. Scriverli è il passo successivo.

Gli screenshot coprono i **passaggi salienti**, non ogni fase: alcune transizioni durano meno del
giro di campionamento, quindi quante immagini escano varia da un'esecuzione all'altra.

### Che cosa rende una dimostrazione pilotabile

In esecuzione normale il lavoro periodico ha le cadenze che le decisioni del DD giustificano nel
merito — traffico ogni cinque minuti, riposizionamento ogni dieci, prenotazioni ogni minuto — e il
livello di traffico si deduce dall'ora locale di Milano. Sono i valori giusti per un sistema acceso e
i valori sbagliati per qualcuno che guarda: la sequenza dell'isteresi si vedrebbe solo alle 17:00 di
un giorno feriale, e una prenotazione si attiverebbe un quarto d'ora dopo.

I comandi qui sopra accorciano quelle cadenze e sostituiscono la sorgente di traffico con una che
segue una **tabella relativa all'avvio del processo**, passando variabili d'ambiente documentate in
`.env.example`. **I default non cambiano**: un'installazione che ignora quelle variabili si comporta
esattamente come prima. Ed è il *mondo* a essere diverso in dimostrazione, non il sistema — non
esiste nessuna rotta che imposta il traffico, perché il traffico è un fenomeno osservato e non
comandato (DD, decisione D76).

### Lo scenario 4 a mano, senza il comando


```bash
# a `pnpm dev` fermo, e dopo `pnpm db:seed`
pnpm db:demo
pnpm dev
```

Arrangia lo scenario 4 del RASD sul momento in cui lo si esegue: scrive un evento di domanda attivo
**adesso** allo stadio; abbassa la domanda della sola fascia oraria corrente nelle altre zone, così
qualcuna ha veicoli da cedere e San Siro resta l'unica zona scoperta; riporta tutti i robotaxi
disponibili e ne sposta via chi stava allo stadio; e ripulisce le corse della dimostrazione
precedente. È ripetibile.

> **A `pnpm dev` fermo.** Da M7 le posizioni dei veicoli vivono nella memoria del processo API — il
> simulatore *è* la flotta — e questo comando non lo raggiunge: con l'API accesa i veicoli che
> stavano percorrendo una rotta la riprendono, e la telemetria riscrive entro mezzo secondo le
> posizioni appena sistemate. Fermare, eseguire, riavviare.

Poi si guarda la dashboard. Il ciclo di riposizionamento gira **ogni dieci minuti** e manda un
veicolo per zona scoperta, quindi il primo movimento arriva entro dieci minuti dall'avvio e i
successivi uno ogni dieci: è la cadenza scelta in M6, e una dimostrazione dal vivo conviene
avviarla in anticipo. Quando parte, un veicolo inattivo si mette in viaggio verso lo stadio — il suo
marker passa al colore di `REBALANCING` e nel pannello alert compare la riga corrispondente.
I dieci minuti governano soltanto la **decisione di nuovi riposizionamenti**. Un robotaxi che
raggiunge la zona target non attende il ciclo successivo: la telemetria ne chiude il
riposizionamento alla cadenza `FLEET_POSITION_REFRESH_MS`, lo riporta ad `AVAILABLE` e aggiorna la
sua `zoneId` alla zona raggiunta (decisione D74).

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
>
> Per la stessa ragione, in un deploy replicato **il lavoro periodico va acceso su un'istanza sola**
> (decisione D72). Ciò che NFR3 chiede replicabile è il cammino delle richieste — nessuno stato di
> sessione lato server, un token emesso da un'istanza accettato da un'altra — non i cinque `@Cron` e
> `@Interval`. Attivazione prenotazioni e riposizionamento su due repliche farebbero lavoro doppio
> senza incoerenze, perché ogni transizione è condizionata sullo stato letto; il **simulatore** no:
> vive nella memoria del processo, quindi due repliche avrebbero due flotte simulate diverse che
> scrivono le stesse righe. In locale, con un processo solo, la questione non si pone.

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
| `pnpm db:demo` | arrangia la serata con la partita a San Siro, per la dimostrazione |

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
