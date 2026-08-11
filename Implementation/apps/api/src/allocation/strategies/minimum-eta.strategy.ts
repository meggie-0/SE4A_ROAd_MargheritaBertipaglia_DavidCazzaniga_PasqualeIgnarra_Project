import { Injectable } from '@nestjs/common';
import type { StrategyName } from '@road/shared';

import { ExternalServicesPort, type EtaOrigin } from '../../external/external-services.port';
import type { RobotaxiSnapshot } from '../../fleet/robotaxi.port';
import { AllocationStrategy, bestScored, type AllocationRequest } from '../allocation-strategy';

/**
 * «Il veicolo che arriva prima» (RASD §2.4, DD §2.3.1): la strategia che il modo Auto attiva
 * quando il traffico è alto (R12, M6).
 *
 * La metrica è il **tempo stimato di arrivo al punto di prelievo**, chiesto a
 * `ExternalServicesPort` in una sola chiamata per tutti i candidati — la `getETA(candidates,
 * pickup)` della Figura 2.5. Non è la stessa cosa della distanza: due veicoli equidistanti possono
 * avere attese molto diverse se uno dei due è dietro una congestione, ed è precisamente questa
 * differenza a rendere utile il cambio di strategia. Con l'adapter di M3, che stima linearmente, i
 * due ordinamenti coincidono; con OSRM (M7) non più, e nessuna riga di questa classe cambierà.
 *
 * **Un candidato senza ETA non è idoneo.** Il fornitore può non saper rispondere per un'origine —
 * fuori area, non raggiungibile —, e in quel caso non compare nel suo esito. Sceglierlo lo stesso
 * vorrebbe dire assegnare un veicolo per il quale nessuno ha calcolato un tempo di attesa, cioè
 * promettere al passeggero un ETA inventato. Se nessun candidato ha un ETA, non c'è assegnazione:
 * è il caso «nessun candidato idoneo» del cancello di M3.
 */
@Injectable()
export class MinimumEtaStrategy extends AllocationStrategy {
  readonly name: StrategyName = 'MINIMUM_ETA';

  constructor(private readonly external: ExternalServicesPort) {
    super();
  }

  async selectRobotaxi(
    request: AllocationRequest,
    candidates: readonly RobotaxiSnapshot[],
  ): Promise<RobotaxiSnapshot | null> {
    // Nessun candidato, nessuna domanda da fare a un servizio esterno: la chiamata costerebbe una
    // latenza di rete (da M7 in poi) per una risposta che si conosce già.
    if (candidates.length === 0) return null;

    const origins: EtaOrigin[] = candidates.map((robotaxi) => ({
      id: robotaxi.id,
      position: { lat: robotaxi.lat, lon: robotaxi.lon },
    }));

    const estimates = await this.external.getETA(origins, request.pickup);
    const minutesById = new Map(estimates.map((estimate) => [estimate.id, estimate.etaMinutes]));

    // `flatMap` e non `filter` seguito da `map`: chi non ha un ETA sparisce e chi ce l'ha porta con
    // sé il valore già letto, senza una seconda interrogazione della mappa da cui potrebbe uscire
    // `undefined` e quindi senza una conversione di tipo da giustificare.
    const scored = candidates.flatMap((robotaxi) => {
      const etaMinutes = minutesById.get(robotaxi.id);
      return etaMinutes === undefined ? [] : [{ robotaxi, score: etaMinutes }];
    });

    return bestScored(scored);
  }
}
