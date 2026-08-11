import { Injectable } from '@nestjs/common';

import { UnknownRobotaxiError } from '../fleet/fleet-monitor.port';
import {
  ConcurrentTransitionError,
  Robotaxi,
  robotaxiSnapshotOf,
  type RobotaxiSnapshot,
  type RobotaxiTransition,
} from '../fleet/robotaxi.port';
import {
  PersistencePort,
  StaleRecordError,
  type MaintenanceRecord,
  type PersistedRecord,
} from '../persistence/persistence.port';
import { ClockPort } from '../platform/clock.port';

import {
  MaintenancePort,
  type MaintenanceCompleted,
  type MaintenanceStarted,
} from './maintenance.port';

/**
 * Il `MaintenanceManager` (DD §2.2, R9).
 *
 * Come il `FleetMonitor`, non decide nulla sul ciclo di vita: costruisce il `Robotaxi` dal record e
 * gli chiede la transizione, che lo stato corrente ammette o rifiuta. È il motivo per cui «da
 * `REBALANCING` non si entra in manutenzione» non compare come controllo qui dentro — lo dice
 * `RebalancingState`, che non espone `requestMaintenance()`.
 *
 * **Le due scritture e il loro ordine.** `PersistencePort` non offre una transazione generica —
 * l'unica è `reserve()`, che esiste perché prenotazione e riserva devono nascere insieme (M4) —
 * quindi stato del veicolo e riga di storico si scrivono in due volte. Ciascuna sequenza mette per
 * prima la scrittura che, se l'altra non avvenisse, lascia il sistema dalla parte prudente:
 *
 * - fermando il veicolo si scrive **prima** lo stato: un'interruzione lascia un veicolo escluso
 *   dalle assegnazioni senza la sua riga di storico, mai un veicolo assegnabile che nessuno sa
 *   essere in officina. Il prezzo di questa scelta è che un guasto fra le due scritture lascia un
 *   veicolo fermo senza intervento aperto, e la porta non permette di aprirlo dopo: bisogna passare
 *   da `completeMaintenance()` e ricominciare;
 * - rimettendolo in servizio si chiude **prima** l'intervento: un'interruzione lascia un veicolo
 *   ancora fermo con lo storico già chiuso, mai il contrario.
 *
 * Lo stato del robotaxi resta in entrambi i casi l'unica sede autorevole di chi è assegnabile.
 */
@Injectable()
export class MaintenanceManager extends MaintenancePort {
  constructor(
    private readonly persistence: PersistencePort,
    private readonly clock: ClockPort,
  ) {
    super();
  }

  async requestMaintenance(robotaxiId: string, reason: string): Promise<MaintenanceStarted> {
    // Un solo istante per l'intera operazione: con `SystemClock` due letture dell'orologio
    // darebbero due valori, e lo stato del veicolo e l'apertura dell'intervento sembrerebbero
    // avvenuti in momenti diversi.
    const now = this.clock.now();
    const record = await this.load(robotaxiId);
    const robotaxi = new Robotaxi(robotaxiSnapshotOf(record));
    robotaxi.requestMaintenance();

    const stopped = await this.write(robotaxi, record, 'requestMaintenance', now);

    const opened = await this.persistence.create('maintenance_record', {
      robotaxiId,
      reason,
      status: 'ONGOING',
      startedAt: now,
      endedAt: null,
    });

    return { robotaxi: stopped, record: opened };
  }

  async completeMaintenance(robotaxiId: string): Promise<MaintenanceCompleted> {
    const now = this.clock.now();
    const record = await this.load(robotaxiId);
    const robotaxi = new Robotaxi(robotaxiSnapshotOf(record));
    robotaxi.completeMaintenance();

    const open = await this.openRecord(robotaxiId);
    const closed =
      open === undefined
        ? null
        : await this.persistence.update('maintenance_record', open.id, {
            status: 'COMPLETED',
            endedAt: now,
          });

    const resumed = await this.write(robotaxi, record, 'completeMaintenance', now);

    return { robotaxi: resumed, record: closed };
  }

  /** Il record del veicolo. `Robotaxi` nasce dalla colonna enum, mai da un valore deciso qui. */
  private async load(robotaxiId: string): Promise<PersistedRecord<'robotaxi'>> {
    const [record] = await this.persistence.find('robotaxi', {
      where: { id: robotaxiId },
      limit: 1,
    });
    if (record === undefined) throw new UnknownRobotaxiError(robotaxiId);
    return record;
  }

  /**
   * Persiste il nuovo stato **condizionando la scrittura su quello letto**.
   *
   * Senza la condizione, una richiesta di manutenzione e una `assign()` concorrenti leggerebbero
   * entrambe `AVAILABLE` e scriverebbero entrambe: si otterrebbe un veicolo `ASSIGNED` con un
   * intervento aperto, cioè un veicolo assegnato a un passeggero mentre è in officina — la
   * violazione letterale di R9.
   */
  private async write(
    robotaxi: Robotaxi,
    read: PersistedRecord<'robotaxi'>,
    transition: RobotaxiTransition,
    now: Date,
  ): Promise<RobotaxiSnapshot> {
    try {
      const updated = await this.persistence.update(
        'robotaxi',
        read.id,
        { state: robotaxi.currentState, updatedAt: now },
        { state: read.state },
      );
      return robotaxiSnapshotOf(updated);
    } catch (error) {
      if (error instanceof StaleRecordError) {
        throw new ConcurrentTransitionError(read.id, read.state, transition);
      }
      throw error;
    }
  }

  /**
   * L'intervento aperto del veicolo, se c'è.
   *
   * Il più recente, non "uno qualsiasi": lo schema non impedisce due righe aperte sullo stesso
   * veicolo — solo lo stato lo impedisce, e solo finché nessuno scrive la tabella a mano — e senza
   * un ordinamento totale l'esito dipenderebbe da come il database restituisce le righe.
   */
  private async openRecord(robotaxiId: string): Promise<MaintenanceRecord | undefined> {
    const [open] = await this.persistence.find('maintenance_record', {
      where: { robotaxiId, endedAt: null },
      orderBy: [
        { field: 'startedAt', direction: 'desc' },
        { field: 'id', direction: 'desc' },
      ],
      limit: 1,
    });
    return open;
  }
}
