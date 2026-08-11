import { Test, type TestingModule } from '@nestjs/testing';

import { ExternalModule } from '../../../src/external/external.module';
import { ExternalServicesPort } from '../../../src/external/external-services.port';

/**
 * L'adapter degli ETA di M3: una stima lineare, deterministica e senza rete.
 *
 * Il test guarda **proprietà**, non numeri: che la stima cresca con la distanza, che sia zero a
 * distanza zero, che due chiamate identiche diano lo stesso risultato e che risponda per ogni
 * origine. I minuti esatti dipendono da due costanti del modello — velocità media e circuità — che
 * M7 sostituirà con i tempi veri di OSRM: fissarli in un'asserzione renderebbe rosso un test sano
 * il giorno in cui il modello migliora.
 *
 * Il `describe` **non porta tag**: qui non si alloca nulla e non c'è nessuna strategia, quindi
 * marcarlo `[R5]` gonfierebbe la matrice di tracciabilità con un test che non dimostra il
 * requisito che nomina. Il requisito di competenza di questo file è NFR8, atteso in M7.
 */

const DUOMO = { lat: 45.4642, lon: 9.19 };
const CENTRALE = { lat: 45.4863, lon: 9.205 }; // ~2,6 km dal Duomo
const RHO_FIERA = { lat: 45.518, lon: 9.085 }; // ~10 km dal Duomo

let moduleRef: TestingModule;
let external: ExternalServicesPort;

beforeEach(async () => {
  moduleRef = await Test.createTestingModule({ imports: [ExternalModule] }).compile();
  external = moduleRef.get(ExternalServicesPort);
});

afterEach(async () => {
  await moduleRef.close();
});

describe('Stima degli ETA dei servizi esterni', () => {
  it('risponde per ogni origine, in minuti positivi', async () => {
    const estimates = await external.getETA(
      [
        { id: 'RT-01', position: CENTRALE },
        { id: 'RT-02', position: RHO_FIERA },
      ],
      DUOMO,
    );

    expect(estimates.map((estimate) => estimate.id).sort()).toEqual(['RT-01', 'RT-02']);
    for (const estimate of estimates) expect(estimate.etaMinutes).toBeGreaterThan(0);
  });

  it('stima un tempo maggiore per un veicolo più lontano', async () => {
    const [vicino, lontano] = await external.getETA(
      [
        { id: 'vicino', position: CENTRALE },
        { id: 'lontano', position: RHO_FIERA },
      ],
      DUOMO,
    );

    expect(vicino?.etaMinutes).toBeLessThan(lontano?.etaMinutes ?? 0);
  });

  it('stima zero per un veicolo già sul punto di prelievo', async () => {
    const [sulPosto] = await external.getETA([{ id: 'RT-01', position: DUOMO }], DUOMO);

    expect(sulPosto?.etaMinutes).toBe(0);
  });

  it('è deterministica: due chiamate identiche danno lo stesso risultato', async () => {
    // È la proprietà che rende stabili i test di `allocation` (CLAUDE.md Regola 3): la stima
    // dipende solo dalle coordinate, non dall'orologio né dalla casualità.
    const origins = [{ id: 'RT-01', position: CENTRALE }];

    const first = await external.getETA(origins, DUOMO);
    const second = await external.getETA(origins, DUOMO);

    expect(first).toEqual(second);
  });

  it('con nessuna origine non restituisce nulla', async () => {
    expect(await external.getETA([], DUOMO)).toEqual([]);
  });
});
