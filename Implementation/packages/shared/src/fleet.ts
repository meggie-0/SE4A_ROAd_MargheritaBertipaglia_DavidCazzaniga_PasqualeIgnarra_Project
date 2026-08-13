import { z } from 'zod';

import { ROBOTAXI_STATES } from './domain.js';
import { geoPointSchema } from './rides.js';

/**
 * Il contratto pubblico della **panoramica di flotta** (RASD R7, G8; DD §2.2.1, §3.2).
 *
 * R7 chiede una vista in tempo reale di posizione e stato di ogni veicolo, e il DD §3.2 la mette
 * al centro della dashboard: mappa con marker colorati per stato, più una status bar che riassume
 * la flotta per stato. `FleetMonitorPort.getFleetStatus()` produce già esattamente questo dato dal
 * M2; fino a M7 però non usciva dall'API, perché nessun client lo guardava. Questo file è la sua
 * forma pubblica.
 *
 * **Perché non passa dal canale push.** Le posizioni cambiano a ogni tick del simulatore, e
 * spingerne una per veicolo per tick inonderebbe il canale, che esiste per gli eventi della corsa
 * (R6). La scelta è scritta in `FleetMonitorPort.recordPositions()`: «la dashboard le posizioni le
 * legge da `getFleetStatus()`». Le *transizioni* invece arrivano sul canale, come tutto il resto —
 * quindi la dashboard vede subito un cambio di stato e ricalcola le posizioni al giro successivo.
 *
 * `geoPointSchema` arriva da `rides.ts` e non è duplicato qui: è la stessa forma — un punto sulla
 * mappa validato ai limiti del sistema di coordinate — e due definizioni strutturalmente uguali ma
 * senza rapporto fra loro divergono alla prima che qualcuno tocca.
 */

/**
 * Ogni quanto la posizione dei veicoli si rinnova, in millisecondi.
 *
 * **È una sola cadenza, e per questo sta qui.** Tre cose devono batterla insieme, o il movimento che
 * si vede a schermo non è quello che il sistema conosce: il mondo simulato che avanza
 * (`SimulatorSchedule`), la telemetria che lo legge e scrive le posizioni (`FleetTelemetrySchedule`)
 * e i due client che le rileggono. Tenere il numero in tre file lo avrebbe fatto divergere al primo
 * che qualcuno tocca — con l'esito peggiore, che non è un errore ma un veicolo che scatta.
 *
 * Mezzo secondo: sotto la soglia oltre la quale l'occhio smette di leggere una serie di posizioni
 * come un movimento e comincia a vedere dei salti. È anche il motivo per cui **non** passa dal
 * canale push: due posizioni al secondo per una flotta di sessantaquattro veicoli fanno centoventotto messaggi al secondo verso
 * ogni client connesso, e il canale esiste per gli eventi della corsa (R6). Chi vuole la posizione
 * la chiede; chi vuole lo stato lo riceve.
 *
 * Non è la velocità del mondo simulato, che resta quella di prima: un passo più corto, ripetuto più
 * spesso, copre la stessa strada nello stesso tempo reale (vedi `DEFAULT_SIMULATOR_SETTINGS`).
 */
export const FLEET_POSITION_REFRESH_MS = 500;

/**
 * Un veicolo come lo vede la dashboard.
 *
 * È la proiezione pubblica di `RobotaxiSnapshot`, e come quella **non** porta metodi di
 * transizione: chi la riceve deve poter disegnare un marker, non muovere un veicolo. La posizione è
 * annidata in `position` invece di due colonne `lat`/`lon` piatte perché è ciò che la mappa
 * consuma, ed è la stessa forma con cui il passeggero manda ritiro e destinazione.
 */
export const fleetVehicleSchema = z.object({
  id: z.string().min(1),
  state: z.enum(ROBOTAXI_STATES),
  position: geoPointSchema,
  /** La zona di Milano in cui il veicolo si trova, o `null` se non è ancora stata calcolata. */
  zoneId: z.string().nullable(),
  /** Quando la riga del veicolo è stata scritta l'ultima volta. */
  updatedAt: z.iso.datetime(),
});
export type FleetVehicle = z.infer<typeof fleetVehicleSchema>;

/**
 * `GET /fleet/status` — la fotografia della flotta.
 *
 * `countsByState` è **ridondante** rispetto a `robotaxis`, e la ridondanza è voluta: la status bar
 * del DD §3.2 mostra il riepilogo per stato, e farlo ricontare a ogni client significherebbe
 * pubblicare un dato che il backend ha già calcolato — con il rischio che due client lo contino in
 * due modi. Il conteggio è quello di `FleetMonitorPort.getFleetStatus()`, che è la sede autorevole.
 *
 * `observedAt` viene da `ClockPort` e non dall'orologio di sistema (CLAUDE.md Regola 3): dice al
 * client quanto è fresco il dato.
 */
export const fleetStatusResponseSchema = z.object({
  observedAt: z.iso.datetime(),
  total: z.number().int().nonnegative(),
  /**
   * Un contatore per **ognuno** dei sette stati, zeri compresi.
   *
   * `z.record` con la chiave vincolata all'enum: una status bar che mostrasse solo gli stati
   * presenti cambierebbe forma a ogni aggiornamento, e la colonna «in manutenzione» sparirebbe
   * proprio quando la flotta sta bene — che è l'istante in cui l'operatore si chiede se il
   * pannello funziona ancora.
   */
  countsByState: z.record(z.enum(ROBOTAXI_STATES), z.number().int().nonnegative()),
  robotaxis: z.array(fleetVehicleSchema),
});
export type FleetStatusResponse = z.infer<typeof fleetStatusResponseSchema>;
