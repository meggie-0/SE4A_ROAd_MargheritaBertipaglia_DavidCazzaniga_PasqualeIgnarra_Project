import type { ZoneDemand } from '@road/shared';

/**
 * La porta del `RebalancingManager` (DD §2.2, CLAUDE.md Regola 1).
 *
 * Le due operazioni sono quelle del DD §2.2 — `analyzeDemand`, `rebalance` — e nient'altro.
 * Entrambe **senza argomenti**: il DD §2.2.1 lo dice esplicitamente per la prima
 * («`analyzeDemand()` is exported without arguments: the `analyzeDemand(demandData, trafficData,
 * fleetStatus)` message in Figure 2.7 is a self-call, and the manager gathers its own inputs»), e
 * vale per la stessa ragione per la seconda: un ciclo di riposizionamento è una decisione che il
 * sistema prende sullo stato che ha, non su parametri che qualcuno gli passa. L'istante lo dà
 * `ClockPort`.
 *
 * Il tipo `ZoneDemand` viene da `@road/shared` e non da qui: è la forma che la dashboard riceve
 * sull'HTTP, e dichiararla due volte — una per il dominio e una per il contratto — avrebbe creato
 * due verità da tenere allineate a mano.
 */

/**
 * Un veicolo mandato a riposizionarsi: chi, e verso dove.
 *
 * `rebalance()` restituisce il piano invece di limitarsi a eseguirlo perché senza un esito
 * l'operazione sarebbe verificabile solo per effetti collaterali — leggendo la colonna di stato dei
 * veicoli e la tabella delle azioni — e un test che ricostruisce ciò che è successo interrogando il
 * database verifica il database, non la decisione.
 */
export interface RebalancingDispatch {
  readonly robotaxiId: string;
  readonly targetZoneId: string;
  /**
   * La zona da cui il veicolo è stato preso: sempre una in surplus, mai nulla.
   *
   * Non è annullabile, e non per ottimismo: un veicolo può essere scelto **solo** se è stato trovato
   * in una zona, perché è l'appartenenza a una zona in surplus a renderlo eleggibile. Le zone sono
   * una partizione di Voronoi (decisione D10), quindi un veicolo senza zona esisterebbe solo con
   * l'elenco delle zone vuoto — e allora non ci sarebbe nemmeno una destinazione dove mandarlo.
   * Dichiararlo annullabile avrebbe costretto la dashboard di M8 a gestire un caso impossibile.
   */
  readonly fromZoneId: string;
}

/**
 * L'esito di `analyzeDemand()`: le zone stimate e **l'istante a cui la stima si riferisce**.
 *
 * L'istante fa parte dell'esito e non lo aggiunge il chiamante, per la ragione più concreta
 * possibile: viene da `ClockPort` (CLAUDE.md Regola 3), e nel `gateway` non c'è un orologio — né
 * deve essercene uno. Una stima senza il proprio istante costringerebbe chi la riceve a
 * datarla da sé, e la data sarebbe quella della risposta, non quella del calcolo.
 */
export interface DemandAnalysis {
  readonly analyzedAt: Date;
  readonly zones: readonly ZoneDemand[];
}

/** L'esito di un ciclo: la stessa analisi, più i veicoli mandati e quelli arrivati. */
export interface RebalancingPlan extends DemandAnalysis {
  readonly dispatched: readonly RebalancingDispatch[];
  /**
   * I veicoli che hanno **raggiunto** la zona verso cui erano stati mandati, e che questo ciclo ha
   * riportato ad `AVAILABLE` (transizione 9, M7).
   *
   * Un ciclo chiude prima di aprire: senza questa metà, un veicolo mandato a riposizionarsi
   * resterebbe in `REBALANCING` per sempre — allocabile, ma mai più contato fra gli inattivi e
   * quindi mai più spostabile (decisione D60). È vuota finché nessuno è arrivato, che è lo stato
   * normale di una flotta ferma.
   */
}

export abstract class RebalancingPort {
  /**
   * La domanda attesa per zona, in ordine **decrescente**, pareggi sull'`id` crescente
   * (R10, G9; decisione D12).
   *
   * Combina la base storica di `demand_sample` — cercata nella fascia oraria settimanale in **ora
   * locale di Milano**, non in UTC — con i moltiplicatori degli eventi di `demand_event` attivi in
   * questo istante. Porta anche i veicoli inattivi per zona e il deficit che ne risulta, perché
   * «quali zone hanno alta domanda» e «quali zone sono scoperte» sono due domande diverse e
   * l'operatore ha bisogno di entrambe.
   *
   * **Non scrive nulla e non muove nessun veicolo.** È una stima: chi la legge decide.
   */
  abstract analyzeDemand(): Promise<DemandAnalysis>;

  /**
   * Chiude i riposizionamenti dei robotaxi che hanno raggiunto la zona di destinazione.
   *
   * È separata da `rebalance()` perché l'arrivo di un veicolo è un evento della telemetria e non deve
   * attendere il successivo ciclo di previsione della domanda.
   */
  abstract completeArrivedRebalancing(): Promise<readonly string[]>;

  /**
   * Un ciclo di riposizionamento (R11, G9; DD §2.4, Figura 2.7).
   *
   * Prende le zone in ordine di **deficit decrescente** e, per ciascuna zona in deficit, manda il
   * veicolo inattivo più vicino preso da una zona in **surplus**, con i pareggi rotti sull'`id` del
   * robotaxi crescente (decisione D12). Un veicolo per zona per ciclo: il deficit è una domanda
   * *attesa*, non una coda di richieste, e svuotare le zone in surplus per pareggiarlo tutto in un
   * colpo produrrebbe l'oscillazione che il ciclo successivo dovrebbe correggere.
   *
   * Ogni veicolo mandato passa `AVAILABLE → REBALANCING` per mano di `FleetMonitorPort`
   * (transizione 8) e lascia una riga in `rebalancing_action`. Un veicolo che nel frattempo è stato
   * assegnato a una corsa viene semplicemente saltato: la corsa di un passeggero vale più di un
   * riposizionamento previsto.
   *
   * Se nessuna zona è in deficit, o se non c'è nessun veicolo in surplus da mandare, non fa nulla e
   * il piano esce vuoto — il ramo «no rebalancing needed» della Figura 2.7.
   */
  abstract rebalance(): Promise<RebalancingPlan>;
}
