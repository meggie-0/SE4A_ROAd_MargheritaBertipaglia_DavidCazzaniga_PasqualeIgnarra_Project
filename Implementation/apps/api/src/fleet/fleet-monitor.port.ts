import type { RobotaxiState as RobotaxiStateName } from '@road/shared';

import type { TimeWindow } from '../persistence/persistence.port';

import type { RideAssignment } from './ride-assignment';
import type { RobotaxiSnapshot } from './robotaxi';

/**
 * La porta del `FleetMonitor` (DD §2.2, CLAUDE.md Regola 1).
 *
 * Le cinque operazioni sono quelle del DD §2.2: `getCandidates`, `getAvailableRobotaxis`,
 * `getFleetStatus`, `assign`, `requestRebalancing`.
 *
 * ## Perché questo file ri-esporta il ciclo di vita del veicolo
 *
 * `Robotaxi`, `RobotaxiState`, `RobotaxiStateFactory` e `IllegalTransitionError` sono **design
 * pubblico**: il DD li disegna in Figura 2.3 e ne descrive il comportamento in §2.6.3. Ma CLAUDE.md
 * Regola 1 dice che un modulo si attraversa solo dai suoi `*.port.ts`, e `pnpm arch` lo impone
 * anche ai test (HARNESS.md §3). Senza questa ri-esportazione il cancello di M2 — che deve
 * enumerare 7 stati × 9 transizioni — non potrebbe raggiungere le classi che deve verificare, e
 * `MaintenanceManager` non potrebbe portare un veicolo in manutenzione passando dalla macchina a
 * stati invece che scrivendo la colonna a mano.
 *
 * Le classi restano definite nei propri file dentro `src/fleet/`: qui c'è solo la dichiarazione di
 * quale parte del modulo è pubblica. Ciò che **non** esce sono `FleetMonitor` e le sette classi di
 * stato concrete, che si raggiungono unicamente tramite `RobotaxiStateFactory`.
 */

export { Robotaxi, type RobotaxiSnapshot } from './robotaxi';
export { RobotaxiState, type RobotaxiContext } from './robotaxi-state';
export { RobotaxiStateFactory } from './robotaxi-state.factory';
export {
  IllegalTransitionError,
  ROBOTAXI_TRANSITIONS,
  type RobotaxiTransition,
} from './robotaxi-transition';
export type { RideAssignment } from './ride-assignment';

/**
 * Gli stati dai quali un veicolo può accettare una corsa, e quindi l'insieme che `getCandidates()`
 * restituisce (DD §2.6.3).
 *
 * `REBALANCING` è dentro di proposito: la transizione 10 interrompe il riposizionamento e assegna
 * la corsa. `MAINTENANCE` è fuori, ed è il modo in cui R9 è realizzato — un veicolo in manutenzione
 * non compare fra i candidati perché il suo stato non è allocabile, non perché qualcuno se ne
 * ricorda al momento giusto.
 */
export const ALLOCATABLE_STATES: readonly RobotaxiStateName[] = ['AVAILABLE', 'REBALANCING'];

/**
 * La panoramica della flotta in tempo reale che R7 e G8 chiedono per l'operatore: posizione e stato
 * di ogni veicolo, più il riepilogo per stato che la status bar della dashboard mostra (DD §3.2).
 *
 * `observedAt` viene da `ClockPort` e non dall'orologio di sistema (CLAUDE.md Regola 3): serve al
 * client per sapere quanto è fresco il dato, e ai test per essere riproducibili.
 */
export interface FleetStatus {
  readonly observedAt: Date;
  readonly total: number;
  readonly countsByState: Readonly<Record<RobotaxiStateName, number>>;
  readonly robotaxis: readonly RobotaxiSnapshot[];
}

/** Sollevata quando l'identificatore indicato non corrisponde ad alcun veicolo della flotta. */
export class UnknownRobotaxiError extends Error {
  constructor(readonly robotaxiId: string) {
    super(`Nessun robotaxi con id ${robotaxiId}.`);
    this.name = 'UnknownRobotaxiError';
  }
}

export abstract class FleetMonitorPort {
  /**
   * I veicoli che possono accettare una corsa, in ordine di `id` crescente.
   *
   * Sono quelli in uno stato di `ALLOCATABLE_STATES`. Se si indica una finestra temporale vengono
   * inoltre esclusi quelli con una riserva sovrapposta, chiedendolo a
   * `PersistencePort.filterAvailable()`: è il filtro sulla timeline che il DD §2.2 assegna al
   * `PersistenceManager` e che serve alla prenotazione anticipata (M4). Senza finestra si guarda
   * solo lo stato, che è ciò che basta alla richiesta immediata.
   *
   * L'insieme che ne esce viene passato *dentro* `AllocationPort.allocate()` da
   * `RideRequestManager`: `allocation` non dipende da `fleet` (DD §2.2.1).
   */
  abstract getCandidates(window?: TimeWindow): Promise<RobotaxiSnapshot[]>;

  /**
   * I veicoli **inattivi**, cioè in stato `AVAILABLE`, in ordine di `id` crescente.
   *
   * Non è un sinonimo di `getCandidates()`: un veicolo in `REBALANCING` è allocabile ma non
   * inattivo, e mandarlo a riposizionarsi una seconda volta non avrebbe senso. È questa lista che
   * il `RebalancingManager` di M6 usa come sorgente dei veicoli da spostare.
   */
  abstract getAvailableRobotaxis(): Promise<RobotaxiSnapshot[]>;

  /** La fotografia della flotta per la dashboard operatore (R7, G8). */
  abstract getFleetStatus(): Promise<FleetStatus>;

  /**
   * Porta il veicolo ad `ASSIGNED` e ne persiste lo stato (transizioni 3 e 10).
   *
   * Solleva `IllegalTransitionError` se il veicolo non è in uno stato allocabile — in manutenzione,
   * o già impegnato in una corsa — e `UnknownRobotaxiError` se non esiste.
   *
   * **Non** scrive il legame fra corsa e veicolo né la riserva: secondo il DD §2.4, Figura 2.5 è
   * `RideRequestManager` a chiamare subito dopo `PersistenceManager.reserve()`, che aggiorna
   * l'assegnazione e impegna la finestra in una sola transazione (M4).
   */
  abstract assign(robotaxiId: string, request: RideAssignment): Promise<RobotaxiSnapshot>;

  /**
   * Porta il veicolo a `REBALANCING` e ne persiste lo stato (transizione 8).
   *
   * La zona di destinazione non è un argomento: non esiste una colonna dove scriverla, e non è una
   * dimenticanza dello schema di M1 — il DD §2.2 la colloca in `rebalancing_action` insieme
   * all'azione che la origina, tabella che nasce con M6 (RASD §2.2.3). Finché quel manager non
   * esiste, questa operazione fa esattamente ciò che la Figura 2.10 prescrive per la transizione 8:
   * cambia lo stato del veicolo.
   */
  abstract requestRebalancing(robotaxiId: string): Promise<RobotaxiSnapshot>;
}
