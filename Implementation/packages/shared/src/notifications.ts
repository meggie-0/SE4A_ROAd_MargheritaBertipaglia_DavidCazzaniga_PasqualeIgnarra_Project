import { z } from 'zod';

import {
  CONTROL_MODES,
  NOTIFICATION_TYPES,
  OPERATOR_ALERT_KINDS,
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
  /**
   * I minuti stimati perché il veicolo raggiunga il punto di ritiro (M7, R6).
   *
   * È il quarto dei momenti che R6 elenca — «vehicle assignment, **ETA**, arrival at the pickup
   * point, and ride completion» — e fino a M6 era l'unico che il canale non portava: l'unico
   * fornitore di tempi di viaggio era un mock, e un numero preso da lì e mostrato come promessa al
   * passeggero sarebbe stato peggio di nessun numero (decisione D46). Con OSRM collegato il dato è
   * reale, e lo porta la notifica di avvicinamento.
   *
   * **Annullabile** perché non sempre si conosce: un fornitore può non saper rispondere per un
   * veicolo, e le altre notifiche non parlano affatto di tempi di arrivo. Un client lo mostra se
   * c'è — «il tuo robotaxi arriva fra 7 minuti» — e senza si limita ad annunciare l'avvicinamento,
   * che è ciò che il sistema faceva fino a M6.
   */
  etaMinutes: z.number().nullable(),
});
export type NotificationPush = z.infer<typeof notificationPushSchema>;

/**
 * Lo **storico degli alert dell'operatore** (decisione D77; RASD R7, R11, R12, R13; G8, G9).
 *
 * Il canale push consegna a chi c'è; questo è ciò che resta per chi arriva dopo. Erano l'unica metà
 * del sistema a non averlo: la tabella `notification` esiste esattamente per «permettere a un client
 * che si riconnette di non perdere ciò che è successo mentre era assente» — lo dice il commento
 * della sua entità — ma nessun alert dell'operatore ci è mai finito, perché nessuno di loro ha un
 * passeggero a cui essere indirizzato.
 *
 * **I campi strutturati ci sono tutti**, e non è ridondanza rispetto a `message`. Il pannello
 * classifica gli alert su `zoneId`, `trafficLevel`, `mode` e `strategy` — non sul testo, che è prosa
 * per un umano e cambierebbe significato alla prima riformulazione. Una riga riletta senza quei
 * campi si potrebbe mostrare ma non colorare, e il pannello direbbe meno di quanto sa.
 */
export const operatorAlertSchema = z.object({
  id: z.uuid(),
  kind: z.enum(OPERATOR_ALERT_KINDS),
  /** Il testo composto dal backend, lo stesso che il canale push ha consegnato. */
  message: z.string(),
  /** L'istante del fatto, non quello della scrittura: viene da `ClockPort`. */
  occurredAt: z.iso.datetime(),
  strategy: z.enum(STRATEGY_NAMES).nullable(),
  mode: z.enum(CONTROL_MODES).nullable(),
  trafficLevel: z.enum(TRAFFIC_LEVELS).nullable(),
  /**
   * Zona e veicolo sono **copie**, non riferimenti.
   *
   * Uno storico racconta com'era il mondo allora: legarlo con una chiave esterna significherebbe che
   * rinominare una zona riscrive il passato, e che cancellarla lo perde. Sono i due modi in cui uno
   * storico smette di essere tale.
   */
  zoneId: z.string().nullable(),
  robotaxiId: z.string().nullable(),
});
export type OperatorAlert = z.infer<typeof operatorAlertSchema>;

export const operatorAlertsResponseSchema = z.object({
  alerts: z.array(operatorAlertSchema),
});
export type OperatorAlertsResponse = z.infer<typeof operatorAlertsResponseSchema>;
