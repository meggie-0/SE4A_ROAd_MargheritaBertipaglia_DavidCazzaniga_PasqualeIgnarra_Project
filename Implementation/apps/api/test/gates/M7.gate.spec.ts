import { createServer, type Server } from 'node:http';
import { AddressInfo } from 'node:net';

import { haversineKm } from '@road/shared';

import type { ExternalServicesPort } from '../../src/external/external-services.port';
import type { FleetSimulationPort } from '../../src/external/fleet-simulation.port';
import type { FleetMonitorPort } from '../../src/fleet/fleet-monitor.port';
import type { PersistencePort } from '../../src/persistence/persistence.port';
import type { RebalancingPort } from '../../src/rebalancing/rebalancing.port';
import type { FleetTelemetryPort } from '../../src/rides/fleet-telemetry.port';
import type { RideRequestPort } from '../../src/rides/rides.port';
import { startApiHarness, type ApiHarness } from '../support/postgres';

/**
 * Cancello di M7 (MILESTONES.md §M7, HARNESS.md §6).
 *
 * Criterio di completamento, tradotto in test:
 *   - **configurando gli adapter reali il sistema funziona senza mock**: qui non è sostituito
 *     nessun componente di ROAd — né il gateway dei servizi esterni, né la flotta —, e la sola cosa
 *     finta è il *fornitore*, un server che parla il protocollo di OSRM (NFR8);
 *   - **con OSRM irraggiungibile il fallback produce comunque un ETA e nessuna richiesta va persa**:
 *     il server viene spento davvero, non simulato spento;
 *   - **il simulatore porta un veicolo da `assigned` ad `arrived` in un numero deterministico di
 *     tick**, contato prima di eseguirlo.
 *
 * Il quarto pezzo di M7 — la seconda metà di R14, l'annullamento con il veicolo in avvicinamento —
 * sta nel cancello di M4, dove vive il resto del requisito, e nella tabella di transizioni del
 * cancello di M2, che adesso ha tredici righe legali invece di undici.
 *
 * Gira su **Postgres vero** e richiede Docker in esecuzione: ciò che dimostra è una catena che
 * attraversa `external`, `fleet`, `rides` e `rebalancing` fino alle colonne, e su un doppio in
 * memoria verificherebbe il doppio.
 */

const NOW = new Date('2026-05-04T09:00:00.000Z');
const HOOK_TIMEOUT_MS = 180_000;

const DUOMO = { id: 'duomo', name: 'Duomo / Centro', lat: 45.4642, lon: 9.19 };
const SAN_SIRO = { id: 'san-siro', name: 'San Siro', lat: 45.4781, lon: 9.124 };
const CENTRALE = { lat: 45.4863, lon: 9.205 };

/**
 * I parametri del simulatore per questo cancello: **un chilometro esatto per tick**.
 *
 * 20 km/h per 3 minuti fa 1 km, quindi «quanti tick servono» è una divisione che il test sa fare
 * prima di eseguire, ed è ciò che rende il conteggio deterministico invece che osservato.
 */
const KM_PER_TICK = 1;

/** Quanto dura, secondo il fornitore finto, ogni tragitto che gli si chiede. */
const ROUTE_SECONDS = 600;

let harness: ApiHarness;
let persistence: PersistencePort;
let rides: RideRequestPort;
let fleet: FleetMonitorPort;
let external: ExternalServicesPort;
let simulation: FleetSimulationPort;
let telemetry: FleetTelemetryPort;
let rebalancing: RebalancingPort;

/** Le richieste arrivate al fornitore: dicono se la rete è stata toccata, e per cosa. */
let osrmRequests: string[] = [];
let osrm: Server;
let osrmPort: number;
const PASSENGER = {
  email: 'giulia.rossi@example.com',
  password: 'password-di-prova',
  name: 'Giulia',
  surname: 'Rossi',
  phoneNumber: null,
  role: 'PASSENGER' as const,
};
let passengerId: string;

function startOsrm(port = 0): Promise<void> {
  osrm = createServer((request, response) => {
    const url = request.url ?? '';
    osrmRequests.push(url);

    const body = url.startsWith('/table')
      ? { code: 'Ok', durations: [[ROUTE_SECONDS]] }
      : routeBetween(url);

    response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(body));
  });

  return new Promise((resolve) => {
    osrm.listen(port, '127.0.0.1', () => {
      osrmPort = (osrm.address() as AddressInfo).port;
      resolve();
    });
  });
}

/**
 * La risposta `/route` del fornitore finto: la geometria che **congiunge i due punti richiesti**.
 *
 * Li rilegge dall'URL invece di restituire una geometria fissa, e non è un vezzo: è ciò che rende
 * calcolabile prima quanti tick servono per percorrerla, che è la promessa che questo cancello
 * verifica. Una geometria inventata renderebbe il conteggio un'osservazione invece che una
 * previsione. Il formato è quello di OSRM — `lon,lat`, coordinate separate da `;` — quindi un
 * errore nell'ordine delle coordinate dell'adapter fallisce qui.
 */
function routeBetween(url: string): unknown {
  const path = url.slice('/route/v1/driving/'.length).split('?')[0] ?? '';
  const points = path.split(';').map((pair) => pair.split(',').map(Number));
  const distanceMeters = 1000 * geometryKm(points);

  return {
    code: 'Ok',
    routes: [
      { distance: distanceMeters, duration: ROUTE_SECONDS, geometry: { coordinates: points } },
    ],
  };
}

/** La lunghezza di una polyline `[lon, lat]`, in chilometri. */
function geometryKm(points: ReadonlyArray<readonly number[]>): number {
  let total = 0;
  for (let index = 1; index < points.length; index += 1) {
    const from = points[index - 1] as readonly number[];
    const to = points[index] as readonly number[];
    total += haversineKm(
      { lat: from[1] as number, lon: from[0] as number },
      { lat: to[1] as number, lon: to[0] as number },
    );
  }
  return total;
}

function stopOsrm(): Promise<void> {
  return new Promise((resolve) => {
    osrm.closeAllConnections();
    osrm.close(() => resolve());
  });
}

/** Un veicolo disponibile nel punto indicato. */
async function givenRobotaxi(id: string, point: { lat: number; lon: number }): Promise<void> {
  await persistence.create('robotaxi', {
    id,
    state: 'AVAILABLE',
    lat: point.lat,
    lon: point.lon,
    zoneId: DUOMO.id,
  });
}

async function stateOf(robotaxiId: string): Promise<string | undefined> {
  const [record] = await persistence.find('robotaxi', { where: { id: robotaxiId }, limit: 1 });
  return record?.state;
}

async function positionOf(robotaxiId: string): Promise<{ lat: number; lon: number }> {
  const [record] = await persistence.find('robotaxi', { where: { id: robotaxiId }, limit: 1 });
  if (record === undefined) throw new Error(`Nessun robotaxi ${robotaxiId}.`);
  return { lat: record.lat, lon: record.lon };
}

/** Quanti tick servono a coprire la distanza fra due punti, con un chilometro a tick. */
function ticksBetween(
  from: { lat: number; lon: number },
  to: { lat: number; lon: number },
): number {
  return Math.ceil(haversineKm(from, to) / KM_PER_TICK);
}

beforeAll(async () => {
  await startOsrm();

  // Gli adapter leggono l'ambiente **quando il modulo si compone**: va scritto prima.
  process.env.OSRM_BASE_URL = `http://127.0.0.1:${osrmPort}`;
  process.env.OSRM_TIMEOUT_MS = '2000';
  process.env.OSRM_CACHE_TTL_SECONDS = '60';
  process.env.SIMULATOR_SPEED_KMH = '20';
  process.env.SIMULATOR_TICK_MINUTES = '3';

  harness = await startApiHarness(NOW.toISOString());
  persistence = harness.persistence;
  rides = harness.rides;
  fleet = harness.fleet;
  external = harness.external;
  simulation = harness.simulation;
  telemetry = harness.fleetTelemetry;
  rebalancing = harness.rebalancing;
}, HOOK_TIMEOUT_MS);

afterAll(async () => {
  await harness?.stop();
  await stopOsrm();
}, HOOK_TIMEOUT_MS);

beforeEach(async () => {
  await harness.reset();
  harness.clock.setNow(NOW);
  osrmRequests = [];

  await persistence.create('zone', DUOMO);
  const registered = await harness.auth.register(PASSENGER);
  passengerId = registered.user.id;
});

describe('[M7] Cancello: servizi esterni reali e simulatore di flotta', () => {
  describe('[NFR8] Con gli adapter reali il sistema funziona senza mock', () => {
    it('una corsa attraversa tutto il ciclo, mossa dalla telemetria e da nessun altro', async () => {
      await givenRobotaxi('RT-01', { lat: DUOMO.lat + 0.01, lon: DUOMO.lon });

      const outcome = await rides.submitImmediate({
        passengerId,
        pickup: DUOMO,
        destination: CENTRALE,
      });
      expect(outcome.accepted).toBe(true);
      if (!outcome.accepted) return;

      // Gli ETA sono stati chiesti al fornitore vero: è ciò che distingue «adapter configurato» da
      // «adapter che finge di esserlo».
      expect(osrmRequests.some((url) => url.startsWith('/table'))).toBe(true);
      expect(await stateOf('RT-01')).toBe('ASSIGNED');

      const rideRequestId = outcome.request.id;

      // Primo giro: la rotta verso il ritiro viene comandata e il veicolo parte (transizione 4).
      const first = await telemetry.runOnce();
      expect(first.advanced).toEqual([
        { rideRequestId, robotaxiId: 'RT-01', step: 'PICKUP_NAVIGATION_STARTED' },
      ]);
      expect(await stateOf('RT-01')).toBe('ARRIVING');
      expect(osrmRequests.some((url) => url.startsWith('/route'))).toBe(true);

      // Il veicolo percorre la rotta. Nessuna attesa: si contano i tick.
      simulation.tick(ticksBetween(await positionOf('RT-01'), DUOMO) + 1);

      const second = await telemetry.runOnce();
      expect(second.advanced).toEqual([
        { rideRequestId, robotaxiId: 'RT-01', step: 'PICKUP_REACHED' },
      ]);
      expect(await stateOf('RT-01')).toBe('ARRIVED');

      // Il passeggero sale e si parte (transizione 6), con la rotta verso la destinazione.
      const third = await telemetry.runOnce();
      expect(third.advanced).toEqual([
        { rideRequestId, robotaxiId: 'RT-01', step: 'RIDE_STARTED' },
      ]);
      expect(await stateOf('RT-01')).toBe('IN_RIDE');

      simulation.tick(ticksBetween(DUOMO, CENTRALE) + 1);

      const fourth = await telemetry.runOnce();
      expect(fourth.advanced).toEqual([
        { rideRequestId, robotaxiId: 'RT-01', step: 'RIDE_COMPLETED' },
      ]);

      // Il ciclo si chiude dove doveva: veicolo libero, corsa e richiesta concluse.
      expect(await stateOf('RT-01')).toBe('AVAILABLE');
      const [request] = await persistence.find('ride_request', {
        where: { id: rideRequestId },
        limit: 1,
      });
      expect(request?.status).toBe('COMPLETED');
      const [ride] = await persistence.find('ride', { where: { rideRequestId }, limit: 1 });
      expect(ride?.status).toBe('COMPLETED');
      expect(ride?.endedAt).not.toBeNull();
    });

    it('la posizione dei veicoli in movimento finisce in tabella (R7, G8)', async () => {
      const start = { lat: DUOMO.lat + 0.02, lon: DUOMO.lon };
      await givenRobotaxi('RT-01', start);
      await rides.submitImmediate({ passengerId, pickup: DUOMO, destination: CENTRALE });

      await telemetry.runOnce();
      simulation.tick();
      const cycle = await telemetry.runOnce();

      expect(cycle.positionsRecorded).toBe(1);
      const moved = await positionOf('RT-01');
      expect(moved).not.toEqual(start);
      // Si è mosso **verso** il punto di ritiro, non in una direzione qualsiasi.
      expect(haversineKm(moved, DUOMO)).toBeLessThan(haversineKm(start, DUOMO));
    });
  });

  describe('[NFR8] Il simulatore porta il veicolo a destinazione in tick contati', () => {
    it('non un tick prima, e non uno di più', async () => {
      const start = { lat: DUOMO.lat + 0.02, lon: DUOMO.lon };
      await givenRobotaxi('RT-01', start);
      await rides.submitImmediate({ passengerId, pickup: DUOMO, destination: CENTRALE });

      await telemetry.runOnce();
      expect(await stateOf('RT-01')).toBe('ARRIVING');

      /**
       * Il conto si fa **prima** di eseguire: il fornitore ha dato la geometria che congiunge i due
       * punti, e a un chilometro per tick il numero di passi è una divisione.
       */
      const expected = ticksBetween(start, DUOMO);

      simulation.tick(expected - 1);
      await telemetry.runOnce();
      // Un tick prima è ancora in strada: senza questa asserzione, un simulatore che teletrasporta
      // i veicoli passerebbe comunque.
      expect(await stateOf('RT-01')).toBe('ARRIVING');

      simulation.tick();
      await telemetry.runOnce();
      expect(await stateOf('RT-01')).toBe('ARRIVED');
    });

    it('senza tick il veicolo non arriva mai, per quanti giri si leggano', async () => {
      await givenRobotaxi('RT-01', { lat: DUOMO.lat + 0.02, lon: DUOMO.lon });
      await rides.submitImmediate({ passengerId, pickup: DUOMO, destination: CENTRALE });

      await telemetry.runOnce();
      for (let giro = 0; giro < 5; giro += 1) await telemetry.runOnce();

      // Il mondo simulato avanza solo su `tick()` (CLAUDE.md Regola 3): leggere non fa succedere.
      expect(await stateOf('RT-01')).toBe('ARRIVING');
    });
  });

  describe('[NFR8] Con OSRM irraggiungibile il sistema non si ferma', () => {
    /** Spegne il fornitore per la durata di un caso, e lo riaccende sulla stessa porta. */
    async function withProviderDown(scenario: () => Promise<void>): Promise<void> {
      await stopOsrm();
      try {
        await scenario();
      } finally {
        await startOsrm(osrmPort);
      }
    }

    it('la richiesta di corsa viene servita lo stesso, con un ETA stimato', async () => {
      await givenRobotaxi('RT-01', { lat: DUOMO.lat + 0.01, lon: DUOMO.lon });

      await withProviderDown(async () => {
        const estimates = await external.getETA(
          [{ id: 'RT-01', position: { lat: DUOMO.lat + 0.01, lon: DUOMO.lon } }],
          DUOMO,
        );
        // Il ripiego risponde per **tutti**: un'origine che sparisse sarebbe un veicolo dichiarato
        // inidoneo per un guasto altrui.
        expect(estimates).toHaveLength(1);
        expect(estimates[0]?.etaMinutes).toBeGreaterThan(0);

        const outcome = await rides.submitImmediate({
          passengerId,
          pickup: DUOMO,
          destination: CENTRALE,
        });

        // Nessuna richiesta persa: la corsa è assegnata e la riserva scritta, come con il
        // fornitore in piedi.
        expect(outcome.accepted).toBe(true);
        if (!outcome.accepted) return;
        expect(outcome.robotaxiId).toBe('RT-01');
        expect(outcome.reservation.period.end.getTime()).toBeGreaterThan(NOW.getTime());
      });

      expect(await stateOf('RT-01')).toBe('ASSIGNED');
    });

    it('e il veicolo arriva comunque: senza percorso vero resta il segmento', async () => {
      const start = { lat: DUOMO.lat + 0.01, lon: DUOMO.lon };
      await givenRobotaxi('RT-01', start);

      await withProviderDown(async () => {
        const outcome = await rides.submitImmediate({
          passengerId,
          pickup: DUOMO,
          destination: CENTRALE,
        });
        expect(outcome.accepted).toBe(true);

        await telemetry.runOnce();
        expect(await stateOf('RT-01')).toBe('ARRIVING');

        simulation.tick(ticksBetween(start, DUOMO));
        await telemetry.runOnce();

        expect(await stateOf('RT-01')).toBe('ARRIVED');
      });
    });
  });

  describe('[R11][G9] Il riposizionamento si chiude quando il veicolo arriva', () => {
    it('il veicolo mandato in un altra zona ci arriva e torna disponibile', async () => {
      await persistence.create('zone', SAN_SIRO);
      const slot = { dayOfWeek: 1, hourOfDay: 11 };
      await persistence.create('demand_sample', { zoneId: DUOMO.id, ...slot, baseDemand: 0 });
      await persistence.create('demand_sample', { zoneId: SAN_SIRO.id, ...slot, baseDemand: 5 });
      await givenRobotaxi('RT-01', DUOMO);

      const plan = await rebalancing.rebalance();

      expect(plan.dispatched).toEqual([
        { robotaxiId: 'RT-01', targetZoneId: SAN_SIRO.id, fromZoneId: DUOMO.id },
      ]);
      // Transizione 8, e la rotta comandata alla flotta (Figura 2.7).
      expect(await stateOf('RT-01')).toBe('REBALANCING');

      // Finché non arriva, il ciclo successivo non lo chiude.
      const stillGoing = await rebalancing.rebalance();
      expect(stillGoing.completed).toEqual([]);
      expect(await stateOf('RT-01')).toBe('REBALANCING');

      simulation.tick(ticksBetween(DUOMO, SAN_SIRO));

      /**
       * Il giro di telemetria **prima** del ciclo di riposizionamento, ed è un ordine che ha una
       * ragione osservabile: è lui a scrivere in tabella dove i veicoli sono arrivati. Senza,
       * `RT-01` risulterebbe ancora in centro — la sua zona si calcola dalle coordinate, decisione
       * D53 — e il ciclo successivo lo rimanderebbe fuori un istante dopo averlo richiamato.
       */
      const observed = await telemetry.runOnce();
      expect(observed.positionsRecorded).toBe(1);

      const closing = await rebalancing.rebalance();

      /**
       * Transizione 9, che fino a M6 **non aveva nessuno che la innescasse** (decisione D60): la
       * sua guardia `hasReachedTargetArea()` dipende da dove il veicolo si trova davvero, e la
       * telemetria nasce qui. Senza, un veicolo mandato a riposizionarsi non tornava mai fra gli
       * inattivi, quindi non era più spostabile.
       */
      expect(closing.completed).toEqual(['RT-01']);
      expect(await stateOf('RT-01')).toBe('AVAILABLE');

      const [action] = await persistence.find('rebalancing_action', {
        where: { robotaxiId: 'RT-01' },
        limit: 1,
      });
      expect(action?.status).toBe('COMPLETED');

      // Ed è arrivato dove doveva: la sua zona adesso è San Siro.
      const arrived = await positionOf('RT-01');
      expect(haversineKm(arrived, SAN_SIRO)).toBeLessThan(haversineKm(arrived, DUOMO));
    });
  });

  describe('[NFR8] Nessun componente fuori dal gateway conosce un fornitore', () => {
    it('la flotta si comanda e si osserva solo attraverso la porta', async () => {
      await givenRobotaxi('RT-01', DUOMO);

      // La formulazione operativa di NFR8 (DD §4.3) vista dall'altro lato: il resto del sistema
      // parla di punti, minuti e identificatori — mai di polyline, URL o codici di risposta.
      const outcome = await external.commandRoute('RT-01', { from: DUOMO, to: SAN_SIRO });
      expect(outcome.accepted).toBe(true);
      expect(outcome.etaMinutes).toBeGreaterThan(0);

      const [reading] = await external.readTelemetry();
      expect(reading?.robotaxiId).toBe('RT-01');
      expect(reading?.observedAt).toEqual(NOW);

      // E ciò che `fleet` riceve della telemetria è la sola cosa che gli compete: dove sono i
      // veicoli (decisione D61).
      const recorded = await fleet.recordPositions([
        { robotaxiId: 'RT-01', lat: SAN_SIRO.lat, lon: SAN_SIRO.lon, observedAt: NOW },
      ]);
      expect(recorded).toBe(1);
      expect(await positionOf('RT-01')).toEqual({ lat: SAN_SIRO.lat, lon: SAN_SIRO.lon });
      // Nessuna transizione: una posizione non è un cambio di stato.
      expect(await stateOf('RT-01')).toBe('AVAILABLE');
    });
  });
});
