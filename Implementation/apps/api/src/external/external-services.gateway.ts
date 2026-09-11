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
import { TrafficSource } from './traffic-source';
import { OsrmRouteGateway } from './osrm-route.gateway';
import { SimulatorFleetGateway } from './simulator-fleet.gateway';
import { TrafficSlowdown } from './traffic-slowdown';

/**
 * L'`ExternalServicesGateway` del DD §2.2: **un facade, un adapter per fornitore**.
 *
 * I fornitori sono tre, e ciascuno ha la sua classe: le mappe (`OsrmRouteGateway`, con la stima
 * lineare come via d'uscita), la sorgente di traffico (`TrafficSource`, in due varianti dalla D76) e la flotta
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
    private readonly traffic: TrafficSource,
    private readonly fleet: SimulatorFleetGateway,
    private readonly slowdown: TrafficSlowdown,
  ) {
    super();
  }

  /**
   * Il tempo delle mappe, allungato dal traffico **lungo il tragitto** (decisione D79).
   *
   * Il fattore si applica qui e non dentro un adapter, ed è il punto: vale per **qualunque**
   * fornitore di mappe, la stima in linea d'aria come OSRM, perché il traffico è un fatto del mondo e
   * non una proprietà di chi calcola i percorsi. Senza fattori configurati è esattamente uno.
   */
  async getETA(
    origins: readonly EtaOrigin[],
    destination: GeoPoint,
  ): Promise<readonly EtaEstimate[]> {
    const estimates = await this.maps.getETA(origins, destination);
    const positions = new Map(origins.map((origin) => [origin.id, origin.position]));

    return estimates.map((estimate) => {
      const from = positions.get(estimate.id);
      if (from === undefined) return estimate;
      return {
        id: estimate.id,
        etaMinutes: estimate.etaMinutes * this.slowdown.routeFactor(from, destination),
      };
    });
  }

  getTraffic(): Promise<TrafficLevel> {
    return this.traffic.getTraffic();
  }

  async commandRoute(robotaxiId: string, route: RouteRequest | null): Promise<RouteCommandOutcome> {
    // La revoca non chiede niente alle mappe: non c'è nessun percorso da calcolare per un veicolo
    // che non deve più andare da nessuna parte (R14, decisione D27).
    if (route === null) {
      this.fleet.revoke(robotaxiId);
      return { robotaxiId, etaMinutes: null, distanceKm: null };
    }

    const leg = await this.maps.route(route.from, route.to);
    this.fleet.follow(robotaxiId, route, leg);

    // Lo stesso fattore della stima: il tempo di attesa promesso al passeggero è quello che il
    // simulatore, rallentando il veicolo dove passa, manterrà.
    const etaMinutes = leg.durationMinutes * this.slowdown.routeFactor(route.from, route.to);
    return { robotaxiId, etaMinutes, distanceKm: leg.distanceKm };
  }

  readTelemetry(): Promise<readonly VehicleTelemetry[]> {
    return Promise.resolve(this.fleet.readTelemetry());
  }
}
