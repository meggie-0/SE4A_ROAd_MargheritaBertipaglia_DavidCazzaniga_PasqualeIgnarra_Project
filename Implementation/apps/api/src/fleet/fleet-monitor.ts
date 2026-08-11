import { Injectable } from '@nestjs/common';
import { ROBOTAXI_STATES, type RobotaxiState as RobotaxiStateName } from '@road/shared';

import { PersistencePort, StaleRecordError } from '../persistence/persistence.port';
import { ClockPort } from '../platform/clock.port';

import { FleetMonitorPort, UnknownRobotaxiError, type FleetStatus } from './fleet-monitor.port';
import type { RideAssignment } from './ride-assignment';
import { Robotaxi, robotaxiSnapshotOf, type RobotaxiSnapshot } from './robotaxi';
import { ALLOCATABLE_STATES, BOOKABLE_STATES } from './robotaxi.port';
import { ConcurrentTransitionError, type RobotaxiTransition } from './robotaxi-transition';

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

  async getCandidates(): Promise<RobotaxiSnapshot[]> {
    const allocatable = await this.persistence.find('robotaxi', {
      where: { state: { oneOf: ALLOCATABLE_STATES } },
      orderBy: [{ field: 'id' }],
    });
    return allocatable.map(robotaxiSnapshotOf);
  }

  async getBookableRobotaxis(): Promise<RobotaxiSnapshot[]> {
    const bookable = await this.persistence.find('robotaxi', {
      where: { state: { oneOf: BOOKABLE_STATES } },
      orderBy: [{ field: 'id' }],
    });
    return bookable.map(robotaxiSnapshotOf);
  }

  async getAvailableRobotaxis(): Promise<RobotaxiSnapshot[]> {
    const idle = await this.persistence.find('robotaxi', {
      where: { state: 'AVAILABLE' },
      orderBy: [{ field: 'id' }],
    });
    return idle.map(robotaxiSnapshotOf);
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
      robotaxis: fleet.map(robotaxiSnapshotOf),
    };
  }

  async assign(robotaxiId: string, request: RideAssignment): Promise<RobotaxiSnapshot> {
    return this.applyTransition(robotaxiId, 'assignRide', (robotaxi) =>
      robotaxi.assignRide(request),
    );
  }

  async releaseAssignment(robotaxiId: string): Promise<RobotaxiSnapshot> {
    return this.applyTransition(robotaxiId, 'cancelRide', (robotaxi) => robotaxi.cancelRide());
  }

  async requestRebalancing(robotaxiId: string): Promise<RobotaxiSnapshot> {
    return this.applyTransition(robotaxiId, 'requestRebalancing', (robotaxi) =>
      robotaxi.requestRebalancing(),
    );
  }

  /**
   * Legge, transisce, scrive — **condizionando la scrittura sullo stato letto**.
   *
   * Due proprietà, e la seconda è quella che si dimentica:
   *
   * - se lo stato corrente non ammette la transizione, `IllegalTransitionError` esce prima di
   *   qualunque scrittura e il database non è stato toccato (NFR5);
   * - se lo ammette ma un altro scrittore ha cambiato la riga nel frattempo, la scrittura non
   *   avviene, perché la `UPDATE` porta con sé lo stato di partenza. Senza quella condizione due
   *   `assign()` concorrenti riuscirebbero entrambe, e un `assign()` in corsa con una richiesta di
   *   manutenzione potrebbe assegnare un veicolo che sta andando in officina — cioè proprio ciò
   *   che R9 vieta.
   */
  private async applyTransition(
    robotaxiId: string,
    transition: RobotaxiTransition,
    apply: (robotaxi: Robotaxi) => void,
  ): Promise<RobotaxiSnapshot> {
    const [record] = await this.persistence.find('robotaxi', {
      where: { id: robotaxiId },
      limit: 1,
    });
    if (record === undefined) throw new UnknownRobotaxiError(robotaxiId);

    const robotaxi = new Robotaxi(robotaxiSnapshotOf(record));
    apply(robotaxi);

    try {
      const updated = await this.persistence.update(
        'robotaxi',
        robotaxiId,
        { state: robotaxi.currentState, updatedAt: this.clock.now() },
        { state: record.state },
      );
      return robotaxiSnapshotOf(updated);
    } catch (error) {
      if (error instanceof StaleRecordError) {
        throw new ConcurrentTransitionError(robotaxiId, record.state, transition);
      }
      throw error;
    }
  }
}
