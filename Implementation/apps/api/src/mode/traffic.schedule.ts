import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';

import { TrafficMonitorPort } from './traffic-monitor.port';

/**
 * Lo **scheduler** che in produzione chiama `TrafficMonitor.runOnce()` (DD §2.2.1, «Periodic work»).
 *
 * Stessa forma di `AdvanceBookingSchedule` (M4) e per le stesse ragioni: separa *quando* si esegue
 * da *cosa* si esegue. Il secondo è dominio e si verifica con livelli passati a mano; il primo è
 * configurazione, non ha niente da asserire e non deve poter influenzare un test. Nei test il
 * modulo `mode` si compone senza `ScheduleModule`, quindi questa classe resta inerte.
 *
 * **Ogni cinque minuti**, e non ogni minuto come le prenotazioni. La differenza è nel costo di un
 * ritardo: una prenotazione attivata con un minuto di ritardo sposta l'arrivo di un veicolo, mentre
 * una strategia commutata cinque minuti dopo cambia il criterio con cui si scelgono i veicoli per
 * le richieste successive — e il traffico urbano non passa da scorrevole a congestionato in un
 * minuto. Leggerlo più spesso interrogherebbe il fornitore senza cambiare nessuna decisione, e da
 * M7 quel fornitore è una chiamata di rete a pagamento.
 */
@Injectable()
export class TrafficSchedule {
  private readonly logger = new Logger(TrafficSchedule.name);

  constructor(private readonly monitor: TrafficMonitorPort) {}

  @Cron(CronExpression.EVERY_5_MINUTES)
  async readTrafficLevel(): Promise<void> {
    try {
      await this.monitor.runOnce();
    } catch (error) {
      // Un'esecuzione periodica non ha nessuno a cui riferire l'errore: se lo lasciasse uscire
      // diventerebbe un rifiuto non gestito e fermerebbe il processo. Si registra e si riprova al
      // giro successivo, con la strategia attiva che resta quella che era — che è il
      // comportamento giusto quando non si sa più che traffico ci sia.
      this.logger.error('La lettura del livello di traffico è fallita.', error);
    }
  }
}
