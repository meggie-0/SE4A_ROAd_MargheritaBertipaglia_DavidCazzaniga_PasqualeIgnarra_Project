import { Injectable } from '@nestjs/common';
import type { GeoPoint, TrafficLevel } from '@road/shared';

import { ExternalServicesPort, type EtaEstimate, type EtaOrigin } from './external-services.port';
import { HourlyTrafficGateway } from './hourly-traffic.gateway';
import { LinearEtaGateway } from './linear-eta.gateway';

/**
 * L'`ExternalServicesGateway` del DD §2.2: **un facade, un adapter per fornitore**.
 *
 * Fino a M5 la porta aveva una sola operazione e una sola classe la realizzava, quindi facade e
 * adapter coincidevano. Con `getTraffic()` i fornitori diventano due — le mappe e la sorgente di
 * traffico — e tenerli nella stessa classe avrebbe significato che l'adapter delle mappe risponde
 * anche di quanto traffico c'è, cioè esattamente la confusione che NFR8 vieta nella formulazione
 * del DD §4.3.
 *
 * Questa classe non contiene logica: sceglie l'adapter e delega. È il punto in cui M7 sostituirà
 * `LinearEtaGateway` con quello di OSRM e `HourlyTrafficGateway` con la sorgente reale, senza che
 * `allocation`, `rides` o `mode` cambino di una riga — perché nessuno dei tre conosce altro che
 * `ExternalServicesPort`.
 */
@Injectable()
export class ExternalServicesGateway extends ExternalServicesPort {
  constructor(
    private readonly eta: LinearEtaGateway,
    private readonly traffic: HourlyTrafficGateway,
  ) {
    super();
  }

  getETA(origins: readonly EtaOrigin[], destination: GeoPoint): Promise<readonly EtaEstimate[]> {
    return this.eta.getETA(origins, destination);
  }

  getTraffic(): Promise<TrafficLevel> {
    return this.traffic.getTraffic();
  }
}
