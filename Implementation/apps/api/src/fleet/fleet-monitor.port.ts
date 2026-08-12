import type { RobotaxiState as RobotaxiStateName } from '@road/shared';

import type { RideAssignment } from './ride-assignment';
import type { RobotaxiSnapshot } from './robotaxi';

/**
 * La porta del `FleetMonitor` (DD §2.2, CLAUDE.md Regola 1).
 *
 * Le cinque operazioni del DD §2.2 — `getCandidates`, `getAvailableRobotaxis`, `getFleetStatus`,
 * `assign`, `requestRebalancing` — più le due che M4 aggiunge: `releaseAssignment`, insieme alla
 * transizione 11 della Figura 2.10 (decisione D28), e `getBookableRobotaxis`, perché «può prendere
 * una corsa adesso» e «potrà servirne una fra due ore» non sono la stessa domanda (decisione D34).
 * Le quattro transizioni intermedie arrivano con M5 (decisione D37), e M7 chiude l'elenco con le
 * due che la telemetria rende possibili: `completeRebalancing`, la transizione 9 che fino ad allora
 * nessuno sapeva innescare, e `recordPositions`, che non è una transizione affatto (decisioni D60 e
 * D61). Il DD attribuisce a `RideRequestManager` il
 * compito di riportare il veicolo ad `AVAILABLE` quando una corsa viene annullata (§2.4, R14) senza
 * dire attraverso quale operazione: `rides` non può toccare la colonna di stato — la macchina la
 * governa `fleet` — quindi l'operazione che mancava è questa.
 *
 * I tipi che compaiono nelle firme, `RobotaxiSnapshot` e `RideAssignment`, sono pubblicati
 * dall'altra porta del modulo, `robotaxi.port.ts`: chi sta fuori li importa da lì.
 */

/**
 * La panoramica della flotta in tempo reale che R7 e G8 chiedono per l'operatore: posizione e stato
 * di ogni veicolo, più il riepilogo per stato che la status bar della dashboard mostra (DD §3.2).
 *
 * `observedAt` viene da `ClockPort` e non dall'orologio di sistema (CLAUDE.md Regola 3): serve al
 * client per sapere quanto è fresco il dato, e ai test per essere riproducibili.
 */
export interface FleetStatus {
  readonly observedAt: Date;
  readonly total: number;
  readonly countsByState: Readonly<Record<RobotaxiStateName, number>>;
  readonly robotaxis: readonly RobotaxiSnapshot[];
}

/**
 * Dove un veicolo è stato osservato, e quando (M7).
 *
 * È ciò che resta della telemetria una volta tolto tutto quello che riguarda il fornitore: non c'è
 * la rotta, non c'è quanto manca, non c'è se è arrivato. `fleet` ha bisogno di sapere **dove sono i
 * veicoli**, che è la domanda di R7 e G8; il resto serve a chi decide le transizioni, e passa da
 * `ExternalServicesPort`.
 */
export interface ObservedPosition {
  readonly robotaxiId: string;
  readonly lat: number;
  readonly lon: number;
  readonly observedAt: Date;
}

/** Sollevata quando l'identificatore indicato non corrisponde ad alcun veicolo della flotta. */
export class UnknownRobotaxiError extends Error {
  constructor(readonly robotaxiId: string) {
    super(`Nessun robotaxi con id ${robotaxiId}.`);
    this.name = 'UnknownRobotaxiError';
  }
}

export abstract class FleetMonitorPort {
  /**
   * I veicoli che possono accettare una corsa, in ordine di `id` crescente: quelli in uno stato di
   * `ALLOCATABLE_STATES`.
   *
   * Guarda **solo lo stato**. Il filtro sulla timeline — quali veicoli sono liberi in una certa
   * finestra — non passa di qui: il DD §2.4, Figure 2.5 e 2.8, lo mette in capo a
   * `RideRequestManager`, che chiama `PersistencePort.filterAvailable()` sui candidati ricevuti.
   * Assorbirlo in questa operazione sposterebbe una responsabilità fra componenti, e da M4 in poi
   * esisterebbero due strade per lo stesso filtro.
   *
   * L'insieme che ne esce viene passato *dentro* `AllocationPort.allocate()` da
   * `RideRequestManager`: `allocation` non dipende da `fleet` (DD §2.2.1, decisione D5).
   */
  abstract getCandidates(): Promise<RobotaxiSnapshot[]>;

  /**
   * I veicoli che possono ricevere una **prenotazione** per una finestra futura, in ordine di `id`
   * crescente: quelli in uno stato di `BOOKABLE_STATES`, cioè tutti tranne quelli in manutenzione
   * (R4, decisione D34).
   *
   * Non è `getCandidates()` e non deve diventarlo. Quella risponde a «chi può prendere una corsa
   * adesso», questa a «chi potrà servirne una fra due ore»: un veicolo oggi `IN_RIDE` sarà libero
   * appena la corsa finisce, e la sua riserva — limitata, per la decisione D8 — dice esattamente
   * quando. Se una prenotazione partisse dai soli candidati allocabili, con la flotta impegnata
   * verrebbe rifiutata sempre, anche per un orario in cui la flotta sarà tutta libera.
   *
   * Come `getCandidates()`, guarda **solo lo stato**: a escludere chi è già impegnato nella finestra
   * richiesta è `PersistencePort.filterAvailable()`, che `RideRequestManager` chiama subito dopo.
   */
  abstract getBookableRobotaxis(): Promise<RobotaxiSnapshot[]>;

  /**
   * I veicoli **inattivi**, cioè in stato `AVAILABLE`, in ordine di `id` crescente.
   *
   * Non è un sinonimo di `getCandidates()`: un veicolo in `REBALANCING` è allocabile ma non
   * inattivo, e mandarlo a riposizionarsi una seconda volta non avrebbe senso. È questa lista che
   * il `RebalancingManager` di M6 usa come sorgente dei veicoli da spostare.
   */
  abstract getAvailableRobotaxis(): Promise<RobotaxiSnapshot[]>;

  /** La fotografia della flotta per la dashboard operatore (R7, G8). */
  abstract getFleetStatus(): Promise<FleetStatus>;

  /**
   * Porta il veicolo ad `ASSIGNED` e ne persiste lo stato (transizioni 3 e 10).
   *
   * Solleva `IllegalTransitionError` se il veicolo non è in uno stato allocabile — in manutenzione,
   * o già impegnato in una corsa —, `ConcurrentTransitionError` se un altro scrittore lo ha
   * cambiato nel frattempo, e `UnknownRobotaxiError` se non esiste.
   *
   * **Non** scrive il legame fra corsa e veicolo né la riserva: secondo il DD §2.4, Figura 2.5 è
   * `RideRequestManager` a chiamare subito dopo `PersistenceManager.reserve()`, che aggiorna
   * l'assegnazione e impegna la finestra in una sola transazione (M4).
   */
  abstract assign(robotaxiId: string, request: RideAssignment): Promise<RobotaxiSnapshot>;

  /**
   * Le quattro transizioni con cui una corsa **avanza**: 4, 5, 6 e 7 della Figura 2.10 (M5).
   *
   * `assign()` e `releaseAssignment()` esistevano già ed erano gli unici due modi di muovere un
   * veicolo dall'esterno: bastavano finché il ciclo di vita andava soltanto aperto e chiuso. R6
   * chiede di notificare al passeggero «vehicle assignment, ETA, arrival at the pickup point, and
   * ride completion», cioè proprio i passi intermedi, e senza un modo di *provocarli* la
   * progressione non sarebbe osservabile — il canale push di questa milestone non avrebbe niente da
   * trasportare. Le transizioni sono quelle che M2 ha già scritto nelle classi di stato: qui non
   * nasce comportamento nuovo, si pubblica il modo di innescarlo.
   *
   * **Chi le chiama.** In questa milestone `rides`, attraverso `RideLifecyclePort`, che muove
   * insieme il veicolo e la corsa. Da M7 le innescherà la telemetria del simulatore
   * (`ExternalServicesPort.readTelemetry()`), che è ciò che risolve le guardie della Figura 2.10
   * dipendenti dalla posizione reale — `hasReachedPickup()`, `hasReachedDestination()`. Il verso
   * resta questo: chi osserva il veicolo dice *quando*, la classe di stato decide *se*.
   *
   * Tutte e quattro condividono la disciplina di `assign()`: `IllegalTransitionError` se lo stato
   * corrente non le ammette, `ConcurrentTransitionError` se la riga è cambiata fra lettura e
   * scrittura, `UnknownRobotaxiError` se il veicolo non esiste.
   */
  /**
   * Transizione 4: il veicolo assegnato parte verso il punto di ritiro (`ASSIGNED → ARRIVING`).
   *
   * `etaToPickupMinutes` è il tempo che il passeggero vedrà nella notifica di avvicinamento (R6,
   * decisione D66). **Non è un dato che `fleet` sappia produrre**: glielo passa chi ha chiesto la
   * transizione, che è anche chi ha chiesto il percorso al fornitore di mappe. La forma è quella di
   * `assign()`, che riceve allo stesso modo la corsa accettata — un valore che il modulo non
   * calcola, trasporta, e che serve a chi riceverà l'evento.
   *
   * È **opzionale e annullabile**, e non per comodità: il fornitore può non saper rispondere per un
   * veicolo, e chi fa avanzare una corsa senza aver chiesto un percorso non ha un tempo da
   * promettere. Senza, il passeggero riceve l'annuncio dell'avvicinamento senza minuti — cioè ciò
   * che il sistema faceva fino a M6 (decisione D46).
   */
  abstract startPickupNavigation(
    robotaxiId: string,
    etaToPickupMinutes?: number | null,
  ): Promise<RobotaxiSnapshot>;

  /** Transizione 5: il veicolo è al punto di ritiro (`ARRIVING → ARRIVED`). */
  abstract pickupReached(robotaxiId: string): Promise<RobotaxiSnapshot>;

  /** Transizione 6: il passeggero è a bordo e si parte (`ARRIVED → IN_RIDE`). */
  abstract startRide(robotaxiId: string): Promise<RobotaxiSnapshot>;

  /** Transizione 7: destinazione raggiunta, il veicolo torna libero (`IN_RIDE → AVAILABLE`). */
  abstract completeRide(robotaxiId: string): Promise<RobotaxiSnapshot>;

  /**
   * Riporta ad `AVAILABLE` un veicolo che era stato assegnato e la cui corsa è stata annullata
   * (transizione 11, R14).
   *
   * Sta a `assign()` come la transizione 11 sta alla 3, e ne condivide la disciplina: solleva
   * `IllegalTransitionError` se il veicolo non è in `ASSIGNED` — in particolare se si è già mosso
   * verso il punto di ritiro —, `ConcurrentTransitionError` se un altro scrittore lo ha cambiato
   * fra la lettura e la scrittura, `UnknownRobotaxiError` se non esiste.
   *
   * **Non** rilascia la riserva né tocca la richiesta di corsa: quelle sono scritture di
   * `PersistenceManager` che `RideRequestManager` ordina subito dopo, esattamente come
   * nell'assegnazione (DD §2.4).
   */
  abstract releaseAssignment(robotaxiId: string): Promise<RobotaxiSnapshot>;

  /**
   * Riporta ad `AVAILABLE` un veicolo che ha raggiunto la zona verso cui era stato mandato
   * (transizione 9, M7).
   *
   * La Figura 2.10 la definisce dal v1.0 e `RebalancingState` la implementa dal M2, ma fino a M6
   * **nessuna operazione la innescava**: un veicolo mandato a riposizionarsi restava in
   * `REBALANCING` finché una corsa non lo interrompeva (transizione 10). Mancava la guardia
   * `hasReachedTargetArea()`, che dipende dalla posizione reale del veicolo — cioè dalla telemetria,
   * che nasce con M7. È la stessa lacuna che la decisione D37 aveva colmato per le transizioni 4-7,
   * lasciata aperta sulla 9 perché allora nessuno sapeva dire *quando* (decisione D60).
   *
   * Il chiamante è il `RebalancingManager`, all'inizio del proprio ciclo: chi ha mandato il veicolo
   * è chi si accorge che è arrivato. Condivide la disciplina di `assign()` —
   * `IllegalTransitionError` se il veicolo non è in `REBALANCING`, `ConcurrentTransitionError` se la
   * riga è cambiata fra lettura e scrittura, `UnknownRobotaxiError` se non esiste.
   */
  abstract completeRebalancing(robotaxiId: string): Promise<RobotaxiSnapshot>;

  /**
   * Scrive dove i veicoli sono stati osservati, e restituisce quanti ne ha aggiornati (M7).
   *
   * **Non è una transizione**: nessuna colonna di stato cambia, nessuna classe di stato viene
   * interrogata, nessun observer viene notificato. Un veicolo che si sposta lungo la propria rotta
   * non cambia ciò che è, cambia dov'è — e R7 chiede all'operatore di poter vedere entrambe le
   * cose.
   *
   * Sta qui e non in chi legge la telemetria perché la riga del veicolo la scrive `fleet` e nessun
   * altro (decisione D28): il modulo che osserva consegna ciò che ha visto, il modulo che possiede
   * il dato lo registra. Un veicolo sconosciuto viene ignorato invece di sollevare — la telemetria
   * arriva da un sistema esterno, che può parlare di veicoli che ROAd non ha in flotta, e un ciclo
   * periodico non deve fermarsi per questo.
   *
   * Le notifiche restano fuori di proposito: una posizione cambia a ogni tick, e spingerne una per
   * veicolo per tick inonderebbe il canale di M5 — che esiste per gli eventi della corsa (R6). La
   * dashboard le posizioni le legge da `getFleetStatus()`.
   */
  abstract recordPositions(positions: readonly ObservedPosition[]): Promise<number>;

  /**
   * Porta il veicolo a `REBALANCING` e ne persiste lo stato (transizione 8).
   *
   * La zona di destinazione non è un argomento: il DD §2.4, Figura 2.7 la fa viaggiare su
   * `ExternalServicesPort.commandRoute()`, non su questa operazione, e l'azione che la origina si
   * registra in `rebalancing_action`, tabella che nasce con M6. Qui accade esattamente ciò che la
   * transizione 8 prescrive: il veicolo cambia stato.
   */
  abstract requestRebalancing(robotaxiId: string): Promise<RobotaxiSnapshot>;
}
