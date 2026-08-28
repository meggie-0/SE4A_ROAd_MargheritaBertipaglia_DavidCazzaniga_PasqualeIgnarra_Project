import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';

import { AdvanceBookingActivatorPort } from './advance-booking.port';

/**
 * Lo **scheduler** che in produzione chiama `runOnce()` (DD §2.2.1, «Periodic work»; decisione D16).
 *
 * È un file a sé, e minuscolo, di proposito: separa *quando* si esegue da *cosa* si esegue. Il
 * secondo è dominio ed è verificabile con un orologio finto; il primo è configurazione, non ha
 * niente da asserire e non deve poter influenzare un test. Un `@Cron` messo direttamente su
 * `AdvanceBookingActivator` avrebbe legato le due cose e fatto partire un timer in ogni
 * composizione del modulo.
 *
 * Il timer non è nel dominio (CLAUDE.md Regola 3): qui non c'è `setInterval`, c'è una dichiarazione
 * che `ScheduleModule` — importato dal solo `AppModule` — trasforma in esecuzioni. Nei test il
 * modulo `rides` si compone senza `ScheduleModule`, quindi questa classe resta inerte e le
 * prenotazioni si attivano solo quando un test lo chiede.
 *
 * **Ogni minuto** è la frequenza giusta rispetto all'anticipo di attivazione, che di default è di
 * 15 minuti: l'attivazione avviene entro un minuto dalla sua scadenza, e un ritardo di quell'ordine
 * è invisibile su una finestra di quindici. Controllare più spesso interrogherebbe il database
 * senza cambiare ciò che il passeggero vede.
 */
@Injectable()
export class AdvanceBookingSchedule {
  private readonly logger = new Logger(AdvanceBookingSchedule.name);

  constructor(private readonly activator: AdvanceBookingActivatorPort) {}

  /**
   * La cadenza si accorcia da configurazione (decisione D76), con il minuto come default. Va tenuta
   * coerente con `RESERVATION_ACTIVATION_LEAD_MINUTES`: controllare ogni minuto un anticipo di
   * trenta secondi significherebbe attivare in ritardo quanto l'anticipo stesso.
   *
   * `process.env` e non `ConfigService`, perché `@Cron` valuta l'argomento all'import.
   */
  @Cron(process.env.ADVANCE_BOOKING_CRON ?? CronExpression.EVERY_MINUTE)
  async activateDueBookings(): Promise<void> {
    try {
      await this.activator.runOnce();
    } catch (error) {
      // Un'esecuzione periodica non ha nessuno a cui riferire l'errore: se lo lasciasse uscire,
      // diventerebbe un rifiuto non gestito e fermerebbe il processo. Si registra e si riprova al
      // minuto successivo, che è ciò che rende l'attivazione tollerante a un guasto transitorio.
      this.logger.error("L'attivazione delle prenotazioni è fallita.", error);
    }
  }
}
