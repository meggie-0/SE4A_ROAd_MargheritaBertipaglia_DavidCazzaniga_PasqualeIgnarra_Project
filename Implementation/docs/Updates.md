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

# ROAd - Resoconto modifiche app passeggero 3

**Data:** 20 agosto 2026
**Autore:** Pasquale Ludovico Ignarra
**Argomento:** Completamento dell’esperienza passeggero, area di servizio, mappa e stabilizzazione dei flussi

## Estensione dell’area di servizio all’Aeroporto di Linate

1. Mantenuto il Comune di Milano come area operativa principale dell’applicazione.

2. Aggiunta un’eccezione esplicita per l’Aeroporto di Milano Linate, necessario perché alcuni servizi di geocoding possono associare il terminal e le relative strade di accesso a comuni diversi da Milano.

3. Definito un punto di riferimento dedicato al terminal di Linate:

   ```text
   lat: 45.4618
   lon: 9.2786
   ```

4. Definita una tolleranza di servizio di circa 700 metri attorno al terminal, sufficiente a comprendere:

   * terminal;
   * area Kiss&Ride;
   * gate;
   * viabilità immediatamente collegata all’aeroporto.

5. Aggiunte in `service-area.ts` funzioni dedicate per riconoscere:

   * punti appartenenti all’area di Linate;
   * indirizzi relativi all’aeroporto;
   * ricerche testuali riconducibili a Linate.

6. Il riconoscimento considera anche formulazioni come:

   * `Linate`;
   * `Aeroporto Linate`;
   * `Aeroporto di Milano Linate`;
   * `Terminal`;
   * `Gate`;
   * `Kiss&Ride`;
   * arrivi e partenze.

7. Aggiornata la validazione dei punti scelti sulla mappa:

   * i punti nel Comune di Milano continuano a essere accettati;
   * i punti nell’area del terminal di Linate vengono accettati anche se il geocoder li classifica fuori dal Comune di Milano;
   * tutti gli altri punti esterni vengono rifiutati con un messaggio esplicito.

8. Applicata la stessa eccezione anche alla posizione corrente ottenuta tramite GPS.

9. Aggiornati i messaggi mostrati all’utente in modo da indicare chiaramente che il servizio è disponibile nel:

   * Comune di Milano;
   * Aeroporto di Milano Linate.

## Ricerca dell’Aeroporto di Linate

1. Integrata l’eccezione di Linate anche nella ricerca testuale degli indirizzi.

2. Le query riconducibili all’aeroporto producono direttamente un suggerimento dedicato:

   **Aeroporto di Milano Linate — Terminal / Kiss&Ride**

3. Il suggerimento utilizza il punto canonico del terminal, evitando risultati incoerenti prodotti dal geocoder.

4. La gestione speciale è effettuata prima della normale ricerca MapTiler, mantenendo invariata la ricerca standard degli altri indirizzi di Milano.

5. I risultati restituiti normalmente dal geocoder vengono comunque controllati per riconoscere eventuali riferimenti a Linate.

## Marker delle zone di Milano

1. Sostituiti i precedenti marker generici delle zone con marker grafici personalizzati.

2. Creato un set di icone SVG dedicato alle diverse zone mostrate sulla mappa.

3. Gli asset sono stati organizzati nella cartella:

   `apps/passenger/public/zone-icons/`

4. Aggiunte icone per le principali zone e punti di riferimento, tra cui:

   * Duomo;
   * Navigli;
   * Cadorna;
   * CityLife;
   * San Siro;
   * Stazione Centrale;
   * Porta Garibaldi;
   * Porta Venezia;
   * Porta Romana;
   * Isola;
   * Bicocca;
   * Lambrate;
   * Politecnico Leonardo;
   * Politecnico Bovisa;
   * Rho Fiera;
   * Linate.

5. I marker utilizzano una maschera CSS, permettendo di adattarne automaticamente il colore al tema corrente.

6. Aggiunto un tooltip al passaggio del mouse per mostrare il nome della zona.

7. Per Linate:

   * utilizzata un’icona dedicata;
   * il marker viene posizionato sul terminal reale invece che sul centro astratto della zona;
   * il tooltip specifica che il Terminal / Kiss&Ride è raggiungibile.

8. Mantenuti separati dai marker delle zone:

   * il pin di partenza;
   * la bandiera della destinazione;
   * il marker del robotaxi.

## Conferme di annullamento

1. Estratta la finestra di conferma in un componente riutilizzabile `ConfirmationDialog`.

2. Lo stesso componente viene ora utilizzato per:

   * annullamento della corsa live;
   * annullamento di una corsa programmata.

3. La finestra viene renderizzata tramite `createPortal`.

4. Il portal utilizza come host l’intero contenitore `.passenger-app`, invece del singolo pannello che ha richiesto la conferma.

5. In questo modo l’overlay:

   * copre l’intera superficie dello smartphone;
   * non rimane confinato nel bottom panel;
   * mantiene la conferma visivamente centrale;
   * funziona allo stesso modo per corsa immediata e prenotazione.

6. Mantenuti gli attributi di accessibilità e i `data-testid` necessari ai test automatici.

## Stabilizzazione della gestione delle prenotazioni

1. Consolidato il flusso introdotto il giorno precedente per le corse programmate.

2. Verificata la separazione tra:

   * prenotazione futura;
   * corsa live.

3. Una prenotazione accettata continua a non essere trattata come una corsa già attiva.

4. L’elenco delle prenotazioni viene riletto dal backend anche dopo un reload dell’applicazione.

5. L’attivazione della prenotazione continua a dipendere dalla notifica WebSocket `ASSIGNED` prodotta dal backend.

6. Al momento dell’attivazione vengono ripristinati:

   * partenza;
   * destinazione;
   * robotaxi assegnato;
   * normale `StatusPanel` della corsa live.

7. La query delle prenotazioni viene invalidata dopo le operazioni che ne modificano il contenuto.

## Aggiornamento dei test end-to-end

1. Aggiornato il flusso Playwright di selezione del percorso per utilizzare la nuova interfaccia:

   * apertura di **Dove si va?**;
   * selezione della partenza;
   * passaggio automatico alla destinazione;
   * selezione della destinazione;
   * apertura automatica della scelta del servizio.

2. Esteso lo scenario relativo alle corse programmate per verificare:

   * conferma della prenotazione;
   * separazione dalla corsa live;
   * apertura dell’elenco delle prenotazioni;
   * persistenza della prenotazione dopo il reload;
   * recupero dell’elenco tramite backend;
   * conferma dell’annullamento;
   * scomparsa della prenotazione cancellata.

3. Mantenuto lo scenario R14 per verificare sia:

   * **No, mantieni la corsa**;
   * **Sì, annulla**.

4. Aggiornato lo scenario di modifica del profilo per utilizzare il menu hamburger.

5. Aggiunta una verifica esplicita del numero di interazioni necessario a richiedere una corsa da avvio a freddo.

6. Il flusso rapido richiede al massimo quattro interazioni principali:

   * apertura della ricerca;
   * selezione della partenza;
   * selezione della destinazione;
   * richiesta della corsa.

7. Rafforzato il gate M8 affinché controlli anche l’esistenza e l’eseguibilità degli scenari end-to-end previsti dalla milestone.

## Verifiche automatiche

Prima dell’ultima fase di rifinitura estetica sono stati completati con esito positivo:

* formattazione;
* lint;
* typecheck TypeScript;
* test unitari;
* test di integrazione;
* verifica del contratto;
* verifica architetturale;
* gate delle milestone;
* tracciabilità dei requisiti;
* test end-to-end Playwright;
* comando completo `pnpm verify`.

La parte funzionale principale dell’app passeggero è stata quindi considerata stabilizzata prima di procedere con gli ultimi interventi puramente estetici e di UX.

## Restyling della schermata di login e registrazione

1. Avviata la fase finale di rifinitura estetica dell’app procedendo schermata per schermata.

2. Rimossa dalla schermata di login la possibilità di cambiare direttamente tema.

3. Il comando giorno/notte rimane disponibile nel menu hamburger dopo l’autenticazione.

4. Centrato maggiormente il logo ROAd e aumentate le sue dimensioni.

5. Rimosso il titolo:

   **ROAd — App passeggero**

6. Promosso a titolo principale il testo:

   **Accedi per richiedere una corsa**

7. In modalità registrazione viene mantenuto il titolo:

   **Crea un account**

8. Aggiunto un bordo viola al pannello centrale.

9. Modificato lo sfondo dei campi e-mail, password, nome e cognome in modo da utilizzare superfici coerenti con quelle della dashboard.

10. Conservato integralmente il funzionamento della modalità registrazione.

11. Migliorato l’attributo `autocomplete` della password distinguendo:

* password corrente durante il login;
* nuova password durante la registrazione.

12. Aggiunte leggere animazioni di ingresso separate per:

* logo;
* pannello di autenticazione.

13. Le animazioni rispettano `prefers-reduced-motion`.

14. Tutti gli interventi continuano a utilizzare le variabili della palette ROAd e risultano quindi compatibili con i temi giorno e notte.

## File principali coinvolti

* `apps/passenger/public/zone-icons/*.svg`
* `apps/passenger/src/App.tsx`
* `apps/passenger/src/address-search.ts`
* `apps/passenger/src/service-area.ts`
* `apps/passenger/src/components/ConfirmationDialog.tsx`
* `apps/passenger/src/components/BookingsPanel.tsx`
* `apps/passenger/src/components/LoginScreen.tsx`
* `apps/passenger/src/components/RideMap.tsx`
* `apps/passenger/src/components/RoutePickerPanel.tsx`
* `apps/passenger/src/components/StatusPanel.tsx`
* `apps/passenger/src/styles.css`
* `apps/api/test/gates/M8.gate.spec.ts`
* `e2e/passenger-ride.e2e.spec.ts`

## Nota architetturale

Le modifiche della giornata non hanno introdotto una nuova logica di dominio.

La gestione della corsa, delle prenotazioni, dell’assegnazione e delle transizioni continua a essere autoritativa nel backend.

L’app passeggero aggiunge solamente:

* validazione e presentazione dei punti dell’area operativa;
* trattamento esplicito del terminal di Linate;
* rappresentazione grafica delle zone;
* miglioramenti di interazione;
* copertura automatizzata dei flussi.

---

# ROAd - Resoconto modifiche app passeggero 4

**Data:** 21 agosto 2026
**Autore:** Pasquale Ludovico Ignarra
**Argomento:** Rifiniture estetiche finali, comportamento della mappa e validazione del percorso

## Verifica finale di login e registrazione

1. Controllato il risultato del nuovo login all’interno del contenitore mobile.

2. Confermata la corretta resa delle schermate di:

   * login;
   * registrazione;
   * tema giorno;
   * tema notte.

3. Considerata conclusa la rifinitura della schermata di autenticazione.

## Animazione del menu hamburger

1. Aggiunta un’animazione di apertura del menu account da destra verso sinistra.

2. Il pannello parte fuori dalla superficie dello smartphone e scorre nella posizione finale.

3. Aggiunto contemporaneamente un leggero fade del backdrop.

4. Utilizzata una curva di animazione coerente con le altre transizioni dell’app.

5. Le animazioni vengono disabilitate quando il sistema richiede `prefers-reduced-motion`.

## Uniformazione della X del menu

1. Sostituito il precedente carattere `×` con lo stesso SVG utilizzato per cancellare partenza e destinazione nella dashboard.

2. Riutilizzate le classi grafiche già presenti, evitando di duplicare lo stile.

3. La X eredita quindi automaticamente:

   * colore corretto nei temi giorno e notte;
   * bordo circolare;
   * sfondo colorato al passaggio del mouse;
   * stato di focus da tastiera;
   * leggera animazione alla pressione.

## Evidenziazione del logout

1. Mantenuta la voce **Esci** come azione distruttiva.

2. Impedito che l’hover generico del menu ne sostituisca il colore rosso.

3. Aggiunto uno stato dedicato per:

   * hover;
   * focus;
   * pressione.

4. In entrambi i temi la voce rimane rossa e viene accompagnata da un leggero sfondo rosso trasparente durante l’interazione.

## Rifinitura del pannello profilo

1. Aggiunta una X in alto a destra accanto al titolo **Il tuo profilo**.

2. La X utilizza lo stesso componente grafico già adottato per dashboard e menu hamburger.

3. Sostituito il precedente comando:

   **Torna alla richiesta**

   con:

   **Annulla**

4. Trasformato **Annulla** in un pulsante secondario con:

   * solo contorno;
   * sfondo trasparente;
   * dimensione comparabile al pulsante **Salva**.

5. Uniformata la larghezza dei due comandi finali.

6. Aggiunta al pannello profilo la stessa animazione di ingresso dal basso utilizzata dal pannello di scelta del servizio.

7. Il profilo viene quindi percepito come un bottom sheet appartenente allo stesso sistema visuale.

## Rifinitura del pannello delle prenotazioni

1. Applicata anche a **Le mie prenotazioni** la stessa animazione di ingresso dal basso.

2. Uniformata la X di chiusura utilizzando lo stesso SVG e gli stessi stati grafici di:

   * dashboard;
   * menu hamburger;
   * profilo.

3. Rimossa quindi la differenza visiva tra i diversi comandi di chiusura dell’app.

## Miglioramento del marker di destinazione

1. Mantenuta la bandiera come simbolo della destinazione.

2. Aggiunto un contorno bianco anche al bastoncino verticale della bandiera.

3. Il contorno è ottenuto disegnando:

   * un tratto bianco più spesso sullo sfondo;
   * il normale tratto colorato sopra di esso.

4. Il marker risulta così più leggibile indipendentemente dai colori e dai dettagli della cartografia sottostante.

## Focus automatico all’assegnazione del robotaxi

1. Aggiunto un focus automatico della mappa quando la corsa entra nella fase in cui il robotaxi è stato trovato e assegnato.

2. Al primo rilevamento del veicolo la vista viene adattata per contenere contemporaneamente:

   * posizione corrente del robotaxi;
   * punto di pickup.

3. Lo zoom è dinamico e dipende dalla distanza tra i due punti.

4. Il focus viene eseguito solamente una volta all’ingresso nella fase.

5. Gli aggiornamenti successivi della posizione del robotaxi non forzano nuovamente la vista.

6. Dopo il focus iniziale il passeggero rimane quindi libero di:

   * spostare la mappa;
   * effettuare zoom;
   * effettuare de-zoom;
   * scegliere manualmente l’inquadratura.

## Focus automatico all’inizio della corsa

1. Quando la fase passa a `in_ride`, viene eseguito un secondo e unico focus automatico.

2. In questo caso la vista comprende:

   * posizione corrente del robotaxi;
   * destinazione.

3. Anche questo focus viene effettuato una sola volta.

4. Durante il resto della corsa la posizione del taxi continua ad aggiornarsi senza modificare automaticamente l’inquadratura scelta dall’utente.

5. Conservato il precedente focus finale sulla destinazione al completamento della corsa.

6. La sequenza visuale complessiva diventa quindi:

   ```text
   percorso impostato
       → taxi assegnato: taxi + pickup
           → corsa iniziata: taxi + destinazione
               → corsa conclusa: focus sulla destinazione
   ```

7. Tra un passaggio automatico e il successivo la mappa rimane completamente controllabile dal passeggero.

8. Il controllo viene resettato alla conclusione della richiesta, consentendo di ripetere correttamente la sequenza durante una corsa successiva.

## Rimozione della topbar durante una corsa attiva

1. Modificata la condizione di rendering della barra superiore autenticata.

2. **Dove si va?** e il menu hamburger vengono ora mostrati solamente quando non esiste una richiesta live.

3. Quando `request !== null` la topbar viene rimossa completamente.

4. Durante le fasi della corsa rimangono quindi in primo piano solamente:

   * mappa;
   * percorso;
   * robotaxi;
   * `StatusPanel`.

5. Il dato invisibile `passenger-name`, utilizzato dai test automatici, è stato separato dall’header.

6. In questo modo la scomparsa della topbar non elimina dal DOM l’informazione usata dai test di autenticazione e aggiornamento del profilo.

## Riferimento permanente a partenza e destinazione durante la corsa

1. Aggiunte al pannello **La tua corsa** le informazioni di:

   * Partenza;
   * Destinazione.

2. I due valori vengono mostrati prima dei dati più tecnici della richiesta.

3. Il passeggero mantiene quindi sempre un riferimento leggibile al viaggio selezionato anche dopo la scomparsa della dashboard di composizione.

4. Quando disponibile viene mostrato l’indirizzo leggibile.

5. In assenza dell’indirizzo viene mantenuto un fallback basato sulle coordinate.

6. Partenza e destinazione sono state raccolte in un blocco visivamente distinto tramite:

   * superficie elevata;
   * bordo;
   * label secondarie;
   * indirizzo in evidenza.

7. Le informazioni precedono i dati relativi a:

   * codice richiesta;
   * tipo di corsa;
   * robotaxi assegnato.

## Controllo di partenza e destinazione coincidenti

1. Aggiunto un controllo per impedire la creazione di corse con partenza e destinazione sostanzialmente coincidenti.

2. La distanza viene calcolata tramite `haversineKm`.

3. Definita una soglia minima di:

   ```text
   0.01 km = 10 metri
   ```

4. Due punti entro circa 10 metri vengono quindi considerati equivalenti ai fini della richiesta.

5. In caso di coincidenza:

   * non viene aperto il pannello di scelta del servizio;
   * il punto appena selezionato viene considerato non valido;
   * il relativo campo rimane attivo;
   * viene mostrato il messaggio:

     **Partenza e destinazione devono essere due punti diversi.**

6. Il controllo viene effettuato in entrambe le direzioni:

   * partenza selezionata prima della destinazione;
   * destinazione selezionata prima della partenza.

7. Reso simmetrico anche il normale flusso di selezione:

   * se viene scelta prima la partenza, l’app passa alla destinazione;
   * se viene scelta prima la destinazione, l’app passa alla partenza;
   * quando entrambi i punti sono presenti e validi viene aperta la scelta del servizio.

8. Il controllo si applica indipendentemente dal modo in cui il punto è stato ottenuto, perché la selezione converge nella stessa funzione:

   * click sulla mappa;
   * suggerimento di indirizzo;
   * posizione corrente.

9. Aggiunta inoltre una seconda verifica immediatamente prima di `submit()`.

10. La verifica nel submit agisce come protezione finale nel caso in cui una futura modifica dell’interfaccia consentisse di aggirare il controllo durante la selezione.

11. Non sono stati introdotti altri limiti arbitrari sulla lunghezza minima della corsa: vengono bloccati solamente punti praticamente coincidenti.

## Coerenza delle animazioni

Al termine delle modifiche i principali pannelli utilizzano comportamenti coerenti:

* menu hamburger: ingresso laterale da destra;
* scelta del servizio: ingresso dal basso;
* modifica profilo: ingresso dal basso;
* elenco prenotazioni: ingresso dal basso;
* login: ingresso leggero di logo e pannello.

Le animazioni rimangono brevi e funzionali e rispettano le preferenze di riduzione del movimento del sistema operativo.

## Stato delle verifiche

Prima dell’ultima tranche di modifiche estetiche e UX risultavano già superati:

* test unitari;
* test end-to-end;
* `pnpm verify`.

Le modifiche del 21 agosto sono state controllate progressivamente durante lo sviluppo e tramite verifica visuale dell’interfaccia.

Prima del commit conclusivo dell’app passeggero deve essere rieseguito il controllo completo sulla HEAD finale, in particolare:

```powershell
pnpm exec prettier --write apps/passenger/src
pnpm verify
```

## File principali coinvolti

* `apps/passenger/src/App.tsx`
* `apps/passenger/src/components/BookingsPanel.tsx`
* `apps/passenger/src/components/ProfilePanel.tsx`
* `apps/passenger/src/components/RideMap.tsx`
* `apps/passenger/src/components/StatusPanel.tsx`
* `apps/passenger/src/styles.css`

## Nota conclusiva

Con queste modifiche viene conclusa la fase di sviluppo e rifinitura dell’app passeggero.

Il flusso coperto comprende ora:

```text
autenticazione
    → selezione partenza e destinazione
        → validazione dell’area di servizio
            → scelta corsa immediata o programmata
                → conferma / gestione prenotazioni
                    → assegnazione robotaxi
                        → avvicinamento al pickup
                            → corsa live
                                → arrivo a destinazione
```

L’interfaccia mantiene una rappresentazione mobile coerente, supporta i temi giorno e notte e conserva la separazione tra logica visuale del client e stato autoritativo del backend.

La fase successiva prevista è la rifinitura grafica della dashboard dell’operatore.

# ROAd - Aggiornamento UI e completamento revisione grafica

**Data:** 21 agosto 2026
**Autore:** Pasquale Ludovico Ignarra
**Argomento:** Revisione grafica e miglioramento dell'interazione delle applicazioni passeggero e operatore

## Obiettivo

Uniformare l'aspetto delle due applicazioni ROAd, migliorare la leggibilità delle informazioni e rendere più chiari i principali flussi di interazione senza modificare la logica di dominio o l'architettura del sistema.

La revisione ha interessato sia l'app passeggero sia la dashboard operatore ed è stata sviluppata mantenendo una palette grafica comune, il supporto ai temi giorno e notte e componenti coerenti tra i due client.

## Aggiornamento dell'app passeggero

La schermata di accesso è stata completamente riallineata allo stile grafico ROAd.

In particolare:

1. rimosso il selettore del tema dalla schermata di login, mantenendolo nel menu account;

2. aumentate e centrate le dimensioni del logo ROAd;

3. semplificata la schermata eliminando il riferimento ridondante ad "App passeggero";

4. mantenuta come intestazione principale la frase:

   `Accedi per richiedere una corsa`;

5. applicato al pannello centrale un bordo viola coerente con la palette ROAd;

6. uniformato lo stile dei campi email e password;

7. aggiunte animazioni leggere di ingresso per logo e pannello;

8. aggiornata l'icona della scheda browser con la favicon ROAd dedicata.

## Menu account passeggero

Il menu account è stato rivisto per renderlo coerente con il resto dell'interfaccia.

Sono stati introdotti:

- apertura laterale da destra;
- backdrop della pagina;
- pulsante di chiusura circolare con icona `X`;
- sezione profilo con avatar e informazioni dell'utente;
- selettore tema giorno/notte;
- accesso alle prenotazioni;
- comando di logout con evidenziazione dedicata;
- animazioni di apertura e chiusura.

Il selettore del tema rimane quindi disponibile solamente dopo l'accesso.

## Miglioramenti dell'interazione con la mappa passeggero

La gestione della mappa durante una corsa è stata resa meno invasiva.

Il comportamento implementato prevede:

1. un primo focus automatico quando viene trovato il robotaxi, mostrando robotaxi e punto di partenza;

2. un secondo focus all'inizio della corsa, mostrando robotaxi e destinazione;

3. dopo il focus iniziale, la mappa rimane liberamente controllabile dall'utente e non viene ricentrata continuamente dagli aggiornamenti della posizione;

4. mantenimento del focus finale sulla destinazione al completamento della corsa.

Sono inoltre state mantenute le icone ROAd dedicate alle zone di servizio e migliorata la visibilità del marker di destinazione.

## Informazioni sulla corsa passeggero

Durante una corsa attiva:

- vengono nascosti il titolo "Dove si va?" e il menu hamburger;
- il pannello di stato diventa il principale elemento informativo;
- vengono mostrati chiaramente punto di partenza e destinazione;
- l'interfaccia mantiene visibile solamente ciò che è rilevante per la corsa in corso.

È stato inoltre aggiunto un controllo che impedisce di selezionare partenza e destinazione coincidenti o poste a meno di 10 metri l'una dall'altra.

Il controllo è simmetrico e viene verificato indipendentemente dall'ordine con cui vengono selezionati i due punti.

## Revisione della dashboard operatore

La dashboard operatore è stata ridisegnata mantenendo invariata la struttura funzionale principale.

La nuova organizzazione utilizza:

- status bar superiore;
- menu hamburger dedicato;
- mappa come elemento principale;
- pannelli operativi sulla destra;
- log operativo sotto la mappa.

È stato eliminato il precedente header contenente informazioni ridondanti come:

- stato del canale;
- nome operatore;
- accesso diretto al profilo;
- logout.

Tali funzioni sono ora raccolte nel menu account.

## Menu account operatore

È stato introdotto un menu laterale coerente con quello dell'app passeggero.

Il menu contiene:

- avatar dell'operatore;
- nome e cognome;
- indirizzo email;
- comando **Modifica profilo**;
- selettore tema giorno/notte;
- comando **Esci**.

Il menu utilizza lo stesso linguaggio grafico dell'app passeggero, comprese animazioni, backdrop e pulsante circolare di chiusura.

## Tema giorno e notte

La dashboard operatore supporta ora entrambi i temi attraverso una palette ROAd condivisa a livello grafico.

Sono state definite variabili dedicate per:

- background;
- superfici;
- superfici elevate;
- bordi;
- testo principale;
- testo secondario;
- accent;
- colori di stato;
- overlay;
- ombre.

Il tema selezionato viene salvato nel browser e ripristinato alle aperture successive.

In assenza di una preferenza precedentemente salvata viene utilizzata la preferenza del sistema operativo.

## Status bar della flotta

La status bar è stata trasformata in un elemento interattivo.

Ogni stato dei robotaxi è selezionabile e apre un menu contenente i veicoli appartenenti a quello stato.

Il menu mostra:

- identificatore del robotaxi;
- zona corrente.

Anche gli stati con zero veicoli rimangono selezionabili e mostrano un messaggio dedicato.

La selezione di un robotaxi dalla status bar:

1. seleziona il robotaxi nella dashboard;

2. effettua un singolo focus sulla sua posizione;

3. lascia successivamente la mappa libera di essere controllata manualmente.

Gli aggiornamenti periodici della flotta non provocano quindi continui ricentramenti della mappa.

## Marker dei robotaxi

I precedenti marker circolari sono stati sostituiti con l'icona ROAd del robotaxi.

Ogni marker utilizza:

- icona del robotaxi;
- colore associato allo stato corrente;
- bordo dello stesso colore;
- sfondo coerente con il tema corrente.

Il robotaxi selezionato viene evidenziato tramite:

- ingrandimento;
- doppio bordo;
- priorità grafica maggiore rispetto agli altri marker.

## Zone di servizio

Le zone della mappa operatore utilizzano ora le stesse icone presenti nell'app passeggero.

È stata inoltre definita una priorità grafica tra i diversi elementi:

```text
robotaxi normale
    ↓
icona zona di servizio
    ↓
robotaxi selezionato

In questo modo le zone rimangono riconoscibili anche in presenza di veicoli vicini, mentre il robotaxi selezionato rimane sempre in primo piano.

La mappa è inoltre limitata all'area di Milano ed è stato rimosso il controllo grafico `+/-` di Leaflet.

## Log operativo

È stato aggiunto un nuovo pannello **Log operativo** direttamente sotto la mappa.

Il log utilizza le notifiche già ricevute dal client e mostra gli eventi più recenti con:

- timestamp;
- robotaxi coinvolto oppure indicazione `Sistema`;
- descrizione dell'evento.

Quando un evento è associato a un robotaxi, il relativo identificatore è selezionabile.

Il click sul robotaxi nel log:

1. seleziona il veicolo;
2. effettua il focus sulla sua posizione nella mappa.

Il log ha la stessa larghezza della mappa e non modifica la disposizione dei pannelli operativi laterali.

## Schermata di accesso operatore

Anche la schermata di login dell'operatore è stata uniformata allo stile dell'app passeggero.

Sono stati introdotti:

- logo ROAd grande e centrato;
- versione corretta del logo per tema giorno e notte;
- pannello centrale con bordo viola;
- campi coerenti con la palette;
- pulsante di accesso coerente con il design ROAd;
- animazioni leggere di ingresso.

La precedente intestazione:

`ROAd — Dashboard operatore`

è stata sostituita con:

`Accedi con il tuo account operatore di flotta.`

I campi e il comportamento del login sono rimasti invariati.

È stata inoltre aggiunta alla scheda del browser la favicon ROAd dedicata, utilizzando le varianti per tema chiaro e scuro.

## Modifica del profilo operatore

Il pannello di modifica del profilo è stato rivisto per integrarsi meglio con la dashboard.

Quando viene aperto:

- il pannello **Strategia di allocazione** rimane visibile;
- il pannello profilo sostituisce temporaneamente solamente **Manutenzione**;
- il pannello **Alert** rimane visibile.

La struttura laterale diventa quindi:

```text
Strategia di allocazione
        ↓
Il tuo profilo
        ↓
Alert
```

Il pannello profilo include ora:

- pulsante circolare `X` in alto a destra;
- comando **Salva**;
- comando **Annulla** al posto del precedente **Chiudi**;
- maggiore separazione grafica tra i due comandi;
- stile coerente con i temi giorno e notte.

Alla chiusura del profilo viene nuovamente mostrato il pannello di manutenzione.

## Stato della revisione grafica

Con queste modifiche la revisione estetica delle due applicazioni viene considerata completata.

Non sono previste ulteriori modifiche grafiche prima dell'integrazione delle funzionalità sviluppate parallelamente e della fase finale di verifica, salvo eventuali correzioni dovute a bug o regressioni.

Il workflow successivo previsto è:

```text
Completamento UI
    → formattazione
        → typecheck
            → commit e push del branch
                → riallineamento con main
                    → integrazione delle modifiche parallele
                        → aggiornamento dei test
                            → pnpm verify
                                → merge finale
```

## Branch di sviluppo

La revisione della dashboard operatore è stata sviluppata sul branch:

`feat/operator-dashboard-redesign`

in modo da mantenere isolate le modifiche grafiche durante lo sviluppo parallelo delle funzionalità R10 e R12.

Prima del merge finale il branch dovrà essere riallineato con `main` e dovranno essere risolti eventuali conflitti nei componenti condivisi della dashboard.

## Test e verifiche

Durante lo sviluppo sono state effettuate verifiche manuali delle principali modifiche grafiche e interattive nei temi giorno e notte.

La fase finale prevede ancora:

1. formattazione tramite Prettier;
2. typecheck dell'intero workspace;
3. verifica dello stato Git e delle modifiche incluse nel branch;
4. aggiornamento degli eventuali test interessati dai nuovi flussi dell'interfaccia;
5. esecuzione completa di:

   `pnpm verify`

6. verifica finale dopo l'integrazione delle modifiche sviluppate parallelamente.

## File principali coinvolti

### App passeggero

- `apps/passenger/src/App.tsx`
- `apps/passenger/src/components/LoginScreen.tsx`
- `apps/passenger/src/components/ProfilePanel.tsx`
- `apps/passenger/src/components/BookingsPanel.tsx`
- `apps/passenger/src/components/RideMap.tsx`
- `apps/passenger/src/components/StatusPanel.tsx`
- `apps/passenger/src/styles.css`
- `apps/passenger/public/`
- asset grafici ROAd e icone delle zone

### Dashboard operatore

- `apps/web/src/App.tsx`
- `apps/web/src/theme.ts`
- `apps/web/src/components/LoginScreen.tsx`
- `apps/web/src/components/ProfilePanel.tsx`
- `apps/web/src/components/StatusBar.tsx`
- `apps/web/src/components/FleetMap.tsx`
- `apps/web/src/components/OperationalLog.tsx`
- `apps/web/src/components/StrategyPanel.tsx`
- `apps/web/src/styles.css`
- `apps/web/index.html`
- `apps/web/public/`
- asset grafici ROAd e icone delle zone

## Nota architetturale

La revisione è stata mantenuta prevalentemente a livello di presentazione e interazione dei client.

Le informazioni relative a:

- stato della flotta;
- strategia di allocazione;
- manutenzione;
- traffico;
- notifiche operative;
- prenotazioni;
- stato delle corse;

continuano a provenire dai servizi e dai contratti già esistenti.

La dashboard non introduce una nuova sorgente di stato: status bar, mappa, pannelli e log rappresentano differenti visualizzazioni dello stesso stato applicativo ricevuto dal backend.

La fase successiva è quindi dedicata alla verifica e all'integrazione, non a ulteriori interventi estetici.