import type {
  ControlMode,
  MaintenanceStatus,
  NotificationType,
  RideRequestKind,
  RideRequestStatus,
  RobotaxiState,
  StrategyName,
  TrafficLevel,
  UserRole,
} from '@road/shared';

/**
 * La porta del `PersistenceManager` (DD §2.2, CLAUDE.md Regola 1).
 *
 * È l'unico modo di raggiungere il database: nessun altro componente apre una connessione, e
 * nient'altro di questo modulo è visibile da fuori. Le entità TypeORM, il `DataSource` e le
 * migrazioni restano dietro questa classe astratta, che fa anche da token di iniezione per Nest.
 *
 * Le quattro operazioni sono quelle del DD §2.2 — `create`, `update`, `filterAvailable`,
 * `reserve` — e non se ne aggiungono altre. I tipi dei record esposti qui sono interfacce di dati
 * semplici, non entità dell'ORM: chi usa la porta non deve poter dedurre che dietro c'è TypeORM.
 */

// ---------------------------------------------------------------------------------------------
// Tempo e riserve
// ---------------------------------------------------------------------------------------------

/**
 * Un intervallo semiaperto `[start, end)`.
 *
 * Semiaperto e non chiuso: due finestre che si toccano (`[9:00, 10:00)` e `[10:00, 11:00)`) non si
 * sovrappongono, ed è la semantica del `tstzrange` con cui la riserva è memorizzata. Se fosse
 * chiuso, un veicolo non potrebbe iniziare una corsa nell'istante in cui ne finisce un'altra.
 */
export interface TimeWindow {
  readonly start: Date;
  readonly end: Date;
}

/**
 * Le due costanti di configurazione della timeline delle riserve (DD §2.4, decisione D8).
 *
 * `bufferMinutes` è il margine che si aggiunge in coda a ogni riserva; `activationLeadMinutes` è
 * l'anticipo con cui una prenotazione viene attivata (e con cui la sua riserva comincia).
 */
export interface ReservationTiming {
  readonly bufferMinutes: number;
  readonly activationLeadMinutes: number;
}

/** I valori di default previsti da MILESTONES.md §M1: 10 e 15 minuti. */
export const DEFAULT_RESERVATION_TIMING: ReservationTiming = {
  bufferMinutes: 10,
  activationLeadMinutes: 15,
};

const MINUTE_MS = 60_000;

const plusMinutes = (instant: Date, minutes: number): Date =>
  new Date(instant.getTime() + minutes * MINUTE_MS);

/**
 * La finestra riservata da una corsa immediata:
 * `[assegnazione, assegnazione + ETA + durata stimata + buffer)` (DD §2.4, decisione D8).
 *
 * **Ogni assegnazione riserva un intervallo limitato.** Un intervallo illimitato renderebbe
 * impossibile qualunque prenotazione futura sullo stesso veicolo, ed è la ragione per cui il
 * vincolo C1 può essere garantito da un vincolo di database invece che dal codice applicativo.
 * Il limite superiore si chiude all'istante effettivo quando la corsa termina o viene annullata:
 * è un `update` della riserva, non un'operazione a sé.
 */
export function immediateReservationWindow(
  assignedAt: Date,
  etaToPickupMinutes: number,
  estimatedRideMinutes: number,
  timing: ReservationTiming = DEFAULT_RESERVATION_TIMING,
): TimeWindow {
  return {
    start: assignedAt,
    end: plusMinutes(assignedAt, etaToPickupMinutes + estimatedRideMinutes + timing.bufferMinutes),
  };
}

/**
 * La finestra riservata da una prenotazione anticipata:
 * `[orario − anticipo, orario + ETA + durata stimata + buffer)` (DD §2.4, decisione D8).
 *
 * L'inizio anticipato non è un dettaglio: coincide con l'istante in cui
 * `AdvanceBookingActivator.runOnce()` trasformerà la prenotazione in assegnazione (decisione D9),
 * quindi il veicolo risulta occupato esattamente da quando serve che lo sia.
 */
export function advanceReservationWindow(
  scheduledPickup: Date,
  etaToPickupMinutes: number,
  estimatedRideMinutes: number,
  timing: ReservationTiming = DEFAULT_RESERVATION_TIMING,
): TimeWindow {
  return {
    start: plusMinutes(scheduledPickup, -timing.activationLeadMinutes),
    end: plusMinutes(
      scheduledPickup,
      etaToPickupMinutes + estimatedRideMinutes + timing.bufferMinutes,
    ),
  };
}

/** L'istante in cui una prenotazione va attivata: `orario − anticipo` (decisione D9). */
export function activationDueAt(
  scheduledPickup: Date,
  timing: ReservationTiming = DEFAULT_RESERVATION_TIMING,
): Date {
  return plusMinutes(scheduledPickup, -timing.activationLeadMinutes);
}

// ---------------------------------------------------------------------------------------------
// I record persistiti
// ---------------------------------------------------------------------------------------------

/** Un utente. `passwordHash` non lascia mai il backend: M1b lo esclude da ogni DTO. */
export interface UserRecord {
  readonly id: string;
  readonly email: string;
  readonly passwordHash: string;
  readonly name: string;
  readonly surname: string;
  readonly phoneNumber: string | null;
  readonly role: UserRole;
  readonly createdAt: Date;
}

/**
 * Una zona di Milano. Il centroide è l'unico dato geometrico: l'appartenenza si decide per
 * centroide più vicino (decisione D10), quindi non esiste una colonna raggio.
 */
export interface ZoneRecord {
  readonly id: string;
  readonly name: string;
  readonly lat: number;
  readonly lon: number;
}

/** Un veicolo della flotta. `state` è la colonna enum da cui M2 ricostruirà l'oggetto di stato. */
export interface RobotaxiRecord {
  readonly id: string;
  readonly state: RobotaxiState;
  readonly lat: number;
  readonly lon: number;
  readonly zoneId: string | null;
  readonly updatedAt: Date;
}

/** Una richiesta di corsa, immediata o anticipata (`kind`). */
export interface RideRequestRecord {
  readonly id: string;
  readonly passengerId: string;
  readonly kind: RideRequestKind;
  readonly status: RideRequestStatus;
  readonly pickupLat: number;
  readonly pickupLon: number;
  readonly pickupAddress: string | null;
  readonly destinationLat: number;
  readonly destinationLon: number;
  readonly destinationAddress: string | null;
  readonly assignedRobotaxiId: string | null;
  readonly createdAt: Date;
}

/**
 * Il dato specifico di una prenotazione anticipata.
 *
 * `activationDueAt` è `scheduledPickup − activationLead` calcolato al momento della prenotazione:
 * memorizzarlo rende la ricerca delle prenotazioni dovute una semplice disuguaglianza e congela
 * l'anticipo con cui la prenotazione è stata accettata, che è ciò che il passeggero si aspetta
 * anche se la configurazione cambia dopo.
 */
export interface BookingRecord {
  readonly id: string;
  readonly rideRequestId: string;
  readonly robotaxiId: string | null;
  readonly reservationId: string | null;
  readonly scheduledPickup: Date;
  readonly activationDueAt: Date;
  readonly activatedAt: Date | null;
  readonly createdAt: Date;
}

/**
 * Una riserva: il veicolo `robotaxiId` è impegnato per la corsa `rideRequestId` nella finestra
 * `period`. Il vincolo di esclusione sul database impedisce che due riserve dello stesso veicolo
 * si sovrappongano, qualunque sia l'interleaving degli scrittori (NFR4).
 */
export interface ReservationRecord {
  readonly id: string;
  readonly robotaxiId: string;
  readonly rideRequestId: string;
  readonly period: TimeWindow;
  readonly createdAt: Date;
}

/** La domanda di base per zona e fascia oraria settimanale (DD §2.2.1, decisione D12). */
export interface DemandSampleRecord {
  readonly id: string;
  readonly zoneId: string;
  /** 0 = domenica … 6 = sabato, la convenzione di `Date.getUTCDay()`. */
  readonly dayOfWeek: number;
  readonly hourOfDay: number;
  readonly baseDemand: number;
}

/** Un evento che moltiplica la domanda di una zona in `[startsAt, endsAt)` (decisione D12). */
export interface DemandEventRecord {
  readonly id: string;
  readonly zoneId: string;
  readonly name: string;
  readonly startsAt: Date;
  readonly endsAt: Date;
  readonly multiplier: number;
}

/** Un periodo di indisponibilità del veicolo (RASD `MaintenanceEvent`, R9). */
export interface MaintenanceRecord {
  readonly id: string;
  readonly robotaxiId: string;
  readonly reason: string;
  readonly status: MaintenanceStatus;
  readonly startedAt: Date;
  readonly endedAt: Date | null;
}

/**
 * Strategia attiva e modo di controllo, in **un solo record** (DD §2.2.1, decisione D6).
 *
 * È l'unica sede autorevole dei due valori: tenerli in memoria li farebbe divergere fra repliche
 * del tier applicativo (NFR3). `lastTrafficLevel` è persistito per la stessa ragione — `enableAuto()`
 * deve rivalutare subito l'ultimo livello noto (decisione D11), e una replica che non ha visto
 * l'ultima lettura di traffico non saprebbe quale sia.
 */
export interface SystemModeRecord {
  readonly id: string;
  readonly activeStrategy: StrategyName;
  readonly mode: ControlMode;
  readonly lastTrafficLevel: TrafficLevel | null;
  readonly updatedAt: Date;
}

/** Una notifica destinata a un utente (RASD §2.2.3). Il trasporto push arriva con M5. */
export interface NotificationRecord {
  readonly id: string;
  readonly recipientId: string;
  readonly rideRequestId: string | null;
  readonly type: NotificationType;
  readonly message: string;
  readonly createdAt: Date;
}

/**
 * Il registro dei tipi persistiti: la chiave è il nome della tabella, il valore la forma del
 * record. `create` e `update` sono generiche su questa mappa, così una chiave sbagliata o un campo
 * di troppo sono errori di compilazione e non di runtime.
 */
export interface PersistedRecords {
  readonly user: UserRecord;
  readonly zone: ZoneRecord;
  readonly robotaxi: RobotaxiRecord;
  readonly ride_request: RideRequestRecord;
  readonly booking: BookingRecord;
  readonly robotaxi_reservation: ReservationRecord;
  readonly demand_sample: DemandSampleRecord;
  readonly demand_event: DemandEventRecord;
  readonly maintenance_record: MaintenanceRecord;
  readonly system_mode: SystemModeRecord;
  readonly notification: NotificationRecord;
}

export type EntityKind = keyof PersistedRecords;

/** Il record identificato da una chiave del registro. */
export type PersistedRecord<K extends EntityKind> = PersistedRecords[K];

/**
 * Le tabelle il cui identificatore lo genera il database (`gen_random_uuid()`).
 *
 * Le altre — `zone`, `robotaxi`, `system_mode` — hanno una chiave *parlante* (`duomo`, `RT-01`,
 * `singleton`) che chi scrive il record deve fornire, ed è voluto: i pareggi di ogni ordinamento
 * del sistema si rompono sull'id crescente, e un identificatore leggibile rende leggibile anche
 * la regola. Il tipo lo impone, quindi dimenticarlo è un errore di compilazione e non di runtime.
 */
export type GeneratedIdKind =
  | 'user'
  | 'ride_request'
  | 'booking'
  | 'robotaxi_reservation'
  | 'demand_sample'
  | 'demand_event'
  | 'maintenance_record'
  | 'notification';

/** Le marche temporali che il manager riempie da `ClockPort` quando il chiamante non le indica. */
type Timestamps = 'createdAt' | 'updatedAt';

/**
 * La forma accettata da `create`: tutti i campi del record, meno quelli generati.
 *
 * Le date restano indicabili perché il seed e i test hanno bisogno di valori fissi; se non le si
 * passa vengono da `ClockPort`, mai dall'orologio di sistema (CLAUDE.md Regola 3).
 */
export type NewRecord<K extends EntityKind> = Omit<PersistedRecord<K>, 'id' | Timestamps> &
  Partial<Pick<PersistedRecord<K>, Extract<keyof PersistedRecord<K>, Timestamps>>> &
  (K extends GeneratedIdKind ? { readonly id?: string } : { readonly id: string });

/** La forma accettata da `update`: un sottoinsieme dei campi, id escluso. */
export type RecordPatch<K extends EntityKind> = Partial<Omit<PersistedRecord<K>, 'id'>>;

// ---------------------------------------------------------------------------------------------
// Riserva
// ---------------------------------------------------------------------------------------------

/**
 * L'input di `reserve`.
 *
 * `booking` è presente solo per le prenotazioni anticipate: passandolo, la riga di `booking` e
 * quella di `robotaxi_reservation` vengono scritte **nella stessa transazione**, che è ciò che
 * MILESTONES.md §M4 pretende ("o scrive entrambe le righe o nessuna"). Senza questo campo servirebbe
 * una quinta operazione sulla porta, che il DD §2.2 non prevede.
 */
export interface ReservationInput {
  readonly robotaxiId: string;
  readonly rideRequestId: string;
  readonly window: TimeWindow;
  readonly booking?: Omit<NewRecord<'booking'>, 'reservationId'>;
}

/**
 * Perché una riserva non è stata scritta.
 *
 * - `ROBOTAXI_BUSY`: la riga del veicolo è bloccata da un'altra transazione in corso. La lettura
 *   dei candidati è `SELECT ... FOR UPDATE SKIP LOCKED`, quindi chi arriva secondo non si mette in
 *   coda: rinuncia subito e il chiamante ri-alloca su un altro veicolo, che è il comportamento
 *   utile quando due richieste immediate concorrono (NFR1).
 * - `OVERLAPPING_RESERVATION`: la finestra si sovrappone a una riserva già scritta. È il vincolo
 *   di esclusione del database a rifiutarla, non un controllo applicativo (NFR4).
 * - `UNKNOWN_ROBOTAXI`: l'identificatore non corrisponde ad alcun veicolo.
 */
export type ReservationRejection = 'ROBOTAXI_BUSY' | 'OVERLAPPING_RESERVATION' | 'UNKNOWN_ROBOTAXI';

/** L'esito di `reserve`: o la riserva (con l'eventuale prenotazione), o il motivo del rifiuto. */
export type ReservationOutcome =
  | {
      readonly reserved: true;
      readonly reservation: ReservationRecord;
      readonly booking: BookingRecord | null;
    }
  | { readonly reserved: false; readonly reason: ReservationRejection };

// ---------------------------------------------------------------------------------------------
// La porta
// ---------------------------------------------------------------------------------------------

export abstract class PersistencePort {
  /** Scrive un nuovo record e lo restituisce completo dei campi generati. */
  abstract create<K extends EntityKind>(kind: K, data: NewRecord<K>): Promise<PersistedRecord<K>>;

  /**
   * Aggiorna i campi indicati e restituisce il record aggiornato.
   * Solleva `RecordNotFoundError` se l'identificatore non esiste.
   */
  abstract update<K extends EntityKind>(
    kind: K,
    id: string,
    patch: RecordPatch<K>,
  ): Promise<PersistedRecord<K>>;

  /**
   * Dei veicoli indicati, quelli **senza** alcuna riserva che si sovrapponga alla finestra.
   *
   * È il filtro sulla timeline richiesto dal DD §2.2 e usato sia dalla richiesta immediata sia
   * dalla prenotazione anticipata. Non guarda lo stato del veicolo né la manutenzione: quelli sono
   * affari di `FleetMonitor` (M2), che produce l'insieme dei candidati passato qui.
   *
   * Restituisce gli identificatori in ordine crescente, perché ogni ordinamento del sistema
   * dev'essere totale e deterministico.
   */
  abstract filterAvailable(robotaxiIds: readonly string[], window: TimeWindow): Promise<string[]>;

  /**
   * Impegna un veicolo su una finestra, in una sola transazione.
   *
   * L'atomicità non è affidata al codice: la sovrapposizione è impedita dal vincolo di esclusione
   * `no_overlapping_reservations` sul database (NFR4, C1). Questo metodo non solleva eccezioni per
   * i conflitti — li descrive nel proprio esito, perché un conflitto è un esito previsto del
   * dominio e non un errore di programmazione.
   */
  abstract reserve(input: ReservationInput): Promise<ReservationOutcome>;
}

/** Sollevata da `update` quando l'identificatore non corrisponde ad alcun record. */
export class RecordNotFoundError extends Error {
  constructor(
    readonly kind: EntityKind,
    readonly id: string,
  ) {
    super(`Nessun record "${kind}" con id ${id}.`);
    this.name = 'RecordNotFoundError';
  }
}
