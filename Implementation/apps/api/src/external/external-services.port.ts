import type { GeoPoint, TrafficLevel } from '@road/shared';

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
 * **Delle cinque operazioni del DD §2.2 qui ce ne sono due.** `getETA` è entrata con M3, `getTraffic`
 * entra con M6 perché è il `TrafficMonitor` a leggerla (DD §2.2.1, «Periodic work»). `commandRoute`
 * e `readTelemetry` servono al simulatore e arrivano con M7: dichiararle adesso vorrebbe dire
 * scrivere metodi che nessuno chiama e che nessun test può falsificare, cioè aggiungere superficie
 * senza aggiungere verifica. Ogni operazione entra nella porta con la milestone che la mette in uso.
 *
 * **`getDemandData()` non entra in M6, ed è una divergenza consapevole dal DD** (decisione D47). La
 * Figura 2.7 la disegna come sorgente della domanda, ma la domanda di questo prototipo *sta nel
 * database*: `demand_sample` e `demand_event` sono due delle undici tabelle di M1, e i criteri con
 * cui si interrogano — «gli eventi attivi in un istante», `startsAt` non oltre `t` ed `endsAt`
 * oltre `t` — sono già scritti in `PersistencePort` con la decisione D12 a fianco. Farle passare da
 * qui avrebbe voluto dire mettere `external` **sopra** `persistence` per rileggere righe che il
 * `RebalancingManager` può leggere da sé (decisione D44), e nessuno dei due componenti ne sarebbe
 * uscito più sostituibile. L'operazione entra in M7 insieme a un fornitore vero, che è ciò che la
 * rende un servizio esterno invece di un giro di parole attorno a una `SELECT`.
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

  /**
   * Il livello di traffico corrente in città (RASD §2.2.1, R12).
   *
   * **Uno solo per la città, non uno per zona.** È la forma che R12 presuppone — «if traffic
   * conditions reach a Medium threshold» parla di una condizione sola — e quella che il
   * `ModeController` sa usare: la strategia attiva è una per il sistema intero, quindi una soglia
   * per zona non avrebbe niente da comandare. Il giorno in cui servisse il dettaglio per zona
   * sarebbe una seconda operazione, non un tipo di ritorno diverso da questo.
   *
   * Chi la chiama è `TrafficMonitor.runOnce()`, che poi passa il livello a
   * `ModePort.onTrafficLevel()` (DD §2.2.1, «Periodic work»; Figura 2.6). Nessun altro: il livello
   * *osservato* non è un ingresso dell'allocazione, è ciò che decide quale politica allocherà.
   */
  abstract getTraffic(): Promise<TrafficLevel>;
}
