import { Test, type TestingModule } from '@nestjs/testing';
import {
  DEFAULT_STRATEGY,
  ROBOTAXI_STATES,
  type GeoPoint,
  type StrategyName,
  type TrafficLevel,
} from '@road/shared';

import { AllocationPort } from '../../src/allocation/allocation.port';
import {
  ExternalServicesPort,
  type RouteCommandOutcome,
  type RouteRequest,
  type VehicleTelemetry,
} from '../../src/external/external-services.port';
import {
  FleetMonitorPort,
  type FleetStatus,
  type ObservedPosition,
} from '../../src/fleet/fleet-monitor.port';
import {
  ALLOCATABLE_STATES,
  BOOKABLE_STATES,
  CANCELLABLE_STATES,
  IllegalTransitionError,
  type RideAssignment,
  type RobotaxiSnapshot,
  type RobotaxiTransition,
} from '../../src/fleet/robotaxi.port';
import {
  PersistencePort,
  RecordNotFoundError,
  SYSTEM_MODE_ID,
  type EntityKind,
  type FindCriteria,
  type NewRecord,
  type PersistedRecord,
  type RecordPatch,
  type ReservationInput,
  type ReservationOutcome,
  type ReservationRejection,
  type TimeWindow,
} from '../../src/persistence/persistence.port';
import { ClockPort } from '../../src/platform/clock.port';
import { FakeClock } from '../../src/platform/fake-clock';
import { NotificationSessionPort } from '../../src/notifications/session.port';
import { AdvanceBookingActivatorPort } from '../../src/rides/advance-booking.port';
import { FleetTelemetryPort } from '../../src/rides/fleet-telemetry.port';
import { RideLifecyclePort } from '../../src/rides/ride-lifecycle.port';
import { RidesModule } from '../../src/rides/rides.module';
import { RideRequestPort } from '../../src/rides/rides.port';

/**
 * Il modulo `rides` composto **senza database e senza rete**, per i casi che un database renderebbe
 * solo più difficili da costruire (M4).
 *
 * Dove passa il confine fra questi test e quelli di integrazione: su Postgres si verifica ciò che
 * *è* il database — l'atomicità di prenotazione e riserva, il vincolo di esclusione, la catena
 * completa —, e infatti il cancello di M4 gira lì. Qui si verifica ciò che il **coordinatore**
 * decide quando qualcosa va storto: un veicolo che si è fatto prendere da un altro fra la scelta e
 * la riserva, uno che va in officina fra la lettura dei candidati e l'assegnazione, un fornitore di
 * ETA che non sa rispondere. Sono corse fra due scritture: su un database vero si costruirebbero
 * governando l'interleaving di due transazioni, e il test parlerebbe di lock invece che della
 * decisione presa.
 *
 * Il modulo si raggiunge solo dalle sue porte (CLAUDE.md Regola 1): questo file inietta
 * `RideRequestPort` e `AdvanceBookingActivatorPort` e sostituisce `PersistencePort`,
 * `FleetMonitorPort`, `AllocationPort`, `ExternalServicesPort` e `ClockPort`, che sono porte
 * anch'esse. Nessun test conosce `RideRequestManager` né `RideAllocator`.
 */

type StoredRecord = Record<string, unknown>;

/**
 * Il doppio di `PersistencePort`: un archivio in memoria delle sole tabelle che `rides` tocca.
 *
 * Riproduce le tre proprietà da cui il coordinatore dipende, e nient'altro: le riserve non
 * rilasciate dello stesso veicolo non possono sovrapporsi, `filterAvailable` esclude chi ne ha una
 * nella finestra, e prenotazione e riserva nascono insieme. È una **riproduzione**, non il vero
 * meccanismo: il vincolo di esclusione è una funzione di PostgreSQL e la sua verifica sta nel
 * cancello di M1 e nei test di integrazione, dove il database è vero.
 */
export class RidesPersistenceDouble extends PersistencePort {
  private readonly tables = new Map<EntityKind, StoredRecord[]>();
  private readonly blocked = new Map<string, ReservationRejection>();
  private sequence = 0;

  constructor(
    private readonly clock: FakeClock,
    activeStrategy: StrategyName = DEFAULT_STRATEGY,
  ) {
    super();
    this.tables.set('system_mode', [
      {
        id: SYSTEM_MODE_ID,
        activeStrategy,
        mode: 'AUTO',
        lastTrafficLevel: null,
        updatedAt: clock.now(),
      },
    ]);
  }

  /**
   * Fa fallire ogni riserva su quel veicolo, con il motivo indicato.
   *
   * È il modo di costruire le due corse che il coordinatore deve saper perdere: `ROBOTAXI_BUSY`,
   * cioè un'altra transazione ha già bloccato la riga, e `OVERLAPPING_RESERVATION`, cioè il vincolo
   * di esclusione ha rifiutato la finestra. Entrambe accadono **dopo** che la strategia ha scelto,
   * ed è per questo che non sono evitabili con un controllo preventivo.
   */
  blockReservationsFor(robotaxiId: string, reason: ReservationRejection): void {
    this.blocked.set(robotaxiId, reason);
  }

  /** Le righe di una tabella, per le asserzioni. */
  rowsOf<K extends EntityKind>(kind: K): PersistedRecord<K>[] {
    return [...(this.tables.get(kind) ?? [])].map((row) => asRecord<PersistedRecord<K>>(row));
  }

  override create<K extends EntityKind>(kind: K, data: NewRecord<K>): Promise<PersistedRecord<K>> {
    const now = this.clock.now();
    const supplied = data as StoredRecord;
    const record: StoredRecord = {
      id: supplied.id ?? `${kind}-${++this.sequence}`,
      createdAt: now,
      updatedAt: now,
      ...supplied,
    };

    this.rowsFor(kind).push(record);
    return Promise.resolve(asRecord<PersistedRecord<K>>({ ...record }));
  }

  override update<K extends EntityKind>(
    kind: K,
    id: string,
    patch: RecordPatch<K>,
  ): Promise<PersistedRecord<K>> {
    const record = this.rowsFor(kind).find((row) => row.id === id);
    if (record === undefined) return Promise.reject(new RecordNotFoundError(kind, id));

    Object.assign(record, patch, { updatedAt: this.clock.now() });
    return Promise.resolve(asRecord<PersistedRecord<K>>({ ...record }));
  }

  override find<K extends EntityKind>(
    kind: K,
    criteria: FindCriteria<K> = {},
  ): Promise<PersistedRecord<K>[]> {
    const where = (criteria.where ?? {}) as Record<string, unknown>;
    let rows = this.rowsFor(kind).filter((row) =>
      Object.entries(where).every(([field, criterion]) => matches(row[field], criterion)),
    );

    /**
     * L'ordinamento applica **tutte** le chiavi, non solo la prima.
     *
     * Non è pignoleria: `AdvanceBookingActivator` ordina per `[activationDueAt, id]` proprio perché
     * il pareggio sia risolto in modo totale, e un doppio che si fermasse alla prima chiave
     * lascerebbe quella regola non verificabile — l'ordine dipenderebbe da quello di inserimento, e
     * il test passerebbe per caso.
     */
    const orderBy = criteria.orderBy ?? [{ field: 'id' as const }];
    /**
     * Le righe si mescolano **prima** di ordinarle, invertendone l'ordine di inserimento.
     *
     * Un archivio in memoria restituirebbe naturalmente le righe nell'ordine in cui sono state
     * scritte, che è più deterministico di un database vero: senza `ORDER BY`, PostgreSQL non
     * promette nulla. Un doppio più gentile della realtà nasconde esattamente i difetti che questi
     * test cercano — un ordinamento a cui manca la chiave di pareggio passerebbe qui e sarebbe
     * instabile in produzione. Invertire è il disordine più economico che resta riproducibile.
     */
    rows = [...rows].reverse();
    rows = rows.sort((left, right) => {
      for (const order of orderBy) {
        const sign = order.direction === 'desc' ? -1 : 1;
        const difference = compare(left[order.field], right[order.field]) * sign;
        if (difference !== 0) return difference;
      }
      return 0;
    });

    if (criteria.limit !== undefined) rows = rows.slice(0, criteria.limit);
    return Promise.resolve(rows.map((row) => asRecord<PersistedRecord<K>>({ ...row })));
  }

  override filterAvailable(robotaxiIds: readonly string[], window: TimeWindow): Promise<string[]> {
    const free = robotaxiIds.filter((id) => !this.hasOverlap(id, window));
    return Promise.resolve([...free].sort());
  }

  override reserve(input: ReservationInput): Promise<ReservationOutcome> {
    const blocked = this.blocked.get(input.robotaxiId);
    if (blocked !== undefined) return Promise.resolve({ reserved: false, reason: blocked });
    if (this.hasOverlap(input.robotaxiId, input.window)) {
      return Promise.resolve({ reserved: false, reason: 'OVERLAPPING_RESERVATION' });
    }

    const now = this.clock.now();
    const reservation: StoredRecord = {
      id: `robotaxi_reservation-${++this.sequence}`,
      robotaxiId: input.robotaxiId,
      rideRequestId: input.rideRequestId,
      period: input.window,
      releasedAt: null,
      createdAt: now,
    };
    this.rowsFor('robotaxi_reservation').push(reservation);

    let booking: StoredRecord | null = null;
    if (input.booking !== undefined) {
      booking = {
        id: `booking-${++this.sequence}`,
        ...(input.booking as StoredRecord),
        rideRequestId: input.rideRequestId,
        reservationId: reservation.id,
        createdAt: now,
      };
      this.rowsFor('booking').push(booking);
    }

    // Il legame richiesta↔veicolo si scrive nella stessa transazione (decisione D35): il doppio lo
    // riproduce, o i test non vedrebbero la colonna che `cancel()` usa per ritrovare il veicolo.
    if (input.rideRequest !== undefined) {
      const request = this.rowsFor('ride_request').find((row) => row.id === input.rideRequestId);
      if (request === undefined) {
        return Promise.reject(new RecordNotFoundError('ride_request', input.rideRequestId));
      }
      Object.assign(request, input.rideRequest);
    }

    return Promise.resolve({
      reserved: true,
      reservation: asRecord<PersistedRecord<'robotaxi_reservation'>>({ ...reservation }),
      booking: booking === null ? null : asRecord<PersistedRecord<'booking'>>({ ...booking }),
    });
  }

  /** Il veicolo ha una riserva **non rilasciata** che si sovrappone alla finestra semiaperta. */
  private hasOverlap(robotaxiId: string, window: TimeWindow): boolean {
    return this.rowsFor('robotaxi_reservation').some((row) => {
      if (row.robotaxiId !== robotaxiId || row.releasedAt !== null) return false;
      const period = row.period as TimeWindow;
      return period.start < window.end && window.start < period.end;
    });
  }

  private rowsFor(kind: EntityKind): StoredRecord[] {
    const existing = this.tables.get(kind);
    if (existing !== undefined) return existing;

    const created: StoredRecord[] = [];
    this.tables.set(kind, created);
    return created;
  }
}

/**
 * Il doppio di `FleetMonitorPort`: una flotta in memoria con la sola disciplina che serve qui —
 * un veicolo si assegna una volta sola, e solo se è in uno stato allocabile.
 *
 * Non riproduce la macchina a stati: quella è di `fleet`, è verificata in modo esaustivo dal
 * cancello di M2, e riscriverla qui significherebbe avere due macchine che divergono. L'insieme
 * degli stati allocabili viene infatti da `ALLOCATABLE_STATES`, che `fleet` pubblica: se un giorno
 * la figura 2.10 ne aggiungesse uno, questo doppio lo seguirebbe invece di restare indietro in
 * silenzio. Delle transizioni riproduce le due condizioni di ingresso che i test di `rides` devono
 * poter far fallire — assegnare un veicolo non allocabile, liberarne uno che non è `ASSIGNED`.
 *
 * Ciò che questo doppio permette è **cambiare la flotta fra due chiamate** — mandare in officina il
 * veicolo riservato di una prenotazione — che è il caso che M4 deve saper gestire.
 */
export class FleetDouble extends FleetMonitorPort {
  private readonly vehicles = new Map<string, RobotaxiSnapshot>();
  readonly assignments: Array<{ robotaxiId: string; rideRequestId: string }> = [];

  constructor(
    private readonly clock: FakeClock,
    vehicles: readonly RobotaxiSnapshot[] = [],
  ) {
    super();
    for (const vehicle of vehicles) this.vehicles.set(vehicle.id, vehicle);
  }

  /** Aggiunge o sostituisce un veicolo: è così che un test lo manda in manutenzione. */
  put(vehicle: RobotaxiSnapshot): void {
    this.vehicles.set(vehicle.id, vehicle);
  }

  setState(robotaxiId: string, state: RobotaxiSnapshot['state']): void {
    const vehicle = this.vehicles.get(robotaxiId);
    if (vehicle === undefined) throw new Error(`Nessun veicolo ${robotaxiId} nel doppio.`);
    this.vehicles.set(robotaxiId, { ...vehicle, state });
  }

  stateOf(robotaxiId: string): RobotaxiSnapshot['state'] | undefined {
    return this.vehicles.get(robotaxiId)?.state;
  }

  getCandidates(): Promise<RobotaxiSnapshot[]> {
    return Promise.resolve(this.allocatable());
  }

  getBookableRobotaxis(): Promise<RobotaxiSnapshot[]> {
    return Promise.resolve(
      [...this.vehicles.values()]
        .filter((vehicle) => BOOKABLE_STATES.includes(vehicle.state))
        .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0)),
    );
  }

  getAvailableRobotaxis(): Promise<RobotaxiSnapshot[]> {
    return Promise.resolve(this.allocatable().filter((vehicle) => vehicle.state === 'AVAILABLE'));
  }

  /**
   * La fotografia della flotta.
   *
   * Fino a M6 il doppio la rifiutava: nessun test di `rides` ne aveva bisogno, e rispondere a una
   * domanda che nessuno fa è un modo di far sembrare verificato ciò che non lo è. Da M7 serve
   * davvero — `FleetTelemetry` la usa per sapere in che stato è il veicolo di ogni corsa in corso —
   * quindi il doppio la produce, con i conteggi calcolati e non inventati.
   */
  getFleetStatus(): Promise<FleetStatus> {
    const robotaxis = [...this.vehicles.values()].sort((left, right) =>
      left.id < right.id ? -1 : left.id > right.id ? 1 : 0,
    );
    const countsByState = Object.fromEntries(ROBOTAXI_STATES.map((state) => [state, 0])) as Record<
      RobotaxiSnapshot['state'],
      number
    >;
    for (const vehicle of robotaxis) countsByState[vehicle.state] += 1;

    return Promise.resolve({
      observedAt: this.clock.now(),
      total: robotaxis.length,
      countsByState,
      robotaxis,
    });
  }

  assign(robotaxiId: string, request: RideAssignment): Promise<RobotaxiSnapshot> {
    const vehicle = this.require(robotaxiId);
    if (!ALLOCATABLE_STATES.includes(vehicle.state)) {
      return Promise.reject(new IllegalTransitionError(robotaxiId, vehicle.state, 'assignRide'));
    }

    this.assignments.push({ robotaxiId, rideRequestId: request.rideRequestId });
    return Promise.resolve(this.moveTo(robotaxiId, 'ASSIGNED'));
  }

  /**
   * L'annullamento, ammesso da **tre** stati (transizioni 11, 12 e 13 della Figura 2.10).
   *
   * Le due nuove entrano con M7: `commandRoute()` esiste, quindi un veicolo in avvicinamento o già
   * fermo al ritiro può essere fermato revocandogli la rotta (decisione D59). Da `IN_RIDE` resta
   * vietato, ed è il confine di R14 — la corsa comincia quando il passeggero sale.
   */
  releaseAssignment(robotaxiId: string): Promise<RobotaxiSnapshot> {
    const vehicle = this.require(robotaxiId);
    if (!CANCELLABLE_STATES.includes(vehicle.state)) {
      return Promise.reject(new IllegalTransitionError(robotaxiId, vehicle.state, 'cancelRide'));
    }
    return Promise.resolve(this.moveTo(robotaxiId, 'AVAILABLE'));
  }

  /**
   * Le quattro transizioni con cui una corsa avanza (M5, transizioni 4–7 della Figura 2.10).
   *
   * Come le altre, il doppio riproduce **solo la condizione di ingresso**: da quale stato il passo
   * è ammesso. La macchina a stati vera resta di `fleet` e il cancello di M2 la verifica in modo
   * esaustivo; qui serve che un passo fuori tempo fallisca come fallirebbe davvero, perché è su
   * quello che `RideLifecycle` costruisce la propria garanzia — il veicolo prima, la corsa poi.
   */
  startPickupNavigation(robotaxiId: string): Promise<RobotaxiSnapshot> {
    return this.advance(robotaxiId, 'ASSIGNED', 'ARRIVING', 'startPickupNavigation');
  }

  pickupReached(robotaxiId: string): Promise<RobotaxiSnapshot> {
    return this.advance(robotaxiId, 'ARRIVING', 'ARRIVED', 'pickupReached');
  }

  startRide(robotaxiId: string): Promise<RobotaxiSnapshot> {
    return this.advance(robotaxiId, 'ARRIVED', 'IN_RIDE', 'startRide');
  }

  completeRide(robotaxiId: string): Promise<RobotaxiSnapshot> {
    return this.advance(robotaxiId, 'IN_RIDE', 'AVAILABLE', 'completeRide');
  }

  private advance(
    robotaxiId: string,
    from: RobotaxiSnapshot['state'],
    to: RobotaxiSnapshot['state'],
    transition: RobotaxiTransition,
  ): Promise<RobotaxiSnapshot> {
    const vehicle = this.require(robotaxiId);
    if (vehicle.state !== from) {
      return Promise.reject(new IllegalTransitionError(robotaxiId, vehicle.state, transition));
    }
    return Promise.resolve(this.moveTo(robotaxiId, to));
  }

  requestRebalancing(robotaxiId: string): Promise<RobotaxiSnapshot> {
    return Promise.resolve(this.moveTo(robotaxiId, 'REBALANCING'));
  }

  completeRebalancing(robotaxiId: string): Promise<RobotaxiSnapshot> {
    return this.advance(robotaxiId, 'REBALANCING', 'AVAILABLE', 'completeRebalancing');
  }

  /** Le posizioni osservate: il doppio le registra, perché `rides` gliele consegna a ogni ciclo. */
  recordPositions(positions: readonly ObservedPosition[]): Promise<number> {
    let updated = 0;
    for (const position of positions) {
      const vehicle = this.vehicles.get(position.robotaxiId);
      if (vehicle === undefined) continue;
      this.vehicles.set(position.robotaxiId, {
        ...vehicle,
        lat: position.lat,
        lon: position.lon,
        updatedAt: position.observedAt,
      });
      updated += 1;
    }
    return Promise.resolve(updated);
  }

  private allocatable(): RobotaxiSnapshot[] {
    return [...this.vehicles.values()]
      .filter((vehicle) => ALLOCATABLE_STATES.includes(vehicle.state))
      .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
  }

  private require(robotaxiId: string): RobotaxiSnapshot {
    const vehicle = this.vehicles.get(robotaxiId);
    if (vehicle === undefined) throw new Error(`Nessun veicolo ${robotaxiId} nel doppio.`);
    return vehicle;
  }

  private moveTo(robotaxiId: string, state: RobotaxiSnapshot['state']): RobotaxiSnapshot {
    const moved = { ...this.require(robotaxiId), state };
    this.vehicles.set(robotaxiId, moved);
    return moved;
  }
}

/**
 * Il doppio di `ExternalServicesPort`: distanza in linea d'aria a velocità costante, e la
 * possibilità di dichiarare che di certe origini **non si sa nulla**.
 *
 * La seconda è il punto: la porta dichiara che un'origine per cui il fornitore non sa rispondere
 * non compare nell'esito, e `rides` deve trattarla come non idonea invece di inventarle una
 * finestra. L'adapter di M3 risponde sempre, quindi quel ramo non sarebbe raggiungibile senza
 * questo doppio.
 */
export class TravelTimeDouble extends ExternalServicesPort {
  private readonly unknown = new Set<string>();

  /**
   * I comandi di rotta ricevuti, nell'ordine (M7).
   *
   * Sono parte di ciò che c'è da verificare e non un dettaglio: R14 pretende che l'annullamento
   * **revochi la rotta prima** di liberare il veicolo, e l'unico modo di dimostrarlo è guardare cosa
   * è stato comandato alla flotta e quando.
   */
  readonly routeCommands: Array<{ robotaxiId: string; destination: GeoPoint | null }> = [];

  /** La telemetria dei veicoli a cui è stata comandata una rotta, per identificatore. */
  private readonly moving = new Map<string, { destination: GeoPoint; hasArrived: boolean }>();

  constructor(
    private readonly clock: FakeClock = new FakeClock(new Date('2026-05-04T09:00:00.000Z')),
    private readonly minutesPerDegree = 100,
  ) {
    super();
  }

  /** Da qui in poi il fornitore non sa rispondere per queste origini. */
  forget(...originIds: readonly string[]): void {
    for (const id of originIds) this.unknown.add(id);
  }

  /**
   * Il traffico non entra nella catena delle richieste di corsa: qui si verifica come una
   * richiesta diventa un'assegnazione, non con quale politica. A leggerlo è il `TrafficMonitor` di
   * M6, che questi casi non compongono.
   */
  getTraffic(): Promise<TrafficLevel> {
    return Promise.resolve('LOW');
  }

  getETA(
    origins: readonly { id: string; position: GeoPoint }[],
    destination: GeoPoint,
  ): Promise<readonly { id: string; etaMinutes: number }[]> {
    return Promise.resolve(
      origins.flatMap((origin) =>
        this.unknown.has(origin.id)
          ? []
          : [
              {
                id: origin.id,
                etaMinutes:
                  (Math.abs(origin.position.lat - destination.lat) +
                    Math.abs(origin.position.lon - destination.lon)) *
                  this.minutesPerDegree,
              },
            ],
      ),
    );
  }

  /**
   * Registra il comando e mette (o toglie) il veicolo fra quelli in movimento.
   *
   * Il doppio non simula il percorso — a farlo è `@road/simulator`, dietro l'adapter vero: qui
   * serve solo sapere **che cosa** è stato comandato, perché è su quello che l'annullamento di R14
   * e la progressione guidata dalla telemetria si verificano.
   */
  commandRoute(robotaxiId: string, route: RouteRequest | null): Promise<RouteCommandOutcome> {
    this.routeCommands.push({ robotaxiId, destination: route === null ? null : route.to });

    if (route === null) this.moving.delete(robotaxiId);
    else this.moving.set(robotaxiId, { destination: route.to, hasArrived: false });

    return Promise.resolve({
      robotaxiId,
      accepted: true,
      etaMinutes: route === null ? null : 0,
      distanceKm: route === null ? null : 0,
    });
  }

  /** Dichiara che il veicolo ha raggiunto la destinazione comandata: la guardia della Figura 2.10. */
  arrive(robotaxiId: string): void {
    const vehicle = this.moving.get(robotaxiId);
    if (vehicle === undefined) {
      throw new Error(
        `Nessuna rotta comandata al robotaxi ${robotaxiId}: non può essere arrivato.`,
      );
    }
    this.moving.set(robotaxiId, { ...vehicle, hasArrived: true });
  }

  readTelemetry(): Promise<readonly VehicleTelemetry[]> {
    const observedAt = this.clock.now();
    return Promise.resolve(
      [...this.moving.entries()]
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([robotaxiId, vehicle]) => ({
          robotaxiId,
          position: vehicle.destination,
          destination: vehicle.destination,
          remainingKm: vehicle.hasArrived ? 0 : 1,
          hasArrived: vehicle.hasArrived,
          observedAt,
        })),
    );
  }
}

export interface RidesHarness {
  readonly rides: RideRequestPort;
  readonly advanceBooking: AdvanceBookingActivatorPort;
  /** L'avanzamento di una corsa assegnata (M5): transizioni 4-7 della Figura 2.10. */
  readonly rideLifecycle: RideLifecyclePort;
  /**
   * Il giro che legge la telemetria e innesca quelle transizioni (M7).
   *
   * Nei test lo chiama il test, un giro alla volta: `RidesModule` si compone senza
   * `ScheduleModule`, quindi il `@Cron` resta inerte (CLAUDE.md Regola 3).
   */
  readonly fleetTelemetry: FleetTelemetryPort;
  /**
   * Il registro delle sessioni push (M5).
   *
   * `NotificationsModule` non è sostituito da un doppio: il `NotificationManager` che gira qui è
   * quello vero, e con lui le classi di sessione e la regola su chi riceve cosa. A essere finto è
   * solo il trasporto — vedi `support/notifications.ts`.
   */
  readonly notificationSessions: NotificationSessionPort;
  readonly persistence: RidesPersistenceDouble;
  readonly fleet: FleetDouble;
  readonly external: TravelTimeDouble;
  readonly clock: FakeClock;
  close(): Promise<void>;
}

export interface ComposeRidesOptions {
  readonly now?: Date;
  readonly vehicles?: readonly RobotaxiSnapshot[];
  readonly activeStrategy?: StrategyName;
}

export async function composeRides(options: ComposeRidesOptions = {}): Promise<RidesHarness> {
  const clock = new FakeClock(options.now ?? new Date('2026-05-04T09:00:00.000Z'));
  const persistence = new RidesPersistenceDouble(clock, options.activeStrategy);
  const fleet = new FleetDouble(clock, options.vehicles);
  const external = new TravelTimeDouble(clock);

  const moduleRef: TestingModule = await Test.createTestingModule({ imports: [RidesModule] })
    .overrideProvider(PersistencePort)
    .useValue(persistence)
    .overrideProvider(FleetMonitorPort)
    .useValue(fleet)
    .overrideProvider(ExternalServicesPort)
    .useValue(external)
    .overrideProvider(ClockPort)
    .useValue(clock)
    .compile();

  return {
    rides: moduleRef.get(RideRequestPort),
    advanceBooking: moduleRef.get(AdvanceBookingActivatorPort),
    rideLifecycle: moduleRef.get(RideLifecyclePort),
    fleetTelemetry: moduleRef.get(FleetTelemetryPort),
    notificationSessions: moduleRef.get(NotificationSessionPort),
    persistence,
    fleet,
    external,
    clock,
    close: () => moduleRef.close(),
  };
}

/** Un veicolo fermo nel punto indicato, disponibile. */
export function vehicleAt(id: string, point: GeoPoint): RobotaxiSnapshot {
  return {
    id,
    state: 'AVAILABLE',
    lat: point.lat,
    lon: point.lon,
    zoneId: null,
    updatedAt: new Date('2026-05-04T09:00:00.000Z'),
  };
}

/**
 * `AllocationPort` non viene sostituita: il modulo compone quella vera, con le sue due strategie e
 * la strategia attiva letta dal doppio di `PersistencePort`. È voluto — ciò che questi test
 * verificano è il *coordinamento*, e sostituire anche la scelta significherebbe verificare che il
 * coordinatore chiama un finto che risponde ciò che il test ha deciso.
 */
export { AllocationPort };

/**
 * L'unica conversione di tipo del doppio, isolata in un punto.
 *
 * `PersistencePort` è generica sul registro dei tipi persistiti, e un archivio che tiene le righe
 * come mappe di campi non può dimostrare al compilatore che una riga è proprio quella di `K`. È lo
 * stesso passaggio, e per la stessa ragione, che `SystemModeDouble` isola in `asRecordOf()`.
 */
function asRecord<T>(row: StoredRecord): T {
  return row as unknown as T;
}

/** Confronto totale per l'ordinamento del doppio: date, numeri e stringhe. */
function compare(left: unknown, right: unknown): number {
  const leftKey = left instanceof Date ? left.getTime() : left;
  const rightKey = right instanceof Date ? right.getTime() : right;

  if (typeof leftKey === 'number' && typeof rightKey === 'number') return leftKey - rightKey;
  return String(leftKey) < String(rightKey) ? -1 : String(leftKey) > String(rightKey) ? 1 : 0;
}

/** I criteri di `FindCriteria` che `rides` usa davvero: uguaglianza, `null`, `atMost`. */
function matches(value: unknown, criterion: unknown): boolean {
  if (criterion === null) return value === null;
  if (typeof criterion === 'object' && criterion !== null && !(criterion instanceof Date)) {
    const bound = (criterion as { atMost?: unknown }).atMost;
    if (bound instanceof Date && value instanceof Date) return value.getTime() <= bound.getTime();
    throw new Error(
      `Il doppio di PersistencePort non gestisce il criterio ${JSON.stringify(criterion)}.`,
    );
  }
  if (value instanceof Date && criterion instanceof Date) {
    return value.getTime() === criterion.getTime();
  }
  return value === criterion;
}
