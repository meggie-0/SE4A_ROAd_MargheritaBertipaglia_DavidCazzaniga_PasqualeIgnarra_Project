import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { FLEET_POSITION_REFRESH_MS } from '@road/shared';

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
 * **Ogni mezzo secondo** (`FLEET_POSITION_REFRESH_MS`), con un tick che vale tre secondi di mondo
 * simulato: la flotta continua a muoversi sei volte più in fretta del tempo reale, come quando il
 * passo era di dieci secondi per un minuto di mondo. Ciò che è cambiato non è la velocità ma la
 * **grana**: la stessa strada, percorsa in venti passi invece che in uno, è un veicolo che scorre
 * sulla mappa invece di saltare da un punto all'altro.
 *
 * `@Interval` e non `@Cron`, perché un'espressione cron non scende sotto il secondo. È lo stesso
 * meccanismo — una dichiarazione che `ScheduleModule` trasforma in esecuzioni, e che senza di esso
 * resta inerte — quindi nei test nulla si muove finché un test non lo chiede (CLAUDE.md Regola 3).
 */
@Injectable()
export class SimulatorSchedule {
  private readonly logger = new Logger(SimulatorSchedule.name);

  constructor(private readonly simulation: FleetSimulationPort) {}

  @Interval(FLEET_POSITION_REFRESH_MS)
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
