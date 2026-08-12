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
 * **Delle cinque operazioni del DD §2.2 qui ce ne sono quattro.** `getETA` è entrata con M3,
 * `getTraffic` con M6 perché è il `TrafficMonitor` a leggerla (DD §2.2.1, «Periodic work»),
 * `commandRoute` e `readTelemetry` entrano con M7 insieme al simulatore, che è il fornitore che le
 * realizza. Ogni operazione entra nella porta con la milestone che la mette in uso: dichiararle
 * prima vorrebbe dire scrivere metodi che nessuno chiama e che nessun test può falsificare, cioè
 * aggiungere superficie senza aggiungere verifica.
 *
 * **`getDemandData()` non entra nemmeno in M7, ed è una divergenza consapevole dal DD** (decisione
 * D47, estesa dalla D62). La Figura 2.7 la disegna come sorgente della domanda, ma la domanda di
 * questo prototipo *sta nel database*: `demand_sample` e `demand_event` sono due delle undici
 * tabelle di M1, e i criteri con cui si interrogano — «gli eventi attivi in un istante», `startsAt`
 * non oltre `t` ed `endsAt` oltre `t` — sono già scritti in `PersistencePort` con la decisione D12
 * a fianco. Farle passare da qui vorrebbe dire mettere `external` **sopra** `persistence` per
 * rileggere righe che il `RebalancingManager` legge da sé (decisione D44), e nessuno dei due
 * componenti ne uscirebbe più sostituibile. La D47 rimandava l'operazione a «M7 insieme a un
 * fornitore vero»: di fornitori veri di domanda per Milano non ce n'è nessuno collegabile, quindi
 * l'operazione resta fuori finché non ce ne sarà uno, e non entra per rispettare un calendario.
 */

/**
 * Un'origine di cui si chiede il tempo di arrivo: chi è e dov'è.
 *
 * Non è `RobotaxiSnapshot`: quel tipo appartiene a `fleet`, e un fornitore esterno che lo ricevesse
 * saprebbe in che stato è il veicolo, cioè una cosa che non lo riguarda e che legherebbe `external`
 * a un altro modulo.
 */
export interface EtaOrigin {
  readonly id: string;
  readonly position: GeoPoint;
}

/**
 * La rotta da comandare a un veicolo: da dove parte e dove deve arrivare (M7).
 *
 * `from` non è ridondante e non si può togliere: ROAd non può presumere che il fornitore di flotta
 * sappia già dove si trova il veicolo — con veicoli veri lo saprebbe, con un simulatore che ha
 * appena ricevuto il primo comando no — e il percorso va calcolato a partire da un punto.
 *
 * È un tipo a sé e non l'`EtaOrigin` con una destinazione perché il **revocare** non ha né l'uno né
 * l'altra: si revoca passando `null` al posto dell'intera rotta, e chi annulla una corsa non deve
 * andare a cercare dove si trova il veicolo per dirgli di fermarsi.
 */
export interface RouteRequest {
  readonly from: GeoPoint;
  readonly to: GeoPoint;
}

/** Il tempo stimato perché l'origine `id` raggiunga la destinazione richiesta, in minuti. */
export interface EtaEstimate {
  readonly id: string;
  readonly etaMinutes: number;
}

/**
 * L'esito di un comando di rotta: il `commandAccepted` della Figura 2.7, cioè il fatto che la
 * chiamata sia tornata, più quello che la flotta ha da dire del percorso.
 *
 * **Non c'è un campo `accepted`**, ed è una rinuncia consapevole. La prima stesura di M7 ce l'aveva,
 * per aderire al nome del messaggio nella figura: nessuno dei due adapter poteva renderlo falso e
 * nessuno dei tre chiamanti lo leggeva, quindi era comportamento *descritto* e non implementato —
 * esattamente ciò che questa porta rimprovera alle operazioni dichiarate prima di avere un uso. Il
 * giorno in cui un fornitore saprà rifiutare un comando, il campo tornerà insieme al chiamante che
 * lo tratta; fino ad allora un comando che non si può eseguire è un errore, non un esito.
 *
 * I due numeri sono annullabili perché una **revoca** non ha né un tempo di arrivo né una
 * lunghezza: il veicolo non sta più andando da nessuna parte.
 */
export interface RouteCommandOutcome {
  readonly robotaxiId: string;
  readonly etaMinutes: number | null;
  readonly distanceKm: number | null;
}

/**
 * Ciò che la flotta racconta di un veicolo in movimento.
 *
 * `hasArrived` è il campo per cui questa operazione esiste. Le guardie della Figura 2.10 che il
 * backend non sapeva risolvere — `hasReachedPickup()`, `hasReachedDestination()`,
 * `hasReachedTargetArea()` — sono tutte la stessa domanda, «il veicolo è arrivato dove l'ho
 * mandato?», e la risposta la dà chi osserva il veicolo. Farla dedurre a un manager confrontando
 * coordinate con una soglia metterebbe un pezzo di fisica del veicolo dentro il dominio, e
 * cambierebbe significato il giorno in cui la flotta fosse fatta di veicoli veri.
 *
 * Il verso resta quello del DD, decisione D37: **chi osserva il veicolo dice *quando*, la classe di
 * stato decide *se***.
 */
export interface VehicleTelemetry {
  readonly robotaxiId: string;
  readonly position: GeoPoint;
  /** Dove il veicolo è stato mandato, o `null` se non sta seguendo nessuna rotta. */
  readonly destination: GeoPoint | null;
  readonly remainingKm: number;
  readonly hasArrived: boolean;
  /** L'istante dell'osservazione, da `ClockPort` e mai dall'orologio di sistema (Regola 3). */
  readonly observedAt: Date;
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

  /**
   * Manda il veicolo verso `destination`, oppure gli **revoca** la rotta se `destination` è `null`
   * (DD §2.4, Figura 2.7; §2.6.3, decisione D27).
   *
   * È l'unico comando che ROAd dà alla flotta, ed è la ragione per cui in M7 si completa R14. Il
   * DD §2.6.3 lo dice esplicitamente: riportare fra i disponibili un veicolo che si è già mosso
   * verso il punto di ritiro «richiede di revocarne la rotta (`commandRoute()`, M7), che è un
   * comando alla flotta e non una transizione del ciclo di vita». La revoca passa **da qui** e non
   * da una sesta operazione, perché è la stessa cosa detta con un argomento diverso — «segui questa
   * rotta» e «non seguirne nessuna» — e il documento le attribuisce entrambe a questo nome.
   *
   * **Non tocca lo stato del veicolo.** Comandare una rotta non è una transizione: quelle passano
   * da `FleetMonitorPort`, che è il solo a scrivere la colonna di stato (decisione D28). Chi
   * comanda una rotta fa poi la transizione che gli compete, o non ne fa nessuna.
   *
   * Revocare la rotta a un veicolo che non ne aveva una è **innocuo** e non è un errore: chi
   * annulla una corsa non deve prima dedurre dallo stato se il veicolo si fosse mosso.
   */
  abstract commandRoute(
    robotaxiId: string,
    route: RouteRequest | null,
  ): Promise<RouteCommandOutcome>;

  /**
   * La telemetria dei veicoli in movimento, in ordine di `id` crescente.
   *
   * Riguarda **solo i veicoli a cui è stata comandata una rotta**: un veicolo fermo che nessuno ha
   * mandato da nessuna parte non produce telemetria, perché non ha niente da raccontare e la sua
   * posizione autorevole è quella che ROAd ha già in tabella. L'esito può quindi essere vuoto, ed è
   * lo stato normale di una flotta a riposo.
   *
   * L'ordine è totale e non incidentale: chi la legge muove corse e scrive righe, e due esecuzioni
   * sullo stesso stato devono produrre la stessa sequenza di scritture.
   */
  abstract readTelemetry(): Promise<readonly VehicleTelemetry[]>;
}
