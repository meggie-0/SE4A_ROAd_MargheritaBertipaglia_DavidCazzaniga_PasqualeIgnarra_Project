import type { RobotaxiState as RobotaxiStateName } from '@road/shared';

/**
 * La porta del **ciclo di vita del veicolo** (DD §2.3.2 Figura 2.3, §2.6.3 Figura 2.10).
 *
 * `fleet` espone due porte, non una — come `platform`, che espone `clock.port.ts` e
 * `random.port.ts` (HARNESS.md §3). La divisione non è cosmetica:
 *
 * - `fleet-monitor.port.ts` è il **servizio**: le cinque operazioni che il DD §2.2 attribuisce al
 *   `FleetMonitor`, e nient'altro;
 * - questo file è il **vocabolario**: le classi con cui il DD descrive il ciclo di vita del veicolo,
 *   che il documento disegna come design pubblico e che quindi devono poter attraversare il confine
 *   del modulo. Le usa `maintenance` per portare un veicolo dentro e fuori dalla manutenzione
 *   passando dalla macchina a stati invece di scrivere la colonna a mano, e le usano i test, che
 *   secondo CLAUDE.md Regola 1 non hanno più diritto di accesso di un altro modulo.
 *
 * Ciò che **non** esce da `fleet` sono `FleetMonitor` e le sette classi di stato concrete: quelle si
 * raggiungono solo tramite `RobotaxiStateFactory`, che è il punto in cui il DD §2.6.3 vuole che si
 * passi. Le classi restano definite nei propri file; qui c'è solo la dichiarazione di cosa è
 * pubblico.
 */

export { Robotaxi, robotaxiSnapshotOf, type RobotaxiSnapshot } from './robotaxi';
export { RobotaxiState, type RobotaxiContext } from './robotaxi-state';
export { RobotaxiStateFactory } from './robotaxi-state.factory';
export {
  ConcurrentTransitionError,
  IllegalTransitionError,
  ROBOTAXI_TRANSITIONS,
  type RobotaxiTransition,
} from './robotaxi-transition';
export type { RideAssignment } from './ride-assignment';

/**
 * Gli stati dai quali un veicolo può accettare una corsa (DD §2.6.3).
 *
 * `REBALANCING` è dentro di proposito: la transizione 10 interrompe il riposizionamento e assegna
 * la corsa. `MAINTENANCE` è fuori, ed è il modo in cui R9 è realizzato — un veicolo in manutenzione
 * non è assegnabile perché il suo stato non lo è, non perché qualcuno se ne ricorda al momento
 * giusto.
 *
 * È una **seconda scrittura** di un fatto che sta già nelle classi di stato: allocabile equivale a
 * «la classe ridefinisce `assignRide`». Esiste perché la query di `getCandidates` ha bisogno di un
 * elenco di valori, non di sette istanze da interrogare. Due codifiche della stessa verità
 * divergono se nessuno le lega, quindi il cancello di M2 verifica l'equivalenza nei due versi.
 */
export const ALLOCATABLE_STATES: readonly RobotaxiStateName[] = ['AVAILABLE', 'REBALANCING'];
