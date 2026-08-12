import { Injectable } from '@nestjs/common';
import type { GeoPoint, TrafficLevel } from '@road/shared';

import {
  ExternalServicesPort,
  type EtaEstimate,
  type RouteCommandOutcome,
  type RouteRequest,
  type EtaOrigin,
  type VehicleTelemetry,
} from './external-services.port';
import { HourlyTrafficGateway } from './hourly-traffic.gateway';
import { OsrmRouteGateway } from './osrm-route.gateway';
import { SimulatorFleetGateway } from './simulator-fleet.gateway';

/**
 * L'`ExternalServicesGateway` del DD §2.2: **un facade, un adapter per fornitore**.
 *
 * I fornitori sono tre, e ciascuno ha la sua classe: le mappe (`OsrmRouteGateway`, con la stima
 * lineare come via d'uscita), la sorgente di traffico (`HourlyTrafficGateway`) e la flotta
 * (`SimulatorFleetGateway`). Tenerli in una classe sola significherebbe che l'adapter delle mappe
 * risponde anche di quanto traffico c'è e di dove si trovano i veicoli, cioè esattamente la
 * confusione con cui il DD §4.3 falsifica NFR8.
 *
 * Questa classe **sceglie l'adapter e delega**, con una sola eccezione che vale la pena leggere:
 * `commandRoute()` tocca due fornitori invece di uno, perché comandare una rotta è chiedere alle
 * mappe *dove si passa* e alla flotta *di passarci*. La Figura 2.7 del DD disegna un messaggio
 * solo, e la composizione dei due fornitori è precisamente ciò che un facade esiste per nascondere:
 * spostarla fuori vorrebbe dire far conoscere al `RebalancingManager` due fornitori invece di
 * nessuno.
 */
@Injectable()
export class ExternalServicesGateway extends ExternalServicesPort {
  constructor(
    private readonly maps: OsrmRouteGateway,
    private readonly traffic: HourlyTrafficGateway,
    private readonly fleet: SimulatorFleetGateway,
  ) {
    super();
  }

  getETA(origins: readonly EtaOrigin[], destination: GeoPoint): Promise<readonly EtaEstimate[]> {
    return this.maps.getETA(origins, destination);
  }

  getTraffic(): Promise<TrafficLevel> {
    return this.traffic.getTraffic();
  }

  async commandRoute(robotaxiId: string, route: RouteRequest | null): Promise<RouteCommandOutcome> {
    // La revoca non chiede niente alle mappe: non c'è nessun percorso da calcolare per un veicolo
    // che non deve più andare da nessuna parte (R14, decisione D27).
    if (route === null) {
      this.fleet.revoke(robotaxiId);
      return { robotaxiId, accepted: true, etaMinutes: null, distanceKm: null };
    }

    const leg = await this.maps.route(route.from, route.to);
    this.fleet.follow(robotaxiId, route, leg);

    return {
      robotaxiId,
      accepted: true,
      etaMinutes: leg.durationMinutes,
      distanceKm: leg.distanceKm,
    };
  }

  readTelemetry(): Promise<readonly VehicleTelemetry[]> {
    return Promise.resolve(this.fleet.readTelemetry());
  }
}
