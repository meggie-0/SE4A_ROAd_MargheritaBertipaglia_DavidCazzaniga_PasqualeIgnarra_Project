import type { RobotaxiState as RobotaxiStateName } from '@road/shared';

import { RobotaxiState, type RobotaxiContext } from '../robotaxi-state';

/**
 * `ASSIGNED` — il veicolo ha una corsa in carico ma non si è ancora mosso verso il punto di ritiro.
 *
 * Una sola uscita, transizione 4 della Figura 2.10.
 */
export class AssignedState extends RobotaxiState {
  readonly name: RobotaxiStateName = 'ASSIGNED';

  /** Transizione 4: `startPickupNavigation() [hasAssignedRide()] / updateStatus()`. */
  override startPickupNavigation(robotaxi: RobotaxiContext): void {
    robotaxi.transitionTo('ARRIVING');
  }
}
