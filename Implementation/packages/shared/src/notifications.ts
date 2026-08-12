import { z } from 'zod';

import {
  CONTROL_MODES,
  NOTIFICATION_TYPES,
  RIDE_STATUSES,
  ROBOTAXI_STATES,
  STRATEGY_NAMES,
  TRAFFIC_LEVELS,
} from './domain.js';

/**
 * Il contratto del **canale push** (RASD R6, G7, NFR2; DD §2.3.3, §2.6.2).
 *
 * Sta in `packages/shared` per la stessa ragione degli schemi HTTP: chi riscrivesse l'app
 * passeggero o la dashboard parte da qui e da `contracts/openapi.json`, senza leggere una riga di
 * NestJS (HARNESS.md §4). Il WebSocket non compare nell'OpenAPI — non è HTTP — quindi senza questo
 * file il suo contratto non esisterebbe da nessuna parte, e i client di M8 lo dedurrebbero
 * leggendo il backend, che è esattamente ciò che i confini vietano.
 *
 * NFR2 è la ragione per cui il canale esiste: DD §4.3 lo dichiara soddisfatto quando «a state
 * change reaches a connected client over the push channel without the client polling». Un client
 * che dovesse ri-chiedere lo stato per accorgersi di un cambiamento lo violerebbe.
 */

/** Lo spazio dei nomi Socket.IO su cui i client si connettono. */
export const NOTIFICATIONS_NAMESPACE = '/notifications';

/**
 * Il nome dell'evento Socket.IO che porta ogni notifica.
 *
 * Uno solo, e non uno per tipo: il tipo sta *dentro* il messaggio. Con un evento per categoria un
 * client dovrebbe iscriversi a ognuna, e ogni nuova categoria diventerebbe un cambiamento di
 * contratto anche per chi non la usa.
 */
export const NOTIFICATION_EVENT = 'notification';

/**
 * Il parametro di handshake che porta il token JWT.
 *
 * Socket.IO lo trasporta in `handshake.auth`, non in un header: la connessione WebSocket del
 * browser non permette di impostare `Authorization`. Il token è lo stesso di M1b — un solo access
 * token, nessuno stato di sessione lato server (NFR3).
 */
export const NOTIFICATION_AUTH_FIELD = 'token';

/**
 * Una notifica come arriva al client.
 *
 * Piatta e con campi annullabili invece che discriminata per sorgente: chi la riceve deve poter
 * aggiornare una schermata, non ricostruire il modello di dominio del backend. `robotaxiState` e
 * `rideStatus` sono le due letture della stessa progressione — dove sta il veicolo e a che punto è
 * la corsa — e una notifica ne porta almeno una.
 *
 * `type` è **annullabile** perché l'insieme `NotificationType` del RASD §2.2.3 descrive le notifiche
 * *al passeggero*, e sul canale viaggiano anche gli eventi di flotta che nessuna corsa riguarda —
 * un veicolo che entra in manutenzione, uno che comincia a riposizionarsi. Quelli raggiungono la
 * dashboard dell'operatore con `type: null` e non lasciano una riga in `notification`: la
 * `Notification` del RASD è indirizzata a un passeggero, e per un evento di flotta non ce n'è uno.
 * Inventare una categoria fuori dall'enum avrebbe fatto divergere codice e documento.
 *
 * **[M6]** I quattro campi in coda — `strategy`, `mode`, `trafficLevel`, `zoneId` — servono al
 * pannello di controllo del DD §3.2, che mostra modo e strategia attiva e tiene un elenco degli
 * switch automatici e dei suggerimenti di riposizionamento. Sono annullabili come gli altri per la
 * stessa ragione: una notifica ne porta quelli che il proprio evento conosce. Trasportarli
 * strutturati e non solo dentro `message` è ciò che permette alla dashboard di *aggiornare* il
 * pannello invece di stampare una riga di testo, e al cancello di M6 di asserire su un valore
 * invece che su una frase.
 */
export const notificationPushSchema = z.object({
  type: z.enum(NOTIFICATION_TYPES).nullable(),
  /** Il testo già pronto da mostrare, in italiano come il resto dell'interfaccia. */
  message: z.string(),
  /** L'istante del cambiamento, non quello della consegna: viene da `ClockPort`. */
  occurredAt: z.iso.datetime(),
  /** La richiesta di corsa a cui l'evento si riferisce, se ce n'è una. */
  rideRequestId: z.uuid().nullable(),
  robotaxiId: z.string().nullable(),
  /** Lo stato del veicolo **dopo** la transizione (DD §2.6.3, Figura 2.10). */
  robotaxiState: z.enum(ROBOTAXI_STATES).nullable(),
  /** Lo stato della corsa dopo il cambiamento (RASD §2.2.3). */
  rideStatus: z.enum(RIDE_STATUSES).nullable(),
  /** La strategia attiva **dopo** il cambiamento, per gli eventi di modo (M6, R8, R12, R13). */
  strategy: z.enum(STRATEGY_NAMES).nullable(),
  /** Il modo di controllo dopo il cambiamento (M6, R13, NFR10). */
  mode: z.enum(CONTROL_MODES).nullable(),
  /** Il livello di traffico che ha provocato l'evento (M6, R12, NFR9). */
  trafficLevel: z.enum(TRAFFIC_LEVELS).nullable(),
  /** La zona a cui l'evento si riferisce: la destinazione di un riposizionamento (M6, R11, G9). */
  zoneId: z.string().nullable(),
});
export type NotificationPush = z.infer<typeof notificationPushSchema>;
