import type { RobotaxiState as RobotaxiStateName } from '@road/shared';

/**
 * Il vocabolario delle transizioni del robotaxi e l'errore che le governa (DD §2.6.3).
 *
 * Sta in un file a sé perché è la foglia del grafo del modulo: le classi di stato e il contesto lo
 * importano, e nulla di ciò che lui importa può a sua volta importarli. Il modulo `fleet` non ha
 * cicli, e `pnpm arch` lo verifica.
 */

/**
 * I nove metodi dichiarati da `RobotaxiState` nel DD §2.3.2, Figura 2.3.
 *
 * Sono un elenco esplicito e non una deduzione dai nomi dei metodi: il cancello di M2 enumera
 * 7 stati × 9 transizioni = 63 combinazioni, e deve poterle generare da una fonte che non sia il
 * codice sotto esame. Un test che ricavasse i metodi per introspezione della classe passerebbe
 * anche se un metodo sparisse, che è il difetto che il cancello esiste per escludere.
 */
export const ROBOTAXI_TRANSITIONS = [
  'assignRide',
  'startPickupNavigation',
  'pickupReached',
  'startRide',
  'completeRide',
  'requestRebalancing',
  'completeRebalancing',
  'requestMaintenance',
  'completeMaintenance',
] as const;

export type RobotaxiTransition = (typeof ROBOTAXI_TRANSITIONS)[number];

/**
 * Sollevata quando si chiede a un veicolo una transizione che il suo stato non ammette (NFR5).
 *
 * Il DD §2.6.3 fissa questa grafia **[v1.1]**: la v1.0 lo chiamava `InvalidTransition`, e documento,
 * codice e test devono usarne una sola.
 *
 * Porta con sé lo stato di partenza e la transizione richiesta perché chi la intercetta — la
 * dashboard operatore, il gateway — deve poter dire *cosa* è stato rifiutato, non solo che qualcosa
 * lo è stato.
 */
export class IllegalTransitionError extends Error {
  constructor(
    readonly robotaxiId: string,
    readonly from: RobotaxiStateName,
    readonly transition: RobotaxiTransition,
  ) {
    super(`Il robotaxi ${robotaxiId} non ammette "${transition}" dallo stato ${from}.`);
    this.name = 'IllegalTransitionError';
  }
}
