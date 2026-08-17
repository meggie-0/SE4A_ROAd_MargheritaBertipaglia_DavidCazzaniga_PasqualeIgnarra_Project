# ROAd — Resoconto modifiche R9: gestione della manutenzione

**Data:** 17 agosto 2026  
**Autore:** Pasquale Ludovico Ignarra

## Obiettivo

Rendere la gestione della manutenzione dei robotaxi utilizzabile dall'operatore tramite la dashboard, completando il collegamento tra il dominio già esistente, l'API pubblica e il client web.

## Situazione iniziale

Il `MaintenanceManager` implementava già la logica prevista da R9:

- transizione `AVAILABLE → MAINTENANCE`;
- transizione `MAINTENANCE → AVAILABLE`;
- esclusione dei veicoli in manutenzione dalle assegnazioni;
- apertura e chiusura di `maintenance_record`;
- protezione dalle transizioni illegali e concorrenti;
- notifica WebSocket delle variazioni di stato.

La funzionalità non era però raggiungibile dall'esterno perché mancavano rotte HTTP, controller, contratto condiviso e comandi nella dashboard operatore.

## Modifiche al contratto condiviso

1. Aggiunte le rotte:

   ```http
   POST /fleet/:robotaxiId/maintenance
   POST /fleet/:robotaxiId/maintenance/complete
   ```

2. Aggiunte le funzioni per costruire gli URL relativi a un robotaxi specifico.

3. Creato il contratto pubblico della manutenzione con schemi Zod per:

   - body di avvio della manutenzione;
   - record di manutenzione;
   - risposta di avvio;
   - risposta di completamento.

4. Esportati i nuovi schemi e tipi da `@road/shared`.

5. Il motivo della manutenzione viene validato come stringa non vuota con un massimo di 255 caratteri. Gli identificatori UUID utilizzano la sintassi Zod 4 `z.uuid()`.

## Modifiche al backend

1. Creati i DTO Swagger della manutenzione.

2. Creato `MaintenanceController`, riservato al ruolo `OPERATOR`.

3. Collegati gli endpoint a `MaintenancePort`, senza duplicare nel controller alcuna regola di dominio.

4. Tradotti gli errori di dominio nei corrispondenti codici HTTP:

   - `400 Bad Request` per body non valido;
   - `401 Unauthorized` per sessione assente o non valida;
   - `403 Forbidden` per ruolo non autorizzato;
   - `404 Not Found` per robotaxi inesistente;
   - `409 Conflict` per transizione illegale o concorrente.

5. Importato `MaintenanceModule` nel `GatewayModule` e registrato `MaintenanceController`.

6. Rigenerato e verificato `contracts/openapi.json`.

## Modifiche alla dashboard operatore

1. Aggiunte in `apps/web/src/api.ts` le chiamate per:

   - avviare la manutenzione;
   - completare la manutenzione.

2. Resi selezionabili i marker dei robotaxi sulla mappa.

3. Aggiunta la deselezione cliccando su un punto libero della mappa.

4. Aggiunto un bordo di selezione visibile e un leggero ingrandimento, mantenendo il colore dello stato del veicolo.

5. Creato `MaintenancePanel`, che mostra:

   - identificatore del robotaxi;
   - stato corrente;
   - zona corrente;
   - campo per il motivo e comando **Metti in manutenzione** quando il veicolo è `AVAILABLE`;
   - comando **Completa manutenzione** quando il veicolo è `MAINTENANCE`;
   - spiegazione dell'indisponibilità del comando negli altri stati.

6. Gestiti separatamente stato di caricamento ed errori della manutenzione, senza interferire con il pannello della strategia.

7. Dopo ogni comando viene invalidata la query della flotta. Le notifiche WebSocket continuano a provocare l'aggiornamento immediato della mappa e della status bar.

8. Aggiunti gli stili del pannello di manutenzione.

## Test e verifiche

1. `pnpm typecheck` completato senza errori.

2. `pnpm contract:update` completato correttamente.

3. `pnpm contract`: 2 test superati su 2.

4. Verifica manuale tramite Swagger:

   - avvio della manutenzione: `201 Created`;
   - secondo avvio sullo stesso veicolo: `409 Conflict`;
   - completamento: `200 OK`;
   - aggiornamento corretto di stato e `maintenance_record`.

5. Gate M8 esteso con test HTTP per R9:

   - avvio e completamento;
   - transizioni incompatibili;
   - validazione del motivo;
   - autenticazione e autorizzazione;
   - presenza delle due rotte nel contratto OpenAPI.

   **Risultato:** 36 test superati su 36.

6. Verifica manuale dalla dashboard:

   - selezione e deselezione del marker;
   - aggiornamento del marker e della status bar;
   - avvio e completamento dal pannello;
   - corretta sostituzione dei comandi in base allo stato.

7. Aggiunto un test Playwright del flusso completo di manutenzione. Il test seleziona direttamente un marker `AVAILABLE`, avvia e completa la manutenzione e ripristina lo stato iniziale per non contaminare gli scenari successivi.

## File principali coinvolti

- `packages/shared/src/api-routes.ts`
- `packages/shared/src/maintenance.ts`
- `packages/shared/src/index.ts`
- `apps/api/src/gateway/dto/maintenance.dto.ts`
- `apps/api/src/gateway/maintenance.controller.ts`
- `apps/api/src/gateway/gateway.module.ts`
- `contracts/openapi.json`
- `apps/api/test/gates/M8.gate.spec.ts`
- `apps/web/src/api.ts`
- `apps/web/src/App.tsx`
- `apps/web/src/components/FleetMap.tsx`
- `apps/web/src/components/MaintenancePanel.tsx`
- `apps/web/src/styles.css`
- `e2e/operator-dashboard.e2e.spec.ts`

## Nota architetturale

Non è stata modificata la logica del dominio: `MaintenanceManager` e la macchina a stati erano già corretti. Le modifiche hanno reso il caso d'uso R9 raggiungibile attraverso il percorso completo:

```text
Dashboard
    → API Gateway
        → MaintenancePort
            → MaintenanceManager
                → database e notifiche
```
# ROAd - Resoconto modifiche R14: cancellazione della corsa

**Data:** 17 agosto 2026  
**Autore:** Pasquale Ludovico Ignarra  
**Argomento:** Implementazione della cancellazione delle corse nell’app passeggero

## Obiettivo

Rendere la cancellazione di una corsa utilizzabile direttamente dall’app passeggero, completando il collegamento tra l’interfaccia React, il contratto API pubblico e la logica di dominio già presente nel backend.

La cancellazione deve essere consentita fino all’inizio effettivo della corsa e deve richiedere una conferma esplicita, così da evitare operazioni accidentali.

## Situazione iniziale

La logica di dominio e il backend implementavano già quanto previsto da R14:

- cancellazione delle richieste immediate e delle prenotazioni anticipate;
- endpoint `POST /rides/:rideRequestId/cancel`;
- verifica dell’identità del passeggero proprietario della richiesta;
- cancellazione negli stati precedenti a `IN_RIDE`;
- rifiuto della cancellazione dopo l’inizio della corsa;
- rilascio delle prenotazioni associate;
- ritorno del robotaxi allo stato disponibile;
- revoca del percorso attivo;
- invio delle notifiche WebSocket relative alla cancellazione.

La funzionalità non era però raggiungibile dall’app passeggero, perché mancavano la chiamata API, il comando nell’interfaccia e la gestione dello stato cancellato restituito dal server.

## Modifiche al client API

1. Importata la funzione condivisa `rideCancelRoute`.

2. Aggiunta in `apps/passenger/src/api.ts` la funzione:

   `cancelRide(token, rideRequestId)`

3. La nuova funzione:

   - costruisce la rotta attraverso il contratto condiviso;
   - utilizza il metodo HTTP `POST`;
   - invia il token del passeggero;
   - valida la risposta tramite `rideRequestResponseSchema`;
   - restituisce una `RideRequestResponse` tipizzata.

4. Non sono stati duplicati percorsi API o schemi già presenti in `@road/shared`.

## Gestione dello stato della corsa

1. Modificata la funzione `initialView()` in `apps/passenger/src/ride-phase.ts`.

2. Gli stati terminali restituiti direttamente dall’API vengono ora riconosciuti immediatamente:

   - `CANCELLED` viene mostrato come `cancelled`;
   - `COMPLETED` viene mostrato come `completed`;
   - `REJECTED` viene mostrato come `rejected`.

3. La risposta alla cancellazione aggiorna quindi immediatamente l’interfaccia, senza dover attendere una successiva notifica WebSocket.

4. Per le richieste ancora attive rimane invariata la distinzione tra:

   - `searching`;
   - `assigned`;
   - `arriving`;
   - `arrived`;
   - `in_ride`.

## Modifiche all’app passeggero

1. Aggiunta in `App.tsx` la gestione della cancellazione tramite:

   - stato di caricamento dedicato;
   - stato di errore dedicato;
   - funzione `cancelCurrentRide()`.

2. La funzione di cancellazione:

   - controlla la presenza della sessione e della richiesta;
   - chiama l’endpoint pubblico;
   - aggiorna la richiesta con la risposta del backend;
   - gestisce separatamente gli errori;
   - effettua il logout se il token è scaduto;
   - impedisce richieste duplicate durante il caricamento.

3. Il reset della richiesta pulisce anche gli stati relativi alla cancellazione.

4. La gestione della cancellazione resta separata dalla gestione della richiesta iniziale e dagli aggiornamenti WebSocket.

## Modifiche al pannello di stato

1. Aggiunto il pulsante **Annulla corsa** nel pannello di stato del passeggero.

2. Il comando è disponibile soltanto nelle fasi:

   - `searching`;
   - `assigned`;
   - `arriving`;
   - `arrived`.

3. Quando la corsa entra nello stato `in_ride`, il pulsante scompare e la cancellazione non è più raggiungibile dall’interfaccia.

4. Durante la chiamata API il pulsante viene disabilitato e mostra lo stato **Annullamento in corso…**.

5. Gli eventuali errori vengono mostrati nel pannello senza interferire con gli altri stati dell’applicazione.

6. Dopo una cancellazione completata:

   - viene mostrato lo stato **Corsa annullata**;
   - il comando di cancellazione scompare;
   - compare il pulsante **Richiedi un’altra corsa**.

## Conferma della cancellazione

1. Aggiunta una finestra modale di conferma per evitare cancellazioni accidentali.

2. Il primo comando **Annulla corsa** non chiama direttamente l’API, ma apre la finestra di conferma.

3. La finestra presenta due possibilità:

   - **Sì, annulla**, che conferma l’operazione e chiama l’API;
   - **No, mantieni la corsa**, che chiude la finestra senza modificare la richiesta.

4. La finestra utilizza gli attributi di accessibilità:

   - `role="dialog"`;
   - `aria-modal="true"`;
   - `aria-labelledby`.

5. Sono stati aggiunti identificatori `data-testid` dedicati per rendere verificabile l’intero flusso tramite Playwright.

## Modifiche grafiche

1. Aggiunti gli stili del comando di cancellazione.

2. Aggiunto uno stile dedicato per le azioni potenzialmente distruttive.

3. Realizzato un overlay a schermo intero per la conferma.

4. La finestra di conferma è:

   - centrata;
   - responsive;
   - utilizzabile sia su desktop sia su schermi di dimensioni simili a uno smartphone;
   - coerente con i colori e le superfici già utilizzati dall’app passeggero.

5. Aggiunto uno stile secondario per il comando che mantiene attiva la corsa.

## Test unitari

1. Esteso `apps/passenger/test/ride-phase.spec.ts`.

2. Aggiunto un test specifico per R14 che verifica che una `RideRequestResponse` con stato `CANCELLED` venga trasformata immediatamente nella fase visuale `cancelled`.

3. Risultato della suite:

   - 19 test suite superate su 19;
   - 211 test superati su 211.

## Gate M8

1. Aggiunta la rotta di cancellazione all’elenco delle operazioni che devono essere presenti nel contratto OpenAPI.

2. Il gate verifica ora esplicitamente la presenza di:

   `POST /rides/:rideRequestId/cancel`

3. Risultato:

   - 1 test suite superata;
   - 37 test superati su 37.

## Test end-to-end

1. Aggiunto uno scenario Playwright dedicato a R14.

2. Il test esegue il seguente flusso attraverso l’interfaccia reale:

   - registra e autentica un nuovo passeggero;
   - seleziona ritiro e destinazione;
   - richiede una corsa;
   - apre la conferma di cancellazione;
   - sceglie inizialmente **No, mantieni la corsa**;
   - verifica che la corsa rimanga attiva;
   - riapre la conferma;
   - sceglie **Sì, annulla**;
   - verifica il passaggio allo stato `cancelled`;
   - verifica la scomparsa del comando di cancellazione;
   - verifica la comparsa del comando per richiedere una nuova corsa.

3. Risultato complessivo Playwright:

   - 11 test superati su 11.

## Verifiche manuali

Sono stati verificati manualmente i seguenti casi:

1. Cancellazione di una corsa immediata prima dell’inizio.

2. Cancellazione di una prenotazione anticipata.

3. Mantenimento della corsa scegliendo **No** nella finestra di conferma.

4. Cancellazione effettiva scegliendo **Sì**.

5. Scomparsa del comando quando la corsa entra nello stato `in_ride`.

6. Visualizzazione dello stato terminale `cancelled`.

7. Comparsa del comando per richiedere una nuova corsa.

8. Ritorno del robotaxi allo stato disponibile.

## Stabilizzazione dell’harness di verifica

Durante `pnpm verify` è stata individuata una condizione di concorrenza preesistente tra i gate M1 e M9.

Entrambi i gate potevano ricostruire contemporaneamente `apps/api/dist`. Una build poteva quindi cancellare temporaneamente i file compilati mentre l’altra stava eseguendo migrazioni o seed, causando errori intermittenti come:

`Cannot find module '../persistence/persistence.module'`

Per rendere la verifica deterministica:

1. aggiunta l’opzione `--runInBand` al passo `gate` di `tools/verify/verify.mjs`;

2. aggiunta la stessa opzione allo script `test:gate` del `package.json`;

3. i gate vengono ora eseguiti in sequenza, evitando scritture concorrenti nella stessa directory di build.

La modifica rende la verifica leggermente più lenta, ma elimina una possibile causa di fallimenti intermittenti.

## Verifica finale

Sono stati completati correttamente:

- formattazione Prettier;
- lint ESLint;
- typecheck TypeScript;
- test unitari;
- test di integrazione;
- verifica del contratto OpenAPI;
- verifica architetturale;
- gate delle milestone;
- tracciabilità dei requisiti;
- test end-to-end Playwright;
- comando completo `pnpm verify`.

## File principali coinvolti

- `apps/api/test/gates/M8.gate.spec.ts`
- `apps/passenger/src/App.tsx`
- `apps/passenger/src/api.ts`
- `apps/passenger/src/components/StatusPanel.tsx`
- `apps/passenger/src/ride-phase.ts`
- `apps/passenger/src/styles.css`
- `apps/passenger/test/ride-phase.spec.ts`
- `e2e/passenger-ride.e2e.spec.ts`
- `package.json`
- `tools/verify/verify.mjs`

## Nota architetturale

La logica del dominio e il controller di cancellazione non sono stati modificati, perché implementavano già correttamente R14.

Le modifiche hanno reso il caso d’uso raggiungibile attraverso il percorso completo:

`App passeggero -> contratto API condiviso -> endpoint di cancellazione -> logica di dominio -> persistenza e notifiche`

Il backend resta la sorgente autoritativa delle transizioni: la scomparsa del pulsante nello stato `in_ride` migliora l’esperienza utente, mentre il controllo server impedisce comunque una cancellazione non valida anche in presenza di una richiesta HTTP costruita manualmente.