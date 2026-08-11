import type { RobotaxiState as RobotaxiStateName } from '@road/shared';

import type { RideAssignment } from '../ride-assignment';
import { RobotaxiState, type RobotaxiContext } from '../robotaxi-state';

/**
 * `REBALANCING` — il veicolo si sta riposizionando verso una zona di domanda prevista.
 *
 * È lo stato aggiunto dal DD §2.6.3 rispetto alla macchina a sei stati del RASD §3.2, e i due punti
 * che un'implementazione sbaglia più facilmente stanno entrambi qui:
 *
 * - il veicolo **è ancora allocabile**. La transizione 10 interrompe il riposizionamento e assegna
 *   la corsa: è esattamente ciò che rende utile spostare i veicoli inattivi verso la domanda
 *   prevista (R11, G9). Trattarlo come non disponibile svuoterebbe la funzione;
 * - il veicolo **non può entrare in manutenzione da qui**. Questa classe espone soltanto
 *   `assignRide()` e `completeRebalancing()`; la manutenzione si chiede una volta tornati ad
 *   `AVAILABLE`.
 */
export class RebalancingState extends RobotaxiState {
  readonly name: RobotaxiStateName = 'REBALANCING';

  /** Transizione 10: `assignRide(request) [hasReceivedRideRequest()] / interruptRebalancing()`. */
  override assignRide(robotaxi: RobotaxiContext, request: RideAssignment): void {
    robotaxi.storeRide(request.rideRequestId);
    robotaxi.transitionTo('ASSIGNED');
  }

  /** Transizione 9: `completeRebalancing() [hasReachedTargetArea()] / setAvailable()`. */
  override completeRebalancing(robotaxi: RobotaxiContext): void {
    robotaxi.transitionTo('AVAILABLE');
  }
}
