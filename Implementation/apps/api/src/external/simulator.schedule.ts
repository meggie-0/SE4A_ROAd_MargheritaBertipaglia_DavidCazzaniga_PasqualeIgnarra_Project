import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';

import { FleetSimulationPort } from './fleet-simulation.port';

/**
 * Lo scheduler che in esecuzione normale fa avanzare il mondo simulato.
 *
 * MILESTONES.md §M7 lo dice in una riga: il simulatore «sotto test avanza solo su `tick()`
 * esplicito; in esecuzione normale ha un ciclo proprio». Questo file *è* quel ciclo, ed è
 * deliberatamente l'unica cosa che contiene: il timer non sta nel dominio né dentro il simulatore
 * (CLAUDE.md Regola 3), sta in una dichiarazione che `ScheduleModule` — importato dal solo
 * `AppModule` — trasforma in esecuzioni. Un test che compone `external` non lo importa, quindi
 * nessun veicolo si muove finché un test non lo chiede.
 *
 * **Ogni dieci secondi**, con un tick che vale un minuto di mondo simulato: la flotta si muove sei
 * volte più in fretta del tempo reale. È la scelta che rende guardabile una demo — un veicolo
 * attraversa Milano in un paio di minuti invece che in mezz'ora — senza rendere il sistema
 * irrealistico, perché ciò che cambia è la velocità del mondo, non il rapporto fra le sue parti.
 */
@Injectable()
export class SimulatorSchedule {
  private readonly logger = new Logger(SimulatorSchedule.name);

  constructor(private readonly simulation: FleetSimulationPort) {}

  @Cron(CronExpression.EVERY_10_SECONDS)
  advanceSimulatedFleet(): void {
    try {
      this.simulation.tick();
    } catch (error) {
      // Un'esecuzione periodica non ha nessuno a cui riferire l'errore: se lo lasciasse uscire
      // diventerebbe un rifiuto non gestito e fermerebbe il processo. La flotta resta dov'è, che è
      // lo stato di partenza e non uno stato incoerente.
      this.logger.error('Il passo del simulatore di flotta è fallito.', error);
    }
  }
}
