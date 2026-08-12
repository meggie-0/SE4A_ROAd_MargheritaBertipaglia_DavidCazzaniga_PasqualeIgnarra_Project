/**
 * La **seconda porta** del modulo `mode`: il punto in cui un'esecuzione periodica entra nel dominio.
 *
 * È la stessa scelta già fatta in M4 con `AdvanceBookingActivatorPort` (decisione D33), e per la
 * stessa ragione. Il DD §2.2.1 elenca `TrafficMonitor.runOnce()` fra le attività periodiche —
 * «reads `getTraffic()` and calls `onTrafficLevel()`» — e CLAUDE.md Regola 3 pretende che quel
 * metodo sia chiamabile **dai test direttamente**, senza aspettare un timer. Ma HARNESS.md §3 dice
 * che nemmeno i test possono raggiungere l'interno di un modulo: se `TrafficMonitor` restasse una
 * classe privata di `mode`, il solo modo di provarlo sarebbe importarla da fuori, cioè rompere il
 * confine che tutto il resto del progetto difende.
 *
 * La porta è quindi ciò che rende la Regola 3 e la Regola 1 compatibili: l'esecuzione periodica ha
 * un ingresso pubblico, e chi lo usa non vede niente altro del componente.
 *
 * `RebalancingScheduler` **non** ha una porta corrispondente, ed è la differenza che vale la pena
 * notare: quello non fa altro che chiamare `RebalancingPort.rebalance()`, che è già pubblica, e una
 * porta in più avrebbe pubblicato un secondo nome per la stessa operazione. Qui invece c'è del
 * comportamento che nessun'altra operazione realizza — la lettura della sorgente esterna e il
 * passaggio del livello al controller — e senza questa porta resterebbe non verificabile.
 */
export abstract class TrafficMonitorPort {
  /**
   * Una lettura del traffico: la chiede a `ExternalServicesPort` e la passa a
   * `ModePort.onTrafficLevel()` (DD §2.2.1, «Periodic work»; Figura 2.6).
   *
   * In produzione la chiama un `@Cron`; nei test la chiamano i test. Non c'è nessun timer qui
   * dentro né nel componente che la realizza (CLAUDE.md Regola 3).
   */
  abstract runOnce(): Promise<void>;
}
