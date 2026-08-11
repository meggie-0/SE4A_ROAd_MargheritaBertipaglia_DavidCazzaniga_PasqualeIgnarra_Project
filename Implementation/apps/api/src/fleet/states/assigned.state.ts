import type { RobotaxiState as RobotaxiStateName } from '@road/shared';

import { RobotaxiState, type RobotaxiContext } from '../robotaxi-state';

/**
 * `ASSIGNED` — il veicolo ha una corsa in carico ma non si è ancora mosso verso il punto di ritiro.
 *
 * Due uscite: la transizione 4 della Figura 2.10, e la **11 [v1.2]**, che è ciò che rende R14
 * realizzabile.
 *
 * L'annullamento è ammesso **solo da qui**, e non è una restrizione arbitraria: R14 parla di
 * annullare «before the ride begins», ma un veicolo che si è già mosso verso il punto di ritiro
 * (`ARRIVING`, `ARRIVED`) sta eseguendo una manovra fisica, e riportarlo ad `AVAILABLE` da una
 * classe di stato significherebbe dichiararlo libero mentre è ancora in strada per qualcun altro.
 * Fermare un veicolo in movimento è un comando alla flotta — `commandRoute()`, M7 — non una
 * transizione del ciclo di vita. Finché quel comando non esiste, l'annullamento si ferma dove il
 * veicolo è ancora fermo.
 */
export class AssignedState extends RobotaxiState {
  readonly name: RobotaxiStateName = 'ASSIGNED';

  /** Transizione 4: `startPickupNavigation() [hasAssignedRide()] / updateStatus()`. */
  override startPickupNavigation(robotaxi: RobotaxiContext): void {
    robotaxi.transitionTo('ARRIVING');
  }

  /**
   * Transizione 11 **[v1.2]**: `cancelRide() [hasAssignedRide()] / releaseRobotaxi()`.
   *
   * L'azione è la stessa della transizione 7 — il veicolo lascia andare la corsa che aveva in
   * carico e torna disponibile — e per questo porta lo stesso nome nella tabella del DD: ciò che
   * cambia è chi la origina, il passeggero invece dell'arrivo a destinazione.
   */
  override cancelRide(robotaxi: RobotaxiContext): void {
    robotaxi.releaseRide();
    robotaxi.transitionTo('AVAILABLE');
  }
}
