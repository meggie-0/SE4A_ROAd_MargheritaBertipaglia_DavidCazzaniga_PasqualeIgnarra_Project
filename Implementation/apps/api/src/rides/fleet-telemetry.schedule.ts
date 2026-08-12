import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';

import { FleetTelemetryPort } from './fleet-telemetry.port';

/**
 * Lo scheduler che in produzione legge la telemetria (DD §2.2.1, «Periodic work»; decisione D16).
 *
 * Stessa forma di `AdvanceBookingSchedule` e `TrafficSchedule`, e per le stesse ragioni: separa
 * *quando* si esegue da *cosa* si esegue, e non fa partire nessun timer nei test, che compongono
 * `rides` senza `ScheduleModule`.
 *
 * **Ogni dieci secondi, come il passo del simulatore.** Le due frequenze sono legate: leggere più
 * spesso di quanto il mondo si muova produrrebbe giri identici, leggere più di rado farebbe arrivare
 * al passeggero la notifica di un arrivo già avvenuto da un pezzo — e NFR2 chiede aggiornamenti in
 * tempo reale. Con una flotta vera la sorgente dei tick sarebbe la flotta stessa, e resterebbe da
 * scegliere solo questa.
 */
@Injectable()
export class FleetTelemetrySchedule {
  private readonly logger = new Logger(FleetTelemetrySchedule.name);

  constructor(private readonly telemetry: FleetTelemetryPort) {}

  @Cron(CronExpression.EVERY_10_SECONDS)
  async readFleetTelemetry(): Promise<void> {
    try {
      await this.telemetry.runOnce();
    } catch (error) {
      // Un'esecuzione periodica non ha nessuno a cui riferire l'errore: se lo lasciasse uscire
      // diventerebbe un rifiuto non gestito e fermerebbe il processo. Le corse restano dove sono e
      // il giro successivo riparte dallo stato corrente, che è ciò che rende il ciclo riprendibile.
      this.logger.error('La lettura della telemetria di flotta è fallita.', error);
    }
  }
}
