/**
 * La **quarta porta** di `rides`: la telemetria che fa avanzare le corse (M7).
 *
 * `RideLifecyclePort` ha pubblicato in M5 le quattro transizioni con cui una corsa procede, ma in
 * M5 a chiamarle erano solo i test: la Figura 2.10 lascia aperte le guardie che dipendono dalla
 * posizione reale del veicolo — `hasReachedPickup()`, `hasReachedDestination()` — e senza telemetria
 * nessuno sapeva dire *quando*. La decisione D37 lo scriveva già: «da M7 le innescherà la telemetria
 * del simulatore». Questa porta è quel chiamante.
 *
 * **Perché sta in `rides`.** Ogni passo muove due cose insieme, lo stato del veicolo e quello della
 * corsa, ed è esattamente la ragione per cui `RideLifecycle` sta qui e non in `fleet` (M5): il
 * componente che coordina due moduli è per il DD §2.2 il `RideRequestManager`. Chi legge la
 * telemetria decide quali corse sono avanzate, quindi sta dalla parte delle corse. Metterla in
 * `fleet` avrebbe costretto quel modulo a conoscere le corse, cioè avrebbe invertito un arco della
 * Figura 2.1 (decisione D61).
 *
 * **È `runOnce()` e non un `@Cron`** (CLAUDE.md Regola 3, decisione D33): il ciclo periodico è un
 * metodo pubblico che in produzione chiama uno scheduler e nei test chiamano i test, un giro alla
 * volta. È la stessa forma di `AdvanceBookingActivatorPort`, e per la stessa ragione — senza,
 * l'avanzamento di una corsa dipenderebbe da quanto ha impiegato il test precedente.
 */

/** Il passo che un giro di telemetria ha fatto compiere a una corsa. */
export type TelemetryStep =
  'PICKUP_NAVIGATION_STARTED' | 'PICKUP_REACHED' | 'RIDE_STARTED' | 'RIDE_COMPLETED';

export interface TelemetryProgress {
  readonly rideRequestId: string;
  readonly robotaxiId: string;
  readonly step: TelemetryStep;
}

/**
 * L'esito di un giro.
 *
 * Restituirlo invece di limitarsi a eseguire è ciò che rende l'operazione verificabile senza
 * ricostruire cosa è successo interrogando il database: un test che leggesse le colonne
 * verificherebbe il database, non la decisione. Vale qui come per `RebalancingPort.rebalance()`.
 */
export interface TelemetryCycle {
  readonly observedAt: Date;
  /** Quanti veicoli hanno avuto la posizione aggiornata in tabella (R7, G8). */
  readonly positionsRecorded: number;
  /** Le corse avanzate, nell'ordine in cui sono state trattate. */
  readonly advanced: readonly TelemetryProgress[];
}

export abstract class FleetTelemetryPort {
  /**
   * Un giro: legge la telemetria, registra le posizioni, fa avanzare le corse che sono avanzate.
   *
   * **Non solleva per una corsa che non può avanzare.** Una transizione rifiutata — il veicolo è
   * cambiato sotto le mani, il passo è arrivato fuori tempo — riguarda una corsa sola, e fermare il
   * giro lascerebbe indietro tutte le altre. Si registra e si passa alla successiva, esattamente
   * come fa il ciclo di riposizionamento con un veicolo che gli è appena stato portato via.
   *
   * È **idempotente rispetto allo stato**: ogni giro decide guardando lo stato corrente del veicolo
   * e la telemetria di quell'istante, senza ricordare nulla del giro precedente. Un giro perso non
   * lascia una corsa a metà — la ritrova il giro dopo.
   */
  abstract runOnce(): Promise<TelemetryCycle>;
}
