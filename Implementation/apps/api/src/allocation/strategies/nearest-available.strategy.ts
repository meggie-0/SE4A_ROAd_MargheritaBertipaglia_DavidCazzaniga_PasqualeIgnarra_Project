import { Injectable } from '@nestjs/common';
import { haversineKm, type StrategyName } from '@road/shared';

import type { RobotaxiSnapshot } from '../../fleet/robotaxi.port';
import { AllocationStrategy, bestScored, type AllocationRequest } from '../allocation-strategy';

/**
 * «Il veicolo più vicino» (RASD §2.4, DD §2.3.1): la strategia di default del sistema.
 *
 * La metrica è la **distanza haversine** fra il punto di prelievo e la posizione del veicolo,
 * calcolata dalla funzione condivisa di `packages/shared` — la stessa con cui si decide a quale
 * zona appartiene un punto (decisione D10). Averne una sola implementazione conta: due formule di
 * distanza nello stesso sistema divergono sui bordi, e i bordi sono esattamente dove i test
 * guardano.
 *
 * Non chiede nulla all'esterno, e per questo resta la scelta giusta a traffico basso: è
 * l'informazione che il sistema possiede già, quindi non introduce né latenza né una dipendenza
 * che può cadere.
 */
@Injectable()
export class NearestAvailableStrategy extends AllocationStrategy {
  readonly name: StrategyName = 'NEAREST_AVAILABLE';

  selectRobotaxi(
    request: AllocationRequest,
    candidates: readonly RobotaxiSnapshot[],
  ): Promise<RobotaxiSnapshot | null> {
    // `RobotaxiSnapshot` porta `lat` e `lon`, cioè è già un `GeoPoint`: nessuna conversione, e
    // nessun punto in cui le due coordinate possano essere scambiate.
    const scored = candidates.map((robotaxi) => ({
      robotaxi,
      score: haversineKm(request.pickup, robotaxi),
    }));

    return Promise.resolve(bestScored(scored));
  }
}
