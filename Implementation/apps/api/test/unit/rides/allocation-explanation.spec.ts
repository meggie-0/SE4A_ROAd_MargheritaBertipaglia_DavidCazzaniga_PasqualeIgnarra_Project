import { recordOperator } from '../../support/notifications';
import { composeRides, vehicleAt, type RidesHarness } from '../../support/rides';

/**
 * La riga del registro operativo, vista da chi la produce: `RideAllocator` (decisione D79).
 *
 * Il caso che questo file difende è stato trovato eseguendo la dimostrazione, non leggendo il
 * codice. A un secondo dalla commutazione una riga ha detto «RT-21 assegnato con Più vicino
 * disponibile, 1,9 min — il più vicino, RT-25, ne avrebbe impiegati 1,6»: un distacco negativo, cioè
 * un numero falso nel registro. RT-25 era stato scartato da un tentativo fallito — il ripiego che
 * l'allocatore fa quando un altro gli prende il veicolo fra la scelta e la riserva (NFR1) — e la
 * strategia aveva scelto, correttamente, il più vicino **fra quelli rimasti**. Il confronto invece si
 * faceva con il più vicino di tutti, anche uno che l'allocatore non poteva prendere.
 *
 * La manopola si accende da `process.env` perché il modulo `rides` legge l'ambiente come in
 * produzione, e si spegne dopo, come fa il cancello di M7 con `OSRM_BASE_URL`.
 */

const NOW = new Date('2026-05-04T09:00:00.000Z');
const DUOMO = { lat: 45.4642, lon: 9.19 };
const north = (id: string, degrees: number) =>
  vehicleAt(id, { lat: DUOMO.lat + degrees, lon: DUOMO.lon });
const draft = {
  passengerId: 'passenger-1',
  pickup: DUOMO,
  destination: { lat: 45.4863, lon: 9.205 },
};

let harness: RidesHarness | null = null;

afterEach(async () => {
  await harness?.close();
  harness = null;
  delete process.env.ALLOCATION_EXPLANATIONS;
});

async function explanationsFor(block: boolean): Promise<string[]> {
  harness = await composeRides({
    now: NOW,
    vehicles: [north('RT-01', 0.01), north('RT-02', 0.05)],
  });
  const dashboard = recordOperator(harness.notificationSessions);
  if (block) harness.persistence.blockReservationsFor('RT-01', 'ROBOTAXI_BUSY');

  await harness.rides.submitImmediate(draft);

  return dashboard.received.map((one) => one.message).filter((m) => m.includes(' assegnato con '));
}

describe('[R5][R7][R8] La riga dice perché quel veicolo, fra quelli che si potevano prendere', () => {
  it('un più vicino perso per concorrenza non entra nel confronto', async () => {
    process.env.ALLOCATION_EXPLANATIONS = 'on';

    const lines = await explanationsFor(true);

    // RT-01 era il più vicino di tutti, ma un'altra transazione l'aveva impegnato: la strategia ha
    // scelto RT-02, che è il più vicino fra quelli ottenibili, e la riga non ha niente da obiettare.
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^RT-02 assegnato con Più vicino disponibile, [0-9]+,[0-9] min$/);
    expect(lines[0]).not.toContain('RT-01');
  });

  it('senza concorrenza sceglie il più vicino, e lo dice senza confronti', async () => {
    process.env.ALLOCATION_EXPLANATIONS = 'on';

    const lines = await explanationsFor(false);

    expect(lines).toEqual([expect.stringMatching(/^RT-01 assegnato con Più vicino disponibile, /)]);
  });

  it('con la manopola spenta non c’è nessuna riga: la dashboard riceve ciò che riceveva prima', async () => {
    const lines = await explanationsFor(false);

    expect(lines).toEqual([]);
  });
});
