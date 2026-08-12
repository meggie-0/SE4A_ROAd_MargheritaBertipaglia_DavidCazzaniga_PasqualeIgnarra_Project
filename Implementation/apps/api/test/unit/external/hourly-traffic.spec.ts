import { Test, type TestingModule } from '@nestjs/testing';

import { ExternalModule } from '../../../src/external/external.module';
import { ExternalServicesPort } from '../../../src/external/external-services.port';
import { ClockPort } from '../../../src/platform/clock.port';
import { FakeClock } from '../../../src/platform/fake-clock';

/**
 * L'adapter del traffico di M6: il livello dedotto dall'ora locale di Milano.
 *
 * Due cose da dimostrare, e la seconda è quella che conta davvero.
 *
 * La prima è che il livello **dipenda dall'ora locale e non da UTC**. È un difetto che si
 * manifesterebbe solo per metà anno — d'inverno Milano è UTC+1, d'estate UTC+2 — e che quindi una
 * suite scritta a gennaio non vedrebbe mai. Il caso con l'ora legale lo mette in evidenza: lo stesso
 * istante UTC che d'inverno è un'ora di punta, d'estate non lo è.
 *
 * La seconda è il **determinismo** (CLAUDE.md Regola 3): l'unico ingresso è `ClockPort`, quindi due
 * letture nello stesso istante simulato danno lo stesso livello. Senza questa proprietà i test
 * sull'isteresi sarebbero instabili, e un test instabile porterebbe a modificare codice sano.
 *
 * Il `describe` **non porta tag**: qui non si commuta nessuna strategia e non c'è nessuna isteresi.
 * Questo file dimostra che la sorgente è deterministica, non che R12 sia soddisfatto — quello lo
 * fanno i test del `ModeController`, che i livelli li ricevono dal chiamante.
 */

let moduleRef: TestingModule;
let external: ExternalServicesPort;
let clock: FakeClock;

/** Il livello letto in un dato istante. */
async function trafficAt(iso: string): Promise<string> {
  clock.setNow(new Date(iso));
  return external.getTraffic();
}

beforeEach(async () => {
  clock = new FakeClock('2026-01-07T08:00:00.000Z');
  moduleRef = await Test.createTestingModule({ imports: [ExternalModule] })
    .overrideProvider(ClockPort)
    .useValue(clock)
    .compile();
  external = moduleRef.get(ExternalServicesPort);
});

afterEach(async () => {
  await moduleRef.close();
});

describe('Il livello di traffico dei servizi esterni', () => {
  it('è alto nelle ore di punta di un giorno feriale', async () => {
    // Mercoledì 7 gennaio 2026, 08:00 UTC = 09:00 a Milano: ancora punta del mattino.
    expect(await trafficAt('2026-01-07T07:00:00.000Z')).toBe('HIGH');
    // 17:00 UTC = 18:00 a Milano: punta della sera.
    expect(await trafficAt('2026-01-07T17:00:00.000Z')).toBe('HIGH');
  });

  it('è basso nelle ore morte', async () => {
    // 02:00 UTC = 03:00 a Milano.
    expect(await trafficAt('2026-01-07T02:00:00.000Z')).toBe('LOW');
    expect(await trafficAt('2026-01-07T12:00:00.000Z')).toBe('LOW');
  });

  it('nel fine settimana non ha punte pendolari e non supera mai la soglia intermedia', async () => {
    // Sabato 10 gennaio 2026, 07:00 UTC = 08:00 a Milano: feriale sarebbe punta, di sabato no.
    expect(await trafficAt('2026-01-10T07:00:00.000Z')).toBe('LOW');
    // 20:00 UTC = 21:00 a Milano, sabato sera: la città è piena ma non congestionata.
    expect(await trafficAt('2026-01-10T20:00:00.000Z')).toBe('MEDIUM');
  });

  /**
   * Il caso che giustifica l'esistenza di `milanWeekdayHourSlot`.
   *
   * Le 05:30 UTC sono le 06:30 d'inverno — ora di punta secondaria — e le 07:30 d'estate, che è
   * punta piena. Se l'adapter leggesse l'ora UTC, i due istanti darebbero lo stesso livello e
   * l'intero modello di domanda sarebbe sfasato di un'ora per metà anno.
   */
  it("distingue ora solare e ora legale, perché legge l'ora locale e non UTC", async () => {
    expect(await trafficAt('2026-01-07T05:30:00.000Z')).toBe('MEDIUM');
    // Mercoledì 8 luglio 2026, stessa ora UTC, ma a Milano sono le 07:30.
    expect(await trafficAt('2026-07-08T05:30:00.000Z')).toBe('HIGH');
  });

  it('è deterministico: due letture nello stesso istante danno lo stesso livello', async () => {
    clock.setNow(new Date('2026-01-07T17:00:00.000Z'));

    const [first, second] = await Promise.all([external.getTraffic(), external.getTraffic()]);

    expect(first).toBe(second);
  });
});
