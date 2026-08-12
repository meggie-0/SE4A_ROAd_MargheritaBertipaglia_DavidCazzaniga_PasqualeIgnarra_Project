import type { RobotaxiState as RobotaxiStateName } from '@road/shared';

import { RobotaxiState, type RobotaxiContext } from '../robotaxi-state';

/**
 * `ARRIVING` — il veicolo sta navigando verso il punto di ritiro.
 *
 * Due uscite: la transizione 5 della Figura 2.10 e la **12 [v1.5]**, che è la seconda metà di R14.
 *
 * L'annullamento da qui non esisteva fino a M6, e la ragione era scritta nel DD §2.6.3 (decisione
 * D27): un veicolo già in movimento verso il punto di ritiro non può essere dichiarato disponibile
 * mentre è ancora in strada per qualcuno, perché fermarlo richiede di **revocargli la rotta** —
 * `commandRoute()`, un comando alla flotta e non una transizione del ciclo di vita. Con M7 quel
 * comando esiste, quindi la ragione del divieto è venuta meno e la riga entra nella tabella: R14
 * chiede di poter annullare «before the ride begins», e la corsa comincia quando il passeggero
 * sale, non quando il veicolo parte.
 *
 * Chi ordina l'annullamento revoca la rotta **prima** di chiamare questa transizione. La classe di
 * stato non lo fa e non deve: qui si decide *se* il passo è ammesso, non lo si esegue nel mondo.
 */
export class ArrivingState extends RobotaxiState {
  readonly name: RobotaxiStateName = 'ARRIVING';

  /** Transizione 5: `pickupReached() [hasReachedPickup()] / notifyPassenger()`. */
  override pickupReached(robotaxi: RobotaxiContext): void {
    robotaxi.transitionTo('ARRIVED');
  }

  /** Transizione 12 **[v1.5]**: `cancelRide() [hasAssignedRide()] / releaseRobotaxi()`. */
  override cancelRide(robotaxi: RobotaxiContext): void {
    robotaxi.releaseRide();
    robotaxi.transitionTo('AVAILABLE');
  }
}
