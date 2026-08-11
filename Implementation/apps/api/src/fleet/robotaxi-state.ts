import type { RobotaxiState as RobotaxiStateName } from '@road/shared';

import type { RideAssignment } from './ride-assignment';
import { IllegalTransitionError, type RobotaxiTransition } from './robotaxi-transition';

/**
 * L'interfaccia `RobotaxiState` del DD §2.3.2, Figura 2.3 — il cuore del pattern State.
 *
 * `RobotaxiStateName` è l'alias locale dell'enum di `@road/shared`, che porta lo stesso nome: qui
 * `RobotaxiState` è la **classe** del pattern, là è il valore persistito nella colonna enum. Il DD
 * usa un solo nome per i due, e l'alias serve a non dovergliene imporre un secondo.
 */

/**
 * Ciò che una classe di stato può fare al veicolo su cui agisce.
 *
 * Le classi di stato ricevono il contesto e non la classe `Robotaxi` concreta per una ragione
 * meccanica: la macchina della Figura 2.10 ha dei cicli (`AVAILABLE → ASSIGNED → … → AVAILABLE`),
 * quindi se ogni stato costruisse direttamente il successivo il grafo dei file sarebbe circolare e
 * `pnpm arch` fallirebbe. Uno stato dichiara **dove** vuole andare — `transitionTo('ASSIGNED')` — e
 * il contesto istanzia la classe corrispondente tramite `RobotaxiStateFactory`. È la stessa
 * fabbrica che il DD §2.6.3 impone per ricostruire lo stato dalla colonna enum, usata qui per un
 * secondo scopo, e nessuno stato conosce gli altri.
 */
export interface RobotaxiContext {
  readonly id: string;

  /** Sostituisce lo stato corrente con quello indicato. */
  transitionTo(state: RobotaxiStateName): void;

  /** L'azione `storeRide()` delle transizioni 3 e 10: il veicolo ricorda la corsa accettata. */
  storeRide(rideRequestId: string): void;

  /** L'azione `releaseRobotaxi()` della transizione 7: il veicolo non ha più una corsa in carico. */
  releaseRide(): void;
}

/**
 * La classe base delle sette classi di stato.
 *
 * Dichiara tutte e nove le transizioni e le rifiuta tutte. Ogni stato concreto **ridefinisce solo
 * quelle che gli sono legali** secondo la Figura 2.10, e questo è ciò che rende il pattern leggibile
 * aprendo il codice: la lista dei metodi di `AvailableState` *è* l'insieme delle sue uscite. Tutto
 * il resto solleva `IllegalTransitionError`, quindi una transizione illegale è impossibile per
 * costruzione e non per controllo (NFR5).
 *
 * **Le guardie della Figura 2.10** (`[isAvailable()]`, `[hasAssignedRide()]`, …) non compaiono come
 * predicati separati perché in questo progetto sono soddisfatte per costruzione o dall'argomento:
 * `isAvailable()` è vero esattamente quando lo stato corrente è `AvailableState`,
 * `hasReceivedRideRequest()` esattamente quando un `RideAssignment` viene passato. Le guardie che
 * dipendono da un dato che il backend non possiede ancora — `hasReachedPickup()`,
 * `hasReachedDestination()`, `hasReachedTargetArea()` — riguardano la telemetria del veicolo, che
 * arriva con M7: sarà il simulatore, attraverso `ExternalServicesPort.readTelemetry()`, a decidere
 * *quando* chiamare la transizione. Lo stato decide *se* è ammessa, che è la responsabilità che il
 * pattern gli assegna.
 */
export abstract class RobotaxiState {
  /** Il valore che finisce nella colonna enum: è così che lo stato sopravvive a un riavvio. */
  abstract readonly name: RobotaxiStateName;

  assignRide(robotaxi: RobotaxiContext, _request: RideAssignment): void {
    this.reject(robotaxi, 'assignRide');
  }

  startPickupNavigation(robotaxi: RobotaxiContext): void {
    this.reject(robotaxi, 'startPickupNavigation');
  }

  pickupReached(robotaxi: RobotaxiContext): void {
    this.reject(robotaxi, 'pickupReached');
  }

  startRide(robotaxi: RobotaxiContext): void {
    this.reject(robotaxi, 'startRide');
  }

  completeRide(robotaxi: RobotaxiContext): void {
    this.reject(robotaxi, 'completeRide');
  }

  requestRebalancing(robotaxi: RobotaxiContext): void {
    this.reject(robotaxi, 'requestRebalancing');
  }

  completeRebalancing(robotaxi: RobotaxiContext): void {
    this.reject(robotaxi, 'completeRebalancing');
  }

  requestMaintenance(robotaxi: RobotaxiContext): void {
    this.reject(robotaxi, 'requestMaintenance');
  }

  completeMaintenance(robotaxi: RobotaxiContext): void {
    this.reject(robotaxi, 'completeMaintenance');
  }

  protected reject(robotaxi: RobotaxiContext, transition: RobotaxiTransition): never {
    throw new IllegalTransitionError(robotaxi.id, this.name, transition);
  }
}
