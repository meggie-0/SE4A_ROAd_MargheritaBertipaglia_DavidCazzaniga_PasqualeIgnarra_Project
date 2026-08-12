import type {
  ControlMode,
  NotificationType,
  RideStatus,
  RobotaxiState,
  StrategyName,
  TrafficLevel,
} from '@road/shared';

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

/**
 * La strategia attiva è cambiata (DD §2.4, Figura 2.6: `StrategyChangedEvent`, `ManualOverrideEvent`).
 *
 * I due eventi della figura sono **uno solo** qui, distinto da `source`: hanno gli stessi campi e
 * lo stesso destinatario, e ciò che li separa è da dove è venuto il cambiamento — che è esattamente
 * il `ChangeSource` che `AllocationPort.setActiveStrategy()` già riceve. Due interfacce identiche a
 * meno del nome avrebbero costretto ogni lettore a gestirle due volte per dire la stessa cosa.
 *
 * `trafficLevel` è il livello che ha provocato lo switch, e per un cambio manuale è l'ultimo noto:
 * è ciò che rende leggibile il pannello alert del DD §3.2 — «passato a MinimumETA perché il traffico
 * è alto» dice all'operatore qualcosa che il solo nome della strategia non dice.
 */
export interface StrategyChangedEvent {
  readonly kind: 'STRATEGY_CHANGED';
  readonly occurredAt: Date;
  readonly strategy: StrategyName;
  readonly mode: ControlMode;
  readonly source: 'auto' | 'manual';
  readonly trafficLevel: TrafficLevel | null;
}

/**
 * Il traffico ha raggiunto la soglia intermedia: si avvisa e **non** si cambia (RASD R12, NFR9).
 *
 * È l'unico evento del sistema che non segue un cambiamento di stato, ed è voluto: R12 chiede che
 * su Medium «the system alerts the Fleet Operator, suggesting a switch», cioè che accada una cosa
 * *osservabile* proprio là dove non accade nessuna transizione. Senza questo evento la soglia
 * intermedia sarebbe indistinguibile dal non aver letto affatto il traffico, e NFR9 — «un cambio
 * su Medium falsifica la proprietà» — sarebbe verificabile solo in negativo.
 *
 * `suggestedStrategy` è la politica che R12 suggerisce, non una che qualcuno abbia attivato.
 */
export interface TrafficAlertEvent {
  readonly kind: 'TRAFFIC_ALERT';
  readonly occurredAt: Date;
  readonly trafficLevel: TrafficLevel;
  readonly suggestedStrategy: StrategyName;
}

/**
 * Un veicolo inattivo è stato mandato verso una zona in deficit (DD §2.4, Figura 2.7; R11, G9).
 *
 * Non sostituisce la transizione `AVAILABLE → REBALANCING`, che il `Robotaxi` notifica per conto
 * proprio come ogni altra (decisione D39): quella dice che il veicolo si sta spostando, questa dice
 * **verso dove**. La destinazione non è una colonna di `robotaxi` e non passa da
 * `requestRebalancing()`, quindi senza questo evento la dashboard vedrebbe partire dei veicoli
 * senza poter dire perché — che è metà di ciò che MILESTONES.md §M6 chiede con «produce alert in
 * dashboard».
 */
export interface RebalancingStartedEvent {
  readonly kind: 'REBALANCING_STARTED';
  readonly occurredAt: Date;
  readonly robotaxiId: string;
  readonly targetZoneId: string;
  readonly targetZoneName: string;
}

/**
 * Il `DomainEvent` della Figura 2.4: ciò che un soggetto notifica ai propri observer.
 *
 * **[M6]** I tre eventi aggiunti non nascono da un `Subject`, e non è un'incoerenza col DD §2.3.3:
 * le Figure 2.6 e 2.7 disegnano `ModeController` e `RebalancingManager` che chiamano
 * `update(...)` **direttamente** sul `NotificationManager`. I soggetti dell'Observer restano due,
 * `Robotaxi` e `Ride`, perché soggetto è chi ha uno stato che gli altri osservano; modo e
 * riposizionamento sono decisioni, e una decisione si comunica una volta sola a chi la deve sapere.
 */
export type DomainEvent =
  | RobotaxiStateChangedEvent
  | RideStatusChangedEvent
  | StrategyChangedEvent
  | TrafficAlertEvent
  | RebalancingStartedEvent;

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
  /** I quattro campi del pannello di controllo dell'operatore (M6, DD §3.2). */
  readonly strategy: StrategyName | null;
  readonly mode: ControlMode | null;
  readonly trafficLevel: TrafficLevel | null;
  readonly zoneId: string | null;
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
