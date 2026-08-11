import type { RobotaxiState as RobotaxiStateName } from '@road/shared';

import type { RideAssignment } from './ride-assignment';
import { RobotaxiStateFactory } from './robotaxi-state.factory';
import type { RobotaxiContext, RobotaxiState } from './robotaxi-state';

/**
 * La vista di sola lettura di un veicolo: ciò che attraversa il confine del modulo.
 *
 * `getFleetStatus()` la usa per la panoramica in tempo reale dell'operatore (R7, G8) e
 * `getCandidates()` per l'insieme che `RideRequestManager` passerà ad `AllocationPort.allocate()`
 * (M3, M4). È una struttura di dati e non la classe `Robotaxi` perché chi la riceve non deve poter
 * chiamare una transizione: farlo su un oggetto staccato dal database cambierebbe una copia in
 * memoria e nient'altro, cioè il modo più silenzioso di introdurre un difetto.
 */
export interface RobotaxiSnapshot {
  readonly id: string;
  readonly state: RobotaxiStateName;
  readonly lat: number;
  readonly lon: number;
  readonly zoneId: string | null;
  readonly updatedAt: Date;
}

/**
 * Il **contesto** del pattern State (DD §2.3.2, Figura 2.3).
 *
 * `Robotaxi` non decide nulla: delega ognuna delle nove transizioni all'oggetto di stato corrente,
 * che la esegue o la rifiuta. È questo a rendere impossibile per costruzione una transizione
 * illegale, ed è il motivo per cui la macchina a stati **non** va scritta con degli `switch` sparsi
 * nei service (CLAUDE.md Regola 2).
 *
 * L'oggetto è di **memoria**: `FleetMonitor` lo costruisce da un record, gli chiede la transizione e
 * ne persiste il nuovo stato. Il legame fra veicolo e richiesta di corsa vive invece su
 * `ride_request.assignedRobotaxiId`, che secondo il DD §2.4, Figura 2.5 scrive
 * `PersistenceManager.reserve()`: qui `assignedRideRequestId` è la memoria di breve durata che
 * l'azione `storeRide()` richiede, non una seconda copia autorevole di quel legame.
 */
export class Robotaxi implements RobotaxiContext {
  private state: RobotaxiState;
  private rideRequestId: string | null;

  constructor(
    private readonly vehicle: RobotaxiSnapshot,
    assignedRideRequestId: string | null = null,
  ) {
    this.state = RobotaxiStateFactory.forState(vehicle.state);
    this.rideRequestId = assignedRideRequestId;
  }

  get id(): string {
    return this.vehicle.id;
  }

  /** Il nome dello stato corrente: è il valore che va nella colonna enum. */
  get currentState(): RobotaxiStateName {
    return this.state.name;
  }

  get assignedRideRequestId(): string | null {
    return this.rideRequestId;
  }

  // -------------------------------------------------------------------------------------------
  // Le nove transizioni della Figura 2.3, tutte delegate allo stato corrente
  // -------------------------------------------------------------------------------------------

  assignRide(request: RideAssignment): void {
    this.state.assignRide(this, request);
  }

  startPickupNavigation(): void {
    this.state.startPickupNavigation(this);
  }

  pickupReached(): void {
    this.state.pickupReached(this);
  }

  startRide(): void {
    this.state.startRide(this);
  }

  completeRide(): void {
    this.state.completeRide(this);
  }

  requestRebalancing(): void {
    this.state.requestRebalancing(this);
  }

  completeRebalancing(): void {
    this.state.completeRebalancing(this);
  }

  requestMaintenance(): void {
    this.state.requestMaintenance(this);
  }

  completeMaintenance(): void {
    this.state.completeMaintenance(this);
  }

  // -------------------------------------------------------------------------------------------
  // Ciò che le classi di stato possono fare al contesto
  // -------------------------------------------------------------------------------------------

  /** `setState()` della Figura 2.3. */
  setState(state: RobotaxiState): void {
    this.state = state;
  }

  transitionTo(name: RobotaxiStateName): void {
    this.setState(RobotaxiStateFactory.forState(name));
  }

  storeRide(rideRequestId: string): void {
    this.rideRequestId = rideRequestId;
  }

  releaseRide(): void {
    this.rideRequestId = null;
  }

  /** Il veicolo com'è adesso, pronto da persistere o da esporre. */
  toSnapshot(): RobotaxiSnapshot {
    return { ...this.vehicle, state: this.state.name };
  }
}
