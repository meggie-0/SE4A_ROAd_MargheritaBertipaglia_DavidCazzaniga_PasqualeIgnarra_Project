import type { StrategyName } from '@road/shared';

import type { RobotaxiSnapshot } from '../fleet/robotaxi.port';

import type { AllocationRequest } from './allocation-strategy';

/**
 * La porta dell'`AllocationManager` (DD §2.2, CLAUDE.md Regola 1).
 *
 * Le tre operazioni sono quelle del DD §2.2.1 — `allocate`, `setActiveStrategy`,
 * `getActiveStrategy` — e nient'altro. Chi alloca inietta questa classe astratta, mai
 * `AllocationManager`.
 *
 * Insieme al servizio, questo file pubblica il **vocabolario del pattern Strategy**: la classe
 * astratta `AllocationStrategy`, il tipo della richiesta e il token del registro. La ragione è la
 * stessa per cui `fleet` pubblica le classi del ciclo di vita in `robotaxi.port.ts`: il DD §2.3.1
 * disegna `AllocationStrategy` come design pubblico, e NFR7 chiede che una politica nuova si
 * aggiunga «scrivendo una classe e registrandola» — cosa impossibile da dimostrare se la classe da
 * estendere non attraversa il confine del modulo. Le due strategie **concrete** restano dentro:
 * si raggiungono per nome, che è il punto del pattern.
 *
 * `allocation` **non dipende da `fleet`** (DD §2.2.1): i candidati non se li procura, glieli passa
 * `RideRequestManager` dopo averli chiesti a `FleetMonitor.getCandidates()`. Quello che questo file
 * importa da `fleet/robotaxi.port.ts` è il solo tipo `RobotaxiSnapshot`, cioè il vocabolario con
 * cui i due moduli si parlano; `AllocationModule` non importa `FleetModule`, e aggiungere
 * quell'arco sarebbe una divergenza dal DD.
 */

export {
  AllocationStrategy,
  bestScored,
  type AllocationRequest,
  type ScoredCandidate,
} from './allocation-strategy';

/**
 * Il token con cui Nest inietta **il registro delle strategie** nell'`AllocationManager`.
 *
 * Il manager riceve un elenco di `AllocationStrategy` e ne costruisce una mappa per nome: non
 * conosce nessuna classe concreta, e infatti nel suo file non ne compare il nome. Registrare una
 * politica nuova è una riga in `allocation.module.ts` (NFR7).
 */
export const ALLOCATION_STRATEGIES = Symbol('ALLOCATION_STRATEGIES');

/** Da dove viene il cambio di strategia (DD §2.2.1, `ChangeSource`). */
export type ChangeSource = 'auto' | 'manual';

/** Sollevata quando si chiede una strategia che nessuna classe registrata realizza. */
export class UnknownStrategyError extends Error {
  constructor(readonly strategy: string) {
    super(`Nessuna strategia di allocazione registrata con il nome ${strategy}.`);
    this.name = 'UnknownStrategyError';
  }
}

/**
 * Sollevata quando la riga singleton di `system_mode` non c'è.
 *
 * Non è una condizione di dominio: quella riga nasce con la migrazione iniziale e il suo `id` è
 * vincolato a un valore solo. Se manca, il database non è quello che il sistema si aspetta, e
 * fallire subito con un messaggio esplicito è più utile che tornare una strategia di default
 * inventata qui — che nasconderebbe lo schema sbagliato fino al primo comportamento strano.
 */
export class SystemModeNotInitialisedError extends Error {
  constructor() {
    super('La riga singleton di system_mode non esiste: eseguire le migrazioni.');
    this.name = 'SystemModeNotInitialisedError';
  }
}

export abstract class AllocationPort {
  /**
   * Il veicolo scelto fra i candidati secondo la **strategia attiva**, o `null` se nessuno è
   * idoneo (R5, G4).
   *
   * Il manager non decide con quale metrica: legge quale strategia è attiva e delega. È il
   * contesto del pattern Strategy (DD §2.6.1).
   *
   * Non scrive nulla: non cambia lo stato del veicolo — lo fa `FleetMonitor.assign()` — e non
   * impegna la finestra — lo fa `PersistenceManager.reserve()`. L'ordine delle tre chiamate è di
   * `RideRequestManager` (DD §2.4, Figura 2.5, M4).
   */
  abstract allocate(
    request: AllocationRequest,
    candidates: readonly RobotaxiSnapshot[],
  ): Promise<RobotaxiSnapshot | null>;

  /**
   * Rende attiva la strategia indicata (R8, G5).
   *
   * `source` è l'origine del cambiamento, e non è informativo: con `'manual'` la strategia e il
   * passaggio in modo Manual si scrivono **nella stessa transazione**, che è ciò che NFR10 chiede
   * («immediate and atomic transition to Manual Mode»); con `'auto'` il modo non viene toccato.
   * Questo metodo è l'unico scrittore della strategia attiva (DD §2.2.1).
   *
   * Chi decide *se* un cambio automatico può avvenire è il `ModeController` (M6), che secondo la
   * Figura 2.6 controlla modo e isteresi **prima** di chiamare qui. La regola dell'isteresi non è
   * quindi riscritta in questo metodo: sarebbe la stessa cosa detta in due posti, e le due copie
   * divergerebbero.
   *
   * **[M6]** Con `source: 'auto'` la scrittura è però **condizionata al modo Auto**, e non è un
   * secondo controllo della stessa regola: è la stessa disciplina che M2 applica a ogni transizione
   * di stato. Fra la lettura su cui il `ModeController` ha deciso e questa scrittura ci sta
   * l'intera azione di un operatore su un'altra replica del tier applicativo (NFR3), e senza la
   * condizione un cambio automatico deciso un istante prima sovrascriverebbe una scelta manuale
   * appena fatta — che è precisamente ciò con cui il DD §4.3 falsifica NFR10. La condizione la
   * valuta il database nella stessa istruzione della scrittura, quindi non c'è finestra in cui
   * infilarsi, e in quel caso il metodo solleva `StaleRecordError` **senza aver scritto nulla**: chi
   * chiama ha una via d'uscita utile, cioè rinunciare, perché l'essere umano ha la precedenza.
   *
   * Con `source: 'manual'` non c'è condizione, ed è il punto di NFR10: la scelta dell'operatore
   * vince sempre, qualunque sia il modo corrente.
   *
   * Solleva `UnknownStrategyError` se il nome non corrisponde a una strategia registrata.
   */
  abstract setActiveStrategy(name: StrategyName, source: ChangeSource): Promise<void>;

  /**
   * La strategia attiva, letta dalla sua unica sede autorevole — il record `system_mode` —
   * attraverso `PersistencePort` (DD §2.2.1).
   *
   * Non c'è una copia in memoria, ed è voluto: due repliche del tier applicativo che tenessero il
   * valore ciascuna per sé divergerebbero al primo cambio, e la dashboard mostrerebbe una
   * strategia diversa da quella con cui il sistema sta allocando (NFR3).
   */
  abstract getActiveStrategy(): Promise<StrategyName>;
}
