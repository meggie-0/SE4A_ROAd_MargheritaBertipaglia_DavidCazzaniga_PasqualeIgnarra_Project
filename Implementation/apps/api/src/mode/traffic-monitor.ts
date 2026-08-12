import { Injectable } from '@nestjs/common';

import { ExternalServicesPort } from '../external/external-services.port';

import { ModePort } from './mode.port';
import { TrafficMonitorPort } from './traffic-monitor.port';

/**
 * Il `TrafficMonitor` del DD §2.2.1: legge il traffico e lo passa al `ModeController` (Figura 2.6).
 *
 * Due righe di corpo, e non è un segno che la classe sia superflua. È l'unico punto in cui il
 * sistema *va a chiedere* qualcosa a una sorgente esterna di propria iniziativa invece che per
 * servire una richiesta, ed è quindi l'unico punto in cui il confine fra «il mondo cambia» e «ROAd
 * se ne accorge» è attraversato. Tenerlo separato dal `ModeController` fa sì che la regola di
 * isteresi si possa provare passandole i livelli a mano — come fa il cancello di M6 con la sequenza
 * `Low→Medium→High→Medium→Low` — senza dover far finta di essere un fornitore di traffico.
 *
 * Nessun timer qui dentro (CLAUDE.md Regola 3): `runOnce()` è pubblico, in produzione lo chiama un
 * `@Cron` che sta in un altro file, e nei test lo chiamano i test attraverso `TrafficMonitorPort`.
 */
@Injectable()
export class TrafficMonitor extends TrafficMonitorPort {
  constructor(
    private readonly external: ExternalServicesPort,
    private readonly mode: ModePort,
  ) {
    super();
  }

  async runOnce(): Promise<void> {
    // Nessun `try` attorno alla lettura: se il fornitore non risponde, l'errore esce e lo registra
    // lo scheduler, che è l'unico che può decidere che cosa farne — cioè riprovare al giro dopo.
    // Assorbirlo qui significherebbe chiamare `onTrafficLevel()` con un livello inventato.
    await this.mode.onTrafficLevel(await this.external.getTraffic());
  }
}
