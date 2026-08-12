import { createServer, type Server } from 'node:http';
import { AddressInfo } from 'node:net';

import { Test, type TestingModule } from '@nestjs/testing';

import {
  ExternalServicesPort,
  type EtaEstimate,
} from '../../../src/external/external-services.port';
import { ExternalModule } from '../../../src/external/external.module';
import { FleetSimulationPort } from '../../../src/external/fleet-simulation.port';
import { ClockPort } from '../../../src/platform/clock.port';
import { FakeClock } from '../../../src/platform/fake-clock';

/**
 * Gli adapter **reali** dei servizi esterni (M7, NFR8).
 *
 * Qui non c'è nessun doppio di ROAd: il modulo `external` è composto com'è in produzione, con
 * l'adapter OSRM, la stima lineare come via d'uscita e il simulatore di flotta. A essere finto è il
 * **fornitore**, cioè un server HTTP che parla il protocollo di OSRM e risponde ciò che il test ha
 * deciso — che è l'unico modo di verificare un adapter senza dipendere da una rete e da un servizio
 * di terzi, e insieme la prova che il protocollo è parlato davvero: un errore nell'ordine delle
 * coordinate o nel nome di un parametro fallisce qui.
 *
 * È anche la formulazione operativa di NFR8 (DD §4.3) letta al contrario: se «i test di dominio
 * girano sostituendo il solo gateway», allora il gateway deve essere verificabile **da solo**,
 * senza database e senza il resto del sistema. Questo file lo compone da solo, e infatti non alza
 * nessun container.
 */

const DUOMO = { lat: 45.4642, lon: 9.19 };
const CENTRALE = { lat: 45.4863, lon: 9.205 };
const GARIBALDI = { lat: 45.4847, lon: 9.1874 };
const NOW = new Date('2026-05-04T09:00:00.000Z');

/** Ciò che il fornitore finto ha ricevuto: serve a verificare la cache e il protocollo. */
let requests: string[] = [];

/** Le risposte che il fornitore darà, decise dal test. `null` significa «rispondi 500». */
let tableResponse: unknown = null;
let routeResponse: unknown = null;

let osrm: Server;
let osrmUrl: string;

/** Un percorso OSRM: metri, secondi e la geometria in GeoJSON, cioè `[lon, lat]`. */
function osrmRoute(
  meters: number,
  seconds: number,
  geometry: ReadonlyArray<readonly [number, number]>,
): unknown {
  return {
    code: 'Ok',
    routes: [{ distance: meters, duration: seconds, geometry: { coordinates: geometry } }],
  };
}

function startOsrm(): Promise<void> {
  osrm = createServer((request, response) => {
    requests.push(request.url ?? '');
    const body = request.url?.startsWith('/table') === true ? tableResponse : routeResponse;

    if (body === null) {
      response.writeHead(500).end('il fornitore non se la sente');
      return;
    }
    response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(body));
  });

  return new Promise((resolve) => {
    // La porta 0 la sceglie il sistema: due esecuzioni in parallelo non si contendono la stessa.
    osrm.listen(0, '127.0.0.1', () => {
      osrmUrl = `http://127.0.0.1:${(osrm.address() as AddressInfo).port}`;
      resolve();
    });
  });
}

interface ExternalHarness {
  readonly external: ExternalServicesPort;
  readonly simulation: FleetSimulationPort;
  close(): Promise<void>;
}

/** Compone il modulo vero con l'ambiente indicato. L'ambiente si legge alla composizione. */
async function composeExternal(baseUrl: string): Promise<ExternalHarness> {
  process.env.OSRM_BASE_URL = baseUrl;
  process.env.OSRM_TIMEOUT_MS = '2000';
  process.env.OSRM_CACHE_TTL_SECONDS = '60';
  process.env.SIMULATOR_SPEED_KMH = '20';
  process.env.SIMULATOR_TICK_MINUTES = '3';

  const moduleRef: TestingModule = await Test.createTestingModule({ imports: [ExternalModule] })
    .overrideProvider(ClockPort)
    .useValue(new FakeClock(NOW))
    .compile();

  return {
    external: moduleRef.get(ExternalServicesPort),
    simulation: moduleRef.get(FleetSimulationPort),
    close: () => moduleRef.close(),
  };
}

beforeAll(async () => {
  await startOsrm();
});

afterAll(async () => {
  // Le connessioni keep-alive che `fetch` lascia aperte terrebbero il server in piedi, e Jest
  // segnalerebbe un worker che non esce: si chiudono esplicitamente prima del server.
  osrm.closeAllConnections();
  await new Promise((resolve) => osrm.close(resolve));
});

beforeEach(() => {
  requests = [];
  tableResponse = { code: 'Ok', durations: [[300], [900]] };
  routeResponse = osrmRoute(2000, 600, [
    [DUOMO.lon, DUOMO.lat],
    [GARIBALDI.lon, GARIBALDI.lat],
  ]);
});

describe('[NFR8] Il gateway dei servizi esterni parla con i fornitori veri', () => {
  let harness: ExternalHarness;

  afterEach(async () => {
    await harness?.close();
  });

  it('gli ETA vengono da OSRM, in una sola richiesta per tutti i candidati', async () => {
    harness = await composeExternal(osrmUrl);

    const estimates = await harness.external.getETA(
      [
        { id: 'RT-01', position: DUOMO },
        { id: 'RT-02', position: GARIBALDI },
      ],
      CENTRALE,
    );

    // I secondi del fornitore diventano minuti, e sono i suoi: la stima lineare fra questi punti
    // darebbe altri numeri, quindi il test fallirebbe se l'adapter la usasse.
    expect(sortedById(estimates)).toEqual([
      { id: 'RT-01', etaMinutes: 5 },
      { id: 'RT-02', etaMinutes: 15 },
    ]);

    // Una richiesta sola, al servizio `/table`, con le due origini come sorgenti e la destinazione
    // come unica destinazione: interrogare il fornitore veicolo per veicolo moltiplicherebbe la
    // latenza di un'allocazione per il numero dei candidati.
    expect(requests).toHaveLength(1);
    expect(requests[0]).toContain('/table/v1/driving/');
    expect(requests[0]).toContain('sources=0;1');
    expect(requests[0]).toContain('destinations=2');
    // Le coordinate viaggiano come `lon,lat`, che è l'ordine di OSRM: invertirle metterebbe i
    // veicoli in mezzo al mare senza che nulla sembri sbagliato.
    expect(requests[0]).toContain(`${DUOMO.lon},${DUOMO.lat}`);
  });

  it('la seconda richiesta identica non tocca la rete', async () => {
    harness = await composeExternal(osrmUrl);
    const origins = [{ id: 'RT-01', position: DUOMO }];

    const first = await harness.external.getETA(origins, CENTRALE);
    const second = await harness.external.getETA(origins, CENTRALE);

    expect(second).toEqual(first);
    // È la cache che MILESTONES.md §M7 chiede: una singola allocazione chiede lo stesso percorso
    // più volte — la strategia per confrontare, il comando di rotta per farlo percorrere.
    expect(requests).toHaveLength(1);
  });

  it("un'origine che il fornitore non sa raggiungere non compare nell'esito", async () => {
    harness = await composeExternal(osrmUrl);
    // `null` in OSRM significa «nessun percorso». La porta prescrive che quell'origine sparisca:
    // è così che `MinimumEtaStrategy` distingue «lontanissimo» da «non so nulla».
    tableResponse = { code: 'Ok', durations: [[null], [600]] };

    const estimates = await harness.external.getETA(
      [
        { id: 'RT-01', position: DUOMO },
        { id: 'RT-02', position: GARIBALDI },
      ],
      CENTRALE,
    );

    expect(estimates).toEqual([{ id: 'RT-02', etaMinutes: 10 }]);
  });

  it('con OSRM irraggiungibile ogni candidato ha comunque un ETA', async () => {
    // Una porta su cui non ascolta nessuno: la connessione viene rifiutata subito.
    harness = await composeExternal('http://127.0.0.1:1');

    const estimates = await harness.external.getETA(
      [
        { id: 'RT-01', position: DUOMO },
        { id: 'RT-02', position: GARIBALDI },
      ],
      CENTRALE,
    );

    // Nessuna richiesta va persa: il ripiego è la stima lineare, che risponde per **tutti**.
    expect(estimates).toHaveLength(2);
    for (const estimate of estimates) expect(estimate.etaMinutes).toBeGreaterThan(0);
  });

  it('una risposta malformata vale come nessuna risposta', async () => {
    harness = await composeExternal(osrmUrl);
    // Il fornitore risponde 200 con un corpo che non è un esito di OSRM. Senza validazione, quei
    // campi assenti diventerebbero `NaN` e attraverserebbero il dominio fino al passeggero.
    tableResponse = { code: 'Ok', qualcosaDaltro: true };

    const estimates = await harness.external.getETA([{ id: 'RT-01', position: DUOMO }], CENTRALE);

    expect(estimates).toHaveLength(1);
    expect(Number.isFinite(estimates[0]?.etaMinutes)).toBe(true);
  });

  it('il comando di rotta usa la geometria di OSRM e il veicolo la percorre', async () => {
    harness = await composeExternal(osrmUrl);
    // Due chilometri di percorso, dieci minuti secondo il fornitore.
    routeResponse = osrmRoute(2000, 600, [
      [DUOMO.lon, DUOMO.lat],
      [GARIBALDI.lon, GARIBALDI.lat],
    ]);

    const outcome = await harness.external.commandRoute('RT-01', { from: DUOMO, to: GARIBALDI });

    expect(outcome).toEqual({ robotaxiId: 'RT-01', etaMinutes: 10, distanceKm: 2 });
    expect(requests.some((url) => url.startsWith('/route/v1/driving/'))).toBe(true);

    // Prima di qualunque tick il veicolo è fermo dov'era, e la telemetria lo dice.
    const [before] = await harness.external.readTelemetry();
    expect(before?.robotaxiId).toBe('RT-01');
    expect(before?.hasArrived).toBe(false);
    expect(before?.observedAt).toEqual(NOW);

    // Un tick vale 3 minuti a 20 km/h, cioè un chilometro: la geometria di OSRM misura ~2,2 km in
    // linea d'aria fra i due punti, quindi tre tick bastano e avanzano.
    harness.simulation.tick(3);

    const [after] = await harness.external.readTelemetry();
    expect(after?.hasArrived).toBe(true);
    expect(after?.position).toEqual(GARIBALDI);
  });

  it('la rotta revocata ferma il veicolo, e revocarla a chi non ne ha non è un errore', async () => {
    harness = await composeExternal(osrmUrl);
    await harness.external.commandRoute('RT-01', { from: DUOMO, to: GARIBALDI });
    harness.simulation.tick();

    const [moved] = await harness.external.readTelemetry();
    const revoked = await harness.external.commandRoute('RT-01', null);

    expect(revoked).toEqual({ robotaxiId: 'RT-01', etaMinutes: null, distanceKm: null });

    const [stopped] = await harness.external.readTelemetry();
    expect(stopped?.position).toEqual(moved?.position);
    expect(stopped?.destination).toBeNull();
    expect(stopped?.hasArrived).toBe(false);

    // R14: chi annulla non deve prima scoprire se il veicolo si fosse mosso.
    await expect(harness.external.commandRoute('RT-99', null)).resolves.toMatchObject({
      robotaxiId: 'RT-99',
      etaMinutes: null,
    });
  });

  it('senza OSRM configurato il sistema funziona lo stesso, e non tocca la rete', async () => {
    // È l'installazione con cui il team lavora in locale: `OSRM_BASE_URL` vuota.
    harness = await composeExternal('');

    const estimates = await harness.external.getETA([{ id: 'RT-01', position: DUOMO }], CENTRALE);
    const outcome = await harness.external.commandRoute('RT-01', { from: DUOMO, to: GARIBALDI });

    expect(estimates).toHaveLength(1);
    expect(outcome.distanceKm).toBeGreaterThan(0);
    expect(requests).toEqual([]);

    // E il veicolo arriva comunque: il segmento fra due punti è pur sempre una rotta.
    harness.simulation.tick(10);
    const [reading] = await harness.external.readTelemetry();
    expect(reading?.hasArrived).toBe(true);
    expect(reading?.position).toEqual(GARIBALDI);
  });

  it('la telemetria riguarda solo i veicoli a cui è stata comandata una rotta', async () => {
    harness = await composeExternal(osrmUrl);

    expect(await harness.external.readTelemetry()).toEqual([]);

    await harness.external.commandRoute('RT-09', { from: DUOMO, to: GARIBALDI });
    await harness.external.commandRoute('RT-02', { from: CENTRALE, to: GARIBALDI });

    // In ordine di identificatore: chi la legge muove corse e scrive righe, e due esecuzioni sullo
    // stesso stato devono produrre la stessa sequenza di scritture.
    expect((await harness.external.readTelemetry()).map((reading) => reading.robotaxiId)).toEqual([
      'RT-02',
      'RT-09',
    ]);
  });
});

/** L'ordine dell'esito di `getETA` non è significativo: chi chiama associa per `id`. */
function sortedById(estimates: readonly EtaEstimate[]): EtaEstimate[] {
  return [...estimates].sort((left, right) => (left.id < right.id ? -1 : 1));
}
