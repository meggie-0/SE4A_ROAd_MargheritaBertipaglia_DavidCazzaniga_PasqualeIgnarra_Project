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
