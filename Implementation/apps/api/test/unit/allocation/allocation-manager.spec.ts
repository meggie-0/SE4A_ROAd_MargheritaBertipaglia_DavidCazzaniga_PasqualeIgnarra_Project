import { DEFAULT_STRATEGY, type StrategyName } from '@road/shared';

import { UnknownStrategyError } from '../../../src/allocation/allocation.port';
import type { RobotaxiSnapshot } from '../../../src/fleet/robotaxi.port';
import { composeAllocation, type AllocationHarness } from '../../support/allocation';

/**
 * L'`AllocationManager` come **contesto** del pattern Strategy (DD §2.3.1, §2.6.1).
 *
 * Qui non si verifica una metrica — quelle hanno i loro file — ma che il manager deleghi alla
 * politica attiva e che il cambio di politica sia una scrittura sull'unica sede autorevole, il
 * record `system_mode` (DD §2.2.1, decisione D6).
 */

const DUOMO = { lat: 45.4642, lon: 9.19 };
const REQUEST = { pickup: DUOMO };

function robotaxiAt(id: string, lat: number, lon: number): RobotaxiSnapshot {
  return { id, state: 'AVAILABLE', lat, lon, zoneId: null, updatedAt: new Date(0) };
}

const NOW = new Date('2026-05-04T09:00:00.000Z');

let harness: AllocationHarness;

beforeEach(async () => {
  harness = await composeAllocation({ now: NOW });
});

afterEach(async () => {
  await harness.close();
});

describe('[R8][G5] Selezione della strategia a runtime', () => {
  it('parte da NearestAvailable, che è il default del sistema', async () => {
    // Il valore non è deciso qui: è quello con cui la migrazione iniziale crea la riga singleton
    // (RASD §2.4, `DEFAULT_STRATEGY` di packages/shared).
    expect(await harness.allocation.getActiveStrategy()).toBe(DEFAULT_STRATEGY);
    expect(DEFAULT_STRATEGY).toBe('NEAREST_AVAILABLE');
  });

  it('un cambio automatico scrive la strategia e lascia stare il modo', async () => {
    await harness.allocation.setActiveStrategy('MINIMUM_ETA', 'auto');

    expect(await harness.allocation.getActiveStrategy()).toBe('MINIMUM_ETA');
    expect(harness.systemMode.systemMode).toMatchObject({
      activeStrategy: 'MINIMUM_ETA',
      mode: 'AUTO',
      updatedAt: NOW,
    });
  });

  it('una scelta manuale porta in modo Manual nella stessa scrittura', async () => {
    // NFR10 nella formulazione del DD §4.3: «il passaggio a Manual è atomico con il cambio di
    // strategia». Una sola `UPDATE` non lascia esistere un istante in cui la strategia è quella
    // scelta dall'operatore e il modo è ancora Auto.
    await harness.allocation.setActiveStrategy('MINIMUM_ETA', 'manual');

    expect(harness.systemMode.systemMode).toMatchObject({
      activeStrategy: 'MINIMUM_ETA',
      mode: 'MANUAL',
    });
  });

  it('rifiuta una strategia che nessuna classe registrata realizza, senza scrivere nulla', async () => {
    const before = harness.systemMode.systemMode;

    // Il nome non appartiene a `StrategyName`, quindi un chiamante tipizzato non può passarlo. Il
    // controllo serve lo stesso: il valore potrebbe arrivare da una colonna scritta da una
    // versione del sistema che conosceva una strategia in più.
    const nonRegistrata = 'NON_ESISTE' as unknown as StrategyName;

    await expect(
      harness.allocation.setActiveStrategy(nonRegistrata, 'manual'),
    ).rejects.toBeInstanceOf(UnknownStrategyError);

    expect(harness.systemMode.systemMode).toBe(before);
  });

  it('e non alloca se la colonna porta una strategia che non sa eseguire', async () => {
    harness.systemMode.forceActiveStrategy('SCOMPARSA');

    await expect(
      harness.allocation.allocate(REQUEST, [robotaxiAt('RT-01', DUOMO.lat, DUOMO.lon)]),
    ).rejects.toBeInstanceOf(UnknownStrategyError);
  });

  it('alloca con la politica attiva, e cambiarla cambia la scelta senza ricomporre nulla', async () => {
    // R8 chiede il cambio «a runtime, senza interruzione del servizio»: nessun riavvio fra le due
    // allocazioni qui sotto, e nemmeno una nuova composizione del modulo.
    const vicinoMaLento = robotaxiAt('RT-01', DUOMO.lat + 0.01, DUOMO.lon);
    const lontanoMaVeloce = robotaxiAt('RT-02', DUOMO.lat + 0.06, DUOMO.lon);
    const candidates = [vicinoMaLento, lontanoMaVeloce];
    harness.external.setEta({ 'RT-01': 25, 'RT-02': 4 });

    expect((await harness.allocation.allocate(REQUEST, candidates))?.id).toBe('RT-01');

    await harness.allocation.setActiveStrategy('MINIMUM_ETA', 'manual');

    expect((await harness.allocation.allocate(REQUEST, candidates))?.id).toBe('RT-02');
  });

  it('rilegge la strategia a ogni allocazione, invece di ricordarsela', async () => {
    // Un manager che tenesse il valore in memoria non se ne accorgerebbe: qui la colonna viene
    // cambiata da fuori, come farebbe un'altra replica del tier applicativo (NFR3).
    const candidates = [
      robotaxiAt('RT-01', DUOMO.lat + 0.01, DUOMO.lon),
      robotaxiAt('RT-02', DUOMO.lat + 0.06, DUOMO.lon),
    ];
    harness.external.setEta({ 'RT-01': 25, 'RT-02': 4 });

    expect((await harness.allocation.allocate(REQUEST, candidates))?.id).toBe('RT-01');

    harness.systemMode.forceActiveStrategy('MINIMUM_ETA');

    expect((await harness.allocation.allocate(REQUEST, candidates))?.id).toBe('RT-02');
  });
});
