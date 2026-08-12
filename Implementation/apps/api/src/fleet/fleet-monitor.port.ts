import type { RobotaxiState as RobotaxiStateName } from '@road/shared';

import type { RideAssignment } from './ride-assignment';
import type { RobotaxiSnapshot } from './robotaxi';

/**
 * La porta del `FleetMonitor` (DD §2.2, CLAUDE.md Regola 1).
 *
 * Le cinque operazioni del DD §2.2 — `getCandidates`, `getAvailableRobotaxis`, `getFleetStatus`,
 * `assign`, `requestRebalancing` — più le due che M4 aggiunge: `releaseAssignment`, insieme alla
 * transizione 11 della Figura 2.10 (decisione D28), e `getBookableRobotaxis`, perché «può prendere
 * una corsa adesso» e «potrà servirne una fra due ore» non sono la stessa domanda (decisione D34). Il DD attribuisce a `RideRequestManager` il
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
  /** Transizione 4: il veicolo assegnato parte verso il punto di ritiro (`ASSIGNED → ARRIVING`). */
  abstract startPickupNavigation(robotaxiId: string): Promise<RobotaxiSnapshot>;

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
   * Porta il veicolo a `REBALANCING` e ne persiste lo stato (transizione 8).
   *
   * La zona di destinazione non è un argomento: il DD §2.4, Figura 2.7 la fa viaggiare su
   * `ExternalServicesPort.commandRoute()`, non su questa operazione, e l'azione che la origina si
   * registra in `rebalancing_action`, tabella che nasce con M6. Qui accade esattamente ciò che la
   * transizione 8 prescrive: il veicolo cambia stato.
   */
  abstract requestRebalancing(robotaxiId: string): Promise<RobotaxiSnapshot>;
}
