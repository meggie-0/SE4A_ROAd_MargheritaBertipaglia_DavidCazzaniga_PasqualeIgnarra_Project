import type { RobotaxiState as RobotaxiStateName } from '@road/shared';

import { UnknownRobotaxiError, type FleetMonitorPort } from '../../../src/fleet/fleet-monitor.port';
import {
  ConcurrentTransitionError,
  IllegalTransitionError,
} from '../../../src/fleet/robotaxi.port';
import type { MaintenancePort } from '../../../src/maintenance/maintenance.port';
import {
  immediateReservationWindow,
  type PersistencePort,
} from '../../../src/persistence/persistence.port';
import { startApiHarness, type ApiHarness } from '../../support/postgres';

/**
 * `FleetMonitor` e `MaintenanceManager` su un Postgres vero (HARNESS.md §1, passo 9).
 *
 * Tutto passa dalle porte. Il punto di questi test è ciò che i test unitari non possono mostrare:
 * che lo stato del veicolo **sopravvive al giro completo** — scrittura sulla colonna enum,
 * rilettura, ricostruzione dell'oggetto — e che due scrittori concorrenti non possono percorrere la
 * macchina a stati insieme. Su un doppio in memoria lo stato sopravvivrebbe da solo, perché non
 * andrebbe mai davvero via, e la concorrenza non esisterebbe affatto.
 */

const NOW = new Date('2026-05-04T09:00:00.000Z');
const DUOMO = { lat: 45.4642, lon: 9.19 };
const RIDE = { rideRequestId: 'ride-1' };

const HOOK_TIMEOUT_MS = 180_000;

let harness: ApiHarness;
let fleet: FleetMonitorPort;
let maintenance: MaintenancePort;
let persistence: PersistencePort;

beforeAll(async () => {
  harness = await startApiHarness(NOW.toISOString());
  fleet = harness.fleet;
  maintenance = harness.maintenance;
  persistence = harness.persistence;
}, HOOK_TIMEOUT_MS);

afterAll(async () => {
  await harness?.stop();
}, HOOK_TIMEOUT_MS);

beforeEach(async () => {
  await harness.reset();
  harness.clock.setNow(NOW);
  await persistence.create('zone', { id: 'duomo', name: 'Duomo / Centro', ...DUOMO });
});

/** Un veicolo al Duomo, nello stato indicato. */
async function givenRobotaxi(id: string, state: RobotaxiStateName): Promise<string> {
  await persistence.create('robotaxi', { id, state, ...DUOMO, zoneId: 'duomo' });
  return id;
}

/** Una richiesta di corsa vera: serve solo dove si scrive una riserva, che ha la chiave esterna. */
async function givenRideRequest(email: string): Promise<string> {
  const passenger = await persistence.create('user', {
    email,
    passwordHash: 'non-una-password',
    name: 'Nome',
    surname: 'Cognome',
    phoneNumber: null,
    role: 'PASSENGER',
  });
  const request = await persistence.create('ride_request', {
    passengerId: passenger.id,
    kind: 'IMMEDIATE',
    status: 'PENDING',
    pickupLat: DUOMO.lat,
    pickupLon: DUOMO.lon,
    pickupAddress: null,
    destinationLat: 45.4781,
    destinationLon: 9.227,
    destinationAddress: null,
    assignedRobotaxiId: null,
  });
  return request.id;
}

/** Lo stato scritto in colonna, letto senza passare dal modulo. */
async function persistedState(id: string): Promise<string | undefined> {
  const rows = await harness.query<{ state: string }>(
    `SELECT "state" FROM "robotaxi" WHERE "id" = $1`,
    [id],
  );
  return rows[0]?.state;
}

describe('[R7][G8] Real-time Fleet Monitoring', () => {
  it('getFleetStatus riporta posizione e stato di ogni veicolo', async () => {
    await givenRobotaxi('RT-01', 'AVAILABLE');
    await givenRobotaxi('RT-02', 'IN_RIDE');
    await givenRobotaxi('RT-03', 'MAINTENANCE');

    const status = await fleet.getFleetStatus();

    expect(status.total).toBe(3);
    expect(status.robotaxis.map((robotaxi) => robotaxi.id)).toEqual(['RT-01', 'RT-02', 'RT-03']);
    expect(status.robotaxis[0]).toMatchObject({
      id: 'RT-01',
      state: 'AVAILABLE',
      lat: DUOMO.lat,
      lon: DUOMO.lon,
      zoneId: 'duomo',
    });
  });

  it('conta tutti e sette gli stati, anche quelli a zero', async () => {
    await givenRobotaxi('RT-01', 'AVAILABLE');
    await givenRobotaxi('RT-02', 'AVAILABLE');
    await givenRobotaxi('RT-03', 'REBALANCING');

    const status = await fleet.getFleetStatus();

    // Le colonne a zero ci sono: una status bar in cui una voce sparisce quando è vuota
    // costringerebbe il client a dedurre da sé l'insieme dei valori possibili (DD §3.2).
    expect(status.countsByState).toEqual({
      AVAILABLE: 2,
      ASSIGNED: 0,
      ARRIVING: 0,
      ARRIVED: 0,
      IN_RIDE: 0,
      REBALANCING: 1,
      MAINTENANCE: 0,
    });
  });

  it("data l'ora dall'orologio della piattaforma e non da quello di sistema", async () => {
    harness.clock.setNow(new Date('2026-05-04T18:30:00.000Z'));

    const status = await fleet.getFleetStatus();

    expect(status.observedAt.toISOString()).toBe('2026-05-04T18:30:00.000Z');
  });

  it('getAvailableRobotaxis restituisce i soli veicoli inattivi, in ordine di id', async () => {
    await givenRobotaxi('RT-03', 'AVAILABLE');
    await givenRobotaxi('RT-01', 'AVAILABLE');
    await givenRobotaxi('RT-02', 'REBALANCING');

    // `REBALANCING` è allocabile ma non inattivo: mandarlo a riposizionarsi una seconda volta non
    // avrebbe senso, ed è questa la lista che il RebalancingManager di M6 userà come sorgente.
    expect((await fleet.getAvailableRobotaxis()).map((robotaxi) => robotaxi.id)).toEqual([
      'RT-01',
      'RT-03',
    ]);
  });
});

describe('[G6] getCandidates: chi può accettare una corsa', () => {
  it('include available e rebalancing, esclude tutti gli altri stati', async () => {
    await givenRobotaxi('RT-01', 'AVAILABLE');
    await givenRobotaxi('RT-02', 'REBALANCING');
    await givenRobotaxi('RT-03', 'ASSIGNED');
    await givenRobotaxi('RT-04', 'ARRIVING');
    await givenRobotaxi('RT-05', 'ARRIVED');
    await givenRobotaxi('RT-06', 'IN_RIDE');
    await givenRobotaxi('RT-07', 'MAINTENANCE');

    expect((await fleet.getCandidates()).map((robotaxi) => robotaxi.id)).toEqual([
      'RT-01',
      'RT-02',
    ]);
  });

  it('non guarda la timeline: il filtro sulle riserve non passa di qui', async () => {
    await givenRobotaxi('RT-01', 'AVAILABLE');
    const rideRequestId = await givenRideRequest('anna@example.com');
    const window = immediateReservationWindow(NOW, 5, 20);

    await persistence.reserve({ robotaxiId: 'RT-01', rideRequestId, window });

    // Il veicolo ha una riserva in corso e resta un candidato: `getCandidates` guarda lo stato, e
    // basta. Chi ha bisogno anche della timeline chiama `PersistencePort.filterAvailable()` sui
    // candidati, ed è `RideRequestManager` a farlo (DD §2.4, Figure 2.5 e 2.8). Assorbire quel
    // filtro qui sposterebbe una responsabilità fra componenti.
    expect((await fleet.getCandidates()).map((robotaxi) => robotaxi.id)).toEqual(['RT-01']);
    expect(await persistence.filterAvailable(['RT-01'], window)).toEqual([]);
  });
});

describe('[G6][NFR5] Il ciclo di vita attraverso la porta', () => {
  it('assign scrive lo stato in colonna e lo restituisce', async () => {
    await givenRobotaxi('RT-01', 'AVAILABLE');

    // L'identificatore della corsa non viene persistito da `assign`: il legame fra richiesta e
    // veicolo lo scrive `PersistenceManager.reserve()` (DD §2.4, Figura 2.5), e in M2 nessuno lo
    // chiama. Qui basta un identificatore qualsiasi.
    const assigned = await fleet.assign('RT-01', RIDE);

    expect(assigned.state).toBe('ASSIGNED');
    expect(await persistedState('RT-01')).toBe('ASSIGNED');
  });

  it('requestRebalancing porta a REBALANCING senza togliere il veicolo dai candidati', async () => {
    await givenRobotaxi('RT-01', 'AVAILABLE');

    const rebalancing = await fleet.requestRebalancing('RT-01');

    expect(rebalancing.state).toBe('REBALANCING');
    expect((await fleet.getCandidates()).map((robotaxi) => robotaxi.id)).toEqual(['RT-01']);
  });

  it('rifiuta una transizione illegale senza toccare il database', async () => {
    // `ARRIVED` e non `ASSIGNED`: se il veicolo fosse già nello stato di arrivo della transizione
    // richiesta, un'implementazione che scrivesse *prima* di transire lascerebbe in colonna lo
    // stesso valore, e l'asserzione non distinguerebbe le due implementazioni.
    await givenRobotaxi('RT-01', 'ARRIVED');

    await expect(fleet.assign('RT-01', RIDE)).rejects.toBeInstanceOf(IllegalTransitionError);

    expect(await persistedState('RT-01')).toBe('ARRIVED');
  });

  it('rifiuta un identificatore che non appartiene alla flotta', async () => {
    await expect(fleet.requestRebalancing('RT-99')).rejects.toBeInstanceOf(UnknownRobotaxiError);
  });
});

describe('[R9][NFR5] Due transizioni concorrenti sullo stesso veicolo', () => {
  /**
   * Quale delle due eccezioni esce dipende da come si intrecciano le due letture, ed entrambe sono
   * corrette: o la seconda legge lo stato già cambiato e la transizione è illegale, o legge quello
   * vecchio e la scrittura condizionata la ferma. Ciò che deve valere sempre — e che senza la
   * condizione non varrebbe — è che a riuscire sia **esattamente una**. Che la condizione funzioni
   * davvero lo dimostra il test deterministico su `update` in `integration/persistence`.
   */
  const refused = [IllegalTransitionError, ConcurrentTransitionError];

  function loser(outcomes: PromiseSettledResult<unknown>[]): unknown {
    const rejected = outcomes.find((outcome) => outcome.status === 'rejected');
    return rejected?.status === 'rejected' ? rejected.reason : undefined;
  }

  it('di due assign() simultanee ne riesce esattamente una', async () => {
    await givenRobotaxi('RT-01', 'AVAILABLE');

    const outcomes = await Promise.allSettled([
      fleet.assign('RT-01', { rideRequestId: 'ride-1' }),
      fleet.assign('RT-01', { rideRequestId: 'ride-2' }),
    ]);

    // Senza la scrittura condizionata sullo stato letto riuscirebbero entrambe: leggono tutte e
    // due `AVAILABLE`, decidono tutte e due che la transizione è legale, e scrivono tutte e due.
    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
    expect(refused.some((type) => loser(outcomes) instanceof type)).toBe(true);
    expect(await persistedState('RT-01')).toBe('ASSIGNED');
  });

  it('un assign() e una richiesta di manutenzione simultanei non si sovrappongono', async () => {
    await givenRobotaxi('RT-01', 'AVAILABLE');

    const outcomes = await Promise.allSettled([
      fleet.assign('RT-01', RIDE),
      maintenance.requestMaintenance('RT-01', 'freni'),
    ]);

    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
    expect(refused.some((type) => loser(outcomes) instanceof type)).toBe(true);

    // È il caso che viola R9 alla lettera: un veicolo `ASSIGNED` con un intervento aperto sarebbe
    // un veicolo assegnato a un passeggero mentre è in officina. I due esiti ammessi sono entrambi
    // coerenti; quello vietato è la combinazione.
    const state = await persistedState('RT-01');
    const records = await harness.countRows('maintenance_record');
    if (state === 'ASSIGNED') {
      expect(records).toBe(0);
    } else {
      expect(state).toBe('MAINTENANCE');
      expect(records).toBe(1);
    }
  });
});

describe('[R9] Maintenance Management', () => {
  it('ferma il veicolo, apre lo storico e lo toglie dai candidati', async () => {
    await givenRobotaxi('RT-01', 'AVAILABLE');
    await givenRobotaxi('RT-02', 'AVAILABLE');

    const started = await maintenance.requestMaintenance('RT-01', 'freni');

    expect(started.robotaxi.state).toBe('MAINTENANCE');
    expect(started.record).toMatchObject({
      robotaxiId: 'RT-01',
      reason: 'freni',
      status: 'ONGOING',
      startedAt: NOW,
      endedAt: null,
    });

    // R9 alla lettera: «prevent their assignment to rides during such periods».
    expect((await fleet.getCandidates()).map((robotaxi) => robotaxi.id)).toEqual(['RT-02']);
    expect((await fleet.getAvailableRobotaxis()).map((robotaxi) => robotaxi.id)).toEqual(['RT-02']);
    await expect(fleet.assign('RT-01', RIDE)).rejects.toBeInstanceOf(IllegalTransitionError);
  });

  it('rimette in servizio il veicolo e chiude lo storico', async () => {
    await givenRobotaxi('RT-01', 'AVAILABLE');
    await maintenance.requestMaintenance('RT-01', 'freni');
    harness.clock.setNow(new Date('2026-05-04T11:00:00.000Z'));

    const completed = await maintenance.completeMaintenance('RT-01');

    expect(completed.robotaxi.state).toBe('AVAILABLE');
    expect(completed.record).toMatchObject({
      status: 'COMPLETED',
      endedAt: new Date('2026-05-04T11:00:00.000Z'),
    });
    expect((await fleet.getCandidates()).map((robotaxi) => robotaxi.id)).toEqual(['RT-01']);
  });

  it('non fa entrare in manutenzione un veicolo che si sta riposizionando', async () => {
    await givenRobotaxi('RT-01', 'REBALANCING');

    await expect(maintenance.requestMaintenance('RT-01', 'freni')).rejects.toBeInstanceOf(
      IllegalTransitionError,
    );

    // Né lo stato né lo storico: la transizione rifiutata non lascia mezzo lavoro dietro di sé.
    expect(await persistedState('RT-01')).toBe('REBALANCING');
    expect(await harness.countRows('maintenance_record')).toBe(0);
  });

  it('non chiude una manutenzione su un veicolo che non è fermo', async () => {
    await givenRobotaxi('RT-01', 'AVAILABLE');

    await expect(maintenance.completeMaintenance('RT-01')).rejects.toBeInstanceOf(
      IllegalTransitionError,
    );
  });
});
