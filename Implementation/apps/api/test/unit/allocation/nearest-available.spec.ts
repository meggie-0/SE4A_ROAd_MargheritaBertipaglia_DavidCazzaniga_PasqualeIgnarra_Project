import type { RobotaxiSnapshot } from '../../../src/fleet/robotaxi.port';
import { composeAllocation, type AllocationHarness } from '../../support/allocation';

/**
 * `NearestAvailableStrategy` — la politica di default (RASD §2.4, DD §2.3.1).
 *
 * I test passano da `AllocationPort.allocate()` e non dalla classe concreta, che il modulo non
 * espone: la strategia si riconosce dal comportamento. È la forma di verifica che HARNESS.md §9
 * chiede — riscrivere il modulo non deve costringere a riscriverne i test.
 */

const DUOMO = { lat: 45.4642, lon: 9.19 };
const REQUEST = { pickup: DUOMO };

/** Un veicolo fermo in un punto. Lo stato non entra nella scelta: i candidati arrivano filtrati. */
function robotaxiAt(id: string, lat: number, lon: number): RobotaxiSnapshot {
  return { id, state: 'AVAILABLE', lat, lon, zoneId: null, updatedAt: new Date(0) };
}

/** Un grado di latitudine vale circa 111 km: 0,01° sono poco più di un chilometro. */
const northOfDuomo = (id: string, degrees: number): RobotaxiSnapshot =>
  robotaxiAt(id, DUOMO.lat + degrees, DUOMO.lon);

let harness: AllocationHarness;

beforeEach(async () => {
  harness = await composeAllocation({ activeStrategy: 'NEAREST_AVAILABLE' });
});

afterEach(async () => {
  await harness.close();
});

describe('[R5][G4] Allocazione con NearestAvailable', () => {
  it('senza candidati non assegna nulla', async () => {
    expect(await harness.allocation.allocate(REQUEST, [])).toBeNull();
  });

  it('con un solo candidato assegna quello, per quanto lontano sia', async () => {
    const lontano = robotaxiAt('RT-09', 45.518, 9.085); // Rho Fiera, oltre 12 km dal Duomo

    const chosen = await harness.allocation.allocate(REQUEST, [lontano]);

    expect(chosen?.id).toBe('RT-09');
  });

  it('fra più candidati assegna il più vicino al punto di prelievo', async () => {
    const candidates = [
      northOfDuomo('RT-01', 0.05),
      northOfDuomo('RT-02', 0.01),
      northOfDuomo('RT-03', 0.03),
    ];

    const chosen = await harness.allocation.allocate(REQUEST, candidates);

    expect(chosen?.id).toBe('RT-02');
  });

  it('distingue due candidati che differiscono di un margine minimo', async () => {
    // Un centesimo di grado di differenza è circa un metro: il valore di frontiera della metrica.
    // Se la distanza venisse arrotondata — ai minuti, ai cento metri — questi due sembrerebbero
    // pari merito e vincerebbe l'id, cioè RT-01.
    const candidates = [northOfDuomo('RT-01', 0.01001), northOfDuomo('RT-02', 0.01)];

    const chosen = await harness.allocation.allocate(REQUEST, candidates);

    expect(chosen?.id).toBe('RT-02');
  });

  it('a parità di distanza vince l id lessicograficamente minore', async () => {
    // Due veicoli nello stesso identico punto: il pareggio è esatto per costruzione, non per
    // arrotondamento. Senza una regola totale l'esito dipenderebbe dall'ordine con cui il
    // database ha restituito le righe, e il test sarebbe instabile (MILESTONES.md §M3).
    const stessoPunto = [
      robotaxiAt('RT-07', DUOMO.lat + 0.02, DUOMO.lon),
      robotaxiAt('RT-02', DUOMO.lat + 0.02, DUOMO.lon),
      robotaxiAt('RT-05', DUOMO.lat + 0.02, DUOMO.lon),
    ];

    expect((await harness.allocation.allocate(REQUEST, stessoPunto))?.id).toBe('RT-02');

    // E l'esito non dipende dall'ordine in cui i candidati arrivano.
    const reversed = [...stessoPunto].reverse();
    expect((await harness.allocation.allocate(REQUEST, reversed))?.id).toBe('RT-02');
  });

  it('guarda la distanza e non il tempo di arrivo', async () => {
    // Gli ETA direbbero il contrario: RT-01 è vicino ma lentissimo, RT-02 lontano e velocissimo.
    // È la differenza fra le due politiche, e questa non deve nemmeno interrogare il fornitore.
    harness.external.setEta({ 'RT-01': 40, 'RT-02': 1 });
    const candidates = [northOfDuomo('RT-01', 0.01), northOfDuomo('RT-02', 0.05)];

    const chosen = await harness.allocation.allocate(REQUEST, candidates);

    expect(chosen?.id).toBe('RT-01');
    expect(harness.external.calls).toHaveLength(0);
  });
});
