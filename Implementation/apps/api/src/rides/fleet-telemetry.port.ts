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

/**
 * Quanto il sistema aspetta, al punto di ritiro, prima di assumere che il passeggero sia salito.
 *
 * **Dieci secondi**, ed è un'assunzione dichiarata del prototipo come la velocità media della stima
 * lineare: la guardia `isPassengerOnBoard()` della Figura 2.10 è l'unica che nessun sensore risolve
 * — né un simulatore né una flotta vera sanno dire se qualcuno è salito — e in un sistema reale la
 * scioglierebbe un'azione del passeggero sull'app, che nessun requisito di ROAd prevede
 * (decisione D63).
 *
 * **È un tempo e non un numero di cicli**, ed è la sola cosa cambiata rispetto a M8. Finché un giro
 * di telemetria durava dieci secondi, «al giro successivo all'arrivo» e «dopo dieci secondi»
 * significavano la stessa cosa; con il giro sceso a mezzo secondo la prima formulazione faceva
 * durare lo stato `arrived` mezzo secondo, cioè il passeggero non faceva in tempo a leggere che il
 * suo robotaxi era arrivato. Legata al tempo, la sosta dura quanto una salita, e quanti giri ci
 * stiano dentro smette di essere una cosa che qualcuno debba sapere.
 *
 * Sono secondi di **tempo reale**, presi da `ClockPort`, e non di mondo simulato: chi aspetta è una
 * persona davanti a uno schermo, non un veicolo su una strada.
 *
 * Sta sulla porta perché è **osservabile da fuori**: chi guida `runOnce()` — i test, gli scenari di
 * sistema — deve poter far scadere la sosta invece di indovinarla, e lo fa portando avanti
 * l'orologio finto di questa quantità. Una costante nascosta nell'implementazione avrebbe costretto
 * a riscriverne il valore in ogni test, che è il modo in cui due verità cominciano a divergere.
 *
 * È una costante e non una variabile d'ambiente, per la stessa ragione di
 * `DEFAULT_RESERVATION_TIMING`: nessun componente la configura, e una variabile in `.env.example`
 * che nessuno legge è una promessa falsa.
 */
export const BOARDING_SECONDS = 10;

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
