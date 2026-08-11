import type { GeoPoint } from '@road/shared';

/**
 * La porta dell'`ExternalServicesGateway` (DD §2.2, CLAUDE.md Regola 1).
 *
 * È il **facade** verso tutto ciò che ROAd non controlla: mappe, traffico, sorgente di domanda,
 * flotta. La sua ragion d'essere è NFR8 nella formulazione falsificabile del DD §4.3 — «nessun
 * componente fuori da `ExternalServicesGateway` cita un protocollo o un SDK di un fornitore, e i
 * test di dominio girano sostituendo il solo gateway». Per questo la firma qui sotto parla di
 * punti e di minuti, non di route, polyline o codici di risposta HTTP: chi la usa non deve poter
 * dedurre che dietro ci sia OSRM, e nemmeno che ci sia una rete.
 *
 * **Delle cinque operazioni del DD §2.2 qui c'è solo `getETA`.** `getTraffic` e `getDemandData`
 * servono al `ModeController` e al `RebalancingManager` (M6), `commandRoute` e `readTelemetry` al
 * simulatore (M7): dichiararle adesso vorrebbe dire scrivere metodi che nessuno chiama e che
 * nessun test può falsificare, cioè aggiungere superficie senza aggiungere verifica. È la stessa
 * scelta già fatta in M2 con `RideAssignment`, che porta il solo campo che le transizioni usano.
 * Ogni operazione entra nella porta con la milestone che la mette in uso.
 */

/** Un'origine di cui si chiede il tempo di arrivo: chi è e dov'è. */
export interface EtaOrigin {
  readonly id: string;
  readonly position: GeoPoint;
}

/** Il tempo stimato perché l'origine `id` raggiunga la destinazione richiesta, in minuti. */
export interface EtaEstimate {
  readonly id: string;
  readonly etaMinutes: number;
}

export abstract class ExternalServicesPort {
  /**
   * I tempi di arrivo stimati dalle origini indicate verso una destinazione comune.
   *
   * È la chiamata `getETA(candidates, pickup)` della Figura 2.5: una sola richiesta per l'intero
   * insieme dei candidati, non una per veicolo, perché il fornitore reale di M7 risponde a
   * matrici di distanze e interrogarlo veicolo per veicolo moltiplicherebbe la latenza di
   * un'allocazione per il numero dei candidati.
   *
   * **Un'origine per cui il fornitore non sa rispondere non compare nell'esito**, e l'esito può
   * quindi essere più corto dell'ingresso o vuoto. Non è un dettaglio di comodo: è il modo in cui
   * `MinimumEtaStrategy` distingue «questo veicolo è lontanissimo» da «di questo veicolo non so
   * nulla», e un veicolo del secondo tipo non è idoneo — assegnarlo significherebbe promettere al
   * passeggero un tempo di attesa che nessuno ha calcolato.
   *
   * L'ordine dell'esito non è significativo: chi chiama associa per `id`.
   */
  abstract getETA(
    origins: readonly EtaOrigin[],
    destination: GeoPoint,
  ): Promise<readonly EtaEstimate[]>;
}
