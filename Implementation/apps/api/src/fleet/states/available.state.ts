import type { RobotaxiState as RobotaxiStateName } from '@road/shared';

import type { RideAssignment } from '../ride-assignment';
import { RobotaxiState, type RobotaxiContext } from '../robotaxi-state';

/**
 * `AVAILABLE` — il veicolo è libero e assegnabile.
 *
 * Tre uscite, transizioni 3, 8 e 1 della Figura 2.10. È l'**unico** stato da cui si entra in
 * manutenzione: un veicolo che si sta riposizionando ci passa prima da qui (DD §2.6.3).
 */
export class AvailableState extends RobotaxiState {
  readonly name: RobotaxiStateName = 'AVAILABLE';

  /** Transizione 3: `assignRide(request) [isAvailable()] / storeRide()`. */
  override assignRide(robotaxi: RobotaxiContext, request: RideAssignment): void {
    robotaxi.storeRide(request.rideRequestId);
    robotaxi.transitionTo('ASSIGNED');
  }

  /** Transizione 8: `requestRebalancing() [hasNoActiveRide()] / computeTargetArea()`. */
  override requestRebalancing(robotaxi: RobotaxiContext): void {
    robotaxi.transitionTo('REBALANCING');
  }

  /** Transizione 1: `requestMaintenance() [requiresMaintenance()] / disableAssignment()`. */
  override requestMaintenance(robotaxi: RobotaxiContext): void {
    robotaxi.transitionTo('MAINTENANCE');
  }
}
