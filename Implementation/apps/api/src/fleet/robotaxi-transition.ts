import type { RobotaxiState as RobotaxiStateName } from '@road/shared';

/**
 * Il vocabolario delle transizioni del robotaxi e l'errore che le governa (DD §2.6.3).
 *
 * Sta in un file a sé perché è la foglia del grafo del modulo: le classi di stato e il contesto lo
 * importano, e nulla di ciò che lui importa può a sua volta importarli. Il modulo `fleet` non ha
 * cicli, e `pnpm arch` lo verifica.
 */

/**
 * I dieci metodi dichiarati da `RobotaxiState` nel DD §2.3.2, Figura 2.3.
 *
 * Sono un elenco esplicito e non una deduzione dai nomi dei metodi: il cancello di M2 enumera
 * 7 stati × 10 transizioni = 70 combinazioni, e deve poterle generare da una fonte che non sia il
 * codice sotto esame. Un test che ricavasse i metodi per introspezione della classe passerebbe
 * anche se un metodo sparisse, che è il difetto che il cancello esiste per escludere.
 *
 * `cancelRide` è la **transizione 11 [v1.2]**, aggiunta in M4 con la riga corrispondente del DD
 * §2.6.3: senza di essa R14 non è realizzabile. Il requisito pretende che l'annullamento «returns
 * the vehicle to the available state if it had already been assigned», ma la Figura 2.10 nella sua
 * versione v1.1 non aveva **nessuna** uscita da `ASSIGNED` verso `AVAILABLE` — l'unica era la
 * transizione 4 verso `ARRIVING`. Il documento contraddiceva sé stesso, e la contraddizione si
 * risolve dove la macchina è scritta, non aggirandola in un service.
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
  'cancelRide',
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

/**
 * Sollevata quando la transizione era legale al momento della lettura, ma qualcun altro ha cambiato
 * lo stato del veicolo prima che la si potesse scrivere.
 *
 * È distinta da `IllegalTransitionError` perché dice una cosa diversa e ammette una risposta
 * diversa. Là la richiesta era sbagliata e ripeterla non serve; qui era giusta e si è persa una
 * corsa: chi alloca può semplicemente passare al candidato successivo, che è la stessa risposta che
 * `PersistencePort.reserve()` prevede per `ROBOTAXI_BUSY`. Confonderle farebbe apparire come un
 * errore di programmazione ciò che è un esito ordinario di due passeggeri che chiedono insieme.
 *
 * Non è un'aggiunta alla Figura 2.10: la macchina a stati resta quella: questo è ciò che accade
 * quando due repliche del tier applicativo (NFR3) la percorrono contemporaneamente sullo stesso
 * veicolo.
 */
export class ConcurrentTransitionError extends Error {
  constructor(
    readonly robotaxiId: string,
    readonly expected: RobotaxiStateName,
    readonly transition: RobotaxiTransition,
  ) {
    super(
      `Il robotaxi ${robotaxiId} non era più in ${expected} quando "${transition}" stava per essere scritta.`,
    );
    this.name = 'ConcurrentTransitionError';
  }
}
