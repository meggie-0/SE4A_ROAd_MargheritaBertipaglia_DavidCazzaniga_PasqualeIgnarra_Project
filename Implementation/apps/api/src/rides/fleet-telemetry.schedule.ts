import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { FLEET_POSITION_REFRESH_MS } from '@road/shared';

import { FleetTelemetryPort } from './fleet-telemetry.port';

/**
 * Lo scheduler che in produzione legge la telemetria (DD §2.2.1, «Periodic work»; decisione D16).
 *
 * Stessa forma di `AdvanceBookingSchedule` e `TrafficSchedule`, e per le stesse ragioni: separa
 * *quando* si esegue da *cosa* si esegue, e non fa partire nessun timer nei test, che compongono
 * `rides` senza `ScheduleModule`.
 *
 * **Alla stessa cadenza del passo del simulatore**, che è la ragione per cui il numero è uno solo e
 * sta in `@road/shared`: le due frequenze sono legate, non uguali per caso. Leggere più spesso di
 * quanto il mondo si muova produrrebbe giri identici; leggere più di rado farebbe arrivare al
 * passeggero la notifica di un arrivo già avvenuto da un pezzo — e NFR2 chiede aggiornamenti in
 * tempo reale. Con una flotta vera la sorgente dei tick sarebbe la flotta stessa, e resterebbe da
 * scegliere solo questa.
 *
 * `@Interval` e non `@Cron` per la stessa ragione dello scheduler del simulatore: mezzo secondo non
 * è esprimibile in cron. Resta una dichiarazione inerte senza `ScheduleModule`, quindi i test
 * continuano a far avanzare le corse chiamando `runOnce()` (CLAUDE.md Regola 3).
 */
@Injectable()
export class FleetTelemetrySchedule {
  private readonly logger = new Logger(FleetTelemetrySchedule.name);

  /**
   * Vero mentre un giro è in corso.
   *
   * Un giro legge la flotta e le corse attive dal database, quindi può durare più di mezzo secondo
   * su una macchina carica — e a quel punto ne partirebbe un secondo sopra il primo. Non
   * corromperebbe nulla, perché ogni transizione è protetta dal controllo di concorrenza di `fleet`
   * e il ciclo riparte comunque dallo stato corrente; produrrebbe però una fila di
   * `ConcurrentTransitionError` nel registro e un carico che cresce da solo proprio quando la
   * macchina è già in difficoltà. Con dieci secondi fra un giro e l'altro il caso era teorico; con
   * mezzo secondo non lo è più.
   *
   * Saltare un giro non costa niente: non c'è memoria fra un giro e l'altro (`FleetTelemetry`), e
   * quello successivo guarda dove i veicoli sono davvero.
   */
  private running = false;

  constructor(private readonly telemetry: FleetTelemetryPort) {}

  @Interval(FLEET_POSITION_REFRESH_MS)
  async readFleetTelemetry(): Promise<void> {
    if (this.running) return;
    this.running = true;

    try {
      await this.telemetry.runOnce();
    } catch (error) {
      // Un'esecuzione periodica non ha nessuno a cui riferire l'errore: se lo lasciasse uscire
      // diventerebbe un rifiuto non gestito e fermerebbe il processo. Le corse restano dove sono e
      // il giro successivo riparte dallo stato corrente, che è ciò che rende il ciclo riprendibile.
      this.logger.error('La lettura della telemetria di flotta è fallita.', error);
    } finally {
      this.running = false;
    }
  }
}
