import type { RobotaxiSnapshot } from '../fleet/fleet-monitor.port';
import type { MaintenanceRecord } from '../persistence/persistence.port';

/**
 * La porta del `MaintenanceManager` (DD §2.2, R9).
 *
 * Due operazioni: mettere un veicolo fuori servizio e rimettercelo. L'esclusione dalle assegnazioni
 * non è un'operazione a sé e non è un controllo sparso nei chiamanti — è una **conseguenza dello
 * stato**: un veicolo in `MAINTENANCE` non è in `ALLOCATABLE_STATES`, quindi
 * `FleetMonitorPort.getCandidates()` non lo restituisce. La tabella `maintenance_record` serve allo
 * storico e alla dashboard, non a decidere chi è assegnabile.
 */

/** L'esito di `requestMaintenance`: il veicolo fermato e il periodo di intervento aperto. */
export interface MaintenanceStarted {
  readonly robotaxi: RobotaxiSnapshot;
  readonly record: MaintenanceRecord;
}

/**
 * L'esito di `completeMaintenance`: il veicolo rimesso in servizio e il periodo chiuso.
 *
 * `record` è `null` nell'unico caso in cui il veicolo era in `MAINTENANCE` senza un intervento
 * aperto — per esempio perché ce l'ha messo il seed. Rifiutarsi di rimetterlo in servizio per una
 * riga di storico mancante bloccherebbe un veicolo sano, quindi la transizione avviene comunque e
 * l'assenza si legge nell'esito.
 */
export interface MaintenanceCompleted {
  readonly robotaxi: RobotaxiSnapshot;
  readonly record: MaintenanceRecord | null;
}

export abstract class MaintenancePort {
  /**
   * Ferma il veicolo per manutenzione e apre il periodo di indisponibilità (transizione 1 della
   * Figura 2.10).
   *
   * Solleva `IllegalTransitionError` se il veicolo non è `AVAILABLE`. In particolare **non** si
   * entra in manutenzione da `REBALANCING`: il DD §2.6.3 lo dice esplicitamente, e il veicolo ci
   * passa da `AVAILABLE` dopo `completeRebalancing()`.
   */
  abstract requestMaintenance(robotaxiId: string, reason: string): Promise<MaintenanceStarted>;

  /**
   * Chiude l'intervento e rimette il veicolo fra i disponibili (transizione 2).
   *
   * Solleva `IllegalTransitionError` se il veicolo non è in `MAINTENANCE`.
   */
  abstract completeMaintenance(robotaxiId: string): Promise<MaintenanceCompleted>;
}
