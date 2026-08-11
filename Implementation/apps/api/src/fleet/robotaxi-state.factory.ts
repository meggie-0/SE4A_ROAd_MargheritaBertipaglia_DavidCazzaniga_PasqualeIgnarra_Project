import type { RobotaxiState as RobotaxiStateName } from '@road/shared';

import type { RobotaxiState } from './robotaxi-state';
import { ArrivedState } from './states/arrived.state';
import { ArrivingState } from './states/arriving.state';
import { AssignedState } from './states/assigned.state';
import { AvailableState } from './states/available.state';
import { InRideState } from './states/in-ride.state';
import { MaintenanceState } from './states/maintenance.state';
import { RebalancingState } from './states/rebalancing.state';

/**
 * Ricostruisce l'oggetto di stato a partire dal valore della colonna enum (DD §2.6.3 **[v1.1]**).
 *
 * È il pezzo che rende il pattern State compatibile con un tier applicativo replicabile: il
 * comportamento vive nelle sette classi, il database memorizza **solo quale classe istanziare**, e
 * due repliche che leggono la stessa riga ottengono lo stesso comportamento. Per la stessa ragione
 * gli oggetti di stato non tengono nulla di durevole — nessuna lista di observer, nessun dato del
 * veicolo — e sono quindi ricostruibili a ogni lettura senza perdere niente.
 *
 * La mappa è indicizzata sull'enum di `@road/shared`, quindi aggiungere un ottavo stato senza
 * scriverne la classe è un errore di compilazione e non una `undefined` a runtime.
 */
export class RobotaxiStateFactory {
  private static readonly constructors: Readonly<Record<RobotaxiStateName, () => RobotaxiState>> = {
    AVAILABLE: () => new AvailableState(),
    ASSIGNED: () => new AssignedState(),
    ARRIVING: () => new ArrivingState(),
    ARRIVED: () => new ArrivedState(),
    IN_RIDE: () => new InRideState(),
    REBALANCING: () => new RebalancingState(),
    MAINTENANCE: () => new MaintenanceState(),
  };

  /**
   * Una **nuova** istanza dello stato indicato.
   *
   * Nuova e non condivisa: le classi di stato sono senza dati e un singleton funzionerebbe, ma
   * restituirlo legherebbe la correttezza a quella proprietà. Il DD dice «rebuilt on each read», e
   * il codice fa letteralmente quello.
   */
  static forState(name: RobotaxiStateName): RobotaxiState {
    return RobotaxiStateFactory.constructors[name]();
  }
}
