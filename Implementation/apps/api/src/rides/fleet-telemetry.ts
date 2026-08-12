import { Injectable, Logger } from '@nestjs/common';
import type { GeoPoint, RobotaxiState } from '@road/shared';

import { ExternalServicesPort, type VehicleTelemetry } from '../external/external-services.port';
import { FleetMonitorPort } from '../fleet/fleet-monitor.port';
import { ConcurrentTransitionError, IllegalTransitionError } from '../fleet/robotaxi.port';
import { PersistencePort, type RideRequestRecord } from '../persistence/persistence.port';
import { ClockPort } from '../platform/clock.port';

import {
  FleetTelemetryPort,
  type TelemetryCycle,
  type TelemetryProgress,
  type TelemetryStep,
} from './fleet-telemetry.port';
import { RideLifecyclePort } from './ride-lifecycle.port';
import { RideNotInProgressError } from './ride-lifecycle.port';

/**
 * Chi guarda la flotta e fa avanzare le corse (M7).
 *
 * Un giro fa tre cose, in quest'ordine: legge la telemetria, consegna le posizioni a `fleet` — che
 * è l'unico a poter scrivere la riga del veicolo (decisione D28) — e poi, per ogni corsa in corso,
 * decide se qualcosa è successo.
 *
 * **Questa classe non contiene la macchina a stati, e la differenza è netta.** Ciò che decide qui è
 * *quando* provare un passo, e lo decide da due fatti osservabili: in che stato è il veicolo adesso
 * e cosa dice la telemetria. Se il passo sia ammesso lo decide la classe di stato, che può
 * rifiutarlo — ed è quello che rende il codice qui sotto sicuro invece che ottimista. È il verso
 * che la decisione D37 fissa: **chi osserva il veicolo dice quando, la classe di stato decide se**.
 * Un `switch` che *eseguisse* le transizioni sarebbe la macchina scritta due volte (CLAUDE.md
 * Regola 2); questo sceglie quale operazione della porta chiamare, che è un'altra cosa.
 *
 * **Ogni giro riparte dallo stato corrente.** Non c'è memoria fra un giro e l'altro: nessun campo,
 * nessuna tabella di avanzamento. È ciò che rende il ciclo tollerante a un giro perso, a un comando
 * di rotta non arrivato e a una transizione rifiutata — la volta dopo si guarda dov'è il veicolo e
 * si ricomincia da lì.
 */
@Injectable()
export class FleetTelemetry extends FleetTelemetryPort {
  private readonly logger = new Logger(FleetTelemetry.name);

  constructor(
    private readonly persistence: PersistencePort,
    private readonly fleet: FleetMonitorPort,
    private readonly external: ExternalServicesPort,
    private readonly lifecycle: RideLifecyclePort,
    private readonly clock: ClockPort,
  ) {
    super();
  }

  async runOnce(): Promise<TelemetryCycle> {
    const observedAt = this.clock.now();
    const telemetry = await this.external.readTelemetry();

    // Le posizioni per prime: valgono anche per i veicoli che non stanno servendo nessuno — uno che
    // si sta riposizionando si muove eccome, e R7 chiede all'operatore di vederlo.
    const positionsRecorded = await this.fleet.recordPositions(
      telemetry.map((reading) => ({
        robotaxiId: reading.robotaxiId,
        lat: reading.position.lat,
        lon: reading.position.lon,
        observedAt: reading.observedAt,
      })),
    );

    const readings = new Map(telemetry.map((reading) => [reading.robotaxiId, reading]));
    const fleetStatus = await this.fleet.getFleetStatus();
    const states = new Map(fleetStatus.robotaxis.map((vehicle) => [vehicle.id, vehicle]));

    const active = await this.persistence.find('ride_request', {
      where: { status: 'ACCEPTED' },
      orderBy: [{ field: 'id' }],
    });

    const advanced: TelemetryProgress[] = [];
    for (const request of active) {
      const robotaxiId = request.assignedRobotaxiId;
      if (robotaxiId === null) continue;

      const vehicle = states.get(robotaxiId);
      // Un veicolo che la flotta non conosce più: non c'è niente da far avanzare, e non è un errore
      // di questo ciclo.
      if (vehicle === undefined) continue;

      const step = await this.advance(
        request,
        robotaxiId,
        vehicle.state,
        { lat: vehicle.lat, lon: vehicle.lon },
        readings.get(robotaxiId),
      );
      if (step !== null) advanced.push({ rideRequestId: request.id, robotaxiId, step });
    }

    return { observedAt, positionsRecorded, advanced };
  }

  /**
   * Il passo che compete a questo veicolo adesso, o `null` se non è successo niente.
   *
   * I quattro rami sono le quattro transizioni della corsa, ciascuna innescata dal fatto che la
   * rende vera:
   *
   * - `ASSIGNED` — il veicolo ha una corsa e non si è ancora mosso: gli si comanda la rotta verso il
   *   punto di ritiro e lo si dichiara in avvicinamento. La rotta **prima** della transizione,
   *   perché un veicolo in `ARRIVING` senza rotta non arriverebbe mai da nessuna parte.
   * - `ARRIVING` — arriva quando la telemetria dice che ha raggiunto **il punto di ritiro**, e non
   *   un punto qualsiasi: il confronto con la destinazione comandata è ciò che impedisce di
   *   scambiare l'arrivo al ritiro con quello a destinazione.
   * - `ARRIVED` — il passeggero sale e si parte. La guardia `isPassengerOnBoard()` della Figura 2.10
   *   è l'unica che **nessun sensore risolve**: né il simulatore né una flotta vera sanno dire se
   *   qualcuno è salito. Il prototipo assume che il passeggero salga al giro successivo all'arrivo,
   *   ed è un'assunzione dichiarata (decisione D63) — in un sistema reale la risolverebbe un'azione
   *   del passeggero sull'app, che nessun requisito di ROAd prevede.
   * - `IN_RIDE` — a destinazione raggiunta la corsa si chiude e la rotta si revoca, così il veicolo
   *   torna disponibile senza portarsi dietro un percorso concluso.
   */
  private async advance(
    request: RideRequestRecord,
    robotaxiId: string,
    state: RobotaxiState,
    position: GeoPoint,
    reading: VehicleTelemetry | undefined,
  ): Promise<TelemetryStep | null> {
    const pickup = { lat: request.pickupLat, lon: request.pickupLon };
    const destination = { lat: request.destinationLat, lon: request.destinationLon };
    const from = position;

    try {
      if (state === 'ASSIGNED') {
        await this.external.commandRoute(robotaxiId, { from, to: pickup });
        await this.lifecycle.startPickupNavigation(request.id);
        return 'PICKUP_NAVIGATION_STARTED';
      }

      if (state === 'ARRIVING') {
        if (!hasReached(reading, pickup)) return null;
        await this.lifecycle.pickupReached(request.id);
        return 'PICKUP_REACHED';
      }

      if (state === 'ARRIVED') {
        await this.lifecycle.startRide(request.id);
        await this.external.commandRoute(robotaxiId, { from, to: destination });
        return 'RIDE_STARTED';
      }

      if (state === 'IN_RIDE') {
        if (!hasReached(reading, destination)) {
          // La corsa è cominciata ma il veicolo non sta andando a destinazione: il comando di rotta
          // del passo precedente non è arrivato. Si ripete, invece di lasciare fermo un passeggero
          // a bordo. Se invece sta viaggiando, il comando ripetuto ricalcola la stessa rotta dalla
          // posizione corrente, che è un'operazione innocua.
          if (reading === undefined || !isSamePoint(reading.destination, destination)) {
            await this.external.commandRoute(robotaxiId, { from, to: destination });
          }
          return null;
        }

        await this.lifecycle.completeRide(request.id);
        // Il veicolo è tornato disponibile: senza revoca continuerebbe a dichiararsi «arrivato»
        // alla destinazione di una corsa che non esiste più.
        await this.external.commandRoute(robotaxiId, null);
        return 'RIDE_COMPLETED';
      }

      return null;
    } catch (error) {
      if (
        error instanceof IllegalTransitionError ||
        error instanceof ConcurrentTransitionError ||
        error instanceof RideNotInProgressError
      ) {
        // Una corsa sola non avanza: il veicolo è cambiato fra la lettura e la scrittura, oppure il
        // passo è arrivato fuori tempo. Fermare il giro lascerebbe indietro tutte le altre, e il
        // giro successivo ripartirà da dove il veicolo si trova davvero.
        this.logger.log(
          `La corsa ${request.id} non è avanzata da ${state}: ${describe(error)}. Si riprova al giro successivo.`,
        );
        return null;
      }
      throw error;
    }
  }
}

/**
 * Vero quando la telemetria dice che il veicolo ha raggiunto **quel** punto.
 *
 * Sono due condizioni e servono entrambe: che sia arrivato, e che il punto a cui è arrivato sia
 * quello che ci interessa. Senza la seconda, un veicolo fermo al punto di ritiro sembrerebbe arrivato
 * a destinazione, e la corsa si chiuderebbe prima di cominciare.
 */
function hasReached(reading: VehicleTelemetry | undefined, target: GeoPoint): boolean {
  return reading !== undefined && reading.hasArrived && isSamePoint(reading.destination, target);
}

/**
 * Confronto **esatto** fra coordinate, e non a meno di una tolleranza.
 *
 * Non è fragile: il punto che la telemetria riporta è quello che ROAd ha comandato — l'adapter della
 * flotta chiude la polyline sulla destinazione richiesta, non su quella agganciata alla strada dal
 * fornitore di mappe — e ha attraversato il sistema come `double precision`, che non arrotonda. Una
 * tolleranza in metri sarebbe una soglia fisica dentro un manager di dominio, cioè la cosa che la
 * telemetria esiste per evitare.
 */
function isSamePoint(left: GeoPoint | null, right: GeoPoint): boolean {
  return left !== null && left.lat === right.lat && left.lon === right.lon;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
