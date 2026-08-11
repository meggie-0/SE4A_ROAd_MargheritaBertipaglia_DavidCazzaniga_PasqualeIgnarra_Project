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

/** Ciclo di vita di un evento di manutenzione (RASD §2.2.3, enum `MaintenanceStatus`). */
export const MAINTENANCE_STATUSES = ['SCHEDULED', 'ONGOING', 'COMPLETED', 'CANCELLED'] as const;
export type MaintenanceStatus = (typeof MAINTENANCE_STATUSES)[number];

/** Tipi di notifica (RASD §2.2.3, enum `NotificationType`). Il trasporto arriva con M5. */
export const NOTIFICATION_TYPES = [
  'VEHICLE_ASSIGNED',
  'VEHICLE_ARRIVING',
  'VEHICLE_ARRIVED',
  'RIDE_STATUS_CHANGED',
  'REBALANCING_ALERT',
] as const;
export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

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
