import { DEFAULT_STRATEGY } from '@road/shared';

import type { AllocationPort } from '../../../src/allocation/allocation.port';
import type { RobotaxiSnapshot } from '../../../src/fleet/robotaxi.port';
import { SYSTEM_MODE_ID, type PersistencePort } from '../../../src/persistence/persistence.port';
import { startApiHarness, type ApiHarness } from '../../support/postgres';

/**
 * `AllocationManager` sul database vero (M3).
 *
 * Le metriche delle due strategie si verificano altrove, su doppi: qui interessa l'altra metà del
 * modulo, cioè che la strategia attiva viva **davvero** nel record `system_mode` e non nella
 * memoria di un processo (DD §2.2.1, decisione D6). È una proprietà che un doppio non può
 * dimostrare, perché la colonna, il vincolo `CHECK` che la limita ai nomi noti e l'atomicità della
 * scrittura sono fatti di PostgreSQL.
 *
 * **Serve Docker in esecuzione.**
 */

const NOW = new Date('2026-05-04T09:00:00.000Z');
const HOOK_TIMEOUT_MS = 180_000;
const DUOMO = { lat: 45.4642, lon: 9.19 };

let harness: ApiHarness;
let allocation: AllocationPort;
let persistence: PersistencePort;

/** Un veicolo fermo sul meridiano del Duomo: la sola cosa che le due metriche guardano. */
function robotaxiAt(id: string, lat: number): RobotaxiSnapshot {
  return { id, state: 'AVAILABLE', lat, lon: DUOMO.lon, zoneId: null, updatedAt: NOW };
}

/** La riga singleton letta senza passare dal modulo. */
async function systemModeRow(): Promise<{ active_strategy: string; mode: string } | undefined> {
  const rows = await harness.query<{ active_strategy: string; mode: string }>(
    `SELECT "active_strategy", "mode" FROM "system_mode" WHERE "id" = $1`,
    [SYSTEM_MODE_ID],
  );
  return rows[0];
}

beforeAll(async () => {
  harness = await startApiHarness(NOW.toISOString());
  allocation = harness.allocation;
  persistence = harness.persistence;
}, HOOK_TIMEOUT_MS);

afterAll(async () => {
  await harness?.stop();
}, HOOK_TIMEOUT_MS);

beforeEach(async () => {
  await harness.reset();
  harness.clock.setNow(NOW);
});

describe('[R8][G5] La strategia attiva vive nel record system_mode', () => {
  it('parte dal default creato dalla migrazione iniziale', async () => {
    expect(await allocation.getActiveStrategy()).toBe(DEFAULT_STRATEGY);
    expect(await systemModeRow()).toMatchObject({
      active_strategy: 'NEAREST_AVAILABLE',
      mode: 'AUTO',
    });
  });

  it('un cambio automatico scrive la sola strategia', async () => {
    await allocation.setActiveStrategy('MINIMUM_ETA', 'auto');

    expect(await systemModeRow()).toMatchObject({
      active_strategy: 'MINIMUM_ETA',
      mode: 'AUTO',
    });
  });

  it('una scelta manuale scrive strategia e modo insieme', async () => {
    // NFR10: il passaggio a Manual è atomico con il cambio di strategia. Sono una sola `UPDATE`,
    // quindi non esiste un istante osservabile in cui la colonna della strategia è già cambiata e
    // quella del modo no.
    await allocation.setActiveStrategy('MINIMUM_ETA', 'manual');

    expect(await systemModeRow()).toMatchObject({
      active_strategy: 'MINIMUM_ETA',
      mode: 'MANUAL',
    });
  });

  it('legge ciò che un altro scrittore ha messo in colonna', async () => {
    // Il caso della seconda replica del tier applicativo (NFR3): il cambio l'ha scritto qualcun
    // altro, e questa istanza deve allocarci sopra senza sapere che è successo. Un manager che
    // tenesse la strategia in memoria continuerebbe con quella vecchia.
    await persistence.update('system_mode', SYSTEM_MODE_ID, { activeStrategy: 'MINIMUM_ETA' });

    expect(await allocation.getActiveStrategy()).toBe('MINIMUM_ETA');
  });

  it('marca l istante del cambio con ClockPort e non con l orologio di sistema', async () => {
    harness.clock.setNow('2026-05-04T18:30:00.000Z');

    await allocation.setActiveStrategy('MINIMUM_ETA', 'manual');

    const [row] = await harness.query<{ updated_at: Date }>(
      `SELECT "updated_at" FROM "system_mode" WHERE "id" = $1`,
      [SYSTEM_MODE_ID],
    );
    expect(row?.updated_at).toEqual(new Date('2026-05-04T18:30:00.000Z'));
  });
});

describe('[R5][G4] Allocazione con gli adapter di questa milestone', () => {
  it('sceglie un veicolo con la strategia attiva, quale che sia', async () => {
    // Composizione reale: `LinearEtaGateway` stima gli ETA dalla distanza, quindi in M3 le due
    // politiche ordinano allo stesso modo e scelgono lo stesso veicolo. È una proprietà
    // dell'adapter di questa milestone, non delle strategie: con OSRM (M7) i due ordinamenti si
    // separano, e i test che li distinguono girano già su una tabella di ETA fissi.
    const candidates = [robotaxiAt('RT-01', 45.52), robotaxiAt('RT-02', 45.47)];

    expect((await allocation.allocate({ pickup: DUOMO }, candidates))?.id).toBe('RT-02');

    await allocation.setActiveStrategy('MINIMUM_ETA', 'manual');

    expect((await allocation.allocate({ pickup: DUOMO }, candidates))?.id).toBe('RT-02');
  });

  it('non assegna nulla se non ci sono candidati', async () => {
    expect(await allocation.allocate({ pickup: DUOMO }, [])).toBeNull();

    await allocation.setActiveStrategy('MINIMUM_ETA', 'auto');
    expect(await allocation.allocate({ pickup: DUOMO }, [])).toBeNull();
  });
});
