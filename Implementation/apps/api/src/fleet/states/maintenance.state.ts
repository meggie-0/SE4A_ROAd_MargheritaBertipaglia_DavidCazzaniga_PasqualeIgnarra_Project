import type { RobotaxiState as RobotaxiStateName } from '@road/shared';

import { RobotaxiState, type RobotaxiContext } from '../robotaxi-state';

/**
 * `MAINTENANCE` — il veicolo è fuori servizio per un intervento (R9).
 *
 * Una sola uscita, transizione 2 della Figura 2.10. Finché è qui il veicolo non compare fra i
 * candidati di `FleetMonitorPort.getCandidates()`, ed è lo **stato** a escluderlo: non una
 * interrogazione sulla tabella `maintenance_record`, che serve allo storico.
 */
export class MaintenanceState extends RobotaxiState {
  readonly name: RobotaxiStateName = 'MAINTENANCE';

  /** Transizione 2: `completeMaintenance() [isOperational()] / enableAssignment()`. */
  override completeMaintenance(robotaxi: RobotaxiContext): void {
    robotaxi.transitionTo('AVAILABLE');
  }
}
