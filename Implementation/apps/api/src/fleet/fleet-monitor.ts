import { Injectable } from '@nestjs/common';
import { ROBOTAXI_STATES, type RobotaxiState as RobotaxiStateName } from '@road/shared';

import { NotificationPort } from '../notifications/notification.port';
import {
  PersistencePort,
  RecordNotFoundError,
  StaleRecordError,
} from '../persistence/persistence.port';
import { ClockPort } from '../platform/clock.port';

import {
  FleetMonitorPort,
  UnknownRobotaxiError,
  type FleetStatus,
  type ObservedPosition,
} from './fleet-monitor.port';
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
    /**
     * L'unico observer registrato su ogni `Robotaxi` che questo componente costruisce (DD §2.3.3).
     *
     * `fleet` dipende da `notifications` e non viceversa: il soggetto conosce l'observer, l'observer
     * non conosce i soggetti. È ciò che permette di riscrivere il canale di notifica senza toccare
     * la macchina a stati, e di provare la macchina a stati senza alzare una socket.
     */
    private readonly notifications: NotificationPort,
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
    return this.applyTransition(
      robotaxiId,
      'assignRide',
      (robotaxi) => robotaxi.assignRide(request),
      // La corsa la sappiamo già: è l'argomento. Cercarla in tabella sarebbe una lettura per
      // scoprire ciò che il chiamante ci ha appena detto.
      request.rideRequestId,
    );
  }

  async startPickupNavigation(robotaxiId: string): Promise<RobotaxiSnapshot> {
    return this.applyTransition(robotaxiId, 'startPickupNavigation', (robotaxi) =>
      robotaxi.startPickupNavigation(),
    );
  }

  async pickupReached(robotaxiId: string): Promise<RobotaxiSnapshot> {
    return this.applyTransition(robotaxiId, 'pickupReached', (robotaxi) =>
      robotaxi.pickupReached(),
    );
  }

  async startRide(robotaxiId: string): Promise<RobotaxiSnapshot> {
    return this.applyTransition(robotaxiId, 'startRide', (robotaxi) => robotaxi.startRide());
  }

  async completeRide(robotaxiId: string): Promise<RobotaxiSnapshot> {
    return this.applyTransition(robotaxiId, 'completeRide', (robotaxi) => robotaxi.completeRide());
  }

  async releaseAssignment(robotaxiId: string): Promise<RobotaxiSnapshot> {
    return this.applyTransition(robotaxiId, 'cancelRide', (robotaxi) => robotaxi.cancelRide());
  }

  async requestRebalancing(robotaxiId: string): Promise<RobotaxiSnapshot> {
    return this.applyTransition(robotaxiId, 'requestRebalancing', (robotaxi) =>
      robotaxi.requestRebalancing(),
    );
  }

  async completeRebalancing(robotaxiId: string): Promise<RobotaxiSnapshot> {
    return this.applyTransition(robotaxiId, 'completeRebalancing', (robotaxi) =>
      robotaxi.completeRebalancing(),
    );
  }

  /**
   * Registra le posizioni osservate: una `UPDATE` per veicolo, nessuna transizione.
   *
   * Non passa da `applyTransition()` e non deve: quel metodo legge lo stato, costruisce il
   * `Robotaxi`, gli chiede un passo della macchina e notifica. Qui non c'è nessun passo — la
   * colonna di stato non viene nemmeno letta, e scriverne una copia identica sarebbe un modo di
   * perdere una transizione concorrente per niente.
   *
   * Un veicolo che il sistema non conosce viene saltato invece di far fallire il ciclo: la
   * telemetria arriva da fuori, e ciò che sta fuori può parlare di veicoli che non sono in flotta.
   */
  async recordPositions(positions: readonly ObservedPosition[]): Promise<number> {
    let updated = 0;

    for (const position of positions) {
      try {
        await this.persistence.update('robotaxi', position.robotaxiId, {
          lat: position.lat,
          lon: position.lon,
          updatedAt: position.observedAt,
        });
        updated += 1;
      } catch (error) {
        if (error instanceof RecordNotFoundError) continue;
        throw error;
      }
    }

    return updated;
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
    knownRideRequestId?: string,
  ): Promise<RobotaxiSnapshot> {
    const [record] = await this.persistence.find('robotaxi', {
      where: { id: robotaxiId },
      limit: 1,
    });
    if (record === undefined) throw new UnknownRobotaxiError(robotaxiId);

    // La corsa in carico si legge **prima** della transizione: `completeRide()` e `cancelRide()`
    // chiamano `releaseRide()`, e dopo di quelle il veicolo non saprebbe più dire a chi la notifica
    // andava consegnata — cioè proprio i due eventi che chiudono la corsa non arriverebbero.
    const rideRequestId = knownRideRequestId ?? (await this.activeRideRequestOf(robotaxiId));

    const robotaxi = new Robotaxi(robotaxiSnapshotOf(record), rideRequestId ?? null);
    // L'unico observer, registrato dal modulo che possiede il soggetto (DD §2.3.3).
    robotaxi.registerObserver(this.notifications);
    apply(robotaxi);

    const observedAt = this.clock.now();
    let updated;
    try {
      updated = await this.persistence.update(
        'robotaxi',
        robotaxiId,
        { state: robotaxi.currentState, updatedAt: observedAt },
        { state: record.state },
      );
    } catch (error) {
      if (error instanceof StaleRecordError) {
        throw new ConcurrentTransitionError(robotaxiId, record.state, transition);
      }
      throw error;
    }

    // **Dopo** la scrittura, e solo se è riuscita: si notifica ciò che è accaduto (R6, G7).
    await robotaxi.notifyObservers({
      kind: 'ROBOTAXI_STATE_CHANGED',
      occurredAt: observedAt,
      robotaxiId,
      from: record.state,
      to: updated.state,
      rideRequestId: rideRequestId ?? null,
    });

    return robotaxiSnapshotOf(updated);
  }

  /**
   * La richiesta di corsa che questo veicolo sta servendo, se ce n'è una.
   *
   * È l'azione `storeRide()` della Figura 2.10 ricostruita dalla sorgente autorevole invece che
   * ricordata: il legame vive su `ride_request.assignedRobotaxiId`, che `PersistenceManager.reserve()`
   * scrive nella stessa transazione della riserva (decisione D35). Una richiesta annullata o
   * rifiutata azzera quella colonna, quindi un veicolo ha al più una richiesta `ACCEPTED` addosso.
   *
   * Serve solo a instradare la notifica: senza, il manager saprebbe che un veicolo si è mosso ma non
   * a quale passeggero la cosa interessa.
   */
  private async activeRideRequestOf(robotaxiId: string): Promise<string | undefined> {
    const [request] = await this.persistence.find('ride_request', {
      where: { assignedRobotaxiId: robotaxiId, status: 'ACCEPTED' },
      orderBy: [{ field: 'createdAt', direction: 'desc' }, { field: 'id' }],
      limit: 1,
    });
    return request?.id;
  }
}
