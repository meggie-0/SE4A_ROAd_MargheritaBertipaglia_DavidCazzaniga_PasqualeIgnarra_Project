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

# ROAd - Resoconto modifiche app passeggero 1

**Data:** 18 agosto 2026  
**Autore:** Pasquale Ludovico Ignarra  
**Argomento:** Aggiornamento interfaccia utente app 

## Tema, palette e asset grafici

1. Introdotta la palette ROAd condivisa tra tema giorno e tema notte tramite variabili CSS.

2. Aggiunta la gestione persistente del tema:

   - caricamento della preferenza salvata;
   - applicazione del tema al documento;
   - passaggio tra modalità giorno e notte;
   - mantenimento della scelta dopo il riavvio dell'app.

3. Preparati e collegati i loghi dedicati ai due temi:

   - logo scuro per il tema giorno;
   - logo bianco per il tema notte.

4. Aggiornate le favicon dinamiche e mantenuta la trasparenza degli asset.

5. Estratta dal logo ROAd la sagoma originale del taxi, salvata come PNG trasparente e utilizzata come maschera CSS. In questo modo l'icona assume automaticamente il colore previsto dal tema e dallo stato di selezione.

## Nuovo contenitore mobile

1. Rappresentata l'app come una superficie verticale delle dimensioni di uno smartphone nella demo desktop.

2. Su smartphone reale la cornice viene rimossa e l'app occupa l'intero viewport.

3. Conservata la schermata di login esistente, adattandola al nuovo contenitore senza modificarne il funzionamento.

4. Trasformata la mappa di Milano nello sfondo a tutto schermo della vista autenticata.

5. Convertiti i pannelli di richiesta, stato e profilo in superfici sovrapposte alla mappa.

6. Aggiunto il supporto alle safe area superiore e inferiore per evitare interferenze con fotocamera, notch e barra di navigazione dello smartphone.

## Barra superiore e menu account

1. Sostituita l'intestazione desktop nella vista autenticata con una barra mobile composta da:

   - comando **Dove si va?**;
   - indicazione progressiva della selezione del percorso;
   - pulsante hamburger per l'apertura del menu account.

2. Posizionata la barra sotto la safe area superiore.

3. Creato un menu laterale con:

   - iniziali, nome, cognome, e-mail e telefono del passeggero;
   - apertura del profilo;
   - cambio tema;
   - logout.

4. Aggiunti backdrop, comando di chiusura e comportamento coerente per mouse, touch e tastiera.

5. Aggiornato il test end-to-end del profilo per aprire profilo e logout attraverso il nuovo menu.

## Pannello di scelta del servizio

1. Ridisegnata la selezione tra:

   - **Corsa immediata**;
   - **Programma corsa**.

2. Sostituiti i radio button visibili con card interamente cliccabili, conservando gli input radio nascosti per accessibilità e test automatici.

3. Evidenziato il servizio selezionato tramite bordo, sfondo e indicatore circolare con pallino centrale.

4. Inserite un'icona taxi derivata dal logo ROAd e un'icona calendario.

5. Mantenuto il selettore di data e ora solamente per la corsa programmata.

6. Uniformati i comandi **Prenota corsa** e **Azzera percorso**:

   - stessa forma e dimensione;
   - pulsante principale pieno;
   - pulsante di azzeramento con bordo colorato e sfondo trasparente.

7. Rimossi elementi grafici che suggerivano funzioni non presenti, come il trascinamento del bottom sheet.

8. Esteso il pannello verso il fondo dello smartphone rispettando la safe area inferiore.

## Scrollbar dei pannelli

1. Resa invisibile la scrollbar dei pannelli quando non è in uso.

2. Aggiunta la classe temporanea `panel--scrolling` durante lo scorrimento.

3. La scrollbar appare durante l'interazione e scompare gradualmente al termine.

4. Ridotte dimensioni e visibilità della barra, eliminando i pulsanti alle estremità dove supportato dal browser.

## Selezione del percorso

1. Resa cliccabile la barra **Dove si va?**.

2. Creato `RoutePickerPanel`, integrato direttamente nella barra superiore come menu a tendina.

3. Durante la selezione:

   - il pulsante hamburger scompare;
   - la barra occupa tutta la larghezza disponibile;
   - compaiono i campi **Partenza** e **Destinazione**;
   - il campo attivo viene evidenziato;
   - il click sulla mappa aggiorna il campo selezionato.

4. Dopo la scelta della partenza il campo attivo passa automaticamente alla destinazione.

5. Quando entrambi i punti sono completi, il menu si chiude automaticamente e ricompare il pannello dei servizi.

6. Rimossi dal menu i comandi espliciti **Conferma** e **Azzera**, adottando un flusso più simile alle applicazioni di navigazione.

7. Sostituita la lente con una freccia durante la selezione. Solamente la freccia è cliccabile per tornare indietro; il relativo cerchio compare al passaggio del mouse o durante la navigazione da tastiera.

8. Aggiunta un'animazione di apertura verso il basso, disattivata quando il sistema richiede la riduzione delle animazioni.

9. Conservata la possibilità di selezionare direttamente i due punti sulla mappa senza aprire il menu, mantenendo il flusso rapido già previsto.

## Mappa e area operativa

1. Rimossi i controlli Leaflet `+` e `−`, mantenendo zoom tramite rotellina, doppio click e gesture touch.

2. Centrata la mappa su Milano e limitata la navigazione all'area operativa tramite:

   - zoom minimo;
   - `maxBounds`;
   - limite rigido allo spostamento.

3. Creata una definizione riutilizzabile dell'area di servizio, destinata anche alle successive verifiche di indirizzi e posizione GPS.

4. Scartata la visualizzazione di un perimetro viola perché rendeva la mappa artificiale.

5. La gestione prevista per punti esterni consiste in un messaggio esplicito di servizio non disponibile, anziché in un confine disegnato sulla mappa.

## Compatibilità e vincoli preservati

1. Non sono stati modificati gli endpoint, i payload o i contratti pubblici della prenotazione.

2. Sono stati mantenuti i principali `data-testid` esistenti, inclusi quelli relativi a:

   - tipo di corsa;
   - data programmata;
   - partenza e destinazione;
   - invio della richiesta;
   - azzeramento del percorso;
   - profilo e logout.

3. La logica di assegnazione, le notifiche WebSocket e la progressione della corsa restano invariate.


## File principali coinvolti

- `apps/passenger/index.html`
- `apps/passenger/public/road-logo-light.png`
- `apps/passenger/public/road-logo-dark.png`
- `apps/passenger/public/road-favicon-light.png`
- `apps/passenger/public/road-favicon-dark.png`
- `apps/passenger/public/road-taxi-icon.png`
- `apps/passenger/src/App.tsx`
- `apps/passenger/src/theme.ts`
- `apps/passenger/src/service-area.ts`
- `apps/passenger/src/components/RequestPanel.tsx`
- `apps/passenger/src/components/RoutePickerPanel.tsx`
- `apps/passenger/src/components/RideMap.tsx`
- `apps/passenger/src/components/StatusPanel.tsx`
- `apps/passenger/src/styles.css`
- `e2e/passenger-ride.e2e.spec.ts`

# ROAd - Resoconto modifiche app passeggero 2

**Data:** 19 agosto 2026  
**Autore:** Pasquale Ludovico Ignarra  
**Argomento:** Miglioramento della corsa live e gestione completa delle corse programmate

## Validazione di partenza e destinazione

1. Migliorata la gestione degli errori durante la selezione di un punto sulla mappa.

2. Separati gli errori bloccanti dagli avvisi non bloccanti relativi all’indirizzo selezionato.

3. Aggiunto il controllo dell’appartenenza del punto all’area di servizio di Milano.

4. Aggiunto lo spostamento automatico del punto selezionato verso la strada percorribile più vicina.

5. Migliorata la ricerca dell’indirizzo tramite reverse geocoding.

6. Quando il servizio non restituisce una via precisa, il punto rimane comunque utilizzabile e vengono mostrate le coordinate o il nome della zona restituito dal provider.

7. Aggiunti messaggi distinti per:

   - punto esterno al Comune di Milano;
   - punto troppo lontano da una strada raggiungibile;
   - impossibilità temporanea di verificare il punto;
   - indirizzo leggibile non disponibile.

8. Applicati gli stessi controlli anche alla posizione corrente ottenuta tramite geolocalizzazione del dispositivo.

## Miglioramento del pannello di stato

1. Evidenziate in verde anche le descrizioni delle fasi già completate.

2. Mantenuta in blu solamente la fase corrente della corsa.

3. Migliorata la visualizzazione del tempo stimato di arrivo.

4. Introdotti due formati:

   - `mm min` quando il tempo residuo è inferiore a un’ora;
   - `hh:mm` quando il tempo residuo è uguale o superiore a un’ora.

5. Il tempo residuo viene aggiornato con il trascorrere dei minuti a partire dall’istante dell’ultima notifica contenente l’ETA.

6. Mantenuta la precedente disposizione del testo relativo all’arrivo stimato, modificando solamente il formato temporale.

7. Rimossi alcuni messaggi secondari in grigio considerati superflui durante la corsa.

## Visualizzazione del robotaxi

1. Sostituito il precedente indicatore circolare del robotaxi con la stessa icona taxi utilizzata nella card **Corsa immediata**.

2. L’icona viene generata attraverso la maschera CSS già derivata dal logo ROAd.

3. Stabilizzate le dimensioni del marker durante le operazioni di zoom e de-zoom della mappa.

4. Personalizzati bordo, sfondo e contrasto del marker per mantenerlo leggibile sulla cartografia.

5. Adattati automaticamente i colori del robotaxi ai temi giorno e notte.

6. Riutilizzata la stessa icona anche nel cerchio di selezione del servizio, mantenendo coerenza visiva tra pannello e mappa.

## Percorso stradale e aggiornamento della mappa

1. Sostituito il collegamento in linea d’aria con un percorso costruito lungo le strade della mappa.

2. Il percorso viene richiesto al servizio di routing e disegnato utilizzando il colore principale della palette ROAd.

3. Mantenuto un comportamento di fallback nel caso in cui il servizio di routing non sia disponibile.

4. Durante l’avvicinamento viene mostrato il percorso tra il robotaxi e il punto di ritiro.

5. Dopo il prelievo:

   - il punto di partenza viene rimosso;
   - il robotaxi rimane visibile;
   - il percorso viene aggiornato tra la posizione del robotaxi e la destinazione.

6. Alla conclusione della corsa:

   - il percorso viene rimosso;
   - il punto di partenza rimane nascosto;
   - sulla mappa resta solamente la destinazione;
   - la vista viene spostata e ingrandita automaticamente sulla destinazione.

7. Il passaggio tra i diversi percorsi dipende dalla fase visuale derivata dalle notifiche e non introduce una nuova macchina a stati nel client.

## Calendario e tema notte

1. Migliorata l’integrazione del selettore nativo di data e ora mostrato per le corse programmate.

2. Aggiunta un’icona del calendario sovrapposta a quella nativa quando quest’ultima non è sufficientemente visibile.

3. Conservata la possibilità di aprire il selettore cliccando sull’area dell’icona.

4. Ridotta l’intensità dell’evidenziazione della data selezionata, evitando che il colore copra completamente il numero del giorno.

5. Adattati al tema notte i colori delle icone relative a:

   - partenza;
   - destinazione;
   - posizione corrente;
   - marker presenti sulla mappa;
   - robotaxi.

6. Adattati alla palette purple ROAd anche i cerchi associati alla freccia di ritorno e ai comandi di cancellazione dei punti.

7. Tutte le modifiche utilizzano le variabili CSS della palette esistente, senza introdurre colori separati per singolo componente.

## Contratto condiviso delle prenotazioni

1. Aggiunta la nuova rotta:

   ```http
   GET /rides/bookings
   ```

2. Aggiunto lo schema Zod `passengerBookingsResponseSchema`.

3. Aggiunto il tipo condiviso `PassengerBookingsResponse`.

4. La risposta utilizza la seguente struttura:

   ```json
   {
     "bookings": []
   }
   ```

5. Il contenitore permette di aggiungere in futuro metadati o paginazione senza cambiare la forma principale della risposta.

6. Il contratto continua a essere definito in `@road/shared`, senza importazioni dirette dal backend nei client.

## Gestione delle prenotazioni nel backend

1. Estesa `RideRequestPort` con l’operazione:

   `listBookings(passengerId)`

2. Introdotto il tipo di dominio `PassengerBooking`, composto dal record della richiesta e dal record della prenotazione.

3. Implementata nel `RideRequestManager` la lettura delle prenotazioni appartenenti al passeggero autenticato.

4. L’elenco include solamente richieste:

   - di tipo `ADVANCE`;
   - con stato `ACCEPTED`;
   - non annullate;
   - non ancora elaborate dall’attivatore.

5. Le prenotazioni vengono ordinate per data e ora del ritiro.

6. Non è stato introdotto alcun limite al numero di prenotazioni dello stesso passeggero, perché tale vincolo non rappresenta un elemento centrale del progetto.

7. Aggiunti il DTO Swagger e il metodo corrispondente in `RidesController`.

8. L’endpoint è protetto tramite:

   - `JwtAuthGuard`;
   - `RolesGuard`;
   - ruolo `PASSENGER`.

9. Un passeggero senza prenotazioni riceve correttamente un elenco vuoto e non un errore HTTP.

10. Non sono state apportate modifiche all’interfaccia dell’app operatore.

## Client API delle prenotazioni

1. Aggiunta in `apps/passenger/src/api.ts` la funzione:

   `fetchPassengerBookings(token)`

2. La funzione:

   - utilizza la rotta definita in `API_ROUTES`;
   - invia il token del passeggero;
   - utilizza il metodo HTTP `GET`;
   - valida la risposta con `passengerBookingsResponseSchema`.

3. Esteso `RideRequestDraft` con gli indirizzi leggibili di partenza e destinazione.

4. Le richieste immediate e programmate inviano ora, quando disponibili:

   - `pickupAddress`;
   - `destinationAddress`.

5. Le coordinate restano la sorgente utilizzata dal dominio, mentre gli indirizzi vengono conservati per migliorare la leggibilità dell’interfaccia.

## Separazione tra prenotazione e corsa live

1. Individuato il comportamento precedente per cui ogni risposta alla funzione `submit()` veniva salvata nello stato `request`.

2. Tale comportamento faceva apparire una corsa programmata come una corsa immediatamente attiva.

3. Modificato il flusso in modo che solamente una corsa immediata venga inserita direttamente nella vista live.

4. Una prenotazione anticipata accettata viene ora conservata nello stato dedicato `bookingConfirmation`.

5. La prenotazione non apre più automaticamente `StatusPanel`.

6. Una prenotazione rifiutata continua a mostrare lo stato terminale di indisponibilità del servizio.

7. Le prenotazioni future vengono caricate tramite TanStack Query e mantenute separate dalla posizione del robotaxi.

8. Dopo creazione o cancellazione viene invalidata solamente la query relativa alle prenotazioni del passeggero.

## Pannello di conferma della prenotazione

1. Creato `BookingConfirmationPanel`.

2. Il pannello viene mostrato immediatamente dopo l’accettazione di una corsa programmata.

3. La conferma mostra:

   - esito positivo della prenotazione;
   - data e ora del ritiro;
   - indirizzo di partenza;
   - indirizzo di destinazione.

4. Aggiunti i comandi:

   - **Vedi le mie prenotazioni**;
   - **Prenota un’altra corsa**.

5. Il pannello non utilizza la progressione della corsa live e non mostra un robotaxi assegnato prima dell’attivazione.

6. Rimossa la barra grigia superiore, perché avrebbe suggerito una funzione di trascinamento non ancora disponibile.

## Pannello delle prenotazioni

1. Creato `BookingsPanel`.

2. Il pannello mostra tutte le prenotazioni ancora in attesa di attivazione.

3. Ogni card contiene:

   - data e ora programmata;
   - punto di partenza;
   - destinazione;
   - comando di annullamento.

4. La prenotazione appena creata viene evidenziata.

5. Aggiunta una finestra di conferma prima dell’annullamento.

6. Durante la chiamata API il comando viene disabilitato e mostra lo stato **Annullamento in corso…**.

7. Dopo l’annullamento viene invalidata la query e la prenotazione scompare dall’elenco.

8. Aggiunto il comando **Prenota un’altra corsa**.

9. Rimossa la barra grigia superiore anche da questo pannello.

10. Aggiunti stili compatibili con i temi giorno e notte tramite le variabili della palette ROAd.

## Accesso dal menu hamburger

1. Aggiunta al menu account la voce **Le mie prenotazioni**.

2. Accanto alla voce viene mostrato il numero delle prenotazioni ancora attive.

3. Il contatore utilizza una forma circolare e i colori della palette corrente.

4. La voce è disponibile quando non è in corso una corsa live.

5. Il pannello può quindi essere raggiunto:

   - direttamente dalla conferma di una nuova prenotazione;
   - successivamente attraverso il menu hamburger.

6. La chiusura del pannello restituisce l’utente alla schermata precedente senza modificare le prenotazioni.

## Attivazione della corsa programmata

1. Aggiunta la gestione della notifica WebSocket relativa all’assegnazione del robotaxi.

2. La semplice notifica iniziale `SCHEDULED` non apre la vista live.

3. L’app attende una notifica che contenga:

   - lo stesso identificatore della prenotazione;
   - `robotaxiState: ASSIGNED`;
   - un identificatore del robotaxi non nullo.

4. Quando la notifica viene ricevuta:

   - la prenotazione diventa la richiesta attiva;
   - vengono ripristinati sulla mappa partenza e destinazione;
   - viene associato il robotaxi assegnato;
   - vengono chiusi conferma, elenco prenotazioni, profilo e menu;
   - viene aperto il normale `StatusPanel`;
   - viene aggiornata la query delle prenotazioni.

5. Da quel momento il flusso torna a utilizzare la progressione live già esistente e le successive notifiche WebSocket.

6. Non è stata introdotta una nuova macchina a stati nel frontend: l’app reagisce all’evento prodotto dal backend.

## Test e verifiche

1. Eseguita la formattazione dei file modificati tramite Prettier.

2. Eseguito il typecheck TypeScript dell’intero workspace.

3. Rigenerato `contracts/openapi.json` tramite:

   `pnpm contract:update`

4. Test del contratto OpenAPI superati:

   - 1 test suite superata;
   - 2 test superati su 2.

5. Verificata manualmente la nuova interfaccia delle prenotazioni nel contesto della mappa.

6. Verificata manualmente la presenza del contatore nel menu hamburger.

7. Verificata manualmente la separazione tra conferma della prenotazione e pannello della corsa live.

8. La verifica completa tramite `pnpm verify` e l’aggiornamento dei test automatici sono rimandati alla fase successiva.

## File principali coinvolti

- `packages/shared/src/api-routes.ts`
- `packages/shared/src/rides.ts`
- `apps/api/src/rides/rides.port.ts`
- `apps/api/src/rides/ride-request.manager.ts`
- `apps/api/src/gateway/dto/rides.dto.ts`
- `apps/api/src/gateway/rides.controller.ts`
- `contracts/openapi.json`
- `apps/passenger/src/api.ts`
- `apps/passenger/src/App.tsx`
- `apps/passenger/src/address-search.ts`
- `apps/passenger/src/ride-phase.ts`
- `apps/passenger/src/components/BookingConfirmationPanel.tsx`
- `apps/passenger/src/components/BookingsPanel.tsx`
- `apps/passenger/src/components/RequestPanel.tsx`
- `apps/passenger/src/components/RideMap.tsx`
- `apps/passenger/src/components/RoutePickerPanel.tsx`
- `apps/passenger/src/components/StatusPanel.tsx`
- `apps/passenger/src/styles.css`

## Nota architetturale

La gestione delle prenotazioni rimane separata dalla gestione della corsa live.

Una prenotazione accettata riserva una finestra temporale, ma non espone immediatamente un robotaxi assegnato. Il backend continua a essere la sorgente autoritativa dell’attivazione e comunica l’assegnazione attraverso il canale WebSocket.

Il flusso implementato è:

```text
App passeggero
    → contratto API condiviso
        → GET /rides/bookings
            → RideRequestPort
                → RideRequestManager
                    → persistenza
```

Al momento dell’attivazione:

```text
AdvanceBookingActivator
    → assegnazione del robotaxi
        → notifica WebSocket ASSIGNED
            → App passeggero
                → StatusPanel
```

L’app operatore non utilizza il nuovo endpoint e non richiede modifiche. L’effetto sull’allocazione rimane indiretto: le prenotazioni occupano le finestre temporali già gestite dal backend.



