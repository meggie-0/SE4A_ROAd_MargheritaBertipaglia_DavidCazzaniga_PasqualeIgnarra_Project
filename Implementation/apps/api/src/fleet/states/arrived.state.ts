import type { RobotaxiState as RobotaxiStateName } from '@road/shared';

import { RobotaxiState, type RobotaxiContext } from '../robotaxi-state';

/**
 * `ARRIVED` — il veicolo è al punto di ritiro e attende il passeggero.
 *
 * Una sola uscita, transizione 6 della Figura 2.10.
 */
export class ArrivedState extends RobotaxiState {
  readonly name: RobotaxiStateName = 'ARRIVED';

  /** Transizione 6: `startRide() [isPassengerOnBoard()] / beginTrip()`. */
  override startRide(robotaxi: RobotaxiContext): void {
    robotaxi.transitionTo('IN_RIDE');
  }
}
