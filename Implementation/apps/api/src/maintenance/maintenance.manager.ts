import { Injectable } from '@nestjs/common';

import { Robotaxi, UnknownRobotaxiError } from '../fleet/fleet-monitor.port';
import { PersistencePort, type MaintenanceRecord } from '../persistence/persistence.port';
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
 * **L'ordine delle due scritture non è casuale.** `PersistencePort` non offre una transazione
 * generica — l'unica è `reserve()`, che esiste perché prenotazione e riserva devono nascere insieme
 * (M4) — quindi stato del veicolo e riga di storico si scrivono in due volte. Ciascuna sequenza
 * mette per prima la scrittura che, se l'altra non avvenisse, lascia il sistema dalla parte
 * prudente:
 *
 * - fermando il veicolo si scrive **prima** lo stato: un'interruzione lascia un veicolo escluso
 *   dalle assegnazioni senza la sua riga di storico, mai un veicolo assegnabile che nessuno sa
 *   essere in officina;
 * - rimettendolo in servizio si chiude **prima** l'intervento: un'interruzione lascia un veicolo
 *   ancora fermo con lo storico già chiuso, mai il contrario.
 *
 * Lo stato del robotaxi resta in entrambi i casi l'unica sede autorevole di chi è assegnabile,
 * coerentemente con quanto la porta dichiara.
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
    const robotaxi = await this.load(robotaxiId);
    robotaxi.requestMaintenance();

    const stopped = await this.persistence.update('robotaxi', robotaxiId, {
      state: robotaxi.currentState,
      updatedAt: this.clock.now(),
    });

    const record = await this.persistence.create('maintenance_record', {
      robotaxiId,
      reason,
      status: 'ONGOING',
      startedAt: this.clock.now(),
      endedAt: null,
    });

    return { robotaxi: { ...stopped }, record };
  }

  async completeMaintenance(robotaxiId: string): Promise<MaintenanceCompleted> {
    const robotaxi = await this.load(robotaxiId);
    robotaxi.completeMaintenance();

    const open = await this.openRecord(robotaxiId);
    const record =
      open === undefined
        ? null
        : await this.persistence.update('maintenance_record', open.id, {
            status: 'COMPLETED',
            endedAt: this.clock.now(),
          });

    const resumed = await this.persistence.update('robotaxi', robotaxiId, {
      state: robotaxi.currentState,
      updatedAt: this.clock.now(),
    });

    return { robotaxi: { ...resumed }, record };
  }

  /** Il veicolo, ricostruito con il proprio stato: il `Robotaxi` nasce dalla colonna enum. */
  private async load(robotaxiId: string): Promise<Robotaxi> {
    const [record] = await this.persistence.find('robotaxi', {
      where: { id: robotaxiId },
      limit: 1,
    });
    if (record === undefined) throw new UnknownRobotaxiError(robotaxiId);
    return new Robotaxi(record);
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
