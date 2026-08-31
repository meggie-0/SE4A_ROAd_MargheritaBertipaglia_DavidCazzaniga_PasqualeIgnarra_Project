/**
 * Il vocabolario del dominio: gli insiemi chiusi di valori che compaiono nello schema del
 * database, nei DTO e (dalla M8) nei client.
 *
 * Sta in `packages/shared` perché è la sorgente unica di verità per DTO ed enum (HARNESS.md §4):
 * chi riscrivesse la dashboard in un altro framework deve poterli leggere senza importare una riga
 * di NestJS. Ogni insieme è dichiarato come tupla `as const` e non come `enum` di TypeScript: la
 * tupla è al tempo stesso il tipo (unione di letterali) e il dato, quindi la stessa costante serve
 * da elenco dei valori in una migrazione, da `z.enum()` in uno schema e da unione nei tipi.
 */

/** Ruoli applicativi. I guard di `gateway` li useranno da M1b (RASD R1, R2). */
export const USER_ROLES = ['PASSENGER', 'OPERATOR'] as const;
export type UserRole = (typeof USER_ROLES)[number];

/**
 * Gli stati del robotaxi.
 *
 * Sono **sette**: la macchina autorevole è quella del DD §2.6.3, Figura 2.10, non quella a sei
 * stati del RASD §3.2, che resta la vista a livello di requisiti. `REBALANCING` è uno stato a
 * tutti gli effetti — un veicolo che si sta riposizionando è ancora allocabile (transizione 10).
 * Le classi di stato e le transizioni arrivano con M2; qui c'è solo il valore persistito, perché
 * la colonna enum è parte dello schema di M1.
 */
export const ROBOTAXI_STATES = [
  'AVAILABLE',
  'ASSIGNED',
  'ARRIVING',
  'ARRIVED',
  'IN_RIDE',
  'REBALANCING',
  'MAINTENANCE',
] as const;
export type RobotaxiState = (typeof ROBOTAXI_STATES)[number];

/** Corsa immediata o prenotazione anticipata (RASD §2.2.1: `ImmediateRide` / `AdvanceBooking`). */
export const RIDE_REQUEST_KINDS = ['IMMEDIATE', 'ADVANCE'] as const;
export type RideRequestKind = (typeof RIDE_REQUEST_KINDS)[number];

/** Ciclo di vita di una richiesta di corsa (RASD §2.2.1, enum `RequestStatus`). */
export const RIDE_REQUEST_STATUSES = [
  'PENDING',
  'ACCEPTED',
  'REJECTED',
  'CANCELLED',
  'COMPLETED',
] as const;
export type RideRequestStatus = (typeof RIDE_REQUEST_STATUSES)[number];

/**
 * Ciclo di vita di una **corsa** (RASD §2.2.3, enum `RideStatus`).
 *
 * Non è un doppione di `RIDE_REQUEST_STATUSES`: quello è il ciclo di vita della *richiesta* — se il
 * sistema l'ha accettata, rifiutata o annullata — mentre questo è il ciclo di vita del *servizio di
 * trasporto* che una richiesta accettata genera (RASD §2.2.1: «An accepted Ride Request can generate
 * one Ride»). Una richiesta `ACCEPTED` può avere una corsa `SCHEDULED`, `WAITING_FOR_PICKUP` o
 * `IN_PROGRESS`, e sono tre cose diverse per il passeggero.
 *
 * `WAITING_FOR_PICKUP` è il veicolo **arrivato** al punto di ritiro che aspetta che il passeggero
 * salga: la corrispondenza con la macchina a stati del veicolo (DD §2.6.3, Figura 2.10) è
 * `ARRIVED`, non `ARRIVING`.
 */
export const RIDE_STATUSES = [
  'SCHEDULED',
  'WAITING_FOR_PICKUP',
  'IN_PROGRESS',
  'COMPLETED',
  'CANCELLED',
] as const;
export type RideStatus = (typeof RIDE_STATUSES)[number];

/** Ciclo di vita di un evento di manutenzione (RASD §2.2.3, enum `MaintenanceStatus`). */
export const MAINTENANCE_STATUSES = ['SCHEDULED', 'ONGOING', 'COMPLETED', 'CANCELLED'] as const;
export type MaintenanceStatus = (typeof MAINTENANCE_STATUSES)[number];

/**
 * Ciclo di vita di un'azione di riposizionamento (RASD §2.2.3, enum `RebalancingStatus`).
 *
 * L'insieme è quello del RASD per intero, ma in M6 una sola riga nasce già `TRIGGERED`: il DD §2.4,
 * Figura 2.7 non disegna il ramo con approvazione dell'operatore che la Figura 3.3 del RASD lascia
 * come alternativa, quindi `SUGGESTED` non ha ancora uno scrittore. `COMPLETED` e `CANCELLED`
 * arrivano con M7, quando la telemetria del simulatore saprà dire che il veicolo è arrivato nella
 * zona di destinazione o che il riposizionamento è stato interrotto da una corsa (transizione 10).
 *
 * Si dichiara comunque per intero perché è l'enum del RASD, e un vincolo `CHECK` che ne ammettesse
 * quattro valori su tre dovrebbe essere migrato di nuovo a M7 per una ragione che si conosce già.
 */
export const REBALANCING_STATUSES = ['SUGGESTED', 'TRIGGERED', 'COMPLETED', 'CANCELLED'] as const;
export type RebalancingStatus = (typeof REBALANCING_STATUSES)[number];

/**
 * Tipi di notifica (RASD §2.2.3, enum `NotificationType`).
 *
 * Sono le categorie che il RASD assegna a una `Notification`, e la `Notification` del RASD è
 * indirizzata a un **passeggero** (Figura 2.2: `Notification "0..*" --> "1" Passenger : sent to`).
 * Gli eventi di flotta che nessuna corsa riguarda — un veicolo che entra in manutenzione, uno che
 * comincia a riposizionarsi — raggiungono comunque la dashboard dell'operatore, ma non sono di
 * questo insieme e non lasciano una riga in `notification`. È il motivo per cui il campo `type`
 * della notifica spedita sul canale push è **annullabile**: vedi `notificationPushSchema`.
 */
export const NOTIFICATION_TYPES = [
  'VEHICLE_ASSIGNED',
  'VEHICLE_ARRIVING',
  'VEHICLE_ARRIVED',
  'RIDE_STATUS_CHANGED',
  'REBALANCING_ALERT',
] as const;
export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

/**
 * Le categorie di **alert dell'operatore** (decisione D77).
 *
 * Sono un insieme distinto da `NOTIFICATION_TYPES`, e la distinzione è la sostanza della D77. La
 * `Notification` del RASD è indirizzata a un passeggero — Figura 2.2, `Notification "0..*" --> "1"
 * Passenger : sent to` — mentre questi quattro eventi non hanno nessun passeggero a cui andare:
 * riguardano il **governo del sistema**, e il loro pubblico è chiunque stia guardando la dashboard.
 *
 * Il RASD usa questo concetto senza modellarlo: fra i suoi `NotificationType` c'è
 * `REBALANCING_ALERT`, che è un avviso all'operatore dentro un'entità che il documento dichiara
 * indirizzata a un passeggero. Tenere i due insiemi separati è ciò che permette a entrambe le
 * affermazioni di restare vere.
 */
export const OPERATOR_ALERT_KINDS = [
  'STRATEGY_CHANGED',
  'MODE_CHANGED',
  'TRAFFIC_ALERT',
  'REBALANCING_STARTED',
] as const;
export type OperatorAlertKind = (typeof OPERATOR_ALERT_KINDS)[number];

/**
 * Le due strategie di allocazione (RASD §2.2.1). Il nome — e non l'oggetto strategia — è ciò che
 * attraversa i confini: `AllocationPort.setActiveStrategy(name, source)` (DD §2.2.1, decisione D4).
 */
export const STRATEGY_NAMES = ['NEAREST_AVAILABLE', 'MINIMUM_ETA'] as const;
export type StrategyName = (typeof STRATEGY_NAMES)[number];

/** Il default del sistema è `NearestAvailable` (RASD §2.4). */
export const DEFAULT_STRATEGY: StrategyName = 'NEAREST_AVAILABLE';

/** Modo di controllo dell'allocazione (RASD §2.2.1, `System Mode`). */
export const CONTROL_MODES = ['AUTO', 'MANUAL'] as const;
export type ControlMode = (typeof CONTROL_MODES)[number];

/** Livello di traffico fornito dal servizio di mappe esterno (RASD §2.2.1). */
export const TRAFFIC_LEVELS = ['LOW', 'MEDIUM', 'HIGH'] as const;
export type TrafficLevel = (typeof TRAFFIC_LEVELS)[number];
