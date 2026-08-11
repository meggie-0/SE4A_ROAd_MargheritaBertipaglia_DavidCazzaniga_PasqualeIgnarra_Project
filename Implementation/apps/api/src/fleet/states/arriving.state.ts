import type { RobotaxiState as RobotaxiStateName } from '@road/shared';

import { RobotaxiState, type RobotaxiContext } from '../robotaxi-state';

/**
 * `ARRIVING` — il veicolo sta navigando verso il punto di ritiro.
 *
 * Una sola uscita, transizione 5 della Figura 2.10.
 */
export class ArrivingState extends RobotaxiState {
  readonly name: RobotaxiStateName = 'ARRIVING';

  /** Transizione 5: `pickupReached() [hasReachedPickup()] / notifyPassenger()`. */
  override pickupReached(robotaxi: RobotaxiContext): void {
    robotaxi.transitionTo('ARRIVED');
  }
}
