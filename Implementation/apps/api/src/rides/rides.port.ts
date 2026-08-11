import type { GeoPoint, RideRequestStatus } from '@road/shared';

import type {
  BookingRecord,
  ReservationRecord,
  RideRequestRecord,
} from '../persistence/persistence.port';

/**
 * La porta del `RideRequestManager` (DD §2.2, CLAUDE.md Regola 1).
 *
 * Le tre operazioni sono quelle di `IRideRequestService` — `submitImmediate`, `submitAdvance`,
 * `cancel` — e nient'altro. L'attivazione delle prenotazioni, che il DD §2.4 attribuisce allo
 * stesso componente, esce da una **seconda porta** (`advance-booking.port.ts`): `runOnce()` non è
 * un'operazione del servizio, è il punto in cui uno scheduler entra nel dominio, e le due cose
 * hanno chiamanti diversi (decisione D33).
 *
 * `rides` è il componente che *coordina*: chiede i candidati a `fleet`, la scelta ad `allocation`,
 * la finestra a `persistence`, i tempi di viaggio a `external`. Non decide con quale metrica si
 * sceglie un veicolo (lo fa la strategia attiva) e non decide quali transizioni sono ammesse (lo
 * fanno le classi di stato). Se un giorno comparisse qui una formula di distanza o uno `switch`
 * sullo stato di un veicolo, sarebbe il segno che una responsabilità è finita nel posto sbagliato.
 */

// ---------------------------------------------------------------------------------------------
// Ciò che il chiamante consegna
// ---------------------------------------------------------------------------------------------

/**
 * Una richiesta di corsa immediata (R3, G2).
 *
 * `passengerId` è un argomento della porta e non del contratto HTTP: chi richiede la corsa è chi
 * porta il token, e il gateway lo prende da lì. È la stessa scelta fatta in M1b per il ruolo di
 * registrazione (decisione D22).
 */
export interface RideRequestDraft {
  readonly passengerId: string;
  readonly pickup: GeoPoint;
  readonly pickupAddress?: string | null;
  readonly destination: GeoPoint;
  readonly destinationAddress?: string | null;
}

/** Una prenotazione anticipata (R4, G3): la stessa richiesta, più l'orario concordato. */
export interface AdvanceBookingDraft extends RideRequestDraft {
  readonly scheduledPickup: Date;
}

// ---------------------------------------------------------------------------------------------
// Ciò che la porta restituisce
// ---------------------------------------------------------------------------------------------

/**
 * Perché una richiesta non ha ottenuto un veicolo.
 *
 * Ce n'è **uno solo**, e va detto perché: dal punto di vista del passeggero «nessun veicolo in uno
 * stato allocabile», «tutti già impegnati in quella finestra» e «la strategia attiva non sa
 * valutarne nessuno» sono lo stesso fatto — non c'è una corsa. Distinguerli qui esporrebbe lo stato
 * interno della flotta a chi non può farci niente. Ciò che serve a chi opera il sistema è la
 * dashboard di R7, che lo stato della flotta lo mostra per intero.
 */
export type RideRejectionReason = 'NO_ELIGIBLE_ROBOTAXI';

/**
 * L'esito di una richiesta: o è accettata con il veicolo che la servirà, o è rifiutata.
 *
 * **La richiesta è persistita in entrambi i casi**, ed è il motivo per cui `request` sta fuori dal
 * ramo: il RASD §2.2.1 dà a `RequestStatus` lo stato `REJECTED`, quindi un rifiuto è una riga con
 * uno stato, non un'assenza. Senza, non resterebbe traccia delle richieste che il sistema non ha
 * saputo servire, che è esattamente il dato che dice quando la flotta è sottodimensionata.
 *
 * `robotaxiId` è il veicolo **riservato**. Per una corsa immediata è anche assegnato; per una
 * prenotazione anticipata lo diventerà all'attivazione (decisione D9), ed è la ragione per cui
 * `booking` è valorizzato solo lì.
 */
export type RideRequestOutcome =
  | {
      readonly accepted: true;
      readonly request: RideRequestRecord;
      readonly robotaxiId: string;
      readonly reservation: ReservationRecord;
      readonly booking: BookingRecord | null;
    }
  | {
      readonly accepted: false;
      readonly request: RideRequestRecord;
      readonly reason: RideRejectionReason;
    };

/**
 * L'esito di un annullamento (R14).
 *
 * I tre campi sono i tre effetti che il requisito enuncia: la richiesta passa a `CANCELLED`, il
 * veicolo torna disponibile *se* ne era stato assegnato uno, e la finestra torna prenotabile.
 * `releasedReservations` è un numero e non un booleano perché una prenotazione ri-allocata
 * all'attivazione può averne lasciata più d'una nello storico, e il chiamante deve poter vedere
 * che sono state chiuse tutte.
 */
export interface RideCancellation {
  readonly request: RideRequestRecord;
  readonly releasedRobotaxiId: string | null;
  readonly releasedReservations: number;
  /** La prenotazione annullata, se la richiesta era anticipata: la riga resta, per lo storico. */
  readonly booking: BookingRecord | null;
}

// ---------------------------------------------------------------------------------------------
// Gli errori
// ---------------------------------------------------------------------------------------------

/**
 * Sollevata quando la richiesta non esiste **o non è di chi la sta annullando**.
 *
 * I due casi danno lo stesso errore di proposito: distinguerli permetterebbe a un passeggero di
 * scoprire quali identificatori di corsa esistono provandoli, che è il modo più economico di
 * enumerare l'attività degli altri utenti.
 */
export class RideRequestNotFoundError extends Error {
  constructor(readonly rideRequestId: string) {
    super(`Nessuna richiesta di corsa ${rideRequestId} per questo passeggero.`);
    this.name = 'RideRequestNotFoundError';
  }
}

/**
 * Perché un annullamento è stato rifiutato.
 *
 * - `REQUEST_NOT_ACTIVE`: la richiesta è già annullata, rifiutata o conclusa. Non c'è niente da
 *   annullare, e ripetere la chiamata non cambierà nulla.
 * - `RIDE_ALREADY_UNDER_WAY`: il veicolo si è già mosso verso il punto di ritiro. R14 ammette
 *   l'annullamento «before the ride begins», ma la Figura 2.10 lascia tornare disponibile solo un
 *   veicolo ancora fermo (transizione 11, decisione D27): fermarne uno in movimento è un comando
 *   alla flotta, non una transizione del ciclo di vita, e arriva con M7.
 */
export type CancellationRefusal = 'REQUEST_NOT_ACTIVE' | 'RIDE_ALREADY_UNDER_WAY';

/** Sollevata quando la richiesta esiste ma non è più annullabile (R14). */
export class RideNotCancellableError extends Error {
  constructor(
    readonly rideRequestId: string,
    readonly refusal: CancellationRefusal,
    /** Lo stato che ha impedito l'annullamento: quello della richiesta o quello del veicolo. */
    readonly currentState: RideRequestStatus | string,
  ) {
    super(
      `La richiesta ${rideRequestId} non è annullabile (${refusal}, stato corrente ${currentState}).`,
    );
    this.name = 'RideNotCancellableError';
  }
}

/**
 * Sollevata quando l'orario di una prenotazione anticipata non è nel futuro.
 *
 * Il controllo è qui e non nello schema condiviso perché «futuro» è una relazione con l'adesso, e
 * l'adesso viene da `ClockPort` (CLAUDE.md Regola 3). Prenotare per un istante già passato non è
 * una richiesta che il sistema possa servire in ritardo: la sua finestra di riserva comincerebbe
 * prima di adesso, e l'attivazione sarebbe già scaduta nel momento in cui la si scrive.
 */
export class ScheduledPickupNotInFutureError extends Error {
  constructor(
    readonly scheduledPickup: Date,
    readonly now: Date,
  ) {
    super(
      `L'orario richiesto (${scheduledPickup.toISOString()}) non è successivo ad adesso (${now.toISOString()}).`,
    );
    this.name = 'ScheduledPickupNotInFutureError';
  }
}

// ---------------------------------------------------------------------------------------------
// La porta
// ---------------------------------------------------------------------------------------------

export abstract class RideRequestPort {
  /**
   * Richiesta immediata: la catena richiesta → candidati → allocazione → riserva → assegnazione
   * (R3, G2; DD §2.4, Figura 2.5).
   *
   * L'ordine fra riserva e assegnazione è `reserve()` **poi** `assign()` (decisione D30): la
   * riserva è il punto in cui la concorrenza viene arbitrata, quindi prenotare per primo fa sì che
   * un rifiuto non lasci nulla da disfare. Se il veicolo scelto non è ottenibile — un'altra
   * transazione lo sta impegnando, o la sua finestra si sovrappone a una riserva esistente — la
   * scelta si ripete fra i candidati rimanenti, che è la risposta che il DD §2.4 prevede già per
   * `ROBOTAXI_BUSY`.
   *
   * Non solleva quando nessun veicolo è idoneo: restituisce l'esito rifiutato, con la richiesta
   * persistita in stato `REJECTED`.
   */
  abstract submitImmediate(draft: RideRequestDraft): Promise<RideRequestOutcome>;

  /**
   * Prenotazione anticipata (R4, G3; DD §2.4, Figura 2.8).
   *
   * I candidati vengono filtrati sulla timeline con `PersistencePort.filterAvailable()` prima di
   * arrivare alla strategia, e la prenotazione accettata scrive **nella stessa transazione** la
   * riga di `booking` e quella di `robotaxi_reservation`: o esistono entrambe o nessuna (NFR4, C1).
   *
   * Il veicolo **non** viene assegnato adesso. Una prenotazione non è un'assegnazione: la
   * trasforma in tale `AdvanceBookingActivatorPort.runOnce()` poco prima dell'orario (decisione
   * D9), che è ciò che permette di ri-allocare se nel frattempo il veicolo non è più idoneo.
   *
   * Solleva `ScheduledPickupNotInFutureError` se l'orario richiesto non è successivo ad adesso.
   */
  abstract submitAdvance(draft: AdvanceBookingDraft): Promise<RideRequestOutcome>;

  /**
   * Annullamento (R14): la richiesta passa a `CANCELLED`, la riserva viene rilasciata e la
   * finestra torna prenotabile; se un veicolo era già stato assegnato, torna ad `AVAILABLE`.
   *
   * `passengerId` non è ridondante: è la sola prova che chi annulla è chi ha richiesto. Un
   * annullamento eseguito sulla corsa di un altro non è un errore di autorizzazione da segnalare —
   * è una richiesta che per quel passeggero non esiste, e per questo solleva
   * `RideRequestNotFoundError`.
   *
   * Solleva `RideNotCancellableError` se la richiesta non è più attiva o se la corsa è già in
   * corso. In entrambi i casi **nulla viene scritto**: il veicolo si libera prima della riserva,
   * quindi un rifiuto della macchina a stati lascia la riserva in piedi e la richiesta intatta.
   */
  abstract cancel(rideRequestId: string, passengerId: string): Promise<RideCancellation>;
}
