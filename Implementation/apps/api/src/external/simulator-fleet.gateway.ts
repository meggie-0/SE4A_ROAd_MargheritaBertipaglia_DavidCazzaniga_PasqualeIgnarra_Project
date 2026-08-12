import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { FleetSimulator } from '@road/simulator';

import { ClockPort } from '../platform/clock.port';

import type { RouteRequest, VehicleTelemetry } from './external-services.port';
import { readSimulatorSettings } from './external.config';
import { FleetSimulationPort } from './fleet-simulation.port';
import type { RouteLeg } from './route-leg';

/**
 * L'adapter della **flotta**: il simulatore di `@road/simulator`, visto dalla porta.
 *
 * Il DD §2.2 elenca la flotta di robotaxi fra i sistemi esterni, insieme al servizio di mappe e
 * alla sorgente di domanda. In questo prototipo i veicoli non esistono, quindi il fornitore è un
 * simulatore — ma è un fornitore a tutti gli effetti: sta dietro la porta, riceve comandi di rotta
 * e pubblica telemetria, e il giorno in cui ci fossero veicoli veri sarebbe questa classe a
 * cambiare, da sola (NFR8).
 *
 * **Questa classe è l'unico punto dell'API che importa `@road/simulator`**, e
 * `.dependency-cruiser.cjs` lo verifica: se un manager di dominio potesse importarlo, saprebbe che
 * la flotta è simulata — cioè saprebbe una cosa che in una consegna con veicoli veri sarebbe falsa.
 *
 * **Il tempo del simulatore non è quello del sistema** (CLAUDE.md Regola 3). Il mondo simulato
 * avanza solo quando qualcuno chiama `tick()`: in esecuzione normale lo fa un `@Cron`
 * (`simulator.schedule.ts`), sotto test lo fanno i test, un tick alla volta. Le marche temporali
 * della telemetria vengono da `ClockPort`, mai dall'orologio di sistema.
 */
@Injectable()
export class SimulatorFleetGateway extends FleetSimulationPort {
  private readonly simulator: FleetSimulator;

  constructor(
    config: ConfigService,
    private readonly clock: ClockPort,
  ) {
    super();
    this.simulator = new FleetSimulator(readSimulatorSettings(config));
  }

  /**
   * Fa percorrere al veicolo il percorso indicato, fino al punto che gli è stato **chiesto**.
   *
   * Il percorso arriva già calcolato dall'adapter delle mappe: la flotta esegue, non decide
   * l'itinerario. È la separazione che tiene i due fornitori distinti — chi sa dove passano le
   * strade e chi guida — e senza la quale il simulatore dovrebbe conoscere OSRM.
   *
   * L'ultimo punto della polyline è la destinazione **richiesta**, non quella su cui il fornitore
   * di mappe ha agganciato il percorso. OSRM restituisce una geometria che finisce sulla strada più
   * vicina, che è a qualche decina di metri dal portone del passeggero: se la telemetria annunciasse
   * *quella*, chi la legge non potrebbe più confrontarla con il punto di ritiro che ha chiesto — e
   * quel confronto è il modo in cui distingue «arrivato al ritiro» da «arrivato a destinazione».
   * Aggiungere il punto richiesto in coda costa al veicolo gli ultimi metri, che è anche ciò che
   * accadrebbe davvero.
   */
  follow(robotaxiId: string, route: RouteRequest, leg: RouteLeg): void {
    const last = leg.waypoints.at(-1);
    const waypoints =
      last !== undefined && last.lat === route.to.lat && last.lon === route.to.lon
        ? leg.waypoints
        : [...leg.waypoints, route.to];

    this.simulator.followRoute(robotaxiId, route.from, waypoints);
  }

  /** Revoca la rotta: il veicolo resta dov'è (R14, decisione D27). */
  revoke(robotaxiId: string): void {
    this.simulator.revokeRoute(robotaxiId);
  }

  /** La telemetria dei veicoli in movimento, datata con l'orologio iniettato. */
  readTelemetry(): readonly VehicleTelemetry[] {
    const observedAt = this.clock.now();
    return this.simulator.telemetry().map((reading) => ({ ...reading, observedAt }));
  }

  /**
   * Un passo del mondo simulato.
   *
   * Passa da `FleetSimulationPort`, la seconda porta del modulo, e non da quella dei servizi
   * esterni: è un comando al *simulatore*, non a un fornitore. La distinzione è quella che permette
   * di far sparire il tick insieme al simulatore il giorno in cui i veicoli fossero veri, senza che
   * nessun manager di dominio se ne accorga (decisione D64).
   */
  tick(times = 1): void {
    for (let step = 0; step < times; step += 1) this.simulator.tick();
  }

  /** Svuota il mondo simulato: nessun veicolo, nessuna rotta. */
  reset(): void {
    this.simulator.reset();
  }
}
