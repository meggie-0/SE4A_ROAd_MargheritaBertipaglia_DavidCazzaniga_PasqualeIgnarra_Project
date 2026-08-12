import type { RideStatus } from '@road/shared';

import type { RideRecord, RideRequestRecord } from '../persistence/persistence.port';

/**
 * La **terza porta** di `rides`: l'avanzamento di una corsa già assegnata (M5, R6, G7).
 *
 * `RideRequestPort` copre la nascita di una richiesta e la sua morte — `submitImmediate`,
 * `submitAdvance`, `cancel` —, `AdvanceBookingActivatorPort` il passaggio da prenotazione ad
 * assegnazione. Quello che mancava è il **mezzo**: il veicolo che parte, arriva, carica il
 * passeggero e lo porta a destinazione. Sono le transizioni 4, 5, 6 e 7 della Figura 2.10, e senza
 * un modo di innescarle la progressione che R6 chiede di notificare non esisterebbe.
 *
 * **Perché sta in `rides` e non in `fleet`.** Ogni passo muove due cose insieme: lo stato del
 * veicolo (`fleet`, decisione D28 — la colonna di stato la scrive solo lui) e lo stato della corsa
 * (`rides`, che possiede la tabella `ride`). Il componente che coordina due moduli è per il DD §2.2
 * il `RideRequestManager`, che già chiede i candidati a `fleet` e passa da `FleetMonitorPort` per
 * ogni transizione. Metterla in `fleet` avrebbe costretto quel modulo a conoscere le corse, cioè
 * avrebbe invertito un arco della Figura 2.1.
 *
 * **Chi la chiama.** In M5 i test, come per `runOnce()` prima che uno scheduler lo chiamasse. Da M7
 * la chiama il simulatore attraverso la telemetria: è lui a sapere *quando* un veicolo ha raggiunto
 * il punto di ritiro, che è la guardia `hasReachedPickup()` che la Figura 2.10 lascia aperta. Non
 * c'è un endpoint HTTP, e non è una dimenticanza: nessun requisito dà a un utente il potere di
 * dichiarare che un veicolo è arrivato — quel fatto lo osserva la flotta, non lo decide un client.
 */

/**
 * L'esito di un passo: la richiesta, la corsa e il veicolo dopo il cambiamento.
 *
 * `ride` è annullabile perché una richiesta rifiutata non genera una corsa (RASD §2.2.1), e il
 * chiamante deve poter distinguere «la corsa è avanzata» da «non c'era una corsa da far avanzare».
 */
export interface RideProgress {
  readonly request: RideRequestRecord;
  readonly ride: RideRecord | null;
  readonly robotaxiId: string;
  readonly rideStatus: RideStatus | null;
}

/**
 * Sollevata quando la richiesta non esiste, non è più attiva, o non ha un veicolo assegnato.
 *
 * Distinta da `IllegalTransitionError`: quella dice che il **veicolo** non può fare quel passo,
 * questa che non c'è una corsa su cui farlo. Confonderle nasconderebbe la differenza fra un
 * simulatore che manda un evento fuori tempo e una corsa che non esiste.
 */
export class RideNotInProgressError extends Error {
  constructor(
    readonly rideRequestId: string,
    readonly reason: 'UNKNOWN_REQUEST' | 'REQUEST_NOT_ACTIVE' | 'NO_ASSIGNED_ROBOTAXI',
  ) {
    super(`La richiesta ${rideRequestId} non ha una corsa in avanzamento (${reason}).`);
    this.name = 'RideNotInProgressError';
  }
}

export abstract class RideLifecyclePort {
  /**
   * Transizione 4: il veicolo assegnato parte verso il punto di ritiro (`ASSIGNED → ARRIVING`).
   *
   * La corsa resta `SCHEDULED`: per il passeggero il patto non è cambiato, è cambiato dove si trova
   * il suo veicolo. È il veicolo a notificare, con `VEHICLE_ARRIVING` — l'«ETA» che R6 nomina.
   */
  abstract startPickupNavigation(rideRequestId: string): Promise<RideProgress>;

  /**
   * Transizione 5: il veicolo è al punto di ritiro (`ARRIVING → ARRIVED`), e la corsa passa a
   * `WAITING_FOR_PICKUP` — sta aspettando il passeggero.
   */
  abstract pickupReached(rideRequestId: string): Promise<RideProgress>;

  /**
   * Transizione 6: il passeggero è a bordo (`ARRIVED → IN_RIDE`), la corsa passa a `IN_PROGRESS` e
   * `startedAt` si valorizza. È il «Ride starts when the passenger boards» del RASD §1.2.2.
   */
  abstract startRide(rideRequestId: string): Promise<RideProgress>;

  /**
   * Transizione 7: destinazione raggiunta (`IN_RIDE → AVAILABLE`). La corsa passa a `COMPLETED`, la
   * richiesta pure, e la riserva si **chiude sull'istante effettivo** invece di restare aperta fino
   * alla fine della finestra stimata (decisione D8): il tempo che avanza torna prenotabile.
   */
  abstract completeRide(rideRequestId: string): Promise<RideProgress>;
}
