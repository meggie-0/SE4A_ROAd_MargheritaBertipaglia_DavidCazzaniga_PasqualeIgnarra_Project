import type { RobotaxiSnapshot } from '../../../src/fleet/robotaxi.port';
import { composeAllocation, type AllocationHarness } from '../../support/allocation';

/**
 * `MinimumEtaStrategy` — la politica che il modo Auto attiva a traffico alto (RASD §2.4, R12).
 *
 * Gli ETA arrivano da `ExternalServicesPort`, qui sostituita da una tabella fissa: è ciò che NFR8
 * promette nella sua forma falsificabile (DD §4.3), cioè che i test di dominio girano sostituendo
 * il **solo** gateway esterno. Con una tabella si possono provare ordini che una stima lineare non
 * produrrebbe mai — il veicolo lontano che arriva prima — e sono esattamente il caso per cui la
 * strategia esiste.
 */

const DUOMO = { lat: 45.4642, lon: 9.19 };
const REQUEST = { pickup: DUOMO };

function robotaxiAt(id: string, lat: number, lon: number): RobotaxiSnapshot {
  return { id, state: 'AVAILABLE', lat, lon, zoneId: null, updatedAt: new Date(0) };
}

const northOfDuomo = (id: string, degrees: number): RobotaxiSnapshot =>
  robotaxiAt(id, DUOMO.lat + degrees, DUOMO.lon);

let harness: AllocationHarness;

beforeEach(async () => {
  harness = await composeAllocation({ activeStrategy: 'MINIMUM_ETA' });
});

afterEach(async () => {
  await harness.close();
});

describe('[R5][G4] Allocazione con MinimumETA', () => {
  it('senza candidati non assegna nulla, e non interroga il fornitore', async () => {
    expect(await harness.allocation.allocate(REQUEST, [])).toBeNull();

    // Da M7 in poi quella chiamata attraversa la rete: farla per una lista vuota costerebbe
    // latenza per una risposta che si conosce già.
    expect(harness.external.calls).toHaveLength(0);
  });

  it('con un solo candidato di cui si conosce l ETA assegna quello', async () => {
    harness.external.setEta({ 'RT-01': 12 });

    const chosen = await harness.allocation.allocate(REQUEST, [northOfDuomo('RT-01', 0.05)]);

    expect(chosen?.id).toBe('RT-01');
  });

  it('nessun candidato idoneo se di nessuno si conosce l ETA', async () => {
    // Il fornitore non sa rispondere per questi veicoli: non compaiono nel suo esito. Sceglierne
    // uno lo stesso significherebbe promettere al passeggero un'attesa che nessuno ha calcolato.
    harness.external.setEta({});

    const chosen = await harness.allocation.allocate(REQUEST, [
      northOfDuomo('RT-01', 0.01),
      northOfDuomo('RT-02', 0.02),
    ]);

    expect(chosen).toBeNull();
  });

  it('scarta i candidati senza ETA e sceglie fra i restanti', async () => {
    harness.external.setEta({ 'RT-03': 9 });

    const chosen = await harness.allocation.allocate(REQUEST, [
      northOfDuomo('RT-01', 0.001), // vicinissimo, ma di lui non si sa nulla
      northOfDuomo('RT-02', 0.002), // idem
      northOfDuomo('RT-03', 0.09), // lontano, ed è l'unico con un ETA
    ]);

    expect(chosen?.id).toBe('RT-03');
  });

  it('assegna il veicolo che arriva prima, anche se non è il più vicino', async () => {
    // È la ragione per cui la strategia esiste: a traffico alto la distanza smette di essere una
    // buona previsione dell'attesa (RASD §2.4).
    harness.external.setEta({ 'RT-01': 22, 'RT-02': 6, 'RT-03': 14 });

    const chosen = await harness.allocation.allocate(REQUEST, [
      northOfDuomo('RT-01', 0.005),
      northOfDuomo('RT-02', 0.08),
      northOfDuomo('RT-03', 0.02),
    ]);

    expect(chosen?.id).toBe('RT-02');
  });

  it('distingue due ETA che differiscono di un decimo di minuto', async () => {
    // Il valore di frontiera della metrica: se gli ETA venissero arrotondati al minuto, questi due
    // sembrerebbero pari merito e vincerebbe l'id, cioè RT-01.
    harness.external.setEta({ 'RT-01': 7.1, 'RT-02': 7 });

    const chosen = await harness.allocation.allocate(REQUEST, [
      northOfDuomo('RT-01', 0.01),
      northOfDuomo('RT-02', 0.01),
    ]);

    expect(chosen?.id).toBe('RT-02');
  });

  it('a parità di ETA vince l id lessicograficamente minore', async () => {
    harness.external.setEta({ 'RT-07': 7, 'RT-02': 7, 'RT-05': 7 });
    const candidates = [
      northOfDuomo('RT-07', 0.01),
      northOfDuomo('RT-02', 0.04),
      northOfDuomo('RT-05', 0.02),
    ];

    expect((await harness.allocation.allocate(REQUEST, candidates))?.id).toBe('RT-02');

    // E nemmeno qui l'ordine di arrivo dei candidati cambia l'esito.
    const reversed = [...candidates].reverse();
    expect((await harness.allocation.allocate(REQUEST, reversed))?.id).toBe('RT-02');
  });

  it('chiede gli ETA verso il punto di prelievo, una volta sola per tutti i candidati', async () => {
    harness.external.setEta({ 'RT-01': 5, 'RT-02': 8 });

    await harness.allocation.allocate(REQUEST, [
      northOfDuomo('RT-01', 0.01),
      northOfDuomo('RT-02', 0.02),
    ]);

    // Una chiamata sola, come nella Figura 2.5: il fornitore reale di M7 risponde a matrici, e
    // interrogarlo veicolo per veicolo moltiplicherebbe la latenza per il numero dei candidati.
    expect(harness.external.calls).toHaveLength(1);
    const [call] = harness.external.calls;
    expect(call?.destination).toEqual(DUOMO);
    expect(call?.origins.map((origin) => origin.id)).toEqual(['RT-01', 'RT-02']);
    // E porta con sé la posizione di ciascun veicolo, non solo il suo identificatore.
    expect(call?.origins[0]?.position).toEqual({ lat: DUOMO.lat + 0.01, lon: DUOMO.lon });
  });
});
