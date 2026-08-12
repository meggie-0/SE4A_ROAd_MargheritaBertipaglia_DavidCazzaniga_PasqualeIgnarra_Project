import type { RobotaxiState as RobotaxiStateName } from '@road/shared';

import { RobotaxiState, type RobotaxiContext } from '../robotaxi-state';

/**
 * `ARRIVED` — il veicolo è al punto di ritiro e attende il passeggero.
 *
 * Due uscite: la transizione 6 della Figura 2.10 e la **13 [v1.5]**, gemella della 12.
 *
 * È lo stato in cui l'annullamento è più naturale e insieme quello in cui fino a M6 era vietato: il
 * passeggero che non si presenta è il caso ordinario, non l'eccezione. La riga entra con M7 per la
 * stessa ragione della 12 — `commandRoute()` esiste, quindi la rotta si può revocare — e il confine
 * di R14 si sposta esattamente di un passo: si annulla finché il passeggero **non è a bordo**, e da
 * `IN_RIDE` in poi non più, perché lì la corsa è cominciata davvero (RASD §1.2.2, «Ride starts when
 * the passenger boards»).
 */
export class ArrivedState extends RobotaxiState {
  readonly name: RobotaxiStateName = 'ARRIVED';

  /** Transizione 6: `startRide() [isPassengerOnBoard()] / beginTrip()`. */
  override startRide(robotaxi: RobotaxiContext): void {
    robotaxi.transitionTo('IN_RIDE');
  }

  /** Transizione 13 **[v1.5]**: `cancelRide() [hasAssignedRide()] / releaseRobotaxi()`. */
  override cancelRide(robotaxi: RobotaxiContext): void {
    robotaxi.releaseRide();
    robotaxi.transitionTo('AVAILABLE');
  }
}
