import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression, Interval } from '@nestjs/schedule';
import { FLEET_POSITION_REFRESH_MS } from '@road/shared';
import { RebalancingPort } from './rebalancing.port';

/**
 * Il `RebalancingScheduler` del DD §2.2.1: in produzione innesca il ciclo della Figura 2.7.
 *
 * `runOnce()` è pubblico come il documento prescrive, ma **non ha una porta**, e la differenza
 * rispetto a `TrafficMonitorPort` merita una riga. Quello legge una sorgente esterna e traduce il
 * risultato in una chiamata al dominio: è comportamento che nessun'altra operazione realizza, e
 * senza una porta resterebbe non verificabile. Questo invece non fa altro che chiamare
 * `RebalancingPort.rebalance()`, che è già pubblica: pubblicarlo a sua volta darebbe due nomi alla
 * stessa operazione, e un test che chiamasse l'uno invece dell'altra dimostrerebbe la stessa cosa.
 *
 * Ciò che i test guidano direttamente è quindi `rebalance()`, attraverso la sua porta — che è ciò
 * che CLAUDE.md Regola 3 chiede («le esecuzioni periodiche sono un metodo pubblico chiamato dallo
 * scheduler in produzione e direttamente dai test») e insieme ciò che HARNESS.md §3 pretende, cioè
 * che nemmeno i test entrino nell'interno di un modulo.
 *
 * **Ogni dieci minuti.** Il riposizionamento insegue una domanda *attesa*, che si muove con le
 * fasce orarie: un ciclo più fitto manderebbe veicoli avanti e indietro inseguendo il rumore di
 * conteggi che cambiano per una corsa iniziata. Dieci minuti è anche il tempo in cui un veicolo
 * attraversa mezza Milano, quindi due cicli non si accavallano sullo stesso spostamento.
 */
@Injectable()
export class RebalancingScheduler {
  private readonly logger = new Logger(RebalancingScheduler.name);
  private completing = false;

  constructor(private readonly rebalancing: RebalancingPort) {}

  /**
   * La cadenza si accorcia da configurazione (decisione D76), con i dieci minuti come default.
   * `process.env` e non `ConfigService`: `@Cron` valuta l'argomento all'import, e `pnpm dev` carica
   * il file d'ambiente con `--env-file-if-exists` prima che qualunque modulo venga importato.
   */
  @Cron(process.env.REBALANCING_CRON ?? CronExpression.EVERY_10_MINUTES)
  async triggerRebalancingCycle(): Promise<void> {
    await this.runOnce();
  }

  @Interval(FLEET_POSITION_REFRESH_MS)
  async completeArrivedVehicles(): Promise<void> {
    if (this.completing) return;
    this.completing = true;

    try {
      const completed = await this.rebalancing.completeArrivedRebalancing();

      if (completed.length > 0) {
        this.logger.log(`Riposizionamento completato: ${completed.join(', ')} disponibili.`);
      }
    } catch (error) {
      this.logger.error('Il controllo dei riposizionamenti completati è fallito.', error);
    } finally {
      this.completing = false;
    }
  }

  /** Un ciclo di riposizionamento. Non solleva: un'esecuzione periodica non ha a chi riferire. */
  async runOnce(): Promise<void> {
    try {
      const plan = await this.rebalancing.rebalance();
      if (plan.dispatched.length > 0) {
        this.logger.log(`Riposizionamento: ${plan.dispatched.length} veicoli in movimento.`);
      }
    } catch (error) {
      // Se lo lasciasse uscire, diventerebbe un rifiuto non gestito e fermerebbe il processo. Si
      // registra e si riprova al ciclo successivo: la flotta resta dov'è, che è lo stato di
      // partenza e non uno stato incoerente.
      this.logger.error('Il ciclo di riposizionamento è fallito.', error);
    }
  }
}
