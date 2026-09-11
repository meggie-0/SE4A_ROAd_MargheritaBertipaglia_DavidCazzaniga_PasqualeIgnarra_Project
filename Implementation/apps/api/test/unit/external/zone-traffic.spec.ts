import { ConfigModule } from '@nestjs/config';
import { Test, type TestingModule } from '@nestjs/testing';
import type { GeoPoint } from '@road/shared';

import { ExternalServicesPort } from '../../../src/external/external-services.port';
import { ExternalModule } from '../../../src/external/external.module';
import { FleetSimulationPort } from '../../../src/external/fleet-simulation.port';
import { ClockPort } from '../../../src/platform/clock.port';
import { FakeClock } from '../../../src/platform/fake-clock';

/**
 * Il traffico **nel mondo**, zona per zona (decisione D79; R12, NFR8).
 *
 * Fino a v1.13 il traffico era un'etichetta: commutava la strategia, ma una macchina impiegava lo
 * stesso tempo con traffico basso o altissimo. Questi casi provano che ora non è più così — che il
 * simulatore rallenta i veicoli dove la strada è congestionata e che le stime lo prevedono — e che
 * **niente cambia per chi non lo configura**.
 *
 * Tutto passa dalle porte, come nel test della sorgente scriptata: `TrafficSlowdown` è una giuntura
 * interna di `external` e un test che la costruisse a mano proverebbe una classe, non ciò che il
 * sistema vede.
 */

const START = '2026-05-04T09:00:00.000Z';

/** Le cinque zone del centro della dimostrazione. */
const CENTRE = 'duomo,cadorna,porta-venezia,navigli,porta-romana';

/** Il centro sale a `HIGH` dopo un minuto; la periferia resta sempre `LOW`. */
const SCRIPT = 'LOW:0,HIGH:60';

/**
 * L'esempio del disegno della D79, con le coordinate dei veicoli del seed.
 *
 * Un prelievo sul bordo del centro, verso CityLife: `RT-06` sta a Cadorna, a 0,67 km, con tutto il
 * tragitto in centro; `RT-09` sta a CityLife, al doppio della distanza, con tre quarti del tragitto
 * fuori.
 */
const PICKUP: GeoPoint = { lat: 45.475, lon: 9.173 };
const RT_06: GeoPoint = { lat: 45.469, lon: 9.174 };
const RT_09: GeoPoint = { lat: 45.479, lon: 9.157 };

/** Due punti tutti in centro e due tutti in periferia, per un tragitto che non attraversa confini. */
const DUOMO: GeoPoint = { lat: 45.4642, lon: 9.19 };
const NEAR_DUOMO: GeoPoint = { lat: 45.4662, lon: 9.193 };
const BICOCCA: GeoPoint = { lat: 45.515, lon: 9.211 };
const NEAR_BICOCCA: GeoPoint = { lat: 45.517, lon: 9.214 };

let moduleRef: TestingModule | null = null;
let clock: FakeClock;

async function compose(environment: Record<string, string>): Promise<{
  external: ExternalServicesPort;
  simulation: FleetSimulationPort;
}> {
  clock = new FakeClock(START);
  moduleRef = await Test.createTestingModule({
    imports: [
      // La configurazione arriva da qui e non da `process.env`, per non lasciarla agli altri file.
      ConfigModule.forRoot({ ignoreEnvFile: true, load: [() => environment] }),
      ExternalModule,
    ],
  })
    .overrideProvider(ClockPort)
    .useValue(clock)
    .compile();

  return {
    external: moduleRef.get(ExternalServicesPort),
    simulation: moduleRef.get(FleetSimulationPort),
  };
}

/** La configurazione della dimostrazione del traffico. */
const DEMO = {
  TRAFFIC_SOURCE: 'scripted',
  TRAFFIC_SCRIPT: SCRIPT,
  TRAFFIC_CENTRE_ZONES: CENTRE,
  TRAFFIC_TIME_FACTORS: 'MEDIUM:1.6,HIGH:4',
};

function secondsAfterStart(seconds: number): void {
  clock.setNow(new Date(new Date(START).getTime() + seconds * 1000));
}

async function minutes(
  external: ExternalServicesPort,
  from: GeoPoint,
  to: GeoPoint,
): Promise<number> {
  const [estimate] = await external.getETA([{ id: 'X', position: from }], to);
  if (estimate === undefined) throw new Error('Nessuna stima.');
  return estimate.etaMinutes;
}

/** Quanti tick servono al veicolo per arrivare dove gli si comanda di andare. */
async function ticksToArrive(
  external: ExternalServicesPort,
  simulation: FleetSimulationPort,
  from: GeoPoint,
  to: GeoPoint,
): Promise<number> {
  await external.commandRoute('RT-01', { from, to });
  for (let ticks = 1; ticks <= 2000; ticks += 1) {
    simulation.tick();
    const [reading] = await external.readTelemetry();
    if (reading?.hasArrived === true) return ticks;
  }
  throw new Error('Il veicolo non arriva.');
}

afterEach(async () => {
  await moduleRef?.close();
  moduleRef = null;
});

describe('[R12] Il traffico rallenta il mondo dove c’è, e le stime lo prevedono', () => {
  it('il livello che il sistema legge è quello del centro', async () => {
    const { external } = await compose(DEMO);

    expect(await external.getTraffic()).toBe('LOW');
    secondsAfterStart(60);
    expect(await external.getTraffic()).toBe('HIGH');
  });

  it('un tragitto tutto in centro costa il fattore del livello; uno tutto in periferia no', async () => {
    const { external } = await compose(DEMO);
    const centreLow = await minutes(external, DUOMO, NEAR_DUOMO);
    const outskirtsLow = await minutes(external, BICOCCA, NEAR_BICOCCA);

    secondsAfterStart(60);

    expect(await minutes(external, DUOMO, NEAR_DUOMO)).toBeCloseTo(centreLow * 4, 9);
    expect(await minutes(external, BICOCCA, NEAR_BICOCCA)).toBeCloseTo(outskirtsLow, 9);
  });

  it('con il centro a HIGH il più vicino smette di essere il più veloce', async () => {
    /**
     * È il fenomeno per cui R12 esiste, visto dalla porta che la strategia a ETA minimo interroga.
     * Con traffico basso la stima è una funzione crescente della distanza e vince `RT-06`, che è
     * più vicino; con il centro congestionato vince `RT-09`, che è a una distanza doppia ma fa quasi
     * tutta la strada fuori dal centro.
     */
    const { external } = await compose(DEMO);
    const origins = [
      { id: 'RT-06', position: RT_06 },
      { id: 'RT-09', position: RT_09 },
    ];
    const byId = async (): Promise<Map<string, number>> =>
      new Map((await external.getETA(origins, PICKUP)).map((e) => [e.id, e.etaMinutes]));

    const low = await byId();
    expect(low.get('RT-06')).toBeLessThan(low.get('RT-09') as number);

    secondsAfterStart(60);
    const high = await byId();
    expect(high.get('RT-09')).toBeLessThan(high.get('RT-06') as number);

    // E non per un soffio: è il distacco che la dimostrazione deve poter mostrare.
    expect((high.get('RT-06') as number) - (high.get('RT-09') as number)).toBeGreaterThanOrEqual(1);
  });

  it('il simulatore mantiene ciò che la stima promette: in centro a HIGH servono quattro volte i tick', async () => {
    const { external, simulation } = await compose(DEMO);
    const free = await ticksToArrive(external, simulation, DUOMO, NEAR_DUOMO);

    await moduleRef?.close();
    const again = await compose(DEMO);
    secondsAfterStart(60);
    const jammed = await ticksToArrive(again.external, again.simulation, DUOMO, NEAR_DUOMO);

    // I tick sono arrotondati per eccesso: se il tragitto libero vale x tick, `free` è ⌈x⌉ e quello
    // congestionato è ⌈4x⌉, che sta fra 4·(free − 1) escluso e 4·free incluso.
    expect(jammed).toBeGreaterThan(4 * (free - 1));
    expect(jammed).toBeLessThanOrEqual(4 * free);
  });

  it('il tempo annunciato con il comando di rotta porta lo stesso fattore della stima', async () => {
    const { external } = await compose(DEMO);
    secondsAfterStart(60);

    const estimate = await minutes(external, DUOMO, NEAR_DUOMO);
    const outcome = await external.commandRoute('RT-01', { from: DUOMO, to: NEAR_DUOMO });

    expect(outcome.etaMinutes).toBeCloseTo(estimate, 9);
  });
});

describe('[NFR8] Chi non configura il traffico per zona non vede cambiare niente', () => {
  it('senza fattori, la stima con il centro a HIGH è identica a quella senza alcun traffico', async () => {
    const { external: withoutFactors } = await compose({
      TRAFFIC_SOURCE: 'scripted',
      TRAFFIC_SCRIPT: SCRIPT,
      TRAFFIC_CENTRE_ZONES: CENTRE,
    });
    secondsAfterStart(60);
    const jammedButUnslowed = await minutes(withoutFactors, RT_06, PICKUP);
    await moduleRef?.close();

    const { external: plain } = await compose({});
    expect(jammedButUnslowed).toBe(await minutes(plain, RT_06, PICKUP));
  });

  it('senza zone del centro, la tabella vale per tutta la città come prima', async () => {
    const { external } = await compose({ TRAFFIC_SOURCE: 'scripted', TRAFFIC_SCRIPT: SCRIPT });
    secondsAfterStart(60);
    expect(await external.getTraffic()).toBe('HIGH');
  });

  it('un fattore minore di uno ferma l’avvio invece di accelerare i veicoli in silenzio', async () => {
    await expect(compose({ ...DEMO, TRAFFIC_TIME_FACTORS: 'HIGH:0.5' })).rejects.toThrow(
      /TRAFFIC_TIME_FACTORS/,
    );
  });

  it('una zona del centro che non esiste ferma l’avvio', async () => {
    await expect(compose({ ...DEMO, TRAFFIC_CENTRE_ZONES: 'duomo,cadrona' })).rejects.toThrow(
      /cadrona/,
    );
  });
});
