import type { NotificationType, RideStatus, RobotaxiState } from '@road/shared';

/**
 * La porta del `NotificationManager` (DD §2.2, §2.3.3; CLAUDE.md Regola 1 e Regola 2).
 *
 * Questo file è il **primo livello dell'Observer**: le due interfacce del pattern e l'evento che ci
 * viaggia sopra. Il secondo livello — le sessioni per connessione — sta in `session.port.ts`, ed è
 * separato perché le due relazioni della Figura 2.4 hanno vite completamente diverse (DD §2.3.3,
 * decisione D7):
 *
 * - **Subject → Observer** è di processo. `Robotaxi` e `Ride` sono ricostruiti dal database a ogni
 *   operazione e non possono portarsi dietro una lista di subscriber durevole: la lista che tengono
 *   vive quanto l'operazione, e l'unico observer che ci finisce dentro è il `NotificationManager`,
 *   registrato dal modulo che possiede il soggetto.
 * - **NotificationManager → sessione** è per connessione, e cambia continuamente.
 *
 * Chi importa questo file sono `fleet` e `rides` — i due soggetti — e nient'altro. Il verso della
 * dipendenza è quello: `notifications` non conosce né l'uno né l'altro, e infatti l'evento qui sotto
 * è descritto con i soli tipi di `@road/shared`. Se portasse, per dire, il nome della transizione
 * definito in `fleet/robotaxi.port.ts`, i due moduli si importerebbero a vicenda e `pnpm arch`
 * fallirebbe sulla dipendenza circolare — a ragione, perché a quel punto nessuno dei due sarebbe
 * più riscrivibile da solo.
 */

// ---------------------------------------------------------------------------------------------
// L'evento
// ---------------------------------------------------------------------------------------------

/**
 * Un cambiamento di stato di un veicolo (DD §2.6.3, Figura 2.10).
 *
 * Porta `from` e `to` invece del nome della transizione, e non è per brevità: la coppia di stati
 * identifica la transizione in modo univoco nella Figura 2.10, ed è fatta di due valori di
 * `@road/shared` invece che di un tipo di `fleet`. È ciò che tiene `notifications` indipendente dal
 * modulo che gli manda gli eventi.
 *
 * `rideRequestId` è la sola cosa che permette di consegnare l'evento: senza, il manager saprebbe
 * che un veicolo si è mosso ma non a quale passeggero interessa. È annullabile perché non tutti i
 * movimenti riguardano una corsa — un veicolo che entra in manutenzione o comincia a riposizionarsi
 * riguarda solo l'operatore.
 */
export interface RobotaxiStateChangedEvent {
  readonly kind: 'ROBOTAXI_STATE_CHANGED';
  readonly occurredAt: Date;
  readonly robotaxiId: string;
  readonly from: RobotaxiState;
  readonly to: RobotaxiState;
  readonly rideRequestId: string | null;
}

/**
 * Un cambiamento di stato di una corsa (RASD §2.2.3, `RideStatus`).
 *
 * Porta `passengerId` già risolto, mentre l'evento del veicolo no: la `Ride` il proprio passeggero
 * lo conosce — è una sua colonna — mentre il `Robotaxi` conosce al più la richiesta che sta
 * servendo. Chiedere al soggetto ciò che sa già evita al manager una lettura per ogni evento.
 */
export interface RideStatusChangedEvent {
  readonly kind: 'RIDE_STATUS_CHANGED';
  readonly occurredAt: Date;
  readonly rideId: string;
  readonly rideRequestId: string;
  readonly passengerId: string;
  readonly robotaxiId: string | null;
  readonly status: RideStatus;
}

/** Il `DomainEvent` della Figura 2.4: ciò che un soggetto notifica ai propri observer. */
export type DomainEvent = RobotaxiStateChangedEvent | RideStatusChangedEvent;

// ---------------------------------------------------------------------------------------------
// Le due interfacce del pattern
// ---------------------------------------------------------------------------------------------

/**
 * L'`Observer` della Figura 2.4: chi vuole sapere che un soggetto è cambiato.
 *
 * `update` è asincrono perché il `NotificationManager` scrive lo storico e consegna: chi notifica
 * deve poter attendere che sia finito, o un test vedrebbe la notifica arrivare dopo la propria
 * asserzione e fallirebbe a intermittenza.
 */
export interface Observer {
  update(event: DomainEvent): Promise<void>;
}

/**
 * Il `Subject` della Figura 2.4, implementato da `Robotaxi` e da `Ride`.
 *
 * Le tre operazioni sono quelle del diagramma. La lista di observer che un soggetto tiene vive
 * quanto l'operazione che lo ha costruito, e in pratica contiene sempre un solo elemento: il
 * `NotificationManager`. Non è una semplificazione da correggere — è la conseguenza del fatto che
 * i soggetti sono oggetti di memoria ricostruiti a ogni lettura (DD §2.3.3).
 */
export interface Subject {
  registerObserver(observer: Observer): void;
  removeObserver(observer: Observer): void;
  notifyObservers(event: DomainEvent): Promise<void>;
}

// ---------------------------------------------------------------------------------------------
// La consegna
// ---------------------------------------------------------------------------------------------

/**
 * Ciò che arriva a una sessione: l'evento tradotto in qualcosa da mostrare.
 *
 * È la forma di `NotificationPush` di `@road/shared` con le date ancora `Date`; a serializzarla è il
 * `gateway`, che è l'unico a sapere che il trasporto è JSON su Socket.IO. Tenere la traduzione qui
 * e la serializzazione là è ciò che permette di sostituire il trasporto senza toccare il dominio.
 *
 * `type` è annullabile per la ragione spiegata in `@road/shared`: l'insieme `NotificationType` del
 * RASD descrive le notifiche **al passeggero**, e un evento di flotta che nessuna corsa riguarda non
 * ne ha una. Quegli eventi raggiungono la dashboard e non lasciano una riga in `notification`.
 */
export interface NotificationDelivery {
  readonly type: NotificationType | null;
  readonly message: string;
  readonly occurredAt: Date;
  readonly rideRequestId: string | null;
  readonly robotaxiId: string | null;
  readonly robotaxiState: RobotaxiState | null;
  readonly rideStatus: RideStatus | null;
}

// ---------------------------------------------------------------------------------------------
// La porta
// ---------------------------------------------------------------------------------------------

/**
 * La porta che i **soggetti** usano: una sola operazione, `update`, come il DD §2.2 prescrive.
 *
 * È una classe astratta e non un'interfaccia perché fa anche da token di iniezione per Nest
 * (CLAUDE.md Regola 1), e dichiara `implements Observer` a livello di tipo: chi la inietta ottiene
 * qualcosa che *è* un observer del pattern, non un servizio che gli somiglia.
 */
export abstract class NotificationPort implements Observer {
  /**
   * Riceve un evento di dominio da un soggetto, ne scrive lo storico se ha un destinatario e lo
   * consegna alle sessioni interessate (R6, G7).
   *
   * **Non solleva.** Una consegna fallita non deve poter annullare la transizione che l'ha
   * generata: il veicolo si è mosso davvero, e far fallire l'operazione perché una socket è caduta
   * scambierebbe un problema di trasporto per un errore di dominio. Chi chiama può quindi attendere
   * questa promessa senza avvolgerla in un `try`.
   */
  abstract update(event: DomainEvent): Promise<void>;
}
