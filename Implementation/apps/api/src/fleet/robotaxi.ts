import type { RobotaxiState as RobotaxiStateName } from '@road/shared';

import type { DomainEvent, Observer, Subject } from '../notifications/notification.port';
import type { PersistedRecord } from '../persistence/persistence.port';

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
 * `Robotaxi` non decide nulla: delega ognuna delle dieci transizioni all'oggetto di stato corrente,
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
export class Robotaxi implements RobotaxiContext, Subject {
  private state: RobotaxiState;
  private rideRequestId: string | null;

  /**
   * Gli observer registrati su questo veicolo (DD §2.3.3, Figura 2.4).
   *
   * La lista vive quanto **l'operazione**, non quanto il veicolo: l'oggetto viene ricostruito dal
   * record a ogni lettura, quindi non può portarsi dietro subscriber durevoli. In pratica contiene
   * sempre un solo elemento, il `NotificationManager`, che `FleetMonitor` ci registra appena
   * costruito il veicolo. Non è una scorciatoia: è la conseguenza diretta del fatto che lo stato si
   * persiste come colonna enum e l'oggetto si ricostruisce via `RobotaxiStateFactory` (§2.6.3).
   */
  private readonly observers: Observer[] = [];

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
  // Le dieci transizioni della Figura 2.3, tutte delegate allo stato corrente
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

  cancelRide(): void {
    this.state.cancelRide(this);
  }

  // -------------------------------------------------------------------------------------------
  // `Subject` (DD §2.3.3, Figura 2.4)
  // -------------------------------------------------------------------------------------------

  registerObserver(observer: Observer): void {
    if (!this.observers.includes(observer)) this.observers.push(observer);
  }

  removeObserver(observer: Observer): void {
    const at = this.observers.indexOf(observer);
    if (at !== -1) this.observers.splice(at, 1);
  }

  /**
   * Notifica gli observer registrati.
   *
   * **Chi la chiama non è la classe di stato, è `FleetMonitor`, e solo dopo che la transizione è
   * stata scritta.** L'azione `notifyPassenger()` della Figura 2.10 si realizza così, e l'ordine è
   * la parte che conta: una transizione può essere legale al momento della lettura e non esserlo
   * più al momento della scrittura — è il caso che `ConcurrentTransitionError` descrive — e
   * notificare da dentro la classe di stato manderebbe al passeggero l'annuncio di un'assegnazione
   * che il database ha poi rifiutato. Si notifica ciò che è successo davvero, non ciò che si stava
   * per fare.
   */
  async notifyObservers(event: DomainEvent): Promise<void> {
    for (const observer of this.observers) await observer.update(event);
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

/**
 * Dal record persistito alla vista pubblica del veicolo.
 *
 * `RobotaxiRecord` e `RobotaxiSnapshot` hanno oggi gli stessi campi e restano due tipi: il primo è
 * la forma della riga, il secondo il vocabolario del modulo `fleet`. Fonderli legherebbe la porta
 * allo schema, e cambiare una colonna diventerebbe un cambiamento di contratto.
 *
 * La conversione elenca i campi uno per uno e non è uno spread. Uno spread compilerebbe lo stesso —
 * un oggetto più largo è assegnabile a uno più stretto quando non è un letterale — e il giorno in
 * cui la riga prendesse una colonna in più se la porterebbe fuori dalla porta senza che nulla
 * protesti. Così invece la colonna nuova resta dentro il modulo, che è dove deve stare.
 */
export function robotaxiSnapshotOf(record: PersistedRecord<'robotaxi'>): RobotaxiSnapshot {
  return {
    id: record.id,
    state: record.state,
    lat: record.lat,
    lon: record.lon,
    zoneId: record.zoneId,
    updatedAt: record.updatedAt,
  };
}
