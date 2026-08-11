import { Injectable } from '@nestjs/common';
import { ROBOTAXI_STATES, type RobotaxiState as RobotaxiStateName } from '@road/shared';

import {
  PersistencePort,
  type PersistedRecord,
  type TimeWindow,
} from '../persistence/persistence.port';
import { ClockPort } from '../platform/clock.port';

import {
  ALLOCATABLE_STATES,
  FleetMonitorPort,
  UnknownRobotaxiError,
  type FleetStatus,
} from './fleet-monitor.port';
import type { RideAssignment } from './ride-assignment';
import { Robotaxi, type RobotaxiSnapshot } from './robotaxi';

/**
 * Il `FleetMonitor` (DD §2.2): la fotografia della flotta e il coordinamento del ciclo di vita.
 *
 * Non contiene una riga di logica di transizione. Legge il record, ricostruisce il `Robotaxi` con
 * `RobotaxiStateFactory`, gli chiede la transizione e ne persiste lo stato: **decide il veicolo**,
 * attraverso la classe di stato corrente. Se qui comparisse un `switch` sullo stato, il pattern
 * State sarebbe scritto due volte e le due copie divergerebbero (CLAUDE.md Regola 2).
 *
 * Il DD §2.6.4 lo chiama Singleton: è l'istanza unica iniettata da Nest in ogni processo del tier
 * applicativo. L'indice in memoria che il DD gli attribuisce non c'è ancora ed è voluto — sarebbe
 * una cache di un dato autorevole che sta nel database, e finché non c'è un costo misurato da
 * abbattere sarebbe solo una seconda verità da tenere allineata (NFR3).
 */
@Injectable()
export class FleetMonitor extends FleetMonitorPort {
  constructor(
    private readonly persistence: PersistencePort,
    private readonly clock: ClockPort,
  ) {
    super();
  }

  async getCandidates(window?: TimeWindow): Promise<RobotaxiSnapshot[]> {
    const allocatable = await this.persistence.find('robotaxi', {
      where: { state: { oneOf: ALLOCATABLE_STATES } },
      orderBy: [{ field: 'id' }],
    });

    if (window === undefined) return allocatable.map(toSnapshot);

    // Il filtro sulla timeline è del `PersistenceManager` (DD §2.2): è lì che vive il vincolo di
    // esclusione, e chiedere altrove quali finestre sono libere significherebbe rispondere da una
    // copia. `filterAvailable` restituisce già gli identificatori in ordine crescente.
    const free = new Set(await this.persistence.filterAvailable(allocatable.map(byId), window));
    return allocatable.filter((record) => free.has(record.id)).map(toSnapshot);
  }

  async getAvailableRobotaxis(): Promise<RobotaxiSnapshot[]> {
    const idle = await this.persistence.find('robotaxi', {
      where: { state: 'AVAILABLE' },
      orderBy: [{ field: 'id' }],
    });
    return idle.map(toSnapshot);
  }

  async getFleetStatus(): Promise<FleetStatus> {
    const fleet = await this.persistence.find('robotaxi', { orderBy: [{ field: 'id' }] });

    // Tutti e sette gli stati compaiono, anche quelli a zero: una status bar in cui una colonna
    // sparisce quando è vuota costringe il client a indovinare l'insieme dei valori possibili.
    const countsByState = Object.fromEntries(ROBOTAXI_STATES.map((state) => [state, 0])) as Record<
      RobotaxiStateName,
      number
    >;
    for (const record of fleet) countsByState[record.state] += 1;

    return {
      observedAt: this.clock.now(),
      total: fleet.length,
      countsByState,
      robotaxis: fleet.map(toSnapshot),
    };
  }

  async assign(robotaxiId: string, request: RideAssignment): Promise<RobotaxiSnapshot> {
    return this.applyTransition(robotaxiId, (robotaxi) => robotaxi.assignRide(request));
  }

  async requestRebalancing(robotaxiId: string): Promise<RobotaxiSnapshot> {
    return this.applyTransition(robotaxiId, (robotaxi) => robotaxi.requestRebalancing());
  }

  /**
   * Legge, transisce, persiste.
   *
   * La transizione avviene **prima** della scrittura: se lo stato corrente non la ammette,
   * `IllegalTransitionError` esce di qui e il database non è stato toccato. È la proprietà per cui
   * NFR5 non ha bisogno di compensazioni.
   */
  private async applyTransition(
    robotaxiId: string,
    transition: (robotaxi: Robotaxi) => void,
  ): Promise<RobotaxiSnapshot> {
    const [record] = await this.persistence.find('robotaxi', {
      where: { id: robotaxiId },
      limit: 1,
    });
    if (record === undefined) throw new UnknownRobotaxiError(robotaxiId);

    const robotaxi = new Robotaxi(toSnapshot(record));
    transition(robotaxi);

    const updated = await this.persistence.update('robotaxi', robotaxiId, {
      state: robotaxi.currentState,
      updatedAt: this.clock.now(),
    });
    return toSnapshot(updated);
  }
}

const byId = (record: PersistedRecord<'robotaxi'>): string => record.id;

/**
 * Dal record persistito alla vista pubblica.
 *
 * Sono due tipi con gli stessi campi e restano due: il primo è la forma della riga, il secondo il
 * vocabolario del modulo `fleet`. Fonderli legherebbe la porta allo schema, e cambiare una colonna
 * diventerebbe un cambiamento di contratto.
 */
function toSnapshot(record: PersistedRecord<'robotaxi'>): RobotaxiSnapshot {
  return {
    id: record.id,
    state: record.state,
    lat: record.lat,
    lon: record.lon,
    zoneId: record.zoneId,
    updatedAt: record.updatedAt,
  };
}
