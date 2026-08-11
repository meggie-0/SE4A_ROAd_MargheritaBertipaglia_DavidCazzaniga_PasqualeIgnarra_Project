/**
 * La **seconda porta** del modulo `rides`: l'attivazione delle prenotazioni anticipate
 * (DD §2.4, decisione D9; pubblicata come porta per la decisione D33).
 *
 * Il modulo ne espone due, come `fleet` e `platform` (HARNESS.md §3), e la divisione è la stessa
 * già adottata là: `rides.port.ts` è il **servizio** — le tre operazioni che un passeggero
 * richiede —, questo file è il **meccanismo** — il punto in cui un'esecuzione periodica entra nel
 * dominio. Metterlo su `RideRequestPort` avrebbe aggiunto una quarta operazione a un servizio che
 * il DD §2.2 definisce con tre, e l'avrebbe resa richiamabile da un client HTTP.
 *
 * `runOnce()` è pubblico perché deve poter essere chiamato **direttamente dai test**: prenotazioni
 * e attivazione sono definite sul tempo, e senza controllo del tempo i loro test sarebbero
 * instabili (CLAUDE.md Regola 3, DD decisione D16). In produzione lo chiama `@Cron`; nessun timer
 * vive nella logica di dominio.
 */

/** Come è finita l'attivazione di una singola prenotazione. */
export type BookingActivationOutcome =
  /** Il veicolo riservato era ancora idoneo: è stato assegnato, come da riserva. */
  | 'ACTIVATED'
  /** Non lo era più: la riserva è stata rilasciata e la corsa affidata a un altro veicolo. */
  | 'REALLOCATED'
  /** Non lo era più e nessun altro era idoneo in quella finestra: la richiesta è stata rifiutata. */
  | 'REJECTED';

export interface BookingActivation {
  readonly bookingId: string;
  readonly rideRequestId: string;
  readonly outcome: BookingActivationOutcome;
  /** Il veicolo che servirà la corsa; `null` se la richiesta è stata rifiutata. */
  readonly robotaxiId: string | null;
}

/**
 * Cosa ha fatto un'esecuzione.
 *
 * `ranAt` è l'istante su cui l'esecuzione ha deciso, non quello in cui è finita: è ciò che rende
 * riproducibile un test che fissa l'orologio. Le prenotazioni la cui richiesta è stata annullata
 * nel frattempo non compaiono affatto — non c'è niente da attivare, e non è un esito.
 */
export interface ActivationReport {
  readonly ranAt: Date;
  readonly activations: readonly BookingActivation[];
}

export abstract class AdvanceBookingActivatorPort {
  /**
   * Attiva tutte le prenotazioni la cui finestra di anticipo è scaduta (DD §2.4, decisione D9).
   *
   * Per ciascuna verifica che il veicolo riservato sia **ancora idoneo** — cioè che compaia fra i
   * candidati di `FleetMonitorPort.getCandidates()`, decisione D32 — e in tal caso lo porta
   * `AVAILABLE → ASSIGNED`. Se non lo è più, rilascia la riserva e ri-alloca fra i veicoli liberi
   * in quella finestra; se nessuno è idoneo, la richiesta passa a `REJECTED`.
   *
   * `now` è esplicito per chi ha già un istante su cui decidere — i test, e il `activateDueBookings(now)`
   * del DD §2.4 — e viene da `ClockPort` quando non lo si passa, che è il caso dello scheduler.
   *
   * È **idempotente rispetto alle prenotazioni già attivate**: una prenotazione con `activatedAt`
   * valorizzato non viene ripresa, quindi due esecuzioni ravvicinate non assegnano due volte.
   */
  abstract runOnce(now?: Date): Promise<ActivationReport>;
}
