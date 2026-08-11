import type { RobotaxiState as RobotaxiStateName } from '@road/shared';

import { RobotaxiState, type RobotaxiContext } from '../robotaxi-state';

/**
 * `IN_RIDE` — il passeggero è a bordo e la corsa è in corso.
 *
 * Una sola uscita, transizione 7 della Figura 2.10.
 */
export class InRideState extends RobotaxiState {
  readonly name: RobotaxiStateName = 'IN_RIDE';

  /** Transizione 7: `completeRide() [hasReachedDestination()] / releaseRobotaxi()`. */
  override completeRide(robotaxi: RobotaxiContext): void {
    robotaxi.releaseRide();
    robotaxi.transitionTo('AVAILABLE');
  }
}
